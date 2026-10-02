//! Independent installed profiles, sharing one recovery-code bag. Callers hold
//! the account authority lock before taking these profile locks.
use super::*;

const EMAIL_KEY_CHECK: &[u8] = b"rv-email-factor-v1";

pub(super) fn email_aad(instance: &str, user: &str, profile: &str, contact: &str) -> Vec<u8> {
    serde_json::to_vec(&(
        "rv-auth-v1",
        "email-factor-key-check",
        instance,
        user,
        profile,
        contact,
    ))
    .expect("string tuple")
}

pub(super) struct Totp {
    pub secret: Zeroizing<Vec<u8>>,
    pub last: i64,
}
pub(super) struct Profiles {
    pub totp: Option<Totp>,
    pub email: bool,
}
impl Profiles {
    pub fn enabled(&self) -> bool {
        self.totp.is_some() || self.email
    }
}

pub(super) async fn validated(
    app: &App,
    tx: &mut Transaction<'_, Postgres>,
    instance: &str,
    user: &str,
) -> Result<Profiles> {
    let totp: Option<(String, Vec<u8>, i64)> = sqlx::query_as(
        "SELECT version,totp_cipher,last_totp_counter FROM user_factors WHERE user_id=$1 FOR UPDATE",
    ).bind(user).fetch_optional(&mut **tx).await?;
    let email: Option<(String, String, Vec<u8>)> = sqlx::query_as(
        "SELECT version,email_version,key_check_cipher FROM user_email_factors WHERE user_id=$1 FOR UPDATE",
    ).bind(user).fetch_optional(&mut **tx).await?;
    let totp = if let Some((id, cipher, last)) = totp {
        let secret = key(app)?.open(&cipher, &factor_crypto::aad(instance, user, &id, "totp"))?;
        if secret.len() != 20 {
            return Err(factor_crypto::unavailable());
        }
        Some(Totp { secret, last })
    } else {
        None
    };
    if let Some((id, contact, cipher)) = &email {
        let check = key(app)?.open(cipher, &email_aad(instance, user, id, contact))?;
        if check.as_slice() != EMAIL_KEY_CHECK {
            return Err(factor_crypto::unavailable());
        }
    }
    Ok(Profiles {
        totp,
        email: email.is_some(),
    })
}

/// Contact mutation must follow explicit removal of its installed factor.
pub(crate) async fn contact_mutable(tx: &mut Transaction<'_, Postgres>, user: &str) -> Result<()> {
    let active: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_email_factors WHERE user_id=$1)")
            .bind(user)
            .fetch_one(&mut **tx)
            .await?;
    if active {
        return Err(Error::new(
            axum::http::StatusCode::CONFLICT,
            "email_factor_active",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
