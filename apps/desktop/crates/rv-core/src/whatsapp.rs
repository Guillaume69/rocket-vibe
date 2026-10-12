//! Local WhatsApp desktop pilot. The sidecar owns encrypted state and the wire protocol.
//! No WhatsApp content or credentials go through a RocketVibe server.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;
use zeroize::Zeroize;

use crate::store::MessageRow;

const MAX_FRAME: u64 = 1 << 20;
const CACHE_MESSAGES: usize = 20_000;

#[derive(Clone, Default)]
pub struct Snapshot {
    pub revision: u64,
    pub state: String,
    pub error: Option<String>,
    /// Pairing material is transient and must never be logged or persisted.
    pub qr: Option<(String, u64)>,
    pub messages: BTreeMap<String, WireMessage>,
    /// The helper replayed its cache: a send intent it does not list was never
    /// recorded, so it never reached WhatsApp.
    pub loaded: bool,
    /// The last send the helper refused before any network attempt.
    pub refused: Option<String>,
    /// The helper process is gone; its state lock is free for a new one.
    pub exited: bool,
}
#[derive(Clone, Deserialize)]
pub struct WireMessage {
    pub id: String,
    pub chat: String,
    pub name: String,
    pub sender: String,
    pub author: String,
    pub text: String,
    pub ts: i64,
    pub mine: bool,
    #[serde(default)]
    pub status: String,
}
impl WireMessage {
    pub fn presentation(&self) -> MessageRow {
        MessageRow {
            id: self.id.clone(),
            rid: self.chat.clone(),
            ts: self.ts,
            text: Some(self.text.clone()),
            author: Some(if self.mine {
                String::new()
            } else if self.author.is_empty() {
                self.name.clone()
            } else {
                self.author.clone()
            }),
            author_id: if self.mine { "me".into() } else { self.sender.clone() },
            outbox_status: match self.status.as_str() {
                "sending" => Some("pending".into()),
                "uncertain" => Some("uncertain".into()),
                _ => None,
            },
            ..Default::default()
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event {
    Qr {
        code: String,
        expires_ms: u64,
    },
    Status {
        state: String,
    },
    Message {
        message: WireMessage,
    },
    Error {
        code: String,
        /// Set when the error refuses one send, which never left the computer.
        #[serde(default)]
        id: Option<String>,
    },
    Sent {
        id: String,
        #[serde(default)]
        state: String,
    },
}
enum Request {
    Send { id: String, chat: String, text: String },
    Connect,
    Logout,
    Stop,
}
pub struct Connector {
    snapshot: Mutex<Snapshot>,
    requests: mpsc::Sender<Request>,
}
fn failure() -> String {
    "connector_unavailable".into()
}

pub fn storage_key() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "secure_storage_unavailable".to_owned())?;
    let value = base64::engine::general_purpose::STANDARD.encode(bytes);
    bytes.zeroize();
    Ok(value)
}
pub fn locate() -> Option<PathBuf> {
    let name = if cfg!(windows) { "rv-whatsapp.exe" } else { "rv-whatsapp" };
    std::env::current_exe().ok()?.parent().map(|p| p.join(name)).filter(|p| p.is_file())
}
impl Snapshot {
    fn apply(&mut self, event: Event) {
        self.revision += 1;
        match event {
            Event::Qr { code, expires_ms } => {
                self.qr = Some((code, expires_ms));
                self.state = "qr".into();
                self.error = None;
            }
            Event::Status { state } => {
                if state != "connecting" {
                    self.qr = None;
                }
                if state == "loaded" {
                    self.loaded = true;
                }
                if state == "logged_out" {
                    self.messages.clear();
                }
                self.state = state;
                self.error = None;
            }
            Event::Message { message } => {
                self.messages.insert(message.id.clone(), message);
                if self.messages.len() > CACHE_MESSAGES
                    && let Some(id) = self.messages.values().min_by_key(|m| (m.ts, &m.id)).map(|m| m.id.clone())
                {
                    self.messages.remove(&id);
                }
            }
            Event::Error { code, id } => {
                // A refused send or a failed unlink leaves the connection as it was.
                if id.is_some() {
                    self.refused = id;
                } else if !matches!(code.as_str(), "logout_failed" | "invalid_command" | "local_storage_failed") {
                    self.qr = None;
                    self.state = "error".into();
                }
                self.error = Some(code);
            }
            Event::Sent { id, state } => {
                let _ = id;
                if state == "uncertain" {
                    self.error = Some("send_uncertain".into());
                }
            }
        }
    }
}
impl Connector {
    pub async fn start(program: &Path, state: &Path, mut key: String) -> Result<Arc<Self>, String> {
        let mut command = Command::new(program);
        command
            .arg("--state")
            .arg(state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| failure())?;
        let mut stdin = child.stdin.take().ok_or_else(failure)?;
        let stdout = child.stdout.take().ok_or_else(failure)?;
        let mut init = json!({"type":"start","key":key});
        key.zeroize();
        let mut bytes = serde_json::to_vec(&init).map_err(|_| failure())?;
        if let serde_json::Value::String(secret) = &mut init["key"] {
            secret.zeroize();
        }
        bytes.push(b'\n');
        let sent = stdin.write_all(&bytes).await;
        bytes.zeroize();
        sent.map_err(|_| failure())?;
        let (requests, receiver) = mpsc::channel(32);
        let connector = Arc::new(Self {
            snapshot: Mutex::new(Snapshot { state: "connecting".into(), ..Default::default() }),
            requests,
        });
        tokio::spawn(worker(Arc::downgrade(&connector), child, stdin, BufReader::new(stdout), receiver));
        Ok(connector)
    }
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    pub fn revision(&self) -> u64 {
        self.snapshot.lock().unwrap_or_else(|p| p.into_inner()).revision
    }
    pub fn state(&self) -> String {
        self.snapshot.lock().unwrap_or_else(|p| p.into_inner()).state.clone()
    }
    pub fn exited(&self) -> bool {
        self.snapshot.lock().unwrap_or_else(|p| p.into_inner()).exited
    }
    fn request(&self, request: Request) -> Result<(), String> {
        self.requests.try_send(request).map_err(|_| failure())
    }
    pub fn reconnect(&self) -> Result<(), String> {
        self.request(Request::Connect)
    }
    pub fn logout(&self) -> Result<(), String> {
        self.request(Request::Logout)
    }
    pub fn stop(&self) {
        let _ = self.requests.try_send(Request::Stop);
    }
    pub fn send(&self, chat: String, text: String) -> Result<String, String> {
        if text.trim().is_empty() || text.len() > 20_000 || self.state() != "connected" {
            return Err("not_connected".into());
        }
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| failure())?;
        let id: String = random.iter().map(|b| format!("{b:02X}")).collect();
        self.request(Request::Send { id: id.clone(), chat, text })?;
        Ok(id)
    }
}
async fn worker(
    weak: Weak<Connector>,
    mut child: Child,
    mut stdin: ChildStdin,
    mut stdout: BufReader<tokio::process::ChildStdout>,
    mut receiver: mpsc::Receiver<Request>,
) {
    let mut line = Vec::new();
    loop {
        let mut limited = (&mut stdout).take(MAX_FRAME + 1 - line.len() as u64);
        tokio::select! {
            read = limited.read_until(b'\n', &mut line) => {
                if !matches!(read, Ok(n) if n > 0) || line.len() > MAX_FRAME as usize { break; }
                let Ok(event) = serde_json::from_slice::<Event>(&line) else { break };
                let Some(connector) = weak.upgrade() else { break };
                connector.snapshot.lock().unwrap_or_else(|p| p.into_inner()).apply(event);
                line.clear();
            }
            request = receiver.recv() => {
                let Some(request) = request else { break };
                let stopping = matches!(request, Request::Stop);
                let value = match request {
                    Request::Send { id, chat, text } => json!({"type":"send","id":id,"chat":chat,"text":text}),
                    Request::Connect => json!({"type":"connect"}),
                    Request::Logout => json!({"type":"logout"}),
                    Request::Stop => json!({"type":"stop"}),
                };
                let mut frame = value.to_string().into_bytes();
                frame.push(b'\n');
                if stdin.write_all(&frame).await.is_err() { break; }
                if stopping { break; }
            }
        }
    }
    drop(stdin);
    if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
    if let Some(connector) = weak.upgrade() {
        let mut snapshot = connector.snapshot.lock().unwrap_or_else(|p| p.into_inner());
        if snapshot.state != "logged_out" {
            snapshot.state = "stopped".into();
        }
        snapshot.qr = None;
        snapshot.exited = true;
        snapshot.revision += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn qr_is_transient_and_revocation_erases_projection() {
        let mut s = Snapshot::default();
        s.apply(Event::Qr { code: "test-only".into(), expires_ms: 30_000 });
        assert!(s.qr.is_some());
        s.apply(Event::Status { state: "connected".into() });
        assert!(s.qr.is_none());
        s.apply(
            serde_json::from_value(json!({"type":"message","message":{
                "id":"chat:1","chat":"chat","name":"Alice","sender":"alice","author":"Alice",
                "text":"hello","ts":10,"mine":false
            }}))
            .unwrap(),
        );
        s.apply(Event::Status { state: "logged_out".into() });
        assert!(s.messages.is_empty());
    }
    #[test]
    fn a_refused_send_keeps_the_connection_and_a_fatal_error_ends_it() {
        let mut s = Snapshot::default();
        s.apply(Event::Status { state: "connected".into() });
        s.apply(serde_json::from_value(json!({"type":"error","code":"invalid_send","id":"ABCDEF0123"})).unwrap());
        assert_eq!(s.state, "connected");
        assert_eq!(s.refused.as_deref(), Some("ABCDEF0123"));
        s.apply(serde_json::from_value(json!({"type":"error","code":"logout_failed"})).unwrap());
        assert_eq!(s.state, "connected");
        s.apply(serde_json::from_value(json!({"type":"error","code":"secure_storage_failed"})).unwrap());
        assert_eq!(s.state, "error");
        assert_eq!(s.error.as_deref(), Some("secure_storage_failed"));
    }
    #[test]
    fn the_replayed_cache_marks_the_snapshot_loaded() {
        let mut s = Snapshot::default();
        assert!(!s.loaded);
        s.apply(Event::Status { state: "loaded".into() });
        s.apply(Event::Status { state: "connecting".into() });
        assert!(s.loaded);
    }
    #[test]
    fn outgoing_unknown_is_never_presented_as_delivered() {
        let m: WireMessage = serde_json::from_value(json!({
            "id":"chat:1","chat":"chat","name":"Alice","sender":"me","author":"",
            "text":"hello","ts":10,"mine":true,"status":"uncertain"
        }))
        .unwrap();
        assert_eq!(m.presentation().outbox_status.as_deref(), Some("uncertain"));
        assert_eq!(m.presentation().author_id, "me");
    }
}
