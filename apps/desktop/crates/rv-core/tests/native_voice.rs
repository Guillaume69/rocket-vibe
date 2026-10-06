mod common;
use common::{FakeHttp, Response, respond};
use rv_core::{
    native::{Identity, NativeSession},
    session::{Connection, SessionInfo},
    voice::{ConnectionState, Ended},
};
use rv_protocol::{Room, RoomKind, Snapshot};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap()
}
fn snapshot() -> Snapshot {
    let mut room: Room = serde_json::from_value(fixture()["room"].clone()).unwrap();
    room.kind = RoomKind::Direct;
    room.read_state = Some(Box::new(serde_json::from_value(json!({"room_id":room.id,"membership_version":"grant","revision":"1",
        "root_position":"0","reply_position":"0","unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false})).unwrap()));
    Snapshot { protocol_version: 1, rooms: vec![room], messages: vec![], cursor: "initial".into() }
}
fn ordinary(req: &common::Request) -> Response {
    let f = fixture();
    match req.path() {
        "/.well-known/rocketvibe" => {
            let mut discovery = f["discovery"].clone();
            discovery["capabilities"]["voice"] = json!(true);
            respond(200, &discovery.to_string())
        }
        "/api/v1/me" => respond(200, &f["session"]["user"].to_string()),
        "/api/v1/sync/changes" => {
            respond(200, &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string())
        }
        "/api/v1/sync/ticket" => respond(200, &f["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => Response { websocket: true, ..Default::default() },
        _ => respond(404, r#"{"code":"not_found"}"#),
    }
}
async fn session(server: &FakeHttp) -> Arc<NativeSession> {
    let session = NativeSession::start(
        SessionInfo {
            base_url: server.url.as_str().trim_end_matches('/').into(),
            user_id: fixture()["session"]["user"]["id"].as_str().unwrap().into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }),
        },
        Path::new(":memory:"),
    )
    .unwrap();
    session.store.snapshot(&snapshot()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    session
}

/// The sidecar is found through `RV_VOICE_BIN`, read from the process
/// environment: run the body in a child test process that has it.
fn in_child_with_sidecar(name: &str) -> bool {
    if std::env::var_os("RV_VOICE_BIN").is_some() {
        return false;
    }
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .env("RV_VOICE_BIN", env!("CARGO_BIN_EXE_fake-voice-sidecar"))
        .args(["--exact", name, "--test-threads=1"])
        .status()
        .unwrap();
    assert!(status.success(), "{name} failed in its child process");
    true
}

#[tokio::test]
async fn joining_ringing_and_leaving_go_through_the_grant_and_the_sidecar() {
    if in_child_with_sidecar("joining_ringing_and_leaving_go_through_the_grant_and_the_sidecar") {
        return;
    }
    let room = snapshot().rooms[0].id.clone();
    let (joins, leaves) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let (joined, left, expected) = (joins.clone(), leaves.clone(), room.clone());
    let server = FakeHttp::start(move |req| {
        if req.path() == format!("/api/v1/rooms/{expected}/voice/join") {
            let input: Value = serde_json::from_str(&req.body).unwrap();
            assert_eq!(input, json!({"membership_version":"grant","data_epoch":"fixture-epoch","ring":true}));
            joined.fetch_add(1, Ordering::SeqCst);
            return respond(
                200,
                &json!({"room_id":expected,"url":"wss://voice.example.org","token":"alice-token",
                "expires_at":"2026-10-06T12:05:00Z","can_publish":true})
                .to_string(),
            );
        }
        if req.path() == "/api/v1/voice/leave" {
            left.fetch_add(1, Ordering::SeqCst);
            return Response { status: 204, ..Default::default() };
        }
        ordinary(req)
    })
    .await;
    let session = session(&server).await;
    assert!(session.voice_supported());
    assert!(session.supported_features().iter().any(|f| f == "voice"));
    assert!(!session.supported_features().iter().any(|f| f == "calls"));
    let mut changes = session.voice().changes();
    session.connect_voice(&room, true).await.unwrap();
    assert_eq!(joins.load(Ordering::SeqCst), 1);
    let snapshot = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = session.voice().snapshot();
            if snapshot.state == ConnectionState::Connected && snapshot.local().is_some() {
                return snapshot;
            }
            let _ = changes.recv().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(snapshot.room.as_deref(), Some(room.as_str()));
    assert_eq!(snapshot.local().unwrap().identity, "alice-token", "the fake sidecar echoes the token it was given");
    session.disconnect_voice().await;
    assert_eq!(session.voice().snapshot().ended, Some(Ended::Left));
    assert_eq!(leaves.load(Ordering::SeqCst), 1);
    common::close_native(session).await;
}

#[tokio::test]
async fn without_a_sidecar_voice_is_not_offered_but_rings_can_be_declined() {
    if std::env::var_os("RV_VOICE_BIN").is_some() {
        return;
    }
    let room = snapshot().rooms[0].id.clone();
    let (declines, rooms) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let (declined, created, created_room) = (declines.clone(), rooms.clone(), snapshot().rooms[0].clone());
    let server = FakeHttp::start(move |req| {
        if req.path() == "/api/v1/voice/rings/ring1/decline" {
            declined.fetch_add(1, Ordering::SeqCst);
            return Response { status: 204, ..Default::default() };
        }
        if req.path() == "/api/v1/rooms" && req.method == "POST" {
            let input: Value = serde_json::from_str(&req.body).unwrap();
            assert_eq!(input["voice"], json!(true));
            created.fetch_add(1, Ordering::SeqCst);
            return respond(200, &serde_json::to_string(&created_room).unwrap());
        }
        ordinary(req)
    })
    .await;
    let session = session(&server).await;
    assert!(!session.voice_supported());
    assert!(!session.supported_features().iter().any(|f| f == "voice"));
    assert_eq!(session.join_voice(&room, false).await.err().unwrap().code(), "unsupported_feature");
    session.decline_ring("ring1").await.unwrap();
    assert_eq!(declines.load(Ordering::SeqCst), 1);
    session.create_room("Lounge", false, true).await.unwrap();
    assert_eq!(rooms.load(Ordering::SeqCst), 1);
    assert!(session.voice_participants(&room).is_empty());
    assert!(session.rings().is_empty());
    common::close_native(session).await;
}
