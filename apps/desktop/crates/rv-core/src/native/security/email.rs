//! Private contact verification shares the proof/factor OS lease. Temporary
//! input codes never enter the trousseau; original intent survives lost ACKs.
use super::{
    Access, Error, Guard, NativeSession, RemoteFuture, Scope, Vault, identifier, invalid, nonce, random_token,
};
use rv_protocol::parity::{
    BeginEmailVerification, ConfirmEmailVerification, EmailVerificationStep, ResumeEmailVerification,
    RetireEmailVerification,
};
pub use rv_protocol::parity::{EmailDeliveryState, EmailStatus};
use serde::{Deserialize, Serialize};
use std::{fs::File, future::Future, sync::Arc};

pub trait Remote: Send + Sync {
    fn status(&self) -> RemoteFuture<EmailStatus>;
    fn begin(&self, input: BeginEmailVerification) -> RemoteFuture<EmailVerificationStep>;
    fn resume(&self, input: ResumeEmailVerification) -> RemoteFuture<EmailVerificationStep>;
    fn confirm(&self, input: ConfirmEmailVerification) -> RemoteFuture<EmailVerificationStep>;
    fn retire(&self, input: RetireEmailVerification) -> RemoteFuture<EmailStatus>;
}
impl Access {
    async fn email_call<T, F, Fut>(&self, action: F) -> Result<T, Error>
    where
        F: FnOnce(rv_client::NativeClient) -> Fut,
        Fut: Future<Output = Result<T, rv_client::Error>>,
    {
        self.before(false).await?;
        if !self.session.email_supported() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let result = action(self.session.client.clone()).await?;
        self.check()?;
        Ok(result)
    }
}
impl NativeSession {
    pub fn email_supported(&self) -> bool {
        self.capabilities
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|c| c.reauthentication && c.reauthentication_retirement && c.email_verification)
    }
}
impl Remote for Access {
    fn status(&self) -> RemoteFuture<EmailStatus> {
        let access = self.clone();
        Box::pin(async move {
            let status = access.email_call(|client| async move { client.email_status().await }).await?;
            check_status(&access.scope, &status)?;
            Ok(status)
        })
    }
    fn begin(&self, input: BeginEmailVerification) -> RemoteFuture<EmailVerificationStep> {
        let access = self.clone();
        Box::pin(async move {
            access.email_call(|client| async move { client.begin_email_verification(&input).await }).await
        })
    }
    fn resume(&self, input: ResumeEmailVerification) -> RemoteFuture<EmailVerificationStep> {
        let access = self.clone();
        Box::pin(async move {
            access.email_call(|client| async move { client.resume_email_verification(&input).await }).await
        })
    }
    fn confirm(&self, input: ConfirmEmailVerification) -> RemoteFuture<EmailVerificationStep> {
        let access = self.clone();
        Box::pin(async move {
            access.email_call(|client| async move { client.confirm_email_verification(&input).await }).await
        })
    }
    fn retire(&self, input: RetireEmailVerification) -> RemoteFuture<EmailStatus> {
        let access = self.clone();
        Box::pin(async move {
            access.email_call(|client| async move { client.retire_email_verification(&input).await }).await
        })
    }
}
pub struct View {
    pub status: EmailStatus,
    pub state: State,
}
pub enum State {
    Idle,
    Pending { receipt_id: String, address: String, expires_at: String, delivery: EmailDeliveryState },
    Verified { receipt_id: String },
    Stale { receipt_id: String },
}
impl State {
    pub fn receipt(&self) -> Option<&str> {
        match self {
            Self::Idle => None,
            Self::Pending { receipt_id, .. } | Self::Verified { receipt_id } | Self::Stale { receipt_id } => {
                Some(receipt_id)
            }
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Accepted {
    version: String,
    head: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    scope: Scope,
    input: BeginEmailVerification,
    expires_at: Option<String>,
    accepted: Option<Accepted>,
}
fn normalized_address(value: &str) -> Result<String, Error> {
    let at = value.rfind('@').filter(|at| *at > 0 && *at + 1 < value.len());
    if value.len() > 254 || !value.bytes().all(|b| b.is_ascii_graphic()) || at.is_none() {
        return Err(Error::Protocol("invalid_email_address"));
    }
    let at = at.unwrap();
    Ok(format!("{}{}", &value[..=at], value[at + 1..].to_ascii_lowercase()))
}
fn date(value: &str) -> bool {
    value.len() <= 64 && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}
fn check_status(scope: &Scope, status: &EmailStatus) -> Result<(), Error> {
    let c = &status.context;
    scope.matches(&c.user_id, &c.device_id, &c.instance_id, &c.data_epoch)?;
    if !identifier(&status.version)
        || !identifier(&status.verification_version)
        || status.address.is_some() != status.verified_at.is_some()
        || status.verified_at.as_deref().is_some_and(|v| !date(v))
        || status.address.as_ref().is_some_and(|v| !normalized_address(v).is_ok_and(|address| address == *v))
    {
        return Err(invalid());
    }
    Ok(())
}
impl Record {
    fn validate(&self, scope: &Scope) -> Result<(), Error> {
        self.scope.validate()?;
        let input = &self.input;
        let c = &input.context;
        if self.scope != *scope
            || !nonce(&input.verification_id)
            || !nonce(&input.operation_id)
            || !identifier(&input.expected_version)
            || !identifier(&input.verification_version)
            || !normalized_address(&input.address).is_ok_and(|address| address == input.address)
            || self.expires_at.as_deref().is_some_and(|v| !date(v))
            || self.accepted.as_ref().is_some_and(|a| {
                !identifier(&a.version)
                    || !identifier(&a.head)
                    || a.version == input.expected_version
                    || a.head == input.verification_version
            })
        {
            return Err(invalid());
        }
        scope.matches(&c.user_id, &c.device_id, &c.instance_id, &c.data_epoch).map_err(|_| invalid())
    }
    fn resume(&self) -> ResumeEmailVerification {
        ResumeEmailVerification {
            verification_id: self.input.verification_id.clone(),
            operation_id: self.input.operation_id.clone(),
            context: self.scope.context(),
        }
    }
}
fn rejected(error: &Error) -> bool {
    matches!(error,Error::Network(rv_client::Error::Server{status:400,code,..}) if code=="email_verification_rejected")
}
fn conflict(error: &Error) -> bool {
    matches!(error,Error::Network(rv_client::Error::Server{status:409,code,..}) if code=="operation_conflict")
}
fn invalid_start(error: &Error) -> bool {
    matches!(error,Error::Network(rv_client::Error::Server{status:400,code,..}) if code=="invalid_request" || code=="invalid_email_address")
}
impl Vault {
    async fn read_email(
        &self,
        key: &str,
        scope: &Scope,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<Option<Record>, Error> {
        guard.check()?;
        let raw = self.storage.read(format!("{key}-email"), lease).await?;
        guard.check()?;
        raw.map(|raw| {
            if raw.len() > 8192 {
                return Err(invalid());
            }
            let record: Record = serde_json::from_str(&raw).map_err(|_| invalid())?;
            record.validate(scope)?;
            Ok(record)
        })
        .transpose()
    }
    async fn write_email(&self, key: &str, record: &Record, lease: Arc<File>, guard: &Guard) -> Result<(), Error> {
        record.validate(&record.scope)?;
        guard.check()?;
        self.storage
            .write(format!("{key}-email"), serde_json::to_string(record).map_err(|_| invalid())?, lease)
            .await?;
        guard.check()
    }
    async fn live_email(&self, scope: &Scope, remote: &dyn Remote, guard: &Guard) -> Result<EmailStatus, Error> {
        guard.check()?;
        let status = remote.status().await?;
        guard.check()?;
        check_status(scope, &status)?;
        Ok(status)
    }
    async fn received_email(
        &self,
        key: &str,
        mut saved: Record,
        result: EmailVerificationStep,
        remote: &dyn Remote,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<View, Error> {
        let status = self.live_email(&saved.scope, remote, guard).await?;
        let input = &saved.input;
        let state = match result {
            EmailVerificationStep::Verified { address, version } => {
                if address != input.address
                    || status.address.as_deref() != Some(&address)
                    || status.version != version
                    || status.verified_at.is_none()
                    || status.verification_version == input.verification_version
                {
                    return Err(Error::Protocol("credentials_changed"));
                }
                saved.accepted = Some(Accepted { version, head: status.verification_version.clone() });
                self.write_email(key, &saved, lease, guard).await?;
                State::Verified { receipt_id: saved.input.operation_id }
            }
            EmailVerificationStep::Pending {
                verification_id,
                operation_id,
                address,
                expires_at,
                expected_version,
                verification_version,
                delivery,
            } => {
                if verification_id != input.verification_id
                    || operation_id != input.operation_id
                    || address != input.address
                    || expected_version != input.expected_version
                    || verification_version != input.verification_version
                    || !date(&expires_at)
                    || saved.expires_at.as_ref().is_some_and(|v| v != &expires_at)
                {
                    return Err(invalid());
                }
                if status.version != expected_version || status.verification_version != verification_version {
                    return Ok(View { status, state: State::Stale { receipt_id: operation_id } });
                }
                if saved.expires_at.is_none() {
                    saved.expires_at = Some(expires_at.clone());
                    self.write_email(key, &saved, lease, guard).await?;
                }
                // Server expiry is authoritative; do not use the device clock.
                State::Pending { receipt_id: operation_id, address, expires_at, delivery }
            }
        };
        Ok(View { status, state })
    }
    async fn recover_email(
        &self,
        key: &str,
        scope: &Scope,
        remote: &dyn Remote,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<View, Error> {
        let status = self.live_email(scope, remote, guard).await?;
        let Some(saved) = self.read_email(key, scope, lease.clone(), guard).await? else {
            return Ok(View { status, state: State::Idle });
        };
        if let Some(a) = &saved.accepted {
            let current = status.version == a.version
                && status.verification_version == a.head
                && status.address.as_ref() == Some(&saved.input.address);
            let state = if current {
                State::Verified { receipt_id: saved.input.operation_id }
            } else {
                State::Stale { receipt_id: saved.input.operation_id }
            };
            return Ok(View { status, state });
        }
        guard.check()?;
        let result = match remote.resume(saved.resume()).await {
            Ok(result) => {
                guard.check()?;
                result
            }
            Err(error) => {
                guard.check()?;
                if !rejected(&error) {
                    return Err(error);
                }
                if saved.expires_at.is_some()
                    || status.version != saved.input.expected_version
                    || status.verification_version != saved.input.verification_version
                {
                    return Ok(View { status, state: State::Stale { receipt_id: saved.input.operation_id } });
                }
                match remote.begin(saved.input.clone()).await {
                    Ok(result) => {
                        guard.check()?;
                        result
                    }
                    Err(error) => {
                        guard.check()?;
                        if rejected(&error) || conflict(&error) || invalid_start(&error) {
                            return Ok(View { status, state: State::Stale { receipt_id: saved.input.operation_id } });
                        }
                        return Err(error);
                    }
                }
            }
        };
        self.received_email(key, saved, result, remote, lease, guard).await
    }
    pub async fn email_resume(&self, scope: &Scope, remote: &dyn Remote, guard: &Guard) -> Result<View, Error> {
        let scope = scope.clone();
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        self.recover_email(&key, &scope, remote, lease, guard).await
    }
    pub async fn email_start(
        &self,
        scope: &Scope,
        remote: &dyn Remote,
        address: &str,
        expected: &EmailStatus,
        guard: &Guard,
    ) -> Result<View, Error> {
        let scope = scope.clone();
        let expected = expected.clone();
        check_status(&scope, &expected)?;
        let address = normalized_address(address)?;
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        if self.read_email(&key, &scope, lease.clone(), guard).await?.is_some() {
            return self.recover_email(&key, &scope, remote, lease, guard).await;
        }
        let status = self.live_email(&scope, remote, guard).await?;
        if status.version != expected.version || status.verification_version != expected.verification_version {
            return Err(Error::Protocol("credentials_changed"));
        }
        let saved = Record {
            scope: scope.clone(),
            input: BeginEmailVerification {
                address,
                verification_id: random_token()?,
                operation_id: random_token()?,
                expected_version: status.version,
                verification_version: status.verification_version,
                context: scope.context(),
            },
            expires_at: None,
            accepted: None,
        };
        self.write_email(&key, &saved, lease.clone(), guard).await?;
        guard.check()?;
        match remote.begin(saved.input.clone()).await {
            Ok(result) => {
                guard.check()?;
                self.received_email(&key, saved, result, remote, lease, guard).await
            }
            Err(error) => {
                guard.check()?;
                if !invalid_start(&error) {
                    return Err(error);
                }
                let status = self.live_email(&scope, remote, guard).await?;
                Ok(View { status, state: State::Stale { receipt_id: saved.input.operation_id } })
            }
        }
    }
    pub async fn email_confirm(
        &self,
        scope: &Scope,
        remote: &dyn Remote,
        receipt: &str,
        code: &str,
        guard: &Guard,
    ) -> Result<View, Error> {
        let scope = scope.clone();
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        let saved =
            self.read_email(&key, &scope, lease.clone(), guard).await?.ok_or(Error::Protocol("credentials_changed"))?;
        if saved.input.operation_id != receipt {
            return Err(Error::Protocol("credentials_changed"));
        }
        let view = self.recover_email(&key, &scope, remote, lease.clone(), guard).await?;
        if !matches!(view.state, State::Pending { .. }) {
            return Ok(view);
        }
        if code.len() != 8 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::Protocol("email_verification_rejected"));
        }
        let saved =
            self.read_email(&key, &scope, lease.clone(), guard).await?.ok_or(Error::Protocol("credentials_changed"))?;
        let original = saved.resume();
        guard.check()?;
        let result = remote
            .confirm(ConfirmEmailVerification {
                verification_id: original.verification_id,
                operation_id: original.operation_id,
                context: original.context,
                code: code.into(),
            })
            .await?;
        guard.check()?;
        if !matches!(result, EmailVerificationStep::Verified { .. }) {
            return Err(invalid());
        }
        self.received_email(&key, saved, result, remote, lease, guard).await
    }
    pub async fn email_cancel(
        &self,
        scope: &Scope,
        remote: &dyn Remote,
        receipt: &str,
        guard: &Guard,
    ) -> Result<View, Error> {
        let scope = scope.clone();
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        self.live_email(&scope, remote, guard).await?;
        let saved =
            self.read_email(&key, &scope, lease.clone(), guard).await?.ok_or(Error::Protocol("credentials_changed"))?;
        if saved.input.operation_id != receipt {
            return Err(Error::Protocol("credentials_changed"));
        }
        guard.check()?;
        let status = remote
            .retire(RetireEmailVerification {
                context: scope.context(),
                expected_version: saved.input.expected_version.clone(),
                verification_version: saved.input.verification_version.clone(),
            })
            .await?;
        guard.check()?;
        check_status(&scope, &status)?;
        if status.verification_version == saved.input.verification_version {
            return Err(invalid());
        }
        match remote.resume(saved.resume()).await {
            Ok(result) => {
                guard.check()?;
                if !matches!(result, EmailVerificationStep::Verified { .. }) {
                    return Err(invalid());
                }
                return self.received_email(&key, saved, result, remote, lease, guard).await;
            }
            Err(error) => {
                guard.check()?;
                if !rejected(&error) {
                    return Err(error);
                }
            }
        }
        self.storage.remove(format!("{key}-email"), lease).await?;
        guard.check()?;
        Ok(View { status, state: State::Idle })
    }
    pub async fn email_acknowledge(
        &self,
        scope: &Scope,
        remote: &dyn Remote,
        receipt: &str,
        guard: &Guard,
    ) -> Result<View, Error> {
        let scope = scope.clone();
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        let status = self.live_email(&scope, remote, guard).await?;
        let saved =
            self.read_email(&key, &scope, lease.clone(), guard).await?.ok_or(Error::Protocol("credentials_changed"))?;
        if saved.input.operation_id != receipt || saved.accepted.is_none() {
            return Err(Error::Protocol("credentials_changed"));
        }
        self.storage.remove(format!("{key}-email"), lease).await?;
        guard.check()?;
        Ok(View { status, state: State::Idle })
    }
}
