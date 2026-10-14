//! The Slack RTM socket of an account, behind the same `LiveEvent` feed the
//! Mattermost socket uses. One actor owns it; the handle only sends commands.
//!
//! `rtm.connect` names a `wss` URL authenticated by the session `d` cookie on
//! the upgrade (no bearer). Slack then pushes every event of the account:
//! there is nothing to subscribe per room. The stream counts as live only
//! after Slack's `hello`, never on the HTTP upgrade, since an `error` frame
//! can follow it. Liveness is Slack's own `ping`/`pong` plus a silence bound.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use url::Url;
use zeroize::Zeroizing;

use crate::ddp::State;
use crate::mattermost::socket::{LiveEvent, Sink, Stream, next_json, send};
use crate::rest::{CallOptions, RestClient};

const HANDSHAKE: Duration = Duration::from_secs(15);
const HEARTBEAT: Duration = Duration::from_secs(30);
/// Two heartbeats without a single frame back: the socket is dead.
const SILENCE_MAX: Duration = Duration::from_secs(75);

enum Command {
    Open,
    Close,
    Typing { channel: String },
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

    pub fn typing(&self, channel: &str) {
        let _ = self.commands.send(Command::Typing { channel: channel.to_owned() });
    }
}

pub fn spawn(
    rest: RestClient,
    team_id: String,
    user_id: String,
    cookie: Zeroizing<String>,
) -> (LiveHandle, mpsc::UnboundedReceiver<LiveEvent>) {
    let (commands, rx) = mpsc::unbounded_channel();
    let (events, events_rx) = mpsc::unbounded_channel();
    let actor = Actor { rest, team_id, user_id, cookie, events, id: 0 };
    tokio::spawn(actor.run(rx));
    (LiveHandle { commands }, events_rx)
}

/// Slack's message servers: a `wss` URL on one of its own hosts, nothing else
/// may carry the cookie.
pub(crate) fn rtm_url(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    let host = url.host_str()?;
    let slack = host == "slack.com"
        || host.ends_with(".slack.com")
        || host == "slack-msgs.com"
        || host.ends_with(".slack-msgs.com");
    (url.scheme() == "wss"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && slack
        && host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-'))
    .then_some(url)
}

enum Ended {
    Closed,
    Lost,
    Dropped,
}

struct Actor {
    rest: RestClient,
    team_id: String,
    user_id: String,
    cookie: Zeroizing<String>,
    events: mpsc::UnboundedSender<LiveEvent>,
    id: u64,
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
        let params = vec![("batch_presence_aware", "1".to_owned()), ("presence_sub", "true".to_owned())];
        let body = self.rest.post("rtm.connect", CallOptions::params(params)).await.ok()?;
        let team = body.get("team").and_then(|t| t.get("id")).and_then(Value::as_str);
        let self_id = body.get("self").and_then(|s| s.get("id")).and_then(Value::as_str);
        if team != Some(self.team_id.as_str()) || self_id != Some(self.user_id.as_str()) {
            return None;
        }
        let url = rtm_url(body.get("url").and_then(Value::as_str)?)?;
        let mut request = url.as_str().into_client_request().ok()?;
        let cookie = format!("d={}", self.cookie.as_str());
        request.headers_mut().insert("Cookie", cookie.parse().ok()?);
        let (socket, _) =
            tokio::time::timeout(HANDSHAKE, tokio_tungstenite::connect_async(request)).await.ok()?.ok()?;
        let (sink, mut stream) = socket.split();
        // The stream only counts as live once `hello` arrived; an `error`
        // frame before it (a bad token, too many connections) ends the try.
        let greeted = tokio::time::timeout(HANDSHAKE, async {
            while let Some(frame) = next_json(&mut stream).await {
                match frame.get("type").and_then(Value::as_str) {
                    Some("hello") => return true,
                    Some("error") => return false,
                    _ => continue,
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        greeted.then_some((sink, stream))
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
                    Some(Command::Typing { channel }) => {
                        self.id += 1;
                        let _ = send(&mut sink, &json!({"id": self.id, "type": "typing", "channel": channel})).await;
                    }
                },
                message = next_json(&mut stream) => {
                    let Some(message) = message else { return Ended::Lost };
                    last_traffic = Instant::now();
                    self.frame(message);
                }
                _ = heartbeat.tick() => {
                    if last_traffic.elapsed() > SILENCE_MAX {
                        return Ended::Lost;
                    }
                    self.id += 1;
                    if !send(&mut sink, &json!({"id": self.id, "type": "ping"})).await {
                        return Ended::Lost;
                    }
                }
            }
        }
    }

    /// A data frame goes on as `LiveEvent::Event` named by its `type`; a
    /// reply (`pong`, a send ack) and `hello` are handled on the spot.
    fn frame(&self, message: Value) {
        if message.get("reply_to").is_some() && message.get("type").and_then(Value::as_str).is_none_or(|t| t == "pong")
        {
            return;
        }
        let Some(name) = message.get("type").and_then(Value::as_str) else { return };
        if name == "hello" || name == "pong" {
            return;
        }
        self.emit(LiveEvent::Event { name: name.to_owned(), data: message, broadcast: Value::Null });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rtm_urls_are_wss_on_slack_message_servers() {
        assert!(rtm_url("wss://wss-primary.slack-msgs.com/websocket/x").is_some());
        assert!(rtm_url("wss://cerberus.slack.com/websocket").is_some());
        assert!(rtm_url("ws://wss-primary.slack-msgs.com/websocket").is_none());
        assert!(rtm_url("wss://evil.example/websocket").is_none());
        assert!(rtm_url("wss://wss-primary.slack-msgs.com:9443/websocket").is_none());
        assert!(rtm_url("https://wss-primary.slack-msgs.com/websocket").is_none());
    }
}
