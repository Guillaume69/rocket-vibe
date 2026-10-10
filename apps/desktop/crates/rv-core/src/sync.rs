//! The socket and REST both write into SQLite; the UI observes the store.

use std::sync::Arc;

use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::Value;

use crate::mattermost::Flavor;
use crate::mattermost::sync::MmSync;
use crate::normalize::{Message, to_epoch, to_message, to_room, to_subscription};
use crate::rest::{CallOptions, RestClient, RestError};
use crate::store::{Store, Writer};

pub const STREAM_ROOM_MESSAGES: &str = "stream-room-messages";
pub const STREAM_NOTIFY_USER: &str = "stream-notify-user";
pub const STREAM_NOTIFY_ROOM: &str = "stream-notify-room";
/// One key on `stream-room-messages` covers new messages and edits of EVERY
/// room of the user. Deletions are not on it: they stay per room.
pub const MY_MESSAGES: &str = "__my_messages__";
const DELETED_CURSOR: &str = "messages-deleted";
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

/// The server family a session speaks to. Every per-server choice matches on
/// it, exhaustively: a forgotten case is a compile error, not a silent fall
/// through to Rocket.Chat's REST on a Mattermost server.
pub(crate) enum Backend<'a> {
    RocketChat,
    /// Mattermost or kChat, with the engine that maps its channels and posts.
    Mattermost(&'a Arc<MmSync>),
}

pub struct SyncEngine {
    store: Arc<Store>,
    rest: RestClient,
    me: String,
    me_uid: String,
    /// A Mattermost or kChat account: every read goes there instead.
    mattermost: Option<Arc<MmSync>>,
}

impl SyncEngine {
    pub fn new(store: Arc<Store>, rest: RestClient, me: &str, me_uid: &str) -> Self {
        SyncEngine { store, rest, me: me.to_owned(), me_uid: me_uid.to_owned(), mattermost: None }
    }

    pub fn for_mattermost(store: Arc<Store>, rest: RestClient, me: &str, me_uid: &str, flavor: Flavor) -> Self {
        let mm = MmSync::new(store.clone(), rest.clone(), me_uid, me, flavor == Flavor::Kchat);
        SyncEngine { mattermost: Some(Arc::new(mm)), ..Self::new(store, rest, me, me_uid) }
    }

    /// Which server family this engine reads; match on it, exhaustively.
    pub(crate) fn backend(&self) -> Backend<'_> {
        match &self.mattermost {
            Some(mm) => Backend::Mattermost(mm),
            None => Backend::RocketChat,
        }
    }

    pub fn apply_event(&self, collection: &str, key: &str, args: &[Value]) {
        let first = args.first().unwrap_or(&Value::Null);
        match collection {
            STREAM_ROOM_MESSAGES => {
                if let Some(m) = to_message(first) {
                    self.store.write(|w| {
                        w.upsert_message(&m);
                        w.note_author(first);
                    });
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
                            self.store.write(|w| {
                                w.upsert_subscription(&s);
                                w.note_dm_name(doc);
                            });
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
        match self.backend() {
            Backend::Mattermost(mm) => {
                return mm.ingest(raw);
            }
            Backend::RocketChat => {}
        }
        self.store.write(|w| ingest_into(w, raw))
    }

    /// A room document a REST answer carried (a discussion created, a
    /// channel joined): stored at once, ahead of the stream. Rocket.Chat only.
    pub fn ingest_room(&self, raw: &Value) {
        match self.backend() {
            Backend::Mattermost(_) => return,
            Backend::RocketChat => {}
        }
        if let Some(r) = to_room(raw, &self.me, &self.me_uid) {
            self.store.write(|w| w.upsert_room(&r));
        }
    }

    /// `rooms.get` + `subscriptions.get` with `updatedSince`: every room and
    /// counter in two requests. Without a cursor, the full load.
    pub async fn catch_up_global(&self) -> Result<(), RestError> {
        match self.backend() {
            Backend::Mattermost(mm) => {
                return mm.catch_up_global().await;
            }
            Backend::RocketChat => {}
        }
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
                    w.note_dm_name(&raw);
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

    /// Rooms I left or that were deleted while nothing listened: whatever
    /// the full subscription list no longer has goes. An empty list is not
    /// trusted to mean "no rooms".
    pub async fn reconcile_rooms(&self) -> Result<(), RestError> {
        match self.backend() {
            Backend::Mattermost(mm) => {
                return mm.reconcile_rooms().await;
            }
            Backend::RocketChat => {}
        }
        let response = self.rest.get("subscriptions.get", CallOptions::default()).await?;
        let live: Vec<String> = response
            .get("update")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(|s| s.get("rid")?.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        if !live.is_empty() {
            self.store.write(|w| w.purge_rooms_except(&live));
        }
        // The full list names every DM's other party: real names known even
        // for conversations no catch-up has touched since the upgrade.
        if let Some(list) = response.get("update").and_then(Value::as_array) {
            self.store.write(|w| list.iter().for_each(|s| w.note_dm_name(s)));
        }
        Ok(())
    }

    /// Edits and deletions in the room since its cursor, which the stream
    /// may have missed. `chat.syncMessages` takes one room and one kind per
    /// call; two pages at most per kind, the cursor keeps the rest for later.
    pub async fn catch_up_room(&self, rid: &str) -> Result<(), RestError> {
        match self.backend() {
            Backend::Mattermost(mm) => {
                return mm.catch_up_room(rid).await;
            }
            Backend::RocketChat => {}
        }
        let Some(since) = self.store.cursor(rid, "messages") else { return Ok(()) };
        self.sync_pages(rid, "UPDATED", "messages", since).await?;
        match self.store.cursor(rid, DELETED_CURSOR) {
            Some(deleted_since) => self.sync_pages(rid, "DELETED", DELETED_CURSOR, deleted_since).await,
            None => {
                self.store.write(|w| w.write_cursor(rid, DELETED_CURSOR, since));
                Ok(())
            }
        }
    }

    async fn sync_pages(&self, rid: &str, kind: &str, stream: &str, since: i64) -> Result<(), RestError> {
        const PAGE: usize = 50;
        const MAX_PAGES: usize = 2;
        let mut cursor = since;
        for _ in 0..MAX_PAGES {
            let options = CallOptions::params([
                ("roomId", rid.to_owned()),
                ("type", kind.to_owned()),
                ("next", cursor.to_string()),
                ("count", PAGE.to_string()),
            ]);
            let response = self.rest.get("chat.syncMessages", options).await?;
            let result = response.get("result").cloned().unwrap_or(Value::Null);
            let list = |key: &str| result.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
            let next = result.pointer("/cursor/next").and_then(Value::as_str).and_then(|n| n.parse::<i64>().ok());
            self.store.write(|w| {
                let newest = if kind == "DELETED" {
                    let deleted = list("deleted");
                    for d in &deleted {
                        if let Some(id) = d.get("_id").and_then(Value::as_str) {
                            w.delete_message(id);
                        }
                    }
                    deleted.iter().filter_map(|d| d.get("_deletedAt").and_then(to_epoch)).max()
                } else {
                    ingest_into(w, &list("updated"))
                };
                match next {
                    Some(n) if n > cursor => w.write_cursor(rid, stream, n),
                    _ => {
                        if let Some(n) = newest.filter(|n| *n > cursor) {
                            w.write_cursor(rid, stream, n);
                        }
                    }
                }
            });
            match next {
                Some(n) if n > cursor => cursor = n,
                _ => return Ok(()),
            }
        }
        Ok(())
    }

    pub async fn load_history(&self, rid: &str, kind: &str, latest: Option<i64>) -> Result<HistoryPage, RestError> {
        match self.backend() {
            Backend::Mattermost(mm) => {
                return mm.load_history(rid, latest).await;
            }
            Backend::RocketChat => {}
        }
        let messages = self.history(rid, kind, latest, None).await?;
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

    /// The history between two instants, bounds included, never stored. With
    /// both bounds the server answers the NEWEST page of the range, not the
    /// first messages after `oldest`.
    pub async fn history_range(
        &self,
        rid: &str,
        kind: &str,
        latest: Option<i64>,
        oldest: Option<i64>,
    ) -> Result<Vec<Message>, RestError> {
        match self.backend() {
            Backend::Mattermost(mm) => {
                return mm.history_range(rid, latest, oldest).await;
            }
            Backend::RocketChat => {}
        }
        Ok(self.history(rid, kind, latest, oldest).await?.iter().filter_map(to_message).collect())
    }

    async fn history(
        &self,
        rid: &str,
        kind: &str,
        latest: Option<i64>,
        oldest: Option<i64>,
    ) -> Result<Vec<Value>, RestError> {
        let mut o = CallOptions::params([("roomId", rid.to_owned()), ("count", HISTORY_PAGE.to_string())]);
        if let Some(latest) = latest {
            o.params.push(("latest".into(), iso(latest)));
        }
        if let Some(oldest) = oldest {
            o.params.push(("oldest".into(), iso(oldest)));
        }
        // `inclusive`: two messages can share a millisecond; without it the
        // twin of the boundary message would be a permanent hole.
        o.params.push(("inclusive".into(), "true".into()));
        o.params.push(("showThreadMessages".into(), "false".into()));

        let response = self.rest.get(history_endpoint(kind), o).await?;
        Ok(response.get("messages").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    /// The server's copy of one message, not stored.
    pub async fn fetch_message(&self, id: &str) -> Result<Option<Message>, RestError> {
        match self.backend() {
            Backend::Mattermost(mm) => {
                return mm.fetch_message(id).await;
            }
            Backend::RocketChat => {}
        }
        let response = self.rest.get("chat.getMessage", CallOptions::params([("msgId", id)])).await?;
        Ok(response.get("message").and_then(to_message))
    }
}

fn ingest_into(w: &mut Writer, raw: &[Value]) -> Option<i64> {
    let mut newest = None;
    for doc in raw {
        let Some(m) = to_message(doc) else { continue };
        newest = newest.max(Some(m.updated_at));
        w.upsert_message(&m);
        w.note_author(doc);
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
