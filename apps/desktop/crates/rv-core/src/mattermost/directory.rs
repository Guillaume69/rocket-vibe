//! Who a Mattermost user id is. Posts, reactions and DM channels name users by
//! id only; the rows carry usernames. Every path that translates calls
//! `ensure` first, so the synchronous lookups never miss.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{Value, json};

use crate::rest::{CallOptions, RestClient};

const BATCH: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub id: String,
    pub username: String,
    pub display: Option<String>,
}

impl User {
    pub fn from_json(raw: &Value) -> Option<User> {
        let id = raw.get("id")?.as_str()?.to_owned();
        let username = raw.get("username")?.as_str()?.to_owned();
        let part = |key: &str| raw.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
        let full = [part("first_name"), part("last_name")].into_iter().flatten().collect::<Vec<_>>().join(" ");
        let display = part("nickname").map(str::to_owned).or((!full.is_empty()).then_some(full));
        Some(User { id, username, display })
    }
}

#[derive(Default)]
pub struct Directory {
    by_id: Mutex<HashMap<String, User>>,
}

impl Directory {
    pub fn remember(&self, user: User) {
        self.by_id.lock().unwrap().insert(user.id.clone(), user);
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
            let mut ids: Vec<String> = ids.into_iter().filter(|id| !id.is_empty() && !known.contains_key(id)).collect();
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
