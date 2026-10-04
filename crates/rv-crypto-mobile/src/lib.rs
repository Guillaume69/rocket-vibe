//! Native-only Keystore seam. Foreign code sees scope/status; keys, protected
//! records, checkpoints and MLS providers never cross the React Native bridge.
use rv_crypto::{installation, protected, vault};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use zeroize::Zeroizing;
mod identity;
mod peers;
pub use identity::{IdentityApproval, IdentityPhase, IdentityStatus};
pub use peers::{PeerApproval, PeerReview};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CryptoBridgeError {
    #[error("crypto_storage_unavailable")]
    Storage,
    #[error("crypto_scope_changed")]
    Changed,
    #[error("crypto_view_closed")]
    Closed,
    #[error("crypto_integrity_failed")]
    Integrity,
}
type Result<T> = std::result::Result<T, CryptoBridgeError>;
impl From<vault::Error> for CryptoBridgeError {
    fn from(error: vault::Error) -> Self {
        match error {
            vault::Error::Storage => Self::Storage,
            vault::Error::Scope => Self::Changed,
            _ => Self::Integrity,
        }
    }
}

/// Kotlin-only foreign trait. Expo exposes no read/write-secret function to JS.
/// Returning None means a confirmed absence; failures must throw.
#[uniffi::export(with_foreign)]
pub trait ProtectedKeystore: Send + Sync {
    fn read(&self, name: String) -> Result<Option<Vec<u8>>>;
    fn write(&self, name: String, value: Vec<u8>) -> Result<()>;
}
struct Platform(Arc<dyn ProtectedKeystore>);
impl protected::Storage for Platform {
    fn read(&self, name: &str) -> std::result::Result<Option<Zeroizing<Vec<u8>>>, vault::Error> {
        let value = self
            .0
            .read(name.into())
            .map_err(|_| vault::Error::Storage)?;
        if value.as_ref().is_some_and(|v| v.len() > 4096) {
            return Err(vault::Error::Limit);
        }
        Ok(value.map(Zeroizing::new))
    }
    fn write(&self, name: &str, value: &[u8]) -> std::result::Result<(), vault::Error> {
        if value.len() > 4096 {
            return Err(vault::Error::Limit);
        }
        self.0
            .write(name.into(), value.to_vec())
            .map_err(|_| vault::Error::Storage)
    }
}
#[derive(Clone, uniffi::Record)]
pub struct CryptoAccount {
    pub origin: String,
    pub instance: String,
    pub data_epoch: String,
    pub user: String,
    pub device: String,
}
impl From<CryptoAccount> for installation::Account {
    fn from(value: CryptoAccount) -> Self {
        Self {
            origin: value.origin,
            instance: value.instance,
            data_epoch: value.data_epoch,
            user: value.user,
            device: value.device,
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum InstallationPhase {
    Missing,
    Initializing,
    Ready,
}
#[derive(Clone, uniffi::Record)]
pub struct InstallationStatus {
    pub phase: InstallationPhase,
    pub account_fingerprint: String,
    pub incarnation: String,
}
#[derive(uniffi::Object)]
pub struct CryptoInstallation {
    slot: installation::Installation,
    fingerprint: String,
    serial: Mutex<()>,
    closed: AtomicBool,
    approval: Mutex<Option<(String, rv_crypto::account::Approval)>>,
    peer_review: Mutex<Option<(String, rv_crypto::account::peers::View)>>,
    peer_approval: Mutex<Option<(String, rv_crypto::account::peers::Approval)>>,
}
impl CryptoInstallation {
    fn check(&self) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            Err(CryptoBridgeError::Closed)
        } else {
            Ok(())
        }
    }
    fn status_inner(&self) -> Result<InstallationStatus> {
        let (phase, incarnation) = match self.slot.load()? {
            None => (InstallationPhase::Missing, String::new()),
            Some(manager) => {
                let phase = match manager.inspect(|_, _| Ok(())) {
                    Ok(()) => InstallationPhase::Ready,
                    Err(vault::Error::NotInitialized) => InstallationPhase::Initializing,
                    Err(error) => return Err(error.into()),
                };
                (phase, manager.scope().incarnation.clone())
            }
        };
        self.check()?;
        Ok(InstallationStatus {
            phase,
            account_fingerprint: self.fingerprint.clone(),
            incarnation,
        })
    }
}
#[uniffi::export]
impl CryptoInstallation {
    #[uniffi::constructor]
    pub fn open(
        directory: String,
        account: CryptoAccount,
        keystore: Arc<dyn ProtectedKeystore>,
    ) -> Result<Arc<Self>> {
        let mut account: installation::Account = account.into();
        let origin = url::Url::parse(&account.origin).map_err(|_| CryptoBridgeError::Changed)?;
        if !matches!(origin.scheme(), "http" | "https")
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err(CryptoBridgeError::Changed);
        }
        // NativeTransport already fixes its base URL. URL parsing adds a slash
        // at the host root; preserve intentional slashes in a non-root base path.
        account.origin = if origin.path() == "/" {
            origin.to_string().trim_end_matches('/').into()
        } else {
            origin.to_string()
        };
        let slot = installation::Installation::new(
            PathBuf::from(directory),
            account.clone(),
            Arc::new(Platform(keystore)),
        )?;
        let fingerprint = data_encoding::HEXLOWER.encode(&Sha256::digest(
            serde_json::to_vec(&("rocketvibe-mobile-account-v1", &account))
                .map_err(|_| CryptoBridgeError::Changed)?,
        ));
        Ok(Arc::new(Self {
            slot,
            fingerprint,
            serial: Mutex::new(()),
            closed: AtomicBool::new(false),
            approval: Mutex::new(None),
            peer_review: Mutex::new(None),
            peer_approval: Mutex::new(None),
        }))
    }
    pub fn stop(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut approval) = self.approval.lock() {
            *approval = None;
        }
        if let Ok(mut review) = self.peer_review.lock() {
            *review = None;
        }
        if let Ok(mut approval) = self.peer_approval.lock() {
            *approval = None;
        }
    }
    pub fn is_closed(&self) -> bool {
        self.check().is_err()
    }
    pub fn status(&self) -> Result<InstallationStatus> {
        let _serial = self.serial.lock().map_err(|_| CryptoBridgeError::Closed)?;
        self.check()?;
        self.status_inner()
    }
    /// Explicitly allocate storage for this account, never an identity or group.
    pub fn initialize(&self, expected_fingerprint: String) -> Result<InstallationStatus> {
        let _serial = self.serial.lock().map_err(|_| CryptoBridgeError::Closed)?;
        self.check()?;
        if expected_fingerprint != self.fingerprint {
            return Err(CryptoBridgeError::Changed);
        }
        self.slot.initialize()?;
        self.status_inner()
    }
    pub fn retire(&self, expected_fingerprint: String) -> Result<()> {
        let _serial = self.serial.lock().map_err(|_| CryptoBridgeError::Closed)?;
        self.check()?;
        if expected_fingerprint != self.fingerprint {
            return Err(CryptoBridgeError::Changed);
        }
        let manager = self.slot.load()?.ok_or(CryptoBridgeError::Changed)?;
        manager.retire()?;
        self.stop();
        Ok(())
    }
}

#[cfg(test)]
mod tests;
