//! Teams into the store: the aggregator's chats and channels with their read
//! state, and each conversation's history, newest page first, older pages
//! reached through the backward link the service hands out.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use reqwest::Method;
use serde_json::Value;

use super::auth::Tokens;
use super::client::{self, Answer};
use super::translate::{self, Directory, split_id, str_of};
use crate::normalize::Message;
use crate::rest::RestError;
use crate::store::Store;
use crate::sync::{HISTORY_PAGE, HistoryPage};

const VIEW: &str = "msnp24Equivalent|supportsMessageProperties";
const OLDER_PAGES: usize = 20;
const PREVIEW_LOOKBACK: usize = 20;

/// An aggregator chat or channel, and the team (id, name) a channel belongs to.
type Entry = (Value, Option<(String, String)>);

pub struct TeamsSync {
    store: Arc<Store>,
    tokens: Arc<Tokens>,
    http: reqwest::Client,
    pub directory: Arc<Directory>,
    me: String,
    /// The backward link past the oldest page read per room, and that page's oldest instant.
    older: Mutex<HashMap<String, (String, i64)>>,
    /// The newest message id marked read per room: never marked backwards.
    marked: Mutex<HashMap<String, i64>>,
    /// Each room's aggregator entry and team, to rebuild its row when a message arrives.
    entries: Mutex<HashMap<String, Entry>>,
}

impl TeamsSync {
    pub fn new(store: Arc<Store>, tokens: Arc<Tokens>, me: &str, me_name: &str) -> Self {
        let directory = Arc::new(Directory::default());
        directory.remember(me, me_name);
        TeamsSync {
            store,
            tokens,
            http: client::http(),
            directory,
            me: me.to_owned(),
            older: Mutex::default(),
            marked: Mutex::default(),
            entries: Mutex::default(),
        }
    }

    /// The newest stored message's server id, when newer than the last one marked read.
    pub(crate) fn unmarked_newest(&self, rid: &str) -> Option<i64> {
        let newest = self
            .store
            .messages(rid, HISTORY_PAGE)
            .iter()
            .filter_map(|m| split_id(&m.id))
            .filter_map(|(_, id)| id.parse::<i64>().ok())
            .max()?;
        let marked = self.marked.lock().unwrap().get(rid).copied();
        marked.is_none_or(|before| newest > before).then_some(newest)
    }

    pub(crate) fn note_marked(&self, rid: &str, id: i64) {
        self.marked.lock().unwrap().insert(rid.to_owned(), id);
    }

    pub fn me(&self) -> &str {
        &self.me
    }

    /// A chat service call; a refused Skype token is renewed once.
    pub(crate) async fn chat(&self, method: Method, url: url::Url, body: Option<&Value>) -> Result<Answer, RestError> {
        for attempt in 0..2 {
            let (token, _) = self.tokens.chat().await?;
            let header = format!("skypetoken={}", token.as_str());
            match client::call(&self.http, method.clone(), url.clone(), ("authentication", &header), body).await {
                Err(e) if e.status == 401 && attempt == 0 => self.tokens.forget_chat().await,
                other => return other,
            }
        }
        unreachable!("the second attempt returns")
    }

    async fn chat_url(&self, segments: &[&str], query: &str) -> Result<url::Url, RestError> {
        let (_, routes) = self.tokens.chat().await?;
        client::service_url(&format!("{}/v1", routes.chat), segments, query)
    }

    pub(crate) async fn conversation_url(&self, rid: &str, tail: &[&str], query: &str) -> Result<url::Url, RestError> {
        let mut segments = vec!["users", "ME", "conversations", rid];
        segments.extend_from_slice(tail);
        self.chat_url(&segments, query).await
    }

    /// The aggregator's list of chats and teams.
    async fn snapshot(&self) -> Result<Value, RestError> {
        let (_, routes) = self.tokens.chat().await?;
        let url = client::service_url(
            &routes.aggregator,
            &["api", "v2", "teams", "users", "me"],
            "isPrefetch=false&enableMembershipSummary=true",
        )?;
        for attempt in 0..2 {
            let token = self.tokens.aggregator().await?;
            let header = format!("Bearer {}", token.as_str());
            match client::call(&self.http, Method::GET, url.clone(), ("authorization", &header), None).await {
                Err(e) if e.status == 401 && attempt == 0 => self.tokens.forget_aggregator().await,
                Err(e) => return Err(e),
                Ok(answer) => return Ok(answer.body),
            }
        }
        unreachable!("the second attempt returns")
    }

    /// Every chat and channel with its read state and last message.
    pub async fn catch_up_global(&self) -> Result<(), RestError> {
        let snapshot = self.snapshot().await?;
        let mut entries = HashMap::new();
        for chat in snapshot.get("chats").and_then(Value::as_array).into_iter().flatten() {
            if let Some(rid) = str_of(chat, "id") {
                entries.insert(rid.to_owned(), (chat.clone(), None));
            }
        }
        for team in snapshot.get("teams").and_then(Value::as_array).into_iter().flatten() {
            let (Some(id), Some(name)) = (str_of(team, "id"), str_of(team, "displayName")) else { continue };
            for channel in team.get("channels").and_then(Value::as_array).into_iter().flatten() {
                if let Some(rid) = str_of(channel, "id") {
                    entries.insert(rid.to_owned(), (channel.clone(), Some((id.to_owned(), name.to_owned()))));
                }
            }
        }
        let rows: Vec<_> = entries.values().filter_map(|(entry, team)| self.row(entry, team.as_ref())).collect();
        *self.entries.lock().unwrap() = entries;
        self.store.write(|w| {
            for (room, sub) in &rows {
                w.upsert_room(room);
                w.upsert_subscription(sub);
            }
        });
        Ok(())
    }

    fn row(
        &self,
        entry: &Value,
        team: Option<&(String, String)>,
    ) -> Option<(crate::normalize::Room, crate::normalize::Subscription)> {
        let now = chrono::Utc::now().timestamp_millis();
        let room = match team {
            Some(_) => translate::channel_room(entry, &self.directory)?,
            None => translate::chat_room(&self.me, entry, &self.directory)?,
        };
        let team = team.map(|(id, name)| (id.as_str(), name.as_str()));
        let sub = translate::subscription(&room.rid, entry, &self.me, now, team);
        Some((room, sub))
    }

    /// The room's entry updated with a newly arrived message, for its row.
    fn with_last(&self, rid: &str, resource: &Value, mine: bool) -> Option<Entry> {
        let mut entries = self.entries.lock().unwrap();
        let (entry, team) = entries.get_mut(rid)?;
        entry["lastMessage"] = serde_json::json!({
            "messageType": resource.get("messagetype"), "content": resource.get("content"),
            "from": resource.get("from"), "imDisplayName": resource.get("imdisplayname"),
            "composeTime": resource.get("composetime").or(resource.get("originalarrivaltime")),
            "id": resource.get("id"),
        });
        for key in ["isRead", "isMessageRead", "isLastMessageFromMe"] {
            entry[key] = Value::Bool(mine);
        }
        Some((entry.clone(), team.clone()))
    }

    /// Whether a message is the one its room's entry previews.
    fn is_preview(&self, rid: &str, resource: &Value) -> bool {
        let entries = self.entries.lock().unwrap();
        let shown =
            entries.get(rid).and_then(|(entry, _)| entry.get("lastMessage")).and_then(|l| translate::int_of(l, "id"));
        shown.is_some() && shown == translate::int_of(resource, "id")
    }

    /// The room's entry previewing `resource` instead (an empty text for none), at the time it showed.
    fn with_preview(&self, rid: &str, resource: Option<&Value>) -> Option<Entry> {
        let mut entries = self.entries.lock().unwrap();
        let (entry, team) = entries.get_mut(rid)?;
        let at = entry.pointer("/lastMessage/composeTime").cloned().unwrap_or(Value::Null);
        entry["lastMessage"] = match resource {
            Some(r) => serde_json::json!({
                "messageType": r.get("messagetype"), "content": r.get("content"),
                "from": r.get("from"), "imDisplayName": r.get("imdisplayname"),
                "composeTime": at, "id": r.get("id"),
            }),
            None => serde_json::json!({ "messageType": "Text", "content": "", "composeTime": at }),
        };
        Some((entry.clone(), team.clone()))
    }

    /// The room's preview after its message was deleted: the newest message left in the room itself.
    async fn preview_after_delete(&self, rid: &str) -> Option<Entry> {
        let query = format!("view={VIEW}&pageSize={PREVIEW_LOOKBACK}");
        let (messages, _) = self.page(self.conversation_url(rid, &["messages"], &query).await.ok()?).await.ok()?;
        let next = messages.iter().find(|m| {
            !translate::deleted(m)
                && matches!(str_of(m, "messagetype"), Some("Text" | "RichText/Html" | "RichText"))
                && translate::message(rid, m, &self.directory).is_some_and(|x| x.thread_id.is_none())
        });
        self.with_preview(rid, next)
    }

    /// A pushed chat event into the store; a new message from someone else
    /// is answered, for a notification.
    pub async fn apply_event(&self, name: &str, resource: &Value) -> Option<Message> {
        let rid = translate::conversation_of(resource)?;
        let known = self.entries.lock().unwrap().contains_key(&rid);
        match name {
            "NewMessage" | "MessageUpdate" => {}
            "ConversationUpdate" | "ThreadUpdate" => {
                if !known {
                    let _ = self.catch_up_global().await;
                }
                return None;
            }
            _ => return None,
        }
        if translate::deleted(resource) {
            if let Some(id) = str_of(resource, "id") {
                self.store.write(|w| w.delete_message(&translate::message_id(&rid, id)));
            }
            if self.is_preview(&rid, resource)
                && let Some((entry, team)) = self.preview_after_delete(&rid).await
                && let Some((room, _)) = self.row(&entry, team.as_ref())
            {
                self.store.write(|w| w.upsert_room(&room));
            }
            return None;
        }
        let message = translate::message(&rid, resource, &self.directory)?;
        let fresh = name == "NewMessage" && !self.store.has_message(&message.id);
        let mine = message.author_id == self.me;
        if !known {
            let _ = self.catch_up_global().await;
        }
        let updated = (fresh && message.thread_id.is_none()).then(|| self.with_last(&rid, resource, mine)).flatten();
        let row = updated.and_then(|(entry, team)| self.row(&entry, team.as_ref()));
        let edited = (!fresh && self.is_preview(&rid, resource))
            .then(|| self.with_preview(&rid, Some(resource)))
            .flatten()
            .and_then(|(entry, team)| self.row(&entry, team.as_ref()));
        self.store.write(|w| {
            w.upsert_message(&message);
            if let Some((room, sub)) = &row {
                w.upsert_room(room);
                w.upsert_subscription(sub);
            }
            if let Some((room, _)) = &edited {
                w.upsert_room(room);
            }
        });
        (fresh && !mine).then_some(message)
    }

    /// Forgets the rooms the list no longer has.
    pub async fn reconcile_rooms(&self) -> Result<(), RestError> {
        let snapshot = self.snapshot().await?;
        let chats = snapshot.get("chats").and_then(Value::as_array).into_iter().flatten();
        let channels = snapshot
            .get("teams")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|t| t.get("channels").and_then(Value::as_array).into_iter().flatten());
        let live: Vec<String> = chats.chain(channels).filter_map(|e| str_of(e, "id").map(str::to_owned)).collect();
        if !live.is_empty() {
            self.store.write(|w| w.purge_rooms_except(&live));
        }
        Ok(())
    }

    /// A channel thread's root and its replies, from the thread-scoped
    /// conversation (`<rid>;messageid=<root>`), stored as they come. The
    /// replies carry their own thread link, so they land under the root.
    /// Presence for a batch of people (UPS getpresence), best effort.
    pub async fn get_presence(&self, mris: &[String]) -> Vec<(String, crate::live::Presence)> {
        if mris.is_empty() {
            return Vec::new();
        }
        let Ok((_, routes)) = self.tokens.chat().await else { return Vec::new() };
        if routes.presence.is_empty() {
            return Vec::new();
        }
        let Ok(url) = url::Url::parse(&format!("{}/v1/presence/getpresence/", routes.presence)) else {
            return Vec::new();
        };
        let Ok(token) = self.tokens.presence().await else { return Vec::new() };
        let header = format!("Bearer {}", token.as_str());
        let body = Value::Array(mris.iter().map(|m| serde_json::json!({ "mri": m })).collect());
        match client::call(&self.http, Method::POST, url, ("authorization", &header), Some(&body)).await {
            Ok(answer) => presence_rows(&answer.body),
            Err(_) => Vec::new(),
        }
    }

    /// Sets my availability (UPS forceavailability), with the presence bearer.
    pub async fn set_presence(&self, availability: &str) -> Result<(), RestError> {
        let (_, routes) = self.tokens.chat().await?;
        if routes.presence.is_empty() {
            return Ok(());
        }
        let url = url::Url::parse(&format!("{}/v1/me/forceavailability/", routes.presence))
            .map_err(|_| crate::teams::auth::refusal("presence_url", 0))?;
        let token = self.tokens.presence().await?;
        let header = format!("Bearer {}", token.as_str());
        let body = serde_json::json!({ "availability": availability });
        client::call(&self.http, Method::PUT, url, ("authorization", &header), Some(&body)).await?;
        Ok(())
    }

    /// Short profiles (name, title) by MRI, via the middle tier with the Spaces
    /// bearer. Best effort: [] when the route or token is absent.
    async fn profiles(&self, mris: &[String]) -> Vec<Value> {
        if mris.is_empty() {
            return Vec::new();
        }
        let Ok((_, routes)) = self.tokens.chat().await else { return Vec::new() };
        if routes.middle_tier.is_empty() {
            return Vec::new();
        }
        let Ok(bearer) = self.tokens.spaces().await else { return Vec::new() };
        let target = format!(
            "{}/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&canBeSmtpAddress=false&skypeTeamsInfo=true",
            routes.middle_tier
        );
        let Ok(url) = url::Url::parse(&target) else { return Vec::new() };
        let body = Value::Array(mris.iter().map(|m| Value::String(m.clone())).collect());
        let header = format!("Bearer {}", bearer.as_str());
        match client::call(&self.http, Method::POST, url, ("authorization", &header), Some(&body)).await {
            Ok(answer) => profile_rows(answer.body),
            Err(_) => Vec::new(),
        }
    }

    /// The profile card for an MRI. A refused or empty call degrades to the name
    /// already learned from messages, so the card shows a name, not an MRI.
    pub async fn profile(&self, key: &str, _by_id: bool) -> Result<crate::info::Profile, RestError> {
        let mri = if key.contains(':') {
            key.to_owned()
        } else {
            self.directory.mri_for(key).unwrap_or_else(|| key.to_owned())
        };
        let rows = self.profiles(std::slice::from_ref(&mri)).await;
        let row = rows
            .iter()
            .find(|r| str_of(r, "mri").is_some_and(|m| m.eq_ignore_ascii_case(&mri)))
            .or_else(|| rows.first());
        Ok(profile_fields(&mri, row, &self.directory))
    }

    /// Room information: name and kind from the store, enriched with the chat
    /// service's topic. The live conversation shape (probed 2026-10-22) carries a
    /// real `threadProperties.topic` but no description or member count; those are
    /// left for the members list. A refused call still returns the name and kind.
    pub async fn room_info(&self, rid: &str) -> Result<crate::info::RoomInfo, RestError> {
        let (name, kind) =
            self.store.room_name(rid).ok_or_else(|| crate::rest::RestError::incomplete("room info: unknown room"))?;
        let topic = self.conversation(rid).await.as_ref().and_then(conversation_topic);
        Ok(crate::info::RoomInfo {
            id: rid.to_owned(),
            name,
            kind,
            topic,
            announcement: None,
            description: None,
            members: None,
            read_only: false,
            encrypted: false,
            archived: false,
            default: false,
        })
    }

    /// The chat service's conversation document, best effort.
    async fn conversation(&self, rid: &str) -> Option<Value> {
        let url = self.conversation_url(rid, &[], "view=msnp24Equivalent").await.ok()?;
        self.chat(Method::GET, url, None).await.ok().map(|a| a.body)
    }

    /// Messages in one room matching `text`, through the Substrate search API.
    /// Substrate indexes Teams messages from Exchange, so a hit carries the
    /// conversation id, author display name, preview and time but no
    /// chat-service message id: the results open the room, they do not jump to
    /// the exact message, and the id is synthetic.
    pub async fn search(&self, rid: &str, text: &str) -> Result<Vec<Message>, RestError> {
        let token = self.tokens.substrate().await?;
        let header = format!("Bearer {}", token.as_str());
        let url = url::Url::parse("https://substrate.office.com/search/api/v2/query")
            .map_err(|_| crate::teams::auth::refusal("substrate_url", 0))?;
        let mut cvid = [0u8; 16];
        getrandom::fill(&mut cvid).ok();
        let cvid: String = cvid.iter().map(|b| format!("{b:02x}")).collect();
        let body = serde_json::json!({
            "Cvid": cvid,
            "Scenario": { "Name": "teamsmessages" },
            "EntityRequests": [{
                "EntityType": "Message",
                "ContentSources": ["Teams"],
                "Query": { "QueryString": text },
                "Size": 50,
            }],
        });
        let answer = client::call(&self.http, Method::POST, url, ("authorization", &header), Some(&body)).await?;
        Ok(search_hits(&answer.body, rid, &self.directory))
    }

    pub async fn load_thread(&self, root_id: &str) -> Result<(), RestError> {
        let Some((rid, server)) = split_id(root_id) else { return Ok(()) };
        if let Some(root) = self.fetch_message(root_id).await? {
            self.store.write(|w| w.upsert_message(&root));
        }
        let target = format!("{rid};messageid={server}");
        let query = format!("view={VIEW}&pageSize={HISTORY_PAGE}");
        let url = self.conversation_url(&target, &["messages"], &query).await?;
        let (rows, _older) = self.page(url).await?;
        self.ingest(rid, &rows);
        Ok(())
    }

    fn ingest(&self, rid: &str, raw: &[Value]) -> Vec<Message> {
        let mut gone = Vec::new();
        let rows: Vec<Message> = raw
            .iter()
            .filter_map(|m| {
                if translate::deleted(m) {
                    gone.extend(str_of(m, "id").map(|id| translate::message_id(rid, id)));
                }
                translate::message(rid, m, &self.directory)
            })
            .collect();
        self.store.write(|w| {
            rows.iter().for_each(|m| w.upsert_message(m));
            gone.iter().for_each(|id| w.delete_message(id));
        });
        rows
    }

    /// One history page, newest first, and the link to the page before it.
    async fn page(&self, url: url::Url) -> Result<(Vec<Value>, Option<String>), RestError> {
        let body = self.chat(Method::GET, url, None).await?.body;
        let messages = body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        let older = body.pointer("/_metadata/backwardLink").and_then(Value::as_str).map(str::to_owned);
        Ok((messages, older))
    }

    /// A backward link is followed only on the chat service's own host.
    async fn trusted(&self, link: &str) -> Option<url::Url> {
        let (_, routes) = self.tokens.chat().await.ok()?;
        let url = url::Url::parse(link).ok()?;
        let base = url::Url::parse(&routes.chat).ok()?;
        (url.scheme() == base.scheme()
            && url.host_str() == base.host_str()
            && url.port() == base.port()
            && url.path().starts_with(base.path()))
        .then_some(url)
    }

    fn remember_older(&self, rid: &str, messages: &[Value], link: Option<String>) {
        let oldest = messages.iter().filter_map(|m| translate::int_of(m, "id")).min();
        let mut older = self.older.lock().unwrap();
        match (link, oldest) {
            (Some(link), Some(at)) => _ = older.insert(rid.to_owned(), (link, at)),
            (None, Some(_)) => _ = older.remove(rid),
            _ => {}
        }
    }

    /// The newest page, or the page before `latest`, walking back from the
    /// last link kept for the room or from the newest page.
    pub async fn load_history(&self, rid: &str, latest: Option<i64>) -> Result<HistoryPage, RestError> {
        let query = format!("view={VIEW}&pageSize={HISTORY_PAGE}");
        let kept = self.older.lock().unwrap().get(rid).cloned();
        let mut next = match (latest, kept) {
            (Some(bound), Some((link, oldest))) if oldest <= bound => self.trusted(&link).await,
            _ => None,
        };
        let mut url = match next.take() {
            Some(url) => url,
            None => self.conversation_url(rid, &["messages"], &query).await?,
        };
        for _ in 0..OLDER_PAGES {
            let (messages, link) = self.page(url).await?;
            let below: Vec<Value> = match latest {
                Some(bound) => messages
                    .iter()
                    .filter(|m| translate::int_of(m, "id").is_some_and(|id| id < bound))
                    .cloned()
                    .collect(),
                None => messages.clone(),
            };
            self.remember_older(rid, &messages, link.clone());
            let follow = match &link {
                Some(link) if below.is_empty() && !messages.is_empty() => self.trusted(link).await,
                _ => None,
            };
            if let Some(older) = follow {
                url = older;
                continue;
            }
            let rows = self.ingest(rid, &below);
            return Ok(HistoryPage { count: below.len(), oldest_ts: rows.iter().map(|m| m.ts).min() });
        }
        Ok(HistoryPage { count: 0, oldest_ts: None })
    }

    /// What arrived since the room's newest stored message; a full page
    /// means more came, and the newest page replaces the stored ones.
    pub async fn catch_up_room(&self, rid: &str) -> Result<(), RestError> {
        let stored = self.store.messages(rid, HISTORY_PAGE);
        let Some(since) =
            stored.iter().filter_map(|m| split_id(&m.id)).filter_map(|(_, id)| id.parse::<i64>().ok()).max()
        else {
            return Ok(());
        };
        let query = format!("view={VIEW}&pageSize={HISTORY_PAGE}&startTime={since}");
        let (messages, _) = self.page(self.conversation_url(rid, &["messages"], &query).await?).await?;
        if (messages.len() as i64) < HISTORY_PAGE {
            self.ingest(rid, &messages);
            return Ok(());
        }
        let query = format!("view={VIEW}&pageSize={HISTORY_PAGE}");
        let (newest, link) = self.page(self.conversation_url(rid, &["messages"], &query).await?).await?;
        let rows: Vec<Message> = newest.iter().filter_map(|m| translate::message(rid, m, &self.directory)).collect();
        self.store.write(|w| {
            w.clear_room_messages(rid);
            rows.iter().for_each(|m| w.upsert_message(m));
        });
        self.remember_older(rid, &newest, link);
        Ok(())
    }

    /// The service's copy of one message, not stored.
    pub async fn fetch_message(&self, id: &str) -> Result<Option<Message>, RestError> {
        let Some((rid, server)) = split_id(id) else { return Ok(None) };
        let url = self.conversation_url(rid, &["messages", server], &format!("view={VIEW}")).await?;
        match self.chat(Method::GET, url, None).await {
            Ok(answer) => Ok(translate::message(rid, &answer.body, &self.directory)),
            Err(e) if e.status == 404 => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Stores one message the live feed or a send answered with.
    pub fn ingest_one(&self, rid: &str, raw: &Value) -> Option<Message> {
        self.ingest(rid, std::slice::from_ref(raw)).into_iter().next()
    }
}

/// (mri, presence) rows from a getpresence response (array or {responses:[]}).
fn presence_rows(body: &Value) -> Vec<(String, crate::live::Presence)> {
    let rows = body
        .as_array()
        .cloned()
        .or_else(|| body.get("responses").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    rows.iter()
        .filter_map(|r| {
            let mri = r.get("mri").and_then(Value::as_str)?.to_owned();
            let availability =
                r.get("presence").and_then(|p| p.get("availability")).and_then(Value::as_str).unwrap_or("Offline");
            Some((mri, crate::teams::actions::availability_presence(availability)))
        })
        .collect()
}

/// The `value[]` rows of a `fetchShortProfile` body, whether the body is the
/// array itself or wraps it under `value`.
fn profile_rows(body: Value) -> Vec<Value> {
    if let Value::Array(rows) = body {
        return rows;
    }
    body.get("value").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// A short profile row as the card's fields, degrading to the directory name.
fn profile_fields(mri: &str, row: Option<&Value>, directory: &Directory) -> crate::info::Profile {
    let name = row.and_then(|r| str_of(r, "displayName")).map(str::to_owned).or_else(|| directory.name(mri));
    if let Some(name) = &name {
        directory.remember(mri, name);
    }
    let username = row
        .and_then(|r| str_of(r, "userPrincipalName").or_else(|| str_of(r, "email")))
        .map(str::to_owned)
        .unwrap_or_else(|| mri.to_owned());
    let bio = row.and_then(|r| str_of(r, "jobTitle")).filter(|t| !t.is_empty()).map(str::to_owned);
    crate::info::Profile {
        id: mri.to_owned(),
        username,
        name,
        presence: None,
        status_text: None,
        roles: Vec::new(),
        utc_offset: None,
        bio,
        avatar_etag: None,
        bot: mri.starts_with("28:"),
        bot_owner: None,
    }
}

/// The `threadProperties.topic` of a chat-service conversation, when set.
fn conversation_topic(body: &Value) -> Option<String> {
    body.get("threadProperties").and_then(|p| str_of(p, "topic")).filter(|t| !t.is_empty()).map(str::to_owned)
}

/// Substrate search hits for one room as messages. Keeps only hits whose
/// conversation is `rid`; the id is synthetic (the Exchange item id, prefixed
/// so it never collides with a real `rid/<number>` message), the author id is
/// resolved from the display name when the directory knows it.
fn search_hits(body: &Value, rid: &str, directory: &Directory) -> Vec<Message> {
    let results = body
        .get("EntitySets")
        .and_then(Value::as_array)
        .and_then(|s| s.first())
        .and_then(|e| e.get("ResultSets"))
        .and_then(Value::as_array)
        .and_then(|r| r.first())
        .and_then(|rs| rs.get("Results"))
        .and_then(Value::as_array);
    let Some(results) = results else { return Vec::new() };
    results
        .iter()
        .filter_map(|hit| {
            let source = hit.get("Source")?;
            let here =
                str_of(source, "ClientConversationId") == Some(rid) || str_of(source, "ClientThreadId") == Some(rid);
            if !here {
                return None;
            }
            let ts = chrono::DateTime::parse_from_rfc3339(str_of(source, "DateTimeSent")?).ok()?.timestamp_millis();
            let name = source
                .get("From")
                .and_then(|from| from.get("EmailAddress"))
                .and_then(|email| str_of(email, "Name"))
                .map(str::to_owned);
            let author_id = name.as_deref().and_then(|n| directory.mri_for(n)).unwrap_or_default();
            let item = str_of(source, "ImmutableId")
                .or_else(|| str_of(source, "ItemId"))
                .or_else(|| str_of(source, "Id"))
                .unwrap_or("hit");
            Some(Message {
                id: format!("{rid}/search:{item}"),
                rid: rid.to_owned(),
                text: str_of(source, "Preview").map(str::to_owned),
                ts,
                author_id,
                author_name: name,
                updated_at: ts,
                ..Default::default()
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_rows_read_an_array_or_a_value_wrapper() {
        let bare = serde_json::json!([{ "mri": "8:a" }]);
        assert_eq!(profile_rows(bare).len(), 1);
        let wrapped = serde_json::json!({ "value": [{ "mri": "8:a" }, { "mri": "8:b" }] });
        assert_eq!(profile_rows(wrapped).len(), 2);
        assert!(profile_rows(serde_json::json!({})).is_empty());
    }

    #[test]
    fn a_short_profile_becomes_the_card_and_degrades_to_the_learned_name() {
        let dir = Directory::default();
        let mri = "8:orgid:aaaa";
        dir.remember(mri, "Known Name");
        let row = serde_json::json!({ "mri": mri, "displayName": "Ada Lovelace", "userPrincipalName": "ada@contoso.com", "jobTitle": "Engineer" });
        let full = profile_fields(mri, Some(&row), &dir);
        assert_eq!(full.id, mri);
        assert_eq!(full.username, "ada@contoso.com");
        assert_eq!(full.name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(full.bio.as_deref(), Some("Engineer"));
        assert!(!full.bot);
        let degraded = profile_fields(mri, None, &dir);
        assert_eq!(degraded.name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(degraded.username, mri);
        assert!(degraded.bio.is_none());
        let bot = profile_fields("28:orgid:app", Some(&serde_json::json!({ "displayName": "Helper" })), &dir);
        assert!(bot.bot);
    }

    #[test]
    fn a_display_name_resolves_to_its_mri_only_when_unambiguous() {
        let dir = Directory::default();
        dir.remember("8:one", "Alice");
        assert_eq!(dir.mri_for("Alice").as_deref(), Some("8:one"));
        dir.remember("8:two", "Alice");
        assert!(dir.mri_for("Alice").is_none());
        assert!(dir.mri_for("Nobody").is_none());
    }

    #[test]
    fn conversation_topic_reads_thread_properties() {
        let with_topic = serde_json::json!({ "threadProperties": { "topic": "Launch", "rosterVersion": "9" } });
        assert_eq!(conversation_topic(&with_topic).as_deref(), Some("Launch"));
        assert_eq!(conversation_topic(&serde_json::json!({ "threadProperties": { "topic": "" } })), None);
        assert_eq!(conversation_topic(&serde_json::json!({})), None);
    }

    #[test]
    fn search_hits_keep_the_room_and_map_the_source() {
        let dir = Directory::default();
        dir.remember("8:orgid:aaaa", "Ada Lovelace");
        let body = serde_json::json!({
            "EntitySets": [{ "ResultSets": [{ "Results": [
                { "Source": {
                    "ClientConversationId": "19:room@thread.tacv2",
                    "ClientThreadId": "19:room@thread.tacv2",
                    "Preview": "found this",
                    "DateTimeSent": "2026-10-22T08:01:52Z",
                    "ImmutableId": "AAItem1",
                    "From": { "EmailAddress": { "Name": "Ada Lovelace" } },
                } },
                { "Source": {
                    "ClientConversationId": "19:other@thread.tacv2",
                    "Preview": "not this room",
                    "DateTimeSent": "2026-10-22T09:00:00Z",
                    "From": { "EmailAddress": { "Name": "Someone Else" } },
                } },
            ] }] }],
        });
        let hits = search_hits(&body, "19:room@thread.tacv2", &dir);
        assert_eq!(hits.len(), 1);
        let hit = &hits[0];
        assert_eq!(hit.rid, "19:room@thread.tacv2");
        assert_eq!(hit.text.as_deref(), Some("found this"));
        assert_eq!(hit.author_name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(hit.author_id, "8:orgid:aaaa");
        assert_eq!(hit.id, "19:room@thread.tacv2/search:AAItem1");
        assert!(hit.ts > 0);
        assert!(search_hits(&serde_json::json!({}), "19:room@thread.tacv2", &dir).is_empty());
    }
}
