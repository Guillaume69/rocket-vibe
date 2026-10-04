use super::*;
use openmls::prelude::LeafNodeParameters;

enum Change {
    Rotate,
    Add(Vec<u8>),
    Remove(String),
    Replace(String, Vec<u8>),
}
pub(super) fn fixture(third: bool) -> (Account, Account, Option<Account>) {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    alice.trust(&bob, true);
    bob.trust(&alice, true);
    let carol = third.then(|| Account::new("carol", "carol-mobile", [4; 16]));
    let mut packages = vec![bob.package()];
    let mut users = vec!["alice", "bob"];
    if let Some(carol) = &carol {
        for a in [&alice, &bob] {
            a.trust(carol, true);
            carol.trust(a, true)
        }
        packages.push(carol.package());
        users.push("carol");
    }
    let request = request(packages, &users);
    let submission = prepare(&alice.coordinator(), &request);
    for account in std::iter::once(&bob).chain(carol.as_ref()) {
        let admission = admission::event(&request, &submission, &account.certificate.device.device);
        admission::accept(account, &admission);
    }
    alice
        .coordinator()
        .confirm(&receipt(&submission), NOW)
        .unwrap();
    (alice, bob, carol)
}
// Build a true pending successor in the same protected provider. This fixture
// exercises receipt reconciliation and conflicts before the public preparation
// API for later transitions is connected to the transport.
fn successor(
    author: &Account,
    operation: &str,
    change: Change,
    alter: impl FnOnce(&mut Plan),
) -> Commit {
    let coordinator = author.coordinator();
    coordinator
        .transact(|provider, records| {
            let mut state = read(records, "room")?.unwrap();
            let active = state.active.as_ref().unwrap();
            let context = coordinator.context(records, NOW)?;
            let mut group = MlsGroup::load(
                provider.storage(),
                &GroupId::from_slice(&state.scope.group_id()?),
            )
            .unwrap()
            .unwrap();
            let mut plan = active.transition.plan.clone();
            plan.operation = operation.into();
            plan.expected_revision = active.receipt.revision;
            plan.expected_epoch = Some(active.receipt.epoch);
            plan.epoch = active.receipt.epoch + 1;
            plan.previous = active.receipt.fingerprint;
            plan.welcomes.clear();
            let (remove, package) = match &change {
                Change::Rotate => (None, None),
                Change::Add(bytes) => (None, Some(bytes)),
                Change::Remove(device) => (Some(device), None),
                Change::Replace(device, bytes) => (Some(device), Some(bytes)),
            };
            let removed = remove.map(|device| {
                group
                    .members()
                    .find(|m| {
                        Certificate::from_credential(&m.credential)
                            .unwrap()
                            .device
                            .device
                            == *device
                    })
                    .unwrap()
                    .index
            });
            if let Some(device) = remove {
                let user = plan
                    .participants
                    .iter()
                    .find(|p| p.device == *device)
                    .unwrap()
                    .user
                    .clone();
                plan.participants.retain(|p| p.device != *device);
                if !plan.participants.iter().any(|p| p.user == user) {
                    plan.members.retain(|m| m.user != user)
                };
            }
            let package = package.map(|bytes| {
                KeyPackageIn::tls_deserialize_exact(bytes)
                    .unwrap()
                    .validate(provider.crypto(), ProtocolVersion::Mls10)
                    .unwrap()
            });
            if let Some(package) = &package {
                let certificate = Certificate::from_credential(package.leaf_node().credential())?;
                let reference = package
                    .hash_ref(provider.crypto())
                    .unwrap()
                    .as_slice()
                    .try_into()
                    .unwrap();
                let user = certificate.device.root.user.clone();
                if !plan.members.iter().any(|m| m.user == user) {
                    plan.members.push(Member {
                        user: user.clone(),
                        access_version: format!("access-{user}"),
                        activation_version: format!("activation-{user}"),
                    });
                    plan.members.sort_by(|a, b| a.user.cmp(&b.user));
                }
                let leaf = removed
                    .map(|i| i.u32())
                    .unwrap_or_else(|| plan.participants.iter().map(|p| p.leaf).max().unwrap() + 1);
                plan.participants.push(Participant {
                    user,
                    device: certificate.device.device.clone(),
                    incarnation: certificate.device.incarnation,
                    root: certificate.device.root.fingerprint()?,
                    certificate: certificate.fingerprint()?,
                    leaf,
                    key_package: Some(reference),
                });
                plan.participants.sort_by_key(|p| p.leaf);
                plan.welcomes.push(public::Welcome {
                    device: certificate.device.device.clone(),
                    incarnation: certificate.device.incarnation,
                    key_package: reference,
                    digest: [1; 32],
                });
            }
            alter(&mut plan);
            group.set_aad(incoming::commit_aad(&plan)?);
            let (message, welcome, info) = match (removed, package) {
                (None, None) => group
                    .self_update(provider, &context.local, LeafNodeParameters::default())
                    .unwrap()
                    .into_messages(),
                (None, Some(package)) => {
                    let (commit, welcome, info) = group
                        .add_members(provider, &context.local, &[package])
                        .unwrap();
                    (commit, Some(welcome), info.map(Into::into))
                }
                (Some(removed), None) => {
                    let (commit, welcome, info) = group
                        .remove_members(provider, &context.local, &[removed])
                        .unwrap();
                    (commit, welcome, info.map(Into::into))
                }
                (Some(removed), Some(package)) => {
                    let messages = group
                        .swap_members(provider, &context.local, &[removed], &[package])
                        .unwrap();
                    (messages.commit, Some(messages.welcome), messages.group_info)
                }
            };
            let commit = message.to_bytes().unwrap();
            let info = info.unwrap().to_bytes().unwrap();
            let public = coordinator.public_group(provider, &group, Some(&info), &context.local)?;
            // Recover actual indices independently of the declared route.
            for member in public.members() {
                let cert = Certificate::from_credential(&member.credential)?;
                plan.participants
                    .iter_mut()
                    .find(|p| p.device == cert.device.device)
                    .unwrap()
                    .leaf = member.index.u32();
            }
            plan.participants.sort_by_key(|p| p.leaf);
            let tree = public
                .export_ratchet_tree()
                .tls_serialize_detached()
                .unwrap();
            plan.context = digest(&public.group_context().tls_serialize_detached().unwrap());
            plan.tree = digest(&tree);
            plan.commit = Some(digest(&commit));
            let welcome = welcome.map(|w| w.to_bytes().unwrap());
            if let Some(welcome) = &welcome {
                for declared in &mut plan.welcomes {
                    declared.digest = digest(welcome)
                }
            };
            let transition = Transition {
                certificate: context.certificate.clone(),
                signature: context.local.sign(&plan.signing_bytes()?).unwrap(),
                plan,
            };
            transition.verify(NOW)?;
            let receipt = Receipt {
                scope: state.scope.clone(),
                operation: operation.into(),
                revision: transition.plan.expected_revision + 1,
                epoch: transition.plan.epoch,
                fingerprint: transition.fingerprint()?,
            };
            let event = Commit {
                roster: Roster {
                    scope: state.scope.clone(),
                    authority_version: transition.plan.authority_version.clone(),
                    members: transition.plan.members.clone(),
                },
                receipt,
                transition: transition.to_bytes()?,
                commit: commit.clone(),
            };
            let welcomes = transition
                .plan
                .welcomes
                .iter()
                .map(|w| Welcome {
                    device: w.device.clone(),
                    incarnation: w.incarnation,
                    key_package: w.key_package,
                    payload: welcome.clone().unwrap(),
                })
                .collect();
            state.pending = Some(Pending {
                created: NOW,
                intent: [9; 32],
                pins: context.pins_fingerprint,
                own: context.certificate.fingerprint()?,
                submission: Submission {
                    scope: state.scope.clone(),
                    operation: operation.into(),
                    transition: event.transition.clone(),
                    commit: Some(commit),
                    tree,
                    welcomes,
                },
                group_info: Some(info),
            });
            save(records, &state)?;
            Ok(event)
        })
        .unwrap()
}
fn resign(author: &Account, event: &mut Commit, alter: impl FnOnce(&mut Transition)) {
    let mut transition = Transition::from_bytes(&event.transition).unwrap();
    alter(&mut transition);
    transition.certificate = author.certificate.clone();
    transition.signature = author
        .manager
        .inspect(|_, records| {
            let signer =
                LocalDevice::load(&author.root, &author.certificate.device.device, records)
                    .unwrap();
            Ok(signer
                .sign(&transition.plan.signing_bytes().unwrap())
                .unwrap())
        })
        .unwrap();
    transition.verify(NOW).unwrap();
    event.receipt = Receipt {
        scope: transition.plan.scope.clone(),
        operation: transition.plan.operation.clone(),
        revision: transition.plan.expected_revision + 1,
        epoch: transition.plan.epoch,
        fingerprint: transition.fingerprint().unwrap(),
    };
    event.roster = Roster {
        scope: transition.plan.scope.clone(),
        authority_version: transition.plan.authority_version.clone(),
        members: transition.plan.members.clone(),
    };
    event.transition = transition.to_bytes().unwrap();
}
pub(super) fn accept(account: &Account, event: &Commit) {
    let (preview, consent) = account.coordinator().preview_commit(event, NOW).unwrap();
    account
        .coordinator()
        .accept_commit(event, &consent, preview.fingerprint, NOW)
        .unwrap();
}
pub(super) fn secret(account: &Account) -> Vec<u8> {
    account
        .manager
        .inspect(|provider, _| {
            let group = MlsGroup::load(
                provider.storage(),
                &GroupId::from_slice(&request(vec![], &["alice"]).roster.scope.group_id().unwrap()),
            )
            .unwrap()
            .unwrap();
            Ok(group
                .export_secret(provider.crypto(), "commit-test", b"context", 32)
                .unwrap())
        })
        .unwrap()
}

#[test]
fn rotation_preview_spends_nothing_and_atomic_successor_survives_reopen() {
    let (alice, bob, _) = fixture(false);
    let event = successor(&alice, "rotate", Change::Rotate, |_| {});
    let before = secret(&bob);
    let (preview, consent) = bob.coordinator().preview_commit(&event, NOW).unwrap();
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(1));
    assert_eq!(secret(&bob), before);
    assert_eq!(
        bob.reopened()
            .preview_commit(&event, NOW)
            .unwrap()
            .0
            .fingerprint,
        preview.fingerprint
    );
    assert_eq!(
        bob.coordinator()
            .accept_commit(&event, &consent, [0; 32], NOW),
        Err(Error::Changed)
    );
    // Later preparation ACKs now reconcile even with an existing active group.
    alice.coordinator().confirm(&event.receipt, NOW).unwrap();
    bob.coordinator()
        .accept_commit(&event, &consent, preview.fingerprint, NOW)
        .unwrap();
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(2));
    assert_ne!(secret(&bob), before);
    assert_eq!(secret(&alice), secret(&bob));
    bob.reopened()
        .accept_commit(&event, &consent, preview.fingerprint, NOW + 1)
        .unwrap();
    assert!(bob.coordinator().preview_commit(&event, NOW + 1).is_err());
}

#[test]
fn real_add_and_remove_require_current_explicit_recipient_consent() {
    let (alice, bob, _) = fixture(false);
    let carol = Account::new("carol", "carol-mobile", [4; 16]);
    alice.trust(&carol, true);
    let event = successor(&alice, "add-carol", Change::Add(carol.package()), |_| {});
    assert!(matches!(
        bob.coordinator().preview_commit(&event, NOW),
        Err(Error::Identity(identity::Error::Untrusted))
    ));
    bob.trust(&carol, false);
    assert!(matches!(
        bob.coordinator().preview_commit(&event, NOW),
        Err(Error::Identity(identity::Error::Unapproved))
    ));
    bob.trust(&carol, true);
    accept(&bob, &event);
    alice.coordinator().confirm(&event.receipt, NOW).unwrap();
    assert_eq!(secret(&alice), secret(&bob));
    bob.revoke(&carol);
    let removed = successor(
        &alice,
        "remove-carol",
        Change::Remove("carol-mobile".into()),
        |_| {},
    );
    // A revoked leaf can be removed; it cannot obstruct the valid successor.
    accept(&bob, &removed);
    alice.coordinator().confirm(&removed.receipt, NOW).unwrap();
    assert_eq!(bob.coordinator().ready_epoch("room"), Ok(3));
    assert_eq!(secret(&alice), secret(&bob));
}

#[test]
fn valid_signed_false_tree_context_leaf_author_and_aad_are_rejected() {
    let (alice, bob, _) = fixture(false);
    let original = successor(&alice, "rotate", Change::Rotate, |_| {});
    let before = secret(&bob);
    for field in 0..7 {
        let mut event = original.clone();
        if field == 5 {
            resign(&bob, &mut event, |_| {})
        } else {
            resign(&alice, &mut event, |transition| match field {
                0 => transition.plan.context = [8; 32],
                1 => transition.plan.tree = [8; 32],
                2 => transition.plan.participants[1].leaf = 3,
                3 => transition.plan.operation = "other-operation".into(),
                4 => transition.plan.previous = [8; 32],
                _ => transition.plan.welcomes.push(public::Welcome {
                    device: "bob-mobile".into(),
                    incarnation: [2; 16],
                    key_package: transition.plan.participants[1].key_package.unwrap(),
                    digest: [8; 32],
                }),
            });
        }
        assert!(bob.coordinator().preview_commit(&event, NOW).is_err());
        assert_eq!(secret(&bob), before);
        assert_eq!(bob.reopened().ready_epoch("room"), Ok(1));
    }
    accept(&bob, &original);
    alice.coordinator().confirm(&original.receipt, NOW).unwrap();
    assert_eq!(secret(&alice), secret(&bob));
}

#[test]
fn a_claimed_add_reference_is_checked_against_the_actual_mls_proposal() {
    let (alice, bob, _) = fixture(false);
    let carol = Account::new("carol", "carol-mobile", [4; 16]);
    for account in [&alice, &bob] {
        account.trust(&carol, true)
    }
    let false_reference = successor(
        &alice,
        "false-reference",
        Change::Add(carol.package()),
        |plan| {
            plan.participants
                .iter_mut()
                .find(|p| p.device == "carol-mobile")
                .unwrap()
                .key_package = Some([8; 32]);
            plan.welcomes[0].key_package = [8; 32];
        },
    );
    // TLS, author signature, AAD and public proof agree; the Add's real RFC
    // reference does not. This must fail after staging and still roll back.
    assert_eq!(
        bob.coordinator()
            .preview_commit(&false_reference, NOW)
            .err(),
        Some(Error::Changed)
    );
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(1));
}

#[test]
fn changed_admission_nonces_require_real_replacement_and_own_rejoin_cannot_inherit() {
    let (alice, bob, carol) = fixture(true);
    let carol = carol.unwrap();
    let false_grant = successor(&alice, "false-grant", Change::Rotate, |plan| {
        plan.members
            .iter_mut()
            .find(|m| m.user == "carol")
            .unwrap()
            .activation_version = "reactivated".into();
    });
    assert_eq!(
        bob.coordinator().preview_commit(&false_grant, NOW).err(),
        Some(Error::Changed)
    );
    // Discard only the fixture's unsubmitted commit to prepare an independent
    // genuine remove+add with a fresh package for that changed grant.
    alice
        .manager
        .transact(|provider, records| {
            let mut state = read(records, "room").unwrap().unwrap();
            let mut group = MlsGroup::load(
                provider.storage(),
                &GroupId::from_slice(&state.scope.group_id().unwrap()),
            )
            .unwrap()
            .unwrap();
            group.clear_pending_commit(provider.storage()).unwrap();
            state.pending = None;
            save(records, &state).unwrap();
            Ok(())
        })
        .unwrap();
    let replacement = successor(
        &alice,
        "real-replacement",
        Change::Replace("carol-mobile".into(), carol.package()),
        |plan| {
            plan.members
                .iter_mut()
                .find(|m| m.user == "carol")
                .unwrap()
                .activation_version = "reactivated".into();
        },
    );
    accept(&bob, &replacement);
    alice
        .coordinator()
        .confirm(&replacement.receipt, NOW)
        .unwrap();
    assert_eq!(secret(&alice), secret(&bob));
    let changed_own = successor(&alice, "own-rejoin", Change::Rotate, |plan| {
        plan.members
            .iter_mut()
            .find(|m| m.user == "bob")
            .unwrap()
            .access_version = "rejoined".into();
    });
    assert_eq!(
        bob.coordinator().preview_commit(&changed_own, NOW).err(),
        Some(Error::Changed)
    );
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(2));
}

#[test]
fn accepted_peer_commit_supersedes_own_pending_only_after_validation_and_checkpoint() {
    let (alice, bob, _) = fixture(false);
    let incoming = successor(&alice, "alice-rotate", Change::Rotate, |_| {});
    let outgoing = successor(&bob, "bob-rotate", Change::Rotate, |_| {});
    let before = secret(&bob);
    let coordinator = bob.coordinator();
    let (preview, consent) = coordinator.preview_commit(&incoming, NOW).unwrap();
    assert_eq!(
        bob.reopened().pending_lookup("room").unwrap().operation,
        outgoing.receipt.operation
    );
    assert_eq!(secret(&bob), before);
    let mut corrupt = incoming.clone();
    corrupt.commit[0] ^= 1;
    let hash = digest(&corrupt.commit);
    resign(&alice, &mut corrupt, |transition| {
        transition.plan.commit = Some(hash)
    });
    assert!(coordinator.preview_commit(&corrupt, NOW).is_err());
    assert_eq!(
        bob.reopened().pending_lookup("room").unwrap().operation,
        outgoing.receipt.operation
    );
    // A late application refusal after a full MLS merge must restore both the
    // pending commit/outbox and the old private epoch, not just the metadata.
    let transition = Transition::from_bytes(&incoming.transition).unwrap();
    let rejected: Result<()> = coordinator.transact(|provider, records| {
        let state = read(records, "room")?.unwrap();
        let context = coordinator.context(records, NOW)?;
        coordinator.validate_commit(provider, &context, &state, &incoming, &transition, NOW)?;
        Err(Error::Changed)
    });
    assert_eq!(rejected, Err(Error::Changed));
    assert_eq!(secret(&bob), before);
    assert_eq!(
        bob.reopened().pending_lookup("room").unwrap().operation,
        outgoing.receipt.operation
    );
    coordinator
        .accept_commit(&incoming, &consent, preview.fingerprint, NOW)
        .unwrap();
    assert_eq!(
        coordinator
            .pending_lookup("room")
            .err()
            .map(|e| e == Error::NotReady),
        Some(true)
    );
    assert_eq!(
        coordinator.confirm(&outgoing.receipt, NOW),
        Err(Error::Receipt)
    );
    alice.coordinator().confirm(&incoming.receipt, NOW).unwrap();
    assert_eq!(secret(&alice), secret(&bob));
}

#[test]
fn own_delivered_pending_commit_uses_its_original_state_without_decrypting_own_ciphertext() {
    let (alice, bob, _) = fixture(false);
    let event = successor(&alice, "own-rotate", Change::Rotate, |_| {});
    let (preview, consent) = alice.coordinator().preview_commit(&event, NOW).unwrap();
    assert_eq!(alice.coordinator().ready_epoch("room"), Ok(1));
    alice
        .coordinator()
        .accept_commit(&event, &consent, preview.fingerprint, NOW)
        .unwrap();
    alice
        .coordinator()
        .confirm(&event.receipt, NOW + 1)
        .unwrap();
    accept(&bob, &event);
    assert_eq!(secret(&alice), secret(&bob));
}

#[test]
fn lost_successor_checkpoint_replays_exact_historical_acceptance_without_new_trust() {
    let (alice, bob, _) = fixture(false);
    let event = successor(&alice, "rotate", Change::Rotate, |_| {});
    let (preview, consent) = bob.coordinator().preview_commit(&event, NOW).unwrap();
    bob.keystore.fail_at.store(
        bob.keystore.writes.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    assert_eq!(
        bob.coordinator()
            .accept_commit(&event, &consent, preview.fingerprint, NOW),
        Err(Error::Storage(vault::Error::Storage))
    );
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(2));
    bob.revoke(&alice);
    bob.reopened()
        .accept_commit(&event, &consent, preview.fingerprint, NOW + 3600)
        .unwrap();
    assert!(
        bob.coordinator()
            .preview_commit(&event, NOW + 3600)
            .is_err()
    );
    alice
        .coordinator()
        .confirm(&event.receipt, NOW + 3600)
        .unwrap();
    assert_eq!(secret(&alice), secret(&bob));
}

#[test]
fn consent_receipt_scope_and_input_bounds_cannot_be_changed_before_acceptance() {
    let (alice, bob, _) = fixture(false);
    let event = successor(&alice, "rotate", Change::Rotate, |_| {});
    let (preview, consent) = bob.coordinator().preview_commit(&event, NOW).unwrap();
    for field in 0..5 {
        let mut changed = event.clone();
        match field {
            0 => changed.receipt.fingerprint = [8; 32],
            1 => changed.receipt.revision += 1,
            2 => changed.receipt.epoch += 1,
            3 => changed.receipt.scope.data_epoch = "restored".into(),
            _ => changed.roster.authority_version = "other-policy".into(),
        }
        assert!(
            bob.coordinator()
                .accept_commit(&changed, &consent, preview.fingerprint, NOW)
                .is_err()
        );
    }
    assert_eq!(
        bob.coordinator()
            .accept_commit(&event, &consent, preview.fingerprint, NOW + 300),
        Err(Error::Changed)
    );
    let carol = Account::new("carol", "carol-mobile", [4; 16]);
    bob.trust(&carol, true);
    assert_eq!(
        bob.coordinator()
            .accept_commit(&event, &consent, preview.fingerprint, NOW),
        Err(Error::Changed)
    );
    let mut oversized = event.clone();
    oversized.commit = vec![0; PAYLOAD_LIMIT + 1];
    assert_eq!(
        bob.coordinator().preview_commit(&oversized, NOW).err(),
        Some(Error::Limit)
    );
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(1));
    accept(&bob, &event);
}

#[test]
fn a_previously_accepted_package_cannot_be_added_again_after_its_leaf_was_removed() {
    let (alice, bob, _) = fixture(false);
    let carol = Account::new("carol", "carol-mobile", [4; 16]);
    for account in [&alice, &bob] {
        account.trust(&carol, true)
    }
    let original = carol.package();
    let added = successor(&alice, "first-add", Change::Add(original.clone()), |_| {});
    accept(&bob, &added);
    alice.coordinator().confirm(&added.receipt, NOW).unwrap();
    let removed = successor(
        &alice,
        "remove",
        Change::Remove("carol-mobile".into()),
        |_| {},
    );
    accept(&bob, &removed);
    alice.coordinator().confirm(&removed.receipt, NOW).unwrap();
    let reused = successor(&alice, "reuse-old-ref", Change::Add(original), |_| {});
    assert_eq!(
        bob.reopened().preview_commit(&reused, NOW).err(),
        Some(Error::Changed)
    );
    assert_eq!(bob.coordinator().ready_epoch("room"), Ok(3));
}

#[test]
fn an_application_ciphertext_cannot_be_accepted_as_a_commit_or_spend_its_ratchet() {
    use openmls::prelude::ProcessedMessageContent;
    let (alice, bob, _) = fixture(false);
    let mut event = successor(&alice, "rotate", Change::Rotate, |_| {});
    let plan = Transition::from_bytes(&event.transition).unwrap().plan;
    let application = alice
        .manager
        .inspect(|provider, records| {
            let local = LocalDevice::load(&alice.root, "alice-desktop", records).unwrap();
            let mut group = MlsGroup::load(
                provider.storage(),
                &GroupId::from_slice(&plan.scope.group_id().unwrap()),
            )
            .unwrap()
            .unwrap();
            group.set_aad(incoming::commit_aad(&plan).unwrap());
            Ok(group
                .create_message(provider, &local, b"private payload")
                .unwrap()
                .to_bytes()
                .unwrap())
        })
        .unwrap();
    event.commit = application.clone();
    let hash = digest(&application);
    resign(&alice, &mut event, |transition| {
        transition.plan.commit = Some(hash)
    });
    assert_eq!(
        bob.coordinator().preview_commit(&event, NOW).err(),
        Some(Error::Mls)
    );
    bob.manager
        .inspect(|provider, _| {
            let mut group = MlsGroup::load(
                provider.storage(),
                &GroupId::from_slice(&plan.scope.group_id().unwrap()),
            )
            .unwrap()
            .unwrap();
            let message = MlsMessageIn::tls_deserialize_exact(&application)
                .unwrap()
                .try_into_protocol_message()
                .unwrap();
            let processed = group.process_message(provider, message).unwrap();
            let ProcessedMessageContent::ApplicationMessage(message) = processed.into_content()
            else {
                panic!("application")
            };
            assert_eq!(message.into_bytes(), b"private payload");
            Ok(())
        })
        .unwrap();
    assert_eq!(bob.reopened().ready_epoch("room"), Ok(1));
}
