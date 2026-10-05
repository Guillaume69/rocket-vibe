//! Destruction of old keys (E2EE_STORAGE.md), shared by desktop and mobile:
//! the private keys of expired KeyPackages, then the storage key itself.
use super::*;
use crate::protected::ROTATION_PERIOD;

/// When the storage key was last renewed and when it is next due.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StorageStatus {
    pub rotated_at: Option<u64>,
    pub due_at: Option<u64>,
}

impl Coordinator<'_> {
    pub fn storage_status(&self) -> Result<StorageStatus> {
        let manager = self.0.load()?.ok_or(vault::Error::NotInitialized)?;
        let rotated_at = manager.rotated_at()?;
        Ok(StorageStatus {
            rotated_at,
            due_at: rotated_at.and_then(|at| at.checked_add(ROTATION_PERIOD)),
        })
    }
    /// Destroys the private keys of KeyPackages expired past their grace
    /// period (once the device has an identity), then rotates the storage key
    /// so no old copy of the vault keeps them readable.
    pub fn renew_storage(&self, now: u64) -> Result<StorageStatus> {
        let manager = self.0.load()?.ok_or(vault::Error::NotInitialized)?;
        match self.state() {
            Ok((manager, state)) => {
                crate::packages::Coordinator::new(manager, state.root)
                    .and_then(|packages| packages.prune(now))
                    .map_err(|_| vault::Error::Rejected)?;
            }
            // No identity yet, or withdrawn: no package was ever published.
            Err(Error::Storage(vault::Error::NotInitialized) | Error::Withdrawn(_)) => {}
            Err(error) => return Err(error),
        }
        manager.rotate(now)?;
        self.storage_status()
    }
    /// Renews when the period has passed since the last renewal, or none was
    /// ever made; whether it renewed.
    pub fn renew_storage_if_due(&self, now: u64) -> Result<bool> {
        let status = self.storage_status()?;
        if status
            .rotated_at
            .is_some_and(|at| at <= now && now - at < ROTATION_PERIOD)
        {
            return Ok(false);
        }
        self.renew_storage(now)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::*;
    use super::*;

    #[test]
    fn storage_renewal_rotates_on_schedule_and_keeps_the_identity() {
        let folder = tempfile::tempdir().unwrap();
        let keys = Arc::new(Keys::default());
        let desktop = slot(folder.path(), keys);
        let wire = initialized(&desktop);
        let c = Coordinator::new(&desktop);
        let directory = c.directory(wire).unwrap();
        let before = c.view(&directory, NOW).unwrap();
        // Never renewed: due at once.
        assert_eq!(
            c.storage_status().unwrap(),
            StorageStatus {
                rotated_at: None,
                due_at: None
            }
        );
        assert!(c.renew_storage_if_due(NOW).unwrap());
        let status = c.storage_status().unwrap();
        assert_eq!(
            status,
            StorageStatus {
                rotated_at: Some(NOW),
                due_at: Some(NOW + ROTATION_PERIOD)
            }
        );
        assert!(!c.renew_storage_if_due(NOW + 1).unwrap());
        assert!(c.renew_storage_if_due(NOW + ROTATION_PERIOD).unwrap());
        // The identity survives the new keys, also from a fresh opening.
        let after = Coordinator::new(&desktop).view(&directory, NOW).unwrap();
        assert_eq!(after.root_fingerprint, before.root_fingerprint);
    }
}
