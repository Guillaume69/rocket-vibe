use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use rv_protocol::{
    Change, Discovery, Message, MessagePage, Room, Session, Snapshot, SocketTicket, SyncBatch,
};
use rv_server::{App, auth};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;

struct Server {
    base: String,
    client: Client,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    async fn start(pool: PgPool) -> Self {
        let app = App::from_pool(pool).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app.router()).await.unwrap();
        });
        Self {
            base,
            client: Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
            task,
        }
    }
    async fn login(&self, username: &str) -> Session {
        self.client
            .post(format!("{}/api/v1/auth/login", self.base))
            .json(&json!({"username":username,"password":"test-password-2026"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn get(&self, token: &str, path: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
    }
    async fn post(&self, token: &str, path: &str, body: Value) -> reqwest::Response {
        self.client
            .post(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap()
    }
    async fn snapshot(&self, token: &str) -> Snapshot {
        self.get(token, "/api/v1/sync/snapshot")
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn changes(&self, token: &str, cursor: &str) -> SyncBatch {
        self.get(token, &format!("/api/v1/sync/changes?cursor={cursor}"))
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
}

async fn user(app: &App, username: &str) -> rv_protocol::User {
    auth::create_user(app, username, "test-password-2026".into(), false)
        .await
        .unwrap()
}

#[sqlx::test]
async fn exchange_replay_restart_and_privacy(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let bob = user(&app, "bob").await;
    user(&app, "mallory").await;
    let server = Server::start(pool.clone()).await;
    let alice_session = server.login("alice").await;
    let bob_session = server.login("bob").await;
    let mallory_session = server.login("mallory").await;
    let bob_initial = server.snapshot(&bob_session.token).await;
    let mallory_initial = server.snapshot(&mallory_session.token).await;
    let room: Room = server
        .post(
            &alice_session.token,
            "/api/v1/rooms",
            json!({"name":"Private test","private":true}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        server
            .post(
                &alice_session.token,
                &format!("/api/v1/rooms/{}/members/{}", room.id, bob.id),
                json!({})
            )
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let path = format!("/api/v1/rooms/{}/messages", room.id);
    let intention = json!({"operation_id":"00112233445566778899aabb","text":"Hello from Android"});
    let (first, replay) = tokio::join!(
        server.post(&alice_session.token, &path, intention.clone()),
        server.post(&alice_session.token, &path, intention.clone())
    );
    let first: Message = first.error_for_status().unwrap().json().await.unwrap();
    let replay: Message = replay.error_for_status().unwrap().json().await.unwrap();
    assert_eq!(first, replay);
    let mut different = intention.clone();
    different["text"] = json!("Changed intention");
    assert_eq!(
        server
            .post(&alice_session.token, &path, different)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let page: MessagePage = server
        .get(&bob_session.token, &path)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page.messages, vec![first.clone()]);
    let batch = server
        .changes(&bob_session.token, &bob_initial.cursor)
        .await;
    assert!(
        batch
            .changes
            .iter()
            .any(|c| matches!(c,Change::MessageUpsert(m) if m==&first))
    );
    assert!(
        server
            .changes(&mallory_session.token, &mallory_initial.cursor)
            .await
            .changes
            .is_empty()
    );
    assert_eq!(
        server.get(&mallory_session.token, &path).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .post(&mallory_session.token, &path, intention.clone())
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .get(
                &mallory_session.token,
                &format!("/api/v1/sync/changes?cursor={}", bob_initial.cursor)
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let identity: Discovery = server
        .client
        .get(format!("{}/.well-known/rocketvibe", server.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    drop(server);
    let restarted = Server::start(pool).await;
    let after: Message = restarted
        .post(&alice_session.token, &path, intention)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first, after);
    let after_identity: Discovery = restarted
        .client
        .get(format!("{}/.well-known/rocketvibe", restarted.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(identity.instance_id, after_identity.instance_id);
    assert_eq!(identity.data_epoch, after_identity.data_epoch);
    assert_eq!(
        restarted.snapshot(&bob_session.token).await.messages,
        vec![first]
    );
}

#[sqlx::test]
async fn sockets_resume_tickets_are_single_use_and_logout_revokes(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let bob = user(&app, "bob").await;
    let server = Server::start(pool).await;
    let alice = server.login("alice").await;
    let bob_session = server.login("bob").await;
    let room: Room = server
        .post(
            &alice.token,
            "/api/v1/direct-messages",
            json!({"user_id":bob.id}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let snapshot = server.snapshot(&bob_session.token).await;
    let ticket: SocketTicket = server
        .post(&bob_session.token, "/api/v1/sync/ticket", json!({}))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!(
        "{}/api/v1/sync/socket?ticket={}&cursor={}",
        server.base.replace("http://", "ws://"),
        ticket.ticket,
        snapshot.cursor
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    assert!(tokio_tungstenite::connect_async(&url).await.is_err());
    let path = format!("/api/v1/rooms/{}/messages", room.id);
    let first: Message = server
        .post(
            &alice.token,
            &path,
            json!({"operation_id":"socket-first","text":"live"}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let wire = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let batch: SyncBatch = serde_json::from_str(wire.to_text().unwrap()).unwrap();
    assert!(
        batch
            .changes
            .iter()
            .any(|c| matches!(c,Change::MessageUpsert(m) if m.id==first.id))
    );
    socket.close(None).await.unwrap();
    server
        .post(
            &alice.token,
            &path,
            json!({"operation_id":"socket-offline","text":"while disconnected"}),
        )
        .await
        .error_for_status()
        .unwrap();
    let ticket: SocketTicket = server
        .post(&bob_session.token, "/api/v1/sync/ticket", json!({}))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let (mut resumed, _) = tokio_tungstenite::connect_async(format!(
        "{}/api/v1/sync/socket?ticket={}&cursor={}",
        server.base.replace("http://", "ws://"),
        ticket.ticket,
        batch.cursor
    ))
    .await
    .unwrap();
    let wire = tokio::time::timeout(Duration::from_secs(5), resumed.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let resumed_batch: SyncBatch = serde_json::from_str(wire.to_text().unwrap()).unwrap();
    assert!(
        resumed_batch
            .changes
            .iter()
            .any(|c| matches!(c,Change::MessageUpsert(m) if m.id=="socket-offline"))
    );
    assert_eq!(
        server
            .post(&bob_session.token, "/api/v1/auth/logout", json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        server.get(&bob_session.token, "/api/v1/me").await.status(),
        StatusCode::UNAUTHORIZED
    );
    let close = tokio::time::timeout(Duration::from_secs(5), resumed.next())
        .await
        .unwrap();
    assert!(close.is_none() || close.unwrap().unwrap().is_close());
}

#[sqlx::test]
async fn removal_filters_replay_and_prevents_writes(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let bob = user(&app, "bob").await;
    let server = Server::start(pool).await;
    let alice = server.login("alice").await;
    let bob_session = server.login("bob").await;
    let room: Room = server
        .post(
            &alice.token,
            "/api/v1/rooms",
            json!({"name":"secret","private":true}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let member = format!("/api/v1/rooms/{}/members/{}", room.id, bob.id);
    server
        .post(&alice.token, &member, json!({}))
        .await
        .error_for_status()
        .unwrap();
    let snapshot = server.snapshot(&bob_session.token).await;
    let path = format!("/api/v1/rooms/{}/messages", room.id);
    server
        .post(
            &alice.token,
            &path,
            json!({"operation_id":"before-removal","text":"secret"}),
        )
        .await
        .error_for_status()
        .unwrap();
    server
        .client
        .delete(format!("{}{member}", server.base))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let replay = server.changes(&bob_session.token, &snapshot.cursor).await;
    assert_eq!(
        replay.changes,
        vec![Change::RoomRemoved {
            room_id: room.id.clone()
        }]
    );
    assert_eq!(
        server.get(&bob_session.token, &path).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .post(
                &bob_session.token,
                &path,
                json!({"operation_id":"after-removal","text":"no"})
            )
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert!(server.snapshot(&bob_session.token).await.rooms.is_empty());
}

#[sqlx::test]
async fn concurrent_dm_and_pagination(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let alice = user(&app, "alice").await;
    let bob = user(&app, "bob").await;
    let server = Server::start(pool).await;
    let a = server.login("alice").await;
    let b = server.login("bob").await;
    let (ab, ba) = tokio::join!(
        server.post(
            &a.token,
            "/api/v1/direct-messages",
            json!({"user_id":bob.id})
        ),
        server.post(
            &b.token,
            "/api/v1/direct-messages",
            json!({"user_id":alice.id})
        )
    );
    let ab: Room = ab.error_for_status().unwrap().json().await.unwrap();
    let ba: Room = ba.error_for_status().unwrap().json().await.unwrap();
    assert_eq!(ab, ba);
    let path = format!("/api/v1/rooms/{}/messages", ab.id);
    for n in 0..3 {
        server
            .post(
                &a.token,
                &path,
                json!({"operation_id":format!("message-{n}"),"text":format!("text {n}")}),
            )
            .await
            .error_for_status()
            .unwrap();
    }
    let first: MessagePage = server
        .get(&b.token, &format!("{path}?limit=2"))
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(first.has_more);
    assert_eq!(first.messages.len(), 2);
    let second: MessagePage = server
        .get(
            &b.token,
            &format!("{path}?limit=2&before={}", first.messages[1].position),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!second.has_more);
    assert_eq!(second.messages[0].text, "text 0");
    assert_ne!(second.messages[0].id, first.messages[1].id);
}

#[sqlx::test]
async fn late_commit_cannot_be_skipped_by_a_cursor(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let snapshot = server.snapshot(&alice.token).await;
    let mut stalled = pool.begin().await.unwrap();
    sqlx::query("UPDATE instance SET position=position+1 WHERE singleton")
        .execute(&mut *stalled)
        .await
        .unwrap();
    let request = server
        .client
        .post(format!("{}/api/v1/rooms", server.base))
        .bearer_auth(&alice.token)
        .json(&json!({"name":"after stalled commit","private":true}));
    let pending = tokio::spawn(async move { request.send().await.unwrap() });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !pending.is_finished(),
        "later publisher must wait for the counter lock"
    );
    let batch = server.changes(&alice.token, &snapshot.cursor).await;
    assert!(batch.changes.is_empty());
    assert!(!batch.has_more);
    stalled.rollback().await.unwrap();
    pending.await.unwrap().error_for_status().unwrap();
    assert_eq!(
        server
            .changes(&alice.token, &batch.cursor)
            .await
            .changes
            .len(),
        1
    );
}

#[sqlx::test]
async fn auth_validation_and_generation_reset(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let discovery: Discovery = server
        .client
        .get(format!("{}/.well-known/rocketvibe", server.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(discovery.product, "rocketvibe");
    assert!(!discovery.capabilities.e2ee);
    assert!(!discovery.capabilities.uploads);
    let unknown = server
        .client
        .post(format!("{}/api/v1/auth/login", server.base))
        .json(&json!({"username":"unknown","password":"wrong"}))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::UNAUTHORIZED);
    let error: rv_protocol::ApiError = unknown.json().await.unwrap();
    assert_eq!(error.code, "session_rejected");
    let a = server.login("alice").await;
    let snapshot = server.snapshot(&a.token).await;
    let malformed = server
        .post(
            &a.token,
            "/api/v1/rooms",
            json!({"name":"test","private":true,"admin":true}),
        )
        .await;
    assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        malformed
            .json::<rv_protocol::ApiError>()
            .await
            .unwrap()
            .code,
        "invalid_request"
    );
    sqlx::query("UPDATE instance SET data_epoch=$1 WHERE singleton")
        .bind(auth::random_token())
        .execute(&pool)
        .await
        .unwrap();
    let reset = server
        .get(
            &a.token,
            &format!("/api/v1/sync/changes?cursor={}", snapshot.cursor),
        )
        .await;
    assert_eq!(reset.status(), StatusCode::CONFLICT);
    assert_eq!(
        reset.json::<rv_protocol::ApiError>().await.unwrap().code,
        "sync_reset_required"
    );
}
