//! Protected file reservations, streamed immutable objects and atomic messages.
use crate::{
    App,
    auth::{self, Account},
    delivery::{LeasedBody, ReadProof, Scope},
    error::{Error, Result},
    store,
};
use axum::{
    body::{Body, Bytes},
    http::{HeaderValue, StatusCode, header},
    response::Response,
};
use chrono::{DateTime, Utc};
use futures_util::{TryStreamExt, stream};
use rv_protocol::{
    Message, SendMessage,
    parity::{CompleteUpload, FileDescriptor, MessageContent, PrepareUpload, Upload, UploadState},
};
use sqlx::{Postgres, Transaction};
use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub const MAX_BYTES: u64 = 100 * 1024 * 1024;
const QUOTA_BYTES: i64 = 50 * 1024 * 1024 * 1024;
const COLUMNS: &str = "SELECT *,expires_at<=clock_timestamp() AS expired,COALESCE(lease_expires_at>clock_timestamp(),false) AS busy FROM uploads";

#[derive(sqlx::FromRow)]
struct Record {
    id: String,
    user_id: String,
    fingerprint: String,
    room_id: String,
    membership_version: String,
    data_epoch: String,
    bytes: i64,
    sha256: String,
    media_type: String,
    filename: String,
    state: String,
    object_id: Option<String>,
    lease_id: Option<String>,
    message_id: Option<String>,
    complete_fingerprint: Option<String>,
    expires_at: DateTime<Utc>,
    expired: bool,
    busy: bool,
}
impl Record {
    fn descriptor(&self) -> FileDescriptor {
        FileDescriptor {
            id: self.id.clone(),
            room_id: self.room_id.clone(),
            bytes: self.bytes.to_string(),
            sha256: self.sha256.clone(),
            media_type: self.media_type.clone(),
            filename: Some(self.filename.clone()),
            encrypted: false,
        }
    }
    fn wire(&self) -> Upload {
        Upload {
            id: self.id.clone(),
            file: self.descriptor(),
            expires_at: self.expires_at.to_rfc3339(),
            message_id: self.message_id.clone(),
            state: match self.state.as_str() {
                "completed" => UploadState::Completed,
                "cancelled" => UploadState::Cancelled,
                "expired" => UploadState::Expired,
                _ if self.expired => UploadState::Expired,
                "ready" => UploadState::Ready,
                _ => UploadState::Prepared,
            },
        }
    }
    fn pending(&self) -> Result<()> {
        if self.expired || self.state == "expired" {
            return Err(Error::new(StatusCode::CONFLICT, "upload_expired"));
        }
        if self.state == "cancelled" {
            return Err(Error::new(StatusCode::CONFLICT, "upload_cancelled"));
        }
        Ok(())
    }
}
fn objects(app: &App) -> Result<&crate::objects::LocalObjects> {
    app.objects
        .as_ref()
        .ok_or_else(|| Error::new(StatusCode::NOT_IMPLEMENTED, "files_unavailable"))
}
async fn load(tx: &mut Transaction<'_, Postgres>, actor: &Account, id: &str) -> Result<Record> {
    if !auth::identifier(id) {
        return Err(Error::invalid());
    }
    sqlx::query_as(&format!("{COLUMNS} WHERE id=$1 AND user_id=$2 FOR UPDATE"))
        .bind(id)
        .bind(&actor.id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(Error::missing)
}
async fn grant(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    room: &str,
) -> Result<(String, String)> {
    store::require_member(tx, room, &actor.id).await?;
    sqlx::query_as("SELECT m.access_version,i.data_epoch FROM members m CROSS JOIN instance i WHERE m.room_id=$1 AND m.user_id=$2 AND i.singleton FOR KEY SHARE OF i")
 .bind(room).bind(&actor.id).fetch_optional(&mut **tx).await?.ok_or_else(Error::missing)
}
async fn validate(tx: &mut Transaction<'_, Postgres>, actor: &Account, row: &Record) -> Result<()> {
    let (membership, epoch) = grant(tx, actor, &row.room_id).await?;
    if row.user_id != actor.id || row.membership_version != membership || row.data_epoch != epoch {
        return Err(Error::new(StatusCode::CONFLICT, "upload_authority_changed"));
    }
    Ok(())
}
fn allowed(mime: &str) -> bool {
    matches!(
        mime,
        "application/octet-stream"
            | "text/plain"
            | "application/pdf"
            | "application/zip"
            | "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "audio/mpeg"
            | "audio/ogg"
            | "audio/wav"
            | "audio/mp4"
            | "video/mp4"
            | "video/quicktime"
            | "video/webm"
    )
}
pub(crate) fn valid_header(bytes: &[u8], mime: &str) -> bool {
    match mime {
        "application/octet-stream" => true,
        "text/plain" => !bytes.contains(&0),
        "application/pdf" => bytes.starts_with(b"%PDF-"),
        "application/zip" => bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06"),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "audio/wav" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE"),
        "audio/ogg" => bytes.starts_with(b"OggS"),
        "audio/mpeg" => {
            bytes.starts_with(b"ID3")
                || bytes.first() == Some(&0xff) && bytes.get(1).is_some_and(|b| b & 0xe0 == 0xe0)
        }
        "audio/mp4" | "video/mp4" | "video/quicktime" => bytes.get(4..8) == Some(b"ftyp"),
        "video/webm" => bytes.starts_with(b"\x1a\x45\xdf\xa3"),
        _ => false,
    }
}
pub async fn prepare(app: &App, actor: &Account, input: PrepareUpload) -> Result<Upload> {
    objects(app)?;
    let bytes = input
        .bytes
        .parse::<u64>()
        .ok()
        .filter(|b| *b > 0 && *b <= MAX_BYTES && b.to_string() == input.bytes)
        .ok_or_else(Error::invalid)?;
    let name = input.filename.as_deref().ok_or_else(Error::invalid)?;
    if input.encrypted
        || !auth::identifier(&input.operation_id)
        || !auth::identifier(&input.room_id)
        || input.sha256.len() != 64
        || !input
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !allowed(&input.media_type)
        || name.trim().is_empty()
        || name.len() > 255
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
        || matches!(name, "." | "..")
    {
        return Err(Error::invalid());
    }
    let fingerprint =
        auth::hash_token(&serde_json::to_string(&input).map_err(|_| Error::invalid())?);
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let (membership, epoch) = grant(&mut tx, actor, &input.room_id).await?;
    if let Some(row) =
        sqlx::query_as::<_, Record>(&format!("{COLUMNS} WHERE user_id=$1 AND operation_id=$2"))
            .bind(&actor.id)
            .bind(&input.operation_id)
            .fetch_optional(&mut *tx)
            .await?
    {
        if row.fingerprint != fingerprint {
            return Err(Error::conflict());
        }
        validate(&mut tx, actor, &row).await?;
        return Ok(row.wire());
    }
    let used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_commands WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM message_actions WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_creation_requests WHERE user_id=$1 AND operation_id=$2)")
 .bind(&actor.id).bind(&input.operation_id).fetch_one(&mut *tx).await?;
    if used {
        return Err(Error::conflict());
    }
    crate::permissions::require_send(&mut tx, &input.room_id, &actor.id).await?;
    let (pending,recent):(i64,i64)=sqlx::query_as("SELECT count(*) FILTER(WHERE state IN ('prepared','ready') AND expires_at>clock_timestamp()),count(*) FILTER(WHERE created_at>clock_timestamp()-interval '60 seconds') FROM uploads WHERE user_id=$1")
 .bind(&actor.id).fetch_one(&mut *tx).await?;
    if pending >= 10 || recent >= 30 {
        return Err(Error::throttled("upload_limit", 60));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('rv-upload-quota-v1',0))")
        .execute(&mut *tx)
        .await?;
    let reserved:i64=sqlx::query_scalar("SELECT COALESCE(sum(bytes),0)::bigint FROM uploads WHERE state IN ('prepared','ready','completed')")
 .fetch_one(&mut *tx).await?;
    if reserved > QUOTA_BYTES - bytes as i64 {
        return Err(Error::new(StatusCode::INSUFFICIENT_STORAGE, "file_quota"));
    }
    let id = auth::random_token();
    sqlx::query("INSERT INTO uploads(id,user_id,operation_id,fingerprint,room_id,membership_version,data_epoch,bytes,sha256,media_type,filename,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'prepared')")
 .bind(&id).bind(&actor.id).bind(&input.operation_id).bind(fingerprint).bind(&input.room_id).bind(membership).bind(epoch).bind(bytes as i64).bind(&input.sha256).bind(&input.media_type).bind(name).execute(&mut *tx).await?;
    let row = load(&mut tx, actor, &id).await?;
    tx.commit().await?;
    Ok(row.wire())
}
pub async fn status(app: &App, actor: &Account, id: &str) -> Result<Upload> {
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let row = load(&mut tx, actor, id).await?;
    validate(&mut tx, actor, &row).await?;
    Ok(row.wire())
}
pub async fn bytes(app: &App, actor: &Account, id: &str, body: Body) -> Result<Upload> {
    let store = objects(app)?;
    let _slot = app
        .file_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::throttled("file_transfer_limit", 5))?;
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let row = load(&mut tx, actor, id).await?;
    validate(&mut tx, actor, &row).await?;
    if matches!(row.state.as_str(), "ready" | "completed") {
        return Ok(row.wire());
    }
    row.pending()?;
    crate::permissions::require_send(&mut tx, &row.room_id, &actor.id).await?;
    if row.busy {
        return Err(Error::new(StatusCode::CONFLICT, "upload_in_progress"));
    }
    let lease = auth::random_token();
    sqlx::query("UPDATE uploads SET lease_id=$2,lease_expires_at=clock_timestamp()+interval '150 seconds' WHERE id=$1").bind(id).bind(&lease).execute(&mut *tx).await?;
    tx.commit().await?;
    let result=async {
 let object=store.put_stream(body,row.bytes as u64,&row.sha256,&row.media_type).await?;
 let mut tx=app.pool.begin().await?;auth::lock_active(&mut tx,actor).await?;
 let current=load(&mut tx,actor,id).await?;validate(&mut tx,actor,&current).await?;current.pending()?;
 crate::permissions::require_send(&mut tx,&current.room_id,&actor.id).await?;
 if current.state!="prepared" || current.lease_id.as_deref()!=Some(&lease) || !current.busy{return Err(Error::conflict());}
 sqlx::query("UPDATE uploads SET state='ready',object_id=$2,lease_id=NULL,lease_expires_at=NULL WHERE id=$1").bind(id).bind(object).execute(&mut *tx).await?;
 let updated=load(&mut tx,actor,id).await?;tx.commit().await?;Ok(updated.wire())
 }.await;
    if result.is_err() {
        let _ = sqlx::query(
            "UPDATE uploads SET lease_id=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_id=$2",
        )
        .bind(id)
        .bind(lease)
        .execute(&app.pool)
        .await;
    }
    result
}
pub async fn cancel(app: &App, actor: &Account, id: &str) -> Result<Upload> {
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let row = load(&mut tx, actor, id).await?;
    validate(&mut tx, actor, &row).await?;
    if row.state == "completed" {
        return Err(Error::conflict());
    }
    sqlx::query("UPDATE uploads SET state='cancelled',object_id=NULL,lease_id=NULL,lease_expires_at=NULL WHERE id=$1").bind(id).execute(&mut *tx).await?;
    let updated = load(&mut tx, actor, id).await?;
    tx.commit().await?;
    Ok(updated.wire())
}
pub async fn complete(
    app: &App,
    actor: &Account,
    id: &str,
    input: CompleteUpload,
) -> Result<Message> {
    let fingerprint = auth::hash_token(&format!(
        "{id}:{}",
        serde_json::to_string(&input).map_err(|_| Error::invalid())?
    ));
    let MessageContent::Plain {
        markdown,
        mentions,
        quotes,
        files,
    } = input.content
    else {
        return Err(Error::invalid());
    };
    if files != [id] || !mentions.is_empty() || !auth::identifier(&input.operation_id) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let row = load(&mut tx, actor, id).await?;
    crate::quotes::lock_rooms(&mut tx, &row.room_id, &quotes).await?;
    validate(&mut tx, actor, &row).await?;
    if row.state == "completed" {
        if row.complete_fingerprint.as_deref() != Some(&fingerprint) {
            return Err(Error::conflict());
        }
        return Ok(sqlx::query_as::<_, store::MessageRow>(&format!(
            "{} WHERE m.id=$1",
            store::MESSAGE_SELECT
        ))
        .bind(&row.message_id)
        .fetch_one(&mut *tx)
        .await?
        .wire());
    }
    row.pending()?;
    if row.state != "ready" || row.object_id.is_none() {
        return Err(Error::new(StatusCode::CONFLICT, "upload_not_ready"));
    }
    let message = store::send_in_tx(
        &mut tx,
        actor,
        &row.room_id,
        SendMessage {
            cards: Vec::new(),
            operation_id: input.operation_id,
            text: markdown,
            reply_to: input.reply_to,
            quotes,
        },
        &[row.descriptor()],
        Some(&format!("file:{fingerprint}")),
    )
    .await?;
    sqlx::query(
        "UPDATE uploads SET state='completed',message_id=$2,complete_fingerprint=$3 WHERE id=$1",
    )
    .bind(id)
    .bind(&message.id)
    .bind(fingerprint)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(message)
}

struct Download {
    app: App,
    proof: ReadProof,
    session: String,
    room: String,
    message: String,
    reader: tokio::fs::File,
    remaining: u64,
    active: Arc<AtomicBool>,
    _release: tokio::sync::oneshot::Sender<()>,
}
pub async fn download(
    app: &App,
    actor: &Account,
    id: &str,
    range: Option<&str>,
) -> Result<Response> {
    if !auth::identifier(id) {
        return Err(Error::invalid());
    }
    let (room,message,object,mime,size,name):(String,String,String,String,i64,String)=sqlx::query_as("SELECT f.room_id,f.message_id,f.object_id,f.media_type,f.bytes,f.filename FROM uploads f JOIN messages m ON m.id=f.message_id JOIN members g ON g.room_id=f.room_id AND g.user_id=$2 WHERE f.id=$1 AND f.state='completed' AND NOT m.deleted")
 .bind(id).bind(&actor.id).fetch_optional(&app.pool).await?.ok_or_else(Error::missing)?;
    let proof = ReadProof::capture(app, actor, Scope::Room(&room)).await?;
    let mut initial = proof
        .lock(app, &actor.session_hash, std::slice::from_ref(&room), None)
        .await?;
    readable(&mut initial, &message).await?;
    let mut reader = objects(app)?.open_reader(&object).await?;
    if reader
        .metadata()
        .await
        .map_err(|_| Error::internal())?
        .len()
        != size as u64
    {
        return Err(Error::internal());
    }
    let (start, end) = byte_range(range, size as u64)?;
    reader
        .seek(io::SeekFrom::Start(start))
        .await
        .map_err(|_| Error::internal())?;
    drop(initial);
    let permit = app
        .file_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::throttled("file_transfer_limit", 5))?;
    let (release, done) = tokio::sync::oneshot::channel();
    let active = Arc::new(AtomicBool::new(true));
    let live = active.clone();
    tokio::spawn(async move {
        tokio::select! {_=done=>(),_=tokio::time::sleep(Duration::from_secs(120))=>()}
        live.store(false, Ordering::SeqCst);
        drop(permit);
    });
    let state = Download {
        app: app.clone(),
        proof,
        session: actor.session_hash.clone(),
        room,
        message,
        reader,
        remaining: end - start + 1,
        active,
        _release: release,
    };
    let stream = stream::try_unfold(state, |mut state| async move {
        if state.remaining == 0 {
            return Ok(None);
        }
        if !state.active.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "file transfer expired",
            ));
        }
        let mut lease = state
            .proof
            .lock(
                &state.app,
                &state.session,
                std::slice::from_ref(&state.room),
                None,
            )
            .await
            .map_err(|_| io::Error::other("file access ended"))?;
        readable(&mut lease, &state.message)
            .await
            .map_err(|_| io::Error::other("file access ended"))?;
        let mut buffer = vec![0u8; state.remaining.min(256 * 1024) as usize];
        state.reader.read_exact(&mut buffer).await?;
        if !state.active.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "file transfer expired",
            ));
        }
        state.remaining -= buffer.len() as u64;
        Ok(Some((LeasedBody::new(Bytes::from(buffer), lease), state)))
    })
    .try_flatten();
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = if range.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime).map_err(|_| Error::internal())?,
    );
    headers.insert(header::CONTENT_LENGTH, (end - start + 1).into());
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if range.is_some() {
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{size}")).unwrap(),
        );
    }
    let filename = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect::<String>();
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"attachment\"; filename*=UTF-8''{filename}"
        ))
        .map_err(|_| Error::internal())?,
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}
async fn readable(tx: &mut Transaction<'_, Postgres>, message: &str) -> Result<()> {
    let exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM messages WHERE id=$1 AND NOT deleted FOR SHARE")
            .bind(message)
            .fetch_optional(&mut **tx)
            .await?;
    if exists.is_none() {
        return Err(Error::missing());
    }
    Ok(())
}
fn byte_range(range: Option<&str>, size: u64) -> Result<(u64, u64)> {
    let bad = || Error::new(StatusCode::RANGE_NOT_SATISFIABLE, "invalid_range");
    let Some(range) = range else {
        return Ok((0, size - 1));
    };
    let (left, right) = range
        .strip_prefix("bytes=")
        .and_then(|s| s.split_once('-'))
        .ok_or_else(bad)?;
    let (start, end) = if left.is_empty() {
        let suffix = right.parse::<u64>().map_err(|_| bad())?;
        if suffix == 0 {
            return Err(bad());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = left.parse::<u64>().map_err(|_| bad())?;
        let end = if right.is_empty() {
            size - 1
        } else {
            right.parse::<u64>().map_err(|_| bad())?.min(size - 1)
        };
        (start, end)
    };
    if start > end || start >= size {
        return Err(bad());
    }
    Ok((start, end))
}
