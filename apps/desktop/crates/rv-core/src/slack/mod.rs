//! Slack: rv-slack speaks to it; here, its account among rv-core's sessions
//! and its conversations in the store (`sync`).

pub use rv_slack::*;

pub mod sync;

use serde_json::Value;

use crate::rest::{Credentials, RestClient, RestError};
use crate::session::SessionInfo;

impl From<Session> for SessionInfo {
    fn from(session: Session) -> Self {
        SessionInfo {
            base_url: session.base_url,
            user_id: session.user_id,
            username: session.username,
            auth_token: session.auth_token,
            native: None,
            mattermost: None,
            slack: Some(session.account),
            teams: None,
        }
    }
}

/// `rv_slack::login`, as an rv-core session.
pub async fn login(token: &str, cookie: &str, expected: Option<(&str, &str)>) -> Result<SessionInfo, RestError> {
    rv_slack::login(token, cookie, expected).await.map(SessionInfo::from)
}

pub async fn login_at(
    api: &url::Url,
    token: &str,
    cookie: &str,
    expected: Option<(&str, &str)>,
) -> Result<SessionInfo, RestError> {
    rv_slack::login_at(api, token, cookie, expected).await.map(SessionInfo::from)
}

pub async fn login_paired(session: &handoff::BrowserSession) -> Result<SessionInfo, RestError> {
    rv_slack::login_paired(session).await.map(SessionInfo::from)
}

pub fn from_secret(value: &Value) -> Option<SessionInfo> {
    account::from_secret(value).map(SessionInfo::from)
}

/// The REST client of a signed-in account.
pub fn client(info: &SessionInfo, account: &SlackAccount) -> RestClient {
    let credentials = Credentials { auth_token: info.auth_token.clone(), user_id: info.user_id.clone() };
    account::client(&info.base_url, credentials, account)
}
