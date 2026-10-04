use super::tests::{Keystore, account, registered};
use super::*;
use data_encoding::{BASE64URL_NOPAD as B64, HEXLOWER};
use rv_protocol::e2ee as http;
use serde_json::{Value, json};

fn call(c: &CryptoInstallation, own: &http::Directory, request: Value) -> Value {
    serde_json::from_str(
        &c.group_action(serde_json::to_string(own).unwrap(), request.to_string())
            .unwrap(),
    )
    .unwrap()
}
fn approve(c: &CryptoInstallation, own: &http::Directory, peer: &http::Directory) {
    let own = serde_json::to_string(own).unwrap();
    let wire = serde_json::to_string(peer).unwrap();
    let identity = peer.identity.as_ref().unwrap();
    let view = c
        .peer_view(own.clone(), identity.user_id.clone(), wire.clone())
        .unwrap();
    let view = c
        .peer_pin(
            own.clone(),
            wire.clone(),
            view.id,
            "first_contact".into(),
            identity.fingerprint.clone(),
            String::new(),
        )
        .unwrap();
    let preview = c
        .peer_preview(
            own.clone(),
            wire.clone(),
            view.id,
            peer.devices[0].device_id.clone(),
        )
        .unwrap();
    c.peer_approve(own, wire, preview.id).unwrap();
}
fn packages(c: &CryptoInstallation, own: &http::Directory) -> Vec<http::AvailableKeyPackage> {
    use openmls::prelude::{
        KeyPackageIn, OpenMlsProvider, ProtocolVersion, tls_codec::Deserialize as _,
    };
    use openmls_rust_crypto::OpenMlsRustCrypto;
    call(c, own, json!({"action":"packages_prepare"}));
    let request: http::PublishKeyPackages =
        serde_json::from_value(call(c, own, json!({"action":"packages_retry"}))).unwrap();
    let provider = OpenMlsRustCrypto::default();
    let available: Vec<_> = request
        .packages
        .iter()
        .map(|wire| {
            let raw = B64.decode(wire.as_bytes()).unwrap();
            let package = KeyPackageIn::tls_deserialize_exact(&raw)
                .unwrap()
                .validate(provider.crypto(), ProtocolVersion::Mls10)
                .unwrap();
            http::AvailableKeyPackage {
                scope: request.scope.clone(),
                user_id: own.identity.as_ref().unwrap().user_id.clone(),
                device_id: own.devices[0].device_id.clone(),
                incarnation: own.devices[0].incarnation.clone(),
                reference: B64.encode(package.hash_ref(provider.crypto()).unwrap().as_slice()),
                wire: wire.clone(),
            }
        })
        .collect();
    let receipt = http::OperationReceipt {
        scope: request.scope,
        operation_id: request.operation_id,
        kind: "publish_key_packages".into(),
        device_id: own.devices[0].device_id.clone(),
        incarnation: own.devices[0].incarnation.clone(),
        device_revision: request.device_revision,
        root_fingerprint: own.identity.as_ref().unwrap().fingerprint.clone(),
        key_package_refs: available.iter().map(|v| v.reference.clone()).collect(),
    };
    call(
        c,
        own,
        json!({"action":"packages_acknowledge","receipt":receipt}),
    );
    available
}
fn receipt(packet: &http::GroupSubmission, room: &str) -> http::GroupReceipt {
    let transition = rv_crypto_public::groups::Transition::from_bytes(
        &B64.decode(packet.transition.as_bytes()).unwrap(),
    )
    .unwrap();
    transition.authenticate().unwrap();
    http::GroupReceipt {
        scope: packet.scope.clone(),
        room_id: room.into(),
        incarnation: HEXLOWER.encode(&transition.plan.scope.incarnation),
        operation_id: packet.operation_id.clone(),
        revision: (transition.plan.expected_revision + 1).to_string(),
        epoch: transition.plan.epoch.to_string(),
        fingerprint: HEXLOWER.encode(&transition.fingerprint().unwrap()),
    }
}
#[test]
fn two_native_actors_create_join_rotate_reopen_original_and_cancel_without_exporting_private_state()
{
    let path = tempfile::tempdir().unwrap();
    let key = Arc::new(Keystore::default());
    let (alice, own) = registered(path.path(), account(), key.clone());
    let mut selected = account();
    selected.user = "bob".into();
    selected.device = "bob-phone".into();
    let (bob, peer) = registered(path.path(), selected, key.clone());
    approve(&alice, &own, &peer);
    approve(&bob, &peer, &own);
    let available = packages(&bob, &peer);
    let mut roster = http::GroupRoster {
        scope: own.scope.clone(),
        room_id: "room".into(),
        authority_version: "authority".into(),
        members: vec![
            http::GroupMember {
                user_id: "alice".into(),
                access_version: "alice-access".into(),
                activation_version: "alice-active".into(),
            },
            http::GroupMember {
                user_id: "bob".into(),
                access_version: "bob-access".into(),
                activation_version: "bob-active".into(),
            },
        ],
        group: None,
    };
    let writes = *key.writes.lock().unwrap();
    assert!(call(&alice, &own, json!({"action":"view","roster":roster}))["accepted"].is_null());
    assert_eq!(*key.writes.lock().unwrap(), writes);
    let preview = call(
        &alice,
        &own,
        json!({"action":"preview","roster":roster,"packages":[available[0]],"removals":[],"event":null}),
    );
    assert!(call(&alice, &own, json!({"action":"pending","room":"room"})).is_null());
    assert_eq!(preview["recipients"].as_array().unwrap().len(), 2);
    call(
        &alice,
        &own,
        json!({"action":"confirm","roster":roster,"id":preview["id"],"fingerprint":preview["fingerprint"]}),
    );
    let original = call(&alice, &own, json!({"action":"retry","room":"room"}));
    alice.stop();
    drop(alice);
    let alice =
        CryptoInstallation::open(path.path().to_string_lossy().into(), account(), key.clone())
            .unwrap();
    assert_eq!(
        original,
        call(&alice, &own, json!({"action":"retry","room":"room"}))
    );
    let packet: http::GroupSubmission = serde_json::from_value(original).unwrap();
    let ack = receipt(&packet, "room");
    let mut wrong = ack.clone();
    wrong.epoch = (ack.epoch.parse::<u64>().unwrap() + 1).to_string();
    assert!(
        alice
            .group_action(
                serde_json::to_string(&own).unwrap(),
                json!({"action":"acknowledge","room":"room","receipt":wrong}).to_string()
            )
            .is_err()
    );
    call(
        &alice,
        &own,
        json!({"action":"acknowledge","room":"room","receipt":ack}),
    );
    roster.group = Some(ack.clone());
    let event = http::GroupEvent {
        receipt: ack.clone(),
        transition: packet.transition.clone(),
        commit: packet.commit.clone(),
        welcome: Some(packet.welcomes[0].clone()),
    };
    let state = http::GroupState {
        receipt: ack.clone(),
        needs_rekey: false,
        transition: packet.transition.clone(),
        tree: packet.tree.clone(),
    };
    assert_eq!(
        call(
            &bob,
            &peer,
            json!({"action":"events","roster":roster,"state":state,"page":{"events":[event],"next":null}})
        )["receipt"]["fingerprint"],
        ack.fingerprint
    );
    let preview = call(
        &bob,
        &peer,
        json!({"action":"preview","roster":roster,"packages":[],"removals":[],"event":event}),
    );
    assert_eq!(preview["kind"], "admission");
    call(
        &bob,
        &peer,
        json!({"action":"confirm","roster":roster,"id":preview["id"],"fingerprint":preview["fingerprint"]}),
    );
    assert_eq!(
        call(&bob, &peer, json!({"action":"view","roster":roster}))["accepted"]["fingerprint"],
        ack.fingerprint
    );
    let preview = call(
        &alice,
        &own,
        json!({"action":"preview","roster":roster,"packages":[],"removals":[],"event":null}),
    );
    // A rejoin with a different grant must invalidate consent, even on one room.
    let mut changed = roster.clone();
    changed.members[1].access_version = "new-bob-access".into();
    assert!(alice.group_action(serde_json::to_string(&own).unwrap(),json!({"action":"confirm","roster":changed,"id":preview["id"],"fingerprint":preview["fingerprint"]}).to_string()).is_err());
    let preview = call(
        &alice,
        &own,
        json!({"action":"preview","roster":roster,"packages":[],"removals":[],"event":null}),
    );
    call(
        &alice,
        &own,
        json!({"action":"confirm","roster":roster,"id":preview["id"],"fingerprint":preview["fingerprint"]}),
    );
    let packet: http::GroupSubmission =
        serde_json::from_value(call(&alice, &own, json!({"action":"retry","room":"room"})))
            .unwrap();
    let ack = receipt(&packet, "room");
    call(
        &alice,
        &own,
        json!({"action":"acknowledge","room":"room","receipt":ack}),
    );
    roster.group = Some(ack.clone());
    let event = http::GroupEvent {
        receipt: ack.clone(),
        transition: packet.transition,
        commit: packet.commit,
        welcome: None,
    };
    let preview = call(
        &bob,
        &peer,
        json!({"action":"preview","roster":roster,"packages":[],"removals":[],"event":event}),
    );
    assert_eq!(preview["kind"], "commit");
    call(
        &bob,
        &peer,
        json!({"action":"confirm","roster":roster,"id":preview["id"],"fingerprint":preview["fingerprint"]}),
    );
    assert_eq!(
        call(&bob, &peer, json!({"action":"view","roster":roster}))["accepted"]["epoch"],
        ack.epoch
    );
    let preview = call(
        &alice,
        &own,
        json!({"action":"preview","roster":roster,"packages":[],"removals":[],"event":null}),
    );
    call(
        &alice,
        &own,
        json!({"action":"confirm","roster":roster,"id":preview["id"],"fingerprint":preview["fingerprint"]}),
    );
    let pending = call(&alice, &own, json!({"action":"pending","room":"room"}));
    let cancellation = call(&alice, &own, json!({"action":"cancel","room":"room"}));
    assert_eq!(
        cancellation["original"]["operation_id"],
        pending["operation"]
    );
    assert_eq!(
        call(&alice, &own, json!({"action":"pending","room":"room"}))["cancelling"],
        true
    );
    let decision = json!({"kind":"cancelled","data":{"scope":own.scope,"room_id":"room","incarnation":ack.incarnation,
        "operation_id":pending["operation"],"device_id":"android","fingerprint":pending["fingerprint"]}});
    call(
        &alice,
        &own,
        json!({"action":"settle","room":"room","settlement":decision}),
    );
    assert!(call(&alice, &own, json!({"action":"pending","room":"room"})).is_null());
    assert_eq!(
        call(&alice, &own, json!({"action":"view","roster":roster}))["accepted"]["epoch"],
        ack.epoch
    );
}
