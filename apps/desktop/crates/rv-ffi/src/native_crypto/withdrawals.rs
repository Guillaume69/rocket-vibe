use super::*;
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    View {},
    Preview { device: String, fingerprint: String },
    Confirm { id: String },
    Resume {},
}
fn changed() -> Error {
    rv_core::native::Error::Protocol("crypto_enrollment_changed").into()
}
#[uniffi::export]
impl NativeCrypto {
    pub async fn withdrawal_action(&self, input: String) -> Result<String, RvError> {
        if input.len() > 32768 {
            return Err(error(changed()));
        }
        let action: Action = serde_json::from_str(&input).map_err(|_| error(changed()))?;
        let inner = self.inner.clone();
        on_tokio(async move {
            let _serial = inner.serial.lock().await;
            inner.access.check()?;
            let output = match action {
                Action::View {} => {
                    inner.withdrawal.lock().unwrap().take();
                    serde_json::to_value(inner.access.withdrawals().await?)
                }
                Action::Preview { device, fingerprint } => {
                    inner.recovery.lock().unwrap().take();
                    inner.withdrawal.lock().unwrap().take();
                    let preview = inner.access.preview_withdrawal(device, fingerprint).await?;
                    let revision = { let mut state = inner.state.lock().unwrap(); state.0 += 1; state.1 = None; state.0 };
                    let output = serde_json::json!({"id":revision.to_string(),"device":preview.device,"incarnation":preview.incarnation,
                        "fingerprint":preview.fingerprint,"root_fingerprint":preview.root_fingerprint,"expires_at":preview.expires_at});
                    *inner.withdrawal.lock().unwrap() = Some((revision, preview));
                    Ok(output)
                }
                Action::Confirm { id } => {
                    let (revision, preview) = inner.withdrawal.lock().unwrap().take().ok_or_else(changed)?;
                    if revision.to_string() != id || inner.state.lock().unwrap().0 != revision { return Err(changed()); }
                    serde_json::to_value(inner.access.withdraw_device(preview).await?)
                }
                Action::Resume {} => serde_json::to_value(inner.access.resume_withdrawal().await?),
            }.map_err(|_| changed())?;
            inner.access.check()?;
            serde_json::to_string(&output).map_err(|_| changed())
        }).await.map_err(error)
    }
}
