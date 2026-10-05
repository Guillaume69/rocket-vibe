//! Explicit root-signed withdrawal and its protected original HTTP intention.
//! A locally confirmed withdrawal is permanent, including before its HTTP ACK.
use super::*;
use crate::identity::Pins;

const RECORD: &str = "crypto-account-withdrawals-v1";
const LIMIT: usize = 4 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    baseline: Renewal,
    target: http::Device,
    request: http::RevokeDevice,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Withdrawals {
    version: u8,
    scope: Scope,
    root: Root,
    learned: Vec<Revocation>,
    pending: Option<Pending>,
}
fn revision(value: &str) -> bool {
    value
        .parse::<i64>()
        .is_ok_and(|n| n > 0 && n.to_string() == value)
}
fn same<T: Serialize>(left: &T, right: &T) -> bool {
    serde_json::to_vec(left).ok() == serde_json::to_vec(right).ok()
}
fn signed(request: &http::RevokeDevice) -> Result<Revocation> {
    let proof: Revocation =
        serde_json::from_slice(&decode(&request.signed, 4096)?).map_err(|_| Error::Changed)?;
    proof.verify()?;
    Ok(proof)
}
fn certificate(device: &http::Device, root: &Root) -> Result<Certificate> {
    let c: Certificate =
        serde_json::from_slice(&decode(&device.certificate, 4096)?).map_err(|_| Error::Changed)?;
    c.authenticate()?;
    if &c.device.root != root
        || c.device.device != device.device_id
        || hex(&c.device.incarnation) != device.incarnation
        || c.device.expires_at.to_string() != device.expires_at
        || !revision(&device.revision)
    {
        return Err(Error::Changed);
    }
    Ok(c)
}
fn load(
    records: &Records,
    manager: &Manager,
    root: &Root,
) -> std::result::Result<Withdrawals, vault::Error> {
    let Some(bytes) = records.get(RECORD) else {
        return Ok(Withdrawals {
            version: 1,
            scope: manager.scope().clone(),
            root: root.clone(),
            learned: vec![],
            pending: None,
        });
    };
    if bytes.len() > LIMIT {
        return Err(vault::Error::Limit);
    }
    let state: Withdrawals = serde_json::from_slice(bytes).map_err(|_| vault::Error::Integrity)?;
    if state.version != 1
        || &state.scope != manager.scope()
        || &state.root != root
        || state.learned.len() > 4096
    {
        return Err(vault::Error::Integrity);
    }
    let mut subjects = BTreeSet::new();
    for proof in &state.learned {
        if &proof.root != root
            || proof.verify().is_err()
            || !subjects.insert((&proof.device, proof.incarnation))
        {
            return Err(vault::Error::Integrity);
        }
    }
    if let Some(pending) = &state.pending {
        let request = &pending.request;
        let proof = signed(request).map_err(|_| vault::Error::Integrity)?;
        certificate(&pending.target, root).map_err(|_| vault::Error::Integrity)?;
        if !pending.baseline.bound(manager, root)
            || request.scope.instance_id != manager.scope().instance
            || request.scope.data_epoch != manager.scope().data_epoch
            || request.incarnation != manager.scope().incarnation
            || request.device_revision != pending.baseline.receipt.device_revision
            || !request.operation_id.starts_with("withdraw-")
            || request.operation_id.len() != 73
            || request.operation_id[9..]
                .bytes()
                .any(|b| !b.is_ascii_digit() && !(b'a'..=b'f').contains(&b))
            || proof.root != *root
            || proof.device != pending.target.device_id
            || hex(&proof.incarnation) != pending.target.incarnation
            || proof.device == manager.scope().device
                && hex(&proof.incarnation) == manager.scope().incarnation
            || !subjects.contains(&(&proof.device, proof.incarnation))
        {
            return Err(vault::Error::Integrity);
        }
    }
    Ok(state)
}
fn learn(state: &mut Withdrawals, proof: Revocation) -> std::result::Result<bool, vault::Error> {
    if proof.root != state.root || proof.verify().is_err() {
        return Err(vault::Error::Rejected);
    }
    if state
        .learned
        .iter()
        .any(|p| p.device == proof.device && p.incarnation == proof.incarnation)
    {
        return Ok(false);
    }
    if state.learned.len() >= 4096 {
        return Err(vault::Error::Limit);
    }
    state.learned.push(proof);
    Ok(true)
}
fn persist(records: &mut Records, state: &Withdrawals) -> std::result::Result<(), vault::Error> {
    let mut pins = private(Pins::load(records, &state.root.instance))?;
    if pins.pinned_root(&state.root.user) == Some(&state.root) {
        for proof in &state.learned {
            private(pins.apply_revocation(proof))?;
        }
        private(pins.save(records))?;
    }
    let bytes = serde_json::to_vec(state).map_err(|_| vault::Error::Integrity)?;
    if bytes.len() > LIMIT {
        return Err(vault::Error::Limit);
    }
    records.insert(RECORD.into(), bytes);
    Ok(())
}
/// Existing explicit pins can learn an owned withdrawal. This never creates
/// a pin or approves a device, including when the directory omits the proof.
pub(super) fn apply_known(
    records: &Records,
    manager: &Manager,
    root: &Root,
    pins: &mut Pins,
) -> std::result::Result<(), vault::Error> {
    if root.user != manager.scope().user || pins.pinned_root(&root.user) != Some(root) {
        return Ok(());
    }
    let state = load(records, manager, root)?;
    for proof in &state.learned {
        private(pins.apply_revocation(proof))?;
    }
    Ok(())
}
pub(super) fn pending(
    records: &Records,
    manager: &Manager,
    root: &Root,
) -> std::result::Result<bool, vault::Error> {
    Ok(load(records, manager, root)?.pending.is_some())
}
/// Learn only proofs for this already established local identity. Own withdrawal
/// and the account guard are saved in the same protected transaction.
pub(super) fn observe(manager: &Manager, account: &State, directory: &Directory) -> Result<bool> {
    let proofs = directory
        .wire
        .revocations
        .iter()
        .map(|item| {
            serde_json::from_slice::<Revocation>(&decode(&item.signed, 4096)?)
                .map_err(|_| Error::Changed)
        })
        .collect::<Result<Vec<_>>>()?;
    let (changed, withdrawn) = manager.inspect(|_, records| {
        let mut state = load(records, manager, &account.root)?;
        let mut changed = false;
        for proof in &proofs {
            changed |= learn(&mut state, proof.clone())?;
        }
        let withdrawn = state.learned.iter().any(|p| {
            p.device == manager.scope().device && hex(&p.incarnation) == manager.scope().incarnation
        });
        let mut pins = private(Pins::load(records, &account.root.instance))?;
        let before = serde_json::to_vec(&pins).map_err(|_| vault::Error::Integrity)?;
        if pins.pinned_root(&account.root.user) == Some(&account.root) {
            for proof in &state.learned {
                private(pins.apply_revocation(proof))?;
            }
        }
        changed |= before != serde_json::to_vec(&pins).map_err(|_| vault::Error::Integrity)?;
        Ok((changed, withdrawn))
    })?;
    if changed || withdrawn {
        manager.transact(|_, records| {
            let mut current = super::read(records, manager)?.ok_or(vault::Error::NotInitialized)?;
            if current.root != account.root {
                return Err(vault::Error::Stale);
            }
            let mut state = load(records, manager, &current.root)?;
            for proof in proofs {
                learn(&mut state, proof)?;
            }
            current.withdrawn |= state.learned.iter().any(|p| {
                p.device == manager.scope().device
                    && hex(&p.incarnation) == manager.scope().incarnation
            });
            super::save(records, &current)?;
            persist(records, &state)
        })?;
    }
    Ok(withdrawn)
}

#[derive(Serialize)]
pub struct Device {
    pub device: String,
    pub incarnation: String,
    pub fingerprint: String,
    pub revision: String,
    pub expires_at: String,
}
#[derive(Serialize)]
pub struct Subject {
    pub device: String,
    pub incarnation: String,
}
#[derive(Serialize)]
pub struct Status {
    pub controls_root: bool,
    pub devices: Vec<Device>,
    pub withdrawn: Vec<Subject>,
    pub pending: Option<Subject>,
}
/// Cannot be reconstructed from UI strings or replayed against a newer target.
pub struct Preview {
    pub device: String,
    pub incarnation: String,
    pub fingerprint: String,
    pub root_fingerprint: String,
    pub expires_at: String,
    scope: Scope,
    target: http::Device,
    baseline: Renewal,
}
impl Coordinator<'_> {
    pub fn withdrawals(&self, directory: &Directory) -> Result<Status> {
        self.bind(directory)?;
        let (manager, account) = self.state()?;
        self.registered_certificate(&manager, &account, directory)?;
        manager
            .inspect(|_, records| {
                let state = load(records, &manager, &account.root)?;
                let devices = directory
                    .wire
                    .devices
                    .iter()
                    .filter(|d| {
                        (d.device_id != manager.scope().device
                            || d.incarnation != manager.scope().incarnation)
                            && !state.learned.iter().any(|p| {
                                p.device == d.device_id && hex(&p.incarnation) == d.incarnation
                            })
                    })
                    .map(|d| {
                        let c =
                            certificate(d, &account.root).map_err(|_| vault::Error::Rejected)?;
                        Ok(Device {
                            device: d.device_id.clone(),
                            incarnation: d.incarnation.clone(),
                            fingerprint: hex(&private(c.fingerprint())?),
                            revision: d.revision.clone(),
                            expires_at: d.expires_at.clone(),
                        })
                    })
                    .collect::<std::result::Result<Vec<_>, vault::Error>>()?;
                Ok(Status {
                    controls_root: account.controller,
                    devices,
                    withdrawn: state
                        .learned
                        .iter()
                        .map(|p| Subject {
                            device: p.device.clone(),
                            incarnation: hex(&p.incarnation),
                        })
                        .collect(),
                    pending: state.pending.map(|p| Subject {
                        device: p.target.device_id,
                        incarnation: p.target.incarnation,
                    }),
                })
            })
            .map_err(Error::from)
    }
    pub fn preview_withdrawal(
        &self,
        directory: &Directory,
        device: &str,
        fingerprint: &str,
    ) -> Result<Preview> {
        self.bind(directory)?;
        let (manager, account) = self.state()?;
        let own = self.registered_certificate(&manager, &account, directory)?;
        if !account.controller || account.registration.is_some() || account.renewal.is_some() {
            return Err(Error::Changed);
        }
        let target = directory
            .wire
            .devices
            .iter()
            .find(|d| d.device_id == device)
            .ok_or(Error::Changed)?;
        let c = certificate(target, &account.root)?;
        if c.device.device == manager.scope().device
            && hex(&c.device.incarnation) == manager.scope().incarnation
            || hex(&c.fingerprint()?) != fingerprint
        {
            return Err(Error::Changed);
        }
        manager.inspect(|_, records| {
            let state = load(records, &manager, &account.root)?;
            if state.pending.is_some()
                || state
                    .learned
                    .iter()
                    .any(|p| p.device == c.device.device && p.incarnation == c.device.incarnation)
            {
                return Err(vault::Error::Rejected);
            }
            private(Issuer::load(
                records,
                &manager.scope().instance,
                &manager.scope().user,
            ))?;
            Ok(())
        })?;
        Ok(Preview {
            device: device.into(),
            incarnation: target.incarnation.clone(),
            fingerprint: fingerprint.into(),
            root_fingerprint: hex(&account.root.fingerprint()?),
            expires_at: target.expires_at.clone(),
            scope: manager.scope().clone(),
            target: target.clone(),
            baseline: Renewal {
                receipt: account.receipt.ok_or(Error::Changed)?,
                certificate: own,
            },
        })
    }
    pub fn prepare_withdrawal(
        &self,
        directory: &Directory,
        preview: Preview,
    ) -> Result<http::RevokeDevice> {
        self.bind(directory)?;
        let (manager, account) = self.state()?;
        let own = self.registered_certificate(&manager, &account, directory)?;
        let target = certificate(&preview.target, &account.root)?;
        if manager.scope() != &preview.scope
            || preview.device != target.device.device
            || preview.incarnation != hex(&target.device.incarnation)
            || preview.fingerprint != hex(&target.fingerprint()?)
            || preview.root_fingerprint != hex(&account.root.fingerprint()?)
            || preview.expires_at != target.device.expires_at.to_string()
            || !account.controller
            || account.registration.is_some()
            || account.renewal.is_some()
            || own != preview.baseline.certificate
            || !account
                .receipt
                .as_ref()
                .is_some_and(|r| same(r, &preview.baseline.receipt))
            || !directory
                .wire
                .devices
                .iter()
                .any(|d| same(d, &preview.target))
        {
            return Err(Error::Changed);
        }
        manager
            .transact(|_, records| {
                let current =
                    super::read(records, &manager)?.ok_or(vault::Error::NotInitialized)?;
                if current.withdrawn
                    || !current.controller
                    || current.registration.is_some()
                    || current.renewal.is_some()
                    || current.root != account.root
                    || !current
                        .receipt
                        .as_ref()
                        .is_some_and(|r| same(r, &preview.baseline.receipt))
                {
                    return Err(vault::Error::Stale);
                }
                let mut state = load(records, &manager, &current.root)?;
                if state.pending.is_some() {
                    return Err(vault::Error::Pending);
                }
                let c = certificate(&preview.target, &current.root)
                    .map_err(|_| vault::Error::Rejected)?;
                if state
                    .learned
                    .iter()
                    .any(|p| p.device == c.device.device && p.incarnation == c.device.incarnation)
                {
                    return Err(vault::Error::Rejected);
                }
                let issuer = private(Issuer::load(
                    records,
                    &manager.scope().instance,
                    &manager.scope().user,
                ))?;
                let proof = private(issuer.revoke(&c.device.device, c.device.incarnation))?;
                let mut nonce = [0u8; 32];
                getrandom::fill(&mut nonce).map_err(|_| vault::Error::Storage)?;
                let request = http::RevokeDevice {
                    scope: preview.baseline.receipt.scope.clone(),
                    operation_id: format!("withdraw-{}", hex(&nonce)),
                    device_revision: preview.baseline.receipt.device_revision.clone(),
                    incarnation: manager.scope().incarnation.clone(),
                    signed: B64
                        .encode(&serde_json::to_vec(&proof).map_err(|_| vault::Error::Integrity)?),
                };
                learn(&mut state, proof)?;
                state.pending = Some(Pending {
                    baseline: preview.baseline,
                    target: preview.target,
                    request: request.clone(),
                });
                persist(records, &state)?;
                Ok(request)
            })
            .map_err(Error::from)
    }
    pub fn pending_withdrawal(&self) -> Result<http::RevokeDevice> {
        let (manager, account) = self.state()?;
        manager
            .inspect(|_, records| {
                load(records, &manager, &account.root)?
                    .pending
                    .map(|p| p.request)
                    .ok_or(vault::Error::Rejected)
            })
            .map_err(Error::from)
    }
    pub fn acknowledge_withdrawal(
        &self,
        request: &http::RevokeDevice,
        receipt: http::OperationReceipt,
    ) -> Result<()> {
        let (manager, account) = self.state()?;
        let proof = signed(request)?;
        if receipt.scope.instance_id != manager.scope().instance
            || receipt.scope.data_epoch != manager.scope().data_epoch
            || receipt.operation_id != request.operation_id
            || receipt.kind != "revoke_device"
            || receipt.device_id != manager.scope().device
            || receipt.incarnation != manager.scope().incarnation
            || receipt.device_revision != request.device_revision
            || receipt.root_fingerprint != hex(&account.root.fingerprint()?)
            || !receipt.key_package_refs.is_empty()
            || proof.root != account.root
        {
            return Err(Error::Changed);
        }
        manager.transact(|_, records| {
            let current = super::read(records, &manager)?.ok_or(vault::Error::NotInitialized)?;
            let mut state = load(records, &manager, &current.root)?;
            let pending = state.pending.as_ref().ok_or(vault::Error::Stale)?;
            if current.withdrawn
                || !current.controller
                || current.registration.is_some()
                || current.renewal.is_some()
                || !same(request, &pending.request)
                || !current
                    .receipt
                    .as_ref()
                    .is_some_and(|r| same(r, &pending.baseline.receipt))
            {
                return Err(vault::Error::Stale);
            }
            state.pending = None;
            persist(records, &state)
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
