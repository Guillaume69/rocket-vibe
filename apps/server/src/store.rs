use chrono::{DateTime, Utc};
use rv_protocol::{Change, CreateRoom, Message, MessagePage, Room, RoomKind, SendMessage, User};
use sqlx::{FromRow, Postgres, Transaction, types::Json};

use crate::{
    App,
    auth::{Account, identifier, random_token},
    error::{Error, Result},
};

#[derive(FromRow)]
pub(crate) struct RoomRow {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub revision: i64,
}

impl RoomRow {
    pub fn wire(self) -> Room {
        Room {
            id: self.id,
            name: self.name,
            kind: match self.kind.as_str() {
                "private" => RoomKind::Private,
                "direct" => RoomKind::Direct,
                _ => RoomKind::Public,
            },
            revision: self.revision.to_string(),
        }
    }
}

#[derive(FromRow)]
pub(crate) struct MessageRow {
    pub id: String,
    pub room_id: String,
    pub author_id: String,
    pub username: String,
    pub display_name: String,
    pub text: String,
    pub created_at: DateTime<Utc>,
    pub position: i64,
    pub revision: i64,
}

impl MessageRow {
    pub fn wire(self) -> Message {
        Message {
            id: self.id,
            room_id: self.room_id,
            author: User {
                id: self.author_id,
                username: self.username,
                display_name: self.display_name,
            },
            text: self.text,
            created_at: self.created_at.to_rfc3339(),
            position: self.position.to_string(),
            revision: self.revision.to_string(),
        }
    }
}

pub(crate) const MESSAGE_SELECT: &str = "SELECT m.id,m.room_id,m.author_id,u.username,u.display_name,m.text,m.created_at,m.position,m.revision FROM messages m JOIN users u ON u.id=m.author_id";

/// Must be called after acquiring domain locks. The counter lock lasts until commit.
pub(crate) async fn next_position(tx: &mut Transaction<'_, Postgres>) -> Result<i64> {
    Ok(sqlx::query_scalar(
        "UPDATE instance SET position=position+1 WHERE singleton RETURNING position",
    )
    .fetch_one(&mut **tx)
    .await?)
}

pub(crate) async fn event(
    tx: &mut Transaction<'_, Postgres>,
    position: i64,
    room: &str,
    recipient: Option<&str>,
    change: Change,
) -> Result<()> {
    sqlx::query("INSERT INTO journal(position,room_id,recipient_id,change) VALUES($1,$2,$3,$4)")
        .bind(position)
        .bind(room)
        .bind(recipient)
        .bind(Json(change))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(crate) async fn require_member(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    user: &str,
) -> Result<String> {
    // Membership changes acquire an exclusive room lock. Writes hold this share
    // lock through commit, preventing a send from racing a removal.
    sqlx::query_scalar("SELECT m.role FROM members m JOIN rooms r ON r.id=m.room_id WHERE m.room_id=$1 AND m.user_id=$2 FOR SHARE OF r")
        .bind(room).bind(user).fetch_optional(&mut **tx).await?.ok_or_else(Error::missing)
}

pub async fn create_room(app: &App, account: &Account, input: CreateRoom) -> Result<Room> {
    let name = input.name.trim();
    if name.is_empty() || name.len() > 128 {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let id = random_token()[..24].to_owned();
    let kind = if input.private { "private" } else { "public" };
    sqlx::query("INSERT INTO rooms(id,name,kind) VALUES($1,$2,$3)")
        .bind(&id)
        .bind(name)
        .bind(kind)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO members(room_id,user_id,role) VALUES($1,$2,'owner')")
        .bind(&id)
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    let position = next_position(&mut tx).await?;
    sqlx::query("UPDATE rooms SET revision=$2 WHERE id=$1")
        .bind(&id)
        .bind(position)
        .execute(&mut *tx)
        .await?;
    let room = RoomRow {
        id,
        name: name.into(),
        kind: kind.into(),
        revision: position,
    }
    .wire();
    event(
        &mut tx,
        position,
        &room.id,
        None,
        Change::RoomUpsert(room.clone()),
    )
    .await?;
    tx.commit().await?;
    Ok(room)
}

pub async fn direct(app: &App, account: &Account, target: &str) -> Result<Room> {
    if !identifier(target) || target == account.id {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let mut users = [account.id.as_str(), target];
    users.sort_unstable();
    // Serialize concurrent creation in both directions, with a consistent lock order.
    let found: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM users WHERE id=ANY($1) AND NOT disabled ORDER BY id FOR UPDATE",
    )
    .bind(users.to_vec())
    .fetch_all(&mut *tx)
    .await?;
    if found.len() != 2 {
        return Err(Error::missing());
    }
    let pair = format!("{}:{}", users[0], users[1]);
    if let Some(room) =
        sqlx::query_as::<_, RoomRow>("SELECT id,name,kind,revision FROM rooms WHERE direct_pair=$1")
            .bind(&pair)
            .fetch_optional(&mut *tx)
            .await?
    {
        tx.commit().await?;
        return Ok(room.wire());
    }
    let id = random_token()[..24].to_owned();
    sqlx::query(
        "INSERT INTO rooms(id,name,kind,direct_pair) VALUES($1,'Direct message','direct',$2)",
    )
    .bind(&id)
    .bind(pair)
    .execute(&mut *tx)
    .await?;
    for user in users {
        sqlx::query("INSERT INTO members(room_id,user_id,role) VALUES($1,$2,'member')")
            .bind(&id)
            .bind(user)
            .execute(&mut *tx)
            .await?;
    }
    let position = next_position(&mut tx).await?;
    sqlx::query("UPDATE rooms SET revision=$2 WHERE id=$1")
        .bind(&id)
        .bind(position)
        .execute(&mut *tx)
        .await?;
    let room = RoomRow {
        id,
        name: "Direct message".into(),
        kind: "direct".into(),
        revision: position,
    }
    .wire();
    event(
        &mut tx,
        position,
        &room.id,
        None,
        Change::RoomUpsert(room.clone()),
    )
    .await?;
    tx.commit().await?;
    Ok(room)
}

pub async fn membership(
    app: &App,
    account: &Account,
    room_id: &str,
    target: &str,
    remove: bool,
) -> Result<()> {
    if !identifier(target) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let kind: Option<String> = sqlx::query_scalar("SELECT kind FROM rooms WHERE id=$1 FOR UPDATE")
        .bind(room_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(kind) = kind else {
        return Err(Error::missing());
    };
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM members WHERE room_id=$1 AND user_id=$2")
            .bind(room_id)
            .bind(&account.id)
            .fetch_optional(&mut *tx)
            .await?;
    // No admin bypass into private/direct conversations. This preserves their boundaries.
    if kind == "direct" || role.as_deref() != Some("owner") {
        return Err(Error::forbidden());
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND NOT disabled)")
            .bind(target)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::missing());
    }
    let rows = if remove {
        if target == account.id {
            return Err(Error::invalid());
        }
        sqlx::query("DELETE FROM members WHERE room_id=$1 AND user_id=$2")
            .bind(room_id)
            .bind(target)
            .execute(&mut *tx)
            .await?
            .rows_affected()
    } else {
        sqlx::query("INSERT INTO members(room_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING")
            .bind(room_id).bind(target).execute(&mut *tx).await?.rows_affected()
    };
    if rows > 0 {
        let position = next_position(&mut tx).await?;
        let change = if remove {
            Change::RoomRemoved {
                room_id: room_id.into(),
            }
        } else {
            let room =
                sqlx::query_as::<_, RoomRow>("SELECT id,name,kind,revision FROM rooms WHERE id=$1")
                    .bind(room_id)
                    .fetch_one(&mut *tx)
                    .await?;
            Change::RoomUpsert(room.wire())
        };
        event(&mut tx, position, room_id, Some(target), change).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn rooms(app: &App, account: &Account) -> Result<Vec<Room>> {
    Ok(sqlx::query_as::<_, RoomRow>("SELECT r.id,r.name,r.kind,r.revision FROM rooms r JOIN members m ON m.room_id=r.id WHERE m.user_id=$1 ORDER BY r.revision DESC,r.id")
        .bind(&account.id).fetch_all(&app.pool).await?.into_iter().map(RoomRow::wire).collect())
}

pub async fn send(
    app: &App,
    account: &Account,
    room_id: &str,
    input: SendMessage,
) -> Result<Message> {
    if !identifier(&input.operation_id) || input.text.trim().is_empty() || input.text.len() > 32_768
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    // All sends by a user serialize before room / journal locks. This also protects
    // operation IDs across rooms, including malicious cross-room replays.
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    require_member(&mut tx, room_id, &account.id).await?;
    let query = format!("{MESSAGE_SELECT} WHERE m.author_id=$1 AND m.operation_id=$2");
    if let Some(existing) = sqlx::query_as::<_, MessageRow>(&query)
        .bind(&account.id)
        .bind(&input.operation_id)
        .fetch_optional(&mut *tx)
        .await?
    {
        if existing.room_id != room_id || existing.text != input.text {
            return Err(Error::conflict());
        }
        tx.commit().await?;
        return Ok(existing.wire());
    }
    let id = input.operation_id;
    // Client message IDs are globally unique. A collision belonging to another user
    // is a conflict, never a response exposing that user's message.
    let result = sqlx::query(
        "INSERT INTO messages(id,room_id,author_id,operation_id,text) VALUES($1,$2,$3,$1,$4)",
    )
    .bind(&id)
    .bind(room_id)
    .bind(&account.id)
    .bind(&input.text)
    .execute(&mut *tx)
    .await;
    match result {
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => return Err(Error::conflict()),
        Err(e) => return Err(e.into()),
        Ok(_) => (),
    }
    let position = next_position(&mut tx).await?;
    sqlx::query("UPDATE messages SET position=$2,revision=$2 WHERE id=$1")
        .bind(&id)
        .bind(position)
        .execute(&mut *tx)
        .await?;
    let query = format!("{MESSAGE_SELECT} WHERE m.id=$1");
    let message = sqlx::query_as::<_, MessageRow>(&query)
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?
        .wire();
    event(
        &mut tx,
        position,
        room_id,
        None,
        Change::MessageUpsert(message.clone()),
    )
    .await?;
    tx.commit().await?;
    Ok(message)
}

pub async fn history(
    app: &App,
    account: &Account,
    room_id: &str,
    before: Option<i64>,
    limit: i64,
) -> Result<MessagePage> {
    let mut tx = app.pool.begin().await?;
    require_member(&mut tx, room_id, &account.id).await?;
    let query = format!(
        "{MESSAGE_SELECT} WHERE m.room_id=$1 AND m.position<$2 ORDER BY m.position DESC LIMIT $3"
    );
    let mut messages: Vec<Message> = sqlx::query_as::<_, MessageRow>(&query)
        .bind(room_id)
        .bind(before.unwrap_or(i64::MAX))
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(MessageRow::wire)
        .collect();
    let has_more = messages.len() > limit as usize;
    messages.truncate(limit as usize);
    tx.commit().await?;
    Ok(MessagePage { messages, has_more })
}
