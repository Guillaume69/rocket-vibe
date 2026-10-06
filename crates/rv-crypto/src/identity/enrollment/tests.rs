use super::*;
use crate::identity::{Pins, Trust};
use crate::protected::{Manager, Storage};
use crate::vault::{Error as VaultError, Scope};
use openmls::prelude::{
    Ciphersuite, KeyPackage, KeyPackageIn, OpenMlsProvider, ProtocolVersion,
    tls_codec::{Deserialize as _, Serialize as _},
};
use openmls_rust_crypto::OpenMlsRustCrypto;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

const NOW: u64 = 1_900_000_000;
const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
fn issuer() -> Issuer {
    Issuer::generate("instance", "alice").unwrap()
}
fn requester(root: &Root, name: &str) -> (LocalDevice, Records, Request) {
    let mut records = Records::new();
    let mut device = LocalDevice::create(root, name, &mut records).unwrap();
    let request = device.request(NOW, &mut records).unwrap();
    (device, records, request)
}
fn grant(issuer: &Issuer, request: &Request, records: &mut Records) -> Grant {
    let consent = issuer.preview_request(request, NOW, 3600, records).unwrap();
    issuer
        .approve_request(request, &consent, NOW, records)
        .unwrap()
}
fn resign(request: &mut Request, device: &LocalDevice) {
    request.signature = device
        .signing
        .sign(&signing_bytes(REQUEST_DOMAIN, &request.body).unwrap())
        .to_bytes()
        .to_vec();
}

#[test]
fn request_proof_binds_root_key_incarnation_and_time_without_automatic_approval() {
    let issuer = issuer();
    let (device, _, request) = requester(issuer.root(), "mobile");
    request.verify(NOW).unwrap();
    assert_eq!(request.verify(NOW - 1), Err(Error::Expired));
    assert_eq!(request.verify(NOW + REQUEST_LIFETIME), Err(Error::Expired));
    for field in 0..7 {
        let mut changed = request.clone();
        match field {
            0 => changed.body.root.user = "mallory".into(),
            1 => changed.body.root.instance = "foreign-instance".into(),
            2 => changed.body.device = "other".into(),
            3 => changed.body.incarnation[0] ^= 1,
            4 => changed.body.request_id[0] ^= 1,
            5 => changed.body.signature_key = issuer.root().public_key,
            _ => changed.body.expires_at -= 1,
        }
        assert_eq!(changed.verify(NOW), Err(Error::Signature));
    }
    assert_eq!(device.credential(NOW).err(), Some(Error::Unapproved));
    let mut other = request.clone();
    other.body.root = super::tests::issuer().root().clone();
    resign(&mut other, &device);
    other.verify(NOW).unwrap();
    assert_eq!(
        issuer
            .preview_request(&other, NOW, 3600, &Records::new())
            .err()
            .map(|e| e == Error::Changed),
        Some(true)
    );
}

#[test]
fn fresh_key_request_and_grant_reopen_and_produce_a_real_validated_mls_package() {
    let issuer = issuer();
    let (mut device, mut records, request) = requester(issuer.root(), "mobile");
    let key = device.public_key();
    let incarnation = device.incarnation();
    assert_eq!(device.request(NOW + 1, &mut records).unwrap(), request);
    assert_eq!(
        LocalDevice::create(issuer.root(), "mobile", &mut records)
            .err()
            .map(|e| e == Error::Changed),
        Some(true)
    );
    drop(device);
    let mut device = LocalDevice::load(issuer.root(), "mobile", &records).unwrap();
    assert_eq!(device.public_key(), key);
    assert_eq!(device.incarnation(), incarnation);
    assert_eq!(device.request(NOW + 2, &mut records).unwrap(), request);
    let grant = grant(&issuer, &request, &mut Records::new());
    device.install(&grant, NOW, &mut records).unwrap();
    drop(device);
    let mut device = LocalDevice::load(issuer.root(), "mobile", &records).unwrap();
    device.install(&grant, NOW, &mut records).unwrap();
    let provider = OpenMlsRustCrypto::default();
    let package = KeyPackage::builder()
        .build(SUITE, &provider, &device, device.credential(NOW).unwrap())
        .unwrap();
    let wire = package.key_package().tls_serialize_detached().unwrap();
    let package = KeyPackageIn::tls_deserialize_exact(wire)
        .unwrap()
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .unwrap();
    let mut pins = Pins::new("instance").unwrap();
    assert_eq!(
        pins.authorize_key_package(&package, NOW)
            .err()
            .map(|e| e == Error::Untrusted),
        Some(true)
    );
    pins.accept_first(issuer.root().clone(), issuer.root().fingerprint().unwrap())
        .unwrap();
    let consent = pins.preview_device(&grant.certificate, NOW).unwrap();
    pins.approve(&grant.certificate, &consent, NOW).unwrap();
    let authorized = pins.authorize_key_package(&package, NOW).unwrap();
    assert_eq!(authorized.incarnation(), incarnation);
    assert_eq!(authorized.trust(), Trust::Unverified);
}

#[test]
fn approval_is_idempotent_but_stale_preview_and_same_id_substitution_are_refused() {
    let issuer = issuer();
    let (device, _, request) = requester(issuer.root(), "mobile");
    let (_, _, second) = requester(issuer.root(), "desktop");
    let mut records = Records::new();
    let first_consent = issuer
        .preview_request(&request, NOW, 3600, &records)
        .unwrap();
    let stale = issuer
        .preview_request(&second, NOW, 3600, &records)
        .unwrap();
    let first = issuer
        .approve_request(&request, &first_consent, NOW, &mut records)
        .unwrap();
    let original_state = records.clone();
    assert_eq!(
        issuer
            .approve_request(&request, &first_consent, NOW + 1, &mut records)
            .unwrap(),
        first
    );
    assert_eq!(records, original_state);
    assert_eq!(
        issuer.approve_request(&second, &stale, NOW, &mut records),
        Err(Error::Changed)
    );
    assert_eq!(records, original_state);
    let current = issuer
        .preview_request(&second, NOW, 3600, &records)
        .unwrap();
    issuer
        .approve_request(&second, &current, NOW, &mut records)
        .unwrap();
    let mut substituted = request.clone();
    substituted.body.device = "substituted".into();
    resign(&mut substituted, &device);
    let consent = issuer
        .preview_request(&substituted, NOW, 3600, &records)
        .unwrap();
    assert_eq!(
        issuer.approve_request(&substituted, &consent, NOW, &mut records),
        Err(Error::Changed)
    );
}

#[test]
fn grants_cannot_be_rebound_to_a_different_request_device_or_local_key() {
    let issuer = issuer();
    let (mut device, mut records, request) = requester(issuer.root(), "mobile");
    let (_, _, other_request) = requester(issuer.root(), "other");
    let grant = grant(&issuer, &request, &mut Records::new());
    let original_state = records.clone();
    let mut changed = grant.clone();
    changed.request[0] ^= 1;
    assert_eq!(
        device.install(&changed, NOW, &mut records),
        Err(Error::Signature)
    );
    assert_eq!(records, original_state);
    let other_grant = super::tests::grant(&issuer, &other_request, &mut Records::new());
    assert_eq!(
        device.install(&other_grant, NOW, &mut records),
        Err(Error::Changed)
    );
    assert_eq!(records, original_state);
    // Root-signed, same local key, but for an obsolete request: still refused.
    let replacement = device
        .request(NOW + REQUEST_LIFETIME, &mut records)
        .unwrap();
    assert_ne!(replacement.body.request_id, request.body.request_id);
    assert_eq!(
        device.install(&grant, NOW + REQUEST_LIFETIME, &mut records),
        Err(Error::Changed)
    );
    let (mut other, mut other_records, _) = requester(issuer.root(), "mobile");
    assert_eq!(
        other.install(&grant, NOW, &mut other_records),
        Err(Error::Changed)
    );
}

#[test]
fn expired_request_and_backwards_clock_never_extend_the_existing_request() {
    let issuer = issuer();
    let (mut device, mut records, request) = requester(issuer.root(), "mobile");
    let original = records.clone();
    assert_eq!(device.request(NOW - 1, &mut records), Err(Error::Expired));
    assert_eq!(records, original);
    let mut controller = Records::new();
    let consent = issuer
        .preview_request(&request, NOW, 3600, &controller)
        .unwrap();
    assert_eq!(
        issuer.approve_request(&request, &consent, NOW + REQUEST_LIFETIME, &mut controller),
        Err(Error::Expired)
    );
    assert!(controller.is_empty());
    let new_request = device
        .request(NOW + REQUEST_LIFETIME, &mut records)
        .unwrap();
    assert_ne!(new_request.body.request_id, request.body.request_id);
    assert_eq!(new_request.body.incarnation, request.body.incarnation);
    assert_eq!(new_request.body.signature_key, request.body.signature_key);
}

#[test]
fn stale_local_device_and_corrupted_private_seed_cannot_overwrite_durable_state() {
    let issuer = issuer();
    let (mut current, mut records, request) = requester(issuer.root(), "mobile");
    let mut stale = LocalDevice::load(issuer.root(), "mobile", &records).unwrap();
    current
        .request(NOW + REQUEST_LIFETIME, &mut records)
        .unwrap();
    let unchanged = records.clone();
    assert_eq!(stale.request(NOW, &mut records), Err(Error::Changed));
    let grant = grant(&issuer, &request, &mut Records::new());
    assert_eq!(
        stale.install(&grant, NOW, &mut records),
        Err(Error::Changed)
    );
    assert_eq!(records, unchanged);
    let mut state: serde_json::Value =
        serde_json::from_slice(records.get(DEVICE_RECORD).unwrap()).unwrap();
    state["seed"][0] = serde_json::json!(state["seed"][0].as_u64().unwrap() ^ 1);
    records.insert(DEVICE_RECORD.into(), serde_json::to_vec(&state).unwrap());
    assert_eq!(
        LocalDevice::load(issuer.root(), "mobile", &records)
            .err()
            .map(|e| e == Error::Changed),
        Some(true)
    );
}

#[test]
fn bounded_wire_decoders_refuse_oversized_unknown_and_duplicate_fields() {
    let issuer = issuer();
    let (_, _, request) = requester(issuer.root(), "mobile");
    let grant = grant(&issuer, &request, &mut Records::new());
    assert_eq!(
        Request::from_bytes(&request.to_bytes().unwrap()).unwrap(),
        request
    );
    assert_eq!(
        Grant::from_bytes(&grant.to_bytes().unwrap()).unwrap(),
        grant
    );
    assert_eq!(
        Request::from_bytes(&vec![b'x'; super::super::WIRE_LIMIT + 1]),
        Err(Error::Limit)
    );
    assert_eq!(
        Grant::from_bytes(&vec![b'x'; 2 * super::super::WIRE_LIMIT + 1]),
        Err(Error::Limit)
    );
    let mut request_value = serde_json::to_value(&request).unwrap();
    request_value["server_approved"] = true.into();
    assert_eq!(
        Request::from_bytes(&serde_json::to_vec(&request_value).unwrap()),
        Err(Error::Invalid)
    );
    let mut grant_value = serde_json::to_value(&grant).unwrap();
    grant_value["server_approved"] = true.into();
    assert_eq!(
        Grant::from_bytes(&serde_json::to_vec(&grant_value).unwrap()),
        Err(Error::Invalid)
    );
    let duplicate = format!(
        "{{\"signature\":[],{}",
        serde_json::to_string(&request)
            .unwrap()
            .strip_prefix('{')
            .unwrap()
    );
    assert_eq!(
        Request::from_bytes(duplicate.as_bytes()),
        Err(Error::Invalid)
    );
}

#[test]
fn public_enrollment_vector_binds_request_proof_and_exact_grant() {
    #[derive(Deserialize)]
    struct PublicFixture {
        request: Request,
        grant: Grant,
    }
    let fixture: PublicFixture =
        serde_json::from_str(include_str!("../../../fixtures/enrollment-v1.json")).unwrap();
    fixture.request.verify(NOW).unwrap();
    fixture.grant.verify(NOW).unwrap();
    assert_eq!(
        fixture.request.fingerprint().unwrap(),
        fixture.grant.request
    );
    assert_eq!(
        fixture.request.body.signature_key,
        fixture.grant.certificate.device.signature_key
    );
    let mut changed = fixture.grant;
    changed.request[0] ^= 1;
    assert_eq!(changed.verify(NOW), Err(Error::Signature));
}

#[test]
fn receipt_limit_blocks_new_issuance_and_expired_requests_are_pruned_without_reissue() {
    let issuer = issuer();
    let (_, _, original_request) = requester(issuer.root(), "mobile");
    let original_grant = grant(&issuer, &original_request, &mut Records::new());
    let mut ledger = Ledger {
        version: 1,
        root: issuer.root().fingerprint().unwrap(),
        clock: NOW,
        receipts: Vec::new(),
    };
    for index in 1..=MAX_RECEIPTS {
        let mut id = [0; 32];
        id[..8].copy_from_slice(&(index as u64).to_be_bytes());
        ledger.receipts.push(Receipt {
            id,
            expires_at: NOW + REQUEST_LIFETIME,
            grant: original_grant.clone(),
        });
    }
    let mut records = Records::new();
    ledger.save(&mut records).unwrap();
    let (mut device, mut requester_records, request) = requester(issuer.root(), "another-device");
    let consent = issuer
        .preview_request(&request, NOW, 3600, &records)
        .unwrap();
    let previous = records.clone();
    assert_eq!(
        issuer.approve_request(&request, &consent, NOW, &mut records),
        Err(Error::Limit)
    );
    assert_eq!(records, previous);
    let now = NOW + REQUEST_LIFETIME;
    let renewed = device.request(now, &mut requester_records).unwrap();
    let consent = issuer
        .preview_request(&renewed, now, 3600, &records)
        .unwrap();
    issuer
        .approve_request(&renewed, &consent, now, &mut records)
        .unwrap();
    assert_eq!(
        Ledger::load(issuer.root(), &records)
            .unwrap()
            .receipts
            .len(),
        1
    );
    assert_eq!(
        issuer
            .preview_request(&original_request, now, 3600, &records)
            .err()
            .map(|e| e == Error::Expired),
        Some(true)
    );
    // Even a later backwards clock cannot reopen the pruned request's window.
    assert_eq!(
        issuer
            .preview_request(&original_request, NOW, 3600, &records)
            .err()
            .map(|e| e == Error::Expired),
        Some(true)
    );
}

#[derive(Default)]
struct Fixture {
    entries: Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>,
    fail: AtomicBool,
}
impl Storage for Fixture {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultError> {
        Ok(self
            .entries
            .lock()
            .unwrap()
            .get(name)
            .map(|v| Zeroizing::new(v.to_vec())))
    }
    fn write(&self, name: &str, bytes: &[u8]) -> Result<(), VaultError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(VaultError::Storage);
        }
        self.entries
            .lock()
            .unwrap()
            .insert(name.into(), Zeroizing::new(bytes.to_vec()));
        Ok(())
    }
}
fn manager(path: &Path, device: &str, storage: Arc<Fixture>) -> Manager {
    Manager::new(
        path.join("private"),
        Scope {
            instance: "instance".into(),
            data_epoch: "epoch".into(),
            user: "alice".into(),
            device: device.into(),
            incarnation: "storage-incarnation".into(),
        },
        storage,
    )
    .unwrap()
}

#[test]
fn real_protected_reopen_preserves_request_and_original_grant_after_lost_checkpoint() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Arc::new(Fixture::default());
    let controller = manager(directory.path(), "controller", storage.clone());
    let requester = manager(directory.path(), "mobile", storage.clone());
    controller.initialize().unwrap();
    requester.initialize().unwrap();
    let root = controller
        .transact(|_, records| {
            let issuer = issuer();
            issuer.save(records).unwrap();
            Ok(issuer.root().clone())
        })
        .unwrap();
    let request = requester
        .transact(|_, records| {
            LocalDevice::create(&root, "mobile", records)
                .unwrap()
                .request(NOW, records)
                .map_err(|_| VaultError::Rejected)
        })
        .unwrap();
    drop(requester);
    let requester = manager(directory.path(), "mobile", storage.clone());
    assert_eq!(
        requester
            .transact(|_, records| {
                LocalDevice::load(&root, "mobile", records)
                    .unwrap()
                    .request(NOW + 1, records)
                    .map_err(|_| VaultError::Rejected)
            })
            .unwrap(),
        request
    );
    let consent = controller
        .inspect(|_, records| {
            Ok(Issuer::load(records, "instance", "alice")
                .unwrap()
                .preview_request(&request, NOW, 3600, records)
                .unwrap())
        })
        .unwrap();
    storage.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        controller.transact(|_, records| {
            Issuer::load(records, "instance", "alice")
                .unwrap()
                .approve_request(&request, &consent, NOW, records)
                .map_err(|_| VaultError::Rejected)
        }),
        Err(VaultError::Storage)
    );
    // No grant was returned while the durable checkpoint was unavailable.
    storage.fail.store(false, Ordering::SeqCst);
    drop(controller);
    let controller = manager(directory.path(), "controller", storage.clone());
    let original = controller
        .inspect(|_, records| {
            Ok(Ledger::load(&root, records).unwrap().receipts[0]
                .grant
                .clone())
        })
        .unwrap();
    let replay = controller
        .transact(|_, records| {
            Issuer::load(records, "instance", "alice")
                .unwrap()
                .approve_request(&request, &consent, NOW + 2, records)
                .map_err(|_| VaultError::Rejected)
        })
        .unwrap();
    assert_eq!(original, replay);
    requester
        .transact(|provider, records| {
            let mut device = LocalDevice::load(&root, "mobile", records).unwrap();
            device.install(&replay, NOW + 2, records).unwrap();
            KeyPackage::builder()
                .build(
                    SUITE,
                    provider,
                    &device,
                    device.credential(NOW + 2).unwrap(),
                )
                .unwrap();
            Ok(())
        })
        .unwrap();
    drop(requester);
    manager(directory.path(), "mobile", storage)
        .inspect(|_, records| {
            assert!(
                LocalDevice::load(&root, "mobile", records)
                    .unwrap()
                    .credential(NOW + 3)
                    .is_ok()
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn rejected_transaction_does_not_issue_a_certificate_or_consume_the_preview() {
    let directory = tempfile::tempdir().unwrap();
    let controller = manager(directory.path(), "controller", Arc::new(Fixture::default()));
    controller.initialize().unwrap();
    let root = controller
        .transact(|_, records| {
            let issuer = issuer();
            issuer.save(records).unwrap();
            Ok(issuer.root().clone())
        })
        .unwrap();
    let (_, _, request) = requester(&root, "mobile");
    let consent = controller
        .inspect(|_, records| {
            Ok(Issuer::load(records, "instance", "alice")
                .unwrap()
                .preview_request(&request, NOW, 3600, records)
                .unwrap())
        })
        .unwrap();
    assert_eq!(
        controller.transact::<()>(|_, records| {
            Issuer::load(records, "instance", "alice")
                .unwrap()
                .approve_request(&request, &consent, NOW, records)
                .unwrap();
            Err(VaultError::Rejected)
        }),
        Err(VaultError::Rejected)
    );
    controller
        .inspect(|_, records| {
            assert!(!records.contains_key(ISSUANCE_RECORD));
            Ok(())
        })
        .unwrap();
    controller
        .transact(|_, records| {
            Issuer::load(records, "instance", "alice")
                .unwrap()
                .approve_request(&request, &consent, NOW, records)
                .map_err(|_| VaultError::Rejected)
        })
        .unwrap();
}
