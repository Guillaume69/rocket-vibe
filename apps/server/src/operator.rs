//! Trusted database operator, never an HTTP admin bypass into private rooms.
use crate::{
    App, auth,
    error::{Error, Result},
    room_details, store,
};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rv_protocol::Change;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, Postgres, Transaction, types::Json};

#[derive(Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next: Option<String>,
}
#[derive(Clone, Debug, Serialize, FromRow)]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub admin: bool,
    pub disabled: bool,
    /// A tombstone: never reactivated, by the CLI or in the app.
    pub deleted: bool,
    pub create_public_room: bool,
    pub create_private_room: bool,
    pub revision: String,
}
#[derive(Clone, Debug, Serialize, FromRow)]
pub struct Room {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub read_only: bool,
    pub voice: bool,
    pub topic: String,
    pub description: String,
    pub announcement: String,
    pub revision: String,
    pub journal_position: String,
    pub member_count: i64,
}
#[derive(Serialize, FromRow)]
pub struct Member {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub disabled: bool,
}
#[derive(Serialize, FromRow)]
pub struct AuditEntry {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub database_role: String,
    /// The in-app administrator or reporter; absent for the operator CLI.
    pub actor_id: Option<String>,
    pub data_epoch: String,
    pub action: String,
    pub operation_id: Option<String>,
    pub subject: String,
    pub details: Json<Value>,
}
const USERS: &str = "SELECT id,username,display_name,admin,disabled,deleted,create_public_room,create_private_room,activation_version AS revision FROM users";
const ROOMS: &str = "SELECT r.id,r.name,r.kind,r.read_only,r.voice,r.topic,r.description,r.announcement,r.details_version AS revision,r.revision::text AS journal_position,(SELECT count(*) FROM members m WHERE m.room_id=r.id) AS member_count FROM rooms r";
fn limit(value: u32) -> Result<i64> {
    if !(1..=100).contains(&value) {
        return Err(Error::invalid());
    }
    Ok(i64::from(value))
}
fn page<T>(mut items: Vec<T>, count: usize, key: impl Fn(&T) -> String) -> Page<T> {
    let more = items.len() > count;
    items.truncate(count);
    Page {
        next: if more { items.last().map(key) } else { None },
        items,
    }
}
fn cursor(after: Option<&str>) -> Result<&str> {
    if after.is_some_and(|v| !auth::identifier(v)) {
        return Err(Error::invalid());
    }
    Ok(after.unwrap_or(""))
}
pub async fn users(app: &App, after: Option<&str>, count: u32) -> Result<Page<User>> {
    let count = limit(count)?;
    let rows = sqlx::query_as::<_, User>(&format!("{USERS} WHERE id>$1 ORDER BY id LIMIT $2"))
        .bind(cursor(after)?)
        .bind(count + 1)
        .fetch_all(&app.pool)
        .await?;
    Ok(page(rows, count as usize, |u| u.id.clone()))
}
pub async fn rooms(app: &App, after: Option<&str>, count: u32) -> Result<Page<Room>> {
    let count = limit(count)?;
    let rows = sqlx::query_as::<_, Room>(&format!("{ROOMS} WHERE r.id>$1 ORDER BY r.id LIMIT $2"))
        .bind(cursor(after)?)
        .bind(count + 1)
        .fetch_all(&app.pool)
        .await?;
    Ok(page(rows, count as usize, |r| r.id.clone()))
}
pub async fn members(
    app: &App,
    room: &str,
    after: Option<&str>,
    count: u32,
) -> Result<Page<Member>> {
    if !auth::identifier(room) {
        return Err(Error::invalid());
    }
    let count = limit(count)?;
    let rows=sqlx::query_as::<_,Member>("SELECT u.id AS user_id,u.username,u.display_name,m.role,u.disabled FROM members m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 AND u.id>$2 ORDER BY u.id LIMIT $3")
        .bind(room).bind(cursor(after)?).bind(count+1).fetch_all(&app.pool).await?;
    Ok(page(rows, count as usize, |m| m.user_id.clone()))
}
pub async fn audit(app: &App, after: Option<&str>, count: u32) -> Result<Page<AuditEntry>> {
    let count = limit(count)?;
    let after = after.unwrap_or("0");
    if after.is_empty() || !after.bytes().all(|c| c.is_ascii_digit()) {
        return Err(Error::invalid());
    }
    let after = after.parse::<i64>().map_err(|_| Error::invalid())?;
    let rows=sqlx::query_as::<_,AuditEntry>("SELECT id::text,created_at,database_role,actor_id,data_epoch,action,operation_id,subject,details FROM operator_audit WHERE id>$1 ORDER BY id LIMIT $2")
        .bind(after).bind(count+1).fetch_all(&app.pool).await?;
    Ok(page(rows, count as usize, |a| a.id.clone()))
}
pub(crate) async fn record(
    tx: &mut Transaction<'_, Postgres>,
    action: &str,
    subject: &str,
    details: Value,
) -> Result<()> {
    // An in-app command names its account; the CLI leaves the actor unset.
    sqlx::query("INSERT INTO operator_audit(data_epoch,action,operation_id,subject,details,actor_id) SELECT data_epoch,$1,NULLIF(current_setting('rocketvibe.operator_operation',true),''),$2,$3,NULLIF(current_setting('rocketvibe.operator_actor',true),'') FROM instance WHERE singleton")
        .bind(action).bind(subject).bind(Json(details)).execute(&mut **tx).await?;
    Ok(())
}
#[derive(Clone, Default, Serialize)]
pub struct UserChanges {
    pub disabled: Option<bool>,
    pub admin: Option<bool>,
    pub create_public_room: Option<bool>,
    pub create_private_room: Option<bool>,
}
#[derive(Clone, Default, Serialize)]
pub struct RoomChanges {
    pub name: Option<String>,
    pub private: Option<bool>,
    pub read_only: Option<bool>,
    pub topic: Option<String>,
    pub description: Option<String>,
    pub announcement: Option<String>,
    pub voice: Option<bool>,
}
#[derive(Clone, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Command {
    User {
        id: String,
        expected: Option<String>,
        changes: UserChanges,
    },
    CreateRoom {
        owner: String,
        name: String,
        private: bool,
        voice: bool,
    },
    Room {
        id: String,
        expected: String,
        changes: RoomChanges,
    },
    Member {
        room: String,
        user: String,
        expected: String,
        role: Option<String>,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt {
    pub operation_id: String,
    pub subject_id: String,
    pub applied_revision: String,
}
fn conflict() -> Error {
    Error::new(StatusCode::CONFLICT, "revision_conflict")
}
pub async fn apply(app: &App, operation: &str, command: Command) -> Result<Receipt> {
    if !auth::identifier(operation) {
        return Err(Error::invalid());
    }
    let hash = auth::hash_token(&serde_json::to_string(&command).map_err(|_| Error::invalid())?);
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    // KEY SHARE permits the ordinary journal counter, while fencing an epoch change.
    let epoch: String =
        sqlx::query_scalar("SELECT data_epoch FROM instance WHERE singleton FOR KEY SHARE")
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("rv-operator:{operation}"))
        .execute(&mut *tx)
        .await?;
    let previous: Option<(String, String, Json<Receipt>)> = sqlx::query_as(
        "SELECT data_epoch,command_hash,receipt FROM operator_commands WHERE operation_id=$1",
    )
    .bind(operation)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((old_epoch, old_hash, receipt)) = previous {
        if old_epoch != epoch || old_hash != hash {
            return Err(Error::conflict());
        }
        return Ok(receipt.0);
    }
    sqlx::query("SELECT set_config('rocketvibe.operator_operation',$1,true)")
        .bind(operation)
        .execute(&mut *tx)
        .await?;
    let (subject_id, applied_revision) = match command {
        Command::User {
            id,
            expected,
            changes,
        } => set_user(&mut tx, &id, expected.as_deref(), changes).await?,
        Command::CreateRoom {
            owner,
            name,
            private,
            voice,
        } => create_room(&mut tx, &owner, &name, private, voice).await?,
        Command::Room {
            id,
            expected,
            changes,
        } => set_room(&mut tx, &id, &expected, changes).await?,
        Command::Member {
            room,
            user,
            expected,
            role,
        } => set_member(&mut tx, &room, &user, &expected, role.as_deref()).await?,
    };
    let receipt = Receipt {
        operation_id: operation.into(),
        subject_id,
        applied_revision,
    };
    sqlx::query("INSERT INTO operator_commands(operation_id,data_epoch,command_hash,receipt) VALUES($1,$2,$3,$4)")
        .bind(operation).bind(epoch).bind(hash).bind(Json(&receipt)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(receipt)
}
/// Serializes account changes, CLI and in-app alike, so the last-administrator
/// check sees every concurrent demotion. Taken before any account row lock.
pub(crate) async fn administration_lock(tx: &mut Transaction<'_, Postgres>) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('rv-administration',0))")
        .execute(&mut **tx)
        .await?;
    Ok(())
}
pub(crate) async fn set_user(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    expected: Option<&str>,
    changes: UserChanges,
) -> Result<(String, String)> {
    if !auth::identifier(id) || expected.is_some_and(|e| !auth::identifier(e)) {
        return Err(Error::invalid());
    }
    administration_lock(tx).await?;
    let before: User = sqlx::query_as(&format!("{USERS} WHERE id=$1 FOR UPDATE"))
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(Error::missing)?;
    if before.deleted {
        return Err(Error::missing());
    }
    if expected.is_some_and(|e| e != before.revision) {
        return Err(conflict());
    }
    let disabled = changes.disabled.unwrap_or(before.disabled);
    let admin = changes.admin.unwrap_or(before.admin);
    let public = changes
        .create_public_room
        .unwrap_or(before.create_public_room);
    let private = changes
        .create_private_room
        .unwrap_or(before.create_private_room);
    let changed = (disabled, admin, public, private)
        != (
            before.disabled,
            before.admin,
            before.create_public_room,
            before.create_private_room,
        );
    if before.admin && !before.disabled && (!admin || disabled) {
        // The instance keeps an active administrator, whoever asks.
        let others: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM users WHERE admin AND NOT disabled AND id<>$1)",
        )
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
        if !others {
            return Err(Error::new(StatusCode::CONFLICT, "last_administrator"));
        }
    }
    if changed {
        sqlx::query("UPDATE users SET disabled=$2,admin=$3,create_public_room=$4,create_private_room=$5 WHERE id=$1")
            .bind(id).bind(disabled).bind(admin).bind(public).bind(private).execute(&mut **tx).await?;
        // Keep password/factors/emails/messages. Old families and all pending delivery must die.
        for query in [
            "DELETE FROM session_devices WHERE user_id=$1",
            "DELETE FROM sync_cursors WHERE user_id=$1",
            "DELETE FROM snapshot_heads WHERE user_id=$1",
            "DELETE FROM auth_challenges WHERE user_id=$1",
            "DELETE FROM factor_setups WHERE user_id=$1",
        ] {
            sqlx::query(query).bind(id).execute(&mut **tx).await?;
        }
    }
    let after: User = sqlx::query_as(&format!("{USERS} WHERE id=$1"))
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    record(
        tx,
        "user.policy",
        id,
        json!({"before":before,"after":after,"changed":changed}),
    )
    .await?;
    Ok((id.into(), after.revision))
}
fn name(value: &str) -> Result<&str> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(Error::invalid());
    }
    Ok(value)
}
async fn create_room(
    tx: &mut Transaction<'_, Postgres>,
    owner: &str,
    title: &str,
    private: bool,
    voice: bool,
) -> Result<(String, String)> {
    if !auth::identifier(owner) {
        return Err(Error::invalid());
    }
    let title = name(title)?;
    let exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM users WHERE id=$1 AND NOT disabled FOR KEY SHARE")
            .bind(owner)
            .fetch_optional(&mut **tx)
            .await?;
    if exists.is_none() {
        return Err(Error::missing());
    }
    let id = auth::random_token()[..24].to_owned();
    sqlx::query("INSERT INTO rooms(id,name,kind,voice) VALUES($1,$2,$3,$4)")
        .bind(&id)
        .bind(title)
        .bind(if private { "private" } else { "public" })
        .bind(voice)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO members(room_id,user_id,role) VALUES($1,$2,'owner')")
        .bind(&id)
        .bind(owner)
        .execute(&mut **tx)
        .await?;
    room_details::publish(tx, &id).await?;
    let room = room_in(tx, &id, false).await?;
    record(tx, "room.created", &id, json!({"owner":owner,"room":room})).await?;
    Ok((id, room.revision))
}
async fn room_in(tx: &mut Transaction<'_, Postgres>, id: &str, lock: bool) -> Result<Room> {
    if !auth::identifier(id) {
        return Err(Error::invalid());
    }
    sqlx::query_as(&format!(
        "{ROOMS} WHERE r.id=$1{}",
        if lock { " FOR UPDATE OF r" } else { "" }
    ))
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(Error::missing)
}
async fn invalidate(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    user: Option<&str>,
) -> Result<()> {
    sqlx::query("DELETE FROM snapshot_heads WHERE user_id IN(SELECT user_id FROM members WHERE room_id=$1) OR user_id=$2 OR $1=ANY(room_ids)")
        .bind(room).bind(user).execute(&mut **tx).await?;
    Ok(())
}
async fn set_room(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    expected: &str,
    changes: RoomChanges,
) -> Result<(String, String)> {
    if !auth::identifier(expected) {
        return Err(Error::invalid());
    }
    let before = room_in(tx, id, true).await?;
    if before.kind == "direct" {
        return Err(Error::forbidden());
    }
    if before.revision != expected {
        return Err(conflict());
    }
    let title = name(changes.name.as_deref().unwrap_or(&before.name))?;
    let kind = changes
        .private
        .map(|p| if p { "private" } else { "public" })
        .unwrap_or(&before.kind);
    let read_only = changes.read_only.unwrap_or(before.read_only);
    let voice = changes.voice.unwrap_or(before.voice);
    let topic = changes.topic.as_deref().unwrap_or(&before.topic);
    let description = changes
        .description
        .as_deref()
        .unwrap_or(&before.description);
    let announcement = changes
        .announcement
        .as_deref()
        .unwrap_or(&before.announcement);
    if topic.len() > 1024
        || description.len() > 4096
        || announcement.len() > 4096
        || [topic, description, announcement]
            .iter()
            .any(|v| v.contains('\0'))
    {
        return Err(Error::invalid());
    }
    let changed = (title, kind, read_only, topic, description, announcement)
        != (
            before.name.as_str(),
            before.kind.as_str(),
            before.read_only,
            before.topic.as_str(),
            before.description.as_str(),
            before.announcement.as_str(),
        )
        || voice != before.voice;
    if changed {
        sqlx::query("UPDATE rooms SET name=$2,kind=$3,read_only=$4,topic=$5,description=$6,announcement=$7,voice=$8 WHERE id=$1")
            .bind(id).bind(title).bind(kind).bind(read_only).bind(topic).bind(description).bind(announcement).bind(voice).execute(&mut **tx).await?;
        invalidate(tx, id, None).await?;
        room_details::publish(tx, id).await?;
    }
    let after = room_in(tx, id, false).await?;
    record(
        tx,
        "room.settings",
        id,
        json!({"before":before,"after":after,"changed":changed}),
    )
    .await?;
    Ok((id.into(), after.revision))
}
async fn set_member(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    user: &str,
    expected: &str,
    role: Option<&str>,
) -> Result<(String, String)> {
    if !auth::identifier(user)
        || !auth::identifier(expected)
        || role.is_some_and(|r| !matches!(r, "owner" | "moderator" | "member"))
    {
        return Err(Error::invalid());
    }
    let before = room_in(tx, room, true).await?;
    if before.kind == "direct" {
        return Err(Error::forbidden());
    }
    if before.revision != expected {
        return Err(conflict());
    }
    let exists: Option<bool> =
        sqlx::query_scalar("SELECT disabled FROM users WHERE id=$1 FOR KEY SHARE")
            .bind(user)
            .fetch_optional(&mut **tx)
            .await?;
    if exists.is_none() || exists == Some(true) && role.is_some() {
        return Err(Error::missing());
    }
    if role.is_some() {
        crate::bots::refuse_encrypted(tx, room, user).await?;
    }
    let previous: Option<String> =
        sqlx::query_scalar("SELECT role FROM members WHERE room_id=$1 AND user_id=$2 FOR UPDATE")
            .bind(room)
            .bind(user)
            .fetch_optional(&mut **tx)
            .await?;
    if previous.as_deref() == Some("owner") && role != Some("owner") {
        room_details::require_other_owner(tx, room, user).await?;
    }
    let changed = previous.as_deref() != role;
    if changed {
        if let Some(role) = role {
            sqlx::query("INSERT INTO members(room_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(room_id,user_id) DO UPDATE SET role=excluded.role")
                .bind(room).bind(user).bind(role).execute(&mut **tx).await?;
        } else {
            sqlx::query("DELETE FROM members WHERE room_id=$1 AND user_id=$2")
                .bind(room)
                .bind(user)
                .execute(&mut **tx)
                .await?;
        }
        invalidate(tx, room, Some(user)).await?;
        if role.is_none() {
            let position = store::next_position(tx).await?;
            store::event(
                tx,
                position,
                room,
                Some(user),
                Change::RoomRemoved {
                    room_id: room.into(),
                },
            )
            .await?;
        }
        room_details::publish(tx, room).await?;
    }
    let after = room_in(tx, room, false).await?;
    record(
        tx,
        "room.member",
        room,
        json!({"user_id":user,"before":previous,"after":role,"changed":changed}),
    )
    .await?;
    Ok((room.into(), after.revision))
}
pub async fn health(app: &App) -> Result<Value> {
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let value:Json<Value>=sqlx::query_scalar("SELECT jsonb_build_object('database','ok','server_version',$1::text,'postgres_version',current_setting('server_version'),'instance_id',instance_id,'data_epoch',data_epoch,'journal_position',position::text,'active_users',(SELECT count(*) FROM users WHERE NOT disabled),'disabled_users',(SELECT count(*) FROM users WHERE disabled),'rooms',(SELECT count(*) FROM rooms),'messages',(SELECT count(*) FROM messages),'migration_version',(SELECT max(version)::text FROM _sqlx_migrations WHERE success)) FROM instance WHERE singleton")
        .bind(env!("CARGO_PKG_VERSION")).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(value.0)
}
