//! History backup (path B). The history code crosses only the explicit code
//! view and the join input; the reviewed generation stays on this view.
use super::*;
use enrollment::history_backup::HistoryBackupApproval;
use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};
#[derive(Deserialize)]
#[serde(transparent)]
struct EnteredCode(String);
impl Drop for EnteredCode {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    View {},
    Preview {},
    Prepare { id: String },
    Code {},
    ConfirmSaved {},
    Resume {},
    Cancel {},
    Join { code: EnteredCode },
    Sync {},
    Restore {},
}
fn changed() -> Error {
    rv_core::native::Error::Protocol("crypto_enrollment_changed").into()
}
#[uniffi::export]
impl NativeCrypto {
    pub async fn history_backup_action(&self, input: String) -> Result<String, RvError> {
        let input = Zeroizing::new(input);
        if input.len() > 4096 {
            return Err(error(changed()));
        }
        let action: Action = serde_json::from_str(&input).map_err(|_| error(changed()))?;
        let inner = self.inner.clone();
        on_tokio(async move {
            let _serial = inner.serial.lock().await;
            inner.access.check()?;
            let output = match action {
                Action::View {} => serde_json::to_value(inner.access.history_backup_status().await?),
                Action::Preview {} => {
                    let preview: HistoryBackupApproval = inner.access.preview_history_backup().await?;
                    let revision = {
                        let mut state = inner.state.lock().unwrap();
                        state.0 += 1;
                        state.1 = None;
                        state.0
                    };
                    let output = serde_json::json!({"id": revision.to_string(), "generation_revision": preview.generation_revision});
                    *inner.history_backup.lock().unwrap() = Some((revision, preview));
                    Ok(output)
                }
                Action::Prepare { id } => {
                    let (revision, preview) = inner.history_backup.lock().unwrap().take().ok_or_else(changed)?;
                    if revision.to_string() != id || inner.state.lock().unwrap().0 != revision {
                        return Err(changed());
                    }
                    serde_json::to_value(inner.access.prepare_history_backup(preview).await?)
                }
                Action::Code {} => {
                    let code = inner.access.history_backup_code().await?;
                    Ok(serde_json::json!({"code": code.as_str()}))
                }
                Action::ConfirmSaved {} => serde_json::to_value(inner.access.confirm_history_backup_code().await?),
                Action::Resume {} => serde_json::to_value(inner.access.resume_history_backup().await?),
                Action::Cancel {} => serde_json::to_value(inner.access.cancel_history_backup().await?),
                Action::Join { code } => {
                    serde_json::to_value(inner.access.join_history_backup(Zeroizing::new(code.0.clone())).await?)
                }
                Action::Sync {} => Ok(serde_json::json!({"pages": inner.access.sync_history_backup().await?.to_string()})),
                Action::Restore {} => {
                    Ok(serde_json::json!({"records": inner.access.restore_history_backup().await?.to_string()}))
                }
            }
            .map_err(|_| changed())?;
            inner.access.check()?;
            serde_json::to_string(&output).map_err(|_| changed())
        })
        .await
        .map_err(error)
    }
}
