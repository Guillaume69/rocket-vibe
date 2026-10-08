//! Room details, people's profiles and message search: read on demand, never stored.

use serde_json::Value;

use crate::live::Presence;
use crate::normalize::{Message, to_message};

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

#[derive(Debug, Clone, PartialEq)]
pub struct RoomInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub topic: Option<String>,
    pub announcement: Option<String>,
    pub description: Option<String>,
    pub members: Option<i64>,
    pub read_only: bool,
    pub encrypted: bool,
    pub archived: bool,
    pub default: bool,
}

/// Native metadata projected into the existing room information view.
pub fn native_room_info(details: rv_protocol::parity::RoomDetails) -> RoomInfo {
    let text = |value: String| (!value.trim().is_empty()).then_some(value);
    RoomInfo {
        id: details.room.id,
        name: details.room.name,
        kind: match details.room.kind {
            rv_protocol::RoomKind::Public => "c",
            rv_protocol::RoomKind::Private => "p",
            rv_protocol::RoomKind::Direct => "d",
        }
        .into(),
        topic: text(details.topic),
        announcement: text(details.announcement),
        description: text(details.description),
        members: Some(i64::from(details.member_count)),
        read_only: details.read_only,
        encrypted: false,
        archived: false,
        default: false,
    }
}

/// `rooms.info`'s `room`.
pub fn room_info(room: &Value) -> Option<RoomInfo> {
    Some(RoomInfo {
        id: text(room, "_id")?,
        name: text(room, "fname").or_else(|| text(room, "name")).unwrap_or_default(),
        kind: text(room, "t").unwrap_or_else(|| "c".to_owned()),
        topic: text(room, "topic"),
        announcement: text(room, "announcement"),
        description: text(room, "description"),
        members: room.get("usersCount").and_then(Value::as_i64),
        read_only: room.get("ro").and_then(Value::as_bool).unwrap_or(false),
        encrypted: room.get("encrypted").and_then(Value::as_bool).unwrap_or(false),
        archived: room.get("archived").and_then(Value::as_bool).unwrap_or(false),
        default: room.get("default").and_then(Value::as_bool).unwrap_or(false),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub id: String,
    pub username: String,
    pub name: Option<String>,
    pub presence: Option<Presence>,
    pub status_text: Option<String>,
    pub roles: Vec<String>,
    /// Hours from UTC, as the server reports it (may be fractional).
    pub utc_offset: Option<f64>,
    pub bio: Option<String>,
    pub avatar_etag: Option<String>,
    /// A RocketVibe bot account (RFC 0003); false on Rocket.Chat.
    pub bot: bool,
    /// The username of the person who owns this bot.
    pub bot_owner: Option<String>,
}

/// `users.info`'s `user`.
pub fn profile(user: &Value) -> Option<Profile> {
    Some(Profile {
        id: text(user, "_id")?,
        username: text(user, "username")?,
        name: text(user, "name"),
        presence: user.get("status").and_then(Value::as_str).and_then(Presence::parse),
        status_text: text(user, "statusText"),
        roles: user
            .get("roles")
            .and_then(Value::as_array)
            .map(|r| r.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default(),
        utc_offset: user.get("utcOffset").and_then(Value::as_f64),
        bio: text(user, "bio"),
        avatar_etag: text(user, "avatarETag"),
        bot: false,
        bot_owner: None,
    })
}

/// "14:05 (UTC+2)" for someone `offset` hours from UTC, at `now_utc`.
pub fn local_time(offset: f64, now_utc: chrono::DateTime<chrono::Utc>) -> String {
    let minutes = (offset * 60.0).round() as i64;
    let there = now_utc + chrono::Duration::minutes(minutes);
    let sign = if minutes < 0 { '−' } else { '+' };
    let (h, m) = (minutes.abs() / 60, minutes.abs() % 60);
    let zone = if m == 0 { format!("UTC{sign}{h}") } else { format!("UTC{sign}{h}:{m:02}") };
    format!("{} ({zone})", there.format("%H:%M"))
}

/// `chat.search`'s messages, newest first as the server gives them.
pub fn search_results(response: &Value) -> Vec<Message> {
    response
        .get("messages")
        .and_then(Value::as_array)
        .map(|m| m.iter().filter_map(to_message).collect())
        .unwrap_or_default()
}

/// `updateAvatar` on `stream-notify-logged`: `[{username, etag}]` for a
/// person, `[{rid, etag}]` for a room. A removed photo comes without etag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AvatarChange {
    User { username: String, etag: Option<String> },
    Room { rid: String, etag: Option<String> },
}

pub fn avatar_change(args: &[Value]) -> Option<AvatarChange> {
    let first = args.first()?;
    let etag = text(first, "etag");
    if let Some(username) = text(first, "username") {
        return Some(AvatarChange::User { username, etag });
    }
    Some(AvatarChange::Room { rid: text(first, "rid")?, etag })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    #[test]
    fn room_fields() {
        let r = room_info(&json!({"_id":"r1","name":"general","fname":"General","t":"c","topic":" hi ",
            "usersCount":12,"ro":true,"default":true}))
        .unwrap();
        assert_eq!((r.name.as_str(), r.topic.as_deref(), r.members), ("General", Some("hi"), Some(12)));
        assert!(r.read_only && r.default && !r.encrypted);
        assert_eq!(r.description, None);
    }

    #[test]
    fn profile_fields() {
        let p = profile(&json!({"_id":"u1","username":"bob","name":"Bob","status":"away","roles":["user","admin"],
            "utcOffset":5.5,"bio":"Hello"}))
        .unwrap();
        assert_eq!(p.presence, Some(Presence::Away));
        assert_eq!(p.roles, ["user", "admin"]);
        assert_eq!(p.utc_offset, Some(5.5));
    }

    #[test]
    fn local_times() {
        let now = chrono::Utc.with_ymd_and_hms(2026, 9, 24, 12, 0, 0).unwrap();
        assert_eq!(local_time(2.0, now), "14:00 (UTC+2)");
        assert_eq!(local_time(5.5, now), "17:30 (UTC+5:30)");
        assert_eq!(local_time(-4.0, now), "08:00 (UTC−4)");
    }

    #[test]
    fn avatar_changes() {
        assert_eq!(
            avatar_change(&[json!({"username":"bob","etag":"e1"})]),
            Some(AvatarChange::User { username: "bob".into(), etag: Some("e1".into()) })
        );
        assert_eq!(avatar_change(&[json!({"rid":"r1"})]), Some(AvatarChange::Room { rid: "r1".into(), etag: None }));
    }
}
