pub mod auth;
mod delivery;
mod error;
mod http;
mod limits;
mod snapshots;
mod store;
mod sync;

use argon2::{Argon2, PasswordHasher, password_hash::SaltString};
use rand_core::OsRng;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::Arc;

#[derive(Clone)]
pub struct App {
    pub pool: PgPool,
    password_slots: Arc<tokio::sync::Semaphore>,
    dummy_password_hash: String,
    socket_slots: Arc<limits::SocketSlots>,
}

impl App {
    pub async fn connect(
        database_url: &str,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .connect(database_url)
            .await?;
        Self::from_pool(pool).await
    }

    pub async fn from_pool(pool: PgPool) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        sqlx::migrate!().run(&pool).await?;
        sqlx::query("INSERT INTO instance(singleton,instance_id,data_epoch) VALUES(true,$1,$2) ON CONFLICT DO NOTHING")
            .bind(auth::random_token()).bind(auth::random_token()).execute(&pool).await?;
        let dummy_password_hash = tokio::task::spawn_blocking(|| {
            Argon2::default()
                .hash_password(
                    b"unusable-dummy-password",
                    &SaltString::generate(&mut OsRng),
                )
                .expect("valid Argon2 parameters")
                .to_string()
        })
        .await?;
        let app = Self {
            pool,
            password_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            dummy_password_hash,
            socket_slots: Arc::default(),
        };
        app.cleanup().await?;
        Ok(app)
    }

    /// Startup and periodic maintenance only touches expired ephemeral records.
    pub async fn cleanup(&self) -> Result<(), sqlx::Error> {
        for query in [
            "DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<=now() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM socket_tickets WHERE token_hash IN (SELECT token_hash FROM socket_tickets WHERE expires_at<=now() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM sync_cursors WHERE token IN (SELECT token FROM sync_cursors WHERE expires_at<=now() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM login_windows WHERE key IN (SELECT key FROM login_windows WHERE expires_at<=now() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM snapshot_heads WHERE id IN (SELECT id FROM snapshot_heads WHERE expires_at<=now() LIMIT 8 FOR UPDATE SKIP LOCKED)",
        ] {
            sqlx::query(query).execute(&self.pool).await?;
        }
        Ok(())
    }

    pub fn router(self) -> axum::Router {
        http::router(self)
    }
}
