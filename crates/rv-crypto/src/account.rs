//! Shared protected account/device ceremony. HTTP and UI generations belong to
//! the adapters; every local step validates signed public inputs again here.
use crate::{
    identity::{
        Certificate, Issuer, Revocation, Root,
        enrollment::{Grant, IssuanceConsent, LocalDevice, Request},
    },
    installation::Installation,
    protected::Manager,
    vault::{self, Records, Scope},
};
use data_encoding::{BASE64URL_NOPAD as B64, HEXLOWER};
use rv_protocol::e2ee as http;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};

const RECORD: &str = "crypto-enrollment-ui-v1";
pub mod history;
pub mod history_backup;
pub mod peers;
pub mod recovery;
mod renewal;
pub mod revocations;
use renewal::Renewal;
const LIFETIME: u64 = 86400 * 30;
#[cfg(test)]
mod testing;
#[derive(thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Storage(#[from] vault::Error),
    #[error(transparent)]
    Identity(#[from] crate::identity::Error),
    #[error(transparent)]
    History(#[from] crate::groups::Error),
    #[error("crypto_enrollment_changed")]
    Changed,
    #[error("crypto_device_withdrawn")]
    Withdrawn(Scope),
}
impl std::fmt::Debug for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, formatter)
    }
}
type Result<T> = std::result::Result<T, Error>;
fn hex(value: &[u8]) -> String {
    HEXLOWER.encode(value)
}
fn decode(value: &str, limit: usize) -> Result<Vec<u8>> {
    if value.len() > limit.div_ceil(3) * 4 {
        return Err(Error::Changed);
    }
    let bytes = B64.decode(value.as_bytes()).map_err(|_| Error::Changed)?;
    if bytes.len() > limit || B64.encode(&bytes) != value {
        return Err(Error::Changed);
    }
    Ok(bytes)
}
fn private<T>(
    value: std::result::Result<T, crate::identity::Error>,
) -> std::result::Result<T, vault::Error> {
    value.map_err(|_| vault::Error::Rejected)
}

/// Complete signed public directory. Its constructor validates every proof;
/// deserialization cannot create an already verified observation.
#[derive(Clone)]
pub struct Directory {
    wire: http::Directory,
    account: crate::installation::Account,
    user: String,
}
impl Directory {
    pub fn verify(slot: &Installation, user: &str, wire: http::Directory) -> Result<Self> {
        let account = slot.account();
        if user.is_empty()
            || user.len() > 256
            || wire.scope.instance_id != account.instance
            || wire.scope.data_epoch != account.data_epoch
            || wire.devices.len() > 64
            || wire.revocations.len() > 4096
            || wire.next_revocation.is_some()
        {
            return Err(Error::Changed);
        }
        let Some(identity) = &wire.identity else {
            if !wire.devices.is_empty() || !wire.revocations.is_empty() {
                return Err(Error::Changed);
            }
            return Ok(Self {
                wire,
                account: account.clone(),
                user: user.into(),
            });
        };
        let root: Root =
            serde_json::from_slice(&decode(&identity.root, 4096)?).map_err(|_| Error::Changed)?;
        root.validate()?;
        if root.instance != account.instance
            || root.user != user
            || identity.user_id != user
            || identity.fingerprint != hex(&root.fingerprint()?)
        {
            return Err(Error::Changed);
        }
        let mut seen = BTreeSet::new();
        for device in &wire.devices {
            let certificate: Certificate =
                serde_json::from_slice(&decode(&device.certificate, 4096)?)
                    .map_err(|_| Error::Changed)?;
            certificate.authenticate()?;
            if certificate.device.root != root
                || certificate.device.device != device.device_id
                || hex(&certificate.device.incarnation) != device.incarnation
                || !seen.insert(&device.device_id)
            {
                return Err(Error::Changed);
            }
        }
        let mut position = 0u64;
        for item in &wire.revocations {
            let next = item.position.parse::<u64>().map_err(|_| Error::Changed)?;
            let revocation: Revocation =
                serde_json::from_slice(&decode(&item.signed, 4096)?).map_err(|_| Error::Changed)?;
            revocation.verify()?;
            if next <= position || item.position != next.to_string() || revocation.root != root {
                return Err(Error::Changed);
            }
            position = next;
        }
        Ok(Self {
            wire,
            account: account.clone(),
            user: user.into(),
        })
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    renewal: Option<Renewal>,
    #[serde(default)]
    withdrawn: bool,
}
fn read(records: &Records, manager: &Manager) -> std::result::Result<Option<State>, vault::Error> {
    let Some(bytes) = records.get(RECORD) else {
        return Ok(None);
    };
    if bytes.len() > 32768 {
        return Err(vault::Error::Limit);
    }
    let state: State = serde_json::from_slice(bytes).map_err(|_| vault::Error::Integrity)?;
    if state.version != 1
        || state.root.instance != manager.scope().instance
        || state.root.user != manager.scope().user
        || state.root.validate().is_err()
        || state.registration.is_some() && state.receipt.is_some()
        || state.renewal.as_ref().is_some_and(|r| {
            !r.bound(manager, &state.root)
                || state.request.is_none()
                || state.receipt.is_none() && state.registration.is_none()
                || state.receipt.as_ref().is_some_and(|receipt| {
                    serde_json::to_vec(receipt).ok() != serde_json::to_vec(&r.receipt).ok()
                })
        })
    {
        return Err(vault::Error::Integrity);
    }
    Ok(Some(state))
}
fn save(records: &mut Records, state: &State) -> std::result::Result<(), vault::Error> {
    let bytes = serde_json::to_vec(state).map_err(|_| vault::Error::Integrity)?;
    if bytes.len() > 32768 {
        return Err(vault::Error::Limit);
    }
    records.insert(RECORD.into(), bytes);
    Ok(())
}
fn incarnation(manager: &Manager) -> std::result::Result<[u8; 16], vault::Error> {
    let bytes = HEXLOWER
        .decode(manager.scope().incarnation.as_bytes())
        .map_err(|_| vault::Error::Scope)?;
    let value: [u8; 16] = bytes.try_into().map_err(|_| vault::Error::Scope)?;
    if value == [0; 16] || hex(&value) != manager.scope().incarnation {
        return Err(vault::Error::Scope);
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
    Expired,
    Renewing,
}
pub struct View {
    pub stage: Stage,
    pub root_fingerprint: String,
    pub request_fingerprint: String,
    pub request_code: String,
    pub controls_root: bool,
    pub remote_fingerprint: String,
    pub certificate_expires_at: Option<u64>,
}
pub struct Approval {
    pub root_fingerprint: String,
    pub request_fingerprint: String,
    pub device: String,
    pub expires_at: u64,
    scope: Scope,
    request: Request,
    consent: IssuanceConsent,
}
pub struct Coordinator<'a>(&'a Installation);
impl<'a> Coordinator<'a> {
    pub fn new(slot: &'a Installation) -> Self {
        Self(slot)
    }
    pub fn directory(&self, wire: http::Directory) -> Result<Directory> {
        Directory::verify(self.0, &self.0.account().user, wire)
    }
    fn bind(&self, directory: &Directory) -> Result<()> {
        if &directory.account != self.0.account() || directory.user != self.0.account().user {
            return Err(Error::Changed);
        }
        Ok(())
    }
    fn state(&self) -> Result<(Arc<Manager>, State)> {
        let manager = self.0.load()?.ok_or(vault::Error::NotInitialized)?;
        let state = manager
            .inspect(|_, records| read(records, &manager))?
            .ok_or(vault::Error::NotInitialized)?;
        if state.withdrawn {
            return Err(Error::Withdrawn(manager.scope().clone()));
        }
        Ok((manager, state))
    }
    fn guard_state(&self, manager: &Manager, state: &State, directory: &Directory) -> Result<()> {
        if state.withdrawn {
            return Err(Error::Withdrawn(manager.scope().clone()));
        }
        if directory.wire.identity.as_ref().is_some_and(|i| {
            state
                .root
                .fingerprint()
                .map(|fp| i.fingerprint != hex(&fp))
                .unwrap_or(true)
        }) {
            return Err(Error::Changed);
        }
        if revocations::observe(manager, state, directory)? {
            return Err(Error::Withdrawn(manager.scope().clone()));
        }
        Ok(())
    }
    fn registered_certificate(
        &self,
        manager: &Manager,
        state: &State,
        directory: &Directory,
    ) -> Result<Certificate> {
        self.guard_state(manager, state, directory)?;
        let receipt = state.receipt.as_ref().ok_or(Error::Changed)?;
        if directory
            .wire
            .identity
            .as_ref()
            .map(|i| i.fingerprint.as_str())
            != Some(hex(&state.root.fingerprint()?).as_str())
        {
            return Err(Error::Changed);
        }
        let device = directory
            .wire
            .devices
            .iter()
            .find(|d| d.device_id == manager.scope().device)
            .ok_or(Error::Changed)?;
        let certificate: Certificate = serde_json::from_slice(&decode(&device.certificate, 4096)?)
            .map_err(|_| Error::Changed)?;
        certificate.authenticate()?;
        if certificate.device.root != state.root
            || certificate.device.device != manager.scope().device
            || hex(&certificate.device.incarnation) != manager.scope().incarnation
            || device.incarnation != manager.scope().incarnation
            || device.revision != receipt.device_revision
        {
            return Err(Error::Changed);
        }
        manager.inspect(|_, records| {
            let local = private(LocalDevice::load(
                &state.root,
                &manager.scope().device,
                records,
            ))?;
            if local.public_key() != certificate.device.signature_key {
                return Err(vault::Error::Integrity);
            }
            let credential = private(local.credential(certificate.device.issued_at))?;
            if private(Certificate::from_credential(&credential.credential))? != certificate {
                return Err(vault::Error::Integrity);
            }
            Ok(())
        })?;
        Ok(certificate)
    }
    fn registered(
        &self,
        manager: &Manager,
        state: &State,
        directory: &Directory,
        time: u64,
    ) -> Result<()> {
        self.registered_certificate(manager, state, directory)?
            .verify(time)?;
        Ok(())
    }
    pub fn prepared(&self, directory: &Directory, time: u64) -> Result<(Arc<Manager>, Root)> {
        self.bind(directory)?;
        let (manager, state) = self.state()?;
        self.registered(&manager, &state, directory, time)?;
        Ok((manager, state.root))
    }
    pub fn device_revision(&self) -> Result<String> {
        self.state()?
            .1
            .receipt
            .ok_or(Error::Changed)
            .map(|r| r.device_revision)
    }
    pub fn view(&self, directory: &Directory, time: u64) -> Result<View> {
        self.bind(directory)?;
        let mut selected = None;
        let state = match self.0.load()? {
            Some(manager) => match manager.inspect(|_, records| read(records, &manager)) {
                Ok(value) => {
                    selected = Some(manager);
                    value
                }
                Err(vault::Error::NotInitialized) => None,
                Err(error) => return Err(error.into()),
            },
            None => None,
        };
        let remote_fingerprint = directory
            .wire
            .identity
            .as_ref()
            .map(|i| i.fingerprint.clone())
            .unwrap_or_default();
        let Some(state) = state else {
            return Ok(View {
                stage: Stage::Missing,
                root_fingerprint: String::new(),
                request_fingerprint: String::new(),
                request_code: String::new(),
                controls_root: false,
                remote_fingerprint,
                certificate_expires_at: None,
            });
        };
        self.guard_state(selected.as_ref().ok_or(Error::Changed)?, &state, directory)?;
        let root_fingerprint = hex(&state.root.fingerprint()?);
        if !remote_fingerprint.is_empty() && remote_fingerprint != root_fingerprint {
            return Err(Error::Changed);
        }
        let certificate = if state.receipt.is_some() {
            Some(self.registered_certificate(
                selected.as_ref().ok_or(Error::Changed)?,
                &state,
                directory,
            )?)
        } else {
            state.renewal.as_ref().map(|r| r.certificate.clone())
        };
        let expired = if let Some(certificate) = &certificate {
            match certificate.verify(time) {
                Ok(()) => false,
                Err(crate::identity::Error::Expired) if time >= certificate.device.expires_at => {
                    true
                }
                Err(error) => return Err(error.into()),
            }
        } else {
            false
        };
        let (request_fingerprint, request_code) = state
            .request
            .as_ref()
            .map(|r| -> Result<_> { Ok((hex(&r.fingerprint()?), B64.encode(&r.to_bytes()?))) })
            .transpose()?
            .unwrap_or_default();
        Ok(View {
            stage: if state.registration.is_some() {
                Stage::Registering
            } else if state.renewal.is_some() {
                Stage::Renewing
            } else if state.receipt.is_some() {
                if expired {
                    Stage::Expired
                } else {
                    Stage::Ready
                }
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
            certificate_expires_at: certificate.map(|c| c.device.expires_at),
        })
    }
    pub fn begin(
        &self,
        directory: &Directory,
        expected_fingerprint: &str,
        time: u64,
    ) -> Result<()> {
        self.bind(directory)?;
        self.view(directory, time)?;
        let root = directory
            .wire
            .identity
            .as_ref()
            .map(|identity| -> Result<Root> {
                if expected_fingerprint != identity.fingerprint {
                    return Err(Error::Changed);
                }
                serde_json::from_slice(&decode(&identity.root, 4096)?).map_err(|_| Error::Changed)
            })
            .transpose()?;
        if root.is_none() && !expected_fingerprint.is_empty() {
            return Err(Error::Changed);
        }
        let manager = self.0.initialize()?;
        manager.transact(|_, records| {
            let mut state = match read(records, &manager)? {
                Some(value) => value,
                None => {
                    let controller = root.is_none();
                    let root = if let Some(root) = &root {
                        root.clone()
                    } else {
                        let issuer = private(Issuer::generate(
                            &manager.scope().instance,
                            &manager.scope().user,
                        ))?;
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
                        renewal: None,
                        withdrawn: false,
                    }
                }
            };
            if state.withdrawn || root.as_ref().is_some_and(|r| *r != state.root) {
                return Err(vault::Error::Rejected);
            }
            if state.registration.is_none() && state.receipt.is_none() {
                let mut local = private(LocalDevice::load(
                    &state.root,
                    &manager.scope().device,
                    records,
                ))?;
                state.request = Some(private(local.request(time, records))?);
                save(records, &state)?;
            }
            Ok(())
        })?;
        Ok(())
    }
    pub fn preview(&self, directory: &Directory, code: &str, time: u64) -> Result<Approval> {
        self.bind(directory)?;
        let request = Request::from_bytes(&decode(code, 4096)?)?;
        request.verify(time)?;
        let (manager, state) = self.state()?;
        self.guard_state(&manager, &state, directory)?;
        manager
            .inspect(|_, records| {
                let requested = hex(&private(request.body.root.fingerprint())?);
                if directory
                    .wire
                    .identity
                    .as_ref()
                    .is_some_and(|i| i.fingerprint != requested)
                    || !state.controller
                    || state.root != request.body.root
                {
                    return Err(vault::Error::Rejected);
                }
                let issuer = private(Issuer::load(
                    records,
                    &manager.scope().instance,
                    &manager.scope().user,
                ))?;
                let consent = private(issuer.preview_request(&request, time, LIFETIME, records))?;
                Ok(Approval {
                    root_fingerprint: requested,
                    request_fingerprint: hex(&private(request.fingerprint())?),
                    device: request.body.device.clone(),
                    expires_at: request.body.expires_at,
                    scope: manager.scope().clone(),
                    request,
                    consent,
                })
            })
            .map_err(Error::from)
    }
    pub fn approve(&self, directory: &Directory, preview: Approval, time: u64) -> Result<String> {
        self.bind(directory)?;
        if directory
            .wire
            .identity
            .as_ref()
            .is_some_and(|i| i.fingerprint != preview.root_fingerprint)
        {
            return Err(Error::Changed);
        }
        let (manager, state) = self.state()?;
        self.guard_state(&manager, &state, directory)?;
        if manager.scope() != &preview.scope
            || !state.controller
            || state.root != preview.request.body.root
        {
            return Err(Error::Changed);
        }
        let grant = manager.transact(|_, records| {
            let issuer = private(Issuer::load(
                records,
                &manager.scope().instance,
                &manager.scope().user,
            ))?;
            private(issuer.approve_request(&preview.request, &preview.consent, time, records))
        })?;
        Ok(B64.encode(&grant.to_bytes()?))
    }
    pub fn install(&self, directory: &Directory, code: &str, time: u64) -> Result<()> {
        self.bind(directory)?;
        let grant = Grant::from_bytes(&decode(code, 8192)?)?;
        let (manager, state) = self.state()?;
        self.guard_state(&manager, &state, directory)?;
        manager.transact(|_, records| {
            let mut state = read(records, &manager)?.ok_or(vault::Error::NotInitialized)?;
            if state.registration.is_some()
                || state.receipt.is_some() && state.renewal.is_none()
                || state.withdrawn
            {
                return Err(vault::Error::Rejected);
            }
            let request = state.request.as_ref().ok_or(vault::Error::Rejected)?;
            let fingerprint = hex(&private(state.root.fingerprint())?);
            if directory
                .wire
                .identity
                .as_ref()
                .is_some_and(|i| i.fingerprint != fingerprint)
            {
                return Err(vault::Error::Rejected);
            }
            let previous = directory
                .wire
                .devices
                .iter()
                .find(|d| d.device_id == manager.scope().device);
            if previous.is_some_and(|d| d.incarnation != manager.scope().incarnation) {
                return Err(vault::Error::Rejected);
            }
            if let Some(renewal) = &state.renewal {
                let previous = previous.ok_or(vault::Error::Rejected)?;
                let certificate: Certificate = serde_json::from_slice(
                    &decode(&previous.certificate, 4096).map_err(|_| vault::Error::Rejected)?,
                )
                .map_err(|_| vault::Error::Rejected)?;
                if previous.revision != renewal.receipt.device_revision
                    || certificate != renewal.certificate
                    || grant.certificate.device.issued_at <= certificate.device.issued_at
                    || grant.certificate.device.expires_at < certificate.device.expires_at
                {
                    return Err(vault::Error::Rejected);
                }
            }
            let mut local = private(LocalDevice::load(
                &state.root,
                &manager.scope().device,
                records,
            ))?;
            private(local.install(&grant, time, records))?;
            state.registration = Some(http::RegisterDevice {
                scope: http::Scope {
                    instance_id: manager.scope().instance.clone(),
                    data_epoch: manager.scope().data_epoch.clone(),
                },
                operation_id: format!("enroll-{}", hex(&private(request.fingerprint())?)),
                expected_root_fingerprint: directory
                    .wire
                    .identity
                    .as_ref()
                    .map(|i| i.fingerprint.clone()),
                expected_device_revision: previous.map(|d| d.revision.clone()),
                request: B64.encode(&private(request.to_bytes())?),
                grant: B64.encode(&private(grant.to_bytes())?),
                revoke_previous: None,
            });
            state.receipt = None;
            save(records, &state)
        })?;
        Ok(())
    }
    pub fn pending(&self) -> Result<http::RegisterDevice> {
        self.state()?.1.registration.ok_or(Error::Changed)
    }
    pub fn acknowledge(
        &self,
        request: &http::RegisterDevice,
        receipt: http::OperationReceipt,
    ) -> Result<()> {
        let (manager, _) = self.state()?;
        let expected_revision = request
            .expected_device_revision
            .as_ref()
            .map(|r| r.parse::<i64>())
            .transpose()
            .map_err(|_| Error::Changed)?
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(Error::Changed)?
            .to_string();
        let grant = Grant::from_bytes(&decode(&request.grant, 8192)?)?;
        if receipt.scope.instance_id != request.scope.instance_id
            || receipt.scope.data_epoch != request.scope.data_epoch
            || receipt.operation_id != request.operation_id
            || receipt.kind != "register_device"
            || receipt.device_id != manager.scope().device
            || receipt.incarnation != hex(&grant.certificate.device.incarnation)
            || receipt.root_fingerprint != hex(&grant.certificate.device.root.fingerprint()?)
            || receipt.device_revision != expected_revision
            || !receipt.key_package_refs.is_empty()
        {
            return Err(Error::Changed);
        }
        manager.transact(|_, records| {
            let mut state = read(records, &manager)?.ok_or(vault::Error::NotInitialized)?;
            let current = state.registration.as_ref().ok_or(vault::Error::Stale)?;
            if serde_json::to_vec(current).ok() != serde_json::to_vec(request).ok() {
                return Err(vault::Error::Stale);
            }
            state.registration = None;
            state.receipt = Some(receipt);
            state.request = None;
            state.renewal = None;
            save(records, &state)
        })?;
        Ok(())
    }
}
