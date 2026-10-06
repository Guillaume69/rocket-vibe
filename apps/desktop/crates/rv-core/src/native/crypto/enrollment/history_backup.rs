//! History backup (E2EE_HISTORY_BACKUP.md, path B) through the existing desktop
//! session and viewer: enabling a generation behind its own code, joining it
//! with the code, uploading this device's history and restoring it. Shared
//! protected steps live in `rv_crypto::account::history_backup`.
use super::*;
use rv_crypto::account::history_backup::HistoryBackupPreview;
pub use rv_crypto::account::history_backup::HistoryBackupStatus;
use zeroize::Zeroizing;

pub struct HistoryBackupApproval {
    pub generation_revision: Option<String>,
    context: Arc<Context>,
    inner: HistoryBackupPreview,
}
fn native(error: rv_client::Error) -> Error {
    crate::native::Error::from(error).into()
}
impl Access {
    fn backup_session(&self) -> Result<Arc<NativeSession>> {
        self.check()?;
        self.0.context.session.upgrade().ok_or_else(changed)
    }
    pub async fn history_backup_status(&self) -> Result<HistoryBackupStatus> {
        let _dispatch = self.0.dispatch.lock().await;
        self.history_backup_status_inner().await
    }
    async fn history_backup_status_inner(&self) -> Result<HistoryBackupStatus> {
        let wire = self.observe().await?;
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            Ok(c.history_backup_status(&c.directory(wire)?)?)
        })
        .await
    }
    /// Review before a new generation replaces the active one.
    pub async fn preview_history_backup(&self) -> Result<HistoryBackupApproval> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let remote = self.backup_session()?.client.crypto_history_key().await.map_err(native)?;
        let context = self.0.context.clone();
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            let inner = c.preview_history_backup(&c.directory(wire)?, remote)?;
            Ok(HistoryBackupApproval { generation_revision: inner.generation_revision.clone(), context, inner })
        })
        .await
    }
    pub async fn prepare_history_backup(&self, approval: HistoryBackupApproval) -> Result<HistoryBackupStatus> {
        let _dispatch = self.0.dispatch.lock().await;
        if !Arc::ptr_eq(&approval.context, &self.0.context)
            || approval.generation_revision != approval.inner.generation_revision
        {
            return Err(changed());
        }
        let wire = self.observe().await?;
        self.owned(move |slot, time| {
            let c = Coordinator::new(slot);
            c.prepare_history_backup(&c.directory(wire)?, approval.inner, time)?;
            Ok(())
        })
        .await?;
        self.history_backup_status_inner().await
    }
    /// Explicit temporary code view; never in status or HTTP.
    pub async fn history_backup_code(&self) -> Result<Zeroizing<String>> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            c.history_backup_status(&c.directory(wire)?)?;
            Ok(c.history_backup_code()?)
        })
        .await
    }
    /// The user saved the code: the generation is published.
    pub async fn confirm_history_backup_code(&self) -> Result<HistoryBackupStatus> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            c.history_backup_status(&c.directory(wire)?)?;
            c.confirm_history_backup_code()?;
            Ok(())
        })
        .await?;
        self.resume_history_backup_inner().await
    }
    pub async fn resume_history_backup(&self) -> Result<HistoryBackupStatus> {
        let _dispatch = self.0.dispatch.lock().await;
        self.resume_history_backup_inner().await
    }
    async fn resume_history_backup_inner(&self) -> Result<HistoryBackupStatus> {
        let wire = self.observe().await?;
        let (request, cancel) = self
            .owned(move |slot, _| {
                let c = Coordinator::new(slot);
                let status = c.history_backup_status(&c.directory(wire)?)?;
                if status.cancel_requested {
                    Ok((c.pending_history_backup_cancellation()?, true))
                } else {
                    Ok((c.pending_history_backup()?, false))
                }
            })
            .await?;
        let session = self.backup_session()?;
        if cancel {
            let result = session.client.cancel_crypto_history_key(&request).await.map_err(native)?;
            self.owned(move |slot, _| Ok(Coordinator::new(slot).settle_history_backup_cancellation(&request, result)?))
                .await?;
        } else {
            let receipt = match session.client.crypto_history_key_operation(&request.operation_id).await {
                Ok(receipt) => receipt,
                Err(rv_client::Error::Server { status: 404, .. }) => {
                    self.check()?;
                    session.client.publish_crypto_history_key(&request).await.map_err(native)?
                }
                Err(error) => return Err(native(error)),
            };
            self.owned(move |slot, _| Ok(Coordinator::new(slot).acknowledge_history_backup(&request, receipt)?))
                .await?;
        }
        self.history_backup_status_inner().await
    }
    pub async fn cancel_history_backup(&self) -> Result<HistoryBackupStatus> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            c.history_backup_status(&c.directory(wire)?)?;
            c.request_history_backup_cancellation()?;
            Ok(())
        })
        .await?;
        self.resume_history_backup_inner().await
    }
    /// Joins the active generation with its code, on another device of the
    /// account or on a new device that lost the others.
    pub async fn join_history_backup(&self, code: Zeroizing<String>) -> Result<HistoryBackupStatus> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let remote = self.backup_session()?.client.crypto_history_key().await.map_err(native)?;
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            c.join_history_backup(&c.directory(wire)?, &remote, &code)?;
            Ok(())
        })
        .await?;
        self.history_backup_status_inner().await
    }
    /// Uploads every pending page of this device's history; returns the pages
    /// sent. Nothing happens without a held key.
    pub async fn sync_history_backup(&self) -> Result<u64> {
        let _dispatch = self.0.dispatch.lock().await;
        let session = self.backup_session()?;
        let mut pages = 0;
        // Uploads go only under the active generation (E2EE_HISTORY_BACKUP.md).
        let active = session.client.crypto_history_key().await.map_err(native)?;
        loop {
            let wire = self.observe().await?;
            let state = active.clone();
            let upload = self
                .owned(move |slot, time| {
                    let c = Coordinator::new(slot);
                    Ok(c.history_backup_upload(&c.directory(wire)?, &state, time)?)
                })
                .await?;
            let Some(upload) = upload else { return Ok(pages) };
            let receipt =
                session.client.upload_crypto_history_backup(&upload.period, &upload.input).await.map_err(native)?;
            let wire = self.observe().await?;
            self.owned(move |slot, time| {
                let c = Coordinator::new(slot);
                Ok(c.history_backup_uploaded(&c.directory(wire)?, upload, &receipt, time)?)
            })
            .await?;
            pages += 1;
        }
    }
    /// Continuous backup: after new private messages, uploads this device's
    /// pending pages in the background, at most once every 10 minutes per view.
    /// Without a held key it only reads the vault; failures retry next time.
    pub fn sync_history_backup_soon(&self) {
        const EVERY: std::time::Duration = std::time::Duration::from_secs(600);
        {
            let mut last = self.0.backup_synced.lock().unwrap();
            if last.is_some_and(|at| at.elapsed() < EVERY) || self.check().is_err() {
                return;
            }
            *last = Some(std::time::Instant::now());
        }
        let access = self.clone();
        tokio::spawn(async move {
            let _ = access.sync_history_backup().await;
        });
    }
    /// Downloads and imports every backed-up period of the held generation;
    /// returns the records imported.
    pub async fn restore_history_backup(&self) -> Result<u64> {
        let _dispatch = self.0.dispatch.lock().await;
        let session = self.backup_session()?;
        let status = self.history_backup_status_inner().await?;
        let generation = status.generation.ok_or_else(changed)?;
        let mut imported = 0;
        let mut after: Option<String> = None;
        loop {
            let listed =
                session.client.crypto_history_backup_periods(&generation, after.as_deref()).await.map_err(native)?;
            for period in listed.periods {
                let wire = self.observe().await?;
                let entry = period.clone();
                let mut next = self
                    .owned(move |slot, time| {
                        let c = Coordinator::new(slot);
                        Ok(c.history_backup_next(&c.directory(wire)?, &entry, time)?)
                    })
                    .await?;
                while let Some(rank) = next {
                    let page = session
                        .client
                        .crypto_history_backup_records(&period.period, &rank.to_string())
                        .await
                        .map_err(native)?;
                    imported += page.records.len() as u64;
                    let wire = self.observe().await?;
                    let entry = period.clone();
                    next = self
                        .owned(move |slot, time| {
                            let c = Coordinator::new(slot);
                            Ok(c.history_backup_import(&c.directory(wire)?, &entry, &page, time)?)
                        })
                        .await?;
                }
            }
            match listed.next {
                Some(next) => after = Some(next),
                None => return Ok(imported),
            }
        }
    }
}
