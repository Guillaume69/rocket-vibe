use super::*;

#[derive(FromRow)]
struct Lease {
    id: String,
    delivery_hash: String,
    payload_cipher: Vec<u8>,
    lease_id: String,
}
async fn claim(app: &App) -> Result<Vec<Lease>> {
    Ok(sqlx::query_as("WITH ready AS (SELECT o.id FROM factor_email_outbox o JOIN current_factor_email_deliveries v ON v.token_hash=o.delivery_hash WHERE o.payload_cipher IS NOT NULL AND o.sent_at IS NULL AND o.expires_at>clock_timestamp() AND o.next_attempt_at<=clock_timestamp() AND o.attempts<8 AND (o.lease_expires_at IS NULL OR o.lease_expires_at<=clock_timestamp()) ORDER BY o.next_attempt_at,o.id LIMIT 4 FOR UPDATE OF o SKIP LOCKED) UPDATE factor_email_outbox o SET lease_id=$1,lease_expires_at=clock_timestamp()+interval '2 minutes',attempts=attempts+1 FROM ready WHERE o.id=ready.id RETURNING o.id,o.delivery_hash,o.payload_cipher,o.lease_id")
        .bind(auth::random_token()).fetch_all(&app.pool).await?)
}
async fn delivery(app: &App, lease: Lease) -> Result<bool> {
    let record:Option<Record>=sqlx::query_as("SELECT v.* FROM factor_email_deliveries v JOIN current_factor_email_deliveries c ON c.token_hash=v.token_hash JOIN factor_email_outbox o ON o.delivery_hash=v.token_hash WHERE o.id=$1 AND o.delivery_hash=$2 AND o.lease_id=$3 AND o.lease_expires_at>clock_timestamp() AND o.payload_cipher IS NOT NULL AND o.sent_at IS NULL")
        .bind(&lease.id).bind(&lease.delivery_hash).bind(&lease.lease_id).fetch_optional(&app.pool).await?;
    let sent = if let Some(record) = record {
        async {
            let check:(Vec<u8>,String,String)=sqlx::query_as("SELECT key_check_cipher,version,email_version FROM user_email_factors WHERE user_id=$1")
                .bind(&record.source.user_id).fetch_one(&app.pool).await?;
            if check.1!=record.source.profile_id || check.2!=record.source.email_version {return Err(rejected());}
            let marker=key(app)?.open(&check.0,&profiles::email_aad(&record.source.instance_id,&record.source.user_id,&check.1,&check.2))?;
            if marker.as_slice()!=profiles::EMAIL_KEY_CHECK {return Err(factor_crypto::unavailable());}
            let plain=key(app)?.open(&lease.payload_cipher,&aad(&record))?;
            let payload:Payload=serde_json::from_slice(&plain).map_err(|_|factor_crypto::unavailable())?;
            if payload.address!=record.source.address || payload.code.len()!=8 || !payload.code.bytes().all(|v|v.is_ascii_digit()) {return Err(factor_crypto::unavailable());}
            app.mail.as_deref().ok_or_else(crate::email::unavailable)?.send(payload.address,crate::mail::Purpose::Authentication,payload.code).await
        }.await.is_ok()
    } else {
        false
    };
    if sent {
        sqlx::query("UPDATE factor_email_outbox SET sent_at=clock_timestamp(),payload_cipher=NULL,lease_id=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_id=$2 AND payload_cipher IS NOT NULL")
            .bind(&lease.id).bind(&lease.lease_id).execute(&app.pool).await?;
    } else {
        sqlx::query("UPDATE factor_email_outbox SET lease_id=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(60,attempts*5)) WHERE id=$1 AND lease_id=$2")
            .bind(&lease.id).bind(&lease.lease_id).execute(&app.pool).await?;
    }
    Ok(sent)
}
pub(crate) async fn drain(app: &App) -> Result<usize> {
    if app.mail.is_none() || app.auth_key.is_none() {
        return Ok(0);
    }
    let jobs = claim(app).await?;
    let results =
        futures_util::future::join_all(jobs.into_iter().map(|job| delivery(app, job))).await;
    let mut count = 0;
    for result in results {
        if result? {
            count += 1;
        }
    }
    Ok(count)
}
