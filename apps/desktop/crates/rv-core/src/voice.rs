//! Voice media runs in the `rv-voice` sidecar, the only binary that links
//! libwebrtc, driven over JSON lines (`rv-voice-protocol`). One process per
//! connection: `connect` spawns it, it exits once disconnected, and it dies with
//! the controller (`kill_on_drop`). The UI observes a [`Snapshot`] and payload-less
//! change notifications, like the native store. Video frames arrive apart, on a
//! loopback TCP stream the controller listens on for each sidecar
//! (`rv_voice_protocol::frames`); the UI reads the latest one per track with
//! [`VoiceController::frame`].
use rv_protocol::voice::VoiceGrant;
use rv_voice_protocol::frames;
pub use rv_voice_protocol::frames::Source as VideoSource;
use rv_voice_protocol::{Command, Event, VERSION};
pub use rv_voice_protocol::{ConnectionState, Device, Participant, ScreenKind, ScreenQuality, ScreenSource, thumbnail};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{broadcast, oneshot};

/// Microphones, then speakers.
pub type Devices = (Vec<Device>, Vec<Device>);

const BINARY: &str = if cfg!(windows) { "rv-voice.exe" } else { "rv-voice" };
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// How often an encrypted session checks its room's group for a new epoch.
const KEY_REFRESH: Duration = Duration::from_secs(15);

/// An encrypted room's voice key (docs/protocol/VOICE.md): exported from its
/// MLS group at `epoch`, as standard base64, whose ASCII bytes LiveKit takes.
#[derive(Clone, PartialEq, Eq)]
pub struct VoiceKey {
    pub epoch: u64,
    pub key: zeroize::Zeroizing<String>,
}
impl VoiceKey {
    pub fn new(epoch: u64, secret: &[u8]) -> Self {
        use base64::Engine;
        Self { epoch, key: zeroize::Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(secret)) }
    }
}
impl std::fmt::Debug for VoiceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VoiceKey").field("epoch", &self.epoch).finish_non_exhaustive()
    }
}
/// Where an encrypted room's voice key comes from: the app's crypto access,
/// asked again while the session lasts. `None` when this device cannot derive
/// the current one (not welcomed, a group change not accepted yet).
pub type VoiceKeys = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Option<VoiceKey>> + Send>> + Send + Sync>;
const EXIT_TIMEOUT: Duration = Duration::from_secs(4);
/// The sidecar connects its frame stream right after starting.
const VIDEO_TIMEOUT: Duration = Duration::from_secs(30);

/// A frame of the room's video, or of this side's own preview: RGBA, rows packed.
#[derive(Clone, PartialEq)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Arc<[u8]>,
    /// Grows with every frame of the session: a view redraws when it moved.
    pub serial: u64,
}
impl std::fmt::Debug for VideoFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "VideoFrame({}x{} #{})", self.width, self.height, self.serial)
    }
}

/// The latest frame of each track of one session.
#[derive(Default)]
struct Video {
    generation: u64,
    frames: HashMap<(VideoSource, String), VideoFrame>,
    serial: u64,
}

/// `RV_VOICE_BIN`, else `rv-voice` next to the running executable, else in the
/// AppImage's `bin`: sharun runs the app through its bundled loader, so the
/// current executable is that loader, and names the root in `SHARUN_DIR`.
pub fn locate() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("RV_VOICE_BIN") {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    let beside = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join(BINARY)));
    let bundled = ["SHARUN_DIR", "APPDIR"]
        .into_iter()
        .filter_map(std::env::var_os)
        .filter(|root| !root.is_empty())
        .map(|root| PathBuf::from(root).join("bin").join(BINARY));
    beside.into_iter().chain(bundled).find(|path| path.is_file())
}

/// This installation can carry voice: the sidecar ships with it.
pub fn available() -> bool {
    locate().is_some()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum VoiceError {
    #[error("voice_unavailable")]
    Unavailable,
    #[error("voice_sidecar_failed")]
    Spawn,
    #[error("voice_sidecar_incompatible")]
    Incompatible,
    #[error("voice_sidecar_exited")]
    Exited,
    #[error("voice_timeout")]
    Timeout,
    /// An encrypted room's grant without its key: never connected in clear.
    #[error("voice_key_unavailable")]
    Unencrypted,
}
impl VoiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unavailable => "voice_unavailable",
            Self::Spawn => "voice_sidecar_failed",
            Self::Incompatible => "voice_sidecar_incompatible",
            Self::Exited => "voice_sidecar_exited",
            Self::Timeout => "voice_timeout",
            Self::Unencrypted => "voice_key_unavailable",
        }
    }
}

/// Why the last connection ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    /// This app left.
    Left,
    /// The account joined voice on another device, which took this place
    /// (LiveKit `duplicate_identity`): "moved to another device".
    MovedElsewhere,
    /// The server removed this account: membership withdrawn, another room
    /// joined, room deleted (the LiveKit reason).
    Removed(String),
    /// A failure: `connect_failed`, `sidecar_exited`, `signal_close`...
    Failed(String),
}
impl Ended {
    pub fn from_reason(reason: &str) -> Self {
        match reason {
            "client_initiated" => Self::Left,
            "duplicate_identity" => Self::MovedElsewhere,
            "participant_removed" | "room_deleted" | "room_closed" => Self::Removed(reason.into()),
            other => Self::Failed(other.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// The native room whose session this is; None when not connected.
    pub room: Option<String>,
    pub state: ConnectionState,
    /// Everyone connected, this account included (`local`), as LiveKit sees them.
    pub participants: Vec<Participant>,
    /// False in a read-only room for a plain member: listening only.
    pub can_publish: bool,
    /// Frames are end-to-end encrypted with the room's group key.
    pub encrypted: bool,
    /// The user's choices; they carry over to the next connection.
    pub microphone: bool,
    pub deafened: bool,
    /// This side's camera and screen share, as asked: off at each connection,
    /// and again when the sidecar reports it could not keep them.
    pub camera: bool,
    pub sharing: bool,
    pub ended: Option<Ended>,
    /// The last command failure the sidecar reported (`device_not_found`...).
    pub error: Option<String>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            room: None,
            state: ConnectionState::Disconnected,
            participants: vec![],
            can_publish: false,
            encrypted: false,
            microphone: true,
            deafened: false,
            camera: false,
            sharing: false,
            ended: None,
            error: None,
        }
    }
}
impl Snapshot {
    pub fn local(&self) -> Option<&Participant> {
        self.participants.iter().find(|p| p.local)
    }
    pub fn moved_elsewhere(&self) -> bool {
        self.ended == Some(Ended::MovedElsewhere)
    }
    fn end(&mut self, ended: Ended) {
        self.room = None;
        self.state = ConnectionState::Disconnected;
        self.participants.clear();
        self.camera = false;
        self.sharing = false;
        self.ended = Some(ended);
    }
}

struct Shared {
    snapshot: Snapshot,
    input: Option<String>,
    output: Option<String>,
    /// A screen's sound carries this call's voices too (off: the apps' sound only).
    share_call: bool,
    /// Who waits for the sidecar's lists, by sidecar generation (several may ask at once).
    devices: Vec<(u64, oneshot::Sender<Devices>)>,
    screens: Vec<(u64, oneshot::Sender<Vec<ScreenSource>>)>,
    /// This side's listening choices, sent to each sidecar as it starts.
    listening: Listening,
}

/// How this side hears the call and is heard: each person's volume (and a
/// mute for this side only), the microphone's and the speakers' volumes, the
/// noise remover. 1.0 is as sent.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Listening {
    pub people: HashMap<String, PersonVolume>,
    pub input_volume: f32,
    pub output_volume: f32,
    pub noise_suppression: bool,
}
impl Default for Listening {
    fn default() -> Self {
        Self { people: HashMap::new(), input_volume: 1.0, output_volume: 1.0, noise_suppression: true }
    }
}
impl Listening {
    fn commands(&self) -> Vec<Command> {
        let mut commands: Vec<Command> = self
            .people
            .iter()
            .map(|(identity, p)| Command::SetParticipantVolume {
                identity: identity.clone(),
                volume: p.volume,
                muted: p.muted,
            })
            .collect();
        commands.push(Command::SetInputVolume { volume: self.input_volume });
        commands.push(Command::SetOutputVolume { volume: self.output_volume });
        commands.push(Command::SetNoiseSuppression { enabled: self.noise_suppression });
        commands
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct PersonVolume {
    pub volume: f32,
    pub muted: bool,
}
impl Default for PersonVolume {
    fn default() -> Self {
        Self { volume: 1.0, muted: false }
    }
}

struct Sidecar {
    generation: u64,
    child: Child,
    stdin: ChildStdin,
}

struct Inner {
    program: Option<PathBuf>,
    args: Vec<String>,
    shared: Mutex<Shared>,
    changes: broadcast::Sender<()>,
    process: tokio::sync::Mutex<Option<Sidecar>>,
    generation: AtomicU64,
    key_refresh: Duration,
    video: Mutex<Video>,
    /// The microphone's level (`f32` bits), apart from the snapshot: it moves
    /// ten times a second and only a meter reads it.
    input_level: AtomicU32,
}

#[derive(Clone)]
pub struct VoiceController {
    inner: Arc<Inner>,
}
impl Default for VoiceController {
    fn default() -> Self {
        Self::new()
    }
}
impl VoiceController {
    /// Spawns the sidecar `locate` finds at each connection.
    pub fn new() -> Self {
        Self::build(None, vec![])
    }
    /// A given sidecar program and arguments (tests).
    pub fn with_sidecar(program: PathBuf, args: Vec<String>) -> Self {
        Self::build(Some(program), args)
    }
    fn build(program: Option<PathBuf>, args: Vec<String>) -> Self {
        let (changes, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(Inner {
                program,
                args,
                shared: Mutex::new(Shared {
                    snapshot: Snapshot::default(),
                    input: None,
                    output: None,
                    share_call: false,
                    devices: vec![],
                    screens: vec![],
                    listening: Listening::default(),
                }),
                changes,
                process: tokio::sync::Mutex::new(None),
                generation: AtomicU64::new(0),
                key_refresh: KEY_REFRESH,
                video: Mutex::default(),
                input_level: AtomicU32::new(0),
            }),
        }
    }
    /// How often an encrypted session asks for its group's key (tests shorten it).
    pub fn with_key_refresh(mut self, every: Duration) -> Self {
        if let Some(inner) = Arc::get_mut(&mut self.inner) {
            inner.key_refresh = every;
        }
        self
    }
    pub fn changes(&self) -> broadcast::Receiver<()> {
        self.inner.changes.subscribe()
    }
    pub fn snapshot(&self) -> Snapshot {
        self.inner.shared.lock().unwrap().snapshot.clone()
    }
    /// The latest frame of someone's camera or screen in the current session
    /// (this side's own included, as a preview), None when it shows nothing.
    pub fn frame(&self, identity: &str, source: VideoSource) -> Option<VideoFrame> {
        let video = self.inner.video.lock().unwrap();
        if video.generation != self.inner.generation.load(Ordering::SeqCst) {
            return None;
        }
        video.frames.get(&(source, identity.to_owned())).cloned()
    }
    /// Replaces any current connection with the grant's room. Returns once the
    /// sidecar took the command; the outcome arrives through the snapshot.
    /// An encrypted grant needs `key`, then follows the group's new keys from `keys`.
    pub async fn connect(
        &self,
        grant: &VoiceGrant,
        key: Option<VoiceKey>,
        keys: Option<VoiceKeys>,
    ) -> Result<(), VoiceError> {
        let key = match (grant.e2ee, key) {
            (true, None) => return Err(VoiceError::Unencrypted),
            (true, key) => key,
            (false, _) => None,
        };
        let mut process = self.inner.process.lock().await;
        // A new generation first: the old sidecar's last words are ignored.
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(old) = process.take() {
            stop(old).await;
        }
        *self.inner.video.lock().unwrap() = Video { generation, ..Video::default() };
        // Frames come back on a loopback port only this sidecar knows the token of.
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.ok();
        let video = listener.and_then(|l| Some((l.local_addr().ok()?.to_string(), l)));
        let token = video_token();
        let commands = self.inner.update(|s| {
            s.snapshot = Snapshot {
                room: Some(grant.room_id.clone()),
                state: ConnectionState::Connecting,
                can_publish: grant.can_publish,
                encrypted: key.is_some(),
                microphone: s.snapshot.microphone,
                deafened: s.snapshot.deafened,
                ..Snapshot::default()
            };
            let mut commands: Vec<_> = video
                .iter()
                .map(|(address, _)| Command::Video { address: address.clone(), token: token.clone() })
                .collect();
            commands.extend(s.listening.commands());
            commands.extend(s.input.iter().map(|d| Command::SetInput { device: d.clone() }));
            commands.extend(s.output.iter().map(|d| Command::SetOutput { device: d.clone() }));
            commands.push(Command::SetMicrophone { enabled: s.snapshot.microphone });
            commands.push(Command::SetDeafened { deafened: s.snapshot.deafened });
            commands.push(Command::Connect {
                url: grant.url.clone(),
                token: grant.token.clone(),
                e2ee_key: key.as_ref().map(|k| k.key.to_string()),
            });
            commands
        });
        let started = async {
            let (child, stdin, lines) = self.inner.spawn().await?;
            let mut sidecar = Sidecar { generation, child, stdin };
            for command in &commands {
                send(&mut sidecar.stdin, command).await?;
            }
            Ok::<_, VoiceError>((sidecar, lines))
        }
        .await;
        match started {
            Ok((sidecar, lines)) => {
                tokio::spawn(read(Arc::downgrade(&self.inner), generation, lines));
                if let Some((_, listener)) = video {
                    tokio::spawn(receive(Arc::downgrade(&self.inner), generation, listener, token));
                }
                *process = Some(sidecar);
                if let (Some(key), Some(keys)) = (key, keys) {
                    let every = self.inner.key_refresh;
                    tokio::spawn(follow(Arc::downgrade(&self.inner), generation, key.epoch, keys, every));
                }
                Ok(())
            }
            Err(error) => {
                self.inner.update(|s| {
                    if self.inner.generation.load(Ordering::SeqCst) == generation {
                        s.snapshot.end(Ended::Failed(error.code().into()));
                    }
                });
                Err(error)
            }
        }
    }
    /// Leaves the room; the snapshot ends at once, the sidecar a little later.
    pub async fn disconnect(&self) {
        let mut process = self.inner.process.lock().await;
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        self.inner.video.lock().unwrap().frames.clear();
        self.inner.input_level.store(0, Ordering::Relaxed);
        self.inner.update(|s| {
            if s.snapshot.room.is_some() {
                s.snapshot.end(Ended::Left);
            }
            s.devices.clear();
            s.screens.clear();
        });
        if let Some(old) = process.take() {
            stop(old).await;
        }
    }
    pub async fn set_microphone(&self, enabled: bool) {
        self.inner.update(|s| s.snapshot.microphone = enabled);
        self.command(Command::SetMicrophone { enabled }).await;
    }
    pub async fn set_deafened(&self, deafened: bool) {
        self.inner.update(|s| s.snapshot.deafened = deafened);
        self.command(Command::SetDeafened { deafened }).await;
    }
    /// The default camera on or off, in the current session only.
    pub async fn set_camera(&self, enabled: bool) {
        if !self.wanted(|s| s.camera = enabled) {
            return;
        }
        self.command(Command::SetCamera { enabled }).await;
    }
    /// Shares a screen or a window (`source` from [`Self::screens`]). The
    /// room's one share must be claimed from the server first:
    /// `NativeSession::share_screen` does both.
    pub async fn start_screen_share(&self, source: Option<String>, quality: Option<ScreenQuality>) {
        if self.wanted(|s| s.sharing = true) {
            let with_call = self.inner.shared.lock().unwrap().share_call;
            self.command(Command::StartScreenShare { with_call, source, quality }).await;
        }
    }
    /// What the session can share: screens, then windows, empty where the
    /// system picks (Wayland). Their thumbnails then come through
    /// [`Self::frame`] under [`thumbnail`]`(id)`, source screen.
    pub async fn screens(&self) -> Result<Vec<ScreenSource>, VoiceError> {
        let mut process = self.inner.process.lock().await;
        let Some(sidecar) = process.as_mut() else { return Err(VoiceError::Unavailable) };
        let (tx, rx) = oneshot::channel();
        self.inner.shared.lock().unwrap().screens.push((sidecar.generation, tx));
        send(&mut sidecar.stdin, &Command::ListScreens).await?;
        drop(process);
        tokio::time::timeout(HELLO_TIMEOUT, rx).await.map_err(|_| VoiceError::Timeout)?.map_err(|_| VoiceError::Exited)
    }
    /// The listening choices, as last set.
    pub fn listening(&self) -> Listening {
        self.inner.shared.lock().unwrap().listening.clone()
    }
    /// Choices kept from an earlier run, before any session (the app's saved file).
    pub fn restore_listening(&self, listening: Listening) {
        self.inner.update(|s| s.listening = listening);
    }
    /// How loud someone plays here, 0.0 to 2.0, and whether they are muted for
    /// this side only. Kept for later connections.
    pub async fn set_person_volume(&self, identity: &str, volume: PersonVolume) {
        let volume = PersonVolume { volume: volume.volume.clamp(0.0, 2.0), ..volume };
        self.inner.update(|s| s.listening.people.insert(identity.into(), volume));
        // Not in the snapshot, yet shown (muted here): the views redraw.
        let _ = self.inner.changes.send(());
        let command =
            Command::SetParticipantVolume { identity: identity.into(), volume: volume.volume, muted: volume.muted };
        self.command(command).await;
    }
    pub async fn set_input_volume(&self, volume: f32) {
        let volume = volume.clamp(0.0, 2.0);
        self.inner.update(|s| s.listening.input_volume = volume);
        self.command(Command::SetInputVolume { volume }).await;
    }
    pub async fn set_output_volume(&self, volume: f32) {
        let volume = volume.clamp(0.0, 2.0);
        self.inner.update(|s| s.listening.output_volume = volume);
        self.command(Command::SetOutputVolume { volume }).await;
    }
    pub async fn set_noise_suppression(&self, enabled: bool) {
        self.inner.update(|s| s.listening.noise_suppression = enabled);
        self.command(Command::SetNoiseSuppression { enabled }).await;
    }
    /// The microphone's level after processing, 0.0 to 1.0; 0.0 outside a session.
    pub fn input_level(&self) -> f32 {
        f32::from_bits(self.inner.input_level.load(Ordering::Relaxed))
    }
    /// Whether a screen's sound carries this call's voices too (for recording
    /// or streaming the whole call; the others then hear themselves). Off by
    /// default; applies to the next share.
    pub fn set_share_call(&self, on: bool) {
        self.inner.shared.lock().unwrap().share_call = on;
    }
    pub fn share_call(&self) -> bool {
        self.inner.shared.lock().unwrap().share_call
    }
    pub async fn stop_screen_share(&self) {
        if self.wanted(|s| s.sharing = false) {
            self.command(Command::StopScreenShare).await;
        }
    }
    /// A video wish applies to a session only.
    fn wanted(&self, change: impl FnOnce(&mut Snapshot)) -> bool {
        self.inner.update(|s| {
            let connected = s.snapshot.room.is_some();
            if connected {
                change(&mut s.snapshot);
                // A new attempt: its failure, even the same as before, is news.
                s.snapshot.error = None;
            }
            connected
        })
    }
    /// A device id from `devices`, empty for the system default; kept for later connections.
    pub async fn select_input(&self, device: &str) {
        self.inner.update(|s| s.input = Some(device.into()));
        self.command(Command::SetInput { device: device.into() }).await;
    }
    pub async fn select_output(&self, device: &str) {
        self.inner.update(|s| s.output = Some(device.into()));
        self.command(Command::SetOutput { device: device.into() }).await;
    }
    /// The selected devices (`None`: never chosen, the system default).
    pub fn selected_devices(&self) -> (Option<String>, Option<String>) {
        let shared = self.inner.shared.lock().unwrap();
        (shared.input.clone(), shared.output.clone())
    }
    /// Microphones and speakers: from the running sidecar, else from a short-lived one.
    pub async fn devices(&self) -> Result<Devices, VoiceError> {
        let mut process = self.inner.process.lock().await;
        // A session that ended took its sidecar with it.
        if process.as_mut().is_some_and(|s| !matches!(s.child.try_wait(), Ok(None))) {
            *process = None;
        }
        if let Some(sidecar) = process.as_mut() {
            let (tx, rx) = oneshot::channel();
            self.inner.shared.lock().unwrap().devices.push((sidecar.generation, tx));
            send(&mut sidecar.stdin, &Command::ListDevices).await?;
            drop(process);
            return tokio::time::timeout(HELLO_TIMEOUT, rx)
                .await
                .map_err(|_| VoiceError::Timeout)?
                .map_err(|_| VoiceError::Exited);
        }
        drop(process);
        let (mut child, mut stdin, mut lines) = self.inner.spawn().await?;
        send(&mut stdin, &Command::ListDevices).await?;
        let found = tokio::time::timeout(HELLO_TIMEOUT, async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(Event::Devices { inputs, outputs }) = serde_json::from_str(&line) {
                    return Ok((inputs, outputs));
                }
            }
            Err(VoiceError::Exited)
        })
        .await
        .map_err(|_| VoiceError::Timeout)?;
        drop(stdin);
        if tokio::time::timeout(EXIT_TIMEOUT, child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
        found
    }
    async fn command(&self, command: Command) {
        command_to(&self.inner, None, command).await;
    }
}

async fn command_to(inner: &Inner, generation: Option<u64>, command: Command) {
    let mut process = inner.process.lock().await;
    if let Some(sidecar) = process.as_mut()
        && generation.is_none_or(|g| g == sidecar.generation)
    {
        // A dead sidecar is reported by its reader; nothing to add here.
        let _ = send(&mut sidecar.stdin, &command).await;
    }
}

/// While the encrypted session `generation` lasts: a member or device added or
/// removed moves the group to a new epoch, whose key replaces the current one.
async fn follow(inner: Weak<Inner>, generation: u64, mut epoch: u64, keys: VoiceKeys, every: Duration) {
    let live = |inner: &Weak<Inner>| inner.upgrade().filter(|i| i.generation.load(Ordering::SeqCst) == generation);
    loop {
        tokio::time::sleep(every).await;
        if live(&inner).is_none() {
            return;
        }
        let Some(next) = keys().await else { continue };
        let Some(current) = live(&inner) else { return };
        if next.epoch != epoch {
            epoch = next.epoch;
            command_to(&current, Some(generation), Command::SetKey { key: next.key.to_string() }).await;
        }
    }
}

impl Inner {
    /// Applies a change and notifies when the snapshot moved.
    fn update<T>(&self, change: impl FnOnce(&mut Shared) -> T) -> T {
        let mut shared = self.shared.lock().unwrap();
        let before = shared.snapshot.clone();
        let result = change(&mut shared);
        let moved = shared.snapshot != before;
        drop(shared);
        if moved {
            let _ = self.changes.send(());
        }
        result
    }
    async fn spawn(&self) -> Result<(Child, ChildStdin, Lines<BufReader<ChildStdout>>), VoiceError> {
        let program = self.program.clone().or_else(locate).ok_or(VoiceError::Unavailable)?;
        let mut command = tokio::process::Command::new(program);
        command.args(&self.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        // A screen's sound leaves out the app's own sounds (cues, ringtone) with the call.
        command.env("RV_VOICE_APP_PID", std::process::id().to_string());
        // The GTK app has no console: without this, Windows opens one for the sidecar.
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn().map_err(|_| VoiceError::Spawn)?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err(VoiceError::Spawn);
        };
        let mut lines = BufReader::new(stdout).lines();
        let hello = tokio::time::timeout(HELLO_TIMEOUT, lines.next_line())
            .await
            .map_err(|_| VoiceError::Timeout)?
            .ok()
            .flatten()
            .ok_or(VoiceError::Exited)?;
        match serde_json::from_str(&hello) {
            Ok(Event::Hello { version: VERSION, .. }) => Ok((child, stdin, lines)),
            _ => Err(VoiceError::Incompatible),
        }
    }
    fn apply(&self, generation: u64, event: Event) {
        self.update(|s| {
            if let Event::Devices { inputs, outputs } = event {
                for (_, tx) in s.devices.extract_if(.., |(owner, _)| *owner == generation) {
                    let _ = tx.send((inputs.clone(), outputs.clone()));
                }
                return;
            }
            if let Event::Screens { screens } = event {
                for (_, tx) in s.screens.extract_if(.., |(owner, _)| *owner == generation) {
                    let _ = tx.send(screens.clone());
                }
                return;
            }
            if let Event::InputLevel { level } = event {
                if self.generation.load(Ordering::SeqCst) == generation {
                    self.input_level.store(level.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
                }
                return;
            }
            if self.generation.load(Ordering::SeqCst) != generation || s.snapshot.room.is_none() {
                return;
            }
            match event {
                Event::State { state } => s.snapshot.state = state,
                Event::Participants { participants } => s.snapshot.participants = participants,
                Event::Disconnected { reason } => s.snapshot.end(Ended::from_reason(&reason)),
                Event::Error { code } => {
                    // The sidecar gave up on a capture: the wish follows.
                    match code.as_str() {
                        "camera_unavailable" | "camera_ended" => s.snapshot.camera = false,
                        "screen_unavailable" | "screen_cancelled" | "screen_ended" => s.snapshot.sharing = false,
                        _ => {}
                    }
                    s.snapshot.error = Some(code);
                }
                Event::Hello { .. } | Event::Devices { .. } | Event::Screens { .. } | Event::InputLevel { .. } => {}
            }
        });
    }
    fn exited(&self, generation: u64) {
        self.update(|s| {
            s.devices.retain(|(owner, _)| *owner != generation);
            s.screens.retain(|(owner, _)| *owner != generation);
            if self.generation.load(Ordering::SeqCst) == generation && s.snapshot.room.is_some() {
                s.snapshot.end(Ended::Failed("sidecar_exited".into()));
            }
        });
    }
}

async fn read(inner: Weak<Inner>, generation: u64, mut lines: Lines<BufReader<ChildStdout>>) {
    loop {
        let line = lines.next_line().await;
        let Some(inner) = inner.upgrade() else { return };
        match line {
            Ok(Some(line)) => {
                if let Ok(event) = serde_json::from_str(&line) {
                    inner.apply(generation, event);
                }
            }
            _ => return inner.exited(generation),
        }
    }
}

/// 32 random hex characters; a sidecar's frame stream opens with them.
fn video_token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // No secret, no stream: a token nobody can send never matches.
        return String::new();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The sidecar's frame stream for session `generation`: the latest frame of each
/// track, kept until the track ends or the session does.
async fn receive(inner: Weak<Inner>, generation: u64, listener: TcpListener, token: String) {
    let Ok(Ok((mut stream, _))) = tokio::time::timeout(VIDEO_TIMEOUT, listener.accept()).await else { return };
    drop(listener);
    if token.is_empty() || !handshake(&mut stream, &token).await {
        return;
    }
    loop {
        let Ok(length) = stream.read_u32_le().await else { return };
        if length > frames::MAX_MESSAGE {
            return;
        }
        let mut body = vec![0u8; length as usize];
        if stream.read_exact(&mut body).await.is_err() {
            return;
        }
        let Some((header, pixels)) = frames::parse(&body) else { return };
        let Some(inner) = inner.upgrade() else { return };
        let mut video = inner.video.lock().unwrap();
        if video.generation != generation {
            return;
        }
        let key = (header.source, header.identity);
        if header.width == 0 {
            video.frames.remove(&key);
            continue;
        }
        video.serial += 1;
        let frame =
            VideoFrame { width: header.width, height: header.height, pixels: pixels.into(), serial: video.serial };
        video.frames.insert(key, frame);
    }
}

async fn handshake(stream: &mut TcpStream, token: &str) -> bool {
    let mut head = [0u8; 5];
    if tokio::time::timeout(HELLO_TIMEOUT, stream.read_exact(&mut head)).await.is_err()
        || head[..4] != frames::MAGIC[..]
    {
        return false;
    }
    let mut sent = vec![0u8; head[4] as usize];
    stream.read_exact(&mut sent).await.is_ok() && sent == token.as_bytes()
}

async fn send(stdin: &mut ChildStdin, command: &Command) -> Result<(), VoiceError> {
    let mut line = serde_json::to_vec(command).map_err(|_| VoiceError::Exited)?;
    line.push(b'\n');
    stdin.write_all(&line).await.map_err(|_| VoiceError::Exited)?;
    stdin.flush().await.map_err(|_| VoiceError::Exited)
}

/// Asks the sidecar to leave, then kills it if it lingers.
async fn stop(mut sidecar: Sidecar) {
    let _ = send(&mut sidecar.stdin, &Command::Disconnect).await;
    if tokio::time::timeout(EXIT_TIMEOUT, sidecar.child.wait()).await.is_err() {
        let _ = sidecar.child.kill().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_map_to_what_the_ui_says() {
        assert_eq!(Ended::from_reason("duplicate_identity"), Ended::MovedElsewhere);
        assert_eq!(Ended::from_reason("client_initiated"), Ended::Left);
        assert_eq!(Ended::from_reason("participant_removed"), Ended::Removed("participant_removed".into()));
        assert_eq!(Ended::from_reason("signal_close"), Ended::Failed("signal_close".into()));
    }

    #[tokio::test]
    async fn a_missing_sidecar_is_unavailable() {
        let voice = VoiceController::with_sidecar(PathBuf::from("/nonexistent/rv-voice"), vec![]);
        let grant = VoiceGrant {
            room_id: "r1".into(),
            url: "wss://lk".into(),
            token: "t".into(),
            expires_at: "2026-10-06T12:05:00Z".into(),
            can_publish: true,
            ring: None,
            e2ee: false,
        };
        assert_eq!(voice.connect(&grant, None, None).await, Err(VoiceError::Spawn));
        let snapshot = voice.snapshot();
        assert_eq!(snapshot.room, None);
        assert_eq!(snapshot.ended, Some(Ended::Failed("voice_sidecar_failed".into())));
    }
}
