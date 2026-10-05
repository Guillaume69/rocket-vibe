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
fn conversation(
    c: &CryptoInstallation,
    own: &http::Directory,
    roster: &http::GroupRoster,
    state: &http::GroupState,
    thread: Option<&str>,
    command: Value,
) -> Value {
    serde_json::from_str(
        &c.conversation_action(
            serde_json::to_string(own).unwrap(),
            json!({"roster":roster,"state":state,"thread":thread,"command":command}).to_string(),
        )
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn private_mobile_messages_keep_originals_drafts_and_verified_journal_across_reopen() {
    let path = tempfile::tempdir().unwrap();
    let key = Arc::new(Keystore::default());
    let (alice, own) = registered(path.path(), account(), key.clone());
    let mut bob_account = account();
    bob_account.user = "bob".into();
    bob_account.device = "bob-phone".into();
    let (bob, peer) = registered(path.path(), bob_account, key.clone());
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
    let preview = call(
        &alice,
        &own,
        json!({"action":"preview","roster":roster,"packages":[available[0]],"removals":[],"event":null}),
    );
    call(
        &alice,
        &own,
        json!({"action":"confirm","roster":roster,"id":preview["id"],"fingerprint":preview["fingerprint"]}),
    );
    let group: http::GroupSubmission =
        serde_json::from_value(call(&alice, &own, json!({"action":"retry","room":"room"})))
            .unwrap();
    let ack = receipt(&group, "room");
    call(
        &alice,
        &own,
        json!({"action":"acknowledge","room":"room","receipt":ack}),
    );
    roster.group = Some(ack.clone());
    let welcome = http::GroupEvent {
        receipt: ack.clone(),
        transition: group.transition.clone(),
        commit: group.commit.clone(),
        welcome: Some(group.welcomes[0].clone()),
    };
    let preview = call(
        &bob,
        &peer,
        json!({"action":"preview","roster":roster,"packages":[],"removals":[],"event":welcome}),
    );
    call(
        &bob,
        &peer,
        json!({"action":"confirm","roster":roster,"id":preview["id"],"fingerprint":preview["fingerprint"]}),
    );
    let state = http::GroupState {
        receipt: ack.clone(),
        needs_rekey: false,
        transition: group.transition.clone(),
        tree: group.tree,
    };
    let genesis = http::GroupEvent {
        welcome: None,
        ..welcome.clone()
    };
    let mut bootstrap = http::DeliveryPage {
        scope: own.scope.clone(),
        room_id: "room".into(),
        incarnation: ack.incarnation.clone(),
        after: "0".into(),
        through: "1".into(),
        events: vec![http::DeliveryEvent {
            position: "1".into(),
            content: http::DeliveryContent::Group(genesis),
        }],
        next: None,
    };
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"receive","page":bootstrap}),
    );
    bootstrap.events[0].content = http::DeliveryContent::Group(welcome);
    conversation(
        &bob,
        &peer,
        &roster,
        &state,
        None,
        json!({"action":"receive","page":bootstrap}),
    );
    let view = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"view","before":null,"limit":200}),
    );
    assert_eq!(view["can_send"], true);
    assert_eq!(view["messages"].as_array().unwrap().len(), 0);
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"draft","text":"private original"}),
    );
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        Some("root"),
        json!({"action":"draft","text":"separate private thread"}),
    );
    let prepared = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"prepare","text":"private original"}),
    );
    let operation = prepared["operation"].as_str().unwrap();
    let original = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"retry","operation":operation}),
    );
    assert!(!original.to_string().contains("private original"));
    alice.stop();
    drop(alice);
    let alice =
        CryptoInstallation::open(path.path().to_string_lossy().into(), account(), key.clone())
            .unwrap();
    assert_eq!(
        original,
        conversation(
            &alice,
            &own,
            &roster,
            &state,
            None,
            json!({"action":"retry","operation":operation})
        )
    );
    assert_eq!(
        conversation(
            &alice,
            &own,
            &roster,
            &state,
            Some("root"),
            json!({"action":"draft","text":null})
        ),
        "separate private thread"
    );
    let packet: http::ApplicationSubmission = serde_json::from_value(original).unwrap();
    let proof = rv_crypto_public::messages::Proof::from_bytes(
        &B64.decode(packet.proof.as_bytes()).unwrap(),
    )
    .unwrap();
    let first = rv_crypto_public::messages::message_id(&proof.fingerprint().unwrap());
    let receipt = http::ApplicationReceipt {
        scope: own.scope.clone(),
        room_id: "room".into(),
        operation_id: operation.into(),
        header: B64.encode(&serde_json::to_vec(&proof.header).unwrap()),
        fingerprint: HEXLOWER.encode(&proof.fingerprint().unwrap()),
        message_id: first.clone(),
        position: "9007199254740993".into(),
    };
    let mut wrong = receipt.clone();
    wrong.fingerprint = "00".repeat(32);
    assert!(
        alice
            .conversation_action(
                serde_json::to_string(&own).unwrap(),
                json!({"roster":roster,"state":state,"thread":null,
        "command":{"action":"acknowledge","receipt":wrong}})
                .to_string()
            )
            .is_err()
    );
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"draft","text":"newer authored draft"}),
    );
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"acknowledge","receipt":receipt}),
    );
    assert_eq!(
        conversation(
            &alice,
            &own,
            &roster,
            &state,
            None,
            json!({"action":"draft","text":null})
        ),
        "newer authored draft"
    );
    let mut page = http::DeliveryPage {
        scope: own.scope.clone(),
        room_id: "room".into(),
        incarnation: ack.incarnation.clone(),
        after: "1".into(),
        through: receipt.position.clone(),
        events: vec![http::DeliveryEvent {
            position: receipt.position.clone(),
            content: http::DeliveryContent::Message(http::ApplicationMessage {
                receipt: receipt.clone(),
                proof: packet.proof.clone(),
                ciphertext: packet.ciphertext.clone(),
            }),
        }],
        next: None,
    };
    if let http::DeliveryContent::Message(message) = &mut page.events[0].content {
        message.ciphertext = "YWJj".into();
    }
    assert!(
        bob.conversation_action(
            serde_json::to_string(&peer).unwrap(),
            json!({"roster":roster,"state":state,"thread":null,
        "command":{"action":"receive","page":page}})
            .to_string()
        )
        .is_err()
    );
    assert_eq!(
        conversation(
            &bob,
            &peer,
            &roster,
            &state,
            None,
            json!({"action":"journal_request"})
        )["after"],
        "1"
    );
    if let http::DeliveryContent::Message(message) = &mut page.events[0].content {
        message.ciphertext = packet.ciphertext;
    }
    for (actor, directory) in [(&*alice, &own), (&*bob, &peer)] {
        conversation(
            actor,
            directory,
            &roster,
            &state,
            None,
            json!({"action":"receive","page":page}),
        );
        let view = conversation(
            actor,
            directory,
            &roster,
            &state,
            None,
            json!({"action":"view","before":null,"limit":200}),
        );
        assert_eq!(view["messages"].as_array().unwrap().len(), 1);
        assert_eq!(view["messages"][0]["document"]["text"], "private original");
        assert_eq!(view["messages"][0]["position"], "9007199254740993");
        assert_eq!(view["messages"][0]["status"], "journaled");
    }
    let rotation = call(
        &alice,
        &own,
        json!({"action":"preview","roster":roster,"packages":[],"removals":[],"event":null}),
    );
    call(
        &alice,
        &own,
        json!({"action":"confirm","roster":roster,"id":rotation["id"],"fingerprint":rotation["fingerprint"]}),
    );
    let rotation: http::GroupSubmission =
        serde_json::from_value(call(&alice, &own, json!({"action":"retry","room":"room"})))
            .unwrap();
    let rotated = self::receipt(&rotation, "room");
    call(
        &alice,
        &own,
        json!({"action":"acknowledge","room":"room","receipt":rotated}),
    );
    roster.group = Some(rotated.clone());
    let state = http::GroupState {
        receipt: rotated.clone(),
        needs_rekey: false,
        transition: rotation.transition.clone(),
        tree: rotation.tree,
    };
    let rotation = http::GroupEvent {
        receipt: rotated,
        transition: rotation.transition,
        commit: rotation.commit,
        welcome: None,
    };
    let page = http::DeliveryPage {
        scope: own.scope.clone(),
        room_id: "room".into(),
        incarnation: ack.incarnation.clone(),
        after: "9007199254740993".into(),
        through: "9007199254740994".into(),
        events: vec![http::DeliveryEvent {
            position: "9007199254740994".into(),
            content: http::DeliveryContent::Group(rotation),
        }],
        next: None,
    };
    for (actor, directory) in [(&*alice, &own), (&*bob, &peer)] {
        conversation(
            actor,
            directory,
            &roster,
            &state,
            None,
            json!({"action":"receive","page":page}),
        );
        let rotated_view = conversation(
            actor,
            directory,
            &roster,
            &state,
            None,
            json!({"action":"view","before":null,"limit":200}),
        );
        if directory.identity.as_ref().unwrap().user_id == "alice" {
            assert_eq!(rotated_view["admission"], view["admission"]);
        }
        assert_eq!(
            rotated_view["messages"][0]["document"]["text"],
            "private original"
        );
    }
    assert_eq!(
        conversation(
            &alice,
            &own,
            &roster,
            &state,
            Some("root"),
            json!({"action":"draft","text":null})
        ),
        "separate private thread"
    );
    let missing = conversation(
        &alice,
        &own,
        &roster,
        &state,
        Some("unknown-root"),
        json!({"action":"view","before":null,"limit":200}),
    );
    assert_eq!(missing["can_send"], false);
    assert!(missing["root"].is_null());
    assert!(alice.conversation_action(serde_json::to_string(&own).unwrap(), json!({"roster":roster,"state":state,"thread":"unknown-root","command":{"action":"prepare","text":"wrong thread"}}).to_string()).is_err());
    let thread_view = conversation(
        &alice,
        &own,
        &roster,
        &state,
        Some(first.as_str()),
        json!({"action":"view","before":null,"limit":200}),
    );
    assert_eq!(thread_view["root"]["document"]["text"], "private original");
    assert_eq!(thread_view["can_send"], true);
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        Some(first.as_str()),
        json!({"action":"draft","text":"private thread reply"}),
    );
    let reply = conversation(
        &alice,
        &own,
        &roster,
        &state,
        Some(first.as_str()),
        json!({"action":"prepare","text":"private thread reply"}),
    );
    let reply_operation = reply["operation"].as_str().unwrap();
    let reply_packet: http::ApplicationSubmission = serde_json::from_value(conversation(
        &alice,
        &own,
        &roster,
        &state,
        Some(first.as_str()),
        json!({"action":"retry","operation":reply_operation}),
    ))
    .unwrap();
    let reply_proof = rv_crypto_public::messages::Proof::from_bytes(
        &B64.decode(reply_packet.proof.as_bytes()).unwrap(),
    )
    .unwrap();
    assert_eq!(reply_proof.header.thread.as_deref(), Some(first.as_str()));
    let thread_reply = rv_crypto_public::messages::message_id(&reply_proof.fingerprint().unwrap());
    let reply_receipt = http::ApplicationReceipt {
        scope: own.scope.clone(),
        room_id: "room".into(),
        operation_id: reply_operation.into(),
        header: B64.encode(&serde_json::to_vec(&reply_proof.header).unwrap()),
        fingerprint: HEXLOWER.encode(&reply_proof.fingerprint().unwrap()),
        message_id: thread_reply.clone(),
        position: "9007199254740995".into(),
    };
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        Some(first.as_str()),
        json!({"action":"acknowledge","receipt":reply_receipt}),
    );
    let reply_page = http::DeliveryPage {
        scope: own.scope.clone(),
        room_id: "room".into(),
        incarnation: ack.incarnation.clone(),
        after: "9007199254740994".into(),
        through: reply_receipt.position.clone(),
        events: vec![http::DeliveryEvent {
            position: reply_receipt.position.clone(),
            content: http::DeliveryContent::Message(http::ApplicationMessage {
                receipt: reply_receipt,
                proof: reply_packet.proof,
                ciphertext: reply_packet.ciphertext,
            }),
        }],
        next: None,
    };
    for (actor, directory) in [(&*alice, &own), (&*bob, &peer)] {
        conversation(
            actor,
            directory,
            &roster,
            &state,
            Some(first.as_str()),
            json!({"action":"receive","page":reply_page}),
        );
        let thread = conversation(
            actor,
            directory,
            &roster,
            &state,
            Some(first.as_str()),
            json!({"action":"view","before":null,"limit":200}),
        );
        assert_eq!(thread["root"]["id"], first.as_str());
        assert_eq!(
            thread["messages"][0]["document"]["reply_to"],
            first.as_str()
        );
        assert_eq!(thread["retained_replies"][first.as_str()], 1);
        let root = conversation(
            actor,
            directory,
            &roster,
            &state,
            None,
            json!({"action":"view","before":null,"limit":200}),
        );
        assert_eq!(root["messages"].as_array().unwrap().len(), 1);
        assert_eq!(root["retained_replies"][first.as_str()], 1);
        let nested = conversation(
            actor,
            directory,
            &roster,
            &state,
            Some(thread_reply.as_str()),
            json!({"action":"view","before":null,"limit":200}),
        );
        assert!(nested["root"].is_null());
        assert_eq!(nested["can_send"], false);
    }
    // The source set includes retained replies even when the root projection
    // does not. Selections carry exact positions and private admissions.
    let sources = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"sources","source":null}),
    );
    assert_eq!(sources["messages"].as_array().unwrap().len(), 2);
    let selected = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"select_quote","message":thread_reply,"membership":"private-membership"}),
    );
    assert_eq!(selected["text"], "private thread reply");
    assert_eq!(
        selected["selection"]["reference"]["revision"],
        "9007199254740995"
    );
    assert_eq!(
        selected["selection"]["crypto_admission"],
        sources["admission"]
    );
    for field in ["crypto_admission", "instance_id", "data_epoch"] {
        let mut invalid = selected["selection"].clone();
        invalid[field] = json!("wrong");
        assert!(
            alice
                .conversation_action(
                    serde_json::to_string(&own).unwrap(),
                    json!({"roster":roster,"state":state,"thread":null,
                "command":{"action":"prepare","text":"","quotes":[invalid],"sources":[]}})
                    .to_string()
                )
                .is_err()
        );
    }
    let mut invalid = selected["selection"].clone();
    invalid["reference"]["revision"] = json!("9007199254740996");
    assert!(
        alice
            .conversation_action(
                serde_json::to_string(&own).unwrap(),
                json!({"roster":roster,"state":state,"thread":null,
            "command":{"action":"prepare","text":"","quotes":[invalid],"sources":[]}})
                .to_string()
            )
            .is_err()
    );
    let ordinary = json!({"reference":{"room_id":"ordinary-room","message_id":"ordinary-source","revision":"9007199254740998"},
        "instance_id":own.scope.instance_id,"data_epoch":own.scope.data_epoch,"membership_version":"ordinary-grant"});
    let ordinary_source = json!({"room_id":"ordinary-room","membership_version":"ordinary-grant","references":[ordinary["reference"]]});
    let mut downgraded = selected["selection"].clone();
    downgraded
        .as_object_mut()
        .unwrap()
        .remove("crypto_admission");
    for (quote, source) in [
        (ordinary.clone(), Value::Null),
        (
            ordinary.clone(),
            json!({"room_id":"ordinary-room","membership_version":"old-grant","references":[ordinary["reference"]]}),
        ),
        (
            ordinary.clone(),
            json!({"room_id":"ordinary-room","membership_version":"ordinary-grant","references":[{"room_id":"ordinary-room","message_id":"ordinary-source","revision":"9007199254740999"}]}),
        ),
        (
            downgraded.clone(),
            json!({"room_id":"room","membership_version":"private-membership","references":[downgraded["reference"]]}),
        ),
    ] {
        let public_sources = if source.is_null() {
            json!([])
        } else {
            json!([source])
        };
        assert!(alice.conversation_action(serde_json::to_string(&own).unwrap(),
            json!({"roster":roster,"state":state,"thread":null,"command":{"action":"prepare","text":"",
                "quotes":[quote],"sources":[],"public_sources":public_sources}}).to_string()).is_err());
    }
    let quoted = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"prepare","text":"","quotes":[selected["selection"],ordinary],"sources":[],"public_sources":[ordinary_source]}),
    );
    let quote_operation = quoted["operation"].as_str().unwrap();
    let quote_original = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"retry","operation":quote_operation}),
    );
    assert!(!quote_original.to_string().contains("private thread reply"));
    alice.stop();
    drop(alice);
    let alice =
        CryptoInstallation::open(path.path().to_string_lossy().into(), account(), key.clone())
            .unwrap();
    assert_eq!(
        quote_original,
        conversation(
            &alice,
            &own,
            &roster,
            &state,
            None,
            json!({"action":"retry","operation":quote_operation})
        )
    );
    let packet: http::ApplicationSubmission = serde_json::from_value(quote_original).unwrap();
    let proof = rv_crypto_public::messages::Proof::from_bytes(
        &B64.decode(packet.proof.as_bytes()).unwrap(),
    )
    .unwrap();
    let private_quote = rv_crypto_public::messages::message_id(&proof.fingerprint().unwrap());
    let quote_receipt = http::ApplicationReceipt {
        scope: own.scope.clone(),
        room_id: "room".into(),
        operation_id: quote_operation.into(),
        header: B64.encode(&serde_json::to_vec(&proof.header).unwrap()),
        fingerprint: HEXLOWER.encode(&proof.fingerprint().unwrap()),
        message_id: private_quote.clone(),
        position: "9007199254740996".into(),
    };
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"acknowledge","receipt":quote_receipt}),
    );
    let quote_page = http::DeliveryPage {
        scope: own.scope.clone(),
        room_id: "room".into(),
        incarnation: ack.incarnation.clone(),
        after: "9007199254740995".into(),
        through: quote_receipt.position.clone(),
        next: None,
        events: vec![http::DeliveryEvent {
            position: quote_receipt.position.clone(),
            content: http::DeliveryContent::Message(http::ApplicationMessage {
                receipt: quote_receipt,
                proof: packet.proof,
                ciphertext: packet.ciphertext,
            }),
        }],
    };
    for (actor, directory) in [(&*alice, &own), (&*bob, &peer)] {
        conversation(
            actor,
            directory,
            &roster,
            &state,
            None,
            json!({"action":"receive","page":quote_page}),
        );
        let view = conversation(
            actor,
            directory,
            &roster,
            &state,
            None,
            json!({"action":"view","before":null,"limit":200}),
        );
        let quoted = view["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == private_quote.as_str())
            .unwrap();
        assert_eq!(quoted["document"]["text"], "");
        assert_eq!(
            quoted["document"]["quotes"],
            json!([selected["selection"]["reference"], ordinary["reference"]])
        );
        assert!(
            !quoted["document"]
                .to_string()
                .contains("private thread reply")
        );
    }
    // Only the author amends; an unsettled edit shows on its target.
    assert!(
        bob.conversation_action(
            serde_json::to_string(&peer).unwrap(),
            json!({"roster":roster,"state":state,"thread":null,"command":{"action":"amend",
            "target":first,"text":"forged"}})
            .to_string()
        )
        .is_err()
    );
    let edit = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"amend","target":first,"text":"private original edited"}),
    );
    let edit_operation = edit["operation"].as_str().unwrap();
    let view = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"view","before":null,"limit":200}),
    );
    let target = |view: &Value| {
        view["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == first.as_str())
            .cloned()
            .unwrap()
    };
    let row = target(&view);
    assert_eq!(
        (&row["status"], &row["amendment"], &row["edited"]),
        (
            &json!("journaled"),
            &json!({"operation":edit_operation,"status":"pending"}),
            &json!(true)
        )
    );
    assert_eq!(row["document"]["text"], "private original edited");
    let packet: http::ApplicationSubmission = serde_json::from_value(conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"retry","operation":edit_operation}),
    ))
    .unwrap();
    let proof = rv_crypto_public::messages::Proof::from_bytes(
        &B64.decode(packet.proof.as_bytes()).unwrap(),
    )
    .unwrap();
    assert_eq!(proof.header.target.as_deref(), Some(first.as_str()));
    let edit_first = rv_crypto_public::messages::message_id(&proof.fingerprint().unwrap());
    let edit_receipt = http::ApplicationReceipt {
        scope: own.scope.clone(),
        room_id: "room".into(),
        operation_id: edit_operation.into(),
        header: B64.encode(&serde_json::to_vec(&proof.header).unwrap()),
        fingerprint: HEXLOWER.encode(&proof.fingerprint().unwrap()),
        message_id: edit_first.clone(),
        position: "9007199254740997".into(),
    };
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"acknowledge","receipt":edit_receipt}),
    );
    let edit_page = http::DeliveryPage {
        scope: own.scope.clone(),
        room_id: "room".into(),
        incarnation: ack.incarnation.clone(),
        after: "9007199254740996".into(),
        through: edit_receipt.position.clone(),
        next: None,
        events: vec![http::DeliveryEvent {
            position: edit_receipt.position.clone(),
            content: http::DeliveryContent::Message(http::ApplicationMessage {
                receipt: edit_receipt,
                proof: packet.proof,
                ciphertext: packet.ciphertext,
            }),
        }],
    };
    for (actor, directory) in [(&*alice, &own), (&*bob, &peer)] {
        conversation(
            actor,
            directory,
            &roster,
            &state,
            None,
            json!({"action":"receive","page":edit_page}),
        );
        let view = conversation(
            actor,
            directory,
            &roster,
            &state,
            None,
            json!({"action":"view","before":null,"limit":200}),
        );
        let row = target(&view);
        assert_eq!(
            (&row["amendment"], &row["edited"]),
            (&Value::Null, &json!(true))
        );
        assert_eq!(row["document"]["text"], "private original edited");
        assert!(
            !view["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["id"] == edit_first.as_str())
        );
    }
    // Private search runs on the device and sees the edited text.
    let found = conversation(
        &bob,
        &peer,
        &roster,
        &state,
        None,
        json!({"action":"search","text":"ORIGINAL EDITED","limit":20}),
    );
    assert_eq!(found["truncated"], false);
    assert_eq!(found["messages"][0]["id"], first.as_str());
    assert_eq!(found["messages"].as_array().unwrap().len(), 1);
    // An unsettled reaction shows on its target with its own operation.
    let reaction = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"react","target":first,"emoji":"thumbsup","present":true}),
    );
    assert!(
        alice
            .conversation_action(
                serde_json::to_string(&own).unwrap(),
                json!({"roster":roster,"state":state,"thread":null,"command":{"action":"react",
            "target":first,"emoji":":thumbsup:","present":true}})
                .to_string()
            )
            .is_err()
    );
    let row = target(&conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"view","before":null,"limit":200}),
    ));
    assert_eq!(
        row["reactions"],
        json!([{"emoji":"thumbsup","users":["alice"]}])
    );
    assert_eq!(row["amendment"]["operation"], reaction["operation"]);
    let pending = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"prepare","text":"recover abandoned document"}),
    );
    let pending = pending["operation"].as_str().unwrap();
    let original = conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"cancel","operation":pending}),
    );
    let packet: http::ApplicationSubmission = serde_json::from_value(original).unwrap();
    let proof = rv_crypto_public::messages::Proof::from_bytes(
        &B64.decode(packet.proof.as_bytes()).unwrap(),
    )
    .unwrap();
    let decision = http::ApplicationSettlement::Cancelled(http::ApplicationCancellation {
        scope: own.scope.clone(),
        room_id: "room".into(),
        operation_id: pending.into(),
        header: B64.encode(&serde_json::to_vec(&proof.header).unwrap()),
        fingerprint: HEXLOWER.encode(&proof.fingerprint().unwrap()),
    });
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"settle","operation":pending,"settlement":decision}),
    );
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"draft","text":""}),
    );
    conversation(
        &alice,
        &own,
        &roster,
        &state,
        None,
        json!({"action":"restore","operation":pending}),
    );
    assert_eq!(
        conversation(
            &alice,
            &own,
            &roster,
            &state,
            None,
            json!({"action":"draft","text":null})
        ),
        "recover abandoned document"
    );
    let mut changed = roster.clone();
    changed.members[0].activation_version = "new-activation".into();
    assert!(
        alice
            .conversation_action(
                serde_json::to_string(&own).unwrap(),
                json!({"roster":changed,"state":state,"thread":null,
        "command":{"action":"view","before":null,"limit":200}})
                .to_string()
            )
            .is_err()
    );
    let manager = alice.slot.load().unwrap().unwrap();
    let signed = manager
        .inspect(|_, records| {
            let issuer = rv_crypto::identity::Issuer::load(records, "instance", "alice").unwrap();
            let incarnation = HEXLOWER
                .decode(own.devices[0].incarnation.as_bytes())
                .unwrap()
                .try_into()
                .unwrap();
            Ok(issuer.revoke("android", incarnation).unwrap())
        })
        .unwrap();
    let mut withdrawn = own.clone();
    withdrawn.revocations.push(http::Revocation {
        position: "9007199254740993".into(),
        signed: B64.encode(&serde_json::to_vec(&signed).unwrap()),
    });
    let request=json!({"roster":roster,"state":state,"thread":null,"command":{"action":"draft","text":"late authoring"}}).to_string();
    assert!(
        alice
            .conversation_action(serde_json::to_string(&withdrawn).unwrap(), request.clone())
            .is_err()
    );
    assert!(alice.is_closed());
    alice.stop();
    drop(alice);
    let reopened =
        CryptoInstallation::open(path.path().to_string_lossy().into(), account(), key).unwrap();
    assert!(
        reopened
            .conversation_action(serde_json::to_string(&own).unwrap(), request)
            .is_err()
    );
    assert!(reopened.is_closed());
}
#[test]
fn two_native_actors_create_join_rotate_reopen_original_and_cancel_without_exporting_private_state()
{
    let path = tempfile::tempdir().unwrap();
    let key = Arc::new(Keystore::default());
    let (alice, mut own) = registered(path.path(), account(), key.clone());
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
    assert_eq!(
        call(&alice, &own, json!({"action":"view","roster":roster}))["needs_credential_update"],
        false
    );
    let stale = call(
        &alice,
        &own,
        json!({"action":"preview","roster":roster,"packages":[],"removals":[],"event":null}),
    );
    let old: rv_crypto::identity::Certificate =
        serde_json::from_slice(&B64.decode(own.devices[0].certificate.as_bytes()).unwrap())
            .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        <= old.device.issued_at
    {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let directory = serde_json::to_string(&own).unwrap();
    let renewal = alice
        .identity_renew(
            directory.clone(),
            own.identity.as_ref().unwrap().fingerprint.clone(),
        )
        .unwrap();
    assert!(renewal.phase == IdentityPhase::Renewing);
    let approval = alice
        .identity_preview(directory.clone(), renewal.request_code)
        .unwrap();
    let grant = alice
        .identity_approve(directory.clone(), approval.id)
        .unwrap();
    alice.identity_install(directory.clone(), grant).unwrap();
    let original = alice.identity_pending(directory.clone()).unwrap();
    let (registration_receipt, _, device) = super::tests::registration_public(&original);
    assert_eq!(registration_receipt.device_revision, "2");
    own.devices = vec![device];
    let directory = serde_json::to_string(&own).unwrap();
    alice
        .identity_acknowledge(
            directory,
            serde_json::to_string(&registration_receipt).unwrap(),
        )
        .unwrap();
    assert!(alice.group_action(serde_json::to_string(&own).unwrap(),
        json!({"action":"confirm","roster":roster,"id":stale["id"],"fingerprint":stale["fingerprint"]}).to_string()).is_err());
    assert_eq!(
        call(&alice, &own, json!({"action":"view","roster":roster}))["needs_credential_update"],
        true
    );
    let renewed: rv_crypto::identity::Certificate =
        serde_json::from_slice(&B64.decode(own.devices[0].certificate.as_bytes()).unwrap())
            .unwrap();
    assert_ne!(renewed.fingerprint().unwrap(), old.fingerprint().unwrap());
    assert_eq!(renewed.device.incarnation, old.device.incarnation);
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
    let transition = rv_crypto_public::groups::Transition::from_bytes(
        &B64.decode(event.transition.as_bytes()).unwrap(),
    )
    .unwrap();
    assert_eq!(transition.certificate, renewed);
    assert_eq!(
        call(&alice, &own, json!({"action":"view","roster":roster}))["needs_credential_update"],
        false
    );
    // Existing approval binds the unchanged root/incarnation/signing key.
    // Renewal cannot silently approve a different device or identity.
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
