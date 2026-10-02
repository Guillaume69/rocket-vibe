//! Durable verification delivery. Claim briefly, send outside business locks,
//! retry the encrypted original payload with a fenced lease after ambiguity.
use crate::{
    App,
    auth::{self, Account},
    email,
    error::{Error, Result},
    mail::Purpose,
};
use chrono::{DateTime, Utc};
use rand_core::{OsRng, RngCore};
use rv_protocol::parity::BeginEmailVerification;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};
use std::net::IpAddr;
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    address: String,
    code: String,
}
#[derive(FromRow)]
struct Binding {
    token_hash: String,
    user_id: String,
    device_id: String,
    instance_id: String,
    data_epoch: String,
    activation_version: String,
    factor_version: String,
    email_version: String,
    requested_version: String,
    address: String,
    expires_at: DateTime<Utc>,
}
fn aad(id: &str, record: &Binding) -> Vec<u8> {
    serde_json::to_vec(&(
        "rv-email-verification-v1",
        id,
        &record.token_hash,
        &record.user_id,
        &record.device_id,
        &record.instance_id,
        &record.data_epoch,
        &record.activation_version,
        &record.factor_version,
        &record.email_version,
        &record.requested_version,
    ))
    .expect("string tuple")
}
pub(crate) fn new_code() -> Zeroizing<String> {
    // Uniform eight decimal digits, with no modulo bias.
    let value = loop {
        let value = OsRng.next_u32();
        if value < 4_200_000_000 {
            break value % 100_000_000;
        }
    };
    Zeroizing::new(format!("{value:08}"))
}
pub(crate) async fn admit(
    app: &App,
    account: &Account,
    input: &BeginEmailVerification,
    peer: Option<IpAddr>,
) -> Result<()> {
    let key = auth::hash_token(
        &serde_json::to_string(&(
            &input.context,
            &input.operation_id,
            &input.verification_id,
            &input.expected_version,
            &input.verification_version,
            &input.address,
            &account.activation_version,
        ))
        .map_err(|_| Error::invalid())?,
    );
    crate::mail_admission::admit(app, &key, &account.id, &input.address, peer).await
}
pub(crate) async fn enqueue(
    app: &App,
    tx: &mut Transaction<'_, Postgres>,
    hash: &str,
    code: &str,
) -> Result<()> {
    let record: Binding = sqlx::query_as("SELECT * FROM email_verifications WHERE token_hash=$1")
        .bind(hash)
        .fetch_one(&mut **tx)
        .await?;
    let id = auth::random_token()[..24].to_owned();
    let payload = Zeroizing::new(
        serde_json::to_vec(&Payload {
            address: record.address.clone(),
            code: code.to_owned(),
        })
        .map_err(|_| Error::internal())?,
    );
    let cipher = app
        .auth_key
        .as_deref()
        .ok_or_else(email::unavailable)?
        .seal(&payload, &aad(&id, &record))?;
    sqlx::query("INSERT INTO email_outbox(id,verification_hash,payload_cipher,expires_at) VALUES($1,$2,$3,$4)").bind(id).bind(hash).bind(cipher).bind(record.expires_at).execute(&mut **tx).await?;
    Ok(())
}
#[derive(FromRow)]
struct Lease {
    id: String,
    verification_hash: String,
    payload_cipher: Vec<u8>,
    lease_id: String,
}
async fn claim(app: &App) -> Result<Vec<Lease>> {
    let lease = auth::random_token();
    // Current authorization only filters claims. No user/instance lock spans SMTP.
    Ok(sqlx::query_as("WITH ready AS (SELECT o.id FROM email_outbox o JOIN email_verifications v ON v.token_hash=o.verification_hash JOIN users u ON u.id=v.user_id JOIN session_devices d ON d.id=v.device_id JOIN instance i ON i.singleton WHERE o.payload_cipher IS NOT NULL AND o.sent_at IS NULL AND o.expires_at>clock_timestamp() AND o.next_attempt_at<=clock_timestamp() AND o.attempts<8 AND (o.lease_expires_at IS NULL OR o.lease_expires_at<=clock_timestamp()) AND v.verified_at IS NULL AND v.attempts<5 AND v.instance_id=i.instance_id AND v.data_epoch=i.data_epoch AND v.activation_version=u.activation_version AND NOT u.disabled AND v.factor_version=u.factor_version AND v.email_version=u.email_version AND v.requested_version=d.email_verification_version AND EXISTS(SELECT 1 FROM sessions s WHERE s.device_id=d.id AND s.expires_at>clock_timestamp()) ORDER BY o.next_attempt_at,o.id LIMIT 4 FOR UPDATE OF o SKIP LOCKED) UPDATE email_outbox o SET lease_id=$1,lease_expires_at=clock_timestamp()+interval '2 minutes',attempts=attempts+1 FROM ready WHERE o.id=ready.id RETURNING o.id,o.verification_hash,o.payload_cipher,o.lease_id")
        .bind(lease).fetch_all(&app.pool).await?)
}
async fn delivery(app: &App, lease: Lease) -> Result<bool> {
    let record:Option<Binding>=sqlx::query_as("SELECT v.* FROM email_verifications v JOIN users u ON u.id=v.user_id JOIN session_devices d ON d.id=v.device_id JOIN instance i ON i.singleton JOIN email_outbox o ON o.verification_hash=v.token_hash WHERE v.token_hash=$1 AND o.id=$2 AND o.lease_id=$3 AND o.lease_expires_at>clock_timestamp() AND o.payload_cipher IS NOT NULL AND o.sent_at IS NULL AND v.expires_at>clock_timestamp() AND v.verified_at IS NULL AND v.attempts<5 AND v.instance_id=i.instance_id AND v.data_epoch=i.data_epoch AND v.activation_version=u.activation_version AND NOT u.disabled AND v.factor_version=u.factor_version AND v.email_version=u.email_version AND v.requested_version=d.email_verification_version AND EXISTS(SELECT 1 FROM sessions s WHERE s.device_id=d.id AND s.expires_at>clock_timestamp())")
        .bind(&lease.verification_hash).bind(&lease.id).bind(&lease.lease_id).fetch_optional(&app.pool).await?;
    let sent = if let Some(record) = record {
        let result = async {
            let plain = app
                .auth_key
                .as_deref()
                .ok_or_else(email::unavailable)?
                .open(&lease.payload_cipher, &aad(&lease.id, &record))?;
            let payload: Payload =
                serde_json::from_slice(&plain).map_err(|_| email::unavailable())?;
            if payload.address != record.address
                || payload.code.len() != 8
                || !payload.code.bytes().all(|b| b.is_ascii_digit())
            {
                return Err(email::unavailable());
            }
            app.mail
                .as_deref()
                .ok_or_else(email::unavailable)?
                .send(payload.address, Purpose::VerifyAddress, payload.code)
                .await
        }
        .await;
        result.is_ok()
    } else {
        false
    };
    if sent {
        sqlx::query("UPDATE email_outbox SET sent_at=clock_timestamp(),payload_cipher=NULL,lease_id=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_id=$2 AND payload_cipher IS NOT NULL")
            .bind(&lease.id).bind(&lease.lease_id).execute(&app.pool).await?;
    } else {
        sqlx::query("UPDATE email_outbox SET lease_id=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(60,attempts*5)) WHERE id=$1 AND lease_id=$2")
            .bind(&lease.id).bind(&lease.lease_id).execute(&app.pool).await?;
    }
    Ok(sent)
}
/// One bounded worker iteration. Multiple processes use independent fenced
/// leases; every retry reads the same encrypted message and original deadline.
pub async fn drain(app: &App) -> Result<usize> {
    if app.mail.is_none() || app.auth_key.is_none() {
        return Ok(0);
    }
    let jobs = claim(app).await?;
    let results =
        futures_util::future::join_all(jobs.into_iter().map(|job| delivery(app, job))).await;
    let mut sent = 0;
    for result in results {
        if result? {
            sent += 1;
        }
    }
    Ok(sent
        + crate::factors::email_delivery::drain(app).await?
        + crate::email_recovery::drain(app).await?)
}
