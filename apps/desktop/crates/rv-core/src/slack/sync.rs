//! Slack into the store: the conversation list with its counts and previews,
//! the history paged by exact `ts`, threads and single messages, and the RTM
//! frames of `live`. Slack pushes no conversation or read document with a
//! message: the conversations and their `client.counts` entries are kept here,
//! seeded by the global catch-up, and the unread state is derived from them.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::directory::{Directory, User};
use super::translate::{self, Translator, first_ts_of, last_ts_of, split_id, ts_ms};
use crate::info::{Profile, RoomInfo};
use crate::normalize::Message;
use crate::rest::{CallOptions, RestClient, RestError};
use crate::store::Store;
use crate::sync::{HISTORY_PAGE, HistoryPage};

const PREVIEWS: usize = 40;
const PREVIEW_CONCURRENCY: usize = 4;
const ROSTER_PAGE: &str = "200";
const MAX_PAGES: usize = 50;
const ROOM_CATCH_UP_PAGES: usize = 4;
const THREAD_PAGE: &str = "200";
const THREAD_PAGES: usize = 20;
/// Where Slack serves a workspace's custom emoji, public like its avatars.
pub const CUSTOM_EMOJI_ORIGIN: &str = "https://emoji.slack-edge.com/";
const GONE: [&str; 4] = ["channel_not_found", "thread_not_found", "message_not_found", "not_in_channel"];

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn is(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool) == Some(true)
}

fn list(v: &Value, key: &str) -> Vec<Value> {
    v.get(key).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// A page's `next_cursor`, None at the end; the same cursor twice is a loop.
fn next_cursor(body: &Value, seen: &mut Vec<String>, method: &str) -> Result<Option<String>, RestError> {
    let Some(cursor) = body.pointer("/response_metadata/next_cursor").and_then(Value::as_str).filter(|c| !c.is_empty())
    else {
        return Ok(None);
    };
    if seen.iter().any(|c| c == cursor) {
        return Err(RestError::incomplete(&format!("{method}: repeated cursor")));
    }
    seen.push(cursor.to_owned());
    Ok(Some(cursor.to_owned()))
}

pub struct SlackSync {
    store: Arc<Store>,
    rest: RestClient,
    pub directory: Arc<Directory>,
    me: String,
    conversations: Mutex<HashMap<String, Value>>,
    names: Mutex<HashMap<String, String>>,
    counts: Mutex<HashMap<String, Value>>,
    /// The newest `ts` marked read per room: never marked backwards.
    marked: Mutex<HashMap<String, String>>,
    /// My "saved for later" messages, the app's stars: messages carry no such flag.
    saved: Mutex<HashSet<String>>,
}

impl SlackSync {
    pub fn new(store: Arc<Store>, rest: RestClient, me: &str, me_username: &str) -> Self {
        let directory = Arc::new(Directory::default());
        directory.remember(User { id: me.to_owned(), username: me_username.to_owned(), ..Default::default() });
        SlackSync {
            store,
            rest,
            directory,
            me: me.to_owned(),
            conversations: Mutex::default(),
            names: Mutex::default(),
            counts: Mutex::default(),
            marked: Mutex::default(),
            saved: Mutex::default(),
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

    /// The people and bots a page names, read before it is translated.
    async fn resolve(&self, messages: &[Value]) {
        let people: Vec<String> = messages.iter().flat_map(translate::people).collect();
        let bots: Vec<String> = messages.iter().filter_map(|m| text(m, "bot_id").map(str::to_owned)).collect();
        tokio::join!(self.directory.ensure(&self.rest, people), self.directory.ensure_bots(&self.rest, bots));
    }

    fn ingest(&self, channel: &str, messages: &[Value]) -> Option<i64> {
        let rows: Vec<Message> = messages.iter().filter_map(|m| self.translate(channel, m)).collect();
        self.store.write(|w| {
            rows.iter().for_each(|m| w.upsert_message(m));
            rows.iter().map(|m| m.updated_at).max()
        })
    }

    /// The workspace's custom emoji, name to image URL. An alias of another
    /// custom emoji takes its image; one of a standard emoji is left out, the
    /// name already resolving through the standard table.
    pub async fn custom_emojis(&self) -> Result<Vec<(String, String)>, RestError> {
        let body = self.call("emoji.list", Vec::new()).await?;
        let list: HashMap<String, String> = body
            .get("emoji")
            .and_then(Value::as_object)
            .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect())
            .unwrap_or_default();
        let resolve = |name: &str| {
            let mut value = list.get(name)?;
            for _ in 0..4 {
                match value.strip_prefix("alias:") {
                    Some(target) => value = list.get(target)?,
                    None => break,
                }
            }
            value.starts_with(CUSTOM_EMOJI_ORIGIN).then(|| value.clone())
        };
        let mut index: Vec<(String, String)> = list.keys().filter_map(|n| Some((n.clone(), resolve(n)?))).collect();
        index.sort();
        Ok(index)
    }

    /// One message Slack answered with (a send), into the store.
    pub async fn ingest_one(&self, channel: &str, raw: &Value) {
        self.resolve(std::slice::from_ref(raw)).await;
        self.ingest(channel, std::slice::from_ref(raw));
    }

    async fn call(&self, method: &str, params: Vec<(&str, String)>) -> Result<Value, RestError> {
        self.rest.post(method, CallOptions::params(params)).await
    }

    /// Every conversation I am in, archived ones left out.
    pub async fn roster(&self) -> Result<Vec<Value>, RestError> {
        let mut out = Vec::new();
        let (mut cursor, mut seen) = (None::<String>, Vec::new());
        for _ in 0..MAX_PAGES {
            let mut params = vec![
                ("types", "public_channel,private_channel,mpim,im".to_owned()),
                ("exclude_archived", "true".to_owned()),
                ("limit", ROSTER_PAGE.to_owned()),
            ];
            params.extend(cursor.take().map(|c| ("cursor", c)));
            let body = self.call("users.conversations", params).await?;
            out.extend(list(&body, "channels").into_iter().filter(|c| text(c, "id").is_some()));
            match next_cursor(&body, &mut seen, "users.conversations")? {
                Some(next) => cursor = Some(next),
                None => return Ok(out),
            }
        }
        Err(RestError::incomplete("users.conversations: too many pages"))
    }

    /// `client.counts` by conversation id; None when Slack would not tell.
    async fn counts(&self) -> Option<HashMap<String, Value>> {
        let body = self.call("client.counts", Vec::new()).await.ok()?;
        let entries = ["channels", "mpims", "ims"].into_iter().flat_map(|key| list(&body, key));
        Some(entries.filter_map(|e| Some((text(&e, "id")?.to_owned(), e))).collect())
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
        let (roster, counts) = tokio::join!(self.roster(), self.counts());
        let roster = roster?;
        self.remember(&roster);
        if let Some(counts) = &counts {
            *self.counts.lock().unwrap() = counts.clone();
        }
        let peers: Vec<String> = roster.iter().filter_map(|c| text(c, "user").map(str::to_owned)).collect();
        self.directory.ensure(&self.rest, std::iter::once(self.me.clone()).chain(peers)).await;
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
                let (page, _) = self.history(rid, vec![("limit", "1".to_owned())]).await.ok()?;
                let newest = page.into_iter().find(|m| !translate::skipped(m))?;
                Some((rid.to_string(), self.translate(rid, &newest)?))
            });
            out.extend(futures_util::future::join_all(fetches).await.into_iter().flatten());
        }
        out
    }

    pub async fn reconcile_rooms(&self) -> Result<(), RestError> {
        let roster = self.roster().await?;
        let live: Vec<String> = roster.iter().filter_map(|c| text(c, "id").map(str::to_owned)).collect();
        if !live.is_empty() {
            self.remember(&roster);
            self.store.write(|w| w.purge_rooms_except(&live));
        }
        Ok(())
    }

    /// One `conversations.history` page, newest first, its people resolved; and whether more follow.
    async fn history(
        &self,
        rid: &str,
        mut params: Vec<(&str, String)>,
    ) -> Result<(Vec<Value>, Option<String>), RestError> {
        params.push(("channel", rid.to_owned()));
        let body = self.call("conversations.history", params).await?;
        let messages = list(&body, "messages");
        self.resolve(&messages).await;
        let more = is(&body, "has_more");
        let cursor = body.pointer("/response_metadata/next_cursor").and_then(Value::as_str).filter(|c| !c.is_empty());
        Ok((messages, if more { cursor.map(str::to_owned) } else { None }))
    }

    /// What was written after the room's newest stored message. When more
    /// than a few pages came since, the cache no longer joins up with the
    /// server: it is cleared and the newest page read in its place.
    pub async fn catch_up_room(&self, rid: &str) -> Result<(), RestError> {
        let newest = self.store.messages(rid, 1).pop();
        let Some(since) = newest.as_ref().and_then(|m| split_id(&m.id)).map(|(_, ts)| ts.to_owned()) else {
            return Ok(());
        };
        let (mut gathered, mut cursor, mut seen) = (Vec::new(), None::<String>, Vec::new());
        for _ in 0..ROOM_CATCH_UP_PAGES {
            let mut params = vec![("oldest", since.clone()), ("limit", HISTORY_PAGE.to_string())];
            params.extend(cursor.take().map(|c| ("cursor", c)));
            let (page, next) = self.history(rid, params).await?;
            gathered.extend(page);
            match next {
                Some(next) if !seen.contains(&next) => {
                    seen.push(next.clone());
                    cursor = Some(next);
                }
                Some(_) => return Err(RestError::incomplete("conversations.history: repeated cursor")),
                None => {
                    self.ingest(rid, &gathered);
                    return Ok(());
                }
            }
        }
        let (first, _) = self.history(rid, vec![("limit", HISTORY_PAGE.to_string())]).await?;
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
        let (messages, _) = self.history(rid, params).await?;
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
        let (messages, _) = self.history(rid, params).await?;
        Ok(messages.iter().filter_map(|m| self.translate(rid, m)).collect())
    }

    /// The server's copy of one message, not stored: from the room's
    /// history, else from its thread.
    pub async fn fetch_message(&self, id: &str) -> Result<Option<Message>, RestError> {
        let Some((rid, ts)) = split_id(id) else { return Ok(None) };
        let gone = |e: RestError| if e.error.as_deref().is_some_and(|c| GONE.contains(&c)) { Ok(None) } else { Err(e) };
        let exact = vec![
            ("latest", ts.to_owned()),
            ("oldest", ts.to_owned()),
            ("inclusive", "true".to_owned()),
            ("limit", "1".to_owned()),
        ];
        let page = match self.history(rid, exact).await {
            Ok((page, _)) => page,
            Err(e) => return gone(e),
        };
        if let Some(found) = page.iter().find(|m| text(m, "ts") == Some(ts)) {
            return Ok(self.translate(rid, found));
        }
        let params = vec![("channel", rid.to_owned()), ("ts", ts.to_owned()), ("limit", "1".to_owned())];
        let replies = match self.call("conversations.replies", params).await {
            Ok(body) => list(&body, "messages"),
            Err(e) => return gone(e),
        };
        let Some(found) = replies.into_iter().find(|m| text(m, "ts") == Some(ts)) else { return Ok(None) };
        self.resolve(std::slice::from_ref(&found)).await;
        Ok(self.translate(rid, &found))
    }

    /// The whole thread. Slack repeats the root at the top of every page.
    pub async fn load_thread(&self, root: &str) -> Result<(), RestError> {
        let Some((rid, ts)) = split_id(root) else { return Err(RestError::incomplete("thread: not a Slack id")) };
        let mut thread: BTreeMap<(i64, String), Value> = BTreeMap::new();
        let (mut cursor, mut seen) = (None::<String>, Vec::new());
        for _ in 0..THREAD_PAGES {
            let mut params =
                vec![("channel", rid.to_owned()), ("ts", ts.to_owned()), ("limit", THREAD_PAGE.to_owned())];
            params.extend(cursor.take().map(|c| ("cursor", c)));
            let body = self.call("conversations.replies", params).await?;
            for message in list(&body, "messages") {
                if let Some(at) = text(&message, "ts").filter(|t| ts_ms(t).is_some()) {
                    thread.insert((ts_ms(at).unwrap_or(0), at.to_owned()), message.clone());
                }
            }
            match next_cursor(&body, &mut seen, "conversations.replies")? {
                Some(next) if is(&body, "has_more") => cursor = Some(next),
                _ => break,
            }
        }
        let messages: Vec<Value> = thread.into_values().collect();
        self.resolve(&messages).await;
        self.ingest(rid, &messages);
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
        self.directory.ensure(&self.rest, [id.clone()]).await;
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
                None
            }
            _ => None,
        }
    }

    async fn live_message(&self, frame: &Value) -> Option<Message> {
        let channel = text(frame, "channel")?;
        match text(frame, "subtype") {
            Some("message_deleted") => {
                let id = translate::message_id(channel, text(frame, "deleted_ts")?);
                self.store.write(|w| w.delete_message(&id));
                None
            }
            Some("message_changed") => {
                let nested = frame.get("message")?;
                self.resolve(std::slice::from_ref(nested)).await;
                let message = self.translate(channel, nested)?;
                self.store.write(|w| w.upsert_message(&message));
                None
            }
            _ => {
                self.resolve(std::slice::from_ref(frame)).await;
                let message = self.translate(channel, frame)?;
                let fresh = !self.store.has_message(&message.id);
                let ts = text(frame, "ts")?;
                let reply = text(frame, "thread_ts").is_some_and(|t| t != ts);
                let mine = text(frame, "user") == Some(self.me.as_str());
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
                self.update_counts(channel, |c| {
                    c["latest"] = Value::from(ts);
                    if !mine {
                        c["has_unreads"] = Value::Bool(true);
                        let before = c.get("mention_count").and_then(Value::as_i64).unwrap_or(0);
                        c["mention_count"] = Value::from(before + i64::from(mention));
                    }
                });
                (fresh && !mine).then_some(message)
            }
        }
    }

    /// Rewrites my message; the stored row follows Slack's answer.
    pub async fn edit(&self, msg_id: &str, text: &str) -> Result<(), RestError> {
        let (channel, ts) = split_id(msg_id).ok_or_else(|| RestError::incomplete("edit: not a Slack message"))?;
        let id_of = |username: &str| self.directory.id_of(username);
        let params = vec![
            ("channel", channel.to_owned()),
            ("ts", ts.to_owned()),
            ("text", translate::markdown_to_mrkdwn(text, &id_of)),
        ];
        let body = self.call("chat.update", params).await?;
        if let Some(message) = body.get("message") {
            let mut message = message.clone();
            message["ts"] = Value::from(ts);
            self.ingest_one(channel, &message).await;
        }
        Ok(())
    }

    pub async fn delete(&self, msg_id: &str) -> Result<(), RestError> {
        let (channel, ts) = split_id(msg_id).ok_or_else(|| RestError::incomplete("delete: not a Slack message"))?;
        self.call("chat.delete", vec![("channel", channel.to_owned()), ("ts", ts.to_owned())]).await?;
        Ok(())
    }

    /// Adds or takes back my reaction; the state already there settles it.
    /// The message is read again, Slack's answer carrying no reactions.
    pub async fn react(&self, msg_id: &str, shortcode: &str, add: bool) -> Result<(), RestError> {
        let (channel, ts) = split_id(msg_id).ok_or_else(|| RestError::incomplete("react: not a Slack message"))?;
        let name = super::emojis::slack_name(shortcode);
        if name.is_empty() {
            return Err(RestError::incomplete("react: no emoji"));
        }
        let params = vec![("channel", channel.to_owned()), ("timestamp", ts.to_owned()), ("name", name)];
        let settled = if add { "already_reacted" } else { "no_reaction" };
        match self.call(if add { "reactions.add" } else { "reactions.remove" }, params).await {
            Ok(_) => {}
            Err(e) if e.error.as_deref() == Some(settled) => {}
            Err(e) => return Err(e),
        }
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
        self.call("conversations.mark", vec![("channel", rid.to_owned()), ("ts", ts.clone())]).await?;
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
        let (channel, ts) = split_id(msg_id).ok_or_else(|| RestError::incomplete("pin: not a Slack message"))?;
        let params = vec![("channel", channel.to_owned()), ("timestamp", ts.to_owned())];
        let settled = if on { "already_pinned" } else { "no_pin" };
        match self.call(if on { "pins.add" } else { "pins.remove" }, params).await {
            Ok(_) => {}
            Err(e) if e.error.as_deref() == Some(settled) => {}
            Err(e) => return Err(e),
        }
        self.refresh(msg_id).await;
        Ok(())
    }

    /// Saves a message for later, or takes it back: the app's star.
    pub async fn save(&self, msg_id: &str, on: bool) -> Result<(), RestError> {
        let (channel, ts) = split_id(msg_id).ok_or_else(|| RestError::incomplete("save: not a Slack message"))?;
        let params = vec![("item_type", "message".to_owned()), ("item_id", channel.to_owned()), ("ts", ts.to_owned())];
        self.call(if on { "saved.add" } else { "saved.delete" }, params).await?;
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

    /// Every message I saved for later, by id; Slack lists the references only.
    pub async fn load_saved(&self) -> Result<(), RestError> {
        let mut ids = HashSet::new();
        let (mut cursor, mut seen) = (None::<String>, Vec::new());
        for _ in 0..MAX_PAGES {
            let mut params = vec![("limit", "100".to_owned())];
            if let Some(c) = &cursor {
                params.push(("cursor", c.clone()));
            }
            let body = self.call("saved.list", params).await?;
            for item in list(&body, "saved_items") {
                if text(&item, "item_type") == Some("message")
                    && let (Some(channel), Some(ts)) = (text(&item, "item_id"), text(&item, "ts"))
                {
                    ids.insert(translate::message_id(channel, ts));
                }
            }
            cursor = next_cursor(&body, &mut seen, "saved.list")?;
            if cursor.is_none() {
                break;
            }
        }
        *self.saved.lock().unwrap() = ids;
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
            let body = self.call("pins.list", vec![("channel", rid.to_owned())]).await?;
            let messages: Vec<Value> =
                list(&body, "items").iter().filter_map(|item| item.get("message").cloned()).collect();
            self.resolve(&messages).await;
            self.ingest(rid, &messages);
            let mut ids: Vec<String> =
                messages.iter().filter_map(|m| Some(translate::message_id(rid, text(m, "ts")?))).collect();
            ids.sort();
            ids
        };
        ids.reverse();
        Ok(ids)
    }

    /// The room's messages Slack's search finds for `query`, newest first.
    pub async fn search(&self, rid: &str, query: &str) -> Result<Vec<Message>, RestError> {
        let params = vec![
            ("query", format!("{query} in:<#{rid}>")),
            ("count", "100".to_owned()),
            ("sort", "timestamp".to_owned()),
            ("sort_dir", "desc".to_owned()),
        ];
        let body = self.call("search.messages", params).await?;
        let matches: Vec<Value> = body
            .pointer("/messages/matches")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|m| m.pointer("/channel/id").and_then(Value::as_str) == Some(rid))
            .cloned()
            .collect();
        self.resolve(&matches).await;
        Ok(matches.iter().filter_map(|m| self.translate(rid, m)).collect())
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

    #[test]
    fn cursors_end_or_loop() {
        let mut seen = Vec::new();
        let page = |c: &str| json!({"response_metadata": {"next_cursor": c}});
        assert_eq!(next_cursor(&page("a"), &mut seen, "m").unwrap().as_deref(), Some("a"));
        assert_eq!(next_cursor(&page(""), &mut seen, "m").unwrap(), None);
        assert_eq!(next_cursor(&json!({}), &mut seen, "m").unwrap(), None);
        assert!(next_cursor(&page("a"), &mut seen, "m").is_err());
    }

    #[test]
    fn permalinks_carry_the_exact_ts() {
        assert_eq!(
            SlackSync::permalink("https://t000.slack.com", "C001", "C001:1700000000.000100"),
            "https://t000.slack.com/archives/C001/p1700000000000100"
        );
    }
}
