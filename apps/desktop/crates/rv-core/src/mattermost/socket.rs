//! The real-time socket of a Mattermost or kChat account. One actor task owns
//! it; the handle only sends commands. The server pushes every event of the
//! account once authenticated: there is nothing to subscribe per room.
//!
//! Mattermost (probed on 11.11): the token goes in an
//! `authentication_challenge` action, each action answers `{status,
//! seq_reply}`. kChat speaks Pusher instead (`pusher`).

use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;

use crate::ddp::State;
use crate::rest::RestClient;

const HANDSHAKE: Duration = Duration::from_secs(15);
const HEARTBEAT: Duration = Duration::from_secs(30);
/// Two heartbeats without a single frame back: the socket is dead.
const SILENCE_MAX: Duration = Duration::from_secs(75);

pub(crate) type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub(crate) type Sink = SplitSink<Socket, WsMessage>;
pub(crate) type Stream = SplitStream<Socket>;

#[derive(Debug, Clone, PartialEq)]
pub enum LiveEvent {
    State(State),
    Authenticated,
    /// The connection dropped without `close()` being asked.
    Lost,
    Event {
        name: String,
        data: Value,
        broadcast: Value,
    },
}

#[derive(Clone)]
pub enum Dialect {
    Mattermost,
    Kchat,
}

enum Command {
    Open,
    Close,
    Typing { channel: String, parent: Option<String> },
}

#[derive(Clone)]
pub struct LiveHandle {
    commands: mpsc::UnboundedSender<Command>,
}

impl LiveHandle {
    pub fn open(&self) {
        let _ = self.commands.send(Command::Open);
    }

    /// Voluntary close: never reported as `Lost`.
    pub fn close(&self) {
        let _ = self.commands.send(Command::Close);
    }

    /// Mattermost only: kChat has no typing action a third-party client can send.
    pub fn typing(&self, channel: &str, parent: Option<&str>) {
        let _ = self.commands.send(Command::Typing { channel: channel.to_owned(), parent: parent.map(str::to_owned) });
    }
}

pub fn websocket_url(base: &Url) -> Url {
    let mut url = base.clone();
    let scheme = if base.scheme() == "http" { "ws" } else { "wss" };
    url.set_scheme(scheme).expect("ws scheme");
    url.set_path(&format!("{}/api/v4/websocket", base.path().trim_end_matches('/')));
    url
}

pub fn spawn(dialect: Dialect, rest: RestClient, token: String) -> (LiveHandle, mpsc::UnboundedReceiver<LiveEvent>) {
    let (commands, rx) = mpsc::unbounded_channel();
    let (events, events_rx) = mpsc::unbounded_channel();
    let actor = Actor { dialect, rest, token, events, seq: 0 };
    tokio::spawn(actor.run(rx));
    (LiveHandle { commands }, events_rx)
}

enum Ended {
    Closed,
    Lost,
    Dropped,
}

struct Actor {
    dialect: Dialect,
    rest: RestClient,
    token: String,
    events: mpsc::UnboundedSender<LiveEvent>,
    seq: u64,
}

pub(crate) async fn send(sink: &mut Sink, message: &Value) -> bool {
    sink.send(WsMessage::text(message.to_string())).await.is_ok()
}

/// The next text frame as JSON, or None when the socket ends.
pub(crate) async fn next_json(stream: &mut Stream) -> Option<Value> {
    while let Some(frame) = stream.next().await {
        match frame.ok()? {
            WsMessage::Text(text) => match serde_json::from_str(text.as_str()) {
                Ok(v) => return Some(v),
                Err(_) => continue,
            },
            WsMessage::Close(_) => return None,
            _ => continue,
        }
    }
    None
}

impl Actor {
    fn emit(&self, event: LiveEvent) {
        let _ = self.events.send(event);
    }

    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        loop {
            match commands.recv().await {
                None => return,
                Some(Command::Open) => {}
                Some(_) => continue,
            }
            self.emit(LiveEvent::State(State::Connecting));
            let ended = match self.connect().await {
                Some((sink, stream)) => self.serve(sink, stream, &mut commands).await,
                None => Ended::Lost,
            };
            self.emit(LiveEvent::State(State::Closed));
            match ended {
                Ended::Dropped => return,
                Ended::Lost => self.emit(LiveEvent::Lost),
                Ended::Closed => {}
            }
        }
    }

    async fn connect(&mut self) -> Option<(Sink, Stream)> {
        crate::tls::ensure_provider();
        match self.dialect {
            Dialect::Mattermost => {
                let url = websocket_url(self.rest.base());
                let (socket, _) =
                    tokio::time::timeout(HANDSHAKE, tokio_tungstenite::connect_async(url.as_str())).await.ok()?.ok()?;
                let (mut sink, mut stream) = socket.split();
                self.seq += 1;
                let challenge =
                    json!({"seq": self.seq, "action": "authentication_challenge", "data": {"token": self.token}});
                if !send(&mut sink, &challenge).await {
                    return None;
                }
                let expected = self.seq;
                let authenticated = tokio::time::timeout(HANDSHAKE, async {
                    while let Some(message) = next_json(&mut stream).await {
                        if message.get("seq_reply").and_then(Value::as_u64) == Some(expected) {
                            return message.get("status").and_then(Value::as_str) == Some("OK");
                        }
                    }
                    false
                })
                .await
                .unwrap_or(false);
                authenticated.then_some((sink, stream))
            }
            Dialect::Kchat => super::pusher::connect(&self.rest, &self.token).await,
        }
    }

    async fn serve(
        &mut self,
        mut sink: Sink,
        mut stream: Stream,
        commands: &mut mpsc::UnboundedReceiver<Command>,
    ) -> Ended {
        self.emit(LiveEvent::State(State::Authenticated));
        self.emit(LiveEvent::Authenticated);
        let mut last_traffic = Instant::now();
        let mut heartbeat = tokio::time::interval_at(Instant::now() + HEARTBEAT, HEARTBEAT);
        loop {
            tokio::select! {
                command = commands.recv() => match command {
                    None => {
                        let _ = sink.close().await;
                        return Ended::Dropped;
                    }
                    Some(Command::Close) => {
                        let _ = sink.close().await;
                        return Ended::Closed;
                    }
                    Some(Command::Open) => {}
                    Some(Command::Typing { channel, parent }) => {
                        if matches!(self.dialect, Dialect::Mattermost) {
                            self.seq += 1;
                            let data = json!({"channel_id": channel, "parent_id": parent.unwrap_or_default()});
                            let _ = send(&mut sink, &json!({"seq": self.seq, "action": "user_typing", "data": data})).await;
                        }
                    }
                },
                message = next_json(&mut stream) => {
                    let Some(message) = message else { return Ended::Lost };
                    last_traffic = Instant::now();
                    match self.dialect {
                        Dialect::Mattermost => self.mattermost_frame(message),
                        Dialect::Kchat => {
                            if let Some(reply) = super::pusher::frame(&message, |e| self.emit(e)) {
                                let _ = send(&mut sink, &reply).await;
                            }
                        }
                    }
                }
                _ = heartbeat.tick() => {
                    if last_traffic.elapsed() > SILENCE_MAX {
                        return Ended::Lost;
                    }
                    let ping = match self.dialect {
                        Dialect::Mattermost => {
                            self.seq += 1;
                            json!({"seq": self.seq, "action": "ping"})
                        }
                        Dialect::Kchat => json!({"event": "pusher:ping", "data": {}}),
                    };
                    if !send(&mut sink, &ping).await {
                        return Ended::Lost;
                    }
                }
            }
        }
    }

    fn mattermost_frame(&self, message: Value) {
        let Some(name) = message.get("event").and_then(Value::as_str) else { return };
        if name == "hello" {
            return;
        }
        self.emit(LiveEvent::Event {
            name: name.to_owned(),
            data: message.get("data").cloned().unwrap_or(Value::Null),
            broadcast: message.get("broadcast").cloned().unwrap_or(Value::Null),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_url_follows_scheme_and_path() {
        assert_eq!(websocket_url(&"https://a.b/chat".parse().unwrap()).as_str(), "wss://a.b/chat/api/v4/websocket");
        assert_eq!(
            websocket_url(&"http://localhost:8065".parse().unwrap()).as_str(),
            "ws://localhost:8065/api/v4/websocket"
        );
    }
}
