//! Who a Slack user or bot id is, read lazily and kept for the session.
//! Messages name people by id only: every path that translates calls
//! `ensure` first with the ids of the whole page.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde_json::Value;

use crate::rest::{CallOptions, RestClient};

const CONCURRENCY: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct User {
    pub id: String,
    pub username: String,
    pub display: Option<String>,
    pub avatar: Option<String>,
    /// The profile's status emoji as a glyph, and when it ends (seconds; 0 never).
    pub status: Option<(String, i64)>,
}

impl User {
    /// `users.info`'s `user`.
    pub fn from_json(raw: &Value) -> Option<User> {
        let id = raw.get("id")?.as_str()?.to_owned();
        let username = raw.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(&id).to_owned();
        let profile = raw.get("profile").unwrap_or(&Value::Null);
        let part = |key: &str| profile.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        let display = part("display_name").or_else(|| part("real_name")).unwrap_or(&username).to_owned();
        let avatar = part("image_72").filter(|u| u.starts_with("https://")).map(str::to_owned);
        let given = profile.pointer("/status_emoji_display_info/0/unicode").and_then(Value::as_str).map(|points| {
            points
                .split('-')
                .filter_map(|p| u32::from_str_radix(p, 16).ok().and_then(char::from_u32))
                .collect::<String>()
        });
        let status = given
            .filter(|g| !g.is_empty())
            .or_else(|| part("status_emoji").and_then(super::emojis::glyph_of))
            .map(|glyph| (glyph, profile.get("status_expiration").and_then(Value::as_i64).unwrap_or(0)));
        Some(User { id, username, display: Some(display), avatar, status })
    }
}

#[derive(Default)]
pub struct Directory {
    users: Mutex<HashMap<String, User>>,
    bots: Mutex<HashMap<String, String>>,
    /// Ids Slack refused to name: asked once per session.
    unknown: Mutex<HashSet<String>>,
}

impl Directory {
    pub fn remember(&self, user: User) {
        self.users.lock().unwrap().insert(user.id.clone(), user);
    }

    pub fn user(&self, id: &str) -> Option<User> {
        self.users.lock().unwrap().get(id).cloned()
    }

    pub fn username(&self, id: &str) -> Option<String> {
        self.users.lock().unwrap().get(id).map(|u| u.username.clone())
    }

    pub fn display_name(&self, id: &str) -> Option<String> {
        self.users.lock().unwrap().get(id).and_then(|u| u.display.clone())
    }

    pub fn id_of(&self, username: &str) -> Option<String> {
        self.users.lock().unwrap().values().find(|u| u.username == username).map(|u| u.id.clone())
    }

    /// The display name of a known username.
    pub fn name_of(&self, username: &str) -> Option<String> {
        self.users.lock().unwrap().values().find(|u| u.username == username).and_then(|u| u.display.clone())
    }

    /// Whether someone's profile was read, not just their username stored.
    fn fetched(&self, id: &str) -> bool {
        self.users.lock().unwrap().get(id).is_some_and(|u| u.display.is_some())
    }

    /// Someone's status emoji, while it lasts.
    pub fn status_emoji(&self, id: &str) -> Option<String> {
        let (glyph, until) = self.users.lock().unwrap().get(id)?.status.clone()?;
        (until <= 0 || until > chrono::Utc::now().timestamp()).then_some(glyph)
    }

    pub fn avatar(&self, id: &str) -> Option<String> {
        self.users.lock().unwrap().get(id).and_then(|u| u.avatar.clone())
    }

    pub fn bot(&self, id: &str) -> Option<String> {
        self.bots.lock().unwrap().get(id).cloned()
    }

    fn missing(&self, ids: impl IntoIterator<Item = String>, known: impl Fn(&str) -> bool) -> Vec<String> {
        let unknown = self.unknown.lock().unwrap();
        let mut ids: Vec<String> =
            ids.into_iter().filter(|id| !id.is_empty() && !known(id) && !unknown.contains(id)).collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// `users.info` for each id not read yet, a few at a time: someone only
    /// known by username (me, at sign-in) still is. A refusal is remembered; a
    /// network failure leaves the id to the next page.
    pub async fn ensure(&self, rest: &RestClient, ids: impl IntoIterator<Item = String>) {
        let missing = self.missing(ids, |id| self.fetched(id));
        for chunk in missing.chunks(CONCURRENCY) {
            let fetches = chunk.iter().map(|id| async move {
                (id, rest.post("users.info", CallOptions::params([("user", id.as_str())])).await)
            });
            for (id, answer) in futures_util::future::join_all(fetches).await {
                match answer {
                    Ok(body) => match body.get("user").and_then(User::from_json) {
                        Some(user) => self.remember(user),
                        None => _ = self.unknown.lock().unwrap().insert(id.clone()),
                    },
                    Err(e) if e.error.as_deref() == Some("user_not_found") => {
                        _ = self.unknown.lock().unwrap().insert(id.clone())
                    }
                    Err(_) => {}
                }
            }
        }
    }

    /// `bots.info` for each bot id not known yet: its name.
    pub async fn ensure_bots(&self, rest: &RestClient, ids: impl IntoIterator<Item = String>) {
        let missing = self.missing(ids, |id| self.bots.lock().unwrap().contains_key(id));
        for chunk in missing.chunks(CONCURRENCY) {
            let fetches = chunk.iter().map(|id| async move {
                (id, rest.post("bots.info", CallOptions::params([("bot", id.as_str())])).await)
            });
            for (id, answer) in futures_util::future::join_all(fetches).await {
                let name =
                    answer.as_ref().ok().and_then(|b| b.pointer("/bot/name")?.as_str()).filter(|n| !n.is_empty());
                match (name, &answer) {
                    (Some(name), _) => _ = self.bots.lock().unwrap().insert(id.clone(), name.to_owned()),
                    (None, Ok(_)) => _ = self.unknown.lock().unwrap().insert(id.clone()),
                    (None, Err(e)) if e.understood => _ = self.unknown.lock().unwrap().insert(id.clone()),
                    (None, Err(_)) => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_prefer_the_display_name_then_the_real_name() {
        let user = |profile: Value| User::from_json(&json!({"id": "U001", "name": "alice", "profile": profile}));
        let shown = |profile| user(profile).unwrap().display.unwrap();
        assert_eq!(shown(json!({"display_name": "Ali", "real_name": "Alice A"})), "Ali");
        assert_eq!(shown(json!({"display_name": " ", "real_name": "Alice A"})), "Alice A");
        assert_eq!(shown(json!({})), "alice");
        let avatar = user(json!({"image_72": "https://avatars.example.test/a.png"})).unwrap().avatar;
        assert_eq!(avatar.as_deref(), Some("https://avatars.example.test/a.png"));
        assert!(user(json!({"image_72": "http://plain.example.test/a.png"})).unwrap().avatar.is_none());
        assert_eq!(user(json!({})).unwrap().username, "alice");
    }

    #[test]
    fn only_new_ids_are_asked_once_each() {
        let directory = Directory::default();
        directory.remember(User { id: "U001".into(), username: "alice".into(), ..Default::default() });
        directory.unknown.lock().unwrap().insert("U003".into());
        let ids = ["U002", "U001", "U002", "", "U003", "U004"].map(str::to_owned);
        let missing = directory.missing(ids, |id| directory.users.lock().unwrap().contains_key(id));
        assert_eq!(missing, ["U002", "U004"]);
        assert_eq!(directory.id_of("alice").as_deref(), Some("U001"));
    }

    #[test]
    fn someone_stored_by_username_alone_is_still_read() {
        let directory = Directory::default();
        directory.remember(User { id: "U000".into(), username: "me".into(), ..Default::default() });
        assert!(!directory.fetched("U000"));
        directory.remember(User::from_json(&json!({"id": "U000", "name": "me"})).unwrap());
        assert!(directory.fetched("U000"));
    }

    #[test]
    fn the_status_emoji_shows_while_it_lasts() {
        let read = |profile: Value| {
            let directory = Directory::default();
            directory.remember(User::from_json(&json!({"id": "U001", "name": "alice", "profile": profile})).unwrap());
            directory.status_emoji("U001")
        };
        let given = json!({"status_emoji": ":star_of_david:", "status_emoji_display_info": [{"unicode": "2721-fe0f"}]});
        assert_eq!(read(given).as_deref(), Some("\u{2721}\u{FE0F}"));
        assert_eq!(
            read(json!({"status_emoji": ":female-office-worker:"})).as_deref(),
            Some("\u{1F469}\u{200D}\u{1F4BC}")
        );
        assert_eq!(read(json!({"status_emoji": ":issou:"})), None, "a custom emoji is no glyph");
        assert_eq!(read(json!({"status_emoji": ":tada:", "status_expiration": 1})), None, "expired");
        assert_eq!(read(json!({})), None);
    }
}
