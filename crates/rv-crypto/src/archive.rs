//! Archive AEAD primitives. Use only inside an owned protected operation.
//! No admission or sharing is granted by possessing/decrypting one document.
use crate::{
    identity::{Certificate, enrollment::LocalDevice},
    vault::Records,
};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use data_encoding::HEXLOWER;
use openmls_traits::signatures::Signer;
pub use rv_crypto_public::archive::{Header, Packet};
use rv_crypto_public::{groups::Member, messages::Receipt};
use rv_protocol::SendMessage;
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("crypto_archive_identity")]
    Identity(#[from] rv_crypto_public::Error),
    #[error("crypto_archive_document")]
    Document,
    #[error("crypto_archive_authentication")]
    Authentication,
    #[error("crypto_archive_changed")]
    Changed,
    #[error("crypto_archive_unavailable")]
    Unavailable,
}
pub type Result<T> = std::result::Result<T, Error>;
/// OS-random per-document key. No Debug/Clone/serde, display or raw-key export.
pub struct Key(Zeroizing<[u8; 32]>);
const DERIVE_DOMAIN: &str = "rocketvibe-history-document-key-v1";
fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| Error::Unavailable)?;
    Ok(bytes)
}
fn record(packet: &Packet) -> Result<String> {
    Ok(format!(
        "crypto-archive-key-v1/{}",
        HEXLOWER.encode(&packet.digest()?)
    ))
}
impl Key {
    /// A shared period's document key: HKDF-SHA256 of the period secret, bound
    /// to the packet's random `key_id`. Only the period secret is ever shared.
    pub(crate) fn derive(
        crypto: &impl openmls_traits::crypto::OpenMlsCrypto,
        secret: &[u8; 32],
        key_id: &[u8; 16],
    ) -> Result<Self> {
        let hash = openmls_traits::types::HashType::Sha2_256;
        let prk = crypto
            .hkdf_extract(hash, &[], secret)
            .map_err(|_| Error::Unavailable)?;
        let mut info = DERIVE_DOMAIN.as_bytes().to_vec();
        info.push(0);
        info.extend_from_slice(key_id);
        let okm = crypto
            .hkdf_expand(hash, prk.as_slice(), &info, 32)
            .map_err(|_| Error::Unavailable)?;
        let mut key = Zeroizing::new([0; 32]);
        key.copy_from_slice(okm.as_slice());
        Ok(Self(key))
    }
    /// The destination is the encrypted vault's records, never app preferences.
    pub fn save(&self, packet: &Packet, records: &mut Records) -> Result<()> {
        decrypt(packet, self)?;
        let name = record(packet)?;
        if let Some(existing) = records.get(&name) {
            if existing.as_slice() != self.0.as_slice() {
                return Err(Error::Changed);
            }
            return Ok(());
        }
        records.insert(name, self.0.to_vec());
        Ok(())
    }
    pub fn load(packet: &Packet, records: &Records) -> Result<Self> {
        let bytes = records
            .get(&record(packet)?)
            .filter(|bytes| bytes.len() == 32)
            .ok_or(Error::Changed)?;
        let mut key = Zeroizing::new([0; 32]);
        key.copy_from_slice(bytes);
        let key = Self(key);
        decrypt(packet, &key)?;
        Ok(key)
    }
    /// Removes only this exact packet's local key. Existing exported copies
    /// cannot be erased or invalidated by this local operation.
    pub fn forget(packet: &Packet, records: &mut Records) -> Result<()> {
        if let Some(mut bytes) = records.remove(&record(packet)?) {
            bytes.zeroize();
        }
        Ok(())
    }
}
/// Seal a previously accepted document with a separate key and exact receipt.
/// The coordinator must first match this document to the verified MLS original.
pub fn seal(
    device: &LocalDevice,
    origin: &Receipt,
    membership: &Member,
    document: &SendMessage,
    now: u64,
) -> Result<(Packet, Key)> {
    let original = Certificate::from_credential(&device.credential(now)?.credential)?;
    seal_from_origin(device, &original, origin, membership, document, now)
}
/// Re-archive with a current approved leaf of the same immutable account root.
/// The original certificate is authenticated historically and stays unchanged.
pub fn seal_from_origin(
    device: &LocalDevice,
    original_certificate: &Certificate,
    origin: &Receipt,
    membership: &Member,
    document: &SendMessage,
    now: u64,
) -> Result<(Packet, Key)> {
    seal_with(
        device,
        original_certificate,
        origin,
        membership,
        document,
        now,
        |_| Ok(Key(Zeroizing::new(random()?))),
    )
}
/// `seal_from_origin` with the document key chosen from the packet's `key_id`.
pub(crate) fn seal_with(
    device: &LocalDevice,
    original_certificate: &Certificate,
    origin: &Receipt,
    membership: &Member,
    document: &SendMessage,
    now: u64,
    key_for: impl FnOnce(&[u8; 16]) -> Result<Key>,
) -> Result<(Packet, Key)> {
    let certificate = Certificate::from_credential(&device.credential(now)?.credential)?;
    let header = Header {
        version: 1,
        origin: origin.clone(),
        author_membership: membership.clone(),
        key_id: random()?,
        nonce: random()?,
    };
    header.validate()?;
    let plain = crate::groups::messages::payload(document).map_err(|_| Error::Document)?;
    // Operation/thread bindings are checked using the same canonical decoder
    // as live messages; a new serialization dialect is not introduced here.
    crate::groups::messages::decode(&plain, &origin.header).map_err(|_| Error::Document)?;
    let key = key_for(&header.key_id)?;
    let ciphertext = XChaCha20Poly1305::new(key.0.as_ref().into())
        .encrypt(
            XNonce::from_slice(&header.nonce),
            Payload {
                msg: &plain,
                aad: &header.aad()?,
            },
        )
        .map_err(|_| Error::Authentication)?;
    let mut packet = Packet {
        header,
        original_certificate: original_certificate.clone(),
        certificate,
        ciphertext,
        signature: Vec::new(),
    };
    packet.signature = device
        .sign(&packet.signing_bytes()?)
        .map_err(|_| Error::Authentication)?;
    packet.verify_current(now)?;
    Ok((packet, key))
}
fn decrypt(packet: &Packet, key: &Key) -> Result<Zeroizing<Vec<u8>>> {
    packet.authenticate()?;
    let bytes = XChaCha20Poly1305::new(key.0.as_ref().into())
        .decrypt(
            XNonce::from_slice(&packet.header.nonce),
            Payload {
                msg: &packet.ciphertext,
                aad: &packet.header.aad()?,
            },
        )
        .map_err(|_| Error::Authentication)?;
    Ok(Zeroizing::new(bytes))
}
/// Pure authentication/decryption. The caller must separately enforce its
/// reader grant and stored historical witness before publishing any cleartext.
pub fn open(
    packet: &Packet,
    key: &Key,
    origin: &Receipt,
    membership: &Member,
) -> Result<SendMessage> {
    if &packet.header.origin != origin || &packet.header.author_membership != membership {
        return Err(Error::Changed);
    }
    let plain = decrypt(packet, key)?;
    crate::groups::messages::decode(&plain, &origin.header).map_err(|_| Error::Document)
}

#[cfg(test)]
mod tests;
