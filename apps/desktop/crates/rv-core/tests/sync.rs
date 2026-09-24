mod common;

use std::sync::Arc;

use common::{FakeHttp, Request, Response, respond};
use rv_core::normalize::{Message, Room, Subscription};
use rv_core::rest::{Credentials, RestClient};
use rv_core::store::Store;
use rv_core::sync::SyncEngine;
use serde_json::json;

async fn engine(handler: impl Fn(&Request) -> Response + Send + Sync + 'static) -> (FakeHttp, Arc<Store>, SyncEngine) {
    let server = FakeHttp::start(handler).await;
    let store = Arc::new(Store::in_memory().unwrap());
    let rest = RestClient::new(server.url.clone());
    rest.set_credentials(Some(Credentials { auth_token: "tok".into(), user_id: "me".into() }));
    let sync = SyncEngine::new(store.clone(), rest, "me", "me");
    (server, store, sync)
}

fn message(id: &str, text: &str, updated_at: i64) -> Message {
    Message {
        id: id.into(),
        rid: "r".into(),
        text: Some(text.into()),
        ts: 1000,
        author_id: "u".into(),
        updated_at,
        ..Default::default()
    }
}

fn param<'a>(r: &'a Request, key: &str) -> Option<&'a str> {
    r.target.split_once('?')?.1.split('&').find_map(|p| p.strip_prefix(&format!("{key}=")))
}

#[tokio::test]
async fn room_catch_up_applies_edits_then_deletions() {
    let (server, store, sync) = engine(|r| {
        let doc = json!({"_id":"m1","rid":"r","msg":"edited","ts":{"$date":1000},"_updatedAt":{"$date":5000},"u":{"_id":"u"}});
        match param(r, "type") {
            Some("UPDATED") => respond(200, &json!({"success":true,"result":{"updated":[doc],"cursor":{"next":null}}}).to_string()),
            Some("DELETED") => respond(
                200,
                &json!({"success":true,"result":{"deleted":[{"_id":"m2","_deletedAt":{"$date":6000}}],"cursor":{"next":null}}}).to_string(),
            ),
            _ => respond(400, "{}"),
        }
    })
    .await;
    store.write(|w| {
        w.upsert_message(&message("m1", "original", 1000));
        w.upsert_message(&message("m2", "doomed", 1000));
        w.write_cursor("r", "messages", 1000);
    });
    sync.catch_up_room("r").await.unwrap();
    let texts: Vec<String> = store.messages("r", 10).iter().filter_map(|m| m.text.clone()).collect();
    assert_eq!(texts, ["edited", "doomed"], "the first pass only arms the deletions cursor");
    assert_eq!(store.cursor("r", "messages"), Some(5000));
    sync.catch_up_room("r").await.unwrap();
    let texts: Vec<String> = store.messages("r", 10).iter().filter_map(|m| m.text.clone()).collect();
    assert_eq!(texts, ["edited"]);
    let kinds: Vec<String> = server.requests().iter().filter_map(|r| param(r, "type").map(str::to_owned)).collect();
    assert_eq!(kinds, ["UPDATED", "UPDATED", "DELETED"]);
}

#[tokio::test]
async fn a_room_without_cursor_is_left_alone() {
    let (server, _store, sync) = engine(|_| respond(500, "{}")).await;
    sync.catch_up_room("r").await.unwrap();
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn reconciliation_purges_rooms_gone_from_the_server() {
    let (_server, store, sync) =
        engine(|_| respond(200, &json!({"success":true,"update":[{"rid":"kept","_id":"s1"}],"remove":[]}).to_string()))
            .await;
    store.write(|w| {
        for rid in ["kept", "gone"] {
            w.upsert_room(&Room { rid: rid.into(), kind: "c".into(), updated_at: 1, ..Default::default() });
            w.upsert_subscription(&Subscription { rid: rid.into(), open: true, updated_at: 1, ..Default::default() });
        }
    });
    sync.reconcile_rooms().await.unwrap();
    let rooms: Vec<String> = store.rooms().into_iter().map(|r| r.rid).collect();
    assert_eq!(rooms, ["kept"]);

    let (_server, store, sync) = engine(|_| respond(200, &json!({"success":true,"update":[]}).to_string())).await;
    store.write(|w| {
        w.upsert_room(&Room { rid: "kept".into(), kind: "c".into(), updated_at: 1, ..Default::default() });
        w.upsert_subscription(&Subscription { rid: "kept".into(), open: true, updated_at: 1, ..Default::default() });
    });
    sync.reconcile_rooms().await.unwrap();
    assert_eq!(store.rooms().len(), 1, "an empty list is not trusted");
}
