//! Immutable, bounded snapshots. SQL captures all pages from one repeatable view.
use crate::{
    App,
    auth::{Account, random_token},
    error::{Error, Result},
    limits,
    store::{MESSAGE_SELECT, MessageRow, RoomRow},
    sync,
};
use rv_protocol::{SnapshotPage, VERSION};
use sqlx::{Postgres, Transaction, types::Json};

fn reset() -> Error {
    Error::new(axum::http::StatusCode::CONFLICT, "sync_reset_required")
}
fn limit() -> Error {
    Error::new(axum::http::StatusCode::CONFLICT, "snapshot_limit")
}
fn empty(id: &str, index: u32) -> SnapshotPage {
    SnapshotPage {
        protocol_version: VERSION,
        snapshot_id: id.into(),
        page_index: index,
        rooms: Vec::new(),
        messages: Vec::new(),
        next: None,
        cursor: None,
    }
}
async fn save(
    tx: &mut Transaction<'_, Postgres>,
    token: &str,
    page: &SnapshotPage,
    total: &mut usize,
) -> Result<()> {
    let bytes = serde_json::to_vec(page)
        .map_err(|_| Error::internal())?
        .len();
    *total += bytes + if page.next.is_none() { 64 } else { 0 };
    if bytes > limits::SNAPSHOT_PAGE_BYTES || *total > limits::SNAPSHOT_TOTAL_BYTES {
        return Err(limit());
    }
    sqlx::query("INSERT INTO snapshot_pages(token,snapshot_id,payload) VALUES($1,$2,$3)")
        .bind(token)
        .bind(&page.snapshot_id)
        .bind(Json(page))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn advance(
    tx: &mut Transaction<'_, Postgres>,
    current: &mut SnapshotPage,
    token: &mut String,
    bytes: &mut usize,
    total: &mut usize,
) -> Result<()> {
    let next = random_token();
    current.next = Some(next.clone());
    save(tx, token, current, total).await?;
    *current = empty(&current.snapshot_id, current.page_index + 1);
    *token = next;
    *bytes = 1024; // Metadata, cursor and commas are included in the final exact check.
    Ok(())
}
async fn materialize(app: &App, user: &Account, id: &str) -> Result<String> {
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let (epoch, position): (String, i64) =
        sqlx::query_as("SELECT data_epoch,position FROM instance WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    // Lock only our reserved head. Revocation/cleanup may wait for this bounded build.
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM snapshot_heads WHERE id=$1 AND user_id=$2 AND expires_at>now())")
        .bind(id).bind(&user.id).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(reset());
    }
    let rooms = sqlx::query_as::<_, RoomRow>("SELECT r.id,r.name,r.kind,r.revision FROM rooms r JOIN members m ON m.room_id=r.id WHERE m.user_id=$1 ORDER BY r.id LIMIT 1001")
        .bind(&user.id).fetch_all(&mut *tx).await?;
    if rooms.len() > 1000 {
        return Err(limit());
    }
    let room_ids: Vec<String> = rooms.iter().map(|r| r.id.clone()).collect();
    // Updating the head protects it against expiry/removal while inserting its pages.
    sqlx::query("UPDATE snapshot_heads SET data_epoch=$2,position=$3,room_ids=$4 WHERE id=$1")
        .bind(id)
        .bind(&epoch)
        .bind(position)
        .bind(&room_ids)
        .execute(&mut *tx)
        .await?;
    let first = random_token();
    let mut token = first.clone();
    let mut current = empty(id, 0);
    let (mut bytes, mut total) = (1024, 0);
    for room in rooms {
        let mut room = room.wire();
        crate::room_reads::personalize(&mut tx, &user.id, &mut room).await?;
        let size = serde_json::to_vec(&room)
            .map_err(|_| Error::internal())?
            .len()
            + 1;
        if bytes + size > limits::SNAPSHOT_PAGE_BYTES {
            advance(&mut tx, &mut current, &mut token, &mut bytes, &mut total).await?;
        }
        bytes += size;
        current.rooms.push(room);
    }
    for room in &room_ids {
        let query =
            format!("{MESSAGE_SELECT} WHERE m.room_id=$1 ORDER BY m.position DESC LIMIT 50");
        // At most 50 bounded messages in memory, plus one output page.
        let mut window: Vec<_> = sqlx::query_as::<_, MessageRow>(&query)
            .bind(room)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(MessageRow::wire)
            .collect();
        crate::marks::personalize(&mut tx, &user.id, &mut window).await?;
        crate::quotes::personalize(&mut tx, &user.id, &mut window).await?;
        for message in window {
            let size = serde_json::to_vec(&message)
                .map_err(|_| Error::internal())?
                .len()
                + 1;
            if size + 1024 > limits::SNAPSHOT_PAGE_BYTES {
                return Err(limit());
            }
            if bytes + size > limits::SNAPSHOT_PAGE_BYTES {
                advance(&mut tx, &mut current, &mut token, &mut bytes, &mut total).await?;
            }
            bytes += size;
            current.messages.push(message);
        }
    }
    save(&mut tx, &token, &current, &mut total).await?;
    sqlx::query("UPDATE snapshot_heads SET ready=true WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(first)
}

pub async fn begin(app: &App, account: &Account) -> Result<SnapshotPage> {
    let id = random_token();
    let mut tx = app.pool.begin().await?;
    // A separate READ COMMITTED reservation avoids stale quota counts while the
    // materialization's repeatable snapshot waits for another admission.
    sqlx::query("SELECT singleton FROM snapshot_budget WHERE singleton FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM snapshot_heads WHERE id IN (SELECT id FROM snapshot_heads WHERE expires_at<=now() LIMIT 32 FOR UPDATE SKIP LOCKED)")
        .execute(&mut *tx).await?;
    let (total, own): (i64,i64) = sqlx::query_as("SELECT count(*),count(*) FILTER (WHERE user_id=$1) FROM snapshot_heads WHERE expires_at>now()")
        .bind(&account.id).fetch_one(&mut *tx).await?;
    if total >= limits::SNAPSHOTS_TOTAL || own >= limits::SNAPSHOTS_PER_USER {
        return Err(Error::throttled("snapshot_busy", 30));
    }
    sqlx::query("INSERT INTO snapshot_heads(id,user_id,data_epoch) SELECT $1,$2,data_epoch FROM instance WHERE singleton")
        .bind(&id).bind(&account.id).execute(&mut *tx).await?;
    tx.commit().await?;
    let result = materialize(app, account, &id).await;
    match result {
        Ok(first) => page(app, account, &first).await,
        Err(error) => {
            let _ = sqlx::query("DELETE FROM snapshot_heads WHERE id=$1")
                .bind(id)
                .execute(&app.pool)
                .await;
            Err(error)
        }
    }
}

pub async fn page(app: &App, account: &Account, token: &str) -> Result<SnapshotPage> {
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::invalid());
    }
    let row: Option<(String,i64,Json<SnapshotPage>)> = sqlx::query_as(
        "SELECT h.data_epoch,h.position,p.payload FROM snapshot_pages p JOIN snapshot_heads h ON h.id=p.snapshot_id \
         JOIN instance i ON i.singleton AND i.data_epoch=h.data_epoch \
         WHERE p.token=$1 AND h.user_id=$2 AND h.ready AND h.expires_at>now() \
         AND NOT EXISTS(SELECT 1 FROM unnest(h.room_ids) rid WHERE NOT EXISTS \
           (SELECT 1 FROM members m WHERE m.room_id=rid AND m.user_id=h.user_id))")
        .bind(token).bind(&account.id).fetch_optional(&app.pool).await?;
    let Some((epoch, position, Json(mut page))) = row else {
        return Err(reset());
    };
    if page.next.is_none() {
        // Only a complete download may publish the captured watermark. Renew it
        // here so other busy devices cannot prune it during a long download.
        page.cursor = Some(sync::cursor(&app.pool, &account.id, &epoch, position).await?);
    }
    Ok(page)
}
