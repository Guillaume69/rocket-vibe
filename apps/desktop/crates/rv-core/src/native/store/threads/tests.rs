use super::*;
use rv_protocol::parity::ReadState;

fn identity() -> Identity {
    Identity { instance_id: "threads-instance".into(), data_epoch: "epoch".into() }
}
fn room(grant: &str, revision: &str) -> Room {
    Room {
        id: "room".into(),
        name: "Room".into(),
        kind: rv_protocol::RoomKind::Private,
        revision: revision.into(),
        encrypted: false,
        voice: false,
        read_state: Some(Box::new(ReadState {
            room_id: "room".into(),
            revision: revision.into(),
            membership_version: Some(grant.into()),
            favorite_revision: Some(revision.into()),
            root_position: "0".into(),
            reply_position: "0".into(),
            unread_roots: "0".into(),
            unread_replies: "2".into(),
            mentions: "0".into(),
            group_mentions: "0".into(),
            favorite: false,
        })),
    }
}
fn message(id: &str, position: &str, root: Option<&str>) -> Message {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut m: Message = serde_json::from_value(fixture["message"].clone()).unwrap();
    m.id = id.into();
    m.room_id = "room".into();
    m.text = id.into();
    m.position = position.into();
    m.revision = position.into();
    m.quotes.clear();
    m.reply_to = root.map(str::to_owned);
    m.thread = None;
    m
}
fn initial() -> Snapshot {
    let mut root = message("root", "10", None);
    root.thread = Some(Box::new(rv_protocol::ThreadSummary {
        replies: "2".into(),
        last_reply_at: Some(root.created_at.clone()),
    }));
    Snapshot {
        protocol_version: 1,
        rooms: vec![room("grant", "1")],
        messages: vec![
            root,
            message("other", "11", None),
            message("first", "9007199254740993", Some("root")),
            message("second", "9007199254740994", Some("root")),
        ],
        cursor: "initial".into(),
    }
}
fn state(position: &str, revision: &str) -> ThreadReadState {
    ThreadReadState {
        root_id: "root".into(),
        room_id: "room".into(),
        membership_version: "grant".into(),
        position: position.into(),
        revision: revision.into(),
        unread: "0".into(),
    }
}
fn pending(root: &str) -> Pending {
    Pending {
        id: "outgoing".into(),
        room_id: "room".into(),
        text: "Saved words".into(),
        quotes: vec![],
        reply_to: Some(root.into()),
    }
}
fn store() -> NativeStore {
    let s = NativeStore::open(Path::new(":memory:"), identity()).unwrap();
    s.snapshot(&initial()).unwrap();
    s
}

#[test]
fn thread_drafts_outbox_and_exact_sequence_survive_disk_restart_and_snapshot() {
    let path = std::env::temp_dir().join(format!("rv-thread-test-{:032x}.sqlite", fastrand::u128(..)));
    let s = NativeStore::open(&path, identity()).unwrap();
    s.snapshot(&initial()).unwrap();
    s.set_draft_from_membership("room", "Room draft", Some("grant")).unwrap();
    s.set_thread_draft_from_membership("room", "root", "Thread draft", Some("grant")).unwrap();
    s.enqueue_quoted(&pending("root"), "me", Some(Some("grant")), &[]).unwrap();
    assert_eq!(
        s.messages("room", 50).unwrap().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["root", "other"]
    );
    assert_eq!(s.oldest("room").unwrap().as_deref(), Some("10"));
    let rows = s.thread_messages("room", "root").unwrap();
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["root", "first", "second", "outgoing"]);
    assert_eq!(rows[0].clone().presentation("room", "me").thread_count, 2);
    assert_eq!(rows[1].clone().presentation("room", "me").thread_id.as_deref(), Some("root"));
    s.snapshot(&initial()).unwrap();
    drop(s);
    let s = NativeStore::open(&path, identity()).unwrap();
    assert_eq!(s.pending().unwrap(), vec![pending("root")]);
    assert_eq!(s.draft_from_membership("room", Some("grant")).unwrap(), "Room draft");
    assert_eq!(s.thread_draft_from_membership("room", "root", Some("grant")).unwrap(), "Thread draft");
    assert_eq!(s.thread_messages("room", "root").unwrap().last().unwrap().id, "outgoing");
    drop(s);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn thread_reads_capture_only_observed_replies_and_preserve_newer_pending_reads() {
    let s = store();
    let token = s.projection_token();
    assert!(!s.stage_thread_read("root", "root", "grant").unwrap());
    assert!(!s.stage_thread_read("root", "other", "grant").unwrap());
    assert!(!s.stage_read_from_membership("room", "second", "grant").unwrap());
    assert!(s.stage_thread_read("root", "first", "grant").unwrap());
    assert!(s.stage_thread_read("root", "second", "grant").unwrap());
    assert!(!s.stage_thread_read("root", "first", "grant").unwrap());
    s.cache_thread_read(&state("9007199254740993", "20"), token).unwrap();
    assert_eq!(s.pending_thread_reads().unwrap()[0].position, "9007199254740994");
    s.cache_thread_read(&state("9007199254740994", "21"), token).unwrap();
    assert!(s.pending_thread_reads().unwrap().is_empty());
    assert!(s.pending_reads().unwrap().is_empty());
    assert_eq!(s.read_state("room").unwrap().unwrap().root_position, "0");
}

#[test]
fn malformed_thread_pages_and_sql_failures_do_not_acknowledge_or_project() {
    let s = store();
    let token = s.projection_token();
    let mut page = ThreadPage {
        root: message("root", "10", None),
        messages: vec![message("new", "9007199254740995", Some("root"))],
        has_more: false,
        read_state: state("0", "22"),
    };
    page.messages[0].room_id = "foreign".into();
    assert!(s.cache_thread(&page, token).is_err());
    page.messages[0].room_id = "room".into();
    s.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_thread_state BEFORE INSERT ON native_thread_states BEGIN SELECT RAISE(ABORT,'injected SQL failure'); END;").unwrap();
    assert!(s.cache_thread(&page, token).is_err());
    assert!(s.selected_messages(&["new".into()]).unwrap().is_empty());
    assert_eq!(s.cursor().unwrap().as_deref(), Some("initial"));
    s.conn.lock().unwrap().execute_batch("DROP TRIGGER fail_thread_state;").unwrap();
    assert!(s.cache_thread(&page, token).unwrap());
    assert_eq!(s.selected_messages(&["new".into()]).unwrap().len(), 1);
}

#[test]
fn deleted_roots_reject_new_sends_and_withdrawal_purges_thread_lifetimes() {
    let s = store();
    let token = s.projection_token();
    s.enqueue_quoted(&pending("root"), "me", Some(Some("grant")), &[]).unwrap();
    let mut root = message("root", "10", None);
    root.revision = "30".into();
    root.deleted = true;
    root.text.clear();
    s.ingest(&[root]).unwrap();
    assert!(!s.thread_writable("room", "root").unwrap());
    let mut another = pending("root");
    another.id = "another".into();
    assert!(s.enqueue_quoted(&another, "me", Some(Some("grant")), &[]).is_err());
    assert_eq!(s.pending().unwrap(), vec![pending("root")]);
    s.set_thread_draft_from_membership("room", "root", "Keep words", Some("grant")).unwrap();
    s.stage_thread_read("root", "second", "grant").unwrap();
    s.cache_thread_read(&state("0", "31"), token).unwrap();
    s.batch(&SyncBatch {
        protocol_version: 1,
        changes: vec![Change::RoomRemoved { room_id: "room".into() }],
        cursor: "removed".into(),
        has_more: false,
    })
    .unwrap();
    s.batch(&SyncBatch {
        protocol_version: 1,
        changes: vec![Change::RoomUpsert(room("next-grant", "40"))],
        cursor: "joined".into(),
        has_more: false,
    })
    .unwrap();
    assert!(s.pending().unwrap().is_empty());
    assert!(s.pending_thread_reads().unwrap().is_empty());
    assert_eq!(s.thread_draft_from_membership("room", "root", Some("next-grant")).unwrap(), "");
    assert!(!s.set_thread_draft_from_membership("room", "root", "Late callback", Some("grant")).unwrap());
    assert!(!s.cache_thread_read(&state("9007199254740994", "41"), token).unwrap());
    let conn = s.conn.lock().unwrap();
    for table in ["native_thread_states", "native_thread_read_intents", "native_thread_drafts"] {
        assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
}
