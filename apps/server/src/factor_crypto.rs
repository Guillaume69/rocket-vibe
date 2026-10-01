//! Standard RFC 6238 construction and operator-key encryption. No secret Debug.
use aes_gcm_siv::{
    Aes256GcmSiv, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use sha1::Sha1;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::error::{Error, Result};

pub struct AuthKey(Zeroizing<[u8; 32]>);

impl AuthKey {
    /// A mounted operator secret; reject symlinks, oversized files and broad
    /// Unix permissions. No environment variable ever contains the key itself.
    pub fn from_file(path: &std::path::Path) -> std::result::Result<Self, &'static str> {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| "Cannot read RV_AUTH_KEY_FILE")?;
        if !metadata.is_file() || !(64..=66).contains(&metadata.len()) {
            return Err(
                "RV_AUTH_KEY_FILE must be a regular file containing 64 hexadecimal characters",
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err("RV_AUTH_KEY_FILE must not grant group or other access (use mode 600)");
            }
        }
        use std::io::Read;
        let mut value = Zeroizing::new(String::new());
        std::fs::File::open(path)
            .map_err(|_| "Cannot read RV_AUTH_KEY_FILE")?
            .take(67)
            .read_to_string(&mut value)
            .map_err(|_| "Cannot read RV_AUTH_KEY_FILE")?;
        Self::from_hex(value.trim_end_matches(['\r', '\n']))
            .map_err(|_| "RV_AUTH_KEY_FILE is malformed")
    }

    /// Exactly 256 random bits, supplied outside the database. Never a password.
    pub fn from_hex(value: &str) -> Result<Self> {
        if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::invalid());
        }
        let mut key = Zeroizing::new([0u8; 32]);
        for (i, byte) in key.iter_mut().enumerate() {
            *byte =
                u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|_| Error::invalid())?;
        }
        Ok(Self(key))
    }

    pub(crate) fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        let cipher =
            Aes256GcmSiv::new_from_slice(self.0.as_ref()).map_err(|_| Error::internal())?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let mut envelope = vec![1];
        envelope.extend_from_slice(&nonce);
        envelope.extend(
            cipher
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: plaintext,
                        aad,
                    },
                )
                .map_err(|_| unavailable())?,
        );
        Ok(envelope)
    }

    pub(crate) fn open(&self, envelope: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        if envelope.len() < 29 || envelope[0] != 1 {
            return Err(unavailable());
        }
        let cipher =
            Aes256GcmSiv::new_from_slice(self.0.as_ref()).map_err(|_| Error::internal())?;
        cipher
            .decrypt(
                Nonce::from_slice(&envelope[1..13]),
                Payload {
                    msg: &envelope[13..],
                    aad,
                },
            )
            .map(Zeroizing::new)
            .map_err(|_| unavailable())
    }
}

pub(crate) fn unavailable() -> Error {
    Error::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "factor_unavailable",
    )
}

/// Stable across data_epoch changes after a restore; bound to purpose/account.
pub(crate) fn aad(instance: &str, user: &str, id: &str, purpose: &str) -> Vec<u8> {
    serde_json::to_vec(&("rv-auth-v1", purpose, instance, user, id)).expect("string tuple")
}

pub(crate) fn secret() -> Zeroizing<[u8; 20]> {
    let mut secret = Zeroizing::new([0u8; 20]);
    OsRng.fill_bytes(secret.as_mut());
    secret
}

fn hotp(secret: &[u8], counter: u64, digits: u32) -> String {
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(secret).expect("HMAC accepts every key size");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 15) as usize;
    let binary = u32::from_be_bytes(digest[offset..offset + 4].try_into().expect("SHA1 output"))
        & 0x7fff_ffff;
    format!(
        "{:0width$}",
        binary % 10u32.pow(digits),
        width = digits as usize
    )
}

/// Fixed three-counter window, six ASCII digits; strict monotonic replay fence.
pub(crate) fn verify(secret: &[u8], code: &str, unix: i64, last: i64) -> Option<i64> {
    if secret.len() != 20
        || unix < 30
        || code.len() != 6
        || !code.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let current = unix / 30;
    let mut matched = None;
    for counter in [current - 1, current, current + 1] {
        let equal = bool::from(
            hotp(secret, counter as u64, 6)
                .as_bytes()
                .ct_eq(code.as_bytes()),
        );
        if equal && counter > last {
            matched = Some(counter);
        }
    }
    matched
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operator_key_file_rejects_malformed_oversized_and_public_secrets() {
        let path =
            std::env::temp_dir().join(format!("rv-auth-key-test-{}", crate::auth::random_token()));
        std::fs::write(&path, "37".repeat(32)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(AuthKey::from_file(&path).is_ok());
        std::fs::write(&path, format!("{}\n", "37".repeat(32))).unwrap();
        assert!(AuthKey::from_file(&path).is_ok());
        std::fs::write(&path, "password").unwrap();
        assert!(AuthKey::from_file(&path).is_err());
        std::fs::write(&path, "37".repeat(64)).unwrap();
        assert!(AuthKey::from_file(&path).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&path, "37".repeat(32)).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(AuthKey::from_file(&path).is_err());
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rfc6238_sha1_vectors_and_six_digit_window() {
        let secret = b"12345678901234567890";
        // RFC 6238 Appendix B: includes 20 billion seconds (beyond 2038).
        for (time, expected) in [
            (59, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
            (20_000_000_000, "65353130"),
        ] {
            assert_eq!(hotp(secret, (time / 30) as u64, 8), expected);
            let code = &expected[2..];
            assert_eq!(verify(secret, code, time, -1), Some(time / 30));
            assert!(verify(secret, code, time, time / 30).is_none());
            assert_eq!(verify(secret, code, time + 30, -1), Some(time / 30));
            assert!(verify(secret, code, time + 60, -1).is_none());
        }
        for code in ["", "12345", "1234567", "１２３４５６", " 12345"] {
            assert!(verify(secret, code, 120, -1).is_none());
        }
    }

    #[test]
    fn ciphertext_is_authenticated_versioned_random_and_scope_bound() {
        let key = AuthKey::from_hex(&"19".repeat(32)).unwrap();
        let context = aad("instance", "user", "setup", "totp");
        let plaintext = secret();
        let envelope = key.seal(plaintext.as_ref(), &context).unwrap();
        assert_ne!(envelope, key.seal(plaintext.as_ref(), &context).unwrap());
        assert_eq!(
            key.open(&envelope, &context).unwrap().as_slice(),
            plaintext.as_ref()
        );
        for scope in [
            aad("other", "user", "setup", "totp"),
            aad("instance", "other", "setup", "totp"),
            aad("instance", "user", "other", "totp"),
            aad("instance", "user", "setup", "receipt"),
        ] {
            assert!(key.open(&envelope, &scope).is_err());
        }
        assert!(
            AuthKey::from_hex(&"29".repeat(32))
                .unwrap()
                .open(&envelope, &context)
                .is_err()
        );
        for i in 0..envelope.len() {
            let mut corrupt = envelope.clone();
            corrupt[i] ^= 1;
            assert!(key.open(&corrupt, &context).is_err());
        }
        assert!(AuthKey::from_hex("password").is_err());
    }
}
