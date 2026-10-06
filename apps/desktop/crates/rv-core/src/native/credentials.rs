//! Durable session renewal. Platform adapters must serialize updates to one
//! account's keychain entry. Secrets never enter the SQLite outbox or logs.
use super::{Error, check};
use crate::session::SessionInfo;
use rv_client::NativeClient;
use rv_protocol::parity::RenewSession;
use serde_json::{Value, json};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;

pub type CredentialFuture = Pin<Box<dyn Future<Output = Result<SessionInfo, Error>> + Send>>;
pub trait Provider: Send + Sync {
    fn resume(&self, expected: SessionInfo) -> CredentialFuture;
}

/// Only a lock file is written on disk. Its name contains no credential.
pub fn lock_file(config: &Path, info: &SessionInfo) -> Result<std::fs::File, Error> {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(format!("{}|{}", info.base_url, info.user_id).as_bytes());
    let name = hash.iter().map(|b| format!("{b:02x}")).collect::<String>();
    std::fs::create_dir_all(config).map_err(|_| Error::Protocol("secure_storage_unavailable"))?;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(config.join(format!("native-credentials-{name}.lock")))
        .map_err(|_| Error::Protocol("secure_storage_unavailable"))
}
pub fn lease_blocking(config: &Path, info: &SessionInfo) -> Result<std::fs::File, Error> {
    let file = lock_file(config, info)?;
    file.lock().map_err(|_| Error::Protocol("secure_storage_unavailable"))?;
    Ok(file)
}
pub async fn lease(config: &Path, info: &SessionInfo) -> Result<std::fs::File, Error> {
    let file = lock_file(config, info)?;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
            Err(_) => return Err(Error::Protocol("secure_storage_unavailable")),
        }
    }
}

#[derive(Clone)]
pub struct Record {
    pub info: SessionInfo,
    pub pending: Option<RenewSession>,
    pub expires_at: Option<String>,
}
impl Record {
    pub fn from_secret(secret: &Value) -> Option<Self> {
        let info = SessionInfo::from_secret(secret)?;
        info.native.as_ref()?;
        let pending = match secret.get("nativeRenewal") {
            None | Some(Value::Null) => None,
            Some(value) => Some(serde_json::from_value(value.clone()).ok()?),
        };
        if pending.as_ref().is_some_and(|p: &RenewSession| !valid_pending(p, &info.auth_token)) {
            return None;
        }
        Some(Self {
            info,
            pending,
            expires_at: secret.get("nativeExpiresAt").and_then(Value::as_str).map(str::to_owned),
        })
    }
    pub fn secret(&self) -> Value {
        let mut secret = self.info.secret();
        if let Some(pending) = &self.pending {
            secret["nativeRenewal"] = json!(pending);
        }
        if let Some(expires) = &self.expires_at {
            secret["nativeExpiresAt"] = json!(expires);
        }
        secret
    }
    pub fn due(&self) -> bool {
        self.pending.is_some()
            || self
                .expires_at
                .as_deref()
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                .is_some_and(|t| t <= chrono::Utc::now() + chrono::Duration::days(2))
    }
}
fn valid_pending(p: &RenewSession, current: &str) -> bool {
    !p.operation_id.is_empty()
        && p.operation_id.len() <= 128
        && p.operation_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        && p.next_token.len() == 64
        && p.next_token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && p.next_token != current
}
pub(crate) fn token() -> Result<String, Error> {
    let mut bytes = [0u8; 32];
    aws_lc_rs::rand::fill(&mut bytes).map_err(|_| Error::Protocol("secure_random_unavailable"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn rejected(error: &rv_client::Error) -> bool {
    matches!(error,rv_client::Error::Server{status:401,code,..} if code=="session_rejected")
}

pub async fn prepare<F, Fut>(mut record: Record, mut save: F) -> Result<Record, Error>
where
    F: FnMut(Record) -> Fut,
    Fut: Future<Output = Result<(), Error>>,
{
    let mut client = NativeClient::new(&record.info.base_url)?;
    let discovery = client.discover().await?;
    check(record.info.native.as_ref().ok_or(Error::Protocol("not_native"))?, &discovery)?;
    if !discovery.capabilities.session_rotation {
        if record.pending.is_some() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        return Ok(record);
    }
    if record.pending.is_some() {
        return renew(record, save).await;
    }
    if record.expires_at.as_deref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).is_none() {
        client.restore(record.info.auth_token.clone());
        let devices = client.device_sessions().await?;
        let mut current = devices.into_iter().filter(|d| d.current);
        record.expires_at = Some(current.next().ok_or(Error::Protocol("session_rejected"))?.expires_at);
        if current.next().is_some()
            || record.expires_at.as_deref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).is_none()
        {
            return Err(Error::Protocol("invalid_native_session"));
        }
        save(record.clone()).await?;
    }
    if record.due() { renew(record, save).await } else { Ok(record) }
}

/// Keep the record after any error. Once the pending successor is durable, a
/// later invocation probes it first, including after the receipt's grace period.
/// `save` must fail if another login/account switch replaced the stored record.
pub async fn renew<F, Fut>(mut record: Record, mut save: F) -> Result<Record, Error>
where
    F: FnMut(Record) -> Fut,
    Fut: Future<Output = Result<(), Error>>,
{
    if record.pending.as_ref().is_some_and(|p| !valid_pending(p, &record.info.auth_token)) {
        return Err(Error::Protocol("invalid_native_credentials"));
    }
    let mut client = NativeClient::new(&record.info.base_url)?;
    let identity = record.info.native.as_ref().ok_or(Error::Protocol("not_native"))?;
    let discovery = client.discover().await?;
    check(identity, &discovery)?;
    if !discovery.capabilities.session_rotation {
        return Err(Error::Protocol("unsupported_feature"));
    }
    if let Some(pending) = &record.pending {
        client.restore(pending.next_token.clone());
        match client.me().await {
            Ok(user) => {
                if user.id != record.info.user_id {
                    return Err(Error::Protocol("session_rejected"));
                }
                let devices = client.device_sessions().await?;
                let mut current = devices.into_iter().filter(|d| d.current);
                let active = current.next().ok_or(Error::Protocol("invalid_native_session"))?;
                if current.next().is_some() || chrono::DateTime::parse_from_rfc3339(&active.expires_at).is_err() {
                    return Err(Error::Protocol("invalid_native_session"));
                }
                record.info.auth_token = pending.next_token.clone();
                record.info.username = user.username;
                record.expires_at = Some(active.expires_at);
                record.pending = None;
                check(identity, &client.discover().await?)?;
                save(record.clone()).await?;
                return Ok(record);
            }
            Err(error) if rejected(&error) => {}
            Err(error) => return Err(error.into()),
        }
    } else {
        record.pending = Some(RenewSession { operation_id: token()?, next_token: token()? });
        save(record.clone()).await?;
    }
    client.restore(record.info.auth_token.clone());
    let pending = record.pending.as_ref().expect("saved successor");
    let session = client.renew(pending).await?;
    if session.token != pending.next_token
        || session.user.id != record.info.user_id
        || chrono::DateTime::parse_from_rfc3339(&session.expires_at).is_err()
    {
        return Err(Error::Protocol("invalid_native_session"));
    }
    check(identity, &client.discover().await?)?;
    record.info.auth_token = session.token;
    record.info.username = session.user.username;
    record.expires_at = Some(session.expires_at);
    record.pending = None;
    save(record.clone()).await?;
    Ok(record)
}
