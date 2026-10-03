//! Structured activity, projected into the existing clients' system rows.
use crate::{User, parity::RoomRole};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SystemMessage {
    CallStarted {
        meeting_id: String,
    },
    RoomCreated {
        name: String,
    },
    RoomRenamed {
        name: String,
    },
    TopicChanged {
        topic: String,
    },
    DescriptionChanged {
        description: String,
    },
    AnnouncementChanged {
        announcement: String,
    },
    PrivacyChanged {
        private: bool,
    },
    ReadOnlyChanged {
        read_only: bool,
    },
    MemberJoined {},
    MemberLeft {},
    MemberAdded {
        user: User,
    },
    MemberRemoved {
        user: User,
    },
    RoleChanged {
        user: User,
        previous_role: RoomRole,
        role: RoomRole,
    },
}

impl SystemMessage {
    /// Presentation identifiers are local adapter vocabulary, not wire events.
    pub fn presentation(&self) -> (&'static str, String) {
        let (kind, param) = match self {
            Self::CallStarted { .. } => ("videoconf", ""),
            Self::RoomCreated { name } => ("rv-room-created", name.as_str()),
            Self::RoomRenamed { name } => ("r", name.as_str()),
            Self::TopicChanged { topic } => ("room_changed_topic", topic.as_str()),
            Self::DescriptionChanged { description } => {
                ("room_changed_description", description.as_str())
            }
            Self::AnnouncementChanged { announcement } => {
                ("room_changed_announcement", announcement.as_str())
            }
            Self::PrivacyChanged { private } => (
                if *private {
                    "rv-room-private"
                } else {
                    "rv-room-public"
                },
                "",
            ),
            Self::ReadOnlyChanged { read_only } => (
                if *read_only {
                    "room-set-read-only"
                } else {
                    "room-removed-read-only"
                },
                "",
            ),
            Self::MemberJoined {} => ("uj", ""),
            Self::MemberLeft {} => ("ul", ""),
            Self::MemberAdded { user } => ("au", user.username.as_str()),
            Self::MemberRemoved { user } => ("ru", user.username.as_str()),
            Self::RoleChanged { user, role, .. } => (
                match role {
                    RoomRole::Owner => "rv-role-owner",
                    RoomRole::Moderator => "rv-role-moderator",
                    RoomRole::Member => "rv-role-member",
                },
                user.username.as_str(),
            ),
        };
        (kind, param.into())
    }
}
