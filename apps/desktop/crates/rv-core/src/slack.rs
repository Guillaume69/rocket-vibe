//! Slack session-mode read preview. Fixed API origin, no writes or persistent credentials.
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use zeroize::Zeroize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub key: String,
    pub team_id: String,
    pub user_id: String,
    pub team: String,
    pub user: String,
    pub origin: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub name: String,
    pub kind: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub ts: String,
    pub user: String,
    pub text: String,
    pub thread_ts: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}
#[derive(Debug, thiserror::Error)]
#[error("Slack: {code}")]
pub struct Error {
    pub code: &'static str,
    pub status: u16,
    pub retry_after: Option<u64>,
}
fn failure(code: &'static str) -> Error {
    Error { code, status: 0, retry_after: None }
}
fn code(raw: &str) -> &'static str {
    match raw {
        "invalid_auth" => "invalid_auth",
        "not_authed" => "not_authed",
        "token_expired" => "token_expired",
        "token_revoked" => "token_revoked",
        "account_inactive" => "account_inactive",
        "missing_scope" => "missing_scope",
        "not_allowed_token_type" => "not_allowed_token_type",
        "no_permission" => "no_permission",
        "channel_not_found" => "channel_not_found",
        "not_in_channel" => "not_in_channel",
        "org_login_required" => "org_login_required",
        "ratelimited" => "ratelimited",
        _ => "api_error",
    }
}
struct Credentials {
    token: String,
    cookie: String,
}
impl Drop for Credentials {
    fn drop(&mut self) {
        self.token.zeroize();
        self.cookie.zeroize();
    }
}
pub fn validate_credentials(token: &str, cookie: &str) -> Result<(), Error> {
    if !token.starts_with("xoxc-")
        || token.len() <= 5
        || token.len() > 16384
        || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || !cookie.starts_with("xoxd-")
        || cookie.len() <= 5
        || cookie.len() > 16384
        || !cookie.bytes().all(|b| (0x21..=0x7e).contains(&b) && !b";,\"\\".contains(&b))
    {
        return Err(failure("invalid_credentials"));
    }
    Ok(())
}
fn field(value: &Value, name: &str) -> String {
    value[name].as_str().unwrap_or_default().to_owned()
}
fn id(raw: &str, prefixes: &[u8]) -> bool {
    raw.len() > 1
        && raw.len() <= 128
        && prefixes.contains(&raw.as_bytes()[0])
        && raw.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}
pub fn exact_timestamp(raw: &str) -> Result<(&str, &str), Error> {
    let Some((seconds, fraction)) = raw.split_once('.') else {
        return Err(failure("invalid_timestamp"));
    };
    if seconds.is_empty()
        || seconds.len() > 12
        || fraction.len() != 6
        || !seconds.bytes().chain(fraction.bytes()).all(|b| b.is_ascii_digit())
    {
        return Err(failure("invalid_timestamp"));
    }
    Ok((seconds, fraction))
}
fn compare_timestamp(a: &str, b: &str) -> std::cmp::Ordering {
    // Only called on validated timestamps. Seconds fit in u64, fractions remain exact.
    let (a, af) = exact_timestamp(a).expect("validated timestamp");
    let (b, bf) = exact_timestamp(b).expect("validated timestamp");
    a.parse::<u64>().expect("validated seconds").cmp(&b.parse().expect("validated seconds")).then(af.cmp(bf))
}
fn cursor(body: &Value) -> Result<Option<String>, Error> {
    let metadata = &body["response_metadata"];
    if !metadata.is_null() && !metadata.is_object() {
        return Err(failure("invalid_response"));
    }
    match &metadata["next_cursor"] {
        Value::Null => Ok(None),
        Value::String(s) if s.is_empty() => Ok(None),
        Value::String(s) if s.len() <= 4096 => Ok(Some(s.clone())),
        _ => Err(failure("invalid_response")),
    }
}
fn identity(body: &Value) -> Result<Identity, Error> {
    let team_id = field(body, "team_id");
    let user_id = field(body, "user_id");
    let url = url::Url::parse(&field(body, "url")).map_err(|_| failure("invalid_identity"))?;
    if !id(&team_id, b"T")
        || !id(&user_id, b"UW")
        || url.scheme() != "https"
        || !url.host_str().is_some_and(|s| s.ends_with(".slack.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(failure("invalid_identity"));
    }
    let team = field(body, "team");
    let user = field(body, "user");
    Ok(Identity {
        key: format!("slack:{team_id}:{user_id}"),
        team: if team.is_empty() { team_id.clone() } else { team },
        user: if user.is_empty() { user_id.clone() } else { user },
        team_id,
        user_id,
        origin: url.origin().ascii_serialization(),
    })
}
/// Transient, account-pinned connection. Debug never contains credentials.
pub struct Reader {
    client: reqwest::Client,
    api: String,
    credentials: Mutex<Option<Credentials>>,
    identity: Mutex<Option<Identity>>,
    closed: AtomicBool,
    cancellation: tokio::sync::watch::Sender<bool>,
}
impl Reader {
    pub fn new(token: String, cookie: String) -> Result<Arc<Self>, Error> {
        Self::with_api(token, cookie, "https://slack.com/api/".to_owned())
    }
    fn with_api(token: String, cookie: String, api: String) -> Result<Arc<Self>, Error> {
        // Even rejected credential buffers are erased when they leave this scope.
        let credentials = Credentials { token, cookie };
        validate_credentials(&credentials.token, &credentials.cookie)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| failure("connection_failed"))?;
        let (cancellation, _) = tokio::sync::watch::channel(false);
        Ok(Arc::new(Self {
            client,
            api,
            credentials: Mutex::new(Some(credentials)),
            identity: Mutex::new(None),
            closed: AtomicBool::new(false),
            cancellation,
        }))
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.cancellation.send_replace(true);
        self.credentials.lock().expect("credentials").take();
        self.identity.lock().expect("identity").take();
    }
    async fn call(&self, method: &'static str, args: &[(&str, &str)]) -> Result<Value, Error> {
        let mut cancellation = self.cancellation.subscribe();
        if self.closed.load(Ordering::Acquire) {
            return Err(failure("cancelled"));
        }
        let request = {
            let credentials = self.credentials.lock().expect("credentials");
            let credentials = credentials.as_ref().ok_or_else(|| failure("cancelled"))?;
            self.client
                .post(format!("{}{method}", self.api))
                .bearer_auth(&credentials.token)
                .header(reqwest::header::COOKIE, format!("d={}", credentials.cookie))
                .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded; charset=utf-8")
                .body(url::form_urlencoded::Serializer::new(String::new()).extend_pairs(args.iter().copied()).finish())
        };
        let work = async {
            let mut response = request.send().await.map_err(|_| failure("connection_failed"))?;
            let status = response.status().as_u16();
            let retry_after =
                response.headers().get("retry-after").and_then(|s| s.to_str().ok()).and_then(|s| s.parse().ok());
            if status == 429 {
                return Err(Error { code: "ratelimited", status, retry_after });
            }
            if !response.status().is_success() {
                return Err(Error { code: "http_error", status, retry_after: None });
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| failure("connection_failed"))? {
                if bytes.len() + chunk.len() > 2_000_000 {
                    return Err(failure("response_too_large"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value = serde_json::from_slice(&bytes).map_err(|_| failure("invalid_response"))?;
            if body["ok"] == false {
                return Err(Error { code: code(body["error"].as_str().unwrap_or_default()), status, retry_after });
            }
            if body["ok"] != true {
                return Err(failure("invalid_response"));
            }
            if self.closed.load(Ordering::Acquire) {
                return Err(failure("cancelled"));
            }
            Ok(body)
        };
        tokio::select! { result=work=>result, _=cancellation.changed()=>Err(failure("cancelled")) }
    }
    pub async fn authenticate(&self) -> Result<Identity, Error> {
        let who = identity(&self.call("auth.test", &[]).await?)?;
        let mut pinned = self.identity.lock().expect("identity");
        if self.closed.load(Ordering::Acquire) {
            return Err(failure("cancelled"));
        }
        if pinned.as_ref().is_some_and(|p| p.key != who.key) {
            return Err(failure("identity_changed"));
        }
        *pinned = Some(who.clone());
        Ok(who)
    }
    fn authenticated(&self) -> Result<(), Error> {
        if self.closed.load(Ordering::Acquire) {
            return Err(failure("cancelled"));
        }
        if self.identity.lock().expect("identity").is_none() {
            return Err(failure("authentication_required"));
        }
        Ok(())
    }
    pub async fn conversations(&self, next: Option<&str>) -> Result<Page<Conversation>, Error> {
        self.authenticated()?;
        let body = self
            .call(
                "users.conversations",
                &[
                    ("types", "public_channel,private_channel,im,mpim"),
                    ("exclude_archived", "true"),
                    ("limit", "100"),
                    ("cursor", next.unwrap_or_default()),
                ],
            )
            .await?;
        let channels = body["channels"].as_array().ok_or_else(|| failure("invalid_response"))?;
        let items = channels
            .iter()
            .map(|r| {
                let rid = field(r, "id");
                if !id(&rid, b"CDG") {
                    return Err(failure("invalid_response"));
                }
                let kind = if r["is_im"] == true {
                    "direct"
                } else if r["is_mpim"] == true {
                    "group"
                } else if r["is_private"] == true {
                    "private"
                } else {
                    "channel"
                };
                let mut name = field(r, "name");
                if name.is_empty() {
                    name = field(r, "user");
                }
                if name.is_empty() {
                    name = rid.clone();
                }
                Ok(Conversation { id: rid, name, kind: kind.to_owned() })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        Ok(Page { items, next_cursor: cursor(&body)? })
    }
    pub async fn history(&self, channel: &str, next: Option<&str>) -> Result<Page<Message>, Error> {
        self.authenticated()?;
        if !id(channel, b"CDG") {
            return Err(failure("invalid_channel"));
        }
        let body = self
            .call(
                "conversations.history",
                &[("channel", channel), ("limit", "50"), ("cursor", next.unwrap_or_default())],
            )
            .await?;
        let mut items = body["messages"]
            .as_array()
            .ok_or_else(|| failure("invalid_response"))?
            .iter()
            .map(|m| {
                let ts = field(m, "ts");
                exact_timestamp(&ts)?;
                let thread_ts = match &m["thread_ts"] {
                    Value::Null => None,
                    Value::String(s) => {
                        exact_timestamp(s)?;
                        Some(s.clone())
                    }
                    _ => return Err(failure("invalid_timestamp")),
                };
                let mut user = field(m, "user");
                if user.is_empty() {
                    user = field(m, "bot_id");
                }
                Ok(Message { ts, user, text: field(m, "text"), thread_ts })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        items.sort_by(|a, b| compare_timestamp(&b.ts, &a.ts));
        let next_cursor = cursor(&body)?;
        if body["has_more"] == true && next_cursor.is_none() {
            return Err(failure("pagination_unsupported"));
        }
        Ok(Page { items, next_cursor })
    }
}
/// Shared nine-activation gate. Call with elapsed monotonic milliseconds.
#[derive(Default)]
pub struct Unlock {
    count: u8,
    last: Option<u64>,
}
impl Unlock {
    pub fn tap(&mut self, now: u64) -> bool {
        if self.last.is_none_or(|last| now < last || now - last > 2000) {
            self.count = 0;
        }
        self.last = Some(now);
        self.count += 1;
        if self.count == 9 {
            self.count = 0;
            self.last = None;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const TOKEN: &str = "xoxc-synthetic";
    const COOKIE: &str = "xoxd-original%2Bbytes%3D";
    fn auth() -> Value {
        json!({"ok":true,"team_id":"TTEST","user_id":"UTEST","team":"Test","user":"test","url":"https://test.slack.com/"})
    }
    async fn server(responses: Vec<(u16, Value, Option<u64>)>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}/api/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, body, retry) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buf = [0; 2048];
                    let n = socket.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&bytes[..end]);
                        let length = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|s| s.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                let body = body.to_string();
                let retry = retry.map(|n| format!("Retry-After: {n}\r\n")).unwrap_or_default();
                let reply = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n{retry}\r\n{body}",
                    body.len()
                );
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
            requests
        });
        (api, task)
    }
    #[test]
    fn credentials_and_identity_boundaries() {
        validate_credentials(TOKEN, COOKIE).unwrap();
        for cookie in ["xoxd-a; x=b", "xoxd-a\r\nX: y", "xoxd-a b", "xoxd-a,b", "xoxd-a\\b"] {
            assert!(validate_credentials(TOKEN, cookie).is_err());
        }
        for url in [
            "https://evilslack.com/",
            "http://test.slack.com/",
            "https://test.slack.com.evil.test/",
            "https://user@test.slack.com/",
        ] {
            let mut v = auth();
            v["url"] = json!(url);
            assert!(identity(&v).is_err());
        }
        assert_eq!(identity(&auth()).unwrap().key, "slack:TTEST:UTEST");
    }
    #[test]
    fn nine_activations_with_reset() {
        let mut gate = Unlock::default();
        for n in 0..8 {
            assert!(!gate.tap(n * 100));
        }
        assert!(gate.tap(800));
        assert!(!gate.tap(900));
        for n in 0..8 {
            assert!(!gate.tap(10000 + n * 100));
        }
        assert!(gate.tap(10800));
    }
    #[tokio::test]
    async fn read_headers_cursors_and_exact_history() {
        let(api,requests)=server(vec![(200,auth(),None),(200,json!({"ok":true,"channels":[],"response_metadata":{"next_cursor":"opaque+/="}}),None),(200,json!({"ok":true,"messages":[{"ts":"1780000000.000001","text":"a"},{"ts":"1780000000.000009","text":"b"}]}),None)]).await;
        let reader = Reader::with_api(TOKEN.into(), COOKIE.into(), api).unwrap();
        reader.authenticate().await.unwrap();
        assert_eq!(reader.conversations(None).await.unwrap().next_cursor.as_deref(), Some("opaque+/="));
        let page = reader.history("CTEST", Some("opaque+/=")).await.unwrap();
        assert_eq!(
            page.items.iter().map(|m| m.ts.as_str()).collect::<Vec<_>>(),
            vec!["1780000000.000009", "1780000000.000001"]
        );
        for request in requests.await.unwrap() {
            let lower = request.to_ascii_lowercase();
            assert!(lower.contains("authorization: bearer xoxc-synthetic"));
            assert!(request.contains(&format!("d={COOKIE}")));
            assert!(lower.starts_with("post /api/"));
        }
        reader.close();
        assert_eq!(reader.authenticate().await.unwrap_err().code, "cancelled");
    }
    #[tokio::test]
    async fn throttles_and_proxy_errors_do_not_expose_bodies() {
        for (status, body, retry, expected) in [
            (429, json!({"private":"secret"}), Some(27), "ratelimited"),
            (401, json!({"private":"secret"}), None, "http_error"),
            (200, json!({"ok":false,"error":"private secret"}), None, "api_error"),
            (200, json!({}), None, "invalid_response"),
        ] {
            let (api, requests) = server(vec![(status, body, retry)]).await;
            let reader = Reader::with_api(TOKEN.into(), COOKIE.into(), api).unwrap();
            let error = reader.authenticate().await.unwrap_err();
            assert_eq!(error.code, expected);
            assert_eq!(error.retry_after, retry);
            assert!(!error.to_string().contains("secret"));
            assert_eq!(requests.await.unwrap().len(), 1);
        }
    }
    #[tokio::test]
    async fn redirects_are_never_followed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}/api/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0; 2048];
            assert!(socket.read(&mut buf).await.unwrap() > 0);
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://evil.test/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        });
        let reader = Reader::with_api(TOKEN.into(), COOKIE.into(), api).unwrap();
        assert_eq!(reader.authenticate().await.unwrap_err().code, "http_error");
        task.await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_releases_pending_network_work() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}/api/", listener.local_addr().unwrap());
        let reader = Reader::with_api(TOKEN.into(), COOKIE.into(), api).unwrap();
        let work = reader.clone();
        let pending = tokio::spawn(async move { work.authenticate().await });
        let (socket, _) = listener.accept().await.unwrap();
        reader.close();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), pending).await.unwrap().unwrap().unwrap_err().code,
            "cancelled"
        );
        drop(socket);
    }
}
