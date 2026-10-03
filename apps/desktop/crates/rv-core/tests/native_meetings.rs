mod common;
use common::{FakeHttp, Response, respond};
use rv_core::{
    native::{Identity, NativeSession, store::NativeStore},
    session::{Connection, SessionInfo},
};
use rv_protocol::{
    Room, Snapshot,
    meetings::{Meeting, MeetingJoin},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap()
}
fn snapshot() -> Snapshot {
    let mut room: Room = serde_json::from_value(fixture()["room"].clone()).unwrap();
    room.read_state = Some(Box::new(serde_json::from_value(json!({"room_id":room.id,"membership_version":"grant","revision":"1",
        "root_position":"0","reply_position":"0","unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false})).unwrap()));
    Snapshot { protocol_version: 1, rooms: vec![room], messages: vec![], cursor: "initial".into() }
}
fn meeting() -> Meeting {
    Meeting {
        id: "meeting".into(),
        room_id: snapshot().rooms[0].id.clone(),
        public_url: "https://meet.example/rvconference".into(),
        created_by: "alice".into(),
        expires_at: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        ended: false,
    }
}

#[tokio::test]
async fn a_profile_call_waits_for_the_new_direct_rooms_authoritative_membership() {
    let created = Arc::new(AtomicBool::new(false));
    let confirmed = created.clone();
    let mut state = snapshot();
    let room = &mut state.rooms[0];
    room.id = "new-direct".into();
    room.kind = rv_protocol::RoomKind::Direct;
    room.read_state.as_mut().unwrap().room_id = room.id.clone();
    let new_room = room.clone();
    let server = FakeHttp::start(move |req| {
        if req.path() == "/api/v1/direct-messages" {
            let input: Value = serde_json::from_str(&req.body).unwrap();
            assert_eq!(input["user_id"],"peer-id");
            confirmed.store(true,Ordering::SeqCst);
            return respond(200,&serde_json::to_string(&new_room).unwrap());
        }
        if req.path() == "/api/v1/sync/changes" && confirmed.load(Ordering::SeqCst) {
            return respond(200,&json!({"protocol_version":1,"changes":[{"type":"room_upsert","data":new_room}],"cursor":"new-direct","has_more":false}).to_string());
        }
        if req.path() == "/api/v1/rooms/new-direct/meetings" {
            let mut meeting = meeting(); meeting.room_id = "new-direct".into();
            return respond(200,&serde_json::to_string(&meeting).unwrap());
        }
        if req.path() == "/api/v1/meetings/meeting/join" {
            let mut meeting = meeting(); meeting.room_id = "new-direct".into();
            return respond(200,&serde_json::to_string(&MeetingJoin {meeting,url:"https://meet.example/rvconference?jwt=transient".into(),
                expires_at:(chrono::Utc::now()+chrono::Duration::seconds(120)).to_rfc3339()}).unwrap());
        }
        ordinary(req,false)
    }).await;
    let client = session(&server, Path::new(":memory:")).await;
    assert!(client.store.read_state("new-direct").unwrap().is_none());
    let call = client.start_direct_call("peer-id").await.unwrap();
    assert_eq!(call, "https://meet.example/rvconference?jwt=transient");
    assert!(client.store.meeting_membership("new-direct", "grant").unwrap());
    common::close_native(client).await;
}
fn ordinary(req: &common::Request, restored: bool) -> Response {
    let f = fixture();
    match req.path() {
        "/.well-known/rocketvibe" => {
            let mut discovery = f["discovery"].clone();
            discovery["capabilities"]["calls"] = json!(true);
            if restored {
                discovery["data_epoch"] = json!("restored");
            }
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
async fn session(server: &FakeHttp, path: &Path) -> Arc<NativeSession> {
    let session = NativeSession::start(
        SessionInfo {
            base_url: server.url.as_str().trim_end_matches('/').into(),
            user_id: fixture()["session"]["user"]["id"].as_str().unwrap().into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }),
        },
        path,
    )
    .unwrap();
    if session.store.rooms().unwrap().is_empty() {
        session.store.snapshot(&snapshot()).unwrap();
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    session
}
#[tokio::test]
async fn lost_start_confirmation_reuses_the_persisted_operation_after_restart() {
    let count = Arc::new(AtomicUsize::new(0));
    let starts = count.clone();
    let server = FakeHttp::start(move |req| {
        if req.path().ends_with("/meetings") {
            assert_eq!(req.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
            let input: rv_protocol::meetings::StartMeeting = serde_json::from_str(&req.body).unwrap();
            assert_eq!(input.membership_version, "grant");
            assert_eq!(input.data_epoch, "fixture-epoch");
            if starts.fetch_add(1, Ordering::SeqCst) == 0 {
                return common::dropped();
            }
            return respond(200, &serde_json::to_string(&meeting()).unwrap());
        }
        if req.path() == "/api/v1/meetings/meeting/join" {
            return respond(
                200,
                &serde_json::to_string(&MeetingJoin {
                    meeting: meeting(),
                    url: "https://meet.example/rvconference?jwt=transient".into(),
                    expires_at: (chrono::Utc::now() + chrono::Duration::seconds(120)).to_rfc3339(),
                })
                .unwrap(),
            );
        }
        ordinary(req, false)
    })
    .await;
    let path = std::env::temp_dir().join(format!("rv-call-retry-{:032x}.sqlite", fastrand::u128(..)));
    let room = snapshot().rooms[0].id.clone();
    let first = session(&server, &path).await;
    assert!(first.start_call(&room, "grant").await.is_err());
    common::close_native(first).await;
    let second = session(&server, &path).await;
    assert_eq!(second.start_call(&room, "grant").await.unwrap(), "https://meet.example/rvconference?jwt=transient");
    let requests = server.requests();
    let operations: Vec<Value> = requests
        .iter()
        .filter(|r| r.path().ends_with("/meetings"))
        .map(|r| serde_json::from_str(&r.body).unwrap())
        .collect();
    assert_eq!(operations.len(), 2);
    assert_eq!(operations[0], operations[1]);
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(conn.query_row("SELECT count(*) FROM native_meeting_intents", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    drop(conn);
    common::close_native(second).await;
    std::fs::remove_file(path).unwrap();
}
#[tokio::test]
async fn join_responses_cannot_open_another_room_or_cross_revocation_or_restore() {
    for scenario in ["normal", "wrong-room", "revoked", "restored"] {
        let cache: Arc<Mutex<Option<Arc<NativeStore>>>> = Arc::new(Mutex::new(None));
        let late = cache.clone();
        let restored = Arc::new(AtomicBool::new(false));
        let changed = restored.clone();
        let server = FakeHttp::start(move |req| {
            if req.path() == "/api/v1/meetings/meeting/join" {
                assert_eq!(req.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
                let mut meeting = meeting();
                if scenario == "wrong-room" {
                    meeting.room_id = "another-room".into();
                }
                if scenario == "restored" {
                    changed.store(true, Ordering::SeqCst);
                }
                if scenario == "revoked" {
                    late.lock().unwrap().as_ref().unwrap().snapshot(&Snapshot { rooms: vec![], ..snapshot() }).unwrap();
                }
                return respond(
                    200,
                    &serde_json::to_string(&MeetingJoin {
                        meeting,
                        url: "https://meet.example/rvconference?jwt=transient".into(),
                        expires_at: (chrono::Utc::now() + chrono::Duration::seconds(120)).to_rfc3339(),
                    })
                    .unwrap(),
                );
            }
            ordinary(req, changed.load(Ordering::SeqCst))
        })
        .await;
        let client = session(&server, Path::new(":memory:")).await;
        *cache.lock().unwrap() = Some(client.store.clone());
        let result = client.join_call(&snapshot().rooms[0].id, "meeting", "grant").await;
        if scenario == "normal" {
            assert!(result.is_ok());
        } else {
            assert!(result.is_err(), "{scenario}");
        }
        cache.lock().unwrap().take();
        common::close_native(client).await;
    }
}
