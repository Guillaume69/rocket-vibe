//! Shared root backup/recovery through the existing desktop session and viewer.
use super::*;
pub use rv_crypto::account::recovery::Status;
use zeroize::Zeroizing;
pub struct BackupApproval {
    pub root_fingerprint: String,
    pub backup_revision: Option<String>,
    context: Arc<Context>,
    inner: rv_crypto::account::recovery::BackupPreview,
}
pub struct RestoreApproval {
    pub root_fingerprint: String,
    pub backup_id: String,
    context: Arc<Context>,
    inner: rv_crypto::account::recovery::RestorePreview,
}
impl Access {
    pub async fn backup_status(&self) -> Result<Status> {
        let _dispatch = self.0.dispatch.lock().await;
        self.backup_status_inner().await
    }
    async fn backup_status_inner(&self) -> Result<Status> {
        let wire = self.observe().await?;
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            Ok(c.backup_status(&c.directory(wire)?)?)
        })
        .await
    }
    pub async fn preview_backup(&self) -> Result<BackupApproval> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let session = self.0.context.session.upgrade().ok_or_else(changed)?;
        let remote = session.client.crypto_root_backup().await.map_err(crate::native::Error::from)?;
        let context = self.0.context.clone();
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            let inner = c.preview_backup(&c.directory(wire)?, remote)?;
            Ok(BackupApproval {
                root_fingerprint: inner.root_fingerprint.clone(),
                backup_revision: inner.backup_revision.clone(),
                context,
                inner,
            })
        })
        .await
    }
    pub async fn prepare_backup(&self, approval: BackupApproval) -> Result<Status> {
        let _dispatch = self.0.dispatch.lock().await;
        if !Arc::ptr_eq(&approval.context, &self.0.context)
            || approval.root_fingerprint != approval.inner.root_fingerprint
            || approval.backup_revision != approval.inner.backup_revision
        {
            return Err(changed());
        }
        let wire = self.observe().await?;
        self.owned(move |slot, time| {
            let c = Coordinator::new(slot);
            c.prepare_backup(&c.directory(wire)?, approval.inner, time)?;
            Ok(())
        })
        .await?;
        self.backup_status_inner().await
    }
    /// Explicit temporary recovery-code view; never included in status or HTTP.
    pub async fn backup_code(&self) -> Result<Zeroizing<String>> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            c.backup_status(&c.directory(wire)?)?;
            Ok(c.backup_code()?)
        })
        .await
    }
    pub async fn confirm_backup_code(&self) -> Result<Status> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            c.backup_status(&c.directory(wire)?)?;
            c.confirm_backup_code()?;
            Ok(())
        })
        .await?;
        self.resume_backup_inner().await
    }
    pub async fn resume_backup(&self) -> Result<Status> {
        let _dispatch = self.0.dispatch.lock().await;
        self.resume_backup_inner().await
    }
    async fn resume_backup_inner(&self) -> Result<Status> {
        let wire = self.observe().await?;
        let (request, cancel) = self
            .owned(move |slot, _| {
                let c = Coordinator::new(slot);
                let status = c.backup_status(&c.directory(wire)?)?;
                if status.cancel_requested {
                    Ok((c.pending_backup_cancellation()?, true))
                } else {
                    Ok((c.pending_backup()?, false))
                }
            })
            .await?;
        self.dispatch_backup(request, cancel).await
    }
    pub async fn cancel_backup(&self) -> Result<Status> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let request = self
            .owned(move |slot, _| {
                let c = Coordinator::new(slot);
                c.backup_status(&c.directory(wire)?)?;
                Ok(c.request_backup_cancellation()?)
            })
            .await?;
        self.dispatch_backup(request, true).await
    }
    async fn dispatch_backup(&self, request: http::PublishRootBackup, cancel: bool) -> Result<Status> {
        let session = self.0.context.session.upgrade().ok_or_else(changed)?;
        self.check()?;
        if cancel {
            let result =
                session.client.cancel_crypto_root_backup(&request).await.map_err(crate::native::Error::from)?;
            self.owned(move |slot, _| Ok(Coordinator::new(slot).settle_backup_cancellation(&request, result)?)).await?;
        } else {
            let receipt = match session.client.crypto_root_backup_operation(&request.operation_id).await {
                Ok(receipt) => receipt,
                Err(rv_client::Error::Server { status: 404, .. }) => {
                    self.check()?;
                    session.client.publish_crypto_root_backup(&request).await.map_err(crate::native::Error::from)?
                }
                Err(error) => return Err(crate::native::Error::from(error).into()),
            };
            self.owned(move |slot, _| Ok(Coordinator::new(slot).acknowledge_backup(&request, receipt)?)).await?;
        }
        self.backup_status_inner().await
    }
    pub async fn preview_restore(&self, code: Zeroizing<String>, fingerprint: String) -> Result<RestoreApproval> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let session = self.0.context.session.upgrade().ok_or_else(changed)?;
        let remote = session.client.crypto_root_backup().await.map_err(crate::native::Error::from)?;
        let context = self.0.context.clone();
        self.owned(move |slot, time| {
            let c = Coordinator::new(slot);
            let d = c.directory(wire)?;
            let view = c.view(&d, time)?;
            if view.stage != Stage::Missing || fingerprint.is_empty() || view.remote_fingerprint != fingerprint {
                return Err(changed());
            }
            let inner = c.preview_restore(&remote, &code, &fingerprint)?;
            Ok(RestoreApproval {
                root_fingerprint: inner.root_fingerprint.clone(),
                backup_id: inner.backup_id.clone(),
                context,
                inner,
            })
        })
        .await
    }
    pub async fn restore_root(&self, approval: RestoreApproval) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        if !Arc::ptr_eq(&approval.context, &self.0.context)
            || approval.root_fingerprint != approval.inner.root_fingerprint
            || approval.backup_id != approval.inner.backup_id
        {
            return Err(changed());
        }
        let wire = self.observe().await?;
        self.owned(move |slot, time| {
            let c = Coordinator::new(slot);
            let d = c.directory(wire)?;
            let view = c.view(&d, time)?;
            if view.stage != Stage::Missing || view.remote_fingerprint != approval.root_fingerprint {
                return Err(changed());
            }
            c.restore_root(approval.inner, time)?;
            Ok(c.view(&d, time)?)
        })
        .await
    }
}
