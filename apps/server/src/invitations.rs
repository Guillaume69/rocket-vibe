//! Operator-issued, single-account invitations. Signup never grants a session.
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rand_core::OsRng;
use rv_protocol::{User, parity::AcceptInvitation};
use serde::Serialize;
use sqlx::FromRow;
use std::net::IpAddr;

use crate::{
    App, auth,
    error::{Error, Result},
};

#[derive(Serialize, FromRow)]
pub struct Invitation {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub consumed_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

// Deliberately no Debug: only explicit operator stdout reveals this once.
#[derive(Serialize)]
pub struct IssuedInvitation {
    pub invitation: Invitation,
    pub token: String,
}

pub async fn issue(app: &App, hours: u32) -> Result<IssuedInvitation> {
    if !(1..=168).contains(&hours) {
        return Err(Error::invalid());
    }
    let token = auth::random_token();
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    // Serializes issuance and fences a concurrent restore / epoch change.
    let epoch: String =
        sqlx::query_scalar("SELECT data_epoch FROM instance WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM account_invitations WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() AND data_epoch=$1")
        .bind(&epoch).fetch_one(&mut *tx).await?;
    if count >= 1000 {
        return Err(Error::throttled("invitation_limit", 60));
    }
    let invitation: Invitation = sqlx::query_as("INSERT INTO account_invitations(id,token_hash,data_epoch,expires_at) VALUES($1,$2,$3,now()+make_interval(hours => $4)) RETURNING id,created_at,expires_at,consumed_at,revoked_at")
        .bind(auth::random_token()[..24].to_owned()).bind(auth::hash_token(&token))
        .bind(epoch).bind(hours as i32).fetch_one(&mut *tx).await?;
    crate::operator::record(
        &mut tx,
        "invitation.issued",
        &invitation.id,
        serde_json::json!({"expires_at":invitation.expires_at}),
    )
    .await?;
    tx.commit().await?;
    Ok(IssuedInvitation { invitation, token })
}

pub async fn list(app: &App) -> Result<Vec<Invitation>> {
    Ok(sqlx::query_as("SELECT id,created_at,expires_at,consumed_at,revoked_at FROM account_invitations ORDER BY created_at DESC,id LIMIT 1000")
        .fetch_all(&app.pool).await?)
}

pub async fn revoke(app: &App, id: &str) -> Result<()> {
    if !auth::identifier(id) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let changed = sqlx::query("UPDATE account_invitations SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL")
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if changed.rows_affected() > 0 {
        crate::operator::record(&mut tx, "invitation.revoked", id, serde_json::json!({})).await?;
    } else {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_invitations WHERE id=$1)")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        if !exists {
            return Err(Error::missing());
        }
    }
    tx.commit().await?;
    Ok(())
}

#[derive(FromRow)]
struct Claim {
    data_epoch: String,
    consumed_by: Option<String>,
    consumed_at: Option<DateTime<Utc>>,
    usable: bool,
}

fn rejected() -> Error {
    Error::new(StatusCode::BAD_REQUEST, "invitation_rejected")
}

pub async fn accept(app: &App, input: AcceptInvitation, peer: Option<IpAddr>) -> Result<User> {
    if input.token.len() != 64
        || !input
            .token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !auth::identifier(&input.username)
        || auth::reserved_username(&input.username)
        || input.password.chars().count() < 12
        || input.password.len() > 1024
    {
        return Err(Error::invalid());
    }
    let permit = std::sync::Arc::new(
        app.password_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::throttled("auth_busy", 1))?,
    );
    crate::limits::invitation_attempt(app, &input.username, peer, &input.token).await?;
    let digest = auth::hash_token(&input.token);
    // One retry covers two concurrent accepts: after the winning commit, verify
    // the bound account password, never compare fast password fingerprints.
    for _ in 0..2 {
        let claim: Option<Claim> = sqlx::query_as("SELECT data_epoch,consumed_by,consumed_at,(revoked_at IS NULL AND expires_at>clock_timestamp()) AS usable FROM account_invitations WHERE token_hash=$1")
            .bind(&digest).fetch_optional(&app.pool).await?;
        let replay = claim.as_ref().and_then(|c| c.consumed_by.as_ref());
        let record: Option<(String, String, String, String)> = if let Some(id) = replay {
            sqlx::query_as("SELECT id,username,display_name,password_hash FROM users WHERE id=$1 AND username=$2 AND NOT disabled")
                .bind(id).bind(&input.username).fetch_optional(&app.pool).await?
        } else {
            None
        };
        let eligible = claim
            .as_ref()
            .is_some_and(|c| c.usable && (c.consumed_at.is_none() || record.is_some()));
        let hash_to_verify = if eligible {
            record.as_ref().map(|r| r.3.clone())
        } else {
            Some(app.dummy_password_hash.clone())
        };
        let password = input.password.clone();
        let work_permit = permit.clone();
        let (valid, new_hash) = tokio::task::spawn_blocking(move || {
            let _permit = work_permit;
            if let Some(hash) = hash_to_verify {
                let valid = PasswordHash::new(&hash).is_ok_and(|h| {
                    Argon2::default()
                        .verify_password(password.as_bytes(), &h)
                        .is_ok()
                });
                Ok((valid, None))
            } else {
                Argon2::default()
                    .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
                    .map(|h| (true, Some(h.to_string())))
            }
        })
        .await
        .map_err(|_| Error::internal())?
        .map_err(|_| Error::internal())?;
        if !eligible || !valid {
            return Err(rejected());
        }
        let claim = claim.expect("eligible claim");
        let mut tx = app.pool.begin().await?;
        auth::mutation_deadlines(&mut tx).await?;
        let epoch: String =
            sqlx::query_scalar("SELECT data_epoch FROM instance WHERE singleton FOR SHARE")
                .fetch_one(&mut *tx)
                .await?;
        if epoch != claim.data_epoch {
            return Err(rejected());
        }
        // Lock the replay account before the invitation, consistent with account
        // mutations. Ensure the verified hash is still the current one.
        let user = if let Some((id, username, display_name, hash)) = record {
            let active: Option<String> = sqlx::query_scalar(
                "SELECT password_hash FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE",
            )
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
            if active.as_deref() != Some(&hash) {
                return Err(rejected());
            }
            Some(User {
                id,
                username,
                display_name,
                ..Default::default()
            })
        } else {
            None
        };
        let current: Claim = sqlx::query_as("SELECT data_epoch,consumed_by,consumed_at,(revoked_at IS NULL AND expires_at>clock_timestamp()) AS usable FROM account_invitations WHERE token_hash=$1 FOR UPDATE")
            .bind(&digest).fetch_optional(&mut *tx).await?.ok_or_else(rejected)?;
        // A lock wait may pass expiration; evaluate using the wall clock after it.
        let usable: bool = sqlx::query_scalar("SELECT revoked_at IS NULL AND expires_at>clock_timestamp() FROM account_invitations WHERE token_hash=$1")
            .bind(&digest).fetch_one(&mut *tx).await?;
        if !usable || current.data_epoch != epoch {
            return Err(rejected());
        }
        if current.consumed_at.is_some() {
            if let Some(user) = user.filter(|u| current.consumed_by.as_deref() == Some(&u.id)) {
                tx.commit().await?;
                return Ok(user);
            }
            drop(tx);
            continue;
        }
        if user.is_some() {
            return Err(rejected());
        }
        let user = User {
            id: auth::random_token()[..24].into(),
            username: input.username.clone(),
            display_name: input.username.clone(),
            ..Default::default()
        };
        // A deleted account's name stays retired (the users trigger also refuses it).
        let retired: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM retired_usernames WHERE username=lower($1))",
        )
        .bind(&user.username)
        .fetch_one(&mut *tx)
        .await?;
        if retired {
            return Err(rejected());
        }
        let inserted = sqlx::query("INSERT INTO users(id,username,display_name,password_hash,admin) VALUES($1,$2,$3,$4,false) ON CONFLICT DO NOTHING")
            .bind(&user.id).bind(&user.username).bind(&user.display_name).bind(new_hash.ok_or_else(rejected)?)
            .execute(&mut *tx).await?;
        if inserted.rows_affected() != 1 {
            return Err(rejected());
        }
        sqlx::query(
            "UPDATE account_invitations SET consumed_by=$2,consumed_at=now() WHERE token_hash=$1",
        )
        .bind(&digest)
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(user);
    }
    Err(rejected())
}
