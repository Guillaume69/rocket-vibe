//! The message `_id` is generated client-side before anything is shown. The
//! message appears at once (optimistic row, `updated_at = 0`), the outbox
//! persists the intent, and a replay after a crash never duplicates it.
//!
//! In an encrypted room the text is encrypted when it leaves, never before;
//! without the room's key (locked) the row waits instead of failing.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const CLOCK_SKEW_MS: i64 = 120_000;
const DELIVERY_UNCERTAIN: &str = "Delivery could not be confirmed. Check the conversation before retrying.";

use serde_json::{Value, json};

use crate::mattermost::sync::MmSync;
use crate::normalize::Message;
use crate::rest::{CallOptions, RestClient, RestError};
use crate::slack::sync::SlackSync;
use crate::slack::translate::{client_msg_id, first_ts_of, markdown_to_mrkdwn, split_id};
use crate::store::Store;
use crate::sync::Backend;
use crate::sync::SyncEngine;

/// 24 hex characters: the shape of Rocket.Chat `_id`s.
pub fn generate_message_id() -> String {
    (0..12).map(|_| format!("{:02x}", fastrand::u8(..))).collect()
}

type Encryptor = dyn Fn(&str, &Value) -> Option<Value> + Send + Sync;

enum Delivered {
    Yes(Value),
    No,
    Unknown,
    Ambiguous,
}

pub struct Outbox {
    store: Arc<Store>,
    rest: RestClient,
    sync: Arc<SyncEngine>,
    me_id: String,
    me_name: String,
    id_generator: Mutex<Box<dyn FnMut() -> String + Send>>,
    encryptor: Mutex<Option<Arc<Encryptor>>>,
    running: AtomicBool,
    again: AtomicBool,
    /// Mattermost rows a POST went out for in this session, answered or not.
    attempted: Mutex<HashSet<String>>,
    explicit_retries: Mutex<HashSet<String>>,
    started_at: i64,
}

impl Outbox {
    pub fn new(store: Arc<Store>, rest: RestClient, sync: Arc<SyncEngine>, me_id: &str, me_name: &str) -> Self {
        Outbox {
            store,
            rest,
            sync,
            me_id: me_id.to_owned(),
            me_name: me_name.to_owned(),
            id_generator: Mutex::new(Box::new(generate_message_id)),
            encryptor: Mutex::new(None),
            running: AtomicBool::new(false),
            again: AtomicBool::new(false),
            attempted: Mutex::new(HashSet::new()),
            explicit_retries: Mutex::new(HashSet::new()),
            started_at: chrono::Utc::now().timestamp_millis(),
        }
    }

    pub fn set_id_generator(&self, generator: impl FnMut() -> String + Send + 'static) {
        *self.id_generator.lock().unwrap() = Box::new(generator);
    }

    /// How a payload is encrypted for a room: None while it cannot be.
    pub fn set_encryptor(&self, encryptor: impl Fn(&str, &Value) -> Option<Value> + Send + Sync + 'static) {
        *self.encryptor.lock().unwrap() = Some(Arc::new(encryptor));
    }

    /// Shows the message at once and persists the intent. Call `process` to send.
    pub fn enqueue(&self, rid: &str, text: &str, thread_id: Option<&str>) -> String {
        self.enqueue_reply(rid, text, thread_id, false)
    }

    /// `enqueue`, a thread reply `shown` in the room too (`tshow`): it shows
    /// there at once, and the row keeps it for a replay. Rocket.Chat only.
    pub fn enqueue_reply(&self, rid: &str, text: &str, thread_id: Option<&str>, shown: bool) -> String {
        let shown = shown && thread_id.is_some();
        let id = (self.id_generator.lock().unwrap())();
        let message = Message {
            id: id.clone(),
            rid: rid.to_owned(),
            text: Some(text.to_owned()),
            ts: chrono::Utc::now().timestamp_millis(),
            author_id: self.me_id.clone(),
            author_name: Some(self.me_name.clone()),
            system_type: self.store.room_encrypted(rid).then(|| crate::normalize::ENCRYPTED_TYPE.to_owned()),
            thread_id: thread_id.map(str::to_owned),
            thread_shown: shown,
            updated_at: 0,
            ..Default::default()
        };
        self.store.write(|w| {
            w.upsert_message(&message);
            w.insert_reply(&id, rid, text, thread_id, shown);
        });
        id
    }

    /// Drops a failed send locally, the server never having taken it. False when
    /// `id` is not a failed send.
    pub fn discard(&self, id: &str) -> bool {
        let gone = self.store.write(|w| w.discard_failed_outbox(id));
        if gone {
            self.attempted.lock().unwrap().remove(id);
            self.explicit_retries.lock().unwrap().remove(id);
        }
        gone
    }

    pub fn retry(&self, id: &str) {
        self.store.write(|w| w.mark_outbox_pending(id));
        self.explicit_retries.lock().unwrap().insert(id.to_owned());
    }

    /// Flushes pending rows in order. Re-entrant: a pass requested while one
    /// runs is noted and run at the end.
    pub async fn process(&self) {
        if self.running.swap(true, Ordering::SeqCst) {
            self.again.store(true, Ordering::SeqCst);
            return;
        }
        loop {
            self.again.store(false, Ordering::SeqCst);
            let reachable = self.pass().await;
            if !reachable || !self.again.load(Ordering::SeqCst) {
                break;
            }
        }
        self.running.store(false, Ordering::SeqCst);
    }

    /// Returns false when the server is out of reach: no point insisting.
    async fn pass(&self) -> bool {
        match self.sync.backend() {
            Backend::Mattermost(mm) => {
                return self.pass_mattermost(mm).await;
            }
            Backend::Slack(slack) => {
                return self.pass_slack(slack).await;
            }
            Backend::RocketChat => {}
        }
        for entry in self.store.pending_outbox() {
            let Some(message) = self.message_of(&entry) else { continue };
            match self.rest.post("chat.sendMessage", CallOptions::body(json!({"message": message}))).await {
                Ok(response) => {
                    self.store.write(|w| w.delete_outbox(&entry.id));
                    if let Some(doc) = response.get("message") {
                        self.sync.ingest_messages(std::slice::from_ref(doc));
                    }
                }
                // Unreachable: the row stays pending for the next trigger.
                Err(e) if e.status == 0 => return false,
                // Replaying an accepted `_id` answers 400 on 8.5, not success:
                // the answer cannot tell "already delivered" from "refused". Ask.
                Err(e) => match self.delivered(&entry.id).await {
                    // Could not ask. The next rows would burn the same quota for the same verdict.
                    Delivered::Unknown | Delivered::Ambiguous => return false,
                    Delivered::Yes(doc) => {
                        self.sync.ingest_messages(&[doc]);
                        self.store.write(|w| w.delete_outbox(&entry.id));
                    }
                    Delivered::No => self.store.write(|w| w.mark_outbox_failed(&entry.id, &e.message)),
                },
            }
        }
        true
    }

    /// The message as it leaves, or None while it waits for a room key.
    fn message_of(&self, entry: &crate::store::OutboxEntry) -> Option<Value> {
        let mut message = json!({"_id": entry.id, "rid": entry.rid});
        if let Some(tmid) = &entry.thread_id {
            message["tmid"] = json!(tmid);
            // Probed on 8.5.1: accepted beside `tmid` and echoed.
            if entry.shown {
                message["tshow"] = json!(true);
            }
        }
        if !self.store.room_encrypted(&entry.rid) {
            message["msg"] = json!(entry.text);
            return Some(message);
        }
        let encrypt = self.encryptor.lock().unwrap().clone()?;
        message["content"] = encrypt(&entry.rid, &json!({"msg": entry.text}))?;
        message["t"] = json!(crate::normalize::ENCRYPTED_TYPE);
        message["e2e"] = json!("pending");
        message["e2eMentions"] = crate::e2e::mentions(&entry.text);
        Some(message)
    }

    /// Mattermost mints the post id: the row leaves under its client id as
    /// `pending_post_id`, which the server echoes and deduplicates for a short
    /// while. Past that, a refusal is checked against my newest posts, and so is
    /// a row about to go out again when it may already have (sent once in this
    /// session with its answer lost, or queued before a restart): a blind replay
    /// would post a duplicate once the server has forgotten the id.
    async fn pass_mattermost(&self, mm: &MmSync) -> bool {
        for entry in self.store.pending_outbox() {
            let explicit = self.explicit_retries.lock().unwrap().remove(&entry.id);
            let replay =
                !explicit && (self.attempted.lock().unwrap().contains(&entry.id) || entry.created_at < self.started_at);
            if replay {
                match self.mine_on_server(&entry).await {
                    Delivered::Unknown => return false,
                    Delivered::Ambiguous => {
                        self.store.write(|w| w.mark_outbox_failed(&entry.id, DELIVERY_UNCERTAIN));
                        continue;
                    }
                    Delivered::Yes(post) => {
                        self.mm_delivered(mm, &entry.id, post);
                        continue;
                    }
                    Delivered::No => {}
                }
            }
            self.attempted.lock().unwrap().insert(entry.id.clone());
            let mut body = json!({"channel_id": entry.rid, "message": entry.text,
                "root_id": entry.thread_id.clone().unwrap_or_default(),
                "pending_post_id": crate::mattermost::pending_post_id(&self.me_id, &entry.id)});
            // kChat refuses any `props` key it does not know with 422 (probed).
            if !mm.kchat() {
                body["props"] = json!({"rocket_vibe_client_id": entry.id});
            }
            let post = match self.rest.post("posts", CallOptions::body(body)).await {
                Ok(post) => post,
                Err(e) if e.status == 0 => return false,
                // The first POST of this row is still being saved: not a refusal.
                // The row stays pending; the next pass looks for it first.
                Err(e) if e.error.as_deref() == Some(STILL_SAVING) => return false,
                Err(e) => match self.mine_on_server(&entry).await {
                    Delivered::Unknown => return false,
                    Delivered::Ambiguous => {
                        self.store.write(|w| w.mark_outbox_failed(&entry.id, DELIVERY_UNCERTAIN));
                        continue;
                    }
                    Delivered::Yes(post) => post,
                    Delivered::No => {
                        self.store.write(|w| w.mark_outbox_failed(&entry.id, &e.message));
                        continue;
                    }
                },
            };
            self.mm_delivered(mm, &entry.id, post);
        }
        true
    }

    /// Slack mints the message `ts`: the row leaves with a `client_msg_id`
    /// derived from its id, which Slack echoes on the message. Whether it also
    /// deduplicates on it is unqualified, so it only serves to look the
    /// message up: before a replay of a row that may have gone out, and after
    /// a lost answer, which otherwise fails as "delivery unknown", never replayed.
    async fn pass_slack(&self, slack: &SlackSync) -> bool {
        for entry in self.store.pending_outbox() {
            let explicit = self.explicit_retries.lock().unwrap().remove(&entry.id);
            let replay =
                !explicit && (self.attempted.lock().unwrap().contains(&entry.id) || entry.created_at < self.started_at);
            if replay {
                match self.mine_on_slack(&entry).await {
                    Delivered::Unknown => return false,
                    Delivered::Ambiguous => {
                        self.store.write(|w| w.mark_outbox_failed(&entry.id, DELIVERY_UNCERTAIN));
                        continue;
                    }
                    Delivered::Yes(message) => {
                        self.slack_delivered(slack, &entry, message).await;
                        continue;
                    }
                    Delivered::No => {}
                }
            }
            self.attempted.lock().unwrap().insert(entry.id.clone());
            let id_of = |username: &str| slack.directory.id_of(username);
            let mut params = vec![
                ("channel", entry.rid.clone()),
                ("text", markdown_to_mrkdwn(&entry.text, &id_of)),
                ("client_msg_id", client_msg_id(&entry.id)),
            ];
            if let Some((_, ts)) = entry.thread_id.as_deref().and_then(split_id) {
                params.push(("thread_ts", ts.to_owned()));
                if entry.shown {
                    params.push(("reply_broadcast", "true".to_owned()));
                }
            }
            let answered = self.rest.post("chat.postMessage", CallOptions::params(params)).await;
            let sent = match answered {
                Ok(body) => match (body.get("message"), body.get("ts").and_then(Value::as_str)) {
                    (Some(message), Some(ts)) => {
                        let mut message = message.clone();
                        message["ts"] = json!(ts);
                        Some(message)
                    }
                    _ => None,
                },
                Err(e)
                    if e.error.as_deref() == Some(crate::slack::RATE_LIMITED) || crate::rest::is_token_rejected(&e) =>
                {
                    return false;
                }
                Err(e) if e.understood && e.status < 500 => {
                    let code = e.error.as_deref().unwrap_or("refused");
                    self.store
                        .write(|w| w.mark_outbox_failed(&entry.id, &format!("Slack refused the message ({code}).")));
                    continue;
                }
                Err(_) => None,
            };
            let message = match sent {
                Some(message) => message,
                None => match self.mine_on_slack(&entry).await {
                    Delivered::Unknown => return false,
                    Delivered::Yes(message) => message,
                    Delivered::No | Delivered::Ambiguous => {
                        self.store.write(|w| w.mark_outbox_failed(&entry.id, DELIVERY_UNCERTAIN));
                        continue;
                    }
                },
            };
            self.slack_delivered(slack, &entry, message).await;
        }
        true
    }

    async fn slack_delivered(&self, slack: &SlackSync, entry: &crate::store::OutboxEntry, message: Value) {
        self.store.write(|w| {
            w.delete_outbox(&entry.id);
            w.delete_message(&entry.id);
        });
        slack.ingest_one(&entry.rid, &message).await;
        self.attempted.lock().unwrap().remove(&entry.id);
    }

    /// Only the row's own `client_msg_id`, from me, proves a delivery. A
    /// window with more after it cannot prove absence.
    async fn mine_on_slack(&self, entry: &crate::store::OutboxEntry) -> Delivered {
        let mut params = vec![
            ("channel", entry.rid.clone()),
            ("oldest", first_ts_of((entry.created_at - CLOCK_SKEW_MS).max(0))),
            ("inclusive", "true".to_owned()),
            ("limit", "100".to_owned()),
        ];
        let method = match entry.thread_id.as_deref().and_then(split_id) {
            Some((_, ts)) => {
                params.push(("ts", ts.to_owned()));
                "conversations.replies"
            }
            None => "conversations.history",
        };
        let marker = client_msg_id(&entry.id);
        match self.rest.post(method, CallOptions::params(params)).await {
            Ok(body) => {
                let messages = body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
                let field = |m: &Value, key: &str| m.get(key).and_then(Value::as_str).map(str::to_owned);
                if let Some(found) = messages.into_iter().find(|m| {
                    field(m, "client_msg_id").as_deref() == Some(marker.as_str())
                        && field(m, "user").as_deref() == Some(self.me_id.as_str())
                }) {
                    return Delivered::Yes(found);
                }
                if body.get("has_more").and_then(Value::as_bool) == Some(true) {
                    Delivered::Ambiguous
                } else {
                    Delivered::No
                }
            }
            Err(e)
                if unanswered(&e)
                    || e.error.as_deref() == Some(crate::slack::RATE_LIMITED)
                    || crate::rest::is_token_rejected(&e) =>
            {
                Delivered::Unknown
            }
            Err(_) => Delivered::No,
        }
    }

    fn mm_delivered(&self, mm: &MmSync, id: &str, post: Value) {
        self.store.write(|w| {
            w.delete_outbox(id);
            w.delete_message(id);
        });
        mm.ingest(&[post]);
        self.attempted.lock().unwrap().remove(id);
    }

    /// Only a durable operation marker proves delivery. Legacy text matches
    /// remain visible as failed sends, awaiting the user's explicit retry.
    async fn mine_on_server(&self, entry: &crate::store::OutboxEntry) -> Delivered {
        let options = CallOptions::params([("per_page", "30")]);
        match self.rest.get(&format!("channels/{}/posts", entry.rid), options).await {
            Ok(list) => {
                let posts = crate::mattermost::sync::ordered(&list);
                if let Some(post) = posts.iter().find(|p| {
                    p.get("user_id").and_then(Value::as_str) == Some(self.me_id.as_str())
                        && p.get("channel_id").and_then(Value::as_str) == Some(entry.rid.as_str())
                        && p.pointer("/props/rocket_vibe_client_id").and_then(Value::as_str) == Some(entry.id.as_str())
                }) {
                    return Delivered::Yes(post.clone());
                }
                // A page containing only newer posts cannot prove absence.
                if posts.len() >= 30
                    && !posts.iter().any(|p| {
                        p.get("create_at")
                            .and_then(Value::as_i64)
                            .is_some_and(|at| at < entry.created_at - CLOCK_SKEW_MS)
                    })
                {
                    return Delivered::Ambiguous;
                }
                if posts.iter().any(|p| {
                    let field = |key: &str| p.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
                    field("user_id") == Some(self.me_id.as_str())
                        && p.pointer("/props/rocket_vibe_client_id").and_then(Value::as_str).is_none()
                        && field("message") == Some(entry.text.as_str())
                        && field("root_id") == entry.thread_id.as_deref()
                        && p.get("create_at")
                            .and_then(Value::as_i64)
                            .is_some_and(|at| at >= entry.created_at - CLOCK_SKEW_MS)
                }) {
                    Delivered::Ambiguous
                } else {
                    Delivered::No
                }
            }
            Err(e) if unanswered(&e) => Delivered::Unknown,
            Err(_) => Delivered::No,
        }
    }

    async fn delivered(&self, id: &str) -> Delivered {
        match self.rest.get("chat.getMessage", CallOptions::params([("msgId", id)])).await {
            Ok(response) => match response.get("message") {
                Some(doc) if doc.get("_id").and_then(Value::as_str) == Some(id) => Delivered::Yes(doc.clone()),
                _ => Delivered::No,
            },
            Err(e) if unanswered(&e) => Delivered::Unknown,
            Err(_) => Delivered::No,
        }
    }
}

/// The lookup got no verdict: silence, the rate limit (`chat.getMessage`
/// shares the 10/min of `chat.sendMessage`), or a server error, such as a proxy's
/// 502 while the server restarts. None of these says the message was refused;
/// marking it failed would turn a maintenance window into retyped messages.
/// Mattermost's answer while the first POST with the same `pending_post_id` is being saved.
const STILL_SAVING: &str = "api.post.deduplicate_create_post.pending";

fn unanswered(e: &RestError) -> bool {
    e.status == 0 || e.status == 429 || e.status >= 500
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_look_like_rocket_chat_ids() {
        let id = generate_message_id();
        assert_eq!(id.len(), 24);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(id, generate_message_id());
    }
}
