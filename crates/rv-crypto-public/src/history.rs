//! Public history-share request, manifest and share proofs. None of them grants
//! a read right: each device still checks its own directory, request and window.
use crate::{
    Certificate, Error, Fingerprint,
    archive::Header,
    groups::{Member, Scope},
    label, signing_bytes, verifying_key,
};
use ed25519_dalek::Signature;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const REQUEST_DOMAIN: &str = "rocketvibe-history-request-v1";
pub const SHARE_DOMAIN: &str = "rocketvibe-history-share-v1";
pub const CHAIN_DOMAIN: &str = "rocketvibe-history-chain-v1";
/// A request stays answerable for at most 7 days.
pub const REQUEST_LIFETIME: u64 = 7 * 86400;
pub const MAX_PERIODS: usize = 1024;
pub const SHARE_LIMIT: usize = 1024 * 1024;
pub const ENVELOPE_LIMIT: usize = 64 * 1024;
pub const RECORD_DOMAIN: &str = "rocketvibe-history-record-v1";
pub const RECORD_AAD_DOMAIN: &str = "rocketvibe-history-record-aad-v1";

/// Positions, counts and bounds stay exact for a JavaScript verifier.
mod decimal {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let text = String::deserialize(deserializer)?;
        let value: u64 = text.parse().map_err(serde::de::Error::custom)?;
        if value > i64::MAX as u64 || value.to_string() != text {
            return Err(serde::de::Error::custom("invalid decimal string"));
        }
        Ok(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestBody {
    pub version: u8,
    /// Current certificate of the requesting device; it carries the account root.
    pub certificate: Certificate,
    pub request_id: [u8; 32],
    /// X25519 public key drawn for this request only.
    pub recipient: [u8; 32],
    #[serde(with = "decimal")]
    pub issued_at: u64,
    #[serde(with = "decimal")]
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
        if bytes.len() > crate::WIRE_LIMIT {
            return Err(Error::Limit);
        }
        serde_json::from_slice(bytes).map_err(|_| Error::Invalid)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > crate::WIRE_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    #[doc(hidden)]
    pub fn body_bytes(&self) -> Result<Vec<u8>, Error> {
        signing_bytes(REQUEST_DOMAIN, &self.body)
    }
    /// Shape, current certificate, window and proof of possession. Trust in the
    /// certificate (same pinned root, listed, not revoked) is the caller's check.
    pub fn verify(&self, now: u64) -> Result<(), Error> {
        let body = &self.body;
        body.certificate.verify(now)?;
        if body.version != 1
            || body.request_id == [0; 32]
            || body.recipient == [0; 32]
            || body.expires_at <= body.issued_at
            || body.expires_at - body.issued_at > REQUEST_LIFETIME
            || body.expires_at > 253_402_300_799
        {
            return Err(Error::Invalid);
        }
        let signature = Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?;
        verifying_key(&body.certificate.device.signature_key)?
            .verify_strict(&self.body_bytes()?, &signature)
            .map_err(|_| Error::Signature)?;
        if now < body.issued_at || now >= body.expires_at {
            return Err(Error::Expired);
        }
        Ok(())
    }
    pub fn fingerprint(&self) -> Result<Fingerprint, Error> {
        Ok(Sha256::digest(signing_bytes(
            "rocketvibe-history-request-fingerprint-v1",
            self,
        )?)
        .into())
    }
}

/// One membership period the sharing device holds for one room.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Period {
    pub scope: Scope,
    /// The account's personal grant during this period.
    pub grant: Member,
    /// Witness of the sharing device's admission that observed this period.
    pub admission: Fingerprint,
    #[serde(with = "decimal")]
    pub first: u64,
    #[serde(with = "decimal")]
    pub last: u64,
    #[serde(with = "decimal")]
    pub count: u64,
    /// Chain digest over the packet fingerprints in position order.
    pub chain: Fingerprint,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u8,
    pub request: Fingerprint,
    pub periods: Vec<Period>,
}
impl Manifest {
    pub fn validate(&self) -> Result<(), Error> {
        if self.version != 1 || self.periods.is_empty() || self.periods.len() > MAX_PERIODS {
            return Err(Error::Invalid);
        }
        for period in &self.periods {
            if !label(&period.scope.instance)
                || !label(&period.scope.data_epoch)
                || !label(&period.scope.room)
                || period.scope.incarnation == [0; 16]
                || !label(&period.grant.user)
                || !label(&period.grant.access_version)
                || !label(&period.grant.activation_version)
                || period.first == 0
                || period.last < period.first
                || period.count == 0
                || period.count > period.last - period.first + 1
            {
                return Err(Error::Invalid);
            }
        }
        // One account per share: every period belongs to the same grant user.
        let user = &self.periods[0].grant.user;
        if self.periods.iter().any(|p| &p.grant.user != user) {
            return Err(Error::Scope);
        }
        Ok(())
    }
    pub fn digest(&self) -> Result<Fingerprint, Error> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > SHARE_LIMIT {
            return Err(Error::Limit);
        }
        let mut hash = Sha256::new();
        hash.update(b"rocketvibe-history-manifest-v1\0");
        hash.update(&bytes);
        Ok(hash.finalize().into())
    }
}

/// The chain digest of an empty period.
pub fn chain_start() -> Result<Fingerprint, Error> {
    Ok(Sha256::digest(signing_bytes(CHAIN_DOMAIN, &())?).into())
}
/// Folds the next packet fingerprint into a running chain digest.
pub fn chain_next(head: Fingerprint, fingerprint: Fingerprint) -> Result<Fingerprint, Error> {
    Ok(Sha256::digest(signing_bytes(CHAIN_DOMAIN, &(head, fingerprint))?).into())
}
/// Folds packet fingerprints, in position order, into a period's chain digest.
pub fn chain(fingerprints: impl IntoIterator<Item = Fingerprint>) -> Result<Fingerprint, Error> {
    let mut head = chain_start()?;
    for fingerprint in fingerprints {
        head = chain_next(head, fingerprint)?;
    }
    Ok(head)
}

/// HPKE base-mode output (RFC 9180): encapsulated key and ciphertext.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub kem_output: Vec<u8>,
    pub ciphertext: Vec<u8>,
}
impl Envelope {
    pub fn digest(&self) -> Result<Fingerprint, Error> {
        if self.kem_output.len() != 32
            || self.ciphertext.is_empty()
            || self.ciphertext.len() > ENVELOPE_LIMIT
        {
            return Err(Error::Invalid);
        }
        let mut hash = Sha256::new();
        hash.update(b"rocketvibe-history-envelope-v1\0");
        hash.update(self.kem_output.as_slice());
        hash.update(self.ciphertext.as_slice());
        Ok(hash.finalize().into())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Share {
    pub manifest: Manifest,
    pub envelope: Envelope,
    /// Current certificate of the sharing device.
    pub certificate: Certificate,
    pub signature: Vec<u8>,
}
impl Share {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > SHARE_LIMIT {
            return Err(Error::Limit);
        }
        serde_json::from_slice(bytes).map_err(|_| Error::Invalid)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > SHARE_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    #[doc(hidden)]
    pub fn signing_bytes(&self) -> Result<Vec<u8>, Error> {
        signing_bytes(
            SHARE_DOMAIN,
            &(
                self.manifest.request,
                self.manifest.digest()?,
                self.envelope.digest()?,
                self.certificate.fingerprint()?,
            ),
        )
    }
    /// Shape, current sharing certificate and its signature. The receiving
    /// device still checks that this certificate is one of its own account's
    /// listed, unrevoked devices and that `request` is its pending request.
    pub fn verify(&self, now: u64) -> Result<(), Error> {
        self.certificate.verify(now)?;
        let signature = Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?;
        verifying_key(&self.certificate.device.signature_key)?
            .verify_strict(&self.signing_bytes()?, &signature)
            .map_err(|_| Error::Signature)?;
        if self.manifest.periods[0].grant.user != self.certificate.device.root.user {
            return Err(Error::Scope);
        }
        Ok(())
    }
}

/// One recovered document: the v1 archive header (exact origin receipt, the
/// author's membership, key ID, nonce), the author's original certificate, and
/// an attestation by the sharing device that its account observed it. Unlike an
/// archive packet, the sharing device need not share the author's root; its own
/// domains keep a record from ever passing as an author-signed archive packet.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub header: Header,
    pub original_certificate: Certificate,
    /// Certificate of the sharing device that attests the observation.
    pub certificate: Certificate,
    pub ciphertext: Vec<u8>,
    pub signature: Vec<u8>,
}
impl Record {
    /// Associated data of the document's AEAD.
    pub fn aad(&self) -> Result<Vec<u8>, Error> {
        self.header.validate()?;
        signing_bytes(RECORD_AAD_DOMAIN, &self.header)
    }
    pub fn signing_bytes(&self) -> Result<Vec<u8>, Error> {
        self.header.validate()?;
        self.certificate.device.validate()?;
        self.original_certificate.device.validate()?;
        let route = &self.header.origin.header;
        let author = &self.original_certificate.device;
        if author.root.instance != route.scope.instance
            || author.root.user != route.author
            || author.device != route.device
            || author.incarnation != route.incarnation
            || self.original_certificate.fingerprint()? != route.certificate
            || self.certificate.device.root.instance != route.scope.instance
        {
            return Err(Error::Scope);
        }
        if self.ciphertext.len() <= 16 || self.ciphertext.len() > crate::archive::CIPHERTEXT_LIMIT {
            return Err(Error::Limit);
        }
        let ciphertext: Fingerprint = Sha256::digest(&self.ciphertext).into();
        signing_bytes(
            RECORD_DOMAIN,
            &(
                &self.header,
                self.original_certificate.fingerprint()?,
                self.certificate.fingerprint()?,
                ciphertext,
            ),
        )
    }
    /// Shape and signatures. Whether the attesting device is trusted (same
    /// account, listed, not revoked) is the receiver's check.
    pub fn authenticate(&self) -> Result<(), Error> {
        let body = self.signing_bytes()?;
        self.certificate.authenticate()?;
        self.original_certificate.authenticate()?;
        let signature = Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?;
        verifying_key(&self.certificate.device.signature_key)?
            .verify_strict(&body, &signature)
            .map_err(|_| Error::Signature)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        self.signing_bytes()?;
        if self.signature.len() != 64 {
            return Err(Error::Signature);
        }
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > crate::archive::WIRE_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.is_empty() || bytes.len() > crate::archive::WIRE_LIMIT {
            return Err(Error::Limit);
        }
        let record: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        if record.to_bytes()? != bytes {
            return Err(Error::Invalid);
        }
        Ok(record)
    }
    pub fn digest(&self) -> Result<Fingerprint, Error> {
        let mut digest = Sha256::new();
        digest.update(b"rocketvibe-history-record-fingerprint-v1\0");
        digest.update(self.to_bytes()?);
        Ok(digest.finalize().into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_vector_authenticates_request_share_and_chained_records() {
        // Disposable certificates; the envelope and the documents are opened by
        // rv-crypto and by scripts/verify-history-vector.mjs.
        #[derive(Deserialize)]
        struct Vector {
            request: Request,
            share: Share,
            records: Vec<Record>,
        }
        let vector: Vector =
            serde_json::from_slice(include_bytes!("../fixtures/history-share-v1.json")).unwrap();
        let now = vector.request.body.issued_at + 3;
        vector.request.verify(now).unwrap();
        vector.share.verify(now).unwrap();
        assert_eq!(
            vector.share.manifest.request,
            vector.request.fingerprint().unwrap()
        );
        let period = &vector.share.manifest.periods[0];
        for record in &vector.records {
            record.authenticate().unwrap();
            assert!(Record::from_bytes(&record.to_bytes().unwrap()).unwrap() == *record);
        }
        assert_eq!(
            chain(vector.records.iter().map(|r| r.digest().unwrap())).unwrap(),
            period.chain
        );
        let mut changed = vector.records[1].clone();
        changed.header.origin.header.thread = None;
        assert!(changed.authenticate().is_err());
        let mut changed = vector.records[0].clone();
        changed.certificate = vector.request.body.certificate.clone();
        assert!(changed.authenticate().is_err());
        let mut changed = vector.share.clone();
        changed.manifest.periods[0].count = 1;
        assert!(changed.verify(now).is_err());
        // The request expires with its window.
        assert!(
            vector
                .request
                .verify(vector.request.body.expires_at)
                .is_err()
        );
    }
}
