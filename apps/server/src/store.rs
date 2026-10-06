use chrono::{DateTime, Utc};
use rv_protocol::{Change, CreateRoom, Message, MessagePage, Room, RoomKind, SendMessage, User};
use sqlx::{FromRow, Postgres, Transaction, types::Json};

use crate::{
    App,
    auth::{Account, identifier, lock_active, random_token},
    error::{Error, Result},
};

#[derive(FromRow, Clone)]
pub(crate) struct RoomRow {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub revision: i64,
    pub encrypted: bool,
    pub voice: bool,
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
            read_state: None,
            encrypted: self.encrypted,
            voice: self.voice,
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
    pub reply_to: Option<String>,
    pub thread_replies: i64,
    pub thread_last_reply: Option<DateTime<Utc>>,
    pub system: Option<Json<rv_protocol::system::SystemMessage>>,
    pub created_at: DateTime<Utc>,
    pub position: i64,
    pub revision: i64,
    pub deleted: bool,
    pub edited_at: Option<DateTime<Utc>>,
    pub reactions: Json<Vec<rv_protocol::MessageReaction>>,
    pub pinned: bool,
    pub quote_references: Json<Vec<rv_protocol::parity::QuoteReference>>,
    pub files: Json<Vec<rv_protocol::parity::FileDescriptor>>,
    pub previews: Json<Vec<rv_protocol::link_previews::LinkPreview>>,
    pub cards: Json<Vec<rv_protocol::cards::IntegrationCard>>,
    pub call: Option<Json<rv_protocol::voice::CallSummary>>,
}

impl MessageRow {
    pub fn wire(self) -> Message {
        let body = (!self.deleted && self.system.is_none())
            .then(|| Box::new(rv_protocol::markdown::parse(&self.text)));
        Message {
            id: self.id,
            room_id: self.room_id,
            author: Box::new(User {
                id: self.author_id,
                username: self.username,
                display_name: self.display_name,
            }),
            text: self.text,
            reply_to: self.reply_to,
            thread: (self.thread_replies > 0).then(|| {
                Box::new(rv_protocol::ThreadSummary {
                    replies: self.thread_replies.to_string(),
                    last_reply_at: self.thread_last_reply.map(|t| t.to_rfc3339()),
                })
            }),
            system: self.system.map(|system| Box::new(system.0)),
            body,
            quotes: if self.deleted {
                Vec::new()
            } else {
                self.quote_references
                    .0
                    .into_iter()
                    .map(|reference| rv_protocol::MessageQuote {
                        reference,
                        excerpt: None,
                        view_position: "0".into(),
                        source_membership_version: None,
                    })
                    .collect()
            },
            created_at: self.created_at.to_rfc3339(),
            position: self.position.to_string(),
            revision: self.revision.to_string(),
            deleted: self.deleted,
            edited_at: self.edited_at.map(|time| time.to_rfc3339()),
            reactions: self.reactions.0,
            pinned: self.pinned,
            personal_star: None,
            personal_mention: None,
            call: self.call.map(|call| Box::new(call.0)),
            cards: if self.deleted {
                Vec::new()
            } else {
                self.cards.0
            },
            previews: if self.deleted {
                Vec::new()
            } else {
                self.previews.0
            },
            files: if self.deleted {
                Vec::new()
            } else {
                self.files.0
            },
        }
    }
}

pub(crate) const MESSAGE_SELECT: &str = "SELECT m.id,m.room_id,m.author_id,u.username,u.display_name,m.text,m.reply_to,(SELECT count(*) FROM messages r WHERE r.reply_to=m.id AND NOT r.deleted) AS thread_replies,(SELECT max(r.created_at) FROM messages r WHERE r.reply_to=m.id AND NOT r.deleted) AS thread_last_reply,m.system,m.created_at,m.position,m.revision,m.deleted,m.edited_at,m.pinned,m.quote_references,m.files,m.previews,m.cards,(SELECT jsonb_strip_nulls(jsonb_build_object('state',v.state,'duration_seconds',CASE WHEN v.answered_at IS NOT NULL AND v.ended_at IS NOT NULL THEN floor(extract(epoch FROM v.ended_at-v.answered_at))::int END)) FROM voice_rings v WHERE v.message_id=m.id) AS call,COALESCE((SELECT jsonb_agg(jsonb_build_object('emoji',g.emoji,'users',g.users) ORDER BY g.emoji) FROM (SELECT e.emoji,jsonb_agg(jsonb_build_object('id',a.id,'username',a.username,'display_name',a.display_name) ORDER BY a.id) AS users FROM message_reactions e JOIN users a ON a.id=e.user_id WHERE e.message_id=m.id GROUP BY e.emoji) g),'[]'::jsonb) AS reactions FROM messages m JOIN users u ON u.id=m.author_id";

pub(crate) fn send_fingerprint(room: &str, text: &str) -> String {
    crate::auth::hash_token(&serde_json::json!([room, text]).to_string())
}

pub(crate) fn quoted_send_fingerprint(
    room: &str,
    text: &str,
    quotes: &[rv_protocol::parity::QuoteReference],
) -> String {
    if quotes.is_empty() {
        send_fingerprint(room, text)
    } else {
        crate::auth::hash_token(&serde_json::json!([room, text, quotes]).to_string())
    }
}

/// Must be called after acquiring domain locks. The counter lock lasts until commit.
pub(crate) async fn next_position(tx: &mut Transaction<'_, Postgres>) -> Result<i64> {
    // Publishers already hold their actor/session locks. Their counter wait
    // must end well before a logout waiting on those locks reaches its six-
    // second deadline; equal deadlines race under scheduler/database load.
    let previous: String = sqlx::query_scalar("SELECT current_setting('lock_timeout')")
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query("SET LOCAL lock_timeout='3s'")
        .execute(&mut **tx)
        .await?;
    let position = sqlx::query_scalar(
        "UPDATE instance SET position=position+1 WHERE singleton RETURNING position",
    )
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query("SELECT set_config('lock_timeout',$1,true)")
        .bind(previous)
        .execute(&mut **tx)
        .await?;
    Ok(position)
}

pub(crate) async fn event(
    tx: &mut Transaction<'_, Postgres>,
    position: i64,
    room: &str,
    recipient: Option<&str>,
    change: Change,
) -> Result<()> {
    if matches!(&change, Change::RoomUpsert(_)) {
        crate::room_reads::initialize_revision(tx, room, position).await?;
    }
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
    if name.is_empty()
        || name.len() > 128
        || input
            .operation_id
            .as_deref()
            .is_some_and(|id| !identifier(id))
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, account).await?;
    if let Some(operation) = &input.operation_id {
        let previous: Option<(String,bool,bool,String)> = sqlx::query_as("SELECT name,private,voice,room_id FROM room_creation_requests WHERE user_id=$1 AND operation_id=$2")
            .bind(&account.id).bind(operation).fetch_optional(&mut *tx).await?;
        if let Some((previous_name, private, voice, room_id)) = previous {
            if previous_name != name || private != input.private || voice != input.voice {
                return Err(Error::conflict());
            }
            require_member(&mut tx, &room_id, &account.id).await?;
            let room =
                sqlx::query_as::<_, RoomRow>("SELECT id,name,kind,revision,EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=rooms.id) AS encrypted,rooms.voice FROM rooms WHERE id=$1")
                    .bind(room_id)
                    .fetch_one(&mut *tx)
                    .await?
                    .wire();
            tx.commit().await?;
            return Ok(room);
        }
        let used: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM message_actions WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_commands WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM e2ee_application_messages WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM e2ee_message_cancellations WHERE user_id=$1 AND operation_id=$2)",
        )
        .bind(&account.id)
        .bind(operation)
        .fetch_one(&mut *tx)
        .await?;
        if used {
            return Err(Error::conflict());
        }
    }
    let allowed: bool = sqlx::query_scalar("SELECT CASE WHEN $2 THEN create_private_room ELSE create_public_room END FROM users WHERE id=$1")
        .bind(&account.id).bind(input.private).fetch_one(&mut *tx).await?;
    if !allowed {
        return Err(Error::forbidden());
    }
    if input.voice && app.livekit.is_none() {
        return Err(crate::voice::unavailable());
    }
    let id = random_token()[..24].to_owned();
    let kind = if input.private { "private" } else { "public" };
    sqlx::query("INSERT INTO rooms(id,name,kind,voice) VALUES($1,$2,$3,$4)")
        .bind(&id)
        .bind(name)
        .bind(kind)
        .bind(input.voice)
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
        encrypted: false,
        voice: input.voice,
    }
    .wire();
    if let Some(operation) = input.operation_id {
        sqlx::query("INSERT INTO room_creation_requests(user_id,operation_id,name,private,voice,room_id) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(&account.id).bind(operation).bind(name).bind(input.private).bind(input.voice).bind(&room.id).execute(&mut *tx).await?;
    }
    event(
        &mut tx,
        position,
        &room.id,
        None,
        Change::RoomUpsert(room.clone()),
    )
    .await?;
    crate::system_messages::publish(
        &mut tx,
        account,
        &room.id,
        rv_protocol::system::SystemMessage::RoomCreated {
            name: room.name.clone(),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(room)
}

pub async fn public_rooms(
    app: &App,
    account: &Account,
    query: &str,
    after: Option<&str>,
) -> Result<rv_protocol::PublicRoomPage> {
    if query.len() > 128 || after.is_some_and(|id| !identifier(id)) {
        return Err(Error::invalid());
    }
    // Literal substring search: user '%'/'_' characters are not SQL wildcards.
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String,String,String,i64,bool,bool,bool)> = sqlx::query_as("SELECT r.id,r.name,r.kind,r.revision,EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=r.id) AS encrypted,r.voice,EXISTS(SELECT 1 FROM members m WHERE m.room_id=r.id AND m.user_id=$1) FROM rooms r WHERE r.kind='public' AND strpos(lower(r.name),lower($2))>0 AND r.id>$3 ORDER BY r.id LIMIT 21")
        .bind(&account.id).bind(query.trim()).bind(after.unwrap_or("")).fetch_all(&app.pool).await?;
    let more = rows.len() > 20;
    let rooms: Vec<_> = rows
        .into_iter()
        .take(20)
        .map(
            |(id, name, kind, revision, encrypted, voice, joined)| rv_protocol::PublicRoom {
                room: RoomRow {
                    id,
                    name,
                    kind,
                    revision,
                    encrypted,
                    voice,
                }
                .wire(),
                joined,
            },
        )
        .collect();
    let next = if more {
        rooms.last().map(|r| r.room.id.clone())
    } else {
        None
    };
    Ok(rv_protocol::PublicRoomPage { rooms, next })
}

pub async fn join_public(app: &App, account: &Account, room_id: &str) -> Result<Room> {
    if !identifier(room_id) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, account).await?;
    let mut room = sqlx::query_as::<_, RoomRow>(
        "SELECT id,name,kind,revision,EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=rooms.id) AS encrypted,rooms.voice FROM rooms WHERE id=$1 AND kind='public' FOR UPDATE",
    )
    .bind(room_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(Error::missing)?
    .wire();
    let inserted = sqlx::query(
        "INSERT INTO members(room_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",
    )
    .bind(room_id)
    .bind(&account.id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted > 0 {
        sqlx::query("DELETE FROM snapshot_heads WHERE user_id IN (SELECT user_id FROM members WHERE room_id=$1) OR $1=ANY(room_ids)")
            .bind(room_id).execute(&mut *tx).await?;
        room = crate::room_details::publish(&mut tx, room_id).await?;
        crate::system_messages::publish(
            &mut tx,
            account,
            room_id,
            rv_protocol::system::SystemMessage::MemberJoined {},
        )
        .await?;
    }
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
    crate::auth::mutation_deadlines(&mut tx).await?;
    // Serialize concurrent creation in both directions, with a consistent lock order.
    // Keep foreign-key KEY SHARE checks compatible with these domain locks.
    let found: Vec<(String, String)> = sqlx::query_as(
        "SELECT id,username FROM users WHERE id=ANY($1) AND NOT disabled ORDER BY id FOR NO KEY UPDATE",
    )
    .bind(users.to_vec())
    .fetch_all(&mut *tx)
    .await?;
    if !found.iter().any(|(id, _)| id == &account.id) {
        return Err(Error::unauthorized());
    }
    lock_active(&mut tx, account).await?;
    if found.len() != 2 {
        return Err(Error::missing());
    }
    let name = format!("{} / {}", found[0].1, found[1].1);
    let pair = format!("{}:{}", users[0], users[1]);
    if let Some(room) =
        sqlx::query_as::<_, RoomRow>("SELECT id,name,kind,revision,EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=rooms.id) AS encrypted,rooms.voice FROM rooms WHERE direct_pair=$1")
            .bind(&pair)
            .fetch_optional(&mut *tx)
            .await?
    {
        tx.commit().await?;
        return Ok(room.wire());
    }
    let id = random_token()[..24].to_owned();
    sqlx::query("INSERT INTO rooms(id,name,kind,direct_pair) VALUES($1,$3,'direct',$2)")
        .bind(&id)
        .bind(pair)
        .bind(&name)
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
        name,
        kind: "direct".into(),
        revision: position,
        encrypted: false,
        voice: false,
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
    lock_active(&mut tx, account).await?;
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
        sqlx::query("DELETE FROM snapshot_heads WHERE user_id IN (SELECT user_id FROM members WHERE room_id=$1) OR user_id=$2 OR $1=ANY(room_ids)")
            .bind(room_id).bind(target).execute(&mut *tx).await?;
        if remove {
            // Never deliver another immutable page containing a withdrawn room.
            // This also prevents remove/re-add from reviving an old snapshot.
            sqlx::query("DELETE FROM snapshot_heads WHERE user_id=$1")
                .bind(target)
                .execute(&mut *tx)
                .await?;
        }
        if remove {
            let position = next_position(&mut tx).await?;
            event(
                &mut tx,
                position,
                room_id,
                Some(target),
                Change::RoomRemoved {
                    room_id: room_id.into(),
                },
            )
            .await?;
        }
        crate::room_details::publish(&mut tx, room_id).await?;
        let user = crate::system_messages::user(&mut tx, target).await?;
        let activity = if remove {
            rv_protocol::system::SystemMessage::MemberRemoved { user }
        } else {
            rv_protocol::system::SystemMessage::MemberAdded { user }
        };
        crate::system_messages::publish(&mut tx, account, room_id, activity).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn rooms(app: &App, account: &Account) -> Result<Vec<Room>> {
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let mut rooms:Vec<_>=sqlx::query_as::<_, RoomRow>("SELECT r.id,r.name,r.kind,r.revision,EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=r.id) AS encrypted,r.voice FROM rooms r JOIN members m ON m.room_id=r.id WHERE m.user_id=$1 ORDER BY r.revision DESC,r.id")
        .bind(&account.id).fetch_all(&mut *tx).await?.into_iter().map(RoomRow::wire).collect();
    for room in &mut rooms {
        crate::room_reads::personalize(&mut tx, &account.id, room).await?;
    }
    tx.commit().await?;
    Ok(rooms)
}

pub async fn send(
    app: &App,
    account: &Account,
    room_id: &str,
    input: SendMessage,
) -> Result<Message> {
    let mut tx = app.pool.begin().await?;
    let message = send_in_tx(&mut tx, account, room_id, input, &[], None).await?;
    tx.commit().await?;
    Ok(message)
}
pub(crate) async fn send_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    account: &Account,
    room_id: &str,
    input: SendMessage,
    files: &[rv_protocol::parity::FileDescriptor],
    fingerprint: Option<&str>,
) -> Result<Message> {
    if !identifier(&input.operation_id)
        || input
            .reply_to
            .as_ref()
            .is_some_and(|root| !identifier(root) || root == &input.operation_id)
        || (input.text.trim().is_empty()
            && input.quotes.is_empty()
            && files.is_empty()
            && input.cards.is_empty())
        || input.text.len() > 32_768
        // Encrypted file descriptors belong to private documents only.
        || !input.files.is_empty()
        || !crate::quotes::valid_references(&input.quotes, &input.operation_id)
        || !rv_protocol::cards::validate(&input.cards)
    {
        return Err(Error::invalid());
    }
    let expected_fingerprint = fingerprint.map(str::to_owned).unwrap_or_else(|| {
        let original = crate::threads::send_fingerprint(
            room_id,
            &input.text,
            &input.quotes,
            input.reply_to.as_deref(),
        );
        if input.cards.is_empty() {
            original
        } else {
            crate::auth::hash_token(&serde_json::json!([original, input.cards]).to_string())
        }
    });
    // All sends by a user serialize before room / journal locks. This also protects
    // operation IDs across rooms, including malicious cross-room replays.
    lock_active(tx, account).await?;
    crate::quotes::lock_rooms(tx, room_id, &input.quotes).await?;
    require_member(tx, room_id, &account.id).await?;
    let used: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM room_creation_requests WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM message_actions WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_commands WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM uploads WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM e2ee_application_messages WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM e2ee_message_cancellations WHERE user_id=$1 AND operation_id=$2)",
    )
    .bind(&account.id)
    .bind(&input.operation_id)
    .fetch_one(&mut **tx)
    .await?;
    if used {
        return Err(Error::conflict());
    }
    let query = format!("{MESSAGE_SELECT} WHERE m.author_id=$1 AND m.operation_id=$2");
    if let Some(existing) = sqlx::query_as::<_, MessageRow>(&query)
        .bind(&account.id)
        .bind(&input.operation_id)
        .fetch_optional(&mut **tx)
        .await?
    {
        let fingerprint: Option<String> =
            sqlx::query_scalar("SELECT send_fingerprint FROM messages WHERE id=$1")
                .bind(&existing.id)
                .fetch_one(&mut **tx)
                .await?;
        let matches = fingerprint.map_or_else(
            || {
                existing.text == input.text
                    && existing.quote_references.0 == input.quotes
                    && existing.reply_to == input.reply_to
                    && existing.files.0 == files
                    && existing.cards.0 == input.cards
            },
            |value| value == expected_fingerprint,
        );
        if existing.room_id != room_id || !matches {
            return Err(Error::conflict());
        }
        return Ok(existing.wire());
    }
    crate::permissions::require_send(tx, room_id, &account.id).await?;
    crate::e2ee::groups::require_plaintext(tx, room_id).await?;
    if let Some(root) = &input.reply_to {
        crate::threads::validate_root(tx, room_id, root).await?;
    }
    crate::quotes::validate(tx, account, &input.quotes, &[]).await?;
    let id = input.operation_id;
    // Client message IDs are globally unique. A collision belonging to another user
    // is a conflict, never a response exposing that user's message.
    let result = sqlx::query(
        "INSERT INTO messages(id,room_id,author_id,operation_id,text,send_fingerprint,quote_references,reply_to,files,cards) VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8,$9)",
    )
    .bind(&id)
    .bind(room_id)
    .bind(&account.id)
    .bind(&input.text)
    .bind(expected_fingerprint)
    .bind(Json(&input.quotes))
    .bind(&input.reply_to)
    .bind(Json(files))
    .bind(Json(&input.cards))
    .execute(&mut **tx)
    .await;
    match result {
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => return Err(Error::conflict()),
        Err(e) => return Err(e.into()),
        Ok(_) => (),
    }
    crate::mentions::capture(tx, &id, room_id, &account.id, &input.text).await?;
    let position = next_position(tx).await?;
    sqlx::query("UPDATE messages SET position=$2,revision=$2 WHERE id=$1")
        .bind(&id)
        .bind(position)
        .execute(&mut **tx)
        .await?;
    crate::link_previews::enqueue(tx, &id, &input.text).await?;
    crate::push::enqueue(tx, &id).await?;
    let query = format!("{MESSAGE_SELECT} WHERE m.id=$1");
    let message = sqlx::query_as::<_, MessageRow>(&query)
        .bind(&id)
        .fetch_one(&mut **tx)
        .await?
        .wire();
    event(
        tx,
        position,
        room_id,
        None,
        Change::MessageUpsert(message.clone()),
    )
    .await?;
    if let Some(root) = &input.reply_to {
        crate::threads::refresh(tx, room_id, root).await?;
    }
    crate::room_reads::message_changed(tx, room_id).await?;
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
        "{MESSAGE_SELECT} WHERE m.room_id=$1 AND m.reply_to IS NULL AND m.position<$2 ORDER BY m.position DESC LIMIT $3"
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
    crate::marks::personalize(&mut tx, &account.id, &mut messages).await?;
    crate::quotes::personalize(&mut tx, &account.id, &mut messages).await?;
    tx.commit().await?;
    Ok(MessagePage { messages, has_more })
}
