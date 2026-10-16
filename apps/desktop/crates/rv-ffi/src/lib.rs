//! rv-core for Swift, through UniFFI: the macOS app's view of a session.
//! Every future runs on this crate's tokio runtime, whatever polls it.

pub mod account_menu;
mod accounts;
pub mod activity;
mod admin;
mod background;
mod context;
mod links;
pub mod markup;
pub mod model;
mod native;
mod native_auth;
mod native_bots;
mod native_crypto;
mod native_emojis;
mod native_files;
mod native_profiles;
mod native_recovery;
mod native_rooms;
mod native_scheduled;
mod native_security;
mod native_voice;
mod native_workflows;
pub mod people;
mod reactions;
mod reminders;
pub mod rocket_chat;
pub mod room_members;
mod slack;
pub mod social;
mod teams;
pub mod writing;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use rv_core::session::{self, Connection, Session, SessionEvent, SessionInfo};
use rv_core::timeline;
use tokio::sync::broadcast::error::RecvError;

use crate::accounts::Dirs;
use crate::model::*;

uniffi::setup_scaffolding!();

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime")
    })
}

async fn on_tokio<F>(future: F) -> F::Output
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    runtime().spawn(future).await.expect("tokio task")
}

async fn blocking<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
    runtime().spawn_blocking(f).await.expect("blocking task")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ConnectionState {
    Offline,
    Connecting,
    Online,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Incoming {
    pub rid: String,
    pub id: String,
    pub author: String,
    pub room_name: String,
    pub direct: bool,
    pub body: Option<String>,
    pub mentions_me: bool,
}

/// A call started by the other member of a direct room, ringing here.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RingingCall {
    pub rid: String,
    pub call_id: String,
    pub caller_id: String,
    pub caller_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum Event {
    /// What the store holds changed: the room list, and those rooms' messages.
    Changed {
        rooms: bool,
        rids: Vec<String>,
    },
    /// Changes were missed: read everything again.
    Resync,
    Connection {
        state: ConnectionState,
    },
    /// The server refused the token: the account is signed out and forgotten.
    Expired,
    Typing {
        rid: String,
    },
    Presence,
    Upload {
        rid: String,
    },
    Avatar,
    E2e,
    Incoming {
        incoming: Incoming,
    },
    /// What the server told me alone in a room: a slash command's answer.
    PrivateNote {
        rid: String,
        text: String,
    },
    /// The voice session, the rings or the listening choices moved (Vibez).
    Voice,
    /// The call ringing here changed: `Chat::incoming_call`.
    CallRing,
}

#[uniffi::export(with_foreign)]
pub trait Listener: Send + Sync {
    /// Called on a tokio thread.
    fn on_event(&self, event: Event);
}

#[derive(uniffi::Object)]
pub struct Client {
    dirs: Arc<Dirs>,
    /// Every signed-in account's session, the open one and the others.
    accounts: rv_core::supervisor::Supervisor,
    notices: Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<rv_core::supervisor::AccountNotice>>>,
}

#[uniffi::export]
impl Client {
    /// `home`: where GLib would put its user directories, for sessions shared with the GTK app.
    #[uniffi::constructor]
    pub fn new(home: String) -> Arc<Self> {
        let dirs = Arc::new(Dirs::glib(std::path::Path::new(&home)));
        // Sign-outs an earlier run could not tell the server about.
        let pending = dirs.clone();
        runtime().spawn(async move {
            let entries = blocking({
                let dirs = pending.clone();
                move || accounts::pending_logouts(&dirs)
            })
            .await;
            for (key, info) in entries {
                if Session::replay_logout(&info).await {
                    let dirs = pending.clone();
                    blocking(move || accounts::forget_logout(&dirs, &key)).await;
                }
            }
        });
        Arc::new(Client::with_dirs(dirs))
    }

    /// Where the apps keep their small preferences (language, folded sections).
    pub fn config_dir(&self) -> String {
        let _ = std::fs::create_dir_all(&self.dirs.config);
        self.dirs.config.to_string_lossy().into_owned()
    }

    /// For files the app makes before sending them (voice, pasted pictures).
    pub fn cache_dir(&self) -> String {
        let _ = std::fs::create_dir_all(&self.dirs.cache);
        self.dirs.cache.to_string_lossy().into_owned()
    }

    pub fn known_servers(&self) -> Vec<String> {
        accounts::known_servers(&self.dirs)
    }

    /// The room list's folded sections of an account (`Account::key`).
    pub fn collapsed_sections(&self, account: String) -> Vec<String> {
        rv_core::collapsed_sections::load(&self.dirs.config, &account)
    }

    pub fn toggle_collapsed_section(&self, account: String, section: String) -> Vec<String> {
        rv_core::collapsed_sections::toggle(&self.dirs.config, &account, &section)
    }

    /// The room last opened on an account (`Account::key`), reopened when it is switched back to.
    pub fn last_room(&self, account: String) -> Option<String> {
        rv_core::last_room::load(&self.dirs.config, &account)
    }

    pub fn set_last_room(&self, account: String, rid: String) {
        rv_core::last_room::save(&self.dirs.config, &account, &rid)
    }

    /// The rail's order (`keys`, `Account::key`) once `moved` is dropped on
    /// `target`'s tile, saved for the next launch and for GTK; None when
    /// nothing moves.
    pub fn move_rail_account(&self, keys: Vec<String>, moved: String, target: String) -> Option<Vec<String>> {
        let order = rv_core::server_rail::reordered(&keys, &moved, &target)?;
        rv_core::server_rail::save(&self.dirs.config, &order);
        Some(order)
    }

    pub async fn accounts(&self) -> Vec<Account> {
        let dirs = self.dirs.clone();
        blocking(move || accounts::load_all(&dirs)).await.iter().map(account).collect()
    }

    /// The kChat team servers an Infomaniak token opens, to pick one at sign-in.
    pub async fn kchat_servers(&self, token: String) -> Result<Vec<KchatServer>, RvError> {
        let list = on_tokio(async move { rv_core::mattermost::kchat_servers(&token).await }).await?;
        Ok(list.into_iter().map(|s| KchatServer { name: s.name, url: s.url }).collect())
    }

    pub async fn probe(&self, server: String, kind: ServerChoice) -> Result<ServerProfile, RvError> {
        let url = session::normalize_server(&server).ok_or_else(|| RvError::local("invalid server address"))?;
        Ok(on_tokio(async move { rv_core::server::probe_as(&url, kind.into()).await }).await?.into())
    }

    /// With `code`, the answer to the `method` challenge a previous attempt raised.
    #[allow(clippy::too_many_arguments)] // The form, its code answer and the chosen kind.
    pub async fn login(
        &self,
        server: String,
        kind: ServerChoice,
        user: String,
        password: String,
        method: Option<String>,
        code: Option<String>,
    ) -> Result<Arc<Chat>, RvError> {
        let url = session::normalize_server(&server).ok_or_else(|| RvError::local("invalid server address"))?;
        let kind: rv_core::native::ServerKind = kind.into();
        if on_tokio({
            let url = url.clone();
            async move { rv_core::native::probe_as(&url, kind).await }
        })
        .await
        .map_err(RvError::local)?
        .is_some()
        {
            return Err(RvError::local("Use native_login for the native pilot"));
        }
        let two_factor = method.zip(code).map(|(m, c)| session::two_factor_code(&m, &c));
        let info = on_tokio(async move { session::login_as(&url, kind, &user, &password, two_factor).await }).await?;
        let (dirs, saved) = (self.dirs.clone(), info.clone());
        blocking(move || {
            accounts::remember_server(&dirs, &saved.base_url);
            accounts::save(&dirs, &saved, None)
        })
        .await
        .map_err(RvError::local)?;
        self.start(info)
    }

    /// `users.2fa.sendEmailCode`, when the email challenge says no code went out yet.
    pub async fn request_email_code(&self, server: String, user: String) {
        if let Some(url) = session::normalize_server(&server) {
            on_tokio(async move { session::request_email_code(&url, &user).await }).await;
        }
    }

    /// Opens an account already signed in on this machine.
    pub async fn resume(&self, key: String) -> Result<Arc<Chat>, RvError> {
        let dirs = self.dirs.clone();
        let info = blocking(move || accounts::load_all(&dirs))
            .await
            .into_iter()
            .find(|i| accounts::key(i) == key)
            .ok_or_else(|| RvError::local("unknown account"))?;
        accounts::set_active(&self.dirs, &info);
        self.start(info)
    }
}

impl Client {
    pub(crate) fn with_dirs(dirs: Arc<Dirs>) -> Client {
        let (accounts, notices) = background::supervise(dirs.clone());
        Client { dirs, accounts, notices }
    }

    /// The account's session, running in the background already or new; it
    /// becomes the open account.
    fn start(&self, info: SessionInfo) -> Result<Arc<Chat>, RvError> {
        let path = self.dirs.database(&info);
        let (session, opening) = match self.accounts.open_counted(&info).map_err(RvError::local)? {
            (rv_core::provider::Chat::Legacy(session), opening) => (session, opening),
            (rv_core::provider::Chat::Native(_) | rv_core::provider::Chat::WhatsApp(_), _) => {
                return Err(RvError::local("not a Rocket.Chat account"));
            }
        };
        Ok(Arc::new(Chat {
            session,
            dirs: self.dirs.clone(),
            database: path,
            forward: Mutex::default(),
            rules: Mutex::default(),
            commands: Mutex::default(),
            accounts: self.accounts.clone(),
            opening,
        }))
    }
}

fn account(info: &SessionInfo) -> Account {
    Account {
        genre: info.genre().into(),
        key: accounts::key(info),
        base_url: info.base_url.clone(),
        user_id: info.user_id.clone(),
        username: info.username.clone(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MessageAction {
    React,
    Reply,
    ReplyInThread,
    Copy,
    Download,
    Edit,
    Delete,
    Pin,
    Unpin,
    Star,
    Unstar,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MediaData {
    pub bytes: Vec<u8>,
    pub content_type: String,
    /// The server's generated initials: no photo, keep the tile.
    pub placeholder: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Upload {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub failed: bool,
    pub progress: Option<f64>,
    /// Waiting for the connection, retried by itself.
    pub retrying: bool,
    /// A Rocket.Chat confirmation may have succeeded; only delivery is checked.
    pub checking: bool,
    /// The thread the file answers; `None` in the room.
    pub thread: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum Found {
    User { id: String, username: String, name: Option<String> },
    Room { id: String, name: String, kind: String },
}

#[derive(uniffi::Object)]
pub struct Chat {
    session: Arc<Session>,
    dirs: Arc<Dirs>,
    database: PathBuf,
    forward: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The server's settings and my permissions by room, for `actions`.
    rules: Mutex<ActionRules>,
    /// The server's slash commands, for `suggestions`.
    commands: Mutex<Vec<rv_core::commands::Command>>,
    accounts: rv_core::supervisor::Supervisor,
    opening: u64,
}

type ActionRules = (Option<rv_core::actions::ServerSettings>, std::collections::HashMap<String, Vec<String>>);

impl Drop for Chat {
    fn drop(&mut self) {
        if let Some(f) = self.forward.lock().unwrap().take() {
            f.abort();
        }
    }
}

fn state(c: Connection) -> ConnectionState {
    match c {
        Connection::Offline => ConnectionState::Offline,
        Connection::Connecting => ConnectionState::Connecting,
        Connection::Online => ConnectionState::Online,
    }
}

fn event(e: SessionEvent) -> Event {
    match e {
        SessionEvent::Connection(c) => Event::Connection { state: state(c) },
        SessionEvent::Expired => Event::Expired,
        SessionEvent::Typing(rid) => Event::Typing { rid },
        SessionEvent::Presence => Event::Presence,
        SessionEvent::Upload(rid) => Event::Upload { rid },
        SessionEvent::Avatar => Event::Avatar,
        SessionEvent::E2e => Event::E2e,
        SessionEvent::Incoming(i) => Event::Incoming {
            incoming: Incoming {
                rid: i.rid,
                id: i.id,
                author: i.author,
                room_name: i.room_name,
                direct: i.direct,
                body: i.body,
                mentions_me: i.mentions_me,
            },
        },
        SessionEvent::Private { rid, text } => Event::PrivateNote { rid, text },
        SessionEvent::CallRing => Event::CallRing,
    }
}

#[uniffi::export]
impl Chat {
    /// The account leaves the screen: its events stop coming here, it stays
    /// connected in the background.
    pub fn shutdown(&self) {
        if let Some(task) = self.forward.lock().unwrap().take() {
            task.abort();
        }
        self.accounts.leave(self.opening);
    }
    pub fn account(&self) -> Account {
        account(&self.session.info)
    }

    /// Replaces the previous listener. An expired session is forgotten here,
    /// before the listener hears of it.
    pub fn set_listener(&self, listener: Arc<dyn Listener>) {
        let mut changes = self.session.store.changes();
        let mut events = self.session.events();
        let (dirs, info, database) = (self.dirs.clone(), self.session.info.clone(), self.database.clone());
        let session = Arc::downgrade(&self.session);
        let supervisor = self.accounts.clone();
        let task = runtime().spawn(async move {
            loop {
                let e = tokio::select! {
                    c = changes.recv() => match c {
                        Ok(c) => Event::Changed { rooms: c.rooms, rids: c.rids.into_iter().collect() },
                        Err(RecvError::Lagged(_)) => Event::Resync,
                        Err(RecvError::Closed) => return,
                    },
                    e = events.recv() => match e {
                        Ok(e) => event(e),
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => return,
                    },
                };
                if e == Event::E2e
                    && let Some(s) = session.upgrade()
                {
                    let (dirs, info, jwk) = (dirs.clone(), info.clone(), s.e2e_export());
                    let _ = tokio::task::spawn_blocking(move || accounts::save(&dirs, &info, jwk.as_deref())).await;
                }
                if e == Event::Expired {
                    // Tasks still running hold the store: release the file first.
                    supervisor.remove(&accounts::key(&info));
                    if let Some(s) = session.upgrade() {
                        s.shutdown();
                        s.store.close();
                    }
                    let (dirs, info, database) = (dirs.clone(), info.clone(), database.clone());
                    let _ = tokio::task::spawn_blocking(move || {
                        accounts::remove(&dirs, &info);
                        rv_core::store::Store::remove_files(&database);
                    })
                    .await;
                }
                listener.on_event(e);
            }
        });
        if let Some(old) = self.forward.lock().unwrap().replace(task) {
            old.abort();
        }
    }

    /// Unlocks encrypted rooms with my E2E password; the key is then kept
    /// for the next launch. Errors: `e2e-wrong`, `e2e-no-keys`, `e2e-failed`.
    pub async fn e2e_unlock(&self, password: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.e2e_unlock(&password).await }).await.map_err(|e| match e {
            session::UnlockError::Key(rv_core::e2e::E2eError::WrongPassword) => RvError::local("e2e-wrong"),
            session::UnlockError::Key(rv_core::e2e::E2eError::NoKeys) => RvError::local("e2e-no-keys"),
            _ => RvError::local("e2e-failed"),
        })
    }

    /// Locks them again and forgets the kept key.
    pub fn e2e_lock(&self) {
        self.session.e2e_lock();
    }

    pub fn e2e_unlocked(&self) -> bool {
        self.session.e2e_unlocked()
    }

    pub fn reconnect_now(&self) {
        self.session.reconnect_now();
    }

    /// Sections in display order, empty ones left out.
    pub fn rooms(&self) -> Vec<RoomGroup> {
        let rows = self.session.store.rooms();
        rv_core::rooms::sections(&rows)
            .into_iter()
            .map(|(section, members)| {
                let rooms = members
                    .into_iter()
                    .map(|r| {
                        let clear = r.last_encrypted.as_deref().and_then(|raw| self.session.decrypt(&r.rid, raw));
                        let presence = r.dm_other_uid.as_deref().and_then(|uid| self.session.presence(uid));
                        let status = r.dm_other_uid.as_deref().and_then(|uid| self.session.status_emoji(uid));
                        let mut room = model::room(r, clear, presence.map(Presence::from));
                        if let Some(emoji) = status {
                            room.name = format!("{} {emoji}", room.name);
                        }
                        room
                    })
                    .collect();
                RoomGroup::new(&section, rooms)
            })
            .collect()
    }

    /// What the dock badge counts: mentions and direct messages.
    pub fn attention(&self) -> i64 {
        rv_core::rooms::attention(&self.session.store.rooms())
    }

    pub fn unread_rooms(&self) -> u32 {
        rv_core::rooms::unread_rooms(&self.session.store.rooms()) as u32
    }

    /// The room's last read time, for the "new messages" marker.
    pub fn last_seen(&self, rid: String) -> Option<i64> {
        self.session.store.last_seen(&rid)
    }

    /// The latest `limit` messages kept for the room, oldest first, grouped.
    /// `unread_after`: marks the first message from someone else after it.
    pub fn messages(&self, rid: String, limit: i64, unread_after: Option<i64>) -> Vec<model::MessageItem> {
        self.lay_out(self.session.store.messages(&rid, limit), unread_after)
    }

    pub fn thread_messages(&self, root_id: String) -> Vec<model::MessageItem> {
        self.lay_out(self.session.store.thread_messages(&root_id), None)
    }

    /// Fetches the newest page and marks the room as the one open. True
    /// when older pages may exist.
    pub async fn open_room(&self, rid: String, kind: String) -> Result<bool, RvError> {
        let s = self.session.clone();
        let page = on_tokio(async move { s.open_room(&rid, &kind).await }).await?;
        Ok(page.count as i64 >= rv_core::sync::HISTORY_PAGE)
    }

    /// One more page before `oldest_ts`.
    pub async fn load_older(&self, rid: String, kind: String, oldest_ts: i64) -> Result<model::OlderPage, RvError> {
        let (s, room) = (self.session.clone(), rid.clone());
        let page = on_tokio(async move { s.sync.load_history(&room, &kind, Some(oldest_ts)).await }).await?;
        // Down to the page and no further: an older message stored on its own
        // (starred, edited) would hide the hole above it.
        let limit = page.oldest_ts.map(|ts| self.session.store.count_since(&rid, ts));
        Ok(model::OlderPage { more: page.count > 1, limit })
    }

    pub async fn load_thread(&self, root_id: String) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.load_thread(&root_id).await }).await?)
    }

    pub async fn mark_read(&self, rid: String) {
        let s = self.session.clone();
        on_tokio(async move { s.mark_read(&rid).await }).await
    }
    /// A Mattermost or kChat account: no end-to-end encryption, the conversation list settings.
    pub fn is_mattermost(&self) -> bool {
        self.session.info.mattermost.is_some()
    }

    /// A Slack account: none of Rocket.Chat's own features (its encryption, GIFs, stickers).
    pub fn is_slack(&self) -> bool {
        self.session.info.slack.is_some()
    }

    /// The account's conversation list settings (Mattermost and kChat), kept on the server.
    pub async fn sidebar_settings(&self) -> Result<SidebarSettings, RvError> {
        let s = self.session.clone();
        let settings = on_tokio(async move { s.sidebar_settings().await }).await?;
        Ok(SidebarSettings {
            name_format: settings.name_format.as_str().to_owned(),
            name_locked: settings.name_locked,
            dm_limit: settings.dm_limit as u32,
        })
    }

    pub async fn set_sidebar_settings(
        &self,
        name_format: Option<String>,
        dm_limit: Option<u32>,
    ) -> Result<(), RvError> {
        let s = self.session.clone();
        let format = name_format.as_deref().and_then(|f| rv_core::mattermost::directory::NameFormat::parse(Some(f)));
        Ok(on_tokio(async move { s.set_sidebar_settings(format, dm_limit.map(|l| l as usize)).await }).await?)
    }

    pub async fn set_favorite(&self, rid: String, present: bool) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.set_favorite(&rid, present).await }).await?)
    }

    pub async fn send(&self, rid: String, text: String, thread_id: Option<String>) {
        let s = self.session.clone();
        on_tokio(async move { s.send_in(&rid, &text, thread_id.as_deref()).await }).await
    }

    /// Runs `text` as a slash command when it names one the server knows:
    /// false when it is a message to send instead. The server's answer comes
    /// as `Event::PrivateNote`.
    pub async fn run_command(&self, rid: String, text: String, thread_id: Option<String>) -> Result<bool, RvError> {
        let s = self.session.clone();
        match on_tokio(async move { s.run_command(&rid, &text, thread_id.as_deref()).await }).await {
            None => Ok(false),
            Some(result) => result.map(|()| true).map_err(Into::into),
        }
    }

    pub async fn retry(&self, id: String) {
        let s = self.session.clone();
        on_tokio(async move { s.retry(&id).await }).await
    }

    /// Every reaction added counts toward my quick reactions.
    pub async fn react(&self, message_id: String, shortcode: String, add: bool) -> Result<(), RvError> {
        if add {
            reactions::usage(&self.dirs.config, &self.session.info).record(&shortcode);
        }
        let s = self.session.clone();
        Ok(on_tokio(async move { s.react(&message_id, &shortcode, add).await }).await?)
    }

    pub async fn edit(&self, rid: String, message_id: String, text: String) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.edit(&rid, &message_id, &text).await }).await?)
    }

    pub async fn delete(&self, rid: String, message_id: String) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.delete(&rid, &message_id).await }).await?)
    }

    pub async fn pin(&self, message_id: String, on: bool) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { if on { s.pin(&message_id).await } else { s.unpin(&message_id).await } }).await?)
    }

    pub async fn star(&self, message_id: String, on: bool) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.star(&message_id, on).await }).await?)
    }

    /// The text to insert in the composer to quote a message.
    pub async fn quote(
        &self,
        kind: String,
        slug: Option<String>,
        rid: String,
        message_id: String,
        text: String,
    ) -> String {
        let s = self.session.clone();
        let link = on_tokio(async move { s.permalink(&kind, slug.as_deref(), &rid, &message_id).await }).await;
        rv_core::actions::quote(&link, &text)
    }

    /// Reads, once, what `actions` and the `/` suggestions need from the
    /// server for this room: its settings, its slash commands and my
    /// permissions there.
    pub async fn prepare_actions(&self, rid: String) {
        let s = self.session.clone();
        let (settings, commands, permissions) = on_tokio(async move {
            let settings = s.settings().await.clone();
            let commands = s.commands().await.map(<[_]>::to_vec).unwrap_or_default();
            (settings, commands, s.permissions(&rid).await.map(|p| (rid, p)))
        })
        .await;
        *self.commands.lock().unwrap() = commands;
        let mut rules = self.rules.lock().unwrap();
        rules.0 = Some(settings);
        if let Some((rid, granted)) = permissions {
            rules.1.insert(rid, granted);
        }
    }

    /// What the actions menu offers on this message, by the server's rules.
    /// Before `prepare_actions` answered, by what a member may do.
    pub fn actions(&self, rid: String, message_id: String, in_thread: bool) -> Vec<MessageAction> {
        self.possible_actions(&rid, &message_id, in_thread)
            .map(|(_, possible)| possible.into_iter().map(action).collect())
            .unwrap_or_default()
    }

    /// The reactions the actions menu offers first, as shortcodes: the ones I
    /// use most on this account, the server's emoji included.
    pub fn quick_reactions(&self) -> Vec<String> {
        let s = &self.session;
        reactions::quick_rocket_chat(&reactions::usage(&self.dirs.config, &s.info), |code| {
            s.custom_emoji(code).is_some()
        })
    }

    /// The call's link, to open in the browser.
    pub async fn join_call(&self, call_id: String) -> Result<String, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.join_call(&call_id).await }).await?)
    }

    /// The call ringing here, started by the other member of a direct room.
    pub fn incoming_call(&self) -> Option<RingingCall> {
        self.session.incoming_call().map(|c| RingingCall {
            rid: c.rid,
            call_id: c.call_id,
            caller_id: c.caller_id,
            caller_name: c.caller_name,
        })
    }

    /// Answered or ignored here: it rings no more.
    pub fn dismiss_call(&self) {
        self.session.dismiss_call();
    }

    /// Declines the ringing call; a refusal from the server is ignored.
    pub async fn decline_call(&self, call_id: String) {
        let s = self.session.clone();
        let _ = on_tokio(async move { s.decline_call(&call_id).await }).await;
    }

    /// The meeting's link to share, without anyone's token.
    pub async fn call_link(&self, call_id: String) -> Result<String, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.call_link(&call_id).await }).await?)
    }

    /// A protected file or avatar, fetched with the session's credentials and cached.
    pub async fn media(&self, path: String) -> Result<MediaData, RvError> {
        let s = self.session.clone();
        let m = on_tokio(async move { s.media.fetch(&path).await }).await?;
        Ok(MediaData { placeholder: m.is_placeholder(), bytes: m.bytes.clone(), content_type: m.content_type.clone() })
    }

    pub async fn download(&self, path: String, destination: String) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.download_to(&path, std::path::Path::new(&destination)).await }).await?)
    }

    pub fn user_avatar(&self, username: String) -> String {
        self.session.user_avatar(&username)
    }

    /// A server emoji's image path, by shortcode without colons.
    pub fn custom_emoji(&self, code: String) -> Option<String> {
        self.session.custom_emoji(&code)
    }
    pub fn custom_emoji_names(&self) -> Vec<String> {
        self.session.custom_emoji_names()
    }

    /// `thread_id` None for the room's own composer.
    pub fn draft(&self, rid: String, thread_id: Option<String>) -> String {
        self.session.store.draft(&draft_key(&rid, thread_id.as_deref())).unwrap_or_default()
    }

    pub fn set_draft(&self, rid: String, thread_id: Option<String>, text: String) {
        let key = draft_key(&rid, thread_id.as_deref());
        self.session.store.write(|w| w.set_draft(&key, &text));
    }

    /// Says I am typing in the room, where the account's protocol carries it.
    pub fn set_typing(&self, rid: String, active: bool) {
        self.session.set_typing(&rid, active);
    }

    /// Who is typing in the room now.
    pub fn typing(&self, rid: String) -> Vec<String> {
        self.session.typing(&rid)
    }

    /// Queues a file for the room, or for its thread `thread`; the refusal
    /// says why the server's rules reject it.
    #[allow(clippy::too_many_arguments)] // The file, its caption and where it goes.
    pub async fn attach(
        &self,
        rid: String,
        thread: Option<String>,
        path: String,
        name: String,
        mime: String,
        caption: Option<String>,
        temporary: bool,
    ) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move {
            s.attach_in(
                &rid,
                thread.as_deref(),
                std::path::Path::new(&path),
                &name,
                &mime,
                caption.as_deref(),
                temporary,
            )
            .await
        })
        .await
        .map_err(|r| match r {
            rv_core::uploads::Refusal::TooLarge { max_mb } => RvError::local(format!("too-large:{max_mb}")),
            rv_core::uploads::Refusal::TypeNotAllowed { mime } => RvError::local(format!("type-not-allowed:{mime}")),
            rv_core::uploads::Refusal::EncryptedFilesOff => RvError::local("encrypted-files-off".to_owned()),
        })
    }

    pub fn uploads(&self, rid: String) -> Vec<Upload> {
        self.session
            .store
            .uploads(&rid)
            .into_iter()
            .map(|u| Upload {
                progress: self.session.uploads.progress(&u.id),
                retrying: self.session.uploads.reconnecting(),
                checking: u.confirm_started && self.session.rest.api() == rv_core::rest::Api::RocketChat,
                failed: u.status == "failed",
                id: u.id,
                name: u.name,
                mime: u.mime,
                thread: u.tmid,
            })
            .collect()
    }

    pub async fn retry_upload(&self, id: String) {
        let uploads = self.session.uploads.clone();
        on_tokio(async move { uploads.retry(&id).await }).await
    }

    pub fn discard_upload(&self, id: String) {
        self.session.uploads.discard(&id);
    }

    pub async fn spotlight(&self, query: String) -> Result<Vec<Found>, RvError> {
        let s = self.session.clone();
        let found = on_tokio(async move { s.spotlight(&query).await }).await?;
        Ok(found
            .into_iter()
            .map(|f| match f {
                rv_core::rooms::Found::User { id, username, name } => Found::User { id, username, name },
                rv_core::rooms::Found::Room { id, name, kind } => Found::Room { id, name, kind },
            })
            .collect())
    }

    /// The direct room with this person, created if need be: its id.
    pub async fn open_dm(&self, username: String) -> Result<String, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.open_dm(&username).await }).await?)
    }

    pub async fn join_channel(&self, rid: String) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.join_channel(&rid).await }).await?)
    }

    /// `online`, `away`, `busy` or `offline`, with a message.
    pub async fn set_status(&self, status: String, message: String) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.set_status(&status, &message).await }).await?)
    }

    pub async fn set_activity(&self, status: String) -> Result<String, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.set_activity(&status).await }).await?)
    }

    /// Signs out on the server and forgets the account and its cache; a
    /// sign-out the server did not hear (offline) is kept for the next start.
    pub async fn sign_out(&self) {
        let s = self.session.clone();
        let settled = on_tokio(async move { s.logout().await }).await;
        self.accounts.remove(&accounts::key(&self.session.info));
        self.session.shutdown();
        self.session.store.close();
        let (dirs, info, database) = (self.dirs.clone(), self.session.info.clone(), self.database.clone());
        blocking(move || {
            accounts::remove(&dirs, &info);
            if !settled {
                accounts::keep_logout(&dirs, &info);
            }
            rv_core::store::Store::remove_files(&database);
        })
        .await;
    }
}

impl Chat {
    fn lay_out(&self, rows: Vec<rv_core::store::MessageRow>, unread_after: Option<i64>) -> Vec<model::MessageItem> {
        lay_out(&self.session, rows, unread_after)
    }
}

/// Rows as the room shows them: opened when encrypted, grouped, the unread marker placed.
fn lay_out(
    session: &Session,
    rows: Vec<rv_core::store::MessageRow>,
    unread_after: Option<i64>,
) -> Vec<model::MessageItem> {
    let info = &session.info;
    let mut laid = timeline::group(rows.into_iter().map(|r| session.open_row(r)).collect());
    if let Some(seen) = unread_after {
        timeline::mark_new(&mut laid, seen, &info.user_id);
    }
    laid.into_iter()
        .map(|d| {
            let mut item = model::message(d, &info.user_id, &info.username);
            if let Some(label) = session.person_label(&item.author_id) {
                item.author_label = label;
            }
            item
        })
        .collect()
}

fn draft_key(rid: &str, thread_id: Option<&str>) -> String {
    match thread_id {
        Some(tmid) => format!("{rid}:{tmid}"),
        None => rid.to_owned(),
    }
}

fn action(a: rv_core::actions::Action) -> MessageAction {
    use rv_core::actions::Action;
    match a {
        Action::React => MessageAction::React,
        Action::Reply => MessageAction::Reply,
        Action::ReplyInThread => MessageAction::ReplyInThread,
        Action::Copy => MessageAction::Copy,
        Action::Download => MessageAction::Download,
        Action::Edit => MessageAction::Edit,
        Action::Delete => MessageAction::Delete,
        Action::Pin => MessageAction::Pin,
        Action::Unpin => MessageAction::Unpin,
        Action::Star => MessageAction::Star,
        Action::Unstar => MessageAction::Unstar,
    }
}

/// French when true, English otherwise; the app decides from the system's languages.
#[uniffi::export]
pub fn set_french(french: bool) {
    rv_core::i18n::set(if french { rv_core::i18n::Lang::Fr } else { rv_core::i18n::Lang::En });
}

#[uniffi::export]
pub fn t(key: String) -> String {
    rv_core::i18n::t(&key).to_owned()
}

/// Fills each `{name}` from `args`.
#[uniffi::export]
pub fn tf(key: String, args: std::collections::HashMap<String, String>) -> String {
    let pairs: Vec<(&str, &str)> = args.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    rv_core::i18n::tf(&key, &pairs)
}

#[uniffi::export]
pub fn tn(key: String, n: i64) -> String {
    rv_core::i18n::tn(&key, n)
}

/// The digit of the Cmd shortcut opening the rail's `slot`: 1 to 9, then 0
/// for the tenth; None past it.
#[uniffi::export]
pub fn rail_shortcut_digit(slot: u32) -> Option<u32> {
    rv_core::server_rail::shortcut_digit(slot as usize)
}

/// What a system message says, after its author's name.
#[uniffi::export]
pub fn system_message(kind: String, param: String) -> String {
    rv_core::i18n::system_message(&kind, &param)
}

/// `:smile:` to 😄 wherever a shortcode has a glyph.
/// Where a call window may go: the call's own origin (see `rv_core::call`).
/// Where the inline player's page lives: the base address it is loaded at.
#[uniffi::export]
pub fn player_origin() -> String {
    format!("{}/", rv_core::player::ORIGIN)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum PlayerNavigation {
    Allow,
    /// Cancelled in the player, opened in the browser.
    Browser,
    Block,
}

/// What the inline player does with a navigation to `target`.
#[uniffi::export]
pub fn player_navigation(target: String, main_frame: bool, clicked: bool) -> PlayerNavigation {
    match rv_core::player::navigation(&target, main_frame, clicked) {
        rv_core::player::Navigation::Allow => PlayerNavigation::Allow,
        rv_core::player::Navigation::Browser => PlayerNavigation::Browser,
        rv_core::player::Navigation::Block => PlayerNavigation::Block,
    }
}

#[uniffi::export]
pub fn call_allowed(url: String, call_url: String) -> bool {
    rv_core::call::allowed(&url, &call_url)
}

/// One Infomaniak sign-in for kChat, from its page to the bearer it yields.
#[derive(uniffi::Object)]
pub struct KchatSignIn {
    pkce: rv_core::mattermost::oauth::Pkce,
}

#[uniffi::export]
impl KchatSignIn {
    #[uniffi::constructor]
    pub fn new() -> Result<Arc<Self>, RvError> {
        let pkce = rv_core::mattermost::oauth::Pkce::new().map_err(RvError::local)?;
        Ok(Arc::new(KchatSignIn { pkce }))
    }

    pub fn authorize_url(&self) -> String {
        self.pkce.authorize_url()
    }

    /// The Infomaniak bearer the redirect caught by the sign-in window trades for.
    pub async fn finish(&self, redirect: String) -> Result<String, RvError> {
        let code = self.pkce.code_from_redirect(&redirect).map_err(RvError::local)?;
        let pkce = self.pkce.clone();
        on_tokio(async move { pkce.exchange(&code).await }).await.map_err(RvError::local)
    }
}

#[uniffi::export]
pub fn kchat_is_redirect(url: String) -> bool {
    rv_core::mattermost::oauth::is_redirect(&url)
}

#[uniffi::export]
pub fn kchat_is_sign_in_page(url: String) -> bool {
    rv_core::mattermost::oauth::is_sign_in_page(&url)
}

#[uniffi::export]
pub fn replace_shortcodes(text: String) -> String {
    rv_core::emoji::replace_shortcodes(&text)
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EmojiMatch {
    pub shortcode: String,
    pub glyph: String,
}

/// Emoji whose shortcode starts with `prefix`, for the composer's `:` completion.
#[uniffi::export]
pub fn complete_emoji(prefix: String, limit: u32) -> Vec<EmojiMatch> {
    rv_core::emoji::complete(&prefix, limit as usize)
        .into_iter()
        .map(|(code, glyph)| EmojiMatch { shortcode: code.to_owned(), glyph: glyph.to_owned() })
        .collect()
}

impl Chat {
    /// The message as stored and what its actions menu offers, by the
    /// server's rules (before `prepare_actions` answered, by what a member may do).
    pub(crate) fn possible_actions(
        &self,
        rid: &str,
        message_id: &str,
        in_thread: bool,
    ) -> Option<(rv_core::store::MessageRow, Vec<rv_core::actions::Action>)> {
        let s = &self.session;
        let row = s.store.messages_by_id(&[message_id.to_owned()]).into_iter().next()?;
        let row = s.open_row(row);
        let (read_only, encrypted) =
            s.store.rooms().iter().find(|r| r.rid == rid).map_or((false, false), |r| (r.read_only, r.encrypted));
        let rules = self.rules.lock().unwrap();
        let fallback = rv_core::actions::ServerSettings::from_list(&[]);
        let ctx = rv_core::actions::ActionContext {
            author_id: &row.author_id,
            ts: row.ts,
            system_type: row.system_type.as_deref(),
            text: row.text.as_deref(),
            has_file: !rv_core::content::files(row.attachments.as_deref()).is_empty()
                || !rv_core::media::image_attachments(row.attachments.as_deref()).is_empty(),
            me: &s.info.user_id,
            settings: rules.0.as_ref().unwrap_or(&fallback),
            permissions: rules.1.get(rid).map(Vec::as_slice),
            read_only,
            encrypted,
            in_thread,
            pinned: row.pinned,
            starred: row.starred_by(&s.info.user_id),
            now: chrono::Utc::now().timestamp_millis(),
            outbox: row.outbox_status.as_deref(),
        };
        let possible = rv_core::actions::possible_actions(&ctx);
        Some((row, possible))
    }
}
