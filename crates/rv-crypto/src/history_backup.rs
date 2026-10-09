//! History backup primitives (E2EE_HISTORY_BACKUP.md, path B): the `rvh1-`
//! code, the account history key and its sealed package, the period secrets,
//! and the device signatures of publications and checkpoints. Use only inside
//! an owned protected operation; trust decisions belong to the callers.
use crate::{
    history::{Error, Result},
    identity::{Certificate, enrollment::LocalDevice},
    vault::Records,
};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use data_encoding::HEXLOWER;
use openmls_traits::{crypto::OpenMlsCrypto, signatures::Signer};
pub use rv_crypto_public::history_backup::{
    Checkpoint, CheckpointBody, KeyHeader, KeyPackage, Period, Publication, PublicationBody,
};
use rv_crypto_public::{Fingerprint, Root};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

const CODE_DOMAIN: &[u8] = b"rocketvibe-history-code-v1\0";

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| Error::Unavailable)?;
    Ok(bytes)
}
fn checksum(key: &[u8; 32]) -> [u8; 4] {
    let mut digest = Sha256::new();
    digest.update(CODE_DOMAIN);
    digest.update(key);
    digest.finalize()[..4]
        .try_into()
        .expect("fixed digest length")
}
fn hex_pair(pair: &[u8]) -> Result<u8> {
    fn digit(value: u8) -> Result<u8> {
        match value {
            b'0'..=b'9' => Ok(value - b'0'),
            b'a'..=b'f' => Ok(value - b'a' + 10),
            b'A'..=b'F' => Ok(value - b'A' + 10),
            _ => Err(Error::Changed),
        }
    }
    Ok((digit(pair[0])? << 4) | digit(pair[1])?)
}

/// The 256-bit key behind the `rvh1-` history code. No Debug/Clone/serde.
pub struct HistoryCode(Zeroizing<[u8; 32]>);
impl HistoryCode {
    pub fn generate() -> Result<Self> {
        Ok(Self(Zeroizing::new(random()?)))
    }
    /// For the explicit code view only. Never log, index or send it.
    pub fn for_display(&self) -> Zeroizing<String> {
        let mut text = Zeroizing::new(String::with_capacity(78));
        text.push_str("rvh1-");
        text.push_str(&HEXLOWER.encode(self.0.as_ref()));
        text.push('-');
        text.push_str(&HEXLOWER.encode(&checksum(&self.0)));
        text
    }
    /// User-entered history code; an identity code (`rvk1-`) is refused.
    pub fn from_code(text: &str) -> Result<Self> {
        let bytes = text.trim().as_bytes();
        if bytes.len() != 78 || !bytes.starts_with(b"rvh1-") || bytes[69] != b'-' {
            return Err(Error::Changed);
        }
        let mut key = Zeroizing::new([0; 32]);
        for (destination, pair) in key.iter_mut().zip(bytes[5..69].as_chunks::<2>().0) {
            *destination = hex_pair(pair)?;
        }
        let mut supplied = [0; 4];
        for (destination, pair) in supplied.iter_mut().zip(bytes[70..78].as_chunks::<2>().0) {
            *destination = hex_pair(pair)?;
        }
        if supplied != checksum(&key) {
            return Err(Error::Changed);
        }
        Ok(Self(key))
    }
    pub(crate) fn save(&self, records: &mut Records, name: &str) {
        if let Some(mut old) = records.insert(name.into(), self.0.to_vec()) {
            old.zeroize();
        }
    }
    pub(crate) fn load(records: &Records, name: &str) -> Result<Self> {
        let bytes = records
            .get(name)
            .filter(|b| b.len() == 32)
            .ok_or(Error::Changed)?;
        let mut key = Zeroizing::new([0; 32]);
        key.copy_from_slice(bytes);
        Ok(Self(key))
    }
}

mod secret {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &Zeroizing<[u8; 32]>,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&Zeroizing::new(HEXLOWER.encode(value.as_ref())))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Zeroizing<[u8; 32]>, D::Error> {
        let text = Zeroizing::new(String::deserialize(deserializer)?);
        let mut bytes = HEXLOWER
            .decode(text.as_bytes())
            .map_err(serde::de::Error::custom)?;
        if bytes.len() != 32 {
            bytes.zeroize();
            return Err(serde::de::Error::custom("crypto_history_key"));
        }
        let mut key = Zeroizing::new([0; 32]);
        key.copy_from_slice(&bytes);
        bytes.zeroize();
        Ok(key)
    }
}
/// The account history key of one generation. No Debug/Clone or raw export.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryKey {
    pub generation: [u8; 16],
    #[serde(with = "secret")]
    key: Zeroizing<[u8; 32]>,
}
impl HistoryKey {
    pub fn generate() -> Result<Self> {
        let generation: [u8; 16] = random()?;
        if generation == [0; 16] {
            return Err(Error::Unavailable);
        }
        Ok(Self {
            generation,
            key: Zeroizing::new(random()?),
        })
    }
    pub(crate) fn to_bytes(&self) -> Result<Zeroizing<Vec<u8>>> {
        Ok(Zeroizing::new(
            serde_json::to_vec(self).map_err(|_| Error::Changed)?,
        ))
    }
    pub(crate) fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 256 {
            return Err(Error::Limit);
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
        if value.generation == [0; 16] {
            return Err(Error::Changed);
        }
        Ok(value)
    }
    /// Seals this key under the history code for `root`.
    pub fn seal(&self, code: &HistoryCode, root: &Root, now: u64) -> Result<KeyPackage> {
        let mut package = KeyPackage {
            header: KeyHeader {
                version: 1,
                root: root.clone(),
                generation: self.generation,
                created_at: now,
            },
            nonce: random()?,
            ciphertext: vec![0; 16],
        };
        let plain = self.to_bytes()?;
        package.ciphertext = XChaCha20Poly1305::new(code.0.as_ref().into())
            .encrypt(
                XNonce::from_slice(&package.nonce),
                Payload {
                    msg: &plain,
                    aad: &package.aad()?,
                },
            )
            .map_err(|_| Error::Authentication)?;
        package.validate()?;
        Ok(package)
    }
    /// Opens a package with the history code; its root must be `root`.
    pub fn open(package: &KeyPackage, code: &HistoryCode, root: &Root) -> Result<Self> {
        if &package.header.root != root {
            return Err(Error::NotRequested);
        }
        let plain = Zeroizing::new(
            XChaCha20Poly1305::new(code.0.as_ref().into())
                .decrypt(
                    XNonce::from_slice(&package.nonce),
                    Payload {
                        msg: &package.ciphertext,
                        aad: &package.aad()?,
                    },
                )
                .map_err(|_| Error::Authentication)?,
        );
        let key = Self::from_bytes(&plain)?;
        if key.generation != package.header.generation {
            return Err(Error::Changed);
        }
        Ok(key)
    }
    /// The secret of one backed-up period: HKDF-SHA256 of the history key with
    /// `info` = period domain NUL period id.
    pub fn period_secret(
        &self,
        crypto: &impl OpenMlsCrypto,
        period: &Period,
    ) -> Result<Zeroizing<[u8; 32]>> {
        let hash = openmls_traits::types::HashType::Sha2_256;
        let prk = crypto
            .hkdf_extract(hash, &[], self.key.as_ref())
            .map_err(|_| Error::Unavailable)?;
        let mut info = rv_crypto_public::history_backup::PERIOD_DOMAIN
            .as_bytes()
            .to_vec();
        info.push(0);
        info.extend_from_slice(&period.id(&self.generation)?);
        let okm = crypto
            .hkdf_expand(hash, prk.as_slice(), &info, 32)
            .map_err(|_| Error::Unavailable)?;
        let mut secret = Zeroizing::new([0; 32]);
        secret.copy_from_slice(okm.as_slice());
        Ok(secret)
    }
}

fn current_certificate(device: &LocalDevice, now: u64) -> Result<Certificate> {
    Ok(Certificate::from_credential(
        &device
            .credential(now)
            .map_err(|_| Error::Changed)?
            .credential,
    )?)
}
/// Signs a publication of `package` with this device's leaf.
pub fn publish(
    device: &LocalDevice,
    body: PublicationBody,
    package: KeyPackage,
    now: u64,
) -> Result<Publication> {
    let certificate = current_certificate(device, now)?;
    if body.package_digest != package.digest()? {
        return Err(Error::Changed);
    }
    let mut publication = Publication {
        signature: device
            .sign(&body.signing_bytes()?)
            .map_err(|_| Error::Authentication)?,
        body,
        package,
    };
    publication.verify(&certificate)?;
    publication.signature.shrink_to_fit();
    Ok(publication)
}
/// Signs a period checkpoint with this device's current certificate.
pub fn checkpoint(device: &LocalDevice, body: CheckpointBody, now: u64) -> Result<Checkpoint> {
    let mut checkpoint = Checkpoint {
        body,
        certificate: current_certificate(device, now)?,
        signature: Vec::new(),
    };
    checkpoint.signature = device
        .sign(&checkpoint.signing_bytes()?)
        .map_err(|_| Error::Authentication)?;
    checkpoint.verify()?;
    Ok(checkpoint)
}
/// Digest helper for record chains.
pub fn period_id(period: &Period, generation: &[u8; 16]) -> Result<Fingerprint> {
    Ok(period.id(generation)?)
}

#[cfg(test)]
mod tests;
