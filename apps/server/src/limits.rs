//! Pilot limits, shared across processes in PostgreSQL where persistence matters.
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
};

use crate::{
    App,
    auth::hash_token,
    error::{Error, Result},
};

pub const SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
pub const SNAPSHOT_PAGE_BYTES: usize = 1024 * 1024;
pub const SNAPSHOT_TOTAL_BYTES: usize = 64 * 1024 * 1024;
pub const SNAPSHOTS_PER_USER: i64 = 4;
pub const SNAPSHOTS_TOTAL: i64 = 16;
pub const BATCH_BYTES: usize = 1024 * 1024;
pub const CURSORS_PER_USER: i64 = 512;
pub const TICKETS_PER_SESSION: i64 = 4;
pub const SOCKETS_TOTAL: usize = 128;
pub const SOCKETS_PER_SESSION: usize = 4;

pub(crate) async fn message_action(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: &str,
) -> Result<()> {
    let (attempts,retry):(i32,i64)=sqlx::query_as("INSERT INTO message_action_windows(user_id,attempts,expires_at) VALUES($1,1,clock_timestamp()+interval '60 seconds') ON CONFLICT(user_id) DO UPDATE SET attempts=CASE WHEN message_action_windows.expires_at<=clock_timestamp() THEN 1 ELSE message_action_windows.attempts+1 END,expires_at=CASE WHEN message_action_windows.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '60 seconds' ELSE message_action_windows.expires_at END RETURNING attempts,GREATEST(1,ceil(extract(epoch from expires_at-clock_timestamp())))::bigint")
        .bind(user).fetch_one(&mut **tx).await?;
    if attempts > 30 {
        return Err(Error::throttled("message_action_limit", retry as u64));
    }
    Ok(())
}

/// A rejected reservation is rolled back, so it neither extends the window nor
/// locks out unrelated accounts. The global row is locked first in every process.
/// It also bounds insertion of arbitrary username / IP keys (120 admissions/min).
pub async fn login_attempt(app: &App, username: &str, peer: Option<IpAddr>) -> Result<()> {
    auth_attempt(app, username, peer, None).await
}

pub async fn invitation_attempt(
    app: &App,
    username: &str,
    peer: Option<IpAddr>,
    token: &str,
) -> Result<()> {
    auth_attempt(app, username, peer, Some(token)).await
}

async fn auth_attempt(
    app: &App,
    username: &str,
    peer: Option<IpAddr>,
    invitation: Option<&str>,
) -> Result<()> {
    let mut tx = app.pool.begin().await?;
    let mut keys = vec![
        ("global".to_owned(), 120),
        (format!("user:{}", hash_token(username)), 10),
    ];
    if let Some(peer) = peer {
        keys.push((format!("ip:{}", hash_token(&peer.to_string())), 30));
    }
    if let Some(token) = invitation {
        keys.push((format!("invite:{}", hash_token(token)), 10));
    }
    for (key, maximum) in keys {
        let (attempts, retry): (i32, i64) = sqlx::query_as(
            "INSERT INTO login_windows(key,attempts,expires_at) VALUES($1,1,now()+interval '60 seconds') \
             ON CONFLICT(key) DO UPDATE SET \
               attempts=CASE WHEN login_windows.expires_at<=now() THEN 1 ELSE login_windows.attempts+1 END, \
               expires_at=CASE WHEN login_windows.expires_at<=now() THEN now()+interval '60 seconds' ELSE login_windows.expires_at END \
             RETURNING attempts, greatest(1,ceil(extract(epoch FROM expires_at-now())))::bigint",
        ).bind(key).fetch_one(&mut *tx).await?;
        if attempts > maximum {
            return Err(Error::throttled("auth_rate_limited", retry as u64));
        }
    }
    // Cleaning on admission prevents an idle janitor or a busy CLI from allowing
    // arbitrary keys to accumulate. Never delete the global row held above.
    sqlx::query("DELETE FROM login_windows WHERE key<>'global' AND expires_at<=now()")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Default)]
pub struct SocketSlots(Mutex<HashMap<String, usize>>);

impl SocketSlots {
    fn available(slots: &HashMap<String, usize>, session: &str) -> Result<()> {
        if slots.values().sum::<usize>() >= SOCKETS_TOTAL
            || slots.get(session).copied().unwrap_or_default() >= SOCKETS_PER_SESSION
        {
            return Err(Error::throttled("socket_limit", 5));
        }
        Ok(())
    }

    /// Report a full socket budget on the authenticated ticket endpoint so
    /// browser / mobile WebSocket APIs can receive and honor Retry-After.
    pub fn check(&self, session: &str) -> Result<()> {
        Self::available(&self.0.lock().expect("socket slots lock"), session)
    }

    pub fn acquire(self: &Arc<Self>, session: &str) -> Result<SocketSlot> {
        let mut slots = self.0.lock().expect("socket slots lock");
        Self::available(&slots, session)?;
        *slots.entry(session.to_owned()).or_default() += 1;
        Ok(SocketSlot {
            slots: self.clone(),
            session: session.to_owned(),
        })
    }
}

/// Owned by the upgrade future, then the stream; cancellation also releases it.
pub struct SocketSlot {
    slots: Arc<SocketSlots>,
    session: String,
}

impl Drop for SocketSlot {
    fn drop(&mut self) {
        let mut slots = self.slots.0.lock().expect("socket slots lock");
        let count = slots.get_mut(&self.session).expect("reserved socket slot");
        *count -= 1;
        if *count == 0 {
            slots.remove(&self.session);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_reservations_are_bounded_and_released() {
        let slots = Arc::new(SocketSlots::default());
        let mut guards = Vec::new();
        for _ in 0..SOCKETS_PER_SESSION {
            guards.push(slots.acquire("same").unwrap());
        }
        assert!(slots.acquire("same").is_err());
        guards.pop();
        guards.push(slots.acquire("same").unwrap());
        for n in guards.len()..SOCKETS_TOTAL {
            guards.push(slots.acquire(&format!("{n}")).unwrap());
        }
        assert!(slots.acquire("different").is_err());
        drop(guards);
        assert!(slots.0.lock().unwrap().is_empty());
        assert!(slots.acquire("different").is_ok());
    }
}
