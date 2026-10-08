//! Operator recovery changes login credentials only, preserving account/data.
use crate::{
    App, auth,
    error::{Error, Result},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rand_core::OsRng;
use rv_protocol::{User, parity::RecoverAccount};
use serde::Serialize;
use sqlx::FromRow;
use std::net::IpAddr;

#[derive(Serialize, FromRow)]
pub struct RecoveryCode {
    pub id: String,
    pub user_id: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub consumed_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}
#[derive(Serialize)]
pub struct IssuedRecoveryCode {
    pub recovery: RecoveryCode,
    pub token: String,
}

pub async fn issue(app: &App, username: &str, hours: u32) -> Result<IssuedRecoveryCode> {
    if !auth::identifier(username) || !(1..=24).contains(&hours) {
        return Err(Error::invalid());
    }
    let token = auth::random_token();
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let epoch: String =
        sqlx::query_scalar("SELECT data_epoch FROM instance WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    let (id,version):(String,String)=sqlx::query_as("SELECT id,activation_version FROM users WHERE username=$1 AND NOT disabled AND NOT bot FOR NO KEY UPDATE")
        .bind(username).fetch_optional(&mut *tx).await?.ok_or_else(Error::missing)?;
    let (total,account):(i64,i64)=sqlx::query_as("SELECT count(*),count(*) FILTER(WHERE user_id=$1) FROM account_recovery_codes WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() AND data_epoch=$2 AND activation_version=(SELECT activation_version FROM users WHERE id=account_recovery_codes.user_id AND NOT disabled) AND (email_version IS NULL OR (email_instance_id=(SELECT instance_id FROM instance WHERE singleton) AND email_version=(SELECT email_version FROM users WHERE id=account_recovery_codes.user_id) AND EXISTS(SELECT 1 FROM account_emails WHERE user_id=account_recovery_codes.user_id)))")
        .bind(&id).bind(&epoch).fetch_one(&mut *tx).await?;
    if total >= 1000 || account >= 3 {
        return Err(Error::throttled("recovery_limit", 60));
    }
    let recovery:RecoveryCode=sqlx::query_as("INSERT INTO account_recovery_codes(id,token_hash,user_id,data_epoch,activation_version,expires_at) VALUES($1,$2,$3,$4,$5,now()+make_interval(hours => $6)) RETURNING id,user_id,created_at,expires_at,consumed_at,revoked_at")
        .bind(auth::random_token()[..24].to_owned()).bind(auth::hash_token(&token)).bind(id).bind(epoch).bind(version).bind(hours as i32)
        .fetch_one(&mut *tx).await?;
    crate::operator::record(
        &mut tx,
        "recovery.issued",
        &recovery.id,
        serde_json::json!({"user_id":recovery.user_id,"expires_at":recovery.expires_at}),
    )
    .await?;
    tx.commit().await?;
    Ok(IssuedRecoveryCode { recovery, token })
}
pub async fn list(app: &App) -> Result<Vec<RecoveryCode>> {
    Ok(sqlx::query_as("SELECT id,user_id,created_at,expires_at,consumed_at,revoked_at FROM account_recovery_codes ORDER BY created_at DESC,id LIMIT 1000")
        .fetch_all(&app.pool).await?)
}
pub async fn revoke(app: &App, id: &str) -> Result<()> {
    if !auth::identifier(id) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let result = sqlx::query("UPDATE account_recovery_codes SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL")
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() > 0 {
        crate::operator::record(&mut tx, "recovery.revoked", id, serde_json::json!({})).await?;
    } else {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_recovery_codes WHERE id=$1)")
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
    user_id: String,
    data_epoch: String,
    activation_version: String,
    consumed_version: Option<String>,
    email_version: Option<String>,
    email_instance_id: Option<String>,
    usable: bool,
}
#[derive(FromRow)]
struct Account {
    id: String,
    username: String,
    display_name: String,
    password_hash: String,
    activation_version: String,
    email_version: String,
    email_verified: bool,
}
fn rejected() -> Error {
    Error::new(StatusCode::BAD_REQUEST, "recovery_rejected")
}

pub async fn accept(app: &App, input: RecoverAccount, peer: Option<IpAddr>) -> Result<User> {
    if input.token.len() != 64
        || !input
            .token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !auth::identifier(&input.username)
        || input.new_password.chars().count() < 12
        || input.new_password.len() > 1024
    {
        return Err(Error::invalid());
    }
    let permit = std::sync::Arc::new(
        app.password_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::throttled("auth_busy", 1))?,
    );
    crate::limits::recovery_attempt(app, &input.username, peer, &input.token).await?;
    let digest = auth::hash_token(&input.token);
    for _ in 0..2 {
        let claim:Option<Claim>=sqlx::query_as("SELECT user_id,data_epoch,activation_version,consumed_version,email_version,email_instance_id,(revoked_at IS NULL AND expires_at>clock_timestamp() AND (consumed_at IS NULL OR consumed_at>clock_timestamp()-interval '5 minutes')) AS usable FROM account_recovery_codes WHERE token_hash=$1")
            .bind(&digest).fetch_optional(&app.pool).await?;
        let record: Option<Account> = if let Some(claim) = &claim {
            sqlx::query_as("SELECT id,username,display_name,password_hash,activation_version,email_version,EXISTS(SELECT 1 FROM account_emails WHERE user_id=users.id) AS email_verified FROM users WHERE id=$1 AND username=$2 AND NOT disabled")
                .bind(&claim.user_id).bind(&input.username).fetch_optional(&app.pool).await?
        } else {
            None
        };
        let eligible = claim.as_ref().zip(record.as_ref()).is_some_and(|(c, r)| {
            c.usable
                && c.email_version
                    .as_ref()
                    .is_none_or(|v| r.email_verified && v == &r.email_version)
                && c.consumed_version
                    .as_deref()
                    .unwrap_or(&c.activation_version)
                    == r.activation_version
        });
        let verify = if !eligible {
            Some(app.dummy_password_hash.clone())
        } else if claim.as_ref().is_some_and(|c| c.consumed_version.is_some()) {
            Some(
                record
                    .as_ref()
                    .expect("eligible account")
                    .password_hash
                    .clone(),
            )
        } else {
            None
        };
        let secret = input.new_password.clone();
        let work_permit = permit.clone();
        let (valid, new_hash) = tokio::task::spawn_blocking(move || {
            let _permit = work_permit;
            if let Some(hash) = verify {
                Ok((
                    PasswordHash::new(&hash).is_ok_and(|h| {
                        Argon2::default()
                            .verify_password(secret.as_bytes(), &h)
                            .is_ok()
                    }),
                    None,
                ))
            } else {
                Argon2::default()
                    .hash_password(secret.as_bytes(), &SaltString::generate(&mut OsRng))
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
        let record = record.expect("eligible account");
        let mut tx = app.pool.begin().await?;
        auth::mutation_deadlines(&mut tx).await?;
        let (instance, epoch): (String, String) =
            sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
                .fetch_one(&mut *tx)
                .await?;
        if epoch != claim.data_epoch
            || claim
                .email_instance_id
                .as_ref()
                .is_some_and(|v| v != &instance)
        {
            return Err(rejected());
        }
        let current:Account=sqlx::query_as("SELECT id,username,display_name,password_hash,activation_version,email_version,EXISTS(SELECT 1 FROM account_emails WHERE user_id=users.id) AS email_verified FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE")
            .bind(&record.id).fetch_optional(&mut *tx).await?.ok_or_else(rejected)?;
        if current.activation_version != record.activation_version
            || current.password_hash != record.password_hash
            || current.username != input.username
        {
            drop(tx);
            continue;
        }
        let code:Claim=sqlx::query_as("SELECT user_id,data_epoch,activation_version,consumed_version,email_version,email_instance_id,(revoked_at IS NULL AND expires_at>clock_timestamp() AND (consumed_at IS NULL OR consumed_at>clock_timestamp()-interval '5 minutes')) AS usable FROM account_recovery_codes WHERE token_hash=$1 FOR UPDATE")
            .bind(&digest).fetch_optional(&mut *tx).await?.ok_or_else(rejected)?;
        let usable:bool=sqlx::query_scalar("SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AND (consumed_at IS NULL OR consumed_at>clock_timestamp()-interval '5 minutes') FROM account_recovery_codes WHERE token_hash=$1")
            .bind(&digest).fetch_one(&mut *tx).await?;
        if !usable
            || code.data_epoch != epoch
            || code.user_id != current.id
            || code
                .email_instance_id
                .as_ref()
                .is_some_and(|v| v != &instance)
            || code
                .email_version
                .as_ref()
                .is_some_and(|v| !current.email_verified || v != &current.email_version)
        {
            return Err(rejected());
        }
        let user = User {
            id: current.id.clone(),
            username: current.username,
            display_name: current.display_name,
            ..Default::default()
        };
        if let Some(version) = code.consumed_version {
            if version != current.activation_version || new_hash.is_some() {
                return Err(rejected());
            }
            tx.commit().await?;
            return Ok(user);
        }
        if code.activation_version != current.activation_version {
            return Err(rejected());
        }
        let version: String = sqlx::query_scalar(
            "UPDATE users SET password_hash=$2 WHERE id=$1 RETURNING activation_version",
        )
        .bind(&user.id)
        .bind(new_hash.ok_or_else(rejected)?)
        .fetch_one(&mut *tx)
        .await?;
        // Revoke whole device families and their tickets/rotation receipts.
        sqlx::query("DELETE FROM session_devices WHERE user_id=$1")
            .bind(&user.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM snapshot_heads WHERE user_id=$1")
            .bind(&user.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM sync_cursors WHERE user_id=$1")
            .bind(&user.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE account_recovery_codes SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 AND token_hash<>$2")
            .bind(&user.id).bind(&digest).execute(&mut *tx).await?;
        sqlx::query("UPDATE account_recovery_codes SET consumed_at=now(),consumed_version=$2 WHERE token_hash=$1")
            .bind(&digest).bind(version).execute(&mut *tx).await?;
        // Every password recovery also retires outstanding mail payloads.
        sqlx::query("UPDATE email_recovery_outbox SET payload_cipher=NULL,lease_id=NULL,lease_expires_at=NULL WHERE request_hash IN (SELECT operation_hash FROM email_recovery_requests WHERE user_id=$1)")
            .bind(&user.id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(user);
    }
    Err(rejected())
}
