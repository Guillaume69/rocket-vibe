//! Mattermost and kChat (Infomaniak's Mattermost) servers: sign-in here, the
//! store mapping in `translate`, the sync in `sync`, the sockets in `socket`
//! (Mattermost) and `pusher` (kChat).
//!
//! Login deliberately omits `X-Requested-With`: with it the server sets the
//! `MMAUTHTOKEN` cookie, which then wins over the bearer, and a `POST` without
//! a CSRF token answers 401 `session_expired` (probed on 11.11).

pub mod actions;
pub mod categories;
pub mod directory;
pub mod pusher;
pub mod socket;
pub mod sync;
pub mod translate;

use std::time::Duration;

use serde_json::{Value, json};
use url::Url;

use crate::rest::{CallOptions, Credentials, RestClient, RestError, TwoFactorChallenge, TwoFactorCode};
use crate::session::SessionInfo;

pub const MFA_REQUIRED: &str = "mfa.validate_token.authenticate.app_error";
/// Where kChat sign-in starts: the account's team servers are listed there.
pub const KCHAT_DIRECTORY: &str = "https://kchat.infomaniak.com";
/// `RestError::error` of a kChat sign-in that must pick one of several team servers.
pub const KCHAT_SEVERAL_SERVERS: &str = "kchat_several_servers";
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Upstream Mattermost, or kChat: a bearer from Infomaniak, its own socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Mattermost,
    Kchat,
}

impl Flavor {
    pub fn genre(self) -> &'static str {
        match self {
            Flavor::Mattermost => "mattermost",
            Flavor::Kchat => "kchat",
        }
    }

    pub fn from_genre(genre: &str) -> Option<Flavor> {
        match genre {
            "mattermost" => Some(Flavor::Mattermost),
            "kchat" => Some(Flavor::Kchat),
            _ => None,
        }
    }
}

pub fn is_kchat_host(base: &Url) -> bool {
    base.host_str().is_some_and(|h| h == "kchat.infomaniak.com" || h.ends_with(".kchat.infomaniak.com"))
}

fn error(message: &str) -> RestError {
    RestError::incomplete(message)
}

/// The server's version when it is a Mattermost, else None. `/system/ping` is
/// anonymous and answers `{status: "OK"}`; a Rocket.Chat or a proxy answers
/// 404 or HTML there.
pub async fn probe(base: &Url) -> Option<String> {
    let client = reqwest::Client::builder().timeout(PROBE_TIMEOUT).build().ok()?;
    let response =
        client.get(format!("{}/api/v4/system/ping", base.as_str().trim_end_matches('/'))).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let version = response
        .headers()
        .get("x-version-id")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split('.').take(3).collect::<Vec<_>>().join("."));
    let body: Value = serde_json::from_str(&response.text().await.ok()?).ok()?;
    (body.get("status").and_then(Value::as_str) == Some("OK")).then(|| version.unwrap_or_default())
}

/// `POST /users/login`; the token comes back in the `Token` header. A missing
/// second factor reads as the TOTP challenge the login screen already asks.
pub async fn login(
    base: &Url,
    user: &str,
    password: &str,
    two_factor: Option<TwoFactorCode>,
) -> Result<SessionInfo, RestError> {
    crate::tls::ensure_provider();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("rocket-vibe-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| error("HTTP client"))?;
    let mut body = json!({"login_id": user.trim(), "password": password});
    let answered = two_factor.as_ref().map(|c| c.code.trim().to_owned()).filter(|c| !c.is_empty());
    if let Some(code) = &answered {
        body["token"] = json!(code);
    }
    let response = client
        .post(format!("{}/api/v4/users/login", base.as_str().trim_end_matches('/')))
        .json(&body)
        .send()
        .await
        .map_err(|_| RestError::network("users/login: server unreachable.".into()))?;
    let status = response.status().as_u16();
    let token = response.headers().get("token").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let text = response.text().await.map_err(|_| RestError::network("users/login: connection lost.".into()))?;
    let me = match crate::rest::interpret_mattermost("users/login", status, &text, false) {
        Ok(me) => me,
        Err(mut e) if e.error.as_deref() == Some(MFA_REQUIRED) && answered.is_none() => {
            e.two_factor =
                Some(TwoFactorChallenge { method: "totp".into(), methods: vec!["totp".into()], code_generated: true });
            return Err(e);
        }
        Err(e) => return Err(e),
    };
    let token = token.ok_or_else(|| error("Login answer without a token."))?;
    session_info(base, &token, &me, Flavor::Mattermost)
}

/// A bearer token (Mattermost personal access token, Infomaniak token for
/// kChat), checked against `/users/me`, which names the account.
pub async fn login_with_token(base: &Url, token: &str, flavor: Flavor) -> Result<SessionInfo, RestError> {
    let rest = client(base.clone(), Some(flavor));
    rest.set_credentials(Some(Credentials { auth_token: token.trim().to_owned(), user_id: String::new() }));
    let me = rest.get("users/me", CallOptions::default()).await?;
    session_info(base, token.trim(), &me, flavor)
}

/// Best effort, as on Rocket.Chat. A kChat token belongs to Infomaniak: never revoked from here.
pub async fn logout(rest: &RestClient, flavor: Flavor) {
    if flavor == Flavor::Mattermost {
        let _ = rest.post("users/logout", CallOptions::default()).await;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KchatServer {
    pub name: String,
    pub url: String,
}

/// The kChat servers the Infomaniak token opens.
pub async fn kchat_servers(token: &str) -> Result<Vec<KchatServer>, RestError> {
    let rest = RestClient::kchat(KCHAT_DIRECTORY.parse().expect("kChat directory URL"));
    rest.set_credentials(Some(Credentials { auth_token: token.trim().to_owned(), user_id: String::new() }));
    let list = rest.get("users/me/servers", CallOptions::default()).await?;
    Ok(list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let url = s.get("url")?.as_str()?.trim_end_matches('/').to_owned();
            let name = ["display_name", "name"]
                .iter()
                .find_map(|k| s.get(*k).and_then(Value::as_str).filter(|n| !n.is_empty()))
                .unwrap_or(&url)
                .to_owned();
            Some(KchatServer { name, url })
        })
        .collect())
}

/// kChat: the address of one team server signs in there; the bare
/// `kchat.infomaniak.com` signs in on the only server of the account, and
/// names them all when there are several.
pub async fn login_kchat(base: &Url, token: &str) -> Result<SessionInfo, RestError> {
    if base.host_str() != Some("kchat.infomaniak.com") {
        return login_with_token(base, token, Flavor::Kchat).await;
    }
    let servers = kchat_servers(token).await?;
    match servers.as_slice() {
        [] => Err(error("No kChat server for this account.")),
        [one] => {
            let url: Url = one.url.parse().map_err(|_| error("kChat server URL"))?;
            login_with_token(&url, token, Flavor::Kchat).await
        }
        many => Err(RestError {
            error: Some(KCHAT_SEVERAL_SERVERS.to_owned()),
            ..error(&many.iter().map(|s| format!("{} ({})", s.name, s.url)).collect::<Vec<_>>().join(", "))
        }),
    }
}

/// The REST client of a Mattermost account, kChat's error envelope included.
pub fn client(base: Url, flavor: Option<Flavor>) -> RestClient {
    match flavor {
        Some(Flavor::Kchat) => RestClient::kchat(base),
        _ => RestClient::mattermost(base),
    }
}

/// `<my user id>:<digits>`, the web client's format: kChat refuses any other
/// with 422 (probed). The digits are the client id's hex read as a number, so a
/// replay of the same row sends the same value and the server deduplicates it.
pub fn pending_post_id(me: &str, client_id: &str) -> String {
    let hex: String = client_id.chars().filter(char::is_ascii_hexdigit).collect();
    let digits =
        u128::from_str_radix(if hex.is_empty() { "0" } else { &hex }, 16).map_or(hex.clone(), |n| n.to_string());
    format!("{me}:{digits}")
}

fn session_info(base: &Url, token: &str, me: &Value, flavor: Flavor) -> Result<SessionInfo, RestError> {
    let field = |key: &str| me.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let (Some(user_id), Some(username)) = (field("id"), field("username")) else {
        return Err(error("Account answer without an id."));
    };
    Ok(SessionInfo {
        base_url: base.as_str().trim_end_matches('/').to_owned(),
        user_id,
        username,
        auth_token: token.to_owned(),
        native: None,
        mattermost: Some(flavor),
    })
}

/// Does an account that is not open have something unread?
pub async fn unread(info: &SessionInfo) -> Result<bool, RestError> {
    let base: Url = info.base_url.parse().map_err(|_| error("base URL"))?;
    let rest = client(base, info.mattermost);
    rest.set_credentials(Some(Credentials { auth_token: info.auth_token.clone(), user_id: info.user_id.clone() }));
    let page = || CallOptions::params([("per_page", "200")]);
    let (channels, members) =
        tokio::try_join!(rest.get("users/me/channels", page()), rest.get("users/me/channel_members", page()))?;
    let channels = channels.as_array().cloned().unwrap_or_default();
    Ok(members.as_array().into_iter().flatten().any(|member| {
        let id = member.get("channel_id").and_then(Value::as_str);
        channels.iter().find(|c| c.get("id").and_then(Value::as_str) == id).is_some_and(|channel| {
            let (unread, mentions) = translate::counts(channel, member);
            unread > 0 || mentions > 0
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_post_id_is_my_id_and_the_rows_digits() {
        let me = "0196fc24-9fdf-72a9-9dfe-81b84476e14f";
        assert_eq!(pending_post_id(me, "ffffffffffffffffffffffff"), format!("{me}:79228162514264337593543950335"));
        assert_eq!(pending_post_id(me, "up-00000000000000ff"), format!("{me}:255"));
    }

    #[test]
    fn kchat_plain_errors_are_believed_only_on_kchat() {
        let body = r#"{"message": "Unauthorized"}"#;
        assert!(!crate::rest::interpret_mattermost("users/me", 401, body, false).unwrap_err().understood);
        assert!(crate::rest::interpret_mattermost("users/me", 401, body, true).unwrap_err().understood);
        assert!(!crate::rest::interpret_mattermost("users/me", 401, "<html>", true).unwrap_err().understood);
    }
}
