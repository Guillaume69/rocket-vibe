//! Anonymous recovery delivery belongs in a separate system vault. Its opaque
//! intent is never a session, a password, a received code or proof of delivery.
use super::{Error, Identity, authentication_vault::Storage, check, credentials, security::Guard};
use chrono::Utc;
use rv_client::NativeClient;
use rv_protocol::{Discovery, parity::RequestEmailRecovery};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::File, path::PathBuf, sync::Arc};

fn invalid() -> Error {
    Error::Protocol("invalid_native_recovery")
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn canonical(base: &str) -> Result<String, Error> {
    NativeClient::new(base)?;
    Ok(url::Url::parse(base).map_err(|_| invalid())?.as_str().trim_end_matches('/').into())
}
/// Shared GTK/Swift key, excluded from active account and authentication indexes.
pub fn key(base: &str, username: &str) -> Result<String, Error> {
    if !identifier(username) {
        return Err(invalid());
    }
    let tuple = serde_json::to_vec(&("native-recovery-email-v1", canonical(base)?, username)).map_err(|_| invalid())?;
    let hash = Sha256::digest(tuple).iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(format!("native-recovery-email-{hash}"))
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    base_url: String,
    username: String,
    identity: Identity,
}
impl Scope {
    pub fn new(base: &str, username: &str, discovery: &Discovery) -> Result<Self, Error> {
        let scope = Self {
            base_url: canonical(base)?,
            username: username.into(),
            identity: Identity { instance_id: discovery.instance_id.clone(), data_epoch: discovery.data_epoch.clone() },
        };
        scope.validate()?;
        Ok(scope)
    }
    fn validate(&self) -> Result<(), Error> {
        if canonical(&self.base_url)? != self.base_url
            || !identifier(&self.username)
            || !identifier(&self.identity.instance_id)
            || !identifier(&self.identity.data_epoch)
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn base_url(&self) -> &str {
        &self.base_url
    }
    pub fn username(&self) -> &str {
        &self.username
    }
    pub fn identity(&self) -> &Identity {
        &self.identity
    }
}
// No Debug and no public operation/credential fields for UI view models.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    scope: Scope,
    input: RequestEmailRecovery,
    created_at: i64,
    expires_at: i64,
    accepted: bool,
    retry_at: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct View {
    pub username: String,
    pub accepted: bool,
    pub expired: bool,
    pub retry_after_seconds: u32,
}
impl Intent {
    fn validate(&self) -> Result<(), Error> {
        self.scope.validate()?;
        if self.input.operation_id.len() != 64
            || !self.input.operation_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.input.username != self.scope.username
            || self.input.instance_id != self.scope.identity.instance_id
            || self.input.data_epoch != self.scope.identity.data_epoch
            || self.created_at < 0
            || self.expires_at.checked_sub(self.created_at) != Some(3_600_000)
            || self.retry_at.is_some_and(|at| at < self.created_at || at > self.expires_at || self.accepted)
        {
            return Err(invalid());
        }
        Ok(())
    }
    fn expired(&self) -> bool {
        let now = Utc::now().timestamp_millis();
        now < self.created_at || now >= self.expires_at
    }
    pub fn view(&self) -> View {
        View {
            username: self.scope.username.clone(),
            accepted: self.accepted,
            expired: self.expired(),
            retry_after_seconds: self.retry_after(),
        }
    }
    fn retry_after(&self) -> u32 {
        self.retry_at
            .map(|at| {
                (at.saturating_sub(Utc::now().timestamp_millis()).max(0).saturating_add(999) / 1000).min(300) as u32
            })
            .unwrap_or(0)
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    fn same_request(&self, other: &Self) -> bool {
        self.scope == other.scope
            && self.input.operation_id == other.input.operation_id
            && self.created_at == other.created_at
            && self.expires_at == other.expires_at
    }
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
    async fn read(&self, key: &str, base: &str, username: &str, lease: Arc<File>) -> Result<Option<Intent>, Error> {
        let Some(raw) = self.storage.read(key.into(), lease).await? else { return Ok(None) };
        // Parser diagnostics may include secrets; only return a stable code.
        let intent: Intent = serde_json::from_str(&raw).map_err(|_| invalid())?;
        intent.validate()?;
        if intent.scope.base_url != canonical(base)? || intent.scope.username != username {
            return Err(invalid());
        }
        Ok(Some(intent))
    }
    async fn write(&self, key: &str, intent: &Intent, lease: Arc<File>) -> Result<(), Error> {
        intent.validate()?;
        self.storage.write(key.into(), serde_json::to_string(intent).map_err(|_| invalid())?, lease).await
    }
    /// Local read only. Expired intents are retained until explicit dismissal.
    pub async fn load(&self, base: &str, username: &str) -> Result<Option<Intent>, Error> {
        let key = key(base, username)?;
        let lease = self.lease(&key, &Guard::new()).await?;
        self.read(&key, base, username, lease).await
    }
    async fn live(scope: &Scope, client: &NativeClient, guard: &Guard, require_capability: bool) -> Result<(), Error> {
        guard.check()?;
        let discovery = client.discover().await?;
        guard.check()?;
        check(&scope.identity, &discovery)?;
        if require_capability && !discovery.capabilities.email_recovery {
            return Err(Error::Protocol("recovery_unavailable"));
        }
        Ok(())
    }
    /// Only an explicit gesture may stage and send. A previous unresolved or
    /// acknowledged intent is never overwritten by a new form or elapsed TTL.
    pub async fn begin(&self, scope: &Scope, guard: &Guard) -> Result<Intent, Error> {
        scope.validate()?;
        let key = key(&scope.base_url, &scope.username)?;
        let lease = self.lease(&key, guard).await?;
        let previous = self.read(&key, &scope.base_url, &scope.username, lease.clone()).await?;
        guard.check()?;
        if let Some(previous) = previous {
            return Err(Error::Protocol(if previous.scope == *scope {
                "recovery_pending"
            } else {
                "server_identity_changed"
            }));
        }
        let client = NativeClient::new(&scope.base_url)?;
        Self::live(scope, &client, guard, true).await?;
        let operation = credentials::token()?;
        guard.check()?;
        let now = Utc::now().timestamp_millis();
        let intent = Intent {
            scope: scope.clone(),
            input: RequestEmailRecovery {
                operation_id: operation,
                username: scope.username.clone(),
                instance_id: scope.identity.instance_id.clone(),
                data_epoch: scope.identity.data_epoch.clone(),
            },
            created_at: now,
            expires_at: now + 3_600_000,
            accepted: false,
            retry_at: None,
        };
        self.write(&key, &intent, lease.clone()).await?;
        guard.check()?;
        self.dispatch(&key, intent, &client, guard, lease).await
    }
    pub async fn retry(&self, expected: &Intent, guard: &Guard) -> Result<Intent, Error> {
        expected.validate()?;
        let scope = &expected.scope;
        let key = key(&scope.base_url, &scope.username)?;
        let lease = self.lease(&key, guard).await?;
        let current = self
            .read(&key, &scope.base_url, &scope.username, lease.clone())
            .await?
            .ok_or(Error::Protocol("credentials_changed"))?;
        guard.check()?;
        if !current.same_request(expected) {
            return Err(Error::Protocol("credentials_changed"));
        }
        if current.expired() {
            return Err(Error::Protocol("recovery_expired"));
        }
        let cooldown = current.retry_after();
        if cooldown > 0 {
            return Err(Error::Network(rv_client::Error::Server {
                status: 429,
                code: "email_recovery_cooldown".into(),
                request_id: None,
                retry_after: Some(u64::from(cooldown)),
            }));
        }
        let client = NativeClient::new(&scope.base_url)?;
        if current.accepted {
            Self::live(scope, &client, guard, false).await?;
            return Ok(current);
        }
        self.dispatch(&key, current, &client, guard, lease).await
    }
    async fn dispatch(
        &self,
        key: &str,
        mut intent: Intent,
        client: &NativeClient,
        guard: &Guard,
        lease: Arc<File>,
    ) -> Result<Intent, Error> {
        Self::live(&intent.scope, client, guard, true).await?;
        if intent.expired() {
            return Err(Error::Protocol("recovery_expired"));
        }
        let reply = match client.request_email_recovery(&intent.input).await {
            Ok(reply) => reply,
            Err(error) => {
                guard.check()?;
                if let rv_client::Error::Server { status: 429, retry_after, .. } = &error {
                    let seconds = retry_after.unwrap_or(1).clamp(1, 300) as i64;
                    intent.retry_at = Some(intent.expires_at.min(Utc::now().timestamp_millis() + seconds * 1000));
                    self.write(key, &intent, lease).await?;
                    guard.check()?;
                }
                return Err(error.into());
            }
        };
        guard.check()?;
        if !reply.accepted {
            return Err(invalid());
        }
        Self::live(&intent.scope, client, guard, false).await?;
        let current = self
            .read(key, &intent.scope.base_url, &intent.scope.username, lease.clone())
            .await?
            .ok_or(Error::Protocol("credentials_changed"))?;
        guard.check()?;
        if !current.same_request(&intent) || current.accepted {
            return Err(Error::Protocol("credentials_changed"));
        }
        intent.accepted = true;
        intent.retry_at = None;
        self.write(key, &intent, lease).await?;
        guard.check()?;
        Ok(intent)
    }
    /// Local dismissal cannot revoke a mail already queued. CAS prevents a
    /// delayed old UI from removing the next explicit request.
    pub async fn forget(&self, expected: &Intent, guard: &Guard) -> Result<bool, Error> {
        expected.validate()?;
        let scope = &expected.scope;
        let key = key(&scope.base_url, &scope.username)?;
        let lease = self.lease(&key, guard).await?;
        let current = self.read(&key, &scope.base_url, &scope.username, lease.clone()).await?;
        guard.check()?;
        let Some(current) = current else { return Ok(true) };
        if !current.same_request(expected) {
            return Ok(false);
        }
        self.storage.remove(key, lease).await?;
        guard.check()?;
        Ok(true)
    }
}
