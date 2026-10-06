//! Jitsi JWTs are minted only for current members, never stored in the journal.
use crate::{
    App, auth,
    error::{Error, Result},
};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, Utc};
use data_encoding::BASE64URL_NOPAD;
use hmac::{Hmac, Mac};
use rv_protocol::meetings::{JoinMeeting, Meeting, MeetingJoin, StartMeeting};
use serde::Deserialize;
use sha2::Sha256;
use sqlx::{Postgres, Transaction};
use std::{io::Read, path::Path};
use url::Url;
use zeroize::Zeroizing;

const TOKEN_SECONDS: i64 = 120;
const MEETING_HOURS: i64 = 2;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    url: String,
    app_id: String,
    secret: String,
}

/// Operator-owned HTTPS origin and shared HS256 secret. Intentionally no Debug.
pub struct Jitsi {
    url: Url,
    app_id: String,
    domain: String,
    secret: Zeroizing<Vec<u8>>,
    configuration_id: String,
}
impl Jitsi {
    pub fn from_file(path: &Path) -> std::result::Result<Self, &'static str> {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|_| "Cannot read RV_JITSI_CONFIG_FILE")?;
        if !metadata.is_file() || metadata.len() > 16 * 1024 {
            return Err("RV_JITSI_CONFIG_FILE must be a regular file of at most 16 KiB");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err("RV_JITSI_CONFIG_FILE must not be readable by group or others");
            }
        }
        let mut bytes = Zeroizing::new(Vec::new());
        std::fs::File::open(path)
            .map_err(|_| "Cannot read RV_JITSI_CONFIG_FILE")?
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read RV_JITSI_CONFIG_FILE")?;
        if bytes.len() > 16 * 1024 {
            return Err("RV_JITSI_CONFIG_FILE is oversized");
        }
        Self::parse(&bytes)
    }

    fn parse(bytes: &[u8]) -> std::result::Result<Self, &'static str> {
        let config: Configuration =
            serde_json::from_slice(bytes).map_err(|_| "Invalid RV_JITSI_CONFIG_FILE JSON")?;
        let secret = Zeroizing::new(config.secret.into_bytes());
        let url = Url::parse(&config.url).map_err(|_| "Invalid Jitsi HTTPS origin")?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(
                "Jitsi URL must be an HTTPS origin without credentials, path, query or fragment",
            );
        }
        if !(32..=1024).contains(&secret.len()) || !auth::identifier(&config.app_id) {
            return Err("Jitsi requires an app_id and a secret of 32 to 1024 bytes");
        }
        let domain = url.host_str().unwrap().to_ascii_lowercase();
        let configuration_id =
            auth::hash_token(&serde_json::json!([url.as_str(), config.app_id]).to_string());
        Ok(Self {
            url,
            app_id: config.app_id,
            domain,
            secret,
            configuration_id,
        })
    }

    fn public_url(&self, conference: &str) -> String {
        let mut url = self.url.clone();
        url.set_path(conference);
        url.into()
    }

    fn join(&self, actor: &auth::Account, row: Row) -> Result<MeetingJoin> {
        let now = Utc::now();
        if row.ended || row.expires_at <= now {
            return Err(ended());
        }
        let deadline = std::cmp::min(now + Duration::seconds(TOKEN_SECONDS), row.expires_at);
        let expires =
            DateTime::from_timestamp(deadline.timestamp(), 0).ok_or_else(Error::internal)?;
        if expires <= now {
            return Err(ended());
        }
        let header = BASE64URL_NOPAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let claims = serde_json::json!({
            "iss": self.app_id, "aud": "jitsi", "sub": self.domain,
            "room": row.conference, "exp": expires.timestamp(), "iat": now.timestamp(),
            "nbf": now.timestamp() - 5, "jti": auth::random_token(),
            "context": {"user": {"id": actor.id, "name": actor.display_name}}
        });
        let payload =
            BASE64URL_NOPAD.encode(&serde_json::to_vec(&claims).map_err(|_| Error::internal())?);
        let input = format!("{header}.{payload}");
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.secret).map_err(|_| Error::internal())?;
        mac.update(input.as_bytes());
        let token = Zeroizing::new(format!(
            "{input}.{}",
            BASE64URL_NOPAD.encode(&mac.finalize().into_bytes())
        ));
        let meeting = row.wire(self);
        let mut url = Url::parse(&meeting.public_url).map_err(|_| Error::internal())?;
        url.query_pairs_mut().append_pair("jwt", &token);
        Ok(MeetingJoin {
            meeting,
            url: url.into(),
            expires_at: expires.to_rfc3339(),
        })
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    room_id: String,
    created_by: String,
    conference: String,
    expires_at: DateTime<Utc>,
    ended: bool,
}
impl Row {
    fn wire(self, jitsi: &Jitsi) -> Meeting {
        Meeting {
            id: self.id,
            room_id: self.room_id,
            created_by: self.created_by,
            public_url: jitsi.public_url(&self.conference),
            expires_at: self.expires_at.to_rfc3339(),
            ended: self.ended || self.expires_at <= Utc::now(),
        }
    }
}
fn unavailable() -> Error {
    Error::new(StatusCode::SERVICE_UNAVAILABLE, "calls_unavailable")
}
fn ended() -> Error {
    Error::new(StatusCode::CONFLICT, "meeting_ended")
}
fn changed() -> Error {
    Error::new(StatusCode::CONFLICT, "membership_replaced")
}

async fn lock_scope(
    tx: &mut Transaction<'_, Postgres>,
    actor: &auth::Account,
    room: &str,
    membership: &str,
    epoch: &str,
) -> Result<(String, bool)> {
    auth::lock_active(tx, actor).await?;
    // Room exclusive lock serializes all starts, ends and membership changes.
    let found: Option<String> = sqlx::query_scalar("SELECT id FROM rooms WHERE id=$1 FOR UPDATE")
        .bind(room)
        .fetch_optional(&mut **tx)
        .await?;
    if found.is_none() {
        return Err(Error::missing());
    }
    let grant: Option<(String,String,bool)> = sqlx::query_as("SELECT m.role,s.membership_version,r.read_only FROM members m JOIN rooms r ON r.id=m.room_id JOIN room_read_states s ON s.room_id=m.room_id AND s.user_id=m.user_id WHERE m.room_id=$1 AND m.user_id=$2 FOR SHARE OF m,s")
        .bind(room).bind(&actor.id).fetch_optional(&mut **tx).await?;
    let (role, version, read_only) = grant.ok_or_else(Error::missing)?;
    if version != membership {
        return Err(changed());
    }
    let current: String =
        sqlx::query_scalar("SELECT data_epoch FROM instance WHERE singleton FOR KEY SHARE")
            .fetch_one(&mut **tx)
            .await?;
    if current != epoch {
        return Err(Error::new(StatusCode::CONFLICT, "data_epoch_changed"));
    }
    Ok((role, read_only))
}

pub async fn start(
    app: &App,
    actor: &auth::Account,
    room: &str,
    input: StartMeeting,
) -> Result<Meeting> {
    let jitsi = app.jitsi.as_ref().ok_or_else(unavailable)?;
    if !auth::identifier(room)
        || !auth::identifier(&input.operation_id)
        || !auth::identifier(&input.membership_version)
        || !auth::identifier(&input.data_epoch)
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let (role, read_only) = lock_scope(
        &mut tx,
        actor,
        room,
        &input.membership_version,
        &input.data_epoch,
    )
    .await?;
    let prior: Option<(String,String,String,String,String)> = sqlx::query_as("SELECT meeting_id,room_id,membership_version,data_epoch,configuration_id FROM meeting_operations WHERE user_id=$1 AND operation_id=$2")
        .bind(&actor.id).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
    if let Some((id, rid, grant, epoch, configuration)) = prior {
        if rid != room
            || grant != input.membership_version
            || epoch != input.data_epoch
            || configuration != jitsi.configuration_id
        {
            return Err(Error::conflict());
        }
        let row = sqlx::query_as::<_, Row>("SELECT * FROM meetings WHERE id=$1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(row.wire(jitsi));
    }
    if read_only && !matches!(role.as_str(), "owner" | "moderator") {
        return Err(Error::forbidden());
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM meeting_operations WHERE user_id=$1 AND created_at>clock_timestamp()-interval '1 day'")
        .bind(&actor.id).fetch_one(&mut *tx).await?;
    if count >= 256 {
        return Err(Error::throttled("meeting_limit", 60));
    }
    let active = sqlx::query_as::<_,Row>("SELECT * FROM meetings WHERE room_id=$1 AND data_epoch=$2 AND configuration_id=$3 AND NOT ended AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1")
        .bind(room).bind(&input.data_epoch).bind(&jitsi.configuration_id).fetch_optional(&mut *tx).await?;
    let row = match active {
        Some(row) => row,
        None => {
            let id = auth::random_token();
            let conference = format!("rv{}", auth::random_token());
            let row = sqlx::query_as::<_,Row>("INSERT INTO meetings(id,room_id,created_by,data_epoch,configuration_id,conference,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+make_interval(hours => $7)) RETURNING *")
                .bind(&id).bind(room).bind(&actor.id).bind(&input.data_epoch).bind(&jitsi.configuration_id).bind(conference).bind(MEETING_HOURS as i32).fetch_one(&mut *tx).await?;
            crate::system_messages::publish(
                &mut tx,
                actor,
                room,
                rv_protocol::system::SystemMessage::CallStarted { meeting_id: id },
            )
            .await?;
            row
        }
    };
    sqlx::query("INSERT INTO meeting_operations(user_id,operation_id,room_id,membership_version,data_epoch,configuration_id,meeting_id) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(&actor.id).bind(&input.operation_id).bind(room).bind(&input.membership_version).bind(&input.data_epoch).bind(&jitsi.configuration_id).bind(&row.id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(row.wire(jitsi))
}

async fn read(app: &App, actor: &auth::Account, id: &str) -> Result<Row> {
    let jitsi = app.jitsi.as_ref().ok_or_else(unavailable)?;
    if !auth::identifier(id) {
        return Err(Error::invalid());
    }
    sqlx::query_as("SELECT c.* FROM meetings c JOIN members m ON m.room_id=c.room_id AND m.user_id=$2 JOIN instance i ON i.singleton AND i.data_epoch=c.data_epoch WHERE c.id=$1 AND c.configuration_id=$3")
        .bind(id).bind(&actor.id).bind(&jitsi.configuration_id).fetch_optional(&app.pool).await?.ok_or_else(Error::missing)
}
pub async fn info(app: &App, actor: &auth::Account, id: &str) -> Result<Meeting> {
    Ok(read(app, actor, id)
        .await?
        .wire(app.jitsi.as_ref().ok_or_else(unavailable)?))
}
pub async fn join(
    app: &App,
    actor: &auth::Account,
    id: &str,
    input: JoinMeeting,
) -> Result<MeetingJoin> {
    if !auth::identifier(&input.membership_version) || !auth::identifier(&input.data_epoch) {
        return Err(Error::invalid());
    }
    let original = read(app, actor, id).await?;
    let mut tx = app.pool.begin().await?;
    lock_scope(
        &mut tx,
        actor,
        &original.room_id,
        &input.membership_version,
        &input.data_epoch,
    )
    .await?;
    let row: Row = sqlx::query_as("SELECT * FROM meetings WHERE id=$1 AND data_epoch=$2")
        .bind(id)
        .bind(&input.data_epoch)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::missing)?;
    let value = app
        .jitsi
        .as_ref()
        .ok_or_else(unavailable)?
        .join(actor, row)?;
    tx.commit().await?;
    Ok(value)
}
pub async fn end(
    app: &App,
    actor: &auth::Account,
    id: &str,
    input: JoinMeeting,
) -> Result<Meeting> {
    if !auth::identifier(&input.membership_version) || !auth::identifier(&input.data_epoch) {
        return Err(Error::invalid());
    }
    let original = read(app, actor, id).await?;
    let mut tx = app.pool.begin().await?;
    let (role, _) = lock_scope(
        &mut tx,
        actor,
        &original.room_id,
        &input.membership_version,
        &input.data_epoch,
    )
    .await?;
    if original.created_by != actor.id && !matches!(role.as_str(), "owner" | "moderator") {
        return Err(Error::forbidden());
    }
    let row: Row =
        sqlx::query_as("UPDATE meetings SET ended=true WHERE id=$1 AND data_epoch=$2 RETURNING *")
            .bind(id)
            .bind(&input.data_epoch)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(Error::missing)?;
    tx.commit().await?;
    Ok(row.wire(app.jitsi.as_ref().ok_or_else(unavailable)?))
}

/// Called after the room delivery lease: end and revocation both need its
/// exclusive room lock, so neither can overtake an accepted HTTP body.
pub(crate) async fn lock_delivery(
    tx: &mut Transaction<'_, Postgres>,
    app: &App,
    meeting: &Meeting,
    token_expiry: Option<&str>,
) -> Result<()> {
    let jitsi = app.jitsi.as_ref().ok_or_else(unavailable)?;
    let row: Row=sqlx::query_as("SELECT c.* FROM meetings c JOIN instance i ON i.singleton AND i.data_epoch=c.data_epoch WHERE c.id=$1 AND c.room_id=$2 AND c.configuration_id=$3 FOR SHARE OF c")
        .bind(&meeting.id).bind(&meeting.room_id).bind(&jitsi.configuration_id).fetch_optional(&mut **tx).await?.ok_or_else(Error::missing)?;
    if row.wire(jitsi) != *meeting {
        return Err(Error::new(StatusCode::CONFLICT, "delivery_revalidate"));
    }
    if let Some(expiry) = token_expiry {
        let expiry = DateTime::parse_from_rfc3339(expiry).map_err(|_| Error::internal())?;
        if meeting.ended || expiry <= Utc::now() {
            return Err(ended());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_rejects_unsafe_origins_and_invalid_secrets() {
        for url in [
            "http://meet.example.org",
            "https://u:p@meet.example.org",
            "https://meet.example.org/tenant/",
            "https://meet.example.org/?jwt=x",
            "https://meet.example.org/#x",
        ] {
            let config = serde_json::json!({"url":url,"app_id":"rv","secret":"a".repeat(32)});
            assert!(Jitsi::parse(&serde_json::to_vec(&config).unwrap()).is_err());
        }
        assert!(
            Jitsi::parse(br#"{"url":"https://meet.example.org","app_id":"rv","secret":"short"}"#)
                .is_err()
        );
        let config = serde_json::json!({"url":"https://meet.example.org:8443","app_id":"rv","secret":"a".repeat(32)});
        let jitsi = Jitsi::parse(&serde_json::to_vec(&config).unwrap()).unwrap();
        assert_eq!(
            jitsi.public_url("rvroom"),
            "https://meet.example.org:8443/rvroom"
        );
    }
}
