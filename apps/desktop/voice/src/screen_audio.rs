//! The screen's sound, published beside a screen share as its own track
//! (`ScreenshareAudio`): what the computer plays, without this call's voices
//! unless asked (`with_call`, for recording or streaming the whole call; the
//! others then hear themselves). "The call" is this sidecar's playout and the
//! app's own sounds (cues, ringtone), the app's process id coming in
//! `RV_VOICE_APP_PID`.
//!
//! - Windows: WASAPI process loopback of everything but the app's process
//!   tree (the sidecar is in it), or plain loopback of the default output.
//! - Linux: a PipeWire capture node linked, port by port, to every audio
//!   output stream but the app's and the sidecar's (all of them with the call).
//! - macOS: none.
//!
//! Each capture hands interleaved 48 kHz stereo samples to one pusher thread,
//! which cuts 10 ms frames for LiveKit. With `RV_VOICE_FAKE_VIDEO=pattern` a
//! 660 Hz tone stands in, unless `RV_VOICE_SCREEN_AUDIO=capture`.
//! `RV_VOICE_LEVELS=1` prints the captured level every 5 seconds on stderr.
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::AudioSourceOptions;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

const RATE: u32 = 48_000;
const CHANNELS: u32 = 2;
/// 10 ms, the frame size WebRTC takes.
const FRAME: u32 = RATE / 100;
const FRAME_SAMPLES: usize = (FRAME * CHANNELS) as usize;

/// A running capture; dropping it stops its threads.
pub struct ScreenAudio {
    stop: Arc<AtomicBool>,
    pub source: NativeAudioSource,
}

impl Drop for ScreenAudio {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// The processes whose sound is the call: this sidecar and the app.
#[cfg(any(windows, target_os = "linux"))]
fn call_processes() -> Vec<u32> {
    let app = std::env::var("RV_VOICE_APP_PID").ok().and_then(|pid| pid.parse().ok());
    std::iter::once(std::process::id()).chain(app).collect()
}

/// The screen's sound, when this platform can capture it. Called within the runtime.
pub fn start(fake: bool, with_call: bool) -> Option<ScreenAudio> {
    let fake = fake && std::env::var("RV_VOICE_SCREEN_AUDIO").as_deref() != Ok("capture");
    if !fake && !cfg!(any(windows, target_os = "linux")) {
        return None;
    }
    // Music and games, not a voice: no echo cancellation, gain or noise suppression.
    let options = AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false };
    let source = NativeAudioSource::new(options, RATE, CHANNELS, 100);
    let stop = Arc::new(AtomicBool::new(false));
    let (samples, received) = channel::<Vec<i16>>();
    let (pusher_stop, pusher_source) = (stop.clone(), source.clone());
    let runtime = tokio::runtime::Handle::current();
    std::thread::spawn(move || push(&pusher_stop, &pusher_source, &runtime, &received));
    let capture_stop = stop.clone();
    std::thread::spawn(move || {
        if fake {
            tone(&capture_stop, &samples);
        } else if let Err(error) = capture::run(&capture_stop, with_call, &samples) {
            eprintln!("rv-voice: screen audio unavailable: {error}");
        }
    });
    Some(ScreenAudio { stop, source })
}

/// 10 ms frames to LiveKit, paced in real time by `capture_frame`.
fn push(
    stop: &AtomicBool,
    source: &NativeAudioSource,
    runtime: &tokio::runtime::Handle,
    received: &Receiver<Vec<i16>>,
) {
    let levels = std::env::var("RV_VOICE_LEVELS").as_deref() == Ok("1");
    let (mut pending, mut energy, mut count, mut since) = (Vec::<i16>::new(), 0f64, 0u64, Instant::now());
    while !stop.load(Ordering::SeqCst) {
        let Ok(samples) = received.recv_timeout(Duration::from_millis(100)) else { continue };
        pending.extend_from_slice(&samples);
        while pending.len() >= FRAME_SAMPLES {
            let chunk: Vec<i16> = pending.drain(..FRAME_SAMPLES).collect();
            if levels {
                energy += chunk.iter().map(|&s| (s as f64 / 32_768.0).powi(2)).sum::<f64>();
                count += chunk.len() as u64;
                if since.elapsed() >= Duration::from_secs(5) {
                    eprintln!("rv-voice: screen audio level {:.4}", (energy / count.max(1) as f64).sqrt());
                    (energy, count, since) = (0.0, 0, Instant::now());
                }
            }
            let mut frame = AudioFrame::new(RATE, CHANNELS, FRAME);
            frame.data = chunk.into();
            if runtime.block_on(source.capture_frame(&frame)).is_err() {
                return;
            }
        }
    }
}

fn tone(stop: &AtomicBool, samples: &Sender<Vec<i16>>) {
    let step = 2.0 * std::f32::consts::PI * 660.0 / RATE as f32;
    let mut phase = 0f32;
    while !stop.load(Ordering::SeqCst) {
        let mut chunk = Vec::with_capacity(FRAME_SAMPLES);
        for _ in 0..FRAME {
            let value = (phase.sin() * 6_000.0) as i16;
            chunk.extend([value, value]);
            phase = (phase + step) % (2.0 * std::f32::consts::PI);
        }
        if samples.send(chunk).is_err() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(windows)]
mod capture {
    use super::*;
    use std::collections::VecDeque;
    use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

    pub(super) fn run(
        stop: &AtomicBool,
        with_call: bool,
        samples: &Sender<Vec<i16>>,
    ) -> Result<(), wasapi::WasapiError> {
        let _ = initialize_mta().ok();
        let mut client = if with_call {
            DeviceEnumerator::new()?.get_default_device(&Direction::Render)?.get_iaudioclient()?
        } else {
            // Everything but the app's process tree, the sidecar included: the
            // call and the app's own sounds play there.
            let app = *call_processes().last().unwrap_or(&std::process::id());
            AudioClient::new_application_loopback_client(app, false)?
        };
        let format = WaveFormat::new(16, 16, &SampleType::Int, RATE as usize, CHANNELS as usize, None);
        let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 200_000 };
        client.initialize_client(&format, &Direction::Capture, &mode)?;
        let event = client.set_get_eventhandle()?;
        let capture = client.get_audiocaptureclient()?;
        client.start_stream()?;
        let mut queue: VecDeque<u8> = VecDeque::new();
        while !stop.load(Ordering::SeqCst) {
            // Nothing playing sends nothing: the wait times out and the loop goes on.
            let _ = event.wait_for_event(50);
            capture.read_from_device_to_deque(&mut queue)?;
            let whole = queue.len() & !1;
            if whole == 0 {
                continue;
            }
            let bytes: Vec<u8> = queue.drain(..whole).collect();
            let chunk = bytes.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)).collect();
            if samples.send(chunk).is_err() {
                break;
            }
        }
        client.stop_stream()
    }
}

#[cfg(target_os = "linux")]
mod capture {
    use super::*;
    use std::io::Read;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::Mutex;

    /// `RV_SCREEN_AUDIO_BIN`, else beside this executable, else in the
    /// AppImage's `bin` (sharun runs this sidecar through its loader), as the
    /// app finds rv-voice.
    fn locate() -> Option<PathBuf> {
        const BINARY: &str = "rv-screen-audio";
        if let Some(path) = std::env::var_os("RV_SCREEN_AUDIO_BIN") {
            return Some(PathBuf::from(path));
        }
        let beside = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join(BINARY)));
        let bundled = ["SHARUN_DIR", "APPDIR"]
            .into_iter()
            .filter_map(std::env::var_os)
            .filter(|root| !root.is_empty())
            .map(|root| PathBuf::from(root).join("bin").join(BINARY));
        beside.into_iter().chain(bundled).find(|path| path.is_file())
    }

    /// PipeWire runs in rv-screen-audio (its Cargo.toml says why); its stdout is the PCM.
    pub(super) fn run(stop: &AtomicBool, with_call: bool, samples: &Sender<Vec<i16>>) -> Result<(), String> {
        let program = locate().ok_or("rv-screen-audio not found")?;
        let mut command = Command::new(program);
        if !with_call {
            for pid in call_processes() {
                command.arg("--exclude").arg(pid.to_string());
            }
        }
        let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        let mut out = child.stdout.take().ok_or("no output")?;
        let child = Mutex::new(child);
        let ended = AtomicBool::new(false);
        std::thread::scope(|scope| {
            // The share stopped, or the helper ended: it goes, which ends the read below.
            scope.spawn(|| {
                while !stop.load(Ordering::SeqCst) && !ended.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                }
                let mut child = child.lock().unwrap_or_else(|e| e.into_inner());
                let _ = child.kill();
                let _ = child.wait();
            });
            let mut buffer = vec![0u8; 3840];
            let mut carry: Option<u8> = None;
            loop {
                let read = match out.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                let mut bytes: Vec<u8> = carry.take().into_iter().chain(buffer[..read].iter().copied()).collect();
                if bytes.len() % 2 == 1 {
                    carry = bytes.pop();
                }
                let chunk = bytes.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)).collect();
                if samples.send(chunk).is_err() {
                    break;
                }
            }
            ended.store(true, Ordering::SeqCst);
        });
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod capture {
    use super::*;
    pub(super) fn run(_stop: &AtomicBool, _with_call: bool, _samples: &Sender<Vec<i16>>) -> Result<(), &'static str> {
        Err("no screen sound on this platform")
    }
}
