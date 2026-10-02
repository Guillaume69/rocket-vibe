//! Monotone reads and explicit, private room favorites. Roots only until P11.
use crate::{
    App,
    auth::{Account, identifier, lock_active},
    error::{Error, Result},
    store::{self, RoomRow},
};
use axum::http::StatusCode;
use rv_protocol::{
    Change, Room,
    parity::{MarkRead, ReadState, RoomCommandReceipt, SetRoomFavorite},
};
use sqlx::{Postgres, Transaction};

fn position(value: &str) -> Result<i64> {
    value
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= 0 && n.to_string() == value)
        .ok_or_else(Error::invalid)
}
pub(crate) async fn lock_room(tx: &mut Transaction<'_, Postgres>, room: &str) -> Result<()> {
    let found: Option<String> = sqlx::query_scalar("SELECT id FROM rooms WHERE id=$1 FOR UPDATE")
        .bind(room)
        .fetch_optional(&mut **tx)
        .await?;
    if found.is_none() {
        return Err(Error::missing());
    }
    Ok(())
}
pub(crate) async fn state(
    conn: &mut sqlx::PgConnection,
    room: &str,
    user: &str,
) -> Result<ReadState> {
    let (root,reply,favorite,revision,unread,membership,favorite_revision,mentions,groups):(i64,i64,bool,i64,i64,String,i64,i64,i64)=sqlx::query_as("SELECT s.root_position,s.reply_position,s.favorite,s.revision,c.unread,s.membership_version,s.favorite_revision,c.mentions,c.groups FROM room_read_states s CROSS JOIN LATERAL (SELECT count(*) AS unread,count(*) FILTER (WHERE EXISTS(SELECT 1 FROM message_mentions p WHERE p.message_id=m.id AND p.user_id=s.user_id AND p.kind='direct')) AS mentions,count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM message_mentions p WHERE p.message_id=m.id AND p.user_id=s.user_id AND p.kind='direct') AND EXISTS(SELECT 1 FROM message_mentions p WHERE p.message_id=m.id AND p.user_id=s.user_id AND p.kind IN ('all','here'))) AS groups FROM messages m WHERE m.room_id=s.room_id AND m.position>s.root_position AND m.author_id<>s.user_id AND NOT m.deleted AND m.system IS NULL) c WHERE s.room_id=$1 AND s.user_id=$2")
        .bind(room).bind(user).fetch_optional(conn).await?.ok_or_else(Error::missing)?;
    Ok(ReadState {
        room_id: room.into(),
        membership_version: Some(membership),
        favorite_revision: Some(favorite_revision.to_string()),
        revision: revision.to_string(),
        root_position: root.to_string(),
        reply_position: reply.to_string(),
        unread_roots: unread.to_string(),
        unread_replies: "0".into(),
        mentions: mentions.to_string(),
        group_mentions: groups.to_string(),
        favorite,
    })
}
pub async fn read(app: &App, actor: &Account, room: &str) -> Result<ReadState> {
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    store::require_member(&mut tx, room, &actor.id).await?;
    let result = state(&mut tx, room, &actor.id).await?;
    tx.commit().await?;
    Ok(result)
}
pub(crate) async fn personalize(
    conn: &mut sqlx::PgConnection,
    user: &str,
    room: &mut Room,
) -> Result<()> {
    room.read_state = Some(Box::new(state(conn, &room.id, user).await?));
    Ok(())
}
/// Every new membership receives a fresh version before its first room event.
pub(crate) async fn initialize_revision(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    revision: i64,
) -> Result<()> {
    sqlx::query("UPDATE room_read_states SET revision=$2,favorite_revision=$2 WHERE room_id=$1 AND revision=0")
        .bind(room)
        .bind(revision)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn publish(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    user: Option<&str>,
    revision: i64,
) -> Result<()> {
    let row: RoomRow = sqlx::query_as("SELECT id,name,kind,revision FROM rooms WHERE id=$1")
        .bind(room)
        .fetch_one(&mut **tx)
        .await?;
    // Account data is attached at read time, never stored in a broadcast payload.
    store::event(tx, revision, room, user, Change::RoomUpsert(row.wire())).await
}
pub(crate) async fn message_changed(tx: &mut Transaction<'_, Postgres>, room: &str) -> Result<()> {
    let revision = store::next_position(tx).await?;
    sqlx::query("UPDATE room_read_states SET revision=$2 WHERE room_id=$1")
        .bind(room)
        .bind(revision)
        .execute(&mut **tx)
        .await?;
    publish(tx, room, None, revision).await
}
pub async fn mark(app: &App, actor: &Account, room: &str, input: MarkRead) -> Result<ReadState> {
    let root = position(&input.root_position)?;
    let reply = position(&input.reply_position)?;
    if reply != 0 {
        return Err(Error::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_feature",
        ));
    }
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, actor).await?;
    lock_room(&mut tx, room).await?;
    store::require_member(&mut tx, room, &actor.id).await?;
    let highest: i64 =
        sqlx::query_scalar("SELECT COALESCE(max(position),0) FROM messages WHERE room_id=$1")
            .bind(room)
            .fetch_one(&mut *tx)
            .await?;
    if root > highest {
        return Err(Error::new(StatusCode::CONFLICT, "invalid_read_position"));
    }
    let current = state(&mut tx, room, &actor.id).await?;
    if root > position(&current.root_position)? {
        admission(&mut tx, &actor.id).await?;
        let revision = store::next_position(&mut tx).await?;
        sqlx::query("UPDATE room_read_states SET root_position=GREATEST(root_position,$3),revision=$4 WHERE room_id=$1 AND user_id=$2").bind(room).bind(&actor.id).bind(root).bind(revision).execute(&mut *tx).await?;
        publish(&mut tx, room, Some(&actor.id), revision).await?;
    }
    let result = state(&mut tx, room, &actor.id).await?;
    tx.commit().await?;
    Ok(result)
}
pub async fn favorite(
    app: &App,
    actor: &Account,
    room: &str,
    input: SetRoomFavorite,
) -> Result<RoomCommandReceipt> {
    if !identifier(room) || !identifier(&input.operation_id) {
        return Err(Error::invalid());
    }
    position(&input.expected_revision)?;
    let fingerprint = crate::auth::hash_token(
        &serde_json::json!([
            "room_favorite",
            room,
            input.expected_revision,
            input.present
        ])
        .to_string(),
    );
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, actor).await?;
    let old:Option<(String,String,String)>=sqlx::query_as("SELECT room_id,command_hash,applied_revision FROM room_commands WHERE user_id=$1 AND operation_id=$2").bind(&actor.id).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
    if let Some((old_room, hash, applied_revision)) = old {
        if old_room != room || hash != fingerprint {
            return Err(Error::conflict());
        }
        tx.commit().await?;
        return Ok(RoomCommandReceipt {
            operation_id: input.operation_id,
            room_id: room.into(),
            applied_revision,
        });
    }
    lock_room(&mut tx, room).await?;
    store::require_member(&mut tx, room, &actor.id).await?;
    let used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_creation_requests WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM message_actions WHERE user_id=$1 AND operation_id=$2)").bind(&actor.id).bind(&input.operation_id).fetch_one(&mut *tx).await?;
    if used {
        return Err(Error::conflict());
    }
    let current = state(&mut tx, room, &actor.id).await?;
    if current.favorite_revision.as_deref() != Some(&input.expected_revision) {
        return Err(Error::new(StatusCode::CONFLICT, "revision_conflict"));
    }
    crate::room_details::admission(&mut tx, &actor.id).await?;
    let revision = if current.favorite != input.present {
        let revision = store::next_position(&mut tx).await?;
        sqlx::query(
            "UPDATE room_read_states SET favorite=$3,revision=$4,favorite_revision=$4 WHERE room_id=$1 AND user_id=$2",
        )
        .bind(room)
        .bind(&actor.id)
        .bind(input.present)
        .bind(revision)
        .execute(&mut *tx)
        .await?;
        publish(&mut tx, room, Some(&actor.id), revision).await?;
        revision.to_string()
    } else {
        current.favorite_revision.ok_or_else(Error::internal)?
    };
    sqlx::query("INSERT INTO room_commands(user_id,operation_id,room_id,command_hash,applied_revision) VALUES($1,$2,$3,$4,$5)").bind(&actor.id).bind(&input.operation_id).bind(room).bind(fingerprint).bind(&revision).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(RoomCommandReceipt {
        operation_id: input.operation_id,
        room_id: room.into(),
        applied_revision: revision,
    })
}
async fn admission(tx: &mut Transaction<'_, Postgres>, user: &str) -> Result<()> {
    let (attempts,retry):(i32,i64)=sqlx::query_as("INSERT INTO room_read_windows(user_id,attempts,expires_at) VALUES($1,1,clock_timestamp()+interval '60 seconds') ON CONFLICT(user_id) DO UPDATE SET attempts=CASE WHEN room_read_windows.expires_at<=clock_timestamp() THEN 1 ELSE room_read_windows.attempts+1 END,expires_at=CASE WHEN room_read_windows.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '60 seconds' ELSE room_read_windows.expires_at END RETURNING attempts,GREATEST(1,ceil(extract(epoch from expires_at-clock_timestamp())))::bigint").bind(user).fetch_one(&mut **tx).await?;
    if attempts > 60 {
        return Err(Error::throttled("room_read_limit", retry as u64));
    }
    Ok(())
}
