//! Existing account settings own the viewer fence; the shared coffer owns
//! target consent, permanent withdrawal and the exact original request.
use super::*;
pub use rv_crypto::account::revocations::Status;

pub struct Approval {
    pub device: String,
    pub incarnation: String,
    pub fingerprint: String,
    pub root_fingerprint: String,
    pub expires_at: String,
    context: Arc<Context>,
    inner: rv_crypto::account::revocations::Preview,
}
impl Access {
    pub async fn withdrawals(&self) -> Result<Status> {
        let _dispatch = self.0.dispatch.lock().await;
        self.withdrawals_inner().await
    }
    async fn withdrawals_inner(&self) -> Result<Status> {
        let wire = self.observe().await?;
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            Ok(c.withdrawals(&c.directory(wire)?)?)
        })
        .await
    }
    pub async fn preview_withdrawal(&self, device: String, fingerprint: String) -> Result<Approval> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let context = self.0.context.clone();
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            let inner = c.preview_withdrawal(&c.directory(wire)?, &device, &fingerprint)?;
            Ok(Approval {
                device: inner.device.clone(),
                incarnation: inner.incarnation.clone(),
                fingerprint: inner.fingerprint.clone(),
                root_fingerprint: inner.root_fingerprint.clone(),
                expires_at: inner.expires_at.clone(),
                context,
                inner,
            })
        })
        .await
    }
    pub async fn withdraw_device(&self, approval: Approval) -> Result<Status> {
        let _dispatch = self.0.dispatch.lock().await;
        self.check()?;
        if !Arc::ptr_eq(&approval.context, &self.0.context) {
            return Err(changed());
        }
        let wire = self.observe().await?;
        self.owned(move |slot, _| {
            let c = Coordinator::new(slot);
            c.prepare_withdrawal(&c.directory(wire)?, approval.inner)?;
            Ok(())
        })
        .await?;
        self.resume_withdrawal_inner().await
    }
    pub async fn resume_withdrawal(&self) -> Result<Status> {
        let _dispatch = self.0.dispatch.lock().await;
        self.resume_withdrawal_inner().await
    }
    async fn resume_withdrawal_inner(&self) -> Result<Status> {
        let wire = self.observe().await?;
        let request = self
            .owned(move |slot, _| {
                let c = Coordinator::new(slot);
                c.withdrawals(&c.directory(wire)?)?;
                Ok(c.pending_withdrawal()?)
            })
            .await?;
        let session = self.0.context.session.upgrade().ok_or_else(changed)?;
        let receipt = match session.client.crypto_operation(&request.operation_id).await {
            Ok(receipt) => receipt,
            Err(rv_client::Error::Server { status: 404, .. }) => {
                self.check()?;
                session.client.revoke_crypto_device(&request).await.map_err(crate::native::Error::from)?
            }
            Err(error) => return Err(crate::native::Error::from(error).into()),
        };
        self.check()?;
        self.owned(move |slot, _| Ok(Coordinator::new(slot).acknowledge_withdrawal(&request, receipt)?)).await?;
        self.withdrawals_inner().await
    }
}
