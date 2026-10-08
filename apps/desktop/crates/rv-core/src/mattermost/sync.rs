//! Mattermost into the store: global and per-room catch-up, history paged by
//! post id, threads, and the live events.
//!
//! Mattermost pushes no membership document when a post arrives: unread
//! counts are derived here from the channel totals and the cached membership,
//! seeded by the catch-up. A new post rewrites the room's preview, a reply
//! leaves it alone.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::categories::{self, Placement};
use super::directory::{Directory, User};
use super::translate::{Translator, deleted, object};
use crate::normalize::Message;
use crate::rest::{CallOptions, RestClient, RestError};
use crate::store::{Store, Writer};
use crate::sync::{HISTORY_PAGE, HistoryPage};

const PREVIEWS: usize = 40;
const PREVIEW_CONCURRENCY: usize = 4;
const MAX_WALK: usize = 20;
const CURSOR_SCOPE: &str = "*";
const CURSOR_STREAM: &str = "mm-last-post";

#[derive(Default)]
struct Live {
    channels: HashMap<String, Value>,
    members: HashMap<String, Value>,
    last_posts: HashMap<String, Value>,
}

pub struct MmSync {
    store: Arc<Store>,
    rest: RestClient,
    pub directory: Arc<Directory>,
    me: String,
    /// kChat lists deletions on their own route; upstream returns them in `since`.
    deleted_route: bool,
    live: Mutex<Live>,
    /// Post ids by creation instant, per room: the screen pages by instant,
    /// Mattermost by post id.
    index: Mutex<HashMap<String, BTreeMap<i64, String>>>,
    /// My stars: Mattermost's flagged posts, a preference rather than a post field.
    flagged: Mutex<HashSet<String>>,
    /// Where my sidebar categories put each room.
    placements: Mutex<HashMap<String, Placement>>,
}

fn int(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn last_post_at(channel: &Value) -> i64 {
    let root = int(channel, "last_root_post_at");
    if root > 0 { root } else { int(channel, "last_post_at") }
}

fn changed_at(channel: &Value) -> i64 {
    int(channel, "update_at").max(last_post_at(channel))
}

/// Posts of a `{order, posts}` list, in order, deleted ones dropped.
pub fn ordered(list: &Value) -> Vec<Value> {
    let posts = list.get("posts").cloned().unwrap_or(Value::Null);
    list.get("order")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|id| posts.get(id.as_str()?).cloned())
        .filter(|p| !deleted(p))
        .collect()
}

impl MmSync {
    pub fn new(store: Arc<Store>, rest: RestClient, me: &str, me_username: &str, deleted_route: bool) -> Self {
        let directory = Arc::new(Directory::default());
        directory.remember(User { id: me.to_owned(), username: me_username.to_owned(), display: None });
        MmSync {
            store,
            rest,
            directory,
            me: me.to_owned(),
            deleted_route,
            live: Mutex::default(),
            index: Mutex::default(),
            flagged: Mutex::default(),
            placements: Mutex::default(),
        }
    }

    fn translator(&self) -> Translator<'_> {
        Translator { directory: &self.directory, me: &self.me }
    }

    pub fn translate(&self, post: &Value) -> Option<Message> {
        let mut message = self.translator().message(post)?;
        if self.flagged.lock().unwrap().contains(&message.id) {
            message.starred = Some(self.me.clone());
        }
        Some(message)
    }

    /// Records a star and rewrites the post's row with it.
    pub async fn set_flagged(&self, ids: &[String], on: bool) {
        {
            let mut flagged = self.flagged.lock().unwrap();
            for id in ids {
                if on {
                    flagged.insert(id.clone());
                } else {
                    flagged.remove(id);
                }
            }
        }
        for id in ids.iter().filter(|id| self.store.has_message(id)) {
            if let Ok(post) = self.rest.get(&format!("posts/{id}"), CallOptions::default()).await {
                self.ensure_authors(std::slice::from_ref(&post)).await;
                self.ingest(&[post]);
            }
        }
    }

    pub fn note_flagged(&self, posts: &[Value]) {
        self.flagged.lock().unwrap().extend(posts.iter().filter_map(|p| text(p, "id").map(str::to_owned)));
    }

    /// A server older than 5.32 has no categories: the rooms keep the default sections.
    async fn load_categories(&self) {
        if let Ok(placements) = categories::load(&self.rest).await {
            *self.placements.lock().unwrap() = placements;
        }
    }

    fn subscription(&self, channel: &Value, member: &Value) -> Option<crate::normalize::Subscription> {
        let mut s = self.translator().subscription(channel, member)?;
        let placement = self.placements.lock().unwrap().get(&s.rid).cloned();
        categories::place(&mut s, placement.as_ref());
        Some(s)
    }

    /// kChat's only sign of a read made elsewhere: no room in it, so my
    /// memberships are read again and the rooms whose counts moved rewritten.
    async fn recount(&self) {
        let Ok(members) = self.pages("users/me/channel_members").await else { return };
        let moved: Vec<String> = {
            let mut live = self.live.lock().unwrap();
            members
                .into_iter()
                .filter_map(|member| {
                    let rid = text(&member, "channel_id")?.to_owned();
                    let known = live.members.get(&rid)?;
                    let keys = ["msg_count", "msg_count_root", "mention_count", "mention_count_root", "last_viewed_at"];
                    if keys.iter().all(|k| known.get(k) == member.get(k)) {
                        return None;
                    }
                    live.members.insert(rid.clone(), member);
                    Some(rid)
                })
                .collect()
        };
        for rid in moved {
            self.write_room(&rid, false);
        }
    }

    /// Until the server's `sidebar_category_updated` brings the new categories.
    pub fn note_favorite(&self, rid: &str, on: bool) {
        if let Some(placement) = self.placements.lock().unwrap().get_mut(rid) {
            placement.favorite = on;
        }
    }

    /// Categories come without their content: read them again, then rewrite every membership row.
    async fn regroup(&self) {
        self.load_categories().await;
        let live = self.live.lock().unwrap();
        let rows: Vec<_> = live
            .channels
            .iter()
            .filter_map(|(rid, channel)| self.subscription(channel, live.members.get(rid)?))
            .collect();
        drop(live);
        self.store.write(|w| rows.iter().for_each(|s| w.upsert_subscription(s)));
    }

    async fn load_flagged(&self) {
        let Ok(list) = self.rest.get("users/me/preferences/flagged_post", CallOptions::default()).await else { return };
        let ids = list.as_array().into_iter().flatten().filter_map(|p| text(p, "name").map(str::to_owned));
        *self.flagged.lock().unwrap() = ids.collect();
    }

    pub async fn ensure_authors(&self, posts: &[Value]) {
        let mut ids = Vec::new();
        for post in posts {
            ids.extend(text(post, "user_id").map(str::to_owned));
            let reactions = post.pointer("/metadata/reactions").and_then(Value::as_array);
            ids.extend(reactions.into_iter().flatten().filter_map(|r| text(r, "user_id").map(str::to_owned)));
        }
        self.directory.ensure(&self.rest, ids).await;
    }

    /// Posts already resolved by `ensure_authors`, or mine.
    pub fn ingest(&self, posts: &[Value]) -> Option<i64> {
        self.remember_ids(posts);
        self.store.write(|w| self.ingest_into(w, posts))
    }

    fn ingest_into(&self, w: &mut Writer, posts: &[Value]) -> Option<i64> {
        let mut newest = None;
        for m in posts.iter().filter_map(|p| self.translate(p)) {
            newest = newest.max(Some(m.updated_at));
            w.upsert_message(&m);
        }
        newest
    }

    fn remember_ids(&self, posts: &[Value]) {
        let mut index = self.index.lock().unwrap();
        for post in posts {
            if let (Some(rid), Some(id)) = (text(post, "channel_id"), text(post, "id")) {
                index.entry(rid.to_owned()).or_default().insert(int(post, "create_at"), id.to_owned());
            }
        }
    }

    async fn pages(&self, path: &str) -> Result<Vec<Value>, RestError> {
        super::pages(&self.rest, path).await
    }

    pub async fn channels(&self) -> Result<Vec<Value>, RestError> {
        Ok(self.pages("users/me/channels").await?.into_iter().filter(|c| int(c, "delete_at") == 0).collect())
    }

    /// Rooms and memberships in two calls across every team; previews for the
    /// rooms that changed. An unchanged room is not rewritten: its row would
    /// lose its preview.
    pub async fn catch_up_global(&self) -> Result<(), RestError> {
        let (channels, members) = tokio::try_join!(self.channels(), self.pages("users/me/channel_members"))?;
        self.load_flagged().await;
        self.load_categories().await;
        let member_of: HashMap<String, Value> =
            members.into_iter().filter_map(|m| Some((text(&m, "channel_id")?.to_owned(), m))).collect();
        let channels: Vec<Value> =
            channels.into_iter().filter(|c| text(c, "id").is_some_and(|id| member_of.contains_key(id))).collect();
        let peers = channels
            .iter()
            .filter(|c| text(c, "type") == Some("D"))
            .flat_map(|c| text(c, "name").unwrap_or_default().split("__").map(str::to_owned).collect::<Vec<_>>());
        self.directory.ensure(&self.rest, peers.collect::<Vec<_>>()).await;

        let since = self.store.cursor(CURSOR_SCOPE, CURSOR_STREAM).unwrap_or(0);
        let mut changed: Vec<Value> = channels.iter().filter(|c| changed_at(c) > since).cloned().collect();
        changed.sort_by_key(|c| std::cmp::Reverse(last_post_at(c)));
        let previews = self.previews(&changed[..changed.len().min(PREVIEWS)]).await;
        {
            let mut live = self.live.lock().unwrap();
            for channel in &channels {
                let id = text(channel, "id").unwrap_or_default().to_owned();
                live.channels.insert(id.clone(), channel.clone());
                if let Some(member) = member_of.get(&id) {
                    live.members.insert(id.clone(), member.clone());
                }
            }
            live.last_posts.extend(previews);
        }
        let live = self.live.lock().unwrap();
        let t = self.translator();
        let newest = channels.iter().map(changed_at).max().unwrap_or(0);
        self.store.write(|w| {
            for channel in &changed {
                let id = text(channel, "id").unwrap_or_default();
                if let Some(room) = t.room(channel, live.last_posts.get(id)) {
                    w.upsert_room(&room);
                }
            }
            for channel in &channels {
                let id = text(channel, "id").unwrap_or_default();
                if let Some(s) = member_of.get(id).and_then(|m| self.subscription(channel, m)) {
                    w.upsert_subscription(&s);
                }
            }
            if newest > 0 {
                w.write_cursor(CURSOR_SCOPE, CURSOR_STREAM, newest);
            }
        });
        Ok(())
    }

    async fn previews(&self, channels: &[Value]) -> HashMap<String, Value> {
        let mut out = HashMap::new();
        for chunk in channels.chunks(PREVIEW_CONCURRENCY) {
            let fetches = chunk.iter().filter_map(|c| text(c, "id")).map(|rid| async move {
                let page = self.page(rid, None, 1).await.ok()?;
                Some((rid.to_owned(), page.into_iter().next()?))
            });
            out.extend(futures_util::future::join_all(fetches).await.into_iter().flatten());
        }
        out
    }

    pub async fn reconcile_rooms(&self) -> Result<(), RestError> {
        let live: Vec<String> =
            self.channels().await?.iter().filter_map(|c| text(c, "id").map(str::to_owned)).collect();
        if !live.is_empty() {
            self.store.write(|w| w.purge_rooms_except(&live));
        }
        Ok(())
    }

    /// Edits and deletions since the room's cursor, in one call: `since` is
    /// fast server-side, unlike Rocket.Chat's `chat.syncMessages`.
    pub async fn catch_up_room(&self, rid: &str) -> Result<(), RestError> {
        let Some(since) = self.store.cursor(rid, "messages") else { return Ok(()) };
        let list = self
            .rest
            .get(&format!("channels/{rid}/posts"), CallOptions::params([("since", since.to_string())]))
            .await?;
        let posts: Vec<Value> =
            list.get("posts").and_then(Value::as_object).map(|m| m.values().cloned().collect()).unwrap_or_default();
        let mut gone: Vec<String> =
            posts.iter().filter(|p| deleted(p)).filter_map(|p| text(p, "id").map(str::to_owned)).collect();
        if self.deleted_route {
            let ids = self
                .rest
                .get(&format!("channels/{rid}/deleted_posts"), CallOptions::params([("since", since.to_string())]))
                .await
                .unwrap_or(Value::Null);
            gone.extend(ids.as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)));
        }
        let alive: Vec<Value> = posts.into_iter().filter(|p| !deleted(p)).collect();
        self.ensure_authors(&alive).await;
        self.remember_ids(&alive);
        self.store.write(|w| {
            let newest = self.ingest_into(w, &alive);
            for id in &gone {
                w.delete_message(id);
            }
            if let Some(n) = newest.filter(|n| *n > since) {
                w.write_cursor(rid, "messages", n);
            }
        });
        Ok(())
    }

    /// Root posts newest first, deleted ones dropped, authors resolved.
    async fn page(&self, rid: &str, before: Option<&str>, per_page: usize) -> Result<Vec<Value>, RestError> {
        let mut options =
            CallOptions::params([("per_page", per_page.to_string()), ("collapsedThreads", "true".to_owned())]);
        if let Some(before) = before {
            options.params.push(("before".into(), before.to_owned()));
        }
        let posts = ordered(&self.rest.get(&format!("channels/{rid}/posts"), options).await?);
        self.remember_ids(&posts);
        self.ensure_authors(&posts).await;
        Ok(posts)
    }

    fn id_at(&self, rid: &str, at: i64) -> Option<String> {
        self.index.lock().unwrap().get(rid)?.get(&at).cloned()
    }

    async fn older_than(&self, rid: &str, bound: i64) -> Result<Vec<Value>, RestError> {
        if let Some(id) = self.id_at(rid, bound) {
            return self.page(rid, Some(&id), HISTORY_PAGE as usize).await;
        }
        let mut before: Option<String> = None;
        for _ in 0..MAX_WALK {
            let posts = self.page(rid, before.as_deref(), HISTORY_PAGE as usize).await?;
            let older: Vec<Value> = posts.iter().filter(|p| int(p, "create_at") < bound).cloned().collect();
            if !older.is_empty() || posts.len() < HISTORY_PAGE as usize {
                return Ok(older);
            }
            before = posts.last().and_then(|p| text(p, "id")).map(str::to_owned);
        }
        Ok(Vec::new())
    }

    pub async fn load_history(&self, rid: &str, latest: Option<i64>) -> Result<HistoryPage, RestError> {
        let posts = match latest {
            None => self.page(rid, None, HISTORY_PAGE as usize).await?,
            Some(bound) => self.older_than(rid, bound).await?,
        };
        self.store.write(|w| {
            let newest = self.ingest_into(w, &posts);
            if let Some(newest) = newest
                && w.cursor(rid, "messages").is_none()
            {
                w.write_cursor(rid, "messages", newest);
            }
        });
        Ok(HistoryPage { count: posts.len(), oldest_ts: posts.iter().map(|p| int(p, "create_at")).min() })
    }

    /// Up to a page of posts in `[oldest, latest]`, newest first, never stored.
    pub async fn history_range(
        &self,
        rid: &str,
        latest: Option<i64>,
        oldest: Option<i64>,
    ) -> Result<Vec<Message>, RestError> {
        let mut out = Vec::new();
        let mut before = latest.and_then(|l| self.id_at(rid, l));
        for _ in 0..MAX_WALK {
            let posts = self.page(rid, before.as_deref(), HISTORY_PAGE as usize).await?;
            for post in &posts {
                let at = int(post, "create_at");
                if latest.is_some_and(|l| at > l) {
                    continue;
                }
                if oldest.is_some_and(|o| at < o) {
                    return Ok(out);
                }
                out.extend(self.translate(post));
                if out.len() >= HISTORY_PAGE as usize {
                    return Ok(out);
                }
            }
            if posts.len() < HISTORY_PAGE as usize {
                return Ok(out);
            }
            before = posts.last().and_then(|p| text(p, "id")).map(str::to_owned);
        }
        Ok(out)
    }

    pub async fn fetch_message(&self, id: &str) -> Result<Option<Message>, RestError> {
        match self.rest.get(&format!("posts/{id}"), CallOptions::default()).await {
            Ok(post) => {
                self.ensure_authors(std::slice::from_ref(&post)).await;
                Ok(self.translate(&post))
            }
            Err(e) if e.status == 404 || e.status == 403 => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The whole thread, root included.
    pub async fn load_thread(&self, root: &str) -> Result<(), RestError> {
        let posts = ordered(&self.rest.get(&format!("posts/{root}/thread"), CallOptions::default()).await?);
        self.ensure_authors(&posts).await;
        self.ingest(&posts);
        Ok(())
    }

    /// A channel I just learnt about, with my membership.
    async fn load_channel(&self, rid: &str) -> Result<(), RestError> {
        let (channel_path, member_path) = (format!("channels/{rid}"), format!("channels/{rid}/members/me"));
        let (channel, member) = tokio::try_join!(
            self.rest.get(&channel_path, CallOptions::default()),
            self.rest.get(&member_path, CallOptions::default()),
        )?;
        if text(&channel, "type") == Some("D") {
            let peers: Vec<String> =
                text(&channel, "name").unwrap_or_default().split("__").map(str::to_owned).collect();
            self.directory.ensure(&self.rest, peers).await;
        }
        let mut live = self.live.lock().unwrap();
        live.channels.insert(rid.to_owned(), channel);
        live.members.insert(rid.to_owned(), member);
        Ok(())
    }

    /// Writes the room row (with the newest root post known) and its membership.
    fn write_room(&self, rid: &str, room: bool) {
        let live = self.live.lock().unwrap();
        let Some(channel) = live.channels.get(rid) else { return };
        let t = self.translator();
        let room = room.then(|| t.room(channel, live.last_posts.get(rid))).flatten();
        let subscription = live.members.get(rid).and_then(|m| self.subscription(channel, m));
        self.store.write(|w| {
            if let Some(r) = &room {
                w.upsert_room(r);
            }
            if let Some(s) = &subscription {
                w.upsert_subscription(s);
            }
        });
    }

    /// One live event into the store. Returns someone else's new post, for the
    /// notification rule.
    pub async fn apply_event(&self, name: &str, data: &Value, broadcast: &Value) -> Option<Message> {
        let channel_id = text(data, "channel_id").or_else(|| text(broadcast, "channel_id")).map(str::to_owned);
        match name {
            "posted" => self.posted(data).await,
            "post_edited" => {
                let post = Value::Object(object(data.get("post")?)?);
                self.ensure_authors(std::slice::from_ref(&post)).await;
                self.ingest(&[post]);
                None
            }
            "post_deleted" => {
                let post = object(data.get("post")?)?;
                let id = post.get("id")?.as_str()?.to_owned();
                self.store.write(|w| w.delete_message(&id));
                None
            }
            "reaction_added" | "reaction_removed" => {
                let reaction = object(data.get("reaction")?)?;
                let id = reaction.get("post_id")?.as_str()?;
                let post = self.rest.get(&format!("posts/{id}"), CallOptions::default()).await.ok()?;
                self.ensure_authors(std::slice::from_ref(&post)).await;
                self.ingest(&[post]);
                None
            }
            "channel_viewed" => {
                self.viewed(&[channel_id?]);
                None
            }
            "multiple_channels_viewed" => {
                let times = data.get("channel_times").and_then(Value::as_object)?;
                self.viewed(&times.keys().cloned().collect::<Vec<_>>());
                None
            }
            "post_unread" => {
                let rid = channel_id?;
                {
                    let mut live = self.live.lock().unwrap();
                    let member = live.members.get_mut(&rid)?;
                    for key in ["msg_count", "msg_count_root", "mention_count", "last_viewed_at"] {
                        if let Some(v) = data.get(key) {
                            member[key] = v.clone();
                        }
                    }
                }
                self.write_room(&rid, false);
                None
            }
            "channel_created" | "channel_updated" | "channel_converted" | "channel_restored" | "direct_added"
            | "group_added" | "user_added" => {
                let rid = data.get("channel").and_then(object).and_then(|c| c.get("id")?.as_str().map(str::to_owned));
                let rid = rid.or(channel_id)?;
                if name == "user_added" && text(data, "user_id") != Some(self.me.as_str()) {
                    return None;
                }
                self.load_channel(&rid).await.ok()?;
                self.write_room(&rid, true);
                None
            }
            "preferences_changed" | "preferences_deleted" => {
                let list = match data.get("preferences") {
                    Some(Value::String(s)) => serde_json::from_str::<Value>(s).ok()?,
                    Some(v) => v.clone(),
                    None => return None,
                };
                let ids: Vec<String> = list
                    .as_array()?
                    .iter()
                    .filter(|p| text(p, "category") == Some("flagged_post"))
                    .filter_map(|p| text(p, "name").map(str::to_owned))
                    .collect();
                if !ids.is_empty() {
                    self.set_flagged(&ids, name == "preferences_changed").await;
                }
                None
            }
            "badge_updated" => {
                self.recount().await;
                None
            }
            "sidebar_category_created"
            | "sidebar_category_updated"
            | "sidebar_category_deleted"
            | "sidebar_category_order_updated" => {
                self.regroup().await;
                None
            }
            "channel_deleted" => {
                self.removed(&channel_id?);
                None
            }
            "user_removed" => {
                let who = text(data, "user_id").or_else(|| text(broadcast, "user_id"));
                if who == Some(self.me.as_str()) {
                    self.removed(&channel_id?);
                }
                None
            }
            _ => None,
        }
    }

    async fn posted(&self, data: &Value) -> Option<Message> {
        let post = Value::Object(object(data.get("post")?)?);
        let rid = text(&post, "channel_id")?.to_owned();
        self.ensure_authors(std::slice::from_ref(&post)).await;
        let known = self.live.lock().unwrap().members.contains_key(&rid);
        if !known {
            let _ = self.load_channel(&rid).await;
        }
        let root = text(&post, "root_id").is_none();
        let mine = text(&post, "user_id") == Some(self.me.as_str());
        let mentioned = mentions(data.get("mentions")).contains(&self.me);
        let at = int(&post, "create_at");
        let fresh = !self.store.has_message(text(&post, "id").unwrap_or_default());
        {
            let mut live = self.live.lock().unwrap();
            if let Some(channel) = live.channels.get_mut(&rid) {
                channel["total_msg_count"] = json!(int(channel, "total_msg_count") + 1);
                channel["last_post_at"] = json!(at);
                if root {
                    channel["total_msg_count_root"] = json!(int(channel, "total_msg_count_root") + 1);
                    channel["last_root_post_at"] = json!(at);
                }
                let (total, total_root) = (channel["total_msg_count"].clone(), channel["total_msg_count_root"].clone());
                if let Some(member) = live.members.get_mut(&rid) {
                    if mine {
                        member["msg_count"] = total;
                        member["msg_count_root"] = total_root;
                        member["mention_count"] = json!(0);
                        member["last_viewed_at"] = json!(at);
                    } else if mentioned {
                        member["mention_count"] = json!(int(member, "mention_count") + 1);
                    }
                }
            }
            if root {
                live.last_posts.insert(rid.clone(), post.clone());
            }
        }
        self.ingest(std::slice::from_ref(&post));
        self.write_room(&rid, root);
        let message = self.translate(&post)?;
        (!mine && fresh && message.system_type.is_none()).then_some(message)
    }

    fn viewed(&self, rids: &[String]) {
        for rid in rids {
            {
                let mut live = self.live.lock().unwrap();
                let Some(channel) = live.channels.get(rid).cloned() else { continue };
                let Some(member) = live.members.get_mut(rid) else { continue };
                member["msg_count"] = channel["total_msg_count"].clone();
                member["msg_count_root"] = channel["total_msg_count_root"].clone();
                member["mention_count"] = json!(0);
                member["last_viewed_at"] = json!(chrono::Utc::now().timestamp_millis());
            }
            self.write_room(rid, false);
        }
    }

    fn removed(&self, rid: &str) {
        {
            let mut live = self.live.lock().unwrap();
            live.channels.remove(rid);
            live.members.remove(rid);
            live.last_posts.remove(rid);
        }
        self.store.write(|w| w.delete_room(rid));
    }

    pub fn me(&self) -> &str {
        &self.me
    }

    pub fn team_of(&self, rid: &str) -> Option<String> {
        let live = self.live.lock().unwrap();
        text(live.channels.get(rid)?, "team_id").map(str::to_owned)
    }

    pub fn remember_channel(&self, channel: Value) {
        if let Some(id) = text(&channel, "id").map(str::to_owned) {
            self.live.lock().unwrap().channels.insert(id, channel);
        }
    }
}

/// `mentions` is a JSON-encoded array of user ids on Mattermost, an array on kChat.
fn mentions(raw: Option<&Value>) -> Vec<String> {
    let parsed = match raw {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        None => Value::Null,
    };
    parsed.as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sync() -> (Arc<Store>, MmSync) {
        let store = Arc::new(Store::in_memory().unwrap());
        let sync = MmSync::new(store.clone(), RestClient::mattermost("http://x".parse().unwrap()), "u-me", "me", false);
        sync.directory.remember(User { id: "u-bob".into(), username: "bob".into(), display: None });
        sync.live.lock().unwrap().channels.insert(
            "ch1".into(),
            json!({"id": "ch1", "type": "O", "name": "dev", "display_name": "Dev", "total_msg_count": 10, "total_msg_count_root": 8}),
        );
        sync.live.lock().unwrap().members.insert(
            "ch1".into(),
            json!({"channel_id": "ch1", "msg_count": 10, "msg_count_root": 8, "mention_count": 0}),
        );
        (store, sync)
    }

    fn post(id: &str, user: &str, root: &str) -> Value {
        json!({"id": id, "channel_id": "ch1", "user_id": user, "message": format!("m {id}"), "create_at": 50, "update_at": 50, "root_id": root})
    }

    #[tokio::test]
    async fn someone_elses_post_counts_unread_and_mentions() {
        let (store, sync) = sync();
        let shown = sync
            .apply_event(
                "posted",
                &json!({"post": post("p1", "u-bob", "").to_string(), "mentions": "[\"u-me\"]"}),
                &json!({}),
            )
            .await;
        assert!(shown.is_some());
        let room = store.rooms().into_iter().find(|r| r.rid == "ch1").unwrap();
        assert_eq!((room.unread, room.mentions), (1, 1));
        assert_eq!(room.last_message.as_deref(), Some("m p1"));
    }

    #[tokio::test]
    async fn my_post_and_a_view_keep_the_room_read() {
        let (store, sync) = sync();
        assert!(sync.apply_event("posted", &json!({"post": post("p1", "u-me", "")}), &json!({})).await.is_none());
        sync.apply_event("posted", &json!({"post": post("p2", "u-bob", "")}), &json!({})).await;
        sync.apply_event("multiple_channels_viewed", &json!({"channel_times": {"ch1": 1}}), &json!({})).await;
        let room = store.rooms().into_iter().find(|r| r.rid == "ch1").unwrap();
        assert_eq!(room.unread, 0);
    }

    #[tokio::test]
    async fn a_reply_adds_no_root_unread() {
        let (store, sync) = sync();
        sync.apply_event("posted", &json!({"post": post("p1", "u-me", "")}), &json!({})).await;
        sync.apply_event("posted", &json!({"post": post("p2", "u-bob", "p1")}), &json!({})).await;
        let room = store.rooms().into_iter().find(|r| r.rid == "ch1").unwrap();
        assert_eq!((room.unread, room.last_message.as_deref()), (0, Some("m p1")));
    }
}
