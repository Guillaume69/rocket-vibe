use rv_client::NativeClient;
use rv_protocol::SendMessage;
use rv_server::{App, auth};
use sqlx::PgPool;

#[tokio::test]
async fn rust_snapshot_bounds_chunked_wire_bodies_before_json_decoding() {
    use axum::{
        Json, Router,
        body::{Body, Bytes},
        routing::{get, post},
    };
    use serde_json::{Value, json};
    let mut discovery: Value =
        serde_json::from_str::<Value>(include_str!("../../../docs/protocol/v1.fixture.json"))
            .unwrap()["discovery"]
            .clone();
    discovery["capabilities"]["snapshot_paging"] = json!(true);
    let router = Router::new()
        .route(
            "/.well-known/rocketvibe",
            get(move || {
                let discovery = discovery.clone();
                async move { Json(discovery) }
            }),
        )
        .route(
            "/api/v1/sync/snapshots",
            post(|| async {
                // No Content-Length, and valid JSON can contain arbitrarily much
                // whitespace. The client must bound the download before decoding it.
                Body::from_stream(futures_util::stream::iter([
                    Ok::<_, std::io::Error>(Bytes::from(vec![b' '; 600_000])),
                    Ok(Bytes::from(vec![b' '; 600_000])),
                    Ok(Bytes::from_static(b"{}")),
                ]))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut client =
        NativeClient::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    client.restore("session".into());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    assert!(matches!(
        client.snapshot().await,
        Err(rv_client::Error::InvalidSnapshot)
    ));
    task.abort();
}

#[tokio::test]
async fn rust_snapshot_rejects_corrupted_or_incomplete_page_sequences() {
    use axum::{
        Json, Router,
        routing::{get, post},
    };
    use serde_json::{Value, json};
    let fixture: Value =
        serde_json::from_str(include_str!("../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut discovery = fixture["discovery"].clone();
    discovery["capabilities"]["snapshot_paging"] = json!(true);
    let room = fixture["room"].clone();
    let message = fixture["message"].clone();
    let first = json!({"protocol_version":1,"snapshot_id":"view","page_index":0,"rooms":[room],"messages":[],"next":"next","cursor":null});
    let last = json!({"protocol_version":1,"snapshot_id":"view","page_index":1,"rooms":[],"messages":[message],"next":null,"cursor":"final-cursor"});
    let mut invalid = Vec::new();
    for (field, value) in [
        ("page_index", json!(2)),
        ("snapshot_id", json!("other")),
        ("protocol_version", json!(99)),
        ("cursor", Value::Null),
        ("next", json!("https://foreign.example/page")),
    ] {
        let mut page = last.clone();
        page[field] = value;
        invalid.push(page);
    }
    let mut duplicate = last.clone();
    duplicate["messages"] = json!([message, message]);
    invalid.push(duplicate);
    let mut duplicate_room = last.clone();
    duplicate_room["rooms"] = json!([room]);
    invalid.push(duplicate_room);
    let mut foreign_room = last.clone();
    foreign_room["messages"][0]["room_id"] = json!("forbidden");
    invalid.push(foreign_room);
    let mut early_cursor = last.clone();
    early_cursor["next"] = json!("another");
    invalid.push(early_cursor);
    let mut repeated_next = last.clone();
    repeated_next["next"] = json!("next");
    repeated_next["cursor"] = Value::Null;
    invalid.push(repeated_next);
    for page in invalid.into_iter().chain([last]) {
        let valid = page["page_index"] == 1
            && page["snapshot_id"] == "view"
            && page["protocol_version"] == 1
            && page["cursor"] == "final-cursor"
            && page["next"].is_null()
            && page["rooms"].as_array().unwrap().is_empty()
            && page["messages"].as_array().unwrap().len() == 1
            && page["messages"][0]["room_id"] == room["id"];
        let info = discovery.clone();
        let start = first.clone();
        let router = Router::new()
            .route(
                "/.well-known/rocketvibe",
                get(move || {
                    let info = info.clone();
                    async move { Json(info) }
                }),
            )
            .route(
                "/api/v1/sync/snapshots",
                post(move || {
                    let start = start.clone();
                    async move { Json(start) }
                }),
            )
            .route(
                "/api/v1/sync/snapshots/next",
                get(move || {
                    let page = page.clone();
                    async move { Json(page) }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client =
            NativeClient::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        client.restore("session".into());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let result = client.snapshot().await;
        if valid {
            assert_eq!(result.unwrap().messages.len(), 1);
        } else {
            assert!(matches!(result, Err(rv_client::Error::InvalidSnapshot)));
        }
        task.abort();
    }
}

#[sqlx::test]
async fn rust_client_exchanges_and_replays_on_real_server(pool: PgPool) {
    use std::{process::Stdio, time::Duration};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let app = App::from_pool(pool.clone()).await.unwrap();
    auth::create_user(&app, "alice", "test-password-2026".into(), false)
        .await
        .unwrap();
    auth::create_user(&app, "bob", "test-password-2026".into(), false)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.router()
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let mut alice = NativeClient::new(&base).unwrap();
    let mut bob = NativeClient::new(&base).unwrap();
    assert_eq!(alice.discover().await.unwrap().product, "rocketvibe");
    let alice_session = alice.login("alice", "test-password-2026").await.unwrap();
    let bob_session = bob.login("bob", "test-password-2026").await.unwrap();
    let room = alice.direct(&bob_session.user.id).await.unwrap();
    let snapshot = bob.snapshot().await.unwrap();
    let operation = SendMessage {
        operation_id: "rust-native-send".into(),
        text: "Hello from the Rust transport".into(),
    };
    let first = alice.send(&room.id, &operation).await.unwrap();
    assert_eq!(alice.send(&room.id, &operation).await.unwrap(), first);
    assert_eq!(
        bob.history(&room.id, None).await.unwrap().messages,
        vec![first]
    );
    assert_eq!(
        bob.changes(&snapshot.cursor).await.unwrap().changes.len(),
        1
    );
    let url = bob.socket_url(&snapshot.cursor).await.unwrap();
    assert_eq!(url.scheme(), "ws");
    assert!(!url.as_str().contains(&bob_session.token));
    let mut child = tokio::process::Command::new("node")
        .arg("../../scripts/native-client-smoke.ts")
        .env("RV_SMOKE_URL", &base)
        .env("RV_SMOKE_PASSWORD", "test-password-2026")
        .env("RV_SMOKE_EXPIRE_CURSOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("Node 24 is required for the cross-client integration test");
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut input = child.stdin.take().unwrap();
    let mut log = String::new();
    let mut expired = false;
    let smoke = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            log.push_str(&line);
            log.push('\n');
            if line == "Mobile runner awaiting cursor expiry" {
                sqlx::query(
                    "UPDATE sync_cursors SET expires_at=now()-interval '1 second' WHERE user_id=$1",
                )
                .bind(&alice_session.user.id)
                .execute(&pool)
                .await
                .unwrap();
                input.write_all(b"expired\n").await.unwrap();
                expired = true;
            }
        }
        child.wait_with_output().await.unwrap()
    })
    .await
    .expect("cross-client test must finish within 60 seconds");
    assert!(
        smoke.status.success(),
        "TypeScript client failed: {log} {}",
        String::from_utf8_lossy(&smoke.stderr)
    );
    assert!(
        expired,
        "the real PostgreSQL cursor must have expired before mobile reconnect"
    );
    server.abort();
}

#[tokio::test]
async fn rust_transport_respects_retry_after_across_clones() {
    use axum::{Json, Router, routing::post};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let requests = calls.clone();
    let router = Router::new().route(
        "/api/v1/auth/login",
        post(move || {
            let requests = requests.clone();
            async move {
                requests.fetch_add(1, Ordering::SeqCst);
                (
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    [("retry-after", "1")],
                    Json(rv_protocol::ApiError {
                        code: "auth_rate_limited".into(),
                        request_id: "test".into(),
                    }),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut client =
        NativeClient::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    for mut transport in [client.clone(), client.clone()] {
        assert!(matches!(transport.login("alice","wrong").await,
            Err(rv_client::Error::Server { status:429,code,request_id,retry_after }) if code=="auth_rate_limited" && request_id.as_deref()==Some("test") && retry_after==Some(1)));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(client.login("bob", "wrong").await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert!(client.login("alice", "wrong").await.is_err());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "the cooldown must eventually expire"
    );
    server.abort();
}
