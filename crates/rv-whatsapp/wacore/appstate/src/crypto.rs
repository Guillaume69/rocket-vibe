use aes::Aes256;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit};
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

/// HKDF-SHA256 with no salt.
pub(crate) fn hkdf(ikm: &[u8], info: &[u8], out: &mut [u8]) {
    Hkdf::<Sha256>::new(None, ikm)
        .expand(info, out)
        .expect("HKDF output length");
}

pub(crate) fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("any key length");
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

pub(crate) fn aes_cbc_encrypt(key: &[u8; 32], iv: &[u8; 16], plaintext: &[u8]) -> Vec<u8> {
    cbc::Encryptor::<Aes256>::new(key.into(), iv.into()).encrypt_padded_vec::<Pkcs7>(plaintext)
}

pub(crate) fn aes_cbc_decrypt(key: &[u8; 32], iv: &[u8], ciphertext: &[u8]) -> Option<Vec<u8>> {
    let iv: &[u8; 16] = iv.try_into().ok()?;
    cbc::Decryptor::<Aes256>::new(key.into(), iv.into())
        .decrypt_padded_vec::<Pkcs7>(ciphertext)
        .ok()
}
