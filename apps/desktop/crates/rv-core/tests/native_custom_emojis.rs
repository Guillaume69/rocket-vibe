mod common;
use common::{FakeHttp, respond};
use rv_core::{
    native::{Identity, NativeSession, store::NativeStore},
    session::{Connection, SessionInfo},
};
use rv_protocol::{Snapshot, custom_emojis::EmojiCatalog};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
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
    serde_json::from_value(fixture()["snapshot"].clone()).unwrap()
}
fn catalogue() -> EmojiCatalog {
    serde_json::from_value(fixture()["emoji_catalog"].clone()).unwrap()
}

#[test]
fn catalogue_floor_is_exact_atomic_and_durable_across_reopen_but_not_epochs() {
    let path = std::env::temp_dir().join(format!("rv-emoji-{:032x}.sqlite", fastrand::u128(..)));
    let store = NativeStore::open(&path, identity()).unwrap();
    store.snapshot(&snapshot()).unwrap();
    let catalog = catalogue();
    assert!(store.save_emojis(&catalog, || true).unwrap());
    let checks = AtomicUsize::new(0);
    assert!(store.invalidate_emojis("9007199254740993", || checks.fetch_add(1, Ordering::SeqCst) == 0).is_err());
    assert_eq!(store.emoji_catalog().unwrap(), Some(catalog.clone()));
    assert!(store.invalidate_emojis("9007199254740993", || true).unwrap());
    assert!(store.emoji_catalog().unwrap().is_none());
    drop(store);
    let store = NativeStore::open(&path, identity()).unwrap();
    assert!(!store.save_emojis(&catalog, || true).unwrap());
    let next = EmojiCatalog { revision: "9007199254740993".into(), ..catalog };
    assert!(store.save_emojis(&next, || true).unwrap());
    assert_eq!(store.cursor().unwrap().as_deref(), Some("opaque-fixture"));
    let altered = EmojiCatalog { items: vec![], ..next.clone() };
    assert!(store.save_emojis(&altered, || true).is_err());
    store.snapshot(&snapshot()).unwrap();
    assert_eq!(store.emoji_catalog().unwrap(), Some(next));
    drop(store);
    let store = NativeStore::open(&path, Identity { data_epoch: "new-epoch".into(), ..identity() }).unwrap();
    assert!(store.emoji_catalog().unwrap().is_none());
    store.snapshot(&snapshot()).unwrap();
    assert_eq!(store.emoji_revision().unwrap(), "0");
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn protected_custom_images_resolve_aliases_and_refuse_a_retired_cached_image() {
    let f = fixture();
    let mut discovery = f["discovery"].clone();
    discovery["capabilities"]["custom_emojis"] = json!(true);
    let advertised = Arc::new(Mutex::new(discovery));
    let discovery = advertised.clone();
    let bytes = "GIF89a";
    let mut catalog = catalogue();
    catalog.items[0].bytes = bytes.len().to_string();
    catalog.items[0].sha256 = Sha256::digest(bytes.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let current = Arc::new(Mutex::new(catalog));
    let image_reads = Arc::new(AtomicUsize::new(0));
    let (remote, reads) = (current.clone(), image_reads.clone());
    let server = FakeHttp::start(move |r| match r.path() {
        "/.well-known/rocketvibe" => respond(200, &discovery.lock().unwrap().to_string()),
        "/api/v1/me" => respond(200, &f["session"]["user"].to_string()),
        "/api/v1/sync/changes" => respond(
            200,
            &json!({"protocol_version":1,"changes":[],"cursor":"opaque-fixture","has_more":false}).to_string(),
        ),
        "/api/v1/sync/ticket" => respond(200, &f["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => common::Response { websocket: true, ..Default::default() },
        "/api/v1/emoji" => {
            assert_eq!(r.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
            respond(200, &serde_json::to_string(&*remote.lock().unwrap()).unwrap())
        }
        path if path.starts_with("/api/v1/emoji/files/") => {
            assert_eq!(r.headers.get("authorization").map(String::as_str), Some("Bearer fixture-token"));
            assert!(!r.target.contains('?'));
            reads.fetch_add(1, Ordering::SeqCst);
            common::Response { headers: vec![("content-type".into(), "image/gif".into())], ..respond(200, bytes) }
        }
        _ => respond(404, "{}"),
    })
    .await;
    let path = std::env::temp_dir().join(format!("rv-emoji-http-{:032x}.sqlite", fastrand::u128(..)));
    let store = NativeStore::open(&path, identity()).unwrap();
    store.snapshot(&snapshot()).unwrap();
    drop(store);
    let session = NativeSession::start(
        SessionInfo {
            mattermost: None,
            base_url: server.url.to_string(),
            user_id: "alice-id".into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity()),
        },
        Path::new(&path),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(session.supported_features().iter().any(|f| f == "custom_emojis"));
    let image = session.custom_emoji("vibe_parrot").unwrap();
    assert_eq!(image, session.custom_emoji("party_parrot").unwrap());
    assert_eq!(session.custom_emoji_names(), ["party_parrot"]);
    assert_eq!(session.custom_emoji_codes("vibe"), ["vibe_parrot"]);
    assert_eq!(session.emoji_media(&image).await.unwrap().bytes, bytes.as_bytes());
    assert_eq!(session.emoji_media(&image).await.unwrap().content_type, "image/gif");
    assert_eq!(image_reads.load(Ordering::SeqCst), 1);
    *current.lock().unwrap() = EmojiCatalog { revision: "4".into(), items: vec![] };
    assert!(session.emoji_media(&image).await.is_err());
    assert!(!session.emoji_current(&image));
    assert!(session.custom_emoji("party_parrot").is_none());
    assert_eq!(image_reads.load(Ordering::SeqCst), 1);
    *current.lock().unwrap() = catalogue();
    current.lock().unwrap().revision = "5".into();
    advertised.lock().unwrap()["capabilities"]["custom_emojis"] = json!(false);
    session.refresh_emojis().await.unwrap();
    assert!(session.custom_emoji_names().is_empty());
    assert!(session.custom_emoji("party_parrot").is_none());
    assert!(!session.supported_features().iter().any(|f| f == "custom_emojis"));
    assert!(!session.emoji_current(&image));
    common::close_native(session).await;
    std::fs::remove_file(path).unwrap();
}
