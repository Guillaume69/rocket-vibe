//! Experimental MLS access on the existing native session, without a second
//! credential, ordinary SQLite plaintext projection or a raw worker escape.
//! The server and the advertised client feature mask still keep E2EE disabled.
use super::{NativeSession, security::Guard};
use rv_crypto::{delivery, groups, protected::Manager};
pub use rv_crypto::{
    delivery::{Batch, ChangePreview, EventKind, EventPreview, GenesisPreview, LocalGroupStatus, Target},
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
    #[error(transparent)]
    Storage(#[from] rv_crypto::vault::Error),
    #[error(transparent)]
    Identity(#[from] rv_crypto::identity::Error),
    #[error(transparent)]
    Account(#[from] rv_crypto::account::Error),
}
type Result<T> = std::result::Result<T, Error>;
impl Error {
    /// The server refused a group transition because a bot is a member of
    /// the room (RFC 0003): no retry helps until the bot leaves.
    pub fn bot_member(&self) -> bool {
        matches!(self, Error::Session(error) if error.code() == "crypto_bot_member")
    }
    /// A member's identity is not pinned, or a device of theirs is not
    /// approved (or revoked, expired, changed): fixed in that member's profile,
    /// not by retrying.
    pub fn untrusted(&self) -> bool {
        matches!(
            self.to_string().as_str(),
            "crypto_identity_untrusted"
                | "crypto_device_unapproved"
                | "crypto_device_revoked"
                | "crypto_identity_changed"
                | "crypto_identity_expired"
        )
    }
}
fn closed() -> super::Error {
    super::Error::Protocol("session_closed")
}
fn scope_changed() -> super::Error {
    super::Error::Protocol("crypto_delivery_scope_changed")
}

pub(super) struct Context {
    session: Weak<NativeSession>,
    generation: u64,
    guard: Guard,
    stopped: AtomicBool,
}
impl Context {
    /// A turn at the vault beside other operations; none while the storage
    /// key is renewed, which can hold the vault for seconds (a full re-seal
    /// and a keystore write).
    pub(super) async fn shared(&self) -> Option<tokio::sync::OwnedRwLockReadGuard<()>> {
        let gate = self.session.upgrade()?.vault_gate.clone();
        Some(gate.read_owned().await)
    }
    /// The vault alone, for the storage key renewal.
    pub(super) async fn exclusive(&self) -> Option<tokio::sync::OwnedRwLockWriteGuard<()>> {
        let gate = self.session.upgrade()?.vault_gate.clone();
        Some(gate.write_owned().await)
    }
    pub(super) fn check(&self) -> std::result::Result<(), super::Error> {
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

pub mod enrollment;
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
pub(crate) struct Registry(Mutex<Vec<Weak<Binding>>>);
impl Registry {
    pub(super) fn stop(&self) {
        for binding in self.0.lock().unwrap().drain(..).filter_map(|weak| weak.upgrade()) {
            binding.stop();
        }
    }
    pub(super) fn stop_scope(&self, scope: &Scope) {
        self.0.lock().unwrap().retain(|weak| {
            let Some(binding) = weak.upgrade() else { return false };
            if &binding.scope == scope {
                binding.stop();
                false
            } else {
                true
            }
        });
    }
    fn attach(&self, mut binding: Binding, manager: &Arc<Manager>, root: &Root) -> Result<Access> {
        let mut slot = self.0.lock().unwrap();
        binding.context.check()?;
        slot.retain(|weak| {
            let Some(previous) = weak.upgrade() else { return false };
            if previous.context.check().is_ok() {
                true
            } else {
                previous.stop();
                false
            }
        });
        if let Some(previous) = slot.iter().find_map(Weak::upgrade) {
            if previous.scope != binding.scope {
                return Err(super::Error::Protocol("crypto_session_already_open").into());
            }
            binding.worker = previous.worker.viewer(manager, root, binding.context.clone())?;
        }
        let binding = Arc::new(binding);
        slot.push(Arc::downgrade(&binding));
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
        let _turn = self.0.context.shared().await;
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
    pub async fn local_group_status(&self, room: &str) -> Result<LocalGroupStatus> {
        self.call(|worker| async move { worker.local_group_status(room).await }).await
    }
    pub async fn cancel_group(&self, room: &str, operation: &str) -> Result<groups::GroupSettlement> {
        self.call(|worker| async move { worker.cancel_group(room, operation).await }).await
    }
    /// The room's voice key at the server's group head, None while behind it.
    pub async fn voice_key(&self, room: &str) -> Result<Option<crate::voice::VoiceKey>> {
        let key = self.call(|worker| async move { worker.voice_key(room).await }).await?;
        Ok(key.map(|(epoch, secret)| crate::voice::VoiceKey::new(epoch, &secret)))
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
    pub async fn amend_message(
        &self,
        room: &str,
        target: String,
        text: Option<String>,
        operation: String,
    ) -> Result<groups::MessageReceipt> {
        self.call(|worker| async move { worker.amend_message(room, target, text, operation).await }).await
    }
    pub async fn react_message(
        &self,
        room: &str,
        target: String,
        emoji: String,
        present: bool,
        operation: String,
    ) -> Result<groups::MessageReceipt> {
        self.call(|worker| async move { worker.react_message(room, target, emoji, present, operation).await }).await
    }
    pub async fn journal_search(&self, room: &str, text: String, limit: usize) -> Result<groups::JournalSearch> {
        self.call(|worker| async move { worker.journal_search(room, text, limit).await }).await
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
    pub async fn message_roster(&self, room: &str) -> Result<(groups::Roster, bool)> {
        self.call(|worker| async move { worker.message_roster(room).await }).await
    }
    pub async fn draft(&self, roster: groups::Roster, thread: Option<String>) -> Result<String> {
        Ok(self.call(|worker| async move { worker.draft(roster, thread).await }).await?.to_string())
    }
    pub async fn set_draft(&self, roster: groups::Roster, thread: Option<String>, text: String) -> Result<()> {
        self.call(|worker| async move { worker.set_draft(roster, thread, text).await }).await
    }
    pub async fn outgoing_messages(&self, roster: groups::Roster) -> Result<Vec<groups::OutgoingMessage>> {
        self.call(|worker| async move { worker.outgoing_messages(roster).await }).await
    }
    pub async fn journal_page(&self, room: &str) -> Result<groups::JournalBatch> {
        self.call(|worker| async move { worker.journal_page(room).await }).await
    }
    pub async fn journal_last_batch(&self, room: &str) -> Result<groups::JournalBatch> {
        self.call(|worker| async move { worker.journal_last_batch(room).await }).await
    }
    pub async fn journal_projection(
        &self,
        room: &str,
        query: groups::ProjectionQuery,
    ) -> Result<groups::JournalProjection> {
        self.call(|worker| async move { worker.journal_projection(room, query).await }).await
    }
    pub async fn journal_sources(&self, room: &str) -> Result<groups::JournalSources> {
        self.call(|worker| async move { worker.journal_sources(room).await }).await
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
        let worker =
            delivery::Worker::new_guarded(manager.clone(), root.clone(), self.client.clone(), context.clone())?;
        self.crypto.attach(Binding { context, worker, scope }, &manager, &root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rv_crypto::{groups, identity};

    #[test]
    fn an_untrusted_member_is_told_apart_from_other_failures() {
        assert!(Error::Identity(identity::Error::Unapproved).untrusted());
        assert!(Error::Identity(identity::Error::Untrusted).untrusted());
        // Wrapped by the delivery worker, as a room dialog receives it.
        assert!(Error::Delivery(delivery::Error::Group(groups::Error::Identity(identity::Error::Revoked))).untrusted());
        assert!(!Error::Storage(rv_crypto::vault::Error::Busy).untrusted());
        assert!(!Error::Delivery(delivery::Error::Group(groups::Error::Mls)).untrusted());
    }
}
