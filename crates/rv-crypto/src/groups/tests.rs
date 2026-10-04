use super::*;
use crate::{identity::Issuer, protected::Storage, vault::Scope as VaultScope};
use openmls::prelude::{MlsGroupJoinConfig, StagedWelcome};
use std::{
    collections::BTreeMap,
    fs,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use zeroize::Zeroizing;

const NOW: u64 = 1_900_000_000;

#[derive(Default)]
struct Keystore {
    items: Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>,
    writes: AtomicUsize,
    fail_at: AtomicUsize,
}
impl Storage for Keystore {
    fn read(&self, name: &str) -> std::result::Result<Option<Zeroizing<Vec<u8>>>, vault::Error> {
        Ok(self
            .items
            .lock()
            .unwrap()
            .get(name)
            .map(|v| Zeroizing::new(v.to_vec())))
    }
    fn write(&self, name: &str, value: &[u8]) -> std::result::Result<(), vault::Error> {
        if self.writes.fetch_add(1, Ordering::SeqCst) + 1 == self.fail_at.load(Ordering::SeqCst) {
            return Err(vault::Error::Storage);
        }
        self.items
            .lock()
            .unwrap()
            .insert(name.into(), Zeroizing::new(value.to_vec()));
        Ok(())
    }
}
struct Account {
    directory: tempfile::TempDir,
    keystore: Arc<Keystore>,
    manager: Arc<Manager>,
    root: Root,
    certificate: Certificate,
}
impl Account {
    fn new(user: &str, device: &str, incarnation: [u8; 16]) -> Self {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let keystore = Arc::new(Keystore::default());
        let manager = Arc::new(
            Manager::new(
                directory.path().to_owned(),
                VaultScope {
                    instance: "instance".into(),
                    data_epoch: "epoch".into(),
                    user: user.into(),
                    device: device.into(),
                    incarnation: HEXLOWER.encode(&incarnation),
                },
                keystore.clone(),
            )
            .unwrap(),
        );
        manager.initialize().unwrap();
        let issuer = Issuer::generate("instance", user).unwrap();
        let root = issuer.root().clone();
        let certificate = manager
            .transact(|_, records| {
                issuer.save(records).unwrap();
                let mut local =
                    LocalDevice::create_bound(&root, device, incarnation, records).unwrap();
                let request = local.request(NOW, records).unwrap();
                let consent = issuer
                    .preview_request(&request, NOW, 3600, records)
                    .unwrap();
                let grant = issuer
                    .approve_request(&request, &consent, NOW, records)
                    .unwrap();
                local.install(&grant, NOW, records).unwrap();
                Ok(grant.certificate)
            })
            .unwrap();
        Self {
            directory,
            keystore,
            manager,
            root,
            certificate,
        }
    }
    fn coordinator(&self) -> Coordinator {
        Coordinator::new(self.manager.clone(), self.root.clone()).unwrap()
    }
    fn reopened(&self) -> Coordinator {
        let manager = Arc::new(
            Manager::new(
                self.directory.path().to_owned(),
                self.manager.scope().clone(),
                self.keystore.clone(),
            )
            .unwrap(),
        );
        Coordinator::new(manager, self.root.clone()).unwrap()
    }
    fn package(&self) -> Vec<u8> {
        self.manager
            .transact(|provider, records| {
                let local =
                    LocalDevice::load(&self.root, &self.manager.scope().device, records).unwrap();
                let package = KeyPackage::builder()
                    .build(SUITE, provider, &local, local.credential(NOW).unwrap())
                    .unwrap();
                Ok(package.key_package().tls_serialize_detached().unwrap())
            })
            .unwrap()
    }
    fn trust(&self, peer: &Account, device: bool) {
        self.manager
            .transact(|_, records| {
                let mut pins = Pins::load(records, "instance").unwrap();
                pins.accept_first(peer.root.clone(), peer.root.fingerprint().unwrap())
                    .unwrap();
                if device {
                    let consent = pins.preview_device(&peer.certificate, NOW).unwrap();
                    pins.approve(&peer.certificate, &consent, NOW).unwrap();
                }
                pins.save(records).unwrap();
                Ok(())
            })
            .unwrap();
    }
    fn revoke(&self, peer: &Account) {
        let revocation = peer
            .manager
            .inspect(|_, records| {
                let issuer = Issuer::load(records, "instance", &peer.root.user).unwrap();
                Ok(issuer
                    .revoke(
                        &peer.certificate.device.device,
                        peer.certificate.device.incarnation,
                    )
                    .unwrap())
            })
            .unwrap();
        self.manager
            .transact(|_, records| {
                let mut pins = Pins::load(records, "instance").unwrap();
                pins.apply_revocation(&revocation).unwrap();
                pins.save(records).unwrap();
                Ok(())
            })
            .unwrap();
    }
}
fn request(packages: Vec<Vec<u8>>, users: &[&str]) -> Genesis {
    Genesis {
        roster: Roster {
            scope: Scope {
                instance: "instance".into(),
                data_epoch: "epoch".into(),
                room: "room".into(),
                incarnation: [3; 16],
            },
            authority_version: "authority".into(),
            members: users
                .iter()
                .map(|u| Member {
                    user: (*u).into(),
                    access_version: format!("access-{u}"),
                    activation_version: format!("activation-{u}"),
                })
                .collect(),
        },
        operation: "create-group".into(),
        packages,
    }
}
fn receipt(submission: &Submission) -> Receipt {
    let transition = Transition::from_bytes(&submission.transition).unwrap();
    Receipt {
        scope: submission.scope.clone(),
        operation: submission.operation.clone(),
        revision: transition.plan.expected_revision + 1,
        epoch: transition.plan.epoch,
        fingerprint: transition.fingerprint().unwrap(),
    }
}
fn bytes(submission: &Submission) -> Vec<u8> {
    serde_json::to_vec(submission).unwrap()
}
fn prepare(coordinator: &Coordinator, request: &Genesis) -> Submission {
    let (preview, consent) = coordinator.preview_genesis(request, NOW).unwrap();
    coordinator
        .prepare_genesis(request, &consent, preview.fingerprint, NOW)
        .unwrap()
}

#[test]
fn real_welcome_retry_and_ack_keep_the_same_mls_group_after_reopening() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    alice.trust(&bob, true);
    let request = request(vec![bob.package()], &["alice", "bob"]);
    let coordinator = alice.coordinator();
    let submission = prepare(&coordinator, &request);
    assert_eq!(coordinator.ready_epoch("room"), Err(Error::NotReady));
    let id = GroupId::from_slice(&request.roster.scope.group_id().unwrap());
    alice
        .manager
        .inspect(|provider, _| {
            let group = MlsGroup::load(provider.storage(), &id).unwrap().unwrap();
            assert_eq!(group.epoch().as_u64(), 0);
            assert!(group.pending_commit().is_some());
            Ok(())
        })
        .unwrap();
    let transition = Transition::from_bytes(&submission.transition).unwrap();
    transition.verify(NOW).unwrap();
    assert_eq!(transition.plan.participants.len(), 2);
    assert_eq!(transition.plan.participants[1].device, "bob-mobile");
    // A separate protected vault consumes its real private KeyPackage material.
    bob.manager
        .transact(|provider, _| {
            let MlsMessageBodyIn::Welcome(welcome) =
                MlsMessageIn::tls_deserialize_exact(&submission.welcomes[0].payload)
                    .unwrap()
                    .extract()
            else {
                panic!("Welcome")
            };
            let group = StagedWelcome::new_from_welcome(
                provider,
                &MlsGroupJoinConfig::default(),
                welcome,
                None,
            )
            .unwrap()
            .into_group(provider)
            .unwrap();
            check_actual(group.public_group(), &transition.plan).unwrap();
            assert_eq!(group.members().count(), 2);
            Ok(())
        })
        .unwrap();
    drop(coordinator);
    let reopened = alice.reopened();
    assert_eq!(
        bytes(&reopened.retry("room", NOW + 1).unwrap()),
        bytes(&submission)
    );
    assert_eq!(
        reopened.pending_lookup("room").unwrap().fingerprint,
        transition.fingerprint().unwrap()
    );
    reopened.confirm(&receipt(&submission), NOW + 1).unwrap();
    reopened.confirm(&receipt(&submission), NOW + 2).unwrap();
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(1));
    assert_eq!(reopened.retry("room", NOW + 2).err(), Some(Error::NotReady));
    // Matching exporter material proves both sides hold the same epoch secrets.
    let secret = alice
        .manager
        .inspect(|provider, _| {
            let group = MlsGroup::load(provider.storage(), &id).unwrap().unwrap();
            Ok(group
                .export_secret(provider.crypto(), "group-test", b"context", 32)
                .unwrap())
        })
        .unwrap();
    bob.manager
        .inspect(|provider, _| {
            let group = MlsGroup::load(provider.storage(), &id).unwrap().unwrap();
            assert_eq!(
                group
                    .export_secret(provider.crypto(), "group-test", b"context", 32)
                    .unwrap(),
                secret
            );
            Ok(())
        })
        .unwrap();
    for path in fs::read_dir(alice.directory.path()).unwrap() {
        let path = path.unwrap().path();
        if path.extension().is_some_and(|e| e == "sqlite") {
            let database = fs::read(path).unwrap();
            for private in [b"crypto-group-v1/room".as_slice(), secret.as_slice()] {
                assert!(!database.windows(private.len()).any(|w| w == private));
            }
        }
    }
}

#[test]
fn every_receipt_binding_is_checked_before_merging_the_pending_commit() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    alice.trust(&bob, true);
    let coordinator = alice.coordinator();
    let submission = prepare(
        &coordinator,
        &request(vec![bob.package()], &["alice", "bob"]),
    );
    let original = receipt(&submission);
    for field in 0..6 {
        let mut changed = original.clone();
        match field {
            0 => changed.scope.incarnation[0] ^= 1,
            1 => changed.operation = "other-operation".into(),
            2 => changed.revision += 1,
            3 => changed.epoch += 1,
            4 => changed.fingerprint[0] ^= 1,
            _ => changed.scope.data_epoch = "restored-epoch".into(),
        }
        assert!(coordinator.confirm(&changed, NOW + 1).is_err());
        assert_eq!(coordinator.ready_epoch("room"), Err(Error::NotReady));
        assert_eq!(
            bytes(&coordinator.retry("room", NOW + 1).unwrap()),
            bytes(&submission)
        );
    }
    coordinator.confirm(&original, NOW + 1).unwrap();
    assert_eq!(coordinator.ready_epoch("room"), Ok(1));
}

#[test]
fn failed_protected_checkpoint_hides_output_and_recovers_the_original_submission() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    alice.trust(&bob, true);
    let coordinator = alice.coordinator();
    let request = request(vec![bob.package()], &["alice", "bob"]);
    let (preview, consent) = coordinator.preview_genesis(&request, NOW).unwrap();
    alice.keystore.fail_at.store(
        alice.keystore.writes.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    assert_eq!(
        coordinator
            .prepare_genesis(&request, &consent, preview.fingerprint, NOW)
            .err(),
        Some(Error::Storage(vault::Error::Storage))
    );
    let recovered = alice.reopened().retry("room", NOW + 1).unwrap();
    assert_eq!(
        bytes(
            &coordinator
                .prepare_genesis(&request, &consent, preview.fingerprint, NOW + 1)
                .unwrap()
        ),
        bytes(&recovered)
    );
    alice
        .reopened()
        .confirm(&receipt(&recovered), NOW + 1)
        .unwrap();
    assert_eq!(coordinator.ready_epoch("room"), Ok(1));
}

#[test]
fn consent_is_invalidated_by_request_trust_and_deadline_changes() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    alice.trust(&bob, true);
    let coordinator = alice.coordinator();
    let mut request = request(vec![bob.package()], &["alice", "bob"]);
    let (preview, consent) = coordinator.preview_genesis(&request, NOW).unwrap();
    assert_eq!(
        coordinator
            .prepare_genesis(&request, &consent, [0; 32], NOW)
            .err(),
        Some(Error::Changed)
    );
    request.roster.members[1].access_version = "returned-member".into();
    assert_eq!(
        coordinator
            .prepare_genesis(&request, &consent, preview.fingerprint, NOW)
            .err(),
        Some(Error::Changed)
    );
    request.roster.members[1].access_version = "access-bob".into();
    assert_eq!(
        coordinator
            .prepare_genesis(&request, &consent, preview.fingerprint, NOW + 300)
            .err(),
        Some(Error::Changed)
    );
    alice
        .manager
        .transact(|_, records| {
            let mut pins = Pins::load(records, "instance").unwrap();
            pins.verify_root(&bob.root, bob.root.fingerprint().unwrap())
                .unwrap();
            pins.save(records).unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(
        coordinator
            .prepare_genesis(&request, &consent, preview.fingerprint, NOW)
            .err(),
        Some(Error::Changed)
    );
    assert_eq!(
        coordinator.pending_lookup("room").err(),
        Some(Error::NotReady)
    );
    let fresh = prepare(&coordinator, &request);
    assert_eq!(
        bytes(&coordinator.retry("room", NOW).unwrap()),
        bytes(&fresh)
    );
}

#[test]
fn unknown_unapproved_revoked_and_altered_key_packages_are_refused() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    let coordinator = alice.coordinator();
    let mut request = request(vec![bob.package()], &["alice", "bob"]);
    assert_eq!(
        coordinator
            .preview_genesis(&request, NOW)
            .err()
            .map(|e| e == Error::Identity(identity::Error::Untrusted)),
        Some(true)
    );
    alice.trust(&bob, false);
    assert_eq!(
        coordinator
            .preview_genesis(&request, NOW)
            .err()
            .map(|e| e == Error::Identity(identity::Error::Unapproved)),
        Some(true)
    );
    alice.trust(&bob, true);
    coordinator.preview_genesis(&request, NOW).unwrap();
    let original = request.packages[0].clone();
    *request.packages[0].last_mut().unwrap() ^= 1;
    assert_eq!(
        coordinator
            .preview_genesis(&request, NOW)
            .err()
            .map(|e| e == Error::Mls),
        Some(true)
    );
    request.packages[0] = original;
    alice.revoke(&bob);
    assert_eq!(
        coordinator
            .preview_genesis(&request, NOW)
            .err()
            .map(|e| e == Error::Identity(identity::Error::Revoked)),
        Some(true)
    );
    assert_eq!(
        coordinator.pending_lookup("room").err(),
        Some(Error::NotReady)
    );
}

#[test]
fn changed_trust_or_expiry_blocks_retry_but_preserves_receipt_reconciliation() {
    for revoke in [false, true] {
        let alice = Account::new("alice", "alice-desktop", [1; 16]);
        let bob = Account::new("bob", "bob-mobile", [2; 16]);
        alice.trust(&bob, true);
        let coordinator = alice.coordinator();
        let submission = prepare(
            &coordinator,
            &request(vec![bob.package()], &["alice", "bob"]),
        );
        let now = if revoke {
            alice.revoke(&bob);
            NOW + 1
        } else {
            NOW + 3600
        };
        assert!(coordinator.retry("room", now).is_err());
        assert_eq!(
            coordinator.pending_lookup("room").unwrap().fingerprint,
            receipt(&submission).fingerprint
        );
        coordinator.confirm(&receipt(&submission), now).unwrap();
        // Readiness is a diagnostic, not permission to encrypt with expired trust.
        assert_eq!(coordinator.ready_epoch("room"), Ok(1));
        assert_eq!(
            coordinator.confirm(&receipt(&submission), NOW).err(),
            Some(Error::Changed)
        );
    }
}

#[test]
fn scope_and_roster_errors_never_create_a_private_group_and_singleton_ack_is_valid() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let coordinator = alice.coordinator();
    let mut request = request(vec![], &["alice"]);
    for field in 0..4 {
        let original = request.roster.clone();
        match field {
            0 => request.roster.scope.instance = "other-instance".into(),
            1 => request.roster.scope.data_epoch = "restored-epoch".into(),
            2 => request.roster.members.push(Member {
                user: "bob".into(),
                access_version: "access".into(),
                activation_version: "active".into(),
            }),
            _ => request.roster.scope.incarnation = [0; 16],
        }
        assert!(coordinator.preview_genesis(&request, NOW).is_err());
        request.roster = original;
    }
    let submission = prepare(&coordinator, &request);
    assert!(submission.commit.is_none());
    assert!(submission.welcomes.is_empty());
    assert_eq!(
        bytes(&alice.reopened().retry("room", NOW).unwrap()),
        bytes(&submission)
    );
    coordinator.confirm(&receipt(&submission), NOW).unwrap();
    assert_eq!(alice.reopened().ready_epoch("room"), Ok(0));
    assert!(coordinator.preview_genesis(&request, NOW).is_err());
}

#[test]
fn vault_scope_is_bound_to_the_exact_local_incarnation_and_credential_key() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let root = alice.root.clone();
    alice
        .manager
        .transact(|_, records| {
            let mut local =
                serde_json::from_slice::<serde_json::Value>(&records["crypto-device-v1"]).unwrap();
            local["incarnation"] = serde_json::json!(vec![2; 16]);
            // This fixture attempts an authenticated record substitution. Loading also
            // checks the certificate/request binding, so it must fail before signing.
            records.insert(
                "crypto-device-v1".into(),
                serde_json::to_vec(&local).unwrap(),
            );
            Ok(())
        })
        .unwrap();
    assert!(
        alice
            .coordinator()
            .preview_genesis(&request(vec![], &["alice"]), NOW)
            .is_err()
    );
    let mut records = Records::new();
    assert_eq!(
        LocalDevice::create_bound(&root, "new", [0; 16], &mut records)
            .err()
            .map(|e| e == identity::Error::Scope),
        Some(true)
    );
    assert!(records.is_empty());
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    let mut pins = Pins::new("instance").unwrap();
    pins.accept_first(bob.root.clone(), bob.root.fingerprint().unwrap())
        .unwrap();
    let consent = pins.preview_device(&bob.certificate, NOW).unwrap();
    pins.approve(&bob.certificate, &consent, NOW).unwrap();
    let credential = bob.certificate.credential().unwrap();
    pins.authorize_credential(&credential, &bob.certificate.device.signature_key, NOW)
        .unwrap();
    assert_eq!(
        pins.authorize_credential(&credential, &[0; 32], NOW)
            .err()
            .map(|e| e == identity::Error::Signature),
        Some(true)
    );
}

#[test]
fn oversized_observations_are_refused_before_intent_serialization() {
    let mut request = request(vec![], &["alice"]);
    request.operation = "a".repeat(129);
    assert_eq!(request_fingerprint(&request), Err(Error::Limit));
    request.operation = "create-group".into();
    request.roster.members[0].access_version = "a".repeat(129);
    assert_eq!(request_fingerprint(&request), Err(Error::Limit));
    request.roster.members[0].access_version = "access-alice".into();
    request.packages.push(vec![1; PACKAGE_LIMIT + 1]);
    assert_eq!(request_fingerprint(&request), Err(Error::Limit));
    request.packages.clear();
    request.roster.members = vec![request.roster.members[0].clone(); public::MAX_MEMBERS + 1];
    assert_eq!(request_fingerprint(&request), Err(Error::Limit));
}

#[path = "admission_tests.rs"]
mod admission;

#[path = "message_tests.rs"]
mod application_messages;
#[path = "changes_tests.rs"]
mod changes;
#[cfg(feature = "native-http")]
#[path = "delivery_tests.rs"]
mod delivery_tests;
#[path = "settlement_tests.rs"]
mod group_settlement;
#[path = "incoming_tests.rs"]
mod incoming_commits;
#[path = "journal_tests.rs"]
mod journal_tests;
#[path = "wire_tests.rs"]
mod wire_tests;
