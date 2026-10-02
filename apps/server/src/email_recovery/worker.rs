use super::*;
#[derive(FromRow)]
struct Lease {
    request_hash: String,
    payload_cipher: Vec<u8>,
    lease_id: String,
}
async fn claim(app: &App) -> Result<Vec<Lease>> {
    Ok(sqlx::query_as("WITH ready AS (SELECT o.request_hash FROM email_recovery_outbox o JOIN current_email_recovery_requests r ON r.operation_hash=o.request_hash WHERE o.payload_cipher IS NOT NULL AND o.sent_at IS NULL AND o.expires_at>clock_timestamp() AND o.next_attempt_at<=clock_timestamp() AND o.attempts<8 AND (o.lease_expires_at IS NULL OR o.lease_expires_at<=clock_timestamp()) ORDER BY o.next_attempt_at,o.request_hash LIMIT 4 FOR UPDATE OF o SKIP LOCKED) UPDATE email_recovery_outbox o SET lease_id=$1,lease_expires_at=clock_timestamp()+interval '2 minutes',attempts=attempts+1 FROM ready WHERE o.request_hash=ready.request_hash RETURNING o.request_hash,o.payload_cipher,o.lease_id")
        .bind(auth::random_token()).fetch_all(&app.pool).await?)
}
async fn delivery(app: &App, job: Lease) -> Result<bool> {
    let current:Option<Binding>=sqlx::query_as("SELECT r.* FROM email_recovery_requests r JOIN current_email_recovery_requests c ON c.operation_hash=r.operation_hash JOIN email_recovery_outbox o ON o.request_hash=r.operation_hash WHERE o.request_hash=$1 AND o.lease_id=$2 AND o.lease_expires_at>clock_timestamp() AND o.payload_cipher IS NOT NULL AND o.sent_at IS NULL")
        .bind(&job.request_hash).bind(&job.lease_id).fetch_optional(&app.pool).await?;
    let sent = if let Some(record) = current {
        async {
            let plain = app
                .auth_key
                .as_deref()
                .ok_or_else(email::unavailable)?
                .open(&job.payload_cipher, &aad(&record))?;
            let payload: Payload = serde_json::from_slice(&plain).map_err(|_| Error::internal())?;
            if payload.address != record.address
                || !nonce(&payload.code)
                || auth::hash_token(&payload.code) != record.token_hash
            {
                return Err(Error::invalid());
            }
            app.mail
                .as_deref()
                .ok_or_else(email::unavailable)?
                .send(
                    payload.address,
                    crate::mail::Purpose::PasswordRecovery,
                    payload.code,
                )
                .await
        }
        .await
        .is_ok()
    } else {
        false
    };
    if sent {
        sqlx::query("UPDATE email_recovery_outbox SET sent_at=clock_timestamp(),payload_cipher=NULL,lease_id=NULL,lease_expires_at=NULL WHERE request_hash=$1 AND lease_id=$2 AND payload_cipher IS NOT NULL")
            .bind(job.request_hash).bind(job.lease_id).execute(&app.pool).await?;
    } else {
        sqlx::query("UPDATE email_recovery_outbox SET lease_id=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(60,attempts*5)) WHERE request_hash=$1 AND lease_id=$2")
            .bind(job.request_hash).bind(job.lease_id).execute(&app.pool).await?;
    }
    Ok(sent)
}
pub async fn drain(app: &App) -> Result<usize> {
    if app.mail.is_none() || app.auth_key.is_none() {
        return Ok(0);
    }
    let jobs = claim(app).await?;
    let outcomes =
        futures_util::future::join_all(jobs.into_iter().map(|job| delivery(app, job))).await;
    let mut sent = 0;
    for result in outcomes {
        if result? {
            sent += 1;
        }
    }
    Ok(sent)
}
