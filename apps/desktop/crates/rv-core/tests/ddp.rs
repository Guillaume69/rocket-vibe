use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rv_core::ddp::{self, DdpEvent, State, Timeouts};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone, Copy, PartialEq)]
enum SubReply {
    Ready,
    OffendingError,
}

/// Scripted DDP server: answers the handshake, the login and every `sub`,
/// records what the client sent, and lets the test push frames.
struct FakeDdp {
    url: url::Url,
    log: Arc<Mutex<Vec<Value>>>,
    push: mpsc::UnboundedSender<Value>,
    kill: mpsc::UnboundedSender<()>,
}

impl FakeDdp {
    async fn start(accept_login: bool, sub_reply: SubReply) -> FakeDdp {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/websocket", listener.local_addr().unwrap()).parse().unwrap();
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
                                "method" if accept_login => Some(json!({"msg": "result", "id": m["id"], "result": {"token": "t"}})),
                                "method" => Some(json!({"msg": "result", "id": m["id"], "error": {"reason": "bad token"}})),
                                "sub" if sub_reply == SubReply::Ready => Some(json!({"msg": "ready", "subs": [m["id"]]})),
                                "sub" => Some(json!({"msg": "error", "reason": "Must connect first", "offendingMessage": m})),
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

    fn received(&self, msg: &str) -> Vec<Value> {
        self.log.lock().unwrap().iter().filter(|m| m["msg"] == msg).cloned().collect()
    }
}

async fn next_matching(events: &mut mpsc::UnboundedReceiver<DdpEvent>, want: impl Fn(&DdpEvent) -> bool) -> DdpEvent {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let e = events.recv().await.expect("event");
            if want(&e) {
                return e;
            }
        }
    })
    .await
    .expect("timed out waiting for event")
}

async fn eventually(mut check: impl FnMut() -> bool) {
    for _ in 0..150 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition never became true");
}

#[tokio::test]
async fn connects_logs_in_and_replays_desired_subscriptions() {
    let server = FakeDdp::start(true, SubReply::Ready).await;
    let (ddp, mut events) = ddp::spawn(server.url.clone(), Timeouts::default());
    ddp.subscribe("stream-room-messages", "__my_messages__");
    ddp.open("token-1");
    next_matching(&mut events, |e| *e == DdpEvent::Authenticated).await;

    let login = server.received("method");
    assert_eq!(login[0]["params"][0]["resume"], "token-1");
    ddp.subscriptions_armed().await;
    assert_eq!(ddp.inspect().await, (State::Authenticated, 1));
    let sub = &server.received("sub")[0];
    assert_eq!(sub["name"], "stream-room-messages");
    assert_eq!(sub["params"][0], "__my_messages__");
    assert_eq!(sub["params"][1]["useCollection"], false);
}

#[tokio::test]
async fn same_stream_twice_is_one_sub_on_the_wire() {
    let server = FakeDdp::start(true, SubReply::Ready).await;
    let (ddp, mut events) = ddp::spawn(server.url.clone(), Timeouts::default());
    ddp.open("t");
    next_matching(&mut events, |e| *e == DdpEvent::Authenticated).await;
    ddp.subscribe("stream-notify-room", "r1/deleteMessage");
    ddp.subscribe("stream-notify-room", "r1/deleteMessage");
    ddp.subscriptions_armed().await;
    assert_eq!(ddp.inspect().await.1, 1);
    assert_eq!(server.received("sub").len(), 1);

    ddp.unsubscribe("stream-notify-room", "r1/deleteMessage");
    ddp.inspect().await;
    assert!(server.received("unsub").is_empty());
    ddp.unsubscribe("stream-notify-room", "r1/deleteMessage");
    eventually(|| server.received("unsub").len() == 1).await;
}

#[tokio::test]
async fn changed_events_are_routed() {
    let server = FakeDdp::start(true, SubReply::Ready).await;
    let (ddp, mut events) = ddp::spawn(server.url.clone(), Timeouts::default());
    ddp.open("t");
    next_matching(&mut events, |e| *e == DdpEvent::Authenticated).await;
    server
        .push
        .send(json!({"msg": "changed", "collection": "stream-room-messages", "id": "id",
            "fields": {"eventName": "__my_messages__", "args": [{"_id": "m1"}]}}))
        .unwrap();
    let e = next_matching(&mut events, |e| matches!(e, DdpEvent::Changed { .. })).await;
    let DdpEvent::Changed { collection, key, args } = e else { unreachable!() };
    assert_eq!((collection.as_str(), key.as_str()), ("stream-room-messages", "__my_messages__"));
    assert_eq!(args[0]["_id"], "m1");
}

#[tokio::test]
async fn server_ping_gets_pong() {
    let server = FakeDdp::start(true, SubReply::Ready).await;
    let (ddp, mut events) = ddp::spawn(server.url.clone(), Timeouts::default());
    ddp.open("t");
    next_matching(&mut events, |e| *e == DdpEvent::Authenticated).await;
    server.push.send(json!({"msg": "ping", "id": "p1"})).unwrap();
    eventually(|| server.received("pong").first().is_some_and(|p| p["id"] == "p1")).await;
}

#[tokio::test]
async fn error_with_offending_id_settles_that_wait_at_once() {
    let server = FakeDdp::start(true, SubReply::OffendingError).await;
    let timeouts = Timeouts { request: Duration::from_secs(60), ..Timeouts::default() };
    let (ddp, mut events) = ddp::spawn(server.url.clone(), timeouts);
    ddp.subscribe("stream-notify-user", "u/rooms-changed");
    ddp.open("t");
    next_matching(&mut events, |e| *e == DdpEvent::Authenticated).await;
    // Long before the 60 s request timeout.
    tokio::time::timeout(Duration::from_secs(2), ddp.subscriptions_armed()).await.unwrap();
    assert_eq!(ddp.inspect().await, (State::Authenticated, 0));
}

#[tokio::test]
async fn refused_login_is_a_loss() {
    let server = FakeDdp::start(false, SubReply::Ready).await;
    let (ddp, mut events) = ddp::spawn(server.url.clone(), Timeouts::default());
    ddp.open("t");
    next_matching(&mut events, |e| *e == DdpEvent::Lost).await;
    assert_eq!(ddp.inspect().await.0, State::Closed);
}

#[tokio::test]
async fn server_close_is_a_loss_but_close_is_not() {
    let server = FakeDdp::start(true, SubReply::Ready).await;
    let (ddp, mut events) = ddp::spawn(server.url.clone(), Timeouts::default());
    ddp.subscribe("stream-room-messages", "__my_messages__");
    ddp.open("t");
    next_matching(&mut events, |e| *e == DdpEvent::Authenticated).await;
    ddp.subscriptions_armed().await;

    server.kill.send(()).unwrap();
    next_matching(&mut events, |e| *e == DdpEvent::Lost).await;
    assert_eq!(ddp.inspect().await, (State::Closed, 0));

    ddp.open("t");
    next_matching(&mut events, |e| *e == DdpEvent::Authenticated).await;
    ddp.subscriptions_armed().await;
    assert_eq!(ddp.inspect().await.1, 1);

    ddp.close();
    tokio::time::sleep(Duration::from_millis(100)).await;
    while let Ok(e) = events.try_recv() {
        assert_ne!(e, DdpEvent::Lost);
    }
}

#[tokio::test]
async fn silent_socket_is_probed_then_dropped() {
    let server = FakeDdp::start(true, SubReply::Ready).await;
    let timeouts = Timeouts {
        request: Duration::from_millis(300),
        silence_max: Duration::from_millis(200),
        watchdog: Duration::from_millis(50),
    };
    let (ddp, mut events) = ddp::spawn(server.url.clone(), timeouts);
    ddp.open("t");
    next_matching(&mut events, |e| *e == DdpEvent::Authenticated).await;
    // The fake never answers our pings: the probe times out.
    next_matching(&mut events, |e| *e == DdpEvent::Lost).await;
    assert!(!server.received("ping").is_empty());
}
