//! Same-room roots and replies, with independent monotone thread reads.
use crate::{
    App,
    auth::{Account, identifier, lock_active},
    error::{Error, Result},
    room_reads,
    store::{self, MESSAGE_SELECT, MessageRow},
};
use axum::http::StatusCode;
use rv_protocol::{Change, MarkThreadRead, ThreadPage, ThreadReadState, parity::QuoteReference};
use sqlx::{Postgres, Transaction};

pub(crate) fn send_fingerprint(
    room: &str,
    text: &str,
    quotes: &[QuoteReference],
    root: Option<&str>,
) -> String {
    match root {
        None => store::quoted_send_fingerprint(room, text, quotes),
        Some(root) => {
            crate::auth::hash_token(&serde_json::json!([room, text, quotes, root]).to_string())
        }
    }
}

pub(crate) async fn validate_root(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    root: &str,
) -> Result<()> {
    let row: Option<(Option<String>, bool, bool)> = sqlx::query_as(
        "SELECT reply_to,deleted,system IS NOT NULL FROM messages WHERE id=$1 AND room_id=$2",
    )
    .bind(root)
    .bind(room)
    .fetch_optional(&mut **tx)
    .await?;
    let (parent, deleted, system) = row.ok_or_else(Error::missing)?;
    if deleted {
        return Err(Error::new(StatusCode::GONE, "thread_root_deleted"));
    }
    if parent.is_some() || system {
        return Err(Error::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_thread_root",
        ));
    }
    Ok(())
}

pub(crate) async fn refresh(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    root: &str,
) -> Result<()> {
    let revision = store::next_position(tx).await?;
    sqlx::query("UPDATE messages SET revision=$2 WHERE id=$1")
        .bind(root)
        .bind(revision)
        .execute(&mut **tx)
        .await?;
    let message = sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
        .bind(root)
        .fetch_one(&mut **tx)
        .await?
        .wire();
    store::event(tx, revision, room, None, Change::MessageUpsert(message)).await
}

pub(crate) async fn root_room(
    conn: &mut sqlx::PgConnection,
    user: &str,
    root: &str,
) -> Result<String> {
    if !identifier(root) {
        return Err(Error::invalid());
    }
    sqlx::query_scalar("SELECT m.room_id FROM messages m JOIN members a ON a.room_id=m.room_id WHERE m.id=$1 AND a.user_id=$2 AND m.reply_to IS NULL AND m.system IS NULL")
        .bind(root).bind(user).fetch_optional(conn).await?.ok_or_else(Error::missing)
}

async fn state(
    conn: &mut sqlx::PgConnection,
    user: &str,
    root: &str,
    room: &str,
) -> Result<ThreadReadState> {
    let (membership,position,revision,unread):(String,i64,i64,i64)=sqlx::query_as("SELECT s.membership_version,GREATEST(s.reply_position,COALESCE(t.position,0)),GREATEST(s.revision,COALESCE(t.revision,0)),(SELECT count(*) FROM messages m WHERE m.reply_to=$1 AND m.position>GREATEST(s.reply_position,COALESCE(t.position,0)) AND m.author_id<>s.user_id AND NOT m.deleted) FROM room_read_states s LEFT JOIN thread_read_states t ON t.root_id=$1 AND t.user_id=s.user_id WHERE s.room_id=$2 AND s.user_id=$3")
        .bind(root).bind(room).bind(user).fetch_one(conn).await?;
    Ok(ThreadReadState {
        root_id: root.into(),
        room_id: room.into(),
        membership_version: membership,
        position: position.to_string(),
        revision: revision.to_string(),
        unread: unread.to_string(),
    })
}

pub async fn page(
    app: &App,
    actor: &Account,
    root: &str,
    before: Option<i64>,
    limit: i64,
) -> Result<ThreadPage> {
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let room = root_room(&mut tx, &actor.id, root).await?;
    let parent = sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
        .bind(root)
        .fetch_one(&mut *tx)
        .await?
        .wire();
    let mut messages = sqlx::query_as::<_, MessageRow>(&format!(
        "{MESSAGE_SELECT} WHERE m.reply_to=$1 AND m.position<$2 ORDER BY m.position DESC LIMIT $3"
    ))
    .bind(root)
    .bind(before.unwrap_or(i64::MAX))
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(MessageRow::wire)
    .collect::<Vec<_>>();
    let has_more = messages.len() > limit as usize;
    messages.truncate(limit as usize);
    // Resolve root and replies together from the same authorized view.
    messages.insert(0, parent);
    crate::marks::personalize(&mut tx, &actor.id, &mut messages).await?;
    crate::quotes::personalize(&mut tx, &actor.id, &mut messages).await?;
    let parent = messages.remove(0);
    let read_state = state(&mut tx, &actor.id, root, &room).await?;
    tx.commit().await?;
    Ok(ThreadPage {
        root: parent,
        messages,
        has_more,
        read_state,
    })
}

pub async fn mark(
    app: &App,
    actor: &Account,
    root: &str,
    input: MarkThreadRead,
) -> Result<ThreadReadState> {
    let position = room_reads::position(&input.position)?;
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, actor).await?;
    let room = root_room(&mut tx, &actor.id, root).await?;
    room_reads::lock_room(&mut tx, &room).await?;
    store::require_member(&mut tx, &room, &actor.id).await?;
    let highest: i64 =
        sqlx::query_scalar("SELECT COALESCE(max(position),0) FROM messages WHERE reply_to=$1")
            .bind(root)
            .fetch_one(&mut *tx)
            .await?;
    if position > highest {
        return Err(Error::new(StatusCode::CONFLICT, "invalid_read_position"));
    }
    let current = state(&mut tx, &actor.id, root, &room).await?;
    if position > room_reads::position(&current.position)? {
        room_reads::admission(&mut tx, &actor.id).await?;
        let revision = store::next_position(&mut tx).await?;
        sqlx::query("INSERT INTO thread_read_states(root_id,room_id,user_id,position,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(root_id,user_id) DO UPDATE SET position=GREATEST(thread_read_states.position,excluded.position),revision=excluded.revision")
            .bind(root).bind(&room).bind(&actor.id).bind(position).bind(revision).execute(&mut *tx).await?;
        sqlx::query("UPDATE room_read_states SET revision=$3 WHERE room_id=$1 AND user_id=$2")
            .bind(&room)
            .bind(&actor.id)
            .bind(revision)
            .execute(&mut *tx)
            .await?;
        room_reads::publish(&mut tx, &room, Some(&actor.id), revision).await?;
    }
    let result = state(&mut tx, &actor.id, root, &room).await?;
    tx.commit().await?;
    Ok(result)
}
