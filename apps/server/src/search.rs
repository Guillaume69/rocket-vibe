//! Search current authorized plaintext, bounded independently of message writes.
use crate::{
    App,
    auth::{self, Account},
    error::{Error, Result},
    store::{self, MESSAGE_SELECT, MessageRow},
};
use rv_protocol::{
    Message,
    search::{SearchMessages, SearchPage},
};

pub(crate) async fn messages(
    app: &App,
    actor: &Account,
    room: &str,
    input: SearchMessages,
) -> Result<SearchPage> {
    let query = input.q.trim();
    let limit = i64::from(input.limit.unwrap_or(50));
    let before = input
        .before
        .as_deref()
        .map(|p| {
            p.parse::<i64>()
                .ok()
                .filter(|n| *n > 0 && n.to_string() == p)
                .ok_or_else(Error::invalid)
        })
        .transpose()?;
    if !auth::identifier(room)
        || query.is_empty()
        || query.len() > 256
        || query.split_whitespace().count() > 16
        || !query.chars().any(char::is_alphanumeric)
        || !(1..=50).contains(&limit)
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    store::require_member(&mut tx, room, &actor.id).await?;
    let (attempts, retry): (i32, i64) = sqlx::query_as("INSERT INTO search_windows(device_id,attempts,expires_at) SELECT device_id,1,clock_timestamp()+interval '60 seconds' FROM sessions WHERE token_hash=$1 ON CONFLICT(device_id) DO UPDATE SET attempts=CASE WHEN search_windows.expires_at<=clock_timestamp() THEN 1 ELSE search_windows.attempts+1 END,expires_at=CASE WHEN search_windows.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '60 seconds' ELSE search_windows.expires_at END RETURNING attempts,GREATEST(1,ceil(extract(epoch FROM expires_at-clock_timestamp())))::bigint")
        .bind(&actor.session_hash).fetch_one(&mut *tx).await?;
    if attempts > 20 {
        return Err(Error::throttled("search_rate_limited", retry as u64));
    }
    // Reserve the budget before starting a stable read snapshot. Concurrent
    // requests serialize this small write without sharing a stale snapshot.
    tx.commit().await?;
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='2s'")
        .execute(&mut *tx)
        .await?;
    store::require_member(&mut tx, room, &actor.id).await?;
    let membership_version: String = sqlx::query_scalar(
        "SELECT membership_version FROM room_read_states WHERE room_id=$1 AND user_id=$2",
    )
    .bind(room)
    .bind(&actor.id)
    .fetch_one(&mut *tx)
    .await?;
    let sql = format!(
        "{MESSAGE_SELECT} WHERE m.room_id=$1 AND NOT m.deleted AND m.system IS NULL AND m.position<$2 AND (m.search_vector @@ plainto_tsquery('simple'::regconfig,$3) OR m.cards_search_vector @@ plainto_tsquery('simple'::regconfig,$3)) ORDER BY m.position DESC LIMIT $4"
    );
    let mut messages: Vec<Message> = sqlx::query_as::<_, MessageRow>(&sql)
        .bind(room)
        .bind(before.unwrap_or(i64::MAX))
        .bind(query)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(MessageRow::wire)
        .collect();
    let has_more = messages.len() > limit as usize;
    messages.truncate(limit as usize);
    crate::marks::personalize(&mut tx, &actor.id, &mut messages).await?;
    crate::quotes::personalize(&mut tx, &actor.id, &mut messages).await?;
    tx.commit().await?;
    let mut page = SearchPage {
        membership_version,
        messages,
        has_more,
    };
    while serde_json::to_vec(&page)
        .map_err(|_| Error::internal())?
        .len()
        > 512 * 1024
    {
        if page.messages.len() <= 1 {
            return Err(Error::new(
                axum::http::StatusCode::PAYLOAD_TOO_LARGE,
                "search_result_too_large",
            ));
        }
        page.messages.pop();
        page.has_more = true;
    }
    Ok(page)
}
