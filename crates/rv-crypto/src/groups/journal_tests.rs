use super::*;
use super::{application_messages as messages, changes};
use rv_protocol::e2ee as http;

const BASE: u64 = 9007199254740992;

#[test]
fn known_own_acceptance_refuses_a_peer_fork_without_spending_the_pending_commit_or_cursor() {
    let (alice, bob, _, initial) = fixture(false);
    let observed = observation(&alice);
    let first = page(&observed, 0, 1, vec![group(&initial, 1, None)], None);
    for account in [&alice, &bob] {
        account
            .coordinator()
            .receive_journal(&observed, &first, NOW)
            .unwrap();
    }
    let own_request = changes::change(&alice, "known-own-ack", &["alice", "bob"], &[], vec![]);
    let own = changes::prepare_change(&alice, &own_request, NOW);
    alice.coordinator().confirm(&receipt(&own), NOW).unwrap();
    let peer_request = changes::change(
        &bob,
        "contradictory-peer-ack",
        &["alice", "bob"],
        &[],
        vec![],
    );
    let peer = changes::prepare_change(&bob, &peer_request, NOW);
    let before = incoming_commits::secret(&alice);
    let reported = JournalObservation {
        current: MessageObservation {
            roster: peer_request.roster,
            head: receipt(&peer),
            needs_rekey: false,
        },
        transition: peer.transition.clone(),
    };
    let fork = page(&reported, 1, 3, vec![group(&peer, 3, None)], None);
    assert!(matches!(
        alice.coordinator().receive_journal(&reported, &fork, NOW),
        Err(Error::Receipt)
    ));
    assert_eq!(alice.reopened().journal_request("room").unwrap().after, 1);
    assert_eq!(
        alice.reopened().pending_lookup("room").unwrap().operation,
        own.operation
    );
    assert_eq!(incoming_commits::secret(&alice), before);
    let observed = JournalObservation {
        current: MessageObservation {
            roster: own_request.roster,
            head: receipt(&own),
            needs_rekey: false,
        },
        transition: own.transition.clone(),
    };
    let correct = page(&observed, 1, 3, vec![group(&own, 3, None)], None);
    alice
        .reopened()
        .receive_journal(&observed, &correct, NOW)
        .unwrap();
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(2));
}

#[test]
fn journal_peer_successor_preserves_unresolved_original_and_its_cancellation_never_moves_the_cursor()
 {
    let (alice, bob, _, initial) = fixture(false);
    let observed = observation(&alice);
    let first = page(&observed, 0, 1, vec![group(&initial, 1, None)], None);
    for account in [&alice, &bob] {
        account
            .coordinator()
            .receive_journal(&observed, &first, NOW)
            .unwrap();
    }
    let outgoing_request = changes::change(&bob, "journal-orphan", &["alice", "bob"], &[], vec![]);
    let outgoing = changes::prepare_change(&bob, &outgoing_request, NOW);
    let peer_request = changes::change(
        &alice,
        "journal-peer-winner",
        &["alice", "bob"],
        &[],
        vec![],
    );
    let peer = changes::prepare_change(&alice, &peer_request, NOW);
    let observed = JournalObservation {
        current: MessageObservation {
            roster: peer_request.roster,
            head: receipt(&peer),
            needs_rekey: false,
        },
        transition: peer.transition.clone(),
    };
    let successor = page(&observed, 1, 3, vec![group(&peer, 3, None)], None);
    bob.coordinator()
        .receive_journal(&observed, &successor, NOW)
        .unwrap();
    let before = incoming_commits::secret(&bob);
    assert!(bob.reopened().pending_lookup("room").unwrap().superseded);
    let CancellationRequest::Original(retained) = bob
        .reopened()
        .request_group_cancellation("room", &outgoing.operation, NOW + 1)
        .unwrap()
    else {
        panic!("original discarded")
    };
    assert_eq!(bytes(&retained), bytes(&outgoing));
    let cancelled = GroupCancellation {
        scope: outgoing.scope,
        operation: outgoing.operation,
        device: bob.manager.scope().device.clone(),
        fingerprint: receipt(&retained).fingerprint,
    };
    bob.reopened()
        .confirm_group_cancellation(&cancelled, NOW + 1)
        .unwrap();
    assert_eq!(bob.reopened().journal_request("room").unwrap().after, 3);
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(2));
    assert_eq!(incoming_commits::secret(&bob), before);
}

fn fixture(third: bool) -> (Account, Account, Option<Account>, Submission) {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    alice.trust(&bob, true);
    bob.trust(&alice, true);
    let carol = third.then(|| Account::new("carol", "carol-mobile", [4; 16]));
    let mut packages = vec![bob.package()];
    let mut users = vec!["alice", "bob"];
    if let Some(carol) = &carol {
        for account in [&alice, &bob] {
            account.trust(carol, true);
            carol.trust(account, true);
        }
        packages.push(carol.package());
        users.push("carol");
    }
    let request = request(packages, &users);
    let submission = prepare(&alice.coordinator(), &request);
    let welcome = admission::event(&request, &submission, &bob.certificate.device.device);
    admission::accept(&bob, &welcome);
    alice
        .coordinator()
        .confirm(&receipt(&submission), NOW)
        .unwrap();
    (alice, bob, carol, submission)
}
fn observation(account: &Account) -> JournalObservation {
    let current = messages::observation(account);
    let transition = account
        .manager
        .inspect(|_, records| {
            Ok(read(records, "room")
                .unwrap()
                .unwrap()
                .active
                .unwrap()
                .transition
                .to_bytes()
                .unwrap())
        })
        .unwrap();
    JournalObservation {
        current,
        transition,
    }
}
fn group(submission: &Submission, position: u64, welcome: Option<&str>) -> http::DeliveryEvent {
    let wire = submission.to_wire().unwrap();
    http::DeliveryEvent {
        position: position.to_string(),
        content: http::DeliveryContent::Group(http::GroupEvent {
            receipt: receipt(submission).to_wire().unwrap(),
            transition: wire.transition,
            commit: wire.commit,
            welcome: welcome
                .and_then(|device| wire.welcomes.into_iter().find(|w| w.device_id == device)),
        }),
    }
}
fn send(account: &Account, id: &str, position: u64) -> http::DeliveryEvent {
    let submission = account
        .coordinator()
        .prepare_message(&messages::observation(account), &messages::message(id), NOW)
        .unwrap();
    let receipt = messages::ack(&submission, position);
    account
        .coordinator()
        .confirm_message(&receipt, NOW)
        .unwrap();
    let wire = submission.to_wire().unwrap();
    http::DeliveryEvent {
        position: position.to_string(),
        content: http::DeliveryContent::Message(http::ApplicationMessage {
            receipt: wire::message_receipt_to_wire(&receipt).unwrap(),
            proof: wire.proof,
            ciphertext: wire.ciphertext,
        }),
    }
}
fn page(
    observed: &JournalObservation,
    after: u64,
    through: u64,
    events: Vec<http::DeliveryEvent>,
    next: Option<u64>,
) -> http::DeliveryPage {
    let scope = &observed.current.head.scope;
    http::DeliveryPage {
        scope: http::Scope {
            instance_id: scope.instance.clone(),
            data_epoch: scope.data_epoch.clone(),
        },
        room_id: scope.room.clone(),
        incarnation: HEXLOWER.encode(&scope.incarnation),
        after: after.to_string(),
        through: through.to_string(),
        events,
        next: next.map(|value| value.to_string()),
    }
}
fn rotate(account: &Account, id: &str) -> Submission {
    let change = changes::change(account, id, &["alice", "bob"], &[], vec![]);
    let submission = changes::prepare_change(account, &change, NOW);
    account
        .coordinator()
        .confirm(&receipt(&submission), NOW)
        .unwrap();
    submission
}
fn offline() -> (Account, Account, JournalObservation, http::DeliveryPage) {
    let (alice, bob, _, initial) = fixture(false);
    let mut events = vec![group(&initial, BASE + 1, Some("bob-mobile"))];
    events.push(send(&alice, "first-epoch", BASE + 2));
    events.push(group(&rotate(&alice, "rotation-one"), BASE + 4, None));
    events.push(send(&alice, "second-epoch", BASE + 7));
    events.push(group(&rotate(&alice, "rotation-two"), BASE + 11, None));
    events.push(send(&alice, "third-epoch", BASE + 15));
    let observed = observation(&alice);
    let page = page(&observed, 0, BASE + 18, events, None);
    (alice, bob, observed, page)
}

#[test]
fn offline_three_epochs_resume_fixed_window_and_replay_protected_page_after_reopen() {
    let (alice, bob, observed, whole) = offline();
    let first = page(
        &observed,
        0,
        BASE + 18,
        whole.events[..2].to_vec(),
        Some(BASE + 2),
    );
    let result = bob
        .coordinator()
        .receive_journal(&observed, &first, NOW)
        .unwrap();
    assert!(!result.complete && result.after == BASE + 2 && result.messages.len() == 1);
    assert_eq!(
        result.messages[0].message().unwrap().operation_id,
        "first-epoch"
    );
    let request = bob.reopened().journal_request("room").unwrap();
    assert_eq!(
        (request.after, request.through),
        (BASE + 2, Some(BASE + 18))
    );
    let mut changed = page(
        &observed,
        BASE + 2,
        BASE + 19,
        whole.events[2..].to_vec(),
        None,
    );
    assert!(
        bob.reopened()
            .receive_journal(&observed, &changed, NOW)
            .is_err()
    );
    changed.through = (BASE + 18).to_string();
    let result = bob
        .reopened()
        .receive_journal(&observed, &changed, NOW)
        .unwrap();
    assert!(result.complete && result.after == BASE + 18 && result.messages.len() == 2);
    assert_eq!(
        result.messages[0].message().unwrap().operation_id,
        "second-epoch"
    );
    assert_eq!(
        result.messages[1].message().unwrap().operation_id,
        "third-epoch"
    );
    assert!(result.head == observed.current.head);
    assert_eq!(
        incoming_commits::secret(&bob),
        incoming_commits::secret(&alice)
    );
    let replay = bob.reopened().journal_last_batch(&observed, NOW).unwrap();
    assert_eq!(replay.after, BASE + 18);
    assert_eq!(
        replay.messages[0].message().unwrap().operation_id,
        "second-epoch"
    );
    assert!(
        bob.coordinator()
            .receive_journal(&observed, &changed, NOW)
            .is_err()
    );
    let http::DeliveryContent::Message(frame) = &whole.events[5].content else {
        panic!()
    };
    let (submission, receipt) = MessageSubmission::from_delivered(frame).unwrap();
    assert!(matches!(
        bob.coordinator()
            .receive_message(&messages::observation(&bob), &submission, &receipt, NOW),
        Err(Error::JournalOrder)
    ));
    let empty = page(&observed, BASE + 18, BASE + 23, vec![], None);
    let empty = bob
        .coordinator()
        .receive_journal(&observed, &empty, NOW)
        .unwrap();
    assert!(empty.messages.is_empty() && empty.after == BASE + 23 && empty.complete);
    let query = ProjectionQuery {
        before: None,
        limit: 2,
        thread: Some("thread-root".into()),
    };
    let projection = bob
        .reopened()
        .journal_projection(&observed, &query, NOW)
        .unwrap();
    assert!(projection.complete && projection.has_older && projection.after == BASE + 23);
    assert_eq!(
        projection
            .messages
            .iter()
            .map(|row| row.message.message().unwrap().operation_id)
            .collect::<Vec<_>>(),
        ["second-epoch", "third-epoch"]
    );
    assert!(projection.messages.iter().all(|row| row.observed_at == NOW));
    let before = projection.messages[0].message.receipt.position;
    let older = bob
        .reopened()
        .journal_projection(
            &observed,
            &ProjectionQuery {
                before: Some(before),
                ..query
            },
            NOW,
        )
        .unwrap();
    assert!(!older.has_older && older.messages.len() == 1);
    assert_eq!(
        older.messages[0].message.message().unwrap().operation_id,
        "first-epoch"
    );
    assert!(
        bob.reopened()
            .journal_projection(
                &observed,
                &ProjectionQuery {
                    before: None,
                    limit: 0,
                    thread: None
                },
                NOW
            )
            .is_err()
    );
    let filtered = bob
        .reopened()
        .journal_projection(
            &observed,
            &ProjectionQuery {
                before: None,
                limit: 50,
                thread: Some("unknown-root".into()),
            },
            NOW,
        )
        .unwrap();
    assert!(filtered.messages.is_empty());
    let mut lost_membership = observation(&alice);
    lost_membership
        .current
        .roster
        .members
        .retain(|m| m.user != bob.root.user);
    assert!(
        bob.reopened()
            .journal_projection(
                &lost_membership,
                &ProjectionQuery {
                    before: None,
                    limit: 50,
                    thread: None
                },
                NOW
            )
            .is_err()
    );
    bob.trust(&bob, false);
    bob.revoke(&bob);
    assert!(
        bob.reopened()
            .journal_projection(
                &observed,
                &ProjectionQuery {
                    before: None,
                    limit: 50,
                    thread: None
                },
                NOW
            )
            .is_err()
    );
}

#[test]
fn late_invalid_signature_rolls_back_messages_rotations_and_cursor_before_retry() {
    let (_, bob, observed, whole) = offline();
    let old_secret = incoming_commits::secret(&bob);
    let mut invalid = whole.clone();
    let http::DeliveryContent::Message(message) = &mut invalid.events[5].content else {
        panic!()
    };
    let mut proof = rv_crypto_public::messages::Proof::from_bytes(
        &B64.decode(message.proof.as_bytes()).unwrap(),
    )
    .unwrap();
    proof.signature[0] ^= 1;
    message.proof = B64.encode(&proof.to_bytes().unwrap());
    message.receipt.fingerprint = HEXLOWER.encode(&proof.fingerprint().unwrap());
    assert!(
        bob.coordinator()
            .receive_journal(&observed, &invalid, NOW)
            .is_err()
    );
    assert_eq!(bob.reopened().journal_request("room").unwrap().after, 0);
    assert_eq!(incoming_commits::secret(&bob), old_secret);
    assert_eq!(bob.coordinator().ready_epoch("room").unwrap(), 1);
    let result = bob
        .reopened()
        .receive_journal(&observed, &whole, NOW)
        .unwrap();
    assert_eq!(result.messages.len(), 3);
    assert!(result.head == observed.current.head);
}

#[test]
fn canonical_envelope_scope_position_and_successor_order_refusals_preserve_prefix() {
    let (_, bob, observed, whole) = offline();
    let mut malformed = Vec::new();
    let mut changed = whole.clone();
    changed.after = "00".into();
    malformed.push(changed);
    let mut changed = whole.clone();
    changed.scope.data_epoch = "other".into();
    malformed.push(changed);
    let mut changed = whole.clone();
    changed.incarnation = "00".repeat(16);
    malformed.push(changed);
    let mut changed = whole.clone();
    changed.events[1].position = changed.events[0].position.clone();
    malformed.push(changed);
    let mut changed = whole.clone();
    changed.events[1].position = (BASE + 3).to_string();
    malformed.push(changed);
    let mut changed = whole.clone();
    changed.events.swap(1, 2);
    malformed.push(changed);
    let mut changed = whole.clone();
    changed.events.remove(2);
    malformed.push(changed);
    let mut changed = whole.clone();
    changed.events[0].position = "9223372036854775808".into();
    malformed.push(changed);
    let mut changed = whole.clone();
    changed.next = Some((BASE + 2).to_string());
    malformed.push(changed);
    let mut changed = whole.clone();
    changed.events = vec![whole.events[0].clone(); 17];
    malformed.push(changed);
    for changed in malformed {
        assert!(
            bob.coordinator()
                .receive_journal(&observed, &changed, NOW)
                .is_err()
        );
        assert_eq!(bob.reopened().journal_request("room").unwrap().after, 0);
    }
    bob.coordinator()
        .receive_journal(&observed, &whole, NOW)
        .unwrap();
}

#[test]
fn own_rotation_ack_preserves_old_epoch_until_unread_message_and_commit_share_prefix() {
    let (alice, bob, _, initial) = fixture(false);
    let observed = observation(&alice);
    for account in [&alice, &bob] {
        let first = page(&observed, 0, 1, vec![group(&initial, 1, None)], None);
        account
            .coordinator()
            .receive_journal(&observed, &first, NOW)
            .unwrap();
    }
    let message = send(&bob, "unread-before-own-rotation", 3);
    let old = incoming_commits::secret(&alice);
    let change = changes::change(
        &alice,
        "deferred-own-rotation",
        &["alice", "bob"],
        &[],
        vec![],
    );
    let submission = changes::prepare_change(&alice, &change, NOW);
    let expected = receipt(&submission);
    alice.coordinator().confirm(&expected, NOW).unwrap();
    assert_eq!(alice.reopened().ready_epoch("room").unwrap(), 1);
    assert_eq!(incoming_commits::secret(&alice), old);
    let observed = JournalObservation {
        current: MessageObservation {
            roster: change.roster,
            head: expected.clone(),
            needs_rekey: false,
        },
        transition: submission.transition.clone(),
    };
    let continuation = page(
        &observed,
        1,
        9,
        vec![message, group(&submission, 5, None)],
        None,
    );
    let commit = Commit {
        roster: observed.current.roster.clone(),
        receipt: expected.clone(),
        transition: submission.transition.clone(),
        commit: submission.commit.clone().unwrap(),
    };
    let (preview, consent) = bob.coordinator().preview_commit(&commit, NOW).unwrap();
    assert!(matches!(
        bob.coordinator()
            .accept_commit(&commit, &consent, preview.fingerprint, NOW),
        Err(Error::JournalOrder)
    ));
    let result = alice
        .reopened()
        .receive_journal(&observed, &continuation, NOW)
        .unwrap();
    assert!(result.head == expected && result.messages.len() == 1);
    let result = bob
        .reopened()
        .receive_journal(&observed, &continuation, NOW)
        .unwrap();
    assert!(result.head == expected && result.messages.len() == 1);
    assert_eq!(
        incoming_commits::secret(&alice),
        incoming_commits::secret(&bob)
    );
    assert_ne!(incoming_commits::secret(&alice), old);
}

#[test]
fn historic_peer_removal_does_not_replace_signed_epoch_roster_with_current_roster() {
    let (alice, bob, _, initial) = fixture(true);
    let before = send(&alice, "before-carol-removal", 2);
    let change = changes::change(
        &alice,
        "remove-carol",
        &["alice", "bob"],
        &["carol-mobile"],
        vec![],
    );
    let submission = changes::prepare_change(&alice, &change, NOW);
    alice
        .coordinator()
        .confirm(&receipt(&submission), NOW)
        .unwrap();
    let after = send(&alice, "after-carol-removal", 7);
    let observed = observation(&alice);
    let whole = page(
        &observed,
        0,
        9,
        vec![
            group(&initial, 1, None),
            before,
            group(&submission, 4, None),
            after,
        ],
        None,
    );
    let mut changed = observation(&alice);
    changed
        .current
        .roster
        .members
        .iter_mut()
        .find(|m| m.user == "bob")
        .unwrap()
        .access_version = "new-admission".into();
    assert!(
        bob.coordinator()
            .receive_journal(&changed, &whole, NOW)
            .is_err()
    );
    assert_eq!(bob.coordinator().journal_request("room").unwrap().after, 0);
    let result = bob
        .coordinator()
        .receive_journal(&observed, &whole, NOW)
        .unwrap();
    assert_eq!(result.messages.len(), 2);
    assert!(result.head == observed.current.head);
    assert_eq!(
        incoming_commits::secret(&alice),
        incoming_commits::secret(&bob)
    );
    assert!(bob.coordinator().journal_last_batch(&changed, NOW).is_err());
}

#[test]
fn failed_external_checkpoint_publishes_no_clear_result_but_reopens_original_batch() {
    let (_, bob, observed, whole) = offline();
    bob.keystore.fail_at.store(
        bob.keystore.writes.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    assert!(matches!(
        bob.coordinator().receive_journal(&observed, &whole, NOW),
        Err(Error::Storage(vault::Error::Storage))
    ));
    bob.keystore.fail_at.store(0, Ordering::SeqCst);
    let result = bob.reopened().journal_last_batch(&observed, NOW).unwrap();
    assert_eq!(result.after, BASE + 18);
    assert_eq!(result.messages.len(), 3);
    assert_eq!(
        result.messages[0].message().unwrap().operation_id,
        "first-epoch"
    );
    assert_eq!(
        result.messages[2].message().unwrap().operation_id,
        "third-epoch"
    );
    assert!(result.head == observed.current.head);
}

fn renew(account: &Account, at: u64) -> Certificate {
    account
        .manager
        .transact(|_, records| {
            let issuer = Issuer::load(records, "instance", &account.root.user).unwrap();
            let mut local =
                LocalDevice::load(&account.root, &account.manager.scope().device, records).unwrap();
            let request = local.request(at, records).unwrap();
            let consent = issuer.preview_request(&request, at, 7200, records).unwrap();
            let grant = issuer
                .approve_request(&request, &consent, at, records)
                .unwrap();
            local.install(&grant, at, records).unwrap();
            Ok(grant.certificate)
        })
        .unwrap()
}

#[test]
fn expired_peer_epochs_reopen_after_own_renewal_without_authorizing_a_current_send() {
    let (alice, bob, observed, whole) = offline();
    let at = NOW + 3601;
    assert!(matches!(
        alice.certificate.verify(at),
        Err(identity::Error::Expired)
    ));
    assert!(
        bob.coordinator()
            .receive_journal(&observed, &whole, at)
            .is_err()
    );
    assert_eq!(bob.coordinator().journal_request("room").unwrap().after, 0);
    renew(&bob, at);
    let result = bob
        .reopened()
        .receive_journal(&observed, &whole, at)
        .unwrap();
    assert_eq!(result.messages.len(), 3);
    assert_eq!(
        result.messages[0].message().unwrap().operation_id,
        "first-epoch"
    );
    assert_eq!(
        result.messages[2].message().unwrap().operation_id,
        "third-epoch"
    );
    assert!(result.head == observed.current.head);
    assert_eq!(
        incoming_commits::secret(&alice),
        incoming_commits::secret(&bob)
    );
    let replay = bob
        .reopened()
        .journal_last_batch(&observed, at + 1)
        .unwrap();
    assert_eq!(replay.messages.len(), 3);
    assert_eq!(bob.reopened().ready_epoch("room").unwrap(), 3);
    assert!(
        bob.coordinator()
            .prepare_message(
                &messages::observation(&bob),
                &messages::message("fresh-send-still-refused"),
                at + 1
            )
            .is_err()
    );
    let http::DeliveryContent::Message(frame) = &whole.events[5].content else {
        panic!()
    };
    let (submission, _) = MessageSubmission::from_delivered(frame).unwrap();
    assert!(matches!(
        submission.verified(at),
        Err(Error::Identity(identity::Error::Expired))
    ));
    let proof = rv_crypto_public::messages::Proof::from_bytes(&submission.proof).unwrap();
    proof.authenticate(&submission.ciphertext).unwrap();
    assert!(matches!(
        proof.verify(at, &submission.ciphertext),
        Err(identity::Error::Expired)
    ));
}

#[test]
fn historical_authentication_keeps_known_revocation_and_signature_refusals() {
    let (alice, bob, observed, whole) = offline();
    let at = NOW + 3601;
    renew(&bob, at);
    bob.revoke(&alice);
    assert!(matches!(
        bob.coordinator().receive_journal(&observed, &whole, at),
        Err(Error::Identity(identity::Error::Revoked))
    ));
    assert_eq!(bob.reopened().journal_request("room").unwrap().after, 0);
    let (alice, bob, observed, whole) = offline();
    renew(&bob, at);
    let mut invalid = whole.clone();
    let http::DeliveryContent::Message(frame) = &mut invalid.events[5].content else {
        panic!()
    };
    let (mut submission, _) = MessageSubmission::from_delivered(frame).unwrap();
    let mut proof = rv_crypto_public::messages::Proof::from_bytes(&submission.proof).unwrap();
    proof.signature[0] ^= 1;
    submission.proof = proof.to_bytes().unwrap();
    frame.proof = B64.encode(&submission.proof);
    frame.receipt.fingerprint = HEXLOWER.encode(&proof.fingerprint().unwrap());
    assert!(matches!(
        bob.coordinator().receive_journal(&observed, &invalid, at),
        Err(Error::Identity(identity::Error::Signature))
    ));
    assert_eq!(bob.reopened().journal_request("room").unwrap().after, 0);
    let result = bob
        .reopened()
        .receive_journal(&observed, &whole, at)
        .unwrap();
    assert!(result.head == observation(&alice).current.head);
}

#[test]
fn future_issued_historical_certificate_is_refused_before_spending_the_valid_epoch() {
    let (alice, bob, observed, whole) = offline();
    let certificate = renew(&alice, NOW + 50);
    let mut invalid = whole.clone();
    let http::DeliveryContent::Message(frame) = &mut invalid.events[5].content else {
        panic!()
    };
    let (mut submission, _) = MessageSubmission::from_delivered(frame).unwrap();
    messages::resign(&alice, &mut submission, |proof| {
        proof.header.certificate = certificate.fingerprint().unwrap();
        proof.certificate = certificate;
    });
    let proof = rv_crypto_public::messages::Proof::from_bytes(&submission.proof).unwrap();
    proof.authenticate(&submission.ciphertext).unwrap();
    frame.proof = B64.encode(&submission.proof);
    let mut receipt = wire::message_receipt(&frame.receipt).unwrap();
    receipt.header = proof.header.clone();
    receipt.fingerprint = proof.fingerprint().unwrap();
    frame.receipt = wire::message_receipt_to_wire(&receipt).unwrap();
    assert!(matches!(
        bob.coordinator()
            .receive_journal(&observed, &invalid, NOW + 10),
        Err(Error::Identity(identity::Error::Expired))
    ));
    assert_eq!(bob.reopened().journal_request("room").unwrap().after, 0);
    bob.reopened()
        .receive_journal(&observed, &whole, NOW + 10)
        .unwrap();
}

#[test]
fn expired_own_pending_rotation_reads_old_message_then_merges_original_commit_after_renewal() {
    let (alice, bob, _, initial) = fixture(false);
    let observed = observation(&alice);
    for account in [&alice, &bob] {
        account
            .coordinator()
            .receive_journal(
                &observed,
                &page(&observed, 0, 1, vec![group(&initial, 1, None)], None),
                NOW,
            )
            .unwrap();
    }
    let message = send(&bob, "old-message-before-rotation", 3);
    let change = changes::change(&alice, "old-own-pending", &["alice", "bob"], &[], vec![]);
    let submission = changes::prepare_change(&alice, &change, NOW);
    let expected = receipt(&submission);
    let at = NOW + 3601;
    alice.coordinator().confirm(&expected, at).unwrap();
    assert_eq!(alice.reopened().ready_epoch("room").unwrap(), 1);
    renew(&alice, at);
    renew(&bob, at);
    let observed = JournalObservation {
        current: MessageObservation {
            roster: change.roster,
            head: expected.clone(),
            needs_rekey: true,
        },
        transition: submission.transition.clone(),
    };
    let continuation = page(
        &observed,
        1,
        5,
        vec![message, group(&submission, 5, None)],
        None,
    );
    let result = alice
        .reopened()
        .receive_journal(&observed, &continuation, at)
        .unwrap();
    assert!(result.head == expected && result.messages.len() == 1);
    let result = bob
        .reopened()
        .receive_journal(&observed, &continuation, at)
        .unwrap();
    assert!(result.head == expected && result.messages.len() == 1);
    assert_eq!(
        incoming_commits::secret(&alice),
        incoming_commits::secret(&bob)
    );
    assert_eq!(
        alice
            .reopened()
            .journal_last_batch(&observed, at + 1)
            .unwrap()
            .messages
            .len(),
        1
    );
}
