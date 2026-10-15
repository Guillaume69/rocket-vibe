//! One-use encrypted handoff from the dedicated official-browser bridge. No durable secrets.
use crate::slack::{Error, validate_credentials};
use aws_lc_rs::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use aws_lc_rs::{
    agreement::{self, PrivateKey, UnparsedPublicKey, X25519},
    hkdf,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use zeroize::{Zeroize, Zeroizing};
fn failure(code: &'static str) -> Error {
    Error { code, status: 0, retry_after: None }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IncomingAccount {
    team_id: String,
    user_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Incoming {
    version: u32,
    account: IncomingAccount,
    token: String,
    cookie: String,
    expires_at: u64,
    transfer_expires_at: u64,
}
impl Drop for Incoming {
    fn drop(&mut self) {
        self.token.zeroize();
        self.cookie.zeroize();
    }
}
pub struct BrowserSession {
    pub team_id: String,
    pub user_id: String,
    pub token: Zeroizing<String>,
    pub cookie: Zeroizing<String>,
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
        if parts.len() != 4 || parts[0] != "rvslack1" {
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
                let info = [b"rocketvibe-slack-handoff-v1".as_slice(), recipient.as_ref(), peer.as_slice()];
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
                Aad::from(b"rocketvibe-slack-handoff-v1"),
                &mut plain,
            )
            .map_err(|_| failure("invalid_handoff"))?;
        let body: Incoming = serde_json::from_slice(raw).map_err(|_| failure("invalid_handoff"))?;
        if body.version != 1 {
            return Err(failure("invalid_handoff"));
        }
        for (id, prefixes) in [(&body.account.team_id, b"T".as_slice()), (&body.account.user_id, b"UW".as_slice())] {
            if id.len() < 2
                || id.len() > 128
                || !prefixes.contains(&id.as_bytes()[0])
                || !id.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            {
                return Err(failure("invalid_handoff"));
            }
        }
        if body.transfer_expires_at <= now
            || body.transfer_expires_at > now.saturating_add(300000)
            || body.expires_at <= now.saturating_add(60000)
            || body.expires_at > now.saturating_add(3600000)
        {
            return Err(failure("expired_handoff"));
        }
        validate_credentials(&body.token, &body.cookie)?;
        guard.take();
        Ok(BrowserSession {
            team_id: body.account.team_id.clone(),
            user_id: body.account.user_id.clone(),
            token: Zeroizing::new(body.token.clone()),
            cookie: Zeroizing::new(body.cookie.clone()),
            expires_at: body.expires_at,
        })
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
        serde_json::from_str(include_str!("../../../../../../docs/protocol/fixtures/slack-handoff.json")).unwrap()
    }
    fn pair(f: &serde_json::Value) -> Pairing {
        Pairing {
            key: Mutex::new(Some(Zeroizing::new(URL_SAFE_NO_PAD.decode(f["privateKey"].as_str().unwrap()).unwrap()))),
        }
    }
    #[test]
    fn authenticated_invalid_plaintext_is_rejected() {
        let f = fixture();
        for code in f["invalid"].as_array().unwrap() {
            assert!(pair(&f).open_at(code.as_str().unwrap(), f["now"].as_u64().unwrap()).is_err());
        }
    }
    #[test]
    fn shared_vector_opens_once_and_preserves_cookie() {
        let f = fixture();
        let p = pair(&f);
        assert_eq!(p.code().unwrap(), f["pairingCode"].as_str().unwrap());
        let s = p.open_at(f["code"].as_str().unwrap(), f["now"].as_u64().unwrap()).unwrap();
        assert_eq!(s.cookie.as_str(), "xoxd-original%2Bbytes%3D");
        assert_eq!(s.team_id, "TTEST");
        assert_eq!(
            p.open_at(f["code"].as_str().unwrap(), f["now"].as_u64().unwrap()).err().unwrap().code,
            "pairing_closed"
        );
    }
    #[test]
    fn rejects_wrong_recipient_provider_tampering_expiry_and_disposal() {
        let f = fixture();
        let code = f["code"].as_str().unwrap();
        let now = f["now"].as_u64().unwrap();
        assert!(Pairing::new().unwrap().open_at(code, now).is_err());
        let p = pair(&f);
        assert!(p.open_at(&code.replace("rvslack1", "rvteams2"), now).is_err());
        assert!(p.open_at(&format!("{code}="), now).is_err());
        assert!(p.open_at(code, now + 300001).is_err());
        p.close();
        assert!(p.code().is_err());
    }
}
