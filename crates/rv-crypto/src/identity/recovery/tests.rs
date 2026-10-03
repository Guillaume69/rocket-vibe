use super::*;
use crate::identity::{Pins, enrollment::LocalDevice};
use crate::protected::{Manager, Storage};
use crate::vault::{Error as VaultError, Scope};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};

const NOW: u64 = 1_900_000_000;
fn issuer() -> Issuer {
    Issuer::generate("instance", "alice").unwrap()
}
fn restore(
    backup: &RootBackup,
    secret: &RecoverySecret,
    expected: &Root,
) -> Result<Records, Error> {
    let mut records = Records::new();
    backup.restore(
        secret,
        expected,
        &OpenMlsRustCrypto::default(),
        &mut records,
    )?;
    Ok(records)
}

#[test]
fn recovery_code_roundtrip_checks_typing_without_accepting_passwords_or_unbounded_input() {
    let secret = RecoverySecret::generate().unwrap();
    let code = secret.for_display();
    assert!(code.len() == 78 && code.starts_with("rvk1-"));
    let restored = RecoverySecret::from_code(&code).unwrap();
    assert!(restored.0.as_ref() == secret.0.as_ref());
    let mut upper = Zeroizing::new(code.to_string());
    upper[5..].make_ascii_uppercase();
    assert!(RecoverySecret::from_code(&upper).unwrap().0.as_ref() == secret.0.as_ref());
    let mut typo = Zeroizing::new(code.as_bytes().to_vec());
    typo[5] = if typo[5] == b'0' { b'1' } else { b'0' };
    assert_eq!(
        RecoverySecret::from_code(std::str::from_utf8(&typo).unwrap()).err(),
        Some(Error::Invalid)
    );
    for invalid in ["account-password", "rvk1-short", &"a".repeat(100_000)] {
        assert_eq!(
            RecoverySecret::from_code(invalid).err(),
            Some(Error::Invalid)
        );
    }
    let second = RecoverySecret::generate().unwrap();
    assert!(secret.for_display().as_str() != second.for_display().as_str());
}

#[test]
fn encrypted_root_roundtrip_uses_distinct_nonces_and_preserves_identity_without_old_leaf_state() {
    let issuer = issuer();
    let secret = RecoverySecret::generate().unwrap();
    let backup = RootBackup::seal(&issuer, &secret, NOW).unwrap();
    let second = RootBackup::seal(&issuer, &secret, NOW).unwrap();
    assert_ne!(backup.nonce, second.nonce);
    assert_ne!(backup.header.backup_id, second.header.backup_id);
    assert_ne!(backup.ciphertext, second.ciphertext);
    let private = PrivateRoot {
        root: issuer.root().clone(),
        seed: issuer.signing.to_bytes(),
    };
    let raw_private = Zeroizing::new(serde_json::to_vec(&private).unwrap());
    assert!(
        !backup
            .ciphertext
            .windows(raw_private.len())
            .any(|w| w == raw_private.as_slice())
    );
    let backup = RootBackup::from_bytes(&backup.to_bytes().unwrap()).unwrap();
    let mut records = restore(&backup, &secret, issuer.root()).unwrap();
    let recovered = Issuer::load(&records, "instance", "alice").unwrap();
    assert_eq!(recovered.root(), issuer.root());
    assert_eq!(records.len(), 2); // Root plus the public digest receipt, no old leaf.
    assert_eq!(
        LocalDevice::load(issuer.root(), "mobile", &records).err(),
        Some(Error::Unapproved)
    );
    let mut old_records = Records::new();
    let old = LocalDevice::create(issuer.root(), "mobile", &mut old_records).unwrap();
    let mut fresh = LocalDevice::create(issuer.root(), "mobile", &mut records).unwrap();
    assert_ne!(old.public_key(), fresh.public_key());
    assert_ne!(old.incarnation(), fresh.incarnation());
    let request = fresh.request(NOW, &mut records).unwrap();
    let consent = recovered
        .preview_request(&request, NOW, 3600, &records)
        .unwrap();
    let grant = recovered
        .approve_request(&request, &consent, NOW, &mut records)
        .unwrap();
    fresh.install(&grant, NOW, &mut records).unwrap();
    assert!(fresh.credential(NOW).is_ok());
    // The recovery package never restores old trust or revocations implicitly.
    assert_eq!(
        Pins::load(&records, "instance")
            .unwrap()
            .observe(issuer.root())
            .unwrap(),
        crate::identity::Observation::Unknown
    );
}

#[test]
fn wrong_code_modified_metadata_nonce_ciphertext_and_wrong_expected_root_are_refused() {
    let issuer = issuer();
    let secret = RecoverySecret::generate().unwrap();
    let backup = RootBackup::seal(&issuer, &secret, NOW).unwrap();
    assert_eq!(
        restore(&backup, &RecoverySecret::generate().unwrap(), issuer.root()).err(),
        Some(Error::Recovery)
    );
    for field in 0..5 {
        let mut changed = backup.clone();
        match field {
            0 => changed.header.backup_id[0] ^= 1,
            1 => changed.header.created_at += 1,
            2 => changed.header.root.user = "mallory".into(),
            3 => changed.nonce[0] ^= 1,
            _ => changed.ciphertext[0] ^= 1,
        }
        assert_eq!(
            restore(&changed, &secret, &changed.header.root).err(),
            Some(Error::Recovery)
        );
    }
    assert_eq!(
        restore(&backup, &secret, super::tests::issuer().root()).err(),
        Some(Error::Changed)
    );
    let mut foreign = issuer.root().clone();
    foreign.instance = "foreign-instance".into();
    assert_eq!(
        restore(&backup, &secret, &foreign).err(),
        Some(Error::Changed)
    );
}

#[test]
fn valid_aead_with_a_mismatched_private_root_is_not_imported() {
    let issuer = issuer();
    let secret = RecoverySecret::generate().unwrap();
    let mut backup = RootBackup::seal(&issuer, &secret, NOW).unwrap();
    let wrong = PrivateRoot {
        root: issuer.root().clone(),
        seed: [7; 32],
    }; // Public invalid fixture seed.
    let plaintext = Zeroizing::new(serde_json::to_vec(&wrong).unwrap());
    backup.ciphertext = XChaCha20Poly1305::new((&*secret.0).into())
        .encrypt(
            XNonce::from_slice(&backup.nonce),
            Payload {
                msg: &plaintext,
                aad: &backup.header.aad().unwrap(),
            },
        )
        .unwrap();
    assert_eq!(
        restore(&backup, &secret, issuer.root()).err(),
        Some(Error::Recovery)
    );
}

#[test]
fn restoration_requires_a_pristine_provider_and_never_replaces_a_live_root_or_device() {
    let issuer = issuer();
    let secret = RecoverySecret::generate().unwrap();
    let backup = RootBackup::seal(&issuer, &secret, NOW).unwrap();
    let mut existing = Records::new();
    issuer.save(&mut existing).unwrap();
    let unchanged = existing.clone();
    assert_eq!(
        backup.restore(
            &secret,
            issuer.root(),
            &OpenMlsRustCrypto::default(),
            &mut existing
        ),
        Err(Error::Changed)
    );
    assert_eq!(existing, unchanged);
    let mut device_records = Records::new();
    LocalDevice::create(issuer.root(), "mobile", &mut device_records).unwrap();
    let unchanged = device_records.clone();
    assert_eq!(
        backup.restore(
            &secret,
            issuer.root(),
            &OpenMlsRustCrypto::default(),
            &mut device_records
        ),
        Err(Error::Changed)
    );
    assert_eq!(device_records, unchanged);
    let provider = OpenMlsRustCrypto::default();
    provider
        .storage()
        .values
        .write()
        .unwrap()
        .insert(b"old-mls-state".to_vec(), b"opaque".to_vec());
    let mut empty = Records::new();
    assert_eq!(
        backup.restore(&secret, issuer.root(), &provider, &mut empty),
        Err(Error::Changed)
    );
    assert!(empty.is_empty());
    assert_eq!(provider.storage().values.read().unwrap().len(), 1);
}

#[test]
fn backup_parser_and_plaintext_bounds_refuse_oversize_unknown_and_unsupported_formats() {
    let issuer = issuer();
    let secret = RecoverySecret::generate().unwrap();
    let backup = RootBackup::seal(&issuer, &secret, NOW).unwrap();
    assert_eq!(
        RootBackup::from_bytes(&vec![b'x'; PACKET_LIMIT + 1]),
        Err(Error::Limit)
    );
    let mut value = serde_json::to_value(&backup).unwrap();
    value["server_verified"] = true.into();
    assert_eq!(
        RootBackup::from_bytes(&serde_json::to_vec(&value).unwrap()),
        Err(Error::Invalid)
    );
    let mut changed = backup.clone();
    changed.header.version = 2;
    assert_eq!(changed.to_bytes(), Err(Error::Invalid));
    changed = backup.clone();
    changed.ciphertext = vec![0; super::super::WIRE_LIMIT + 17];
    assert_eq!(changed.to_bytes(), Err(Error::Limit));
    changed = backup;
    changed.ciphertext.truncate(15);
    assert_eq!(changed.to_bytes(), Err(Error::Limit));
}

#[derive(Default)]
struct Fixture {
    entries: Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>,
    fail: std::sync::atomic::AtomicBool,
}
impl Storage for Fixture {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultError> {
        Ok(self
            .entries
            .lock()
            .unwrap()
            .get(name)
            .map(|v| Zeroizing::new(v.to_vec())))
    }
    fn write(&self, name: &str, bytes: &[u8]) -> Result<(), VaultError> {
        if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(VaultError::Storage);
        }
        self.entries
            .lock()
            .unwrap()
            .insert(name.into(), Zeroizing::new(bytes.to_vec()));
        Ok(())
    }
}
fn manager(path: &Path, storage: Arc<Fixture>) -> Manager {
    Manager::new(
        path.join("private"),
        Scope {
            instance: "instance".into(),
            data_epoch: "epoch".into(),
            user: "alice".into(),
            device: "fresh-device".into(),
            incarnation: "fresh-storage-incarnation".into(),
        },
        storage,
    )
    .unwrap()
}

#[test]
fn recovered_root_is_atomic_and_persists_after_actual_protected_disk_reopen() {
    let issuer = issuer();
    let secret = RecoverySecret::generate().unwrap();
    let backup = RootBackup::seal(&issuer, &secret, NOW).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let storage = Arc::new(Fixture::default());
    let vault = manager(directory.path(), storage.clone());
    vault.initialize().unwrap();
    assert_eq!(
        vault.transact::<()>(|provider, records| {
            backup
                .restore(&secret, issuer.root(), provider, records)
                .unwrap();
            Err(VaultError::Rejected)
        }),
        Err(VaultError::Rejected)
    );
    vault
        .inspect(|provider, records| {
            assert!(records.is_empty());
            assert!(provider.storage().values.read().unwrap().is_empty());
            Ok(())
        })
        .unwrap();
    vault
        .transact(|provider, records| {
            backup
                .restore(&secret, issuer.root(), provider, records)
                .map_err(|_| VaultError::Rejected)
        })
        .unwrap();
    drop(vault);
    manager(directory.path(), storage)
        .transact(|provider, records| {
            assert_eq!(
                Issuer::load(records, "instance", "alice").unwrap().root(),
                issuer.root()
            );
            assert!(provider.storage().values.read().unwrap().is_empty());
            let request = LocalDevice::create(issuer.root(), "fresh-device", records)
                .unwrap()
                .request(NOW, records)
                .unwrap();
            assert_ne!(request.body.signature_key, issuer.root().public_key);
            Ok(())
        })
        .unwrap();
}

#[test]
fn lost_recovery_checkpoint_replays_the_exact_backup_without_resetting_a_new_leaf() {
    use std::sync::atomic::Ordering;
    let issuer = issuer();
    let secret = RecoverySecret::generate().unwrap();
    let backup = RootBackup::seal(&issuer, &secret, NOW).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let storage = Arc::new(Fixture::default());
    let vault = manager(directory.path(), storage.clone());
    vault.initialize().unwrap();
    storage.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        vault.transact(|provider, records| backup
            .restore(&secret, issuer.root(), provider, records)
            .map_err(|_| VaultError::Rejected)),
        Err(VaultError::Storage)
    );
    drop(vault);
    storage.fail.store(false, Ordering::SeqCst);
    let vault = manager(directory.path(), storage);
    let request = vault
        .transact(|provider, records| {
            backup
                .restore(&secret, issuer.root(), provider, records)
                .unwrap();
            LocalDevice::create(issuer.root(), "fresh-device", records)
                .unwrap()
                .request(NOW, records)
                .map_err(|_| VaultError::Rejected)
        })
        .unwrap();
    let replacement = RootBackup::seal(&issuer, &secret, NOW).unwrap();
    vault
        .transact(|provider, records| {
            let before = records.clone();
            // Successful replay is a read of the original result, not a reset.
            backup
                .restore(&secret, issuer.root(), provider, records)
                .unwrap();
            assert_eq!(before, *records);
            assert_eq!(
                backup.restore(
                    &RecoverySecret::generate().unwrap(),
                    issuer.root(),
                    provider,
                    records
                ),
                Err(Error::Recovery)
            );
            assert_eq!(
                replacement.restore(&secret, issuer.root(), provider, records),
                Err(Error::Changed)
            );
            assert_eq!(before, *records);
            assert_eq!(
                LocalDevice::load(issuer.root(), "fresh-device", records)
                    .unwrap()
                    .request(NOW + 1, records)
                    .unwrap(),
                request
            );
            Ok(())
        })
        .unwrap();
}
