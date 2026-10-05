use super::*;
use crate::tests::{Keystore, account, registered, registration_public};
use serde_json::{Value, json};

fn call(view: &CryptoInstallation, d: &e2ee::Directory, input: Value) -> Result<Value> {
    view.history_action(serde_json::to_string(d).unwrap(), input.to_string())
        .map(|s| serde_json::from_str(&s).unwrap())
}
/// A phone of the same account, approved by the controller.
fn phone(
    folder: &std::path::Path,
    key: Arc<Keystore>,
    controller: &CryptoInstallation,
    own: &mut e2ee::Directory,
) -> Arc<CryptoInstallation> {
    let mut selected = account();
    selected.device = "phone".into();
    let phone = CryptoInstallation::open(folder.to_string_lossy().into(), selected, key).unwrap();
    let directory = serde_json::to_string(&*own).unwrap();
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
            serde_json::to_string(&*own).unwrap(),
            serde_json::to_string(&receipt).unwrap(),
        )
        .unwrap();
    phone
}
fn listed(own: &e2ee::Directory, entries: Vec<Value>) -> e2ee::HistoryRequests {
    serde_json::from_value(json!({"scope": own.scope, "requests": entries})).unwrap()
}

#[test]
fn native_history_offers_are_directory_bound_previews_are_handle_bound_and_nothing_empty_is_shared()
{
    let folder = tempfile::tempdir().unwrap();
    let key = Arc::new(Keystore::default());
    let (controller, mut own) = registered(folder.path(), account(), key.clone());
    let phone = phone(folder.path(), key.clone(), &controller, &mut own);
    let request = call(&phone, &own, json!({"action":"request"})).unwrap();
    let fingerprint = request["fingerprint"].as_str().unwrap().to_owned();
    // Replayed: same request until it expires or is answered.
    assert_eq!(
        call(&phone, &own, json!({"action":"request"})).unwrap()["fingerprint"],
        fingerprint.as_str()
    );
    let view = call(&phone, &own, json!({"action":"view"})).unwrap();
    assert_eq!(view["pending"], fingerprint.as_str());
    assert_eq!(view["sharing"], Value::Null);
    assert_eq!(view["importing"], Value::Null);
    let entry = json!({
        "fingerprint": fingerprint,
        "device_id": "phone",
        "request": request["input"]["request"],
        "expires_at": "0",
        "sharer_device_id": null,
        "committed": false,
    });
    // The phone never answers itself; the controller sees its request.
    let none = call(
        &phone,
        &own,
        json!({"action":"offers","listed":listed(&own, vec![entry.clone()])}),
    )
    .unwrap();
    assert!(none["offers"].as_array().unwrap().is_empty());
    let offers = call(
        &controller,
        &own,
        json!({"action":"offers","listed":listed(&own, vec![entry.clone()])}),
    )
    .unwrap();
    assert_eq!(offers["offers"].as_array().unwrap().len(), 1);
    assert_eq!(offers["offers"][0]["device"], "phone");
    // Another handle of the same installation cannot use this staged offer.
    let second = CryptoInstallation::open(
        folder.path().to_string_lossy().into(),
        account(),
        key.clone(),
    )
    .unwrap();
    assert!(
        call(
            &second,
            &own,
            json!({"action":"preview","id":offers["id"],"fingerprint":fingerprint})
        )
        .is_err()
    );
    let preview = call(
        &controller,
        &own,
        json!({"action":"preview","id":offers["id"],"fingerprint":fingerprint}),
    )
    .unwrap();
    assert_eq!(preview["fingerprint"], fingerprint.as_str());
    assert!(preview["periods"].as_array().unwrap().is_empty());
    // The offer was consumed by its preview.
    assert!(
        call(
            &controller,
            &own,
            json!({"action":"preview","id":offers["id"],"fingerprint":fingerprint})
        )
        .is_err()
    );
    // No observed history: nothing to share, nothing to upload.
    assert!(
        call(
            &controller,
            &own,
            json!({"action":"approve","id":preview["id"]})
        )
        .is_err()
    );
    assert_eq!(
        call(&controller, &own, json!({"action":"upload"})).unwrap()["upload"],
        Value::Null
    );
    assert!(
        call(
            &controller,
            &own,
            json!({"action":"uploaded","receipt":{"period":0,"count":"1"}})
        )
        .is_err()
    );
    // A page without an open import, and unknown fields, are refused.
    assert!(
        call(
            &phone,
            &own,
            json!({"action":"import_page","page":{"period":0,"start":"0","records":[],"next":null}})
        )
        .is_err()
    );
    assert!(call(&phone, &own, json!({"action":"view","extra":1})).is_err());
    // Only the phone's own requests nothing waits for are acknowledgeable.
    let mut stale = entry.clone();
    stale["fingerprint"] = json!("ab".repeat(32));
    let acks = call(
        &phone,
        &own,
        json!({"action":"acknowledgeable","listed":listed(&own, vec![entry, stale])}),
    )
    .unwrap();
    assert_eq!(acks["requests"], json!(["ab".repeat(32)]));
    phone.stop();
    assert!(call(&phone, &own, json!({"action":"view"})).is_err());
}
