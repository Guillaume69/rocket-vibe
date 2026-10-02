//! Anonymous requests have an identical public acknowledgement. Only the
//! original verified contact can receive an encrypted, high-entropy code.
mod worker;
use crate::{
    App, auth, email,
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
use rv_protocol::parity::{EmailRecoveryRequested, RequestEmailRecovery};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::net::IpAddr;
pub use worker::drain;
use zeroize::Zeroizing;

#[derive(Clone, PartialEq, Eq, FromRow)]
struct Contact {
    id: String,
    activation_version: String,
    email_version: String,
    address: String,
}
#[derive(FromRow)]
struct Binding {
    operation_hash: String,
    binding_hash: String,
    instance_id: String,
    data_epoch: String,
    user_id: String,
    activation_version: String,
    email_version: String,
    address: String,
    token_hash: String,
    expires_at: DateTime<Utc>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    address: String,
    code: String,
}
fn nonce(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn aad(record: &Binding) -> Vec<u8> {
    serde_json::to_vec(&(
        "rv-email-password-recovery-v1",
        &record.operation_hash,
        &record.binding_hash,
        &record.instance_id,
        &record.data_epoch,
        &record.user_id,
        &record.activation_version,
        &record.email_version,
        &record.address,
        &record.token_hash,
        record.expires_at,
    ))
    .expect("string tuple")
}
fn verified(contact: &Contact) -> bool {
    crate::mail::normalized_address(&contact.address)
        .is_ok_and(|address| address == contact.address)
}
pub async fn request(
    app: &App,
    input: RequestEmailRecovery,
    peer: Option<IpAddr>,
) -> Result<EmailRecoveryRequested> {
    if !nonce(&input.operation_id)
        || [&input.username, &input.instance_id, &input.data_epoch]
            .iter()
            .any(|v| !auth::identifier(v))
    {
        return Err(Error::invalid());
    }
    let key = app.auth_key.as_deref().ok_or_else(email::unavailable)?;
    if app.mail.is_none() {
        return Err(email::unavailable());
    }
    // SMTP quotas alone cannot bound anonymous suppressed receipts, because
    // mail-limited requests are acknowledged too. Share the public auth budget.
    crate::limits::auth_attempt(
        app,
        &input.username,
        peer,
        Some(("email-recovery", &input.operation_id)),
    )
    .await?;
    let operation_hash = auth::hash_token(&format!(
        "rv-email-recovery-request-v1:{}",
        input.operation_id
    ));
    let binding_hash = auth::hash_token(
        &serde_json::to_string(&(&input.instance_id, &input.data_epoch, &input.username))
            .map_err(|_| Error::invalid())?,
    );
    let (instance, epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton")
            .fetch_one(&app.pool)
            .await?;
    if instance != input.instance_id || epoch != input.data_epoch {
        return Err(Error::conflict());
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM email_recovery_requests WHERE operation_hash=$1)",
    )
    .bind(&operation_hash)
    .fetch_one(&app.pool)
    .await?;
    if exists {
        return Ok(EmailRecoveryRequested { accepted: true });
    }
    let original:Option<Contact>=sqlx::query_as("SELECT u.id,u.activation_version,u.email_version,e.address FROM users u JOIN account_emails e ON e.user_id=u.id WHERE u.username=$1 AND NOT u.disabled")
        .bind(&input.username).fetch_optional(&app.pool).await?;
    let original = original.filter(verified);
    // Unknown/unverified names use the same durable SMTP admission path and
    // counters. Their synthetic budget keys never become a message recipient.
    let anonymous = auth::hash_token(&format!("rv-email-recovery-unknown:{}", input.username));
    let user = original
        .as_ref()
        .map(|s| s.id.as_str())
        .unwrap_or(&anonymous);
    let synthetic = format!("{anonymous}@invalid.example");
    let address = original
        .as_ref()
        .map(|s| s.address.as_str())
        .unwrap_or(&synthetic);
    let admission = auth::hash_token(&format!("rv-email-recovery-admission-v1:{operation_hash}"));
    let admitted = match crate::mail_admission::admit(app, &admission, user, address, peer).await {
        Ok(()) => true,
        Err(e) if e.status == axum::http::StatusCode::TOO_MANY_REQUESTS => false,
        Err(e) => return Err(e),
    };
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    // Serialize bounded public receipts before instance/account locks; the
    // shared outbox budget is acquired last, as in both existing producers.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('rv-email-recovery-requests',0))")
        .execute(&mut *tx)
        .await?;
    let (instance_id, epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut *tx)
            .await?;
    if instance_id != input.instance_id || epoch != input.data_epoch {
        return Err(Error::conflict());
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM email_recovery_requests WHERE operation_hash=$1)",
    )
    .bind(&operation_hash)
    .fetch_one(&mut *tx)
    .await?;
    if exists {
        // A changed binding is also a generic no-op. Public callers cannot
        // inspect, revive or replace the original private request.
        tx.commit().await?;
        return Ok(EmailRecoveryRequested { accepted: true });
    }
    let receipts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM email_recovery_requests WHERE expires_at>clock_timestamp()",
    )
    .fetch_one(&mut *tx)
    .await?;
    if receipts >= 1000 {
        return Err(Error::throttled("email_recovery_limit", 60));
    }
    let current:Option<Contact>=sqlx::query_as("SELECT u.id,u.activation_version,u.email_version,e.address FROM users u JOIN account_emails e ON e.user_id=u.id WHERE u.username=$1 AND NOT u.disabled FOR NO KEY UPDATE OF u")
        .bind(&input.username).fetch_optional(&mut *tx).await?;
    let current = current.filter(verified);
    let source = if admitted && current == original {
        current
    } else {
        None
    };
    let (total,account):(i64,i64)=sqlx::query_as("SELECT count(*),count(*) FILTER(WHERE user_id=$1) FROM account_recovery_codes WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() AND data_epoch=$2 AND activation_version=(SELECT activation_version FROM users WHERE id=account_recovery_codes.user_id AND NOT disabled) AND (email_version IS NULL OR (email_instance_id=(SELECT instance_id FROM instance WHERE singleton) AND email_version=(SELECT email_version FROM users WHERE id=account_recovery_codes.user_id) AND EXISTS(SELECT 1 FROM account_emails WHERE user_id=account_recovery_codes.user_id)))")
        .bind(source.as_ref().map(|s|&s.id)).bind(&epoch).fetch_one(&mut *tx).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('rv-email-outbox-budget',0))")
        .execute(&mut *tx)
        .await?;
    let queued:i64=sqlx::query_scalar("SELECT (SELECT count(*) FROM email_outbox WHERE payload_cipher IS NOT NULL AND sent_at IS NULL AND expires_at>clock_timestamp())+(SELECT count(*) FROM factor_email_outbox WHERE payload_cipher IS NOT NULL AND sent_at IS NULL AND expires_at>clock_timestamp())+(SELECT count(*) FROM email_recovery_outbox WHERE payload_cipher IS NOT NULL AND sent_at IS NULL AND expires_at>clock_timestamp())").fetch_one(&mut *tx).await?;
    let source = source.filter(|_| total < 1000 && account < 3 && queued < 1000);
    let mut code = None;
    let token_hash = if let Some(source) = &source {
        let token = Zeroizing::new(auth::random_token());
        let hash = auth::hash_token(&token);
        sqlx::query("INSERT INTO account_recovery_codes(id,token_hash,user_id,data_epoch,activation_version,email_version,email_instance_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 hour')")
            .bind(auth::random_token()[..24].to_owned()).bind(&hash).bind(&source.id).bind(&epoch).bind(&source.activation_version).bind(&source.email_version).bind(&instance_id).execute(&mut *tx).await?;
        code = Some(token);
        Some(hash)
    } else {
        None
    };
    sqlx::query("INSERT INTO email_recovery_requests(operation_hash,binding_hash,instance_id,data_epoch,user_id,activation_version,email_version,address,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '1 hour')")
        .bind(&operation_hash).bind(&binding_hash).bind(instance_id).bind(epoch).bind(source.as_ref().map(|s|&s.id)).bind(source.as_ref().map(|s|&s.activation_version)).bind(source.as_ref().map(|s|&s.email_version)).bind(source.as_ref().map(|s|&s.address)).bind(token_hash).execute(&mut *tx).await?;
    if let Some(code) = code {
        let record: Binding =
            sqlx::query_as("SELECT * FROM email_recovery_requests WHERE operation_hash=$1")
                .bind(&operation_hash)
                .fetch_one(&mut *tx)
                .await?;
        let plain = Zeroizing::new(
            serde_json::to_vec(&Payload {
                address: record.address.clone(),
                code: code.to_string(),
            })
            .map_err(|_| Error::internal())?,
        );
        let cipher = key.seal(&plain, &aad(&record))?;
        sqlx::query("INSERT INTO email_recovery_outbox(request_hash,payload_cipher,expires_at) VALUES($1,$2,$3)").bind(&operation_hash).bind(cipher).bind(record.expires_at).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(EmailRecoveryRequested { accepted: true })
}
#[cfg(test)]
mod tests;
