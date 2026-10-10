//! History recovery for a new device (E2EE_HISTORY.md, path A). The adapter
//! carries HTTP and the human approval; requests, shares and record pages cross
//! as public wire values, period secrets and documents never leave Rust.
use super::*;
use rv_crypto::account::{
    self,
    history::{ImportStatus, Offer, SharePreview, Upload},
};
use rv_protocol::e2ee;
use serde::Deserialize;
use serde_json::{Value, json};

/// Opaque objects between two calls, bound to a random id and this handle.
#[derive(Default)]
pub(super) struct Staged {
    offers: Option<(String, Vec<Offer>)>,
    preview: Option<(String, SharePreview)>,
    upload: Option<Upload>,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    /// New device: its request (created once, replayed) to publish.
    Request {},
    /// What this device is doing: its pending request, an unfinished share,
    /// an open import.
    View {},
    ClearPreview {},
    Offers {
        listed: e2ee::HistoryRequests,
    },
    Preview {
        id: String,
        fingerprint: String,
    },
    Approve {
        id: String,
        /// Also hand control of the account over (E2EE_DELEGATION.md).
        #[serde(default)]
        delegate: bool,
    },
    Upload {},
    Uploaded {
        receipt: e2ee::HistoryRecordsReceipt,
    },
    Commit {},
    Committed {
        state: e2ee::HistoryShareState,
    },
    Abandon {},
    ImportBegin {
        state: e2ee::HistoryShareState,
    },
    ImportPage {
        page: e2ee::HistoryRecordsPage,
    },
    Acknowledgeable {
        listed: e2ee::HistoryRequests,
    },
}
fn status(value: Option<ImportStatus>) -> Value {
    value.map_or(Value::Null, |s| {
        json!({
            "request": s.request,
            "next": s.next.map(|(period, after)| json!({"period": period, "after": after.to_string()})),
        })
    })
}
fn changed() -> account::Error {
    account::Error::Changed
}
#[cfg_attr(feature = "native-bindings", uniffi::export)]
impl CryptoInstallation {
    pub fn history_action(&self, directory: String, input: String) -> Result<String> {
        // Record pages are the largest input: 200 records under 4 MiB.
        if input.len() > 8 * 1024 * 1024 {
            return Err(CryptoBridgeError::Integrity);
        }
        let action: Action =
            serde_json::from_str(&input).map_err(|_| CryptoBridgeError::Integrity)?;
        self.identity_call(&directory, |c, d, time| {
            let mut staged = self.history_staged.lock().map_err(|_| changed())?;
            let output = match action {
                Action::Request {} => {
                    let (fingerprint, input) = c.history_request(d, time)?;
                    json!({"fingerprint": fingerprint, "input": input})
                }
                Action::View {} => json!({
                    "pending": c.history_pending(d, time)?,
                    "sharing": c.history_share_pending(d, time)?,
                    "importing": status(c.history_import_status(d, time)?),
                }),
                Action::ClearPreview {} => {
                    *staged = Staged::default();
                    json!({"cleared": true})
                }
                Action::Offers { listed } => {
                    let offers = c.history_offers(d, &listed, time)?;
                    let id = nonce()?;
                    let list: Vec<Value> = offers
                        .iter()
                        .map(|o| {
                            json!({
                                "fingerprint": o.fingerprint,
                                "device": o.device,
                                "issued_at": o.issued_at.to_string(),
                                "expires_at": o.expires_at.to_string(),
                            })
                        })
                        .collect();
                    staged.offers = Some((id.clone(), offers));
                    staged.preview = None;
                    json!({"id": id, "offers": list})
                }
                Action::Preview { id, fingerprint } => {
                    let (expected, offers) = staged.offers.take().ok_or_else(changed)?;
                    if id != expected {
                        return Err(changed());
                    }
                    let offer = offers
                        .into_iter()
                        .find(|o| o.fingerprint == fingerprint)
                        .ok_or_else(changed)?;
                    let preview = c.history_preview(d, offer, time)?;
                    let id = nonce()?;
                    let periods: Vec<Value> = preview
                        .periods
                        .iter()
                        .map(|p| json!({"room": p.room, "documents": p.documents.to_string()}))
                        .collect();
                    let output = json!({
                        "id": id,
                        "fingerprint": preview.fingerprint,
                        "device": preview.device,
                        "periods": periods,
                        "can_delegate": preview.can_delegate,
                    });
                    staged.preview = Some((id, preview));
                    output
                }
                Action::Approve { id, delegate } => {
                    let (expected, preview) = staged.preview.take().ok_or_else(changed)?;
                    if id != expected {
                        return Err(changed());
                    }
                    c.history_approve(d, preview, delegate, time)?;
                    json!({"approved": true})
                }
                Action::Upload {} => match c.history_upload(d, time)? {
                    Some(upload) => {
                        let output = json!({"request": upload.request, "input": upload.input});
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
                    c.history_uploaded(d, upload, &receipt, time)?;
                    json!({"recorded": true})
                }
                Action::Commit {} => {
                    let commit = c.history_commit(d, time)?;
                    json!({"request": commit.request, "input": commit.input})
                }
                Action::Committed { state } => {
                    c.history_committed(d, &state, time)?;
                    json!({"committed": true})
                }
                Action::Abandon {} => {
                    staged.upload = None;
                    c.history_share_abandon(d, time)?;
                    json!({"abandoned": true})
                }
                Action::ImportBegin { state } => {
                    status(Some(c.history_import_begin(d, &state, time)?))
                }
                Action::ImportPage { page } => status(Some(c.history_import_page(d, &page, time)?)),
                Action::Acknowledgeable { listed } => {
                    json!({"requests": c.history_acknowledgeable(d, &listed, time)?})
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
