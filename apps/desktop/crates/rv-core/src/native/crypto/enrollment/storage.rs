//! Destruction of old keys (E2EE_STORAGE.md) through the existing desktop
//! session: the private keys of expired KeyPackages, then the storage key.
//! Shared protected steps live in `rv_crypto::account::storage`.
use super::*;
pub use rv_crypto::account::storage::StorageStatus;

impl Access {
    pub async fn storage_status(&self) -> Result<StorageStatus> {
        let _dispatch = self.0.dispatch.lock().await;
        self.owned(|slot, _| Ok(Coordinator::new(slot).storage_status()?)).await
    }
    /// Destroys expired package keys and seals the vault under a fresh key;
    /// the old key no longer exists anywhere.
    pub async fn renew_storage(&self) -> Result<StorageStatus> {
        let _dispatch = self.0.dispatch.lock().await;
        let _alone = self.0.context.exclusive().await;
        self.owned(|slot, time| Ok(Coordinator::new(slot).renew_storage(time)?)).await
    }
    /// At most once an hour per view, in the background: renews the storage
    /// when its period has passed.
    pub fn renew_storage_soon(&self) {
        const EVERY: std::time::Duration = std::time::Duration::from_secs(3600);
        {
            let mut last = self.0.storage_checked.lock().unwrap();
            if last.is_some_and(|at| at.elapsed() < EVERY) || self.check().is_err() {
                return;
            }
            *last = Some(std::time::Instant::now());
        }
        let access = self.clone();
        tokio::spawn(async move {
            let _dispatch = access.0.dispatch.lock().await;
            let _alone = access.0.context.exclusive().await;
            let _ = access.owned(|slot, time| Ok(Coordinator::new(slot).renew_storage_if_due(time)?)).await;
        });
    }
}
