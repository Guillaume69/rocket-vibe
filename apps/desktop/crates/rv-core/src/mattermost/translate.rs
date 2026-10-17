//! Mattermost documents to the store's rows. The serialized sub-fields the
//! renderer reads (`reactions`, `attachments`, `urls`) are written in the shape
//! it already knows from Rocket.Chat, so nothing downstream branches on the
//! server. Users are named by id on the wire: `Directory` resolves them first.

use serde_json::{Map, Value, json};

use super::directory::Directory;
use crate::normalize::{Message, Room, Subscription};

const FILES: &str = "/api/v4/files";

/// A JSON string (Mattermost) or an object (kChat) both read as the object.
pub fn object(value: &Value) -> Option<Map<String, Value>> {
    match value {
        Value::String(s) => serde_json::from_str::<Value>(s).ok().and_then(|v| v.as_object().cloned()),
        Value::Object(o) => Some(o.clone()),
        _ => None,
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn num_of(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn positive(v: &Value, key: &str) -> Option<i64> {
    Some(num_of(v, key)).filter(|n| *n > 0)
}

/// Mattermost's system posts onto the types the renderer knows, with their parameter.
/// Any room member can post a `custom_call`: only kMeet's own origin is ever opened.
pub const KMEET_ORIGIN: &str = "https://kmeet.infomaniak.com";

pub fn is_kmeet(url: &str) -> bool {
    crate::call::origin(url).is_some_and(|o| o == KMEET_ORIGIN)
}

/// kChat's kMeet call post (`custom_call`). A running call is a `videoconf`
/// whose call id is its `conference_id`, joined through the server
/// (`Session::join_call`); one that is over is a `videoconf-ended` carrying its
/// length in seconds, when known.
pub fn kmeet_call(props: &Value) -> (&'static str, String, Option<String>) {
    let (start, end) = (positive(props, "start_at"), positive(props, "end_at"));
    let over = matches!(str_of(props, "status"), Some("ended" | "missed" | "declined" | "cancelled"));
    if end.is_some() || over {
        let seconds = start.zip(end).filter(|(s, e)| e >= s).map(|(s, e)| ((e - s + 500) / 1000).to_string());
        return ("videoconf-ended", seconds.unwrap_or_default(), None);
    }
    ("videoconf", String::new(), str_of(props, "conference_id").map(str::to_owned))
}

fn system(kind: &str, props: &Value, author: Option<&str>) -> Option<(&'static str, Option<String>)> {
    let prop = |key: &str| str_of(props, key).map(str::to_owned);
    let who = || prop("username").or_else(|| author.map(str::to_owned));
    if kind == "custom_call" {
        let (kind, param, _) = kmeet_call(props);
        return Some((kind, Some(param)));
    }
    Some(match kind {
        "system_join_channel" | "system_join_team" => ("uj", who()),
        "system_leave_channel" | "system_leave_team" => ("ul", who()),
        "system_add_to_channel" | "system_add_to_team" => ("au", prop("addedUsername")),
        "system_remove_from_channel" | "system_remove_from_team" => ("ru", prop("removedUsername")),
        "system_header_change" => ("room_changed_topic", Some(prop("new_header").unwrap_or_default())),
        "system_purpose_change" => ("room_changed_description", Some(prop("new_purpose").unwrap_or_default())),
        "system_displayname_change" => ("r", prop("new_displayname")),
        _ => return None,
    })
}

pub fn deleted(post: &Value) -> bool {
    num_of(post, "delete_at") > 0
}

/// Unread ROOT posts (replies live in threads, as on screen) and mentions. A
/// muted channel (`notify_props.mark_unread: "mention"`) counts its mentions only.
pub fn counts(channel: &Value, member: &Value) -> (i64, i64) {
    let rooted = channel.get("total_msg_count_root").is_some_and(Value::is_i64)
        && member.get("msg_count_root").is_some_and(Value::is_i64);
    let unread = if rooted {
        num_of(channel, "total_msg_count_root") - num_of(member, "msg_count_root")
    } else {
        num_of(channel, "total_msg_count") - num_of(member, "msg_count")
    };
    // Mattermost counts every message of a DM as a mention; the list shows a DM's unread count instead.
    let mentions = if str_of(channel, "type") == Some("D") { 0 } else { num_of(member, "mention_count") };
    let muted = member.pointer("/notify_props/mark_unread").and_then(Value::as_str) == Some("mention");
    (if muted { num_of(member, "mention_count") } else { unread.max(0) }, mentions)
}

pub struct Translator<'a> {
    pub directory: &'a Directory,
    pub me: &'a str,
    pub base: &'a str,
}

impl Translator<'_> {
    pub fn message(&self, post: &Value) -> Option<Message> {
        let id = str_of(post, "id")?;
        let rid = str_of(post, "channel_id")?;
        let ts = positive(post, "create_at")?;
        let author_id = str_of(post, "user_id")?;
        if deleted(post) || str_of(post, "type") == Some("system_ephemeral") {
            return None;
        }
        let props = post.get("props").cloned().unwrap_or(Value::Null);
        let author = self.directory.username(author_id);
        let flag = |key: &str| {
            matches!(props.get(key), Some(Value::String(s)) if s == "true")
                || props.get(key) == Some(&Value::Bool(true))
        };
        let webhook = flag("from_webhook");
        let alias = str_of(&props, "override_username").filter(|_| webhook).map(str::to_owned);
        let alias_avatar = str_of(&props, "override_icon_url")
            .filter(|url| webhook && crate::content::is_web_link(url))
            .map(str::to_owned);
        let metadata = post.get("metadata").cloned().unwrap_or(Value::Null);
        let root = str_of(post, "root_id");
        let mm_kind = str_of(post, "type").unwrap_or_default();
        let system = system(mm_kind, &props, author.as_deref());
        let message = str_of(post, "message").unwrap_or_default();
        let text = match &system {
            Some((_, param)) => param.clone(),
            None if mm_kind == "reminder" => {
                Some(reminder(&props, message, self.base).unwrap_or_else(|| message.to_owned()))
            }
            None => Some(message.to_owned()),
        };
        let mut cards = cards(props.get("attachments"));
        cards.extend(self.permalinks(metadata.get("embeds")));
        Some(Message {
            id: id.to_owned(),
            rid: rid.to_owned(),
            text,
            ts,
            author_id: author_id.to_owned(),
            author_name: author.clone(),
            system_type: system.map(|(t, _)| t.to_owned()),
            thread_id: root.map(str::to_owned),
            thread_count: if root.is_none() { num_of(post, "reply_count") } else { 0 },
            thread_last: root.is_none().then(|| positive(post, "last_reply_at")).flatten(),
            thread_shown: false,
            edited_at: positive(post, "edit_at"),
            attachments: join_attachments(attachments(metadata.get("files")), cards),
            reactions: self.reactions(metadata.get("reactions")),
            encrypted_raw: None,
            updated_at: positive(post, "update_at").unwrap_or(ts),
            md: None,
            urls: previews(metadata.get("embeds")),
            call_id: (mm_kind == "custom_call").then(|| kmeet_call(&props).2).flatten(),
            pinned: post.get("is_pinned").and_then(Value::as_bool).unwrap_or(false),
            starred: None,
            thread_followers: None,
            discussion_id: None,
            discussion_count: 0,
            discussion_last: None,
            alias,
            alias_avatar,
            author_bot: webhook || flag("from_bot") || self.directory.user(author_id).is_some_and(|u| u.bot),
        })
    }

    /// Posts linked in the text that the server previews (`permalink` embeds),
    /// as the quotes Rocket.Chat's attachments already render.
    fn permalinks(&self, embeds: Option<&Value>) -> Vec<Value> {
        embeds
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|e| str_of(e, "type") == Some("permalink"))
            .filter_map(|e| {
                let data = e.get("data")?;
                let post = data.get("post")?;
                let id = str_of(post, "id").or_else(|| str_of(data, "post_id"))?;
                let author = str_of(post, "user_id")
                    .and_then(|uid| self.directory.display_name(uid).or_else(|| self.directory.username(uid)));
                let mut quote = json!({
                    "message_link": super::actions::permalink("", id),
                    "permalink_preview": true,
                    "text": str_of(post, "message").unwrap_or_default(),
                });
                if let Some(author) = author {
                    quote["author_name"] = json!(author);
                }
                if let Some(ts) = positive(post, "create_at") {
                    quote["ts"] = json!(ts);
                }
                if let Some(files) =
                    attachments(post.pointer("/metadata/files")).and_then(|f| serde_json::from_str(&f).ok())
                {
                    quote["attachments"] = files;
                }
                Some(quote)
            })
            .collect()
    }

    /// `<idA>__<idB>`: the id that is not mine, or mine for a note-to-self.
    pub fn dm_other(&self, name: &str) -> Option<String> {
        let ids: Vec<&str> = name.split("__").filter(|p| !p.is_empty()).collect();
        if ids.len() != 2 {
            return None;
        }
        Some(ids.iter().find(|p| **p != self.me).copied().unwrap_or(self.me).to_owned())
    }

    pub fn room(&self, channel: &Value, last_post: Option<&Value>) -> Option<Room> {
        let rid = str_of(channel, "id")?;
        let mm_kind = str_of(channel, "type")?;
        let kind = match mm_kind {
            "O" => "c",
            "P" => "p",
            "D" | "G" => "d",
            _ => return None,
        };
        let other = (mm_kind == "D").then(|| self.dm_other(str_of(channel, "name").unwrap_or_default())).flatten();
        let other_user = other.as_deref().and_then(|id| self.directory.user(id));
        let last = last_post.and_then(|p| self.message(p));
        let last_post_at = positive(channel, "last_root_post_at").or_else(|| positive(channel, "last_post_at"));
        let display_name = match mm_kind {
            "D" => other_user.as_ref().map(|u| u.display.clone().unwrap_or_else(|| u.username.clone())),
            "G" => str_of(channel, "display_name").map(|d| self.without_me(d)),
            _ => str_of(channel, "display_name").or_else(|| str_of(channel, "name")).map(str::to_owned),
        };
        Some(Room {
            rid: rid.to_owned(),
            kind: kind.to_owned(),
            name: if mm_kind == "D" {
                other_user.as_ref().map(|u| u.username.clone())
            } else {
                str_of(channel, "name").map(str::to_owned)
            },
            display_name,
            encrypted: false,
            read_only: false,
            dm_other_uid: other,
            last_message: last.as_ref().filter(|m| m.system_type.is_none()).and_then(|m| {
                m.text.clone().filter(|t| !t.is_empty()).or_else(|| preview_of(m.attachments.as_deref()))
            }),
            last_message_type: last.as_ref().and_then(|m| m.system_type.clone()),
            last_message_author: last.as_ref().and_then(|m| m.alias.clone().or_else(|| m.author_name.clone())),
            last_encrypted: None,
            last_message_ts: last.as_ref().map(|m| m.ts).or(last_post_at),
            avatar_etag: None,
            updated_at: num_of(channel, "update_at").max(last_post_at.unwrap_or(0)),
            keep_preview: last_post.is_none(),
        })
    }

    pub fn subscription(&self, channel: &Value, member: &Value) -> Option<Subscription> {
        let rid = str_of(member, "channel_id").or_else(|| str_of(channel, "id"))?;
        let (unread, mentions) = counts(channel, member);
        let owner = str_of(member, "roles").is_some_and(|r| r.split_whitespace().any(|role| role == "channel_admin"));
        Some(Subscription {
            rid: rid.to_owned(),
            sub_id: Some(rid.to_owned()),
            unread,
            mentions,
            group_mentions: 0,
            alert: unread > 0,
            open: true,
            favorite: false,
            last_seen: positive(member, "last_viewed_at"),
            updated_at: num_of(member, "last_update_at").max(num_of(channel, "update_at")),
            e2e_key: None,
            roles: owner.then(|| "owner".to_owned()),
            ..Default::default()
        })
    }

    fn without_me(&self, display: &str) -> String {
        let me = self.directory.username(self.me);
        let others: Vec<&str> =
            display.split(',').map(str::trim).filter(|n| !n.is_empty() && Some(*n) != me.as_deref()).collect();
        let last = others.len().saturating_sub(1);
        let named: Vec<String> = others
            .iter()
            .enumerate()
            .map(|(i, n)| {
                let cut = || (i == last).then(|| self.directory.name_of_cut(n)).flatten();
                self.directory.name_of(n).or_else(cut).unwrap_or_else(|| (*n).to_owned())
            })
            .collect();
        if named.is_empty() { display.to_owned() } else { named.join(", ") }
    }

    fn reactions(&self, raw: Option<&Value>) -> Option<String> {
        let mut grouped: Map<String, Value> = Map::new();
        for reaction in raw?.as_array()? {
            let (Some(emoji), Some(user)) = (str_of(reaction, "emoji_name"), str_of(reaction, "user_id")) else {
                continue;
            };
            let name = self.directory.username(user).unwrap_or_else(|| user.to_owned());
            let bucket = grouped.entry(format!(":{emoji}:")).or_insert_with(|| json!({"usernames": []}));
            if let Some(list) = bucket.get_mut("usernames").and_then(Value::as_array_mut) {
                list.push(json!(name));
            }
        }
        (!grouped.is_empty()).then(|| Value::Object(grouped).to_string())
    }
}

/// A "visible only to you" post (`ephemeral_message`): its room, its words
/// (a reminder's acknowledgement in the app's language), its cards and its id,
/// which its buttons are pressed through.
pub struct Ephemeral {
    pub rid: String,
    pub text: String,
    pub attachments: Option<String>,
    pub post_id: String,
}

impl Translator<'_> {
    pub fn ephemeral(&self, post: &Value) -> Option<Ephemeral> {
        let rid = str_of(post, "channel_id")?.to_owned();
        let post_id = str_of(post, "id")?.to_owned();
        let props = post.get("props").cloned().unwrap_or(Value::Null);
        let message = str_of(post, "message").unwrap_or_default();
        let text = reminder_set(&props, message, self.base).unwrap_or_else(|| message.trim().to_owned());
        let cards = cards(props.get("attachments"));
        let attachments = (!cards.is_empty()).then(|| Value::Array(cards).to_string());
        (!text.is_empty() || attachments.is_some()).then_some(Ephemeral { rid, text, attachments, post_id })
    }
}

/// The acknowledgement of a reminder just set (`props.type: "reminder"`,
/// `target_time` in seconds): the server's English carries an RFC 822 time.
fn reminder_set(props: &Value, message: &str, base: &str) -> Option<String> {
    if str_of(props, "type") != Some("reminder") {
        return None;
    }
    let due = props.get("target_time").and_then(|t| t.as_i64().or_else(|| t.as_str()?.parse().ok()))?;
    let username = str_of(props, "username")?;
    let link = message
        .split_whitespace()
        .find(|w| crate::content::is_web_link(w))
        .map(str::to_owned)
        .or_else(|| post_link(props, base))?;
    Some(crate::i18n::tf(
        "mm.reminder_set",
        &[("user", username), ("link", &link), ("when", &crate::reminders::when(due))],
    ))
}

fn post_link(props: &Value, base: &str) -> Option<String> {
    let (team, post) = (str_of(props, "team_name")?, str_of(props, "post_id")?);
    Some(format!("{}/{team}/pl/{post}", base.trim_end_matches('/')))
}

/// The server's reminder of a post (`type: "reminder"`) in the app's language:
/// its text is the server's English, the link at its end.
fn reminder(props: &Value, message: &str, base: &str) -> Option<String> {
    let username = str_of(props, "username")?;
    let link = message
        .split_whitespace()
        .last()
        .filter(|w| crate::content::is_web_link(w))
        .map(str::to_owned)
        .or_else(|| post_link(props, base))?;
    Some(crate::i18n::tf("mm.reminder", &[("user", username), ("link", &link)]))
}

/// Integrations' Slack-style cards (`props.attachments`), in the shape
/// Rocket.Chat's attachments already render.
fn cards(raw: Option<&Value>) -> Vec<Value> {
    raw.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let a = a.as_object()?;
            let mut card = Map::new();
            for key in ["author_name", "title", "title_link", "color", "fields", "pretext"] {
                if let Some(v) = a.get(key) {
                    card.insert(key.to_owned(), v.clone());
                }
            }
            let buttons: Vec<Value> = a
                .get("actions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|b| matches!(str_of(b, "type"), None | Some("button")))
                .filter_map(|b| {
                    let mut button = json!({"id": str_of(b, "id")?, "name": str_of(b, "name")?});
                    for key in ["style", "cookie"] {
                        if let Some(v) = str_of(b, key) {
                            button[key] = json!(v);
                        }
                    }
                    Some(button)
                })
                .collect();
            if !buttons.is_empty() {
                card.insert("actions".into(), Value::Array(buttons));
            }
            let text =
                ["text", "fallback"].iter().find_map(|k| a.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()));
            if let Some(text) = text {
                card.insert("text".into(), json!(text));
            }
            (!card.is_empty()).then_some(Value::Object(card))
        })
        .collect()
}

fn join_attachments(files: Option<String>, cards: Vec<Value>) -> Option<String> {
    if cards.is_empty() {
        return files;
    }
    let mut list: Vec<Value> = files.and_then(|f| serde_json::from_str(&f).ok()).unwrap_or_default();
    list.extend(cards);
    Some(Value::Array(list).to_string())
}

/// A post with no text: its first card's title or text, else its first file's name.
fn preview_of(attachments: Option<&str>) -> Option<String> {
    let list: Vec<Value> = serde_json::from_str(attachments?).ok()?;
    list.iter().find_map(|a| ["title", "text"].iter().find_map(|k| str_of(a, k).map(str::to_owned)))
}

fn attachments(raw: Option<&Value>) -> Option<String> {
    let mut out = Vec::new();
    for file in raw?.as_array()? {
        let Some(id) = str_of(file, "id") else { continue };
        let name = str_of(file, "name").unwrap_or(id);
        let mime = str_of(file, "mime_type").unwrap_or("application/octet-stream");
        let link = format!("{FILES}/{id}");
        let size = num_of(file, "size");
        let mut a = json!({"title": name, "title_link": link, "type": "file", "size": size});
        if mime.starts_with("image/") {
            let preview = file.get("has_preview_image").and_then(Value::as_bool).unwrap_or(false);
            a["image_url"] = json!(if preview { format!("{link}/preview") } else { link.clone() });
            a["image_type"] = json!(mime);
            a["image_size"] = json!(size);
            let (w, h) = (num_of(file, "width"), num_of(file, "height"));
            if w > 0 && h > 0 {
                a["image_dimensions"] = json!({"width": w, "height": h});
            }
        } else if mime.starts_with("video/") {
            a["video_url"] = json!(link);
            a["video_type"] = json!(mime);
            a["video_size"] = json!(size);
        } else if mime.starts_with("audio/") {
            a["audio_url"] = json!(link);
            a["audio_type"] = json!(mime);
            a["audio_size"] = json!(size);
        }
        out.push(a);
    }
    (!out.is_empty()).then(|| Value::Array(out).to_string())
}

/// OpenGraph embeds to the `urls` shape link cards read.
fn previews(raw: Option<&Value>) -> Option<String> {
    let mut out = Vec::new();
    for embed in raw?.as_array()? {
        if str_of(embed, "type") != Some("opengraph") {
            continue;
        }
        let Some(url) = str_of(embed, "url") else { continue };
        let data = embed.get("data").cloned().unwrap_or(Value::Null);
        let mut meta = Map::new();
        if let Some(t) = str_of(&data, "title") {
            meta.insert("ogTitle".into(), json!(t));
        }
        if let Some(d) = str_of(&data, "description") {
            meta.insert("ogDescription".into(), json!(d));
        }
        if let Some(s) = str_of(&data, "site_name") {
            meta.insert("ogSiteName".into(), json!(s));
        }
        let image = data.get("images").and_then(Value::as_array).and_then(|a| a.first());
        if let Some(i) = image.and_then(|i| str_of(i, "secure_url").or_else(|| str_of(i, "url"))) {
            meta.insert("ogImage".into(), json!(i));
        }
        out.push(json!({"url": url, "meta": meta}));
    }
    (!out.is_empty()).then(|| Value::Array(out).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mattermost::directory::User;

    fn directory() -> Directory {
        let d = Directory::default();
        d.remember(User { id: "u-me".into(), username: "me".into(), display: Some("Me".into()), ..Default::default() });
        d.remember(User {
            id: "u-bob".into(),
            username: "bob".into(),
            display: Some("Bob Builder".into()),
            ..Default::default()
        });
        d
    }

    fn post(id: &str, extra: Value) -> Value {
        let mut p = json!({"id": id, "channel_id": "ch1", "user_id": "u-bob", "message": format!("message {id}"),
            "create_at": 1000, "update_at": 1000, "edit_at": 0, "delete_at": 0, "root_id": "", "type": "", "props": {}, "metadata": {}});
        if let (Some(target), Some(more)) = (p.as_object_mut(), extra.as_object()) {
            target.extend(more.clone());
        }
        p
    }

    #[test]
    fn a_post_names_its_author_and_keeps_server_times() {
        let d = directory();
        let t = Translator { directory: &d, me: "u-me", base: "https://chat.example.com/" };
        let m = t.message(&post("p1", json!({"create_at": 10, "update_at": 20, "edit_at": 15}))).unwrap();
        assert_eq!(m.author_name.as_deref(), Some("bob"));
        assert_eq!((m.ts, m.updated_at, m.edited_at), (10, 20, Some(15)));
        assert!(t.message(&post("p2", json!({"delete_at": 5}))).is_none());
    }

    #[test]
    fn reactions_and_files_take_the_renderers_shapes() {
        let d = directory();
        let t = Translator { directory: &d, me: "u-me", base: "https://chat.example.com/" };
        let m = t
            .message(&post(
                "p1",
                json!({"metadata": {
                    "reactions": [{"user_id": "u-me", "emoji_name": "+1"}, {"user_id": "u-bob", "emoji_name": "+1"}],
                    "files": [{"id": "f1", "name": "cat.png", "mime_type": "image/png", "size": 9, "width": 4, "height": 3, "has_preview_image": true}]
                }}),
            ))
            .unwrap();
        let reactions: Value = serde_json::from_str(m.reactions.as_deref().unwrap()).unwrap();
        assert_eq!(reactions[":+1:"]["usernames"], json!(["me", "bob"]));
        let files: Value = serde_json::from_str(m.attachments.as_deref().unwrap()).unwrap();
        assert_eq!(files[0]["image_url"], json!("/api/v4/files/f1/preview"));
    }

    #[test]
    fn an_integration_posts_under_its_own_name_and_picture() {
        let d = directory();
        let t = Translator { directory: &d, me: "u-me", base: "https://chat.example.com/" };
        let hook = t
            .message(&post(
                "p1",
                json!({"props": {"from_webhook": "true", "override_username": "Uptime-Kuma",
                    "override_icon_url": "https://example.com/kuma.png"}}),
            ))
            .unwrap();
        assert_eq!(hook.author_name.as_deref(), Some("bob"));
        assert_eq!(hook.alias.as_deref(), Some("Uptime-Kuma"));
        assert_eq!(hook.alias_avatar.as_deref(), Some("https://example.com/kuma.png"));
        assert!(hook.author_bot);
        let claimed = t
            .message(&post("p2", json!({"props": {"override_username": "Admin", "override_icon_url": "/x.png"}})))
            .unwrap();
        assert_eq!((claimed.alias, claimed.alias_avatar, claimed.author_bot), (None, None, false));
        assert!(t.message(&post("p3", json!({"props": {"from_bot": "true"}}))).unwrap().author_bot);
        d.remember(User { id: "u-euria".into(), username: "euria".into(), bot: true, ..Default::default() });
        assert!(t.message(&post("p4", json!({"user_id": "u-euria"}))).unwrap().author_bot);
    }

    #[test]
    fn a_reminder_reads_in_the_apps_language_and_quotes_its_post() {
        let d = directory();
        let t = Translator { directory: &d, me: "u-me", base: "https://chat.example.com/" };
        let link = "https://chat.example.com/team/pl/p0";
        let m = t
            .message(&post(
                "p1",
                json!({"type": "reminder", "message": format!("Hi there, here's your reminder about this message from @bob: {link}"),
                    "props": {"username": "bob", "team_name": "team", "post_id": "p0"},
                    "metadata": {"embeds": [{"type": "permalink", "data": {"post_id": "p0",
                        "post": {"id": "p0", "user_id": "u-bob", "message": "test pra", "create_at": 5}}}]}}),
            ))
            .unwrap();
        assert_eq!(m.system_type, None);
        let text = m.text.unwrap();
        assert!(text.contains("@bob") && text.ends_with(link), "{text}");
        let quotes = crate::content::quotes(m.attachments.as_deref());
        assert_eq!(quotes.len(), 1);
        assert_eq!((quotes[0].author.as_deref(), quotes[0].text.as_str()), (Some("Bob Builder"), "test pra"));
        let props = json!({"username": "bob", "team_name": "team", "post_id": "p0"});
        let bare = t.message(&post("p2", json!({"type": "reminder", "message": "Hi there", "props": props}))).unwrap();
        assert!(bare.text.as_deref().unwrap().ends_with(link), "{:?}", bare.text);
        let mut set = props.clone();
        set["type"] = json!("reminder");
        set["target_time"] = json!(1_792_400_400);
        let ack = t.ephemeral(&json!({"id": "e1", "channel_id": "ch1", "message": "Set", "props": set})).unwrap();
        assert!(ack.text.contains(&format!("]({link})")), "{}", ack.text);
    }

    #[test]
    fn an_ephemeral_post_is_never_a_message() {
        let d = directory();
        let t = Translator { directory: &d, me: "u-me", base: "https://chat.example.com/" };
        assert!(t.message(&post("p1", json!({"type": "system_ephemeral"}))).is_none());
    }

    #[test]
    fn a_post_for_me_alone_keeps_its_buttons_and_reads_a_reminder_in_my_language() {
        let d = directory();
        let t = Translator { directory: &d, me: "u-me", base: "https://chat.example.com/" };
        let note = t
            .ephemeral(&json!({"id": "e1", "channel_id": "ch1", "message": "",
                "props": {"attachments": [{"text": "Remind?", "actions": [
                    {"id": "del", "name": "Delete", "style": "danger", "cookie": "c1"},
                    {"id": "menu", "name": "Pick", "type": "select"},
                    {"id": "", "name": "Nameless id"}]}]}}))
            .unwrap();
        assert_eq!((note.rid.as_str(), note.post_id.as_str(), note.text.as_str()), ("ch1", "e1", ""));
        let card = crate::content::cards(note.attachments.as_deref()).remove(0);
        assert_eq!(
            card.actions,
            [crate::content::CardAction {
                id: "del".into(),
                name: "Delete".into(),
                style: "danger".into(),
                cookie: Some("c1".into())
            }]
        );
        let link = "https://chat.example.com/team/pl/p0";
        let ack = t
            .ephemeral(&json!({"id": "e2", "channel_id": "ch1",
                "message": format!("You will be reminded about {link} by @bob at 19 Oct 26 09:00 UTC"),
                "props": {"type": "reminder", "target_time": 1_792_400_400, "username": "bob", "team_name": "team", "post_id": "p0"}}))
            .unwrap();
        assert!(ack.text.contains(&format!("]({link})")) && ack.text.contains("@bob"), "{}", ack.text);
        assert!(!ack.text.contains("UTC"));
        assert!(t.ephemeral(&json!({"id": "e3", "channel_id": "ch1", "message": "  "})).is_none());
    }

    #[test]
    fn a_cards_pretext_stays_above_it() {
        let d = directory();
        let t = Translator { directory: &d, me: "u-me", base: "https://chat.example.com/" };
        let m = t
            .message(&post(
                "p1",
                json!({"message": "", "props": {"attachments": [{"pretext": "New **access** request",
                    "title": ":file_folder: [MGP](https://drive.example.com/f/1)", "text": "stp"}]}}),
            ))
            .unwrap();
        let card = crate::content::cards(m.attachments.as_deref()).remove(0);
        assert_eq!(card.pretext.as_deref(), Some("New **access** request"));
        assert_eq!(card.text.as_deref(), Some("stp"));
    }

    #[test]
    fn system_posts_and_threads() {
        let d = directory();
        let t = Translator { directory: &d, me: "u-me", base: "https://chat.example.com/" };
        let joined =
            t.message(&post("p1", json!({"type": "system_join_channel", "props": {"username": "bob"}}))).unwrap();
        assert_eq!((joined.system_type.as_deref(), joined.text.as_deref()), (Some("uj"), Some("bob")));
        assert_eq!(t.message(&post("p2", json!({"root_id": "p1"}))).unwrap().thread_id.as_deref(), Some("p1"));
        let root = t.message(&post("p1", json!({"reply_count": 3, "last_reply_at": 50}))).unwrap();
        assert_eq!((root.thread_count, root.thread_last), (3, Some(50)));
    }

    #[test]
    fn rooms_and_memberships() {
        let d = directory();
        let t = Translator { directory: &d, me: "u-me", base: "https://chat.example.com/" };
        let dm = t.room(&json!({"id": "d1", "type": "D", "name": "u-bob__u-me"}), None).unwrap();
        assert_eq!(
            (dm.kind.as_str(), dm.name.as_deref(), dm.display_name.as_deref()),
            ("d", Some("bob"), Some("Bob Builder"))
        );
        let group =
            t.room(&json!({"id": "g1", "type": "G", "name": "x", "display_name": "bob, me, carol"}), None).unwrap();
        assert_eq!(group.display_name.as_deref(), Some("Bob Builder, carol"));
        let sub = t
            .subscription(
                &json!({"id": "ch1", "total_msg_count": 30, "total_msg_count_root": 10}),
                &json!({"channel_id": "ch1", "msg_count": 20, "msg_count_root": 7, "mention_count": 2, "roles": "channel_user channel_admin"}),
            )
            .unwrap();
        assert_eq!((sub.unread, sub.mentions, sub.roles.as_deref()), (3, 2, Some("owner")));
        let dm = json!({"id": "d1", "type": "D", "total_msg_count_root": 4});
        assert_eq!(counts(&dm, &json!({"msg_count_root": 1, "mention_count": 3})), (3, 0));
        let channel = json!({"id": "ch1", "total_msg_count_root": 10});
        let muted = json!({"msg_count_root": 2, "mention_count": 1, "notify_props": {"mark_unread": "mention"}});
        assert_eq!(counts(&channel, &muted), (1, 1), "a muted channel counts its mentions only");
    }

    #[test]
    fn nested_documents_as_strings_or_objects() {
        assert_eq!(object(&json!("{\"a\":1}")).unwrap()["a"], json!(1));
        assert_eq!(object(&json!({"a": 1})).unwrap()["a"], json!(1));
        assert!(object(&json!("[1]")).is_none());
    }

    #[test]
    fn kmeet_call_posts() {
        let running = kmeet_call(
            &json!({"url": "https://kmeet.infomaniak.com/r1", "conference_id": "c1", "status": "calling", "start_at": 1000}),
        );
        assert_eq!(running, ("videoconf", String::new(), Some("c1".to_owned())));
        let ended = kmeet_call(
            &json!({"url": "https://kmeet.infomaniak.com/r1", "status": "ended", "start_at": 1000, "end_at": 2_888_000}),
        );
        assert_eq!(ended, ("videoconf-ended", "2887".to_owned(), None));
        assert_eq!(kmeet_call(&json!({"status": "missed"})).1, "");
        assert_eq!(kmeet_call(&json!({"url": "javascript:alert(1)"})).2, None);
    }
}
