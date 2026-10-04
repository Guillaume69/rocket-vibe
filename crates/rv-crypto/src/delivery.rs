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
    event: http::GroupEvent,
    consent: groups::Consent,
}
/// Public, validated page envelope. Each event still needs its own protected
/// preview/consent/accept; a page or head cannot grant admission or trust.
pub struct Batch {
    pub head: groups::Receipt,
    pub page: http::GroupEventPage,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cooldown {
    version: u8,
    observed: u64,
    until: u64,
}
const COOLDOWN: &str = "crypto-http-cooldown-v1";

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
            clock,
        })
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
        let clock = self.clock;
        let value = tokio::task::spawn_blocking(move || {
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
    async fn resume_group_inner(&self, room: &str) -> Result<groups::Receipt> {
        let room_owned = room.to_owned();
        let pending = self
            .owned(move |manager, root, _| {
                Ok(groups::Coordinator::new(manager, root)?.pending_lookup(&room_owned)?)
            })
            .await?;
        let receipt = match self
            .client
            .crypto_group_operation(room, &pending.operation)
            .await
        {
            Ok(receipt) => receipt,
            Err(rv_client::Error::Server { status: 404, .. }) => {
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
            let (preview, consent) = if event.welcome.is_some() {
                coordinator
                    .preview_admission(&groups::Admission::from_wire(&roster, &event)?, now)?
            } else {
                coordinator.preview_commit(&groups::Commit::from_wire(&roster, &event)?, now)?
            };
            Ok(EventPreview {
                preview,
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
            if preview.event.welcome.is_some() {
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
