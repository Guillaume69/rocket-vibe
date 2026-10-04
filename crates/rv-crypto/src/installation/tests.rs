use super::*;
use std::{
    collections::BTreeMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
#[derive(Default)]
struct Memory {
    values: Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>,
    fail: AtomicBool,
}
impl Storage for Memory {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error::Storage);
        }
        Ok(self
            .values
            .lock()
            .unwrap()
            .get(name)
            .map(|v| Zeroizing::new(v.to_vec())))
    }
    fn write(&self, name: &str, bytes: &[u8]) -> Result<(), Error> {
        self.values
            .lock()
            .unwrap()
            .insert(name.into(), Zeroizing::new(bytes.to_vec()));
        Ok(())
    }
}
fn account() -> Account {
    Account {
        origin: "https://server.example".into(),
        instance: "instance".into(),
        data_epoch: "epoch".into(),
        user: "user".into(),
        device: "device".into(),
    }
}
#[test]
fn selection_reopens_the_same_vault_and_never_falls_back_on_storage_failure() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("private");
    let storage = Arc::new(Memory::default());
    let slot = Installation::new(path.clone(), account(), storage.clone()).unwrap();
    assert!(slot.load().unwrap().is_none());
    assert!(storage.values.lock().unwrap().is_empty());
    let manager = slot.initialize().unwrap();
    manager
        .transact(|_, records| {
            records.insert("original".into(), vec![42]);
            Ok(())
        })
        .unwrap();
    let reopened = Installation::new(path.clone(), account(), storage.clone())
        .unwrap()
        .load()
        .unwrap()
        .unwrap();
    assert!(reopened.scope() == manager.scope());
    assert_eq!(
        reopened
            .inspect(|_, records| Ok(records["original"].clone()))
            .unwrap(),
        vec![42]
    );
    storage.fail.store(true, Ordering::SeqCst);
    assert!(matches!(slot.load(), Err(Error::Storage)));
    assert!(matches!(slot.initialize(), Err(Error::Storage)));
    storage.fail.store(false, Ordering::SeqCst);
    let copied = Installation::new(temp.path().join("other"), account(), storage.clone()).unwrap();
    assert!(matches!(copied.load(), Err(Error::Integrity)));
    manager.retire().unwrap();
    assert!(matches!(slot.initialize(), Err(Error::Retired)));
}
#[test]
fn interrupted_initialization_keeps_the_selected_incarnation_and_family_lock() {
    let temp = tempfile::tempdir().unwrap();
    let storage = Arc::new(Memory::default());
    let slot = Installation::new(temp.path().join("private"), account(), storage.clone()).unwrap();
    let lease = protected::lease(&slot.directory, &slot.name).unwrap();
    assert!(matches!(slot.initialize(), Err(Error::Busy)));
    drop(lease);
    let selection = Selection {
        version: 1,
        scope: account().scope("01010101010101010101010101010101".into()),
        location: slot.location().unwrap(),
    };
    storage
        .write(&slot.name, &serde_json::to_vec(&selection).unwrap())
        .unwrap();
    let manager = slot.load().unwrap().unwrap();
    assert_eq!(
        manager.inspect(|_, _| Ok(())).unwrap_err(),
        Error::NotInitialized
    );
    let manager = slot.initialize().unwrap();
    assert_eq!(manager.scope().incarnation, selection.scope.incarnation);
    let mut other = account();
    other.device = "new-http-device".into();
    let other = Installation::new(slot.directory.clone(), other, storage).unwrap();
    assert!(other.load().unwrap().is_none());
    let mut clone_server = account();
    clone_server.origin = "https://other.example".into();
    let clone_server =
        Installation::new(slot.directory.clone(), clone_server, slot.storage.clone()).unwrap();
    assert!(clone_server.load().unwrap().is_none());
}
