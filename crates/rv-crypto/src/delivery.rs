//! Experimental async delivery over the existing native SDK. Network never
//! runs inside the protected lease; private work runs on owned blocking tasks.
use crate::{groups, identity::Root, packages, protected::Manager, vault};
use rv_client::NativeClient;
use rv_protocol::e2ee as http;
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Group(#[from] groups::Error),
    #[error(transparent)]
    Packages(#[from] packages::Error),
    #[error(transparent)]
    Storage(#[from] vault::Error),
    #[error(transparent)]
    Network(#[from] rv_client::Error),
    #[error("crypto_delivery_scope_changed")]
    Scope,
    #[error("crypto_delivery_stopped")]
    Stopped,
    #[error("crypto_delivery_worker_failed")]
    Worker,
    #[error("crypto_delivery_cooldown")]
    Cooldown { retry_after: u64 },
}
type Result<T> = std::result::Result<T, Error>;
type Clock = fn() -> Result<u64>;
fn clock() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| Error::Worker)
}

pub struct Target {
    pub user: String,
    pub device: String,
}
pub struct GenesisPreview {
    pub preview: groups::Preview,
    request: groups::Genesis,
    consent: groups::Consent,
}
pub struct ChangePreview {
    pub preview: groups::Preview,
    request: groups::Change,
    consent: groups::Consent,
}
pub struct EventPreview {
    pub preview: groups::Preview,
    pub kind: EventKind,
    event: http::GroupEvent,
    consent: groups::Consent,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    Admission,
    Readmission,
    Commit,
}
/// Public, validated page envelope. Each event still needs its own protected
/// preview/consent/accept; a page or head cannot grant admission or trust.
pub struct Batch {
    pub head: groups::Receipt,
    pub page: http::GroupEventPage,
}
/// Protected local observations for the existing room controls. An accepted
/// receipt is a catchup point; it does not authorize a send or a new admission.
pub struct LocalGroupStatus {
    pub accepted: Option<groups::Receipt>,
    pub participants: Vec<groups::Participant>,
    pub pending: Option<groups::PendingLookup>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cooldown {
    version: u8,
    observed: u64,
    until: u64,
}
const COOLDOWN: &str = "crypto-http-cooldown-v1";

/// A native account/viewer generation. Called only at operation boundaries;
/// it must not access the vault or wait for platform work. Once inactive, this
/// worker is terminal even if the application's session later reconnects.
pub trait Lifecycle: Send + Sync {
    fn active(&self) -> bool;
    /// Observe a successfully scoped discovery without a second network request.
    /// Default adapters have no capability state to update.
    fn discovery(&self, _info: &rv_protocol::Discovery) -> bool {
        self.active()
    }
}

/// One immutable account/vault scope. Clones share stop state and dispatch
/// ordering; a new viewer generation gets a new worker and stops its old one.
/// This feature remains experimental; existing apps still gate E2EE off.
#[derive(Clone)]
pub struct Worker {
    manager: Arc<Manager>,
    root: Root,
    client: NativeClient,
    dispatch: Arc<Mutex<()>>,
    stopped: Arc<AtomicBool>,
    lifecycle: Option<Arc<dyn Lifecycle>>,
    clock: Clock,
}
impl Worker {
    pub fn new(manager: Arc<Manager>, root: Root, client: NativeClient) -> Result<Self> {
        groups::Coordinator::new(manager.clone(), root.clone())?;
        packages::Coordinator::new(manager.clone(), root.clone())?;
        Ok(Self {
            manager,
            root,
            client,
            dispatch: Arc::new(Mutex::new(())),
            stopped: Arc::new(AtomicBool::new(false)),
            lifecycle: None,
            clock,
        })
    }
    pub fn new_guarded(
        manager: Arc<Manager>,
        root: Root,
        client: NativeClient,
        lifecycle: Arc<dyn Lifecycle>,
    ) -> Result<Self> {
        let mut worker = Self::new(manager, root, client)?;
        worker.lifecycle = Some(lifecycle);
        worker.current()?;
        Ok(worker)
    }
    #[cfg(test)]
    pub(crate) fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }
    fn current(&self) -> Result<()> {
        if self.lifecycle.as_ref().is_some_and(|guard| !guard.active()) {
            self.stop();
        }
        if self.stopped.load(Ordering::Acquire) {
            Err(Error::Stopped)
        } else {
            Ok(())
        }
    }
    async fn owned<T: Send + 'static>(
        &self,
        operation: impl FnOnce(Arc<Manager>, Root, u64) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.current()?;
        let manager = self.manager.clone();
        let root = self.root.clone();
        let stopped = self.stopped.clone();
        let lifecycle = self.lifecycle.clone();
        let clock = self.clock;
        let value = tokio::task::spawn_blocking(move || {
            if lifecycle.as_ref().is_some_and(|guard| !guard.active()) {
                stopped.store(true, Ordering::Release);
            }
            if stopped.load(Ordering::Acquire) {
                return Err(Error::Stopped);
            }
            operation(manager, root, clock()?)
        })
        .await
        .map_err(|_| Error::Worker)??;
        self.current()?;
        Ok(value)
    }
    async fn scope(&self) -> Result<()> {
        self.current()?;
        let info = self.client.discover().await?;
        self.current()?;
        if info.instance_id != self.manager.scope().instance
            || info.data_epoch != self.manager.scope().data_epoch
        {
            return Err(Error::Scope);
        }
        if self
            .lifecycle
            .as_ref()
            .is_some_and(|guard| !guard.discovery(&info))
        {
            self.stop();
            return Err(Error::Stopped);
        }
        self.current()?;
        let user = self.client.me().await?;
        self.current()?;
        if user.id != self.manager.scope().user {
            return Err(Error::Scope);
        }
        let devices = self.client.device_sessions().await?;
        self.current()?;
        if devices.len() > 256 {
            return Err(groups::Error::Limit.into());
        }
        let mut current = devices.iter().filter(|device| device.current);
        if current
            .next()
            .is_none_or(|device| device.id != self.manager.scope().device)
            || current.next().is_some()
        {
            return Err(Error::Scope);
        }
        Ok(())
    }
    async fn gate(&self) -> Result<()> {
        self.owned(|manager, _, now| {
            manager
                .inspect(|_, records| {
                    let Some(value) = records.get(COOLDOWN) else {
                        return Ok(None);
                    };
                    if value.len() > 256 {
                        return Err(vault::Error::Rejected);
                    }
                    let value: Cooldown =
                        serde_json::from_slice(value).map_err(|_| vault::Error::Rejected)?;
                    if value.version != 1
                        || now < value.observed
                        || value.until < value.observed
                        || value.until - value.observed > 300
                    {
                        return Err(vault::Error::Rejected);
                    }
                    Ok((value.until > now).then(|| value.until - now))
                })
                .map_err(Error::from)?
                .map_or(Ok(()), |retry_after| Err(Error::Cooldown { retry_after }))
        })
        .await
    }
    async fn network<T>(&self, result: std::result::Result<T, rv_client::Error>) -> Result<T> {
        self.current()?;
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                if let rv_client::Error::Server {
                    status: 429,
                    retry_after,
                    ..
                } = &error
                {
                    let delay = retry_after.unwrap_or(1).clamp(1, 300);
                    self.owned(move |manager, _, now| {
                        manager.transact(|_, records| {
                            let value = Cooldown {
                                version: 1,
                                observed: now,
                                until: now.checked_add(delay).ok_or(vault::Error::Rejected)?,
                            };
                            records.insert(
                                COOLDOWN.into(),
                                serde_json::to_vec(&value).map_err(|_| vault::Error::Rejected)?,
                            );
                            Ok(())
                        })?;
                        Ok(())
                    })
                    .await?;
                }
                Err(error.into())
            }
        }
    }
    async fn available(
        &self,
        room: &str,
        targets: Vec<Target>,
    ) -> Result<Vec<http::AvailableKeyPackage>> {
        if targets.len() >= rv_crypto_public::groups::MAX_DEVICES {
            return Err(groups::Error::Limit.into());
        }
        let mut packages = Vec::new();
        for target in targets {
            self.current()?;
            packages.push(
                self.client
                    .available_crypto_key_package(room, &target.user, &target.device)
                    .await?,
            );
        }
        self.current()?;
        Ok(packages)
    }
    pub async fn preview_genesis(
        &self,
        room: &str,
        incarnation: [u8; 16],
        operation: String,
        targets: Vec<Target>,
    ) -> Result<GenesisPreview> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        let roster = self.client.crypto_group_roster(room).await?;
        let packages = self.available(room, targets).await?;
        self.owned(move |manager, root, now| {
            let request = groups::Genesis::from_wire(&roster, incarnation, &operation, &packages)?;
            let (preview, consent) =
                groups::Coordinator::new(manager, root)?.preview_genesis(&request, now)?;
            Ok(GenesisPreview {
                preview,
                request,
                consent,
            })
        })
        .await
    }
    pub async fn prepare_genesis(
        &self,
        preview: GenesisPreview,
        confirmed: [u8; 32],
    ) -> Result<groups::Receipt> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        self.gate().await?;
        let room = preview.request.roster.scope.room.clone();
        self.owned(move |manager, root, now| {
            groups::Coordinator::new(manager, root)?.prepare_genesis(
                &preview.request,
                &preview.consent,
                confirmed,
                now,
            )?;
            Ok(())
        })
        .await?;
        self.resume_group_inner(&room).await
    }
    pub async fn preview_change(
        &self,
        room: &str,
        operation: String,
        removals: Vec<String>,
        targets: Vec<Target>,
    ) -> Result<ChangePreview> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        let roster = self.client.crypto_group_roster(room).await?;
        let packages = self.available(room, targets).await?;
        self.owned(move |manager, root, now| {
            let request = groups::Change::from_wire(&roster, &operation, &removals, &packages)?;
            let (preview, consent) =
                groups::Coordinator::new(manager, root)?.preview_change(&request, now)?;
            Ok(ChangePreview {
                preview,
                request,
                consent,
            })
        })
        .await
    }
    pub async fn prepare_change(
        &self,
        preview: ChangePreview,
        confirmed: [u8; 32],
    ) -> Result<groups::Receipt> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        self.gate().await?;
        let room = preview.request.roster.scope.room.clone();
        self.owned(move |manager, root, now| {
            groups::Coordinator::new(manager, root)?.prepare_change(
                &preview.request,
                &preview.consent,
                confirmed,
                now,
            )?;
            Ok(())
        })
        .await?;
        self.resume_group_inner(&room).await
    }
    pub async fn resume_group(&self, room: &str) -> Result<groups::Receipt> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        self.resume_group_inner(room).await
    }
    pub async fn local_group_status(&self, room: &str) -> Result<LocalGroupStatus> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        let room = room.to_owned();
        self.owned(move |manager, root, _| {
            let coordinator = groups::Coordinator::new(manager, root)?;
            let (accepted, participants) = match coordinator.accepted_group(&room) {
                Ok((receipt, participants)) => (Some(receipt), participants),
                Err(groups::Error::NotReady) => (None, vec![]),
                Err(error) => return Err(error.into()),
            };
            let pending = match coordinator.pending_lookup(&room) {
                Ok(pending) => Some(pending),
                Err(groups::Error::NotReady) => None,
                Err(error) => return Err(error.into()),
            };
            Ok(LocalGroupStatus {
                accepted,
                participants,
                pending,
            })
        })
        .await
    }
    async fn resume_group_inner(&self, room: &str) -> Result<groups::Receipt> {
        let room_owned = room.to_owned();
        let pending = self
            .owned(move |manager, root, _| {
                Ok(groups::Coordinator::new(manager, root)?.pending_lookup(&room_owned)?)
            })
            .await?;
        if pending.cancelling {
            return match self.cancel_group_inner(room, &pending.operation).await? {
                groups::GroupSettlement::Accepted(receipt) => Ok(receipt),
                groups::GroupSettlement::Cancelled(_) => Err(groups::Error::GroupCancelled.into()),
            };
        }
        let receipt = match self
            .client
            .crypto_group_operation(room, &pending.operation)
            .await
        {
            Ok(receipt) => receipt,
            Err(rv_client::Error::Server { status: 404, .. }) => {
                if pending.superseded {
                    return Err(groups::Error::Pending.into());
                }
                self.gate().await?;
                let room = room.to_owned();
                let submission = self
                    .owned(move |manager, root, now| {
                        Ok(groups::Coordinator::new(manager, root)?
                            .retry(&room, now)?
                            .to_wire()?)
                    })
                    .await?;
                self.current()?;
                self.network(
                    self.client
                        .submit_crypto_group(&pending.scope.room, &submission)
                        .await,
                )
                .await?
            }
            Err(rv_client::Error::Server {
                status: 409, code, ..
            }) if code == "crypto_group_cancelled" => {
                return match self.cancel_group_inner(room, &pending.operation).await? {
                    groups::GroupSettlement::Accepted(receipt) => Ok(receipt),
                    groups::GroupSettlement::Cancelled(_) => {
                        Err(groups::Error::GroupCancelled.into())
                    }
                };
            }
            Err(error) => return Err(error.into()),
        };
        let receipt = groups::Receipt::from_wire(&receipt)?;
        if receipt.scope != pending.scope
            || receipt.operation != pending.operation
            || receipt.fingerprint != pending.fingerprint
        {
            return Err(groups::Error::Receipt.into());
        }
        self.owned(move |manager, root, now| {
            groups::Coordinator::new(manager, root)?.confirm(&receipt, now)?;
            Ok(receipt)
        })
        .await
    }
    /// Checkpoint abandonment before HTTP. Accepted packets retain their MLS
    /// transition; a terminal cancellation alone releases the prepared commit.
    pub async fn cancel_group(
        &self,
        room: &str,
        operation: &str,
    ) -> Result<groups::GroupSettlement> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        self.cancel_group_inner(room, operation).await
    }
    async fn cancel_group_inner(
        &self,
        room: &str,
        operation: &str,
    ) -> Result<groups::GroupSettlement> {
        let owned_room = room.to_owned();
        let owned_operation = operation.to_owned();
        let request = self
            .owned(move |manager, root, now| {
                Ok(
                    groups::Coordinator::new(manager, root)?.request_group_cancellation(
                        &owned_room,
                        &owned_operation,
                        now,
                    )?,
                )
            })
            .await?;
        let groups::CancellationRequest::Original(original) = request else {
            let groups::CancellationRequest::Known(value) = request else {
                unreachable!()
            };
            return Ok(value);
        };
        let submission = original.to_wire()?;
        let decision = self
            .network(self.client.cancel_crypto_group(room, &submission).await)
            .await?;
        self.owned(move |manager, root, now| {
            let coordinator = groups::Coordinator::new(manager, root)?;
            let decision = groups::GroupSettlement::from_wire(&decision)?;
            match &decision {
                groups::GroupSettlement::Accepted(receipt) => coordinator.confirm(receipt, now)?,
                groups::GroupSettlement::Cancelled(receipt) => {
                    coordinator.confirm_group_cancellation(receipt, now)?
                }
            }
            Ok(decision)
        })
        .await
    }
    pub async fn publish_packages(
        &self,
        revision: String,
        count: usize,
    ) -> Result<http::OperationReceipt> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        self.gate().await?;
        self.owned(move |manager, root, now| {
            packages::Coordinator::new(manager, root)?.prepare(&revision, count, now)?;
            Ok(())
        })
        .await?;
        self.resume_packages_inner().await
    }
    pub async fn resume_packages(&self) -> Result<http::OperationReceipt> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        self.resume_packages_inner().await
    }
    async fn resume_packages_inner(&self) -> Result<http::OperationReceipt> {
        let pending = self
            .owned(|manager, root, _| {
                Ok(packages::Coordinator::new(manager, root)?.pending_lookup()?)
            })
            .await?;
        let receipt = match self.client.crypto_operation(&pending.operation_id).await {
            Ok(receipt) => receipt,
            Err(rv_client::Error::Server { status: 404, .. }) => {
                self.gate().await?;
                let request = self
                    .owned(|manager, root, now| {
                        Ok(packages::Coordinator::new(manager, root)?.retry(now)?)
                    })
                    .await?;
                self.current()?;
                self.network(self.client.publish_key_packages(&request).await)
                    .await?
            }
            Err(error) => return Err(error.into()),
        };
        self.owned(move |manager, root, now| {
            packages::Coordinator::new(manager, root)?.confirm(&receipt, now)?;
            Ok(receipt)
        })
        .await
    }
    async fn message_observation(&self, room: &str) -> Result<groups::MessageObservation> {
        let roster = self.client.crypto_group_roster(room).await?;
        self.current()?;
        let state = self.client.crypto_group_state(room).await?;
        self.current()?;
        let room = room.to_owned();
        self.owned(move |manager, _, _| {
            let observation = groups::MessageObservation::from_wire(&roster, &state)?;
            if observation.head.scope.room != room
                || observation.head.scope.instance != manager.scope().instance
                || observation.head.scope.data_epoch != manager.scope().data_epoch
            {
                return Err(Error::Scope);
            }
            Ok(observation)
        })
        .await
    }
    /// Prepare and checkpoint the original private ratchet/body before HTTP.
    /// Persist the operation ID in the app outbox; on restart use resume_message.
    pub async fn send_message(
        &self,
        room: &str,
        message: rv_protocol::SendMessage,
    ) -> Result<rv_crypto_public::messages::Receipt> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        self.gate().await?;
        let observation = self.message_observation(room).await?;
        let operation = message.operation_id.clone();
        self.owned(move |manager, root, now| {
            groups::Coordinator::new(manager, root)?.prepare_message(
                &observation,
                &message,
                now,
            )?;
            Ok(())
        })
        .await?;
        self.resume_message_inner(&operation).await
    }
    /// Look up a historical own receipt before any current-state validation or
    /// POST, including after withdrawal, rekey, certificate expiry or cooldown.
    pub async fn resume_message(
        &self,
        operation: &str,
    ) -> Result<rv_crypto_public::messages::Receipt> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        self.resume_message_inner(operation).await
    }
    async fn resume_message_inner(
        &self,
        operation: &str,
    ) -> Result<rv_crypto_public::messages::Receipt> {
        let id = operation.to_owned();
        let pending = self
            .owned(move |manager, root, _| {
                Ok(groups::Coordinator::new(manager, root)?.pending_message(&id)?)
            })
            .await?;
        let room = &pending.header.scope.room;
        if pending.cancelling {
            return match self.cancel_message_inner(operation).await? {
                groups::MessageSettlement::Accepted(receipt) => Ok(receipt),
                groups::MessageSettlement::Cancelled(_) => {
                    Err(groups::Error::MessageCancelled.into())
                }
            };
        }
        let receipt = match self.client.crypto_message_operation(room, operation).await {
            Ok(receipt) => receipt,
            Err(rv_client::Error::Server {
                status: 409,
                ref code,
                ..
            }) if code == "crypto_message_cancelled" => {
                return match self.cancel_message_inner(operation).await? {
                    groups::MessageSettlement::Accepted(receipt) => Ok(receipt),
                    groups::MessageSettlement::Cancelled(_) => {
                        Err(groups::Error::MessageCancelled.into())
                    }
                };
            }
            Err(rv_client::Error::Server { status: 404, .. }) => {
                self.gate().await?;
                let observation = self.message_observation(room).await?;
                let id = operation.to_owned();
                let submission = self
                    .owned(move |manager, root, now| {
                        Ok(groups::Coordinator::new(manager, root)?
                            .retry_message(&observation, &id, now)?
                            .to_wire()?)
                    })
                    .await?;
                self.current()?;
                self.network(self.client.submit_crypto_message(room, &submission).await)
                    .await?
            }
            Err(error) => return Err(error.into()),
        };
        let receipt = groups::wire::message_receipt(&receipt)?;
        if receipt.header != pending.header || receipt.fingerprint != pending.fingerprint {
            return Err(groups::Error::Receipt.into());
        }
        self.owned(move |manager, root, now| {
            groups::Coordinator::new(manager, root)?.confirm_message(&receipt, now)?;
            Ok(receipt)
        })
        .await
    }
    /// Explicitly abandon an unresolved original intention. A server-side
    /// acceptance wins the race; otherwise its tombstone fences all late POSTs.
    /// The private document remains recoverable until separately released.
    pub async fn cancel_message(&self, operation: &str) -> Result<groups::MessageSettlement> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        self.cancel_message_inner(operation).await
    }
    async fn cancel_message_inner(&self, operation: &str) -> Result<groups::MessageSettlement> {
        let id = operation.to_owned();
        let submission = self
            .owned(move |manager, root, now| {
                Ok(groups::Coordinator::new(manager, root)?
                    .request_cancellation(&id, now)?
                    .to_wire()?)
            })
            .await?;
        let proof = groups::MessageSubmission::from_wire(&submission)?;
        let room = rv_crypto_public::messages::Proof::from_bytes(&proof.proof)
            .map_err(groups::Error::from)?
            .header
            .scope
            .room;
        let settlement = self
            .network(self.client.cancel_crypto_message(&room, &submission).await)
            .await?;
        self.owned(move |manager, root, now| {
            let coordinator = groups::Coordinator::new(manager, root)?;
            let proof = rv_crypto_public::messages::Proof::from_bytes(&proof.proof)
                .map_err(groups::Error::from)?;
            match settlement {
                http::ApplicationSettlement::Accepted(value) => {
                    let receipt = groups::wire::message_receipt(&value)?;
                    receipt.matches(&proof).map_err(groups::Error::from)?;
                    coordinator.confirm_message(&receipt, now)?;
                    Ok(groups::MessageSettlement::Accepted(receipt))
                }
                http::ApplicationSettlement::Cancelled(value) => {
                    let receipt = groups::wire::message_cancellation(&value)?;
                    receipt.matches(&proof)?;
                    coordinator.confirm_cancellation(&receipt, now)?;
                    Ok(groups::MessageSettlement::Cancelled(receipt))
                }
            }
        })
        .await
    }
    /// Receive one frame against the exact current accepted head. This is not
    /// an ordered journal checkpoint: adapters must not advance a page cursor
    /// from this result, and missed historical epochs require catchup support.
    pub async fn receive_message(
        &self,
        message: http::ApplicationMessage,
    ) -> Result<groups::ClearMessage> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        let observation = self.message_observation(&message.receipt.room_id).await?;
        self.owned(move |manager, root, now| {
            let (submission, receipt) = groups::MessageSubmission::from_delivered(&message)?;
            Ok(groups::Coordinator::new(manager, root)?.receive_message(
                &observation,
                &submission,
                &receipt,
                now,
            )?)
        })
        .await
    }
    /// Fetch exactly the next protected prefix. A page, all MLS changes and all
    /// clear messages commit together; a failed/abandoned HTTP read advances
    /// nothing. Call again while complete=false to finish the fixed window.
    pub async fn journal_page(&self, room: &str) -> Result<groups::JournalBatch> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        let owned_room = room.to_owned();
        let request = self
            .owned(move |manager, root, _| {
                Ok(groups::Coordinator::new(manager, root)?.journal_request(&owned_room)?)
            })
            .await?;
        let end = request.through.map(|value| value.to_string());
        let page = self
            .client
            .crypto_delivery(room, &request.after.to_string(), end.as_deref())
            .await?;
        self.current()?;
        // Re-observe the reader's current grant after receiving the ciphertext.
        // Each historical epoch still requires the exact same admission.
        let roster = self.client.crypto_group_roster(room).await?;
        self.current()?;
        let state = self.client.crypto_group_state(room).await?;
        self.current()?;
        self.owned(move |manager, root, now| {
            let observation = groups::JournalObservation::from_wire(&roster, &state)?;
            if observation.current.head.scope != request.scope || page.room_id != request.scope.room
            {
                return Err(Error::Scope);
            }
            Ok(groups::Coordinator::new(manager, root)?.receive_journal(
                &observation,
                &page,
                now,
            )?)
        })
        .await
    }
    /// Recover a protected page whose result was lost before app projection.
    pub async fn journal_last_batch(&self, room: &str) -> Result<groups::JournalBatch> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        let roster = self.client.crypto_group_roster(room).await?;
        self.current()?;
        let state = self.client.crypto_group_state(room).await?;
        self.current()?;
        let room = room.to_owned();
        self.owned(move |manager, root, now| {
            let observation = groups::JournalObservation::from_wire(&roster, &state)?;
            if observation.current.head.scope.room != room
                || observation.current.head.scope.instance != manager.scope().instance
                || observation.current.head.scope.data_epoch != manager.scope().data_epoch
            {
                return Err(Error::Scope);
            }
            Ok(groups::Coordinator::new(manager, root)?.journal_last_batch(&observation, now)?)
        })
        .await
    }
    pub async fn events(&self, room: &str) -> Result<Batch> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        let remote = self.client.crypto_group_state(room).await?;
        let head = groups::Receipt::from_state(&remote)?;
        if head.scope.room != room
            || head.scope.instance != self.manager.scope().instance
            || head.scope.data_epoch != self.manager.scope().data_epoch
        {
            return Err(Error::Scope);
        }
        let room = room.to_owned();
        let local = self
            .owned(move |manager, root, _| {
                match groups::Coordinator::new(manager, root)?.accepted_receipt(&room) {
                    Ok(receipt) => Ok(Some(receipt)),
                    Err(groups::Error::NotReady) => Ok(None),
                    Err(error) => Err(error.into()),
                }
            })
            .await?;
        if local.as_ref().is_some_and(|local| {
            local.scope != head.scope
                || local.revision > head.revision
                || local.revision == head.revision && local != &head
        }) {
            return Err(Error::Scope);
        }
        let after = local.as_ref().map_or(0, |receipt| receipt.revision);
        let page = self
            .client
            .crypto_group_events(&head.scope.room, &after.to_string())
            .await?;
        let scope = head.scope.clone();
        self.owned(move |_, _, _| {
            groups::wire::validate_page(&page, &scope, after)?;
            Ok(Batch { head, page })
        })
        .await
    }
    pub async fn preview_event(&self, event: http::GroupEvent) -> Result<EventPreview> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        let roster = self
            .client
            .crypto_group_roster(&event.receipt.room_id)
            .await?;
        self.owned(move |manager, root, now| {
            let coordinator = groups::Coordinator::new(manager, root)?;
            let (kind, preview, consent) = if event.welcome.is_some() {
                let admission = groups::Admission::from_wire(&roster, &event)?;
                match coordinator.preview_admission(&admission, now) {
                    Ok((preview, consent)) => (EventKind::Admission, preview, consent),
                    Err(groups::Error::Exists) => {
                        let (preview, consent) =
                            coordinator.preview_readmission(&admission, now)?;
                        (EventKind::Readmission, preview, consent)
                    }
                    Err(error) => return Err(error.into()),
                }
            } else {
                let (preview, consent) = coordinator
                    .preview_commit(&groups::Commit::from_wire(&roster, &event)?, now)?;
                (EventKind::Commit, preview, consent)
            };
            Ok(EventPreview {
                preview,
                kind,
                event,
                consent,
            })
        })
        .await
    }
    pub async fn accept_event(
        &self,
        preview: EventPreview,
        confirmed: [u8; 32],
    ) -> Result<groups::Receipt> {
        let _dispatch = self.dispatch.lock().await;
        self.scope().await?;
        let roster = self
            .client
            .crypto_group_roster(&preview.event.receipt.room_id)
            .await?;
        self.owned(move |manager, root, now| {
            let coordinator = groups::Coordinator::new(manager, root)?;
            if preview.kind == EventKind::Readmission {
                coordinator.accept_readmission(
                    &groups::Admission::from_wire(&roster, &preview.event)?,
                    &preview.consent,
                    confirmed,
                    now,
                )?;
            } else if preview.event.welcome.is_some() {
                coordinator.accept_admission(
                    &groups::Admission::from_wire(&roster, &preview.event)?,
                    &preview.consent,
                    confirmed,
                    now,
                )?;
            } else {
                coordinator.accept_commit(
                    &groups::Commit::from_wire(&roster, &preview.event)?,
                    &preview.consent,
                    confirmed,
                    now,
                )?;
            }
            Ok(groups::Receipt::from_wire(&preview.event.receipt)?)
        })
        .await
    }
}
