//! Browser worker adapter for the shared Rust ceremony and MLS engine. Only the
//! worker may restore/export a private snapshot. The page gets public ceremony
//! material and transient render documents after the host's durable commit.
#![forbid(unsafe_code)]
#![cfg(target_arch = "wasm32")]
use rv_crypto_mobile::{CryptoBridgeError, CryptoInstallation, ProtectedKeystore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, Zeroizing};

#[derive(Default)]
struct Keys(Mutex<BTreeMap<String, Vec<u8>>>);
impl ProtectedKeystore for Keys {
    fn read(&self, name: String) -> Result<Option<Vec<u8>>, CryptoBridgeError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| CryptoBridgeError::Closed)?
            .get(&name)
            .cloned())
    }
    fn write(&self, name: String, value: Vec<u8>) -> Result<(), CryptoBridgeError> {
        let mut keys = self.0.lock().map_err(|_| CryptoBridgeError::Closed)?;
        if let Some(mut old) = keys.insert(name, value) {
            old.zeroize();
        }
        Ok(())
    }
}
impl Drop for Keys {
    fn drop(&mut self) {
        if let Ok(keys) = self.0.get_mut() {
            for value in keys.values_mut() {
                value.zeroize();
            }
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u8,
    keys: BTreeMap<String, Vec<u8>>,
    databases: Vec<rv_crypto::browser::Database>,
}
fn error(value: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&value.to_string())
}
#[wasm_bindgen]
pub struct Bridge {
    installation: Arc<CryptoInstallation>,
    keys: Arc<Keys>,
}
#[wasm_bindgen]
impl Bridge {
    #[wasm_bindgen(constructor)]
    pub fn new(account: &str) -> Result<Bridge, JsValue> {
        let keys = Arc::new(Keys::default());
        let installation = CryptoInstallation::open(
            "/crypto".into(),
            serde_json::from_str(account).map_err(error)?,
            keys.clone(),
        )
        .map_err(error)?;
        Ok(Self { installation, keys })
    }
    pub fn restore(&self, snapshot: &str) -> Result<(), JsValue> {
        let value: Snapshot = serde_json::from_str(snapshot).map_err(error)?;
        if value.version != 1
            || value.keys.len() > 16
            || value
                .keys
                .iter()
                .any(|(k, v)| !k.starts_with("native-crypto-") || k.len() > 128 || v.len() > 4096)
        {
            return Err(error("crypto_integrity_failed"));
        }
        rv_crypto::browser::restore(value.databases).map_err(error)?;
        let mut keys = self.keys.0.lock().map_err(error)?;
        for value in keys.values_mut() {
            value.zeroize();
        }
        *keys = value.keys;
        Ok(())
    }
    pub fn snapshot(&self) -> Result<String, JsValue> {
        serde_json::to_string(&Snapshot {
            version: 1,
            keys: self.keys.0.lock().map_err(error)?.clone(),
            databases: rv_crypto::browser::export().map_err(error)?,
        })
        .map_err(error)
    }
    pub fn invoke(&self, method: &str, args: &str) -> Result<String, JsValue> {
        let arguments: Vec<String> = serde_json::from_str(args).map_err(error)?;
        if arguments.len() > 8 || arguments.iter().any(|s| s.len() > 8 * 1024 * 1024) {
            return Err(error("crypto_integrity_failed"));
        }
        let arg = |i: usize| {
            arguments
                .get(i)
                .cloned()
                .ok_or_else(|| error("invalid_crypto_command"))
        };
        let c = &self.installation;
        let value: Value = match method {
            "status" => json!(c.status().map_err(error)?),
            "initialize" => json!(c.initialize(arg(0)?).map_err(error)?),
            "removed" => {
                c.retire(arg(0)?).map_err(error)?;
                Value::Null
            }
            "identityView" => json!(c.identity_view(arg(0)?).map_err(error)?),
            "identityBegin" => json!(c.identity_begin(arg(0)?, arg(1)?).map_err(error)?),
            "identityRenew" => json!(c.identity_renew(arg(0)?, arg(1)?).map_err(error)?),
            "identityPreview" => json!(c.identity_preview(arg(0)?, arg(1)?).map_err(error)?),
            "identityApprove" => json!(c.identity_approve(arg(0)?, arg(1)?).map_err(error)?),
            "identityInstall" => json!(c.identity_install(arg(0)?, arg(1)?).map_err(error)?),
            "identityPending" => json!(c.identity_pending(arg(0)?).map_err(error)?),
            "identityAcknowledge" => {
                json!(c.identity_acknowledge(arg(0)?, arg(1)?).map_err(error)?)
            }
            "peerView" => json!(c.peer_view(arg(0)?, arg(1)?, arg(2)?).map_err(error)?),
            "peerPin" => json!(
                c.peer_pin(arg(0)?, arg(1)?, arg(2)?, arg(3)?, arg(4)?, arg(5)?)
                    .map_err(error)?
            ),
            "peerPreview" => json!(
                c.peer_preview(arg(0)?, arg(1)?, arg(2)?, arg(3)?)
                    .map_err(error)?
            ),
            "peerApprove" => json!(c.peer_approve(arg(0)?, arg(1)?, arg(2)?).map_err(error)?),
            "groupAction" => json!(c.group_action(arg(0)?, arg(1)?).map_err(error)?),
            "conversationAction" => {
                let raw = c.conversation_action(arg(0)?, arg(1)?).map_err(error)?;
                let mut document: Value = serde_json::from_str(&raw).map_err(error)?;
                // Native markdown is parsed locally, without sending plaintext.
                fn parsed(value: &mut Value) {
                    if let Some(text) = value
                        .get("document")
                        .and_then(|d| d.get("text"))
                        .and_then(Value::as_str)
                    {
                        value["body"] = json!(rv_protocol::markdown::parse(text));
                    }
                }
                if let Some(rows) = document.get_mut("messages").and_then(Value::as_array_mut) {
                    for row in rows {
                        parsed(row);
                    }
                }
                if let Some(root) = document.get_mut("root") {
                    parsed(root);
                }
                json!(serde_json::to_string(&document).map_err(error)?)
            }
            "withdrawalAction" => json!(c.withdrawal_action(arg(0)?, arg(1)?).map_err(error)?),
            "recoveryAction" => json!(c.recovery_action(arg(0)?, arg(1)?).map_err(error)?),
            "historyAction" => json!(c.history_action(arg(0)?, arg(1)?).map_err(error)?),
            "historyBackupAction" => {
                json!(c.history_backup_action(arg(0)?, arg(1)?).map_err(error)?)
            }
            "storageAction" => json!(c.storage_action(arg(0)?, arg(1)?).map_err(error)?),
            _ => return Err(error("invalid_crypto_command")),
        };
        serde_json::to_string(&value).map_err(error)
    }
    pub fn close(&self) {
        self.installation.stop();
    }
}
#[wasm_bindgen]
pub struct SealedFile {
    metadata: String,
    object: Vec<u8>,
}
#[wasm_bindgen]
impl SealedFile {
    pub fn metadata(&self) -> String {
        self.metadata.clone()
    }
    pub fn object(&self) -> Vec<u8> {
        self.object.clone()
    }
}
#[wasm_bindgen]
pub fn seal_file(bytes: &mut [u8]) -> Result<SealedFile, JsValue> {
    let clear = Zeroizing::new(bytes.to_vec());
    bytes.fill(0);
    if rv_crypto::files::object_size(bytes.len() as u64) > rv_crypto::files::MAX_OBJECT {
        return Err(error("encrypted_file_too_large"));
    }
    let mut object = Vec::new();
    let sealed = rv_crypto::files::seal(clear.as_slice(), &mut object).map_err(error)?;
    let metadata=serde_json::to_string(&json!({"key":rv_crypto::files::encode_key(&sealed.key),"bytes":sealed.bytes.to_string(),"sha256":sealed.sha256_text(),"object_bytes":sealed.object_bytes.to_string(),"object_sha256":sealed.object_sha256_text()})).map_err(error)?;
    Ok(SealedFile { metadata, object })
}
#[wasm_bindgen]
pub fn open_file(
    key: &str,
    bytes: &str,
    sha256: &str,
    object: &[u8],
) -> Result<js_sys::Uint8Array, JsValue> {
    let key = rv_crypto::files::decode_key(key).map_err(error)?;
    let bytes = bytes.parse::<u64>().map_err(error)?;
    if rv_crypto::files::object_size(bytes) > rv_crypto::files::MAX_OBJECT
        || object.len() as u64 != rv_crypto::files::object_size(bytes)
    {
        return Err(error("crypto_integrity_failed"));
    }
    let hash = rv_crypto::files::decode_sha256(sha256).map_err(error)?;
    let mut clear = Zeroizing::new(Vec::new());
    rv_crypto::files::open(&key, bytes, &hash, object, &mut *clear).map_err(error)?;
    // Copy directly to JS; dropping the protected Vec wipes the WASM heap.
    Ok(js_sys::Uint8Array::from(clear.as_slice()))
}
