use super::super::testing::{self, Keys, NOW, empty, initialized, slot};
use super::*;
use crate::protected::Storage;
use std::sync::atomic::{AtomicBool, Ordering};
fn empty_remote() -> http::RootBackupState {
    http::RootBackupState {
        scope: empty().scope,
        active: None,
    }
}
fn accepted(request: &http::PublishRootBackup) -> http::RootBackupReceipt {
    let p = publication(request).unwrap();
    http::RootBackupReceipt {
        scope: request.scope.clone(),
        operation_id: request.operation_id.clone(),
        device_id: p.body.device.clone(),
        incarnation: hex(&p.body.incarnation),
        device_revision: p.body.device_revision.clone(),
        root_fingerprint: hex(&p.packet.header.root.fingerprint().unwrap()),
        backup_id: hex(&p.packet.header.backup_id),
        backup_revision: (p
            .body
            .expected_revision
            .as_deref()
            .map(revision)
            .transpose()
            .unwrap()
            .unwrap_or(0)
            + 1)
        .to_string(),
        packet_digest: hex(&p.body.packet_digest),
    }
}
fn remote_packet(request: &http::PublishRootBackup) -> http::RootBackupState {
    http::RootBackupState {
        scope: request.scope.clone(),
        active: Some(http::RootBackupVersion {
            publication: request.publication.clone(),
            receipt: accepted(request),
        }),
    }
}
#[test]
fn backup_outbox_precedes_code_view_requires_saved_confirmation_and_reopens_exact_original() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let installation = slot(folder.path(), keys.clone());
    let wire = initialized(&installation);
    let c = Coordinator::new(&installation);
    let own = c.directory(wire.clone()).unwrap();
    let preview = c.preview_backup(&own, empty_remote()).unwrap();
    let stale_preview = c.preview_backup(&own, empty_remote()).unwrap();
    let fp = preview.root_fingerprint.clone();
    c.prepare_backup(&own, preview, NOW).unwrap();
    assert!(c.backup_status(&own).unwrap().pending);
    assert!(!c.backup_status(&own).unwrap().code_saved);
    assert!(c.pending_backup().is_err());
    assert!(c.renew(&own, &fp, NOW + 1).is_err());
    assert!(c.preview_backup(&own, empty_remote()).is_err());
    let code = c.backup_code().unwrap();
    let manager = installation.load().unwrap().unwrap();
    manager
        .inspect(|_, records| {
            assert!(
                !records
                    .get(RECORD)
                    .unwrap()
                    .windows(code.len())
                    .any(|w| w == code.as_bytes())
            );
            assert_eq!(records.get(SECRET).unwrap().len(), 32);
            Ok(())
        })
        .unwrap();
    c.confirm_backup_code().unwrap();
    let original = c.pending_backup().unwrap();
    let p = publication(&original).unwrap();
    let packet = RootBackup::from_bytes(&p.packet.to_bytes().unwrap()).unwrap();
    packet
        .authenticate(
            &RecoverySecret::from_code(&code).unwrap(),
            &p.packet.header.root,
        )
        .unwrap();
    drop(manager);
    drop(installation);
    let installation = slot(folder.path(), keys);
    let c = Coordinator::new(&installation);
    assert!(same(&c.pending_backup().unwrap(), &original));
    assert_eq!(c.backup_code().unwrap().as_str(), code.as_str());
    let mut wrong = accepted(&original);
    wrong.packet_digest = "ff".repeat(32);
    assert!(c.acknowledge_backup(&original, wrong).is_err());
    let mut wrong = accepted(&original);
    wrong.backup_revision = "2".into();
    assert!(c.acknowledge_backup(&original, wrong).is_err());
    assert!(same(&c.pending_backup().unwrap(), &original));
    c.acknowledge_backup(&original, accepted(&original))
        .unwrap();
    assert!(c.pending_backup().is_err() && c.backup_code().is_err());
    let own = c.directory(wire).unwrap();
    let status = c.backup_status(&own).unwrap();
    assert!(!status.pending);
    assert_eq!(status.receipt.unwrap().backup_revision, "1");
    assert!(c.prepare_backup(&own, stale_preview, NOW + 1).is_err());
    assert!(c.preview_backup(&own, empty_remote()).is_err());
    let active = remote_packet(&original);
    c.preview_backup(&own, active.clone()).unwrap();
    let mut substituted = active;
    substituted.active.as_mut().unwrap().receipt.packet_digest = "ff".repeat(32);
    assert!(c.preview_backup(&own, substituted).is_err());
    installation
        .load()
        .unwrap()
        .unwrap()
        .inspect(|_, records| {
            assert!(!records.contains_key(SECRET));
            Ok(())
        })
        .unwrap();
    c.renew(&own, &fp, NOW + 1).unwrap();
}
#[test]
fn backup_preview_rejects_altered_labels_remote_receipt_and_other_incarnation() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let installation = slot(folder.path(), keys.clone());
    let wire = initialized(&installation);
    let c = Coordinator::new(&installation);
    let own = c.directory(wire.clone()).unwrap();
    let mut preview = c.preview_backup(&own, empty_remote()).unwrap();
    preview.root_fingerprint = "ff".repeat(32);
    assert!(c.prepare_backup(&own, preview, NOW).is_err());
    assert!(c.backup_code().is_err());
    let preview = c.preview_backup(&own, empty_remote()).unwrap();
    let mut account = installation.account().clone();
    account.device = "other".into();
    let other = Installation::new(folder.path().join("other"), account, keys).unwrap();
    let other_c = Coordinator::new(&other);
    assert!(
        other_c
            .prepare_backup(&other_c.directory(wire.clone()).unwrap(), preview, NOW)
            .is_err()
    );
    assert!(other.load().unwrap().is_none());
    let preview = c.preview_backup(&own, empty_remote()).unwrap();
    c.prepare_backup(&own, preview, NOW).unwrap();
    c.confirm_backup_code().unwrap();
    let original = c.pending_backup().unwrap();
    let mut remote = remote_packet(&original);
    remote.active.as_mut().unwrap().receipt.device_revision = "2".into();
    assert!(
        c.preview_restore(
            &remote,
            &c.backup_code().unwrap(),
            &hex(&publication(&original)
                .unwrap()
                .packet
                .header
                .root
                .fingerprint()
                .unwrap())
        )
        .is_err()
    );
}
#[test]
fn fresh_recovery_checks_code_before_vault_creation_and_exact_retry_preserves_new_leaf_and_records()
{
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let installation = slot(folder.path(), keys.clone());
    let mut wire = initialized(&installation);
    let controller = Coordinator::new(&installation);
    let own = controller.directory(wire.clone()).unwrap();
    controller
        .prepare_backup(
            &own,
            controller.preview_backup(&own, empty_remote()).unwrap(),
            NOW,
        )
        .unwrap();
    controller.confirm_backup_code().unwrap();
    let original = controller.pending_backup().unwrap();
    let remote = remote_packet(&original);
    let code = controller.backup_code().unwrap();
    let fp = wire.identity.as_ref().unwrap().fingerprint.clone();
    let mut account = installation.account().clone();
    account.device = "recovered-phone".into();
    let phone = Installation::new(folder.path().join("recovery-private"), account, keys).unwrap();
    let c = Coordinator::new(&phone);
    let wrong = RecoverySecret::generate().unwrap().for_display();
    assert!(c.preview_restore(&remote, &wrong, &fp).is_err());
    assert!(c.preview_restore(&remote, &code, &"ff".repeat(32)).is_err());
    assert!(phone.load().unwrap().is_none());
    let preview = c.preview_restore(&remote, &code, &fp).unwrap();
    assert!(phone.load().unwrap().is_none());
    c.restore_root(preview, NOW + 1).unwrap();
    let own = c.directory(wire.clone()).unwrap();
    let view = c.view(&own, NOW + 1).unwrap();
    assert!(view.controls_root && view.stage == Stage::IdentityCreated);
    assert_eq!(view.root_fingerprint, fp);
    let request = Request::from_bytes(&decode(&view.request_code, 8192).unwrap()).unwrap();
    let owner: Certificate =
        serde_json::from_slice(&decode(&wire.devices[0].certificate, 4096).unwrap()).unwrap();
    assert_ne!(request.body.signature_key, owner.device.signature_key);
    assert_ne!(request.body.incarnation, owner.device.incarnation);
    let approval = c.preview(&own, &view.request_code, NOW + 1).unwrap();
    let grant = c.approve(&own, approval, NOW + 1).unwrap();
    c.install(&own, &grant, NOW + 1).unwrap();
    let pending = c.pending().unwrap();
    let (receipt, device) = testing::publication(&pending);
    wire.devices.push(device);
    c.acknowledge(&pending, receipt).unwrap();
    let manager = phone.load().unwrap().unwrap();
    manager
        .transact(|_, records| {
            records.insert("subsequent-state".into(), vec![19, 42]);
            Ok(())
        })
        .unwrap();
    let own = c.directory(wire).unwrap();
    let before = c
        .registered_certificate(&manager, &c.state().unwrap().1, &own)
        .unwrap();
    c.restore_root(c.preview_restore(&remote, &code, &fp).unwrap(), NOW + 30)
        .unwrap();
    assert_eq!(
        c.registered_certificate(&manager, &c.state().unwrap().1, &own)
            .unwrap(),
        before
    );
    manager
        .inspect(|_, records| {
            assert_eq!(records.get("subsequent-state").unwrap(), &vec![19, 42]);
            assert!(!records.contains_key(SECRET));
            Ok(())
        })
        .unwrap();
    assert!(c.preview_restore(&remote, &wrong, &fp).is_err());
    // An existing unrelated identity is never overwritten by a recovery.
    assert!(
        controller
            .restore_root(
                controller.preview_restore(&remote, &code, &fp).unwrap(),
                NOW + 1
            )
            .is_err()
    );
    assert_eq!(
        controller
            .view(
                &controller
                    .directory(empty_from_root(&original, owner))
                    .unwrap(),
                NOW + 1
            )
            .unwrap()
            .root_fingerprint,
        fp
    );
}
fn empty_from_root(original: &http::PublishRootBackup, owner: Certificate) -> http::Directory {
    let p = publication(original).unwrap();
    http::Directory {
        scope: original.scope.clone(),
        identity: Some(http::Identity {
            user_id: p.packet.header.root.user.clone(),
            root: B64.encode(&serde_json::to_vec(&p.packet.header.root).unwrap()),
            fingerprint: hex(&p.packet.header.root.fingerprint().unwrap()),
            revision: "1".into(),
        }),
        devices: vec![http::Device {
            device_id: owner.device.device.clone(),
            incarnation: hex(&owner.device.incarnation),
            certificate: B64.encode(&serde_json::to_vec(&owner).unwrap()),
            revision: "1".into(),
            expires_at: owner.device.expires_at.to_string(),
        }],
        revocations: vec![],
        next_revocation: None,
    }
}
#[test]
fn an_enrolled_non_controller_cannot_create_a_root_backup() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let root_slot = slot(folder.path(), keys.clone());
    let mut wire = initialized(&root_slot);
    let controller = Coordinator::new(&root_slot);
    let mut account = root_slot.account().clone();
    account.device = "delegated-phone".into();
    let phone = Installation::new(folder.path().join("phone-private"), account, keys).unwrap();
    let c = Coordinator::new(&phone);
    let own = c.directory(wire.clone()).unwrap();
    c.begin(&own, &wire.identity.as_ref().unwrap().fingerprint, NOW + 1)
        .unwrap();
    let waiting = c.view(&own, NOW + 1).unwrap();
    let controller_own = controller.directory(wire.clone()).unwrap();
    let approval = controller
        .preview(&controller_own, &waiting.request_code, NOW + 1)
        .unwrap();
    let grant = controller
        .approve(&controller_own, approval, NOW + 1)
        .unwrap();
    c.install(&own, &grant, NOW + 1).unwrap();
    let original = c.pending().unwrap();
    let (receipt, device) = testing::publication(&original);
    wire.devices.push(device);
    c.acknowledge(&original, receipt).unwrap();
    let own = c.directory(wire).unwrap();
    assert!(!c.backup_status(&own).unwrap().controls_root);
    assert!(c.preview_backup(&own, empty_remote()).is_err());
    assert!(c.backup_code().is_err() && c.pending_backup().is_err());
}
struct FailingKeys {
    keys: Arc<Keys>,
    fail: AtomicBool,
}
impl Storage for FailingKeys {
    fn read(&self, name: &str) -> std::result::Result<Option<Zeroizing<Vec<u8>>>, vault::Error> {
        self.keys.read(name)
    }
    fn write(&self, name: &str, bytes: &[u8]) -> std::result::Result<(), vault::Error> {
        if self.fail.load(Ordering::SeqCst) {
            Err(vault::Error::Storage)
        } else {
            self.keys.write(name, bytes)
        }
    }
}
#[test]
fn lost_backup_checkpoint_never_reveals_code_before_success_and_reopen_retains_original_packet() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let storage = Arc::new(FailingKeys {
        keys,
        fail: AtomicBool::new(false),
    });
    let account = crate::installation::Account {
        origin: "https://example.org".into(),
        instance: "instance".into(),
        data_epoch: "epoch".into(),
        user: "alice".into(),
        device: "desktop".into(),
    };
    let installation = Installation::new(
        folder.path().join("private"),
        account.clone(),
        storage.clone(),
    )
    .unwrap();
    let wire = initialized(&installation);
    let c = Coordinator::new(&installation);
    let own = c.directory(wire.clone()).unwrap();
    let preview = c.preview_backup(&own, empty_remote()).unwrap();
    storage.fail.store(true, Ordering::SeqCst);
    assert!(matches!(
        c.prepare_backup(&own, preview, NOW),
        Err(Error::Storage(vault::Error::Storage))
    ));
    assert!(c.backup_code().is_err());
    storage.fail.store(false, Ordering::SeqCst);
    drop(installation);
    let installation = Installation::new(folder.path().join("private"), account, storage).unwrap();
    let c = Coordinator::new(&installation);
    let own = c.directory(wire).unwrap();
    assert!(c.backup_status(&own).unwrap().pending);
    assert!(c.pending_backup().is_err());
    let code = c.backup_code().unwrap();
    c.confirm_backup_code().unwrap();
    let original = c.pending_backup().unwrap();
    assert!(same(&original, &c.pending_backup().unwrap()));
    assert_eq!(c.backup_code().unwrap().as_str(), code.as_str());
    c.acknowledge_backup(&original, accepted(&original))
        .unwrap();
}
