//! Who a Mattermost user id is. Posts, reactions and DM channels name users by
//! id only; the rows carry usernames. Every path that translates calls
//! `ensure` first, so the synchronous lookups never miss.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Value, json};

use crate::rest::{CallOptions, RestClient};

const BATCH: usize = 100;

/// Mattermost's `TeammateNameDisplay`: the server's, or my own
/// `display_settings/name_format` preference unless the server locks it.
/// kChat fills `nickname` with the username, so a nickname first would show
/// usernames everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NameFormat {
    Username,
    NicknameFullName,
    #[default]
    FullName,
}

impl NameFormat {
    pub fn parse(value: Option<&str>) -> Option<NameFormat> {
        match value? {
            "username" => Some(NameFormat::Username),
            "nickname_full_name" => Some(NameFormat::NicknameFullName),
            "full_name" => Some(NameFormat::FullName),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            NameFormat::Username => "username",
            NameFormat::NicknameFullName => "nickname_full_name",
            NameFormat::FullName => "full_name",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct User {
    pub id: String,
    pub username: String,
    /// What the name format makes of the fields below; None shows the username.
    pub display: Option<String>,
    pub full_name: Option<String>,
    pub nickname: Option<String>,
    /// The custom status's emoji, as a glyph, while it lasts.
    pub status_emoji: Option<String>,
    /// Read from the server, names included: me, registered at sign-in with my username only, is not.
    pub named: bool,
}

impl User {
    pub fn from_json(raw: &Value) -> Option<User> {
        let id = raw.get("id")?.as_str()?.to_owned();
        let username = raw.get("username")?.as_str()?.to_owned();
        let part = |key: &str| raw.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
        let full = [part("first_name"), part("last_name")].into_iter().flatten().collect::<Vec<_>>().join(" ");
        let full_name = (!full.is_empty()).then_some(full);
        Some(User {
            id,
            username,
            display: full_name.clone(),
            full_name,
            nickname: part("nickname").map(str::to_owned),
            status_emoji: status_emoji(raw),
            named: true,
        })
    }

    fn named_as(mut self, format: NameFormat) -> User {
        if self.named {
            self.display = match format {
                NameFormat::Username => None,
                NameFormat::NicknameFullName => self.nickname.clone().or_else(|| self.full_name.clone()),
                NameFormat::FullName => self.full_name.clone(),
            };
        }
        self
    }
}

/// `props.customStatus`: `{emoji, text, duration, expires_at}`, JSON-encoded on
/// Mattermost, a plain object on kChat (probed).
fn status_emoji(raw: &Value) -> Option<String> {
    let status = match raw.pointer("/props/customStatus")? {
        Value::String(s) => serde_json::from_str::<Value>(s).ok()?,
        v @ Value::Object(_) => v.clone(),
        _ => return None,
    };
    if let Some(expires) =
        status.get("expires_at").and_then(Value::as_str).and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        && expires.timestamp() > 0
        && expires < chrono::Utc::now()
    {
        return None;
    }
    crate::emoji::unicode(status.get("emoji")?.as_str()?).map(str::to_owned)
}

#[derive(Default)]
pub struct Directory {
    by_id: Mutex<HashMap<String, User>>,
    format: Mutex<NameFormat>,
}

impl Directory {
    pub fn remember(&self, user: User) {
        let user = user.named_as(*self.format.lock().unwrap());
        self.by_id.lock().unwrap().insert(user.id.clone(), user);
    }

    pub fn name_format(&self) -> NameFormat {
        *self.format.lock().unwrap()
    }

    /// Names every known user again; true when the format moved.
    pub fn set_name_format(&self, format: NameFormat) -> bool {
        if std::mem::replace(&mut *self.format.lock().unwrap(), format) == format {
            return false;
        }
        let mut users = self.by_id.lock().unwrap();
        for user in users.values_mut() {
            *user = user.clone().named_as(format);
        }
        true
    }

    /// The name a username shows under the name format, when that user is known.
    pub fn name_of(&self, username: &str) -> Option<String> {
        self.by_id.lock().unwrap().values().find(|u| u.username == username).and_then(|u| u.display.clone())
    }

    /// The one known user whose username starts with `cut` (the end of a truncated group DM title).
    pub fn name_of_cut(&self, cut: &str) -> Option<String> {
        let users = self.by_id.lock().unwrap();
        let mut matches = users.values().filter(|u| u.username.starts_with(cut));
        let first = matches.next()?;
        matches.next().is_none().then(|| first.display.clone().unwrap_or_else(|| first.username.clone()))
    }

    /// `user id → name` and `user id → status emoji`, for the rows that show people.
    pub fn display_name(&self, id: &str) -> Option<String> {
        self.by_id.lock().unwrap().get(id).and_then(|u| u.display.clone())
    }

    pub fn status_emoji(&self, id: &str) -> Option<String> {
        self.by_id.lock().unwrap().get(id).and_then(|u| u.status_emoji.clone())
    }
    pub fn user(&self, id: &str) -> Option<User> {
        self.by_id.lock().unwrap().get(id).cloned()
    }

    pub fn username(&self, id: &str) -> Option<String> {
        self.by_id.lock().unwrap().get(id).map(|u| u.username.clone())
    }

    pub fn id_of(&self, username: &str) -> Option<String> {
        self.by_id.lock().unwrap().values().find(|u| u.username == username).map(|u| u.id.clone())
    }

    /// Fetches the unknown ids. A failure leaves them unknown: rows then show
    /// the bare id rather than blocking the stream.
    pub async fn ensure(&self, rest: &RestClient, ids: impl IntoIterator<Item = String>) {
        let missing: Vec<String> = {
            let known = self.by_id.lock().unwrap();
            let mut ids: Vec<String> =
                ids.into_iter().filter(|id| !id.is_empty() && !known.get(id).is_some_and(|u| u.named)).collect();
            ids.sort();
            ids.dedup();
            ids
        };
        for batch in missing.chunks(BATCH) {
            let Ok(users) = rest.post("users/ids", CallOptions::body(json!(batch))).await else { continue };
            for user in users.as_array().into_iter().flatten().filter_map(User::from_json) {
                self.remember(user);
            }
        }
    }

    /// Same as `ensure`, for the usernames a group DM's title lists. kChat cuts
    /// that title at 64 characters, and one cut username refuses the whole
    /// batch: names are then asked one by one.
    pub async fn ensure_usernames(&self, rest: &RestClient, names: impl IntoIterator<Item = String>) {
        let missing: Vec<String> = {
            let known = self.by_id.lock().unwrap();
            let mut names: Vec<String> =
                names.into_iter().filter(|n| !n.is_empty() && !known.values().any(|u| &u.username == n)).collect();
            names.sort();
            names.dedup();
            names
        };
        for batch in missing.chunks(BATCH) {
            let users = match rest.post("users/usernames", CallOptions::body(json!(batch))).await {
                Ok(users) => users.as_array().cloned().unwrap_or_default(),
                Err(_) => {
                    let mut found = Vec::new();
                    for name in batch {
                        if let Ok(users) = rest.post("users/usernames", CallOptions::body(json!([name]))).await {
                            found.extend(users.as_array().cloned().unwrap_or_default());
                        }
                    }
                    found
                }
            };
            for user in users.iter().filter_map(User::from_json) {
                self.remember(user);
            }
        }
    }

    pub async fn by_name(&self, rest: &RestClient, username: &str) -> Option<User> {
        if let Some(id) = self.id_of(username) {
            return self.user(&id);
        }
        let raw = rest.get(&format!("users/username/{username}"), CallOptions::default()).await.ok()?;
        let user = User::from_json(&raw)?;
        self.remember(user.clone());
        Some(user)
    }
}
