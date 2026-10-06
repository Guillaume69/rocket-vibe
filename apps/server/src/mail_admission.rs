//! Shared persistent SMTP budget. Admission is committed independently of the
//! business transaction, so cancellation cannot admit the same command twice.
//! Producers derive a domain-bound hash of their immutable delivery intent;
//! verification retains its original hash format for already queued commands.
use crate::{
    App, auth,
    error::{Error, Result},
};
use std::net::IpAddr;

pub(crate) async fn admit(
    app: &App,
    admission_key: &str,
    user_id: &str,
    address: &str,
    peer: Option<IpAddr>,
) -> Result<()> {
    if admission_key.len() != 64
        || !admission_key
            .bytes()
            .all(|v| v.is_ascii_hexdigit() && !v.is_ascii_uppercase())
    {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    // Acquire the shared quota lock before any account, device or challenge
    // lock. No SMTP request or business transaction retains this lease.
    let mut keys = vec![
        ("global".to_owned(), 120, 60),
        (format!("user:{}", auth::hash_token(user_id)), 3, 900),
        (
            format!(
                "address:{}",
                auth::hash_token(&address.to_ascii_lowercase())
            ),
            3,
            900,
        ),
    ];
    if let Some(peer) = peer {
        keys.push((
            format!("ip:{}", auth::hash_token(&peer.to_string())),
            10,
            900,
        ));
    }
    sqlx::query("INSERT INTO email_delivery_windows(key,attempts,expires_at) VALUES('global',1,clock_timestamp()) ON CONFLICT DO NOTHING").execute(&mut *tx).await?;
    sqlx::query("SELECT key FROM email_delivery_windows WHERE key='global' FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM email_delivery_admissions WHERE key=$1 AND expires_at>clock_timestamp())").bind(admission_key).fetch_one(&mut *tx).await?;
    if exists {
        tx.commit().await?;
        return Ok(());
    }
    for (key, maximum, seconds) in keys {
        let (count,retry):(i32,i64)=sqlx::query_as("INSERT INTO email_delivery_windows(key,attempts,expires_at) VALUES($1,1,clock_timestamp()+make_interval(secs=>$2)) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN email_delivery_windows.expires_at<=clock_timestamp() THEN 1 ELSE email_delivery_windows.attempts+1 END,expires_at=CASE WHEN email_delivery_windows.expires_at<=clock_timestamp() THEN clock_timestamp()+make_interval(secs=>$2) ELSE email_delivery_windows.expires_at END RETURNING attempts,GREATEST(1,ceil(extract(epoch from expires_at-clock_timestamp())))::bigint")
            .bind(key).bind(seconds as f64).fetch_one(&mut *tx).await?;
        if count > maximum {
            return Err(Error::throttled("email_delivery_limit", retry as u64));
        }
    }
    sqlx::query("INSERT INTO email_delivery_admissions(key,expires_at) VALUES($1,clock_timestamp()+interval '1 day') ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at").bind(admission_key).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM email_delivery_admissions WHERE key IN (SELECT key FROM email_delivery_admissions WHERE expires_at<=clock_timestamp() LIMIT 1000)").execute(&mut *tx).await?;
    sqlx::query(
        "DELETE FROM email_delivery_windows WHERE key<>'global' AND expires_at<=clock_timestamp()",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests;
