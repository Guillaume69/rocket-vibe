//! Rocket.Chat REST client. REST to act, DDP to listen: DDP method calls are
//! deprecated since 8.0.

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
    /// The body carried a Rocket.Chat envelope, as opposed to a proxy's page.
    pub understood: bool,
    pub two_factor: Option<TwoFactorChallenge>,
}

impl RestError {
    fn network(message: String) -> Self {
        RestError { status: 0, message, error: None, error_type: None, understood: false, two_factor: None }
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
        }
    }
}

/// The only predicate allowed to trigger an automatic logout. On 8.5 a 401
/// means "not authenticated" and nothing else, but a 401 without a
/// Rocket.Chat envelope comes from something on the path, and a 2FA
/// challenge is not a refusal.
pub fn is_token_rejected(e: &RestError) -> bool {
    e.two_factor.is_none() && e.status == 401 && e.understood
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
}

impl RestClient {
    pub fn new(base: Url) -> Self {
        let http = reqwest::Client::builder().timeout(TIMEOUT).build().expect("HTTP client");
        let (token_rejected, _) = broadcast::channel(8);
        RestClient { http, base, credentials: Arc::default(), token_rejected }
    }

    pub fn base(&self) -> &Url {
        &self.base
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

    /// GET a protected file (avatar, upload). Returns its bytes and content type.
    pub async fn fetch_protected(&self, path_or_url: &str) -> Result<(Vec<u8>, String), RestError> {
        let credentials = self.credentials();
        let Some(url) = crate::media::protected_url(&self.base, credentials.as_ref(), path_or_url) else {
            return Err(RestError::network(format!("{path_or_url}: not a URL.")));
        };
        let response = self
            .http
            .get(url)
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

    fn url_for(&self, path: &str, options: &CallOptions) -> Url {
        let mut url = self.base.clone();
        let prefix = if options.outside_api_v1 { "/" } else { "/api/v1/" };
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
                request = request.header("X-Auth-Token", &c.auth_token).header("X-User-Id", &c.user_id);
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
            let result = interpret(path, status, &text);
            if let (Err(e), Some(c)) = (&result, &sent)
                && is_token_rejected(e)
            {
                let _ = self.token_rejected.send(c.auth_token.clone());
            }
            return result;
        }
    }
}

fn delay_after_429(reset: Option<&reqwest::header::HeaderValue>, attempt: u32) -> Duration {
    let now = chrono::Utc::now().timestamp_millis();
    let wait =
        reset.and_then(|h| h.to_str().ok()).and_then(|s| s.parse::<i64>().ok()).map(|reset| reset - now).unwrap_or(0);
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
        });
    }
    Ok(json)
}
