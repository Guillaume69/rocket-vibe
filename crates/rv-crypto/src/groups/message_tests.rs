use super::*;
use rv_crypto_public::messages as packet;
use rv_protocol::{SendMessage, cards::IntegrationCard, parity::QuoteReference};

fn observation(account: &Account) -> MessageObservation {
    account
        .manager
        .inspect(|_, records| {
            let state = read(records, "room").unwrap().unwrap();
            let active = state.active.unwrap();
            Ok(MessageObservation {
                roster: Roster {
                    scope: state.scope,
                    authority_version: active.transition.plan.authority_version,
                    members: active.transition.plan.members,
                },
                head: active.receipt,
                needs_rekey: false,
            })
        })
        .unwrap()
}
fn message(id: &str) -> SendMessage {
    SendMessage {
        operation_id: id.into(),
        text: "Texte privé **riche** 🐾\nseconde ligne".into(),
        reply_to: Some("thread-root".into()),
        quotes: vec![QuoteReference {
            room_id: "quoted-room".into(),
            message_id: "quoted-message".into(),
            revision: "9007199254740993".into(),
        }],
        cards: vec![IntegrationCard {
            author: Some("Auteur privé".into()),
            title: Some("Carte privée".into()),
            url: Some("https://example.org/private".into()),
            text: Some("Contenu privé de carte".into()),
            color: None,
            fields: vec![],
        }],
    }
}
fn ack(submission: &MessageSubmission, position: u64) -> packet::Receipt {
    let proof = submission.verified(NOW).unwrap();
    packet::Receipt {
        fingerprint: proof.fingerprint().unwrap(),
        header: proof.header,
        message: format!("stored-{position}"),
        position,
    }
}
fn resign(
    account: &Account,
    submission: &mut MessageSubmission,
    alter: impl FnOnce(&mut packet::Proof),
) {
    let mut proof = packet::Proof::from_bytes(&submission.proof).unwrap();
    alter(&mut proof);
    proof.ciphertext = digest(&submission.ciphertext);
    proof.signature = account
        .manager
        .inspect(|_, records| {
            let local =
                LocalDevice::load(&account.root, &account.manager.scope().device, records).unwrap();
            Ok(local.sign(&proof.signing_bytes().unwrap()).unwrap())
        })
        .unwrap();
    submission.proof = proof.to_bytes().unwrap();
}
// Scratch-provider ciphertexts exercise late rejection. They never leave this
// test fixture or advance the actual sender's durable ratchet.
fn crafted(
    signer: &Account,
    claim: &Account,
    request: &SendMessage,
    plaintext: &[u8],
) -> MessageSubmission {
    let observed = observation(signer);
    let header = packet::Header {
        version: 1,
        scope: observed.head.scope.clone(),
        operation: request.operation_id.clone(),
        group_revision: observed.head.revision,
        epoch: observed.head.epoch,
        group_fingerprint: observed.head.fingerprint,
        author: claim.root.user.clone(),
        device: claim.manager.scope().device.clone(),
        incarnation: claim.certificate.device.incarnation,
        certificate: claim.certificate.fingerprint().unwrap(),
        kind: packet::Kind::Chat,
        thread: request.reply_to.clone(),
    };
    let ciphertext = signer
        .manager
        .inspect(|provider, records| {
            let mut group = MlsGroup::load(
                provider.storage(),
                &GroupId::from_slice(&header.scope.group_id().unwrap()),
            )
            .unwrap()
            .unwrap();
            let local =
                LocalDevice::load(&signer.root, &signer.manager.scope().device, records).unwrap();
            group.set_aad(header.aad().unwrap());
            Ok(group
                .create_message(provider, &local, plaintext)
                .unwrap()
                .to_bytes()
                .unwrap())
        })
        .unwrap();
    let mut proof = packet::Proof {
        header,
        certificate: claim.certificate.clone(),
        ciphertext: digest(&ciphertext),
        signature: vec![],
    };
    proof.signature = claim
        .manager
        .inspect(|_, records| {
            let local =
                LocalDevice::load(&claim.root, &claim.manager.scope().device, records).unwrap();
            Ok(local.sign(&proof.signing_bytes().unwrap()).unwrap())
        })
        .unwrap();
    MessageSubmission {
        proof: proof.to_bytes().unwrap(),
        ciphertext,
    }
}

#[test]
fn durable_original_ciphertext_rich_body_and_own_echo_survive_actual_reopen() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let observed = observation(&alice);
    let request = message("private-first");
    let original = alice
        .coordinator()
        .prepare_message(&observed, &request, NOW)
        .unwrap();
    assert!(
        !original
            .ciphertext
            .windows(request.text.len())
            .any(|s| s == request.text.as_bytes())
    );
    assert!(
        alice
            .reopened()
            .prepare_message(&observed, &request, NOW)
            .unwrap()
            == original
    );
    assert!(
        alice
            .reopened()
            .retry_message(&observed, &request.operation_id, NOW)
            .unwrap()
            == original
    );
    let receipt = ack(&original, 9_007_199_254_740_993);
    let clear = bob
        .reopened()
        .receive_message(&observation(&bob), &original, &receipt, NOW)
        .unwrap();
    assert!(
        serde_json::to_vec(&clear.message().unwrap()).unwrap()
            == serde_json::to_vec(&request).unwrap()
    );
    assert_eq!(
        bob.reopened()
            .received_message_position(&observed.head.scope)
            .unwrap(),
        receipt.position
    );
    assert!(
        bob.reopened()
            .receive_message(&observation(&bob), &original, &receipt, NOW)
            .unwrap()
            .message()
            .unwrap()
            .text
            == request.text
    );
    alice.reopened().confirm_message(&receipt, NOW).unwrap();
    alice.reopened().confirm_message(&receipt, NOW).unwrap();
    let own = alice
        .reopened()
        .receive_message(&observed, &original, &receipt, NOW)
        .unwrap();
    assert!(own.message().unwrap().text == request.text);
    assert!(matches!(
        alice
            .coordinator()
            .retry_message(&observed, &request.operation_id, NOW),
        Err(Error::MessageNotPending)
    ));
    let next = alice
        .coordinator()
        .prepare_message(&observed, &message("private-next"), NOW)
        .unwrap();
    assert!(next.ciphertext != original.ciphertext);
    bob.coordinator()
        .receive_message(
            &observation(&bob),
            &next,
            &ack(&next, receipt.position + 1),
            NOW,
        )
        .unwrap();
}

#[test]
fn valid_outer_proof_cannot_substitute_aad_thread_operation_or_actual_mls_author() {
    let (alice, bob, carol) = incoming_commits::fixture(true);
    let carol = carol.unwrap();
    let request = message("bound-message");
    let original = alice
        .coordinator()
        .prepare_message(&observation(&alice), &request, NOW)
        .unwrap();
    for field in 0..3 {
        let mut modified = original.clone();
        resign(&alice, &mut modified, |proof| match field {
            0 => proof.header.operation = "different-message".into(),
            1 => proof.header.thread = Some("different-thread".into()),
            _ => proof.header.group_fingerprint = [7; 32],
        });
        modified.verified(NOW).unwrap();
        assert!(
            bob.coordinator()
                .receive_message(&observation(&bob), &modified, &ack(&modified, 1), NOW)
                .is_err()
        );
        assert_eq!(
            bob.coordinator()
                .received_message_position(&observation(&bob).head.scope)
                .unwrap(),
            0
        );
    }
    bob.coordinator()
        .receive_message(&observation(&bob), &original, &ack(&original, 1), NOW)
        .unwrap();
    let request = message("real-sender");
    let payload = super::super::messages::payload(&request).unwrap();
    let mixed = crafted(&bob, &alice, &request, &payload);
    mixed.verified(NOW).unwrap();
    assert!(
        carol
            .coordinator()
            .receive_message(&observation(&carol), &mixed, &ack(&mixed, 2), NOW)
            .is_err()
    );
    let genuine = bob
        .coordinator()
        .prepare_message(&observation(&bob), &request, NOW)
        .unwrap();
    carol
        .coordinator()
        .receive_message(&observation(&carol), &genuine, &ack(&genuine, 2), NOW)
        .unwrap();
}

#[test]
fn late_plaintext_refusal_restores_receiver_ratchet_and_receipt_prefix() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let request = message("late-content");
    let malformed = crafted(
        &alice,
        &alice,
        &request,
        b"this is not the authenticated content document",
    );
    let writes = bob.keystore.writes.load(Ordering::SeqCst);
    assert!(matches!(
        bob.coordinator()
            .receive_message(&observation(&bob), &malformed, &ack(&malformed, 1), NOW),
        Err(Error::Changed)
    ));
    assert_eq!(bob.keystore.writes.load(Ordering::SeqCst), writes);
    assert_eq!(
        bob.coordinator()
            .received_message_position(&observation(&bob).head.scope)
            .unwrap(),
        0
    );
    let genuine = alice
        .coordinator()
        .prepare_message(&observation(&alice), &request, NOW)
        .unwrap();
    assert!(
        bob.reopened()
            .receive_message(&observation(&bob), &genuine, &ack(&genuine, 1), NOW)
            .unwrap()
            .message()
            .unwrap()
            .text
            == request.text
    );
}

#[test]
fn outbound_and_inbound_checkpoint_loss_recover_original_ciphertext_and_clear_once() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let request = message("checkpoint-message");
    alice.keystore.fail_at.store(
        alice.keystore.writes.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    assert!(matches!(
        alice
            .coordinator()
            .prepare_message(&observation(&alice), &request, NOW),
        Err(Error::Storage(_))
    ));
    let original = alice
        .reopened()
        .retry_message(&observation(&alice), &request.operation_id, NOW)
        .unwrap();
    let receipt = ack(&original, 1);
    bob.keystore.fail_at.store(
        bob.keystore.writes.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    assert!(matches!(
        bob.coordinator()
            .receive_message(&observation(&bob), &original, &receipt, NOW),
        Err(Error::Storage(_))
    ));
    let received = bob
        .reopened()
        .receive_message(&observation(&bob), &original, &receipt, NOW)
        .unwrap();
    assert!(received.message().unwrap().text == request.text);
    assert_eq!(
        bob.reopened()
            .received_message_position(&observation(&bob).head.scope)
            .unwrap(),
        1
    );
    alice.reopened().confirm_message(&receipt, NOW).unwrap();
}

#[test]
fn every_ack_field_and_reused_operation_are_checked_without_reencrypting() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let observed = observation(&alice);
    let request = message("exact-ack");
    let original = alice
        .coordinator()
        .prepare_message(&observed, &request, NOW)
        .unwrap();
    let receipt = ack(&original, 1);
    for field in 0..4 {
        let mut changed = receipt.clone();
        match field {
            0 => changed.header.operation = "other-op".into(),
            1 => changed.header.epoch += 1,
            2 => changed.fingerprint = [8; 32],
            _ => changed.header.device = "other-device".into(),
        }
        assert!(alice.coordinator().confirm_message(&changed, NOW).is_err());
        assert!(
            alice
                .reopened()
                .retry_message(&observed, &request.operation_id, NOW)
                .unwrap()
                == original
        );
    }
    let mut changed = message("exact-ack");
    changed.text = "other private content".into();
    assert!(matches!(
        alice
            .coordinator()
            .prepare_message(&observed, &changed, NOW),
        Err(Error::Conflict)
    ));
    alice.coordinator().confirm_message(&receipt, NOW).unwrap();
    let mut changed = receipt.clone();
    changed.position += 1;
    assert!(matches!(
        alice.coordinator().confirm_message(&changed, NOW),
        Err(Error::Receipt)
    ));
    changed = receipt.clone();
    changed.message = "other-stored-message".into();
    assert!(matches!(
        alice.coordinator().confirm_message(&changed, NOW),
        Err(Error::Receipt)
    ));
    bob.coordinator()
        .receive_message(&observation(&bob), &original, &receipt, NOW)
        .unwrap();
    assert!(
        bob.coordinator()
            .receive_message(&observation(&bob), &original, &changed, NOW)
            .is_err()
    );
    alice.coordinator().forget_message(&receipt).unwrap();
    alice.coordinator().confirm_message(&receipt, NOW).unwrap();
    assert!(
        alice
            .coordinator()
            .prepare_message(&observed, &request, NOW)
            .is_err()
    );
    bob.coordinator().forget_message(&receipt).unwrap();
    assert!(matches!(
        bob.coordinator()
            .receive_message(&observation(&bob), &original, &receipt, NOW),
        Err(Error::MessageNotRetained)
    ));
}

#[test]
fn current_grants_pins_and_rekey_gate_new_sends_but_keep_ack_lookup() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let observed = observation(&alice);
    let request = message("gated-message");
    let change = Change {
        roster: observed.roster.clone(),
        head: observed.head.clone(),
        operation: "rotate-with-pending-message".into(),
        removals: vec![],
        packages: vec![],
    };
    let (old_preview, old_consent) = alice.coordinator().preview_change(&change, NOW).unwrap();
    let original = alice
        .coordinator()
        .prepare_message(&observed, &request, NOW)
        .unwrap();
    let receipt = ack(&original, 1);
    assert!(matches!(
        alice.coordinator().preview_change(&change, NOW),
        Err(Error::Pending)
    ));
    assert!(matches!(
        alice
            .coordinator()
            .prepare_change(&change, &old_consent, old_preview.fingerprint, NOW),
        Err(Error::Pending)
    ));
    for field in 0..3 {
        let mut changed = observed.clone();
        match field {
            0 => changed.roster.members[0].access_version = "changed-access".into(),
            1 => changed.needs_rekey = true,
            _ => changed.head.revision += 1,
        }
        assert!(
            alice
                .coordinator()
                .retry_message(&changed, &request.operation_id, NOW)
                .is_err()
        );
        assert!(
            alice
                .coordinator()
                .prepare_message(&changed, &message("cannot-send"), NOW)
                .is_err()
        );
    }
    alice.revoke(&bob);
    assert!(
        alice
            .coordinator()
            .retry_message(&observed, &request.operation_id, NOW)
            .is_err()
    );
    assert!(
        alice
            .coordinator()
            .prepare_message(&observed, &message("revoked-recipient"), NOW)
            .is_err()
    );
    assert!(
        alice
            .reopened()
            .pending_message(&request.operation_id)
            .unwrap()
            .fingerprint
            == receipt.fingerprint
    );
    alice
        .reopened()
        .confirm_message(&receipt, NOW + 4000)
        .unwrap();
}

#[test]
fn actual_pending_rotation_blocks_new_sends_and_preserves_confirmed_old_echoes() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let observed = observation(&alice);
    let first = alice
        .coordinator()
        .prepare_message(&observed, &message("before-rotation"), NOW)
        .unwrap();
    let first_ack = ack(&first, 1);
    bob.coordinator()
        .receive_message(&observation(&bob), &first, &first_ack, NOW)
        .unwrap();
    alice
        .coordinator()
        .confirm_message(&first_ack, NOW)
        .unwrap();
    let change = Change {
        roster: observed.roster.clone(),
        head: observed.head.clone(),
        operation: "rotate-after-message".into(),
        removals: vec![],
        packages: vec![],
    };
    let (preview, consent) = alice.coordinator().preview_change(&change, NOW).unwrap();
    let prepared = alice
        .coordinator()
        .prepare_change(&change, &consent, preview.fingerprint, NOW)
        .unwrap();
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    assert!(matches!(
        alice
            .coordinator()
            .prepare_message(&observed, &message("during-rotation"), NOW),
        Err(Error::Pending)
    ));
    let event = Commit {
        roster: change.roster,
        receipt: receipt(&prepared),
        transition: prepared.transition,
        commit: prepared.commit.unwrap(),
    };
    let (preview, consent) = bob.coordinator().preview_commit(&event, NOW).unwrap();
    bob.coordinator()
        .accept_commit(&event, &consent, preview.fingerprint, NOW)
        .unwrap();
    alice.coordinator().confirm(&event.receipt, NOW).unwrap();
    for account in [&alice, &bob] {
        let current = observation(account);
        assert_eq!(current.head.epoch, 2);
        assert!(
            account
                .reopened()
                .receive_message(&current, &first, &first_ack, NOW)
                .unwrap()
                .message()
                .unwrap()
                .operation_id
                == "before-rotation"
        );
        assert_eq!(
            account
                .reopened()
                .received_message_position(&current.head.scope)
                .unwrap(),
            1
        );
    }
    let next = alice
        .reopened()
        .prepare_message(&observation(&alice), &message("after-rotation"), NOW)
        .unwrap();
    assert_eq!(next.verified(NOW).unwrap().header.epoch, 2);
    bob.reopened()
        .receive_message(&observation(&bob), &next, &ack(&next, 2), NOW)
        .unwrap();
}

#[test]
fn unknown_backward_position_is_refused_without_consumption_and_cached_replay_cannot_rewind() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let observed = observation(&alice);
    let first = alice
        .coordinator()
        .prepare_message(&observed, &message("ordered-first"), NOW)
        .unwrap();
    let first_ack = ack(&first, 20);
    bob.coordinator()
        .receive_message(&observation(&bob), &first, &first_ack, NOW)
        .unwrap();
    alice
        .coordinator()
        .confirm_message(&first_ack, NOW)
        .unwrap();
    let next = alice
        .coordinator()
        .prepare_message(&observed, &message("ordered-next"), NOW)
        .unwrap();
    let writes = bob.keystore.writes.load(Ordering::SeqCst);
    assert!(matches!(
        bob.coordinator()
            .receive_message(&observation(&bob), &next, &ack(&next, 19), NOW),
        Err(Error::Changed)
    ));
    assert_eq!(bob.keystore.writes.load(Ordering::SeqCst), writes);
    bob.reopened()
        .receive_message(&observation(&bob), &next, &ack(&next, 21), NOW)
        .unwrap();
    bob.reopened()
        .receive_message(&observation(&bob), &first, &first_ack, NOW)
        .unwrap();
    assert_eq!(
        bob.reopened()
            .received_message_position(&observed.head.scope)
            .unwrap(),
        21
    );
}

#[test]
fn bounded_documents_and_unknown_own_ciphertext_cannot_advance_protected_ratchets() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let observed = observation(&alice);
    let writes = alice.keystore.writes.load(Ordering::SeqCst);
    for case in 0..6 {
        let mut request = message("bounded-document");
        match case {
            0 => request.operation_id = "bad/operation".into(),
            1 => request.text = "x".repeat(32_769),
            2 => request.quotes[0].revision = "01".into(),
            3 => request.cards[0].text = Some("x".repeat(80_000)),
            4 => request.reply_to = Some(request.operation_id.clone()),
            _ => {
                request.text.clear();
                request.quotes.clear();
                request.cards.clear();
            }
        }
        assert!(
            alice
                .coordinator()
                .prepare_message(&observed, &request, NOW)
                .is_err()
        );
    }
    assert_eq!(alice.keystore.writes.load(Ordering::SeqCst), writes);
    let request = message("bounded-document");
    let original = alice
        .coordinator()
        .prepare_message(&observed, &request, NOW)
        .unwrap();
    let receipt = ack(&original, 1);
    let mut changed = original.clone();
    changed.proof.push(b' ');
    assert!(changed.verified(NOW).is_err());
    changed.proof = vec![b' '; packet::PROOF_LIMIT + 1];
    assert!(changed.verified(NOW).is_err());
    changed = original.clone();
    changed.ciphertext = vec![0; packet::CIPHERTEXT_LIMIT + 1];
    assert!(changed.verified(NOW).is_err());
    changed = original.clone();
    resign(&alice, &mut changed, |proof| {
        proof.certificate.signature[0] ^= 1;
        proof.header.certificate = proof.certificate.fingerprint().unwrap();
    });
    // Canonical decoding is not certificate authentication.
    packet::Proof::from_bytes(&changed.proof).unwrap();
    assert!(changed.verified(NOW).is_err());
    changed = original.clone();
    *changed.ciphertext.last_mut().unwrap() ^= 1;
    resign(&alice, &mut changed, |_| {});
    changed.verified(NOW).unwrap();
    let writes = bob.keystore.writes.load(Ordering::SeqCst);
    assert!(
        bob.coordinator()
            .receive_message(&observation(&bob), &changed, &ack(&changed, 1), NOW)
            .is_err()
    );
    assert_eq!(bob.keystore.writes.load(Ordering::SeqCst), writes);
    bob.reopened()
        .receive_message(&observation(&bob), &original, &receipt, NOW)
        .unwrap();
    alice.coordinator().confirm_message(&receipt, NOW).unwrap();
    let request = message("unknown-own");
    let plaintext = super::super::messages::payload(&request).unwrap();
    let unretained = crafted(&alice, &alice, &request, &plaintext);
    assert!(matches!(
        alice
            .coordinator()
            .receive_message(&observed, &unretained, &ack(&unretained, 2), NOW),
        Err(Error::Changed)
    ));
    let retained = alice
        .reopened()
        .prepare_message(&observed, &request, NOW)
        .unwrap();
    bob.reopened()
        .receive_message(&observation(&bob), &retained, &ack(&retained, 2), NOW)
        .unwrap();
}

#[test]
fn bounded_cache_releases_confirmed_plaintext_without_reusing_an_operation_or_skipping_a_ratchet() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let observed = observation(&alice);
    let mut first = None;
    for i in 0..64 {
        let request = message(&format!("bounded-{i}"));
        let submission = alice
            .coordinator()
            .prepare_message(&observed, &request, NOW)
            .unwrap();
        let receipt = ack(&submission, i + 1);
        bob.coordinator()
            .receive_message(&observation(&bob), &submission, &receipt, NOW)
            .unwrap();
        alice.coordinator().confirm_message(&receipt, NOW).unwrap();
        if i == 0 {
            first = Some((submission, receipt));
        }
    }
    assert!(matches!(
        alice
            .coordinator()
            .prepare_message(&observed, &message("bounded-next"), NOW),
        Err(Error::Limit)
    ));
    let (original, receipt) = first.unwrap();
    alice.coordinator().forget_message(&receipt).unwrap();
    bob.coordinator().forget_message(&receipt).unwrap();
    assert!(
        alice
            .coordinator()
            .prepare_message(&observed, &message("bounded-0"), NOW)
            .is_err()
    );
    assert!(matches!(
        bob.coordinator()
            .receive_message(&observation(&bob), &original, &receipt, NOW),
        Err(Error::MessageNotRetained)
    ));
    let next = alice
        .coordinator()
        .prepare_message(&observed, &message("bounded-next"), NOW)
        .unwrap();
    bob.coordinator()
        .receive_message(&observation(&bob), &next, &ack(&next, 65), NOW)
        .unwrap();
    assert_eq!(
        bob.coordinator()
            .received_message_position(&observed.head.scope)
            .unwrap(),
        65
    );
}
