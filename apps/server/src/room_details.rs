//! Versioned room information and membership management. No admin bypass.
use crate::{
    App,
    auth::{Account, identifier, lock_active},
    error::{Error, Result},
    permissions,
    store::{self, RoomRow},
};
use axum::http::StatusCode;
use rv_protocol::{
    Change,
    parity::{
        ChangeRoomRole, LeaveRoom, RoomCommandReceipt, RoomDetails, RoomMember, RoomMemberPage,
        RoomRole, UpdateRoom,
    },
};
use sqlx::{FromRow, Postgres, Transaction};

#[derive(FromRow)]
struct CoreRoom {
    #[sqlx(flatten)]
    room: RoomRow,
    details_version: String,
    authority_version: String,
    topic: String,
    description: String,
    announcement: String,
    read_only: bool,
}
#[derive(FromRow)]
struct DetailsRow {
    #[sqlx(flatten)]
    core: CoreRoom,
    actor_role: String,
    actor_access: String,
    member_count: i64,
}
pub async fn read(app: &App, actor: &Account, room: &str) -> Result<RoomDetails> {
    if !identifier(room) {
        return Err(Error::invalid());
    }
    let row: DetailsRow = sqlx::query_as("SELECT r.*,m.role AS actor_role,m.access_version AS actor_access,(SELECT count(*) FROM members g WHERE g.room_id=r.id) AS member_count FROM rooms r JOIN members m ON m.room_id=r.id AND m.user_id=$2 WHERE r.id=$1")
        .bind(room).bind(&actor.id).fetch_optional(&app.pool).await?.ok_or_else(Error::missing)?;
    let p = permissions::room_grant(
        room,
        &row.actor_role,
        &row.core.room.kind,
        row.core.read_only,
        &row.core.authority_version,
        &row.actor_access,
    );
    Ok(RoomDetails {
        room: row.core.room.wire(),
        revision: row.core.details_version,
        topic: row.core.topic,
        description: row.core.description,
        announcement: row.core.announcement,
        read_only: row.core.read_only,
        member_count: u32::try_from(row.member_count).map_err(|_| Error::internal())?,
        permissions: p,
    })
}
pub async fn members(
    app: &App,
    actor: &Account,
    room: &str,
    after: Option<&str>,
    expected: Option<&str>,
) -> Result<RoomMemberPage> {
    if !identifier(room)
        || after.is_some_and(|s| !identifier(s))
        || expected.is_some_and(|s| !identifier(s))
        || after.is_some() && expected.is_none()
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let revision: String = sqlx::query_scalar("SELECT r.details_version FROM rooms r JOIN members m ON m.room_id=r.id AND m.user_id=$2 WHERE r.id=$1")
        .bind(room).bind(&actor.id).fetch_optional(&mut *tx).await?.ok_or_else(Error::missing)?;
    if expected.is_some_and(|value| value != revision) {
        return Err(revision_conflict());
    }
    let rows: Vec<(String,String,String,String,bool)> = sqlx::query_as("SELECT u.id,u.username,u.display_name,m.role,u.disabled FROM members m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 AND u.id>$2 ORDER BY u.id LIMIT 51")
        .bind(room).bind(after.unwrap_or("")).fetch_all(&mut *tx).await?;
    let more = rows.len() > 50;
    let members: Vec<_> = rows
        .into_iter()
        .take(50)
        .map(|(id, username, display_name, role, disabled)| RoomMember {
            user: rv_protocol::User {
                id,
                username,
                display_name,
            },
            role: permissions::role(&role),
            disabled,
        })
        .collect();
    let next = more.then(|| members.last().unwrap().user.id.clone());
    tx.commit().await?;
    Ok(RoomMemberPage {
        room_id: room.into(),
        revision,
        members,
        next,
    })
}
fn revision_conflict() -> Error {
    Error::new(StatusCode::CONFLICT, "revision_conflict")
}
fn role_name(role: RoomRole) -> &'static str {
    match role {
        RoomRole::Owner => "owner",
        RoomRole::Moderator => "moderator",
        RoomRole::Member => "member",
    }
}
pub enum Command {
    Settings(UpdateRoom),
    Role {
        target: String,
        input: ChangeRoomRole,
    },
    Leave(LeaveRoom),
}
impl Command {
    fn parts(&self, room: &str) -> Result<(&str, &str, String)> {
        let (operation, expected, fields) = match self {
            Self::Settings(i) => {
                let name = i.name.trim();
                if name.is_empty()
                    || name.len() > 128
                    || name.chars().any(char::is_control)
                    || i.topic.len() > 1024
                    || i.description.len() > 4096
                    || i.announcement.len() > 4096
                    || [&i.topic, &i.description, &i.announcement]
                        .iter()
                        .any(|s| s.contains('\0'))
                {
                    return Err(Error::invalid());
                }
                (
                    &i.operation_id,
                    &i.expected_revision,
                    serde_json::json!([
                        "settings",
                        room,
                        i.expected_revision,
                        name,
                        i.private,
                        i.topic,
                        i.description,
                        i.announcement,
                        i.read_only
                    ]),
                )
            }
            Self::Role { target, input: i } => {
                if !identifier(target) {
                    return Err(Error::invalid());
                }
                (
                    &i.operation_id,
                    &i.expected_revision,
                    serde_json::json!(["role", room, target, i.expected_revision, i.role]),
                )
            }
            Self::Leave(i) => (
                &i.operation_id,
                &i.expected_revision,
                serde_json::json!(["leave", room, i.expected_revision]),
            ),
        };
        if !identifier(room) || !identifier(operation) || !identifier(expected) {
            return Err(Error::invalid());
        }
        Ok((
            operation,
            expected,
            crate::auth::hash_token(&fields.to_string()),
        ))
    }
}
pub async fn receipt(
    app: &App,
    actor: &Account,
    room: &str,
    operation: &str,
) -> Result<RoomCommandReceipt> {
    if !identifier(room) || !identifier(operation) {
        return Err(Error::invalid());
    }
    let revision: String = sqlx::query_scalar("SELECT applied_revision FROM room_commands WHERE user_id=$1 AND room_id=$2 AND operation_id=$3")
        .bind(&actor.id).bind(room).bind(operation).fetch_optional(&app.pool).await?.ok_or_else(Error::missing)?;
    Ok(RoomCommandReceipt {
        operation_id: operation.into(),
        room_id: room.into(),
        applied_revision: revision,
    })
}
pub async fn apply(
    app: &App,
    actor: &Account,
    room: &str,
    command: Command,
) -> Result<RoomCommandReceipt> {
    let (operation, expected, fingerprint) = command.parts(room)?;
    let mut tx = app.pool.begin().await?;
    lock_active(&mut tx, actor).await?;
    // Personal receipts remain readable after a successful departure or self
    // demotion. Replaying never restores membership, settings or an old role.
    let old: Option<(String,String,String)> = sqlx::query_as("SELECT room_id,command_hash,applied_revision FROM room_commands WHERE user_id=$1 AND operation_id=$2")
        .bind(&actor.id).bind(operation).fetch_optional(&mut *tx).await?;
    if let Some((old_room, hash, revision)) = old {
        if old_room != room || hash != fingerprint {
            return Err(Error::conflict());
        }
        tx.commit().await?;
        return Ok(RoomCommandReceipt {
            operation_id: operation.into(),
            room_id: room.into(),
            applied_revision: revision,
        });
    }
    let current: CoreRoom = sqlx::query_as("SELECT * FROM rooms WHERE id=$1 FOR UPDATE")
        .bind(room)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::missing)?;
    let role = store::require_member(&mut tx, room, &actor.id).await?;
    if current.room.kind == "direct" {
        return Err(Error::forbidden());
    }
    if !matches!(command, Command::Leave(_)) && role != "owner" {
        return Err(Error::forbidden());
    }
    if current.details_version != expected {
        return Err(revision_conflict());
    }
    let used: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM message_actions WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_creation_requests WHERE user_id=$1 AND operation_id=$2)")
        .bind(&actor.id).bind(operation).fetch_one(&mut *tx).await?;
    if used {
        return Err(Error::conflict());
    }
    admission(&mut tx, &actor.id).await?;
    let leaving = matches!(command, Command::Leave(_));
    let changed = match &command {
        Command::Settings(input) => {
            let kind = if input.private { "private" } else { "public" };
            let changed = current.room.name != input.name.trim()
                || current.room.kind != kind
                || current.read_only != input.read_only
                || current.topic != input.topic
                || current.description != input.description
                || current.announcement != input.announcement;
            if changed {
                sqlx::query("UPDATE rooms SET name=$2,kind=$3,read_only=$4,topic=$5,description=$6,announcement=$7 WHERE id=$1")
                    .bind(room).bind(input.name.trim()).bind(kind).bind(input.read_only).bind(&input.topic).bind(&input.description).bind(&input.announcement).execute(&mut *tx).await?;
            }
            changed
        }
        Command::Role { target, input } => {
            let previous: String = sqlx::query_scalar("SELECT m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 AND m.user_id=$2 AND NOT u.disabled FOR UPDATE OF m FOR KEY SHARE OF u")
                .bind(room).bind(target).fetch_optional(&mut *tx).await?.ok_or_else(Error::missing)?;
            let next = role_name(input.role);
            if previous == "owner" && next != "owner" {
                require_other_owner(&mut tx, room, target).await?;
            }
            if previous != next {
                sqlx::query("UPDATE members SET role=$3 WHERE room_id=$1 AND user_id=$2")
                    .bind(room)
                    .bind(target)
                    .bind(next)
                    .execute(&mut *tx)
                    .await?;
            }
            previous != next
        }
        Command::Leave(_) => {
            if role == "owner" {
                require_other_owner(&mut tx, room, &actor.id).await?;
            }
            sqlx::query("DELETE FROM members WHERE room_id=$1 AND user_id=$2")
                .bind(room)
                .bind(&actor.id)
                .execute(&mut *tx)
                .await?;
            true
        }
    };
    if changed {
        // Cancel both materialized pages and reservations which are still building.
        sqlx::query("DELETE FROM snapshot_heads WHERE user_id IN (SELECT user_id FROM members WHERE room_id=$1) OR user_id=$2 OR $1=ANY(room_ids)")
            .bind(room).bind(&actor.id).execute(&mut *tx).await?;
        if leaving {
            let position = store::next_position(&mut tx).await?;
            store::event(
                &mut tx,
                position,
                room,
                Some(&actor.id),
                Change::RoomRemoved {
                    room_id: room.into(),
                },
            )
            .await?;
        }
        publish(&mut tx, room).await?;
    }
    let revision: String = sqlx::query_scalar("SELECT details_version FROM rooms WHERE id=$1")
        .bind(room)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO room_commands(user_id,operation_id,room_id,command_hash,applied_revision) VALUES($1,$2,$3,$4,$5)")
        .bind(&actor.id).bind(operation).bind(room).bind(fingerprint).bind(&revision).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(RoomCommandReceipt {
        operation_id: operation.into(),
        room_id: room.into(),
        applied_revision: revision,
    })
}
async fn require_other_owner(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    target: &str,
) -> Result<()> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM members WHERE room_id=$1 AND role='owner' AND user_id<>$2)",
    )
    .bind(room)
    .bind(target)
    .fetch_one(&mut **tx)
    .await?;
    if !exists {
        return Err(Error::new(StatusCode::CONFLICT, "last_room_owner"));
    }
    Ok(())
}
pub(crate) async fn publish(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
) -> Result<rv_protocol::Room> {
    let position = store::next_position(tx).await?;
    let row: RoomRow =
        sqlx::query_as("UPDATE rooms SET revision=$2 WHERE id=$1 RETURNING id,name,kind,revision")
            .bind(room)
            .bind(position)
            .fetch_one(&mut **tx)
            .await?;
    let room = row.wire();
    store::event(
        tx,
        position,
        &room.id,
        None,
        Change::RoomUpsert(room.clone()),
    )
    .await?;
    Ok(room)
}
async fn admission(tx: &mut Transaction<'_, Postgres>, user: &str) -> Result<()> {
    let (attempts,retry):(i32,i64)=sqlx::query_as("INSERT INTO room_command_windows(user_id,attempts,expires_at) VALUES($1,1,clock_timestamp()+interval '60 seconds') ON CONFLICT(user_id) DO UPDATE SET attempts=CASE WHEN room_command_windows.expires_at<=clock_timestamp() THEN 1 ELSE room_command_windows.attempts+1 END,expires_at=CASE WHEN room_command_windows.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '60 seconds' ELSE room_command_windows.expires_at END RETURNING attempts,GREATEST(1,ceil(extract(epoch from expires_at-clock_timestamp())))::bigint")
        .bind(user).fetch_one(&mut **tx).await?;
    if attempts > 30 {
        return Err(Error::throttled("room_command_limit", retry as u64));
    }
    Ok(())
}
