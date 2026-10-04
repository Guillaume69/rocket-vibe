use super::*;

#[test]
fn protected_drafts_reopen_separately_for_roots_threads_and_membership_grants() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let roster = application_messages::observation(&alice).roster;
    let coordinator = alice.coordinator();
    let secret = incoming_commits::secret(&alice);
    coordinator
        .set_draft(&roster, None, "Root private draft 🐾".into(), NOW)
        .unwrap();
    coordinator
        .set_draft(
            &roster,
            Some("thread-root".into()),
            "Thread private draft".into(),
            NOW,
        )
        .unwrap();
    let reopened = alice.reopened();
    let writes = alice.keystore.writes.load(Ordering::SeqCst);
    assert_eq!(
        &*reopened.draft(&roster, None, NOW).unwrap(),
        "Root private draft 🐾"
    );
    assert_eq!(
        &*reopened
            .draft(&roster, Some("thread-root".into()), NOW)
            .unwrap(),
        "Thread private draft"
    );
    assert!(
        reopened
            .draft(&roster, Some("another-thread".into()), NOW)
            .unwrap()
            .is_empty()
    );
    assert!(
        bob.coordinator()
            .draft(&roster, None, NOW)
            .unwrap()
            .is_empty()
    );
    assert_eq!(alice.keystore.writes.load(Ordering::SeqCst), writes);
    assert_eq!(incoming_commits::secret(&alice), secret);
    for member_field in [false, true] {
        let mut changed = roster.clone();
        let grant = changed
            .members
            .iter_mut()
            .find(|m| m.user == "alice")
            .unwrap();
        if member_field {
            grant.activation_version = "new-activation".into();
        } else {
            grant.access_version = "new-access".into();
        }
        assert!(reopened.draft(&changed, None, NOW).is_err());
        assert!(
            reopened
                .set_draft(&changed, None, "Replacement".into(), NOW)
                .is_err()
        );
    }
    let mut changed = roster.clone();
    changed.scope.incarnation = [7; 16];
    assert!(reopened.draft(&changed, None, NOW).is_err());
    assert_eq!(
        &*alice.reopened().draft(&roster, None, NOW).unwrap(),
        "Root private draft 🐾"
    );
    reopened
        .set_draft(&roster, None, String::new(), NOW)
        .unwrap();
    assert!(
        alice
            .reopened()
            .draft(&roster, None, NOW)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        &*alice
            .reopened()
            .draft(&roster, Some("thread-root".into()), NOW)
            .unwrap(),
        "Thread private draft"
    );
    // The filesystem holds encrypted coffer envelopes, never the compose text.
    for file in fs::read_dir(alice.directory.path()).unwrap().flatten() {
        if file.file_type().unwrap().is_file() {
            let bytes = fs::read(file.path()).unwrap();
            assert!(
                !bytes
                    .windows(b"private draft".len())
                    .any(|w| w == b"private draft")
            );
        }
    }
}

#[test]
fn compose_eligibility_is_read_only_and_drafts_survive_rotation_but_reject_own_revocation() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let observation = application_messages::observation(&alice);
    let coordinator = alice.coordinator();
    coordinator
        .set_draft(
            &observation.roster,
            None,
            "Keep through rotation".into(),
            NOW,
        )
        .unwrap();
    let writes = alice.keystore.writes.load(Ordering::SeqCst);
    assert_eq!(coordinator.can_prepare_message(&observation, NOW), Ok(true));
    let mut blocked = observation.clone();
    blocked.needs_rekey = true;
    assert_eq!(coordinator.can_prepare_message(&blocked, NOW), Ok(false));
    assert_eq!(
        coordinator.can_prepare_message(&observation, NOW + 3601),
        Ok(false)
    );
    assert_eq!(alice.keystore.writes.load(Ordering::SeqCst), writes);
    let change = changes::change(&alice, "draft-rotation", &["alice", "bob"], &[], vec![]);
    let submission = changes::prepare_change(&alice, &change, NOW);
    assert_eq!(
        coordinator.can_prepare_message(&observation, NOW),
        Ok(false)
    );
    assert_eq!(
        &*coordinator.draft(&observation.roster, None, NOW).unwrap(),
        "Keep through rotation"
    );
    coordinator.confirm(&receipt(&submission), NOW).unwrap();
    let rotated = application_messages::observation(&alice);
    assert_eq!(
        alice.reopened().can_prepare_message(&rotated, NOW),
        Ok(true)
    );
    assert_eq!(
        &*alice.reopened().draft(&rotated.roster, None, NOW).unwrap(),
        "Keep through rotation"
    );
    assert!(
        coordinator
            .set_draft(
                &rotated.roster,
                Some("bad/thread".into()),
                "Invalid".into(),
                NOW
            )
            .is_err()
    );
    assert!(
        coordinator
            .set_draft(&rotated.roster, None, "a".repeat(65537), NOW)
            .is_err()
    );
    alice.trust(&alice, false);
    alice.revoke(&alice);
    assert_eq!(
        alice.reopened().can_prepare_message(&rotated, NOW),
        Ok(false)
    );
    assert!(alice.reopened().draft(&rotated.roster, None, NOW).is_err());
    assert!(
        alice
            .reopened()
            .set_draft(&rotated.roster, None, "Revoked".into(), NOW)
            .is_err()
    );
    drop(bob);
}

#[test]
fn outgoing_intents_reopen_with_original_body_and_cancellation_cannot_be_relabelled() {
    let (alice, bob, _) = incoming_commits::fixture(false);
    let observation = application_messages::observation(&alice);
    let document = application_messages::message("private-original-compose");
    let original = alice
        .coordinator()
        .prepare_message(&observation, &document, NOW)
        .unwrap();
    let writes = alice.keystore.writes.load(Ordering::SeqCst);
    let pending = alice
        .reopened()
        .outgoing_messages(&observation.roster, NOW)
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert!(!pending[0].cancelling && !pending[0].cancelled && pending[0].receipt.is_none());
    assert_eq!(pending[0].header.operation, document.operation_id);
    assert_eq!(
        serde_json::to_value(pending[0].message().unwrap()).unwrap(),
        serde_json::to_value(&document).unwrap()
    );
    assert!(
        bob.coordinator()
            .outgoing_messages(&observation.roster, NOW)
            .unwrap()
            .is_empty()
    );
    assert_eq!(alice.keystore.writes.load(Ordering::SeqCst), writes);
    alice
        .coordinator()
        .request_cancellation(&document.operation_id, NOW)
        .unwrap();
    assert!(
        alice
            .reopened()
            .outgoing_messages(&observation.roster, NOW)
            .unwrap()[0]
            .cancelling
    );
    let proof = original.verified(NOW).unwrap();
    alice
        .coordinator()
        .confirm_cancellation(
            &MessageCancellation {
                header: proof.header.clone(),
                fingerprint: proof.fingerprint().unwrap(),
            },
            NOW,
        )
        .unwrap();
    let cancelled = alice
        .reopened()
        .outgoing_messages(&observation.roster, NOW)
        .unwrap();
    assert!(cancelled[0].cancelled && !cancelled[0].cancelling);
    assert_eq!(cancelled[0].message().unwrap().text, document.text);
    let mut another_admission = observation.roster.clone();
    another_admission
        .members
        .iter_mut()
        .find(|m| m.user == "alice")
        .unwrap()
        .activation_version = "other".into();
    assert!(
        alice
            .reopened()
            .outgoing_messages(&another_admission, NOW)
            .is_err()
    );
}
