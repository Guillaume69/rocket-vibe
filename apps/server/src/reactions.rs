//! Explicit reaction state, deduplicated across retries and process restarts.
use crate::{
    App,
    auth::{Account, identifier, lock_active},
    error::{Error, Result},
    store::{self, MESSAGE_SELECT, MessageRow},
};
use axum::http::StatusCode;
use rv_protocol::{Change, parity::SetReaction};

pub async fn apply(app: &App, account: &Account, id: &str, input: SetReaction) -> Result<()> {
    if !identifier(id) || !identifier(&input.operation_id) {
        return Err(Error::invalid());
    }
    let emoji = rv_protocol::emojis::canonical(&input.emoji)
        .ok_or_else(|| Error::new(StatusCode::UNPROCESSABLE_ENTITY, "unknown_emoji"))?;
    let hash = crate::auth::hash_token(
        &serde_json::json!(["react", id, emoji, input.present]).to_string(),
    );
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, account).await?;
    let room: Option<String> = sqlx::query_scalar("SELECT room_id FROM messages WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let room = room.ok_or_else(Error::missing)?;
    let read_only: bool = sqlx::query_scalar("SELECT read_only FROM rooms WHERE id=$1 FOR UPDATE")
        .bind(&room)
        .fetch_one(&mut *tx)
        .await?;
    let role = store::require_member(&mut tx, &room, &account.id).await?;
    let message =
        sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1 FOR UPDATE OF m"))
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let receipt: Option<String> = sqlx::query_scalar(
        "SELECT command_hash FROM message_actions WHERE user_id=$1 AND operation_id=$2",
    )
    .bind(&account.id)
    .bind(&input.operation_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(previous) = receipt {
        if previous != hash {
            return Err(Error::conflict());
        }
        tx.commit().await?;
        return Ok(());
    }
    let used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_creation_requests WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_commands WHERE user_id=$1 AND operation_id=$2)").bind(&account.id).bind(&input.operation_id).fetch_one(&mut *tx).await?;
    if used {
        return Err(Error::conflict());
    }
    if read_only && role != "owner" && role != "moderator" {
        return Err(Error::forbidden());
    }
    if message.deleted {
        return Err(Error::new(StatusCode::GONE, "message_deleted"));
    }
    if message.system.is_some() {
        return Err(Error::forbidden());
    }
    let present:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3)").bind(id).bind(&account.id).bind(emoji).fetch_one(&mut *tx).await?;
    if input.present && !present {
        let (total,groups,own,group_exists):(i64,i64,i64,bool)=sqlx::query_as("SELECT count(*),count(DISTINCT emoji),count(*) FILTER (WHERE user_id=$2),COALESCE(bool_or(emoji=$3),false) FROM message_reactions WHERE message_id=$1").bind(id).bind(&account.id).bind(emoji).fetch_one(&mut *tx).await?;
        // Bounds both UI chips and the payloads of history/journal/snapshot pages.
        if total >= 256 || own >= 16 || groups >= 32 && !group_exists {
            return Err(Error::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "reaction_limit",
            ));
        }
    }
    crate::limits::message_action(&mut tx, &account.id).await?;
    if present != input.present {
        if input.present {
            sqlx::query("INSERT INTO message_reactions(message_id,user_id,emoji) VALUES($1,$2,$3)")
                .bind(id)
                .bind(&account.id)
                .bind(emoji)
                .execute(&mut *tx)
                .await?;
        } else {
            sqlx::query(
                "DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3",
            )
            .bind(id)
            .bind(&account.id)
            .bind(emoji)
            .execute(&mut *tx)
            .await?;
        }
        let position = store::next_position(&mut tx).await?;
        sqlx::query("UPDATE messages SET revision=$2 WHERE id=$1")
            .bind(id)
            .bind(position)
            .execute(&mut *tx)
            .await?;
        let current = sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
            .bind(id)
            .fetch_one(&mut *tx)
            .await?
            .wire();
        store::event(
            &mut tx,
            position,
            &room,
            None,
            Change::MessageUpsert(current),
        )
        .await?;
    }
    sqlx::query("INSERT INTO message_actions(user_id,operation_id,command_hash,message_id) VALUES($1,$2,$3,$4)").bind(&account.id).bind(&input.operation_id).bind(hash).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
