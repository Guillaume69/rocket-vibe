//! History recovery between devices of the account (E2EE_HISTORY.md, path A),
//! through the existing desktop session and viewer. The new device asks and
//! imports; another device previews, approves and uploads. Shared protected
//! steps live in `rv_crypto::account::history`, also used by Android.
use super::*;
pub use rv_crypto::account::history::{ImportStatus, PreviewPeriod};
use rv_crypto::account::history::{Offer, SharePreview};

/// A request of another device of the account, verified against the directory.
pub struct HistoryOffer {
    pub fingerprint: String,
    pub device: String,
    pub expires_at: u64,
    context: Arc<Context>,
    inner: Offer,
}
/// What the human approves: this request fingerprint, these room periods.
pub struct HistoryApproval {
    pub fingerprint: String,
    pub device: String,
    pub periods: Vec<PreviewPeriod>,
    context: Arc<Context>,
    inner: SharePreview,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportProgress {
    /// No request is pending on this device.
    Idle,
    /// The request is published; no device has committed a share yet.
    Waiting { request: String },
    /// Every page is imported and the server copy acknowledged.
    Done { request: String },
}
fn status_code(error: &rv_client::Error) -> Option<(u16, &str)> {
    match error {
        rv_client::Error::Server { status, code, .. } => Some((*status, code.as_str())),
        _ => None,
    }
}
fn native(error: rv_client::Error) -> Error {
    crate::native::Error::from(error).into()
}
impl Access {
    fn session(&self) -> Result<Arc<NativeSession>> {
        self.check()?;
        self.0.context.session.upgrade().ok_or_else(changed)
    }
    /// New device: publishes its history request (created once, replayed
    /// until it expires) and returns its fingerprint, shown to the human.
    pub async fn request_history(&self) -> Result<String> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let (fingerprint, input) = self
            .owned(move |slot, time| {
                let c = Coordinator::new(slot);
                Ok(c.history_request(&c.directory(wire)?, time)?)
            })
            .await?;
        let entry = self.session()?.client.publish_crypto_history_request(&input).await.map_err(native)?;
        if entry.fingerprint != fingerprint {
            return Err(changed());
        }
        Ok(fingerprint)
    }
    /// Sharing device: requests of other devices of the account it may answer.
    pub async fn history_offers(&self) -> Result<Vec<HistoryOffer>> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let listed = self.session()?.client.crypto_history_requests().await.map_err(native)?;
        let context = self.0.context.clone();
        self.owned(move |slot, time| {
            let c = Coordinator::new(slot);
            Ok(c.history_offers(&c.directory(wire)?, &listed, time)?
                .into_iter()
                .map(|inner| HistoryOffer {
                    fingerprint: inner.fingerprint.clone(),
                    device: inner.device.clone(),
                    expires_at: inner.expires_at,
                    context: context.clone(),
                    inner,
                })
                .collect())
        })
        .await
    }
    /// Sharing device: the room periods it would share. Nothing is sent.
    pub async fn preview_history(&self, offer: HistoryOffer) -> Result<HistoryApproval> {
        let _dispatch = self.0.dispatch.lock().await;
        if !Arc::ptr_eq(&offer.context, &self.0.context)
            || offer.fingerprint != offer.inner.fingerprint
            || offer.device != offer.inner.device
        {
            return Err(changed());
        }
        let wire = self.observe().await?;
        let context = self.0.context.clone();
        self.owned(move |slot, time| {
            let c = Coordinator::new(slot);
            let inner = c.history_preview(&c.directory(wire)?, offer.inner, time)?;
            Ok(HistoryApproval {
                fingerprint: inner.fingerprint.clone(),
                device: inner.device.clone(),
                periods: inner
                    .periods
                    .iter()
                    .map(|p| PreviewPeriod { room: p.room.clone(), documents: p.documents })
                    .collect(),
                context,
                inner,
            })
        })
        .await
    }
    /// Sharing device: the human approved; the share is sealed, uploaded page
    /// by page and committed. Interrupted, it resumes with `resume_history_share`.
    pub async fn share_history(&self, approval: HistoryApproval) -> Result<()> {
        let _dispatch = self.0.dispatch.lock().await;
        if !Arc::ptr_eq(&approval.context, &self.0.context)
            || approval.fingerprint != approval.inner.fingerprint
            || approval.device != approval.inner.device
        {
            return Err(changed());
        }
        let wire = self.observe().await?;
        self.owned(move |slot, time| {
            let c = Coordinator::new(slot);
            c.history_approve(&c.directory(wire)?, approval.inner, time)?;
            Ok(())
        })
        .await?;
        self.run_history_share().await
    }
    /// Sharing device: continues an unfinished share; false when none is open.
    pub async fn resume_history_share(&self) -> Result<bool> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let pending = self
            .owned(move |slot, time| {
                let c = Coordinator::new(slot);
                Ok(c.history_share_pending(&c.directory(wire)?, time)?)
            })
            .await?;
        if pending.is_none() {
            return Ok(false);
        }
        self.run_history_share().await?;
        Ok(true)
    }
    async fn abandon_history_share(&self) -> Result<()> {
        let wire = self.observe().await?;
        self.owned(move |slot, time| {
            let c = Coordinator::new(slot);
            Ok(c.history_share_abandon(&c.directory(wire)?, time)?)
        })
        .await
    }
    async fn run_history_share(&self) -> Result<()> {
        let session = self.session()?;
        loop {
            let wire = self.observe().await?;
            let upload = self
                .owned(move |slot, time| {
                    let c = Coordinator::new(slot);
                    Ok(c.history_upload(&c.directory(wire)?, time)?)
                })
                .await?;
            let Some(upload) = upload else { break };
            let receipt = match session.client.upload_crypto_history_records(&upload.request, &upload.input).await {
                Ok(receipt) => receipt,
                // The request expired or was replaced, or another device of the
                // account answers it: this job can never complete.
                Err(error)
                    if matches!(
                        status_code(&error),
                        Some((404, _) | (409, "history_share_claimed" | "history_share_committed"))
                    ) =>
                {
                    self.abandon_history_share().await?;
                    return Err(native(error));
                }
                Err(error) => return Err(native(error)),
            };
            let wire = self.observe().await?;
            self.owned(move |slot, time| {
                let c = Coordinator::new(slot);
                Ok(c.history_uploaded(&c.directory(wire)?, upload, &receipt, time)?)
            })
            .await?;
        }
        let wire = self.observe().await?;
        let commit = self
            .owned(move |slot, time| {
                let c = Coordinator::new(slot);
                Ok(c.history_commit(&c.directory(wire)?, time)?)
            })
            .await?;
        let state = match session.client.commit_crypto_history_share(&commit.request, &commit.input).await {
            Ok(state) => state,
            Err(error)
                if matches!(
                    status_code(&error),
                    Some((404, _) | (409, "history_share_claimed" | "history_share_committed"))
                ) =>
            {
                self.abandon_history_share().await?;
                return Err(native(error));
            }
            Err(error) => return Err(native(error)),
        };
        let wire = self.observe().await?;
        self.owned(move |slot, time| {
            let c = Coordinator::new(slot);
            Ok(c.history_committed(&c.directory(wire)?, &state, time)?)
        })
        .await
    }
    /// New device: imports the committed share answering its request, page by
    /// page, then acknowledges it so the server deletes its copy. Safe to call
    /// again after any interruption; it also acknowledges finished requests
    /// whose acknowledgement was lost.
    pub async fn import_history(&self) -> Result<ImportProgress> {
        let _dispatch = self.0.dispatch.lock().await;
        let session = self.session()?;
        let wire = self.observe().await?;
        let (status, pending) = self
            .owned(move |slot, time| {
                let c = Coordinator::new(slot);
                let d = c.directory(wire)?;
                Ok((c.history_import_status(&d, time)?, c.history_pending(&d, time)?))
            })
            .await?;
        let mut status = match (status, pending) {
            (Some(status), _) => status,
            (None, None) => {
                self.acknowledge_stale_history(&session).await?;
                return Ok(ImportProgress::Idle);
            }
            (None, Some(request)) => {
                let state = match session.client.crypto_history_share(&request).await {
                    Ok(state) => state,
                    Err(error) if matches!(status_code(&error), Some((404, _))) => {
                        return Ok(ImportProgress::Waiting { request });
                    }
                    Err(error) => return Err(native(error)),
                };
                let wire = self.observe().await?;
                self.owned(move |slot, time| {
                    let c = Coordinator::new(slot);
                    Ok(c.history_import_begin(&c.directory(wire)?, &state, time)?)
                })
                .await?
            }
        };
        while let Some((period, after)) = status.next {
            let page = session
                .client
                .crypto_history_records(&status.request, period, &after.to_string())
                .await
                .map_err(native)?;
            let wire = self.observe().await?;
            status = self
                .owned(move |slot, time| {
                    let c = Coordinator::new(slot);
                    Ok(c.history_import_page(&c.directory(wire)?, &page, time)?)
                })
                .await?;
        }
        session.client.acknowledge_crypto_history(&status.request).await.map_err(native)?;
        Ok(ImportProgress::Done { request: status.request })
    }
    async fn acknowledge_stale_history(&self, session: &NativeSession) -> Result<()> {
        let listed = session.client.crypto_history_requests().await.map_err(native)?;
        let wire = self.observe().await?;
        let stale = self
            .owned(move |slot, time| {
                let c = Coordinator::new(slot);
                Ok(c.history_acknowledgeable(&c.directory(wire)?, &listed, time)?)
            })
            .await?;
        for request in stale {
            self.check()?;
            session.client.acknowledge_crypto_history(&request).await.map_err(native)?;
        }
        Ok(())
    }
}
