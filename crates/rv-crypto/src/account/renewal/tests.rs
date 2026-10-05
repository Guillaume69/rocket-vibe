use super::super::testing::*;
use super::*;

#[test]
fn expiry_renewal_retains_identity_and_original_registration_until_exact_ack() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let installation = slot(folder.path(), keys.clone());
    let mut wire = initialized(&installation);
    let c = Coordinator::new(&installation);
    let directory = c.directory(wire.clone()).unwrap();
    let ready = c.view(&directory, NOW).unwrap();
    assert!(ready.stage == Stage::Ready);
    assert!(c.view(&directory, NOW - 1).is_err());
    assert_eq!(ready.certificate_expires_at, Some(NOW + LIFETIME));
    let original_scope = c.prepared(&directory, NOW).unwrap().0.scope().clone();
    let expired = NOW + LIFETIME + 1;
    assert!(c.view(&directory, expired).unwrap().stage == Stage::Expired);
    assert!(c.prepared(&directory, expired).is_err());
    assert!(c.renew(&directory, &"00".repeat(32), expired).is_err());
    c.renew(&directory, &ready.root_fingerprint, expired)
        .unwrap();
    let waiting = c.view(&directory, expired).unwrap();
    assert!(waiting.stage == Stage::Renewing && waiting.controls_root);
    assert!(!waiting.request_code.is_empty());
    c.renew(&directory, &ready.root_fingerprint, expired + 1)
        .unwrap();
    assert_eq!(
        c.view(&directory, expired + 1).unwrap().request_code,
        waiting.request_code
    );
    let preview = c
        .preview(&directory, &waiting.request_code, expired + 1)
        .unwrap();
    let grant = c.approve(&directory, preview, expired + 1).unwrap();
    c.install(&directory, &grant, expired + 1).unwrap();
    assert!(c.view(&directory, expired + 1).unwrap().stage == Stage::Registering);
    assert!(c.prepared(&directory, expired + 1).is_err());
    let original = c.pending().unwrap();
    assert_eq!(original.expected_device_revision.as_deref(), Some("1"));
    assert!(original.revoke_previous.is_none());
    let old_certificate: Certificate =
        serde_json::from_slice(&decode(&wire.devices[0].certificate, 4096).unwrap()).unwrap();
    let renewed = Grant::from_bytes(&decode(&original.grant, 8192).unwrap()).unwrap();
    assert_eq!(renewed.certificate.device.root, old_certificate.device.root);
    assert_eq!(
        renewed.certificate.device.signature_key,
        old_certificate.device.signature_key
    );
    assert_eq!(
        renewed.certificate.device.incarnation,
        old_certificate.device.incarnation
    );
    drop(installation);
    let installation = slot(folder.path(), keys);
    let c = Coordinator::new(&installation);
    assert_eq!(
        serde_json::to_vec(&c.pending().unwrap()).unwrap(),
        serde_json::to_vec(&original).unwrap()
    );
    let (mut receipt, device) = publication(&original);
    wire.devices[0] = device;
    // The server accepted it, but the application has not yet recorded its ACK.
    assert!(
        c.view(&c.directory(wire.clone()).unwrap(), expired + 2)
            .unwrap()
            .stage
            == Stage::Registering
    );
    receipt.operation_id = "different-renewal".into();
    assert!(c.acknowledge(&original, receipt).is_err());
    let (receipt, _) = publication(&original);
    c.acknowledge(&original, receipt).unwrap();
    let directory = c.directory(wire).unwrap();
    let ready = c.view(&directory, expired + 2).unwrap();
    assert!(ready.stage == Stage::Ready);
    assert_eq!(ready.certificate_expires_at, Some(expired + 1 + LIFETIME));
    assert_eq!(c.device_revision().unwrap(), "2");
    assert!(c.prepared(&directory, expired + 2).unwrap().0.scope() == &original_scope);
    assert!(c.pending().is_err());
    assert!(c.install(&directory, &grant, expired + 2).is_err());
}

#[test]
fn changed_directory_and_signed_withdrawal_cannot_become_renewal_baselines() {
    let folder = tempfile::tempdir().unwrap();
    let installation = slot(folder.path(), Arc::new(Keys::default()));
    let wire = initialized(&installation);
    let c = Coordinator::new(&installation);
    let directory = c.directory(wire.clone()).unwrap();
    let ready = c.view(&directory, NOW).unwrap();
    let mut substituted = wire.clone();
    substituted.devices[0].revision = "2".into();
    assert!(
        c.renew(
            &c.directory(substituted).unwrap(),
            &ready.root_fingerprint,
            NOW + 1
        )
        .is_err()
    );
    c.renew(&directory, &ready.root_fingerprint, NOW + 1)
        .unwrap();
    assert!(c.prepared(&directory, NOW + 1).is_ok());
    let waiting = c.view(&directory, NOW + 1).unwrap();
    let preview = c
        .preview(&directory, &waiting.request_code, NOW + 1)
        .unwrap();
    let grant = c.approve(&directory, preview, NOW + 1).unwrap();
    let mut substituted = wire.clone();
    substituted.devices[0].revision = "2".into();
    assert!(
        c.install(&c.directory(substituted).unwrap(), &grant, NOW + 1)
            .is_err()
    );
    assert_eq!(
        c.view(&directory, NOW + 1).unwrap().request_code,
        waiting.request_code
    );
    let manager = installation.load().unwrap().unwrap();
    let revocation = manager
        .inspect(|_, records| {
            let issuer = Issuer::load(records, "instance", "alice").unwrap();
            Ok(issuer
                .revoke(&manager.scope().device, incarnation(&manager).unwrap())
                .unwrap())
        })
        .unwrap();
    let mut withdrawn = wire.clone();
    withdrawn.revocations.push(http::Revocation {
        position: "1".into(),
        signed: B64.encode(&serde_json::to_vec(&revocation).unwrap()),
    });
    assert!(matches!(
        c.renew(
            &c.directory(withdrawn).unwrap(),
            &ready.root_fingerprint,
            NOW + 2
        ),
        Err(Error::Withdrawn(_))
    ));
    assert!(matches!(
        c.renew(&directory, &ready.root_fingerprint, NOW + 2),
        Err(Error::Withdrawn(_))
    ));
}

#[test]
fn a_non_controller_renews_after_expiry_only_with_the_existing_root_controller() {
    let folder = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let root_slot = slot(folder.path(), keys.clone());
    let mut wire = initialized(&root_slot);
    let controller = Coordinator::new(&root_slot);
    let mut phone_account = root_slot.account().clone();
    phone_account.device = "phone".into();
    let phone_slot =
        Installation::new(folder.path().join("phone-private"), phone_account, keys).unwrap();
    let phone = Coordinator::new(&phone_slot);
    let directory = phone.directory(wire.clone()).unwrap();
    let root = wire.identity.as_ref().unwrap().fingerprint.clone();
    phone.begin(&directory, &root, NOW + 1).unwrap();
    let waiting = phone.view(&directory, NOW + 1).unwrap();
    assert!(!waiting.controls_root && waiting.stage == Stage::WaitingForApproval);
    let approval = controller
        .preview(
            &controller.directory(wire.clone()).unwrap(),
            &waiting.request_code,
            NOW + 1,
        )
        .unwrap();
    let grant = controller
        .approve(
            &controller.directory(wire.clone()).unwrap(),
            approval,
            NOW + 1,
        )
        .unwrap();
    phone.install(&directory, &grant, NOW + 1).unwrap();
    let original = phone.pending().unwrap();
    let (receipt, device) = publication(&original);
    wire.devices.push(device);
    phone.acknowledge(&original, receipt).unwrap();
    let expired = NOW + LIFETIME + 2;
    let directory = phone.directory(wire.clone()).unwrap();
    assert!(phone.view(&directory, expired).unwrap().stage == Stage::Expired);
    phone.renew(&directory, &root, expired).unwrap();
    let renewing = phone.view(&directory, expired).unwrap();
    assert!(renewing.stage == Stage::Renewing && !renewing.controls_root);
    assert!(
        phone
            .preview(&directory, &renewing.request_code, expired)
            .is_err()
    );
    assert!(phone.prepared(&directory, expired).is_err());
    let directory = controller.directory(wire.clone()).unwrap();
    assert!(controller.view(&directory, expired).unwrap().stage == Stage::Expired);
    let approval = controller
        .preview(&directory, &renewing.request_code, expired)
        .unwrap();
    let grant = controller.approve(&directory, approval, expired).unwrap();
    phone
        .install(&phone.directory(wire.clone()).unwrap(), &grant, expired)
        .unwrap();
    let original = phone.pending().unwrap();
    let (receipt, device) = publication(&original);
    wire.devices[1] = device;
    phone.acknowledge(&original, receipt).unwrap();
    let directory = phone.directory(wire).unwrap();
    assert!(phone.view(&directory, expired + 1).unwrap().stage == Stage::Ready);
    assert!(phone.prepared(&directory, expired + 1).is_ok());
    assert_eq!(phone.device_revision().unwrap(), "2");
    assert_eq!(
        phone
            .view(&directory, expired + 1)
            .unwrap()
            .root_fingerprint,
        root
    );
}
