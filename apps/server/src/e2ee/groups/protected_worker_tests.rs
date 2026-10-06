//! Runs the actual private coordinator in a separate binary so its SQLite
//! linkage remains outside the SQLx server workspace. The explicit ignored
//! test is required by the dedicated CI job, which supplies its fixture.
use super::*;
use axum::{
    body::Body,
    extract::Request,
    middleware::{self, Next},
};
use std::{
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::io::AsyncWriteExt;

#[sqlx::test]
#[ignore = "requires RV_CRYPTO_HTTP_SMOKE_BINARY; exercised by native-crypto-http CI"]
async fn protected_http_worker_publishes_joins_rotates_and_reconciles_real_postgres(pool: PgPool) {
    let binary = std::env::var_os("RV_CRYPTO_HTTP_SMOKE_BINARY")
        .expect("build and supply the separate private delivery_smoke fixture");
    assert!(
        std::fs::metadata(&binary).unwrap().is_file(),
        "private fixture binary missing"
    );
    let app = App::from_pool(pool).await.unwrap();
    let (alice, alice_token) = actor(&app, "protected-worker-alice").await;
    let (bob, bob_token) = actor(&app, "protected-worker-bob").await;
    let room = store::create_room(
        &app,
        &alice,
        CreateRoom {
            name: "protected-worker-room".into(),
            private: true,
            operation_id: None,
        },
    )
    .await
    .unwrap();
    store::membership(&app, &alice, &room.id, &bob.id, false)
        .await
        .unwrap();
    sqlx::query("UPDATE instance SET position=9007199254740992 WHERE singleton")
        .execute(&app.pool)
        .await
        .unwrap();
    let packages = Arc::new(AtomicUsize::new(0));
    let transitions = Arc::new(AtomicUsize::new(0));
    let applications = Arc::new(AtomicUsize::new(0));
    let package_posts = packages.clone();
    let group_posts = transitions.clone();
    let message_posts = applications.clone();
    let cancellation_posts = Arc::new(AtomicUsize::new(0));
    let cancellations = cancellation_posts.clone();
    let group_cancellation_posts = Arc::new(AtomicUsize::new(0));
    let group_cancellations = group_cancellation_posts.clone();
    let router = crate::http::router(app.clone()).layer(middleware::from_fn(
        move |request: Request, next: Next| {
            let packages = package_posts.clone();
            let transitions = group_posts.clone();
            let applications = message_posts.clone();
            let cancellations = cancellations.clone();
            let group_cancellations = group_cancellations.clone();
            async move {
                let package = request.method() == axum::http::Method::POST
                    && request.uri().path() == "/api/v1/e2ee/key-packages";
                let group = request.method() == axum::http::Method::POST
                    && request.uri().path().ends_with("/transitions");
                let message = request.method() == axum::http::Method::POST
                    && request.uri().path().starts_with("/api/v1/e2ee/rooms/")
                    && request.uri().path().ends_with("/messages");
                let cancellation = request.method() == axum::http::Method::POST
                    && request.uri().path().ends_with("/cancel")
                    && request.uri().path().contains("/message-operations/");
                let group_cancellation = request.method() == axum::http::Method::POST
                    && request.uri().path().ends_with("/cancel")
                    && request.uri().path().contains("/operations/");
                let lose = (package && packages.fetch_add(1, Ordering::SeqCst) == 0)
                    || group
                    || message
                    || (cancellation && cancellations.fetch_add(1, Ordering::SeqCst) == 0)
                    || (group_cancellation
                        && group_cancellations.fetch_add(1, Ordering::SeqCst) == 0);
                if group {
                    transitions.fetch_add(1, Ordering::SeqCst);
                }
                if message {
                    applications.fetch_add(1, Ordering::SeqCst);
                }
                let mut response = next.run(request).await;
                if lose && response.status().is_success() {
                    // The real handler committed before this deliberately broken
                    // response body. Never manufacture a successful receipt.
                    response
                        .headers_mut()
                        .remove(axum::http::header::CONTENT_LENGTH);
                    *response.body_mut() = Body::from_stream(futures_util::stream::once(async {
                        Err::<axum::body::Bytes, _>(std::io::Error::other(
                            "intentional lost fixture response",
                        ))
                    }));
                }
                response
            }
        },
    ));
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", socket.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(socket, router).await.unwrap();
    });
    let input = serde_json::to_vec(&serde_json::json!({"base":base,"room":room.id,"alice":{"user":alice.id,"token":alice_token},"bob":{"user":bob.id,"token":bob_token}})).unwrap();
    let mut child = tokio::process::Command::new(binary)
        .env_remove("DATABASE_URL")
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Keep phase diagnostics visible even if the bounded child wait expires.
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&input).await.unwrap();
    let output = tokio::time::timeout(Duration::from_secs(90), child.wait_with_output())
        .await
        .expect("private worker fixture timed out")
        .unwrap();
    server.abort();
    assert!(
        output.status.success(),
        "private worker failed with {}; see its phase diagnostics above",
        output.status
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "protected-worker-http-smoke: passed"
    );
    assert_eq!(
        packages.load(Ordering::SeqCst),
        3,
        "expected two initial publications and one renewed peer publication without replaying an accepted POST"
    );
    assert_eq!(
        transitions.load(Ordering::SeqCst),
        7,
        "expected six accepted transitions and one explicitly fenced late abandoned POST"
    );
    assert_eq!(
        applications.load(Ordering::SeqCst),
        11,
        "expected ten accepted sends and one explicitly fenced late abandoned POST"
    );
    let opaque: i64 =
        sqlx::query_scalar("SELECT count(*) FROM e2ee_application_messages WHERE room_id=$1")
            .bind(&room.id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(opaque, 10);
    assert_eq!(cancellation_posts.load(Ordering::SeqCst), 3);
    let abandoned: i64 =
        sqlx::query_scalar("SELECT count(*) FROM e2ee_message_cancellations WHERE user_id=$1")
            .bind(&alice.id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(abandoned, 1);
    assert_eq!(group_cancellation_posts.load(Ordering::SeqCst), 2);
    let abandoned_groups: i64 =
        sqlx::query_scalar("SELECT count(*) FROM e2ee_group_cancellations WHERE user_id=$1")
            .bind(&alice.id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(abandoned_groups, 1);
    let delivered: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_delivery WHERE room_id=$1")
        .bind(&room.id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(delivered, 16);
    let clear: i64 =
        sqlx::query_scalar("SELECT count(*) FROM messages WHERE room_id=$1 AND system IS NULL")
            .bind(&room.id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(clear, 0);
    let packets: Vec<(Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT proof,ciphertext FROM e2ee_application_messages WHERE room_id=$1")
            .bind(&room.id)
            .fetch_all(&app.pool)
            .await
            .unwrap();
    let secret = b"protected-worker-private-payload-phase-";
    assert!(packets.iter().all(|(proof, cipher)| {
        !proof.windows(secret.len()).any(|bytes| bytes == secret)
            && !cipher.windows(secret.len()).any(|bytes| bytes == secret)
    }));
    let head: (i64, i64) =
        sqlx::query_as("SELECT revision,epoch FROM e2ee_groups WHERE room_id=$1")
            .bind(&room.id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(head, (6, 6));
    for (table, expected) in [("e2ee_group_events", 6_i64), ("e2ee_group_welcomes", 3_i64)] {
        let query = format!("SELECT count(*) FROM {table} WHERE room_id=$1");
        let count: i64 = sqlx::query_scalar(&query)
            .bind(&room.id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
        assert_eq!(count, expected);
    }
    let spent: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_key_packages WHERE spent")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(
        spent, 3,
        "only the initial, readmission and renewed peer packages may be consumed"
    );
    let operations: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM e2ee_operations WHERE result->>'kind'='publish_key_packages'",
    )
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert_eq!(operations, 3);
    let device_revisions: Vec<i64> = sqlx::query_scalar(
        "SELECT revision FROM e2ee_devices WHERE user_id=$1 OR user_id=$2 ORDER BY user_id",
    )
    .bind(&alice.id)
    .bind(&bob.id)
    .fetch_all(&app.pool)
    .await
    .unwrap();
    assert_eq!(device_revisions, vec![2, 2]);
    rejected(
        store::send(
            &app,
            &alice,
            &room.id,
            SendMessage {
                operation_id: auth::random_token(),
                text: "must not reach encrypted room".into(),
                quotes: vec![],
                cards: vec![],
                reply_to: None,
                files: vec![],
            },
        )
        .await,
        "crypto_required",
    );
}
