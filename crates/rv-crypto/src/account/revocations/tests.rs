use super::super::testing::*;
use super::*;
use crate::identity::{Error as IdentityError, Observation};
use std::sync::atomic::{AtomicBool, Ordering};

fn phone(
    slot: &Installation,
    folder: &std::path::Path,
    keys: Arc<Keys>,
    wire: &mut http::Directory,
) -> Installation {
    let mut account = slot.account().clone();
    account.device = "phone".into();
    let phone = Installation::new(folder.join("phone-private"), account, keys).unwrap();
    let c = Coordinator::new(&phone);
    let own = c.directory(wire.clone()).unwrap();
    c.begin(&own, &wire.identity.as_ref().unwrap().fingerprint, NOW)
        .unwrap();
    let waiting = c.view(&own, NOW).unwrap();
    let controller = Coordinator::new(slot);
    let directory = controller.directory(wire.clone()).unwrap();
    let preview = controller
        .preview(&directory, &waiting.request_code, NOW)
        .unwrap();
    let grant = controller.approve(&directory, preview, NOW).unwrap();
    c.install(&own, &grant, NOW).unwrap();
    let original = c.pending().unwrap();
    let (receipt, device) = publication(&original);
    wire.devices.push(device);
    c.acknowledge(&original, receipt).unwrap();
    phone
}
fn target(wire: &http::Directory) -> Certificate {
    let device = wire
        .devices
        .iter()
        .find(|d| d.device_id == "phone")
        .unwrap();
    serde_json::from_slice(&decode(&device.certificate, 4096).unwrap()).unwrap()
}
fn receipt(c: &Coordinator<'_>, request: &http::RevokeDevice) -> http::OperationReceipt {
    let (_, account) = c.state().unwrap();
    let baseline = account.receipt.unwrap();
    http::OperationReceipt {
        scope: request.scope.clone(),
        operation_id: request.operation_id.clone(),
        kind: "revoke_device".into(),
        device_id: baseline.device_id,
        incarnation: request.incarnation.clone(),
        device_revision: request.device_revision.clone(),
        root_fingerprint: baseline.root_fingerprint,
        key_package_refs: vec![],
    }
}
fn approve_target(manager: &Manager, certificate: &Certificate) {
    manager
        .transact(|_, records| {
            let mut pins = Pins::load(records, "instance").unwrap();
            pins.accept_first(
                certificate.device.root.clone(),
                certificate.device.root.fingerprint().unwrap(),
            )
            .unwrap();
            let consent = pins.preview_device(certificate, NOW).unwrap();
            pins.approve(certificate, &consent, NOW).unwrap();
            pins.save(records).unwrap();
            Ok(())
        })
        .unwrap();
}
fn withdrawn(manager: &Manager, certificate: &Certificate) {
    manager
        .inspect(|_, records| {
            let pins = Pins::load(records, "instance").unwrap();
            assert_eq!(
                pins.authorize_credential(
                    &certificate.credential().unwrap(),
                    &certificate.device.signature_key,
                    NOW
                )
                .err(),
                Some(IdentityError::Revoked)
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn explicit_withdrawal_is_saved_before_output_and_exact_ack_survives_reopen_and_omission() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let installation = slot(folder.path(), keys.clone());
    let mut wire = initialized(&installation);
    let _phone = phone(&installation, folder.path(), keys.clone(), &mut wire);
    let certificate = target(&wire);
    let c = Coordinator::new(&installation);
    let directory = c.directory(wire.clone()).unwrap();
    let manager = c.prepared(&directory, NOW).unwrap().0;
    approve_target(&manager, &certificate);
    let scope = manager.scope().clone();
    let before = c.withdrawals(&directory).unwrap();
    assert!(before.controls_root && before.pending.is_none() && before.withdrawn.is_empty());
    assert_eq!(before.devices.len(), 1);
    let fp = before.devices[0].fingerprint.clone();
    let preview = c.preview_withdrawal(&directory, "phone", &fp).unwrap();
    assert_eq!(preview.incarnation, hex(&certificate.device.incarnation));
    assert!(c.pending_withdrawal().is_err());
    manager
        .inspect(|_, records| {
            assert!(
                Pins::load(records, "instance")
                    .unwrap()
                    .authorize_credential(
                        &certificate.credential().unwrap(),
                        &certificate.device.signature_key,
                        NOW
                    )
                    .is_ok()
            );
            Ok(())
        })
        .unwrap();
    let request = c.prepare_withdrawal(&directory, preview).unwrap();
    let proof = signed(&request).unwrap();
    assert_eq!(proof.device, "phone");
    assert_eq!(proof.root, certificate.device.root);
    withdrawn(&manager, &certificate);
    assert!(
        c.renew(
            &directory,
            &wire.identity.as_ref().unwrap().fingerprint,
            NOW + 1
        )
        .is_err()
    );
    assert!(c.preview_withdrawal(&directory, "phone", &fp).is_err());
    assert!(c.prepared(&directory, NOW + 1).is_ok());
    let pending = c.withdrawals(&directory).unwrap();
    assert!(pending.devices.is_empty() && pending.withdrawn.len() == 1);
    assert_eq!(pending.pending.unwrap().device, "phone");
    let accepted = receipt(&c, &request);
    drop(manager);
    drop(installation);
    let installation = slot(folder.path(), keys);
    let c = Coordinator::new(&installation);
    assert!(same(&c.pending_withdrawal().unwrap(), &request));
    let mut substituted = request.clone();
    substituted.operation_id = format!("withdraw-{}", "00".repeat(32));
    assert!(
        c.acknowledge_withdrawal(&substituted, accepted.clone())
            .is_err()
    );
    for index in 0..9 {
        let mut wrong = accepted.clone();
        match index {
            0 => wrong.scope.instance_id.push('x'),
            1 => wrong.scope.data_epoch.push('x'),
            2 => wrong.operation_id.push('x'),
            3 => wrong.kind = "register_device".into(),
            4 => wrong.device_id = "phone".into(),
            5 => wrong.incarnation = hex(&certificate.device.incarnation),
            6 => wrong.device_revision = "2".into(),
            7 => wrong.root_fingerprint = "00".repeat(32),
            _ => wrong.key_package_refs.push("substituted".into()),
        }
        assert!(c.acknowledge_withdrawal(&request, wrong).is_err());
        assert!(same(&c.pending_withdrawal().unwrap(), &request));
    }
    c.acknowledge_withdrawal(&request, accepted).unwrap();
    assert!(c.pending_withdrawal().is_err());
    assert!(
        c.acknowledge_withdrawal(&request, receipt(&c, &request))
            .is_err()
    );
    let directory = c.directory(wire.clone()).unwrap();
    let manager = c.prepared(&directory, NOW + 2).unwrap().0;
    assert!(manager.scope() == &scope);
    withdrawn(&manager, &certificate);
    assert!(c.withdrawals(&directory).unwrap().devices.is_empty());
    assert!(c.preview_withdrawal(&directory, "phone", &fp).is_err());
    c.renew(
        &directory,
        &wire.identity.as_ref().unwrap().fingerprint,
        NOW + 2,
    )
    .unwrap();
}

#[test]
fn previews_bind_target_incarnation_certificate_revision_controller_and_account() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let installation = slot(folder.path(), keys.clone());
    let mut wire = initialized(&installation);
    let phone = phone(&installation, folder.path(), keys, &mut wire);
    let c = Coordinator::new(&installation);
    let own = c.directory(wire.clone()).unwrap();
    let certificate = target(&wire);
    let fp = hex(&certificate.fingerprint().unwrap());
    assert!(
        c.preview_withdrawal(&own, "phone", &"00".repeat(32))
            .is_err()
    );
    let own_cert: Certificate =
        serde_json::from_slice(&decode(&wire.devices[0].certificate, 4096).unwrap()).unwrap();
    assert!(
        c.preview_withdrawal(&own, "desktop", &hex(&own_cert.fingerprint().unwrap()))
            .is_err()
    );
    let non_controller = Coordinator::new(&phone);
    assert!(
        !non_controller
            .withdrawals(&non_controller.directory(wire.clone()).unwrap())
            .unwrap()
            .controls_root
    );
    assert!(
        non_controller
            .preview_withdrawal(
                &non_controller.directory(wire.clone()).unwrap(),
                "desktop",
                &hex(&own_cert.fingerprint().unwrap())
            )
            .is_err()
    );
    let preview = c.preview_withdrawal(&own, "phone", &fp).unwrap();
    assert!(
        non_controller
            .prepare_withdrawal(&non_controller.directory(wire.clone()).unwrap(), preview)
            .is_err()
    );
    let preview = c.preview_withdrawal(&own, "phone", &fp).unwrap();
    let mut changed = wire.clone();
    changed.devices[1].revision = "2".into();
    assert!(
        c.prepare_withdrawal(&c.directory(changed).unwrap(), preview)
            .is_err()
    );
    assert!(c.pending_withdrawal().is_err());
    for field in 0..3 {
        let mut changed = wire.clone();
        let preview = c.preview_withdrawal(&own, "phone", &fp).unwrap();
        match field {
            0 => changed.devices.retain(|d| d.device_id != "phone"),
            1 => changed.devices[0].revision = "2".into(),
            _ => {
                let manager = installation.load().unwrap().unwrap();
                let replacement = manager
                    .inspect(|_, records| {
                        Ok(Issuer::load(records, "instance", "alice")
                            .unwrap()
                            .certify(
                                "phone",
                                [23; 16],
                                certificate.device.signature_key,
                                NOW,
                                NOW + LIFETIME,
                            )
                            .unwrap())
                    })
                    .unwrap();
                changed.devices[1].incarnation = hex(&replacement.device.incarnation);
                changed.devices[1].certificate =
                    B64.encode(&serde_json::to_vec(&replacement).unwrap());
            }
        }
        assert!(
            c.prepare_withdrawal(&c.directory(changed).unwrap(), preview)
                .is_err()
        );
        assert!(c.pending_withdrawal().is_err());
    }
    let mut modified_labels = c.preview_withdrawal(&own, "phone", &fp).unwrap();
    modified_labels.device = "another-device".into();
    assert!(c.prepare_withdrawal(&own, modified_labels).is_err());
    // The owner can withdraw an expired leaf, even when its own certificate has expired.
    let expired = NOW + LIFETIME + 1;
    assert!(c.prepared(&own, expired).is_err());
    let preview = c.preview_withdrawal(&own, "phone", &fp).unwrap();
    let request = c.prepare_withdrawal(&own, preview).unwrap();
    c.acknowledge_withdrawal(&request, receipt(&c, &request))
        .unwrap();
    assert_eq!(c.withdrawals(&own).unwrap().withdrawn.len(), 1);
}

#[test]
fn an_owned_remote_withdrawal_is_learned_without_root_control_and_survives_omission_and_reopen() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let controller = slot(folder.path(), keys.clone());
    let mut wire = initialized(&controller);
    let phone = phone(&controller, folder.path(), keys.clone(), &mut wire);
    let certificate: Certificate =
        serde_json::from_slice(&decode(&wire.devices[0].certificate, 4096).unwrap()).unwrap();
    let manager = controller.load().unwrap().unwrap();
    let proof = manager
        .inspect(|_, records| {
            Ok(Issuer::load(records, "instance", "alice")
                .unwrap()
                .revoke("desktop", certificate.device.incarnation)
                .unwrap())
        })
        .unwrap();
    wire.revocations.push(http::Revocation {
        position: "1".into(),
        signed: B64.encode(&serde_json::to_vec(&proof).unwrap()),
    });
    let observer = Coordinator::new(&phone);
    let own = observer.directory(wire.clone()).unwrap();
    let status = observer.withdrawals(&own).unwrap();
    assert!(!status.controls_root && status.devices.is_empty());
    assert_eq!(status.withdrawn.len(), 1);
    let account = phone.account().clone();
    drop(phone);
    wire.revocations.clear();
    let phone = Installation::new(folder.path().join("phone-private"), account, keys).unwrap();
    let observer = Coordinator::new(&phone);
    let own = observer.directory(wire).unwrap();
    let peers = super::super::peers::Coordinator::new(&phone, &own, NOW).unwrap();
    let view = peers.read(own.clone(), NOW).unwrap();
    let view = peers
        .pin(
            view,
            own.clone(),
            super::super::peers::RootChoice::FirstContact,
            &hex(&certificate.device.root.fingerprint().unwrap()),
            "",
            NOW,
        )
        .unwrap();
    assert!(peers.preview(view, own, "desktop", NOW).is_err());
    withdrawn(&phone.load().unwrap().unwrap(), &certificate);
}

#[test]
fn learning_owned_withdrawals_never_pins_a_root_and_later_explicit_trust_cannot_restore_a_device() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let installation = slot(folder.path(), keys.clone());
    let mut wire = initialized(&installation);
    let _phone = phone(&installation, folder.path(), keys, &mut wire);
    let c = Coordinator::new(&installation);
    let own = c.directory(wire.clone()).unwrap();
    let certificate = target(&wire);
    let root = &certificate.device.root;
    let preview = c
        .preview_withdrawal(&own, "phone", &hex(&certificate.fingerprint().unwrap()))
        .unwrap();
    let request = c.prepare_withdrawal(&own, preview).unwrap();
    c.acknowledge_withdrawal(&request, receipt(&c, &request))
        .unwrap();
    let manager = c.prepared(&own, NOW).unwrap().0;
    manager
        .inspect(|_, records| {
            assert!(matches!(
                Pins::load(records, "instance")
                    .unwrap()
                    .observe(root)
                    .unwrap(),
                Observation::Unknown
            ));
            Ok(())
        })
        .unwrap();
    let peers = super::super::peers::Coordinator::new(&installation, &own, NOW).unwrap();
    let view = peers.read(own.clone(), NOW).unwrap();
    let view = peers
        .pin(
            view,
            own.clone(),
            super::super::peers::RootChoice::FirstContact,
            &hex(&root.fingerprint().unwrap()),
            "",
            NOW,
        )
        .unwrap();
    assert!(!view.status.devices.iter().any(|d| d.approved));
    assert!(peers.preview(view, own, "phone", NOW).is_err());
    withdrawn(&manager, &certificate);
}

struct FailingKeys {
    keys: Arc<Keys>,
    fail: AtomicBool,
}
impl crate::protected::Storage for FailingKeys {
    fn read(
        &self,
        name: &str,
    ) -> std::result::Result<Option<zeroize::Zeroizing<Vec<u8>>>, vault::Error> {
        self.keys.read(name)
    }
    fn write(&self, name: &str, bytes: &[u8]) -> std::result::Result<(), vault::Error> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(vault::Error::Storage);
        }
        self.keys.write(name, bytes)
    }
}
#[test]
fn checkpoint_failure_returns_no_request_and_reopen_keeps_the_same_signed_intention() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let storage = Arc::new(FailingKeys {
        keys: keys.clone(),
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
    let mut wire = initialized(&installation);
    let _phone = phone(&installation, folder.path(), keys, &mut wire);
    let c = Coordinator::new(&installation);
    let own = c.directory(wire.clone()).unwrap();
    let certificate = target(&wire);
    let preview = c
        .preview_withdrawal(&own, "phone", &hex(&certificate.fingerprint().unwrap()))
        .unwrap();
    storage.fail.store(true, Ordering::SeqCst);
    assert!(matches!(
        c.prepare_withdrawal(&own, preview),
        Err(Error::Storage(vault::Error::Storage))
    ));
    storage.fail.store(false, Ordering::SeqCst);
    drop(installation);
    let installation = Installation::new(folder.path().join("private"), account, storage).unwrap();
    let c = Coordinator::new(&installation);
    let request = c.pending_withdrawal().unwrap();
    assert!(same(&request, &c.pending_withdrawal().unwrap()));
    assert_eq!(signed(&request).unwrap().device, "phone");
    let own = c.directory(wire).unwrap();
    assert!(c.withdrawals(&own).unwrap().devices.is_empty());
    c.acknowledge_withdrawal(&request, receipt(&c, &request))
        .unwrap();
}

#[test]
fn a_learned_withdrawal_outlives_a_directory_that_omits_it() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let installation = slot(folder.path(), keys.clone());
    let mut wire = initialized(&installation);
    let phone = phone(&installation, folder.path(), keys.clone(), &mut wire);
    let certificate = target(&wire);
    let c = Coordinator::new(&installation);
    let directory = c.directory(wire.clone()).unwrap();
    let manager = c.prepared(&directory, NOW).unwrap().0;
    approve_target(&manager, &certificate);
    // The phone asks for history before it is withdrawn.
    let p = Coordinator::new(&phone);
    let (fingerprint, input) = p
        .history_request(&p.directory(wire.clone()).unwrap(), NOW)
        .unwrap();
    let listed = http::HistoryRequests {
        scope: empty().scope,
        requests: vec![http::HistoryRequestEntry {
            fingerprint: fingerprint.clone(),
            device_id: "phone".into(),
            request: input.request.clone(),
            expires_at: (NOW + 7 * 86400).to_string(),
            sharer_device_id: None,
            committed: false,
        }],
    };
    assert_eq!(
        c.history_offers(&directory, &listed, NOW + 1)
            .unwrap()
            .len(),
        1
    );
    let fp = c.withdrawals(&directory).unwrap().devices[0]
        .fingerprint
        .clone();
    let preview = c.preview_withdrawal(&directory, "phone", &fp).unwrap();
    c.prepare_withdrawal(&directory, preview).unwrap();
    // The server omits the withdrawal: the phone stays untrusted anyway.
    assert!(wire.revocations.is_empty());
    assert!(
        c.history_offers(&directory, &listed, NOW + 1)
            .unwrap()
            .is_empty()
    );
}
