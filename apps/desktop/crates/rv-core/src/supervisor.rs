//! Every signed-in account of the device stays connected, not only the one
//! on screen, so a message or a call on another account notifies at once.
//!
//! The supervisor holds one `Chat` per account (`key`): the open one, which
//! the UI also listens to, and the others in the background. Each account's
//! session keeps its own socket and reconnects on its own (Rocket.Chat's DDP,
//! Mattermost's or kChat's socket, the RocketVibe live socket); a session that
//! could not even start is started again with a back-off. A background
//! account subscribes to nothing more than its account-wide streams: rooms are
//! opened only on screen.
//!
//! A background account's events become `AccountNotice`s: its notifications
//! (already filtered by that account's rules), its ringing calls, its unread
//! state for the account switcher and the badge, and its expiry. The open
//! account's notifications and calls are left to the UI's own listener, so
//! nothing is announced twice.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::call_ring::IncomingCall;
use crate::notify::Incoming;
use crate::provider::{Chat, ChatEvent};
use crate::rooms::Badge;
use crate::session::{SessionEvent, SessionInfo};

/// How long the unread state waits for a burst of changes to settle.
const UNREAD_SETTLE: Duration = Duration::from_millis(300);
const MAX_START_DELAY: Duration = Duration::from_secs(300);

/// An account's key, as the keychain files spell it.
pub fn key(info: &SessionInfo) -> String {
    format!("{}|{}", info.base_url, info.user_id)
}

const NOTIFICATION_PREFIX: &str = "rv-account:";

/// The notification key of a background Rocket.Chat, Mattermost or kChat
/// account's room: the account and the room, hex-encoded since `|` separates
/// the arguments of a Windows notification's buttons.
pub fn notification_key(info: &SessionInfo, rid: &str) -> String {
    let account: String = key(info).bytes().map(|b| format!("{b:02x}")).collect();
    format!("{NOTIFICATION_PREFIX}{account}:{rid}")
}

/// The account key and the room of a `notification_key`.
pub fn notification_target(notification: &str) -> Option<(String, String)> {
    let (account, rid) = notification.strip_prefix(NOTIFICATION_PREFIX)?.split_once(':')?;
    if rid.is_empty() || account.len() % 2 != 0 || !account.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = (0..account.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&account[i..i + 2], 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    Some((String::from_utf8(bytes).ok()?, rid.to_owned()))
}

/// The server's host, which names a background account in what it shows.
pub fn server_label(info: &SessionInfo) -> String {
    if crate::whatsapp::is_whatsapp(info) {
        return "WhatsApp".into();
    }
    url::Url::parse(&info.base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_owned()))
        .unwrap_or_else(|| info.base_url.clone())
}

/// A background account's notification says which server it comes from:
/// after the person of a direct message, else after the room.
pub fn from_account(mut incoming: Incoming, info: &SessionInfo) -> Incoming {
    let server = server_label(info);
    if incoming.direct {
        incoming.author = format!("{} ({server})", incoming.author);
    } else {
        incoming.room_name = format!("{} ({server})", incoming.room_name);
    }
    incoming
}

/// Opens an account's session; called inside the runtime.
pub type Starter = Arc<dyn Fn(&SessionInfo) -> Result<Chat, String> + Send + Sync>;

/// A RocketVibe direct call ringing for me.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceCall {
    pub id: String,
    pub rid: String,
    pub caller: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    /// A message to notify.
    Incoming(Incoming),
    /// The Rocket.Chat or kChat call ringing on the account, or none any more.
    Call(Option<IncomingCall>),
    /// The RocketVibe voice ring for me, or none any more.
    Voice(Option<VoiceCall>),
    /// Its rooms' unread state, as the app's badge counts it.
    Unread(Badge),
    /// The server refused its token: it is stopped here and asks to sign in
    /// again once opened.
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountNotice {
    pub info: SessionInfo,
    pub notice: Notice,
}

impl AccountNotice {
    pub fn key(&self) -> String {
        key(&self.info)
    }
}

/// What a background or open account's event asks of the supervisor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Notify,
    Ring,
    Expire,
    Unread,
    Skip,
}

fn step(active: bool, event: &ChatEvent) -> Step {
    match event {
        ChatEvent::Incoming(_) | ChatEvent::Session(SessionEvent::Incoming(_)) if active => Step::Skip,
        ChatEvent::Incoming(_) | ChatEvent::Session(SessionEvent::Incoming(_)) => Step::Notify,
        ChatEvent::Session(SessionEvent::CallRing) if active => Step::Skip,
        ChatEvent::Session(SessionEvent::CallRing) => Step::Ring,
        ChatEvent::Session(SessionEvent::Expired) if active => Step::Skip,
        ChatEvent::Session(SessionEvent::Expired) => Step::Expire,
        ChatEvent::Changed(change) if change.rooms => Step::Unread,
        ChatEvent::Reload | ChatEvent::Rooms(_) => Step::Unread,
        _ => Step::Skip,
    }
}

fn start_delay(attempt: u32) -> Duration {
    Duration::from_millis(1000u64 << attempt.min(9)).min(MAX_START_DELAY)
}

/// The account's unread state, from its store.
pub fn badge(chat: &Chat) -> Badge {
    match chat {
        Chat::Legacy(session) => crate::rooms::badge(&session.store.rooms()),
        Chat::Native(session) => crate::rooms::badge(&session.room_rows().unwrap_or_default()),
        Chat::WhatsApp(session) => crate::rooms::badge(&session.room_rows()),
    }
}

/// The voice ring waiting for my answer on a RocketVibe account.
pub fn voice_call(session: &crate::native::NativeSession) -> Option<VoiceCall> {
    let me = &session.info.user_id;
    session.rings().into_iter().find(|r| &r.callee.id == me && r.state == rv_protocol::voice::RingState::Ringing).map(
        |r| VoiceCall {
            caller: if r.caller.display_name.is_empty() { r.caller.username } else { r.caller.display_name },
            id: r.id,
            rid: r.room_id,
        },
    )
}

fn closed(chat: &Chat) -> bool {
    match chat {
        Chat::Legacy(session) => session.is_closed(),
        Chat::Native(session) => session.is_closed(),
        Chat::WhatsApp(session) => session.is_closed(),
    }
}

fn shut(chat: &Chat) {
    match chat {
        Chat::Legacy(session) => session.shutdown(),
        Chat::Native(session) => session.shutdown(),
        // Stops the helper; the link stays for the account's return.
        Chat::WhatsApp(session) => session.shutdown(),
    }
}

struct Entry {
    info: SessionInfo,
    chat: Option<Chat>,
    /// Its watcher and event forwarder, or the loop starting it.
    tasks: Vec<JoinHandle<()>>,
}

impl Entry {
    fn abort(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }
}

struct Inner {
    handle: Handle,
    starter: Starter,
    entries: Mutex<HashMap<String, Entry>>,
    active: Mutex<Option<String>>,
    /// Counts `open`: the latest opening owns the screen.
    openings: AtomicU64,
    /// Refused tokens: not started again until the account is opened.
    expired: Mutex<HashSet<String>>,
    notices: mpsc::UnboundedSender<AccountNotice>,
}

#[derive(Clone)]
pub struct Supervisor(Arc<Inner>);

impl Supervisor {
    /// `handle` is the runtime the sessions run on; the notices come out of
    /// the receiver, from any account but the open one (`Unread` from all).
    pub fn new(handle: Handle, starter: Starter) -> (Self, mpsc::UnboundedReceiver<AccountNotice>) {
        let (notices, rx) = mpsc::unbounded_channel();
        let inner = Inner {
            handle,
            starter,
            entries: Mutex::default(),
            active: Mutex::default(),
            openings: AtomicU64::new(0),
            expired: Mutex::default(),
            notices,
        };
        (Supervisor(Arc::new(inner)), rx)
    }

    /// The account to show: its running session, else a new one. It becomes
    /// the open account, the previous one goes to the background.
    pub fn open(&self, info: &SessionInfo) -> Result<Chat, String> {
        self.open_counted(info).map(|(chat, _)| chat)
    }

    /// `open`, and which opening it was, for `leave`.
    pub fn open_counted(&self, info: &SessionInfo) -> Result<(Chat, u64), String> {
        let key = key(info);
        self.0.expired.lock().unwrap().remove(&key);
        let chat = {
            let mut entries = self.0.entries.lock().unwrap();
            match entries.get(&key).and_then(|e| e.chat.clone()).filter(|c| !closed(c)) {
                Some(chat) => {
                    if let Chat::Native(session) = &chat
                        && session.is_suspended()
                    {
                        session.reconnect();
                    }
                    chat
                }
                None => {
                    if let Some(mut stale) = entries.remove(&key) {
                        stale.abort();
                        if let Some(chat) = stale.chat {
                            shut(&chat);
                        }
                    }
                    let chat = {
                        let _guard = self.0.handle.enter();
                        (self.0.starter)(info)?
                    };
                    let tasks = Inner::watch(&self.0, &key, info, &chat);
                    entries.insert(key.clone(), Entry { info: info.clone(), chat: Some(chat.clone()), tasks });
                    chat
                }
            }
        };
        let mut active = self.0.active.lock().unwrap();
        let opening = self.0.openings.fetch_add(1, Ordering::SeqCst) + 1;
        let previous = active.replace(key.clone());
        drop(active);
        self.left(previous, Some(&key));
        Ok((chat, opening))
    }

    /// The screen that `opening` gave the account closes; nothing changes if
    /// an account, even the same one, was opened since.
    pub fn leave(&self, opening: u64) {
        let mut active = self.0.active.lock().unwrap();
        if self.0.openings.load(Ordering::SeqCst) != opening {
            return;
        }
        let previous = active.take();
        drop(active);
        self.left(previous, None);
    }

    /// Which account is on screen; None while none is (the sign-in form).
    /// The one leaving it stops hearing its open room and leaves its voice session.
    pub fn set_active(&self, key: Option<&str>) {
        let previous = std::mem::replace(&mut *self.0.active.lock().unwrap(), key.map(str::to_owned));
        self.left(previous, key);
    }

    fn left(&self, previous: Option<String>, key: Option<&str>) {
        let Some(previous) = previous.filter(|p| Some(p.as_str()) != key) else { return };
        let chat = self.0.entries.lock().unwrap().get(&previous).and_then(|e| e.chat.clone());
        match chat {
            Some(Chat::Legacy(session)) => session.close_room(),
            Some(Chat::Native(session)) if session.voice().snapshot().room.is_some() => {
                self.0.handle.spawn(async move { session.disconnect_voice().await });
            }
            _ => {}
        }
    }

    pub fn active(&self) -> Option<String> {
        self.0.active.lock().unwrap().clone()
    }

    pub fn is_active(&self, key: &str) -> bool {
        self.0.active.lock().unwrap().as_deref() == Some(key)
    }

    /// Every signed-in account connected: the missing ones start in the
    /// background, those no longer signed in stop (never the open one).
    pub fn sync(&self, accounts: &[SessionInfo]) {
        let keys: HashSet<String> = accounts.iter().map(key).collect();
        let active = self.active();
        let gone: Vec<Chat> = {
            let mut entries = self.0.entries.lock().unwrap();
            let stale: Vec<String> = entries
                .keys()
                .filter(|k| !keys.contains(*k) && active.as_deref() != Some(k.as_str()))
                .cloned()
                .collect();
            stale
                .into_iter()
                .filter_map(|k| {
                    let mut entry = entries.remove(&k)?;
                    entry.abort();
                    entry.chat
                })
                .collect()
        };
        for chat in gone {
            shut(&chat);
        }
        self.0.expired.lock().unwrap().retain(|k| keys.contains(k));
        for info in accounts {
            let key = key(info);
            if self.0.expired.lock().unwrap().contains(&key) {
                continue;
            }
            let mut entries = self.0.entries.lock().unwrap();
            if entries.contains_key(&key) {
                continue;
            }
            let task = self.0.handle.spawn(Inner::start(Arc::downgrade(&self.0), key.clone(), info.clone()));
            entries.insert(key, Entry { info: info.clone(), chat: None, tasks: vec![task] });
        }
    }

    /// Takes the account out (signed out, expired): the caller shuts its session down.
    pub fn remove(&self, key: &str) -> Option<Chat> {
        let mut active = self.0.active.lock().unwrap();
        if active.as_deref() == Some(key) {
            *active = None;
        }
        drop(active);
        let mut entry = self.0.entries.lock().unwrap().remove(key)?;
        entry.abort();
        entry.chat
    }

    /// The account's running session, open or in the background.
    pub fn chat(&self, key: &str) -> Option<Chat> {
        self.0.entries.lock().unwrap().get(key).and_then(|e| e.chat.clone())
    }

    /// The accounts with a running session.
    pub fn running(&self) -> Vec<SessionInfo> {
        self.0.entries.lock().unwrap().values().filter(|e| e.chat.is_some()).map(|e| e.info.clone()).collect()
    }

    /// Every session stops: the app is quitting.
    pub fn shutdown(&self) {
        *self.0.active.lock().unwrap() = None;
        let entries: Vec<Entry> = self.0.entries.lock().unwrap().drain().map(|(_, e)| e).collect();
        for mut entry in entries {
            entry.abort();
            if let Some(chat) = entry.chat {
                shut(&chat);
            }
        }
    }
}

impl Inner {
    fn is_active(&self, key: &str) -> bool {
        self.active.lock().unwrap().as_deref() == Some(key)
    }

    fn send(&self, info: &SessionInfo, notice: Notice) {
        let _ = self.notices.send(AccountNotice { info: info.clone(), notice });
    }

    /// Starts an account in the background, again and again until it starts.
    async fn start(inner: Weak<Inner>, key: String, info: SessionInfo) {
        let mut attempt = 0;
        loop {
            let Some(this) = inner.upgrade() else { return };
            {
                let mut entries = this.entries.lock().unwrap();
                match entries.get(&key) {
                    Some(entry) if entry.chat.is_none() => {}
                    _ => return,
                }
                if let Ok(chat) = (this.starter)(&info) {
                    let tasks = Inner::watch(&this, &key, &info, &chat);
                    // This loop's own handle is dropped, not aborted: it ends here.
                    entries.insert(key, Entry { info, chat: Some(chat), tasks });
                    return;
                }
            }
            drop(this);
            tokio::time::sleep(start_delay(attempt)).await;
            attempt += 1;
        }
    }

    fn watch(this: &Arc<Inner>, key: &str, info: &SessionInfo, chat: &Chat) -> Vec<JoinHandle<()>> {
        let _guard = this.handle.enter();
        let (events, forward) = chat.events();
        let watcher =
            this.handle.spawn(Inner::hear(Arc::downgrade(this), key.to_owned(), info.clone(), chat.clone(), events));
        vec![watcher, forward]
    }

    async fn hear(
        inner: Weak<Inner>,
        key: String,
        info: SessionInfo,
        chat: Chat,
        mut events: mpsc::Receiver<ChatEvent>,
    ) {
        let mut shown: Option<Badge> = None;
        let mut ringing: Option<VoiceCall> = None;
        let mut dirty = true;
        loop {
            let event = if dirty {
                tokio::select! {
                    event = events.recv() => event,
                    () = tokio::time::sleep(UNREAD_SETTLE) => {
                        dirty = false;
                        let now = badge(&chat);
                        if shown != Some(now) {
                            shown = Some(now);
                            let Some(this) = inner.upgrade() else { return };
                            this.send(&info, Notice::Unread(now));
                        }
                        continue;
                    }
                }
            } else {
                events.recv().await
            };
            let Some(event) = event else { return };
            let Some(this) = inner.upgrade() else { return };
            let active = this.is_active(&key);
            let rooms_moved = step(false, &event) == Step::Unread;
            match step(active, &event) {
                Step::Notify => {
                    if let ChatEvent::Incoming(incoming) = event {
                        this.send(&info, Notice::Incoming(incoming));
                    } else if let ChatEvent::Session(SessionEvent::Incoming(incoming)) = event {
                        this.send(&info, Notice::Incoming(*incoming));
                    }
                }
                Step::Ring => {
                    if let Chat::Legacy(session) = &chat {
                        this.send(&info, Notice::Call(session.incoming_call()));
                    }
                }
                Step::Expire => {
                    this.send(&info, Notice::Expired);
                    this.expired.lock().unwrap().insert(key.clone());
                    let entry = this.entries.lock().unwrap().remove(&key);
                    shut(&chat);
                    if let Some(entry) = entry {
                        // The first is this very task: it ends here.
                        entry.tasks.into_iter().skip(1).for_each(|t| t.abort());
                    }
                    return;
                }
                Step::Unread => dirty = true,
                Step::Skip => {}
            }
            if let Chat::Native(session) = &chat
                && rooms_moved
            {
                let now = if active { None } else { voice_call(session) };
                if now != ringing {
                    let announce = !active || ringing.is_some();
                    ringing = now.clone();
                    if announce {
                        this.send(&info, Notice::Voice(now));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Change;

    #[test]
    fn the_open_account_leaves_its_notifications_and_calls_to_the_ui() {
        let incoming = ChatEvent::Incoming(Incoming::default());
        assert_eq!(step(true, &incoming), Step::Skip);
        assert_eq!(step(false, &incoming), Step::Notify);
        let ring = ChatEvent::Session(SessionEvent::CallRing);
        assert_eq!(step(true, &ring), Step::Skip);
        assert_eq!(step(false, &ring), Step::Ring);
        let expired = ChatEvent::Session(SessionEvent::Expired);
        assert_eq!(step(true, &expired), Step::Skip, "the UI signs the open account out itself");
        assert_eq!(step(false, &expired), Step::Expire);
    }

    #[test]
    fn room_changes_move_the_unread_state_of_every_account() {
        let rooms = ChatEvent::Changed(Change { rooms: true, rids: Default::default() });
        let messages = ChatEvent::Changed(Change { rooms: false, rids: ["r".to_owned()].into() });
        for active in [true, false] {
            assert_eq!(step(active, &rooms), Step::Unread);
            assert_eq!(step(active, &messages), Step::Skip);
            assert_eq!(step(active, &ChatEvent::Reload), Step::Unread);
            assert_eq!(step(active, &ChatEvent::Rooms(vec![])), Step::Unread);
            assert_eq!(step(active, &ChatEvent::Session(SessionEvent::Presence)), Step::Skip);
        }
    }

    #[test]
    fn a_failed_start_waits_longer_each_time_up_to_five_minutes() {
        assert_eq!(start_delay(0), Duration::from_secs(1));
        assert_eq!(start_delay(3), Duration::from_secs(8));
        assert_eq!(start_delay(20), MAX_START_DELAY);
    }

    #[test]
    fn a_notification_key_finds_its_account_and_room_again() {
        let info = SessionInfo {
            base_url: "https://chat.example:8443/team/".into(),
            user_id: "u|1".into(),
            username: "me".into(),
            auth_token: "t".into(),
            native: None,
            mattermost: None,
        };
        let notification = notification_key(&info, "room:1");
        assert!(!notification.contains('|'), "Windows splits its arguments on |");
        assert_eq!(notification_target(&notification), Some((key(&info), "room:1".to_owned())));
        assert_eq!(notification_target("rv-account:zz:r"), None);
        assert_eq!(notification_target("rv-account:616:r"), None);
        assert_eq!(notification_target("rv-account:61:"), None);
        assert_eq!(notification_target("r1"), None);
    }

    #[test]
    fn a_background_notification_names_its_server() {
        let info = SessionInfo {
            base_url: "https://www.chat.example/".into(),
            user_id: "u".into(),
            username: "me".into(),
            auth_token: "t".into(),
            native: None,
            mattermost: None,
        };
        let dm = Incoming { author: "Ana".into(), room_name: "ana".into(), direct: true, ..Default::default() };
        assert_eq!(from_account(dm, &info).author, "Ana (chat.example)");
        let room = Incoming { author: "Ana".into(), room_name: "general".into(), ..Default::default() };
        let room = from_account(room, &info);
        assert_eq!((room.author.as_str(), room.room_name.as_str()), ("Ana", "general (chat.example)"));
    }

    fn native_account() -> (Supervisor, SessionInfo) {
        let info = SessionInfo {
            base_url: "http://127.0.0.1:9/native".into(),
            user_id: "u1".into(),
            username: "me".into(),
            auth_token: "t".into(),
            native: Some(crate::native::Identity { instance_id: "i".into(), data_epoch: "e".into() }),
            mattermost: None,
        };
        let path = std::env::temp_dir().join(format!("rv-supervisor-{:032x}.sqlite", fastrand::u128(..)));
        let starter: Starter = Arc::new(move |info: &SessionInfo| {
            crate::native::NativeSession::start(info.clone(), &path).map(Chat::from).map_err(|e| e.to_string())
        });
        (Supervisor::new(Handle::current(), starter).0, info)
    }

    #[tokio::test]
    async fn opening_a_suspended_account_connects_it_again() {
        let (accounts, info) = native_account();
        let Ok(Chat::Native(first)) = accounts.open(&info) else { panic!("a native session") };
        first.suspend();
        assert!(first.is_suspended());
        let Ok(Chat::Native(again)) = accounts.open(&info) else { panic!("a native session") };
        assert!(Arc::ptr_eq(&first, &again), "the running session is reused");
        assert!(!again.is_suspended());
        accounts.shutdown();
        assert!(!first.is_suspended(), "a closed session is not suspended");
    }

    #[tokio::test]
    async fn the_screen_left_behind_by_a_reopening_does_not_close_the_account() {
        let (accounts, info) = native_account();
        let (_, first) = accounts.open_counted(&info).unwrap();
        let (_, second) = accounts.open_counted(&info).unwrap();
        accounts.leave(first);
        assert!(accounts.is_active(&key(&info)));
        accounts.leave(second);
        assert_eq!(accounts.active(), None);
        accounts.shutdown();
    }

    #[test]
    fn keys_match_the_keychain_files() {
        let info = SessionInfo {
            base_url: "https://chat.example/".into(),
            user_id: "u1".into(),
            username: "me".into(),
            auth_token: "t".into(),
            native: None,
            mattermost: None,
        };
        assert_eq!(key(&info), "https://chat.example/|u1");
    }
}
