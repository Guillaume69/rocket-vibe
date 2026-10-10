mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{FakeHttp, Request, Response, dropped, respond};
use rv_core::outbox::Outbox;
use rv_core::rest::{Credentials, RestClient};
use rv_core::store::Store;
use rv_core::sync::SyncEngine;
use serde_json::json;

const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";

fn server_message(id: &str) -> String {
    json!({"success": true, "message": {"_id": id, "rid": "r", "msg": "hello", "ts": {"$date": 1000},
        "_updatedAt": {"$date": 1001}, "u": {"_id": "me", "username": "me"}}})
    .to_string()
}

struct Fixture {
    server: FakeHttp,
    store: Arc<Store>,
    outbox: Outbox,
}

async fn fixture(handler: impl Fn(&Request) -> Response + Send + Sync + 'static) -> Fixture {
    let server = FakeHttp::start(handler).await;
    let store = Arc::new(Store::in_memory().unwrap());
    let rest = RestClient::new(server.url.clone());
    rest.set_credentials(Some(Credentials { auth_token: "tok".into(), user_id: "me".into() }));
    let sync = Arc::new(SyncEngine::new(store.clone(), rest.clone(), "me", "me"));
    let outbox = Outbox::new(store.clone(), rest, sync, "me", "me");
    outbox.set_id_generator(|| ID.to_owned());
    Fixture { server, store, outbox }
}

fn scalar(store: &Store, sql: &str) -> Option<String> {
    store.read(|c| c.query_row(sql, [], |r| r.get::<_, Option<String>>(0))).ok().flatten()
}

fn count(store: &Store, sql: &str) -> i64 {
    store.read(|c| c.query_row(sql, [], |r| r.get(0))).unwrap()
}

fn sends(server: &FakeHttp) -> usize {
    server.requests().iter().filter(|r| r.path().ends_with("chat.sendMessage")).count()
}

#[tokio::test]
async fn send_shows_optimistic_row_then_reconciles() {
    let f = fixture(|_| respond(200, &server_message(ID))).await;
    f.outbox.enqueue("r", "hello", None);
    assert_eq!(count(&f.store, "SELECT updated_at FROM messages"), 0);
    f.outbox.process().await;
    assert_eq!(count(&f.store, "SELECT COUNT(*) FROM outbox"), 0);
    assert_eq!(count(&f.store, "SELECT updated_at FROM messages"), 1001);
    let body: serde_json::Value = serde_json::from_str(&f.server.requests()[0].body).unwrap();
    assert_eq!(body["message"]["_id"], ID);
}

#[tokio::test]
async fn a_reply_also_sent_to_the_room_shows_there_and_leaves_with_tshow() {
    let up = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = up.clone();
    let f = fixture(move |_| {
        if flag.load(std::sync::atomic::Ordering::SeqCst) { respond(200, &server_message(ID)) } else { dropped() }
    })
    .await;
    f.outbox.enqueue_reply("r", "hello", Some("root"), true);
    let shown = f.store.messages("r", 10);
    assert_eq!(shown.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), [ID], "in the room at once");
    // Offline: the replay keeps `tshow`.
    f.outbox.process().await;
    up.store(true, std::sync::atomic::Ordering::SeqCst);
    f.outbox.process().await;
    let sent = f.server.requests().into_iter().rfind(|r| r.path().ends_with("chat.sendMessage")).unwrap();
    let body: serde_json::Value = serde_json::from_str(&sent.body).unwrap();
    assert_eq!((body["message"]["tmid"].as_str(), body["message"]["tshow"].as_bool()), (Some("root"), Some(true)));
    assert_eq!(count(&f.store, "SELECT COUNT(*) FROM outbox"), 0);
}

#[tokio::test]
async fn a_thread_reply_stays_out_of_the_room_and_sends_no_tshow() {
    let f = fixture(|_| respond(200, &server_message(ID))).await;
    f.outbox.enqueue_reply("r", "hello", Some("root"), false);
    assert!(f.store.messages("r", 10).is_empty());
    f.outbox.process().await;
    let body: serde_json::Value = serde_json::from_str(&f.server.requests()[0].body).unwrap();
    assert_eq!(body["message"]["tshow"], serde_json::Value::Null);
}

#[tokio::test]
async fn refusal_that_was_delivered_is_not_a_failure() {
    let f = fixture(|r| {
        if r.path().ends_with("chat.sendMessage") {
            respond(400, r#"{"success":false,"error":"Cannot read properties of undefined (reading 'starred')"}"#)
        } else {
            respond(200, &server_message(ID))
        }
    })
    .await;
    f.outbox.enqueue("r", "hello", None);
    f.outbox.process().await;
    assert_eq!(count(&f.store, "SELECT COUNT(*) FROM outbox"), 0);
    assert_eq!(count(&f.store, "SELECT updated_at FROM messages"), 1001);
}

#[tokio::test]
async fn refusal_that_was_not_delivered_fails() {
    let f = fixture(|_| respond(400, r#"{"success":false,"error":"error-not-allowed"}"#)).await;
    f.outbox.enqueue("r", "hello", None);
    f.outbox.process().await;
    assert_eq!(scalar(&f.store, "SELECT status FROM outbox").as_deref(), Some("failed"));
}

#[tokio::test]
async fn server_error_keeps_pending_and_retry_resends() {
    // A proxy's 502 while the server restarts answers both the send and the
    // lookup: no verdict, so the row waits instead of turning "not sent".
    let up = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = up.clone();
    let f = fixture(move |_| {
        if flag.load(std::sync::atomic::Ordering::SeqCst) {
            respond(200, &server_message(ID))
        } else {
            respond(502, "<html>Bad Gateway</html>")
        }
    })
    .await;
    f.outbox.enqueue("r", "hello", None);
    f.outbox.process().await;
    assert_eq!(scalar(&f.store, "SELECT status FROM outbox").as_deref(), Some("pending"));

    up.store(true, std::sync::atomic::Ordering::SeqCst);
    f.outbox.process().await;
    assert_eq!(count(&f.store, "SELECT COUNT(*) FROM outbox"), 0);
}

#[tokio::test]
async fn unreachable_keeps_pending_and_retry_resends() {
    let online = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = online.clone();
    let f = fixture(move |_| {
        if flag.load(std::sync::atomic::Ordering::SeqCst) { respond(200, &server_message(ID)) } else { dropped() }
    })
    .await;
    f.outbox.enqueue("r", "hello", None);
    f.outbox.process().await;
    assert_eq!(scalar(&f.store, "SELECT status FROM outbox").as_deref(), Some("pending"));

    online.store(true, std::sync::atomic::Ordering::SeqCst);
    f.outbox.process().await;
    assert_eq!(count(&f.store, "SELECT COUNT(*) FROM outbox"), 0);
}

#[tokio::test]
async fn unknown_verdict_stops_the_pass() {
    let f = fixture(|r| {
        if r.path().ends_with("chat.sendMessage") {
            respond(400, r#"{"success":false,"error":"x"}"#)
        } else {
            dropped()
        }
    })
    .await;
    let n = std::sync::atomic::AtomicUsize::new(0);
    f.outbox.set_id_generator(move || format!("{:024}", n.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    f.outbox.enqueue("r", "one", None);
    f.outbox.enqueue("r", "two", None);
    tokio::time::timeout(Duration::from_secs(10), f.outbox.process()).await.unwrap();
    assert_eq!(sends(&f.server), 1);
    assert_eq!(count(&f.store, "SELECT COUNT(*) FROM outbox WHERE status = 'pending'"), 2);
}

fn encrypted_room(store: &Store) {
    let room = rv_core::normalize::Room { rid: "r".into(), kind: "p".into(), encrypted: true, ..Default::default() };
    store.write(|w| w.upsert_room(&room));
}

#[tokio::test]
async fn encrypted_room_sends_content_never_text() {
    let f = fixture(|_| respond(200, &server_message(ID))).await;
    encrypted_room(&f.store);
    f.outbox.set_encryptor(|rid, payload| Some(json!({"kid": rid, "ciphertext": payload["msg"]})));
    f.outbox.enqueue("r", "hi @bob", Some("root"));
    assert_eq!(scalar(&f.store, "SELECT system_type FROM messages").as_deref(), Some("e2e"));
    f.outbox.process().await;
    let body: serde_json::Value = serde_json::from_str(&f.server.requests()[0].body).unwrap();
    let message = &body["message"];
    assert_eq!(message["msg"], serde_json::Value::Null);
    assert_eq!(
        (message["t"].as_str(), message["e2e"].as_str(), message["tmid"].as_str()),
        (Some("e2e"), Some("pending"), Some("root"))
    );
    assert_eq!(message["content"], json!({"kid": "r", "ciphertext": "hi @bob"}));
    assert_eq!(message["e2eMentions"]["e2eUserMentions"], json!(["@bob"]));
    assert_eq!(count(&f.store, "SELECT COUNT(*) FROM outbox"), 0);
}

#[tokio::test]
async fn locked_encrypted_room_waits_without_failing() {
    let f = fixture(|_| respond(200, &server_message(ID))).await;
    encrypted_room(&f.store);
    f.outbox.enqueue("r", "secret", None);
    f.outbox.process().await;
    f.outbox.set_encryptor(|_, _| None);
    f.outbox.process().await;
    assert_eq!(sends(&f.server), 0);
    assert_eq!(scalar(&f.store, "SELECT status FROM outbox").as_deref(), Some("pending"));
    f.outbox.set_encryptor(|_, payload| Some(payload.clone()));
    f.outbox.process().await;
    assert_eq!(sends(&f.server), 1);
}
