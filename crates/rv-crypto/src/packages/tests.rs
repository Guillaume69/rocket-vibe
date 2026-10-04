use super::*;
use crate::{
    groups::{self, Admission, Genesis, Roster},
    identity::Issuer,
    protected::Storage,
};
use openmls::prelude::{KeyPackageIn, ProtocolVersion, tls_codec::Deserialize as _};
use rv_crypto_public::groups::{Member, Scope as GroupScope, Transition};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::fs;
use std::{
    collections::BTreeMap,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

#[derive(Default)]
struct Keystore {
    values: Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>,
    writes: AtomicUsize,
    fail_at: AtomicUsize,
}
impl Storage for Keystore {
    fn read(&self, name: &str) -> std::result::Result<Option<Zeroizing<Vec<u8>>>, vault::Error> {
        Ok(self
            .values
            .lock()
            .unwrap()
            .get(name)
            .map(|b| Zeroizing::new(b.to_vec())))
    }
    fn write(&self, name: &str, bytes: &[u8]) -> std::result::Result<(), vault::Error> {
        if self.writes.fetch_add(1, Ordering::SeqCst) + 1 == self.fail_at.load(Ordering::SeqCst) {
            return Err(vault::Error::Storage);
        }
        self.values
            .lock()
            .unwrap()
            .insert(name.into(), Zeroizing::new(bytes.to_vec()));
        Ok(())
    }
}
fn now() -> u64 {
    // Every fixture shares one actual wall-clock reference, even when key
    // generation crosses a second between the creator and joining accounts.
    static NOW: OnceLock<u64> = OnceLock::new();
    *NOW.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    })
}
struct Account {
    directory: tempfile::TempDir,
    manager: Arc<Manager>,
    keystore: Arc<Keystore>,
    root: Root,
    certificate: Certificate,
    now: u64,
}
impl Account {
    fn new(user: &str, device: &str, incarnation: [u8; 16]) -> Self {
        let now = now();
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let keystore = Arc::new(Keystore::default());
        let manager = Arc::new(
            Manager::new(
                directory.path().into(),
                vault::Scope {
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
                let request = local.request(now, records).unwrap();
                let consent = issuer
                    .preview_request(&request, now, 3600, records)
                    .unwrap();
                let grant = issuer
                    .approve_request(&request, &consent, now, records)
                    .unwrap();
                local.install(&grant, now, records).unwrap();
                Ok(grant.certificate)
            })
            .unwrap();
        Self {
            directory,
            manager,
            keystore,
            root,
            certificate,
            now,
        }
    }
    fn coordinator(&self) -> Coordinator {
        Coordinator::new(self.manager.clone(), self.root.clone()).unwrap()
    }
    fn reopened(&self) -> Coordinator {
        Coordinator::new(
            Arc::new(
                Manager::new(
                    self.directory.path().into(),
                    self.manager.scope().clone(),
                    self.keystore.clone(),
                )
                .unwrap(),
            ),
            self.root.clone(),
        )
        .unwrap()
    }
    fn trust(&self, peer: &Self) {
        self.manager
            .transact(|_, records| {
                let mut pins = Pins::load(records, "instance").unwrap();
                pins.accept_first(peer.root.clone(), peer.root.fingerprint().unwrap())
                    .unwrap();
                let consent = pins.preview_device(&peer.certificate, self.now).unwrap();
                pins.approve(&peer.certificate, &consent, self.now).unwrap();
                pins.save(records).unwrap();
                Ok(())
            })
            .unwrap();
    }
    fn revoke_self(&self) {
        self.trust(self);
        self.manager
            .transact(|_, records| {
                let issuer = Issuer::load(records, "instance", &self.root.user).unwrap();
                let mut pins = Pins::load(records, "instance").unwrap();
                pins.apply_revocation(
                    &issuer
                        .revoke(
                            &self.certificate.device.device,
                            self.certificate.device.incarnation,
                        )
                        .unwrap(),
                )
                .unwrap();
                pins.save(records).unwrap();
                Ok(())
            })
            .unwrap();
    }
}
fn bytes(request: &PublishKeyPackages) -> Vec<u8> {
    serde_json::to_vec(request).unwrap()
}
fn stored(account: &Account) -> Vec<u8> {
    account
        .manager
        .inspect(|_, records| Ok(records.get(RECORD).cloned().unwrap_or_default()))
        .unwrap()
}
// Synthetic server ACK for unit coverage. Public lookup intentionally exposes
// only routing metadata; production obtains this DTO from authenticated HTTP.
fn expected(account: &Account) -> OperationReceipt {
    account
        .manager
        .inspect(|_, records| {
            let state: State = serde_json::from_slice(records.get(RECORD).unwrap()).unwrap();
            Ok(state.pending.unwrap().expected)
        })
        .unwrap()
}
fn lookup_matches(lookup: &PendingLookup, receipt: &OperationReceipt) -> bool {
    lookup.scope.instance_id == receipt.scope.instance_id
        && lookup.scope.data_epoch == receipt.scope.data_epoch
        && lookup.operation_id == receipt.operation_id
}
fn admitted(alice: &Account, bob: &Account, wire: &str) -> (groups::Coordinator, Admission) {
    alice.trust(bob);
    bob.trust(alice);
    let roster = Roster {
        scope: GroupScope {
            instance: "instance".into(),
            data_epoch: "epoch".into(),
            room: "room".into(),
            incarnation: [9; 16],
        },
        authority_version: "authority".into(),
        members: ["alice", "bob"]
            .into_iter()
            .map(|user| Member {
                user: user.into(),
                access_version: format!("access-{user}"),
                activation_version: format!("activation-{user}"),
            })
            .collect(),
    };
    let request = Genesis {
        roster: roster.clone(),
        operation: "genesis".into(),
        packages: vec![B64.decode(wire.as_bytes()).unwrap()],
    };
    let coordinator = groups::Coordinator::new(alice.manager.clone(), alice.root.clone()).unwrap();
    let (preview, consent) = coordinator.preview_genesis(&request, alice.now).unwrap();
    let submission = coordinator
        .prepare_genesis(&request, &consent, preview.fingerprint, alice.now)
        .unwrap();
    let transition = Transition::from_bytes(&submission.transition).unwrap();
    let receipt = groups::Receipt {
        scope: submission.scope.clone(),
        operation: submission.operation.clone(),
        revision: 1,
        epoch: 1,
        fingerprint: transition.fingerprint().unwrap(),
    };
    let admission = Admission {
        roster,
        receipt,
        transition: submission.transition,
        commit: submission.commit,
        welcome: submission.welcomes[0].clone(),
    };
    (coordinator, admission)
}
fn join(bob: &Account, admission: &Admission) {
    let coordinator = groups::Coordinator::new(bob.manager.clone(), bob.root.clone()).unwrap();
    let (preview, consent) = coordinator.preview_admission(admission, bob.now).unwrap();
    coordinator
        .accept_admission(admission, &consent, preview.fingerprint, bob.now)
        .unwrap();
}

#[test]
fn original_http_dto_and_real_private_packages_survive_reopen() {
    let account = Account::new("bob", "bob-mobile", [2; 16]);
    let coordinator = account.coordinator();
    let request = coordinator
        .prepare("9007199254740993", 2, account.now)
        .unwrap();
    assert_eq!(
        bytes(&account.reopened().retry(account.now + 1).unwrap()),
        bytes(&request)
    );
    assert_eq!(
        bytes(
            &coordinator
                .prepare("9007199254740993", 2, account.now + 1)
                .unwrap()
        ),
        bytes(&request)
    );
    let expected = expected(&account);
    assert_eq!(expected.device_revision, "9007199254740993");
    let json = String::from_utf8(bytes(&request)).unwrap();
    assert!(!json.contains("seed") && !json.contains("private") && !json.contains("checkpoint"));
    for (wire, reference) in request.packages.iter().zip(&expected.key_package_refs) {
        let raw = B64.decode(wire.as_bytes()).unwrap();
        let provider = OpenMlsRustCrypto::default();
        let package = KeyPackageIn::tls_deserialize_exact(&raw)
            .unwrap()
            .validate(provider.crypto(), ProtocolVersion::Mls10)
            .unwrap();
        let certificate = Certificate::from_credential(package.leaf_node().credential()).unwrap();
        assert_eq!(certificate, account.certificate);
        assert!(!package.last_resort());
        assert_eq!(
            package.life_time().not_after(),
            account.certificate.device.expires_at
        );
        assert_eq!(
            *reference,
            B64.encode(package.hash_ref(provider.crypto()).unwrap().as_slice())
        );
        assert_ne!(*reference, B64.encode(&Sha256::digest(&raw)));
    }
    coordinator.confirm(&expected, account.now + 2).unwrap();
    account
        .reopened()
        .confirm(&expected, account.now + 3)
        .unwrap();
    assert!(matches!(
        coordinator.retry(account.now + 3),
        Err(Error::NotPending)
    ));
    let second = coordinator
        .prepare("9007199254740993", 2, account.now + 3)
        .unwrap();
    assert_ne!(second.operation_id, request.operation_id);
    assert_ne!(second.packages, request.packages);
    // A delayed duplicate of the previous ACK cannot clear the new outbox.
    coordinator.confirm(&expected, account.now + 4).unwrap();
    assert_eq!(
        bytes(&coordinator.retry(account.now + 4).unwrap()),
        bytes(&second)
    );
}

#[test]
fn every_receipt_field_and_reference_order_is_checked_without_mutation() {
    let account = Account::new("bob", "bob-mobile", [2; 16]);
    let coordinator = account.coordinator();
    coordinator.prepare("7", 2, account.now).unwrap();
    let expected = expected(&account);
    let original = stored(&account);
    for field in 0..12 {
        let mut receipt = expected.clone();
        match field {
            0 => receipt.scope.instance_id = "foreign".into(),
            1 => receipt.scope.data_epoch = "restored".into(),
            2 => receipt.operation_id = "foreign".into(),
            3 => receipt.kind = "register_device".into(),
            4 => receipt.device_id = "foreign".into(),
            5 => receipt.incarnation = HEXLOWER.encode(&[8; 16]),
            6 => receipt.device_revision = "8".into(),
            7 => receipt.device_revision = "07".into(),
            8 => receipt.root_fingerprint = HEXLOWER.encode(&[8; 32]),
            9 => receipt.key_package_refs.reverse(),
            10 => receipt.key_package_refs.pop().map(|_| ()).unwrap(),
            _ => receipt.key_package_refs[0] = receipt.key_package_refs[1].clone(),
        }
        assert_eq!(
            coordinator.confirm(&receipt, account.now + 1),
            Err(Error::Receipt)
        );
        assert_eq!(stored(&account), original);
    }
    coordinator.confirm(&expected, account.now + 1).unwrap();
}

#[test]
fn failed_publication_checkpoint_recovers_only_the_original_outbox() {
    let account = Account::new("bob", "bob-mobile", [2; 16]);
    account.keystore.fail_at.store(
        account.keystore.writes.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    assert!(matches!(
        account.coordinator().prepare("1", 2, account.now),
        Err(Error::Storage(vault::Error::Storage))
    ));
    let recovered = account.reopened().retry(account.now + 1).unwrap();
    assert_eq!(
        account.reopened().pending_lookup().unwrap().operation_id,
        recovered.operation_id
    );
    let expected = expected(&account);
    assert_eq!(
        bytes(
            &account
                .coordinator()
                .prepare("1", 2, account.now + 1)
                .unwrap()
        ),
        bytes(&recovered)
    );
    account
        .coordinator()
        .confirm(&expected, account.now + 2)
        .unwrap();
    // The recovered private material really joins MLS, rather than just matching JSON.
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let (creator, admission) = admitted(&alice, &account, &recovered.packages[0]);
    join(&account, &admission);
    creator.confirm(&admission.receipt, alice.now).unwrap();
    assert_eq!(creator.ready_epoch("room"), Ok(1));
}

#[test]
fn lost_ack_checkpoint_preserves_the_historical_ack_after_expiry() {
    let account = Account::new("bob", "bob-mobile", [2; 16]);
    account.coordinator().prepare("1", 1, account.now).unwrap();
    let receipt = expected(&account);
    account.keystore.fail_at.store(
        account.keystore.writes.load(Ordering::SeqCst) + 1,
        Ordering::SeqCst,
    );
    assert_eq!(
        account.coordinator().confirm(&receipt, account.now + 1),
        Err(Error::Storage(vault::Error::Storage))
    );
    let future = account.now + 3600;
    account.reopened().confirm(&receipt, future).unwrap();
    assert!(matches!(
        account.coordinator().prepare("1", 1, future),
        Err(Error::Identity(identity::Error::Expired))
    ));
    assert_eq!(
        account.coordinator().confirm(&receipt, account.now),
        Err(Error::Changed)
    );
}

#[test]
fn expiry_and_local_revocation_forbid_resend_but_keep_receipt_lookup() {
    for revoke in [false, true] {
        let account = Account::new("bob", "bob-mobile", [2; 16]);
        let original = account.coordinator().prepare("1", 1, account.now).unwrap();
        let expected = expected(&account);
        let when = if revoke {
            account.revoke_self();
            account.now + 1
        } else {
            account.now + 3600
        };
        let refusal = if revoke {
            identity::Error::Revoked
        } else {
            identity::Error::Expired
        };
        assert!(
            matches!(account.coordinator().retry(when),Err(Error::Identity(e)) if e == refusal)
        );
        assert_eq!(
            bytes(&original),
            bytes(
                &account
                    .manager
                    .inspect(|_, records| {
                        let state: State =
                            serde_json::from_slice(records.get(RECORD).unwrap()).unwrap();
                        Ok(state.pending.unwrap().request)
                    })
                    .unwrap()
            )
        );
        assert!(lookup_matches(
            &account.coordinator().pending_lookup().unwrap(),
            &expected
        ));
        account.coordinator().confirm(&expected, when).unwrap();
        assert!(
            matches!(account.coordinator().prepare("1",1,when),Err(Error::Identity(e)) if e == refusal)
        );
    }
}

#[test]
fn consumed_package_is_not_republished_and_lost_publication_ack_still_reconciles() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    let request = bob.coordinator().prepare("1", 1, bob.now).unwrap();
    let expected = expected(&bob);
    let (creator, admission) = admitted(&alice, &bob, &request.packages[0]);
    join(&bob, &admission);
    assert!(matches!(
        bob.reopened().retry(bob.now),
        Err(Error::Consumed)
    ));
    assert!(lookup_matches(
        &bob.coordinator().pending_lookup().unwrap(),
        &expected
    ));
    bob.coordinator().confirm(&expected, bob.now).unwrap();
    creator.confirm(&admission.receipt, alice.now).unwrap();
    let next = bob.reopened().prepare("1", 1, bob.now).unwrap();
    assert_ne!(next.packages, request.packages);
    bob.manager
        .inspect(|provider, records| {
            let state: State = serde_json::from_slice(records.get(RECORD).unwrap()).unwrap();
            assert_eq!(state.retained.len(), 1);
            assert!(bundle(provider, &state.retained[0]).unwrap().is_some());
            Ok(())
        })
        .unwrap();
}

#[test]
fn bounded_retention_releases_only_a_bundle_actually_consumed_by_mls() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let bob = Account::new("bob", "bob-mobile", [2; 16]);
    let mut first = None;
    for _ in 0..8 {
        let request = bob.coordinator().prepare("1", 8, bob.now).unwrap();
        first.get_or_insert(request.packages[0].clone());
        bob.coordinator().confirm(&expected(&bob), bob.now).unwrap();
    }
    let original = stored(&bob);
    assert!(matches!(
        bob.coordinator().prepare("1", 1, bob.now),
        Err(Error::Limit)
    ));
    assert_eq!(stored(&bob), original);
    let (_, admission) = admitted(&alice, &bob, first.as_deref().unwrap());
    join(&bob, &admission);
    bob.reopened().prepare("1", 1, bob.now).unwrap();
    assert_eq!(
        bob.manager
            .inspect(|_, records| Ok(
                serde_json::from_slice::<State>(records.get(RECORD).unwrap())
                    .unwrap()
                    .retained
                    .len()
            ))
            .unwrap(),
        64
    );
}

#[test]
fn invalid_parameters_scope_and_clock_do_not_allocate_packages() {
    let account = Account::new("bob", "bob-mobile", [2; 16]);
    for revision in ["0", "01", "-1", "9223372036854775808", "1\n"] {
        assert!(matches!(
            account.coordinator().prepare(revision, 1, account.now),
            Err(Error::Changed)
        ));
    }
    for count in [0, 9, usize::MAX] {
        assert!(matches!(
            account.coordinator().prepare("1", count, account.now),
            Err(Error::Limit)
        ));
    }
    assert!(stored(&account).is_empty());
    let request = account.coordinator().prepare("1", 1, account.now).unwrap();
    let original = stored(&account);
    assert!(matches!(
        account.coordinator().prepare("2", 1, account.now),
        Err(Error::Pending)
    ));
    assert!(matches!(
        account.coordinator().prepare("1", 2, account.now),
        Err(Error::Pending)
    ));
    assert!(matches!(
        account.coordinator().retry(account.now - 1),
        Err(Error::Changed)
    ));
    assert!(matches!(
        account.coordinator().prepare("1", 1, MAX_CLOCK + 1),
        Err(Error::Changed)
    ));
    assert_eq!(stored(&account), original);
    assert_eq!(
        bytes(&account.reopened().retry(account.now).unwrap()),
        bytes(&request)
    );
    let foreign = Issuer::generate("instance", "foreign").unwrap();
    assert!(matches!(
        Coordinator::new(account.manager.clone(), foreign.root().clone()),
        Err(Error::Identity(identity::Error::Scope))
    ));
}

#[test]
fn observed_local_revocation_also_forbids_group_preparation() {
    let alice = Account::new("alice", "alice-desktop", [1; 16]);
    let roster = Roster {
        scope: GroupScope {
            instance: "instance".into(),
            data_epoch: "epoch".into(),
            room: "room".into(),
            incarnation: [9; 16],
        },
        authority_version: "authority".into(),
        members: vec![Member {
            user: "alice".into(),
            access_version: "access".into(),
            activation_version: "activation".into(),
        }],
    };
    let request = Genesis {
        roster,
        operation: "genesis".into(),
        packages: vec![],
    };
    let coordinator = groups::Coordinator::new(alice.manager.clone(), alice.root.clone()).unwrap();
    let (preview, consent) = coordinator.preview_genesis(&request, alice.now).unwrap();
    alice.revoke_self();
    assert!(matches!(
        coordinator.prepare_genesis(&request, &consent, preview.fingerprint, alice.now),
        Err(groups::Error::Identity(identity::Error::Revoked))
    ));
    assert!(matches!(
        coordinator.preview_genesis(&request, alice.now),
        Err(groups::Error::Identity(identity::Error::Revoked))
    ));
}
