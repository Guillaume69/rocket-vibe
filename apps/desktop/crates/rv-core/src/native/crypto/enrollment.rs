//! Identity/device ceremonies share their protected state with Android. This
//! adapter owns only the existing desktop session and viewer lifecycle.
use super::{Context, Error, Result};
use crate::native::{NativeSession, security::Guard};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
pub use rv_crypto::account::{Stage, View};
use rv_crypto::{
    account::Coordinator,
    delivery::Lifecycle as _,
    identity::Root,
    installation::{Account, Installation},
    protected::{Manager, Storage},
    vault,
};
use rv_protocol::e2ee as http;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

pub mod peers;
pub mod recovery;
pub mod revocations;
pub mod rooms;
fn changed() -> Error {
    crate::native::Error::Protocol("crypto_enrollment_changed").into()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn decode(code: &str, limit: usize) -> Result<Vec<u8>> {
    if code.len() > limit.div_ceil(3) * 4 {
        return Err(changed());
    }
    let bytes = B64.decode(code).map_err(|_| changed())?;
    if bytes.len() > limit || B64.encode(&bytes) != code {
        return Err(changed());
    }
    Ok(bytes)
}
fn now() -> Result<u64> {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).map_err(|_| changed())
}
fn private<T>(value: std::result::Result<T, rv_crypto::identity::Error>) -> std::result::Result<T, vault::Error> {
    value.map_err(|_| vault::Error::Rejected)
}
pub struct Approval {
    pub root_fingerprint: String,
    pub request_fingerprint: String,
    pub device: String,
    pub expires_at: u64,
    context: Arc<Context>,
    inner: rv_crypto::account::Approval,
}
struct Inner {
    context: Arc<Context>,
    installation: Arc<Installation>,
    account: Account,
    dispatch: tokio::sync::Mutex<()>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.context.stopped.store(true, Ordering::SeqCst);
    }
}
#[derive(Clone)]
pub struct Access(Arc<Inner>);
impl Access {
    pub fn close(&self) {
        self.0.context.stopped.store(true, Ordering::SeqCst);
        self.0.context.guard.cancel();
    }
    pub fn check(&self) -> Result<()> {
        Ok(self.0.context.check()?)
    }
    async fn owned<T: Send + 'static>(
        &self,
        action: impl FnOnce(&Installation, u64) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.check()?;
        let inner = self.0.clone();
        let result = tokio::task::spawn_blocking(move || {
            inner.context.check()?;
            action(&inner.installation, now()?)
        })
        .await
        .map_err(|_| changed())?;
        if let Err(Error::Account(rv_crypto::account::Error::Withdrawn(scope))) = &result
            && let Some(session) = self.0.context.session.upgrade()
        {
            session.crypto.stop_scope(scope);
        }
        self.check()?;
        result
    }
    async fn observe(&self) -> Result<http::Directory> {
        self.check()?;
        let session = self.0.context.session.upgrade().ok_or_else(changed)?;
        let discovery = session.client.discover().await.map_err(crate::native::Error::from)?;
        if !self.0.context.discovery(&discovery) {
            self.close();
            return Err(changed());
        }
        session.refresh_credentials().await?;
        let user = session.client.me().await.map_err(crate::native::Error::from)?;
        self.check()?;
        let devices = session.client.device_sessions().await.map_err(crate::native::Error::from)?;
        self.check()?;
        let account = &self.0.account;
        if user.id != account.user
            || devices.len() > 256
            || devices.iter().filter(|d| d.current).count() != 1
            || !devices.iter().any(|d| d.current && d.id == account.device)
        {
            self.close();
            return Err(changed());
        }
        let directory =
            session.client.crypto_directory(&account.user, None).await.map_err(crate::native::Error::from)?;
        self.check()?;
        if directory.scope.instance_id != account.instance
            || directory.scope.data_epoch != account.data_epoch
            || directory.devices.len() > 64
            || directory.revocations.len() > 256
        {
            return Err(changed());
        }
        if directory.identity.is_some() {
            return self.verified_directory(&account.user, directory).await.map(|(wire, _)| wire);
        }
        if !directory.devices.is_empty() || !directory.revocations.is_empty() || directory.next_revocation.is_some() {
            return Err(changed());
        }
        Ok(directory)
    }
    pub async fn refresh(&self) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        self.view(self.observe().await?).await
    }
    pub(super) async fn prepared(&self) -> Result<(Arc<Manager>, Root)> {
        let wire = self.observe().await?;
        self.owned(move |slot, time| {
            let coordinator = Coordinator::new(slot);
            let directory = coordinator.directory(wire)?;
            Ok(coordinator.prepared(&directory, time)?)
        })
        .await
    }
    async fn device_revision(&self) -> Result<String> {
        self.prepared().await?;
        self.owned(|slot, _| Ok(Coordinator::new(slot).device_revision()?)).await
    }
    pub async fn conversation(&self) -> Result<super::Access> {
        let _dispatch = self.0.dispatch.lock().await;
        let (manager, root) = self.prepared().await?;
        self.check()?;
        let session = self.0.context.session.upgrade().ok_or_else(changed)?;
        let access = session.crypto(self.0.context.guard.clone(), manager, root).await?;
        self.check()?;
        Ok(access)
    }
    async fn view(&self, wire: http::Directory) -> Result<View> {
        self.owned(move |slot, time| {
            let coordinator = Coordinator::new(slot);
            let directory = coordinator.directory(wire)?;
            Ok(coordinator.view(&directory, time)?)
        })
        .await
    }
    pub async fn begin(&self, expected_fingerprint: String) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let next = wire.clone();
        self.owned(move |slot, time| {
            let coordinator = Coordinator::new(slot);
            let directory = coordinator.directory(wire)?;
            Ok(coordinator.begin(&directory, &expected_fingerprint, time)?)
        })
        .await?;
        self.view(next).await
    }
    pub async fn renew(&self, expected_fingerprint: String) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let next = wire.clone();
        self.owned(move |slot, time| {
            let coordinator = Coordinator::new(slot);
            let directory = coordinator.directory(wire)?;
            Ok(coordinator.renew(&directory, &expected_fingerprint, time)?)
        })
        .await?;
        self.view(next).await
    }
    pub async fn preview(&self, code: String) -> Result<Approval> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let context = self.0.context.clone();
        self.owned(move |slot, time| {
            let coordinator = Coordinator::new(slot);
            let directory = coordinator.directory(wire)?;
            let inner = coordinator.preview(&directory, &code, time)?;
            Ok(Approval {
                root_fingerprint: inner.root_fingerprint.clone(),
                request_fingerprint: inner.request_fingerprint.clone(),
                device: inner.device.clone(),
                expires_at: inner.expires_at,
                context,
                inner,
            })
        })
        .await
    }
    pub async fn approve(&self, preview: Approval) -> Result<String> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        if !Arc::ptr_eq(&preview.context, &self.0.context) {
            return Err(changed());
        }
        self.owned(move |slot, time| {
            let coordinator = Coordinator::new(slot);
            let directory = coordinator.directory(wire)?;
            Ok(coordinator.approve(&directory, preview.inner, time)?)
        })
        .await
    }
    pub async fn install(&self, code: String) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        let wire = self.observe().await?;
        let scope = self
            .owned(move |slot, time| {
                let coordinator = Coordinator::new(slot);
                let directory = coordinator.directory(wire)?;
                coordinator.install(&directory, &code, time)?;
                Ok(slot.load()?.ok_or_else(changed)?.scope().clone())
            })
            .await?;
        if let Some(session) = self.0.context.session.upgrade() {
            session.crypto.stop_scope(&scope);
        }
        self.resume_inner().await
    }
    pub async fn resume(&self) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        self.resume_inner().await
    }
    async fn resume_inner(&self) -> Result<View> {
        let wire = self.observe().await?;
        let request = self
            .owned(move |slot, time| {
                let coordinator = Coordinator::new(slot);
                let directory = coordinator.directory(wire)?;
                coordinator.view(&directory, time)?;
                Ok(coordinator.pending()?)
            })
            .await?;
        let session = self.0.context.session.upgrade().ok_or_else(changed)?;
        let receipt = match session.client.crypto_operation(&request.operation_id).await {
            Ok(receipt) => receipt,
            Err(rv_client::Error::Server { status: 404, .. }) => {
                self.check()?;
                session.client.register_crypto_device(&request).await.map_err(crate::native::Error::from)?
            }
            Err(error) => return Err(crate::native::Error::from(error).into()),
        };
        self.check()?;
        self.owned(move |slot, _| Ok(Coordinator::new(slot).acknowledge(&request, receipt)?)).await?;
        self.view(self.observe().await?).await
    }
}
impl NativeSession {
    pub fn crypto_settings_supported(&self) -> bool {
        self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.e2ee && c.device_sessions)
    }
    pub async fn crypto_settings(
        self: &Arc<Self>,
        guard: Guard,
        directory: PathBuf,
        storage: Arc<dyn Storage>,
    ) -> Result<Access> {
        let context = Arc::new(Context {
            session: Arc::downgrade(self),
            generation: self.security_generation.load(Ordering::SeqCst),
            guard,
            stopped: AtomicBool::new(false),
        });
        context.check()?;
        self.identity().await?;
        context.check()?;
        self.refresh_credentials().await?;
        let devices = self.client.device_sessions().await.map_err(crate::native::Error::from)?;
        context.check()?;
        if devices.len() > 256 || devices.iter().filter(|d| d.current).count() != 1 {
            return Err(changed());
        }
        let device = devices.iter().find(|d| d.current).ok_or_else(changed)?;
        let identity = self.info.native.as_ref().ok_or_else(changed)?;
        let account = Account {
            origin: self.info.base_url.clone(),
            instance: identity.instance_id.clone(),
            data_epoch: identity.data_epoch.clone(),
            user: self.info.user_id.clone(),
            device: device.id.clone(),
        };
        let installation = Arc::new(Installation::new(directory, account.clone(), storage)?);
        Ok(Access(Arc::new(Inner { context, installation, account, dispatch: tokio::sync::Mutex::new(()) })))
    }
}
