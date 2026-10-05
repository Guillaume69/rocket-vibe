//! Public formats of the history backup (E2EE_HISTORY_BACKUP.md): the key
//! package sealed under the history code, its device-signed publication and the
//! signed checkpoints of backed-up periods. No key, code or decryption here.
use super::*;
use crate::groups::{Member, Scope as GroupScope};
use crate::recovery::Scope;

pub const PACKAGE_LIMIT: usize = 4096;
pub const PUBLICATION_LIMIT: usize = 16 * 1024;
pub const PUBLICATION_DOMAIN: &str = "rocketvibe-history-key-publication-v1";
pub const CHECKPOINT_DOMAIN: &str = "rocketvibe-history-backup-checkpoint-v1";
pub const KEY_DOMAIN: &str = "rocketvibe-history-key-v1";
pub const PERIOD_DOMAIN: &str = "rocketvibe-history-backup-period-v1";

/// Positions, counts and times stay exact for a JavaScript verifier.
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
pub struct KeyHeader {
    pub version: u8,
    pub root: Root,
    /// Random identifier of this history key generation.
    pub generation: [u8; 16],
    #[serde(with = "decimal")]
    pub created_at: u64,
}
/// The history key sealed under the history code's key (XChaCha20-Poly1305,
/// AAD = `KEY_DOMAIN` NUL compact JSON header).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyPackage {
    pub header: KeyHeader,
    pub nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
}
impl KeyPackage {
    pub fn validate(&self) -> Result<(), Error> {
        self.header.root.validate()?;
        if self.header.version != 1
            || self.header.generation == [0; 16]
            || self.header.created_at == 0
            || self.header.created_at > 253_402_300_799
        {
            return Err(Error::Invalid);
        }
        // {generation, key} as JSON, plus the tag.
        if self.ciphertext.len() < 16 || self.ciphertext.len() > 1024 {
            return Err(Error::Limit);
        }
        Ok(())
    }
    pub fn aad(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        signing_bytes(KEY_DOMAIN, &self.header)
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > PACKAGE_LIMIT {
            return Err(Error::Limit);
        }
        let package: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        package.validate()?;
        Ok(package)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > PACKAGE_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    pub fn digest(&self) -> Result<Fingerprint, Error> {
        Ok(Sha256::digest(self.to_bytes()?).into())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationBody {
    pub version: u8,
    pub scope: Scope,
    pub operation: String,
    pub device: String,
    pub incarnation: [u8; 16],
    pub device_revision: String,
    pub expected_revision: Option<String>,
    pub package_digest: Fingerprint,
}
fn revision(value: &str) -> bool {
    value
        .parse::<i64>()
        .is_ok_and(|n| n > 0 && n.to_string() == value)
}
impl PublicationBody {
    pub fn validate(&self) -> Result<(), Error> {
        if self.version != 1
            || !label(&self.scope.instance)
            || !label(&self.scope.data_epoch)
            || !label(&self.operation)
            || self.operation.len() > 128
            || !label(&self.device)
            || self.incarnation == [0; 16]
            || !revision(&self.device_revision)
            || self
                .expected_revision
                .as_ref()
                .is_some_and(|r| !revision(r))
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    pub fn signing_bytes(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        signing_bytes(PUBLICATION_DOMAIN, self)
    }
}
/// A new history key generation, signed by the leaf of the publishing device.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    pub body: PublicationBody,
    pub package: KeyPackage,
    pub signature: Vec<u8>,
}
impl Publication {
    /// Shape, binding to the package and the publishing device's signature.
    /// That the certificate is the account's registered device is the caller's
    /// check (server: its registration; client: its verified directory).
    pub fn verify(&self, certificate: &Certificate) -> Result<(), Error> {
        self.package.validate()?;
        certificate.authenticate()?;
        let device = &certificate.device;
        if self.body.scope.instance != self.package.header.root.instance
            || device.root != self.package.header.root
            || device.device != self.body.device
            || device.incarnation != self.body.incarnation
            || self.body.package_digest != self.package.digest()?
        {
            return Err(Error::Scope);
        }
        verifying_key(&device.signature_key)?
            .verify_strict(
                &self.body.signing_bytes()?,
                &Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?,
            )
            .map_err(|_| Error::Signature)
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > PUBLICATION_LIMIT {
            return Err(Error::Limit);
        }
        let publication: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        publication.package.validate()?;
        publication.body.validate()?;
        Ok(publication)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        self.package.validate()?;
        self.body.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > PUBLICATION_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
}

/// One uploader's membership period: the path A binding (room scope, personal
/// grant, admission witness) and the uploading device. Certificate renewal keeps
/// the device and incarnation, so a period continues across it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Period {
    pub scope: GroupScope,
    pub grant: Member,
    pub admission: Fingerprint,
    pub device: String,
    pub incarnation: [u8; 16],
}
impl Period {
    pub fn validate(&self) -> Result<(), Error> {
        if !label(&self.scope.instance)
            || !label(&self.scope.data_epoch)
            || !label(&self.scope.room)
            || self.scope.incarnation == [0; 16]
            || !label(&self.grant.user)
            || !label(&self.grant.access_version)
            || !label(&self.grant.activation_version)
            || !label(&self.device)
            || self.incarnation == [0; 16]
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    /// The period's identifier within a generation, used as the server route.
    pub fn id(&self, generation: &[u8; 16]) -> Result<Fingerprint, Error> {
        self.validate()?;
        Ok(Sha256::digest(signing_bytes(PERIOD_DOMAIN, &(generation, self))?).into())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointBody {
    pub version: u8,
    pub generation: [u8; 16],
    pub period: Period,
    /// Ranks held, `1..=count`, with the positions of the first and last.
    #[serde(with = "decimal")]
    pub count: u64,
    #[serde(with = "decimal")]
    pub first: u64,
    #[serde(with = "decimal")]
    pub last: u64,
    /// Chain digest of the record fingerprints in rank order (history::chain).
    pub chain: Fingerprint,
}
/// A period's progress, signed by the uploading device's current certificate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub body: CheckpointBody,
    pub certificate: Certificate,
    pub signature: Vec<u8>,
}
impl Checkpoint {
    pub fn signing_bytes(&self) -> Result<Vec<u8>, Error> {
        let body = &self.body;
        body.period.validate()?;
        if body.version != 1
            || body.generation == [0; 16]
            || body.count == 0
            || body.first == 0
            || body.last < body.first
            || body.count > body.last - body.first + 1
            || self.certificate.device.device != body.period.device
            || self.certificate.device.incarnation != body.period.incarnation
            || self.certificate.device.root.user != body.period.grant.user
            || self.certificate.device.root.instance != body.period.scope.instance
        {
            return Err(Error::Invalid);
        }
        signing_bytes(CHECKPOINT_DOMAIN, &(body, self.certificate.fingerprint()?))
    }
    /// Shape and the uploader's signature. That the certificate chains to the
    /// account's pinned root is the caller's check.
    pub fn verify(&self) -> Result<(), Error> {
        let bytes = self.signing_bytes()?;
        self.certificate.authenticate()?;
        verifying_key(&self.certificate.device.signature_key)?
            .verify_strict(
                &bytes,
                &Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?,
            )
            .map_err(|_| Error::Signature)
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > WIRE_LIMIT * 2 {
            return Err(Error::Limit);
        }
        let checkpoint: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        checkpoint.verify()?;
        Ok(checkpoint)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        self.verify()?;
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > WIRE_LIMIT * 2 {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
}
