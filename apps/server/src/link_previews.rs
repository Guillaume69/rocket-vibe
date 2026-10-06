//! Durable bounded unfurl jobs. Network and image work is outside every SQL
//! transaction. Publication checks the lease, content lifetime and data epoch.
mod network;
use crate::{
    App, auth,
    delivery::{ReadProof, Scope},
    error::{Error, Result},
    store::{self, MESSAGE_SELECT, MessageRow},
};
use axum::{http::header, response::Response};
use rv_protocol::{
    Change,
    link_previews::{LinkPreview, PreviewImage},
};
use sqlx::{Postgres, Transaction, types::Json};

#[derive(sqlx::FromRow)]
struct Lease {
    message_id: String,
    slot: i16,
    token: String,
    data_epoch: String,
    url: String,
    lease_id: String,
}

pub(crate) async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    message: &str,
    text: &str,
) -> Result<()> {
    let token = auth::random_token();
    sqlx::query("UPDATE messages SET preview_token=$2,previews='[]' WHERE id=$1")
        .bind(message)
        .bind(&token)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM link_preview_jobs WHERE message_id=$1")
        .bind(message)
        .execute(&mut **tx)
        .await?;
    for (slot, url) in network::links(text).into_iter().enumerate() {
        sqlx::query("INSERT INTO link_preview_jobs(message_id,slot,token,data_epoch,url) SELECT $1,$2,$3,data_epoch,$4 FROM instance WHERE singleton")
            .bind(message).bind(slot as i16).bind(&token).bind(url).execute(&mut **tx).await?;
    }
    Ok(())
}
async fn claim(app: &App) -> Result<Vec<Lease>> {
    Ok(sqlx::query_as("WITH ready AS (SELECT j.message_id,j.slot FROM link_preview_jobs j JOIN messages m ON m.id=j.message_id JOIN instance i ON i.singleton WHERE j.state='pending' AND j.token=m.preview_token AND j.data_epoch=i.data_epoch AND NOT m.deleted AND m.system IS NULL AND j.expires_at>clock_timestamp() AND j.next_attempt_at<=clock_timestamp() AND j.attempts<3 AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=clock_timestamp()) ORDER BY j.next_attempt_at,j.message_id,j.slot LIMIT 4 FOR UPDATE OF j SKIP LOCKED) UPDATE link_preview_jobs j SET lease_id=$1,lease_expires_at=clock_timestamp()+interval '1 minute',attempts=attempts+1 FROM ready WHERE j.message_id=ready.message_id AND j.slot=ready.slot RETURNING j.message_id,j.slot,j.token,j.data_epoch,j.url,j.lease_id")
        .bind(auth::random_token()).fetch_all(&app.pool).await?)
}
async fn current(app: &App, job: &Lease) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM link_preview_jobs j JOIN messages m ON m.id=j.message_id JOIN instance i ON i.singleton JOIN users u ON u.id=m.author_id WHERE j.message_id=$1 AND j.slot=$2 AND j.lease_id=$3 AND j.token=$4 AND j.data_epoch=$5 AND j.token=m.preview_token AND j.data_epoch=i.data_epoch AND j.state='pending' AND j.lease_expires_at>clock_timestamp() AND j.expires_at>clock_timestamp() AND NOT m.deleted AND NOT u.disabled AND EXISTS(SELECT 1 FROM members a WHERE a.room_id=m.room_id AND a.user_id=m.author_id))")
        .bind(&job.message_id).bind(job.slot).bind(&job.lease_id).bind(&job.token).bind(&job.data_epoch).fetch_one(&app.pool).await?)
}
async fn failed(app: &App, job: &Lease, retry: bool) -> Result<()> {
    sqlx::query("UPDATE link_preview_jobs SET state=CASE WHEN $4 AND attempts<3 AND expires_at>clock_timestamp() THEN 'pending' ELSE 'retired' END,lease_id=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp()+make_interval(secs=>attempts*10) WHERE message_id=$1 AND slot=$2 AND lease_id=$3")
        .bind(&job.message_id).bind(job.slot).bind(&job.lease_id).bind(retry).execute(&app.pool).await?;
    Ok(())
}
async fn deliver(app: &App, job: Lease) -> Result<bool> {
    if !current(app, &job).await? {
        failed(app, &job, false).await?;
        return Ok(false);
    }
    let collected = match network::collect(&job.url).await {
        Ok(value) => value,
        Err(error) => {
            failed(app, &job, error.retry()).await?;
            return Ok(false);
        }
    };
    publish(app, &job, collected).await
}
async fn publish(app: &App, job: &Lease, collected: network::Collected) -> Result<bool> {
    let image = if let Some(image) = collected.image {
        let bytes = image.bytes.len();
        let digest = auth::hash_token_bytes(&image.bytes);
        let objects = app.objects.as_ref().ok_or_else(Error::internal)?;
        let file_id = objects.put(image.bytes).await?;
        Some(PreviewImage {
            file_id,
            sha256: digest,
            bytes: bytes.to_string(),
            width: image.width,
            height: image.height,
            media_type: "image/png".into(),
        })
    } else {
        None
    };
    let preview = LinkPreview {
        url: job.url.clone(),
        kind: collected.kind,
        title: collected.title,
        description: collected.description,
        site: collected.site,
        image,
    };
    if !rv_protocol::link_previews::validate(std::slice::from_ref(&preview)) {
        return Err(Error::internal());
    }
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    let epoch: Option<String> = sqlx::query_scalar(
        "SELECT data_epoch FROM instance WHERE singleton AND data_epoch=$1 FOR KEY SHARE",
    )
    .bind(&job.data_epoch)
    .fetch_optional(&mut *tx)
    .await?;
    if epoch.is_none() {
        return Ok(false);
    }
    let owner: Option<(String, String)> =
        sqlx::query_as("SELECT author_id,room_id FROM messages WHERE id=$1")
            .bind(&job.message_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((author, room)) = owner else {
        return Ok(false);
    };
    let active: Option<String> =
        sqlx::query_scalar("SELECT id FROM users WHERE id=$1 AND NOT disabled FOR SHARE")
            .bind(&author)
            .fetch_optional(&mut *tx)
            .await?;
    if active.is_none() {
        return Ok(false);
    }
    // Same order as message mutation: account, room, membership, message, job.
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR UPDATE")
        .bind(&room)
        .fetch_one(&mut *tx)
        .await?;
    let member: Option<String> =
        sqlx::query_scalar("SELECT user_id FROM members WHERE user_id=$1 AND room_id=$2 FOR SHARE")
            .bind(&author)
            .bind(&room)
            .fetch_optional(&mut *tx)
            .await?;
    if member.is_none() {
        return Ok(false);
    }
    let token:Option<String> = sqlx::query_scalar("SELECT preview_token FROM messages WHERE id=$1 AND NOT deleted AND system IS NULL FOR UPDATE")
        .bind(&job.message_id).fetch_optional(&mut *tx).await?.flatten();
    if token.as_deref() != Some(&job.token) {
        return Ok(false);
    }
    let valid:Option<String> = sqlx::query_scalar("SELECT lease_id FROM link_preview_jobs WHERE message_id=$1 AND slot=$2 AND lease_id=$3 AND token=$4 AND state='pending' AND expires_at>clock_timestamp() AND lease_expires_at>clock_timestamp() FOR UPDATE")
        .bind(&job.message_id).bind(job.slot).bind(&job.lease_id).bind(&job.token).fetch_optional(&mut *tx).await?;
    if valid.is_none() {
        return Ok(false);
    }
    sqlx::query("UPDATE link_preview_jobs SET state='complete',result=$4 WHERE message_id=$1 AND slot=$2 AND lease_id=$3")
        .bind(&job.message_id).bind(job.slot).bind(&job.lease_id).bind(Json(preview)).execute(&mut *tx).await?;
    let previews:Vec<Json<LinkPreview>> = sqlx::query_scalar("SELECT result FROM link_preview_jobs WHERE message_id=$1 AND token=$2 AND state='complete' ORDER BY slot")
        .bind(&job.message_id).bind(&job.token).fetch_all(&mut *tx).await?;
    let previews: Vec<_> = previews.into_iter().map(|p| p.0).collect();
    sqlx::query("DELETE FROM snapshot_heads WHERE user_id IN(SELECT user_id FROM members WHERE room_id=$1) OR $1=ANY(room_ids)")
        .bind(&room).execute(&mut *tx).await?;
    sqlx::query("UPDATE rooms SET authority_version=$2 WHERE id=$1")
        .bind(&room)
        .bind(auth::random_token())
        .execute(&mut *tx)
        .await?;
    let position = store::next_position(&mut tx).await?;
    sqlx::query("UPDATE messages SET previews=$2,revision=$3 WHERE id=$1")
        .bind(&job.message_id)
        .bind(Json(previews))
        .bind(position)
        .execute(&mut *tx)
        .await?;
    let message = sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
        .bind(&job.message_id)
        .fetch_one(&mut *tx)
        .await?
        .wire();
    store::event(
        &mut tx,
        position,
        &room,
        None,
        Change::MessageUpsert(message),
    )
    .await?;
    // A wait on the global sequencer may outlive the lease. Keep ownership
    // until this last check, so expiry rolls back the metadata and journal too.
    let finished:Option<String> = sqlx::query_scalar("UPDATE link_preview_jobs SET lease_id=NULL,lease_expires_at=NULL WHERE message_id=$1 AND slot=$2 AND lease_id=$3 AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp() RETURNING message_id")
        .bind(&job.message_id).bind(job.slot).bind(&job.lease_id).fetch_optional(&mut *tx).await?;
    if finished.is_none() {
        return Ok(false);
    }
    tx.commit().await?;
    Ok(true)
}
pub async fn drain(app: &App) -> Result<usize> {
    if app.objects.is_none() {
        return Ok(0);
    }
    // One batch per process; independent server processes coordinate via SQL.
    let Ok(_slots) = app.preview_slots.try_acquire_many(4) else {
        return Ok(0);
    };
    let jobs = claim(app).await?;
    let outcomes = futures_util::future::join_all(jobs.into_iter().map(|j| deliver(app, j))).await;
    let mut published = 0;
    for result in outcomes {
        if result? {
            published += 1;
        }
    }
    Ok(published)
}

pub(crate) async fn image_response(
    app: &App,
    account: &auth::Account,
    hash: &str,
    message: &str,
    id: &str,
) -> Result<Response> {
    if !auth::identifier(message)
        || id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::missing());
    }
    let room:Option<String> = sqlx::query_scalar("SELECT m.room_id FROM messages m JOIN members a ON a.room_id=m.room_id AND a.user_id=$2 WHERE m.id=$1 AND NOT m.deleted")
        .bind(message).bind(&account.id).fetch_optional(&app.pool).await?;
    let room = room.ok_or_else(Error::missing)?;
    let proof = ReadProof::capture(app, account, Scope::Room(&room)).await?;
    let objects = app.objects.as_ref().ok_or_else(Error::missing)?;
    let bytes = objects.read(id, 4 * 1024 * 1024).await?;
    let mut lease = proof
        .lock(app, hash, std::slice::from_ref(&room), None)
        .await?;
    let previews: Option<Json<Vec<LinkPreview>>> = sqlx::query_scalar(
        "SELECT previews FROM messages WHERE id=$1 AND room_id=$2 AND NOT deleted FOR SHARE",
    )
    .bind(message)
    .bind(&room)
    .fetch_optional(&mut *lease)
    .await?;
    let image = previews
        .as_ref()
        .and_then(|p| {
            p.0.iter()
                .filter_map(|p| p.image.as_ref())
                .find(|i| i.file_id == id)
        })
        .ok_or_else(Error::missing)?;
    if image.media_type != "image/png"
        || image.bytes != bytes.len().to_string()
        || auth::hash_token_bytes(&bytes) != image.sha256
    {
        return Err(Error::internal());
    }
    let mut response = crate::delivery::leased_bytes(bytes.into(), lease, "image/png");
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    Ok(response)
}

#[cfg(test)]
mod tests;
