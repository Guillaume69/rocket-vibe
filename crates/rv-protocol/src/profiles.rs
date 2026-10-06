//! Public profiles and private account preferences, independently versioned.
use crate::parity::{UserPreferences, UserProfile};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OwnProfile {
    pub profile: UserProfile,
    pub preferences: UserPreferences,
    /// Verified contact, visible only to its owner. Changes use the email proof flow.
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateProfile {
    pub operation_id: String,
    pub expected_revision: String,
    pub username: String,
    pub display_name: String,
    pub bio: String,
    pub status: crate::live::PresenceStatus,
    pub status_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdatePreferences {
    pub operation_id: String,
    pub expected_revision: String,
    pub language: String,
    pub clock_24h: bool,
    pub push_enabled: bool,
    pub push_mentions_only: bool,
    pub desktop_notifications: DesktopNotifications,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DesktopNotifications {
    #[default]
    Default,
    All,
    Mention,
    Nothing,
}

/// Query accompanying the raw PNG/JPEG body, or DELETE. No user-supplied file path.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AvatarCommand {
    pub operation_id: String,
    pub expected_revision: String,
}

/// Replays return the original revision; clients refetch the current profile.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProfileReceipt {
    pub operation_id: String,
    pub applied_revision: String,
}

/// Bounded live invalidation; this never changes the durable room cursor.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProfileStamp {
    pub user: crate::User,
    pub revision: String,
    pub avatar_file_id: Option<String>,
    pub status_text: String,
}
