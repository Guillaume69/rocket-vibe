//! Voice media runs in the `rv-voice` sidecar, the only binary that links
//! libwebrtc, driven over JSON lines (`rv-voice-protocol`). One process per
//! connection: `connect` spawns it, it exits once disconnected, and it dies with
//! the controller (`kill_on_drop`). The UI observes a [`Snapshot`] and payload-less
//! change notifications, like the native store.
use rv_protocol::voice::VoiceGrant;
use rv_voice_protocol::{Command, Event, VERSION};
pub use rv_voice_protocol::{ConnectionState, Device, Participant};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{broadcast, oneshot};

/// Microphones, then speakers.
pub type Devices = (Vec<Device>, Vec<Device>);

const BINARY: &str = if cfg!(windows) { "rv-voice.exe" } else { "rv-voice" };
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const EXIT_TIMEOUT: Duration = Duration::from_secs(4);

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
}
impl VoiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unavailable => "voice_unavailable",
            Self::Spawn => "voice_sidecar_failed",
            Self::Incompatible => "voice_sidecar_incompatible",
            Self::Exited => "voice_sidecar_exited",
            Self::Timeout => "voice_timeout",
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
    /// The user's choices; they carry over to the next connection.
    pub microphone: bool,
    pub deafened: bool,
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
            microphone: true,
            deafened: false,
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
        self.ended = Some(ended);
    }
}

struct Shared {
    snapshot: Snapshot,
    input: Option<String>,
    output: Option<String>,
    devices: Option<(u64, oneshot::Sender<Devices>)>,
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
                shared: Mutex::new(Shared { snapshot: Snapshot::default(), input: None, output: None, devices: None }),
                changes,
                process: tokio::sync::Mutex::new(None),
                generation: AtomicU64::new(0),
            }),
        }
    }
    pub fn changes(&self) -> broadcast::Receiver<()> {
        self.inner.changes.subscribe()
    }
    pub fn snapshot(&self) -> Snapshot {
        self.inner.shared.lock().unwrap().snapshot.clone()
    }
    /// Replaces any current connection with the grant's room. Returns once the
    /// sidecar took the command; the outcome arrives through the snapshot.
    pub async fn connect(&self, grant: &VoiceGrant) -> Result<(), VoiceError> {
        let mut process = self.inner.process.lock().await;
        // A new generation first: the old sidecar's last words are ignored.
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(old) = process.take() {
            stop(old).await;
        }
        let commands = self.inner.update(|s| {
            s.snapshot = Snapshot {
                room: Some(grant.room_id.clone()),
                state: ConnectionState::Connecting,
                can_publish: grant.can_publish,
                microphone: s.snapshot.microphone,
                deafened: s.snapshot.deafened,
                ..Snapshot::default()
            };
            let mut commands: Vec<_> = s.input.iter().map(|d| Command::SetInput { device: d.clone() }).collect();
            commands.extend(s.output.iter().map(|d| Command::SetOutput { device: d.clone() }));
            commands.push(Command::SetMicrophone { enabled: s.snapshot.microphone });
            commands.push(Command::SetDeafened { deafened: s.snapshot.deafened });
            commands.push(Command::Connect { url: grant.url.clone(), token: grant.token.clone() });
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
                *process = Some(sidecar);
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
        self.inner.update(|s| {
            if s.snapshot.room.is_some() {
                s.snapshot.end(Ended::Left);
            }
            s.devices = None;
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
            self.inner.shared.lock().unwrap().devices = Some((sidecar.generation, tx));
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
        let mut process = self.inner.process.lock().await;
        if let Some(sidecar) = process.as_mut() {
            // A dead sidecar is reported by its reader; nothing to add here.
            let _ = send(&mut sidecar.stdin, &command).await;
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
                if let Some((owner, tx)) = s.devices.take() {
                    if owner == generation {
                        let _ = tx.send((inputs, outputs));
                    } else {
                        s.devices = Some((owner, tx));
                    }
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
                Event::Error { code } => s.snapshot.error = Some(code),
                Event::Hello { .. } | Event::Devices { .. } => {}
            }
        });
    }
    fn exited(&self, generation: u64) {
        self.update(|s| {
            if s.devices.as_ref().is_some_and(|(owner, _)| *owner == generation) {
                s.devices = None;
            }
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
        assert_eq!(voice.connect(&grant).await, Err(VoiceError::Spawn));
        let snapshot = voice.snapshot();
        assert_eq!(snapshot.room, None);
        assert_eq!(snapshot.ended, Some(Ended::Failed("voice_sidecar_failed".into())));
    }
}
