//! Every call to Teams' services once signed in: the chat service, the CSA
//! aggregator, presence, the middle tier's profiles, Substrate search, the
//! templates service and Microsoft Graph for files. A refused token is renewed
//! once. What the answers become in an app's store is the app's.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use reqwest::Method;
use serde_json::{Value, json};

use crate::auth::{Tokens, refusal};
use crate::client::{self, Answer};
use crate::translate::{self, Directory, split_id, str_of};
use rv_provider::live::Presence;
use rv_provider::normalize::Message;
use rv_provider::rest::RestError;

/// The chat service's message view, with the properties reactions and pins live in.
pub const VIEW: &str = "msnp24Equivalent|supportsMessageProperties";

/// The OneDrive folder Teams keeps a chat's files in.
const CHAT_FILES: &str = "Microsoft Teams Chat Files";

/// A file uploaded to a room's files folder, as the chat-service message's
/// `properties.files` entry needs it.
pub struct FileRef {
    pub item_id: String,
    pub name: String,
    pub web_url: String,
    pub site: String,
    pub unique: String,
}

/// Where a room's files go: a channel's team (its Graph group, when the
/// aggregator named it), or a chat (my OneDrive).
pub enum FilesHome<'a> {
    Channel { group: Option<&'a str> },
    Chat,
}

pub struct Service {
    tokens: Arc<Tokens>,
    http: reqwest::Client,
    me: String,
    pub directory: Arc<Directory>,
    /// A room's files folder (Graph drive id, folder item id), cached per room.
    drives: Mutex<HashMap<String, (String, String)>>,
}

impl Service {
    pub fn new(tokens: Arc<Tokens>, me: &str, directory: Arc<Directory>) -> Self {
        Service { tokens, http: client::http(), me: me.to_owned(), directory, drives: Mutex::default() }
    }

    pub fn me(&self) -> &str {
        &self.me
    }

    /// A chat service call; a refused Skype token is renewed once.
    pub async fn chat(&self, method: Method, url: url::Url, body: Option<&Value>) -> Result<Answer, RestError> {
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

    pub async fn conversation_url(&self, rid: &str, tail: &[&str], query: &str) -> Result<url::Url, RestError> {
        let mut segments = vec!["users", "ME", "conversations", rid];
        segments.extend_from_slice(tail);
        self.chat_url(&segments, query).await
    }

    /// The aggregator's list of chats and teams.
    pub async fn snapshot(&self) -> Result<Value, RestError> {
        self.aggregator_call(
            Method::GET,
            &["api", "v2", "teams", "users", "me"],
            "isPrefetch=false&enableMembershipSummary=true",
            None,
        )
        .await
        .map(|answer| answer.body)
    }

    /// A CSA aggregator call with its bearer; a refused token is renewed once.
    pub async fn aggregator_call(
        &self,
        method: Method,
        segments: &[&str],
        query: &str,
        body: Option<&Value>,
    ) -> Result<Answer, RestError> {
        let (_, routes) = self.tokens.chat().await?;
        let url = client::service_url(&routes.aggregator, segments, query)?;
        for attempt in 0..2 {
            let token = self.tokens.aggregator().await?;
            let header = format!("Bearer {}", token.as_str());
            match client::call(&self.http, method.clone(), url.clone(), ("authorization", &header), body).await {
                Err(e) if e.status == 401 && attempt == 0 => self.tokens.forget_aggregator().await,
                other => return other,
            }
        }
        unreachable!("the second attempt returns")
    }

    /// An image on Teams' object store (`translate::is_teams_image`), with the
    /// skype token in asyncgw's own form; a refused token is renewed once.
    pub async fn fetch_image(&self, url: &str) -> Result<(Vec<u8>, String), RestError> {
        if !translate::is_teams_image(url) {
            return Err(RestError::network(format!("{url}: not a Teams image.")));
        }
        let net = |e: reqwest::Error| RestError::network(format!("teams image: {e}"));
        for attempt in 0..2 {
            let (token, _) = self.tokens.chat().await?;
            let response = self
                .http
                .get(url)
                .header("authorization", format!("skype_token {}", token.as_str()))
                .send()
                .await
                .map_err(net)?;
            let status = response.status().as_u16();
            if status == 401 && attempt == 0 {
                self.tokens.forget_chat().await;
                continue;
            }
            if !(200..300).contains(&status) {
                return Err(RestError { status, ..RestError::network(format!("teams image: {status}")) });
            }
            let kind = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_owned();
            return Ok((response.bytes().await.map_err(net)?.to_vec(), kind));
        }
        unreachable!("the second attempt returns")
    }

    /// One history page, newest first, and the link to the page before it.
    pub async fn page(&self, url: url::Url) -> Result<(Vec<Value>, Option<String>), RestError> {
        let body = self.chat(Method::GET, url, None).await?.body;
        let messages = body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        let older = body.pointer("/_metadata/backwardLink").and_then(Value::as_str).map(str::to_owned);
        Ok((messages, older))
    }

    /// The page of a conversation's messages `query` asks for.
    pub async fn messages(&self, rid: &str, query: &str) -> Result<(Vec<Value>, Option<String>), RestError> {
        self.page(self.conversation_url(rid, &["messages"], query).await?).await
    }

    /// A backward link is followed only on the chat service's own host.
    pub async fn trusted(&self, link: &str) -> Option<url::Url> {
        let (_, routes) = self.tokens.chat().await.ok()?;
        let url = url::Url::parse(link).ok()?;
        let base = url::Url::parse(&routes.chat).ok()?;
        (url.scheme() == base.scheme()
            && url.host_str() == base.host_str()
            && url.port() == base.port()
            && url.path().starts_with(base.path()))
        .then_some(url)
    }

    /// The service's copy of one message (`<rid>/<server id>`); None when it answers 404.
    pub async fn message(&self, id: &str) -> Result<Option<(String, Value)>, RestError> {
        let Some((rid, server)) = split_id(id) else { return Ok(None) };
        let url = self.conversation_url(rid, &["messages", server], &format!("view={VIEW}")).await?;
        match self.chat(Method::GET, url, None).await {
            Ok(answer) => Ok(Some((rid.to_owned(), answer.body))),
            Err(e) if e.status == 404 => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The chat service's conversation document, best effort.
    pub async fn conversation(&self, rid: &str) -> Option<Value> {
        let url = self.conversation_url(rid, &[], "view=msnp24Equivalent").await.ok()?;
        self.chat(Method::GET, url, None).await.ok().map(|a| a.body)
    }

    /// The room's roster, from the threads service: each member is `{id: <mri>, role}`.
    pub async fn roster(&self, rid: &str) -> Result<Value, RestError> {
        let url = self.chat_url(&["threads", rid], "view=msnp24Equivalent&threadProperties=1").await?;
        Ok(self.chat(Method::GET, url, None).await?.body)
    }

    /// Presence for a batch of people (UPS getpresence), best effort.
    pub async fn get_presence(&self, mris: &[String]) -> Vec<(String, Presence)> {
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
        let body = Value::Array(mris.iter().map(|m| json!({ "mri": m })).collect());
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
            .map_err(|_| refusal("presence_url", 0))?;
        let token = self.tokens.presence().await?;
        let header = format!("Bearer {}", token.as_str());
        let body = json!({ "availability": availability });
        client::call(&self.http, Method::PUT, url, ("authorization", &header), Some(&body)).await?;
        Ok(())
    }

    /// Short profiles (name, title) by MRI, via the middle tier with the Spaces
    /// bearer. Best effort: [] when the route or token is absent.
    pub async fn profiles(&self, mris: &[String]) -> Vec<Value> {
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

    /// Messages in one room matching `text`, through the Substrate search API.
    /// Substrate indexes Teams messages from Exchange, so a hit carries the
    /// conversation id, author display name, preview and time but no
    /// chat-service message id: the results open the room, they do not jump to
    /// the exact message, and the id is synthetic.
    pub async fn search(&self, rid: &str, text: &str) -> Result<Vec<Message>, RestError> {
        let token = self.tokens.substrate().await?;
        let header = format!("Bearer {}", token.as_str());
        let url = url::Url::parse("https://substrate.office.com/search/api/v2/query")
            .map_err(|_| refusal("substrate_url", 0))?;
        let mut cvid = [0u8; 16];
        getrandom::fill(&mut cvid).ok();
        let cvid: String = cvid.iter().map(|b| format!("{b:02x}")).collect();
        let body = json!({
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

    /// Download a Teams shared file: its SharePoint/OneDrive url resolved
    /// through Graph `GET /shares/u!{base64url}/driveItem/content`, which
    /// answers 302 to a pre-signed url we follow WITHOUT the bearer. Streams to
    /// `dest`, reporting bytes. The chat token cannot reach this; the Graph
    /// token can (verified live 2026-10-22).
    pub async fn download_file(
        &self,
        url: &str,
        dest: &std::path::Path,
        progress: impl Fn(u64) + Send,
    ) -> Result<(), RestError> {
        use base64::Engine;
        let token = self.tokens.graph().await?;
        let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url.as_bytes());
        let share = format!("https://graph.microsoft.com/v1.0/shares/u!{enc}/driveItem/content");
        let net = |e: reqwest::Error| RestError::network(format!("teams file: {e}"));
        let first = self.http.get(&share).bearer_auth(token.as_str()).send().await.map_err(net)?;
        let status = first.status().as_u16();
        let response = if (300..400).contains(&status) {
            let location = first
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| RestError::network("teams file: redirect without a location".to_owned()))?
                .to_owned();
            self.http.get(&location).send().await.map_err(net)?
        } else {
            first
        };
        stream_response(response, dest, progress).await
    }

    /// A GET against Microsoft Graph with the Graph bearer, as JSON.
    async fn graph_json(&self, url: &str) -> Result<Value, RestError> {
        let token = self.tokens.graph().await?;
        let r = self
            .http
            .get(url)
            .bearer_auth(token.as_str())
            .send()
            .await
            .map_err(|e| RestError::network(format!("teams graph: {e}")))?;
        let status = r.status().as_u16();
        let body: Value = r.json().await.unwrap_or(Value::Null);
        if status >= 400 {
            return Err(refusal(&format!("graph_{status}"), status));
        }
        Ok(body)
    }

    /// The Graph group id of the team a channel belongs to: `known` when the
    /// aggregator named it, else found by scanning my joined teams for the one
    /// whose channels include it.
    pub async fn parent_team(&self, channel: &str, known: Option<&str>) -> Result<String, RestError> {
        if let Some(group) = known {
            return Ok(group.to_owned());
        }
        let teams = self.graph_json("https://graph.microsoft.com/v1.0/me/joinedTeams?$select=id").await?;
        for team in teams.get("value").and_then(Value::as_array).into_iter().flatten() {
            let Some(gid) = team.get("id").and_then(Value::as_str) else { continue };
            let url = format!("https://graph.microsoft.com/v1.0/teams/{gid}/channels?$select=id");
            let chans = self.graph_json(&url).await?;
            let here = chans
                .get("value")
                .and_then(Value::as_array)
                .is_some_and(|cs| cs.iter().any(|c| c.get("id").and_then(Value::as_str) == Some(channel)));
            if here {
                return Ok(gid.to_owned());
            }
        }
        Err(refusal("teams_team_not_found", 0))
    }

    /// The organizer's object id of a channel call, from its start message's author.
    pub async fn call_organizer(&self, rid: &str, server: &str) -> Result<Option<String>, RestError> {
        let url = self.conversation_url(rid, &["messages", server], &format!("view={VIEW}")).await?;
        let start = self.chat(Method::GET, url, None).await?.body;
        Ok(str_of(&start, "from").map(translate::mri_of).and_then(translate::object_id).map(str::to_owned))
    }

    /// Renames a channel as Teams' web app does: its templates service,
    /// addressed by the team's Graph group and the channel's Substrate group.
    pub async fn rename(&self, group: &str, substrate: &str, tenant: &str, name: &str) -> Result<(), RestError> {
        let (_, routes) = self.tokens.chat().await?;
        let base = format!("{}/templates", routes.aggregator.replace("/api/csa/", "/fabric/"));
        let channel = format!("OID:{substrate}@{tenant}");
        let url = client::service_url(&base, &["api", "teams", group, "channels", &channel], "forceSync=false")?;
        let body = json!({ "displayName": name });
        for attempt in 0..2 {
            let token = self.tokens.templates().await?;
            let header = format!("Bearer {}", token.as_str());
            match client::call(&self.http, Method::PATCH, url.clone(), ("authorization", &header), Some(&body)).await {
                Err(e) if e.status == 401 && attempt == 0 => self.tokens.forget_templates().await,
                Err(e) => return Err(e),
                Ok(_) => return Ok(()),
            }
        }
        unreachable!("the second attempt returns")
    }

    /// (Graph drive id, folder item id) where a room's files go, cached per
    /// room: a channel's SharePoint files folder, a chat's `Microsoft Teams
    /// Chat Files` folder in my OneDrive (as Teams' own clients do), made
    /// when it does not exist yet.
    async fn files_folder(&self, rid: &str, home: &FilesHome<'_>) -> Result<(String, String), RestError> {
        if let Some(found) = self.drives.lock().unwrap().get(rid).cloned() {
            return Ok(found);
        }
        let pair = match home {
            FilesHome::Chat => self.chat_files_folder().await?,
            FilesHome::Channel { group } => {
                let group = self.parent_team(rid, *group).await?;
                let url = format!(
                    "https://graph.microsoft.com/v1.0/teams/{group}/channels/{rid}/filesFolder?$select=id,parentReference"
                );
                let folder = self.graph_json(&url).await?;
                let drive = folder.pointer("/parentReference/driveId").and_then(Value::as_str);
                let item = folder.get("id").and_then(Value::as_str);
                let (Some(drive), Some(item)) = (drive, item) else {
                    return Err(refusal("teams_files_folder", 0));
                };
                (drive.to_owned(), item.to_owned())
            }
        };
        self.drives.lock().unwrap().insert(rid.to_owned(), pair.clone());
        Ok(pair)
    }

    async fn chat_files_folder(&self) -> Result<(String, String), RestError> {
        let pair = |v: &Value| {
            Some((
                v.pointer("/parentReference/driveId").and_then(Value::as_str)?.to_owned(),
                v.get("id").and_then(Value::as_str)?.to_owned(),
            ))
        };
        let path = format!(
            "https://graph.microsoft.com/v1.0/me/drive/root:/{}?$select=id,parentReference",
            encode_segment(CHAT_FILES)
        );
        if let Ok(found) = self.graph_json(&path).await
            && let Some(found) = pair(&found)
        {
            return Ok(found);
        }
        let token = self.tokens.graph().await?;
        let body = json!({ "name": CHAT_FILES, "folder": {}, "@microsoft.graph.conflictBehavior": "fail" });
        let made = self
            .http
            .post("https://graph.microsoft.com/v1.0/me/drive/root/children")
            .bearer_auth(token.as_str())
            .json(&body)
            .send()
            .await
            .map_err(|e| RestError::network(format!("teams chat files: {e}")))?;
        let status = made.status().as_u16();
        let made: Value = made.json().await.unwrap_or(Value::Null);
        match pair(&made) {
            Some(found) => Ok(found),
            None if status == 409 => {
                pair(&self.graph_json(&path).await?).ok_or_else(|| refusal("teams_chat_files", status))
            }
            None => Err(refusal("teams_chat_files", status)),
        }
    }

    /// Grants a chat's other members read on a file in my OneDrive, as Teams'
    /// clients do for a chat's files, without Microsoft's invitation mail
    /// (`driveItem/invite`, verified live 2026-10-24).
    async fn share_with_chat(&self, rid: &str, drive: &str, item_id: &str) -> Result<(), RestError> {
        let roster = self.roster(rid).await?;
        let others: Vec<Value> = roster
            .get("members")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|m| str_of(m, "id"))
            .filter(|mri| *mri != self.me)
            .filter_map(|mri| mri.strip_prefix("8:orgid:"))
            .map(|oid| json!({ "objectId": oid }))
            .collect();
        if others.is_empty() {
            return Ok(());
        }
        let token = self.tokens.graph().await?;
        let body = json!({ "requireSignIn": true, "sendInvitation": false, "roles": ["read"], "recipients": others });
        let r = self
            .http
            .post(format!("https://graph.microsoft.com/v1.0/drives/{drive}/items/{item_id}/invite"))
            .bearer_auth(token.as_str())
            .json(&body)
            .send()
            .await
            .map_err(|e| RestError::network(format!("teams share: {e}")))?;
        let status = r.status().as_u16();
        if status >= 400 {
            return Err(refusal(&format!("graph_invite_{status}"), status));
        }
        Ok(())
    }

    /// Uploads `bytes` into a room's files folder (Graph simple upload), and
    /// returns the stored file as the chat message needs it.
    pub async fn upload_file(
        &self,
        rid: &str,
        home: &FilesHome<'_>,
        name: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<FileRef, RestError> {
        let (drive, folder) = self.files_folder(rid, home).await?;
        let token = self.tokens.graph().await?;
        let put = format!(
            "https://graph.microsoft.com/v1.0/drives/{drive}/items/{folder}:/{}:/content",
            encode_segment(name)
        );
        let r = self
            .http
            .put(&put)
            .bearer_auth(token.as_str())
            .header("content-type", mime)
            .body(bytes)
            .send()
            .await
            .map_err(|e| RestError::network(format!("teams upload: {e}")))?;
        let status = r.status().as_u16();
        let item: Value = r.json().await.unwrap_or(Value::Null);
        if status >= 400 {
            return Err(refusal(&format!("graph_upload_{status}"), status));
        }
        let item_id =
            item.get("id").and_then(Value::as_str).ok_or_else(|| refusal("teams_upload_no_id", status.max(200)))?;
        self.file_ref(rid, home, item_id).await
    }

    /// The stored file's message fields, re-read for its SharePoint ids; a
    /// chat's file is shared with the chat's members first.
    pub async fn file_ref(&self, rid: &str, home: &FilesHome<'_>, item_id: &str) -> Result<FileRef, RestError> {
        let (drive, _) = self.files_folder(rid, home).await?;
        if matches!(home, FilesHome::Chat) {
            self.share_with_chat(rid, &drive, item_id).await?;
        }
        let url = format!(
            "https://graph.microsoft.com/v1.0/drives/{drive}/items/{item_id}?$select=id,name,webUrl,sharepointIds"
        );
        let item = self.graph_json(&url).await?;
        let text = |p: &str| item.pointer(p).and_then(Value::as_str).unwrap_or_default().to_owned();
        Ok(FileRef {
            item_id: item_id.to_owned(),
            name: text("/name"),
            web_url: text("/webUrl"),
            site: text("/sharepointIds/siteUrl"),
            unique: text("/sharepointIds/listItemUniqueId"),
        })
    }

    /// Posts text into a room, or into a channel thread under `root`; answers
    /// the new message's server id.
    pub async fn send(&self, rid: &str, root: Option<&str>, text: &str, client_id: &str) -> Result<String, RestError> {
        let body = json!({
            "content": to_html(text),
            "messagetype": "RichText/Html",
            "contenttype": "text",
            "clientmessageid": client_id,
            "imdisplayname": self.directory.shown(&self.me),
        });
        let url = self.conversation_url(&thread_target(rid, root), &["messages"], "").await?;
        let answer = self.chat(Method::POST, url, Some(&body)).await?;
        let id = translate::int_of(&answer.body, "OriginalArrivalTime")
            .ok_or_else(|| refusal("send_answer", answer.status))?;
        Ok(id.to_string())
    }

    /// Posts an uploaded file, with an optional caption, as Teams' clients do.
    pub async fn send_file(
        &self,
        rid: &str,
        root: Option<&str>,
        file: &FileRef,
        caption: Option<&str>,
        client_id: &str,
    ) -> Result<(), RestError> {
        let ext = file.name.rsplit('.').next().filter(|e| *e != file.name).unwrap_or("");
        let files = serde_json::to_string(&json!([{
            "@type": "http://schema.skype.com/File",
            "version": 2,
            "id": file.unique,
            "itemid": file.unique,
            "fileName": file.name,
            "fileType": ext,
            "title": file.name,
            "type": ext,
            "state": "active",
            "fileInfo": {"fileUrl": file.web_url, "siteUrl": file.site, "serverRelativeUrl": "", "itemId": null, "shareUrl": null, "shareId": null},
            "fileChicletState": {"serviceName": "teams", "state": "active"},
            "baseUrl": file.site,
            "objectUrl": file.web_url,
        }]))
        .unwrap_or_default();
        let content = caption.filter(|c| !c.is_empty()).map(to_html).unwrap_or_default();
        let body = json!({
            "content": content,
            "messagetype": "RichText/Html",
            "contenttype": "Text",
            "clientmessageid": client_id,
            "imdisplayname": self.directory.shown(&self.me),
            "properties": {"files": files},
        });
        let url = self.conversation_url(&thread_target(rid, root), &["messages"], "").await?;
        self.chat(Method::POST, url, Some(&body)).await?;
        Ok(())
    }

    pub async fn set_typing(&self, rid: &str, active: bool) -> Result<(), RestError> {
        let body = json!({
            "content": "",
            "messagetype": if active { "Control/Typing" } else { "Control/ClearTyping" },
            "contenttype": "Application/Message",
            "imdisplayname": self.directory.shown(&self.me),
        });
        let url = self.conversation_url(rid, &["messages"], "").await?;
        self.chat(Method::POST, url, Some(&body)).await?;
        Ok(())
    }

    pub async fn edit(&self, msg_id: &str, text: &str) -> Result<(), RestError> {
        let (rid, server) = ids(msg_id)?;
        let body = json!({"content": to_html(text), "messagetype": "RichText/Html", "contenttype": "text"});
        let url = self.conversation_url(rid, &["messages", server], "").await?;
        self.chat(Method::PUT, url, Some(&body)).await?;
        Ok(())
    }

    pub async fn delete(&self, msg_id: &str) -> Result<(), RestError> {
        let (rid, server) = ids(msg_id)?;
        let url = self.conversation_url(rid, &["messages", server], "").await?;
        self.chat(Method::DELETE, url, None).await?;
        Ok(())
    }

    pub async fn react(&self, msg_id: &str, shortcode: &str, add: bool) -> Result<(), RestError> {
        let (rid, server) = ids(msg_id)?;
        let key = translate::reaction_key(shortcode).ok_or_else(|| refusal("reaction_not_supported", 0))?;
        let url = self.conversation_url(rid, &["messages", server, "properties"], "name=emotions").await?;
        let (method, body) = if add {
            (Method::PUT, json!({"emotions": {"key": key, "value": chrono::Utc::now().timestamp_millis()}}))
        } else {
            (Method::DELETE, json!({"emotions": {"key": key}}))
        };
        self.chat(method, url, Some(&body)).await?;
        Ok(())
    }

    /// Pins or unpins a channel post, through the aggregator (channels only).
    pub async fn set_pinned(&self, team: &str, msg_id: &str, pinned: bool) -> Result<(), RestError> {
        let (rid, post) = ids(msg_id)?;
        let method = if pinned { Method::POST } else { Method::DELETE };
        let segments = ["api", "v1", "teams", team, "channels", rid, "posts", post, "pin"];
        self.aggregator_call(method, &segments, "", None).await?;
        Ok(())
    }

    /// Moves the room's read horizon to message `newest`.
    pub async fn mark_read(&self, rid: &str, newest: i64) -> Result<(), RestError> {
        let horizon = format!("{newest};{};{newest}", chrono::Utc::now().timestamp_millis());
        let url = self.conversation_url(rid, &["properties"], "name=consumptionhorizon").await?;
        self.chat(Method::PUT, url, Some(&json!({"consumptionhorizon": horizon}))).await?;
        Ok(())
    }

    /// My message carrying `client_id` among the room's messages since
    /// `since`, and whether the page was full (more may have come).
    pub async fn mine_since(&self, rid: &str, since: i64, client_id: &str) -> Result<(Option<Value>, bool), RestError> {
        let query = format!("view={VIEW}&pageSize=200&startTime={}", since.max(0));
        let (messages, _) = self.messages(rid, &query).await?;
        let full = messages.len() >= 200;
        let found = messages
            .into_iter()
            .find(|m| echoes(m, client_id) && str_of(m, "from").is_some_and(|f| translate::mri_of(f) == self.me));
        Ok((found, full))
    }
}

fn ids(id: &str) -> Result<(&str, &str), RestError> {
    split_id(id).ok_or_else(|| refusal("message_id", 0))
}

fn thread_target(rid: &str, root: Option<&str>) -> String {
    match root.and_then(split_id) {
        Some((_, root)) => format!("{rid};messageid={root}"),
        None => rid.to_owned(),
    }
}

/// Percent-encode one URL path segment (RFC 3986 unreserved kept), for a file
/// name in a Graph path-addressed upload.
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn to_html(text: &str) -> String {
    let escaped = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let lines: Vec<String> = escaped.lines().map(|l| format!("<p>{l}</p>")).collect();
    if lines.is_empty() { "<p></p>".to_owned() } else { lines.concat() }
}

pub fn client_message_id(entry_id: &str) -> String {
    let digits: String = entry_id.chars().filter(char::is_ascii_hexdigit).take(15).collect();
    u64::from_str_radix(&digits, 16).map(|n| n.to_string()).unwrap_or_else(|_| entry_id.to_owned())
}

pub fn echoes(raw: &Value, client_id: &str) -> bool {
    str_of(raw, "clientmessageid") == Some(client_id)
}

pub fn availability_presence(availability: &str) -> Presence {
    match availability {
        "Available" | "AvailableIdle" => Presence::Online,
        "Away" | "BeRightBack" => Presence::Away,
        "Busy" | "BusyIdle" | "DoNotDisturb" | "InAMeeting" | "InACall" | "Presenting" | "Focusing" => Presence::Busy,
        _ => Presence::Offline,
    }
}

pub fn presence_availability(p: Presence) -> &'static str {
    match p {
        Presence::Online => "Available",
        Presence::Away => "Away",
        Presence::Busy => "DoNotDisturb",
        Presence::Offline => "Offline",
    }
}

/// Someone typing or stopping in a room: (room, typist's MRI, shown name, active).
pub struct Typing {
    pub rid: String,
    pub from_mri: String,
    pub display: Option<String>,
    pub active: bool,
}

/// A typing push (`Control/Typing`, `Control/ClearTyping`), or None.
pub fn typing(name: &str, resource: &Value) -> Option<Typing> {
    if name != "NewMessage" {
        return None;
    }
    let active = match resource.get("messagetype").and_then(Value::as_str)? {
        "Control/Typing" => true,
        "Control/ClearTyping" => false,
        _ => return None,
    };
    let rid = translate::conversation_of(resource)?;
    let from_mri = translate::mri_of(resource.get("from").and_then(Value::as_str).unwrap_or_default()).to_owned();
    let display = resource.get("imdisplayname").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    Some(Typing { rid, from_mri, display, active })
}

/// (mri, presence) rows from a getpresence response (array or {responses:[]}).
fn presence_rows(body: &Value) -> Vec<(String, Presence)> {
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
            Some((mri, availability_presence(availability)))
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

/// The `threadProperties.topic` of a chat-service conversation, when set.
pub fn conversation_topic(body: &Value) -> Option<String> {
    body.get("threadProperties").and_then(|p| str_of(p, "topic")).filter(|t| !t.is_empty()).map(str::to_owned)
}

/// Stream an HTTP response body to `dest`, reporting bytes received.
async fn stream_response(
    mut response: reqwest::Response,
    dest: &std::path::Path,
    progress: impl Fn(u64) + Send,
) -> Result<(), RestError> {
    use tokio::io::AsyncWriteExt as _;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(RestError {
            status,
            message: format!("teams file: HTTP {status}"),
            ..RestError::network(String::new())
        });
    }
    let written = |e: std::io::Error| RestError::incomplete(&format!("{}: {e}", dest.display()));
    let mut file = tokio::fs::File::create(dest).await.map_err(written)?;
    let mut received = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|e| RestError::network(format!("teams file: {e}")))? {
        file.write_all(&chunk).await.map_err(written)?;
        received += chunk.len() as u64;
        progress(received);
    }
    file.flush().await.map_err(written)
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

    #[test]
    fn availability_maps_onto_presence() {
        use rv_provider::live::Presence;
        assert_eq!(availability_presence("Available"), Presence::Online);
        assert_eq!(availability_presence("Away"), Presence::Away);
        assert_eq!(availability_presence("BeRightBack"), Presence::Away);
        assert_eq!(availability_presence("DoNotDisturb"), Presence::Busy);
        assert_eq!(availability_presence("InAMeeting"), Presence::Busy);
        assert_eq!(availability_presence("Offline"), Presence::Offline);
        assert_eq!(availability_presence("PresenceUnknown"), Presence::Offline);
        assert_eq!(presence_availability(Presence::Online), "Available");
        assert_eq!(presence_availability(Presence::Busy), "DoNotDisturb");
    }

    #[test]
    fn client_ids_are_stable_digits() {
        let id = client_message_id("65f0a1b2c3d4e5f6a7b8c9d0");
        assert!(id.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(id, client_message_id("65f0a1b2c3d4e5f6a7b8c9d0"));
        assert_eq!(thread_target("19:c@thread.tacv2", Some("19:c@thread.tacv2/10")), "19:c@thread.tacv2;messageid=10");
        assert_eq!(thread_target("19:c@thread.v2", None), "19:c@thread.v2");
    }

    #[test]
    fn a_control_typing_push_is_detected_with_its_room_and_typist() {
        let resource = json!({
            "messagetype": "Control/Typing",
            "from": "https://x/v1/users/ME/contacts/8:orgid:ada",
            "imdisplayname": "Ada",
            "conversationLink": "https://x/v1/users/ME/conversations/19:c@thread.v2"
        });
        let f = typing("NewMessage", &resource).expect("typing");
        assert_eq!(f.rid, "19:c@thread.v2");
        assert_eq!(f.from_mri, "8:orgid:ada");
        assert_eq!(f.display.as_deref(), Some("Ada"));
        assert!(f.active);
        let mut clear = resource.clone();
        clear["messagetype"] = json!("Control/ClearTyping");
        assert!(!typing("NewMessage", &clear).unwrap().active);
        // An ordinary message is not typing.
        let mut msg = resource.clone();
        msg["messagetype"] = json!("RichText/Html");
        assert!(typing("NewMessage", &msg).is_none());
        // Only NewMessage carries typing.
        assert!(typing("MessageUpdate", &resource).is_none());
    }

    #[test]
    fn typed_text_is_escaped_html() {
        assert_eq!(to_html("a <b> & \"c\"\nnext"), "<p>a &lt;b&gt; &amp; &quot;c&quot;</p><p>next</p>");
        assert_eq!(to_html(""), "<p></p>");
    }
}
