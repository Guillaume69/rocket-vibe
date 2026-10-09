use super::*;
use rv_core::{
    native::{Identity, NativeSession, store::NativeStore},
    session::{Connection, SessionInfo},
};
use std::{
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
#[path = "../../../rv-core/tests/common/mod.rs"]
mod http;

fn until(check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !check() {
        assert!(Instant::now() < deadline, "GTK preview timed out");
        while glib::MainContext::default().iteration(false) {}
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn picture(widget: &gtk::Widget) -> Option<gtk::Picture> {
    if let Some(picture) = widget.downcast_ref::<gtk::Picture>() {
        return Some(picture.clone());
    }
    std::iter::successors(widget.first_child(), |w| w.next_sibling()).find_map(|w| picture(&w))
}

#[test]
#[ignore = "requires a GTK display; run under Xvfb"]
fn native_link_previews_paint_existing_cards_and_revoke_the_old_membership() {
    gtk::init().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _entered = runtime.enter();
    let bytes =
        gdk::MemoryTexture::new(1, 1, gdk::MemoryFormat::R8g8b8a8, &glib::Bytes::from(&[80u8, 120, 200, 255][..]), 4)
            .save_to_png_bytes()
            .to_vec();
    let digest: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    let file = "a".repeat(64);
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut discovery = fixture["discovery"].clone();
    discovery["capabilities"]["link_previews"] = serde_json::json!(true);
    let mut raw = fixture["snapshot"].clone();
    raw["rooms"] = serde_json::json!([fixture["room"].clone()]);
    raw["messages"] = serde_json::json!([fixture["message"].clone()]);
    raw["rooms"][0]["read_state"] = serde_json::json!({"room_id":"room-id","revision":"1","membership_version":"membership","favorite_revision":"1","root_position":"0","reply_position":"0","unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false});
    raw["messages"][0]["previews"] = serde_json::json!([{"url":"https://example.org/article","kind":"page","title":"An article","description":"Description","site":"Example","image":{"file_id":file,"sha256":digest,"bytes":bytes.len().to_string(),"width":1,"height":1,"media_type":"image/png"}}]);
    raw["messages"][0]["cards"] = serde_json::json!([{"author":"CI","title":"Build ready","url":"https://example.org/build","text":"Details","color":"#1177aa","fields":[{"title":"Commit","value":"abcdef","short":true}]}]);
    let current = Arc::new(Mutex::new(raw["messages"][0].clone()));
    let reads = Arc::new(AtomicUsize::new(0));
    let (remote, count) = (current.clone(), reads.clone());
    let server = runtime.block_on(http::FakeHttp::start(move |r| match r.path() {
        "/.well-known/rocketvibe" => http::respond(200, &discovery.to_string()),
        "/api/v1/me" => http::respond(200, &fixture["session"]["user"].to_string()),
        "/api/v1/sync/changes" => http::respond(
            200,
            &serde_json::json!({"protocol_version":1,"changes":[],"cursor":"opaque-fixture","has_more":false})
                .to_string(),
        ),
        "/api/v1/sync/ticket" => http::respond(200, &fixture["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => http::Response { websocket: true, ..Default::default() },
        "/api/v1/messages/message-id" => http::respond(200, &remote.lock().unwrap().to_string()),
        path if path.contains("/previews/") => {
            count.fetch_add(1, Ordering::SeqCst);
            http::Response {
                status: 200,
                binary: Some(bytes.clone()),
                headers: vec![("content-type".into(), "image/png".into())],
                ..Default::default()
            }
        }
        _ => http::respond(404, "{}"),
    }));
    let path = std::env::temp_dir().join(format!("gtk-previews-{}.sqlite", std::process::id()));
    let identity = Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() };
    let store = NativeStore::open(&path, identity.clone()).unwrap();
    store.snapshot(&serde_json::from_value(raw.clone()).unwrap()).unwrap();
    drop(store);
    let session = NativeSession::start(
        SessionInfo {
            mattermost: None,
            base_url: server.url.to_string(),
            user_id: "alice-id".into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity),
        },
        &path,
    )
    .unwrap();
    until(|| session.status().connection == Connection::Online);
    let row = session.store.messages("room-id", 10).unwrap().remove(0).presentation("room-id", "alice-id");
    let preview = rv_core::content::link_previews(row.urls.as_deref(), 3).remove(0);
    let integration = attachment_card(&rv_core::content::cards(row.attachments.as_deref()).remove(0));
    assert!(integration.has_css_class("attachment-card"));
    let provider = media::Provider::RocketVibe(session.clone());
    let card = link_preview_provider(provider.clone(), &preview);
    // An article card comes wrapped in the clamp that fits it to its natural width.
    let inner = card.downcast_ref::<adw::Clamp>().and_then(|c| c.child()).unwrap_or_else(|| card.clone());
    assert!(inner.has_css_class("link-card"));
    until(|| picture(&card).is_some_and(|p| p.paintable().is_some()));
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    let again = link_preview_provider(provider.clone(), &preview);
    until(|| picture(&again).is_some_and(|p| p.paintable().is_some()));
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    raw["rooms"][0]["read_state"]["membership_version"] = serde_json::json!("rejoined");
    raw["rooms"][0]["read_state"]["revision"] = serde_json::json!("2");
    session.store.snapshot(&serde_json::from_value(raw).unwrap()).unwrap();
    until(|| picture(&card).unwrap().paintable().is_none());
    assert!(provider.current(&format!("rv-preview:message-id/{file}")));
    let next = link_preview_provider(provider, &preview);
    until(|| picture(&next).is_some_and(|p| p.paintable().is_some()));
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    session.shutdown();
    drop((card, again, next));
    // Revocation watchers run on the GTK context and release their providers.
    until(|| Arc::strong_count(&session) == 1);
    runtime.block_on(http::close_native(session));
    std::fs::remove_file(path).unwrap();
}
