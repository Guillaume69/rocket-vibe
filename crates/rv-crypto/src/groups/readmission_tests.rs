use super::*;
use super::{application_messages as messages, changes, incoming_commits as incoming};

fn fixture() -> (Account, Account, Admission) {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    alice.trust(&bob, true);
    bob.trust(&alice, true);
    let request = request(vec![bob.package()], &["alice", "bob"]);
    let initial = prepare(&alice.coordinator(), &request);
    let welcome = admission::event(&request, &initial, "bob-mobile");
    admission::accept(&bob, &welcome);
    alice
        .coordinator()
        .confirm(&receipt(&initial), NOW)
        .unwrap();
    (alice, bob, welcome)
}
fn successor(alice: &Account, bob: &Account) -> Admission {
    let remove = changes::change(
        alice,
        "remove-old-admission",
        &["alice"],
        &["bob-mobile"],
        vec![],
    );
    let removed = changes::prepare_change(alice, &remove, NOW);
    alice
        .coordinator()
        .confirm(&receipt(&removed), NOW)
        .unwrap();
    let mut add = changes::change(
        alice,
        "fresh-readmission",
        &["alice", "bob"],
        &[],
        vec![bob.package()],
    );
    add.roster
        .members
        .iter_mut()
        .find(|m| m.user == "bob")
        .unwrap()
        .access_version = "rejoined-bob".into();
    let submitted = changes::prepare_change(alice, &add, NOW);
    alice
        .coordinator()
        .confirm(&receipt(&submitted), NOW)
        .unwrap();
    admission::event(
        &Genesis {
            roster: add.roster,
            operation: add.operation,
            packages: vec![],
        },
        &submitted,
        "bob-mobile",
    )
}

#[test]
fn same_vault_fresh_welcome_replaces_old_group_atomically_and_keeps_package_history() {
    let (alice, bob, old) = fixture();
    let original_secret = incoming::secret(&bob);
    let fresh = successor(&alice, &bob);
    let coordinator = bob.reopened();
    let (preview, consent) = coordinator.preview_readmission(&fresh, NOW).unwrap();
    assert_eq!(incoming::secret(&bob), original_secret);
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(1));
    coordinator
        .accept_readmission(&fresh, &consent, preview.fingerprint, NOW)
        .unwrap();
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(3));
    assert_eq!(incoming::secret(&bob), incoming::secret(&alice));
    assert_ne!(incoming::secret(&bob), original_secret);
    bob.manager
        .inspect(|_, records| {
            let state = read(records, "room").unwrap().unwrap();
            assert!(state.seen_packages.contains(&old.welcome.key_package));
            assert!(state.seen_packages.contains(&fresh.welcome.key_package));
            Ok(())
        })
        .unwrap();
    coordinator
        .accept_readmission(&fresh, &consent, preview.fingerprint, NOW + 3600)
        .unwrap();
}

#[test]
fn pending_original_group_and_message_must_settle_before_readmission() {
    for group in [false, true] {
        let (alice, bob, _) = fixture();
        let pending = if group {
            let change =
                changes::change(&bob, "before-readmission", &["alice", "bob"], &[], vec![]);
            Some(changes::prepare_change(&bob, &change, NOW))
        } else {
            bob.coordinator()
                .prepare_message(
                    &messages::observation(&bob),
                    &messages::message("before-readmission"),
                    NOW,
                )
                .unwrap();
            None
        };
        let fresh = successor(&alice, &bob);
        assert!(matches!(
            bob.reopened().preview_readmission(&fresh, NOW),
            Err(Error::Pending)
        ));
        if let Some(submission) = pending {
            bob.coordinator()
                .request_group_cancellation("room", &submission.operation, NOW)
                .unwrap();
            bob.coordinator()
                .confirm_group_cancellation(
                    &GroupCancellation {
                        scope: submission.scope.clone(),
                        operation: submission.operation.clone(),
                        device: "bob-mobile".into(),
                        fingerprint: receipt(&submission).fingerprint,
                    },
                    NOW,
                )
                .unwrap();
        } else {
            let original = bob
                .coordinator()
                .request_cancellation("before-readmission", NOW)
                .unwrap();
            let proof = rv_crypto_public::messages::Proof::from_bytes(&original.proof).unwrap();
            bob.coordinator()
                .confirm_cancellation(
                    &MessageCancellation {
                        header: proof.header.clone(),
                        fingerprint: proof.fingerprint().unwrap(),
                    },
                    NOW,
                )
                .unwrap();
        }
        let (preview, consent) = bob.reopened().preview_readmission(&fresh, NOW).unwrap();
        bob.reopened()
            .accept_readmission(&fresh, &consent, preview.fingerprint, NOW)
            .unwrap();
        if !group {
            assert!(
                bob.reopened()
                    .cancelled_message("before-readmission")
                    .is_ok()
            );
        }
        assert_eq!(incoming::secret(&alice), incoming::secret(&bob));
    }
}

#[test]
fn previous_cached_plaintext_cannot_be_projected_under_the_new_admission() {
    let (alice, bob, _) = fixture();
    let old_roster = messages::observation(&bob).roster;
    bob.coordinator()
        .set_draft(&old_roster, None, "Draft before readmission".into(), NOW)
        .unwrap();
    let message = messages::message("previous-admission-payload");
    let original = alice
        .coordinator()
        .prepare_message(&messages::observation(&alice), &message, NOW)
        .unwrap();
    let accepted = messages::ack(&original, 10);
    alice.coordinator().confirm_message(&accepted, NOW).unwrap();
    bob.coordinator()
        .receive_message(&messages::observation(&bob), &original, &accepted, NOW)
        .unwrap();
    let fresh = successor(&alice, &bob);
    let (preview, consent) = bob.coordinator().preview_readmission(&fresh, NOW).unwrap();
    bob.coordinator()
        .accept_readmission(&fresh, &consent, preview.fingerprint, NOW)
        .unwrap();
    let current = messages::observation(&bob);
    assert!(bob.reopened().draft(&old_roster, None, NOW).is_err());
    assert!(
        bob.reopened()
            .draft(&current.roster, None, NOW)
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        bob.coordinator()
            .receive_message(&current, &original, &accepted, NOW),
        Err(Error::MessageRetired)
    ));
    assert_eq!(bob.reopened().journal_request("room").unwrap().after, 0);
    let next = alice
        .coordinator()
        .prepare_message(
            &messages::observation(&alice),
            &messages::message("fresh-admission-payload"),
            NOW,
        )
        .unwrap();
    let ack = messages::ack(&next, 12);
    alice.coordinator().confirm_message(&ack, NOW).unwrap();
    bob.reopened()
        .receive_message(&current, &next, &ack, NOW)
        .unwrap();
}

#[test]
fn wrong_welcome_mls_bytes_after_valid_signature_never_destroy_old_storage_or_consume_fresh_package()
 {
    let (alice, bob, _) = fixture();
    let fresh = successor(&alice, &bob);
    let before = incoming::secret(&bob);
    let mut corrupt = fresh.clone();
    corrupt.welcome.payload[0] ^= 1;
    let mut transition = Transition::from_bytes(&corrupt.transition).unwrap();
    transition
        .plan
        .welcomes
        .iter_mut()
        .find(|w| w.device == "bob-mobile")
        .unwrap()
        .digest = digest(&corrupt.welcome.payload);
    transition.signature = alice
        .manager
        .inspect(|_, records| {
            let local = LocalDevice::load(&alice.root, "alice-desktop", records).unwrap();
            Ok(local
                .sign(&transition.plan.signing_bytes().unwrap())
                .unwrap())
        })
        .unwrap();
    corrupt.receipt.fingerprint = transition.fingerprint().unwrap();
    corrupt.transition = transition.to_bytes().unwrap();
    assert!(
        bob.coordinator()
            .preview_readmission(&corrupt, NOW)
            .is_err()
    );
    assert_eq!(incoming::secret(&bob), before);
    let (preview, consent) = bob.reopened().preview_readmission(&fresh, NOW).unwrap();
    bob.reopened()
        .accept_readmission(&fresh, &consent, preview.fingerprint, NOW)
        .unwrap();
    assert_eq!(incoming::secret(&bob), incoming::secret(&alice));
}

#[test]
fn stale_pin_or_roster_confirmation_preserves_the_previous_group() {
    let (alice, bob, _) = fixture();
    let fresh = successor(&alice, &bob);
    let before = incoming::secret(&bob);
    let (preview, consent) = bob.coordinator().preview_readmission(&fresh, NOW).unwrap();
    let mut changed = fresh.clone();
    changed
        .roster
        .members
        .iter_mut()
        .find(|m| m.user == "bob")
        .unwrap()
        .access_version = "another-grant".into();
    assert!(
        bob.coordinator()
            .accept_readmission(&changed, &consent, preview.fingerprint, NOW)
            .is_err()
    );
    bob.revoke(&alice);
    assert!(matches!(
        bob.coordinator()
            .accept_readmission(&fresh, &consent, preview.fingerprint, NOW),
        Err(Error::Changed)
    ));
    assert_eq!(incoming::secret(&bob), before);
}

#[test]
fn failed_external_checkpoint_reconciles_only_old_or_fully_new_admission_after_reopen() {
    let (alice, bob, old) = fixture();
    let fresh = successor(&alice, &bob);
    let (preview, consent) = bob.coordinator().preview_readmission(&fresh, NOW).unwrap();
    bob.keystore.fail_at.store(
        bob.keystore.writes.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    assert!(
        bob.coordinator()
            .accept_readmission(&fresh, &consent, preview.fingerprint, NOW)
            .is_err()
    );
    bob.keystore.fail_at.store(0, Ordering::SeqCst);
    let reopened = bob.reopened();
    assert!(matches!(reopened.ready_epoch("room"), Ok(1) | Ok(3)));
    reopened
        .accept_readmission(&fresh, &consent, preview.fingerprint, NOW)
        .unwrap();
    assert_eq!(incoming::secret(&bob), incoming::secret(&alice));
    assert!(reopened.preview_readmission(&old, NOW).is_err());
}
