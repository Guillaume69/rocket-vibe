//! rv-voice: one LiveKit voice connection, driven by the desktop app over JSON
//! lines (crates/rv-voice-protocol): audio, camera and screen out, and the room's
//! video to the app (video.rs). One process per connection: it exits once
//! disconnected, and when its stdin closes (the app died).
//!
//! `RV_VOICE_FAKE_AUDIO=sine` publishes a synthetic tone instead of opening the
//! microphone and speakers, `RV_VOICE_FAKE_VIDEO=pattern` a test pattern instead
//! of the camera and the screen, for headless tests.
mod screen_audio;
mod video;

use livekit::e2ee::key_provider::{KeyProvider, KeyProviderOptions};
use livekit::e2ee::{E2eeOptions, EncryptionType};
use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::track::VideoQuality;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::AudioSourceOptions;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::peer_connection_factory::native::PeerConnectionFactoryExt;
use livekit::webrtc::video_source::RtcVideoSource;
use rv_voice_protocol::frames::Source;
use rv_voice_protocol::{
    Command, ConnectionState as State, DEAFENED_ATTRIBUTE, Device, Event, Participant as Member, VERSION,
};
use screen_audio::ScreenAudio;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::Instant;
use video::{Capture, Frames, Internal};

/// After undeafening, the echo canceller has had no playout reference for a
/// while: keep the microphone silent until it has converged again.
const AEC_SETTLE: Duration = Duration::from_millis(1000);
/// LiveKit's `TrackSource::SCREEN_SHARE` in a permission's publish sources.
const SCREEN_SHARE_SOURCE: i32 = 3;

fn emit(event: Event) {
    // LiveKit reports some transitions twice (state change, then `Reconnected`).
    static STATE: std::sync::Mutex<Option<State>> = std::sync::Mutex::new(None);
    if let Event::State { state } = &event {
        let mut last = STATE.lock().unwrap_or_else(|e| e.into_inner());
        if *last == Some(*state) {
            return;
        }
        *last = Some(*state);
    }
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", event.line());
    let _ = out.flush();
}

fn error(code: &str) {
    emit(Event::Error { code: code.into() });
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("rv-voice {} (protocol {VERSION}, livekit 0.9.3)", env!("CARGO_PKG_VERSION"));
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build();
    let Ok(runtime) = runtime else { std::process::exit(2) };
    runtime.block_on(run());
    // The stdin thread may still block on a read: leave without joining it.
    std::process::exit(0);
}

async fn run() {
    let (tx, mut commands) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim_start_matches('\u{feff}');
            if line.trim().is_empty() {
                continue;
            }
            let command = serde_json::from_str::<Command>(line).map_err(|_| ());
            if tx.send(command).is_err() {
                break;
            }
        }
    });
    emit(Event::Hello { version: VERSION, sidecar: env!("CARGO_PKG_VERSION").into() });
    let (internal, mut captures) = mpsc::unbounded_channel();
    let mut voice = Voice::new(std::env::var("RV_VOICE_FAKE_AUDIO").is_ok_and(|v| v == "sine"), internal);
    voice.fake_video = std::env::var("RV_VOICE_FAKE_VIDEO").is_ok_and(|v| v == "pattern");
    let mut events: Option<mpsc::UnboundedReceiver<RoomEvent>> = None;
    loop {
        let settle = voice.settle;
        tokio::select! {
            command = commands.recv() => match command {
                // stdin closed: the app is gone, leave rather than linger in the room.
                None => return voice.close().await,
                Some(Err(())) => error("invalid_command"),
                Some(Ok(Command::Disconnect)) => {
                    voice.close().await;
                    emit(Event::State { state: State::Disconnected });
                    emit(Event::Disconnected { reason: "client_initiated".into() });
                    return;
                }
                Some(Ok(Command::Connect { url, token, e2ee_key })) => {
                    if voice.room.is_some() {
                        error("already_connected");
                        continue;
                    }
                    emit(Event::State { state: State::Connecting });
                    // LiveKit's frame encryption under the group's key: the same
                    // shared key, index and defaults as the Android engine.
                    let mut options = RoomOptions::default();
                    options.encryption = e2ee_key.map(|key| E2eeOptions {
                        encryption_type: EncryptionType::Gcm,
                        key_provider: KeyProvider::with_shared_key(KeyProviderOptions::default(), key.into_bytes()),
                    });
                    match Room::connect(&url, &token, options).await {
                        Ok((room, receiver)) => {
                            events = Some(receiver);
                            voice.room = Some(Arc::new(room));
                            emit(Event::State { state: State::Connected });
                            voice.start_audio().await;
                            voice.publish_participants();
                        }
                        Err(_) => {
                            emit(Event::State { state: State::Disconnected });
                            emit(Event::Disconnected { reason: "connect_failed".into() });
                            return;
                        }
                    }
                }
                Some(Ok(command)) => voice.command(command).await,
            },
            Some(news) = captures.recv() => voice.capture(news).await,
            event = async { events.as_mut().unwrap().recv().await }, if events.is_some() => {
                let Some(event) = event else {
                    voice.close().await;
                    emit(Event::State { state: State::Disconnected });
                    emit(Event::Disconnected { reason: "other".into() });
                    return;
                };
                if let RoomEvent::Disconnected { reason } = &event {
                    let reason = match reason.as_str_name() {
                        "UNKNOWN_REASON" => "other".into(),
                        name => name.to_lowercase(),
                    };
                    voice.close().await;
                    emit(Event::State { state: State::Disconnected });
                    emit(Event::Disconnected { reason });
                    return;
                }
                voice.room_event(event).await;
            },
            _ = tokio::time::sleep_until(settle.unwrap_or_else(Instant::now)), if settle.is_some() => {
                voice.settle = None;
                voice.apply_microphone();
            },
        }
    }
}

struct Voice {
    fake: bool,
    room: Option<Arc<Room>>,
    /// Kept alive for the whole session: dropping the last handle switches the
    /// audio device module back to synthetic mode (no microphone, no speakers).
    audio: Option<PlatformAudio>,
    track: Option<LocalAudioTrack>,
    microphone: bool,
    deafened: bool,
    input: Option<String>,
    output: Option<String>,
    settle: Option<Instant>,
    last: Option<Vec<Member>>,
    fake_video: bool,
    /// Where the app reads video frames, once it said.
    frames: Option<Arc<Frames>>,
    internal: mpsc::UnboundedSender<Internal>,
    /// This side's camera and screen: the capture, then its published track.
    camera: Option<(Capture, Option<LocalVideoTrack>)>,
    screen: Option<(Capture, Option<LocalVideoTrack>)>,
    /// The screen's sound, beside a published screen, and whether it carries the call.
    screen_audio: Option<(ScreenAudio, Option<LocalAudioTrack>)>,
    with_call: bool,
    /// The room's video tracks this side shows, by track.
    watched: HashMap<TrackSid, (tokio::task::JoinHandle<()>, Source, String)>,
}

impl Voice {
    fn new(fake: bool, internal: mpsc::UnboundedSender<Internal>) -> Self {
        Self {
            fake,
            fake_video: false,
            frames: None,
            internal,
            camera: None,
            screen: None,
            screen_audio: None,
            with_call: false,
            watched: HashMap::new(),
            room: None,
            audio: None,
            track: None,
            microphone: true,
            deafened: false,
            input: None,
            output: None,
            settle: None,
            last: None,
        }
    }

    async fn close(&mut self) {
        self.camera = None;
        self.screen = None;
        self.screen_audio = None;
        for (_, (task, source, identity)) in self.watched.drain() {
            task.abort();
            if let Some(frames) = &self.frames {
                frames.end(source, &identity);
            }
        }
        if let Some(room) = self.room.take() {
            let _ = tokio::time::timeout(Duration::from_secs(3), room.close()).await;
        }
        self.track = None;
        self.audio = None;
    }

    async fn command(&mut self, command: Command) {
        match command {
            Command::Video { address, token } => {
                if self.frames.is_none() {
                    self.frames = Some(Frames::connect(address, token));
                }
            }
            Command::SetCamera { enabled } => {
                if !enabled {
                    return self.stop_video(Source::Camera).await;
                }
                if self.camera.is_none() && self.may_publish() {
                    let identity = self.local_identity();
                    self.camera = Some((
                        video::camera(self.fake_video, self.frames.clone(), identity, self.internal.clone()),
                        None,
                    ));
                }
            }
            Command::StartScreenShare { with_call } => {
                if self.screen.is_none() && self.may_publish() {
                    self.with_call = with_call;
                    let identity = self.local_identity();
                    self.screen = Some((
                        video::screen(self.fake_video, self.frames.clone(), identity, self.internal.clone()),
                        None,
                    ));
                }
            }
            Command::StopScreenShare => self.stop_video(Source::Screen).await,
            Command::SetMicrophone { enabled } => {
                self.microphone = enabled;
                self.apply_microphone();
                self.publish_participants();
            }
            Command::SetDeafened { deafened } => {
                if self.deafened == deafened {
                    return;
                }
                self.deafened = deafened;
                if !deafened && self.track.is_some() && !self.fake {
                    self.settle = Some(Instant::now() + AEC_SETTLE);
                }
                self.apply_deafened();
                self.apply_microphone();
                if let Some(room) = &self.room {
                    let participant = room.local_participant();
                    let value = if deafened { "1" } else { "" };
                    tokio::spawn(async move {
                        let attributes = HashMap::from([(DEAFENED_ATTRIBUTE.to_owned(), value.to_owned())]);
                        if participant.set_attributes(attributes).await.is_err() {
                            error("attribute_failed");
                        }
                    });
                }
                self.publish_participants();
            }
            Command::ListDevices => self.list_devices(),
            Command::SetInput { device } => {
                self.input = Some(device);
                if let Some(audio) = &self.audio
                    && !select(audio, self.input.as_deref().unwrap_or_default(), true)
                {
                    error("device_not_found");
                }
            }
            Command::SetOutput { device } => {
                self.output = Some(device);
                if let Some(audio) = &self.audio
                    && !select(audio, self.output.as_deref().unwrap_or_default(), false)
                {
                    error("device_not_found");
                }
            }
            Command::SetKey { key } => match self.room.as_ref().and_then(|r| r.e2ee_manager().key_provider()) {
                Some(keys) => keys.set_shared_key(key.into_bytes(), 0),
                None => error("not_encrypted"),
            },
            Command::Connect { .. } | Command::Disconnect => {}
        }
    }

    fn may_publish(&self) -> bool {
        self.room.as_ref().is_some_and(|room| room.local_participant().permission().is_none_or(|p| p.can_publish))
    }

    fn local_identity(&self) -> String {
        self.room.as_ref().map(|room| room.local_participant().identity().to_string()).unwrap_or_default()
    }

    fn slot(&mut self, source: Source) -> &mut Option<(Capture, Option<LocalVideoTrack>)> {
        match source {
            Source::Camera => &mut self.camera,
            Source::Screen => &mut self.screen,
        }
    }

    /// The SFU unpublished this side's camera or screen: the capture stops.
    fn lost(&mut self, source: Source, sid: &TrackSid) {
        let ours = self.slot(source).as_ref().is_some_and(|(_, track)| track.as_ref().is_some_and(|t| &t.sid() == sid));
        if ours {
            *self.slot(source) = None;
            if source == Source::Screen {
                // Its sound goes too: the takeover revoked both sources.
                self.screen_audio = None;
            }
            error(if source == Source::Screen { "screen_ended" } else { "camera_ended" });
        }
    }

    /// Stops the capture and takes its track out of the room.
    async fn stop_video(&mut self, source: Source) {
        if source == Source::Screen {
            self.stop_screen_audio().await;
        }
        let Some((capture, track)) = self.slot(source).take() else { return };
        drop(capture);
        if let (Some(room), Some(track)) = (&self.room, track) {
            let _ = room.local_participant().unpublish_track(&track.sid()).await;
        }
        self.publish_participants();
    }

    async fn stop_screen_audio(&mut self) {
        let Some((capture, track)) = self.screen_audio.take() else { return };
        drop(capture);
        if let (Some(room), Some(track)) = (&self.room, track) {
            let _ = room.local_participant().unpublish_track(&track.sid()).await;
        }
    }

    /// The screen's sound beside a published screen, where the platform captures it.
    async fn start_screen_audio(&mut self) {
        let Some(room) = self.room.clone() else { return };
        if self.screen_audio.is_some() {
            return;
        }
        let Some(capture) = screen_audio::start(self.fake_video, self.with_call) else { return };
        let track = LocalAudioTrack::create_audio_track("screen-audio", RtcAudioSource::Native(capture.source.clone()));
        let options = TrackPublishOptions {
            source: TrackSource::ScreenshareAudio,
            audio_encoding: Some(livekit::options::AudioEncoding { max_bitrate: 96_000 }),
            dtx: false,
            red: false,
            ..Default::default()
        };
        match room.local_participant().publish_track(LocalTrack::Audio(track.clone()), options).await {
            Ok(_) => self.screen_audio = Some((capture, Some(track))),
            Err(_) => eprintln!("rv-voice: screen audio not published"),
        }
    }

    /// A capture thread's news: the first frames publish its track, a failure ends it.
    async fn capture(&mut self, news: Internal) {
        let (source, kind, name) = match news {
            Internal::Failed(source, code) => {
                if self.slot(source).is_some() {
                    self.stop_video(source).await;
                    error(code);
                }
                return;
            }
            Internal::CameraReady => (Source::Camera, TrackSource::Camera, "camera"),
            Internal::ScreenReady => (Source::Screen, TrackSource::Screenshare, "screen"),
        };
        let Some(room) = self.room.clone() else { return };
        let Some((capture, track)) = self.slot(source) else { return };
        if track.is_some() {
            return;
        }
        let local = LocalVideoTrack::create_video_track(name, RtcVideoSource::Native(capture.source.clone()));
        // A screen is text: crisp frames over fluid motion, one layer.
        let options = TrackPublishOptions { source: kind, simulcast: source == Source::Camera, ..Default::default() };
        match room.local_participant().publish_track(LocalTrack::Video(local.clone()), options).await {
            Ok(_) => {
                if let Some((_, track)) = self.slot(source) {
                    *track = Some(local);
                }
                if source == Source::Screen {
                    self.start_screen_audio().await;
                }
            }
            Err(_) => {
                self.stop_video(source).await;
                error(if source == Source::Camera { "camera_unavailable" } else { "screen_unavailable" });
            }
        }
        self.publish_participants();
    }

    fn list_devices(&self) {
        if self.fake {
            return emit(Event::Devices { inputs: vec![], outputs: vec![] });
        }
        // Outside a session, a short-lived handle: the devices are listed, not opened.
        let audio = match &self.audio {
            Some(audio) => audio.clone(),
            None => match PlatformAudio::new() {
                Ok(audio) => audio,
                Err(_) => {
                    error("audio_unavailable");
                    return emit(Event::Devices { inputs: vec![], outputs: vec![] });
                }
            },
        };
        let inputs = audio
            .recording_devices()
            .map(|d| Device { id: device_id(d.id.as_str(), &d.name), name: d.name, default: d.index == 0 })
            .collect();
        let outputs = audio
            .playout_devices()
            .map(|d| Device { id: device_id(d.id.as_str(), &d.name), name: d.name, default: d.index == 0 })
            .collect();
        emit(Event::Devices { inputs, outputs });
    }

    async fn start_audio(&mut self) {
        let Some(room) = self.room.clone() else { return };
        let source = if self.fake {
            let source = NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 1, 100);
            tokio::spawn(sine(source.clone()));
            RtcAudioSource::Native(source)
        } else {
            match self.audio.clone().map_or_else(PlatformAudio::new, Ok) {
                Ok(audio) => {
                    for (device, input) in [(&self.input, true), (&self.output, false)] {
                        if let Some(device) = device
                            && !select(&audio, device, input)
                        {
                            error("device_not_found");
                        }
                    }
                    let source = audio.rtc_source();
                    self.audio = Some(audio);
                    source
                }
                Err(_) => return error("audio_unavailable"),
            }
        };
        // A plain member of a read-only room listens only.
        if room.local_participant().permission().is_some_and(|p| !p.can_publish) {
            return;
        }
        let track = LocalAudioTrack::create_audio_track("microphone", source);
        let options =
            TrackPublishOptions { source: TrackSource::Microphone, dtx: true, red: true, ..Default::default() };
        match room.local_participant().publish_track(LocalTrack::Audio(track.clone()), options).await {
            Ok(_) => {
                self.track = Some(track);
                self.apply_microphone();
            }
            Err(_) => error("publish_failed"),
        }
    }

    fn apply_microphone(&self) {
        let Some(track) = &self.track else { return };
        if self.microphone {
            track.unmute();
        } else {
            track.mute();
        }
        // Silent without telling the room while the echo canceller settles.
        if self.microphone && self.settle.is_some() {
            track.disable();
        } else {
            track.enable();
        }
    }

    fn apply_deafened(&self) {
        let Some(room) = &self.room else { return };
        for participant in room.remote_participants().values() {
            for publication in participant.track_publications().values() {
                if let Some(RemoteTrack::Audio(track)) = publication.track() {
                    // A disabled remote track is still received, just not played.
                    if self.deafened { track.disable() } else { track.enable() }
                }
            }
        }
    }

    async fn room_event(&mut self, event: RoomEvent) {
        match event {
            RoomEvent::ConnectionStateChanged(ConnectionState::Connected) | RoomEvent::Reconnected => {
                emit(Event::State { state: State::Connected })
            }
            RoomEvent::ConnectionStateChanged(ConnectionState::Reconnecting) | RoomEvent::Reconnecting => {
                emit(Event::State { state: State::Reconnecting })
            }
            RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(track), .. } if self.deafened => track.disable(),
            RoomEvent::TrackSubscribed { track: RemoteTrack::Video(track), publication, participant } => {
                if let Some(frames) = &self.frames {
                    let source =
                        if publication.source() == TrackSource::Screenshare { Source::Screen } else { Source::Camera };
                    let identity = participant.identity().to_string();
                    // LiveKit sends the lowest simulcast layer until asked: cards
                    // show up to 640 by 480, a screen fills the stage.
                    if publication.simulcasted() {
                        let quality = if source == Source::Screen { VideoQuality::High } else { VideoQuality::Medium };
                        publication.set_video_quality(quality);
                    }
                    let task = tokio::spawn(video::watch(track, source, identity.clone(), frames.clone()));
                    if let Some((old, ..)) = self.watched.insert(publication.sid(), (task, source, identity)) {
                        old.abort();
                    }
                }
            }
            RoomEvent::TrackUnsubscribed { publication, .. } => {
                if let Some((task, source, identity)) = self.watched.remove(&publication.sid()) {
                    task.abort();
                    if let Some(frames) = &self.frames {
                        frames.end(source, &identity);
                    }
                }
            }
            // Taken out by the SFU: someone else's share replaced this one.
            RoomEvent::LocalTrackUnpublished { publication, .. } => match publication.source() {
                TrackSource::Screenshare => self.lost(Source::Screen, &publication.sid()),
                TrackSource::Camera => self.lost(Source::Camera, &publication.sid()),
                _ => self.track = None,
            },
            RoomEvent::ParticipantPermissionChanged { participant: Participant::Local(_), permission } => {
                // The screen source revoked (another share took over): stop
                // capturing, whether or not the SFU unpublished the track yet.
                let sources = permission.as_ref().map(|p| p.can_publish_sources.clone()).unwrap_or_default();
                if !sources.is_empty() && !sources.contains(&SCREEN_SHARE_SOURCE) && self.screen.is_some() {
                    self.stop_video(Source::Screen).await;
                    error("screen_ended");
                }
                if permission.is_some_and(|p| p.can_publish) && self.track.is_none() {
                    self.start_audio().await;
                }
            }
            // Diagnostics only (stderr): a key mismatch silences someone without
            // any other trace. Identities are account ids, never content.
            RoomEvent::E2eeStateChanged { participant, state } => {
                eprintln!("rv-voice: e2ee {} {state:?}", participant.identity());
            }
            _ => {}
        }
        self.publish_participants();
    }

    /// The whole list, sent only when something in it changed.
    fn publish_participants(&mut self) {
        let Some(room) = &self.room else { return };
        let local = room.local_participant();
        let mut participants = vec![Member {
            identity: local.identity().to_string(),
            local: true,
            muted: !self.microphone || self.track.is_none(),
            deafened: self.deafened,
            speaking: local.is_speaking(),
            level: level(local.audio_level()),
            camera: self.camera.as_ref().is_some_and(|(_, track)| track.is_some()),
            screen: self.screen.as_ref().is_some_and(|(_, track)| track.is_some()),
        }];
        let mut remote: Vec<_> = room
            .remote_participants()
            .values()
            .map(|p| Member {
                identity: p.identity().to_string(),
                local: false,
                muted: p
                    .track_publications()
                    .values()
                    .find(|t| t.source() == TrackSource::Microphone)
                    .is_none_or(|t| t.is_muted()),
                deafened: p.attributes().get(DEAFENED_ATTRIBUTE).is_some_and(|v| v == "1"),
                speaking: p.is_speaking(),
                level: level(p.audio_level()),
                camera: p.track_publications().values().any(|t| t.source() == TrackSource::Camera && !t.is_muted()),
                screen: p.track_publications().values().any(|t| t.source() == TrackSource::Screenshare),
            })
            .collect();
        remote.sort_by(|a, b| a.identity.cmp(&b.identity));
        participants.extend(remote);
        // LiveKit keeps the last speaker level of a muted participant.
        for member in participants.iter_mut().filter(|m| m.muted) {
            member.speaking = false;
            member.level = 0.0;
        }
        if self.last.as_ref() != Some(&participants) {
            self.last = Some(participants.clone());
            emit(Event::Participants { participants });
        }
    }
}

fn level(value: f32) -> f32 {
    (value.clamp(0.0, 1.0) * 100.0).round() / 100.0
}

/// PulseAudio reports no device GUID: such a device goes by its name.
fn device_id(guid: &str, name: &str) -> String {
    if guid.is_empty() { name.into() } else { guid.into() }
}

/// Selects a device by the id `list_devices` gave it, the system default when empty.
fn select(audio: &PlatformAudio, id: &str, input: bool) -> bool {
    let found = if input {
        audio
            .recording_devices()
            .find(|d| if id.is_empty() { d.index == 0 } else { device_id(d.id.as_str(), &d.name) == id })
            .map(|d| (d.id.as_str().to_owned(), d.index))
    } else {
        audio
            .playout_devices()
            .find(|d| if id.is_empty() { d.index == 0 } else { device_id(d.id.as_str(), &d.name) == id })
            .map(|d| (d.id.as_str().to_owned(), d.index))
    };
    let Some((guid, index)) = found else { return false };
    if !guid.is_empty() {
        return if input {
            audio.switch_recording_device(&RecordingDeviceId::from_unchecked_guid(&guid)).is_ok()
        } else {
            audio.switch_playout_device(&PlayoutDeviceId::from_unchecked_guid(&guid)).is_ok()
        };
    }
    // Without a GUID, by index, with the same stop/select/restart as a switch.
    let Ok(index) = u16::try_from(index) else { return false };
    let runtime = livekit::rtc_engine::lk_runtime::LkRuntime::instance();
    let factory = runtime.pc_factory();
    if input {
        let running = factory.recording_is_initialized();
        (!running || factory.stop_recording())
            && factory.set_recording_device(index)
            && (!running || factory.init_recording() && factory.start_recording())
    } else {
        let running = factory.playout_is_initialized();
        (!running || factory.stop_playout())
            && factory.set_playout_device(index)
            && (!running || factory.init_playout() && factory.start_playout())
    }
}

/// A 440 Hz tone in 10 ms frames; `capture_frame` paces itself in real time.
async fn sine(source: NativeAudioSource) {
    let step = 2.0 * std::f32::consts::PI * 440.0 / 48_000.0;
    let mut phase = 0f32;
    loop {
        let mut frame = AudioFrame::new(48_000, 1, 480);
        for sample in frame.data.to_mut().iter_mut() {
            *sample = (phase.sin() * 12_000.0) as i16;
            phase = (phase + step) % (2.0 * std::f32::consts::PI);
        }
        if source.capture_frame(&frame).await.is_err() {
            return;
        }
    }
}
