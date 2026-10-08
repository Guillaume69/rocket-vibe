mod admin;
pub mod auth;
pub mod bots;
mod commands;
pub mod custom_emojis;
mod delivery;
pub mod e2ee;
mod email;
pub mod email_delivery;
pub mod email_recovery;
mod error;
pub mod factor_crypto;
mod factors;
mod files;
mod http;
pub mod invitations;
mod limits;
pub mod link_previews;
mod live;
pub mod livekit;
pub mod mail;
mod mail_admission;
mod marks;
mod mentions;
mod message_actions;
pub mod objects;
pub mod operator;
mod permissions;
mod profiles;
pub mod push;
mod quotes;
mod reactions;
mod reauthentication;
pub mod recovery;
mod room_details;
mod room_reads;
mod search;
mod sessions;
mod snapshots;
mod store;
mod sync;
mod system_messages;
mod threads;
pub mod voice;

use argon2::{Argon2, PasswordHasher, password_hash::SaltString};
use rand_core::OsRng;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::Arc;

#[derive(Clone)]
pub struct App {
    pub pool: PgPool,
    pub mail: Option<Arc<mail::Sender>>,
    pub push: Option<Arc<push::Sender>>,
    /// The operator's SFU: advertises the `voice` capability when configured.
    pub livekit: Option<Arc<livekit::LiveKit>>,
    /// Advertises the `e2ee` capability: on by default, an operator may turn
    /// native end-to-end encryption off for an instance (`RV_E2EE=false`).
    pub e2ee: bool,
    /// This process's start, reported by the administration overview.
    pub(crate) started_at: chrono::DateTime<chrono::Utc>,
    pub(crate) objects: Option<objects::LocalObjects>,
    image_slots: Arc<tokio::sync::Semaphore>,
    file_slots: Arc<tokio::sync::Semaphore>,
    preview_slots: Arc<tokio::sync::Semaphore>,
    password_slots: Arc<tokio::sync::Semaphore>,
    crypto_slots: Arc<tokio::sync::Semaphore>,
    dummy_password_hash: String,
    socket_slots: Arc<limits::SocketSlots>,
    auth_key: Option<Arc<factor_crypto::AuthKey>>,
}

impl App {
    pub async fn connect(
        database_url: &str,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Self::connect_with_auth_key(database_url, None).await
    }

    pub async fn connect_with_auth_key(
        database_url: &str,
        auth_key: Option<factor_crypto::AuthKey>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .connect(database_url)
            .await?;
        Self::from_pool_with_auth_key(pool, auth_key).await
    }

    pub async fn from_pool(pool: PgPool) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Self::from_pool_with_auth_key(pool, None).await
    }

    pub async fn from_pool_with_auth_key(
        pool: PgPool,
        auth_key: Option<factor_crypto::AuthKey>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
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
            mail: None,
            push: None,
            livekit: None,
            e2ee: true,
            started_at: chrono::Utc::now(),
            objects: None,
            image_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            file_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            preview_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            password_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            crypto_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            dummy_password_hash,
            socket_slots: Arc::default(),
            auth_key: auth_key.map(Arc::new),
        };
        app.cleanup().await?;
        Ok(app)
    }

    pub fn with_mail(mut self, mail: Option<mail::Sender>) -> Self {
        self.mail = mail.map(Arc::new);
        self
    }

    pub fn with_objects(mut self, objects: objects::LocalObjects) -> Self {
        self.objects = Some(objects);
        self
    }

    pub fn with_push(mut self, push: Option<push::Sender>) -> Self {
        self.push = push.map(Arc::new);
        self
    }

    pub fn with_livekit(mut self, livekit: Option<livekit::LiveKit>) -> Self {
        self.livekit = livekit.map(Arc::new);
        self
    }

    pub fn with_e2ee(mut self, enabled: bool) -> Self {
        self.e2ee = enabled;
        self
    }

    /// Startup and periodic maintenance only touches expired ephemeral records.
    pub async fn cleanup(&self) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE uploads SET state='expired',object_id=NULL,lease_id=NULL,lease_expires_at=NULL WHERE id IN (SELECT id FROM uploads WHERE state IN ('prepared','ready') AND expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)")
            .execute(&self.pool).await?;
        sqlx::query("DELETE FROM profile_windows WHERE expires_at<=clock_timestamp()")
            .execute(&self.pool)
            .await?;
        if let Some(objects) = &self.objects
            && let Err(error) = objects.collect(&self.pool).await
        {
            tracing::warn!(code = error.code, "object garbage collection failed");
        }
        for query in [
            "DELETE FROM e2ee_history_requests WHERE fingerprint IN (SELECT fingerprint FROM e2ee_history_requests WHERE retained_until<=clock_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM e2ee_history_request_log WHERE (device_id,fingerprint) IN (SELECT device_id,fingerprint FROM e2ee_history_request_log WHERE created_at<=clock_timestamp()-interval '1 day' LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM push_notifications WHERE id IN (SELECT id FROM push_notifications WHERE expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM link_preview_jobs WHERE (message_id,slot) IN (SELECT j.message_id,j.slot FROM link_preview_jobs j JOIN messages m ON m.id=j.message_id JOIN instance i ON i.singleton WHERE j.expires_at<=clock_timestamp() OR j.token IS DISTINCT FROM m.preview_token OR j.data_epoch<>i.data_epoch OR m.deleted LIMIT 1000 FOR UPDATE OF j SKIP LOCKED)",
            "DELETE FROM presence_leases WHERE device_id IN (SELECT device_id FROM presence_leases WHERE expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM voice_sessions WHERE user_id IN (SELECT user_id FROM voice_sessions WHERE expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM voice_pushes WHERE id IN (SELECT id FROM voice_pushes WHERE expires_at<=clock_timestamp()-interval '1 day' LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM typing_leases WHERE (device_id,room_id,root_key) IN (SELECT device_id,room_id,root_key FROM typing_leases WHERE expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM live_windows WHERE device_id IN (SELECT device_id FROM live_windows WHERE expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM search_windows WHERE device_id IN (SELECT device_id FROM search_windows WHERE expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "UPDATE email_recovery_outbox SET payload_cipher=NULL,lease_id=NULL,lease_expires_at=NULL WHERE request_hash IN (SELECT o.request_hash FROM email_recovery_outbox o WHERE o.payload_cipher IS NOT NULL AND (o.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM current_email_recovery_requests r WHERE r.operation_hash=o.request_hash)) LIMIT 1000 FOR UPDATE OF o SKIP LOCKED)",
            "DELETE FROM email_recovery_requests WHERE operation_hash IN (SELECT operation_hash FROM email_recovery_requests WHERE expires_at<=clock_timestamp()-interval '1 day' LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM factor_email_deliveries WHERE token_hash IN (SELECT token_hash FROM factor_email_deliveries WHERE expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "UPDATE email_factor_changes SET receipt_cipher=NULL WHERE ctid IN (SELECT ctid FROM email_factor_changes WHERE expires_at<=clock_timestamp() AND receipt_cipher IS NOT NULL LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM email_factor_changes WHERE created_at<=clock_timestamp()-interval '1 day' AND ctid IN (SELECT ctid FROM email_factor_changes WHERE created_at<=clock_timestamp()-interval '1 day' LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM email_removals WHERE (device_id,operation_hash) IN (SELECT device_id,operation_hash FROM email_removals WHERE expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM email_verifications WHERE token_hash IN (SELECT token_hash FROM email_verifications WHERE expires_at<=clock_timestamp() AND (receipt_expires_at IS NULL OR receipt_expires_at<=clock_timestamp()) LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM email_delivery_windows WHERE key IN (SELECT key FROM email_delivery_windows WHERE expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM email_delivery_admissions WHERE key IN (SELECT key FROM email_delivery_admissions WHERE expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM reauthentication_challenges WHERE token_hash IN (SELECT token_hash FROM reauthentication_challenges WHERE expires_at<=clock_timestamp() AND (receipt_expires_at IS NULL OR receipt_expires_at<=clock_timestamp()) LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM reauthentication_grants WHERE device_id IN (SELECT device_id FROM reauthentication_grants WHERE expires_at<=clock_timestamp() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM auth_challenges WHERE token_hash IN (SELECT token_hash FROM auth_challenges WHERE expires_at<=now() AND (receipt_expires_at IS NULL OR receipt_expires_at<=now()) LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM factor_setups WHERE id IN (SELECT id FROM factor_setups WHERE expires_at<=now() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "UPDATE factor_backup_regenerations SET receipt_cipher=NULL WHERE id IN (SELECT id FROM factor_backup_regenerations WHERE expires_at<=clock_timestamp() AND receipt_cipher IS NOT NULL LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM factor_backup_regenerations WHERE id IN (SELECT id FROM factor_backup_regenerations WHERE created_at<=clock_timestamp()-interval '1 day' LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<=now() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM session_devices WHERE id IN (SELECT d.id FROM session_devices d WHERE NOT EXISTS(SELECT 1 FROM sessions s WHERE s.device_id=d.id) LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM session_rotations WHERE old_hash IN (SELECT old_hash FROM session_rotations WHERE expires_at<=now() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM socket_tickets WHERE token_hash IN (SELECT token_hash FROM socket_tickets WHERE expires_at<=now() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM sync_cursors WHERE token IN (SELECT token FROM sync_cursors WHERE expires_at<=now() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM login_windows WHERE key IN (SELECT key FROM login_windows WHERE expires_at<=now() LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM account_invitations WHERE id IN (SELECT id FROM account_invitations WHERE expires_at<now()-interval '30 days' LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM account_recovery_codes WHERE id IN (SELECT id FROM account_recovery_codes WHERE expires_at<now()-interval '30 days' LIMIT 1000 FOR UPDATE SKIP LOCKED)",
            "DELETE FROM moderation_commands WHERE (actor_id,operation_id) IN (SELECT actor_id,operation_id FROM moderation_commands WHERE created_at<=clock_timestamp()-interval '7 days' LIMIT 1000 FOR UPDATE SKIP LOCKED)",
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
