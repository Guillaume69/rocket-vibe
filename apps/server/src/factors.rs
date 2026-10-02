//! Native second factors: account-first SQL locks, encrypted TOTP secrets,
//! single-use challenges/codes and replay receipts proving the same successor.
pub(crate) mod email_delivery;
pub(crate) mod email_settings;
pub(crate) mod profiles;

use chrono::{DateTime, Utc};
use rv_protocol::{
    Session, User,
    parity::{
        AuthChallenge, BeginFactorSetup, EnableFactor, FactorBackupCodes, FactorSetup,
        FactorStatus, FinishFactor, RegenerateFactorBackups, SecondFactor,
    },
};
use sqlx::{FromRow, Postgres, Transaction};
use std::net::IpAddr;
use zeroize::Zeroizing;

use crate::{
    App,
    auth::{self, Account},
    error::{Error, Result},
    factor_crypto::{self, AuthKey},
};

fn rejected() -> Error {
    Error::new(axum::http::StatusCode::BAD_REQUEST, "factor_rejected")
}
fn key(app: &App) -> Result<&AuthKey> {
    app.auth_key
        .as_deref()
        .ok_or_else(factor_crypto::unavailable)
}
pub(crate) fn bearer_candidate(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub(crate) async fn issue_challenge(
    app: &App,
    tx: &mut Transaction<'_, Postgres>,
    user: &User,
    instance: &str,
    epoch: &str,
) -> Result<AuthChallenge> {
    let methods = methods(app, tx, &user.id, instance).await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_challenges WHERE user_id=$1 AND expires_at>clock_timestamp() AND accepted_operation IS NULL")
        .bind(&user.id).fetch_one(&mut **tx).await?;
    if count >= 5 {
        return Err(Error::throttled("challenge_limit", 60));
    }
    let token = auth::random_token();
    let expires: DateTime<Utc> = sqlx::query_scalar("INSERT INTO auth_challenges(token_hash,user_id,data_epoch,activation_version,factor_version,expires_at) SELECT $1,id,$3,activation_version,factor_version,clock_timestamp()+interval '5 minutes' FROM users WHERE id=$2 RETURNING expires_at")
        .bind(auth::hash_token(&token)).bind(&user.id).bind(epoch).fetch_one(&mut **tx).await?;
    Ok(AuthChallenge {
        challenge_id: token,
        methods,
        expires_at: expires.to_rfc3339(),
        resend_after_seconds: 0,
    })
}

pub(crate) async fn methods(
    app: &App,
    tx: &mut Transaction<'_, Postgres>,
    user_id: &str,
    instance: &str,
) -> Result<Vec<SecondFactor>> {
    // Fail closed on a missing/wrong key or corrupt ciphertext, even if backup
    // codes remain. A deployment mistake never downgrades an enabled account.
    let profiles = profiles::validated(app, tx, instance, user_id).await?;
    if !profiles.enabled() {
        return Err(factor_crypto::unavailable());
    }
    let backups: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM factor_backup_codes WHERE user_id=$1 AND consumed_at IS NULL)",
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    let mut methods = Vec::new();
    if profiles.totp.is_some() {
        methods.push(SecondFactor::Totp);
    }
    if profiles.email && app.mail.is_some() {
        methods.push(SecondFactor::Email);
    }
    if backups {
        methods.push(SecondFactor::RecoveryCode);
    }
    if methods.is_empty() {
        return Err(factor_crypto::unavailable());
    }
    Ok(methods)
}

#[derive(FromRow)]
struct Challenge {
    data_epoch: String,
    activation_version: String,
    factor_version: String,
    expires_at: DateTime<Utc>,
    attempts: i32,
    accepted_operation: Option<String>,
    session_hash: Option<String>,
    receipt_expires_at: Option<DateTime<Utc>>,
}

pub(crate) async fn finish(
    app: &App,
    input: FinishFactor,
    peer: Option<IpAddr>,
) -> Result<Session> {
    if input.challenge_id == input.next_token
        || !bearer_candidate(&input.challenge_id)
        || !bearer_candidate(&input.next_token)
        || !auth::identifier(&input.operation_id)
        || input.code.len() > 128
    {
        return Err(Error::invalid());
    }
    let challenge_hash = auth::hash_token(&input.challenge_id);
    let found: Option<(String, String)> = sqlx::query_as("SELECT u.id,u.username FROM auth_challenges c JOIN users u ON u.id=c.user_id WHERE c.token_hash=$1")
        .bind(&challenge_hash).fetch_optional(&app.pool).await?;
    crate::limits::auth_attempt(
        app,
        found.as_ref().map(|u| u.1.as_str()).unwrap_or(""),
        peer,
        Some(("factor", &input.challenge_id)),
    )
    .await?;
    let (id, _) = found.ok_or_else(rejected)?;
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let (instance, epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut *tx)
            .await?;
    let user: Option<(String, String, String, String, String)> = sqlx::query_as("SELECT id,username,display_name,activation_version,factor_version FROM users WHERE id=$1 AND NOT disabled FOR NO KEY UPDATE")
        .bind(&id).fetch_optional(&mut *tx).await?;
    let (id, username, display_name, activation, version) = user.ok_or_else(rejected)?;
    let user = User {
        id,
        username,
        display_name,
    };
    let challenge: Option<Challenge> = sqlx::query_as("SELECT data_epoch,activation_version,factor_version,expires_at,attempts,accepted_operation,session_hash,receipt_expires_at FROM auth_challenges WHERE token_hash=$1 AND user_id=$2 FOR UPDATE")
        .bind(&challenge_hash).bind(&user.id).fetch_optional(&mut *tx).await?;
    let challenge = challenge.ok_or_else(rejected)?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if challenge.data_epoch != epoch
        || challenge.activation_version != activation
        || challenge.factor_version != version
    {
        return Err(rejected());
    }
    let next_hash = auth::hash_token(&input.next_token);
    if let Some(operation) = challenge.accepted_operation {
        if operation != input.operation_id
            || challenge.session_hash.as_deref() != Some(&next_hash)
            || challenge
                .receipt_expires_at
                .is_none_or(|expiry| expiry <= now)
        {
            return Err(rejected());
        }
        let expires: Option<DateTime<Utc>> = sqlx::query_scalar("SELECT expires_at FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE")
            .bind(next_hash).bind(&user.id).fetch_optional(&mut *tx).await?;
        let expires = expires.ok_or_else(rejected)?;
        tx.commit().await?;
        return Ok(Session {
            token: input.next_token,
            expires_at: expires.to_rfc3339(),
            user,
        });
    }
    if challenge.expires_at <= now || challenge.attempts >= 5 {
        return Err(rejected());
    }
    let valid = verify_code(
        app,
        &mut tx,
        &instance,
        &user.id,
        &input.method,
        &input.code,
        ProofScope {
            deadline: challenge.expires_at,
            kind: email_delivery::Kind::Login,
            challenge: &input.challenge_id,
        },
    )
    .await?;
    if !valid {
        sqlx::query("UPDATE auth_challenges SET attempts=attempts+1 WHERE token_hash=$1")
            .bind(challenge_hash)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?; // A failed code consumes an attempt, including after restart.
        return Err(rejected());
    }
    let session = auth::create_session(&mut tx, &user, input.next_token).await?;
    sqlx::query("UPDATE auth_challenges SET accepted_operation=$2,session_hash=$3,device_id=(SELECT device_id FROM sessions WHERE token_hash=$3),receipt_expires_at=clock_timestamp()+interval '5 minutes' WHERE token_hash=$1")
        .bind(challenge_hash).bind(input.operation_id).bind(next_hash).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(session)
}

/// Login and reauthentication share the same persisted one-use counter/codes.
/// Caller retains account authority and challenge locks until its commit.
pub(crate) struct ProofScope<'a> {
    pub deadline: DateTime<Utc>,
    pub kind: email_delivery::Kind,
    pub challenge: &'a str,
}
pub(crate) async fn verify_code(
    app: &App,
    tx: &mut Transaction<'_, Postgres>,
    instance: &str,
    user_id: &str,
    method: &SecondFactor,
    code: &str,
    proof: ProofScope<'_>,
) -> Result<bool> {
    let profiles = profiles::validated(app, tx, instance, user_id).await?;
    if !profiles.enabled() {
        return Err(rejected());
    }
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    if proof.deadline <= now {
        return Ok(false);
    }
    let valid = match method {
        SecondFactor::Totp => {
            let counter = profiles.totp.as_ref().and_then(|totp| {
                factor_crypto::verify(&totp.secret, code, now.timestamp(), totp.last)
            });
            if let Some(counter) = counter {
                sqlx::query("UPDATE user_factors SET last_totp_counter=$2 WHERE user_id=$1")
                    .bind(user_id)
                    .bind(counter)
                    .execute(&mut **tx)
                    .await?;
                true
            } else {
                false
            }
        }
        SecondFactor::RecoveryCode => {
            // High-entropy 128-bit codes; separators/case are presentation only.
            let normalized = code.replace('-', "").to_ascii_lowercase();
            if normalized.len() != 32 || !normalized.bytes().all(|b| b.is_ascii_hexdigit()) {
                false
            } else {
                sqlx::query("UPDATE factor_backup_codes SET consumed_at=clock_timestamp() WHERE user_id=$1 AND token_hash=$2 AND consumed_at IS NULL")
                    .bind(user_id).bind(auth::hash_token(&normalized)).execute(&mut **tx).await?.rows_affected() == 1
            }
        }
        SecondFactor::Email => {
            profiles.email
                && email_delivery::verify(
                    tx,
                    user_id,
                    proof.kind,
                    proof.challenge,
                    code,
                    proof.deadline,
                )
                .await?
        }
    };
    Ok(valid)
}

/// Recent password login grants enrollment only while there is no active factor.
/// Once enabled, prove the current factor by full login or explicit reauth.
pub(crate) async fn recent(tx: &mut Transaction<'_, Postgres>, account: &Account) -> Result<()> {
    let granted = recently_authenticated(tx, account).await?;
    if !granted {
        return Err(Error::new(
            axum::http::StatusCode::FORBIDDEN,
            "reauthentication_required",
        ));
    }
    Ok(())
}

pub(crate) async fn recently_authenticated(
    tx: &mut Transaction<'_, Postgres>,
    account: &Account,
) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_devices d JOIN sessions s ON s.device_id=d.id JOIN users u ON u.id=d.user_id JOIN instance i ON i.singleton LEFT JOIN account_factor_profiles f ON f.user_id=d.user_id LEFT JOIN reauthentication_grants g ON g.device_id=d.id AND g.user_id=u.id WHERE s.token_hash=$1 AND ((d.created_at>clock_timestamp()-interval '15 minutes' AND (f.user_id IS NULL OR d.login_factor_id=f.version)) OR (g.proof_version=d.reauthentication_version AND g.expires_at>clock_timestamp() AND g.authenticated_at>clock_timestamp()-interval '15 minutes' AND g.instance_id=i.instance_id AND g.data_epoch=i.data_epoch AND g.activation_version=u.activation_version AND g.factor_version=u.factor_version AND (f.user_id IS NULL OR (g.factor_completed AND g.factor_id=f.version)))))")
        .bind(&account.session_hash).fetch_one(&mut **tx).await?)
}

pub(crate) async fn status(app: &App, account: &Account) -> Result<FactorStatus> {
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, account).await?;
    let (totp, email, count, version): (bool, bool, i64, Option<String>) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM user_factors WHERE user_id=$1),EXISTS(SELECT 1 FROM user_email_factors WHERE user_id=$1),(SELECT COUNT(*) FROM factor_backup_codes WHERE user_id=$1 AND consumed_at IS NULL),(SELECT u.factor_version FROM users u JOIN account_factor_profiles f ON f.user_id=u.id WHERE u.id=$1)")
        .bind(&account.id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(FactorStatus {
        totp,
        email,
        backup_codes_remaining: count as u32,
        factor_version: version,
    })
}

#[derive(FromRow)]
struct Setup {
    id: String,
    operation_id: String,
    data_epoch: String,
    activation_version: String,
    secret_cipher: Vec<u8>,
    expires_at: DateTime<Utc>,
    attempts: i32,
    accepted_operation: Option<String>,
    receipt_cipher: Option<Vec<u8>>,
}

pub(crate) async fn begin(
    app: &App,
    account: &Account,
    input: BeginFactorSetup,
) -> Result<FactorSetup> {
    if !auth::identifier(&input.operation_id) {
        return Err(Error::invalid());
    }
    let key = key(app)?;
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let (instance, epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut *tx)
            .await?;
    auth::lock_active(&mut tx, account).await?;
    recent(&mut tx, account).await?;
    profiles::validated(app, &mut tx, &instance, &account.id).await?;
    let active: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_factors WHERE user_id=$1)")
            .bind(&account.id)
            .fetch_one(&mut *tx)
            .await?;
    if active {
        return Err(Error::conflict());
    }
    let previous: Option<Setup> =
        sqlx::query_as("SELECT * FROM factor_setups WHERE user_id=$1 FOR UPDATE")
            .bind(&account.id)
            .fetch_optional(&mut *tx)
            .await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let (id, secret, expires) = if let Some(saved) = previous.filter(|s| {
        s.expires_at > now
            && s.data_epoch == epoch
            && s.activation_version == account.activation_version
    }) {
        if saved.operation_id != input.operation_id || saved.accepted_operation.is_some() {
            return Err(Error::conflict());
        }
        let secret = key.open(
            &saved.secret_cipher,
            &factor_crypto::aad(&instance, &account.id, &saved.id, "totp"),
        )?;
        (saved.id, secret, saved.expires_at)
    } else {
        let id = auth::random_token()[..32].to_owned();
        let secret = factor_crypto::secret();
        let cipher = key.seal(
            secret.as_ref(),
            &factor_crypto::aad(&instance, &account.id, &id, "totp"),
        )?;
        let expires: DateTime<Utc> = sqlx::query_scalar("INSERT INTO factor_setups(id,user_id,operation_id,data_epoch,activation_version,secret_cipher,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes') ON CONFLICT(user_id) DO UPDATE SET id=EXCLUDED.id,operation_id=EXCLUDED.operation_id,data_epoch=EXCLUDED.data_epoch,activation_version=EXCLUDED.activation_version,secret_cipher=EXCLUDED.secret_cipher,expires_at=EXCLUDED.expires_at,attempts=0,accepted_operation=NULL,receipt_cipher=NULL RETURNING expires_at")
            .bind(&id).bind(&account.id).bind(input.operation_id).bind(epoch).bind(&account.activation_version).bind(cipher).fetch_one(&mut *tx).await?;
        (id, Zeroizing::new(secret.to_vec()), expires)
    };
    let secret = data_encoding::BASE32_NOPAD.encode(&secret);
    let issuer = format!("RocketVibe-{}", &instance[..8.min(instance.len())]);
    let provisioning_uri = format!(
        "otpauth://totp/{issuer}:{}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits=6&period=30",
        account.username
    );
    tx.commit().await?;
    Ok(FactorSetup {
        setup_id: id,
        secret,
        provisioning_uri,
        expires_at: expires.to_rfc3339(),
    })
}

pub(crate) async fn enable(
    app: &App,
    account: &Account,
    input: EnableFactor,
) -> Result<FactorBackupCodes> {
    if !auth::identifier(&input.setup_id)
        || !auth::identifier(&input.operation_id)
        || input.code.len() > 128
    {
        return Err(Error::invalid());
    }
    crate::limits::auth_attempt(
        app,
        &account.username,
        None,
        Some(("factor-setup", &input.setup_id)),
    )
    .await?;
    let key = key(app)?;
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let (instance, epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut *tx)
            .await?;
    auth::lock_active(&mut tx, account).await?;
    let setup: Option<Setup> =
        sqlx::query_as("SELECT * FROM factor_setups WHERE user_id=$1 AND id=$2 FOR UPDATE")
            .bind(&account.id)
            .bind(&input.setup_id)
            .fetch_optional(&mut *tx)
            .await?;
    let setup = setup.ok_or_else(rejected)?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if setup.expires_at <= now
        || setup.data_epoch != epoch
        || setup.activation_version != account.activation_version
    {
        return Err(rejected());
    }
    if let Some(operation) = setup.accepted_operation {
        if operation != input.operation_id {
            return Err(rejected());
        }
        let receipt = key.open(
            setup.receipt_cipher.as_deref().ok_or_else(rejected)?,
            &factor_crypto::aad(&instance, &account.id, &setup.id, "backup-receipt"),
        )?;
        let codes: FactorBackupCodes =
            serde_json::from_slice(&receipt).map_err(|_| factor_crypto::unavailable())?;
        tx.commit().await?;
        return Ok(codes);
    }
    recent(&mut tx, account).await?;
    let active: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_factors WHERE user_id=$1)")
            .bind(&account.id)
            .fetch_one(&mut *tx)
            .await?;
    profiles::validated(app, &mut tx, &instance, &account.id).await?;
    if active || setup.attempts >= 5 {
        return Err(rejected());
    }
    let secret = key.open(
        &setup.secret_cipher,
        &factor_crypto::aad(&instance, &account.id, &setup.id, "totp"),
    )?;
    let Some(counter) = factor_crypto::verify(&secret, &input.code, now.timestamp(), -1) else {
        sqlx::query("UPDATE factor_setups SET attempts=attempts+1 WHERE id=$1")
            .bind(setup.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Err(rejected());
    };
    sqlx::query("INSERT INTO user_factors(user_id,version,totp_cipher,last_totp_counter) VALUES($1,$2,$3,$4)")
        .bind(&account.id).bind(&setup.id).bind(setup.secret_cipher).bind(counter).execute(&mut *tx).await?;
    let committed_version = auth::random_token();
    // Enrollment explicitly issues the displayed replacement common bag.
    // Adding TOTP alongside e-mail must not accumulate another ten live codes.
    sqlx::query("DELETE FROM factor_backup_codes WHERE user_id=$1")
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    let codes = new_backup_codes(&mut tx, &account.id, &committed_version).await?;
    // Advance the authority and delete other families. Keep only the enrolling
    // device, which cannot disable its new factor without a full factor login.
    let activation: String = sqlx::query_scalar(
        "UPDATE users SET factor_version=$2 WHERE id=$1 RETURNING activation_version",
    )
    .bind(&account.id)
    .bind(&committed_version)
    .fetch_one(&mut *tx)
    .await?;
    fence_other_sessions(&mut tx, account).await?;
    let receipt = Zeroizing::new(serde_json::to_vec(&codes).map_err(|_| Error::internal())?);
    let cipher = key.seal(
        &receipt,
        &factor_crypto::aad(&instance, &account.id, &setup.id, "backup-receipt"),
    )?;
    sqlx::query("UPDATE factor_setups SET accepted_operation=$2,receipt_cipher=$3,activation_version=$4,expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1")
        .bind(setup.id).bind(input.operation_id).bind(cipher).bind(activation).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(codes)
}

async fn new_backup_codes(
    tx: &mut Transaction<'_, Postgres>,
    user_id: &str,
    factor_version: &str,
) -> Result<FactorBackupCodes> {
    let mut codes = FactorBackupCodes {
        codes: vec![],
        factor_version: Some(factor_version.into()),
    };
    for _ in 0..10 {
        let code = auth::random_token()[..32].to_owned();
        sqlx::query("INSERT INTO factor_backup_codes(user_id,token_hash) VALUES($1,$2)")
            .bind(user_id)
            .bind(auth::hash_token(&code))
            .execute(&mut **tx)
            .await?;
        codes.codes.push(
            code.as_bytes()
                .chunks(8)
                .map(|c| std::str::from_utf8(c).expect("hex").to_ascii_uppercase())
                .collect::<Vec<_>>()
                .join("-"),
        );
    }
    Ok(codes)
}

#[derive(FromRow)]
struct BackupRegeneration {
    id: String,
    requested_version: String,
    committed_version: String,
    data_epoch: String,
    activation_version: String,
    receipt_cipher: Option<Vec<u8>>,
    expires_at: DateTime<Utc>,
}

pub(crate) async fn regenerate_backups(
    app: &App,
    account: &Account,
    input: RegenerateFactorBackups,
) -> Result<FactorBackupCodes> {
    if !auth::identifier(&input.factor_version) || !auth::identifier(&input.operation_id) {
        return Err(Error::invalid());
    }
    let key = key(app)?;
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let (instance, epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut *tx)
            .await?;
    auth::lock_active(&mut tx, account).await?;
    let device: String =
        sqlx::query_scalar("SELECT device_id FROM sessions WHERE token_hash=$1 AND user_id=$2")
            .bind(&account.session_hash)
            .bind(&account.id)
            .fetch_one(&mut *tx)
            .await?;
    let (version, activation): (String, String) =
        sqlx::query_as("SELECT factor_version,activation_version FROM users WHERE id=$1")
            .bind(&account.id)
            .fetch_one(&mut *tx)
            .await?;
    let saved: Option<BackupRegeneration> = sqlx::query_as("SELECT id,requested_version,committed_version,data_epoch,activation_version,receipt_cipher,expires_at FROM factor_backup_regenerations WHERE user_id=$1 AND device_id=$2 AND operation_id=$3 FOR UPDATE")
        .bind(&account.id).bind(&device).bind(&input.operation_id).fetch_optional(&mut *tx).await?;
    // Check the wall clock after the receipt lock, including a delayed retry.
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if let Some(saved) = saved {
        if saved.requested_version != input.factor_version
            || saved.committed_version != version
            || saved.data_epoch != epoch
            || saved.activation_version != activation
            || saved.expires_at <= now
        {
            return Err(Error::conflict());
        }
        let receipt = key.open(
            saved
                .receipt_cipher
                .as_deref()
                .ok_or_else(Error::conflict)?,
            &factor_crypto::aad(
                &instance,
                &account.id,
                &saved.id,
                "backup-regeneration-receipt",
            ),
        )?;
        let codes: FactorBackupCodes =
            serde_json::from_slice(&receipt).map_err(|_| factor_crypto::unavailable())?;
        tx.commit().await?;
        return Ok(codes);
    }
    if version != input.factor_version {
        return Err(Error::conflict());
    }
    recent(&mut tx, account).await?;
    if !profiles::validated(app, &mut tx, &instance, &account.id)
        .await?
        .enabled()
    {
        return Err(Error::conflict());
    }
    // Serialize this successful-operation quota with the user's authority lock.
    // Receipt replays never mint codes, consume quota or revoke new devices.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM factor_backup_regenerations WHERE user_id=$1 AND created_at>clock_timestamp()-interval '15 minutes'")
        .bind(&account.id).fetch_one(&mut *tx).await?;
    if count >= 3 {
        return Err(Error::throttled("factor_regeneration_limit", 900));
    }
    sqlx::query("DELETE FROM factor_backup_codes WHERE user_id=$1")
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    let committed_version = auth::random_token();
    let codes = new_backup_codes(&mut tx, &account.id, &committed_version).await?;
    let activation: String = sqlx::query_scalar(
        "UPDATE users SET factor_version=$2 WHERE id=$1 RETURNING activation_version",
    )
    .bind(&account.id)
    .bind(&committed_version)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM factor_setups WHERE user_id=$1")
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    fence_other_sessions(&mut tx, account).await?;
    let id = auth::random_token();
    let plaintext = Zeroizing::new(serde_json::to_vec(&codes).map_err(|_| Error::internal())?);
    let cipher = key.seal(
        &plaintext,
        &factor_crypto::aad(&instance, &account.id, &id, "backup-regeneration-receipt"),
    )?;
    sqlx::query("INSERT INTO factor_backup_regenerations(id,user_id,device_id,operation_id,requested_version,committed_version,data_epoch,activation_version,receipt_cipher,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '5 minutes')")
        .bind(id).bind(&account.id).bind(device).bind(input.operation_id).bind(input.factor_version)
        .bind(committed_version).bind(epoch).bind(activation).bind(cipher).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(codes)
}

async fn fence_other_sessions(tx: &mut Transaction<'_, Postgres>, account: &Account) -> Result<()> {
    sqlx::query("DELETE FROM session_devices WHERE user_id=$1 AND id<>(SELECT device_id FROM sessions WHERE token_hash=$2)")
        .bind(&account.id).bind(&account.session_hash).execute(&mut **tx).await?;
    sqlx::query("DELETE FROM snapshot_heads WHERE user_id=$1")
        .bind(&account.id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM sync_cursors WHERE user_id=$1")
        .bind(&account.id)
        .execute(&mut **tx)
        .await?;
    crate::reauthentication::carry_authority(tx, account).await?;
    Ok(())
}

pub(crate) async fn disable(
    app: &App,
    account: &Account,
    input: rv_protocol::parity::DisableFactor,
) -> Result<()> {
    if !auth::identifier(&input.factor_version) {
        return Err(Error::invalid());
    }
    key(app)?;
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let instance: String =
        sqlx::query_scalar("SELECT instance_id FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut *tx)
            .await?;
    auth::lock_active(&mut tx, account).await?;
    let version: Option<String> = sqlx::query_scalar(
        "SELECT u.factor_version FROM users u JOIN user_factors f ON f.user_id=u.id WHERE u.id=$1",
    )
    .bind(&account.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(version) = version else {
        tx.commit().await?;
        return Ok(());
    };
    if version != input.factor_version {
        return Err(Error::conflict());
    }
    recent(&mut tx, account).await?;
    profiles::validated(app, &mut tx, &instance, &account.id).await?;
    sqlx::query("DELETE FROM user_factors WHERE user_id=$1")
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM factor_setups WHERE user_id=$1")
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE users SET factor_version=$2 WHERE id=$1")
        .bind(&account.id)
        .bind(auth::random_token())
        .execute(&mut *tx)
        .await?;
    fence_other_sessions(&mut tx, account).await?;
    tx.commit().await?;
    Ok(())
}
