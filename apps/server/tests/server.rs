use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use rv_protocol::{
    Change, Discovery, Message, MessagePage, Room, Session, Snapshot, SnapshotPage, SocketTicket,
    SyncBatch,
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
async fn sends_and_direct_creation_allow_foreign_key_checks(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    let alice = user(&app, "alice").await;
    let bob = user(&app, "bob").await;
    let server = Server::start(pool.clone()).await;
    let session = server.login("alice").await;
    let room: Room = server
        .post(
            &session.token,
            "/api/v1/rooms",
            json!({"name":"Lock regression","private":true}),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();

    for direct in [false, true] {
        // Hold the journal counter so the HTTP operation keeps its domain locks.
        let mut blocker = pool.begin().await.unwrap();
        sqlx::query("SELECT position FROM instance WHERE singleton FOR UPDATE")
            .execute(&mut *blocker)
            .await
            .unwrap();
        let path = if direct {
            "/api/v1/direct-messages".into()
        } else {
            format!("/api/v1/rooms/{}/messages", room.id)
        };
        let body = if direct {
            json!({"user_id":bob.id})
        } else {
            json!({"operation_id":"lock-regression-send","text":"Concurrent membership"})
        };
        let request = server
            .client
            .post(format!("{}{path}", server.base))
            .bearer_auth(&session.token)
            .json(&body);
        let pending = tokio::spawn(async move { request.send().await.unwrap() });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let waiting: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE instance SET position=position+1%')",
                )
                .fetch_one(&pool)
                .await
                .unwrap();
                if waiting {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("operation should reach the blocked journal counter");

        // Membership/message/journal foreign keys use KEY SHARE on users. A
        // stronger FOR UPDATE lock would deadlock with a concurrent room change.
        let compatible = sqlx::query("SELECT id FROM users WHERE id=ANY($1) FOR KEY SHARE NOWAIT")
            .bind(vec![alice.id.clone(), bob.id.clone()])
            .execute(&pool)
            .await;
        blocker.rollback().await.unwrap();
        let response = pending.await.unwrap();
        assert!(
            compatible.is_ok(),
            "domain locks must allow foreign-key checks"
        );
        assert_eq!(response.status(), StatusCode::OK);
    }
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
async fn active_socket_never_sends_room_payload_after_its_withdrawal(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    user(&app, "bob").await;
    let server = Server::start(pool).await;
    let alice = server.login("alice").await;
    let bob = server.login("bob").await;
    let mut rooms = Vec::new();
    for name in ["withdrawn", "still-authorized"] {
        let room: Room = server
            .post(
                &alice.token,
                "/api/v1/rooms",
                json!({"name":name,"private":true}),
            )
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        server
            .post(
                &alice.token,
                &format!("/api/v1/rooms/{}/members/{}", room.id, bob.user.id),
                json!({}),
            )
            .await
            .error_for_status()
            .unwrap();
        rooms.push(room);
    }
    let snapshot = server.snapshot(&bob.token).await;
    let ticket: SocketTicket = server
        .post(&bob.token, "/api/v1/sync/ticket", json!({}))
        .await
        .json()
        .await
        .unwrap();
    let (mut ws, _) = tokio_tungstenite::connect_async(format!(
        "{}/api/v1/sync/socket?ticket={}&cursor={}",
        server.base.replace("http://", "ws://"),
        ticket.ticket,
        snapshot.cursor
    ))
    .await
    .unwrap();
    let public_path = format!("/api/v1/rooms/{}/messages", rooms[1].id);
    server
        .post(
            &alice.token,
            &public_path,
            json!({"operation_id":"socket-ready","text":"ready"}),
        )
        .await
        .error_for_status()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let frame = ws.next().await.unwrap().unwrap();
            if let Ok(text) = frame.to_text() {
                let batch: SyncBatch = serde_json::from_str(text).unwrap();
                if batch
                    .changes
                    .iter()
                    .any(|c| matches!(c,Change::MessageUpsert(m) if m.id=="socket-ready"))
                {
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
    let private_path = format!("/api/v1/rooms/{}/messages", rooms[0].id);
    let sends = futures_util::future::join_all((0..8).map(|n| {
        server.post(
            &alice.token,
            &private_path,
            json!({"operation_id":format!("racing-{n}"),"text":"private during withdrawal"}),
        )
    }));
    let withdrawal = server
        .client
        .delete(format!(
            "{}/api/v1/rooms/{}/members/{}",
            server.base, rooms[0].id, bob.user.id
        ))
        .bearer_auth(&alice.token)
        .send();
    let (sends, withdrawal) = tokio::join!(sends, withdrawal);
    for response in sends {
        response.error_for_status().unwrap();
    }
    withdrawal.unwrap().error_for_status().unwrap();
    // Keep using the same live socket. Its other room continues to work.
    server
        .post(
            &alice.token,
            &private_path,
            json!({"operation_id":"strictly-after-withdrawal","text":"must remain private"}),
        )
        .await
        .error_for_status()
        .unwrap();
    server
        .post(
            &alice.token,
            &public_path,
            json!({"operation_id":"public-barrier","text":"still connected"}),
        )
        .await
        .error_for_status()
        .unwrap();
    let mut withdrawn = false;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = ws.next().await.unwrap().unwrap();
            if let Ok(text) = frame.to_text() {
                let batch: SyncBatch = serde_json::from_str(text).unwrap();
                let mut complete = false;
                for change in batch.changes {
                    match change {
                        Change::RoomRemoved { room_id } if room_id == rooms[0].id => {
                            withdrawn = true
                        }
                        Change::MessageUpsert(message) => {
                            assert!(
                                !(withdrawn && message.room_id == rooms[0].id),
                                "no payload may follow its withdrawal on this connection"
                            );
                            assert_ne!(message.id, "strictly-after-withdrawal");
                            complete |= message.id == "public-barrier";
                        }
                        Change::RoomUpsert(room) => assert!(!(withdrawn && room.id == rooms[0].id)),
                        _ => (),
                    }
                }
                if complete {
                    assert!(withdrawn);
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
    ws.close(None).await.unwrap();
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
async fn a_stalled_publisher_releases_its_session_before_logout_times_out(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let mut stalled = pool.begin().await.unwrap();
    sqlx::query("UPDATE instance SET position=position+1 WHERE singleton")
        .execute(&mut *stalled)
        .await
        .unwrap();
    let request = server
        .client
        .post(format!("{}/api/v1/rooms", server.base))
        .bearer_auth(&alice.token)
        .json(&json!({"name":"Must roll back","private":true}));
    let publish = tokio::spawn(async move { request.send().await.unwrap() });
    tokio::time::timeout(Duration::from_secs(2),async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE instance SET position%')").fetch_one(&pool).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let logout = server
        .client
        .post(format!("{}/api/v1/auth/logout", server.base))
        .bearer_auth(&alice.token)
        .send();
    let (publish, logout) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(publish, logout)
    })
    .await
    .unwrap();
    assert_eq!(publish.unwrap().status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(logout.unwrap().status(), StatusCode::NO_CONTENT);
    let rooms: i64 = sqlx::query_scalar("SELECT count(*) FROM rooms")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        rooms, 0,
        "the blocked mutation must roll back before releasing its session"
    );
    stalled.rollback().await.unwrap();
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

#[sqlx::test]
async fn login_budgets_survive_restart_and_ignore_forwarded_ip(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    user(&app, "bob").await;
    let server = Server::start(pool.clone()).await;
    for username in ["alice", "unknown"] {
        for _ in 0..10 {
            let response = server
                .client
                .post(format!("{}/api/v1/auth/login", server.base))
                .json(&json!({"username":username,"password":"wrong"}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let response = server
            .client
            .post(format!("{}/api/v1/auth/login", server.base))
            .json(&json!({"username":username,"password":"test-password-2026"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let delay: u64 = response.headers()["retry-after"]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!((1..=60).contains(&delay));
        assert_eq!(
            response.json::<rv_protocol::ApiError>().await.unwrap().code,
            "auth_rate_limited"
        );
    }
    drop(server);
    let server = Server::start(pool.clone()).await;
    let limited = server
        .client
        .post(format!("{}/api/v1/auth/login", server.base))
        .json(&json!({"username":"alice","password":"test-password-2026"}))
        .send()
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    let bob = server.login("bob").await;
    // Prime the actual TCP peer's last IP allowance, not a forwarded header.
    sqlx::query("UPDATE login_windows SET attempts=30 WHERE key=$1")
        .bind(format!("ip:{}", auth::hash_token("127.0.0.1")))
        .execute(&pool)
        .await
        .unwrap();
    let spoofed = server
        .client
        .post(format!("{}/api/v1/auth/login", server.base))
        .header("x-forwarded-for", "203.0.113.123")
        .header("forwarded", "for=203.0.113.123")
        .json(&json!({"username":"another-unknown","password":"wrong"}))
        .send()
        .await
        .unwrap();
    assert_eq!(spoofed.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        server.get(&bob.token, "/api/v1/me").await.status(),
        StatusCode::OK
    );
    // Expired windows release the budget; rejected attempts never extend it.
    sqlx::query(
        "UPDATE login_windows SET expires_at=now()-interval '1 second' WHERE key<> 'global'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let alice = server.login("alice").await;
    assert_eq!(alice.user.username, "alice");
    sqlx::query("UPDATE login_windows SET attempts=120 WHERE key='global'")
        .execute(&pool)
        .await
        .unwrap();
    let global = server
        .client
        .post(format!("{}/api/v1/auth/login", server.base))
        .json(&json!({"username":"new-key","password":"wrong"}))
        .send()
        .await
        .unwrap();
    assert_eq!(global.status(), StatusCode::TOO_MANY_REQUESTS);
    let inserted: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM login_windows WHERE key=$1)")
            .bind(format!("user:{}", auth::hash_token("new-key")))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !inserted,
        "rejected requests must not grow the limiter table"
    );
}

#[sqlx::test]
async fn simultaneous_logins_cannot_overrun_a_username_budget(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    sqlx::query("INSERT INTO login_windows(key,attempts,expires_at) VALUES($1,9,now()+interval '60 seconds')")
        .bind(format!("user:{}",auth::hash_token("alice"))).execute(&pool).await.unwrap();
    let requests = (0..8).map(|_| {
        server
            .client
            .post(format!("{}/api/v1/auth/login", server.base))
            .json(&json!({"username":"alice","password":"test-password-2026"}))
            .send()
    });
    let responses = futures_util::future::join_all(requests).await;
    assert_eq!(
        responses
            .iter()
            .filter(|r| r.as_ref().unwrap().status() == StatusCode::OK)
            .count(),
        1
    );
    for response in responses {
        let response = response.unwrap();
        assert!(matches!(
            response.status(),
            StatusCode::OK | StatusCode::TOO_MANY_REQUESTS
        ));
    }
    let attempts: i32 = sqlx::query_scalar("SELECT attempts FROM login_windows WHERE key=$1")
        .bind(format!("user:{}", auth::hash_token("alice")))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(attempts, 10);
}

#[sqlx::test]
async fn ticket_and_socket_slots_are_bounded_and_released(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let snapshot = server.snapshot(&alice.token).await;
    let replies = futures_util::future::join_all(
        (0..8).map(|_| server.post(&alice.token, "/api/v1/sync/ticket", json!({}))),
    )
    .await;
    let mut tickets = Vec::new();
    for reply in replies {
        if reply.status() == StatusCode::OK {
            tickets.push(reply.json::<SocketTicket>().await.unwrap());
        } else {
            assert_eq!(reply.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(reply.headers()["retry-after"], "30");
        }
    }
    assert_eq!(tickets.len(), 4);
    let url = |ticket: &str| {
        format!(
            "{}/api/v1/sync/socket?ticket={ticket}&cursor={}",
            server.base.replace("http://", "ws://"),
            snapshot.cursor
        )
    };
    let (first, _) = tokio_tungstenite::connect_async(url(&tickets[0].ticket))
        .await
        .unwrap();
    let replay = tokio_tungstenite::connect_async(url(&tickets[0].ticket))
        .await
        .unwrap_err();
    assert!(
        matches!(replay,tokio_tungstenite::tungstenite::Error::Http(r) if r.status()==StatusCode::UNAUTHORIZED)
    );
    sqlx::query(
        "UPDATE socket_tickets SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    )
    .bind(auth::hash_token(&tickets[1].ticket))
    .execute(&pool)
    .await
    .unwrap();
    let expired = tokio_tungstenite::connect_async(url(&tickets[1].ticket))
        .await
        .unwrap_err();
    assert!(
        matches!(expired,tokio_tungstenite::tungstenite::Error::Http(r) if r.status()==StatusCode::UNAUTHORIZED)
    );
    let fresh: SocketTicket = server
        .post(&alice.token, "/api/v1/sync/ticket", json!({}))
        .await
        .json()
        .await
        .unwrap();
    let mut sockets = vec![first];
    for ticket in [&tickets[2].ticket, &tickets[3].ticket] {
        sockets.push(
            tokio_tungstenite::connect_async(url(ticket))
                .await
                .unwrap()
                .0,
        );
    }
    let excess: SocketTicket = server
        .post(&alice.token, "/api/v1/sync/ticket", json!({}))
        .await
        .json()
        .await
        .unwrap();
    // Reserve this ticket while a socket slot is still available, then fill it:
    // the upgrade must also enforce the limit when admissions race.
    sockets.push(
        tokio_tungstenite::connect_async(url(&fresh.ticket))
            .await
            .unwrap()
            .0,
    );
    let ticket_refused = server
        .post(&alice.token, "/api/v1/sync/ticket", json!({}))
        .await;
    assert_eq!(ticket_refused.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(ticket_refused.headers()["retry-after"], "5");
    assert_eq!(
        ticket_refused
            .json::<rv_protocol::ApiError>()
            .await
            .unwrap()
            .code,
        "socket_limit"
    );
    let limited = tokio_tungstenite::connect_async(url(&excess.ticket))
        .await
        .unwrap_err();
    assert!(
        matches!(limited,tokio_tungstenite::tungstenite::Error::Http(r) if r.status()==StatusCode::TOO_MANY_REQUESTS && r.headers()["retry-after"]=="5")
    );
    sockets.pop().unwrap().close(None).await.unwrap();
    let replacement = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let response = server
                .post(&alice.token, "/api/v1/sync/ticket", json!({}))
                .await;
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                tokio::time::sleep(Duration::from_millis(20)).await;
                continue;
            }
            let ticket: SocketTicket = response.error_for_status().unwrap().json().await.unwrap();
            if let Ok((ws, _)) = tokio_tungstenite::connect_async(url(&ticket.ticket)).await {
                break ws;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("closed socket must release its reservation");
    sockets.push(replacement);
    server
        .post(&alice.token, "/api/v1/auth/logout", json!({}))
        .await
        .error_for_status()
        .unwrap();
    for mut socket in sockets {
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(Ok(message)) = socket.next().await {
                if message.is_close() {
                    return;
                }
            }
        })
        .await;
        assert!(closed.is_ok(), "logout must close active sockets");
    }
}

#[sqlx::test]
async fn expired_cursors_reset_without_resurrecting_and_records_are_pruned(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let old = server.snapshot(&alice.token).await;
    sqlx::query("UPDATE sync_cursors SET expires_at=now()-interval '1 second' WHERE token=$1")
        .bind(&old.cursor)
        .execute(&pool)
        .await
        .unwrap();
    let reset = server
        .get(
            &alice.token,
            &format!("/api/v1/sync/changes?cursor={}", old.cursor),
        )
        .await;
    assert_eq!(reset.status(), StatusCode::CONFLICT);
    assert_eq!(
        reset.json::<rv_protocol::ApiError>().await.unwrap().code,
        "sync_reset_required"
    );
    let fresh = server.snapshot(&alice.token).await;
    assert_ne!(
        fresh.cursor, old.cursor,
        "an expired token must stay expired at the same watermark"
    );
    assert_eq!(
        server
            .get(
                &alice.token,
                &format!("/api/v1/sync/changes?cursor={}", old.cursor)
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    // Simulate retained cursors from many devices / historical watermarks.
    sqlx::query("INSERT INTO sync_cursors(token,user_id,data_epoch,position,expires_at) SELECT lpad(n::text,64,'0'),$1,data_epoch,n,now()+interval '1 day' FROM instance CROSS JOIN generate_series(1,600) n")
        .bind(&alice.user.id).execute(&pool).await.unwrap();
    let current = server.snapshot(&alice.token).await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_cursors WHERE user_id=$1")
        .bind(&alice.user.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 512);
    assert_eq!(current.cursor, fresh.cursor);
    let pruned = format!("{:0>64}", 1);
    assert_eq!(
        server
            .get(
                &alice.token,
                &format!("/api/v1/sync/changes?cursor={pruned}")
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let active_ticket: SocketTicket = server
        .post(&alice.token, "/api/v1/sync/ticket", json!({}))
        .await
        .json()
        .await
        .unwrap();
    let expired_session = auth::random_token();
    sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()-interval '1 second')")
        .bind(&expired_session).bind(&alice.user.id).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO socket_tickets(token_hash,session_hash,expires_at) VALUES($1,$2,now()+interval '20 seconds')")
        .bind(auth::random_token()).bind(&expired_session).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO socket_tickets(token_hash,session_hash,expires_at) VALUES($1,$2,now()-interval '1 second')")
        .bind(auth::random_token()).bind(auth::hash_token(&alice.token)).execute(&pool).await.unwrap();
    sqlx::query("UPDATE sync_cursors SET expires_at=now()-interval '1 second' WHERE token<>$1")
        .bind(&current.cursor)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE login_windows SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    // Startup cleanup skips work held by another transaction instead of blocking
    // login / cursor creation behind a cycle of row locks.
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT token FROM sync_cursors WHERE token<>$1 LIMIT 1 FOR UPDATE")
        .bind(&current.cursor)
        .fetch_one(&mut *held)
        .await
        .unwrap();
    let restarted = tokio::time::timeout(Duration::from_secs(5), App::from_pool(pool.clone()))
        .await
        .expect("cleanup must skip a locked cursor")
        .unwrap();
    let retained: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_cursors")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(retained, 2, "live and locked cursor must remain");
    held.rollback().await.unwrap();
    restarted.cleanup().await.unwrap();
    for (table, expected) in [
        ("sessions", 1_i64),
        ("socket_tickets", 1),
        ("sync_cursors", 1),
        ("login_windows", 0),
    ] {
        let query = format!("SELECT count(*) FROM {table}");
        let count: i64 = sqlx::query_scalar(&query).fetch_one(&pool).await.unwrap();
        assert_eq!(count, expected, "cleanup of {table}");
    }
    assert!(
        server
            .changes(&alice.token, &current.cursor)
            .await
            .changes
            .is_empty()
    );
    let ticket_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM socket_tickets WHERE token_hash=$1)")
            .bind(auth::hash_token(&active_ticket.ticket))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(ticket_exists, "cleanup must keep valid tickets");
}

#[sqlx::test]
async fn large_json_is_bounded_without_skipping_replay_events(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let initial = server.snapshot(&alice.token).await;
    // Quotes double their wire size: limits must measure JSON, not raw text.
    let text = "\"".repeat(30_000);
    let mut ids = Vec::new();
    let mut last_room = String::new();
    for n in 0..3 {
        let room: Room = server
            .post(
                &alice.token,
                "/api/v1/rooms",
                json!({"name":format!("Large {n}"),"private":true}),
            )
            .await
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        last_room = room.id.clone();
        for m in 0..50 {
            let id = format!("large-{n}-{m}");
            server
                .post(
                    &alice.token,
                    &format!("/api/v1/rooms/{}/messages", room.id),
                    json!({"operation_id":id,"text":text}),
                )
                .await
                .error_for_status()
                .unwrap();
            ids.push(id);
        }
        if n == 1 {
            let response = server.get(&alice.token, "/api/v1/sync/snapshot").await;
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = response.bytes().await.unwrap();
            assert!(bytes.len() <= 8 * 1024 * 1024);
            assert_eq!(
                serde_json::from_slice::<Snapshot>(&bytes)
                    .unwrap()
                    .messages
                    .len(),
                100
            );
        }
    }
    let cursors_before: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_cursors")
        .fetch_one(&pool)
        .await
        .unwrap();
    let oversized = server.get(&alice.token, "/api/v1/sync/snapshot").await;
    assert_eq!(oversized.status(), StatusCode::CONFLICT);
    assert_eq!(
        oversized
            .json::<rv_protocol::ApiError>()
            .await
            .unwrap()
            .code,
        "snapshot_limit"
    );
    let cursors_after: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_cursors")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        cursors_before, cursors_after,
        "a partial snapshot must not publish a cursor"
    );
    let first_bytes = server
        .post(&alice.token, "/api/v1/sync/snapshots", json!({}))
        .await
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert!(first_bytes.len() <= 1024 * 1024);
    let first: SnapshotPage = serde_json::from_slice(&first_bytes).unwrap();
    assert!(first.next.is_some());
    assert!(
        first.cursor.is_none(),
        "partial pages cannot publish a replay cursor"
    );
    let frozen_ids = ids.clone();
    let future = "after-materialization";
    server
        .post(
            &alice.token,
            &format!("/api/v1/rooms/{last_room}/messages"),
            json!({"operation_id":future,"text":"arrived between snapshot pages"}),
        )
        .await
        .error_for_status()
        .unwrap();
    ids.push(future.into());
    let mut page = first;
    let mut snapshot_ids = Vec::new();
    let snapshot_id = page.snapshot_id.clone();
    let mut index = 0;
    let frozen_cursor = loop {
        assert_eq!(page.snapshot_id, snapshot_id);
        assert_eq!(page.page_index, index);
        snapshot_ids.extend(page.messages.iter().map(|m| m.id.clone()));
        if let Some(next) = page.next {
            assert!(page.cursor.is_none());
            let bytes = server
                .get(&alice.token, &format!("/api/v1/sync/snapshots/{next}"))
                .await
                .error_for_status()
                .unwrap()
                .bytes()
                .await
                .unwrap();
            assert!(bytes.len() <= 1024 * 1024);
            page = serde_json::from_slice(&bytes).unwrap();
            index += 1;
        } else {
            break page.cursor.unwrap();
        }
    };
    assert!(index > 1);
    snapshot_ids.sort();
    let mut sorted_frozen = frozen_ids;
    sorted_frozen.sort();
    assert_eq!(
        snapshot_ids, sorted_frozen,
        "every page must come from the same immutable view"
    );
    let after_snapshot = server.changes(&alice.token, &frozen_cursor).await;
    assert!(
        matches!(after_snapshot.changes.as_slice(), [Change::MessageUpsert(m)] if m.id==future)
    );
    let mut native = rv_client::NativeClient::new(&server.base).unwrap();
    native.restore(alice.token.clone());
    let assembled = native.snapshot().await.unwrap();
    assert_eq!(assembled.messages.len(), 150);
    assert!(assembled.messages.iter().any(|m| m.id == future));
    let mobile = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new("node")
            .arg("../../scripts/native-snapshot-smoke.ts")
            .env("RV_SMOKE_URL", &server.base)
            .env("RV_SMOKE_PASSWORD", "test-password-2026")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("large mobile snapshot timed out")
    .expect("Node 24 is required");
    assert!(
        mobile.status.success(),
        "mobile snapshot: {} {}",
        String::from_utf8_lossy(&mobile.stdout),
        String::from_utf8_lossy(&mobile.stderr)
    );
    let mut cursor = initial.cursor;
    let mut delivered = Vec::new();
    let mut batches = 0;
    loop {
        let response = server
            .get(
                &alice.token,
                &format!("/api/v1/sync/changes?cursor={cursor}"),
            )
            .await
            .error_for_status()
            .unwrap();
        let bytes = response.bytes().await.unwrap();
        assert!(bytes.len() <= 1024 * 1024);
        let batch: SyncBatch = serde_json::from_slice(&bytes).unwrap();
        for change in batch.changes {
            if let Change::MessageUpsert(message) = change {
                delivered.push(message.id);
            }
        }
        assert_ne!(batch.cursor, cursor);
        cursor = batch.cursor;
        batches += 1;
        if !batch.has_more {
            break;
        }
        assert!(batches < 30, "byte-bounded batches must keep advancing");
    }
    assert!(batches > 2, "large messages must produce smaller batches");
    assert_eq!(
        delivered, ids,
        "replay must preserve every event exactly once in journal order"
    );
    let page: MessagePage = server
        .get(
            &alice.token,
            &format!("/api/v1/rooms/{last_room}/messages?limit=1"),
        )
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page.messages[0].id, *ids.last().unwrap());
    assert!(
        server
            .changes(&alice.token, &cursor)
            .await
            .changes
            .is_empty()
    );
}

#[sqlx::test]
async fn materialized_pages_expire_and_cannot_survive_withdrawal_or_restore(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    user(&app, "bob").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let bob = server.login("bob").await;
    let room: Room = server
        .post(
            &alice.token,
            "/api/v1/rooms",
            json!({"name":"Paged private", "private":true}),
        )
        .await
        .json()
        .await
        .unwrap();
    server
        .post(
            &alice.token,
            &format!("/api/v1/rooms/{}/members/{}", room.id, bob.user.id),
            json!({}),
        )
        .await
        .error_for_status()
        .unwrap();
    for n in 0..24 {
        server
            .post(
                &alice.token,
                &format!("/api/v1/rooms/{}/messages", room.id),
                json!({"operation_id":format!("paged-{n}"),"text":"\"".repeat(30_000)}),
            )
            .await
            .error_for_status()
            .unwrap();
    }
    let first: SnapshotPage = server
        .post(&bob.token, "/api/v1/sync/snapshots", json!({}))
        .await
        .json()
        .await
        .unwrap();
    let next = first.next.unwrap();
    let path = format!("/api/v1/sync/snapshots/{next}");
    assert_eq!(
        server.get(&alice.token, &path).await.status(),
        StatusCode::CONFLICT,
        "a page belongs to one account"
    );
    let again = server.get(&bob.token, &path).await.bytes().await.unwrap();
    assert_eq!(
        again,
        server.get(&bob.token, &path).await.bytes().await.unwrap(),
        "lost page responses can be retried"
    );
    server
        .client
        .delete(format!(
            "{}/api/v1/rooms/{}/members/{}",
            server.base, room.id, bob.user.id
        ))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        server.get(&bob.token, &path).await.status(),
        StatusCode::CONFLICT
    );
    server
        .post(
            &alice.token,
            &format!("/api/v1/rooms/{}/members/{}", room.id, bob.user.id),
            json!({}),
        )
        .await
        .error_for_status()
        .unwrap();
    assert_eq!(
        server.get(&bob.token, &path).await.status(),
        StatusCode::CONFLICT,
        "rejoining must not revive a withdrawn snapshot"
    );
    let fresh: SnapshotPage = server
        .post(&bob.token, "/api/v1/sync/snapshots", json!({}))
        .await
        .json()
        .await
        .unwrap();
    let fresh_path = format!("/api/v1/sync/snapshots/{}", fresh.next.unwrap());
    sqlx::query("UPDATE snapshot_heads SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server.get(&bob.token, &fresh_path).await.status(),
        StatusCode::CONFLICT
    );
    app.cleanup().await.unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM snapshot_pages")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 0,
        "cleanup must cascade to the immutable payload pages"
    );
    let before_restore: SnapshotPage = server
        .post(&bob.token, "/api/v1/sync/snapshots", json!({}))
        .await
        .json()
        .await
        .unwrap();
    sqlx::query("UPDATE instance SET data_epoch=$1")
        .bind(auth::random_token())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .get(
                &bob.token,
                &format!("/api/v1/sync/snapshots/{}", before_restore.next.unwrap())
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
}

#[sqlx::test]
async fn concurrent_snapshot_admission_keeps_account_and_global_storage_bounded(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    user(&app, "bob").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    let bob = server.login("bob").await;
    for _ in 0..3 {
        server
            .post(&alice.token, "/api/v1/sync/snapshots", json!({}))
            .await
            .error_for_status()
            .unwrap();
    }
    let results = futures_util::future::join_all(
        (0..8).map(|_| server.post(&alice.token, "/api/v1/sync/snapshots", json!({}))),
    )
    .await;
    assert_eq!(
        results
            .iter()
            .filter(|r| r.status() == StatusCode::OK)
            .count(),
        1
    );
    for result in results.into_iter().filter(|r| r.status() != StatusCode::OK) {
        assert_eq!(result.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(result.headers()["retry-after"], "30");
        assert_eq!(
            result.json::<rv_protocol::ApiError>().await.unwrap().code,
            "snapshot_busy"
        );
    }
    let own: i64 = sqlx::query_scalar("SELECT count(*) FROM snapshot_heads WHERE user_id=$1")
        .bind(&alice.user.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(own, 4);
    sqlx::query("INSERT INTO snapshot_heads(id,user_id,data_epoch) SELECT $1||n,$2,data_epoch FROM instance CROSS JOIN generate_series(1,12) n")
        .bind(auth::random_token()).bind(&alice.user.id).execute(&pool).await.unwrap();
    assert_eq!(
        server
            .post(&bob.token, "/api/v1/sync/snapshots", json!({}))
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    sqlx::query("UPDATE snapshot_heads SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .post(&bob.token, "/api/v1/sync/snapshots", json!({}))
            .await
            .status(),
        StatusCode::OK
    );
}

#[sqlx::test]
async fn snapshot_room_and_total_byte_limits_refund_failed_reservations(pool: PgPool) {
    let app = App::from_pool(pool.clone()).await.unwrap();
    user(&app, "alice").await;
    let server = Server::start(pool.clone()).await;
    let alice = server.login("alice").await;
    sqlx::query("INSERT INTO rooms(id,name,kind) SELECT 'small-room-'||n,'Small '||n,'private' FROM generate_series(1,110) n")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO members(room_id,user_id,role) SELECT id,$1,'owner' FROM rooms")
        .bind(&alice.user.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        server
            .get(&alice.token, "/api/v1/sync/snapshot")
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let mut native = rv_client::NativeClient::new(&server.base).unwrap();
    native.restore(alice.token.clone());
    assert_eq!(native.snapshot().await.unwrap().rooms.len(), 110);
    sqlx::query("UPDATE snapshot_heads SET expires_at=now()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    app.cleanup().await.unwrap();
    sqlx::query("INSERT INTO rooms(id,name,kind) SELECT 'quota-room-'||n,'Quota '||n,'private' FROM generate_series(1,22) n")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO members(room_id,user_id,role) SELECT id,$1,'owner' FROM rooms WHERE id LIKE 'quota-room-%'")
        .bind(&alice.user.id).execute(&pool).await.unwrap();
    // Escaping 32,000 quotes doubles the wire size. 22 x 50 messages exceeds
    // the 64 MiB budget after several pages were inserted in the transaction.
    sqlx::query("INSERT INTO messages(id,room_id,author_id,operation_id,text,position,revision) SELECT 'quota-message-'||n,'quota-room-'||((n-1)/50+1),$1,'quota-send-'||n,$2,n,1 FROM generate_series(1,1100) n")
        .bind(&alice.user.id).bind("\"".repeat(32_000)).execute(&pool).await.unwrap();
    sqlx::query("UPDATE instance SET position=1100 WHERE singleton")
        .execute(&pool)
        .await
        .unwrap();
    let response = server
        .client
        .post(format!("{}/api/v1/sync/snapshots", server.base))
        .bearer_auth(&alice.token)
        .json(&json!({}))
        // This test deliberately materializes over 64 MiB on a shared CI runner.
        // It measures storage rejection/refund, independently of client deadlines.
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        response.json::<rv_protocol::ApiError>().await.unwrap().code,
        "snapshot_limit"
    );
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM snapshot_heads),(SELECT count(*) FROM snapshot_pages)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        counts,
        (0, 0),
        "a failed build refunds its reservation and every partial page"
    );
    sqlx::query("INSERT INTO rooms(id,name,kind) SELECT 'overflow-room-'||n,'Overflow '||n,'private' FROM generate_series(1,950) n")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO members(room_id,user_id,role) SELECT id,$1,'owner' FROM rooms WHERE id LIKE 'overflow-room-%'")
        .bind(&alice.user.id).execute(&pool).await.unwrap();
    assert_eq!(
        server
            .post(&alice.token, "/api/v1/sync/snapshots", json!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM snapshot_heads")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
}
