//! The socket and REST both write into SQLite; the UI observes the store.

use std::sync::Arc;

use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::Value;

use crate::normalize::{to_epoch, to_message, to_room, to_subscription};
use crate::rest::{CallOptions, RestClient, RestError};
use crate::store::{Store, Writer};

pub const STREAM_ROOM_MESSAGES: &str = "stream-room-messages";
pub const STREAM_NOTIFY_USER: &str = "stream-notify-user";
pub const STREAM_NOTIFY_ROOM: &str = "stream-notify-room";
/// One key on `stream-room-messages` covers new messages and edits of EVERY
/// room of the user. Deletions are not on it: they stay per room.
pub const MY_MESSAGES: &str = "__my_messages__";
pub const HISTORY_PAGE: i64 = 50;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HistoryPage {
    pub count: usize,
    pub oldest_ts: Option<i64>,
}

pub fn history_endpoint(kind: &str) -> &'static str {
    match kind {
        "c" => "channels.history",
        "p" => "groups.history",
        _ => "im.history",
    }
}

fn iso(epoch_ms: i64) -> String {
    Utc.timestamp_millis_opt(epoch_ms).unwrap().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `<uid>/subscriptions-changed` -> `subscriptions-changed`.
fn topic_of(key: &str) -> &str {
    key.split_once('/').map_or("", |(_, topic)| topic)
}

pub struct SyncEngine {
    store: Arc<Store>,
    rest: RestClient,
    me: String,
    me_uid: String,
}

impl SyncEngine {
    pub fn new(store: Arc<Store>, rest: RestClient, me: &str, me_uid: &str) -> Self {
        SyncEngine { store, rest, me: me.to_owned(), me_uid: me_uid.to_owned() }
    }

    pub fn apply_event(&self, collection: &str, key: &str, args: &[Value]) {
        let first = args.first().unwrap_or(&Value::Null);
        match collection {
            STREAM_ROOM_MESSAGES => {
                if let Some(m) = to_message(first) {
                    self.store.write(|w| w.upsert_message(&m));
                }
            }
            STREAM_NOTIFY_USER => {
                // 8.5 sends `[action, document]`; some versions send the document alone.
                let (action, doc) = match first {
                    Value::String(action) => (Some(action.as_str()), args.get(1).unwrap_or(&Value::Null)),
                    _ => (None, first),
                };
                // 'removed' only carries the SUBSCRIPTION's `_id`: enough to find
                // the room, not to rebuild it. Upserting would leave a ghost.
                let removed = action == Some("removed");
                let id = doc.get("_id").and_then(Value::as_str).unwrap_or_default();
                match topic_of(key) {
                    "subscriptions-changed" if removed => self.store.write(|w| w.delete_by_subscription_id(id)),
                    "subscriptions-changed" => {
                        if let Some(s) = to_subscription(doc) {
                            self.store.write(|w| w.upsert_subscription(&s));
                        }
                    }
                    "rooms-changed" if removed => self.store.write(|w| w.delete_room(id)),
                    "rooms-changed" => {
                        if let Some(r) = to_room(doc, &self.me, &self.me_uid) {
                            self.store.write(|w| w.upsert_room(&r));
                        }
                    }
                    _ => {}
                }
            }
            STREAM_NOTIFY_ROOM if topic_of(key) == "deleteMessage" => {
                if let Some(id) = first.get("_id").and_then(Value::as_str) {
                    self.store.write(|w| w.delete_message(id));
                }
            }
            _ => {}
        }
    }

    /// Returns the newest `_updatedAt` ingested: the stuff cursors are made of.
    pub fn ingest_messages(&self, raw: &[Value]) -> Option<i64> {
        self.store.write(|w| ingest_into(w, raw))
    }

    /// `rooms.get` + `subscriptions.get` with `updatedSince`: every room and
    /// counter in two requests. Without a cursor, the full load.
    pub async fn catch_up_global(&self) -> Result<(), RestError> {
        let options = |stream: &str| {
            let mut o = CallOptions::default();
            if let Some(c) = self.store.cursor("*", stream) {
                o.params.push(("updatedSince".into(), iso(c)));
            }
            o
        };
        let (rooms, subscriptions) = tokio::try_join!(
            self.rest.get("rooms.get", options("rooms")),
            self.rest.get("subscriptions.get", options("subscriptions")),
        )?;
        let list = |v: &Value, key: &str| v.get(key).and_then(Value::as_array).cloned().unwrap_or_default();

        self.store.write(|w| {
            let mut newest_room = None;
            for raw in list(&rooms, "update") {
                if let Some(r) = to_room(&raw, &self.me, &self.me_uid) {
                    newest_room = newest_room.max(Some(r.updated_at));
                    w.upsert_room(&r);
                }
            }
            for raw in list(&rooms, "remove") {
                if let Some(id) = raw.get("_id").and_then(Value::as_str) {
                    w.delete_room(id);
                }
            }
            if let Some(c) = newest_room {
                w.write_cursor("*", "rooms", c);
            }

            let mut newest_sub = None;
            for raw in list(&subscriptions, "update") {
                if let Some(s) = to_subscription(&raw) {
                    newest_sub = newest_sub.max(Some(s.updated_at));
                    w.upsert_subscription(&s);
                }
            }
            // The server projects `{_id, _deletedAt}`: the SUBSCRIPTION id is the only key.
            for raw in list(&subscriptions, "remove") {
                if let Some(id) = raw.get("_id").and_then(Value::as_str) {
                    w.delete_by_subscription_id(id);
                }
            }
            if let Some(c) = newest_sub {
                w.write_cursor("*", "subscriptions", c);
            }
        });
        Ok(())
    }

    pub async fn load_history(&self, rid: &str, kind: &str, latest: Option<i64>) -> Result<HistoryPage, RestError> {
        let mut o = CallOptions::params([("roomId", rid.to_owned()), ("count", HISTORY_PAGE.to_string())]);
        if let Some(latest) = latest {
            o.params.push(("latest".into(), iso(latest)));
        }
        // `inclusive`: two messages can share a millisecond; without it the
        // twin of the boundary message would be a permanent hole.
        o.params.push(("inclusive".into(), "true".into()));
        o.params.push(("showThreadMessages".into(), "false".into()));

        let response = self.rest.get(history_endpoint(kind), o).await?;
        let messages = response.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        self.store.write(|w| {
            let newest = ingest_into(w, &messages);
            if let Some(newest) = newest
                && w.cursor(rid, "messages").is_none()
            {
                w.write_cursor(rid, "messages", newest);
            }
        });
        Ok(HistoryPage {
            count: messages.len(),
            oldest_ts: messages.iter().filter_map(|m| m.get("ts").and_then(to_epoch)).min(),
        })
    }
}

fn ingest_into(w: &mut Writer, raw: &[Value]) -> Option<i64> {
    let mut newest = None;
    for m in raw.iter().filter_map(to_message) {
        newest = newest.max(Some(m.updated_at));
        w.upsert_message(&m);
    }
    newest
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn iso_is_utc_with_millis() {
        assert_eq!(iso(1700000000123), "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn events_route_to_the_store() {
        let store = Arc::new(Store::in_memory().unwrap());
        let sync = SyncEngine::new(store.clone(), RestClient::new("http://x".parse().unwrap()), "me", "U1");
        sync.apply_event(
            STREAM_ROOM_MESSAGES,
            MY_MESSAGES,
            &[json!({"_id":"m1","rid":"r","msg":"hi","ts":5,"u":{"_id":"U2"}})],
        );
        assert_eq!(store.messages("r", 10).len(), 1);
        sync.apply_event(STREAM_NOTIFY_ROOM, "r/deleteMessage", &[json!({"_id":"m1"})]);
        assert!(store.messages("r", 10).is_empty());

        sync.apply_event(
            STREAM_NOTIFY_USER,
            "U1/rooms-changed",
            &[json!("updated"), json!({"_id":"r","t":"c","name":"general","_updatedAt":1})],
        );
        sync.apply_event(
            STREAM_NOTIFY_USER,
            "U1/subscriptions-changed",
            &[json!("inserted"), json!({"_id":"s","rid":"r","open":true,"_updatedAt":1})],
        );
        assert_eq!(store.rooms().len(), 1);
        sync.apply_event(STREAM_NOTIFY_USER, "U1/subscriptions-changed", &[json!("removed"), json!({"_id":"s"})]);
        assert!(store.rooms().is_empty());
    }
}
