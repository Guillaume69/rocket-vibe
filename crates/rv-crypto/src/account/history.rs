//! History recovery for a new device (E2EE_HISTORY.md, path A), between the
//! adapters' transport and the protected groups coordinator. The account's
//! verified directory decides which devices of the account are trusted; the
//! human approval of a request fingerprint and every HTTP call stay with the
//! adapters, every secret and document inside the vault.
use super::*;
use crate::groups::{self, HistoryImport};
use rv_crypto_public::history::{Record, Request as HistoryRequest, SHARE_LIMIT, Share};

/// Records per downloaded page, as the server serves them.
const PAGE_LIMIT: usize = 200;

/// A request from another device of this account that this device may answer.
pub struct Offer {
    pub fingerprint: String,
    pub device: String,
    pub issued_at: u64,
    pub expires_at: u64,
    request: HistoryRequest,
}
/// One room period the sharing device would share.
pub struct PreviewPeriod {
    pub room: String,
    pub documents: u64,
}
/// What the human approves: this exact request fingerprint, these periods.
pub struct SharePreview {
    pub fingerprint: String,
    pub device: String,
    pub periods: Vec<PreviewPeriod>,
    /// This device holds the account root and may hand control over with the
    /// share (E2EE_DELEGATION.md).
    pub can_delegate: bool,
    request: HistoryRequest,
}
/// One page to PUT on `…/requests/{request}/records`.
pub struct Upload {
    pub request: String,
    pub input: http::UploadHistoryRecords,
    start: u64,
    count: u64,
}
/// The signed share to POST on `…/requests/{request}/share`.
pub struct Commit {
    pub request: String,
    pub input: http::CommitHistoryShare,
}
/// Import progress of the new device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportStatus {
    pub request: String,
    /// Next entry to download and the rank after which to read, or none when
    /// every entry is imported and the request can be acknowledged.
    pub next: Option<(u32, u64)>,
}

impl Directory {
    /// Another device of this account, listed with this certificate's device,
    /// incarnation and leaf key, and never revoked. Renewal keeps all three.
    fn sibling(&self, certificate: &Certificate, own: &str) -> Result<()> {
        certificate.authenticate()?;
        let identity = self.wire.identity.as_ref().ok_or(Error::Changed)?;
        let incarnation = hex(&certificate.device.incarnation);
        if certificate.device.device == own
            || identity.fingerprint != hex(&certificate.device.root.fingerprint()?)
            || certificate.device.root.user != self.user
        {
            return Err(Error::Changed);
        }
        let listed = self
            .wire
            .devices
            .iter()
            .find(|d| d.device_id == certificate.device.device)
            .ok_or(Error::Changed)?;
        let current: Certificate = serde_json::from_slice(&decode(&listed.certificate, 4096)?)
            .map_err(|_| Error::Changed)?;
        if listed.incarnation != incarnation
            || current.device.root != certificate.device.root
            || current.device.incarnation != certificate.device.incarnation
            || current.device.signature_key != certificate.device.signature_key
        {
            return Err(Error::Changed);
        }
        for item in &self.wire.revocations {
            let revocation: Revocation =
                serde_json::from_slice(&decode(&item.signed, 4096)?).map_err(|_| Error::Changed)?;
            if revocation.device == certificate.device.device
                && revocation.incarnation == certificate.device.incarnation
            {
                return Err(Error::Changed);
            }
        }
        Ok(())
    }
}
fn request_hex(request: &HistoryRequest) -> Result<String> {
    Ok(hex(&request.fingerprint()?))
}
fn status(import: HistoryImport) -> ImportStatus {
    ImportStatus {
        request: hex(&import.share.manifest.request),
        next: import
            .next
            .map(|(period, imported)| (period as u32, imported)),
    }
}

impl Coordinator<'_> {
    fn groups(&self, directory: &Directory, time: u64) -> Result<groups::Coordinator> {
        let (manager, root) = self.prepared(directory, time)?;
        Ok(groups::Coordinator::new(manager, root)?)
    }
    fn scope(&self) -> http::Scope {
        http::Scope {
            instance_id: self.0.account().instance.clone(),
            data_epoch: self.0.account().data_epoch.clone(),
        }
    }

    /// New device: its pending request, created once and replayed until it
    /// expires; publishing it again is idempotent.
    pub fn history_request(
        &self,
        directory: &Directory,
        time: u64,
    ) -> Result<(String, http::PublishHistoryRequest)> {
        let request = self.groups(directory, time)?.history_request(time)?;
        Ok((
            request_hex(&request)?,
            http::PublishHistoryRequest {
                scope: self.scope(),
                request: B64.encode(&request.to_bytes()?),
            },
        ))
    }
    /// New device: its pending request's fingerprint, without creating one.
    pub fn history_pending(&self, directory: &Directory, time: u64) -> Result<Option<String>> {
        self.groups(directory, time)?
            .history_pending_request()?
            .map(|r| request_hex(&r))
            .transpose()
    }
    /// Sharing device: the listed requests it may answer. Entries that fail any
    /// check (another account, an unlisted or revoked device, this device, an
    /// expired window, a share claimed or committed by another) are left out.
    pub fn history_offers(
        &self,
        directory: &Directory,
        wire: &http::HistoryRequests,
        time: u64,
    ) -> Result<Vec<Offer>> {
        self.prepared(directory, time)?;
        let own = &self.0.account().device;
        if wire.scope.instance_id != self.0.account().instance
            || wire.scope.data_epoch != self.0.account().data_epoch
            || wire.requests.len() > 64
        {
            return Err(Error::Changed);
        }
        let mut offers = Vec::new();
        for entry in &wire.requests {
            if entry.committed || entry.sharer_device_id.as_ref().is_some_and(|d| d != own) {
                continue;
            }
            let Ok(bytes) = decode(&entry.request, rv_crypto_public::WIRE_LIMIT) else {
                continue;
            };
            let Ok(request) = HistoryRequest::from_bytes(&bytes) else {
                continue;
            };
            let certificate = &request.body.certificate;
            if request.verify(time).is_err()
                || directory.sibling(certificate, own).is_err()
                || entry.device_id != certificate.device.device
                || request_hex(&request)? != entry.fingerprint
            {
                continue;
            }
            offers.push(Offer {
                fingerprint: entry.fingerprint.clone(),
                device: entry.device_id.clone(),
                issued_at: request.body.issued_at,
                expires_at: request.body.expires_at,
                request,
            });
        }
        Ok(offers)
    }
    /// Sharing device: the periods it would share with this request. Nothing is
    /// drawn or recorded before the approval.
    pub fn history_preview(
        &self,
        directory: &Directory,
        offer: Offer,
        time: u64,
    ) -> Result<SharePreview> {
        directory.sibling(&offer.request.body.certificate, &self.0.account().device)?;
        let periods = self
            .groups(directory, time)?
            .history_preview(&offer.request, time)?
            .into_iter()
            .map(|p| PreviewPeriod {
                room: p.scope.room,
                documents: p.documents,
            })
            .collect();
        let can_delegate = self.state().is_ok_and(|(_, state)| state.controller);
        Ok(SharePreview {
            fingerprint: offer.fingerprint,
            device: offer.device,
            periods,
            can_delegate,
            request: offer.request,
        })
    }
    /// Sharing device: the human approved this preview; the job begins (or the
    /// one already begun for this request is kept). `delegate`: the human also
    /// hands control of the account (its private root) to that device.
    pub fn history_approve(
        &self,
        directory: &Directory,
        preview: SharePreview,
        delegate: bool,
        time: u64,
    ) -> Result<()> {
        directory.sibling(&preview.request.body.certificate, &self.0.account().device)?;
        if request_hex(&preview.request)? != preview.fingerprint
            || delegate && !(preview.can_delegate && self.state()?.1.controller)
        {
            return Err(Error::Changed);
        }
        Ok(self
            .groups(directory, time)?
            .history_share_begin(&preview.request, delegate, time)?)
    }
    /// New device: a delegated root received in a share becomes this device's
    /// root once it matches the account's exactly; the device then controls
    /// the account. Replayable; whether control was adopted.
    pub fn adopt_control(&self) -> Result<bool> {
        let (manager, _) = self.state()?;
        Ok(manager.transact(|_, records| {
            let Some(bytes) = records.remove(crate::history::DELEGATED_ROOT) else {
                return Ok(false);
            };
            let bytes = zeroize::Zeroizing::new(bytes);
            let mut state = read(records, &manager)?.ok_or(vault::Error::NotInitialized)?;
            if state.withdrawn || state.controller {
                return Ok(false);
            }
            // A root other than the account's is dropped, never adopted.
            let Ok(issuer) = crate::identity::Issuer::import(&bytes, &state.root) else {
                return Ok(false);
            };
            private(issuer.save(records))?;
            state.controller = true;
            save(records, &state)?;
            Ok(true)
        })?)
    }
    /// Sharing device: the request of the unfinished job, if any.
    pub fn history_share_pending(
        &self,
        directory: &Directory,
        time: u64,
    ) -> Result<Option<String>> {
        self.groups(directory, time)?
            .history_share_request()?
            .map(|r| request_hex(&r))
            .transpose()
    }
    /// Sharing device: the next page to upload, sealed again identically until
    /// it is recorded; none once every period is sealed.
    pub fn history_upload(&self, directory: &Directory, time: u64) -> Result<Option<Upload>> {
        let groups = self.groups(directory, time)?;
        let Some(request) = groups.history_share_request()? else {
            return Ok(None);
        };
        let Some(page) = groups.history_share_page(time)? else {
            return Ok(None);
        };
        let records = page
            .packets
            .iter()
            .map(|r| Ok(B64.encode(&r.to_bytes()?)))
            .collect::<Result<Vec<_>>>()?;
        Ok(Some(Upload {
            request: request_hex(&request)?,
            input: http::UploadHistoryRecords {
                scope: self.scope(),
                period: u32::try_from(page.period).map_err(|_| Error::Changed)?,
                start: page.start.to_string(),
                records,
            },
            start: page.start,
            count: page.packets.len() as u64,
        }))
    }
    /// Sharing device: the server holds this page; its progress is recorded.
    pub fn history_uploaded(
        &self,
        directory: &Directory,
        upload: Upload,
        receipt: &http::HistoryRecordsReceipt,
        time: u64,
    ) -> Result<()> {
        if receipt.period != upload.input.period
            || receipt.count != (upload.start + upload.count).to_string()
        {
            return Err(Error::Changed);
        }
        Ok(self.groups(directory, time)?.history_share_uploaded(
            upload.input.period as usize,
            upload.start,
            upload.count,
            time,
        )?)
    }
    /// Sharing device: the signed share, drawn once, after the last page.
    pub fn history_commit(&self, directory: &Directory, time: u64) -> Result<Commit> {
        let groups = self.groups(directory, time)?;
        let request = groups.history_share_request()?.ok_or(Error::Changed)?;
        let share = groups.history_share_finish(time)?;
        Ok(Commit {
            request: request_hex(&request)?,
            input: http::CommitHistoryShare {
                scope: self.scope(),
                share: B64.encode(&share.to_bytes()?),
            },
        })
    }
    /// Sharing device: the server committed exactly this share; the job ends.
    pub fn history_committed(
        &self,
        directory: &Directory,
        state: &http::HistoryShareState,
        time: u64,
    ) -> Result<()> {
        let groups = self.groups(directory, time)?;
        let request = groups.history_share_request()?.ok_or(Error::Changed)?;
        let share = groups.history_share_finish(time)?;
        if state.fingerprint != request_hex(&request)?
            || state.sharer_device_id != self.0.account().device
            || decode(&state.share, SHARE_LIMIT)? != share.to_bytes()?
        {
            return Err(Error::Changed);
        }
        Ok(groups.history_share_forget()?)
    }
    /// Sharing device: drops an unfinished job the server will never accept
    /// (expired or replaced request, share claimed by another device).
    pub fn history_share_abandon(&self, directory: &Directory, time: u64) -> Result<()> {
        Ok(self.groups(directory, time)?.history_share_forget()?)
    }

    /// New device: opens the committed share of another trusted device of
    /// the account and keeps it, with its period secrets, as an import job.
    pub fn history_import_begin(
        &self,
        directory: &Directory,
        state: &http::HistoryShareState,
        time: u64,
    ) -> Result<ImportStatus> {
        let share =
            Share::from_bytes(&decode(&state.share, SHARE_LIMIT)?).map_err(|_| Error::Changed)?;
        directory.sibling(&share.certificate, &self.0.account().device)?;
        if state.scope.instance_id != self.0.account().instance
            || state.scope.data_epoch != self.0.account().data_epoch
            || state.sharer_device_id != share.certificate.device.device
            || state.fingerprint != hex(&share.manifest.request)
        {
            return Err(Error::Changed);
        }
        let begun = self
            .groups(directory, time)?
            .history_import_begin(&share, time)?;
        self.adopt_control()?;
        Ok(status(begun))
    }
    /// New device: the open import, if any.
    pub fn history_import_status(
        &self,
        directory: &Directory,
        time: u64,
    ) -> Result<Option<ImportStatus>> {
        self.adopt_control()?;
        Ok(self.groups(directory, time)?.history_import()?.map(status))
    }
    /// New device: its own listed requests that no local request or import
    /// waits for any more (an import finished before its acknowledgement was
    /// sent, a replaced request). The adapter acknowledges them.
    pub fn history_acknowledgeable(
        &self,
        directory: &Directory,
        wire: &http::HistoryRequests,
        time: u64,
    ) -> Result<Vec<String>> {
        let groups = self.groups(directory, time)?;
        let pending = groups
            .history_pending_request()?
            .map(|r| request_hex(&r))
            .transpose()?;
        let importing = groups
            .history_import()?
            .map(|i| hex(&i.share.manifest.request));
        Ok(wire
            .requests
            .iter()
            .filter(|e| e.device_id == self.0.account().device)
            .filter(|e| Some(&e.fingerprint) != pending.as_ref())
            .filter(|e| Some(&e.fingerprint) != importing.as_ref())
            .map(|e| e.fingerprint.clone())
            .collect())
    }
    /// New device: verifies and stores the next downloaded page.
    pub fn history_import_page(
        &self,
        directory: &Directory,
        page: &http::HistoryRecordsPage,
        time: u64,
    ) -> Result<ImportStatus> {
        let groups = self.groups(directory, time)?;
        let current = groups.history_import()?.ok_or(Error::Changed)?;
        if current
            .next
            .map(|(p, imported)| (p as u32, imported.to_string()))
            != Some((page.period, page.start.clone()))
            || page.records.is_empty()
            || page.records.len() > PAGE_LIMIT
        {
            return Err(Error::Changed);
        }
        let records = page
            .records
            .iter()
            .map(|r| {
                Record::from_bytes(&decode(r, rv_crypto_public::archive::WIRE_LIMIT)?)
                    .map_err(|_| Error::Changed)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(status(groups.history_import_page(
            page.period as usize,
            &records,
            time,
        )?))
    }
}

#[cfg(test)]
mod tests;
