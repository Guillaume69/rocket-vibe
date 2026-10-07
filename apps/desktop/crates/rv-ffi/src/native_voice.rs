//! Voice on a RocketVibe server for the SwiftUI app, over rv-core's voice
//! controller and its `rv-voice` sidecar (the GTK app's engine): who is in each
//! room's session, the session this account is in, rings, devices, listening
//! choices, video frames and what to share. The choices live where the GTK app
//! keeps them (`rv_core::voice_prefs`, the shared config dir).
//!
//! A supervisor follows the session apart from the UI, as GTK's page does: an
//! outgoing ring declined or missed while alone hangs up, and a direct call
//! hangs up 2 s after the other person left. It also tells the listener that
//! the voice state moved (`Event::Voice`), at most ten times a second.
use crate::native::{NativeChat, native_error};
use crate::{Event, Listener, model::RvError, on_tokio, runtime};
use rv_core::native::NativeSession;
use rv_core::native::crypto::enrollment::rooms;
use rv_core::native::security::Guard;
use rv_core::voice::{
    ConnectionState, Ended, PersonVolume, ScreenKind, ScreenQuality, Snapshot, VideoSource, VoiceKeys, thumbnail,
};
use rv_core::voice_prefs::VoicePrefs;
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

/// A direct call's other person gone: hang up after this grace (a reconnection, a device switch).
const DIRECT_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum VoicePhase {
    Idle,
    Connecting,
    Connected,
    Reconnecting,
}

/// Someone in a room's voice session.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct VoiceMember {
    pub id: String,
    pub name: String,
    pub local: bool,
    pub muted: bool,
    pub deafened: bool,
    /// Lit while they speak; only known in the session this account is in.
    pub speaking: bool,
    pub camera: bool,
    pub screen: bool,
    /// Muted for this side only.
    pub muted_here: bool,
    /// Their photo (`rv-avatar:<file id>`), for the media store; None: initials.
    pub avatar: Option<String>,
}

/// The session this account is in, as the sidecar reports it.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct VoiceState {
    pub room: Option<String>,
    pub phase: VoicePhase,
    pub can_publish: bool,
    pub encrypted: bool,
    pub microphone: bool,
    pub deafened: bool,
    pub camera: bool,
    pub sharing: bool,
    pub members: Vec<VoiceMember>,
    /// Why the last session ended when the user did not end it: `moved`,
    /// `removed`, `lost`; `left` when they did.
    pub ended: Option<String>,
    /// The last failure the sidecar reported (`camera_unavailable`...).
    pub error: Option<String>,
}

/// A direct call ringing or just resolved.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct VoiceCall {
    pub id: String,
    pub room: String,
    pub caller_id: String,
    pub caller_name: String,
    pub callee_id: String,
    /// `ringing`, `answered`, `declined`, `missed`, `cancelled`.
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct VoiceDevice {
    pub id: String,
    pub name: String,
}

/// Microphones and speakers, the system default first (an empty id), two of
/// one name told apart; and the ones chosen.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct VoiceDevices {
    pub inputs: Vec<VoiceDevice>,
    pub outputs: Vec<VoiceDevice>,
    pub input: String,
    pub output: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct VoiceListening {
    pub input_volume: f32,
    pub output_volume: f32,
    pub noise_suppression: bool,
    /// A screen's sound carries the call's voices too.
    pub share_call: bool,
    pub share_height: u32,
    pub share_fps: u32,
}

/// A screen or a window that can be shared.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct VoiceSource {
    pub id: String,
    /// A window; else a screen.
    pub window: bool,
    pub title: String,
}

/// A video frame, RGBA rows packed, or `None` while the same one shows.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct VoiceFrame {
    pub width: u32,
    pub height: u32,
    pub serial: u64,
    pub rgba: Vec<u8>,
}

fn display(display_name: &str, username: &str) -> String {
    if display_name.is_empty() { username } else { display_name }.to_owned()
}

fn ring_state(state: impl serde::Serialize) -> String {
    serde_json::to_value(state).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

fn prefs(chat: &NativeChat) -> VoicePrefs {
    VoicePrefs::new(chat.dirs.config.clone())
}

/// An encrypted room's voice keys, from this installation's crypto vault: the
/// room's access opens at the first ask and stays while the session asks again.
fn voice_keys(chat: &NativeChat, room: &str) -> VoiceKeys {
    let (session, room) = (Arc::downgrade(&chat.session), room.to_owned());
    let path = chat.dirs.data.join("native-crypto");
    let cached: Arc<tokio::sync::Mutex<Option<rooms::Access>>> = Arc::default();
    Arc::new(move || {
        let (session, room, path, cached) = (session.clone(), room.clone(), path.clone(), cached.clone());
        Box::pin(async move {
            let mut cached = cached.lock().await;
            if cached.is_none() {
                let session = session.upgrade()?;
                let settings = session
                    .crypto_settings(Guard::new(), path, Arc::new(rv_crypto::protected::system::Keyring))
                    .await
                    .ok()?;
                *cached = Some(settings.room(room).await.ok()?);
            }
            match cached.as_ref()?.voice_key().await {
                Ok(key) => key,
                Err(_) => {
                    if let Some(access) = cached.take() {
                        access.close();
                    }
                    None
                }
            }
        })
    })
}

fn members(session: &NativeSession, room: &str, snapshot: &Snapshot) -> Vec<VoiceMember> {
    let live = session.voice_participants(room);
    let me = &session.info.user_id;
    let listening = session.voice().listening();
    let muted_here = |uid: &str| listening.people.get(uid).is_some_and(|p| p.muted);
    let avatar = |uid: &str| {
        session
            .store
            .profile_identity(uid)
            .ok()
            .flatten()
            .and_then(|p| p.avatar_file_id)
            .map(|id| format!("rv-avatar:{id}"))
    };
    if snapshot.room.as_deref() == Some(room) && !snapshot.participants.is_empty() {
        return snapshot
            .participants
            .iter()
            .map(|p| {
                let name = live
                    .iter()
                    .find(|o| o.user.id == p.identity)
                    .map(|o| display(&o.user.display_name, &o.user.username))
                    .or_else(|| {
                        session
                            .store
                            .profile_identity(&p.identity)
                            .ok()
                            .flatten()
                            .map(|s| display(&s.user.display_name, &s.user.username))
                    })
                    .unwrap_or_else(|| if p.local { session.info.username.clone() } else { String::new() });
                VoiceMember {
                    name,
                    local: p.local || &p.identity == me,
                    muted: p.muted,
                    deafened: p.deafened,
                    speaking: p.speaking,
                    camera: p.camera,
                    screen: p.screen,
                    muted_here: muted_here(&p.identity),
                    avatar: avatar(&p.identity),
                    id: p.identity.clone(),
                }
            })
            .collect();
    }
    live.into_iter()
        .map(|o| VoiceMember {
            name: display(&o.user.display_name, &o.user.username),
            local: &o.user.id == me,
            muted_here: muted_here(&o.user.id),
            avatar: avatar(&o.user.id),
            speaking: false,
            id: o.user.id,
            muted: o.muted,
            deafened: o.deafened,
            camera: o.camera,
            screen: o.screen,
        })
        .collect()
}

fn frame(session: &NativeSession, identity: &str, source: VideoSource, since: u64) -> Option<VoiceFrame> {
    let frame = session.voice().frame(identity, source)?;
    Some(VoiceFrame {
        width: frame.width,
        height: frame.height,
        serial: frame.serial,
        rgba: if frame.serial == since { vec![] } else { frame.pixels.to_vec() },
    })
}

#[uniffi::export]
impl NativeChat {
    /// The server offers voice and this installation carries the sidecar.
    pub fn voice_supported(&self) -> bool {
        self.session.voice_supported()
    }
    pub fn voice_state(&self) -> VoiceState {
        let s = self.session.voice().snapshot();
        VoiceState {
            phase: match (&s.room, s.state) {
                (None, _) => VoicePhase::Idle,
                (Some(_), ConnectionState::Connected) => VoicePhase::Connected,
                (Some(_), ConnectionState::Reconnecting) => VoicePhase::Reconnecting,
                (Some(_), _) => VoicePhase::Connecting,
            },
            members: s.room.as_deref().map(|room| members(&self.session, room, &s)).unwrap_or_default(),
            ended: s.ended.as_ref().map(|e| {
                match e {
                    Ended::Left => "left",
                    Ended::MovedElsewhere => "moved",
                    Ended::Removed(_) => "removed",
                    // A sidecar that never started is told by the join's own failure.
                    Ended::Failed(code) if code.starts_with("voice_") => "left",
                    Ended::Failed(_) => "lost",
                }
                .to_owned()
            }),
            room: s.room.clone(),
            can_publish: s.can_publish,
            encrypted: s.encrypted,
            microphone: s.microphone,
            deafened: s.deafened,
            camera: s.camera,
            sharing: s.sharing,
            error: s.error.clone(),
        }
    }
    /// Who is in a room's voice session: the server's 2 s snapshot, or the
    /// session's own view (who speaks) for the room this account is in.
    pub fn voice_members(&self, room: String) -> Vec<VoiceMember> {
        members(&self.session, &room, &self.session.voice().snapshot())
    }
    pub fn voice_calls(&self) -> Vec<VoiceCall> {
        self.session
            .rings()
            .into_iter()
            .map(|r| VoiceCall {
                state: ring_state(r.state),
                caller_name: display(&r.caller.display_name, &r.caller.username),
                id: r.id,
                room: r.room_id,
                caller_id: r.caller.id,
                callee_id: r.callee.id,
            })
            .collect()
    }
    /// Joins a room's session (`ring` calls the other member of a direct room),
    /// leaving any other one. A refusal's code: `voice_encrypted_room`,
    /// `voice_key_unavailable`, `voice_unavailable`...
    pub async fn join_voice(&self, room: String, ring: bool) -> Result<(), RvError> {
        let (session, keys) = (self.session.clone(), voice_keys(self, &room));
        on_tokio(async move { session.connect_voice(&room, ring, Some(keys)).await }).await.map_err(native_error)
    }
    pub async fn answer_call(&self, id: String, room: String) -> Result<(), RvError> {
        let (session, keys) = (self.session.clone(), voice_keys(self, &room));
        on_tokio(async move { session.answer_ring(&id, &room, Some(keys)).await }).await.map_err(native_error)
    }
    pub async fn decline_call(&self, id: String) -> Result<(), RvError> {
        let session = self.session.clone();
        on_tokio(async move { session.decline_ring(&id).await }).await.map_err(native_error)
    }
    pub async fn leave_voice_session(&self) {
        let session = self.session.clone();
        on_tokio(async move { session.disconnect_voice().await }).await
    }
    pub async fn set_voice_microphone(&self, enabled: bool) {
        let session = self.session.clone();
        on_tokio(async move { session.voice().set_microphone(enabled).await }).await
    }
    pub async fn set_voice_deafened(&self, deafened: bool) {
        let session = self.session.clone();
        on_tokio(async move { session.voice().set_deafened(deafened).await }).await
    }
    pub async fn set_voice_camera(&self, enabled: bool) {
        let session = self.session.clone();
        on_tokio(async move { session.voice().set_camera(enabled).await }).await
    }
    /// Shares a screen or a window (`source` from `voice_sources`; None: the
    /// first screen, or the system's picker), at the quality chosen, kept for
    /// the next share. Refused with `screen_taken` while someone else's share
    /// cannot be taken over.
    pub async fn share_screen(&self, source: Option<String>, height: u32, fps: u32) -> Result<(), RvError> {
        let quality = ScreenQuality { height, fps }.clamped();
        prefs(self).set_share_quality(quality);
        let session = self.session.clone();
        on_tokio(async move { session.share_screen(source, Some(quality)).await }).await.map_err(native_error)
    }
    pub async fn stop_screen_share(&self) {
        let session = self.session.clone();
        on_tokio(async move { session.stop_screen_share().await }).await
    }
    /// What can be shared, screens first; empty where the system picks.
    /// Their thumbnails then come through `voice_thumbnail`.
    pub async fn voice_sources(&self) -> Result<Vec<VoiceSource>, RvError> {
        let session = self.session.clone();
        let sources = on_tokio(async move { session.voice().screens().await })
            .await
            .map_err(|e| RvError::Local { message: e.code().into() })?;
        Ok(sources
            .into_iter()
            .map(|s| VoiceSource { window: s.kind == ScreenKind::Window, id: s.id, title: s.title })
            .collect())
    }
    /// Someone's camera or screen (`screen`), this side's own included; the
    /// pixels only when the frame changed since `since`.
    pub fn voice_frame(&self, identity: String, screen: bool, since: u64) -> Option<VoiceFrame> {
        frame(&self.session, &identity, if screen { VideoSource::Screen } else { VideoSource::Camera }, since)
    }
    pub fn voice_thumbnail(&self, source: String, since: u64) -> Option<VoiceFrame> {
        frame(&self.session, &thumbnail(&source), VideoSource::Screen, since)
    }
    /// The microphone's level after processing, 0 to 1.
    pub fn voice_input_level(&self) -> f32 {
        self.session.voice().input_level()
    }
    pub async fn voice_devices(&self) -> Result<VoiceDevices, RvError> {
        let session = self.session.clone();
        let (inputs, outputs) = on_tokio(async move { session.voice().devices().await })
            .await
            .map_err(|e| RvError::Local { message: e.code().into() })?;
        let (input, output) = self.session.voice().selected_devices();
        let prefs = prefs(self);
        let named = |devices: Vec<rv_core::voice::Device>| {
            let mut out =
                vec![VoiceDevice { id: String::new(), name: rv_core::i18n::t("voice_settings.default").into() }];
            for (index, device) in devices.iter().enumerate() {
                let before = devices[..index].iter().filter(|d| d.name == device.name).count();
                let name = if before == 0 { device.name.clone() } else { format!("{} ({})", device.name, before + 1) };
                out.push(VoiceDevice { id: device.id.clone(), name });
            }
            out
        };
        Ok(VoiceDevices {
            inputs: named(inputs),
            outputs: named(outputs),
            input: input.or_else(|| prefs.device(true)).unwrap_or_default(),
            output: output.or_else(|| prefs.device(false)).unwrap_or_default(),
        })
    }
    /// A device id from `voice_devices`, empty for the default; kept for later runs.
    pub async fn select_voice_device(&self, input: bool, id: String) {
        prefs(self).set_device(input, &id);
        let session = self.session.clone();
        on_tokio(async move {
            if input { session.voice().select_input(&id).await } else { session.voice().select_output(&id).await }
        })
        .await
    }
    pub fn voice_listening(&self) -> VoiceListening {
        let (listening, prefs) = (self.session.voice().listening(), prefs(self));
        let quality = prefs.share_quality();
        VoiceListening {
            input_volume: listening.input_volume,
            output_volume: listening.output_volume,
            noise_suppression: listening.noise_suppression,
            share_call: self.session.voice().share_call(),
            share_height: quality.height,
            share_fps: quality.fps,
        }
    }
    pub async fn set_voice_input_volume(&self, volume: f32) {
        let session = self.session.clone();
        on_tokio(async move { session.voice().set_input_volume(volume).await }).await;
        prefs(self).save_listening(self.session.voice());
    }
    pub async fn set_voice_output_volume(&self, volume: f32) {
        let session = self.session.clone();
        on_tokio(async move { session.voice().set_output_volume(volume).await }).await;
        prefs(self).save_listening(self.session.voice());
    }
    pub async fn set_voice_noise_suppression(&self, enabled: bool) {
        let session = self.session.clone();
        on_tokio(async move { session.voice().set_noise_suppression(enabled).await }).await;
        prefs(self).save_listening(self.session.voice());
    }
    pub fn set_voice_share_call(&self, on: bool) {
        prefs(self).set_share_call(on);
        self.session.voice().set_share_call(on);
    }
    /// How loud someone plays here (0 to 2) and whether they are muted for this side only.
    pub fn person_volume(&self, uid: String) -> f32 {
        self.session.voice().listening().people.get(&uid).map_or(1.0, |p| p.volume)
    }
    pub async fn set_person_volume(&self, uid: String, volume: f32, muted: bool) {
        let session = self.session.clone();
        on_tokio(async move { session.voice().set_person_volume(&uid, PersonVolume { volume, muted }).await }).await;
        prefs(self).save_listening(self.session.voice());
    }
    pub async fn create_voice_room(&self, name: String, private: bool, voice: bool) -> Result<String, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.create_room(&name, private, voice).await }).await.map_err(RvError::local)
    }
}

impl NativeChat {
    /// The saved voice choices, handed to the session's controller once.
    pub(crate) fn apply_voice_prefs(&self) {
        let (session, prefs) = (self.session.clone(), prefs(self));
        session.voice().set_share_call(prefs.share_call());
        if let Some(listening) = prefs.listening() {
            session.voice().restore_listening(listening);
        }
        runtime().spawn(async move { prefs.apply(session.voice()).await });
    }

    /// The supervisor (see the module's doc); replaced with the listener.
    pub(crate) fn supervise_voice(&self, listener: Arc<dyn Listener>) -> tokio::task::JoinHandle<()> {
        let session = Arc::downgrade(&self.session);
        runtime().spawn(supervise(session, listener))
    }
}

async fn supervise(session: Weak<NativeSession>, listener: Arc<dyn Listener>) {
    let Some(mut changes) = session.upgrade().map(|s| s.voice().changes()) else { return };
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let (mut rings, mut company, mut alone): (HashMap<String, String>, Option<String>, Option<Instant>) =
        (HashMap::new(), None, None);
    let mut last = None;
    loop {
        tokio::select! {
            change = changes.recv() => {
                if matches!(change, Err(tokio::sync::broadcast::error::RecvError::Closed)) {
                    return;
                }
                // Who speaks moves often: one notice per 100 ms is enough.
                tokio::time::sleep(Duration::from_millis(100)).await;
                while changes.try_recv().is_ok() {}
            }
            _ = tick.tick() => {}
        }
        let Some(s) = session.upgrade() else { return };
        let snapshot = s.voice().snapshot();
        let me = s.info.user_id.clone();
        let alone_now = !snapshot.participants.iter().any(|p| !p.local);
        // An outgoing ring nobody answered, while alone in its call: hang up.
        let mut hang_up = false;
        for ring in s.rings() {
            let state = ring_state(ring.state);
            let before = rings.insert(ring.id.clone(), state.clone());
            if before.as_deref() == Some("ringing")
                && matches!(state.as_str(), "declined" | "missed")
                && ring.caller.id == me
                && snapshot.room.as_deref() == Some(&ring.room_id)
                && alone_now
            {
                hang_up = true;
            }
        }
        // A direct call: the other person gone for the grace, hang up too.
        let direct = snapshot.room.as_deref().is_some_and(|room| {
            s.store
                .rooms()
                .is_ok_and(|rooms| rooms.iter().any(|r| r.id == room && r.kind == rv_core::native::RoomKind::Direct))
        });
        if !direct || snapshot.state != ConnectionState::Connected {
            if snapshot.room.is_none() {
                (company, alone) = (None, None);
            }
        } else if !alone_now {
            (company, alone) = (snapshot.room.clone(), None);
        } else if company == snapshot.room {
            let since = *alone.get_or_insert_with(Instant::now);
            if since.elapsed() >= DIRECT_GRACE {
                hang_up = true;
                (company, alone) = (None, None);
            }
        }
        if hang_up {
            s.disconnect_voice().await;
        }
        let shown = Some((snapshot.clone(), s.voice().listening(), rings.clone()));
        if shown != last {
            last = shown;
            listener.on_event(Event::Voice);
        }
    }
}
