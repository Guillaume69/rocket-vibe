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

/// kChat's kMeet call post (`custom_call`): `props.url` is the meeting, joined
/// as is. A running call is a `videoconf` whose call id is that URL; one that
/// is over is a `videoconf-ended` carrying its length in seconds, when known.
pub fn kmeet_call(props: &Value) -> (&'static str, String, Option<String>) {
    let (start, end) = (positive(props, "start_at"), positive(props, "end_at"));
    let over = matches!(str_of(props, "status"), Some("ended" | "missed" | "declined" | "cancelled"));
    if end.is_some() || over {
        let seconds = start.zip(end).filter(|(s, e)| e >= s).map(|(s, e)| ((e - s + 500) / 1000).to_string());
        return ("videoconf-ended", seconds.unwrap_or_default(), None);
    }
    ("videoconf", String::new(), str_of(props, "url").filter(|u| is_kmeet(u)).map(str::to_owned))
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

/// Unread ROOT posts (replies live in threads, as on screen) and mentions.
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
    (unread.max(0), mentions)
}

pub struct Translator<'a> {
    pub directory: &'a Directory,
    pub me: &'a str,
}

impl Translator<'_> {
    pub fn message(&self, post: &Value) -> Option<Message> {
        let id = str_of(post, "id")?;
        let rid = str_of(post, "channel_id")?;
        let ts = positive(post, "create_at")?;
        let author_id = str_of(post, "user_id")?;
        if deleted(post) {
            return None;
        }
        let props = post.get("props").cloned().unwrap_or(Value::Null);
        let author = self.directory.username(author_id);
        let author_name = str_of(&props, "override_username").map(str::to_owned).or_else(|| author.clone());
        let metadata = post.get("metadata").cloned().unwrap_or(Value::Null);
        let root = str_of(post, "root_id");
        let mm_kind = str_of(post, "type").unwrap_or_default();
        let system = system(mm_kind, &props, author.as_deref());
        let text = match &system {
            Some((_, param)) => param.clone(),
            None => Some(str_of(post, "message").unwrap_or_default().to_owned()),
        };
        Some(Message {
            id: id.to_owned(),
            rid: rid.to_owned(),
            text,
            ts,
            author_id: author_id.to_owned(),
            author_name,
            system_type: system.map(|(t, _)| t.to_owned()),
            thread_id: root.map(str::to_owned),
            thread_count: if root.is_none() { num_of(post, "reply_count") } else { 0 },
            thread_last: root.is_none().then(|| positive(post, "last_reply_at")).flatten(),
            thread_shown: false,
            edited_at: positive(post, "edit_at"),
            attachments: attachments(metadata.get("files")),
            reactions: self.reactions(metadata.get("reactions")),
            encrypted_raw: None,
            updated_at: positive(post, "update_at").unwrap_or(ts),
            md: None,
            urls: previews(metadata.get("embeds")),
            call_id: (mm_kind == "custom_call").then(|| kmeet_call(&props).2).flatten(),
            pinned: post.get("is_pinned").and_then(Value::as_bool).unwrap_or(false),
            starred: None,
        })
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
            last_message: last.as_ref().filter(|m| m.system_type.is_none()).and_then(|m| m.text.clone()),
            last_message_type: last.as_ref().and_then(|m| m.system_type.clone()),
            last_message_author: last.as_ref().and_then(|m| m.author_name.clone()),
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
        if others.is_empty() { display.to_owned() } else { others.join(", ") }
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

/// Files as Rocket.Chat-shaped attachments on the file API, images with their preview.
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
        d.remember(User { id: "u-me".into(), username: "me".into(), display: Some("Me".into()) });
        d.remember(User { id: "u-bob".into(), username: "bob".into(), display: Some("Bob Builder".into()) });
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
        let t = Translator { directory: &d, me: "u-me" };
        let m = t.message(&post("p1", json!({"create_at": 10, "update_at": 20, "edit_at": 15}))).unwrap();
        assert_eq!(m.author_name.as_deref(), Some("bob"));
        assert_eq!((m.ts, m.updated_at, m.edited_at), (10, 20, Some(15)));
        assert!(t.message(&post("p2", json!({"delete_at": 5}))).is_none());
    }

    #[test]
    fn reactions_and_files_take_the_renderers_shapes() {
        let d = directory();
        let t = Translator { directory: &d, me: "u-me" };
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
    fn system_posts_and_threads() {
        let d = directory();
        let t = Translator { directory: &d, me: "u-me" };
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
        let t = Translator { directory: &d, me: "u-me" };
        let dm = t.room(&json!({"id": "d1", "type": "D", "name": "u-bob__u-me"}), None).unwrap();
        assert_eq!(
            (dm.kind.as_str(), dm.name.as_deref(), dm.display_name.as_deref()),
            ("d", Some("bob"), Some("Bob Builder"))
        );
        let group =
            t.room(&json!({"id": "g1", "type": "G", "name": "x", "display_name": "bob, me, carol"}), None).unwrap();
        assert_eq!(group.display_name.as_deref(), Some("bob, carol"));
        let sub = t
            .subscription(
                &json!({"id": "ch1", "total_msg_count": 30, "total_msg_count_root": 10}),
                &json!({"channel_id": "ch1", "msg_count": 20, "msg_count_root": 7, "mention_count": 2, "roles": "channel_user channel_admin"}),
            )
            .unwrap();
        assert_eq!((sub.unread, sub.mentions, sub.roles.as_deref()), (3, 2, Some("owner")));
        let dm = json!({"id": "d1", "type": "D", "total_msg_count_root": 4});
        assert_eq!(counts(&dm, &json!({"msg_count_root": 1, "mention_count": 3})), (3, 0));
    }

    #[test]
    fn nested_documents_as_strings_or_objects() {
        assert_eq!(object(&json!("{\"a\":1}")).unwrap()["a"], json!(1));
        assert_eq!(object(&json!({"a": 1})).unwrap()["a"], json!(1));
        assert!(object(&json!("[1]")).is_none());
    }

    #[test]
    fn kmeet_call_posts() {
        let running =
            kmeet_call(&json!({"url": "https://kmeet.infomaniak.com/r1", "status": "started", "start_at": 1000}));
        assert_eq!(running, ("videoconf", String::new(), Some("https://kmeet.infomaniak.com/r1".to_owned())));
        let ended = kmeet_call(
            &json!({"url": "https://kmeet.infomaniak.com/r1", "status": "ended", "start_at": 1000, "end_at": 2_888_000}),
        );
        assert_eq!(ended, ("videoconf-ended", "2887".to_owned(), None));
        assert_eq!(kmeet_call(&json!({"status": "missed"})).1, "");
        assert_eq!(kmeet_call(&json!({"url": "javascript:alert(1)"})).2, None);
    }
}
