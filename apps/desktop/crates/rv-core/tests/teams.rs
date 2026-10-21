//! A Teams account against a fake aggregator and chat service: the list with
//! its read state, history paged through the backward link, a room catch-up,
//! and the token each service is sent.
mod common;

use std::sync::Arc;

use common::{FakeHttp, Request, Response, respond};
use rv_core::session::SessionInfo;
use rv_core::store::Store;
use rv_core::teams::auth::{Routes, TeamsAccount, Tokens};
use rv_core::teams::sync::TeamsSync;
use serde_json::{Value, json};
use zeroize::Zeroizing;

const ME: &str = "8:orgid:00000000-0000-4000-8000-0000000000aa";
const ROOM: &str = "19:chat@thread.v2";

fn info() -> SessionInfo {
    SessionInfo {
        base_url: rv_core::teams::auth::ORIGIN.into(),
        user_id: ME.into(),
        username: "Me".into(),
        auth_token: String::new(),
        native: None,
        mattermost: None,
        slack: None,
        teams: Some(TeamsAccount {
            tenant_id: "00000000-0000-4000-8000-000000000001".into(),
            refresh: Zeroizing::new("synthetic-refresh".into()),
        }),
    }
}

fn message(id: i64, text: &str) -> Value {
    json!({
        "id": id.to_string(), "messagetype": "RichText/Html", "contenttype": "text",
        "content": format!("<p>{text}</p>"), "from": "https://x/v1/users/ME/contacts/8:orgid:bob",
        "imdisplayname": "Bob", "originalarrivaltime": chrono::DateTime::from_timestamp_millis(id).unwrap().to_rfc3339(),
        "version": id.to_string(),
    })
}

fn sync(server: &FakeHttp) -> (Arc<Store>, TeamsSync) {
    let base = server.url.as_str().trim_end_matches('/');
    let routes = Routes {
        chat: format!("{base}/api/chatsvc/fr"),
        aggregator: format!("{base}/api/csa/emea"),
        ..Default::default()
    };
    let tokens = Tokens::preset(&info(), routes, "skype-x", "agg-y").unwrap();
    let store = Arc::new(Store::in_memory().unwrap());
    (store.clone(), TeamsSync::new(store, tokens, ME, "Me"))
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn handler(server_url: String) -> impl Fn(&Request) -> Response + Send + Sync + 'static {
    move |request: &Request| {
        let path = request.path();
        if path.starts_with("/api/csa/") {
            assert_eq!(header(request, "authorization"), Some("Bearer agg-y"));
            return respond(
                200,
                &json!({
                    "chats": [{"id": ROOM, "chatType": "chat", "isOneOnOne": true, "isRead": false,
                        "members": [{"mri": ME}, {"mri": "8:orgid:bob"}],
                        "lastMessage": {"messageType": "RichText/Html", "content": "<p>new</p>", "from": "8:orgid:bob",
                            "imDisplayName": "Bob", "composeTime": "2026-10-20T10:00:00Z", "id": "300"}}],
                    "teams": [{"id": "team", "displayName": "Ops", "channels": [
                        {"id": "19:general@thread.tacv2", "displayName": "General", "isMessageRead": true}]}],
                })
                .to_string(),
            );
        }
        assert_eq!(header(request, "authentication"), Some("skypetoken=skype-x"));
        assert!(path.contains("/conversations/19:chat@thread.v2/messages"), "{path}");
        let query = request.target.split_once('?').map(|(_, q)| q).unwrap_or_default();
        if query.contains("syncState=older") {
            return respond(200, &json!({"messages": [message(100, "first")], "_metadata": {}}).to_string());
        }
        if query.contains("startTime=200") {
            return respond(
                200,
                &json!({"messages": [message(300, "new"), message(200, "second edited")]}).to_string(),
            );
        }
        let back = format!("{}api/chatsvc/fr/v1/users/ME/conversations/{ROOM}/messages?syncState=older", server_url);
        let mut gone = message(250, "");
        gone["properties"] = json!({"deletetime": "251"});
        respond(
            200,
            &json!({"messages": [gone, message(200, "second")], "_metadata": {"backwardLink": back}}).to_string(),
        )
    }
}

#[tokio::test]
async fn the_list_history_and_catch_up() {
    let url = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let shared = url.clone();
    let server = FakeHttp::start(move |r| handler(shared.lock().unwrap().clone())(r)).await;
    *url.lock().unwrap() = server.url.to_string();
    let (store, sync) = sync(&server);

    sync.catch_up_global().await.unwrap();
    let rooms = store.rooms();
    let chat = rooms.iter().find(|r| r.rid == ROOM).expect("the chat");
    assert_eq!((chat.name.as_str(), chat.alert), ("Bob", true));
    let general = rooms.iter().find(|r| r.rid == "19:general@thread.tacv2").expect("the channel");
    assert_eq!((general.group_name.as_deref(), general.alert), (Some("Ops"), false));

    let page = sync.load_history(ROOM, None).await.unwrap();
    assert_eq!(page.count, 2);
    let ids: Vec<String> = store.messages(ROOM, 50).into_iter().map(|m| m.id).collect();
    assert_eq!(ids, vec![format!("{ROOM}/200")], "the deleted message is not stored");

    let older = sync.load_history(ROOM, Some(200)).await.unwrap();
    assert_eq!(older.count, 1);
    assert!(store.messages(ROOM, 50).iter().any(|m| m.id == format!("{ROOM}/100")));

    sync.catch_up_room(ROOM).await.unwrap();
    let texts: Vec<Option<String>> = store.messages(ROOM, 50).into_iter().map(|m| m.text).collect();
    assert!(texts.contains(&Some("new".into())) && texts.contains(&Some("second edited".into())), "{texts:?}");
    assert!(server.requests().iter().any(|r| r.target.contains("startTime=200")));
}
