mod common;
use common::{FakeHttp, respond};
use rv_core::{
    native::{
        Identity, NativeSession,
        store::{FileIntent, NativeStore},
    },
    session::{Connection, SessionInfo},
};
use rv_protocol::{
    Snapshot,
    parity::{CompleteUpload, FileDescriptor, MessageContent, PrepareUpload},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap()
}
fn identity(f: &Value) -> Identity {
    Identity {
        instance_id: f["discovery"]["instance_id"].as_str().unwrap().into(),
        data_epoch: f["discovery"]["data_epoch"].as_str().unwrap().into(),
    }
}
fn snapshot(f: &Value) -> Snapshot {
    let mut room = f["room"].clone();
    room["read_state"] = json!({"room_id":"room-id","membership_version":"grant","revision":"0","root_position":"0","reply_position":"0","unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false});
    Snapshot {
        protocol_version: 1,
        rooms: vec![serde_json::from_value(room).unwrap()],
        messages: vec![],
        cursor: "initial".into(),
    }
}
fn intent() -> FileIntent {
    FileIntent {
        id: "prepare".into(),
        rid: "room-id".into(),
        membership: "grant".into(),
        path: "private-copy".into(),
        prepare: PrepareUpload {
            operation_id: "prepare".into(),
            room_id: "room-id".into(),
            bytes: "4".into(),
            sha256: "a".repeat(64),
            media_type: "text/plain".into(),
            filename: Some("file.txt".into()),
            encrypted: false,
        },
        complete: CompleteUpload {
            operation_id: "complete".into(),
            content: MessageContent::Plain {
                markdown: "original caption".into(),
                mentions: vec![],
                quotes: vec![],
                files: vec![],
            },
            reply_to: None,
        },
        cancelling: false,
        failed: false,
        error: None,
    }
}
#[test]
fn manifests_and_intentions_are_atomic_and_do_not_cross_membership_or_epoch() {
    let f = fixture();
    let path = std::env::temp_dir().join(format!("rv-files-{:032x}.sqlite", fastrand::u128(..)));
    let mut initial = snapshot(&f);
    let store = NativeStore::open(&path, identity(&f)).unwrap();
    store.snapshot(&initial).unwrap();
    let pending = intent();
    assert!(store.save_file_intent(&pending).unwrap());
    store.fail_file_intent(&pending.id, "upload_expired").unwrap();
    store.retry_file_intent(&pending.id).unwrap();
    let retry = store.file_intents().unwrap().remove(0);
    assert_ne!(retry.prepare.operation_id, pending.prepare.operation_id);
    assert_eq!(retry.complete.operation_id, pending.complete.operation_id);
    assert!(!retry.failed);
    store.file_intent_state(&pending.id, true, false).unwrap();
    drop(store);
    let store = NativeStore::open(&path, identity(&f)).unwrap();
    assert!(store.file_intents().unwrap()[0].cancelling);
    store.retry_file_intent(&pending.id).unwrap();
    assert!(store.file_intents().unwrap()[0].cancelling);
    store.file_intent_state(&pending.id, false, true).unwrap();
    assert!(store.file_intents().unwrap()[0].cancelling);
    let mut message: rv_protocol::Message = serde_json::from_value(f["message"].clone()).unwrap();
    message.files = vec![FileDescriptor {
        id: "file-id".into(),
        room_id: "room-id".into(),
        bytes: "4".into(),
        sha256: "a".repeat(64),
        media_type: "text/plain".into(),
        filename: Some("file.txt".into()),
        encrypted: false,
    }];
    store.ingest(std::slice::from_ref(&message)).unwrap();
    let rows = store.messages("room-id", 20).unwrap();
    assert_eq!(rv_core::content::files(rows[0].attachments.as_deref()).len(), 1);
    let mut invalid = message.clone();
    invalid.files[0].room_id = "other-room".into();
    invalid.revision = "9007199254740994".into();
    assert!(store.ingest(&[invalid]).is_err());
    assert!(store.file_descriptor("file-id").unwrap().is_some());
    initial.rooms[0].read_state.as_mut().unwrap().membership_version = Some("new-grant".into());
    initial.rooms[0].read_state.as_mut().unwrap().revision = "1".into();
    store.snapshot(&initial).unwrap();
    assert!(store.file_intents().unwrap().is_empty());
    assert!(store.file_descriptor("file-id").unwrap().is_none());
    assert!(!store.finish_file_intent(&pending, None).unwrap());
    drop(store);
    let store = NativeStore::open(&path, Identity { data_epoch: "new-epoch".into(), ..identity(&f) }).unwrap();
    assert!(store.file_intents().unwrap().is_empty());
    drop(store);
    std::fs::remove_file(path).unwrap();
}
async fn until(mut test: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !test() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn lost_prepare_and_confirmation_responses_reopen_the_original_intention_and_current_receipt() {
    let f = fixture();
    let phase = Arc::new(AtomicUsize::new(0));
    let original = Arc::new(Mutex::new(None::<Value>));
    let complete = Arc::new(Mutex::new(None::<String>));
    // Keep each response lost until that session has actually stopped. An
    // immediate worker/HTTP retry must not complete the next phase before the
    // test has inspected its durable outbox, particularly on Windows runners.
    let allow_prepare = Arc::new(AtomicBool::new(false));
    let allow_receipt = Arc::new(AtomicBool::new(false));
    let (prepared, delivered) = (allow_prepare.clone(), allow_receipt.clone());
    let (stage, saved, key, fixture) = (phase.clone(), original.clone(), complete.clone(), f.clone());
    let server=FakeHttp::start(move |request|match request.path(){
        "/.well-known/rocketvibe"=>{let mut d=fixture["discovery"].clone();d["capabilities"]["uploads"]=json!(true);respond(200,&d.to_string())},
        "/api/v1/me"=>respond(200,&fixture["session"]["user"].to_string()),
        "/api/v1/sync/changes"=>respond(200,&json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string()),
        "/api/v1/sync/ticket"=>respond(200,&fixture["socket_ticket"].to_string()),
        "/api/v1/sync/socket"=>common::Response{websocket:true,..Default::default()},
        "/api/v1/uploads"=>{
            let input:Value=serde_json::from_str(&request.body).unwrap();let mut old=saved.lock().unwrap();if let Some(old)=old.as_ref(){assert_eq!(old,&input)}else{*old=Some(input.clone());}
            if !prepared.load(Ordering::SeqCst) {stage.store(1,Ordering::SeqCst);return common::dropped()}
            let finished=key.lock().unwrap().clone();respond(200,&json!({"id":"upload-id","file":{"id":"file-id","room_id":input["room_id"],"bytes":input["bytes"],"sha256":input["sha256"],"media_type":input["media_type"],"filename":input["filename"],"encrypted":false},"state":if finished.is_some(){"completed"}else{"ready"},"expires_at":"2026-10-04T00:00:00Z","message_id":finished}).to_string())
        },
        "/api/v1/uploads/upload-id/complete"=>{
            let input:Value=serde_json::from_str(&request.body).unwrap();let id=input["operation_id"].as_str().unwrap().to_owned();let mut original=key.lock().unwrap();if let Some(old)=original.as_ref(){assert_eq!(old,&id)}else{*original=Some(id.clone());stage.store(2,Ordering::SeqCst);}
            if !delivered.load(Ordering::SeqCst) {return common::dropped()}
            let prepared=saved.lock().unwrap();let p=prepared.as_ref().unwrap();let mut m=fixture["message"].clone();m["id"]=json!(id);m["text"]=json!("caption edited elsewhere");m["body"]=Value::Null;m["quotes"]=json!([]);m["files"]=json!([{"id":"file-id","room_id":p["room_id"],"bytes":p["bytes"],"sha256":p["sha256"],"media_type":p["media_type"],"filename":p["filename"],"encrypted":false}]);respond(200,&m.to_string())
        },
        _=>respond(404,r#"{"code":"not_found","request_id":"files-test"}"#)
    }).await;
    let folder = std::env::temp_dir().join(format!("rv-files-retry-{:032x}", fastrand::u128(..)));
    std::fs::create_dir_all(&folder).unwrap();
    let db = folder.join("session.sqlite");
    let source = folder.join("source.txt");
    std::fs::write(&source, "file").unwrap();
    let store = NativeStore::open(&db, identity(&f)).unwrap();
    store.snapshot(&snapshot(&f)).unwrap();
    drop(store);
    let info = SessionInfo {
        mattermost: None,
        base_url: server.url.as_str().into(),
        user_id: "alice-id".into(),
        username: "alice".into(),
        auth_token: "fixture-token".into(),
        native: Some(identity(&f)),
    };
    let first = NativeSession::start(info.clone(), &db).unwrap();
    until(|| first.status().connection == Connection::Online).await;
    first
        .attach_file("room-id", &source, "source.txt", "text/plain", Some("original caption"), false, "grant")
        .await
        .unwrap();
    until(|| phase.load(Ordering::SeqCst) == 1).await;
    let original_intent = first.store.file_intents().unwrap()[0].clone();
    common::close_native(first).await;
    allow_prepare.store(true, Ordering::SeqCst);
    let second = NativeSession::start(info.clone(), &db).unwrap();
    until(|| phase.load(Ordering::SeqCst) == 2).await;
    assert_eq!(second.store.file_intents().unwrap()[0].complete.operation_id, original_intent.complete.operation_id);
    common::close_native(second).await;
    allow_receipt.store(true, Ordering::SeqCst);
    let third = NativeSession::start(info, &db).unwrap();
    until(|| third.store.file_intents().unwrap().is_empty()).await;
    let rows = third.store.messages("room-id", 50).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, original_intent.complete.operation_id);
    assert_eq!(rows[0].text, "caption edited elsewhere");
    assert!(third.file_current("rv-file:file-id"));
    common::close_native(third).await;
    std::fs::remove_dir_all(folder).unwrap();
}
