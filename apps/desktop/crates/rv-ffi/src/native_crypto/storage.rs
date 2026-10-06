//! Destruction of old keys (E2EE_STORAGE.md): when the storage key was last
//! renewed, and renewing it now. No key crosses this API.
use super::*;
use serde::Deserialize;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    View {},
    Renew {},
}
fn changed() -> Error {
    rv_core::native::Error::Protocol("crypto_enrollment_changed").into()
}
#[uniffi::export]
impl NativeCrypto {
    pub async fn storage_action(&self, input: String) -> Result<String, RvError> {
        let input = Zeroizing::new(input);
        if input.len() > 256 {
            return Err(error(changed()));
        }
        let action: Action = serde_json::from_str(&input).map_err(|_| error(changed()))?;
        let inner = self.inner.clone();
        on_tokio(async move {
            let _serial = inner.serial.lock().await;
            inner.access.check()?;
            let status = match action {
                Action::View {} => inner.access.storage_status().await?,
                Action::Renew {} => inner.access.renew_storage().await?,
            };
            inner.access.check()?;
            Ok::<_, Error>(
                serde_json::json!({
                    "rotated_at": status.rotated_at.map(|t| t.to_string()),
                    "due_at": status.due_at.map(|t| t.to_string()),
                })
                .to_string(),
            )
        })
        .await
        .map_err(error)
    }
}
