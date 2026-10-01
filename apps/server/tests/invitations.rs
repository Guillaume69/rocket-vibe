use reqwest::{Client, StatusCode};
use rv_protocol::{User, parity::AcceptInvitation};
use rv_server::{App, invitations};
use serde_json::json;
use sqlx::PgPool;

struct Server {
    base: String,
    task: tokio::task::JoinHandle<()>,
    http: Client,
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
            task,
            http: Client::new(),
        }
    }
    async fn accept(&self, input: &AcceptInvitation) -> reqwest::Response {
        self.http
            .post(format!("{}/api/v1/auth/invitations/accept", self.base))
            .json(input)
            .send()
            .await
            .unwrap()
    }
}
fn input(token: String, name: &str) -> AcceptInvitation {
    AcceptInvitation {
        token,
        username: name.into(),
        password: "signup-password-2026".into(),
    }
}

#[sqlx::test]
async fn invitation_race_replay_has_one_account_no_session_or_admin(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let invite = invitations::issue(&app, 168).await.unwrap();
    let (stored,): (String,) = sqlx::query_as("SELECT token_hash FROM account_invitations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_ne!(stored, invite.token);
    assert_eq!(stored, rv_server::auth::hash_token(&invite.token));
    let server = Server::start(app.clone()).await;
    let claim = input(invite.token, "new-user");
    let (a, b) = tokio::join!(server.accept(&claim), server.accept(&claim));
    assert_eq!(a.status(), StatusCode::OK);
    assert_eq!(b.status(), StatusCode::OK);
    assert_eq!(a.headers()["cache-control"], "no-store");
    let a: User = a.json().await.unwrap();
    let b: User = b.json().await.unwrap();
    assert_eq!(a.id, b.id);
    let (users,sessions,admin):(i64,i64,bool)=sqlx::query_as("SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM sessions),admin FROM users WHERE id=$1")
        .bind(&a.id).fetch_one(&pool).await.unwrap();
    assert_eq!((users, sessions, admin), (1, 0, false));
    let replay: User = server
        .accept(&claim)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(a.id, replay.id);
    let mut wrong = claim.clone();
    wrong.password = "wrong-password-2026".into();
    assert_eq!(
        server.accept(&wrong).await.status(),
        StatusCode::BAD_REQUEST
    );
    wrong = claim.clone();
    wrong.username = "other-user".into();
    assert_eq!(
        server.accept(&wrong).await.status(),
        StatusCode::BAD_REQUEST
    );
    let forbidden=server.http.post(format!("{}/api/v1/auth/invitations/accept",server.base))
        .json(&json!({"token":claim.token,"username":claim.username,"password":claim.password,"admin":true})).send().await.unwrap();
    assert_eq!(forbidden.status(), StatusCode::BAD_REQUEST);
    assert_eq!(invitations::list(&app).await.unwrap().len(), 1);
    assert_eq!(
        server
            .http
            .post(format!("{}/api/v1/auth/register", server.base))
            .json(&json!({"username":"public","password":"signup-password-2026"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let session = rv_server::auth::login(&app, claim.username, claim.password)
        .await
        .unwrap();
    assert_eq!(session.user.id, a.id);
}

#[sqlx::test]
async fn invitation_expiration_revocation_epoch_and_account_changes(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    assert!(invitations::issue(&app, 0).await.is_err());
    assert!(invitations::issue(&app, 169).await.is_err());
    let revoked = invitations::issue(&app, 1).await.unwrap();
    invitations::revoke(&app, &revoked.invitation.id)
        .await
        .unwrap();
    assert_eq!(
        invitations::accept(&app, input(revoked.token, "revoked"), None)
            .await
            .err()
            .unwrap()
            .code,
        "invitation_rejected"
    );
    let expired = invitations::issue(&app, 1).await.unwrap();
    sqlx::query("UPDATE account_invitations SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1").bind(expired.invitation.id).execute(&pool).await.unwrap();
    assert!(
        invitations::accept(&app, input(expired.token, "expired"), None)
            .await
            .is_err()
    );
    let epoch = invitations::issue(&app, 1).await.unwrap();
    sqlx::query("UPDATE instance SET data_epoch='restored-generation'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        invitations::accept(&app, input(epoch.token, "old-epoch"), None)
            .await
            .is_err()
    );
    let issued = invitations::issue(&app, 1).await.unwrap();
    let claim = input(issued.token, "bound-account");
    let account = invitations::accept(&app, claim.clone(), None)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET disabled=true WHERE id=$1")
        .bind(&account.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        invitations::accept(&app, claim.clone(), None)
            .await
            .is_err()
    );
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(account.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(invitations::accept(&app, claim, None).await.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test]
async fn waiting_claim_rechecks_expiration_and_does_not_create_an_account(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let invite = invitations::issue(&app, 1).await.unwrap();
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM account_invitations WHERE id=$1 FOR UPDATE")
        .bind(&invite.invitation.id)
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    let invitation_id = invite.invitation.id.clone();
    let claim = tokio::spawn(async move {
        invitations::accept(&app, input(invite.token, "waiting-user"), None).await
    });
    // Observe the real lock wait; expiration happens after admission and Argon2.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT data_epoch,consumed_by,%')")
                .fetch_one(&pool).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("accept must wait on the held invitation");
    sqlx::query("UPDATE account_invitations SET created_at=now()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(invitation_id).execute(&mut *lock).await.unwrap();
    lock.commit().await.unwrap();
    assert_eq!(
        claim.await.unwrap().err().unwrap().code,
        "invitation_rejected"
    );
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(users, 0);
}

#[sqlx::test]
async fn invitation_quota_is_persistent_and_shared_with_login(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let token = rv_server::auth::random_token();
    for i in 0..10 {
        assert_eq!(
            invitations::accept(&app, input(token.clone(), &format!("name-{i}")), None)
                .await
                .err()
                .unwrap()
                .code,
            "invitation_rejected"
        );
    }
    let other = App::from_pool(pool.clone()).await.unwrap();
    assert_eq!(
        invitations::accept(&other, input(token, "name-extra"), None)
            .await
            .err()
            .unwrap()
            .code,
        "auth_rate_limited"
    );
    let keys: Vec<String> = sqlx::query_scalar("SELECT key FROM login_windows")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(keys.iter().all(|key| !key.contains("name-")));
    let issued = invitations::issue(&app, 1).await.unwrap();
    let server = Server::start(app).await;
    for _ in 0..10 {
        assert_eq!(
            server
                .accept(&input(issued.token.clone(), "same-account"))
                .await
                .status(),
            StatusCode::OK
        );
    }
    let limited = server
        .http
        .post(format!("{}/api/v1/auth/login", server.base))
        .json(&json!({"username":"same-account","password":"signup-password-2026"}))
        .send()
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
}
