//! Bot accounts (RFC 0003, `docs/rfcs/0003-bots.md`). A bot is a `users` row
//! owned by a person; each API key is a session of its own device, so every
//! existing check applies to it. The gate below decides which routes a key may
//! reach, by scope; everything else is closed to it.
use crate::{
    App,
    admin::{admit, fingerprint, settle},
    auth::{self, Account, random_token},
    error::{Error, Result},
    operator,
};
use axum::{
    extract::{MatchedPath, Request, State},
    http::{Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use rv_protocol::{
    User,
    bots::{
        BOTS_PER_OWNER, Bot, BotKey, BotKeyCreated, BotKeyList, BotList, BotScope, CreateBot,
        CreateBotKey, DESCRIPTION_BYTES, InstanceSettings, KEY_DAYS, KEYS_PER_BOT, LABEL_BYTES,
        UpdateBot, UpdateInstanceSettings,
    },
};
use serde_json::json;
use sqlx::{FromRow, Postgres, Transaction};

use BotScope::*;

/// `(method, matched route, scope)`; `None` is open to every key. A route
/// missing here is closed to keys: new routes stay closed until listed.
const ROUTES: &[(&str, &str, Option<BotScope>)] = &[
    ("GET", "/api/v1/me", None),
    ("PATCH", "/api/v1/me", None),
    ("GET", "/api/v1/me/profile", None),
    ("PUT", "/api/v1/me/avatar", None),
    ("DELETE", "/api/v1/me/avatar", None),
    ("GET", "/api/v1/me/permissions", None),
    ("GET", "/api/v1/emoji", None),
    ("GET", "/api/v1/emoji/files/{id}", None),
    ("GET", "/api/v1/avatars/{id}", None),
    ("GET", "/api/v1/bots/reference", None),
    ("GET", "/api/v1/rooms", Some(RoomsRead)),
    ("GET", "/api/v1/rooms/{room}", Some(RoomsRead)),
    ("GET", "/api/v1/rooms/{room}/members", Some(RoomsRead)),
    ("GET", "/api/v1/rooms/{room}/permissions", Some(RoomsRead)),
    ("GET", "/api/v1/rooms/{room}/messages", Some(RoomsRead)),
    (
        "GET",
        "/api/v1/rooms/{room}/messages/search",
        Some(RoomsRead),
    ),
    ("GET", "/api/v1/rooms/{room}/pins", Some(RoomsRead)),
    ("GET", "/api/v1/messages/{message}", Some(RoomsRead)),
    (
        "GET",
        "/api/v1/messages/{message}/permissions",
        Some(RoomsRead),
    ),
    ("GET", "/api/v1/messages/{message}/thread", Some(RoomsRead)),
    ("GET", "/api/v1/messages/{message}/replies", Some(RoomsRead)),
    (
        "GET",
        "/api/v1/messages/{message}/previews/{id}",
        Some(RoomsRead),
    ),
    ("GET", "/api/v1/files/{id}", Some(RoomsRead)),
    ("GET", "/api/v1/sync/snapshot", Some(RoomsRead)),
    ("POST", "/api/v1/sync/snapshots", Some(RoomsRead)),
    ("GET", "/api/v1/sync/snapshots/{token}", Some(RoomsRead)),
    ("GET", "/api/v1/sync/changes", Some(RoomsRead)),
    ("POST", "/api/v1/sync/ticket", Some(RoomsRead)),
    ("GET", "/api/v1/live", Some(RoomsRead)),
    ("POST", "/api/v1/rooms/{room}/messages", Some(MessagesWrite)),
    (
        "POST",
        "/api/v1/messages/{message}/replies",
        Some(MessagesWrite),
    ),
    ("PATCH", "/api/v1/messages/{message}", Some(MessagesWrite)),
    ("DELETE", "/api/v1/messages/{message}", Some(MessagesWrite)),
    ("PUT", "/api/v1/rooms/{room}/typing", Some(MessagesWrite)),
    ("POST", "/api/v1/uploads", Some(FilesWrite)),
    ("GET", "/api/v1/uploads/{id}", Some(FilesWrite)),
    ("DELETE", "/api/v1/uploads/{id}", Some(FilesWrite)),
    ("PUT", "/api/v1/uploads/{id}/bytes", Some(FilesWrite)),
    ("POST", "/api/v1/uploads/{id}/complete", Some(FilesWrite)),
    (
        "PUT",
        "/api/v1/messages/{message}/reactions",
        Some(ReactionsWrite),
    ),
    ("GET", "/api/v1/rooms/public", Some(RoomsJoin)),
    ("GET", "/api/v1/rooms/discover", Some(RoomsJoin)),
    ("POST", "/api/v1/rooms/{room}/join", Some(RoomsJoin)),
    ("POST", "/api/v1/rooms/{room}/leave", Some(RoomsJoin)),
    ("GET", "/api/v1/users", Some(UsersRead)),
    ("GET", "/api/v1/users/lookup", Some(UsersRead)),
    ("GET", "/api/v1/users/{id}", Some(UsersRead)),
    ("POST", "/api/v1/direct-messages", Some(DmWrite)),
];

pub(crate) const SENDS_PER_MINUTE: i32 = 60;
pub(crate) const DIRECT_PER_MINUTE: i32 = 10;

/// The gate's own table, grouped by scope in the order of `BotScope::ALL`.
pub(crate) fn reference() -> rv_protocol::bots::BotReference {
    use rv_protocol::bots::{BotRoute, BotScopeRoutes};
    let group = |scope: Option<BotScope>| BotScopeRoutes {
        scope,
        routes: ROUTES
            .iter()
            .filter(|(_, _, s)| *s == scope)
            .map(|(method, path, _)| BotRoute {
                method: (*method).into(),
                path: (*path).into(),
            })
            .collect(),
    };
    rv_protocol::bots::BotReference {
        key_prefix: rv_protocol::bots::KEY_PREFIX.into(),
        groups: std::iter::once(group(None))
            .chain(BotScope::ALL.into_iter().map(|s| group(Some(s))))
            .collect(),
        sends_per_minute: SENDS_PER_MINUTE as u32,
        direct_per_minute: DIRECT_PER_MINUTE as u32,
    }
}

/// `None`: never open to a key. `Some(None)`: open to every key.
pub(crate) fn route_scope(method: &Method, path: &str) -> Option<Option<BotScope>> {
    ROUTES
        .iter()
        .find(|(m, p, _)| *p == path && method.as_str() == *m)
        .map(|(_, _, scope)| *scope)
}

fn bearer_key(request: &Request) -> Option<&str> {
    request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|token| token.starts_with(rv_protocol::bots::KEY_PREFIX))
}

/// Route layer: a person's token passes untouched; a key reaches only the
/// routes of its granted scopes. Runs after routing, on the matched template.
pub(crate) async fn gate(State(app): State<App>, request: Request, next: Next) -> Response {
    let Some(token) = bearer_key(&request) else {
        return next.run(request).await;
    };
    if !rv_protocol::bots::is_key(token) {
        return Error::unauthorized().into_response();
    }
    let path = request
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_default();
    let Some(scope) = route_scope(request.method(), &path) else {
        return Error::new(StatusCode::FORBIDDEN, "bot_forbidden").into_response();
    };
    // The key's last use is recorded here, at most once a minute: the device's
    // own last_seen_at moves only every five minutes.
    let scopes: Option<Vec<String>> = match sqlx::query_scalar("WITH k AS (SELECT s.device_id,b.scopes FROM sessions s JOIN bots b ON b.user_id=s.user_id JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled), touched AS (UPDATE bot_keys SET last_used_at=clock_timestamp() WHERE device_id=(SELECT device_id FROM k) AND (last_used_at IS NULL OR last_used_at<clock_timestamp()-interval '1 minute')) SELECT scopes FROM k")
        .bind(auth::hash_token(token))
        .fetch_optional(&app.pool)
        .await
    {
        Ok(scopes) => scopes,
        Err(error) => return Error::from(error).into_response(),
    };
    let Some(scopes) = scopes else {
        return Error::unauthorized().into_response();
    };
    if scope.is_some_and(|scope| !scopes.iter().any(|s| s == scope.as_str())) {
        return Error::new(StatusCode::FORBIDDEN, "bot_scope_missing").into_response();
    }
    next.run(request).await
}

/// Per-bot budget over a 60-second window; a refusal rolls back with its
/// transaction, so it never extends the window.
pub(crate) async fn budget(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    kind: &'static str,
    max: i32,
) -> Result<()> {
    if !actor.bot {
        return Ok(());
    }
    let (attempts, retry): (i32, i64) = sqlx::query_as("INSERT INTO bot_windows(user_id,kind,attempts,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '60 seconds') ON CONFLICT(user_id,kind) DO UPDATE SET attempts=CASE WHEN bot_windows.expires_at<=clock_timestamp() THEN 1 ELSE bot_windows.attempts+1 END,expires_at=CASE WHEN bot_windows.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '60 seconds' ELSE bot_windows.expires_at END RETURNING attempts,GREATEST(1,ceil(extract(epoch from expires_at-clock_timestamp())))::bigint")
        .bind(&actor.id)
        .bind(kind)
        .fetch_one(&mut **tx)
        .await?;
    if attempts > max {
        return Err(Error::throttled("bot_rate_limited", retry as u64));
    }
    Ok(())
}

/// Bots stay out of encrypted rooms: an MLS plan must represent every member
/// and a bot has no crypto device (RFC 0003 §8). Call under the room lock.
pub(crate) async fn refuse_encrypted(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    user: &str,
) -> Result<()> {
    let refused: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$2 AND bot) AND EXISTS(SELECT 1 FROM e2ee_groups WHERE room_id=$1)")
        .bind(room)
        .bind(user)
        .fetch_one(&mut **tx)
        .await?;
    if refused {
        return Err(Error::new(StatusCode::CONFLICT, "bot_encrypted_room"));
    }
    Ok(())
}

/// A group transition while an active bot is a member could never represent
/// it: refused with its own code, which the apps word.
pub(crate) async fn refuse_group(tx: &mut Transaction<'_, Postgres>, room: &str) -> Result<()> {
    let bot: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM members m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 AND u.bot AND NOT u.disabled)")
        .bind(room)
        .fetch_one(&mut **tx)
        .await?;
    if bot {
        return Err(Error::new(StatusCode::CONFLICT, "crypto_bot_member"));
    }
    Ok(())
}

#[derive(FromRow)]
struct BotRow {
    id: String,
    username: String,
    display_name: String,
    disabled: bool,
    avatar_file_id: Option<String>,
    owner_id: String,
    owner_username: String,
    owner_display_name: String,
    owner_deleted: bool,
    description: String,
    scopes: Vec<String>,
    created_at: DateTime<Utc>,
    live_keys: i64,
}

impl BotRow {
    fn wire(self) -> Bot {
        let mut scopes: Vec<BotScope> = self
            .scopes
            .iter()
            .filter_map(|s| BotScope::parse(s))
            .collect();
        scopes.sort();
        Bot {
            user: User {
                id: self.id,
                username: self.username,
                display_name: self.display_name,
                bot: true,
                ..Default::default()
            },
            owner: User {
                id: self.owner_id,
                username: self.owner_username,
                display_name: self.owner_display_name,
                deleted: self.owner_deleted,
                ..Default::default()
            },
            description: self.description,
            scopes,
            created_at: self.created_at.to_rfc3339(),
            disabled: self.disabled,
            avatar_file_id: self.avatar_file_id,
            live_keys: self.live_keys as u32,
        }
    }
}

const BOT_SELECT: &str = "SELECT u.id,u.username,u.display_name,u.disabled,u.avatar_file_id,o.id AS owner_id,o.username AS owner_username,o.display_name AS owner_display_name,o.deleted AS owner_deleted,b.description,b.scopes,b.created_at,(SELECT count(*) FROM bot_keys k JOIN sessions s ON s.device_id=k.device_id WHERE k.bot_id=b.user_id AND s.expires_at>now()) AS live_keys FROM bots b JOIN users u ON u.id=b.user_id JOIN users o ON o.id=b.owner_id WHERE NOT u.deleted";

async fn bot_in(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<Bot> {
    let row: BotRow = sqlx::query_as(&format!("{BOT_SELECT} AND b.user_id=$1"))
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(Error::missing)?;
    Ok(row.wire())
}

fn person(actor: &Account) -> Result<()> {
    // The gate already keeps keys away; a bot never manages bots.
    if actor.bot {
        return Err(Error::forbidden());
    }
    Ok(())
}

/// Locks a live bot the actor may manage: its owner, or an administrator.
/// Someone else's bot is answered as missing.
async fn managed(tx: &mut Transaction<'_, Postgres>, actor: &Account, id: &str) -> Result<bool> {
    if !auth::identifier(id) {
        return Err(Error::invalid());
    }
    let row: Option<(String, bool)> = sqlx::query_as("SELECT b.owner_id,u.disabled FROM bots b JOIN users u ON u.id=b.user_id WHERE b.user_id=$1 AND NOT u.deleted FOR UPDATE OF b")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
    match row {
        Some((owner, disabled)) if owner == actor.id || actor.admin => Ok(disabled),
        _ => Err(Error::missing()),
    }
}

fn clean_scopes(scopes: &[BotScope]) -> Vec<String> {
    let mut scopes = scopes.to_vec();
    scopes.sort();
    scopes.dedup();
    scopes.iter().map(|s| s.as_str().to_owned()).collect()
}

fn valid_description(value: &str) -> bool {
    value.len() <= DESCRIPTION_BYTES && !value.contains('\0')
}

pub(crate) async fn list(app: &App, actor: &Account, all: bool) -> Result<BotList> {
    person(actor)?;
    if all {
        crate::admin::require_admin(actor)?;
    }
    let rows: Vec<BotRow> = sqlx::query_as(&format!(
        "{BOT_SELECT} AND ($1 OR b.owner_id=$2) ORDER BY lower(u.username),u.id LIMIT 500"
    ))
    .bind(all)
    .bind(&actor.id)
    .fetch_all(&app.pool)
    .await?;
    Ok(BotList {
        bots: rows.into_iter().map(BotRow::wire).collect(),
    })
}

fn valid_display_name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

pub(crate) async fn create(app: &App, actor: &Account, input: CreateBot) -> Result<Bot> {
    person(actor)?;
    let display_name = input.display_name.trim();
    if !auth::identifier(&input.username)
        || auth::reserved_username(&input.username)
        || !valid_display_name(display_name)
        || !valid_description(&input.description)
    {
        return Err(Error::invalid());
    }
    let scopes = clean_scopes(&input.scopes);
    let hash = fingerprint(json!([
        "bot.create",
        input.username,
        display_name,
        input.description,
        scopes
    ]));
    let (mut tx, replay) = admit(app, actor, false, &input.operation_id, &hash).await?;
    if replay {
        let id: String =
            sqlx::query_scalar("SELECT user_id FROM bots WHERE owner_id=$1 AND operation_id=$2")
                .bind(&actor.id)
                .bind(&input.operation_id)
                .fetch_one(&mut *tx)
                .await?;
        let bot = bot_in(&mut tx, &id).await?;
        tx.commit().await?;
        return Ok(bot);
    }
    let user_bots: bool = sqlx::query_scalar("SELECT user_bots FROM instance WHERE singleton")
        .fetch_one(&mut *tx)
        .await?;
    if !actor.admin && !user_bots {
        return Err(Error::new(StatusCode::FORBIDDEN, "bots_disabled"));
    }
    // lock_active holds the owner row: concurrent creations queue here.
    let owned: i64 = sqlx::query_scalar("SELECT count(*) FROM bots b JOIN users u ON u.id=b.user_id WHERE b.owner_id=$1 AND NOT u.deleted")
        .bind(&actor.id)
        .fetch_one(&mut *tx)
        .await?;
    if owned >= BOTS_PER_OWNER {
        return Err(Error::new(StatusCode::CONFLICT, "bot_limit"));
    }
    let id = random_token()[..24].to_owned();
    // An empty password hash never verifies; sign-in skips bots anyway.
    let inserted = sqlx::query("INSERT INTO users(id,username,display_name,password_hash,bot,create_public_room,create_private_room) VALUES($1,$2,$3,'',true,false,false)")
        .bind(&id)
        .bind(&input.username)
        .bind(display_name)
        .execute(&mut *tx)
        .await;
    match inserted {
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(Error::new(StatusCode::CONFLICT, "username_taken"));
        }
        other => {
            other?;
        }
    }
    sqlx::query(
        "INSERT INTO bots(user_id,owner_id,description,scopes,operation_id) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(&id)
    .bind(&actor.id)
    .bind(&input.description)
    .bind(&scopes)
    .bind(&input.operation_id)
    .execute(&mut *tx)
    .await?;
    operator::record(
        &mut tx,
        "bot.created",
        &id,
        json!({"owner":actor.id,"username":input.username,"scopes":scopes}),
    )
    .await?;
    let bot = bot_in(&mut tx, &id).await?;
    settle(tx, actor, &input.operation_id, &hash).await?;
    Ok(bot)
}

pub(crate) async fn update(app: &App, actor: &Account, id: &str, input: UpdateBot) -> Result<Bot> {
    person(actor)?;
    let display_name = input.display_name.as_deref().map(str::trim);
    if input
        .description
        .as_deref()
        .is_some_and(|d| !valid_description(d))
        || display_name.is_some_and(|d| !valid_display_name(d))
    {
        return Err(Error::invalid());
    }
    let scopes = input.scopes.as_deref().map(clean_scopes);
    let hash = fingerprint(json!([
        "bot.update",
        id,
        display_name,
        input.description,
        scopes
    ]));
    let (mut tx, replay) = admit(app, actor, false, &input.operation_id, &hash).await?;
    if replay {
        let bot = bot_in(&mut tx, id).await?;
        tx.commit().await?;
        return Ok(bot);
    }
    managed(&mut tx, actor, id).await?;
    sqlx::query("UPDATE bots SET description=COALESCE($2,description),scopes=COALESCE($3,scopes) WHERE user_id=$1")
        .bind(id)
        .bind(&input.description)
        .bind(&scopes)
        .execute(&mut *tx)
        .await?;
    if let Some(name) = display_name {
        // The profile version rotates with it: the apps refresh the name.
        sqlx::query("UPDATE users SET display_name=$2 WHERE id=$1")
            .bind(id)
            .bind(name)
            .execute(&mut *tx)
            .await?;
    }
    operator::record(
        &mut tx,
        "bot.updated",
        id,
        json!({"display_name":display_name.is_some(),"description":input.description.is_some(),"scopes":scopes}),
    )
    .await?;
    let bot = bot_in(&mut tx, id).await?;
    settle(tx, actor, &input.operation_id, &hash).await?;
    Ok(bot)
}

/// Tombstones the bot like a deleted account: keys revoked, memberships left,
/// its messages kept under a deleted author. Repeating it answers the same.
pub(crate) async fn delete(app: &App, actor: &Account, id: &str) -> Result<()> {
    person(actor)?;
    let operation = random_token()[..32].to_owned();
    let hash = fingerprint(json!(["bot.delete", id]));
    let (mut tx, _) = crate::admin::admit_with(app, actor, true, false, &operation, &hash).await?;
    let gone: Option<(String, bool)> = sqlx::query_as(
        "SELECT b.owner_id,u.deleted FROM bots b JOIN users u ON u.id=b.user_id WHERE b.user_id=$1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    if gone.is_some_and(|(owner, deleted)| deleted && (owner == actor.id || actor.admin)) {
        tx.commit().await?;
        return Ok(());
    }
    managed(&mut tx, actor, id).await?;
    let revision: String = sqlx::query_scalar("SELECT activation_version FROM users WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let avatar = crate::admin::tombstone(&mut tx, id, &revision).await?;
    operator::record(&mut tx, "bot.deleted", id, json!({"owner":actor.id})).await?;
    settle(tx, actor, &operation, &hash).await?;
    if let (Some(store), Some(avatar)) = (&app.objects, avatar) {
        let _ = store.remove(&avatar).await;
    }
    Ok(())
}

/// The owner (or an administrator) sets or removes the bot's photo. Decoding
/// runs outside any transaction, on the bounded image pool, as for a person.
pub(crate) async fn avatar(
    app: &App,
    actor: &Account,
    id: &str,
    upload: Option<(String, axum::body::Bytes)>,
) -> Result<Bot> {
    person(actor)?;
    let store = app
        .objects
        .as_ref()
        .ok_or_else(|| Error::new(StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"))?;
    {
        let mut tx = app.pool.begin().await?;
        auth::lock_active(&mut tx, actor).await?;
        managed(&mut tx, actor, id).await?;
        tx.commit().await?;
    }
    let encoded = match upload {
        None => None,
        Some((mime, bytes)) => {
            let permit = app
                .image_slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| Error::throttled("avatar_busy", 1))?;
            Some(
                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    crate::profiles::decode_avatar(&mime, &bytes)
                })
                .await
                .map_err(|_| Error::internal())??,
            )
        }
    };
    let operation = random_token()[..32].to_owned();
    let hash = fingerprint(json!(["bot.avatar", id, operation]));
    let (mut tx, _) = admit(app, actor, false, &operation, &hash).await?;
    managed(&mut tx, actor, id).await?;
    let file = match encoded {
        Some(bytes) => Some(store.put(bytes).await?),
        None => None,
    };
    let previous: Option<String> =
        sqlx::query_scalar("SELECT avatar_file_id FROM users WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("UPDATE users SET avatar_file_id=$2 WHERE id=$1")
        .bind(id)
        .bind(&file)
        .execute(&mut *tx)
        .await?;
    operator::record(&mut tx, "bot.avatar", id, json!({"set":file.is_some()})).await?;
    let bot = bot_in(&mut tx, id).await?;
    settle(tx, actor, &operation, &hash).await?;
    if let Some(previous) = previous.filter(|p| file.as_ref() != Some(p)) {
        let _ = store.remove(&previous).await;
    }
    Ok(bot)
}

#[derive(FromRow)]
struct KeyRow {
    id: String,
    label: String,
    hint: String,
    created_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    last_used_at: Option<DateTime<Utc>>,
}

impl KeyRow {
    fn wire(self) -> BotKey {
        BotKey {
            id: self.id,
            label: self.label,
            hint: self.hint,
            created_at: self.created_at.to_rfc3339(),
            expires_at: self.expires_at.map(|t| t.to_rfc3339()),
            last_used_at: self.last_used_at.map(|t| t.to_rfc3339()),
        }
    }
}

const KEY_SELECT: &str = "SELECT k.id,k.label,k.hint,k.created_at,k.expires_at,k.last_used_at FROM bot_keys k JOIN sessions s ON s.device_id=k.device_id WHERE k.bot_id=$1 AND s.expires_at>now()";

pub(crate) async fn keys(app: &App, actor: &Account, id: &str) -> Result<BotKeyList> {
    person(actor)?;
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    managed(&mut tx, actor, id).await?;
    let rows: Vec<KeyRow> = sqlx::query_as(&format!("{KEY_SELECT} ORDER BY k.created_at,k.id"))
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(BotKeyList {
        keys: rows.into_iter().map(KeyRow::wire).collect(),
    })
}

/// The only time the key is shown. A replay cannot show it again and says so.
pub(crate) async fn create_key(
    app: &App,
    actor: &Account,
    id: &str,
    input: CreateBotKey,
) -> Result<BotKeyCreated> {
    person(actor)?;
    let label = input.label.trim();
    if label.is_empty()
        || label.len() > LABEL_BYTES
        || label.chars().any(char::is_control)
        || input
            .expires_in_days
            .is_some_and(|days| !(1..=KEY_DAYS).contains(&days))
    {
        return Err(Error::invalid());
    }
    let hash = fingerprint(json!(["bot.key", id, label, input.expires_in_days]));
    let (mut tx, replay) = admit(app, actor, false, &input.operation_id, &hash).await?;
    if replay {
        return Err(Error::new(StatusCode::CONFLICT, "bot_key_replayed"));
    }
    crate::factors::recent(&mut tx, actor).await?;
    if managed(&mut tx, actor, id).await? {
        return Err(Error::new(StatusCode::CONFLICT, "bot_disabled"));
    }
    let live: i64 = sqlx::query_scalar("SELECT count(*) FROM bot_keys k JOIN sessions s ON s.device_id=k.device_id WHERE k.bot_id=$1 AND s.expires_at>now()")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if live >= KEYS_PER_BOT {
        return Err(Error::new(StatusCode::CONFLICT, "bot_key_limit"));
    }
    let key = format!("{}{}", rv_protocol::bots::KEY_PREFIX, random_token());
    let key_id = random_token()[..24].to_owned();
    let device = random_token()[..32].to_owned();
    sqlx::query("INSERT INTO session_devices(id,user_id,label) VALUES($1,$2,$3)")
        .bind(&device)
        .bind(id)
        .bind(label)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO bot_keys(id,bot_id,device_id,label,hint,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(days=>$6))")
        .bind(&key_id)
        .bind(id)
        .bind(&device)
        .bind(label)
        .bind(&key[key.len() - 4..])
        .bind(input.expires_in_days.map(|d| d as i32))
        .execute(&mut *tx)
        .await?;
    // A key without expiry keeps a far session deadline: `sessions` needs one.
    sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at,device_id) VALUES($1,$2,COALESCE((SELECT expires_at FROM bot_keys WHERE id=$4),clock_timestamp()+interval '100 years'),$3)")
        .bind(auth::hash_token(&key))
        .bind(id)
        .bind(&device)
        .bind(&key_id)
        .execute(&mut *tx)
        .await?;
    operator::record(
        &mut tx,
        "bot.key_created",
        id,
        json!({"key":key_id,"label":label,"expires_in_days":input.expires_in_days}),
    )
    .await?;
    let info: KeyRow = sqlx::query_as(&format!("{KEY_SELECT} AND k.id=$2"))
        .bind(id)
        .bind(&key_id)
        .fetch_one(&mut *tx)
        .await?;
    settle(tx, actor, &input.operation_id, &hash).await?;
    Ok(BotKeyCreated {
        key,
        info: info.wire(),
    })
}

/// Revoking deletes the key's device: its session goes with it. Revoking a
/// key already gone answers the same.
pub(crate) async fn revoke_key(app: &App, actor: &Account, id: &str, key: &str) -> Result<()> {
    person(actor)?;
    if !auth::identifier(key) {
        return Err(Error::invalid());
    }
    let operation = random_token()[..32].to_owned();
    let hash = fingerprint(json!(["bot.revoke", id, key]));
    let (mut tx, _) = admit(app, actor, false, &operation, &hash).await?;
    managed(&mut tx, actor, id).await?;
    let revoked = sqlx::query("DELETE FROM session_devices WHERE id=(SELECT device_id FROM bot_keys WHERE id=$1 AND bot_id=$2)")
        .bind(key)
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if revoked > 0 {
        operator::record(&mut tx, "bot.key_revoked", id, json!({"key":key})).await?;
    }
    settle(tx, actor, &operation, &hash).await?;
    Ok(())
}

pub(crate) async fn settings(app: &App) -> Result<InstanceSettings> {
    let user_bots: bool = sqlx::query_scalar("SELECT user_bots FROM instance WHERE singleton")
        .fetch_one(&app.pool)
        .await?;
    Ok(InstanceSettings { user_bots })
}

pub(crate) async fn update_settings(
    app: &App,
    actor: &Account,
    input: UpdateInstanceSettings,
) -> Result<InstanceSettings> {
    let hash = fingerprint(json!(["instance.settings", input.user_bots]));
    let (mut tx, replay) = admit(app, actor, true, &input.operation_id, &hash).await?;
    if !replay {
        if let Some(user_bots) = input.user_bots {
            sqlx::query("UPDATE instance SET user_bots=$1 WHERE singleton")
                .bind(user_bots)
                .execute(&mut *tx)
                .await?;
        }
        operator::record(
            &mut tx,
            "instance.settings",
            "instance",
            json!({"user_bots":input.user_bots}),
        )
        .await?;
    }
    let user_bots: bool = sqlx::query_scalar("SELECT user_bots FROM instance WHERE singleton")
        .fetch_one(&mut *tx)
        .await?;
    if replay {
        tx.commit().await?;
    } else {
        settle(tx, actor, &input.operation_id, &hash).await?;
    }
    Ok(InstanceSettings { user_bots })
}

/// Operator CLI: the instance switch, without an acting account.
pub async fn set_user_bots(app: &App, user_bots: bool) -> Result<()> {
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    sqlx::query("UPDATE instance SET user_bots=$1 WHERE singleton")
        .bind(user_bots)
        .execute(&mut *tx)
        .await?;
    operator::record(
        &mut tx,
        "instance.settings",
        "instance",
        json!({"user_bots":user_bots}),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_route_table_has_no_duplicate_and_no_sensitive_route() {
        let mut seen = std::collections::HashSet::new();
        for (method, path, _) in ROUTES {
            assert!(seen.insert((method, path)), "{method} {path} listed twice");
            if *path == "/api/v1/bots/reference" {
                continue;
            }
            for closed in [
                "/api/v1/auth/",
                "/api/v1/admin/",
                "/api/v1/e2ee/",
                "/api/v1/bots",
                "/api/v1/me/sessions",
                "/api/v1/me/push",
                "/api/v1/me/factors",
                "/api/v1/me/email",
                "/api/v1/me/reauth",
                "/api/v1/voice/",
            ] {
                assert!(!path.starts_with(closed), "{path} must stay closed to keys");
            }
        }
    }

    #[test]
    fn scopes_open_their_routes_only() {
        assert_eq!(
            route_scope(&Method::POST, "/api/v1/rooms/{room}/messages"),
            Some(Some(MessagesWrite))
        );
        assert_eq!(route_scope(&Method::GET, "/api/v1/me"), Some(None));
        assert_eq!(route_scope(&Method::POST, "/api/v1/rooms"), None);
        assert_eq!(route_scope(&Method::POST, "/api/v1/auth/renew"), None);
    }

    #[test]
    fn the_reference_is_the_gate_table() {
        let reference = reference();
        let listed: usize = reference.groups.iter().map(|g| g.routes.len()).sum();
        assert_eq!(listed, ROUTES.len());
        assert_eq!(reference.groups.len(), BotScope::ALL.len() + 1);
        assert!(reference.groups.iter().all(|g| !g.routes.is_empty()));
    }
}
