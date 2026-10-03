//! Expiring observations. These frames never advance a durable sync cursor.
use crate::User;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PresenceStatus {
    Online,
    Away,
    Busy,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SetPresence {
    pub status: PresenceStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SetTyping {
    pub active: bool,
    pub membership_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PresenceEntry {
    pub user: User,
    pub status: PresenceStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Typist {
    pub user: User,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LiveRoom {
    pub room_id: String,
    pub membership_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_peer: Option<User>,
    pub typing: Vec<Typist>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LiveState {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<crate::profiles::ProfileStamp>,
    /// Receiver-relative lifetime; no client wall clock participates in leases.
    pub ttl_ms: u32,
    /// Above the bounded pilot capacity, forget observations rather than truncate them.
    pub limited: bool,
    pub presence: Vec<PresenceEntry>,
    pub rooms: Vec<LiveRoom>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum LiveFrame {
    Live(LiveState),
}
