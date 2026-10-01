use super::super::{
    self as email,
    tests::{PASSWORD, Relay, confirmation, fixture, start_input},
};
use super::*;
use crate::email_delivery;
use rv_protocol::parity::{EmailVerificationStep, ResumeEmailVerification};
use std::time::Duration;

async fn verified(pool: &sqlx::PgPool) -> (App, Account, Relay) {
    let relay = Relay::start(false).await;
    let (app, account) = fixture(pool, &relay).await;
    verify(&app, &account, &relay, "owner@example.test").await;
    (app, account, relay)
}
async fn verify(app: &App, account: &Account, relay: &Relay, address: &str) {
    let input = start_input(app, account, address).await;
    email::begin(app, account, input.clone(), None)
        .await
        .unwrap();
    assert_eq!(email_delivery::drain(app).await.unwrap(), 1);
    assert!(matches!(
        email::confirm(
            app,
            account,
            confirmation(&input, relay.code(address).await)
        )
        .await
        .unwrap(),
        EmailVerificationStep::Verified { .. }
    ));
}
async fn input(app: &App, account: &Account) -> RemoveVerifiedEmail {
    let status = email::status(app, account).await.unwrap();
    RemoveVerifiedEmail {
        operation_id: auth::random_token(),
        expected_version: status.version,
        verification_version: status.verification_version,
        context: status.context,
    }
}
fn resumption(input: &RemoveVerifiedEmail) -> ResumeEmailRemoval {
    ResumeEmailRemoval {
        operation_id: input.operation_id.clone(),
        context: input.context.clone(),
    }
}
fn retirement(input: &RemoveVerifiedEmail) -> RetireEmailRemoval {
    RetireEmailRemoval {
        expected_version: input.expected_version.clone(),
        verification_version: input.verification_version.clone(),
        context: input.context.clone(),
    }
}
async fn second(app: &App) -> Account {
    let session = auth::login(app, "owner".into(), PASSWORD.into())
        .await
        .unwrap();
    auth::authenticate(app, &auth::hash_token(&session.token))
        .await
        .unwrap()
}

#[sqlx::test]
async fn removal_survives_restart_and_expired_proof_without_smtp_or_new_authority(
    pool: sqlx::PgPool,
) {
    let (app, account, _relay) = verified(&pool).await;
    let command = input(&app, &account).await;
    let before:(String,String,String,String,DateTime<Utc>)=sqlx::query_as("SELECT u.activation_version,u.factor_version,u.password_hash,d.reauthentication_version,d.created_at FROM users u JOIN session_devices d ON d.user_id=u.id WHERE u.id=$1").bind(&account.id).fetch_one(&pool).await.unwrap();
    let no_mail = App::from_pool(pool.clone()).await.unwrap();
    let receipt = begin(&no_mail, &account, command.clone()).await.unwrap();
    assert!(
        receipt.version != command.expected_version
            && receipt.verification_version != command.verification_version
    );
    let after:(String,String,String,String,DateTime<Utc>)=sqlx::query_as("SELECT u.activation_version,u.factor_version,u.password_hash,d.reauthentication_version,d.created_at FROM users u JOIN session_devices d ON d.user_id=u.id WHERE u.id=$1").bind(&account.id).fetch_one(&pool).await.unwrap();
    assert!(before == after);
    let counts:(i64,i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM account_emails),(SELECT count(*) FROM email_verifications),(SELECT count(*) FROM email_outbox),(SELECT count(*) FROM session_devices),(SELECT count(*) FROM sessions)").fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (0, 0, 0, 1, 1));
    assert!(!serde_json::to_string(&receipt).unwrap().contains('@'));
    let stored: String = sqlx::query_scalar("SELECT operation_hash FROM email_removals")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(stored != command.operation_id);
    sqlx::query("UPDATE session_devices SET created_at=clock_timestamp()-interval '20 minutes'")
        .execute(&pool)
        .await
        .unwrap();
    let restarted = App::from_pool(pool.clone()).await.unwrap();
    assert!(
        begin(&restarted, &account, command.clone())
            .await
            .unwrap()
            .version
            == receipt.version
    );
    assert!(
        resume(&restarted, &account, resumption(&command))
            .await
            .unwrap()
            .version
            == receipt.version
    );
    assert!(
        email::status(&app, &account)
            .await
            .unwrap()
            .address
            .is_none()
    );
}

#[sqlx::test]
async fn missing_contact_stale_scope_and_old_proof_fail_without_mutating_contact(
    pool: sqlx::PgPool,
) {
    let relay = Relay::start(false).await;
    let (app, account) = fixture(&pool, &relay).await;
    let missing = input(&app, &account).await;
    assert!(
        begin(&app, &account, missing)
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    verify(&app, &account, &relay, "owner@example.test").await;
    let command = input(&app, &account).await;
    let mut wrong = command.clone();
    wrong.context.device_id = "another-device".into();
    assert!(
        begin(&app, &account, wrong)
            .await
            .is_err_and(|e| e.code == "operation_conflict")
    );
    let mut old = command.clone();
    old.expected_version = "old-contact".into();
    assert!(
        begin(&app, &account, old)
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    sqlx::query("UPDATE session_devices SET created_at=clock_timestamp()-interval '20 minutes'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        begin(&app, &account, command)
            .await
            .is_err_and(|e| e.code == "reauthentication_required")
    );
    assert!(
        email::status(&app, &account)
            .await
            .unwrap()
            .address
            .as_deref()
            == Some("owner@example.test")
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM email_removals")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[sqlx::test]
async fn removal_purges_old_codes_across_devices_and_never_erases_a_new_contact_after_pruning(
    pool: sqlx::PgPool,
) {
    let (app, account, relay) = verified(&pool).await;
    let other = second(&app).await;
    let pending = start_input(&app, &other, "pending@example.test").await;
    email::begin(&app, &other, pending.clone(), None)
        .await
        .unwrap();
    let command = input(&app, &account).await;
    begin(&app, &account, command.clone()).await.unwrap();
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 0);
    assert!(
        email::resume(
            &app,
            &other,
            ResumeEmailVerification {
                verification_id: pending.verification_id.clone(),
                operation_id: pending.operation_id.clone(),
                context: pending.context.clone()
            }
        )
        .await
        .is_err_and(|e| e.code == "email_verification_rejected")
    );
    assert!(
        email::begin(&app, &other, pending.clone(), None)
            .await
            .is_err_and(|e| e.code == "operation_conflict")
    );
    email::retire(
        &app,
        &other,
        rv_protocol::parity::RetireEmailVerification {
            expected_version: pending.expected_version,
            verification_version: pending.verification_version,
            context: pending.context,
        },
    )
    .await
    .unwrap();
    verify(&app, &other, &relay, "replacement@example.test").await;
    assert!(
        resume(&app, &account, resumption(&command))
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    assert!(
        begin(&app, &account, command.clone())
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    sqlx::query("UPDATE email_removals SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    app.cleanup().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM email_removals")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert!(
        begin(&app, &account, command)
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    assert!(
        email::status(&app, &account)
            .await
            .unwrap()
            .address
            .as_deref()
            == Some("replacement@example.test")
    );
}

#[sqlx::test]
async fn concurrent_confirmation_and_removal_cannot_both_commit(pool: sqlx::PgPool) {
    let (app, account, relay) = verified(&pool).await;
    let other = second(&app).await;
    let candidate = start_input(&app, &other, "replacement@example.test").await;
    email::begin(&app, &other, candidate.clone(), None)
        .await
        .unwrap();
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 1);
    let confirmation = confirmation(&candidate, relay.code("replacement@example.test").await);
    let command = input(&app, &account).await;
    let (removed, confirmed) = tokio::join!(
        begin(&app, &account, command),
        email::confirm(&app, &other, confirmation)
    );
    assert!(removed.is_ok() != confirmed.is_ok());
    let status = email::status(&app, &account).await.unwrap();
    assert!(if removed.is_ok() {
        status.address.is_none()
    } else {
        status.address.as_deref() == Some("replacement@example.test")
    });
}

#[sqlx::test]
async fn retirement_fences_an_unreceived_removal_without_rewinding_a_new_intent(
    pool: sqlx::PgPool,
) {
    let (app, account, _relay) = verified(&pool).await;
    let command = input(&app, &account).await;
    let retired = retire(&app, &account, retirement(&command)).await.unwrap();
    assert!(retired.address.as_deref() == Some("owner@example.test"));
    assert!(retired.version == command.expected_version);
    assert!(retired.verification_version != command.verification_version);
    assert!(
        begin(&app, &account, command.clone())
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    let fresh = input(&app, &account).await;
    let unchanged = retire(&app, &account, retirement(&command)).await.unwrap();
    assert!(unchanged.verification_version == fresh.verification_version);
    let removed = begin(&app, &account, fresh).await.unwrap();
    let after = retire(&app, &account, retirement(&command)).await.unwrap();
    assert!(
        after.address.is_none()
            && after.version == removed.version
            && after.verification_version == removed.verification_version
    );
}

#[sqlx::test]
async fn accepted_removal_wins_over_retirement_and_remains_resumable(pool: sqlx::PgPool) {
    let (app, account, _relay) = verified(&pool).await;
    let command = input(&app, &account).await;
    let removed = begin(&app, &account, command.clone()).await.unwrap();
    sqlx::query("UPDATE session_devices SET created_at=clock_timestamp()-interval '20 minutes'")
        .execute(&pool)
        .await
        .unwrap();
    let status = retire(&app, &account, retirement(&command)).await.unwrap();
    assert!(
        status.address.is_none()
            && status.version == removed.version
            && status.verification_version == removed.verification_version
    );
    let accepted = resume(&app, &account, resumption(&command)).await.unwrap();
    assert!(
        accepted.version == removed.version
            && accepted.verification_version == removed.verification_version
    );
}

#[sqlx::test]
async fn old_retirement_preserves_verification_started_after_another_device_changed_contact(
    pool: sqlx::PgPool,
) {
    let (app, account, relay) = verified(&pool).await;
    let command = input(&app, &account).await;
    let other = second(&app).await;
    verify(&app, &other, &relay, "replacement@example.test").await;
    let candidate = start_input(&app, &account, "later@example.test").await;
    assert!(candidate.expected_version != command.expected_version);
    assert!(candidate.verification_version == command.verification_version);
    email::begin(&app, &account, candidate.clone(), None)
        .await
        .unwrap();
    let status = retire(&app, &account, retirement(&command)).await.unwrap();
    assert!(status.address.as_deref() == Some("replacement@example.test"));
    assert!(
        status.version == candidate.expected_version
            && status.verification_version == candidate.verification_version
    );
    assert!(matches!(
        email::resume(
            &app,
            &account,
            ResumeEmailVerification {
                verification_id: candidate.verification_id.clone(),
                operation_id: candidate.operation_id.clone(),
                context: candidate.context.clone()
            }
        )
        .await
        .unwrap(),
        EmailVerificationStep::Pending { .. }
    ));
    assert!(
        begin(&app, &account, command)
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    assert_eq!(email_delivery::drain(&app).await.unwrap(), 1);
    email::confirm(
        &app,
        &account,
        confirmation(&candidate, relay.code("later@example.test").await),
    )
    .await
    .unwrap();
    assert!(
        email::status(&app, &account)
            .await
            .unwrap()
            .address
            .as_deref()
            == Some("later@example.test")
    );
}

#[sqlx::test]
async fn concurrent_retirement_and_removal_have_one_durable_result(pool: sqlx::PgPool) {
    let (app, account, _relay) = verified(&pool).await;
    let command = input(&app, &account).await;
    let (removed, retired) = tokio::join!(
        begin(&app, &account, command.clone()),
        retire(&app, &account, retirement(&command))
    );
    let status = retired.unwrap();
    match removed {
        Ok(receipt) => {
            assert!(status.address.is_none() && status.version == receipt.version);
            assert!(
                resume(&app, &account, resumption(&command))
                    .await
                    .unwrap()
                    .version
                    == receipt.version
            );
        }
        Err(error) => {
            assert_eq!(error.code, "email_removal_rejected");
            assert!(
                status.address.as_deref() == Some("owner@example.test")
                    && status.version == command.expected_version
            );
            assert!(status.verification_version != command.verification_version);
            assert!(
                resume(&app, &account, resumption(&command))
                    .await
                    .is_err_and(|e| e.code == "email_removal_rejected")
            );
        }
    }
}

async fn deadline_after_lock(pool: sqlx::PgPool, proof: bool) {
    let (app, account, _relay) = verified(&pool).await;
    let command = input(&app, &account).await;
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM email_outbox FOR UPDATE")
        .fetch_all(&mut *blocker)
        .await
        .unwrap();
    let expiry = if proof {
        "UPDATE session_devices SET created_at=clock_timestamp()-interval '15 minutes'+interval '2 seconds'"
    } else {
        "UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds'"
    };
    sqlx::query(expiry).execute(&pool).await.unwrap();
    let cloned = app.clone();
    let active = account.clone();
    let late = tokio::spawn(async move { begin(&cloned, &active, command).await });
    tokio::time::timeout(Duration::from_secs(1),async {
        loop {
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT o.id FROM email_outbox%' AND wait_event_type='Lock')").fetch_one(&pool).await.unwrap();
            if waiting {break;}
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("removal must reach held outbox row before deadline");
    tokio::time::sleep(Duration::from_millis(2100)).await;
    blocker.rollback().await.unwrap();
    let expected = if proof {
        "reauthentication_required"
    } else {
        "session_rejected"
    };
    assert!(late.await.unwrap().is_err_and(|e| e.code == expected));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM account_emails")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM email_removals")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}
#[sqlx::test]
async fn expired_proof_after_row_wait_cannot_remove_contact(pool: sqlx::PgPool) {
    deadline_after_lock(pool, true).await;
}
#[sqlx::test]
async fn expired_session_after_row_wait_cannot_remove_contact(pool: sqlx::PgPool) {
    deadline_after_lock(pool, false).await;
}

#[sqlx::test]
async fn receipt_rejects_changed_inputs_scope_and_authority(pool: sqlx::PgPool) {
    let (app, account, _relay) = verified(&pool).await;
    let command = input(&app, &account).await;
    begin(&app, &account, command.clone()).await.unwrap();
    let mut changed = command.clone();
    changed.expected_version = "new-request".into();
    assert!(
        begin(&app, &account, changed)
            .await
            .is_err_and(|e| e.code == "operation_conflict")
    );
    let other = second(&app).await;
    let mut wrong = resumption(&command);
    wrong.context.device_id = email::status(&app, &other).await.unwrap().context.device_id;
    assert!(
        resume(&app, &other, wrong)
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    sqlx::query("UPDATE users SET factor_version='different-protection'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        resume(&app, &account, resumption(&command))
            .await
            .is_err_and(|e| e.code == "delivery_revalidate")
    );
    let current = auth::authenticate(&app, &account.session_hash)
        .await
        .unwrap();
    assert!(
        resume(&app, &current, resumption(&command))
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    sqlx::query("UPDATE instance SET data_epoch='different-generation'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        resume(&app, &current, resumption(&command))
            .await
            .is_err_and(|e| e.code == "operation_conflict")
    );
}

#[sqlx::test]
async fn disabled_or_revoked_family_cannot_resume_a_private_removal_receipt(pool: sqlx::PgPool) {
    let (app, account, _relay) = verified(&pool).await;
    let command = input(&app, &account).await;
    begin(&app, &account, command.clone()).await.unwrap();
    sqlx::query("UPDATE users SET disabled=true")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        resume(&app, &account, resumption(&command))
            .await
            .is_err_and(|e| e.code == "session_rejected")
    );
    sqlx::query("UPDATE users SET disabled=false")
        .execute(&pool)
        .await
        .unwrap();
    let current = auth::authenticate(&app, &account.session_hash)
        .await
        .unwrap();
    assert!(
        resume(&app, &current, resumption(&command))
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    sqlx::query("DELETE FROM sessions")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        resume(&app, &current, resumption(&command))
            .await
            .is_err_and(|e| e.code == "session_rejected")
    );
}

#[sqlx::test]
async fn expired_removal_receipt_is_not_extended_by_replay_or_recreated_after_pruning(
    pool: sqlx::PgPool,
) {
    let (app, account, _relay) = verified(&pool).await;
    let command = input(&app, &account).await;
    let removed = begin(&app, &account, command.clone()).await.unwrap();
    sqlx::query("UPDATE email_removals SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        resume(&app, &account, resumption(&command))
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    assert!(
        begin(&app, &account, command.clone())
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    app.cleanup().await.unwrap();
    assert!(
        begin(&app, &account, command)
            .await
            .is_err_and(|e| e.code == "email_removal_rejected")
    );
    let status = email::status(&app, &account).await.unwrap();
    assert!(status.address.is_none() && status.version == removed.version);
}

#[sqlx::test]
async fn real_http_sdk_removes_without_smtp_and_private_routes_reject_forged_fields(
    pool: sqlx::PgPool,
) {
    let (app, _account, _relay) = verified(&pool).await;
    let no_mail = app.with_mail(None);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, no_mail.router()).await.unwrap();
    });
    let mut client = rv_client::NativeClient::new(&base).unwrap();
    let discovery = client.discover().await.unwrap();
    assert!(discovery.capabilities.email_removal && !discovery.capabilities.email_verification);
    let session = client.login("owner", PASSWORD).await.unwrap();
    let status = client.email_status().await.unwrap();
    let command = RemoveVerifiedEmail {
        operation_id: auth::random_token(),
        expected_version: status.version,
        verification_version: status.verification_version,
        context: status.context,
    };
    let http = reqwest::Client::new();
    let mut forged = serde_json::to_value(&command).unwrap();
    forged["address"] = serde_json::json!("forged@example.test");
    let bad = http
        .post(format!("{base}/api/v1/me/email/removal/start"))
        .bearer_auth(&session.token)
        .json(&forged)
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), reqwest::StatusCode::BAD_REQUEST);
    let retired = client
        .retire_email_removal(&retirement(&command))
        .await
        .unwrap();
    assert!(retired.address.as_deref() == Some("owner@example.test"));
    assert!(client.remove_verified_email(&command).await.is_err());
    let command = RemoveVerifiedEmail {
        operation_id: auth::random_token(),
        expected_version: retired.version,
        verification_version: retired.verification_version,
        context: retired.context,
    };
    let receipt = client.remove_verified_email(&command).await.unwrap();
    let retired = http
        .post(format!("{base}/api/v1/me/email/removal/retire"))
        .bearer_auth(&session.token)
        .json(&retirement(&command))
        .send()
        .await
        .unwrap();
    assert!(retired.status().is_success());
    assert!(
        retired
            .headers()
            .get("cache-control")
            .is_some_and(|v| v == "no-store")
    );
    let retired: EmailStatus = retired.json().await.unwrap();
    assert!(
        retired.address.is_none()
            && retired.version == receipt.version
            && retired.verification_version == receipt.verification_version
    );
    assert!(
        client
            .resume_email_removal(&resumption(&command))
            .await
            .unwrap()
            .version
            == receipt.version
    );
    let replay = http
        .post(format!("{base}/api/v1/me/email/removal/start"))
        .bearer_auth(&session.token)
        .json(&command)
        .send()
        .await
        .unwrap();
    assert!(replay.status().is_success());
    assert!(
        replay
            .headers()
            .get("cache-control")
            .is_some_and(|v| v == "no-store")
    );
    assert!(client.email_status().await.unwrap().address.is_none());
    task.abort();
}
