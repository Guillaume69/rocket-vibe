//! Protected backup outbox and explicit fresh-device root recovery.
use super::*;
use crate::identity::recovery::{RecoverySecret, RootBackup};
use rv_crypto_public::recovery::{
    PUBLICATION_LIMIT, Publication, PublicationBody, Scope as PublicScope,
};
use zeroize::{Zeroize, Zeroizing};
const RECORD: &str = "crypto-root-backup-ui-v1";
const SECRET: &str = "crypto-root-backup-pending-secret-v1";
const LIMIT: usize = 128 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    baseline: Renewal,
    request: http::PublishRootBackup,
    code_saved: bool,
    #[serde(default)]
    cancel_requested: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    scope: Scope,
    root: Root,
    receipt: Option<http::RootBackupReceipt>,
    pending: Option<Pending>,
}
fn revision(value: &str) -> Result<i64> {
    value
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0 && n.to_string() == value)
        .ok_or(Error::Changed)
}
fn same<T: Serialize>(left: &T, right: &T) -> bool {
    serde_json::to_vec(left).ok() == serde_json::to_vec(right).ok()
}
fn publication(request: &http::PublishRootBackup) -> Result<Publication> {
    let p = Publication::from_bytes(&decode(&request.publication, PUBLICATION_LIMIT)?)?;
    if p.body.operation != request.operation_id
        || p.body.scope.instance != request.scope.instance_id
        || p.body.scope.data_epoch != request.scope.data_epoch
    {
        return Err(Error::Changed);
    }
    Ok(p)
}
fn receipt_matches(p: &Publication, r: &http::RootBackupReceipt) -> Result<()> {
    let expected = p
        .body
        .expected_revision
        .as_deref()
        .map(revision)
        .transpose()?
        .unwrap_or(0)
        .checked_add(1)
        .ok_or(Error::Changed)?;
    if r.scope.instance_id != p.body.scope.instance
        || r.scope.data_epoch != p.body.scope.data_epoch
        || r.operation_id != p.body.operation
        || r.device_id != p.body.device
        || r.incarnation != hex(&p.body.incarnation)
        || r.device_revision != p.body.device_revision
        || r.root_fingerprint != hex(&p.packet.header.root.fingerprint()?)
        || r.backup_id != hex(&p.packet.header.backup_id)
        || revision(&r.backup_revision)? != expected
        || r.packet_digest != hex(&p.body.packet_digest)
    {
        return Err(Error::Changed);
    }
    Ok(())
}
fn remote(
    account: &crate::installation::Account,
    value: &http::RootBackupState,
) -> Result<Option<Publication>> {
    if value.scope.instance_id != account.instance || value.scope.data_epoch != account.data_epoch {
        return Err(Error::Changed);
    }
    value
        .active
        .as_ref()
        .map(|active| {
            let p = Publication::from_bytes(&decode(&active.publication, PUBLICATION_LIMIT)?)?;
            if p.packet.header.root.instance != account.instance
                || p.packet.header.root.user != account.user
            {
                return Err(Error::Changed);
            }
            receipt_matches(&p, &active.receipt)?;
            Ok(p)
        })
        .transpose()
}
fn load(
    records: &Records,
    manager: &Manager,
    root: &Root,
) -> std::result::Result<Saved, vault::Error> {
    let Some(bytes) = records.get(RECORD) else {
        if records.contains_key(SECRET) {
            return Err(vault::Error::Integrity);
        }
        return Ok(Saved {
            version: 1,
            scope: manager.scope().clone(),
            root: root.clone(),
            receipt: None,
            pending: None,
        });
    };
    if bytes.len() > LIMIT {
        return Err(vault::Error::Limit);
    }
    let saved: Saved = serde_json::from_slice(bytes).map_err(|_| vault::Error::Integrity)?;
    if saved.version != 1
        || &saved.scope != manager.scope()
        || &saved.root != root
        || saved.pending.is_some() != records.contains_key(SECRET)
    {
        return Err(vault::Error::Integrity);
    }
    if let Some(r) = &saved.receipt
        && (r.scope.instance_id != manager.scope().instance
            || r.scope.data_epoch != manager.scope().data_epoch
            || r.device_id != manager.scope().device
            || r.incarnation != manager.scope().incarnation
            || r.root_fingerprint != hex(&private(root.fingerprint())?)
            || revision(&r.backup_revision).is_err())
    {
        return Err(vault::Error::Integrity);
    }
    if let Some(pending) = &saved.pending {
        let current = read(records, manager)?.ok_or(vault::Error::NotInitialized)?;
        let p = publication(&pending.request).map_err(|_| vault::Error::Integrity)?;
        if current.withdrawn
            || !current.controller
            || current.registration.is_some()
            || current.renewal.is_some()
            || !current
                .receipt
                .as_ref()
                .is_some_and(|r| same(r, &pending.baseline.receipt))
            || !pending.baseline.bound(manager, root)
            || p.packet.header.root != *root
            || p.body.device != manager.scope().device
            || hex(&p.body.incarnation) != manager.scope().incarnation
            || p.body.device_revision != pending.baseline.receipt.device_revision
            || p.body.scope.instance != manager.scope().instance
            || p.body.scope.data_epoch != manager.scope().data_epoch
        {
            return Err(vault::Error::Integrity);
        }
        let secret = private(RecoverySecret::load(records, SECRET))?;
        let packet = private(RootBackup::from_bytes(&private(p.packet.to_bytes())?))?;
        private(packet.authenticate(&secret, root))?;
    }
    Ok(saved)
}
fn persist(records: &mut Records, saved: &Saved) -> std::result::Result<(), vault::Error> {
    let bytes = serde_json::to_vec(saved).map_err(|_| vault::Error::Integrity)?;
    if bytes.len() > LIMIT {
        return Err(vault::Error::Limit);
    }
    records.insert(RECORD.into(), bytes);
    Ok(())
}
fn observe_receipt(
    saved: &Saved,
    remote: &http::RootBackupState,
) -> std::result::Result<(), vault::Error> {
    if let Some(known) = &saved.receipt {
        let observed = &remote.active.as_ref().ok_or(vault::Error::Stale)?.receipt;
        let old = revision(&known.backup_revision).map_err(|_| vault::Error::Integrity)?;
        let new = revision(&observed.backup_revision).map_err(|_| vault::Error::Integrity)?;
        if new < old || new == old && !same(known, observed) {
            return Err(vault::Error::Stale);
        }
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
#[derive(Serialize)]
pub struct Status {
    pub controls_root: bool,
    pub root_fingerprint: String,
    pub receipt: Option<http::RootBackupReceipt>,
    pub pending: bool,
    pub code_saved: bool,
    pub cancel_requested: bool,
}
pub struct BackupPreview {
    pub root_fingerprint: String,
    pub backup_revision: Option<String>,
    scope: Scope,
    baseline: Renewal,
    remote: http::RootBackupState,
    local_receipt: Option<http::RootBackupReceipt>,
}
/// The code and decrypted key are opaque and zeroized when this preview is dropped.
pub struct RestorePreview {
    pub root_fingerprint: String,
    pub backup_id: String,
    account: crate::installation::Account,
    root: Root,
    packet: RootBackup,
    secret: RecoverySecret,
}
impl Coordinator<'_> {
    pub fn backup_status(&self, directory: &Directory) -> Result<Status> {
        self.bind(directory)?;
        let (manager, account) = self.state()?;
        self.registered_certificate(&manager, &account, directory)?;
        manager
            .inspect(|_, records| {
                let saved = load(records, &manager, &account.root)?;
                Ok(Status {
                    controls_root: account.controller,
                    root_fingerprint: hex(&private(account.root.fingerprint())?),
                    receipt: saved.receipt,
                    pending: saved.pending.is_some(),
                    code_saved: saved.pending.as_ref().is_some_and(|p| p.code_saved),
                    cancel_requested: saved.pending.as_ref().is_some_and(|p| p.cancel_requested),
                })
            })
            .map_err(Error::from)
    }
    pub fn preview_backup(
        &self,
        directory: &Directory,
        value: http::RootBackupState,
    ) -> Result<BackupPreview> {
        self.bind(directory)?;
        let (manager, account) = self.state()?;
        let certificate = self.registered_certificate(&manager, &account, directory)?;
        let p = remote(self.0.account(), &value)?;
        if !account.controller
            || account.registration.is_some()
            || account.renewal.is_some()
            || p.is_some_and(|p| p.packet.header.root != account.root)
        {
            return Err(Error::Changed);
        }
        let local_receipt = manager.inspect(|_, records| {
            let saved = load(records, &manager, &account.root)?;
            observe_receipt(&saved, &value)?;
            if saved.pending.is_some() || revocations::pending(records, &manager, &account.root)? {
                return Err(vault::Error::Stale);
            }
            private(Issuer::load(
                records,
                &manager.scope().instance,
                &manager.scope().user,
            ))?;
            Ok(saved.receipt)
        })?;
        Ok(BackupPreview {
            root_fingerprint: hex(&account.root.fingerprint()?),
            backup_revision: value
                .active
                .as_ref()
                .map(|p| p.receipt.backup_revision.clone()),
            scope: manager.scope().clone(),
            baseline: Renewal {
                receipt: account.receipt.ok_or(Error::Changed)?,
                certificate,
            },
            remote: value,
            local_receipt,
        })
    }
    /// Explicit create/replace confirmation. No HTTP intent is exposed until
    /// the separately displayed recovery code is confirmed saved by the user.
    pub fn prepare_backup(
        &self,
        directory: &Directory,
        preview: BackupPreview,
        time: u64,
    ) -> Result<()> {
        self.bind(directory)?;
        let (manager, account) = self.state()?;
        let certificate = self.registered_certificate(&manager, &account, directory)?;
        remote(self.0.account(), &preview.remote)?;
        if &preview.scope != manager.scope()
            || preview.root_fingerprint != hex(&account.root.fingerprint()?)
            || preview.backup_revision
                != preview
                    .remote
                    .active
                    .as_ref()
                    .map(|p| p.receipt.backup_revision.clone())
            || certificate != preview.baseline.certificate
            || !account.controller
            || account.registration.is_some()
            || account.renewal.is_some()
            || !account
                .receipt
                .as_ref()
                .is_some_and(|r| same(r, &preview.baseline.receipt))
        {
            return Err(Error::Changed);
        }
        manager.transact(|_, records| {
            let current = read(records, &manager)?.ok_or(vault::Error::NotInitialized)?;
            let mut saved = load(records, &manager, &current.root)?;
            observe_receipt(&saved, &preview.remote)?;
            if current.withdrawn
                || !current.controller
                || current.registration.is_some()
                || current.renewal.is_some()
                || current.root != account.root
                || saved.pending.is_some()
                || !same(&saved.receipt, &preview.local_receipt)
                || revocations::pending(records, &manager, &current.root)?
                || !current
                    .receipt
                    .as_ref()
                    .is_some_and(|r| same(r, &preview.baseline.receipt))
            {
                return Err(vault::Error::Stale);
            }
            let issuer = private(Issuer::load(
                records,
                &manager.scope().instance,
                &manager.scope().user,
            ))?;
            let secret = private(RecoverySecret::generate())?;
            let packet = private(RootBackup::seal(&issuer, &secret, time))?;
            let digest = private(rv_crypto_public::recovery::RootBackup::from_bytes(
                &private(packet.to_bytes())?,
            ))?
            .digest()
            .map_err(|_| vault::Error::Rejected)?;
            let mut random = Zeroizing::new([0u8; 32]);
            getrandom::fill(random.as_mut()).map_err(|_| vault::Error::Storage)?;
            let operation = format!("backup-{}", hex(random.as_ref()));
            let p = private(issuer.publish_backup(
                &packet,
                PublicationBody {
                    version: 1,
                    scope: PublicScope {
                        instance: manager.scope().instance.clone(),
                        data_epoch: manager.scope().data_epoch.clone(),
                    },
                    operation: operation.clone(),
                    device: manager.scope().device.clone(),
                    incarnation: incarnation(&manager)?,
                    device_revision: preview.baseline.receipt.device_revision.clone(),
                    expected_revision: preview.backup_revision,
                    packet_digest: digest,
                },
            ))?;
            saved.pending = Some(Pending {
                baseline: preview.baseline,
                request: http::PublishRootBackup {
                    scope: http::Scope {
                        instance_id: manager.scope().instance.clone(),
                        data_epoch: manager.scope().data_epoch.clone(),
                    },
                    operation_id: operation,
                    publication: B64.encode(&private(p.to_bytes())?),
                },
                code_saved: false,
                cancel_requested: false,
            });
            secret.save(records, SECRET);
            persist(records, &saved)
        })?;
        Ok(())
    }
    /// Explicit temporary view only, never included in status or HTTP metadata.
    pub fn backup_code(&self) -> Result<Zeroizing<String>> {
        let (manager, account) = self.state()?;
        manager
            .inspect(|_, records| {
                if load(records, &manager, &account.root)?.pending.is_none() {
                    return Err(vault::Error::Rejected);
                }
                Ok(private(RecoverySecret::load(records, SECRET))?.for_display())
            })
            .map_err(Error::from)
    }
    pub fn confirm_backup_code(&self) -> Result<()> {
        let (manager, account) = self.state()?;
        manager.transact(|_, records| {
            let mut saved = load(records, &manager, &account.root)?;
            saved
                .pending
                .as_mut()
                .ok_or(vault::Error::Stale)?
                .code_saved = true;
            persist(records, &saved)
        })?;
        Ok(())
    }
    pub fn pending_backup(&self) -> Result<http::PublishRootBackup> {
        let (manager, account) = self.state()?;
        manager
            .inspect(|_, records| {
                let saved = load(records, &manager, &account.root)?;
                let p = saved
                    .pending
                    .filter(|p| p.code_saved && !p.cancel_requested)
                    .ok_or(vault::Error::Rejected)?;
                Ok(p.request)
            })
            .map_err(Error::from)
    }
    pub fn acknowledge_backup(
        &self,
        request: &http::PublishRootBackup,
        receipt: http::RootBackupReceipt,
    ) -> Result<()> {
        let (manager, account) = self.state()?;
        let p = publication(request)?;
        receipt_matches(&p, &receipt)?;
        if p.packet.header.root != account.root {
            return Err(Error::Changed);
        }
        manager.transact(|_, records| {
            let current = read(records, &manager)?.ok_or(vault::Error::NotInitialized)?;
            let mut saved = load(records, &manager, &current.root)?;
            let pending = saved.pending.as_ref().ok_or(vault::Error::Stale)?;
            if current.withdrawn
                || !current.controller
                || !pending.code_saved
                || !same(request, &pending.request)
                || !current
                    .receipt
                    .as_ref()
                    .is_some_and(|r| same(r, &pending.baseline.receipt))
            {
                return Err(vault::Error::Stale);
            }
            saved.pending = None;
            saved.receipt = Some(receipt);
            if let Some(mut key) = records.remove(SECRET) {
                key.zeroize();
            }
            persist(records, &saved)
        })?;
        Ok(())
    }
    /// Explicit abandonment, protected before network output. A resumed view
    /// keeps cancelling this original intent and cannot accidentally publish it.
    pub fn request_backup_cancellation(&self) -> Result<http::PublishRootBackup> {
        let (manager, account) = self.state()?;
        manager
            .transact(|_, records| {
                let mut saved = load(records, &manager, &account.root)?;
                let pending = saved.pending.as_mut().ok_or(vault::Error::Stale)?;
                pending.cancel_requested = true;
                let original = pending.request.clone();
                persist(records, &saved)?;
                Ok(original)
            })
            .map_err(Error::from)
    }
    pub fn pending_backup_cancellation(&self) -> Result<http::PublishRootBackup> {
        let (manager, account) = self.state()?;
        manager
            .inspect(|_, records| {
                load(records, &manager, &account.root)?
                    .pending
                    .filter(|p| p.cancel_requested)
                    .map(|p| p.request)
                    .ok_or(vault::Error::Stale)
            })
            .map_err(Error::from)
    }
    pub fn settle_backup_cancellation(
        &self,
        request: &http::PublishRootBackup,
        result: http::RootBackupSettlement,
    ) -> Result<()> {
        let original = self.pending_backup_cancellation()?;
        if !same(request, &original) {
            return Err(Error::Changed);
        }
        let receipt = match result {
            http::RootBackupSettlement::Accepted(receipt) => {
                return self.acknowledge_backup(request, receipt);
            }
            http::RootBackupSettlement::Cancelled(receipt) => receipt,
        };
        let (manager, account) = self.state()?;
        let p = publication(request)?;
        if receipt.scope.instance_id != p.body.scope.instance
            || receipt.scope.data_epoch != p.body.scope.data_epoch
            || receipt.operation_id != p.body.operation
            || receipt.device_id != p.body.device
            || receipt.incarnation != hex(&p.body.incarnation)
            || receipt.device_revision != p.body.device_revision
            || receipt.root_fingerprint != hex(&p.packet.header.root.fingerprint()?)
            || receipt.backup_id != hex(&p.packet.header.backup_id)
            || receipt.expected_revision != p.body.expected_revision
            || receipt.packet_digest != hex(&p.body.packet_digest)
        {
            return Err(Error::Changed);
        }
        manager.transact(|_, records| {
            let mut saved = load(records, &manager, &account.root)?;
            let pending = saved.pending.as_ref().ok_or(vault::Error::Stale)?;
            if !pending.cancel_requested || !same(request, &pending.request) {
                return Err(vault::Error::Stale);
            }
            saved.pending = None;
            if let Some(mut key) = records.remove(SECRET) {
                key.zeroize();
            }
            persist(records, &saved)
        })?;
        Ok(())
    }
    pub fn preview_restore(
        &self,
        value: &http::RootBackupState,
        code: &str,
        expected_fingerprint: &str,
    ) -> Result<RestorePreview> {
        let p = remote(self.0.account(), value)?.ok_or(Error::Changed)?;
        let root = p.packet.header.root.clone();
        let fingerprint = hex(&root.fingerprint()?);
        if fingerprint != expected_fingerprint {
            return Err(Error::Changed);
        }
        let secret = RecoverySecret::from_code(code)?;
        let packet = RootBackup::from_bytes(&p.packet.to_bytes()?)?;
        packet.authenticate(&secret, &root)?;
        Ok(RestorePreview {
            root_fingerprint: fingerprint,
            backup_id: hex(&packet.header.backup_id),
            account: self.0.account().clone(),
            root,
            packet,
            secret,
        })
    }
    /// Explicit restore confirmation. The immutable root is imported, followed
    /// by one fresh bound local leaf. An exact retry preserves that leaf and all
    /// subsequent records; old MLS ratchets, pins and history are never imported.
    pub fn restore_root(&self, preview: RestorePreview, time: u64) -> Result<()> {
        if &preview.account != self.0.account()
            || preview.root_fingerprint != hex(&preview.root.fingerprint()?)
            || preview.backup_id != hex(&preview.packet.header.backup_id)
        {
            return Err(Error::Changed);
        }
        preview
            .packet
            .authenticate(&preview.secret, &preview.root)?;
        let manager = self.0.initialize()?;
        manager.transact(|provider, records| {
            private(
                preview
                    .packet
                    .restore(&preview.secret, &preview.root, provider, records),
            )?;
            if let Some(current) = read(records, &manager)? {
                if current.withdrawn || !current.controller || current.root != preview.root {
                    return Err(vault::Error::Rejected);
                }
                return Ok(());
            }
            let mut local = private(LocalDevice::create_bound(
                &preview.root,
                &manager.scope().device,
                incarnation(&manager)?,
                records,
            ))?;
            let request = private(local.request(time, records))?;
            save(
                records,
                &State {
                    version: 1,
                    root: preview.root,
                    controller: true,
                    request: Some(request),
                    registration: None,
                    receipt: None,
                    renewal: None,
                    withdrawn: false,
                },
            )
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
