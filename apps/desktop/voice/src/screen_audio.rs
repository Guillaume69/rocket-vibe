//! The screen's sound, published beside a screen share as its own track
//! (`ScreenshareAudio`): what the computer plays, without this call's voices
//! unless asked (`with_call`, for recording or streaming the whole call; the
//! others then hear themselves).
//!
//! Windows only: WASAPI process loopback of everything but this process tree,
//! whose playout is the call, or plain loopback of the default output with the
//! call. Linux would need the call routed apart first; macOS has no loopback.
//! With `RV_VOICE_FAKE_VIDEO=pattern`, a 660 Hz tone stands in.
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::AudioSourceOptions;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const RATE: u32 = 48_000;
const CHANNELS: u32 = 2;
/// 10 ms, the frame size WebRTC takes.
const FRAME: u32 = RATE / 100;

/// A running capture; dropping it stops the thread.
pub struct ScreenAudio {
    stop: Arc<AtomicBool>,
    pub source: NativeAudioSource,
}

impl Drop for ScreenAudio {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// The screen's sound, when this platform can capture it. Called within the runtime.
pub fn start(fake: bool, with_call: bool) -> Option<ScreenAudio> {
    if !fake && !cfg!(windows) {
        return None;
    }
    // Music and games, not a voice: no echo cancellation, gain or noise suppression.
    let options = AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false };
    let source = NativeAudioSource::new(options, RATE, CHANNELS, 100);
    let stop = Arc::new(AtomicBool::new(false));
    let (thread_stop, thread_source) = (stop.clone(), source.clone());
    let runtime = tokio::runtime::Handle::current();
    std::thread::spawn(move || {
        let push = |samples: Vec<i16>| {
            let mut frame = AudioFrame::new(RATE, CHANNELS, FRAME);
            frame.data = samples.into();
            // Paces itself in real time, as the microphone's tone does.
            runtime.block_on(thread_source.capture_frame(&frame)).is_ok()
        };
        if fake {
            tone(&thread_stop, push);
        } else {
            loopback::run(&thread_stop, with_call, push);
        }
    });
    Some(ScreenAudio { stop, source })
}

fn tone(stop: &AtomicBool, push: impl Fn(Vec<i16>) -> bool) {
    let step = 2.0 * std::f32::consts::PI * 660.0 / RATE as f32;
    let mut phase = 0f32;
    while !stop.load(Ordering::SeqCst) {
        let mut samples = Vec::with_capacity((FRAME * CHANNELS) as usize);
        for _ in 0..FRAME {
            let value = (phase.sin() * 6_000.0) as i16;
            samples.extend([value, value]);
            phase = (phase + step) % (2.0 * std::f32::consts::PI);
        }
        if !push(samples) {
            return;
        }
    }
}

#[cfg(windows)]
mod loopback {
    use super::*;
    use std::collections::VecDeque;
    use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, initialize_mta};

    /// Bytes of one 10 ms frame: 16-bit stereo.
    const FRAME_BYTES: usize = (FRAME * CHANNELS * 2) as usize;

    pub(super) fn run(stop: &AtomicBool, with_call: bool, push: impl Fn(Vec<i16>) -> bool) {
        if let Err(error) = capture(stop, with_call, push) {
            eprintln!("rv-voice: screen audio unavailable: {error}");
        }
    }

    fn capture(stop: &AtomicBool, with_call: bool, push: impl Fn(Vec<i16>) -> bool) -> Result<(), wasapi::WasapiError> {
        let _ = initialize_mta().ok();
        let mut client = if with_call {
            DeviceEnumerator::new()?.get_default_device(&Direction::Render)?.get_iaudioclient()?
        } else {
            // Everything but this process tree: the call plays here.
            AudioClient::new_application_loopback_client(std::process::id(), false)?
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
            while queue.len() >= FRAME_BYTES {
                let bytes: Vec<u8> = queue.drain(..FRAME_BYTES).collect();
                let samples = bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
                if !push(samples) {
                    return client.stop_stream();
                }
            }
        }
        client.stop_stream()
    }
}

#[cfg(not(windows))]
mod loopback {
    use super::*;
    pub(super) fn run(_stop: &AtomicBool, _with_call: bool, _push: impl Fn(Vec<i16>) -> bool) {}
}
