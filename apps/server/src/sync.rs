use rv_protocol::{Change, Snapshot, SyncBatch, VERSION};
use serde::Serialize;
use sqlx::{PgPool, types::Json};

use crate::{
    App,
    auth::{Account, random_token},
    error::{Error, Result},
    limits,
    store::{MESSAGE_SELECT, MessageRow, RoomRow},
};

pub(crate) async fn cursor(
    pool: &PgPool,
    user: &str,
    epoch: &str,
    position: i64,
) -> Result<String> {
    let mut tx = pool.begin().await?;
    // Consistent single-user lock also bounds concurrent devices' cursor pruning.
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
        .bind(user)
        .execute(&mut *tx)
        .await?;
    let token: String = sqlx::query_scalar(
        "INSERT INTO sync_cursors(token,user_id,data_epoch,position) VALUES($1,$2,$3,$4) \
         ON CONFLICT(user_id,data_epoch,position) DO UPDATE SET \
           token=CASE WHEN sync_cursors.expires_at<=now() THEN EXCLUDED.token ELSE sync_cursors.token END, \
           expires_at=now()+interval '7 days' RETURNING token",
    ).bind(random_token()).bind(user).bind(epoch).bind(position).fetch_one(&mut *tx).await?;
    sqlx::query(
        "DELETE FROM sync_cursors WHERE user_id=$1 AND token<>$2 AND \
         (expires_at<=now() OR token IN \
           (SELECT token FROM sync_cursors WHERE user_id=$1 AND token<>$2 \
            ORDER BY expires_at DESC,position DESC OFFSET $3))",
    )
    .bind(user)
    .bind(&token)
    .bind(limits::CURSORS_PER_USER - 1)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(token)
}

fn wire_len(value: &impl Serialize) -> Result<usize> {
    serde_json::to_vec(value)
        .map(|v| v.len())
        .map_err(|_| Error::internal())
}

fn snapshot_limit() -> Error {
    Error::new(axum::http::StatusCode::CONFLICT, "snapshot_limit")
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
        return Err(snapshot_limit());
    }
    let rooms: Vec<_> = rooms.into_iter().map(RoomRow::wire).collect();
    let mut bytes = wire_len(&rooms)? + 128;
    let mut messages = Vec::new();
    for room in &rooms {
        let query =
            format!("{MESSAGE_SELECT} WHERE m.room_id=$1 ORDER BY m.position DESC LIMIT 50");
        for message in sqlx::query_as::<_, MessageRow>(&query)
            .bind(&room.id)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(MessageRow::wire)
        {
            bytes += wire_len(&message)? + 1;
            if bytes > limits::SNAPSHOT_BYTES {
                return Err(snapshot_limit());
            }
            messages.push(message);
        }
    }
    let mut snapshot = Snapshot {
        protocol_version: VERSION,
        rooms,
        messages,
        cursor: "0".repeat(64),
    };
    if wire_len(&snapshot)? > limits::SNAPSHOT_BYTES {
        return Err(snapshot_limit());
    }
    tx.commit().await?;
    // Cursor bookkeeping is separate from the consistent read. Its default
    // READ COMMITTED upsert also permits concurrent devices at the same watermark.
    snapshot.cursor = cursor(&app.pool, &account.id, &epoch, position).await?;
    Ok(snapshot)
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
        "SELECT position FROM sync_cursors WHERE token=$1 AND user_id=$2 AND data_epoch=$3 AND expires_at>now()",
    )
    .bind(token)
    .bind(&account.id)
    .bind(&epoch)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(after) = after else {
        return Err(Error::new(
            axum::http::StatusCode::CONFLICT,
            "sync_reset_required",
        ));
    };
    // Scan a bounded range including unauthorized events; advance over them without
    // exposing their content or the instance's global sequence numbers.
    let scanned: Vec<(i64, String, Option<String>, Json<Change>)> = sqlx::query_as(
        "WITH scanned AS \
           (SELECT position,room_id,recipient_id,change FROM journal WHERE position>$1 AND position<=$2 ORDER BY position LIMIT $3), \
         sized AS (SELECT *,sum(octet_length(change::text)) OVER (ORDER BY position) AS bytes FROM scanned) \
         SELECT position,room_id,recipient_id,change FROM sized WHERE bytes<=$4 ORDER BY position",
    ).bind(after).bind(high).bind(limit.clamp(1,100)).bind((limits::BATCH_BYTES-1024) as i64).fetch_all(&mut *tx).await?;
    if scanned.is_empty() && after < high {
        return Err(Error::new(axum::http::StatusCode::CONFLICT, "event_limit"));
    }
    let mut output = Vec::new();
    let mut bytes = 128;
    let mut last = after;
    for (position, room_id, recipient, change) in scanned {
        if let Some(recipient) = recipient {
            if recipient == account.id {
                // A withdrawal contains only an ID previously accessible to this user.
                if matches!(change.0, Change::RoomRemoved { .. }) {
                    let size = wire_len(&change.0)? + 1;
                    if bytes + size > limits::BATCH_BYTES {
                        break;
                    }
                    bytes += size;
                    output.push(change.0);
                    last = position;
                    continue;
                }
            } else {
                last = position;
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
            let size = wire_len(&change.0)? + 1;
            if bytes + size > limits::BATCH_BYTES {
                break;
            }
            bytes += size;
            output.push(change.0);
        }
        last = position;
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
