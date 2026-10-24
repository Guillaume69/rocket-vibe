//! The symmetric primitives of the WhatsApp engine (transport, media, app
//! state, history), on RustCrypto. The Signal protocol itself is `rv-signal`.

use aes::Aes256;
use aes_gcm::aead::AeadInOut;
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit};
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256, Sha512};

const TAG_LEN: usize = 16;

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub enum CryptoProviderError {
    #[error("bad input")]
    BadInput,
    #[error("authentication failed")]
    AuthFailed,
    #[error("crypto backend failed")]
    BackendFailed,
}

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub enum DecryptionError {
    #[error("bad key or IV")]
    BadKeyOrIv,
    #[error("bad ciphertext: {0}")]
    BadCiphertext(&'static str),
}

#[derive(Debug, thiserror::Error, Clone, Copy, PartialEq, Eq)]
pub enum EncryptionError {
    #[error("bad key or IV")]
    BadKeyOrIv,
}

/// AES-256-GCM, the tag appended to the ciphertext, which is appended to `out`.
pub fn aes_256_gcm_encrypt(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    input: &[u8],
    out: &mut Vec<u8>,
) -> Result<(), CryptoProviderError> {
    let start = out.len();
    out.extend_from_slice(input);
    let tag = Aes256Gcm::new(key.into())
        .encrypt_inout_detached(&Nonce::from(*nonce), aad, out[start..].as_mut().into())
        .map_err(|_| CryptoProviderError::BackendFailed)?;
    out.extend_from_slice(&tag);
    Ok(())
}

/// AES-256-GCM of `ciphertext || tag`, the plaintext appended to `out`.
pub fn aes_256_gcm_decrypt(
    key: &[u8; 32],
    nonce: &[u8; 12],
    aad: &[u8],
    input: &[u8],
    out: &mut Vec<u8>,
) -> Result<(), CryptoProviderError> {
    let body = input
        .len()
        .checked_sub(TAG_LEN)
        .ok_or(CryptoProviderError::BadInput)?;
    let start = out.len();
    out.extend_from_slice(&input[..body]);
    let tag = Tag::try_from(&input[body..]).map_err(|_| CryptoProviderError::BadInput)?;
    let result = Aes256Gcm::new(key.into()).decrypt_inout_detached(
        &Nonce::from(*nonce),
        aad,
        out[start..].as_mut().into(),
        &tag,
    );
    if result.is_err() {
        out.truncate(start);
        return Err(CryptoProviderError::AuthFailed);
    }
    Ok(())
}

/// A growable byte buffer an AEAD can work in place: `Vec<u8>` and `BytesMut`.
pub trait GcmInPlaceBuffer {
    fn as_slice(&self) -> &[u8];
    fn as_mut_slice(&mut self) -> &mut [u8];
    fn len(&self) -> usize {
        self.as_slice().len()
    }
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    fn resize(&mut self, len: usize, value: u8);
    fn truncate(&mut self, len: usize);
}

impl GcmInPlaceBuffer for Vec<u8> {
    fn as_slice(&self) -> &[u8] {
        self
    }
    fn as_mut_slice(&mut self) -> &mut [u8] {
        self
    }
    fn resize(&mut self, len: usize, value: u8) {
        Vec::resize(self, len, value);
    }
    fn truncate(&mut self, len: usize) {
        Vec::truncate(self, len);
    }
}

impl GcmInPlaceBuffer for bytes::BytesMut {
    fn as_slice(&self) -> &[u8] {
        self
    }
    fn as_mut_slice(&mut self) -> &mut [u8] {
        self
    }
    fn resize(&mut self, len: usize, value: u8) {
        bytes::BytesMut::resize(self, len, value);
    }
    fn truncate(&mut self, len: usize) {
        bytes::BytesMut::truncate(self, len);
    }
}

/// A connection's AEAD, keyed once.
pub trait TransportAead: Send + Sync {
    /// Plaintext in, `ciphertext || tag` out, in the same buffer.
    fn encrypt_in_place(
        &self,
        nonce: &[u8; 12],
        aad: &[u8],
        buffer: &mut dyn GcmInPlaceBuffer,
    ) -> Result<(), CryptoProviderError>;
    /// `ciphertext || tag` in, plaintext out, in the same buffer.
    fn decrypt_in_place(
        &self,
        nonce: &[u8; 12],
        aad: &[u8],
        buffer: &mut dyn GcmInPlaceBuffer,
    ) -> Result<(), CryptoProviderError>;
}

struct GcmTransport(Aes256Gcm);

impl TransportAead for GcmTransport {
    fn encrypt_in_place(
        &self,
        nonce: &[u8; 12],
        aad: &[u8],
        buffer: &mut dyn GcmInPlaceBuffer,
    ) -> Result<(), CryptoProviderError> {
        let len = buffer.len();
        let tag = self
            .0
            .encrypt_inout_detached(&Nonce::from(*nonce), aad, buffer.as_mut_slice().into())
            .map_err(|_| CryptoProviderError::BackendFailed)?;
        buffer.resize(len + TAG_LEN, 0);
        buffer.as_mut_slice()[len..].copy_from_slice(&tag);
        Ok(())
    }

    fn decrypt_in_place(
        &self,
        nonce: &[u8; 12],
        aad: &[u8],
        buffer: &mut dyn GcmInPlaceBuffer,
    ) -> Result<(), CryptoProviderError> {
        let body = buffer
            .len()
            .checked_sub(TAG_LEN)
            .ok_or(CryptoProviderError::BadInput)?;
        let tag =
            Tag::try_from(&buffer.as_slice()[body..]).map_err(|_| CryptoProviderError::BadInput)?;
        self.0
            .decrypt_inout_detached(
                &Nonce::from(*nonce),
                aad,
                (&mut buffer.as_mut_slice()[..body]).into(),
                &tag,
            )
            .map_err(|_| CryptoProviderError::AuthFailed)?;
        buffer.truncate(body);
        Ok(())
    }
}

pub fn transport_aead(key: &[u8; 32]) -> Result<Box<dyn TransportAead>, CryptoProviderError> {
    Ok(Box::new(GcmTransport(Aes256Gcm::new(key.into()))))
}

/// AES-256-CBC with PKCS#7, the ciphertext appended to `out`.
pub fn aes_256_cbc_encrypt_into(
    input: &[u8],
    key: &[u8],
    iv: &[u8],
    out: &mut Vec<u8>,
) -> Result<(), EncryptionError> {
    let encryptor = cbc::Encryptor::<Aes256>::new_from_slices(key, iv)
        .map_err(|_| EncryptionError::BadKeyOrIv)?;
    out.extend(encryptor.encrypt_padded_vec::<Pkcs7>(input));
    Ok(())
}

/// AES-256-CBC with PKCS#7; `out` is cleared, then holds the plaintext, in
/// its own allocation when it is large enough.
pub fn aes_256_cbc_decrypt_into(
    input: &[u8],
    key: &[u8],
    iv: &[u8],
    out: &mut Vec<u8>,
) -> Result<(), DecryptionError> {
    out.clear();
    out.extend_from_slice(input);
    aes_256_cbc_decrypt_in_place(out, key, iv)
}

/// AES-256-CBC with PKCS#7, decrypted in the buffer itself, which then holds
/// the plaintext: no other allocation.
pub fn aes_256_cbc_decrypt_in_place(
    buffer: &mut Vec<u8>,
    key: &[u8],
    iv: &[u8],
) -> Result<(), DecryptionError> {
    let decryptor = cbc::Decryptor::<Aes256>::new_from_slices(key, iv)
        .map_err(|_| DecryptionError::BadKeyOrIv)?;
    if buffer.is_empty() || !buffer.len().is_multiple_of(16) {
        return Err(DecryptionError::BadCiphertext("not whole blocks"));
    }
    let len = decryptor
        .decrypt_padded::<Pkcs7>(buffer)
        .map_err(|_| DecryptionError::BadCiphertext("bad padding"))?
        .len();
    buffer.truncate(len);
    Ok(())
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    hmac_sha256_two_part(key, data, &[])
}

pub fn hmac_sha256_two_part(key: &[u8], first: &[u8], second: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("any key length");
    mac.update(first);
    mac.update(second);
    mac.finalize().into_bytes().into()
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum Error {
    #[error("unknown {0} algorithm {1}")]
    UnknownAlgorithm(&'static str, String),
    #[error("invalid key size")]
    InvalidKeySize,
    #[error("invalid nonce size")]
    InvalidNonceSize,
    #[error("invalid input size")]
    InvalidInputSize,
    #[error("invalid authentication tag")]
    InvalidTag,
    #[error("output buffer too small")]
    OutputBufferTooSmall,
}

/// A hash chosen by name: `SHA256` or `SHA512`.
#[derive(Clone)]
pub enum CryptographicHash {
    Sha256(Sha256),
    Sha512(Sha512),
}

impl CryptographicHash {
    pub fn new(algorithm: &str) -> Result<Self, Error> {
        match algorithm {
            "SHA-256" | "SHA256" | "Sha256" => Ok(Self::Sha256(Sha256::new())),
            "SHA-512" | "SHA512" | "Sha512" => Ok(Self::Sha512(Sha512::new())),
            other => Err(Error::UnknownAlgorithm("hash", other.to_owned())),
        }
    }
    pub fn update(&mut self, data: &[u8]) {
        match self {
            Self::Sha256(h) => h.update(data),
            Self::Sha512(h) => h.update(data),
        }
    }
    /// The digest; the hash starts over.
    pub fn finalize(&mut self) -> Vec<u8> {
        match self {
            Self::Sha256(h) => h.finalize_reset().to_vec(),
            Self::Sha512(h) => h.finalize_reset().to_vec(),
        }
    }
    pub fn finalize_sha256_array(&mut self) -> Result<[u8; 32], Error> {
        match self {
            Self::Sha256(h) => Ok(h.finalize_reset().into()),
            Self::Sha512(_) => Err(Error::InvalidInputSize),
        }
    }
}

/// An HMAC chosen by name: `HmacSha256` or `HmacSha512`.
#[derive(Clone)]
pub enum CryptographicMac {
    Sha256 {
        running: Box<Hmac<Sha256>>,
        keyed: Box<Hmac<Sha256>>,
    },
    Sha512 {
        running: Box<Hmac<Sha512>>,
        keyed: Box<Hmac<Sha512>>,
    },
}

impl CryptographicMac {
    pub fn new(algorithm: &str, key: &[u8]) -> Result<Self, Error> {
        match algorithm {
            "HmacSha256" | "HMACSHA256" => {
                let keyed = Box::new(
                    <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("any key length"),
                );
                Ok(Self::Sha256 {
                    running: keyed.clone(),
                    keyed,
                })
            }
            "HmacSha512" | "HMACSHA512" => {
                let keyed = Box::new(
                    <Hmac<Sha512> as KeyInit>::new_from_slice(key).expect("any key length"),
                );
                Ok(Self::Sha512 {
                    running: keyed.clone(),
                    keyed,
                })
            }
            other => Err(Error::UnknownAlgorithm("MAC", other.to_owned())),
        }
    }
    pub fn update(&mut self, data: &[u8]) {
        match self {
            Self::Sha256 { running, .. } => running.update(data),
            Self::Sha512 { running, .. } => running.update(data),
        }
    }
    /// The MAC; it starts over under the same key.
    pub fn finalize(&mut self) -> Vec<u8> {
        match self {
            Self::Sha256 { running, keyed } => std::mem::replace(running, keyed.clone())
                .finalize()
                .into_bytes()
                .to_vec(),
            Self::Sha512 { running, keyed } => std::mem::replace(running, keyed.clone())
                .finalize()
                .into_bytes()
                .to_vec(),
        }
    }
    pub fn finalize_sha256_array(&mut self) -> Result<[u8; 32], Error> {
        match self {
            Self::Sha256 { running, keyed } => Ok(std::mem::replace(running, keyed.clone())
                .finalize()
                .into_bytes()
                .into()),
            Self::Sha512 { .. } => Err(Error::InvalidInputSize),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gcm_round_trips_and_refuses_a_flipped_bit() {
        let (key, nonce) = ([7u8; 32], [1u8; 12]);
        let mut sealed = Vec::new();
        aes_256_gcm_encrypt(&key, &nonce, b"ad", b"hello", &mut sealed).unwrap();
        let mut opened = Vec::new();
        aes_256_gcm_decrypt(&key, &nonce, b"ad", &sealed, &mut opened).unwrap();
        assert_eq!(opened, b"hello");
        sealed[0] ^= 1;
        assert_eq!(
            aes_256_gcm_decrypt(&key, &nonce, b"ad", &sealed, &mut Vec::new()),
            Err(CryptoProviderError::AuthFailed)
        );
    }

    #[test]
    fn the_transport_aead_agrees_with_the_one_shot_functions() {
        let (key, nonce) = ([3u8; 32], [9u8; 12]);
        let aead = transport_aead(&key).unwrap();
        let mut buffer = b"frame".to_vec();
        aead.encrypt_in_place(&nonce, b"", &mut buffer).unwrap();
        let mut expected = Vec::new();
        aes_256_gcm_encrypt(&key, &nonce, b"", b"frame", &mut expected).unwrap();
        assert_eq!(buffer, expected);
        let mut frame = bytes::BytesMut::from(&buffer[..]);
        aead.decrypt_in_place(&nonce, b"", &mut frame).unwrap();
        assert_eq!(&frame[..], b"frame");
    }

    #[test]
    fn cbc_round_trips() {
        let mut sealed = Vec::new();
        aes_256_cbc_encrypt_into(b"sixteen bytes!!!+", &[1; 32], &[2; 16], &mut sealed).unwrap();
        assert_eq!(sealed.len(), 32);
        let mut opened = Vec::new();
        aes_256_cbc_decrypt_into(&sealed, &[1; 32], &[2; 16], &mut opened).unwrap();
        assert_eq!(opened, b"sixteen bytes!!!+");
    }
}
