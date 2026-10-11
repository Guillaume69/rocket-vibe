//! Polls, game nights, an account's image shelf and transient voice reactions.
use crate::{
    App,
    auth::{self, Account},
    error::{Error, Result},
    store::{self, MESSAGE_SELECT, MessageRow},
};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rv_protocol::{Change, Message, SendMessage, social::*};
use sqlx::{Postgres, Transaction, types::Json};
fn line(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
fn operation(input: &CreateSocial) -> &str {
    match input {
        CreateSocial::Poll { operation_id, .. } | CreateSocial::GameNight { operation_id, .. } => {
            operation_id
        }
    }
}
fn definition(input: &CreateSocial, now: DateTime<Utc>) -> Result<SocialCard> {
    match input {
        CreateSocial::Poll {
            question,
            options,
            multiple,
            closes_at,
            ..
        } => {
            let unique: std::collections::HashSet<_> =
                options.iter().map(|s| s.trim().to_lowercase()).collect();
            if !line(question, 512)
                || !(2..=10).contains(&options.len())
                || unique.len() != options.len()
                || !options.iter().all(|s| line(s, 200))
            {
                return Err(Error::invalid());
            }
            if let Some(t) = closes_at {
                let t = DateTime::parse_from_rfc3339(t).map_err(|_| Error::invalid())?;
                if t <= now || t > now + chrono::Duration::days(30) {
                    return Err(Error::invalid());
                }
            }
            Ok(SocialCard::Poll {
                question: question.trim().into(),
                options: options
                    .iter()
                    .map(|s| PollOption {
                        label: s.trim().into(),
                        voters: vec![],
                    })
                    .collect(),
                multiple: *multiple,
                closes_at: closes_at.clone(),
                closed: false,
            })
        }
        CreateSocial::GameNight {
            title,
            starts_at,
            description,
            ..
        } => {
            let t = DateTime::parse_from_rfc3339(starts_at).map_err(|_| Error::invalid())?;
            if !line(title, 512)
                || description.len() > 4096
                || t <= now
                || t > now + chrono::Duration::days(365)
            {
                return Err(Error::invalid());
            }
            Ok(SocialCard::GameNight {
                title: title.trim().into(),
                starts_at: t.to_rfc3339(),
                description: description.clone(),
                going: vec![],
                maybe: vec![],
                declined: vec![],
            })
        }
    }
}
async fn plain_room(tx: &mut Transaction<'_, Postgres>, actor: &Account, room: &str) -> Result<()> {
    auth::lock_active(tx, actor).await?;
    let encrypted:Option<bool>=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=r.id) FROM rooms r WHERE r.id=$1 FOR UPDATE").bind(room).fetch_optional(&mut **tx).await?;
    store::require_member(tx, room, &actor.id).await?;
    if encrypted.ok_or_else(Error::missing)? {
        return Err(Error::new(StatusCode::CONFLICT, "crypto_required"));
    }
    Ok(())
}
async fn publish(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    value: SocialCard,
) -> Result<Message> {
    // Expire regenerable five-minute snapshot pages, as message_actions::write does.
    let room: String = sqlx::query_scalar("SELECT room_id FROM messages WHERE id=$1")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM snapshot_heads WHERE user_id IN (SELECT user_id FROM members WHERE room_id=$1) OR $1=ANY(room_ids)").bind(&room).execute(&mut **tx).await?;
    sqlx::query("UPDATE rooms SET authority_version=$2 WHERE id=$1")
        .bind(&room)
        .bind(auth::random_token())
        .execute(&mut **tx)
        .await?;
    let position = store::next_position(tx).await?;
    sqlx::query("UPDATE messages SET social=$2,revision=$3 WHERE id=$1")
        .bind(id)
        .bind(Json(value))
        .bind(position)
        .execute(&mut **tx)
        .await?;
    let m = sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
        .bind(id)
        .fetch_one(&mut **tx)
        .await?
        .wire();
    store::event(
        tx,
        position,
        &m.room_id,
        None,
        Change::MessageUpsert(m.clone()),
    )
    .await?;
    Ok(m)
}
pub async fn create(
    app: &App,
    actor: &Account,
    room: &str,
    input: CreateSocial,
) -> Result<Message> {
    let id = operation(&input).to_owned();
    if !auth::identifier(&id) || !auth::identifier(room) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    plain_room(&mut tx, actor, room).await?;
    let existing:Option<(String,Json<CreateSocial>)>=sqlx::query_as("SELECT m.room_id,s.definition FROM social_cards s JOIN messages m ON m.id=s.message_id WHERE s.message_id=$1 AND s.author_id=$2").bind(&id).bind(&actor.id).fetch_optional(&mut *tx).await?;
    if let Some((r, d)) = existing {
        if r != room
            || serde_json::to_value(&d.0).map_err(|_| Error::internal())?
                != serde_json::to_value(&input).map_err(|_| Error::internal())?
        {
            return Err(Error::conflict());
        }
        let m = sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1"))
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?
            .wire();
        tx.commit().await?;
        return Ok(m);
    }
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let value = definition(&input, now)?;
    let (text, reply_to) = match &input {
        CreateSocial::Poll {
            question,
            options,
            reply_to,
            ..
        } => (
            format!(
                "{}\n{}",
                question.trim(),
                options
                    .iter()
                    .enumerate()
                    .map(|(i, o)| format!("{}. {}", i + 1, o.trim()))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            reply_to.clone(),
        ),
        CreateSocial::GameNight {
            title,
            starts_at,
            description,
            reply_to,
            ..
        } => (
            format!("{}\n{}\n{}", title.trim(), starts_at, description),
            reply_to.clone(),
        ),
    };
    store::send_in_tx(
        &mut tx,
        actor,
        room,
        SendMessage {
            operation_id: id.clone(),
            text,
            reply_to,
            also_in_room: false,
            quotes: vec![],
            cards: vec![],
            files: vec![],
        },
        &[],
        None,
    )
    .await?;
    sqlx::query("INSERT INTO social_cards(message_id,author_id,definition) VALUES($1,$2,$3)")
        .bind(&id)
        .bind(&actor.id)
        .bind(Json(input))
        .execute(&mut *tx)
        .await?;
    let m = publish(&mut tx, &id, value).await?;
    tx.commit().await?;
    Ok(m)
}
async fn load(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    id: &str,
) -> Result<(String, String, CreateSocial, bool)> {
    let room: Option<String> =
        sqlx::query_scalar("SELECT room_id FROM messages WHERE id=$1 AND NOT deleted")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    let room = room.ok_or_else(Error::missing)?;
    plain_room(tx, actor, &room).await?;
    let (author, definition, closed): (String, Json<CreateSocial>, bool) = sqlx::query_as(
        "SELECT author_id,definition,closed FROM social_cards WHERE message_id=$1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(Error::missing)?;
    Ok((room, author, definition.0, closed))
}
async fn projected(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    input: &CreateSocial,
    closed: bool,
) -> Result<SocialCard> {
    let created: DateTime<Utc> = sqlx::query_scalar("SELECT created_at FROM messages WHERE id=$1")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    let mut result = definition(input, created - chrono::Duration::seconds(1))?;
    let votes:Vec<(String,Json<Vec<u32>>)>=sqlx::query_as("SELECT a.user_id,a.choices FROM social_answers a JOIN members m ON m.user_id=a.user_id JOIN messages q ON q.id=a.message_id AND q.room_id=m.room_id JOIN users u ON u.id=a.user_id WHERE a.message_id=$1 AND NOT u.disabled ORDER BY a.user_id LIMIT 200").bind(id).fetch_all(&mut **tx).await?;
    match &mut result {
        SocialCard::Poll {
            options,
            closed: out,
            closes_at,
            ..
        } => {
            *out = closed
                || closes_at.as_ref().is_some_and(|t| {
                    DateTime::parse_from_rfc3339(t).is_ok_and(|t| t <= Utc::now())
                });
            for (user, choices) in votes {
                for c in choices.0 {
                    if let Some(o) = options.get_mut(c as usize) {
                        o.voters.push(user.clone())
                    }
                }
            }
        }
        SocialCard::GameNight {
            going,
            maybe,
            declined,
            ..
        } => {
            for (user, choices) in votes {
                match choices.0.first() {
                    Some(0) => going.push(user),
                    Some(1) => maybe.push(user),
                    Some(2) => declined.push(user),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Ok(result)
}
async fn receipt(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    id: &str,
    hash: &str,
) -> Result<bool> {
    let p: Option<String> = sqlx::query_scalar(
        "SELECT command_hash FROM message_actions WHERE user_id=$1 AND operation_id=$2",
    )
    .bind(&actor.id)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(p) = p {
        if p != hash {
            return Err(Error::conflict());
        }
        return Ok(true);
    }
    let used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_commands WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_creation_requests WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM uploads WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM e2ee_application_messages WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM e2ee_message_cancellations WHERE user_id=$1 AND operation_id=$2)").bind(&actor.id).bind(id).fetch_one(&mut **tx).await?;
    if used {
        return Err(Error::conflict());
    }
    Ok(false)
}
pub async fn answer(app: &App, actor: &Account, id: &str, input: AnswerSocial) -> Result<()> {
    if !auth::identifier(id) || !auth::identifier(&input.operation_id) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let (_, _, def, closed) = load(&mut tx, actor, id).await?;
    let hash =
        auth::hash_token(&serde_json::json!(["social_answer", id, input.choices]).to_string());
    if receipt(&mut tx, actor, &input.operation_id, &hash).await? {
        tx.commit().await?;
        return Ok(());
    }
    let mut choices = input.choices.clone();
    choices.sort_unstable();
    choices.dedup();
    if choices != input.choices {
        return Err(Error::invalid());
    }
    match &def {
        CreateSocial::Poll {
            options,
            multiple,
            closes_at,
            ..
        } => {
            if closed
                || closes_at
                    .as_ref()
                    .is_some_and(|t| DateTime::parse_from_rfc3339(t).is_ok_and(|t| t <= Utc::now()))
            {
                return Err(Error::new(StatusCode::CONFLICT, "poll_closed"));
            }
            if choices.iter().any(|c| *c as usize >= options.len())
                || !multiple && choices.len() > 1
            {
                return Err(Error::invalid());
            }
        }
        CreateSocial::GameNight { starts_at, .. } => {
            if DateTime::parse_from_rfc3339(starts_at).is_ok_and(|t| t <= Utc::now()) {
                return Err(Error::new(StatusCode::CONFLICT, "event_started"));
            }
            if choices.len() > 1 || choices.iter().any(|c| *c > 2) {
                return Err(Error::invalid());
            }
        }
    }
    let participants: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM social_answers WHERE message_id=$1 AND user_id<>$2",
    )
    .bind(id)
    .bind(&actor.id)
    .fetch_one(&mut *tx)
    .await?;
    if participants >= 200 {
        return Err(Error::new(StatusCode::CONFLICT, "social_capacity"));
    }
    crate::limits::message_action(&mut tx, &actor.id).await?;
    sqlx::query("INSERT INTO social_answers(message_id,user_id,choices) VALUES($1,$2,$3) ON CONFLICT(message_id,user_id) DO UPDATE SET choices=EXCLUDED.choices").bind(id).bind(&actor.id).bind(Json(choices)).execute(&mut *tx).await?;
    let value = projected(&mut tx, id, &def, closed).await?;
    publish(&mut tx, id, value).await?;
    sqlx::query("INSERT INTO message_actions(user_id,operation_id,command_hash,message_id) VALUES($1,$2,$3,$4)").bind(&actor.id).bind(&input.operation_id).bind(hash).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn close(app: &App, actor: &Account, id: &str, input: ClosePoll) -> Result<()> {
    if !auth::identifier(&input.operation_id) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let (_, author, def, closed) = load(&mut tx, actor, id).await?;
    if author != actor.id {
        return Err(Error::forbidden());
    }
    if !matches!(def, CreateSocial::Poll { .. }) {
        return Err(Error::invalid());
    }
    let hash = auth::hash_token(&serde_json::json!(["close_poll", id]).to_string());
    if receipt(&mut tx, actor, &input.operation_id, &hash).await? {
        tx.commit().await?;
        return Ok(());
    }
    if !closed {
        crate::limits::message_action(&mut tx, &actor.id).await?;
        sqlx::query("UPDATE social_cards SET closed=true WHERE message_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let v = projected(&mut tx, id, &def, true).await?;
        publish(&mut tx, id, v).await?;
    }
    sqlx::query("INSERT INTO message_actions(user_id,operation_id,command_hash,message_id) VALUES($1,$2,$3,$4)").bind(&actor.id).bind(input.operation_id).bind(hash).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn shelf(app: &App, actor: &Account) -> Result<Vec<Sticker>> {
    Ok(sqlx::query_as::<_, (String, String, String)>(
        "SELECT id,name,url FROM sticker_shelf WHERE user_id=$1 ORDER BY name,id LIMIT 200",
    )
    .bind(&actor.id)
    .fetch_all(&app.pool)
    .await?
    .into_iter()
    .map(|(id, name, url)| Sticker { id, name, url })
    .collect())
}
pub async fn save_sticker(app: &App, actor: &Account, input: SaveSticker) -> Result<()> {
    if !auth::identifier(&input.operation_id)
        || !line(&input.name, 100)
        || !public_image(&input.url)
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sticker_shelf WHERE user_id=$1 AND url<>$2")
            .bind(&actor.id)
            .bind(&input.url)
            .fetch_one(&mut *tx)
            .await?;
    if count >= 200 {
        return Err(Error::new(StatusCode::CONFLICT, "sticker_limit"));
    }
    let old: Option<(String, String, String)> =
        sqlx::query_as("SELECT user_id,name,url FROM sticker_shelf WHERE id=$1")
            .bind(&input.operation_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((u, n, url)) = old {
        if u != actor.id || n != input.name.trim() || url != input.url {
            return Err(Error::conflict());
        }
        tx.commit().await?;
        return Ok(());
    }
    sqlx::query("INSERT INTO sticker_shelf(id,user_id,name,url) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,url) DO UPDATE SET name=EXCLUDED.name").bind(&input.operation_id).bind(&actor.id).bind(input.name.trim()).bind(input.url).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn remove_sticker(app: &App, actor: &Account, id: &str) -> Result<()> {
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    sqlx::query("DELETE FROM sticker_shelf WHERE id=$1 AND user_id=$2")
        .bind(id)
        .bind(&actor.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
pub async fn image(app: &App, actor: &Account, room: &str, input: SendImage) -> Result<Message> {
    if !public_image(&input.url) || !line(&input.title, 200) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    plain_room(&mut tx, actor, room).await?;
    let fingerprint = auth::hash_token(
        &serde_json::json!(["social_image", room, input.url, input.title, input.reply_to])
            .to_string(),
    );
    let m = store::send_in_tx(
        &mut tx,
        actor,
        room,
        SendMessage {
            operation_id: input.operation_id,
            text: input.url.clone(),
            reply_to: input.reply_to,
            also_in_room: false,
            quotes: vec![],
            files: vec![],
            cards: vec![],
        },
        &[],
        Some(&fingerprint),
    )
    .await?;
    if m.social.is_some() {
        tx.commit().await?;
        return Ok(m);
    }
    let source = Some(input.url.clone());
    let powered_by = url::Url::parse(&input.url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h == "media.giphy.com" || h.ends_with(".giphy.com"))
        })
        .unwrap_or(false)
        .then(|| "GIPHY".into());
    let m = publish(
        &mut tx,
        &m.id,
        SocialCard::Image {
            title: input.title,
            url: input.url,
            width: 0,
            height: 0,
            source,
            powered_by,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(m)
}
pub async fn react_voice(app: &App, actor: &Account, room: &str, input: ReactVoice) -> Result<()> {
    if !auth::identifier(&input.operation_id)
        || !matches!(
            input.emoji.as_str(),
            "👏" | "😂" | "❤️" | "🎉" | "👍" | "👋"
        )
    {
        return Err(Error::invalid());
    }
    if app.livekit.is_none() {
        return Err(crate::voice::unavailable());
    }
    let mut tx = app.pool.begin().await?;
    plain_room(&mut tx, actor, room).await?;
    let connected:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM voice_sessions WHERE room_id=$1 AND user_id=$2 AND state='connected' AND data_epoch=(SELECT data_epoch FROM instance WHERE singleton) AND expires_at>clock_timestamp())").bind(room).bind(&actor.id).fetch_one(&mut *tx).await?;
    if !connected {
        return Err(Error::forbidden());
    }
    let encrypted: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e2ee_groups WHERE room_id=$1)")
            .bind(room)
            .fetch_one(&mut *tx)
            .await?;
    if encrypted {
        return Err(Error::new(StatusCode::CONFLICT, "crypto_required"));
    }
    let existing: Option<(String, String, String)> =
        sqlx::query_as("SELECT room_id,user_id,emoji FROM voice_reactions WHERE id=$1")
            .bind(&input.operation_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((r, u, e)) = existing {
        if r != room || u != actor.id || e != input.emoji {
            return Err(Error::conflict());
        }
        tx.commit().await?;
        return Ok(());
    }
    let recent:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM voice_reactions WHERE user_id=$1 AND expires_at>clock_timestamp()+interval '4 seconds')").bind(&actor.id).fetch_one(&mut *tx).await?;
    if recent {
        return Err(Error::new(
            StatusCode::TOO_MANY_REQUESTS,
            "voice_reaction_rate",
        ));
    }
    sqlx::query(
        "DELETE FROM voice_reactions WHERE expires_at<clock_timestamp()-interval '1 minute'",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO voice_reactions(id,room_id,user_id,emoji) VALUES($1,$2,$3,$4)")
        .bind(input.operation_id)
        .bind(room)
        .bind(&actor.id)
        .bind(input.emoji)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_options_refused() {
        let p = CreateSocial::Poll {
            operation_id: "x".into(),
            question: "Game?".into(),
            options: vec!["Foo".into(), " foo ".into()],
            multiple: false,
            closes_at: None,
            reply_to: None,
        };
        assert!(definition(&p, Utc::now()).is_err());
    }
    #[test]
    fn past_event_refused() {
        let p = CreateSocial::GameNight {
            operation_id: "x".into(),
            title: "Play".into(),
            starts_at: "2020-01-01T00:00:00Z".into(),
            description: String::new(),
            reply_to: None,
        };
        assert!(definition(&p, Utc::now()).is_err());
    }
}
