//! In-app administration and member reports (ADMINISTRATION.md). An account
//! with `users.admin` manages accounts and moderates reports; it still reads no
//! private conversation. A message's text reaches it only through an open
//! report, and moderation deletes only a reported message.
use crate::{
    App,
    auth::{self, Account, identifier},
    error::{Error, Result},
    message_actions,
    operator::{self, UserChanges},
    store::{self, MESSAGE_SELECT, MessageRow},
};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rv_protocol::{
    Change, RoomKind, User,
    admin::{
        AdminMessageCounts, AdminOverview, AdminReport, AdminReportCounts, AdminReportedMessage,
        AdminReportedMessagePage, AdminReportedUser, AdminReportedUserPage, AdminRoom,
        AdminRoomCounts, AdminRoomPage, AdminUploadCounts, AdminUser, AdminUserCounts,
        AdminUserPage, DeleteAdminUser, ReportInput, UpdateAdminUser,
    },
};
use serde_json::json;
use sqlx::{FromRow, Postgres, Transaction};
use std::collections::HashMap;

/// Live presence per account: the strongest unexpired lease of a live session.
const PRESENCE: &str = "WITH presence AS (SELECT p.user_id,min(CASE p.status WHEN 'busy' THEN 0 WHEN 'online' THEN 1 ELSE 2 END) AS priority FROM presence_leases p JOIN instance i ON i.singleton AND p.data_epoch=i.data_epoch WHERE p.expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM sessions s WHERE s.device_id=p.device_id AND s.expires_at>clock_timestamp()) GROUP BY p.user_id)";
/// A disabled account's avatar is no longer served, so it is not advertised.
const USER_COLUMNS: &str = "u.id,u.username,u.display_name,CASE WHEN u.disabled THEN NULL ELSE u.avatar_file_id END AS avatar_file_id,u.admin,u.disabled,COALESCE(CASE p.priority WHEN 0 THEN 'busy' WHEN 1 THEN 'online' WHEN 2 THEN 'away' END,'offline') AS status,u.created_at,(SELECT max(d.last_seen_at) FROM session_devices d WHERE d.user_id=u.id) AS last_seen_at,u.activation_version AS revision";
const REPORTS_SHOWN: i64 = 20;
/// Open reports one account may have at once, messages and accounts together.
const OPEN_REPORTS: i64 = 200;

#[derive(FromRow)]
struct UserRow {
    id: String,
    username: String,
    display_name: String,
    avatar_file_id: Option<String>,
    admin: bool,
    disabled: bool,
    status: String,
    created_at: Option<DateTime<Utc>>,
    last_seen_at: Option<DateTime<Utc>>,
    revision: String,
}
impl UserRow {
    fn wire(self) -> AdminUser {
        AdminUser {
            id: self.id,
            username: self.username,
            display_name: self.display_name,
            avatar_file_id: self.avatar_file_id,
            admin: self.admin,
            disabled: self.disabled,
            status: crate::profiles::status(&self.status),
            created_at: self.created_at.map(|t| t.to_rfc3339()),
            last_seen_at: self.last_seen_at.map(|t| t.to_rfc3339()),
            revision: self.revision,
        }
    }
}

fn count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or_default()
}
fn limit(value: Option<u32>) -> Result<i64> {
    let value = value.unwrap_or(50);
    if !(1..=100).contains(&value) {
        return Err(Error::invalid());
    }
    Ok(i64::from(value))
}
fn hex(value: &str) -> String {
    value.bytes().map(|b| format!("{b:02x}")).collect()
}
fn unhex(value: &str) -> Option<String> {
    if value.is_empty() || !value.len().is_multiple_of(2) {
        return None;
    }
    let bytes = (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(value.get(i..i + 2)?, 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}
/// An opaque keyset cursor: the last row's sort key and ID, so a rename or a
/// deletion between two pages neither skips nor repeats a row.
fn cursor_after(key: &str, id: &str) -> String {
    format!("{}-{}", hex(key), hex(id))
}
fn cursor(after: Option<&str>) -> Result<(Option<String>, Option<String>)> {
    let Some(after) = after else {
        return Ok((None, None));
    };
    let decoded = (after.len() <= 1100)
        .then(|| after.split_once('-'))
        .flatten()
        .and_then(|(key, id)| Some((unhex(key)?, unhex(id)?)))
        .filter(|(_, id)| identifier(id));
    let (key, id) = decoded.ok_or_else(Error::invalid)?;
    Ok((Some(key), Some(id)))
}
/// Report pages go from the newest report back; the cursor is a report ID.
fn report_cursor(after: Option<&str>) -> Result<Option<i64>> {
    after.map(crate::room_reads::position).transpose()
}
/// A literal, case-insensitive substring; no wildcard.
fn search(q: Option<&str>) -> Result<Option<String>> {
    let Some(q) = q.map(str::trim).filter(|q| !q.is_empty()) else {
        return Ok(None);
    };
    if q.chars().count() > 128 || q.chars().any(char::is_control) {
        return Err(Error::invalid());
    }
    Ok(Some(q.to_owned()))
}
/// Keyset page: one extra row fetched tells whether a next page exists.
fn page<T>(mut items: Vec<T>, size: i64, key: impl Fn(&T) -> String) -> (Vec<T>, Option<String>) {
    let more = items.len() as i64 > size;
    items.truncate(size as usize);
    let next = if more { items.last().map(key) } else { None };
    (items, next)
}
fn wire_user(id: String, username: String, display_name: String, deleted: bool) -> User {
    User {
        id,
        username,
        display_name,
        deleted,
        ..Default::default()
    }
}
fn room_kind(kind: &str) -> RoomKind {
    match kind {
        "private" => RoomKind::Private,
        "direct" => RoomKind::Direct,
        _ => RoomKind::Public,
    }
}

pub(crate) fn require_admin(actor: &Account) -> Result<()> {
    if actor.admin {
        Ok(())
    } else {
        Err(Error::forbidden())
    }
}

pub(crate) async fn overview(app: &App) -> Result<AdminOverview> {
    #[derive(FromRow)]
    struct Row {
        postgres_version: String,
        migration_version: Option<String>,
        instance_id: String,
        data_epoch: String,
        users_total: i64,
        users_active: i64,
        users_deactivated: i64,
        admins: i64,
        online: i64,
        away: i64,
        busy: i64,
        rooms_total: i64,
        rooms_public: i64,
        rooms_private: i64,
        rooms_direct: i64,
        rooms_encrypted: i64,
        messages_public: i64,
        messages_private: i64,
        messages_direct: i64,
        messages_encrypted: i64,
        uploads: i64,
        upload_bytes: i64,
        reported_messages: i64,
        reported_users: i64,
    }
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let row: Row = sqlx::query_as(&format!("{PRESENCE}, live AS (SELECT count(*) FILTER (WHERE p.priority=1) AS online,count(*) FILTER (WHERE p.priority=2) AS away,count(*) FILTER (WHERE p.priority=0) AS busy FROM presence p JOIN users u ON u.id=p.user_id AND NOT u.disabled), room_counts AS (SELECT count(*) AS total,count(*) FILTER (WHERE kind='public') AS public,count(*) FILTER (WHERE kind='private') AS private,count(*) FILTER (WHERE kind='direct') AS direct FROM rooms), message_counts AS (SELECT count(*) FILTER (WHERE r.kind='public') AS public,count(*) FILTER (WHERE r.kind='private') AS private,count(*) FILTER (WHERE r.kind='direct') AS direct FROM messages m JOIN rooms r ON r.id=m.room_id WHERE NOT m.deleted AND m.system IS NULL) \
         SELECT current_setting('server_version') AS postgres_version,(SELECT max(version)::text FROM _sqlx_migrations WHERE success) AS migration_version,i.instance_id,i.data_epoch,\
         (SELECT count(*) FROM users WHERE NOT deleted) AS users_total,(SELECT count(*) FROM users WHERE NOT disabled) AS users_active,(SELECT count(*) FROM users WHERE disabled AND NOT deleted) AS users_deactivated,(SELECT count(*) FROM users WHERE admin AND NOT disabled) AS admins,\
         l.online,l.away,l.busy,r.total AS rooms_total,r.public AS rooms_public,r.private AS rooms_private,r.direct AS rooms_direct,(SELECT count(*) FROM e2ee_groups) AS rooms_encrypted,\
         m.public AS messages_public,m.private AS messages_private,m.direct AS messages_direct,(SELECT count(*) FROM e2ee_application_messages) AS messages_encrypted,\
         (SELECT count(*) FROM uploads WHERE state='completed') AS uploads,(SELECT COALESCE(sum(bytes),0)::bigint FROM uploads WHERE state='completed') AS upload_bytes,\
         (SELECT count(DISTINCT message_id) FROM message_reports WHERE closed_at IS NULL) AS reported_messages,(SELECT count(DISTINCT x.user_id) FROM user_reports x JOIN users u ON u.id=x.user_id AND NOT u.deleted WHERE x.closed_at IS NULL) AS reported_users \
         FROM instance i CROSS JOIN live l CROSS JOIN room_counts r CROSS JOIN message_counts m WHERE i.singleton"))
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    let messages = AdminMessageCounts {
        total: count(
            row.messages_public
                + row.messages_private
                + row.messages_direct
                + row.messages_encrypted,
        ),
        public: count(row.messages_public),
        private: count(row.messages_private),
        direct: count(row.messages_direct),
        encrypted: count(row.messages_encrypted),
    };
    Ok(AdminOverview {
        server_version: env!("CARGO_PKG_VERSION").into(),
        postgres_version: row.postgres_version,
        migration_version: row.migration_version,
        instance_id: row.instance_id,
        data_epoch: row.data_epoch,
        started_at: app.started_at.to_rfc3339(),
        users: AdminUserCounts {
            total: count(row.users_total),
            active: count(row.users_active),
            deactivated: count(row.users_deactivated),
            admins: count(row.admins),
            online: count(row.online),
            away: count(row.away),
            busy: count(row.busy),
            offline: count(row.users_active - row.online - row.away - row.busy),
        },
        rooms: AdminRoomCounts {
            total: count(row.rooms_total),
            public: count(row.rooms_public),
            private: count(row.rooms_private),
            direct: count(row.rooms_direct),
            encrypted: count(row.rooms_encrypted),
        },
        messages,
        uploads: AdminUploadCounts {
            count: count(row.uploads),
            bytes: count(row.upload_bytes),
        },
        reports: AdminReportCounts {
            messages: count(row.reported_messages),
            users: count(row.reported_users),
        },
    })
}

/// Deleted accounts never appear; disabled ones do. Ordered by username.
pub(crate) async fn users(
    app: &App,
    after: Option<&str>,
    size: Option<u32>,
    q: Option<&str>,
) -> Result<AdminUserPage> {
    let size = limit(size)?;
    let (key, id) = cursor(after)?;
    let rows: Vec<UserRow> = sqlx::query_as(&format!("{PRESENCE} SELECT {USER_COLUMNS} FROM users u LEFT JOIN presence p ON p.user_id=u.id WHERE NOT u.deleted AND ($1::text IS NULL OR (u.username,u.id)>($1::text,$2::text)) AND ($3::text IS NULL OR strpos(lower(u.username),lower($3))>0 OR strpos(lower(u.display_name),lower($3))>0) ORDER BY u.username,u.id LIMIT $4"))
        .bind(key)
        .bind(id)
        .bind(search(q)?)
        .bind(size + 1)
        .fetch_all(&app.pool)
        .await?;
    let (items, next) = page(rows, size, |u| cursor_after(&u.username, &u.id));
    Ok(AdminUserPage {
        items: items.into_iter().map(UserRow::wire).collect(),
        next,
    })
}

async fn user_in(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<AdminUser> {
    let row: UserRow = sqlx::query_as(&format!(
        "{PRESENCE} SELECT {USER_COLUMNS} FROM users u LEFT JOIN presence p ON p.user_id=u.id WHERE u.id=$1 AND NOT u.deleted"
    ))
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(Error::missing)?;
    Ok(row.wire())
}

/// Every command's prologue: authorization under lock, then its receipt.
/// `Ok(None)` is the replay of an applied command, which is never reapplied.
pub(crate) async fn admit(
    app: &App,
    actor: &Account,
    administration: bool,
    operation: &str,
    fingerprint: &str,
) -> Result<(Transaction<'static, Postgres>, bool)> {
    admit_with(
        app,
        actor,
        administration,
        administration,
        operation,
        fingerprint,
    )
    .await
}

/// `queue`: takes the administration lock before the actor's, as every
/// command that ends in `operator::set_user` must (a bot's deletion).
pub(crate) async fn admit_with(
    app: &App,
    actor: &Account,
    queue: bool,
    administration: bool,
    operation: &str,
    fingerprint: &str,
) -> Result<(Transaction<'static, Postgres>, bool)> {
    if !identifier(operation) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    if queue {
        // Account changes queue behind each other: two administrators demoting
        // each other can neither deadlock nor both succeed.
        operator::administration_lock(&mut tx).await?;
    }
    auth::lock_active(&mut tx, actor).await?;
    // The activation version also covers the admin right: lock_active proved it current.
    if administration {
        require_admin(actor)?;
    }
    sqlx::query("SELECT set_config('rocketvibe.operator_actor',$1,true),set_config('rocketvibe.operator_operation',$2,true)")
        .bind(&actor.id)
        .bind(operation)
        .execute(&mut *tx)
        .await?;
    let saved: Option<String> = sqlx::query_scalar(
        "SELECT command_hash FROM moderation_commands WHERE actor_id=$1 AND operation_id=$2",
    )
    .bind(&actor.id)
    .bind(operation)
    .fetch_optional(&mut *tx)
    .await?;
    match saved {
        Some(hash) if hash == fingerprint => Ok((tx, true)),
        Some(_) => Err(Error::conflict()),
        None => Ok((tx, false)),
    }
}
pub(crate) async fn settle(
    mut tx: Transaction<'static, Postgres>,
    actor: &Account,
    operation: &str,
    fingerprint: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO moderation_commands(actor_id,operation_id,command_hash) VALUES($1,$2,$3)",
    )
    .bind(&actor.id)
    .bind(operation)
    .bind(fingerprint)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
pub(crate) fn fingerprint(value: serde_json::Value) -> String {
    auth::hash_token(&value.to_string())
}
fn self_administration() -> Error {
    Error::new(StatusCode::CONFLICT, "self_administration")
}

/// Locks a live (not deleted) account and checks the expected revision. Its
/// username and avatar are what a deletion retires.
async fn target(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    revision: &str,
) -> Result<(String, Option<String>)> {
    let (username, avatar, current): (String, Option<String>, String) = sqlx::query_as(
        "SELECT username,avatar_file_id,activation_version FROM users WHERE id=$1 AND NOT deleted FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(Error::missing)?;
    if current != revision {
        return Err(Error::new(StatusCode::CONFLICT, "revision_conflict"));
    }
    Ok((username, avatar))
}

pub(crate) async fn update_user(
    app: &App,
    actor: &Account,
    id: &str,
    input: UpdateAdminUser,
) -> Result<AdminUser> {
    if !identifier(id) || !identifier(&input.revision) {
        return Err(Error::invalid());
    }
    let hash = fingerprint(json!([
        "admin.user",
        id,
        input.revision,
        input.admin,
        input.disabled
    ]));
    let (mut tx, replay) = admit(app, actor, true, &input.operation_id, &hash).await?;
    if replay {
        let current = user_in(&mut tx, id).await?;
        tx.commit().await?;
        return Ok(current);
    }
    if id == actor.id {
        return Err(self_administration());
    }
    target(&mut tx, id, &input.revision).await?;
    // The CLI's own change: revokes devices, cursors, snapshots and challenges,
    // and keeps an active administrator (`last_administrator`).
    operator::set_user(
        &mut tx,
        id,
        Some(&input.revision),
        UserChanges {
            admin: input.admin,
            disabled: input.disabled,
            ..Default::default()
        },
    )
    .await?;
    let current = user_in(&mut tx, id).await?;
    settle(tx, actor, &input.operation_id, &hash).await?;
    Ok(current)
}

/// Tombstones an account. Its messages stay with their author, now shown as a
/// deleted user; everything that identified, authenticated or reached it goes.
pub(crate) async fn delete_user(
    app: &App,
    actor: &Account,
    id: &str,
    input: DeleteAdminUser,
) -> Result<()> {
    if !identifier(id) || !identifier(&input.revision) {
        return Err(Error::invalid());
    }
    let hash = fingerprint(json!(["admin.delete", id, input.revision]));
    let (mut tx, replay) = admit(app, actor, true, &input.operation_id, &hash).await?;
    if replay {
        tx.commit().await?;
        return Ok(());
    }
    if id == actor.id {
        return Err(self_administration());
    }
    let avatar = tombstone(&mut tx, id, &input.revision).await?;
    settle(tx, actor, &input.operation_id, &hash).await?;
    // The avatar is unreferenced now; collection would also reclaim it later.
    if let (Some(store), Some(avatar)) = (&app.objects, avatar) {
        let _ = store.remove(&avatar).await;
    }
    Ok(())
}

/// Deletes a live account at its expected revision, inside the caller's
/// administration command; answers its avatar, to remove after the commit.
pub(crate) async fn tombstone(
    tx: &mut Transaction<'static, Postgres>,
    id: &str,
    revision: &str,
) -> Result<Option<String>> {
    let (username, avatar) = target(tx, id, revision).await?;
    // Deactivation first: devices (and with them sessions, tickets, push
    // registrations, presence and E2EE devices), cursors, snapshots, challenges;
    // it refuses to remove the last active administrator.
    operator::set_user(
        tx,
        id,
        Some(revision),
        UserChanges {
            disabled: Some(true),
            admin: Some(false),
            create_public_room: Some(false),
            create_private_room: Some(false),
        },
    )
    .await?;
    for query in [
        "DELETE FROM push_devices WHERE user_id=$1",
        "DELETE FROM presence_leases WHERE user_id=$1",
        "DELETE FROM typing_leases WHERE user_id=$1",
        "DELETE FROM user_email_factors WHERE user_id=$1",
        "DELETE FROM user_factors WHERE user_id=$1",
        "DELETE FROM factor_backup_codes WHERE user_id=$1",
        "DELETE FROM account_emails WHERE user_id=$1",
        "UPDATE account_recovery_codes SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL AND consumed_at IS NULL",
        "UPDATE user_reports SET closed_at=clock_timestamp(),closed_by=current_setting('rocketvibe.operator_actor',true),resolution='deleted' WHERE user_id=$1 AND closed_at IS NULL",
        // Pending e-mail recovery keeps only its opaque no-op receipt, as for a removed account.
        "UPDATE email_recovery_outbox SET payload_cipher=NULL,lease_id=NULL,lease_expires_at=NULL WHERE request_hash IN (SELECT operation_hash FROM email_recovery_requests WHERE user_id=$1)",
        "UPDATE email_recovery_requests SET user_id=NULL,activation_version=NULL,email_version=NULL,address=NULL,token_hash=NULL WHERE user_id=$1",
        // Sealed key material nobody can open any more: the account has no device left.
        "DELETE FROM e2ee_root_backups WHERE user_id=$1",
        "DELETE FROM e2ee_history_keys WHERE user_id=$1",
        "DELETE FROM e2ee_history_key_generations WHERE user_id=$1",
    ] {
        sqlx::query(query).bind(id).execute(&mut **tx).await?;
    }
    // The username is retired: no later account may take it.
    sqlx::query("INSERT INTO retired_usernames(username,user_id) VALUES(lower($1),$2) ON CONFLICT DO NOTHING")
        .bind(&username)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE users SET deleted=true,username='deleted-'||id,display_name='',bio='',status_text='',chosen_status='offline',avatar_file_id=NULL,password_hash='',factor_version=gen_random_uuid()::text,email_version=gen_random_uuid()::text WHERE id=$1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    let rooms: Vec<(String, String)> = sqlx::query_as(
        "SELECT r.id,m.role FROM members m JOIN rooms r ON r.id=m.room_id WHERE m.user_id=$1 ORDER BY r.id FOR UPDATE OF r,m",
    )
    .bind(id)
    .fetch_all(&mut **tx)
    .await?;
    let mut heirs = Vec::new();
    for (room, role) in &rooms {
        if role == "owner" {
            // An ownerless room gets its earliest remaining active member.
            let heir: Option<String> = sqlx::query_scalar("UPDATE members SET role='owner' WHERE room_id=$1 AND user_id=(SELECT m.user_id FROM members m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 AND m.user_id<>$2 AND NOT EXISTS(SELECT 1 FROM members o WHERE o.room_id=$1 AND o.role='owner' AND o.user_id<>$2) ORDER BY u.disabled,m.joined_at,m.user_id LIMIT 1) RETURNING user_id")
                .bind(room).bind(id).fetch_optional(&mut **tx).await?;
            if let Some(heir) = heir {
                heirs.push(json!({"room_id":room,"user_id":heir}));
            }
        }
        sqlx::query("DELETE FROM members WHERE room_id=$1 AND user_id=$2")
            .bind(room)
            .bind(id)
            .execute(&mut **tx)
            .await?;
        sqlx::query("DELETE FROM snapshot_heads WHERE user_id IN (SELECT user_id FROM members WHERE room_id=$1) OR $1=ANY(room_ids)")
            .bind(room)
            .execute(&mut **tx)
            .await?;
        let position = store::next_position(tx).await?;
        store::event(
            tx,
            position,
            room,
            Some(id),
            Change::RoomRemoved {
                room_id: room.clone(),
            },
        )
        .await?;
        crate::room_details::publish(tx, room).await?;
    }
    operator::record(
        tx,
        "user.deleted",
        id,
        json!({"rooms":rooms.len(),"heirs":heirs}),
    )
    .await?;
    Ok(avatar)
}

#[derive(FromRow)]
struct RoomRow {
    id: String,
    kind: String,
    name: String,
    topic: String,
    read_only: bool,
    created_at: Option<DateTime<Utc>>,
    direct_pair: Option<String>,
    encrypted: bool,
    member_count: i64,
    message_count: i64,
    last_message_at: Option<DateTime<Utc>>,
}

/// All rooms, direct conversations included: metadata and counts, no content.
pub(crate) async fn rooms(
    app: &App,
    after: Option<&str>,
    size: Option<u32>,
    q: Option<&str>,
) -> Result<AdminRoomPage> {
    let size = limit(size)?;
    let (key, id) = cursor(after)?;
    let rows: Vec<RoomRow> = sqlx::query_as("SELECT r.id,r.kind,r.name,r.topic,r.read_only,r.created_at,r.direct_pair,EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=r.id) AS encrypted,(SELECT count(*) FROM members m WHERE m.room_id=r.id) AS member_count,(SELECT count(*) FROM messages m WHERE m.room_id=r.id AND NOT m.deleted AND m.system IS NULL)+(SELECT count(*) FROM e2ee_application_messages e WHERE e.room_id=r.id) AS message_count,GREATEST((SELECT max(m.created_at) FROM messages m WHERE m.room_id=r.id AND NOT m.deleted AND m.system IS NULL),(SELECT max(e.created_at) FROM e2ee_application_messages e WHERE e.room_id=r.id)) AS last_message_at FROM rooms r WHERE ($1::text IS NULL OR (r.name,r.id)>($1::text,$2::text)) AND ($3::text IS NULL OR strpos(lower(r.name),lower($3))>0) ORDER BY r.name,r.id LIMIT $4")
        .bind(key)
        .bind(id)
        .bind(search(q)?)
        .bind(size + 1)
        .fetch_all(&app.pool)
        .await?;
    let (rows, next) = page(rows, size, |r| cursor_after(&r.name, &r.id));
    let pairs: Vec<String> = rows
        .iter()
        .filter_map(|r| r.direct_pair.as_deref())
        .flat_map(|pair| pair.split(':').map(str::to_owned))
        .collect();
    let people: HashMap<String, User> = sqlx::query_as::<_, (String, String, String, bool)>(
        "SELECT id,username,display_name,deleted FROM users WHERE id=ANY($1)",
    )
    .bind(&pairs)
    .fetch_all(&app.pool)
    .await?
    .into_iter()
    .map(|(id, username, display_name, deleted)| {
        (id.clone(), wire_user(id, username, display_name, deleted))
    })
    .collect();
    let items = rows
        .into_iter()
        .map(|r| AdminRoom {
            kind: room_kind(&r.kind),
            direct_members: r
                .direct_pair
                .as_deref()
                .map(|pair| {
                    pair.split(':')
                        .filter_map(|id| people.get(id).cloned())
                        .collect()
                })
                .unwrap_or_default(),
            id: r.id,
            name: r.name,
            topic: (!r.topic.is_empty()).then_some(r.topic),
            member_count: count(r.member_count),
            message_count: count(r.message_count),
            last_message_at: r.last_message_at.map(|t| t.to_rfc3339()),
            created_at: r.created_at.map(|t| t.to_rfc3339()),
            read_only: r.read_only,
            encrypted: r.encrypted,
        })
        .collect();
    Ok(AdminRoomPage { items, next })
}

#[derive(FromRow)]
struct ReportRow {
    target: String,
    reason: String,
    created_at: DateTime<Utc>,
    id: String,
    username: String,
    display_name: String,
    deleted: bool,
}
/// The newest open reports of each target, at most 20 per target.
async fn reasons(
    app: &App,
    table: &str,
    column: &str,
    targets: &[String],
) -> Result<HashMap<String, Vec<AdminReport>>> {
    let rows: Vec<ReportRow> = sqlx::query_as(&format!("SELECT x.target,x.reason,x.created_at,a.id,a.username,a.display_name,a.deleted FROM (SELECT {column} AS target,reporter_id,reason,created_at,id AS report_id,row_number() OVER (PARTITION BY {column} ORDER BY id DESC) AS n FROM {table} WHERE closed_at IS NULL AND {column}=ANY($1)) x JOIN users a ON a.id=x.reporter_id WHERE x.n<=$2 ORDER BY x.target,x.report_id DESC"))
        .bind(targets)
        .bind(REPORTS_SHOWN)
        .fetch_all(&app.pool)
        .await?;
    let mut reports: HashMap<String, Vec<AdminReport>> = HashMap::new();
    for row in rows {
        reports.entry(row.target).or_default().push(AdminReport {
            reporter: wire_user(row.id, row.username, row.display_name, row.deleted),
            reason: row.reason,
            created_at: row.created_at.to_rfc3339(),
        });
    }
    Ok(reports)
}

/// Open reports by message, the most recently reported first. The text shown
/// is the one the newest reporter saw and disclosed, kept with the report, so
/// a later edit or deletion cannot hide what was reported.
pub(crate) async fn reported_messages(
    app: &App,
    after: Option<&str>,
    size: Option<u32>,
) -> Result<AdminReportedMessagePage> {
    #[derive(FromRow)]
    struct Row {
        message_id: String,
        report_count: i64,
        latest_id: i64,
        latest_at: DateTime<Utc>,
        room_id: String,
        room_kind: String,
        room_name: String,
        author_id: String,
        username: String,
        display_name: String,
        author_deleted: bool,
        author_revision: Option<String>,
        text: String,
        created_at: DateTime<Utc>,
        deleted: bool,
    }
    let size = limit(size)?;
    let rows: Vec<Row> = sqlx::query_as("WITH open AS (SELECT message_id,count(*) AS report_count,max(id) AS latest_id,max(created_at) AS latest_at,(array_agg(message_text ORDER BY id DESC))[1] AS text FROM message_reports WHERE closed_at IS NULL GROUP BY message_id) SELECT o.message_id,o.report_count,o.latest_id,o.latest_at,o.text,m.room_id,r.kind AS room_kind,r.name AS room_name,m.author_id,u.username,u.display_name,u.deleted AS author_deleted,CASE WHEN u.deleted THEN NULL ELSE u.activation_version END AS author_revision,m.created_at,m.deleted FROM open o JOIN messages m ON m.id=o.message_id JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=m.author_id WHERE ($1::bigint IS NULL OR o.latest_id<$1) ORDER BY o.latest_id DESC LIMIT $2")
        .bind(report_cursor(after)?)
        .bind(size + 1)
        .fetch_all(&app.pool)
        .await?;
    let (rows, next) = page(rows, size, |r| r.latest_id.to_string());
    let ids: Vec<String> = rows.iter().map(|r| r.message_id.clone()).collect();
    let mut reports = reasons(app, "message_reports", "message_id", &ids).await?;
    let items = rows
        .into_iter()
        .map(|r| AdminReportedMessage {
            reports: reports.remove(&r.message_id).unwrap_or_default(),
            message_id: r.message_id,
            room_id: r.room_id,
            room_kind: room_kind(&r.room_kind),
            room_name: r.room_name,
            author: wire_user(r.author_id, r.username, r.display_name, r.author_deleted),
            author_revision: r.author_revision,
            text: r.text,
            created_at: r.created_at.to_rfc3339(),
            deleted: r.deleted,
            report_count: count(r.report_count),
            latest_report_at: r.latest_at.to_rfc3339(),
        })
        .collect();
    Ok(AdminReportedMessagePage { items, next })
}

/// Open reports by account, the most recently reported first.
pub(crate) async fn reported_users(
    app: &App,
    after: Option<&str>,
    size: Option<u32>,
) -> Result<AdminReportedUserPage> {
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        user: UserRow,
        report_count: i64,
        latest_id: i64,
        latest_at: DateTime<Utc>,
    }
    let size = limit(size)?;
    let rows: Vec<Row> = sqlx::query_as(&format!("{PRESENCE}, open AS (SELECT user_id,count(*) AS report_count,max(id) AS latest_id,max(created_at) AS latest_at FROM user_reports WHERE closed_at IS NULL GROUP BY user_id) SELECT {USER_COLUMNS},o.report_count,o.latest_id,o.latest_at FROM open o JOIN users u ON u.id=o.user_id LEFT JOIN presence p ON p.user_id=u.id WHERE NOT u.deleted AND ($1::bigint IS NULL OR o.latest_id<$1) ORDER BY o.latest_id DESC LIMIT $2"))
        .bind(report_cursor(after)?)
        .bind(size + 1)
        .fetch_all(&app.pool)
        .await?;
    let (rows, next) = page(rows, size, |r| r.latest_id.to_string());
    let ids: Vec<String> = rows.iter().map(|r| r.user.id.clone()).collect();
    let mut reports = reasons(app, "user_reports", "user_id", &ids).await?;
    let items = rows
        .into_iter()
        .map(|r| AdminReportedUser {
            reports: reports.remove(&r.user.id).unwrap_or_default(),
            user: r.user.wire(),
            report_count: count(r.report_count),
            latest_report_at: r.latest_at.to_rfc3339(),
        })
        .collect();
    Ok(AdminReportedUserPage { items, next })
}

#[derive(Clone, Copy)]
pub(crate) enum Resolution {
    Dismiss,
    Delete,
}
/// Closes the open reports of a message, deleting it first if asked. Only a
/// reported message can be deleted this way; replays apply nothing.
pub(crate) async fn resolve_message(
    app: &App,
    actor: &Account,
    message: &str,
    operation: &str,
    resolution: Resolution,
) -> Result<()> {
    if !identifier(message) {
        return Err(Error::invalid());
    }
    let action = match resolution {
        Resolution::Dismiss => "dismissed",
        Resolution::Delete => "deleted",
    };
    let hash = fingerprint(json!(["admin.message_reports", message, action]));
    let (mut tx, replay) = admit(app, actor, true, operation, &hash).await?;
    if replay {
        tx.commit().await?;
        return Ok(());
    }
    let room: String = sqlx::query_scalar("SELECT room_id FROM messages WHERE id=$1")
        .bind(message)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::missing)?;
    // Room before message, the order of the members' own message commands. The
    // tombstone rotates the room's authority key: take that lock up front.
    sqlx::query("SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE")
        .bind(&room)
        .execute(&mut *tx)
        .await?;
    let row =
        sqlx::query_as::<_, MessageRow>(&format!("{MESSAGE_SELECT} WHERE m.id=$1 FOR UPDATE OF m"))
            .bind(message)
            .fetch_one(&mut *tx)
            .await?;
    let open: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM message_reports WHERE message_id=$1 AND closed_at IS NULL FOR UPDATE",
    )
    .bind(message)
    .fetch_all(&mut *tx)
    .await?;
    if open.is_empty() {
        return Err(Error::missing());
    }
    let erased = matches!(resolution, Resolution::Delete) && !row.deleted;
    if erased {
        message_actions::write(&mut tx, &room, message, &row, None, &[]).await?;
    }
    sqlx::query("UPDATE message_reports SET closed_at=clock_timestamp(),closed_by=$2,resolution=$3 WHERE message_id=$1 AND closed_at IS NULL")
        .bind(message)
        .bind(&actor.id)
        .bind(action)
        .execute(&mut *tx)
        .await?;
    operator::record(
        &mut tx,
        if erased {
            "message.moderated"
        } else {
            "message.reports_closed"
        },
        message,
        json!({"room_id":room,"author_id":row.author_id,"reports":open.len(),"resolution":action}),
    )
    .await?;
    settle(tx, actor, operation, &hash).await
}

pub(crate) async fn dismiss_user(
    app: &App,
    actor: &Account,
    user: &str,
    operation: &str,
) -> Result<()> {
    if !identifier(user) {
        return Err(Error::invalid());
    }
    let hash = fingerprint(json!(["admin.user_reports", user]));
    let (mut tx, replay) = admit(app, actor, true, operation, &hash).await?;
    if replay {
        tx.commit().await?;
        return Ok(());
    }
    let closed = sqlx::query("UPDATE user_reports SET closed_at=clock_timestamp(),closed_by=$2,resolution='dismissed' WHERE user_id=$1 AND closed_at IS NULL")
        .bind(user)
        .bind(&actor.id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if closed == 0 {
        return Err(Error::missing());
    }
    operator::record(
        &mut tx,
        "user.reports_closed",
        user,
        json!({"reports":closed,"resolution":"dismissed"}),
    )
    .await?;
    settle(tx, actor, operation, &hash).await
}

fn reason(input: &ReportInput) -> Result<&str> {
    let reason = input.reason.trim();
    if reason.is_empty() || reason.chars().count() > 1000 || reason.contains('\0') {
        return Err(Error::invalid());
    }
    Ok(reason)
}
fn self_report() -> Error {
    Error::new(StatusCode::CONFLICT, "self_report")
}

/// A member reports a message of a room it can read. Encrypted messages are
/// not in `messages`, so they cannot be reported (their text is private).
pub(crate) async fn report_message(
    app: &App,
    actor: &Account,
    message: &str,
    input: ReportInput,
) -> Result<()> {
    let text = reason(&input)?;
    if !identifier(message) {
        return Err(Error::invalid());
    }
    let hash = fingerprint(json!(["report.message", message, text]));
    let (mut tx, replay) = admit(app, actor, false, &input.operation_id, &hash).await?;
    if replay {
        tx.commit().await?;
        return Ok(());
    }
    let (room, author, deleted, system, snapshot): (String, String, bool, bool, String) =
        sqlx::query_as(
            "SELECT room_id,author_id,deleted,system IS NOT NULL,text FROM messages WHERE id=$1",
        )
        .bind(message)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::missing)?;
    store::require_member(&mut tx, &room, &actor.id).await?;
    if system {
        return Err(Error::forbidden());
    }
    if deleted {
        return Err(Error::new(StatusCode::GONE, "message_deleted"));
    }
    if author == actor.id {
        return Err(self_report());
    }
    crate::limits::message_action(&mut tx, &actor.id).await?;
    replace_report(&mut tx, Target::Message(&snapshot), message, actor, text).await?;
    operator::record(
        &mut tx,
        "message.reported",
        message,
        json!({"room_id":room,"author_id":author}),
    )
    .await?;
    settle(tx, actor, &input.operation_id, &hash).await
}

pub(crate) async fn report_user(
    app: &App,
    actor: &Account,
    user: &str,
    input: ReportInput,
) -> Result<()> {
    let text = reason(&input)?;
    if !identifier(user) {
        return Err(Error::invalid());
    }
    let hash = fingerprint(json!(["report.user", user, text]));
    let (mut tx, replay) = admit(app, actor, false, &input.operation_id, &hash).await?;
    if replay {
        tx.commit().await?;
        return Ok(());
    }
    if user == actor.id {
        return Err(self_report());
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND NOT deleted FOR KEY SHARE)",
    )
    .bind(user)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(Error::missing());
    }
    crate::limits::message_action(&mut tx, &actor.id).await?;
    replace_report(&mut tx, Target::User, user, actor, text).await?;
    operator::record(&mut tx, "user.reported", user, json!({})).await?;
    settle(tx, actor, &input.operation_id, &hash).await
}
enum Target<'a> {
    /// With the text the reporter sees now.
    Message(&'a str),
    User,
}
/// One open report per reporter and target: a new one replaces the old, so the
/// report ID still orders targets by their latest report. A reporter keeps at
/// most `OPEN_REPORTS` open; the message-action window serializes its reports.
async fn replace_report(
    tx: &mut Transaction<'_, Postgres>,
    target: Target<'_>,
    id: &str,
    actor: &Account,
    reason: &str,
) -> Result<()> {
    let (table, column) = match target {
        Target::Message(_) => ("message_reports", "message_id"),
        Target::User => ("user_reports", "user_id"),
    };
    sqlx::query(&format!(
        "DELETE FROM {table} WHERE {column}=$1 AND reporter_id=$2 AND closed_at IS NULL"
    ))
    .bind(id)
    .bind(&actor.id)
    .execute(&mut **tx)
    .await?;
    let open: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM message_reports WHERE reporter_id=$1 AND closed_at IS NULL)+(SELECT count(*) FROM user_reports WHERE reporter_id=$1 AND closed_at IS NULL)")
        .bind(&actor.id)
        .fetch_one(&mut **tx)
        .await?;
    if open >= OPEN_REPORTS {
        // Lifted only as administrators close reports: no meaningful delay to promise.
        return Err(Error::throttled("report_limit", 3600));
    }
    match target {
        Target::Message(text) => sqlx::query(
            "INSERT INTO message_reports(message_id,reporter_id,reason,message_text) VALUES($1,$2,$3,$4)",
        )
        .bind(id)
        .bind(&actor.id)
        .bind(reason)
        .bind(text),
        Target::User => {
            sqlx::query("INSERT INTO user_reports(user_id,reporter_id,reason) VALUES($1,$2,$3)")
                .bind(id)
                .bind(&actor.id)
                .bind(reason)
        }
    }
    .execute(&mut **tx)
    .await?;
    Ok(())
}
