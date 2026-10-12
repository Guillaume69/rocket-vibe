//! Several Rocket.Chat accounts kept connected by the supervisor, each on a
//! scripted DDP server: a background account's message becomes its notice,
//! the open account's stays with the UI's own listener, a dropped socket
//! comes back, and switching moves the line between the two.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rv_core::provider::{Chat, ChatEvent};
use rv_core::rooms::Badge;
use rv_core::session::{Session, SessionInfo};
use rv_core::supervisor::{self, AccountNotice, Notice, Supervisor};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// Answers the handshake, the resume login and every `sub`; REST requests
/// are not WebSocket upgrades and fail, as on an unreachable server.
struct FakeDdp {
    url: url::Url,
    log: Arc<Mutex<Vec<Value>>>,
    push: mpsc::UnboundedSender<Value>,
    kill: mpsc::UnboundedSender<()>,
}

impl FakeDdp {
    async fn start() -> FakeDdp {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap()).parse().unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let (push, mut push_rx) = mpsc::unbounded_channel::<Value>();
        let (kill, mut kill_rx) = mpsc::unbounded_channel::<()>();
        let record = log.clone();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else { continue };
                loop {
                    tokio::select! {
                        frame = ws.next() => {
                            let Some(Ok(Message::Text(text))) = frame else { break };
                            let m: Value = serde_json::from_str(text.as_str()).unwrap();
                            record.lock().unwrap().push(m.clone());
                            let reply = match m["msg"].as_str().unwrap_or_default() {
                                "connect" => Some(json!({"msg": "connected", "session": "S1"})),
                                "method" => Some(json!({"msg": "result", "id": m["id"], "result": {"token": "t"}})),
                                "sub" => Some(json!({"msg": "ready", "subs": [m["id"]]})),
                                "ping" => Some(json!({"msg": "pong", "id": m["id"]})),
                                _ => None,
                            };
                            if let Some(r) = reply {
                                let _ = ws.send(Message::text(r.to_string())).await;
                            }
                        }
                        Some(v) = push_rx.recv() => { let _ = ws.send(Message::text(v.to_string())).await; }
                        Some(()) = kill_rx.recv() => { let _ = ws.close(None).await; break; }
                    }
                }
            }
        });
        FakeDdp { url, log, push, kill }
    }

    /// Times the client subscribed to every room's new messages.
    fn my_messages_subs(&self) -> usize {
        self.log.lock().unwrap().iter().filter(|m| m["msg"] == "sub" && m["params"][0] == "__my_messages__").count()
    }

    fn message(&self, id: &str, text: &str) {
        let now = chrono_now();
        self.push
            .send(json!({
                "msg": "changed",
                "collection": "stream-room-messages",
                "id": "id",
                "fields": {"eventName": "__my_messages__", "args": [{
                    "_id": id, "rid": "r1", "msg": text, "ts": {"$date": now},
                    "u": {"_id": "someone", "username": "someone"}, "_updatedAt": {"$date": now},
                }]},
            }))
            .unwrap();
    }
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn account(server: &FakeDdp, uid: &str) -> SessionInfo {
    SessionInfo {
        base_url: server.url.to_string(),
        user_id: uid.into(),
        username: "me".into(),
        auth_token: "tok".into(),
        native: None,
        mattermost: None,
    }
}

async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..250 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{what} never happened");
}

/// The next notice that is not an unread state, within `wait`.
async fn next_notice(notices: &mut mpsc::UnboundedReceiver<AccountNotice>, wait: Duration) -> Option<AccountNotice> {
    tokio::time::timeout(wait, async {
        loop {
            let notice = notices.recv().await.expect("notices ended");
            if !matches!(notice.notice, Notice::Unread(_)) {
                return notice;
            }
        }
    })
    .await
    .ok()
}

fn general(chat: &Chat) {
    let session = chat.legacy().unwrap();
    let room = rv_core::normalize::to_room(&json!({"_id": "r1", "t": "c", "name": "general"}), "me", "me").unwrap();
    session.store.write(|w| w.upsert_room(&room));
}

fn starter(dir: &std::path::Path) -> supervisor::Starter {
    let dir = dir.to_owned();
    Arc::new(move |info: &SessionInfo| {
        let path = dir.join(format!("{}.sqlite", info.user_id));
        Session::start(info.clone(), &path).map(Chat::from).map_err(|e| e.to_string())
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_background_account_notifies_and_the_open_one_is_left_to_its_window() {
    let (server_a, server_b) = (FakeDdp::start().await, FakeDdp::start().await);
    let dir = tempfile::tempdir().unwrap();
    let (supervisor, mut notices) = Supervisor::new(tokio::runtime::Handle::current(), starter(dir.path()));
    let (a, b) = (account(&server_a, "ua"), account(&server_b, "ub"));

    let chat_a = supervisor.open(&a).unwrap();
    supervisor.sync(&[a.clone(), b.clone()]);
    eventually("both accounts listening", || server_a.my_messages_subs() == 1 && server_b.my_messages_subs() == 1)
        .await;
    let chat_b = supervisor.chat(&supervisor::key(&b)).expect("the background account runs");
    assert!(supervisor.is_active(&supervisor::key(&a)));
    general(&chat_a);
    general(&chat_b);
    let (mut window, forward) = chat_a.events();

    server_b.message("b1", "hello @me");
    let notice = next_notice(&mut notices, Duration::from_secs(5)).await.expect("the background message is announced");
    assert_eq!(notice.key(), supervisor::key(&b));
    let Notice::Incoming(incoming) = notice.notice else { panic!("not a message: {:?}", notice.notice) };
    assert_eq!((incoming.rid.as_str(), incoming.id.as_str()), ("r1", "b1"));

    server_a.message("a1", "hello @me");
    let shown = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ChatEvent::Incoming(incoming)) = window.recv().await {
                return incoming;
            }
        }
    })
    .await
    .expect("the open account's window hears its message");
    assert_eq!(shown.id, "a1");
    assert_eq!(next_notice(&mut notices, Duration::from_millis(600)).await, None, "announced once, by the window");
    forward.abort();

    server_b.kill.send(()).unwrap();
    eventually("the background account reconnected", || server_b.my_messages_subs() == 2).await;
    server_b.message("b2", "again @me");
    let notice = next_notice(&mut notices, Duration::from_secs(5)).await.expect("heard after reconnecting");
    assert!(matches!(&notice.notice, Notice::Incoming(i) if i.id == "b2"));

    let reopened = supervisor.open(&b).unwrap();
    assert!(reopened.same(&chat_b), "switching reuses the running session");
    server_b.message("b3", "on screen @me");
    server_a.message("a2", "behind @me");
    let notice = next_notice(&mut notices, Duration::from_secs(5)).await.expect("the account left behind notifies");
    assert_eq!(notice.key(), supervisor::key(&a));
    assert!(matches!(&notice.notice, Notice::Incoming(i) if i.id == "a2"));
    assert_eq!(next_notice(&mut notices, Duration::from_millis(600)).await, None);

    supervisor.shutdown();
    assert!(chat_a.legacy().unwrap().is_closed() && chat_b.legacy().unwrap().is_closed());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unread_rooms_reach_the_switcher_and_a_failed_start_is_retried() {
    let server = FakeDdp::start().await;
    let dir = tempfile::tempdir().unwrap();
    let failures = Arc::new(AtomicUsize::new(1));
    let inner = starter(dir.path());
    let flaky: supervisor::Starter = {
        let failures = failures.clone();
        Arc::new(move |info: &SessionInfo| {
            if failures.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() {
                return Err("database locked".into());
            }
            inner(info)
        })
    };
    let (supervisor, mut notices) = Supervisor::new(tokio::runtime::Handle::current(), flaky);
    let b = account(&server, "ub");
    supervisor.sync(std::slice::from_ref(&b));
    assert!(supervisor.chat(&supervisor::key(&b)).is_none(), "the first start failed");
    eventually("the start was retried", || supervisor.chat(&supervisor::key(&b)).is_some()).await;
    let chat = supervisor.chat(&supervisor::key(&b)).unwrap();

    let subscription = rv_core::normalize::to_subscription(&json!({
        "_id": "s1", "rid": "r1", "t": "d", "name": "someone", "unread": 2, "open": true,
        "_updatedAt": {"$date": chrono_now()},
    }))
    .unwrap();
    let room = rv_core::normalize::to_room(&json!({"_id": "r1", "t": "d", "usernames": ["me", "someone"]}), "me", "ub")
        .unwrap();
    chat.legacy().unwrap().store.write(|w| {
        w.upsert_room(&room);
        w.upsert_subscription(&subscription);
    });
    let unread = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Notice::Unread(badge) = notices.recv().await.unwrap().notice
                && badge != Badge::None
            {
                return badge;
            }
        }
    })
    .await
    .expect("the unread state follows the store");
    assert_eq!(unread, Badge::Count(2), "a direct message counts");

    let removed = supervisor.remove(&supervisor::key(&b)).expect("still running");
    removed.legacy().unwrap().shutdown();
    supervisor.sync(&[]);
    assert!(supervisor.running().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopening_a_paused_native_account_resumes_its_existing_outbox_without_restarting_healthy_sessions() {
    use common::{FakeHttp, respond};
    use rv_core::native::{Identity, NativeSession};
    use rv_core::session::Connection;

    let fixture: Value = serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let responses = fixture.clone();
    let server = FakeHttp::start(move |request| match request.path() {
        "/.well-known/rocketvibe" => respond(200, &responses["discovery"].to_string()),
        "/api/v1/me" => respond(200, &responses["session"]["user"].to_string()),
        "/api/v1/sync/snapshot" => respond(
            200,
            &json!({
                "protocol_version": 1, "rooms": [responses["room"]], "messages": [], "cursor": "initial"
            })
            .to_string(),
        ),
        "/api/v1/sync/changes" => respond(
            200,
            &json!({
                "protocol_version": 1, "changes": [], "cursor": "initial", "has_more": false
            })
            .to_string(),
        ),
        "/api/v1/sync/ticket" => respond(200, &responses["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => common::Response { websocket: true, ..Default::default() },
        "/api/v1/rooms/room-id/messages" if request.method == "POST" => {
            let intention: Value = serde_json::from_str(&request.body).unwrap();
            let mut message = responses["message"].clone();
            message["id"] = intention["operation_id"].clone();
            message["text"] = intention["text"].clone();
            respond(200, &message.to_string())
        }
        _ => respond(404, r#"{"code":"not_found","request_id":"supervisor-test"}"#),
    })
    .await;
    let info = SessionInfo {
        base_url: server.url.as_str().into(),
        user_id: "alice-id".into(),
        username: "alice".into(),
        auth_token: "fixture-token".into(),
        native: Some(Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }),
        mattermost: None,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("native.sqlite");
    let starts = Arc::new(AtomicUsize::new(0));
    let record_starts = starts.clone();
    let starter: supervisor::Starter = Arc::new(move |info| {
        record_starts.fetch_add(1, Ordering::SeqCst);
        NativeSession::start(info.clone(), &path).map(Chat::from).map_err(|error| error.to_string())
    });
    let (supervisor, _notices) = Supervisor::new(tokio::runtime::Handle::current(), starter);
    let opened = supervisor.open(&info).unwrap();
    let native = opened.native().unwrap();
    let sockets = || server.requests().iter().filter(|request| request.path() == "/api/v1/sync/socket").count();
    let sends = || {
        server
            .requests()
            .into_iter()
            .filter(|request| request.method == "POST" && request.path().ends_with("/messages"))
            .collect::<Vec<_>>()
    };
    eventually("native account online", || native.status().connection == Connection::Online).await;
    assert_eq!(sockets(), 1);
    let healthy = supervisor.open(&info).unwrap();
    assert!(healthy.same(&opened));
    assert_eq!(native.status().connection, Connection::Online);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(sockets(), 1, "opening a healthy background session keeps its socket");

    native.suspend();
    eventually("native account suspended", || native.status().connection == Connection::Offline).await;
    let intention = native.send("room-id", "Queued while the native account is suspended").unwrap();
    assert_eq!(native.store.pending().unwrap()[0].id, intention);
    native.store.set_draft("room-id", "Draft on the reused session").unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(sends().is_empty(), "a suspended account keeps its intention local");

    let reopened = supervisor.open(&info).unwrap();
    assert!(reopened.same(&opened), "resume retains the session and its durable store");
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    eventually("reopened native account online and queued intention acknowledged", || {
        native.status().connection == Connection::Online && native.store.pending().unwrap().is_empty()
    })
    .await;
    assert_eq!(sockets(), 2, "resume opens one fresh authenticated socket");
    assert_eq!(native.store.draft("room-id").unwrap(), "Draft on the reused session");
    let delivered = native.store.messages("room-id", 10).unwrap();
    assert_eq!(delivered.iter().filter(|message| message.id == intention && message.status.is_none()).count(), 1);
    let sent = sends();
    assert_eq!(sent.len(), 1, "the queued intention is posted exactly once");
    assert_eq!(serde_json::from_str::<Value>(&sent[0].body).unwrap()["operation_id"], intention);
    assert!(supervisor.open(&info).unwrap().same(&opened));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(sockets(), 2);
    assert_eq!(sends().len(), 1);
    supervisor.shutdown();
}
