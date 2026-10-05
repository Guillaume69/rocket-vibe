//! History backup ceremony (E2EE_HISTORY_BACKUP.md, path B): enabling a new
//! history key generation behind its own `rvh1-` code, its signed publication
//! outbox, and joining an existing generation with the code. The code is shown
//! only on explicit request; the key lives only in the vault.
use super::*;
use crate::history_backup::{self as backup, HistoryCode, HistoryKey};
use rv_crypto_public::history_backup::{PUBLICATION_LIMIT, Publication, PublicationBody};
use rv_crypto_public::recovery::Scope as PublicScope;
use zeroize::Zeroize;

const RECORD: &str = "crypto-history-backup-ui-v1";
const PENDING_CODE: &str = "crypto-history-backup-pending-code-v1";
const PENDING_KEY: &str = "crypto-history-backup-pending-key-v1";
/// The history key this device holds and uploads under.
pub(crate) const KEY: &str = "crypto-history-key-v1";
const LIMIT: usize = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    request: http::PublishHistoryKey,
    code_saved: bool,
    cancel_requested: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    scope: Scope,
    root: Root,
    receipt: Option<http::HistoryKeyReceipt>,
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
fn publication(request: &http::PublishHistoryKey) -> Result<Publication> {
    let p = Publication::from_bytes(&decode(&request.publication, PUBLICATION_LIMIT)?)?;
    if p.body.operation != request.operation_id
        || p.body.scope.instance != request.scope.instance_id
        || p.body.scope.data_epoch != request.scope.data_epoch
    {
        return Err(Error::Changed);
    }
    Ok(p)
}
fn receipt_matches(p: &Publication, r: &http::HistoryKeyReceipt) -> Result<()> {
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
        || r.root_fingerprint != hex(&p.package.header.root.fingerprint()?)
        || r.generation != hex(&p.package.header.generation)
        || revision(&r.generation_revision)? != expected
        || r.package_digest != hex(&p.body.package_digest)
    {
        return Err(Error::Changed);
    }
    Ok(())
}
/// The active publication of this account, its receipt matching it.
fn remote(
    account: &crate::installation::Account,
    root: &Root,
    value: &http::HistoryKeyState,
) -> Result<Option<Publication>> {
    if value.scope.instance_id != account.instance || value.scope.data_epoch != account.data_epoch {
        return Err(Error::Changed);
    }
    value
        .active
        .as_ref()
        .map(|active| {
            let p = Publication::from_bytes(&decode(&active.publication, PUBLICATION_LIMIT)?)?;
            if &p.package.header.root != root {
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
        if records.contains_key(PENDING_CODE) || records.contains_key(PENDING_KEY) {
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
    let pending = saved.pending.is_some();
    if saved.version != 1
        || &saved.scope != manager.scope()
        || &saved.root != root
        || pending != records.contains_key(PENDING_CODE)
        || pending != records.contains_key(PENDING_KEY)
    {
        return Err(vault::Error::Integrity);
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
fn forget(records: &mut Records, name: &str) {
    if let Some(mut bytes) = records.remove(name) {
        bytes.zeroize();
    }
}
fn backup_error(_: crate::history::Error) -> vault::Error {
    vault::Error::Rejected
}
/// The history key this device holds, if any.
pub(crate) fn held(records: &Records) -> std::result::Result<Option<HistoryKey>, vault::Error> {
    records
        .get(KEY)
        .map(|bytes| HistoryKey::from_bytes(bytes).map_err(|_| vault::Error::Integrity))
        .transpose()
}
fn hold(records: &mut Records, key: &HistoryKey) -> std::result::Result<(), vault::Error> {
    let bytes = key.to_bytes().map_err(backup_error)?;
    if let Some(mut old) = records.insert(KEY.into(), bytes.to_vec()) {
        old.zeroize();
    }
    Ok(())
}

#[derive(Serialize)]
pub struct HistoryBackupStatus {
    /// This device holds a history key and uploads under it.
    pub holds_key: bool,
    pub generation: Option<String>,
    pub receipt: Option<http::HistoryKeyReceipt>,
    pub pending: bool,
    pub code_saved: bool,
    pub cancel_requested: bool,
}
pub struct HistoryBackupPreview {
    /// The active generation's revision this one replaces, if any.
    pub generation_revision: Option<String>,
    scope: Scope,
    remote: http::HistoryKeyState,
}

impl Coordinator<'_> {
    pub fn history_backup_status(&self, directory: &Directory) -> Result<HistoryBackupStatus> {
        self.bind(directory)?;
        let (manager, account) = self.state()?;
        self.registered_certificate(&manager, &account, directory)?;
        manager
            .inspect(|_, records| {
                let saved = load(records, &manager, &account.root)?;
                let key = held(records)?;
                Ok(HistoryBackupStatus {
                    holds_key: key.is_some(),
                    generation: key.map(|k| hex(&k.generation)),
                    receipt: saved.receipt,
                    pending: saved.pending.is_some(),
                    code_saved: saved.pending.as_ref().is_some_and(|p| p.code_saved),
                    cancel_requested: saved.pending.as_ref().is_some_and(|p| p.cancel_requested),
                })
            })
            .map_err(Error::from)
    }
    /// Explicit review before a new generation replaces the active one.
    pub fn preview_history_backup(
        &self,
        directory: &Directory,
        value: http::HistoryKeyState,
    ) -> Result<HistoryBackupPreview> {
        self.bind(directory)?;
        let (manager, account) = self.state()?;
        self.registered_certificate(&manager, &account, directory)?;
        remote(self.0.account(), &account.root, &value)?;
        manager.inspect(|_, records| {
            if load(records, &manager, &account.root)?.pending.is_some() {
                return Err(vault::Error::Stale);
            }
            Ok(())
        })?;
        Ok(HistoryBackupPreview {
            generation_revision: value
                .active
                .as_ref()
                .map(|a| a.receipt.generation_revision.clone()),
            scope: manager.scope().clone(),
            remote: value,
        })
    }
    /// Draws a new history key and code and keeps the signed publication as an
    /// outbox. No HTTP intent leaves before the code is confirmed saved.
    pub fn prepare_history_backup(
        &self,
        directory: &Directory,
        preview: HistoryBackupPreview,
        time: u64,
    ) -> Result<()> {
        self.bind(directory)?;
        let (manager, account) = self.state()?;
        self.registered_certificate(&manager, &account, directory)?;
        remote(self.0.account(), &account.root, &preview.remote)?;
        let receipt = account.receipt.clone().ok_or(Error::Changed)?;
        if &preview.scope != manager.scope()
            || preview.generation_revision
                != preview
                    .remote
                    .active
                    .as_ref()
                    .map(|a| a.receipt.generation_revision.clone())
        {
            return Err(Error::Changed);
        }
        manager.transact(|_, records| {
            let mut saved = load(records, &manager, &account.root)?;
            if saved.pending.is_some() {
                return Err(vault::Error::Stale);
            }
            let local = private(LocalDevice::load(
                &account.root,
                &manager.scope().device,
                records,
            ))?;
            let key = HistoryKey::generate().map_err(backup_error)?;
            let code = HistoryCode::generate().map_err(backup_error)?;
            let package = key.seal(&code, &account.root, time).map_err(backup_error)?;
            let digest = package.digest().map_err(|_| vault::Error::Rejected)?;
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|_| vault::Error::Storage)?;
            let operation = format!("history-key-{}", hex(&random));
            let body = PublicationBody {
                version: 1,
                scope: PublicScope {
                    instance: manager.scope().instance.clone(),
                    data_epoch: manager.scope().data_epoch.clone(),
                },
                operation: operation.clone(),
                device: manager.scope().device.clone(),
                incarnation: incarnation(&manager)?,
                device_revision: receipt.device_revision.clone(),
                expected_revision: preview.generation_revision,
                package_digest: digest,
            };
            let p = backup::publish(&local, body, package, time).map_err(backup_error)?;
            saved.pending = Some(Pending {
                request: http::PublishHistoryKey {
                    scope: http::Scope {
                        instance_id: manager.scope().instance.clone(),
                        data_epoch: manager.scope().data_epoch.clone(),
                    },
                    operation_id: operation,
                    publication: B64.encode(&p.to_bytes().map_err(|_| vault::Error::Rejected)?),
                },
                code_saved: false,
                cancel_requested: false,
            });
            code.save(records, PENDING_CODE);
            records.insert(
                PENDING_KEY.into(),
                key.to_bytes().map_err(backup_error)?.to_vec(),
            );
            persist(records, &saved)
        })?;
        Ok(())
    }
    /// Explicit temporary view only, never in status or HTTP.
    pub fn history_backup_code(&self) -> Result<zeroize::Zeroizing<String>> {
        let (manager, account) = self.state()?;
        manager
            .inspect(|_, records| {
                if load(records, &manager, &account.root)?.pending.is_none() {
                    return Err(vault::Error::Rejected);
                }
                Ok(HistoryCode::load(records, PENDING_CODE)
                    .map_err(backup_error)?
                    .for_display())
            })
            .map_err(Error::from)
    }
    pub fn confirm_history_backup_code(&self) -> Result<()> {
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
    pub fn pending_history_backup(&self) -> Result<http::PublishHistoryKey> {
        let (manager, account) = self.state()?;
        manager
            .inspect(|_, records| {
                load(records, &manager, &account.root)?
                    .pending
                    .filter(|p| p.code_saved && !p.cancel_requested)
                    .map(|p| p.request)
                    .ok_or(vault::Error::Rejected)
            })
            .map_err(Error::from)
    }
    /// The server accepted this generation: this device now holds its key.
    pub fn acknowledge_history_backup(
        &self,
        request: &http::PublishHistoryKey,
        receipt: http::HistoryKeyReceipt,
    ) -> Result<()> {
        let (manager, account) = self.state()?;
        let p = publication(request)?;
        receipt_matches(&p, &receipt)?;
        if p.package.header.root != account.root {
            return Err(Error::Changed);
        }
        manager.transact(|_, records| {
            let mut saved = load(records, &manager, &account.root)?;
            let pending = saved.pending.as_ref().ok_or(vault::Error::Stale)?;
            if !pending.code_saved || !same(request, &pending.request) {
                return Err(vault::Error::Stale);
            }
            let key =
                HistoryKey::from_bytes(records.get(PENDING_KEY).ok_or(vault::Error::Integrity)?)
                    .map_err(backup_error)?;
            if key.generation != p.package.header.generation {
                return Err(vault::Error::Integrity);
            }
            hold(records, &key)?;
            saved.pending = None;
            saved.receipt = Some(receipt);
            forget(records, PENDING_CODE);
            forget(records, PENDING_KEY);
            persist(records, &saved)
        })?;
        Ok(())
    }
    pub fn request_history_backup_cancellation(&self) -> Result<http::PublishHistoryKey> {
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
    pub fn pending_history_backup_cancellation(&self) -> Result<http::PublishHistoryKey> {
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
    pub fn settle_history_backup_cancellation(
        &self,
        request: &http::PublishHistoryKey,
        result: http::HistoryKeySettlement,
    ) -> Result<()> {
        if !same(request, &self.pending_history_backup_cancellation()?) {
            return Err(Error::Changed);
        }
        let receipt = match result {
            http::HistoryKeySettlement::Accepted(receipt) => {
                return self.acknowledge_history_backup(request, receipt);
            }
            http::HistoryKeySettlement::Cancelled(receipt) => receipt,
        };
        let (manager, account) = self.state()?;
        let p = publication(request)?;
        if receipt.scope.instance_id != p.body.scope.instance
            || receipt.scope.data_epoch != p.body.scope.data_epoch
            || receipt.operation_id != p.body.operation
            || receipt.device_id != p.body.device
            || receipt.generation != hex(&p.package.header.generation)
            || receipt.expected_revision != p.body.expected_revision
            || receipt.package_digest != hex(&p.body.package_digest)
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
            forget(records, PENDING_CODE);
            forget(records, PENDING_KEY);
            persist(records, &saved)
        })?;
        Ok(())
    }
    /// Joins the active generation with its history code, on another device of
    /// the account or on a blank device restoring the history. Returns the
    /// generation now held.
    pub fn join_history_backup(
        &self,
        directory: &Directory,
        value: &http::HistoryKeyState,
        code: &str,
    ) -> Result<String> {
        self.bind(directory)?;
        let (manager, account) = self.state()?;
        self.registered_certificate(&manager, &account, directory)?;
        let p = remote(self.0.account(), &account.root, value)?.ok_or(Error::Changed)?;
        let code = HistoryCode::from_code(code).map_err(|_| Error::Changed)?;
        let key = HistoryKey::open(&p.package, &code, &account.root).map_err(|_| Error::Changed)?;
        let generation = hex(&key.generation);
        manager.transact(|_, records| {
            if load(records, &manager, &account.root)?.pending.is_some() {
                return Err(vault::Error::Stale);
            }
            hold(records, &key)
        })?;
        Ok(generation)
    }
}

#[cfg(test)]
mod tests;
