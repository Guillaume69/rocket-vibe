use rv_client::NativeClient;
use rv_protocol::SendMessage;
use rv_server::{App, auth};
use sqlx::PgPool;

#[sqlx::test]
async fn rust_client_exchanges_and_replays_on_real_server(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    auth::create_user(&app, "alice", "test-password-2026".into(), false)
        .await
        .unwrap();
    auth::create_user(&app, "bob", "test-password-2026".into(), false)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app.router()).await.unwrap();
    });
    let mut alice = NativeClient::new(&base).unwrap();
    let mut bob = NativeClient::new(&base).unwrap();
    assert_eq!(alice.discover().await.unwrap().product, "rocketvibe");
    alice.login("alice", "test-password-2026").await.unwrap();
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
    let smoke = tokio::process::Command::new("node")
        .arg("../../scripts/native-client-smoke.ts")
        .env("RV_SMOKE_URL", &base)
        .env("RV_SMOKE_PASSWORD", "test-password-2026")
        .output()
        .await
        .expect("Node 24 is required for the cross-client integration test");
    assert!(
        smoke.status.success(),
        "TypeScript client failed: {}",
        String::from_utf8_lossy(&smoke.stderr)
    );
    server.abort();
}
