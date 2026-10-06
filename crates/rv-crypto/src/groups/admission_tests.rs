use super::*;

pub(super) fn event(request: &Genesis, submission: &Submission, device: &str) -> Admission {
    Admission {
        roster: request.roster.clone(),
        receipt: receipt(submission),
        transition: submission.transition.clone(),
        commit: submission.commit.clone(),
        welcome: submission
            .welcomes
            .iter()
            .find(|w| w.device == device)
            .unwrap()
            .clone(),
    }
}
fn fixture() -> (Account, Account, Submission, Admission) {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    alice.trust(&bob, true);
    bob.trust(&alice, true);
    let request = request(vec![bob.package()], &["alice", "bob"]);
    let submission = prepare(&alice.coordinator(), &request);
    let admission = event(&request, &submission, "bob-mobile");
    (alice, bob, submission, admission)
}
fn resign(author: &Account, admission: &mut Admission, change: impl FnOnce(&mut Transition)) {
    let mut transition = Transition::from_bytes(&admission.transition).unwrap();
    change(&mut transition);
    transition.certificate = author.certificate.clone();
    transition.signature = author
        .manager
        .inspect(|_, records| {
            let local =
                LocalDevice::load(&author.root, &author.manager.scope().device, records).unwrap();
            Ok(local
                .sign(&transition.plan.signing_bytes().unwrap())
                .unwrap())
        })
        .unwrap();
    transition.verify(NOW).unwrap();
    admission.receipt = Receipt {
        scope: transition.plan.scope.clone(),
        operation: transition.plan.operation.clone(),
        revision: transition.plan.expected_revision + 1,
        epoch: transition.plan.epoch,
        fingerprint: transition.fingerprint().unwrap(),
    };
    admission.transition = transition.to_bytes().unwrap();
}
pub(super) fn accept(bob: &Account, admission: &Admission) {
    let (preview, consent) = bob.coordinator().preview_admission(admission, NOW).unwrap();
    bob.coordinator()
        .accept_admission(admission, &consent, preview.fingerprint, NOW)
        .unwrap();
}
fn exporters_equal(alice: &Account, bob: &Account, admission: &Admission) {
    let id = GroupId::from_slice(&admission.roster.scope.group_id().unwrap());
    let secret = alice
        .manager
        .inspect(|provider, _| {
            let group = MlsGroup::load(provider.storage(), &id).unwrap().unwrap();
            Ok(group
                .export_secret(provider.crypto(), "admission-test", b"context", 32)
                .unwrap())
        })
        .unwrap();
    bob.manager
        .inspect(|provider, _| {
            let group = MlsGroup::load(provider.storage(), &id).unwrap().unwrap();
            assert_eq!(
                group
                    .export_secret(provider.crypto(), "admission-test", b"context", 32)
                    .unwrap(),
                secret
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn validated_preview_consumes_nothing_and_confirmed_join_survives_reopen() {
    let (alice, bob, submission, admission) = fixture();
    let coordinator = bob.coordinator();
    let (preview, consent) = coordinator.preview_admission(&admission, NOW).unwrap();
    assert_eq!(preview.recipients.len(), 2);
    assert_eq!(preview.recipients[1].device, "bob-mobile");
    assert_eq!(coordinator.ready_epoch("room"), Err(Error::NotReady));
    let (again, _) = bob.reopened().preview_admission(&admission, NOW).unwrap();
    assert_eq!(preview.fingerprint, again.fingerprint);
    assert_eq!(
        coordinator.accept_admission(&admission, &consent, [0; 32], NOW),
        Err(Error::Changed)
    );
    coordinator
        .accept_admission(&admission, &consent, preview.fingerprint, NOW)
        .unwrap();
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(1));
    assert_eq!(
        coordinator.pending_lookup("room").err(),
        Some(Error::NotReady)
    );
    coordinator
        .accept_admission(&admission, &consent, preview.fingerprint, NOW + 1)
        .unwrap();
    alice
        .coordinator()
        .confirm(&receipt(&submission), NOW)
        .unwrap();
    exporters_equal(&alice, &bob, &admission);
    // The receiver's private package really has been consumed exactly once.
    bob.manager
        .inspect(|provider, _| {
            let MlsMessageBodyIn::Welcome(welcome) =
                MlsMessageIn::tls_deserialize_exact(&admission.welcome.payload)
                    .unwrap()
                    .extract()
            else {
                panic!("Welcome")
            };
            assert!(
                ProcessedWelcome::new_from_welcome(
                    provider,
                    &MlsGroupJoinConfig::default(),
                    welcome
                )
                .is_err()
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn signed_metadata_cannot_substitute_the_actual_mls_context_tree_leaf_or_package() {
    let (alice, bob, _, admission) = fixture();
    for field in 0..6 {
        let mut changed = admission.clone();
        if field == 5 {
            changed.welcome.key_package[0] ^= 1;
        }
        let reference = changed.welcome.key_package;
        resign(&alice, &mut changed, |transition| match field {
            0 => transition.plan.context[0] ^= 1,
            1 => transition.plan.tree[0] ^= 1,
            2 => transition.plan.participants[1].certificate[0] ^= 1,
            3 => transition.plan.participants[1].root[0] ^= 1,
            4 => transition.plan.participants[1].leaf = 2,
            _ => {
                transition.plan.participants[1].key_package = Some(reference);
                transition.plan.welcomes[0].key_package = reference;
            }
        });
        assert_eq!(
            bob.coordinator()
                .preview_admission(&changed, NOW)
                .err()
                .map(|e| e == Error::Changed),
            Some(true)
        );
        assert_eq!(bob.coordinator().ready_epoch("room"), Err(Error::NotReady));
        // The failed crypto pass has rolled back private package consumption.
        bob.reopened().preview_admission(&admission, NOW).unwrap();
    }
    accept(&bob, &admission);
    assert_eq!(bob.coordinator().ready_epoch("room"), Ok(1));
}

#[test]
fn a_trusted_peer_cannot_claim_a_welcome_authored_by_another_mls_leaf() {
    let (_, bob, _, admission) = fixture();
    let mut changed = admission.clone();
    // The public signature is valid for an admitted leaf. The real MLS GroupInfo
    // signer remains Alice, so Bob's signed claim must not replace its author.
    resign(&bob, &mut changed, |_| ());
    assert_eq!(
        bob.coordinator()
            .preview_admission(&changed, NOW)
            .err()
            .map(|e| e == Error::Changed),
        Some(true)
    );
    accept(&bob, &admission);
}

#[test]
fn corrupt_welcome_with_a_valid_signed_digest_does_not_spend_the_private_package() {
    let (alice, bob, _, admission) = fixture();
    let mut changed = admission.clone();
    *changed.welcome.payload.last_mut().unwrap() ^= 1;
    let hash = digest(&changed.welcome.payload);
    resign(&alice, &mut changed, |t| t.plan.welcomes[0].digest = hash);
    assert_eq!(
        bob.coordinator()
            .preview_admission(&changed, NOW)
            .err()
            .map(|e| e == Error::Mls),
        Some(true)
    );
    accept(&bob, &admission);
}

#[test]
fn current_room_grants_receipt_and_actual_group_incarnation_are_required() {
    let (alice, bob, _, admission) = fixture();
    for field in 0..6 {
        let mut changed = admission.clone();
        match field {
            0 => changed.roster.members[1].access_version = "returned-member".into(),
            1 => changed.roster.members[1].activation_version = "reactivated-account".into(),
            2 => changed.roster.authority_version = "new-policy".into(),
            3 => changed.receipt.fingerprint[0] ^= 1,
            4 => changed.receipt.revision += 1,
            _ => {
                changed.roster.scope.incarnation[0] ^= 1;
                let scope = changed.roster.scope.clone();
                resign(&alice, &mut changed, |t| t.plan.scope = scope);
            }
        }
        assert!(bob.coordinator().preview_admission(&changed, NOW).is_err());
        bob.coordinator()
            .preview_admission(&admission, NOW)
            .unwrap();
    }
    let (preview, consent) = bob
        .coordinator()
        .preview_admission(&admission, NOW)
        .unwrap();
    assert_eq!(
        bob.coordinator()
            .accept_admission(&admission, &consent, preview.fingerprint, NOW + 300),
        Err(Error::Changed)
    );
    assert_eq!(bob.coordinator().ready_epoch("room"), Err(Error::NotReady));
    accept(&bob, &admission);
}

#[test]
fn every_mls_recipient_requires_local_root_and_device_consent() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    let charlie = Account::new("charlie", "charlie-desktop", [4; 16]);
    alice.trust(&bob, true);
    alice.trust(&charlie, true);
    bob.trust(&alice, true);
    let request = request(
        vec![charlie.package(), bob.package()],
        &["alice", "bob", "charlie"],
    );
    let submission = prepare(&alice.coordinator(), &request);
    let admission = event(&request, &submission, "bob-mobile");
    assert_eq!(
        bob.coordinator()
            .preview_admission(&admission, NOW)
            .err()
            .map(|e| e == Error::Identity(identity::Error::Untrusted)),
        Some(true)
    );
    bob.trust(&charlie, false);
    assert_eq!(
        bob.coordinator()
            .preview_admission(&admission, NOW)
            .err()
            .map(|e| e == Error::Identity(identity::Error::Unapproved)),
        Some(true)
    );
    bob.trust(&charlie, true);
    let (preview, consent) = bob
        .coordinator()
        .preview_admission(&admission, NOW)
        .unwrap();
    bob.revoke(&charlie);
    assert_eq!(
        bob.coordinator()
            .accept_admission(&admission, &consent, preview.fingerprint, NOW),
        Err(Error::Changed)
    );
    assert_eq!(
        bob.coordinator()
            .preview_admission(&admission, NOW)
            .err()
            .map(|e| e == Error::Identity(identity::Error::Revoked)),
        Some(true)
    );
    assert_eq!(bob.coordinator().ready_epoch("room"), Err(Error::NotReady));
}

#[test]
fn a_lost_join_checkpoint_recovers_consumption_and_exact_historical_acceptance() {
    let (alice, bob, submission, admission) = fixture();
    let (preview, consent) = bob
        .coordinator()
        .preview_admission(&admission, NOW)
        .unwrap();
    bob.keystore.fail_at.store(
        bob.keystore.writes.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    assert_eq!(
        bob.coordinator()
            .accept_admission(&admission, &consent, preview.fingerprint, NOW),
        Err(Error::Storage(vault::Error::Storage))
    );
    let reopened = bob.reopened();
    assert_eq!(reopened.ready_epoch("room"), Ok(1));
    bob.revoke(&alice);
    reopened
        .accept_admission(&admission, &consent, preview.fingerprint, NOW + 3600)
        .unwrap();
    alice
        .coordinator()
        .confirm(&receipt(&submission), NOW + 3600)
        .unwrap();
    exporters_equal(&alice, &bob, &admission);
    let mut changed = admission.clone();
    changed.welcome.payload[0] ^= 1;
    assert_eq!(
        reopened.accept_admission(&changed, &consent, preview.fingerprint, NOW + 3600),
        Err(Error::Changed)
    );
}

#[test]
fn a_late_application_refusal_rolls_back_consumption_and_the_created_group() {
    let (_, bob, _, admission) = fixture();
    let coordinator = bob.coordinator();
    let transition = Transition::from_bytes(&admission.transition).unwrap();
    let result: Result<()> = coordinator.transact(|provider, records| {
        let context = coordinator.context(records, NOW)?;
        coordinator.validate_admission(provider, &context, &admission, &transition, NOW)?;
        // Simulate an additional application check refusing after MLS has
        // consumed the package and written the full joined provider state.
        Err(Error::Changed)
    });
    assert_eq!(result, Err(Error::Changed));
    assert_eq!(bob.reopened().ready_epoch("room"), Err(Error::NotReady));
    accept(&bob, &admission);
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(1));
}
