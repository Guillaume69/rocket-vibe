//! The Trouter connection of a Teams account, behind the same `LiveEvent`
//! feed the other live sockets use. One actor owns it; the handle only sends
//! commands. Chat events arrive for every conversation once the endpoint is
//! registered: there is nothing to subscribe per room.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use super::auth::Tokens;
use super::frames::{self, Frame};
use rv_provider::socket::State;
use rv_provider::socket::{LiveEvent, Sink, Stream};

const HANDSHAKE: Duration = Duration::from_secs(15);
/// Trouter's heartbeat is 70 s: three missed are a dead socket.
const SILENCE_MAX: Duration = Duration::from_secs(210);
const REGISTER_AGAIN: Duration = Duration::from_secs(6 * 3600);
const TROUTER_HOSTS: &str = ".trouter.teams.microsoft.com";

enum Command {
    Open,
    Close,
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
}

pub fn spawn(tokens: Arc<Tokens>) -> (LiveHandle, mpsc::UnboundedReceiver<LiveEvent>) {
    let (commands, rx) = mpsc::unbounded_channel();
    let (events, events_rx) = mpsc::unbounded_channel();
    tokio::spawn(Actor { tokens, events }.run(rx));
    (LiveHandle { commands }, events_rx)
}

/// A fresh version-4 UUID naming this connection's endpoint.
fn endpoint_id() -> Option<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).ok()?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Some(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

/// An `https` URL on one of Trouter's hosts.
fn trouter_url(raw: &str) -> Option<url::Url> {
    let url = url::Url::parse(raw).ok()?;
    let host = url.host_str()?;
    (url.scheme() == "https" && url.username().is_empty() && host.ends_with(TROUTER_HOSTS)).then_some(url)
}

enum Ended {
    Closed,
    Lost,
    Dropped,
}

struct Socket {
    sink: Sink,
    stream: Stream,
    epid: String,
    surl: String,
}

struct Actor {
    tokens: Arc<Tokens>,
    events: mpsc::UnboundedSender<LiveEvent>,
}

impl Actor {
    fn emit(&self, event: LiveEvent) {
        let _ = self.events.send(event);
    }

    async fn run(self, mut commands: mpsc::UnboundedReceiver<Command>) {
        loop {
            match commands.recv().await {
                None => return,
                Some(Command::Open) => {}
                Some(Command::Close) => continue,
            }
            self.emit(LiveEvent::State(State::Connecting));
            let ended = match self.connect().await {
                Some(socket) => self.serve(socket, &mut commands).await,
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

    async fn connect(&self) -> Option<Socket> {
        rv_provider::tls::ensure_provider();
        let (skype, routes) = self.tokens.chat().await.ok()?;
        let base = trouter_url(&routes.trouter)?;
        let epid = endpoint_id()?;
        let client_info = json!({"cv": "2026.10.0.1", "ua": "TeamsCDL", "hr": "", "v": "1415/26.10.0.0"}).to_string();
        let mut allocate = base.join("/v4/a").ok()?;
        allocate.query_pairs_mut().append_pair("epid", &epid).append_pair("tc", &client_info);
        let http = super::client::http();
        let answer: Value = http
            .post(allocate)
            .header("X-Skypetoken", skype.as_str())
            .header("content-type", "text/plain")
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        let socketio = trouter_url(answer.get("socketio")?.as_str()?)?;
        let surl = trouter_url(answer.get("surl")?.as_str()?)?.to_string();
        let params = answer.get("connectparams")?.as_object()?.clone();
        let mut query: Vec<(String, String)> =
            params.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned()))).collect();
        let con_num = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or_else(|_| "0".to_owned(), |d| d.as_millis().to_string());
        query.extend([
            ("v".into(), "v4".into()),
            ("tc".into(), client_info),
            ("timeout".into(), "40".into()),
            ("auth".into(), "true".into()),
            ("epid".into(), epid.clone()),
            ("cor_id".into(), endpoint_id()?),
            ("con_num".into(), format!("{con_num}_1")),
        ]);
        let mut handshake = socketio.join("socket.io/1/").ok()?;
        handshake.query_pairs_mut().extend_pairs(&query);
        let sid = tokio::time::timeout(HANDSHAKE, async {
            let text =
                http.get(handshake).header("X-Skypetoken", skype.as_str()).send().await.ok()?.text().await.ok()?;
            text.split(':')
                .next()
                .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
                .map(str::to_owned)
        })
        .await
        .ok()??;
        let mut socket_url = socketio.join(&format!("socket.io/1/websocket/{sid}")).ok()?;
        socket_url.set_scheme("wss").ok()?;
        socket_url.query_pairs_mut().extend_pairs(&query);
        let mut request = socket_url.as_str().into_client_request().ok()?;
        request.headers_mut().insert("X-Skypetoken", skype.as_str().parse().ok()?);
        let (socket, _) =
            tokio::time::timeout(HANDSHAKE, tokio_tungstenite::connect_async(request)).await.ok()?.ok()?;
        let (mut sink, mut stream) = socket.split();
        let connected = tokio::time::timeout(HANDSHAKE, async {
            while let Some(Ok(WsMessage::Text(text))) = stream.next().await {
                if frames::parse(text.as_str()) == Frame::Connect {
                    return sink
                        .send(WsMessage::text(frames::authenticate(&skype, &Value::Object(params.clone()))))
                        .await
                        .is_ok();
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        connected.then_some(Socket { sink, stream, epid, surl })
    }

    /// Asks the registrar to route this account's chat events to the socket.
    async fn register(&self, epid: &str, surl: &str) -> bool {
        let Ok((skype, routes)) = self.tokens.chat().await else { return false };
        let Ok(registrar) = url::Url::parse(&routes.registrar) else { return false };
        let body = json!({
            "clientDescription": {
                "appId": "TeamsCDLWebWorker", "aesKey": "", "languageId": "en-US", "platform": "edge",
                "templateKey": "TeamsCDLWebWorker_2.6", "platformUIVersion": "49/26.10.0.0",
            },
            "registrationId": epid,
            "nodeId": "",
            "transports": {"TROUTER": [{"context": "", "path": surl, "ttl": 86400}]},
        });
        let sent =
            super::client::http().post(registrar).header("X-Skypetoken", skype.as_str()).json(&body).send().await;
        sent.is_ok_and(|r| r.status().is_success())
    }

    async fn serve(&self, mut socket: Socket, commands: &mut mpsc::UnboundedReceiver<Command>) -> Ended {
        if !self.register(&socket.epid, &socket.surl).await {
            return Ended::Lost;
        }
        self.emit(LiveEvent::State(State::Authenticated));
        self.emit(LiveEvent::Authenticated);
        let mut last_traffic = Instant::now();
        let mut check = tokio::time::interval(Duration::from_secs(30));
        let mut renew = tokio::time::interval_at(Instant::now() + REGISTER_AGAIN, REGISTER_AGAIN);
        loop {
            tokio::select! {
                command = commands.recv() => match command {
                    None => {
                        let _ = socket.sink.close().await;
                        return Ended::Dropped;
                    }
                    Some(Command::Close) => {
                        let _ = socket.sink.close().await;
                        return Ended::Closed;
                    }
                    Some(Command::Open) => {}
                },
                frame = socket.stream.next() => {
                    let text = match frame {
                        Some(Ok(WsMessage::Text(text))) => text,
                        Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => return Ended::Lost,
                        Some(Ok(_)) => continue,
                    };
                    last_traffic = Instant::now();
                    if !self.frame(&mut socket.sink, text.as_str()).await {
                        return Ended::Lost;
                    }
                }
                _ = check.tick() => {
                    if last_traffic.elapsed() > SILENCE_MAX {
                        return Ended::Lost;
                    }
                }
                _ = renew.tick() => {
                    if !self.register(&socket.epid, &socket.surl).await {
                        return Ended::Lost;
                    }
                }
            }
        }
    }

    /// Answers one frame; false when the socket can no longer be written.
    async fn frame(&self, sink: &mut Sink, text: &str) -> bool {
        match frames::parse(text) {
            Frame::Heartbeat => sink.send(WsMessage::text(frames::HEARTBEAT)).await.is_ok(),
            Frame::Event(name) => {
                if name == "trouter.message_loss" {
                    self.emit(LiveEvent::Authenticated);
                }
                true
            }
            Frame::Request { envelope, ack } => {
                if let Some(reply) = frames::reply(&envelope)
                    && sink.send(WsMessage::text(reply)).await.is_err()
                {
                    return false;
                }
                if let Some(id) = ack
                    && sink.send(WsMessage::text(frames::ack(&id))).await.is_err()
                {
                    return false;
                }
                if let Some((name, data)) = frames::chat_event(&envelope) {
                    self.emit(LiveEvent::Event { name, data, broadcast: Value::Null });
                }
                true
            }
            Frame::Connect | Frame::Other => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_ids_are_v4_uuids() {
        let id = endpoint_id().unwrap();
        assert_eq!((id.len(), &id[14..15]), (36, "4"));
        assert_ne!(id, endpoint_id().unwrap());
    }

    #[test]
    fn only_trouter_hosts_are_reached() {
        assert!(trouter_url("https://pub-ent-euno-13-t.trouter.teams.microsoft.com:443/").is_some());
        assert!(trouter_url("https://go-eu.trouter.teams.microsoft.com/v3/c").is_some());
        for bad in [
            "http://go-eu.trouter.teams.microsoft.com/",
            "https://trouter.teams.microsoft.com.evil.example/",
            "https://user@go.trouter.teams.microsoft.com/",
            "https://evil.example/",
        ] {
            assert!(trouter_url(bad).is_none(), "{bad}");
        }
    }
}
