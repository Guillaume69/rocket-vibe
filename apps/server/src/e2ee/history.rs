//! History shares between devices of one account (E2EE_HISTORY.md, path A).
//! The server keeps signed opaque bytes and decides who may write or read them;
//! period secrets, recipient keys and documents never reach it. Trust in the
//! sharing device and the human approval stay on the devices.
use super::*;
use rv_crypto_public::history::{Record, Request as HistoryRequest, SHARE_LIMIT, Share, chain};

/// Records per page and raw bytes per page, as in the specification.
pub const PAGE_RECORDS: usize = 200;
pub const PAGE_BYTES: usize = 4 * 1024 * 1024;
/// Raw bytes per downloaded page: base64 keeps the response under the clients'
/// 4 MiB crypto body limit.
const DOWNLOAD_BYTES: usize = 2816 * 1024;
const SHARE_RECORDS: i64 = 100_000;
const SHARE_BYTES: i64 = 512 * 1024 * 1024;
const DAILY_REQUESTS: i64 = 16;
/// A committed share stays downloadable for 7 days.
const RETENTION: i64 = 7 * 86400;

fn claimed() -> Error {
    Error::new(StatusCode::CONFLICT, "history_share_claimed")
}
fn committed() -> Error {
    Error::new(StatusCode::CONFLICT, "history_share_committed")
}
fn incomplete() -> Error {
    Error::new(StatusCode::CONFLICT, "history_share_incomplete")
}
fn gap() -> Error {
    Error::new(StatusCode::CONFLICT, "history_record_gap")
}
fn own_request() -> Error {
    Error::new(StatusCode::FORBIDDEN, "history_own_request")
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
fn check_scope(scope: &Scope) -> Result<()> {
    if !auth::identifier(&scope.instance_id) || !auth::identifier(&scope.data_epoch) {
        return Err(Error::invalid());
    }
    Ok(())
}
fn timestamp(seconds: i64) -> Result<chrono::DateTime<Utc>> {
    chrono::DateTime::from_timestamp(seconds, 0).ok_or_else(Error::invalid)
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
/// Forgets this account's requests past their retention, with their shares.
async fn expire(tx: &mut Transaction<'_, Postgres>, actor: &Account) -> Result<()> {
    sqlx::query(
        "DELETE FROM e2ee_history_requests WHERE user_id=$1 AND retained_until<=clock_timestamp()",
    )
    .bind(&actor.id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
/// The session device's registered, unrevoked certificate.
async fn current_certificate(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
) -> Result<Certificate> {
    let row: Option<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT incarnation,certificate FROM e2ee_devices WHERE device_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(device)
    .bind(&actor.id)
    .fetch_optional(&mut **tx)
    .await?;
    let (incarnation, bytes) = row.ok_or_else(revoked)?;
    let withdrawn: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e2ee_revocations WHERE user_id=$1 AND device_id=$2 AND incarnation=$3)")
        .bind(&actor.id).bind(device).bind(&incarnation).fetch_one(&mut **tx).await?;
    if withdrawn {
        return Err(revoked());
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::internal())
}
struct Pending {
    device: String,
    request: HistoryRequest,
    expires_at: chrono::DateTime<Utc>,
}
/// A request of this account, locked for the share's writers.
async fn pending(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    fingerprint: &str,
    write: bool,
) -> Result<Pending> {
    let query = if write {
        "SELECT device_id,request,expires_at FROM e2ee_history_requests WHERE fingerprint=$1 AND user_id=$2 FOR UPDATE"
    } else {
        "SELECT device_id,request,expires_at FROM e2ee_history_requests WHERE fingerprint=$1 AND user_id=$2 FOR SHARE"
    };
    let row: Option<(String, Vec<u8>, chrono::DateTime<Utc>)> = sqlx::query_as(query)
        .bind(fingerprint)
        .bind(&actor.id)
        .fetch_optional(&mut **tx)
        .await?;
    let (device, bytes, expires_at) = row.ok_or_else(Error::missing)?;
    Ok(Pending {
        device,
        request: HistoryRequest::from_bytes(&bytes).map_err(|_| Error::internal())?,
        expires_at,
    })
}
fn entry(
    fingerprint: String,
    device_id: String,
    request: Vec<u8>,
    expires_at: chrono::DateTime<Utc>,
    sharer: Option<String>,
    committed: bool,
) -> wire::HistoryRequestEntry {
    wire::HistoryRequestEntry {
        fingerprint,
        device_id,
        request: B64.encode(&request),
        expires_at: expires_at.timestamp().to_string(),
        sharer_device_id: sharer,
        committed,
    }
}

/// New device: publishes its signed request, replacing its previous one and
/// that one's share. Replaying the same request returns it unchanged.
pub async fn publish_request(
    app: &App,
    actor: &Account,
    input: wire::PublishHistoryRequest,
) -> Result<wire::HistoryRequestEntry> {
    check_scope(&input.scope)?;
    let encoded = input.request.clone();
    let (request, fingerprint, bytes) = verify(app, move || {
        let request = HistoryRequest::from_bytes(&decode(&encoded, rv_crypto_public::WIRE_LIMIT)?)
            .map_err(|_| proof())?;
        let now = u64::try_from(Utc::now().timestamp()).map_err(|_| Error::internal())?;
        request.verify(now).map_err(|_| proof())?;
        let fingerprint = hex(&request.fingerprint().map_err(|_| proof())?);
        let bytes = request.to_bytes().map_err(|_| proof())?;
        Ok((request, fingerprint, bytes))
    })
    .await?;
    let mut tx = app.pool.begin().await?;
    let (device, now) = lock_scope(&mut tx, actor, &input.scope).await?;
    expire(&mut tx, actor).await?;
    let certificate = current_certificate(&mut tx, actor, &device).await?;
    let own = &request.body.certificate.device;
    if request.body.certificate != certificate
        || own.device != device
        || own.root.user != actor.id
        || own.root.instance != input.scope.instance_id
        || (request.body.expires_at as i64) <= now
    {
        return Err(proof());
    }
    let expires_at = timestamp(request.body.expires_at as i64)?;
    let existing: Option<(Option<String>, Option<bool>)> = sqlx::query_as(
        "SELECT s.sharer_device_id,s.share IS NOT NULL FROM e2ee_history_requests r LEFT JOIN e2ee_history_shares s ON s.request=r.fingerprint WHERE r.fingerprint=$1 AND r.device_id=$2",
    )
    .bind(&fingerprint)
    .bind(&device)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((sharer, done)) = existing {
        tx.commit().await?;
        return Ok(entry(
            fingerprint,
            device,
            bytes,
            expires_at,
            sharer,
            done.unwrap_or(false),
        ));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_history_request_log WHERE user_id=$1 AND device_id=$2 AND created_at>clock_timestamp()-interval '1 day'")
        .bind(&actor.id).bind(&device).fetch_one(&mut *tx).await?;
    if count >= DAILY_REQUESTS {
        return Err(Error::throttled("history_request_limit", 3600));
    }
    sqlx::query("DELETE FROM e2ee_history_requests WHERE device_id=$1")
        .bind(&device)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO e2ee_history_requests(fingerprint,user_id,device_id,request,expires_at,retained_until) VALUES($1,$2,$3,$4,$5,$5)")
        .bind(&fingerprint).bind(&actor.id).bind(&device).bind(&bytes).bind(expires_at).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO e2ee_history_request_log(user_id,device_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
        .bind(&actor.id).bind(&device).bind(&fingerprint).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(entry(fingerprint, device, bytes, expires_at, None, false))
}

/// The account's requests still answerable, and the committed shares still kept.
pub async fn requests(app: &App, actor: &Account) -> Result<wire::HistoryRequests> {
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let scope = current_scope(&mut tx).await?;
    expire(&mut tx, actor).await?;
    type Row = (
        String,
        String,
        Vec<u8>,
        chrono::DateTime<Utc>,
        Option<String>,
        Option<bool>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT r.fingerprint,r.device_id,r.request,r.expires_at,s.sharer_device_id,s.share IS NOT NULL \
         FROM e2ee_history_requests r LEFT JOIN e2ee_history_shares s ON s.request=r.fingerprint \
         WHERE r.user_id=$1 AND (r.expires_at>clock_timestamp() OR s.share IS NOT NULL) ORDER BY r.expires_at,r.fingerprint",
    )
    .bind(&actor.id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(wire::HistoryRequests {
        scope,
        requests: rows
            .into_iter()
            .map(|(f, d, r, e, s, c)| entry(f, d, r, e, s, c.unwrap_or(false)))
            .collect(),
    })
}

struct Checked {
    room: String,
    position: i64,
    digest: String,
    bytes: Vec<u8>,
    record: Record,
}
/// Sharing device: stores the next records of one manifest entry. The first
/// page claims the share for this device; a replayed page is accepted as is.
pub async fn upload(
    app: &App,
    actor: &Account,
    fingerprint: &str,
    input: wire::UploadHistoryRecords,
) -> Result<wire::HistoryRecordsReceipt> {
    fingerprint_hex(fingerprint)?;
    check_scope(&input.scope)?;
    let start = decimal(&input.start)?;
    if input.records.is_empty() || input.records.len() > PAGE_RECORDS || input.period >= 1024 {
        return Err(Error::invalid());
    }
    let encoded = input.records.clone();
    let checked = verify(app, move || {
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
                room: record.header.origin.header.scope.room.clone(),
                position: i64::try_from(record.header.origin.position).map_err(|_| proof())?,
                digest: hex(&record.digest().map_err(|_| proof())?),
                bytes,
                record,
            });
        }
        Ok(checked)
    })
    .await?;
    let room = checked[0].room.clone();
    let mut tx = app.pool.begin().await?;
    let (device, now) = lock_scope(&mut tx, actor, &input.scope).await?;
    expire(&mut tx, actor).await?;
    let request = pending(&mut tx, actor, fingerprint, true).await?;
    if request.device == device {
        return Err(own_request());
    }
    let certificate = current_certificate(&mut tx, actor, &device).await?;
    for item in &checked {
        let scope = &item.record.header.origin.header.scope;
        if item.record.certificate != certificate
            || certificate.device.root != request.request.body.certificate.device.root
            || scope.instance != input.scope.instance_id
            || scope.data_epoch != input.scope.data_epoch
            || item.room != room
        {
            return Err(proof());
        }
    }
    crate::store::require_member(&mut tx, &room, &actor.id).await?;
    let share: Option<(String, bool, i64, i64)> = sqlx::query_as(
        "SELECT sharer_device_id,share IS NOT NULL,records,bytes FROM e2ee_history_shares WHERE request=$1 FOR UPDATE",
    )
    .bind(fingerprint)
    .fetch_optional(&mut *tx)
    .await?;
    let (records, bytes) = match share {
        Some((sharer, _, _, _)) if sharer != device => return Err(claimed()),
        Some((_, done, records, bytes)) => {
            if done && !replayed(&mut tx, fingerprint, &input, start, &checked).await? {
                return Err(committed());
            }
            (records, bytes)
        }
        None => {
            if request.expires_at.timestamp() <= now {
                return Err(Error::missing());
            }
            sqlx::query("INSERT INTO e2ee_history_shares(request,sharer_device_id) VALUES($1,$2)")
                .bind(fingerprint)
                .bind(&device)
                .execute(&mut *tx)
                .await?;
            (0, 0)
        }
    };
    let held: (i64, Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT count(*),max(position),min(room_id) FROM e2ee_history_records WHERE request=$1 AND period=$2",
    )
    .bind(fingerprint)
    .bind(input.period as i32)
    .fetch_one(&mut *tx)
    .await?;
    let (count, mut last, held_room) = held;
    if start > count || held_room.is_some_and(|r| r != room) {
        return Err(gap());
    }
    if !replayed(
        &mut tx,
        fingerprint,
        &input,
        start,
        &checked[..(count - start).min(checked.len() as i64) as usize],
    )
    .await?
    {
        return Err(Error::conflict());
    }
    // A page entirely held already (a replay) has nothing fresh.
    let fresh = &checked[((count - start) as usize).min(checked.len())..];
    if !fresh.is_empty() && request.expires_at.timestamp() <= now {
        return Err(Error::missing());
    }
    let added: i64 = fresh.iter().map(|c| c.bytes.len() as i64).sum();
    if records + fresh.len() as i64 > SHARE_RECORDS || bytes + added > SHARE_BYTES {
        return Err(Error::throttled("history_share_limit", 3600));
    }
    for (offset, item) in fresh.iter().enumerate() {
        if last.is_some_and(|p| item.position <= p) {
            return Err(gap());
        }
        last = Some(item.position);
        sqlx::query("INSERT INTO e2ee_history_records(request,period,rank,room_id,position,digest,record) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(fingerprint).bind(input.period as i32).bind(count + 1 + offset as i64).bind(&item.room)
            .bind(item.position).bind(&item.digest).bind(&item.bytes).execute(&mut *tx).await?;
    }
    sqlx::query(
        "UPDATE e2ee_history_shares SET records=records+$2,bytes=bytes+$3 WHERE request=$1",
    )
    .bind(fingerprint)
    .bind(fresh.len() as i64)
    .bind(added)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(wire::HistoryRecordsReceipt {
        period: input.period,
        count: (count + fresh.len() as i64).to_string(),
    })
}
/// Whether `checked` is exactly what the server holds from rank `start + 1`.
async fn replayed(
    tx: &mut Transaction<'_, Postgres>,
    fingerprint: &str,
    input: &wire::UploadHistoryRecords,
    start: i64,
    checked: &[Checked],
) -> Result<bool> {
    if checked.is_empty() {
        return Ok(true);
    }
    let held: Vec<String> = sqlx::query_scalar(
        "SELECT digest FROM e2ee_history_records WHERE request=$1 AND period=$2 AND rank>$3 ORDER BY rank LIMIT $4",
    )
    .bind(fingerprint)
    .bind(input.period as i32)
    .bind(start)
    .bind(checked.len() as i64)
    .fetch_all(&mut **tx)
    .await?;
    Ok(held.len() == checked.len() && held.iter().zip(checked).all(|(h, c)| *h == c.digest))
}

fn state(scope: Scope, fingerprint: &str, sharer: String, share: &[u8]) -> wire::HistoryShareState {
    wire::HistoryShareState {
        scope,
        fingerprint: fingerprint.into(),
        sharer_device_id: sharer,
        share: B64.encode(share),
    }
}
/// Sharing device: commits the signed share once the server holds exactly
/// the records of its manifest, counted and chained as signed.
pub async fn commit(
    app: &App,
    actor: &Account,
    fingerprint: &str,
    input: wire::CommitHistoryShare,
) -> Result<wire::HistoryShareState> {
    fingerprint_hex(fingerprint)?;
    check_scope(&input.scope)?;
    let encoded = input.share.clone();
    let (share, bytes) = verify(app, move || {
        let share = Share::from_bytes(&decode(&encoded, SHARE_LIMIT)?).map_err(|_| proof())?;
        let now = u64::try_from(Utc::now().timestamp()).map_err(|_| Error::internal())?;
        share.verify(now).map_err(|_| proof())?;
        let bytes = share.to_bytes().map_err(|_| proof())?;
        Ok((share, bytes))
    })
    .await?;
    let mut tx = app.pool.begin().await?;
    let (device, now) = lock_scope(&mut tx, actor, &input.scope).await?;
    expire(&mut tx, actor).await?;
    let request = pending(&mut tx, actor, fingerprint, true).await?;
    if request.device == device {
        return Err(own_request());
    }
    let held: Option<(String, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT sharer_device_id,share FROM e2ee_history_shares WHERE request=$1 FOR UPDATE",
    )
    .bind(fingerprint)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((sharer, saved)) = held else {
        return Err(incomplete());
    };
    if sharer != device {
        return Err(claimed());
    }
    if let Some(saved) = saved {
        if saved != bytes {
            return Err(committed());
        }
        tx.commit().await?;
        return Ok(state(input.scope, fingerprint, sharer, &saved));
    }
    if request.expires_at.timestamp() <= now {
        return Err(Error::missing());
    }
    let certificate = current_certificate(&mut tx, actor, &device).await?;
    if share.certificate != certificate
        || certificate.device.root != request.request.body.certificate.device.root
        || hex(&share.manifest.request) != fingerprint
    {
        return Err(proof());
    }
    let beyond: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM e2ee_history_records WHERE request=$1 AND period>=$2)",
    )
    .bind(fingerprint)
    .bind(share.manifest.periods.len() as i32)
    .fetch_one(&mut *tx)
    .await?;
    if beyond {
        return Err(incomplete());
    }
    for (index, period) in share.manifest.periods.iter().enumerate() {
        if period.scope.instance != input.scope.instance_id
            || period.scope.data_epoch != input.scope.data_epoch
        {
            return Err(proof());
        }
        let rows: Vec<(String, i64, String)> = sqlx::query_as(
            "SELECT room_id,position,digest FROM e2ee_history_records WHERE request=$1 AND period=$2 ORDER BY rank",
        )
        .bind(fingerprint)
        .bind(index as i32)
        .fetch_all(&mut *tx)
        .await?;
        let digests = rows
            .iter()
            .map(|(_, _, d)| {
                data_encoding::HEXLOWER
                    .decode(d.as_bytes())
                    .ok()
                    .and_then(|b| <[u8; 32]>::try_from(b).ok())
                    .ok_or_else(Error::internal)
            })
            .collect::<Result<Vec<_>>>()?;
        if rows.len() as u64 != period.count
            || rows.iter().any(|(room, _, _)| *room != period.scope.room)
            || rows.first().map(|r| r.1 as u64) != Some(period.first)
            || rows.last().map(|r| r.1 as u64) != Some(period.last)
            || chain(digests).map_err(|_| Error::internal())? != period.chain
        {
            return Err(incomplete());
        }
    }
    sqlx::query("UPDATE e2ee_history_shares SET share=$2 WHERE request=$1")
        .bind(fingerprint)
        .bind(&bytes)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE e2ee_history_requests SET retained_until=greatest(retained_until,clock_timestamp()+make_interval(secs=>$2)) WHERE fingerprint=$1")
        .bind(fingerprint)
        .bind(RETENTION as f64)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(state(input.scope, fingerprint, sharer, &bytes))
}

/// The requesting device's own request, and its committed share.
async fn own_share(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    fingerprint: &str,
) -> Result<(Scope, String, Vec<u8>)> {
    fingerprint_hex(fingerprint)?;
    let scope = current_scope(tx).await?;
    let (device, _) = lock_scope(tx, actor, &scope).await?;
    expire(tx, actor).await?;
    let request = pending(tx, actor, fingerprint, false).await?;
    if request.device != device {
        return Err(Error::missing());
    }
    let row: Option<(String, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT sharer_device_id,share FROM e2ee_history_shares WHERE request=$1 FOR SHARE",
    )
    .bind(fingerprint)
    .fetch_optional(&mut **tx)
    .await?;
    match row {
        Some((sharer, Some(share))) => Ok((scope, sharer, share)),
        _ => Err(Error::missing()),
    }
}
/// Requesting device: the committed share answering its request.
pub async fn share(
    app: &App,
    actor: &Account,
    fingerprint: &str,
) -> Result<wire::HistoryShareState> {
    let mut tx = app.pool.begin().await?;
    let (scope, sharer, share) = own_share(&mut tx, actor, fingerprint).await?;
    tx.commit().await?;
    Ok(state(scope, fingerprint, sharer, &share))
}
/// The room of one committed manifest entry, for the read proof.
pub async fn period_room(
    app: &App,
    actor: &Account,
    fingerprint: &str,
    period: u32,
) -> Result<String> {
    let mut tx = app.pool.begin().await?;
    own_share(&mut tx, actor, fingerprint).await?;
    let room: Option<String> = sqlx::query_scalar(
        "SELECT room_id FROM e2ee_history_records WHERE request=$1 AND period=$2 LIMIT 1",
    )
    .bind(fingerprint)
    .bind(period as i32)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    room.ok_or_else(Error::missing)
}
/// Requesting device: records of one entry after rank `after`, while the
/// account can still read the room.
pub async fn records(
    app: &App,
    actor: &Account,
    fingerprint: &str,
    period: u32,
    after: &str,
    limit: usize,
) -> Result<wire::HistoryRecordsPage> {
    let after = decimal(after)?;
    if limit == 0 || limit > PAGE_RECORDS {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    own_share(&mut tx, actor, fingerprint).await?;
    let rows: Vec<(i64, String, Vec<u8>)> = sqlx::query_as(
        "SELECT rank,room_id,record FROM e2ee_history_records WHERE request=$1 AND period=$2 AND rank>$3 ORDER BY rank LIMIT $4",
    )
    .bind(fingerprint)
    .bind(period as i32)
    .bind(after)
    .bind(limit as i64 + 1)
    .fetch_all(&mut *tx)
    .await?;
    if let Some((_, room, _)) = rows.first() {
        crate::store::require_member(&mut tx, room, &actor.id).await?;
    }
    let fetched = rows.len();
    let mut page = Vec::new();
    let mut total = 0;
    let mut end = after;
    for (rank, _, record) in rows.into_iter().take(limit) {
        total += record.len();
        if !page.is_empty() && total > DOWNLOAD_BYTES {
            break;
        }
        end = rank;
        page.push(B64.encode(&record));
    }
    tx.commit().await?;
    let next = (page.len() < fetched).then(|| end.to_string());
    Ok(wire::HistoryRecordsPage {
        period,
        start: after.to_string(),
        records: page,
        next,
    })
}
/// Requesting device: the import is done or abandoned; the request, its share
/// and records are deleted. Repeating it is harmless.
pub async fn acknowledge(app: &App, actor: &Account, fingerprint: &str) -> Result<()> {
    fingerprint_hex(fingerprint)?;
    let mut tx = app.pool.begin().await?;
    let scope = current_scope(&mut tx).await?;
    let (device, _) = lock_scope(&mut tx, actor, &scope).await?;
    sqlx::query(
        "DELETE FROM e2ee_history_requests WHERE fingerprint=$1 AND user_id=$2 AND device_id=$3",
    )
    .bind(fingerprint)
    .bind(&actor.id)
    .bind(&device)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
