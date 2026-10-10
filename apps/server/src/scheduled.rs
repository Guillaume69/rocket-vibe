//! Scheduled messages: text the server sends for its author at `send_at`.
//!
//! The row's operation id becomes the sent message's: a worker that dies
//! after the send and before removing the row replays the same operation,
//! which the send path answers with the message already made.
use crate::{
    App,
    auth::{self, Account, identifier},
    error::{Error, Result},
    store,
};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, Utc};
use rv_protocol::{
    SendMessage,
    scheduled::{
        MAX_DAYS, MAX_PENDING, MIN_DELAY_SECONDS, ScheduleMessage, ScheduledMessage,
        ScheduledMessages, ScheduledState,
    },
};

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    room_id: String,
    text: String,
    reply_to: Option<String>,
    send_at: DateTime<Utc>,
    state: String,
    error: Option<String>,
}

impl Row {
    fn dto(self) -> ScheduledMessage {
        ScheduledMessage {
            id: self.id,
            room_id: self.room_id,
            text: self.text,
            reply_to: self.reply_to,
            send_at: self
                .send_at
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            state: if self.state == "failed" {
                ScheduledState::Failed
            } else {
                ScheduledState::Pending
            },
            error: self.error,
        }
    }
}

const COLUMNS: &str = "id,room_id,text,reply_to,send_at,state,error";

pub(crate) async fn schedule(
    app: &App,
    actor: &Account,
    room: &str,
    input: ScheduleMessage,
) -> Result<ScheduledMessage> {
    if !identifier(&input.operation_id)
        || !identifier(room)
        || input.text.trim().is_empty()
        || input.text.len() > 32_768
        || input
            .reply_to
            .as_ref()
            .is_some_and(|root| !identifier(root))
    {
        return Err(Error::invalid());
    }
    let send_at = DateTime::parse_from_rfc3339(&input.send_at)
        .map_err(|_| Error::invalid())?
        .with_timezone(&Utc);
    let mut tx = app.pool.begin().await?;
    // Serializes the account's commands and checks its session.
    auth::lock_active(&mut tx, actor).await?;
    let replay: Option<Row> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM scheduled_messages WHERE user_id=$1 AND operation_id=$2"
    ))
    .bind(&actor.id)
    .bind(&input.operation_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = replay {
        tx.commit().await?;
        // The same operation answers what it made; another body under its id is a conflict.
        return if row.room_id == room && row.text == input.text && row.reply_to == input.reply_to {
            Ok(row.dto())
        } else {
            Err(Error::conflict())
        };
    }
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    // A little slack below the minimum: the client chose "in one minute" a moment ago.
    if send_at < now + Duration::seconds(MIN_DELAY_SECONDS - 10)
        || send_at > now + Duration::days(MAX_DAYS)
    {
        return Err(Error::invalid());
    }
    store::require_member(&mut tx, room, &actor.id).await?;
    crate::permissions::require_send(&mut tx, room, &actor.id).await?;
    let encrypted: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e2ee_groups WHERE room_id=$1)")
            .bind(room)
            .fetch_one(&mut *tx)
            .await?;
    if encrypted {
        // The server never holds an encrypted room's plaintext.
        return Err(Error::new(StatusCode::CONFLICT, "encrypted_room"));
    }
    if let Some(root) = &input.reply_to {
        let root_ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE id=$1 AND room_id=$2 AND reply_to IS NULL AND NOT deleted)")
            .bind(root)
            .bind(room)
            .fetch_one(&mut *tx)
            .await?;
        if !root_ok {
            return Err(Error::invalid());
        }
    }
    // An id already used by a sent message would make the send a silent replay.
    let used: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1 AND operation_id=$2)",
    )
    .bind(&actor.id)
    .bind(&input.operation_id)
    .fetch_one(&mut *tx)
    .await?;
    if used {
        return Err(Error::conflict());
    }
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM scheduled_messages WHERE user_id=$1 AND state='pending'",
    )
    .bind(&actor.id)
    .fetch_one(&mut *tx)
    .await?;
    if pending >= MAX_PENDING {
        return Err(Error::new(StatusCode::CONFLICT, "scheduled_limit"));
    }
    let row: Row = sqlx::query_as(&format!(
        "INSERT INTO scheduled_messages(user_id,room_id,operation_id,text,reply_to,send_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING {COLUMNS}"
    ))
    .bind(&actor.id)
    .bind(room)
    .bind(&input.operation_id)
    .bind(&input.text)
    .bind(&input.reply_to)
    .bind(send_at)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row.dto())
}

pub(crate) async fn list(app: &App, actor: &Account) -> Result<ScheduledMessages> {
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM scheduled_messages WHERE user_id=$1 ORDER BY send_at,id LIMIT 200"
    ))
    .bind(&actor.id)
    .fetch_all(&app.pool)
    .await?;
    Ok(ScheduledMessages {
        messages: rows.into_iter().map(Row::dto).collect(),
    })
}

/// Cancels a pending one, or dismisses a failed one. One the worker is
/// sending right now answers `scheduled_sending`: it is about to arrive.
pub(crate) async fn cancel(app: &App, actor: &Account, id: &str) -> Result<()> {
    if !identifier(id) {
        return Err(Error::invalid());
    }
    let gone = sqlx::query("DELETE FROM scheduled_messages WHERE id=$1 AND user_id=$2 AND (state='failed' OR lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())")
        .bind(id)
        .bind(&actor.id)
        .execute(&app.pool)
        .await?
        .rows_affected();
    if gone > 0 {
        return Ok(());
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM scheduled_messages WHERE id=$1 AND user_id=$2)",
    )
    .bind(id)
    .bind(&actor.id)
    .fetch_one(&app.pool)
    .await?;
    Err(if exists {
        Error::new(StatusCode::CONFLICT, "scheduled_sending")
    } else {
        Error::missing()
    })
}

#[derive(sqlx::FromRow)]
struct Due {
    id: String,
    user_id: String,
    room_id: String,
    operation_id: String,
    text: String,
    reply_to: Option<String>,
}

/// One tick: the due messages are leased, sent, then removed, or marked failed.
pub async fn drain(app: &App) -> Result<()> {
    let due: Vec<Due> = sqlx::query_as("WITH due AS (SELECT id FROM scheduled_messages WHERE state='pending' AND send_at<=clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY send_at,id LIMIT 16 FOR UPDATE SKIP LOCKED) UPDATE scheduled_messages s SET lease_expires_at=clock_timestamp()+interval '1 minute' FROM due WHERE s.id=due.id RETURNING s.id,s.user_id,s.room_id,s.operation_id,s.text,s.reply_to")
        .fetch_all(&app.pool)
        .await?;
    for row in due {
        match send(app, &row).await {
            Ok(()) => {
                sqlx::query("DELETE FROM scheduled_messages WHERE id=$1")
                    .bind(&row.id)
                    .execute(&app.pool)
                    .await?;
            }
            // The database or the server itself: the lease lapses and the next tick retries.
            Err(error) if error.status.is_server_error() => {
                tracing::warn!(code = error.code, "scheduled message will be retried");
            }
            Err(error) => {
                sqlx::query("UPDATE scheduled_messages SET state='failed',error=$2,lease_expires_at=NULL WHERE id=$1")
                    .bind(&row.id)
                    .bind(error.code)
                    .execute(&app.pool)
                    .await?;
            }
        }
    }
    Ok(())
}

/// Sends as the author, through one of their live sessions (the send path
/// checks the account is active and still allowed to post in the room).
async fn send(app: &App, row: &Due) -> Result<()> {
    let hash: Option<String> = sqlx::query_scalar("SELECT token_hash FROM sessions WHERE user_id=$1 AND expires_at>clock_timestamp() ORDER BY expires_at DESC LIMIT 1")
        .bind(&row.user_id)
        .fetch_optional(&app.pool)
        .await?;
    let Some(hash) = hash else {
        return Err(Error::new(StatusCode::UNAUTHORIZED, "no_session"));
    };
    let account = auth::authenticate(app, &hash).await?;
    let encrypted: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e2ee_groups WHERE room_id=$1)")
            .bind(&row.room_id)
            .fetch_one(&app.pool)
            .await?;
    if encrypted {
        return Err(Error::new(StatusCode::CONFLICT, "encrypted_room"));
    }
    store::send(
        app,
        &account,
        &row.room_id,
        SendMessage {
            operation_id: row.operation_id.clone(),
            text: row.text.clone(),
            reply_to: row.reply_to.clone(),
            quotes: vec![],
            cards: vec![],
            files: vec![],
        },
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rv_protocol::CreateRoom;
    use sqlx::PgPool;

    const PASSWORD: &str = "disposable-scheduled-test-password";

    async fn account(app: &App, name: &str) -> Account {
        auth::create_user(app, name, PASSWORD.into(), false)
            .await
            .unwrap();
        let session = auth::login(app, name.into(), PASSWORD.into())
            .await
            .unwrap();
        auth::authenticate(app, &auth::hash_token(&session.token))
            .await
            .unwrap()
    }

    fn input(operation: &str, text: &str, minutes: i64) -> ScheduleMessage {
        ScheduleMessage {
            operation_id: operation.into(),
            text: text.into(),
            reply_to: None,
            send_at: (Utc::now() + Duration::minutes(minutes)).to_rfc3339(),
        }
    }

    async fn due_now(app: &App, id: &str) {
        sqlx::query("UPDATE scheduled_messages SET send_at=now()-interval '1 second' WHERE id=$1")
            .bind(id)
            .execute(&app.pool)
            .await
            .unwrap();
    }

    async fn sent(app: &App, room: &str, text: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM messages WHERE room_id=$1 AND text=$2")
            .bind(room)
            .bind(text)
            .fetch_one(&app.pool)
            .await
            .unwrap()
    }

    #[sqlx::test]
    async fn a_scheduled_message_is_sent_once_at_its_time_and_leaves_the_list(pool: PgPool) {
        let app = App::from_pool(pool).await.unwrap();
        let alice = account(&app, "scheduled-alice").await;
        let room = store::create_room(
            &app,
            &alice,
            CreateRoom {
                name: "Later".into(),
                private: true,
                operation_id: None,
                voice: false,
            },
        )
        .await
        .unwrap();
        // Too soon, too late, empty: refused.
        for refused in [
            input("op-soon", "hi", 0),
            input("op-late", "hi", 60 * 24 * 31),
            input("op-empty", " ", 5),
        ] {
            assert!(schedule(&app, &alice, &room.id, refused).await.is_err());
        }
        let first = schedule(&app, &alice, &room.id, input("op-1", "see you later", 5))
            .await
            .unwrap();
        assert_eq!(first.state, ScheduledState::Pending);
        // A replay answers the same row; another body under the id is a conflict.
        assert_eq!(
            schedule(&app, &alice, &room.id, input("op-1", "see you later", 5))
                .await
                .unwrap()
                .id,
            first.id
        );
        assert!(
            schedule(&app, &alice, &room.id, input("op-1", "something else", 5))
                .await
                .is_err()
        );
        // Not due: nothing goes out.
        drain(&app).await.unwrap();
        assert_eq!(sent(&app, &room.id, "see you later").await, 0);
        due_now(&app, &first.id).await;
        drain(&app).await.unwrap();
        assert_eq!(sent(&app, &room.id, "see you later").await, 1);
        assert!(list(&app, &alice).await.unwrap().messages.is_empty());
        // A worker that died after the send replays the same operation: still one message.
        sqlx::query("INSERT INTO scheduled_messages(user_id,room_id,operation_id,text,send_at) VALUES($1,$2,'op-1','see you later',now())")
            .bind(&alice.id)
            .bind(&room.id)
            .execute(&app.pool)
            .await
            .unwrap();
        drain(&app).await.unwrap();
        assert_eq!(sent(&app, &room.id, "see you later").await, 1);
    }

    #[sqlx::test]
    async fn a_cancelled_one_never_goes_and_a_lost_room_fails_visibly(pool: PgPool) {
        let app = App::from_pool(pool).await.unwrap();
        let alice = account(&app, "scheduled-owner").await;
        let bob = account(&app, "scheduled-bob").await;
        let room = store::create_room(
            &app,
            &alice,
            CreateRoom {
                name: "Gone".into(),
                private: true,
                operation_id: None,
                voice: false,
            },
        )
        .await
        .unwrap();
        store::membership(&app, &alice, &room.id, &bob.id, false)
            .await
            .unwrap();
        let cancelled = schedule(&app, &bob, &room.id, input("op-c", "never sent", 5))
            .await
            .unwrap();
        cancel(&app, &bob, &cancelled.id).await.unwrap();
        assert!(cancel(&app, &bob, &cancelled.id).await.is_err());
        let orphan = schedule(&app, &bob, &room.id, input("op-o", "too late", 5))
            .await
            .unwrap();
        // Another account cannot touch it.
        assert!(cancel(&app, &alice, &orphan.id).await.is_err());
        store::membership(&app, &alice, &room.id, &bob.id, true)
            .await
            .unwrap();
        due_now(&app, &orphan.id).await;
        drain(&app).await.unwrap();
        assert_eq!(sent(&app, &room.id, "too late").await, 0);
        let listed = list(&app, &bob).await.unwrap().messages;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].state, ScheduledState::Failed);
        assert!(listed[0].error.is_some());
        // Its author dismisses it.
        cancel(&app, &bob, &orphan.id).await.unwrap();
        assert!(list(&app, &bob).await.unwrap().messages.is_empty());
    }
}
