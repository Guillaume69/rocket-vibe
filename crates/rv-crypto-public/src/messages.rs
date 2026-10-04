//! Public application routing and device proof. No private MLS state or keys.
use crate::{Certificate, Error, Fingerprint, groups::Scope, verifying_key};
use ed25519_dalek::Signature;
use openmls::prelude::{ContentType, MlsMessageIn, WireFormat, tls_codec::Deserialize as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PROOF_LIMIT: usize = 16 * 1024;
pub const CIPHERTEXT_LIMIT: usize = 128 * 1024;
pub const DOMAIN: &str = "rocketvibe-mls-application-proof-v1";

pub fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Chat,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub version: u8,
    pub scope: Scope,
    pub operation: String,
    pub group_revision: u64,
    pub epoch: u64,
    pub group_fingerprint: Fingerprint,
    pub author: String,
    pub device: String,
    pub incarnation: [u8; 16],
    pub certificate: Fingerprint,
    pub kind: Kind,
    pub thread: Option<String>,
}
impl Header {
    pub fn validate(&self) -> Result<(), Error> {
        self.scope.group_id()?;
        if self.version != 1
            || !identifier(&self.operation)
            || !identifier(&self.author)
            || !identifier(&self.device)
            || self.incarnation == [0; 16]
            || self.group_revision == 0
            || self.group_revision > i64::MAX as u64
            || self.epoch > i64::MAX as u64
            || self.group_fingerprint == [0; 32]
            || self.certificate == [0; 32]
            || self
                .thread
                .as_ref()
                .is_some_and(|s| !identifier(s) || s == &self.operation)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    pub fn aad(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        let mut result = b"rocketvibe-mls-application-routing-v1\0".to_vec();
        result.extend(serde_json::to_vec(self).map_err(|_| Error::Invalid)?);
        if result.len() > PROOF_LIMIT {
            return Err(Error::Limit);
        }
        Ok(result)
    }
}

// No Debug: even an opaque encrypted payload must not enter diagnostics.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Proof {
    pub header: Header,
    pub certificate: Certificate,
    pub ciphertext: Fingerprint,
    pub signature: Vec<u8>,
}
impl Proof {
    /// Canonical bytes and identity bindings to sign. Authentication belongs
    /// to `authenticate`; `verify` also requires current certificate validity.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, Error> {
        self.header.validate()?;
        let certificate = &self.certificate;
        certificate.device.validate()?;
        let device = &certificate.device;
        if device.root.instance != self.header.scope.instance
            || device.root.user != self.header.author
            || device.device != self.header.device
            || device.incarnation != self.header.incarnation
            || certificate.fingerprint()? != self.header.certificate
            || self.ciphertext == [0; 32]
        {
            return Err(Error::Scope);
        }
        crate::signing_bytes(
            DOMAIN,
            &(&self.header, self.header.certificate, self.ciphertext),
        )
    }
    pub fn verify(&self, now: u64, ciphertext: &[u8]) -> Result<(), Error> {
        self.verify_inner(Some(now), ciphertext)
    }
    /// Authenticate historical bytes and certificate signatures, without
    /// claiming current validity, delivery time, admission or key trust.
    pub fn authenticate(&self, ciphertext: &[u8]) -> Result<(), Error> {
        self.verify_inner(None, ciphertext)
    }
    fn verify_inner(&self, now: Option<u64>, ciphertext: &[u8]) -> Result<(), Error> {
        if self.signature.len() != 64
            || ciphertext.is_empty()
            || ciphertext.len() > CIPHERTEXT_LIMIT
        {
            return Err(Error::Limit);
        }
        let body = self.signing_bytes()?;
        match now {
            Some(now) => self.certificate.verify(now)?,
            None => self.certificate.authenticate()?,
        }
        if Sha256::digest(ciphertext).as_slice() != self.ciphertext {
            return Err(Error::Changed);
        }
        let protocol = MlsMessageIn::tls_deserialize_exact(ciphertext)
            .map_err(|_| Error::Invalid)?
            .try_into_protocol_message()
            .map_err(|_| Error::Invalid)?;
        if protocol.wire_format() != WireFormat::PrivateMessage
            || protocol.content_type() != ContentType::Application
            || protocol.group_id().as_slice() != self.header.scope.group_id()?
            || protocol.epoch().as_u64() != self.header.epoch
        {
            return Err(Error::Invalid);
        }
        verifying_key(&self.certificate.device.signature_key)?
            .verify_strict(
                &body,
                &Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?,
            )
            .map_err(|_| Error::Signature)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        self.signing_bytes()?;
        if self.signature.len() != 64 {
            return Err(Error::Signature);
        }
        let result = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if result.len() > PROOF_LIMIT {
            return Err(Error::Limit);
        }
        Ok(result)
    }
    /// Bounded canonical decoding. Authenticate signatures and apply the
    /// relevant current/read policy before accepting this proof.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.is_empty() || bytes.len() > PROOF_LIMIT {
            return Err(Error::Limit);
        }
        let proof: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        if proof.to_bytes()? != bytes {
            return Err(Error::Invalid);
        }
        Ok(proof)
    }
    pub fn fingerprint(&self) -> Result<Fingerprint, Error> {
        let mut digest = Sha256::new();
        digest.update(b"rocketvibe-mls-application-fingerprint-v1\0");
        digest.update(self.to_bytes()?);
        Ok(digest.finalize().into())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub header: Header,
    pub fingerprint: Fingerprint,
    pub message: String,
    /// Native journal position, represented as a decimal string at HTTP/JS.
    pub position: u64,
}
impl Receipt {
    pub fn validate(&self) -> Result<(), Error> {
        self.header.validate()?;
        if !identifier(&self.message)
            || self.position == 0
            || self.position > i64::MAX as u64
            || self.fingerprint == [0; 32]
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    pub fn matches(&self, proof: &Proof) -> Result<(), Error> {
        self.validate()?;
        if self.header != proof.header || self.fingerprint != proof.fingerprint()? {
            return Err(Error::Changed);
        }
        Ok(())
    }
}
