//! The JSON lines spoken between the desktop apps and the `rv-voice` sidecar,
//! which alone links libwebrtc: one command per line on its stdin, one event per
//! line on its stdout. The sidecar speaks first, with [`Event::Hello`].
//!
//! Video frames never travel through these lines: the app listens on a loopback
//! TCP port it names with [`Command::Video`], and the sidecar streams there every
//! frame it shows (the room's cameras and screen, its own previews), in the
//! binary format of [`frames`]. A peer ignores nothing silently: an unknown
//! command answers `Error { code: "invalid_command" }`, so new commands need no
//! version bump.
use serde::{Deserialize, Serialize};

/// Bumped on any incompatible change; the app refuses another version.
/// 2: `Connect.e2ee_key`, which a version 1 sidecar would ignore and connect in clear.
pub const VERSION: u32 = 2;

fn is_false(value: &bool) -> bool {
    !*value
}

/// The participant attribute through which a client reports being deafened.
pub const DEAFENED_ATTRIBUTE: &str = "rv.deafened";

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Join a LiveKit room with a grant's signalling URL and token.
    Connect {
        url: String,
        token: String,
        /// An encrypted room's voice key (VOICE.md): its standard base64, whose
        /// ASCII bytes are LiveKit's shared key, index 0. Absent in clear.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        e2ee_key: Option<String>,
    },
    /// The room's group reached a new epoch: frames from now on use its key.
    SetKey {
        key: String,
    },
    SetMicrophone {
        enabled: bool,
    },
    SetDeafened {
        deafened: bool,
    },
    /// Answered by [`Event::Devices`].
    ListDevices,
    /// A device `id` from [`Event::Devices`]; empty for the system default.
    SetInput {
        device: String,
    },
    SetOutput {
        device: String,
    },
    /// Where to stream video frames ([`frames`]): a loopback `host:port` the app
    /// listens on, and the token the connection opens with. Sent before `Connect`.
    Video {
        address: String,
        token: String,
    },
    /// Publish the default camera, or stop. Off at every connection.
    SetCamera {
        enabled: bool,
    },
    /// Publish a screen or a window and, where the platform captures it
    /// (Windows, Linux), its sound: what the computer plays, without this
    /// call's voices unless `with_call`; a window's program only (Windows).
    /// `source` is an id from [`Event::Screens`]; none takes the portal's
    /// picker on Wayland, the first screen elsewhere. The app claims the
    /// room's one share from the server first.
    StartScreenShare {
        #[serde(default, skip_serializing_if = "is_false")]
        with_call: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        /// The default: 1080 lines at 15 frames a second.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        quality: Option<ScreenQuality>,
    },
    /// Answered by [`Event::Screens`], whose thumbnails then arrive on the
    /// frame stream (source screen, identity [`thumbnail`]`(id)`).
    ListScreens,
    /// How loud someone of the room plays here, 0.0 to 2.0 (1.0 as sent), and
    /// whether they are muted for this side only. Kept for the whole process.
    SetParticipantVolume {
        identity: String,
        volume: f32,
        #[serde(default, skip_serializing_if = "is_false")]
        muted: bool,
    },
    /// The microphone's gain, 0.0 to 2.0, after noise removal.
    SetInputVolume {
        volume: f32,
    },
    /// Everything the call plays, 0.0 to 2.0.
    SetOutputVolume {
        volume: f32,
    },
    /// The noise remover (RNNoise) on the microphone; on unless turned off.
    SetNoiseSuppression {
        enabled: bool,
    },
    StopScreenShare,
    /// Leave the room; the sidecar then exits.
    Disconnect,
}

// Manual: the token admits its bearer to the room's media, never print it.
impl std::fmt::Debug for Command {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect { url, e2ee_key, .. } => f
                .debug_struct("Connect")
                .field("url", url)
                .field("encrypted", &e2ee_key.is_some())
                .finish_non_exhaustive(),
            Self::SetKey { .. } => f.write_str("SetKey"),
            Self::SetMicrophone { enabled } => f.debug_struct("SetMicrophone").field("enabled", enabled).finish(),
            Self::SetDeafened { deafened } => f.debug_struct("SetDeafened").field("deafened", deafened).finish(),
            Self::ListDevices => f.write_str("ListDevices"),
            Self::SetInput { device } => f.debug_struct("SetInput").field("device", device).finish(),
            Self::SetOutput { device } => f.debug_struct("SetOutput").field("device", device).finish(),
            Self::Video { address, .. } => f.debug_struct("Video").field("address", address).finish_non_exhaustive(),
            Self::SetCamera { enabled } => f.debug_struct("SetCamera").field("enabled", enabled).finish(),
            Self::StartScreenShare { with_call, source, quality } => f
                .debug_struct("StartScreenShare")
                .field("with_call", with_call)
                .field("source", source)
                .field("quality", quality)
                .finish(),
            Self::ListScreens => f.write_str("ListScreens"),
            Self::SetParticipantVolume { identity, volume, muted } => f
                .debug_struct("SetParticipantVolume")
                .field("identity", identity)
                .field("volume", volume)
                .field("muted", muted)
                .finish(),
            Self::SetInputVolume { volume } => f.debug_struct("SetInputVolume").field("volume", volume).finish(),
            Self::SetOutputVolume { volume } => f.debug_struct("SetOutputVolume").field("volume", volume).finish(),
            Self::SetNoiseSuppression { enabled } => {
                f.debug_struct("SetNoiseSuppression").field("enabled", enabled).finish()
            }
            Self::StopScreenShare => f.write_str("StopScreenShare"),
            Self::Disconnect => f.write_str("Disconnect"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Connecting,
    Connected,
    Reconnecting,
    #[default]
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Participant {
    /// The LiveKit identity, which is the account id.
    pub identity: String,
    /// True for this sidecar's own participant.
    #[serde(default)]
    pub local: bool,
    /// Not publishing microphone audio (muted, or no microphone published).
    pub muted: bool,
    pub deafened: bool,
    pub speaking: bool,
    /// LiveKit's audio level, 0.0 to 1.0.
    pub level: f32,
    /// Publishing an unmuted camera.
    #[serde(default)]
    pub camera: bool,
    /// Sharing a screen.
    #[serde(default)]
    pub screen: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub default: bool,
}

/// A screen or a window that can be shared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenSource {
    /// Opaque, for [`Command::StartScreenShare`].
    pub id: String,
    pub kind: ScreenKind,
    /// The window's title; empty for a screen (the app numbers them).
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenKind {
    Screen,
    Window,
}

/// How a shared screen is sent: at most `height` lines (the width follows),
/// `fps` frames a second. The sidecar clamps both to what it supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenQuality {
    pub height: u32,
    pub fps: u32,
}

impl ScreenQuality {
    pub const DEFAULT: Self = Self { height: 1080, fps: 15 };
    /// Within 360 to 2160 lines and 5 to 60 frames a second.
    pub fn clamped(self) -> Self {
        Self { height: self.height.clamp(360, 2160), fps: self.fps.clamp(5, 60) }
    }
    /// The encoder's ceiling, in bits a second: about 0.08 bit per pixel and
    /// frame for a 16:9 screen, within 1.5 and 12 Mbit/s.
    pub fn bitrate(self) -> u64 {
        let q = self.clamped();
        let pixels = q.height as u64 * q.height as u64 * 16 / 9;
        (pixels * q.fps as u64 * 8 / 100).clamp(1_500_000, 12_000_000)
    }
}

/// The frame-stream identity of a share source's thumbnail.
pub fn thumbnail(id: &str) -> String {
    format!("thumbnail:{id}")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Hello {
        version: u32,
        sidecar: String,
    },
    State {
        state: ConnectionState,
    },
    /// The full list, local participant included, whenever anything in it changes.
    Participants {
        participants: Vec<Participant>,
    },
    Devices {
        inputs: Vec<Device>,
        outputs: Vec<Device>,
    },
    /// What can be shared; empty where the system picks (Wayland's portal).
    Screens {
        screens: Vec<ScreenSource>,
    },
    /// The microphone's level after processing, 0.0 to 1.0, about ten times
    /// a second while connected (the participants carry a coarser one).
    InputLevel {
        level: f32,
    },
    /// The session ended; `reason` is LiveKit's in snake case (`duplicate_identity`,
    /// `participant_removed`, `room_deleted`, `client_initiated`...), or `connect_failed`.
    Disconnected {
        reason: String,
    },
    /// A command failed; the session goes on unless a `Disconnected` follows.
    /// Video: `camera_unavailable`, `screen_unavailable`, `screen_cancelled`
    /// (the picker was closed), `screen_ended` (stopped from outside, or another
    /// participant's share replaced this one), `camera_ended`.
    Error {
        code: String,
    },
}

impl Event {
    pub fn line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// The video frames the sidecar streams to the app over loopback TCP.
///
/// The connection opens with [`MAGIC`], one length byte and the token of
/// [`Command::Video`]. Then each message is a little-endian `u32` length
/// followed by that many bytes: the source (0 camera, 1 screen), the identity's
/// length (one byte) and UTF-8 bytes, width and height (`u32`), then
/// `width * height * 4` bytes of RGBA, rows packed. Zero by zero means the track
/// ended. Frames are the latest only: the sidecar drops what the app does not
/// read in time.
pub mod frames {
    /// Opens the stream, before the token.
    pub const MAGIC: &[u8; 4] = b"RVV1";
    /// The largest message: a 1920 by 1080 frame and its header.
    pub const MAX_MESSAGE: u32 = 1920 * 1080 * 4 + 512;

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub enum Source {
        Camera,
        Screen,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Header {
        pub source: Source,
        /// The participant's identity (account id); the local one for previews.
        pub identity: String,
        pub width: u32,
        pub height: u32,
    }

    /// The bytes that open the stream.
    pub fn handshake(token: &str) -> Vec<u8> {
        let token = &token.as_bytes()[..token.len().min(255)];
        let mut out = MAGIC.to_vec();
        out.push(token.len() as u8);
        out.extend_from_slice(token);
        out
    }

    /// One message, length prefix included. `pixels` is RGBA, rows packed.
    pub fn message(header: &Header, pixels: &[u8]) -> Vec<u8> {
        let identity = &header.identity.as_bytes()[..header.identity.len().min(255)];
        let body = 2 + identity.len() + 8 + pixels.len();
        let mut out = Vec::with_capacity(4 + body);
        out.extend_from_slice(&(body as u32).to_le_bytes());
        out.push(match header.source {
            Source::Camera => 0,
            Source::Screen => 1,
        });
        out.push(identity.len() as u8);
        out.extend_from_slice(identity);
        out.extend_from_slice(&header.width.to_le_bytes());
        out.extend_from_slice(&header.height.to_le_bytes());
        out.extend_from_slice(pixels);
        out
    }

    /// A message's body (after its length): the header and the pixels, or None
    /// when malformed (the pixels must be exactly `width * height * 4` bytes).
    pub fn parse(body: &[u8]) -> Option<(Header, &[u8])> {
        let (&source, rest) = body.split_first()?;
        let source = match source {
            0 => Source::Camera,
            1 => Source::Screen,
            _ => return None,
        };
        let (&length, rest) = rest.split_first()?;
        let (identity, rest) = rest.split_at_checked(length as usize)?;
        let identity = std::str::from_utf8(identity).ok()?.to_owned();
        let (width, rest) = rest.split_at_checked(4)?;
        let (height, pixels) = rest.split_at_checked(4)?;
        let width = u32::from_le_bytes(width.try_into().ok()?);
        let height = u32::from_le_bytes(height.try_into().ok()?);
        if (width as usize).checked_mul(height as usize)?.checked_mul(4)? != pixels.len() {
            return None;
        }
        Some((Header { source, identity, width, height }, pixels))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn commands_round_trip_with_snake_case_tags() {
        let cases = [
            (
                Command::Connect { url: "wss://lk".into(), token: "t".into(), e2ee_key: None },
                json!({"type":"connect","url":"wss://lk","token":"t"}),
            ),
            (
                Command::Connect { url: "wss://lk".into(), token: "t".into(), e2ee_key: Some("a2V5".into()) },
                json!({"type":"connect","url":"wss://lk","token":"t","e2ee_key":"a2V5"}),
            ),
            (Command::SetKey { key: "a2V5".into() }, json!({"type":"set_key","key":"a2V5"})),
            (Command::SetMicrophone { enabled: false }, json!({"type":"set_microphone","enabled":false})),
            (Command::SetDeafened { deafened: true }, json!({"type":"set_deafened","deafened":true})),
            (Command::ListDevices, json!({"type":"list_devices"})),
            (Command::SetInput { device: "mic".into() }, json!({"type":"set_input","device":"mic"})),
            (Command::SetOutput { device: String::new() }, json!({"type":"set_output","device":""})),
            (Command::Disconnect, json!({"type":"disconnect"})),
            (
                Command::Video { address: "127.0.0.1:4242".into(), token: "t".into() },
                json!({"type":"video","address":"127.0.0.1:4242","token":"t"}),
            ),
            (Command::SetCamera { enabled: true }, json!({"type":"set_camera","enabled":true})),
            (
                Command::StartScreenShare { with_call: false, source: None, quality: None },
                json!({"type":"start_screen_share"}),
            ),
            (
                Command::StartScreenShare {
                    with_call: true,
                    source: Some("w:42".into()),
                    quality: Some(ScreenQuality { height: 720, fps: 30 }),
                },
                json!({"type":"start_screen_share","with_call":true,"source":"w:42","quality":{"height":720,"fps":30}}),
            ),
            (Command::ListScreens, json!({"type":"list_screens"})),
            (
                Command::SetParticipantVolume { identity: "u2".into(), volume: 0.5, muted: false },
                json!({"type":"set_participant_volume","identity":"u2","volume":0.5}),
            ),
            (
                Command::SetParticipantVolume { identity: "u2".into(), volume: 1.0, muted: true },
                json!({"type":"set_participant_volume","identity":"u2","volume":1.0,"muted":true}),
            ),
            (Command::SetInputVolume { volume: 1.5 }, json!({"type":"set_input_volume","volume":1.5})),
            (Command::SetOutputVolume { volume: 0.25 }, json!({"type":"set_output_volume","volume":0.25})),
            (Command::SetNoiseSuppression { enabled: false }, json!({"type":"set_noise_suppression","enabled":false})),
            (Command::StopScreenShare, json!({"type":"stop_screen_share"})),
        ];
        for (command, wire) in cases {
            assert_eq!(serde_json::to_value(&command).unwrap(), wire);
            assert_eq!(serde_json::from_value::<Command>(wire).unwrap(), command);
        }
        assert!(serde_json::from_str::<Command>(r#"{"type":"call"}"#).is_err());
        let connect = Command::Connect { url: "u".into(), token: "secret".into(), e2ee_key: Some("key".into()) };
        assert!(!format!("{connect:?}").contains("secret") && !format!("{connect:?}").contains("key\""));
        assert!(!format!("{:?}", Command::SetKey { key: "secret".into() }).contains("secret"));
        let video = Command::Video { address: "127.0.0.1:1".into(), token: "secret".into() };
        assert!(!format!("{video:?}").contains("secret"));
    }

    #[test]
    fn screen_quality_stays_within_bounds() {
        assert_eq!(ScreenQuality { height: 100, fps: 500 }.clamped(), ScreenQuality { height: 360, fps: 60 });
        assert_eq!(ScreenQuality { height: 720, fps: 15 }.bitrate(), 1_500_000);
        assert_eq!(ScreenQuality::DEFAULT.bitrate(), 2_488_320);
        assert_eq!(ScreenQuality { height: 1080, fps: 30 }.bitrate(), 4_976_640);
        assert_eq!(ScreenQuality { height: 1440, fps: 60 }.bitrate(), 12_000_000);
    }

    #[test]
    fn frames_round_trip_and_refuse_a_wrong_size() {
        let header = frames::Header { source: frames::Source::Screen, identity: "u1".into(), width: 2, height: 1 };
        let pixels = [1, 2, 3, 255, 4, 5, 6, 255];
        let message = frames::message(&header, &pixels);
        let length = u32::from_le_bytes(message[..4].try_into().unwrap()) as usize;
        assert_eq!(length, message.len() - 4);
        assert_eq!(frames::parse(&message[4..]), Some((header.clone(), &pixels[..])));
        let ended = frames::Header { width: 0, height: 0, ..header };
        assert_eq!(frames::parse(&frames::message(&ended, &[])[4..]), Some((ended, &[][..])));
        assert_eq!(frames::parse(&message[4..message.len() - 1]), None);
        assert_eq!(frames::parse(&[9, 0, 0, 0, 0, 0, 0, 0, 0, 0]), None);
        assert_eq!(frames::handshake("tok"), b"RVV1\x03tok".to_vec());
    }

    #[test]
    fn events_round_trip_with_snake_case_tags() {
        let participant = Participant {
            identity: "u1".into(),
            local: true,
            muted: false,
            deafened: true,
            speaking: true,
            level: 0.5,
            camera: false,
            screen: true,
        };
        let cases = [
            (
                Event::Hello { version: VERSION, sidecar: "0.9.0".into() },
                json!({"type":"hello","version":2,"sidecar":"0.9.0"}),
            ),
            (Event::State { state: ConnectionState::Reconnecting }, json!({"type":"state","state":"reconnecting"})),
            (
                Event::Participants { participants: vec![participant] },
                json!({"type":"participants","participants":[{"identity":"u1","local":true,"muted":false,"deafened":true,"speaking":true,"level":0.5,"camera":false,"screen":true}]}),
            ),
            (
                Event::Devices {
                    inputs: vec![Device { id: "a".into(), name: "Mic".into(), default: true }],
                    outputs: vec![],
                },
                json!({"type":"devices","inputs":[{"id":"a","name":"Mic","default":true}],"outputs":[]}),
            ),
            (
                Event::Disconnected { reason: "duplicate_identity".into() },
                json!({"type":"disconnected","reason":"duplicate_identity"}),
            ),
            (Event::Error { code: "device_not_found".into() }, json!({"type":"error","code":"device_not_found"})),
            (
                Event::Screens {
                    screens: vec![ScreenSource { id: "w:7".into(), kind: ScreenKind::Window, title: "Game".into() }],
                },
                json!({"type":"screens","screens":[{"id":"w:7","kind":"window","title":"Game"}]}),
            ),
            (Event::InputLevel { level: 0.25 }, json!({"type":"input_level","level":0.25})),
        ];
        for (event, wire) in cases {
            assert_eq!(serde_json::to_value(&event).unwrap(), wire);
            assert_eq!(serde_json::from_str::<Event>(&event.line()).unwrap(), event);
        }
        let older: Event = serde_json::from_value(
            json!({"type":"participants","participants":[{"identity":"u2","muted":true,"deafened":false,"speaking":false,"level":0.0}]}),
        )
        .unwrap();
        assert!(matches!(older, Event::Participants { participants }
            if !participants[0].local && !participants[0].camera && !participants[0].screen));
    }
}
