//! Reading end-to-end encrypted rooms (Rocket.Chat `rc.v1`/`rc.v2`), never
//! writing them. The private key, unlocked with the E2E password, stays in
//! memory; each room's AES key is unwrapped from its subscription's `E2EKey`.

use aws_lc_rs::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use aws_lc_rs::cipher::{AES_256, DecryptionContext, PaddedBlockDecryptingKey, UnboundCipherKey};
use aws_lc_rs::rsa::{OAEP_SHA256_MGF1SHA256, OaepPrivateDecryptingKey, PrivateDecryptingKey};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum E2eError {
    #[error("wrong E2E password")]
    WrongPassword,
    #[error("no E2E keys on this account")]
    NoKeys,
    #[error("undecipherable: {0}")]
    Undecipherable(&'static str),
}

const GCM_TAG: usize = 16;
const CBC_IV: usize = 16;
/// RSA-2048 output in base64: what follows an `E2EKey`'s key id.
const RSA_B64_LEN: usize = 344;

fn b64(s: &str) -> Result<Vec<u8>, E2eError> {
    STANDARD.decode(s.trim()).map_err(|_| E2eError::Undecipherable("base64"))
}

fn b64url(s: &str) -> Result<Vec<u8>, E2eError> {
    URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).map_err(|_| E2eError::Undecipherable("base64url"))
}

fn pbkdf2(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    let rounds = std::num::NonZeroU32::new(iterations.max(1)).expect("non-zero");
    aws_lc_rs::pbkdf2::derive(aws_lc_rs::pbkdf2::PBKDF2_HMAC_SHA256, rounds, salt, password.as_bytes(), &mut key);
    key
}

/// AES-256-GCM with the tag at the end (WebCrypto's layout). None when it
/// does not authenticate: a wrong key.
fn gcm(key: &[u8], iv: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < GCM_TAG {
        return None;
    }
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).ok()?);
    let nonce = Nonce::try_assume_unique_for_key(iv).ok()?;
    let mut buffer = sealed.to_vec();
    let plain = key.open_in_place(nonce, Aad::empty(), &mut buffer).ok()?;
    Some(plain.to_vec())
}

fn cbc(key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    let key = PaddedBlockDecryptingKey::cbc_pkcs7(UnboundCipherKey::new(&AES_256, key).ok()?).ok()?;
    let iv: [u8; CBC_IV] = iv.try_into().ok()?;
    let mut buffer = data.to_vec();
    let plain = key.decrypt(&mut buffer, DecryptionContext::Iv128(iv.into())).ok()?;
    Some(plain.to_vec())
}

fn der_length(len: usize, out: &mut Vec<u8>) {
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes: Vec<u8> = len.to_be_bytes().into_iter().skip_while(|b| *b == 0).collect();
        out.push(0x80 | bytes.len() as u8);
        out.extend(bytes);
    }
}

fn der(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    der_length(content.len(), &mut out);
    out.extend_from_slice(content);
    out
}

fn der_integer(bytes: &[u8]) -> Vec<u8> {
    let trimmed: Vec<u8> = bytes.iter().copied().skip_while(|b| *b == 0).collect();
    let mut content = if trimmed.is_empty() { vec![0] } else { trimmed };
    if content[0] & 0x80 != 0 {
        content.insert(0, 0);
    }
    der(0x02, &content)
}

/// A JWK RSA private key as PKCS#8 DER, the only form aws-lc imports.
fn jwk_to_pkcs8(jwk: &Value) -> Result<Vec<u8>, E2eError> {
    let mut rsa = der_integer(&[0]);
    for field in ["n", "e", "d", "p", "q", "dp", "dq", "qi"] {
        let value = jwk.get(field).and_then(Value::as_str).ok_or(E2eError::Undecipherable("jwk"))?;
        rsa.extend(der_integer(&b64url(value)?));
    }
    let rsa = der(0x30, &rsa);
    let algorithm =
        der(0x30, &[&[0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01][..], &[0x05, 0x00]].concat());
    let mut info = der_integer(&[0]);
    info.extend(algorithm);
    info.extend(der(0x04, &rsa));
    Ok(der(0x30, &info))
}

pub struct PrivateKey(OaepPrivateDecryptingKey);

impl std::fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PrivateKey(..)")
    }
}

fn import_jwk(jwk: &[u8]) -> Result<PrivateKey, E2eError> {
    let jwk: Value = serde_json::from_slice(jwk).map_err(|_| E2eError::WrongPassword)?;
    let key = PrivateDecryptingKey::from_pkcs8(&jwk_to_pkcs8(&jwk)?).map_err(|_| E2eError::Undecipherable("rsa"))?;
    Ok(PrivateKey(OaepPrivateDecryptingKey::new(key).map_err(|_| E2eError::Undecipherable("oaep"))?))
}

/// `e2e.fetchMyKeys`' `private_key`, opened with the E2E password: v2 is a
/// JSON envelope (PBKDF2 with its own salt and rounds, AES-GCM); v1 is
/// `IV || AES-CBC`, salted with the user id, 1000 rounds.
pub fn unlock_private_key(private_key: &str, password: &str, uid: &str) -> Result<PrivateKey, E2eError> {
    let raw = private_key.trim();
    if raw.is_empty() {
        return Err(E2eError::NoKeys);
    }
    let envelope: Option<Value> = raw.starts_with('{').then(|| serde_json::from_str(raw).ok()).flatten();
    let v1 = match &envelope {
        Some(e) if e.get("iterations").is_some() && e.get("salt").is_some() => {
            let text = |k: &str| e.get(k).and_then(Value::as_str).unwrap_or_default();
            let rounds = e.get("iterations").and_then(Value::as_u64).unwrap_or(0) as u32;
            let key = pbkdf2(password, text("salt").as_bytes(), rounds);
            let jwk = gcm(&key, &b64(text("iv"))?, &b64(text("ciphertext"))?).ok_or(E2eError::WrongPassword)?;
            return import_jwk(&jwk);
        }
        Some(e) => b64(e.get("$binary").and_then(Value::as_str).ok_or(E2eError::NoKeys)?)?,
        None => b64(raw)?,
    };
    if v1.len() <= CBC_IV {
        return Err(E2eError::Undecipherable("v1 key"));
    }
    let key = pbkdf2(password, uid.as_bytes(), 1000);
    let jwk = cbc(&key, &v1[..CBC_IV], &v1[CBC_IV..]).ok_or(E2eError::WrongPassword)?;
    import_jwk(&jwk)
}

/// The key id an `E2EKey` starts with (a UUID in v2, 12 characters in v1).
pub fn key_id(e2e_key: &str) -> &str {
    &e2e_key[..e2e_key.len().saturating_sub(RSA_B64_LEN)]
}

/// A room's AES key, from its subscription's `E2EKey`.
pub fn room_key(e2e_key: &str, private: &PrivateKey) -> Result<Vec<u8>, E2eError> {
    let wrapped = b64(&e2e_key[key_id(e2e_key).len()..])?;
    let mut out = vec![0u8; private.0.min_output_size()];
    let jwk = private
        .0
        .decrypt(&OAEP_SHA256_MGF1SHA256, &wrapped, &mut out, None)
        .map_err(|_| E2eError::Undecipherable("room key"))?;
    let jwk: Value = serde_json::from_slice(jwk).map_err(|_| E2eError::Undecipherable("room key jwk"))?;
    b64url(jwk.get("k").and_then(Value::as_str).ok_or(E2eError::Undecipherable("room key k"))?)
}

/// A message's `content` opened with its room's key: v2 carries `iv` (12
/// bytes GCM, 16 bytes CBC for old accounts); v1 has `keyId(12) + b64(IV || CBC)`.
pub fn decrypt_message(content: &str, room_key: &[u8]) -> Result<String, E2eError> {
    let content: Value = serde_json::from_str(content).map_err(|_| E2eError::Undecipherable("content"))?;
    let ciphertext = content.get("ciphertext").and_then(Value::as_str).ok_or(E2eError::Undecipherable("ciphertext"))?;
    let plain = match content.get("iv").and_then(Value::as_str).filter(|iv| !iv.is_empty()) {
        Some(iv) => {
            let (iv, data) = (b64(iv)?, b64(ciphertext)?);
            if iv.len() == 12 { gcm(room_key, &iv, &data) } else { cbc(room_key, &iv, &data) }
        }
        None => {
            let blob = b64(ciphertext.get(12..).unwrap_or_default())?;
            (blob.len() > CBC_IV).then(|| cbc(room_key, &blob[..CBC_IV], &blob[CBC_IV..])).flatten()
        }
    }
    .ok_or(E2eError::Undecipherable("message"))?;
    let text = String::from_utf8(plain).map_err(|_| E2eError::Undecipherable("utf-8"))?;
    Ok(serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v.get("msg").or_else(|| v.get("text")).and_then(Value::as_str).map(str::to_owned))
        .unwrap_or(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lc_rs::aead::NONCE_LEN;
    use aws_lc_rs::cipher::{EncryptionContext, PaddedBlockEncryptingKey};

    fn seal_gcm(key: &[u8], iv: &[u8], plain: &[u8]) -> Vec<u8> {
        let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).unwrap());
        let mut buffer = plain.to_vec();
        key.seal_in_place_append_tag(Nonce::try_assume_unique_for_key(iv).unwrap(), Aad::empty(), &mut buffer).unwrap();
        buffer
    }

    fn seal_cbc(key: &[u8], iv: [u8; 16], plain: &[u8]) -> Vec<u8> {
        let key = PaddedBlockEncryptingKey::cbc_pkcs7(UnboundCipherKey::new(&AES_256, key).unwrap()).unwrap();
        let mut buffer = plain.to_vec();
        key.less_safe_encrypt(&mut buffer, EncryptionContext::Iv128(iv.into())).unwrap();
        buffer
    }

    #[test]
    fn messages_in_all_three_shapes() {
        let key = [7u8; 32];
        let gcm_iv = [1u8; NONCE_LEN];
        let v2 = serde_json::json!({"algorithm":"rc.v2.aes-sha2","kid":"k","iv":STANDARD.encode(gcm_iv),
            "ciphertext":STANDARD.encode(seal_gcm(&key, &gcm_iv, br#"{"msg":"hello gcm"}"#))});
        assert_eq!(decrypt_message(&v2.to_string(), &key).unwrap(), "hello gcm");
        let cbc_iv = [2u8; 16];
        let old = serde_json::json!({"iv":STANDARD.encode(cbc_iv),
            "ciphertext":STANDARD.encode(seal_cbc(&key, cbc_iv, br#"{"text":"hello cbc"}"#))});
        assert_eq!(decrypt_message(&old.to_string(), &key).unwrap(), "hello cbc");
        let blob = [&cbc_iv[..], &seal_cbc(&key, cbc_iv, b"plain v1")].concat();
        let v1 = serde_json::json!({"ciphertext": format!("abcdefghijkl{}", STANDARD.encode(blob))});
        assert_eq!(decrypt_message(&v1.to_string(), &key).unwrap(), "plain v1");
        assert!(decrypt_message(&v2.to_string(), &[8u8; 32]).is_err());
    }

    #[test]
    fn wrong_password_is_told_apart() {
        let key = pbkdf2("right", b"v2:u:salt", 1000);
        let iv = [3u8; NONCE_LEN];
        let envelope = serde_json::json!({"iv":STANDARD.encode(iv),"salt":"v2:u:salt","iterations":1000,
            "ciphertext":STANDARD.encode(seal_gcm(&key, &iv, b"{\"kty\":\"RSA\"}"))});
        assert_eq!(unlock_private_key(&envelope.to_string(), "wrong", "u").unwrap_err(), E2eError::WrongPassword);
        // Right password, but the JWK lacks the RSA fields.
        assert_eq!(
            unlock_private_key(&envelope.to_string(), "right", "u").unwrap_err(),
            E2eError::Undecipherable("jwk")
        );
        assert_eq!(unlock_private_key("", "x", "u").unwrap_err(), E2eError::NoKeys);
    }

    #[test]
    fn der_integers() {
        assert_eq!(der_integer(&[0x00, 0x01]), [0x02, 0x01, 0x01]);
        assert_eq!(der_integer(&[0x80]), [0x02, 0x02, 0x00, 0x80]);
        let mut long = Vec::new();
        der_length(300, &mut long);
        assert_eq!(long, [0x82, 0x01, 0x2C]);
        assert_eq!(key_id(&format!("{}{}", "u".repeat(36), "x".repeat(RSA_B64_LEN))), "u".repeat(36));
    }
}
