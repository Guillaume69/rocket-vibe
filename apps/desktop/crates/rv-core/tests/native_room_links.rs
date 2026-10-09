mod common;
use common::{FakeHttp, Response, respond};
use rv_core::{
    links,
    native::{Identity, NativeSession, store::NativeStore},
};
use rv_protocol::{Change, Message, Room, Snapshot, SyncBatch};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap()
}
fn room() -> Room {
    let mut r: Room = serde_json::from_value(fixture()["room"].clone()).unwrap();
    r.read_state=Some(Box::new(serde_json::from_value(json!({"room_id":r.id,"membership_version":"grant","revision":"1","root_position":"0","reply_position":"0","unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false})).unwrap()));
    r
}

#[tokio::test]
async fn links_resolve_real_http_messages_and_fence_room_thread_membership_and_epoch() {
    for scenario in ["normal", "wrong-room", "deleted", "wrong-thread", "rejoined", "restored"] {
        let f = fixture();
        let changed = Arc::new(AtomicBool::new(false));
        let epoch = changed.clone();
        let cache: Arc<Mutex<Option<Arc<NativeStore>>>> = Arc::new(Mutex::new(None));
        let late = cache.clone();
        let mut m: Message = serde_json::from_value(f["message"].clone()).unwrap();
        m.id = "reply".into();
        m.reply_to = Some("root".into());
        let server = FakeHttp::start(move |req| {
            let path = req.path().strip_prefix("/native").unwrap_or(req.path());
            match path {
                "/.well-known/rocketvibe" => {
                    let mut d = f["discovery"].clone();
                    if epoch.load(Ordering::SeqCst) {
                        d["data_epoch"] = json!("restored");
                    }
                    respond(200, &d.to_string())
                }
                "/api/v1/me" => respond(200, &f["session"]["user"].to_string()),
                "/api/v1/sync/changes" => respond(
                    200,
                    &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string(),
                ),
                "/api/v1/sync/ticket" => respond(200, &f["socket_ticket"].to_string()),
                "/api/v1/sync/socket" => Response { websocket: true, ..Default::default() },
                "/api/v1/messages/reply" => {
                    assert_eq!(req.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
                    let mut message = m.clone();
                    if scenario == "wrong-room" {
                        message.room_id = "other-room".into();
                    }
                    if scenario == "deleted" {
                        message.deleted = true;
                        message.text.clear();
                    }
                    if scenario == "restored" {
                        epoch.store(true, Ordering::SeqCst);
                    }
                    if scenario == "rejoined" {
                        let mut room = room();
                        room.read_state.as_mut().unwrap().membership_version = Some("new-grant".into());
                        room.read_state.as_mut().unwrap().revision = "10".into();
                        late.lock()
                            .unwrap()
                            .as_ref()
                            .unwrap()
                            .batch(&SyncBatch {
                                protocol_version: 1,
                                changes: vec![Change::RoomUpsert(room)],
                                cursor: "new-grant".into(),
                                has_more: false,
                            })
                            .unwrap();
                    }
                    respond(200, &serde_json::to_string(&message).unwrap())
                }
                _ => respond(404, r#"{"code":"not_found"}"#),
            }
        })
        .await;
        let info = rv_core::session::SessionInfo {
            mattermost: None,
            base_url: format!("{}/native", server.url.as_str().trim_end_matches('/')),
            user_id: fixture()["session"]["user"]["id"].as_str().unwrap().into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }),
        };
        let session = NativeSession::start(info, Path::new(":memory:")).unwrap();
        session
            .store
            .snapshot(&Snapshot {
                protocol_version: 1,
                rooms: vec![room()],
                messages: vec![],
                cursor: "initial".into(),
            })
            .unwrap();
        *cache.lock().unwrap() = Some(session.store.clone());
        tokio::time::timeout(Duration::from_secs(5), async {
            while session.status().connection != rv_core::session::Connection::Online {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let url = links::native_permalink(
            &session.info,
            &room().id,
            Some("reply"),
            (scenario == "wrong-thread").then_some("forged-root"),
        )
        .unwrap();
        let resolved = session.resolve_room_link(links::parse(&url).unwrap()).await;
        if scenario == "normal" {
            let link = resolved.unwrap();
            assert_eq!(link.root.as_deref(), Some("root"));
            assert_eq!(session.store.selected_messages(&["reply".into()]).unwrap().len(), 1);
        } else {
            assert!(resolved.is_err(), "{scenario}");
            assert!(session.store.selected_messages(&["reply".into()]).unwrap().is_empty(), "{scenario}");
        }
        let requests = server.requests();
        assert!(requests.iter().any(|r| r.path() == "/native/api/v1/messages/reply"));
        cache.lock().unwrap().take();
        common::close_native(session).await;
    }
}

#[test]
fn native_jump_rank_uses_decimal_sequence_not_timestamp_or_float() {
    let store = NativeStore::open(
        Path::new(":memory:"),
        Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() },
    )
    .unwrap();
    let f = fixture();
    let mut early: Message = serde_json::from_value(f["message"].clone()).unwrap();
    early.id = "early".into();
    early.position = "9007199254740993".into();
    early.revision = early.position.clone();
    let mut late = early.clone();
    late.id = "late".into();
    late.position = "9007199254740994".into();
    late.revision = late.position.clone();
    late.created_at = "2020-01-01T00:00:00Z".into();
    store
        .snapshot(&Snapshot {
            protocol_version: 1,
            rooms: vec![room()],
            messages: vec![early, late],
            cursor: "initial".into(),
        })
        .unwrap();
    assert_eq!(store.message_rank(&room().id, "early").unwrap(), Some(1));
    assert_eq!(store.message_rank(&room().id, "late").unwrap(), Some(0));
    assert_eq!(store.message_rank("other", "early").unwrap(), None);
}
