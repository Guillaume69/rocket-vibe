use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::{Client, StatusCode};
use rv_protocol::{
    Session,
    parity::{AuthenticationStep, FactorBackupCodes, FactorSetup, FinishFactor, SecondFactor},
};
use rv_server::{App, auth, factor_crypto::AuthKey};
use serde_json::{Value, json};
use sha1::Sha1;
use sqlx::PgPool;

const PASSWORD: &str = "factor-test-password-2026";
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
    async fn post(&self, path: &str, token: Option<&str>, input: Value) -> reqwest::Response {
        let mut request = self
            .http
            .post(format!("{}/api/v1{path}", self.base))
            .json(&input);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        request.send().await.unwrap()
    }
    async fn get(&self, path: &str, token: &str) -> reqwest::Response {
        self.http
            .get(format!("{}/api/v1{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
    }
    async fn challenge(&self) -> String {
        let result = self
            .post(
                "/auth/start",
                None,
                json!({"username":"owner","password":PASSWORD}),
            )
            .await;
        assert_eq!(result.status(), StatusCode::OK);
        assert_eq!(result.headers()["cache-control"], "no-store");
        match result.json::<AuthenticationStep>().await.unwrap() {
            AuthenticationStep::Challenge { challenge, user } => {
                assert_eq!(user.username, "owner");
                assert_eq!(challenge.methods.len(), 2);
                challenge.challenge_id
            }
            AuthenticationStep::Session { .. } => {
                panic!("a protected account minted a password-only session")
            }
        }
    }
    async fn finish(
        &self,
        challenge: &str,
        code: &str,
        method: &str,
        candidate: &str,
        operation: &str,
    ) -> reqwest::Response {
        self.post("/auth/factors/verify", None, json!({"challenge_id":challenge,"method":method,"code":code,"operation_id":operation,"next_token":candidate})).await
    }
}
async fn fixture(pool: &PgPool) -> (App, Server, Session) {
    let app = App::from_pool_with_auth_key(
        pool.clone(),
        Some(AuthKey::from_hex(&"37".repeat(32)).unwrap()),
    )
    .await
    .unwrap();
    auth::create_user(&app, "owner", PASSWORD.into(), false)
        .await
        .unwrap();
    let session = auth::login(&app, "owner".into(), PASSWORD.into())
        .await
        .unwrap();
    let server = Server::start(app.clone()).await;
    (app, server, session)
}
fn totp(secret: &str, counter: i64) -> String {
    let secret = data_encoding::BASE32_NOPAD
        .decode(secret.as_bytes())
        .unwrap();
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(&secret).unwrap();
    mac.update(&(counter as u64).to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 15) as usize;
    let binary = u32::from_be_bytes(digest[offset..offset + 4].try_into().unwrap()) & 0x7fff_ffff;
    format!("{:06}", binary % 1_000_000)
}
async fn begin(server: &Server, session: &Session, op: &str) -> FactorSetup {
    let response = server
        .post(
            "/me/factors/totp/setup",
            Some(&session.token),
            json!({"operation_id":op}),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    response.json().await.unwrap()
}
async fn enroll(server: &Server, session: &Session) -> (FactorSetup, FactorBackupCodes) {
    let setup = begin(server, session, "setup-1").await;
    let result = server.post("/me/factors/totp/enable", Some(&session.token), json!({"setup_id":setup.setup_id,"operation_id":"enable-1","code":totp(&setup.secret, Utc::now().timestamp()/30)})).await;
    assert_eq!(result.status(), StatusCode::OK);
    assert_eq!(result.headers()["cache-control"], "no-store");
    (setup, result.json().await.unwrap())
}
async fn reset_limits(pool: &PgPool) {
    sqlx::query("DELETE FROM login_windows")
        .execute(pool)
        .await
        .unwrap();
}

async fn full_login(server: &Server, code: &str, operation: &str) -> Session {
    let challenge = server.challenge().await;
    let response = server
        .finish(
            &challenge,
            code,
            "recovery_code",
            &auth::random_token(),
            operation,
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    response.json().await.unwrap()
}

async fn factor_version(server: &Server, token: &str) -> String {
    let status: Value = server.get("/me/factors", token).await.json().await.unwrap();
    status["factor_version"].as_str().unwrap().to_owned()
}

#[sqlx::test]
async fn backup_regeneration_is_atomic_and_replays_the_same_device_receipt_after_restart_and_rotation(
    pool: PgPool,
) {
    let (app, server, enrolling) = fixture(&pool).await;
    let (_, original) = enroll(&server, &enrolling).await;
    reset_limits(&pool).await;
    let session = full_login(&server, &original.codes[0], "full-login").await;
    let old_challenge = server.challenge().await;
    let version = factor_version(&server, &session.token).await;
    let input = json!({"factor_version":version,"operation_id":"regenerate-1"});
    assert_eq!(
        server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&enrolling.token),
                input.clone()
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let before: (String, Vec<u8>, i64) =
        sqlx::query_as("SELECT version,totp_cipher,last_totp_counter FROM user_factors")
            .fetch_one(&pool)
            .await
            .unwrap();
    let (a, b) = tokio::join!(
        server.post(
            "/me/factors/recovery/regenerate",
            Some(&session.token),
            input.clone()
        ),
        server.post(
            "/me/factors/recovery/regenerate",
            Some(&session.token),
            input.clone()
        )
    );
    assert!(matches!(a.status(), StatusCode::OK | StatusCode::CONFLICT));
    assert!(matches!(b.status(), StatusCode::OK | StatusCode::CONFLICT));
    assert!(a.status() == StatusCode::OK || b.status() == StatusCode::OK);
    let response = if a.status() == StatusCode::OK { a } else { b };
    assert_eq!(response.headers()["cache-control"], "no-store");
    let codes: FactorBackupCodes = response.json().await.unwrap();
    assert_eq!(codes.codes.len(), 10);
    assert!(codes.codes.iter().all(|c| !original.codes.contains(c)));
    let after: (String, Vec<u8>, i64) =
        sqlx::query_as("SELECT version,totp_cipher,last_totp_counter FROM user_factors")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        before == after,
        "regenerating backups must retain the authenticator and replay counter"
    );
    assert_ne!(factor_version(&server, &session.token).await, version);
    assert_eq!(
        server.get("/me", &enrolling.token).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM factor_setups")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        server
            .finish(
                &old_challenge,
                &original.codes[1],
                "recovery_code",
                &auth::random_token(),
                "stale-challenge"
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let current_challenge = server.challenge().await;
    assert_eq!(
        server
            .finish(
                &current_challenge,
                &original.codes[1],
                "recovery_code",
                &auth::random_token(),
                "old-code"
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let other = full_login(&server, &codes.codes[0], "new-device").await;
    let other_input = input.clone();
    assert_eq!(
        server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&other.token),
                other_input
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let rotated = server
        .post(
            "/auth/renew",
            Some(&session.token),
            json!({"operation_id":"rotate-after-regeneration","next_token":auth::random_token()}),
        )
        .await
        .json::<Session>()
        .await
        .unwrap();
    drop(server);
    let server = Server::start(app).await;
    // The receipt proves the original authorized operation; recovering it must
    // not require another factor or regenerate the accepted codes.
    sqlx::query("UPDATE session_devices SET created_at=clock_timestamp()-interval '20 minutes' WHERE id=(SELECT device_id FROM sessions WHERE token_hash=$1)")
        .bind(auth::hash_token(&rotated.token)).execute(&pool).await.unwrap();
    let mut sdk = rv_client::NativeClient::new(&server.base).unwrap();
    sdk.restore(rotated.token.clone());
    let recovered = sdk
        .regenerate_factor_backups(&rv_protocol::parity::RegenerateFactorBackups {
            factor_version: version.clone(),
            operation_id: "regenerate-1".into(),
        })
        .await
        .unwrap();
    assert!(
        recovered.codes == codes.codes,
        "lost acknowledgement must recover the same code bag"
    );
    assert_eq!(
        server.get("/me", &other.token).await.status(),
        StatusCode::OK,
        "receipt replay must not revoke a device created after the original commit"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM factor_backup_codes WHERE consumed_at IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        9
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM factor_backup_regenerations")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    let stored: Value = sqlx::query_scalar("SELECT to_jsonb(r) FROM factor_backup_regenerations r")
        .fetch_one(&pool)
        .await
        .unwrap();
    let stored = stored.to_string();
    assert!(codes.codes.iter().all(|c| !stored.contains(c)));
    assert_eq!(
        server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&rotated.token),
                json!({"factor_version":version,"operation_id":"different-operation"})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
}

#[sqlx::test]
async fn backup_regeneration_quota_survives_source_device_revocation(pool: PgPool) {
    let (_, server, enrolling) = fixture(&pool).await;
    let (_, original) = enroll(&server, &enrolling).await;
    reset_limits(&pool).await;
    let session = full_login(&server, &original.codes[0], "full-login").await;
    let mut latest = FactorBackupCodes { codes: vec![] };
    let mut last_input = json!({});
    for i in 0..3 {
        last_input = json!({"factor_version":factor_version(&server, &session.token).await,"operation_id":format!("regenerate-{i}")});
        let response = server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&session.token),
                last_input.clone(),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        latest = response.json().await.unwrap();
    }
    let replay = server
        .post(
            "/me/factors/recovery/regenerate",
            Some(&session.token),
            last_input,
        )
        .await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert!(replay.json::<FactorBackupCodes>().await.unwrap().codes == latest.codes);
    let other = full_login(&server, &latest.codes[0], "replacement-device").await;
    let device: String = sqlx::query_scalar("SELECT device_id FROM sessions WHERE token_hash=$1")
        .bind(auth::hash_token(&session.token))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .http
            .delete(format!("{}/api/v1/me/sessions/{device}", server.base))
            .bearer_auth(&other.token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM factor_backup_regenerations WHERE device_id IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        3
    );
    let rejected = server.post("/me/factors/recovery/regenerate", Some(&other.token), json!({"factor_version":factor_version(&server, &other.token).await,"operation_id":"quota-bypass"})).await;
    assert_eq!(rejected.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(rejected.headers()["retry-after"], "900");
    assert_eq!(
        rejected.json::<Value>().await.unwrap()["code"],
        "factor_regeneration_limit"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM factor_backup_codes WHERE consumed_at IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        9
    );
}

#[sqlx::test]
async fn backup_regeneration_receipts_are_bound_to_cipher_purpose_generation_and_authority(
    pool: PgPool,
) {
    let (_, server, enrolling) = fixture(&pool).await;
    let (_, original) = enroll(&server, &enrolling).await;
    reset_limits(&pool).await;
    let session = full_login(&server, &original.codes[0], "full-login").await;
    let input = json!({"factor_version":factor_version(&server, &session.token).await,"operation_id":"regenerate-1"});
    assert_eq!(
        server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&session.token),
                input.clone()
            )
            .await
            .status(),
        StatusCode::OK
    );
    let cipher: Vec<u8> =
        sqlx::query_scalar("SELECT receipt_cipher FROM factor_backup_regenerations")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("UPDATE factor_backup_regenerations SET receipt_cipher=(SELECT totp_cipher FROM user_factors)").execute(&pool).await.unwrap();
    assert_eq!(
        server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&session.token),
                input.clone()
            )
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    sqlx::query("UPDATE factor_backup_regenerations SET receipt_cipher=$1")
        .bind(cipher)
        .execute(&pool)
        .await
        .unwrap();
    let epoch: String = sqlx::query_scalar("SELECT data_epoch FROM instance")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE instance SET data_epoch=$1")
        .bind(auth::random_token())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&session.token),
                input.clone()
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE instance SET data_epoch=$1")
        .bind(epoch)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET admin=NOT admin")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&session.token),
                input
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM factor_backup_regenerations")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM factor_backup_codes WHERE consumed_at IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        10
    );
}

#[sqlx::test]
async fn backup_regeneration_expiry_is_checked_after_receipt_lock_and_pruning_cannot_reapply_it(
    pool: PgPool,
) {
    let (app, server, enrolling) = fixture(&pool).await;
    let (_, original) = enroll(&server, &enrolling).await;
    reset_limits(&pool).await;
    let session = full_login(&server, &original.codes[0], "full-login").await;
    let input = json!({"factor_version":factor_version(&server, &session.token).await,"operation_id":"regenerate-1"});
    assert_eq!(
        server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&session.token),
                input.clone()
            )
            .await
            .status(),
        StatusCode::OK
    );
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM factor_backup_regenerations FOR UPDATE")
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    let base = server.base.clone();
    let token = session.token.clone();
    let pending_input = input.clone();
    let task = tokio::spawn(async move {
        Client::new()
            .post(format!("{base}/api/v1/me/factors/recovery/regenerate"))
            .bearer_auth(token)
            .json(&pending_input)
            .send()
            .await
            .unwrap()
    });
    let mut waiting = false;
    for _ in 0..100 {
        waiting = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id,requested_version,committed_version,%')").fetch_one(&pool).await.unwrap();
        if waiting {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        waiting,
        "the HTTP retry must wait for the real receipt lock"
    );
    sqlx::query(
        "UPDATE factor_backup_regenerations SET expires_at=clock_timestamp()-interval '1 second'",
    )
    .execute(&mut *lock)
    .await
    .unwrap();
    lock.commit().await.unwrap();
    assert_eq!(task.await.unwrap().status(), StatusCode::CONFLICT);
    app.cleanup().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM factor_backup_regenerations WHERE receipt_cipher IS NOT NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    sqlx::query(
        "UPDATE factor_backup_regenerations SET created_at=clock_timestamp()-interval '2 days'",
    )
    .execute(&pool)
    .await
    .unwrap();
    app.cleanup().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM factor_backup_regenerations")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&session.token),
                input
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM factor_backup_codes WHERE consumed_at IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        10
    );
}

#[sqlx::test]
async fn backup_regeneration_fails_closed_on_invalid_authority_recent_proof_and_operator_key(
    pool: PgPool,
) {
    let (_, server, enrolling) = fixture(&pool).await;
    let (_, original) = enroll(&server, &enrolling).await;
    reset_limits(&pool).await;
    let session = full_login(&server, &original.codes[0], "full-login").await;
    let version = factor_version(&server, &session.token).await;
    let input = json!({"factor_version":version,"operation_id":"regenerate-1"});
    assert_eq!(server.post("/me/factors/recovery/regenerate", Some(&session.token), json!({"factor_version":version,"operation_id":"forged","user_id":enrolling.user.id})).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&session.token),
                json!({"factor_version":"stale","operation_id":"old-version"})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let broken = App::from_pool_with_auth_key(
        pool.clone(),
        Some(AuthKey::from_hex(&"39".repeat(32)).unwrap()),
    )
    .await
    .unwrap();
    let broken = Server::start(broken).await;
    assert_eq!(
        broken
            .post(
                "/me/factors/recovery/regenerate",
                Some(&session.token),
                input.clone()
            )
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    sqlx::query("UPDATE session_devices SET created_at=clock_timestamp()-interval '20 minutes'")
        .execute(&pool)
        .await
        .unwrap();
    let rotated = server
        .post(
            "/auth/renew",
            Some(&session.token),
            json!({"operation_id":"rotate-old-proof","next_token":auth::random_token()}),
        )
        .await
        .json::<Session>()
        .await
        .unwrap();
    assert_eq!(
        server
            .post(
                "/me/factors/recovery/regenerate",
                Some(&rotated.token),
                input
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM factor_backup_codes WHERE consumed_at IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        9
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM factor_backup_regenerations")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(factor_version(&server, &rotated.token).await, version);
}

#[sqlx::test]
async fn enrollment_and_totp_are_single_use_but_lost_ack_replays_one_session(pool: PgPool) {
    let (app, server, enrolling) = fixture(&pool).await;
    let other = auth::login(&app, "owner".into(), PASSWORD.into())
        .await
        .unwrap();
    let setup = begin(&server, &enrolling, "setup-1").await;
    let replay = begin(&server, &enrolling, "setup-1").await;
    assert_eq!(setup.secret, replay.secret);
    assert_eq!(setup.setup_id, replay.setup_id);
    assert_eq!(
        data_encoding::BASE32_NOPAD
            .decode(setup.secret.as_bytes())
            .unwrap()
            .len(),
        20
    );
    assert!(
        setup
            .provisioning_uri
            .contains("algorithm=SHA1&digits=6&period=30")
    );
    let input = json!({"setup_id":setup.setup_id,"operation_id":"enable-1","code":totp(&setup.secret,Utc::now().timestamp()/30)});
    let (a, b) = tokio::join!(
        server.post(
            "/me/factors/totp/enable",
            Some(&enrolling.token),
            input.clone()
        ),
        server.post("/me/factors/totp/enable", Some(&enrolling.token), input)
    );
    // A request admitted before the authority changed must revalidate; a new
    // replay with the current authority recovers the encrypted code receipt.
    assert!(matches!(a.status(), StatusCode::OK | StatusCode::CONFLICT));
    assert!(matches!(b.status(), StatusCode::OK | StatusCode::CONFLICT));
    assert!(a.status() == StatusCode::OK || b.status() == StatusCode::OK);
    let codes = if a.status() == StatusCode::OK { a } else { b }
        .json::<FactorBackupCodes>()
        .await
        .unwrap();
    assert_eq!(codes.codes.len(), 10);
    let replay = server
        .post(
            "/me/factors/totp/enable",
            Some(&enrolling.token),
            json!({"setup_id":setup.setup_id,"operation_id":"enable-1","code":"lost-response"}),
        )
        .await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(
        replay.json::<FactorBackupCodes>().await.unwrap().codes,
        codes.codes
    );
    assert_eq!(
        server.get("/me", &other.token).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        server.get("/me", &enrolling.token).await.status(),
        StatusCode::OK
    );
    let status: Value = server
        .get("/me/factors", &enrolling.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(status["backup_codes_remaining"], 10);
    assert_eq!(
        server
            .post(
                "/me/factors/totp/disable",
                Some(&enrolling.token),
                json!({"factor_version":status["factor_version"]})
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        server
            .post(
                "/auth/login",
                None,
                json!({"username":"owner","password":PASSWORD})
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    reset_limits(&pool).await;
    let challenge = server.challenge().await;
    let next = auth::random_token();
    let counter = Utc::now().timestamp() / 30 + 1;
    let code = totp(&setup.secret, counter);
    let (a, b) = tokio::join!(
        server.finish(&challenge, &code, "totp", &next, "login-1"),
        server.finish(&challenge, &code, "totp", &next, "login-1")
    );
    assert_eq!(a.status(), StatusCode::OK);
    assert_eq!(b.status(), StatusCode::OK);
    assert_eq!(a.json::<Session>().await.unwrap().token, next);
    assert_eq!(b.json::<Session>().await.unwrap().token, next);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT last_totp_counter FROM user_factors")
            .fetch_one(&pool)
            .await
            .unwrap(),
        counter
    );
    let stored: Value = sqlx::query_scalar("SELECT jsonb_build_object('factors',(SELECT jsonb_agg(f) FROM user_factors f),'setups',(SELECT jsonb_agg(s) FROM factor_setups s),'backups',(SELECT jsonb_agg(b) FROM factor_backup_codes b),'challenges',(SELECT jsonb_agg(c) FROM auth_challenges c))").fetch_one(&pool).await.unwrap();
    let stored = stored.to_string();
    for secret in [
        setup.secret.as_str(),
        code.as_str(),
        challenge.as_str(),
        next.as_str(),
        codes.codes[0].as_str(),
    ] {
        assert!(!stored.contains(secret));
    }
    assert_eq!(
        server
            .finish(&challenge, "", "totp", &next, "login-1")
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        server
            .finish(&challenge, &code, "totp", &auth::random_token(), "login-2")
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    reset_limits(&pool).await;
    let second = server.challenge().await;
    assert_eq!(
        server
            .finish(&second, &code, "totp", &auth::random_token(), "login-3")
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    sqlx::query("UPDATE auth_challenges SET receipt_expires_at=clock_timestamp()-interval '1 second' WHERE accepted_operation IS NOT NULL").execute(&pool).await.unwrap();
    assert_eq!(
        server
            .finish(&challenge, &code, "totp", &next, "login-1")
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
}

#[sqlx::test]
async fn backup_code_race_consumes_once_and_sdk_does_not_replace_active_credentials(pool: PgPool) {
    let (_, server, enrolling) = fixture(&pool).await;
    let (_, codes) = enroll(&server, &enrolling).await;
    reset_limits(&pool).await;
    let a = server.challenge().await;
    let b = server.challenge().await;
    let next_a = auth::random_token();
    let next_b = auth::random_token();
    let (first, second) = tokio::join!(
        server.finish(&a, &codes.codes[0], "recovery_code", &next_a, "backup-a"),
        server.finish(&b, &codes.codes[0], "recovery_code", &next_b, "backup-b")
    );
    assert!(matches!(
        (first.status(), second.status()),
        (StatusCode::OK, StatusCode::BAD_REQUEST) | (StatusCode::BAD_REQUEST, StatusCode::OK)
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM factor_backup_codes WHERE consumed_at IS NOT NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let mut client = rv_client::NativeClient::new(&server.base).unwrap();
    client.restore(enrolling.token.clone());
    let challenge = match client.start_login("owner", PASSWORD).await.unwrap() {
        AuthenticationStep::Challenge { challenge, .. } => challenge,
        _ => panic!("SDK failed to surface challenge"),
    };
    assert_eq!(
        client.saved_token().as_deref(),
        Some(enrolling.token.as_str())
    );
    let next = auth::random_token();
    let session = client
        .finish_factor(&FinishFactor {
            challenge_id: challenge.challenge_id,
            method: SecondFactor::RecoveryCode,
            code: codes.codes[1].clone(),
            operation_id: "sdk-login".into(),
            next_token: next.clone(),
        })
        .await
        .unwrap();
    assert_eq!(session.token, next);
    assert_eq!(
        client.saved_token().as_deref(),
        Some(enrolling.token.as_str())
    );
    client.restore(next);
    let status = client.factor_status().await.unwrap();
    assert_eq!(status.backup_codes_remaining, 8);
    client
        .disable_factor(&rv_protocol::parity::DisableFactor {
            factor_version: status.factor_version.unwrap(),
        })
        .await
        .unwrap();
    assert!(!client.factor_status().await.unwrap().totp);
    assert_eq!(
        server.get("/me", &enrolling.token).await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test]
async fn five_failed_codes_are_persistent_across_restart_and_do_not_create_sessions(pool: PgPool) {
    let (_, server, enrolling) = fixture(&pool).await;
    let (_, codes) = enroll(&server, &enrolling).await;
    reset_limits(&pool).await;
    let challenge = server.challenge().await;
    for index in 0..5 {
        assert_eq!(
            server
                .finish(
                    &challenge,
                    "invalid",
                    "totp",
                    &auth::random_token(),
                    &format!("wrong-{index}")
                )
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    drop(server);
    let restarted = App::from_pool_with_auth_key(
        pool.clone(),
        Some(AuthKey::from_hex(&"37".repeat(32)).unwrap()),
    )
    .await
    .unwrap();
    let server = Server::start(restarted).await;
    assert_eq!(
        server
            .finish(
                &challenge,
                &codes.codes[0],
                "recovery_code",
                &auth::random_token(),
                "too-late"
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT attempts FROM auth_challenges")
            .fetch_one(&pool)
            .await
            .unwrap(),
        5
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM factor_backup_codes WHERE consumed_at IS NOT NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    let unknown = auth::random_token();
    for index in 0..3 {
        let _ = server
            .finish(
                &unknown,
                "invalid",
                "totp",
                &auth::random_token(),
                &format!("unknown-{index}"),
            )
            .await;
    }
    assert_eq!(server.challenge().await.len(), 64);
}

#[sqlx::test]
async fn missing_wrong_and_corrupt_keys_never_downgrade_a_protected_account(pool: PgPool) {
    let (_, server, enrolling) = fixture(&pool).await;
    enroll(&server, &enrolling).await;
    drop(server);
    for key in [None, Some(AuthKey::from_hex(&"47".repeat(32)).unwrap())] {
        let app = App::from_pool_with_auth_key(pool.clone(), key)
            .await
            .unwrap();
        let server = Server::start(app).await;
        assert_eq!(
            server
                .post(
                    "/auth/start",
                    None,
                    json!({"username":"owner","password":PASSWORD})
                )
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            server
                .post(
                    "/auth/login",
                    None,
                    json!({"username":"owner","password":PASSWORD})
                )
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    sqlx::query("UPDATE user_factors SET totp_cipher=decode('00','hex')")
        .execute(&pool)
        .await
        .unwrap();
    let app = App::from_pool_with_auth_key(
        pool.clone(),
        Some(AuthKey::from_hex(&"37".repeat(32)).unwrap()),
    )
    .await
    .unwrap();
    let server = Server::start(app).await;
    assert_eq!(
        server
            .post(
                "/auth/start",
                None,
                json!({"username":"owner","password":PASSWORD})
            )
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}

#[sqlx::test]
async fn restore_password_reset_and_account_changes_fence_challenges_but_preserve_factor(
    pool: PgPool,
) {
    let (app, server, enrolling) = fixture(&pool).await;
    let (_, codes) = enroll(&server, &enrolling).await;
    reset_limits(&pool).await;
    let challenge = server.challenge().await;
    let recovery = rv_server::recovery::issue(&app, "owner", 1).await.unwrap();
    let recovered = server.post("/auth/recovery",None,json!({"token":recovery.token,"username":"owner","new_password":"changed-password-2026"})).await;
    assert_eq!(recovered.status(), StatusCode::OK);
    assert_eq!(
        server
            .finish(
                &challenge,
                &codes.codes[0],
                "recovery_code",
                &auth::random_token(),
                "old-password-proof"
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        server
            .post(
                "/auth/login",
                None,
                json!({"username":"owner","password":"changed-password-2026"})
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    reset_limits(&pool).await;
    let result: AuthenticationStep = server
        .post(
            "/auth/start",
            None,
            json!({"username":"owner","password":"changed-password-2026"}),
        )
        .await
        .json()
        .await
        .unwrap();
    let challenge = match result {
        AuthenticationStep::Challenge { challenge, .. } => challenge.challenge_id,
        _ => panic!("password reset removed factor"),
    };
    sqlx::query("UPDATE instance SET data_epoch=$1")
        .bind(auth::random_token())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .finish(
                &challenge,
                &codes.codes[0],
                "recovery_code",
                &auth::random_token(),
                "old-epoch"
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    // The ciphertext AAD excludes data_epoch: the new generation can still use
    // the operator key, while all old challenges are rejected.
    let result: AuthenticationStep = server
        .post(
            "/auth/start",
            None,
            json!({"username":"owner","password":"changed-password-2026"}),
        )
        .await
        .json()
        .await
        .unwrap();
    let challenge = match result {
        AuthenticationStep::Challenge { challenge, .. } => challenge.challenge_id,
        _ => panic!("restore removed factor"),
    };
    sqlx::query("UPDATE users SET disabled=true WHERE username='owner'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .finish(
                &challenge,
                &codes.codes[0],
                "recovery_code",
                &auth::random_token(),
                "disabled"
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_factors")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}

#[sqlx::test]
async fn delayed_factor_verification_rechecks_expiry_after_sql_lock(pool: PgPool) {
    let (_, server, enrolling) = fixture(&pool).await;
    let (_, codes) = enroll(&server, &enrolling).await;
    reset_limits(&pool).await;
    let challenge = server.challenge().await;
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("SELECT token_hash FROM auth_challenges FOR UPDATE")
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    let base = server.base.clone();
    let code = codes.codes[0].clone();
    let pending_challenge = challenge.clone();
    let task = tokio::spawn(async move {
        Client::new().post(format!("{base}/api/v1/auth/factors/verify")).json(&json!({"challenge_id":pending_challenge,"code":code,"method":"recovery_code","operation_id":"delayed","next_token":auth::random_token()})).send().await.unwrap()
    });
    let mut waiting = false;
    for _ in 0..100 {
        waiting=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT data_epoch,activation_version,factor_version,expires_at%')").fetch_one(&pool).await.unwrap();
        if waiting {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        waiting,
        "HTTP verifier must be waiting for the real SQL lock"
    );
    sqlx::query("UPDATE auth_challenges SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&mut *lock)
        .await
        .unwrap();
    lock.commit().await.unwrap();
    assert_eq!(task.await.unwrap().status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM factor_backup_codes WHERE consumed_at IS NOT NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
}

#[sqlx::test]
async fn typescript_sdk_uses_real_postgres_factor_routes_and_recovers_a_lost_ack(pool: PgPool) {
    let (_, server, _) = fixture(&pool).await;
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/native-factors-smoke.ts");
    let output = tokio::process::Command::new("node")
        .arg(script)
        .arg(&server.base)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("recent full-factor disable passed"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_factors")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}

#[sqlx::test]
async fn factor_disable_requires_recent_full_auth_and_never_removes_a_newer_factor(pool: PgPool) {
    let (_, server, enrolling) = fixture(&pool).await;
    let (_, codes) = enroll(&server, &enrolling).await;
    reset_limits(&pool).await;
    let challenge = server.challenge().await;
    let next = auth::random_token();
    assert_eq!(
        server
            .finish(
                &challenge,
                &codes.codes[0],
                "recovery_code",
                &next,
                "full-login"
            )
            .await
            .status(),
        StatusCode::OK
    );
    let status: Value = server.get("/me/factors", &next).await.json().await.unwrap();
    let full_device: String =
        sqlx::query_scalar("SELECT device_id FROM sessions WHERE token_hash=$1")
            .bind(auth::hash_token(&next))
            .fetch_one(&pool)
            .await
            .unwrap();
    let denied = server
        .http
        .delete(format!("{}/api/v1/me/sessions/{full_device}", server.base))
        .bearer_auth(&enrolling.token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        denied.status(),
        StatusCode::FORBIDDEN,
        "the pre-factor enrollment session cannot revoke a newly authenticated device"
    );
    assert_eq!(server.get("/me", &next).await.status(), StatusCode::OK);
    let disable = json!({"factor_version":status["factor_version"]});
    sqlx::query("UPDATE session_devices SET created_at=clock_timestamp()-interval '20 minutes' WHERE id=(SELECT device_id FROM sessions WHERE token_hash=$1)").bind(auth::hash_token(&next)).execute(&pool).await.unwrap();
    let renewed = server
        .post(
            "/auth/renew",
            Some(&next),
            json!({"operation_id":"rotate-stale","next_token":auth::random_token()}),
        )
        .await
        .json::<Session>()
        .await
        .unwrap();
    assert_eq!(
        server
            .post(
                "/me/factors/totp/disable",
                Some(&renewed.token),
                disable.clone()
            )
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        server
            .finish(
                &challenge,
                &codes.codes[0],
                "recovery_code",
                &next,
                "full-login"
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    reset_limits(&pool).await;
    let challenge = server.challenge().await;
    let next = auth::random_token();
    assert_eq!(
        server
            .finish(
                &challenge,
                &codes.codes[1],
                "recovery_code",
                &next,
                "fresh-login"
            )
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        server
            .post("/me/factors/totp/disable", Some(&next), disable.clone())
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        server
            .post("/me/factors/totp/disable", Some(&next), disable.clone())
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let session = Session {
        token: next,
        expires_at: "unused".into(),
        user: enrolling.user,
    };
    enroll(&server, &session).await;
    assert_eq!(
        server
            .post("/me/factors/totp/disable", Some(&session.token), disable)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let status: Value = server
        .get("/me/factors", &session.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(status["totp"], true);
    assert_eq!(status["backup_codes_remaining"], 10);
}

#[sqlx::test]
async fn factor_setup_is_bounded_and_candidate_conflicts_do_not_spend_backup_codes(pool: PgPool) {
    let (_, server, enrolling) = fixture(&pool).await;
    let setup = begin(&server, &enrolling, "bounded-setup").await;
    assert_eq!(
        server
            .post(
                "/me/factors/totp/setup",
                Some(&enrolling.token),
                json!({"operation_id":"other-setup"})
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    for index in 0..5 {
        assert_eq!(server.post("/me/factors/totp/enable",Some(&enrolling.token),json!({"setup_id":setup.setup_id,"operation_id":format!("wrong-{index}"),"code":"invalid"})).await.status(),StatusCode::BAD_REQUEST);
    }
    let valid = totp(&setup.secret, Utc::now().timestamp() / 30);
    assert_eq!(
        server
            .post(
                "/me/factors/totp/enable",
                Some(&enrolling.token),
                json!({"setup_id":setup.setup_id,"operation_id":"late-setup","code":valid})
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT attempts FROM factor_setups")
            .fetch_one(&pool)
            .await
            .unwrap(),
        5
    );
    // Expire the fixture's abandoned setup; the next operation gets a new key.
    sqlx::query("UPDATE factor_setups SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    reset_limits(&pool).await;
    let (_, codes) = enroll(&server, &enrolling).await;
    reset_limits(&pool).await;
    let challenge = server.challenge().await;
    assert_eq!(
        server
            .finish(
                &challenge,
                &codes.codes[0],
                "recovery_code",
                &enrolling.token,
                "existing-candidate"
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        server
            .finish(
                &challenge,
                &codes.codes[0],
                "recovery_code",
                &challenge,
                "challenge-as-bearer"
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM factor_backup_codes WHERE consumed_at IS NOT NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        server
            .finish(
                &challenge,
                &codes.codes[0],
                "recovery_code",
                &auth::random_token(),
                "valid-candidate"
            )
            .await
            .status(),
        StatusCode::OK
    );
    reset_limits(&pool).await;
    for _ in 0..5 {
        server.challenge().await;
    }
    let limited = server
        .post(
            "/auth/start",
            None,
            json!({"username":"owner","password":PASSWORD}),
        )
        .await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.headers()["retry-after"], "60");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM auth_challenges WHERE accepted_operation IS NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        5
    );
}
