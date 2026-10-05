//! What the server only streams and never stores: who is typing, who is online.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::Value;

pub const STREAM_NOTIFY_LOGGED: &str = "stream-notify-logged";
pub const USER_STATUS: &str = "user-status";
pub const USER_ACTIVITY: &str = "user-activity";
/// On `stream-notify-user`, after `<uid>/`: what the server says to me alone,
/// such as a slash command's answer.
pub const PRIVATE_MESSAGE: &str = "message";
/// A typist who goes quiet without saying so is forgotten after this.
pub const TYPING_EXPIRY: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Online,
    Away,
    Busy,
    Offline,
}

impl Presence {
    fn from_code(code: i64) -> Option<Self> {
        match code {
            0 => Some(Presence::Offline),
            1 => Some(Presence::Online),
            2 => Some(Presence::Away),
            3 => Some(Presence::Busy),
            _ => None,
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "online" => Some(Presence::Online),
            "away" => Some(Presence::Away),
            "busy" => Some(Presence::Busy),
            "offline" => Some(Presence::Offline),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Presence::Online => "online",
            Presence::Away => "away",
            Presence::Busy => "busy",
            Presence::Offline => "offline",
        }
    }
}

/// `user-status` args: `[[uid, username, statusCode, statusText]]`.
pub fn presence_event(args: &[Value]) -> Option<(String, Presence)> {
    let entry = args.first()?.as_array()?;
    let uid = entry.first()?.as_str().filter(|s| !s.is_empty())?;
    Some((uid.to_owned(), Presence::from_code(entry.get(2)?.as_i64()?)?))
}

/// `<uid>/message` args: `[{rid, msg, private: true, …}]` → (rid, text).
pub fn private_message(args: &[Value]) -> Option<(String, String)> {
    let message = args.first()?;
    let rid = message.get("rid").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let text = message.get("msg").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())?;
    Some((rid.to_owned(), text.to_owned()))
}

/// `users.presence`: everyone the server reports, by uid.
pub fn presence_list(response: &Value) -> Vec<(String, Presence)> {
    response
        .get("users")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|u| {
            let uid = u.get("_id")?.as_str().filter(|s| !s.is_empty())?;
            Some((uid.to_owned(), Presence::parse(u.get("status")?.as_str()?)?))
        })
        .collect()
}

/// `user-activity` args: `[username, ["user-typing", …]]`; an empty list means stopped.
pub fn activity_event(args: &[Value]) -> Option<(String, bool)> {
    let user = args.first()?.as_str().filter(|s| !s.is_empty())?;
    let typing =
        args.get(1).and_then(Value::as_array).is_some_and(|a| a.iter().any(|v| v.as_str() == Some("user-typing")));
    Some((user.to_owned(), typing))
}

#[derive(Default)]
pub struct Typing {
    rooms: HashMap<String, HashMap<String, Instant>>,
}

impl Typing {
    pub fn apply(&mut self, rid: &str, user: &str, typing: bool, now: Instant) {
        let room = self.rooms.entry(rid.to_owned()).or_default();
        if typing {
            room.insert(user.to_owned(), now + TYPING_EXPIRY);
        } else {
            room.remove(user);
        }
    }

    /// Who is typing in the room, by name, `me` left out.
    pub fn who(&self, rid: &str, me: &str, now: Instant) -> Vec<String> {
        let mut names: Vec<String> = self
            .rooms
            .get(rid)
            .into_iter()
            .flatten()
            .filter(|(name, until)| name.as_str() != me && **until > now)
            .map(|(name, _)| name.clone())
            .collect();
        names.sort();
        names
    }

    pub fn clear(&mut self, rid: &str) {
        self.rooms.remove(rid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn private_messages_carry_their_room() {
        let args = [json!({"_id": "1790807900253", "rid": "R1", "msg": "The channel `#nope` does not exist.",
            "private": true, "u": {"username": "rocket.cat"}})];
        assert_eq!(private_message(&args), Some(("R1".into(), "The channel `#nope` does not exist.".into())));
        assert_eq!(private_message(&[json!({"rid": "R1", "msg": "  "})]), None);
        assert_eq!(private_message(&[json!({"msg": "no room"})]), None);
        assert_eq!(private_message(&[]), None);
    }

    #[test]
    fn typing_expires_and_stops() {
        let mut t = Typing::default();
        let now = Instant::now();
        t.apply("r", "bob", true, now);
        t.apply("r", "alice", true, now);
        t.apply("r", "me", true, now);
        assert_eq!(t.who("r", "me", now), ["alice", "bob"]);
        t.apply("r", "alice", false, now);
        assert_eq!(t.who("r", "me", now), ["bob"]);
        assert!(t.who("r", "me", now + TYPING_EXPIRY).is_empty());
        assert!(t.who("other", "me", now).is_empty());
    }

    #[test]
    fn events() {
        assert_eq!(activity_event(&[json!("bob"), json!(["user-typing"])]), Some(("bob".into(), true)));
        assert_eq!(activity_event(&[json!("bob"), json!([])]), Some(("bob".into(), false)));
        assert_eq!(presence_event(&[json!(["u1", "bob", 2, ""])]), Some(("u1".into(), Presence::Away)));
        assert_eq!(presence_event(&[json!(["u1", "bob", 9])]), None);
        let list = presence_list(&json!({"users":[{"_id":"u1","status":"busy"},{"_id":"u2","status":"weird"}]}));
        assert_eq!(list, [("u1".to_owned(), Presence::Busy)]);
    }
}
