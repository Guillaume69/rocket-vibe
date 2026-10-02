//! Server authority. Client booleans are hints; mutations recompute under locks.
use crate::{
    App,
    auth::Account,
    error::{Error, Result},
};
use chrono::{DateTime, Duration, Utc};
use rv_protocol::parity::{AccountPermissions, MessagePermissions, RoomPermissions, RoomRole};
use sqlx::{Postgres, Transaction};

pub(crate) fn role(value: &str) -> RoomRole {
    match value {
        "owner" => RoomRole::Owner,
        "moderator" => RoomRole::Moderator,
        _ => RoomRole::Member,
    }
}

pub async fn account(app: &App, actor: &Account) -> Result<AccountPermissions> {
    let (public, private, admin): (bool, bool, bool) = sqlx::query_as("SELECT create_public_room,create_private_room,admin FROM users WHERE id=$1 AND NOT disabled")
        .bind(&actor.id).fetch_optional(&app.pool).await?.ok_or_else(Error::unauthorized)?;
    Ok(AccountPermissions {
        create_public_room: public,
        create_private_room: private,
        manage_accounts: admin,
        manage_instance: admin,
    })
}

pub async fn room(app: &App, actor: &Account, id: &str) -> Result<RoomPermissions> {
    let (role, kind, read_only, version, grant): (String,String,bool,String,String) = sqlx::query_as("SELECT m.role,r.kind,r.read_only,r.authority_version,m.access_version FROM members m JOIN rooms r ON r.id=m.room_id WHERE m.user_id=$1 AND m.room_id=$2")
        .bind(&actor.id).bind(id).fetch_optional(&app.pool).await?.ok_or_else(Error::missing)?;
    Ok(room_grant(id, &role, &kind, read_only, &version, &grant))
}

pub(crate) fn room_grant(
    id: &str,
    role: &str,
    kind: &str,
    read_only: bool,
    version: &str,
    grant: &str,
) -> RoomPermissions {
    let owner = role == "owner";
    let elevated = owner || role == "moderator";
    RoomPermissions {
        room_id: id.into(),
        revision: format!("{version}:{grant}"),
        role: self::role(role),
        read: true,
        send: !read_only || elevated,
        invite: owner && kind != "direct",
        remove_member: owner && kind != "direct",
        change_settings: owner && kind != "direct",
        pin: elevated,
        upload: !read_only || elevated,
        start_call: !read_only || elevated,
    }
}

pub async fn message(app: &App, actor: &Account, id: &str) -> Result<(String, MessagePermissions)> {
    let row: MessageGrant = sqlx::query_as("SELECT m.room_id,m.revision,m.author_id,m.created_at,g.role,r.read_only,m.deleted FROM messages m JOIN members g ON g.room_id=m.room_id AND g.user_id=$1 JOIN rooms r ON r.id=m.room_id WHERE m.id=$2")
        .bind(&actor.id).bind(id).fetch_optional(&app.pool).await?.ok_or_else(Error::missing)?;
    let deadline = row.created_at + Duration::minutes(15);
    let elevated = row.role == "owner" || row.role == "moderator";
    let own = row.author_id == actor.id && deadline > Utc::now();
    let send = !row.read_only || elevated;
    Ok((
        row.room_id,
        MessagePermissions {
            message_id: id.into(),
            revision: row.revision.to_string(),
            edit: !row.deleted && own && send,
            delete: !row.deleted && (own || elevated),
            react: !row.deleted && send,
            pin: !row.deleted && elevated,
            star: !row.deleted,
            edit_until: Some(deadline.to_rfc3339()),
        },
    ))
}

#[derive(sqlx::FromRow)]
struct MessageGrant {
    room_id: String,
    revision: i64,
    author_id: String,
    created_at: DateTime<Utc>,
    role: String,
    read_only: bool,
    deleted: bool,
}

pub(crate) async fn require_send(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    user: &str,
) -> Result<()> {
    let allowed: Option<bool> = sqlx::query_scalar("SELECT NOT r.read_only OR m.role IN ('owner','moderator') FROM rooms r JOIN members m ON m.room_id=r.id AND m.user_id=$2 WHERE r.id=$1 FOR SHARE OF r,m")
        .bind(room).bind(user).fetch_optional(&mut **tx).await?;
    match allowed {
        Some(true) => Ok(()),
        Some(false) => Err(Error::forbidden()),
        None => Err(Error::missing()),
    }
}
