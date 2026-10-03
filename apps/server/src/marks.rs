//! Public pins and private, independently versioned account stars.
use crate::{
    App,
    auth::{Account, identifier, lock_active},
    error::{Error, Result},
    store::{self, MESSAGE_SELECT, MessageRow},
};
use axum::http::StatusCode;
use rv_protocol::{Change, Message, MessagePage, PersonalStar, parity::SetMark};

pub(crate) async fn personalize_mentions(
    conn: &mut sqlx::PgConnection,
    user: &str,
    messages: &mut [Message],
) -> Result<()> {
    let ids: Vec<_> = messages
        .iter()
        .filter(|m| !m.deleted)
        .map(|m| m.id.clone())
        .collect();
    let mentions: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT message_id FROM message_mentions WHERE user_id=$1 AND message_id=ANY($2)",
    )
    .bind(user)
    .bind(&ids)
    .fetch_all(conn)
    .await?;
    for message in messages {
        message.personal_mention = Some(!message.deleted && mentions.contains(&message.id));
    }
    Ok(())
}
pub(crate) async fn personalize(
    conn: &mut sqlx::PgConnection,
    user: &str,
    messages: &mut [Message],
) -> Result<()> {
    let ids: Vec<_> = messages
        .iter()
        .filter(|m| !m.deleted)
        .map(|m| m.id.clone())
        .collect();
    let rows: Vec<(String,bool,i64)> = sqlx::query_as("SELECT message_id,present,revision FROM message_stars WHERE user_id=$1 AND message_id=ANY($2)")
        .bind(user).bind(&ids).fetch_all(&mut *conn).await?;
    personalize_mentions(conn, user, messages).await?;
    for message in messages {
        message.personal_star = Some(Box::new(
            rows.iter()
                .find(|r| r.0 == message.id)
                .map(|r| PersonalStar {
                    present: r.1,
                    revision: r.2.to_string(),
                })
                .unwrap_or(PersonalStar {
                    present: false,
                    revision: "0".into(),
                }),
        ));
    }
    Ok(())
}

pub async fn apply(
    app: &App,
    account: &Account,
    id: &str,
    input: SetMark,
    starred: bool,
) -> Result<()> {
    if !identifier(id) || !identifier(&input.operation_id) {
        return Err(Error::invalid());
    }
    let hash = crate::auth::hash_token(
        &serde_json::json!([if starred { "star" } else { "pin" }, id, input.present]).to_string(),
    );
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, account).await?;
    let room: String = sqlx::query_scalar("SELECT room_id FROM messages WHERE id=$1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::missing)?;
    sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR UPDATE")
        .bind(&room)
        .execute(&mut *tx)
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
    let used: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_creation_requests WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_commands WHERE user_id=$1 AND operation_id=$2)")
        .bind(&account.id).bind(&input.operation_id).fetch_one(&mut *tx).await?;
    if used {
        return Err(Error::conflict());
    }
    if !starred && role != "owner" && role != "moderator" {
        return Err(Error::forbidden());
    }
    if message.deleted {
        return Err(Error::new(StatusCode::GONE, "message_deleted"));
    }
    if message.system.is_some() {
        return Err(Error::forbidden());
    }
    let present = if starred {
        sqlx::query_scalar::<_, bool>(
            "SELECT present FROM message_stars WHERE message_id=$1 AND user_id=$2",
        )
        .bind(id)
        .bind(&account.id)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or(false)
    } else {
        message.pinned
    };
    crate::limits::message_action(&mut tx, &account.id).await?;
    if present != input.present {
        let position = store::next_position(&mut tx).await?;
        if starred {
            sqlx::query("INSERT INTO message_stars(message_id,user_id,present,revision) VALUES($1,$2,$3,$4) ON CONFLICT(message_id,user_id) DO UPDATE SET present=excluded.present,revision=excluded.revision")
                .bind(id).bind(&account.id).bind(input.present).bind(position).execute(&mut *tx).await?;
        } else {
            sqlx::query("UPDATE messages SET pinned=$2,revision=$3 WHERE id=$1")
                .bind(id)
                .bind(input.present)
                .bind(position)
                .execute(&mut *tx)
                .await?;
        }
        let mut current =
            sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
                .bind(id)
                .fetch_one(&mut *tx)
                .await?
                .wire();
        if starred {
            personalize(&mut tx, &account.id, std::slice::from_mut(&mut current)).await?;
        }
        store::event(
            &mut tx,
            position,
            &room,
            starred.then_some(account.id.as_str()),
            Change::MessageUpsert(current),
        )
        .await?;
    }
    sqlx::query("INSERT INTO message_actions(user_id,operation_id,command_hash,message_id) VALUES($1,$2,$3,$4)")
        .bind(&account.id).bind(&input.operation_id).bind(hash).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn list(
    app: &App,
    account: &Account,
    room: &str,
    before: Option<i64>,
    limit: i64,
    starred: bool,
) -> Result<MessagePage> {
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    store::require_member(&mut tx, room, &account.id).await?;
    let condition = if starred {
        "EXISTS(SELECT 1 FROM message_stars s WHERE s.message_id=m.id AND s.user_id=$4 AND s.present)"
    } else {
        "m.pinned AND $4::text IS NOT NULL"
    };
    let mut messages: Vec<_> = sqlx::query_as::<_,MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.room_id=$1 AND NOT m.deleted AND m.position<$2 AND {condition} ORDER BY m.position DESC LIMIT $3"))
        .bind(room).bind(before.unwrap_or(i64::MAX)).bind(limit+1).bind(&account.id).fetch_all(&mut *tx).await?.into_iter().map(MessageRow::wire).collect();
    let has_more = messages.len() > limit as usize;
    messages.truncate(limit as usize);
    personalize(&mut tx, &account.id, &mut messages).await?;
    crate::quotes::personalize(&mut tx, &account.id, &mut messages).await?;
    tx.commit().await?;
    Ok(MessagePage { messages, has_more })
}
