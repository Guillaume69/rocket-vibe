mod common;
use common::{FakeHttp, respond};
use rv_core::native::{Identity, NativeSession, store::NativeStore};
use rv_core::session::{Connection, SessionInfo};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

#[tokio::test]
async fn room_information_uses_existing_model_and_rejects_late_cross_scope_payloads() {
    let fixture: Value = serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    for scenario in ["normal", "unsupported", "foreign", "removed", "closed", "epoch"] {
        let owner: Arc<Mutex<Option<Weak<NativeSession>>>> = Arc::default();
        let callback = owner.clone();
        let changed = Arc::new(AtomicBool::new(false));
        let epoch = changed.clone();
        let replies = fixture.clone();
        let server = FakeHttp::start(move |request| match request.path() {
            "/.well-known/rocketvibe" => {
                let mut discovery = replies["discovery"].clone();
                discovery["capabilities"]["room_info"] = json!(scenario != "unsupported");
                if epoch.load(Ordering::SeqCst) {
                    discovery["data_epoch"] = json!("replacement-epoch");
                }
                respond(200, &discovery.to_string())
            }
            "/api/v1/me" => respond(200, &replies["session"]["user"].to_string()),
            "/api/v1/sync/changes" => respond(
                200,
                &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string(),
            ),
            "/api/v1/sync/ticket" => respond(200, &replies["socket_ticket"].to_string()),
            "/api/v1/sync/socket" => common::Response { websocket: true, ..Default::default() },
            "/api/v1/rooms/room-id" => {
                let session = callback.lock().unwrap().as_ref().and_then(Weak::upgrade).unwrap();
                match scenario {
                    "removed" => session
                        .store
                        .batch(&rv_protocol::SyncBatch {
                            protocol_version: 1,
                            changes: vec![rv_protocol::Change::RoomRemoved { room_id: "room-id".into() }],
                            cursor: "removed".into(),
                            has_more: false,
                        })
                        .unwrap(),
                    "closed" => session.shutdown(),
                    "epoch" => epoch.store(true, Ordering::SeqCst),
                    _ => (),
                }
                let mut details = replies["parity"]["room_details"].clone();
                details["read_only"] = json!(true);
                if scenario == "foreign" {
                    details["room"]["id"] = json!("foreign-room");
                }
                respond(200, &details.to_string())
            }
            _ => respond(404, r#"{"code":"not_found","request_id":"fixture"}"#),
        })
        .await;
        let identity = Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() };
        let path = std::env::temp_dir().join(format!("rv-room-info-{:032x}.sqlite", fastrand::u128(..)));
        let store = NativeStore::open(&path, identity.clone()).unwrap();
        store
            .snapshot(&rv_protocol::Snapshot {
                protocol_version: 1,
                rooms: vec![serde_json::from_value(fixture["room"].clone()).unwrap()],
                messages: vec![],
                cursor: "initial".into(),
            })
            .unwrap();
        drop(store);
        let session = NativeSession::start(
            SessionInfo {
                base_url: server.url.to_string(),
                user_id: "alice-id".into(),
                username: "alice".into(),
                auth_token: "fixture-token".into(),
                native: Some(identity),
            },
            &path,
        )
        .unwrap();
        *owner.lock().unwrap() = Some(Arc::downgrade(&session));
        tokio::time::timeout(Duration::from_secs(5), async {
            while session.status().connection != Connection::Online {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let result = session.room_info("room-id").await;
        if scenario == "normal" {
            let info = result.unwrap();
            assert_eq!(info.id, "room-id");
            assert_eq!(info.name, "A room");
            assert_eq!(info.kind, "p");
            assert_eq!(info.topic.as_deref(), Some("Sujet 🚀"));
            assert_eq!(info.members, Some(1));
            assert!(info.read_only);
            assert!(session.supported_features().iter().any(|f| f == "room_info"));
        } else {
            let expected = match scenario {
                "unsupported" => "unsupported_feature",
                "foreign" => "invalid_room_details",
                "removed" => "delivery_revalidate",
                "closed" => "session_closed",
                _ => "server_identity_changed",
            };
            assert_eq!(result.unwrap_err().code(), expected);
        }
        common::close_native(session).await;
        assert!(
            server.requests().iter().all(|r| r.path() == "/.well-known/rocketvibe" || r.path().starts_with("/api/v1/"))
        );
        std::fs::remove_file(path).unwrap();
    }
}
