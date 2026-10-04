use super::incoming_commits as incoming;
use super::*;
use rv_protocol::e2ee as http;

pub(super) fn observation(value: &Roster, head: Option<&Receipt>) -> http::GroupRoster {
    http::GroupRoster {
        scope: http::Scope {
            instance_id: value.scope.instance.clone(),
            data_epoch: value.scope.data_epoch.clone(),
        },
        room_id: value.scope.room.clone(),
        authority_version: value.authority_version.clone(),
        members: value
            .members
            .iter()
            .map(|m| http::GroupMember {
                user_id: m.user.clone(),
                access_version: m.access_version.clone(),
                activation_version: m.activation_version.clone(),
            })
            .collect(),
        group: head.map(|h| h.to_wire().unwrap()),
    }
}
pub(super) fn available(account: &Account) -> http::AvailableKeyPackage {
    let bytes = account.package();
    let provider = OpenMlsRustCrypto::default();
    let package = KeyPackageIn::tls_deserialize_exact(&bytes)
        .unwrap()
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .unwrap();
    http::AvailableKeyPackage {
        scope: http::Scope {
            instance_id: "instance".into(),
            data_epoch: "epoch".into(),
        },
        user_id: account.root.user.clone(),
        device_id: account.certificate.device.device.clone(),
        incarnation: HEXLOWER.encode(&account.certificate.device.incarnation),
        reference: B64.encode(package.hash_ref(provider.crypto()).unwrap().as_slice()),
        wire: B64.encode(&bytes),
    }
}
fn event(submission: &Submission, target: Option<&str>) -> http::GroupEvent {
    let wire = submission.to_wire().unwrap();
    http::GroupEvent {
        receipt: receipt(submission).to_wire().unwrap(),
        transition: wire.transition,
        commit: wire.commit,
        welcome: target.map(|device| {
            wire.welcomes
                .into_iter()
                .find(|w| w.device_id == device)
                .unwrap()
        }),
    }
}
fn fixture() -> (
    Account,
    Account,
    Genesis,
    Submission,
    http::GroupRoster,
    http::GroupEvent,
) {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    alice.trust(&bob, true);
    bob.trust(&alice, true);
    let roster = observation(&request(vec![], &["alice", "bob"]).roster, None);
    let genesis = Genesis::from_wire(&roster, [3; 16], "create-group", &[available(&bob)]).unwrap();
    let submission = prepare(&alice.coordinator(), &genesis);
    let roster = observation(&genesis.roster, Some(&receipt(&submission)));
    let event = event(&submission, Some("bob-mobile"));
    (alice, bob, genesis, submission, roster, event)
}

#[test]
fn actual_genesis_join_and_rotation_use_shared_http_dtos_without_private_export() {
    let (alice, bob, _, submission, mut roster, event) = fixture();
    let original = serde_json::to_vec(&submission.to_wire().unwrap()).unwrap();
    assert_eq!(
        serde_json::to_vec(
            &alice
                .reopened()
                .retry("room", NOW)
                .unwrap()
                .to_wire()
                .unwrap()
        )
        .unwrap(),
        original
    );
    let ack = Receipt::from_wire(&event.receipt).unwrap();
    alice.coordinator().confirm(&ack, NOW).unwrap();
    let admission = Admission::from_wire(&roster, &event).unwrap();
    admission::accept(&bob, &admission);
    assert_eq!(incoming::secret(&alice), incoming::secret(&bob));
    roster.authority_version = "authority-new".into();
    let change = Change::from_wire(&roster, "rotate", &[], &[]).unwrap();
    let (preview, consent) = alice.coordinator().preview_change(&change, NOW).unwrap();
    let rotated = alice
        .coordinator()
        .prepare_change(&change, &consent, preview.fingerprint, NOW)
        .unwrap();
    let delivered = event_for_rotation(&rotated);
    roster.group = Some(delivered.receipt.clone());
    let received = Commit::from_wire(&roster, &delivered).unwrap();
    incoming::accept(&bob, &received);
    alice
        .coordinator()
        .confirm(&Receipt::from_wire(&delivered.receipt).unwrap(), NOW)
        .unwrap();
    assert_eq!(incoming::secret(&alice), incoming::secret(&bob));
    let wire = rotated.to_wire().unwrap();
    let state = http::GroupState {
        receipt: delivered.receipt.clone(),
        transition: wire.transition,
        tree: wire.tree,
        needs_rekey: false,
    };
    assert!(Receipt::from_state(&state).unwrap() == received.receipt);
    let mut bad = state;
    bad.tree = B64.encode(b"unrelated tree");
    assert_eq!(Receipt::from_state(&bad).err(), Some(Error::Changed));
}
// Keep the event fixture function accessible when a local variable is named event.
fn event_for_rotation(submission: &Submission) -> http::GroupEvent {
    event(submission, None)
}

#[test]
fn decimals_and_encodings_preserve_exact_large_receipts_and_refuse_alternate_forms() {
    let (_, _, _, submission, _, _) = fixture();
    let mut value = receipt(&submission).to_wire().unwrap();
    value.revision = "9007199254740993".into();
    value.epoch = "9007199254740992".into();
    let exact = Receipt::from_wire(&value).unwrap();
    assert_eq!(exact.revision, 9_007_199_254_740_993);
    assert_eq!(exact.to_wire().unwrap().epoch, "9007199254740992");
    for invalid in [
        "01",
        "+1",
        " 1",
        "1 ",
        "-1",
        "1.0",
        "1e3",
        "9223372036854775808",
    ] {
        let mut changed = value.clone();
        changed.revision = invalid.into();
        assert!(Receipt::from_wire(&changed).is_err(), "{invalid}");
    }
    for field in 0..5 {
        let mut changed = value.clone();
        match field {
            0 => changed.incarnation = "00".repeat(16),
            1 => changed.fingerprint = "00".repeat(32),
            2 => changed.incarnation = "AB".repeat(16),
            3 => changed.fingerprint = B64.encode(&[3; 32]),
            _ => changed.scope.instance_id = "x".repeat(129),
        }
        assert!(Receipt::from_wire(&changed).is_err());
    }
    let mut zero = value;
    zero.revision = "0".into();
    assert!(Receipt::from_wire(&zero).is_err());
}

#[test]
fn key_package_metadata_is_verified_against_actual_tls_identity_and_hash_ref() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    let observed = observation(&request(vec![], &["alice", "bob"]).roster, None);
    let package = available(&bob);
    // Structural conversion alone grants no root/device approval in the vault.
    let genesis = Genesis::from_wire(
        &observed,
        [3; 16],
        "genesis",
        std::slice::from_ref(&package),
    )
    .unwrap();
    assert_eq!(
        alice.coordinator().preview_genesis(&genesis, NOW).err(),
        Some(Error::Identity(identity::Error::Untrusted))
    );
    for field in 0..8 {
        let mut wrong = package.clone();
        match field {
            0 => wrong.scope.data_epoch = "old".into(),
            1 => wrong.user_id = "alice".into(),
            2 => wrong.device_id = "different".into(),
            3 => wrong.incarnation = HEXLOWER.encode(&[9; 16]),
            4 => wrong.reference = B64.encode(&[9; 32]),
            5 => wrong.reference.push('='),
            6 => wrong.wire = B64.encode(b"bad TLS"),
            _ => wrong.wire = "A".repeat(PACKAGE_LIMIT.div_ceil(3) * 4 + 1),
        }
        assert!(
            Genesis::from_wire(&observed, [3; 16], "genesis", &[wrong]).is_err(),
            "field {field}"
        );
    }
    assert!(
        Genesis::from_wire(&observed, [3; 16], "genesis", &[package.clone(), package]).is_err()
    );
}

#[test]
fn current_observations_and_vault_scope_are_required_for_admission_and_change() {
    let (alice, bob, genesis, submission, roster, event) = fixture();
    for field in 0..6 {
        let mut wrong = roster.clone();
        match field {
            0 => wrong.room_id = "other".into(),
            1 => wrong.scope.data_epoch = "old".into(),
            2 => wrong.authority_version = "new".into(),
            3 => wrong.members[1].activation_version = "new-activation".into(),
            4 => wrong.members.reverse(),
            _ => wrong.group = None,
        }
        assert!(
            Admission::from_wire(&wrong, &event).is_err(),
            "field {field}"
        );
    }
    let mut foreign = observation(&genesis.roster, None);
    foreign.scope.instance_id = "other-instance".into();
    let foreign = Genesis::from_wire(&foreign, [3; 16], "other", &[]).unwrap();
    assert_eq!(
        alice.coordinator().preview_genesis(&foreign, NOW).err(),
        Some(Error::Identity(identity::Error::Scope))
    );
    let accepted = Receipt::from_wire(&event.receipt).unwrap();
    alice.coordinator().confirm(&accepted, NOW).unwrap();
    admission::accept(&bob, &Admission::from_wire(&roster, &event).unwrap());
    let mut observed = roster;
    observed.group.as_mut().unwrap().revision = "2".into();
    let stale = Change::from_wire(&observed, "stale", &[], &[]).unwrap();
    assert_eq!(
        alice.coordinator().preview_change(&stale, NOW).err(),
        Some(Error::Changed)
    );
    assert_eq!(
        Genesis::from_wire(&observed, [3; 16], "duplicate", &[])
            .err()
            .map(|_| true),
        Some(true)
    );
    assert_eq!(
        alice.reopened().ready_epoch("room"),
        Ok(receipt(&submission).epoch)
    );
}

#[test]
fn targeted_welcome_and_signed_payload_bindings_cannot_be_substituted() {
    let (_, bob, _, submission, roster, original) = fixture();
    assert!(Commit::from_wire(&roster, &original).is_err());
    for field in 0..7 {
        let mut wrong = original.clone();
        match field {
            0 => wrong.receipt.operation_id = "other-operation".into(),
            1 => wrong.commit = Some(B64.encode(b"other commit")),
            2 => wrong.welcome.as_mut().unwrap().device_id = "other".into(),
            3 => wrong.welcome.as_mut().unwrap().key_package_ref = B64.encode(&[8; 32]),
            4 => wrong.welcome.as_mut().unwrap().payload = B64.encode(b"other Welcome"),
            5 => wrong.transition.push('='),
            _ => wrong.welcome = None,
        }
        assert!(
            Admission::from_wire(&roster, &wrong).is_err(),
            "field {field}"
        );
        assert_eq!(bob.coordinator().ready_epoch("room"), Err(Error::NotReady));
    }
    for field in 0..5 {
        let mut wrong = submission.clone();
        match field {
            0 => wrong.operation = "other".into(),
            1 => wrong.tree[0] ^= 1,
            2 => wrong.welcomes[0].key_package[0] ^= 1,
            3 => wrong.welcomes.clear(),
            _ => wrong.commit.as_mut().unwrap()[0] ^= 1,
        }
        assert!(wrong.to_wire().is_err());
    }
    admission::accept(&bob, &Admission::from_wire(&roster, &original).unwrap());
}

#[test]
fn pages_keep_order_scope_and_exact_cursor_without_granting_historical_membership() {
    let (alice, bob, _, submission, mut roster, first) = fixture();
    alice
        .coordinator()
        .confirm(&Receipt::from_wire(&first.receipt).unwrap(), NOW)
        .unwrap();
    admission::accept(&bob, &Admission::from_wire(&roster, &first).unwrap());
    let change = Change::from_wire(&roster, "rotate", &[], &[]).unwrap();
    let (preview, consent) = alice.coordinator().preview_change(&change, NOW).unwrap();
    let rotated = alice
        .coordinator()
        .prepare_change(&change, &consent, preview.fingerprint, NOW)
        .unwrap();
    let second = event(&rotated, None);
    roster.group = Some(second.receipt.clone());
    let page = http::GroupEventPage {
        events: vec![first.clone(), second.clone()],
        next: Some("2".into()),
    };
    wire::validate_page(&page, &submission.scope, 0).unwrap();
    // A newer head can still deliver the initial Welcome; it is not discarded
    // just because it is older than the head when grants/authority still match.
    Admission::from_wire(&roster, &first).unwrap();
    for field in 0..5 {
        let mut wrong = page.clone();
        match field {
            0 => wrong.events.reverse(),
            1 => wrong.events = vec![first.clone(), first.clone()],
            2 => wrong.next = Some("01".into()),
            3 => wrong.next = Some("1".into()),
            _ => wrong.events = vec![first.clone(); 17],
        }
        assert!(wire::validate_page(&wrong, &submission.scope, 0).is_err());
    }
    assert!(wire::validate_page(&page, &submission.scope, 1).is_err());
    let empty = http::GroupEventPage {
        events: vec![],
        next: Some("2".into()),
    };
    assert!(wire::validate_page(&empty, &submission.scope, 1).is_err());
    incoming::accept(&bob, &Commit::from_wire(&roster, &second).unwrap());
    alice
        .coordinator()
        .confirm(&Receipt::from_wire(&second.receipt).unwrap(), NOW)
        .unwrap();
    let change = Change::from_wire(&roster, "rotate-again", &[], &[]).unwrap();
    let (preview, consent) = alice.coordinator().preview_change(&change, NOW).unwrap();
    let third = alice
        .coordinator()
        .prepare_change(&change, &consent, preview.fingerprint, NOW)
        .unwrap();
    let third = event(&third, None);
    let gap = http::GroupEventPage {
        events: vec![first.clone(), third.clone()],
        next: None,
    };
    assert_eq!(
        wire::validate_page(&gap, &submission.scope, 0),
        Err(Error::Changed)
    );
    let complete = http::GroupEventPage {
        events: vec![first, second, third],
        next: None,
    };
    wire::validate_page(&complete, &submission.scope, 0).unwrap();
}
