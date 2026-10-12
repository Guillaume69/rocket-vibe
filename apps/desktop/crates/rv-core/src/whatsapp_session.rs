//! A WhatsApp account as the apps hold it: the helper kept alive (restarted
//! with back-off, its state lock waited for), the conversations and timeline
//! built from its snapshot, notifications, sends whose text comes back only
//! when it provably never left, and the end of the link (unlinked from the
//! phone, or here).
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use tokio::sync::{broadcast, watch};

use crate::notify::Incoming;
use crate::session::{Connection, SessionInfo};
use crate::store::RoomRow;
use crate::timeline::Display;
use crate::whatsapp::{self, Connector, Snapshot, WireMessage};

/// Fetches (or makes, when no state exists yet) the key of a keychain entry.
pub type KeySource =
    Arc<dyn Fn(String, bool) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> + Send + Sync>;

/// Messages older than this when the helper connected were missed offline:
/// listed, not notified.
const NOTIFY_WINDOW_MS: i64 = 120_000;
const RESTART_MAX: Duration = Duration::from_secs(60);

/// What the account tells beyond its revisions.
#[derive(Debug, Clone)]
pub enum Notice {
    Incoming(Box<Incoming>),
    /// The device is no longer linked (removed from the phone, or another
    /// account behind its state): the account is over.
    Expired,
}

/// Connectors a sign-in already started, waiting for their account to adopt
/// them instead of starting a second helper on the same state.
fn handoffs() -> &'static Mutex<HashMap<String, Arc<Connector>>> {
    static HANDOFFS: OnceLock<Mutex<HashMap<String, Arc<Connector>>>> = OnceLock::new();
    HANDOFFS.get_or_init(Mutex::default)
}
pub fn handoff(state: &str, connector: Arc<Connector>) {
    handoffs().lock().unwrap_or_else(|p| p.into_inner()).insert(state.to_owned(), connector);
}

#[derive(Default)]
struct Local {
    /// WhatsApp ids already seen (the part after the chat): not notified again,
    /// whatever re-keying or replay brings them back.
    seen: Option<HashSet<String>>,
    loaded_at: i64,
    /// One send in flight per chat: (id, text).
    pending: BTreeMap<String, (String, String)>,
    /// Sends of a helper that was replaced, settled once the new one replayed.
    orphans: BTreeMap<String, (String, String)>,
    /// Texts of sends that never left, to give back as drafts.
    returned: Vec<(String, String)>,
    /// Sends whose outcome the helper's exit left unknown.
    uncertain: usize,
    read_sent: Option<(String, u32)>,
    rooms: Option<(u64, Arc<Vec<RoomRow>>)>,
    drafts: HashMap<String, String>,
    expired: bool,
}

pub struct WaSession {
    pub info: SessionInfo,
    state: String,
    connector: Mutex<Option<Arc<Connector>>>,
    local: Mutex<Local>,
    revisions: watch::Sender<u64>,
    notices: broadcast::Sender<Notice>,
    closed: AtomicBool,
}

impl WaSession {
    /// Starts the account's helper in the background; returns at once. Must
    /// run inside a tokio runtime.
    pub fn start(info: SessionInfo, program: PathBuf, data_dir: PathBuf, keys: KeySource) -> Arc<Self> {
        let state = whatsapp::state_id(&info.base_url).unwrap_or_default().to_owned();
        let this = Arc::new(Self {
            info,
            state,
            connector: Mutex::default(),
            local: Mutex::default(),
            revisions: watch::Sender::new(0),
            notices: broadcast::channel(64).0,
            closed: AtomicBool::new(false),
        });
        tokio::spawn(run(Arc::downgrade(&this), program, data_dir, keys));
        this
    }
    fn local(&self) -> std::sync::MutexGuard<'_, Local> {
        self.local.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn connector(&self) -> Option<Arc<Connector>> {
        self.connector.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    pub fn snapshot(&self) -> Snapshot {
        self.connector().map(|c| c.snapshot()).unwrap_or_default()
    }
    /// A revision per change of what the account shows.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.revisions.subscribe()
    }
    pub fn notices(&self) -> broadcast::Receiver<Notice> {
        self.notices.subscribe()
    }
    fn bump(&self) {
        self.revisions.send_modify(|r| *r += 1);
    }
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
    /// Stops the helper, keeping the link: the account comes back as it was.
    pub fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(connector) = self.connector() {
            connector.stop();
        }
        self.bump();
    }
    /// Waits, up to `limit`, for the helper to checkpoint and exit.
    pub async fn exited(&self, limit: Duration) {
        let Some(connector) = self.connector() else { return };
        let mut changes = connector.subscribe();
        let _ = tokio::time::timeout(limit, async {
            while !connector.exited() {
                if changes.changed().await.is_err() {
                    return;
                }
            }
        })
        .await;
    }
    pub fn connection(&self) -> Connection {
        match self.snapshot().state.as_str() {
            "connected" => Connection::Online,
            "connecting" | "paired" | "loaded" => Connection::Connecting,
            _ if self.connector().is_none() && !self.is_closed() => Connection::Connecting,
            _ => Connection::Offline,
        }
    }
    /// Unlinks the device from the account (the phone forgets it), then ends.
    /// A failure keeps the account: removing it here alone is not an unlink.
    pub async fn unlink(&self) -> Result<(), String> {
        let connector = self.connector().ok_or("connector_unavailable")?;
        let mut changes = connector.subscribe();
        connector.logout()?;
        let outcome = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let s = connector.snapshot();
                if s.state == "logged_out" {
                    return Ok(());
                }
                if s.error.as_deref() == Some("logout_failed") || s.exited {
                    return Err("logout_failed".to_owned());
                }
                if changes.changed().await.is_err() {
                    return Err("logout_failed".to_owned());
                }
            }
        })
        .await
        .unwrap_or_else(|_| Err("logout_failed".into()));
        if outcome.is_ok() {
            self.closed.store(true, Ordering::SeqCst);
            self.local().expired = true;
        }
        outcome
    }

    /// The conversations, newest activity first, as the room list draws them.
    pub fn room_rows(&self) -> Arc<Vec<RoomRow>> {
        let s = self.snapshot();
        if let Some((revision, rows)) = &self.local().rooms
            && *revision == s.revision
        {
            return rows.clone();
        }
        let mut last: BTreeMap<&str, &WireMessage> = BTreeMap::new();
        for m in s.messages.values() {
            let entry = last.entry(m.chat.as_str()).or_insert(m);
            if (m.ts, &m.id) > (entry.ts, &entry.id) {
                *entry = m;
            }
        }
        let mut rows: Vec<RoomRow> = last
            .into_values()
            .map(|m| {
                let group = m.chat.ends_with("@g.us");
                let unread = i64::from(s.unread.get(&m.chat).copied().unwrap_or(0));
                RoomRow {
                    rid: m.chat.clone(),
                    kind: if group { "p" } else { "d" }.into(),
                    name: s.chat_name(m),
                    last_message: Some(if m.deleted {
                        crate::i18n::t("wa.deleted").to_owned()
                    } else {
                        m.text.clone()
                    }),
                    last_ts: m.ts,
                    unread,
                    alert: unread > 0,
                    last_author: group.then(|| s.presentation(m).author.unwrap_or_default()),
                    // Moves when the photo does, so a changed photo redraws its row.
                    avatar_etag: s.avatars.get(&m.chat).map(|photo| format!("{}:{:p}", photo.len(), photo.as_ptr())),
                    ..Default::default()
                }
            })
            .collect();
        rows.sort_by(|a, b| b.last_ts.cmp(&a.last_ts).then(a.rid.cmp(&b.rid)));
        let rows = Arc::new(rows);
        self.local().rooms = Some((s.revision, rows.clone()));
        rows
    }
    /// A chat's messages as the timeline draws them; my latest settled
    /// message says how far it went, an uncertain one says so.
    pub fn timeline(&self, chat: &str) -> Vec<Display> {
        let s = self.snapshot();
        let mut messages: Vec<&WireMessage> = s.messages.values().filter(|m| m.chat == chat).collect();
        messages.sort_by_key(|m| (m.ts, &m.id));
        let receipt = messages
            .iter()
            .rev()
            .find(|m| m.mine && m.status.is_empty() && !m.deleted)
            .map(|m| (m.id.clone(), m.receipt.clone()));
        let mut rows = crate::timeline::group(messages.into_iter().map(|m| s.presentation(m)).collect());
        for row in &mut rows {
            if row.row.outbox_status.as_deref() == Some("uncertain") {
                row.seen = Some(crate::i18n::t("wa.send_uncertain").into());
            } else if let Some((id, state)) = &receipt
                && *id == row.row.id
                && !state.is_empty()
            {
                row.seen = Some(crate::i18n::t(&format!("wa.{state}")).into());
            }
        }
        rows
    }
    pub fn chat_name(&self, chat: &str) -> String {
        let s = self.snapshot();
        s.name_of(chat).map(str::to_owned).unwrap_or_else(|| whatsapp::fallback_name(chat))
    }
    /// A photo's JPEG bytes, by JID.
    pub fn photo(&self, jid: &str) -> Option<Arc<[u8]>> {
        self.snapshot().avatars.get(jid).cloned()
    }

    /// Sends a text; one send in flight per chat.
    pub fn send(&self, chat: &str, text: &str, reply: Option<String>) -> Result<(), String> {
        if self.local().pending.contains_key(chat) {
            return Err("send_pending".into());
        }
        let connector = self.connector().ok_or("not_connected")?;
        let id = connector.send(chat.to_owned(), text.to_owned(), reply)?;
        self.local().pending.insert(chat.to_owned(), (id, text.to_owned()));
        self.bump();
        Ok(())
    }
    pub fn sending(&self, chat: &str) -> bool {
        self.local().pending.contains_key(chat)
    }
    /// Texts of sends that never left, to put back in their chat's composer.
    pub fn returned_drafts(&self) -> Vec<(String, String)> {
        std::mem::take(&mut self.local().returned)
    }
    /// How many sends a helper exit left unconfirmed since the last call.
    pub fn take_uncertain(&self) -> usize {
        std::mem::take(&mut self.local().uncertain)
    }
    pub fn react(&self, id: &str, glyph: String) -> Result<(), String> {
        self.connector().ok_or("not_connected")?.react(id.to_owned(), glyph)
    }
    pub fn edit(&self, id: &str, text: String) -> Result<(), String> {
        self.connector().ok_or("not_connected")?.edit(id.to_owned(), text)
    }
    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.connector().ok_or("not_connected")?.delete(id.to_owned())
    }
    /// Reads a chat once per unread count, when the account is connected.
    pub fn mark_read(&self, chat: &str) {
        let s = self.snapshot();
        let count = s.unread.get(chat).copied().unwrap_or(0);
        if count == 0 || s.state != "connected" {
            return;
        }
        let key = Some((chat.to_owned(), count));
        if self.local().read_sent == key {
            return;
        }
        if let Some(connector) = self.connector()
            && connector.mark_read(chat.to_owned()).is_ok()
        {
            self.local().read_sent = key;
        }
    }
    pub fn draft(&self, chat: &str) -> String {
        self.local().drafts.get(chat).cloned().unwrap_or_default()
    }
    pub fn set_draft(&self, chat: &str, text: &str) {
        let mut local = self.local();
        if text.trim().is_empty() {
            local.drafts.remove(chat);
        } else {
            local.drafts.insert(chat.to_owned(), text.to_owned());
        }
    }
    /// What a WhatsApp chat offers, by the names `NativeSession::supports` uses.
    pub fn supports(feature: &str) -> bool {
        matches!(feature, "reply" | "react" | "edit" | "delete" | "read")
    }

    /// Settles the sends, notices new messages and the end of the link after a change.
    fn observe(&self, s: &Snapshot) {
        let mut notices = Vec::new();
        {
            let mut guard = self.local();
            let local = &mut *guard;
            if s.loaded {
                let orphans = std::mem::take(&mut local.orphans);
                for (chat, (id, text)) in orphans {
                    if !s.messages.contains_key(&format!("{chat}:{id}")) {
                        local.returned.push((chat, text));
                    }
                }
            }
            let pending = std::mem::take(&mut local.pending);
            for (chat, (id, text)) in pending {
                match s.messages.get(&format!("{chat}:{id}")) {
                    Some(m) if m.status != "sending" => {}
                    None if s.refused.as_deref() == Some(id.as_str()) || s.exited => local.returned.push((chat, text)),
                    Some(_) if s.exited => local.uncertain += 1,
                    _ => {
                        local.pending.insert(chat, (id, text));
                    }
                }
            }
            // The first replay is what was there before: seen, not notified.
            if s.loaded {
                match local.seen.as_mut() {
                    None => {
                        local.seen = Some(s.messages.values().map(|m| wa_id(&m.id).to_owned()).collect());
                        local.loaded_at = chrono::Utc::now().timestamp_millis();
                    }
                    Some(seen) => {
                        let loaded_at = local.loaded_at;
                        for m in s.messages.values() {
                            if !seen.insert(wa_id(&m.id).to_owned()) {
                                continue;
                            }
                            if m.mine || m.deleted || !m.status.is_empty() || m.ts < loaded_at - NOTIFY_WINDOW_MS {
                                continue;
                            }
                            let row = s.presentation(m);
                            notices.push(Notice::Incoming(Box::new(Incoming {
                                rid: m.chat.clone(),
                                id: m.id.clone(),
                                author: row.author.unwrap_or_default(),
                                room_name: s.chat_name(m),
                                direct: !m.chat.ends_with("@g.us"),
                                body: Some(m.text.clone()),
                                mentions_me: false,
                                avatar: None,
                                image: None,
                            })));
                        }
                    }
                }
            }
            let unlinked = s.state == "logged_out"
                || s.qr.is_some()
                || s.account.as_ref().is_some_and(|(jid, _)| *jid != self.info.user_id);
            if unlinked && !local.expired {
                local.expired = true;
                notices.push(Notice::Expired);
            }
        }
        for notice in notices {
            let _ = self.notices.send(notice);
        }
        self.bump();
    }
    fn replaced(&self) {
        let mut local = self.local();
        let pending = std::mem::take(&mut local.pending);
        local.orphans.extend(pending);
        local.read_sent = None;
    }
}

/// A message's WhatsApp id, without its chat: stable when a LID is re-keyed.
fn wa_id(id: &str) -> &str {
    id.split_once(':').map_or(id, |(_, wa)| wa)
}

/// Keeps the helper running until the account closes or the link ends.
async fn run(weak: Weak<WaSession>, program: PathBuf, data_dir: PathBuf, keys: KeySource) {
    let mut backoff = Duration::from_secs(2);
    loop {
        let Some(this) = weak.upgrade() else { return };
        if this.is_closed() || this.local().expired {
            return;
        }
        let adopted = handoffs().lock().unwrap_or_else(|p| p.into_inner()).remove(&this.state);
        let connector = match adopted {
            Some(connector) => Ok(connector),
            None => {
                let (path, entry) = whatsapp::state_location(&data_dir, &this.state);
                if !path.exists() {
                    // The state went away: nothing left to link with.
                    this.local().expired = true;
                    let _ = this.notices.send(Notice::Expired);
                    this.bump();
                    return;
                }
                match keys(entry, true).await {
                    Ok(key) => Connector::start(&program, &path, key).await,
                    Err(e) => Err(e),
                }
            }
        };
        let connector = match connector {
            Ok(connector) => connector,
            Err(_) => {
                drop(this);
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(RESTART_MAX);
                continue;
            }
        };
        if this.is_closed() {
            connector.stop();
            return;
        }
        this.replaced();
        *this.connector.lock().unwrap_or_else(|p| p.into_inner()) = Some(connector.clone());
        let mut changes = connector.subscribe();
        drop(this);
        loop {
            let s = connector.snapshot();
            let Some(this) = weak.upgrade() else {
                connector.stop();
                return;
            };
            this.observe(&s);
            if s.state == "connected" {
                backoff = Duration::from_secs(2);
            }
            if s.exited || this.is_closed() {
                break;
            }
            drop(this);
            if changes.changed().await.is_err() {
                break;
            }
        }
        // Exited: wait for it to be over, then a new helper unless the account ended.
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RESTART_MAX);
    }
}
