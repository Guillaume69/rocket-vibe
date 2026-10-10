//! Private Teams read foundation. Browser identity acquisition is a separate, unresolved gate.
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;
use zeroize::Zeroize;

#[derive(Debug, thiserror::Error)]
#[error("Teams: {code}")]
pub struct Error {
    pub code: &'static str,
    pub status: u16,
    pub retry_after: Option<u64>,
}
fn failure(code: &'static str) -> Error {
    Error { code, status: 0, retry_after: None }
}
#[derive(Clone, Debug)]
pub struct Account {
    pub tenant_id: String,
    pub account_id: String,
}
impl Account {
    /// From a supported sign-in result/profile. Never decode Microsoft API access tokens.
    pub fn key(&self) -> Result<String, Error> {
        let t = self.tenant_id.as_bytes();
        if t.len() != 36
            || !t
                .iter()
                .enumerate()
                .all(|(i, b)| if [8, 13, 18, 23].contains(&i) { *b == b'-' } else { b.is_ascii_hexdigit() })
        {
            return Err(failure("invalid_identity"));
        }
        opaque(&Value::String(self.account_id.clone()))?;
        Ok(serde_json::json!(["teams", "global", self.tenant_id.to_lowercase(), self.account_id]).to_string())
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Routes {
    aggregator: String,
    chat: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub name: String,
    pub kind: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub key: String,
    pub id: String,
    pub conversation_id: String,
    pub root_id: Option<String>,
    pub version: Option<String>,
    pub author: String,
    pub arrived_at: String,
    pub content: String,
    pub format: String,
}
#[derive(Clone, Debug)]
pub struct History {
    pub items: Vec<Message>,
    pub backward_link: Option<String>,
}
fn object(v: &Value) -> Result<&Value, Error> {
    if v.is_object() { Ok(v) } else { Err(failure("invalid_response")) }
}
fn opaque(v: &Value) -> Result<&str, Error> {
    v.as_str()
        .filter(|s| {
            !s.is_empty() && *s != "." && *s != ".." && s.len() <= 2048 && !s.chars().any(|c| c.is_ascii_control())
        })
        .ok_or_else(|| failure("invalid_identity"))
}
fn optional(v: &Value, max: usize) -> Result<&str, Error> {
    if v.is_null() {
        return Ok("");
    }
    v.as_str().filter(|s| s.len() <= max).ok_or_else(|| failure("invalid_response"))
}
fn parse_url(raw: &str) -> Result<url::Url, Error> {
    if raw.len() > 16384 || raw.bytes().any(|b| b <= 0x20 || b == 0x7f || b == b'\\') {
        return Err(failure("unsafe_route"));
    }
    let u = url::Url::parse(raw).map_err(|_| failure("unsafe_route"))?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || u.fragment().is_some()
    {
        return Err(failure("unsafe_route"));
    }
    Ok(u)
}
fn route(raw: &str, service: &str) -> Result<String, Error> {
    let u = parse_url(raw)?;
    let prefix = format!("/api/{service}/");
    let region = u.path().strip_prefix(&prefix).unwrap_or_default().trim_end_matches('/');
    if u.host_str() != Some("teams.microsoft.com")
        || u.query().is_some()
        || region.is_empty()
        || !region.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || u.path().ends_with("//")
    {
        return Err(failure("unsafe_route"));
    }
    Ok(format!("https://teams.microsoft.com{}", u.path().trim_end_matches('/')))
}
impl Routes {
    /// Only observed proxy roles qualify initially. Ignore tokens and fallback alias names.
    pub fn discover(body: &Value) -> Result<Self, Error> {
        let gtms = object(&object(body)?["regionGtms"])?;
        Ok(Self {
            aggregator: route(optional(&gtms["chatSvcAggAfd"], 16384)?, "csa")?,
            chat: route(optional(&gtms["chatServiceAfd"], 16384)?, "chatsvc")?,
        })
    }
    pub fn snapshot_url(&self) -> String {
        format!("{}/api/v2/teams/users/me?isPrefetch=false&enableMembershipSummary=true", self.aggregator)
    }
    pub fn history_url(&self, conversation: &str) -> Result<String, Error> {
        opaque(&Value::String(conversation.to_owned()))?;
        let mut u = url::Url::parse(&format!("{}/v1/users/ME/conversations/", self.chat)).expect("validated route");
        u.path_segments_mut().expect("HTTPS base").pop_if_empty().push(conversation).push("messages");
        u.set_query(Some("pageSize=50"));
        Ok(u.to_string())
    }
    pub fn backward_link(&self, raw: &str, conversation: &str) -> Result<String, Error> {
        let u = parse_url(raw)?;
        let expected = url::Url::parse(&self.history_url(conversation)?).expect("validated history URL");
        // Compare decoded opaque components: URL libraries encode ':' and '@' differently.
        if u.origin() != expected.origin() || decoded_path(&u) != decoded_path(&expected) {
            return Err(failure("unsafe_pagination"));
        }
        Ok(u.to_string())
    }
}
fn decoded_path(u: &url::Url) -> Vec<Vec<u8>> {
    // Decode separately so an encoded slash cannot introduce another path component.
    u.path()
        .split('/')
        .map(|part| {
            let bytes = part.as_bytes();
            let mut out = Vec::new();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'%'
                    && i + 2 < bytes.len()
                    && let (Some(a), Some(b)) =
                        ((bytes[i + 1] as char).to_digit(16), (bytes[i + 2] as char).to_digit(16))
                {
                    out.push((a * 16 + b) as u8);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            out
        })
        .collect()
}
pub fn parse_snapshot(body: &Value) -> Result<Vec<Conversation>, Error> {
    object(body)?;
    let chats = body["chats"].as_array().filter(|a| a.len() <= 10000).ok_or_else(|| failure("invalid_response"))?;
    let teams = body["teams"].as_array().filter(|a| a.len() <= 1000).ok_or_else(|| failure("invalid_response"))?;
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |r: &Value, channel: bool| -> Result<(), Error> {
        object(r)?;
        let id = opaque(&r["id"])?;
        let kind = if channel {
            "channel"
        } else {
            match optional(&r["chatType"], 128)? {
                "oneOnOne" => "direct",
                "group" => "group",
                "meeting" => "meeting",
                _ => "unsupported",
            }
        };
        let title = optional(&r["title"], 4096)?;
        let display = optional(&r["displayName"], 4096)?;
        if seen.insert(id.to_owned()) {
            result.push(Conversation {
                id: id.to_owned(),
                name: if !title.is_empty() {
                    title
                } else if !display.is_empty() {
                    display
                } else {
                    id
                }
                .to_owned(),
                kind: kind.to_owned(),
            });
        }
        if result.len() > 20000 {
            return Err(failure("invalid_response"));
        }
        Ok(())
    };
    for r in chats {
        add(r, false)?;
    }
    for team in teams {
        let channels = object(team)?["channels"]
            .as_array()
            .filter(|a| a.len() <= 10000)
            .ok_or_else(|| failure("invalid_response"))?;
        for r in channels {
            add(r, true)?;
        }
    }
    Ok(result)
}
fn valid_timestamp_shape(s: &str) -> bool {
    if s.len() < 20 || s.get(10..11) != Some("T") || s.get(17..19) == Some("60") {
        return false;
    }
    let Some(mut zone) = s.get(19..) else {
        return false;
    };
    if let Some(fraction) = zone.strip_prefix('.') {
        let count = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if !(1..=7).contains(&count) {
            return false;
        }
        zone = &fraction[count..];
    }
    zone == "Z" || (zone.len() == 6 && matches!(zone.as_bytes()[0], b'+' | b'-') && zone.as_bytes()[3] == b':')
}
/// Unsupported actions stay false until live evidence and durable operation policy qualify them.
#[derive(Clone, Debug, Default)]
pub struct Capabilities {
    pub persistent_accounts: bool,
    pub send: bool,
    pub edit: bool,
    pub delete: bool,
    pub reactions: bool,
    pub live: bool,
    pub files: bool,
    pub calls: bool,
    pub push: bool,
}
pub fn parse_history(body: &Value, account: &Account, routes: &Routes, conversation: &str) -> Result<History, Error> {
    object(body)?;
    let key = account.key()?;
    opaque(&Value::String(conversation.to_owned()))?;
    let messages =
        body["messages"].as_array().filter(|a| a.len() <= 1000).ok_or_else(|| failure("invalid_response"))?;
    let mut items = Vec::new();
    for r in messages {
        object(r)?;
        let id = opaque(&r["id"])?;
        let arrived = optional(&r["originalarrivaltime"], 64)?;
        chrono::DateTime::parse_from_rfc3339(arrived).map_err(|_| failure("invalid_timestamp"))?;
        if !valid_timestamp_shape(arrived) {
            return Err(failure("invalid_timestamp"));
        }
        let props = if r["properties"].is_null() {
            Value::Object(Default::default())
        } else {
            object(&r["properties"])?.clone()
        };
        let root = if !r["parentMessageId"].is_null() { &r["parentMessageId"] } else { &props["parentMessageId"] };
        let root_id = if root.is_null() { None } else { Some(opaque(root)?.to_owned()) };
        let version = if r["version"].is_null() { None } else { Some(opaque(&r["version"])?.to_owned()) };
        let format = match optional(&r["messagetype"], 128)? {
            "Text" => "text",
            "RichText/Html" => "html",
            _ => "unsupported",
        };
        items.push(Message {
            key: serde_json::json!([key, conversation, root_id, id]).to_string(),
            id: id.to_owned(),
            conversation_id: conversation.to_owned(),
            root_id,
            version,
            author: optional(&r["from"], 2048)?.to_owned(),
            arrived_at: arrived.to_owned(),
            content: if format == "unsupported" { String::new() } else { optional(&r["content"], 65536)?.to_owned() },
            format: format.to_owned(),
        });
    }
    let meta = if body["_metadata"].is_null() {
        Value::Object(Default::default())
    } else {
        object(&body["_metadata"])?.clone()
    };
    let next = optional(&meta["backwardLink"], 16384)?;
    Ok(History {
        items,
        backward_link: if next.is_empty() { None } else { Some(routes.backward_link(next, conversation)?) },
    })
}
/// In-memory audience credentials provided by a future qualified broker. No Debug/serialization.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tokens {
    pub spaces: String,
    pub aggregator: String,
    pub chat: String,
}
impl Drop for Tokens {
    fn drop(&mut self) {
        self.spaces.zeroize();
        self.aggregator.zeroize();
        self.chat.zeroize();
    }
}
pub struct Reader {
    account: Account,
    expires_at: Option<u64>,
    client: reqwest::Client,
    tokens: Mutex<Option<Tokens>>,
    routes: Mutex<Option<Routes>>,
    discovery_version: AtomicU64,
    closed: AtomicBool,
    cancellation: tokio::sync::watch::Sender<bool>,
}
impl Reader {
    pub fn new(account: Account, tokens: Tokens) -> Result<Arc<Self>, Error> {
        Self::with_expiry(account, tokens, None)
    }
    pub fn from_browser(session: crate::teams_handoff::BrowserSession) -> Result<Arc<Self>, Error> {
        Self::with_expiry(session.account, session.tokens, Some(session.expires_at))
    }
    fn with_expiry(account: Account, tokens: Tokens, expires_at: Option<u64>) -> Result<Arc<Self>, Error> {
        account.key()?;
        for t in [&tokens.spaces, &tokens.aggregator, &tokens.chat] {
            if t.is_empty()
                || t.len() > 65536
                || !t.bytes().all(|b| b.is_ascii_alphanumeric() || b"._~+/-=".contains(&b))
            {
                return Err(failure("invalid_credentials"));
            }
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| failure("connection_failed"))?;
        let (cancellation, _) = tokio::sync::watch::channel(false);
        Ok(Arc::new(Self {
            account,
            expires_at,
            client,
            tokens: Mutex::new(Some(tokens)),
            routes: Mutex::new(None),
            discovery_version: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            cancellation,
        }))
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.cancellation.send_replace(true);
        self.tokens.lock().expect("tokens").take();
        self.routes.lock().expect("routes").take();
    }
    async fn call(&self, target: &str, audience: &str, post: bool) -> Result<Value, Error> {
        let mut cancellation = self.cancellation.subscribe();
        if self.closed.load(Ordering::Acquire) {
            return Err(failure("cancelled"));
        }
        if self.expires_at.is_some_and(|expiry| expiry <= chrono::Utc::now().timestamp_millis().max(0) as u64 + 30000) {
            return Err(failure("session_expired"));
        }
        let request = {
            let tokens = self.tokens.lock().expect("tokens");
            let tokens = tokens.as_ref().ok_or_else(|| failure("cancelled"))?;
            let token = match audience {
                "spaces" => &tokens.spaces,
                "aggregator" => &tokens.aggregator,
                "chat" => &tokens.chat,
                _ => return Err(failure("invalid_audience")),
            };
            let request = if post { self.client.post(target).body("") } else { self.client.get(target) };
            request.bearer_auth(token).header(reqwest::header::ACCEPT, "application/json")
        };
        let work = async {
            let mut response = request.send().await.map_err(|_| failure("connection_failed"))?;
            let status = response.status().as_u16();
            let retry_after =
                response.headers().get("retry-after").and_then(|s| s.to_str().ok()).and_then(|s| s.parse().ok());
            if !response.status().is_success() {
                return Err(Error {
                    code: match status {
                        401 => "audience_rejected",
                        403 => "permission_denied",
                        429 => "ratelimited",
                        _ => "http_error",
                    },
                    status,
                    retry_after: if status == 429 { retry_after } else { None },
                });
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| failure("connection_failed"))? {
                if bytes.len() + chunk.len() > 2_000_000 {
                    return Err(failure("response_too_large"));
                }
                bytes.extend_from_slice(&chunk);
            }
            if self.closed.load(Ordering::Acquire) {
                return Err(failure("cancelled"));
            }
            serde_json::from_slice(&bytes).map_err(|_| failure("invalid_response"))
        };
        tokio::select! { result=work=>result, _=cancellation.changed()=>Err(failure("cancelled")) }
    }
    pub async fn discover(&self) -> Result<(), Error> {
        let version = self.discovery_version.fetch_add(1, Ordering::AcqRel) + 1;
        let routes =
            Routes::discover(&self.call("https://teams.microsoft.com/api/authsvc/v1.0/authz", "spaces", true).await?)?;
        let mut pinned = self.routes.lock().expect("routes");
        if self.closed.load(Ordering::Acquire) {
            return Err(failure("cancelled"));
        }
        if self.discovery_version.load(Ordering::Acquire) != version {
            return Err(failure("superseded_discovery"));
        }
        *pinned = Some(routes);
        Ok(())
    }
    fn ready(&self) -> Result<Routes, Error> {
        if self.closed.load(Ordering::Acquire) {
            return Err(failure("cancelled"));
        }
        self.routes.lock().expect("routes").clone().ok_or_else(|| failure("discovery_required"))
    }
    pub async fn conversations(&self) -> Result<Vec<Conversation>, Error> {
        parse_snapshot(&self.call(&self.ready()?.snapshot_url(), "aggregator", false).await?)
    }
    pub async fn history(&self, conversation: &str, backward: Option<&str>) -> Result<History, Error> {
        let routes = self.ready()?;
        let target = match backward {
            Some(b) => routes.backward_link(b, conversation)?,
            None => routes.history_url(conversation)?,
        };
        parse_history(&self.call(&target, "chat", false).await?, &self.account, &routes, conversation)
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.close();
    }
}
/// Deliberately limited plain-text projection for the read preview.
pub fn plain_text(message: &Message) -> String {
    if message.format != "html" {
        return message.content.clone();
    }
    let mut rest = message.content.as_str();
    let mut out = String::new();
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        if rest.starts_with("<!--") {
            if let Some(end) = rest.find("-->") {
                rest = &rest[end + 3..];
                continue;
            }
            rest = "";
            break;
        }
        let Some(end) = rest.find('>') else {
            rest = "";
            break;
        };
        let tag = rest[1..end].trim().to_ascii_lowercase();
        rest = &rest[end + 1..];
        let name = tag.trim_start_matches('/').split(|c: char| !c.is_ascii_alphanumeric()).next().unwrap_or("");
        if matches!(name, "script" | "style") && !tag.starts_with('/') {
            let lower = rest.to_ascii_lowercase();
            if let Some(close) = lower.find(&format!("</{name}")) {
                rest = &rest[close..];
            } else {
                rest = "";
                break;
            }
            continue;
        }
        if name == "br" || (tag.starts_with('/') && matches!(name, "p" | "div" | "li")) {
            out.push('\n');
        }
    }
    out.push_str(rest);
    crate::content::decode_entities(&out).trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../../../docs/protocol/fixtures/teams-read.json")).unwrap()
    }
    fn account() -> Account {
        Account { tenant_id: "00000000-0000-0000-0000-000000000001".into(), account_id: "synthetic-account".into() }
    }
    fn tokens() -> Tokens {
        Tokens {
            spaces: "synthetic-spaces".into(),
            aggregator: "synthetic-aggregator".into(),
            chat: "synthetic-chat".into(),
        }
    }
    #[test]
    fn global_routes_are_role_scoped() {
        let f = fixture();
        let mut auth = f["authz"].clone();
        Routes::discover(&auth).unwrap();
        for bad in [
            "http://teams.microsoft.com/api/chatsvc/fr",
            "https://evil.test/api/chatsvc/fr",
            "https://teams.microsoft.com.evil.test/api/chatsvc/fr",
            "https://user@teams.microsoft.com/api/chatsvc/fr",
            "https://teams.microsoft.com/api/csa/fr",
            "https://teams.microsoft.com/api/chatsvc/fr?x=1",
            "https://teams.microsoft.com/api/chatsvc/fr#x",
            "https://teams.microsoft.com:444/api/chatsvc/fr",
            "https://teams.microsoft.com/api/chatsvc/fr/other",
        ] {
            auth["regionGtms"]["chatServiceAfd"] = bad.into();
            assert!(Routes::discover(&auth).is_err(), "{bad}");
        }
    }
    #[test]
    fn paging_and_opaque_context_cannot_change_service() {
        let f = fixture();
        let routes = Routes::discover(&f["authz"]).unwrap();
        let conv = f["conversation"].as_str().unwrap();
        let next = f["history"]["_metadata"]["backwardLink"].as_str().unwrap();
        assert_eq!(routes.backward_link(next, conv).unwrap(), next);
        let url = routes.history_url(conv).unwrap();
        assert!(url.contains("chat%2Fopaque"));
        for bad in [
            next.replace("teams.microsoft.com", "evil.test"),
            next.replace("19%3Achat%2Fopaque%40test", "other"),
            next.replace("/chatsvc/", "/csa/"),
            next.replace("/messages?", "/properties?"),
        ] {
            assert!(routes.backward_link(&bad, conv).is_err());
        }
        assert!(routes.history_url("..").is_err());
    }
    #[test]
    fn shared_fixture_preserves_ids_revisions_and_unknown_types() {
        let f = fixture();
        let routes = Routes::discover(&f["authz"]).unwrap();
        let conv = f["conversation"].as_str().unwrap();
        let page = parse_history(&f["history"], &account(), &routes, conv).unwrap();
        let m = &page.items[0];
        assert_eq!(m.id, "9007199254740993");
        assert_eq!(m.version.as_deref(), Some("9007199254740995"));
        assert_eq!(m.root_id.as_deref(), Some("9007199254740992"));
        assert_eq!(m.format, "html");
        assert_eq!(page.items[1].format, "unsupported");
        assert!(page.items[1].content.is_empty());
        let snapshot = parse_snapshot(&f["snapshot"]).unwrap();
        assert_eq!(snapshot.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(), ["direct", "unsupported", "channel"]);
        let mut history = f["history"].clone();
        history["messages"][0]["id"] = serde_json::json!(9007199254740992u64);
        assert!(parse_history(&history, &account(), &routes, conv).is_err());
        history = f["history"].clone();
        history["messages"][0]["originalarrivaltime"] = "2026-02-31T00:00:00Z".into();
        assert!(parse_history(&history, &account(), &routes, conv).is_err());
    }
    #[test]
    fn identity_partitions_tenants_and_contexts() {
        let a = account();
        let mut b = account();
        b.tenant_id = "00000000-0000-0000-0000-000000000002".into();
        assert_ne!(a.key().unwrap(), b.key().unwrap());
        let f = fixture();
        let routes = Routes::discover(&f["authz"]).unwrap();
        let mut h = f["history"].clone();
        h["_metadata"] = serde_json::json!({});
        assert_ne!(
            parse_history(&h, &a, &routes, "first").unwrap().items[0].key,
            parse_history(&h, &a, &routes, "second").unwrap().items[0].key
        );
    }
    #[tokio::test]
    async fn closed_reader_drops_tokens_and_rejects_reads() {
        let reader = Reader::new(account(), tokens()).unwrap();
        assert_eq!(reader.conversations().await.unwrap_err().code, "discovery_required");
        reader.close();
        assert!(reader.tokens.lock().unwrap().is_none());
        assert_eq!(reader.discover().await.unwrap_err().code, "cancelled");
    }

    async fn response(status: u16, body: &str, extra: &str) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = format!("http://{}/read", listener.local_addr().unwrap());
        let output = format!(
            "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
            body.len()
        );
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0; 2048];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                buf.extend_from_slice(&chunk[..n]);
            }
            socket.write_all(output.as_bytes()).await.unwrap();
            String::from_utf8(buf).unwrap()
        });
        (target, task)
    }
    #[tokio::test]
    async fn transport_selects_audience_and_sanitizes_errors() {
        let reader = Reader::new(account(), tokens()).unwrap();
        for audience in ["spaces", "aggregator", "chat"] {
            let (target, task) = response(200, "{}", "").await;
            reader.call(&target, audience, false).await.unwrap();
            let request = task.await.unwrap().to_ascii_lowercase();
            assert!(request.contains(&format!("authorization: bearer synthetic-{audience}")));
            assert!(!request.contains("cookie:"));
        }
        for (status, code) in
            [(401, "audience_rejected"), (403, "permission_denied"), (429, "ratelimited"), (500, "http_error")]
        {
            let (target, task) = response(status, "private secret", "Retry-After: 27\r\n").await;
            let error = reader.call(&target, "chat", false).await.unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(error.status, status);
            assert!(!error.to_string().contains("secret"));
            assert_eq!(error.retry_after, if status == 429 { Some(27) } else { None });
            task.await.unwrap();
            assert!(reader.tokens.lock().unwrap().is_some());
        }
    }
    #[tokio::test]
    async fn transport_does_not_follow_redirects() {
        let (target, task) = response(302, "", "Location: https://evil.test/\r\n").await;
        let reader = Reader::new(account(), tokens()).unwrap();
        assert_eq!(reader.call(&target, "chat", false).await.unwrap_err().status, 302);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn closing_cancels_pending_network_work() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = format!("http://{}/read", listener.local_addr().unwrap());
        let reader = Reader::new(account(), tokens()).unwrap();
        let active = reader.clone();
        let pending = tokio::spawn(async move { active.call(&target, "chat", false).await });
        let (socket, _) = listener.accept().await.unwrap();
        reader.close();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), pending).await.unwrap().unwrap().unwrap_err().code,
            "cancelled"
        );
        drop(socket);
    }

    #[test]
    fn limited_html_projection_never_exposes_script_bodies() {
        let f = fixture();
        let routes = Routes::discover(&f["authz"]).unwrap();
        let mut m = parse_history(&f["history"], &account(), &routes, f["conversation"].as_str().unwrap())
            .unwrap()
            .items
            .remove(0);
        m.content = "<p>Hello &amp; &lt;world&gt;</p><script>secret()</script><p>Next<br>line</p>".into();
        assert_eq!(plain_text(&m), "Hello & <world>\nNext\nline");
        m.content = "Safe<script>hidden".into();
        assert_eq!(plain_text(&m), "Safe");
    }
    #[tokio::test]
    async fn imported_expired_tokens_fail_before_discovery() {
        let session = crate::teams_handoff::BrowserSession { account: account(), tokens: tokens(), expires_at: 1 };
        let reader = Reader::from_browser(session).unwrap();
        assert_eq!(reader.discover().await.unwrap_err().code, "session_expired");
    }
}
