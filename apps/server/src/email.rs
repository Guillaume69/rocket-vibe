//! Private verified contact, bound to an existing device and a retired command head.
pub(crate) mod removal;
use crate::{
    App,
    auth::{self, Account},
    error::{Error, Result},
    factors,
};
use chrono::{DateTime, Utc};
use rv_protocol::parity::{
    BeginEmailVerification, ConfirmEmailVerification, EmailDeliveryState, EmailStatus,
    EmailVerificationStep, ReauthenticationContext, ResumeEmailVerification,
    RetireEmailVerification,
};
use sqlx::{FromRow, Postgres, Transaction};
use std::net::IpAddr;
use subtle::ConstantTimeEq;

pub(crate) fn unavailable() -> Error {
    Error::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "email_unavailable",
    )
}
fn rejected() -> Error {
    Error::new(
        axum::http::StatusCode::BAD_REQUEST,
        "email_verification_rejected",
    )
}
fn intent(candidate: &str, operation: &str, context: &ReauthenticationContext) -> Result<()> {
    if !factors::bearer_candidate(candidate) || !auth::identifier(operation) {
        return Err(Error::invalid());
    }
    valid_context(context)
}
fn valid_context(context: &ReauthenticationContext) -> Result<()> {
    if [
        &context.user_id,
        &context.device_id,
        &context.instance_id,
        &context.data_epoch,
    ]
    .iter()
    .any(|id| !auth::identifier(id))
    {
        return Err(Error::invalid());
    }
    Ok(())
}
struct Source {
    context: ReauthenticationContext,
    activation: String,
    factor: String,
    version: String,
    head: String,
    claimed: bool,
}
async fn source(tx: &mut Transaction<'_, Postgres>, account: &Account) -> Result<Source> {
    let (instance_id, data_epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut **tx)
            .await?;
    auth::lock_active(tx, account).await?;
    let (version, factor): (String, String) =
        sqlx::query_as("SELECT email_version,factor_version FROM users WHERE id=$1")
            .bind(&account.id)
            .fetch_one(&mut **tx)
            .await?;
    let (device_id,head,claimed,expiry):(String,String,bool,DateTime<Utc>)=sqlx::query_as("SELECT d.id,d.email_verification_version,d.email_verification_claimed,s.expires_at FROM session_devices d JOIN sessions s ON s.device_id=d.id WHERE s.token_hash=$1 FOR NO KEY UPDATE OF d").bind(&account.session_hash).fetch_one(&mut **tx).await?;
    if expiry <= clock(tx).await? {
        return Err(Error::unauthorized());
    }
    Ok(Source {
        context: ReauthenticationContext {
            user_id: account.id.clone(),
            device_id,
            instance_id,
            data_epoch,
        },
        activation: account.activation_version.clone(),
        factor,
        version,
        head,
        claimed,
    })
}
fn scoped(source: &Source, context: &ReauthenticationContext) -> Result<()> {
    let actual = &source.context;
    if actual.user_id != context.user_id
        || actual.device_id != context.device_id
        || actual.instance_id != context.instance_id
        || actual.data_epoch != context.data_epoch
    {
        return Err(Error::conflict());
    }
    Ok(())
}
async fn clock(tx: &mut Transaction<'_, Postgres>) -> Result<DateTime<Utc>> {
    Ok(sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?)
}
async fn status_in(tx: &mut Transaction<'_, Postgres>, current: Source) -> Result<EmailStatus> {
    let email: Option<(String, DateTime<Utc>)> =
        sqlx::query_as("SELECT address,verified_at FROM account_emails WHERE user_id=$1")
            .bind(&current.context.user_id)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(EmailStatus {
        address: email.as_ref().map(|v| v.0.clone()),
        verified_at: email.map(|v| v.1.to_rfc3339()),
        version: current.version,
        verification_version: current.head,
        context: current.context,
    })
}
pub(crate) async fn status(app: &App, account: &Account) -> Result<EmailStatus> {
    let mut tx = app.pool.begin().await?;
    let current = source(&mut tx, account).await?;
    let view = status_in(&mut tx, current).await?;
    tx.commit().await?;
    Ok(view)
}
#[derive(FromRow)]
struct Verification {
    token_hash: String,
    operation_id: String,
    instance_id: String,
    data_epoch: String,
    activation_version: String,
    factor_version: String,
    email_version: String,
    requested_version: String,
    committed_version: Option<String>,
    committed_head: Option<String>,
    address: String,
    code_hash: String,
    attempts: i32,
    expires_at: DateTime<Utc>,
    verified_at: Option<DateTime<Utc>>,
    receipt_expires_at: Option<DateTime<Utc>>,
}
async fn find(
    tx: &mut Transaction<'_, Postgres>,
    current: &Source,
    hash: &str,
) -> Result<Option<Verification>> {
    Ok(sqlx::query_as("SELECT * FROM email_verifications WHERE token_hash=$1 AND user_id=$2 AND device_id=$3 FOR UPDATE").bind(hash).bind(&current.context.user_id).bind(&current.context.device_id).fetch_optional(&mut **tx).await?)
}
async fn view(
    tx: &mut Transaction<'_, Postgres>,
    current: &Source,
    saved: &Verification,
    candidate: &str,
    operation: &str,
) -> Result<EmailVerificationStep> {
    let now = clock(tx).await?;
    if saved.operation_id != operation
        || saved.instance_id != current.context.instance_id
        || saved.data_epoch != current.context.data_epoch
        || saved.activation_version != current.activation
        || saved.factor_version != current.factor
    {
        return Err(rejected());
    }
    if saved.verified_at.is_some() {
        if saved.committed_version.as_deref() != Some(&current.version)
            || saved.committed_head.as_deref() != Some(&current.head)
            || saved.receipt_expires_at.is_none_or(|t| t <= now)
        {
            return Err(rejected());
        }
        Ok(EmailVerificationStep::Verified {
            address: saved.address.clone(),
            version: current.version.clone(),
        })
    } else {
        if saved.email_version != current.version
            || saved.requested_version != current.head
            || saved.expires_at <= now
            || saved.attempts >= 5
        {
            return Err(rejected());
        }
        let (sent,attempts,sending):(bool,i32,bool)=sqlx::query_as("SELECT sent_at IS NOT NULL,attempts,COALESCE(lease_expires_at>clock_timestamp(),false) FROM email_outbox WHERE verification_hash=$1").bind(&saved.token_hash).fetch_one(&mut **tx).await?;
        let delivery = if sent {
            EmailDeliveryState::Accepted
        } else if sending {
            EmailDeliveryState::Sending
        } else if attempts >= 8 {
            EmailDeliveryState::Exhausted
        } else if attempts > 0 {
            EmailDeliveryState::Deferred
        } else {
            EmailDeliveryState::Queued
        };
        Ok(EmailVerificationStep::Pending {
            verification_id: candidate.to_owned(),
            operation_id: operation.to_owned(),
            address: saved.address.clone(),
            expires_at: saved.expires_at.to_rfc3339(),
            expected_version: saved.email_version.clone(),
            verification_version: saved.requested_version.clone(),
            delivery,
        })
    }
}
fn expected(current: &Source, input: &BeginEmailVerification) -> Result<()> {
    scoped(current, &input.context)?;
    if current.version != input.expected_version
        || current.head != input.verification_version
        || current.claimed
    {
        return Err(Error::conflict());
    }
    Ok(())
}
pub(crate) async fn begin(
    app: &App,
    account: &Account,
    mut input: BeginEmailVerification,
    peer: Option<IpAddr>,
) -> Result<EmailVerificationStep> {
    intent(&input.verification_id, &input.operation_id, &input.context)?;
    if !auth::identifier(&input.expected_version) || !auth::identifier(&input.verification_version)
    {
        return Err(Error::invalid());
    }
    if app.mail.is_none() || app.auth_key.is_none() {
        return Err(unavailable());
    }
    input.address = crate::mail::normalized_address(&input.address)?;
    let hash = auth::hash_token(&input.verification_id);
    // Inspect a known receipt before spending quota or requiring a new proof.
    let mut tx = app.pool.begin().await?;
    let current = source(&mut tx, account).await?;
    scoped(&current, &input.context)?;
    if let Some(saved) = find(&mut tx, &current, &hash).await? {
        if saved.address != input.address
            || saved.email_version != input.expected_version
            || saved.requested_version != input.verification_version
        {
            return Err(Error::conflict());
        }
        let result = view(
            &mut tx,
            &current,
            &saved,
            &input.verification_id,
            &input.operation_id,
        )
        .await?;
        tx.commit().await?;
        return Ok(result);
    }
    expected(&current, &input)?;
    factors::recent(&mut tx, account).await?;
    factors::profiles::contact_mutable(&mut tx, &account.id).await?;
    tx.rollback().await?;
    // Global quota precedes business locks, in its own durable transaction.
    crate::email_delivery::admit(app, account, &input, peer).await?;
    let mut tx = app.pool.begin().await?;
    let current = source(&mut tx, account).await?;
    scoped(&current, &input.context)?;
    if let Some(saved) = find(&mut tx, &current, &hash).await? {
        if saved.address != input.address
            || saved.email_version != input.expected_version
            || saved.requested_version != input.verification_version
        {
            return Err(Error::conflict());
        }
        let result = view(
            &mut tx,
            &current,
            &saved,
            &input.verification_id,
            &input.operation_id,
        )
        .await?;
        tx.commit().await?;
        return Ok(result);
    }
    expected(&current, &input)?;
    factors::recent(&mut tx, account).await?;
    factors::profiles::contact_mutable(&mut tx, &account.id).await?;
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM email_verifications WHERE device_id=$1 AND (operation_id=$2 OR requested_version=$3))").bind(&current.context.device_id).bind(&input.operation_id).bind(&current.head).fetch_one(&mut *tx).await?;
    if exists {
        return Err(Error::conflict());
    }
    // Queue budget is last, after user/device/verification locks in every producer.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('rv-email-outbox-budget',0))")
        .execute(&mut *tx)
        .await?;
    let queued:i64=sqlx::query_scalar("SELECT (SELECT count(*) FROM email_outbox WHERE payload_cipher IS NOT NULL AND sent_at IS NULL AND expires_at>clock_timestamp())+(SELECT count(*) FROM factor_email_outbox WHERE payload_cipher IS NOT NULL AND sent_at IS NULL AND expires_at>clock_timestamp())").fetch_one(&mut *tx).await?;
    if queued >= 1000 {
        return Err(Error::throttled("email_queue_limit", 60));
    }
    // The shared budget may have waited after the first authority check.
    // Re-read actual time under our existing locks before creating any mail.
    auth::lock_active(&mut tx, account).await?;
    factors::recent(&mut tx, account).await?;
    sqlx::query("UPDATE session_devices SET email_verification_claimed=true WHERE id=$1")
        .bind(&current.context.device_id)
        .execute(&mut *tx)
        .await?;
    let code = crate::email_delivery::new_code();
    sqlx::query("INSERT INTO email_verifications(token_hash,user_id,device_id,operation_id,instance_id,data_epoch,activation_version,factor_version,email_version,requested_version,address,code_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+interval '15 minutes')")
        .bind(&hash).bind(&account.id).bind(&current.context.device_id).bind(&input.operation_id).bind(&current.context.instance_id).bind(&current.context.data_epoch).bind(&current.activation).bind(&current.factor).bind(&current.version).bind(&current.head).bind(&input.address).bind(code_hash(&input.verification_id,&code)).execute(&mut *tx).await?;
    let saved = find(&mut tx, &current, &hash)
        .await?
        .ok_or_else(Error::internal)?;
    crate::email_delivery::enqueue(app, &mut tx, &hash, &code).await?;
    let result = view(
        &mut tx,
        &current,
        &saved,
        &input.verification_id,
        &input.operation_id,
    )
    .await?;
    tx.commit().await?;
    Ok(result)
}
pub(crate) async fn resume(
    app: &App,
    account: &Account,
    input: ResumeEmailVerification,
) -> Result<EmailVerificationStep> {
    intent(&input.verification_id, &input.operation_id, &input.context)?;
    let mut tx = app.pool.begin().await?;
    let current = source(&mut tx, account).await?;
    scoped(&current, &input.context)?;
    let saved = find(&mut tx, &current, &auth::hash_token(&input.verification_id))
        .await?
        .ok_or_else(rejected)?;
    let result = view(
        &mut tx,
        &current,
        &saved,
        &input.verification_id,
        &input.operation_id,
    )
    .await?;
    tx.commit().await?;
    Ok(result)
}
fn code_hash(candidate: &str, code: &str) -> String {
    auth::hash_token(&format!("rv-email-code:{candidate}:{code}"))
}
pub(crate) async fn confirm(
    app: &App,
    account: &Account,
    input: ConfirmEmailVerification,
) -> Result<EmailVerificationStep> {
    intent(&input.verification_id, &input.operation_id, &input.context)?;
    if input.code.len() > 128 {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let current = source(&mut tx, account).await?;
    scoped(&current, &input.context)?;
    let saved = find(&mut tx, &current, &auth::hash_token(&input.verification_id))
        .await?
        .ok_or_else(rejected)?;
    let result = view(
        &mut tx,
        &current,
        &saved,
        &input.verification_id,
        &input.operation_id,
    )
    .await?;
    if saved.verified_at.is_some() {
        tx.commit().await?;
        return Ok(result);
    }
    factors::recent(&mut tx, account).await?;
    factors::profiles::contact_mutable(&mut tx, &account.id).await?;
    if !bool::from(
        saved
            .code_hash
            .as_bytes()
            .ct_eq(code_hash(&input.verification_id, &input.code).as_bytes()),
    ) {
        sqlx::query("UPDATE email_verifications SET attempts=attempts+1 WHERE token_hash=$1")
            .bind(&saved.token_hash)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Err(rejected());
    }
    let version = auth::random_token();
    let head = auth::random_token();
    let now = clock(&mut tx).await?;
    if saved.expires_at <= now {
        return Err(rejected());
    }
    sqlx::query("INSERT INTO account_emails(user_id,address,verified_at) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET address=excluded.address,verified_at=excluded.verified_at").bind(&account.id).bind(&saved.address).bind(now).execute(&mut *tx).await?;
    sqlx::query("UPDATE users SET email_version=$2 WHERE id=$1")
        .bind(&account.id)
        .bind(&version)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE session_devices SET email_verification_version=$2,email_verification_claimed=false WHERE id=$1")
        .bind(&current.context.device_id)
        .bind(&head)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE email_verifications SET verified_at=$2,committed_version=$3,committed_head=$4,receipt_expires_at=$2+interval '5 minutes' WHERE token_hash=$1").bind(&saved.token_hash).bind(now).bind(&version).bind(&head).execute(&mut *tx).await?;
    sqlx::query("UPDATE email_outbox SET payload_cipher=NULL,lease_id=NULL,lease_expires_at=NULL WHERE verification_hash=$1").bind(&saved.token_hash).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(EmailVerificationStep::Verified {
        address: saved.address,
        version,
    })
}
pub(crate) async fn retire(
    app: &App,
    account: &Account,
    input: RetireEmailVerification,
) -> Result<EmailStatus> {
    valid_context(&input.context)?;
    if !auth::identifier(&input.expected_version) || !auth::identifier(&input.verification_version)
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let mut current = source(&mut tx, account).await?;
    scoped(&current, &input.context)?;
    if current.head == input.verification_version {
        // Contact may have changed on another device; retiring this device's
        // old command head must still work without changing that contact.
        current.head = auth::random_token();
        sqlx::query("UPDATE session_devices SET email_verification_version=$2,email_verification_claimed=false WHERE id=$1")
            .bind(&current.context.device_id)
            .bind(&current.head)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM email_verifications WHERE device_id=$1 AND requested_version=$2 AND verified_at IS NULL").bind(&current.context.device_id).bind(&input.verification_version).execute(&mut *tx).await?;
    }
    let result = status_in(&mut tx, current).await?;
    tx.commit().await?;
    Ok(result)
}

#[cfg(test)]
pub(crate) mod tests;
