//! Immutable encrypted documents, separate from MLS sending ratchets.
//! Authentication alone proves neither admission, delivery time nor read rights.
use crate::{
    Certificate, Error, Fingerprint, groups::Member, messages::Receipt, signing_bytes,
    verifying_key,
};
use ed25519_dalek::Signature;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PLAIN_LIMIT: usize = 64 * 1024;
pub const CIPHERTEXT_LIMIT: usize = PLAIN_LIMIT + 16;
pub const WIRE_LIMIT: usize = 384 * 1024;
pub const DOMAIN: &str = "rocketvibe-archive-document-proof-v1";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub version: u8,
    #[serde(with = "origin_wire")]
    pub origin: Receipt,
    /// The author's original membership, never the reader's current grant.
    pub author_membership: Member,
    pub key_id: [u8; 16],
    pub nonce: [u8; 24],
}
// Keep every revision/epoch/position exact when a public verifier uses JS.
// The rest of the origin uses the existing strict message receipt structure.
mod origin_wire {
    use super::*;
    use serde::{Deserializer, Serializer};
    pub fn serialize<S: Serializer>(receipt: &Receipt, serializer: S) -> Result<S::Ok, S::Error> {
        let mut value = serde_json::to_value(receipt).map_err(serde::ser::Error::custom)?;
        value["position"] = receipt.position.to_string().into();
        value["header"]["group_revision"] = receipt.header.group_revision.to_string().into();
        value["header"]["epoch"] = receipt.header.epoch.to_string().into();
        // Keep framing stable even if another workspace enables preserve_order.
        value.sort_all_objects();
        value.serialize(serializer)
    }
    fn exact(value: &mut serde_json::Value, field: &str, zero: bool) -> Result<(), &'static str> {
        let text = value
            .get(field)
            .and_then(serde_json::Value::as_str)
            .ok_or("decimal string required")?;
        let number: u64 = text.parse().map_err(|_| "invalid decimal string")?;
        if (!zero && number == 0) || number > i64::MAX as u64 || number.to_string() != text {
            return Err("invalid decimal string");
        }
        value[field] = number.into();
        Ok(())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Receipt, D::Error> {
        let mut value = serde_json::Value::deserialize(deserializer)?;
        exact(&mut value, "position", false).map_err(serde::de::Error::custom)?;
        let header = value
            .get_mut("header")
            .ok_or_else(|| serde::de::Error::custom("missing header"))?;
        exact(header, "group_revision", false).map_err(serde::de::Error::custom)?;
        exact(header, "epoch", true).map_err(serde::de::Error::custom)?;
        serde_json::from_value(value).map_err(serde::de::Error::custom)
    }
}
fn revision(text: &str) -> bool {
    text.parse::<i64>()
        .is_ok_and(|v| v > 0 && v.to_string() == text)
}
impl Header {
    pub fn validate(&self) -> Result<(), Error> {
        self.origin.validate()?;
        if self.version != 1
            || self.key_id == [0; 16]
            || self.nonce == [0; 24]
            || self.author_membership.user != self.origin.header.author
            || !revision(&self.author_membership.access_version)
            || !revision(&self.author_membership.activation_version)
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    pub fn aad(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        signing_bytes("rocketvibe-archive-document-aad-v1", self)
    }
}

// Opaque ciphertext must not be printed by a diagnostic formatter.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Packet {
    pub header: Header,
    pub original_certificate: Certificate,
    /// Current archive signer, possibly another approved leaf of the same root.
    pub certificate: Certificate,
    pub ciphertext: Vec<u8>,
    pub signature: Vec<u8>,
}
impl Packet {
    pub fn signing_bytes(&self) -> Result<Vec<u8>, Error> {
        self.header.validate()?;
        self.certificate.device.validate()?;
        self.original_certificate.device.validate()?;
        let route = &self.header.origin.header;
        let device = &self.original_certificate.device;
        if device.root.instance != route.scope.instance
            || device.root.user != route.author
            || device.device != route.device
            || device.incarnation != route.incarnation
            || self.original_certificate.fingerprint()? != route.certificate
            || self.certificate.device.root != device.root
        {
            return Err(Error::Scope);
        }
        if self.ciphertext.len() <= 16 || self.ciphertext.len() > CIPHERTEXT_LIMIT {
            return Err(Error::Limit);
        }
        let ciphertext: Fingerprint = Sha256::digest(&self.ciphertext).into();
        signing_bytes(
            DOMAIN,
            &(
                &self.header,
                self.original_certificate.fingerprint()?,
                self.certificate.fingerprint()?,
                ciphertext,
            ),
        )
    }
    /// Shape/signatures only. A stored observation or explicit archive admission
    /// is still required; a server timestamp cannot establish pre-withdrawal use.
    pub fn authenticate(&self) -> Result<(), Error> {
        let body = self.signing_bytes()?;
        self.certificate.authenticate()?;
        self.original_certificate.authenticate()?;
        let signature = Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?;
        verifying_key(&self.certificate.device.signature_key)?
            .verify_strict(&body, &signature)
            .map_err(|_| Error::Signature)
    }
    pub fn verify_current(&self, now: u64) -> Result<(), Error> {
        self.authenticate()?;
        self.certificate.verify(now)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        self.signing_bytes()?;
        if self.signature.len() != 64 {
            return Err(Error::Signature);
        }
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > WIRE_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.is_empty() || bytes.len() > WIRE_LIMIT {
            return Err(Error::Limit);
        }
        let packet: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        if packet.to_bytes()? != bytes {
            return Err(Error::Invalid);
        }
        Ok(packet)
    }
    pub fn digest(&self) -> Result<Fingerprint, Error> {
        let mut digest = Sha256::new();
        digest.update(b"rocketvibe-archive-document-fingerprint-v1\0");
        digest.update(self.to_bytes()?);
        Ok(digest.finalize().into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_vector_authenticates_and_preserves_exact_original_receipt() {
        // Disposable certificate, synthetic origin receipt, real AEAD packet.
        // This vector is not proof of an MLS admission or a server acceptance.
        let packet =
            Packet::from_bytes(include_bytes!("../fixtures/archive-document-v1.json")).unwrap();
        packet.authenticate().unwrap();
        assert_eq!(packet.header.origin.position, 9_007_199_254_740_995);
        assert_eq!(
            packet.header.origin.header.group_revision,
            9_007_199_254_740_993
        );
        assert!(
            packet
                .verify_current(packet.certificate.device.expires_at)
                .is_err()
        );
        let mut changed = packet.clone();
        changed.header.origin.header.scope.room = "foreign".into();
        assert!(changed.authenticate().is_err());
        let mut changed = packet.clone();
        changed.certificate.device.incarnation[0] ^= 1;
        assert!(changed.authenticate().is_err());
    }
}
