//! rv-core for Swift, through UniFFI: the macOS app's view of a session.
//! Every future runs on this crate's tokio runtime, whatever polls it.

mod accounts;
mod context;
pub mod markup;
pub mod model;
pub mod people;
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
}

#[uniffi::export(with_foreign)]
pub trait Listener: Send + Sync {
    /// Called on a tokio thread.
    fn on_event(&self, event: Event);
}

#[derive(uniffi::Object)]
pub struct Client {
    dirs: Arc<Dirs>,
}

#[uniffi::export]
impl Client {
    /// `home`: where GLib would put its user directories, for sessions shared with the GTK app.
    #[uniffi::constructor]
    pub fn new(home: String) -> Arc<Self> {
        Arc::new(Client { dirs: Arc::new(Dirs::glib(std::path::Path::new(&home))) })
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

    pub async fn accounts(&self) -> Vec<Account> {
        let dirs = self.dirs.clone();
        blocking(move || accounts::load_all(&dirs)).await.iter().map(account).collect()
    }

    pub async fn probe(&self, server: String) -> Result<ServerProfile, RvError> {
        let url = session::normalize_server(&server).ok_or_else(|| RvError::local("invalid server address"))?;
        Ok(on_tokio(async move { rv_core::server::probe(&url).await }).await?.into())
    }

    /// With `code`, the answer to the `method` challenge a previous attempt raised.
    pub async fn login(
        &self,
        server: String,
        user: String,
        password: String,
        method: Option<String>,
        code: Option<String>,
    ) -> Result<Arc<Chat>, RvError> {
        let url = session::normalize_server(&server).ok_or_else(|| RvError::local("invalid server address"))?;
        let two_factor = method.zip(code).map(|(m, c)| session::two_factor_code(&m, &c));
        let info = on_tokio(async move { session::login(&url, &user, &password, two_factor).await }).await?;
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
    fn start(&self, info: SessionInfo) -> Result<Arc<Chat>, RvError> {
        let path = self.dirs.database(&info);
        let session = {
            let _guard = runtime().enter();
            Session::start(info, &path).map_err(RvError::local)?
        };
        let resumed = session.clone();
        runtime().spawn_blocking(move || {
            if let Some(jwk) = accounts::e2e_key(&resumed.info) {
                let _guard = runtime().enter();
                resumed.e2e_resume(&jwk);
            }
        });
        Ok(Arc::new(Chat {
            session,
            dirs: self.dirs.clone(),
            database: path,
            forward: Mutex::default(),
            rules: Mutex::default(),
            commands: Mutex::default(),
        }))
    }
}

fn account(info: &SessionInfo) -> Account {
    Account {
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
}

type ActionRules = (Option<rv_core::actions::ServerSettings>, std::collections::HashMap<String, Vec<String>>);

impl Drop for Chat {
    fn drop(&mut self) {
        if let Some(f) = self.forward.lock().unwrap().take() {
            f.abort();
        }
        self.session.shutdown();
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
    }
}

#[uniffi::export]
impl Chat {
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
                    let (dirs, info, database) = (dirs.clone(), info.clone(), database.clone());
                    let _ = tokio::task::spawn_blocking(move || {
                        accounts::remove(&dirs, &info);
                        let _ = std::fs::remove_file(database);
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
            .map(|(section, members)| RoomGroup {
                section: section.into(),
                rooms: members
                    .into_iter()
                    .map(|r| {
                        let clear = r.last_encrypted.as_deref().and_then(|raw| self.session.decrypt(&r.rid, raw));
                        let presence = r.dm_other_uid.as_deref().and_then(|uid| self.session.presence(uid));
                        model::room(r, clear, presence.map(Presence::from))
                    })
                    .collect(),
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

    /// One more page before `oldest_ts`. True when there may be more still.
    pub async fn load_older(&self, rid: String, kind: String, oldest_ts: i64) -> Result<bool, RvError> {
        let s = self.session.clone();
        let page = on_tokio(async move { s.sync.load_history(&rid, &kind, Some(oldest_ts)).await }).await?;
        Ok(page.count > 1)
    }

    pub async fn load_thread(&self, root_id: String) -> Result<(), RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.load_thread(&root_id).await }).await?)
    }

    pub async fn mark_read(&self, rid: String) {
        let s = self.session.clone();
        on_tokio(async move { s.mark_read(&rid).await }).await
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

    pub async fn react(&self, message_id: String, shortcode: String, add: bool) -> Result<(), RvError> {
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
        let s = &self.session;
        let Some(row) = s.store.messages_by_id(std::slice::from_ref(&message_id)).into_iter().next() else {
            return Vec::new();
        };
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
            permissions: rules.1.get(&rid).map(Vec::as_slice),
            read_only,
            encrypted,
            in_thread,
            pinned: row.pinned,
            starred: row.starred_by(&s.info.user_id),
            now: chrono::Utc::now().timestamp_millis(),
        };
        rv_core::actions::possible_actions(&ctx).into_iter().map(action).collect()
    }

    /// The reactions the actions menu offers first, as shortcodes.
    pub fn quick_reactions(&self) -> Vec<String> {
        rv_core::actions::QUICK_REACTIONS.iter().map(|c| (*c).to_owned()).collect()
    }

    /// The call's link, to open in the browser.
    pub async fn join_call(&self, call_id: String) -> Result<String, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.join_call(&call_id).await }).await?)
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

    /// `thread_id` None for the room's own composer.
    pub fn draft(&self, rid: String, thread_id: Option<String>) -> String {
        self.session.store.draft(&draft_key(&rid, thread_id.as_deref())).unwrap_or_default()
    }

    pub fn set_draft(&self, rid: String, thread_id: Option<String>, text: String) {
        let key = draft_key(&rid, thread_id.as_deref());
        self.session.store.write(|w| w.set_draft(&key, &text));
    }

    /// Who is typing in the room now.
    pub fn typing(&self, rid: String) -> Vec<String> {
        self.session.typing(&rid)
    }

    /// Queues a file for the room; the refusal says why the server's rules reject it.
    pub async fn attach(
        &self,
        rid: String,
        path: String,
        name: String,
        mime: String,
        caption: Option<String>,
        temporary: bool,
    ) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move {
            s.attach(&rid, std::path::Path::new(&path), &name, &mime, caption.as_deref(), temporary).await
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
                failed: u.status == "failed",
                id: u.id,
                name: u.name,
                mime: u.mime,
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

    /// Signs out on the server (best effort) and forgets the account and its cache.
    pub async fn sign_out(&self) {
        let s = self.session.clone();
        on_tokio(async move { s.logout().await }).await;
        let (dirs, info, database) = (self.dirs.clone(), self.session.info.clone(), self.database.clone());
        blocking(move || {
            accounts::remove(&dirs, &info);
            let _ = std::fs::remove_file(database);
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
    laid.into_iter().map(|d| model::message(d, &info.user_id, &info.username)).collect()
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
