mod common;
use common::{FakeHttp, Response, respond};
use rv_core::native::notification_navigation::NavigationQueue;
use rv_core::native::{Identity, NativeSession, notifications, store::NativeStore};
use rv_protocol::{Change, Message, Room, Snapshot, SyncBatch};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap()
}
fn room() -> Room {
    let mut r: Room = serde_json::from_value(fixture()["room"].clone()).unwrap();
    r.read_state=Some(Box::new(serde_json::from_value(json!({"room_id":r.id,"membership_version":"1","revision":"1","root_position":"0","reply_position":"0","unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false})).unwrap()));
    r
}
fn message(id: &str, position: &str) -> Message {
    let mut m: Message = serde_json::from_value(fixture()["message"].clone()).unwrap();
    m.id = id.into();
    m.position = position.into();
    m.revision = position.into();
    m.personal_mention = Some(true);
    m
}
fn batch(messages: Vec<Message>) -> SyncBatch {
    SyncBatch {
        protocol_version: 1,
        changes: messages.into_iter().map(Change::MessageUpsert).collect(),
        cursor: "next".into(),
        has_more: false,
    }
}
fn store() -> NativeStore {
    let s = NativeStore::open(
        Path::new(":memory:"),
        Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() },
    )
    .unwrap();
    s.snapshot(&Snapshot { protocol_version: 1, rooms: vec![room()], messages: vec![], cursor: "initial".into() })
        .unwrap();
    s
}
#[test]
fn live_candidates_skip_history_replay_edits_self_and_failed_transactions() {
    let s = store();
    s.batch(&batch(vec![message("history", "2")])).unwrap();
    assert!(s.batch_notifying(&batch(vec![message("history", "2")]), Some("bob")).unwrap().is_empty());
    let mut edited = message("edited", "3");
    edited.revision = "4".into();
    let mut own = message("own", "5");
    own.author.id = "bob".into();
    assert!(s.batch_notifying(&batch(vec![edited, own]), Some("bob")).unwrap().is_empty());
    let live = batch(vec![message("live", "9007199254740994")]);
    let notices = s.batch_notifying(&live, Some("bob")).unwrap();
    assert_eq!(notices.len(), 1);
    assert!(notices[0].incoming.mentions_me);
    assert!(s.batch_notifying(&live, Some("bob")).unwrap().is_empty());
    let mut invalid = message("bad", "9007199254740995");
    invalid.created_at = "bad date".into();
    let cursor = s.cursor().unwrap();
    assert!(s.batch_notifying(&batch(vec![message("rolled-back", "9007199254740995"), invalid]), Some("bob")).is_err());
    assert_eq!(s.cursor().unwrap(), cursor);
    assert_eq!(
        s.batch_notifying(&batch(vec![message("rolled-back", "9007199254740995")]), Some("bob")).unwrap().len(),
        1
    );
}
#[test]
fn read_delete_and_membership_replacement_invalidate_queued_notices() {
    let s = store();
    let notices = s.batch_notifying(&batch(vec![message("live", "2")]), Some("bob")).unwrap();
    let n = &notices[0];
    assert!(s.notification_valid(n, true).unwrap());
    let mut r = room();
    r.read_state.as_mut().unwrap().root_position = "2".into();
    r.read_state.as_mut().unwrap().revision = "3".into();
    s.batch(&SyncBatch {
        protocol_version: 1,
        changes: vec![Change::RoomUpsert(r.clone())],
        cursor: "read".into(),
        has_more: false,
    })
    .unwrap();
    assert!(!s.notification_valid(n, true).unwrap());
    assert!(s.notification_valid(n, false).unwrap());
    r.read_state.as_mut().unwrap().membership_version = Some("after".into());
    r.read_state.as_mut().unwrap().revision = "4".into();
    s.snapshot(&Snapshot {
        protocol_version: 1,
        rooms: vec![r],
        messages: vec![message("live", "2")],
        cursor: "rejoined".into(),
    })
    .unwrap();
    assert!(!s.notification_valid(n, false).unwrap());
    let fresh = s.batch_notifying(&batch(vec![message("fresh", "4")]), Some("bob")).unwrap();
    let mut deleted = message("fresh", "4");
    deleted.revision = "5".into();
    deleted.deleted = true;
    deleted.text.clear();
    s.batch(&batch(vec![deleted])).unwrap();
    assert!(!s.notification_valid(&fresh[0], false).unwrap());
}
#[tokio::test]
async fn actual_live_socket_emits_once_and_scopes_persisted_notification_replies() {
    let f = fixture();
    let mut live = message("live", "2");
    live.personal_mention = Some(false);
    let resolved_live = live.clone();
    let direct = {
        let mut r = room();
        r.kind = rv_protocol::RoomKind::Direct;
        r
    };
    let socket_batch = batch(vec![live]);
    let wire = serde_json::to_value(&socket_batch).unwrap();
    let responses = f.clone();
    let server = FakeHttp::start(move |req| match req.path() {
        "/.well-known/rocketvibe" => respond(200, &responses["discovery"].to_string()),
        "/api/v1/me" => respond(200, &json!({"id":"bob","username":"bob","display_name":"Bob"}).to_string()),
        "/api/v1/sync/changes" => {
            respond(200, &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string())
        }
        "/api/v1/sync/ticket" => respond(200, &responses["socket_ticket"].to_string()),
        "/api/v1/messages/live" => {
            assert_eq!(req.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
            respond(200, &serde_json::to_string(&resolved_live).unwrap())
        }
        "/api/v1/sync/socket" => {
            Response { websocket: true, websocket_frames: vec![wire.clone(), wire.clone()], ..Default::default() }
        }
        _ => respond(404, r#"{"code":"not_found"}"#),
    })
    .await;
    let path = std::env::temp_dir().join(format!("rv-notify-{:032x}.sqlite", fastrand::u128(..)));
    let identity = Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() };
    let cache = NativeStore::open(&path, identity.clone()).unwrap();
    cache
        .snapshot(&Snapshot { protocol_version: 1, rooms: vec![direct], messages: vec![], cursor: "initial".into() })
        .unwrap();
    drop(cache);
    let info = rv_core::session::SessionInfo {
        base_url: server.url.to_string(),
        user_id: "bob".into(),
        username: "bob".into(),
        auth_token: "fixture-token".into(),
        native: Some(identity),
    };
    let s = NativeSession::start(info.clone(), &path).unwrap();
    let mut incoming = s.incoming();
    let n = tokio::time::timeout(Duration::from_secs(5), incoming.recv()).await.unwrap().unwrap();
    assert!(n.direct);
    assert!(!n.mentions_me);
    assert!(s.notification_current(&n));
    assert!(incoming.try_recv().is_err());
    let key = s.notification_key(&n.rid);
    common::close_native(s).await;
    let s = NativeSession::start(info, &path).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while s.status().connection != rv_core::session::Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(s.resolve_notification(&key, &n.id).await.unwrap().message.as_deref(), Some("live"));
    s.suspend();
    assert!(s.notification_target(&key, &n.id).is_some());
    assert!(s.notification_target("rv-native:foreign:room-id", &n.id).is_none());
    let operation = s.reply_notification(&key, &n.id, "exact response").unwrap();
    assert!(s.store.pending().unwrap().is_empty());
    let pending = s.store.pending_notification_replies().unwrap();
    assert_eq!(pending[0].pending.id, operation);
    assert_eq!(pending[0].pending.text, "exact response");
    s.shutdown();
    assert!(s.reply_notification(&key, &n.id, "late").is_err());
    common::close_native(s).await;
    std::fs::remove_file(path).unwrap();
}

fn offline_reply(info: &rv_core::session::SessionInfo, path: &Path) -> String {
    let cache = NativeStore::open(path, info.native.clone().unwrap()).unwrap();
    cache
        .snapshot(&Snapshot { protocol_version: 1, rooms: vec![room()], messages: vec![], cursor: "initial".into() })
        .unwrap();
    let mut target = message("offline-target", "2");
    target.reply_to = Some("offline-root".into());
    let notices = cache.batch_notifying(&batch(vec![target]), Some("bob")).unwrap();
    assert!(cache.remember_notification(&notices[0]).unwrap());
    let key = notifications::notification_key(info, &room().id);
    drop(cache);
    let id =
        notifications::save_notification_reply(info, path, &key, "offline-target", "  offline exact reply  ").unwrap();
    assert_eq!(
        notifications::save_notification_reply(info, path, &key, "offline-target", "offline exact reply").unwrap(),
        id
    );
    let cache = NativeStore::open(path, info.native.clone().unwrap()).unwrap();
    assert!(cache.pending().unwrap().is_empty());
    assert_eq!(cache.pending_notification_replies().unwrap().len(), 1);
    assert!(cache.selected_messages(&["offline-root".into()]).unwrap().is_empty());
    cache.retry(&id).unwrap();
    assert!(cache.pending().unwrap().is_empty(), "manual retry must not bypass private validation");
    // Reading or disabling the alert can remove the OS ledger independently
    // of an explicit response that was already accepted durably.
    cache.forget_notification("offline-target").unwrap();
    assert_eq!(cache.pending_notification_replies().unwrap().len(), 1);
    id
}

fn reply_info(server: &FakeHttp) -> rv_core::session::SessionInfo {
    rv_core::session::SessionInfo {
        base_url: server.url.to_string(),
        user_id: "bob".into(),
        username: "bob".into(),
        auth_token: "fixture-token".into(),
        native: Some(Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }),
    }
}

#[test]
fn notification_navigation_reopens_and_fences_slow_capture_old_ack_and_cancellation() {
    let config = std::env::temp_dir().join(format!("rv-navigation-{:032x}", fastrand::u128(..)));
    let queue = NavigationQueue::new(&config);
    let cache = store();
    let info = rv_core::session::SessionInfo {
        base_url: "http://127.0.0.1:9".into(),
        user_id: "bob".into(),
        username: "bob".into(),
        auth_token: "private-fixture-bearer".into(),
        native: Some(Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }),
    };
    let notices = cache.batch_notifying(&batch(vec![message("target", "9007199254740994")]), Some("bob")).unwrap();
    assert!(cache.remember_notification(&notices[0]).unwrap());
    let key = notifications::notification_key(&info, &room().id);
    let first = queue.begin().unwrap();
    assert!(queue.pending().unwrap().is_none(), "a reservation cannot navigate before capture");
    assert!(queue.capture(&first, &info, &cache, &key, "target").unwrap());
    let queue = NavigationQueue::new(&config);
    assert_eq!(queue.pending().unwrap().unwrap().id, first);
    let conn = rusqlite::Connection::open(config.join("notification-navigation.sqlite")).unwrap();
    let payload: String = conn.query_row("SELECT payload FROM navigation", [], |r| r.get(0)).unwrap();
    let record: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(record["position"], "9007199254740994");
    assert_eq!(record.as_object().unwrap().len(), 7);
    assert!(!payload.contains(&info.auth_token));
    assert!(!payload.contains("body"));
    assert!(!payload.contains("author"));
    let second = queue.begin().unwrap();
    assert!(!queue.capture(&first, &info, &cache, &key, "target").unwrap());
    assert!(queue.capture(&second, &info, &cache, &key, "target").unwrap());
    assert!(!queue.clear(&first).unwrap(), "old completion must not erase a new click");
    assert_eq!(queue.pending().unwrap().unwrap().id, second);
    queue.cancel().unwrap();
    assert!(
        !queue.capture(&second, &info, &cache, &key, "target").unwrap(),
        "late callback cannot revive a cancelled navigation"
    );
    let third = queue.begin().unwrap();
    let mut wrong = info.clone();
    wrong.user_id = "other-account".into();
    assert!(queue.capture(&third, &wrong, &cache, &key, "target").is_err());
    let mut restored = info.clone();
    restored.native.as_mut().unwrap().data_epoch = "restored".into();
    assert!(
        queue
            .capture(&third, &restored, &cache, &notifications::notification_key(&restored, &room().id), "target")
            .is_err()
    );
    assert!(queue.capture(&third, &info, &cache, &key, "target").unwrap());
    conn.execute("UPDATE navigation SET payload=?1", ["{".repeat(9000)]).unwrap();
    assert!(queue.pending().is_err(), "oversized or malformed metadata never becomes a fallback room link");
    assert!(queue.clear(&third).unwrap());
    drop(conn);
    std::fs::remove_dir_all(config).unwrap();
}

#[tokio::test]
async fn durable_notification_click_revalidates_after_restart_and_keeps_only_transient_failures() {
    for scenario in
        ["normal", "transient", "deleted", "root-deleted", "rejoined", "restored", "superseded", "cancelled"]
    {
        let config = std::env::temp_dir().join(format!("rv-navigation-http-{:032x}", fastrand::u128(..)));
        let queue = NavigationQueue::new(&config);
        let path = config.join("native.sqlite");
        let f = fixture();
        let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fail_once = failed.clone();
        let superseding = queue.clone();
        let late_info = Arc::new(Mutex::new(None::<rv_core::session::SessionInfo>));
        let capture_info = late_info.clone();
        let capture_path = path.clone();
        let server = FakeHttp::start(move |req| match req.path() {
            "/.well-known/rocketvibe" => {
                let mut discovery = f["discovery"].clone();
                if scenario == "restored" { discovery["data_epoch"] = json!("restored"); }
                respond(200, &discovery.to_string())
            }
            "/api/v1/me" => respond(200, &json!({"id":"bob","username":"bob","display_name":"Bob"}).to_string()),
            "/api/v1/sync/changes" => {
                let mut r = room();
                r.read_state.as_mut().unwrap().membership_version = Some("new-grant".into());
                r.read_state.as_mut().unwrap().revision = "10".into();
                respond(200, &json!({"protocol_version":1,"changes":if scenario=="rejoined" {vec![Change::RoomUpsert(r)]} else {vec![]},"cursor":"next","has_more":false}).to_string())
            }
            "/api/v1/sync/ticket" => respond(200, &f["socket_ticket"].to_string()),
            "/api/v1/sync/socket" => Response { websocket:true, ..Default::default() },
            "/api/v1/messages/target" => {
                assert_eq!(req.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
                if scenario=="transient" && !fail_once.swap(true,std::sync::atomic::Ordering::SeqCst) { return respond(503,r#"{"code":"temporarily_unavailable"}"#) }
                if scenario=="superseded" {
                    let info = capture_info.lock().unwrap().clone().unwrap();
                    let id = superseding.begin().unwrap();
                    assert!(superseding.capture_saved(&id,&info,&capture_path,&notifications::notification_key(&info,&room().id),"next-target").unwrap());
                }
                if scenario=="cancelled" { superseding.cancel().unwrap(); }
                let mut target = message("target", "2");
                target.reply_to = Some("root".into());
                if scenario=="deleted" { target.deleted=true; target.text.clear(); target.body=None; }
                respond(200,&serde_json::to_string(&target).unwrap())
            }
            "/api/v1/messages/root" => {
                let mut root = message("root","1");
                if scenario=="root-deleted" { root.deleted=true; root.text.clear(); root.body=None; }
                respond(200,&serde_json::to_string(&root).unwrap())
            }
            _ => respond(404,r#"{"code":"not_found"}"#),
        }).await;
        let info = reply_info(&server);
        *late_info.lock().unwrap() = Some(info.clone());
        let id = queue.begin().unwrap();
        let cache = NativeStore::open(&path, info.native.clone().unwrap()).unwrap();
        cache
            .snapshot(&Snapshot {
                protocol_version: 1,
                rooms: vec![room()],
                messages: vec![],
                cursor: "initial".into(),
            })
            .unwrap();
        let mut target = message("target", "2");
        target.reply_to = Some("root".into());
        for n in cache.batch_notifying(&batch(vec![target, message("next-target", "3")]), Some("bob")).unwrap() {
            assert!(cache.remember_notification(&n).unwrap());
        }
        drop(cache);
        let key = notifications::notification_key(&info, &room().id);
        assert!(queue.capture_saved(&id, &info, &path, &key, "target").unwrap());
        let cache = NativeStore::open(&path, info.native.clone().unwrap()).unwrap();
        cache.forget_notification("target").unwrap();
        // A bounded catch-up snapshot may no longer contain either target or root.
        cache
            .snapshot(&Snapshot {
                protocol_version: 1,
                rooms: vec![room()],
                messages: vec![],
                cursor: "initial".into(),
            })
            .unwrap();
        drop(cache);
        assert!(server.requests().is_empty(), "capturing a click must not require network access");
        let mut session = NativeSession::start(info.clone(), &path).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !session.is_closed() && session.status().connection != rv_core::session::Connection::Online {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let queue = NavigationQueue::new(&config);
        if scenario == "transient" {
            assert!(session.resolve_notification_navigation(&queue, &id).await.is_err());
            assert!(queue.current(&id).unwrap());
            common::close_native(session).await;
            session = NativeSession::start(info, &path).unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while session.status().connection != rv_core::session::Connection::Online {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
        let resolved = session.resolve_notification_navigation(&queue, &id).await;
        if matches!(scenario, "normal" | "transient") {
            let link = resolved.unwrap();
            assert_eq!(link.message.as_deref(), Some("target"));
            assert_eq!(link.root.as_deref(), Some("root"));
            assert!(queue.current(&id).unwrap(), "only the UI opening the destination acknowledges it");
            assert!(queue.clear(&id).unwrap());
        } else {
            assert!(resolved.is_err(), "{scenario}");
            assert!(!queue.current(&id).unwrap(), "{scenario}");
            if scenario == "superseded" {
                assert_eq!(queue.pending().unwrap().unwrap().message, "next-target");
                assert!(!queue.clear(&id).unwrap());
            } else {
                assert!(queue.pending().unwrap().is_none(), "{scenario}");
            }
        }
        common::close_native(session).await;
        drop(queue);
        std::fs::remove_dir_all(config).unwrap();
    }
}

#[test]
fn concurrent_cold_notification_replies_keep_one_durable_id() {
    let info = rv_core::session::SessionInfo {
        base_url: "http://127.0.0.1:9".into(),
        user_id: "bob".into(),
        username: "bob".into(),
        auth_token: "fixture-token".into(),
        native: Some(Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }),
    };
    let path = std::env::temp_dir().join(format!("rv-notification-concurrent-{:032x}.sqlite", fastrand::u128(..)));
    let cache = NativeStore::open(&path, info.native.clone().unwrap()).unwrap();
    cache
        .snapshot(&Snapshot { protocol_version: 1, rooms: vec![room()], messages: vec![], cursor: "initial".into() })
        .unwrap();
    let notices = cache.batch_notifying(&batch(vec![message("target", "1")]), Some("bob")).unwrap();
    assert!(cache.remember_notification(&notices[0]).unwrap());
    let key = notifications::notification_key(&info, &room().id);
    let barrier = std::sync::Barrier::new(3);
    let ids = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            barrier.wait();
            notifications::save_notification_reply(&info, &path, &key, "target", "same response").unwrap()
        });
        let second = scope.spawn(|| {
            barrier.wait();
            notifications::save_notification_reply(&info, &path, &key, "target", "same response").unwrap()
        });
        barrier.wait();
        (first.join().unwrap(), second.join().unwrap())
    });
    assert_eq!(ids.0, ids.1);
    assert_eq!(cache.pending_notification_replies().unwrap().len(), 1);
    assert!(cache.pending().unwrap().is_empty());
    cache.abandon(&ids.0).unwrap();
    assert!(cache.pending_notification_replies().unwrap().is_empty());
    drop(cache);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn offline_notification_reply_reopens_with_uncached_root_and_refuses_deleted_or_replaced_targets() {
    for scenario in ["normal", "deleted", "root-deleted", "rejoined", "restored"] {
        let f = fixture();
        let endpoint = format!("/api/v1/rooms/{}/messages", room().id);
        let server = FakeHttp::start(move |req| match req.path() {
            "/.well-known/rocketvibe" => {
                let mut discovery = f["discovery"].clone();
                if scenario == "restored" {
                    discovery["data_epoch"] = json!("restored");
                }
                respond(200, &discovery.to_string())
            }
            "/api/v1/me" => respond(200, &json!({"id":"bob","username":"bob","display_name":"Bob"}).to_string()),
            "/api/v1/sync/changes" => {
                let mut r = room();
                r.read_state.as_mut().unwrap().membership_version = Some("replacement".into());
                r.read_state.as_mut().unwrap().revision = "10".into();
                let changes = if scenario == "rejoined" { vec![Change::RoomUpsert(r)] } else { vec![] };
                respond(
                    200,
                    &json!({"protocol_version":1,"changes":changes,"cursor":"next","has_more":false}).to_string(),
                )
            }
            "/api/v1/sync/ticket" => respond(200, &f["socket_ticket"].to_string()),
            "/api/v1/sync/socket" => Response { websocket: true, ..Default::default() },
            "/api/v1/messages/offline-target" => {
                assert_eq!(req.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
                let mut target = message("offline-target", "2");
                target.reply_to = Some("offline-root".into());
                if scenario == "deleted" {
                    target.deleted = true;
                    target.text.clear();
                    target.body = None;
                }
                respond(200, &serde_json::to_string(&target).unwrap())
            }
            "/api/v1/messages/offline-root" => {
                let mut root = message("offline-root", "1");
                if scenario == "root-deleted" {
                    root.deleted = true;
                    root.text.clear();
                    root.body = None;
                }
                respond(200, &serde_json::to_string(&root).unwrap())
            }
            path if path == endpoint => {
                assert_eq!(scenario, "normal", "no forbidden notification reply may reach send");
                let send: rv_protocol::SendMessage = serde_json::from_str(&req.body).unwrap();
                assert_eq!(send.text, "offline exact reply");
                assert_eq!(send.reply_to.as_deref(), Some("offline-root"));
                let mut echo = message(&send.operation_id, "3");
                echo.text = send.text;
                echo.reply_to = send.reply_to;
                echo.body = None;
                echo.author.id = "bob".into();
                echo.author.username = "bob".into();
                respond(200, &serde_json::to_string(&echo).unwrap())
            }
            _ => respond(404, r#"{"code":"not_found"}"#),
        })
        .await;
        let info = reply_info(&server);
        let path = std::env::temp_dir().join(format!("rv-offline-notification-{:032x}.sqlite", fastrand::u128(..)));
        let id = offline_reply(&info, &path);
        assert!(server.requests().is_empty(), "accepting an offline response must not need HTTP");
        let s = NativeSession::start(info, &path).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !s.is_closed() && s.status().connection != rv_core::session::Connection::Online {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        if scenario == "restored" {
            assert!(s.is_closed());
            assert_eq!(s.status().error.as_deref(), Some("server_identity_changed"));
        } else if scenario == "rejoined" {
            assert!(s.store.selected_messages(std::slice::from_ref(&id)).unwrap().is_empty());
        } else {
            let rows = s.store.selected_messages(std::slice::from_ref(&id)).unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].text, "offline exact reply");
            assert_eq!(rows[0].status.as_deref(), (scenario != "normal").then_some("failed"));
            assert!(s.store.pending_notification_replies().unwrap().is_empty());
            if scenario != "normal" {
                s.retry(&id).unwrap();
                assert!(s.store.pending().unwrap().is_empty());
            }
        }
        let sends = server.requests().iter().filter(|r| r.method == "POST" && r.path().ends_with("/messages")).count();
        assert_eq!(sends, usize::from(scenario == "normal"), "{scenario}");
        common::close_native(s).await;
        std::fs::remove_file(path).unwrap();
    }
}

#[tokio::test]
async fn offline_notification_reply_confirms_lost_send_after_restart_even_when_original_was_deleted() {
    let f = fixture();
    let committed: Arc<Mutex<Option<Message>>> = Arc::new(Mutex::new(None));
    let delivered = committed.clone();
    let endpoint = format!("/api/v1/rooms/{}/messages", room().id);
    let server = FakeHttp::start(move |req| match req.path() {
        "/.well-known/rocketvibe" => respond(200, &f["discovery"].to_string()),
        "/api/v1/me" => respond(200, &json!({"id":"bob","username":"bob","display_name":"Bob"}).to_string()),
        "/api/v1/sync/changes" => {
            respond(200, &json!({"protocol_version":1,"changes":[],"cursor":"next","has_more":false}).to_string())
        }
        "/api/v1/sync/ticket" => respond(200, &f["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => Response { websocket: true, ..Default::default() },
        "/api/v1/messages/offline-target" => {
            let mut target = message("offline-target", "2");
            target.reply_to = Some("offline-root".into());
            if delivered.lock().unwrap().is_some() {
                target.deleted = true;
                target.text.clear();
                target.body = None;
            }
            respond(200, &serde_json::to_string(&target).unwrap())
        }
        "/api/v1/messages/offline-root" => respond(200, &serde_json::to_string(&message("offline-root", "1")).unwrap()),
        path if path == endpoint => {
            let send: rv_protocol::SendMessage = serde_json::from_str(&req.body).unwrap();
            assert!(delivered.lock().unwrap().is_none(), "the lost response must not create a second send");
            let mut echo = message(&send.operation_id, "3");
            echo.text = send.text;
            echo.reply_to = send.reply_to;
            echo.body = None;
            echo.author.id = "bob".into();
            echo.author.username = "bob".into();
            *delivered.lock().unwrap() = Some(echo);
            common::dropped()
        }
        path if path.starts_with("/api/v1/messages/") => {
            let message = delivered.lock().unwrap();
            let echo = message.as_ref().unwrap();
            assert_eq!(path, format!("/api/v1/messages/{}", echo.id));
            assert_eq!(req.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
            respond(200, &serde_json::to_string(echo).unwrap())
        }
        _ => respond(404, r#"{"code":"not_found"}"#),
    })
    .await;
    let info = reply_info(&server);
    let path = std::env::temp_dir().join(format!("rv-offline-notification-lost-{:032x}.sqlite", fastrand::u128(..)));
    let id = offline_reply(&info, &path);
    let s = NativeSession::start(info.clone(), &path).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while committed.lock().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    common::close_native(s).await;
    let s = NativeSession::start(info, &path).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while s.status().connection != rv_core::session::Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let rows = s.store.selected_messages(std::slice::from_ref(&id)).unwrap();
    assert_eq!(rows[0].status, None);
    assert_eq!(rows[0].text, "offline exact reply");
    assert!(s.store.pending_notification_replies().unwrap().is_empty());
    assert_eq!(server.requests().iter().filter(|r| r.method == "POST" && r.path().ends_with("/messages")).count(), 1);
    assert_eq!(server.requests().iter().filter(|r| r.path() == "/api/v1/messages/offline-target").count(), 1);
    common::close_native(s).await;
    std::fs::remove_file(path).unwrap();
}
