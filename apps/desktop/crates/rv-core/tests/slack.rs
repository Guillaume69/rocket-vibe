//! A saved Slack account against a fake Web API: sign-in and its secret, the
//! refusals that end a session, the conversation list, the history paged by
//! exact `ts`, threads, and a session that never speaks another server's API.
mod common;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use common::{FakeHttp, Request, Response, dropped, respond};
use rv_core::rest::{RestClient, is_token_rejected};
use rv_core::session::{Session, SessionEvent, SessionInfo};
use rv_core::slack::sync::SlackSync;
use rv_core::slack::{METHODS, SlackAccount};
use rv_core::store::Store;
use serde_json::{Value, json};
use zeroize::Zeroizing;

const TOKEN: &str = "xoxc-000-synthetic";
const COOKIE: &str = "xoxd-synthetic%2Fbytes%3D%3D";

fn form(request: &Request) -> HashMap<String, String> {
    url::form_urlencoded::parse(request.body.as_bytes()).into_owned().collect()
}

fn method(request: &Request) -> &str {
    request.path().trim_start_matches("/api/")
}

fn ok(body: Value) -> Response {
    let mut body = body;
    body["ok"] = json!(true);
    respond(200, &body.to_string())
}

fn auth() -> Response {
    ok(json!({"url": "https://t000.slack.com/", "team": "Team", "user": "me", "team_id": "T000", "user_id": "U000"}))
}

fn user(id: &str, name: &str) -> Value {
    json!({"id": id, "name": name, "profile": {"display_name": name.to_uppercase(), "image_72": format!("https://avatars.example.test/{id}.png")}})
}

fn sync(server: &FakeHttp) -> (Arc<Store>, SlackSync) {
    let store = Arc::new(Store::in_memory().unwrap());
    let rest = RestClient::slack(server.url.clone(), Zeroizing::new(COOKIE.to_owned()));
    rest.set_credentials(Some(rv_core::rest::Credentials { auth_token: TOKEN.into(), user_id: "U000".into() }));
    (store.clone(), SlackSync::new(store, rest, "U000", "me"))
}

#[tokio::test]
async fn sign_in_checks_the_identity_and_the_secret_round_trips() {
    let server = FakeHttp::start(|_| auth()).await;
    let info = rv_core::slack::login_at(&server.url, TOKEN, COOKIE, None).await.unwrap();
    assert_eq!(
        (info.base_url.as_str(), info.user_id.as_str(), info.username.as_str()),
        ("https://t000.slack.com", "U000", "me")
    );
    let account = info.slack.clone().unwrap();
    assert_eq!((account.team_id.as_str(), account.cookie.as_str()), ("T000", COOKIE));
    let request = &server.requests()[0];
    assert_eq!((request.method.as_str(), request.path()), ("POST", "/api/auth.test"));
    assert_eq!(request.headers["authorization"], format!("Bearer {TOKEN}"));
    assert_eq!(request.headers["cookie"], format!("d={COOKIE}"));
    assert!(request.headers["content-type"].starts_with("application/x-www-form-urlencoded"));

    assert_eq!(info.genre(), "slack");
    let secret = info.secret();
    assert_eq!(SessionInfo::from_secret(&secret), Some(info.clone()));
    assert!(!format!("{info:?}").contains(COOKIE) && !format!("{info:?}").contains(TOKEN));
    for (key, value) in [
        ("baseUrl", json!("https://t000.slack.com.evil.test")),
        ("baseUrl", json!("http://t000.slack.com")),
        ("slackCookie", json!("xoxd-a; b=c")),
        ("slackTeamId", json!("t000")),
        ("authToken", json!("xoxb-bot")),
    ] {
        let mut forged = secret.clone();
        forged[key] = value;
        assert!(SessionInfo::from_secret(&forged).is_none(), "{key}");
    }

    let mismatch = rv_core::slack::login_at(&server.url, TOKEN, COOKIE, Some(("T999", "U000"))).await.unwrap_err();
    assert_eq!(mismatch.error.as_deref(), Some("identity_mismatch"));
    let before = server.requests().len();
    let refused = rv_core::slack::login_at(&server.url, "xoxp-not-a-session", COOKIE, None).await.unwrap_err();
    assert_eq!(refused.error.as_deref(), Some("invalid_credentials"));
    assert_eq!(server.requests().len(), before, "nothing leaves for malformed credentials");
}

#[tokio::test]
async fn only_slack_refusals_end_a_session() {
    for code in ["not_authed", "invalid_auth", "token_expired", "token_revoked", "account_inactive"] {
        let server = FakeHttp::start(move |_| respond(200, &json!({"ok": false, "error": code}).to_string())).await;
        let error = rv_core::slack::login_at(&server.url, TOKEN, COOKIE, None).await.unwrap_err();
        assert!(is_token_rejected(&error), "{code}");
    }
    let answers: [fn() -> Response; 5] = [
        || respond(200, "<html>Sign in</html>"),
        || respond(503, r#"{"ok":false,"error":"invalid_auth"}"#),
        || respond(401, r#"{"message":"Unauthorized"}"#),
        || respond(200, r#"{"ok":false,"error":"channel_not_found"}"#),
        dropped,
    ];
    for answer in answers {
        let server = FakeHttp::start(move |_| answer()).await;
        let error = rv_core::slack::login_at(&server.url, TOKEN, COOKIE, None).await.unwrap_err();
        assert!(!is_token_rejected(&error), "{error:?}");
    }

    let limited = FakeHttp::queue(vec![
        Response { status: 429, headers: vec![("Retry-After".into(), "1".into())], ..Default::default() },
        auth(),
    ])
    .await;
    rv_core::slack::login_at(&limited.url, TOKEN, COOKIE, None).await.unwrap();
    assert_eq!(limited.requests().len(), 2, "one retry after the rate limit");

    let revoked = FakeHttp::start(|_| respond(200, r#"{"ok":false,"error":"token_revoked"}"#)).await;
    let dir = tempfile::tempdir().unwrap();
    let session = Session::start(info(&revoked), &dir.path().join("slack.sqlite")).unwrap();
    let mut events = session.events();
    session.reconnect_now();
    let expired = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(SessionEvent::Expired) = events.recv().await {
                return;
            }
        }
    })
    .await;
    assert!(expired.is_ok(), "a revoked token signs the session out");
    session.shutdown();
    session.store.close();
}

fn info(server: &FakeHttp) -> SessionInfo {
    SessionInfo {
        base_url: server.url.to_string().trim_end_matches('/').to_owned(),
        user_id: "U000".into(),
        username: "me".into(),
        auth_token: TOKEN.into(),
        native: None,
        mattermost: None,
        slack: Some(SlackAccount { team_id: "T000".into(), cookie: Zeroizing::new(COOKIE.into()) }),
    }
}

fn workspace(request: &Request) -> Response {
    let form = form(request);
    match method(request) {
        "auth.test" => auth(),
        "rtm.connect" => respond(200, r#"{"ok":false,"error":"missing_scope"}"#),
        "emoji.list" => {
            ok(json!({"emoji": {"issou": "https://emoji.slack-edge.com/T000/issou/a.png", "ris": "alias:issou"}}))
        }
        "chat.postMessage" => {
            let ts = "1700000500.000001";
            ok(json!({"channel": form["channel"], "ts": ts,
                "message": {"type": "message", "user": "U000", "text": form["text"], "ts": ts, "client_msg_id": form["client_msg_id"]}}))
        }
        "chat.update" => ok(json!({"channel": form["channel"], "ts": form["ts"],
            "message": {"type": "message", "user": "U000", "text": form["text"], "edited": {"ts": "1700000600.000000"}}})),
        "chat.delete" | "reactions.add" | "conversations.mark" => ok(json!({})),
        "reactions.remove" => respond(200, r#"{"ok":false,"error":"no_reaction"}"#),
        "users.conversations" => match form.get("cursor").map(String::as_str) {
            None => ok(json!({
                "channels": [
                    {"id": "C001", "name": "general", "is_channel": true, "updated": 1_700_000_000_000_i64},
                    {"id": "D001", "is_im": true, "user": "U001"},
                ],
                "response_metadata": {"next_cursor": "page2"},
            })),
            Some("page2") => ok(json!({
                "channels": [
                    {"id": "G001", "is_mpim": true, "name": "mpdm-me--alice--bob-1"},
                    {"id": "C002", "name": "ops", "is_private": true},
                ],
                "response_metadata": {"next_cursor": ""},
            })),
            Some(other) => panic!("unexpected cursor {other}"),
        },
        "client.counts" => ok(json!({
            "channels": [
                {"id": "C001", "has_unreads": true, "mention_count": 2, "latest": "1700000300.000100", "last_read": "1700000100.000000"},
                {"id": "C002", "has_unreads": false, "mention_count": 0, "latest": "1700000100.000000"},
            ],
            "mpims": [{"id": "G001", "has_unreads": true, "mention_count": 0, "latest": "1700000200.000000"}],
            "ims": [{"id": "D001", "has_unreads": false, "mention_count": 0, "latest": "1700000250.000000"}],
        })),
        "conversations.history" => {
            let channel = form["channel"].clone();
            ok(
                json!({"messages": [{"ts": "1700000300.000100", "user": "U001", "text": format!("newest in {channel} <@U002>")}], "has_more": false}),
            )
        }
        "users.info" => {
            let id = form["user"].clone();
            let name = match id.as_str() {
                "U000" => "me",
                "U001" => "alice",
                "U002" => "bob",
                _ => return respond(200, r#"{"ok":false,"error":"user_not_found"}"#),
            };
            ok(json!({"user": user(&id, name)}))
        }
        other => panic!("unexpected method {other}"),
    }
}

#[tokio::test]
async fn the_list_pages_by_cursor_and_maps_counts() {
    let server = FakeHttp::start(workspace).await;
    let (store, sync) = sync(&server);
    sync.catch_up_global().await.unwrap();
    let rooms: HashMap<String, _> = store.rooms().into_iter().map(|r| (r.rid.clone(), r)).collect();
    assert_eq!(rooms.len(), 4);
    let general = &rooms["C001"];
    assert_eq!((general.kind.as_str(), general.unread, general.mentions, general.alert), ("c", 2, 2, true));
    assert_eq!(general.last_message.as_deref(), Some("newest in C001 @bob"));
    assert_eq!(general.last_ts, 1_700_000_300_000);
    assert_eq!((rooms["C002"].kind.as_str(), rooms["C002"].unread, rooms["C002"].alert), ("p", 0, false));
    let group = &rooms["G001"];
    assert_eq!((group.kind.as_str(), group.unread, group.alert), ("d", 1, true));
    let dm = &rooms["D001"];
    assert_eq!((dm.kind.as_str(), dm.dm_other_uid.as_deref()), ("d", Some("U001")));
    let pages: Vec<Option<String>> = server
        .requests()
        .iter()
        .filter(|r| method(r) == "users.conversations")
        .map(|r| form(r).get("cursor").cloned())
        .collect();
    assert_eq!(pages, [None, Some("page2".to_owned())]);
    assert!(server.requests().iter().filter(|r| method(r) == "conversations.history").all(|r| form(r)["limit"] == "1"));

    let looping = FakeHttp::start(|r| match method(r) {
        "users.conversations" => ok(json!({"channels": [], "response_metadata": {"next_cursor": "again"}})),
        _ => ok(json!({})),
    })
    .await;
    let (_, sync) = self::sync(&looping);
    assert!(sync.catch_up_global().await.is_err(), "a repeated cursor is a loop, not a list");
}

/// 120 messages, two by two in the same millisecond, newest first, honouring
/// `latest`, `oldest` and `inclusive` the way Slack does.
fn channel_history(request: &Request) -> Response {
    let all: Vec<String> =
        (0..120).rev().map(|i| format!("{}.{:06}", 1_700_000_000 + i / 2, 100 + (i % 2) * 800)).collect();
    let form = form(request);
    let inclusive = form.get("inclusive").is_some_and(|v| v == "true");
    let key = |ts: &str| ts.replace('.', "").parse::<u64>().unwrap();
    let within: Vec<&String> = all
        .iter()
        .filter(|ts| match form.get("latest") {
            Some(l) => key(ts) < key(l) || (inclusive && key(ts) == key(l)),
            None => true,
        })
        .filter(|ts| match form.get("oldest") {
            Some(o) => key(ts) > key(o) || (inclusive && key(ts) == key(o)),
            None => true,
        })
        .collect();
    let limit: usize = form.get("limit").and_then(|l| l.parse().ok()).unwrap_or(100);
    let page: Vec<Value> = within.iter().take(limit).map(|ts| json!({"ts": ts, "user": "U001", "text": ts})).collect();
    ok(json!({"messages": page, "has_more": within.len() > limit}))
}

#[tokio::test]
async fn history_pages_back_by_the_exact_ts() {
    let server = FakeHttp::start(|r| match method(r) {
        "users.info" => ok(json!({"user": user("U001", "alice")})),
        _ => channel_history(r),
    })
    .await;
    let (store, sync) = sync(&server);
    let first = sync.load_history("C001", None).await.unwrap();
    assert_eq!(first.count, 50);
    let second = sync.load_history("C001", first.oldest_ts).await.unwrap();
    assert_eq!(second.count, 50);
    let third = sync.load_history("C001", second.oldest_ts).await.unwrap();
    assert_eq!(third.count, 20);
    let stored = store.messages("C001", 1000);
    assert_eq!(stored.len(), 120, "no twin of a millisecond is lost at a page edge");
    assert_eq!(stored[0].id, "C001:1700000000.000100");
    assert_eq!(stored[1].id, "C001:1700000000.000900", "the same millisecond, ordered by id");
    let bounds: Vec<(Option<String>, Option<String>)> = server
        .requests()
        .iter()
        .filter(|r| method(r) == "conversations.history")
        .map(|r| (form(r).get("latest").cloned(), form(r).get("inclusive").cloned()))
        .collect();
    assert_eq!(bounds[1], (Some("1700000035.000100".to_owned()), None));
    assert_eq!(bounds[2], (Some("1700000010.000100".to_owned()), None));

    let (_, fresh) = self::sync(&server);
    fresh.load_history("C001", Some(1_700_000_010_000)).await.unwrap();
    let last = server.requests().into_iter().rev().find(|r| method(r) == "conversations.history").unwrap();
    assert_eq!(form(&last)["latest"], "1700000010.000999");
    assert_eq!(form(&last)["inclusive"], "true");

    sync.catch_up_room("C001").await.unwrap();
    let last = server.requests().into_iter().rev().find(|r| method(r) == "conversations.history").unwrap();
    assert_eq!(form(&last)["oldest"], "1700000059.000900", "a room's catch-up starts after its newest stored ts");
}

#[tokio::test]
async fn a_thread_keeps_one_root() {
    let root = json!({"ts": "1700000000.000100", "thread_ts": "1700000000.000100", "user": "U001", "text": "root", "reply_count": 3, "latest_reply": "1700000003.000000"});
    let reply = |n: i64| json!({"ts": format!("170000000{n}.000000"), "thread_ts": "1700000000.000100", "user": "U001", "text": format!("reply {n}")});
    let server = FakeHttp::start(move |r| match method(r) {
        "users.info" => ok(json!({"user": user("U001", "alice")})),
        "conversations.replies" => match form(r).get("cursor").map(String::as_str) {
            None => ok(json!({"messages": [root, reply(1), reply(2)], "has_more": true, "response_metadata": {"next_cursor": "more"}})),
            Some(_) => ok(json!({"messages": [root, reply(3)], "has_more": false})),
        },
        other => panic!("unexpected method {other}"),
    })
    .await;
    let (store, sync) = sync(&server);
    sync.load_thread("C001:1700000000.000100").await.unwrap();
    let thread = store.thread_messages("C001:1700000000.000100");
    assert_eq!(thread.len(), 4);
    assert_eq!(thread.iter().filter(|m| m.id == "C001:1700000000.000100").count(), 1);
    assert!(
        thread
            .iter()
            .filter(|m| m.id != "C001:1700000000.000100")
            .all(|m| m.thread_id.as_deref() == Some("C001:1700000000.000100"))
    );
    assert_eq!(thread[0].thread_count, 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slack_session_speaks_only_slack() {
    let server = FakeHttp::start(workspace).await;
    let dir = tempfile::tempdir().unwrap();
    let session = Session::start(info(&server), &dir.path().join("slack.sqlite")).unwrap();
    let s = session.clone();
    tokio::time::timeout(Duration::from_secs(10), async {
        while s.store.rooms().len() < 4 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the catch-up lists the rooms, socket or not");
    assert!(server.requests().iter().any(|r| method(r) == "rtm.connect"), "the live socket is asked for");
    assert!(s.room_info("C001").await.is_ok());
    assert!(s.open_room("C001", "c").await.is_ok());
    assert!(s.react("C001:1700000300.000100", ":+1:", true).await.is_ok());
    assert!(s.react("C001:1700000300.000100", ":+1:", false).await.is_ok(), "no_reaction is the wanted state");
    assert!(s.edit("C001", "C001:1700000300.000100", "**x**").await.is_ok());
    assert!(s.delete("C001", "C001:1700000300.000100").await.is_ok());
    assert!(s.pin("C001:1700000300.000100").await.is_err());
    assert!(s.star("C001:1700000300.000100", true).await.is_err());
    assert!(s.set_favorite("C001", true).await.is_err());
    assert!(s.me().await.is_err());
    assert!(s.set_status("away", "lunch").await.is_err());
    assert!(s.spotlight("al").await.is_err());
    assert!(s.join_channel("C001").await.is_err());
    assert!(s.invite_link("C001").await.is_err());
    assert!(s.create_channel("team", false).await.is_err());
    assert!(s.refresh_custom_emojis().await.is_err());
    assert!(s.call_available().await);
    assert!(!s.threads_available() && !s.unread_marks_available());
    s.mark_read("C001").await;
    s.send("C001", "hello").await;
    assert!(s.store.pending_outbox().is_empty(), "the send is delivered");
    assert!(s.store.has_message("C001:1700000500.000001"), "under Slack's own ts");
    let sent = server.requests().into_iter().find(|r| method(r) == "chat.postMessage").unwrap();
    assert!(form(&sent).contains_key("client_msg_id"));
    let edited = server.requests().into_iter().find(|r| method(r) == "chat.update").unwrap();
    assert_eq!(form(&edited)["text"], "*x*");
    assert!(server.requests().iter().any(|r| method(r) == "conversations.mark"));
    let link = s.permalink("c", Some("general"), "C001", "C001:1700000300.000100").await;
    assert!(link.ends_with("/archives/C001/p1700000300000100"), "{link}");
    let lists = || server.requests().iter().filter(|r| method(r) == "users.conversations").count();
    let before = lists();
    session.reconnect_now();
    tokio::time::timeout(Duration::from_secs(10), async {
        while lists() == before {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a refresh reads the list again");
    for request in server.requests() {
        assert_eq!(request.method, "POST", "{}", request.target);
        assert!(request.path().starts_with("/api/") && !request.path().starts_with("/api/v"), "{}", request.target);
        assert!(METHODS.contains(&method(&request)), "{}", request.target);
    }
    session.shutdown();
    session.store.close();
}

fn room(store: &Store, rid: &str) -> rv_core::store::RoomRow {
    store.rooms().into_iter().find(|r| r.rid == rid).unwrap()
}

fn texts(store: &Store, rid: &str) -> Vec<String> {
    store.messages(rid, 50).into_iter().filter_map(|m| m.text).collect()
}

#[tokio::test]
async fn a_live_message_moves_the_preview_and_the_unread_count() {
    let server = FakeHttp::start(workspace).await;
    let (store, sync) = sync(&server);
    sync.catch_up_global().await.unwrap();
    let frame =
        json!({"type": "message", "channel": "C002", "ts": "1700000400.000001", "user": "U001", "text": "hey <@U000>"});
    let incoming = sync.apply_event("message", &frame).await;
    assert_eq!(incoming.map(|m| m.id), Some("C002:1700000400.000001".to_owned()));
    let ops = room(&store, "C002");
    assert_eq!((ops.unread, ops.mentions, ops.alert), (1, 1, true));
    assert_eq!(ops.last_message.as_deref(), Some("hey @me"));
    assert_eq!(texts(&store, "C002"), ["hey @me"]);
    assert!(sync.apply_event("message", &frame).await.is_none(), "a repeated frame is not a new message");
}

#[tokio::test]
async fn my_own_message_and_a_reply_leave_the_badge_and_the_preview() {
    let server = FakeHttp::start(workspace).await;
    let (store, sync) = sync(&server);
    sync.catch_up_global().await.unwrap();
    let mine = json!({"type": "message", "channel": "C002", "ts": "1700000400.000001", "user": "U000", "text": "mine"});
    assert!(sync.apply_event("message", &mine).await.is_none());
    assert_eq!((room(&store, "C002").unread, room(&store, "C002").last_message.as_deref()), (0, Some("mine")));
    let reply = json!({"type": "message", "channel": "C002", "ts": "1700000500.000001", "thread_ts": "1700000400.000001", "user": "U001", "text": "re"});
    sync.apply_event("message", &reply).await;
    assert_eq!(room(&store, "C002").last_message.as_deref(), Some("mine"), "a reply is not the preview");
    assert_eq!(room(&store, "C002").unread, 1);
}

#[tokio::test]
async fn live_edits_and_deletions_target_the_exact_ts() {
    let server = FakeHttp::start(workspace).await;
    let (store, sync) = sync(&server);
    sync.catch_up_global().await.unwrap();
    for ts in ["1700000400.000001", "1700000400.000002"] {
        sync.apply_event(
            "message",
            &json!({"type": "message", "channel": "C002", "ts": ts, "user": "U001", "text": ts}),
        )
        .await;
    }
    let edit = json!({
        "type": "message", "subtype": "message_changed", "channel": "C002", "ts": "1700000450.000000",
        "message": {"type": "message", "ts": "1700000400.000001", "user": "U001", "text": "edited", "edited": {"ts": "1700000450.000000"}},
    });
    assert!(sync.apply_event("message", &edit).await.is_none(), "an edit notifies nobody");
    let deletion = json!({"type": "message", "subtype": "message_deleted", "channel": "C002", "ts": "1700000460.000000", "deleted_ts": "1700000400.000002"});
    sync.apply_event("message", &deletion).await;
    assert_eq!(texts(&store, "C002"), ["edited"]);
}

#[tokio::test]
async fn a_marked_frame_clears_the_badge_and_a_reaction_rereads_its_message() {
    let server = FakeHttp::start(workspace).await;
    let (store, sync) = sync(&server);
    sync.catch_up_global().await.unwrap();
    assert!(room(&store, "C001").alert);
    let marked = json!({"type": "channel_marked", "channel": "C001", "ts": "1700000300.000100", "unread_count_display": 0, "mention_count_display": 0});
    sync.apply_event("channel_marked", &marked).await;
    assert_eq!((room(&store, "C001").unread, room(&store, "C001").alert), (0, false));

    let before = server.requests().len();
    let reaction = json!({"type": "reaction_added", "user": "U001", "reaction": "tada", "item": {"type": "message", "channel": "C001", "ts": "1700000300.000100"}});
    sync.apply_event("reaction_added", &reaction).await;
    let reread = &server.requests()[before..];
    assert!(reread.iter().any(|r| method(r) == "conversations.history" && form(r)["latest"] == "1700000300.000100"));
    assert_eq!(texts(&store, "C001"), ["newest in C001 @bob"]);
}

#[tokio::test]
async fn a_frame_for_a_room_off_the_list_writes_no_room() {
    let server = FakeHttp::start(workspace).await;
    let (store, sync) = sync(&server);
    sync.catch_up_global().await.unwrap();
    let frame =
        json!({"type": "message", "channel": "C999", "ts": "1700000400.000001", "user": "U001", "text": "elsewhere"});
    sync.apply_event("message", &frame).await;
    assert!(store.rooms().iter().all(|r| r.rid != "C999"));
}

fn outbox(server: &FakeHttp) -> (Arc<Store>, rv_core::outbox::Outbox) {
    let store = Arc::new(Store::in_memory().unwrap());
    let rest = RestClient::slack(server.url.clone(), Zeroizing::new(COOKIE.to_owned()));
    rest.set_credentials(Some(rv_core::rest::Credentials { auth_token: TOKEN.into(), user_id: "U000".into() }));
    let sync = Arc::new(rv_core::sync::SyncEngine::for_slack(store.clone(), rest.clone(), "me", "U000"));
    (store.clone(), rv_core::outbox::Outbox::new(store, rest, sync, "U000", "me"))
}

fn status(store: &Store, rid: &str, id: &str) -> Option<String> {
    store.messages(rid, 50).into_iter().find(|m| m.id == id).and_then(|m| m.outbox_status)
}

#[tokio::test]
async fn a_reply_carries_its_thread_and_the_room_broadcast() {
    let server = FakeHttp::start(workspace).await;
    let (store, outbox) = outbox(&server);
    outbox.enqueue_reply("C001", "in thread", Some("C001:1700000000.000100"), true);
    outbox.process().await;
    let sent = server.requests().into_iter().find(|r| method(r) == "chat.postMessage").unwrap();
    let form = form(&sent);
    assert_eq!((form["thread_ts"].as_str(), form["reply_broadcast"].as_str()), ("1700000000.000100", "true"));
    assert!(store.pending_outbox().is_empty());
}

#[tokio::test]
async fn a_refusal_fails_the_send_without_a_lookup() {
    let server = FakeHttp::start(|r| match method(r) {
        "chat.postMessage" => respond(200, r#"{"ok":false,"error":"is_archived"}"#),
        other => panic!("unexpected {other}"),
    })
    .await;
    let (store, outbox) = outbox(&server);
    let id = outbox.enqueue("C001", "hi", None);
    outbox.process().await;
    assert_eq!(status(&store, "C001", &id).as_deref(), Some("failed"));
    assert_eq!(server.requests().len(), 1);
}

/// A 502 to the send, then a history holding one message from me with `marker`.
fn lost_answer(marker: String) -> impl Fn(&Request) -> Response + Send + Sync + 'static {
    move |r: &Request| match method(r) {
        "chat.postMessage" => respond(502, "Bad Gateway"),
        "conversations.history" => ok(json!({"has_more": false, "messages": [
            {"type": "message", "user": "U000", "text": "hi", "ts": "1700000500.000009",
             "client_msg_id": marker.clone()},
        ]})),
        "users.info" => ok(json!({"user": user("U000", "me")})),
        other => panic!("unexpected {other}"),
    }
}

use rv_core::slack::translate::client_msg_id;

#[tokio::test]
async fn a_lost_answer_is_not_settled_by_another_rows_marker() {
    let id = rv_core::outbox::generate_message_id();
    let server = FakeHttp::start(lost_answer(client_msg_id(&id))).await;
    let (store, outbox) = outbox(&server);
    let queued = outbox.enqueue("C001", "hi", None);
    assert_ne!(queued, id, "ids are fresh");
    outbox.process().await;
    assert_eq!(status(&store, "C001", &queued).as_deref(), Some("failed"), "a marker of another row proves nothing");
    assert_eq!(server.requests().iter().filter(|r| method(r) == "chat.postMessage").count(), 1, "never replayed");
}

#[tokio::test]
async fn a_lost_answer_finds_the_message_it_sent() {
    let server = FakeHttp::start(|r: &Request| match method(r) {
        "chat.postMessage" => respond(502, "Bad Gateway"),
        "conversations.history" => ok(json!({"has_more": false, "messages": []})),
        other => panic!("unexpected {other}"),
    })
    .await;
    let (store, outbox) = outbox(&server);
    let id = outbox.enqueue("C001", "hi", None);
    outbox.process().await;
    assert_eq!(status(&store, "C001", &id).as_deref(), Some("failed"), "absent from the window: delivery unknown");

    let marker = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let seen = marker.clone();
    let server = FakeHttp::start(move |r: &Request| match method(r) {
        "chat.postMessage" => {
            *seen.lock().unwrap() = form(r)["client_msg_id"].clone();
            respond(502, "Bad Gateway")
        }
        "conversations.history" => ok(json!({"has_more": false, "messages": [
            {"type": "message", "user": "U000", "text": "hi", "ts": "1700000500.000009", "client_msg_id": seen.lock().unwrap().clone()},
        ]})),
        "users.info" => ok(json!({"user": user("U000", "me")})),
        other => panic!("unexpected {other}"),
    })
    .await;
    let (store, outbox) = self::outbox(&server);
    let id = outbox.enqueue("C001", "hi", None);
    outbox.process().await;
    assert_eq!(*marker.lock().unwrap(), client_msg_id(&id));
    assert!(store.pending_outbox().is_empty(), "my own marker proves the delivery");
    assert!(store.has_message("C001:1700000500.000009"));
}
