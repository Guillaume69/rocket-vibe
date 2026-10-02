use super::*;
use axum::response::IntoResponse;
use sqlx::PgPool;

fn key(purpose: &str, command: &str) -> String {
    auth::hash_token(&format!("{purpose}:{command}"))
}
async fn counts(pool: &PgPool) -> (i64, i32) {
    sqlx::query_as("SELECT (SELECT count(*) FROM email_delivery_admissions),(SELECT attempts FROM email_delivery_windows WHERE key='global')")
        .fetch_one(pool).await.unwrap()
}

#[sqlx::test]
async fn concurrent_original_intents_and_runtime_restart_consume_one_admission(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let command = key("factor-email", "original");
    let peer = Some("192.0.2.10".parse().unwrap());
    let (a, b) = tokio::join!(
        admit(&app, &command, "private-user", "owner@example.test", peer),
        admit(&app, &command, "private-user", "owner@example.test", peer)
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(counts(&pool).await, (1, 1));
    let restarted = App::from_pool(pool.clone()).await.unwrap();
    // A replay is available even after unrelated commands fill the cooldown.
    for id in ["another", "third"] {
        admit(
            &app,
            &key("verification", id),
            "private-user",
            "owner@example.test",
            peer,
        )
        .await
        .unwrap();
    }
    let before = counts(&pool).await;
    admit(
        &restarted,
        &command,
        "private-user",
        "owner@example.test",
        peer,
    )
    .await
    .unwrap();
    assert_eq!(counts(&pool).await, before);
    assert!(
        admit(
            &restarted,
            &key("recovery", "fourth"),
            "private-user",
            "owner@example.test",
            peer
        )
        .await
        .is_err_and(|e| e.code == "email_delivery_limit")
    );
    assert_eq!(counts(&pool).await, (3, 3));
}

#[sqlx::test]
async fn purposes_share_private_account_address_and_ip_budgets_without_plaintext_keys(
    pool: PgPool,
) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    for purpose in ["verification", "factor-email", "password-recovery"] {
        admit(
            &app,
            &key(purpose, "same-local-command"),
            "private-user",
            "Owner@Example.Test",
            Some("192.0.2.11".parse().unwrap()),
        )
        .await
        .unwrap();
    }
    assert_eq!(counts(&pool).await, (3, 3));
    // Different accounts cannot bypass the existing recipient budget by case.
    let error = admit(
        &app,
        &key("factor-email", "fourth"),
        "another-user",
        "owner@example.test",
        None,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.code, "email_delivery_limit");
    let response = error.into_response();
    let retry: u64 = response.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(retry > 0 && retry <= 900);
    assert_eq!(counts(&pool).await, (3, 3));
    let stored:Vec<String>=sqlx::query_scalar("SELECT key FROM email_delivery_windows UNION ALL SELECT key FROM email_delivery_admissions").fetch_all(&pool).await.unwrap();
    assert!(
        stored
            .iter()
            .all(|v| !v.contains('@') && !v.contains("private-user") && !v.contains("192.0.2.11"))
    );
    let users: i64 =
        sqlx::query_scalar("SELECT count(*) FROM email_delivery_windows WHERE key LIKE 'user:%'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        users, 1,
        "Denied admission rolls back its new per-user and global increments"
    );
}

#[sqlx::test]
async fn ip_budget_is_shared_across_accounts_and_addresses_and_replays_remain_available(
    pool: PgPool,
) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let peer = Some("192.0.2.12".parse().unwrap());
    for id in 0..10 {
        admit(
            &app,
            &key("factor-email", &id.to_string()),
            &format!("user-{id}"),
            &format!("user-{id}@example.test"),
            peer,
        )
        .await
        .unwrap();
    }
    assert!(
        admit(
            &app,
            &key("verification", "extra"),
            "another-user",
            "another@example.test",
            peer
        )
        .await
        .is_err_and(|e| e.code == "email_delivery_limit")
    );
    assert_eq!(counts(&pool).await, (10, 10));
    admit(
        &app,
        &key("factor-email", "0"),
        "user-0",
        "user-0@example.test",
        peer,
    )
    .await
    .unwrap();
    assert_eq!(counts(&pool).await, (10, 10));
}

#[sqlx::test]
async fn expired_budgets_reset_but_an_invalid_admission_never_changes_storage(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    for id in 0..3 {
        admit(
            &app,
            &key("factor-email", &id.to_string()),
            "private-user",
            "owner@example.test",
            None,
        )
        .await
        .unwrap();
    }
    for malformed in ["", "secret@example.test", "0123", &"A".repeat(64)] {
        assert!(
            admit(&app, malformed, "private-user", "owner@example.test", None)
                .await
                .is_err_and(|e| e.code == "invalid_request")
        );
    }
    assert_eq!(counts(&pool).await, (3, 3));
    sqlx::query(
        "UPDATE email_delivery_windows SET expires_at=clock_timestamp()-interval '1 second'",
    )
    .execute(&pool)
    .await
    .unwrap();
    admit(
        &app,
        &key("factor-email", "renewed-window"),
        "private-user",
        "owner@example.test",
        None,
    )
    .await
    .unwrap();
    assert_eq!(counts(&pool).await, (4, 1));
    let attempts: Vec<i32> = sqlx::query_scalar("SELECT attempts FROM email_delivery_windows")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(attempts.iter().all(|v| *v == 1));
}

#[sqlx::test]
async fn aborted_waiter_cannot_charge_or_publish_a_late_admission(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    admit(
        &app,
        &key("verification", "first"),
        "private-user",
        "owner@example.test",
        None,
    )
    .await
    .unwrap();
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT key FROM email_delivery_windows WHERE key='global' FOR UPDATE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let clone = app.clone();
    let original = key("factor-email", "cancelled-waiter");
    let candidate = original.clone();
    let waiter = tokio::spawn(async move {
        admit(
            &clone,
            &candidate,
            "private-user",
            "owner@example.test",
            None,
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {
            let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'INSERT INTO email_delivery_windows%' OR query LIKE 'SELECT key FROM email_delivery_windows%') AND pid<>pg_backend_pid())").fetch_one(&pool).await.unwrap();
            if waiting {break;}
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("Producer must reach the actual shared quota lock");
    waiter.abort();
    let _ = waiter.await;
    blocker.commit().await.unwrap();
    // Retry the original request only after its caller has been cancelled.
    admit(&app, &original, "private-user", "owner@example.test", None)
        .await
        .unwrap();
    assert_eq!(counts(&pool).await, (2, 2));
}
