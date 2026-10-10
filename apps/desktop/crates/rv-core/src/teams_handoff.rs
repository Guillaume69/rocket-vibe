//! One-use encrypted handoff from the dedicated official-browser bridge. No durable secrets.
use crate::teams::{Account, Error, Tokens};
use aws_lc_rs::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use aws_lc_rs::{
    agreement::{self, PrivateKey, UnparsedPublicKey, X25519},
    hkdf,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;
fn failure(code: &'static str) -> Error {
    Error { code, status: 0, retry_after: None }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IncomingAccount {
    tenant_id: String,
    account_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Incoming {
    version: u32,
    account: IncomingAccount,
    tokens: Tokens,
    expires_at: u64,
    transfer_expires_at: u64,
}
pub struct BrowserSession {
    pub account: Account,
    pub tokens: Tokens,
    pub expires_at: u64,
}
struct AesKey;
impl hkdf::KeyType for AesKey {
    fn len(&self) -> usize {
        32
    }
}
fn private(seed: &[u8]) -> Result<PrivateKey, Error> {
    PrivateKey::from_private_key(&X25519, seed).map_err(|_| failure("invalid_handoff"))
}
pub struct Pairing {
    key: Mutex<Option<Zeroizing<Vec<u8>>>>,
}
impl Pairing {
    pub fn new() -> Result<Arc<Self>, Error> {
        let mut key = Zeroizing::new(vec![0; 32]);
        getrandom::fill(&mut key).map_err(|_| failure("randomness_unavailable"))?;
        Ok(Arc::new(Self { key: Mutex::new(Some(key)) }))
    }
    pub fn code(&self) -> Result<String, Error> {
        self.key
            .lock()
            .expect("pairing")
            .as_ref()
            .map(|k| {
                private(k).and_then(|key| {
                    key.compute_public_key()
                        .map(|p| URL_SAFE_NO_PAD.encode(p.as_ref()))
                        .map_err(|_| failure("invalid_handoff"))
                })
            })
            .ok_or_else(|| failure("pairing_closed"))?
    }
    pub fn close(&self) {
        self.key.lock().expect("pairing").take();
    }
    pub fn open(&self, code: &str) -> Result<BrowserSession, Error> {
        self.open_at(code, chrono::Utc::now().timestamp_millis().max(0) as u64)
    }
    fn open_at(&self, code: &str, now: u64) -> Result<BrowserSession, Error> {
        if code.len() > 300000 {
            return Err(failure("invalid_handoff"));
        }
        let parts = code.split('.').collect::<Vec<_>>();
        if parts.len() != 4 || parts[0] != "rvteams2" {
            return Err(failure("invalid_handoff"));
        }
        let peer = URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| failure("invalid_handoff"))?;
        if peer.len() != 32 {
            return Err(failure("invalid_handoff"));
        }
        let nonce = URL_SAFE_NO_PAD.decode(parts[2]).map_err(|_| failure("invalid_handoff"))?;
        let mut plain = Zeroizing::new(URL_SAFE_NO_PAD.decode(parts[3]).map_err(|_| failure("invalid_handoff"))?);
        if nonce.len() != 12 || plain.len() < 17 || plain.len() > 200000 {
            return Err(failure("invalid_handoff"));
        }
        let mut guard = self.key.lock().expect("pairing");
        let key = guard.as_ref().ok_or_else(|| failure("pairing_closed"))?;
        let receiver = private(key)?;
        let recipient = receiver.compute_public_key().map_err(|_| failure("invalid_handoff"))?;
        let secret = agreement::agree(
            &receiver,
            UnparsedPublicKey::new(&X25519, &peer),
            failure("invalid_handoff"),
            |shared| {
                let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, &[0; 32]);
                let prk = salt.extract(shared);
                let info = [b"rocketvibe-teams-handoff-v2".as_slice(), recipient.as_ref(), peer.as_slice()];
                let okm = prk.expand(&info, AesKey).map_err(|_| failure("invalid_handoff"))?;
                let mut result = Zeroizing::new(vec![0; 32]);
                okm.fill(&mut result).map_err(|_| failure("invalid_handoff"))?;
                Ok(result)
            },
        )?;
        let cipher = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &secret).map_err(|_| failure("invalid_handoff"))?);
        let raw = cipher
            .open_in_place(
                Nonce::try_assume_unique_for_key(&nonce).map_err(|_| failure("invalid_handoff"))?,
                Aad::from(b"rocketvibe-teams-handoff-v2"),
                &mut plain,
            )
            .map_err(|_| failure("invalid_handoff"))?;
        let body: Incoming = serde_json::from_slice(raw).map_err(|_| failure("invalid_handoff"))?;
        if body.version != 1 {
            return Err(failure("invalid_handoff"));
        }
        let account = Account { tenant_id: body.account.tenant_id, account_id: body.account.account_id };
        account.key()?;
        if body.transfer_expires_at <= now
            || body.transfer_expires_at > now.saturating_add(300000)
            || body.expires_at <= now.saturating_add(60000)
            || body.expires_at > now.saturating_add(86400000)
        {
            return Err(failure("expired_handoff"));
        }
        for t in [&body.tokens.spaces, &body.tokens.aggregator, &body.tokens.chat] {
            if t.is_empty()
                || t.len() > 65536
                || !t.bytes().all(|b| b.is_ascii_alphanumeric() || b"._~+/-=".contains(&b))
            {
                return Err(failure("invalid_handoff"));
            }
        }
        guard.take();
        Ok(BrowserSession { account, tokens: body.tokens, expires_at: body.expires_at })
    }
}
impl Drop for Pairing {
    fn drop(&mut self) {
        self.close();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../../../docs/protocol/fixtures/teams-handoff.json")).unwrap()
    }
    fn pairing(key: &str) -> Pairing {
        Pairing { key: Mutex::new(Some(Zeroizing::new(URL_SAFE_NO_PAD.decode(key).unwrap()))) }
    }
    #[test]
    fn native_crypto_opens_shared_vector_once_and_preserves_opaque_tokens() {
        let f = fixture();
        let pair = pairing(f["privateKey"].as_str().unwrap());
        assert_eq!(pair.code().unwrap(), f["pairingCode"].as_str().unwrap());
        let code = f["code"].as_str().unwrap();
        let session = pair.open_at(code, f["now"].as_u64().unwrap()).unwrap();
        assert_eq!(session.tokens.chat, "synthetic-chat");
        assert_eq!(session.account.account_id, "synthetic-account");
        assert_eq!(pair.open_at(code, f["now"].as_u64().unwrap()).err().unwrap().code, "pairing_closed");
    }
    #[test]
    fn wrong_key_tampering_expiry_and_close_fail() {
        let f = fixture();
        let code = f["code"].as_str().unwrap();
        let now = f["now"].as_u64().unwrap();
        let wrong = Pairing::new().unwrap();
        assert_eq!(wrong.open_at(code, now).err().unwrap().code, "invalid_handoff");
        let pair = pairing(f["pairingKey"].as_str().unwrap());
        let mut modified = code.to_owned();
        modified.replace_range(modified.len() - 4..modified.len() - 3, "x");
        assert!(pair.open_at(&modified, now).is_err());
        assert_eq!(pair.open_at(code, now + 300001).err().unwrap().code, "expired_handoff");
        pair.close();
        assert_eq!(pair.code().unwrap_err().code, "pairing_closed");
    }
}
