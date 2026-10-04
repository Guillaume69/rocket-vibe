//! Identity and device ceremonies in the existing account/settings lifecycle.
//! Only public association codes leave owned protected transactions.
use super::{Context, Error, Result};
use crate::native::{NativeSession, security::Guard};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use rv_crypto::{
    delivery::Lifecycle as _,
    identity::{
        Issuer, Root,
        enrollment::{Grant, IssuanceConsent, LocalDevice, Request},
    },
    installation::{Account, Installation},
    protected::{Manager, Storage},
    vault::{self, Records},
};
use rv_protocol::e2ee as http;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

const RECORD: &str = "crypto-enrollment-ui-v1";
pub mod peers;
const LIFETIME: u64 = 86400 * 30;
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
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u8,
    root: Root,
    controller: bool,
    request: Option<Request>,
    registration: Option<http::RegisterDevice>,
    receipt: Option<http::OperationReceipt>,
    #[serde(default)]
    withdrawn: bool,
}
fn read(records: &Records, manager: &Manager) -> std::result::Result<Option<State>, vault::Error> {
    let Some(bytes) = records.get(RECORD) else { return Ok(None) };
    if bytes.len() > 32768 {
        return Err(vault::Error::Limit);
    }
    let value: State = serde_json::from_slice(bytes).map_err(|_| vault::Error::Integrity)?;
    if value.version != 1
        || value.root.instance != manager.scope().instance
        || value.root.user != manager.scope().user
        || value.root.validate().is_err()
        || (value.registration.is_some() && value.receipt.is_some())
    {
        return Err(vault::Error::Integrity);
    }
    Ok(Some(value))
}
fn save(records: &mut Records, value: &State) -> std::result::Result<(), vault::Error> {
    let bytes = serde_json::to_vec(value).map_err(|_| vault::Error::Integrity)?;
    if bytes.len() > 32768 {
        return Err(vault::Error::Limit);
    }
    records.insert(RECORD.into(), bytes);
    Ok(())
}
fn private<T>(value: std::result::Result<T, rv_crypto::identity::Error>) -> std::result::Result<T, vault::Error> {
    value.map_err(|_| vault::Error::Rejected)
}
fn registered(manager: &Manager, state: &State, directory: &http::Directory, time: u64) -> Result<()> {
    let receipt = state.receipt.as_ref().ok_or_else(changed)?;
    if state.withdrawn
        || directory.identity.as_ref().map(|i| i.fingerprint.as_str()) != Some(hex(&state.root.fingerprint()?).as_str())
    {
        return Err(changed());
    }
    for item in &directory.revocations {
        let revocation: rv_crypto::identity::Revocation =
            serde_json::from_slice(&decode(&item.signed, 4096)?).map_err(|_| changed())?;
        revocation.verify()?;
        if revocation.root == state.root
            && revocation.device == manager.scope().device
            && hex(&revocation.incarnation) == manager.scope().incarnation
        {
            // Keep a withdrawal learned from a valid root signature even if a
            // later directory omits it or still advertises the revoked leaf.
            manager.transact(|_, records| {
                let mut current = read(records, manager)?.ok_or(vault::Error::NotInitialized)?;
                current.withdrawn = true;
                save(records, &current)
            })?;
            return Err(changed());
        }
    }
    let device = directory.devices.iter().find(|d| d.device_id == manager.scope().device).ok_or_else(changed)?;
    let certificate: rv_crypto::identity::Certificate =
        serde_json::from_slice(&decode(&device.certificate, 4096)?).map_err(|_| changed())?;
    certificate.verify(time)?;
    if certificate.device.root != state.root
        || certificate.device.device != manager.scope().device
        || hex(&certificate.device.incarnation) != manager.scope().incarnation
        || device.incarnation != manager.scope().incarnation
        || device.revision != receipt.device_revision
    {
        return Err(changed());
    }
    manager.inspect(|_, records| {
        let local = private(LocalDevice::load(&state.root, &manager.scope().device, records))?;
        if local.public_key() != certificate.device.signature_key {
            return Err(vault::Error::Integrity);
        }
        private(local.credential(time)).map(|_| ())
    })?;
    Ok(())
}
fn incarnation(manager: &Manager) -> std::result::Result<[u8; 16], vault::Error> {
    let mut value = [0; 16];
    let encoded = &manager.scope().incarnation;
    if encoded.len() != 32 {
        return Err(vault::Error::Scope);
    }
    for (i, slot) in value.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&encoded[2 * i..2 * i + 2], 16).map_err(|_| vault::Error::Scope)?;
    }
    Ok(value)
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Missing,
    IdentityCreated,
    WaitingForApproval,
    Registering,
    Ready,
}
pub struct View {
    pub stage: Stage,
    pub root_fingerprint: String,
    pub request_fingerprint: String,
    pub request_code: String,
    pub controls_root: bool,
    pub remote_fingerprint: String,
}
pub struct Approval {
    pub root_fingerprint: String,
    pub request_fingerprint: String,
    pub device: String,
    pub expires_at: u64,
    context: Arc<Context>,
    request: Request,
    consent: IssuanceConsent,
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
        } else if !directory.devices.is_empty()
            || !directory.revocations.is_empty()
            || directory.next_revocation.is_some()
        {
            return Err(changed());
        }
        Ok(directory)
    }
    pub async fn refresh(&self) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        let directory = self.observe().await?;
        self.view(directory).await
    }
    pub(super) async fn prepared(&self) -> Result<(Arc<Manager>, Root)> {
        let directory = self.observe().await?;
        self.owned(move |slot, time| {
            let manager = slot.load()?.ok_or_else(changed)?;
            let state = manager.inspect(|_, records| read(records, &manager))?.ok_or_else(changed)?;
            registered(&manager, &state, &directory, time)?;
            Ok((manager, state.root))
        })
        .await
    }
    /// Attach the exact already registered installation. Positive absence,
    /// incomplete registration or changed directory never initializes a replacement.
    pub async fn conversation(&self) -> Result<super::Access> {
        let _dispatch = self.0.dispatch.lock().await;
        let (manager, root) = self.prepared().await?;
        self.check()?;
        let session = self.0.context.session.upgrade().ok_or_else(changed)?;
        let access = session.crypto(self.0.context.guard.clone(), manager, root).await?;
        self.check()?;
        Ok(access)
    }
    async fn view(&self, directory: http::Directory) -> Result<View> {
        self.owned(move |slot, time| {
            let mut selected = None;
            let state = match slot.load()? {
                Some(manager) => match manager.inspect(|_, records| read(records, &manager)) {
                    Ok(state) => {
                        selected = Some(manager);
                        state
                    }
                    Err(vault::Error::NotInitialized) => None,
                    Err(error) => return Err(error.into()),
                },
                None => None,
            };
            let remote_fingerprint = directory.identity.as_ref().map(|i| i.fingerprint.clone()).unwrap_or_default();
            let Some(state) = state else {
                return Ok(View {
                    stage: Stage::Missing,
                    root_fingerprint: String::new(),
                    request_fingerprint: String::new(),
                    request_code: String::new(),
                    controls_root: false,
                    remote_fingerprint,
                });
            };
            let root_fingerprint = hex(&state.root.fingerprint()?);
            if !remote_fingerprint.is_empty() && remote_fingerprint != root_fingerprint {
                return Err(changed());
            }
            if state.receipt.is_some() {
                let manager = selected.as_ref().ok_or_else(changed)?;
                registered(manager, &state, &directory, time)?;
            }
            let (request_fingerprint, request_code) = state
                .request
                .as_ref()
                .map(|r| -> Result<_> { Ok((hex(&r.fingerprint()?), B64.encode(r.to_bytes()?))) })
                .transpose()?
                .unwrap_or_default();
            Ok(View {
                stage: if state.receipt.is_some() {
                    Stage::Ready
                } else if state.registration.is_some() {
                    Stage::Registering
                } else if state.controller {
                    Stage::IdentityCreated
                } else {
                    Stage::WaitingForApproval
                },
                root_fingerprint,
                request_fingerprint,
                request_code,
                controls_root: state.controller,
                remote_fingerprint,
            })
        })
        .await
    }
    /// A positive explicit action. Existing server identity must be compared and
    /// acknowledged by fingerprint; no fresh root replaces it.
    pub async fn begin(&self, expected_fingerprint: String) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        let directory = self.observe().await?;
        let root = directory
            .identity
            .as_ref()
            .map(|identity| {
                if expected_fingerprint != identity.fingerprint {
                    return Err(changed());
                }
                serde_json::from_slice::<Root>(&decode(&identity.root, 4096)?).map_err(|_| changed())
            })
            .transpose()?;
        if root.is_none() && !expected_fingerprint.is_empty() {
            return Err(changed());
        }
        self.owned(move |slot, time| {
            let manager = slot.initialize()?;
            manager.transact(|_, records| {
                let mut state = match read(records, &manager)? {
                    Some(value) => value,
                    None => {
                        let controller = root.is_none();
                        let root = if let Some(root) = &root {
                            root.clone()
                        } else {
                            let issuer = private(Issuer::generate(&manager.scope().instance, &manager.scope().user))?;
                            private(issuer.save(records))?;
                            issuer.root().clone()
                        };
                        private(LocalDevice::create_bound(
                            &root,
                            &manager.scope().device,
                            incarnation(&manager)?,
                            records,
                        ))?;
                        State {
                            version: 1,
                            root,
                            controller,
                            request: None,
                            registration: None,
                            receipt: None,
                            withdrawn: false,
                        }
                    }
                };
                if root.as_ref().is_some_and(|root| *root != state.root) {
                    return Err(vault::Error::Rejected);
                }
                if state.registration.is_none() && state.receipt.is_none() {
                    let mut local = private(LocalDevice::load(&state.root, &manager.scope().device, records))?;
                    state.request = Some(private(local.request(time, records))?);
                    save(records, &state)?;
                }
                Ok(())
            })?;
            Ok(())
        })
        .await?;
        self.view(directory).await
    }
    pub async fn preview(&self, code: String) -> Result<Approval> {
        let _dispatch = self.0.dispatch.lock().await;
        let directory = self.observe().await?;
        let request = Request::from_bytes(&decode(&code, 4096)?)?;
        let context = self.0.context.clone();
        self.owned(move |slot, time| {
            request.verify(time)?;
            let manager = slot.load()?.ok_or(vault::Error::NotInitialized)?;
            manager
                .inspect(|_, records| {
                    let state = read(records, &manager)?.ok_or(vault::Error::NotInitialized)?;
                    let requested_fingerprint = hex(&private(request.body.root.fingerprint())?);
                    if directory.identity.as_ref().is_some_and(|i| i.fingerprint != requested_fingerprint)
                        || !state.controller
                        || state.root != request.body.root
                    {
                        return Err(vault::Error::Rejected);
                    }
                    let issuer = private(Issuer::load(records, &manager.scope().instance, &manager.scope().user))?;
                    let consent = private(issuer.preview_request(&request, time, LIFETIME, records))?;
                    Ok(Approval {
                        root_fingerprint: hex(&private(request.body.root.fingerprint())?),
                        request_fingerprint: hex(&private(request.fingerprint())?),
                        device: request.body.device.clone(),
                        expires_at: request.body.expires_at,
                        context,
                        request,
                        consent,
                    })
                })
                .map_err(Error::from)
        })
        .await
    }
    /// Human approval of the exact displayed proof. Public grant only; this
    /// cannot register a remote HTTP device or automatically trust room peers.
    pub async fn approve(&self, preview: Approval) -> Result<String> {
        let _dispatch = self.0.dispatch.lock().await;
        let directory = self.observe().await?;
        if directory.identity.as_ref().is_some_and(|i| i.fingerprint != preview.root_fingerprint) {
            return Err(changed());
        }
        if !Arc::ptr_eq(&preview.context, &self.0.context) {
            return Err(changed());
        }
        self.owned(move |slot, time| {
            let manager = slot.load()?.ok_or(vault::Error::NotInitialized)?;
            let grant = manager.transact(|_, records| {
                let issuer = private(Issuer::load(records, &manager.scope().instance, &manager.scope().user))?;
                private(issuer.approve_request(&preview.request, &preview.consent, time, records))
            })?;
            Ok(B64.encode(grant.to_bytes()?))
        })
        .await
    }
    pub async fn install(&self, code: String) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        let directory = self.observe().await?;
        let grant = Grant::from_bytes(&decode(&code, 8192)?)?;
        self.owned(move |slot, time| {
            let manager = slot.load()?.ok_or(vault::Error::NotInitialized)?;
            manager.transact(|_, records| {
                let mut state = read(records, &manager)?.ok_or(vault::Error::NotInitialized)?;
                if state.registration.is_some() || state.receipt.is_some() {
                    return Err(vault::Error::Rejected);
                }
                let request = state.request.as_ref().ok_or(vault::Error::Rejected)?;
                let fingerprint = hex(&private(state.root.fingerprint())?);
                if directory.identity.as_ref().is_some_and(|i| i.fingerprint != fingerprint) {
                    return Err(vault::Error::Rejected);
                }
                let previous = directory.devices.iter().find(|d| d.device_id == manager.scope().device);
                // Incarnation replacement requires its own revocation ceremony.
                if previous.is_some_and(|d| d.incarnation != manager.scope().incarnation) {
                    return Err(vault::Error::Rejected);
                }
                let mut local = private(LocalDevice::load(&state.root, &manager.scope().device, records))?;
                private(local.install(&grant, time, records))?;
                state.registration = Some(http::RegisterDevice {
                    scope: http::Scope {
                        instance_id: manager.scope().instance.clone(),
                        data_epoch: manager.scope().data_epoch.clone(),
                    },
                    operation_id: format!("enroll-{}", hex(&private(request.fingerprint())?)),
                    expected_root_fingerprint: directory.identity.map(|i| i.fingerprint),
                    expected_device_revision: previous.map(|d| d.revision.clone()),
                    request: B64.encode(private(request.to_bytes())?),
                    grant: B64.encode(private(grant.to_bytes())?),
                    revoke_previous: None,
                });
                save(records, &state)
            })?;
            Ok(())
        })
        .await?;
        self.resume_inner().await
    }
    pub async fn resume(&self) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        self.resume_inner().await
    }
    async fn resume_inner(&self) -> Result<View> {
        self.observe().await?;
        let request = self
            .owned(|slot, _| {
                let manager = slot.load()?.ok_or(vault::Error::NotInitialized)?;
                manager
                    .inspect(|_, records| {
                        read(records, &manager)?.and_then(|s| s.registration).ok_or(vault::Error::NotInitialized)
                    })
                    .map_err(Error::from)
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
        let expected_revision = request
            .expected_device_revision
            .as_ref()
            .map(|r| r.parse::<i64>())
            .transpose()
            .map_err(|_| changed())?
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(changed)?
            .to_string();
        let grant = Grant::from_bytes(&decode(&request.grant, 8192)?)?;
        if receipt.scope.instance_id != request.scope.instance_id
            || receipt.scope.data_epoch != request.scope.data_epoch
            || receipt.operation_id != request.operation_id
            || receipt.kind != "register_device"
            || receipt.device_id != self.0.account.device
            || receipt.incarnation != hex(&grant.certificate.device.incarnation)
            || receipt.root_fingerprint != hex(&grant.certificate.device.root.fingerprint()?)
            || receipt.device_revision != expected_revision
            || !receipt.key_package_refs.is_empty()
        {
            return Err(changed());
        }
        self.owned(move |slot, _| {
            let manager = slot.load()?.ok_or(vault::Error::NotInitialized)?;
            manager.transact(|_, records| {
                let mut state = read(records, &manager)?.ok_or(vault::Error::NotInitialized)?;
                let current = state.registration.as_ref().ok_or(vault::Error::Stale)?;
                if serde_json::to_vec(current).ok() != serde_json::to_vec(&request).ok() {
                    return Err(vault::Error::Stale);
                }
                state.registration = None;
                state.receipt = Some(receipt);
                state.request = None;
                save(records, &state)
            })?;
            Ok(())
        })
        .await?;
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
