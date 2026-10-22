//! A Teams account: signed in with a Microsoft device code as the Teams
//! desktop app's public client, kept by its refresh token, which Microsoft
//! rotates on every refresh. Access and Skype tokens live in memory only.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::rest::RestError;
use crate::session::SessionInfo;

/// The Teams desktop and mobile app: a public client, so a device code completes
/// (the web client `5e3ce6c0-…` is confidential and answers `AADSTS7000218`).
pub const CLIENT_ID: &str = "1fec8e78-bce4-4aaf-ab1b-5451cc387264";
pub const LOGIN: &str = "https://login.microsoftonline.com";
pub const SPACES: &str = "https://api.spaces.skype.com";
pub const AGGREGATOR: &str = "https://chatsvcagg.teams.microsoft.com";
pub const AUTHZ: &str = "https://teams.microsoft.com/api/authsvc/v1.0/authz";
/// The presence 401 named `login.microsoftonline.com`, so the Unified Presence
/// Service wants an AAD bearer for its own scope, not the skypetoken.
const PRESENCE_SCOPE: &str = "https://presence.teams.microsoft.com";
/// Message search runs on the Substrate query API with a bearer for its scope.
const SUBSTRATE: &str = "https://substrate.office.com";
/// The `base_url` of every Teams account: the conversations live behind routes
/// discovered per tenant, not at one address.
pub const ORIGIN: &str = "https://teams.microsoft.com";
pub const SESSION_REJECTED: &str = "teams-session-rejected";
const MARGIN: Duration = Duration::from_secs(300);

/// What a Teams account keeps beside its id, in the same secret record.
#[derive(Clone, PartialEq, Eq)]
pub struct TeamsAccount {
    pub tenant_id: String,
    pub refresh: Zeroizing<String>,
}

impl std::fmt::Debug for TeamsAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TeamsAccount").field("tenant_id", &self.tenant_id).field("refresh", &"[redacted]").finish()
    }
}

pub(crate) fn refusal(code: &str, status: u16) -> RestError {
    RestError {
        status,
        error: Some(code.to_owned()),
        error_type: (status == 401).then(|| SESSION_REJECTED.to_owned()),
        ..RestError::incomplete(&format!("Teams: {code}"))
    }
}

fn http() -> reqwest::Client {
    crate::tls::ensure_provider();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .expect("Teams HTTP client")
}

async fn form(url: &str, fields: &[(&str, &str)]) -> Result<Value, RestError> {
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(fields).finish();
    let response = http()
        .post(url)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| RestError::network(e.to_string()))?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.map_err(|e| RestError::network(e.to_string()))?;
    if status >= 500 {
        return Err(RestError { status, ..RestError::network(format!("Microsoft sign-in answered {status}")) });
    }
    Ok(body)
}

fn guid(s: &str) -> bool {
    s.len() == 36
        && s.bytes()
            .enumerate()
            .all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}

/// The claims of an id token Microsoft just handed us over TLS: read, not verified.
fn claims(id_token: &str) -> Option<Value> {
    use base64::Engine;
    let payload = id_token.split('.').nth(1)?;
    serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
}

/// A device code to show: the user approves it at `verification_uri`.
pub struct DeviceCode {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    interval: u64,
    device_code: Zeroizing<String>,
}

impl std::fmt::Debug for DeviceCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceCode").field("user_code", &self.user_code).finish_non_exhaustive()
    }
}

pub async fn device_code() -> Result<DeviceCode, RestError> {
    let scope = format!("{SPACES}/.default openid profile offline_access");
    let body =
        form(&format!("{LOGIN}/organizations/oauth2/v2.0/devicecode"), &[("client_id", CLIENT_ID), ("scope", &scope)])
            .await?;
    let field = |key: &str| body[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    let verification_uri =
        field("verification_uri").filter(|u| u.starts_with("https://")).ok_or_else(|| refusal("device_code", 200))?;
    Ok(DeviceCode {
        user_code: field("user_code").ok_or_else(|| refusal("device_code", 200))?,
        device_code: Zeroizing::new(field("device_code").ok_or_else(|| refusal("device_code", 200))?),
        verification_uri,
        expires_in: body["expires_in"].as_u64().unwrap_or(900),
        interval: body["interval"].as_u64().unwrap_or(5).clamp(1, 60),
    })
}

/// Waits until the code is approved, refused or expired; `cancelled` ends it early.
pub async fn approved(code: &DeviceCode, cancelled: impl Fn() -> bool) -> Result<SessionInfo, RestError> {
    let deadline = Instant::now() + Duration::from_secs(code.expires_in);
    let mut interval = code.interval;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if cancelled() {
            return Err(refusal("cancelled", 0));
        }
        let body = form(
            &format!("{LOGIN}/organizations/oauth2/v2.0/token"),
            &[
                ("client_id", CLIENT_ID),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", &code.device_code),
            ],
        )
        .await?;
        match body["error"].as_str() {
            Some("authorization_pending") => continue,
            Some("slow_down") => interval += 5,
            Some("authorization_declined") => return Err(refusal("declined", 0)),
            Some("expired_token") => return Err(refusal("expired", 0)),
            Some(other) => return Err(refusal(other, 0)),
            None => return signed_in(&body).await,
        }
    }
    Err(refusal("expired", 0))
}

async fn signed_in(body: &Value) -> Result<SessionInfo, RestError> {
    let refresh = Zeroizing::new(body["refresh_token"].as_str().unwrap_or_default().to_owned());
    let claims = body["id_token"].as_str().and_then(claims).ok_or_else(|| refusal("id_token", 200))?;
    let text = |key: &str| claims[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    let (tenant_id, object_id) = (text("tid").unwrap_or_default(), text("oid").unwrap_or_default());
    if refresh.is_empty() || !guid(&tenant_id) || !guid(&object_id) {
        return Err(refusal("id_token", 200));
    }
    let info = SessionInfo {
        base_url: ORIGIN.to_owned(),
        user_id: format!("8:orgid:{object_id}"),
        username: text("name").or_else(|| text("preferred_username")).unwrap_or_else(|| object_id.clone()),
        auth_token: String::new(),
        native: None,
        mattermost: None,
        slack: None,
        teams: Some(TeamsAccount { tenant_id, refresh }),
    };
    Tokens::new(&info)?.chat().await?;
    Ok(info)
}

pub(crate) fn write_secret(account: &TeamsAccount, secret: &mut Value) {
    secret["teamsTenantId"] = json!(account.tenant_id);
    secret["teamsRefresh"] = json!(account.refresh.as_str());
}

/// A saved Teams account, refused unless every field is one Microsoft could have given.
pub(crate) fn from_secret(value: &Value) -> Option<SessionInfo> {
    let field = |key: &str| value[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    let user_id = field("userId")?;
    let tenant_id = field("teamsTenantId")?;
    if field("baseUrl")? != ORIGIN || !guid(&tenant_id) || !user_id.strip_prefix("8:orgid:").is_some_and(guid) {
        return None;
    }
    Some(SessionInfo {
        base_url: ORIGIN.to_owned(),
        username: field("username").unwrap_or_else(|| user_id.clone()),
        user_id,
        auth_token: String::new(),
        native: None,
        mattermost: None,
        slack: None,
        teams: Some(TeamsAccount { tenant_id, refresh: Zeroizing::new(field("teamsRefresh")?) }),
    })
}

type Sink = Box<dyn Fn(&SessionInfo) + Send + Sync>;
static SINK: OnceLock<Sink> = OnceLock::new();

/// Where a rotated refresh token is saved: the app's keychain, set once at start.
pub fn set_credential_sink(sink: impl Fn(&SessionInfo) + Send + Sync + 'static) {
    let _ = SINK.set(Box::new(sink));
}

/// The routes authz hands a tenant; only `https` Teams and Trouter hosts are kept.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Routes {
    pub chat: String,
    pub aggregator: String,
    pub trouter: String,
    pub registrar: String,
    pub ams: String,
    pub middle_tier: String,
    pub presence: String,
    pub search: String,
}

/// Status and raw body of a probe response, or the transport error.
async fn describe(r: Result<reqwest::Response, reqwest::Error>) -> Value {
    match r {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let header = |name: &str| resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
            // The failing calls answered empty or non-JSON; these headers name the
            // auth a 401 wants (WWW-Authenticate) and Teams' own error detail.
            let www_authenticate = header("www-authenticate");
            let content_type = header("content-type");
            let diagnostics = header("x-ms-diagnostics");
            let text = resp.text().await.unwrap_or_default();
            let body = match serde_json::from_str::<Value>(&text) {
                Ok(json) => json,
                Err(_) if text.is_empty() => Value::Null,
                Err(_) => Value::String(text.chars().take(2000).collect()),
            };
            json!({
                "status": status,
                "body": body,
                "www_authenticate": www_authenticate,
                "content_type": content_type,
                "x_ms_diagnostics": diagnostics,
            })
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// A conversation GET described WITHOUT its message content: status, headers,
/// the `threadProperties` key names, and the topic and member count only.
async fn describe_conversation(r: Result<reqwest::Response, reqwest::Error>) -> Value {
    match r {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let header = |name: &str| resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
            let www_authenticate = header("www-authenticate");
            let content_type = header("content-type");
            let diagnostics = header("x-ms-diagnostics");
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            let props = body.get("threadProperties");
            let keys: Vec<String> =
                props.and_then(Value::as_object).map(|o| o.keys().cloned().collect()).unwrap_or_default();
            json!({
                "status": status,
                "www_authenticate": www_authenticate,
                "content_type": content_type,
                "x_ms_diagnostics": diagnostics,
                "type": body.get("type"),
                "thread_property_keys": keys,
                "topic": props.and_then(|p| p.get("topic")),
                "membercount": props.and_then(|p| p.get("membercount")),
            })
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// A file download described by TRANSPORT only: status, content-type,
/// content-length and the auth-challenge header, plus whether any body bytes
/// came back. Never the url or the bytes themselves.
async fn describe_download(r: Result<reqwest::Response, reqwest::Error>) -> Value {
    match r {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let header = |name: &str| resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
            let www_authenticate = header("www-authenticate");
            let content_type = header("content-type");
            let content_length = header("content-length");
            let bytes = resp.bytes().await.map(|b| b.len()).unwrap_or(0);
            json!({
                "status": status,
                "www_authenticate": www_authenticate,
                "content_type": content_type,
                "content_length": content_length,
                "body_bytes_nonzero": bytes > 0,
            })
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// A members body described WITHOUT identities: the member count and the
/// member-row key names and top-level keys, plus any error envelope.
fn member_report(status: u16, www_authenticate: Option<String>, body: &Value) -> Value {
    let members = body.as_array().or_else(|| body.get("members").and_then(Value::as_array));
    let member_keys: Vec<String> = members
        .and_then(|a| a.first())
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let top_level_keys: Vec<String> = body.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    json!({
        "status": status,
        "www_authenticate": www_authenticate,
        "member_count": members.map(|a| a.len()),
        "member_keys": member_keys,
        "top_level_keys": top_level_keys,
        "error_code": body.get("errorCode"),
        "message": body.get("message"),
    })
}

/// A Substrate search result described by STRUCTURE only: status, the result
/// total and count, and the field names of the first result and its Source.
/// No message content, so a matching term can be used to learn the hit shape.
async fn describe_search_hits(r: Result<reqwest::Response, reqwest::Error>) -> Value {
    let keys = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_object).map(|o| o.keys().cloned().collect()).unwrap_or_default()
    };
    match r {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            let result_set = body
                .get("EntitySets")
                .and_then(Value::as_array)
                .and_then(|s| s.first())
                .and_then(|e| e.get("ResultSets"))
                .and_then(Value::as_array)
                .and_then(|r| r.first());
            let results = result_set.and_then(|rs| rs.get("Results")).and_then(Value::as_array);
            let first = results.and_then(|r| r.first());
            let source = first.and_then(|f| f.get("Source"));
            let kind = |v: Option<&Value>| -> &'static str {
                match v {
                    Some(Value::String(s)) if s.starts_with("19:") => "string(19:)",
                    Some(Value::String(_)) => "string",
                    Some(Value::Object(_)) => "object",
                    Some(Value::Array(_)) => "array",
                    Some(Value::Number(_)) => "number",
                    Some(Value::Bool(_)) => "bool",
                    Some(Value::Null) | None => "absent",
                }
            };
            let field = |name: &str| kind(source.and_then(|s| s.get(name)));
            json!({
                "status": status,
                "total": result_set.and_then(|rs| rs.get("Total")),
                "result_count": results.map(|r| r.len()),
                "result_keys": keys(first),
                "source_keys": keys(source),
                "source_types": {
                    "ClientThreadId": field("ClientThreadId"),
                    "ClientConversationId": field("ClientConversationId"),
                    "ConversationId": field("ConversationId"),
                    "From": field("From"),
                    "Sender": field("Sender"),
                    "Preview": field("Preview"),
                    "Subject": field("Subject"),
                    "DateTimeSent": field("DateTimeSent"),
                },
                "from_keys": keys(source.and_then(|s| s.get("From"))),
                "from_email_keys": keys(source.and_then(|s| s.get("From")).and_then(|f| f.get("EmailAddress"))),
            })
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// The first message in a page that carries a file, by shape only: its
/// messagetype, properties key names, whether `files` is a JSON string, the
/// file-entry key names and whether the content holds a `<URIObject>`. No
/// filenames, urls or message text. The second tuple field is the download
/// candidate url (the `<a href>` or the `uri` attribute), kept out of the
/// reported value so the probe can test its auth without exposing it.
fn file_message_shape(body: &Value) -> Option<(Value, Option<String>)> {
    let files_value = |props: Option<&Value>| -> Option<Value> {
        props.and_then(|p| p.get("files")).map(|f| match f {
            Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
            other => other.clone(),
        })
    };
    for m in body.get("messages").and_then(Value::as_array)? {
        let kind = m.get("messagetype").and_then(Value::as_str).unwrap_or("");
        // A call recording is a meeting artifact on AMS with its own auth, not a
        // shared file: skip it so the scan finds an ordinary attachment instead.
        if kind.contains("CallRecording") {
            continue;
        }
        let props = m.get("properties");
        let files = files_value(props);
        let entries = files.as_ref().and_then(Value::as_array);
        let has_files = entries.is_some_and(|a| !a.is_empty());
        let content = m.get("content").and_then(Value::as_str).unwrap_or("");
        let content_uriobject = content.contains("<URIObject");
        if kind.contains("File") || kind.contains("Media") || has_files || content_uriobject {
            let prop_keys: Vec<String> =
                props.and_then(Value::as_object).map(|o| o.keys().cloned().collect()).unwrap_or_default();
            let file_keys: Vec<String> = entries
                .and_then(|a| a.first())
                .and_then(Value::as_object)
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            // URIObject structure: the opening tag's attribute names and the
            // child element names, so the parser is known without the values.
            let (attrs, children) = uriobject_structure(content);
            let report = json!({
                "messagetype": kind,
                "properties_keys": prop_keys,
                "files_is_string": props.and_then(|p| p.get("files")).is_some_and(Value::is_string),
                "file_count": entries.map(|a| a.len()),
                "file_keys": file_keys,
                "content_has_uriobject": content_uriobject,
                "uriobject_attrs": attrs,
                "uriobject_children": children,
            });
            return Some((report, uriobject_download_url(content)));
        }
    }
    None
}

/// The download url inside a `<URIObject>`: the first `<a href="…">` (the file
/// link), else the object's own `uri="…"` attribute. Used only to probe the
/// download auth; never put into reported output.
fn uriobject_download_url(content: &str) -> Option<String> {
    let start = content.find("<URIObject")?;
    let rest = &content[start..];
    let body_end = rest.find("</URIObject>").unwrap_or(rest.len());
    let object = &rest[..body_end];
    let attr = |src: &str, name: &str| -> Option<String> {
        let at = src.find(&format!("{name}=\""))?;
        let after = &src[at + name.len() + 2..];
        let end = after.find('"')?;
        Some(after[..end].to_owned())
    };
    attr(object, "href").or_else(|| attr(&object[..object.find('>').unwrap_or(object.len())], "uri"))
}

/// The `<URIObject>`'s opening-tag attribute names and its child element names,
/// NO attribute or element values (those hold the file name and url).
fn uriobject_structure(content: &str) -> (Vec<String>, Vec<String>) {
    let Some(start) = content.find("<URIObject") else { return (Vec::new(), Vec::new()) };
    let rest = &content[start + "<URIObject".len()..];
    let open_end = rest.find('>').unwrap_or(rest.len());
    let attrs: Vec<String> = rest[..open_end]
        .split_whitespace()
        .filter_map(|tok| tok.split('=').next())
        .filter(|name| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .map(str::to_owned)
        .collect();
    let body_end = rest.find("</URIObject>").unwrap_or(rest.len());
    let mut children = Vec::new();
    let mut scan = &rest[open_end.min(body_end)..body_end];
    while let Some(lt) = scan.find('<') {
        scan = &scan[lt + 1..];
        if scan.starts_with('/') {
            continue;
        }
        let name: String = scan.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        if !name.is_empty() && !children.contains(&name) {
            children.push(name);
        }
    }
    (attrs, children)
}

fn host_ends(raw: &str, suffixes: &[&str]) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    let host = url.host_str()?.to_owned();
    let ok = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && suffixes.iter().any(|s| host == s[1..] || host.ends_with(s));
    ok.then(|| raw.trim_end_matches('/').to_owned())
}

impl Routes {
    pub fn discover(body: &Value) -> Option<Self> {
        let gtms = &body["regionGtms"];
        let teams = [".teams.microsoft.com", ".teams.cloud.microsoft"];
        let get = |key: &str, hosts: &[&str]| gtms[key].as_str().and_then(|raw| host_ends(raw, hosts));
        Some(Routes {
            chat: get("chatServiceAfd", &teams)?,
            aggregator: get("chatSvcAggAfd", &teams)?,
            trouter: get("calling_trouterUrl", &[".trouter.teams.microsoft.com"]).unwrap_or_default(),
            registrar: get("calling_registrarUrl", &teams).unwrap_or_default(),
            ams: get("ams", &[".asyncgw.teams.microsoft.com", ".teams.microsoft.com"]).unwrap_or_default(),
            middle_tier: get("middleTier", &teams).unwrap_or_default(),
            presence: get("unifiedPresence", &teams).unwrap_or_default(),
            search: get("search", &[".asyncgw.teams.microsoft.com", ".teams.microsoft.com"]).unwrap_or_default(),
        })
    }
}

struct Lease {
    value: Zeroizing<String>,
    until: Instant,
}

impl Lease {
    fn fresh(&self) -> Option<Zeroizing<String>> {
        (Instant::now() + MARGIN < self.until).then(|| self.value.clone())
    }
}

#[derive(Default)]
struct Held {
    aggregator: Option<Lease>,
    presence: Option<Lease>,
    substrate: Option<Lease>,
    skype: Option<Lease>,
    routes: Option<Routes>,
}

/// An account's live tokens: refreshed from the refresh token when they near
/// their end, the rotated refresh token saved through the sink.
pub struct Tokens {
    info: Mutex<SessionInfo>,
    held: tokio::sync::Mutex<Held>,
}

impl Tokens {
    pub fn new(info: &SessionInfo) -> Result<Arc<Self>, RestError> {
        info.teams.as_ref().ok_or_else(|| refusal("not_teams", 0))?;
        Ok(Arc::new(Tokens { info: Mutex::new(info.clone()), held: tokio::sync::Mutex::default() }))
    }

    /// Tokens already held, for a test server: they never refresh.
    pub fn preset(info: &SessionInfo, routes: Routes, skype: &str, aggregator: &str) -> Result<Arc<Self>, RestError> {
        let tokens = Self::new(info)?;
        let lease = |value: &str| Lease {
            value: Zeroizing::new(value.to_owned()),
            until: Instant::now() + Duration::from_secs(1 << 30),
        };
        let held = Held {
            aggregator: Some(lease(aggregator)),
            presence: None,
            substrate: None,
            skype: Some(lease(skype)),
            routes: Some(routes),
        };
        *tokens.held.try_lock().expect("a fresh account") = held;
        Ok(tokens)
    }

    pub fn info(&self) -> SessionInfo {
        self.info.lock().unwrap().clone()
    }

    async fn access(&self, audience: &str) -> Result<Lease, RestError> {
        let (tenant, refresh) = {
            let info = self.info.lock().unwrap();
            let account = info.teams.as_ref().expect("Teams account");
            (account.tenant_id.clone(), account.refresh.clone())
        };
        let scope = format!("{audience}/.default openid profile offline_access");
        let body = form(
            &format!("{LOGIN}/{tenant}/oauth2/v2.0/token"),
            &[
                ("client_id", CLIENT_ID),
                ("grant_type", "refresh_token"),
                ("refresh_token", &refresh),
                ("scope", &scope),
            ],
        )
        .await?;
        if let Some(error) = body["error"].as_str() {
            let status =
                if matches!(error, "invalid_grant" | "interaction_required" | "invalid_client") { 401 } else { 400 };
            return Err(refusal(error, status));
        }
        let token =
            body["access_token"].as_str().filter(|t| !t.is_empty()).ok_or_else(|| refusal("access_token", 200))?;
        if let Some(rotated) = body["refresh_token"].as_str().filter(|t| !t.is_empty() && **t != **refresh) {
            let saved = {
                let mut info = self.info.lock().unwrap();
                info.teams.as_mut().expect("Teams account").refresh = Zeroizing::new(rotated.to_owned());
                info.clone()
            };
            if let Some(sink) = SINK.get() {
                sink(&saved);
            }
        }
        let seconds = body["expires_in"].as_u64().unwrap_or(3600);
        Ok(Lease { value: Zeroizing::new(token.to_owned()), until: Instant::now() + Duration::from_secs(seconds) })
    }

    /// The aggregator's bearer.
    pub async fn aggregator(&self) -> Result<Zeroizing<String>, RestError> {
        let mut held = self.held.lock().await;
        if let Some(token) = held.aggregator.as_ref().and_then(Lease::fresh) {
            return Ok(token);
        }
        let lease = self.access(AGGREGATOR).await?;
        let token = lease.value.clone();
        held.aggregator = Some(lease);
        Ok(token)
    }

    /// The Spaces bearer, for the middle tier's profiles.
    pub async fn spaces(&self) -> Result<Zeroizing<String>, RestError> {
        Ok(self.access(SPACES).await?.value)
    }

    /// The presence bearer: the Unified Presence Service refuses the skypetoken
    /// and wants an AAD token for its own scope (probed live 2026-10-22).
    pub async fn presence(&self) -> Result<Zeroizing<String>, RestError> {
        let mut held = self.held.lock().await;
        if let Some(token) = held.presence.as_ref().and_then(Lease::fresh) {
            return Ok(token);
        }
        let lease = self.access(PRESENCE_SCOPE).await?;
        let token = lease.value.clone();
        held.presence = Some(lease);
        Ok(token)
    }

    /// The Substrate bearer, for message search.
    pub async fn substrate(&self) -> Result<Zeroizing<String>, RestError> {
        let mut held = self.held.lock().await;
        if let Some(token) = held.substrate.as_ref().and_then(Lease::fresh) {
            return Ok(token);
        }
        let lease = self.access(SUBSTRATE).await?;
        let token = lease.value.clone();
        held.substrate = Some(lease);
        Ok(token)
    }

    /// The Skype token and the tenant's routes, from authz.
    pub async fn chat(&self) -> Result<(Zeroizing<String>, Routes), RestError> {
        let mut held = self.held.lock().await;
        if let (Some(token), Some(routes)) = (held.skype.as_ref().and_then(Lease::fresh), held.routes.clone()) {
            return Ok((token, routes));
        }
        let spaces = self.access(SPACES).await?;
        let response = http()
            .post(AUTHZ)
            .bearer_auth(spaces.value.as_str())
            .header("content-length", "0")
            .send()
            .await
            .map_err(|e| RestError::network(e.to_string()))?;
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or_default();
        if status == 401 || status == 403 {
            return Err(refusal("authz", 401));
        }
        let skype = body.pointer("/tokens/skypeToken").and_then(Value::as_str).filter(|t| !t.is_empty());
        let (Some(skype), Some(routes)) = (skype, Routes::discover(&body)) else {
            return Err(refusal("authz", status.max(200)));
        };
        let seconds = body.pointer("/tokens/expiresIn").and_then(Value::as_u64).unwrap_or(3600);
        let lease =
            Lease { value: Zeroizing::new(skype.to_owned()), until: Instant::now() + Duration::from_secs(seconds) };
        let token = lease.value.clone();
        held.skype = Some(lease);
        held.routes = Some(routes.clone());
        Ok((token, routes))
    }

    /// Read-only: the authz `regionGtms` service map (service URLs only, no
    /// tokens). For host discovery when extending the provider.
    pub async fn region_gtms(&self) -> Result<Value, RestError> {
        let spaces = self.access(SPACES).await?;
        let response = http()
            .post(AUTHZ)
            .bearer_auth(spaces.value.as_str())
            .header("content-length", "0")
            .send()
            .await
            .map_err(|e| RestError::network(e.to_string()))?;
        let body: Value = response.json().await.unwrap_or_default();
        Ok(body.get("regionGtms").cloned().unwrap_or(Value::Null))
    }

    /// Read-only shape probe for presence, profiles and search. Returns each
    /// endpoint's URL, status and raw body (own data only; search uses an
    /// unlikely term), so request/response shapes can be confirmed before use.
    pub async fn probe_shapes(&self, me: &str) -> Value {
        let (skype, routes) = match self.chat().await {
            Ok(v) => v,
            Err(e) => return json!({ "error": format!("chat token: {e:?}") }),
        };
        let bearer = self.aggregator().await.map(|b| b.as_str().to_owned()).unwrap_or_default();
        let mut out = serde_json::Map::new();

        if !routes.presence.is_empty() {
            let url = format!("{}/v1/presence/getpresence/", routes.presence);
            out.insert("presence_url".into(), json!(url));
            let r = http()
                .post(&url)
                .header("authentication", format!("skypetoken={}", skype.as_str()))
                .json(&json!([{ "mri": me }]))
                .send()
                .await;
            out.insert("presence".into(), describe(r).await);
            // Variant: the 401 wants an AAD bearer, not the skypetoken. Try a
            // token for the presence scope from the refresh token.
            match self.access(PRESENCE_SCOPE).await {
                Ok(lease) => {
                    let r =
                        http().post(&url).bearer_auth(lease.value.as_str()).json(&json!([{ "mri": me }])).send().await;
                    out.insert("presence_bearer".into(), describe(r).await);
                }
                Err(e) => {
                    out.insert("presence_bearer".into(), json!({ "token_error": format!("{e:?}") }));
                }
            }
        }
        if !routes.middle_tier.is_empty() && !bearer.is_empty() {
            let url = format!(
                "{}/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&canBeSmtpAddress=false&skypeTeamsInfo=true",
                routes.middle_tier
            );
            out.insert("profile_url".into(), json!(url));
            let r = http().post(&url).bearer_auth(&bearer).json(&json!([me])).send().await;
            out.insert("profile".into(), describe(r).await);
            // Variant: the 204 accepted the call but matched no one. `me` is an
            // `8:orgid:<oid>` MRI; try the raw oid in case the middle tier keys
            // on the bare object id instead.
            let oid = me.strip_prefix("8:orgid:").unwrap_or(me);
            if oid != me {
                let r = http().post(&url).bearer_auth(&bearer).json(&json!([oid])).send().await;
                out.insert("profile_oid".into(), describe(r).await);
            }
            // Variant: the aggregator bearer above matched no one; the real code
            // uses the Spaces bearer (the Teams web client's /api/mt token).
            if let Ok(spaces) = self.spaces().await {
                let r = http().post(&url).bearer_auth(spaces.as_str()).json(&json!([me])).send().await;
                out.insert("profile_spaces".into(), describe(r).await);
            }
        }
        if !routes.search.is_empty() {
            let url = format!("{}/v2/search", routes.search);
            out.insert("search_url".into(), json!(url));
            let r = http()
                .post(&url)
                .header("authentication", format!("skypetoken={}", skype.as_str()))
                .json(&json!({ "query": "rvprobe-zzqx-unlikely", "resultType": "messages", "top": 5 }))
                .send()
                .await;
            out.insert("search".into(), describe(r).await);
        }
        // Variant: the asyncgw /msgsearch path 404s. Try the Substrate search
        // API with its own host and audience. The 400 on the first body wanted
        // the Teams content source, a correlation id and a scenario.
        if let Ok(lease) = self.access(SUBSTRATE).await {
            let url = "https://substrate.office.com/search/api/v2/query";
            let mut cvid = [0u8; 16];
            getrandom::fill(&mut cvid).ok();
            let cvid: String = cvid.iter().map(|b| format!("{b:02x}")).collect();
            let body = json!({
                "Cvid": cvid,
                "Scenario": { "Name": "teamsmessages" },
                "EntityRequests": [{
                    "EntityType": "Message",
                    "ContentSources": ["Teams"],
                    "Query": { "QueryString": "rvprobe-zzqx-unlikely" },
                    "Size": 5,
                }],
            });
            let r = http().post(url).bearer_auth(lease.value.as_str()).json(&body).send().await;
            out.insert("search_substrate".into(), describe(r).await);
            // A matching term, to learn the hit shape. Reports only field names
            // and counts of the results, never the message content.
            let mut cvid = [0u8; 16];
            getrandom::fill(&mut cvid).ok();
            let cvid: String = cvid.iter().map(|b| format!("{b:02x}")).collect();
            let hit = json!({
                "Cvid": cvid,
                "Scenario": { "Name": "teamsmessages" },
                "EntityRequests": [{
                    "EntityType": "Message",
                    "ContentSources": ["Teams"],
                    "Query": { "QueryString": "http" },
                    "Size": 3,
                }],
            });
            let r = http().post(url).bearer_auth(lease.value.as_str()).json(&hit).send().await;
            out.insert("search_hit_shape".into(), describe_search_hits(r).await);
        }
        // Room-info shape: list the user's conversations (chat skypetoken, as
        // history does), take the first id and GET that conversation. Only its
        // status, headers, threadProperties keys, topic and membercount are
        // reported, never message content.
        if !routes.chat.is_empty() {
            let list =
                format!("{}/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=30&startTime=1", routes.chat);
            let ids: Vec<String> =
                match http().get(&list).header("authentication", format!("skypetoken={}", skype.as_str())).send().await
                {
                    Ok(resp) if resp.status().is_success() => resp
                        .json::<Value>()
                        .await
                        .ok()
                        .and_then(|b| b.get("conversations").and_then(Value::as_array).cloned())
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_owned))
                        .collect(),
                    _ => Vec::new(),
                };
            let thread_url = |id: &str, tail: Option<&str>| -> Option<url::Url> {
                let mut url = url::Url::parse(&format!("{}/v1/threads", routes.chat)).ok()?;
                {
                    let mut seg = url.path_segments_mut().ok()?;
                    seg.push(id);
                    if let Some(tail) = tail {
                        seg.push(tail);
                    }
                }
                url.set_query(Some("view=msnp24Equivalent&threadProperties=1"));
                Some(url)
            };
            if let Some(id) = ids.first() {
                let conv =
                    url::Url::parse(&format!("{}/v1/users/ME/conversations", routes.chat)).ok().and_then(|mut u| {
                        u.path_segments_mut().ok()?.push(id);
                        u.set_query(Some("view=msnp24Equivalent"));
                        Some(u)
                    });
                if let Some(url) = conv {
                    let r =
                        http().get(url).header("authentication", format!("skypetoken={}", skype.as_str())).send().await;
                    out.insert("conversation".into(), describe_conversation(r).await);
                }
            } else {
                out.insert("conversation".into(), json!({ "note": "no conversation id listed" }));
            }
            // The roster lives on the threads service: scan up to 10 threads and
            // report the first with members, so an empty 1:1 does not hide it.
            let mut roster = None;
            let mut fallback = None;
            for id in ids.iter().take(10) {
                let Some(url) = thread_url(id, None) else { continue };
                let (status, body) = match http()
                    .get(url)
                    .header("authentication", format!("skypetoken={}", skype.as_str()))
                    .send()
                    .await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        (status, resp.json::<Value>().await.unwrap_or(Value::Null))
                    }
                    Err(_) => continue,
                };
                let report = member_report(status, None, &body);
                if report.get("member_count").and_then(Value::as_u64).unwrap_or(0) > 0 {
                    roster = Some(report);
                    break;
                }
                fallback.get_or_insert(report);
            }
            out.insert("thread_roster".into(), roster.or(fallback).unwrap_or(Value::Null));
            // Attachment shape: scan recent messages of a few conversations for
            // the first one carrying a file, reported by messagetype and field
            // names only (no filenames, urls or message text).
            let mut files = None;
            for id in ids.iter().take(12) {
                let msgs =
                    url::Url::parse(&format!("{}/v1/users/ME/conversations", routes.chat)).ok().and_then(|mut u| {
                        {
                            let mut seg = u.path_segments_mut().ok()?;
                            seg.push(id);
                            seg.push("messages");
                        }
                        u.set_query(Some("view=msnp24Equivalent&pageSize=50"));
                        Some(u)
                    });
                let Some(url) = msgs else { continue };
                let body = match http()
                    .get(url)
                    .header("authentication", format!("skypetoken={}", skype.as_str()))
                    .send()
                    .await
                {
                    Ok(resp) if resp.status().is_success() => resp.json::<Value>().await.unwrap_or(Value::Null),
                    _ => continue,
                };
                if let Some(report) = file_message_shape(&body) {
                    files = Some(report);
                    break;
                }
            }
            match files {
                Some((mut report, download)) => {
                    // Probe the file download with the Skype token: does the AMS
                    // host accept it? Report only status, content-type and
                    // whether a body came back. Never the url or any bytes.
                    if let (Some(url), Value::Object(map)) = (download, &mut report) {
                        let answer = http()
                            .get(&url)
                            .header("authentication", format!("skypetoken={}", skype.as_str()))
                            .send()
                            .await;
                        map.insert("download".into(), describe_download(answer).await);
                    }
                    out.insert("file_shape".into(), report);
                }
                None => {
                    out.insert("file_shape".into(), json!({ "note": "no file message found" }));
                }
            }
        }
        Value::Object(out)
    }

    /// Forgets the Skype token after the chat service refused it.
    pub async fn forget_chat(&self) {
        self.held.lock().await.skype = None;
    }

    pub async fn forget_aggregator(&self) {
        self.held.lock().await.aggregator = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_keep_teams_hosts_only() {
        let body = json!({"regionGtms": {
            "chatServiceAfd": "https://teams.microsoft.com/api/chatsvc/fr",
            "chatSvcAggAfd": "https://teams.microsoft.com/api/csa/emea",
            "calling_trouterUrl": "https://go-eu.trouter.teams.microsoft.com/v3/c",
            "calling_registrarUrl": "https://teams.microsoft.com/registrar/prod/V2/registrations",
            "ams": "https://fr-prod.asyncgw.teams.microsoft.com"
        }});
        let routes = Routes::discover(&body).unwrap();
        assert_eq!(routes.chat, "https://teams.microsoft.com/api/chatsvc/fr");
        assert_eq!(routes.trouter, "https://go-eu.trouter.teams.microsoft.com/v3/c");
        for bad in [
            "http://teams.microsoft.com/api/chatsvc/fr",
            "https://teams.microsoft.com.evil.example/api",
            "https://user@teams.microsoft.com/api/chatsvc/fr",
            "https://evilteams.microsoft.com/api",
        ] {
            let mut b = body.clone();
            b["regionGtms"]["chatServiceAfd"] = json!(bad);
            assert!(Routes::discover(&b).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_secret_round_trips_and_refuses_what_microsoft_never_gives() {
        let account = TeamsAccount {
            tenant_id: "d3144935-0000-4000-8000-000000000001".into(),
            refresh: Zeroizing::new("0.A-refresh".into()),
        };
        let mut secret = json!({
            "baseUrl": ORIGIN,
            "userId": "8:orgid:00000000-0000-4000-8000-0000000000aa",
            "username": "Ada",
            "authToken": "",
        });
        write_secret(&account, &mut secret);
        let info = from_secret(&secret).unwrap();
        assert_eq!(info.teams.as_ref(), Some(&account));
        assert_eq!(info.username, "Ada");
        for (key, bad) in [("baseUrl", "https://evil.example"), ("userId", "8:orgid:nope"), ("teamsTenantId", "x")] {
            let mut s = secret.clone();
            s[key] = json!(bad);
            assert!(from_secret(&s).is_none(), "{key}");
        }
        assert!(!format!("{account:?}").contains("refresh\": \"0.A"));
        assert!(!format!("{account:?}").contains("0.A-refresh"));
    }

    #[test]
    fn claims_are_read_from_the_id_token() {
        use base64::Engine;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"tid":"t","oid":"o"}"#);
        assert_eq!(claims(&format!("h.{payload}.s")).unwrap()["oid"], "o");
        assert!(claims("garbage").is_none());
    }
}
