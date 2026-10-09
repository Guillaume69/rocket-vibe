//! History backup (E2EE_HISTORY_BACKUP.md, path B). The history code crosses
//! only the explicit code view and the join input; the key, the period secrets
//! and the documents stay in Rust. Uploads and pages cross as public wire values.
use super::*;
use rv_crypto::account::{
    self,
    history_backup::{BackupUpload, HistoryBackupPreview},
};
use rv_protocol::e2ee;
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroize;

#[derive(Deserialize)]
#[serde(transparent)]
struct EnteredCode(String);
impl Drop for EnteredCode {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
#[derive(Default)]
pub(super) struct Staged {
    preview: Option<(String, HistoryBackupPreview)>,
    upload: Option<BackupUpload>,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    View {},
    ClearPreview {},
    Preview {
        remote: e2ee::HistoryKeyState,
    },
    Prepare {
        id: String,
    },
    Code {},
    ConfirmSaved {},
    Pending {},
    RequestCancel {},
    PendingCancel {},
    Acknowledge {
        receipt: e2ee::HistoryKeyReceipt,
    },
    SettleCancel {
        result: e2ee::HistoryKeySettlement,
    },
    Join {
        remote: e2ee::HistoryKeyState,
        code: EnteredCode,
    },
    Upload {
        remote: e2ee::HistoryKeyState,
    },
    Uploaded {
        receipt: e2ee::HistoryBackupReceipt,
    },
    Next {
        listed: e2ee::HistoryBackupPeriod,
    },
    Import {
        listed: e2ee::HistoryBackupPeriod,
        page: e2ee::HistoryBackupPage,
    },
}
fn changed() -> account::Error {
    account::Error::Changed
}
fn after(value: Option<u64>) -> Value {
    json!({"after": value.map(|v| v.to_string())})
}
#[cfg_attr(feature = "native-bindings", uniffi::export)]
impl CryptoInstallation {
    pub fn history_backup_action(&self, directory: String, input: String) -> Result<String> {
        let input = Zeroizing::new(input);
        // A downloaded page is the largest input: 200 records under 4 MiB.
        if input.len() > 8 * 1024 * 1024 {
            return Err(CryptoBridgeError::Integrity);
        }
        let action: Action =
            serde_json::from_str(&input).map_err(|_| CryptoBridgeError::Integrity)?;
        self.identity_call(&directory, |c, d, time| {
            let mut staged = self.history_backup_staged.lock().map_err(|_| changed())?;
            let status = |c: &account::Coordinator<'_>| {
                serde_json::to_value(c.history_backup_status(d)?).map_err(|_| changed())
            };
            let output = match action {
                Action::View {} => status(c)?,
                Action::ClearPreview {} => {
                    *staged = Staged::default();
                    json!({"cleared": true})
                }
                Action::Preview { remote } => {
                    let preview = c.preview_history_backup(d, remote)?;
                    let id = nonce()?;
                    let output =
                        json!({"id": id, "generation_revision": preview.generation_revision});
                    staged.preview = Some((id, preview));
                    output
                }
                Action::Prepare { id } => {
                    let (expected, preview) = staged.preview.take().ok_or_else(changed)?;
                    if id != expected {
                        return Err(changed());
                    }
                    c.prepare_history_backup(d, preview, time)?;
                    status(c)?
                }
                Action::Code {} => {
                    c.history_backup_status(d)?;
                    let code = c.history_backup_code()?;
                    // The adapter clears this text on blur or account change.
                    json!({"code": code.as_str()})
                }
                Action::ConfirmSaved {} => {
                    c.history_backup_status(d)?;
                    c.confirm_history_backup_code()?;
                    status(c)?
                }
                Action::Pending {} => {
                    c.history_backup_status(d)?;
                    serde_json::to_value(c.pending_history_backup()?).map_err(|_| changed())?
                }
                Action::RequestCancel {} => {
                    c.history_backup_status(d)?;
                    serde_json::to_value(c.request_history_backup_cancellation()?)
                        .map_err(|_| changed())?
                }
                Action::PendingCancel {} => {
                    c.history_backup_status(d)?;
                    serde_json::to_value(c.pending_history_backup_cancellation()?)
                        .map_err(|_| changed())?
                }
                Action::Acknowledge { receipt } => {
                    c.history_backup_status(d)?;
                    c.acknowledge_history_backup(&c.pending_history_backup()?, receipt)?;
                    status(c)?
                }
                Action::SettleCancel { result } => {
                    c.history_backup_status(d)?;
                    c.settle_history_backup_cancellation(
                        &c.pending_history_backup_cancellation()?,
                        result,
                    )?;
                    status(c)?
                }
                Action::Join { remote, code } => {
                    c.join_history_backup(d, &remote, &code.0)?;
                    status(c)?
                }
                Action::Upload { remote } => match c.history_backup_upload(d, &remote, time)? {
                    Some(upload) => {
                        let output = json!({"period": upload.period, "input": upload.input});
                        staged.upload = Some(upload);
                        json!({"upload": output})
                    }
                    None => {
                        staged.upload = None;
                        json!({"upload": null})
                    }
                },
                Action::Uploaded { receipt } => {
                    let upload = staged.upload.take().ok_or_else(changed)?;
                    c.history_backup_uploaded(d, upload, &receipt, time)?;
                    json!({"recorded": true})
                }
                Action::Next { listed } => after(c.history_backup_next(d, &listed, time)?),
                Action::Import { listed, page } => {
                    after(c.history_backup_import(d, &listed, &page, time)?)
                }
            };
            serde_json::to_string(&output).map_err(|_| changed())
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
