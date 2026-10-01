use reqwest::{Client, StatusCode};
use rv_protocol::{Session, User, parity::RecoverAccount};
use rv_server::{App, auth, recovery};
use serde_json::json;
use sqlx::PgPool;

struct Server {
    base: String,
    http: Client,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn start(app: App) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.router()
                    .into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            base,
            http: Client::new(),
            task,
        }
    }
    async fn accept(&self, input: &RecoverAccount) -> reqwest::Response {
        self.http
            .post(format!("{}/api/v1/auth/recovery", self.base))
            .json(input)
            .send()
            .await
            .unwrap()
    }
    async fn login(&self, name: &str, password: &str) -> reqwest::Response {
        self.http
            .post(format!("{}/api/v1/auth/login", self.base))
            .json(&json!({"username":name,"password":password}))
            .send()
            .await
            .unwrap()
    }
    async fn me(&self, token: &str) -> reqwest::Response {
        self.http
            .get(format!("{}/api/v1/me", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
    }
}
fn input(token: String, name: &str) -> RecoverAccount {
    RecoverAccount {
        token,
        username: name.into(),
        new_password: "recovered-password-2026".into(),
    }
}

#[sqlx::test]
async fn recovery_is_once_only_revokes_all_devices_but_preserves_account_and_messages(
    pool: PgPool,
) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let user = auth::create_user(&app, "owner", "original-password-2026".into(), true)
        .await
        .unwrap();
    let first = auth::login(&app, "owner".into(), "original-password-2026".into())
        .await
        .unwrap();
    let second = auth::login(&app, "owner".into(), "original-password-2026".into())
        .await
        .unwrap();
    // Seed account-owned data directly; recovery never rewrites identities/data.
    sqlx::query("INSERT INTO rooms(id,name,kind) VALUES('keep-room','Kept room','private')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO members(room_id,user_id,role) VALUES('keep-room',$1,'owner')")
        .bind(&user.id)
        .execute(&pool)
        .await
        .unwrap();
    let server = Server::start(app.clone()).await;
    let sent = server
        .http
        .post(format!("{}/api/v1/rooms/keep-room/messages", server.base))
        .bearer_auth(&first.token)
        .json(&json!({"operation_id":"keep-message","text":"Preserve this account's conversation"}))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), StatusCode::OK);
    let snapshot = server
        .http
        .post(format!("{}/api/v1/sync/snapshots", server.base))
        .bearer_auth(&first.token)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(snapshot.status(), StatusCode::OK);
    let before: String = sqlx::query_scalar("SELECT activation_version FROM users WHERE id=$1")
        .bind(&user.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let issued = recovery::issue(&app, "owner", 24).await.unwrap();
    let stored: String =
        sqlx::query_scalar("SELECT token_hash FROM account_recovery_codes WHERE id=$1")
            .bind(&issued.recovery.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, auth::hash_token(&issued.token));
    assert_ne!(stored, issued.token);
    let claim = input(issued.token, "owner");
    let (a, b) = tokio::join!(server.accept(&claim), server.accept(&claim));
    assert_eq!(a.status(), StatusCode::OK);
    assert_eq!(b.status(), StatusCode::OK);
    assert_eq!(a.headers()["cache-control"], "no-store");
    let a: User = a.json().await.unwrap();
    let b: User = b.json().await.unwrap();
    assert_eq!(a.id, user.id);
    assert_eq!(a.id, b.id);
    for old in [&first.token, &second.token] {
        assert_eq!(server.me(old).await.status(), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(
        server
            .login("owner", "original-password-2026")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let new: Session = server
        .login("owner", &claim.new_password)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(new.user.id, user.id);
    let replay: User = server
        .accept(&claim)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(replay.id, user.id);
    assert_eq!(
        server.me(&new.token).await.status(),
        StatusCode::OK,
        "Receipt replay must not revoke the new session"
    );
    let (after, admin): (String, bool) =
        sqlx::query_as("SELECT activation_version,admin FROM users WHERE id=$1")
            .bind(&user.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_ne!(before, after);
    assert!(admin);
    let counts:(i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM messages),(SELECT count(*) FROM snapshot_heads),(SELECT count(*) FROM session_devices)").fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (1, 1, 0, 1));
    let mut wrong = claim.clone();
    wrong.new_password = "other-reset-password-2026".into();
    assert_eq!(
        server.accept(&wrong).await.status(),
        StatusCode::BAD_REQUEST
    );
}

#[sqlx::test]
async fn recovery_needs_valid_bound_account_epoch_and_current_grant(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let user = auth::create_user(&app, "target", "original-password-2026".into(), false)
        .await
        .unwrap();
    assert!(recovery::issue(&app, "missing", 1).await.is_err());
    assert!(recovery::issue(&app, "target", 25).await.is_err());
    let wrong = recovery::issue(&app, "target", 1).await.unwrap();
    assert_eq!(
        recovery::accept(&app, input(wrong.token, "another-account"), None)
            .await
            .err()
            .unwrap()
            .code,
        "recovery_rejected"
    );
    recovery::revoke(&app, &wrong.recovery.id).await.unwrap();
    let expired = recovery::issue(&app, "target", 1).await.unwrap();
    sqlx::query("UPDATE account_recovery_codes SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1").bind(&expired.recovery.id).execute(&pool).await.unwrap();
    assert!(
        recovery::accept(&app, input(expired.token, "target"), None)
            .await
            .is_err()
    );
    let old_epoch = recovery::issue(&app, "target", 1).await.unwrap();
    sqlx::query("UPDATE instance SET data_epoch='restore-generation'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        recovery::accept(&app, input(old_epoch.token, "target"), None)
            .await
            .is_err()
    );
    let old_grant = recovery::issue(&app, "target", 1).await.unwrap();
    recovery::issue(&app, "target", 1).await.unwrap();
    recovery::issue(&app, "target", 1).await.unwrap();
    assert_eq!(
        recovery::issue(&app, "target", 1).await.err().unwrap().code,
        "recovery_limit"
    );
    sqlx::query("UPDATE users SET admin=true WHERE id=$1")
        .bind(&user.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        recovery::accept(&app, input(old_grant.token, "target"), None)
            .await
            .is_err()
    );
    let disabled = recovery::issue(&app, "target", 1).await.unwrap();
    sqlx::query("UPDATE users SET disabled=true WHERE id=$1")
        .bind(&user.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        recovery::accept(&app, input(disabled.token, "target"), None)
            .await
            .is_err()
    );
    assert!(recovery::issue(&app, "target", 1).await.is_err());
}

#[sqlx::test]
async fn recovery_revokes_other_codes_and_bounds_receipt_grace(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    auth::create_user(&app, "target", "original-password-2026".into(), false)
        .await
        .unwrap();
    let used = recovery::issue(&app, "target", 1).await.unwrap();
    let other = recovery::issue(&app, "target", 1).await.unwrap();
    let third = recovery::issue(&app, "target", 1).await.unwrap();
    assert_eq!(
        recovery::issue(&app, "target", 1).await.err().unwrap().code,
        "recovery_limit"
    );
    let claim = input(used.token, "target");
    recovery::accept(&app, claim.clone(), None).await.unwrap();
    assert!(
        recovery::accept(&app, input(other.token, "target"), None)
            .await
            .is_err()
    );
    assert!(
        recovery::accept(&app, input(third.token, "target"), None)
            .await
            .is_err()
    );
    sqlx::query(
        "UPDATE account_recovery_codes SET consumed_at=now()-interval '6 minutes' WHERE id=$1",
    )
    .bind(used.recovery.id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(recovery::accept(&app, claim, None).await.is_err());
}

#[sqlx::test]
async fn recovery_expiring_during_a_lock_wait_keeps_old_password_and_session(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let user = auth::create_user(&app, "waiting", "original-password-2026".into(), false)
        .await
        .unwrap();
    let session = auth::login(&app, "waiting".into(), "original-password-2026".into())
        .await
        .unwrap();
    let code = recovery::issue(&app, "waiting", 1).await.unwrap();
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM account_recovery_codes WHERE id=$1 FOR UPDATE")
        .bind(&code.recovery.id)
        .fetch_one(&mut *held)
        .await
        .unwrap();
    let (worker, secret) = (app.clone(), code.token);
    let accepting =
        tokio::spawn(
            async move { recovery::accept(&worker, input(secret, "waiting"), None).await },
        );
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT user_id,data_epoch,activation_version,consumed_version,%')").fetch_one(&pool).await.unwrap();if waiting{break;}tokio::time::sleep(std::time::Duration::from_millis(10)).await;}
    }).await.expect("reset passed admission and waits on recovery code");
    sqlx::query("UPDATE account_recovery_codes SET created_at=now()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(code.recovery.id).execute(&mut *held).await.unwrap();
    held.commit().await.unwrap();
    assert_eq!(
        accepting.await.unwrap().err().unwrap().code,
        "recovery_rejected"
    );
    assert_eq!(
        auth::authenticate(&app, &auth::hash_token(&session.token))
            .await
            .unwrap()
            .id,
        user.id
    );
    assert!(
        auth::login(&app, "waiting".into(), "original-password-2026".into())
            .await
            .is_ok()
    );
}

#[sqlx::test]
async fn login_verified_before_password_reset_cannot_create_a_session_after_it(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let user = auth::create_user(&app, "racer", "original-password-2026".into(), false)
        .await
        .unwrap();
    let new_user = auth::create_user(&app, "hash-source", "new-password-for-racer".into(), false)
        .await
        .unwrap();
    let new_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
        .bind(new_user.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&user.id)
        .fetch_one(&mut *held)
        .await
        .unwrap();
    let old_login = tokio::spawn(async move {
        auth::login(&app, "racer".into(), "original-password-2026".into()).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT password_hash FROM users%')").fetch_one(&pool).await.unwrap();if waiting{break;}tokio::time::sleep(std::time::Duration::from_millis(10)).await;}
    }).await.expect("old login verified password and waits on user");
    sqlx::query("UPDATE users SET password_hash=$2 WHERE id=$1")
        .bind(&user.id)
        .bind(new_hash)
        .execute(&mut *held)
        .await
        .unwrap();
    held.commit().await.unwrap();
    assert_eq!(
        old_login.await.unwrap().err().unwrap().code,
        "session_rejected"
    );
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions WHERE user_id=$1")
        .bind(user.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sessions, 0);
}
