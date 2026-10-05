use super::incoming_commits as incoming;
use super::*;

pub(super) fn change(
    account: &Account,
    operation: &str,
    users: &[&str],
    removals: &[&str],
    packages: Vec<Vec<u8>>,
) -> Change {
    let head = account
        .manager
        .inspect(|_, records| {
            Ok(read(records, "room")
                .unwrap()
                .unwrap()
                .active
                .unwrap()
                .receipt)
        })
        .unwrap();
    Change {
        roster: request(vec![], users).roster,
        head,
        operation: operation.into(),
        removals: removals.iter().map(|s| (*s).into()).collect(),
        packages,
    }
}
pub(super) fn prepare_change(account: &Account, request: &Change, now: u64) -> Submission {
    let (preview, consent) = account.coordinator().preview_change(request, now).unwrap();
    account
        .coordinator()
        .prepare_change(request, &consent, preview.fingerprint, now)
        .unwrap()
}
fn event(request: &Change, submission: &Submission) -> Commit {
    Commit {
        roster: request.roster.clone(),
        receipt: receipt(submission),
        transition: submission.transition.clone(),
        commit: submission.commit.clone().unwrap(),
    }
}
fn admit(account: &Account, request: &Change, submission: &Submission) {
    let genesis = Genesis {
        roster: request.roster.clone(),
        operation: request.operation.clone(),
        packages: vec![],
    };
    admission::accept(
        account,
        &admission::event(&genesis, submission, &account.certificate.device.device),
    );
}
fn finish(author: &Account, others: &[&Account], request: &Change, submission: &Submission) {
    let event = event(request, submission);
    for peer in others {
        incoming::accept(peer, &event);
    }
    author.coordinator().confirm(&event.receipt, NOW).unwrap();
    for peer in others {
        assert_eq!(incoming::secret(author), incoming::secret(peer));
    }
}

#[test]
fn rotation_is_exact_durable_outbox_until_exact_receipt() {
    let (alice, bob, _) = incoming::fixture(false);
    let request = change(&alice, "rotate", &["alice", "bob"], &[], vec![]);
    let before = incoming::secret(&alice);
    let (preview, consent) = alice.coordinator().preview_change(&request, NOW).unwrap();
    assert_eq!(incoming::secret(&alice), before);
    let submission = alice
        .coordinator()
        .prepare_change(&request, &consent, preview.fingerprint, NOW)
        .unwrap();
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    assert_eq!(incoming::secret(&alice), before);
    assert_eq!(
        bytes(&alice.reopened().retry("room", NOW).unwrap()),
        bytes(&submission)
    );
    assert_eq!(
        bytes(
            &alice
                .reopened()
                .prepare_change(&request, &consent, preview.fingerprint, NOW + 301)
                .unwrap()
        ),
        bytes(&submission)
    );
    assert_eq!(
        alice.coordinator().preview_change(&request, NOW).err(),
        Some(Error::Pending)
    );
    let mut bad = receipt(&submission);
    bad.fingerprint[0] ^= 1;
    assert_eq!(alice.coordinator().confirm(&bad, NOW), Err(Error::Receipt));
    let mut conflict = request.clone();
    conflict.operation = "another".into();
    assert!(
        alice
            .coordinator()
            .prepare_change(&conflict, &consent, preview.fingerprint, NOW)
            .is_err()
    );
    assert_eq!(
        bytes(&alice.reopened().retry("room", NOW).unwrap()),
        bytes(&submission)
    );
    finish(&alice, &[&bob], &request, &submission);
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(2));
    assert_eq!(
        alice.coordinator().pending_lookup("room").err(),
        Some(Error::NotReady)
    );
}

#[test]
fn add_then_remove_revoked_device_preserves_retained_refs_and_real_secrets() {
    let (alice, bob, _) = incoming::fixture(false);
    let carol = Account::new("carol", "carol-mobile", [4; 16]);
    for a in [&alice, &bob] {
        a.trust(&carol, true);
        carol.trust(a, true);
    }
    let request = change(
        &alice,
        "add-carol",
        &["alice", "bob", "carol"],
        &[],
        vec![carol.package()],
    );
    let submission = prepare_change(&alice, &request, NOW);
    let plan = Transition::from_bytes(&submission.transition).unwrap().plan;
    let old_ref = bob
        .manager
        .inspect(|_, records| {
            Ok(read(records, "room")
                .unwrap()
                .unwrap()
                .active
                .unwrap()
                .transition
                .plan
                .participants
                .into_iter()
                .find(|p| p.user == "bob")
                .unwrap()
                .key_package)
        })
        .unwrap();
    assert_eq!(
        plan.participants
            .iter()
            .find(|p| p.user == "bob")
            .unwrap()
            .key_package,
        old_ref
    );
    assert_eq!(submission.welcomes.len(), 1);
    admit(&carol, &request, &submission);
    finish(&alice, &[&bob], &request, &submission);
    assert_eq!(incoming::secret(&alice), incoming::secret(&carol));
    alice.revoke(&carol);
    bob.revoke(&carol);
    let remove = change(
        &alice,
        "remove-carol",
        &["alice", "bob"],
        &["carol-mobile"],
        vec![],
    );
    let removal = prepare_change(&alice, &remove, NOW);
    assert!(removal.welcomes.is_empty());
    finish(&alice, &[&bob], &remove, &removal);
    assert_ne!(incoming::secret(&alice), incoming::secret(&carol));
}

#[test]
fn unequal_removals_and_additions_are_one_real_transition() {
    let (alice, bob, carol) = incoming::fixture(true);
    let carol = carol.unwrap();
    let dave = Account::new("dave", "dave-new", [8; 16]);
    alice.trust(&dave, true);
    dave.trust(&alice, true);
    let request = change(
        &alice,
        "remove-two-add-one",
        &["alice", "dave"],
        &["bob-mobile", "carol-mobile"],
        vec![dave.package()],
    );
    let (preview, consent) = alice.coordinator().preview_change(&request, NOW).unwrap();
    let submission = alice
        .coordinator()
        .prepare_change(&request, &consent, preview.fingerprint, NOW)
        .unwrap();
    admit(&dave, &request, &submission);
    let mut reordered = request.clone();
    reordered.removals.reverse();
    assert_eq!(
        bytes(
            &alice
                .reopened()
                .prepare_change(&reordered, &consent, preview.fingerprint, NOW)
                .unwrap()
        ),
        bytes(&submission)
    );
    alice
        .coordinator()
        .confirm(&receipt(&submission), NOW)
        .unwrap();
    assert_eq!(incoming::secret(&alice), incoming::secret(&dave));
    assert_ne!(incoming::secret(&alice), incoming::secret(&bob));
    assert_ne!(incoming::secret(&alice), incoming::secret(&carol));
    let plan = Transition::from_bytes(&submission.transition).unwrap().plan;
    assert_eq!(plan.participants.len(), 2);
    assert_eq!(plan.welcomes.len(), 1);
}

#[test]
fn retained_or_own_nonce_change_requires_actual_fresh_admission() {
    let (alice, bob, _) = incoming::fixture(false);
    for user in ["alice", "bob"] {
        let mut request = change(&alice, "bad-nonce", &["alice", "bob"], &[], vec![]);
        request
            .roster
            .members
            .iter_mut()
            .find(|m| m.user == user)
            .unwrap()
            .access_version = "new-access".into();
        assert_eq!(
            alice.coordinator().preview_change(&request, NOW).err(),
            Some(Error::Changed)
        );
    }
    let mut request = change(
        &alice,
        "readmit-bob",
        &["alice", "bob"],
        &["bob-mobile"],
        vec![bob.package()],
    );
    request.roster.members[1].activation_version = "new-activation".into();
    let submission = prepare_change(&alice, &request, NOW);
    assert_eq!(submission.welcomes.len(), 1);
    // The old admitted engine needs the distinct tombstone/rejoin path.
    assert_eq!(
        bob.coordinator()
            .preview_commit(&event(&request, &submission), NOW)
            .err(),
        Some(Error::Changed)
    );
}

#[test]
fn preview_binds_head_roster_operation_packages_and_pins() {
    let (alice, bob, _) = incoming::fixture(false);
    let request = change(&alice, "rotate", &["alice", "bob"], &[], vec![]);
    let (preview, consent) = alice.coordinator().preview_change(&request, NOW).unwrap();
    for field in 0..5 {
        let mut changed = request.clone();
        match field {
            0 => changed.head.revision += 1,
            1 => changed.head.fingerprint[0] ^= 1,
            2 => changed.roster.authority_version = "changed".into(),
            3 => changed.operation = "other".into(),
            _ => changed.packages.push(bob.package()),
        }
        assert_eq!(
            alice
                .coordinator()
                .prepare_change(&changed, &consent, preview.fingerprint, NOW)
                .err(),
            Some(Error::Changed)
        );
    }
    assert_eq!(
        alice
            .coordinator()
            .prepare_change(&request, &consent, [0; 32], NOW)
            .err(),
        Some(Error::Changed)
    );
    assert_eq!(
        alice
            .coordinator()
            .prepare_change(&request, &consent, preview.fingerprint, NOW + 300)
            .err(),
        Some(Error::Changed)
    );
    alice.revoke(&bob);
    assert_eq!(
        alice
            .coordinator()
            .prepare_change(&request, &consent, preview.fingerprint, NOW)
            .err(),
        Some(Error::Changed)
    );
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    assert_eq!(
        alice.coordinator().pending_lookup("room").err(),
        Some(Error::NotReady)
    );
}

#[test]
fn stale_head_self_removal_unknown_duplicates_and_malformed_packages_are_refused() {
    let (alice, bob, _) = incoming::fixture(false);
    let base = change(&alice, "change", &["alice", "bob"], &[], vec![]);
    for case in 0..9 {
        let mut request = base.clone();
        match case {
            0 => request.head.revision += 1,
            1 => request.head.scope.data_epoch = "old".into(),
            2 => request.removals.push("alice-desktop".into()),
            3 => request.removals.push("unknown".into()),
            4 => request.removals = vec!["bob-mobile".into(), "bob-mobile".into()],
            5 => request.packages = vec![vec![1, 2, 3]],
            6 => request.packages = vec![bob.package()],
            7 => request.roster.members.reverse(),
            _ => request.roster.members.push(Member {
                user: "carol".into(),
                access_version: "access-carol".into(),
                activation_version: "activation-carol".into(),
            }),
        }
        assert!(
            alice.coordinator().preview_change(&request, NOW).is_err(),
            "case {case}"
        );
        assert_eq!(
            alice.coordinator().pending_lookup("room").err(),
            Some(Error::NotReady)
        );
    }
    let (preview, consent) = alice.coordinator().preview_change(&base, NOW).unwrap();
    assert!(
        alice
            .coordinator()
            .prepare_change(&base, &consent, preview.fingerprint, NOW)
            .is_ok()
    );
}

#[test]
fn new_devices_need_explicit_pins_and_original_spent_packages_cannot_be_readded() {
    let (alice, bob, _) = incoming::fixture(false);
    let carol = Account::new("carol", "carol-mobile", [4; 16]);
    let raw = carol.package();
    let request = change(
        &alice,
        "add",
        &["alice", "bob", "carol"],
        &[],
        vec![raw.clone()],
    );
    assert_eq!(
        alice.coordinator().preview_change(&request, NOW).err(),
        Some(Error::Identity(identity::Error::Untrusted))
    );
    alice.trust(&carol, false);
    assert_eq!(
        alice.coordinator().preview_change(&request, NOW).err(),
        Some(Error::Identity(identity::Error::Unapproved))
    );
    alice.trust(&carol, true);
    bob.trust(&carol, true);
    carol.trust(&alice, true);
    carol.trust(&bob, true);
    let mut duplicated = request.clone();
    duplicated.packages.push(raw.clone());
    assert_eq!(
        alice.coordinator().preview_change(&duplicated, NOW).err(),
        Some(Error::Changed)
    );
    let added = prepare_change(&alice, &request, NOW);
    admit(&carol, &request, &added);
    finish(&alice, &[&bob], &request, &added);
    let remove = change(
        &alice,
        "remove",
        &["alice", "bob"],
        &["carol-mobile"],
        vec![],
    );
    let removed = prepare_change(&alice, &remove, NOW);
    finish(&alice, &[&bob], &remove, &removed);
    let readd = change(&alice, "spent", &["alice", "bob", "carol"], &[], vec![raw]);
    assert_eq!(
        alice.reopened().preview_change(&readd, NOW).err(),
        Some(Error::Changed)
    );
}

#[test]
fn real_credential_renewal_updates_mls_leaf_and_peer_receives_it() {
    let (alice, bob, _) = incoming::fixture(false);
    assert_eq!(
        alice.coordinator().needs_credential_update("room", NOW),
        Ok(false)
    );
    let request = change(&alice, "renew", &["alice", "bob"], &[], vec![]);
    let (preview, consent) = alice.coordinator().preview_change(&request, NOW).unwrap();
    let renewed = alice
        .manager
        .transact(|_, records| {
            let issuer = Issuer::load(records, "instance", "alice").unwrap();
            let mut local =
                LocalDevice::load(&alice.root, &alice.manager.scope().device, records).unwrap();
            let request = local.request(NOW + 1, records).unwrap();
            let consent = issuer
                .preview_request(&request, NOW + 1, 7200, records)
                .unwrap();
            let grant = issuer
                .approve_request(&request, &consent, NOW + 1, records)
                .unwrap();
            local.install(&grant, NOW + 1, records).unwrap();
            Ok(grant.certificate)
        })
        .unwrap();
    assert_ne!(
        renewed.fingerprint().unwrap(),
        alice.certificate.fingerprint().unwrap()
    );
    assert_eq!(
        alice.coordinator().needs_credential_update("room", NOW + 1),
        Ok(true)
    );
    assert_eq!(
        alice
            .coordinator()
            .prepare_change(&request, &consent, preview.fingerprint, NOW + 1)
            .err(),
        Some(Error::Changed)
    );
    let submission = prepare_change(&alice, &request, NOW + 1);
    let transition = Transition::from_bytes(&submission.transition).unwrap();
    assert_eq!(transition.certificate, renewed);
    let event = event(&request, &submission);
    let (preview, consent) = bob.coordinator().preview_commit(&event, NOW + 1).unwrap();
    bob.coordinator()
        .accept_commit(&event, &consent, preview.fingerprint, NOW + 1)
        .unwrap();
    alice
        .coordinator()
        .confirm(&event.receipt, NOW + 1)
        .unwrap();
    assert_eq!(incoming::secret(&alice), incoming::secret(&bob));
    assert_eq!(
        alice.coordinator().needs_credential_update("room", NOW + 1),
        Ok(false)
    );
    assert_eq!(
        bob.coordinator().needs_credential_update("room", NOW + 1),
        Ok(false)
    );
    alice
        .manager
        .inspect(|provider, _| {
            let group = MlsGroup::load(
                provider.storage(),
                &GroupId::from_slice(&request.roster.scope.group_id().unwrap()),
            )
            .unwrap()
            .unwrap();
            let own = group
                .members()
                .find(|m| m.index == group.own_leaf_index())
                .unwrap();
            assert_eq!(
                Certificate::from_credential(&own.credential).unwrap(),
                renewed
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn lost_preparation_checkpoint_recovers_one_exact_pending_commit() {
    let (alice, bob, _) = incoming::fixture(false);
    let request = change(&alice, "interrupted", &["alice", "bob"], &[], vec![]);
    let (preview, consent) = alice.coordinator().preview_change(&request, NOW).unwrap();
    alice.keystore.fail_at.store(
        alice.keystore.writes.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    assert_eq!(
        alice
            .coordinator()
            .prepare_change(&request, &consent, preview.fingerprint, NOW)
            .err(),
        Some(Error::Storage(vault::Error::Storage))
    );
    let recovered = alice
        .reopened()
        .prepare_change(&request, &consent, preview.fingerprint, NOW)
        .unwrap();
    assert_eq!(
        bytes(&alice.reopened().retry("room", NOW).unwrap()),
        bytes(&recovered)
    );
    finish(&alice, &[&bob], &request, &recovered);
}

#[test]
fn expired_peers_require_explicit_remove_add_and_fresh_welcome_after_both_certificates_renew() {
    use super::application_messages as messages;
    let (alice, bob, _) = incoming::fixture(false);
    let later = NOW + 3601;
    let renew = |account: &Account| {
        account
            .manager
            .transact(|_, records| {
                let issuer = Issuer::load(records, "instance", &account.root.user).unwrap();
                let mut local =
                    LocalDevice::load(&account.root, &account.manager.scope().device, records)
                        .unwrap();
                let request = local.request(later, records).unwrap();
                let consent = issuer
                    .preview_request(&request, later, 7200, records)
                    .unwrap();
                let grant = issuer
                    .approve_request(&request, &consent, later, records)
                    .unwrap();
                local.install(&grant, later, records).unwrap();
                Ok(grant.certificate)
            })
            .unwrap()
    };
    let own = renew(&alice);
    let peer = renew(&bob);
    assert!(alice.certificate.verify(later).is_err() && bob.certificate.verify(later).is_err());
    assert_eq!(
        alice.coordinator().needs_credential_update("room", later),
        Ok(true)
    );
    let ordinary = change(&alice, "keep-expired-peer", &["alice", "bob"], &[], vec![]);
    assert!(
        alice
            .coordinator()
            .preview_change(&ordinary, later)
            .is_err()
    );
    let fresh = bob.package_at(later);
    let without_remove = change(
        &alice,
        "add-without-remove",
        &["alice", "bob"],
        &[],
        vec![fresh.clone()],
    );
    assert!(
        alice
            .coordinator()
            .preview_change(&without_remove, later)
            .is_err()
    );
    let replacement = change(
        &alice,
        "replace-renewed-peer",
        &["alice", "bob"],
        &["bob-mobile"],
        vec![fresh],
    );
    let before = incoming::secret(&bob);
    let submitted = prepare_change(&alice, &replacement, later);
    let plan = Transition::from_bytes(&submitted.transition).unwrap().plan;
    assert_eq!(
        plan.participants
            .iter()
            .find(|p| p.user == "alice")
            .unwrap()
            .certificate,
        own.fingerprint().unwrap()
    );
    assert_eq!(
        plan.participants
            .iter()
            .find(|p| p.user == "bob")
            .unwrap()
            .certificate,
        peer.fingerprint().unwrap()
    );
    assert_eq!(submitted.welcomes.len(), 1);
    assert_eq!(submitted.welcomes[0].device, "bob-mobile");
    assert!(
        bob.coordinator()
            .preview_commit(&event(&replacement, &submitted), later)
            .is_err()
    );
    let admission = admission::event(
        &Genesis {
            roster: replacement.roster.clone(),
            operation: replacement.operation.clone(),
            packages: vec![],
        },
        &submitted,
        "bob-mobile",
    );
    let (preview, consent) = bob
        .reopened()
        .preview_readmission(&admission, later)
        .unwrap();
    assert_eq!(
        incoming::secret(&bob),
        before,
        "preview must preserve the old group and package"
    );
    let mut wrong = admission.clone();
    wrong.welcome.payload[0] ^= 1;
    assert!(
        bob.reopened()
            .accept_readmission(&wrong, &consent, preview.fingerprint, later)
            .is_err()
    );
    assert_eq!(incoming::secret(&bob), before);
    bob.reopened()
        .accept_readmission(&admission, &consent, preview.fingerprint, later)
        .unwrap();
    alice
        .coordinator()
        .confirm(&receipt(&submitted), later)
        .unwrap();
    assert_eq!(incoming::secret(&alice), incoming::secret(&bob));
    assert_eq!(
        alice.coordinator().needs_credential_update("room", later),
        Ok(false)
    );
    assert_eq!(
        bob.coordinator().needs_credential_update("room", later),
        Ok(false)
    );
    assert!(
        bob.reopened()
            .preview_readmission(&admission, later)
            .is_err()
    );
    let message = messages::message("after-both-expired-renewals");
    let original = alice
        .coordinator()
        .prepare_message(&messages::observation(&alice), &message, later)
        .unwrap();
    let ack = messages::ack_at(&original, 100, later);
    alice.coordinator().confirm_message(&ack, later).unwrap();
    bob.reopened()
        .receive_message(&messages::observation(&bob), &original, &ack, later)
        .unwrap();
    let own_submission = bob
        .reopened()
        .prepare_message(
            &messages::observation(&bob),
            &messages::message("renewed-peer-replies"),
            later,
        )
        .unwrap();
    let peer_ack = messages::ack_at(&own_submission, 101, later);
    bob.coordinator().confirm_message(&peer_ack, later).unwrap();
    alice
        .reopened()
        .receive_message(
            &messages::observation(&alice),
            &own_submission,
            &peer_ack,
            later,
        )
        .unwrap();
}

#[test]
fn singleton_epoch_zero_rotates_then_admits_a_real_new_member() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let genesis = prepare(&alice.coordinator(), &request(vec![], &["alice"]));
    alice
        .coordinator()
        .confirm(&receipt(&genesis), NOW)
        .unwrap();
    assert_eq!(alice.coordinator().ready_epoch("room"), Ok(0));
    let rotate = change(&alice, "singleton-rotate", &["alice"], &[], vec![]);
    let rotated = prepare_change(&alice, &rotate, NOW);
    assert_eq!(receipt(&rotated).epoch, 1);
    alice
        .coordinator()
        .confirm(&receipt(&rotated), NOW)
        .unwrap();
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    alice.trust(&bob, true);
    bob.trust(&alice, true);
    let add = change(
        &alice,
        "add-after-rotate",
        &["alice", "bob"],
        &[],
        vec![bob.package()],
    );
    let added = prepare_change(&alice, &add, NOW);
    admit(&bob, &add, &added);
    alice.coordinator().confirm(&receipt(&added), NOW).unwrap();
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(2));
    assert_eq!(incoming::secret(&alice), incoming::secret(&bob));
}

#[test]
fn public_input_and_reference_history_are_bounded_without_mutating_group() {
    let (alice, _, _) = incoming::fixture(false);
    let base = change(&alice, "bounded", &["alice", "bob"], &[], vec![]);
    for case in 0..5 {
        let mut request = base.clone();
        match case {
            0 => request.operation = "x".repeat(129),
            1 => request.packages = vec![vec![0; PACKAGE_LIMIT + 1]],
            2 => request.removals = vec!["x".into(); public::MAX_DEVICES],
            3 => {
                request.roster.members =
                    vec![request.roster.members[0].clone(); public::MAX_MEMBERS + 1]
            }
            _ => request.head.operation = "x".repeat(129),
        }
        assert_eq!(
            alice.coordinator().preview_change(&request, NOW).err(),
            Some(Error::Limit)
        );
    }
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    let carol = Account::new("carol", "carol-mobile", [4; 16]);
    alice.trust(&carol, true);
    alice
        .manager
        .transact(|_, records| {
            let mut state = read(records, "room").unwrap().unwrap();
            for index in 0..(PACKAGE_HISTORY_LIMIT - 1) as u64 {
                let mut reference = [7; 32];
                reference[..8].copy_from_slice(&index.to_be_bytes());
                state.seen_packages.insert(reference);
            }
            save(records, &state).unwrap();
            Ok(())
        })
        .unwrap();
    let request = change(
        &alice,
        "history-full",
        &["alice", "bob", "carol"],
        &[],
        vec![carol.package()],
    );
    assert_eq!(
        alice.coordinator().preview_change(&request, NOW).err(),
        Some(Error::Limit)
    );
}
