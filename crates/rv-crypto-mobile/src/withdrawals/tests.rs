use super::*;
use crate::tests::{Keystore, account, registered, registration_public};
use serde_json::{Value, json};
fn call(view: &CryptoInstallation, directory: &e2ee::Directory, action: Value) -> Value {
    serde_json::from_str(
        &view
            .withdrawal_action(
                serde_json::to_string(directory).unwrap(),
                action.to_string(),
            )
            .unwrap(),
    )
    .unwrap()
}
#[test]
fn native_withdrawal_consent_is_handle_bound_and_the_original_survives_stop_and_reopen() {
    let folder = tempfile::tempdir().unwrap();
    let key = Arc::new(Keystore::default());
    let (controller, mut own) = registered(folder.path(), account(), key.clone());
    let mut selected = account();
    selected.device = "phone".into();
    let phone = CryptoInstallation::open(
        folder.path().to_string_lossy().into(),
        selected,
        key.clone(),
    )
    .unwrap();
    let directory = serde_json::to_string(&own).unwrap();
    let waiting = phone
        .identity_begin(
            directory.clone(),
            own.identity.as_ref().unwrap().fingerprint.clone(),
        )
        .unwrap();
    let preview = controller
        .identity_preview(directory.clone(), waiting.request_code)
        .unwrap();
    let grant = controller
        .identity_approve(directory.clone(), preview.id)
        .unwrap();
    phone.identity_install(directory.clone(), grant).unwrap();
    let (receipt, _, device) = registration_public(&phone.identity_pending(directory).unwrap());
    own.devices.push(device);
    phone
        .identity_acknowledge(
            serde_json::to_string(&own).unwrap(),
            serde_json::to_string(&receipt).unwrap(),
        )
        .unwrap();
    let status = call(&controller, &own, json!({"action":"view"}));
    assert_eq!(status["devices"].as_array().unwrap().len(), 1);
    let fp = status["devices"][0]["fingerprint"].as_str().unwrap();
    let preview = call(
        &controller,
        &own,
        json!({"action":"preview","device":"phone","fingerprint":fp}),
    );
    assert_eq!(preview["incarnation"], own.devices[1].incarnation);
    assert!(
        controller
            .withdrawal_action(
                serde_json::to_string(&own).unwrap(),
                r#"{"action":"pending"}"#.into()
            )
            .is_err()
    );
    assert!(
        phone
            .withdrawal_action(
                serde_json::to_string(&own).unwrap(),
                json!({"action":"prepare","id":preview["id"]}).to_string()
            )
            .is_err()
    );
    let second_handle = CryptoInstallation::open(
        folder.path().to_string_lossy().into(),
        account(),
        key.clone(),
    )
    .unwrap();
    assert!(
        second_handle
            .withdrawal_action(
                serde_json::to_string(&own).unwrap(),
                json!({"action":"prepare","id":preview["id"]}).to_string()
            )
            .is_err()
    );
    let original = call(
        &controller,
        &own,
        json!({"action":"prepare","id":preview["id"]}),
    );
    assert_eq!(
        call(&controller, &own, json!({"action":"pending"})),
        original
    );
    assert_eq!(
        call(&controller, &own, json!({"action":"view"}))["pending"]["device"],
        "phone"
    );
    controller.stop();
    assert!(
        controller
            .withdrawal_action(
                serde_json::to_string(&own).unwrap(),
                r#"{"action":"pending"}"#.into()
            )
            .is_err()
    );
    let reopened =
        CryptoInstallation::open(folder.path().to_string_lossy().into(), account(), key).unwrap();
    assert_eq!(call(&reopened, &own, json!({"action":"pending"})), original);
    let mut receipt = json!({"scope":own.scope,"operation_id":original["operation_id"],"kind":"revoke_device",
        "device_id":"phone","incarnation":own.devices[0].incarnation,"device_revision":"1",
        "root_fingerprint":own.identity.as_ref().unwrap().fingerprint,"key_package_refs":[]});
    assert!(
        reopened
            .withdrawal_action(
                serde_json::to_string(&own).unwrap(),
                json!({"action":"acknowledge","receipt":receipt}).to_string()
            )
            .is_err()
    );
    receipt["device_id"] = json!(account().device);
    let accepted = call(
        &reopened,
        &own,
        json!({"action":"acknowledge","receipt":receipt}),
    );
    assert!(accepted["pending"].is_null());
    assert_eq!(accepted["withdrawn"].as_array().unwrap().len(), 1);
    assert!(accepted["devices"].as_array().unwrap().is_empty());
    assert!(own.revocations.is_empty());
    assert_eq!(
        call(&reopened, &own, json!({"action":"view"}))["withdrawn"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        reopened
            .withdrawal_action(
                serde_json::to_string(&own).unwrap(),
                r#"{"action":"view","private_seed":"forbidden"}"#.into()
            )
            .is_err()
    );
    reopened.stop();
    phone.stop();
    second_handle.stop();
}
