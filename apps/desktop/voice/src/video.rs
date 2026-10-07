//! Video: this side's camera and screen to the room, and every frame the app
//! shows (the room's cameras and screen, this side's previews) to the app, over
//! the loopback stream of `rv_voice_protocol::frames`.
//!
//! Captures run on their own threads (a camera handle is not `Send`, a desktop
//! capturer is polled) and report to the main loop through [`Internal`].
//! `RV_VOICE_FAKE_VIDEO=pattern` replaces the camera and the screen with a
//! moving test pattern, for headless tests.
use livekit::prelude::RemoteVideoTrack;
use livekit::webrtc::desktop_capturer::{
    CaptureError, DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions, DesktopFrame,
};
use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::video_frame::{I420Buffer, VideoBuffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::VideoResolution;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_stream::native::NativeVideoStream;
use rv_voice_protocol::frames::{self, Header, Source};
use rv_voice_protocol::{Event, ScreenKind, ScreenQuality, ScreenSource, thumbnail};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

/// At most this many frames a second reach the app, per track.
const FRAME_INTERVAL: Duration = Duration::from_millis(66);
/// What the app receives at most: cards are small, a screen fills the stage.
const CAMERA_FIT: (u32, u32) = (640, 480);
const SCREEN_FIT: (u32, u32) = (1920, 1080);
/// What this side's camera publishes at most.
const PUBLISH_FIT: (u32, u32) = (1920, 1080);
/// A share picker's thumbnail.
const THUMBNAIL_FIT: (u32, u32) = (320, 180);

/// A capture thread's news for the main loop.
pub enum Internal {
    /// The camera delivers frames: publish its track.
    CameraReady,
    /// The first screen frame: publish the screen track.
    ScreenReady,
    /// The capture stopped on its own (`camera_unavailable`, `screen_cancelled`...).
    Failed(Source, &'static str),
}

/// The latest message per track, waiting for the writer thread: a track the app
/// reads too slowly loses frames, never its end marker.
#[derive(Default)]
struct Mailbox {
    pending: HashMap<(Source, String), Vec<u8>>,
    order: VecDeque<(Source, String)>,
    closed: bool,
}

pub struct Frames {
    mailbox: Mutex<Mailbox>,
    ready: Condvar,
}

impl Frames {
    /// Connects to the app's frame listener on a thread of its own.
    pub fn connect(address: String, token: String) -> Arc<Self> {
        let frames = Arc::new(Self { mailbox: Mutex::default(), ready: Condvar::new() });
        let writer = frames.clone();
        std::thread::spawn(move || {
            let stream = TcpStream::connect(&address).and_then(|mut stream| {
                stream.set_nodelay(true)?;
                stream.write_all(&frames::handshake(&token))?;
                Ok(stream)
            });
            let Ok(mut stream) = stream else {
                eprintln!("rv-voice: video stream unavailable");
                return writer.close();
            };
            while let Some(message) = writer.next() {
                if stream.write_all(&message).is_err() {
                    return writer.close();
                }
            }
        });
        frames
    }

    fn next(&self) -> Option<Vec<u8>> {
        let mut mailbox = self.mailbox.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if mailbox.closed {
                return None;
            }
            if let Some(key) = mailbox.order.pop_front() {
                return mailbox.pending.remove(&key);
            }
            mailbox = self.ready.wait(mailbox).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn close(&self) {
        let mut mailbox = self.mailbox.lock().unwrap_or_else(|e| e.into_inner());
        mailbox.closed = true;
        mailbox.pending.clear();
        mailbox.order.clear();
    }

    fn put(&self, header: Header, pixels: &[u8]) {
        let key = (header.source, header.identity.clone());
        let message = frames::message(&header, pixels);
        let mut mailbox = self.mailbox.lock().unwrap_or_else(|e| e.into_inner());
        if mailbox.closed {
            return;
        }
        if mailbox.pending.insert(key.clone(), message).is_none() {
            mailbox.order.push_back(key);
        }
        drop(mailbox);
        self.ready.notify_one();
    }

    /// The track ended: the app drops its last frame.
    pub fn end(&self, source: Source, identity: &str) {
        self.put(Header { source, identity: identity.into(), width: 0, height: 0 }, &[]);
    }

    /// A frame for the app, scaled to fit what it shows, at most every `FRAME_INTERVAL`.
    fn show(&self, source: Source, identity: &str, buffer: &I420Buffer) {
        self.show_within(source, identity, buffer, if source == Source::Camera { CAMERA_FIT } else { SCREEN_FIT });
    }

    fn show_within(&self, source: Source, identity: &str, buffer: &I420Buffer, fit: (u32, u32)) {
        let (width, height) = fitted(buffer.width(), buffer.height(), fit);
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let scaled;
        let buffer = if (width, height) == (buffer.width(), buffer.height()) {
            buffer
        } else {
            // `scale` needs a mutable handle; a copy keeps the caller's buffer as it was.
            let mut copy = copy_i420(buffer);
            scaled = copy.scale(width as i32, height as i32);
            &scaled
        };
        let (y, u, v) = buffer.data();
        let (sy, su, sv) = buffer.strides();
        yuv_helper::i420_to_abgr(y, sy, u, su, v, sv, &mut pixels, width * 4, width as i32, height as i32);
        self.put(Header { source, identity: identity.into(), width, height }, &pixels);
    }
}

/// The largest even size within `fit` with the frame's proportions, never larger than the frame.
fn fitted(width: u32, height: u32, fit: (u32, u32)) -> (u32, u32) {
    let (width, height) = (width.max(2), height.max(2));
    let scale = (fit.0 as f64 / width as f64).min(fit.1 as f64 / height as f64).min(1.0);
    let even = |v: f64| ((v as u32) & !1).max(2);
    (even(width as f64 * scale), even(height as f64 * scale))
}

fn copy_i420(buffer: &I420Buffer) -> I420Buffer {
    let mut copy = I420Buffer::new(buffer.width(), buffer.height());
    let (sy, su, sv) = buffer.strides();
    let (dy, du, dv) = copy.strides();
    let (y, u, v) = buffer.data();
    let (cy, cu, cv) = copy.data_mut();
    let rows = |src: &[u8], src_stride: u32, dst: &mut [u8], dst_stride: u32, width: u32, height: u32| {
        for row in 0..height as usize {
            let (s, d) = (row * src_stride as usize, row * dst_stride as usize);
            dst[d..d + width as usize].copy_from_slice(&src[s..s + width as usize]);
        }
    };
    let (cw, ch) = (buffer.chroma_width(), buffer.chroma_height());
    rows(y, sy, cy, dy, buffer.width(), buffer.height());
    rows(u, su, cu, du, cw, ch);
    rows(v, sv, cv, dv, cw, ch);
    copy
}

/// RGBA (or BGRA when `bgra`) to I420, at most `fit`.
fn to_i420(pixels: &[u8], stride: u32, width: u32, height: u32, bgra: bool, fit: (u32, u32)) -> I420Buffer {
    let (even_w, even_h) = (width & !1, height & !1);
    let mut buffer = I420Buffer::new(even_w.max(2), even_h.max(2));
    let (dy, du, dv) = buffer.strides();
    let (y, u, v) = buffer.data_mut();
    let convert = if bgra { yuv_helper::argb_to_i420 } else { yuv_helper::abgr_to_i420 };
    convert(pixels, stride, y, dy, u, du, v, dv, even_w as i32, even_h as i32);
    let (fit_w, fit_h) = fitted(even_w, even_h, fit);
    if (fit_w, fit_h) == (even_w, even_h) { buffer } else { buffer.scale(fit_w as i32, fit_h as i32) }
}

/// A remote camera or screen, for as long as it is subscribed.
pub async fn watch(track: RemoteVideoTrack, source: Source, identity: String, frames: Arc<Frames>) {
    use futures_util::StreamExt;
    let mut stream = NativeVideoStream::new(track.rtc_track());
    let mut last: Option<Instant> = None;
    while let Some(frame) = stream.next().await {
        if last.is_some_and(|at| at.elapsed() < FRAME_INTERVAL) {
            continue;
        }
        last = Some(Instant::now());
        let buffer = frame.buffer.to_i420();
        frames.show(source, &identity, &buffer);
    }
    frames.end(source, &identity);
}

/// A running capture; dropping it stops the thread.
pub struct Capture {
    stop: Arc<AtomicBool>,
    pub source: NativeVideoSource,
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// What a capture thread shares: where frames go, and how to say it stopped.
struct Sink {
    stop: Arc<AtomicBool>,
    source: NativeVideoSource,
    frames: Option<Arc<Frames>>,
    identity: String,
    kind: Source,
    internal: UnboundedSender<Internal>,
    shown: Option<Instant>,
    /// What is published at most, and how often a screen is captured.
    fit: (u32, u32),
    interval: Duration,
}

impl Sink {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
    /// To the room, and as a preview to the app.
    fn push(&mut self, buffer: I420Buffer) {
        if let Some(frames) = &self.frames
            && self.shown.is_none_or(|at| at.elapsed() >= FRAME_INTERVAL)
        {
            self.shown = Some(Instant::now());
            frames.show(self.kind, &self.identity, &buffer);
        }
        self.source.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buffer));
    }
    fn fail(&self, code: &'static str) {
        if !self.stopped() {
            let _ = self.internal.send(Internal::Failed(self.kind, code));
        }
    }
}

impl Drop for Sink {
    fn drop(&mut self) {
        if let Some(frames) = &self.frames {
            frames.end(self.kind, &self.identity);
        }
    }
}

fn start(
    kind: Source,
    fake: bool,
    chosen: Option<String>,
    quality: ScreenQuality,
    frames: Option<Arc<Frames>>,
    identity: String,
    internal: UnboundedSender<Internal>,
) -> Capture {
    let stop = Arc::new(AtomicBool::new(false));
    // A screen's width follows its height; a very wide one is capped at twice 16:9.
    let screen_fit = (quality.height * 32 / 9, quality.height);
    let (resolution, screencast, fit, interval) = match kind {
        Source::Camera => (VideoResolution { width: 1280, height: 720 }, false, PUBLISH_FIT, FRAME_INTERVAL),
        Source::Screen => (
            VideoResolution { width: quality.height * 16 / 9, height: quality.height },
            true,
            screen_fit,
            Duration::from_millis(1000 / quality.fps.max(1) as u64),
        ),
    };
    let source = NativeVideoSource::new(resolution, screencast);
    let sink = Sink {
        stop: stop.clone(),
        source: source.clone(),
        frames,
        identity,
        kind,
        internal,
        shown: None,
        fit,
        interval,
    };
    std::thread::spawn(move || match (kind, fake) {
        (_, true) => pattern(sink),
        (Source::Camera, false) => camera::run(sink),
        (Source::Screen, false) => desktop(sink, chosen),
    });
    Capture { stop, source }
}

pub fn camera(
    fake: bool,
    frames: Option<Arc<Frames>>,
    identity: String,
    internal: UnboundedSender<Internal>,
) -> Capture {
    start(Source::Camera, fake, None, ScreenQuality::DEFAULT, frames, identity, internal)
}

/// `chosen`: an id from [`list_screens`]; None for the portal's picker on
/// Wayland, the first screen elsewhere.
pub fn screen(
    fake: bool,
    chosen: Option<String>,
    quality: ScreenQuality,
    frames: Option<Arc<Frames>>,
    identity: String,
    internal: UnboundedSender<Internal>,
) -> Capture {
    start(Source::Screen, fake, chosen, quality, frames, identity, internal)
}

/// Wayland: the portal is the picker, and lists nothing beforehand.
fn wayland() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some()
}

fn capturer(kind: DesktopCaptureSourceType) -> Option<DesktopCapturer> {
    let mut options = DesktopCapturerOptions::new(kind);
    options.set_include_cursor(true);
    DesktopCapturer::new(options)
}

/// A source id: its kind, then libwebrtc's id (a window handle for a window).
fn source_id(kind: ScreenKind, id: u64) -> String {
    match kind {
        ScreenKind::Screen => format!("screen:{id}"),
        ScreenKind::Window => format!("window:{id}"),
    }
}

fn parse_source(id: &str) -> Option<(ScreenKind, u64)> {
    let (kind, number) = id.split_once(':')?;
    let kind = match kind {
        "screen" => ScreenKind::Screen,
        "window" => ScreenKind::Window,
        _ => return None,
    };
    Some((kind, number.parse().ok()?))
}

/// Screens, then windows, as [`Event::Screens`]; then each one's thumbnail on
/// the frame stream. On a thread: a capture per source takes a moment.
pub fn list_screens(fake: bool, frames: Option<Arc<Frames>>) {
    if fake {
        let screens = vec![
            ScreenSource { id: "screen:0".into(), kind: ScreenKind::Screen, title: String::new() },
            ScreenSource { id: "window:1".into(), kind: ScreenKind::Window, title: "Test window".into() },
        ];
        return crate::emit(Event::Screens { screens });
    }
    if wayland() {
        return crate::emit(Event::Screens { screens: vec![] });
    }
    std::thread::spawn(move || {
        let mut found = vec![];
        for (kind, type_) in [
            (ScreenKind::Screen, DesktopCaptureSourceType::Screen),
            (ScreenKind::Window, DesktopCaptureSourceType::Window),
        ] {
            let Some(capturer) = capturer(type_) else { continue };
            for source in capturer.get_source_list() {
                let title = if kind == ScreenKind::Window { source.title() } else { String::new() };
                // Untitled windows are tool and helper windows, nothing to share.
                if kind == ScreenKind::Window && title.trim().is_empty() {
                    continue;
                }
                found.push((ScreenSource { id: source_id(kind, source.id()), kind, title }, type_, source));
            }
        }
        crate::emit(Event::Screens { screens: found.iter().map(|(s, ..)| s.clone()).collect() });
        let Some(frames) = frames else { return };
        for (screen, type_, source) in found {
            let Some(mut capturer) = capturer(type_) else { continue };
            let latest: Arc<Mutex<Option<Captured>>> = Arc::default();
            let slot = latest.clone();
            capturer.start_capture(Some(source), move |result: Result<DesktopFrame, CaptureError>| {
                *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(copy(result));
            });
            // A minimised window gives nothing: it goes without a thumbnail.
            for _ in 0..4 {
                capturer.capture_frame();
                let taken = latest.lock().unwrap_or_else(|e| e.into_inner()).take();
                if let Some(Ok((pixels, stride, width, height))) = taken
                    && width >= 2
                    && height >= 2
                {
                    let buffer = to_i420(&pixels, stride, width, height, true, THUMBNAIL_FIT);
                    frames.show_within(Source::Screen, &thumbnail(&screen.id), &buffer, THUMBNAIL_FIT);
                    break;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        }
    });
}

/// The process showing a shared window (Windows), whose sound alone the share carries.
#[cfg(windows)]
pub fn window_process(id: &str) -> Option<u32> {
    let (ScreenKind::Window, handle) = parse_source(id)? else { return None };
    let mut pid = 0u32;
    // SAFETY: a lookup on a window handle libwebrtc listed; a stale one fails and leaves `pid` 0.
    #[allow(unsafe_code)]
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
            windows::Win32::Foundation::HWND(handle as usize as *mut std::ffi::c_void),
            Some(&mut pid),
        );
    }
    (pid != 0).then_some(pid)
}

#[cfg(not(windows))]
pub fn window_process(_id: &str) -> Option<u32> {
    None
}

/// A moving gradient, 15 frames a second, for tests without devices.
fn pattern(mut sink: Sink) {
    let (width, height) = if sink.kind == Source::Camera { (640, 480) } else { (1280, 720) };
    let ready = if sink.kind == Source::Camera { Internal::CameraReady } else { Internal::ScreenReady };
    let _ = sink.internal.send(ready);
    let mut tick = 0u32;
    while !sink.stopped() {
        let mut buffer = I420Buffer::new(width, height);
        let (sy, su, sv) = buffer.strides();
        let (y, u, v) = buffer.data_mut();
        for row in 0..height {
            for col in 0..width {
                y[(row * sy + col) as usize] = ((col + row + tick * 4) % 256) as u8;
            }
        }
        let tint = if sink.kind == Source::Camera { (90, 200) } else { (200, 90) };
        for row in 0..height / 2 {
            for col in 0..width / 2 {
                u[(row * su + col) as usize] = tint.0;
                v[(row * sv + col) as usize] = tint.1;
            }
        }
        sink.push(buffer);
        tick = tick.wrapping_add(1);
        std::thread::sleep(FRAME_INTERVAL);
    }
}

/// A copied screen frame (BGRA, its stride, width, height), or why there is none.
type Captured = Result<(Vec<u8>, u32, u32, u32), CaptureError>;

fn copy(result: Result<DesktopFrame, CaptureError>) -> Captured {
    result
        .map(|frame| (frame.data().to_vec(), frame.stride(), frame.width().max(0) as u32, frame.height().max(0) as u32))
}

/// A screen or a window: the portal's picker on Wayland (PipeWire), else the
/// chosen source, or the first screen. Polled at 15 frames a second.
fn desktop(mut sink: Sink, chosen: Option<String>) {
    let wayland = wayland();
    let wanted = chosen.as_deref().and_then(parse_source).filter(|_| !wayland);
    let kind = match wanted {
        Some((ScreenKind::Window, _)) => DesktopCaptureSourceType::Window,
        _ => DesktopCaptureSourceType::Screen,
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let kind = if wayland { DesktopCaptureSourceType::Generic } else { kind };
    let Some(mut capturer) = capturer(kind) else {
        return sink.fail("screen_unavailable");
    };
    let chosen = if wayland {
        None
    } else {
        let sources = capturer.get_source_list();
        let source = match wanted {
            Some((_, id)) => sources.into_iter().find(|s| s.id() == id),
            None => sources.into_iter().next(),
        };
        match source {
            Some(source) => Some(source),
            None => return sink.fail("screen_unavailable"),
        }
    };
    let latest: Arc<Mutex<Option<Captured>>> = Arc::default();
    let slot = latest.clone();
    capturer.start_capture(chosen, move |result: Result<DesktopFrame, CaptureError>| {
        *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(copy(result));
    });
    let mut started = false;
    while !sink.stopped() {
        let began = Instant::now();
        capturer.capture_frame();
        let taken = latest.lock().unwrap_or_else(|e| e.into_inner()).take();
        match taken {
            Some(Ok((pixels, stride, width, height))) if width >= 2 && height >= 2 => {
                if !started {
                    started = true;
                    let _ = sink.internal.send(Internal::ScreenReady);
                }
                let fit = sink.fit;
                sink.push(to_i420(&pixels, stride, width, height, true, fit));
            }
            // The portal's picker was closed, or the stream stopped from outside.
            Some(Err(CaptureError::Permanent)) => {
                return sink.fail(if started { "screen_ended" } else { "screen_cancelled" });
            }
            _ => {}
        }
        std::thread::sleep(sink.interval.saturating_sub(began.elapsed()));
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
mod camera {
    use super::*;
    use nokhwa::Camera;
    use nokhwa::pixel_format::RgbAFormat;
    use nokhwa::utils::{CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType, Resolution};

    /// The default camera, closest to 1280 by 720 at 30 frames a second.
    pub(super) fn run(mut sink: Sink) {
        let wanted = CameraFormat::new(Resolution::new(1280, 720), FrameFormat::MJPEG, 30);
        let requested = RequestedFormat::new::<RgbAFormat>(RequestedFormatType::Closest(wanted));
        let Ok(mut camera) = Camera::new(CameraIndex::Index(0), requested) else {
            return sink.fail("camera_unavailable");
        };
        if camera.open_stream().is_err() {
            return sink.fail("camera_unavailable");
        }
        let mut ready = false;
        while !sink.stopped() {
            let Ok(frame) = camera.frame() else {
                let _ = camera.stop_stream();
                return sink.fail("camera_unavailable");
            };
            let resolution = frame.resolution();
            let rgba = if frame.source_frame_format() == FrameFormat::MJPEG {
                image::load_from_memory_with_format(frame.buffer(), image::ImageFormat::Jpeg)
                    .ok()
                    .map(|image| image.into_rgba8().into_raw())
            } else {
                frame.decode_image::<RgbAFormat>().ok().map(|image| image.into_raw())
            };
            // A corrupt frame now and then is skipped.
            let Some(rgba) = rgba else { continue };
            let (width, height) = (resolution.width(), resolution.height());
            if rgba.len() < (width * height * 4) as usize {
                continue;
            }
            if !ready {
                ready = true;
                let _ = sink.internal.send(Internal::CameraReady);
            }
            sink.push(to_i420(&rgba, width * 4, width, height, false, PUBLISH_FIT));
        }
        let _ = camera.stop_stream();
    }
}

/// No camera without its permission in the app bundle (macOS): unavailable.
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod camera {
    use super::*;
    pub(super) fn run(sink: Sink) {
        sink.fail("camera_unavailable");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_fit_even_sizes_without_growing() {
        assert_eq!(fitted(1280, 720, CAMERA_FIT), (640, 360));
        assert_eq!(fitted(320, 240, CAMERA_FIT), (320, 240));
        assert_eq!(fitted(2560, 1440, SCREEN_FIT), (1920, 1080));
        assert_eq!(fitted(1001, 333, CAMERA_FIT), (640, 212));
        assert_eq!(fitted(0, 0, CAMERA_FIT), (2, 2));
    }

    #[test]
    fn share_sources_round_trip_their_ids() {
        assert_eq!(parse_source(&source_id(ScreenKind::Window, 4242)), Some((ScreenKind::Window, 4242)));
        assert_eq!(parse_source(&source_id(ScreenKind::Screen, 0)), Some((ScreenKind::Screen, 0)));
        assert_eq!(parse_source("tab:1"), None);
        assert_eq!(parse_source("window:x"), None);
    }
}
