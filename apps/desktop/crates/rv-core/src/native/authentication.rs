//! Pre-authentication coordinator shared by GTK/SwiftUI. Its dedicated pending
//! record belongs in the secure vault, never the active session or SQLite.
use super::{
    Error, Identity, check,
    credentials::{self, Record},
};
use crate::session::SessionInfo;
use rv_client::NativeClient;
pub use rv_protocol::parity::SecondFactor;
use rv_protocol::{
    Discovery, Session, User,
    parity::{AuthChallenge, AuthenticationStep, FinishFactor},
};
use serde::{Deserialize, Serialize};
use std::future::Future;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PendingFactor {
    pub operation_id: String,
    pub next_token: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginChallenge {
    pub base_url: String,
    pub identity: Identity,
    pub user: User,
    pub challenge: AuthChallenge,
    pub pending: Option<PendingFactor>,
}

pub enum Step {
    Authenticated(Record),
    Challenge(LoginChallenge),
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub fn method_name(method: SecondFactor) -> &'static str {
    match method {
        SecondFactor::Totp => "totp",
        SecondFactor::Email => "email",
        SecondFactor::RecoveryCode => "recovery_code",
    }
}
impl LoginChallenge {
    pub fn validate(&self) -> Result<(), Error> {
        NativeClient::new(&self.base_url)?;
        let methods = self.challenge.methods.iter().map(|m| method_name(*m)).collect::<std::collections::HashSet<_>>();
        if !token(&self.challenge.challenge_id)
            || self.user.id.is_empty()
            || self.user.id.len() > 128
            || self.user.username.is_empty()
            || self.user.username.len() > 128
            || self.identity.instance_id.is_empty()
            || self.identity.data_epoch.is_empty()
            || self.identity.instance_id.len() > 128
            || self.identity.data_epoch.len() > 128
            || self.challenge.methods.is_empty()
            || self.challenge.methods.len() > 3
            || methods.len() != self.challenge.methods.len()
            || chrono::DateTime::parse_from_rfc3339(&self.challenge.expires_at).is_err()
            || self.pending.as_ref().is_some_and(|p| {
                !identifier(&p.operation_id) || !token(&p.next_token) || p.next_token == self.challenge.challenge_id
            })
        {
            return Err(Error::Protocol("invalid_native_authentication"));
        }
        Ok(())
    }
}

fn record(base: &str, identity: &Identity, session: Session, expected: Option<&str>) -> Result<Record, Error> {
    let expiry = chrono::DateTime::parse_from_rfc3339(&session.expires_at)
        .map_err(|_| Error::Protocol("invalid_native_session"))?;
    if !token(&session.token)
        || session.user.id.is_empty()
        || session.user.id.len() > 128
        || expected.is_some_and(|id| session.user.id != id)
        || expiry <= chrono::Utc::now()
    {
        return Err(Error::Protocol("invalid_native_session"));
    }
    Ok(Record {
        info: SessionInfo {
            base_url: base.into(),
            user_id: session.user.id,
            username: session.user.username,
            auth_token: session.token,
            native: Some(identity.clone()),
        },
        pending: None,
        expires_at: Some(session.expires_at),
    })
}

pub async fn start(base: &url::Url, discovered: &Discovery, username: &str, password: &str) -> Result<Step, Error> {
    let mut client = NativeClient::new(base.as_str())?;
    let identity = Identity { instance_id: discovered.instance_id.clone(), data_epoch: discovered.data_epoch.clone() };
    let fresh = client.discover().await?;
    check(&identity, &fresh)?;
    let step = if fresh.capabilities.second_factors {
        client.start_login(username, password).await?
    } else {
        AuthenticationStep::Session { session: client.login(username, password).await? }
    };
    check(&identity, &client.discover().await?)?;
    match step {
        AuthenticationStep::Session { session } => {
            Ok(Step::Authenticated(record(base.as_str().trim_end_matches('/'), &identity, session, None)?))
        }
        AuthenticationStep::Challenge { challenge, user } => {
            let saved = LoginChallenge {
                base_url: base.as_str().trim_end_matches('/').into(),
                identity,
                user,
                challenge,
                pending: None,
            };
            saved.validate()?;
            Ok(Step::Challenge(saved))
        }
    }
}

/// Signup/recovery return a User rather than a bearer. Follow the same factor
/// login, and require the resulting session/challenge to name that exact UID.
pub async fn start_account_code(
    base: &url::Url,
    discovered: &Discovery,
    username: &str,
    password: &str,
    token: &str,
    recovery: bool,
) -> Result<Step, Error> {
    let client = NativeClient::new(base.as_str())?;
    let identity = Identity { instance_id: discovered.instance_id.clone(), data_epoch: discovered.data_epoch.clone() };
    let fresh = client.discover().await?;
    check(&identity, &fresh)?;
    if !(if recovery { fresh.capabilities.account_recovery } else { fresh.capabilities.account_invitations }) {
        return Err(Error::Protocol(if recovery { "recovery_unavailable" } else { "invitation_unavailable" }));
    }
    let user = if recovery {
        client
            .recover_account(&rv_protocol::parity::RecoverAccount {
                token: token.into(),
                username: username.into(),
                new_password: password.into(),
            })
            .await?
    } else {
        client
            .accept_invitation(&rv_protocol::parity::AcceptInvitation {
                token: token.into(),
                username: username.into(),
                password: password.into(),
            })
            .await?
    };
    check(&identity, &client.discover().await?)?;
    let result = start(base, discovered, username, password).await?;
    let uid = match &result {
        Step::Authenticated(record) => &record.info.user_id,
        Step::Challenge(saved) => &saved.user.id,
    };
    if uid != &user.id {
        return Err(Error::Protocol("server_identity_changed"));
    }
    Ok(result)
}

/// Probe the already durable candidate first. A network/protocol refusal is
/// never treated as proof that the code failed. Callers retain the pending
/// record until the completed active session has itself been committed securely.
async fn recover_candidate(saved: &LoginChallenge, client: &mut NativeClient) -> Result<Option<Record>, Error> {
    let Some(pending) = saved.pending.as_ref() else {
        return Ok(None);
    };
    client.restore(pending.next_token.clone());
    let user = match client.me().await {
        Ok(user) => user,
        Err(rv_client::Error::Server { status: 401, code, .. }) if code == "session_rejected" => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if user.id != saved.user.id {
        return Err(Error::Protocol("server_identity_changed"));
    }
    let devices = client.device_sessions().await?;
    let unique = devices.iter().map(|d| &d.id).collect::<std::collections::HashSet<_>>();
    let active = devices.iter().filter(|d| d.current).collect::<Vec<_>>();
    if devices.len() > 64
        || unique.len() != devices.len()
        || active.len() != 1
        || devices.iter().any(|d| d.id.is_empty())
    {
        return Err(Error::Protocol("invalid_native_session"));
    }
    check(&saved.identity, &client.discover().await?)?;
    Ok(Some(record(
        &saved.base_url,
        &saved.identity,
        Session { token: pending.next_token.clone(), expires_at: active[0].expires_at.clone(), user },
        Some(&saved.user.id),
    )?))
}

pub async fn recover(saved: &LoginChallenge) -> Result<Option<Record>, Error> {
    saved.validate()?;
    let mut client = NativeClient::new(&saved.base_url)?;
    check(&saved.identity, &client.discover().await?)?;
    recover_candidate(saved, &mut client).await
}

pub async fn finish<F, Fut>(
    mut saved: LoginChallenge,
    method: SecondFactor,
    code: &str,
    mut save: F,
) -> Result<Record, Error>
where
    F: FnMut(LoginChallenge) -> Fut,
    Fut: Future<Output = Result<(), Error>>,
{
    saved.validate()?;
    let mut client = NativeClient::new(&saved.base_url)?;
    let discovery = client.discover().await?;
    check(&saved.identity, &discovery)?;
    if let Some(completed) = recover_candidate(&saved, &mut client).await? {
        return Ok(completed);
    }
    if !discovery.capabilities.second_factors {
        return Err(Error::Protocol("factor_unavailable"));
    }
    if chrono::DateTime::parse_from_rfc3339(&saved.challenge.expires_at)
        .map_err(|_| Error::Protocol("invalid_native_authentication"))?
        <= chrono::Utc::now()
    {
        return Err(Error::Protocol("factor_expired"));
    }
    if !saved.challenge.methods.iter().any(|m| method_name(*m) == method_name(method))
        || code.len() > 128
        || code.trim().is_empty()
    {
        return Err(Error::Protocol("invalid_factor_code"));
    }
    if saved.pending.is_none() {
        saved.pending = Some(PendingFactor { operation_id: credentials::token()?, next_token: credentials::token()? });
        saved.validate()?;
        save(saved.clone()).await?; // Fail closed if the vault cannot durably save.
    }
    let pending = saved.pending.as_ref().expect("durable candidate");
    let session = client
        .finish_factor(&FinishFactor {
            challenge_id: saved.challenge.challenge_id.clone(),
            method,
            code: code.trim().into(),
            operation_id: pending.operation_id.clone(),
            next_token: pending.next_token.clone(),
        })
        .await?;
    if session.token != pending.next_token {
        return Err(Error::Protocol("invalid_native_session"));
    }
    check(&saved.identity, &client.discover().await?)?;
    record(&saved.base_url, &saved.identity, session, Some(&saved.user.id))
}
