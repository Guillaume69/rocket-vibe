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

pub struct TeamsSync {
    store: Arc<Store>,
    tokens: Arc<Tokens>,
    http: reqwest::Client,
    pub directory: Arc<Directory>,
    me: String,
    /// The backward link past the oldest page read per room, and that page's oldest instant.
    older: Mutex<HashMap<String, (String, i64)>>,
}

impl TeamsSync {
    pub fn new(store: Arc<Store>, tokens: Arc<Tokens>, me: &str, me_name: &str) -> Self {
        let directory = Arc::new(Directory::default());
        directory.remember(me, me_name);
        TeamsSync { store, tokens, http: client::http(), directory, me: me.to_owned(), older: Mutex::default() }
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
        let now = chrono::Utc::now().timestamp_millis();
        let mut rows = Vec::new();
        for chat in snapshot.get("chats").and_then(Value::as_array).into_iter().flatten() {
            if let Some(room) = translate::chat_room(&self.me, chat, &self.directory) {
                let sub = translate::subscription(&room.rid, chat, &self.me, now, None);
                rows.push((room, sub));
            }
        }
        for team in snapshot.get("teams").and_then(Value::as_array).into_iter().flatten() {
            let (Some(id), Some(name)) = (str_of(team, "id"), str_of(team, "displayName")) else { continue };
            for channel in team.get("channels").and_then(Value::as_array).into_iter().flatten() {
                if let Some(room) = translate::channel_room(channel, &self.directory) {
                    let sub = translate::subscription(&room.rid, channel, &self.me, now, Some((id, name)));
                    rows.push((room, sub));
                }
            }
        }
        self.store.write(|w| {
            for (room, sub) in &rows {
                w.upsert_room(room);
                w.upsert_subscription(sub);
            }
        });
        Ok(())
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
