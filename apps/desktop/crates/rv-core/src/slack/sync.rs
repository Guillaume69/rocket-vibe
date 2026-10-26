//! Slack into the store: the conversation list with its counts and previews,
//! the history paged by exact `ts`, threads and single messages, and the RTM
//! frames of `live`. Slack pushes no conversation or read document with a
//! message: the conversations and their `client.counts` entries are kept here,
//! seeded by the global catch-up, and the unread state is derived from them.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::directory::{Directory, User};
use super::translate::{self, Translator, first_ts_of, last_ts_of, split_id, ts_ms};
use crate::info::{Profile, RoomInfo};
use crate::normalize::Message;
use crate::rest::{RestClient, RestError};
use crate::store::Store;
use crate::sync::{HISTORY_PAGE, HistoryPage};
use rv_slack::service::{Service, is, text};

pub use rv_slack::service::CUSTOM_EMOJI_ORIGIN;

const PREVIEWS: usize = 40;
const PREVIEW_CONCURRENCY: usize = 4;
const PREVIEW_LOOKBACK: usize = 10;
const ROOM_CATCH_UP_PAGES: usize = 4;
const SPOTLIGHT_PEOPLE: usize = 20;

pub struct SlackSync {
    store: Arc<Store>,
    pub service: Service,
    pub directory: Arc<Directory>,
    me: String,
    conversations: Mutex<HashMap<String, Value>>,
    names: Mutex<HashMap<String, String>>,
    counts: Mutex<HashMap<String, Value>>,
    /// The newest `ts` marked read per room: never marked backwards.
    marked: Mutex<HashMap<String, String>>,
    /// My "saved for later" messages, the app's stars: messages carry no such flag.
    saved: Mutex<HashSet<String>>,
    /// Rooms a live message came from before the list knew them: listed again once each.
    unlisted: Mutex<HashSet<String>>,
    /// The `ts` of the message each room previews, when known.
    previews: Mutex<HashMap<String, String>>,
}

impl SlackSync {
    pub fn new(store: Arc<Store>, rest: RestClient, me: &str, me_username: &str) -> Self {
        let directory = Arc::new(Directory::default());
        directory.remember(User { id: me.to_owned(), username: me_username.to_owned(), ..Default::default() });
        SlackSync {
            store,
            service: Service::new(rest, directory.clone()),
            directory,
            me: me.to_owned(),
            conversations: Mutex::default(),
            names: Mutex::default(),
            counts: Mutex::default(),
            marked: Mutex::default(),
            saved: Mutex::default(),
            unlisted: Mutex::default(),
            previews: Mutex::default(),
        }
    }

    pub fn translate(&self, channel: &str, raw: &Value) -> Option<Message> {
        let names = self.names.lock().unwrap();
        let mut message = Translator { directory: &self.directory, channels: &names }.message(channel, raw)?;
        if self.saved.lock().unwrap().contains(&message.id) {
            message.starred = Some(self.me.clone());
        }
        Some(message)
    }

    fn ingest(&self, channel: &str, messages: &[Value]) -> Option<i64> {
        let rows: Vec<Message> = messages.iter().filter_map(|m| self.translate(channel, m)).collect();
        self.store.write(|w| {
            rows.iter().for_each(|m| w.upsert_message(m));
            rows.iter().map(|m| m.updated_at).max()
        })
    }

    /// The workspace's custom emoji, name to image URL.
    pub async fn custom_emojis(&self) -> Result<Vec<(String, String)>, RestError> {
        self.service.custom_emojis().await
    }

    /// One message Slack answered with (a send), into the store.
    pub async fn ingest_one(&self, channel: &str, raw: &Value) {
        self.service.resolve(std::slice::from_ref(raw)).await;
        self.ingest(channel, std::slice::from_ref(raw));
    }

    /// Every conversation I am in, archived ones left out.
    pub async fn roster(&self) -> Result<Vec<Value>, RestError> {
        self.service.roster().await
    }

    fn remember(&self, roster: &[Value]) {
        let names: HashMap<String, String> = roster
            .iter()
            .filter(|c| !is(c, "is_im") && !is(c, "is_mpim"))
            .filter_map(|c| Some((text(c, "id")?.to_owned(), text(c, "name")?.to_owned())))
            .collect();
        *self.names.lock().unwrap() = names;
        *self.conversations.lock().unwrap() =
            roster.iter().filter_map(|c| Some((text(c, "id")?.to_owned(), c.clone()))).collect();
    }

    /// The list, its counts, and the newest message of the 40 rooms most
    /// recently written to, four at a time.
    pub async fn catch_up_global(&self) -> Result<(), RestError> {
        let snapshot = chrono::Utc::now().timestamp_millis();
        let (roster, counts) = tokio::join!(self.service.roster(), self.service.counts());
        let roster = roster?;
        let counts = counts.or_else(|| {
            let kept = self.counts.lock().unwrap().clone();
            (!kept.is_empty()).then_some(kept)
        });
        self.remember(&roster);
        if let Some(counts) = &counts {
            *self.counts.lock().unwrap() = counts.clone();
        }
        let peers: Vec<String> = roster.iter().filter_map(|c| text(c, "user").map(str::to_owned)).collect();
        self.service.ensure_people(std::iter::once(self.me.clone()).chain(peers)).await;
        let latest =
            |rid: &str| counts.as_ref().and_then(|c| c.get(rid)).and_then(|e| text(e, "latest")).and_then(ts_ms);
        let shown: HashMap<String, (i64, bool)> =
            self.store.rooms().into_iter().map(|r| (r.rid, (r.last_ts, r.last_message.is_some()))).collect();
        let mut recent: Vec<(&str, i64)> =
            roster.iter().filter_map(|c| text(c, "id")).filter_map(|rid| Some((rid, latest(rid)?))).collect();
        recent.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
        let stale: Vec<&str> = recent
            .into_iter()
            .take(PREVIEWS)
            .filter(|(rid, at)| shown.get(*rid).is_none_or(|(last, known)| !known || last < at))
            .map(|(rid, _)| rid)
            .collect();
        let previews = self.previews(&stale).await;
        self.previews
            .lock()
            .unwrap()
            .extend(previews.iter().filter_map(|(rid, m)| Some((rid.clone(), split_id(&m.id)?.1.to_owned()))));
        let rooms: Vec<_> = {
            let names = self.names.lock().unwrap();
            let t = Translator { directory: &self.directory, channels: &names };
            roster
                .iter()
                .filter_map(|c| {
                    let rid = text(c, "id")?;
                    let room = t.room(&self.me, c, latest(rid), previews.get(rid))?;
                    let counts = counts.as_ref().and_then(|map| map.get(rid));
                    let open = !is(c, "is_user_deleted");
                    Some((room, translate::subscription(rid, counts, snapshot, open)))
                })
                .collect()
        };
        self.store.write(|w| {
            for (room, subscription) in &rooms {
                w.upsert_room(room);
                w.upsert_subscription(subscription);
            }
        });
        Ok(())
    }

    async fn previews(&self, rids: &[&str]) -> HashMap<String, Message> {
        let mut out = HashMap::new();
        for chunk in rids.chunks(PREVIEW_CONCURRENCY) {
            let fetches = chunk.iter().map(|rid| async move {
                let (page, _) = self.service.history(rid, vec![("limit", "1".to_owned())]).await.ok()?;
                let newest = page.into_iter().find(|m| !translate::skipped(m))?;
                Some((rid.to_string(), self.translate(rid, &newest)?))
            });
            out.extend(futures_util::future::join_all(fetches).await.into_iter().flatten());
        }
        out
    }

    pub async fn reconcile_rooms(&self) -> Result<(), RestError> {
        let roster = self.service.roster().await?;
        let live: Vec<String> = roster.iter().filter_map(|c| text(c, "id").map(str::to_owned)).collect();
        if !live.is_empty() {
            self.remember(&roster);
            self.store.write(|w| w.purge_rooms_except(&live));
        }
        Ok(())
    }

    /// What was written after the room's newest stored message. When more
    /// than a few pages came since, the cache no longer joins up with the
    /// server: it is cleared and the newest page read in its place.
    pub async fn catch_up_room(&self, rid: &str) -> Result<(), RestError> {
        let stored = self.store.messages(rid, HISTORY_PAGE);
        let Some(since) = stored.iter().rev().find_map(|m| split_id(&m.id)).map(|(_, ts)| ts.to_owned()) else {
            return Ok(());
        };
        if let Some(gathered) = self.service.history_since(rid, &since, HISTORY_PAGE, ROOM_CATCH_UP_PAGES).await? {
            self.ingest(rid, &gathered);
            return Ok(());
        }
        let (first, _) = self.service.history(rid, vec![("limit", HISTORY_PAGE.to_string())]).await?;
        let rows: Vec<Message> = first.iter().filter_map(|m| self.translate(rid, m)).collect();
        self.store.write(|w| {
            w.clear_room_messages(rid);
            rows.iter().for_each(|m| w.upsert_message(m));
        });
        Ok(())
    }

    /// `latest`: the exact `ts` of the stored message shown at that instant,
    /// excluded; without one, the millisecond's last `ts`, included.
    fn before(&self, rid: &str, bound: i64) -> Vec<(&'static str, String)> {
        let exact = self.store.first_shown_at(rid, bound);
        match exact.as_deref().and_then(split_id).filter(|(channel, _)| *channel == rid) {
            Some((_, ts)) => vec![("latest", ts.to_owned())],
            None => vec![("latest", last_ts_of(bound)), ("inclusive", "true".to_owned())],
        }
    }

    pub async fn load_history(&self, rid: &str, latest: Option<i64>) -> Result<HistoryPage, RestError> {
        let mut params = vec![("limit", HISTORY_PAGE.to_string())];
        if let Some(bound) = latest {
            params.extend(self.before(rid, bound));
        }
        let (messages, _) = self.service.history(rid, params).await?;
        self.ingest(rid, &messages);
        let instants = messages.iter().filter_map(|m| text(m, "ts").and_then(ts_ms));
        Ok(HistoryPage { count: messages.len(), oldest_ts: instants.min() })
    }

    /// Up to a page of messages in `[oldest, latest]`, newest first, never stored.
    pub async fn history_range(
        &self,
        rid: &str,
        latest: Option<i64>,
        oldest: Option<i64>,
    ) -> Result<Vec<Message>, RestError> {
        let mut params = vec![("limit", HISTORY_PAGE.to_string()), ("inclusive", "true".to_owned())];
        params.extend(latest.map(|l| ("latest", last_ts_of(l))));
        params.extend(oldest.map(|o| ("oldest", first_ts_of(o))));
        let (messages, _) = self.service.history(rid, params).await?;
        Ok(messages.iter().filter_map(|m| self.translate(rid, m)).collect())
    }

    /// The server's copy of one message, not stored: from the room's
    /// history, else from its thread.
    pub async fn fetch_message(&self, id: &str) -> Result<Option<Message>, RestError> {
        Ok(self.service.message(id).await?.and_then(|(rid, raw)| self.translate(&rid, &raw)))
    }

    /// The whole thread. Slack repeats the root at the top of every page.
    pub async fn load_thread(&self, root: &str) -> Result<(), RestError> {
        let Some((rid, ts)) = split_id(root) else { return Err(RestError::incomplete("thread: not a Slack id")) };
        let messages = self.service.thread(rid, ts).await?;
        self.ingest(rid, &messages);
        Ok(())
    }

    /// Renames a channel; Slack's name is its address too, its own rules
    /// (lower case, no spaces) checked by Slack.
    pub async fn rename(&self, rid: &str, name: &str) -> Result<(), RestError> {
        let renamed = self.service.rename(rid, name).await?;
        if let Some(c) = self.conversations.lock().unwrap().get_mut(rid) {
            c["name"] = Value::from(renamed.clone());
        }
        self.names.lock().unwrap().insert(rid.to_owned(), renamed);
        Ok(())
    }

    pub fn channel_name(&self, rid: &str) -> Option<String> {
        self.names.lock().unwrap().get(rid).cloned()
    }

    /// From the list read at the last catch-up: no request.
    pub fn room_info(&self, rid: &str) -> Option<RoomInfo> {
        let conversations = self.conversations.lock().unwrap();
        let c = conversations.get(rid)?;
        let value = |key: &str| c.pointer(&format!("/{key}/value")).and_then(Value::as_str).filter(|s| !s.is_empty());
        let kind = if is(c, "is_im") || is(c, "is_mpim") {
            "d"
        } else if is(c, "is_private") {
            "p"
        } else {
            "c"
        };
        let name = match text(c, "name") {
            Some(name) if !is(c, "is_im") => name.to_owned(),
            _ => text(c, "user").and_then(|u| self.directory.username(u)).unwrap_or_else(|| rid.to_owned()),
        };
        Some(RoomInfo {
            id: rid.to_owned(),
            name,
            kind: kind.to_owned(),
            topic: value("topic").map(str::to_owned),
            announcement: None,
            description: value("purpose").map(str::to_owned),
            members: c.get("num_members").and_then(Value::as_i64),
            read_only: false,
            encrypted: false,
            archived: is(c, "is_archived"),
            default: is(c, "is_general"),
        })
    }

    pub fn room_by_name(&self, name: &str) -> Option<RoomInfo> {
        let name = name.trim_start_matches('#');
        let rid = self.names.lock().unwrap().iter().find(|(_, n)| n.as_str() == name).map(|(rid, _)| rid.clone())?;
        self.room_info(&rid)
    }

    /// A person as the directory knows them, by username or by id.
    pub async fn profile(&self, key: &str, by_id: bool) -> Option<Profile> {
        let id = if by_id { key.to_owned() } else { self.directory.id_of(key)? };
        self.service.ensure_people([id.clone()]).await;
        let user = self.directory.user(&id)?;
        Some(Profile {
            id: user.id,
            username: user.username,
            name: user.display,
            presence: None,
            status_text: None,
            roles: Vec::new(),
            utc_offset: None,
            bio: None,
            avatar_etag: None,
            bot: false,
            bot_owner: None,
        })
    }

    /// A Slack permalink, from the message id alone.
    pub fn permalink(base_url: &str, rid: &str, msg_id: &str) -> String {
        let ts = split_id(msg_id).map(|(_, ts)| ts.replace('.', "")).unwrap_or_default();
        format!("{}/archives/{rid}/p{ts}", base_url.trim_end_matches('/'))
    }

    /// One RTM frame into the store. Returns a new message from someone
    /// else, for a notification; edits, deletions and reads return nothing.
    pub async fn apply_event(&self, name: &str, frame: &Value) -> Option<Message> {
        match name {
            "message" => self.live_message(frame).await,
            "reaction_added" | "reaction_removed" => {
                let item = frame.get("item")?;
                if text(item, "type") != Some("message") {
                    return None;
                }
                let id = translate::message_id(text(item, "channel")?, text(item, "ts")?);
                if let Ok(Some(message)) = self.fetch_message(&id).await {
                    self.store.write(|w| w.upsert_message(&message));
                }
                None
            }
            "pin_added" | "pin_removed" => {
                let item = frame.get("item")?;
                let channel = text(frame, "channel_id").or_else(|| text(item, "channel"))?;
                let ts = item.get("message").and_then(|m| text(m, "ts"))?;
                self.refresh(&translate::message_id(channel, ts)).await;
                None
            }
            "channel_marked" | "group_marked" | "im_marked" | "mpim_marked" => {
                let rid = text(frame, "channel")?;
                let unread = ["unread_count_display", "unread_count"].iter().find_map(|k| frame.get(*k)?.as_i64());
                let mentions = ["mention_count_display", "mention_count"].iter().find_map(|k| frame.get(*k)?.as_i64());
                self.update_counts(rid, |c| {
                    c["has_unreads"] = Value::Bool(unread.unwrap_or(0) > 0);
                    c["mention_count"] = Value::from(mentions.unwrap_or(0));
                    if let Some(ts) = text(frame, "ts") {
                        c["last_read"] = Value::from(ts);
                    }
                });
                if let Some(ts) = text(frame, "ts") {
                    self.marked.lock().unwrap().insert(rid.to_owned(), ts.to_owned());
                }
                None
            }
            "im_created" | "channel_joined" | "group_joined" | "mpim_open" | "im_open" => {
                let _ = self.catch_up_global().await;
                None
            }
            _ => None,
        }
    }

    async fn live_message(&self, frame: &Value) -> Option<Message> {
        let channel = text(frame, "channel")?;
        match text(frame, "subtype") {
            Some("message_deleted") => {
                let ts = text(frame, "deleted_ts")?;
                let id = translate::message_id(channel, ts);
                self.store.write(|w| w.delete_message(&id));
                self.preview_after_delete(channel, ts).await;
                None
            }
            Some("message_changed") => {
                let nested = frame.get("message")?;
                let preview = self.is_preview(channel, nested);
                if preview && text(nested, "subtype") == Some("tombstone") {
                    self.preview_after_delete(channel, text(nested, "ts")?).await;
                    return None;
                }
                self.service.resolve(std::slice::from_ref(nested)).await;
                let message = self.translate(channel, nested)?;
                self.store.write(|w| w.upsert_message(&message));
                if preview {
                    self.write_preview(channel, Some(&message));
                }
                None
            }
            _ => {
                let unknown = !self.conversations.lock().unwrap().contains_key(channel);
                if unknown && self.unlisted.lock().unwrap().insert(channel.to_owned()) {
                    let _ = self.catch_up_global().await;
                }
                self.service.resolve(std::slice::from_ref(frame)).await;
                let message = self.translate(channel, frame)?;
                let fresh = !self.store.has_message(&message.id);
                let ts = text(frame, "ts")?;
                let reply = text(frame, "thread_ts").is_some_and(|t| t != ts);
                let mine = text(frame, "user") == Some(self.me.as_str());
                if !reply {
                    self.previews.lock().unwrap().insert(channel.to_owned(), ts.to_owned());
                }
                let room = {
                    let conversations = self.conversations.lock().unwrap();
                    let names = self.names.lock().unwrap();
                    let t = Translator { directory: &self.directory, channels: &names };
                    conversations
                        .get(channel)
                        .and_then(|c| t.room(&self.me, c, Some(message.ts), (!reply).then_some(&message)))
                };
                self.store.write(|w| {
                    w.upsert_message(&message);
                    if let Some(room) = &room {
                        w.upsert_room(room);
                    }
                });
                let mention = mentions(frame, &self.me);
                // Slack counts a thread reply as no channel unread: only a mention of me in it.
                let in_thread = reply && text(frame, "subtype") != Some("thread_broadcast");
                if !in_thread || (mention && !mine) {
                    self.update_counts(channel, |c| {
                        if !in_thread {
                            c["latest"] = Value::from(ts);
                        }
                        if !mine {
                            c["has_unreads"] = Value::Bool(true);
                            let before = c.get("mention_count").and_then(Value::as_i64).unwrap_or(0);
                            c["mention_count"] = Value::from(before + i64::from(mention));
                        }
                    });
                }
                (fresh && !mine && (!in_thread || mention)).then_some(message)
            }
        }
    }

    /// Whether a message is its room's preview: the one known, else a root at least as new as the room's latest.
    fn is_preview(&self, rid: &str, message: &Value) -> bool {
        let Some(ts) = text(message, "ts") else { return false };
        if text(message, "thread_ts").is_some_and(|t| t != ts) {
            return false;
        }
        if let Some(known) = self.previews.lock().unwrap().get(rid) {
            return known == ts;
        }
        self.counts
            .lock()
            .unwrap()
            .get(rid)
            .and_then(|c| text(c, "latest"))
            .is_some_and(|latest| super::compare_timestamp(ts, latest).is_ge())
    }

    /// The room's preview after its message went: the newest root message left, or none.
    async fn preview_after_delete(&self, rid: &str, ts: &str) {
        if !self.is_preview(rid, &serde_json::json!({ "ts": ts })) {
            return;
        }
        self.previews.lock().unwrap().remove(rid);
        let Ok((page, _)) = self.service.history(rid, vec![("limit", PREVIEW_LOOKBACK.to_string())]).await else {
            return;
        };
        if self.previews.lock().unwrap().contains_key(rid) {
            return;
        }
        let next = page
            .iter()
            .filter(|m| text(m, "ts").is_some_and(|t| t != ts) && !translate::skipped(m))
            .filter(|m| text(m, "thread_ts").is_none_or(|t| Some(t) == text(m, "ts")))
            .find_map(|m| self.translate(rid, m));
        self.write_preview(rid, next.as_ref());
    }

    /// Writes the room row with `last` as its preview, `None` clearing it; the room keeps its place.
    fn write_preview(&self, rid: &str, last: Option<&Message>) {
        let latest = self.counts.lock().unwrap().get(rid).and_then(|c| text(c, "latest")).and_then(ts_ms);
        let room = {
            let conversations = self.conversations.lock().unwrap();
            let names = self.names.lock().unwrap();
            let t = Translator { directory: &self.directory, channels: &names };
            conversations.get(rid).and_then(|c| t.room(&self.me, c, latest, last))
        };
        let Some(mut room) = room else { return };
        room.keep_preview = false;
        let mut previews = self.previews.lock().unwrap();
        match last.and_then(|m| split_id(&m.id)) {
            Some((_, ts)) => previews.insert(rid.to_owned(), ts.to_owned()),
            None => previews.remove(rid),
        };
        drop(previews);
        self.store.write(|w| w.upsert_room(&room));
    }

    /// Rewrites my message; the stored row follows Slack's answer.
    pub async fn edit(&self, msg_id: &str, text: &str) -> Result<(), RestError> {
        if let Some((channel, message)) = self.service.edit(msg_id, text).await? {
            self.ingest(&channel, std::slice::from_ref(&message));
        }
        Ok(())
    }

    pub async fn delete(&self, msg_id: &str) -> Result<(), RestError> {
        self.service.delete(msg_id).await
    }

    /// Adds or takes back my reaction; the state already there settles it.
    /// The message is read again, Slack's answer carrying no reactions.
    pub async fn react(&self, msg_id: &str, shortcode: &str, add: bool) -> Result<(), RestError> {
        self.service.react(msg_id, shortcode, add).await?;
        if let Ok(Some(message)) = self.fetch_message(msg_id).await {
            self.store.write(|w| w.upsert_message(&message));
        }
        Ok(())
    }

    /// Marks the room read up to its newest message known, never backwards;
    /// the badge clears at once, before Slack's `*_marked` echo.
    pub async fn mark_read(&self, rid: &str) -> Result<(), RestError> {
        let kept = self.counts.lock().unwrap().get(rid).and_then(|c| text(c, "latest").map(str::to_owned));
        let stored = || {
            self.store.messages(rid, 1).into_iter().next().and_then(|m| split_id(&m.id).map(|(_, ts)| ts.to_owned()))
        };
        let Some(ts) = kept.or_else(stored) else { return Ok(()) };
        let newer =
            self.marked.lock().unwrap().get(rid).is_none_or(|before| super::compare_timestamp(&ts, before).is_gt());
        if !newer {
            return Ok(());
        }
        self.service.mark(rid, &ts).await?;
        self.marked.lock().unwrap().insert(rid.to_owned(), ts.clone());
        self.update_counts(rid, |c| {
            c["has_unreads"] = Value::Bool(false);
            c["mention_count"] = Value::from(0);
            c["last_read"] = Value::from(ts.as_str());
        });
        Ok(())
    }

    /// Slack's copy of a message, stored again: an action's answer does not carry it.
    async fn refresh(&self, msg_id: &str) {
        if let Ok(Some(message)) = self.fetch_message(msg_id).await {
            self.store.write(|w| w.upsert_message(&message));
        }
    }

    /// Pins or unpins a message for everyone in the room.
    pub async fn pin(&self, msg_id: &str, on: bool) -> Result<(), RestError> {
        self.service.pin(msg_id, on).await?;
        self.refresh(msg_id).await;
        Ok(())
    }

    /// Saves a message for later, or takes it back: the app's star.
    pub async fn save(&self, msg_id: &str, on: bool) -> Result<(), RestError> {
        self.service.save(msg_id, on).await?;
        {
            let mut saved = self.saved.lock().unwrap();
            if on {
                saved.insert(msg_id.to_owned());
            } else {
                saved.remove(msg_id);
            }
        }
        self.refresh(msg_id).await;
        Ok(())
    }

    /// Every message I saved for later, by id.
    pub async fn load_saved(&self) -> Result<(), RestError> {
        *self.saved.lock().unwrap() = self.service.saved().await?;
        Ok(())
    }

    /// A room's pinned messages, or the ones I saved there, stored; their ids, newest first.
    pub async fn marked(&self, rid: &str, saved: bool) -> Result<Vec<String>, RestError> {
        let mut ids = if saved {
            self.load_saved().await?;
            let mut ids: Vec<String> = self
                .saved
                .lock()
                .unwrap()
                .iter()
                .filter(|id| split_id(id).is_some_and(|(channel, _)| channel == rid))
                .cloned()
                .collect();
            ids.sort();
            for id in &ids {
                self.refresh(id).await;
            }
            ids
        } else {
            let messages = self.service.pins(rid).await?;
            self.ingest(rid, &messages);
            let mut ids: Vec<String> =
                messages.iter().filter_map(|m| Some(translate::message_id(rid, text(m, "ts")?))).collect();
            ids.sort();
            ids
        };
        ids.reverse();
        Ok(ids)
    }

    /// People to start a conversation with, by username or name.
    pub async fn spotlight(&self, query: &str) -> Result<Vec<crate::rooms::Found>, RestError> {
        let people = self.service.search_people(query, &self.me, SPOTLIGHT_PEOPLE).await?;
        Ok(people
            .into_iter()
            .map(|u| crate::rooms::Found::User { id: u.id, username: u.username, name: u.display })
            .collect())
    }

    /// The direct conversation with these people (by username) and me,
    /// created if needed and listed: its rid.
    pub async fn open_direct(&self, usernames: &[String]) -> Result<String, RestError> {
        let ids = usernames
            .iter()
            .map(|name| {
                self.directory.id_of(name).ok_or_else(|| RestError::incomplete("direct message: unknown person"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let rid = self.service.open_conversation(&ids).await?;
        self.catch_up_global().await?;
        Ok(rid)
    }

    /// The room's messages Slack's search finds for `query`, newest first.
    pub async fn search(&self, rid: &str, query: &str) -> Result<Vec<Message>, RestError> {
        let matches = self.service.search(rid, query).await?;
        Ok(matches.iter().filter_map(|m| self.translate(rid, m)).collect())
    }

    /// Where a file's bytes go, and the id Slack gave it.
    pub async fn upload_url(&self, name: &str, length: u64) -> Result<(url::Url, String), RestError> {
        self.service.upload_url(name, length).await
    }

    /// Shares an uploaded file in the room, with its caption and in its thread.
    pub async fn complete_upload(
        &self,
        file_id: &str,
        title: &str,
        rid: &str,
        caption: Option<&str>,
        tmid: Option<&str>,
    ) -> Result<(), RestError> {
        self.service.complete_upload(file_id, title, rid, caption, tmid).await
    }

    /// Changes a room's kept counts and writes its subscription row from them.
    fn update_counts(&self, rid: &str, change: impl FnOnce(&mut Value)) {
        if !self.conversations.lock().unwrap().contains_key(rid) {
            return;
        }
        let entry = {
            let mut counts = self.counts.lock().unwrap();
            let entry = counts.entry(rid.to_owned()).or_insert_with(|| serde_json::json!({"id": rid}));
            change(entry);
            entry.clone()
        };
        let row = translate::subscription(rid, Some(&entry), chrono::Utc::now().timestamp_millis(), true);
        self.store.write(|w| w.upsert_subscription(&row));
    }

    pub fn me(&self) -> &str {
        &self.me
    }
}

/// Whether a message names me, or the whole room.
fn mentions(frame: &Value, me: &str) -> bool {
    let body = text(frame, "text").unwrap_or_default();
    body.contains(&format!("<@{me}>")) || ["<!channel>", "<!here>", "<!everyone>"].iter().any(|m| body.contains(m))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A Slack API answering every call with `body`; the request lines it saw.
    async fn answering(body: Value) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}/api/", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = Vec::new();
                let mut chunk = [0; 2048];
                loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let length = String::from_utf8_lossy(&buf[..end])
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + length {
                        break;
                    }
                }
                log.lock().unwrap().push(String::from_utf8_lossy(&buf).into_owned());
                let body = body.to_string();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        (api, seen)
    }

    fn sync_at(api: &str) -> (Arc<Store>, SlackSync) {
        let store = Arc::new(Store::in_memory().unwrap());
        let rest = RestClient::slack(api.parse().unwrap(), zeroize::Zeroizing::new("d".to_owned()));
        let sync = SlackSync::new(store.clone(), rest, "U000", "me");
        sync.directory.remember(User { id: "U001".into(), username: "bob".into(), ..Default::default() });
        sync.conversations
            .lock()
            .unwrap()
            .insert("C1".into(), json!({"id": "C1", "name": "general", "is_channel": true}));
        sync.counts.lock().unwrap().insert("C1".into(), json!({"id": "C1", "latest": "1.000000"}));
        (store, sync)
    }

    fn room(store: &Store) -> crate::store::RoomRow {
        store.rooms().into_iter().find(|r| r.rid == "C1").unwrap()
    }

    fn said(ts: &str, text: &str) -> Value {
        json!({"type": "message", "channel": "C1", "ts": ts, "user": "U001", "text": text})
    }

    #[tokio::test]
    async fn an_edit_of_the_previewed_message_rewrites_the_preview_and_an_older_one_does_not() {
        let (store, sync) = sync_at("http://127.0.0.1:9/api/");
        sync.apply_event("message", &said("2.000000", "typo")).await;
        let edit = |ts: &str, text: &str| json!({"type": "message", "subtype": "message_changed", "channel": "C1", "ts": "3.000000", "message": said(ts, text)});
        sync.apply_event("message", &edit("0.500000", "old fixed")).await;
        assert_eq!(room(&store).last_message.as_deref(), Some("typo"));
        sync.apply_event("message", &edit("2.000000", "fixed")).await;
        assert_eq!(room(&store).last_message.as_deref(), Some("fixed"));
    }

    #[tokio::test]
    async fn deleting_the_previewed_message_previews_the_newest_root_left_in_place() {
        let left = json!({"ok": true, "messages": [
            {"type": "message", "subtype": "thread_broadcast", "ts": "1.800000", "thread_ts": "1.500000", "user": "U001", "text": "re"},
            {"type": "message", "subtype": "tombstone", "ts": "1.700000", "user": "U001", "text": "This message was deleted."},
            {"type": "message", "ts": "1.500000", "user": "U001", "text": "earlier"},
        ], "has_more": false});
        let (api, seen) = answering(left).await;
        let (store, sync) = sync_at(&api);
        sync.apply_event("message", &said("2.000000", "gone soon")).await;
        let gone = |ts: &str| json!({"type": "message", "subtype": "message_deleted", "channel": "C1", "ts": "3.000000", "deleted_ts": ts});
        let history = || seen.lock().unwrap().iter().any(|r| r.contains("conversations.history"));
        sync.apply_event("message", &gone("1.400000")).await;
        assert!(!history());
        sync.apply_event("message", &gone("2.000000")).await;
        assert!(history());
        let row = room(&store);
        assert_eq!((row.last_message.as_deref(), row.last_ts), (Some("earlier"), 2000));
    }

    #[tokio::test]
    async fn a_previewed_message_turned_tombstone_with_nothing_left_clears_the_preview() {
        let (api, _) = answering(json!({"ok": true, "messages": [], "has_more": false})).await;
        let (store, sync) = sync_at(&api);
        sync.apply_event("message", &said("2.000000", "parent")).await;
        let mut tombstone = said("2.000000", "This message was deleted.");
        tombstone["subtype"] = json!("tombstone");
        tombstone["thread_ts"] = json!("2.000000");
        sync.apply_event("message", &json!({"type": "message", "subtype": "message_changed", "channel": "C1", "ts": "3.000000", "message": tombstone})).await;
        let row = room(&store);
        assert_eq!((row.last_message, row.last_ts), (None, 2000));
    }

    #[test]
    fn permalinks_carry_the_exact_ts() {
        assert_eq!(
            SlackSync::permalink("https://t000.slack.com", "C001", "C001:1700000000.000100"),
            "https://t000.slack.com/archives/C001/p1700000000000100"
        );
    }
}
