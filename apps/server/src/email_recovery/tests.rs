use super::*;
use crate::{email::tests::Relay, factor_crypto::AuthKey, factors, recovery};
use rv_protocol::parity::{
    AuthenticationStep, BeginFactorSetup, EnableFactor, FinishFactor, RecoverAccount, SecondFactor,
};
use sqlx::PgPool;
use std::time::Duration;
const PASSWORD: &str = "mail-recovery-test-password";
const NEXT: &str = "new-mail-recovery-test-password";
const ADDRESS: &str = "owner@example.test";
async fn fixture(pool: &PgPool, relay: &Relay) -> (App, rv_protocol::Session) {
    let app = App::from_pool_with_auth_key(
        pool.clone(),
        Some(AuthKey::from_hex(&"37".repeat(32)).unwrap()),
    )
    .await
    .unwrap()
    .with_mail(Some(relay.sender()));
    let user = auth::create_user(&app, "owner", PASSWORD.into(), false)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO account_emails(user_id,address,verified_at) VALUES($1,$2,clock_timestamp())",
    )
    .bind(user.id)
    .bind(ADDRESS)
    .execute(pool)
    .await
    .unwrap();
    let session = auth::login(&app, "owner".into(), PASSWORD.into())
        .await
        .unwrap();
    (app, session)
}
async fn input(app: &App, name: &str) -> RequestEmailRecovery {
    let (instance_id, data_epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    RequestEmailRecovery {
        operation_id: auth::random_token(),
        username: name.into(),
        instance_id,
        data_epoch,
    }
}
async fn count(pool: &PgPool, query: &str) -> i64 {
    sqlx::query_scalar(query).fetch_one(pool).await.unwrap()
}
fn confirmation(code: String) -> RecoverAccount {
    RecoverAccount {
        token: code,
        username: "owner".into(),
        new_password: NEXT.into(),
    }
}
fn totp(secret: &str) -> String {
    use hmac::{Hmac, Mac};
    let secret = data_encoding::BASE32_NOPAD
        .decode(secret.as_bytes())
        .unwrap();
    let mut mac = <Hmac<sha1::Sha1> as Mac>::new_from_slice(&secret).unwrap();
    mac.update(&((Utc::now().timestamp() / 30) as u64).to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 15) as usize;
    format!(
        "{:06}",
        (u32::from_be_bytes(digest[offset..offset + 4].try_into().unwrap()) & 0x7fff_ffff)
            % 1_000_000
    )
}
#[sqlx::test]
async fn public_response_is_uniform_private_and_uses_real_http_without_bearer(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, _) = fixture(&pool, &relay).await;
    auth::create_user(&app, "unverified", PASSWORD.into(), false)
        .await
        .unwrap();
    auth::create_user(&app, "disabled", PASSWORD.into(), false)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET disabled=true WHERE username='disabled'")
        .execute(&pool)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = app.clone().router();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let client = reqwest::Client::new();
    for name in ["owner", "unverified", "disabled", "unknown"] {
        let reply = client
            .post(format!("{base}/api/v1/auth/recovery/email/start"))
            .json(&input(&app, name).await)
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), reqwest::StatusCode::ACCEPTED);
        assert_eq!(reply.headers()["cache-control"], "no-store");
        assert_eq!(
            reply.json::<serde_json::Value>().await.unwrap(),
            serde_json::json!({"accepted":true})
        );
    }
    let sdk = rv_client::NativeClient::new(&base).unwrap();
    assert!(
        sdk.request_email_recovery(&input(&app, "unknown").await)
            .await
            .unwrap()
            .accepted
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM email_recovery_requests").await,
        5
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM email_recovery_outbox").await,
        1
    );
    assert_eq!(crate::email_delivery::drain(&app).await.unwrap(), 1);
    assert_eq!(relay.codes(ADDRESS).await.len(), 1);
    assert!(relay.codes("unverified@example.test").await.is_empty());
    assert!(sdk.discover().await.unwrap().capabilities.email_recovery);
    assert!(
        sdk.recover_account(&confirmation(relay.code(ADDRESS).await))
            .await
            .unwrap()
            .username
            == "owner"
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM session_devices").await,
        0
    );
    let mut malformed = serde_json::to_value(input(&app, "owner").await).unwrap();
    malformed["address"] = serde_json::json!("attacker@example.test");
    assert_eq!(
        client
            .post(format!("{base}/api/v1/auth/recovery/email/start"))
            .json(&malformed)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::BAD_REQUEST
    );
    server.abort();
}
#[sqlx::test]
async fn original_request_and_smtp_ambiguity_survive_concurrency_and_runtime_restart(pool: PgPool) {
    let relay = Relay::start(true).await;
    let (app, _) = fixture(&pool, &relay).await;
    let request_input = input(&app, "owner").await;
    let (a, b) = tokio::join!(
        request(&app, request_input.clone(), None),
        request(&app, request_input.clone(), None)
    );
    assert!(a.unwrap().accepted && b.unwrap().accepted);
    let original: (String, DateTime<Utc>) =
        sqlx::query_as("SELECT token_hash,expires_at FROM email_recovery_requests")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 0);
    let code = relay.code(ADDRESS).await;
    assert!(nonce(&code) && auth::hash_token(&code) == original.0);
    let cipher: Vec<u8> = sqlx::query_scalar("SELECT payload_cipher FROM email_recovery_outbox")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!cipher.windows(code.len()).any(|v| v == code.as_bytes()));
    let restarted = App::from_pool_with_auth_key(
        pool.clone(),
        Some(AuthKey::from_hex(&"37".repeat(32)).unwrap()),
    )
    .await
    .unwrap()
    .with_mail(Some(relay.sender()));
    assert!(
        request(&restarted, request_input.clone(), None)
            .await
            .unwrap()
            .accepted
    );
    sqlx::query("UPDATE email_recovery_outbox SET next_attempt_at=clock_timestamp()")
        .execute(&pool)
        .await
        .unwrap();
    let (a, b) = tokio::join!(drain(&restarted), drain(&restarted));
    assert_eq!(a.unwrap() + b.unwrap(), 1);
    let copies = relay.codes(ADDRESS).await;
    assert!(copies.len() == 2 && copies[0] == copies[1]);
    let current: (String, DateTime<Utc>) =
        sqlx::query_as("SELECT token_hash,expires_at FROM email_recovery_requests")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(current == original);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM account_recovery_codes").await,
        1
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM email_delivery_admissions").await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM email_recovery_outbox WHERE payload_cipher IS NOT NULL"
        )
        .await,
        0
    );
    let mut other = request_input;
    other.username = "unknown".into();
    assert!(request(&restarted, other, None).await.unwrap().accepted);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM email_recovery_requests").await,
        1
    );
}
#[sqlx::test]
async fn accepted_mail_code_preserves_totp_backups_messages_and_replay_does_not_revoke_new_login(
    pool: PgPool,
) {
    let relay = Relay::start(false).await;
    let (app, old) = fixture(&pool, &relay).await;
    let account = auth::authenticate(&app, &auth::hash_token(&old.token))
        .await
        .unwrap();
    let setup = factors::begin(
        &app,
        &account,
        BeginFactorSetup {
            operation_id: auth::random_token(),
        },
    )
    .await
    .unwrap();
    let saved = factors::enable(
        &app,
        &account,
        EnableFactor {
            setup_id: setup.setup_id,
            operation_id: auth::random_token(),
            code: totp(&setup.secret),
        },
    )
    .await
    .unwrap();
    let profile: (String, Vec<u8>, i64) =
        sqlx::query_as("SELECT version,totp_cipher,last_totp_counter FROM user_factors")
            .fetch_one(&pool)
            .await
            .unwrap();
    let backups: Vec<String> =
        sqlx::query_scalar("SELECT token_hash FROM factor_backup_codes ORDER BY token_hash")
            .fetch_all(&pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO rooms(id,name,kind) VALUES('kept-room','Kept room','private')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO members(room_id,user_id,role) VALUES('kept-room',$1,'owner')")
        .bind(&old.user.id)
        .execute(&pool)
        .await
        .unwrap();
    let account = auth::authenticate(&app, &auth::hash_token(&old.token))
        .await
        .unwrap();
    let message = crate::store::send(
        &app,
        &account,
        "kept-room",
        rv_protocol::SendMessage {
            quotes: vec![],
            operation_id: auth::random_token(),
            text: "Conversation retained after password recovery".into(),
        },
    )
    .await
    .unwrap();
    request(&app, input(&app, "owner").await, None)
        .await
        .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 1);
    let claim = confirmation(relay.code(ADDRESS).await);
    let (a, b) = tokio::join!(
        recovery::accept(&app, claim.clone(), None),
        recovery::accept(&app, claim.clone(), None)
    );
    assert!(a.unwrap().id == old.user.id && b.unwrap().id == old.user.id);
    assert!(
        auth::authenticate(&app, &auth::hash_token(&old.token))
            .await
            .is_err()
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM session_devices").await,
        0
    );
    assert!(
        sqlx::query_as::<_, (String, Vec<u8>, i64)>(
            "SELECT version,totp_cipher,last_totp_counter FROM user_factors"
        )
        .fetch_one(&pool)
        .await
        .unwrap()
            == profile
    );
    assert!(
        sqlx::query_scalar::<_, String>(
            "SELECT token_hash FROM factor_backup_codes ORDER BY token_hash"
        )
        .fetch_all(&pool)
        .await
        .unwrap()
            == backups
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM members WHERE room_id='kept-room' AND role='owner'"
        )
        .await,
        1
    );
    let retained: (String, String) =
        sqlx::query_as("SELECT author_id,text FROM messages WHERE id=$1")
            .bind(&message.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(retained.0 == old.user.id && retained.1 == message.text);
    let step = auth::start_login(&app, "owner".into(), NEXT.into(), None)
        .await
        .unwrap();
    let challenge = match step {
        AuthenticationStep::Challenge { challenge, .. } => challenge,
        _ => panic!("Recovery bypassed installed TOTP"),
    };
    assert!(
        challenge
            .methods
            .iter()
            .any(|method| matches!(method, SecondFactor::Totp))
    );
    let fresh = factors::finish(
        &app,
        FinishFactor {
            challenge_id: challenge.challenge_id,
            method: SecondFactor::RecoveryCode,
            code: saved.codes[0].clone(),
            operation_id: auth::random_token(),
            next_token: auth::random_token(),
        },
        None,
    )
    .await
    .unwrap();
    // The same code can replay the password receipt without another revocation.
    let before: i64 = count(&pool, "SELECT count(*) FROM auth_challenges").await;
    assert!(recovery::accept(&app, claim, None).await.unwrap().id == old.user.id);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM auth_challenges").await,
        before
    );
    assert!(
        auth::authenticate(&app, &auth::hash_token(&fresh.token))
            .await
            .unwrap()
            .id
            == old.user.id
    );
}
#[sqlx::test]
async fn removed_contact_invalidates_pending_delivery_and_delivered_code(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, _) = fixture(&pool, &relay).await;
    request(&app, input(&app, "owner").await, None)
        .await
        .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 1);
    let claim = confirmation(relay.code(ADDRESS).await);
    request(&app, input(&app, "owner").await, None)
        .await
        .unwrap();
    sqlx::query("DELETE FROM account_emails")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        recovery::accept(&app, claim, None)
            .await
            .is_err_and(|e| e.code == "recovery_rejected")
    );
    assert_eq!(drain(&app).await.unwrap(), 0);
    let retry = input(&app, "owner").await;
    assert!(request(&app, retry, None).await.unwrap().accepted);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM account_recovery_codes").await,
        2
    );
    assert_eq!(relay.codes(ADDRESS).await.len(), 1);
    app.cleanup().await.unwrap();
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM email_recovery_outbox WHERE payload_cipher IS NOT NULL"
        )
        .await,
        0
    );
}
#[sqlx::test]
async fn contact_changed_while_accept_waits_on_real_account_lock_rejects_original_code(
    pool: PgPool,
) {
    let relay = Relay::start(false).await;
    let (app, session) = fixture(&pool, &relay).await;
    request(&app, input(&app, "owner").await, None)
        .await
        .unwrap();
    drain(&app).await.unwrap();
    let claim = confirmation(relay.code(ADDRESS).await);
    let mut locked = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&session.user.id)
        .execute(&mut *locked)
        .await
        .unwrap();
    let running = app.clone();
    let task = tokio::spawn(async move { recovery::accept(&running, claim, None).await });
    let mut blocked = false;
    for _ in 0..100 {
        let waiting:i64=sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id,username,display_name,password_hash,activation_version,email_version,%FOR NO KEY UPDATE%'").fetch_one(&pool).await.unwrap();
        if waiting > 0 {
            blocked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(blocked, "Acceptance must wait on the actual account lock");
    sqlx::query("UPDATE users SET email_version='changed-contact' WHERE id=$1")
        .bind(&session.user.id)
        .execute(&mut *locked)
        .await
        .unwrap();
    locked.commit().await.unwrap();
    assert!(
        task.await
            .unwrap()
            .is_err_and(|e| e.code == "recovery_rejected")
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM account_recovery_codes WHERE consumed_at IS NOT NULL"
        )
        .await,
        0
    );
}
#[sqlx::test]
async fn instance_epoch_expiration_and_authority_fence_delivery_and_confirmation(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, _) = fixture(&pool, &relay).await;
    request(&app, input(&app, "owner").await, None)
        .await
        .unwrap();
    drain(&app).await.unwrap();
    let claim = confirmation(relay.code(ADDRESS).await);
    request(&app, input(&app, "owner").await, None)
        .await
        .unwrap();
    let original: (String, String) = sqlx::query_as("SELECT instance_id,data_epoch FROM instance")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE instance SET instance_id='other-instance'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 0);
    assert!(
        recovery::accept(&app, claim.clone(), None)
            .await
            .is_err_and(|e| e.code == "recovery_rejected")
    );
    sqlx::query("UPDATE instance SET instance_id=$1,data_epoch='other-epoch'")
        .bind(&original.0)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 0);
    assert!(
        recovery::accept(&app, claim.clone(), None)
            .await
            .is_err_and(|e| e.code == "recovery_rejected")
    );
    sqlx::query("UPDATE instance SET data_epoch=$1")
        .bind(original.1)
        .execute(&pool)
        .await
        .unwrap();
    let authority: String =
        sqlx::query_scalar("SELECT activation_version FROM users WHERE username='owner'")
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("UPDATE users SET disabled=true WHERE username='owner'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 0);
    assert!(
        recovery::accept(&app, claim.clone(), None)
            .await
            .is_err_and(|e| e.code == "recovery_rejected")
    );
    sqlx::query("UPDATE users SET disabled=false WHERE username='owner'")
        .execute(&pool)
        .await
        .unwrap();
    // Restore the fixture authority separately; changing disabled rotates it.
    sqlx::query("UPDATE users SET activation_version=$1 WHERE username='owner'")
        .bind(authority)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE account_recovery_codes SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '1 hour'").execute(&pool).await.unwrap();
    assert!(
        recovery::accept(&app, claim, None)
            .await
            .is_err_and(|e| e.code == "recovery_rejected")
    );
    assert_eq!(drain(&app).await.unwrap(), 0);
    assert_eq!(relay.codes(ADDRESS).await.len(), 1);
    app.cleanup().await.unwrap();
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM email_recovery_outbox WHERE payload_cipher IS NOT NULL"
        )
        .await,
        0
    );
}
#[sqlx::test]
async fn quotas_are_uniform_persisted_and_suppressed_request_never_revives(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, _) = fixture(&pool, &relay).await;
    let mut suppressed = None;
    for i in 0..5 {
        let candidate = input(&app, "owner").await;
        assert!(
            request(&app, candidate.clone(), None)
                .await
                .unwrap()
                .accepted
        );
        if i == 4 {
            suppressed = Some(candidate);
        }
    }
    assert_eq!(
        count(&pool, "SELECT count(*) FROM account_recovery_codes").await,
        3
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM email_recovery_requests WHERE token_hash IS NULL"
        )
        .await,
        2
    );
    sqlx::query("DELETE FROM email_delivery_windows")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE account_recovery_codes SET revoked_at=clock_timestamp()")
        .execute(&pool)
        .await
        .unwrap();
    let restarted = App::from_pool_with_auth_key(
        pool.clone(),
        Some(AuthKey::from_hex(&"37".repeat(32)).unwrap()),
    )
    .await
    .unwrap()
    .with_mail(Some(relay.sender()));
    assert!(
        request(&restarted, suppressed.unwrap(), None)
            .await
            .unwrap()
            .accepted
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM account_recovery_codes").await,
        3
    );
    assert_eq!(drain(&restarted).await.unwrap(), 0);
    restarted.cleanup().await.unwrap();
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM email_recovery_outbox WHERE payload_cipher IS NOT NULL"
        )
        .await,
        0
    );
}
#[sqlx::test]
async fn delivered_confirmation_works_without_smtp_or_key_and_never_creates_session(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, _) = fixture(&pool, &relay).await;
    request(&app, input(&app, "owner").await, None)
        .await
        .unwrap();
    drain(&app).await.unwrap();
    let unavailable = App::from_pool(pool.clone()).await.unwrap();
    assert!(
        request(&unavailable, input(&app, "owner").await, None)
            .await
            .is_err_and(|e| e.code == "email_unavailable")
    );
    assert_eq!(drain(&unavailable).await.unwrap(), 0);
    recovery::accept(&unavailable, confirmation(relay.code(ADDRESS).await), None)
        .await
        .unwrap();
    assert_eq!(count(&pool, "SELECT count(*) FROM sessions").await, 0);
}

#[sqlx::test]
async fn deleted_account_erases_mail_but_keeps_an_opaque_receipt_for_reused_username(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, session) = fixture(&pool, &relay).await;
    let original = input(&app, "owner").await;
    request(&app, original.clone(), None).await.unwrap();
    sqlx::query("DELETE FROM session_devices WHERE user_id=$1")
        .bind(&session.user.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(session.user.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(count(&pool,"SELECT count(*) FROM email_recovery_requests WHERE user_id IS NULL AND address IS NULL AND token_hash IS NULL").await,1);
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM email_recovery_outbox WHERE payload_cipher IS NOT NULL"
        )
        .await,
        0
    );
    let next = auth::create_user(&app, "owner", PASSWORD.into(), false)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO account_emails(user_id,address,verified_at) VALUES($1,$2,clock_timestamp())",
    )
    .bind(next.id)
    .bind("replacement@example.test")
    .execute(&pool)
    .await
    .unwrap();
    assert!(request(&app, original, None).await.unwrap().accepted);
    assert_eq!(drain(&app).await.unwrap(), 0);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM account_recovery_codes").await,
        0
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM email_delivery_admissions").await,
        1
    );
    assert!(relay.codes("replacement@example.test").await.is_empty());
}

#[sqlx::test]
async fn bounded_public_receipts_throttle_all_names_with_no_existence_oracle(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, _) = fixture(&pool, &relay).await;
    let seed = input(&app, "owner").await;
    sqlx::query("INSERT INTO email_recovery_requests(operation_hash,binding_hash,instance_id,data_epoch,expires_at) SELECT lpad(to_hex(n),64,'0'),$1,$2,$3,clock_timestamp()+interval '1 hour' FROM generate_series(1,1000) n")
        .bind("a".repeat(64)).bind(&seed.instance_id).bind(&seed.data_epoch).execute(&pool).await.unwrap();
    for name in ["owner", "unknown"] {
        assert!(
            request(&app, input(&app, name).await, None)
                .await
                .is_err_and(|e| e.code == "email_recovery_limit"
                    && e.status == axum::http::StatusCode::TOO_MANY_REQUESTS)
        );
    }
    assert_eq!(
        count(&pool, "SELECT count(*) FROM account_recovery_codes").await,
        0
    );
    assert_eq!(drain(&app).await.unwrap(), 0);
    sqlx::query(
        "UPDATE email_recovery_requests SET expires_at=clock_timestamp()-interval '25 hours'",
    )
    .execute(&pool)
    .await
    .unwrap();
    app.cleanup().await.unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) FROM email_recovery_requests").await,
        0
    );
}

#[sqlx::test]
async fn anonymous_request_budget_bounds_suppressed_storage_and_recovers_after_expiry(
    pool: PgPool,
) {
    let relay = Relay::start(false).await;
    let (app, _) = fixture(&pool, &relay).await;
    sqlx::query("DELETE FROM login_windows")
        .execute(&pool)
        .await
        .unwrap();
    let peer = Some("192.0.2.8".parse().unwrap());
    for _ in 0..10 {
        assert!(
            request(&app, input(&app, "unknown").await, peer)
                .await
                .unwrap()
                .accepted
        );
    }
    assert!(
        request(&app, input(&app, "unknown").await, peer)
            .await
            .is_err_and(|e| e.code == "auth_rate_limited")
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM email_recovery_requests").await,
        10
    );
    sqlx::query("UPDATE login_windows SET attempts=120 WHERE key='global'")
        .execute(&pool)
        .await
        .unwrap();
    for name in ["owner", "unknown"] {
        assert!(
            request(&app, input(&app, name).await, peer)
                .await
                .is_err_and(|e| e.code == "auth_rate_limited")
        );
    }
    assert_eq!(
        count(&pool, "SELECT count(*) FROM email_recovery_requests").await,
        10
    );
    sqlx::query("UPDATE login_windows SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    let restarted = App::from_pool_with_auth_key(
        pool.clone(),
        Some(AuthKey::from_hex(&"37".repeat(32)).unwrap()),
    )
    .await
    .unwrap()
    .with_mail(Some(relay.sender()));
    assert!(
        request(&restarted, input(&app, "owner").await, peer)
            .await
            .unwrap()
            .accepted
    );
    assert_eq!(drain(&restarted).await.unwrap(), 1);
}

#[sqlx::test]
async fn wrong_operator_key_releases_lease_without_sending_and_original_key_can_resume(
    pool: PgPool,
) {
    let relay = Relay::start(false).await;
    let (app, _) = fixture(&pool, &relay).await;
    request(&app, input(&app, "owner").await, None)
        .await
        .unwrap();
    let wrong = App::from_pool_with_auth_key(
        pool.clone(),
        Some(AuthKey::from_hex(&"38".repeat(32)).unwrap()),
    )
    .await
    .unwrap()
    .with_mail(Some(relay.sender()));
    assert_eq!(drain(&wrong).await.unwrap(), 0);
    assert!(relay.codes(ADDRESS).await.is_empty());
    assert_eq!(count(&pool,"SELECT count(*) FROM email_recovery_outbox WHERE payload_cipher IS NOT NULL AND lease_id IS NULL AND attempts=1").await,1);
    sqlx::query("UPDATE email_recovery_outbox SET next_attempt_at=clock_timestamp()")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 1);
    assert_eq!(relay.codes(ADDRESS).await.len(), 1);
}
