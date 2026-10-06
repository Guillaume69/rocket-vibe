use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::http::HeaderMap;
use chrono::{DateTime, Utc};
use rand_core::{OsRng, RngCore};
use rv_protocol::{Session, User};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use std::net::IpAddr;

use crate::{
    App,
    error::{Error, Result},
};

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hash_token(token: &str) -> String {
    hash_token_bytes(token.as_bytes())
}
pub fn hash_token_bytes(token: &[u8]) -> String {
    Sha256::digest(token)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

pub fn bearer(headers: &HeaderMap) -> Result<String> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(Error::unauthorized)?;
    if token.len() != 64 {
        return Err(Error::unauthorized());
    }
    Ok(hash_token(token))
}

#[derive(Clone, FromRow)]
pub struct Account {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub admin: bool,
    pub(crate) session_hash: String,
    pub(crate) activation_version: String,
}

impl Account {
    pub fn user(&self) -> User {
        User {
            id: self.id.clone(),
            username: self.username.clone(),
            display_name: self.display_name.clone(),
        }
    }
}

pub async fn authenticate(app: &App, session_hash: &str) -> Result<Account> {
    // Approximate last activity, at most once per five minutes. Skip a device
    // already being rotated/revoked instead of holding up HTTP authentication.
    sqlx::query_as::<_, Account>("WITH seen AS (SELECT d.id FROM session_devices d JOIN sessions s ON s.device_id=d.id JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled AND d.last_seen_at<now()-interval '5 minutes' FOR UPDATE OF d SKIP LOCKED), touched AS (UPDATE session_devices d SET last_seen_at=GREATEST(d.last_seen_at,now()) FROM seen WHERE d.id=seen.id) SELECT u.id, u.username, u.display_name, u.admin,u.activation_version,s.token_hash AS session_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled")
        .bind(session_hash).fetch_optional(&app.pool).await?.ok_or_else(Error::unauthorized)
}

/// Authentication at HTTP admission is not enough for a delayed mutation.
/// Retain account/session locks through its commit, in user-then-session order.
pub(crate) async fn mutation_deadlines(tx: &mut Transaction<'_, Postgres>) -> Result<()> {
    // A mutation may legitimately wait for the five-second delivery lease.
    sqlx::query("SET LOCAL lock_timeout='6s'")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='8s'")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SET LOCAL idle_in_transaction_session_timeout='10s'")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(crate) async fn lock_active(
    tx: &mut Transaction<'_, Postgres>,
    account: &Account,
) -> Result<()> {
    mutation_deadlines(tx).await?;
    let user: Option<String> = sqlx::query_scalar(
        "SELECT activation_version FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE",
    )
    .bind(&account.id)
    .fetch_optional(&mut **tx)
    .await?;
    if user.is_none() {
        return Err(Error::unauthorized());
    }
    let expires: Option<DateTime<Utc>> = sqlx::query_scalar("SELECT expires_at FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE")
        .bind(&account.session_hash).bind(&account.id).fetch_optional(&mut **tx).await?;
    // now() is fixed at transaction start. Even clock_timestamp() in the row
    // predicate can precede a FOR SHARE wait without any concurrent row update.
    // Recheck the actual clock only AFTER both authorization locks are held.
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    if expires.is_none_or(|expires| expires <= now) {
        return Err(Error::unauthorized());
    }
    if user.as_deref() != Some(&account.activation_version) {
        return Err(Error::new(
            axum::http::StatusCode::CONFLICT,
            "delivery_revalidate",
        ));
    }
    Ok(())
}

/// A Rocket.Chat (Meteor) password hash: bcrypt over the lowercase SHA-256
/// hex digest of the password, which the web client used to send.
pub(crate) fn legacy_password_matches(password: &str, legacy: &str) -> bool {
    let digest: String = Sha256::digest(password.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    bcrypt::verify(digest, legacy).unwrap_or(false)
}

pub async fn create_user(app: &App, username: &str, password: String, admin: bool) -> Result<User> {
    if !identifier(username) || !(12..=1024).contains(&password.len()) {
        return Err(Error::invalid());
    }
    let password_hash = tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|v| v.to_string())
    })
    .await
    .map_err(|_| Error::internal())?
    .map_err(|_| Error::internal())?;
    let user = User {
        id: random_token()[..24].into(),
        username: username.into(),
        display_name: username.into(),
    };
    let mut tx = app.pool.begin().await?;
    mutation_deadlines(&mut tx).await?;
    let result = sqlx::query(
        "INSERT INTO users(id,username,display_name,password_hash,admin) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(&user.id)
    .bind(&user.username)
    .bind(&user.display_name)
    .bind(password_hash)
    .bind(admin)
    .execute(&mut *tx)
    .await;
    match result {
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Err(Error::conflict()),
        Err(e) => Err(e.into()),
        Ok(_) => {
            crate::operator::record(
                &mut tx,
                "user.created",
                &user.id,
                serde_json::json!({"user":user,"admin":admin}),
            )
            .await?;
            tx.commit().await?;
            Ok(user)
        }
    }
}

pub async fn login(app: &App, username: String, password: String) -> Result<Session> {
    login_from(app, username, password, None).await
}

pub async fn login_from(
    app: &App,
    username: String,
    password: String,
    peer: Option<IpAddr>,
) -> Result<Session> {
    match password_login(app, username, password, peer, false).await? {
        rv_protocol::parity::AuthenticationStep::Session { session } => Ok(session),
        rv_protocol::parity::AuthenticationStep::Challenge { .. } => {
            unreachable!("legacy login never issues a challenge")
        }
    }
}

pub async fn start_login(
    app: &App,
    username: String,
    password: String,
    peer: Option<IpAddr>,
) -> Result<rv_protocol::parity::AuthenticationStep> {
    password_login(app, username, password, peer, true).await
}

async fn password_login(
    app: &App,
    username: String,
    password: String,
    peer: Option<IpAddr>,
    challenges: bool,
) -> Result<rv_protocol::parity::AuthenticationStep> {
    if username.len() > 128 || password.len() > 1024 {
        return Err(Error::invalid());
    }
    // Limit expensive Argon2 work independently of the HTTP connection count.
    let permit = app
        .password_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::throttled("auth_busy", 1))?;
    crate::limits::login_attempt(app, &username, peer).await?;
    let record: Option<(String,String,String,String,Option<String>)> = sqlx::query_as("SELECT id,username,display_name,password_hash,legacy_password FROM users WHERE username=$1 AND NOT disabled")
        .bind(username).fetch_optional(&app.pool).await?;
    let hash = record
        .as_ref()
        .map(|r| r.3.clone())
        .unwrap_or_else(|| app.dummy_password_hash.clone());
    let legacy = record.as_ref().and_then(|r| r.4.clone());
    let (valid, rehashed) = tokio::task::spawn_blocking(move || {
        // Dropping a cancelled HTTP future must not release the slot while
        // Argon2 is still running in the blocking thread pool.
        let _permit = permit;
        // An imported account answers to its Rocket.Chat password once; it
        // leaves with the native hash of that same password.
        if let Some(legacy) = legacy {
            if !legacy_password_matches(&password, &legacy) {
                return (false, None);
            }
            let fresh = Argon2::default()
                .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
                .map(|v| v.to_string())
                .ok();
            return (fresh.is_some(), fresh);
        }
        let valid = PasswordHash::new(&hash).ok().is_some_and(|h| {
            Argon2::default()
                .verify_password(password.as_bytes(), &h)
                .is_ok()
        });
        (valid, None)
    })
    .await
    .map_err(|_| Error::internal())?;
    let Some((id, username, display_name, verified_hash, _)) = record.filter(|_| valid) else {
        return Err(Error::unauthorized());
    };
    let mut tx = app.pool.begin().await?;
    mutation_deadlines(&mut tx).await?;
    let (instance, epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut *tx)
            .await?;
    let active: Option<String> = sqlx::query_scalar(
        "SELECT password_hash FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    if active.as_deref() != Some(&verified_hash) {
        return Err(Error::unauthorized());
    }
    if let Some(fresh) = rehashed {
        // The trigger drops the legacy hash with the change.
        sqlx::query("UPDATE users SET password_hash=$2 WHERE id=$1")
            .bind(&id)
            .bind(fresh)
            .execute(&mut *tx)
            .await?;
    }
    let user = User {
        id,
        username,
        display_name,
    };
    let enabled: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_factor_profiles WHERE user_id=$1)")
            .bind(&user.id)
            .fetch_one(&mut *tx)
            .await?;
    if enabled {
        if !challenges {
            return Err(Error::new(
                axum::http::StatusCode::BAD_REQUEST,
                "factor_required",
            ));
        }
        let challenge =
            crate::factors::issue_challenge(app, &mut tx, &user, &instance, &epoch).await?;
        tx.commit().await?;
        return Ok(rv_protocol::parity::AuthenticationStep::Challenge { challenge, user });
    }
    let session = create_session(&mut tx, &user, random_token()).await?;
    tx.commit().await?;
    Ok(rv_protocol::parity::AuthenticationStep::Session { session })
}

/// Caller holds the account lock and has checked its authentication proof.
pub(crate) async fn create_session(
    tx: &mut Transaction<'_, Postgres>,
    user: &User,
    token: String,
) -> Result<Session> {
    let existing: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1)")
            .bind(hash_token(&token))
            .fetch_one(&mut **tx)
            .await?;
    if existing {
        return Err(Error::conflict());
    }
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id=$1 AND expires_at>now()")
            .bind(&user.id)
            .fetch_one(&mut **tx)
            .await?;
    if count >= 64 {
        return Err(Error::throttled("device_limit", 60));
    }
    let device = random_token()[..32].to_owned();
    sqlx::query("INSERT INTO session_devices(id,user_id,login_factor_id) VALUES($1,$2,(SELECT version FROM account_factor_profiles WHERE user_id=$2))")
        .bind(&device)
        .bind(&user.id)
        .execute(&mut **tx)
        .await?;
    let expires_at:DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO sessions(token_hash,user_id,expires_at,device_id) VALUES($1,$2,clock_timestamp()+interval '30 days',$3) RETURNING expires_at",
    )
    .bind(hash_token(&token))
    .bind(&user.id)
    .bind(device)
    .fetch_one(&mut **tx)
    .await?;
    Ok(Session {
        token,
        expires_at: expires_at.to_rfc3339(),
        user: user.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rocket_chat_password_hash_is_checked_the_meteor_way() {
        let digest: String = Sha256::digest(b"alice-dev-2026")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let hash = bcrypt::hash(digest, 4).unwrap();
        assert!(legacy_password_matches("alice-dev-2026", &hash));
        assert!(!legacy_password_matches("alice-dev-2027", &hash));
        assert!(!legacy_password_matches(
            "alice-dev-2026",
            "not a bcrypt hash"
        ));
    }
}
