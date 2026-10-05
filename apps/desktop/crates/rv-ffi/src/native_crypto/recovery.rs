//! Explicit code display/input only; opaque confirmations remain on this view.
use super::*;
use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};
pub(super) enum Staged {
    Backup(Box<enrollment::recovery::BackupApproval>),
    Restore(Box<enrollment::recovery::RestoreApproval>),
}
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
    PreviewBackup {},
    PrepareBackup { id: String },
    Code {},
    ConfirmSaved {},
    Resume {},
    Cancel {},
    PreviewRestore { code: EnteredCode, fingerprint: String },
    Restore { id: String },
}
fn changed() -> Error {
    rv_core::native::Error::Protocol("crypto_enrollment_changed").into()
}
#[uniffi::export]
impl NativeCrypto {
    pub async fn recovery_action(&self, input: String) -> Result<String, RvError> {
        let input = Zeroizing::new(input);
        if input.len() > 32768 {
            return Err(error(changed()));
        }
        let action: Action = serde_json::from_str(&input).map_err(|_| error(changed()))?;
        let inner = self.inner.clone();
        on_tokio(async move{
            let _serial=inner.serial.lock().await;inner.access.check()?;
            let output=match action {
                Action::View{}=>{inner.recovery.lock().unwrap().take();serde_json::to_value(inner.access.backup_status().await?)},
                Action::PreviewBackup{}=>{
                    inner.recovery.lock().unwrap().take();let preview=inner.access.preview_backup().await?;
                    let revision={let mut state=inner.state.lock().unwrap();state.0+=1;state.1=None;state.0};
                    let output=serde_json::json!({"id":revision.to_string(),"root_fingerprint":preview.root_fingerprint,"backup_revision":preview.backup_revision});
                    *inner.recovery.lock().unwrap()=Some((revision,Staged::Backup(Box::new(preview))));Ok(output)
                },
                Action::PrepareBackup{id}=>{
                    let (revision,staged)=inner.recovery.lock().unwrap().take().ok_or_else(changed)?;
                    if revision.to_string()!=id || inner.state.lock().unwrap().0!=revision {return Err(changed());}
                    let Staged::Backup(preview)=staged else{return Err(changed());};
                    serde_json::to_value(inner.access.prepare_backup(*preview).await?)
                },
                Action::Code{}=>{
                    let code=inner.access.backup_code().await?;
                    Ok(serde_json::json!({"code":code.as_str()}))
                },
                Action::ConfirmSaved{}=>serde_json::to_value(inner.access.confirm_backup_code().await?),
                Action::Resume{}=>serde_json::to_value(inner.access.resume_backup().await?),
                Action::Cancel{}=>serde_json::to_value(inner.access.cancel_backup().await?),
                Action::PreviewRestore{code,fingerprint}=>{
                    inner.recovery.lock().unwrap().take();
                    let preview=inner.access.preview_restore(Zeroizing::new(code.0.clone()),fingerprint).await?;
                    let revision={let mut state=inner.state.lock().unwrap();state.0+=1;state.1=None;state.0};
                    let output=serde_json::json!({"id":revision.to_string(),"root_fingerprint":preview.root_fingerprint,"backup_id":preview.backup_id});
                    *inner.recovery.lock().unwrap()=Some((revision,Staged::Restore(Box::new(preview))));Ok(output)
                },
                Action::Restore{id}=>{
                    let (revision,staged)=inner.recovery.lock().unwrap().take().ok_or_else(changed)?;
                    if revision.to_string()!=id || inner.state.lock().unwrap().0!=revision {return Err(changed());}
                    let Staged::Restore(preview)=staged else{return Err(changed());};
                    inner.access.restore_root(*preview).await?;
                    let mut state=inner.state.lock().unwrap();state.0+=1;state.1=None;
                    Ok(serde_json::json!({"restored":true}))
                },
            }.map_err(|_|changed())?;
            inner.access.check()?;
            serde_json::to_string(&output).map_err(|_|changed())
        }).await.map_err(error)
    }
}
