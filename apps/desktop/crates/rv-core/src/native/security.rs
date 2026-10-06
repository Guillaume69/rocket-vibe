//! Private settings operations on the current native family. GTK and SwiftUI
//! share intent keys, an OS lease spanning HTTP, and fallible trousseau storage.
pub mod email;
mod email_settings;
mod factor_email;
use super::{Error, NativeSession, authentication::method_name, authentication_vault::Storage};
pub use email_settings::EmailFactorExpectation;
use rv_protocol::parity::*;
pub use rv_protocol::parity::{FactorSetup as Setup, FactorStatus as Status};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub type RemoteFuture<T> = Pin<Box<dyn Future<Output = Result<T, Error>> + Send>>;
pub trait Remote: Send + Sync {
    fn status(&self) -> RemoteFuture<ReauthenticationStatus>;
    fn begin(&self, input: BeginReauthentication) -> RemoteFuture<ReauthenticationStep>;
    fn resume(&self, input: ResumeReauthentication) -> RemoteFuture<ReauthenticationStep>;
    fn finish(&self, input: FinishReauthentication) -> RemoteFuture<ReauthenticationGrant>;
    fn retire(&self, input: RetireReauthentication) -> RemoteFuture<ReauthenticationStatus>;
    fn factor_status(&self) -> RemoteFuture<FactorStatus>;
    fn setup(&self, input: BeginFactorSetup) -> RemoteFuture<FactorSetup>;
    fn enable(&self, input: EnableFactor) -> RemoteFuture<FactorBackupCodes>;
    fn regenerate(&self, input: RegenerateFactorBackups) -> RemoteFuture<FactorBackupCodes>;
    fn disable(&self, input: DisableFactor) -> RemoteFuture<()>;
    fn contact_status(&self) -> RemoteFuture<EmailStatus> {
        Box::pin(async { Err(Error::Protocol("unsupported_feature")) })
    }
    fn change_email_factor(&self, _input: ChangeEmailFactor, _enabled: bool) -> RemoteFuture<EmailFactorChange> {
        Box::pin(async { Err(Error::Protocol("unsupported_feature")) })
    }
    fn email_begin(&self, _input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        Box::pin(async { Err(Error::Protocol("unsupported_feature")) })
    }
    fn email_resume(&self, _input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        Box::pin(async { Err(Error::Protocol("unsupported_feature")) })
    }
}

/// A UI closes this guard on dismissal or account change. It can cross the
/// Tokio/GTK/FFI seam without retaining any widget or main-thread reference.
#[derive(Clone)]
pub struct Guard(Arc<AtomicBool>);
impl Default for Guard {
    fn default() -> Self {
        Self::new()
    }
}
impl Guard {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(true)))
    }
    pub fn cancel(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
    pub fn alive(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    pub fn check(&self) -> Result<(), Error> {
        if self.alive() { Ok(()) } else { Err(Error::Protocol("session_closed")) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    base_url: String,
    user_id: String,
    device_id: String,
    instance_id: String,
    data_epoch: String,
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn nonce(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn invalid() -> Error {
    Error::Protocol("invalid_native_security")
}
use super::credentials::token as random_token;
impl Scope {
    pub fn new(base: &str, context: ReauthenticationContext) -> Result<Self, Error> {
        rv_client::NativeClient::new(base)?;
        let scope = Self {
            base_url: url::Url::parse(base).map_err(|_| invalid())?.as_str().trim_end_matches('/').into(),
            user_id: context.user_id,
            device_id: context.device_id,
            instance_id: context.instance_id,
            data_epoch: context.data_epoch,
        };
        if [&scope.user_id, &scope.device_id, &scope.instance_id, &scope.data_epoch].iter().any(|id| !identifier(id)) {
            return Err(invalid());
        }
        Ok(scope)
    }
    pub fn context(&self) -> ReauthenticationContext {
        ReauthenticationContext {
            user_id: self.user_id.clone(),
            device_id: self.device_id.clone(),
            instance_id: self.instance_id.clone(),
            data_epoch: self.data_epoch.clone(),
        }
    }
    fn validate(&self) -> Result<(), Error> {
        if Self::new(&self.base_url, self.context())? == *self { Ok(()) } else { Err(invalid()) }
    }
    fn matches(&self, user: &str, device: &str, instance: &str, epoch: &str) -> Result<(), Error> {
        if self.user_id == user && self.device_id == device && self.instance_id == instance && self.data_epoch == epoch
        {
            Ok(())
        } else {
            Err(Error::Protocol("server_identity_changed"))
        }
    }
    fn status(&self, value: &ReauthenticationStatus) -> Result<(), Error> {
        self.matches(&value.user_id, &value.device_id, &value.instance_id, &value.data_epoch)?;
        if !identifier(&value.proof_version) {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn key(&self) -> Result<String, Error> {
        self.validate()?;
        let tuple = serde_json::to_vec(&(
            "native-security-v1",
            &self.base_url,
            &self.user_id,
            &self.device_id,
            &self.instance_id,
            &self.data_epoch,
        ))
        .map_err(|_| invalid())?;
        let digest = Sha256::digest(tuple).iter().map(|b| format!("{b:02x}")).collect::<String>();
        Ok(format!("native-security-{digest}"))
    }
}

/// Every request rechecks this runner generation before and after discovery /
/// HTTP. It shares the rotating NativeClient and never saves a credential.
#[derive(Clone)]
pub struct Access {
    session: Arc<NativeSession>,
    generation: u64,
    guard: Guard,
    scope: Scope,
}
impl Access {
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub fn guard(&self) -> Guard {
        self.guard.clone()
    }
    pub fn check(&self) -> Result<(), Error> {
        self.guard.check()?;
        if self.generation != self.session.security_generation.load(Ordering::SeqCst) {
            return Err(Error::Protocol("session_closed"));
        }
        self.session.ready()
    }
    async fn before(&self, factor: bool) -> Result<(), Error> {
        self.check()?;
        self.session.identity().await?;
        self.check()?;
        if !self
            .session
            .capabilities
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|c| c.reauthentication && c.reauthentication_retirement && (!factor || c.second_factors))
        {
            return Err(Error::Protocol("unsupported_feature"));
        }
        Ok(())
    }
    async fn call<T, F, Fut>(&self, factor: bool, action: F) -> Result<T, Error>
    where
        F: FnOnce(rv_client::NativeClient) -> Fut,
        Fut: Future<Output = Result<T, rv_client::Error>>,
    {
        self.before(factor).await?;
        let result = action(self.session.client.clone()).await?;
        self.check()?;
        Ok(result)
    }
}
macro_rules! remote_call {
    ($name:ident,$input:ty,$output:ty,$method:ident,$factor:expr) => {
        fn $name(&self, input: $input) -> RemoteFuture<$output> {
            let access = self.clone();
            Box::pin(async move { access.call($factor, |client| async move { client.$method(&input).await }).await })
        }
    };
}
impl Remote for Access {
    fn status(&self) -> RemoteFuture<ReauthenticationStatus> {
        let access = self.clone();
        Box::pin(async move {
            let status = access.call(false, |client| async move { client.reauthentication_status().await }).await?;
            access.scope.status(&status)?;
            Ok(status)
        })
    }
    remote_call!(begin, BeginReauthentication, ReauthenticationStep, begin_reauthentication, false);
    remote_call!(resume, ResumeReauthentication, ReauthenticationStep, resume_reauthentication, false);
    remote_call!(finish, FinishReauthentication, ReauthenticationGrant, finish_reauthentication, false);
    remote_call!(retire, RetireReauthentication, ReauthenticationStatus, retire_reauthentication, false);
    fn factor_status(&self) -> RemoteFuture<FactorStatus> {
        let access = self.clone();
        Box::pin(async move { access.call(false, |client| async move { client.factor_status().await }).await })
    }
    remote_call!(setup, BeginFactorSetup, FactorSetup, begin_factor_setup, true);
    remote_call!(enable, EnableFactor, FactorBackupCodes, enable_factor, true);
    remote_call!(regenerate, RegenerateFactorBackups, FactorBackupCodes, regenerate_factor_backups, true);
    remote_call!(disable, DisableFactor, (), disable_factor, true);
    fn contact_status(&self) -> RemoteFuture<EmailStatus> {
        <Self as email::Remote>::status(self)
    }
    fn change_email_factor(&self, input: ChangeEmailFactor, enabled: bool) -> RemoteFuture<EmailFactorChange> {
        let access = self.clone();
        Box::pin(async move {
            access.before(false).await?;
            if !access.session.email_factors_supported() {
                return Err(Error::Protocol("unsupported_feature"));
            }
            // Replay is available without SMTP; the server gates a new enable.
            let result = if enabled {
                access.session.client.enable_email_factor(&input).await?
            } else {
                access.session.client.disable_email_factor(&input).await?
            };
            access.check()?;
            Ok(result)
        })
    }
    fn email_begin(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        let access = self.clone();
        Box::pin(async move { access.factor_email_call(input, true).await })
    }
    fn email_resume(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        let access = self.clone();
        Box::pin(async move { access.factor_email_call(input, false).await })
    }
}
impl NativeSession {
    pub fn security_supported(&self) -> bool {
        self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.reauthentication && c.reauthentication_retirement)
    }
    pub fn factors_supported(&self) -> bool {
        self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.second_factors)
    }
    pub async fn security(self: &Arc<Self>, guard: Guard) -> Result<Access, Error> {
        self.ready()?;
        guard.check()?;
        let generation = self.security_generation.load(Ordering::SeqCst);
        self.refresh_credentials().await?;
        if self.security_generation.load(Ordering::SeqCst) != generation {
            return Err(Error::Protocol("session_closed"));
        }
        self.ready()?;
        guard.check()?;
        let identity = self.info.native.as_ref().ok_or_else(invalid)?;
        let mut access = Access {
            session: self.clone(),
            generation,
            guard,
            scope: Scope::new(
                &self.info.base_url,
                ReauthenticationContext {
                    user_id: self.info.user_id.clone(),
                    device_id: "unresolved".into(),
                    instance_id: identity.instance_id.clone(),
                    data_epoch: identity.data_epoch.clone(),
                },
            )?,
        };
        let status = access.call(false, |client| async move { client.reauthentication_status().await }).await?;
        access.scope = Scope::new(
            &self.info.base_url,
            ReauthenticationContext {
                user_id: self.info.user_id.clone(),
                device_id: status.device_id.clone(),
                instance_id: identity.instance_id.clone(),
                data_epoch: identity.data_epoch.clone(),
            },
        )?;
        access.scope.status(&status)?;
        Ok(access)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProofAttempt {
    scope: Scope,
    challenge_id: String,
    operation_id: String,
    proof_version: String,
    challenge: Option<AuthChallenge>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::factor_email::private_intent"
    )]
    email: Option<super::factor_email::Intent>,
}
impl ProofAttempt {
    pub fn challenge(&self) -> Option<&AuthChallenge> {
        self.challenge.as_ref()
    }
    pub fn email(&self) -> Option<&super::factor_email::Intent> {
        self.email.as_ref()
    }
    fn validate(&self, scope: &Scope) -> Result<(), Error> {
        self.scope.validate()?;
        if self.scope != *scope
            || !nonce(&self.challenge_id)
            || !nonce(&self.operation_id)
            || !identifier(&self.proof_version)
            || self.challenge.as_ref().is_some_and(|c| {
                c.challenge_id != self.challenge_id
                    || c.methods.is_empty()
                    || c.methods.len() > 3
                    || chrono::DateTime::parse_from_rfc3339(&c.expires_at).is_err()
            })
        {
            return Err(invalid());
        }
        if let Some(email) = &self.email {
            email.validate(self.challenge.as_ref().ok_or_else(invalid)?)?;
        }
        Ok(())
    }
    fn resume(&self) -> ResumeReauthentication {
        ResumeReauthentication { challenge_id: self.challenge_id.clone(), operation_id: self.operation_id.clone() }
    }
}
pub enum ProofState {
    Ready,
    Password,
    Challenge(Box<ProofAttempt>),
}
pub enum FactorState {
    Idle,
    Setup(Box<FactorSetup>),
    Codes { receipt_id: String, codes: FactorBackupCodes },
    Stale { receipt_id: String },
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum FactorIntent {
    Setup { operation_id: String, setup: Option<FactorSetup>, enable_operation_id: Option<String> },
    Regenerate { operation_id: String, factor_version: String },
    Disable { operation_id: String, factor_version: String },
    Email { operation_id: String, email_version: String, factor_version: Option<String>, enabled: bool },
    Codes { operation_id: String, factor_version: String, codes: FactorBackupCodes },
}
impl FactorIntent {
    fn operation(&self) -> &str {
        match self {
            Self::Setup { operation_id, .. }
            | Self::Regenerate { operation_id, .. }
            | Self::Disable { operation_id, .. }
            | Self::Email { operation_id, .. }
            | Self::Codes { operation_id, .. } => operation_id,
        }
    }
    fn validate(&self) -> Result<(), Error> {
        if !nonce(self.operation()) {
            return Err(invalid());
        }
        match self {
            Self::Setup { setup, enable_operation_id, .. } => {
                if enable_operation_id.as_ref().is_some_and(|id| !nonce(id))
                    || setup.as_ref().is_some_and(|s| {
                        !identifier(&s.setup_id)
                            || s.secret.is_empty()
                            || s.secret.len() > 128
                            || s.provisioning_uri.len() > 2048
                            || !s.provisioning_uri.starts_with("otpauth://totp/")
                            || chrono::DateTime::parse_from_rfc3339(&s.expires_at).is_err()
                    })
                {
                    return Err(invalid());
                }
            }
            Self::Regenerate { factor_version, .. } | Self::Disable { factor_version, .. } => {
                if !identifier(factor_version) {
                    return Err(invalid());
                }
            }
            Self::Email { email_version, factor_version, .. } => {
                if !identifier(email_version) || factor_version.as_ref().is_some_and(|v| !identifier(v)) {
                    return Err(invalid());
                }
            }
            Self::Codes { factor_version, codes, .. } => {
                if !identifier(factor_version)
                    || codes.factor_version.as_deref() != Some(factor_version)
                    || codes.codes.len() != 10
                    || codes.codes.iter().any(|c| c.is_empty() || c.len() > 128)
                {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FactorRecord {
    scope: Scope,
    intent: FactorIntent,
}
#[derive(Clone, Copy)]
pub enum FactorAction {
    Setup,
    Regenerate,
    Disable,
}
#[derive(Clone)]
pub struct Vault {
    config: PathBuf,
    storage: Arc<dyn Storage>,
}
impl Vault {
    pub fn new(config: PathBuf, storage: Arc<dyn Storage>) -> Self {
        Self { config, storage }
    }
    async fn lease(&self, key: &str, guard: &Guard) -> Result<Arc<File>, Error> {
        guard.check()?;
        std::fs::create_dir_all(&self.config).map_err(|_| Error::Protocol("secure_storage_unavailable"))?;
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.config.join(format!("{key}.lock")))
            .map_err(|_| Error::Protocol("secure_storage_unavailable"))?;
        loop {
            guard.check()?;
            match file.try_lock() {
                Ok(()) => return Ok(Arc::new(file)),
                Err(std::fs::TryLockError::WouldBlock) => {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await
                }
                Err(_) => return Err(Error::Protocol("secure_storage_unavailable")),
            }
        }
    }
    async fn read_proof(
        &self,
        key: &str,
        scope: &Scope,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<Option<ProofAttempt>, Error> {
        guard.check()?;
        let raw = self.storage.read(format!("{key}-reauth"), lease).await?;
        guard.check()?;
        raw.map(|raw| {
            let value: ProofAttempt = serde_json::from_str(&raw).map_err(|_| invalid())?;
            value.validate(scope)?;
            Ok(value)
        })
        .transpose()
    }
    async fn write_proof(&self, key: &str, value: &ProofAttempt, lease: Arc<File>, guard: &Guard) -> Result<(), Error> {
        value.validate(&value.scope)?;
        guard.check()?;
        self.storage
            .write(format!("{key}-reauth"), serde_json::to_string(value).map_err(|_| invalid())?, lease)
            .await?;
        guard.check()
    }
    async fn status(&self, scope: &Scope, remote: &dyn Remote, guard: &Guard) -> Result<ReauthenticationStatus, Error> {
        guard.check()?;
        let status = remote.status().await?;
        guard.check()?;
        scope.status(&status)?;
        Ok(status)
    }
    async fn probe(
        &self,
        saved: &ProofAttempt,
        remote: &dyn Remote,
        guard: &Guard,
    ) -> Result<Option<ReauthenticationStep>, Error> {
        guard.check()?;
        let result = remote.resume(saved.resume()).await;
        guard.check()?;
        match result {
            Err(Error::Network(rv_client::Error::Server { status: 404, ref code, .. }))
                if code == "reauthentication_not_found" =>
            {
                Ok(None)
            }
            Err(Error::Network(rv_client::Error::Server { status: 400, ref code, .. }))
                if code == "reauthentication_rejected" =>
            {
                Ok(None)
            }
            result => result.map(Some),
        }
    }
    async fn accepted(
        &self,
        key: &str,
        saved: &ProofAttempt,
        grant: ReauthenticationGrant,
        remote: &dyn Remote,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<ProofState, Error> {
        saved.scope.matches(&grant.user_id, &grant.device_id, &grant.instance_id, &grant.data_epoch)?;
        let status = self.status(&saved.scope, remote, guard).await?;
        if !status.recent || status.proof_version != grant.proof_version {
            return Err(Error::Protocol("credentials_changed"));
        }
        guard.check()?;
        self.storage.remove(format!("{key}-reauth"), lease).await?;
        guard.check()?;
        Ok(ProofState::Ready)
    }
    async fn challenge(
        &self,
        key: &str,
        mut saved: ProofAttempt,
        mut challenge: AuthChallenge,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<ProofState, Error> {
        if saved.email.is_some() {
            let old = saved.challenge.as_ref().ok_or_else(invalid)?;
            if old.challenge_id != challenge.challenge_id
                || !super::factor_email::same_deadline(&old.expires_at, &challenge.expires_at)
            {
                return Err(invalid());
            }
            // An already delivered code remains usable if SMTP disappears.
            // Never advertise email for a new challenge on that authority.
            if !challenge.methods.iter().any(|m| matches!(m, SecondFactor::Email)) {
                challenge.methods.push(SecondFactor::Email);
            }
        }
        saved.challenge = Some(challenge);
        self.write_proof(key, &saved, lease, guard).await?;
        Ok(ProofState::Challenge(Box::new(saved)))
    }
    pub async fn prepare(
        &self,
        scope: &Scope,
        remote: &dyn Remote,
        password: &str,
        guard: &Guard,
    ) -> Result<ProofState, Error> {
        let scope = scope.clone();
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        let mut status = self.status(&scope, remote, guard).await?;
        if let Some(saved) = self.read_proof(&key, &scope, lease.clone(), guard).await? {
            match self.probe(&saved, remote, guard).await? {
                Some(ReauthenticationStep::Granted { grant }) => {
                    return self.accepted(&key, &saved, grant, remote, lease, guard).await;
                }
                Some(ReauthenticationStep::Challenge { challenge }) => {
                    return self.challenge(&key, saved, challenge, lease, guard).await;
                }
                None => {}
            }
            guard.check()?;
            status = remote
                .retire(RetireReauthentication { context: scope.context(), proof_version: saved.proof_version.clone() })
                .await?;
            guard.check()?;
            scope.status(&status)?;
            if status.proof_version == saved.proof_version {
                return Err(invalid());
            }
            match self.probe(&saved, remote, guard).await? {
                Some(ReauthenticationStep::Granted { grant }) => {
                    return self.accepted(&key, &saved, grant, remote, lease, guard).await;
                }
                Some(_) => return Err(invalid()),
                None => {}
            }
            guard.check()?;
            self.storage.remove(format!("{key}-reauth"), lease.clone()).await?;
            guard.check()?;
        }
        if status.recent {
            return Ok(ProofState::Ready);
        }
        if password.is_empty() {
            return Ok(ProofState::Password);
        }
        if password.len() > 1024 {
            return Err(invalid());
        }
        let saved = ProofAttempt {
            scope,
            challenge_id: random_token()?,
            operation_id: random_token()?,
            proof_version: status.proof_version,
            challenge: None,
            email: None,
        };
        self.write_proof(&key, &saved, lease.clone(), guard).await?;
        guard.check()?;
        let result = remote
            .begin(BeginReauthentication {
                password: password.into(),
                challenge_id: saved.challenge_id.clone(),
                operation_id: saved.operation_id.clone(),
                proof_version: saved.proof_version.clone(),
                context: Some(saved.scope.context()),
            })
            .await?;
        guard.check()?;
        match result {
            ReauthenticationStep::Granted { grant } => self.accepted(&key, &saved, grant, remote, lease, guard).await,
            ReauthenticationStep::Challenge { challenge } => self.challenge(&key, saved, challenge, lease, guard).await,
        }
    }
    pub async fn finish(
        &self,
        expected: &ProofAttempt,
        remote: &dyn Remote,
        method: SecondFactor,
        code: &str,
        guard: &Guard,
    ) -> Result<ProofState, Error> {
        let expected = expected.clone();
        expected.validate(&expected.scope)?;
        let key = expected.scope.key()?;
        let lease = self.lease(&key, guard).await?;
        self.status(&expected.scope, remote, guard).await?;
        let saved = self
            .read_proof(&key, &expected.scope, lease.clone(), guard)
            .await?
            .ok_or(Error::Protocol("credentials_changed"))?;
        if saved.challenge_id != expected.challenge_id || saved.operation_id != expected.operation_id {
            return Err(Error::Protocol("credentials_changed"));
        }
        let live = match self.probe(&saved, remote, guard).await? {
            Some(ReauthenticationStep::Granted { grant }) => {
                return self.accepted(&key, &saved, grant, remote, lease, guard).await;
            }
            Some(ReauthenticationStep::Challenge { challenge }) => challenge,
            None => return Err(Error::Protocol("reauthentication_rejected")),
        };
        let delivered_email = matches!(method, SecondFactor::Email)
            && saved.email.is_some()
            && saved.challenge.as_ref().is_some_and(|old| {
                old.challenge_id == live.challenge_id
                    && super::factor_email::same_deadline(&old.expires_at, &live.expires_at)
            });
        if code.is_empty()
            || code.len() > 128
            || (!delivered_email && !live.methods.iter().any(|m| method_name(*m) == method_name(method)))
        {
            return Err(Error::Protocol("reauthentication_rejected"));
        }
        guard.check()?;
        let grant = remote
            .finish(FinishReauthentication {
                challenge_id: saved.challenge_id.clone(),
                operation_id: saved.operation_id.clone(),
                method,
                code: code.into(),
            })
            .await?;
        guard.check()?;
        self.accepted(&key, &saved, grant, remote, lease, guard).await
    }
    async fn read_factor(
        &self,
        key: &str,
        scope: &Scope,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<Option<FactorRecord>, Error> {
        guard.check()?;
        let raw = self.storage.read(format!("{key}-factors"), lease).await?;
        guard.check()?;
        raw.map(|raw| {
            let value: FactorRecord = serde_json::from_str(&raw).map_err(|_| invalid())?;
            value.scope.validate()?;
            value.intent.validate()?;
            if value.scope != *scope {
                return Err(invalid());
            }
            Ok(value)
        })
        .transpose()
    }
    async fn write_factor(
        &self,
        key: &str,
        scope: &Scope,
        intent: FactorIntent,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<(), Error> {
        intent.validate()?;
        guard.check()?;
        let raw = serde_json::to_string(&FactorRecord { scope: scope.clone(), intent }).map_err(|_| invalid())?;
        self.storage.write(format!("{key}-factors"), raw, lease).await?;
        guard.check()
    }
    async fn factor_status(&self, scope: &Scope, remote: &dyn Remote, guard: &Guard) -> Result<FactorStatus, Error> {
        self.status(scope, remote, guard).await?;
        guard.check()?;
        let status = remote.factor_status().await?;
        guard.check()?;
        Ok(status)
    }
    async fn bag(
        &self,
        key: &str,
        scope: &Scope,
        (operation, codes): (String, FactorBackupCodes),
        remote: &dyn Remote,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<FactorState, Error> {
        let status = self.factor_status(scope, remote, guard).await?;
        let version = codes.factor_version.clone().filter(|v| identifier(v)).ok_or_else(invalid)?;
        let stale = !(status.totp || status.email) || status.factor_version.as_deref() != Some(&version);
        let result = if stale {
            FactorState::Stale { receipt_id: operation.clone() }
        } else {
            FactorState::Codes { receipt_id: operation.clone(), codes: codes.clone() }
        };
        self.write_factor(
            key,
            scope,
            FactorIntent::Codes { operation_id: operation, factor_version: version, codes },
            lease,
            guard,
        )
        .await?;
        Ok(result)
    }
    async fn recover_factor(
        &self,
        key: &str,
        scope: &Scope,
        remote: &dyn Remote,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<FactorState, Error> {
        let status = self.factor_status(scope, remote, guard).await?;
        let Some(saved) = self.read_factor(key, scope, lease.clone(), guard).await? else {
            return Ok(FactorState::Idle);
        };
        match saved.intent {
            FactorIntent::Codes { operation_id, factor_version, codes } => {
                if status.factor_version.as_deref() != Some(&factor_version) {
                    Ok(FactorState::Stale { receipt_id: operation_id })
                } else {
                    Ok(FactorState::Codes { receipt_id: operation_id, codes })
                }
            }
            FactorIntent::Disable { operation_id, factor_version } => {
                if status.totp {
                    if status.factor_version.as_deref() != Some(&factor_version) {
                        return Ok(FactorState::Stale { receipt_id: operation_id });
                    }
                    guard.check()?;
                    remote.disable(DisableFactor { factor_version }).await?;
                    guard.check()?;
                }
                self.storage.remove(format!("{key}-factors"), lease).await?;
                guard.check()?;
                Ok(FactorState::Idle)
            }
            FactorIntent::Email { operation_id, email_version, factor_version, enabled } => {
                self.recover_email_factor(
                    key,
                    scope,
                    (
                        ChangeEmailFactor { operation_id, email_version, factor_version, context: scope.context() },
                        enabled,
                    ),
                    remote,
                    lease,
                    guard,
                )
                .await
            }
            FactorIntent::Regenerate { operation_id, factor_version } => {
                guard.check()?;
                match remote
                    .regenerate(RegenerateFactorBackups {
                        operation_id: operation_id.clone(),
                        factor_version: factor_version.clone(),
                    })
                    .await
                {
                    Ok(codes) => {
                        guard.check()?;
                        self.bag(key, scope, (operation_id, codes), remote, lease, guard).await
                    }
                    Err(Error::Network(rv_client::Error::Server { status: 409, .. })) => {
                        guard.check()?;
                        if self.factor_status(scope, remote, guard).await?.factor_version.as_deref()
                            != Some(&factor_version)
                        {
                            Ok(FactorState::Stale { receipt_id: operation_id })
                        } else {
                            Err(Error::Protocol("credentials_changed"))
                        }
                    }
                    Err(e) => Err(e),
                }
            }
            FactorIntent::Setup { operation_id, setup, enable_operation_id } => {
                if status.totp {
                    if let (Some(setup), Some(operation)) = (&setup, &enable_operation_id) {
                        guard.check()?;
                        return match remote
                            .enable(EnableFactor {
                                setup_id: setup.setup_id.clone(),
                                operation_id: operation.clone(),
                                code: String::new(),
                            })
                            .await
                        {
                            Ok(codes) => {
                                guard.check()?;
                                self.bag(key, scope, (operation.clone(), codes), remote, lease, guard).await
                            }
                            Err(Error::Network(rv_client::Error::Server { status: 400, ref code, .. }))
                                if code == "factor_rejected" =>
                            {
                                guard.check()?;
                                Ok(FactorState::Stale { receipt_id: operation_id })
                            }
                            Err(e) => Err(e),
                        };
                    }
                    return Ok(FactorState::Stale { receipt_id: operation_id });
                }
                guard.check()?;
                let fresh = remote.setup(BeginFactorSetup { operation_id: operation_id.clone() }).await?;
                guard.check()?;
                let same = setup.as_ref().is_some_and(|s| s.setup_id == fresh.setup_id);
                self.write_factor(
                    key,
                    scope,
                    FactorIntent::Setup {
                        operation_id,
                        setup: Some(fresh.clone()),
                        enable_operation_id: if same { enable_operation_id } else { None },
                    },
                    lease,
                    guard,
                )
                .await?;
                Ok(FactorState::Setup(Box::new(fresh)))
            }
        }
    }
    pub async fn factor_resume(&self, scope: &Scope, remote: &dyn Remote, guard: &Guard) -> Result<FactorState, Error> {
        let scope = scope.clone();
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        self.recover_factor(&key, &scope, remote, lease, guard).await
    }
    pub async fn factor_start(
        &self,
        scope: &Scope,
        remote: &dyn Remote,
        action: FactorAction,
        guard: &Guard,
    ) -> Result<FactorState, Error> {
        let scope = scope.clone();
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        if self.read_factor(&key, &scope, lease.clone(), guard).await?.is_none() {
            let status = self.factor_status(&scope, remote, guard).await?;
            let operation_id = random_token()?;
            let intent = match action {
                FactorAction::Setup => {
                    if status.totp {
                        return Err(Error::Protocol("credentials_changed"));
                    }
                    FactorIntent::Setup { operation_id, setup: None, enable_operation_id: None }
                }
                FactorAction::Regenerate | FactorAction::Disable => {
                    let installed = if matches!(action, FactorAction::Regenerate) {
                        status.totp || status.email
                    } else {
                        status.totp
                    };
                    let factor_version = status
                        .factor_version
                        .filter(|v| installed && identifier(v))
                        .ok_or(Error::Protocol("credentials_changed"))?;
                    if matches!(action, FactorAction::Regenerate) {
                        FactorIntent::Regenerate { operation_id, factor_version }
                    } else {
                        FactorIntent::Disable { operation_id, factor_version }
                    }
                }
            };
            self.write_factor(&key, &scope, intent, lease.clone(), guard).await?;
        }
        self.recover_factor(&key, &scope, remote, lease, guard).await
    }
    pub async fn factor_enable(
        &self,
        scope: &Scope,
        remote: &dyn Remote,
        expected: &FactorSetup,
        code: &str,
        guard: &Guard,
    ) -> Result<FactorState, Error> {
        let scope = scope.clone();
        let expected = expected.clone();
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        let status = self.factor_status(&scope, remote, guard).await?;
        let saved = self
            .read_factor(&key, &scope, lease.clone(), guard)
            .await?
            .ok_or(Error::Protocol("credentials_changed"))?;
        if matches!(saved.intent, FactorIntent::Codes { .. }) {
            return self.recover_factor(&key, &scope, remote, lease, guard).await;
        }
        let FactorIntent::Setup { operation_id, setup, enable_operation_id } = saved.intent else {
            return Err(Error::Protocol("credentials_changed"));
        };
        if setup.as_ref().is_none_or(|s| s.setup_id != expected.setup_id) {
            return Err(Error::Protocol("credentials_changed"));
        }
        if status.totp {
            return self.recover_factor(&key, &scope, remote, lease, guard).await;
        }
        if code.is_empty() || code.len() > 128 {
            return Err(Error::Protocol("factor_rejected"));
        }
        let operation = match enable_operation_id {
            Some(op) => op,
            None => random_token()?,
        };
        self.write_factor(
            &key,
            &scope,
            FactorIntent::Setup { operation_id, setup, enable_operation_id: Some(operation.clone()) },
            lease.clone(),
            guard,
        )
        .await?;
        guard.check()?;
        let codes = remote
            .enable(EnableFactor { setup_id: expected.setup_id, operation_id: operation.clone(), code: code.into() })
            .await?;
        guard.check()?;
        self.bag(&key, &scope, (operation, codes), remote, lease, guard).await
    }
    pub async fn factor_clear(&self, scope: &Scope, receipt: &str, guard: &Guard) -> Result<bool, Error> {
        let scope = scope.clone();
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        let Some(saved) = self.read_factor(&key, &scope, lease.clone(), guard).await? else { return Ok(true) };
        if saved.intent.operation() != receipt {
            return Ok(false);
        }
        guard.check()?;
        self.storage.remove(format!("{key}-factors"), lease).await?;
        guard.check()?;
        Ok(true)
    }
}
