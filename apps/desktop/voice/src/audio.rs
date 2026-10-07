//! The call's sound, played and captured by the sidecar itself rather than by
//! libwebrtc's device module, so that it can:
//! - remove noise with RNNoise (`nnnoiseless`) after WebRTC's echo canceller;
//! - mix each person at the volume this side chose, or mute them here only;
//! - tell who speaks from the sound itself, at once and down to a whisper,
//!   instead of the SFU's coarser active-speaker updates.
//!
//! Capture: the device's rate to 48 kHz mono, 10 ms frames, WebRTC's echo
//! cancellation (against what plays) and high-pass filter, then RNNoise and a
//! voice gate that closes between words (a keyboard, a click: what RNNoise lets
//! through), then WebRTC's gain control, last so that it never raises the noise
//! RNNoise has to remove, then the input volume, then LiveKit. Without RNNoise,
//! WebRTC's own noise suppression takes its place, and no gate. Playout: each remote audio track as 48 kHz stereo, one
//! buffer per track, mixed at each person's gain and the output volume; the mix
//! is also the echo canceller's reference.
//!
//! Devices go through cpal: WASAPI, CoreAudio, and on Linux PulseAudio's
//! protocol (which PipeWire serves) in pure Rust. `RV_VOICE_FAKE_AUDIO=sine`
//! opens no device: a tone stands for the microphone, and remote tracks are
//! still read, for who speaks.
//!
//! Diagnostics: `RV_VOICE_DEBUG=1` prints the devices' formats and, every 5 s,
//! the tracks that ran dry, the backlogs cut and the longest lock wait on the
//! speakers' side; `RV_VOICE_RECORD=<dir>` writes each remote track as received
//! (raw 48 kHz stereo 16-bit); `RV_VOICE_TEST_TONE=1` replaces the microphone's
//! samples with a 440 Hz tone, through the whole path.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use livekit::prelude::RemoteAudioTrack;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::AudioSourceOptions;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::native::apm::AudioProcessingModule;
use nnnoiseless::DenoiseState;
use rv_voice_protocol::Device;
use std::collections::{HashMap, VecDeque};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

const RATE: u32 = 48_000;
/// 10 ms at 48 kHz: WebRTC's frame, and RNNoise's.
const FRAME: usize = 480;
/// A remote track starts playing once this much is buffered (stereo samples)...
const PRIME: usize = 4 * FRAME * 2;
/// ...and is cut back to it past this much (a clock drifting, a burst).
const BACKLOG: usize = 20 * FRAME * 2;
/// Someone still speaks this long after their last loud enough frame.
const HANGOVER: Duration = Duration::from_millis(350);
/// Above this, a remote voice speaks: a whisper after the sender's processing
/// stays above, the noise its suppressor leaves stays below.
const REMOTE_SPEECH_DB: f32 = -52.0;
/// This side: RNNoise's voice probability, above a floor that keeps out a
/// breath it would call voice; without RNNoise, the level alone.
const LOCAL_VOICE: f32 = 0.5;
const LOCAL_FLOOR_DB: f32 = -62.0;
const LOCAL_SPEECH_DB: f32 = -50.0;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// An `f32` shared between threads.
struct Float(AtomicU32);
impl Float {
    fn new(value: f32) -> Self {
        Self(AtomicU32::new(value.to_bits()))
    }
    fn get(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
    fn set(&self, value: f32) {
        self.0.store(value.to_bits(), Ordering::Relaxed);
    }
}

/// RMS of samples in -1..1, in dBFS (silence is -100).
fn decibels(samples: impl Iterator<Item = f32>) -> f32 {
    let (sum, count) = samples.fold((0f64, 0usize), |(s, n), x| (s + (x as f64).powi(2), n + 1));
    if count == 0 || sum == 0.0 {
        return -100.0;
    }
    (10.0 * (sum / count as f64).log10()) as f32
}

/// dBFS to the 0..1 level the app shows: -60 dB and below is nothing.
fn level(db: f32) -> f32 {
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

/// Who speaks, from frame levels: loud enough recently, and a smoothed level.
#[derive(Default)]
struct Activity {
    level: f32,
    heard: Option<Instant>,
}
impl Activity {
    fn frame(&mut self, db: f32, speech: bool) {
        let now = level(db);
        // Fast up, slower down, as a meter reads.
        self.level = if now > self.level { now } else { self.level * 0.8 + now * 0.2 };
        if speech {
            self.heard = Some(Instant::now());
        }
    }
    fn speaking(&self) -> bool {
        self.heard.is_some_and(|at| at.elapsed() < HANGOVER)
    }
    fn quiet(&mut self) {
        self.level = 0.0;
        self.heard = None;
    }
}

/// A remote audio track: its buffer (48 kHz stereo, interleaved) and activity.
struct Remote {
    identity: String,
    /// A microphone, not a screen's sound: only voices speak.
    voice: bool,
    buffer: VecDeque<f32>,
    playing: bool,
    activity: Activity,
}

/// How someone plays here.
#[derive(Clone, Copy)]
struct Gain {
    volume: f32,
    muted: bool,
}

/// WebRTC's processing in two steps around RNNoise: echo cancellation and the
/// high-pass filter first (its own noise suppression only without RNNoise: both
/// would eat a whisper), gain control last.
struct Processing {
    module: AudioProcessingModule,
    gain: AudioProcessingModule,
    webrtc_ns: bool,
}
impl Processing {
    fn new(denoise: bool) -> Self {
        Self {
            module: AudioProcessingModule::new(true, false, true, !denoise),
            gain: AudioProcessingModule::new(false, true, false, false),
            webrtc_ns: !denoise,
        }
    }
}

/// RNNoise's voice probability that opens the gate.
const GATE_VOICE: f32 = 0.6;
/// Frames (10 ms) the gate stays open after the last voice: word endings and short pauses.
const GATE_HOLD: u32 = 30;
/// How much of the gain is left after each closed frame (fades out over about 100 ms).
const GATE_RELEASE: f32 = 0.6;

/// Closes the microphone between words when RNNoise hears no voice: a
/// keyboard's or a mouse's clicks, which RNNoise only softens.
#[derive(Default)]
pub struct Gate {
    gain: f32,
    hold: u32,
}

impl Gate {
    /// Applies the gate to one 10 ms frame, given its voice probability.
    pub fn apply(&mut self, voice: f32, samples: &mut [f32]) {
        if voice >= GATE_VOICE {
            self.hold = GATE_HOLD;
        } else {
            self.hold = self.hold.saturating_sub(1);
        }
        let start = self.gain;
        // Opens at once, so the first syllable passes; closes gradually.
        let end = if self.hold > 0 {
            1.0
        } else if start * GATE_RELEASE < 0.01 {
            0.0
        } else {
            start * GATE_RELEASE
        };
        let step = (end - start) / samples.len().max(1) as f32;
        for (index, sample) in samples.iter_mut().enumerate() {
            *sample *= start + step * index as f32;
        }
        self.gain = end;
    }
}

/// What the sidecar's commands set and the audio threads read, for the whole
/// process: choices made before a connection hold when it starts.
pub struct Mix {
    /// The microphone reaches the room (on, not deafened, not settling).
    sending: AtomicBool,
    deafened: AtomicBool,
    denoise: AtomicBool,
    input_volume: Float,
    output_volume: Float,
    input_level: Float,
    local: Mutex<Activity>,
    processing: Mutex<Processing>,
    remotes: Mutex<HashMap<String, Remote>>,
    gains: Mutex<HashMap<String, Gain>>,
    /// The echo canceller's delay hint: what the devices buffer, in ms.
    output_delay: AtomicU32,
    input_delay: AtomicU32,
    /// A device stream failed (unplugged): the main loop reopens the default.
    pub broken: AtomicBool,
    /// Diagnostics (`RV_VOICE_DEBUG=1`): tracks that ran dry, backlogs cut,
    /// the longest wait for the processing lock in the speakers' callback (µs).
    dry: AtomicU32,
    cut: AtomicU32,
    waited: AtomicU32,
}

impl Mix {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sending: AtomicBool::new(true),
            deafened: AtomicBool::new(false),
            denoise: AtomicBool::new(true),
            input_volume: Float::new(1.0),
            output_volume: Float::new(1.0),
            input_level: Float::new(0.0),
            local: Mutex::default(),
            processing: Mutex::new(Processing::new(true)),
            remotes: Mutex::default(),
            gains: Mutex::default(),
            output_delay: AtomicU32::new(20),
            input_delay: AtomicU32::new(20),
            broken: AtomicBool::new(false),
            dry: AtomicU32::new(0),
            cut: AtomicU32::new(0),
            waited: AtomicU32::new(0),
        })
    }

    /// The diagnostics since the last call: dry tracks, backlogs cut, longest lock wait (µs).
    pub fn diagnostics(&self) -> (u32, u32, u32) {
        (
            self.dry.swap(0, Ordering::Relaxed),
            self.cut.swap(0, Ordering::Relaxed),
            self.waited.swap(0, Ordering::Relaxed),
        )
    }

    pub fn set_sending(&self, on: bool) {
        self.sending.store(on, Ordering::Relaxed);
        if !on {
            lock(&self.local).quiet();
            self.input_level.set(0.0);
        }
    }
    pub fn set_deafened(&self, on: bool) {
        self.deafened.store(on, Ordering::Relaxed);
    }
    pub fn set_denoise(&self, on: bool) {
        self.denoise.store(on, Ordering::Relaxed);
    }
    pub fn set_input_volume(&self, volume: f32) {
        self.input_volume.set(volume.clamp(0.0, 2.0));
    }
    pub fn set_output_volume(&self, volume: f32) {
        self.output_volume.set(volume.clamp(0.0, 2.0));
    }
    pub fn set_gain(&self, identity: &str, volume: f32, muted: bool) {
        lock(&self.gains).insert(identity.into(), Gain { volume: volume.clamp(0.0, 2.0), muted });
    }

    /// This side's microphone level after processing, 0..1.
    pub fn input_level(&self) -> f32 {
        self.input_level.get()
    }

    /// Whether someone speaks, and their level: this side (`local`) from its
    /// microphone, the others from what their tracks play.
    pub fn activity(&self, identity: &str, local: bool) -> (bool, f32) {
        if local {
            let activity = lock(&self.local);
            return (activity.speaking(), activity.level);
        }
        lock(&self.remotes)
            .values()
            .filter(|r| r.voice && r.identity == identity)
            .fold((false, 0f32), |(speaking, level), r| {
                (speaking || r.activity.speaking(), level.max(r.activity.level))
            })
    }

    /// A remote track's 10 ms frame (48 kHz stereo).
    fn receive(&self, sid: &str, identity: &str, voice: bool, samples: &[i16], play: bool) {
        // Diagnostics: each track's sound as received, raw 48 kHz stereo i16.
        if let Ok(dir) = std::env::var("RV_VOICE_RECORD") {
            use std::io::Write;
            let path = std::path::Path::new(&dir).join(format!("{identity}.raw"));
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
                let _ = file.write_all(&bytes);
            }
        }
        let floats = samples.iter().map(|&s| s as f32 / 32_768.0);
        let db = decibels(floats.clone());
        let mut remotes = lock(&self.remotes);
        let remote = remotes.entry(sid.into()).or_insert_with(|| Remote {
            identity: identity.into(),
            voice,
            buffer: VecDeque::new(),
            playing: false,
            activity: Activity::default(),
        });
        remote.activity.frame(db, db > REMOTE_SPEECH_DB);
        if play {
            remote.buffer.extend(floats);
            if remote.buffer.len() > BACKLOG {
                let extra = remote.buffer.len() - PRIME;
                remote.buffer.drain(..extra);
                self.cut.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn forget(&self, sid: &str) {
        lock(&self.remotes).remove(sid);
    }

    /// The next 10 ms of everything the call plays (48 kHz stereo, -1..1),
    /// also handed to the echo canceller.
    fn next(&self) -> Vec<f32> {
        let mut out = vec![0f32; FRAME * 2];
        let deafened = self.deafened.load(Ordering::Relaxed);
        {
            let gains = lock(&self.gains);
            let mut remotes = lock(&self.remotes);
            for remote in remotes.values_mut() {
                if !remote.playing && remote.buffer.len() >= PRIME {
                    remote.playing = true;
                }
                if !remote.playing {
                    continue;
                }
                if remote.buffer.len() < out.len() {
                    // Ran dry (loss, a late packet): wait for a cushion again.
                    remote.playing = false;
                    remote.buffer.clear();
                    self.dry.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                let gain = gains.get(&remote.identity).copied().unwrap_or(Gain { volume: 1.0, muted: false });
                let factor = if gain.muted || deafened { 0.0 } else { gain.volume };
                for (sample, value) in out.iter_mut().zip(remote.buffer.drain(..FRAME * 2)) {
                    *sample += value * factor;
                }
            }
        }
        let master = self.output_volume.get();
        for sample in &mut out {
            *sample = (*sample * master).clamp(-1.0, 1.0);
        }
        let mut reference: Vec<i16> = out.iter().map(|&s| (s * 32_767.0) as i16).collect();
        let asked = Instant::now();
        let mut processing = lock(&self.processing);
        self.waited.fetch_max(asked.elapsed().as_micros() as u32, Ordering::Relaxed);
        let _ = processing.module.process_reverse_stream(&mut reference, RATE as i32, 2);
        out
    }

    /// One 10 ms microphone frame (48 kHz mono, -1..1) through the processing;
    /// what the room hears, or None while not sending.
    fn capture(&self, frame: &[f32], denoiser: &mut DenoiseState, gate: &mut Gate) -> Option<Vec<i16>> {
        let mut pcm: Vec<i16> = frame.iter().map(|&s| (s * 32_767.0).clamp(-32_768.0, 32_767.0) as i16).collect();
        let denoise = self.denoise.load(Ordering::Relaxed);
        {
            let mut processing = lock(&self.processing);
            if processing.webrtc_ns == denoise {
                *processing = Processing::new(denoise);
            }
            let delay = self.output_delay.load(Ordering::Relaxed) + self.input_delay.load(Ordering::Relaxed);
            let _ = processing.module.set_stream_delay_ms(delay as i32);
            let _ = processing.module.process_stream(&mut pcm, RATE as i32, 1);
        }
        let mut samples: Vec<f32> = pcm.iter().map(|&s| s as f32).collect();
        let voice = if denoise {
            let mut clean = vec![0f32; FRAME];
            let probability = denoiser.process_frame(&mut clean, &samples);
            gate.apply(probability, &mut clean);
            samples = clean;
            Some(probability)
        } else {
            None
        };
        let mut pcm: Vec<i16> = samples.iter().map(|&s| s.clamp(-32_768.0, 32_767.0) as i16).collect();
        let _ = lock(&self.processing).gain.process_stream(&mut pcm, RATE as i32, 1);
        let gain = self.input_volume.get();
        let pcm: Vec<i16> = pcm.iter().map(|&s| (s as f32 * gain).clamp(-32_768.0, 32_767.0) as i16).collect();
        if !self.sending.load(Ordering::Relaxed) {
            return None;
        }
        let db = decibels(pcm.iter().map(|&s| s as f32 / 32_768.0));
        let speech = match voice {
            Some(probability) => probability >= LOCAL_VOICE && db > LOCAL_FLOOR_DB,
            None => db > LOCAL_SPEECH_DB,
        };
        let mut local = lock(&self.local);
        local.frame(db, speech);
        self.input_level.set(local.level);
        Some(pcm)
    }
}

/// The devices: microphones, then speakers. A PulseAudio monitor (another
/// device's playback) is no microphone.
pub fn devices() -> (Vec<Device>, Vec<Device>) {
    let host = cpal::default_host();
    let id = |d: &cpal::Device| d.id().ok().map(|id| id.to_string());
    let list = |devices: Option<Vec<cpal::Device>>, default: Option<String>| -> Vec<Device> {
        devices
            .unwrap_or_default()
            .iter()
            .filter_map(|d| {
                let id = id(d)?;
                let name = d.description().ok().map(|n| n.name().to_owned()).unwrap_or_else(|| id.clone());
                Some(Device { default: Some(&id) == default.as_ref(), id, name })
            })
            .filter(|d| !d.id.ends_with(".monitor"))
            .collect()
    };
    let inputs =
        list(host.input_devices().ok().map(Iterator::collect), host.default_input_device().as_ref().and_then(id));
    let outputs =
        list(host.output_devices().ok().map(Iterator::collect), host.default_output_device().as_ref().and_then(id));
    (inputs, outputs)
}

/// A device by the id `devices` gave it, the default when empty; None when
/// it is gone (the default then stands in).
fn device(id: &str, input: bool) -> (Option<cpal::Device>, bool) {
    let host = cpal::default_host();
    let fallback = || if input { host.default_input_device() } else { host.default_output_device() };
    if id.is_empty() {
        return (fallback(), true);
    }
    let found = cpal::DeviceId::from_str(id).ok().and_then(|id| host.device_by_id(&id));
    match found {
        Some(device) => (Some(device), true),
        None => (fallback(), false),
    }
}

/// The audio of one connection: its devices' streams and the microphone track's source.
pub struct Audio {
    mix: Arc<Mix>,
    pub source: NativeAudioSource,
    frames: mpsc::UnboundedSender<Vec<i16>>,
    input: Option<cpal::Stream>,
    output: Option<cpal::Stream>,
    fake: bool,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for Audio {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        lock(&self.mix.remotes).clear();
        lock(&self.mix.local).quiet();
    }
}

impl Audio {
    /// Opens the chosen devices (empty ids: the defaults). Within the runtime.
    /// Also says whether both devices were found.
    pub fn start(mix: Arc<Mix>, fake: bool, input: &str, output: &str) -> (Self, bool) {
        // The processing runs here, not again in LiveKit's source.
        let options =
            AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false };
        let source = NativeAudioSource::new(options, RATE, 1, 100);
        let (frames, mut received) = mpsc::unbounded_channel::<Vec<i16>>();
        let pusher = source.clone();
        let mut tasks = vec![tokio::spawn(async move {
            while let Some(samples) = received.recv().await {
                let frame = AudioFrame {
                    data: samples.into(),
                    sample_rate: RATE,
                    num_channels: 1,
                    samples_per_channel: FRAME as u32,
                };
                if pusher.capture_frame(&frame).await.is_err() {
                    return;
                }
            }
        })];
        mix.broken.store(false, Ordering::Relaxed);
        let mut audio = Self { mix, source, frames, input: None, output: None, fake, tasks: vec![] };
        let found = if fake {
            tasks.push(tokio::spawn(sine(audio.mix.clone(), audio.frames.clone())));
            true
        } else {
            let found_in = audio.set_input(input);
            let found_out = audio.set_output(output);
            found_in && found_out
        };
        audio.tasks = tasks;
        (audio, found)
    }

    /// Reopens the microphone; false when that device is gone (the default then).
    pub fn set_input(&mut self, id: &str) -> bool {
        if self.fake {
            return true;
        }
        self.input = None;
        let (device, found) = device(id, true);
        self.input = device.and_then(|d| match capture(&d, self.mix.clone(), self.frames.clone()) {
            Ok(stream) => Some(stream),
            Err(error) => {
                eprintln!("rv-voice: microphone unavailable: {error}");
                None
            }
        });
        found && self.input.is_some()
    }

    pub fn set_output(&mut self, id: &str) -> bool {
        if self.fake {
            return true;
        }
        self.output = None;
        let (device, found) = device(id, false);
        self.output = device.and_then(|d| match play(&d, self.mix.clone()) {
            Ok(stream) => Some(stream),
            Err(error) => {
                eprintln!("rv-voice: speakers unavailable: {error}");
                None
            }
        });
        found && self.output.is_some()
    }

    /// Reads a remote audio track for as long as it is subscribed.
    pub fn listen(
        &self,
        sid: String,
        identity: String,
        voice: bool,
        track: RemoteAudioTrack,
    ) -> tokio::task::JoinHandle<()> {
        use futures_util::StreamExt;
        let (mix, play) = (self.mix.clone(), !self.fake);
        tokio::spawn(async move {
            let mut stream = NativeAudioStream::new(track.rtc_track(), RATE as i32, 2);
            while let Some(frame) = stream.next().await {
                mix.receive(&sid, &identity, voice, &frame.data, play);
            }
            mix.forget(&sid);
        })
    }

    pub fn forget(&self, sid: &str) {
        self.mix.forget(sid);
    }
}

/// The speakers: 48 kHz stereo from the mix, to the device's own rate and channels.
fn play(device: &cpal::Device, mix: Arc<Mix>) -> Result<cpal::Stream, String> {
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let config = supported.config();
    if std::env::var("RV_VOICE_DEBUG").as_deref() == Ok("1") {
        eprintln!("rv-voice: speakers {:?} {:?}", supported.sample_format(), config);
    }
    let stream = match supported.sample_format() {
        SampleFormat::F32 => play_as::<f32>(device, &config, mix),
        SampleFormat::I16 => play_as::<i16>(device, &config, mix),
        SampleFormat::I32 => play_as::<i32>(device, &config, mix),
        SampleFormat::U16 => play_as::<u16>(device, &config, mix),
        other => return Err(format!("unsupported sample format {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

fn play_as<T: SizedSample + FromSample<f32>>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mix: Arc<Mix>,
) -> Result<cpal::Stream, String> {
    let channels = config.channels as usize;
    let step = RATE as f64 / config.sample_rate as f64;
    let (mut pending, mut position) = (VecDeque::<[f32; 2]>::new(), 0f64);
    let broken = mix.clone();
    device
        .build_output_stream(
            *config,
            move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
                let stamp = info.timestamp();
                let ahead = stamp.playback.saturating_duration_since(stamp.callback);
                let queued = pending.len() as u64 * 1000 / RATE as u64;
                mix.output_delay.store((ahead.as_millis() as u64 + queued) as u32, Ordering::Relaxed);
                for frame in data.chunks_mut(channels) {
                    while pending.len() < 2 {
                        let next = mix.next();
                        pending.extend(next.as_chunks::<2>().0.iter().copied());
                    }
                    let (a, b, t) = (pending[0], pending[1], position as f32);
                    let (left, right) = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
                    match frame {
                        [mono] => *mono = T::from_sample((left + right) / 2.0),
                        [l, r, rest @ ..] => {
                            *l = T::from_sample(left);
                            *r = T::from_sample(right);
                            for other in rest {
                                *other = T::from_sample(0.0);
                            }
                        }
                        [] => {}
                    }
                    position += step;
                    while position >= 1.0 {
                        position -= 1.0;
                        pending.pop_front();
                    }
                }
            },
            move |error| {
                eprintln!("rv-voice: speakers: {error}");
                broken.broken.store(true, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|e| e.to_string())
}

/// The microphone: the device's rate and channels to 48 kHz mono, 10 ms frames.
fn capture(
    device: &cpal::Device,
    mix: Arc<Mix>,
    frames: mpsc::UnboundedSender<Vec<i16>>,
) -> Result<cpal::Stream, String> {
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let config = supported.config();
    if std::env::var("RV_VOICE_DEBUG").as_deref() == Ok("1") {
        eprintln!("rv-voice: microphone {:?} {:?}", supported.sample_format(), config);
    }
    let stream = match supported.sample_format() {
        SampleFormat::F32 => capture_as::<f32>(device, &config, mix, frames),
        SampleFormat::I16 => capture_as::<i16>(device, &config, mix, frames),
        SampleFormat::I32 => capture_as::<i32>(device, &config, mix, frames),
        SampleFormat::U16 => capture_as::<u16>(device, &config, mix, frames),
        other => return Err(format!("unsupported sample format {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

fn capture_as<T: SizedSample>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mix: Arc<Mix>,
    frames: mpsc::UnboundedSender<Vec<i16>>,
) -> Result<cpal::Stream, String>
where
    f32: FromSample<T>,
{
    let channels = (config.channels as usize).max(1);
    let step = config.sample_rate as f64 / RATE as f64;
    let (mut previous, mut position) = (0f32, 0f64);
    let mut frame = Vec::with_capacity(FRAME);
    let mut denoiser = DenoiseState::new();
    let mut gate = Gate::default();
    let broken = mix.clone();
    // Diagnostics: a 440 Hz tone in place of the microphone, through the whole path.
    let tone = std::env::var("RV_VOICE_TEST_TONE").as_deref() == Ok("1");
    let (mut phase, device_rate) = (0f32, config.sample_rate as f32);
    device
        .build_input_stream(
            *config,
            move |data: &[T], info: &cpal::InputCallbackInfo| {
                let stamp = info.timestamp();
                let behind = stamp.callback.saturating_duration_since(stamp.capture);
                mix.input_delay.store(behind.as_millis() as u32 + 10, Ordering::Relaxed);
                for samples in data.chunks(channels) {
                    let mut mono = samples.iter().map(|&s| f32::from_sample(s)).sum::<f32>() / channels as f32;
                    if tone {
                        mono = (phase.sin()) * 0.3;
                        phase =
                            (phase + 2.0 * std::f32::consts::PI * 440.0 / device_rate) % (2.0 * std::f32::consts::PI);
                    }
                    // Linear resampling: each 48 kHz sample between the last two device samples.
                    while position < 1.0 {
                        frame.push(previous + (mono - previous) * position as f32);
                        position += step;
                        if frame.len() == FRAME {
                            if let Some(pcm) = mix.capture(&frame, &mut denoiser, &mut gate) {
                                let _ = frames.send(pcm);
                            }
                            frame.clear();
                        }
                    }
                    position -= 1.0;
                    previous = mono;
                }
            },
            move |error| {
                eprintln!("rv-voice: microphone: {error}");
                broken.broken.store(true, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|e| e.to_string())
}

/// A 440 Hz tone in 10 ms frames for headless tests: this side "speaks" while sending.
async fn sine(mix: Arc<Mix>, frames: mpsc::UnboundedSender<Vec<i16>>) {
    let step = 2.0 * std::f32::consts::PI * 440.0 / RATE as f32;
    let mut phase = 0f32;
    let mut tick = tokio::time::interval(Duration::from_millis(10));
    loop {
        tick.tick().await;
        let mut pcm = vec![0i16; FRAME];
        for sample in pcm.iter_mut() {
            *sample = (phase.sin() * 12_000.0) as i16;
            phase = (phase + step) % (2.0 * std::f32::consts::PI);
        }
        if !mix.sending.load(Ordering::Relaxed) {
            continue;
        }
        {
            let mut local = lock(&mix.local);
            local.frame(decibels(pcm.iter().map(|&s| s as f32 / 32_768.0)), true);
            mix.input_level.set(local.level);
        }
        if frames.send(pcm).is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_and_speech_follow_the_frames() {
        assert_eq!(decibels([].into_iter()), -100.0);
        assert!((decibels([0.5f32; 480].into_iter()) - -6.02).abs() < 0.01);
        assert_eq!(level(-60.0), 0.0);
        assert_eq!(level(0.0), 1.0);
        let mut activity = Activity::default();
        activity.frame(-30.0, true);
        assert!(activity.speaking() && activity.level > 0.4);
        activity.frame(-90.0, false);
        assert!(activity.speaking(), "within the hangover");
        assert!(activity.level < 0.5 && activity.level > 0.0, "the meter falls back slowly");
        activity.quiet();
        assert!(!activity.speaking());
    }

    #[test]
    fn the_gate_opens_on_a_voice_holds_then_fades() {
        let mut gate = Gate::default();
        let mut frame = [1000f32; FRAME];
        // A click alone: RNNoise hears no voice, nothing passes.
        gate.apply(0.2, &mut frame);
        assert!(frame.iter().all(|&s| s == 0.0));
        // A voice: open within the frame, and fully the next one.
        let mut frame = [1000f32; FRAME];
        gate.apply(0.9, &mut frame);
        assert!(frame[0] == 0.0 && frame[FRAME - 1] > 990.0);
        let mut frame = [1000f32; FRAME];
        gate.apply(0.1, &mut frame);
        assert!(frame.iter().all(|&s| s == 1000.0), "held after the voice");
        for _ in 2..GATE_HOLD {
            gate.apply(0.1, &mut [0f32; FRAME]);
        }
        // Past the hold: it fades out, then shuts.
        let mut frame = [1000f32; FRAME];
        gate.apply(0.1, &mut frame);
        assert!(frame[FRAME - 1] < 650.0 && frame[FRAME - 1] > 550.0);
        for _ in 0..12 {
            gate.apply(0.1, &mut [0f32; FRAME]);
        }
        let mut frame = [1000f32; FRAME];
        gate.apply(0.1, &mut frame);
        assert!(frame.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn remotes_mix_at_their_gain_and_speak_from_their_sound() {
        let mix = Mix::new();
        // A whisper at -40 dBFS speaks; quiet noise at -70 does not.
        let whisper = vec![(0.01 * 32_768.0) as i16; FRAME * 2];
        let noise = vec![(0.0003 * 32_768.0) as i16; FRAME * 2];
        for _ in 0..4 {
            mix.receive("t1", "alice", true, &whisper, true);
            mix.receive("t2", "bob", true, &noise, true);
        }
        assert!(mix.activity("alice", false).0);
        assert!(!mix.activity("bob", false).0);
        // Primed after 40 ms: alice at half volume, bob muted here.
        mix.set_gain("alice", 0.5, false);
        mix.set_gain("bob", 1.0, true);
        let out = mix.next();
        let expected = 0.01 * 0.5;
        assert!(out.iter().all(|&s| (s - expected).abs() < 1e-4), "{}", out[0]);
        mix.set_deafened(true);
        assert!(mix.next().iter().all(|&s| s == 0.0));
        mix.forget("t1");
        assert!(!mix.activity("alice", false).0);
    }
}
