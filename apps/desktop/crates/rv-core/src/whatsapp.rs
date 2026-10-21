//! Local WhatsApp desktop pilot. The sidecar owns encrypted state and the wire protocol.
//! No WhatsApp content or credentials go through a Vibez server.
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, watch};
use zeroize::Zeroize;

use crate::store::MessageRow;

const MAX_FRAME: u64 = 1 << 20;

/// A WhatsApp account's `base_url`: `whatsapp://<state id>`, the id naming its
/// sealed state and wrapping key on this computer. Its `user_id` is the
/// account's JID; it has no token. Not an http server: every place that reads
/// `base_url` as one checks `is_whatsapp` first.
pub const SCHEME: &str = "whatsapp://";
/// The state of the window that came before accounts (`whatsapp-pilot/`),
/// adopted as an account without a new scan.
pub const PILOT_STATE: &str = "pilot";

/// The state id of a WhatsApp account, when `base_url` is one.
pub fn state_id(base_url: &str) -> Option<&str> {
    let id = base_url.strip_prefix(SCHEME)?;
    let valid = (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    valid.then_some(id)
}
pub fn is_whatsapp(info: &crate::session::SessionInfo) -> bool {
    state_id(&info.base_url).is_some()
}
/// The account a linked device stands for.
pub fn account_info(state: &str, jid: &str, name: &str) -> crate::session::SessionInfo {
    crate::session::SessionInfo {
        base_url: format!("{SCHEME}{state}"),
        user_id: jid.to_owned(),
        username: if name.is_empty() { fallback_name(jid) } else { name.to_owned() },
        auth_token: String::new(),
        native: None,
        mattermost: None,
        slack: None,
        teams: None,
    }
}
/// A new state id: random, lower-case hex.
pub fn new_state_id() -> Result<String, String> {
    let mut random = [0_u8; 12];
    getrandom::fill(&mut random).map_err(|_| failure())?;
    Ok(random.iter().map(|b| format!("{b:02x}")).collect())
}
/// Where an account's sealed state lives under the app's data directory, and
/// the keychain entry of the key that wraps it. The pilot's state keeps the
/// places it always had, so adopting it moves nothing.
pub fn state_location(data_dir: &Path, state: &str) -> (PathBuf, String) {
    if state == PILOT_STATE {
        return (data_dir.join("whatsapp-pilot").join("state.bin"), "whatsapp-pilot-storage-v1".into());
    }
    (data_dir.join("whatsapp").join(state).join("state.bin"), format!("whatsapp-storage-v1|{state}"))
}
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
    /// What each chat and sender is called, swapped in whole by the helper.
    pub names: Arc<BTreeMap<String, String>>,
    /// Profile photos (JPEG previews) by JID.
    pub avatars: Arc<BTreeMap<String, Arc<[u8]>>>,
    /// Reactions by message id, then by sender ("me" for mine): the emoji.
    pub reactions: Arc<BTreeMap<String, BTreeMap<String, String>>>,
    /// Unread messages by chat, as WhatsApp counts them (shared with the phone).
    pub unread: BTreeMap<String, u32>,
    /// The linked account: its JID and the name it shows, once paired.
    pub account: Option<(String, String)>,
    /// Who types (or records) in each chat, and since when.
    pub typing: BTreeMap<String, BTreeMap<String, (String, std::time::Instant)>>,
    /// Calls ringing now, by id.
    pub calls: BTreeMap<String, WaCall>,
    /// The code to type on the phone to link by number, once asked for.
    pub pairing_code: Option<String>,
}
/// A WhatsApp call ringing: it can be declined here, or answered on the phone.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct WaCall {
    pub id: String,
    /// The caller's JID.
    pub from: String,
    /// The group a group call rings in.
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub video: bool,
    pub state: String,
}
/// A "typing" WhatsApp does not end itself fades after this.
const TYPING_FADE: Duration = Duration::from_secs(12);
impl Snapshot {
    /// The name shown for a chat or a person, falling back on what the
    /// message itself carried.
    pub fn name_of(&self, jid: &str) -> Option<&str> {
        self.names.get(jid).map(String::as_str).filter(|n| !n.is_empty())
    }
    pub fn chat_name(&self, message: &WireMessage) -> String {
        self.name_of(&message.chat).map(str::to_owned).unwrap_or_else(|| fallback_name(&message.chat))
    }
    /// The names of who types in a chat now.
    pub fn typing_names(&self, chat: &str) -> Vec<String> {
        self.typing
            .get(chat)
            .into_iter()
            .flatten()
            .filter(|(_, (state, since))| state != "paused" && since.elapsed() < TYPING_FADE)
            .map(|(sender, _)| self.name_of(sender).map(str::to_owned).unwrap_or_else(|| fallback_name(sender)))
            .collect()
    }
    /// A message as the native timeline draws it.
    pub fn presentation(&self, m: &WireMessage) -> MessageRow {
        let mut row = m.presentation();
        if !m.mine {
            let named = self.name_of(&m.sender).map(str::to_owned);
            row.author = Some(
                named.unwrap_or_else(|| if !m.author.is_empty() { m.author.clone() } else { fallback_name(&m.sender) }),
            );
        }
        row.reactions = self.reactions.get(&m.id).and_then(|by_sender| self.reactions_json(by_sender));
        let attachments: Vec<serde_json::Value> = self.quote(m).into_iter().chain(attachment_json(m)).collect();
        row.attachments = (!attachments.is_empty()).then(|| serde_json::Value::Array(attachments).to_string());
        row
    }
    /// `{":shortcode:": {"usernames": [sender, ...], "names": [...]}}`, the
    /// shape the timeline's reaction chips read, each sender named as the
    /// timeline names them; a glyph with no shortcode is keyed by itself.
    fn reactions_json(&self, by_sender: &BTreeMap<String, String>) -> Option<String> {
        let mut grouped: BTreeMap<String, (Vec<&str>, Vec<String>)> = BTreeMap::new();
        for (sender, emoji) in by_sender {
            let code = crate::emoji::shortcode(emoji).unwrap_or(emoji.as_str());
            let (users, names) = grouped.entry(format!(":{code}:")).or_default();
            users.push(sender);
            names.push(match sender.as_str() {
                "me" => crate::i18n::t("wa.me").to_owned(),
                jid => self.name_of(jid).map(str::to_owned).unwrap_or_else(|| fallback_name(jid)),
            });
        }
        let value: serde_json::Map<String, serde_json::Value> = grouped
            .into_iter()
            .map(|(code, (users, names))| (code, json!({ "usernames": users, "names": names })))
            .collect();
        (!value.is_empty()).then(|| serde_json::Value::Object(value).to_string())
    }
    /// The quoted message as the timeline's quote card: its current text when
    /// cached (edited or deleted since), else the text the reply carried.
    fn quote(&self, m: &WireMessage) -> Option<serde_json::Value> {
        if m.reply_to.is_empty() {
            return None;
        }
        let cached = self.messages.get(&m.reply_to);
        let sender = cached.map_or(m.quote_sender.as_str(), |q| if q.mine { "me" } else { q.sender.as_str() });
        let author = if sender == "me" {
            crate::i18n::t("wa.me").to_owned()
        } else if sender.is_empty() {
            String::new()
        } else {
            self.name_of(sender).map(str::to_owned).unwrap_or_else(|| fallback_name(sender))
        };
        let text = match cached {
            Some(q) if q.deleted => crate::i18n::t("wa.deleted").to_owned(),
            Some(q) => q.words(),
            None => m.quote_text.clone(),
        };
        Some(json!({"message_link": format!("{REPLY_LINK}{}", m.reply_to), "author_name": author, "text": text}))
    }
}

/// The composer's reply link for a WhatsApp message: `wa-reply:<id>`.
pub const REPLY_LINK: &str = "wa-reply:";

/// The text a composer submits with a reply armed (`[ ](wa-reply:<id>) text`),
/// split into the quoted message's id and the text.
pub fn split_reply(text: &str) -> (Option<String>, String) {
    let Some(rest) = text.strip_prefix("[ ](").and_then(|r| r.strip_prefix(REPLY_LINK)) else {
        return (None, text.to_owned());
    };
    match rest.split_once(')') {
        Some((id, body)) if !id.is_empty() => (Some(id.to_owned()), body.trim_start().to_owned()),
        _ => (None, text.to_owned()),
    }
}

/// A JID without a known name: its number, as WhatsApp shows a stranger.
pub fn fallback_name(jid: &str) -> String {
    match jid.split_once('@') {
        Some((user, "s.whatsapp.net")) => format!("+{user}"),
        Some((user, _)) => user.to_owned(),
        None => jid.to_owned(),
    }
}

/// The glyph WhatsApp sends for a reaction chip's shortcode.
pub fn reaction_glyph(shortcode: &str) -> String {
    crate::emoji::unicode(shortcode).map(str::to_owned).unwrap_or_else(|| shortcode.trim_matches(':').to_owned())
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
    #[serde(default)]
    pub edited: bool,
    #[serde(default)]
    pub deleted: bool,
    /// How far my message went: `delivered`, `read` or `played`.
    #[serde(default)]
    pub receipt: String,
    /// A reply: the quoted message's id, sender ("me" for mine) and quoted text.
    #[serde(default)]
    pub reply_to: String,
    #[serde(default)]
    pub quote_sender: String,
    #[serde(default)]
    pub quote_text: String,
    /// An attachment (image, gif, video, audio, voice, document, sticker):
    /// the text is then its caption.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub width: i64,
    #[serde(default)]
    pub height: i64,
    #[serde(default)]
    pub seconds: i64,
    /// A link's preview as the sender's app made it; its thumbnail, when
    /// `link_image`, is fetched like an attachment.
    #[serde(default)]
    pub link_url: String,
    #[serde(default)]
    pub link_title: String,
    #[serde(default)]
    pub link_description: String,
    #[serde(default)]
    pub link_image: bool,
}
/// The path a WhatsApp attachment is asked for by: `wa-media:<message id>`.
pub const MEDIA_LINK: &str = "wa-media:";
/// The attachment of a message in the shape the timeline draws
/// (Rocket.Chat's): an image, an audio or video file, or a document.
fn attachment_json(m: &WireMessage) -> Option<serde_json::Value> {
    if m.deleted {
        return None;
    }
    let link = format!("{MEDIA_LINK}{}", m.id);
    // "audio/ogg; codecs=opus" reads as its type alone.
    let mime = m.mime.split(';').next().unwrap_or_default().trim();
    let size = (m.size > 0).then_some(m.size);
    let duration = |label: &str| {
        if m.seconds > 0 { format!("{label} ({}:{:02})", m.seconds / 60, m.seconds % 60) } else { label.to_owned() }
    };
    Some(match m.kind.as_str() {
        "image" | "sticker" => json!({
            "image_url": link,
            "image_dimensions": {"width": m.width, "height": m.height},
            "image_size": size,
        }),
        "voice" | "audio" => json!({
            "title": duration(crate::i18n::t(&format!("wa.kind.{}", m.kind))),
            "audio_url": link, "audio_type": mime, "audio_size": size,
        }),
        "video" | "gif" => json!({
            "title": duration(crate::i18n::t(&format!("wa.kind.{}", m.kind))),
            "video_url": link, "video_type": mime, "video_size": size,
        }),
        "document" => json!({
            "title": if m.file_name.is_empty() { crate::i18n::t("wa.kind.document").to_owned() } else { m.file_name.clone() },
            "title_link": link, "title_link_download": true, "format": mime, "size": size,
        }),
        _ => return None,
    })
}
impl WireMessage {
    /// What the message says in words: an attachment's label, then its caption.
    pub fn words(&self) -> String {
        if self.deleted {
            return crate::i18n::t("wa.deleted").to_owned();
        }
        let label = match self.kind.as_str() {
            "" => return self.text.clone(),
            "document" if !self.file_name.is_empty() => format!("📄 {}", self.file_name),
            kind => crate::i18n::t(&format!("wa.kind.{kind}")).to_owned(),
        };
        if self.text.is_empty() { label } else { format!("{label}\n{}", self.text) }
    }
}
impl WireMessage {
    pub fn presentation(&self) -> MessageRow {
        MessageRow {
            id: self.id.clone(),
            rid: self.chat.clone(),
            ts: self.ts,
            // An attachment's caption only: the attachment draws itself.
            text: Some(if self.kind.is_empty() || self.deleted { self.words() } else { self.text.clone() }),
            edited: self.edited && !self.deleted,
            author: Some(if self.mine {
                crate::i18n::t("wa.me").to_owned()
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
            urls: self.link_preview(),
            ..Default::default()
        }
    }
    /// The preview in the shape of a Rocket.Chat `urls` entry, which the
    /// timeline's link cards (and video-site cards) read.
    fn link_preview(&self) -> Option<String> {
        if self.link_url.is_empty() || self.deleted || !self.kind.is_empty() {
            return None;
        }
        let mut meta = serde_json::Map::new();
        if !self.link_title.is_empty() {
            meta.insert("ogTitle".into(), self.link_title.clone().into());
        }
        if !self.link_description.is_empty() {
            meta.insert("ogDescription".into(), self.link_description.clone().into());
        }
        if self.link_image {
            meta.insert("ogImage".into(), format!("{MEDIA_LINK}{}", self.id).into());
        }
        Some(json!([{"url": self.link_url, "meta": meta}]).to_string())
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
        message: Box<WireMessage>,
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
    Names {
        #[serde(default)]
        names: BTreeMap<String, String>,
    },
    Avatar {
        jid: String,
        #[serde(default)]
        data: String,
    },
    Reaction {
        reaction: WireReaction,
    },
    /// The helper re-keyed its cache (a LID mapped to a number): it replays it whole.
    Reload,
    Chat {
        jid: String,
        #[serde(default)]
        unread: u32,
    },
    Account {
        jid: String,
        #[serde(default)]
        name: String,
    },
    Typing {
        typing: WireTyping,
    },
    Call {
        call: WaCall,
    },
    PairingCode {
        code: String,
    },
    /// A downloaded attachment, by its message id; an empty path is a failure.
    File {
        id: String,
        #[serde(default)]
        path: String,
    },
    /// The answer to a search, by its id.
    Found {
        id: String,
        #[serde(default)]
        people: Vec<Person>,
    },
}
#[derive(Deserialize)]
struct WireTyping {
    chat: String,
    sender: String,
    state: String,
}

/// A file to send to a chat.
#[derive(Clone, Debug, Default)]
pub struct OutgoingFile {
    pub chat: String,
    pub path: String,
    pub name: String,
    pub mime: String,
    pub caption: String,
    pub reply: Option<String>,
    /// Recorded by the app: sent as a voice note.
    pub voice: bool,
}
struct Upload {
    id: String,
    chat: String,
    path: String,
    name: String,
    mime: String,
    caption: String,
    reply: Option<String>,
    voice: bool,
}

/// Someone (or a group) a search found: a conversation to start.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Person {
    pub jid: String,
    pub name: String,
}
#[derive(Deserialize)]
struct WireReaction {
    message: String,
    sender: String,
    #[serde(default)]
    emoji: String,
}
enum Request {
    Send { id: String, chat: String, text: String, reply: Option<String> },
    Act { kind: &'static str, id: String, text: String },
    Read { chat: String },
    Search { id: String, text: String },
    Download { id: String },
    Upload(Box<Upload>),
    Typing { chat: String, composing: bool },
    RejectCall { id: String },
    PairPhone { number: String },
    Presence { available: bool },
    Connect,
    Logout,
    Stop,
}
pub struct Connector {
    snapshot: Mutex<Snapshot>,
    requests: mpsc::Sender<Request>,
    /// The snapshot's revision after each change: a watcher folds bursts by itself.
    revisions: watch::Sender<u64>,
    /// Searches waiting for their answer, by id.
    searches: Mutex<HashMap<String, oneshot::Sender<Vec<Person>>>>,
    /// Downloads waiting for their file, by message id; one request serves them all.
    downloads: Mutex<HashMap<String, Vec<oneshot::Sender<String>>>>,
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
/// The helper beside the app's executable, or in an AppImage's root (whose
/// executable is its loader; the root is in `SHARUN_DIR`), like `rv-voice`.
pub fn locate() -> Option<PathBuf> {
    let name = if cfg!(windows) { "rv-whatsapp.exe" } else { "rv-whatsapp" };
    let beside = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join(name)));
    let bundled = ["SHARUN_DIR", "APPDIR"]
        .into_iter()
        .filter_map(std::env::var_os)
        .filter(|root| !root.is_empty())
        .map(|root| PathBuf::from(root).join("bin").join(name));
    beside.into_iter().chain(bundled).find(|path| path.is_file())
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
                // A message ends its author's typing.
                if let Some(senders) = self.typing.get_mut(&message.chat) {
                    senders.remove(&message.sender);
                }
                self.messages.insert(message.id.clone(), *message);
                if self.messages.len() > CACHE_MESSAGES
                    && let Some(id) = self.messages.values().min_by_key(|m| (m.ts, &m.id)).map(|m| m.id.clone())
                {
                    self.messages.remove(&id);
                }
            }
            Event::Error { code, id } => {
                // Only these end the session; a refused send, a failed reaction
                // or unlink leave the connection as it was.
                if id.is_some() {
                    self.refused = id;
                } else if matches!(
                    code.as_str(),
                    "connector_start_failed"
                        | "secure_storage_failed"
                        | "session_ended"
                        | "pairing_failed"
                        | "client_outdated"
                        | "connection_failed"
                        | "state_removal_failed"
                ) {
                    self.qr = None;
                    self.state = "error".into();
                }
                self.error = Some(code);
            }
            Event::Names { names } => self.names = Arc::new(names),
            Event::Avatar { jid, data } => {
                let photo = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).unwrap_or_default();
                let avatars = Arc::make_mut(&mut self.avatars);
                if photo.is_empty() {
                    avatars.remove(&jid);
                } else {
                    avatars.insert(jid, photo.into());
                }
            }
            Event::Reaction { reaction } => {
                let reactions = Arc::make_mut(&mut self.reactions);
                let by_sender = reactions.entry(reaction.message.clone()).or_default();
                if reaction.emoji.is_empty() {
                    by_sender.remove(&reaction.sender);
                } else {
                    by_sender.insert(reaction.sender, reaction.emoji);
                }
                if by_sender.is_empty() {
                    reactions.remove(&reaction.message);
                }
            }
            Event::Reload => {
                self.messages.clear();
                self.reactions = Arc::default();
                self.unread.clear();
            }
            Event::Account { jid, name } => self.account = Some((jid, name)),
            Event::PairingCode { code } => {
                self.pairing_code = Some(code);
                self.error = None;
            }
            Event::Call { call } => {
                if call.state == "ringing" {
                    self.calls.insert(call.id.clone(), call);
                } else {
                    self.calls.remove(&call.id);
                }
            }
            Event::Typing { typing } => {
                let senders = self.typing.entry(typing.chat).or_default();
                senders.insert(typing.sender, (typing.state, std::time::Instant::now()));
                senders.retain(|_, (state, since)| state != "paused" && since.elapsed() < TYPING_FADE);
            }
            // Answered to their askers by the reader, never kept.
            Event::Found { .. } | Event::File { .. } => {}
            Event::Chat { jid, unread } => {
                if unread == 0 {
                    self.unread.remove(&jid);
                } else {
                    self.unread.insert(jid, unread);
                }
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
            revisions: watch::Sender::new(0),
            searches: Mutex::default(),
            downloads: Mutex::default(),
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
    /// Changes of the snapshot, as revisions; the last one stays when it exits.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.revisions.subscribe()
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
    /// Sends a text, answering `reply` (a message id) when set.
    pub fn send(&self, chat: String, text: String, reply: Option<String>) -> Result<String, String> {
        if text.trim().is_empty() || text.len() > 20_000 || self.state() != "connected" {
            return Err("not_connected".into());
        }
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| failure())?;
        let id: String = random.iter().map(|b| format!("{b:02X}")).collect();
        self.request(Request::Send { id: id.clone(), chat, text, reply })?;
        Ok(id)
    }
    /// Reacts to a message with a glyph; an empty one takes my reaction back.
    pub fn react(&self, id: String, glyph: String) -> Result<(), String> {
        self.request(Request::Act { kind: "react", id, text: glyph })
    }
    pub fn edit(&self, id: String, text: String) -> Result<(), String> {
        if text.trim().is_empty() || text.len() > 20_000 {
            return Err("invalid_edit".into());
        }
        self.request(Request::Act { kind: "edit", id, text })
    }
    /// Deletes my message for everyone.
    pub fn delete(&self, id: String) -> Result<(), String> {
        self.request(Request::Act { kind: "delete", id, text: String::new() })
    }
    /// Reads a chat: its unread messages get their read receipts.
    /// Asks for a code to link by phone number (international, digits only
    /// count) instead of the QR; it arrives as `Snapshot::pairing_code`.
    pub fn pair_phone(&self, number: String) -> Result<(), String> {
        self.request(Request::PairPhone { number })
    }
    /// Declines a call ringing here, for all my devices.
    pub fn reject_call(&self, id: String) -> Result<(), String> {
        self.request(Request::RejectCall { id })
    }
    /// Tells a chat I am typing, or stopped.
    pub fn set_typing(&self, chat: String, composing: bool) -> Result<(), String> {
        self.request(Request::Typing { chat, composing })
    }
    /// Online while the app is in front (WhatsApp then sends who types, and
    /// holds the phone's notifications back), offline otherwise.
    pub fn set_presence(&self, available: bool) -> Result<(), String> {
        self.request(Request::Presence { available })
    }
    /// Sends a local file (a voice note when `voice`), uploaded by the helper;
    /// the id is the send's, like `send`'s.
    pub fn send_file(&self, file: OutgoingFile) -> Result<String, String> {
        if self.state() != "connected" {
            return Err("not_connected".into());
        }
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| failure())?;
        let id: String = random.iter().map(|b| format!("{b:02X}")).collect();
        self.request(Request::Upload(Box::new(Upload {
            id: id.clone(),
            chat: file.chat,
            path: file.path,
            name: file.name,
            mime: file.mime,
            caption: file.caption,
            reply: file.reply,
            voice: file.voice,
        })))?;
        Ok(id)
    }
    /// A message's attachment, fetched and decrypted into the account's
    /// private folder by the helper: the file's path.
    pub async fn download(&self, id: String) -> Result<PathBuf, String> {
        let (tx, rx) = oneshot::channel();
        let first = {
            let mut downloads = self.downloads.lock().unwrap_or_else(|p| p.into_inner());
            let waiters = downloads.entry(id.clone()).or_default();
            waiters.push(tx);
            waiters.len() == 1
        };
        if first && let Err(e) = self.request(Request::Download { id: id.clone() }) {
            self.downloads.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(Duration::from_secs(330), rx).await {
            Ok(Ok(path)) if !path.is_empty() => Ok(PathBuf::from(path)),
            _ => Err("download_failed".into()),
        }
    }
    /// People and groups matching `text`, from the phone's contacts and WhatsApp.
    pub async fn search(&self, text: String) -> Result<Vec<Person>, String> {
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).map_err(|_| failure())?;
        let id: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let (tx, rx) = oneshot::channel();
        self.searches.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), tx);
        if let Err(e) = self.request(Request::Search { id: id.clone(), text }) {
            self.searches.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
            return Err(e);
        }
        let answer = tokio::time::timeout(Duration::from_secs(20), rx).await;
        self.searches.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        match answer {
            Ok(Ok(people)) => Ok(people),
            _ => Err(failure()),
        }
    }
    pub fn mark_read(&self, chat: String) -> Result<(), String> {
        self.request(Request::Read { chat })
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
                // Not JSON is a broken helper; a frame of a type this build does
                // not know is a newer helper, and is skipped.
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) else { break };
                let Some(connector) = weak.upgrade() else { break };
                if let Ok(event) = serde_json::from_value::<Event>(value) {
                    if let Event::Found { id, people } = event {
                        if let Some(asker) = connector.searches.lock().unwrap_or_else(|p| p.into_inner()).remove(&id) {
                            let _ = asker.send(people);
                        }
                        line.clear();
                        continue;
                    }
                    if let Event::File { id, path } = event {
                        let waiters =
                            connector.downloads.lock().unwrap_or_else(|p| p.into_inner()).remove(&id).unwrap_or_default();
                        for waiter in waiters {
                            let _ = waiter.send(path.clone());
                        }
                        line.clear();
                        continue;
                    }
                    let revision = {
                        let mut snapshot = connector.snapshot.lock().unwrap_or_else(|p| p.into_inner());
                        snapshot.apply(event);
                        snapshot.revision
                    };
                    connector.revisions.send_replace(revision);
                }
                line.clear();
            }
            request = receiver.recv() => {
                let Some(request) = request else { break };
                let stopping = matches!(request, Request::Stop);
                let value = match request {
                    Request::Send { id, chat, text, reply } => {
                        json!({"type":"send","id":id,"chat":chat,"text":text,"reply":reply.unwrap_or_default()})
                    }
                    Request::Act { kind, id, text } => json!({"type":kind,"id":id,"text":text}),
                    Request::Read { chat } => json!({"type":"read","chat":chat}),
                    Request::Search { id, text } => json!({"type":"search","id":id,"text":text}),
                    Request::Download { id } => json!({"type":"download","id":id}),
                    Request::RejectCall { id } => json!({"type":"reject_call","id":id}),
                    Request::PairPhone { number } => json!({"type":"pair_phone","text":number}),
                    Request::Typing { chat, composing } => {
                        json!({"type":"typing","chat":chat,"text":if composing { "composing" } else { "paused" }})
                    }
                    Request::Presence { available } => {
                        json!({"type":"presence","text":if available { "available" } else { "unavailable" }})
                    }
                    Request::Upload(u) => json!({
                        "type":"upload","id":u.id,"chat":u.chat,"text":u.caption,"reply":u.reply.unwrap_or_default(),
                        "path":u.path,"mime":u.mime,"name":u.name,"voice":u.voice,
                    }),
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
        connector.revisions.send_replace(snapshot.revision);
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_link_preview_becomes_a_link_card_with_its_thumbnail_from_the_helper() {
        let m: WireMessage = serde_json::from_value(json!({
            "id":"a@s.whatsapp.net:L1","chat":"a@s.whatsapp.net","name":"a","sender":"a@s.whatsapp.net","author":"A",
            "text":"see https://example.org/a","ts":1,"mine":false,"link_url":"https://example.org/a",
            "link_title":"Example","link_description":"A page","link_image":true
        }))
        .unwrap();
        let previews = crate::content::link_previews(m.presentation().urls.as_deref(), 3);
        assert!(matches!(&previews[..], [crate::content::LinkPreview::Card { title: Some(t), image: Some(i), .. }]
            if t == "Example" && i == "wa-media:a@s.whatsapp.net:L1"));
        let video: WireMessage = serde_json::from_value(json!({
            "id":"a@s.whatsapp.net:V1","chat":"a@s.whatsapp.net","name":"a","sender":"a@s.whatsapp.net","author":"A",
            "text":"https://youtu.be/dQw4w9WgXcQ","ts":1,"mine":false,"link_url":"https://youtu.be/dQw4w9WgXcQ",
            "link_title":"A song","link_image":true
        }))
        .unwrap();
        let row = video.presentation();
        let links = crate::content::video_links(row.text.as_deref().unwrap(), row.urls.as_deref(), 3);
        assert_eq!(links[0].thumbnail.as_deref(), Some("wa-media:a@s.whatsapp.net:V1"));
        assert_eq!(links[0].title.as_deref(), Some("A song"));
        assert!(crate::content::link_previews(row.urls.as_deref(), 3).is_empty());
        let deleted: WireMessage = serde_json::from_value(json!({
            "id":"x","chat":"c","name":"c","sender":"s","author":"","text":"","ts":1,"mine":false,
            "deleted":true,"link_url":"https://example.org"
        }))
        .unwrap();
        assert!(deleted.presentation().urls.is_none());
    }
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
    fn names_reactions_and_avatars_reach_the_presentation() {
        let mut s = Snapshot::default();
        let wire = |value: serde_json::Value| serde_json::from_value::<Event>(value).unwrap();
        s.apply(wire(json!({"type":"message","message":{
            "id":"g@g.us:1","chat":"g@g.us","name":"g","sender":"33600000001@s.whatsapp.net","author":"",
            "text":"hello","ts":10,"mine":false
        }})));
        let m = s.messages["g@g.us:1"].clone();
        assert_eq!(s.presentation(&m).author.as_deref(), Some("+33600000001"));
        assert_eq!(s.chat_name(&m), "g");
        s.apply(wire(json!({"type":"names","names":{"g@g.us":"Les amis","33600000001@s.whatsapp.net":"Alice"}})));
        assert_eq!(s.presentation(&m).author.as_deref(), Some("Alice"));
        assert_eq!(s.chat_name(&m), "Les amis");
        s.apply(wire(json!({"type":"reaction","reaction":{"message":"g@g.us:1","sender":"me","emoji":"👍","ts":11}})));
        s.apply(wire(json!({"type":"reaction","reaction":{"message":"g@g.us:1","sender":"b","emoji":"👍","ts":12}})));
        let reactions = crate::actions::reactions(s.presentation(&m).reactions.as_deref(), "me");
        assert_eq!(reactions.len(), 1);
        assert_eq!((reactions[0].count, reactions[0].mine), (2, true));
        assert_eq!(reactions[0].people[0], ("b".to_owned(), "b".to_owned()));
        assert_eq!(reaction_glyph(&reactions[0].shortcode), "👍");
        s.apply(wire(json!({"type":"reaction","reaction":{"message":"g@g.us:1","sender":"me","emoji":"","ts":13}})));
        let reactions = crate::actions::reactions(s.presentation(&m).reactions.as_deref(), "me");
        assert_eq!((reactions[0].count, reactions[0].mine), (1, false));
        s.apply(wire(json!({"type":"avatar","jid":"g@g.us","data":"/9j/"})));
        assert_eq!(s.avatars.get("g@g.us").map(|a| a.len()), Some(3));
        s.apply(wire(json!({"type":"avatar","jid":"g@g.us","data":""})));
        assert!(s.avatars.is_empty());
        s.apply(wire(json!({"type":"account","jid":"33600000000@s.whatsapp.net","name":"Thomas"})));
        assert_eq!(s.account, Some(("33600000000@s.whatsapp.net".into(), "Thomas".into())));
        s.apply(wire(json!({"type":"chat","jid":"g@g.us","unread":3})));
        assert_eq!(s.unread.get("g@g.us"), Some(&3));
        s.apply(wire(json!({"type":"chat","jid":"g@g.us","unread":0})));
        assert!(s.unread.is_empty());
        s.apply(wire(json!({"type":"reload"})));
        assert!(s.messages.is_empty() && s.reactions.is_empty());
    }
    #[test]
    fn a_deleted_message_shows_as_deleted_and_an_edit_as_edited() {
        let m: WireMessage = serde_json::from_value(json!({
            "id":"c:1","chat":"c","name":"c","sender":"c","author":"","text":"","ts":1,"mine":false,"deleted":true
        }))
        .unwrap();
        assert_eq!(m.presentation().text.as_deref(), Some(crate::i18n::t("wa.deleted")));
        let m: WireMessage = serde_json::from_value(json!({
            "id":"c:1","chat":"c","name":"c","sender":"c","author":"","text":"new","ts":1,"mine":false,"edited":true
        }))
        .unwrap();
        assert!(m.presentation().edited);
    }
    #[test]
    fn a_reply_quotes_the_cached_message_and_the_composer_link_splits() {
        let mut s = Snapshot::default();
        let wire = |value: serde_json::Value| serde_json::from_value::<Event>(value).unwrap();
        s.apply(wire(json!({"type":"message","message":{
            "id":"a@s.whatsapp.net:1","chat":"a@s.whatsapp.net","name":"a","sender":"a@s.whatsapp.net",
            "author":"","text":"question","ts":1,"mine":false
        }})));
        s.apply(wire(json!({"type":"message","message":{
            "id":"a@s.whatsapp.net:2","chat":"a@s.whatsapp.net","name":"a","sender":"me","author":"",
            "text":"answer","ts":2,"mine":true,"reply_to":"a@s.whatsapp.net:1",
            "quote_sender":"a@s.whatsapp.net","quote_text":"old question"
        }})));
        let reply = s.messages["a@s.whatsapp.net:2"].clone();
        let quotes = crate::content::quotes(s.presentation(&reply).attachments.as_deref());
        assert_eq!(quotes.len(), 1);
        assert_eq!(quotes[0].text, "question");
        assert_eq!(quotes[0].author.as_deref(), Some("+a"));
        let text = crate::actions::quote(&format!("{REPLY_LINK}a@s.whatsapp.net:1"), "answer");
        assert_eq!(split_reply(&text), (Some("a@s.whatsapp.net:1".into()), "answer".into()));
        assert_eq!(split_reply("plain"), (None, "plain".into()));
    }
    #[test]
    fn a_whatsapp_account_round_trips_through_its_secret() {
        let info = account_info("ab12", "33600000000@s.whatsapp.net", "");
        assert_eq!(info.username, "+33600000000");
        assert!(is_whatsapp(&info));
        assert_eq!(info.genre(), "whatsapp");
        let back = crate::session::SessionInfo::from_secret(&info.secret()).expect("whatsapp secret");
        assert_eq!((back.base_url.as_str(), back.user_id.as_str()), ("whatsapp://ab12", "33600000000@s.whatsapp.net"));
        assert!(is_whatsapp(&back) && back.native.is_none() && back.mattermost.is_none());
        for bad in ["whatsapp://", "whatsapp://AB", "whatsapp://a/b", "https://whatsapp.example"] {
            assert!(state_id(bad).is_none(), "{bad}");
        }
        let mut forged = info.secret();
        forged["baseUrl"] = json!("https://chat.example");
        assert!(crate::session::SessionInfo::from_secret(&forged).is_none());
        assert_eq!(crate::supervisor::server_label(&info), "WhatsApp");
        let (path, key) = state_location(Path::new("/data"), PILOT_STATE);
        assert_eq!(
            (path, key.as_str()),
            (Path::new("/data/whatsapp-pilot/state.bin").into(), "whatsapp-pilot-storage-v1")
        );
        let (path, key) = state_location(Path::new("/data"), "ab12");
        assert_eq!(
            (path, key.as_str()),
            (Path::new("/data/whatsapp/ab12/state.bin").into(), "whatsapp-storage-v1|ab12")
        );
    }
    #[test]
    fn typing_shows_until_paused_or_a_message() {
        let mut s = Snapshot::default();
        let wire = |value: serde_json::Value| serde_json::from_value::<Event>(value).unwrap();
        s.apply(wire(json!({"type":"names","names":{"a@s.whatsapp.net":"Alice"}})));
        s.apply(wire(json!({"type":"typing","typing":{"chat":"a@s.whatsapp.net","sender":"a@s.whatsapp.net","state":"composing"}})));
        assert_eq!(s.typing_names("a@s.whatsapp.net"), vec!["Alice".to_owned()]);
        s.apply(wire(
            json!({"type":"typing","typing":{"chat":"a@s.whatsapp.net","sender":"a@s.whatsapp.net","state":"paused"}}),
        ));
        assert!(s.typing_names("a@s.whatsapp.net").is_empty());
        s.apply(wire(json!({"type":"typing","typing":{"chat":"a@s.whatsapp.net","sender":"a@s.whatsapp.net","state":"composing"}})));
        s.apply(wire(json!({"type":"message","message":{
            "id":"a@s.whatsapp.net:1","chat":"a@s.whatsapp.net","name":"a","sender":"a@s.whatsapp.net",
            "author":"","text":"hi","ts":1,"mine":false
        }})));
        assert!(s.typing_names("a@s.whatsapp.net").is_empty());
    }
    #[test]
    fn a_call_rings_until_it_ends() {
        let mut s = Snapshot::default();
        let wire = |value: serde_json::Value| serde_json::from_value::<Event>(value).unwrap();
        s.apply(wire(
            json!({"type":"call","call":{"id":"C1","from":"a@s.whatsapp.net","video":true,"state":"ringing"}}),
        ));
        assert!(s.calls["C1"].video);
        s.apply(wire(json!({"type":"call","call":{"id":"C1","from":"a@s.whatsapp.net","state":"ended"}})));
        assert!(s.calls.is_empty());
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
