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
    Sha256::digest(token.as_bytes())
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
    sqlx::query_as::<_, Account>("SELECT u.id, u.username, u.display_name, u.admin,u.activation_version,s.token_hash AS session_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled")
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
    let session: Option<String> = sqlx::query_scalar("SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR SHARE")
        .bind(&account.session_hash).bind(&account.id).fetch_optional(&mut **tx).await?;
    if session.is_none() {
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
    let result = sqlx::query(
        "INSERT INTO users(id,username,display_name,password_hash,admin) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(&user.id)
    .bind(&user.username)
    .bind(&user.display_name)
    .bind(password_hash)
    .bind(admin)
    .execute(&app.pool)
    .await;
    match result {
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Err(Error::conflict()),
        Err(e) => Err(e.into()),
        Ok(_) => Ok(user),
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
    let record: Option<(String,String,String,String)> = sqlx::query_as("SELECT id,username,display_name,password_hash FROM users WHERE username=$1 AND NOT disabled")
        .bind(username).fetch_optional(&app.pool).await?;
    let hash = record
        .as_ref()
        .map(|r| r.3.clone())
        .unwrap_or_else(|| app.dummy_password_hash.clone());
    let valid = tokio::task::spawn_blocking(move || {
        // Dropping a cancelled HTTP future must not release the slot while
        // Argon2 is still running in the blocking thread pool.
        let _permit = permit;
        PasswordHash::new(&hash).ok().is_some_and(|h| {
            Argon2::default()
                .verify_password(password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .map_err(|_| Error::internal())?;
    let Some((id, username, display_name, _)) = record.filter(|_| valid) else {
        return Err(Error::unauthorized());
    };
    let token = random_token();
    let expires_at: DateTime<Utc> = Utc::now() + chrono::Duration::days(30);
    let mut tx = app.pool.begin().await?;
    mutation_deadlines(&mut tx).await?;
    let active: Option<String> =
        sqlx::query_scalar("SELECT id FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    if active.is_none() {
        return Err(Error::unauthorized());
    }
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id=$1 AND expires_at>now()")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
    if count >= 64 {
        return Err(Error::throttled("device_limit", 60));
    }
    let device = random_token()[..32].to_owned();
    sqlx::query("INSERT INTO session_devices(id,user_id) VALUES($1,$2)")
        .bind(&device)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let expires_at:DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO sessions(token_hash,user_id,expires_at,device_id) VALUES($1,$2,$3,$4) RETURNING expires_at",
    )
    .bind(hash_token(&token))
    .bind(&id)
    .bind(expires_at)
    .bind(device)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Session {
        token,
        expires_at: expires_at.to_rfc3339(),
        user: User {
            id,
            username,
            display_name,
        },
    })
}
