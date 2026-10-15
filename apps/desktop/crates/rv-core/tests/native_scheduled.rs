mod common;
use chrono::{Duration as Span, Utc};
use common::{FakeHttp, dropped, respond};
use rv_core::{
    native::{Identity, NativeSession, scheduled, store::NativeStore},
    session::{Connection, SessionInfo},
};
use rv_protocol::Snapshot;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap()
}
fn identity() -> Identity {
    Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }
}

#[tokio::test]
async fn schedule_replays_its_operation_until_answered_lists_one_room_and_cancels() {
    let f = fixture();
    let mut discovery = f["discovery"].clone();
    discovery["capabilities"]["scheduled_messages"] = json!(true);
    let advertised = Arc::new(Mutex::new(discovery));
    let mut secret = f["room"].clone();
    secret["id"] = json!("secret-id");
    secret["encrypted"] = json!(true);
    let snapshot: Snapshot = serde_json::from_value(
        json!({"protocol_version":1,"rooms":[f["room"], secret],"messages":[],"cursor":"opaque-fixture"}),
    )
    .unwrap();
    let posts = Arc::new(AtomicUsize::new(0));
    let (discovery, counter) = (advertised.clone(), posts.clone());
    let server = FakeHttp::start(move |r| match (r.method.as_str(), r.path()) {
        (_, "/.well-known/vibez") => respond(200, &discovery.lock().unwrap().to_string()),
        (_, "/api/v1/me") => respond(200, &f["session"]["user"].to_string()),
        (_, "/api/v1/sync/changes") => respond(
            200,
            &json!({"protocol_version":1,"changes":[],"cursor":"opaque-fixture","has_more":false}).to_string(),
        ),
        (_, "/api/v1/sync/ticket") => respond(200, &f["socket_ticket"].to_string()),
        (_, "/api/v1/sync/socket") => common::Response { websocket: true, ..Default::default() },
        ("POST", "/api/v1/rooms/room-id/scheduled") => {
            assert_eq!(r.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
            // The first attempt loses its answer.
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                return dropped();
            }
            let input: Value = serde_json::from_str(&r.body).unwrap();
            respond(
                200,
                &json!({
                    "id": format!("s-{}", input["operation_id"].as_str().unwrap()),
                    "room_id": "room-id",
                    "text": input["text"],
                    "reply_to": input.get("reply_to"),
                    "send_at": input["send_at"],
                    "state": "pending",
                })
                .to_string(),
            )
        }
        ("GET", "/api/v1/scheduled") => respond(
            200,
            &json!({"messages": [
                {"id": "s1", "room_id": "room-id", "text": "later", "send_at": "2026-10-12T06:00:00Z", "state": "pending"},
                {"id": "s2", "room_id": "elsewhere", "text": "other", "send_at": "2026-10-12T07:00:00Z", "state": "pending"},
                {"id": "s3", "room_id": "room-id", "text": "lost", "send_at": "2026-10-10T06:00:00Z", "state": "failed", "error": "permission_denied"},
            ]})
            .to_string(),
        ),
        ("DELETE", "/api/v1/scheduled/s1") => respond(204, ""),
        ("DELETE", "/api/v1/scheduled/s4") => {
            respond(409, &json!({"code": "scheduled_sending", "request_id": "r"}).to_string())
        }
        _ => respond(404, &json!({"code": "not_found", "request_id": "r"}).to_string()),
    })
    .await;
    let path = std::env::temp_dir().join(format!("rv-scheduled-{:032x}.sqlite", fastrand::u128(..)));
    let store = NativeStore::open(&path, identity()).unwrap();
    store.snapshot(&snapshot).unwrap();
    drop(store);
    let session = NativeSession::start(
        SessionInfo {
            mattermost: None,
            slack: None,
            base_url: server.url.to_string(),
            user_id: "alice-id".into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity()),
        },
        Path::new(&path),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(session.supported_features().iter().any(|f| f == "scheduled_messages"));
    assert!(session.can_schedule("room-id"));
    assert!(!session.can_schedule("secret-id"), "never in an encrypted room");

    let at = scheduled::in_one_hour(Utc::now());
    // The field's blank lines are not part of the message: the retry is the same one.
    let lost = session.schedule_message("room-id", None, "hello later\n", at).await.unwrap_err();
    assert_eq!(lost.code(), "connection_failed");
    let made = session.schedule_message("room-id", None, "hello later", at).await.unwrap();
    assert_eq!((made.room_id.as_str(), made.text.as_str()), ("room-id", "hello later"));
    let operations: Vec<String> = server
        .requests()
        .iter()
        .filter(|r| r.method == "POST" && r.path() == "/api/v1/rooms/room-id/scheduled")
        .map(|r| serde_json::from_str::<Value>(&r.body).unwrap()["operation_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(operations.len(), 2);
    assert_eq!(operations[0], operations[1], "a retry without an answer replays the same operation");
    assert_eq!(made.id, format!("s-{}", operations[0]));

    // Answered, the next one is a new message, here a thread reply.
    let reply = session.schedule_message("room-id", Some("root-id"), "hello later", at).await.unwrap();
    assert_eq!(reply.reply_to.as_deref(), Some("root-id"));
    let bodies: Vec<Value> = server
        .requests()
        .iter()
        .filter(|r| r.method == "POST" && r.path() == "/api/v1/rooms/room-id/scheduled")
        .map(|r| serde_json::from_str(&r.body).unwrap())
        .collect();
    assert_ne!(bodies[2]["operation_id"], bodies[1]["operation_id"]);
    assert_eq!(bodies[2]["reply_to"], "root-id");
    assert!(bodies[1].get("reply_to").is_none());
    assert!(bodies[2]["send_at"].as_str().unwrap().ends_with('Z'));

    let refused = session.schedule_message("secret-id", None, "secret", at).await.unwrap_err();
    assert_eq!(refused.code(), "encrypted_room");
    let soon = session.schedule_message("room-id", None, "too soon", Utc::now() + Span::seconds(5)).await;
    assert_eq!(soon.unwrap_err().code(), "scheduled_time");
    let far = session.schedule_message("room-id", None, "too far", Utc::now() + Span::days(31)).await;
    assert_eq!(far.unwrap_err().code(), "scheduled_time");
    assert_eq!(session.schedule_message("room-id", None, "   ", at).await.unwrap_err().code(), "invalid_request");
    assert_eq!(posts.load(Ordering::SeqCst), 3, "refused locally, nothing was sent");

    let listed = session.scheduled_messages("room-id").await.unwrap();
    assert_eq!(listed.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["s1", "s3"]);
    assert_eq!(listed[1].state, scheduled::ScheduledState::Failed);
    assert_eq!(scheduled::failure_key(listed[1].error.as_deref()), Some("scheduled.reason_access"));

    session.cancel_scheduled("s1").await.unwrap();
    assert_eq!(session.cancel_scheduled("s4").await.unwrap_err().code(), "scheduled_sending");
    assert_eq!(session.cancel_scheduled("gone").await.unwrap_err().code(), "not_found");
    assert!(server.requests().iter().any(|r| r.method == "DELETE" && r.path() == "/api/v1/scheduled/s1"));

    // A server that stops offering it: nothing is offered nor sent.
    advertised.lock().unwrap()["capabilities"]["scheduled_messages"] = json!(false);
    session.reconnect();
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.scheduled_supported() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(!session.can_schedule("room-id"));
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(session.scheduled_messages("room-id").await.unwrap_err().code(), "unsupported_feature");
    common::close_native(session).await;
    std::fs::remove_file(path).unwrap();
}
