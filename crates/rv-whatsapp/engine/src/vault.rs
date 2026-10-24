//! The sealed state: one file, AES-256-GCM under a 32-byte key from the
//! system keychain, written whole through a temporary file. Nothing of the
//! account reaches the disk unsealed; a state without its key fails closed.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::Rng;
use sha2::{Digest, Sha256};

const HEADER: &[u8] = b"RVWA2";
/// The Go helper's sealed SQLite: unreadable here, the device links again.
const GO_HEADER: &[u8] = b"RVWA1";
const NONCE: usize = 12;
const MAX_STATE: u64 = 128 << 20;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("the state is held by another engine")]
    Busy,
    #[error("the state was written by the previous engine")]
    PreviousEngine,
    #[error("the state does not open with this key")]
    Unreadable,
    #[error("the state is too large")]
    TooLarge,
    #[error("storage: {0}")]
    Io(#[from] std::io::Error),
}

pub struct Vault {
    path: PathBuf,
    aead: Aes256Gcm,
    _lock: File,
    inner: Mutex<Inner>,
}

struct Inner {
    sealed: [u8; 32],
    revoked: bool,
}

impl Vault {
    /// Opens the state at `path` under its lock; the plaintext it held, if any.
    pub fn open(path: &Path, key: &[u8]) -> Result<(Self, Option<Vec<u8>>), VaultError> {
        let key: [u8; 32] = key.try_into().map_err(|_| VaultError::Unreadable)?;
        if let Some(dir) = path.parent() {
            create_private_dir(dir)?;
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(lock_path(path))?;
        if lock.try_lock().is_err() {
            return Err(VaultError::Busy);
        }
        let aead = Aes256Gcm::new(&key.into());
        let mut vault = Self {
            path: path.to_owned(),
            aead,
            _lock: lock,
            inner: Mutex::new(Inner {
                sealed: [0; 32],
                revoked: false,
            }),
        };
        let plain = match fs::metadata(path) {
            Ok(meta) if meta.len() > MAX_STATE => return Err(VaultError::TooLarge),
            Ok(_) => Some(vault.unseal(&fs::read(path)?)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        if let Some(plain) = &plain {
            vault.inner.get_mut().expect("not shared yet").sealed = Sha256::digest(plain).into();
        }
        Ok((vault, plain))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn unseal(&self, blob: &[u8]) -> Result<Vec<u8>, VaultError> {
        if blob.starts_with(GO_HEADER) {
            return Err(VaultError::PreviousEngine);
        }
        if blob.is_empty() || !blob.starts_with(HEADER) || blob.len() < HEADER.len() + NONCE + 16 {
            return Err(VaultError::Unreadable);
        }
        let (nonce, sealed) = blob[HEADER.len()..].split_at(NONCE);
        let nonce = Nonce::try_from(nonce).map_err(|_| VaultError::Unreadable)?;
        self.aead
            .decrypt(
                &nonce,
                Payload {
                    msg: sealed,
                    aad: HEADER,
                },
            )
            .map_err(|_| VaultError::Unreadable)
    }

    /// Writes `plain` sealed, unless it is what was last written.
    pub fn seal(&self, plain: &[u8]) -> Result<(), VaultError> {
        let mut inner = self.inner.lock().expect("vault lock");
        if inner.revoked {
            return Ok(());
        }
        if plain.len() as u64 > MAX_STATE - 128 {
            return Err(VaultError::TooLarge);
        }
        let digest: [u8; 32] = Sha256::digest(plain).into();
        if digest == inner.sealed {
            return Ok(());
        }
        let mut nonce = [0u8; NONCE];
        rand::rng().fill_bytes(&mut nonce);
        let sealed = self
            .aead
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: plain,
                    aad: HEADER,
                },
            )
            .map_err(|_| VaultError::Unreadable)?;
        let mut blob = Vec::with_capacity(HEADER.len() + NONCE + sealed.len());
        blob.extend_from_slice(HEADER);
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&sealed);
        write_atomically(&self.path, &blob)?;
        inner.sealed = digest;
        Ok(())
    }

    /// Erases the state; later seals write nothing.
    pub fn revoke(&self) -> Result<(), VaultError> {
        let mut inner = self.inner.lock().expect("vault lock");
        inner.revoked = true;
        match fs::remove_file(&self.path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

fn lock_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

fn write_atomically(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mut suffix = [0u8; 8];
    rand::rng().fill_bytes(&mut suffix);
    let tmp = dir.join(format!(
        ".state-{}",
        suffix
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let mut name = [0u8; 8];
        rand::rng().fill_bytes(&mut name);
        std::env::temp_dir().join(format!(
            "rv-vault-test-{}",
            name.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ))
    }

    #[test]
    fn a_state_reopens_with_its_key_only() {
        let path = dir().join("state");
        let (vault, plain) = Vault::open(&path, &[7; 32]).unwrap();
        assert!(plain.is_none());
        vault.seal(b"account").unwrap();
        assert!(
            !fs::read(&path).unwrap().windows(7).any(|w| w == b"account"),
            "nothing unsealed on disk"
        );
        drop(vault);
        let (_, plain) = Vault::open(&path, &[7; 32]).unwrap();
        assert_eq!(plain.as_deref(), Some(&b"account"[..]));
        assert!(matches!(
            Vault::open(&path, &[8; 32]),
            Err(VaultError::Unreadable)
        ));
    }

    #[test]
    fn a_held_state_is_busy_and_a_go_state_is_refused() {
        let path = dir().join("state");
        let (_held, _) = Vault::open(&path, &[1; 32]).unwrap();
        assert!(matches!(
            Vault::open(&path, &[1; 32]),
            Err(VaultError::Busy)
        ));
        let other = dir().join("state");
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(&other, b"RVWA1 sealed sqlite").unwrap();
        assert!(matches!(
            Vault::open(&other, &[1; 32]),
            Err(VaultError::PreviousEngine)
        ));
    }

    #[test]
    fn a_revoked_state_is_gone_and_stays_gone() {
        let path = dir().join("state");
        let (vault, _) = Vault::open(&path, &[2; 32]).unwrap();
        vault.seal(b"x").unwrap();
        vault.revoke().unwrap();
        vault.seal(b"y").unwrap();
        assert!(!path.exists());
    }
}
