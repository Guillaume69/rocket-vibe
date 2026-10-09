//! REST client. REST to act, DDP to listen: DDP method calls are deprecated
//! since Rocket.Chat 8.0. The same client speaks Mattermost's `/api/v4/`
//! (`Api::Mattermost`): bearer token, its own error envelope, and the media
//! authenticated by header since that server refuses a token in the URL.

use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::broadcast;
use url::Url;

pub const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RATE_LIMIT_RETRIES: u32 = 3;
const MAX_RETRY_DELAY_MS: i64 = 30_000;
const NETWORK_RETRY_DELAY: Duration = Duration::from_millis(400);
// Spread added to 429 retries, so that concurrent calls sharing the same
// `x-ratelimit-reset` do not wake up on the same millisecond and collide again.
const RATE_LIMIT_JITTER_MS: u64 = 500;
/// Below this a reset value is a count of seconds, not an instant (2001 in epoch ms).
const EPOCH_MS_FLOOR: i64 = 1_000_000_000_000;

const TWO_FACTOR_METHODS: [&str; 3] = ["totp", "email", "password"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub auth_token: String,
    pub user_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TwoFactorCode {
    pub code: String,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TwoFactorChallenge {
    pub method: String,
    pub methods: Vec<String>,
    pub code_generated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct RestError {
    /// 0 means no HTTP response at all: unreachable, timed out.
    pub status: u16,
    pub message: String,
    pub error: Option<String>,
    pub error_type: Option<String>,
    /// The body carried a recognized provider envelope, rather than a proxy's page.
    pub understood: bool,
    pub two_factor: Option<TwoFactorChallenge>,
    /// Provider diagnostics, independent of the server's user-facing message.
    pub request_id: Option<String>,
    pub retry_after: Option<u64>,
    /// The failure's `details`, when the server explains it (`user-last-owner`
    /// names the rooms).
    pub details: Option<Value>,
}

impl RestError {
    pub(crate) fn network(message: String) -> Self {
        RestError {
            status: 0,
            message,
            error: None,
            error_type: None,
            understood: false,
            two_factor: None,
            request_id: None,
            retry_after: None,
            details: None,
        }
    }

    /// A success whose body lacks what the call exists for.
    pub fn incomplete(message: &str) -> Self {
        RestError {
            status: 200,
            message: message.to_owned(),
            error: None,
            error_type: None,
            understood: true,
            two_factor: None,
            request_id: None,
            retry_after: None,
            details: None,
        }
    }
}

/// The only predicate allowed to trigger an automatic logout. On 8.5 a 401
/// means "not authenticated" and nothing else, but a 401 without a
/// Rocket.Chat envelope comes from something on the path, and a 2FA
/// challenge is not a refusal.
/// A 401 that judges a password typed now, not the session's token (probed on Mattermost 11.11).
const MATTERMOST_PASSWORD_REFUSED: &str = "api.user.check_user_password.invalid.app_error";

pub fn is_token_rejected(e: &RestError) -> bool {
    e.two_factor.is_none() && e.status == 401 && e.understood
}

/// Which server's REST dialect the client speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Api {
    #[default]
    RocketChat,
    Mattermost,
}

#[derive(Debug, Clone, Default)]
pub struct CallOptions {
    pub params: Vec<(String, String)>,
    pub body: Option<Value>,
    pub anonymous: bool,
    pub two_factor: Option<TwoFactorCode>,
    /// `/api/info` is the only useful route outside `/api/v1/`.
    pub outside_api_v1: bool,
    /// Replay once on a network failure. Only for idempotent writes: never
    /// for `chat.sendMessage`, whose dedup lives in the outbox.
    pub retry_on_network_error: bool,
}

impl CallOptions {
    pub fn params<K: Into<String>, V: Into<String>>(pairs: impl IntoIterator<Item = (K, V)>) -> Self {
        CallOptions { params: pairs.into_iter().map(|(k, v)| (k.into(), v.into())).collect(), ..Default::default() }
    }

    pub fn body(body: Value) -> Self {
        CallOptions { body: Some(body), ..Default::default() }
    }
}

#[derive(Clone)]
pub struct RestClient {
    http: reqwest::Client,
    base: Url,
    credentials: Arc<RwLock<Option<Credentials>>>,
    token_rejected: broadcast::Sender<String>,
    api: Api,
    /// kChat: a `{message}` error body is believed (`interpret_mattermost`).
    plain_errors: bool,
}

impl RestClient {
    pub fn new(base: Url) -> Self {
        Self::with_api(base, Api::RocketChat)
    }

    /// A client for a Mattermost (or kChat) server's `/api/v4/`.
    pub fn mattermost(base: Url) -> Self {
        Self::with_api(base, Api::Mattermost)
    }

    /// kChat: Mattermost's API, but errors are `{message}` without `id`.
    pub fn kchat(base: Url) -> Self {
        RestClient { plain_errors: true, ..Self::with_api(base, Api::Mattermost) }
    }

    fn with_api(base: Url, api: Api) -> Self {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("rocket-vibe-desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("HTTP client");
        let (token_rejected, _) = broadcast::channel(8);
        RestClient { http, base, credentials: Arc::default(), token_rejected, api, plain_errors: false }
    }

    pub fn base(&self) -> &Url {
        &self.base
    }

    pub fn api(&self) -> Api {
        self.api
    }

    fn authenticate(&self, request: reqwest::RequestBuilder, credentials: &Credentials) -> reqwest::RequestBuilder {
        match self.api {
            Api::RocketChat => {
                request.header("X-Auth-Token", &credentials.auth_token).header("X-User-Id", &credentials.user_id)
            }
            Api::Mattermost => request.bearer_auth(&credentials.auth_token),
        }
    }

    /// The URL of a server file, authenticated in its query on Rocket.Chat
    /// only: Mattermost takes the bearer header (`authenticate`).
    fn file_url(&self, path_or_url: &str) -> Option<Url> {
        let credentials = self.credentials();
        let in_query = credentials.as_ref().filter(|_| self.api == Api::RocketChat);
        crate::media::protected_url(&self.base, in_query, path_or_url)
    }

    /// The bearer goes with our own server's files only: attachment URLs come
    /// from message fields, so from anyone.
    fn file_request(&self, url: Url) -> reqwest::RequestBuilder {
        let same_origin = url.origin() == self.base.origin();
        let request = self.http.get(url);
        match self.credentials() {
            Some(c) if self.api == Api::Mattermost && same_origin => self.authenticate(request, &c),
            _ => request,
        }
    }

    pub fn set_credentials(&self, credentials: Option<Credentials>) {
        *self.credentials.write().unwrap() = credentials;
    }

    pub fn credentials(&self) -> Option<Credentials> {
        self.credentials.read().unwrap().clone()
    }

    /// Carries the token actually sent, so a late 401 on a replaced session
    /// can be told apart from a refusal of the current one.
    pub fn token_rejected(&self) -> broadcast::Receiver<String> {
        self.token_rejected.subscribe()
    }

    pub async fn get(&self, path: &str, options: CallOptions) -> Result<Value, RestError> {
        self.call(reqwest::Method::GET, path, options).await
    }

    pub async fn post(&self, path: &str, options: CallOptions) -> Result<Value, RestError> {
        self.call(reqwest::Method::POST, path, options).await
    }

    pub async fn put(&self, path: &str, options: CallOptions) -> Result<Value, RestError> {
        self.call(reqwest::Method::PUT, path, options).await
    }

    pub async fn delete(&self, path: &str, options: CallOptions) -> Result<Value, RestError> {
        self.call(reqwest::Method::DELETE, path, options).await
    }

    /// POSTs a file as a `multipart/form-data` field, with `texts` beside it,
    /// reporting `(sent, total)` bytes as the body streams out. The client's
    /// 15 s cap would cut any real upload: the timeout here grows with the size.
    #[allow(clippy::too_many_arguments)]
    pub async fn upload(
        &self,
        path: &str,
        field: &str,
        bytes: Vec<u8>,
        name: &str,
        mime: &str,
        texts: Vec<(String, String)>,
        progress: impl Fn(u64, u64) + Send + Sync + 'static,
    ) -> Result<Value, RestError> {
        const CHUNK: usize = 64 * 1024;
        let total = bytes.len() as u64;
        let progress = Arc::new(progress);
        let chunks: Vec<Vec<u8>> = bytes.chunks(CHUNK).map(<[u8]>::to_vec).collect();
        let mut sent = 0u64;
        let stream = futures_util::stream::iter(chunks.into_iter().map(move |chunk| {
            sent += chunk.len() as u64;
            progress(sent, total);
            Ok::<_, std::io::Error>(chunk)
        }));
        let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), total)
            .file_name(name.to_owned())
            .mime_str(mime)
            .map_err(|_| RestError::incomplete(&format!("{mime}: not a media type")))?;
        let form = texts
            .into_iter()
            .fold(reqwest::multipart::Form::new(), |form, (k, v)| form.text(k, v))
            .part(field.to_owned(), part);
        let mut request = self
            .http
            .post(self.url_for(path, &CallOptions::default()))
            .timeout(Duration::from_secs(60 + total / (32 * 1024)))
            .multipart(form);
        let sent_credentials = self.credentials();
        if let Some(c) = &sent_credentials {
            request = self.authenticate(request, c);
        }
        let response = request.send().await.map_err(|_| RestError::network(format!("{path}: upload interrupted.")))?;
        let status = response.status().as_u16();
        let text =
            response.text().await.map_err(|_| RestError::network(format!("{path}: connection lost while reading.")))?;
        let result = self.interpret(path, status, &text);
        if let (Err(e), Some(c)) = (&result, &sent_credentials)
            && is_token_rejected(e)
        {
            let _ = self.token_rejected.send(c.auth_token.clone());
        }
        result
    }

    /// GET a protected file (avatar, upload). Returns its bytes and content type.
    pub async fn fetch_protected(&self, path_or_url: &str) -> Result<(Vec<u8>, String), RestError> {
        let Some(url) = self.file_url(path_or_url) else {
            return Err(RestError::network(format!("{path_or_url}: not a URL.")));
        };
        let response = self
            .file_request(url)
            .send()
            .await
            .map_err(|_| RestError::network(format!("{path_or_url}: server unreachable.")))?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        if !(200..300).contains(&status) {
            return Err(RestError {
                status,
                message: format!("{path_or_url}: HTTP {status}."),
                ..RestError::network(String::new())
            });
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| RestError::network(format!("{path_or_url}: connection lost while reading.")))?;
        Ok((bytes.to_vec(), content_type))
    }

    /// Streams a server file into `dest`, reporting the bytes received so
    /// far. The client's 15 s cap would cut any large file: here only a
    /// silence of `STALL` ends the transfer.
    pub async fn download_protected(
        &self,
        path_or_url: &str,
        dest: &std::path::Path,
        progress: impl Fn(u64) + Send,
    ) -> Result<(), RestError> {
        use tokio::io::AsyncWriteExt as _;
        const STALL: Duration = Duration::from_secs(30);
        let Some(url) = self.file_url(path_or_url) else {
            return Err(RestError::network(format!("{path_or_url}: not a URL.")));
        };
        let lost = || RestError::network(format!("{path_or_url}: connection lost while reading."));
        let request = self.file_request(url).timeout(Duration::from_secs(24 * 3600)).send();
        let mut response = tokio::time::timeout(STALL, request)
            .await
            .ok()
            .and_then(Result::ok)
            .ok_or_else(|| RestError::network(format!("{path_or_url}: server unreachable.")))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(RestError {
                status,
                message: format!("{path_or_url}: HTTP {status}."),
                ..RestError::network(String::new())
            });
        }
        let written = |e: std::io::Error| RestError::incomplete(&format!("{}: {e}", dest.display()));
        let mut file = tokio::fs::File::create(dest).await.map_err(written)?;
        let mut received = 0u64;
        while let Some(chunk) =
            tokio::time::timeout(STALL, response.chunk()).await.map_err(|_| lost())?.map_err(|_| lost())?
        {
            file.write_all(&chunk).await.map_err(written)?;
            received += chunk.len() as u64;
            progress(received);
        }
        file.flush().await.map_err(written)
    }

    fn url_for(&self, path: &str, options: &CallOptions) -> Url {
        let mut url = self.base.clone();
        let prefix = match (options.outside_api_v1, self.api) {
            (true, _) => "/",
            (false, Api::RocketChat) => "/api/v1/",
            (false, Api::Mattermost) => "/api/v4/",
        };
        url.set_path(&format!("{}{prefix}{path}", self.base.path().trim_end_matches('/')));
        if !options.params.is_empty() {
            url.query_pairs_mut().extend_pairs(options.params.iter());
        }
        url
    }

    async fn call(&self, method: reqwest::Method, path: &str, options: CallOptions) -> Result<Value, RestError> {
        let mut rate_limit_attempt = 0;
        let mut network_attempt = 0;
        loop {
            // Captured before the request leaves: reading it at reception would
            // give the CURRENT token, and a late 401 would wipe a new session.
            let sent = if options.anonymous { None } else { self.credentials() };
            let mut request = self
                .http
                .request(method.clone(), self.url_for(path, &options))
                .header("Content-Type", "application/json");
            if let Some(c) = &sent {
                request = self.authenticate(request, c);
            }
            if let Some(tf) = &options.two_factor {
                request = request.header("x-2fa-code", &tf.code).header("x-2fa-method", &tf.method);
            }
            if let Some(body) = &options.body {
                request = request.body(body.to_string());
            }

            let response = match request.send().await {
                Ok(r) => r,
                Err(e) => {
                    if options.retry_on_network_error && network_attempt < 1 {
                        network_attempt += 1;
                        tokio::time::sleep(NETWORK_RETRY_DELAY).await;
                        continue;
                    }
                    let message = if e.is_timeout() {
                        format!("{path}: no response in {} s.", TIMEOUT.as_secs())
                    } else {
                        format!("{path}: server unreachable.")
                    };
                    return Err(RestError::network(message));
                }
            };

            let status = response.status().as_u16();
            if status == 429 && rate_limit_attempt < MAX_RATE_LIMIT_RETRIES {
                let delay = delay_after_429(response.headers().get("x-ratelimit-reset"), rate_limit_attempt);
                rate_limit_attempt += 1;
                tokio::time::sleep(delay).await;
                continue;
            }

            let text = match response.text().await {
                Ok(t) => t,
                Err(_) => return Err(RestError::network(format!("{path}: connection lost while reading."))),
            };
            let result = self.interpret(path, status, &text);
            if let (Err(e), Some(c)) = (&result, &sent)
                && is_token_rejected(e)
            {
                let _ = self.token_rejected.send(c.auth_token.clone());
            }
            return result;
        }
    }
}

impl RestClient {
    fn interpret(&self, path: &str, status: u16, text: &str) -> Result<Value, RestError> {
        match self.api {
            Api::RocketChat => interpret(path, status, text),
            Api::Mattermost => interpret_mattermost(path, status, text, self.plain_errors),
        }
    }
}

/// Mattermost answers lists as JSON arrays and errors as
/// `{id, message, status_code}`; that envelope is what makes a 401 believable.
/// kChat (`plain`) answers `{message}` alone, a revoked token included
/// (`401 {"message": "Unauthorized"}`, probed).
pub(crate) fn interpret_mattermost(path: &str, status: u16, text: &str, plain: bool) -> Result<Value, RestError> {
    let http_ok = (200..300).contains(&status);
    if text.trim().is_empty() && http_ok {
        return Ok(json!({}));
    }
    let parsed: Option<Value> = serde_json::from_str(text).ok();
    if http_ok {
        return parsed.ok_or_else(|| RestError {
            status,
            message: format!("{path}: non-JSON response ({status}, {} bytes).", text.len()),
            ..RestError::network(String::new())
        });
    }
    let str_of = |key: &str| parsed.as_ref().and_then(|v| v.get(key)).and_then(Value::as_str).map(str::to_owned);
    let error = str_of("id");
    let enveloped = (error.is_some() && parsed.as_ref().and_then(|v| v.get("status_code")).is_some())
        || (plain && str_of("message").is_some());
    let understood = enveloped && error.as_deref() != Some(MATTERMOST_PASSWORD_REFUSED);
    Err(RestError {
        status,
        message: str_of("message").unwrap_or_else(|| format!("{path} failed")),
        error,
        error_type: None,
        understood,
        two_factor: None,
        request_id: str_of("request_id"),
        retry_after: None,
        details: None,
    })
}

/// Rocket.Chat's `x-ratelimit-reset` is an instant in epoch milliseconds,
/// Mattermost's the seconds left until the reset.
fn delay_after_429(reset: Option<&reqwest::header::HeaderValue>, attempt: u32) -> Duration {
    let now = chrono::Utc::now().timestamp_millis();
    let wait = reset
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
        .map(|reset| if reset < EPOCH_MS_FLOOR { reset * 1000 } else { reset - now })
        .unwrap_or(0);
    let base = if wait > 0 { wait + 250 } else { 1000 << attempt };
    let jitter = fastrand::u64(0..RATE_LIMIT_JITTER_MS) as i64;
    Duration::from_millis((base + jitter).min(MAX_RETRY_DELAY_MS) as u64)
}

fn interpret(path: &str, status: u16, text: &str) -> Result<Value, RestError> {
    let http_ok = (200..300).contains(&status);
    // `POST /api/v1/logout` answers 200 with an empty body.
    if text.trim().is_empty() && http_ok {
        return Ok(json!({}));
    }
    let json: Value = match serde_json::from_str(text) {
        Ok(v @ Value::Object(_)) => v,
        _ => {
            return Err(RestError {
                status,
                message: format!("{path}: non-JSON response ({status}, {} bytes).", text.len()),
                error: None,
                error_type: None,
                understood: false,
                two_factor: None,
                request_id: None,
                retry_after: None,
                details: None,
            });
        }
    };
    let str_of = |key: &str| json.get(key).and_then(Value::as_str).map(str::to_owned);

    // 8.5 flags 2FA two ways: `error` on /login, `errorType` elsewhere.
    if str_of("errorType").as_deref() == Some("totp-required") || str_of("error").as_deref() == Some("totp-required") {
        let details = json.get("details");
        let method = details
            .and_then(|d| d.get("method"))
            .and_then(Value::as_str)
            .filter(|m| TWO_FACTOR_METHODS.contains(m))
            .unwrap_or("password")
            .to_owned();
        let methods = details
            .and_then(|d| d.get("availableMethods"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .filter(|m| TWO_FACTOR_METHODS.contains(m))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let code_generated = details.and_then(|d| d.get("codeGenerated")).and_then(Value::as_bool).unwrap_or(false);
        return Err(RestError {
            status,
            message: format!("Two-factor authentication required ({method})."),
            error: None,
            error_type: Some("totp-required".into()),
            understood: true,
            two_factor: Some(TwoFactorChallenge { method, methods, code_generated }),
            request_id: None,
            retry_after: None,
            details: None,
        });
    }

    // `success: false` on /api/v1/*, `status: 'error'` on /api/v1/login.
    let failed =
        !http_ok || json.get("success") == Some(&Value::Bool(false)) || str_of("status").as_deref() == Some("error");
    if failed {
        let error = str_of("error");
        let error_type = str_of("errorType");
        // "JSON" is not "Rocket.Chat": a gateway happily answers
        // `401 {"message":"Unauthorized"}`. Require a mark of the envelope.
        let understood = json.get("success").is_some_and(Value::is_boolean)
            || str_of("status").as_deref() == Some("error")
            || error_type.is_some();
        return Err(RestError {
            status,
            message: error.clone().or_else(|| str_of("message")).unwrap_or_else(|| format!("{path} failed")),
            error,
            error_type,
            understood,
            two_factor: None,
            request_id: None,
            retry_after: None,
            details: json.get("details").cloned(),
        });
    }
    Ok(json)
}
