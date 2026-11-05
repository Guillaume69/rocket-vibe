//! The XMPP connection and the Jingle session of a joined conference.

use std::collections::BTreeMap;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use super::Config;
use super::sdp::{self, Answer, JINGLE, Offer};
use crate::xml::Element;
use crate::{CallSignaling, Candidate, Error, Event, IceServer, Member, random_hex};

const CLIENT: &str = "jabber:client";
const FRAMING: &str = "urn:ietf:params:xml:ns:xmpp-framing";
const STREAMS: &str = "http://etherx.jabber.org/streams";
const SASL: &str = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND: &str = "urn:ietf:params:xml:ns:xmpp-bind";
const MUC: &str = "http://jabber.org/protocol/muc";
const MUC_USER: &str = "http://jabber.org/protocol/muc#user";
const NICK: &str = "http://jabber.org/protocol/nick";
const DISCO_INFO: &str = "http://jabber.org/protocol/disco#info";
const PING: &str = "urn:xmpp:ping";
const EXTDISCO: &str = "urn:xmpp:extdisco:2";
const FOCUS: &str = "http://jitsi.org/protocol/focus";

/// How often the server is pinged, and how long without a frame from it means
/// the socket is gone.
const PING_EVERY: std::time::Duration = std::time::Duration::from_secs(25);
const SILENCE: std::time::Duration = std::time::Duration::from_secs(90);

/// `RV_CALL_DEBUG=1` prints each Jingle action and why a session ended, to stderr.
fn debug(what: &str) {
    if std::env::var("RV_CALL_DEBUG").as_deref() == Ok("1") {
        eprintln!("rv-call: {what}");
    }
}

/// What this client can do, as Jicofo reads it (disco#info): audio over ICE and
/// DTLS-SRTP, bundled and multiplexed, with source names; no video, no SCTP.
const FEATURES: [&str; 11] = [
    DISCO_INFO,
    "urn:xmpp:jingle:1",
    "urn:xmpp:jingle:apps:rtp:1",
    "urn:xmpp:jingle:transports:ice-udp:1",
    "urn:xmpp:jingle:apps:dtls:0",
    "urn:xmpp:jingle:apps:rtp:audio",
    "urn:xmpp:jingle:apps:rtp:rtp-hdrext:0",
    "urn:xmpp:jingle:apps:grouping:0",
    "urn:ietf:rfc:5761",
    "urn:ietf:rfc:5888",
    "http://jitsi.org/source-name",
];

enum Command {
    Answer(String),
    Candidate(Candidate),
    Muted(bool),
    Leave(oneshot::Sender<()>),
}

/// A joined Jitsi conference.
pub struct Session {
    events: mpsc::UnboundedReceiver<Event>,
    commands: mpsc::UnboundedSender<Command>,
    endpoint: String,
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connects, logs in, asks the focus for the conference and joins its room.
pub async fn join(config: Config) -> Result<Session, Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut request = config.socket_url().into_client_request().map_err(|e| Error::new(format!("url: {e}")))?;
    request.headers_mut().insert("Sec-WebSocket-Protocol", "xmpp".parse().expect("static header"));
    let (mut socket, _) =
        tokio_tungstenite::connect_async(request).await.map_err(|e| Error::new(format!("connect: {e}")))?;

    open(&mut socket, &config.domain).await?;
    let features = expect(&mut socket, |e| e.is("features", STREAMS)).await?;
    let mechanisms: Vec<String> = features
        .find("mechanisms", SASL)
        .map(|m| m.find_all("mechanism", SASL).map(|e| e.content()).collect())
        .unwrap_or_default();
    if !mechanisms.iter().any(|m| m == "ANONYMOUS") {
        return Err(Error::new("no anonymous login"));
    }
    send(&mut socket, &Element::new("auth", SASL).attr("mechanism", "ANONYMOUS")).await?;
    let outcome = expect(&mut socket, |e| e.ns == SASL).await?;
    if outcome.name != "success" {
        return Err(Error::new("login refused"));
    }
    open(&mut socket, &config.domain).await?;
    expect(&mut socket, |e| e.is("features", STREAMS)).await?;
    let bind = iq("set", &config.domain).child(Element::new("bind", BIND));
    let bound = request_iq(&mut socket, bind).await?;
    let jid = bound
        .find("bind", BIND)
        .and_then(|b| b.find("jid", BIND))
        .map(Element::content)
        .ok_or_else(|| Error::new("no jid bound"))?;

    let ice = external_services(&mut socket, &config.domain).await;

    // Jicofo may take a moment to set the conference up: it says `ready='false'` until then.
    for attempt in 0..10 {
        let conference = iq("set", &config.focus).child(
            Element::new("conference", FOCUS)
                .attr("room", config.room_jid())
                .attr("machine-uid", random_hex(16))
                .child(Element::new("property", FOCUS).attr("name", "rtcpmux").attr("value", "true"))
                .child(Element::new("property", FOCUS).attr("name", "bundle").attr("value", "true"))
                .child(Element::new("property", FOCUS).attr("name", "startAudioMuted").attr("value", "9"))
                .child(Element::new("property", FOCUS).attr("name", "startVideoMuted").attr("value", "9")),
        );
        let answer = request_iq(&mut socket, conference).await?;
        if answer.find("conference", FOCUS).and_then(|c| c.get("ready")) != Some("false") {
            break;
        }
        if attempt == 9 {
            return Err(Error::new("conference not ready"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    let endpoint = random_hex(4);
    let (event_tx, events) = mpsc::unbounded_channel();
    let (commands, command_rx) = mpsc::unbounded_channel();
    let _ = event_tx.send(Event::IceServers(ice));
    let mut state = State {
        config,
        jid,
        endpoint: endpoint.clone(),
        muted: false,
        offer: None,
        initiator: None,
        answer: None,
        pending: Vec::new(),
        candidates_sent: 0,
        members: BTreeMap::new(),
        events: event_tx,
    };
    send(&mut socket, &state.presence(None)).await?;
    tokio::spawn(async move { state.run(socket, command_rx).await });
    Ok(Session { events, commands, endpoint })
}

impl CallSignaling for Session {
    async fn next_event(&mut self) -> Option<Event> {
        self.events.recv().await
    }

    async fn answer(&mut self, sdp: &str) -> Result<(), Error> {
        self.commands.send(Command::Answer(sdp.to_owned())).map_err(|_| Error::new("session ended"))
    }

    async fn local_candidate(&mut self, candidate: Candidate) -> Result<(), Error> {
        self.commands.send(Command::Candidate(candidate)).map_err(|_| Error::new("session ended"))
    }

    async fn set_muted(&mut self, muted: bool) -> Result<(), Error> {
        self.commands.send(Command::Muted(muted)).map_err(|_| Error::new("session ended"))
    }

    async fn leave(&mut self) {
        let (done, wait) = oneshot::channel();
        if self.commands.send(Command::Leave(done)).is_ok() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(3), wait).await;
        }
    }

    fn local_id(&self) -> &str {
        &self.endpoint
    }
}

struct State {
    config: Config,
    jid: String,
    endpoint: String,
    muted: bool,
    offer: Option<Offer>,
    /// The focus occupant who offered, and the Jingle initiator.
    initiator: Option<(String, String)>,
    answer: Option<Answer>,
    /// Local candidates gathered before the answer went out.
    pending: Vec<Candidate>,
    candidates_sent: usize,
    members: BTreeMap<String, Member>,
    events: mpsc::UnboundedSender<Event>,
}

impl State {
    async fn run(&mut self, mut socket: Socket, mut commands: mpsc::UnboundedReceiver<Command>) {
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        let mut heard = tokio::time::Instant::now();
        let reason = loop {
            tokio::select! {
                frame = socket.next() => {
                    let Some(Ok(frame)) = frame else { break "connection_lost" };
                    heard = tokio::time::Instant::now();
                    let Message::Text(text) = frame else { continue };
                    let Some(stanza) = Element::parse(&text) else { continue };
                    if stanza.is("close", FRAMING) {
                        break "connection_closed";
                    }
                    for reply in self.stanza(stanza) {
                        if send(&mut socket, &reply).await.is_err() {
                            break;
                        }
                    }
                }
                command = commands.recv() => {
                    let Some(command) = command else { break "client_gone" };
                    if let Command::Leave(done) = command {
                        for frame in self.leave_frames() {
                            let _ = send(&mut socket, &frame).await;
                        }
                        let _ = socket.close(None).await;
                        let _ = done.send(());
                        break "client_initiated";
                    }
                    for frame in self.command(command) {
                        if send(&mut socket, &frame).await.is_err() {
                            break;
                        }
                    }
                }
                _ = ping.tick() => {
                    // Each ping is answered: a socket silent this long is dead even if TCP has not said so.
                    if heard.elapsed() > SILENCE {
                        break "connection_lost";
                    }
                    let ping = iq("get", &self.config.domain).child(Element::new("ping", PING));
                    if send(&mut socket, &ping).await.is_err() {
                        break "connection_lost";
                    }
                }
            }
        };
        debug(&format!("session ended: {reason}"));
        let _ = self.events.send(Event::Ended(reason.to_owned()));
    }

    fn room_jid(&self) -> String {
        self.config.room_jid()
    }

    /// This client's MUC presence; `kind` `unavailable` to leave.
    fn presence(&self, kind: Option<&str>) -> Element {
        let mut p = Element::new("presence", CLIENT).attr("to", format!("{}/{}", self.room_jid(), self.endpoint));
        if let Some(kind) = kind {
            p.set_attr("type", kind);
            return p;
        }
        let muted = if self.muted { "true" } else { "false" };
        p.child(Element::new("x", MUC))
            .child(Element::new("stats-id", CLIENT).text(random_hex(4)))
            .child(
                Element::new("SourceInfo", CLIENT).text(format!("{{\"{}-a0\":{{\"muted\":{muted}}}}}", self.endpoint)),
            )
            .child(Element::new("audiomuted", CLIENT).text(muted))
            .child(Element::new("videomuted", CLIENT).text("true"))
            .child(Element::new("nick", NICK).text(&self.config.display_name))
    }

    /// Replies and frames to send after one incoming stanza.
    fn stanza(&mut self, stanza: Element) -> Vec<Element> {
        match stanza.name.as_str() {
            "presence" => {
                self.presence_in(&stanza);
                Vec::new()
            }
            "iq" => self.iq_in(&stanza),
            _ => Vec::new(),
        }
    }

    fn presence_in(&mut self, p: &Element) {
        let Some(from) = p.get("from") else { return };
        let Some((room, nick)) = from.split_once('/') else { return };
        if room != self.room_jid() {
            return;
        }
        if p.get("type") == Some("error") {
            let _ = self.events.send(Event::Ended("join_refused".to_owned()));
            return;
        }
        // The focus and this client are not people in the call.
        let is_focus = p
            .find("x", MUC_USER)
            .and_then(|x| x.find("item", MUC_USER))
            .and_then(|i| i.get("jid"))
            .is_some_and(|j| j.starts_with("focus@"));
        if nick == self.endpoint || nick == "focus" || is_focus {
            return;
        }
        if p.get("type") == Some("unavailable") {
            self.members.remove(nick);
        } else {
            let name = p.find("nick", NICK).map(Element::content).unwrap_or_default();
            let muted = p.find("audiomuted", CLIENT).map(|m| m.content().trim() == "true").unwrap_or_else(|| {
                p.find("SourceInfo", CLIENT).map(|s| s.content().contains("\"muted\":true")).unwrap_or(false)
            });
            self.members.insert(nick.to_owned(), Member { id: nick.to_owned(), name, muted });
        }
        let _ = self.events.send(Event::Roster(self.members.values().cloned().collect()));
    }

    fn iq_in(&mut self, iq_in: &Element) -> Vec<Element> {
        let from = iq_in.get("from").unwrap_or_default().to_owned();
        let id = iq_in.get("id").unwrap_or_default().to_owned();
        let kind = iq_in.get("type").unwrap_or_default();
        if kind == "result" || kind == "error" {
            return Vec::new();
        }
        let result = Element::new("iq", CLIENT).attr("type", "result").attr("to", &from).attr("id", &id);
        if kind == "get" {
            if iq_in.find("ping", PING).is_some() {
                return vec![result];
            }
            if iq_in.find("query", DISCO_INFO).is_some() {
                let mut query = Element::new("query", DISCO_INFO).child(
                    Element::new("identity", DISCO_INFO)
                        .attr("category", "client")
                        .attr("type", "web")
                        .attr("name", "RocketVibe"),
                );
                for feature in FEATURES {
                    query.push(Element::new("feature", DISCO_INFO).attr("var", feature));
                }
                return vec![result.child(query)];
            }
            return vec![error_iq(&from, &id)];
        }
        let Some(jingle) = iq_in.find("jingle", JINGLE) else { return vec![error_iq(&from, &id)] };
        let mut out = vec![result];
        let from_focus = from.ends_with("/focus") || from.split('@').next() == Some("focus");
        debug(&format!(
            "jingle {} from {}",
            jingle.get("action").unwrap_or_default(),
            if from_focus { "focus" } else { "peer" }
        ));
        match jingle.get("action").unwrap_or_default() {
            "session-initiate" if !from_focus => {
                // Another participant offering peer to peer: declined, the bridge carries the call.
                out.push(terminate(&from, jingle.get("sid").unwrap_or_default(), "decline"));
            }
            "session-initiate" => {
                if let Some(offer) = Offer::from_initiate(jingle) {
                    let initiator = jingle.get("initiator").unwrap_or(&from).to_owned();
                    self.initiator = Some((from, initiator));
                    self.answer = None;
                    self.candidates_sent = 0;
                    let _ = self.events.send(Event::Offer { sdp: offer.sdp() });
                    self.offer = Some(offer);
                }
            }
            "source-add" | "addsource" => {
                if let Some(offer) = &mut self.offer {
                    offer.add(
                        jingle
                            .find_all("content", JINGLE)
                            .filter_map(|c| c.find("description", sdp::RTP))
                            .flat_map(sdp::parse_sources)
                            .collect(),
                    );
                    let _ = self.events.send(Event::Offer { sdp: offer.sdp() });
                }
            }
            "source-remove" | "removesource" => {
                if let Some(offer) = &mut self.offer {
                    let ssrcs: Vec<u32> = jingle
                        .find_all("content", JINGLE)
                        .filter_map(|c| c.find("description", sdp::RTP))
                        .flat_map(sdp::parse_sources)
                        .map(|s| s.ssrc)
                        .collect();
                    offer.remove(&ssrcs);
                    let _ = self.events.send(Event::Offer { sdp: offer.sdp() });
                }
            }
            "transport-info" => {
                if let Some(offer) = &self.offer {
                    for content in jingle.find_all("content", JINGLE) {
                        if let Some(t) = content.find("transport", sdp::ICE_UDP) {
                            for c in t.find_all("candidate", sdp::ICE_UDP) {
                                let _ = self
                                    .events
                                    .send(Event::RemoteCandidate(sdp::remote_candidate(offer, sdp::candidate_line(c))));
                            }
                        }
                    }
                }
            }
            "transport-replace" if from_focus => {
                // The focus restarting ICE or moving the call to another bridge: the
                // session is joined again from scratch rather than patched.
                let _ = self.events.send(Event::Ended("transport_replaced".to_owned()));
            }
            "session-terminate" if self.offer.as_ref().is_some_and(|o| Some(o.sid.as_str()) == jingle.get("sid")) => {
                self.offer = None;
                let _ = self.events.send(Event::Ended("terminated".to_owned()));
            }
            _ => {}
        }
        out
    }

    fn command(&mut self, command: Command) -> Vec<Element> {
        match command {
            Command::Answer(sdp) => {
                let (Some(offer), Some((to, initiator))) = (&self.offer, &self.initiator) else { return Vec::new() };
                if self.answer.is_some() {
                    // A renegotiation of sources stays local.
                    return Vec::new();
                }
                let mut answer = Answer::parse(&sdp, &offer.audio.name);
                for c in self.pending.drain(..) {
                    if !answer.transport.candidates.contains(&c.line) {
                        answer.transport.candidates.push(c.line);
                    }
                }
                self.candidates_sent = answer.transport.candidates.len();
                let accept = Element::new("jingle", JINGLE)
                    .attr("action", "session-accept")
                    .attr("initiator", initiator)
                    .attr("responder", &self.jid)
                    .attr("sid", &offer.sid)
                    .child(
                        Element::new("group", sdp::GROUPING)
                            .attr("semantics", "BUNDLE")
                            .child(Element::new("content", sdp::GROUPING).attr("name", &offer.audio.name)),
                    )
                    .child(answer.content(&offer.audio.name, &self.endpoint));
                let frame = iq("set", to).child(accept);
                self.answer = Some(answer);
                vec![frame]
            }
            Command::Candidate(candidate) => {
                let (Some(offer), Some((to, initiator)), Some(answer)) = (&self.offer, &self.initiator, &self.answer)
                else {
                    self.pending.push(candidate);
                    return Vec::new();
                };
                let Some(element) = sdp::candidate_element(&candidate.line, &format!("c{}", self.candidates_sent))
                else {
                    return Vec::new();
                };
                self.candidates_sent += 1;
                let mut transport = answer.transport_element(false);
                transport.push(element);
                let info = Element::new("jingle", JINGLE)
                    .attr("action", "transport-info")
                    .attr("initiator", initiator)
                    .attr("sid", &offer.sid)
                    .child(
                        Element::new("content", JINGLE)
                            .attr("creator", "initiator")
                            .attr("name", &offer.audio.name)
                            .child(transport),
                    );
                vec![iq("set", to).child(info)]
            }
            Command::Muted(muted) => {
                self.muted = muted;
                vec![self.presence(None)]
            }
            Command::Leave(_) => Vec::new(),
        }
    }

    fn leave_frames(&mut self) -> Vec<Element> {
        let mut frames = Vec::new();
        if let (Some(offer), Some((to, _))) = (&self.offer, &self.initiator) {
            frames.push(terminate(to, &offer.sid, "success"));
        }
        frames.push(self.presence(Some("unavailable")));
        frames.push(Element::new("close", FRAMING));
        frames
    }
}

fn iq(kind: &str, to: &str) -> Element {
    Element::new("iq", CLIENT).attr("type", kind).attr("to", to).attr("id", random_hex(6))
}

fn error_iq(to: &str, id: &str) -> Element {
    Element::new("iq", CLIENT).attr("type", "error").attr("to", to).attr("id", id).child(
        Element::new("error", CLIENT)
            .attr("type", "cancel")
            .child(Element::new("feature-not-implemented", "urn:ietf:params:xml:ns:xmpp-stanzas")),
    )
}

fn terminate(to: &str, sid: &str, reason: &str) -> Element {
    iq("set", to).child(
        Element::new("jingle", JINGLE)
            .attr("action", "session-terminate")
            .attr("sid", sid)
            .child(Element::new("reason", JINGLE).child(Element::new(reason, JINGLE))),
    )
}

async fn open(socket: &mut Socket, domain: &str) -> Result<(), Error> {
    send(socket, &Element::new("open", FRAMING).attr("to", domain).attr("version", "1.0")).await?;
    expect(socket, |e| e.is("open", FRAMING)).await.map(|_| ())
}

async fn send(socket: &mut Socket, element: &Element) -> Result<(), Error> {
    socket.send(Message::text(element.write())).await.map_err(|e| Error::new(format!("send: {e}")))
}

/// The next stanza `wanted` accepts, within ten seconds; others in between are dropped.
async fn expect(socket: &mut Socket, wanted: impl Fn(&Element) -> bool) -> Result<Element, Error> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let frame = tokio::time::timeout_at(deadline, socket.next())
            .await
            .map_err(|_| Error::new("timed out"))?
            .ok_or_else(|| Error::new("connection closed"))?
            .map_err(|e| Error::new(format!("receive: {e}")))?;
        let Message::Text(text) = frame else { continue };
        let Some(stanza) = Element::parse(&text) else { continue };
        if stanza.is("close", FRAMING) {
            return Err(Error::new("server closed the stream"));
        }
        if wanted(&stanza) {
            return Ok(stanza);
        }
    }
}

/// Sends an IQ and waits for its result; an error answer is an error.
async fn request_iq(socket: &mut Socket, request: Element) -> Result<Element, Error> {
    let id = request.get("id").unwrap_or_default().to_owned();
    send(socket, &request).await?;
    let answer = expect(socket, |e| e.name == "iq" && e.get("id") == Some(id.as_str())).await?;
    if answer.get("type") == Some("error") {
        return Err(Error::new(format!(
            "{} refused",
            request.elements().next().map(|e| e.name.as_str()).unwrap_or("iq")
        )));
    }
    Ok(answer)
}

/// TURN and STUN servers the deployment announces (XEP-0215); none is fine.
async fn external_services(socket: &mut Socket, domain: &str) -> Vec<IceServer> {
    let query = iq("get", domain).child(Element::new("services", EXTDISCO));
    let Ok(answer) = request_iq(socket, query).await else { return Vec::new() };
    let Some(services) = answer.find("services", EXTDISCO) else { return Vec::new() };
    services.find_all("service", EXTDISCO).filter_map(ice_server).collect()
}

fn ice_server(service: &Element) -> Option<IceServer> {
    let kind = service.get("type")?;
    if !matches!(kind, "stun" | "turn" | "turns") {
        return None;
    }
    let host = service.get("host")?;
    let mut url = format!("{kind}:{host}");
    if let Some(port) = service.get("port") {
        url.push(':');
        url.push_str(port);
    }
    if kind != "stun"
        && let Some(transport) = service.get("transport")
    {
        url.push_str("?transport=");
        url.push_str(transport);
    }
    Some(IceServer {
        urls: vec![url],
        username: service.get("username").unwrap_or_default().to_owned(),
        credential: service.get("password").unwrap_or_default().to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG_JS: &str = "var config = {\n    hosts: {\n        domain: 'meet.jitsi',\n        // focus: 'focus.meet.jitsi',\n        muc: 'muc.meet.jitsi'\n    },\n    bosh: 'https://meet.barrut.me/http-bind',\n    websocket: 'wss://meet.barrut.me/xmpp-websocket',\n};";

    #[test]
    fn external_services_become_ice_servers() {
        let s = Element::new("service", EXTDISCO)
            .attr("type", "turns")
            .attr("host", "turn.example")
            .attr("port", "443")
            .attr("transport", "tcp")
            .attr("username", "u")
            .attr("password", "p");
        let server = ice_server(&s).unwrap();
        assert_eq!(server.urls, vec!["turns:turn.example:443?transport=tcp"]);
        assert_eq!((server.username.as_str(), server.credential.as_str()), ("u", "p"));
    }

    fn state() -> State {
        let (events, _rx) = mpsc::unbounded_channel();
        State {
            config: Config::from_meeting("https://meet.barrut.me/r", CONFIG_JS, "Ana", None).unwrap(),
            jid: "x@meet.jitsi/y".into(),
            endpoint: "ep000001".into(),
            muted: false,
            offer: None,
            initiator: None,
            answer: None,
            pending: Vec::new(),
            candidates_sent: 0,
            members: BTreeMap::new(),
            events,
        }
    }

    #[test]
    fn disco_lists_audio_only_and_presence_names_the_source() {
        let mut s = state();
        let disco = Element::new("iq", CLIENT)
            .attr("type", "get")
            .attr("from", "focus@auth.meet.jitsi/focus")
            .attr("id", "d1")
            .child(Element::new("query", DISCO_INFO));
        let reply = s.stanza(disco).remove(0).write();
        assert!(reply.contains("urn:xmpp:jingle:apps:rtp:audio"));
        assert!(!reply.contains("rtp:video") && !reply.contains("dtls-sctp"));
        let presence = s.presence(None);
        assert_eq!(presence.get("to"), Some("r@muc.meet.jitsi/ep000001"));
        assert_eq!(presence.find("SourceInfo", CLIENT).unwrap().content(), r#"{"ep000001-a0":{"muted":false}}"#);
    }

    #[test]
    fn a_peer_offer_is_declined() {
        let mut s = state();
        let iq = Element::new("iq", CLIENT)
            .attr("type", "set")
            .attr("from", "r@muc.meet.jitsi/abcd1234")
            .attr("id", "p1")
            .child(Element::new("jingle", JINGLE).attr("action", "session-initiate").attr("sid", "s1"));
        let out = s.stanza(iq);
        assert_eq!(out.len(), 2);
        assert!(out[1].write().contains("session-terminate"));
    }

    #[test]
    fn a_transport_replace_from_the_focus_ends_the_session_to_be_joined_again() {
        let (events, mut rx) = mpsc::unbounded_channel();
        let mut s = State { events, ..state() };
        let iq = Element::new("iq", CLIENT)
            .attr("type", "set")
            .attr("from", "r@muc.meet.jitsi/focus")
            .attr("id", "t1")
            .child(Element::new("jingle", JINGLE).attr("action", "transport-replace").attr("sid", "s1"));
        let out = s.stanza(iq);
        assert_eq!(out.len(), 1, "only the iq result");
        assert!(matches!(rx.try_recv(), Ok(Event::Ended(reason)) if reason == "transport_replaced"));
    }
}
