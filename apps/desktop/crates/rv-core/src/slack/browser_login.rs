use super::{Error, account, id as valid_id, validate_credentials};
use crate::session::SessionInfo;
use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpStream,
    process::{Child, Command},
    sync::{Mutex as AsyncMutex, mpsc, oneshot, watch},
    time::{Instant, sleep, timeout},
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};
use zeroize::{Zeroize, Zeroizing};

fn failure(code: &'static str) -> Error {
    Error { code, status: 0, retry_after: None }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    OpeningBrowser,
    SigningIn,
    Ready(Vec<Workspace>),
    Complete,
    Failed(&'static str),
    Cancelled,
}

struct Credential {
    team_id: String,
    user_id: String,
    label: String,
    token: Zeroizing<String>,
    cookie: Zeroizing<String>,
}

struct Inner {
    state: Mutex<State>,
    credentials: Mutex<HashMap<String, Credential>>,
    cancel: watch::Sender<bool>,
}

impl Inner {
    fn state(&self) -> State {
        self.state.lock().expect("Slack browser login").clone()
    }

    fn set_state(&self, state: State) {
        *self.state.lock().expect("Slack browser login") = state;
    }
}

/// Signs in through a fresh, app-owned Chromium-family profile. Credentials
/// stay in this process until the caller selects a validated workspace.
pub struct BrowserLogin {
    inner: Arc<Inner>,
}

impl BrowserLogin {
    pub fn start() -> Result<Arc<Self>, Error> {
        let executable = browser_executable().ok_or_else(|| failure("supported_browser_missing"))?;
        let (cancel, receiver) = watch::channel(false);
        let inner = Arc::new(Inner {
            state: Mutex::new(State::OpeningBrowser),
            credentials: Mutex::new(HashMap::new()),
            cancel,
        });
        tokio::spawn(run(inner.clone(), executable, receiver));
        Ok(Arc::new(Self { inner }))
    }

    pub fn state(&self) -> State {
        self.inner.state()
    }

    /// A sign-in an app window finished: `reached` is the Slack page it
    /// stopped on, `cookies` what it held. Its workspaces are then read as a
    /// browser sign-in's are; the state moves on as for `start`.
    pub fn from_window(reached: &str, cookies: Vec<WindowCookie>) -> Arc<Self> {
        let (cancel, _) = watch::channel(false);
        let inner =
            Arc::new(Inner { state: Mutex::new(State::SigningIn), credentials: Mutex::new(HashMap::new()), cancel });
        let hosts: Vec<String> = slack_url(reached).and_then(|u| u.host_str().map(str::to_owned)).into_iter().collect();
        let mut result = json!({"cookies": cookies.iter().map(|c| json!({
            "name": c.name, "value": c.value.as_str(), "domain": c.domain, "path": c.path,
            "secure": c.secure, "httpOnly": c.http_only, "expires": -1,
        })).collect::<Vec<_>>()});
        drop(cookies);
        let task = inner.clone();
        tokio::spawn(async move {
            derive_from(&task, &result, &hosts).await;
            zeroize_json(&mut result);
            task.set_state(match workspaces(&task) {
                Some(workspaces) => State::Ready(workspaces),
                None => State::Failed("authentication_failed"),
            });
        });
        Arc::new(Self { inner })
    }

    pub fn cancel(&self) {
        self.inner.cancel.send_replace(true);
    }

    pub async fn take(&self, team_id: &str) -> Result<SessionInfo, Error> {
        let candidate = self
            .inner
            .credentials
            .lock()
            .expect("Slack browser login")
            .remove(team_id)
            .ok_or_else(|| failure("workspace_unavailable"))?;
        self.inner.credentials.lock().expect("Slack browser login").clear();
        let info = account::login(&candidate.token, &candidate.cookie, Some((&candidate.team_id, &candidate.user_id)))
            .await
            .map_err(|_| failure("authentication_failed"))?;
        self.inner.set_state(State::Complete);
        Ok(info)
    }
}

impl Drop for BrowserLogin {
    fn drop(&mut self) {
        self.cancel();
        self.inner.credentials.lock().expect("Slack browser login").clear();
    }
}

async fn run(inner: Arc<Inner>, executable: PathBuf, receiver: watch::Receiver<bool>) {
    let result = async {
        let mut browser = Browser::launch(executable).await?;
        inner.set_state(State::SigningIn);
        let capture = browser.capture(&inner, receiver).await;
        browser.shutdown().await;
        capture
    }
    .await;
    match result {
        Ok(()) => {
            if let Some(workspaces) = workspaces(&inner) {
                inner.set_state(State::Ready(workspaces));
            } else {
                inner.set_state(State::Failed("authentication_failed"));
            }
        }
        Err("cancelled") => inner.set_state(State::Cancelled),
        Err(code) => inner.set_state(State::Failed(code)),
    }
}

fn workspaces(inner: &Inner) -> Option<Vec<Workspace>> {
    let credentials = inner.credentials.lock().expect("Slack browser login");
    if credentials.is_empty() {
        return None;
    }
    let mut result: Vec<_> =
        credentials.values().map(|c| Workspace { id: c.team_id.clone(), label: c.label.clone() }).collect();
    result.sort_by(|a, b| a.label.cmp(&b.label).then(a.id.cmp(&b.id)));
    Some(result)
}

struct Profile(PathBuf);

/// The profile holds the session cookie: readable by me only.
fn private_dir(path: &std::path::Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

impl Profile {
    fn create() -> Result<Self, &'static str> {
        let base = std::env::temp_dir();
        for _ in 0..8 {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|_| "randomness_unavailable")?;
            let name = random.iter().map(|b| format!("{b:02x}")).collect::<String>();
            let path = base.join(format!("rocketvibe-slack-login-{name}"));
            match private_dir(&path) {
                Ok(()) => {
                    let preferences = path.join("Default").join("Preferences");
                    if std::fs::create_dir_all(preferences.parent().unwrap())
                        .and_then(|()| {
                            std::fs::write(
                                &preferences,
                                json!({"protocol_handler":{"excluded_schemes":{"slack":true}}}).to_string(),
                            )
                        })
                        .is_err()
                    {
                        let _ = std::fs::remove_dir_all(&path);
                        return Err("profile_creation_failed");
                    }
                    return Ok(Self(path));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err("profile_creation_failed"),
            }
        }
        Err("profile_creation_failed")
    }

    async fn remove(&mut self) {
        for _ in 0..6 {
            match tokio::fs::remove_dir_all(&self.0).await {
                Ok(()) => return,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
                Err(_) => sleep(Duration::from_millis(250)).await,
            }
        }
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Replies = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, &'static str>>>>>;

/// The events the capture acts on; every other event is dropped unread.
const EVENTS: [&str; 2] = ["Target.attachedToTarget", "Fetch.requestPaused"];

struct Cdp {
    sink: AsyncMutex<SplitSink<Socket, Message>>,
    replies: Replies,
    next_id: AtomicU64,
    reader: tokio::task::JoinHandle<()>,
}

impl Cdp {
    async fn connect(endpoint: &str) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Value>), &'static str> {
        let (socket, _) = timeout(Duration::from_secs(10), connect_async(endpoint))
            .await
            .map_err(|_| "browser_unavailable")?
            .map_err(|_| "browser_unavailable")?;
        let (sink, stream) = socket.split();
        let replies: Replies = Arc::default();
        let (events, receiver) = mpsc::unbounded_channel();
        let reader = tokio::spawn(read(stream, replies.clone(), events));
        Ok((Arc::new(Self { sink: AsyncMutex::new(sink), replies, next_id: AtomicU64::new(1), reader }), receiver))
    }

    async fn command(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, &'static str> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut request = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            request["sessionId"] = json!(session);
        }
        let mut text = serde_json::to_string(&request).map_err(|_| "browser_command_failed")?;
        zeroize_json(&mut request);
        let (reply, answer) = oneshot::channel();
        self.replies.lock().expect("CDP replies").insert(id, reply);
        let sent = self.sink.lock().await.send(Message::Text(text.as_str().into())).await;
        text.zeroize();
        if sent.is_err() {
            self.replies.lock().expect("CDP replies").remove(&id);
            return Err("browser_closed");
        }
        match timeout(Duration::from_secs(12), answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("browser_closed"),
            Err(_) => {
                self.replies.lock().expect("CDP replies").remove(&id);
                Err("browser_timeout")
            }
        }
    }
}

impl Drop for Cdp {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

async fn read(mut stream: SplitStream<Socket>, replies: Replies, events: mpsc::UnboundedSender<Value>) {
    while let Some(Ok(message)) = stream.next().await {
        if !message.is_text() {
            continue;
        }
        let Ok(text) = message.into_text() else { continue };
        let mut raw = text.to_string();
        if raw.len() > 4_000_000 {
            raw.zeroize();
            continue;
        }
        let packet: Result<Value, _> = serde_json::from_str(&raw);
        raw.zeroize();
        let Ok(mut packet) = packet else { continue };
        if let Some(id) = packet["id"].as_u64() {
            let result = if packet["error"].is_object() {
                Err("browser_command_failed")
            } else {
                Ok(packet.get_mut("result").map(Value::take).unwrap_or(Value::Null))
            };
            zeroize_json(&mut packet);
            match replies.lock().expect("CDP replies").remove(&id) {
                Some(reply) => {
                    let _ = reply.send(result);
                }
                None => {
                    if let Ok(mut result) = result {
                        zeroize_json(&mut result);
                    }
                }
            }
        } else if packet["method"].as_str().is_some_and(|m| EVENTS.contains(&m)) {
            let _ = events.send(packet);
        } else {
            zeroize_json(&mut packet);
        }
    }
    replies.lock().expect("CDP replies").clear();
}

struct Browser {
    child: Option<Child>,
    profile: Profile,
    cdp: Arc<Cdp>,
    events: mpsc::UnboundedReceiver<Value>,
}

impl Browser {
    async fn launch(executable: PathBuf) -> Result<Self, &'static str> {
        let profile = Profile::create()?;

        let mut child = Command::new(executable)
            .arg("--remote-debugging-address=127.0.0.1")
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.0.display()))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-sync")
            .arg("--new-window")
            .arg("https://slack.com/signin")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "browser_launch_failed")?;

        let endpoint = debugger_endpoint(&mut child, &profile.0).await?;
        let (cdp, events) = Cdp::connect(&endpoint).await?;
        cdp.command(
            "Target.setAutoAttach",
            json!({"autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true}),
            None,
        )
        .await?;
        Ok(Self { child: Some(child), profile, cdp, events })
    }

    async fn capture(&mut self, inner: &Arc<Inner>, mut cancel: watch::Receiver<bool>) -> Result<(), &'static str> {
        let deadline = Instant::now() + Duration::from_secs(20 * 60);
        let mut cookie_fingerprint = None;
        let mut checked: HashMap<[u8; 32], Instant> = HashMap::new();
        let mut pages = HashMap::new();
        let mut handoff_hosts = Vec::new();
        let mut ready_since = None;
        let mut tick = tokio::time::interval(Duration::from_millis(800));

        loop {
            tokio::select! {
                _ = cancel.changed() => {
                    if *cancel.borrow() {
                        return Err("cancelled");
                    }
                }
                event = self.events.recv() => {
                    let Some(mut event) = event else { return Err("browser_closed") };
                    let handoff = self.on_event(&event, &mut pages).await;
                    zeroize_json(&mut event);
                    if let Some(host) = handoff {
                        handoff_hosts.push(host);
                        self.derive(inner, &handoff_hosts).await;
                        return Ok(());
                    }
                    continue;
                }
                _ = tick.tick() => {}
                _ = tokio::time::sleep_until(deadline) => return Err("timeout"),
            }
            if *cancel.borrow() {
                return Err("cancelled");
            }
            if self.child.as_mut().and_then(|child| child.try_wait().ok().flatten()).is_some() {
                return if workspaces(inner).is_some() { Ok(()) } else { Err("browser_closed") };
            }
            let seen = self.inspect(inner, &mut cookie_fingerprint, &mut checked, &mut pages).await?;
            let before = handoff_hosts.len();
            for host in seen {
                if !handoff_hosts.contains(&host) {
                    handoff_hosts.push(host);
                }
            }
            if workspaces(inner).is_none() && handoff_hosts.len() > before {
                self.derive(inner, &handoff_hosts).await;
                if workspaces(inner).is_some() {
                    return Ok(());
                }
            }
            if workspaces(inner).is_some() {
                let first = ready_since.get_or_insert_with(Instant::now);
                if first.elapsed() >= Duration::from_secs(2) {
                    return Ok(());
                }
            } else {
                ready_since = None;
            }
        }
    }

    /// Keeps every page under document interception, and answers Slack's
    /// desktop handoff with a local page before it can open `slack:` or the
    /// web client. Returns the handoff's workspace host.
    async fn on_event(&self, event: &Value, pages: &mut HashMap<String, String>) -> Option<String> {
        let session = event["sessionId"].as_str();
        match event["method"].as_str()? {
            "Target.attachedToTarget" => {
                let child = event["params"]["sessionId"].as_str()?;
                let info = &event["params"]["targetInfo"];
                if info["type"] == "page" {
                    self.intercept(info["targetId"].as_str().unwrap_or_default(), child, pages).await;
                }
                let _ = self.cdp.command("Runtime.runIfWaitingForDebugger", json!({}), Some(child)).await;
                None
            }
            "Fetch.requestPaused" => {
                let request_id = event["params"]["requestId"].as_str()?;
                let url = slack_url(event["params"]["request"]["url"].as_str().unwrap_or_default());
                match url.filter(is_handoff_url) {
                    Some(url) => {
                        let _ = self
                            .cdp
                            .command(
                                "Fetch.fulfillRequest",
                                json!({
                                    "requestId": request_id,
                                    "responseCode": 200,
                                    "responseHeaders": [
                                        {"name": "Content-Type", "value": "text/html; charset=utf-8"},
                                        {"name": "Cache-Control", "value": "no-store"},
                                    ],
                                    "body": HANDOFF_PAGE,
                                }),
                                session,
                            )
                            .await;
                        url.host_str().map(str::to_owned)
                    }
                    None => {
                        let _ =
                            self.cdp.command("Fetch.continueRequest", json!({"requestId": request_id}), session).await;
                        None
                    }
                }
            }
            _ => None,
        }
    }

    async fn intercept(&self, target: &str, session: &str, pages: &mut HashMap<String, String>) {
        if pages.get(target).map(String::as_str) != Some(session) {
            pages.insert(target.to_owned(), session.to_owned());
            let _ = self
                .cdp
                .command(
                    "Fetch.enable",
                    json!({"patterns": [{"urlPattern": "*/ssb/*", "resourceType": "Document", "requestStage": "Request"}]}),
                    Some(session),
                )
                .await;
        }
    }

    /// Reaching the handoff means the sign-in completed: the session cookie
    /// is set, and each workspace host seen gives its token from its own
    /// boot page.
    async fn derive(&self, inner: &Arc<Inner>, handoff_hosts: &[String]) {
        let Ok(mut result) = self.cdp.command("Storage.getCookies", json!({}), None).await else { return };
        derive_from(inner, &result, handoff_hosts).await;
        zeroize_json(&mut result);
    }

    async fn inspect(
        &self,
        inner: &Arc<Inner>,
        cookie_fingerprint: &mut Option<[u8; 32]>,
        checked: &mut HashMap<[u8; 32], Instant>,
        pages: &mut HashMap<String, String>,
    ) -> Result<Vec<String>, &'static str> {
        let mut handoffs = Vec::new();
        let result = self.cdp.command("Target.getTargets", json!({}), None).await?;
        let targets = result["targetInfos"].as_array().cloned().unwrap_or_default();
        for target in targets.into_iter().filter(|t| t["type"] == "page").take(20) {
            let target_id = target["targetId"].as_str().unwrap_or_default().to_owned();
            let Some(session_id) = pages.get(&target_id).cloned() else {
                if let Ok(attached) = self
                    .cdp
                    .command("Target.attachToTarget", json!({"targetId": target_id, "flatten": true}), None)
                    .await
                    && let Some(session) = attached["sessionId"].as_str()
                {
                    self.intercept(&target_id, session, pages).await;
                }
                continue;
            };
            let raw_url = target["url"].as_str().unwrap_or_default();
            let Some(page_url) = slack_url(raw_url) else { continue };
            // The interception can miss the handoff (seen with Edge on Windows):
            // a page left on it still means the sign-in completed.
            if is_handoff_url(&page_url) {
                handoffs.extend(page_url.host_str().map(str::to_owned));
                continue;
            }
            if !is_client_url(&page_url) {
                continue;
            }
            let cookie =
                match self.cdp.command("Network.getCookies", json!({"urls": [raw_url]}), Some(&session_id)).await {
                    Ok(mut cookies) => {
                        let cookie = session_cookie(&cookies, Some(&page_url));
                        zeroize_json(&mut cookies);
                        cookie
                    }
                    Err(_) => None,
                };
            if let Some(cookie) = cookie {
                let fingerprint: [u8; 32] = Sha256::digest(cookie.as_bytes()).into();
                if cookie_fingerprint.is_some_and(|old| old != fingerprint) {
                    inner.credentials.lock().expect("Slack browser login").clear();
                    checked.clear();
                    inner.set_state(State::SigningIn);
                }
                *cookie_fingerprint = Some(fingerprint);
                let snapshot = self
                    .cdp
                    .command(
                        "Runtime.evaluate",
                        json!({"expression": SNAPSHOT, "returnByValue": true}),
                        Some(&session_id),
                    )
                    .await;
                if let Ok(mut snapshot) = snapshot {
                    if let Some(value) = snapshot["result"]["value"].as_object() {
                        let snapshot_url = value.get("url").and_then(Value::as_str).unwrap_or_default();
                        let config = value.get("config").and_then(Value::as_str).unwrap_or_default();
                        let boot_token = value.get("bootToken").and_then(Value::as_str).unwrap_or_default();
                        if slack_url(snapshot_url).is_some_and(|u| is_client_url(&u)) {
                            for candidate in candidates(snapshot_url, config, boot_token) {
                                let fingerprint: [u8; 32] = Sha256::digest(candidate.token.as_bytes()).into();
                                if checked.get(&fingerprint).is_some_and(|at| at.elapsed() < Duration::from_secs(30)) {
                                    continue;
                                }
                                checked.insert(fingerprint, Instant::now());
                                if let Ok(mut info) = account::login(&candidate.token, &cookie, None).await {
                                    let Some(account) = info.slack.take() else {
                                        info.auth_token.zeroize();
                                        continue;
                                    };
                                    let token = Zeroizing::new(std::mem::take(&mut info.auth_token));
                                    if account.team_id != candidate.team_id {
                                        continue;
                                    }
                                    let credential = Credential {
                                        team_id: account.team_id,
                                        user_id: info.user_id.clone(),
                                        label: candidate.label,
                                        token,
                                        cookie: account.cookie,
                                    };
                                    inner
                                        .credentials
                                        .lock()
                                        .expect("Slack browser login")
                                        .insert(credential.team_id.clone(), credential);
                                }
                            }
                        }
                    }
                    zeroize_json(&mut snapshot);
                }
            }
        }
        Ok(handoffs)
    }

    async fn shutdown(&mut self) {
        let _ = timeout(Duration::from_secs(1), self.cdp.command("Browser.close", json!({}), None)).await;
        if let Some(child) = self.child.as_mut()
            && timeout(Duration::from_secs(3), child.wait()).await.is_err()
        {
            let _ = child.start_kill();
            let _ = timeout(Duration::from_secs(2), child.wait()).await;
        }
        self.child.take();
        self.profile.remove().await;
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

const HANDOFF_PAGE: &str = "PCFkb2N0eXBlIGh0bWw+PG1ldGEgY2hhcnNldD11dGYtOD48dGl0bGU+U2xhY2s8L3RpdGxlPjxib2R5IHN0eWxlPSJmb250OjE2cHggc3lzdGVtLXVpO3RleHQtYWxpZ246Y2VudGVyO21hcmdpbi10b3A6MjB2aCI+U2lnbmVkIGluLiBSb2NrZXRWaWJlIGlzIGZpbmlzaGluZyB1cC48L2JvZHk+";

const SNAPSHOT: &str = r#"(()=>{const u=new URL(location.href);if(u.protocol!=="https:"||u.port||!/^([a-z0-9-]+\.)?slack\.com$/.test(u.hostname)||!/^\/(client|app)(\/|$)/.test(u.pathname))return null;let config=null;try{const s=localStorage.getItem("localConfig_v2");if(s&&s.length<=2000000)config=s}catch{}let total=0;const tokens=new Set();for(const s of document.scripts){const t=s.textContent||"";total+=t.length;if(total>2000000)break;for(const m of t.matchAll(/["']api_token["']\s*:\s*["'](xoxc-[A-Za-z0-9-]+)["']/g))tokens.add(m[1])}return{url:u.href,config,bootToken:tokens.size===1?[...tokens][0]:null}})()"#;

/// The session cookie among `result`'s (CDP `Storage.getCookies` shape) and
/// the workspace hosts the handoff and the cookie domains name: each host's
/// boot page gives its token, kept as a credential once Slack accepts it.
async fn derive_from(inner: &Arc<Inner>, result: &Value, handoff_hosts: &[String]) {
    let cookie = session_cookie(result, None);
    let mut hosts: Vec<String> = handoff_hosts.to_vec();
    if let Some(cookies) = result["cookies"].as_array() {
        hosts.extend(cookies.iter().filter_map(|c| c["domain"].as_str()).map(|d| d.trim_start_matches('.').to_owned()));
    }
    let Some(cookie) = cookie else { return };
    for host in workspace_hosts(&hosts).into_iter().take(20) {
        let Some(token) = boot_token(&host, &cookie).await else { continue };
        if let Ok(mut info) = account::login(&token, &cookie, None).await {
            let Some(account) = info.slack.take() else {
                info.auth_token.zeroize();
                continue;
            };
            let label = host.strip_suffix(".slack.com").unwrap_or(&host).to_owned();
            let credential = Credential {
                team_id: account.team_id,
                user_id: info.user_id.clone(),
                label,
                token: Zeroizing::new(std::mem::take(&mut info.auth_token)),
                cookie: account.cookie,
            };
            inner.credentials.lock().expect("Slack browser login").insert(credential.team_id.clone(), credential);
        }
    }
}

/// A cookie an app window read: what `derive_from` reads from CDP.
pub struct WindowCookie {
    pub name: String,
    pub value: Zeroizing<String>,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
}

/// Where an app window's Slack sign-in may go: Slack's own `https` pages.
pub fn window_page(raw: &str) -> bool {
    slack_url(raw).is_some()
}

/// Where it ends: the desktop handoff, or the web client loading instead.
pub fn window_done(raw: &str) -> bool {
    slack_url(raw).is_some_and(|url| is_handoff_url(&url) || is_client_url(&url))
}

/// The address an app window's Slack sign-in starts on, and whose cookies it reads.
pub const WINDOW_START: &str = "https://slack.com/signin";
pub const WINDOW_COOKIES: &str = "https://slack.com";

/// The one secure, HttpOnly, unexpired Slack `d` cookie of a CDP cookie list,
/// scoped to `url` when one is given.
fn session_cookie(result: &Value, url: Option<&url::Url>) -> Option<Zeroizing<String>> {
    let now = chrono::Utc::now().timestamp() as f64;
    let mut found = Vec::new();
    for cookie in result["cookies"].as_array().into_iter().flatten() {
        let name = cookie["name"].as_str().unwrap_or_default();
        let value = cookie["value"].as_str().unwrap_or_default();
        let domain = cookie["domain"].as_str().unwrap_or_default().trim_start_matches('.');
        let path = cookie["path"].as_str().unwrap_or("/");
        let expires = cookie["expires"].as_f64().unwrap_or(-1.0);
        if name == "d"
            && cookie["secure"] == true
            && cookie["httpOnly"] == true
            && valid_slack_host(domain)
            && url.is_none_or(|u| {
                (u.host_str() == Some(domain) || u.host_str().is_some_and(|h| h.ends_with(&format!(".{domain}"))))
                    && u.path().starts_with(path)
            })
            && (expires <= 0.0 || expires > now + 60.0)
            && validate_credentials("xoxc-placeholder", value).is_ok()
            && !found.iter().any(|f: &Zeroizing<String>| f.as_str() == value)
        {
            found.push(Zeroizing::new(value.to_owned()));
        }
    }
    if found.len() == 1 { found.pop() } else { None }
}

/// Slack's own hosts, never a workspace.
const INFRA_HOSTS: [&str; 12] =
    ["app", "api", "a", "edgeapi", "files", "downloads", "www", "my", "status", "slack", "join", "signin"];

/// The distinct `<workspace>.slack.com` hosts among `hosts`.
fn workspace_hosts(hosts: &[String]) -> Vec<String> {
    let mut found = Vec::new();
    for host in hosts {
        let host = host.to_ascii_lowercase();
        let Some(label) = host.strip_suffix(".slack.com") else { continue };
        if valid_slack_host(&host) && !INFRA_HOSTS.contains(&label) && !found.contains(&host) {
            found.push(host);
        }
    }
    found
}

/// The `xoxc` token a workspace's boot page carries for the session `cookie`.
/// Slack serves that page with a 403, token and all, so the status is not
/// read; a signed-out page has no token.
async fn boot_token(host: &str, cookie: &str) -> Option<Zeroizing<String>> {
    crate::tls::ensure_provider();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .ok()?;
    let mut url = slack_url(&format!("https://{host}/"))?;
    for _ in 0..6 {
        let response = client.get(url.clone()).header("Cookie", format!("d={cookie}")).send().await.ok()?;
        if response.status().is_redirection() {
            let next = response.headers().get("location")?.to_str().ok()?;
            url = slack_url(url.join(next).ok()?.as_str())?;
            continue;
        }
        let mut body = Zeroizing::new(Vec::new());
        let mut response = response;
        while let Some(chunk) = response.chunk().await.ok()? {
            if body.len() + chunk.len() > 4_000_000 {
                return None;
            }
            body.extend_from_slice(&chunk);
        }
        return scrape_token(&String::from_utf8_lossy(&body));
    }
    None
}

fn scrape_token(html: &str) -> Option<Zeroizing<String>> {
    let token = |at: usize| {
        let end =
            html[at + 5..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).map_or(html.len(), |n| at + 5 + n);
        (end > at + 5).then(|| Zeroizing::new(html[at..end].to_owned()))
    };
    let keyed = "\"api_token\":\"xoxc-";
    if let Some(at) = html.find(keyed).and_then(|at| token(at + keyed.len() - 5)) {
        return Some(at);
    }
    html.match_indices("xoxc-").find_map(|(at, _)| token(at))
}

#[derive(Clone)]
struct Candidate {
    team_id: String,
    label: String,
    token: Zeroizing<String>,
}

fn candidates(url: &str, config: &str, boot_token: &str) -> Vec<Candidate> {
    let Some(page) = slack_url(url).filter(is_client_url) else { return Vec::new() };
    let selected = page
        .path_segments()
        .and_then(|mut parts| {
            let first = parts.next()?;
            matches!(first, "client" | "app").then(|| parts.next()).flatten()
        })
        .filter(|id| valid_id(id, b"T"));
    let mut config: Value = serde_json::from_str(config).unwrap_or(Value::Null);
    let mut found = HashMap::new();
    if let Some(teams) = config["teams"].as_object() {
        for (key, team) in teams.iter().take(100) {
            let id = team["id"].as_str().unwrap_or(key);
            let team_url = team["url"].as_str().filter(|s| !s.is_empty()).map(str::to_owned).or_else(|| {
                team["domain"]
                    .as_str()
                    .filter(|s| s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
                    .map(|domain| format!("https://{domain}.slack.com/"))
            });
            if team_url.and_then(|u| slack_url(&u)).is_none() {
                continue;
            }
            let token = team["token"].as_str().unwrap_or_default();
            if !valid_id(id, b"T") || validate_credentials(token, "xoxd-placeholder").is_err() {
                continue;
            }
            let label = ["name", "team_name", "team", "label"]
                .iter()
                .find_map(|key| team[key].as_str().filter(|s| !s.is_empty()))
                .map(|s| s.chars().take(120).collect())
                .unwrap_or_else(|| id.to_owned());
            found.insert(
                id.to_owned(),
                Candidate { team_id: id.to_owned(), label, token: Zeroizing::new(token.to_owned()) },
            );
        }
    }
    if let Some(id) = selected.filter(|_| validate_credentials(boot_token, "xoxd-placeholder").is_ok()) {
        found.entry(id.to_owned()).or_insert_with(|| Candidate {
            team_id: id.to_owned(),
            label: id.to_owned(),
            token: Zeroizing::new(boot_token.to_owned()),
        });
    }
    zeroize_json(&mut config);
    found.into_values().take(20).collect()
}

fn slack_url(raw: &str) -> Option<url::Url> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
        || !url.host_str().is_some_and(valid_slack_host)
    {
        return None;
    }
    Some(url)
}

fn valid_slack_host(host: &str) -> bool {
    host == "slack.com"
        || host.strip_suffix(".slack.com").is_some_and(|prefix| {
            !prefix.is_empty()
                && !prefix.contains('.')
                && prefix.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn is_handoff_url(url: &url::Url) -> bool {
    url.path().starts_with("/ssb/")
}

fn is_client_url(url: &url::Url) -> bool {
    ["/client", "/app"].iter().any(|prefix| url.path() == *prefix || url.path().starts_with(&format!("{prefix}/")))
}

/// The launched browser's debugger. It picks its own port and writes it,
/// with the browser's endpoint path, to `DevToolsActivePort` in its profile:
/// no port is chosen here and freed for another process to take first.
async fn debugger_endpoint(child: &mut Child, profile: &std::path::Path) -> Result<String, &'static str> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let file = profile.join("DevToolsActivePort");
    loop {
        if Instant::now() >= deadline {
            return Err("browser_unavailable");
        }
        if child.try_wait().map_err(|_| "browser_unavailable")?.is_some() {
            return Err("browser_launch_failed");
        }
        if let Ok(text) = tokio::fs::read_to_string(&file).await
            && let Some((port, path)) = text.split_once('\n')
            && let Ok(port) = port.trim().parse::<u16>()
        {
            let endpoint = format!("ws://127.0.0.1:{port}{}", path.trim());
            if valid_debugger_endpoint(&endpoint, port) {
                return Ok(endpoint);
            }
        }
        sleep(Duration::from_millis(100)).await;
    }
}

/// Opens `url`, a page of Slack's web app, as an app window of a temporary
/// browser profile already signed in with the session's `d` cookie, so a
/// huddle needs no sign-in of its own. The profile, cookie included, is
/// deleted once the window closes. Answers the browser used.
pub async fn open_signed_in(url: &str, cookie: &str) -> Result<PathBuf, Error> {
    let target = super::translate::huddle_page(url).ok_or_else(|| failure("invalid_url"))?;
    let executable = browser_executable().ok_or_else(|| failure("browser_unavailable"))?;
    let profile = Profile::create().map_err(failure)?;
    let mut child = Command::new(&executable)
        .arg("--remote-debugging-address=127.0.0.1")
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.0.display()))
        .arg(format!("--app={target}"))
        .arg("--class=rocket-vibe-call")
        .args(["--no-first-run", "--no-default-browser-check", "--disable-sync"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| failure("browser_launch_failed"))?;
    let signed_in = async {
        let endpoint = debugger_endpoint(&mut child, &profile.0).await?;
        let (cdp, _events) = Cdp::connect(&endpoint).await?;
        let mut cookies = json!({"cookies": [{
            "name": "d", "value": cookie, "domain": ".slack.com", "path": "/",
            "secure": true, "httpOnly": true, "sameSite": "Lax",
        }]});
        let set = cdp.command("Storage.setCookies", cookies.clone(), None).await;
        zeroize_json(&mut cookies);
        set?;
        let targets = cdp.command("Target.getTargets", json!({}), None).await?;
        let page = targets["targetInfos"]
            .as_array()
            .and_then(|list| list.iter().find(|t| t["type"] == "page"))
            .and_then(|t| t["targetId"].as_str())
            .ok_or("browser_unavailable")?
            .to_owned();
        let attached = cdp.command("Target.attachToTarget", json!({"targetId": page, "flatten": true}), None).await?;
        let session = attached["sessionId"].as_str().ok_or("browser_unavailable")?;
        cdp.command("Page.navigate", json!({"url": target}), Some(session)).await?;
        Ok::<(), &'static str>(())
    }
    .await;
    if let Err(code) = signed_in {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(failure(code));
    }
    tokio::spawn(async move {
        let mut profile = profile;
        let _ = child.wait().await;
        profile.remove().await;
    });
    Ok(executable)
}

fn valid_debugger_endpoint(raw: &str, port: u16) -> bool {
    url::Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "ws"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(port)
            && url.path().starts_with("/devtools/browser/")
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

fn zeroize_json(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_json),
        Value::Object(values) => values.values_mut().for_each(zeroize_json),
        _ => {}
    }
}

fn browser_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "linux")]
    {
        candidates.extend([
            PathBuf::from("/usr/bin/chromium"),
            PathBuf::from("/usr/bin/chromium-browser"),
            PathBuf::from("/usr/bin/google-chrome"),
            PathBuf::from("/usr/bin/microsoft-edge"),
            PathBuf::from("/usr/bin/brave-browser"),
            PathBuf::from("/usr/bin/brave"),
            PathBuf::from("/snap/bin/chromium"),
        ]);
    }
    #[cfg(target_os = "macos")]
    {
        candidates.extend([
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            PathBuf::from("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
        ]);
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            candidates.extend([
                home.join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                home.join("Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
                home.join("Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
            ]);
        }
    }
    #[cfg(target_os = "windows")]
    {
        for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(variable) {
                let root = PathBuf::from(root);
                candidates.extend([
                    root.join("Google/Chrome/Application/chrome.exe"),
                    root.join("Microsoft/Edge/Application/msedge.exe"),
                    root.join("BraveSoftware/Brave-Browser/Application/brave.exe"),
                ]);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let names = [
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "microsoft-edge",
        "microsoft-edge-stable",
        "brave-browser",
        "brave",
        "vivaldi",
    ];
    #[cfg(target_os = "windows")]
    let names: [&str; 0] = [];
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            candidates.extend(names.iter().map(|name| directory.join(name)));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slack_urls_are_https_slack_hosts_only() {
        assert!(slack_url("https://app.slack.com/client/T1").is_some());
        assert!(slack_url("https://acme-1.slack.com/").is_some());
        assert!(slack_url("http://app.slack.com/client").is_none());
        assert!(slack_url("https://app.slack.com:8443/client").is_none());
        assert!(slack_url("https://a.b.slack.com/").is_none());
        assert!(slack_url("https://slack.com.evil.example/").is_none());
        assert!(slack_url("https://user@app.slack.com/").is_none());
        assert!(slack_url("https://ACME.slack.com/").is_some_and(|u| u.host_str() == Some("acme.slack.com")));
    }

    #[test]
    fn the_app_window_shows_slack_pages_and_stops_on_the_handoff_or_the_client() {
        assert!(window_page(WINDOW_START));
        assert!(window_page("https://acme.slack.com/signin"));
        assert!(!window_page("https://slack.com.evil.example/"));
        assert!(!window_page("http://slack.com/signin"));
        assert!(window_done("https://acme.slack.com/ssb/redirect"));
        assert!(window_done("https://app.slack.com/client/T1/C1"));
        assert!(!window_done(WINDOW_START));
        assert!(!window_done("https://evil.example/ssb/redirect"));
    }

    #[tokio::test]
    async fn an_app_window_without_its_session_cookie_fails_without_a_request() {
        let cookie = |name: &str, http_only| WindowCookie {
            name: name.to_owned(),
            value: Zeroizing::new("xoxd-abc".to_owned()),
            domain: ".slack.com".to_owned(),
            path: "/".to_owned(),
            secure: true,
            http_only,
        };
        let login = BrowserLogin::from_window(
            "https://acme.slack.com/ssb/redirect",
            vec![cookie("b", true), cookie("d", false)],
        );
        for _ in 0..200 {
            if !matches!(login.state(), State::SigningIn) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(matches!(login.state(), State::Failed("authentication_failed")));
    }

    #[test]
    fn client_and_handoff_paths() {
        let url = |raw| slack_url(raw).unwrap();
        assert!(is_client_url(&url("https://app.slack.com/client")));
        assert!(is_client_url(&url("https://app.slack.com/client/T1/C1")));
        assert!(is_client_url(&url("https://acme.slack.com/app")));
        assert!(!is_client_url(&url("https://app.slack.com/clientele")));
        assert!(is_handoff_url(&url("https://acme.slack.com/ssb/redirect")));
        assert!(!is_handoff_url(&url("https://acme.slack.com/signin")));
    }

    #[test]
    fn debugger_endpoint_must_be_the_launched_local_port() {
        assert!(valid_debugger_endpoint("ws://127.0.0.1:9222/devtools/browser/abc", 9222));
        assert!(!valid_debugger_endpoint("ws://127.0.0.1:9223/devtools/browser/abc", 9222));
        assert!(!valid_debugger_endpoint("ws://example.com:9222/devtools/browser/abc", 9222));
        assert!(!valid_debugger_endpoint("ws://127.0.0.1:9222/devtools/page/abc", 9222));
        assert!(!valid_debugger_endpoint("ws://127.0.0.1:9222/devtools/browser/abc?x=1", 9222));
    }

    #[test]
    fn candidates_come_from_local_config_teams() {
        let config = json!({"teams": {
            "T1": {"id": "T1", "name": "Acme", "url": "https://acme.slack.com/", "token": "xoxc-1-a"},
            "T2": {"id": "T2", "domain": "beta", "token": "xoxc-2-b"},
            "T3": {"id": "T3", "name": "Elsewhere", "url": "https://evil.example/", "token": "xoxc-3-c"},
            "T4": {"id": "T4", "name": "No token", "url": "https://four.slack.com/"},
            "bad": {"id": "t5", "url": "https://five.slack.com/", "token": "xoxc-5-e"}
        }})
        .to_string();
        let mut found = candidates("https://app.slack.com/client/T1", &config, "");
        found.sort_by(|a, b| a.team_id.cmp(&b.team_id));
        let summary: Vec<_> = found.iter().map(|c| (c.team_id.as_str(), c.label.as_str(), c.token.as_str())).collect();
        assert_eq!(summary, [("T1", "Acme", "xoxc-1-a"), ("T2", "T2", "xoxc-2-b")]);
    }

    #[test]
    fn boot_token_names_the_workspace_in_the_url() {
        let found = candidates("https://app.slack.com/client/T9/C1", "", "xoxc-9-z");
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].team_id.as_str(), found[0].token.as_str()), ("T9", "xoxc-9-z"));
        assert!(candidates("https://app.slack.com/client", "", "xoxc-9-z").is_empty());
        assert!(candidates("https://app.slack.com/client/T9", "", "not-a-token").is_empty());
        assert!(candidates("https://app.slack.com/signin", "", "xoxc-9-z").is_empty());
    }

    #[test]
    fn config_entry_wins_over_the_boot_token() {
        let config = json!({"teams": {"T1": {"name": "Acme", "domain": "acme", "token": "xoxc-config"}}}).to_string();
        let found = candidates("https://app.slack.com/client/T1", &config, "xoxc-boot");
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].label.as_str(), found[0].token.as_str()), ("Acme", "xoxc-config"));
    }

    #[test]
    fn zeroize_json_blanks_every_string() {
        let mut value = json!({"a": "secret", "b": ["x", {"c": "y"}], "n": 1});
        zeroize_json(&mut value);
        assert_eq!(value, json!({"a": "", "b": ["", {"c": ""}], "n": 1}));
    }

    #[test]
    fn workspace_hosts_skip_slack_infrastructure() {
        let hosts: Vec<String> = [
            "acme.slack.com",
            "app.slack.com",
            "slack.com",
            "ACME.slack.com",
            "beta.slack.com",
            "a.b.slack.com",
            "evil.example",
        ]
        .map(str::to_owned)
        .to_vec();
        assert_eq!(workspace_hosts(&hosts), ["acme.slack.com", "beta.slack.com"]);
    }

    #[test]
    fn boot_page_token_prefers_the_keyed_one() {
        let html = r#"<script>x="xoxc-other"; boot={"api_token":"xoxc-123-abc","team":"T1"}</script>"#;
        assert_eq!(scrape_token(html).as_deref().map(String::as_str), Some("xoxc-123-abc"));
        assert_eq!(scrape_token(r#"a "xoxc-9-z" b"#).as_deref().map(String::as_str), Some("xoxc-9-z"));
        assert!(scrape_token(r#"{"api_token":null}"#).is_none());
        assert!(scrape_token("xoxc-").is_none());
    }

    #[test]
    fn session_cookie_is_the_one_secure_http_only_d() {
        let cookie = |name: &str, value: &str, domain: &str, secure: bool| json!({"name": name, "value": value, "domain": domain, "path": "/", "secure": secure, "httpOnly": true, "expires": -1});
        let list = |cookies: Vec<Value>| json!({"cookies": cookies});
        let found = session_cookie(
            &list(vec![cookie("d", "xoxd-a", ".slack.com", true), cookie("b", "x", ".slack.com", true)]),
            None,
        );
        assert_eq!(found.as_deref().map(String::as_str), Some("xoxd-a"));
        assert!(session_cookie(&list(vec![cookie("d", "xoxd-a", ".slack.com", false)]), None).is_none());
        assert!(session_cookie(&list(vec![cookie("d", "xoxd-a", ".evil.example", true)]), None).is_none());
        let twice =
            list(vec![cookie("d", "xoxd-a", ".slack.com", true), cookie("d", "xoxd-b", "acme.slack.com", true)]);
        assert!(session_cookie(&twice, None).is_none());
        let page = url::Url::parse("https://beta.slack.com/client").unwrap();
        let scoped =
            list(vec![cookie("d", "xoxd-a", ".slack.com", true), cookie("d", "xoxd-b", "acme.slack.com", true)]);
        assert_eq!(session_cookie(&scoped, Some(&page)).as_deref().map(String::as_str), Some("xoxd-a"));
    }
}
