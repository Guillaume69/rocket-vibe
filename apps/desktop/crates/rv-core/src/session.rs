//! A logged-in session: REST, DDP, store, sync and outbox wired together,
//! plus the reconnection loop. Everything a UI needs, nothing it draws.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use url::Url;

use crate::actions::{self, ServerSettings};
use crate::ddp::{self, DdpEvent, DdpHandle, State, Timeouts};
use crate::live;
use crate::{info, media};

const UPDATE_AVATAR: &str = "updateAvatar";
use crate::media::MediaCache;
use crate::outbox::Outbox;
use crate::rest::{CallOptions, Credentials, RestClient, RestError, TwoFactorCode};
use crate::store::Store;
use crate::sync::{HistoryPage, MY_MESSAGES, STREAM_NOTIFY_ROOM, STREAM_NOTIFY_USER, STREAM_ROOM_MESSAGES, SyncEngine};
use crate::uploads::{self, Uploads};

const MAX_RECONNECT_DELAY_MS: u64 = 30_000;

#[derive(Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub base_url: String,
    pub user_id: String,
    pub username: String,
    pub auth_token: String,
    /// None for legacy Rocket.Chat accounts; pinned for the native pilot.
    pub native: Option<crate::native::Identity>,
}

impl std::fmt::Debug for SessionInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionInfo")
            .field("base_url", &self.base_url)
            .field("user_id", &self.user_id)
            .field("username", &self.username)
            .field("auth_token", &"[redacted]")
            .field("native", &self.native)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Connection {
    Offline,
    Connecting,
    Online,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    Connection(Connection),
    /// The server refused our token: the session is over.
    Expired,
    /// Who types in this room changed.
    Typing(String),
    /// Someone's presence changed.
    Presence,
    /// An upload of this room progressed.
    Upload(String),
    /// Images changed: someone's photo, or the list of custom emoji.
    Avatar,
    /// Encrypted rooms were unlocked or locked again.
    E2e,
    /// A new message from someone else that my notification preference wants shown.
    Incoming(Box<crate::notify::Incoming>),
    /// What the server told me alone in a room: a slash command's answer.
    Private {
        rid: String,
        text: String,
    },
}

pub fn normalize_server(input: &str) -> Option<Url> {
    let input = input.trim().trim_end_matches('/');
    let with_scheme = if input.contains("://") { input.to_owned() } else { format!("https://{input}") };
    Url::parse(&with_scheme).ok().filter(|u| u.host_str().is_some())
}

fn websocket_url(base: &Url) -> Url {
    let mut url = base.clone();
    let scheme = if base.scheme() == "http" { "ws" } else { "wss" };
    url.set_scheme(scheme).expect("ws scheme");
    url.set_path(&format!("{}/websocket", base.path().trim_end_matches('/')));
    url
}

/// For the `password` 2FA method the server wants the SHA-256 hex of the password.
pub fn two_factor_code(method: &str, input: &str) -> TwoFactorCode {
    let code = if method == "password" {
        Sha256::digest(input.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    } else {
        input.trim().to_owned()
    };
    TwoFactorCode { code, method: method.to_owned() }
}

pub async fn login(
    server: &Url,
    user: &str,
    password: &str,
    two_factor: Option<TwoFactorCode>,
) -> Result<SessionInfo, RestError> {
    if let Some(discovery) = crate::native::probe(server).await.map_err(crate::native::rest_error)? {
        return crate::native::login(server, &discovery, user, password).await.map_err(crate::native::rest_error);
    }
    let rest = RestClient::new(server.clone());
    let options = CallOptions {
        anonymous: true,
        two_factor,
        body: Some(json!({"user": user, "password": password})),
        ..Default::default()
    };
    let response = rest.post("login", options).await?;
    let data = response.get("data").unwrap_or(&Value::Null);
    let field = |pointer: &str| data.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_owned();
    let info = SessionInfo {
        base_url: server.to_string().trim_end_matches('/').to_owned(),
        user_id: field("/userId"),
        username: field("/me/username"),
        auth_token: field("/authToken"),
        native: None,
    };
    if info.auth_token.is_empty() || info.user_id.is_empty() {
        return Err(RestError {
            status: 200,
            message: "Unexpected login response.".into(),
            error: None,
            error_type: None,
            understood: false,
            two_factor: None,
            request_id: None,
            retry_after: None,
        });
    }
    Ok(info)
}

/// `users.2fa.sendEmailCode`: needed when the email challenge says no code was generated yet.
pub async fn request_email_code(server: &Url, user: &str) {
    let rest = RestClient::new(server.clone());
    let options = CallOptions { anonymous: true, body: Some(json!({"emailOrUsername": user})), ..Default::default() };
    let _ = rest.post("users.2fa.sendEmailCode", options).await;
}

pub struct Session {
    pub info: SessionInfo,
    pub store: Arc<Store>,
    pub rest: RestClient,
    pub sync: Arc<SyncEngine>,
    pub outbox: Arc<Outbox>,
    pub media: Arc<MediaCache>,
    pub uploads: Arc<Uploads>,
    ddp: DdpHandle,
    events: broadcast::Sender<SessionEvent>,
    current_room: Mutex<Option<(String, String)>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    settings: tokio::sync::OnceCell<ServerSettings>,
    /// `permissions.listAll` (ours only) and my global roles, fetched once.
    access: tokio::sync::OnceCell<(Vec<actions::PermissionRoles>, Vec<String>)>,
    commands: tokio::sync::OnceCell<Vec<crate::commands::Command>>,
    typing: Mutex<live::Typing>,
    call_available: Mutex<Option<bool>>,
    /// Photo versions learnt from `updateAvatar`, by username.
    avatars: Mutex<HashMap<String, String>>,
    /// `desktopNotifications` from `me`, kept current by set_preference.
    notification_preference: Mutex<String>,
    /// None until `users.presence` answered once; it only lists who is not offline.
    presence: Mutex<Option<HashMap<String, live::Presence>>>,
    /// My private key once unlocked, and the room keys unwrapped with it (by key id).
    e2e: Mutex<Option<E2eUnlocked>>,
    /// Custom emoji: shortcode (name or alias) → image path.
    custom_emoji: Mutex<HashMap<String, String>>,
    custom_emoji_names: Mutex<Vec<String>>,
    once: tokio::sync::OnceCell<()>,
    /// Rooms whose edits and deletions were caught up this session.
    synced: Arc<Mutex<std::collections::HashSet<String>>>,
}

struct E2eUnlocked {
    key: crate::e2e::PrivateKey,
    /// The same key as its JWK, for the keychain.
    jwk: String,
    rooms: HashMap<String, (String, Vec<u8>)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnlockError {
    Server(RestError),
    Key(crate::e2e::E2eError),
}

impl Session {
    /// Must run inside a tokio runtime.
    pub fn start(info: SessionInfo, db_path: &Path) -> rusqlite::Result<Arc<Session>> {
        // A native account must never enter the Rocket.Chat REST/DDP engine.
        if info.native.is_some() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let base: Url = info.base_url.parse().expect("stored base URL");
        let store = Arc::new(Store::open(db_path)?);
        let rest = RestClient::new(base.clone());
        rest.set_credentials(Some(Credentials { auth_token: info.auth_token.clone(), user_id: info.user_id.clone() }));
        let sync = Arc::new(SyncEngine::new(store.clone(), rest.clone(), &info.username, &info.user_id));
        let outbox = Arc::new(Outbox::new(store.clone(), rest.clone(), sync.clone(), &info.user_id, &info.username));
        let (ddp, ddp_events) = ddp::spawn(websocket_url(&base), Timeouts::default());
        ddp.subscribe(STREAM_NOTIFY_USER, &format!("{}/subscriptions-changed", info.user_id));
        ddp.subscribe(STREAM_NOTIFY_USER, &format!("{}/rooms-changed", info.user_id));
        ddp.subscribe(STREAM_NOTIFY_USER, &format!("{}/{}", info.user_id, live::PRIVATE_MESSAGE));
        ddp.subscribe(STREAM_ROOM_MESSAGES, MY_MESSAGES);
        ddp.subscribe(live::STREAM_NOTIFY_LOGGED, live::USER_STATUS);
        ddp.subscribe(live::STREAM_NOTIFY_LOGGED, UPDATE_AVATAR);
        let (events, _) = broadcast::channel(32);

        let media = Arc::new(MediaCache::new(rest.clone()));
        let uploads = Arc::new(Uploads::new(store.clone(), rest.clone(), sync.clone()));
        let session = Arc::new(Session {
            info,
            store,
            rest,
            sync,
            outbox,
            media,
            uploads,
            ddp,
            events,
            current_room: Mutex::new(None),
            tasks: Mutex::default(),
            settings: tokio::sync::OnceCell::new(),
            access: tokio::sync::OnceCell::new(),
            commands: tokio::sync::OnceCell::new(),
            typing: Mutex::default(),
            call_available: Mutex::default(),
            avatars: Mutex::default(),
            notification_preference: Mutex::new("default".to_owned()),
            e2e: Mutex::default(),
            custom_emoji: Mutex::default(),
            custom_emoji_names: Mutex::default(),
            once: tokio::sync::OnceCell::new(),
            synced: Arc::default(),
            presence: Mutex::default(),
        });
        let weak = Arc::downgrade(&session);
        session.outbox.set_encryptor(move |rid, payload| weak.upgrade()?.encrypt(rid, payload));
        let weak = Arc::downgrade(&session);
        session.uploads.set_encryptor(move |rid, payload| weak.upgrade()?.encrypt(rid, payload));
        let listener = tokio::spawn(Self::listen(Arc::downgrade(&session), ddp_events));
        let watcher = tokio::spawn(Self::watch_token(Arc::downgrade(&session), session.rest.token_rejected()));
        let progress = tokio::spawn(Self::forward_uploads(Arc::downgrade(&session), session.uploads.changes()));
        session.tasks.lock().unwrap().extend([listener, watcher, progress]);

        session.ddp.open(&session.info.auth_token);
        // The read the user sees: not sequenced behind the socket negotiation.
        session.spawn_catch_up();
        Ok(session)
    }

    pub fn events(&self) -> broadcast::Receiver<SessionEvent> {
        self.events.subscribe()
    }

    pub fn current_room(&self) -> Option<(String, String)> {
        self.current_room.lock().unwrap().clone()
    }

    async fn listen(session: std::sync::Weak<Session>, mut events: tokio::sync::mpsc::UnboundedReceiver<DdpEvent>) {
        let mut attempt: u32 = 0;
        while let Some(event) = events.recv().await {
            let Some(s) = session.upgrade() else { return };
            match event {
                DdpEvent::Changed { collection, key, args } => s.apply_live(&collection, &key, &args),
                DdpEvent::State(state) => {
                    let c = match state {
                        State::Authenticated => Connection::Online,
                        State::Closed => Connection::Offline,
                        _ => Connection::Connecting,
                    };
                    let _ = s.events.send(SessionEvent::Connection(c));
                }
                DdpEvent::Authenticated => {
                    attempt = 0;
                    // The read that GUARANTEES: started once the server armed our
                    // subscriptions, so nothing falls between the two transports.
                    let s2 = s.clone();
                    tokio::spawn(async move {
                        s2.ddp.subscriptions_armed().await;
                        s2.catch_up().await;
                    });
                }
                DdpEvent::Lost => {
                    let base = (1000u64 << attempt.min(5)).min(MAX_RECONNECT_DELAY_MS);
                    let delay = (base + fastrand::u64(0..1000)).min(MAX_RECONNECT_DELAY_MS);
                    attempt += 1;
                    let ddp = s.ddp.clone();
                    let token = s.info.auth_token.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        ddp.open(&token);
                    });
                }
            }
        }
    }

    fn apply_live(self: &Arc<Self>, collection: &str, key: &str, args: &[Value]) {
        if collection == live::STREAM_NOTIFY_LOGGED && key == live::USER_STATUS {
            if let Some((uid, presence)) = live::presence_event(args) {
                self.presence.lock().unwrap().get_or_insert_default().insert(uid, presence);
                let _ = self.events.send(SessionEvent::Presence);
            }
            return;
        }
        if collection == STREAM_NOTIFY_USER && key == format!("{}/{}", self.info.user_id, live::PRIVATE_MESSAGE) {
            if let Some((rid, text)) = live::private_message(args) {
                let _ = self.events.send(SessionEvent::Private { rid, text });
            }
            return;
        }
        if collection == live::STREAM_NOTIFY_LOGGED && key == UPDATE_AVATAR {
            match info::avatar_change(args) {
                Some(info::AvatarChange::User { username, etag }) => {
                    let etag = etag.unwrap_or_else(|| media::NO_PHOTO.to_owned());
                    self.avatars.lock().unwrap().insert(username, etag);
                    let _ = self.events.send(SessionEvent::Avatar);
                }
                Some(info::AvatarChange::Room { rid, etag }) => {
                    let etag = etag.unwrap_or_else(|| media::NO_PHOTO.to_owned());
                    self.store.write(|w| w.set_room_avatar(&rid, &etag));
                }
                None => {}
            }
            return;
        }
        if collection == STREAM_NOTIFY_ROOM
            && let Some(rid) = key.strip_suffix(&format!("/{}", live::USER_ACTIVITY))
        {
            if let Some((user, typing)) = live::activity_event(args) {
                self.typing.lock().unwrap().apply(rid, &user, typing, Instant::now());
                let _ = self.events.send(SessionEvent::Typing(rid.to_owned()));
                if typing {
                    let (weak, rid) = (Arc::downgrade(self), rid.to_owned());
                    tokio::spawn(async move {
                        tokio::time::sleep(live::TYPING_EXPIRY + Duration::from_millis(100)).await;
                        if let Some(s) = weak.upgrade() {
                            let _ = s.events.send(SessionEvent::Typing(rid));
                        }
                    });
                }
            }
            return;
        }
        let incoming = (collection == STREAM_ROOM_MESSAGES).then(|| self.incoming(args)).flatten();
        self.sync.apply_event(collection, key, args);
        if let Some(incoming) = incoming {
            let _ = self.events.send(SessionEvent::Incoming(Box::new(incoming)));
        }
    }

    /// A message nobody showed us yet, from someone else, that the preference wants.
    fn incoming(&self, args: &[Value]) -> Option<crate::notify::Incoming> {
        let m = crate::normalize::to_message(args.first()?)?;
        if m.author_id == self.info.user_id
            || m.edited_at.is_some()
            || (m.system_type.is_some() && m.system_type.as_deref() != Some("e2e"))
            || self.store.has_message(&m.id)
        {
            return None;
        }
        let (room_name, kind) = self.store.room_name(&m.rid)?;
        let encrypted = m.system_type.as_deref() == Some("e2e");
        let incoming = crate::notify::Incoming {
            rid: m.rid.clone(),
            id: m.id.clone(),
            author: m.author_name.clone().unwrap_or_default(),
            room_name,
            direct: kind == "d",
            body: (!encrypted).then(|| crate::notify::body_of(&m)),
            mentions_me: crate::notify::mentions_me(&m, &self.info.username),
        };
        let preference = self.notification_preference.lock().unwrap().clone();
        crate::notify::wanted(&preference, &incoming).then_some(incoming)
    }

    /// Who is typing in the room right now, me left out.
    pub fn typing(&self, rid: &str) -> Vec<String> {
        self.typing.lock().unwrap().who(rid, &self.info.username, Instant::now())
    }

    pub fn presence(&self, uid: &str) -> Option<live::Presence> {
        let presence = self.presence.lock().unwrap();
        presence.as_ref().map(|known| known.get(uid).copied().unwrap_or(live::Presence::Offline))
    }

    /// Everyone's presence at once; the stream then keeps it current.
    async fn load_presence(&self) {
        if let Ok(response) = self.rest.get("users.presence", CallOptions::default()).await {
            let list = live::presence_list(&response);
            self.presence.lock().unwrap().replace(list.into_iter().collect());
            let _ = self.events.send(SessionEvent::Presence);
        }
    }

    /// Whether the server has a video-conference provider. A "no" is kept for
    /// the session; a network failure or a refused token says nothing about it.
    pub async fn call_available(&self) -> bool {
        if let Some(known) = *self.call_available.lock().unwrap() {
            return known;
        }
        match self.rest.get("video-conference.capabilities", CallOptions::default()).await {
            Ok(_) => {
                self.call_available.lock().unwrap().replace(true);
                true
            }
            Err(e) => {
                if e.status != 0 && e.status != 401 {
                    self.call_available.lock().unwrap().replace(false);
                }
                false
            }
        }
    }

    /// A person's photo, with its version when a change was announced.
    pub fn user_avatar(&self, username: &str) -> String {
        let etag = self.avatars.lock().unwrap().get(username).cloned();
        media::avatar_path(media::AvatarTarget::User(username), etag.as_deref())
    }

    pub async fn room_info(&self, rid: &str) -> Result<info::RoomInfo, RestError> {
        let response = self.rest.get("rooms.info", CallOptions::params([("roomId", rid)])).await?;
        response.get("room").and_then(info::room_info).ok_or_else(|| RestError::incomplete("rooms.info: no room"))
    }

    pub async fn room_by_name(&self, name: &str) -> Result<info::RoomInfo, RestError> {
        let response = self.rest.get("rooms.info", CallOptions::params([("roomName", name)])).await?;
        response.get("room").and_then(info::room_info).ok_or_else(|| RestError::incomplete("rooms.info: no room"))
    }

    /// By username, or by id when `by_id`.
    pub async fn profile(&self, key: &str, by_id: bool) -> Result<info::Profile, RestError> {
        let param = if by_id { "userId" } else { "username" };
        let response = self.rest.get("users.info", CallOptions::params([(param, key)])).await?;
        let profile =
            response.get("user").and_then(info::profile).ok_or_else(|| RestError::incomplete("users.info: no user"))?;
        if let Some(etag) = &profile.avatar_etag {
            self.avatars.lock().unwrap().insert(profile.username.clone(), etag.clone());
        }
        Ok(profile)
    }

    pub async fn search(&self, rid: &str, text: &str) -> Result<Vec<crate::normalize::Message>, RestError> {
        let options = CallOptions::params([("roomId", rid), ("searchText", text), ("count", "50")]);
        Ok(info::search_results(&self.rest.get("chat.search", options).await?))
    }

    /// Opens my private key with the E2E password. The password is not kept;
    /// the key is, by the app, through `e2e_export`.
    pub async fn e2e_unlock(&self, password: &str) -> Result<(), UnlockError> {
        let keys = self.rest.get("e2e.fetchMyKeys", CallOptions::default()).await.map_err(UnlockError::Server)?;
        let private = keys.get("private_key").and_then(Value::as_str).unwrap_or_default();
        let (key, jwk) =
            crate::e2e::unlock_private_key_jwk(private, password, &self.info.user_id).map_err(UnlockError::Key)?;
        self.unlocked_with(key, jwk);
        Ok(())
    }

    /// Unlocks with a key kept from an earlier session. False when it does not import.
    pub fn e2e_resume(&self, jwk: &str) -> bool {
        if self.e2e_unlocked() {
            return true;
        }
        let Ok(key) = crate::e2e::import_private_key(jwk) else { return false };
        self.unlocked_with(key, jwk.to_owned());
        true
    }

    /// My private key as a JWK, while unlocked.
    pub fn e2e_export(&self) -> Option<String> {
        self.e2e.lock().unwrap().as_ref().map(|u| u.jwk.clone())
    }

    fn unlocked_with(&self, key: crate::e2e::PrivateKey, jwk: String) {
        self.e2e.lock().unwrap().replace(E2eUnlocked { key, jwk, rooms: HashMap::new() });
        let _ = self.events.send(SessionEvent::E2e);
        let (outbox, uploads) = (self.outbox.clone(), self.uploads.clone());
        tokio::spawn(async move { outbox.process().await });
        tokio::spawn(async move { uploads.process().await });
    }

    pub fn e2e_lock(&self) {
        if self.e2e.lock().unwrap().take().is_some() {
            let _ = self.events.send(SessionEvent::E2e);
        }
    }

    pub fn e2e_unlocked(&self) -> bool {
        self.e2e.lock().unwrap().is_some()
    }

    /// The room's key id and AES key, when unlocked and my wrapped copy opens.
    fn room_key(&self, rid: &str) -> Option<(String, Vec<u8>)> {
        let mut guard = self.e2e.lock().unwrap();
        let unlocked = guard.as_mut()?;
        let wrapped = self.store.e2e_key(rid)?;
        let kid = crate::e2e::key_id(&wrapped).to_owned();
        if unlocked.rooms.get(rid).is_none_or(|(known, _)| *known != kid) {
            let key = crate::e2e::room_key(&wrapped, &unlocked.key).ok()?;
            unlocked.rooms.insert(rid.to_owned(), (kid, key));
        }
        unlocked.rooms.get(rid).cloned()
    }

    /// An encrypted `content` of the room in clear, when unlocked and the key fits.
    pub fn decrypt(&self, rid: &str, content: &str) -> Option<String> {
        self.decrypt_payload(rid, content).map(|p| p.text)
    }

    /// The text of an encrypted `content`, and the attachments of a file.
    pub fn decrypt_payload(&self, rid: &str, content: &str) -> Option<crate::e2e::Payload> {
        crate::e2e::decrypt_payload(content, &self.room_key(rid)?.1).ok()
    }

    /// A row as it reads: an encrypted one opened when unlocked (its text, and
    /// the attachments of a file, whose keys the media cache learns), closed
    /// when locked. My message still in the outbox keeps its own text.
    pub fn open_row(&self, mut row: crate::store::MessageRow) -> crate::store::MessageRow {
        if row.system_type.as_deref() != Some(crate::normalize::ENCRYPTED_TYPE) {
            return row;
        }
        let Some(raw) = row.encrypted_raw.as_deref() else { return row };
        let payload = self.decrypt_payload(&row.rid, raw);
        let attachments = payload.as_ref().and_then(|p| p.attachments.as_ref());
        if let Some(attachments) = attachments {
            self.media.learn_keys(attachments);
        }
        row.attachments = attachments.map(Value::to_string);
        row.text = payload.map(|p| p.text);
        row
    }

    /// A payload encrypted under the room's current key, or None while locked.
    pub fn encrypt(&self, rid: &str, payload: &Value) -> Option<Value> {
        let (kid, key) = self.room_key(rid)?;
        crate::e2e::encrypt_message(payload, &key, &kid).ok()
    }

    /// The server path of a custom emoji's image.
    pub fn custom_emoji(&self, code: &str) -> Option<String> {
        self.custom_emoji.lock().unwrap().get(code).cloned()
    }

    /// Every custom emoji, once each, by name.
    pub fn custom_emoji_names(&self) -> Vec<String> {
        self.custom_emoji_names.lock().unwrap().clone()
    }

    /// Custom shortcodes starting with `prefix`, sorted.
    pub fn custom_emoji_codes(&self, prefix: &str) -> Vec<String> {
        let mut codes: Vec<String> =
            self.custom_emoji.lock().unwrap().keys().filter(|k| k.starts_with(prefix)).cloned().collect();
        codes.sort();
        codes
    }

    pub async fn me(&self) -> Result<crate::account::Me, RestError> {
        Ok(crate::account::me(&self.rest.get("me", CallOptions::default()).await?))
    }

    /// Both at once: `users.setStatus` clears whichever one is left out.
    pub async fn set_status(&self, status: &str, message: &str) -> Result<(), RestError> {
        let body = json!({"status": status, "message": message});
        self.rest.post("users.setStatus", CallOptions::body(body)).await.map(|_| ())
    }

    /// `password` is the plain current password (hashed here) when username
    /// or email change; a 2FA challenge comes back as the error's `two_factor`.
    pub async fn update_basic_info(
        &self,
        mut data: serde_json::Map<String, Value>,
        password: Option<&str>,
        two_factor: Option<TwoFactorCode>,
    ) -> Result<(), RestError> {
        if let Some(password) = password {
            data.insert("currentPassword".into(), json!(two_factor_code("password", password).code));
        }
        let options = CallOptions { body: Some(json!({"data": data})), two_factor, ..Default::default() };
        self.rest.post("users.updateOwnBasicInfo", options).await.map(|_| ())
    }

    pub async fn set_avatar(&self, file: &Path, mime: &str) -> Result<(), RestError> {
        let bytes = tokio::fs::read(file).await.map_err(|e| RestError::incomplete(&e.to_string()))?;
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "avatar".into());
        self.rest.upload("users.setAvatar", "image", bytes, &name, mime, Vec::new(), |_, _| {}).await.map(|_| ())
    }

    pub async fn reset_avatar(&self) -> Result<(), RestError> {
        self.rest.post("users.resetAvatar", CallOptions::body(json!({}))).await.map(|_| ())
    }

    pub async fn set_preference(&self, key: &str, value: Value) -> Result<(), RestError> {
        let body = json!({"data": {key: value}});
        self.rest.post("users.setPreferences", CallOptions::body(body)).await?;
        if key == "desktopNotifications"
            && let Some(v) = value.as_str()
        {
            *self.notification_preference.lock().unwrap() = v.to_owned();
        }
        Ok(())
    }

    pub async fn spotlight(&self, query: &str) -> Result<Vec<crate::rooms::Found>, RestError> {
        let response = self.rest.get("spotlight", CallOptions::params([("query", query)])).await?;
        Ok(crate::rooms::spotlight_results(&response))
    }

    /// The DM with this user, created if needed; returns its rid once the
    /// store has it, so it can be opened at once.
    pub async fn open_dm(&self, username: &str) -> Result<String, RestError> {
        let response = self.rest.post("im.create", CallOptions::body(json!({"username": username}))).await?;
        let rid = response
            .pointer("/room/_id")
            .or_else(|| response.pointer("/room/rid"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| RestError::incomplete("im.create: no room"))?;
        self.sync.catch_up_global().await?;
        Ok(rid)
    }

    pub async fn join_channel(&self, rid: &str) -> Result<(), RestError> {
        self.rest.post("channels.join", CallOptions::body(json!({"roomId": rid}))).await?;
        self.sync.catch_up_global().await
    }

    pub async fn mark_read(&self, rid: &str) {
        let _ = self.rest.post("subscriptions.read", CallOptions::body(json!({"rid": rid}))).await;
    }

    async fn forward_uploads(session: std::sync::Weak<Session>, mut changes: broadcast::Receiver<String>) {
        loop {
            match changes.recv().await {
                Ok(rid) => {
                    let Some(s) = session.upgrade() else { return };
                    let _ = s.events.send(SessionEvent::Upload(rid));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }

    /// Checks the file against the server's rules, queues it and starts sending.
    pub async fn attach(
        self: &Arc<Self>,
        rid: &str,
        file: &std::path::Path,
        name: &str,
        mime: &str,
        caption: Option<&str>,
        temporary: bool,
    ) -> Result<(), uploads::Refusal> {
        let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
        uploads::validate(self.settings().await, size, mime, self.store.room_encrypted(rid))?;
        self.uploads.enqueue(rid, &file.to_string_lossy(), name, mime, caption, temporary);
        let uploads = self.uploads.clone();
        tokio::spawn(async move { uploads.process().await });
        Ok(())
    }

    async fn watch_token(session: std::sync::Weak<Session>, mut rejected: broadcast::Receiver<String>) {
        while let Ok(token) = rejected.recv().await {
            let Some(s) = session.upgrade() else { return };
            if token == s.info.auth_token {
                let _ = s.events.send(SessionEvent::Expired);
                return;
            }
        }
    }

    pub fn spawn_catch_up(self: &Arc<Self>) {
        let s = self.clone();
        tokio::spawn(async move { s.catch_up().await });
    }

    async fn catch_up(&self) {
        if self.sync.catch_up_global().await.is_ok() {
            self.outbox.process().await;
            self.uploads.process().await;
        }
        self.load_presence().await;
        self.once.get_or_init(|| self.once_per_session()).await;
        if let Some((rid, kind)) = self.current_room() {
            let _ = self.sync.load_history(&rid, &kind, None).await;
            if self.sync.catch_up_room(&rid).await.is_ok() {
                self.synced.lock().unwrap().insert(rid);
            }
        }
    }

    /// What does not change from one reconnection to the next: read once,
    /// the REST budget being ten calls a minute.
    async fn once_per_session(&self) {
        if let Ok(list) = self.rest.get("emoji-custom.list", CallOptions::default()).await {
            let index = crate::emoji::custom_index(&list);
            *self.custom_emoji_names.lock().unwrap() = crate::emoji::custom_names(&index);
            self.custom_emoji.lock().unwrap().extend(index);
            let _ = self.events.send(SessionEvent::Avatar);
        }
        if let Ok(me) = self.me().await {
            *self.notification_preference.lock().unwrap() = me.desktop_notifications;
        }
        let _ = self.sync.reconcile_rooms().await;
    }

    pub fn reconnect_now(&self) {
        self.ddp.open(&self.info.auth_token);
    }

    /// Switches the open room and loads its latest page.
    pub async fn open_room(&self, rid: &str, kind: &str) -> Result<HistoryPage, RestError> {
        let previous = self.current_room.lock().unwrap().replace((rid.to_owned(), kind.to_owned()));
        if let Some((old, _)) = previous {
            self.ddp.unsubscribe(STREAM_NOTIFY_ROOM, &format!("{old}/deleteMessage"));
            self.ddp.unsubscribe(STREAM_NOTIFY_ROOM, &format!("{old}/{}", live::USER_ACTIVITY));
            self.typing.lock().unwrap().clear(&old);
        }
        // Deletions are not on `__my_messages__`: they stay per room.
        self.ddp.subscribe(STREAM_NOTIFY_ROOM, &format!("{rid}/deleteMessage"));
        self.ddp.subscribe(STREAM_NOTIFY_ROOM, &format!("{rid}/{}", live::USER_ACTIVITY));
        let rest = self.rest.clone();
        let read = CallOptions::body(json!({"rid": rid}));
        tokio::spawn(async move {
            let _ = rest.post("subscriptions.read", read).await;
        });
        let page = self.sync.load_history(rid, kind, None).await;
        if !self.synced.lock().unwrap().contains(rid) {
            let (sync, rid) = (self.sync.clone(), rid.to_owned());
            let synced = self.synced.clone();
            tokio::spawn(async move {
                if sync.catch_up_room(&rid).await.is_ok() {
                    synced.lock().unwrap().insert(rid);
                }
            });
        }
        page
    }

    pub async fn send(&self, rid: &str, text: &str) {
        let text = crate::compose::fenced(text.trim());
        if text.is_empty() {
            return;
        }
        self.outbox.enqueue(rid, &text, None);
        self.outbox.process().await;
    }

    pub async fn retry(&self, id: &str) {
        self.outbox.retry(id);
        self.outbox.process().await;
    }

    /// Best effort: the local state is logged out whatever the server says.
    pub async fn logout(&self) {
        self.shutdown();
        let _ = self.rest.post("logout", CallOptions::default()).await;
    }

    /// The server's public settings, read once per session.
    pub async fn settings(&self) -> &ServerSettings {
        self.settings.get_or_init(|| ServerSettings::fetch(&self.rest)).await
    }

    /// The message-action permissions I hold in the room: from my global roles
    /// and my roles there. None when the server could not be asked.
    pub async fn permissions(&self, rid: &str) -> Option<Vec<String>> {
        let access = self
            .access
            .get_or_try_init(|| async {
                let (all, me) = tokio::try_join!(
                    self.rest.get("permissions.listAll", CallOptions::default()),
                    self.rest.get("me", CallOptions::default()),
                )?;
                let roles = me
                    .get("roles")
                    .and_then(Value::as_array)
                    .map(|r| r.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                    .unwrap_or_default();
                Ok::<_, RestError>((actions::permission_roles(&all), roles))
            })
            .await;
        let (permissions, global) = access.ok()?;
        let mut roles = global.clone();
        roles.extend(self.store.room_roles(rid));
        Some(actions::granted(permissions, &roles))
    }

    /// The server's slash commands, read once per session.
    pub async fn commands(&self) -> Result<&[crate::commands::Command], RestError> {
        let commands = self
            .commands
            .get_or_try_init(|| async {
                let list = self.rest.get("commands.list", CallOptions::params([("count", "0")])).await?;
                Ok::<_, RestError>(crate::commands::parse_list(&list, crate::i18n::current()))
            })
            .await?;
        Ok(commands)
    }

    /// Runs `text` as a slash command when it names one the server knows;
    /// None when it is a message to send. Its answer, if any, comes as
    /// `SessionEvent::Private`.
    pub async fn run_command(&self, rid: &str, text: &str, thread_id: Option<&str>) -> Option<Result<(), RestError>> {
        let (name, params) = crate::commands::split(text)?;
        let known = self.commands().await.ok()?.iter().any(|c| c.name == name);
        if !known {
            return None;
        }
        let mut body = json!({
            "command": name,
            "roomId": rid,
            "params": params,
            "triggerId": format!("{:016x}", fastrand::u64(..)),
        });
        if let Some(tmid) = thread_id {
            body["tmid"] = json!(tmid);
        }
        Some(self.rest.post("commands.run", CallOptions::body(body)).await.map(|_| ()))
    }

    /// The permalink the server recognises: built on `Site_Url`, else on our base URL.
    pub async fn permalink(&self, kind: &str, slug: Option<&str>, rid: &str, msg_id: &str) -> String {
        let base = self.settings().await.site_url.clone().unwrap_or_else(|| self.info.base_url.clone());
        actions::permalink(&base, kind, slug, rid, msg_id)
    }

    pub async fn react(&self, msg_id: &str, shortcode: &str, add: bool) -> Result<(), RestError> {
        actions::react(&self.rest, msg_id, shortcode, add).await
    }

    pub async fn edit(&self, rid: &str, msg_id: &str, text: &str) -> Result<(), RestError> {
        let text = &crate::compose::fenced(text);
        let doc = if self.store.message_type(msg_id).as_deref() == Some(crate::normalize::ENCRYPTED_TYPE) {
            let content = self
                .encrypt(rid, &serde_json::json!({"msg": text}))
                .ok_or_else(|| RestError::incomplete("chat.update: room key unavailable"))?;
            actions::edit_encrypted(&self.rest, rid, msg_id, content, crate::e2e::mentions(text)).await?
        } else {
            actions::edit(&self.rest, rid, msg_id, text).await?
        };
        if doc.is_object() {
            self.sync.ingest_messages(std::slice::from_ref(&doc));
        }
        Ok(())
    }

    pub async fn delete(&self, rid: &str, msg_id: &str) -> Result<(), RestError> {
        actions::delete(&self.rest, rid, msg_id).await?;
        self.store.write(|w| w.delete_message(msg_id));
        Ok(())
    }

    /// Stars a room, or takes the star away: it moves to the Favorites section.
    pub async fn set_favorite(&self, rid: &str, on: bool) -> Result<(), RestError> {
        actions::favorite(&self.rest, rid, on).await?;
        self.store.write(|w| w.set_favorite(rid, on));
        Ok(())
    }

    pub async fn pin(&self, msg_id: &str) -> Result<(), RestError> {
        actions::pin(&self.rest, msg_id).await?;
        self.refresh_message(msg_id).await;
        Ok(())
    }

    pub async fn unpin(&self, msg_id: &str) -> Result<(), RestError> {
        actions::unpin(&self.rest, msg_id).await?;
        self.refresh_message(msg_id).await;
        Ok(())
    }

    pub async fn star(&self, msg_id: &str, on: bool) -> Result<(), RestError> {
        actions::star(&self.rest, msg_id, on).await?;
        self.refresh_message(msg_id).await;
        Ok(())
    }

    /// The server's copy of a message, stored: the stream does not always
    /// carry a change of its pin or its stars.
    async fn refresh_message(&self, msg_id: &str) {
        if let Ok(response) = self.rest.get("chat.getMessage", CallOptions::params([("msgId", msg_id)])).await
            && let Some(doc) = response.get("message")
        {
            self.sync.ingest_messages(std::slice::from_ref(doc));
        }
    }

    /// A room's pinned messages, or the ones I starred there, newest first; stored as they come.
    pub async fn marked(&self, rid: &str, starred: bool) -> Result<Vec<crate::store::MessageRow>, RestError> {
        let docs = actions::marked(&self.rest, rid, starred).await?;
        self.sync.ingest_messages(&docs);
        let ids: Vec<String> =
            docs.iter().filter_map(|d| d.get("_id").and_then(Value::as_str)).map(str::to_owned).collect();
        Ok(self.store.messages_by_id(&ids))
    }

    /// Writes a server file to `dest`, through a temporary name so a failed
    /// transfer never leaves a truncated file where a complete one is expected.
    pub async fn download_to(&self, path_or_url: &str, dest: &std::path::Path) -> Result<(), RestError> {
        self.download_with_progress(path_or_url, dest, |_| {}).await
    }

    /// The file streamed to disk, reporting the bytes received; a file of an
    /// encrypted room is deciphered once whole.
    pub async fn download_with_progress(
        &self,
        path_or_url: &str,
        dest: &std::path::Path,
        progress: impl Fn(u64) + Send,
    ) -> Result<(), RestError> {
        let partial = dest.with_extension("part");
        let written = |e: std::io::Error| RestError::incomplete(&format!("{}: {e}", dest.display()));
        let result = async {
            self.rest.download_protected(path_or_url, &partial, progress).await?;
            if self.media.encrypted(path_or_url) {
                let bytes = self.media.open(path_or_url, std::fs::read(&partial).map_err(written)?)?;
                std::fs::write(&partial, bytes).map_err(written)?;
            }
            std::fs::rename(&partial, dest).map_err(written)
        }
        .await;
        if result.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        result
    }

    pub async fn start_call(&self, rid: &str) -> Result<String, RestError> {
        let call_id = actions::start_call(&self.rest, rid).await?;
        actions::join_call(&self.rest, &call_id).await
    }

    pub async fn join_call(&self, call_id: &str) -> Result<String, RestError> {
        actions::join_call(&self.rest, call_id).await
    }

    /// The meeting's link to share, without anyone's token.
    pub async fn call_link(&self, call_id: &str) -> Result<String, RestError> {
        let url = match actions::call_url(&self.rest, call_id).await? {
            Some(url) => url,
            None => actions::join_call(&self.rest, call_id).await?,
        };
        Ok(crate::call::meeting_link(&url))
    }

    /// The root (`chat.getThreadMessages` never returns it) then every reply,
    /// by full pages: `count: 0` depends on `API_Allow_Infinite_Count`.
    pub async fn load_thread(&self, root_id: &str) -> Result<(), RestError> {
        const PAGE: usize = 100;
        const MAX_PAGES: usize = 20;
        if let Ok(root) = self.rest.get("chat.getMessage", CallOptions::params([("msgId", root_id)])).await
            && let Some(doc) = root.get("message")
        {
            self.sync.ingest_messages(std::slice::from_ref(doc));
        }
        for page in 0..MAX_PAGES {
            let options = CallOptions::params([
                ("tmid", root_id.to_owned()),
                ("count", PAGE.to_string()),
                ("offset", (page * PAGE).to_string()),
            ]);
            let response = self.rest.get("chat.getThreadMessages", options).await?;
            let batch = response.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
            self.sync.ingest_messages(&batch);
            if batch.len() < PAGE {
                break;
            }
        }
        Ok(())
    }

    /// Sends into a thread when `thread_id` is set.
    pub async fn send_in(&self, rid: &str, text: &str, thread_id: Option<&str>) {
        let text = crate::compose::fenced(text.trim());
        if text.is_empty() {
            return;
        }
        self.outbox.enqueue(rid, &text, thread_id);
        self.outbox.process().await;
    }

    pub fn shutdown(&self) {
        self.ddp.close();
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_input_is_normalized() {
        assert_eq!(normalize_server("chat.example.com/").unwrap().as_str(), "https://chat.example.com/");
        assert_eq!(normalize_server(" http://localhost:3000 ").unwrap().as_str(), "http://localhost:3000/");
        assert!(normalize_server("").is_none());
    }

    #[test]
    fn websocket_url_follows_scheme_and_path() {
        assert_eq!(websocket_url(&"https://a.b/chat".parse().unwrap()).as_str(), "wss://a.b/chat/websocket");
        assert_eq!(websocket_url(&"http://localhost:3000".parse().unwrap()).as_str(), "ws://localhost:3000/websocket");
    }

    #[test]
    fn password_method_hashes() {
        assert_eq!(
            two_factor_code("password", "secret").code,
            "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b"
        );
        assert_eq!(two_factor_code("totp", " 123456 ").code, "123456");
    }
}
