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
/// Protected record of the last storage key rotation (seconds since epoch).
const ROTATED: &str = "vault-key-rotated-at-v1";
/// Automatic rotation period of the storage key.
pub const ROTATION_PERIOD: u64 = 30 * 86400;

pub(crate) struct Lease(File);
impl Drop for Lease {
    fn drop(&mut self) {
        // Explicit unlock also releases a briefly inherited descriptor while
        // another thread spawns a child; closing this handle alone can leave
        // flock held until that child execs/closes its inherited descriptor.
        #[cfg(not(target_os = "android"))]
        let _ = self.0.unlock();
        #[cfg(target_os = "android")]
        let _ = rustix::fs::flock(&self.0, rustix::fs::FlockOperation::Unlock);
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
    /// A storage key rotation in progress: the next key, saved before the
    /// SQLite commit that seals the vault under it, removed after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    next: Option<[u8; 32]>,
}
impl Secret {
    fn valid(&self, scope: &Scope, location: [u8; 32]) -> bool {
        self.version == 1
            && self.scope == *scope
            && self.location == location
            && if self.retired {
                self.key.is_none() && self.checkpoint.is_none() && self.next.is_none()
            } else {
                self.key.is_some()
                    && self.checkpoint.is_none_or(|c| c.revision >= 0)
                    && (self.next.is_none() || self.checkpoint.is_some())
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
        if let Some(key) = &mut self.next {
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
    /// Public account/device scope, including the incarnation bound by the
    /// protected record. It contains no key or checkpoint state.
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    /// Only the same physical protected installation may share a dispatch
    /// queue. A copied database with the same public scope is a different one.
    pub fn same_installation(&self, other: &Self) -> Result<bool, Error> {
        Ok(self.scope == other.scope && self.location()? == other.location()?)
    }
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
        lease(&self.directory, &self.name)
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
        let key = record.key;
        self.protect_with(record, key, vault)
    }
    /// Replaces the stored `record` with `key` and the vault's checkpoint, no
    /// rotation in progress, then releases the vault.
    fn protect_with(
        &self,
        record: &mut Secret,
        key: Option<[u8; 32]>,
        vault: &mut Vault,
    ) -> Result<(), Error> {
        let next = Secret {
            version: 1,
            scope: self.scope.clone(),
            location: self.location()?,
            key,
            checkpoint: Some(vault.checkpoint()),
            retired: false,
            next: None,
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
            Ok(mut vault) => {
                if record.next.is_some() {
                    // A rotation stopped before its commit: the next key never
                    // sealed anything. Forget it; a later rotation draws anew.
                    self.protect(record, &mut vault)?;
                }
                Ok(vault)
            }
            Err(Error::Stale) => {
                let recovered = Vault::recover_committed(
                    &self.path(),
                    self.scope.clone(),
                    record.key()?,
                    marker,
                );
                let (mut vault, key) = match (recovered, record.next) {
                    // A rotation committed but not yet protected: the state
                    // one revision ahead is sealed under the next key.
                    (Err(Error::Integrity), Some(next)) => (
                        Vault::recover_committed(
                            &self.path(),
                            self.scope.clone(),
                            Key::from_keystore(next),
                            marker,
                        )?,
                        Some(next),
                    ),
                    (result, _) => (result?, record.key),
                };
                self.protect_with(record, key, &mut vault)?;
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
                    next: None,
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
        self.inspect_with_blobs(|provider, records, _| operation(provider, records))
    }
    pub fn inspect_with_blobs<T>(
        &self,
        operation: impl FnOnce(
            &OpenMlsRustCrypto,
            &Records,
            &crate::vault::blobs::Access<'_>,
        ) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let _lease = self.lease()?;
        let mut record = self.read()?.ok_or(Error::NotInitialized)?;
        self.open(&mut record)?.inspect_with_blobs(operation)
    }
    /// The callback has no network/UI side effects. Output is returned only
    /// after the protected checkpoint is saved and read back under the OS lease.
    pub fn transact<T>(
        &self,
        operation: impl FnOnce(&OpenMlsRustCrypto, &mut Records) -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.transact_with_blobs(|provider, records, _| operation(provider, records))
    }
    pub fn transact_with_blobs<T>(
        &self,
        operation: impl FnOnce(
            &OpenMlsRustCrypto,
            &mut Records,
            &mut crate::vault::blobs::Access<'_>,
        ) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let _lease = self.lease()?;
        let mut record = self.read()?.ok_or(Error::NotInitialized)?;
        let mut vault = self.open(&mut record)?;
        let (result, _) = vault.transact_with_blobs(operation)?;
        self.protect(&mut record, &mut vault)?;
        Ok(result)
    }
    /// Rotates the storage key: a fresh key is saved as the next one, the vault
    /// and its blocks are sealed again under it in one commit, then the
    /// protected record keeps only the fresh key and the new checkpoint. The
    /// old key no longer exists anywhere, so old copies of the database (WAL,
    /// backups, flash remnants) stay sealed for good. A crash at any step
    /// resumes on either side at the next opening.
    pub fn rotate(&self, now: u64) -> Result<(), Error> {
        let _lease = self.lease()?;
        let mut record = self.read()?.ok_or(Error::NotInitialized)?;
        let mut vault = self.open(&mut record)?;
        let next = Key::generate()?;
        let intent = Secret {
            version: 1,
            scope: self.scope.clone(),
            location: self.location()?,
            key: record.key,
            checkpoint: record.checkpoint,
            retired: false,
            next: Some(*next.for_keystore()),
        };
        self.write(Some(&record), &intent)?;
        record = intent;
        let fresh = *next.for_keystore();
        vault.rotate(next, |records| {
            records.insert(ROTATED.into(), now.to_string().into_bytes());
        })?;
        self.protect_with(&mut record, Some(fresh), &mut vault)?;
        vault.scrub()
    }
    /// When the storage key was last rotated, if ever.
    pub fn rotated_at(&self) -> Result<Option<u64>, Error> {
        self.inspect(|_, records| {
            records
                .get(ROTATED)
                .map(|v| {
                    std::str::from_utf8(v)
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .ok_or(Error::Integrity)
                })
                .transpose()
        })
    }
    /// Rotates when `period` has passed since the last rotation, or none was
    /// ever made. Whether it rotated.
    pub fn rotate_if_due(&self, now: u64, period: u64) -> Result<bool, Error> {
        if self
            .rotated_at()?
            .is_some_and(|at| at <= now && now - at < period)
        {
            return Ok(false);
        }
        self.rotate(now)?;
        Ok(true)
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
            next: None,
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

pub(crate) fn lease(directory: &std::path::Path, name: &str) -> Result<Lease, Error> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory).map_err(|_| Error::Storage)?;
    let metadata = fs::symlink_metadata(directory).map_err(|_| Error::Storage)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Storage);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != rustix::process::geteuid().as_raw() {
            return Err(Error::Storage);
        }
    }
    let path = directory.join(format!("{}.lock", name));
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
    #[cfg(not(target_os = "android"))]
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => Error::Busy,
        std::fs::TryLockError::Error(_) => Error::Storage,
    })?;
    #[cfg(target_os = "android")]
    rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive).map_err(
        |error| {
            if error == rustix::io::Errno::WOULDBLOCK {
                Error::Busy
            } else {
                Error::Storage
            }
        },
    )?;
    Ok(Lease(file))
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
