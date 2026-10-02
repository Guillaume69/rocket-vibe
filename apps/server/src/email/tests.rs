use super::*;
use crate::{email_delivery, factor_crypto::AuthKey, mail::Sender};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::Mutex,
};
pub(super) const PASSWORD: &str = "email-fixture-password-2026";
const KEY: &str = "3737373737373737373737373737373737373737373737373737373737373737";

#[sqlx::test]
async fn actual_typescript_provider_and_private_vault_resume_lost_mail_replies(pool: sqlx::PgPool) {
    let relay = Arc::new(Relay::start(false).await);
    let app = App::from_pool_with_auth_key(pool.clone(), Some(AuthKey::from_hex(KEY).unwrap()))
        .await
        .unwrap()
        .with_mail(Some(Sender::loopback_fixture(relay.port)));
    let user = auth::create_user(&app, "owner", PASSWORD.into(), false)
        .await
        .unwrap();
    let original: String = sqlx::query_scalar("SELECT activation_version FROM users WHERE id=$1")
        .bind(&user.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let delivery_app = app.clone();
    let owner = user.id.clone();
    let router = app.router().route(
        "/__email_fixture/deliver",
        axum::routing::get(move |headers: axum::http::HeaderMap| {
            let app = delivery_app.clone();
            let relay = relay.clone();
            let owner = owner.clone();
            async move {
                let account = auth::authenticate(&app, &auth::bearer(&headers)?).await?;
                if account.id != owner {
                    return Err(crate::error::Error::unauthorized());
                }
                let delivered = email_delivery::drain(&app).await?;
                let code = relay.code("owner@example.test").await;
                Ok::<_, crate::error::Error>(axum::Json(
                    serde_json::json!({"delivered":delivered,"code":code}),
                ))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let no_mail = App::from_pool(pool.clone()).await.unwrap();
    let no_mail_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let no_mail_base = format!("http://{}", no_mail_listener.local_addr().unwrap());
    let no_mail_server = tokio::spawn(async move {
        axum::serve(no_mail_listener, no_mail.router())
            .await
            .unwrap();
    });
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        tokio::process::Command::new("node")
            .arg(root.join("scripts/native-email-mobile-pilot.ts"))
            .arg(base)
            .arg(no_mail_base)
            .env("RV_EMAIL_PILOT_PASSWORD", PASSWORD)
            .current_dir(root)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("native TypeScript pilot timed out")
    .expect("Node 24 is required by the contract suite");
    server.abort();
    no_mail_server.abort();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("native email mobile pilot: verified")
    );
    let result:(i64,i64,i64,i64,bool,i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM session_devices),(SELECT count(*) FROM sessions),(SELECT count(*) FROM email_verifications),(SELECT count(*) FROM email_delivery_admissions),(SELECT activation_version=$1 FROM users WHERE id=$2),(SELECT count(*) FROM email_outbox),(SELECT count(*) FROM account_emails),(SELECT count(*) FROM email_removals)")
        .bind(original).bind(user.id).fetch_one(&pool).await.unwrap();
    assert_eq!(result, (1, 1, 0, 1, true, 0, 0, 1));
}

pub(crate) struct Relay {
    port: u16,
    messages: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}
struct HttpTask(tokio::task::JoinHandle<()>);
impl Drop for HttpTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}
#[sqlx::test]
async fn typed_native_client_and_private_http_routes_complete_verification(pool: sqlx::PgPool) {
    let relay = Relay::start(false).await;
    let app = App::from_pool_with_auth_key(pool.clone(), Some(AuthKey::from_hex(KEY).unwrap()))
        .await
        .unwrap()
        .with_mail(Some(Sender::loopback_fixture(relay.port)));
    auth::create_user(&app, "owner", PASSWORD.into(), false)
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let served = app.clone();
    let _http = HttpTask(tokio::spawn(async move {
        axum::serve(
            listener,
            served
                .router()
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    }));
    let mut client = rv_client::NativeClient::new(&base).unwrap();
    let session = client.login("owner", PASSWORD).await.unwrap();
    assert!(
        client
            .discover()
            .await
            .unwrap()
            .capabilities
            .email_verification
    );
    let initial = client.email_status().await.unwrap();
    assert!(initial.address.is_none());
    let input = BeginEmailVerification {
        address: "owner@example.test".into(),
        verification_id: auth::random_token(),
        operation_id: auth::random_token(),
        expected_version: initial.version,
        verification_version: initial.verification_version,
        context: initial.context,
    };
    assert!(matches!(
        client.begin_email_verification(&input).await.unwrap(),
        EmailVerificationStep::Pending {
            delivery: rv_protocol::parity::EmailDeliveryState::Queued,
            ..
        }
    ));
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 1);
    assert!(matches!(
        client
            .resume_email_verification(&resumption(&input))
            .await
            .unwrap(),
        EmailVerificationStep::Pending {
            delivery: rv_protocol::parity::EmailDeliveryState::Accepted,
            ..
        }
    ));
    let code = relay.code("owner@example.test").await;
    client
        .confirm_email_verification(&confirmation(&input, code))
        .await
        .unwrap();
    let response = reqwest::Client::new()
        .get(format!("{base}/api/v1/me/email"))
        .bearer_auth(&session.token)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    assert!(
        response.headers()["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store")
    );
    let users = reqwest::Client::new()
        .get(format!("{base}/api/v1/users"))
        .bearer_auth(&session.token)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!users.contains("owner@example.test"));
    let outsider = auth::create_user(&app, "outsider", PASSWORD.into(), false)
        .await
        .unwrap();
    assert!(outsider.id != session.user.id);
    let mut other = rv_client::NativeClient::new(&base).unwrap();
    other.login("outsider", PASSWORD).await.unwrap();
    assert!(
        other
            .resume_email_verification(&resumption(&input))
            .await
            .is_err()
    );
    let bogus = reqwest::Client::new()
        .post(format!("{base}/api/v1/me/email/verification/start"))
        .bearer_auth(&session.token)
        .json(&serde_json::json!({"address":"owner@example.test","token":"hidden-extra-field"}))
        .send()
        .await
        .unwrap();
    assert_eq!(bogus.status(), reqwest::StatusCode::BAD_REQUEST);
}
impl Drop for Relay {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Relay {
    pub(crate) async fn start(lose_first: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let messages = Arc::new(Mutex::new(Vec::new()));
        let captured = messages.clone();
        let deliveries = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let captured = captured.clone();
                let deliveries = deliveries.clone();
                tokio::spawn(async move {
                    let mut io = BufReader::new(socket);
                    io.get_mut()
                        .write_all(b"220 localhost SMTP\r\n")
                        .await
                        .unwrap();
                    loop {
                        let mut line = String::new();
                        if io.read_line(&mut line).await.unwrap() == 0 {
                            break;
                        }
                        let reply = if line.starts_with("EHLO ")
                            || line.starts_with("MAIL FROM:")
                            || line.starts_with("RCPT TO:")
                        {
                            b"250 localhost\r\n".as_slice()
                        } else if line == "DATA\r\n" {
                            io.get_mut().write_all(b"354 message\r\n").await.unwrap();
                            let mut message = String::new();
                            loop {
                                let mut part = String::new();
                                let read = io.read_line(&mut part).await.unwrap();
                                assert!(read > 0, "Incomplete fixture message");
                                if part == ".\r\n" {
                                    break;
                                }
                                message.push_str(&part);
                            }
                            captured.lock().await.push(message);
                            if lose_first && deliveries.fetch_add(1, Ordering::SeqCst) == 0 {
                                break;
                            }
                            b"250 queued\r\n".as_slice()
                        } else if line == "QUIT\r\n" {
                            io.get_mut().write_all(b"221 bye\r\n").await.unwrap();
                            break;
                        } else {
                            panic!("Unexpected fixture SMTP command");
                        };
                        io.get_mut().write_all(reply).await.unwrap();
                    }
                });
            }
        });
        Self {
            port,
            messages,
            task,
        }
    }
    pub(crate) fn sender(&self) -> Sender {
        Sender::loopback_fixture(self.port)
    }
    pub(crate) async fn codes(&self, address: &str) -> Vec<String> {
        self.messages
            .lock()
            .await
            .iter()
            .filter(|v| v.contains(&format!("To: {address}")))
            .filter_map(|v| v.lines().find_map(|line| line.strip_prefix("Code: ")))
            .map(str::to_owned)
            .collect()
    }
    pub(crate) async fn code(&self, address: &str) -> String {
        let messages = self.messages.lock().await;
        let message = messages
            .iter()
            .find(|v| v.contains(&format!("To: {address}")))
            .expect("Fixture mail was captured");
        message
            .lines()
            .find_map(|line| line.strip_prefix("Code: "))
            .expect("Fixed code template")
            .to_owned()
    }
}
pub(super) async fn fixture(pool: &sqlx::PgPool, relay: &Relay) -> (App, Account) {
    let app = App::from_pool_with_auth_key(pool.clone(), Some(AuthKey::from_hex(KEY).unwrap()))
        .await
        .unwrap()
        .with_mail(Some(Sender::loopback_fixture(relay.port)));
    auth::create_user(&app, "owner", PASSWORD.into(), false)
        .await
        .unwrap();
    let session = auth::login(&app, "owner".into(), PASSWORD.into())
        .await
        .unwrap();
    let account = auth::authenticate(&app, &auth::hash_token(&session.token))
        .await
        .unwrap();
    (app, account)
}
pub(super) async fn start_input(
    app: &App,
    account: &Account,
    address: &str,
) -> BeginEmailVerification {
    let status = status(app, account).await.unwrap();
    BeginEmailVerification {
        address: address.into(),
        verification_id: auth::random_token(),
        operation_id: auth::random_token(),
        expected_version: status.version,
        verification_version: status.verification_version,
        context: status.context,
    }
}
pub(super) fn confirmation(
    input: &BeginEmailVerification,
    code: String,
) -> ConfirmEmailVerification {
    ConfirmEmailVerification {
        verification_id: input.verification_id.clone(),
        operation_id: input.operation_id.clone(),
        context: input.context.clone(),
        code,
    }
}
fn retirement(input: &BeginEmailVerification) -> RetireEmailVerification {
    RetireEmailVerification {
        expected_version: input.expected_version.clone(),
        verification_version: input.verification_version.clone(),
        context: input.context.clone(),
    }
}
fn resumption(input: &BeginEmailVerification) -> ResumeEmailVerification {
    ResumeEmailVerification {
        verification_id: input.verification_id.clone(),
        operation_id: input.operation_id.clone(),
        context: input.context.clone(),
    }
}
#[sqlx::test]
async fn verified_contact_replays_without_new_family_or_login_authority(pool: sqlx::PgPool) {
    let relay = Relay::start(false).await;
    let (app, account) = fixture(&pool, &relay).await;
    let input = start_input(&app, &account, "Owner@EXAMPLE.TEST").await;
    let before:(String,DateTime<Utc>)=sqlx::query_as("SELECT u.activation_version,d.created_at FROM users u JOIN session_devices d ON d.user_id=u.id WHERE u.id=$1").bind(&account.id).fetch_one(&pool).await.unwrap();
    assert!(matches!(
        begin(&app, &account, input.clone(), None).await.unwrap(),
        EmailVerificationStep::Pending { .. }
    ));
    assert!(matches!(
        begin(&app, &account, input.clone(), None).await.unwrap(),
        EmailVerificationStep::Pending { .. }
    ));
    assert!(status(&app, &account).await.unwrap().address.is_none());
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 1);
    let code = relay.code("Owner@example.test").await;
    assert!(
        confirm(&app, &account, confirmation(&input, "invalid".into()))
            .await
            .is_err_and(|e| e.code == "email_verification_rejected")
    );
    assert!(matches!(
        confirm(&app, &account, confirmation(&input, code))
            .await
            .unwrap(),
        EmailVerificationStep::Verified { .. }
    ));
    let verified = status(&app, &account).await.unwrap();
    assert!(verified.address.as_deref() == Some("Owner@example.test"));
    assert!(verified.version != input.expected_version);
    assert!(matches!(
        confirm(&app, &account, confirmation(&input, "".into()))
            .await
            .unwrap(),
        EmailVerificationStep::Verified { .. }
    ));
    assert!(matches!(
        resume(&app, &account, resumption(&input)).await.unwrap(),
        EmailVerificationStep::Verified { .. }
    ));
    assert!(matches!(
        begin(&app, &account, input.clone(), None).await.unwrap(),
        EmailVerificationStep::Verified { .. }
    ));
    let stable = status(&app, &account).await.unwrap();
    assert!(stable.verified_at == verified.verified_at && stable.version == verified.version);
    let after:(String,DateTime<Utc>)=sqlx::query_as("SELECT u.activation_version,d.created_at FROM users u JOIN session_devices d ON d.user_id=u.id WHERE u.id=$1").bind(&account.id).fetch_one(&pool).await.unwrap();
    assert!(before == after);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM session_devices")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM email_outbox WHERE payload_cipher IS NULL AND sent_at IS NOT NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i32>(
            "SELECT attempts FROM email_delivery_windows WHERE key='global'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert!(
        retire(&app, &account, retirement(&input))
            .await
            .unwrap()
            .version
            == verified.version
    );
}
#[sqlx::test]
async fn ambiguous_smtp_retries_original_cipher_and_code_after_restart(pool: sqlx::PgPool) {
    let relay = Relay::start(true).await;
    let (app, account) = fixture(&pool, &relay).await;
    let input = start_input(&app, &account, "owner@example.test").await;
    begin(&app, &account, input.clone(), None).await.unwrap();
    let cipher: Vec<u8> = sqlx::query_scalar("SELECT payload_cipher FROM email_outbox")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 0);
    let retained: Vec<u8> = sqlx::query_scalar("SELECT payload_cipher FROM email_outbox")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(cipher == retained);
    sqlx::query("UPDATE email_outbox SET next_attempt_at=clock_timestamp()")
        .execute(&pool)
        .await
        .unwrap();
    let restarted =
        App::from_pool_with_auth_key(pool.clone(), Some(AuthKey::from_hex(KEY).unwrap()))
            .await
            .unwrap()
            .with_mail(Some(Sender::loopback_fixture(relay.port)));
    assert_eq!(email_delivery::drain(&restarted).await.unwrap(), 1);
    let messages = relay.messages.lock().await;
    assert_eq!(messages.len(), 2);
    let codes: Vec<_> = messages
        .iter()
        .map(|v| {
            v.lines()
                .find_map(|line| line.strip_prefix("Code: "))
                .unwrap()
        })
        .collect();
    assert!(codes[0] == codes[1]);
    drop(messages);
    let code = relay.code("owner@example.test").await;
    confirm(&restarted, &account, confirmation(&input, code))
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM email_verifications")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}
#[sqlx::test]
async fn retiring_before_late_start_or_finish_fences_old_candidate(pool: sqlx::PgPool) {
    let relay = Relay::start(false).await;
    let (app, account) = fixture(&pool, &relay).await;
    let old = start_input(&app, &account, "old@example.test").await;
    let fresh = retire(&app, &account, retirement(&old)).await.unwrap();
    assert!(fresh.verification_version != old.verification_version);
    assert!(
        begin(&app, &account, old.clone(), None)
            .await
            .is_err_and(|e| e.code == "operation_conflict")
    );
    let pending = start_input(&app, &account, "old@example.test").await;
    begin(&app, &account, pending.clone(), None).await.unwrap();
    email_delivery::drain(&app).await.unwrap();
    let old_code = relay.code("old@example.test").await;
    retire(&app, &account, retirement(&pending)).await.unwrap();
    let next = start_input(&app, &account, "new@example.test").await;
    begin(&app, &account, next.clone(), None).await.unwrap();
    let head = status(&app, &account).await.unwrap().verification_version;
    assert!(
        retire(&app, &account, retirement(&pending))
            .await
            .unwrap()
            .verification_version
            == head
    );
    assert!(
        confirm(&app, &account, confirmation(&pending, old_code))
            .await
            .is_err_and(|e| e.code == "email_verification_rejected")
    );
    assert!(status(&app, &account).await.unwrap().address.is_none());
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 1);
    let code = relay.code("new@example.test").await;
    confirm(&app, &account, confirmation(&next, code))
        .await
        .unwrap();
    assert!(status(&app, &account).await.unwrap().address.as_deref() == Some("new@example.test"));
}
#[sqlx::test]
async fn competing_devices_and_policy_changes_do_not_relabel_a_candidate(pool: sqlx::PgPool) {
    let relay = Relay::start(false).await;
    let (app, first) = fixture(&pool, &relay).await;
    let other = auth::login(&app, "owner".into(), PASSWORD.into())
        .await
        .unwrap();
    let second = auth::authenticate(&app, &auth::hash_token(&other.token))
        .await
        .unwrap();
    let a = start_input(&app, &first, "first@example.test").await;
    let b = start_input(&app, &second, "second@example.test").await;
    begin(&app, &first, a.clone(), None).await.unwrap();
    begin(&app, &second, b.clone(), None).await.unwrap();
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 2);
    confirm(
        &app,
        &first,
        confirmation(&a, relay.code("first@example.test").await),
    )
    .await
    .unwrap();
    assert!(
        confirm(
            &app,
            &second,
            confirmation(&b, relay.code("second@example.test").await)
        )
        .await
        .is_err_and(|e| e.code == "email_verification_rejected")
    );
    let updated = retire(&app, &second, retirement(&b)).await.unwrap();
    assert!(updated.address.as_deref() == Some("first@example.test"));
    let pending = start_input(&app, &second, "third@example.test").await;
    begin(&app, &second, pending.clone(), None).await.unwrap();
    sqlx::query("UPDATE instance SET data_epoch='different-epoch'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 0);
    assert!(
        resume(&app, &second, resumption(&pending))
            .await
            .is_err_and(|e| e.code == "operation_conflict")
    );
}
#[sqlx::test]
async fn attempt_and_delivery_limits_survive_a_new_runtime(pool: sqlx::PgPool) {
    let relay = Relay::start(false).await;
    let (app, account) = fixture(&pool, &relay).await;
    let first = start_input(&app, &account, "owner@example.test").await;
    begin(&app, &account, first.clone(), None).await.unwrap();
    for _ in 0..5 {
        assert!(
            confirm(&app, &account, confirmation(&first, "wrong".into()))
                .await
                .is_err()
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT attempts FROM email_verifications")
            .fetch_one(&pool)
            .await
            .unwrap(),
        5
    );
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 0);
    retire(&app, &account, retirement(&first)).await.unwrap();
    for _ in 0..2 {
        let input = start_input(&app, &account, "owner@example.test").await;
        begin(&app, &account, input.clone(), None).await.unwrap();
        retire(&app, &account, retirement(&input)).await.unwrap();
    }
    let restarted =
        App::from_pool_with_auth_key(pool.clone(), Some(AuthKey::from_hex(KEY).unwrap()))
            .await
            .unwrap()
            .with_mail(Some(Sender::loopback_fixture(relay.port)));
    let blocked = start_input(&restarted, &account, "owner@example.test").await;
    assert!(
        begin(&restarted, &account, blocked, None)
            .await
            .is_err_and(|e| e.code == "email_delivery_limit")
    );
    assert!(
        status(&restarted, &account)
            .await
            .unwrap()
            .address
            .is_none()
    );
}
#[sqlx::test]
async fn expired_proof_or_session_wait_and_wrong_context_cannot_enqueue(pool: sqlx::PgPool) {
    let relay = Relay::start(false).await;
    let (app, account) = fixture(&pool, &relay).await;
    let mut input = start_input(&app, &account, "owner@example.test").await;
    input.context.user_id = "another-user".into();
    assert!(
        begin(&app, &account, input, None)
            .await
            .is_err_and(|e| e.code == "operation_conflict")
    );
    let input = start_input(&app, &account, "owner@example.test").await;
    sqlx::query("UPDATE session_devices SET created_at=clock_timestamp()-interval '20 minutes'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        begin(&app, &account, input.clone(), None)
            .await
            .is_err_and(|e| e.code == "reauthentication_required")
    );
    sqlx::query("UPDATE session_devices SET created_at=clock_timestamp()")
        .execute(&pool)
        .await
        .unwrap();
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&account.id)
        .execute(&mut *blocker)
        .await
        .unwrap();
    sqlx::query("UPDATE sessions SET expires_at=clock_timestamp()+interval '200 milliseconds'")
        .execute(&pool)
        .await
        .unwrap();
    let cloned = app.clone();
    let late = tokio::spawn(async move { begin(&cloned, &account, input, None).await });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    blocker.commit().await.unwrap();
    assert!(
        late.await
            .unwrap()
            .is_err_and(|e| e.code == "session_rejected")
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM email_outbox")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[sqlx::test]
async fn expiry_during_queue_budget_wait_is_rechecked_before_enqueue(pool: sqlx::PgPool) {
    let relay = Relay::start(false).await;
    let (app, account) = fixture(&pool, &relay).await;
    for expire_proof in [true, false] {
        sqlx::query("UPDATE session_devices SET created_at=clock_timestamp()")
            .execute(&pool)
            .await
            .unwrap();
        let input = start_input(&app, &account, "owner@example.test").await;
        let mut blocker = pool.begin().await.unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('rv-email-outbox-budget',0))")
            .execute(&mut *blocker)
            .await
            .unwrap();
        let expiry = if expire_proof {
            "UPDATE session_devices SET created_at=clock_timestamp()-interval '15 minutes'+interval '2 seconds'"
        } else {
            "UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds'"
        };
        sqlx::query(expiry).execute(&pool).await.unwrap();
        let cloned = app.clone();
        let active = account.clone();
        let late = tokio::spawn(async move { begin(&cloned, &active, input, None).await });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()))")
                    .fetch_one(&pool).await.unwrap();
                if waiting { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("producer must reach the held queue budget");
        tokio::time::sleep(std::time::Duration::from_millis(2100)).await;
        blocker.commit().await.unwrap();
        let code = if expire_proof {
            "reauthentication_required"
        } else {
            "session_rejected"
        };
        assert!(late.await.unwrap().is_err_and(|error| error.code == code));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM email_outbox")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }
}

#[sqlx::test]
async fn expired_family_cannot_deliver_a_previously_queued_verification(pool: sqlx::PgPool) {
    let relay = Relay::start(false).await;
    let (app, account) = fixture(&pool, &relay).await;
    let input = start_input(&app, &account, "owner@example.test").await;
    begin(&app, &account, input, None).await.unwrap();
    sqlx::query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 0);
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT attempts FROM email_outbox")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert!(relay.messages.lock().await.is_empty());
    app.cleanup().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM email_outbox")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[sqlx::test]
async fn last_delivery_attempt_remains_sending_until_its_lease_ends(pool: sqlx::PgPool) {
    let relay = Relay::start(false).await;
    let (app, account) = fixture(&pool, &relay).await;
    let input = start_input(&app, &account, "owner@example.test").await;
    begin(&app, &account, input.clone(), None).await.unwrap();
    sqlx::query("UPDATE email_outbox SET attempts=8,lease_id='last-attempt',lease_expires_at=clock_timestamp()+interval '2 minutes'")
        .execute(&pool).await.unwrap();
    assert!(matches!(
        resume(&app, &account, resumption(&input)).await.unwrap(),
        EmailVerificationStep::Pending {
            delivery: rv_protocol::parity::EmailDeliveryState::Sending,
            ..
        }
    ));
    sqlx::query("UPDATE email_outbox SET lease_expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        resume(&app, &account, resumption(&input)).await.unwrap(),
        EmailVerificationStep::Pending {
            delivery: rv_protocol::parity::EmailDeliveryState::Exhausted,
            ..
        }
    ));
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 0);
    assert!(relay.messages.lock().await.is_empty());
}

#[sqlx::test]
async fn pruned_expired_challenge_never_reopens_its_claimed_head(pool: sqlx::PgPool) {
    let relay = Relay::start(false).await;
    let (app, account) = fixture(&pool, &relay).await;
    let original = start_input(&app, &account, "owner@example.test").await;
    begin(&app, &account, original.clone(), None).await.unwrap();
    sqlx::query("UPDATE email_verifications SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    app.cleanup().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM email_verifications")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert!(
        begin(&app, &account, original.clone(), None)
            .await
            .is_err_and(|error| error.code == "operation_conflict")
    );
    let fresh_candidate = start_input(&app, &account, "another@example.test").await;
    assert!(
        begin(&app, &account, fresh_candidate, None)
            .await
            .is_err_and(|error| error.code == "operation_conflict")
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM email_outbox")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    retire(&app, &account, retirement(&original)).await.unwrap();
    let next = start_input(&app, &account, "another@example.test").await;
    assert!(next.verification_version != original.verification_version);
    begin(&app, &account, next, None).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM email_outbox")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
}
