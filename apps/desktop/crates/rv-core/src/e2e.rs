//! End-to-end encrypted rooms (Rocket.Chat `rc.v1`/`rc.v2`): reading them,
//! and writing messages and files the way the web client does. The private
//! key, unlocked with the E2E password, stays in memory; each room's AES key
//! is unwrapped from its subscription's `E2EKey`.

use aws_lc_rs::aead::{AES_128_GCM, AES_256_GCM, Aad, Algorithm, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use aws_lc_rs::cipher::{
    AES_128, AES_256, Algorithm as CipherAlgorithm, DecryptingKey, DecryptionContext, EncryptingKey, EncryptionContext,
    PaddedBlockDecryptingKey, PaddedBlockEncryptingKey, UnboundCipherKey,
};
use aws_lc_rs::digest::{SHA256, digest};
use aws_lc_rs::rsa::{OAEP_SHA256_MGF1SHA256, OaepPrivateDecryptingKey, PrivateDecryptingKey};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Value, json};

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

/// The AES variant a key's length calls for: a room created by the old web
/// client has a 16-byte `A128CBC` key, a recent one 32 bytes.
fn gcm_for(key: &[u8]) -> Option<&'static Algorithm> {
    match key.len() {
        16 => Some(&AES_128_GCM),
        32 => Some(&AES_256_GCM),
        _ => None,
    }
}

fn cbc_for(key: &[u8]) -> Option<&'static CipherAlgorithm> {
    match key.len() {
        16 => Some(&AES_128),
        32 => Some(&AES_256),
        _ => None,
    }
}

/// AES-GCM with the tag at the end (WebCrypto's layout). None when it does
/// not authenticate: a wrong key.
fn gcm(key: &[u8], iv: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < GCM_TAG {
        return None;
    }
    let key = LessSafeKey::new(UnboundKey::new(gcm_for(key)?, key).ok()?);
    let nonce = Nonce::try_assume_unique_for_key(iv).ok()?;
    let mut buffer = sealed.to_vec();
    let plain = key.open_in_place(nonce, Aad::empty(), &mut buffer).ok()?;
    Some(plain.to_vec())
}

fn cbc(key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    let key = PaddedBlockDecryptingKey::cbc_pkcs7(UnboundCipherKey::new(cbc_for(key)?, key).ok()?).ok()?;
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

/// What an encrypted message carries once open: its text, and for a file
/// its attachments, which hold each file's key.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Payload {
    pub text: String,
    pub attachments: Option<Value>,
}

/// A message's `content` opened with its room's key: v2 carries `iv` (12
/// bytes GCM, 16 bytes CBC for old accounts); v1 has `keyId(12) + b64(IV || CBC)`.
pub fn decrypt_message(content: &str, room_key: &[u8]) -> Result<String, E2eError> {
    decrypt_payload(content, room_key).map(|p| p.text)
}

pub fn decrypt_payload(content: &str, room_key: &[u8]) -> Result<Payload, E2eError> {
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
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return Ok(Payload { text, attachments: None }) };
    let attachments = value.get("attachments").filter(|a| a.is_array()).cloned();
    match value.get("msg").or_else(|| value.get("text")).and_then(Value::as_str) {
        Some(msg) => Ok(Payload { text: msg.to_owned(), attachments }),
        None if attachments.is_some() => Ok(Payload { text: String::new(), attachments }),
        None => Ok(Payload { text, attachments: None }),
    }
}

fn random<const N: usize>() -> Result<[u8; N], E2eError> {
    let mut bytes = [0u8; N];
    aws_lc_rs::rand::fill(&mut bytes).map_err(|_| E2eError::Undecipherable("random"))?;
    Ok(bytes)
}

/// A payload (`{msg}`, plus the attachments of a file) as the `rc.v2.aes-sha2`
/// content the web client sends. The mode follows the room key, as WebCrypto
/// imports it from its JWK: `A128CBC` (16 bytes) is CBC with a 16-byte IV,
/// `A256GCM` (32 bytes) GCM with a 12-byte IV and the tag at the end.
pub fn encrypt_message(payload: &Value, room_key: &[u8], kid: &str) -> Result<Value, E2eError> {
    let mut data = payload.to_string().into_bytes();
    let iv = match room_key.len() {
        16 => {
            let iv = random::<CBC_IV>()?;
            let key = UnboundCipherKey::new(&AES_128, room_key).map_err(|_| E2eError::Undecipherable("room key"))?;
            let key = PaddedBlockEncryptingKey::cbc_pkcs7(key).map_err(|_| E2eError::Undecipherable("room key"))?;
            key.less_safe_encrypt(&mut data, EncryptionContext::Iv128(iv.into()))
                .map_err(|_| E2eError::Undecipherable("encrypt"))?;
            iv.to_vec()
        }
        32 => {
            let iv = random::<NONCE_LEN>()?;
            let key = LessSafeKey::new(
                UnboundKey::new(&AES_256_GCM, room_key).map_err(|_| E2eError::Undecipherable("room key"))?,
            );
            key.seal_in_place_append_tag(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut data)
                .map_err(|_| E2eError::Undecipherable("encrypt"))?;
            iv.to_vec()
        }
        _ => return Err(E2eError::Undecipherable("room key")),
    };
    Ok(
        json!({"algorithm": "rc.v2.aes-sha2", "kid": kid, "iv": STANDARD.encode(iv), "ciphertext": STANDARD.encode(data)}),
    )
}

/// The server cannot read an encrypted message, so it notifies only whom
/// `e2eMentions` names (probed on 8.5): an `@` or `#` at the start or after a
/// blank, as the web client parses them.
pub fn mentions(text: &str) -> Value {
    let pick = |sigil: char| {
        let mut found: Vec<String> = Vec::new();
        for word in text.split_whitespace() {
            let Some(rest) = word.strip_prefix(sigil) else { continue };
            let name: String =
                rest.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@')).collect();
            let name = name.trim_end_matches(['.', '-', '@']);
            if !name.is_empty() && !found.iter().any(|f| f[1..] == *name) {
                found.push(format!("{sigil}{name}"));
            }
        }
        found
    };
    json!({"e2eUserMentions": pick('@'), "e2eChannelMentions": pick('#')})
}

/// How a file of an encrypted room was encrypted, from its attachment: its
/// own AES-CTR key, a 16-byte initial counter, and the SHA-256 of the plain file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEncryption {
    key: Vec<u8>,
    iv: [u8; 16],
    sha256: Option<String>,
}

/// None when the attachment is not an encrypted one.
pub fn file_encryption(attachment: &Value) -> Option<FileEncryption> {
    let encryption = attachment.get("encryption")?;
    let key = b64url(encryption.get("key")?.get("k")?.as_str()?).ok()?;
    let iv = b64(encryption.get("iv")?.as_str()?).ok()?.try_into().ok()?;
    let sha256 = attachment.get("hashes").and_then(|h| h.get("sha256")).and_then(Value::as_str).map(str::to_lowercase);
    Some(FileEncryption { key, iv, sha256 })
}

fn sha256_hex(data: &[u8]) -> String {
    digest(&SHA256, data).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// The downloaded bytes of an encrypted file, in clear. CTR has no tag: a
/// wrong key yields noise, which the sender's SHA-256 turns down.
pub fn decrypt_file(data: &[u8], encryption: &FileEncryption) -> Result<Vec<u8>, E2eError> {
    let key =
        UnboundCipherKey::new(cbc_for(&encryption.key).ok_or(E2eError::Undecipherable("file key"))?, &encryption.key)
            .map_err(|_| E2eError::Undecipherable("file key"))?;
    let key = DecryptingKey::ctr(key).map_err(|_| E2eError::Undecipherable("file key"))?;
    let mut plain = data.to_vec();
    key.decrypt(&mut plain, DecryptionContext::Iv128(encryption.iv.into()))
        .map_err(|_| E2eError::Undecipherable("file"))?;
    if encryption.sha256.as_ref().is_some_and(|hash| *hash != sha256_hex(&plain)) {
        return Err(E2eError::Undecipherable("file hash"));
    }
    Ok(plain)
}

/// A file encrypted to be sent, and what its attachment must say to open it.
pub struct EncryptedFile {
    pub data: Vec<u8>,
    /// The key as the JWK the web client imports back.
    pub key: Value,
    pub iv: String,
    pub sha256: String,
}

/// A fresh AES-256-CTR key and 16-byte counter, as the web client does.
pub fn encrypt_file(plain: &[u8]) -> Result<EncryptedFile, E2eError> {
    let raw = random::<32>()?;
    let iv = random::<16>()?;
    let key = UnboundCipherKey::new(&AES_256, &raw).map_err(|_| E2eError::Undecipherable("file key"))?;
    let key = EncryptingKey::ctr(key).map_err(|_| E2eError::Undecipherable("file key"))?;
    let mut data = plain.to_vec();
    key.less_safe_encrypt(&mut data, EncryptionContext::Iv128(iv.into()))
        .map_err(|_| E2eError::Undecipherable("encrypt"))?;
    Ok(EncryptedFile {
        data,
        key: json!({"kty": "oct", "alg": "A256CTR", "k": URL_SAFE_NO_PAD.encode(raw), "ext": true,
            "key_ops": ["encrypt", "decrypt"]}),
        iv: STANDARD.encode(iv),
        sha256: sha256_hex(plain),
    })
}

/// The name an encrypted file is uploaded under: the SHA-256 of its real one.
pub fn hashed_name(name: &str) -> String {
    sha256_hex(name.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seal_gcm(key: &[u8], iv: &[u8], plain: &[u8]) -> Vec<u8> {
        let key = LessSafeKey::new(UnboundKey::new(gcm_for(key).unwrap(), key).unwrap());
        let mut buffer = plain.to_vec();
        key.seal_in_place_append_tag(Nonce::try_assume_unique_for_key(iv).unwrap(), Aad::empty(), &mut buffer).unwrap();
        buffer
    }

    fn seal_cbc(key: &[u8], iv: [u8; 16], plain: &[u8]) -> Vec<u8> {
        let key =
            PaddedBlockEncryptingKey::cbc_pkcs7(UnboundCipherKey::new(cbc_for(key).unwrap(), key).unwrap()).unwrap();
        let mut buffer = plain.to_vec();
        key.less_safe_encrypt(&mut buffer, EncryptionContext::Iv128(iv.into())).unwrap();
        buffer
    }

    #[test]
    fn messages_in_all_three_shapes() {
        for size in [16, 32] {
            let key = vec![7u8; size];
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
            assert!(decrypt_message(&v2.to_string(), &vec![8u8; size]).is_err());
        }
        let v2 = serde_json::json!({"iv":STANDARD.encode([1u8; NONCE_LEN]),"ciphertext":STANDARD.encode([0u8; 32])});
        assert!(decrypt_message(&v2.to_string(), &[7u8; 20]).is_err());
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

    /// Produced by WebCrypto, the web client's API: what it sends, we read.
    const WEB_CBC128: (&str, &str) = (
        "kbrRJ76LN1qBuiTCe4yRzA==",
        r#"{"algorithm":"rc.v2.aes-sha2","kid":"eyJhbGciOiJB","iv":"0Kqxr4TXQEiUvWxKvRa0Kg==","ciphertext":"Y+yZeC80n9AOMnM5ouO7DhqoiAYS8ozKFVyIERht//te/9Aw3RLGeW4IGtl4laCrQw4B5B+OWGxE3GIkHou9Lg=="}"#,
    );
    const WEB_GCM256: (&str, &str) = (
        "2dFWn9e/aByyI8skXM8iJFBmFNXYFSGofuob3DeKqcY=",
        r#"{"algorithm":"rc.v2.aes-sha2","kid":"eyJhbGciOiJB","iv":"/pV24hyq0+ZM545s","ciphertext":"ZhRaUfEoQ7UNTrIuqL0ZHWuYJGn3rekj0lFWO6iThObF/m9fbdJTp8CpD1HphBRVqRCnHKZrVi3hvOjAutjj9OL1TfplvIBFqQD+lIY="}"#,
    );
    const WEB_FILE: &str = "LzwjrmqGFMkEw1Jh+5ziwqJQwSbu0cXD0bke/7AoCsG+ihmzFkzf733a6H8opL2g9082wu28ld26Wr+OTkFSXG2niPMUW7OHS+cazmfLDhuHNKo78te3cTgLWWS6u4OLq0Q5x5rN9SNJoimqA3LMZqO1KszcnzYHhqMQwEEEpfGMz9oLkpfW/JpeoOCaK3XSPgnhPF7Wfm0RHHIhCyTk91j4NQ1N0GBt+paV5XePa5fyZ7N9tAj30ae5IeZImqn0Nhbx6Di+Y0KwlaS6/9+eOKQczQl6fYAhgdle8KXkY6yzPSucjXw+/zkx53Lw2/OH33zCxPQIhjNFTWhCr4vbqiLJMeeyN5rsI4ih32o4Wh1NXFg4CWlmaokXtOrctnksSVwBET3eLn878uJf8Wgtx3QByLE/0zkCg6STz8V67IeTua5/aLze+3lE1/xGbDQ83zgFGyWDrtjsvefUq6tagDEbsWECM8AbM0xmh6ar5hcOjqSN6cYCx7JZ20WypiNMKUkh5RIP60saZA5T03P8gPEQOYp5irjxsSrzR8JBGrZpSKvHtamNqj3BOuz4KO5NqYZPreeVe/4SIFHymIQlbE7L2UuFRusXyRrtBgJ4wh0FwIk7dXGohmiFX0v5YIN3NMXYSgrdXSH+YqJS2OPM/6FaWUGwxZbvwUmir8GNOfP92s1xNu/nWCEmlW4hLk8Oixbw1fNX/3J59jOjbVJYUOl2c/ztk0Hi3esLMVnFA+1EDzdWuyzoiotdOiSDCnFV57/CCRyzQReU/0JgBCFD8lc8aonHQ86hLnPocD2effIxzZAWjq5AiT98hKPZZRPPxWkaevF8lLF87HJatd7hdOTJC5E6PJGX55g1D87HHxDpZzuCF+VgK0lNS6s7JdEmHXx73KKfZPmUqv56mNyX0W4y1O6QYabPROtt4+K8TeoX0gnxhlEgsiSnCn029Q9hXVWCAqejo1k75bfNq50jEdszWqR6QBNZhjhfblCDmhkaHlorES16ig==";
    const WEB_FILE_ATTACHMENT: &str = r#"{"encryption":{"key":{"key_ops":["encrypt","decrypt"],"ext":true,"alg":"A256CTR","kty":"oct","k":"igYjqNQSL-4byYpjspl_CJa6Osw4cJUGdN8qP1ksito"},"iv":"dyV1C2Ef6zENR3vcrwPRMA=="},"hashes":{"sha256":"8cd11c550acc9cae256ebd8f87f5f91b5424e4cde004a8addbc2721d021cfe13"}}"#;

    #[test]
    fn what_the_web_client_encrypts_opens() {
        for (key, content) in [WEB_CBC128, WEB_GCM256] {
            let payload = decrypt_payload(content, &STANDARD.decode(key).unwrap()).unwrap();
            assert_eq!(payload.text, "salut du web 🔒");
            assert_eq!(payload.attachments, Some(json!([{"title": "a.png"}])));
        }
        let encryption = file_encryption(&serde_json::from_str(WEB_FILE_ATTACHMENT).unwrap()).unwrap();
        let plain = decrypt_file(&STANDARD.decode(WEB_FILE).unwrap(), &encryption).unwrap();
        assert_eq!(plain, "contenu du fichier ".repeat(40).into_bytes());
    }

    #[test]
    fn what_we_encrypt_opens_in_the_mode_of_the_key() {
        for (size, iv_len) in [(16, 16), (32, 12)] {
            let key = vec![5u8; size];
            let payload = json!({"msg": "envoyé 🔒", "attachments": [{"title": "b.pdf"}]});
            let content = encrypt_message(&payload, &key, "kid").unwrap();
            assert_eq!(content["kid"], "kid");
            assert_eq!(STANDARD.decode(content["iv"].as_str().unwrap()).unwrap().len(), iv_len);
            let opened = decrypt_payload(&content.to_string(), &key).unwrap();
            assert_eq!(opened.text, "envoyé 🔒");
            assert_eq!(opened.attachments, Some(json!([{"title": "b.pdf"}])));
            assert_ne!(encrypt_message(&payload, &key, "kid").unwrap()["iv"], content["iv"]);
        }
        assert!(encrypt_message(&json!({"msg": "x"}), &[1u8; 20], "kid").is_err());
    }

    #[test]
    fn files_round_trip_and_a_wrong_key_is_caught() {
        let plain = b"%PDF-1.4 rapport secret".repeat(100);
        let sent = encrypt_file(&plain).unwrap();
        assert_eq!(sent.key["alg"], "A256CTR");
        let attachment = json!({"encryption": {"key": sent.key, "iv": sent.iv}, "hashes": {"sha256": sent.sha256}});
        let encryption = file_encryption(&attachment).unwrap();
        assert_eq!(decrypt_file(&sent.data, &encryption).unwrap(), plain);
        let mut altered = sent.data.clone();
        altered[3] ^= 1;
        assert!(decrypt_file(&altered, &encryption).is_err());
        assert_eq!(file_encryption(&json!({"title": "clear.pdf"})), None);
        assert_eq!(hashed_name("a").len(), 64);
    }

    #[test]
    fn mentions_for_the_server() {
        assert_eq!(
            mentions("@bob look at #general, @bob and @carol. mail alice@example.com @dave@other.server"),
            json!({"e2eUserMentions": ["@bob", "@carol", "@dave@other.server"], "e2eChannelMentions": ["#general"]})
        );
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
