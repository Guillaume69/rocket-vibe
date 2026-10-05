//! History recovery for a new device of the account (E2EE_HISTORY.md, path A).
//! The worker checks request and share certificates against the verified
//! account directory and holds the human approval; this module keeps every
//! secret and every verified document inside protected transactions.
use super::*;
use crate::history::{self as share, Document, ImportJob, PeriodPlan, Request, Share, ShareJob};
use openmls_traits::OpenMlsProvider;

const SHARE_RECORD: &str = "crypto-history-share-v1";
const IMPORT_RECORD: &str = "crypto-history-import-v1";
/// A request stays answerable for 7 days.
pub const REQUEST_LIFETIME: u64 = 7 * 86400;
/// Packets per page, and a byte budget under the server's 4 MiB page limit.
#[cfg(not(test))]
pub const PAGE_PACKETS: usize = 200;
#[cfg(test)]
pub const PAGE_PACKETS: usize = 5;
const PAGE_BYTES: usize = 3 * 1024 * 1024;

impl From<share::Error> for Error {
    fn from(error: share::Error) -> Self {
        match error {
            share::Error::Limit => Error::Limit,
            share::Error::NotRequested => Error::Receipt,
            _ => Error::Changed,
        }
    }
}

/// One period the sharing device would share.
pub struct HistoryPeriod {
    pub scope: Scope,
    pub grant: Member,
    pub admission: Fingerprint,
    pub documents: u64,
}
/// One page to upload: packets of ranks `start + 1 ..= start + packets.len()`.
pub struct HistoryPage {
    pub period: usize,
    pub start: u64,
    pub packets: Vec<crate::history::Record>,
}
/// Import progress of the new device.
pub struct HistoryImport {
    pub share: Share,
    /// Next period to download and how many of its packets are imported.
    pub next: Option<(usize, u64)>,
}

fn load_share(records: &Records) -> Result<Option<ShareJob>> {
    records
        .get(SHARE_RECORD)
        .map(|bytes| ShareJob::from_bytes(bytes).map_err(Error::from))
        .transpose()
}
fn load_import(records: &Records) -> Result<Option<ImportJob>> {
    records
        .get(IMPORT_RECORD)
        .map(|bytes| ImportJob::from_bytes(bytes).map_err(Error::from))
        .transpose()
}
fn save_share(records: &mut Records, job: &ShareJob) -> Result<()> {
    records.insert(SHARE_RECORD.into(), job.to_bytes()?.to_vec());
    Ok(())
}
fn save_import(records: &mut Records, job: &ImportJob) -> Result<()> {
    records.insert(IMPORT_RECORD.into(), job.to_bytes()?.to_vec());
    Ok(())
}

impl Coordinator {
    fn same_account(&self, certificate: &Certificate) -> Result<()> {
        if certificate.device.root != self.root
            || certificate.device.device == self.manager.scope().device
        {
            return Err(Error::Changed);
        }
        Ok(())
    }
    /// New device: its pending history request, created on first call and
    /// replayed until it expires or is answered.
    pub fn history_request(&self, now: u64) -> Result<Request> {
        self.transact(|provider, records| {
            let context = self.context(records, now)?;
            Ok(share::request(
                &context.local,
                provider.crypto(),
                records,
                now,
                REQUEST_LIFETIME,
            )?)
        })
    }
    /// New device: its pending request, without creating one.
    pub fn history_pending_request(&self) -> Result<Option<Request>> {
        self.inspect(|_, records| Ok(share::pending_request(records)?))
    }
    /// Sharing device: the periods it would share with this request. Nothing
    /// is drawn or recorded; the human approves this exact request fingerprint.
    pub fn history_preview(&self, request: &Request, now: u64) -> Result<Vec<HistoryPeriod>> {
        request.verify(now)?;
        self.same_account(&request.body.certificate)?;
        self.inspect(|_, records| {
            self.context(records, now)?;
            Ok(self
                .journal_archive_periods(records)?
                .into_iter()
                .map(|(scope, grant, admission, documents)| HistoryPeriod {
                    scope,
                    grant,
                    admission,
                    documents,
                })
                .collect())
        })
    }
    /// Sharing device: begins the approved share, or keeps the one already
    /// begun for this request. Another request's unfinished job is replaced.
    pub fn history_share_begin(&self, request: &Request, now: u64) -> Result<()> {
        request.verify(now)?;
        self.same_account(&request.body.certificate)?;
        self.transact(|_, records| {
            if load_share(records)?.is_some_and(|job| job.request() == request) {
                return Ok(());
            }
            let context = self.context(records, now)?;
            let plans = self
                .journal_archive_periods(records)?
                .into_iter()
                .map(|(scope, grant, admission, total)| PeriodPlan {
                    scope,
                    grant,
                    admission,
                    total,
                })
                .collect();
            let job = ShareJob::new(&context.local, request, plans, now)?;
            if job.next().is_none() {
                return Err(Error::NotReady);
            }
            save_share(records, &job)
        })
    }
    /// The documents of one page: as many next ranks as fit the page budget.
    fn page_documents(
        &self,
        records: &Records,
        blocks: &vault::blobs::Access<'_>,
        job: &ShareJob,
        period: usize,
        start: u64,
        count: Option<u64>,
    ) -> Result<Vec<Document>> {
        let (scope, grant, admission, total) = job.binding(period).ok_or(Error::Changed)?;
        let room = read(records, &scope.room)?.ok_or(Error::NotReady)?;
        let plan = &room.active.as_ref().ok_or(Error::NotReady)?.transition.plan;
        let to = start + count.unwrap_or(PAGE_PACKETS as u64).min(total - start);
        let archived = self.journal_archive_documents(
            records,
            blocks,
            scope,
            grant,
            *admission,
            start + 1,
            to,
        )?;
        let mut documents = Vec::with_capacity(archived.len());
        let mut bytes = 0usize;
        for item in archived {
            // Older nodes did not record the author's membership: the current
            // plan stands in while the author is still a member.
            let membership = match item.author {
                Some(member) => member,
                None => plan
                    .members
                    .iter()
                    .find(|m| m.user == item.origin.header.author)
                    .cloned()
                    .ok_or(Error::MessageNotRetained)?,
            };
            bytes += item.message.text.len() + 2048;
            if count.is_none() && !documents.is_empty() && bytes > PAGE_BYTES {
                break;
            }
            documents.push(Document {
                origin: item.origin,
                original_certificate: item.certificate,
                membership,
                message: item.message,
            });
        }
        Ok(documents)
    }
    /// Sharing device: the next page to upload, sealed again identically until
    /// it is recorded; none once every period is sealed.
    pub fn history_share_page(&self, now: u64) -> Result<Option<HistoryPage>> {
        self.inspect_with_blobs(|provider, records, blocks| {
            let job = load_share(records)?.ok_or(Error::NotReady)?;
            let Some((period, start)) = job.next() else {
                return Ok(None);
            };
            let context = self.context(records, now)?;
            let documents = self.page_documents(records, blocks, &job, period, start, None)?;
            let page = job.seal_page(provider.crypto(), &context.local, period, &documents, now)?;
            Ok(Some(HistoryPage {
                period,
                start: page.start,
                packets: page.packets,
            }))
        })
    }
    /// Sharing device: records a page the server now holds. The page is sealed
    /// again from the job, so its progress comes from the vault, not the caller.
    pub fn history_share_uploaded(
        &self,
        period: usize,
        start: u64,
        count: u64,
        now: u64,
    ) -> Result<()> {
        self.transact_with_blobs(|provider, records, blocks| {
            let mut job = load_share(records)?.ok_or(Error::NotReady)?;
            if job.next() != Some((period, start)) || count == 0 {
                return Err(Error::Changed);
            }
            let context = self.context(records, now)?;
            let documents =
                self.page_documents(records, blocks, &job, period, start, Some(count))?;
            if documents.len() as u64 != count {
                return Err(Error::Changed);
            }
            let page = job.seal_page(provider.crypto(), &context.local, period, &documents, now)?;
            job.advance(&page)?;
            save_share(records, &job)
        })
    }
    /// Sharing device: the signed share once every page is uploaded. The
    /// envelope is drawn once; a lost commit response gets the same share.
    pub fn history_share_finish(&self, now: u64) -> Result<Share> {
        self.transact(|provider, records| {
            let mut job = load_share(records)?.ok_or(Error::NotReady)?;
            let context = self.context(records, now)?;
            let share = job.finish(provider.crypto(), &context.local, now)?;
            save_share(records, &job)?;
            Ok(share)
        })
    }
    /// Sharing device: the request its unfinished job answers, if any.
    pub fn history_share_request(&self) -> Result<Option<Request>> {
        self.inspect(|_, records| Ok(load_share(records)?.map(|job| job.request().clone())))
    }
    /// Sharing device: forgets the job once the server accepted the share.
    pub fn history_share_forget(&self) -> Result<()> {
        self.transact(|_, records| {
            if let Some(mut bytes) = records.remove(SHARE_RECORD) {
                zeroize::Zeroize::zeroize(&mut bytes);
            }
            Ok(())
        })
    }
    /// New device: opens the share answering its pending request and keeps it,
    /// with its period secrets, as an import job. Replays keep the first one.
    pub fn history_import_begin(&self, received: &Share, now: u64) -> Result<HistoryImport> {
        self.same_account(&received.certificate)?;
        self.transact(|provider, records| {
            self.context(records, now)?;
            if let Some(job) = load_import(records)? {
                if job.share() != received {
                    return Err(Error::Conflict);
                }
                return Ok(HistoryImport {
                    share: job.share().clone(),
                    next: job.next(),
                });
            }
            let job = ImportJob::open(provider.crypto(), records, received, now)?;
            save_import(records, &job)?;
            Ok(HistoryImport {
                share: job.share().clone(),
                next: job.next(),
            })
        })
    }
    /// New device: the import job's progress, if one is open.
    pub fn history_import(&self) -> Result<Option<HistoryImport>> {
        self.inspect(|_, records| {
            Ok(load_import(records)?.map(|job| HistoryImport {
                share: job.share().clone(),
                next: job.next(),
            }))
        })
    }
    /// New device: verifies the next packets of `period` and stores their
    /// documents with the job's progress, in one protected transaction. Once
    /// every period is complete, the request, its key and the period secrets
    /// are forgotten; the recovered documents stay.
    pub fn history_import_page(
        &self,
        period: usize,
        packets: &[crate::history::Record],
        now: u64,
    ) -> Result<HistoryImport> {
        self.transact_with_blobs(|provider, records, blocks| {
            self.context(records, now)?;
            let mut job = load_import(records)?.ok_or(Error::NotReady)?;
            let messages = job.accept(provider.crypto(), period, packets)?;
            let entry = job
                .share()
                .manifest
                .periods
                .get(period)
                .ok_or(Error::Changed)?
                .clone();
            let sharer = job.share().certificate.fingerprint()?;
            let plaintexts = messages
                .iter()
                .map(messages::payload)
                .collect::<Result<Vec<_>>>()?;
            let documents = packets
                .iter()
                .cloned()
                .zip(plaintexts.iter().map(|p| p.as_slice()))
                .collect::<Vec<_>>();
            self.append_recovered(
                records,
                blocks,
                &entry.scope,
                &entry.grant,
                entry.admission,
                sharer,
                entry.count,
                &documents,
            )?;
            let progress = HistoryImport {
                share: job.share().clone(),
                next: job.next(),
            };
            if progress.next.is_none() {
                share::forget_request(records);
                if let Some(mut bytes) = records.remove(IMPORT_RECORD) {
                    zeroize::Zeroize::zeroize(&mut bytes);
                }
            } else {
                save_import(records, &job)?;
            }
            Ok(progress)
        })
    }
}
