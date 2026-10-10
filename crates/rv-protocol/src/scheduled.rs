//! Scheduled messages: text the server sends for its author at a chosen time.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The earliest a message may be scheduled, in seconds from now.
pub const MIN_DELAY_SECONDS: i64 = 60;
/// The latest, in days from now.
pub const MAX_DAYS: i64 = 30;
/// Pending scheduled messages an account may hold at once.
pub const MAX_PENDING: i64 = 100;

/// `POST /api/v1/rooms/{id}/scheduled`. Replaying the same `operation_id`
/// returns the scheduled message it made; that id also becomes the sent
/// message's, so the send itself can never happen twice.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ScheduleMessage {
    pub operation_id: String,
    pub text: String,
    /// A thread reply, as `SendMessage.reply_to`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// RFC 3339, between `MIN_DELAY_SECONDS` and `MAX_DAYS` ahead.
    pub send_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledState {
    /// Waiting for `send_at`.
    Pending,
    /// The server could not send it (no longer a member, the room became
    /// read-only or encrypted, no live session left); `error` says why. It
    /// stays listed until its author removes it.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ScheduledMessage {
    pub id: String,
    pub room_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    pub send_at: String,
    pub state: ScheduledState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `GET /api/v1/scheduled`: the account's pending and failed scheduled
/// messages, every room, soonest first. A sent one leaves the list; the
/// message itself arrives like any other.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScheduledMessages {
    pub messages: Vec<ScheduledMessage>,
}
