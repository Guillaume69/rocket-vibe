//! Profile mutations serialize per account. Public reads never include contact details.
use crate::{
    App,
    auth::{self, Account},
    delivery::ReadProof,
    error::{Error, Result},
    factors,
};
use axum::{
    body::Bytes,
    http::{StatusCode, header},
    response::Response,
};
use rv_protocol::{
    User,
    live::PresenceStatus,
    parity::{UserPreferences, UserProfile},
    profiles::{
        AvatarCommand, DesktopNotifications, OwnProfile, ProfileReceipt, UpdatePreferences,
        UpdateProfile,
    },
};
use sqlx::{Postgres, Transaction};
use std::io::Cursor;

pub const AVATAR_BYTES: usize = 2 * 1024 * 1024;
#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    username: String,
    display_name: String,
    bio: String,
    status_text: String,
    chosen_status: String,
    profile_version: String,
    avatar_file_id: Option<String>,
    preferences_version: String,
    preferred_language: String,
    clock_24h: bool,
    push_enabled: bool,
    push_mentions_only: bool,
    desktop_notifications: String,
    email: Option<String>,
    bot: bool,
    owner_id: Option<String>,
    owner_username: Option<String>,
    owner_display_name: Option<String>,
    owner_deleted: Option<bool>,
}
impl Row {
    fn profile(&self) -> UserProfile {
        UserProfile {
            user: User {
                id: self.id.clone(),
                username: self.username.clone(),
                display_name: self.display_name.clone(),
                bot: self.bot,
                ..Default::default()
            },
            revision: self.profile_version.clone(),
            bio: self.bio.clone(),
            status_text: self.status_text.clone(),
            status: status(&self.chosen_status),
            avatar_file_id: self.avatar_file_id.clone(),
            bot_owner: self.owner_id.clone().map(|id| User {
                id,
                username: self.owner_username.clone().unwrap_or_default(),
                display_name: self.owner_display_name.clone().unwrap_or_default(),
                deleted: self.owner_deleted.unwrap_or_default(),
                ..Default::default()
            }),
        }
    }
    fn own(self) -> OwnProfile {
        OwnProfile {
            profile: self.profile(),
            preferences: UserPreferences {
                revision: self.preferences_version,
                language: self.preferred_language,
                clock_24h: self.clock_24h,
                push_enabled: self.push_enabled,
                push_mentions_only: self.push_mentions_only,
                desktop_notifications: match self.desktop_notifications.as_str() {
                    "all" => DesktopNotifications::All,
                    "mention" => DesktopNotifications::Mention,
                    "nothing" => DesktopNotifications::Nothing,
                    _ => DesktopNotifications::Default,
                },
            },
            email: self.email,
        }
    }
}
// A bot's profile names its owner (RFC 0003).
const SELECT: &str = "SELECT u.*,e.address AS email,o.id AS owner_id,o.username AS owner_username,o.display_name AS owner_display_name,o.deleted AS owner_deleted FROM users u LEFT JOIN account_emails e ON e.user_id=u.id LEFT JOIN bots b ON b.user_id=u.id LEFT JOIN users o ON o.id=b.owner_id WHERE u.id=$1 AND NOT u.disabled";
const PUBLIC_SELECT: &str = "SELECT u.*,NULL::text AS email,o.id AS owner_id,o.username AS owner_username,o.display_name AS owner_display_name,o.deleted AS owner_deleted FROM users u LEFT JOIN bots b ON b.user_id=u.id LEFT JOIN users o ON o.id=b.owner_id WHERE u.id=$1 AND NOT u.disabled";
pub(crate) fn status(value: &str) -> PresenceStatus {
    match value {
        "away" => PresenceStatus::Away,
        "busy" => PresenceStatus::Busy,
        "offline" => PresenceStatus::Offline,
        _ => PresenceStatus::Online,
    }
}
pub(crate) fn status_name(value: PresenceStatus) -> &'static str {
    match value {
        PresenceStatus::Online => "online",
        PresenceStatus::Away => "away",
        PresenceStatus::Busy => "busy",
        PresenceStatus::Offline => "offline",
    }
}
fn notification_name(value: DesktopNotifications) -> &'static str {
    match value {
        DesktopNotifications::All => "all",
        DesktopNotifications::Mention => "mention",
        DesktopNotifications::Nothing => "nothing",
        DesktopNotifications::Default => "default",
    }
}

pub(crate) async fn own(app: &App, actor: &Account) -> Result<OwnProfile> {
    let row: Row = sqlx::query_as(SELECT)
        .bind(&actor.id)
        .fetch_one(&app.pool)
        .await?;
    Ok(row.own())
}
pub(crate) async fn public(app: &App, id: &str) -> Result<UserProfile> {
    if !auth::identifier(id) {
        return Err(Error::invalid());
    }
    let row: Row = sqlx::query_as(PUBLIC_SELECT)
        .bind(id)
        .fetch_optional(&app.pool)
        .await?
        .ok_or_else(Error::missing)?;
    Ok(row.profile())
}
pub(crate) async fn lookup(app: &App, username: &str) -> Result<UserProfile> {
    if !auth::identifier(username) {
        return Err(Error::invalid());
    }
    let id: String = sqlx::query_scalar("SELECT id FROM users WHERE username=$1 AND NOT disabled")
        .bind(username)
        .fetch_optional(&app.pool)
        .await?
        .ok_or_else(Error::missing)?;
    public(app, &id).await
}

async fn replay(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    operation: &str,
    hash: &str,
) -> Result<Option<ProfileReceipt>> {
    let old:Option<(String,String)>=sqlx::query_as("SELECT command_hash,applied_revision FROM profile_commands WHERE user_id=$1 AND operation_id=$2").bind(&actor.id).bind(operation).fetch_optional(&mut **tx).await?;
    old.map(|(saved, revision)| {
        if saved == hash {
            Ok(ProfileReceipt {
                operation_id: operation.into(),
                applied_revision: revision,
            })
        } else {
            Err(Error::conflict())
        }
    })
    .transpose()
}
async fn admission(tx: &mut Transaction<'_, Postgres>, actor: &Account) -> Result<()> {
    let (count,retry):(i32,i64)=sqlx::query_as("INSERT INTO profile_windows(user_id,attempts,expires_at) VALUES($1,1,clock_timestamp()+interval '60 seconds') ON CONFLICT(user_id) DO UPDATE SET attempts=CASE WHEN profile_windows.expires_at<=clock_timestamp() THEN 1 ELSE profile_windows.attempts+1 END,expires_at=CASE WHEN profile_windows.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '60 seconds' ELSE profile_windows.expires_at END RETURNING attempts,GREATEST(1,ceil(extract(epoch FROM expires_at-clock_timestamp())))::bigint").bind(&actor.id).fetch_one(&mut **tx).await?;
    if count > 20 {
        return Err(Error::throttled("profile_rate_limited", retry as u64));
    }
    Ok(())
}
async fn receipt(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    operation: &str,
    hash: &str,
    revision: String,
) -> Result<ProfileReceipt> {
    sqlx::query("INSERT INTO profile_commands(user_id,operation_id,command_hash,applied_revision) VALUES($1,$2,$3,$4)").bind(&actor.id).bind(operation).bind(hash).bind(&revision).execute(&mut **tx).await?;
    Ok(ProfileReceipt {
        operation_id: operation.into(),
        applied_revision: revision,
    })
}
fn identifiers(operation: &str, expected: &str) -> Result<()> {
    if !auth::identifier(operation) || !auth::identifier(expected) {
        return Err(Error::invalid());
    }
    Ok(())
}
fn fingerprint<T: serde::Serialize>(kind: &str, input: &T) -> Result<String> {
    Ok(auth::hash_token(
        &serde_json::to_string(&(kind, input)).map_err(|_| Error::internal())?,
    ))
}
fn revision_conflict() -> Error {
    Error::new(StatusCode::CONFLICT, "revision_conflict")
}

pub(crate) async fn update(
    app: &App,
    actor: &Account,
    input: UpdateProfile,
) -> Result<ProfileReceipt> {
    identifiers(&input.operation_id, &input.expected_revision)?;
    if !auth::identifier(&input.username)
        || input.display_name.trim().is_empty()
        || input.display_name.len() > 256
        || input.display_name.chars().any(char::is_control)
        || input.bio.len() > 4096
        || input.status_text.len() > 512
        || input.bio.contains('\0')
        || input.status_text.chars().any(char::is_control)
    {
        return Err(Error::invalid());
    }
    let hash = fingerprint("profile", &input)?;
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    if let Some(saved) = replay(&mut tx, actor, &input.operation_id, &hash).await? {
        tx.commit().await?;
        return Ok(saved);
    }
    let (version, username): (String, String) =
        sqlx::query_as("SELECT profile_version,username FROM users WHERE id=$1")
            .bind(&actor.id)
            .fetch_one(&mut *tx)
            .await?;
    if version != input.expected_revision {
        return Err(revision_conflict());
    }
    if username != input.username {
        if auth::reserved_username(&input.username) {
            return Err(Error::invalid());
        }
        factors::recent(&mut tx, actor).await?;
    }
    admission(&mut tx, actor).await?;
    let result:std::result::Result<String,sqlx::Error>=sqlx::query_scalar("UPDATE users SET username=$2,display_name=$3,bio=$4,chosen_status=$5,status_text=$6 WHERE id=$1 RETURNING profile_version")
        .bind(&actor.id).bind(input.username).bind(input.display_name.trim()).bind(input.bio).bind(status_name(input.status)).bind(input.status_text).fetch_one(&mut *tx).await;
    let revision = match result {
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(Error::new(StatusCode::CONFLICT, "username_taken"));
        }
        other => other?,
    };
    // The chosen status applies to all active devices; their next lease refresh
    // also reads it, so a stale client cannot restore an old status.
    if input.status == PresenceStatus::Offline {
        sqlx::query("DELETE FROM presence_leases WHERE user_id=$1")
            .bind(&actor.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM typing_leases WHERE user_id=$1")
            .bind(&actor.id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("UPDATE presence_leases SET status=$2 WHERE user_id=$1")
            .bind(&actor.id)
            .bind(status_name(input.status))
            .execute(&mut *tx)
            .await?;
    }
    let saved = receipt(&mut tx, actor, &input.operation_id, &hash, revision).await?;
    tx.commit().await?;
    Ok(saved)
}

pub(crate) async fn preferences(
    app: &App,
    actor: &Account,
    input: UpdatePreferences,
) -> Result<ProfileReceipt> {
    identifiers(&input.operation_id, &input.expected_revision)?;
    if !["auto", "fr", "en"].contains(&input.language.as_str()) {
        return Err(Error::invalid());
    }
    let hash = fingerprint("preferences", &input)?;
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    if let Some(saved) = replay(&mut tx, actor, &input.operation_id, &hash).await? {
        tx.commit().await?;
        return Ok(saved);
    }
    let version: String = sqlx::query_scalar("SELECT preferences_version FROM users WHERE id=$1")
        .bind(&actor.id)
        .fetch_one(&mut *tx)
        .await?;
    if version != input.expected_revision {
        return Err(revision_conflict());
    }
    admission(&mut tx, actor).await?;
    let revision:String=sqlx::query_scalar("UPDATE users SET preferred_language=$2,clock_24h=$3,push_enabled=$4,push_mentions_only=$5,desktop_notifications=$6 WHERE id=$1 RETURNING preferences_version")
        .bind(&actor.id).bind(input.language).bind(input.clock_24h).bind(input.push_enabled).bind(input.push_mentions_only).bind(notification_name(input.desktop_notifications)).fetch_one(&mut *tx).await?;
    let saved = receipt(&mut tx, actor, &input.operation_id, &hash, revision).await?;
    tx.commit().await?;
    Ok(saved)
}

pub(crate) async fn avatar(
    app: &App,
    actor: &Account,
    input: AvatarCommand,
    upload: Option<(String, Bytes)>,
) -> Result<ProfileReceipt> {
    identifiers(&input.operation_id, &input.expected_revision)?;
    let store = app
        .objects
        .as_ref()
        .ok_or_else(|| Error::new(StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"))?;
    let content_hash = upload.as_ref().map(|(mime, bytes)| {
        use sha2::{Digest, Sha256};
        (mime.clone(), format!("{:x}", Sha256::digest(bytes)))
    });
    let hash = fingerprint("avatar", &(&input, content_hash))?;
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    if let Some(saved) = replay(&mut tx, actor, &input.operation_id, &hash).await? {
        tx.commit().await?;
        return Ok(saved);
    }
    let version: String = sqlx::query_scalar("SELECT profile_version FROM users WHERE id=$1")
        .bind(&actor.id)
        .fetch_one(&mut *tx)
        .await?;
    if version != input.expected_revision {
        return Err(revision_conflict());
    }
    admission(&mut tx, actor).await?;
    // Reserve CPU budget durably even for malformed images. Do not retain a
    // database/account lock while a decoder runs on the bounded blocking pool.
    tx.commit().await?;
    let encoded = match upload {
        None => None,
        Some((mime, bytes)) => {
            let permit = app
                .image_slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| Error::throttled("avatar_busy", 1))?;
            let encoded = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                decode_avatar(&mime, &bytes)
            })
            .await
            .map_err(|_| Error::internal())??;
            Some(encoded)
        }
    };
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    if let Some(saved) = replay(&mut tx, actor, &input.operation_id, &hash).await? {
        tx.commit().await?;
        return Ok(saved);
    }
    let (version, previous): (String, Option<String>) =
        sqlx::query_as("SELECT profile_version,avatar_file_id FROM users WHERE id=$1")
            .bind(&actor.id)
            .fetch_one(&mut *tx)
            .await?;
    if version != input.expected_revision {
        return Err(revision_conflict());
    }
    let id = match encoded {
        Some(bytes) => Some(store.put(bytes).await?),
        None => None,
    };
    let revision: String = sqlx::query_scalar(
        "UPDATE users SET avatar_file_id=$2 WHERE id=$1 RETURNING profile_version",
    )
    .bind(&actor.id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    let saved = receipt(&mut tx, actor, &input.operation_id, &hash, revision).await?;
    tx.commit().await?;
    if let Some(id) = previous {
        let _ = store.remove(&id).await;
    }
    Ok(saved)
}
pub(crate) fn decode_avatar(mime: &str, bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.is_empty() || bytes.len() > AVATAR_BYTES {
        return Err(Error::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "avatar_too_large",
        ));
    }
    let format = match mime {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        _ => {
            return Err(Error::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "invalid_avatar",
            ));
        }
    };
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(2048);
    limits.max_image_height = Some(2048);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| Error::new(StatusCode::BAD_REQUEST, "invalid_avatar"))?;
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err(Error::invalid());
    }
    // Re-encode to strip metadata, appended payloads, and arbitrary input formats.
    let rgba = if decoded.width() > 512 || decoded.height() > 512 {
        decoded.thumbnail(512, 512)
    } else {
        decoded
    }
    .into_rgba8();
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| Error::internal())?;
    let output = output.into_inner();
    if output.len() > AVATAR_BYTES {
        return Err(Error::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "avatar_too_large",
        ));
    }
    Ok(output)
}

pub(crate) async fn avatar_response(
    app: &App,
    hash: &str,
    proof: &ReadProof,
    id: &str,
) -> Result<Response> {
    let store = app
        .objects
        .as_ref()
        .ok_or_else(|| Error::new(StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"))?;
    let user: Option<String> =
        sqlx::query_scalar("SELECT id FROM users WHERE avatar_file_id=$1 AND NOT disabled")
            .bind(id)
            .fetch_optional(&app.pool)
            .await?;
    let user = user.ok_or_else(Error::missing)?;
    let bytes = store.read(id, AVATAR_BYTES as u64).await?;
    let mut lease = proof.lock(app, hash, &[], None).await?;
    let current:Option<String>=sqlx::query_scalar("SELECT avatar_file_id FROM users WHERE id=$1 AND NOT disabled AND avatar_file_id=$2 FOR SHARE").bind(user).bind(id).fetch_optional(&mut *lease).await?;
    if current.as_deref() != Some(id) {
        return Err(Error::missing());
    }
    let mut response = crate::delivery::leased_bytes(bytes.into(), lease, "image/png");
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    Ok(response)
}

/// A profile changed during construction must be refetched, never submitted as current.
pub(crate) async fn response(
    app: &App,
    hash: &str,
    proof: &ReadProof,
    profile: &UserProfile,
    value: &impl serde::Serialize,
    preferences: Option<&str>,
) -> Result<Response> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::internal())?;
    let mut lease = proof.lock(app, hash, &[], None).await?;
    let current:Option<(String,String)>=sqlx::query_as("SELECT profile_version,preferences_version FROM users WHERE id=$1 AND NOT disabled FOR SHARE").bind(&profile.user.id).fetch_optional(&mut *lease).await?;
    if !current.is_some_and(|(p, s)| p == profile.revision && preferences.is_none_or(|v| v == s)) {
        return Err(Error::new(StatusCode::CONFLICT, "delivery_revalidate"));
    }
    let mut response = crate::delivery::leased_bytes(bytes.into(), lease, "application/json");
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(response)
}
