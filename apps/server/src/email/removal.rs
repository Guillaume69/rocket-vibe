//! Removing a contact is independent of SMTP. A retired contact version cannot
//! be reused after receipt pruning; replay never applies the removal again.
use super::{Source, clock, scoped, source, status_in, valid_context};
use crate::{
    App,
    auth::{self, Account},
    error::{Error, Result},
    factors,
};
use chrono::{DateTime, Utc};
use rv_protocol::parity::{
    EmailRemovalReceipt, EmailStatus, RemoveVerifiedEmail, ResumeEmailRemoval, RetireEmailRemoval,
};
use sqlx::{FromRow, Postgres, Transaction};

fn rejected() -> Error {
    Error::new(
        axum::http::StatusCode::BAD_REQUEST,
        "email_removal_rejected",
    )
}
fn operation(
    operation: &str,
    context: &rv_protocol::parity::ReauthenticationContext,
) -> Result<()> {
    if !auth::identifier(operation) {
        return Err(Error::invalid());
    }
    valid_context(context)
}
fn hash(operation: &str) -> String {
    auth::hash_token(&format!("rv-email-removal:{operation}"))
}
#[derive(FromRow)]
struct Receipt {
    instance_id: String,
    data_epoch: String,
    activation_version: String,
    factor_version: String,
    expected_version: String,
    requested_head: String,
    committed_version: String,
    committed_head: String,
    expires_at: DateTime<Utc>,
}
async fn find(
    tx: &mut Transaction<'_, Postgres>,
    source: &Source,
    operation: &str,
) -> Result<Option<Receipt>> {
    Ok(sqlx::query_as("SELECT * FROM email_removals WHERE device_id=$1 AND user_id=$2 AND operation_hash=$3 FOR UPDATE")
        .bind(&source.context.device_id).bind(&source.context.user_id).bind(hash(operation)).fetch_optional(&mut **tx).await?)
}
async fn view(
    tx: &mut Transaction<'_, Postgres>,
    source: &Source,
    saved: Receipt,
) -> Result<EmailRemovalReceipt> {
    if saved.instance_id != source.context.instance_id
        || saved.data_epoch != source.context.data_epoch
        || saved.activation_version != source.activation
        || saved.factor_version != source.factor
        || saved.committed_version != source.version
        || saved.committed_head != source.head
        || saved.expires_at <= clock(tx).await?
    {
        return Err(rejected());
    }
    let present: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_emails WHERE user_id=$1)")
            .bind(&source.context.user_id)
            .fetch_one(&mut **tx)
            .await?;
    if present {
        return Err(rejected());
    }
    Ok(EmailRemovalReceipt {
        version: saved.committed_version,
        verification_version: saved.committed_head,
        context: source.context.clone(),
    })
}
pub(crate) async fn begin(
    app: &App,
    account: &Account,
    input: RemoveVerifiedEmail,
) -> Result<EmailRemovalReceipt> {
    operation(&input.operation_id, &input.context)?;
    if !auth::identifier(&input.expected_version) || !auth::identifier(&input.verification_version)
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let current = source(&mut tx, account).await?;
    scoped(&current, &input.context)?;
    if let Some(saved) = find(&mut tx, &current, &input.operation_id).await? {
        if saved.expected_version != input.expected_version
            || saved.requested_head != input.verification_version
        {
            return Err(Error::conflict());
        }
        let result = view(&mut tx, &current, saved).await?;
        tx.commit().await?;
        return Ok(result);
    }
    if current.version != input.expected_version || current.head != input.verification_version {
        return Err(rejected());
    }
    let present: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_emails WHERE user_id=$1)")
            .bind(&account.id)
            .fetch_one(&mut *tx)
            .await?;
    if !present {
        return Err(rejected());
    }
    factors::recent(&mut tx, account).await?;
    // User/device -> verification -> outbox locks match producers. Acquire all
    // rows before rechecking the real session/proof deadlines; SMTP owns none.
    sqlx::query("SELECT token_hash FROM email_verifications WHERE user_id=$1 FOR UPDATE")
        .bind(&account.id)
        .fetch_all(&mut *tx)
        .await?;
    sqlx::query("SELECT o.id FROM email_outbox o JOIN email_verifications v ON v.token_hash=o.verification_hash WHERE v.user_id=$1 FOR UPDATE OF o")
        .bind(&account.id).fetch_all(&mut *tx).await?;
    let current = source(&mut tx, account).await?;
    scoped(&current, &input.context)?;
    factors::recent(&mut tx, account).await?;
    let version = auth::random_token();
    let head = auth::random_token();
    let now = clock(&mut tx).await?;
    sqlx::query("DELETE FROM account_emails WHERE user_id=$1")
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    // Delete former addresses and sealed code payloads, not just their jobs.
    sqlx::query("DELETE FROM email_verifications WHERE user_id=$1")
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE users SET email_version=$2 WHERE id=$1")
        .bind(&account.id)
        .bind(&version)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE session_devices SET email_verification_version=$2,email_verification_claimed=false WHERE id=$1")
        .bind(&current.context.device_id).bind(&head).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO email_removals(user_id,device_id,operation_hash,instance_id,data_epoch,activation_version,factor_version,expected_version,requested_head,committed_version,committed_head,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12+interval '5 minutes')")
        .bind(&account.id).bind(&current.context.device_id).bind(hash(&input.operation_id))
        .bind(&current.context.instance_id).bind(&current.context.data_epoch).bind(&current.activation).bind(&current.factor)
        .bind(&input.expected_version).bind(&input.verification_version).bind(&version).bind(&head).bind(now)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(EmailRemovalReceipt {
        version,
        verification_version: head,
        context: current.context,
    })
}
pub(crate) async fn resume(
    app: &App,
    account: &Account,
    input: ResumeEmailRemoval,
) -> Result<EmailRemovalReceipt> {
    operation(&input.operation_id, &input.context)?;
    let mut tx = app.pool.begin().await?;
    let current = source(&mut tx, account).await?;
    scoped(&current, &input.context)?;
    let saved = find(&mut tx, &current, &input.operation_id)
        .await?
        .ok_or_else(rejected)?;
    let result = view(&mut tx, &current, saved).await?;
    tx.commit().await?;
    Ok(result)
}

/// A removal was approved against this contact AND this device head. Retiring
/// an old snapshot cannot cancel a later verification after a contact change.
pub(crate) async fn retire(
    app: &App,
    account: &Account,
    input: RetireEmailRemoval,
) -> Result<EmailStatus> {
    valid_context(&input.context)?;
    if !auth::identifier(&input.expected_version) || !auth::identifier(&input.verification_version)
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let mut current = source(&mut tx, account).await?;
    scoped(&current, &input.context)?;
    if current.version == input.expected_version && current.head == input.verification_version {
        sqlx::query("SELECT token_hash FROM email_verifications WHERE device_id=$1 AND requested_version=$2 AND email_version=$3 AND verified_at IS NULL FOR UPDATE")
            .bind(&current.context.device_id).bind(&input.verification_version).bind(&input.expected_version).fetch_all(&mut *tx).await?;
        sqlx::query("SELECT o.id FROM email_outbox o JOIN email_verifications v ON v.token_hash=o.verification_hash WHERE v.device_id=$1 AND v.requested_version=$2 AND v.email_version=$3 AND v.verified_at IS NULL FOR UPDATE OF o")
            .bind(&current.context.device_id).bind(&input.verification_version).bind(&input.expected_version).fetch_all(&mut *tx).await?;
        current = source(&mut tx, account).await?;
        current.head = auth::random_token();
        sqlx::query("UPDATE session_devices SET email_verification_version=$2,email_verification_claimed=false WHERE id=$1")
            .bind(&current.context.device_id).bind(&current.head).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM email_verifications WHERE device_id=$1 AND requested_version=$2 AND email_version=$3 AND verified_at IS NULL")
            .bind(&current.context.device_id).bind(&input.verification_version).bind(&input.expected_version).execute(&mut *tx).await?;
    }
    let value = status_in(&mut tx, current).await?;
    tx.commit().await?;
    Ok(value)
}

#[cfg(test)]
mod tests;
