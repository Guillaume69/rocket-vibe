mod common;
use common::{FakeHttp, respond};
use rv_core::{
    native::{Identity, NativeSession, store::NativeStore},
    session::{Connection, SessionInfo},
};
use rv_protocol::{Snapshot, parity::ReadState};
use serde_json::{Value, json};
use std::{
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
fn snapshot() -> Snapshot {
    let mut room: rv_protocol::Room = serde_json::from_value(fixture()["room"].clone()).unwrap();
    room.read_state = Some(Box::new(ReadState {
        room_id: room.id.clone(),
        revision: "10".into(),
        favorite_revision: Some("9".into()),
        membership_version: Some("membership".into()),
        root_position: "0".into(),
        reply_position: "0".into(),
        unread_roots: "2".into(),
        unread_replies: "0".into(),
        mentions: "0".into(),
        group_mentions: "0".into(),
        favorite: false,
    }));
    let mut message: rv_protocol::Message = serde_json::from_value(fixture()["message"].clone()).unwrap();
    message.id = "observed".into();
    message.position = "9007199254740993".into();
    let mut newest = message.clone();
    newest.id = "newest".into();
    newest.position = "9007199254740994".into();
    Snapshot { protocol_version: 1, rooms: vec![room], messages: vec![message, newest], cursor: "initial".into() }
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
fn routine(request: &common::Request) -> common::Response {
    let data = fixture();
    match request.path() {
        "/.well-known/rocketvibe" => {
            let mut discovery = data["discovery"].clone();
            for key in ["read_markers", "favorites"] {
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
async fn wait_until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
fn path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("rv-reads-runner-{:032x}.sqlite", fastrand::u128(..)))
}

#[tokio::test]
async fn lost_http_acks_recover_original_reads_and_favorites_after_disk_reopen() {
    let favorite_writes = Arc::new(AtomicUsize::new(0));
    let favorite_count = favorite_writes.clone();
    let read_writes = Arc::new(AtomicUsize::new(0));
    let read_count = read_writes.clone();
    let current = Arc::new(Mutex::new(*snapshot().rooms[0].read_state.clone().unwrap()));
    let state = current.clone();
    let file = path();
    let store = NativeStore::open(&file, identity()).unwrap();
    store.snapshot(&snapshot()).unwrap();
    store.stage_read("room-id", "observed").unwrap();
    let saved = store.stage_favorite("room-id", true).unwrap().unwrap();
    let original_id = saved.input.operation_id;
    drop(store);
    let server = FakeHttp::start(move |request| {
        if request.path() == format!("/api/v1/rooms/room-id/commands/{original_id}") {
            return if favorite_count.load(Ordering::SeqCst) > 0 {
                respond(
                    200,
                    &json!({"operation_id":original_id,"room_id":"room-id","applied_revision":"12"}).to_string(),
                )
            } else {
                routine(request)
            };
        }
        if request.path() == "/api/v1/rooms/room-id/favorite" {
            let input: Value = serde_json::from_str(&request.body).unwrap();
            assert_eq!(input, json!({"operation_id":original_id,"expected_revision":"9","present":true}));
            favorite_count.fetch_add(1, Ordering::SeqCst);
            let mut state = state.lock().unwrap();
            state.favorite = true;
            state.favorite_revision = Some("12".into());
            state.revision = "12".into();
            return common::dropped();
        }
        if request.path() == "/api/v1/rooms/room-id/read" {
            let mut state = state.lock().unwrap();
            if request.method == "POST" {
                let input: Value = serde_json::from_str(&request.body).unwrap();
                assert_eq!(input, json!({"root_position":"9007199254740993","reply_position":"0"}));
                read_count.fetch_add(1, Ordering::SeqCst);
                state.root_position = "9007199254740993".into();
                state.revision = "13".into();
                return common::dropped();
            }
            return respond(200, &serde_json::to_string(&*state).unwrap());
        }
        routine(request)
    })
    .await;
    let first = NativeSession::start(account(&server), &file).unwrap();
    wait_until(|| first.status().connection == Connection::Online).await;
    assert_eq!(first.store.pending_reads().unwrap().len(), 1);
    assert_eq!(first.store.pending_favorites().unwrap().len(), 1);
    common::close_native(first).await;
    {
        let mut state = current.lock().unwrap();
        state.favorite = false;
        state.favorite_revision = Some("14".into());
        state.revision = "14".into();
    }
    let second = NativeSession::start(account(&server), &file).unwrap();
    wait_until(|| second.status().connection == Connection::Online).await;
    assert!(second.store.pending_reads().unwrap().is_empty());
    assert!(second.store.pending_favorites().unwrap().is_empty());
    assert!(!second.store.read_state("room-id").unwrap().unwrap().favorite);
    assert_eq!(favorite_writes.load(Ordering::SeqCst), 1);
    assert_eq!(read_writes.load(Ordering::SeqCst), 1);
    common::close_native(second).await;
    std::fs::remove_file(file).unwrap();
}

#[tokio::test]
async fn read_quota_keeps_socket_healthy_while_favorites_and_messages_still_apply() {
    let read_writes = Arc::new(AtomicUsize::new(0));
    let read_count = read_writes.clone();
    let favorite_writes = Arc::new(AtomicUsize::new(0));
    let favorite_count = favorite_writes.clone();
    let sends = Arc::new(AtomicUsize::new(0));
    let send_count = sends.clone();
    let current = Arc::new(Mutex::new(*snapshot().rooms[0].read_state.clone().unwrap()));
    let state = current.clone();
    let server = FakeHttp::start(move |request| {
        if request.path() == "/api/v1/rooms/room-id/read" {
            if request.method == "POST" {
                read_count.fetch_add(1, Ordering::SeqCst);
                let mut response = respond(429, r#"{"code":"rate_limited","request_id":"quota"}"#);
                response.headers.push(("retry-after".into(), "60".into()));
                return response;
            }
            return respond(200, &serde_json::to_string(&*state.lock().unwrap()).unwrap());
        }
        if request.path() == "/api/v1/rooms/room-id/favorite" {
            let input: Value = serde_json::from_str(&request.body).unwrap();
            favorite_count.fetch_add(1, Ordering::SeqCst);
            let mut state = state.lock().unwrap();
            state.favorite = true;
            state.favorite_revision = Some("20".into());
            state.revision = "20".into();
            return respond(
                200,
                &json!({"operation_id":input["operation_id"],"room_id":"room-id","applied_revision":"20"}).to_string(),
            );
        }
        if request.path() == "/api/v1/rooms/room-id/messages" {
            send_count.fetch_add(1, Ordering::SeqCst);
            let input: Value = serde_json::from_str(&request.body).unwrap();
            let mut message = fixture()["message"].clone();
            message["id"] = input["operation_id"].clone();
            message["text"] = input["text"].clone();
            message["position"] = json!("9007199254740995");
            message["revision"] = json!("21");
            return respond(200, &message.to_string());
        }
        routine(request)
    })
    .await;
    let file = path();
    let store = NativeStore::open(&file, identity()).unwrap();
    store.snapshot(&snapshot()).unwrap();
    drop(store);
    let session = NativeSession::start(account(&server), &file).unwrap();
    wait_until(|| session.status().connection == Connection::Online).await;
    assert!(session.mark_observed_read("room-id", "observed").unwrap());
    wait_until(|| read_writes.load(Ordering::SeqCst) == 1).await;
    assert!(session.mark_observed_read("room-id", "newest").unwrap());
    session.set_favorite("room-id", true).unwrap();
    session.send("room-id", "Quota leaves messages available").unwrap();
    wait_until(|| {
        favorite_writes.load(Ordering::SeqCst) == 1
            && sends.load(Ordering::SeqCst) == 1
            && session.store.pending().unwrap().is_empty()
            && session.store.pending_favorites().unwrap().is_empty()
    })
    .await;
    assert_eq!(read_writes.load(Ordering::SeqCst), 1);
    assert_eq!(session.status().connection, Connection::Online);
    assert_eq!(session.store.pending_reads().unwrap()[0].root_position, "9007199254740994");
    common::close_native(session).await;
    std::fs::remove_file(file).unwrap();
}

#[tokio::test]
async fn confirmed_favorite_waits_for_current_state_across_restart_without_repeating_put() {
    let writes = Arc::new(AtomicUsize::new(0));
    let count = writes.clone();
    let available = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let allow = available.clone();
    let server = FakeHttp::start(move |request| {
        if request.path() == "/api/v1/rooms/room-id/favorite" {
            count.fetch_add(1, Ordering::SeqCst);
            let input: Value = serde_json::from_str(&request.body).unwrap();
            return respond(
                200,
                &json!({"operation_id":input["operation_id"],"room_id":"room-id","applied_revision":"12"}).to_string(),
            );
        }
        if request.path() == "/api/v1/rooms/room-id/read" {
            if !allow.load(Ordering::SeqCst) {
                return respond(503, r#"{"code":"temporarily_unavailable","request_id":"fixture"}"#);
            }
            let mut state = *snapshot().rooms[0].read_state.clone().unwrap();
            state.revision = "14".into();
            state.favorite_revision = Some("14".into());
            return respond(200, &serde_json::to_string(&state).unwrap());
        }
        routine(request)
    })
    .await;
    let file = path();
    let store = NativeStore::open(&file, identity()).unwrap();
    store.snapshot(&snapshot()).unwrap();
    store.stage_favorite("room-id", true).unwrap();
    drop(store);
    let first = NativeSession::start(account(&server), &file).unwrap();
    wait_until(|| first.status().connection == Connection::Online).await;
    assert_eq!(first.store.favorite_intent("room-id").unwrap().unwrap().phase, "confirmed");
    common::close_native(first).await;
    available.store(true, Ordering::SeqCst);
    let second = NativeSession::start(account(&server), &file).unwrap();
    wait_until(|| second.status().connection == Connection::Online).await;
    assert!(second.store.pending_favorites().unwrap().is_empty());
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert_eq!(server.requests().iter().filter(|r| r.path().contains("/commands/")).count(), 1);
    common::close_native(second).await;
    std::fs::remove_file(file).unwrap();
}

#[tokio::test]
async fn favorite_runner_fences_foreign_receipts_and_missed_rejoin_before_any_put() {
    for scenario in ["foreign", "rejoin", "conflict"] {
        let holder: Arc<Mutex<Option<std::sync::Weak<NativeSession>>>> = Arc::default();
        let owner = holder.clone();
        let receipts = Arc::new(AtomicUsize::new(0));
        let reads = receipts.clone();
        let puts = Arc::new(AtomicUsize::new(0));
        let writes = puts.clone();
        let server=FakeHttp::start(move|request| {
            if request.path().starts_with("/api/v1/rooms/room-id/commands/") {
                reads.fetch_add(1,Ordering::SeqCst);
                if scenario=="foreign" {return respond(200,&json!({"operation_id":request.path().rsplit('/').next().unwrap(),"room_id":"another-room","applied_revision":"12"}).to_string());}
                if scenario=="rejoin" {let mut next=snapshot();next.rooms[0].read_state.as_mut().unwrap().membership_version=Some("new-membership".into());next.rooms[0].read_state.as_mut().unwrap().revision="20".into();owner.lock().unwrap().as_ref().unwrap().upgrade().unwrap().store.snapshot(&next).unwrap();}
                return routine(request);
            }
            if request.path()=="/api/v1/rooms/room-id/favorite" {writes.fetch_add(1,Ordering::SeqCst);return respond(409,r#"{"code":"revision_conflict","request_id":"fixture"}"#);}
            routine(request)
        }).await;
        let file = path();
        let store = NativeStore::open(&file, identity()).unwrap();
        store.snapshot(&snapshot()).unwrap();
        drop(store);
        let session = NativeSession::start(account(&server), &file).unwrap();
        *holder.lock().unwrap() = Some(Arc::downgrade(&session));
        wait_until(|| session.status().connection == Connection::Online).await;
        session.set_favorite("room-id", true).unwrap();
        wait_until(|| {
            receipts.load(Ordering::SeqCst) > 0
                && if scenario == "rejoin" {
                    session.store.favorite_intent("room-id").unwrap().is_none()
                } else if scenario == "conflict" {
                    session.store.favorite_intent("room-id").unwrap().is_some_and(|s| s.phase == "failed")
                } else {
                    server.requests().iter().filter(|r| r.path() == "/.well-known/rocketvibe").count() >= 3
                }
        })
        .await;
        assert_eq!(puts.load(Ordering::SeqCst), usize::from(scenario == "conflict"));
        if scenario == "foreign" {
            assert_eq!(session.store.favorite_intent("room-id").unwrap().unwrap().phase, "pending");
        }
        if scenario == "conflict" {
            let saved = session.store.favorite_intent("room-id").unwrap().unwrap();
            assert_eq!(saved.input.expected_revision, "9");
            assert!(!session.dismiss_failed_favorite("room-id", "wrong-id").unwrap());
            assert!(session.dismiss_failed_favorite("room-id", &saved.input.operation_id).unwrap());
        }
        assert!(!session.store.read_state("room-id").unwrap().unwrap().favorite);
        common::close_native(session).await;
        std::fs::remove_file(file).unwrap();
    }
}
