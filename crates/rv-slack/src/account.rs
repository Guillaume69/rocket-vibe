//! A saved Slack account: signed in with a browser session's `xoxc` token and
//! `d` cookie, checked by `auth.test`. It lives until Slack refuses it.

use serde_json::{Value, json};
use url::Url;
use zeroize::Zeroizing;

use super::api::ORIGIN;
use super::handoff::BrowserSession;
use super::{identity, validate_credentials};
use rv_provider::rest::{CallOptions, Credentials, RestClient, RestError};

/// What a Slack account keeps beside its token, in the same secret record.
#[derive(Clone, PartialEq, Eq)]
pub struct SlackAccount {
    pub team_id: String,
    /// Byte for byte as the browser had it: never decoded.
    pub cookie: Zeroizing<String>,
}

impl std::fmt::Debug for SlackAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SlackAccount").field("team_id", &self.team_id).field("cookie", &"[redacted]").finish()
    }
}

/// A signed-in account: who it is, its token and what Slack keeps beside it.
#[derive(Clone, PartialEq, Eq)]
pub struct Session {
    pub base_url: String,
    pub user_id: String,
    pub username: String,
    pub auth_token: String,
    pub account: SlackAccount,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("base_url", &self.base_url)
            .field("user_id", &self.user_id)
            .field("username", &self.username)
            .field("auth_token", &"[redacted]")
            .field("account", &self.account)
            .finish()
    }
}

fn refusal(code: &str) -> RestError {
    RestError { error: Some(code.to_owned()), ..RestError::incomplete(&format!("Slack: {code}")) }
}

/// A workspace on slack.com reads Slack's API; any other base is a test server.
pub fn api_base(base_url: &str) -> Url {
    let origin = || ORIGIN.parse().expect("Slack API origin");
    match Url::parse(base_url) {
        Ok(url) if workspace(&url) => origin(),
        Ok(url) => url,
        Err(_) => origin(),
    }
}

fn workspace(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|h| h.ends_with(".slack.com"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
}

/// The REST client of a signed-in account.
pub fn client(base_url: &str, credentials: Credentials, account: &SlackAccount) -> RestClient {
    let rest = RestClient::slack(api_base(base_url), account.cookie.clone());
    rest.set_credentials(Some(credentials));
    rest
}

/// Checks the session with `auth.test` on slack.com; `expected` is the team
/// and user a pairing announced.
pub async fn login(token: &str, cookie: &str, expected: Option<(&str, &str)>) -> Result<Session, RestError> {
    login_at(&ORIGIN.parse().expect("Slack API origin"), token, cookie, expected).await
}

/// `login` against the API at `api`.
pub async fn login_at(
    api: &Url,
    token: &str,
    cookie: &str,
    expected: Option<(&str, &str)>,
) -> Result<Session, RestError> {
    let (token, cookie) = (Zeroizing::new(token.trim().to_owned()), Zeroizing::new(cookie.trim().to_owned()));
    validate_credentials(&token, &cookie).map_err(|e| refusal(e.code))?;
    rv_provider::tls::ensure_provider();
    let rest = RestClient::slack(api.clone(), cookie.clone());
    rest.set_credentials(Some(Credentials { auth_token: token.to_string(), user_id: String::new() }));
    let who = identity(&rest.post("auth.test", CallOptions::default()).await?).map_err(|e| refusal(e.code))?;
    if expected.is_some_and(|(team, user)| team != who.team_id || user != who.user_id) {
        return Err(refusal("identity_mismatch"));
    }
    Ok(Session {
        base_url: who.origin,
        user_id: who.user_id,
        username: who.user,
        auth_token: token.to_string(),
        account: SlackAccount { team_id: who.team_id, cookie },
    })
}

/// The session a browser pairing handed over, for the account it named.
pub async fn login_paired(session: &BrowserSession) -> Result<Session, RestError> {
    login(&session.token, &session.cookie, Some((&session.team_id, &session.user_id))).await
}

pub fn write_secret(account: &SlackAccount, secret: &mut Value) {
    secret["slackTeamId"] = json!(account.team_id);
    secret["slackCookie"] = json!(account.cookie.as_str());
}

/// A saved Slack account, refused unless every field is one Slack could have given.
pub fn from_secret(value: &Value) -> Option<Session> {
    let field = |key: &str| value[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    let base_url = field("baseUrl")?;
    let parsed = Url::parse(&base_url).ok()?;
    if !workspace(&parsed) || parsed.origin().ascii_serialization() != base_url {
        return None;
    }
    let auth_token = field("authToken")?;
    let cookie = Zeroizing::new(field("slackCookie")?);
    validate_credentials(&auth_token, &cookie).ok()?;
    let (team_id, user_id) = (field("slackTeamId")?, field("userId")?);
    if !super::id(&team_id, b"T") || !super::id(&user_id, b"UW") {
        return None;
    }
    Some(Session {
        base_url,
        username: field("username").unwrap_or_else(|| user_id.clone()),
        user_id,
        auth_token,
        account: SlackAccount { team_id, cookie },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_api_is_slack_for_any_workspace() {
        assert_eq!(api_base("https://t000.slack.com").as_str(), "https://slack.com/");
        assert_eq!(api_base("http://127.0.0.1:9").as_str(), "http://127.0.0.1:9/");
        assert_eq!(api_base("not a url").as_str(), "https://slack.com/");
    }

    #[test]
    fn debug_never_shows_the_cookie() {
        let account = SlackAccount { team_id: "T000".into(), cookie: Zeroizing::new("xoxd-hidden".into()) };
        assert!(!format!("{account:?}").contains("hidden"));
    }
}
