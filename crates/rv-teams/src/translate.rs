//! Teams into the store's rows: the aggregator's chats and channels as rooms
//! and read states, the chat service's messages (HTML) as the markdown the
//! renderer reads, emotions as reactions.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use rv_provider::normalize::{Message, Room, Subscription};

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

/// Teams' emoticon ids (Skype's, still sent as reaction keys and in
/// `<img itemtype=".../Emoji" itemid=...>`) and their glyphs.
const EMOTICONS: &[(&str, &str)] = &[
    ("smile", "🙂"),
    ("happy", "😊"),
    ("grinning", "😀"),
    ("bigsmile", "😃"),
    ("laughcry", "😂"),
    ("rofl", "🤣"),
    ("wink", "😉"),
    ("blush", "😊"),
    ("inlove", "😍"),
    ("hearteyes", "😍"),
    ("kiss", "😘"),
    ("tongueout", "😛"),
    ("cool", "😎"),
    ("think", "🤔"),
    ("wonder", "🤔"),
    ("smirk", "😏"),
    ("unamused", "😒"),
    ("eyeroll", "🙄"),
    ("giggle", "🤭"),
    ("nerdy", "🤓"),
    ("whew", "😅"),
    ("sweat", "😓"),
    ("worry", "😟"),
    ("cry", "😢"),
    ("loudlycrying", "😭"),
    ("sleepy", "😪"),
    ("yawn", "🥱"),
    ("sick", "🤒"),
    ("puke", "🤮"),
    ("devil", "😈"),
    ("angel", "😇"),
    ("party", "🥳"),
    ("facepalm", "🤦"),
    ("shrug", "🤷"),
    ("clap", "👏"),
    ("handsinair", "🙌"),
    ("praying", "🙏"),
    ("muscle", "💪"),
    ("ok", "👌"),
    ("yes", "👍"),
    ("no", "👎"),
    ("dislike", "👎"),
    ("wave", "👋"),
    ("fire", "🔥"),
    ("100", "💯"),
    ("star", "⭐"),
    ("sun", "☀️"),
    ("coffee", "☕"),
    ("cake", "🍰"),
    ("beer", "🍺"),
    ("gift", "🎁"),
    ("rose", "🌹"),
    ("brokenheart", "💔"),
    ("lips", "💋"),
    ("poop", "💩"),
    ("skull", "💀"),
    ("smilerobot", "🤖"),
    ("robot", "🤖"),
    ("rocket", "🚀"),
    ("checkmark", "✅"),
];

/// The glyph of a `<codepoints>_<name>` key's codepoints, `1f62d` or `1f44d-1f3fb`.
fn codepoints(key: &str) -> Option<String> {
    let (points, _) = key.split_once('_')?;
    points
        .split('-')
        .map(|hex| u32::from_str_radix(hex, 16).ok().and_then(char::from_u32))
        .collect::<Option<String>>()
        .filter(|g| !g.is_empty())
}

/// The shortcode a reaction key shows as: a classic key, a key carrying its
/// codepoints (`1f62d_loudlycrying`) or a Teams emoticon id, by its glyph's
/// standard shortcode; else the key's name.
pub fn reaction_code(key: &str) -> String {
    if let Some((_, code)) = KEYS.iter().find(|(k, _)| *k == key) {
        return (*code).to_owned();
    }
    let name = key.split_once('_').map(|(_, name)| name).filter(|n| !n.is_empty()).unwrap_or(key);
    let glyph = codepoints(key)
        .or_else(|| EMOTICONS.iter().find(|(id, _)| *id == name || *id == key).map(|(_, glyph)| (*glyph).to_owned()));
    glyph.and_then(|g| rv_provider::emoji::shortcode(&g)).unwrap_or(name).to_owned()
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

    /// The MRI known under this display name, only when exactly one person
    /// carries it: the desktop opens a card by the shown name, not the MRI.
    pub fn mri_for(&self, name: &str) -> Option<String> {
        let names = self.names.lock().unwrap();
        let mut found = None;
        for (mri, who) in names.iter() {
            if who == name {
                if found.is_some() {
                    return None;
                }
                found = Some(mri.clone());
            }
        }
        found
    }

    /// The name of the person a mention token (`mention_token`) stands for.
    pub fn by_token(&self, token: &str) -> Option<String> {
        let names = self.names.lock().unwrap();
        names.iter().find(|(mri, _)| mention_token(mri) == Some(token)).map(|(_, name)| name.clone())
    }

    /// The MRI a mention token stands for, among the people known.
    pub fn mri_of_token(&self, token: &str) -> Option<String> {
        let names = self.names.lock().unwrap();
        names.keys().find(|mri| mention_token(mri) == Some(token)).cloned()
    }

    pub fn known(&self, mri: &str) -> bool {
        self.names.lock().unwrap().contains_key(mri)
    }

    /// An MRI's name, or the MRI when nobody has said it.
    pub fn shown(&self, mri: &str) -> String {
        self.name(mri).unwrap_or_else(|| mri.to_owned())
    }

    /// Learns the sender's display name from an entry's last message.
    pub fn learn_last(&self, entry: &Value) {
        if let Some(last) = entry.get("lastMessage")
            && let (Some(from), Some(name)) = (str_of(last, "from"), str_of(last, "imDisplayName"))
        {
            self.remember(mri_of(from), name);
        }
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

/// A person a message mentions, from its `properties.mentions`: Teams writes
/// one `<span itemtype=".../Mention" itemid=N>` per word of the name.
#[derive(Debug, Clone, PartialEq)]
pub struct Mentioned {
    pub item: String,
    pub mri: String,
}

/// `properties.mentions`, a JSON string or an array of `{itemid, mri, displayName}`.
pub fn mentions_of(raw: &Value) -> Vec<Mentioned> {
    let list = match raw.pointer("/properties/mentions") {
        Some(Value::Array(list)) => list.clone(),
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or_default(),
        _ => Vec::new(),
    };
    list.iter()
        .filter_map(|m| {
            let item = str_of(m, "itemid").map(str::to_owned).or_else(|| int_of(m, "itemid").map(|n| n.to_string()))?;
            Some(Mentioned { item, mri: str_of(m, "mri")?.to_owned() })
        })
        .collect()
}

/// The token a mention is written as, `@<object id>`: one word the renderer
/// reads whole, which `Directory::by_token` names back.
pub fn mention_token(mri: &str) -> Option<&str> {
    let token = mri.rsplit(':').next()?;
    (!token.is_empty() && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).then_some(token)
}

/// `text` with each `@<token>` a person stands behind spelled `@<name>`.
pub fn spell_mentions(text: &str, name: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('@') {
        out.push_str(&rest[..=at]);
        rest = &rest[at + 1..];
        let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).unwrap_or(rest.len());
        match name(&rest[..end]) {
            Some(full) if end > 0 => out.push_str(&full),
            _ => out.push_str(&rest[..end]),
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// A reply's quote, `<blockquote itemtype=".../Reply" itemid=<message id>>`
/// holding the author (`<strong itemprop="mri" itemid=<mri>>`), the time
/// (`<span itemprop="time" itemid=<ms>>`) and the text (`<p itemprop="preview">`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Quoted {
    pub id: Option<String>,
    pub author: Option<String>,
    pub author_mri: Option<String>,
    pub ts: Option<i64>,
    pub text: String,
}

fn quoted(open: &str, inner: &str) -> Quoted {
    let mut quote = Quoted { id: attribute(open, "itemid").map(str::to_owned), ..Default::default() };
    let mut rest = inner;
    while let Some(start) = rest.find('<') {
        let Some(end) = rest[start..].find('>').map(|e| start + e) else { break };
        let tag = &rest[start + 1..end];
        rest = &rest[end + 1..];
        let (name, prop) =
            (tag.split_whitespace().next().unwrap_or("").to_ascii_lowercase(), attribute(tag, "itemprop"));
        let close = format!("</{name}");
        let body = rest.to_ascii_lowercase().find(&close).map_or(rest, |c| &rest[..c]);
        match prop {
            Some("mri") => {
                quote.author_mri = attribute(tag, "itemid").map(str::to_owned);
                quote.author = Some(html_to_markdown(body)).filter(|n| !n.is_empty());
            }
            Some("time") => quote.ts = attribute(tag, "itemid").and_then(|t| t.parse().ok()),
            Some("preview") => quote.text = html_to_markdown(body),
            _ => continue,
        }
        rest = &rest[body.len()..];
    }
    quote
}

/// Teams' message HTML, as markdown with the replies it quotes set apart.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Converted {
    pub text: String,
    pub quotes: Vec<Quoted>,
    /// The people mentioned by token, with the name their spans spelled.
    pub people: Vec<(String, String)>,
}

/// Teams' message HTML to markdown: paragraphs, breaks, emphasis, code, links,
/// lists, quotes, mentions (`@Name`) and emoji (`alt`). Scripts, styles and
/// remote images are dropped; a reply's quote is left out.
pub fn html_to_markdown(html: &str) -> String {
    convert(html, &[]).text
}

/// `html_to_markdown`, with the replies quoted apart and the mentions whose
/// person `mentions` names as `@<token>`; the words of one person's name,
/// one span each, make one mention.
pub fn convert(html: &str, mentions: &[Mentioned]) -> Converted {
    let mut out = String::new();
    let mut quotes = Vec::new();
    let mut rest = html;
    let mut lists: Vec<Option<u32>> = Vec::new();
    let mut link: Option<String> = None;
    let mut link_text_start = 0;
    let mut pre = false;
    let mut spans: Vec<Option<(usize, Option<String>)>> = Vec::new();
    let mut last_mention: Option<(usize, usize, String, String)> = None;
    let mut people: Vec<(String, String)> = Vec::new();
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
            ("blockquote", false) if attribute(tag, "itemtype").is_some_and(|t| t.ends_with("/Reply")) => {
                let close = rest.to_ascii_lowercase().find("</blockquote").unwrap_or(rest.len());
                quotes.push(quoted(tag, &rest[..close]));
                rest = &rest[close..];
                rest = rest.find('>').map_or("", |end| &rest[end + 1..]);
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
                    .map(rv_provider::text::decode_entities);
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
            ("span", false) => {
                let mention = attribute(tag, "itemtype").is_some_and(|t| t.ends_with("/Mention"));
                spans.push(mention.then(|| {
                    let item = attribute(tag, "itemid");
                    (out.len(), mentions.iter().find(|m| Some(m.item.as_str()) == item).map(|m| m.mri.clone()))
                }));
            }
            ("span", true) => {
                if let Some(Some((at, mri))) = spans.pop() {
                    let word = out[at..].trim().to_owned();
                    out.truncate(at);
                    let mri = mri.unwrap_or_default();
                    let joined = match &last_mention {
                        Some((from, end, who, name)) if *who == mri && out[*end..].trim().is_empty() => {
                            out.truncate(*from);
                            if mention_token(&mri).is_some() {
                                people.pop();
                            }
                            format!("{name} {word}")
                        }
                        _ => word,
                    };
                    let from = out.len();
                    match mention_token(&mri) {
                        Some(token) => {
                            out.push_str(&format!("@{token}"));
                            people.push((mri.clone(), joined.clone()));
                        }
                        None => out.push_str(&format!("@{joined}")),
                    }
                    last_mention = Some((from, out.len(), mri, joined));
                }
            }
            ("img", _) => {
                let emoji = attribute(tag, "itemtype").is_some_and(|t| t.ends_with("/Emoji"));
                if let Some(alt) = attribute(tag, "alt").filter(|_| emoji) {
                    out.push_str(&rv_provider::text::decode_entities(alt));
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
    Converted { text: joined.trim().to_owned(), quotes, people }
}

fn push_text(out: &mut String, text: &str, pre: bool) {
    let decoded = rv_provider::text::decode_entities(text);
    if pre {
        out.push_str(&decoded);
    } else {
        let collapsed: String = decoded.split(['\n', '\r']).collect::<Vec<_>>().join(" ");
        out.push_str(&collapsed.replace('\u{a0}', " "));
    }
}

/// A message's text: HTML for `RichText/Html`, plain otherwise, under the
/// post's subject in bold when it has one.
pub fn body_text(raw: &Value) -> String {
    body(raw).text
}

/// `body_text` with the replies the message quotes and the people it mentions.
pub fn body(raw: &Value) -> Converted {
    let content = str_of(raw, "content").unwrap_or_default();
    let html = str_of(raw, "messagetype").is_some_and(|t| t.starts_with("RichText"))
        || str_of(raw, "contenttype").is_some_and(|t| t.eq_ignore_ascii_case("html"));
    let mut converted = if html {
        convert(content, &mentions_of(raw))
    } else {
        Converted { text: rv_provider::text::decode_entities(content).trim().to_owned(), ..Default::default() }
    };
    converted.text = match subject(raw) {
        Some(title) if converted.text.is_empty() => format!("**{title}**"),
        Some(title) => format!("**{title}**\n\n{}", converted.text),
        None => converted.text,
    };
    converted
}

/// A reply's quote as the quote attachment the timeline renders.
fn quote_attachment(conversation: &str, quote: &Quoted, directory: &Directory) -> Value {
    let author = quote.author_mri.as_deref().and_then(|mri| directory.name(mri)).or_else(|| quote.author.clone());
    let link = quote.id.as_deref().map_or_else(String::new, |id| permalink(conversation, id));
    let mut out = json!({"text": quote.text, "message_link": link});
    if let Some(author) = author {
        out["author_name"] = json!(author);
    }
    if let Some(ts) = quote.ts {
        out["ts"] = json!(ts);
    }
    out
}

/// An edited text without the subject `body_text` put in front of it: the
/// subject stays the message's own property.
pub fn without_subject(raw: &Value, text: &str) -> String {
    let Some(title) = subject(raw) else { return text.to_owned() };
    text.strip_prefix(&format!("**{title}**")).map_or(text, |rest| rest.trim_start_matches('\n')).to_owned()
}

/// A channel post's subject, the title Teams shows above it: the chat
/// service's `properties.subject`, or `subject` where the aggregator or a
/// rebuilt entry carries it.
pub fn subject(raw: &Value) -> Option<String> {
    let title = raw.pointer("/properties/subject").and_then(Value::as_str).or_else(|| str_of(raw, "subject"))?;
    let title = rv_provider::text::decode_entities(title).trim().to_owned();
    (!title.is_empty()).then_some(title)
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
        "TopicUpdate" => {
            Some(("room_changed_topic", tag_value(content, "value").map(rv_provider::text::decode_entities)))
        }
        _ => None,
    }
}

/// A call event's card: the message it is drawn as, its kind (`videoconf`
/// running, `videoconf-ended` over), the length in seconds for one over, and
/// the call id a running card joins with.
struct CallCard {
    server: String,
    ts: Option<i64>,
    kind: &'static str,
    seconds: String,
    call_id: Option<String>,
}

/// A Teams call (`Event/Call`) as the call message kChat's and Slack's calls
/// also become. Its start (`callStarted`) is a running call whose call id is
/// its own message id: Join opens it in Teams' web app, a channel's straight
/// in the call (`meetup_link`), a chat's on the conversation. Its end
/// is a separate event, in a channel a reply on the start, carrying each
/// participant's `<duration>`: it is drawn in the start's place (the start's
/// id and time, a Teams message id being its arrival time), and being newer it
/// replaces the running card whichever arrives first. Read from a live
/// channel call on 2026-10-23; the start's content is never rewritten.
fn call_card(conversation: &str, raw: &Value, id: &str) -> Option<CallCard> {
    let content = str_of(raw, "content").unwrap_or_default();
    let event = tag_value(content, "callEventType").unwrap_or_default();
    let ended = content.contains("<ended/>") || event.eq_ignore_ascii_case("callEnded");
    if !ended {
        return event.eq_ignore_ascii_case("callStarted").then(|| CallCard {
            server: id.to_owned(),
            ts: None,
            kind: "videoconf",
            seconds: String::new(),
            call_id: Some(message_id(conversation, id)),
        });
    }
    let longest = content
        .split("<duration>")
        .skip(1)
        .filter_map(|rest| rest.split("</duration>").next()?.trim().parse::<u64>().ok())
        .max();
    let start = root_of(raw, id).or_else(|| {
        str_of(raw, "parentMessageId")
            .map(str::to_owned)
            .or_else(|| int_of(raw, "parentMessageId").map(|n| n.to_string()))
            .filter(|p| p != id && p.bytes().all(|b| b.is_ascii_digit()))
    });
    Some(CallCard {
        ts: start.as_deref().and_then(|s| s.parse().ok()),
        server: start.unwrap_or_else(|| id.to_owned()),
        kind: "videoconf-ended",
        seconds: longest.map(|s| s.to_string()).unwrap_or_default(),
        call_id: None,
    })
}

fn call_message(conversation: &str, raw: &Value, id: &str, directory: &Directory) -> Option<Message> {
    let card = call_card(conversation, raw, id)?;
    directory.learn(raw);
    let at = instant(raw, "originalarrivaltime").or_else(|| instant(raw, "composetime")).or_else(|| id.parse().ok())?;
    let author = str_of(raw, "from").map(mri_of).unwrap_or_default().to_owned();
    let thread_id = match card.kind {
        "videoconf" => root_of(raw, id).map(|root| message_id(conversation, &root)),
        _ => None,
    };
    Some(Message {
        id: message_id(conversation, &card.server),
        rid: conversation.to_owned(),
        text: Some(card.seconds),
        ts: card.ts.unwrap_or(at),
        author_name: Some(directory.shown(&author)),
        author_id: author,
        system_type: Some(card.kind.to_owned()),
        thread_id,
        call_id: card.call_id,
        updated_at: at.max(int_of(raw, "version").unwrap_or(0)),
        ..Default::default()
    })
}

/// A channel's page in Teams' web app, where its running call shows a Join.
pub fn channel_link(channel: &str, name: &str, group: &str, tenant: &str) -> String {
    let mut url = url::Url::parse("https://teams.microsoft.com/l/channel/").expect("Teams link base");
    url.path_segments_mut().expect("https base").pop_if_empty().extend([channel, name]);
    url.query_pairs_mut().append_pair("groupId", group).append_pair("tenantId", tenant);
    url.to_string()
}

/// A channel call's join page in Teams' web app: the thread, the call's start
/// message and its organizer, the starter (read from the web app's own call
/// metadata, 2026-10-23).
pub fn meetup_link(thread: &str, message: &str, tenant: &str, organizer: &str) -> String {
    let thread = thread.replace(':', "%3a").replace('@', "%40");
    let mut url = url::Url::parse(&format!("https://teams.microsoft.com/l/meetup-join/{thread}/{message}"))
        .expect("Teams link base");
    let context = format!("{{\"Tid\":{},\"Oid\":{}}}", Value::from(tenant), Value::from(organizer));
    url.query_pairs_mut().append_pair("context", &context);
    url.to_string()
}

/// The AAD object id of an `8:orgid:` MRI.
pub fn object_id(mri: &str) -> Option<&str> {
    mri.strip_prefix("8:orgid:").filter(|oid| !oid.is_empty())
}

/// A chat's page in Teams' web app, where its running call shows a Join.
pub fn chat_link(chat: &str, tenant: &str) -> String {
    let mut url = url::Url::parse("https://teams.microsoft.com/l/chat/").expect("Teams link base");
    url.path_segments_mut().expect("https base").pop_if_empty().extend([chat, "conversations"]);
    url.query_pairs_mut().append_pair("tenantId", tenant);
    url.to_string()
}

/// Where a Teams call window may go: Microsoft's own `https` pages (Teams'
/// web app, its CDNs and the Microsoft sign-in it passes through) and the
/// page's blobs. A tenant signing in through its own identity provider leaves
/// this list, so that sign-in goes to the browser.
pub fn call_allowed(url: &str, _call_url: &str) -> bool {
    url == "about:blank"
        || url == "about:srcdoc"
        || url.strip_prefix("blob:").is_some_and(microsoft_web)
        || microsoft_web(url)
}

fn microsoft_web(link: &str) -> bool {
    const DOMAINS: [&str; 11] = [
        "microsoft.com",
        "cloud.microsoft",
        "microsoftonline.com",
        "live.com",
        "office.com",
        "office.net",
        "msauth.net",
        "msftauth.net",
        "skype.com",
        "teams.microsoft.us",
        "microsoft",
    ];
    url::Url::parse(link).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.host_str().is_some_and(|h| DOMAINS.iter().any(|d| h == *d || h.ends_with(&format!(".{d}"))))
    })
}

/// One chat service message, or None for a kind the app does not show.
/// A url Graph can resolve through `/shares`: a SharePoint or OneDrive host.
/// Teams shared files live there; AMS media (call recordings) does not and is
/// left out, so it is never offered as a download that would fail.
pub fn is_graph_share(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|h| h.ends_with(".sharepoint.com") || h.ends_with(".sharepoint-df.com") || h == "1drv.ms")
}

/// File attachments from the chat-service `properties.files` (a JSON string):
/// each `{title, fileInfo.fileUrl}`. Only files on a SharePoint/OneDrive host
/// are kept (downloaded through Graph `/shares`), as the renderer's RC shape
/// `{title, title_link, type: "file", size}`. None when the message has no
/// such file.
/// An image Teams keeps on its asyncgw object store (`https://<region>.asyncgw
/// .teams.microsoft.com/v1/objects/<id>/views/<view>`), read with the skype
/// token (verified live 2026-10-24: 200 with it, 401 without).
pub fn is_teams_image(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.host_str().is_some_and(|h| h.ends_with(".asyncgw.teams.microsoft.com"))
            && u.path().starts_with("/v1/objects/")
            && u.path().contains("/views/")
    })
}

fn image_attachment(url: &str, title: Option<&str>, width: Option<i64>, height: Option<i64>) -> Value {
    let mut a = json!({ "image_url": url });
    if let Some(title) = title {
        a["title"] = json!(title);
    }
    if let (Some(w), Some(h)) = (width.filter(|w| *w > 0), height.filter(|h| *h > 0)) {
        a["image_dimensions"] = json!({ "width": w, "height": h });
    }
    a
}

/// The images pasted into a message: its `<img>` tags on Teams' object store,
/// emoji left to the text.
fn inline_images(content: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(at) = rest.to_ascii_lowercase().find("<img") {
        let tail = &rest[at..];
        let end = tail.find('>').map_or(tail.len(), |e| e + 1);
        let tag = &tail[..end];
        rest = &tail[end..];
        if attribute(tag, "itemtype").is_some_and(|t| t.ends_with("/Emoji")) {
            continue;
        }
        let Some(src) = attribute(tag, "src").map(rv_provider::text::decode_entities) else { continue };
        if is_teams_image(&src) {
            let size = |name: &str| attribute(tag, name).and_then(|v| v.trim_end_matches("px").parse::<i64>().ok());
            out.push(image_attachment(&src, None, size("width"), size("height")));
        }
    }
    out
}

/// A message's attachments in the renderer's Rocket.Chat shape: images pasted
/// into it, then its shared files, each with its preview image when Teams
/// keeps one on its object store.
pub fn file_attachments(raw: &Value) -> Option<String> {
    let mut out = inline_images(str_of(raw, "content").unwrap_or_default());
    let parsed = match raw.get("properties").and_then(|p| p.get("files")) {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        Some(other) => other.clone(),
        None => Value::Null,
    };
    for f in parsed.as_array().map(Vec::as_slice).unwrap_or_default() {
        if let Some(preview) =
            f.pointer("/filePreview/previewUrl").and_then(Value::as_str).filter(|u| is_teams_image(u))
        {
            let title = f.get("title").or_else(|| f.get("fileName")).and_then(Value::as_str);
            let size = |key: &str| f.pointer(&format!("/filePreview/{key}")).and_then(Value::as_i64);
            out.push(image_attachment(preview, title, size("previewWidth"), size("previewHeight")));
        }
        let Some(url) =
            f.pointer("/fileInfo/fileUrl").and_then(Value::as_str).or_else(|| f.get("fileUrl").and_then(Value::as_str))
        else {
            continue;
        };
        if !is_graph_share(url) {
            continue;
        }
        let name = f
            .get("title")
            .or_else(|| f.get("filename"))
            .or_else(|| f.get("fileName"))
            .and_then(Value::as_str)
            .unwrap_or("file");
        let mut a = json!({ "title": name, "title_link": url, "type": "file" });
        if let Some(size) = f.pointer("/fileInfo/fileSize").and_then(Value::as_i64).or_else(|| int_of(f, "size")) {
            a["size"] = json!(size);
        }
        out.push(a);
    }
    (!out.is_empty()).then(|| Value::Array(out).to_string())
}

pub fn message(conversation: &str, raw: &Value, directory: &Directory) -> Option<Message> {
    let id = str_of(raw, "id").map(str::to_owned).or_else(|| int_of(raw, "id").map(|n| n.to_string()))?;
    let kind = str_of(raw, "messagetype").unwrap_or_default();
    if kind == "Event/Call" {
        return if deleted(raw) { None } else { call_message(conversation, raw, &id, directory) };
    }
    let attachments = file_attachments(raw);
    let shown = matches!(kind, "Text" | "RichText/Html" | "RichText")
        || kind.starts_with("ThreadActivity/")
        || attachments.is_some();
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
    let converted = body(raw);
    for (mri, name) in &converted.people {
        if !directory.known(mri) {
            directory.remember(mri, name);
        }
    }
    let text = match &system {
        Some((_, param)) => param.clone(),
        None => Some(converted.text),
    };
    let quotes: Vec<Value> = converted.quotes.iter().map(|q| quote_attachment(conversation, q, directory)).collect();
    let attachments = if quotes.is_empty() {
        attachments
    } else {
        let files: Vec<Value> = attachments.and_then(|a| serde_json::from_str(&a).ok()).unwrap_or_default();
        Some(Value::Array(quotes.into_iter().chain(files).collect()).to_string())
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
        attachments,
        reactions: reactions(raw, directory),
        pinned: props.get("pinned").is_some_and(|v| !v.is_null()),
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

/// The kinds a room's preview shows.
const PREVIEWED: [&str; 3] = ["Text", "RichText/Html", "RichText"];

/// The last message the aggregator carries for a chat or channel.
fn preview(last: &Value, directory: &Directory) -> Option<(String, Option<String>, i64)> {
    let kind = str_of(last, "messageType").unwrap_or_default();
    if !matches!(kind, "Text" | "RichText/Html" | "RichText") {
        return None;
    }
    let raw = json!({"content": last.get("content"), "messagetype": kind, "subject": subject(last)});
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

/// The server id of the last message the aggregator carries for a chat or channel.
pub fn last_id(entry: &Value) -> Option<i64> {
    entry.get("lastMessage").and_then(|l| int_of(l, "id"))
}

/// The time of the last message that makes a room unread: membership,
/// topic and control events are never stored, so they cannot be read past.
fn unread_at(entry: &Value) -> Option<i64> {
    let last = entry.get("lastMessage")?;
    let kind = str_of(last, "messageType").unwrap_or_default();
    if kind.starts_with("ThreadActivity/") || kind.starts_with("Control/") {
        return None;
    }
    instant(last, "composeTime").or_else(|| int_of(last, "id"))
}

/// The entry read up to message `id`, as a mark read leaves it.
pub fn read_up_to(entry: &mut Value, id: i64) {
    if horizon(entry).is_some_and(|seen| seen >= id) {
        return;
    }
    entry["consumptionHorizon"] =
        json!({"originalArrivalTime": id, "timeStamp": chrono::Utc::now().timestamp_millis()});
    for key in ["isRead", "isMessageRead"] {
        if entry.get(key).is_some() {
            entry[key] = Value::Bool(true);
        }
    }
}

/// A chat the chat service lists (`users/ME/conversations`) in the
/// aggregator's chat shape, for one the snapshot left out: its topic, kind,
/// last message and read horizon, and for a one-to-one chat (`19:<a>_<b>@unq.gbl.spaces`)
/// its two members. None for a channel (its team's snapshot files it), a
/// system conversation (`48:` notes, call logs) or one with no message yet.
pub fn listed_chat(conversation: &Value) -> Option<Value> {
    let id = str_of(conversation, "id")?;
    let props = conversation.get("threadProperties").unwrap_or(&Value::Null);
    let kind = str_of(props, "threadType").unwrap_or_default();
    if !id.starts_with("19:")
        || id.ends_with("@thread.tacv2")
        || id.ends_with("@thread.skype")
        || matches!(kind, "space" | "topic")
    {
        return None;
    }
    let last = conversation.get("lastMessage").filter(|l| int_of(l, "id").is_some())?;
    let one_on_one = id.ends_with("@unq.gbl.spaces");
    let members: Vec<Value> = match id.strip_prefix("19:").and_then(|rest| rest.strip_suffix("@unq.gbl.spaces")) {
        Some(pair) => {
            pair.split('_').filter(|oid| !oid.is_empty()).map(|oid| json!({"mri": format!("8:orgid:{oid}")})).collect()
        }
        None => Vec::new(),
    };
    let meeting = kind == "meeting" || id.starts_with("19:meeting_");
    let horizon = conversation
        .pointer("/properties/consumptionhorizon")
        .and_then(Value::as_str)
        .and_then(|h| h.split(';').next())
        .and_then(|first| first.parse::<i64>().ok());
    let mut chat = json!({
        "id": id,
        "chatType": if meeting { "meeting" } else { "chat" },
        "isOneOnOne": one_on_one,
        "members": members,
        "lastMessage": {
            "messageType": last.get("messagetype"), "content": last.get("content"),
            "from": last.get("from"), "imDisplayName": last.get("imdisplayname"),
            "composeTime": last.get("composetime").or(last.get("originalarrivaltime")),
            "id": last.get("id"),
        },
    });
    if let Some(topic) = str_of(props, "topic") {
        chat["title"] = json!(rv_provider::text::decode_entities(topic));
    }
    if let Some(seen) = horizon {
        chat["consumptionHorizon"] = json!({"originalArrivalTime": seen});
    }
    Some(chat)
}

/// An aggregator chat as a room; `names` are its other members' names when known.
/// The one-to-one chat of two people by their `8:orgid:` MRIs: Teams names
/// it after their two directory ids in ascending order.
pub fn one_on_one_id(me: &str, other: &str) -> Option<String> {
    let oid = |mri: &str| mri.strip_prefix("8:orgid:").filter(|o| !o.is_empty() && !o.contains('_')).map(str::to_owned);
    let (mut a, mut b) = (oid(me)?, oid(other)?);
    if a == b {
        return None;
    }
    if b < a {
        std::mem::swap(&mut a, &mut b);
    }
    Some(format!("19:{a}_{b}@unq.gbl.spaces"))
}

/// The two members a one-to-one chat id names, as MRIs.
pub fn one_on_one_members(rid: &str) -> Option<[String; 2]> {
    let (a, b) = rid.strip_prefix("19:")?.strip_suffix("@unq.gbl.spaces")?.split_once('_')?;
    (!a.is_empty() && !b.is_empty()).then(|| [format!("8:orgid:{a}"), format!("8:orgid:{b}")])
}

/// The chat service's request creating that one-to-one chat: Teams answers
/// 404 to a first message posted before it exists.
pub fn one_on_one_thread(rid: &str) -> Option<Value> {
    let members = one_on_one_members(rid)?;
    Some(json!({
        "members": members.iter().map(|id| json!({"id": id, "role": "Admin"})).collect::<Vec<_>>(),
        "properties": {"threadType": "chat", "fixedRoster": "true", "uniquerosterthread": "true"},
    }))
}

/// A one-to-one chat with no message yet, as an aggregator entry: created on
/// Teams' side when its first message is sent.
pub fn new_one_on_one(me: &str, other: &str, now: i64) -> Option<Value> {
    let id = one_on_one_id(me, other)?;
    let created = chrono::DateTime::from_timestamp_millis(now)?.to_rfc3339();
    Some(json!({
        "id": id,
        "chatType": "chat",
        "isOneOnOne": true,
        "isRead": true,
        "members": [{"mri": me}, {"mri": other}],
        "createdAt": created,
    }))
}

/// A bot or app member (`28:`): Teams leaves it out of a chat's name.
pub fn bot(mri: &str) -> bool {
    mri.starts_with("28:")
}

/// A chat named after its members: the people I talk with, not the bots
/// added to it, and none whose name is unknown while one is known.
pub fn chat_room(me: &str, chat: &Value, directory: &Directory) -> Option<Room> {
    let rid = str_of(chat, "id")?;
    let members: Vec<&str> = chat
        .get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| str_of(m, "mri"))
        .filter(|m| *m != me && !bot(m))
        .collect();
    let meeting = str_of(chat, "chatType") == Some("meeting");
    let one_on_one = chat.get("isOneOnOne").and_then(Value::as_bool) == Some(true)
        || (!meeting && members.len() == 1 && str_of(chat, "title").is_none());
    let last = chat.get("lastMessage").and_then(|l| preview(l, directory));
    let named: Vec<String> = members.iter().filter_map(|m| directory.name(m)).collect();
    let others = if named.is_empty() { members.iter().map(|m| directory.shown(m)).collect() } else { named };
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

/// A channel's own name, "General" for a team's default one.
pub fn channel_name(channel: &Value) -> String {
    str_of(channel, "displayName").map(str::to_owned).unwrap_or_else(|| "General".to_owned())
}

/// How a channel shows outside its team's section, where every team's
/// default channel would otherwise read "General"; a channel already named
/// after its team ("Tech - GED") keeps its own name.
pub fn qualified_name(team: &str, channel: &str) -> String {
    let named = !team.is_empty()
        && channel.get(..team.len()).is_some_and(|start| start.eq_ignore_ascii_case(team))
        && !channel[team.len()..].chars().next().is_some_and(char::is_alphanumeric);
    if named { channel.to_owned() } else { format!("{team} · {channel}") }
}

/// An aggregator channel as a room, filed under its team: named after the
/// team too, the team's own section showing the channel's name alone.
pub fn channel_room(channel: &Value, team: Option<&str>, directory: &Directory) -> Option<Room> {
    let rid = str_of(channel, "id")?;
    let own = channel_name(channel);
    let last = channel.get("lastMessage").and_then(|l| preview(l, directory));
    let at = last.as_ref().map(|(_, _, at)| *at).or_else(|| last_at(channel));
    Some(Room {
        rid: rid.to_owned(),
        kind: if str_of(channel, "channelType").is_some_and(|t| t != "Standard") { "p" } else { "c" }.to_owned(),
        display_name: Some(team.map_or_else(|| own.clone(), |team| qualified_name(team, &own))),
        name: Some(own),
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

/// Whether I starred a chat or pinned a channel. A channel's `isFavorite` is
/// Teams' older "shown in the team list" (every team's General carries it),
/// not a favorite.
fn favorite(entry: &Value, channel: bool) -> bool {
    let flag = if channel { "isPinned" } else { "isFavorite" };
    entry.get(flag).and_then(Value::as_bool) == Some(true)
}

/// An aggregator chat's or channel's read state. Teams gives no count: one
/// unread room counts one, its mentions are not known. A channel with no read
/// horizon is one never opened or hidden, which Teams shows as read; a channel
/// hidden from its team's list (`isFavorite: false`) is never unread, and one
/// Teams flags unread with no message to read is read. A chat
/// Teams marks hidden is listed again once its last message is one it shows:
/// Teams sets the flag on many chats its own list still shows.
pub fn subscription(rid: &str, entry: &Value, me: &str, updated_at: i64, team: Option<(&str, &str)>) -> Subscription {
    let read_flag = entry.get("isRead").or_else(|| entry.get("isMessageRead")).and_then(Value::as_bool);
    let mine = entry.get("isLastMessageFromMe").and_then(Value::as_bool) == Some(true)
        || entry.pointer("/lastMessage/from").and_then(Value::as_str).is_some_and(|f| mri_of(f) == me);
    let newer = match (unread_at(entry), horizon(entry)) {
        (Some(last), Some(seen)) => last > seen,
        (Some(_), None) => team.is_none(),
        _ => false,
    };
    let channel = team.is_some();
    let hidden_channel = channel && entry.get("isFavorite").and_then(Value::as_bool) == Some(false);
    let flagged = |read: bool| !read && (!channel || unread_at(entry).is_some());
    let unread = !mine && !hidden_channel && read_flag.map_or(newer, flagged);
    let spoken =
        entry.get("lastMessage").is_some_and(|l| str_of(l, "messageType").is_some_and(|k| PREVIEWED.contains(&k)));
    let hidden = (entry.get("hidden").and_then(Value::as_bool) == Some(true) && !spoken)
        || entry.get("isConversationDeleted").and_then(Value::as_bool) == Some(true);
    Subscription {
        rid: rid.to_owned(),
        sub_id: Some(rid.to_owned()),
        unread: i64::from(unread),
        alert: unread,
        open: !hidden,
        favorite: favorite(entry, team.is_some()),
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
    fn a_one_on_one_thread_names_both_members_on_a_fixed_roster() {
        let id = "19:aa_bb@unq.gbl.spaces";
        let thread = one_on_one_thread(id).unwrap();
        assert_eq!(thread["members"][0]["id"], "8:orgid:aa");
        assert_eq!(thread["members"][1]["id"], "8:orgid:bb");
        assert_eq!(thread["properties"]["uniquerosterthread"], "true");
        assert!(one_on_one_thread("19:abc@thread.v2").is_none());
        assert!(one_on_one_thread("19:_bb@unq.gbl.spaces").is_none());
    }

    #[test]
    fn a_one_on_one_is_named_after_both_ids_in_order() {
        let me = "8:orgid:f1c9871e-4fe6-43b1-aa6f-5151f41cb073";
        let her = "8:orgid:e91438dc-73eb-4dd2-9689-2d77b9bd5fcc";
        let id = "19:e91438dc-73eb-4dd2-9689-2d77b9bd5fcc_f1c9871e-4fe6-43b1-aa6f-5151f41cb073@unq.gbl.spaces";
        assert_eq!(one_on_one_id(me, her).as_deref(), Some(id));
        assert_eq!(one_on_one_id(her, me).as_deref(), Some(id));
        assert_eq!(one_on_one_id(me, me), None);
        assert_eq!(one_on_one_id(me, "28:bot"), None);
        let chat = new_one_on_one(me, her, 1_700_000_000_000).unwrap();
        let room = chat_room(me, &chat, &Directory::default()).unwrap();
        assert_eq!(room.rid, id);
        assert_eq!(room.kind, "d");
        assert_eq!(room.dm_other_uid.as_deref(), Some(her));
        assert_eq!(room.updated_at, 1_700_000_000_000);
    }

    #[test]
    fn graph_shares_are_sharepoint_or_onedrive_hosts() {
        assert!(is_graph_share("https://contoso.sharepoint.com/sites/x/Shared%20Documents/a.pdf"));
        assert!(is_graph_share("https://contoso-my.sharepoint.com/personal/u/Documents/a.pdf"));
        assert!(is_graph_share("https://1drv.ms/x/s!abc"));
        // AMS call-recording media is not a driveItem: left out.
        assert!(!is_graph_share("https://as-api.asyncgw.teams.microsoft.com/v1/objects/0-weu-x/views/original"));
        assert!(!is_graph_share("not a url"));
    }

    #[test]
    fn images_on_the_object_store_show_inline() {
        let preview = "https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frc-d2-ab/views/imgo";
        let files = serde_json::to_string(&json!([{
            "title": "photo.png",
            "fileInfo": {"fileUrl": "https://contoso.sharepoint.com/sites/x/Shared Documents/photo.png"},
            "filePreview": {"previewUrl": preview, "previewWidth": 512, "previewHeight": 256},
        }]))
        .unwrap();
        let raw = json!({
            "content": concat!(
                "<p><img itemtype=\"http://schema.skype.com/AMSImage\" width=\"300\" height=\"200\" ",
                "src=\"https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frc-d1-cd/views/imgo\"></p>",
                "<img itemtype=\"http://schema.skype.com/Emoji\" alt=\"x\" src=\"https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/e/views/imgo\">",
                "<img src=\"https://tracker.example/p.gif\">"
            ),
            "properties": {"files": files},
        });
        let found: Vec<Value> = serde_json::from_str(&file_attachments(&raw).unwrap()).unwrap();
        assert_eq!(found.len(), 3, "{found:?}");
        assert_eq!(found[0]["image_dimensions"], json!({"width": 300, "height": 200}));
        assert_eq!(
            found[1],
            json!({"image_url": preview, "title": "photo.png", "image_dimensions": {"width": 512, "height": 256}})
        );
        assert_eq!(found[2]["type"], "file");
        for no in [
            "http://fr-prod.asyncgw.teams.microsoft.com/v1/objects/a/views/imgo",
            "https://evil.example/v1/objects/a/views/imgo",
            "https://asyncgw.teams.microsoft.com.evil.example/v1/objects/a/views/imgo",
            "https://u@fr-prod.asyncgw.teams.microsoft.com/v1/objects/a/views/imgo",
        ] {
            assert!(!is_teams_image(no), "{no}");
        }
    }

    #[test]
    fn file_attachments_keep_sharepoint_files_in_the_rc_shape() {
        let raw = json!({
            "messagetype": "RichText/Media_GenericFile",
            "properties": { "files": serde_json::to_string(&json!([
                { "title": "report.pdf", "fileInfo": { "fileUrl": "https://contoso.sharepoint.com/sites/x/report.pdf", "fileSize": 1234 } },
                { "title": "clip.mp4", "fileInfo": { "fileUrl": "https://as-api.asyncgw.teams.microsoft.com/v1/objects/0/views/original" } }
            ])).unwrap() }
        });
        let json = file_attachments(&raw).expect("one sharepoint file");
        let parsed: Value = serde_json::from_str(&json).unwrap();
        let files = parsed.as_array().unwrap();
        assert_eq!(files.len(), 1, "the AMS media url is left out");
        assert_eq!(files[0]["title"], json!("report.pdf"));
        assert_eq!(files[0]["title_link"], json!("https://contoso.sharepoint.com/sites/x/report.pdf"));
        assert_eq!(files[0]["type"], json!("file"));
        assert_eq!(files[0]["size"], json!(1234));
    }

    #[test]
    fn a_file_only_message_is_shown_through_its_attachment() {
        let directory = Directory::default();
        let raw = json!({
            "id": "1792540504421",
            "messagetype": "RichText/Media_GenericFile",
            "from": "8:orgid:aaa",
            "originalarrivaltime": "2026-10-20T23:55:04.4210000Z",
            "content": "",
            "properties": { "files": serde_json::to_string(&json!([
                { "title": "report.pdf", "fileInfo": { "fileUrl": "https://contoso.sharepoint.com/sites/x/report.pdf" } }
            ])).unwrap() }
        });
        let m = message("19:abc@thread.v2", &raw, &directory).expect("file message is shown");
        assert!(m.attachments.is_some());
    }

    #[test]
    fn teams_times_carry_seven_fractional_digits() {
        let raw = json!({"originalarrivaltime": "2026-10-20T23:55:04.4210000Z"});
        assert_eq!(instant(&raw, "originalarrivaltime"), Some(1792540504421));
    }

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
        assert!(!m.pinned);
        let pinned =
            raw("1792540521726", json!({"properties": {"pinned": "{\"creatorId\":\"8:orgid:aaa\",\"pinnedTime\":1}"}}));
        assert!(message("19:c@thread.v2", &pinned, &d).unwrap().pinned);
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
    fn a_call_starts_as_a_join_card_and_its_end_replaces_it() {
        let d = Directory::default();
        let channel = "19:ch@thread.tacv2";
        let start = raw(
            "1792713340033",
            json!({"messagetype": "Event/Call",
                "content": "<partlist alt =\"\"></partlist><callEventType>callStarted</callEventType><callId>c1</callId>",
                "conversationLink": format!("https://t/conversations/{channel};messageid=1792713340033")}),
        );
        let running = message(channel, &start, &d).unwrap();
        assert_eq!(running.id, format!("{channel}/1792713340033"));
        assert_eq!(running.system_type.as_deref(), Some("videoconf"));
        assert_eq!(running.call_id.as_deref(), Some(running.id.as_str()));
        assert_eq!(running.thread_id, None);
        let end = raw(
            "1792713355826",
            json!({"messagetype": "Event/Call",
                "content": "<ended/><partlist count=\"2\"><part><duration>76</duration></part><part><duration>40</duration></part></partlist><callEventType>callEnded</callEventType>",
                "conversationLink": format!("https://t/conversations/{channel};messageid=1792713340033")}),
        );
        let over = message(channel, &end, &d).unwrap();
        assert_eq!(over.id, running.id);
        assert_eq!(over.ts, 1792713340033);
        assert_eq!((over.system_type.as_deref(), over.text.as_deref()), (Some("videoconf-ended"), Some("76")));
        assert_eq!((over.thread_id.clone(), over.call_id.clone()), (None, None));
        assert!(over.updated_at > running.updated_at);
        let csa = json!({"messagetype": "Event/Call", "id": "9", "parentMessageId": "5",
            "originalarrivaltime": "2026-10-22T23:55:55.826Z", "content": "<ended/><callEventType>callEnded</callEventType>"});
        assert_eq!(message(channel, &csa, &d).unwrap().id, format!("{channel}/5"));
    }

    #[test]
    fn call_links_open_the_conversation_and_stay_on_microsoft() {
        let link = channel_link("19:ch@thread.tacv2", "Général", "g-1", "t-1");
        assert_eq!(
            link,
            "https://teams.microsoft.com/l/channel/19:ch@thread.tacv2/G%C3%A9n%C3%A9ral?groupId=g-1&tenantId=t-1"
        );
        assert_eq!(
            chat_link("19:a_b@unq.gbl.spaces", "t-1"),
            "https://teams.microsoft.com/l/chat/19:a_b@unq.gbl.spaces/conversations?tenantId=t-1"
        );
        assert_eq!(
            meetup_link("19:ch@thread.tacv2", "1792769688903", "t-1", "o-1"),
            "https://teams.microsoft.com/l/meetup-join/19%3ach%40thread.tacv2/1792769688903?context=%7B%22Tid%22%3A%22t-1%22%2C%22Oid%22%3A%22o-1%22%7D"
        );
        assert_eq!(object_id("8:orgid:o-1"), Some("o-1"));
        assert_eq!(object_id("8:live:bob"), None);
        for ok in [
            link.as_str(),
            "https://teams.cloud.microsoft/v2/",
            "https://login.microsoftonline.com/common/oauth2/authorize",
            "https://statics.teams.cdn.office.net/x.js",
            "about:blank",
        ] {
            assert!(call_allowed(ok, ""), "{ok}");
        }
        for no in [
            "http://teams.microsoft.com/",
            "https://evil.example/",
            "https://microsoft.com.evil.example/",
            "https://user@teams.microsoft.com/",
            "https://idp.contoso.com/saml",
        ] {
            assert!(!call_allowed(no, ""), "{no}");
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
        assert_eq!(channel_room(&channel, None, &d).unwrap().kind, "c");
        let sub = subscription("19:g@thread.tacv2", &channel, me, 5, Some(("team", "Ops")));
        assert_eq!((sub.group_name.as_deref(), sub.alert), (Some("Ops"), false));
    }

    #[test]
    fn chats_only_the_chat_service_lists_take_the_aggregator_shape() {
        let d = Directory::default();
        let last = json!({"id": "1792540521726", "messagetype": "RichText/Html", "content": "<p>yo</p>",
            "from": "https://t/v1/users/ME/contacts/8:orgid:bbb", "imdisplayname": "Bob",
            "composetime": "2026-10-20T23:55:21.726Z"});
        let one = json!({"id": "19:aaa_bbb@unq.gbl.spaces", "threadProperties": {}, "lastMessage": last,
            "properties": {"consumptionhorizon": "1792540500000;1792540500001;42"}});
        let chat = listed_chat(&one).unwrap();
        assert_eq!(chat["members"], json!([{"mri": "8:orgid:aaa"}, {"mri": "8:orgid:bbb"}]));
        assert_eq!(horizon(&chat), Some(1792540500000));
        let room = chat_room("8:orgid:aaa", &chat, &d).unwrap();
        assert_eq!((room.kind.as_str(), room.display_name.as_deref()), ("d", Some("Bob")));
        assert_eq!(room.dm_other_uid.as_deref(), Some("8:orgid:bbb"));
        assert!(subscription("19:aaa_bbb@unq.gbl.spaces", &chat, "8:orgid:aaa", 5, None).alert);
        let group = json!({"id": "19:g@thread.v2", "threadProperties": {"topic": "Point infra", "threadType": "chat"}, "lastMessage": last});
        assert_eq!(listed_chat(&group).unwrap()["title"], "Point infra");
        let meeting =
            json!({"id": "19:meeting_x@thread.v2", "threadProperties": {"threadType": "meeting"}, "lastMessage": last});
        assert_eq!(listed_chat(&meeting).unwrap()["chatType"], "meeting");
        for skipped in [
            json!({"id": "19:c@thread.tacv2", "lastMessage": last}),
            json!({"id": "19:s@thread.v2", "threadProperties": {"threadType": "space"}, "lastMessage": last}),
            json!({"id": "48:notes", "lastMessage": last}),
            json!({"id": "19:empty@thread.v2", "threadProperties": {}}),
        ] {
            assert!(listed_chat(&skipped).is_none(), "{skipped}");
        }
    }

    #[test]
    fn a_hidden_chat_shows_again_once_it_has_a_message() {
        let last = json!({"messageType": "RichText/Html", "content": "<p>yo</p>", "id": "1"});
        let hidden = json!({"id": "19:x@thread.v2", "hidden": true, "lastMessage": last});
        assert!(subscription("19:x@thread.v2", &hidden, "me", 5, None).open);
        let silent = json!({"id": "19:x@thread.v2", "hidden": true});
        assert!(!subscription("19:x@thread.v2", &silent, "me", 5, None).open);
        let gone = json!({"id": "19:x@thread.v2", "isConversationDeleted": true, "lastMessage": last});
        assert!(!subscription("19:x@thread.v2", &gone, "me", 5, None).open);
    }

    #[test]
    fn a_post_shows_its_subject_as_a_title_an_edit_leaves_out() {
        let d = Directory::default();
        let post = raw(
            "10",
            json!({"properties": {"subject": "Des failles php &amp; co"}, "content": "<p>https://x.example</p>"}),
        );
        let m = message("19:ch@thread.tacv2", &post, &d).unwrap();
        assert_eq!(m.text.as_deref(), Some("**Des failles php & co**\n\nhttps://x.example"));
        assert_eq!(without_subject(&post, "**Des failles php & co**\n\nfixed"), "fixed");
        assert_eq!(without_subject(&raw("11", json!({})), "**bold** start"), "**bold** start");
        let blank = raw("12", json!({"properties": {"subject": "  "}}));
        assert_eq!(message("c", &blank, &d).unwrap().text.as_deref(), Some("hello"));
        let channel = json!({"id": "19:ch@thread.tacv2", "lastMessage": {"messageType": "RichText/Html",
            "content": "<p>link</p>", "subject": "Faille Gitlab", "composeTime": "2026-10-20T23:55:21.726Z", "id": "1"}});
        assert_eq!(
            channel_room(&channel, None, &d).unwrap().last_message.as_deref(),
            Some("**Faille Gitlab**\n\nlink")
        );
    }

    #[test]
    fn channels_carry_their_team_and_are_favorites_only_when_pinned() {
        let d = Directory::default();
        let general = json!({"id": "19:g@thread.tacv2", "isFavorite": true});
        let room = channel_room(&general, Some("Tech"), &d).unwrap();
        assert_eq!((room.name.as_deref(), room.display_name.as_deref()), (Some("General"), Some("Tech · General")));
        let team = Some(("team", "Tech"));
        assert!(!subscription("19:g@thread.tacv2", &general, "me", 5, team).favorite, "shown, not starred");
        let pinned = json!({"id": "19:p@thread.tacv2", "displayName": "Ops", "isPinned": true});
        assert!(subscription("19:p@thread.tacv2", &pinned, "me", 5, team).favorite);
        let starred_chat = json!({"id": "19:x@thread.v2", "isFavorite": true});
        assert!(subscription("19:x@thread.v2", &starred_chat, "me", 5, None).favorite);
    }

    #[test]
    fn channels_never_opened_or_ending_on_an_event_are_read() {
        let me = "8:orgid:me";
        let team = Some(("team", "Ops"));
        let text = json!({"messageType": "RichText/Html", "content": "<p>yo</p>", "from": "8:orgid:bbb",
            "composeTime": "2026-10-20T23:55:21.726Z", "id": "1792540521726"});
        let never_opened = json!({"id": "19:g@thread.tacv2", "lastMessage": text});
        assert!(!subscription("19:g@thread.tacv2", &never_opened, me, 5, team).alert);
        assert!(
            subscription("19:x@thread.v2", &never_opened, me, 5, None).alert,
            "a chat with no horizon stays unread"
        );
        let seen_before = json!({"id": "19:g@thread.tacv2", "lastMessage": text,
            "consumptionHorizon": {"originalArrivalTime": 1792540500000_i64}});
        assert!(subscription("19:g@thread.tacv2", &seen_before, me, 5, team).alert);
        let mut event = seen_before.clone();
        event["lastMessage"]["messageType"] = json!("ThreadActivity/MemberJoined");
        assert!(!subscription("19:g@thread.tacv2", &event, me, 5, team).alert);
        let mut read = seen_before.clone();
        assert_eq!(last_id(&read), Some(1792540521726));
        read_up_to(&mut read, 1792540521726);
        assert!(!subscription("19:g@thread.tacv2", &read, me, 5, team).alert);
        assert_eq!(horizon(&read), Some(1792540521726));
        read_up_to(&mut read, 1);
        assert_eq!(horizon(&read), Some(1792540521726), "never marked backwards");
    }

    #[test]
    fn hidden_channels_and_flags_with_nothing_to_read_are_read() {
        let me = "8:orgid:me";
        let team = Some(("team", "ID Capture"));
        // Probe of the stuck channels (2026-10-28): Teams' own flag says
        // unread, but there is no last message and no horizon.
        let flagged = json!({"id": "19:alerts@thread.tacv2", "isMessageRead": false, "isFavorite": true});
        assert!(!subscription("19:alerts@thread.tacv2", &flagged, me, 5, team).alert);
        let text = json!({"messageType": "RichText/Html", "content": "<p>yo</p>", "from": "8:orgid:bbb",
            "composeTime": "2026-10-20T23:55:21.726Z", "id": "1792540521726"});
        let shown = json!({"id": "19:hello@thread.tacv2", "isMessageRead": false, "isFavorite": true,
            "lastMessage": text, "consumptionHorizon": {"originalArrivalTime": 1792540500000_i64}});
        assert!(subscription("19:hello@thread.tacv2", &shown, me, 5, team).alert);
        let mut hidden = shown.clone();
        hidden["isFavorite"] = json!(false);
        assert!(!subscription("19:hello@thread.tacv2", &hidden, me, 5, team).alert, "hidden from the team list");
        let chat = json!({"id": "19:x@thread.v2", "isRead": false, "isFavorite": false, "lastMessage": text});
        assert!(subscription("19:x@thread.v2", &chat, me, 5, None).alert, "a chat's isFavorite is a star");
    }

    #[test]
    fn a_channel_named_after_its_team_is_not_prefixed_twice() {
        assert_eq!(qualified_name("Tech", "Tech - GED"), "Tech - GED");
        assert_eq!(qualified_name("Tech", "tech · ops"), "tech · ops");
        assert_eq!(qualified_name("Tech", "Technology"), "Tech · Technology");
        assert_eq!(qualified_name("Tech", "General"), "Tech · General");
    }

    #[test]
    fn a_chat_is_named_after_its_people_not_its_bots() {
        let me = "8:orgid:me";
        let d = Directory::default();
        d.remember("8:orgid:micael", "Micael GONZALEZ");
        let chat = json!({"id": "19:c@thread.v2", "isOneOnOne": false, "chatType": "chat", "members": [
            {"mri": me}, {"mri": "8:orgid:micael"}, {"mri": "28:512b84d2-5840-45d6-8d01-5f073836d039"}]});
        let room = chat_room(me, &chat, &d).unwrap();
        assert_eq!(room.display_name.as_deref(), Some("Micael GONZALEZ"));
        assert_eq!(room.kind, "d");
        assert_eq!(room.dm_other_uid.as_deref(), Some("8:orgid:micael"), "me and one person");
        let group = json!({"id": "19:g@thread.v2", "chatType": "chat", "members": [
            {"mri": me}, {"mri": "8:orgid:micael"}, {"mri": "8:orgid:unknown"}]});
        let room = chat_room(me, &group, &d).unwrap();
        assert_eq!(room.display_name.as_deref(), Some("Micael GONZALEZ"), "an unknown name is left out");
        assert!(room.dm_other_uid.is_none());
    }

    #[test]
    fn reaction_keys_show_as_standard_shortcodes() {
        assert_eq!(reaction_code("like"), "+1");
        assert_eq!(reaction_code("loudlycrying"), "sob");
        assert_eq!(reaction_code("smilerobot"), "robot");
        assert_eq!(reaction_code("1f62d_loudlycrying"), "sob");
        assert_eq!(reaction_code("1f44d-1f3fb_thumbsuplight"), rv_provider::emoji::shortcode("👍🏻").unwrap());
        assert_eq!(reaction_code("zzzunknown"), "zzzunknown");
    }

    #[test]
    fn a_reply_quote_is_set_apart_and_the_text_after_it_trimmed() {
        let html = concat!(
            r#"<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="1792500000000">"#,
            r#"<strong itemprop="mri" itemid="8:orgid:marc">Marc-Etienne BARRUT</strong>"#,
            r#"<span itemprop="time" itemid="1792500000000"></span>"#,
            r#"<p itemprop="preview">Je suis outré</p></blockquote>"#,
            r#"<p>&nbsp; Je m'en doute. J'espère que tu t'en remettras</p>"#
        );
        let converted = convert(html, &[]);
        assert_eq!(converted.text, "Je m'en doute. J'espère que tu t'en remettras");
        assert_eq!(
            converted.quotes,
            vec![Quoted {
                id: Some("1792500000000".into()),
                author: Some("Marc-Etienne BARRUT".into()),
                author_mri: Some("8:orgid:marc".into()),
                ts: Some(1792500000000),
                text: "Je suis outré".into(),
            }]
        );
        let d = Directory::default();
        let m = message("19:c@thread.v2", &raw("1792600000000", json!({"content": html})), &d).unwrap();
        let quotes: Value = serde_json::from_str(m.attachments.as_deref().unwrap()).unwrap();
        assert_eq!(quotes[0]["author_name"], "Marc-Etienne BARRUT");
        assert_eq!(quotes[0]["text"], "Je suis outré");
        assert_eq!(quotes[0]["message_link"], permalink("19:c@thread.v2", "1792500000000"));
    }

    #[test]
    fn a_mention_spelled_one_span_per_word_is_one_mention() {
        let html = concat!(
            r#"<p>bien vu. <span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">Marc-Etienne</span>"#,
            r#"&nbsp;<span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="1">BARRUT</span> pour action</p>"#,
            r#"<p><span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="2">Olivier</span> "#,
            r#"<span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="3">DAUMIN</span> pour info</p>"#
        );
        let marc = "8:orgid:f1c9871e-4fe6-43b1-aa6f-5151f41cb073";
        let olivier = "8:orgid:0a7c1d02-1111-2222-3333-444455556666";
        let mentions = json!([
            {"@type": "http://schema.skype.com/Mention", "itemid": 0, "mri": marc, "mentionType": "person", "displayName": "Marc-Etienne"},
            {"@type": "http://schema.skype.com/Mention", "itemid": 1, "mri": marc, "mentionType": "person", "displayName": "BARRUT"},
            {"@type": "http://schema.skype.com/Mention", "itemid": 2, "mri": olivier, "mentionType": "person", "displayName": "Olivier"},
            {"@type": "http://schema.skype.com/Mention", "itemid": 3, "mri": olivier, "mentionType": "person", "displayName": "DAUMIN"},
        ]);
        let raw = raw("1792600000001", json!({"content": html, "properties": {"mentions": mentions.to_string()}}));
        let d = Directory::default();
        let m = message("19:c@thread.v2", &raw, &d).unwrap();
        assert_eq!(
            m.text.as_deref(),
            Some(
                "bien vu. @f1c9871e-4fe6-43b1-aa6f-5151f41cb073 pour action\n@0a7c1d02-1111-2222-3333-444455556666 pour info"
            )
        );
        assert_eq!(d.by_token("f1c9871e-4fe6-43b1-aa6f-5151f41cb073").as_deref(), Some("Marc-Etienne BARRUT"));
        assert_eq!(d.mri_of_token("0a7c1d02-1111-2222-3333-444455556666").as_deref(), Some(olivier));
        assert_eq!(
            spell_mentions(m.text.as_deref().unwrap(), |t| d.by_token(t)),
            "bien vu. @Marc-Etienne BARRUT pour action\n@Olivier DAUMIN pour info"
        );
        assert_eq!(html_to_markdown(html), "bien vu. @Marc-Etienne BARRUT pour action\n@Olivier DAUMIN pour info");
    }
}
