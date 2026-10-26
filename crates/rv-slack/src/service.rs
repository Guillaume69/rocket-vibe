//! Every Web API call once signed in, with its paging: the conversation
//! list and `client.counts`, history by exact `ts`, threads, single messages,
//! writes, pins, saved items, search and file uploads. The people and bots a
//! page names are resolved in the directory before it is returned. What the
//! answers become in an app's store is the app's.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use serde_json::Value;

use crate::directory::{Directory, User};
use crate::translate::{self, split_id, ts_ms};
use rv_provider::rest::{CallOptions, RestClient, RestError};

const ROSTER_PAGE: &str = "200";
const MAX_PAGES: usize = 50;
const THREAD_PAGE: &str = "200";
const THREAD_PAGES: usize = 20;
/// Where Slack serves a workspace's custom emoji, public like its avatars.
pub const CUSTOM_EMOJI_ORIGIN: &str = "https://emoji.slack-edge.com/";
const GONE: [&str; 4] = ["channel_not_found", "thread_not_found", "message_not_found", "not_in_channel"];

pub fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

pub fn is(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool) == Some(true)
}

pub fn list(v: &Value, key: &str) -> Vec<Value> {
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

fn message_ids<'a>(msg_id: &'a str, what: &str) -> Result<(&'a str, &'a str), RestError> {
    split_id(msg_id).ok_or_else(|| RestError::incomplete(&format!("{what}: not a Slack message")))
}

/// Someone `users.list` names who can be written to: their user, and the
/// lowercase text a search matches (username, display and real names).
/// Bots, Slackbot and deactivated accounts are left out.
fn person(raw: &Value) -> Option<(User, String)> {
    if is(raw, "deleted") || is(raw, "is_bot") || text(raw, "id") == Some("USLACKBOT") {
        return None;
    }
    let user = User::from_json(raw)?;
    let names = [Some(user.username.as_str()), raw.pointer("/profile/display_name").and_then(Value::as_str)]
        .into_iter()
        .chain([raw.pointer("/profile/real_name").and_then(Value::as_str), text(raw, "real_name")])
        .flatten()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    Some((user, names))
}

pub struct Service {
    rest: RestClient,
    pub directory: Arc<Directory>,
    /// The workspace's people for a search, read once per session: id and the text matched.
    people: tokio::sync::Mutex<Option<Vec<(String, String)>>>,
}

impl Service {
    pub fn new(rest: RestClient, directory: Arc<Directory>) -> Self {
        Service { rest, directory, people: tokio::sync::Mutex::default() }
    }

    pub async fn call(&self, method: &str, params: Vec<(&str, String)>) -> Result<Value, RestError> {
        self.rest.post(method, CallOptions::params(params)).await
    }

    /// The people and bots messages name, read into the directory.
    pub async fn resolve(&self, messages: &[Value]) {
        let people: Vec<String> = messages.iter().flat_map(translate::people).collect();
        let bots: Vec<String> = messages.iter().filter_map(|m| text(m, "bot_id").map(str::to_owned)).collect();
        tokio::join!(self.directory.ensure(&self.rest, people), self.directory.ensure_bots(&self.rest, bots));
    }

    /// People by id, read into the directory.
    pub async fn ensure_people(&self, ids: impl IntoIterator<Item = String>) {
        self.directory.ensure(&self.rest, ids).await;
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
    pub async fn counts(&self) -> Option<HashMap<String, Value>> {
        let body = self.call("client.counts", Vec::new()).await.ok()?;
        let entries = ["channels", "mpims", "ims"].into_iter().flat_map(|key| list(&body, key));
        Some(entries.filter_map(|e| Some((text(&e, "id")?.to_owned(), e))).collect())
    }

    /// One `conversations.history` page, newest first, its people resolved; and the cursor when more follow.
    pub async fn history(
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

    /// Everything written after `since` in up to `pages` pages of `per_page`;
    /// None when more than that came.
    pub async fn history_since(
        &self,
        rid: &str,
        since: &str,
        per_page: i64,
        pages: usize,
    ) -> Result<Option<Vec<Value>>, RestError> {
        let (mut gathered, mut cursor, mut seen) = (Vec::new(), None::<String>, Vec::new());
        for _ in 0..pages {
            let mut params = vec![("oldest", since.to_owned()), ("limit", per_page.to_string())];
            params.extend(cursor.take().map(|c| ("cursor", c)));
            let (page, next) = self.history(rid, params).await?;
            gathered.extend(page);
            match next {
                Some(next) if !seen.contains(&next) => {
                    seen.push(next.clone());
                    cursor = Some(next);
                }
                Some(_) => return Err(RestError::incomplete("conversations.history: repeated cursor")),
                None => return Ok(Some(gathered)),
            }
        }
        Ok(None)
    }

    /// Slack's copy of one message (`<channel>/<ts>`), people resolved: from
    /// the room's history, else from its thread. None when it is gone.
    pub async fn message(&self, id: &str) -> Result<Option<(String, Value)>, RestError> {
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
        if let Some(found) = page.into_iter().find(|m| text(m, "ts") == Some(ts)) {
            return Ok(Some((rid.to_owned(), found)));
        }
        let params = vec![
            ("channel", rid.to_owned()),
            ("ts", ts.to_owned()),
            ("oldest", ts.to_owned()),
            ("latest", ts.to_owned()),
            ("inclusive", "true".to_owned()),
            ("limit", "2".to_owned()),
        ];
        let replies = match self.call("conversations.replies", params).await {
            Ok(body) => list(&body, "messages"),
            Err(e) => return gone(e),
        };
        let Some(found) = replies.into_iter().find(|m| text(m, "ts") == Some(ts)) else { return Ok(None) };
        self.resolve(std::slice::from_ref(&found)).await;
        Ok(Some((rid.to_owned(), found)))
    }

    /// The whole thread under `root`, oldest first, people resolved. Slack
    /// repeats the root at the top of every page.
    pub async fn thread(&self, rid: &str, ts: &str) -> Result<Vec<Value>, RestError> {
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
        Ok(messages)
    }

    /// Renames a channel; Slack's name is its address too, its own rules
    /// (lower case, no spaces) checked by Slack. Answers the name Slack kept.
    pub async fn rename(&self, rid: &str, name: &str) -> Result<String, RestError> {
        let body =
            self.call("conversations.rename", vec![("channel", rid.to_owned()), ("name", name.to_owned())]).await?;
        Ok(body.pointer("/channel/name").and_then(Value::as_str).unwrap_or(name).to_owned())
    }

    /// Rewrites my message; answers its new copy, people resolved, when Slack gives it.
    pub async fn edit(&self, msg_id: &str, text: &str) -> Result<Option<(String, Value)>, RestError> {
        let (channel, ts) = message_ids(msg_id, "edit")?;
        let id_of = |username: &str| self.directory.id_of(username);
        let params = vec![
            ("channel", channel.to_owned()),
            ("ts", ts.to_owned()),
            ("text", translate::markdown_to_mrkdwn(text, &id_of)),
        ];
        let body = self.call("chat.update", params).await?;
        let Some(message) = body.get("message") else { return Ok(None) };
        let mut message = message.clone();
        message["ts"] = Value::from(ts);
        self.resolve(std::slice::from_ref(&message)).await;
        Ok(Some((channel.to_owned(), message)))
    }

    pub async fn delete(&self, msg_id: &str) -> Result<(), RestError> {
        let (channel, ts) = message_ids(msg_id, "delete")?;
        self.call("chat.delete", vec![("channel", channel.to_owned()), ("ts", ts.to_owned())]).await?;
        Ok(())
    }

    /// Adds or takes back my reaction; the state already there settles it.
    pub async fn react(&self, msg_id: &str, shortcode: &str, add: bool) -> Result<(), RestError> {
        let (channel, ts) = message_ids(msg_id, "react")?;
        let name = crate::emojis::slack_name(shortcode);
        if name.is_empty() {
            return Err(RestError::incomplete("react: no emoji"));
        }
        let params = vec![("channel", channel.to_owned()), ("timestamp", ts.to_owned()), ("name", name)];
        let settled = if add { "already_reacted" } else { "no_reaction" };
        match self.call(if add { "reactions.add" } else { "reactions.remove" }, params).await {
            Ok(_) => Ok(()),
            Err(e) if e.error.as_deref() == Some(settled) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Moves the room's read mark to `ts`.
    pub async fn mark(&self, rid: &str, ts: &str) -> Result<(), RestError> {
        self.call("conversations.mark", vec![("channel", rid.to_owned()), ("ts", ts.to_owned())]).await?;
        Ok(())
    }

    /// Pins or unpins a message for everyone in the room; the state already there settles it.
    pub async fn pin(&self, msg_id: &str, on: bool) -> Result<(), RestError> {
        let (channel, ts) = message_ids(msg_id, "pin")?;
        let params = vec![("channel", channel.to_owned()), ("timestamp", ts.to_owned())];
        let settled = if on { "already_pinned" } else { "no_pin" };
        match self.call(if on { "pins.add" } else { "pins.remove" }, params).await {
            Ok(_) => Ok(()),
            Err(e) if e.error.as_deref() == Some(settled) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Saves a message for later, or takes it back.
    pub async fn save(&self, msg_id: &str, on: bool) -> Result<(), RestError> {
        let (channel, ts) = message_ids(msg_id, "save")?;
        let params = vec![("item_type", "message".to_owned()), ("item_id", channel.to_owned()), ("ts", ts.to_owned())];
        self.call(if on { "saved.add" } else { "saved.delete" }, params).await?;
        Ok(())
    }

    /// Every message I saved for later, by id; Slack lists the references only.
    pub async fn saved(&self) -> Result<HashSet<String>, RestError> {
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
        Ok(ids)
    }

    /// A room's pinned messages, people resolved.
    pub async fn pins(&self, rid: &str) -> Result<Vec<Value>, RestError> {
        let body = self.call("pins.list", vec![("channel", rid.to_owned())]).await?;
        let messages: Vec<Value> =
            list(&body, "items").iter().filter_map(|item| item.get("message").cloned()).collect();
        self.resolve(&messages).await;
        Ok(messages)
    }

    /// The room's messages Slack's search finds for `query`, newest first, people resolved.
    pub async fn search(&self, rid: &str, query: &str) -> Result<Vec<Value>, RestError> {
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
        Ok(matches)
    }

    /// People whose username or name holds the query, case-insensitively,
    /// `me` left out, at most `limit`. The first search reads the workspace's
    /// people (`users.list`, every page); a failed read is tried again next time.
    pub async fn search_people(&self, query: &str, me: &str, limit: usize) -> Result<Vec<User>, RestError> {
        let q = query.trim().trim_start_matches('@').to_lowercase();
        let mut people = self.people.lock().await;
        if people.is_none() {
            *people = Some(self.workspace_people().await?);
        }
        Ok(people
            .iter()
            .flatten()
            .filter(|(id, names)| id != me && names.contains(&q))
            .filter_map(|(id, _)| self.directory.user(id))
            .take(limit)
            .collect())
    }

    async fn workspace_people(&self) -> Result<Vec<(String, String)>, RestError> {
        let mut out = Vec::new();
        let (mut cursor, mut seen) = (None::<String>, Vec::new());
        for _ in 0..MAX_PAGES {
            let mut params = vec![("limit", ROSTER_PAGE.to_owned())];
            params.extend(cursor.take().map(|c| ("cursor", c)));
            let body = self.call("users.list", params).await?;
            for (user, names) in list(&body, "members").iter().filter_map(person) {
                out.push((user.id.clone(), names));
                self.directory.remember(user);
            }
            match next_cursor(&body, &mut seen, "users.list")? {
                Some(next) => cursor = Some(next),
                None => return Ok(out),
            }
        }
        Err(RestError::incomplete("users.list: too many pages"))
    }

    /// The direct conversation with these people and me, created if needed
    /// (one person: a DM; up to eight: a group DM): its id.
    pub async fn open_conversation(&self, ids: &[String]) -> Result<String, RestError> {
        let params = vec![("users", ids.join(",")), ("return_im", "true".to_owned())];
        let body = self.call("conversations.open", params).await?;
        body.pointer("/channel/id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| RestError::incomplete("conversations.open: no channel"))
    }

    /// Where a file's bytes go, and the id Slack gave it. Only Slack's file
    /// host is accepted as the destination.
    pub async fn upload_url(&self, name: &str, length: u64) -> Result<(url::Url, String), RestError> {
        let body = self
            .call("files.getUploadURLExternal", vec![("filename", name.to_owned()), ("length", length.to_string())])
            .await?;
        let url = text(&body, "upload_url")
            .and_then(|u| url::Url::parse(u).ok())
            .filter(translate::file_host)
            .ok_or_else(|| RestError::incomplete("files.getUploadURLExternal: no Slack upload address"))?;
        let id = text(&body, "file_id")
            .filter(|id| id.starts_with('F') && id.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()))
            .ok_or_else(|| RestError::incomplete("files.getUploadURLExternal: no file id"))?;
        Ok((url, id.to_owned()))
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
        let mut params = vec![
            ("files", serde_json::json!([{"id": file_id, "title": title}]).to_string()),
            ("channel_id", rid.to_owned()),
        ];
        if let Some(caption) = caption.filter(|c| !c.is_empty()) {
            let id_of = |username: &str| self.directory.id_of(username);
            params.push(("initial_comment", translate::markdown_to_mrkdwn(caption, &id_of)));
        }
        if let Some((_, ts)) = tmid.and_then(split_id) {
            params.push(("thread_ts", ts.to_owned()));
        }
        self.call("files.completeUploadExternal", params).await.map(|_| ())
    }
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
    fn a_search_matches_usernames_display_and_real_names_of_people_only() {
        let member = |extra: Value| {
            let mut raw = json!({"id": "U001", "name": "mgonzalez",
                "profile": {"display_name": "Mika", "real_name": "Micael GONZALEZ"}});
            raw.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            raw
        };
        let (user, names) = person(&member(json!({}))).unwrap();
        assert_eq!((user.id.as_str(), user.username.as_str()), ("U001", "mgonzalez"));
        assert!(["micael", "gonz", "mika", "mgon"].iter().all(|q| names.contains(q)), "{names}");
        assert!(person(&member(json!({"deleted": true}))).is_none());
        assert!(person(&member(json!({"is_bot": true}))).is_none());
        assert!(person(&member(json!({"id": "USLACKBOT"}))).is_none());
    }
}
