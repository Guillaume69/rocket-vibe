use super::*;
use super::{
    changes::{change, prepare_change},
    incoming_commits as incoming,
};

fn cancellation(account: &Account, submission: &Submission) -> GroupCancellation {
    GroupCancellation {
        scope: submission.scope.clone(),
        operation: submission.operation.clone(),
        device: account.certificate.device.device.clone(),
        fingerprint: Transition::from_bytes(&submission.transition)
            .unwrap()
            .fingerprint()
            .unwrap(),
    }
}
fn request_cancel(account: &Account, submission: &Submission, now: u64) {
    let CancellationRequest::Original(original) = account
        .coordinator()
        .request_group_cancellation(&submission.scope.room, &submission.operation, now)
        .unwrap()
    else {
        panic!("original packet not retained")
    };
    assert_eq!(bytes(&original), bytes(submission));
}
fn event(submission: &Submission, roster: Roster) -> Commit {
    Commit {
        roster,
        receipt: receipt(submission),
        transition: submission.transition.clone(),
        commit: submission.commit.clone().unwrap(),
    }
}

#[test]
fn cancelled_genesis_releases_real_mls_storage_but_reserves_its_operation_across_restart() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let original_request = request(vec![], &["alice"]);
    let original = prepare(&alice.coordinator(), &original_request);
    request_cancel(&alice, &original, NOW + 1);
    assert_eq!(
        alice.reopened().retry("room", NOW + 1).err(),
        Some(Error::GroupCancelling)
    );
    let cancelled = cancellation(&alice, &original);
    alice
        .reopened()
        .confirm_group_cancellation(&cancelled, NOW + 2)
        .unwrap();
    let reopened = alice.reopened();
    assert!(
        matches!(reopened.group_settlement(&original.operation).unwrap(), Some(GroupSettlement::Cancelled(ref saved)) if saved == &cancelled)
    );
    reopened
        .confirm_group_cancellation(&cancelled, NOW + 3)
        .unwrap();
    assert_eq!(
        reopened
            .preview_genesis(&original_request, NOW + 3)
            .err()
            .map(|e| e == Error::GroupCancelled),
        Some(true)
    );
    let mut next = request(vec![], &["alice"]);
    next.operation = "fresh-genesis".into();
    assert_eq!(
        reopened
            .preview_genesis(&next, NOW)
            .err()
            .map(|e| e == Error::Changed),
        Some(true)
    );
    let (preview, consent) = reopened.preview_genesis(&next, NOW + 3).unwrap();
    let prepared = reopened
        .prepare_genesis(&next, &consent, preview.fingerprint, NOW + 3)
        .unwrap();
    reopened.confirm(&receipt(&prepared), NOW + 3).unwrap();
    assert_eq!(reopened.ready_epoch("room"), Ok(0));
    assert_eq!(
        reopened.confirm(&receipt(&original), NOW + 3),
        Err(Error::Receipt)
    );
}

#[test]
fn cancelled_rotation_preserves_accepted_epoch_and_allows_a_genuine_next_commit() {
    let (alice, bob, _) = incoming::fixture(false);
    let before = incoming::secret(&alice);
    let rotate = change(&alice, "abandoned-rotation", &["alice", "bob"], &[], vec![]);
    let original = prepare_change(&alice, &rotate, NOW);
    request_cancel(&alice, &original, NOW + 1);
    alice
        .reopened()
        .confirm_group_cancellation(&cancellation(&alice, &original), NOW + 1)
        .unwrap();
    assert_eq!(incoming::secret(&alice), before);
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    assert_eq!(
        alice
            .reopened()
            .pending_lookup("room")
            .err()
            .map(|e| e == Error::NotReady),
        Some(true)
    );
    let next = change(&alice, "next-rotation", &["alice", "bob"], &[], vec![]);
    let submitted = prepare_change(&alice, &next, NOW + 2);
    let next_event = event(&submitted, next.roster);
    incoming::accept(&bob, &next_event);
    alice
        .reopened()
        .confirm(&next_event.receipt, NOW + 2)
        .unwrap();
    assert_eq!(incoming::secret(&alice), incoming::secret(&bob));
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(2));
}

#[test]
fn superseded_original_survives_peer_commit_and_cancel_never_rewinds_the_accepted_group() {
    let (alice, bob, _) = incoming::fixture(false);
    let bob_request = change(&bob, "superseded-bob", &["alice", "bob"], &[], vec![]);
    let original = prepare_change(&bob, &bob_request, NOW);
    let alice_request = change(&alice, "accepted-alice", &["alice", "bob"], &[], vec![]);
    let peer = prepare_change(&alice, &alice_request, NOW);
    let peer_event = event(&peer, alice_request.roster);
    incoming::accept(&bob, &peer_event);
    alice
        .coordinator()
        .confirm(&peer_event.receipt, NOW)
        .unwrap();
    let before = incoming::secret(&bob);
    let unresolved = bob.reopened().pending_lookup("room").unwrap();
    assert!(unresolved.superseded);
    assert_eq!(unresolved.operation, original.operation);
    let next = change(&bob, "after-peer", &["alice", "bob"], &[], vec![]);
    assert_eq!(
        bob.reopened()
            .preview_change(&next, NOW)
            .err()
            .map(|e| e == Error::Pending),
        Some(true)
    );
    assert_eq!(
        bob.reopened().confirm(&receipt(&original), NOW),
        Err(Error::Receipt)
    );
    request_cancel(&bob, &original, NOW + 1);
    bob.reopened()
        .confirm_group_cancellation(&cancellation(&bob, &original), NOW + 2)
        .unwrap();
    assert_eq!(incoming::secret(&bob), before);
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(2));
    let successor = prepare_change(&bob, &next, NOW + 3);
    let next_event = event(&successor, next.roster);
    incoming::accept(&alice, &next_event);
    bob.coordinator()
        .confirm(&next_event.receipt, NOW + 3)
        .unwrap();
    assert_eq!(incoming::secret(&alice), incoming::secret(&bob));
}

#[test]
fn accepted_original_wins_cancellation_and_replays_its_terminal_receipt_after_expiry() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let original = prepare(&alice.coordinator(), &request(vec![], &["alice"]));
    request_cancel(&alice, &original, NOW + 1);
    let ack = receipt(&original);
    alice.reopened().confirm(&ack, NOW + 3600).unwrap();
    let reopened = alice.reopened();
    let CancellationRequest::Known(GroupSettlement::Accepted(saved)) = reopened
        .request_group_cancellation("room", &original.operation, NOW + 3601)
        .unwrap()
    else {
        panic!("accepted packet abandoned")
    };
    assert!(saved == ack);
    reopened.confirm(&ack, NOW + 3601).unwrap();
    assert_eq!(
        reopened.confirm_group_cancellation(&cancellation(&alice, &original), NOW + 3601),
        Err(Error::Receipt)
    );
    assert_eq!(reopened.ready_epoch("room"), Ok(0));
}

#[test]
fn cancellation_survives_expiry_and_pin_revocation_but_refuses_substituted_metadata() {
    let (alice, bob, _) = incoming::fixture(false);
    let rotate = change(&alice, "expired-rotation", &["alice", "bob"], &[], vec![]);
    let original = prepare_change(&alice, &rotate, NOW);
    let cancelled = cancellation(&alice, &original);
    assert_eq!(
        alice
            .coordinator()
            .confirm_group_cancellation(&cancelled, NOW),
        Err(Error::Receipt)
    );
    request_cancel(&alice, &original, NOW + 3600);
    alice.revoke(&bob);
    for field in 0..5 {
        let mut substituted = cancelled.clone();
        match field {
            0 => substituted.scope.data_epoch = "restored".into(),
            1 => substituted.scope.incarnation = [9; 16],
            2 => substituted.device = "other-device".into(),
            3 => substituted.fingerprint = [9; 32],
            _ => substituted.operation = "other-operation".into(),
        }
        assert!(
            alice
                .reopened()
                .confirm_group_cancellation(&substituted, NOW + 3600)
                .is_err()
        );
        assert!(alice.reopened().pending_lookup("room").unwrap().cancelling);
    }
    alice
        .reopened()
        .confirm_group_cancellation(&cancelled, NOW + 3600)
        .unwrap();
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    assert_eq!(
        alice.reopened().confirm_group_cancellation(&cancelled, NOW),
        Err(Error::Changed)
    );
}

#[test]
fn failed_protected_checkpoint_keeps_original_and_pending_commit_until_reconciliation() {
    let (alice, _, _) = incoming::fixture(false);
    let rotate = change(
        &alice,
        "checkpoint-rotation",
        &["alice", "bob"],
        &[],
        vec![],
    );
    let original = prepare_change(&alice, &rotate, NOW);
    request_cancel(&alice, &original, NOW);
    alice.keystore.fail_at.store(
        alice.keystore.writes.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    assert!(
        alice
            .coordinator()
            .confirm_group_cancellation(&cancellation(&alice, &original), NOW)
            .is_err()
    );
    alice.keystore.fail_at.store(0, Ordering::SeqCst);
    let reopened = alice.reopened();
    if reopened
        .group_settlement(&original.operation)
        .unwrap()
        .is_none()
    {
        assert!(reopened.pending_lookup("room").unwrap().cancelling);
        reopened
            .confirm_group_cancellation(&cancellation(&alice, &original), NOW)
            .unwrap();
    }
    assert_eq!(reopened.ready_epoch("room"), Ok(1));
    assert!(matches!(
        reopened.group_settlement(&original.operation).unwrap(),
        Some(GroupSettlement::Cancelled(_))
    ));
}
