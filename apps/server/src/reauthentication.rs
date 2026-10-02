//! Recent proof on an existing family; no new bearer, device or active account.
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use chrono::{DateTime, Duration, Utc};
use rv_protocol::parity::{
    AuthChallenge, BeginReauthentication, FinishReauthentication, ReauthenticationContext,
    ReauthenticationGrant, ReauthenticationStatus, ReauthenticationStep, ResumeReauthentication,
    RetireReauthentication,
};
use sqlx::{FromRow, Postgres, Transaction};
use std::net::IpAddr;
use zeroize::Zeroizing;

use crate::{
    App,
    auth::{self, Account},
    error::{Error, Result},
    factors,
};

fn rejected() -> Error {
    // A mistyped proof is not a revoked chat session.
    Error::new(
        axum::http::StatusCode::BAD_REQUEST,
        "reauthentication_rejected",
    )
}
fn valid_intent(challenge: &str, operation: &str) -> Result<()> {
    if !factors::bearer_candidate(challenge) || !auth::identifier(operation) {
        return Err(Error::invalid());
    }
    Ok(())
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

fn check_context(
    context: &ReauthenticationContext,
    account: &Account,
    instance: &str,
    epoch: &str,
    device: &str,
) -> Result<()> {
    if context.user_id != account.id
        || context.device_id != device
        || context.instance_id != instance
        || context.data_epoch != epoch
    {
        return Err(Error::conflict());
    }
    Ok(())
}

#[derive(FromRow)]
struct Challenge {
    device_id: String,
    operation_id: String,
    instance_id: String,
    data_epoch: String,
    activation_version: String,
    factor_version: String,
    requested_version: String,
    committed_version: Option<String>,
    expires_at: DateTime<Utc>,
    attempts: i32,
    authenticated_at: Option<DateTime<Utc>>,
    factor_completed: bool,
    receipt_expires_at: Option<DateTime<Utc>>,
}

async fn source(
    tx: &mut Transaction<'_, Postgres>,
    account: &Account,
) -> Result<(String, String, String, String)> {
    let (instance, epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut **tx)
            .await?;
    auth::lock_active(tx, account).await?;
    let (device, revision, expiry): (String, String, DateTime<Utc>) =
        sqlx::query_as("SELECT d.id,d.reauthentication_version,s.expires_at FROM sessions s JOIN session_devices d ON d.id=s.device_id WHERE s.token_hash=$1 AND s.user_id=$2 FOR NO KEY UPDATE OF d")
            .bind(&account.session_hash)
            .bind(&account.id)
            .fetch_one(&mut **tx)
            .await?;
    // Device/head writes must not wait until after a code was consumed. The
    // session may have expired while acquiring this final authentication lock.
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    if expiry <= now {
        return Err(Error::unauthorized());
    }
    Ok((instance, epoch, device, revision))
}

async fn find(
    tx: &mut Transaction<'_, Postgres>,
    account: &Account,
    device: &str,
    hash: &str,
) -> Result<Option<Challenge>> {
    Ok(sqlx::query_as("SELECT * FROM reauthentication_challenges WHERE token_hash=$1 AND user_id=$2 AND device_id=$3 FOR UPDATE")
        .bind(hash).bind(&account.id).bind(device).fetch_optional(&mut **tx).await?)
}

async fn current(
    tx: &mut Transaction<'_, Postgres>,
    account: &Account,
    saved: &Challenge,
    operation: &str,
    instance: &str,
    epoch: &str,
    revision: &str,
) -> Result<DateTime<Utc>> {
    let version: String = sqlx::query_scalar("SELECT factor_version FROM users WHERE id=$1")
        .bind(&account.id)
        .fetch_one(&mut **tx)
        .await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    if saved.operation_id != operation
        || saved.instance_id != instance
        || saved.data_epoch != epoch
        || saved.activation_version != account.activation_version
        || saved.factor_version != version
        || saved
            .committed_version
            .as_deref()
            .unwrap_or(&saved.requested_version)
            != revision
        || (saved.authenticated_at.is_none() && (saved.expires_at <= now || saved.attempts >= 5))
        || (saved.authenticated_at.is_some() && saved.receipt_expires_at.is_none_or(|t| t <= now))
    {
        return Err(rejected());
    }
    Ok(now)
}

fn grant(
    account: &Account,
    saved: &Challenge,
    authenticated: DateTime<Utc>,
) -> ReauthenticationGrant {
    ReauthenticationGrant {
        user_id: account.id.clone(),
        device_id: saved.device_id.clone(),
        instance_id: saved.instance_id.clone(),
        data_epoch: saved.data_epoch.clone(),
        factor_version: saved.factor_version.clone(),
        proof_version: saved
            .committed_version
            .clone()
            .expect("accepted proof revision"),
        authenticated_at: authenticated.to_rfc3339(),
        expires_at: (authenticated + Duration::minutes(15)).to_rfc3339(),
    }
}

async fn view(
    app: &App,
    tx: &mut Transaction<'_, Postgres>,
    account: &Account,
    saved: &Challenge,
    challenge_id: String,
) -> Result<ReauthenticationStep> {
    if let Some(authenticated) = saved.authenticated_at {
        // Never write a grant or extend its age on receipt recovery.
        Ok(ReauthenticationStep::Granted {
            grant: grant(account, saved, authenticated),
        })
    } else {
        Ok(ReauthenticationStep::Challenge {
            challenge: AuthChallenge {
                challenge_id,
                methods: factors::methods(app, tx, &account.id, &saved.instance_id).await?,
                expires_at: saved.expires_at.to_rfc3339(),
                resend_after_seconds: 0,
            },
        })
    }
}

async fn accept(
    tx: &mut Transaction<'_, Postgres>,
    account: &Account,
    hash: &str,
    saved: &mut Challenge,
    factor_completed: bool,
) -> Result<ReauthenticationGrant> {
    let revision = auth::random_token();
    let factor_id: Option<String> = if factor_completed {
        Some(
            sqlx::query_scalar("SELECT version FROM account_factor_profiles WHERE user_id=$1")
                .bind(&account.id)
                .fetch_one(&mut **tx)
                .await?,
        )
    } else {
        None
    };
    sqlx::query("UPDATE session_devices SET reauthentication_version=$2 WHERE id=$1")
        .bind(&saved.device_id)
        .bind(&revision)
        .execute(&mut **tx)
        .await?;
    let authenticated: DateTime<Utc> = sqlx::query_scalar("UPDATE reauthentication_challenges SET authenticated_at=clock_timestamp(),factor_completed=$2,receipt_expires_at=clock_timestamp()+interval '5 minutes',committed_version=$3 WHERE token_hash=$1 RETURNING authenticated_at")
        .bind(hash).bind(factor_completed).bind(&revision).fetch_one(&mut **tx).await?;
    sqlx::query("INSERT INTO reauthentication_grants(device_id,user_id,instance_id,data_epoch,activation_version,factor_version,authenticated_at,expires_at,factor_completed,proof_version,factor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$7+interval '15 minutes',$8,$9,$10) ON CONFLICT(device_id) DO UPDATE SET instance_id=EXCLUDED.instance_id,data_epoch=EXCLUDED.data_epoch,activation_version=EXCLUDED.activation_version,factor_version=EXCLUDED.factor_version,authenticated_at=EXCLUDED.authenticated_at,expires_at=EXCLUDED.expires_at,factor_completed=EXCLUDED.factor_completed,proof_version=EXCLUDED.proof_version,factor_id=EXCLUDED.factor_id")
        .bind(&saved.device_id).bind(&account.id).bind(&saved.instance_id).bind(&saved.data_epoch)
        .bind(&saved.activation_version).bind(&saved.factor_version).bind(authenticated).bind(factor_completed)
        .bind(&revision).bind(factor_id).execute(&mut **tx).await?;
    saved.authenticated_at = Some(authenticated);
    saved.committed_version = Some(revision);
    saved.factor_completed = factor_completed;
    Ok(grant(account, saved, authenticated))
}

pub(crate) async fn begin(
    app: &App,
    account: &Account,
    input: BeginReauthentication,
    peer: Option<IpAddr>,
) -> Result<ReauthenticationStep> {
    valid_intent(&input.challenge_id, &input.operation_id)?;
    if input.password.len() > 1024 || !auth::identifier(&input.proof_version) {
        return Err(Error::invalid());
    }
    if let Some(context) = &input.context {
        valid_context(context)?;
    }
    let permit = app
        .password_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::throttled("auth_busy", 1))?;
    crate::limits::auth_attempt(
        app,
        &account.username,
        peer,
        Some(("reauth", &input.challenge_id)),
    )
    .await?;
    let verified_hash: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1 AND NOT disabled")
            .bind(&account.id)
            .fetch_optional(&app.pool)
            .await?
            .ok_or_else(rejected)?;
    let hash = verified_hash.clone();
    let password = Zeroizing::new(input.password);
    let valid = tokio::task::spawn_blocking(move || {
        // The CPU slot follows the real blocking job after HTTP cancellation.
        let _permit = permit;
        PasswordHash::new(&hash).ok().is_some_and(|h| {
            Argon2::default()
                .verify_password(password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .map_err(|_| Error::internal())?;
    if !valid {
        return Err(rejected());
    }
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let (instance, epoch, device, revision) = source(&mut tx, account).await?;
    if let Some(context) = &input.context {
        check_context(context, account, &instance, &epoch, &device)?;
    }
    let (current_hash, version): (String, String) =
        sqlx::query_as("SELECT password_hash,factor_version FROM users WHERE id=$1")
            .bind(&account.id)
            .fetch_one(&mut *tx)
            .await?;
    if verified_hash != current_hash {
        return Err(rejected());
    }
    let hash = auth::hash_token(&input.challenge_id);
    if let Some(saved) = find(&mut tx, account, &device, &hash).await? {
        if saved.requested_version != input.proof_version {
            return Err(Error::conflict());
        }
        current(
            &mut tx,
            account,
            &saved,
            &input.operation_id,
            &instance,
            &epoch,
            &revision,
        )
        .await?;
        let step = view(app, &mut tx, account, &saved, input.challenge_id).await?;
        tx.commit().await?;
        return Ok(step);
    }
    if input.proof_version != revision {
        return Err(Error::conflict());
    }
    let occupied: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 UNION ALL SELECT 1 FROM auth_challenges WHERE token_hash=$1 UNION ALL SELECT 1 FROM reauthentication_challenges WHERE token_hash=$1 OR (device_id=$2 AND operation_id=$3))")
        .bind(&hash).bind(&device).bind(&input.operation_id).fetch_one(&mut *tx).await?;
    if occupied {
        return Err(Error::conflict());
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reauthentication_challenges WHERE user_id=$1 AND authenticated_at IS NULL AND expires_at>clock_timestamp()")
        .bind(&account.id).fetch_one(&mut *tx).await?;
    if count >= 5 {
        return Err(Error::throttled("challenge_limit", 60));
    }
    let enabled: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_factor_profiles WHERE user_id=$1)")
            .bind(&account.id)
            .fetch_one(&mut *tx)
            .await?;
    if enabled {
        factors::methods(app, &mut tx, &account.id, &instance).await?;
    }
    let inserted = sqlx::query_as::<_, Challenge>("INSERT INTO reauthentication_challenges(token_hash,user_id,device_id,operation_id,instance_id,data_epoch,activation_version,factor_version,requested_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '5 minutes') RETURNING *")
        .bind(&hash).bind(&account.id).bind(&device).bind(&input.operation_id).bind(instance).bind(epoch)
        .bind(&account.activation_version).bind(version).bind(revision).fetch_one(&mut *tx).await;
    let mut saved = match inserted {
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => return Err(Error::conflict()),
        result => result?,
    };
    let step = if enabled {
        view(app, &mut tx, account, &saved, input.challenge_id).await?
    } else {
        ReauthenticationStep::Granted {
            grant: accept(&mut tx, account, &hash, &mut saved, false).await?,
        }
    };
    tx.commit().await?;
    Ok(step)
}

pub(crate) async fn resume(
    app: &App,
    account: &Account,
    input: ResumeReauthentication,
) -> Result<ReauthenticationStep> {
    valid_intent(&input.challenge_id, &input.operation_id)?;
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let (instance, epoch, device, revision) = source(&mut tx, account).await?;
    let hash = auth::hash_token(&input.challenge_id);
    let saved = find(&mut tx, account, &device, &hash)
        .await?
        .ok_or_else(|| {
            Error::new(
                axum::http::StatusCode::NOT_FOUND,
                "reauthentication_not_found",
            )
        })?;
    current(
        &mut tx,
        account,
        &saved,
        &input.operation_id,
        &instance,
        &epoch,
        &revision,
    )
    .await?;
    let step = view(app, &mut tx, account, &saved, input.challenge_id).await?;
    tx.commit().await?;
    Ok(step)
}

pub(crate) async fn finish(
    app: &App,
    account: &Account,
    input: FinishReauthentication,
    peer: Option<IpAddr>,
) -> Result<ReauthenticationGrant> {
    valid_intent(&input.challenge_id, &input.operation_id)?;
    if input.code.len() > 128 {
        return Err(Error::invalid());
    }
    crate::limits::auth_attempt(
        app,
        &account.username,
        peer,
        Some(("reauth", &input.challenge_id)),
    )
    .await?;
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let (instance, epoch, device, revision) = source(&mut tx, account).await?;
    let hash = auth::hash_token(&input.challenge_id);
    let mut saved = find(&mut tx, account, &device, &hash)
        .await?
        .ok_or_else(rejected)?;
    current(
        &mut tx,
        account,
        &saved,
        &input.operation_id,
        &instance,
        &epoch,
        &revision,
    )
    .await?;
    if let Some(authenticated) = saved.authenticated_at {
        let grant = grant(account, &saved, authenticated);
        tx.commit().await?;
        return Ok(grant);
    }
    let valid = factors::verify_code(
        app,
        &mut tx,
        &instance,
        &account.id,
        &input.method,
        &input.code,
        factors::ProofScope {
            deadline: saved.expires_at,
            kind: factors::email_delivery::Kind::Reauthentication,
            challenge: &input.challenge_id,
        },
    )
    .await?;
    if !valid {
        sqlx::query(
            "UPDATE reauthentication_challenges SET attempts=attempts+1 WHERE token_hash=$1",
        )
        .bind(hash)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(rejected());
    }
    // E-mail verification also locks delivery/outbox rows. Their wait must not
    // allow the account session or original proof challenge to expire unseen.
    let (instance, epoch, _, revision) = source(&mut tx, account).await?;
    current(
        &mut tx,
        account,
        &saved,
        &input.operation_id,
        &instance,
        &epoch,
        &revision,
    )
    .await?;
    let grant = accept(&mut tx, account, &hash, &mut saved, true).await?;
    tx.commit().await?;
    Ok(grant)
}

/// An authorized factor setting advances the keeper's authority without
/// extending proof age or upgrading a password-only proof into a factor proof.
pub(crate) async fn carry_authority(
    tx: &mut Transaction<'_, Postgres>,
    account: &Account,
) -> Result<()> {
    sqlx::query("UPDATE reauthentication_grants g SET factor_version=u.factor_version,activation_version=u.activation_version FROM users u,instance i WHERE u.id=$1 AND g.user_id=u.id AND g.device_id=(SELECT device_id FROM sessions WHERE token_hash=$2) AND g.activation_version=$3 AND g.instance_id=i.instance_id AND g.data_epoch=i.data_epoch AND i.singleton AND g.expires_at>clock_timestamp()")
        .bind(&account.id).bind(&account.session_hash).bind(&account.activation_version).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) async fn status(app: &App, account: &Account) -> Result<ReauthenticationStatus> {
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let (instance_id, data_epoch, device_id, proof_version) = source(&mut tx, account).await?;
    let recent = factors::recently_authenticated(&mut tx, account).await?;
    tx.commit().await?;
    Ok(ReauthenticationStatus {
        user_id: account.id.clone(),
        instance_id,
        data_epoch,
        device_id,
        proof_version,
        recent,
    })
}

/// Fence unaccepted work, including a start request still verifying a password.
/// Replaying an old head cannot retire a newer proof. Carry a valid grant's
/// original age and factor provenance; cancellation is never reauthentication.
pub(crate) async fn retire(
    app: &App,
    account: &Account,
    input: RetireReauthentication,
) -> Result<ReauthenticationStatus> {
    valid_context(&input.context)?;
    if !auth::identifier(&input.proof_version) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let (instance_id, data_epoch, device_id, mut proof_version) = source(&mut tx, account).await?;
    check_context(
        &input.context,
        account,
        &instance_id,
        &data_epoch,
        &device_id,
    )?;
    if proof_version == input.proof_version {
        let next = auth::random_token();
        sqlx::query("UPDATE session_devices SET reauthentication_version=$2 WHERE id=$1")
            .bind(&device_id)
            .bind(&next)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE reauthentication_grants SET proof_version=$3 WHERE device_id=$1 AND user_id=$2 AND proof_version=$4")
            .bind(&device_id).bind(&account.id).bind(&next).bind(&proof_version).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM reauthentication_challenges WHERE device_id=$1 AND user_id=$2 AND requested_version=$3 AND authenticated_at IS NULL")
            .bind(&device_id).bind(&account.id).bind(&proof_version).execute(&mut *tx).await?;
        proof_version = next;
    }
    let recent = factors::recently_authenticated(&mut tx, account).await?;
    tx.commit().await?;
    Ok(ReauthenticationStatus {
        user_id: account.id.clone(),
        device_id,
        instance_id,
        data_epoch,
        proof_version,
        recent,
    })
}
