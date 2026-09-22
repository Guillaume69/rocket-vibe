//! The message `_id` is generated client-side before anything is shown. The
//! message appears at once (optimistic row, `updated_at = 0`), the outbox
//! persists the intent, and a replay after a crash never duplicates it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use crate::normalize::Message;
use crate::rest::{CallOptions, RestClient};
use crate::store::Store;
use crate::sync::SyncEngine;

/// 24 hex characters: the shape of Rocket.Chat `_id`s.
pub fn generate_message_id() -> String {
    (0..12).map(|_| format!("{:02x}", fastrand::u8(..))).collect()
}

enum Delivered {
    Yes(Value),
    No,
    Unknown,
}

pub struct Outbox {
    store: Arc<Store>,
    rest: RestClient,
    sync: Arc<SyncEngine>,
    me_id: String,
    me_name: String,
    id_generator: Mutex<Box<dyn FnMut() -> String + Send>>,
    running: AtomicBool,
    again: AtomicBool,
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
            running: AtomicBool::new(false),
            again: AtomicBool::new(false),
        }
    }

    pub fn set_id_generator(&self, generator: impl FnMut() -> String + Send + 'static) {
        *self.id_generator.lock().unwrap() = Box::new(generator);
    }

    /// Shows the message at once and persists the intent. Call `process` to send.
    pub fn enqueue(&self, rid: &str, text: &str, thread_id: Option<&str>) -> String {
        let id = (self.id_generator.lock().unwrap())();
        let message = Message {
            id: id.clone(),
            rid: rid.to_owned(),
            text: Some(text.to_owned()),
            ts: chrono::Utc::now().timestamp_millis(),
            author_id: self.me_id.clone(),
            author_name: Some(self.me_name.clone()),
            thread_id: thread_id.map(str::to_owned),
            updated_at: 0,
            ..Default::default()
        };
        self.store.write(|w| {
            w.upsert_message(&message);
            w.insert_outbox(&id, rid, text, thread_id);
        });
        id
    }

    pub fn retry(&self, id: &str) {
        self.store.write(|w| w.mark_outbox_pending(id));
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
        for entry in self.store.pending_outbox() {
            let mut message = json!({"_id": entry.id, "rid": entry.rid, "msg": entry.text});
            if let Some(tmid) = &entry.thread_id {
                message["tmid"] = json!(tmid);
            }
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
                    Delivered::Unknown => return false,
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

    async fn delivered(&self, id: &str) -> Delivered {
        match self.rest.get("chat.getMessage", CallOptions::params([("msgId", id)])).await {
            Ok(response) => match response.get("message") {
                Some(doc) if doc.get("_id").and_then(Value::as_str) == Some(id) => Delivered::Yes(doc.clone()),
                _ => Delivered::No,
            },
            // 429: `chat.getMessage` shares the 10/min limit of `chat.sendMessage`.
            // Neither that nor silence is a denial from the server.
            Err(e) if e.status == 0 || e.status == 429 => Delivered::Unknown,
            Err(_) => Delivered::No,
        }
    }
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
