//! The stores the cipher functions read and write through, and the session
//! checkout protocol of a write-back cache: a session is checked out for an
//! encrypt or decrypt and handed back once, stored or cancelled.

use portable_atomic::{AtomicBool, Ordering};
use std::num::NonZeroU64;
use std::sync::Arc;

use async_trait::async_trait;

use super::address::ProtocolAddress;
use super::error::{Result, SignalProtocolError};
use super::keys::{KeyPair, PublicKey};
use super::prekeys::{PreKeyId, PreKeyRecord, SignedPreKeyId, SignedPreKeyRecord};
use super::sender_keys::SenderKeyRecord;
use super::session::SessionRecord;
use crate::store::sender_key_name::SenderKeyName;

#[cfg(not(target_arch = "wasm32"))]
pub trait ThreadSafe: Send + Sync {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + Sync + ?Sized> ThreadSafe for T {}
#[cfg(target_arch = "wasm32")]
pub trait ThreadSafe {}
#[cfg(target_arch = "wasm32")]
impl<T: ?Sized> ThreadSafe for T {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Sending,
    Receiving,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityChange {
    NewOrUnchanged,
    ReplacedExisting,
}

impl IdentityChange {
    pub fn from_changed(changed: bool) -> Self {
        if changed {
            Self::ReplacedExisting
        } else {
            Self::NewOrUnchanged
        }
    }
}

impl TryFrom<isize> for IdentityChange {
    type Error = SignalProtocolError;
    fn try_from(value: isize) -> Result<Self> {
        match value {
            0 => Ok(Self::NewOrUnchanged),
            1 => Ok(Self::ReplacedExisting),
            other => Err(SignalProtocolError::InvalidArgument(format!(
                "identity change {other}"
            ))),
        }
    }
}

/// A checkout's identity: the store generation it was taken in, and a token
/// only it holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SessionCheckoutKey {
    generation: u64,
    token: NonZeroU64,
}

impl SessionCheckoutKey {
    pub const fn new(generation: u64, token: NonZeroU64) -> Self {
        Self { generation, token }
    }
    pub const fn generation(self) -> u64 {
        self.generation
    }
    pub const fn token(self) -> NonZeroU64 {
        self.token
    }
}

/// How a store took a checked-out session back.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum SessionCheckoutStoreResult {
    Stored,
    /// The checkout no longer holds (the store was cleared or the slot taken).
    Rejected,
    /// Queued behind a busy store; the flag says whether it was applied once
    /// `complete_session_checkout` has run.
    Pending(Arc<AtomicBool>),
    /// The store has no checkout path: store it the ordinary way.
    Unhandled(SessionRecord),
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait IdentityKeyStore: ThreadSafe {
    async fn get_identity_key_pair(&self) -> Result<KeyPair>;
    async fn get_local_registration_id(&self) -> Result<u32>;
    async fn save_identity(
        &mut self,
        address: &ProtocolAddress,
        identity: &PublicKey,
    ) -> Result<IdentityChange>;
    async fn is_trusted_identity(
        &self,
        address: &ProtocolAddress,
        identity: &PublicKey,
        direction: Direction,
    ) -> Result<bool>;
    async fn get_identity(&self, address: &ProtocolAddress) -> Result<Option<PublicKey>>;

    /// A synchronous answer, when the store has one at hand.
    fn try_is_trusted_identity(
        &self,
        _address: &ProtocolAddress,
        _identity: &PublicKey,
        _direction: Direction,
    ) -> Option<Result<bool>> {
        None
    }

    fn try_save_identity(
        &mut self,
        _address: &ProtocolAddress,
        _identity: &PublicKey,
    ) -> Option<Result<IdentityChange>> {
        None
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait PreKeyStore: ThreadSafe {
    async fn get_pre_key(&self, prekey_id: PreKeyId) -> Result<PreKeyRecord>;
    async fn save_pre_key(&mut self, prekey_id: PreKeyId, record: &PreKeyRecord) -> Result<()>;
    async fn remove_pre_key(&mut self, prekey_id: PreKeyId) -> Result<()>;
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait SignedPreKeyStore: ThreadSafe {
    async fn get_signed_pre_key(
        &self,
        signed_prekey_id: SignedPreKeyId,
    ) -> Result<SignedPreKeyRecord>;
    async fn save_signed_pre_key(
        &mut self,
        signed_prekey_id: SignedPreKeyId,
        record: &SignedPreKeyRecord,
    ) -> Result<()>;
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait SessionStore: ThreadSafe {
    async fn load_session(&self, address: &ProtocolAddress) -> Result<Option<SessionRecord>>;
    async fn store_session(
        &mut self,
        address: &ProtocolAddress,
        record: SessionRecord,
    ) -> Result<()>;

    async fn has_session(&self, address: &ProtocolAddress) -> Result<bool> {
        Ok(self.load_session(address).await?.is_some())
    }

    /// Loads a session to change it; the checkout key, when the store gives
    /// one, must come back through `try_store_session_from_checkout` or
    /// `cancel_session_checkout`.
    async fn load_session_for_update(
        &self,
        address: &ProtocolAddress,
    ) -> Result<(Option<SessionRecord>, Option<SessionCheckoutKey>)> {
        Ok((self.load_session(address).await?, None))
    }

    async fn prefetch_sessions(&self, _addresses: &[ProtocolAddress]) -> Result<()> {
        Ok(())
    }

    /// Applies checkouts a busy store queued.
    async fn complete_session_checkout(&mut self) {}

    fn cancel_session_checkout(
        &mut self,
        _address: &ProtocolAddress,
        _checkout: Option<SessionCheckoutKey>,
    ) {
    }

    fn try_has_session(&self, _address: &ProtocolAddress) -> Option<Result<bool>> {
        None
    }

    fn try_load_session_for_update(
        &self,
        _address: &ProtocolAddress,
    ) -> Option<Result<(Option<SessionRecord>, Option<SessionCheckoutKey>)>> {
        None
    }

    fn try_store_session_from_checkout(
        &mut self,
        _address: &ProtocolAddress,
        record: SessionRecord,
        _checkout: Option<SessionCheckoutKey>,
        _had_session: bool,
    ) -> SessionCheckoutStoreResult {
        SessionCheckoutStoreResult::Unhandled(record)
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub trait SenderKeyStore: ThreadSafe {
    async fn store_sender_key(
        &mut self,
        sender_key_name: &SenderKeyName,
        record: SenderKeyRecord,
    ) -> Result<()>;
    async fn load_sender_key(
        &self,
        sender_key_name: &SenderKeyName,
    ) -> Result<Option<SenderKeyRecord>>;

    /// Serializes a group's chain between its users; the cipher functions
    /// never take it themselves, their callers do.
    async fn sender_key_lock(
        &self,
        _sender_key_name: &SenderKeyName,
    ) -> Arc<async_lock::Mutex<()>> {
        Arc::new(async_lock::Mutex::new(()))
    }

    async fn session_setup_lock(
        &self,
        _sender_key_name: &SenderKeyName,
    ) -> Arc<async_lock::Mutex<()>> {
        Arc::new(async_lock::Mutex::new(()))
    }
}

pub(crate) async fn checkout_session(
    store: &mut dyn SessionStore,
    address: &ProtocolAddress,
) -> Result<(Option<SessionRecord>, Option<SessionCheckoutKey>)> {
    if let Some(result) = store.try_load_session_for_update(address) {
        return result;
    }
    store.load_session_for_update(address).await
}

/// A session checked out for an encrypt or decrypt. The caller works on a
/// copy; `store` hands the changed record back. If the call fails or is
/// dropped at any await point (its task aborted), the original is handed back
/// unchanged instead: a write-back cache has taken it out while checked out,
/// so releasing the checkout alone would lose it.
pub(crate) struct CheckoutGuard<'s> {
    store: &'s mut dyn SessionStore,
    address: &'s ProtocolAddress,
    key: Option<SessionCheckoutKey>,
    original: Option<SessionRecord>,
    armed: bool,
}

impl<'s> CheckoutGuard<'s> {
    /// The guard and a working copy of the session, if there is one.
    pub(crate) async fn take(
        store: &'s mut dyn SessionStore,
        address: &'s ProtocolAddress,
    ) -> Result<(Self, Option<SessionRecord>)> {
        let (record, key) = checkout_session(store, address).await?;
        let copy = record.clone();
        Ok((
            Self {
                store,
                address,
                key,
                original: record,
                armed: true,
            },
            copy,
        ))
    }

    pub(crate) async fn store(mut self, record: SessionRecord) -> Result<()> {
        self.armed = false;
        let had_session = self.original.is_some();
        store_checked_out(
            &mut *self.store,
            self.address,
            record,
            self.key,
            had_session,
        )
        .await
    }
}

impl Drop for CheckoutGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        match self.original.take() {
            Some(original) => {
                // A store without a checkout path never took it out: nothing to restore.
                let _ = self.store.try_store_session_from_checkout(
                    self.address,
                    original,
                    self.key,
                    true,
                );
            }
            None => self.store.cancel_session_checkout(self.address, self.key),
        }
    }
}

/// Hands a checked-out session back as stored.
pub(crate) async fn store_checked_out(
    store: &mut dyn SessionStore,
    address: &ProtocolAddress,
    record: SessionRecord,
    checkout: Option<SessionCheckoutKey>,
    had_session: bool,
) -> Result<()> {
    match store.try_store_session_from_checkout(address, record, checkout, had_session) {
        SessionCheckoutStoreResult::Stored => Ok(()),
        SessionCheckoutStoreResult::Unhandled(record) => store.store_session(address, record).await,
        SessionCheckoutStoreResult::Pending(applied) => {
            store.complete_session_checkout().await;
            if applied.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(SignalProtocolError::InvalidState(
                    "SessionCheckout::commit",
                    "queued restore was not applied".to_owned(),
                ))
            }
        }
        SessionCheckoutStoreResult::Rejected => Err(SignalProtocolError::InvalidState(
            "SessionCheckout::commit",
            "checkout no longer holds".to_owned(),
        )),
    }
}

/// A session checked out to be read, then handed back unchanged
/// (`commit`) or released (`discard`; dropping it releases it too).
pub struct SessionCheckout<'a> {
    store: &'a mut dyn SessionStore,
    address: &'a ProtocolAddress,
    record: Option<SessionRecord>,
    checkout: Option<SessionCheckoutKey>,
}

impl<'a> SessionCheckout<'a> {
    /// None when there is no session; the checkout is then released.
    pub async fn load(
        store: &'a mut dyn SessionStore,
        address: &'a ProtocolAddress,
    ) -> Result<Option<Self>> {
        let (record, checkout) = checkout_session(store, address).await?;
        match record {
            Some(record) => Ok(Some(Self {
                store,
                address,
                record: Some(record),
                checkout,
            })),
            None => {
                store.cancel_session_checkout(address, checkout);
                Ok(None)
            }
        }
    }

    pub fn record(&self) -> &SessionRecord {
        self.record.as_ref().expect("held until commit or discard")
    }

    pub async fn commit(mut self) -> Result<()> {
        let record = self.record.take().expect("held until commit or discard");
        let checkout = self.checkout.take();
        store_checked_out(self.store, self.address, record, checkout, true).await
    }

    pub fn discard(mut self) {
        self.release();
    }

    fn release(&mut self) {
        if self.record.take().is_some() {
            self.store
                .cancel_session_checkout(self.address, self.checkout.take());
        }
    }
}

impl Drop for SessionCheckout<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

pub async fn is_trusted_identity<S: IdentityKeyStore + ?Sized>(
    store: &S,
    address: &ProtocolAddress,
    identity: &PublicKey,
    direction: Direction,
) -> Result<bool> {
    match store.try_is_trusted_identity(address, identity, direction) {
        Some(answer) => answer,
        None => {
            store
                .is_trusted_identity(address, identity, direction)
                .await
        }
    }
}

pub(crate) async fn save_identity(
    store: &mut dyn IdentityKeyStore,
    address: &ProtocolAddress,
    identity: &PublicKey,
) -> Result<IdentityChange> {
    match store.try_save_identity(address, identity) {
        Some(answer) => answer,
        None => store.save_identity(address, identity).await,
    }
}

pub async fn has_session<S: SessionStore + ?Sized>(
    store: &S,
    address: &ProtocolAddress,
) -> Result<bool> {
    match store.try_has_session(address) {
        Some(answer) => answer,
        None => store.has_session(address).await,
    }
}
