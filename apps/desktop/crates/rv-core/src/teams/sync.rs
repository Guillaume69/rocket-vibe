//! Teams into the store: the aggregator's chats and channels with their read
//! state, and each conversation's history, newest page first, older pages
//! reached through the backward link the service hands out.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::auth::Tokens;
use super::translate::{self, Directory, split_id, str_of};
use crate::normalize::Message;
use crate::rest::RestError;
use crate::store::Store;
use crate::sync::{HISTORY_PAGE, HistoryPage};
use rv_teams::service::{self, FilesHome, Service, VIEW};

const PINNED_LOOKBACK: i64 = 200;
const OLDER_PAGES: usize = 20;
const PREVIEW_LOOKBACK: usize = 20;

/// An aggregator chat or channel, and the team (id, name) a channel belongs to.
type Entry = (Value, Option<(String, String)>);

pub use rv_teams::service::FileRef;

pub struct TeamsSync {
    store: Arc<Store>,
    pub service: Service,
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
            service: Service::new(tokens, me, directory.clone()),
            directory,
            me: me.to_owned(),
            older: Mutex::default(),
            marked: Mutex::default(),
            entries: Mutex::default(),
        }
    }

    /// The newest message id of the room, stored or listed by the aggregator,
    /// when newer than the last one marked read. The listed one counts the
    /// events the store never keeps, which a horizon must still pass.
    pub(crate) fn unmarked_newest(&self, rid: &str) -> Option<i64> {
        let stored = self
            .store
            .messages(rid, HISTORY_PAGE)
            .iter()
            .filter_map(|m| split_id(&m.id))
            .filter_map(|(_, id)| id.parse::<i64>().ok())
            .max();
        let listed = self.entries.lock().unwrap().get(rid).and_then(|(entry, _)| translate::last_id(entry));
        let newest = stored.max(listed)?;
        let marked = self.marked.lock().unwrap().get(rid).copied();
        marked.is_none_or(|before| newest > before).then_some(newest)
    }

    /// Notes the room read up to `id`, its row read at once.
    pub(crate) fn note_marked(&self, rid: &str, id: i64) {
        self.marked.lock().unwrap().insert(rid.to_owned(), id);
        let read = self.entries.lock().unwrap().get_mut(rid).map(|(entry, team)| {
            translate::read_up_to(entry, id);
            (entry.clone(), team.clone())
        });
        if let Some((_, sub)) = read.and_then(|(entry, team)| self.row(&entry, team.as_ref())) {
            self.store.write(|w| w.upsert_subscription(&sub));
        }
    }

    pub fn me(&self) -> &str {
        &self.me
    }

    /// An image on Teams' object store, with the skype token.
    pub async fn fetch_image(&self, url: &str) -> Result<(Vec<u8>, String), RestError> {
        self.service.fetch_image(url).await
    }

    /// The parent team id of a channel room, if known; None for a chat (no team).
    pub(crate) fn team_of(&self, rid: &str) -> Option<String> {
        self.entries.lock().unwrap().get(rid).and_then(|(_, team)| team.as_ref()).map(|(id, _)| id.clone())
    }

    /// Where a room's files go: its team's Graph group when the aggregator
    /// named it (a channel), or my OneDrive (a chat).
    fn files_home(&self, rid: &str) -> (bool, Option<String>) {
        let entries = self.entries.lock().unwrap();
        match entries.get(rid) {
            Some((entry, Some(_))) => (true, str_of(entry, "groupId").map(str::to_owned)),
            _ => (false, None),
        }
    }

    /// The Graph group of a channel's team, as the aggregator named it.
    fn known_group(&self, channel: &str) -> Option<String> {
        self.entries
            .lock()
            .unwrap()
            .get(channel)
            .and_then(|(entry, team)| team.as_ref().and_then(|_| str_of(entry, "groupId")).map(str::to_owned))
    }

    /// Every chat and channel with its read state and last message.
    pub async fn catch_up_global(&self) -> Result<(), RestError> {
        let snapshot = self.service.snapshot().await?;
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
            Some((_, name)) => translate::channel_room(entry, Some(name), &self.directory)?,
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
        let (messages, _) = self.service.messages(rid, &query).await.ok()?;
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
        let snapshot = self.service.snapshot().await?;
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

    /// Presence for a batch of people (UPS getpresence), best effort.
    pub async fn get_presence(&self, mris: &[String]) -> Vec<(String, crate::live::Presence)> {
        self.service.get_presence(mris).await
    }

    /// Sets my availability (UPS forceavailability).
    pub async fn set_presence(&self, availability: &str) -> Result<(), RestError> {
        self.service.set_presence(availability).await
    }

    /// The profile card for an MRI. A refused or empty call degrades to the name
    /// already learned from messages, so the card shows a name, not an MRI.
    pub async fn profile(&self, key: &str, _by_id: bool) -> Result<crate::info::Profile, RestError> {
        let mri = if key.contains(':') {
            key.to_owned()
        } else {
            self.directory.mri_for(key).unwrap_or_else(|| key.to_owned())
        };
        let rows = self.service.profiles(std::slice::from_ref(&mri)).await;
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
        let (shown, kind) =
            self.store.room_name(rid).ok_or_else(|| crate::rest::RestError::incomplete("room info: unknown room"))?;
        let own = self
            .entries
            .lock()
            .unwrap()
            .get(rid)
            .and_then(|(entry, team)| team.as_ref().map(|_| translate::channel_name(entry)));
        let name = own.unwrap_or(shown);
        let topic = self.service.conversation(rid).await.as_ref().and_then(service::conversation_topic);
        let members = self.members(rid).await.ok().map(|p| i64::from(p.total));
        Ok(crate::info::RoomInfo {
            id: rid.to_owned(),
            name,
            kind,
            topic,
            announcement: None,
            description: None,
            members,
            read_only: false,
            encrypted: false,
            archived: false,
            default: false,
        })
    }

    /// Messages in one room matching `text`, through Substrate search.
    pub async fn search(&self, rid: &str, text: &str) -> Result<Vec<Message>, RestError> {
        self.service.search(rid, text).await
    }

    /// Download a Teams shared file through Graph, streamed to `dest`.
    pub async fn download_file(
        &self,
        url: &str,
        dest: &std::path::Path,
        progress: impl Fn(u64) + Send,
    ) -> Result<(), RestError> {
        self.service.download_file(url, dest, progress).await
    }

    /// The conversation's page in Teams' web app, which a call window opens to
    /// start or join its call: a channel's needs its team's Graph group id, a
    /// chat's only the tenant.
    pub async fn call_url(&self, rid: &str, tenant: &str) -> Result<String, RestError> {
        let channel =
            self.entries.lock().unwrap().get(rid).and_then(|(entry, team)| {
                team.as_ref().map(|_| str_of(entry, "displayName").unwrap_or(rid).to_owned())
            });
        match channel {
            Some(name) => {
                let group = self.service.parent_team(rid, self.known_group(rid).as_deref()).await?;
                Ok(translate::channel_link(rid, &name, &group, tenant))
            }
            None => Ok(translate::chat_link(rid, tenant)),
        }
    }

    /// Where a call card's Join goes: a channel call's own join page, built from
    /// its start message's author as organizer; otherwise the conversation's page.
    pub async fn join_url(&self, call_id: &str, tenant: &str) -> Result<String, RestError> {
        let Some((rid, server)) = translate::split_id(call_id) else { return self.call_url(call_id, tenant).await };
        if self.team_of(rid).is_none() {
            return self.call_url(rid, tenant).await;
        }
        match self.service.call_organizer(rid, server).await? {
            Some(oid) => Ok(translate::meetup_link(rid, server, tenant, &oid)),
            None => self.call_url(rid, tenant).await,
        }
    }

    /// Whether a room is a channel Teams lets me rename here: one whose
    /// aggregator entry names its team's group and its own Substrate group.
    pub fn renamable(&self, rid: &str) -> bool {
        self.entries.lock().unwrap().get(rid).is_some_and(|(entry, team)| {
            team.is_some() && str_of(entry, "groupId").is_some() && str_of(entry, "substrateGroupId").is_some()
        })
    }

    /// Renames a channel as Teams' web app does: its templates service,
    /// addressed by the team's Graph group and the channel's Substrate group.
    pub async fn rename(&self, rid: &str, name: &str, tenant: &str) -> Result<(), RestError> {
        let ids = self.entries.lock().unwrap().get(rid).and_then(|(entry, _)| {
            Some((str_of(entry, "groupId")?.to_owned(), str_of(entry, "substrateGroupId")?.to_owned()))
        });
        let Some((group, oid)) = ids else { return Err(crate::teams::auth::refusal("teams_team_not_found", 0)) };
        self.service.rename(&group, &oid, tenant, name).await?;
        if let Some((entry, _)) = self.entries.lock().unwrap().get_mut(rid) {
            entry["displayName"] = Value::from(name);
        }
        Ok(())
    }

    /// Uploads `bytes` into a room's files folder, answering the stored file
    /// as the chat message needs it.
    pub async fn upload_file(&self, rid: &str, name: &str, mime: &str, bytes: Vec<u8>) -> Result<FileRef, RestError> {
        let (channel, group) = self.files_home(rid);
        let home = if channel { FilesHome::Channel { group: group.as_deref() } } else { FilesHome::Chat };
        self.service.upload_file(rid, &home, name, mime, bytes).await
    }

    /// The stored file's message fields, re-read for its SharePoint ids.
    pub async fn file_ref(&self, rid: &str, item_id: &str) -> Result<FileRef, RestError> {
        let (channel, group) = self.files_home(rid);
        let home = if channel { FilesHome::Channel { group: group.as_deref() } } else { FilesHome::Chat };
        self.service.file_ref(rid, &home, item_id).await
    }

    /// The room's roster, from the threads service (`GET /v1/threads/<rid>`);
    /// each member is `{id: <mri>, role}`. Read-only: Teams gives no add, remove
    /// or role-change route here, so no rights travel with it.
    pub async fn members(&self, rid: &str) -> Result<crate::members::MemberPage, RestError> {
        Ok(roster_page(&self.service.roster(rid).await?, &self.directory))
    }

    pub async fn load_thread(&self, root_id: &str) -> Result<(), RestError> {
        let Some((rid, server)) = split_id(root_id) else { return Ok(()) };
        if let Some(root) = self.fetch_message(root_id).await? {
            self.store.write(|w| w.upsert_message(&root));
        }
        let target = format!("{rid};messageid={server}");
        let (rows, _older) = self.service.messages(&target, &format!("view={VIEW}&pageSize={HISTORY_PAGE}")).await?;
        self.ingest(rid, &rows);
        Ok(())
    }

    /// A room's pinned messages among its newest `PINNED_LOOKBACK`, newest
    /// first: Teams has no list of them, its web app filters the messages it
    /// holds on `properties.pinned` (seen in a capture, 2026-10-23).
    pub async fn pinned(&self, rid: &str) -> Result<Vec<String>, RestError> {
        let (rows, _older) = self.service.messages(rid, &format!("view={VIEW}&pageSize={PINNED_LOOKBACK}")).await?;
        let mut pinned: Vec<Message> = self.ingest(rid, &rows).into_iter().filter(|m| m.pinned).collect();
        pinned.sort_by_key(|m| std::cmp::Reverse(m.ts));
        Ok(pinned.into_iter().map(|m| m.id).collect())
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
            (Some(bound), Some((link, oldest))) if oldest <= bound => self.service.trusted(&link).await,
            _ => None,
        };
        let mut url = match next.take() {
            Some(url) => url,
            None => self.service.conversation_url(rid, &["messages"], &query).await?,
        };
        for _ in 0..OLDER_PAGES {
            let (messages, link) = self.service.page(url).await?;
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
                Some(link) if below.is_empty() && !messages.is_empty() => self.service.trusted(link).await,
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
        let (messages, _) = self.service.messages(rid, &query).await?;
        if (messages.len() as i64) < HISTORY_PAGE {
            self.ingest(rid, &messages);
            return Ok(());
        }
        let query = format!("view={VIEW}&pageSize={HISTORY_PAGE}");
        let (newest, link) = self.service.messages(rid, &query).await?;
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
        Ok(self.service.message(id).await?.and_then(|(rid, raw)| translate::message(&rid, &raw, &self.directory)))
    }

    /// Stores one message the live feed or a send answered with.
    pub fn ingest_one(&self, rid: &str, raw: &Value) -> Option<Message> {
        self.ingest(rid, std::slice::from_ref(raw)).into_iter().next()
    }
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

/// A threads-service roster as a member page: each row is `{id: <mri>, role}`,
/// the name resolved from the directory when known.
fn roster_page(body: &Value, directory: &Directory) -> crate::members::MemberPage {
    let members: Vec<crate::members::Member> = body
        .get("members")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|m| {
            let mri = str_of(m, "id")?.to_owned();
            let name = directory.name(&mri);
            Some(crate::members::Member {
                id: mri.clone(),
                username: name.clone().unwrap_or(mri),
                name,
                presence: None,
                avatar_etag: None,
                roles: str_of(m, "role").map(|r| vec![r.to_owned()]).unwrap_or_default(),
            })
        })
        .collect();
    let total = members.len() as u32;
    crate::members::MemberPage { members, total }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn roster_page_maps_members_and_resolves_names() {
        let dir = Directory::default();
        dir.remember("8:orgid:aaaa", "Ada Lovelace");
        let body = serde_json::json!({ "members": [
            { "id": "8:orgid:aaaa", "role": "Admin" },
            { "id": "8:orgid:bbbb", "role": "User" },
        ] });
        let page = roster_page(&body, &dir);
        assert_eq!(page.total, 2);
        assert_eq!(page.members[0].id, "8:orgid:aaaa");
        assert_eq!(page.members[0].username, "Ada Lovelace");
        assert_eq!(page.members[0].roles, vec!["Admin".to_owned()]);
        assert_eq!(page.members[1].username, "8:orgid:bbbb");
        assert_eq!(roster_page(&serde_json::json!({}), &dir).total, 0);
    }
}
