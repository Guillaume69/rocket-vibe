use super::Error;
use super::*;
use crate::protected::{Manager, Storage};
use crate::vault::{Error as VaultError, Scope};
use openmls::prelude::{
    Ciphersuite, CredentialWithKey, KeyPackageIn, OpenMlsProvider, ProtocolVersion,
    tls_codec::{Deserialize as _, Serialize as _},
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

const NOW: u64 = 1_900_000_000;
const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
fn issuer() -> Issuer {
    Issuer::generate("instance", "alice").unwrap()
}
fn device_key() -> SignatureKeyPair {
    SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap()
}
fn certificate(issuer: &Issuer, signer: &SignatureKeyPair, incarnation: u8) -> Certificate {
    issuer
        .certify(
            "desktop",
            [incarnation; 16],
            signer.to_public_vec().try_into().unwrap(),
            NOW,
            NOW + 3600,
        )
        .unwrap()
}
fn package(certificate: &Certificate, signer: &SignatureKeyPair) -> KeyPackage {
    let provider = OpenMlsRustCrypto::default();
    let credential = CredentialWithKey {
        credential: certificate.credential().unwrap(),
        signature_key: signer.to_public_vec().into(),
    };
    let bundle = KeyPackage::builder()
        .build(SUITE, &provider, signer, credential)
        .unwrap();
    let wire = bundle.key_package().tls_serialize_detached().unwrap();
    KeyPackageIn::tls_deserialize_exact(wire)
        .unwrap()
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .unwrap()
}
fn pinned(root: &Root) -> Pins {
    let mut pins = Pins::new("instance").unwrap();
    pins.accept_first(root.clone(), root.fingerprint().unwrap())
        .unwrap();
    pins
}
fn approve(pins: &mut Pins, certificate: &Certificate) -> Result<(), Error> {
    let consent = pins.preview_device(certificate, NOW)?;
    pins.approve(certificate, &consent, NOW)
}

#[test]
fn valid_mls_keypackage_requires_exact_root_and_device_approval() {
    let issuer = issuer();
    let signer = device_key();
    let certificate = certificate(&issuer, &signer, 1);
    let package = package(&certificate, &signer);
    let mut pins = Pins::new("instance").unwrap();
    assert_eq!(pins.observe(issuer.root()), Ok(Observation::Unknown));
    assert_eq!(
        pins.authorize_key_package(&package, NOW).err(),
        Some(Error::Untrusted)
    );
    // Observation, public signatures and a valid KeyPackage alone never add pins.
    assert_eq!(pins.observe(issuer.root()), Ok(Observation::Unknown));
    pins.accept_first(issuer.root().clone(), issuer.root().fingerprint().unwrap())
        .unwrap();
    assert_eq!(
        pins.authorize_key_package(&package, NOW).err(),
        Some(Error::Unapproved)
    );
    approve(&mut pins, &certificate).unwrap();
    let authorized = pins.authorize_key_package(&package, NOW).unwrap();
    assert_eq!(authorized.root(), issuer.root());
    assert_eq!(authorized.device(), "desktop");
    assert_eq!(authorized.incarnation(), [1; 16]);
    assert_eq!(authorized.trust(), Trust::Unverified);
    pins.verify_root(issuer.root(), issuer.root().fingerprint().unwrap())
        .unwrap();
    assert_eq!(
        pins.authorize_key_package(&package, NOW).unwrap().trust(),
        Trust::Verified
    );
}

#[test]
fn stolen_certificate_cannot_authenticate_a_different_mls_leaf_key() {
    let issuer = issuer();
    let original = device_key();
    let certificate = certificate(&issuer, &original, 1);
    let impostor = device_key();
    // OpenMLS accepts this KeyPackage's own signature. Its basic credential
    // claims the victim's certificate; our independent binding rejects it.
    let forged = package(&certificate, &impostor);
    let mut pins = pinned(issuer.root());
    approve(&mut pins, &certificate).unwrap();
    assert_eq!(
        pins.authorize_key_package(&forged, NOW).err(),
        Some(Error::Signature)
    );
    assert_eq!(
        pins.authorize_key_package(&package(&certificate, &original), NOW)
            .unwrap()
            .device(),
        "desktop"
    );
}

#[test]
fn certificate_scope_time_weak_keys_and_changed_payloads_are_rejected() {
    let issuer = issuer();
    let signer = device_key();
    let original = certificate(&issuer, &signer, 1);
    assert_eq!(original.verify(NOW - 1), Err(Error::Expired));
    assert_eq!(original.verify(NOW + 3600), Err(Error::Expired));
    let weak = [0; 32];
    assert_eq!(
        issuer
            .certify("desktop", [1; 16], weak, NOW, NOW + 60)
            .err(),
        Some(Error::Signature)
    );
    assert_eq!(
        issuer
            .certify(
                "desktop",
                [1; 16],
                signer.to_public_vec().try_into().unwrap(),
                NOW,
                NOW + MAX_LIFETIME + 1
            )
            .err(),
        Some(Error::Invalid)
    );
    for field in 0..6 {
        let mut changed = original.clone();
        match field {
            0 => changed.device.root.instance = "other".into(),
            1 => changed.device.root.user = "other".into(),
            2 => changed.device.device = "other".into(),
            3 => changed.device.incarnation[0] ^= 1,
            4 => changed.device.expires_at += 1,
            _ => changed.signature[0] ^= 1,
        }
        assert_eq!(changed.verify(NOW), Err(Error::Signature));
    }
    let mut wrong_instance = Pins::new("other-instance").unwrap();
    assert_eq!(
        wrong_instance.accept_first(issuer.root().clone(), issuer.root().fingerprint().unwrap()),
        Err(Error::Scope)
    );
    let mut pins = pinned(issuer.root());
    let mut stale = pins.preview_device(&original, NOW).unwrap();
    stale.certificate[0] ^= 1;
    assert_eq!(pins.approve(&original, &stale, NOW), Err(Error::Changed));
    assert_eq!(
        pins.authorize_key_package(&package(&original, &signer), NOW)
            .err(),
        Some(Error::Unapproved)
    );
}

#[test]
fn root_substitution_suspends_admission_and_explicit_replacement_clears_devices() {
    let old = issuer();
    let new = issuer();
    let signer = device_key();
    let old_certificate = certificate(&old, &signer, 1);
    let new_certificate = certificate(&new, &signer, 1);
    let mut pins = pinned(old.root());
    approve(&mut pins, &old_certificate).unwrap();
    assert_eq!(pins.observe(new.root()), Ok(Observation::Changed));
    assert_eq!(approve(&mut pins, &new_certificate), Err(Error::Changed));
    assert_eq!(
        pins.authorize_key_package(&package(&new_certificate, &signer), NOW)
            .err(),
        Some(Error::Changed)
    );
    assert_eq!(
        pins.replace_verified(
            [0; 32],
            new.root().clone(),
            new.root().fingerprint().unwrap()
        ),
        Err(Error::Changed)
    );
    pins.replace_verified(
        old.root().fingerprint().unwrap(),
        new.root().clone(),
        new.root().fingerprint().unwrap(),
    )
    .unwrap();
    assert_eq!(
        pins.authorize_key_package(&package(&old_certificate, &signer), NOW)
            .err(),
        Some(Error::Changed)
    );
    assert_eq!(
        pins.authorize_key_package(&package(&new_certificate, &signer), NOW)
            .err(),
        Some(Error::Unapproved)
    );
    approve(&mut pins, &new_certificate).unwrap();
    assert_eq!(
        pins.authorize_key_package(&package(&new_certificate, &signer), NOW)
            .unwrap()
            .trust(),
        Trust::Verified
    );
}

#[test]
fn signed_revocation_is_monotonic_across_reissue_and_persistence() {
    let issuer = issuer();
    let signer = device_key();
    let certificate = certificate(&issuer, &signer, 1);
    let mut pins = pinned(issuer.root());
    approve(&mut pins, &certificate).unwrap();
    let revoked = issuer.revoke("desktop", [1; 16]).unwrap();
    let mut forged = revoked.clone();
    forged.device = "other".into();
    assert_eq!(pins.apply_revocation(&forged), Err(Error::Signature));
    pins.apply_revocation(&revoked).unwrap();
    pins.apply_revocation(&revoked).unwrap();
    let mut records = Records::new();
    pins.save(&mut records).unwrap();
    let mut pins = Pins::load(&records, "instance").unwrap();
    let renewed = super::tests::certificate(&issuer, &signer, 1);
    assert_eq!(approve(&mut pins, &renewed), Err(Error::Revoked));
    assert_eq!(
        pins.authorize_key_package(&package(&renewed, &signer), NOW)
            .err(),
        Some(Error::Revoked)
    );
    let fresh = super::tests::certificate(&issuer, &signer, 2);
    approve(&mut pins, &fresh).unwrap();
    assert_eq!(
        pins.authorize_key_package(&package(&fresh, &signer), NOW)
            .unwrap()
            .incarnation(),
        [2; 16]
    );
    assert_eq!(Pins::load(&records, "other").err(), Some(Error::Scope));
}

#[derive(Default)]
struct ProtectedFixture(Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>);
impl Storage for ProtectedFixture {
    fn read(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(name)
            .map(|value| Zeroizing::new(value.to_vec())))
    }
    fn write(&self, name: &str, bytes: &[u8]) -> Result<(), VaultError> {
        self.0
            .lock()
            .unwrap()
            .insert(name.into(), Zeroizing::new(bytes.to_vec()));
        Ok(())
    }
}
fn manager(path: &Path, storage: Arc<dyn Storage>) -> Manager {
    Manager::new(
        path.join("private"),
        Scope {
            instance: "instance".into(),
            data_epoch: "epoch".into(),
            user: "alice".into(),
            device: "desktop".into(),
            incarnation: "incarnation".into(),
        },
        storage,
    )
    .unwrap()
}
#[test]
fn issuer_and_trust_survive_protected_disk_reopen_without_replacing_identity() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Arc::new(ProtectedFixture::default());
    let vault = manager(directory.path(), storage.clone());
    vault.initialize().unwrap();
    let signer = device_key();
    let (root, certificate) = vault
        .transact(|_, records| {
            let issuer = Issuer::generate("instance", "alice").unwrap();
            issuer.save(records).unwrap();
            let certificate = super::tests::certificate(&issuer, &signer, 1);
            let mut pins = pinned(issuer.root());
            approve(&mut pins, &certificate).unwrap();
            pins.save(records).unwrap();
            Ok((issuer.root().clone(), certificate))
        })
        .unwrap();
    drop(vault);
    let reopened = manager(directory.path(), storage);
    reopened
        .transact(|_, records| {
            let loaded = Issuer::load(records, "instance", "alice").unwrap();
            assert_eq!(loaded.root(), &root);
            loaded.save(records).unwrap();
            assert_eq!(
                Issuer::load(records, "instance", "other").err(),
                Some(Error::Scope)
            );
            assert_eq!(issuer().save(records), Err(Error::Changed));
            let mut pins = Pins::load(records, "instance").unwrap();
            assert_eq!(
                pins.authorize_key_package(&package(&certificate, &signer), NOW)
                    .unwrap()
                    .trust(),
                Trust::Unverified
            );
            pins.apply_revocation(&loaded.revoke("desktop", [1; 16]).unwrap())
                .unwrap();
            pins.save(records).unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(
        reopened
            .inspect(|_, records| {
                Ok(Pins::load(records, "instance")
                    .unwrap()
                    .authorize_key_package(&package(&certificate, &signer), NOW)
                    .err())
            })
            .unwrap(),
        Some(Error::Revoked)
    );
}

#[test]
fn credential_parser_refuses_legacy_unknown_and_oversized_payloads() {
    assert_eq!(
        Certificate::from_credential(&BasicCredential::new(b"alice".to_vec()).into()).err(),
        Some(Error::Invalid)
    );
    assert_eq!(
        Certificate::from_credential(&BasicCredential::new(vec![b'x'; WIRE_LIMIT + 1]).into())
            .err(),
        Some(Error::Limit)
    );
    let issuer = issuer();
    let signer = device_key();
    let certificate = certificate(&issuer, &signer, 1);
    let mut value = serde_json::to_value(&certificate).unwrap();
    value["server_approved"] = true.into();
    let credential = BasicCredential::new(serde_json::to_vec(&value).unwrap()).into();
    assert_eq!(
        Certificate::from_credential(&credential).err(),
        Some(Error::Invalid)
    );
}

#[test]
fn public_documented_certificate_vector_is_accepted_and_binds_the_exact_credential() {
    let fixture: Certificate =
        serde_json::from_str(include_str!("../../fixtures/identity-certificate-v1.json")).unwrap();
    fixture.verify(NOW).unwrap();
    assert_eq!(
        Certificate::from_credential(&fixture.credential().unwrap()).unwrap(),
        fixture
    );
    let mut changed = fixture.clone();
    changed.device.root.user = "substituted-user".into();
    assert_eq!(changed.verify(NOW), Err(Error::Signature));
}

#[test]
fn stale_consent_cannot_restore_an_old_device_or_swap_a_key_in_the_same_incarnation() {
    let issuer = issuer();
    let old_signer = device_key();
    let new_signer = device_key();
    let old = certificate(&issuer, &old_signer, 1);
    let new = certificate(&issuer, &new_signer, 2);
    let mut pins = pinned(issuer.root());
    let stale = pins.preview_device(&old, NOW).unwrap();
    let current = pins.preview_device(&new, NOW).unwrap();
    pins.approve(&new, &current, NOW).unwrap();
    pins.approve(&new, &current, NOW).unwrap(); // Idempotent confirmation after lost output.
    assert_eq!(pins.approve(&old, &stale, NOW), Err(Error::Changed));
    assert_eq!(
        pins.authorize_key_package(&package(&old, &old_signer), NOW)
            .err(),
        Some(Error::Unapproved)
    );
    let substituted = certificate(&issuer, &old_signer, 2);
    assert_eq!(
        pins.preview_device(&substituted, NOW)
            .err()
            .map(|e| e == Error::Changed),
        Some(true)
    );
    let fresh = certificate(&issuer, &new_signer, 3);
    let interrupted = pins.preview_device(&fresh, NOW).unwrap();
    pins.apply_revocation(&issuer.revoke("desktop", [2; 16]).unwrap())
        .unwrap();
    assert_eq!(pins.approve(&fresh, &interrupted, NOW), Err(Error::Changed));
    pins.verify_root(issuer.root(), issuer.root().fingerprint().unwrap())
        .unwrap();
    pins.accept_first(issuer.root().clone(), issuer.root().fingerprint().unwrap())
        .unwrap();
    assert_eq!(pins.observe(issuer.root()), Ok(Observation::Verified));
}
