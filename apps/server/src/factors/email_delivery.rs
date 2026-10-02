//! Explicit OTP deliveries on an existing, unextended authentication challenge.
//! All resends use its original sealed code. Receipt recovery never enqueues.
use super::*;
use rv_protocol::parity::{EmailDeliveryState, FactorEmailDelivery, RequestFactorEmail};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

mod worker;
pub(crate) use worker::drain;

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Login,
    Reauthentication,
}
impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Login => "login",
            Self::Reauthentication => "reauth",
        }
    }
}
#[derive(Clone, Serialize, FromRow, PartialEq)]
struct Source {
    user_id: String,
    device_id: Option<String>,
    purpose: String,
    challenge_hash: String,
    instance_id: String,
    data_epoch: String,
    activation_version: String,
    factor_version: String,
    email_version: String,
    profile_id: String,
    proof_version: Option<String>,
    address: String,
    expires_at: DateTime<Utc>,
}
#[derive(FromRow)]
struct Record {
    token_hash: String,
    operation_id: String,
    code_hash: String,
    payload_cipher: Option<Vec<u8>>,
    #[sqlx(flatten)]
    source: Source,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    address: String,
    code: String,
}
fn aad(record: &Record) -> Vec<u8> {
    serde_json::to_vec(&(
        "rv-factor-email-delivery-v1",
        &record.token_hash,
        &record.operation_id,
        &record.source,
        &record.code_hash,
    ))
    .expect("private binding")
}
fn code_hash(kind: &str, challenge: &str, code: &str) -> String {
    // The raw challenge is an unlogged random secret, absent from SQL. The
    // stored hash alone cannot salt a brute-force search for the decimal OTP.
    auth::hash_token(
        &serde_json::to_string(&("rv-factor-email-code-v1", kind, challenge, code))
            .expect("string tuple"),
    )
}
fn intent(input: &RequestFactorEmail) -> Result<()> {
    if !bearer_candidate(&input.challenge_id)
        || !bearer_candidate(&input.delivery_id)
        || input.challenge_id == input.delivery_id
        || !auth::identifier(&input.operation_id)
    {
        return Err(Error::invalid());
    }
    Ok(())
}
async fn clock(tx: &mut Transaction<'_, Postgres>) -> Result<DateTime<Utc>> {
    Ok(sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?)
}
async fn source(
    tx: &mut Transaction<'_, Postgres>,
    input: &RequestFactorEmail,
    account: Option<&Account>,
    kind: Kind,
) -> Result<Source> {
    let hash = auth::hash_token(&input.challenge_id);
    let (instance, epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut **tx)
            .await?;
    let user = match kind {
        Kind::Login => sqlx::query_scalar::<_, String>(
            "SELECT user_id FROM auth_challenges WHERE token_hash=$1",
        )
        .bind(&hash)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(rejected)?,
        Kind::Reauthentication => {
            let account = account.ok_or_else(rejected)?;
            auth::lock_active(tx, account).await?;
            account.id.clone()
        }
    };
    let (activation,factor,contact): (String,String,String)=sqlx::query_as("SELECT activation_version,factor_version,email_version FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE")
        .bind(&user).fetch_optional(&mut **tx).await?.ok_or_else(rejected)?;
    let (device, proof, session_expiry) = match kind {
        Kind::Login => (None, None, None),
        Kind::Reauthentication => {
            let account = account.ok_or_else(rejected)?;
            let (device,proof,expiry):(String,String,DateTime<Utc>)=sqlx::query_as("SELECT d.id,d.reauthentication_version,s.expires_at FROM session_devices d JOIN sessions s ON s.device_id=d.id WHERE s.token_hash=$1 AND d.user_id=$2 FOR NO KEY UPDATE OF d")
                .bind(&account.session_hash).bind(&user).fetch_optional(&mut **tx).await?.ok_or_else(rejected)?;
            (Some(device), Some(proof), Some(expiry))
        }
    };
    let expires = match kind {
        Kind::Login => {
            let (saved_epoch,saved_activation,saved_factor,expiry,attempts,accepted):(String,String,String,DateTime<Utc>,i32,bool)=sqlx::query_as("SELECT data_epoch,activation_version,factor_version,expires_at,attempts,accepted_operation IS NOT NULL FROM auth_challenges WHERE token_hash=$1 AND user_id=$2 FOR UPDATE")
                .bind(&hash).bind(&user).fetch_optional(&mut **tx).await?.ok_or_else(rejected)?;
            if saved_epoch != epoch
                || saved_activation != activation
                || saved_factor != factor
                || attempts >= 5
                || accepted
            {
                return Err(rejected());
            }
            expiry
        }
        Kind::Reauthentication => {
            let (saved_instance,saved_epoch,saved_activation,saved_factor,saved_proof,expiry,attempts,accepted):(String,String,String,String,String,DateTime<Utc>,i32,bool)=sqlx::query_as("SELECT instance_id,data_epoch,activation_version,factor_version,requested_version,expires_at,attempts,authenticated_at IS NOT NULL FROM reauthentication_challenges WHERE token_hash=$1 AND user_id=$2 AND device_id=$3 FOR UPDATE")
                .bind(&hash).bind(&user).bind(&device).fetch_optional(&mut **tx).await?.ok_or_else(rejected)?;
            if saved_instance != instance
                || saved_epoch != epoch
                || saved_activation != activation
                || saved_factor != factor
                || Some(saved_proof) != proof
                || attempts >= 5
                || accepted
            {
                return Err(rejected());
            }
            expiry
        }
    };
    let (profile_id,profile_contact,address):(String,String,String)=sqlx::query_as("SELECT f.version,f.email_version,e.address FROM user_email_factors f JOIN account_emails e ON e.user_id=f.user_id WHERE f.user_id=$1 FOR UPDATE OF f")
        .bind(&user).fetch_optional(&mut **tx).await?.ok_or_else(rejected)?;
    let now = clock(tx).await?;
    if profile_contact != contact || expires <= now || session_expiry.is_some_and(|v| v <= now) {
        return Err(rejected());
    }
    Ok(Source {
        user_id: user,
        device_id: device,
        purpose: kind.name().into(),
        challenge_hash: hash,
        instance_id: instance,
        data_epoch: epoch,
        activation_version: activation,
        factor_version: factor,
        email_version: contact,
        profile_id,
        proof_version: proof,
        address,
        expires_at: expires,
    })
}
async fn find(tx: &mut Transaction<'_, Postgres>, hash: &str) -> Result<Option<Record>> {
    Ok(
        sqlx::query_as("SELECT * FROM factor_email_deliveries WHERE token_hash=$1 FOR UPDATE")
            .bind(hash)
            .fetch_optional(&mut **tx)
            .await?,
    )
}
async fn view(
    tx: &mut Transaction<'_, Postgres>,
    current: &Source,
    record: &Record,
    input: &RequestFactorEmail,
) -> Result<FactorEmailDelivery> {
    if record.source != *current || record.operation_id != input.operation_id {
        return Err(Error::conflict());
    }
    let (accepted, attempts, sending, deferred): (bool, i32, bool, bool) = sqlx::query_as(
        "SELECT sent_at IS NOT NULL,attempts,COALESCE(lease_expires_at>clock_timestamp(),false),next_attempt_at>clock_timestamp() FROM factor_email_outbox WHERE delivery_hash=$1",
    )
    .bind(&record.token_hash)
    .fetch_one(&mut **tx)
    .await?;
    let retry:i64=sqlx::query_scalar("SELECT GREATEST(0,ceil(extract(epoch FROM max(created_at)+interval '60 seconds'-clock_timestamp())))::bigint FROM factor_email_deliveries WHERE purpose=$1 AND challenge_hash=$2")
        .bind(&current.purpose).bind(&current.challenge_hash).fetch_one(&mut **tx).await?;
    Ok(FactorEmailDelivery {
        expires_at: current.expires_at.to_rfc3339(),
        delivery: if accepted {
            EmailDeliveryState::Accepted
        } else if sending {
            EmailDeliveryState::Sending
        } else if attempts >= 8 {
            EmailDeliveryState::Exhausted
        } else if deferred && attempts > 0 {
            EmailDeliveryState::Deferred
        } else {
            EmailDeliveryState::Queued
        },
        resend_after_seconds: retry.clamp(0, 60) as u32,
    })
}
async fn allowed(
    tx: &mut Transaction<'_, Postgres>,
    current: &Source,
    input: &RequestFactorEmail,
) -> Result<()> {
    let (count,retry,operation):(i64,i64,bool)=sqlx::query_as("SELECT count(*),COALESCE(GREATEST(0,ceil(extract(epoch FROM max(created_at)+interval '60 seconds'-clock_timestamp())))::bigint,0),COALESCE(bool_or(operation_id=$3),false) FROM factor_email_deliveries WHERE purpose=$1 AND challenge_hash=$2")
        .bind(&current.purpose).bind(&current.challenge_hash).bind(&input.operation_id).fetch_one(&mut **tx).await?;
    if operation {
        return Err(Error::conflict());
    }
    if count >= 3 {
        return Err(Error::throttled("email_challenge_delivery_limit", 60));
    }
    if retry > 0 {
        return Err(Error::throttled("email_resend_cooldown", retry as u64));
    }
    let occupied:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 UNION ALL SELECT 1 FROM auth_challenges WHERE token_hash=$1 UNION ALL SELECT 1 FROM reauthentication_challenges WHERE token_hash=$1)")
        .bind(auth::hash_token(&input.delivery_id)).fetch_one(&mut **tx).await?;
    if occupied {
        return Err(Error::conflict());
    }
    Ok(())
}
pub(crate) async fn resume(
    app: &App,
    input: RequestFactorEmail,
    account: Option<&Account>,
    kind: Kind,
) -> Result<FactorEmailDelivery> {
    intent(&input)?;
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let current = source(&mut tx, &input, account, kind).await?;
    let record = find(&mut tx, &auth::hash_token(&input.delivery_id))
        .await?
        .ok_or_else(rejected)?;
    let result = view(&mut tx, &current, &record, &input).await?;
    tx.commit().await?;
    Ok(result)
}
pub(crate) async fn begin(
    app: &App,
    input: RequestFactorEmail,
    account: Option<&Account>,
    kind: Kind,
    peer: Option<IpAddr>,
) -> Result<FactorEmailDelivery> {
    intent(&input)?;
    let hash = auth::hash_token(&input.delivery_id);
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let current = source(&mut tx, &input, account, kind).await?;
    if let Some(record) = find(&mut tx, &hash).await? {
        let result = view(&mut tx, &current, &record, &input).await?;
        tx.commit().await?;
        return Ok(result);
    }
    if app.mail.is_none() {
        return Err(crate::email::unavailable());
    }
    profiles::validated(app, &mut tx, &current.instance_id, &current.user_id).await?;
    allowed(&mut tx, &current, &input).await?;
    tx.rollback().await?;
    let admission = auth::hash_token(
        &serde_json::to_string(&(
            "rv-factor-email-admission-v1",
            &current,
            &input.delivery_id,
            &input.operation_id,
        ))
        .expect("string tuple"),
    );
    crate::mail_admission::admit(app, &admission, &current.user_id, &current.address, peer).await?;
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let latest = source(&mut tx, &input, account, kind).await?;
    if latest != current {
        return Err(rejected());
    }
    if let Some(record) = find(&mut tx, &hash).await? {
        let result = view(&mut tx, &latest, &record, &input).await?;
        tx.commit().await?;
        return Ok(result);
    }
    profiles::validated(app, &mut tx, &latest.instance_id, &latest.user_id).await?;
    allowed(&mut tx, &latest, &input).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('rv-email-outbox-budget',0))")
        .execute(&mut *tx)
        .await?;
    let queued:i64=sqlx::query_scalar("SELECT (SELECT count(*) FROM email_outbox WHERE payload_cipher IS NOT NULL AND sent_at IS NULL AND expires_at>clock_timestamp())+(SELECT count(*) FROM factor_email_outbox WHERE payload_cipher IS NOT NULL AND sent_at IS NULL AND expires_at>clock_timestamp())")
        .fetch_one(&mut *tx).await?;
    if queued >= 1000 {
        return Err(Error::throttled("email_queue_limit", 60));
    }
    source(&mut tx, &input, account, kind).await?;
    let previous:Option<Record>=sqlx::query_as("SELECT * FROM factor_email_deliveries WHERE purpose=$1 AND challenge_hash=$2 ORDER BY created_at,token_hash LIMIT 1 FOR UPDATE")
        .bind(&latest.purpose).bind(&latest.challenge_hash).fetch_optional(&mut *tx).await?;
    let payload = if let Some(previous) = previous {
        if previous.source != latest {
            return Err(rejected());
        }
        let plain = key(app)?.open(
            previous.payload_cipher.as_deref().ok_or_else(rejected)?,
            &aad(&previous),
        )?;
        let payload: Payload =
            serde_json::from_slice(&plain).map_err(|_| factor_crypto::unavailable())?;
        if payload.address != latest.address
            || previous.code_hash != code_hash(kind.name(), &input.challenge_id, &payload.code)
        {
            return Err(factor_crypto::unavailable());
        }
        payload
    } else {
        Payload {
            address: latest.address.clone(),
            code: crate::email_delivery::new_code().to_string(),
        }
    };
    let mut record = Record {
        token_hash: hash,
        operation_id: input.operation_id.clone(),
        code_hash: code_hash(kind.name(), &input.challenge_id, &payload.code),
        payload_cipher: None,
        source: latest,
    };
    let plain = Zeroizing::new(serde_json::to_vec(&payload).map_err(|_| Error::internal())?);
    let cipher = key(app)?.seal(&plain, &aad(&record))?;
    let s = &record.source;
    sqlx::query("INSERT INTO factor_email_deliveries(token_hash,operation_id,user_id,device_id,purpose,challenge_hash,instance_id,data_epoch,activation_version,factor_version,email_version,profile_id,proof_version,address,code_hash,payload_cipher,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)")
        .bind(&record.token_hash).bind(&record.operation_id).bind(&s.user_id).bind(&s.device_id).bind(&s.purpose).bind(&s.challenge_hash).bind(&s.instance_id).bind(&s.data_epoch).bind(&s.activation_version).bind(&s.factor_version).bind(&s.email_version).bind(&s.profile_id).bind(&s.proof_version).bind(&s.address).bind(&record.code_hash).bind(&cipher).bind(s.expires_at).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO factor_email_outbox(id,delivery_hash,payload_cipher,expires_at) VALUES($1,$2,$3,$4)")
        .bind(auth::random_token()).bind(&record.token_hash).bind(&cipher).bind(s.expires_at).execute(&mut *tx).await?;
    record.payload_cipher = Some(cipher);
    let result = view(&mut tx, &record.source, &record, &input).await?;
    tx.commit().await?;
    Ok(result)
}

/// Caller has already locked and checked the exact account/challenge authority.
#[derive(FromRow)]
struct StoredCode {
    code_hash: String,
    expires_at: DateTime<Utc>,
    consumed_at: Option<DateTime<Utc>>,
    current: bool,
}
pub(crate) async fn verify(
    tx: &mut Transaction<'_, Postgres>,
    user: &str,
    kind: Kind,
    challenge: &str,
    code: &str,
    deadline: DateTime<Utc>,
) -> Result<bool> {
    if code.len() != 8 || !code.bytes().all(|v| v.is_ascii_digit()) {
        return Ok(false);
    }
    let hash = auth::hash_token(challenge);
    let records:Vec<StoredCode>=sqlx::query_as("SELECT v.code_hash,v.expires_at,v.consumed_at,EXISTS(SELECT 1 FROM current_factor_email_deliveries c WHERE c.token_hash=v.token_hash) AS current FROM factor_email_deliveries v WHERE v.purpose=$1 AND v.challenge_hash=$2 AND v.user_id=$3 FOR UPDATE OF v")
        .bind(kind.name()).bind(&hash).bind(user).fetch_all(&mut **tx).await?;
    sqlx::query("SELECT o.id FROM factor_email_outbox o JOIN factor_email_deliveries v ON v.token_hash=o.delivery_hash WHERE v.purpose=$1 AND v.challenge_hash=$2 AND v.user_id=$3 FOR UPDATE OF o")
        .bind(kind.name()).bind(&hash).bind(user).fetch_all(&mut **tx).await?;
    let now = clock(tx).await?;
    if deadline <= now {
        return Ok(false);
    }
    let candidate = code_hash(kind.name(), challenge, code);
    let valid = records.iter().any(|saved| {
        saved.current
            && saved.consumed_at.is_none()
            && saved.expires_at == deadline
            && saved.expires_at > now
            && bool::from(saved.code_hash.as_bytes().ct_eq(candidate.as_bytes()))
    });
    if valid {
        sqlx::query("UPDATE factor_email_deliveries SET consumed_at=clock_timestamp(),payload_cipher=NULL WHERE purpose=$1 AND challenge_hash=$2 AND user_id=$3")
            .bind(kind.name()).bind(&hash).bind(user).execute(&mut **tx).await?;
        sqlx::query("DELETE FROM factor_email_outbox WHERE delivery_hash IN (SELECT token_hash FROM factor_email_deliveries WHERE purpose=$1 AND challenge_hash=$2 AND user_id=$3)")
            .bind(kind.name()).bind(hash).bind(user).execute(&mut **tx).await?;
    }
    Ok(valid)
}

#[cfg(test)]
mod tests;
