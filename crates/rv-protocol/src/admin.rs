//! In-app administration and member reports. Administration grants no access to
//! private conversations: a message's text reaches an admin only through an open
//! report, which its reporter disclosed.
use crate::{RoomKind, User, live::PresenceStatus};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct AdminUserCounts {
    /// Accounts, deleted ones excluded.
    pub total: u64,
    pub active: u64,
    pub deactivated: u64,
    /// Active administrators.
    pub admins: u64,
    pub online: u64,
    pub away: u64,
    pub busy: u64,
    pub offline: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct AdminRoomCounts {
    pub total: u64,
    pub public: u64,
    pub private: u64,
    pub direct: u64,
    /// Rooms with an MLS group, also counted under their kind.
    pub encrypted: u64,
}

/// Messages people wrote: system activity and tombstones are not counted.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct AdminMessageCounts {
    pub total: u64,
    pub public: u64,
    pub private: u64,
    pub direct: u64,
    /// Opaque private messages, outside the three plaintext kinds.
    pub encrypted: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct AdminUploadCounts {
    pub count: u64,
    pub bytes: u64,
}

/// Open reports only.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct AdminReportCounts {
    /// Reported messages, not reports.
    pub messages: u64,
    /// Reported accounts, not reports.
    pub users: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct AdminOverview {
    pub server_version: String,
    pub postgres_version: String,
    pub migration_version: Option<String>,
    pub instance_id: String,
    pub data_epoch: String,
    /// Start of this server process; the uptime is the distance to now.
    pub started_at: String,
    pub users: AdminUserCounts,
    pub rooms: AdminRoomCounts,
    pub messages: AdminMessageCounts,
    pub uploads: AdminUploadCounts,
    pub reports: AdminReportCounts,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct AdminUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    /// The profile avatar (`/api/v1/avatars/{id}`); absent for a disabled account,
    /// whose avatar is no longer served.
    pub avatar_file_id: Option<String>,
    pub admin: bool,
    pub disabled: bool,
    pub status: PresenceStatus,
    pub created_at: Option<String>,
    /// Latest activity of any of its devices, at a five-minute granularity.
    pub last_seen_at: Option<String>,
    /// Account authority version, expected back by every change.
    pub revision: String,
    /// A bot account (RFC 0003); absent from older servers.
    #[serde(default)]
    pub bot: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct AdminUserPage {
    pub items: Vec<AdminUser>,
    /// Opaque cursor carrying the last sort key, stable across renames.
    pub next: Option<String>,
}

/// Absent fields are kept. My own admin right and activation cannot be changed.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateAdminUser {
    pub operation_id: String,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admin: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
}

/// Tombstones the account; its messages stay, attributed to a deleted user.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteAdminUser {
    pub operation_id: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct AdminRoom {
    pub id: String,
    pub kind: RoomKind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    pub member_count: u64,
    pub message_count: u64,
    pub last_message_at: Option<String>,
    pub created_at: Option<String>,
    pub read_only: bool,
    pub encrypted: bool,
    /// The pair of a direct conversation, deleted accounts included; empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub direct_members: Vec<User>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct AdminRoomPage {
    pub items: Vec<AdminRoom>,
    pub next: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct AdminReport {
    pub reporter: User,
    pub reason: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct AdminReportedMessage {
    pub message_id: String,
    pub room_id: String,
    pub room_kind: RoomKind,
    pub room_name: String,
    pub author: User,
    /// The author's account revision, to deactivate it directly; absent for a
    /// deleted author.
    pub author_revision: Option<String>,
    /// The text as the newest report saw it, even after an edit or a deletion.
    pub text: String,
    pub created_at: String,
    pub deleted: bool,
    pub report_count: u64,
    pub latest_report_at: String,
    /// Newest first, at most 20.
    pub reports: Vec<AdminReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct AdminReportedMessagePage {
    pub items: Vec<AdminReportedMessage>,
    pub next: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct AdminReportedUser {
    pub user: AdminUser,
    pub report_count: u64,
    pub latest_report_at: String,
    /// Newest first, at most 20.
    pub reports: Vec<AdminReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct AdminReportedUserPage {
    pub items: Vec<AdminReportedUser>,
    pub next: Option<String>,
}

/// Dismissing reports or deleting a reported message.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AdminOperation {
    pub operation_id: String,
}

/// A member's report of a message or an account. Reporting the same target
/// again keeps one open report and replaces its reason.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReportInput {
    pub operation_id: String,
    /// Trimmed, 1 to 1,000 characters.
    pub reason: String,
}

/// Export root of the administration fixture.
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct AdminContract {
    pub overview: AdminOverview,
    pub user_page: AdminUserPage,
    pub update_user: UpdateAdminUser,
    pub delete_user: DeleteAdminUser,
    pub room_page: AdminRoomPage,
    pub reported_messages: AdminReportedMessagePage,
    pub reported_users: AdminReportedUserPage,
    pub operation: AdminOperation,
    pub report: ReportInput,
    pub create_emoji: crate::custom_emojis::CreateEmoji,
    pub remove_emoji: crate::custom_emojis::RemoveEmoji,
}
