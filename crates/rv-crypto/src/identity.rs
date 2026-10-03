//! Client-owned roots, signed device certificates and explicit persistent pins.
//! No network response or valid signature alone grants admission to a group.
use crate::vault::Records;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use openmls::prelude::{BasicCredential, Credential, CredentialType, KeyPackage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use zeroize::{Zeroize, Zeroizing};

pub mod enrollment;
pub mod recovery;

const ROOT_RECORD: &str = "crypto-root-v1";
const TRUST_RECORD: &str = "crypto-trust-v1";
const WIRE_LIMIT: usize = 4096;
const STATE_LIMIT: usize = 2 * 1024 * 1024;
const MAX_PEERS: usize = 1024;
const MAX_DEVICES: usize = 64;
const MAX_REVOKED: usize = 4096;
const MAX_LIFETIME: u64 = 90 * 86400;
const CERT_DOMAIN: &str = "rocketvibe-device-certificate-v1";
const REVOKE_DOMAIN: &str = "rocketvibe-device-revocation-v1";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("crypto_identity_invalid")]
    Invalid,
    #[error("crypto_identity_scope")]
    Scope,
    #[error("crypto_identity_signature")]
    Signature,
    #[error("crypto_identity_expired")]
    Expired,
    #[error("crypto_identity_changed")]
    Changed,
    #[error("crypto_identity_untrusted")]
    Untrusted,
    #[error("crypto_device_unapproved")]
    Unapproved,
    #[error("crypto_device_revoked")]
    Revoked,
    #[error("crypto_identity_limit")]
    Limit,
    #[error("crypto_identity_unavailable")]
    Unavailable,
    #[error("crypto_recovery_failed")]
    Recovery,
}

pub type Fingerprint = [u8; 32];
fn label(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn random<const N: usize>() -> Result<[u8; N], Error> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| Error::Unavailable)?;
    Ok(bytes)
}
fn signing_bytes(domain: &str, value: &impl Serialize) -> Result<Vec<u8>, Error> {
    let payload = serde_json::to_vec(value).map_err(|_| Error::Invalid)?;
    if payload.len() > WIRE_LIMIT {
        return Err(Error::Limit);
    }
    let mut bytes = domain.as_bytes().to_vec();
    bytes.push(0);
    bytes.extend(payload);
    Ok(bytes)
}
fn verifying_key(bytes: &[u8; 32]) -> Result<VerifyingKey, Error> {
    let key = VerifyingKey::from_bytes(bytes).map_err(|_| Error::Signature)?;
    if key.is_weak() {
        return Err(Error::Signature);
    }
    Ok(key)
}

/// Public immutable account root. Names/bearers are never identity inputs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Root {
    pub version: u8,
    pub instance: String,
    pub user: String,
    pub generation: [u8; 16],
    pub public_key: [u8; 32],
}
impl Root {
    fn validate(&self) -> Result<(), Error> {
        if self.version != 1
            || !label(&self.instance)
            || !label(&self.user)
            || self.generation == [0; 16]
        {
            return Err(Error::Invalid);
        }
        verifying_key(&self.public_key)?;
        Ok(())
    }
    pub fn fingerprint(&self) -> Result<Fingerprint, Error> {
        self.validate()?;
        Ok(Sha256::digest(signing_bytes("rocketvibe-root-fingerprint-v1", self)?).into())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Device {
    pub version: u8,
    pub root: Root,
    pub device: String,
    pub incarnation: [u8; 16],
    pub serial: [u8; 16],
    pub suite: u16,
    pub signature_key: [u8; 32],
    pub issued_at: u64,
    pub expires_at: u64,
}
impl Device {
    fn validate(&self) -> Result<(), Error> {
        self.root.validate()?;
        if self.version != 1
            || self.suite != 1
            || !label(&self.device)
            || self.incarnation == [0; 16]
            || self.serial == [0; 16]
            || self.expires_at <= self.issued_at
            || self.expires_at - self.issued_at > MAX_LIFETIME
            || self.expires_at > 253_402_300_799
        {
            return Err(Error::Invalid);
        }
        verifying_key(&self.signature_key)?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Certificate {
    pub device: Device,
    pub signature: Vec<u8>,
}
impl Certificate {
    /// Signature/shape checks only; not trust, admission or proof of possession.
    pub fn verify(&self, now: u64) -> Result<(), Error> {
        self.device.validate()?;
        let signature = Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?;
        verifying_key(&self.device.root.public_key)?
            .verify_strict(&signing_bytes(CERT_DOMAIN, &self.device)?, &signature)
            .map_err(|_| Error::Signature)?;
        if now < self.device.issued_at || now >= self.device.expires_at {
            return Err(Error::Expired);
        }
        Ok(())
    }
    pub fn fingerprint(&self) -> Result<Fingerprint, Error> {
        self.device.validate()?;
        if self.signature.len() != 64 {
            return Err(Error::Signature);
        }
        Ok(Sha256::digest(signing_bytes(
            "rocketvibe-certificate-fingerprint-v1",
            self,
        )?)
        .into())
    }
    pub fn credential(&self) -> Result<Credential, Error> {
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > WIRE_LIMIT {
            return Err(Error::Limit);
        }
        Ok(BasicCredential::new(bytes).into())
    }
    pub fn from_credential(credential: &Credential) -> Result<Self, Error> {
        if credential.credential_type() != CredentialType::Basic {
            return Err(Error::Invalid);
        }
        if credential.serialized_content().len() > WIRE_LIMIT {
            return Err(Error::Limit);
        }
        // OpenMLS stores a BasicCredential's identity directly as content;
        // `Credential::deserialized` is for other TLS-encoded credential types.
        serde_json::from_slice(credential.serialized_content()).map_err(|_| Error::Invalid)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Revocation {
    pub root: Root,
    pub device: String,
    pub incarnation: [u8; 16],
    pub signature: Vec<u8>,
}
impl Revocation {
    fn body(&self) -> Result<Vec<u8>, Error> {
        self.root.validate()?;
        if !label(&self.device) || self.incarnation == [0; 16] {
            return Err(Error::Invalid);
        }
        signing_bytes(REVOKE_DOMAIN, &(&self.root, &self.device, self.incarnation))
    }
    pub fn verify(&self) -> Result<(), Error> {
        let signature = Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?;
        verifying_key(&self.root.public_key)?
            .verify_strict(&self.body()?, &signature)
            .map_err(|_| Error::Signature)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivateRoot {
    root: Root,
    seed: [u8; 32],
}
impl Drop for PrivateRoot {
    fn drop(&mut self) {
        self.seed.zeroize();
    }
}
/// No Clone, Debug or plaintext export API. Store only inside a Vault transaction.
pub struct Issuer {
    root: Root,
    signing: SigningKey,
}
impl Issuer {
    pub fn generate(instance: &str, user: &str) -> Result<Self, Error> {
        if !label(instance) || !label(user) {
            return Err(Error::Scope);
        }
        let seed = Zeroizing::new(random()?);
        let signing = SigningKey::from_bytes(&seed);
        let root = Root {
            version: 1,
            instance: instance.into(),
            user: user.into(),
            generation: random()?,
            public_key: signing.verifying_key().to_bytes(),
        };
        root.validate()?;
        Ok(Self { root, signing })
    }
    pub fn root(&self) -> &Root {
        &self.root
    }
    pub fn load(records: &Records, instance: &str, user: &str) -> Result<Self, Error> {
        let bytes = records.get(ROOT_RECORD).ok_or(Error::Untrusted)?;
        if bytes.len() > WIRE_LIMIT {
            return Err(Error::Limit);
        }
        let private: PrivateRoot = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        private.root.validate()?;
        if private.root.instance != instance || private.root.user != user {
            return Err(Error::Scope);
        }
        let signing = SigningKey::from_bytes(&private.seed);
        if signing.verifying_key().to_bytes() != private.root.public_key {
            return Err(Error::Signature);
        }
        Ok(Self {
            root: private.root.clone(),
            signing,
        })
    }
    pub fn save(&self, records: &mut Records) -> Result<(), Error> {
        if records.contains_key(ROOT_RECORD) {
            if Self::load(records, &self.root.instance, &self.root.user)?.root != self.root {
                return Err(Error::Changed);
            }
            return Ok(());
        }
        let private = PrivateRoot {
            root: self.root.clone(),
            seed: self.signing.to_bytes(),
        };
        let bytes = Zeroizing::new(serde_json::to_vec(&private).map_err(|_| Error::Invalid)?);
        records.insert(ROOT_RECORD.into(), bytes.to_vec());
        Ok(())
    }
    pub fn certify(
        &self,
        device: &str,
        incarnation: [u8; 16],
        signature_key: [u8; 32],
        issued_at: u64,
        expires_at: u64,
    ) -> Result<Certificate, Error> {
        let device = Device {
            version: 1,
            root: self.root.clone(),
            device: device.into(),
            incarnation,
            serial: random()?,
            suite: 1,
            signature_key,
            issued_at,
            expires_at,
        };
        device.validate()?;
        let signature = self
            .signing
            .sign(&signing_bytes(CERT_DOMAIN, &device)?)
            .to_bytes()
            .to_vec();
        Ok(Certificate { device, signature })
    }
    pub fn revoke(&self, device: &str, incarnation: [u8; 16]) -> Result<Revocation, Error> {
        let mut revoked = Revocation {
            root: self.root.clone(),
            device: device.into(),
            incarnation,
            signature: Vec::new(),
        };
        revoked.signature = self.signing.sign(&revoked.body()?).to_bytes().to_vec();
        Ok(revoked)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Trust {
    Unverified,
    Verified,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Observation {
    Unknown,
    Unverified,
    Verified,
    Changed,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Approved {
    incarnation: [u8; 16],
    signature_key: [u8; 32],
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin {
    root: Root,
    trust: Trust,
    devices: BTreeMap<String, Approved>,
    revoked: BTreeSet<(String, [u8; 16])>,
}
impl Pin {
    fn fingerprint(&self) -> Result<Fingerprint, Error> {
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > STATE_LIMIT {
            return Err(Error::Limit);
        }
        Ok(Sha256::digest(bytes).into())
    }
}
/// Local preview token. Never deserialize it from HTTP. The UI confirms the
/// exact certificate; any intervening pin/roster decision requires a new preview.
pub struct Consent {
    certificate: Fingerprint,
    pin: Fingerprint,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pins {
    version: u8,
    instance: String,
    peers: BTreeMap<String, Pin>,
}
/// Only returned after checking a real MLS KeyPackage against explicit pins.
pub struct AuthorizedDevice {
    root: Root,
    device: String,
    incarnation: [u8; 16],
    trust: Trust,
}
impl AuthorizedDevice {
    pub fn root(&self) -> &Root {
        &self.root
    }
    pub fn device(&self) -> &str {
        &self.device
    }
    pub fn incarnation(&self) -> [u8; 16] {
        self.incarnation
    }
    pub fn trust(&self) -> Trust {
        self.trust
    }
}
impl Pins {
    pub fn new(instance: &str) -> Result<Self, Error> {
        if !label(instance) {
            return Err(Error::Scope);
        }
        Ok(Self {
            version: 1,
            instance: instance.into(),
            peers: BTreeMap::new(),
        })
    }
    pub fn load(records: &Records, instance: &str) -> Result<Self, Error> {
        let Some(bytes) = records.get(TRUST_RECORD) else {
            return Self::new(instance);
        };
        if bytes.len() > STATE_LIMIT {
            return Err(Error::Limit);
        }
        let pins: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        if pins.version != 1 || pins.instance != instance || pins.peers.len() > MAX_PEERS {
            return Err(Error::Scope);
        }
        for (user, pin) in &pins.peers {
            pins.check_root(&pin.root)?;
            if *user != pin.root.user
                || pin.devices.len() > MAX_DEVICES
                || pin.revoked.len() > MAX_REVOKED
            {
                return Err(Error::Invalid);
            }
            for (device, approved) in &pin.devices {
                if !label(device) || approved.incarnation == [0; 16] {
                    return Err(Error::Invalid);
                }
                verifying_key(&approved.signature_key)?;
            }
            if pin
                .revoked
                .iter()
                .any(|(device, incarnation)| !label(device) || *incarnation == [0; 16])
            {
                return Err(Error::Invalid);
            }
        }
        Ok(pins)
    }
    pub fn save(&self, records: &mut Records) -> Result<(), Error> {
        let bytes = Zeroizing::new(serde_json::to_vec(self).map_err(|_| Error::Invalid)?);
        if bytes.len() > STATE_LIMIT {
            return Err(Error::Limit);
        }
        records.insert(TRUST_RECORD.into(), bytes.to_vec());
        Ok(())
    }
    fn check_root(&self, root: &Root) -> Result<(), Error> {
        root.validate()?;
        if root.instance != self.instance {
            return Err(Error::Scope);
        }
        Ok(())
    }
    pub fn observe(&self, root: &Root) -> Result<Observation, Error> {
        self.check_root(root)?;
        Ok(match self.peers.get(&root.user) {
            None => Observation::Unknown,
            Some(pin) if pin.root != *root => Observation::Changed,
            Some(pin) => match pin.trust {
                Trust::Unverified => Observation::Unverified,
                Trust::Verified => Observation::Verified,
            },
        })
    }
    /// Explicit first-contact consent for the exact displayed fingerprint.
    /// This is TOFU, not an out-of-band verification; no device is approved.
    pub fn accept_first(&mut self, root: Root, displayed: Fingerprint) -> Result<(), Error> {
        self.check_root(&root)?;
        if root.fingerprint()? != displayed {
            return Err(Error::Changed);
        }
        if let Some(pin) = self.peers.get(&root.user) {
            return if pin.root == root {
                Ok(())
            } else {
                Err(Error::Changed)
            };
        }
        if self.peers.len() >= MAX_PEERS {
            return Err(Error::Limit);
        }
        self.peers.insert(
            root.user.clone(),
            Pin {
                root,
                trust: Trust::Unverified,
                devices: BTreeMap::new(),
                revoked: BTreeSet::new(),
            },
        );
        Ok(())
    }
    /// Call only after human out-of-band confirmation, not an HTTP lookup.
    pub fn verify_root(&mut self, root: &Root, confirmed: Fingerprint) -> Result<(), Error> {
        self.check_root(root)?;
        let pin = self.peers.get_mut(&root.user).ok_or(Error::Untrusted)?;
        if pin.root != *root || root.fingerprint()? != confirmed {
            return Err(Error::Changed);
        }
        pin.trust = Trust::Verified;
        Ok(())
    }
    /// A root change requires both the previously observed and new confirmed
    /// fingerprints. Never inherit device approvals across this boundary.
    pub fn replace_verified(
        &mut self,
        previous: Fingerprint,
        root: Root,
        confirmed: Fingerprint,
    ) -> Result<(), Error> {
        self.check_root(&root)?;
        let pin = self.peers.get_mut(&root.user).ok_or(Error::Untrusted)?;
        if pin.root.fingerprint()? != previous
            || root.fingerprint()? != confirmed
            || pin.root == root
        {
            return Err(Error::Changed);
        }
        *pin = Pin {
            root,
            trust: Trust::Verified,
            devices: BTreeMap::new(),
            revoked: BTreeSet::new(),
        };
        Ok(())
    }
    pub fn preview_device(&self, certificate: &Certificate, now: u64) -> Result<Consent, Error> {
        certificate.verify(now)?;
        self.check_root(&certificate.device.root)?;
        let device = &certificate.device;
        let pin = self.peers.get(&device.root.user).ok_or(Error::Untrusted)?;
        if pin.root != device.root {
            return Err(Error::Changed);
        }
        if pin
            .revoked
            .contains(&(device.device.clone(), device.incarnation))
        {
            return Err(Error::Revoked);
        }
        if pin.devices.get(&device.device).is_some_and(|a| {
            a.incarnation == device.incarnation && a.signature_key != device.signature_key
        }) {
            return Err(Error::Changed);
        }
        Ok(Consent {
            certificate: certificate.fingerprint()?,
            pin: pin.fingerprint()?,
        })
    }
    /// Explicit device approval for the exact local preview shown to the human.
    /// Group membership still requires its independent signed roster/MLS commit.
    pub fn approve(
        &mut self,
        certificate: &Certificate,
        consent: &Consent,
        now: u64,
    ) -> Result<(), Error> {
        certificate.verify(now)?;
        self.check_root(&certificate.device.root)?;
        if certificate.fingerprint()? != consent.certificate {
            return Err(Error::Changed);
        }
        let device = &certificate.device;
        let pin = self
            .peers
            .get_mut(&device.root.user)
            .ok_or(Error::Untrusted)?;
        if pin.root != device.root {
            return Err(Error::Changed);
        }
        if pin
            .revoked
            .contains(&(device.device.clone(), device.incarnation))
        {
            return Err(Error::Revoked);
        }
        if let Some(approved) = pin.devices.get(&device.device)
            && approved.incarnation == device.incarnation
        {
            return if approved.signature_key == device.signature_key {
                Ok(())
            } else {
                Err(Error::Changed)
            };
        }
        if pin.fingerprint()? != consent.pin {
            return Err(Error::Changed);
        }
        if !pin.devices.contains_key(&device.device) && pin.devices.len() >= MAX_DEVICES {
            return Err(Error::Limit);
        }
        pin.devices.insert(
            device.device.clone(),
            Approved {
                incarnation: device.incarnation,
                signature_key: device.signature_key,
            },
        );
        Ok(())
    }
    pub fn apply_revocation(&mut self, revoked: &Revocation) -> Result<(), Error> {
        revoked.verify()?;
        self.check_root(&revoked.root)?;
        let pin = self
            .peers
            .get_mut(&revoked.root.user)
            .ok_or(Error::Untrusted)?;
        if pin.root != revoked.root {
            return Err(Error::Changed);
        }
        let subject = (revoked.device.clone(), revoked.incarnation);
        if !pin.revoked.contains(&subject) && pin.revoked.len() >= MAX_REVOKED {
            return Err(Error::Limit);
        }
        pin.revoked.insert(subject);
        if pin
            .devices
            .get(&revoked.device)
            .is_some_and(|a| a.incarnation == revoked.incarnation)
        {
            pin.devices.remove(&revoked.device);
        }
        Ok(())
    }
    /// The KeyPackage must first pass OpenMLS validation (including its signature
    /// and lifetime). Certificate and leaf signing key must agree exactly.
    pub fn authorize_key_package(
        &self,
        package: &KeyPackage,
        now: u64,
    ) -> Result<AuthorizedDevice, Error> {
        let certificate = Certificate::from_credential(package.leaf_node().credential())?;
        certificate.verify(now)?;
        self.check_root(&certificate.device.root)?;
        let device = certificate.device;
        if package.ciphersuite() as u16 != device.suite
            || package.leaf_node().signature_key().as_slice() != device.signature_key
        {
            return Err(Error::Signature);
        }
        let pin = self.peers.get(&device.root.user).ok_or(Error::Untrusted)?;
        if pin.root != device.root {
            return Err(Error::Changed);
        }
        if pin
            .revoked
            .contains(&(device.device.clone(), device.incarnation))
        {
            return Err(Error::Revoked);
        }
        let approved = pin.devices.get(&device.device).ok_or(Error::Unapproved)?;
        if approved.incarnation != device.incarnation
            || approved.signature_key != device.signature_key
        {
            return Err(Error::Unapproved);
        }
        Ok(AuthorizedDevice {
            root: device.root,
            device: device.device,
            incarnation: device.incarnation,
            trust: pin.trust,
        })
    }
}

#[cfg(test)]
mod tests;
