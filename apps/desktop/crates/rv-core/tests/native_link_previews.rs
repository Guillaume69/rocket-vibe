mod common;
use base64::Engine;
use common::{FakeHttp, respond};
use rv_core::{
    native::{Identity, NativeSession, store::NativeStore},
    session::{Connection, SessionInfo},
};
use rv_protocol::{
    Change, Snapshot, SyncBatch,
    link_previews::{LinkPreview, PreviewImage, PreviewKind},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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
fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=")
        .unwrap()
}
fn snapshot() -> Snapshot {
    let mut value = fixture();
    value["snapshot"]["rooms"] = json!([value["room"].clone()]);
    value["snapshot"]["messages"] = json!([value["message"].clone()]);
    value["snapshot"]["rooms"][0]["read_state"] = json!({"room_id":"room-id","revision":"1","membership_version":"membership","favorite_revision":"1","root_position":"0","reply_position":"0","unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false});
    let mut snapshot: Snapshot = serde_json::from_value(value["snapshot"].clone()).unwrap();
    let png = png();
    let image = PreviewImage {
        file_id: "a".repeat(64),
        sha256: Sha256::digest(&png).iter().map(|b| format!("{b:02x}")).collect(),
        bytes: png.len().to_string(),
        width: 1,
        height: 1,
        media_type: "image/png".into(),
    };
    snapshot.messages[0].previews = vec![LinkPreview {
        url: "https://example.org/article".into(),
        kind: PreviewKind::Page,
        title: Some("An article".into()),
        description: Some("Description".into()),
        site: Some("Example".into()),
        image: Some(image),
    }];
    snapshot
}
#[tokio::test]
async fn existing_cards_and_private_reader_keep_cache_across_reactions_and_fence_edits_and_rejoining() {
    let f = fixture();
    let mut discovery = f["discovery"].clone();
    discovery["capabilities"]["link_previews"] = json!(true);
    let initial = snapshot();
    let remote = Arc::new(Mutex::new(initial.messages[0].clone()));
    let reads = Arc::new(AtomicUsize::new(0));
    let (current, count) = (remote.clone(), reads.clone());
    let image = initial.messages[0].previews[0].image.as_ref().unwrap();
    let bytes = png();
    let server = FakeHttp::start(move |r| match r.path() {
        "/.well-known/rocketvibe" => respond(200, &discovery.to_string()),
        "/api/v1/me" => respond(200, &f["session"]["user"].to_string()),
        "/api/v1/sync/changes" => respond(
            200,
            &json!({"protocol_version":1,"changes":[],"cursor":"opaque-fixture","has_more":false}).to_string(),
        ),
        "/api/v1/sync/ticket" => respond(200, &f["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => common::Response { websocket: true, ..Default::default() },
        "/api/v1/messages/message-id" => respond(200, &serde_json::to_string(&*current.lock().unwrap()).unwrap()),
        path if path.contains("/previews/") => {
            assert_eq!(r.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
            assert!(!r.target.contains('?'));
            count.fetch_add(1, Ordering::SeqCst);
            common::Response {
                status: 200,
                binary: Some(bytes.clone()),
                headers: vec![("content-type".into(), "image/png".into())],
                ..Default::default()
            }
        }
        _ => respond(404, "{}"),
    })
    .await;
    let path = std::env::temp_dir().join(format!("rv-previews-{:032x}.sqlite", fastrand::u128(..)));
    let identity = Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() };
    let store = NativeStore::open(&path, identity.clone()).unwrap();
    store.snapshot(&initial).unwrap();
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
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(session.supported_features().iter().any(|f| f == "link_previews"));
    let row = session.store.messages("room-id", 10).unwrap().remove(0).presentation("room-id", "alice-id");
    let cards = rv_core::content::link_previews(row.urls.as_deref(), 3);
    assert_eq!(cards.len(), 1);
    let source = format!("rv-preview:message-id/{}", image.file_id);
    let scope = session.preview_scope(&source).unwrap();
    assert_eq!(session.preview_media(&source).await.unwrap().bytes, png());
    assert_eq!(session.preview_media(&source).await.unwrap().content_type, "image/png");
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    let mut reaction = initial.messages[0].clone();
    reaction.revision = "9007199254740994".into();
    session
        .store
        .batch(&SyncBatch {
            protocol_version: 1,
            changes: vec![Change::MessageUpsert(reaction.clone())],
            cursor: "reaction".into(),
            has_more: false,
        })
        .unwrap();
    assert_eq!(session.preview_scope(&source).unwrap(), scope);
    session.preview_media(&source).await.unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    remote.lock().unwrap().previews.clear();
    assert!(session.preview_media(&source).await.is_err());
    reaction.revision = "9007199254740995".into();
    reaction.previews.clear();
    session
        .store
        .batch(&SyncBatch {
            protocol_version: 1,
            changes: vec![Change::MessageUpsert(reaction)],
            cursor: "edit".into(),
            has_more: false,
        })
        .unwrap();
    assert!(!session.preview_current(&source));
    let mut rejoined = initial.clone();
    rejoined.rooms[0].read_state.as_mut().unwrap().membership_version = Some("rejoined".into());
    rejoined.rooms[0].read_state.as_mut().unwrap().revision = "2".into();
    session.store.snapshot(&rejoined).unwrap();
    *remote.lock().unwrap() = initial.messages[0].clone();
    assert_ne!(session.preview_scope(&source).unwrap(), scope);
    session.preview_media(&source).await.unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    common::close_native(session).await;
    std::fs::remove_file(path).unwrap();
}

#[test]
fn native_video_metadata_does_not_fall_back_to_an_external_thumbnail() {
    let mut initial = snapshot();
    initial.messages[0].text = "https://www.youtube.com/watch?v=dQw4w9WgXcQ".into();
    initial.messages[0].previews[0].url = initial.messages[0].text.clone();
    let store = NativeStore::open(
        std::path::Path::new(":memory:"),
        Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() },
    )
    .unwrap();
    store.snapshot(&initial).unwrap();
    let row = store.messages("room-id", 10).unwrap().remove(0).presentation("room-id", "alice-id");
    let video = rv_core::content::video_links(row.text.as_deref().unwrap(), row.urls.as_deref(), 3).remove(0);
    assert_eq!(video.title.as_deref(), Some("An article"));
    assert!(video.thumbnail.unwrap().starts_with("rv-preview:"));
    assert!(rv_core::content::link_previews(row.urls.as_deref(), 3).is_empty());
    initial.messages[0].previews.clear();
    initial.messages[0].revision = "9007199254740994".into();
    store.snapshot(&initial).unwrap();
    let row = store.messages("room-id", 10).unwrap().remove(0).presentation("room-id", "alice-id");
    assert!(rv_core::content::video_links(row.text.as_deref().unwrap(), row.urls.as_deref(), 3)[0].thumbnail.is_none());
}
