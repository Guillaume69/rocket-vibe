//! Native RocketVibe v1 wire types. No UI, database, or Rocket.Chat dependencies.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub mod emojis;
pub mod parity;

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
    // Additive discovery fields. Missing means unavailable for older v1 servers.
    #[serde(default)]
    pub editing: bool,
    #[serde(default)]
    pub deletion: bool,
    #[serde(default)]
    pub pins: bool,
    #[serde(default)]
    pub stars: bool,
    #[serde(default)]
    pub favorites: bool,
    #[serde(default)]
    pub read_markers: bool,
    #[serde(default)]
    pub search: bool,
    #[serde(default)]
    pub profiles: bool,
    #[serde(default)]
    pub room_info: bool,
    #[serde(default)]
    pub room_discovery: bool,
    #[serde(default)]
    pub typing: bool,
    #[serde(default)]
    pub presence: bool,
    #[serde(default)]
    pub custom_emojis: bool,
    #[serde(default)]
    pub quotes: bool,
    #[serde(default)]
    pub snapshot_paging: bool,
    #[serde(default)]
    pub idempotent_room_creation: bool,
    #[serde(default)]
    pub fine_permissions: bool,
    #[serde(default)]
    pub session_rotation: bool,
    #[serde(default)]
    pub device_sessions: bool,
    #[serde(default)]
    pub account_invitations: bool,
    #[serde(default)]
    pub account_recovery: bool,
    #[serde(default)]
    pub second_factors: bool,
    #[serde(default)]
    pub reauthentication: bool,
    #[serde(default)]
    pub reauthentication_retirement: bool,
    #[serde(default)]
    pub email_verification: bool,
    #[serde(default)]
    pub email_removal: bool,
    #[serde(default)]
    pub email_factors: bool,
    #[serde(default)]
    pub email_factor_delivery: bool,
    #[serde(default)]
    pub email_recovery: bool,
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
            editing: false,
            deletion: false,
            pins: false,
            stars: false,
            favorites: false,
            read_markers: false,
            search: false,
            profiles: false,
            room_info: false,
            room_discovery: false,
            typing: false,
            presence: false,
            custom_emojis: false,
            quotes: false,
            snapshot_paging: false,
            idempotent_room_creation: false,
            fine_permissions: false,
            session_rotation: false,
            device_sessions: false,
            account_invitations: false,
            account_recovery: false,
            second_factors: false,
            reauthentication: false,
            reauthentication_retirement: false,
            email_verification: false,
            email_removal: false,
            email_factors: false,
            email_factor_delivery: false,
            email_recovery: false,
        }
    }
}

impl Capabilities {
    /// Feature names are stable across HTTP, mobile and desktop bindings.
    /// Both peers must support a feature before the UI can offer it.
    pub fn supported_features(&self, client: &Self) -> Vec<String> {
        let mut features = Vec::new();
        macro_rules! include {
            ($($name:ident),+ $(,)?) => { $(
                if self.$name && client.$name { features.push(stringify!($name).into()); }
            )+ };
        }
        include!(
            text_messages,
            private_rooms,
            direct_messages,
            durable_sync,
            threads,
            reactions,
            uploads,
            push,
            e2ee,
            calls,
            editing,
            deletion,
            pins,
            stars,
            favorites,
            read_markers,
            search,
            profiles,
            room_info,
            room_discovery,
            typing,
            presence,
            custom_emojis,
            quotes,
            session_rotation,
            device_sessions,
            account_invitations,
            account_recovery,
            second_factors,
            reauthentication,
            reauthentication_retirement,
            email_verification,
            email_removal,
            email_factors,
            email_factor_delivery,
            email_recovery
        );
        features
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
    /// Absent only for clients predating durable room creation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PublicRoom {
    pub room: Room,
    pub joined: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PublicRoomPage {
    pub rooms: Vec<PublicRoom>,
    pub next: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DirectMessage {
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct MessageReaction {
    pub emoji: String,
    pub users: Vec<User>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct PersonalStar {
    pub present: bool,
    /// Independent private revision: starring never changes the public message.
    pub revision: String,
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
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reactions: Vec<MessageReaction>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
    /// Present only in account-scoped reads or a journal event for its owner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personal_star: Option<Box<PersonalStar>>,
}

fn is_false(value: &bool) -> bool {
    !value
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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SnapshotPage {
    pub protocol_version: u32,
    pub snapshot_id: String,
    pub page_index: u32,
    pub rooms: Vec<Room>,
    pub messages: Vec<Message>,
    /// Opaque page token, authenticated and bound to the same account/generation.
    pub next: Option<String>,
    /// Only the last page publishes the fixed watermark's replay cursor.
    pub cursor: Option<String>,
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
    pub public_room_page: PublicRoomPage,
    pub direct_message: DirectMessage,
    pub send_message: SendMessage,
    pub message: Message,
    pub message_page: MessagePage,
    pub snapshot: Snapshot,
    pub snapshot_page: SnapshotPage,
    pub sync_batch: SyncBatch,
    pub socket_ticket: SocketTicket,
    pub error: ApiError,
    pub parity: parity::ParityContract,
}

pub fn schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(Contract)).expect("schema serializes")
}
