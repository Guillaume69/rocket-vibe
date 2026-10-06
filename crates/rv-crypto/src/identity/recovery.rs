//! Encrypted account-root backup, never a snapshot of an MLS sending state.
use super::{Error, Issuer, PrivateRoot, Root, random, signing_bytes};
use crate::vault::Records;
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use ed25519_dalek::Signer as _;
use ed25519_dalek::SigningKey;
use openmls::prelude::OpenMlsProvider;
use openmls_rust_crypto::OpenMlsRustCrypto;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

const DOMAIN: &str = "rocketvibe-root-recovery-v1";
const CODE_DOMAIN: &[u8] = b"rocketvibe-recovery-code-v1\0";
const PACKET_LIMIT: usize = 24 * 1024;
const RESTORE_RECORD: &str = "crypto-recovery-import-v1";
impl Issuer {
    /// Authenticates an opaque packet without exporting the root signing key.
    pub fn publish_backup(
        &self,
        backup: &RootBackup,
        body: rv_crypto_public::recovery::PublicationBody,
    ) -> Result<rv_crypto_public::recovery::Publication, Error> {
        let packet = rv_crypto_public::recovery::RootBackup::from_bytes(&backup.to_bytes()?)?;
        if packet.header.root != self.root || body.packet_digest != packet.digest()? {
            return Err(Error::Changed);
        }
        let signature = self
            .signing
            .sign(&body.signing_bytes()?)
            .to_bytes()
            .to_vec();
        let publication = rv_crypto_public::recovery::Publication {
            body,
            packet,
            signature,
        };
        publication.verify()?;
        Ok(publication)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreReceipt {
    version: u8,
    root: super::Fingerprint,
    backup: super::Fingerprint,
}

/// 256-bit OS-random recovery key. No Debug/Clone/serde or raw-byte export.
pub struct RecoverySecret(Zeroizing<[u8; 32]>);
fn checksum(key: &[u8; 32]) -> [u8; 4] {
    let mut digest = Sha256::new();
    digest.update(CODE_DOMAIN);
    digest.update(key);
    digest.finalize()[..4]
        .try_into()
        .expect("fixed digest length")
}
fn append_hex(text: &mut String, bytes: &[u8]) {
    const HEX: &[u8] = b"0123456789abcdef";
    for byte in bytes {
        text.push(HEX[(byte >> 4) as usize] as char);
        text.push(HEX[(byte & 15) as usize] as char);
    }
}
fn hex_pair(pair: &[u8]) -> Result<u8, Error> {
    fn digit(value: u8) -> Result<u8, Error> {
        match value {
            b'0'..=b'9' => Ok(value - b'0'),
            b'a'..=b'f' => Ok(value - b'a' + 10),
            b'A'..=b'F' => Ok(value - b'A' + 10),
            _ => Err(Error::Invalid),
        }
    }
    Ok((digit(pair[0])? << 4) | digit(pair[1])?)
}
impl RecoverySecret {
    /// Internal protected-record persistence, never an FFI/HTTP key export.
    pub(crate) fn save(&self, records: &mut Records, name: &str) {
        if let Some(mut old) = records.insert(name.into(), self.0.to_vec()) {
            old.zeroize();
        }
    }
    pub(crate) fn load(records: &Records, name: &str) -> Result<Self, Error> {
        let bytes = records
            .get(name)
            .filter(|bytes| bytes.len() == 32)
            .ok_or(Error::Recovery)?;
        let mut key = Zeroizing::new([0; 32]);
        key.copy_from_slice(bytes);
        Ok(Self(key))
    }
    pub fn generate() -> Result<Self, Error> {
        let mut key = Zeroizing::new([0; 32]);
        getrandom::fill(key.as_mut()).map_err(|_| Error::Unavailable)?;
        Ok(Self(key))
    }
    /// For the explicit recovery-code view only. Never log, index or send it.
    /// The adapter must not turn this temporary owned secret into a durable string.
    pub fn for_display(&self) -> Zeroizing<String> {
        let mut text = Zeroizing::new(String::with_capacity(78));
        text.push_str("rvk1-");
        append_hex(&mut text, self.0.as_ref());
        text.push('-');
        append_hex(&mut text, &checksum(&self.0));
        text
    }
    /// User-entered code, not the account password. Length checked before allocation.
    pub fn from_code(text: &str) -> Result<Self, Error> {
        let bytes = text.as_bytes();
        if bytes.len() != 78 || !bytes.starts_with(b"rvk1-") || bytes[69] != b'-' {
            return Err(Error::Invalid);
        }
        let mut key = Zeroizing::new([0; 32]);
        for (destination, pair) in key.iter_mut().zip(bytes[5..69].chunks_exact(2)) {
            *destination = hex_pair(pair)?;
        }
        let mut supplied = [0; 4];
        for (destination, pair) in supplied.iter_mut().zip(bytes[70..78].chunks_exact(2)) {
            *destination = hex_pair(pair)?;
        }
        if supplied != checksum(&key) {
            return Err(Error::Invalid);
        }
        Ok(Self(key))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub version: u8,
    pub root: Root,
    pub backup_id: [u8; 16],
    pub created_at: u64,
}
impl Header {
    fn aad(&self) -> Result<Vec<u8>, Error> {
        self.root.validate()?;
        if self.version != 1 || self.backup_id == [0; 16] || self.created_at > 253_402_300_799 {
            return Err(Error::Invalid);
        }
        signing_bytes(DOMAIN, self)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootBackup {
    pub header: Header,
    pub nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
}
impl RootBackup {
    fn authenticated_signing(
        &self,
        secret: &RecoverySecret,
        expected: &Root,
    ) -> Result<SigningKey, Error> {
        self.validate()?;
        expected.validate()?;
        if self.header.root != *expected {
            return Err(Error::Changed);
        }
        let plaintext = Zeroizing::new(
            XChaCha20Poly1305::new((&*secret.0).into())
                .decrypt(
                    XNonce::from_slice(&self.nonce),
                    Payload {
                        msg: &self.ciphertext,
                        aad: &self.header.aad()?,
                    },
                )
                .map_err(|_| Error::Recovery)?,
        );
        let private: PrivateRoot =
            serde_json::from_slice(&plaintext).map_err(|_| Error::Recovery)?;
        if private.root != *expected {
            return Err(Error::Recovery);
        }
        let signing = SigningKey::from_bytes(&private.seed);
        if signing.verifying_key().to_bytes() != expected.public_key {
            return Err(Error::Recovery);
        }
        Ok(signing)
    }
    /// Pure preview: validates the entered code before creating any vault.
    pub fn authenticate(&self, secret: &RecoverySecret, expected: &Root) -> Result<Root, Error> {
        self.authenticated_signing(secret, expected)?;
        Ok(expected.clone())
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > PACKET_LIMIT {
            return Err(Error::Limit);
        }
        let backup: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        backup.validate()?;
        Ok(backup)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > PACKET_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    fn validate(&self) -> Result<(), Error> {
        self.header.aad()?;
        if self.ciphertext.len() < 16 || self.ciphertext.len() > super::WIRE_LIMIT + 16 {
            return Err(Error::Limit);
        }
        Ok(())
    }
    /// Inside the owned protected transaction. This exports ciphertext only.
    pub fn seal(issuer: &Issuer, secret: &RecoverySecret, created_at: u64) -> Result<Self, Error> {
        let header = Header {
            version: 1,
            root: issuer.root.clone(),
            backup_id: random()?,
            created_at,
        };
        let nonce = random()?;
        let private = PrivateRoot {
            root: issuer.root.clone(),
            seed: issuer.signing.to_bytes(),
        };
        let plaintext = Zeroizing::new(serde_json::to_vec(&private).map_err(|_| Error::Invalid)?);
        if plaintext.len() > super::WIRE_LIMIT {
            return Err(Error::Limit);
        }
        let ciphertext = XChaCha20Poly1305::new((&*secret.0).into())
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: &header.aad()?,
                },
            )
            .map_err(|_| Error::Recovery)?;
        let backup = Self {
            header,
            nonce,
            ciphertext,
        };
        backup.to_bytes()?;
        Ok(backup)
    }
    /// First recovery requires a pristine vault/provider; an exact receipt retry
    /// returns metadata without resetting any subsequent device/group state.
    /// The expected root is
    /// pinned/confirmed by the identity flow; HTTP never grants that confirmation.
    /// Return public metadata only, after Manager confirms its checkpoint.
    pub fn restore(
        &self,
        secret: &RecoverySecret,
        expected: &Root,
        provider: &OpenMlsRustCrypto,
        records: &mut Records,
    ) -> Result<Root, Error> {
        self.validate()?;
        expected.validate()?;
        if self.header.root != *expected {
            return Err(Error::Changed);
        }
        let packet = self.to_bytes()?;
        let digest: super::Fingerprint = Sha256::digest(&packet).into();
        let root_fingerprint = expected.fingerprint()?;
        let mut already_restored = false;
        if !records.is_empty()
            || !provider
                .storage()
                .values
                .read()
                .map_err(|_| Error::Unavailable)?
                .is_empty()
        {
            let Some(receipt) = records.get(RESTORE_RECORD) else {
                return Err(Error::Changed);
            };
            if receipt.len() > super::WIRE_LIMIT {
                return Err(Error::Limit);
            }
            let receipt: RestoreReceipt =
                serde_json::from_slice(receipt).map_err(|_| Error::Invalid)?;
            if receipt.version != 1
                || receipt.root != root_fingerprint
                || receipt.backup != digest
                || Issuer::load(records, &expected.instance, &expected.user)?.root() != expected
            {
                return Err(Error::Changed);
            }
            already_restored = true;
        }
        let signing = self.authenticated_signing(secret, expected)?;
        if already_restored {
            return Ok(expected.clone());
        }
        let issuer = Issuer {
            root: expected.clone(),
            signing,
        };
        issuer.save(records)?;
        records.insert(
            RESTORE_RECORD.into(),
            serde_json::to_vec(&RestoreReceipt {
                version: 1,
                root: root_fingerprint,
                backup: digest,
            })
            .map_err(|_| Error::Invalid)?,
        );
        Ok(expected.clone())
    }
}

#[cfg(test)]
mod tests;
