//! Teams into the store's rows: the aggregator's chats and channels as rooms
//! and read states, the chat service's messages (HTML) as the markdown the
//! renderer reads, emotions as reactions.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::normalize::{Message, Room, Subscription};

/// A message id: the conversation and the server id, which is only unique within it.
pub fn message_id(conversation: &str, id: &str) -> String {
    format!("{conversation}/{id}")
}

/// The conversation and the server id of a message id.
pub fn split_id(id: &str) -> Option<(&str, &str)> {
    let (conversation, server) = id.rsplit_once('/')?;
    (!conversation.is_empty() && !server.is_empty() && server.bytes().all(|b| b.is_ascii_digit()))
        .then_some((conversation, server))
}

/// The message's link in Teams itself.
pub fn permalink(rid: &str, msg_id: &str) -> String {
    let server = split_id(msg_id).map_or(msg_id, |(_, id)| id);
    let mut url = url::Url::parse("https://teams.microsoft.com/l/message/").expect("Teams link base");
    url.path_segments_mut().expect("https base").pop_if_empty().extend([rid, server]);
    url.to_string()
}

pub fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// A number Teams sends as a string or a number.
pub fn int_of(v: &Value, key: &str) -> Option<i64> {
    match v.get(key)? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn instant(v: &Value, key: &str) -> Option<i64> {
    let raw = str_of(v, key)?;
    chrono::DateTime::parse_from_rfc3339(raw).ok().map(|t| t.timestamp_millis())
}

/// The MRI at the end of a `from` contact link, or the MRI itself.
pub fn mri_of(from: &str) -> &str {
    from.rsplit('/').next().unwrap_or(from)
}

/// The conversation a pushed or listed resource belongs to.
pub fn conversation_of(resource: &Value) -> Option<String> {
    let link = str_of(resource, "conversationLink").or_else(|| str_of(resource, "conversationid"))?;
    let tail = link.rsplit("/conversations/").next().unwrap_or(link);
    let conversation = tail.split(';').next().unwrap_or(tail);
    let decoded = percent_decoded(conversation);
    (!decoded.is_empty()).then_some(decoded)
}

fn percent_decoded(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match (bytes[i], bytes.get(i + 1).copied().and_then(hex), bytes.get(i + 2).copied().and_then(hex)) {
            (b'%', Some(hi), Some(lo)) => {
                out.push((hi * 16 + lo) as u8);
                i += 3;
            }
            (b, _, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| raw.to_owned())
}

/// The reply chain root of a channel message (`;messageid=`), when not itself.
fn root_of(resource: &Value, id: &str) -> Option<String> {
    let link = str_of(resource, "conversationLink")?;
    let root = link.split(";messageid=").nth(1)?;
    (root != id && root.bytes().all(|b| b.is_ascii_digit())).then(|| root.to_owned())
}

/// The emotions property, an array or the same array in a JSON string.
fn emotions(raw: &Value) -> Vec<Value> {
    match raw.pointer("/properties/emotions") {
        Some(Value::Array(list)) => list.clone(),
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Teams' classic reaction keys and their shortcodes.
const KEYS: [(&str, &str); 6] = [
    ("like", "+1"),
    ("heart", "heart"),
    ("laugh", "laughing"),
    ("surprised", "open_mouth"),
    ("sad", "cry"),
    ("angry", "angry"),
];

/// The shortcode a reaction key shows as: a classic key, or a `<codepoints>_<name>` key's name.
pub fn reaction_code(key: &str) -> String {
    if let Some((_, code)) = KEYS.iter().find(|(k, _)| *k == key) {
        return (*code).to_owned();
    }
    key.split_once('_').map(|(_, name)| name).filter(|n| !n.is_empty()).unwrap_or(key).to_owned()
}

/// The key a shortcode is sent as; only the classic keys are known to be accepted.
pub fn reaction_key(shortcode: &str) -> Option<&'static str> {
    let code = shortcode.trim_matches(':');
    let code = match code {
        "thumbsup" | "thumbs_up" => "+1",
        "joy" | "laughing" | "satisfied" => "laughing",
        "heart" | "red_heart" => "heart",
        "astonished" | "hushed" | "open_mouth" => "open_mouth",
        "cry" | "sob" | "disappointed" => "cry",
        "angry" | "rage" => "angry",
        other => other,
    };
    KEYS.iter().find(|(_, c)| *c == code).map(|(k, _)| *k)
}

/// People named by MRI: display names from messages, members and profiles.
#[derive(Default)]
pub struct Directory {
    names: std::sync::Mutex<HashMap<String, String>>,
}

impl Directory {
    pub fn remember(&self, mri: &str, name: &str) {
        let name = name.trim();
        if !mri.is_empty() && !name.is_empty() {
            self.names.lock().unwrap().insert(mri.to_owned(), name.to_owned());
        }
    }

    pub fn name(&self, mri: &str) -> Option<String> {
        self.names.lock().unwrap().get(mri).cloned()
    }

    pub fn known(&self, mri: &str) -> bool {
        self.names.lock().unwrap().contains_key(mri)
    }

    /// An MRI's name, or the MRI when nobody has said it.
    pub fn shown(&self, mri: &str) -> String {
        self.name(mri).unwrap_or_else(|| mri.to_owned())
    }

    /// Learns the sender's display name from a message.
    pub fn learn(&self, raw: &Value) {
        if let (Some(from), Some(name)) = (str_of(raw, "from"), str_of(raw, "imdisplayname")) {
            self.remember(mri_of(from), name);
        }
    }
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let start = lower.find(&format!("{name}="))? + name.len() + 1;
    let rest = &tag[start..];
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        rest[1..].split(quote).next()
    } else {
        rest.split(|c: char| c.is_whitespace() || c == '>').next()
    }
}

/// Teams' message HTML to markdown: paragraphs, breaks, emphasis, code, links,
/// lists, quotes, mentions (`@Name`) and emoji (`alt`). Scripts, styles and
/// remote images are dropped.
pub fn html_to_markdown(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    let mut lists: Vec<Option<u32>> = Vec::new();
    let mut link: Option<String> = None;
    let mut link_text_start = 0;
    let mut pre = false;
    while let Some(start) = rest.find('<') {
        push_text(&mut out, &rest[..start], pre);
        rest = &rest[start..];
        if rest.starts_with("<!--") {
            rest = rest.find("-->").map_or("", |end| &rest[end + 3..]);
            continue;
        }
        let Some(end) = rest.find('>') else {
            rest = "";
            break;
        };
        let tag = &rest[1..end];
        rest = &rest[end + 1..];
        let closing = tag.starts_with('/');
        let name = tag.trim_start_matches('/').split(|c: char| !c.is_ascii_alphanumeric()).next().unwrap_or("");
        let name = name.to_ascii_lowercase();
        match (name.as_str(), closing) {
            ("script" | "style", false) => {
                let lower = rest.to_ascii_lowercase();
                rest = lower.find(&format!("</{name}")).map_or("", |close| &rest[close..]);
            }
            ("br", _) => out.push('\n'),
            ("p" | "div", true) => out.push('\n'),
            ("b" | "strong", _) => out.push_str("**"),
            ("i" | "em", _) => out.push('_'),
            ("s" | "strike" | "del", _) => out.push_str("~~"),
            ("code", _) if !pre => out.push('`'),
            ("pre", false) => {
                pre = true;
                out.push_str("\n```\n");
            }
            ("pre", true) => {
                pre = false;
                out.push_str("\n```\n");
            }
            ("blockquote", false) => out.push_str("\n> "),
            ("blockquote", true) => out.push('\n'),
            ("ul", false) => lists.push(None),
            ("ol", false) => lists.push(Some(0)),
            ("ul" | "ol", true) => {
                lists.pop();
                out.push('\n');
            }
            ("li", false) => {
                let depth = lists.len().saturating_sub(1);
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
                match lists.last_mut() {
                    Some(Some(n)) => {
                        *n += 1;
                        out.push_str(&format!("{n}. "));
                    }
                    _ => out.push_str("- "),
                }
            }
            ("a", false) => {
                link = attribute(tag, "href")
                    .filter(|h| h.starts_with("https://") || h.starts_with("http://"))
                    .map(crate::content::decode_entities);
                link_text_start = out.len();
            }
            ("a", true) => {
                if let Some(href) = link.take() {
                    let text = out[link_text_start..].to_owned();
                    out.truncate(link_text_start);
                    if text.trim().is_empty() || text.trim() == href {
                        out.push_str(&href);
                    } else {
                        out.push_str(&format!("[{}]({href})", text.trim()));
                    }
                }
            }
            ("span", false) if attribute(tag, "itemtype").is_some_and(|t| t.ends_with("/Mention")) => out.push('@'),
            ("img", _) => {
                let emoji = attribute(tag, "itemtype").is_some_and(|t| t.ends_with("/Emoji"));
                if let Some(alt) = attribute(tag, "alt").filter(|_| emoji) {
                    out.push_str(&crate::content::decode_entities(alt));
                }
            }
            _ => {}
        }
    }
    push_text(&mut out, rest, pre);
    let lines: Vec<&str> = out.lines().map(str::trim_end).collect();
    let mut joined = lines.join("\n");
    while joined.contains("\n\n\n") {
        joined = joined.replace("\n\n\n", "\n\n");
    }
    joined.trim().to_owned()
}

fn push_text(out: &mut String, text: &str, pre: bool) {
    let decoded = crate::content::decode_entities(text);
    if pre {
        out.push_str(&decoded);
    } else {
        let collapsed: String = decoded.split(['\n', '\r']).collect::<Vec<_>>().join(" ");
        out.push_str(&collapsed.replace('\u{a0}', " "));
    }
}

/// A message's text: HTML for `RichText/Html`, plain otherwise.
pub fn body_text(raw: &Value) -> String {
    let content = str_of(raw, "content").unwrap_or_default();
    let html = str_of(raw, "messagetype").is_some_and(|t| t.starts_with("RichText"))
        || str_of(raw, "contenttype").is_some_and(|t| t.eq_ignore_ascii_case("html"));
    if html { html_to_markdown(content) } else { crate::content::decode_entities(content).trim().to_owned() }
}

pub fn deleted(raw: &Value) -> bool {
    int_of(raw.get("properties").unwrap_or(&Value::Null), "deletetime").is_some_and(|t| t > 0)
}

fn tag_value<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let start = xml.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = xml[start..].find(&format!("</{tag}>"))?;
    Some(&xml[start..start + end])
}

fn system(raw: &Value, directory: &Directory) -> Option<(&'static str, Option<String>)> {
    let kind = str_of(raw, "messagetype")?.strip_prefix("ThreadActivity/")?;
    let content = str_of(raw, "content").unwrap_or_default();
    let target = || tag_value(content, "target").or_else(|| tag_value(content, "id")).map(|m| directory.shown(m));
    match kind {
        "AddMember" => Some(("au", target())),
        "DeleteMember" => Some(("ru", target())),
        "TopicUpdate" => Some(("room_changed_topic", tag_value(content, "value").map(crate::content::decode_entities))),
        _ => None,
    }
}

/// One chat service message, or None for a kind the app does not show.
pub fn message(conversation: &str, raw: &Value, directory: &Directory) -> Option<Message> {
    let id = str_of(raw, "id").map(str::to_owned).or_else(|| int_of(raw, "id").map(|n| n.to_string()))?;
    let kind = str_of(raw, "messagetype").unwrap_or_default();
    let shown = matches!(kind, "Text" | "RichText/Html" | "RichText") || kind.starts_with("ThreadActivity/");
    if !shown || deleted(raw) {
        return None;
    }
    directory.learn(raw);
    let author = str_of(raw, "from").map(mri_of).unwrap_or_default().to_owned();
    let system = system(raw, directory);
    if kind.starts_with("ThreadActivity/") && system.is_none() {
        return None;
    }
    let at = instant(raw, "originalarrivaltime").or_else(|| instant(raw, "composetime")).or_else(|| id.parse().ok())?;
    let props = raw.get("properties").cloned().unwrap_or(Value::Null);
    let edited_at = int_of(&props, "edittime").filter(|t| *t > 0);
    let text = match &system {
        Some((_, param)) => param.clone(),
        None => Some(body_text(raw)),
    };
    let thread_id = root_of(raw, &id).map(|root| message_id(conversation, &root));
    Some(Message {
        id: message_id(conversation, &id),
        rid: conversation.to_owned(),
        text,
        ts: at,
        author_name: Some(directory.shown(&author)),
        author_id: author,
        system_type: system.map(|(t, _)| t.to_owned()),
        thread_id,
        edited_at,
        attachments: None,
        reactions: reactions(raw, directory),
        updated_at: edited_at.unwrap_or(at).max(int_of(raw, "version").unwrap_or(0)),
        ..Default::default()
    })
}

fn reactions(raw: &Value, directory: &Directory) -> Option<String> {
    let mut grouped = Map::new();
    for emotion in emotions(raw) {
        let Some(key) = str_of(&emotion, "key") else { continue };
        let users: Vec<Value> = emotion
            .get("users")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|u| str_of(u, "mri"))
            .map(|mri| json!(directory.shown(mri)))
            .collect();
        if !users.is_empty() {
            grouped.insert(format!(":{}:", reaction_code(key)), json!({"usernames": users}));
        }
    }
    (!grouped.is_empty()).then(|| Value::Object(grouped).to_string())
}

/// Whether I am among a message's reactions under `key`.
pub fn reacted(raw: &Value, key: &str, me: &str) -> bool {
    emotions(raw).iter().any(|e| {
        str_of(e, "key") == Some(key)
            && e.get("users").and_then(Value::as_array).is_some_and(|u| u.iter().any(|u| str_of(u, "mri") == Some(me)))
    })
}

/// The last message the aggregator carries for a chat or channel.
fn preview(last: &Value, directory: &Directory) -> Option<(String, Option<String>, i64)> {
    let kind = str_of(last, "messageType").unwrap_or_default();
    if !matches!(kind, "Text" | "RichText/Html" | "RichText") {
        return None;
    }
    let raw = json!({"content": last.get("content"), "messagetype": kind});
    let author = str_of(last, "from").map(mri_of);
    if let (Some(mri), Some(name)) = (author, str_of(last, "imDisplayName")) {
        directory.remember(mri, name);
    }
    let at = instant(last, "composeTime").or_else(|| int_of(last, "id"))?;
    Some((body_text(&raw), author.map(|m| directory.shown(m)), at))
}

fn last_at(entry: &Value) -> Option<i64> {
    entry.get("lastMessage").and_then(|l| instant(l, "composeTime").or_else(|| int_of(l, "id")))
}

/// An aggregator chat as a room; `names` are its other members' names when known.
pub fn chat_room(me: &str, chat: &Value, directory: &Directory) -> Option<Room> {
    let rid = str_of(chat, "id")?;
    let members: Vec<&str> = chat
        .get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| str_of(m, "mri"))
        .filter(|m| *m != me)
        .collect();
    let one_on_one = chat.get("isOneOnOne").and_then(Value::as_bool) == Some(true);
    let meeting = str_of(chat, "chatType") == Some("meeting");
    let last = chat.get("lastMessage").and_then(|l| preview(l, directory));
    let others: Vec<String> = members.iter().map(|m| directory.shown(m)).collect();
    let title = str_of(chat, "title").map(str::to_owned);
    let display = title.or_else(|| (!others.is_empty()).then(|| others.join(", ")));
    let at = last.as_ref().map(|(_, _, at)| *at).or_else(|| last_at(chat));
    Some(Room {
        rid: rid.to_owned(),
        kind: if meeting { "p" } else { "d" }.to_owned(),
        name: display.clone().or_else(|| Some(rid.to_owned())),
        display_name: display,
        dm_other_uid: one_on_one.then(|| members.first().map(|m| (*m).to_owned())).flatten(),
        last_message: last.as_ref().map(|(text, _, _)| text.clone()),
        last_message_author: last.as_ref().and_then(|(_, author, _)| author.clone()),
        last_message_ts: at,
        updated_at: at.or_else(|| instant(chat, "createdAt")).unwrap_or(0),
        keep_preview: last.is_none(),
        ..Default::default()
    })
}

/// An aggregator channel as a room, filed under its team.
pub fn channel_room(channel: &Value, directory: &Directory) -> Option<Room> {
    let rid = str_of(channel, "id")?;
    let name = str_of(channel, "displayName").map(str::to_owned).unwrap_or_else(|| "General".to_owned());
    let last = channel.get("lastMessage").and_then(|l| preview(l, directory));
    let at = last.as_ref().map(|(_, _, at)| *at).or_else(|| last_at(channel));
    Some(Room {
        rid: rid.to_owned(),
        kind: if str_of(channel, "channelType").is_some_and(|t| t != "Standard") { "p" } else { "c" }.to_owned(),
        name: Some(name.clone()),
        display_name: Some(name),
        last_message: last.as_ref().map(|(text, _, _)| text.clone()),
        last_message_author: last.as_ref().and_then(|(_, author, _)| author.clone()),
        last_message_ts: at,
        updated_at: at.unwrap_or(0),
        keep_preview: last.is_none(),
        ..Default::default()
    })
}

/// The read horizon's message id (its arrival instant), when set.
pub fn horizon(entry: &Value) -> Option<i64> {
    entry.get("consumptionHorizon").and_then(|h| int_of(h, "originalArrivalTime")).filter(|t| *t > 0)
}

/// An aggregator chat's or channel's read state. Teams gives no count: one
/// unread room counts one, its mentions are not known.
pub fn subscription(rid: &str, entry: &Value, me: &str, updated_at: i64, team: Option<(&str, &str)>) -> Subscription {
    let read_flag = entry.get("isRead").or_else(|| entry.get("isMessageRead")).and_then(Value::as_bool);
    let mine = entry.get("isLastMessageFromMe").and_then(Value::as_bool) == Some(true)
        || entry.pointer("/lastMessage/from").and_then(Value::as_str).is_some_and(|f| mri_of(f) == me);
    let newer = match (last_at(entry), horizon(entry)) {
        (Some(last), Some(seen)) => last > seen,
        (Some(_), None) => true,
        _ => false,
    };
    let unread = !mine && read_flag.map_or(newer, |read| !read);
    let hidden = entry.get("hidden").and_then(Value::as_bool) == Some(true)
        || entry.get("isConversationDeleted").and_then(Value::as_bool) == Some(true);
    Subscription {
        rid: rid.to_owned(),
        sub_id: Some(rid.to_owned()),
        unread: i64::from(unread),
        alert: unread,
        open: !hidden,
        favorite: entry.get("isFavorite").and_then(Value::as_bool) == Some(true),
        last_seen: horizon(entry),
        updated_at,
        group_id: team.map(|(id, _)| id.to_owned()),
        group_name: team.map(|(_, name)| name.to_owned()),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_split_on_the_last_slash() {
        let id = message_id("19:abc@thread.v2", "1792540504421");
        assert_eq!(split_id(&id), Some(("19:abc@thread.v2", "1792540504421")));
        assert_eq!(split_id("19:abc@thread.v2"), None);
        assert_eq!(split_id("19:abc/12x"), None);
        assert_eq!(
            permalink("19:abc@thread.v2", &id),
            "https://teams.microsoft.com/l/message/19:abc@thread.v2/1792540504421"
        );
    }

    #[test]
    fn html_becomes_markdown() {
        let html = concat!(
            "<p>Hi <span itemtype=\"http://schema.skype.com/Mention\" itemscope itemid=\"0\">Ada</span>,</p>",
            "<p><b>bold</b> <i>it</i> <s>gone</s> <code>x()</code> &amp; ",
            "<a href=\"https://example.com/a?b=1&amp;c=2\">a link</a></p>",
            "<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>",
            "<img itemtype=\"http://schema.skype.com/Emoji\" alt=\"😀\" src=\"https://x\">",
            "<img src=\"https://tracker.example/p.gif\">",
            "<script>alert(1)</script><style>p{}</style>",
        );
        let md = html_to_markdown(html);
        assert!(md.starts_with("Hi @Ada,"), "{md}");
        assert!(md.contains("**bold** _it_ ~~gone~~ `x()` & [a link](https://example.com/a?b=1&c=2)"), "{md}");
        assert!(md.contains("- one\n- two") && md.contains("1. first"), "{md}");
        assert!(md.contains('😀'), "{md}");
        assert!(!md.contains("alert") && !md.contains("tracker") && !md.contains("p{}"), "{md}");
        assert_eq!(html_to_markdown("<a href=\"javascript:x\">click</a>"), "click");
        assert_eq!(html_to_markdown("<pre>a\n  b</pre>"), "```\na\n  b\n```");
    }

    fn raw(id: &str, extra: Value) -> Value {
        let mut m = json!({
            "id": id, "messagetype": "RichText/Html", "contenttype": "text", "content": "<p>hello</p>",
            "from": "https://teams.microsoft.com/api/chatsvc/fr/v1/users/ME/contacts/8:orgid:aaa",
            "imdisplayname": "Ada", "originalarrivaltime": "2026-10-20T23:55:21.726Z", "version": id,
            "conversationLink": "https://teams.microsoft.com/api/chatsvc/fr/v1/users/ME/conversations/19:c@thread.v2",
        });
        if let (Value::Object(m), Value::Object(e)) = (&mut m, extra) {
            m.extend(e);
        }
        m
    }

    #[test]
    fn messages_edits_reactions_and_deletions() {
        let d = Directory::default();
        let m = message("19:c@thread.v2", &raw("1792540521726", json!({})), &d).unwrap();
        assert_eq!(m.id, "19:c@thread.v2/1792540521726");
        assert_eq!(m.text.as_deref(), Some("hello"));
        assert_eq!((m.author_id.as_str(), m.author_name.as_deref()), ("8:orgid:aaa", Some("Ada")));
        assert_eq!(m.ts, 1792540521726);
        let edited = raw(
            "1792540521726",
            json!({"properties": {"edittime": "1792540590172", "emotions": [
                {"key": "like", "users": [{"mri": "8:orgid:aaa", "time": 1, "value": "1"}]},
                {"key": "heart", "users": []},
                {"key": "1f525_fire", "users": [{"mri": "8:orgid:bbb"}]}
            ]}}),
        );
        let m = message("19:c@thread.v2", &edited, &d).unwrap();
        assert_eq!(m.edited_at, Some(1792540590172));
        let reactions: Value = serde_json::from_str(m.reactions.as_deref().unwrap()).unwrap();
        assert_eq!(reactions[":+1:"]["usernames"], json!(["Ada"]));
        assert_eq!(reactions[":fire:"]["usernames"], json!(["8:orgid:bbb"]));
        assert!(reactions.get(":heart:").is_none());
        assert!(reacted(&edited, "like", "8:orgid:aaa") && !reacted(&edited, "heart", "8:orgid:aaa"));
        let gone = raw("1792540521726", json!({"content": "", "properties": {"deletetime": "1792540597454"}}));
        assert!(deleted(&gone) && message("19:c@thread.v2", &gone, &d).is_none());
        let as_string =
            raw("5", json!({"properties": {"emotions": "[{\"key\":\"laugh\",\"users\":[{\"mri\":\"m\"}]}]"}}));
        assert!(message("c", &as_string, &d).unwrap().reactions.unwrap().contains(":laughing:"));
    }

    #[test]
    fn replies_activities_and_skipped_kinds() {
        let d = Directory::default();
        d.remember("8:orgid:bbb", "Bob");
        let reply = raw(
            "20",
            json!({"conversationLink": "https://t/v1/users/ME/conversations/19:ch@thread.tacv2;messageid=10"}),
        );
        assert_eq!(conversation_of(&reply).as_deref(), Some("19:ch@thread.tacv2"));
        assert_eq!(
            conversation_of(&json!({"conversationLink": "https://t/conversations/19%3Ax%40thread.v2"})).as_deref(),
            Some("19:x@thread.v2")
        );
        assert_eq!(
            message("19:ch@thread.tacv2", &reply, &d).unwrap().thread_id.as_deref(),
            Some("19:ch@thread.tacv2/10")
        );
        let root = raw("10", json!({"conversationLink": "https://t/conversations/19:ch@thread.tacv2;messageid=10"}));
        assert_eq!(message("19:ch@thread.tacv2", &root, &d).unwrap().thread_id, None);
        let added = raw(
            "30",
            json!({"messagetype": "ThreadActivity/AddMember", "content": "<addmember><eventtime>1</eventtime><target>8:orgid:bbb</target></addmember>"}),
        );
        let m = message("c", &added, &d).unwrap();
        assert_eq!((m.system_type.as_deref(), m.text.as_deref()), (Some("au"), Some("Bob")));
        for kind in ["Event/Call", "ThreadActivity/MemberJoined", "Control/Typing"] {
            assert!(message("c", &raw("40", json!({"messagetype": kind})), &d).is_none(), "{kind}");
        }
    }

    #[test]
    fn reaction_keys_both_ways() {
        assert_eq!(reaction_code("like"), "+1");
        assert_eq!(reaction_code("1f525_fire"), "fire");
        assert_eq!(reaction_key(":thumbsup:"), Some("like"));
        assert_eq!(reaction_key("joy"), Some("laugh"));
        assert_eq!(reaction_key("fire"), None);
    }

    #[test]
    fn chats_channels_and_read_state() {
        let d = Directory::default();
        let me = "8:orgid:me";
        let chat = json!({
            "id": "19:x@thread.v2", "chatType": "chat", "isOneOnOne": true, "isRead": false,
            "members": [{"mri": me}, {"mri": "8:orgid:bbb"}],
            "consumptionHorizon": {"originalArrivalTime": 100, "timeStamp": 101, "clientMessageId": "1"},
            "lastMessage": {"messageType": "RichText/Html", "content": "<p>yo</p>", "from": "8:orgid:bbb",
                "imDisplayName": "Bob", "composeTime": "2026-10-20T23:55:21.726Z", "id": "1792540521726"},
        });
        let room = chat_room(me, &chat, &d).unwrap();
        assert_eq!((room.kind.as_str(), room.display_name.as_deref()), ("d", Some("Bob")));
        assert_eq!((room.last_message.as_deref(), room.last_message_author.as_deref()), (Some("yo"), Some("Bob")));
        assert_eq!(room.dm_other_uid.as_deref(), Some("8:orgid:bbb"));
        let sub = subscription("19:x@thread.v2", &chat, me, 5, None);
        assert!(sub.alert && sub.unread == 1 && sub.open && sub.last_seen == Some(100));
        let mut mine = chat.clone();
        mine["isLastMessageFromMe"] = json!(true);
        assert!(!subscription("r", &mine, me, 5, None).alert);
        let meeting =
            json!({"id": "19:m@thread.v2", "chatType": "meeting", "title": "Standup", "isRead": true, "hidden": true});
        let room = chat_room(me, &meeting, &d).unwrap();
        assert_eq!((room.kind.as_str(), room.name.as_deref()), ("p", Some("Standup")));
        assert!(!subscription("r", &meeting, me, 5, None).open);
        let channel = json!({"id": "19:g@thread.tacv2", "displayName": "General", "isMessageRead": true, "channelType": "Standard"});
        assert_eq!(channel_room(&channel, &d).unwrap().kind, "c");
        let sub = subscription("19:g@thread.tacv2", &channel, me, 5, Some(("team", "Ops")));
        assert_eq!((sub.group_name.as_deref(), sub.alert), (Some("Ops"), false));
    }
}
