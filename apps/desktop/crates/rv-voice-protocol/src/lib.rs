//! The JSON lines spoken between the desktop apps and the `rv-voice` sidecar,
//! which alone links libwebrtc: one command per line on its stdin, one event per
//! line on its stdout. The sidecar speaks first, with [`Event::Hello`].
//!
//! Audio only for now. Video extends it additively: `SetCamera`,
//! `StartScreenShare`/`StopScreenShare` commands, the `camera`/`screen` flags
//! already on [`Participant`]; frames will travel through shared memory, never
//! through these lines. A peer ignores nothing silently: an unknown command
//! answers `Error { code: "invalid_command" }`, so new commands need no version bump.
use serde::{Deserialize, Serialize};

/// Bumped on any incompatible change; the app refuses another version.
/// 2: `Connect.e2ee_key`, which a version 1 sidecar would ignore and connect in clear.
pub const VERSION: u32 = 2;

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
    /// Publishing a camera track. Always false until video lands.
    #[serde(default)]
    pub camera: bool,
    /// Sharing a screen. Always false until video lands.
    #[serde(default)]
    pub screen: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub default: bool,
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
    /// The session ended; `reason` is LiveKit's in snake case (`duplicate_identity`,
    /// `participant_removed`, `room_deleted`, `client_initiated`...), or `connect_failed`.
    Disconnected {
        reason: String,
    },
    /// A command failed; the session goes on unless a `Disconnected` follows.
    Error {
        code: String,
    },
}

impl Event {
    pub fn line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
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
        ];
        for (command, wire) in cases {
            assert_eq!(serde_json::to_value(&command).unwrap(), wire);
            assert_eq!(serde_json::from_value::<Command>(wire).unwrap(), command);
        }
        assert!(serde_json::from_str::<Command>(r#"{"type":"call"}"#).is_err());
        let connect = Command::Connect { url: "u".into(), token: "secret".into(), e2ee_key: Some("key".into()) };
        assert!(!format!("{connect:?}").contains("secret") && !format!("{connect:?}").contains("key\""));
        assert!(!format!("{:?}", Command::SetKey { key: "secret".into() }).contains("secret"));
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
