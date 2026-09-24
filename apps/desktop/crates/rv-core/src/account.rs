//! My own account: what `me` says, and the calls that change it.

use serde_json::{Map, Value, json};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Me {
    pub username: String,
    pub name: String,
    pub email: String,
    /// The status I chose (`statusDefault`), not the live presence.
    pub status: String,
    pub status_text: String,
    pub bio: String,
    pub avatar_etag: Option<String>,
    /// `all`, `mention`, `nothing`, or `default` (the server's choice).
    pub desktop_notifications: String,
}

pub const STATUSES: [&str; 4] = ["online", "away", "busy", "offline"];

fn text(v: &Value, pointer: &str) -> String {
    v.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_owned()
}

pub fn me(response: &Value) -> Me {
    let status = [text(response, "/statusDefault"), text(response, "/status")]
        .into_iter()
        .find(|s| STATUSES.contains(&s.as_str()))
        .unwrap_or_else(|| "offline".to_owned());
    let preference = text(response, "/settings/preferences/desktopNotifications");
    Me {
        username: text(response, "/username"),
        name: text(response, "/name"),
        email: text(response, "/emails/0/address"),
        status,
        status_text: text(response, "/statusText"),
        bio: text(response, "/bio"),
        avatar_etag: Some(text(response, "/avatarETag")).filter(|e| !e.is_empty()),
        desktop_notifications: if preference.is_empty() { "default".to_owned() } else { preference },
    }
}

/// The fields of `users.updateOwnBasicInfo` that changed; username and email
/// also need the current password.
pub fn basic_info_changes(before: &Me, after: &Me) -> Map<String, Value> {
    let mut data = Map::new();
    for (key, old, new) in [
        ("name", &before.name, &after.name),
        ("username", &before.username, &after.username),
        ("email", &before.email, &after.email),
        ("bio", &before.bio, &after.bio),
    ] {
        if old != new {
            data.insert(key.to_owned(), json!(new));
        }
    }
    data
}

pub fn needs_password(changes: &Map<String, Value>) -> bool {
    changes.contains_key("username") || changes.contains_key("email")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_me() {
        let m = me(&json!({"username":"alice","name":"Alice","emails":[{"address":"a@x.org"}],"status":"offline",
            "statusDefault":"busy","statusText":"in a meeting","avatarETag":"e1",
            "settings":{"preferences":{"desktopNotifications":"mention"}}}));
        assert_eq!((m.status.as_str(), m.email.as_str()), ("busy", "a@x.org"));
        assert_eq!(m.desktop_notifications, "mention");
        assert_eq!(me(&json!({})).desktop_notifications, "default");
    }

    #[test]
    fn changes() {
        let before = Me { name: "A".into(), username: "a".into(), ..Me::default() };
        let after = Me { name: "B".into(), username: "a".into(), bio: "hi".into(), ..Me::default() };
        let c = basic_info_changes(&before, &after);
        assert_eq!(Value::Object(c.clone()), json!({"name":"B","bio":"hi"}));
        assert!(!needs_password(&c));
        let after = Me { username: "b".into(), ..before.clone() };
        assert!(needs_password(&basic_info_changes(&before, &after)));
    }
}
