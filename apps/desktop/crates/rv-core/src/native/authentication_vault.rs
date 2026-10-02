//! Private pre-authentication vault. Platform adapters use a system trousseau,
//! never SQLite or an active-session entry. Only empty lock files touch disk.
use super::{
    Error,
    authentication::{self, LoginChallenge, Step},
    credentials::Record,
    factor_email,
    security::Guard,
};
use crate::session::SessionInfo;
use rv_client::NativeClient;
use rv_protocol::parity::SecondFactor;
use sha2::{Digest, Sha256};
use std::{fs::File, future::Future, path::PathBuf, pin::Pin, sync::Arc};

pub type StorageFuture<T> = Pin<Box<dyn Future<Output = Result<T, Error>> + Send>>;
/// An adapter MUST retain the passed lease until the actual platform operation
/// finishes, including spawn_blocking/DBus work surviving caller cancellation.
/// `None` means a positively missing entry, never an unavailable/locked vault.
pub trait Storage: Send + Sync {
    fn read(&self, key: String, lease: Arc<File>) -> StorageFuture<Option<String>>;
    fn write(&self, key: String, value: String, lease: Arc<File>) -> StorageFuture<()>;
    fn remove(&self, key: String, lease: Arc<File>) -> StorageFuture<()>;
}

struct Scope {
    base: String,
    username: String,
    key: String,
}
fn canonical(base: &str) -> Result<String, Error> {
    NativeClient::new(base)?;
    Ok(url::Url::parse(base)
        .map_err(|_| Error::Protocol("invalid_native_authentication"))?
        .as_str()
        .trim_end_matches('/')
        .into())
}
fn make_scope(base: &str, username: &str) -> Result<Scope, Error> {
    if username.is_empty() || username.len() > 128 {
        return Err(Error::Protocol("invalid_native_authentication"));
    }
    let base = canonical(base)?;
    let tuple = serde_json::to_vec(&("native-auth-v1", &base, username))
        .map_err(|_| Error::Protocol("invalid_native_authentication"))?;
    let hash = Sha256::digest(tuple).iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(Scope { base, username: username.into(), key: format!("native-auth-{hash}") })
}
/// Shared GTK/FFI key, intentionally absent from the active-account index.
pub fn key(base: &str, username: &str) -> Result<String, Error> {
    Ok(make_scope(base, username)?.key)
}
fn same_identity(a: &LoginChallenge, b: &LoginChallenge) -> bool {
    canonical(&a.base_url).ok() == canonical(&b.base_url).ok()
        && a.identity == b.identity
        && a.user.id == b.user.id
        && a.user.username == b.user.username
}
fn same_attempt(a: &LoginChallenge, b: &LoginChallenge) -> bool {
    same_identity(a, b) && a.challenge.challenge_id == b.challenge.challenge_id
}

#[derive(Clone)]
pub struct Vault {
    config: PathBuf,
    storage: Arc<dyn Storage>,
}
/// Exact previous proof to clear after the active credential write. Callers do
/// not re-read a possibly newer attempt to guess which verification completed.
pub enum Prepared {
    Authenticated(Box<Record>, Option<LoginChallenge>),
    Challenge(LoginChallenge),
}
impl Vault {
    pub fn new(config: PathBuf, storage: Arc<dyn Storage>) -> Self {
        Self { config, storage }
    }
    async fn lease(&self, scope: &Scope) -> Result<Arc<File>, Error> {
        self.lease_guard(scope, &Guard::new()).await
    }
    async fn lease_guard(&self, scope: &Scope, guard: &Guard) -> Result<Arc<File>, Error> {
        guard.check()?;
        std::fs::create_dir_all(&self.config).map_err(|_| Error::Protocol("secure_storage_unavailable"))?;
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.config.join(format!("{}.lock", scope.key)))
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
    async fn read(&self, scope: &Scope, lease: Arc<File>) -> Result<Option<LoginChallenge>, Error> {
        let Some(raw) = self.storage.read(scope.key.clone(), lease).await? else { return Ok(None) };
        // serde errors can contain input excerpts; never return their Display.
        let saved: LoginChallenge =
            serde_json::from_str(&raw).map_err(|_| Error::Protocol("invalid_native_authentication"))?;
        saved.validate()?;
        if canonical(&saved.base_url)? != scope.base || saved.user.username != scope.username {
            return Err(Error::Protocol("invalid_native_authentication"));
        }
        Ok(Some(saved))
    }
    async fn write(&self, scope: &Scope, record: &LoginChallenge, lease: Arc<File>) -> Result<(), Error> {
        let raw = serde_json::to_string(record).map_err(|_| Error::Protocol("invalid_native_authentication"))?;
        self.storage.write(scope.key.clone(), raw, lease).await
    }
    pub async fn load(&self, base: &str, username: &str) -> Result<Option<LoginChallenge>, Error> {
        let scope = make_scope(base, username)?;
        let lease = self.lease(&scope).await?;
        self.read(&scope, lease).await
    }
    /// `fresh` comes from a freshly verified password start holding the server's
    /// account lock. Never replace an unresolved candidate before that barrier.
    pub async fn stage(&self, fresh: LoginChallenge) -> Result<Step, Error> {
        Ok(match self.stage_tracked(fresh).await? {
            Prepared::Authenticated(record, _) => Step::Authenticated(*record),
            Prepared::Challenge(saved) => Step::Challenge(saved),
        })
    }
    pub async fn prepare(&self, step: Step) -> Result<Prepared, Error> {
        match step {
            Step::Authenticated(record) => Ok(Prepared::Authenticated(Box::new(record), None)),
            Step::Challenge(fresh) => self.stage_tracked(fresh).await,
        }
    }
    async fn stage_tracked(&self, fresh: LoginChallenge) -> Result<Prepared, Error> {
        fresh.validate()?;
        if fresh.pending.is_some() || fresh.email.is_some() {
            return Err(Error::Protocol("invalid_native_authentication"));
        }
        let scope = make_scope(&fresh.base_url, &fresh.user.username)?;
        let lease = self.lease(&scope).await?;
        if let Some(previous) = self.read(&scope, lease.clone()).await?
            && (previous.pending.is_some() || previous.email.is_some())
        {
            if !same_identity(&previous, &fresh) {
                return Err(Error::Protocol("server_identity_changed"));
            }
            if let Some(completed) = authentication::recover(&previous).await? {
                return Ok(Prepared::Authenticated(Box::new(completed), Some(previous)));
            }
            // Server challenge TTL is exactly five minutes. Password start and
            // factor verification acquire the same user lock; a candidate probe
            // AFTER a start issued after old expiry cannot miss a future commit.
            let issued = chrono::DateTime::parse_from_rfc3339(&fresh.challenge.expires_at)
                .map_err(|_| Error::Protocol("invalid_native_authentication"))?
                - chrono::Duration::minutes(5);
            let old_expiry = chrono::DateTime::parse_from_rfc3339(&previous.challenge.expires_at)
                .map_err(|_| Error::Protocol("invalid_native_authentication"))?;
            if old_expiry > issued {
                return Ok(Prepared::Challenge(previous));
            }
        }
        self.write(&scope, &fresh, lease.clone()).await?;
        Ok(Prepared::Challenge(fresh))
    }
    pub async fn recover(&self, expected: &LoginChallenge) -> Result<Option<Record>, Error> {
        expected.validate()?;
        let scope = make_scope(&expected.base_url, &expected.user.username)?;
        let lease = self.lease(&scope).await?;
        let current = self.read(&scope, lease.clone()).await?.ok_or(Error::Protocol("credentials_changed"))?;
        if !same_attempt(&current, expected) {
            return Err(Error::Protocol("credentials_changed"));
        }
        authentication::recover(&current).await
    }
    pub async fn send_email(
        &self,
        expected: &LoginChallenge,
        resend: bool,
        guard: &Guard,
    ) -> Result<LoginChallenge, Error> {
        expected.validate()?;
        let scope = make_scope(&expected.base_url, &expected.user.username)?;
        let lease = self.lease_guard(&scope, guard).await?;
        let current = self.read(&scope, lease.clone()).await?.ok_or(Error::Protocol("credentials_changed"))?;
        guard.check()?;
        if !same_attempt(&current, expected)
            || (resend
                && !matches!((&current.email, &expected.email),
            (Some(a), Some(b)) if a.same_candidate(b)))
        {
            return Err(Error::Protocol("credentials_changed"));
        }
        let client = NativeClient::new(&current.base_url)?;
        let discovery = client.discover().await?;
        guard.check()?;
        super::check(&current.identity, &discovery)?;
        if current.email.is_none() && !discovery.capabilities.email_factor_delivery {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let remote = factor_email::LoginRemote { client, identity: current.identity.clone(), guard: guard.clone() };
        let (challenge, previous) = (current.challenge.clone(), current.email.clone());
        let tracked = Arc::new(std::sync::Mutex::new(current));
        let (vault, saved) = (self.clone(), tracked.clone());
        factor_email::send(&challenge, previous, resend, &remote, guard, move |email| {
            let (vault, saved, lease, guard) = (vault.clone(), saved.clone(), lease.clone(), guard.clone());
            let prior = saved.lock().unwrap().clone();
            async move {
                guard.check()?;
                let scope = make_scope(&prior.base_url, &prior.user.username)?;
                let actual = vault.read(&scope, lease.clone()).await?.ok_or(Error::Protocol("credentials_changed"))?;
                guard.check()?;
                if serde_json::to_string(&actual).map_err(|_| Error::Protocol("invalid_native_authentication"))?
                    != serde_json::to_string(&prior).map_err(|_| Error::Protocol("invalid_native_authentication"))?
                {
                    return Err(Error::Protocol("credentials_changed"));
                }
                let mut updated = prior;
                updated.email = Some(email);
                updated.validate()?;
                vault.write(&scope, &updated, lease).await?;
                guard.check()?;
                *saved.lock().unwrap() = updated;
                Ok(())
            }
        })
        .await?;
        let result = tracked.lock().unwrap().clone();
        Ok(result)
    }
    pub async fn finish(&self, expected: &LoginChallenge, method: SecondFactor, code: &str) -> Result<Record, Error> {
        expected.validate()?;
        let scope = make_scope(&expected.base_url, &expected.user.username)?;
        let lease = self.lease(&scope).await?;
        let current = self.read(&scope, lease.clone()).await?.ok_or(Error::Protocol("credentials_changed"))?;
        if !same_attempt(&current, expected) {
            return Err(Error::Protocol("credentials_changed"));
        }
        let prior = current.clone();
        let vault = self.clone();
        authentication::finish(current, method, code, move |updated| {
            let (vault, lease, prior) = (vault.clone(), lease.clone(), prior.clone());
            async move {
                let scope = make_scope(&prior.base_url, &prior.user.username)?;
                let actual = vault.read(&scope, lease.clone()).await?.ok_or(Error::Protocol("credentials_changed"))?;
                if !same_attempt(&actual, &prior) || actual.pending != prior.pending {
                    return Err(Error::Protocol("credentials_changed"));
                }
                vault.write(&scope, &updated, lease).await
            }
        })
        .await
    }
    /// Call after saving the active session. A newer attempt or rotated bearer
    /// conservatively retains the pending record instead of deleting its proof.
    pub async fn clear_completed(
        &self,
        expected: &LoginChallenge,
        active: Option<&SessionInfo>,
    ) -> Result<bool, Error> {
        expected.validate()?;
        let scope = make_scope(&expected.base_url, &expected.user.username)?;
        let lease = self.lease(&scope).await?;
        let Some(current) = self.read(&scope, lease.clone()).await? else { return Ok(true) };
        let Some(active) = active else { return Ok(false) };
        if !same_attempt(&current, expected)
            || active.native.as_ref() != Some(&current.identity)
            || canonical(&active.base_url)? != scope.base
            || active.user_id != current.user.id
            || current.pending.as_ref().is_none_or(|p| p.next_token != active.auth_token)
        {
            return Ok(false);
        }
        self.storage.remove(scope.key, lease).await?;
        Ok(true)
    }
}
