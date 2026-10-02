//! Explicit factor enrollment/retirement with a device-bound private receipt.
use super::*;
use rv_protocol::parity::{ChangeEmailFactor, EmailFactorChange, ReauthenticationContext};

struct Source {
    context: ReauthenticationContext,
    version: String,
    contact: String,
    installed: bool,
}
async fn source(tx: &mut Transaction<'_, Postgres>, account: &Account) -> Result<Source> {
    let (instance_id, data_epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR SHARE")
            .fetch_one(&mut **tx)
            .await?;
    auth::lock_active(tx, account).await?;
    let (device_id,expires): (String,DateTime<Utc>) = sqlx::query_as("SELECT d.id,s.expires_at FROM sessions s JOIN session_devices d ON d.id=s.device_id WHERE s.token_hash=$1 FOR NO KEY UPDATE OF d")
        .bind(&account.session_hash).fetch_one(&mut **tx).await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    if expires <= now {
        return Err(Error::unauthorized());
    }
    let (version,contact,installed): (String,String,bool) = sqlx::query_as("SELECT factor_version,email_version,EXISTS(SELECT 1 FROM account_factor_profiles WHERE user_id=u.id) FROM users u WHERE id=$1")
        .bind(&account.id).fetch_one(&mut **tx).await?;
    Ok(Source {
        context: ReauthenticationContext {
            user_id: account.id.clone(),
            device_id,
            instance_id,
            data_epoch,
        },
        version,
        contact,
        installed,
    })
}
fn context_equal(a: &ReauthenticationContext, b: &ReauthenticationContext) -> bool {
    a.user_id == b.user_id
        && a.device_id == b.device_id
        && a.instance_id == b.instance_id
        && a.data_epoch == b.data_epoch
}
fn aad(input: &ChangeEmailFactor, enabled: bool, committed: &str) -> Vec<u8> {
    serde_json::to_vec(&(
        "rv-email-factor-change-v1",
        &input.context,
        &input.operation_id,
        &input.email_version,
        &input.factor_version,
        enabled,
        committed,
    ))
    .expect("string tuple")
}
#[derive(FromRow)]
struct Receipt {
    enabled: bool,
    instance_id: String,
    data_epoch: String,
    email_version: String,
    requested_version: Option<String>,
    committed_version: String,
    activation_version: String,
    profile_id: Option<String>,
    receipt_cipher: Option<Vec<u8>>,
    expires_at: DateTime<Utc>,
}
pub(crate) async fn change(
    app: &App,
    account: &Account,
    input: ChangeEmailFactor,
    enabled: bool,
) -> Result<EmailFactorChange> {
    if !auth::identifier(&input.operation_id)
        || !auth::identifier(&input.email_version)
        || input
            .factor_version
            .as_ref()
            .is_some_and(|v| !auth::identifier(v))
        || [
            &input.context.user_id,
            &input.context.device_id,
            &input.context.instance_id,
            &input.context.data_epoch,
        ]
        .iter()
        .any(|v| !auth::identifier(v))
    {
        return Err(Error::invalid());
    }
    let key = key(app)?;
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let current = source(&mut tx, account).await?;
    if !context_equal(&current.context, &input.context) {
        return Err(Error::conflict());
    }
    let hash = auth::hash_token(&format!("rv-email-factor-change:{}", input.operation_id));
    let saved:Option<Receipt>=sqlx::query_as("SELECT * FROM email_factor_changes WHERE user_id=$1 AND device_id=$2 AND operation_hash=$3 FOR UPDATE")
        .bind(&account.id).bind(&current.context.device_id).bind(&hash).fetch_optional(&mut *tx).await?;
    let active: Option<String> =
        sqlx::query_scalar("SELECT version FROM user_email_factors WHERE user_id=$1 FOR UPDATE")
            .bind(&account.id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(saved) = saved {
        let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&mut *tx)
            .await?;
        if saved.enabled != enabled
            || saved.instance_id != current.context.instance_id
            || saved.data_epoch != current.context.data_epoch
            || saved.email_version != input.email_version
            || saved.email_version != current.contact
            || saved.requested_version != input.factor_version
            || saved.committed_version != current.version
            || saved.activation_version != account.activation_version
            || saved.expires_at <= now
            || (enabled && active != saved.profile_id)
            || (!enabled && active.is_some())
        {
            return Err(Error::conflict());
        }
        let plain = key.open(
            saved
                .receipt_cipher
                .as_deref()
                .ok_or_else(Error::conflict)?,
            &aad(&input, enabled, &saved.committed_version),
        )?;
        let receipt: EmailFactorChange =
            serde_json::from_slice(&plain).map_err(|_| factor_crypto::unavailable())?;
        tx.commit().await?;
        return Ok(receipt);
    }
    if current.contact != input.email_version
        || input.factor_version != current.installed.then_some(current.version.clone())
        || enabled == active.is_some()
    {
        return Err(Error::conflict());
    }
    if enabled && app.mail.is_none() {
        return Err(crate::email::unavailable());
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_emails WHERE user_id=$1)")
            .bind(&account.id)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::conflict());
    }
    recent(&mut tx, account).await?;
    profiles::validated(app, &mut tx, &current.context.instance_id, &account.id).await?;
    // Time may have advanced while acquiring the final profile lock.
    source(&mut tx, account).await?;
    recent(&mut tx, account).await?;
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM email_factor_changes WHERE user_id=$1 AND created_at>clock_timestamp()-interval '15 minutes'")
        .bind(&account.id).fetch_one(&mut *tx).await?;
    if count >= 6 {
        return Err(Error::throttled("email_factor_change_limit", 900));
    }
    let profile_id = if enabled {
        let id = auth::random_token();
        let cipher = profiles::seal_email(
            app,
            &current.context.instance_id,
            &account.id,
            &id,
            &current.contact,
        )?;
        sqlx::query("INSERT INTO user_email_factors(user_id,version,email_version,key_check_cipher) VALUES($1,$2,$3,$4)")
            .bind(&account.id).bind(&id).bind(&current.contact).bind(cipher).execute(&mut *tx).await?;
        Some(id)
    } else {
        sqlx::query("DELETE FROM user_email_factors WHERE user_id=$1")
            .bind(&account.id)
            .execute(&mut *tx)
            .await?;
        None
    };
    let version = auth::random_token();
    let codes = if enabled {
        sqlx::query("DELETE FROM factor_backup_codes WHERE user_id=$1")
            .bind(&account.id)
            .execute(&mut *tx)
            .await?;
        new_backup_codes(&mut tx, &account.id, &version)
            .await?
            .codes
    } else {
        vec![]
    };
    let activation: String = sqlx::query_scalar(
        "UPDATE users SET factor_version=$2 WHERE id=$1 RETURNING activation_version",
    )
    .bind(&account.id)
    .bind(&version)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM factor_setups WHERE user_id=$1")
        .bind(&account.id)
        .execute(&mut *tx)
        .await?;
    fence_other_sessions(&mut tx, account).await?;
    let receipt = EmailFactorChange {
        enabled,
        codes,
        factor_version: version.clone(),
        email_version: current.contact,
        context: current.context,
    };
    let plain = Zeroizing::new(serde_json::to_vec(&receipt).map_err(|_| Error::internal())?);
    let cipher = key.seal(&plain, &aad(&input, enabled, &version))?;
    sqlx::query("INSERT INTO email_factor_changes(user_id,device_id,operation_hash,enabled,instance_id,data_epoch,email_version,requested_version,committed_version,activation_version,profile_id,receipt_cipher,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+interval '5 minutes')")
        .bind(&account.id).bind(&receipt.context.device_id).bind(hash).bind(enabled).bind(&receipt.context.instance_id).bind(&receipt.context.data_epoch)
        .bind(&input.email_version).bind(input.factor_version).bind(version).bind(activation).bind(profile_id).bind(cipher).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(receipt)
}
