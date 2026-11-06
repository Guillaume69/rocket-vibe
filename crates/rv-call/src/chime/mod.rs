//! Amazon Chime SDK meetings (Slack's huddles): the signalling WebSocket of
//! `MediaPlacement.SignalingUrl`, binary protobuf frames, the client offering.
//! The sequence follows a captured huddle (brain/architecture/native-calls.md):
//! JOIN, JOIN_ACK with the TURN servers, SUBSCRIBE with the offer, SUBSCRIBE_ACK
//! with the answer, then who is in the call (AUDIO_STREAM_ID_INFO) and how loud
//! (AUDIO_METADATA). The server mixes everyone into one audio stream.

#[cfg(feature = "client")]
pub mod client;
pub mod proto;

use std::collections::BTreeMap;

use proto::{Message, Writer, frame, kind};

use crate::{IceServer, Member};

/// The SDK this client presents itself as: the protocol it speaks is that one's.
const SDK_VERSION: &str = "3.32.0";

/// A meeting's attendee credentials, as the provider hands them (Slack's
/// `rooms.join` `call.free_willy`).
#[derive(Clone, PartialEq, Eq)]
pub struct Config {
    /// `MediaPlacement.SignalingUrl`: `wss://signal.<cell>.m.chime.aws/control/<meeting>`.
    pub signaling_url: String,
    /// `MediaPlacement.AudioHostUrl` (`host:3478`).
    pub audio_host: String,
    pub attendee_id: String,
    pub join_token: String,
    /// The page origin the provider's web client connects from.
    pub origin: String,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("signaling_url", &self.signaling_url)
            .field("attendee_id", &self.attendee_id)
            .finish_non_exhaustive()
    }
}

impl Config {
    /// The signalling socket's URL, with the query the SDK adds; `None` unless
    /// it is a `wss` URL on Chime's own domain.
    pub fn socket_url(&self) -> Option<String> {
        let rest = self.signaling_url.strip_prefix("wss://")?;
        let host = rest.split(['/', '?', '#']).next()?;
        if host.contains('@') || !(host.ends_with(".chime.aws") || host == "chime.aws") {
            return None;
        }
        let base = self.signaling_url.split(['?', '#']).next()?;
        Some(format!(
            "{base}?X-Chime-Control-Protocol-Version=3&X-Amzn-Chime-Send-Close-On-Error=1&X-Amzn-Version={SDK_VERSION}&X-Amzn-User-Agent=rocket-vibe"
        ))
    }
}

pub(crate) fn join(timestamp: u64, audio_session_id: u32) -> Vec<u8> {
    let details = Writer::default()
        .string(5, "rocket-vibe")
        .string(6, env!("CARGO_PKG_VERSION"))
        .string(7, "amazon-chime-sdk-js")
        .string(8, SDK_VERSION)
        .string(10, std::env::consts::OS)
        .string(11, std::env::consts::ARCH);
    let body = Writer::default()
        .uint(1, 2)
        // HAS_STREAM_UPDATE
        .uint(3, 2)
        .message(4, details)
        .uint(6, u64::from(audio_session_id))
        .bool(7, true)
        // BANDWIDTH_PROBING_AND_VIDEO_QUALITY_ADAPTION, and the three supported
        .uint(10, 4)
        .uint(11, 2)
        .uint(11, 3)
        .uint(11, 4);
    proto::signal(timestamp, kind::JOIN, frame::JOIN, body)
}

/// The SUBSCRIBE carrying the offer: the microphone as the one stream sent.
pub(crate) fn subscribe(timestamp: u64, config: &Config, compressed_offer: &[u8], muted: bool) -> Vec<u8> {
    let stream = Writer::default()
        .uint(1, 1)
        .uint(2, 15)
        .uint(3, 600)
        .string(4, "AmazonChimeExpressAudio")
        .uint(6, 1)
        .uint(7, 400_000)
        .string(8, &config.attendee_id)
        // AUDIO
        .uint(9, 1);
    let body = Writer::default()
        // RX: no video sent
        .uint(1, 1)
        .message(2, stream)
        .uint(3, 0)
        .string(4, "")
        .string(5, &config.audio_host)
        .bool(6, false)
        .bool(7, muted)
        .bytes(8, compressed_offer);
    proto::signal(timestamp, kind::SUBSCRIBE, frame::SUBSCRIBE, body)
}

pub(crate) fn audio_control(timestamp: u64, muted: bool) -> Vec<u8> {
    proto::signal(timestamp, kind::AUDIO_CONTROL, frame::AUDIO_CONTROL, Writer::default().bool(1, muted))
}

pub(crate) fn leave(timestamp: u64) -> Vec<u8> {
    proto::signal(timestamp, kind::LEAVE, frame::LEAVE, Writer::default())
}

/// A PING (`kind` 1) or PONG (2).
pub(crate) fn ping_pong(timestamp: u64, pong: bool, id: u64) -> Vec<u8> {
    let body = Writer::default().uint(1, if pong { 2 } else { 1 }).uint(2, id);
    proto::signal(timestamp, kind::PING_PONG, frame::PING_PONG, body)
}

/// JOIN_ACK's TURN servers, as one server with its URIs.
pub(crate) fn turn_servers(ack: &Message) -> Vec<IceServer> {
    let Some(turn) = ack.message(1) else { return Vec::new() };
    let urls = turn.strings(4);
    if urls.is_empty() {
        return Vec::new();
    }
    vec![IceServer {
        urls,
        username: turn.string(1).unwrap_or_default(),
        credential: turn.string(2).unwrap_or_default(),
    }]
}

/// Who is in the call, by the audio stream the server gives each attendee.
#[derive(Debug, Default)]
pub(crate) struct Roster {
    me: String,
    /// Stream id to the person on it (external user id) and whether muted.
    streams: BTreeMap<u64, (String, bool)>,
}

impl Roster {
    pub(crate) fn new(attendee_id: &str) -> Self {
        Roster { me: attendee_id.to_owned(), streams: BTreeMap::new() }
    }

    /// Applies an AUDIO_STREAM_ID_INFO: a stream with an attendee joins (or
    /// leaves when dropped), one with only `muted` changes it, one with neither
    /// leaves. Answers whether anything changed.
    pub(crate) fn stream_info(&mut self, info: &Message) -> bool {
        let mut changed = false;
        for stream in info.messages(1) {
            let Some(id) = stream.int(1) else { continue };
            let attendee = stream.string(2);
            let muted = stream.int(3).map(|m| m != 0);
            if attendee.as_deref() == Some(self.me.as_str()) {
                continue;
            }
            if stream.int(5).is_some_and(|d| d != 0) {
                changed |= self.streams.remove(&id).is_some();
            } else if let Some(attendee) = attendee {
                let person = stream.string(4).filter(|e| !e.is_empty()).unwrap_or(attendee);
                let entry = (person, muted.unwrap_or(false));
                changed |= self.streams.insert(id, entry.clone()) != Some(entry);
            } else if let Some(muted) = muted {
                if let Some(entry) = self.streams.get_mut(&id) {
                    changed |= entry.1 != muted;
                    entry.1 = muted;
                }
            } else {
                changed |= self.streams.remove(&id).is_some();
            }
        }
        changed
    }

    /// Applies an AUDIO_METADATA: each stream's loudness, 0 for those it leaves
    /// out (as the SDK does), and the mute changes it carries.
    pub(crate) fn metadata(&mut self, meta: &Message) -> (Vec<(String, f32)>, bool) {
        let mut loud: BTreeMap<u64, f32> = BTreeMap::new();
        let mut changed = false;
        for state in meta.messages(1) {
            let Some(id) = state.int(1) else { continue };
            if let Some(volume) = state.int(2) {
                loud.insert(id, level(volume));
            }
            if let (Some(muted), Some(entry)) = (state.int(3), self.streams.get_mut(&id)) {
                changed |= entry.1 != (muted != 0);
                entry.1 = muted != 0;
            }
        }
        let levels =
            self.streams.iter().map(|(id, (person, _))| (person.clone(), *loud.get(id).unwrap_or(&0.0))).collect();
        (levels, changed)
    }

    pub(crate) fn members(&self) -> Vec<Member> {
        let mut seen = std::collections::BTreeSet::new();
        self.streams
            .values()
            .filter(|(person, _)| seen.insert(person.clone()))
            .map(|(person, muted)| Member { id: person.clone(), name: String::new(), muted: *muted })
            .collect()
    }
}

/// What an AUDIO_STATUS means for the session (`MeetingSessionStatus` of the SDK).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Status {
    Fine,
    /// Worth joining again.
    Lost(String),
    /// Joining again would be refused, or would take the call from elsewhere.
    Over(&'static str),
}

pub(crate) fn audio_status(status: u64) -> Status {
    match status {
        0 | 200 => Status::Fine,
        301 => Status::Over("duplicate_identity"),
        403 => Status::Over("refused"),
        409 => Status::Over("at_capacity"),
        410 => Status::Over("meeting_ended"),
        411 => Status::Over("removed"),
        other => Status::Lost(format!("audio_status_{other}")),
    }
}

/// An attendee's volume as the server sends it (minus decibels) between 0 and
/// 1, over the SDK's own range of -42 to -14 dB.
fn level(volume: u64) -> f32 {
    let db = -(volume.min(127) as f32);
    ((db + 42.0) / 28.0).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config {
            signaling_url: "wss://signal.z2.ew3.m.chime.aws/control/b7f5".into(),
            audio_host: "f35d.k.m2.ew3.app.chime.aws:3478".into(),
            attendee_id: "me-attendee".into(),
            join_token: "token".into(),
            origin: "https://app.slack.com".into(),
        }
    }

    #[test]
    fn the_socket_url_carries_the_protocol_version_and_stays_on_chime() {
        let url = config().socket_url().unwrap();
        assert!(url.starts_with("wss://signal.z2.ew3.m.chime.aws/control/b7f5?X-Chime-Control-Protocol-Version=3&"));
        for bad in [
            "https://signal.z2.ew3.m.chime.aws/control/x",
            "wss://evil.example/control/x",
            "wss://chime.aws@evil.example/x",
            "wss://signal.chime.aws.evil.example/x",
        ] {
            assert_eq!(Config { signaling_url: bad.into(), ..config() }.socket_url(), None, "{bad}");
        }
    }

    #[test]
    fn the_join_matches_the_captured_one() {
        let b = join(7, 42);
        let (kind, m) = proto::received(&b).unwrap();
        assert_eq!(b[0], proto::CLIENT_FRAME);
        assert_eq!(kind, kind::JOIN);
        let join = m.message(frame::JOIN).unwrap();
        assert_eq!((join.int(1), join.int(3), join.int(6), join.int(7)), (Some(2), Some(2), Some(42), Some(1)));
        assert_eq!(join.message(4).unwrap().string(7).as_deref(), Some("amazon-chime-sdk-js"));
    }

    #[test]
    fn the_subscribe_sends_the_microphone_and_the_offer() {
        let b = subscribe(7, &config(), b"deflated", true);
        let (kind, m) = proto::received(&b).unwrap();
        assert_eq!(kind, kind::SUBSCRIBE);
        let sub = m.message(frame::SUBSCRIBE).unwrap();
        assert_eq!(sub.int(1), Some(1));
        assert_eq!(sub.string(5).as_deref(), Some("f35d.k.m2.ew3.app.chime.aws:3478"));
        assert_eq!(sub.int(7), Some(1));
        assert_eq!(sub.bytes(8), Some(&b"deflated"[..]));
        let stream = sub.message(2).unwrap();
        assert_eq!(stream.string(4).as_deref(), Some("AmazonChimeExpressAudio"));
        assert_eq!(stream.string(8).as_deref(), Some("me-attendee"));
        assert_eq!(stream.int(9), Some(1));
    }

    #[test]
    fn audio_statuses_tell_what_ends_the_call() {
        assert_eq!(audio_status(200), Status::Fine);
        assert_eq!(audio_status(410), Status::Over("meeting_ended"));
        assert_eq!(audio_status(301), Status::Over("duplicate_identity"));
        assert_eq!(audio_status(503), Status::Lost("audio_status_503".into()));
    }

    #[test]
    fn the_join_ack_gives_the_turn_servers() {
        let turn = Writer::default()
            .string(1, "user")
            .string(2, "secret")
            .uint(3, 300)
            .string(4, "turn:ice.example.chime.aws:3478?transport=udp")
            .string(4, "turns:ice.example.chime.aws:443?transport=tcp");
        let ack = Writer::default().message(1, turn).uint(2, 25).finish();
        let servers = turn_servers(&Message::parse(&ack).unwrap());
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].urls.len(), 2);
        assert_eq!((servers[0].username.as_str(), servers[0].credential.as_str()), ("user", "secret"));
        assert!(turn_servers(&Message::parse(&[]).unwrap()).is_empty());
    }

    fn info(streams: Vec<Writer>) -> Vec<u8> {
        streams.into_iter().fold(Writer::default(), |w, s| w.message(1, s)).finish()
    }

    #[test]
    fn the_roster_follows_stream_infos_without_this_client() {
        let mut roster = Roster::new("me-attendee");
        let joined = info(vec![
            Writer::default().uint(1, 1).string(2, "me-attendee").uint(3, 0).string(4, "T-R-UME"),
            Writer::default().uint(1, 2).string(2, "other").uint(3, 0).string(4, "T-R-UOTHER"),
        ]);
        assert!(roster.stream_info(&Message::parse(&joined).unwrap()));
        assert_eq!(roster.members(), vec![Member { id: "T-R-UOTHER".into(), name: String::new(), muted: false }]);

        let muted = info(vec![Writer::default().uint(1, 2).uint(3, 1)]);
        assert!(roster.stream_info(&Message::parse(&muted).unwrap()));
        assert!(roster.members()[0].muted);
        assert!(!roster.stream_info(&Message::parse(&muted).unwrap()));

        let left = info(vec![Writer::default().uint(1, 2)]);
        assert!(roster.stream_info(&Message::parse(&left).unwrap()));
        assert!(roster.members().is_empty());

        let back = info(vec![Writer::default().uint(1, 3).string(2, "other").string(4, "T-R-UOTHER")]);
        roster.stream_info(&Message::parse(&back).unwrap());
        let dropped = info(vec![Writer::default().uint(1, 3).string(2, "other").uint(5, 1)]);
        assert!(roster.stream_info(&Message::parse(&dropped).unwrap()));
        assert!(roster.members().is_empty());
    }

    #[test]
    fn metadata_gives_levels_and_silence_for_the_streams_it_leaves_out() {
        let mut roster = Roster::new("me");
        let joined = info(vec![
            Writer::default().uint(1, 2).string(2, "a").string(4, "A"),
            Writer::default().uint(1, 3).string(2, "b").string(4, "B"),
        ]);
        roster.stream_info(&Message::parse(&joined).unwrap());
        let meta = Writer::default().message(1, Writer::default().uint(1, 2).uint(2, 14)).finish();
        let (levels, changed) = roster.metadata(&Message::parse(&meta).unwrap());
        assert!(!changed);
        assert_eq!(levels, vec![("A".to_owned(), 1.0), ("B".to_owned(), 0.0)]);
        assert_eq!(level(42), 0.0);
        assert_eq!(level(127), 0.0);
        assert!((level(28) - 0.5).abs() < 1e-6);
    }
}
