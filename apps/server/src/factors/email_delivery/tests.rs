use super::*;
use crate::{email, email::tests::Relay, reauthentication};
use rv_protocol::parity::{
    AuthenticationStep, BeginReauthentication, ChangeEmailFactor, EmailFactorChange,
    FinishReauthentication, ReauthenticationStep,
};
use sqlx::PgPool;
use std::time::Duration;

const PASSWORD: &str = "email-otp-test-password";
const ADDRESS: &str = "owner@example.test";

fn totp(secret: &str) -> String {
    use hmac::{Hmac, Mac};
    let secret = data_encoding::BASE32_NOPAD
        .decode(secret.as_bytes())
        .unwrap();
    let mut mac = <Hmac<sha1::Sha1> as Mac>::new_from_slice(&secret).unwrap();
    mac.update(&((Utc::now().timestamp() / 30) as u64).to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 15) as usize;
    let binary = u32::from_be_bytes(digest[offset..offset + 4].try_into().unwrap()) & 0x7fff_ffff;
    format!("{:06}", binary % 1_000_000)
}

async fn fixture(pool: &PgPool, relay: &Relay) -> (App, Session) {
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
    let session = auth::login(&app, "owner".into(), PASSWORD.into())
        .await
        .unwrap();
    // Contact verification has its own end-to-end tests. An explicit factor
    // command, rather than this verified contact, must enable OTP here.
    sqlx::query(
        "INSERT INTO account_emails(user_id,address,verified_at) VALUES($1,$2,clock_timestamp())",
    )
    .bind(user.id)
    .bind(ADDRESS)
    .execute(pool)
    .await
    .unwrap();
    (app, session)
}
async fn account(app: &App, session: &Session) -> Account {
    auth::authenticate(app, &auth::hash_token(&session.token))
        .await
        .unwrap()
}
async fn change_input(app: &App, session: &Session) -> ChangeEmailFactor {
    let current = account(app, session).await;
    let contact = email::status(app, &current).await.unwrap();
    let factors = super::super::status(app, &current).await.unwrap();
    ChangeEmailFactor {
        operation_id: auth::random_token(),
        email_version: contact.version,
        factor_version: factors.factor_version,
        context: contact.context,
    }
}
async fn enroll(app: &App, session: &Session) -> (ChangeEmailFactor, EmailFactorChange) {
    let input = change_input(app, session).await;
    let result = email_settings::change(app, &account(app, session).await, input.clone(), true)
        .await
        .unwrap();
    assert!(result.enabled && result.codes.len() == 10);
    (input, result)
}
async fn login_challenge(app: &App) -> AuthChallenge {
    match auth::start_login(app, "owner".into(), PASSWORD.into(), None)
        .await
        .unwrap()
    {
        AuthenticationStep::Challenge { challenge, .. } => challenge,
        AuthenticationStep::Session { .. } => {
            panic!("protected login minted a password-only session")
        }
    }
}
fn request(challenge: &str) -> RequestFactorEmail {
    RequestFactorEmail {
        challenge_id: challenge.into(),
        delivery_id: auth::random_token(),
        operation_id: auth::random_token(),
    }
}
fn finish(challenge: &str, code: String) -> FinishFactor {
    FinishFactor {
        challenge_id: challenge.into(),
        method: SecondFactor::Email,
        code,
        operation_id: auth::random_token(),
        next_token: auth::random_token(),
    }
}
fn error<T>(result: Result<T>) -> Error {
    match result {
        Err(error) => error,
        Ok(_) => panic!("operation unexpectedly accepted"),
    }
}
async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}
struct HttpTask(tokio::task::JoinHandle<()>);
impl Drop for HttpTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn server(app: &App) -> (String, HttpTask) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = app.clone();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            app.router()
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (base, HttpTask(task))
}

#[sqlx::test]
async fn typed_http_enrollment_and_lost_login_ack_recover_exactly_one_session(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, old) = fixture(&pool, &relay).await;
    let other = auth::login(&app, "owner".into(), PASSWORD.into())
        .await
        .unwrap();
    let (base, _http) = server(&app).await;
    let mut sdk = rv_client::NativeClient::new(&base).unwrap();
    sdk.restore(old.token.clone());
    let discovery = sdk.discover().await.unwrap();
    assert!(discovery.capabilities.email_factors && discovery.capabilities.email_factor_delivery);
    assert!(!sdk.factor_status().await.unwrap().email);
    let input = change_input(&app, &old).await;
    let (a, b) = tokio::join!(
        sdk.enable_email_factor(&input),
        sdk.enable_email_factor(&input)
    );
    // A simultaneous command can authenticate just before the first command
    // advances account authority. Its explicit same-intent retry must recover
    // the original receipt instead of creating another enrollment/code bag.
    let mut receipts = Vec::new();
    for result in [a, b] {
        receipts.push(match result {
            Ok(receipt) => receipt,
            Err(rv_client::Error::Server { code, .. }) if code == "delivery_revalidate" => {
                sdk.enable_email_factor(&input).await.unwrap()
            }
            Err(error) => panic!("unexpected enrollment refusal: {error}"),
        });
    }
    let a = &receipts[0];
    let b = &receipts[1];
    assert!(a.enabled && a.codes.len() == 10 && a.codes == b.codes);
    assert!(a.factor_version == b.factor_version);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM email_factor_changes").await,
        1
    );
    assert!(
        auth::authenticate(&app, &auth::hash_token(&other.token))
            .await
            .is_err()
    );
    let AuthenticationStep::Challenge { challenge, .. } =
        sdk.start_login("owner", PASSWORD).await.unwrap()
    else {
        panic!("factor was bypassed");
    };
    assert!(matches!(
        challenge.methods.as_slice(),
        [SecondFactor::Email, SecondFactor::RecoveryCode]
    ));
    let delivery = request(&challenge.challenge_id);
    let pending = sdk.begin_factor_email(&delivery).await.unwrap();
    assert!(matches!(pending.delivery, EmailDeliveryState::Queued));
    sdk.begin_factor_email(&delivery).await.unwrap();
    sdk.resume_factor_email(&delivery).await.unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) FROM factor_email_outbox").await,
        1
    );
    assert_eq!(crate::email_delivery::drain(&app).await.unwrap(), 1);
    assert!(matches!(
        sdk.resume_factor_email(&delivery).await.unwrap().delivery,
        EmailDeliveryState::Accepted
    ));
    let proof = finish(&challenge.challenge_id, relay.code(ADDRESS).await);
    let (a, b) = tokio::join!(sdk.finish_factor(&proof), sdk.finish_factor(&proof));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert!(a.token == b.token && a.token == proof.next_token);
    assert!(sdk.saved_token().as_deref() == Some(old.token.as_str()));
    assert_eq!(
        count(&pool, "SELECT count(*) FROM session_devices").await,
        2
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM factor_email_outbox").await,
        0
    );
    assert_eq!(count(&pool, "SELECT count(*) FROM factor_email_deliveries WHERE consumed_at IS NOT NULL AND payload_cipher IS NULL").await, 1);
    let bogus = reqwest::Client::new().post(format!("{base}/api/v1/auth/factors/email/start"))
        .json(&serde_json::json!({"challenge_id":delivery.challenge_id,"delivery_id":delivery.delivery_id,"operation_id":delivery.operation_id,"purpose":"reauth","address":"outsider@example.test"}))
        .send().await.unwrap();
    assert_eq!(bogus.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(bogus.headers()["cache-control"], "no-store");
}

#[sqlx::test]
async fn email_proof_stays_on_its_family_and_does_not_extend_a_lost_receipt(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, old) = fixture(&pool, &relay).await;
    let (enrollment, enrolled) = enroll(&app, &old).await;
    let current = account(&app, &old).await;
    let status = reauthentication::status(&app, &current).await.unwrap();
    let intent = BeginReauthentication {
        password: PASSWORD.into(),
        challenge_id: auth::random_token(),
        operation_id: auth::random_token(),
        proof_version: status.proof_version,
        context: Some(enrollment.context.clone()),
    };
    assert!(matches!(
        reauthentication::begin(&app, &current, intent.clone(), None)
            .await
            .unwrap(),
        ReauthenticationStep::Challenge { .. }
    ));
    let delivery = request(&intent.challenge_id);
    assert!(
        begin(&app, delivery.clone(), None, Kind::Login, None)
            .await
            .is_err()
    );
    begin(
        &app,
        delivery.clone(),
        Some(&current),
        Kind::Reauthentication,
        None,
    )
    .await
    .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 1);
    let code = relay.code(ADDRESS).await;
    assert!(
        code_hash("login", &intent.challenge_id, &code)
            != code_hash("reauth", &intent.challenge_id, &code)
    );
    let proof = FinishReauthentication {
        challenge_id: intent.challenge_id,
        operation_id: intent.operation_id,
        method: SecondFactor::Email,
        code,
    };
    let (a, b) = tokio::join!(
        reauthentication::finish(&app, &current, proof.clone(), None),
        reauthentication::finish(&app, &current, proof.clone(), None)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.authenticated_at, b.authenticated_at);
    assert_eq!(a.expires_at, b.expires_at);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM session_devices").await,
        1
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM factor_backup_codes").await,
        10
    );
    sqlx::query(
        "UPDATE reauthentication_grants SET expires_at=clock_timestamp()-interval '1 second'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let receipt = email_settings::change(&app, &account(&app, &old).await, enrollment, true)
        .await
        .unwrap();
    assert!(receipt.codes == enrolled.codes);
    assert!(
        !reauthentication::status(&app, &account(&app, &old).await)
            .await
            .unwrap()
            .recent
    );
}

#[sqlx::test]
async fn smtp_absence_keeps_backup_authentication_and_explicit_retirement_available(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, old) = fixture(&pool, &relay).await;
    let (_, enrolled) = enroll(&app, &old).await;
    let challenge = login_challenge(&app).await;
    let original = request(&challenge.challenge_id);
    begin(&app, original.clone(), None, Kind::Login, None)
        .await
        .unwrap();
    let unavailable = app.clone().with_mail(None);
    assert!(matches!(
        login_challenge(&unavailable).await.methods.as_slice(),
        [SecondFactor::RecoveryCode]
    ));
    resume(&unavailable, original.clone(), None, Kind::Login)
        .await
        .unwrap();
    begin(&unavailable, original, None, Kind::Login, None)
        .await
        .unwrap();
    assert_eq!(
        error(
            begin(
                &unavailable,
                request(&challenge.challenge_id),
                None,
                Kind::Login,
                None
            )
            .await
        )
        .status,
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    let mut proof = finish(&challenge.challenge_id, enrolled.codes[0].clone());
    proof.method = SecondFactor::RecoveryCode;
    let full = super::super::finish(&unavailable, proof, None)
        .await
        .unwrap();
    let retirement = change_input(&unavailable, &full).await;
    let retired = email_settings::change(
        &unavailable,
        &account(&unavailable, &full).await,
        retirement.clone(),
        false,
    )
    .await
    .unwrap();
    assert!(!retired.enabled && retired.codes.is_empty());
    assert_eq!(
        count(&pool, "SELECT count(*) FROM factor_backup_codes").await,
        0
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM factor_email_outbox").await,
        0
    );
    assert!(
        email_settings::change(
            &unavailable,
            &account(&unavailable, &full).await,
            retirement.clone(),
            false
        )
        .await
        .unwrap()
        .factor_version
            == retired.factor_version
    );
    // Recover a new password proof with no factors before enrolling again.
    let status = reauthentication::status(&app, &account(&app, &full).await)
        .await
        .unwrap();
    let fresh = BeginReauthentication {
        password: PASSWORD.into(),
        challenge_id: auth::random_token(),
        operation_id: auth::random_token(),
        proof_version: status.proof_version,
        context: Some(retirement.context.clone()),
    };
    reauthentication::begin(&app, &account(&app, &full).await, fresh, None)
        .await
        .unwrap();
    enroll(&app, &full).await;
    assert_eq!(
        error(email_settings::change(&app, &account(&app, &full).await, retirement, false).await)
            .status,
        axum::http::StatusCode::CONFLICT
    );
    assert!(
        super::super::status(&app, &account(&app, &full).await)
            .await
            .unwrap()
            .email
    );
}

#[sqlx::test]
async fn smtp_ack_loss_and_explicit_resends_keep_original_code_and_deadline(pool: PgPool) {
    let relay = Relay::start(true).await;
    let (app, old) = fixture(&pool, &relay).await;
    enroll(&app, &old).await;
    let challenge = login_challenge(&app).await;
    let original = request(&challenge.challenge_id);
    let pending = begin(&app, original.clone(), None, Kind::Login, None)
        .await
        .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 0);
    assert!(matches!(
        resume(&app, original.clone(), None, Kind::Login)
            .await
            .unwrap()
            .delivery,
        EmailDeliveryState::Deferred
    ));
    sqlx::query(
        "UPDATE factor_email_outbox SET next_attempt_at=clock_timestamp()-interval '1 second'",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 1);
    let codes = relay.codes(ADDRESS).await;
    assert!(codes.len() == 2 && codes[0] == codes[1]);
    assert_eq!(
        error(
            begin(
                &app,
                request(&challenge.challenge_id),
                None,
                Kind::Login,
                None
            )
            .await
        )
        .code,
        "email_resend_cooldown"
    );
    for _ in 0..2 {
        sqlx::query(
            "UPDATE factor_email_deliveries SET created_at=clock_timestamp()-interval '61 seconds'",
        )
        .execute(&pool)
        .await
        .unwrap();
        let resent = begin(
            &app,
            request(&challenge.challenge_id),
            None,
            Kind::Login,
            None,
        )
        .await
        .unwrap();
        assert_eq!(pending.expires_at, resent.expires_at);
        assert_eq!(drain(&app).await.unwrap(), 1);
    }
    let codes = relay.codes(ADDRESS).await;
    assert!(codes.len() == 4 && codes.iter().all(|code| code == &codes[0]));
    assert_eq!(
        count(
            &pool,
            "SELECT count(DISTINCT code_hash) FROM factor_email_deliveries"
        )
        .await,
        1
    );
    assert_eq!(
        error(
            begin(
                &app,
                request(&challenge.challenge_id),
                None,
                Kind::Login,
                None
            )
            .await
        )
        .code,
        "email_challenge_delivery_limit"
    );
    begin(&app, original.clone(), None, Kind::Login, None)
        .await
        .unwrap();
    resume(&app, original, None, Kind::Login).await.unwrap();
    assert_eq!(
        count(&pool, "SELECT count(*) FROM email_delivery_admissions").await,
        3
    );
}

async fn wait_for_lock(pool: &PgPool, pattern: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND pid<>pg_backend_pid())")
                .bind(pattern).fetch_one(pool).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("actor reached the intended SQL lock");
}
#[sqlx::test]
async fn queue_wait_cannot_extend_an_expired_challenge_or_leave_a_delivery(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, old) = fixture(&pool, &relay).await;
    enroll(&app, &old).await;
    let challenge = login_challenge(&app).await;
    sqlx::query("UPDATE auth_challenges SET expires_at=clock_timestamp()+interval '2 seconds'")
        .execute(&pool)
        .await
        .unwrap();
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('rv-email-outbox-budget',0))")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let actor_app = app.clone();
    let actor = tokio::spawn(async move {
        begin(
            &actor_app,
            request(&challenge.challenge_id),
            None,
            Kind::Login,
            None,
        )
        .await
    });
    wait_for_lock(&pool, "SELECT pg_advisory_xact_lock%").await;
    tokio::time::sleep(Duration::from_millis(2200)).await;
    blocker.commit().await.unwrap();
    assert!(actor.await.unwrap().is_err());
    assert_eq!(
        count(&pool, "SELECT count(*) FROM factor_email_deliveries").await,
        0
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM factor_email_outbox").await,
        0
    );
    assert!(relay.codes(ADDRESS).await.is_empty());
}

#[sqlx::test]
async fn proof_expiring_while_waiting_for_outbox_neither_consumes_code_nor_mints_session(
    pool: PgPool,
) {
    let relay = Relay::start(false).await;
    let (app, old) = fixture(&pool, &relay).await;
    enroll(&app, &old).await;
    let challenge = login_challenge(&app).await;
    begin(
        &app,
        request(&challenge.challenge_id),
        None,
        Kind::Login,
        None,
    )
    .await
    .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 1);
    // The delivered code is already known to the recipient. Advance its whole
    // authoritative deadline together; no worker decrypts this test-only edit.
    sqlx::query("WITH deadline AS (UPDATE auth_challenges SET expires_at=clock_timestamp()+interval '2 seconds' RETURNING expires_at), delivery AS (UPDATE factor_email_deliveries SET expires_at=(SELECT expires_at FROM deadline)) UPDATE factor_email_outbox SET expires_at=(SELECT expires_at FROM deadline)")
        .execute(&pool).await.unwrap();
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM current_factor_email_deliveries"
        )
        .await,
        1
    );
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM factor_email_outbox FOR UPDATE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let actor_app = app.clone();
    let proof = finish(&challenge.challenge_id, relay.code(ADDRESS).await);
    let actor = tokio::spawn(async move { super::super::finish(&actor_app, proof, None).await });
    wait_for_lock(&pool, "SELECT o.id FROM factor_email_outbox%").await;
    tokio::time::sleep(Duration::from_millis(2200)).await;
    blocker.commit().await.unwrap();
    assert!(actor.await.unwrap().is_err());
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM factor_email_deliveries WHERE consumed_at IS NOT NULL"
        )
        .await,
        0
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM session_devices").await,
        1
    );
}

#[sqlx::test]
async fn tampered_payload_wrong_key_and_old_epoch_are_never_sent_or_accepted(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, old) = fixture(&pool, &relay).await;
    enroll(&app, &old).await;
    let challenge = login_challenge(&app).await;
    let original = request(&challenge.challenge_id);
    begin(&app, original.clone(), None, Kind::Login, None)
        .await
        .unwrap();
    let wrong = App::from_pool_with_auth_key(
        pool.clone(),
        Some(AuthKey::from_hex(&"29".repeat(32)).unwrap()),
    )
    .await
    .unwrap()
    .with_mail(Some(relay.sender()));
    assert_eq!(drain(&wrong).await.unwrap(), 0);
    sqlx::query("UPDATE factor_email_outbox SET payload_cipher=set_byte(payload_cipher,0,get_byte(payload_cipher,0)#1),next_attempt_at=clock_timestamp()-interval '1 second'").execute(&pool).await.unwrap();
    assert_eq!(drain(&app).await.unwrap(), 0);
    assert!(relay.codes(ADDRESS).await.is_empty());
    sqlx::query("UPDATE instance SET data_epoch=$1 WHERE singleton")
        .bind(auth::random_token())
        .execute(&pool)
        .await
        .unwrap();
    assert!(resume(&app, original, None, Kind::Login).await.is_err());
    assert!(
        super::super::finish(
            &app,
            finish(&challenge.challenge_id, "00000000".into()),
            None
        )
        .await
        .is_err()
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM factor_email_deliveries WHERE consumed_at IS NOT NULL"
        )
        .await,
        0
    );
}

#[sqlx::test]
async fn explicit_email_enrollment_replaces_common_backups_and_retirement_keeps_totp(pool: PgPool) {
    let relay = Relay::start(false).await;
    let (app, old) = fixture(&pool, &relay).await;
    let current = account(&app, &old).await;
    let setup = super::super::begin(
        &app,
        &current,
        BeginFactorSetup {
            operation_id: auth::random_token(),
        },
    )
    .await
    .unwrap();
    let backups = super::super::enable(
        &app,
        &current,
        EnableFactor {
            setup_id: setup.setup_id,
            operation_id: auth::random_token(),
            code: totp(&setup.secret),
        },
    )
    .await
    .unwrap();
    let challenge = login_challenge(&app).await;
    let mut proof = finish(&challenge.challenge_id, backups.codes[0].clone());
    proof.method = SecondFactor::RecoveryCode;
    let full = super::super::finish(&app, proof, None).await.unwrap();
    let original_cipher: Vec<u8> = sqlx::query_scalar("SELECT totp_cipher FROM user_factors")
        .fetch_one(&pool)
        .await
        .unwrap();
    let (_, enrolled) = enroll(&app, &full).await;
    assert!(
        enrolled
            .codes
            .iter()
            .all(|code| !backups.codes.contains(code))
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM factor_backup_codes").await,
        10
    );
    let challenge = login_challenge(&app).await;
    assert!(matches!(
        challenge.methods.as_slice(),
        [
            SecondFactor::Totp,
            SecondFactor::Email,
            SecondFactor::RecoveryCode
        ]
    ));
    begin(
        &app,
        request(&challenge.challenge_id),
        None,
        Kind::Login,
        None,
    )
    .await
    .unwrap();
    assert_eq!(drain(&app).await.unwrap(), 1);
    // Once a valid code is delivered, a transport outage cannot prevent its
    // verification or force a password-only login.
    let without_smtp = app.clone().with_mail(None);
    let full = super::super::finish(
        &without_smtp,
        finish(&challenge.challenge_id, relay.code(ADDRESS).await),
        None,
    )
    .await
    .unwrap();
    let input = change_input(&without_smtp, &full).await;
    email_settings::change(
        &without_smtp,
        &account(&without_smtp, &full).await,
        input,
        false,
    )
    .await
    .unwrap();
    let status = super::super::status(&app, &account(&app, &full).await)
        .await
        .unwrap();
    assert!(status.totp && !status.email && status.backup_codes_remaining == 10);
    let retained_cipher: Vec<u8> = sqlx::query_scalar("SELECT totp_cipher FROM user_factors")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(original_cipher == retained_cipher);
}

#[sqlx::test]
async fn enrollment_receipt_expiry_and_missing_full_proof_cannot_rotate_a_live_profile(
    pool: PgPool,
) {
    let relay = Relay::start(false).await;
    let (app, old) = fixture(&pool, &relay).await;
    let (input, receipt) = enroll(&app, &old).await;
    let retirement = change_input(&app, &old).await;
    assert_eq!(
        error(email_settings::change(&app, &account(&app, &old).await, retirement, false).await)
            .code,
        "reauthentication_required"
    );
    sqlx::query("UPDATE email_factor_changes SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        error(email_settings::change(&app, &account(&app, &old).await, input, true).await).status,
        axum::http::StatusCode::CONFLICT
    );
    let status = super::super::status(&app, &account(&app, &old).await)
        .await
        .unwrap();
    assert!(
        status.email && status.factor_version.as_deref() == Some(receipt.factor_version.as_str())
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM factor_backup_codes").await,
        10
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM email_factor_changes").await,
        1
    );
}
