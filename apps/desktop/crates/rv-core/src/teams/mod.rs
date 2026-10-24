//! Microsoft Teams: rv-teams speaks to it; here, its account among rv-core's
//! sessions, its conversations in the store (`sync`) and what a user does in
//! them (`actions`).

pub use rv_teams::*;

pub mod actions;
pub mod sync;

use serde_json::Value;

use crate::rest::RestError;
use crate::session::SessionInfo;

impl From<Session> for SessionInfo {
    fn from(session: Session) -> Self {
        SessionInfo {
            base_url: auth::ORIGIN.to_owned(),
            user_id: session.user_id,
            username: session.username,
            auth_token: String::new(),
            native: None,
            mattermost: None,
            slack: None,
            teams: Some(session.account),
        }
    }
}

/// The Teams side of an rv-core session; None for any other kind of account.
pub fn session(info: &SessionInfo) -> Option<Session> {
    let account = info.teams.clone()?;
    Some(Session { user_id: info.user_id.clone(), username: info.username.clone(), account })
}

/// `auth::approved`, as an rv-core session.
pub async fn approved(code: &auth::DeviceCode, cancelled: impl Fn() -> bool) -> Result<SessionInfo, RestError> {
    auth::approved(code, cancelled).await.map(SessionInfo::from)
}

pub fn from_secret(value: &Value) -> Option<SessionInfo> {
    auth::from_secret(value).map(SessionInfo::from)
}

/// Where a rotated refresh token is saved: the app's keychain, set once at start.
pub fn set_credential_sink(sink: impl Fn(&SessionInfo) + Send + Sync + 'static) {
    auth::set_credential_sink(move |session| sink(&SessionInfo::from(session.clone())));
}
