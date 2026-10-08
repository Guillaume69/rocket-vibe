//! Bot accounts (RFC 0003): non-human accounts owned by a person, acting with
//! API keys inside the scopes their owner grants.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Every bot key starts with this prefix, then 64 lowercase hexadecimal digits.
pub const KEY_PREFIX: &str = "rvb_";
/// Live bots one account may own, administrators included.
pub const BOTS_PER_OWNER: i64 = 10;
/// Live keys of one bot: enough to rotate without downtime.
pub const KEYS_PER_BOT: i64 = 5;
/// Bytes of a description and of a key label.
pub const DESCRIPTION_BYTES: usize = 512;
pub const LABEL_BYTES: usize = 64;
/// Longest expiry a key may be given at creation.
pub const KEY_DAYS: u32 = 3650;

/// What a key may do. Routes outside every scope are never open to a key.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
pub enum BotScope {
    /// Rooms it belongs to: list, details, members, history, threads, files, sync and socket.
    #[serde(rename = "rooms:read")]
    RoomsRead,
    /// Send and reply; edit and delete its own messages; typing.
    #[serde(rename = "messages:write")]
    MessagesWrite,
    /// Upload files.
    #[serde(rename = "files:write")]
    FilesWrite,
    /// Add and remove reactions.
    #[serde(rename = "reactions:write")]
    ReactionsWrite,
    /// Browse public rooms, join one, leave a room.
    #[serde(rename = "rooms:join")]
    RoomsJoin,
    /// User directory, lookup and profiles.
    #[serde(rename = "users:read")]
    UsersRead,
    /// Open a direct conversation.
    #[serde(rename = "dm:write")]
    DmWrite,
}

impl BotScope {
    pub const ALL: [BotScope; 7] = [
        BotScope::RoomsRead,
        BotScope::MessagesWrite,
        BotScope::FilesWrite,
        BotScope::ReactionsWrite,
        BotScope::RoomsJoin,
        BotScope::UsersRead,
        BotScope::DmWrite,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            BotScope::RoomsRead => "rooms:read",
            BotScope::MessagesWrite => "messages:write",
            BotScope::FilesWrite => "files:write",
            BotScope::ReactionsWrite => "reactions:write",
            BotScope::RoomsJoin => "rooms:join",
            BotScope::UsersRead => "users:read",
            BotScope::DmWrite => "dm:write",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|scope| scope.as_str() == value)
    }
}

/// True for a well-formed bot key; says nothing of whether it is live.
pub fn is_key(token: &str) -> bool {
    token.strip_prefix(KEY_PREFIX).is_some_and(|rest| {
        rest.len() == 64
            && rest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// A bot as its owner and the administrators see it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct Bot {
    /// The bot's account: `user.bot` is always true.
    pub user: crate::User,
    pub owner: crate::User,
    pub description: String,
    pub scopes: Vec<BotScope>,
    pub created_at: String,
    /// Deactivated by an administrator, or with its owner.
    pub disabled: bool,
    /// Its photo (`/api/v1/avatars/{id}`), set by its owner or by itself.
    #[serde(default)]
    pub avatar_file_id: Option<String>,
    pub live_keys: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct BotList {
    pub bots: Vec<Bot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateBot {
    pub operation_id: String,
    pub username: String,
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub scopes: Vec<BotScope>,
}

/// Absent fields keep their value. The photo has its own route,
/// `PUT`/`DELETE /api/v1/bots/{id}/avatar`; the bot may also edit its own
/// profile with its key through `/me`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateBot {
    pub operation_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub scopes: Option<Vec<BotScope>>,
}

/// A key's public description; the key itself is shown once, at creation.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct BotKey {
    pub id: String,
    pub label: String,
    /// The key's last four characters, to recognise it.
    pub hint: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    /// At most a minute behind.
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct BotKeyList {
    pub keys: Vec<BotKey>,
}

/// Needs a recent sign-in of the person creating it. Replaying the operation
/// answers `bot_key_replayed`: the key is never shown twice.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateBotKey {
    pub operation_id: String,
    pub label: String,
    /// None: the key never expires.
    #[serde(default)]
    pub expires_in_days: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct BotKeyCreated {
    pub key: String,
    pub info: BotKey,
}

/// One route a key may call, as the server matches it (`{room}` is a parameter).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct BotRoute {
    pub method: String,
    pub path: String,
}

/// The routes one scope opens; `scope` absent: open to every key.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct BotScopeRoutes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<BotScope>,
    pub routes: Vec<BotRoute>,
}

/// What a key can reach, read from the table the server enforces, so the apps
/// show their people the same API the gate admits. Every other route is closed.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct BotReference {
    pub key_prefix: String,
    pub groups: Vec<BotScopeRoutes>,
    /// Sends (and replies) a minute per bot.
    pub sends_per_minute: u32,
    /// New direct conversations a minute per bot.
    pub direct_per_minute: u32,
}

/// Instance-wide settings, administrators only.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct InstanceSettings {
    /// Every account may create bots; administrators always may.
    pub user_bots: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateInstanceSettings {
    pub operation_id: String,
    #[serde(default)]
    pub user_bots: Option<bool>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct BotsContract {
    pub bot: Bot,
    pub bot_list: BotList,
    pub create_bot: CreateBot,
    pub update_bot: UpdateBot,
    pub bot_key: BotKey,
    pub bot_key_list: BotKeyList,
    pub create_bot_key: CreateBotKey,
    pub bot_key_created: BotKeyCreated,
    pub bot_reference: BotReference,
    pub instance_settings: InstanceSettings,
    pub update_instance_settings: UpdateInstanceSettings,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_round_trip_by_name() {
        for scope in BotScope::ALL {
            let json = serde_json::to_string(&scope).unwrap();
            assert_eq!(json, format!("\"{}\"", scope.as_str()));
            assert_eq!(serde_json::from_str::<BotScope>(&json).unwrap(), scope);
            assert_eq!(BotScope::parse(scope.as_str()), Some(scope));
        }
        assert_eq!(BotScope::parse("admin"), None);
    }

    #[test]
    fn keys_need_the_prefix_and_64_lowercase_hex() {
        let hex = "0123456789abcdef".repeat(4);
        assert!(is_key(&format!("rvb_{hex}")));
        assert!(!is_key(&hex));
        assert!(!is_key(&format!("rvb_{}", hex.to_uppercase())));
        assert!(!is_key(&format!("rvb_{}", &hex[1..])));
        assert!(!is_key(&format!("rvx_{hex}")));
    }
}
