//! Destruction of old keys (E2EE_STORAGE.md): when the storage key was last
//! renewed, renewing it now, or when due. No key crosses this API.
use super::*;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    View {},
    Renew {},
    RenewIfDue {},
}
#[uniffi::export]
impl CryptoInstallation {
    pub fn storage_action(&self, directory: String, input: String) -> Result<String> {
        if input.len() > 256 {
            return Err(CryptoBridgeError::Integrity);
        }
        let action: Action =
            serde_json::from_str(&input).map_err(|_| CryptoBridgeError::Integrity)?;
        self.identity_call(&directory, |c, _, time| {
            let renewed = match action {
                Action::View {} => false,
                Action::Renew {} => {
                    c.renew_storage(time)?;
                    true
                }
                Action::RenewIfDue {} => c.renew_storage_if_due(time)?,
            };
            let status = c.storage_status()?;
            Ok(
                json!({"rotated_at":status.rotated_at.map(|t| t.to_string()),
                "due_at":status.due_at.map(|t| t.to_string()),"renewed":renewed})
                .to_string(),
            )
        })
    }
}
