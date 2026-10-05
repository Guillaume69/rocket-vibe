//! Public E2EE proof formats and verification shared by server and clients.
//! No private signing key, storage, recovery secret or trust/admission state.
#![forbid(unsafe_code)]
use ed25519_dalek::{Signature, VerifyingKey};
use openmls::prelude::{BasicCredential, Credential, CredentialType};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub mod archive;
pub mod enrollment;
pub mod groups;
pub mod messages;
pub mod recovery;
pub const WIRE_LIMIT: usize = 4096;
pub const MAX_LIFETIME: u64 = 90 * 86400;
pub const CERT_DOMAIN: &str = "rocketvibe-device-certificate-v1";
pub const REVOKE_DOMAIN: &str = "rocketvibe-device-revocation-v1";

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
#[doc(hidden)]
pub fn label(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
#[doc(hidden)]
pub fn signing_bytes(domain: &str, value: &impl Serialize) -> Result<Vec<u8>, Error> {
    let payload = serde_json::to_vec(value).map_err(|_| Error::Invalid)?;
    if payload.len() > WIRE_LIMIT {
        return Err(Error::Limit);
    }
    let mut bytes = domain.as_bytes().to_vec();
    bytes.push(0);
    bytes.extend(payload);
    Ok(bytes)
}
#[doc(hidden)]
pub fn verifying_key(bytes: &[u8; 32]) -> Result<VerifyingKey, Error> {
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
    pub fn validate(&self) -> Result<(), Error> {
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
    pub fn validate(&self) -> Result<(), Error> {
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
    /// Cryptographic signature/shape only. No current validity, trust,
    /// admission or proof of possession is granted by this historical check.
    pub fn authenticate(&self) -> Result<(), Error> {
        self.device.validate()?;
        let signature = Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?;
        verifying_key(&self.device.root.public_key)?
            .verify_strict(&signing_bytes(CERT_DOMAIN, &self.device)?, &signature)
            .map_err(|_| Error::Signature)?;
        Ok(())
    }
    /// Current signature/shape/lifetime; still not trust or admission.
    pub fn verify(&self, now: u64) -> Result<(), Error> {
        self.authenticate()?;
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
    #[doc(hidden)]
    pub fn body(&self) -> Result<Vec<u8>, Error> {
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
