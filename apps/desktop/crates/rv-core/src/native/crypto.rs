//! Experimental MLS access on the existing native session, without a second
//! credential, ordinary SQLite plaintext projection or a raw worker escape.
//! The server and the advertised client feature mask still keep E2EE disabled.
use super::{NativeSession, security::Guard};
use rv_crypto::{delivery, groups, protected::Manager};
pub use rv_crypto::{
    delivery::{Batch, ChangePreview, EventKind, EventPreview, GenesisPreview, Target},
    identity::{Fingerprint, Root},
    vault::Scope,
};
use rv_protocol::e2ee as http;
use std::{
    future::Future,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Session(#[from] super::Error),
    #[error(transparent)]
    Delivery(#[from] delivery::Error),
}
type Result<T> = std::result::Result<T, Error>;
fn closed() -> super::Error {
    super::Error::Protocol("session_closed")
}
fn scope_changed() -> super::Error {
    super::Error::Protocol("crypto_delivery_scope_changed")
}

struct Context {
    session: Weak<NativeSession>,
    generation: u64,
    guard: Guard,
    stopped: AtomicBool,
}
impl Context {
    fn check(&self) -> std::result::Result<(), super::Error> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err(closed());
        }
        self.guard.check()?;
        let session = self.session.upgrade().ok_or_else(closed)?;
        if session.security_generation.load(Ordering::SeqCst) != self.generation {
            return Err(closed());
        }
        session.ready()?;
        if !session.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.e2ee) {
            return Err(super::Error::Protocol("unsupported_feature"));
        }
        Ok(())
    }
}
impl delivery::Lifecycle for Context {
    fn active(&self) -> bool {
        self.check().is_ok()
    }
    fn discovery(&self, info: &rv_protocol::Discovery) -> bool {
        if !self.active() {
            return false;
        }
        let Some(session) = self.session.upgrade() else { return false };
        let Some(identity) = &session.info.native else { return false };
        if info.instance_id != identity.instance_id || info.data_epoch != identity.data_epoch {
            return false;
        }
        *session.capabilities.lock().unwrap() = Some(info.capabilities.clone());
        self.active()
    }
}
struct Binding {
    context: Arc<Context>,
    worker: delivery::Worker,
    scope: Scope,
}
impl Binding {
    fn stop(&self) {
        self.context.stopped.store(true, Ordering::SeqCst);
        self.worker.stop();
    }
}
impl Drop for Binding {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Default)]
pub(crate) struct Registry(Mutex<Option<Weak<Binding>>>);
impl Registry {
    pub(super) fn stop(&self) {
        if let Some(binding) = self.0.lock().unwrap().take().and_then(|weak| weak.upgrade()) {
            binding.stop();
        }
    }
    fn attach(&self, binding: Binding) -> Result<Access> {
        let mut slot = self.0.lock().unwrap();
        binding.context.check()?;
        if let Some(previous) = slot.as_ref().and_then(Weak::upgrade) {
            if previous.context.check().is_ok() {
                return Err(super::Error::Protocol("crypto_session_already_open").into());
            }
            previous.stop();
        }
        let binding = Arc::new(binding);
        *slot = Some(Arc::downgrade(&binding));
        Ok(Access(binding))
    }
}

/// Clones share one dispatch queue and one terminal lifecycle. The weak session
/// reference cannot keep a closed account runner alive. Cleartext results are
/// discarded if the account/viewer changes while HTTP or owned storage finishes.
#[derive(Clone)]
pub struct Access(Arc<Binding>);
impl Access {
    pub fn scope(&self) -> &Scope {
        &self.0.scope
    }
    pub fn stop(&self) {
        self.0.stop();
    }
    pub fn check(&self) -> Result<()> {
        if let Err(error) = self.0.context.check() {
            self.stop();
            return Err(error.into());
        }
        Ok(())
    }
    async fn call<T, F>(&self, action: impl FnOnce(delivery::Worker) -> F) -> Result<T>
    where
        F: Future<Output = std::result::Result<T, delivery::Error>>,
    {
        self.check()?;
        let result = action(self.0.worker.clone()).await;
        self.check()?;
        if matches!(&result, Err(delivery::Error::Scope)) {
            self.stop();
        }
        Ok(result?)
    }
    pub async fn publish_packages(&self, revision: String, count: usize) -> Result<http::OperationReceipt> {
        self.call(|worker| async move { worker.publish_packages(revision, count).await }).await
    }
    pub async fn resume_packages(&self) -> Result<http::OperationReceipt> {
        self.call(|worker| async move { worker.resume_packages().await }).await
    }
    pub async fn preview_genesis(
        &self,
        room: &str,
        incarnation: [u8; 16],
        operation: String,
        targets: Vec<Target>,
    ) -> Result<GenesisPreview> {
        self.call(|worker| async move { worker.preview_genesis(room, incarnation, operation, targets).await }).await
    }
    pub async fn prepare_genesis(&self, preview: GenesisPreview, confirmed: Fingerprint) -> Result<groups::Receipt> {
        self.call(|worker| async move { worker.prepare_genesis(preview, confirmed).await }).await
    }
    pub async fn preview_change(
        &self,
        room: &str,
        operation: String,
        removals: Vec<String>,
        targets: Vec<Target>,
    ) -> Result<ChangePreview> {
        self.call(|worker| async move { worker.preview_change(room, operation, removals, targets).await }).await
    }
    pub async fn prepare_change(&self, preview: ChangePreview, confirmed: Fingerprint) -> Result<groups::Receipt> {
        self.call(|worker| async move { worker.prepare_change(preview, confirmed).await }).await
    }
    pub async fn resume_group(&self, room: &str) -> Result<groups::Receipt> {
        self.call(|worker| async move { worker.resume_group(room).await }).await
    }
    pub async fn cancel_group(&self, room: &str, operation: &str) -> Result<groups::GroupSettlement> {
        self.call(|worker| async move { worker.cancel_group(room, operation).await }).await
    }
    pub async fn events(&self, room: &str) -> Result<Batch> {
        self.call(|worker| async move { worker.events(room).await }).await
    }
    pub async fn preview_event(&self, event: http::GroupEvent) -> Result<EventPreview> {
        self.call(|worker| async move { worker.preview_event(event).await }).await
    }
    pub async fn accept_event(&self, preview: EventPreview, confirmed: Fingerprint) -> Result<groups::Receipt> {
        self.call(|worker| async move { worker.accept_event(preview, confirmed).await }).await
    }
    pub async fn send_message(&self, room: &str, message: rv_protocol::SendMessage) -> Result<groups::MessageReceipt> {
        self.call(|worker| async move { worker.send_message(room, message).await }).await
    }
    pub async fn resume_message(&self, operation: &str) -> Result<groups::MessageReceipt> {
        self.call(|worker| async move { worker.resume_message(operation).await }).await
    }
    pub async fn cancel_message(&self, operation: &str) -> Result<groups::MessageSettlement> {
        self.call(|worker| async move { worker.cancel_message(operation).await }).await
    }
    pub async fn receive_message(&self, message: http::ApplicationMessage) -> Result<groups::ClearMessage> {
        self.call(|worker| async move { worker.receive_message(message).await }).await
    }
    pub async fn journal_page(&self, room: &str) -> Result<groups::JournalBatch> {
        self.call(|worker| async move { worker.journal_page(room).await }).await
    }
    pub async fn journal_last_batch(&self, room: &str) -> Result<groups::JournalBatch> {
        self.call(|worker| async move { worker.journal_last_batch(room).await }).await
    }
}
impl NativeSession {
    /// Explicit experimental attachment; no vault creation, root generation or
    /// enrollment is implicit. Production servers currently advertise e2ee=false.
    pub async fn crypto(self: &Arc<Self>, guard: Guard, manager: Arc<Manager>, root: Root) -> Result<Access> {
        self.ready()?;
        guard.check()?;
        let context = Arc::new(Context {
            session: Arc::downgrade(self),
            generation: self.security_generation.load(Ordering::SeqCst),
            guard,
            stopped: AtomicBool::new(false),
        });
        self.identity().await?;
        context.check()?;
        let scope = manager.scope().clone();
        let identity = self.info.native.as_ref().ok_or_else(scope_changed)?;
        if scope.instance != identity.instance_id
            || scope.data_epoch != identity.data_epoch
            || scope.user != self.info.user_id
            || root.instance != scope.instance
            || root.user != scope.user
        {
            return Err(scope_changed().into());
        }
        self.refresh_credentials().await?;
        context.check()?;
        let user = self.client.me().await.map_err(super::Error::from)?;
        context.check()?;
        if user.id != scope.user {
            return Err(scope_changed().into());
        }
        let devices = self.client.device_sessions().await.map_err(super::Error::from)?;
        context.check()?;
        let mut current = devices.iter().filter(|device| device.current);
        if devices.len() > 256
            || current.next().is_none_or(|device| device.id != scope.device)
            || current.next().is_some()
        {
            return Err(scope_changed().into());
        }
        let worker = delivery::Worker::new_guarded(manager, root, self.client.clone(), context.clone())?;
        self.crypto.attach(Binding { context, worker, scope })
    }
}
