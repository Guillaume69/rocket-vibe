use super::*;
use rv_core::{
    native::{Identity, NativeSession, store::NativeStore},
    session::SessionInfo,
};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

#[allow(clippy::duplicate_mod)]
#[path = "../../../rv-core/tests/common/mod.rs"]
mod http;

fn until(stage: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !check() {
        assert!(Instant::now() < deadline, "native room navigation timed out at {stage}");
        while glib::MainContext::default().iteration(false) {}
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "requires a GTK display; run under Xvfb"]
fn new_direct_and_public_rooms_open_after_sync_without_stealing_later_navigation() {
    gtk::init().unwrap();
    adw::init().unwrap();
    let executor = tokio::runtime::Runtime::new().unwrap();
    let _entered = executor.enter();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut discovery = fixture["discovery"].clone();
    discovery["capabilities"]["room_discovery"] = serde_json::json!(true);
    let initial = fixture["room"].clone();
    let mut other = initial.clone();
    other["id"] = serde_json::json!("other-room");
    other["name"] = serde_json::json!("Other room");
    let mut snapshot = fixture["snapshot"].clone();
    snapshot["rooms"] = serde_json::json!([initial, other]);
    snapshot["messages"] = serde_json::json!([]);
    // The HTTP receipt deliberately precedes the authoritative membership batch.
    let announced = Arc::new(Mutex::new(None::<serde_json::Value>));
    let receipt_seen = Arc::new(Mutex::new(String::new()));
    let (pending, seen) = (announced.clone(), receipt_seen.clone());
    let server = executor.block_on(http::FakeHttp::start(move |r| match (r.method.as_str(), r.path()) {
        (_, "/.well-known/rocketvibe") => http::respond(200, &discovery.to_string()),
        (_, "/api/v1/me") => http::respond(200, &fixture["session"]["user"].to_string()),
        (_, "/api/v1/sync/changes") => {
            let room = pending.lock().unwrap().take();
            let changes: Vec<_> =
                room.into_iter().map(|room| serde_json::json!({"type":"room_upsert","data":room})).collect();
            let delayed = !changes.is_empty();
            let mut reply = http::respond(
                200,
                &serde_json::json!({"protocol_version":1,"changes":changes,"cursor":"opaque-fixture","has_more":false})
                    .to_string(),
            );
            if delayed {
                reply.delay = Duration::from_millis(600);
            }
            reply
        }
        (_, "/api/v1/sync/ticket") => http::respond(200, &fixture["socket_ticket"].to_string()),
        (_, "/api/v1/sync/socket") => http::Response { websocket: true, ..Default::default() },
        ("POST", "/api/v1/direct-messages") => {
            let input: serde_json::Value = serde_json::from_str(&r.body).unwrap();
            let peer = input["user_id"].as_str().unwrap();
            *seen.lock().unwrap() = peer.to_owned();
            let room = serde_json::json!({"id":format!("dm-{peer}"),"name":peer,"kind":"direct","revision":"1"});
            *pending.lock().unwrap() = Some(room.clone());
            let mut reply = http::respond(200, &room.to_string());
            if peer == "late-peer" {
                reply.delay = Duration::from_millis(200);
            }
            reply
        }
        ("POST", "/api/v1/rooms/new-public/join") => {
            let room = serde_json::json!({"id":"new-public","name":"Joined public","kind":"public","revision":"1"});
            *pending.lock().unwrap() = Some(room.clone());
            http::respond(200, &room.to_string())
        }
        _ => http::respond(404, r#"{"code":"not_found","request_id":"fixture"}"#),
    }));
    let path = std::env::temp_dir().join(format!("gtk-navigation-{}.sqlite", std::process::id()));
    let identity = Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() };
    let store = NativeStore::open(&path, identity.clone()).unwrap();
    store.snapshot(&serde_json::from_value(snapshot).unwrap()).unwrap();
    drop(store);
    let session = NativeSession::start(
        SessionInfo {
            base_url: server.url.to_string(),
            user_id: "alice-id".into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity),
            mattermost: None,
        },
        &path,
    )
    .unwrap();
    until("initial session online", || session.status().connection == Connection::Online);
    let page = ChatPage::new();
    let window = gtk::Window::new();
    window.set_child(Some(page.root()));
    window.present();
    page.set_native_session(session.clone());
    page.open_room("room-id");
    assert_eq!(page.current_rid().as_deref(), Some("room-id"));
    page.go_to(rv_core::rooms::Found::User { id: "new-peer".into(), username: "new-peer".into(), name: None });
    until("direct receipt before membership", || page.native_pending_room.borrow().is_some());
    assert_eq!(page.current_rid().as_deref(), Some("room-id"), "a receipt alone grants no membership");
    until("direct membership hydration", || session.store.rooms().unwrap().iter().any(|r| r.id == "dm-new-peer"));
    page.on_native_rooms();
    assert_eq!(page.current_rid().as_deref(), Some("dm-new-peer"));
    page.go_to(rv_core::rooms::Found::Room { id: "new-public".into(), name: "Joined public".into(), kind: "c".into() });
    until("public join receipt before membership", || page.native_pending_room.borrow().is_some());
    until("public membership hydration", || session.store.rooms().unwrap().iter().any(|r| r.id == "new-public"));
    page.on_native_change();
    assert_eq!(page.current_rid().as_deref(), Some("new-public"));
    page.go_to(rv_core::rooms::Found::User { id: "late-peer".into(), username: "late-peer".into(), name: None });
    until("late direct request observed", || *receipt_seen.lock().unwrap() == "late-peer");
    page.user_navigation();
    page.open_room("other-room");
    until("late direct membership hydration", || session.store.rooms().unwrap().iter().any(|r| r.id == "dm-late-peer"));
    page.on_native_change();
    assert_eq!(
        page.current_rid().as_deref(),
        Some("other-room"),
        "late accepted commands cannot steal newer user navigation"
    );
    assert!(page.native_pending_room.borrow().is_none());
    page.set_session(None);
    gtk::prelude::GtkWindowExt::set_focus(&window, None::<&gtk::Widget>);
    window.close();
    drop(window);
    drop(page);
    session.shutdown();
    // History/access completions run on GLib and release their session there.
    // Keep that context moving before the Tokio-only shutdown assertion.
    until("GTK and worker session holders released", || Arc::strong_count(&session) == 1);
    executor.block_on(http::close_native(session));
    let _ = std::fs::remove_file(path);
}
