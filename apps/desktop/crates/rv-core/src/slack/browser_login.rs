use super::{Error, account, id as valid_id, validate_credentials};
use crate::session::SessionInfo;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    net::TcpListener,
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
    sync::{Mutex as AsyncMutex, watch},
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

impl Profile {
    fn create() -> Result<Self, &'static str> {
        let base = std::env::temp_dir();
        for _ in 0..8 {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|_| "randomness_unavailable")?;
            let name = random.iter().map(|b| format!("{b:02x}")).collect::<String>();
            let path = base.join(format!("rocketvibe-slack-login-{name}"));
            match std::fs::create_dir(&path) {
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

struct Cdp {
    socket: AsyncMutex<Socket>,
    next_id: AtomicU64,
}

impl Cdp {
    async fn connect(endpoint: &str) -> Result<Arc<Self>, &'static str> {
        let (socket, _) = timeout(Duration::from_secs(10), connect_async(endpoint))
            .await
            .map_err(|_| "browser_unavailable")?
            .map_err(|_| "browser_unavailable")?;
        Ok(Arc::new(Self { socket: AsyncMutex::new(socket), next_id: AtomicU64::new(1) }))
    }

    async fn command(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, &'static str> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut request = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            request["sessionId"] = json!(session);
        }
        let text = serde_json::to_string(&request).map_err(|_| "browser_command_failed")?;
        let mut socket = self.socket.lock().await;
        timeout(Duration::from_secs(12), async {
            socket.send(Message::Text(text.into())).await.map_err(|_| "browser_closed")?;
            loop {
                let message = socket.next().await.ok_or("browser_closed")?.map_err(|_| "browser_closed")?;
                if !message.is_text() {
                    continue;
                }
                let mut raw = message.into_text().map_err(|_| "browser_command_failed")?.to_string();
                if raw.len() > 4_000_000 {
                    raw.zeroize();
                    return Err("browser_command_failed");
                }
                let mut packet: Value = match serde_json::from_str(&raw) {
                    Ok(packet) => packet,
                    Err(_) => {
                        raw.zeroize();
                        continue;
                    }
                };
                raw.zeroize();
                if packet["id"].as_u64() != Some(id) {
                    zeroize_json(&mut packet);
                    continue;
                }
                if packet["error"].is_object() {
                    zeroize_json(&mut packet);
                    return Err("browser_command_failed");
                }
                let result = packet.get("result").cloned().unwrap_or(Value::Null);
                zeroize_json(&mut packet);
                return Ok(result);
            }
        })
        .await
        .map_err(|_| "browser_timeout")?
    }
}

struct Browser {
    child: Option<Child>,
    profile: Profile,
    cdp: Arc<Cdp>,
}

impl Browser {
    async fn launch(executable: PathBuf) -> Result<Self, &'static str> {
        let profile = Profile::create()?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "browser_unavailable")?;
        let port = listener.local_addr().map_err(|_| "browser_unavailable")?.port();
        drop(listener);

        let mut child = Command::new(executable)
            .arg("--remote-debugging-address=127.0.0.1")
            .arg(format!("--remote-debugging-port={port}"))
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

        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "browser_unavailable")?;
        let version_url = format!("http://127.0.0.1:{port}/json/version");
        let deadline = Instant::now() + Duration::from_secs(15);
        let endpoint = loop {
            if Instant::now() >= deadline {
                return Err("browser_unavailable");
            }
            if child.try_wait().map_err(|_| "browser_unavailable")?.is_some() {
                return Err("browser_launch_failed");
            }
            if let Ok(response) = http.get(&version_url).send().await
                && response.status().is_success()
            {
                let bytes = response.bytes().await.map_err(|_| "browser_unavailable")?;
                if bytes.len() <= 65536 {
                    let body: Value = serde_json::from_slice(&bytes).map_err(|_| "browser_unavailable")?;
                    if let Some(endpoint) = body["webSocketDebuggerUrl"].as_str()
                        && valid_debugger_endpoint(endpoint, port)
                    {
                        break endpoint.to_owned();
                    }
                }
            }
            sleep(Duration::from_millis(100)).await;
        };
        let cdp = Cdp::connect(&endpoint).await?;
        Ok(Self { child: Some(child), profile, cdp })
    }

    async fn capture(&mut self, inner: &Arc<Inner>, mut cancel: watch::Receiver<bool>) -> Result<(), &'static str> {
        let deadline = Instant::now() + Duration::from_secs(20 * 60);
        let mut cookie_fingerprint = None;
        let mut checked: HashMap<[u8; 32], Instant> = HashMap::new();
        let mut redirected = HashSet::new();
        let mut ready_since = None;

        loop {
            tokio::select! {
                _ = cancel.changed() => {
                    if *cancel.borrow() {
                        return Err("cancelled");
                    }
                }
                _ = sleep(Duration::from_millis(800)) => {}
                _ = tokio::time::sleep_until(deadline) => return Err("timeout"),
            }
            if *cancel.borrow() {
                return Err("cancelled");
            }
            if self.child.as_mut().and_then(|child| child.try_wait().ok().flatten()).is_some() {
                return if workspaces(inner).is_some() { Ok(()) } else { Err("browser_closed") };
            }
            self.inspect(inner, &mut cookie_fingerprint, &mut checked, &mut redirected).await?;
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

    async fn inspect(
        &self,
        inner: &Arc<Inner>,
        cookie_fingerprint: &mut Option<[u8; 32]>,
        checked: &mut HashMap<[u8; 32], Instant>,
        redirected: &mut HashSet<String>,
    ) -> Result<(), &'static str> {
        let result = self.cdp.command("Target.getTargets", json!({}), None).await?;
        let targets = result["targetInfos"].as_array().cloned().unwrap_or_default();
        for target in targets.into_iter().filter(|t| t["type"] == "page").take(20) {
            let target_id = target["targetId"].as_str().unwrap_or_default().to_owned();
            let raw_url = target["url"].as_str().unwrap_or_default();
            let Some(page_url) = slack_url(raw_url) else { continue };
            if !is_handoff_url(&page_url) && !is_client_url(&page_url) {
                continue;
            }
            let Ok(attached) =
                self.cdp.command("Target.attachToTarget", json!({"targetId": target_id, "flatten": true}), None).await
            else {
                continue;
            };
            let Some(session_id) = attached["sessionId"].as_str() else { continue };
            let session_id = session_id.to_owned();
            let cookie = read_session_cookie(&self.cdp, &session_id, raw_url).await;
            if let Some(cookie) = cookie {
                let fingerprint: [u8; 32] = Sha256::digest(cookie.as_bytes()).into();
                if cookie_fingerprint.is_some_and(|old| old != fingerprint) {
                    inner.credentials.lock().expect("Slack browser login").clear();
                    checked.clear();
                    inner.set_state(State::SigningIn);
                }
                *cookie_fingerprint = Some(fingerprint);

                if is_handoff_url(&page_url) {
                    if redirected.insert(target_id.clone()) {
                        let _ = self
                            .cdp
                            .command("Page.navigate", json!({"url":"https://app.slack.com/client"}), Some(&session_id))
                            .await;
                    }
                } else {
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
                                    if checked
                                        .get(&fingerprint)
                                        .is_some_and(|at| at.elapsed() < Duration::from_secs(30))
                                    {
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

            let _ = self.cdp.command("Target.detachFromTarget", json!({"sessionId": session_id}), None).await;
        }
        Ok(())
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

const SNAPSHOT: &str = r#"(()=>{const u=new URL(location.href);if(u.protocol!=="https:"||u.port||!/^([a-z0-9-]+\.)?slack\.com$/.test(u.hostname)||!/^\/(client|app)(\/|$)/.test(u.pathname))return null;let config=null;try{const s=localStorage.getItem("localConfig_v2");if(s&&s.length<=2000000)config=s}catch{}let total=0;const tokens=new Set();for(const s of document.scripts){const t=s.textContent||"";total+=t.length;if(total>2000000)break;for(const m of t.matchAll(/["']api_token["']\s*:\s*["'](xoxc-[A-Za-z0-9-]+)["']/g))tokens.add(m[1])}return{url:u.href,config,bootToken:tokens.size===1?[...tokens][0]:null}})()"#;

async fn read_session_cookie(cdp: &Cdp, session_id: &str, url: &str) -> Option<Zeroizing<String>> {
    let mut result = cdp.command("Network.getCookies", json!({"urls":[url]}), Some(session_id)).await.ok()?;
    let now = chrono::Utc::now().timestamp() as f64;
    let mut found = Vec::new();
    if let Some(cookies) = result["cookies"].as_array() {
        for cookie in cookies {
            let name = cookie["name"].as_str().unwrap_or_default();
            let value = cookie["value"].as_str().unwrap_or_default();
            let domain = cookie["domain"].as_str().unwrap_or_default().trim_start_matches('.');
            let path = cookie["path"].as_str().unwrap_or("/");
            let expires = cookie["expires"].as_f64().unwrap_or(-1.0);
            if name == "d"
                && cookie["secure"] == true
                && cookie["httpOnly"] == true
                && valid_slack_host(domain)
                && url::Url::parse(url).ok().is_some_and(|u| {
                    (u.host_str() == Some(domain) || u.host_str().is_some_and(|h| h.ends_with(&format!(".{domain}"))))
                        && u.path().starts_with(path)
                })
                && (expires <= 0.0 || expires > now + 60.0)
                && validate_credentials("xoxc-placeholder", value).is_ok()
            {
                found.push(Zeroizing::new(value.to_owned()));
            }
        }
    }
    zeroize_json(&mut result);
    if found.len() == 1 { found.pop() } else { None }
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
    let names = ["chromium", "chromium-browser", "google-chrome", "microsoft-edge", "brave-browser", "brave"];
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
}
