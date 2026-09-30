use rv_protocol::{Change, Snapshot, SyncBatch, VERSION};
use sqlx::{PgPool, types::Json};

use crate::{
    App,
    auth::{Account, random_token},
    error::{Error, Result},
    store::{MESSAGE_SELECT, MessageRow, RoomRow},
};

async fn cursor(pool: &PgPool, user: &str, epoch: &str, position: i64) -> Result<String> {
    Ok(sqlx::query_scalar("INSERT INTO sync_cursors(token,user_id,data_epoch,position) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,data_epoch,position) DO UPDATE SET position=EXCLUDED.position RETURNING token")
        .bind(random_token()).bind(user).bind(epoch).bind(position).fetch_one(pool).await?)
}

pub async fn snapshot(app: &App, account: &Account) -> Result<Snapshot> {
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let (epoch, position): (String, i64) =
        sqlx::query_as("SELECT data_epoch,position FROM instance WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    let rooms = sqlx::query_as::<_, RoomRow>("SELECT r.id,r.name,r.kind,r.revision FROM rooms r JOIN members m ON m.room_id=r.id WHERE m.user_id=$1 ORDER BY r.id LIMIT 101")
        .bind(&account.id).fetch_all(&mut *tx).await?;
    // J1 deliberately refuses oversize snapshots instead of silently dropping rooms.
    if rooms.len() > 100 {
        return Err(Error(axum::http::StatusCode::CONFLICT, "snapshot_limit"));
    }
    let mut messages = Vec::new();
    for room in &rooms {
        let query =
            format!("{MESSAGE_SELECT} WHERE m.room_id=$1 ORDER BY m.position DESC LIMIT 50");
        messages.extend(
            sqlx::query_as::<_, MessageRow>(&query)
                .bind(&room.id)
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .map(MessageRow::wire),
        );
    }
    tx.commit().await?;
    // Cursor bookkeeping is separate from the consistent read. Its default
    // READ COMMITTED upsert also permits concurrent devices at the same watermark.
    let token = cursor(&app.pool, &account.id, &epoch, position).await?;
    Ok(Snapshot {
        protocol_version: VERSION,
        rooms: rooms.into_iter().map(RoomRow::wire).collect(),
        messages,
        cursor: token,
    })
}

pub async fn changes(app: &App, account: &Account, token: &str, limit: i64) -> Result<SyncBatch> {
    if token.len() != 64 {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let (epoch, high): (String, i64) =
        sqlx::query_as("SELECT data_epoch,position FROM instance WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    let after: Option<i64> = sqlx::query_scalar(
        "SELECT position FROM sync_cursors WHERE token=$1 AND user_id=$2 AND data_epoch=$3",
    )
    .bind(token)
    .bind(&account.id)
    .bind(&epoch)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(after) = after else {
        return Err(Error(
            axum::http::StatusCode::CONFLICT,
            "sync_reset_required",
        ));
    };
    // Scan a bounded range including unauthorized events; advance over them without
    // exposing their content or the instance's global sequence numbers.
    let scanned: Vec<(i64, String, Option<String>, Json<Change>)> = sqlx::query_as("SELECT position,room_id,recipient_id,change FROM journal WHERE position>$1 AND position<=$2 ORDER BY position LIMIT $3")
        .bind(after).bind(high).bind(limit).fetch_all(&mut *tx).await?;
    let mut output = Vec::new();
    let mut last = after;
    for (position, room_id, recipient, change) in scanned {
        last = position;
        if let Some(recipient) = recipient {
            if recipient == account.id {
                // A withdrawal contains only an ID previously accessible to this user.
                if matches!(change.0, Change::RoomRemoved { .. }) {
                    output.push(change.0);
                    continue;
                }
            } else {
                continue;
            }
        }
        let allowed: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM members WHERE room_id=$1 AND user_id=$2)",
        )
        .bind(&room_id)
        .bind(&account.id)
        .fetch_one(&mut *tx)
        .await?;
        if allowed {
            output.push(change.0);
        }
    }
    let has_more = last < high;
    // Empty range at the current watermark reuses the same opaque cursor.
    tx.commit().await?;
    let next = cursor(&app.pool, &account.id, &epoch, last).await?;
    Ok(SyncBatch {
        protocol_version: VERSION,
        changes: output,
        cursor: next,
        has_more,
    })
}
