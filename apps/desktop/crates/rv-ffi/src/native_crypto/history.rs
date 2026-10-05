//! History recovery between devices of the account. Public fingerprints, device
//! names, room ids and counts cross UniFFI; offers and the approved preview
//! stay on this view, bound to a revision.
use super::*;
use enrollment::history::{HistoryApproval, HistoryOffer, ImportProgress};
use serde::Deserialize;
pub(super) enum Staged {
    Offers(Vec<HistoryOffer>),
    Preview(Box<HistoryApproval>),
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Request {},
    Import {},
    Offers {},
    Preview { id: String, fingerprint: String },
    Share { id: String },
    Resume {},
}
fn changed() -> Error {
    rv_core::native::Error::Protocol("crypto_enrollment_changed").into()
}
fn stage(inner: &Inner, staged: Staged) -> u64 {
    let revision = {
        let mut state = inner.state.lock().unwrap();
        state.0 += 1;
        state.1 = None;
        state.0
    };
    *inner.history.lock().unwrap() = Some((revision, staged));
    revision
}
fn take(inner: &Inner, id: &str) -> Result<Staged, Error> {
    let (revision, staged) = inner.history.lock().unwrap().take().ok_or_else(changed)?;
    if revision.to_string() != id || inner.state.lock().unwrap().0 != revision {
        return Err(changed());
    }
    Ok(staged)
}
#[uniffi::export]
impl NativeCrypto {
    pub async fn history_action(&self, input: String) -> Result<String, RvError> {
        if input.len() > 4096 {
            return Err(error(changed()));
        }
        let action: Action = serde_json::from_str(&input).map_err(|_| error(changed()))?;
        let inner = self.inner.clone();
        on_tokio(async move {
            let _serial = inner.serial.lock().await;
            inner.access.check()?;
            let output = match action {
                Action::Request {} => {
                    inner.history.lock().unwrap().take();
                    serde_json::json!({"fingerprint": inner.access.request_history().await?})
                }
                Action::Import {} => match inner.access.import_history().await? {
                    ImportProgress::Idle => serde_json::json!({"state": "idle"}),
                    ImportProgress::Waiting { request } => serde_json::json!({"state": "waiting", "request": request}),
                    ImportProgress::Done { request } => serde_json::json!({"state": "done", "request": request}),
                },
                Action::Offers {} => {
                    inner.history.lock().unwrap().take();
                    let offers = inner.access.history_offers().await?;
                    let list: Vec<_> = offers
                        .iter()
                        .map(|o| {
                            serde_json::json!({"fingerprint": o.fingerprint, "device": o.device, "expires_at": o.expires_at.to_string()})
                        })
                        .collect();
                    let id = stage(&inner, Staged::Offers(offers));
                    serde_json::json!({"id": id.to_string(), "offers": list})
                }
                Action::Preview { id, fingerprint } => {
                    let Staged::Offers(offers) = take(&inner, &id)? else { return Err(changed()) };
                    let offer = offers.into_iter().find(|o| o.fingerprint == fingerprint).ok_or_else(changed)?;
                    let preview = inner.access.preview_history(offer).await?;
                    let periods: Vec<_> = preview
                        .periods
                        .iter()
                        .map(|p| serde_json::json!({"room": p.room, "documents": p.documents.to_string()}))
                        .collect();
                    let output = serde_json::json!({
                        "fingerprint": preview.fingerprint,
                        "device": preview.device,
                        "periods": periods,
                    });
                    let id = stage(&inner, Staged::Preview(Box::new(preview)));
                    let mut output = output;
                    output["id"] = serde_json::json!(id.to_string());
                    output
                }
                Action::Share { id } => {
                    let Staged::Preview(preview) = take(&inner, &id)? else { return Err(changed()) };
                    inner.access.share_history(*preview).await?;
                    serde_json::json!({"shared": true})
                }
                Action::Resume {} => serde_json::json!({"resumed": inner.access.resume_history_share().await?}),
            };
            inner.access.check()?;
            serde_json::to_string(&output).map_err(|_| changed())
        })
        .await
        .map_err(error)
    }
}
