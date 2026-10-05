use super::*;
use crate::tests::{Keystore, account, registered, registration_public};
use data_encoding::{BASE64URL_NOPAD as B64, HEXLOWER};
use rv_crypto_public::recovery::Publication;
use serde_json::{Value, json};
fn call(view: &CryptoInstallation, d: &e2ee::Directory, input: Value) -> Value {
    serde_json::from_str(
        &view
            .recovery_action(serde_json::to_string(d).unwrap(), input.to_string())
            .unwrap(),
    )
    .unwrap()
}
fn request(view: &CryptoInstallation, d: &e2ee::Directory) -> e2ee::PublishRootBackup {
    serde_json::from_value(call(view, d, json!({"action":"pending"}))).unwrap()
}
fn receipt(original: &e2ee::PublishRootBackup) -> e2ee::RootBackupReceipt {
    let p = Publication::from_bytes(&B64.decode(original.publication.as_bytes()).unwrap()).unwrap();
    e2ee::RootBackupReceipt {
        scope: original.scope.clone(),
        operation_id: original.operation_id.clone(),
        device_id: p.body.device.clone(),
        incarnation: HEXLOWER.encode(&p.body.incarnation),
        device_revision: p.body.device_revision.clone(),
        root_fingerprint: HEXLOWER.encode(&p.packet.header.root.fingerprint().unwrap()),
        backup_id: HEXLOWER.encode(&p.packet.header.backup_id),
        backup_revision: "1".into(),
        packet_digest: HEXLOWER.encode(&p.body.packet_digest),
    }
}
#[test]
fn native_backup_code_is_explicit_approval_is_handle_bound_and_fresh_restore_has_a_different_leaf()
{
    let folder = tempfile::tempdir().unwrap();
    let key = Arc::new(Keystore::default());
    let (controller, mut own) = registered(folder.path(), account(), key.clone());
    let remote = e2ee::RootBackupState {
        scope: own.scope.clone(),
        active: None,
    };
    let preview = call(
        &controller,
        &own,
        json!({"action":"preview_backup","remote":remote}),
    );
    let directory = serde_json::to_string(&own).unwrap();
    let second = CryptoInstallation::open(
        folder.path().to_string_lossy().into(),
        account(),
        key.clone(),
    )
    .unwrap();
    assert!(
        second
            .recovery_action(
                directory.clone(),
                json!({"action":"prepare_backup","id":preview["id"]}).to_string()
            )
            .is_err()
    );
    let status = call(
        &controller,
        &own,
        json!({"action":"prepare_backup","id":preview["id"]}),
    );
    assert_eq!(status["pending"], true);
    assert_eq!(status["code_saved"], false);
    assert!(status.get("code").is_none());
    assert!(
        controller
            .recovery_action(directory.clone(), r#"{"action":"pending"}"#.into())
            .is_err()
    );
    let code = call(&controller, &own, json!({"action":"code"}));
    let code = Zeroizing::new(code["code"].as_str().unwrap().to_owned());
    assert_eq!(code.len(), 78);
    call(&controller, &own, json!({"action":"confirm_saved"}));
    let original = request(&controller, &own);
    let accepted = receipt(&original);
    let remote = e2ee::RootBackupState {
        scope: own.scope.clone(),
        active: Some(e2ee::RootBackupVersion {
            publication: original.publication.clone(),
            receipt: accepted.clone(),
        }),
    };
    controller.stop();
    assert!(
        controller
            .recovery_action(directory.clone(), r#"{"action":"code"}"#.into())
            .is_err()
    );
    let controller = CryptoInstallation::open(
        folder.path().to_string_lossy().into(),
        account(),
        key.clone(),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(request(&controller, &own)).unwrap(),
        serde_json::to_value(&original).unwrap()
    );
    let mut selected = account();
    selected.device = "recovered-phone".into();
    let phone = CryptoInstallation::open(
        folder.path().to_string_lossy().into(),
        selected.clone(),
        key.clone(),
    )
    .unwrap();
    let wrong = rv_crypto::identity::recovery::RecoverySecret::generate()
        .unwrap()
        .for_display();
    assert!(phone.recovery_action(directory.clone(),json!({"action":"preview_restore","remote":remote,"code":wrong.as_str(),"fingerprint":accepted.root_fingerprint}).to_string()).is_err());
    assert!(phone.status().unwrap().phase == InstallationPhase::Missing);
    let preview = call(
        &phone,
        &own,
        json!({"action":"preview_restore","remote":remote,"code":code.as_str(),"fingerprint":accepted.root_fingerprint}),
    );
    assert!(phone.status().unwrap().phase == InstallationPhase::Missing);
    let another = CryptoInstallation::open(
        folder.path().to_string_lossy().into(),
        selected.clone(),
        key.clone(),
    )
    .unwrap();
    assert!(
        another
            .recovery_action(
                directory.clone(),
                json!({"action":"restore","id":preview["id"]}).to_string()
            )
            .is_err()
    );
    phone.stop();
    let phone =
        CryptoInstallation::open(folder.path().to_string_lossy().into(), selected, key).unwrap();
    assert!(
        phone
            .recovery_action(
                directory.clone(),
                json!({"action":"restore","id":preview["id"]}).to_string()
            )
            .is_err()
    );
    let preview = call(
        &phone,
        &own,
        json!({"action":"preview_restore","remote":remote,"code":code.as_str(),"fingerprint":accepted.root_fingerprint}),
    );
    assert_eq!(
        call(&phone, &own, json!({"action":"restore","id":preview["id"]}))["restored"],
        true
    );
    let restored = phone.identity_view(directory.clone()).unwrap();
    assert!(restored.phase == IdentityPhase::IdentityCreated && restored.controls_root);
    assert_eq!(restored.root_fingerprint, accepted.root_fingerprint);
    let approval = phone
        .identity_preview(directory.clone(), restored.request_code)
        .unwrap();
    let grant = phone
        .identity_approve(directory.clone(), approval.id)
        .unwrap();
    phone.identity_install(directory.clone(), grant).unwrap();
    let (received, _, device) = registration_public(&phone.identity_pending(directory).unwrap());
    assert_ne!(device.incarnation, own.devices[0].incarnation);
    assert_ne!(device.certificate, own.devices[0].certificate);
    own.devices.push(device);
    phone
        .identity_acknowledge(
            serde_json::to_string(&own).unwrap(),
            serde_json::to_string(&received).unwrap(),
        )
        .unwrap();
    let status = call(
        &controller,
        &own,
        json!({"action":"acknowledge","receipt":accepted}),
    );
    assert_eq!(status["pending"], false);
    assert!(
        controller
            .recovery_action(
                serde_json::to_string(&own).unwrap(),
                r#"{"action":"code"}"#.into()
            )
            .is_err()
    );
    assert!(
        controller
            .recovery_action(
                serde_json::to_string(&own).unwrap(),
                r#"{"action":"view","private_seed":"forbidden"}"#.into()
            )
            .is_err()
    );
}
#[test]
fn native_abandonment_survives_stop_and_reopen_and_cannot_be_retried_as_publication() {
    let folder = tempfile::tempdir().unwrap();
    let key = Arc::new(Keystore::default());
    let (view, own) = registered(folder.path(), account(), key.clone());
    let directory = serde_json::to_string(&own).unwrap();
    let remote = e2ee::RootBackupState {
        scope: own.scope.clone(),
        active: None,
    };
    let preview = call(
        &view,
        &own,
        json!({"action":"preview_backup","remote":remote}),
    );
    call(
        &view,
        &own,
        json!({"action":"prepare_backup","id":preview["id"]}),
    );
    call(&view, &own, json!({"action":"confirm_saved"}));
    let original = request(&view, &own);
    let cancelled = call(&view, &own, json!({"action":"request_cancel"}));
    assert_eq!(cancelled, serde_json::to_value(&original).unwrap());
    assert!(
        view.recovery_action(directory.clone(), r#"{"action":"pending"}"#.into())
            .is_err()
    );
    view.stop();
    let view =
        CryptoInstallation::open(folder.path().to_string_lossy().into(), account(), key).unwrap();
    assert_eq!(
        call(&view, &own, json!({"action":"pending_cancel"})),
        cancelled
    );
    let p = Publication::from_bytes(&B64.decode(original.publication.as_bytes()).unwrap()).unwrap();
    let accepted = receipt(&original);
    let e2ee::RootBackupReceipt {
        backup_revision: _,
        scope,
        operation_id,
        device_id,
        incarnation,
        device_revision,
        root_fingerprint,
        backup_id,
        packet_digest,
    } = accepted;
    let result = e2ee::RootBackupSettlement::Cancelled(e2ee::RootBackupCancellation {
        scope,
        operation_id,
        device_id,
        incarnation,
        device_revision,
        root_fingerprint,
        backup_id,
        expected_revision: p.body.expected_revision,
        packet_digest,
    });
    let status = call(
        &view,
        &own,
        json!({"action":"settle_cancel","result":result}),
    );
    assert_eq!(status["pending"], false);
    assert!(
        view.recovery_action(directory, r#"{"action":"code"}"#.into())
            .is_err()
    );
}
