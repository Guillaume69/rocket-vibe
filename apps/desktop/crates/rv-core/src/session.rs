//! A logged-in session: REST, DDP, store, sync and outbox wired together,
//! plus the reconnection loop. Everything a UI needs, nothing it draws.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use url::Url;

use crate::actions::{self, ServerSettings};
use crate::ddp::{self, DdpEvent, DdpHandle, State, Timeouts};
use crate::media::MediaCache;
use crate::outbox::Outbox;
use crate::rest::{CallOptions, Credentials, RestClient, RestError, TwoFactorCode};
use crate::store::Store;
use crate::sync::{HistoryPage, MY_MESSAGES, STREAM_NOTIFY_ROOM, STREAM_NOTIFY_USER, STREAM_ROOM_MESSAGES, SyncEngine};

const MAX_RECONNECT_DELAY_MS: u64 = 30_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub base_url: String,
    pub user_id: String,
    pub username: String,
    pub auth_token: String,
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
    };
    if info.auth_token.is_empty() || info.user_id.is_empty() {
        return Err(RestError {
            status: 200,
            message: "Unexpected login response.".into(),
            error: None,
            error_type: None,
            understood: false,
            two_factor: None,
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
    ddp: DdpHandle,
    events: broadcast::Sender<SessionEvent>,
    current_room: Mutex<Option<(String, String)>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    settings: tokio::sync::OnceCell<ServerSettings>,
}

impl Session {
    /// Must run inside a tokio runtime.
    pub fn start(info: SessionInfo, db_path: &Path) -> rusqlite::Result<Arc<Session>> {
        let base: Url = info.base_url.parse().expect("stored base URL");
        let store = Arc::new(Store::open(db_path)?);
        let rest = RestClient::new(base.clone());
        rest.set_credentials(Some(Credentials { auth_token: info.auth_token.clone(), user_id: info.user_id.clone() }));
        let sync = Arc::new(SyncEngine::new(store.clone(), rest.clone(), &info.username, &info.user_id));
        let outbox = Arc::new(Outbox::new(store.clone(), rest.clone(), sync.clone(), &info.user_id, &info.username));
        let (ddp, ddp_events) = ddp::spawn(websocket_url(&base), Timeouts::default());
        ddp.subscribe(STREAM_NOTIFY_USER, &format!("{}/subscriptions-changed", info.user_id));
        ddp.subscribe(STREAM_NOTIFY_USER, &format!("{}/rooms-changed", info.user_id));
        ddp.subscribe(STREAM_ROOM_MESSAGES, MY_MESSAGES);
        let (events, _) = broadcast::channel(32);

        let media = Arc::new(MediaCache::new(rest.clone()));
        let session = Arc::new(Session {
            info,
            store,
            rest,
            sync,
            outbox,
            media,
            ddp,
            events,
            current_room: Mutex::new(None),
            tasks: Mutex::default(),
            settings: tokio::sync::OnceCell::new(),
        });
        let listener = tokio::spawn(Self::listen(Arc::downgrade(&session), ddp_events));
        let watcher = tokio::spawn(Self::watch_token(Arc::downgrade(&session), session.rest.token_rejected()));
        session.tasks.lock().unwrap().extend([listener, watcher]);

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
                DdpEvent::Changed { collection, key, args } => s.sync.apply_event(&collection, &key, &args),
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
        }
        if let Some((rid, kind)) = self.current_room() {
            let _ = self.sync.load_history(&rid, &kind, None).await;
        }
    }

    pub fn reconnect_now(&self) {
        self.ddp.open(&self.info.auth_token);
    }

    /// Switches the open room and loads its latest page.
    pub async fn open_room(&self, rid: &str, kind: &str) -> Result<HistoryPage, RestError> {
        let previous = self.current_room.lock().unwrap().replace((rid.to_owned(), kind.to_owned()));
        if let Some((old, _)) = previous {
            self.ddp.unsubscribe(STREAM_NOTIFY_ROOM, &format!("{old}/deleteMessage"));
        }
        // Deletions are not on `__my_messages__`: they stay per room.
        self.ddp.subscribe(STREAM_NOTIFY_ROOM, &format!("{rid}/deleteMessage"));
        let rest = self.rest.clone();
        let read = CallOptions::body(json!({"rid": rid}));
        tokio::spawn(async move {
            let _ = rest.post("subscriptions.read", read).await;
        });
        self.sync.load_history(rid, kind, None).await
    }

    pub async fn send(&self, rid: &str, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        self.outbox.enqueue(rid, text, None);
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

    /// The permalink the server recognises: built on `Site_Url`, else on our base URL.
    pub async fn permalink(&self, kind: &str, slug: Option<&str>, rid: &str, msg_id: &str) -> String {
        let base = self.settings().await.site_url.clone().unwrap_or_else(|| self.info.base_url.clone());
        actions::permalink(&base, kind, slug, rid, msg_id)
    }

    pub async fn react(&self, msg_id: &str, shortcode: &str, add: bool) -> Result<(), RestError> {
        actions::react(&self.rest, msg_id, shortcode, add).await
    }

    pub async fn edit(&self, rid: &str, msg_id: &str, text: &str) -> Result<(), RestError> {
        let doc = actions::edit(&self.rest, rid, msg_id, text).await?;
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

    pub async fn pin(&self, msg_id: &str) -> Result<(), RestError> {
        actions::pin(&self.rest, msg_id).await
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
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        self.outbox.enqueue(rid, text, thread_id);
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
