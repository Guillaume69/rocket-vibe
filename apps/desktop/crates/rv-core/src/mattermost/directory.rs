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
    /// A bot account (kChat's Euria, a Mattermost bot): the BOT badge.
    pub bot: bool,
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
            bot: raw.get("is_bot").and_then(Value::as_bool) == Some(true),
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
    asked: Mutex<std::collections::HashSet<String>>,
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

    pub fn is_bot(&self, id: &str) -> bool {
        self.by_id.lock().unwrap().get(id).is_some_and(|u| u.bot)
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
        self.lookup(rest, names).await;
    }

    /// The usernames posts mention: one the server answered for, known or not,
    /// is not asked again this session.
    pub async fn ensure_mentioned(&self, rest: &RestClient, names: impl IntoIterator<Item = String>) {
        let names: Vec<String> = {
            let asked = self.asked.lock().unwrap();
            names.into_iter().filter(|n| !asked.contains(n)).collect()
        };
        let answered = self.lookup(rest, names).await;
        self.asked.lock().unwrap().extend(answered);
    }

    async fn lookup(&self, rest: &RestClient, names: impl IntoIterator<Item = String>) -> Vec<String> {
        let missing: Vec<String> = {
            let known = self.by_id.lock().unwrap();
            let mut names: Vec<String> =
                names.into_iter().filter(|n| !n.is_empty() && !known.values().any(|u| &u.username == n)).collect();
            names.sort();
            names.dedup();
            names
        };
        let mut answered = Vec::new();
        for batch in missing.chunks(BATCH) {
            let users = match rest.post("users/usernames", CallOptions::body(json!(batch))).await {
                Ok(users) => {
                    answered.extend_from_slice(batch);
                    users.as_array().cloned().unwrap_or_default()
                }
                Err(_) => {
                    let mut found = Vec::new();
                    for name in batch {
                        match rest.post("users/usernames", CallOptions::body(json!([name]))).await {
                            Ok(users) => {
                                answered.push(name.clone());
                                found.extend(users.as_array().cloned().unwrap_or_default());
                            }
                            Err(e) if matches!(e.status, 400 | 404) => answered.push(name.clone()),
                            Err(_) => {}
                        }
                    }
                    found
                }
            };
            for user in users.iter().filter_map(User::from_json) {
                self.remember(user);
            }
        }
        answered
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn server(answers: Vec<(u16, &'static str)>) -> (RestClient, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let rest = RestClient::mattermost(format!("http://{}", listener.local_addr().unwrap()).parse().unwrap());
        let task = tokio::spawn(async move {
            let mut bodies = Vec::new();
            for (status, body) in answers {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0; 2048];
                let head = loop {
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break at + 4;
                    }
                };
                let length = String::from_utf8_lossy(&buf[..head])
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                while buf.len() < head + length {
                    let n = socket.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                bodies.push(String::from_utf8_lossy(&buf[head..]).into_owned());
                let reply = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
            bodies
        });
        (rest, task)
    }

    const NOBODY: &str = r#"{"id":"api.user.get_by_username.app_error","status_code":400,"message":"no"}"#;

    #[tokio::test]
    async fn a_mention_the_server_answered_is_asked_once() {
        let (rest, task) = server(vec![(200, r#"[{"id":"u-bob","username":"bob"}]"#)]).await;
        let d = Directory::default();
        d.ensure_mentioned(&rest, ["bob".to_owned(), "nobody".to_owned()]).await;
        d.ensure_mentioned(&rest, ["bob".to_owned(), "nobody".to_owned()]).await;
        assert_eq!(task.await.unwrap(), [r#"["bob","nobody"]"#]);
        assert_eq!(d.id_of("bob").as_deref(), Some("u-bob"));
    }

    #[tokio::test]
    async fn a_failed_lookup_is_asked_again() {
        let (rest, task) =
            server(vec![(500, "{}"), (500, "{}"), (400, NOBODY), (200, r#"[{"id":"u-bob","username":"bob"}]"#)]).await;
        let d = Directory::default();
        d.ensure_mentioned(&rest, ["bob".to_owned(), "nobody".to_owned()]).await;
        assert_eq!(d.id_of("bob"), None);
        d.ensure_mentioned(&rest, ["bob".to_owned(), "nobody".to_owned()]).await;
        assert_eq!(task.await.unwrap(), [r#"["bob","nobody"]"#, r#"["bob"]"#, r#"["nobody"]"#, r#"["bob"]"#]);
        assert_eq!(d.id_of("bob").as_deref(), Some("u-bob"));
    }

    #[tokio::test]
    async fn a_group_title_is_not_held_back_by_mentions() {
        let (rest, task) = server(vec![(200, "[]"), (200, "[]")]).await;
        let d = Directory::default();
        d.ensure_mentioned(&rest, ["carol".to_owned()]).await;
        d.ensure_usernames(&rest, ["carol".to_owned()]).await;
        assert_eq!(task.await.unwrap().len(), 2);
    }

    #[test]
    fn a_bot_is_known_by_its_flag() {
        let d = Directory::default();
        d.remember(User::from_json(&serde_json::json!({"id":"b1","username":"euria","is_bot":true})).unwrap());
        d.remember(User::from_json(&serde_json::json!({"id":"u1","username":"bob"})).unwrap());
        assert!(d.is_bot("b1"));
        assert!(!d.is_bot("u1"));
        assert!(!d.is_bot("unknown"));
    }
}
