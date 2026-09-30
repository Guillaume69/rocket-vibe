use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::http::HeaderMap;
use chrono::{DateTime, Utc};
use rand_core::{OsRng, RngCore};
use rv_protocol::{Session, User};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
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

#[derive(FromRow)]
pub struct Account {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub admin: bool,
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
    sqlx::query_as::<_, Account>("SELECT u.id, u.username, u.display_name, u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled")
        .bind(session_hash).fetch_optional(&app.pool).await?.ok_or_else(Error::unauthorized)
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
    sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)")
        .bind(hash_token(&token))
        .bind(&id)
        .bind(expires_at)
        .execute(&app.pool)
        .await?;
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
