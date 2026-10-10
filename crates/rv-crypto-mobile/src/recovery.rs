//! Recovery codes cross only the explicit code view/input. Root/leaf keys,
//! protected records and opaque approval objects remain inside Rust.
use super::*;
use rv_crypto::account::{
    self,
    recovery::{BackupPreview, RestorePreview},
};
use rv_protocol::e2ee;
use serde::Deserialize;
use zeroize::Zeroize;
#[derive(Deserialize)]
#[serde(transparent)]
struct EnteredCode(String);
impl Drop for EnteredCode {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
pub(super) enum Staged {
    Backup(Box<BackupPreview>),
    Restore(Box<RestorePreview>),
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    View {},
    ClearPreview {},
    PreviewBackup {
        remote: e2ee::RootBackupState,
    },
    PrepareBackup {
        id: String,
    },
    Code {},
    ConfirmSaved {},
    Pending {},
    RequestCancel {},
    PendingCancel {},
    Acknowledge {
        receipt: e2ee::RootBackupReceipt,
    },
    SettleCancel {
        result: e2ee::RootBackupSettlement,
    },
    PreviewRestore {
        remote: e2ee::RootBackupState,
        code: EnteredCode,
        fingerprint: String,
    },
    Restore {
        id: String,
    },
}
fn status(
    c: &account::Coordinator<'_>,
    d: &account::Directory,
) -> std::result::Result<String, account::Error> {
    serde_json::to_string(&c.backup_status(d)?).map_err(|_| account::Error::Changed)
}
#[cfg_attr(feature = "native-bindings", uniffi::export)]
impl CryptoInstallation {
    pub fn recovery_action(&self, directory: String, input: String) -> Result<String> {
        let input = Zeroizing::new(input);
        if input.len() > 128 * 1024 {
            return Err(CryptoBridgeError::Integrity);
        }
        let action: Action =
            serde_json::from_str(&input).map_err(|_| CryptoBridgeError::Integrity)?;
        self.identity_call(&directory,|c,d,time| {
            let view=c.view(d,time)?;
            match action {
                Action::View{}=>{
                    status(c,d)
                }
                Action::ClearPreview{}=>{self.recovery_preview.lock().map_err(|_|account::Error::Changed)?.take();Ok("{\"cleared\":true}".into())}
                Action::PreviewBackup{remote}=>{
                    let preview=c.preview_backup(d,remote)?;
                    let id=nonce()?;
                    let output=serde_json::json!({"id":id,"root_fingerprint":preview.root_fingerprint,"backup_revision":preview.backup_revision}).to_string();
                    *self.recovery_preview.lock().map_err(|_|account::Error::Changed)?=Some((id,Staged::Backup(Box::new(preview))));
                    Ok(output)
                }
                Action::PrepareBackup{id}=>{
                    let (expected,staged)=self.recovery_preview.lock().map_err(|_|account::Error::Changed)?.take().ok_or(account::Error::Changed)?;
                    if id!=expected {return Err(account::Error::Changed);}
                    let Staged::Backup(preview)=staged else {return Err(account::Error::Changed);};
                    c.prepare_backup(d,*preview,time)?;
                    status(c,d)
                }
                Action::Code{}=>{
                    c.backup_status(d)?;
                    let code=c.backup_code()?;
                    // The adapter clears this temporary text on blur/account
                    // change. It is never part of status, HTTP or logging.
                    Ok(serde_json::json!({"code":code.as_str()}).to_string())
                }
                Action::ConfirmSaved{}=>{c.backup_status(d)?;c.confirm_backup_code()?;status(c,d)}
                Action::Pending{}=>{c.backup_status(d)?;serde_json::to_string(&c.pending_backup()?).map_err(|_|account::Error::Changed)}
                Action::RequestCancel{}=>{c.backup_status(d)?;serde_json::to_string(&c.request_backup_cancellation()?).map_err(|_|account::Error::Changed)}
                Action::PendingCancel{}=>{c.backup_status(d)?;serde_json::to_string(&c.pending_backup_cancellation()?).map_err(|_|account::Error::Changed)}
                Action::Acknowledge{receipt}=>{c.backup_status(d)?;c.acknowledge_backup(&c.pending_backup()?,receipt)?;status(c,d)}
                Action::SettleCancel{result}=>{c.backup_status(d)?;c.settle_backup_cancellation(&c.pending_backup_cancellation()?,result)?;status(c,d)}
                Action::PreviewRestore{remote,code,fingerprint}=>{
                    if view.stage!=account::Stage::Missing || fingerprint!=view.remote_fingerprint || fingerprint.is_empty() {return Err(account::Error::Changed);}
                    let preview=c.preview_restore(&remote,&code.0,&fingerprint)?;
                    let id=nonce()?;
                    let output=serde_json::json!({"id":id,"root_fingerprint":preview.root_fingerprint,"backup_id":preview.backup_id}).to_string();
                    *self.recovery_preview.lock().map_err(|_|account::Error::Changed)?=Some((id,Staged::Restore(Box::new(preview))));
                    Ok(output)
                }
                Action::Restore{id}=>{
                    let (expected,staged)=self.recovery_preview.lock().map_err(|_|account::Error::Changed)?.take().ok_or(account::Error::Changed)?;
                    if id!=expected {return Err(account::Error::Changed);}
                    let Staged::Restore(preview)=staged else {return Err(account::Error::Changed);};
                    if view.stage!=account::Stage::Missing || view.remote_fingerprint!=preview.root_fingerprint {return Err(account::Error::Changed);}
                    c.restore_root(*preview,time)?;
                    Ok("{\"restored\":true}".into())
                }
            }
        })
    }
}
fn nonce() -> std::result::Result<String, account::Error> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| account::Error::Changed)?;
    Ok(data_encoding::HEXLOWER.encode(&bytes))
}
#[cfg(test)]
mod tests;
