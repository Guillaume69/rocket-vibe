//! History backup on the groups side (E2EE_HISTORY_BACKUP.md, path B): this
//! device uploads its verified journal archive per period under the account
//! history key, and a device holding that key imports backed-up periods into
//! the recovered catalog. Secrets and documents stay in protected transactions.
use super::*;
use crate::account::history_backup::held;
use crate::history::{self as share, Document, Record};
use crate::history_backup::{self as backup, Checkpoint, CheckpointBody, HistoryKey, Period};
use openmls_traits::OpenMlsProvider;
use rv_crypto_public::history::{chain_next, chain_start};

const UPLOAD: &str = "crypto-history-backup-upload-v1/";
const IMPORT: &str = "crypto-history-backup-import-v1/";

/// Verified progress of one period: ranks held, positions and chain digest.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Progress {
    version: u8,
    count: u64,
    first: u64,
    last: u64,
    chain: Fingerprint,
}
fn name(prefix: &str, generation: &[u8; 16], id: &Fingerprint) -> String {
    format!(
        "{prefix}{}/{}",
        HEXLOWER.encode(generation),
        HEXLOWER.encode(id)
    )
}
fn progress(records: &Records, name: &str) -> Result<Progress> {
    match records.get(name) {
        None => Ok(Progress {
            version: 1,
            count: 0,
            first: 0,
            last: 0,
            chain: chain_start()?,
        }),
        Some(bytes) if bytes.len() <= 1024 => {
            let value: Progress = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
            if value.version != 1
                || value.count > 0 && (value.first == 0 || value.last < value.first)
            {
                return Err(Error::Changed);
            }
            Ok(value)
        }
        Some(_) => Err(Error::Limit),
    }
}
fn save(records: &mut Records, name: String, value: &Progress) -> Result<()> {
    records.insert(name, serde_json::to_vec(value).map_err(|_| Error::Changed)?);
    Ok(())
}

/// One page to upload and the checkpoint signed after it.
pub struct BackupPage {
    pub id: Fingerprint,
    pub period: Period,
    /// Ranks `start + 1 ..= start + records.len()`.
    pub start: u64,
    pub records: Vec<Record>,
    pub checkpoint: Checkpoint,
}

impl Coordinator {
    fn backup_period(
        &self,
        scope: &Scope,
        grant: &Member,
        admission: Fingerprint,
    ) -> Result<Period> {
        let incarnation: [u8; 16] = HEXLOWER
            .decode(self.manager.scope().incarnation.as_bytes())
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or(Error::Changed)?;
        Ok(Period {
            scope: scope.clone(),
            grant: grant.clone(),
            admission,
            device: self.manager.scope().device.clone(),
            incarnation,
        })
    }
    /// Seals `documents` as the next ranks after `from` and signs the
    /// checkpoint that follows them. The same inputs give the same bytes.
    #[allow(clippy::too_many_arguments)]
    fn backup_seal(
        &self,
        crypto: &impl openmls_traits::crypto::OpenMlsCrypto,
        local: &identity::enrollment::LocalDevice,
        key: &HistoryKey,
        period: &Period,
        from: &Progress,
        documents: &[Document],
        now: u64,
    ) -> Result<(Vec<Record>, Progress, Checkpoint)> {
        let secret = key.period_secret(crypto, period)?;
        let mut next = Progress {
            version: 1,
            count: from.count,
            first: from.first,
            last: from.last,
            chain: from.chain,
        };
        let mut sealed = Vec::with_capacity(documents.len());
        for document in documents {
            next.count += 1;
            let (material, key_id, nonce) = share::material(crypto, &secret, next.count)?;
            let record = share::seal_record(local, document, now, &material, key_id, nonce)?;
            let position = record.header.origin.position;
            if position <= next.last {
                return Err(Error::JournalOrder);
            }
            if next.first == 0 {
                next.first = position;
            }
            next.last = position;
            next.chain = chain_next(next.chain, record.digest()?)?;
            sealed.push(record);
        }
        let checkpoint = backup::checkpoint(
            local,
            CheckpointBody {
                version: 1,
                generation: key.generation,
                period: period.clone(),
                count: next.count,
                first: next.first,
                last: next.last,
                chain: next.chain,
            },
            now,
        )?;
        Ok((sealed, next, checkpoint))
    }
    /// The next page this device should back up, sealed again identically until
    /// it is recorded; none when every own period is up to date or the device
    /// holds no history key.
    pub fn history_backup_page(&self, now: u64) -> Result<Option<BackupPage>> {
        self.inspect_with_blobs(|provider, records, blocks| {
            let Some(key) = held(records)? else {
                return Ok(None);
            };
            let context = self.context(records, now)?;
            for (scope, grant, admission, total) in self.journal_archive_periods(records)? {
                let period = self.backup_period(&scope, &grant, admission)?;
                let id = period.id(&key.generation)?;
                let from = progress(records, &name(UPLOAD, &key.generation, &id))?;
                if from.count >= total {
                    continue;
                }
                let documents = self.page_documents(
                    records,
                    blocks,
                    (&scope, &grant, &admission, total),
                    from.count,
                    None,
                )?;
                if documents.is_empty() {
                    continue;
                }
                let (sealed, _, checkpoint) = self.backup_seal(
                    provider.crypto(),
                    &context.local,
                    &key,
                    &period,
                    &from,
                    &documents,
                    now,
                )?;
                return Ok(Some(BackupPage {
                    id,
                    period,
                    start: from.count,
                    records: sealed,
                    checkpoint,
                }));
            }
            Ok(None)
        })
    }
    /// Records a page the server now holds; progress comes from the vault.
    pub fn history_backup_uploaded(
        &self,
        id: &Fingerprint,
        start: u64,
        count: u64,
        now: u64,
    ) -> Result<()> {
        self.transact_with_blobs(|provider, records, blocks| {
            let key = held(records)?.ok_or(Error::NotReady)?;
            let context = self.context(records, now)?;
            for (scope, grant, admission, total) in self.journal_archive_periods(records)? {
                let period = self.backup_period(&scope, &grant, admission)?;
                if &period.id(&key.generation)? != id {
                    continue;
                }
                let key_name = name(UPLOAD, &key.generation, id);
                let from = progress(records, &key_name)?;
                if from.count != start || count == 0 || start + count > total {
                    return Err(Error::Changed);
                }
                let documents = self.page_documents(
                    records,
                    blocks,
                    (&scope, &grant, &admission, total),
                    start,
                    Some(count),
                )?;
                if documents.len() as u64 != count {
                    return Err(Error::Changed);
                }
                let (_, next, _) = self.backup_seal(
                    provider.crypto(),
                    &context.local,
                    &key,
                    &period,
                    &from,
                    &documents,
                    now,
                )?;
                return save(records, key_name, &next);
            }
            Err(Error::Changed)
        })
    }
    /// Imports the next records of a backed-up period, verified against the
    /// account root, the period, the rank-bound key material and, once the
    /// checkpoint's count is reached, its chain. Returns the ranks now held.
    pub fn history_backup_import(
        &self,
        checkpoint: &Checkpoint,
        start: u64,
        packets: &[Record],
        now: u64,
    ) -> Result<u64> {
        checkpoint.verify()?;
        let body = &checkpoint.body;
        let period = &body.period;
        let own = self.manager.scope();
        if checkpoint.certificate.device.root != self.root
            || period.grant.user != own.user
            || period.scope.instance != own.instance
            || period.scope.data_epoch != own.data_epoch
            || packets.is_empty()
        {
            return Err(Error::Changed);
        }
        self.transact_with_blobs(|provider, records, blocks| {
            self.context(records, now)?;
            let key = held(records)?.ok_or(Error::NotReady)?;
            if key.generation != body.generation {
                return Err(Error::Changed);
            }
            let id = period.id(&key.generation)?;
            let key_name = name(IMPORT, &key.generation, &id);
            let mut next = progress(records, &key_name)?;
            if start != next.count || next.count + packets.len() as u64 > body.count {
                return Err(Error::JournalOrder);
            }
            let secret = key.period_secret(provider.crypto(), period)?;
            let mut plaintexts = Vec::with_capacity(packets.len());
            for packet in packets {
                next.count += 1;
                packet.authenticate()?;
                let attested = &packet.certificate.device;
                let origin = &packet.header.origin;
                if attested.root != self.root
                    || attested.device != period.device
                    || attested.incarnation != period.incarnation
                    || origin.header.scope != period.scope
                    || origin.position <= next.last
                    || origin.position < body.first
                    || origin.position > body.last
                {
                    return Err(Error::Changed);
                }
                let (material, key_id, nonce) =
                    share::material(provider.crypto(), &secret, next.count)?;
                if packet.header.key_id != key_id || packet.header.nonce != nonce {
                    return Err(Error::Changed);
                }
                let message = share::open_record(packet, &material)?;
                plaintexts.push(messages::payload(&message)?);
                if next.first == 0 {
                    next.first = origin.position;
                }
                next.last = origin.position;
                next.chain = chain_next(next.chain, packet.digest()?)?;
            }
            if next.count == body.count
                && (next.chain != body.chain || next.first != body.first || next.last != body.last)
            {
                return Err(Error::Changed);
            }
            let documents = packets
                .iter()
                .cloned()
                .zip(plaintexts.iter().map(|p| p.as_slice()))
                .collect::<Vec<_>>();
            self.append_recovered(
                records,
                blocks,
                &period.scope,
                &period.grant,
                period.admission,
                id,
                body.count,
                &documents,
            )?;
            save(records, key_name, &next)?;
            Ok(next.count)
        })
    }
    /// Ranks already imported for a backed-up period.
    pub fn history_backup_imported(&self, checkpoint: &Checkpoint) -> Result<u64> {
        self.inspect(|_, records| {
            let key = held(records)?.ok_or(Error::NotReady)?;
            if key.generation != checkpoint.body.generation {
                return Err(Error::Changed);
            }
            let id = checkpoint.body.period.id(&key.generation)?;
            Ok(progress(records, &name(IMPORT, &key.generation, &id))?.count)
        })
    }
}
