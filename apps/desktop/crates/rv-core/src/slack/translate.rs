//! Slack documents to the store's rows: ids and instants, mrkdwn to the
//! app's markdown, and the Rocket.Chat shapes the renderer already knows.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::directory::Directory;
use super::exact_timestamp;
use crate::normalize::{Message, Room, Subscription};

/// `<channel>:<ts>`, `ts` being Slack's exact decimal string.
pub fn message_id(channel: &str, ts: &str) -> String {
    format!("{channel}:{ts}")
}

/// The channel and the exact `ts` of a message id.
pub fn split_id(id: &str) -> Option<(&str, &str)> {
    let (channel, ts) = id.split_once(':')?;
    exact_timestamp(ts).ok()?;
    Some((channel, ts))
}

/// Milliseconds of an exact `ts`, the microseconds cut: for display and order only.
pub fn ts_ms(ts: &str) -> Option<i64> {
    let (seconds, fraction) = exact_timestamp(ts).ok()?;
    let seconds: i64 = seconds.parse().ok()?;
    let micros: i64 = fraction.parse().ok()?;
    seconds.checked_mul(1000)?.checked_add(micros / 1000)
}

/// The latest `ts` a millisecond can hold, for a bound only known in milliseconds.
pub fn last_ts_of(ms: i64) -> String {
    format!("{}.{:03}999", ms.div_euclid(1000), ms.rem_euclid(1000))
}

pub fn first_ts_of(ms: i64) -> String {
    format!("{}.{:03}000", ms.div_euclid(1000), ms.rem_euclid(1000))
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Slack's mrkdwn to the markdown the renderer reads. Outside code: people,
/// channels and links resolved, `*bold*` and `~strike~` doubled; everywhere:
/// the three entities Slack escapes, last.
pub fn mrkdwn(text: &str, user: &dyn Fn(&str) -> Option<String>, channel: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while !rest.is_empty() {
        let (plain, code, after) = next_code(rest);
        out.push_str(&super::emojis::replace(&plain_mrkdwn(plain, user, channel)));
        out.push_str(code);
        rest = after;
    }
    unescape(&out)
}

/// Splits off the text before the next code block or span, the code itself, and what follows.
fn next_code(text: &str) -> (&str, &str, &str) {
    let mut from = 0;
    while let Some(at) = text[from..].find('`').map(|i| i + from) {
        let end = if text[at..].starts_with("```") {
            text[at + 3..].find("```").map(|i| at + 3 + i + 3)
        } else {
            text[at + 1..].find(['`', '\n']).filter(|i| text[at + 1 + i..].starts_with('`')).map(|i| at + 1 + i + 1)
        };
        match end {
            Some(end) => return (&text[..at], &text[at..end], &text[end..]),
            None => from = at + 1,
        }
    }
    (text, "", "")
}

const HOLE_START: char = '\u{E000}';
const HOLE_END: char = '\u{E001}';

fn plain_mrkdwn(text: &str, user: &dyn Fn(&str) -> Option<String>, channel: &dyn Fn(&str) -> Option<String>) -> String {
    let mut held = Vec::new();
    let mut with_holes = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        let Some(close) = rest[open..].find(['>', '\n']).filter(|i| rest[open + i..].starts_with('>')) else {
            with_holes.push_str(&rest[..=open]);
            rest = &rest[open + 1..];
            continue;
        };
        with_holes.push_str(&rest[..open]);
        with_holes.push_str(&format!("{HOLE_START}{}{HOLE_END}", held.len()));
        held.push(reference(&rest[open + 1..open + close], user, channel));
        rest = &rest[open + close + 1..];
    }
    with_holes.push_str(rest);
    let styled = emphasis(&emphasis(&with_holes, '*', "**"), '~', "~~");
    let mut out = String::new();
    let mut rest = styled.as_str();
    while let Some(start) = rest.find(HOLE_START) {
        out.push_str(&rest[..start]);
        let after = &rest[start + HOLE_START.len_utf8()..];
        let end = after.find(HOLE_END).unwrap_or(after.len());
        out.push_str(after[..end].parse::<usize>().ok().and_then(|i| held.get(i)).map_or("", String::as_str));
        rest = after.get(end + HOLE_END.len_utf8()..).unwrap_or("");
    }
    out.push_str(rest);
    out
}

/// One `<...>` of mrkdwn.
fn reference(inner: &str, user: &dyn Fn(&str) -> Option<String>, channel: &dyn Fn(&str) -> Option<String>) -> String {
    let (target, label) = match inner.split_once('|') {
        Some((t, l)) => (t, Some(l).filter(|l| !l.is_empty())),
        None => (inner, None),
    };
    if let Some(id) = target.strip_prefix('@') {
        return match user(id) {
            Some(name) => format!("@{name}"),
            None => format!("@{}", label.map_or(id, |l| l.trim_start_matches('@'))),
        };
    }
    if let Some(id) = target.strip_prefix('#') {
        return format!("#{}", label.map(str::to_owned).or_else(|| channel(id)).unwrap_or_else(|| id.to_owned()));
    }
    if let Some(special) = target.strip_prefix('!') {
        return match special {
            "here" => "@here".to_owned(),
            "channel" | "everyone" => "@all".to_owned(),
            _ => match (special.strip_prefix("subteam^"), label) {
                (_, Some(label)) => label.to_owned(),
                (Some(team), None) => format!("@{team}"),
                (None, None) => String::new(),
            },
        };
    }
    match label {
        Some(label) if label != target => format!("[{label}]({target})"),
        _ => target.to_owned(),
    }
}

/// `*b*` to `**b**`: a delimiter opens after a boundary before a non-space,
/// closes after a non-space before a boundary, on the same line.
/// A UUID-shaped `client_msg_id`, the same for the same outbox row id; the
/// mobile app derives it the same way.
pub fn client_msg_id(row_id: &str) -> String {
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let (mut a, mut b) = (0xcbf2_9ce4_8422_2325_u64, 0x8422_2325_cbf2_9ce4_u64);
    for c in row_id.chars() {
        let code = u64::from(c);
        a = (a ^ code).wrapping_mul(PRIME);
        b = (b ^ (code + 0x9e)).wrapping_mul(PRIME);
    }
    let mut hex: Vec<char> = format!("{a:016x}{b:016x}").chars().collect();
    hex[12] = '4';
    hex[16] = ['8', '9', 'a', 'b'][(hex[16].to_digit(16).unwrap_or(0) & 3) as usize];
    let h: String = hex.into_iter().collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// The app's markdown into Slack's mrkdwn, for what is sent. Code goes as
/// typed; outside it Slack's three entities are escaped first, links become
/// `<url|label>`, known `@usernames` `<@id>`, `@all`/`@here` Slack's
/// broadcasts, `**bold**` `*bold*`, `*italic*` `_italic_`, `~~strike~~` `~strike~`.
pub fn markdown_to_mrkdwn(text: &str, id_of: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while !rest.is_empty() {
        let (plain, code, after) = next_code(rest);
        out.push_str(&outgoing(plain, id_of));
        out.push_str(code);
        rest = after;
    }
    out
}

const BOLD: char = '\u{E002}';

fn outgoing(text: &str, id_of: &dyn Fn(&str) -> Option<String>) -> String {
    let escaped = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let mut held = Vec::new();
    let linked = links(&escaped, &mut held);
    let mentioned = mentions(&linked, id_of, &mut held);
    let bold = spans(&mentioned, "**", &BOLD.to_string(), false);
    let italic = spans(&bold, "*", "_", true);
    let styled = spans(&italic.replace(BOLD, "*"), "~~", "~", false);
    let mut out = String::new();
    let mut rest = styled.as_str();
    while let Some(start) = rest.find(HOLE_START) {
        out.push_str(&rest[..start]);
        let after = &rest[start + HOLE_START.len_utf8()..];
        let end = after.find(HOLE_END).unwrap_or(after.len());
        out.push_str(after[..end].parse::<usize>().ok().and_then(|i| held.get(i)).map_or("", String::as_str));
        rest = after.get(end + HOLE_END.len_utf8()..).unwrap_or("");
    }
    out.push_str(rest);
    out
}

fn hole(held: &mut Vec<String>, value: String) -> String {
    held.push(value);
    format!("{HOLE_START}{}{HOLE_END}", held.len() - 1)
}

/// `[label](https://…)` into a held `<url|label>`.
fn links(text: &str, held: &mut Vec<String>) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let parsed = rest[open + 1..].find("](").and_then(|mid| {
            let label = &rest[open + 1..open + 1 + mid];
            let url_start = open + 1 + mid + 2;
            let close = rest[url_start..].find(')')?;
            let url = &rest[url_start..url_start + close];
            let valid = !label.is_empty()
                && !label.contains(['\n', ']'])
                && (url.starts_with("https://") || url.starts_with("http://"))
                && !url.contains(char::is_whitespace);
            valid.then(|| (label.replace('|', "/"), url.to_owned(), url_start + close + 1))
        });
        match parsed {
            Some((label, url, end)) => {
                out.push_str(&rest[..open]);
                out.push_str(&hole(held, format!("<{url}|{label}>")));
                rest = &rest[end..];
            }
            None => {
                out.push_str(&rest[..=open]);
                rest = &rest[open + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn mentions(text: &str, id_of: &dyn Fn(&str) -> Option<String>, held: &mut Vec<String>) -> String {
    let chars: Vec<char> = text.chars().collect();
    let name_char = |c: &char| c.is_alphanumeric() || matches!(c, '_' | '.' | '-');
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let starts = chars[i] == '@'
            && i.checked_sub(1)
                .and_then(|p| chars.get(p))
                .is_none_or(|c| !(c.is_alphanumeric() || *c == '_' || *c == '@'));
        let name: String = if starts {
            let end = (i + 1..chars.len()).find(|j| !name_char(&chars[*j])).unwrap_or(chars.len());
            chars[i + 1..end].iter().collect()
        } else {
            String::new()
        };
        let name = name.trim_end_matches(['.', '-']);
        if name.is_empty() {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let target = match name {
            "all" | "channel" | "everyone" => Some("<!channel>".to_owned()),
            "here" => Some("<!here>".to_owned()),
            _ => id_of(name).map(|id| format!("<@{id}>")),
        };
        match target {
            Some(target) => {
                out.push_str(&hole(held, target));
                i += 1 + name.chars().count();
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// Each `delim…delim` on one line, non-blank at both inner edges, rewrapped in
/// `with`; `bounded` also wants no word character just outside.
fn spans(text: &str, delim: &str, with: &str, bounded: bool) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find(delim) {
        let inner = &rest[open + delim.len()..];
        let before = rest[..open].chars().next_back();
        let found = (!inner.starts_with(char::is_whitespace)
            && !inner.starts_with(delim.chars().next().unwrap_or(' '))
            && (!bounded || before.is_none_or(|c| !c.is_alphanumeric())))
        .then(|| inner.find(delim))
        .flatten()
        .filter(|close| {
            let body = &inner[..*close];
            let after = inner[close + delim.len()..].chars().next();
            !body.is_empty()
                && !body.contains('\n')
                && !body.ends_with(char::is_whitespace)
                && (!bounded || after.is_none_or(|c| !c.is_alphanumeric()))
        });
        match found {
            Some(close) => {
                out.push_str(&rest[..open]);
                out.push_str(with);
                out.push_str(&inner[..close]);
                out.push_str(with);
                rest = &inner[close + delim.len()..];
            }
            None => {
                out.push_str(&rest[..open + delim.len()]);
                rest = inner;
            }
        }
    }
    out.push_str(rest);
    out
}

fn emphasis(text: &str, delimiter: char, doubled: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let boundary =
        |c: Option<&char>| c.is_none_or(|c| c.is_whitespace() || (c.is_ascii_punctuation() && *c != delimiter));
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let opens = chars[i] == delimiter
            && boundary(i.checked_sub(1).and_then(|p| chars.get(p)))
            && chars.get(i + 1).is_some_and(|c| !c.is_whitespace() && *c != delimiter);
        let close = opens
            .then(|| {
                (i + 2..chars.len())
                    .take_while(|j| chars[*j] != '\n')
                    .find(|j| chars[*j] == delimiter && !chars[j - 1].is_whitespace() && boundary(chars.get(j + 1)))
            })
            .flatten();
        match close {
            Some(j) => {
                out.push_str(doubled);
                out.extend(&chars[i + 1..j]);
                out.push_str(doubled);
                i = j + 1;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// The user ids a message names: its author, its reactions and its mentions.
pub fn people(message: &Value) -> Vec<String> {
    let mut ids: Vec<String> = str_of(message, "user").map(str::to_owned).into_iter().collect();
    for reaction in message.get("reactions").and_then(Value::as_array).into_iter().flatten() {
        ids.extend(
            reaction
                .get("users")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|u| u.as_str().map(str::to_owned)),
        );
    }
    let text = str_of(message, "text").unwrap_or_default();
    for (at, _) in text.match_indices("<@") {
        let id: String = text[at + 2..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        ids.push(id);
    }
    ids
}

/// Messages Slack hides, or keeps as the tombstone of a deleted thread root.
/// A huddle's message (`huddle_thread`) as the call message kChat's calls
/// also become: running, a `videoconf` whose call id is the huddle's Slack
/// URL (huddles have no API to join: the card's Join opens it in the
/// browser); over, a `videoconf-ended` carrying its length in seconds, when
/// known. The end arrives as an edit of the same message.
pub fn huddle_call(raw: &Value, channel: &str) -> Option<(&'static str, String, Option<String>)> {
    if str_of(raw, "subtype") != Some("huddle_thread") {
        return None;
    }
    let room = raw.get("room").unwrap_or(&Value::Null);
    let seconds =
        |key: &str| room.get(key).and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok())).filter(|s| *s > 0);
    if room.get("has_ended").and_then(Value::as_bool) == Some(true) || seconds("date_end").is_some() {
        let length = seconds("date_start").zip(seconds("date_end")).filter(|(start, end)| end >= start);
        return Some((
            "videoconf-ended",
            length.map(|(start, end)| (end - start).to_string()).unwrap_or_default(),
            None,
        ));
    }
    Some(("videoconf", String::new(), str_of(raw, "team").and_then(|team| huddle_url(team, channel))))
}

/// The page of Slack's web app that starts or joins a room's huddle in the
/// browser itself. The `huddle/<team>/<channel>` link Slack gives only offers
/// to launch its desktop app.
pub fn huddle_url(team: &str, channel: &str) -> Option<String> {
    let id = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    (team.starts_with('T') && id(team) && id(channel))
        .then(|| format!("https://app.slack.com/client/{team}/{channel}?open=start_huddle"))
}

/// A huddle's page as [`huddle_url`] builds it, a stored `huddle/` link
/// included; any other Slack page as is, anything else refused.
pub fn huddle_page(link: &str) -> Option<String> {
    if !slack_web(link) {
        return None;
    }
    let url = url::Url::parse(link).ok()?;
    let parts: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();
    match parts.as_slice() {
        ["huddle", team, channel] => huddle_url(team, channel),
        _ => Some(link.to_owned()),
    }
}

/// An `https` page of Slack's own web app, the only kind a huddle opens.
pub fn slack_web(link: &str) -> bool {
    url::Url::parse(link).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.host_str().is_some_and(|h| h == "slack.com" || h.ends_with(".slack.com"))
    })
}

pub fn skipped(message: &Value) -> bool {
    message.get("hidden").and_then(Value::as_bool) == Some(true)
        || matches!(str_of(message, "subtype"), Some("tombstone" | "message_deleted" | "message_changed"))
}

pub struct Translator<'a> {
    pub directory: &'a Directory,
    /// Channel names by id, for a `<#C1>` without its label.
    pub channels: &'a HashMap<String, String>,
}

impl Translator<'_> {
    fn text(&self, raw: &str) -> String {
        let user = |id: &str| self.directory.username(id);
        let channel = |id: &str| self.channels.get(id).cloned();
        mrkdwn(raw, &user, &channel)
    }

    pub fn message(&self, channel: &str, raw: &Value) -> Option<Message> {
        if skipped(raw) {
            return None;
        }
        let ts = str_of(raw, "ts")?;
        let at = ts_ms(ts)?;
        let subtype = str_of(raw, "subtype");
        let user = str_of(raw, "user");
        let bot = str_of(raw, "bot_id");
        let author_id = user.or(bot).unwrap_or_default().to_owned();
        let author_name = match (user, subtype) {
            (Some(id), s) if s != Some("bot_message") => {
                Some(self.directory.username(id).unwrap_or_else(|| id.to_owned()))
            }
            _ => bot.and_then(|b| self.directory.bot(b)).or_else(|| str_of(raw, "username").map(str::to_owned)),
        };
        let system = match subtype {
            Some("channel_join") => Some(("uj", author_name.clone())),
            Some("channel_leave") => Some(("ul", author_name.clone())),
            Some("channel_topic") => {
                Some(("room_changed_topic", Some(self.text(str_of(raw, "topic").unwrap_or_default()))))
            }
            Some("channel_purpose") => {
                Some(("room_changed_description", Some(self.text(str_of(raw, "purpose").unwrap_or_default()))))
            }
            _ => None,
        };
        let huddle = huddle_call(raw, channel);
        let system = huddle.as_ref().map(|(kind, param, _)| (*kind, Some(param.clone()))).or(system);
        let text = match &system {
            Some((_, param)) => param.clone(),
            None => {
                let mut text = self.text(str_of(raw, "text").unwrap_or_default());
                let files: Vec<&str> = raw
                    .get("files")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|f| str_of(f, "name").or_else(|| str_of(f, "title")))
                    .collect();
                if !files.is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(&format!("📎 {}", files.join(", ")));
                }
                Some(text)
            }
        };
        let thread_ts = str_of(raw, "thread_ts").filter(|t| *t != ts && exact_timestamp(t).is_ok());
        let root = thread_ts.is_none() && str_of(raw, "thread_ts") == Some(ts);
        let edited_at = raw.pointer("/edited/ts").and_then(Value::as_str).and_then(ts_ms);
        Some(Message {
            id: message_id(channel, ts),
            rid: channel.to_owned(),
            text,
            ts: at,
            author_id,
            author_name,
            system_type: system.map(|(t, _)| t.to_owned()),
            thread_id: thread_ts.map(|t| message_id(channel, t)),
            thread_count: if root { raw.get("reply_count").and_then(Value::as_i64).unwrap_or(0) } else { 0 },
            thread_last: root.then(|| str_of(raw, "latest_reply").and_then(ts_ms)).flatten(),
            thread_shown: thread_ts.is_some() && subtype == Some("thread_broadcast"),
            edited_at,
            attachments: None,
            reactions: self.reactions(raw.get("reactions")),
            encrypted_raw: None,
            updated_at: edited_at.unwrap_or(at),
            md: None,
            urls: None,
            call_id: huddle.and_then(|(_, _, link)| link),
            pinned: false,
            starred: None,
            thread_followers: None,
            discussion_id: None,
            discussion_count: 0,
            discussion_last: None,
        })
    }

    fn reactions(&self, raw: Option<&Value>) -> Option<String> {
        let mut grouped = Map::new();
        for reaction in raw?.as_array()? {
            let Some(name) = str_of(reaction, "name") else { continue };
            let users: Vec<Value> = reaction
                .get("users")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|id| json!(self.directory.username(id).unwrap_or_else(|| id.to_owned())))
                .collect();
            let key = format!(":{}:", super::emojis::reaction_code(name));
            match grouped.get_mut(&key).and_then(|g| g.get_mut("usernames")).and_then(Value::as_array_mut) {
                Some(known) => known.extend(users),
                None => _ = grouped.insert(key, json!({"usernames": users})),
            }
        }
        (!grouped.is_empty()).then(|| Value::Object(grouped).to_string())
    }

    /// A `users.conversations` entry, with its newest message when read.
    pub fn room(&self, me: &str, conversation: &Value, latest: Option<i64>, last: Option<&Message>) -> Option<Room> {
        let rid = str_of(conversation, "id")?;
        let is = |key: &str| conversation.get(key).and_then(Value::as_bool) == Some(true);
        let kind = if is("is_im") || is("is_mpim") {
            "d"
        } else if is("is_private") {
            "p"
        } else {
            "c"
        };
        let (name, display_name, other) = if is("is_im") {
            let other = str_of(conversation, "user").map(str::to_owned);
            let user = other.as_deref().and_then(|id| self.directory.user(id));
            let name = user.as_ref().map(|u| u.username.clone()).or_else(|| other.clone());
            (name, user.and_then(|u| u.display), other)
        } else if is("is_mpim") {
            let name = str_of(conversation, "name").map(str::to_owned);
            let mine = self.directory.username(me);
            let members: Vec<String> = mpim_members(name.as_deref().unwrap_or_default())
                .into_iter()
                .filter(|m| Some(m) != mine.as_ref())
                .map(|m| self.directory.name_of(&m).unwrap_or(m))
                .collect();
            (name, (!members.is_empty()).then(|| members.join(", ")), None)
        } else {
            let name = str_of(conversation, "name").map(str::to_owned);
            (name.clone(), name, None)
        };
        let updated = conversation.get("updated").and_then(Value::as_i64).unwrap_or(0);
        let last_ts = last.map(|m| m.ts).or(latest);
        Some(Room {
            rid: rid.to_owned(),
            kind: kind.to_owned(),
            name,
            display_name,
            encrypted: false,
            read_only: false,
            dm_other_uid: other,
            last_message: last.filter(|m| m.system_type.is_none()).and_then(|m| m.text.clone()),
            last_message_type: last.and_then(|m| m.system_type.clone()),
            last_message_author: last.and_then(|m| m.author_name.clone()),
            last_encrypted: None,
            last_message_ts: last_ts,
            avatar_etag: None,
            updated_at: updated.max(last_ts.unwrap_or(0)),
            keep_preview: last.is_none(),
        })
    }
}

/// `mpdm-alice--bob--carol-1`: the usernames of a group conversation.
pub fn mpim_members(name: &str) -> Vec<String> {
    let Some(inner) = name.strip_prefix("mpdm-") else { return Vec::new() };
    let inner = inner.rsplit_once('-').filter(|(_, n)| n.chars().all(|c| c.is_ascii_digit())).map_or(inner, |(i, _)| i);
    inner.split("--").filter(|n| !n.is_empty()).map(str::to_owned).collect()
}

/// A `client.counts` entry. A failed read of the counts leaves every room unread-free.
pub fn subscription(rid: &str, counts: Option<&Value>, updated_at: i64, open: bool) -> Subscription {
    let unreads = counts.and_then(|c| c.get("has_unreads")).and_then(Value::as_bool) == Some(true);
    let mentions = counts.and_then(|c| c.get("mention_count")).and_then(Value::as_i64).unwrap_or(0).max(0);
    Subscription {
        rid: rid.to_owned(),
        sub_id: Some(rid.to_owned()),
        unread: if unreads { mentions.max(1) } else { 0 },
        mentions,
        alert: unreads,
        open,
        last_seen: counts.and_then(|c| str_of(c, "last_read")).and_then(ts_ms),
        updated_at,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outgoing_markdown_becomes_mrkdwn() {
        let id_of = |u: &str| (u == "alice").then(|| "U001".to_owned());
        let out = |t: &str| markdown_to_mrkdwn(t, &id_of);
        assert_eq!(out("**b** *i* ~~s~~"), "*b* _i_ ~s~");
        assert_eq!(
            out("see [docs](https://x.test/a) @alice @bob @here @all"),
            "see <https://x.test/a|docs> <@U001> @bob <!here> <!channel>"
        );
        assert_eq!(out("a < b & `<@x> **y**`"), "a &lt; b &amp; `<@x> **y**`");
        assert_eq!(out("mail me@alice.test, thanks @alice."), "mail me@alice.test, thanks <@U001>.");
        assert_eq!(out("2*3*4 stays"), "2*3*4 stays");
    }

    #[test]
    fn a_huddle_is_a_call_whose_id_is_its_slack_page() {
        let message = |room: Value| json!({"type": "message", "subtype": "huddle_thread", "team": "T1", "ts": "1.000000", "room": room});
        let call = |room: Value, channel: &str| huddle_call(&message(room), channel).unwrap();
        assert_eq!(
            call(json!({"huddle_link": "https://app.slack.com/huddle/T1/C1"}), "C1"),
            ("videoconf", String::new(), Some("https://app.slack.com/client/T1/C1?open=start_huddle".to_owned()))
        );
        assert_eq!(call(json!({}), "D1").2.as_deref(), Some("https://app.slack.com/client/T1/D1?open=start_huddle"));
        assert_eq!(
            huddle_page("https://app.slack.com/huddle/T1/C1").as_deref(),
            Some("https://app.slack.com/client/T1/C1?open=start_huddle")
        );
        assert_eq!(huddle_page("https://evil.example/huddle/T1/C1"), None);
        assert_eq!(
            call(json!({"date_start": 1000, "date_end": 1600}), "C1"),
            ("videoconf-ended", "600".to_owned(), None)
        );
        assert_eq!(call(json!({"has_ended": true}), "C1"), ("videoconf-ended", String::new(), None));
        assert!(huddle_call(&json!({"type": "message", "ts": "1.000000"}), "C1").is_none());
        assert_eq!(huddle_url("T1", "C1/../x"), None);
    }

    #[test]
    fn client_msg_ids_match_the_mobile_derivation() {
        let id = client_msg_id("local1");
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!("89ab".contains(&id[19..20]));
        assert_eq!(id, "e0e3bce0-03ec-40bb-ba25-48e1d317a4c2");
        assert_eq!(client_msg_id("é€😀"), "ea94271b-fa1a-4248-91ff-07fb275a64b5");
        assert_ne!(client_msg_id("local2"), id);
    }
    use crate::slack::directory::User;

    fn directory() -> Directory {
        let directory = Directory::default();
        for (id, username, display) in [("U001", "alice", "Ali"), ("U002", "bob", "Bobby"), ("U000", "me", "Me")] {
            directory.remember(User {
                id: id.into(),
                username: username.into(),
                display: Some(display.into()),
                ..Default::default()
            });
        }
        directory
    }

    fn convert(text: &str) -> String {
        let d = directory();
        let channels = HashMap::from([("C001".to_owned(), "general".to_owned())]);
        Translator { directory: &d, channels: &channels }.text(text)
    }

    #[test]
    fn mrkdwn_people_channels_and_specials() {
        assert_eq!(convert("hi <@U001> and <@U009|zed>, <@U008>"), "hi @alice and @zed, @U008");
        assert_eq!(convert("see <#C001> and <#C002|random> or <#C003>"), "see #general and #random or #C003");
        assert_eq!(convert("<!here> <!channel> <!everyone> <!subteam^S001|@devs>"), "@here @all @all @devs");
    }

    #[test]
    fn mrkdwn_links_styles_and_escapes() {
        assert_eq!(
            convert("<https://example.test/a?b=1&amp;c=2|the doc> <https://example.test>"),
            "[the doc](https://example.test/a?b=1&c=2) https://example.test"
        );
        assert_eq!(convert("*bold* _it_ ~gone~ 2*3*4 * not *"), "**bold** _it_ ~~gone~~ 2*3*4 * not *");
        assert_eq!(convert("*hi <@U001>*"), "**hi @alice**");
        assert_eq!(convert("a &lt;b&gt; &amp;lt; c"), "a <b> &lt; c");
        assert_eq!(convert("<https://example.test/~x/|~x~>"), "[~x~](https://example.test/~x/)");
    }

    #[test]
    fn mrkdwn_leaves_code_alone() {
        assert_eq!(convert("`*a* <@U001>` *b*"), "`*a* <@U001>` **b**");
        assert_eq!(convert("```\n*a* &lt;x&gt;\n<#C001>```\n~c~"), "```\n*a* <x>\n<#C001>```\n~~c~~");
        assert_eq!(convert("lone ` *d*"), "lone ` **d**");
    }

    #[test]
    fn ids_and_instants_are_exact() {
        assert_eq!(ts_ms("1700000000.123456"), Some(1_700_000_000_123));
        assert_eq!(ts_ms("1700000000.000999"), Some(1_700_000_000_000));
        assert_eq!(ts_ms("1700000000.12"), None);
        assert_eq!(message_id("C001", "1700000000.123456"), "C001:1700000000.123456");
        assert_eq!(split_id("C001:1700000000.123456"), Some(("C001", "1700000000.123456")));
        assert_eq!(split_id("C001:17000"), None);
        assert_eq!(last_ts_of(1_700_000_000_123), "1700000000.123999");
        assert_eq!(first_ts_of(1_700_000_000_007), "1700000000.007000");
        let (a, b) = (message_id("C001", "1700000000.000100"), message_id("C001", "1700000000.000900"));
        assert_eq!(ts_ms("1700000000.000100"), ts_ms("1700000000.000900"));
        assert!(a < b, "same millisecond: the id orders them");
    }

    #[test]
    fn messages_threads_reactions_and_subtypes() {
        let d = directory();
        let channels = HashMap::new();
        let t = Translator { directory: &d, channels: &channels };
        let root = t
            .message(
                "C001",
                &json!({"ts": "1700000000.000100", "user": "U001", "text": "root", "thread_ts": "1700000000.000100",
                    "reply_count": 2, "latest_reply": "1700000050.500000", "edited": {"ts": "1700000010.000000"},
                    "reactions": [{"name": "+1", "users": ["U001", "U002"], "count": 2}]}),
            )
            .unwrap();
        assert_eq!(root.id, "C001:1700000000.000100");
        assert_eq!((root.thread_id, root.thread_count, root.thread_last), (None, 2, Some(1_700_000_050_500)));
        assert_eq!((root.edited_at, root.updated_at), (Some(1_700_000_010_000), 1_700_000_010_000));
        assert_eq!(root.author_name.as_deref(), Some("alice"));
        let reactions: Value = serde_json::from_str(root.reactions.as_deref().unwrap()).unwrap();
        let code = crate::emoji::shortcode("\u{1F44D}").unwrap();
        assert_eq!(
            reactions,
            json!({format!(":{code}:"): {"usernames": ["alice", "bob"]}}),
            "the app's own code for 👍"
        );
        let reply = t
            .message(
                "C001",
                &json!({"ts": "1700000001.000200", "user": "U002", "text": "r", "thread_ts": "1700000000.000100"}),
            )
            .unwrap();
        assert_eq!(reply.thread_id.as_deref(), Some("C001:1700000000.000100"));
        assert!(!reply.thread_shown && reply.thread_count == 0);
        let join = t.message("C001", &json!({"ts": "1700000002.000000", "user": "U002", "subtype": "channel_join", "text": "<@U002> has joined"})).unwrap();
        assert_eq!((join.system_type.as_deref(), join.text.as_deref()), (Some("uj"), Some("bob")));
        let topic = t
            .message(
                "C001",
                &json!({"ts": "1700000003.000000", "user": "U002", "subtype": "channel_topic", "topic": "*new*"}),
            )
            .unwrap();
        assert_eq!(
            (topic.system_type.as_deref(), topic.text.as_deref()),
            (Some("room_changed_topic"), Some("**new**"))
        );
        let bot = t.message("C001", &json!({"ts": "1700000004.000000", "subtype": "bot_message", "bot_id": "B001", "username": "deploy", "text": "done"})).unwrap();
        assert_eq!((bot.author_id.as_str(), bot.author_name.as_deref()), ("B001", Some("deploy")));
        let file = t.message("C001", &json!({"ts": "1700000005.000000", "user": "U001", "subtype": "file_share", "text": "look", "files": [{"name": "a.pdf"}, {"title": "b"}]})).unwrap();
        assert_eq!(file.text.as_deref(), Some("look\n📎 a.pdf, b"));
        for hidden in [
            json!({"ts": "1700000006.000000", "hidden": true}),
            json!({"ts": "1700000007.000000", "subtype": "tombstone"}),
        ] {
            assert!(t.message("C001", &hidden).is_none());
        }
    }

    #[test]
    fn rooms_and_counts() {
        let d = directory();
        let channels = HashMap::new();
        let t = Translator { directory: &d, channels: &channels };
        let dm = t.room("U000", &json!({"id": "D001", "is_im": true, "user": "U001"}), Some(5), None).unwrap();
        assert_eq!(
            (dm.kind.as_str(), dm.name.as_deref(), dm.display_name.as_deref()),
            ("d", Some("alice"), Some("Ali"))
        );
        assert_eq!((dm.dm_other_uid.as_deref(), dm.keep_preview), (Some("U001"), true));
        let group = t
            .room("U000", &json!({"id": "G001", "is_mpim": true, "name": "mpdm-me--alice--carl-1"}), None, None)
            .unwrap();
        assert_eq!((group.kind.as_str(), group.display_name.as_deref()), ("d", Some("Ali, carl")));
        let private = t.room("U000", &json!({"id": "C002", "is_private": true, "name": "ops"}), None, None).unwrap();
        assert_eq!(private.kind, "p");
        let unread = subscription(
            "C001",
            Some(&json!({"has_unreads": true, "mention_count": 0, "last_read": "1700000000.000500"})),
            9,
            true,
        );
        assert_eq!(
            (unread.unread, unread.mentions, unread.alert, unread.last_seen),
            (1, 0, true, Some(1_700_000_000_000))
        );
        let mentioned = subscription("C001", Some(&json!({"has_unreads": true, "mention_count": 3})), 9, true);
        assert_eq!((mentioned.unread, mentioned.mentions), (3, 3));
        let unknown = subscription("C001", None, 9, true);
        assert_eq!((unknown.unread, unknown.alert), (0, false));
    }
}
