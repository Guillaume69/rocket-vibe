mod common;
use common::{FakeHttp, respond};
use rv_core::{
    native::{
        Identity, NativeSession,
        store::{NativeStore, RoomOperation},
    },
    session::{Connection, SessionInfo},
};
use rv_protocol::parity::{ChangeRoomRole, LeaveRoom, UpdateRoom};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

fn identity() -> Identity {
    Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }
}
fn account(server: &FakeHttp) -> SessionInfo {
    SessionInfo {
        base_url: server.url.to_string(),
        user_id: "alice-id".into(),
        username: "alice".into(),
        auth_token: "fixture-token".into(),
        native: Some(identity()),
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap()
}
fn seed(path: &std::path::Path) -> NativeStore {
    let store = NativeStore::open(path, identity()).unwrap();
    store
        .snapshot(&rv_protocol::Snapshot {
            protocol_version: 1,
            rooms: vec![serde_json::from_value(fixture()["room"].clone()).unwrap()],
            messages: vec![],
            cursor: "initial".into(),
        })
        .unwrap();
    store
}
fn routine(request: &common::Request, data: &Value) -> common::Response {
    match request.path() {
        "/.well-known/rocketvibe" => {
            let mut discovery = data["discovery"].clone();
            for key in ["room_info", "room_settings", "room_roles", "room_leave"] {
                discovery["capabilities"][key] = json!(true);
            }
            respond(200, &discovery.to_string())
        }
        "/api/v1/me" => respond(200, &data["session"]["user"].to_string()),
        "/api/v1/sync/changes" => {
            respond(200, &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string())
        }
        "/api/v1/sync/ticket" => respond(200, &data["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => common::Response { websocket: true, ..Default::default() },
        _ => respond(404, r#"{"code":"not_found","request_id":"fixture"}"#),
    }
}
async fn online(session: &NativeSession) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
fn update() -> UpdateRoom {
    UpdateRoom {
        operation_id: "original".into(),
        expected_revision: "original-revision".into(),
        name: "Room".into(),
        private: true,
        topic: "Private subject".into(),
        description: String::new(),
        announcement: String::new(),
        read_only: false,
    }
}

#[tokio::test]
async fn all_room_commands_recover_a_lost_acknowledgement_from_disk_without_reapplying() {
    for kind in ["settings", "role", "leave"] {
        let owner: Arc<Mutex<Option<Weak<NativeSession>>>> = Arc::default();
        let callback = owner.clone();
        let applied = Arc::new(AtomicUsize::new(0));
        let count = applied.clone();
        let data = fixture();
        let server = FakeHttp::start(move |request| {
            if request.path() == "/api/v1/rooms/room-id/commands/original" {
                return if count.load(Ordering::SeqCst) == 0 {
                    respond(404, r#"{"code":"not_found","request_id":"fixture"}"#)
                } else {
                    respond(
                        200,
                        &json!({"operation_id":"original","room_id":"room-id","applied_revision":"applied"})
                            .to_string(),
                    )
                };
            }
            if request.method != "GET" && request.path().starts_with("/api/v1/rooms/room-id") {
                let input: Value = serde_json::from_str(&request.body).unwrap();
                assert_eq!(input["operation_id"], "original");
                assert_eq!(input["expected_revision"], "original-revision");
                assert_eq!(
                    request.method,
                    if kind == "settings" {
                        "PATCH"
                    } else if kind == "role" {
                        "PUT"
                    } else {
                        "POST"
                    }
                );
                count.fetch_add(1, Ordering::SeqCst);
                callback.lock().unwrap().as_ref().unwrap().upgrade().unwrap().suspend();
                return common::dropped();
            }
            routine(request, &data)
        })
        .await;
        let path = std::env::temp_dir().join(format!("rv-room-lost-{:032x}.sqlite", fastrand::u128(..)));
        let store = seed(&path);
        let command = match kind {
            "settings" => RoomOperation::Settings { input: update() },
            "role" => RoomOperation::Role {
                target: "alice-id".into(),
                input: ChangeRoomRole {
                    operation_id: "original".into(),
                    expected_revision: "original-revision".into(),
                    role: rv_protocol::parity::RoomRole::Member,
                },
            },
            _ => RoomOperation::Leave {
                input: LeaveRoom { operation_id: "original".into(), expected_revision: "original-revision".into() },
            },
        };
        store.stage_room_operation("room-id", command).unwrap().unwrap();
        drop(store);
        let first = NativeSession::start(account(&server), &path).unwrap();
        *owner.lock().unwrap() = Some(Arc::downgrade(&first));
        tokio::time::timeout(Duration::from_secs(5), async {
            while applied.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(first.store.pending_room_operations().unwrap().len(), 1);
        common::close_native(first).await;
        let second = NativeSession::start(account(&server), &path).unwrap();
        *owner.lock().unwrap() = Some(Arc::downgrade(&second));
        online(&second).await;
        assert!(second.store.pending_room_operations().unwrap().is_empty());
        assert_eq!(applied.load(Ordering::SeqCst), 1);
        let requests = server.requests();
        let relevant: Vec<_> = requests.iter().filter(|r| r.path().starts_with("/api/v1/rooms/")).collect();
        assert_eq!(relevant.len(), 3);
        assert_eq!(relevant[0].method, "GET");
        assert_eq!(relevant[2].method, "GET");
        common::close_native(second).await;
        std::fs::remove_file(path).unwrap();
    }
}

#[tokio::test]
async fn room_runner_does_not_mutate_on_ambiguous_receipts_or_lifetime_changes() {
    for scenario in ["conflict", "receipt_error", "foreign", "withdrawn", "closed", "epoch"] {
        let owner: Arc<Mutex<Option<Weak<NativeSession>>>> = Arc::default();
        let callback = owner.clone();
        let changed = Arc::new(AtomicBool::new(false));
        let epoch = changed.clone();
        let data = fixture();
        let server=FakeHttp::start(move|request|{
            if request.path()=="/.well-known/rocketvibe" && epoch.load(Ordering::SeqCst){let mut response=routine(request,&data);let mut discovery:Value=serde_json::from_str(&response.body).unwrap();discovery["data_epoch"]=json!("replacement");response.body=discovery.to_string();return response;}
            if request.path()=="/api/v1/rooms/room-id/commands/original" {
                let session=callback.lock().unwrap().as_ref().unwrap().upgrade().unwrap();
                match scenario {
                    "withdrawn"=>session.store.batch(&rv_protocol::SyncBatch{protocol_version:1,changes:vec![rv_protocol::Change::RoomRemoved{room_id:"room-id".into()}],cursor:"removed".into(),has_more:false}).unwrap(),
                    "closed"=>session.shutdown(),"epoch"=>epoch.store(true,Ordering::SeqCst),_=>(),
                }
                return match scenario {
                    "foreign"|"epoch"=>respond(200,&json!({"operation_id":"original","room_id":if scenario=="foreign" {"other"}else{"room-id"},"applied_revision":"applied"}).to_string()),
                    "receipt_error"=>respond(404,r#"{"code":"receipt_hidden","request_id":"fixture"}"#),
                    _=>respond(404,r#"{"code":"not_found","request_id":"fixture"}"#),
                };
            }
            if request.method=="PATCH" {return respond(409,r#"{"code":"revision_conflict","request_id":"fixture"}"#);}
            routine(request,&data)
        }).await;
        let path = std::env::temp_dir().join(format!("rv-room-guard-{:032x}.sqlite", fastrand::u128(..)));
        drop(seed(&path));
        let session = NativeSession::start(account(&server), &path).unwrap();
        *owner.lock().unwrap() = Some(Arc::downgrade(&session));
        online(&session).await;
        let result = session.update_room("room-id", update()).await;
        if scenario == "withdrawn" {
            assert!(result.is_ok());
            assert!(session.store.room_operation("room-id").unwrap().is_none());
        } else {
            let error = result.unwrap_err();
            assert_eq!(
                error.code(),
                match scenario {
                    "conflict" => "revision_conflict",
                    "receipt_error" => "receipt_hidden",
                    "foreign" => "invalid_room_receipt",
                    "closed" => "session_closed",
                    _ => "server_identity_changed",
                }
            );
            assert_eq!(
                session.store.room_operation("room-id").unwrap().unwrap().failed,
                matches!(scenario, "conflict" | "receipt_error")
            );
        }
        assert_eq!(
            server.requests().iter().filter(|r| r.method == "PATCH").count(),
            usize::from(scenario == "conflict")
        );
        common::close_native(session).await;
        std::fs::remove_file(path).unwrap();
    }
}
