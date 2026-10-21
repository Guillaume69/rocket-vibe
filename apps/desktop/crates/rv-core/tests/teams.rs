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

#[tokio::test]
async fn send_edit_react_delete_and_mark_read() {
    let server = FakeHttp::start(|request: &Request| {
        assert_eq!(header(request, "authentication"), Some("skypetoken=skype-x"));
        match (request.method.as_str(), request.path().ends_with("/messages")) {
            ("POST", true) => respond(201, r#"{"OriginalArrivalTime":1792540504421}"#),
            ("GET", _) => respond(200, &message(500, "fetched").to_string()),
            _ => respond(200, ""),
        }
    })
    .await;
    let (store, sync) = sync(&server);
    let id = sync.send(ROOM, None, "hi <there>", "c-1").await.unwrap();
    assert_eq!(id, "1792540504421");
    let sent: Value = serde_json::from_str(&server.requests()[0].body).unwrap();
    assert_eq!(
        (sent["content"].as_str(), sent["clientmessageid"].as_str()),
        (Some("<p>hi &lt;there&gt;</p>"), Some("c-1"))
    );

    let msg = format!("{ROOM}/500");
    sync.react(&msg, ":thumbsup:", true).await.unwrap();
    sync.react(&msg, "thumbsup", false).await.unwrap();
    assert!(sync.react(&msg, "fire", true).await.is_err(), "only Teams' own reactions are sent");
    sync.edit(&msg, "changed").await.unwrap();
    sync.delete(&msg).await.unwrap();
    let requests = server.requests();
    let reacts: Vec<&Request> = requests.iter().filter(|r| r.target.contains("name=emotions")).collect();
    assert_eq!(reacts.len(), 2);
    assert_eq!((reacts[0].method.as_str(), reacts[1].method.as_str()), ("PUT", "DELETE"));
    assert_eq!(serde_json::from_str::<Value>(&reacts[0].body).unwrap()["emotions"]["key"], "like");
    assert!(
        requests.iter().any(|r| r.method == "PUT" && r.path().ends_with("/messages/500") && r.body.contains("changed"))
    );
    assert!(requests.iter().any(|r| r.method == "DELETE" && r.path().ends_with("/messages/500")));

    assert!(store.messages(ROOM, 50).iter().any(|m| m.id == msg), "the reaction answer was stored");
    sync.mark_read(ROOM).await.unwrap();
    sync.mark_read(ROOM).await.unwrap();
    let marks: Vec<Request> =
        server.requests().into_iter().filter(|r| r.target.contains("name=consumptionhorizon")).collect();
    assert_eq!(marks.len(), 1, "an unchanged room is not marked twice");
    let horizon =
        serde_json::from_str::<Value>(&marks[0].body).unwrap()["consumptionhorizon"].as_str().unwrap().to_owned();
    assert!(horizon.starts_with("500;") && horizon.ends_with(";500"), "{horizon}");
}

#[tokio::test]
async fn pushed_messages_update_the_room_and_only_others_notify() {
    let url = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let shared = url.clone();
    let server = FakeHttp::start(move |r| handler(shared.lock().unwrap().clone())(r)).await;
    *url.lock().unwrap() = server.url.to_string();
    let (store, sync) = sync(&server);
    sync.catch_up_global().await.unwrap();

    let link = format!("https://x/v1/users/ME/conversations/{ROOM}");
    let mut theirs = message(1792540600000, "pushed");
    theirs["conversationLink"] = json!(link);
    let notified = sync.apply_event("NewMessage", &theirs).await.expect("a new message from Bob");
    assert_eq!(notified.text.as_deref(), Some("pushed"));
    let room = store.rooms().into_iter().find(|r| r.rid == ROOM).unwrap();
    assert_eq!((room.last_message.as_deref(), room.alert), (Some("pushed"), true));
    assert!(sync.apply_event("NewMessage", &theirs).await.is_none(), "the same message twice notifies once");

    let mut mine = message(1792540610000, "mine");
    mine["conversationLink"] = json!(link);
    mine["from"] = json!(format!("https://x/v1/users/ME/contacts/{ME}"));
    assert!(sync.apply_event("NewMessage", &mine).await.is_none());
    assert!(!store.rooms().into_iter().find(|r| r.rid == ROOM).unwrap().alert, "my own message reads the room");

    let mut gone = message(1792540600000, "");
    gone["conversationLink"] = json!(link);
    gone["properties"] = json!({"deletetime": "1"});
    assert!(sync.apply_event("MessageUpdate", &gone).await.is_none());
    assert!(!store.messages(ROOM, 50).iter().any(|m| m.id == format!("{ROOM}/1792540600000")));
}
