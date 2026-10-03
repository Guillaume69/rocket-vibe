use super::*;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::{collections::BTreeMap, path::Path, time::Duration};

#[derive(Default)]
struct Fixture {
    items: Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>,
    writes: AtomicUsize,
    fail_at: AtomicUsize,
    fail_after: AtomicBool,
    unavailable: AtomicBool,
}
impl Storage for Fixture {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(Error::Storage);
        }
        Ok(self
            .items
            .lock()
            .unwrap()
            .get(name)
            .map(|bytes| Zeroizing::new(bytes.to_vec())))
    }
    fn write(&self, name: &str, value: &[u8]) -> Result<(), Error> {
        let fail =
            self.writes.fetch_add(1, Ordering::SeqCst) + 1 == self.fail_at.load(Ordering::SeqCst);
        if fail && !self.fail_after.load(Ordering::SeqCst) {
            return Err(Error::Storage);
        }
        self.items
            .lock()
            .unwrap()
            .insert(name.into(), Zeroizing::new(value.to_vec()));
        if fail { Err(Error::Storage) } else { Ok(()) }
    }
}
fn scope() -> Scope {
    Scope {
        instance: "instance".into(),
        data_epoch: "epoch".into(),
        user: "alice".into(),
        device: "device".into(),
        incarnation: "incarnation".into(),
    }
}
fn test_manager(directory: &Path, storage: Arc<dyn Storage>) -> Manager {
    Manager::new(directory.to_owned(), scope(), storage).unwrap()
}
fn private_directory() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    directory
}

#[test]
fn unavailable_or_missing_keystore_never_overwrites_an_existing_database() {
    let directory = private_directory();
    let storage = Arc::new(Fixture::default());
    let manager = test_manager(directory.path(), storage.clone());
    storage.unavailable.store(true, Ordering::SeqCst);
    assert_eq!(manager.initialize(), Err(Error::Storage));
    assert!(!manager.path().exists());
    storage.unavailable.store(false, Ordering::SeqCst);
    storage.fail_at.store(1, Ordering::SeqCst);
    assert_eq!(manager.initialize(), Err(Error::Storage));
    assert!(!manager.path().exists());
    manager.initialize().unwrap();
    manager
        .transact(|_, records| {
            records.insert("original".into(), b"Fixture private row".to_vec());
            Ok(())
        })
        .unwrap();
    let copy = fs::read(manager.path()).unwrap();
    storage.items.lock().unwrap().clear();
    assert_eq!(manager.initialize(), Err(Error::NotInitialized));
    assert_eq!(manager.inspect(|_, _| Ok(())), Err(Error::NotInitialized));
    assert_eq!(fs::read(manager.path()).unwrap(), copy);
}

#[test]
fn interrupted_initial_checkpoint_recovers_only_pristine_genesis() {
    let directory = private_directory();
    let storage = Arc::new(Fixture::default());
    storage.fail_at.store(2, Ordering::SeqCst);
    let manager = test_manager(directory.path(), storage.clone());
    assert_eq!(manager.initialize(), Err(Error::Storage));
    assert!(manager.path().exists());
    assert!(manager.read().unwrap().unwrap().checkpoint.is_none());
    assert_eq!(manager.inspect(|_, _| Ok(())), Err(Error::NotInitialized));
    manager.initialize().unwrap();
    assert_eq!(manager.inspect(|_, records| Ok(records.len())), Ok(0));
    manager
        .transact(|_, records| {
            records.insert("private".into(), vec![1]);
            Ok(())
        })
        .unwrap();
    let mut record = manager.read().unwrap().unwrap();
    record.checkpoint = None;
    let bytes = Zeroizing::new(serde_json::to_vec(&record).unwrap());
    storage
        .items
        .lock()
        .unwrap()
        .insert(manager.name.clone(), bytes);
    assert_eq!(manager.initialize(), Err(Error::Stale));
    assert_eq!(manager.transact(|_, _| Ok(())), Err(Error::NotInitialized));
}

#[test]
fn failed_and_ambiguous_platform_writes_hide_output_and_recover_the_original_outbox() {
    let directory = private_directory();
    let storage = Arc::new(Fixture::default());
    let manager = test_manager(directory.path(), storage.clone());
    manager.initialize().unwrap();
    storage.fail_at.store(3, Ordering::SeqCst);
    assert_eq!(
        manager.transact(|_, records| {
            records.insert(
                "original-ciphertext".into(),
                b"Fixture outbound bytes".to_vec(),
            );
            Ok(b"Fixture outbound bytes".to_vec())
        }),
        Err(Error::Storage)
    );
    // A fresh manager reloads both authorities, confirms the authenticated successor,
    // and returns the original outbox instead of preparing another encryption.
    let reopened = test_manager(directory.path(), storage.clone());
    assert_eq!(
        reopened
            .inspect(|_, records| Ok(records["original-ciphertext"].clone()))
            .unwrap(),
        b"Fixture outbound bytes"
    );
    storage.fail_at.store(5, Ordering::SeqCst);
    storage.fail_after.store(true, Ordering::SeqCst);
    assert_eq!(
        reopened.transact(|_, records| {
            records.insert("private-inbox".into(), b"Fixture plaintext".to_vec());
            Ok(b"Fixture plaintext".to_vec())
        }),
        Err(Error::Storage)
    );
    assert_eq!(
        manager
            .inspect(|_, records| Ok(records["private-inbox"].clone()))
            .unwrap(),
        b"Fixture plaintext"
    );
    assert_eq!(storage.writes.load(Ordering::SeqCst), 5);
}
#[test]
fn retirement_is_durable_repeatable_and_cannot_revive_a_restored_incarnation() {
    let directory = private_directory();
    let storage = Arc::new(Fixture::default());
    let manager = test_manager(directory.path(), storage.clone());
    manager.initialize().unwrap();
    manager
        .transact(|_, records| {
            records.insert("private".into(), vec![1]);
            Ok(())
        })
        .unwrap();
    let copy = fs::read(manager.path()).unwrap();
    storage.fail_at.store(4, Ordering::SeqCst);
    assert_eq!(manager.retire(), Err(Error::Storage));
    assert!(manager.path().exists());
    assert_eq!(manager.inspect(|_, records| Ok(records.len())), Ok(1));
    manager.retire().unwrap();
    let tombstone = manager.read().unwrap().unwrap();
    assert!(tombstone.retired && tombstone.key.is_none() && tombstone.checkpoint.is_none());
    assert!(!manager.path().exists());
    fs::write(manager.path(), copy).unwrap();
    assert_eq!(manager.initialize(), Err(Error::Retired));
    assert_eq!(manager.inspect(|_, _| Ok(())), Err(Error::Retired));
    manager.retire().unwrap();
    manager.retire().unwrap();
    assert!(!manager.path().exists());
    assert_eq!(manager.initialize(), Err(Error::Retired));
}

#[test]
fn a_database_copy_cannot_fork_the_same_device_with_a_different_directory_lock() {
    let original = private_directory();
    let copied = private_directory();
    let storage = Arc::new(Fixture::default());
    let first = test_manager(original.path(), storage.clone());
    first.initialize().unwrap();
    let second = test_manager(copied.path(), storage.clone());
    fs::copy(first.path(), second.path()).unwrap();
    assert_eq!(second.inspect(|_, _| Ok(())), Err(Error::Integrity));
    assert_eq!(second.initialize(), Err(Error::Integrity));
    assert_eq!(second.transact(|_, _| Ok(())), Err(Error::Integrity));
    assert_eq!(storage.writes.load(Ordering::SeqCst), 2);
    assert_eq!(first.inspect(|_, records| Ok(records.len())), Ok(0));
}

struct Delayed {
    fixture: Fixture,
    delay: AtomicBool,
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}

#[test]
fn completed_lease_unlocks_even_while_a_child_style_descriptor_copy_exists() {
    let directory = private_directory();
    let storage = Arc::new(Fixture::default());
    let manager = test_manager(directory.path(), storage);
    let lease = manager.lease().unwrap();
    let inherited = lease.0.try_clone().unwrap();
    assert!(matches!(manager.lease(), Err(Error::Busy)));
    drop(lease);
    let next = manager.lease().unwrap();
    drop(next);
    drop(inherited);
}

impl Storage for Delayed {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        self.fixture.read(name)
    }
    fn write(&self, name: &str, value: &[u8]) -> Result<(), Error> {
        if self.delay.swap(false, Ordering::SeqCst) {
            self.entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        }
        self.fixture.write(name, value)
    }
}
#[test]
fn actual_os_lease_survives_an_abandoned_caller_until_the_platform_write_finishes() {
    let directory = private_directory();
    let (entered, ready) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let storage = Arc::new(Delayed {
        fixture: Fixture::default(),
        delay: AtomicBool::new(false),
        entered,
        release: Mutex::new(wait),
    });
    let first = test_manager(directory.path(), storage.clone());
    first.initialize().unwrap();
    let second = test_manager(directory.path(), storage.clone());
    storage.delay.store(true, Ordering::SeqCst);
    let (sent, result) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        sent.send(first.transact(|_, records| {
            records.insert("durable".into(), vec![9]);
            Ok(())
        }))
        .unwrap();
    });
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(worker); // The caller goes away; the owned worker must retain its lease.
    assert_eq!(second.inspect(|_, _| Ok(())), Err(Error::Busy));
    release.send(()).unwrap();
    assert_eq!(result.recv_timeout(Duration::from_secs(5)).unwrap(), Ok(()));
    assert_eq!(
        second.inspect(|_, records| Ok(records["durable"].clone())),
        Ok(vec![9])
    );
}

#[cfg(unix)]
#[test]
fn public_directory_and_symbolic_lock_are_rejected_before_touching_the_keystore() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let directory = private_directory();
    let storage = Arc::new(Fixture::default());
    let manager = test_manager(directory.path(), storage.clone());
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(manager.initialize(), Err(Error::Storage));
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let target = directory.path().join("unrelated");
    fs::write(&target, b"Fixture unrelated file").unwrap();
    symlink(
        &target,
        directory.path().join(format!("{}.lock", manager.name)),
    )
    .unwrap();
    assert_eq!(manager.initialize(), Err(Error::Storage));
    assert_eq!(storage.writes.load(Ordering::SeqCst), 0);
    assert_eq!(fs::read(&target).unwrap(), b"Fixture unrelated file");
}
