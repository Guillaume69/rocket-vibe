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
fn empty_directory() -> rv_protocol::e2ee::Directory {
    rv_protocol::e2ee::Directory {
        scope: rv_protocol::e2ee::Scope {
            instance_id: "instance".into(),
            data_epoch: "epoch".into(),
        },
        identity: None,
        devices: vec![],
        revocations: vec![],
        next_revocation: None,
    }
}
fn registration_public(
    input: &str,
) -> (
    rv_protocol::e2ee::OperationReceipt,
    rv_protocol::e2ee::Identity,
    rv_protocol::e2ee::Device,
) {
    use rv_crypto::identity::enrollment::Grant;
    let request: rv_protocol::e2ee::RegisterDevice = serde_json::from_str(input).unwrap();
    let grant = Grant::from_bytes(
        &data_encoding::BASE64URL_NOPAD
            .decode(request.grant.as_bytes())
            .unwrap(),
    )
    .unwrap();
    let cert = &grant.certificate.device;
    let fingerprint = data_encoding::HEXLOWER.encode(&cert.root.fingerprint().unwrap());
    let receipt = rv_protocol::e2ee::OperationReceipt {
        scope: request.scope,
        operation_id: request.operation_id,
        kind: "register_device".into(),
        device_id: cert.device.clone(),
        incarnation: data_encoding::HEXLOWER.encode(&cert.incarnation),
        device_revision: "1".into(),
        root_fingerprint: fingerprint.clone(),
        key_package_refs: vec![],
    };
    let identity = rv_protocol::e2ee::Identity {
        user_id: cert.root.user.clone(),
        root: data_encoding::BASE64URL_NOPAD.encode(&serde_json::to_vec(&cert.root).unwrap()),
        fingerprint,
        revision: "1".into(),
    };
    let device = rv_protocol::e2ee::Device {
        device_id: cert.device.clone(),
        incarnation: receipt.incarnation.clone(),
        certificate: data_encoding::BASE64URL_NOPAD
            .encode(&serde_json::to_vec(&grant.certificate).unwrap()),
        revision: "1".into(),
        expires_at: cert.expires_at.to_string(),
    };
    (receipt, identity, device)
}

#[test]
fn shared_ceremony_enrolls_two_devices_reopens_original_registration_and_remembers_withdrawal() {
    use data_encoding::{BASE64URL_NOPAD as B64, HEXLOWER};
    let directory = tempfile::tempdir().unwrap();
    let key = Arc::new(Keystore::default());
    let first = open(directory.path(), key.clone());
    let mut wire = empty_directory();
    let empty = serde_json::to_string(&wire).unwrap();
    assert!(first.identity_view(empty.clone()).unwrap().phase == IdentityPhase::Missing);
    assert_eq!(*key.writes.lock().unwrap(), 0);
    let created = first.identity_begin(empty.clone(), String::new()).unwrap();
    assert!(created.phase == IdentityPhase::IdentityCreated && created.controls_root);
    let preview = first
        .identity_preview(empty.clone(), created.request_code.clone())
        .unwrap();
    assert_eq!(preview.request_fingerprint, created.request_fingerprint);
    assert!(
        first
            .identity_approve(empty.clone(), "wrong-consent".into())
            .is_err()
    );
    assert!(first.identity_approve(empty.clone(), preview.id).is_err());
    let preview = first
        .identity_preview(empty.clone(), created.request_code)
        .unwrap();
    let grant = first.identity_approve(empty.clone(), preview.id).unwrap();
    assert!(
        first.identity_install(empty.clone(), grant).unwrap().phase == IdentityPhase::Registering
    );
    let pending = first.identity_pending(empty.clone()).unwrap();
    first.stop();
    let first = open(directory.path(), key.clone());
    assert_eq!(first.identity_pending(empty.clone()).unwrap(), pending);
    let (mut receipt, identity, device) = registration_public(&pending);
    wire.identity = Some(identity);
    wire.devices.push(device);
    let published = serde_json::to_string(&wire).unwrap();
    receipt.device_revision = "2".into();
    assert!(
        first
            .identity_acknowledge(published.clone(), serde_json::to_string(&receipt).unwrap())
            .is_err()
    );
    assert_eq!(first.identity_pending(published.clone()).unwrap(), pending);
    receipt.device_revision = "1".into();
    assert!(
        first
            .identity_acknowledge(published.clone(), serde_json::to_string(&receipt).unwrap())
            .unwrap()
            .phase
            == IdentityPhase::Ready
    );
    let mut phone_account = account();
    phone_account.device = "second-phone".into();
    let phone = CryptoInstallation::open(
        directory.path().to_string_lossy().into(),
        phone_account.clone(),
        key.clone(),
    )
    .unwrap();
    let writes = *key.writes.lock().unwrap();
    assert!(
        phone
            .identity_begin(published.clone(), "00".repeat(32))
            .is_err()
    );
    assert_eq!(*key.writes.lock().unwrap(), writes);
    let waiting = phone
        .identity_begin(published.clone(), created.root_fingerprint)
        .unwrap();
    assert!(waiting.phase == IdentityPhase::WaitingForApproval && !waiting.controls_root);
    assert!(
        phone
            .identity_preview(published.clone(), waiting.request_code.clone())
            .is_err()
    );
    let approval = first
        .identity_preview(published.clone(), waiting.request_code)
        .unwrap();
    let grant = first
        .identity_approve(published.clone(), approval.id)
        .unwrap();
    phone.identity_install(published.clone(), grant).unwrap();
    let original = phone.identity_pending(published.clone()).unwrap();
    phone.stop();
    let phone = CryptoInstallation::open(
        directory.path().to_string_lossy().into(),
        phone_account.clone(),
        key.clone(),
    )
    .unwrap();
    assert_eq!(phone.identity_pending(published.clone()).unwrap(), original);
    let (receipt, _, device) = registration_public(&original);
    wire.devices.push(device);
    let published = serde_json::to_string(&wire).unwrap();
    assert!(
        phone
            .identity_acknowledge(published.clone(), serde_json::to_string(&receipt).unwrap())
            .unwrap()
            .phase
            == IdentityPhase::Ready
    );
    let manager = first.slot.load().unwrap().unwrap();
    let revocation = manager
        .inspect(|_, records| {
            let issuer = rv_crypto::identity::Issuer::load(records, "instance", "alice").unwrap();
            let incarnation: [u8; 16] = HEXLOWER
                .decode(receipt.incarnation.as_bytes())
                .unwrap()
                .try_into()
                .unwrap();
            Ok(issuer.revoke("second-phone", incarnation).unwrap())
        })
        .unwrap();
    wire.revocations.push(rv_protocol::e2ee::Revocation {
        position: "9007199254740993".into(),
        signed: B64.encode(&serde_json::to_vec(&revocation).unwrap()),
    });
    assert!(
        phone
            .identity_view(serde_json::to_string(&wire).unwrap())
            .is_err()
    );
    assert!(phone.is_closed());
    wire.revocations.clear();
    let reopened = CryptoInstallation::open(
        directory.path().to_string_lossy().into(),
        phone_account,
        key,
    )
    .unwrap();
    assert!(
        reopened
            .identity_view(serde_json::to_string(&wire).unwrap())
            .is_err()
    );
    assert!(reopened.is_closed());
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
