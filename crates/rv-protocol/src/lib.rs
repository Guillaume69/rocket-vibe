//! Native RocketVibe v1 wire types. No UI, database, or Rocket.Chat dependencies.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct Capabilities {
    pub text_messages: bool,
    pub private_rooms: bool,
    pub direct_messages: bool,
    pub durable_sync: bool,
    pub threads: bool,
    pub reactions: bool,
    pub uploads: bool,
    pub push: bool,
    pub e2ee: bool,
    pub calls: bool,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            text_messages: true,
            private_rooms: true,
            direct_messages: true,
            durable_sync: true,
            threads: false,
            reactions: false,
            uploads: false,
            push: false,
            e2ee: false,
            calls: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Discovery {
    pub product: String,
    pub instance_id: String,
    pub data_epoch: String,
    pub server_version: String,
    pub protocol_versions: Vec<u32>,
    pub api_path: String,
    pub capabilities: Capabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Login {
    pub username: String,
    pub password: String,
}

// Deliberately no Debug: a session's bearer token must not enter logs accidentally.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct Session {
    pub token: String,
    pub expires_at: String,
    pub user: User,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RoomKind {
    Public,
    Private,
    Direct,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct Room {
    pub id: String,
    pub name: String,
    pub kind: RoomKind,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateRoom {
    pub name: String,
    pub private: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DirectMessage {
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct Message {
    pub id: String,
    pub room_id: String,
    pub author: User,
    pub text: String,
    pub created_at: String,
    pub position: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SendMessage {
    pub operation_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MessagePage {
    /// Newest first. The next page uses the last message's position as `before`.
    pub messages: Vec<Message>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum Change {
    RoomUpsert(Room),
    MessageUpsert(Message),
    RoomRemoved { room_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SyncBatch {
    pub protocol_version: u32,
    pub changes: Vec<Change>,
    /// Opaque and bound to the authenticated account and data generation.
    pub cursor: String,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Snapshot {
    pub protocol_version: u32,
    pub rooms: Vec<Room>,
    pub messages: Vec<Message>,
    pub cursor: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct SocketTicket {
    pub ticket: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApiError {
    pub code: String,
    pub request_id: String,
}

/// Single schema root, also used by the TypeScript binding generator.
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct Contract {
    pub discovery: Discovery,
    pub login: Login,
    pub session: Session,
    pub room: Room,
    pub create_room: CreateRoom,
    pub direct_message: DirectMessage,
    pub send_message: SendMessage,
    pub message: Message,
    pub message_page: MessagePage,
    pub snapshot: Snapshot,
    pub sync_batch: SyncBatch,
    pub socket_ticket: SocketTicket,
    pub error: ApiError,
}

pub fn schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(Contract)).expect("schema serializes")
}
