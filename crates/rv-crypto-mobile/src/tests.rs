use super::*;
use std::collections::BTreeMap;
#[derive(Default)]
struct Keystore {
    items: Mutex<BTreeMap<String, Vec<u8>>>,
    writes: Mutex<usize>,
    unavailable: AtomicBool,
}
impl ProtectedKeystore for Keystore {
    fn read(&self, name: String) -> Result<Option<Vec<u8>>> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(CryptoBridgeError::Storage);
        }
        Ok(self.items.lock().unwrap().get(&name).cloned())
    }
    fn write(&self, name: String, value: Vec<u8>) -> Result<()> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(CryptoBridgeError::Storage);
        }
        *self.writes.lock().unwrap() += 1;
        self.items.lock().unwrap().insert(name, value);
        Ok(())
    }
}
fn account() -> CryptoAccount {
    CryptoAccount {
        origin: "https://example.org".into(),
        instance: "instance".into(),
        data_epoch: "epoch".into(),
        user: "alice".into(),
        device: "android".into(),
    }
}
fn open(path: &std::path::Path, key: Arc<Keystore>) -> Arc<CryptoInstallation> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    CryptoInstallation::open(path.to_string_lossy().into(), account(), key).unwrap()
}
#[test]
fn scope_read_does_not_initialize_and_explicit_storage_reopens_only_original_incarnation() {
    let directory = tempfile::tempdir().unwrap();
    let key = Arc::new(Keystore::default());
    let view = open(directory.path(), key.clone());
    let missing = view.status().unwrap();
    assert!(missing.phase == InstallationPhase::Missing);
    assert_eq!(*key.writes.lock().unwrap(), 0);
    assert!(view.initialize("aa".repeat(32)).is_err());
    let ready = view
        .initialize(missing.account_fingerprint.clone())
        .unwrap();
    assert!(ready.phase == InstallationPhase::Ready && ready.incarnation.len() == 32);
    view.stop();
    assert!(view.status().is_err());
    assert!(view.initialize(missing.account_fingerprint).is_err());
    let reopened = open(directory.path(), key.clone());
    let current = reopened.status().unwrap();
    assert_eq!(current.incarnation, ready.incarnation);
    key.unavailable.store(true, Ordering::SeqCst);
    let writes = *key.writes.lock().unwrap();
    assert!(reopened.status().is_err());
    assert!(
        reopened
            .initialize(current.account_fingerprint.clone())
            .is_err()
    );
    assert_eq!(*key.writes.lock().unwrap(), writes);
    key.unavailable.store(false, Ordering::SeqCst);
    reopened.retire(current.account_fingerprint).unwrap();
    assert!(reopened.is_closed());
    assert!(open(directory.path(), key).status().is_err());
}
#[test]
fn copied_coffer_and_substituted_account_cannot_open_the_original_platform_record() {
    let directory = tempfile::tempdir().unwrap();
    let copy = tempfile::tempdir().unwrap();
    let key = Arc::new(Keystore::default());
    let original = open(directory.path(), key.clone());
    let status = original.status().unwrap();
    original.initialize(status.account_fingerprint).unwrap();
    assert!(open(copy.path(), key.clone()).status().is_err());
    let mut wrong = account();
    wrong.user = "bob".into();
    let other =
        CryptoInstallation::open(directory.path().to_string_lossy().into(), wrong, key).unwrap();
    assert!(other.status().unwrap().phase == InstallationPhase::Missing);
    assert_ne!(
        other.status().unwrap().account_fingerprint,
        original.status().unwrap().account_fingerprint
    );
}

#[test]
fn origin_normalization_keeps_distinct_base_paths_and_rejects_credentials_or_queries() {
    let directory = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let key = Arc::new(Keystore::default());
    let select = |origin: &str| {
        let mut scoped = account();
        scoped.origin = origin.into();
        CryptoInstallation::open(
            directory.path().to_string_lossy().into(),
            scoped,
            key.clone(),
        )
    };
    let root = select("https://example.org").unwrap().status().unwrap();
    let slash = select("https://example.org/").unwrap().status().unwrap();
    assert_eq!(root.account_fingerprint, slash.account_fingerprint);
    let path = select("https://example.org/tenant")
        .unwrap()
        .status()
        .unwrap();
    let path_slash = select("https://example.org/tenant/")
        .unwrap()
        .status()
        .unwrap();
    assert_ne!(path.account_fingerprint, path_slash.account_fingerprint);
    assert!(select("https://user:password@example.org").is_err());
    assert!(select("https://example.org/?query=1").is_err());
    assert!(select("https://example.org/#fragment").is_err());
    assert_eq!(*key.writes.lock().unwrap(), 0);
}
