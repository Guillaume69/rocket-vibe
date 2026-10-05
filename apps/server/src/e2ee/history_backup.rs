//! History backup (E2EE_HISTORY_BACKUP.md, path B). The server keeps the
//! history key package sealed under the history code, behind a device-signed
//! publication with compare-and-swap, and the periods of history records each
//! device uploads under keys derived from it, with their signed checkpoints.
//! It never sees the code, the key or a document.
use super::*;
use rv_crypto_public::history::{Record, chain_next};
use rv_crypto_public::history_backup::{Checkpoint, PUBLICATION_LIMIT, Publication};

pub const PAGE_RECORDS: usize = 200;
const PAGE_BYTES: usize = 4 * 1024 * 1024;
/// Raw bytes per downloaded page, under the clients' 4 MiB crypto body limit.
const DOWNLOAD_BYTES: usize = 2816 * 1024;
const DAILY_GENERATIONS: i64 = 4;
const KEPT_GENERATIONS: i64 = 4;
const ACCOUNT_RECORDS: i64 = 1_000_000;
const ACCOUNT_BYTES: i64 = 2 * 1024 * 1024 * 1024;
const PERIOD_PAGE: i64 = 100;

fn cancelled() -> Error {
    Error::new(StatusCode::CONFLICT, "history_key_cancelled")
}
fn gap() -> Error {
    Error::new(StatusCode::CONFLICT, "history_record_gap")
}
fn fingerprint_hex(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::invalid());
    }
    Ok(())
}
fn generation_hex(value: &str) -> Result<()> {
    if value.len() != 32
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::invalid());
    }
    Ok(())
}
async fn current_scope(tx: &mut Transaction<'_, Postgres>) -> Result<Scope> {
    let (instance_id, data_epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR KEY SHARE")
            .fetch_one(&mut **tx)
            .await?;
    Ok(Scope {
        instance_id,
        data_epoch,
    })
}
/// The session device's registered, unrevoked certificate and revision.
async fn registered(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
) -> Result<(Certificate, i64)> {
    let row: Option<(String, Vec<u8>, i64)> = sqlx::query_as(
        "SELECT incarnation,certificate,revision FROM e2ee_devices WHERE device_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(device)
    .bind(&actor.id)
    .fetch_optional(&mut **tx)
    .await?;
    let (incarnation, bytes, revision) = row.ok_or_else(revoked)?;
    let withdrawn: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e2ee_revocations WHERE user_id=$1 AND device_id=$2 AND incarnation=$3)")
        .bind(&actor.id).bind(device).bind(&incarnation).fetch_one(&mut **tx).await?;
    if withdrawn {
        return Err(revoked());
    }
    Ok((
        serde_json::from_slice(&bytes).map_err(|_| Error::internal())?,
        revision,
    ))
}

async fn saved_cancellation(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
    operation: &str,
    fingerprint: Option<&str>,
) -> Result<Option<wire::HistoryKeyCancellation>> {
    let row: Option<(String, serde_json::Value)> = sqlx::query_as("SELECT fingerprint,receipt FROM e2ee_history_key_cancellations WHERE user_id=$1 AND device_id=$2 AND operation_id=$3")
        .bind(&actor.id).bind(device).bind(operation).fetch_optional(&mut **tx).await?;
    match row {
        Some((old, value)) if fingerprint.is_none_or(|fp| fp == old) => Ok(Some(
            serde_json::from_value(value).map_err(|_| Error::internal())?,
        )),
        Some(_) => Err(Error::conflict()),
        None => Ok(None),
    }
}
async fn saved_key(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
    operation: &str,
    fingerprint: Option<&str>,
) -> Result<Option<wire::HistoryKeyReceipt>> {
    let row: Option<(String, serde_json::Value)> = sqlx::query_as("SELECT fingerprint,receipt FROM e2ee_history_key_operations WHERE user_id=$1 AND device_id=$2 AND operation_id=$3")
        .bind(&actor.id).bind(device).bind(operation).fetch_optional(&mut **tx).await?;
    match row {
        Some((old, value)) if fingerprint.is_none_or(|fp| fp == old) => Ok(Some(
            serde_json::from_value(value).map_err(|_| Error::internal())?,
        )),
        Some(_) => Err(Error::conflict()),
        None => Ok(None),
    }
}
async fn publish_result(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
    operation: &str,
    fingerprint: &str,
) -> Result<Option<wire::HistoryKeyReceipt>> {
    if let Some(receipt) = saved_key(tx, actor, device, operation, Some(fingerprint)).await? {
        return Ok(Some(receipt));
    }
    if saved_cancellation(tx, actor, device, operation, Some(fingerprint))
        .await?
        .is_some()
    {
        return Err(cancelled());
    }
    Ok(None)
}
async fn decoded(app: &App, input: &wire::PublishHistoryKey) -> Result<Publication> {
    let encoded = input.publication.clone();
    let p = verify(app, move || {
        Publication::from_bytes(&decode(&encoded, PUBLICATION_LIMIT)?).map_err(|_| proof())
    })
    .await?;
    if p.body.scope.instance != input.scope.instance_id
        || p.body.scope.data_epoch != input.scope.data_epoch
        || p.body.operation != input.operation_id
    {
        return Err(proof());
    }
    Ok(p)
}
/// The active key package of this account.
pub async fn current(app: &App, actor: &Account) -> Result<wire::HistoryKeyState> {
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let scope = current_scope(&mut tx).await?;
    let row: Option<(Vec<u8>, serde_json::Value)> =
        sqlx::query_as("SELECT publication,receipt FROM e2ee_history_keys WHERE user_id=$1")
            .bind(&actor.id)
            .fetch_optional(&mut *tx)
            .await?;
    let active = row
        .map(|(publication, receipt)| -> Result<_> {
            Ok(wire::HistoryKeyVersion {
                publication: B64.encode(&publication),
                receipt: serde_json::from_value(receipt).map_err(|_| Error::invalid())?,
            })
        })
        .transpose()?;
    tx.commit().await?;
    Ok(wire::HistoryKeyState { scope, active })
}
/// The original receipt of this device's publication.
pub async fn operation(
    app: &App,
    actor: &Account,
    operation: &str,
) -> Result<wire::HistoryKeyReceipt> {
    if !auth::identifier(operation) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let scope = current_scope(&mut tx).await?;
    let (device, _) = lock_scope(&mut tx, actor, &scope).await?;
    let receipt = match saved_key(&mut tx, actor, &device, operation, None).await? {
        Some(receipt) => receipt,
        None => {
            if saved_cancellation(&mut tx, actor, &device, operation, None)
                .await?
                .is_some()
            {
                return Err(cancelled());
            }
            return Err(Error::missing());
        }
    };
    tx.commit().await?;
    Ok(receipt)
}
/// A new history key generation, signed by the session device's registered
/// leaf, replacing the active one by compare-and-swap.
pub async fn publish(
    app: &App,
    actor: &Account,
    input: wire::PublishHistoryKey,
) -> Result<wire::HistoryKeyReceipt> {
    validate_scope(&input.scope, &input.operation_id)?;
    let fingerprint = intent("history_key", &input)?;
    let mut initial = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut initial, actor, &input.scope).await?;
    if let Some(receipt) = publish_result(
        &mut initial,
        actor,
        &device,
        &input.operation_id,
        &fingerprint,
    )
    .await?
    {
        initial.commit().await?;
        return Ok(receipt);
    }
    initial.commit().await?;
    let publication = decoded(app, &input).await?;
    let mut tx = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut tx, actor, &input.scope).await?;
    let root: Option<(Vec<u8>, String)> =
        sqlx::query_as("SELECT root,fingerprint FROM e2ee_identities WHERE user_id=$1 FOR UPDATE")
            .bind(&actor.id)
            .fetch_optional(&mut *tx)
            .await?;
    let (root, root_fingerprint) = root.ok_or_else(changed)?;
    if let Some(receipt) =
        publish_result(&mut tx, actor, &device, &input.operation_id, &fingerprint).await?
    {
        tx.commit().await?;
        return Ok(receipt);
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_history_key_operations WHERE user_id=$1 AND created_at>clock_timestamp()-interval '1 day'")
        .bind(&actor.id).fetch_one(&mut *tx).await?;
    if count >= DAILY_GENERATIONS {
        return Err(Error::throttled("history_key_limit", 3600));
    }
    let (certificate, device_revision) = registered(&mut tx, actor, &device).await?;
    let body = &publication.body;
    let header = &publication.package.header;
    publication.verify(&certificate).map_err(|_| proof())?;
    if body.device != device
        || device_revision.to_string() != body.device_revision
        || header.root.user != actor.id
        || root != serde_json::to_vec(&header.root).map_err(|_| proof())?
    {
        return Err(changed());
    }
    let previous: Option<i64> =
        sqlx::query_scalar("SELECT revision FROM e2ee_history_keys WHERE user_id=$1 FOR UPDATE")
            .bind(&actor.id)
            .fetch_optional(&mut *tx)
            .await?;
    if previous.map(|r| r.to_string()) != body.expected_revision {
        return Err(Error::new(
            StatusCode::CONFLICT,
            "history_key_revision_conflict",
        ));
    }
    let next = previous.unwrap_or(0).checked_add(1).ok_or_else(revision)?;
    let generation = hex(&header.generation);
    let receipt = wire::HistoryKeyReceipt {
        scope: input.scope,
        operation_id: input.operation_id,
        device_id: device,
        incarnation: hex(&body.incarnation),
        device_revision: body.device_revision.clone(),
        root_fingerprint,
        generation: generation.clone(),
        generation_revision: next.to_string(),
        package_digest: hex(&body.package_digest),
    };
    let value = serde_json::to_value(&receipt).map_err(|_| proof())?;
    sqlx::query("INSERT INTO e2ee_history_keys(user_id,revision,generation,publication,receipt) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,generation=EXCLUDED.generation,publication=EXCLUDED.publication,receipt=EXCLUDED.receipt")
        .bind(&actor.id).bind(next).bind(&generation).bind(publication.to_bytes().map_err(|_| proof())?).bind(&value).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO e2ee_history_key_generations(user_id,generation,revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
        .bind(&actor.id).bind(&generation).bind(next).execute(&mut *tx).await?;
    // Older generations beyond the kept ones go, with their periods.
    sqlx::query("DELETE FROM e2ee_history_key_generations WHERE user_id=$1 AND revision<=$2-$3")
        .bind(&actor.id)
        .bind(next)
        .bind(KEPT_GENERATIONS)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO e2ee_history_key_operations(user_id,device_id,operation_id,fingerprint,receipt) VALUES($1,$2,$3,$4,$5)")
        .bind(&actor.id).bind(&receipt.device_id).bind(&receipt.operation_id).bind(fingerprint).bind(value).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(receipt)
}
/// Terminal settlement of this device's publication intent: an accepted
/// generation wins; cancelling never removes it.
pub async fn cancel(
    app: &App,
    actor: &Account,
    operation: &str,
    input: wire::PublishHistoryKey,
) -> Result<wire::HistoryKeySettlement> {
    validate_scope(&input.scope, &input.operation_id)?;
    if input.operation_id != operation {
        return Err(Error::invalid());
    }
    let fingerprint = intent("history_key", &input)?;
    let p = decoded(app, &input).await?;
    let mut tx = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut tx, actor, &input.scope).await?;
    sqlx::query("SELECT 1 FROM e2ee_identities WHERE user_id=$1 FOR UPDATE")
        .bind(&actor.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(changed)?;
    if let Some(receipt) = saved_key(&mut tx, actor, &device, operation, Some(&fingerprint)).await?
    {
        tx.commit().await?;
        return Ok(wire::HistoryKeySettlement::Accepted(receipt));
    }
    if let Some(receipt) =
        saved_cancellation(&mut tx, actor, &device, operation, Some(&fingerprint)).await?
    {
        tx.commit().await?;
        return Ok(wire::HistoryKeySettlement::Cancelled(receipt));
    }
    if p.package.header.root.user != actor.id || p.body.device != device {
        return Err(proof());
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_history_key_cancellations WHERE user_id=$1 AND device_id=$2 AND created_at>clock_timestamp()-interval '1 day'")
        .bind(&actor.id).bind(&device).fetch_one(&mut *tx).await?;
    if count >= 64 {
        return Err(Error::throttled("history_key_cancellation_limit", 3600));
    }
    let receipt = wire::HistoryKeyCancellation {
        scope: input.scope,
        operation_id: operation.into(),
        device_id: device.clone(),
        incarnation: hex(&p.body.incarnation),
        device_revision: p.body.device_revision.clone(),
        root_fingerprint: hex(&p.package.header.root.fingerprint().map_err(|_| proof())?),
        generation: hex(&p.package.header.generation),
        expected_revision: p.body.expected_revision.clone(),
        package_digest: hex(&p.body.package_digest),
    };
    sqlx::query("INSERT INTO e2ee_history_key_cancellations(user_id,device_id,operation_id,fingerprint,receipt) VALUES($1,$2,$3,$4,$5)")
        .bind(&actor.id).bind(&device).bind(operation).bind(fingerprint).bind(serde_json::to_value(&receipt).map_err(|_| Error::internal())?).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(wire::HistoryKeySettlement::Cancelled(receipt))
}

/// Backed-up periods of a generation with their latest checkpoints.
pub async fn periods(
    app: &App,
    actor: &Account,
    generation: &str,
    after: Option<&str>,
) -> Result<wire::HistoryBackupPeriods> {
    generation_hex(generation)?;
    if let Some(after) = after {
        fingerprint_hex(after)?;
    }
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let scope = current_scope(&mut tx).await?;
    let rows: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT period,checkpoint FROM e2ee_history_backup_periods WHERE user_id=$1 AND generation=$2 AND period>$3 ORDER BY period LIMIT $4",
    )
    .bind(&actor.id)
    .bind(generation)
    .bind(after.unwrap_or(""))
    .bind(PERIOD_PAGE + 1)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let more = rows.len() as i64 > PERIOD_PAGE;
    let periods: Vec<_> = rows
        .into_iter()
        .take(PERIOD_PAGE as usize)
        .map(|(period, checkpoint)| wire::HistoryBackupPeriod {
            period,
            checkpoint: B64.encode(&checkpoint),
        })
        .collect();
    let next = more
        .then(|| periods.last().map(|p| p.period.clone()))
        .flatten();
    Ok(wire::HistoryBackupPeriods {
        scope,
        generation: generation.into(),
        periods,
        next,
    })
}

struct Checked {
    position: i64,
    digest: [u8; 32],
    bytes: Vec<u8>,
    record: Record,
}
/// Stores the next records of this device's period and their checkpoint.
pub async fn upload(
    app: &App,
    actor: &Account,
    period: &str,
    input: wire::UploadHistoryBackup,
) -> Result<wire::HistoryBackupReceipt> {
    fingerprint_hex(period)?;
    check_scope(&input.scope)?;
    let start = decimal(&input.start)?;
    if input.records.is_empty() || input.records.len() > PAGE_RECORDS {
        return Err(Error::invalid());
    }
    let (encoded, checkpoint_text) = (input.records.clone(), input.checkpoint.clone());
    let (checkpoint, checkpoint_bytes, checked) = verify(app, move || {
        let checkpoint =
            Checkpoint::from_bytes(&decode(&checkpoint_text, 8192)?).map_err(|_| proof())?;
        let checkpoint_bytes = checkpoint.to_bytes().map_err(|_| proof())?;
        let mut total = 0;
        let mut checked = Vec::with_capacity(encoded.len());
        for value in &encoded {
            let record = Record::from_bytes(&decode(value, rv_crypto_public::archive::WIRE_LIMIT)?)
                .map_err(|_| proof())?;
            record.authenticate().map_err(|_| proof())?;
            let bytes = record.to_bytes().map_err(|_| proof())?;
            total += bytes.len();
            if total > PAGE_BYTES {
                return Err(Error::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "crypto_body_too_large",
                ));
            }
            checked.push(Checked {
                position: i64::try_from(record.header.origin.position).map_err(|_| proof())?,
                digest: record.digest().map_err(|_| proof())?,
                bytes,
                record,
            });
        }
        Ok((checkpoint, checkpoint_bytes, checked))
    })
    .await?;
    let body = &checkpoint.body;
    let room = body.period.scope.room.clone();
    let generation = hex(&body.generation);
    if hex(&body.period.id(&body.generation).map_err(|_| proof())?) != period
        || body.period.scope.instance != input.scope.instance_id
        || body.period.scope.data_epoch != input.scope.data_epoch
        || body.period.grant.user != actor.id
    {
        return Err(proof());
    }
    for item in &checked {
        if item.record.certificate != checkpoint.certificate
            || item.record.header.origin.header.scope != body.period.scope
        {
            return Err(proof());
        }
    }
    let mut tx = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut tx, actor, &input.scope).await?;
    let (certificate, _) = registered(&mut tx, actor, &device).await?;
    if checkpoint.certificate != certificate || body.period.device != device {
        return Err(proof());
    }
    let known: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM e2ee_history_key_generations WHERE user_id=$1 AND generation=$2)",
    )
    .bind(&actor.id)
    .bind(&generation)
    .fetch_one(&mut *tx)
    .await?;
    if !known {
        return Err(Error::missing());
    }
    crate::store::require_member(&mut tx, &room, &actor.id).await?;
    let held: Option<(i64, i64, Vec<u8>)> = sqlx::query_as(
        "SELECT count,last_position,chain FROM e2ee_history_backup_periods WHERE user_id=$1 AND period=$2 FOR UPDATE",
    )
    .bind(&actor.id)
    .bind(period)
    .fetch_optional(&mut *tx)
    .await?;
    let (count, last, chain) = match &held {
        Some((count, last, chain)) => (
            *count,
            Some(*last),
            <[u8; 32]>::try_from(chain.as_slice()).map_err(|_| Error::internal())?,
        ),
        None => (
            0,
            None,
            rv_crypto_public::history::chain_start().map_err(|_| Error::internal())?,
        ),
    };
    // A page already held is accepted again unchanged.
    let end = start + checked.len() as i64;
    if end <= count {
        let held: Vec<String> = sqlx::query_scalar(
            "SELECT digest FROM e2ee_history_backup_records WHERE user_id=$1 AND period=$2 AND rank>$3 ORDER BY rank LIMIT $4",
        )
        .bind(&actor.id)
        .bind(period)
        .bind(start)
        .bind(checked.len() as i64)
        .fetch_all(&mut *tx)
        .await?;
        if held.len() != checked.len()
            || held.iter().zip(&checked).any(|(h, c)| *h != hex(&c.digest))
        {
            return Err(Error::conflict());
        }
        tx.commit().await?;
        return Ok(wire::HistoryBackupReceipt {
            period: period.into(),
            count: count.to_string(),
        });
    }
    if start != count || body.count != end as u64 {
        return Err(gap());
    }
    let mut next_chain = chain;
    let mut previous = last;
    for item in &checked {
        if previous.is_some_and(|p| item.position <= p) {
            return Err(gap());
        }
        previous = Some(item.position);
        next_chain = chain_next(next_chain, item.digest).map_err(|_| Error::internal())?;
    }
    if next_chain != body.chain
        || previous.map(|p| p as u64) != Some(body.last)
        || held.is_none() && checked.first().map(|c| c.position as u64) != Some(body.first)
    {
        return Err(proof());
    }
    let added: i64 = checked.iter().map(|c| c.bytes.len() as i64).sum();
    let (records, bytes): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM e2ee_history_backup_records WHERE user_id=$1),COALESCE((SELECT sum(bytes)::bigint FROM e2ee_history_backup_periods WHERE user_id=$1),0)",
    )
    .bind(&actor.id)
    .fetch_one(&mut *tx)
    .await?;
    if records + checked.len() as i64 > ACCOUNT_RECORDS || bytes + added > ACCOUNT_BYTES {
        return Err(Error::throttled("history_backup_limit", 3600));
    }
    sqlx::query("INSERT INTO e2ee_history_backup_periods(user_id,period,generation,device_id,room_id,count,last_position,chain,checkpoint,bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,period) DO UPDATE SET count=EXCLUDED.count,last_position=EXCLUDED.last_position,chain=EXCLUDED.chain,checkpoint=EXCLUDED.checkpoint,bytes=e2ee_history_backup_periods.bytes+EXCLUDED.bytes")
        .bind(&actor.id).bind(period).bind(&generation).bind(&device).bind(&room).bind(end)
        .bind(previous.unwrap_or_default()).bind(next_chain.as_slice()).bind(&checkpoint_bytes).bind(added)
        .execute(&mut *tx).await?;
    for (offset, item) in checked.iter().enumerate() {
        sqlx::query("INSERT INTO e2ee_history_backup_records(user_id,period,rank,digest,record) VALUES($1,$2,$3,$4,$5)")
            .bind(&actor.id).bind(period).bind(start + 1 + offset as i64).bind(hex(&item.digest)).bind(&item.bytes)
            .execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(wire::HistoryBackupReceipt {
        period: period.into(),
        count: end.to_string(),
    })
}
fn check_scope(scope: &Scope) -> Result<()> {
    if !auth::identifier(&scope.instance_id) || !auth::identifier(&scope.data_epoch) {
        return Err(Error::invalid());
    }
    Ok(())
}
/// The room of a backed-up period, for the read proof.
pub async fn period_room(app: &App, actor: &Account, period: &str) -> Result<String> {
    fingerprint_hex(period)?;
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let room: Option<String> = sqlx::query_scalar(
        "SELECT room_id FROM e2ee_history_backup_periods WHERE user_id=$1 AND period=$2",
    )
    .bind(&actor.id)
    .bind(period)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    room.ok_or_else(Error::missing)
}
/// Records of a backed-up period after rank `after`, for any device of the
/// account while the account can still read the room.
pub async fn records(
    app: &App,
    actor: &Account,
    period: &str,
    after: &str,
    limit: usize,
) -> Result<wire::HistoryBackupPage> {
    fingerprint_hex(period)?;
    let after = decimal(after)?;
    if limit == 0 || limit > PAGE_RECORDS {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let scope = current_scope(&mut tx).await?;
    lock_scope(&mut tx, actor, &scope).await?;
    let room: String = sqlx::query_scalar(
        "SELECT room_id FROM e2ee_history_backup_periods WHERE user_id=$1 AND period=$2 FOR SHARE",
    )
    .bind(&actor.id)
    .bind(period)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(Error::missing)?;
    crate::store::require_member(&mut tx, &room, &actor.id).await?;
    let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT rank,record FROM e2ee_history_backup_records WHERE user_id=$1 AND period=$2 AND rank>$3 ORDER BY rank LIMIT $4",
    )
    .bind(&actor.id)
    .bind(period)
    .bind(after)
    .bind(limit as i64 + 1)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let fetched = rows.len();
    let mut page = Vec::new();
    let mut total = 0;
    let mut end = after;
    for (rank, record) in rows.into_iter().take(limit) {
        total += record.len();
        if !page.is_empty() && total > DOWNLOAD_BYTES {
            break;
        }
        end = rank;
        page.push(B64.encode(&record));
    }
    Ok(wire::HistoryBackupPage {
        period: period.into(),
        start: after.to_string(),
        next: (page.len() < fetched).then(|| end.to_string()),
        records: page,
    })
}
