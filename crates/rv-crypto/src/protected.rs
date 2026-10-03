//! Blocking protected-storage coordinator. Execute the whole operation on an
//! owned worker: cancellation must not detach a platform write from its lease.
use crate::vault::{Checkpoint, Error, Key, Records, Scope, Vault};
use openmls_rust_crypto::OpenMlsRustCrypto;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    path::PathBuf,
    sync::Arc,
};
use zeroize::{Zeroize, Zeroizing};

const SECRET_LIMIT: usize = 2048;

struct Lease(File);
impl Drop for Lease {
    fn drop(&mut self) {
        // Explicit unlock also releases a briefly inherited descriptor while
        // another thread spawns a child; closing this handle alone can leave
        // flock held until that child execs/closes its inherited descriptor.
        let _ = self.0.unlock();
    }
}

/// Protected platform storage, never a file beside the database.
/// `None` means positively absent, never locked/unavailable. Writes replace one
/// complete item atomically and durably. Methods finish the actual OS work before
/// returning; do not spawn a detached mutation. No callbacks may reenter Manager.
pub trait Storage: Send + Sync {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error>;
    fn write(&self, name: &str, value: &[u8]) -> Result<(), Error>;
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Secret {
    version: u8,
    scope: Scope,
    location: [u8; 32],
    key: Option<[u8; 32]>,
    checkpoint: Option<Checkpoint>,
    retired: bool,
}
impl Secret {
    fn valid(&self, scope: &Scope, location: [u8; 32]) -> bool {
        self.version == 1
            && self.scope == *scope
            && self.location == location
            && if self.retired {
                self.key.is_none() && self.checkpoint.is_none()
            } else {
                self.key.is_some() && self.checkpoint.is_none_or(|c| c.revision >= 0)
            }
    }
    fn key(&self) -> Result<Key, Error> {
        self.key.map(Key::from_keystore).ok_or(Error::Retired)
    }
}
impl Drop for Secret {
    fn drop(&mut self) {
        if let Some(key) = &mut self.key {
            key.zeroize();
        }
    }
}

/// One shared private directory and scope across all native adapters for this
/// installation. Only filenames derived from the exact scope are ever used.
/// The manager owns no long-lived live MLS state, so another process is observed
/// on every operation. This is an internal crypto-engine API, not an UI/FFI API.
pub struct Manager {
    directory: PathBuf,
    scope: Scope,
    name: String,
    storage: Arc<dyn Storage>,
}
impl Manager {
    pub fn new(directory: PathBuf, scope: Scope, storage: Arc<dyn Storage>) -> Result<Self, Error> {
        if !scope.valid() || !directory.is_absolute() {
            return Err(Error::Scope);
        }
        let tuple = serde_json::to_vec(&("rocketvibe-crypto-protected-v1", &scope))
            .map_err(|_| Error::Scope)?;
        let hash = Sha256::digest(tuple)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        Ok(Self {
            directory,
            scope,
            name: format!("native-crypto-{hash}"),
            storage,
        })
    }
    fn path(&self) -> PathBuf {
        self.directory.join(format!("{}.sqlite", self.name))
    }
    fn location(&self) -> Result<[u8; 32], Error> {
        // A copied DB in a second directory must not fork the same device's
        // send state under a different lock while sharing a keystore entry.
        let canonical = fs::canonicalize(&self.directory).map_err(|_| Error::Storage)?;
        let mut hash = Sha256::new();
        hash.update(b"rocketvibe-crypto-location-v1");
        hash.update(canonical.as_os_str().as_encoded_bytes());
        Ok(hash.finalize().into())
    }
    fn lease(&self) -> Result<Lease, Error> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&self.directory)
            .map_err(|_| Error::Storage)?;
        let metadata = fs::symlink_metadata(&self.directory).map_err(|_| Error::Storage)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(Error::Storage);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.mode() & 0o077 != 0 || metadata.uid() != rustix::process::geteuid().as_raw()
            {
                return Err(Error::Storage);
            }
        }
        let path = self.directory.join(format!("{}.lock", self.name));
        if let Ok(metadata) = fs::symlink_metadata(&path)
            && !metadata.is_file()
        {
            return Err(Error::Storage);
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path).map_err(|_| Error::Storage)?;
        let metadata = file.metadata().map_err(|_| Error::Storage)?;
        if !metadata.is_file() || metadata.len() != 0 {
            return Err(Error::Storage);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.mode() & 0o077 != 0
                || metadata.nlink() != 1
                || metadata.uid() != rustix::process::geteuid().as_raw()
            {
                return Err(Error::Storage);
            }
        }
        file.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => Error::Busy,
            std::fs::TryLockError::Error(_) => Error::Storage,
        })?;
        Ok(Lease(file))
    }
    fn read(&self) -> Result<Option<Secret>, Error> {
        let Some(bytes) = self.storage.read(&self.name)? else {
            return Ok(None);
        };
        if bytes.len() > SECRET_LIMIT {
            return Err(Error::Limit);
        }
        let record: Secret = serde_json::from_slice(&bytes).map_err(|_| Error::Integrity)?;
        if !record.valid(&self.scope, self.location()?) {
            return Err(Error::Integrity);
        }
        Ok(Some(record))
    }
    fn write(&self, expected: Option<&Secret>, next: &Secret) -> Result<(), Error> {
        if self.read()?.as_ref() != expected {
            return Err(Error::Stale);
        }
        let bytes = Zeroizing::new(serde_json::to_vec(next).map_err(|_| Error::Integrity)?);
        if bytes.len() > SECRET_LIMIT {
            return Err(Error::Limit);
        }
        self.storage.write(&self.name, &bytes)?;
        if self.read()?.as_ref() != Some(next) {
            return Err(Error::Stale);
        }
        Ok(())
    }
    fn protect(&self, record: &mut Secret, vault: &mut Vault) -> Result<(), Error> {
        let next = Secret {
            version: 1,
            scope: self.scope.clone(),
            location: self.location()?,
            key: record.key,
            checkpoint: Some(vault.checkpoint()),
            retired: false,
        };
        self.write(Some(record), &next)?;
        *record = next;
        vault.checkpoint_persisted(vault.checkpoint())
    }
    fn open(&self, record: &mut Secret) -> Result<Vault, Error> {
        if record.retired {
            return Err(Error::Retired);
        }
        let marker = record.checkpoint.ok_or(Error::NotInitialized)?;
        match Vault::open(&self.path(), self.scope.clone(), record.key()?, marker) {
            Ok(vault) => Ok(vault),
            Err(Error::Stale) => {
                let mut vault = Vault::recover_committed(
                    &self.path(),
                    self.scope.clone(),
                    record.key()?,
                    marker,
                )?;
                self.protect(record, &mut vault)?;
                Ok(vault)
            }
            Err(error) => Err(error),
        }
    }
    /// Explicit initialization only. A missing/locked keystore never replaces
    /// an existing database. An interrupted pristine genesis may be resumed.
    pub fn initialize(&self) -> Result<(), Error> {
        let _lease = self.lease()?;
        let mut record = match self.read()? {
            Some(record) => record,
            None => {
                match fs::symlink_metadata(self.path()) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    _ => return Err(Error::NotInitialized),
                }
                let key = Key::generate()?;
                let fresh = Secret {
                    version: 1,
                    scope: self.scope.clone(),
                    location: self.location()?,
                    key: Some(*key.for_keystore()),
                    checkpoint: None,
                    retired: false,
                };
                self.write(None, &fresh)?;
                fresh
            }
        };
        if record.retired {
            return Err(Error::Retired);
        }
        if record.checkpoint.is_some() {
            drop(self.open(&mut record)?);
            return Ok(());
        }
        let mut vault = match fs::symlink_metadata(self.path()) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Vault::create(&self.path(), self.scope.clone(), record.key()?)?
            }
            Ok(_) => Vault::recover_initial(&self.path(), self.scope.clone(), record.key()?)?,
            Err(_) => return Err(Error::Storage),
        };
        self.protect(&mut record, &mut vault)
    }
    pub fn inspect<T>(
        &self,
        operation: impl FnOnce(&OpenMlsRustCrypto, &Records) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let _lease = self.lease()?;
        let mut record = self.read()?.ok_or(Error::NotInitialized)?;
        self.open(&mut record)?.inspect(operation)
    }
    /// The callback has no network/UI side effects. Output is returned only
    /// after the protected checkpoint is saved and read back under the OS lease.
    pub fn transact<T>(
        &self,
        operation: impl FnOnce(&OpenMlsRustCrypto, &mut Records) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let _lease = self.lease()?;
        let mut record = self.read()?.ok_or(Error::NotInitialized)?;
        let mut vault = self.open(&mut record)?;
        let (result, _) = vault.transact(operation)?;
        self.protect(&mut record, &mut vault)?;
        Ok(result)
    }
    /// Persist a keyless tombstone before unlinking the encrypted files. Keep
    /// the lock and tombstone: old backups must never revive this incarnation.
    pub fn retire(&self) -> Result<(), Error> {
        let _lease = self.lease()?;
        let current = self.read()?;
        let retired = Secret {
            version: 1,
            scope: self.scope.clone(),
            location: self.location()?,
            key: None,
            checkpoint: None,
            retired: true,
        };
        if current.as_ref() != Some(&retired) {
            self.write(current.as_ref(), &retired)?;
        }
        for suffix in [".sqlite", ".sqlite-wal", ".sqlite-shm"] {
            match fs::remove_file(self.directory.join(format!("{}{suffix}", self.name))) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(Error::Storage),
            }
        }
        #[cfg(unix)]
        File::open(&self.directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| Error::Storage)?;
        Ok(())
    }
}

#[cfg(all(
    feature = "system-keystore",
    any(target_os = "linux", target_os = "macos", target_os = "windows")
))]
pub mod system {
    use super::*;
    /// Dedicated service, outside the legacy/session account index. Always
    /// explicit native platform features; Android needs its own Keystore bridge.
    pub struct Keyring;
    const SERVICE: &str = "me.barrut.RocketVibe.crypto.v1";
    impl Storage for Keyring {
        fn read(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
            match keyring::Entry::new(SERVICE, name)
                .map_err(|_| Error::Storage)?
                .get_secret()
            {
                Ok(value) => Ok(Some(Zeroizing::new(value))),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(Error::Storage),
            }
        }
        fn write(&self, name: &str, value: &[u8]) -> Result<(), Error> {
            keyring::Entry::new(SERVICE, name)
                .and_then(|entry| entry.set_secret(value))
                .map_err(|_| Error::Storage)
        }
    }
}

#[cfg(test)]
mod tests;
