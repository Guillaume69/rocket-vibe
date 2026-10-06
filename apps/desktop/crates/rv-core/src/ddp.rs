//! Listen-only DDP client for Rocket.Chat, written from the DDP spec. DDP
//! method calls are deprecated since 8.0: the only method ever called is
//! `login` (a `sub` without an authenticated session gets `nosub`).
//!
//! One actor task owns the socket; the handle only sends it commands.

use std::collections::HashMap;
use std::pin::Pin;
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Closed,
    Connecting,
    Connected,
    Authenticated,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DdpEvent {
    State(State),
    Authenticated,
    /// The connection dropped without `close()` being asked.
    Lost,
    Changed {
        collection: String,
        key: String,
        args: Vec<Value>,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub request: Duration,
    /// The server pings every 30 s (measured on 8.5): 45 s of silence proves a
    /// ping was lost. We probe then, and only a missing pong kills the socket.
    pub silence_max: Duration,
    pub watchdog: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Timeouts {
            request: Duration::from_secs(10),
            silence_max: Duration::from_secs(45),
            watchdog: Duration::from_secs(15),
        }
    }
}

enum Command {
    Open(String),
    Close,
    Subscribe(String, String),
    Unsubscribe(String, String),
    WhenArmed(oneshot::Sender<()>),
    Inspect(oneshot::Sender<(State, usize)>),
}

#[derive(Clone)]
pub struct DdpHandle {
    commands: mpsc::UnboundedSender<Command>,
}

impl DdpHandle {
    pub fn open(&self, auth_token: &str) {
        let _ = self.commands.send(Command::Open(auth_token.to_owned()));
    }

    /// Voluntary close: never reported as `Lost`.
    pub fn close(&self) {
        let _ = self.commands.send(Command::Close);
    }

    /// Transport-agnostic: remembered, established once authenticated, and
    /// replayed after every reconnection. Ref-counted so that two observers
    /// produce a single `sub` on the wire.
    pub fn subscribe(&self, name: &str, key: &str) {
        let _ = self.commands.send(Command::Subscribe(name.to_owned(), key.to_owned()));
    }

    pub fn unsubscribe(&self, name: &str, key: &str) {
        let _ = self.commands.send(Command::Unsubscribe(name.to_owned(), key.to_owned()));
    }

    /// Resolves once no subscription negotiation is in flight (ready, nosub or
    /// dead socket). A REST read started after this cannot leave a gap.
    pub async fn subscriptions_armed(&self) {
        let (tx, rx) = oneshot::channel();
        if self.commands.send(Command::WhenArmed(tx)).is_ok() {
            let _ = rx.await;
        }
    }

    /// Current state and number of subscriptions established on the wire.
    pub async fn inspect(&self) -> (State, usize) {
        let (tx, rx) = oneshot::channel();
        let _ = self.commands.send(Command::Inspect(tx));
        rx.await.unwrap_or((State::Closed, 0))
    }
}

pub fn spawn(url: Url, timeouts: Timeouts) -> (DdpHandle, mpsc::UnboundedReceiver<DdpEvent>) {
    let (commands, rx) = mpsc::unbounded_channel();
    let (events, events_rx) = mpsc::unbounded_channel();
    let actor = Actor {
        url,
        timeouts,
        events,
        state: State::Closed,
        token: String::new(),
        counter: 0,
        sink: None,
        connect_requested: false,
        epoch: 0,
        connect_deadline: None,
        pending: HashMap::new(),
        desired: HashMap::new(),
        armed_waiters: Vec::new(),
        last_traffic: Instant::now(),
        next_watchdog: None,
        probing: false,
    };
    tokio::spawn(actor.run(rx));
    (DdpHandle { commands }, events_rx)
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Connecting = Pin<Box<dyn Future<Output = Result<Socket, tokio_tungstenite::tungstenite::Error>> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingKind {
    Login,
    Sub,
    Probe,
}

struct Pending {
    kind: PendingKind,
    sub_key: String,
    deadline: Instant,
}

struct Desired {
    name: String,
    key: String,
    refs: usize,
    wire_id: Option<String>,
    in_flight: bool,
}

struct Actor {
    url: Url,
    timeouts: Timeouts,
    events: mpsc::UnboundedSender<DdpEvent>,
    state: State,
    token: String,
    counter: u64,
    sink: Option<SplitSink<Socket, WsMessage>>,
    connect_requested: bool,
    epoch: u64,
    connect_deadline: Option<Instant>,
    pending: HashMap<String, Pending>,
    desired: HashMap<String, Desired>,
    armed_waiters: Vec<oneshot::Sender<()>>,
    last_traffic: Instant,
    next_watchdog: Option<Instant>,
    probing: bool,
}

fn key_of(name: &str, key: &str) -> String {
    format!("{name}|{key}")
}

impl Actor {
    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        let mut stream: Option<SplitStream<Socket>> = None;
        let mut connecting: Option<Connecting> = None;
        loop {
            if std::mem::take(&mut self.connect_requested) {
                let url = self.url.to_string();
                connecting = Some(Box::pin(async move {
                    crate::tls::ensure_provider();
                    tokio_tungstenite::connect_async(url).await.map(|(socket, _)| socket)
                }));
            }
            let epoch = self.epoch;
            let deadline = self.next_deadline();
            tokio::select! {
                command = commands.recv() => match command {
                    Some(c) => self.on_command(c).await,
                    None => {
                        self.teardown(true);
                        return;
                    }
                },
                result = async { connecting.as_mut().unwrap().await }, if connecting.is_some() => {
                    connecting = None;
                    match result {
                        Ok(socket) => {
                            let (sink, source) = socket.split();
                            self.sink = Some(sink);
                            stream = Some(source);
                            self.send(json!({"msg": "connect", "version": "1", "support": ["1"]})).await;
                        }
                        Err(_) => self.teardown(false),
                    }
                }
                frame = async { stream.as_mut().unwrap().next().await }, if stream.is_some() => match frame {
                    Some(Ok(WsMessage::Text(text))) => {
                        self.last_traffic = Instant::now();
                        self.on_message(text.as_str()).await;
                    }
                    Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => self.teardown(false),
                    Some(Ok(_)) => self.last_traffic = Instant::now(),
                },
                _ = tokio::time::sleep_until(deadline.unwrap_or_else(far_future)), if deadline.is_some() => {
                    self.on_timers().await;
                }
            }
            // A teardown happened: the old socket's late frames must not reach us.
            if self.epoch != epoch {
                stream = None;
                if !self.connect_requested {
                    connecting = None;
                }
            }
        }
    }

    fn emit(&self, event: DdpEvent) {
        let _ = self.events.send(event);
    }

    fn set_state(&mut self, state: State) {
        if self.state != state {
            self.state = state;
            self.emit(DdpEvent::State(state));
        }
    }

    fn next_id(&mut self, prefix: char) -> String {
        self.counter += 1;
        format!("{prefix}{}", self.counter)
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().map(|p| p.deadline).chain(self.connect_deadline).chain(self.next_watchdog).min()
    }

    async fn send(&mut self, value: Value) {
        if let Some(sink) = &mut self.sink
            && sink.send(WsMessage::text(value.to_string())).await.is_err()
        {
            self.teardown(false);
        }
    }

    async fn on_command(&mut self, command: Command) {
        match command {
            Command::Open(token) => {
                if self.state != State::Closed {
                    return;
                }
                self.token = token;
                self.set_state(State::Connecting);
                self.connect_deadline = Some(Instant::now() + self.timeouts.request);
                self.last_traffic = Instant::now();
                self.connect_requested = true;
            }
            Command::Close => self.teardown(true),
            Command::Subscribe(name, key) => {
                let entry = self.desired.entry(key_of(&name, &key)).or_insert(Desired {
                    name,
                    key,
                    refs: 0,
                    wire_id: None,
                    in_flight: false,
                });
                entry.refs += 1;
                let k = key_of(&entry.name, &entry.key);
                self.establish(&k).await;
            }
            Command::Unsubscribe(name, key) => {
                let k = key_of(&name, &key);
                let Some(entry) = self.desired.get_mut(&k) else { return };
                entry.refs -= 1;
                if entry.refs > 0 {
                    return;
                }
                let wire_id = self.desired.remove(&k).and_then(|d| d.wire_id);
                if let Some(id) = wire_id {
                    self.send(json!({"msg": "unsub", "id": id})).await;
                }
            }
            Command::WhenArmed(tx) => {
                self.armed_waiters.push(tx);
                self.notify_armed_if_idle();
            }
            Command::Inspect(tx) => {
                let established = self.desired.values().filter(|d| d.wire_id.is_some()).count();
                let _ = tx.send((self.state, established));
            }
        }
    }

    async fn establish(&mut self, k: &str) {
        let Some(entry) = self.desired.get(k) else { return };
        if self.state != State::Authenticated || entry.wire_id.is_some() || entry.in_flight {
            return;
        }
        let (name, key) = (entry.name.clone(), entry.key.clone());
        let id = self.next_id('s');
        self.desired.get_mut(k).unwrap().in_flight = true;
        self.expect(&id, PendingKind::Sub, k);
        // Rocket.Chat streamers take this object as their last parameter.
        self.send(json!({
            "msg": "sub", "id": id, "name": name,
            "params": [key, {"useCollection": false, "args": []}],
        }))
        .await;
    }

    fn expect(&mut self, id: &str, kind: PendingKind, sub_key: &str) {
        let deadline = Instant::now() + self.timeouts.request;
        self.pending.insert(id.to_owned(), Pending { kind, sub_key: sub_key.to_owned(), deadline });
    }

    async fn settle(&mut self, id: &str, success: bool) {
        let Some(pending) = self.pending.remove(id) else { return };
        match pending.kind {
            PendingKind::Login => {
                if !success {
                    self.teardown(false);
                    return;
                }
                self.set_state(State::Authenticated);
                self.last_traffic = Instant::now();
                self.next_watchdog = Some(Instant::now() + self.timeouts.watchdog);
                let keys: Vec<String> = self.desired.keys().cloned().collect();
                for k in keys {
                    self.establish(&k).await;
                }
                self.emit(DdpEvent::Authenticated);
                self.notify_armed_if_idle();
            }
            PendingKind::Sub => {
                match self.desired.get_mut(&pending.sub_key) {
                    Some(d) if d.in_flight => {
                        d.in_flight = false;
                        // A failed sub stays desired and is retried at the next login.
                        if success {
                            d.wire_id = Some(id.to_owned());
                        }
                    }
                    _ if success => {
                        // Released while negotiating: the server just established it.
                        self.send(json!({"msg": "unsub", "id": id})).await;
                    }
                    _ => {}
                }
                self.notify_armed_if_idle();
            }
            PendingKind::Probe => {
                self.probing = false;
                if !success {
                    self.teardown(false);
                }
            }
        }
    }

    fn notify_armed_if_idle(&mut self) {
        if self.desired.values().any(|d| d.in_flight) {
            return;
        }
        for waiter in self.armed_waiters.drain(..) {
            let _ = waiter.send(());
        }
    }

    async fn on_timers(&mut self) {
        let now = Instant::now();
        if self.connect_deadline.is_some_and(|d| d <= now) {
            self.teardown(false);
            return;
        }
        let expired: Vec<String> =
            self.pending.iter().filter(|(_, p)| p.deadline <= now).map(|(id, _)| id.clone()).collect();
        for id in expired {
            self.settle(&id, false).await;
        }
        if self.next_watchdog.is_some_and(|d| d <= now) {
            self.next_watchdog = Some(now + self.timeouts.watchdog);
            if !self.probing && now.duration_since(self.last_traffic) >= self.timeouts.silence_max {
                self.probe().await;
            }
        }
    }

    async fn probe(&mut self) {
        // A negotiation in progress is not probed: 8.5 answers a `ping` sent
        // before `connect` with `msg: 'error'`, never a pong. `Connected` does pong.
        if !matches!(self.state, State::Connected | State::Authenticated) {
            return;
        }
        self.probing = true;
        let id = self.next_id('v');
        self.expect(&id, PendingKind::Probe, "");
        self.send(json!({"msg": "ping", "id": id})).await;
    }

    async fn on_message(&mut self, text: &str) {
        let Ok(m) = serde_json::from_str::<Value>(text) else { return };
        let str_of = |key: &str| m.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        match str_of("msg").as_str() {
            "connected" => {
                self.connect_deadline = None;
                self.set_state(State::Connected);
                let id = self.next_id('m');
                self.expect(&id, PendingKind::Login, "");
                let token = self.token.clone();
                self.send(json!({"msg": "method", "id": id, "method": "login", "params": [{"resume": token}]})).await;
            }
            "failed" => self.teardown(false),
            "ping" => {
                // The server drops sockets that do not pong.
                let mut pong = json!({"msg": "pong"});
                if let Some(id) = m.get("id") {
                    pong["id"] = id.clone();
                }
                self.send(pong).await;
            }
            "pong" => {
                if let Some(id) = m.get("id").and_then(Value::as_str) {
                    self.settle(id, true).await;
                }
            }
            "result" => self.settle(&str_of("id"), m.get("error").is_none()).await,
            "ready" => {
                let ids: Vec<String> = m
                    .get("subs")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                    .unwrap_or_default();
                for id in ids {
                    self.settle(&id, true).await;
                }
            }
            "nosub" => self.settle(&str_of("id"), false).await,
            "error" => {
                // An out-of-sequence message gets `msg: 'error'`, never its
                // answer. `offendingMessage` carries the faulty id: reject that wait only.
                if let Some(id) = m.pointer("/offendingMessage/id").and_then(Value::as_str) {
                    self.settle(id, false).await;
                }
            }
            "changed" => {
                let collection = str_of("collection");
                let key = m.pointer("/fields/eventName").and_then(Value::as_str).unwrap_or_default().to_owned();
                if !collection.is_empty() && !key.is_empty() {
                    let args = m.pointer("/fields/args").and_then(Value::as_array).cloned().unwrap_or_default();
                    self.emit(DdpEvent::Changed { collection, key, args });
                }
            }
            _ => {}
        }
    }

    fn teardown(&mut self, voluntary: bool) {
        if self.state == State::Closed && self.sink.is_none() && !self.connect_requested {
            return;
        }
        self.epoch += 1;
        self.sink = None;
        self.connect_requested = false;
        self.connect_deadline = None;
        self.next_watchdog = None;
        self.probing = false;
        self.pending.clear();
        for d in self.desired.values_mut() {
            d.wire_id = None;
            d.in_flight = false;
        }
        self.set_state(State::Closed);
        self.notify_armed_if_idle();
        if !voluntary {
            self.emit(DdpEvent::Lost);
        }
    }
}

fn far_future() -> Instant {
    Instant::now() + Duration::from_secs(86_400)
}
