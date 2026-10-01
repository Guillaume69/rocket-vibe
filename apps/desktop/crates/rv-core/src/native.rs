//! Native desktop pilot: pinned identity, durable SQLite projection and a single replay loop.
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
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::{Notify, broadcast, watch};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub instance_id: String,
    pub data_epoch: String,
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
    Ok(SessionInfo {
        base_url: base.as_str().trim_end_matches('/').into(),
        user_id: session.user.id,
        username: session.user.username,
        auth_token: session.token,
        native: Some(identity),
    })
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
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl NativeSession {
    pub fn start(info: SessionInfo, path: &Path) -> Result<Arc<Self>, Error> {
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
            status: Mutex::new(Status { connection: Connection::Offline, error: None }),
            capabilities: Mutex::new(None),
            events,
            control,
            wake: Notify::new(),
            paused: AtomicBool::new(false),
            verified: AtomicBool::new(false),
            task: Mutex::new(None),
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
                s.verified.store(false, Ordering::SeqCst);
                if let Some(Err(error)) = result {
                    let terminal = error.terminal();
                    s.set_status(Connection::Offline, Some(error.code().into()));
                    if terminal {
                        s.paused.store(true, Ordering::SeqCst);
                        continue;
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
    fn set_status(&self, connection: Connection, error: Option<String>) {
        *self.status.lock().unwrap() = Status { connection, error };
        let _ = self.events.send(());
    }
    fn signal(&self) {
        self.control.send_modify(|n| *n = n.wrapping_add(1));
    }
    pub fn suspend(&self) {
        self.paused.store(true, Ordering::SeqCst);
        self.verified.store(false, Ordering::SeqCst);
        self.signal();
    }
    pub fn reconnect(&self) {
        if self.status().error.as_deref() == Some("server_identity_changed") {
            return;
        }
        self.paused.store(false, Ordering::SeqCst);
        self.signal();
    }
    pub fn shutdown(&self) {
        self.paused.store(true, Ordering::SeqCst);
        self.verified.store(false, Ordering::SeqCst);
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        self.set_status(Connection::Offline, None);
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
                server.supported_features(&rv_protocol::Capabilities { room_discovery: true, ..Default::default() })
            })
            .unwrap_or_default()
    }
    async fn snapshot(&self) -> Result<(), Error> {
        let snapshot = self.client.snapshot().await?;
        self.identity().await?;
        self.store.snapshot(&snapshot)?;
        Ok(())
    }
    async fn cycle(&self) -> Result<(), Error> {
        self.identity().await?;
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
        loop {
            tokio::select! {
                frame=socket.next()=>{
                    match frame {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))=>{let batch=serde_json::from_str(&text).map_err(|_| Error::Protocol("invalid_batch"))?;self.store.batch(&batch)?;last=tokio::time::Instant::now();}
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(_)|tokio_tungstenite::tungstenite::Message::Pong(_)))=>{},
                        _=>return Err(Error::Protocol("socket_closed")),
                    }
                }
                _=self.wake.notified()=>self.flush().await?,
                _=tokio::time::sleep_until(last+Duration::from_secs(45))=>return Err(Error::Protocol("socket_timeout")),
            }
        }
    }
    async fn flush(&self) -> Result<(), Error> {
        for pending in self.store.pending()? {
            match self
                .client
                .send(
                    &pending.room_id,
                    &rv_protocol::SendMessage { operation_id: pending.id.clone(), text: pending.text },
                )
                .await
            {
                Ok(message) => self.store.ingest(&[message])?,
                Err(error @ rv_client::Error::Server { status: 401, .. }) => return Err(error.into()),
                Err(rv_client::Error::Server { status, code })
                    if (400..500).contains(&status) && status != 429 && code != "delivery_revalidate" =>
                {
                    self.store.fail(&pending.id, &code)?
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
    pub fn send(&self, rid: &str, text: &str) -> Result<String, Error> {
        if self.status().error.as_deref() == Some("server_identity_changed") {
            return Err(Error::Protocol("server_identity_changed"));
        }
        let text = text.trim();
        if text.is_empty() || text.len() > 32_768 {
            return Err(Error::Protocol("invalid_message"));
        }
        let id = format!("{:032x}", fastrand::u128(..));
        self.store.enqueue(&id, rid, text, &self.info.username)?;
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
        if self.verified.load(Ordering::SeqCst) { Ok(()) } else { Err(Error::Protocol("offline")) }
    }
    pub async fn users(&self) -> Result<Vec<rv_protocol::User>, Error> {
        self.ready()?;
        let users = self.client.users().await?;
        self.ready()?;
        Ok(users)
    }
    pub async fn history(&self, rid: &str, older: bool) -> Result<bool, Error> {
        self.ready()?;
        let before = if older { self.store.oldest(rid)? } else { None };
        let page = self.client.history(rid, before.as_deref()).await?;
        self.ready()?;
        self.store.ingest(&page.messages)?;
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
        self.client.logout().await?;
        Ok(())
    }
}
