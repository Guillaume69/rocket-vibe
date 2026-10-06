use super::*;
use crate::tests::{Keystore, account, registered};
use data_encoding::{BASE64URL_NOPAD as B64, HEXLOWER};
use rv_crypto_public::history_backup::Publication;
use serde_json::{Value, json};

fn call(view: &CryptoInstallation, d: &e2ee::Directory, input: Value) -> Result<Value> {
    view.history_backup_action(serde_json::to_string(d).unwrap(), input.to_string())
        .map(|s| serde_json::from_str(&s).unwrap())
}

#[test]
fn native_history_code_is_explicit_the_preview_is_handle_bound_and_the_code_joins() {
    let folder = tempfile::tempdir().unwrap();
    let key = Arc::new(Keystore::default());
    let (controller, own) = registered(folder.path(), account(), key.clone());
    let nothing = json!({"scope": own.scope, "active": null});
    let preview = call(
        &controller,
        &own,
        json!({"action":"preview","remote":nothing}),
    )
    .unwrap();
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
            json!({"action":"prepare","id":preview["id"]})
        )
        .is_err()
    );
    let status = call(
        &controller,
        &own,
        json!({"action":"prepare","id":preview["id"]}),
    )
    .unwrap();
    assert_eq!(status["pending"], true);
    assert!(call(&controller, &own, json!({"action":"pending"})).is_err());
    let code = call(&controller, &own, json!({"action":"code"})).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(code.starts_with("rvh1-"));
    call(&controller, &own, json!({"action":"confirm_saved"})).unwrap();
    let request: e2ee::PublishHistoryKey =
        serde_json::from_value(call(&controller, &own, json!({"action":"pending"})).unwrap())
            .unwrap();
    assert!(!request.publication.contains(&code));
    let p = Publication::from_bytes(&B64.decode(request.publication.as_bytes()).unwrap()).unwrap();
    let receipt = json!({"scope":request.scope,"operation_id":request.operation_id,"device_id":p.body.device,
        "incarnation":HEXLOWER.encode(&p.body.incarnation),"device_revision":p.body.device_revision,
        "root_fingerprint":HEXLOWER.encode(&p.package.header.root.fingerprint().unwrap()),
        "generation":HEXLOWER.encode(&p.package.header.generation),"generation_revision":"1",
        "package_digest":HEXLOWER.encode(&p.body.package_digest)});
    let status = call(
        &controller,
        &own,
        json!({"action":"acknowledge","receipt":receipt}),
    )
    .unwrap();
    assert_eq!(status["holds_key"], true);
    assert!(call(&controller, &own, json!({"action":"code"})).is_err());
    // Nothing observed yet: nothing to upload, and an unknown field is refused.
    let published = json!({"scope": own.scope, "active": {"publication": request.publication, "receipt": receipt}});
    assert!(call(&controller, &own, json!({"action":"upload"})).is_err());
    assert_eq!(
        call(&controller, &own, json!({"action":"upload","remote":published})).unwrap()["upload"],
        Value::Null
    );
    assert!(call(&controller, &own, json!({"action":"view","code":code})).is_err());
    // The code joins the active generation.
    let active = json!({"scope": own.scope, "active": {"publication": request.publication, "receipt": receipt}});
    assert!(
        call(
            &controller,
            &own,
            json!({"action":"join","remote":active,"code":"rvh1-wrong"})
        )
        .is_err()
    );
    let joined = call(
        &controller,
        &own,
        json!({"action":"join","remote":active,"code":code}),
    )
    .unwrap();
    assert_eq!(joined["generation"], status["generation"]);
    controller.stop();
    assert!(call(&controller, &own, json!({"action":"view"})).is_err());
}
