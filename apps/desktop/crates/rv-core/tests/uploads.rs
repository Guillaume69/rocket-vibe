mod common;

use std::sync::Arc;

use common::{FakeHttp, Request, Response, dropped, respond};
use rv_core::rest::{Credentials, RestClient};
use rv_core::store::Store;
use rv_core::sync::SyncEngine;
use rv_core::uploads::Uploads;
use serde_json::json;

const FILE_ID: &str = "file123";

fn confirmed() -> String {
    json!({"success": true, "message": {"_id": "m1", "rid": "r", "msg": "", "ts": {"$date": 1000},
        "_updatedAt": {"$date": 1001}, "u": {"_id": "me", "username": "me"},
        "attachments": [{"title": "a.txt", "title_link": format!("/file-upload/{FILE_ID}/a.txt")}]}})
    .to_string()
}

struct Fixture {
    server: FakeHttp,
    store: Arc<Store>,
    uploads: Arc<Uploads>,
    _dir: std::path::PathBuf,
    path: String,
}

async fn fixture(handler: impl Fn(&Request) -> Response + Send + Sync + 'static) -> Fixture {
    let server = FakeHttp::start(handler).await;
    let store = Arc::new(Store::in_memory().unwrap());
    let rest = RestClient::new(server.url.clone());
    rest.set_credentials(Some(Credentials { auth_token: "tok".into(), user_id: "me".into() }));
    let sync = Arc::new(SyncEngine::new(store.clone(), rest.clone(), "me", "me"));
    let uploads = Arc::new(Uploads::new(store.clone(), rest, sync));
    let dir = std::env::temp_dir().join(format!("rv-uploads-{:x}", fastrand::u64(..)));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("a.txt");
    std::fs::write(&path, b"hello upload").unwrap();
    Fixture { server, store, uploads, _dir: dir, path: path.to_string_lossy().into_owned() }
}

fn calls(server: &FakeHttp, suffix: &str) -> Vec<Request> {
    server.requests().into_iter().filter(|r| r.path().contains(suffix)).collect()
}

fn media_then_confirm(r: &Request) -> Response {
    if r.path().contains("rooms.media/") {
        respond(200, &json!({"success": true, "file": {"_id": FILE_ID, "url": "/x"}}).to_string())
    } else if r.path().contains("rooms.mediaConfirm/") {
        respond(200, &confirmed())
    } else {
        respond(404, "{}")
    }
}

#[tokio::test]
async fn two_steps_then_the_message() {
    let f = fixture(media_then_confirm).await;
    f.uploads.enqueue("r", &f.path, "a.txt", "text/plain", Some(" a caption "), false, None);
    f.uploads.process().await;
    let media = calls(&f.server, "rooms.media/r");
    assert_eq!(media.len(), 1);
    assert!(media[0].body.contains("hello upload"));
    assert!(media[0].headers["content-type"].starts_with("multipart/form-data"));
    let confirm = calls(&f.server, &format!("rooms.mediaConfirm/r/{FILE_ID}"));
    assert_eq!(confirm.len(), 1);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&confirm[0].body).unwrap(), json!({"msg": "a caption"}));
    assert!(f.store.uploads("r").is_empty());
    assert!(f.store.file_posted("r", FILE_ID));
    assert!(std::path::Path::new(&f.path).exists(), "a file the user picked is never deleted");
}

#[tokio::test]
async fn a_file_in_a_thread_is_confirmed_with_its_tmid() {
    let f = fixture(media_then_confirm).await;
    f.uploads.enqueue("r", &f.path, "a.txt", "text/plain", Some("in the thread"), false, Some("root1"));
    f.uploads.process().await;
    let confirm = calls(&f.server, &format!("rooms.mediaConfirm/r/{FILE_ID}"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&confirm[0].body).unwrap(),
        json!({"msg": "in the thread", "tmid": "root1"})
    );
}

#[tokio::test]
async fn a_known_file_id_already_posted_is_not_confirmed_again() {
    let f = fixture(|r| {
        if r.path().contains("channels.history") {
            respond(200, &json!({"success": true, "messages": [serde_json::from_str::<serde_json::Value>(&confirmed()).unwrap()["message"]]}).to_string())
        } else {
            respond(500, "{}")
        }
    })
    .await;
    f.store.write(|w| {
        w.upsert_room(&rv_core::normalize::Room {
            rid: "r".into(),
            kind: "c".into(),
            updated_at: 1,
            ..Default::default()
        })
    });
    f.uploads.enqueue("r", &f.path, "a.txt", "text/plain", None, true, None);
    let id = f.store.uploads("r")[0].id.clone();
    f.store.write(|w| w.set_upload_file_id(&id, FILE_ID));
    f.uploads.process().await;
    assert!(calls(&f.server, "rooms.mediaConfirm").is_empty());
    assert_eq!(calls(&f.server, "channels.history").len(), 1, "the room is refreshed once to find out");
    assert!(f.store.uploads("r").is_empty());
    assert!(!std::path::Path::new(&f.path).exists(), "our temporary copy goes once settled");
}

#[tokio::test]
async fn refused_fails_and_offline_waits() {
    let f = fixture(|r| {
        if r.path().contains("rooms.media/") {
            respond(400, &json!({"success": false, "error": "error-file-too-large"}).to_string())
        } else {
            dropped()
        }
    })
    .await;
    f.uploads.enqueue("r", &f.path, "a.txt", "text/plain", None, false, None);
    f.uploads.process().await;
    assert_eq!(f.store.uploads("r")[0].status, "failed");

    let g = fixture(|_| dropped()).await;
    g.uploads.enqueue("r", &g.path, "a.txt", "text/plain", None, false, None);
    g.uploads.process().await;
    assert_eq!(g.store.uploads("r")[0].status, "pending");
}

#[tokio::test]
async fn a_lost_connection_is_retried_without_waiting_for_the_socket() {
    let dropped_once = std::sync::atomic::AtomicBool::new(false);
    let f = fixture(move |r| {
        if r.path().contains("rooms.media/") && !dropped_once.swap(true, std::sync::atomic::Ordering::SeqCst) {
            dropped()
        } else {
            media_then_confirm(r)
        }
    })
    .await;
    f.uploads.enqueue("r", &f.path, "a.txt", "text/plain", None, false, None);
    f.uploads.process().await;
    assert_eq!(f.store.uploads("r")[0].status, "pending");
    assert!(f.uploads.reconnecting());
    for _ in 0..40 {
        if f.store.uploads("r").is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(f.store.uploads("r").is_empty(), "sent on the retry");
    assert_eq!(calls(&f.server, "rooms.media/r").len(), 2);
    assert!(!f.uploads.reconnecting());
}

#[tokio::test]
async fn discard_removes_the_row() {
    let f = fixture(media_then_confirm).await;
    f.uploads.enqueue("r", &f.path, "a.txt", "text/plain", None, false, None);
    let id = f.store.uploads("r")[0].id.clone();
    f.uploads.discard(&id);
    f.uploads.process().await;
    assert!(f.store.uploads("r").is_empty());
    assert!(f.server.requests().is_empty());
}

fn encrypted_room(store: &Store) {
    let room = rv_core::normalize::Room { rid: "r".into(), kind: "p".into(), encrypted: true, ..Default::default() };
    store.write(|w| w.upsert_room(&room));
}

#[tokio::test]
async fn encrypted_room_sends_the_file_encrypted_under_a_hashed_name() {
    let f = fixture(media_then_confirm).await;
    encrypted_room(&f.store);
    let payloads = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = payloads.clone();
    f.uploads.set_encryptor(move |_, payload| {
        seen.lock().unwrap().push(payload.clone());
        Some(json!({"sealed": true}))
    });
    f.uploads.enqueue("r", &f.path, "a.txt", "text/plain", Some("the caption"), false, None);
    f.uploads.process().await;

    let media = calls(&f.server, "rooms.media/r");
    assert_eq!(media.len(), 1);
    assert!(!media[0].body.contains("hello upload"), "the bytes never go up in clear");
    assert!(media[0].body.contains(&rv_core::e2e::hashed_name("a.txt")));
    assert!(!media[0].body.contains("a.txt\""), "nor the real name");
    assert!(media[0].body.contains("name=\"content\""));
    let confirm = calls(&f.server, &format!("rooms.mediaConfirm/r/{FILE_ID}"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&confirm[0].body).unwrap(),
        json!({"msg": "", "t": "e2e", "content": {"sealed": true}, "fileContent": {"sealed": true}})
    );
    let payloads = payloads.lock().unwrap();
    let message = payloads.iter().find(|p| p.get("attachments").is_some()).unwrap();
    assert_eq!(message["msg"], "the caption");
    let attachment = &message["attachments"][0];
    assert_eq!(attachment["title"], "a.txt");
    assert_eq!(attachment["title_link"], format!("/file-upload/{FILE_ID}/{}", rv_core::e2e::hashed_name("a.txt")));
    assert_eq!(attachment["encryption"]["key"]["alg"], "A256CTR");
    assert!(f.store.uploads("r").is_empty());
}

#[tokio::test]
async fn locked_encrypted_room_holds_the_file() {
    let f = fixture(media_then_confirm).await;
    encrypted_room(&f.store);
    f.uploads.set_encryptor(|_, _| None);
    f.uploads.enqueue("r", &f.path, "a.txt", "text/plain", None, false, None);
    f.uploads.process().await;
    assert!(calls(&f.server, "rooms.media").is_empty());
    assert_eq!(f.store.uploads("r").len(), 1);
}

fn room(store: &Store) {
    store.write(|w| {
        w.upsert_room(&rv_core::normalize::Room { rid: "r".into(), kind: "c".into(), ..Default::default() })
    });
}

fn history_with_file() -> Response {
    respond(
        200,
        &json!({"success": true, "messages": [
            serde_json::from_str::<serde_json::Value>(&confirmed()).unwrap()["message"]
        ]})
        .to_string(),
    )
}

#[tokio::test]
async fn lost_confirm_and_stale_or_failed_history_never_post_twice() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let reads = AtomicUsize::new(0);
    let f = fixture(move |r| {
        if r.path().contains("channels.history") {
            match reads.fetch_add(1, Ordering::SeqCst) {
                0 => respond(200, r#"{"success":true,"messages":[]}"#),
                1 => respond(502, "proxy timeout"),
                _ => history_with_file(),
            }
        } else if r.path().contains("rooms.mediaConfirm/") {
            dropped() // Accepted by Rocket.Chat, but the response was lost.
        } else {
            media_then_confirm(r)
        }
    })
    .await;
    room(&f.store);
    f.uploads.enqueue("r", &f.path, "screenshot.png", "image/png", None, true, None);
    f.uploads.process().await;
    // Empty and failed reads both leave delivery uncertain, never authorize POST.
    f.uploads.process().await;
    f.uploads.process().await;
    assert_eq!(calls(&f.server, "rooms.mediaConfirm/").len(), 1);
    assert_eq!(calls(&f.server, "rooms.media/").len(), 1);
    assert!(std::path::Path::new(&f.path).exists());
    assert_eq!(f.store.uploads("r")[0].status, "pending");
    f.uploads.process().await;
    assert!(f.store.uploads("r").is_empty());
    assert!(!std::path::Path::new(&f.path).exists());
    assert_eq!(calls(&f.server, "rooms.mediaConfirm/").len(), 1);
}

#[tokio::test]
async fn confirm_timeout_while_server_is_still_working_never_replays() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    let visible = Arc::new(AtomicBool::new(false));
    let seen = visible.clone();
    let f = fixture(move |r| {
        if r.path().contains("rooms.mediaConfirm/") {
            let visible = seen.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(17)).await;
                visible.store(true, Ordering::SeqCst);
            });
            Response { delay: Duration::from_secs(17), ..respond(200, &confirmed()) }
        } else if r.path().contains("channels.history") {
            if seen.load(Ordering::SeqCst) {
                history_with_file()
            } else {
                respond(200, r#"{"success":true,"messages":[]}"#)
            }
        } else {
            media_then_confirm(r)
        }
    })
    .await;
    room(&f.store);
    f.uploads.enqueue("r", &f.path, "screenshot.png", "image/png", None, false, None);
    f.uploads.process().await; // Real HTTP timeout at 15 seconds, server still active.
    assert!(!visible.load(Ordering::SeqCst));
    f.uploads.process().await;
    assert!(!f.store.uploads("r").is_empty());
    assert_eq!(calls(&f.server, "rooms.mediaConfirm/").len(), 1);
    tokio::time::sleep(Duration::from_secs(3)).await;
    f.uploads.process().await;
    assert!(f.store.uploads("r").is_empty());
    assert_eq!(calls(&f.server, "rooms.mediaConfirm/").len(), 1);
}

#[tokio::test]
async fn proxy_or_unreadable_confirm_reconciles_after_engine_restart() {
    for (status, body) in [(502, "proxy timeout"), (200, "truncated json")] {
        use std::sync::atomic::{AtomicBool, Ordering};
        let visible = Arc::new(AtomicBool::new(false));
        let seen = visible.clone();
        let f = fixture(move |r| {
            if r.path().contains("rooms.mediaConfirm/") {
                respond(status, body)
            } else if r.path().contains("channels.history") {
                if seen.load(Ordering::SeqCst) {
                    history_with_file()
                } else {
                    respond(200, r#"{"success":true,"messages":[]}"#)
                }
            } else {
                media_then_confirm(r)
            }
        })
        .await;
        room(&f.store);
        f.uploads.enqueue("r", &f.path, "screenshot.png", "image/png", None, false, None);
        f.uploads.process().await;
        let row = f.store.uploads("r")[0].clone();
        assert!(row.confirm_started);
        // Simulate a kill with a sending row, then a newly constructed engine.
        f.store.write(|w| w.set_upload_status(&row.id, "sending"));
        let rest = RestClient::new(f.server.url.clone());
        let sync = Arc::new(SyncEngine::new(f.store.clone(), rest.clone(), "me", "me"));
        let resumed = Arc::new(Uploads::new(f.store.clone(), rest, sync));
        resumed.process().await;
        assert_eq!(calls(&f.server, "rooms.mediaConfirm/").len(), 1);
        visible.store(true, Ordering::SeqCst);
        resumed.process().await;
        assert!(f.store.uploads("r").is_empty());
        assert_eq!(calls(&f.server, "rooms.mediaConfirm/").len(), 1);
    }
}

#[tokio::test]
async fn encrypted_confirm_is_not_replayed_with_or_without_its_in_memory_key() {
    let f = fixture(|r| {
        if r.path().contains("rooms.mediaConfirm/") {
            dropped()
        } else if r.path().contains("groups.history") {
            respond(200, r#"{"success":true,"messages":[]}"#)
        } else {
            media_then_confirm(r)
        }
    })
    .await;
    encrypted_room(&f.store);
    f.uploads.set_encryptor(|_, _| Some(json!({"sealed":true})));
    f.uploads.enqueue("r", &f.path, "a.txt", "text/plain", None, false, None);
    f.uploads.process().await;
    f.uploads.process().await;
    let rest = RestClient::new(f.server.url.clone());
    let sync = Arc::new(SyncEngine::new(f.store.clone(), rest.clone(), "me", "me"));
    let resumed = Arc::new(Uploads::new(f.store.clone(), rest, sync));
    resumed.set_encryptor(|_, _| Some(json!({"new_key":true})));
    resumed.process().await;
    assert_eq!(
        calls(&f.server, "rooms.media/").len(),
        1,
        "restart must not re-encrypt and re-upload an uncertain send"
    );
    assert_eq!(calls(&f.server, "rooms.mediaConfirm/").len(), 1);
}

#[tokio::test]
async fn a_definitive_confirm_refusal_can_be_explicitly_retried() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let refused = AtomicBool::new(false);
    let f = fixture(move |r| {
        if r.path().contains("rooms.mediaConfirm/") && !refused.swap(true, Ordering::SeqCst) {
            respond(400, r#"{"success":false,"error":"error-not-allowed"}"#)
        } else if r.path().contains("channels.history") {
            respond(200, r#"{"success":true,"messages":[]}"#)
        } else {
            media_then_confirm(r)
        }
    })
    .await;
    room(&f.store);
    f.uploads.enqueue("r", &f.path, "a.txt", "text/plain", None, false, None);
    f.uploads.process().await;
    let row = f.store.uploads("r")[0].clone();
    assert_eq!(row.status, "failed");
    assert!(!row.confirm_started);
    f.uploads.process().await;
    assert_eq!(calls(&f.server, "rooms.mediaConfirm/").len(), 1);
    f.uploads.retry(&row.id).await;
    assert!(f.store.uploads("r").is_empty());
    assert_eq!(calls(&f.server, "rooms.mediaConfirm/").len(), 2);
    assert_eq!(calls(&f.server, "rooms.media/").len(), 1);
}

#[tokio::test]
async fn an_uncertain_confirm_does_not_block_other_uploads() {
    let f = fixture(|r| {
        if r.path().contains("channels.history") {
            respond(200, r#"{"success":true,"messages":[]}"#)
        } else {
            media_then_confirm(r)
        }
    })
    .await;
    room(&f.store);
    f.uploads.enqueue("r", &f.path, "a.txt", "text/plain", None, false, None);
    let first = f.store.uploads("r")[0].id.clone();
    f.store.write(|w| {
        w.set_upload_file_id(&first, "uncertain-file");
        w.set_upload_confirm_started(&first, true);
    });
    f.uploads.enqueue("r", &f.path, "next.txt", "text/plain", None, false, None);
    f.uploads.process().await;
    assert_eq!(f.store.uploads("r").len(), 1);
    assert_eq!(f.store.uploads("r")[0].id, first);
    assert_eq!(calls(&f.server, "rooms.mediaConfirm/").len(), 1);
    assert!(f.store.file_posted("r", FILE_ID));
}
