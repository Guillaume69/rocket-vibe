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
fn private_blocks_and_index_recover_after_failed_protected_checkpoint_without_early_output() {
    let directory = private_directory();
    let storage = Arc::new(Fixture::default());
    let manager = test_manager(directory.path(), storage.clone());
    manager.initialize().unwrap();
    storage
        .fail_at
        .store(storage.writes.load(Ordering::SeqCst) + 1, Ordering::SeqCst);
    let result = manager.transact_with_blobs(|_, records, blocks| {
        let reference = blocks.put(b"protected private archive fixture")?;
        records.insert(
            "archive-reference".into(),
            serde_json::to_vec(&reference).unwrap(),
        );
        Ok(reference)
    });
    assert!(
        result.err() == Some(Error::Storage),
        "No reference escapes before its protected checkpoint"
    );
    storage.fail_at.store(0, Ordering::SeqCst);
    let reopened = test_manager(directory.path(), storage.clone());
    reopened
        .inspect_with_blobs(|_, records, blocks| {
            let reference: crate::vault::blobs::Reference =
                serde_json::from_slice(&records["archive-reference"]).unwrap();
            assert!(blocks.read(&reference)?.as_slice() == b"protected private archive fixture");
            Ok(())
        })
        .unwrap();
    let count: i64 = rusqlite::Connection::open(reopened.path())
        .unwrap()
        .query_row("SELECT count(*) FROM private_blobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1, "The recovered original is not appended twice");
    storage.unavailable.store(true, Ordering::SeqCst);
    assert!(reopened.inspect_with_blobs(|_, _, _| Ok(())).err() == Some(Error::Storage));
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
fn a_short_operation_in_progress_is_waited_for_not_reported_busy() {
    let directory = private_directory();
    let storage = Arc::new(Fixture::default());
    let manager = Arc::new(test_manager(directory.path(), storage));
    let held = manager.lease().unwrap();
    let (taken, waited) = mpsc::channel();
    let other = manager.clone();
    let waiter = std::thread::spawn(move || {
        taken.send(()).unwrap();
        other.lease().map(drop)
    });
    waited.recv().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    drop(held);
    assert_eq!(waiter.join().unwrap(), Ok(()));
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

fn stored(manager: &Manager) -> Secret {
    manager.read().unwrap().unwrap()
}
/// Two blocks, the second naming the first inside its sealed content, both
/// referenced from protected records.
fn archive(
    manager: &Manager,
) -> (
    crate::vault::blobs::Reference,
    crate::vault::blobs::Reference,
) {
    manager
        .transact_with_blobs(|_, records, blocks| {
            let first = blocks.put(b"first private block")?;
            let second = blocks.put(&serde_json::to_vec(&first).unwrap())?;
            records.insert("archive-head".into(), serde_json::to_vec(&second).unwrap());
            Ok((first, second))
        })
        .unwrap()
}
fn read_back(manager: &Manager, second: crate::vault::blobs::Reference) -> Vec<u8> {
    manager
        .inspect_with_blobs(|_, records, blocks| {
            let head: crate::vault::blobs::Reference =
                serde_json::from_slice(&records["archive-head"]).unwrap();
            assert!(head == second);
            let first: crate::vault::blobs::Reference =
                serde_json::from_slice(&blocks.read(&head)?).unwrap();
            Ok(blocks.read(&first)?.to_vec())
        })
        .unwrap()
}

#[test]
fn storage_key_rotation_reseals_everything_and_leaves_no_old_key() {
    let directory = private_directory();
    let storage = Arc::new(Fixture::default());
    let manager = test_manager(directory.path(), storage.clone());
    manager.initialize().unwrap();
    let (_, second) = archive(&manager);
    let before = stored(&manager);
    let old = before.key.unwrap();
    assert_eq!(manager.rotated_at().unwrap(), None);
    manager.rotate(1_000).unwrap();
    let after = stored(&manager);
    assert!(after.key.unwrap() != old && after.next.is_none());
    assert_eq!(
        after.checkpoint.unwrap().revision,
        before.checkpoint.unwrap().revision + 1
    );
    // References made before the rotation, nested ones included, still hold.
    assert_eq!(read_back(&manager, second), b"first private block");
    assert_eq!(manager.rotated_at().unwrap(), Some(1_000));
    // The old key opens nothing any more; the WAL frames under it are gone.
    assert!(
        crate::vault::Vault::open(
            &manager.path(),
            scope(),
            Key::from_keystore(old),
            after.checkpoint.unwrap()
        )
        .is_err()
    );
    let wal = directory
        .path()
        .join(format!("{}.sqlite-wal", manager.name));
    assert!(fs::metadata(&wal).map(|m| m.len() == 0).unwrap_or(true));
    // New blocks and a second rotation work on top.
    let (_, third) = archive(&manager);
    manager.rotate(2_000).unwrap();
    assert_eq!(read_back(&manager, third), b"first private block");
    // Due only after the period.
    assert!(
        !manager
            .rotate_if_due(2_000 + ROTATION_PERIOD - 1, ROTATION_PERIOD)
            .unwrap()
    );
    assert!(
        manager
            .rotate_if_due(2_000 + ROTATION_PERIOD, ROTATION_PERIOD)
            .unwrap()
    );
    assert_eq!(manager.rotated_at().unwrap(), Some(2_000 + ROTATION_PERIOD));
}

#[test]
fn an_interrupted_rotation_resumes_on_either_side_of_its_commit() {
    // The intent write fails: nothing changed, the old key still opens.
    let directory = private_directory();
    let storage = Arc::new(Fixture::default());
    let manager = test_manager(directory.path(), storage.clone());
    manager.initialize().unwrap();
    let (_, second) = archive(&manager);
    let old = stored(&manager).key.unwrap();
    storage
        .fail_at
        .store(storage.writes.load(Ordering::SeqCst) + 1, Ordering::SeqCst);
    assert!(manager.rotate(10).is_err());
    assert!(stored(&manager).key == Some(old) && stored(&manager).next.is_none());
    assert_eq!(read_back(&manager, second), b"first private block");

    // Committed under the next key, the final write lost: the next opening
    // recovers the rotated state with the next key and forgets the old one.
    storage
        .fail_at
        .store(storage.writes.load(Ordering::SeqCst) + 2, Ordering::SeqCst);
    assert!(manager.rotate(20).is_err());
    let intent = stored(&manager);
    assert!(intent.key == Some(old) && intent.next.is_some());
    let reopened = test_manager(directory.path(), storage.clone());
    assert_eq!(read_back(&reopened, second), b"first private block");
    let recovered = stored(&reopened);
    assert!(recovered.key == intent.next && recovered.next.is_none());
    assert_eq!(reopened.rotated_at().unwrap(), Some(20));

    // The final write landed but answered an error: already consistent.
    storage.fail_after.store(true, Ordering::SeqCst);
    storage
        .fail_at
        .store(storage.writes.load(Ordering::SeqCst) + 2, Ordering::SeqCst);
    assert!(reopened.rotate(30).is_err());
    storage.fail_after.store(false, Ordering::SeqCst);
    assert_eq!(read_back(&reopened, second), b"first private block");
    assert_eq!(reopened.rotated_at().unwrap(), Some(30));

    // An intent left before any commit: the next key sealed nothing and goes.
    let mut orphan = stored(&reopened);
    let current = orphan.key;
    orphan.next = Some([9; 32]);
    let expected = stored(&reopened);
    reopened.write(Some(&expected), &orphan).unwrap();
    assert_eq!(read_back(&reopened, second), b"first private block");
    assert!(stored(&reopened).key == current && stored(&reopened).next.is_none());
}
