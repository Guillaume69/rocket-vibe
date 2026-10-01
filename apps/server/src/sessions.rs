//! Rotating opaque sessions. Only hashes enter the database; a retry proves
//! knowledge of both the previous bearer and the durably saved next bearer.
use crate::{
    App, auth,
    auth::Account,
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
use rv_protocol::{
    Session, User,
    parity::{DeviceSession, RenameDevice, RenewSession},
};

pub async fn renew(app: &App, old_hash: &str, input: RenewSession) -> Result<Session> {
    if !auth::identifier(&input.operation_id)
        || input.next_token.len() != 64
        || !input
            .next_token
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(Error::invalid());
    }
    let next_hash = auth::hash_token(&input.next_token);
    if next_hash == old_hash {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let user_id: Option<String> = sqlx::query_scalar("SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now() UNION SELECT d.user_id FROM session_rotations r JOIN session_devices d ON d.id=r.device_id WHERE r.old_hash=$1 AND r.expires_at>now() LIMIT 1")
        .bind(old_hash).fetch_optional(&mut *tx).await?;
    let id = user_id.ok_or_else(Error::unauthorized)?;
    let user: Option<(String, String, String)> = sqlx::query_as(
        "SELECT id,username,display_name FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    let (id, username, display_name) = user.ok_or_else(Error::unauthorized)?;
    let previous: Option<(String,String,String)> = sqlx::query_as("SELECT device_id,next_hash,operation_id FROM session_rotations WHERE old_hash=$1 AND expires_at>now() FOR UPDATE")
        .bind(old_hash).fetch_optional(&mut *tx).await?;
    let expires_at: DateTime<Utc>;
    if let Some((device, saved_next, operation)) = previous {
        if saved_next != next_hash || operation != input.operation_id {
            // A spent bearer proposed another successor. Revoke this device's
            // entire family; never mint a second branch from an old secret.
            sqlx::query("DELETE FROM session_devices WHERE id=$1 AND user_id=$2")
                .bind(device)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Err(Error::unauthorized());
        }
        expires_at = sqlx::query_scalar("SELECT expires_at FROM sessions WHERE token_hash=$1 AND device_id=$2 AND user_id=$3 AND expires_at>now() FOR SHARE")
            .bind(&next_hash).bind(device).bind(&id).fetch_optional(&mut *tx).await?.ok_or_else(Error::unauthorized)?;
    } else {
        let device: Option<String> = sqlx::query_scalar("SELECT device_id FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE")
            .bind(old_hash).bind(&id).fetch_optional(&mut *tx).await?;
        let device = device.ok_or_else(Error::unauthorized)?;
        let existing: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1)")
                .bind(&next_hash)
                .fetch_one(&mut *tx)
                .await?;
        if existing {
            return Err(Error::conflict());
        }
        let attempts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_rotations WHERE device_id=$1 AND created_at>now()-interval '1 minute'")
            .bind(&device).fetch_one(&mut *tx).await?;
        if attempts >= 10 {
            return Err(Error::throttled("session_rotation_limit", 60));
        }
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(old_hash)
            .execute(&mut *tx)
            .await?;
        expires_at = sqlx::query_scalar("SELECT now()+interval '30 days'")
            .fetch_one(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO sessions(token_hash,user_id,expires_at,device_id) VALUES($1,$2,$3,$4)",
        )
        .bind(&next_hash)
        .bind(&id)
        .bind(expires_at)
        .bind(&device)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE session_devices SET last_seen_at=now() WHERE id=$1")
            .bind(&device)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO session_rotations(old_hash,device_id,next_hash,operation_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')")
            .bind(old_hash).bind(device).bind(&next_hash).bind(input.operation_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Session {
        token: input.next_token,
        expires_at: expires_at.to_rfc3339(),
        user: User {
            id,
            username,
            display_name,
        },
    })
}

pub async fn list(app: &App, account: &Account) -> Result<Vec<DeviceSession>> {
    type DeviceRow = (
        String,
        String,
        DateTime<Utc>,
        DateTime<Utc>,
        DateTime<Utc>,
        bool,
    );
    let rows: Vec<DeviceRow> = sqlx::query_as("SELECT d.id,d.label,d.created_at,d.last_seen_at,s.expires_at,s.token_hash=$2 FROM session_devices d JOIN sessions s ON s.device_id=d.id WHERE d.user_id=$1 AND s.expires_at>now() ORDER BY d.created_at,d.id LIMIT 64")
        .bind(&account.id).bind(&account.session_hash).fetch_all(&app.pool).await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, label, created, last_seen, expires, current)| DeviceSession {
                id,
                label,
                created_at: created.to_rfc3339(),
                last_seen_at: last_seen.to_rfc3339(),
                expires_at: expires.to_rfc3339(),
                current,
            },
        )
        .collect())
}

pub async fn rename(app: &App, account: &Account, id: &str, input: RenameDevice) -> Result<()> {
    let label = input.label.trim();
    if label.is_empty() || label.len() > 128 || label.chars().any(char::is_control) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, account).await?;
    if sqlx::query("UPDATE session_devices SET label=$3 WHERE id=$1 AND user_id=$2")
        .bind(id)
        .bind(&account.id)
        .bind(label)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        == 0
    {
        return Err(Error::missing());
    }
    tx.commit().await?;
    Ok(())
}

pub async fn revoke(app: &App, account: &Account, id: Option<&str>) -> Result<()> {
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, account).await?;
    if let Some(target) = id {
        let sensitive: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_devices d WHERE d.id=$1 AND d.user_id=$2 AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.device_id=d.id AND s.token_hash=$3))")
            .bind(target).bind(&account.id).bind(&account.session_hash).fetch_one(&mut *tx).await?;
        if sensitive {
            let recent: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_devices d JOIN sessions s ON s.device_id=d.id WHERE s.token_hash=$1 AND d.created_at>now()-interval '15 minutes')")
                .bind(&account.session_hash).fetch_one(&mut *tx).await?;
            if !recent {
                return Err(Error::new(
                    axum::http::StatusCode::FORBIDDEN,
                    "reauthentication_required",
                ));
            }
        }
    }
    // Deleting the family also removes receipts and unused socket tickets.
    sqlx::query("DELETE FROM session_devices WHERE user_id=$1 AND (id=$2 OR ($2::text IS NULL AND id IN (SELECT device_id FROM sessions WHERE token_hash=$3)))")
        .bind(&account.id).bind(id).bind(&account.session_hash).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
