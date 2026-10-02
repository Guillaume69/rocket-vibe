//! Native desktop pilot: pinned identity, durable SQLite projection and a single replay loop.
pub mod authentication;
pub mod authentication_vault;
pub mod credentials;
pub mod email_recovery;
pub mod factor_email;
pub mod markdown;
mod read_intents;
pub mod read_presentation;
mod room_operations;
pub use room_operations::{
    ChangeRoomRole, LeaveRoom, RoomDetails, RoomMemberPage, RoomRole, UpdateRoom, room_operation_id,
};
pub mod security;
pub mod store;

use crate::rest::RestError;
use crate::session::{Connection, SessionInfo};
use futures_util::StreamExt;
use rv_client::NativeClient;
pub use rv_protocol::{Discovery, Room, RoomKind};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::sync::{Notify, broadcast, watch};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub instance_id: String,
    pub data_epoch: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReactionIntent {
    emoji: String,
    present: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Network(#[from] rv_client::Error),
    #[error(transparent)]
    Local(#[from] rusqlite::Error),
    #[error("{0}")]
    Protocol(&'static str),
}
impl Error {
    pub fn code(&self) -> &str {
        match self {
            Self::Network(rv_client::Error::Server { code, .. }) => code,
            Self::Protocol(code) => code,
            _ => "connection_failed",
        }
    }
    fn terminal(&self) -> bool {
        matches!(self.code(), "server_identity_changed" | "session_rejected")
    }
}
pub fn rest_error(error: Error) -> RestError {
    let (request_id, retry_after) = diagnostics(&error);
    let status = match &error {
        Error::Network(rv_client::Error::Server { status, .. }) => *status,
        Error::Protocol(_) => 409,
        _ => 0,
    };
    RestError {
        status,
        message: error.to_string(),
        error: Some(error.code().into()),
        error_type: None,
        understood: matches!(&error, Error::Network(rv_client::Error::Server { .. })),
        two_factor: None,
        request_id,
        retry_after,
    }
}

fn diagnostics(error: &Error) -> (Option<String>, Option<u64>) {
    match error {
        Error::Network(rv_client::Error::Server { request_id, retry_after, .. }) => (request_id.clone(), *retry_after),
        _ => (None, None),
    }
}

/// Absence may fall back to RC; a positively identified incompatible native protocol never does.
pub async fn probe(base: &url::Url) -> Result<Option<Discovery>, Error> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::Protocol("invalid_client"))?;
    let response = client
        .get(format!("{}/.well-known/rocketvibe", base.as_str().trim_end_matches('/')))
        .send()
        .await
        .map_err(|_| Error::Protocol("discovery_unavailable"))?;
    if matches!(response.status().as_u16(), 404 | 410) {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(Error::Protocol("discovery_unavailable"));
    }
    let body = response.text().await.map_err(|_| Error::Protocol("discovery_unavailable"))?;
    let native = serde_json::from_str::<Value>(&body).ok().is_some_and(|v| v["product"] == "rocketvibe");
    if !native {
        return Ok(None);
    }
    Ok(Some(NativeClient::new(base.as_str())?.discover().await?))
}
pub async fn login(
    base: &url::Url,
    discovery: &Discovery,
    username: &str,
    password: &str,
) -> Result<SessionInfo, Error> {
    let mut client = NativeClient::new(base.as_str())?;
    let fresh = client.discover().await?;
    let identity = Identity { instance_id: discovery.instance_id.clone(), data_epoch: discovery.data_epoch.clone() };
    check(&identity, &fresh)?;
    let session = client.login(username, password).await?;
    check(&identity, &client.discover().await?)?;
    Ok(SessionInfo {
        base_url: base.as_str().trim_end_matches('/').into(),
        user_id: session.user.id,
        username: session.user.username,
        auth_token: session.token,
        native: Some(identity),
    })
}
/// Invitation/password stay transient. Normal login follows account creation.
pub async fn register(
    base: &url::Url,
    discovery: &Discovery,
    token: &str,
    username: &str,
    password: &str,
) -> Result<SessionInfo, Error> {
    account_code_login(base, discovery, token, username, password, false).await
}
pub async fn recover(
    base: &url::Url,
    discovery: &Discovery,
    token: &str,
    username: &str,
    password: &str,
) -> Result<SessionInfo, Error> {
    account_code_login(base, discovery, token, username, password, true).await
}
async fn account_code_login(
    base: &url::Url,
    discovery: &Discovery,
    token: &str,
    username: &str,
    password: &str,
    recovery: bool,
) -> Result<SessionInfo, Error> {
    let client = NativeClient::new(base.as_str())?;
    let identity = Identity { instance_id: discovery.instance_id.clone(), data_epoch: discovery.data_epoch.clone() };
    let fresh = client.discover().await?;
    check(&identity, &fresh)?;
    if !(if recovery { fresh.capabilities.account_recovery } else { fresh.capabilities.account_invitations }) {
        return Err(Error::Protocol(if recovery { "recovery_unavailable" } else { "invitation_unavailable" }));
    }
    let user = if recovery {
        client
            .recover_account(&rv_protocol::parity::RecoverAccount {
                token: token.into(),
                username: username.into(),
                new_password: password.into(),
            })
            .await?
    } else {
        client
            .accept_invitation(&rv_protocol::parity::AcceptInvitation {
                token: token.into(),
                username: username.into(),
                password: password.into(),
            })
            .await?
    };
    check(&identity, &client.discover().await?)?;
    let info = login(base, discovery, username, password).await?;
    if info.user_id != user.id {
        return Err(Error::Protocol("server_identity_changed"));
    }
    Ok(info)
}

fn check(identity: &Identity, discovery: &Discovery) -> Result<(), Error> {
    if identity.instance_id != discovery.instance_id || identity.data_epoch != discovery.data_epoch {
        return Err(Error::Protocol("server_identity_changed"));
    }
    Ok(())
}

impl SessionInfo {
    pub fn from_secret(value: &Value) -> Option<Self> {
        let field = |key: &str| value[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
        let native = match value.get("genre") {
            None => None,
            Some(Value::String(kind)) if kind == "rocketchat" => None,
            Some(Value::String(kind)) if kind == "rocketvibe" => {
                Some(Identity { instance_id: field("nativeInstanceId")?, data_epoch: field("nativeDataEpoch")? })
            }
            _ => return None,
        };
        let base_url = field("baseUrl")?;
        NativeClient::new(&base_url).ok()?;
        Some(Self {
            base_url,
            user_id: field("userId")?,
            username: field("username").unwrap_or_default(),
            auth_token: field("authToken")?,
            native,
        })
    }
    pub fn secret(&self) -> Value {
        let mut value = json!({"baseUrl":self.base_url,"userId":self.user_id,"username":self.username,"authToken":self.auth_token,"genre":if self.native.is_some() {"rocketvibe"} else {"rocketchat"}});
        if let Some(identity) = &self.native {
            value["nativeInstanceId"] = json!(identity.instance_id);
            value["nativeDataEpoch"] = json!(identity.data_epoch);
        }
        value
    }
}
pub fn database_name(info: &SessionInfo) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{}|{}", info.base_url, info.user_id).as_bytes());
    format!("native-{}.sqlite", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

#[derive(Debug, Clone)]
pub struct Status {
    pub connection: Connection,
    pub error: Option<String>,
    pub request_id: Option<String>,
    pub retry_after: Option<u64>,
}
pub struct NativeSession {
    pub info: SessionInfo,
    pub store: Arc<store::NativeStore>,
    client: NativeClient,
    status: Mutex<Status>,
    capabilities: Mutex<Option<rv_protocol::Capabilities>>,
    events: broadcast::Sender<()>,
    control: watch::Sender<u64>,
    wake: Notify,
    paused: AtomicBool,
    verified: AtomicBool,
    closed: AtomicBool,
    command_lock: tokio::sync::Mutex<()>,
    room_access_lock: tokio::sync::Mutex<()>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    credentials: Option<Arc<dyn credentials::Provider>>,
    security_generation: AtomicU64,
    state_intent_lock: tokio::sync::Mutex<()>,
    read_retry: Mutex<Option<tokio::time::Instant>>,
    favorite_retry: Mutex<Option<tokio::time::Instant>>,
}
impl NativeSession {
    pub fn start(info: SessionInfo, path: &Path) -> Result<Arc<Self>, Error> {
        Self::start_with_credentials(info, path, None)
    }
    pub fn start_with_credentials(
        info: SessionInfo,
        path: &Path,
        credentials: Option<Arc<dyn credentials::Provider>>,
    ) -> Result<Arc<Self>, Error> {
        let identity = info.native.clone().ok_or(Error::Protocol("native_identity_missing"))?;
        let store = Arc::new(store::NativeStore::open(path, identity)?);
        let mut client = NativeClient::new(&info.base_url)?;
        client.restore(info.auth_token.clone());
        let (events, _) = broadcast::channel(32);
        let (control, mut changed) = watch::channel(0);
        let session = Arc::new(Self {
            info,
            store,
            client,
            status: Mutex::new(Status {
                connection: Connection::Offline,
                error: None,
                request_id: None,
                retry_after: None,
            }),
            capabilities: Mutex::new(None),
            events,
            control,
            wake: Notify::new(),
            paused: AtomicBool::new(false),
            verified: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            command_lock: tokio::sync::Mutex::new(()),
            room_access_lock: tokio::sync::Mutex::new(()),
            task: Mutex::new(None),
            credentials,
            security_generation: AtomicU64::new(0),
            state_intent_lock: tokio::sync::Mutex::new(()),
            read_retry: Mutex::new(None),
            favorite_retry: Mutex::new(None),
        });
        let weak = Arc::downgrade(&session);
        let task = tokio::spawn(async move {
            let mut attempt = 0u32;
            loop {
                let Some(s) = weak.upgrade() else { return };
                if s.paused.load(Ordering::SeqCst) {
                    if changed.changed().await.is_err() {
                        return;
                    };
                    continue;
                }
                s.set_status(Connection::Connecting, None);
                let result = tokio::select! {result=s.cycle()=>Some(result), _=changed.changed()=>None};
                s.security_generation.fetch_add(1, Ordering::SeqCst);
                s.verified.store(false, Ordering::SeqCst);
                if let Some(Err(error)) = result {
                    let terminal = error.terminal();
                    s.set_failure(&error);
                    if terminal {
                        s.paused.store(true, Ordering::SeqCst);
                        s.closed.store(true, Ordering::SeqCst);
                        return;
                    }
                    let delay =
                        Duration::from_millis(((1000u64 << attempt.min(5)) + fastrand::u64(0..1000)).min(30_000));
                    attempt += 1;
                    tokio::select! {_=tokio::time::sleep(delay)=>{},_=changed.changed()=>{attempt=0;}};
                } else {
                    attempt = 0;
                    s.set_status(Connection::Offline, None);
                }
            }
        });
        *session.task.lock().unwrap() = Some(task);
        Ok(session)
    }
    pub fn events(&self) -> broadcast::Receiver<()> {
        self.events.subscribe()
    }
    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
    pub fn credential_info(&self) -> SessionInfo {
        let mut info = self.info.clone();
        if let Some(token) = self.client.saved_token() {
            info.auth_token = token;
        }
        info
    }
    fn set_status(&self, connection: Connection, error: Option<String>) {
        *self.status.lock().unwrap() = Status { connection, error, request_id: None, retry_after: None };
        let _ = self.events.send(());
    }
    fn set_failure(&self, error: &Error) {
        let (request_id, retry_after) = diagnostics(error);
        *self.status.lock().unwrap() =
            Status { connection: Connection::Offline, error: Some(error.code().into()), request_id, retry_after };
        let _ = self.events.send(());
    }
    fn signal(&self) {
        self.control.send_modify(|n| *n = n.wrapping_add(1));
    }
    pub fn suspend(&self) {
        self.security_generation.fetch_add(1, Ordering::SeqCst);
        self.paused.store(true, Ordering::SeqCst);
        self.verified.store(false, Ordering::SeqCst);
        self.signal();
    }
    pub fn reconnect(&self) {
        self.security_generation.fetch_add(1, Ordering::SeqCst);
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        if self.status().error.as_deref() == Some("server_identity_changed") {
            return;
        }
        self.paused.store(false, Ordering::SeqCst);
        self.verified.store(false, Ordering::SeqCst);
        self.set_status(Connection::Connecting, None);
        self.signal();
    }
    pub fn shutdown(&self) {
        self.security_generation.fetch_add(1, Ordering::SeqCst);
        self.closed.store(true, Ordering::SeqCst);
        self.paused.store(true, Ordering::SeqCst);
        self.verified.store(false, Ordering::SeqCst);
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        self.set_status(Connection::Offline, None);
    }
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
    async fn identity(&self) -> Result<(), Error> {
        let discovery = self.client.discover().await?;
        check(self.info.native.as_ref().unwrap(), &discovery)?;
        *self.capabilities.lock().unwrap() = Some(discovery.capabilities);
        Ok(())
    }
    pub fn supported_features(&self) -> Vec<String> {
        // Advance this mask only together with the corresponding client handlers.
        self.capabilities
            .lock()
            .unwrap()
            .as_ref()
            .map(|server| {
                server.supported_features(&rv_protocol::Capabilities {
                    room_discovery: true,
                    room_info: true,
                    room_settings: true,
                    room_roles: true,
                    room_leave: true,
                    favorites: true,
                    read_markers: true,
                    editing: true,
                    deletion: true,
                    reactions: true,
                    pins: true,
                    stars: true,
                    fine_permissions: true,
                    session_rotation: self.credentials.is_some(),
                    device_sessions: true,
                    ..Default::default()
                })
            })
            .unwrap_or_default()
    }
    async fn snapshot(&self) -> Result<(), Error> {
        let snapshot = self.client.snapshot().await?;
        self.identity().await?;
        self.store.snapshot(&snapshot)?;
        Ok(())
    }
    async fn refresh_credentials(&self) -> Result<(), Error> {
        if let Some(credentials) = &self.credentials {
            let fresh = credentials.resume(self.credential_info()).await?;
            if fresh.base_url != self.info.base_url
                || fresh.user_id != self.info.user_id
                || fresh.native != self.info.native
            {
                return Err(Error::Protocol("server_identity_changed"));
            }
            self.client.update_token(fresh.auth_token);
        }
        Ok(())
    }
    async fn cycle(&self) -> Result<(), Error> {
        self.identity().await?;
        self.refresh_credentials().await?;
        if self.client.me().await?.id != self.info.user_id {
            return Err(Error::Protocol("session_rejected"));
        }
        if let Some(mut cursor) = self.store.cursor()? {
            loop {
                match self.client.changes(&cursor).await {
                    Ok(batch) => {
                        self.store.batch(&batch)?;
                        cursor = batch.cursor;
                        if !batch.has_more {
                            break;
                        }
                    }
                    Err(rv_client::Error::Server { code, .. }) if code == "sync_reset_required" => {
                        self.identity().await?;
                        self.snapshot().await?;
                        break;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        } else {
            self.snapshot().await?;
        }
        // Before replaying any old intention, upgrade an unstamped cache from
        // the authoritative snapshot. A missed withdrawal cannot be inferred
        // from an HTTP state response or from room metadata alone.
        let upgrade_read_cache = self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.read_markers)
            && self.store.rooms()?.iter().any(|r| r.read_state.as_ref().is_none_or(|s| s.membership_version.is_none()));
        if upgrade_read_cache {
            self.snapshot().await?;
        }
        self.verified.store(true, Ordering::SeqCst);
        self.flush().await?;
        let url = self.client.socket_url(&self.store.cursor()?.unwrap()).await?;
        let (mut socket, _) =
            tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(url.as_str()))
                .await
                .map_err(|_| Error::Protocol("socket_timeout"))?
                .map_err(|_| Error::Protocol("socket_closed"))?;
        self.set_status(Connection::Online, None);
        let mut last = tokio::time::Instant::now();
        let credential_check = tokio::time::Instant::now() + Duration::from_secs(24 * 60 * 60);
        loop {
            let state_retry = self.state_retry_deadline();
            tokio::select! {
                frame=socket.next()=>{
                    match frame {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))=>{let batch=serde_json::from_str(&text).map_err(|_| Error::Protocol("invalid_batch"))?;self.store.batch(&batch)?;last=tokio::time::Instant::now();}
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(_)|tokio_tungstenite::tungstenite::Message::Pong(_)))=>{},
                        _=>return Err(Error::Protocol("socket_closed")),
                    }
                }
                _=self.wake.notified()=>self.flush().await?,
                _=tokio::time::sleep_until(state_retry.unwrap_or(credential_check)), if state_retry.is_some()=>self.flush_state_intents().await?,
                _=tokio::time::sleep_until(credential_check), if self.credentials.is_some()=>return Ok(()),
                _=tokio::time::sleep_until(last+Duration::from_secs(45))=>return Err(Error::Protocol("socket_timeout")),
            }
        }
    }
    async fn flush(&self) -> Result<(), Error> {
        for pending in self.store.pending()? {
            let projection = self.store.projection_token();
            match self
                .client
                .send(
                    &pending.room_id,
                    &rv_protocol::SendMessage { quotes: vec![], operation_id: pending.id.clone(), text: pending.text },
                )
                .await
            {
                Ok(message) => {
                    if !self.store.ingest_at(&[message], projection)? {
                        return Err(Error::Protocol("delivery_revalidate"));
                    }
                }
                Err(error @ rv_client::Error::Server { status: 401, .. }) => return Err(error.into()),
                Err(rv_client::Error::Server { status, code, .. })
                    if (400..500).contains(&status) && status != 429 && code != "delivery_revalidate" =>
                {
                    self.store.fail(&pending.id, &code)?
                }
                Err(error) => return Err(error.into()),
            }
        }
        for command in self.store.pending_commands()? {
            match self.apply_command(&command).await {
                Ok(()) => (),
                Err(error) if permanent_command_error(&error) => self.store.fail_command(&command.id, error.code())?,
                Err(error) => return Err(error),
            }
        }
        for operation in self.store.pending_room_operations()? {
            match self.apply_room_operation(&operation).await {
                Ok(()) => (),
                Err(error) if permanent_command_error(&error) => {
                    self.store.fail_room_operation(&operation.room, operation.command.id(), error.code())?
                }
                Err(error) => return Err(error),
            }
        }
        self.flush_state_intents().await?;
        Ok(())
    }
    pub fn send(&self, rid: &str, text: &str) -> Result<String, Error> {
        self.send_intention(rid, text, None)
    }
    pub fn send_from_membership(&self, rid: &str, text: &str, membership: Option<&str>) -> Result<String, Error> {
        self.send_intention(rid, text, Some(membership))
    }
    fn send_intention(&self, rid: &str, text: &str, membership: Option<Option<&str>>) -> Result<String, Error> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(Error::Protocol("session_closed"));
        }
        if self.status().error.as_deref() == Some("server_identity_changed") {
            return Err(Error::Protocol("server_identity_changed"));
        }
        let text = text.trim();
        if text.is_empty() || text.len() > 32_768 {
            return Err(Error::Protocol("invalid_message"));
        }
        let id = format!("{:032x}", fastrand::u128(..));
        if let Some(expected) = membership {
            if !self.store.enqueue_from_membership(&id, rid, text, &self.info.username, expected)? {
                return Err(Error::Protocol("delivery_revalidate"));
            }
        } else {
            self.store.enqueue(&id, rid, text, &self.info.username)?;
        }
        self.wake.notify_one();
        Ok(id)
    }
    pub fn retry(&self, id: &str) -> Result<(), Error> {
        self.store.retry(id)?;
        self.wake.notify_one();
        Ok(())
    }
    pub fn abandon(&self, id: &str) -> Result<(), Error> {
        self.store.abandon(id)?;
        Ok(())
    }
    fn ready(&self) -> Result<(), Error> {
        if self.closed.load(Ordering::SeqCst) {
            Err(Error::Protocol("session_closed"))
        } else if self.verified.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(Error::Protocol("offline"))
        }
    }
    pub async fn message_permissions(&self, id: &str) -> Result<rv_protocol::parity::MessagePermissions, Error> {
        self.ready()?;
        if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.fine_permissions) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let permissions = self.client.message_permissions(id).await?;
        self.ready()?;
        Ok(permissions)
    }
    pub async fn room_details(&self, room: &str) -> Result<rv_protocol::parity::RoomDetails, Error> {
        self.ready()?;
        if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.room_info) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let projection = self.store.projection_token();
        self.identity().await?;
        self.ready()?;
        let details = self.client.room_details(room).await?;
        self.identity().await?;
        self.ready()?;
        if details.room.id != room || details.permissions.room_id != room {
            return Err(Error::Protocol("invalid_room_details"));
        }
        if projection != self.store.projection_token() || !self.store.rooms()?.iter().any(|r| r.id == room) {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        self.store.cache_room_access(&details, projection)?;
        Ok(details)
    }
    /// An offline cache is only a UI hint; every send is authorized by the server.
    pub fn can_send_to_room(&self, room: &str) -> bool {
        if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.room_info) {
            return true;
        }
        self.store.room_access(room).ok().flatten().is_some_and(|a| a.can_send)
    }
    pub async fn refresh_room_access(&self, room: &str) -> Result<(), Error> {
        let _guard = self.room_access_lock.lock().await;
        for _ in 0..3 {
            if self.store.room_access(room)?.is_some() {
                return Ok(());
            }
            let Some(before) = self.store.rooms()?.into_iter().find(|r| r.id == room) else {
                return Ok(());
            };
            self.room_details(room).await?;
            if self.store.rooms()?.iter().find(|r| r.id == room).is_none_or(|r| r.revision == before.revision) {
                return Ok(());
            }
        }
        Ok(())
    }
    pub async fn room_info(&self, room: &str) -> Result<crate::info::RoomInfo, Error> {
        Ok(crate::info::native_room_info(self.room_details(room).await?))
    }
    pub async fn edit(&self, rid: &str, id: &str, revision: &str, text: &str) -> Result<(), Error> {
        if text.trim().is_empty() || text.len() > 32_768 {
            return Err(Error::Protocol("invalid_message"));
        }
        self.submit_command(rid, id, revision, store::MessageCommandKind::Edit, text).await
    }
    pub async fn message_action_context(
        &self,
        id: &str,
    ) -> Result<(rv_protocol::Message, rv_protocol::parity::MessagePermissions), Error> {
        self.ready()?;
        let projection = self.store.projection_token();
        let message = self.client.message(id).await?;
        let permissions = self.message_permissions(id).await?;
        if permissions.revision != message.revision {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        if !self.store.ingest_at(std::slice::from_ref(&message), projection)? {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        if message.deleted {
            return Err(Error::Protocol("message_deleted"));
        }
        Ok((message, permissions))
    }
    pub async fn delete(&self, rid: &str, id: &str, revision: &str) -> Result<(), Error> {
        self.submit_command(rid, id, revision, store::MessageCommandKind::Delete, "").await
    }
    pub async fn react(&self, rid: &str, id: &str, emoji: &str, present: bool) -> Result<(), Error> {
        let emoji = rv_protocol::emojis::canonical(emoji).ok_or(Error::Protocol("unknown_emoji"))?;
        let text = serde_json::to_string(&ReactionIntent { emoji: emoji.into(), present })
            .map_err(|_| Error::Protocol("invalid_message_action"))?;
        // Explicit state actions have no content-revision precondition.
        self.submit_command(rid, id, "0", store::MessageCommandKind::React, &text).await
    }
    async fn submit_command(
        &self,
        rid: &str,
        id: &str,
        revision: &str,
        kind: store::MessageCommandKind,
        text: &str,
    ) -> Result<(), Error> {
        self.ready()?;
        let command =
            self.store.command(rid, id, revision, kind, text)?.ok_or(Error::Protocol("message_action_pending"))?;
        let result = self.apply_command(&command).await;
        if let Err(error) = &result {
            if permanent_command_error(error) {
                self.store.fail_command(&command.id, error.code())?;
            } else if error.terminal() {
                self.shutdown();
                self.set_failure(error);
            } else {
                self.wake.notify_one();
            }
        }
        result
    }
    pub async fn set_mark(&self, rid: &str, id: &str, present: bool, starred: bool) -> Result<(), Error> {
        self.submit_command(
            rid,
            id,
            "0",
            if starred { store::MessageCommandKind::Star } else { store::MessageCommandKind::Pin },
            if present { "true" } else { "false" },
        )
        .await
    }
    pub async fn marked(&self, rid: &str, starred: bool) -> Result<Vec<rv_protocol::Message>, Error> {
        self.ready()?;
        if !self.supported_features().iter().any(|f| f == if starred { "stars" } else { "pins" }) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let token = self.store.projection_token();
        let mut messages = Vec::new();
        let mut before: Option<String> = None;
        for _ in 0..100 {
            let page = self.client.marked(rid, starred, before.as_deref()).await?;
            self.ready()?;
            if page.messages.len() > 100
                || page.messages.iter().any(|m| {
                    m.room_id != rid
                        || m.deleted
                        || if starred { m.personal_star.as_ref().is_none_or(|s| !s.present) } else { !m.pinned }
                })
            {
                return Err(Error::Protocol("invalid_message_page"));
            }
            let mut previous = before
                .as_deref()
                .map(str::parse::<u64>)
                .transpose()
                .map_err(|_| Error::Protocol("invalid_message_page"))?;
            for message in &page.messages {
                let position = message
                    .position
                    .parse::<u64>()
                    .ok()
                    .filter(|n| n.to_string() == message.position)
                    .ok_or(Error::Protocol("invalid_message_page"))?;
                if previous.is_some_and(|p| position >= p) {
                    return Err(Error::Protocol("invalid_message_page"));
                }
                previous = Some(position);
            }
            let next = page.messages.last().map(|m| m.position.clone());
            if page.has_more
                && next.as_deref().is_none_or(|next| {
                    before.as_deref().is_some_and(|old| next.parse::<u64>().ok() >= old.parse::<u64>().ok())
                })
            {
                return Err(Error::Protocol("invalid_message_page"));
            }
            let has_more = page.has_more;
            messages.extend(page.messages);
            if !has_more {
                if !self.store.ingest_at(&messages, token)? {
                    return Err(Error::Protocol("delivery_revalidate"));
                }
                let _ = self.events.send(());
                return Ok(messages);
            }
            before = next;
        }
        Err(Error::Protocol("message_list_limit"))
    }
    async fn apply_command(&self, command: &store::PendingCommand) -> Result<(), Error> {
        use rv_protocol::parity::{DeleteMessage, EditMessage, MessageContent, SetMark, SetReaction};
        let _guard = self.command_lock.lock().await;
        self.ready()?;
        let supported = self.capabilities.lock().unwrap().as_ref().is_some_and(|c| match command.kind {
            store::MessageCommandKind::Edit => c.editing,
            store::MessageCommandKind::Delete => c.deletion,
            store::MessageCommandKind::React => c.reactions,
            store::MessageCommandKind::Pin => c.pins,
            store::MessageCommandKind::Star => c.stars,
        });
        if !supported {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let projection = self.store.projection_token();
        let message = match command.kind {
            store::MessageCommandKind::Edit => {
                self.client
                    .edit_message(
                        &command.message_id,
                        &EditMessage {
                            operation_id: command.id.clone(),
                            expected_revision: command.expected_revision.clone(),
                            content: MessageContent::Plain {
                                markdown: command.text.clone(),
                                mentions: vec![],
                                quotes: vec![],
                                files: vec![],
                            },
                        },
                    )
                    .await?
            }
            store::MessageCommandKind::Delete => {
                self.client
                    .delete_message(
                        &command.message_id,
                        &DeleteMessage {
                            operation_id: command.id.clone(),
                            expected_revision: command.expected_revision.clone(),
                        },
                    )
                    .await?
            }
            store::MessageCommandKind::React => {
                let intent: ReactionIntent =
                    serde_json::from_str(&command.text).map_err(|_| Error::Protocol("invalid_message_action"))?;
                self.client
                    .set_reaction(
                        &command.message_id,
                        &SetReaction { operation_id: command.id.clone(), emoji: intent.emoji, present: intent.present },
                    )
                    .await?
            }
            store::MessageCommandKind::Pin | store::MessageCommandKind::Star => {
                let present: bool =
                    serde_json::from_str(&command.text).map_err(|_| Error::Protocol("invalid_message_action"))?;
                self.client
                    .set_mark(
                        &command.message_id,
                        &SetMark { operation_id: command.id.clone(), present },
                        command.kind == store::MessageCommandKind::Star,
                    )
                    .await?
            }
        };
        self.ready()?;
        if !self.store.confirm_command(&command.id, &message, projection)? {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        Ok(())
    }
    pub async fn users(&self) -> Result<Vec<rv_protocol::User>, Error> {
        self.ready()?;
        let users = self.client.users().await?;
        self.ready()?;
        Ok(users)
    }
    fn device_access(&self) -> Result<(), Error> {
        self.ready()?;
        if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.device_sessions) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        Ok(())
    }
    pub async fn device_sessions(&self) -> Result<Vec<rv_protocol::parity::DeviceSession>, Error> {
        self.device_access()?;
        self.refresh_credentials().await?;
        self.device_access()?;
        let devices = self.client.device_sessions().await?;
        self.ready()?;
        let mut ids = std::collections::HashSet::new();
        if devices.len() > 64
            || devices.iter().filter(|d| d.current).count() != 1
            || devices.iter().any(|d| !ids.insert(&d.id))
        {
            return Err(Error::Protocol("invalid_native_session"));
        }
        Ok(devices)
    }
    pub async fn rename_device(&self, id: &str, label: &str) -> Result<(), Error> {
        self.device_access()?;
        self.refresh_credentials().await?;
        self.device_access()?;
        self.client.rename_device(id, &rv_protocol::parity::RenameDevice { label: label.into() }).await?;
        self.ready()
    }
    pub async fn revoke_device(&self, id: &str) -> Result<(), Error> {
        self.device_access()?;
        self.refresh_credentials().await?;
        self.device_access()?;
        if self.client.device_sessions().await?.iter().any(|d| d.id == id && d.current) {
            return Err(Error::Protocol("current_device_requires_logout"));
        }
        self.device_access()?;
        self.client.revoke_device(id).await?;
        self.ready()
    }
    pub async fn history(&self, rid: &str, older: bool) -> Result<bool, Error> {
        self.ready()?;
        let projection = self.store.projection_token();
        let before = if older { self.store.oldest(rid)? } else { None };
        let page = self.client.history(rid, before.as_deref()).await?;
        self.ready()?;
        if !self.store.ingest_at(&page.messages, projection)? {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        Ok(page.has_more)
    }
    pub async fn create_room(&self, name: &str, private: bool) -> Result<String, Error> {
        self.ready()?;
        let name = name.trim();
        if name.is_empty() || name.len() > 128 {
            return Err(Error::Protocol("invalid_room"));
        }
        let supported = self.capabilities.lock().unwrap().as_ref().is_some_and(|caps| caps.idempotent_room_creation);
        let operation_id = if supported { Some(self.store.room_creation(name, private)?) } else { None };
        let room = self
            .client
            .create_room(&rv_protocol::CreateRoom { name: name.into(), private, operation_id: operation_id.clone() })
            .await?;
        self.ready()?;
        if let Some(id) = operation_id {
            self.store.complete_room_creation(&id)?;
        }
        self.reconnect();
        Ok(room.id)
    }
    async fn user_id(&self, username: &str) -> Result<String, Error> {
        self.ready()?;
        self.client
            .users()
            .await?
            .into_iter()
            .find(|u| u.username == username.trim())
            .map(|u| u.id)
            .ok_or(Error::Protocol("user_not_found"))
    }
    pub async fn public_rooms(&self, query: &str) -> Result<rv_protocol::PublicRoomPage, Error> {
        self.ready()?;
        if !self.supported_features().iter().any(|f| f == "room_discovery") {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let page = self.client.public_rooms(query, None).await?;
        self.ready()?;
        Ok(page)
    }
    pub async fn spotlight(&self, query: &str) -> Result<Vec<crate::rooms::Found>, Error> {
        let query = query.trim();
        let users = self.users().await?;
        let needle = query.to_lowercase();
        let mut found: Vec<_> = users
            .into_iter()
            .filter(|u| {
                u.id != self.info.user_id
                    && format!("{} {}", u.username, u.display_name).to_lowercase().contains(&needle)
            })
            .take(20)
            .map(|u| crate::rooms::Found::User { id: u.id, username: u.username, name: Some(u.display_name) })
            .collect();
        if self.supported_features().iter().any(|f| f == "room_discovery") {
            found.extend(self.public_rooms(query).await?.rooms.into_iter().map(|r| crate::rooms::Found::Room {
                id: r.room.id,
                name: r.room.name,
                kind: "c".into(),
            }));
        }
        Ok(found)
    }
    pub async fn join_public(&self, rid: &str) -> Result<String, Error> {
        self.ready()?;
        if !self.supported_features().iter().any(|f| f == "room_discovery") {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let room = self.client.join_public(rid).await?;
        self.ready()?;
        self.reconnect();
        Ok(room.id)
    }
    pub async fn direct(&self, username: &str) -> Result<String, Error> {
        let uid = self.user_id(username).await?;
        self.ready()?;
        let room = self.client.direct(&uid).await?;
        self.ready()?;
        self.reconnect();
        Ok(room.id)
    }
    pub async fn invite(&self, rid: &str, username: &str) -> Result<(), Error> {
        let uid = self.user_id(username).await?;
        self.ready()?;
        self.client.add_member(rid, &uid).await?;
        Ok(())
    }
    pub async fn logout(&self) -> Result<(), Error> {
        self.identity().await?;
        self.refresh_credentials().await?;
        self.client.logout().await?;
        Ok(())
    }
}

fn permanent_command_error(error: &Error) -> bool {
    matches!(error,Error::Network(rv_client::Error::Server{status,code,..}) if (400..500).contains(status) && *status!=401 && *status!=429 && code!="delivery_revalidate")
        || matches!(error, Error::Protocol("unsupported_feature" | "invalid_message_action" | "unknown_emoji"))
}
