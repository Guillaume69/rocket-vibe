//! Public signed enrollment requests and root grants; neither implies admission.
use super::{Certificate, Error, Fingerprint, Root, label, signing_bytes, verifying_key};
use ed25519_dalek::Signature;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
pub const REQUEST_DOMAIN: &str = "rocketvibe-device-request-v1";
const GRANT_DOMAIN: &str = "rocketvibe-device-grant-v1";
pub const REQUEST_LIFETIME: u64 = 600;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestBody {
    pub version: u8,
    pub root: Root,
    pub device: String,
    pub incarnation: [u8; 16],
    pub request_id: [u8; 32],
    pub signature_key: [u8; 32],
    pub issued_at: u64,
    pub expires_at: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub body: RequestBody,
    pub signature: Vec<u8>,
}
impl Request {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > super::WIRE_LIMIT {
            return Err(Error::Limit);
        }
        serde_json::from_slice(bytes).map_err(|_| Error::Invalid)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > super::WIRE_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    /// Proof of possession only. The human still approves this exact request.
    pub fn verify(&self, now: u64) -> Result<(), Error> {
        let body = &self.body;
        body.root.validate()?;
        if body.version != 1
            || !label(&body.device)
            || body.incarnation == [0; 16]
            || body.request_id == [0; 32]
            || body.expires_at <= body.issued_at
            || body.expires_at - body.issued_at > REQUEST_LIFETIME
            || body.expires_at > 253_402_300_799
        {
            return Err(Error::Invalid);
        }
        let signature = Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?;
        verifying_key(&body.signature_key)?
            .verify_strict(&signing_bytes(REQUEST_DOMAIN, body)?, &signature)
            .map_err(|_| Error::Signature)?;
        if now < body.issued_at || now >= body.expires_at {
            return Err(Error::Expired);
        }
        Ok(())
    }
    pub fn fingerprint(&self) -> Result<Fingerprint, Error> {
        Ok(Sha256::digest(signing_bytes("rocketvibe-request-fingerprint-v1", self)?).into())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub request: Fingerprint,
    pub certificate: Certificate,
    pub signature: Vec<u8>,
}
impl Grant {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > 2 * super::WIRE_LIMIT {
            return Err(Error::Limit);
        }
        serde_json::from_slice(bytes).map_err(|_| Error::Invalid)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > 2 * super::WIRE_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    #[doc(hidden)]
    pub fn body(&self) -> Result<Vec<u8>, Error> {
        signing_bytes(GRANT_DOMAIN, &(self.request, &self.certificate))
    }
    pub fn verify(&self, now: u64) -> Result<(), Error> {
        self.certificate.verify(now)?;
        let signature = Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?;
        verifying_key(&self.certificate.device.root.public_key)?
            .verify_strict(&self.body()?, &signature)
            .map_err(|_| Error::Signature)
    }
}
