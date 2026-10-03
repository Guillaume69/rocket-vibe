//! Durable, revision-checked commands. Receipts contain fingerprints, no text.
use crate::{
    App,
    auth::{Account, identifier, lock_active, random_token},
    error::{Error, Result},
    store::{self, MESSAGE_SELECT, MessageRow},
};
use axum::http::StatusCode;
use chrono::{Duration, Utc};
use rv_protocol::{
    Change, Message,
    parity::{DeleteMessage, EditMessage, MessageContent},
};
use sqlx::types::Json;

pub enum Command {
    Edit(EditMessage),
    Delete(DeleteMessage),
}

pub async fn read(app: &App, account: &Account, id: &str) -> Result<Message> {
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let query = format!(
        "{MESSAGE_SELECT} WHERE m.id=$1 AND EXISTS(SELECT 1 FROM members g WHERE g.room_id=m.room_id AND g.user_id=$2)"
    );
    let mut message = sqlx::query_as::<_, MessageRow>(&query)
        .bind(id)
        .bind(&account.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::missing)?
        .wire();
    crate::marks::personalize(&mut tx, &account.id, std::slice::from_mut(&mut message)).await?;
    crate::quotes::personalize(&mut tx, &account.id, std::slice::from_mut(&mut message)).await?;
    tx.commit().await?;
    Ok(message)
}

pub async fn apply(app: &App, account: &Account, id: &str, command: Command) -> Result<()> {
    let (operation, expected, text, quotes, hash) = match &command {
        Command::Edit(input) => {
            let MessageContent::Plain {
                markdown,
                mentions,
                quotes,
                files,
            } = &input.content
            else {
                return Err(Error::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "unsupported_feature",
                ));
            };
            if !mentions.is_empty() || !files.is_empty() {
                return Err(Error::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "unsupported_feature",
                ));
            }
            if markdown.len() > 32_768 || !crate::quotes::valid_references(quotes, id) {
                return Err(Error::invalid());
            }
            (
                &input.operation_id,
                &input.expected_revision,
                Some(markdown.as_str()),
                quotes.as_slice(),
                crate::auth::hash_token(
                    &serde_json::json!(["edit", id, input.expected_revision, input.content])
                        .to_string(),
                ),
            )
        }
        Command::Delete(input) => (
            &input.operation_id,
            &input.expected_revision,
            None,
            &[][..],
            crate::auth::hash_token(
                &serde_json::json!(["delete", id, input.expected_revision]).to_string(),
            ),
        ),
    };
    if !identifier(operation)
        || !identifier(id)
        || expected
            .parse::<u64>()
            .ok()
            .is_none_or(|value| value.to_string() != *expected)
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, account).await?;
    let room: Option<String> = sqlx::query_scalar("SELECT room_id FROM messages WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let room = room.ok_or_else(Error::missing)?;
    crate::quotes::lock_rooms(&mut tx, &room, quotes).await?;
    let read_only: bool = sqlx::query_scalar("SELECT read_only FROM rooms WHERE id=$1")
        .bind(&room)
        .fetch_one(&mut *tx)
        .await?;
    let role = store::require_member(&mut tx, &room, &account.id).await?;
    let query = format!("{MESSAGE_SELECT} WHERE m.id=$1 FOR UPDATE OF m");
    let message = sqlx::query_as::<_, MessageRow>(&query)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let receipt: Option<String> = sqlx::query_scalar(
        "SELECT command_hash FROM message_actions WHERE user_id=$1 AND operation_id=$2",
    )
    .bind(&account.id)
    .bind(operation)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(previous) = receipt {
        if previous != hash {
            return Err(Error::conflict());
        }
        tx.commit().await?;
        return Ok(());
    }
    let used: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_creation_requests WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_commands WHERE user_id=$1 AND operation_id=$2)")
        .bind(&account.id).bind(operation).fetch_one(&mut *tx).await?;
    if used {
        return Err(Error::conflict());
    }
    let own =
        message.author_id == account.id && message.created_at + Duration::minutes(15) > Utc::now();
    if message.system.is_some() {
        return Err(Error::forbidden());
    }
    let elevated = role == "owner" || role == "moderator";
    let permitted = if text.is_some() {
        own && (!read_only || elevated)
    } else {
        own || elevated
    };
    if !permitted {
        return Err(Error::forbidden());
    }
    if message.deleted {
        return Err(Error::new(StatusCode::GONE, "message_deleted"));
    }
    if message.revision.to_string() != *expected {
        return Err(Error::new(StatusCode::CONFLICT, "revision_conflict"));
    }
    if text.is_some_and(|text| text.trim().is_empty())
        && quotes.is_empty()
        && message.files.0.is_empty()
    {
        return Err(Error::invalid());
    }
    crate::quotes::validate(&mut tx, &account.id, quotes, &message.quote_references.0).await?;
    crate::limits::message_action(&mut tx, &account.id).await?;
    let mentions_removed = crate::mentions::retain(&mut tx, id, text).await?;
    if text.is_none() {
        sqlx::query("DELETE FROM message_stars WHERE message_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE messages SET pinned=false WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM message_reactions WHERE message_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    // Invalidate views before the sequencer. All readers use room -> membership
    // -> snapshot locks, so a materialized pre-edit page cannot survive.
    // A reserved head exposes an empty room_ids until its materialization
    // commits. Match its participant first, so deletion waits for that build
    // instead of missing an uncommitted private payload.
    sqlx::query("DELETE FROM snapshot_heads WHERE user_id IN (SELECT user_id FROM members WHERE room_id=$1) OR $1=ANY(room_ids)")
        .bind(&room)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE rooms SET authority_version=$2 WHERE id=$1")
        .bind(&room)
        .bind(random_token())
        .execute(&mut *tx)
        .await?;
    let position = store::next_position(&mut tx).await?;
    sqlx::query("UPDATE messages SET text=$2,deleted=$3,revision=$4,edited_at=CASE WHEN $3 THEN edited_at ELSE clock_timestamp() END,send_fingerprint=COALESCE(send_fingerprint,$5),quote_references=$6 WHERE id=$1")
        .bind(id).bind(text.unwrap_or("")).bind(text.is_none()).bind(position).bind(store::quoted_send_fingerprint(&room,&message.text,&message.quote_references.0)).bind(Json(quotes)).execute(&mut *tx).await?;
    crate::link_previews::enqueue(&mut tx, id, text.unwrap_or("")).await?;
    let current = sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?
        .wire();
    if current.deleted {
        // Retain journal positions and durable message IDs, erase old payloads.
        // Replays now carry the authoritative tombstone even at an earlier event.
        sqlx::query("UPDATE journal SET change=$3 WHERE room_id=$1 AND change->>'type'='message_upsert' AND change #>> '{data,id}'=$2")
            .bind(&room).bind(id).bind(Json(Change::MessageUpsert(current.clone()))).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO message_actions(user_id,operation_id,command_hash,message_id) VALUES($1,$2,$3,$4)")
        .bind(&account.id).bind(operation).bind(hash).bind(id).execute(&mut *tx).await?;
    store::event(
        &mut tx,
        position,
        &room,
        None,
        Change::MessageUpsert(current),
    )
    .await?;
    if text.is_none()
        && let Some(root) = &message.reply_to
    {
        crate::threads::refresh(&mut tx, &room, root).await?;
    }
    if text.is_none() || mentions_removed {
        crate::room_reads::message_changed(&mut tx, &room).await?;
    }
    tx.commit().await?;
    Ok(())
}
