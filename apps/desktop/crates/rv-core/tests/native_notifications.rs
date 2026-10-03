mod common;
use common::{FakeHttp, Response, respond};
use rv_core::native::{Identity, NativeSession, store::NativeStore};
use rv_protocol::{Change, Message, Room, Snapshot, SyncBatch};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

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
    let s = NativeSession::start(info, &path).unwrap();
    let mut incoming = s.incoming();
    let n = tokio::time::timeout(Duration::from_secs(5), incoming.recv()).await.unwrap().unwrap();
    assert!(n.direct);
    assert!(!n.mentions_me);
    assert!(s.notification_current(&n));
    assert!(incoming.try_recv().is_err());
    s.suspend();
    let key = s.notification_key(&n.rid);
    assert!(s.notification_target(&key, &n.id).is_some());
    assert!(s.notification_target("rv-native:foreign:room-id", &n.id).is_none());
    let operation = s.reply_notification(&key, &n.id, "exact response").unwrap();
    let pending = s.store.pending().unwrap();
    assert_eq!(pending[0].id, operation);
    assert_eq!(pending[0].text, "exact response");
    s.shutdown();
    assert!(s.reply_notification(&key, &n.id, "late").is_err());
    common::close_native(s).await;
    std::fs::remove_file(path).unwrap();
}
