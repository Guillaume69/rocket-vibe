//! Voice sessions over the operator's LiveKit SFU. Media never crosses this
//! server: it mints a short join token per request and observes who is connected.
use crate::User;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct JoinVoice {
    pub membership_version: String,
    pub data_epoch: String,
    /// Direct rooms only: ring the other member. Ignored when a call already rings.
    #[serde(default, skip_serializing_if = "crate::is_false")]
    pub ring: bool,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AnswerRing {
    pub membership_version: String,
    pub data_epoch: String,
}

// No Debug: the token admits its bearer to the room's media.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct VoiceGrant {
    pub room_id: String,
    /// LiveKit signalling origin (`wss://` in production).
    pub url: String,
    pub token: String,
    pub expires_at: String,
    /// False in a read-only room for a plain member: listening only.
    pub can_publish: bool,
    /// The ring this join started or answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ring: Option<VoiceRing>,
}

/// One account connected to a room's voice session, as the SFU last reported it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct VoiceParticipant {
    pub user: User,
    pub muted: bool,
    pub deafened: bool,
    /// Publishing an unmuted camera.
    #[serde(default, skip_serializing_if = "crate::is_false")]
    pub camera: bool,
    /// Holds the room's screen share (one per room, `POST /api/v1/voice/screen`).
    #[serde(default, skip_serializing_if = "crate::is_false")]
    pub screen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RingState {
    Ringing,
    Answered,
    Declined,
    /// Nobody answered before the ring expired.
    Missed,
    /// The caller left before an answer.
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct VoiceRing {
    pub id: String,
    pub room_id: String,
    pub caller: User,
    pub callee: User,
    pub state: RingState,
    /// Receiver-relative time left while ringing; zero once resolved.
    pub expires_in_ms: u32,
}

/// The outcome carried by a direct call's `call_started` row.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct CallSummary {
    pub state: RingState,
    /// Answered calls, once both sides left.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u32>,
}
