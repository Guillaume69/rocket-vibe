//! Opaque root backup and root-signed publication. No recovery key or decryption.
use super::*;
pub const PACKET_LIMIT: usize = 24 * 1024;
pub const PUBLICATION_LIMIT: usize = 32 * 1024;
pub const PUBLICATION_DOMAIN: &str = "rocketvibe-root-backup-publication-v1";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub version: u8,
    pub root: Root,
    pub backup_id: [u8; 16],
    pub created_at: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootBackup {
    pub header: Header,
    pub nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
}
impl RootBackup {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > PACKET_LIMIT {
            return Err(Error::Limit);
        }
        let packet: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        packet.validate()?;
        Ok(packet)
    }
    pub fn validate(&self) -> Result<(), Error> {
        self.header.root.validate()?;
        if self.header.version != 1
            || self.header.backup_id == [0; 16]
            || self.header.created_at > 253_402_300_799
        {
            return Err(Error::Invalid);
        }
        if self.ciphertext.len() < 16 || self.ciphertext.len() > WIRE_LIMIT + 16 {
            return Err(Error::Limit);
        }
        Ok(())
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > PACKET_LIMIT {
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
pub struct Scope {
    pub instance: String,
    pub data_epoch: String,
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
    pub packet_digest: Fingerprint,
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    pub body: PublicationBody,
    pub packet: RootBackup,
    pub signature: Vec<u8>,
}
impl Publication {
    pub fn verify(&self) -> Result<(), Error> {
        self.packet.validate()?;
        if self.body.scope.instance != self.packet.header.root.instance
            || self.body.packet_digest != self.packet.digest()?
        {
            return Err(Error::Scope);
        }
        verifying_key(&self.packet.header.root.public_key)?
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
        publication.verify()?;
        Ok(publication)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        self.verify()?;
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > PUBLICATION_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
}
