//! A chat's Notes tab: a Loop page in SharePoint Embedded, read whole and
//! turned into markdown. The page's text is a Fluid merge-tree: the summary in
//! the latest snapshot, then the operations sequenced since, replayed in order.
//! Saving rewrites the paragraphs that changed through Fluid's delta stream.
use base64::Engine;
use serde_json::{Map, Value};

/// The system message Teams posts when a chat's notes are created
/// (`ThreadActivity/FileAdd`, subtype `loopThread`); its text is the page's address.
pub const CREATED: &str = "rv-notes-created";

/// Where a chat's notes page lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    /// `https://<tenant>.sharepoint.com`.
    pub host: String,
    pub drive: String,
    pub item: String,
}

/// The page named by a `FileAdd` event's address: its `nav` parameter is a
/// base64 query `s=<container>&d=<drive>&f=<item>&...`.
pub fn page(uri: &str) -> Option<Page> {
    let url = url::Url::parse(uri).ok()?;
    let host = format!("{}://{}", url.scheme(), url.host_str()?);
    if url.scheme() != "https" || !url.host_str()?.ends_with(".sharepoint.com") {
        return None;
    }
    let nav = url.query_pairs().find(|(k, _)| k == "nav")?.1.into_owned();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(nav.trim_end_matches('='))
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(nav.trim_end_matches('=')))
        .ok()?;
    let query = String::from_utf8(decoded).ok()?;
    let field = |name: &str| {
        url::form_urlencoded::parse(query.as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
    };
    let (drive, item) = (field("d")?, field("f")?);
    (!drive.is_empty() && !item.is_empty()).then_some(Page { host, drive, item })
}

/// Reads the page with a SharePoint bearer for its host: the latest snapshot,
/// then the operations sequenced after it.
pub async fn fetch(http: &reqwest::Client, token: &str, page: &Page) -> Result<Text, rv_provider::rest::RestError> {
    use crate::auth::refusal;
    let item = format!("{}/_api/v2.1/drives/{}/items/{}/opStream", page.host, page.drive, page.item);
    let get = |url: String| async move {
        let response = http
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| rv_provider::rest::RestError::network(e.to_string()))?;
        let status = response.status().as_u16();
        if status >= 400 {
            return Err(refusal(&format!("notes_{status}"), status));
        }
        response.json::<Value>().await.map_err(|e| rv_provider::rest::RestError::network(e.to_string()))
    };
    let snapshot = get(format!("{item}/snapshots/trees/latest?ump=1")).await?;
    let latest = snapshot["latestSequenceNumber"].as_i64().unwrap_or(0);
    // The service refuses an open range ("must specify 'AND' filter").
    let later = get(format!(
        "{item}?ump=1&filter=sequenceNumber%20ge%20{}%20and%20sequenceNumber%20le%20{}",
        latest + 1,
        latest + 5000
    ))
    .await
    .map(|body| body["value"].as_array().cloned().unwrap_or_default())
    .unwrap_or_default();
    read(&snapshot, &later).ok_or_else(|| refusal("notes_format", 200))
}

/// The page as markdown, with who changed it last and when.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Text {
    pub markdown: String,
    /// The Loop component whose `text` channel holds the page.
    pub component: String,
    blocks: Vec<Block>,
    /// The last operation applied.
    pub sequence: i64,
    pub updated_by: Option<String>,
    /// Milliseconds since the epoch.
    pub updated_at: Option<i64>,
}

#[derive(Clone)]
enum Unit {
    /// One UTF-16 code unit: Fluid counts positions as JavaScript does.
    Text(u16, Map<String, Value>),
    Marker(Map<String, Value>),
}

/// The page's text from its latest snapshot (`opStream/snapshots/trees/latest`,
/// JSON form) and any operations fetched after it.
pub fn read(snapshot: &Value, later: &[Value]) -> Option<Text> {
    let tree = snapshot.pointer("/trees/0")?;
    let blobs: std::collections::HashMap<&str, &Value> = snapshot["blobs"]
        .as_array()
        .map(|all| all.iter().filter_map(|b| Some((b["id"].as_str()?, b))).collect())
        .unwrap_or_default();
    let blob = |id: &str| -> Option<String> {
        let b = blobs.get(id)?;
        let content = b["content"].as_str()?;
        if b["encoding"].as_str() == Some("base64") {
            String::from_utf8(base64::engine::general_purpose::STANDARD.decode(content).ok()?).ok()
        } else {
            Some(content.to_owned())
        }
    };
    let entries: Vec<(&str, &str)> = tree["entries"]
        .as_array()?
        .iter()
        .filter_map(|e| Some((e["path"].as_str()?, e["id"].as_str().unwrap_or_default())))
        .collect();
    let (header_path, header_id) = entries.iter().find(|(path, _)| path.ends_with("/.channels/text/content/header"))?;
    let component = header_path.strip_prefix(".app/.channels/")?.split('/').next()?.to_owned();
    let header: Value = serde_json::from_str(&blob(header_id)?).ok()?;
    let folder = header_path.trim_end_matches("header");
    let mut units = Vec::new();
    let chunks: Vec<String> = header
        .pointer("/headerMetadata/orderedChunkMetadata")
        .and_then(Value::as_array)
        .map(|all| all.iter().filter_map(|c| c["id"].as_str().map(str::to_owned)).collect())
        .unwrap_or_else(|| vec!["header".to_owned()]);
    for chunk in chunks {
        let body = if chunk == "header" {
            header.clone()
        } else {
            let path = format!("{folder}{chunk}");
            let Some((_, id)) = entries.iter().find(|(p, _)| *p == path) else { continue };
            blob(id).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
        };
        for segment in body["segmentTexts"].as_array().into_iter().flatten() {
            units.extend(segment_units(segment));
        }
    }
    let base = header.pointer("/headerMetadata/sequenceNumber").and_then(Value::as_i64).unwrap_or(0);
    let lists = lists_in(snapshot, &blob);
    let mut text = Text { sequence: base, component: component.clone(), ..Text::default() };
    let mut sequenced: Vec<&Value> = snapshot["ops"].as_array().into_iter().flatten().chain(later.iter()).collect();
    sequenced.sort_by_key(|o| sequence_of(o));
    let mut seen = std::collections::HashSet::new();
    for entry in sequenced {
        let seq = sequence_of(entry);
        if seq <= base || !seen.insert(seq) {
            continue;
        }
        let op = entry.get("op").unwrap_or(entry);
        let Some(contents) = op["contents"].as_str().and_then(|c| serde_json::from_str::<Value>(c).ok()) else {
            text.sequence = text.sequence.max(seq);
            continue;
        };
        let mut changed = false;
        for merge in merge_ops(&contents, &component) {
            changed |= apply(&mut units, &merge, &mut text);
        }
        if changed {
            text.updated_at = op["timestamp"].as_i64().or(text.updated_at);
        }
        text.sequence = text.sequence.max(seq);
    }
    text.blocks = blocks(&units, &lists);
    text.markdown = render(&text.blocks);
    Some(text)
}

fn sequence_of(entry: &Value) -> i64 {
    entry["sequenceNumber"]
        .as_i64()
        .or_else(|| entry.pointer("/op/sequenceNumber").and_then(Value::as_i64))
        .unwrap_or(0)
}

fn props_of(segment: &Value) -> Map<String, Value> {
    segment["props"].as_object().cloned().unwrap_or_default()
}

fn segment_units(segment: &Value) -> Vec<Unit> {
    if let Some(text) = segment.as_str() {
        return text.encode_utf16().map(|u| Unit::Text(u, Map::new())).collect();
    }
    if segment.get("marker").is_some() {
        return vec![Unit::Marker(props_of(segment))];
    }
    let props = props_of(segment);
    segment["text"]
        .as_str()
        .map(|t| t.encode_utf16().map(|u| Unit::Text(u, props.clone())).collect())
        .unwrap_or_default()
}

/// The merge-tree operations a sequenced op carries for the page's text,
/// unwrapping grouped batches. A compressed or chunked batch is skipped.
fn merge_ops(contents: &Value, component: &str) -> Vec<Value> {
    match contents["type"].as_str() {
        Some("groupedBatch") => contents["contents"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|inner| merge_ops(&inner["contents"], component))
            .collect(),
        Some("component") => {
            let envelope = &contents["contents"];
            let content = &envelope.pointer("/contents/content").cloned().unwrap_or(Value::Null);
            if envelope["address"].as_str() != Some(component) || content["address"].as_str() != Some("text") {
                return Vec::new();
            }
            vec![content["contents"].clone()]
        }
        _ => Vec::new(),
    }
}

/// Applies one merge-tree operation in sequence order; true when the text changed.
fn apply(units: &mut Vec<Unit>, op: &Value, text: &mut Text) -> bool {
    let at = |key: &str| op[key].as_u64().map(|p| (p as usize).min(units.len()));
    match op["type"].as_u64() {
        Some(0) => {
            let Some(pos) = at("pos1") else { return false };
            let inserted = segment_units(&op["seg"]);
            if let Some(name) = op.pointer("/seg/props/attribution/name").and_then(Value::as_str) {
                text.updated_by = Some(name.to_owned());
            }
            let changed = !inserted.is_empty();
            units.splice(pos..pos, inserted);
            changed
        }
        Some(1) | Some(4) | Some(5) => {
            let (Some(from), Some(to)) = (at("pos1"), at("pos2")) else { return false };
            if from >= to {
                return false;
            }
            units.drain(from..to);
            true
        }
        Some(2) => {
            let (Some(from), Some(to)) = (at("pos1"), at("pos2")) else { return false };
            let Some(changes) = op["props"].as_object() else { return false };
            for unit in &mut units[from..to.max(from)] {
                let props = match unit {
                    Unit::Text(_, p) | Unit::Marker(p) => p,
                };
                for (key, value) in changes {
                    if value.is_null() {
                        props.remove(key);
                    } else {
                        props.insert(key.clone(), value.clone());
                    }
                }
            }
            from < to
        }
        Some(3) => {
            let mut changed = false;
            for inner in op["ops"].as_array().into_iter().flatten() {
                changed |= apply(units, inner, text);
            }
            changed
        }
        _ => false,
    }
}

fn flag(props: &Map<String, Value>, keys: &[&str]) -> bool {
    keys.iter().any(|k| match props.get(*k) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().is_some_and(|n| n != 0),
        Some(Value::String(s)) => !s.is_empty() && s != "false" && s != "0",
        _ => false,
    })
}

fn text_of(props: &Map<String, Value>, key: &str) -> Option<String> {
    match props.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Object(o)) => o.get("value").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned),
        _ => None,
    }
}

fn link(props: &Map<String, Value>) -> Option<String> {
    ["hyperlink!url", "link", "hyperlink", "href", "url"].iter().find_map(|k| match props.get(*k) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Object(o)) => {
            o.get("url").or_else(|| o.get("href")).or_else(|| o.get("value")).and_then(Value::as_str).map(str::to_owned)
        }
        _ => None,
    })
}

/// Loop writes a strikethrough either as its own flag or as a text decoration.
fn struck(props: &Map<String, Value>) -> bool {
    flag(props, &["format!strikeThrough", "strikethrough", "strike"])
        || props.get("format!textDecoration").is_some_and(|v| {
            let v = v.to_string().to_ascii_lowercase();
            v.contains("line-through") || v.contains("strike")
        })
}

fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '*' | '_' | '[' | ']' | '`' | '~') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The inline formatting the editor gives a run, as markdown reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Marks {
    bold: bool,
    italic: bool,
    struck: bool,
    code: bool,
    link: Option<String>,
}

impl Marks {
    fn of(props: &Map<String, Value>) -> Marks {
        Marks {
            bold: flag(props, &["format!bold", "bold"]),
            italic: flag(props, &["format!italic", "italic"]),
            struck: struck(props),
            code: flag(props, &["code", "inlineCode"]),
            link: link(props),
        }
    }

    /// The editor's properties for these marks; `null` clears one.
    fn props(&self) -> Map<String, Value> {
        let mut out = Map::new();
        let set = |on: bool| if on { Value::Bool(true) } else { Value::Null };
        out.insert("format!bold".into(), set(self.bold));
        out.insert("format!italic".into(), set(self.italic));
        out.insert("format!strikeThrough".into(), set(self.struck));
        out.insert("hyperlink!url".into(), self.link.clone().map(Value::String).unwrap_or(Value::Null));
        out
    }
}

/// A run of text with the same inline formatting, as markdown.
fn inline(runs: &[(String, Marks)]) -> String {
    runs.iter()
        .map(|(text, marks)| {
            if text.trim().is_empty() {
                return text.clone();
            }
            let mut out = escaped(text);
            if marks.code {
                out = format!("`{}`", text.replace('`', "'"));
            }
            if marks.struck {
                out = format!("~~{out}~~");
            }
            if marks.italic {
                out = format!("*{out}*");
            }
            if marks.bold {
                out = format!("**{out}**");
            }
            match &marks.link {
                Some(url) => format!("[{out}]({url})"),
                None => out,
            }
        })
        .collect()
}

/// What a paragraph is, from its marker.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    Paragraph,
    Heading(usize),
    Quote,
    Code,
    Bullet(usize),
    Numbered(usize),
    Check(usize, bool),
}

impl Kind {
    fn listed(&self) -> bool {
        matches!(self, Kind::Bullet(_) | Kind::Numbered(_) | Kind::Check(..))
    }

    /// The editor's paragraph style for this kind, `None` for a plain paragraph.
    fn style(&self) -> Option<String> {
        match self {
            Kind::Heading(n) => Some(format!("Heading {n}")),
            Kind::Quote => Some("Quote".into()),
            Kind::Code => Some("Code".into()),
            _ => None,
        }
    }
}

/// The list formats a page declares: list id → the format of each level
/// (`%cb` a checkbox, a `cssClass` bullet, else numbered).
type Lists = std::collections::HashMap<String, Vec<String>>;

fn level_of(props: &Map<String, Value>) -> usize {
    ["list!level", "list!indentLevel", "indentLevel", "listLevel", "level"]
        .iter()
        .find_map(|k| props.get(*k).and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok())))
        .unwrap_or(0)
        .min(8) as usize
}

fn checked(props: &Map<String, Value>) -> bool {
    flag(props, &["list!checked", "checked", "isChecked", "completed", "done"])
        || props.iter().any(|(k, v)| k.to_ascii_lowercase().contains("state") && v.as_str() == Some("checked"))
}

fn kind_of(props: &Map<String, Value>, lists: &Lists) -> Kind {
    if let Some(style) = text_of(props, "style!reference") {
        let lower = style.to_ascii_lowercase();
        if let Some(n) = lower.strip_prefix("heading ").and_then(|n| n.trim().parse::<usize>().ok()) {
            return Kind::Heading(n.clamp(1, 6));
        }
        match lower.as_str() {
            "title" => return Kind::Heading(1),
            "subtitle" => return Kind::Heading(2),
            "quote" | "intense quote" | "callout" => return Kind::Quote,
            "code" => return Kind::Code,
            _ => {}
        }
    }
    let level = level_of(props);
    if let Some(list) = text_of(props, "list!reference") {
        let format = lists.get(&list).and_then(|formats| formats.get(level)).map(String::as_str).unwrap_or("");
        if format.contains("%cb") || checked(props) {
            return Kind::Check(level, checked(props));
        }
        if format.contains("%cd") && !format.contains("cssClass") {
            return Kind::Numbered(level);
        }
        return Kind::Bullet(level);
    }
    let kind = props.get("nodeType").and_then(Value::as_str).unwrap_or("Paragraph").to_ascii_lowercase();
    if kind.contains("heading") || kind.contains("title") {
        let n = props
            .get("headingLevel")
            .and_then(Value::as_u64)
            .or_else(|| kind.chars().filter(char::is_ascii_digit).collect::<String>().parse().ok())
            .unwrap_or(1)
            .clamp(1, 6) as usize;
        return Kind::Heading(n);
    }
    if kind.contains("check") || kind.contains("task") || kind.contains("todo") {
        return Kind::Check(level, checked(props));
    }
    if kind.contains("number") || (kind.contains("ordered") && !kind.contains("unordered")) {
        return Kind::Numbered(level);
    }
    if kind.contains("list") || kind.contains("bullet") {
        return Kind::Bullet(level);
    }
    if kind.contains("quote") {
        return Kind::Quote;
    }
    if kind.contains("code") {
        return Kind::Code;
    }
    Kind::Paragraph
}

/// One paragraph of the page: its text runs and the marker that closes it,
/// with where both sit in the merge-tree.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Block {
    kind: Kind,
    runs: Vec<(String, Marks)>,
    /// Position of the paragraph's first unit.
    start: usize,
    /// Position of its marker; the page's length for text after the last one.
    marker: usize,
    props: Option<Map<String, Value>>,
}

impl Block {
    fn line(&self) -> String {
        let body = inline(&self.runs);
        match &self.kind {
            Kind::Paragraph => match self.runs.split_first() {
                // A list item or quote written as text keeps its prefix readable.
                Some(((first, marks), rest)) if *marks == Marks::default() => match literal_prefix(first) {
                    Some(n) => {
                        let mut runs = vec![(first[n..].to_owned(), marks.clone())];
                        runs.extend_from_slice(rest);
                        format!("{}{}", &first[..n], inline(&runs))
                    }
                    None => body,
                },
                _ => body,
            },
            Kind::Code => body,
            Kind::Heading(n) => format!("{} {body}", "#".repeat(*n)),
            Kind::Quote => format!("> {body}"),
            Kind::Bullet(l) => format!("{}- {body}", "  ".repeat(*l)),
            Kind::Numbered(l) => format!("{}1. {body}", "  ".repeat(*l)),
            Kind::Check(l, done) => format!("{}- [{}] {body}", "  ".repeat(*l), if *done { "x" } else { " " }),
        }
    }

    fn text(&self) -> String {
        self.runs.iter().map(|(t, _)| t.as_str()).collect()
    }
}

/// The list formats declared anywhere in the snapshot: `List` nodes carry
/// `list!id` and one `list!itemFormat-<level>` per level.
fn lists_in(snapshot: &Value, blob: &dyn Fn(&str) -> Option<String>) -> Lists {
    fn walk(v: &Value, out: &mut Lists) {
        match v {
            Value::Object(o) => {
                let id = o.get("list!id").and_then(|v| v.as_str().or_else(|| v.get("value")?.as_str()));
                if let Some(id) = id {
                    let mut formats = vec![String::new(); 9];
                    for (k, v) in o {
                        if let Some(n) = k.strip_prefix("list!itemFormat-").and_then(|n| n.parse::<usize>().ok()) {
                            let f = v.as_str().or_else(|| v.get("value")?.as_str()).unwrap_or_default();
                            if n < formats.len() {
                                formats[n] = f.to_owned();
                            }
                        }
                    }
                    out.insert(id.to_owned(), formats);
                }
                o.values().for_each(|v| walk(v, out));
            }
            Value::Array(a) => a.iter().for_each(|v| walk(v, out)),
            Value::String(s) if s.contains("list!id") => {
                if let Ok(inner) = serde_json::from_str::<Value>(s) {
                    walk(&inner, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Lists::new();
    for b in snapshot["blobs"].as_array().into_iter().flatten() {
        if let Some(text) = b["id"].as_str().and_then(blob)
            && text.contains("list!id")
            && let Ok(v) = serde_json::from_str::<Value>(&text)
        {
            walk(&v, &mut out);
        }
    }
    out
}

fn blocks(units: &[Unit], lists: &Lists) -> Vec<Block> {
    let mut out = Vec::new();
    let mut runs: Vec<(String, Marks)> = Vec::new();
    let mut pending: Vec<u16> = Vec::new();
    let mut pending_marks: Option<Marks> = None;
    let mut start = 0;
    let flush = |pending: &mut Vec<u16>, marks: &mut Option<Marks>, runs: &mut Vec<(String, Marks)>| {
        if !pending.is_empty() {
            runs.push((String::from_utf16_lossy(pending), marks.take().unwrap_or_default()));
            pending.clear();
        }
    };
    for (pos, unit) in units.iter().enumerate() {
        match unit {
            Unit::Text(u, props) => {
                let marks = Marks::of(props);
                if pending_marks.as_ref().is_some_and(|m| *m != marks) {
                    flush(&mut pending, &mut pending_marks, &mut runs);
                }
                pending_marks.get_or_insert(marks);
                pending.push(*u);
            }
            Unit::Marker(props) => {
                flush(&mut pending, &mut pending_marks, &mut runs);
                out.push(Block {
                    kind: kind_of(props, lists),
                    runs: std::mem::take(&mut runs),
                    start,
                    marker: pos,
                    props: Some(props.clone()),
                });
                start = pos + 1;
            }
        }
    }
    flush(&mut pending, &mut pending_marks, &mut runs);
    if !runs.is_empty() {
        out.push(Block { kind: Kind::Paragraph, runs, start, marker: units.len(), props: None });
    }
    out
}

/// The page's markdown: consecutive list items and code lines stay together.
fn render(blocks: &[Block]) -> String {
    let mut out = String::new();
    let mut previous: Option<&Kind> = None;
    let mut previous_family: Option<u8> = None;
    let mut i = 0;
    while i < blocks.len() {
        let block = &blocks[i];
        if previous.is_some() {
            let tight = list_family(block).is_some() && list_family(block) == previous_family;
            out.push_str(if tight { "\n" } else { "\n\n" });
        }
        if block.kind == Kind::Code {
            let mut lines = Vec::new();
            while i < blocks.len() && blocks[i].kind == Kind::Code {
                lines.push(blocks[i].text());
                i += 1;
            }
            out.push_str(&format!("```\n{}\n```", lines.join("\n")));
            previous = Some(&Kind::Code);
            previous_family = None;
            continue;
        }
        out.push_str(&block.line());
        previous = Some(&block.kind);
        previous_family = list_family(block);
        i += 1;
    }
    out.trim().to_owned()
}

/// The kind of list a paragraph belongs to, native or written as text:
/// 1 bullets, 2 numbers, 3 checkboxes.
fn list_family(block: &Block) -> Option<u8> {
    match block.kind {
        Kind::Bullet(_) => return Some(1),
        Kind::Numbered(_) => return Some(2),
        Kind::Check(..) => return Some(3),
        Kind::Paragraph => {}
        _ => return None,
    }
    let (text, marks) = block.runs.first()?;
    if *marks != Marks::default() || literal_prefix(text).is_none() {
        return None;
    }
    let rest = text.trim_start();
    if rest.starts_with('>') {
        None
    } else if rest.starts_with("- [") {
        Some(3)
    } else if rest.starts_with(|c: char| c.is_ascii_digit()) {
        Some(2)
    } else {
        Some(1)
    }
}

/// Markdown's inline marks back into runs: `**`, `*`, `~~`, `` ` ``,
/// `[text](url)` and backslash escapes.
fn parse_inline(text: &str) -> Vec<(String, Marks)> {
    fn go(chars: &[char], base: &Marks, out: &mut Vec<(String, Marks)>) {
        let mut buf = String::new();
        let mut i = 0;
        let push = |buf: &mut String, marks: &Marks, out: &mut Vec<(String, Marks)>| {
            if !buf.is_empty() {
                match out.last_mut() {
                    Some((t, m)) if m == marks => t.push_str(buf),
                    _ => out.push((buf.clone(), marks.clone())),
                }
                buf.clear();
            }
        };
        let find = |from: usize, pat: &[char]| -> Option<usize> {
            let mut j = from;
            while j + pat.len() <= chars.len() {
                if chars[j] == '\\' {
                    j += 2;
                    continue;
                }
                if chars[j..j + pat.len()] == *pat {
                    return Some(j);
                }
                j += 1;
            }
            None
        };
        while i < chars.len() {
            let c = chars[i];
            if c == '\\' && i + 1 < chars.len() {
                buf.push(chars[i + 1]);
                i += 2;
                continue;
            }
            let mut nested = |open: usize, close: &[char], f: &dyn Fn(&mut Marks)| -> Option<usize> {
                let end = find(i + open, close)?;
                if end == i + open {
                    return None;
                }
                push(&mut buf, base, out);
                let mut marks = base.clone();
                f(&mut marks);
                go(&chars[i + open..end], &marks, out);
                Some(end + close.len())
            };
            let next = if chars[i..].starts_with(&['*', '*']) {
                nested(2, &['*', '*'], &|m| m.bold = true)
            } else if chars[i..].starts_with(&['~', '~']) {
                nested(2, &['~', '~'], &|m| m.struck = true)
            } else if c == '*' || c == '_' {
                nested(1, &[c], &|m| m.italic = true)
            } else if c == '`' {
                let end = find(i + 1, &['`']);
                end.map(|end| {
                    push(&mut buf, base, out);
                    let mut marks = base.clone();
                    marks.code = true;
                    out.push((chars[i + 1..end].iter().collect(), marks));
                    end + 1
                })
            } else if c == '[' {
                find(i + 1, &[']']).and_then(|close| {
                    if chars.get(close + 1) != Some(&'(') {
                        return None;
                    }
                    let url_end = find(close + 2, &[')'])?;
                    let url: String = chars[close + 2..url_end].iter().collect();
                    push(&mut buf, base, out);
                    let mut marks = base.clone();
                    marks.link = Some(url);
                    go(&chars[i + 1..close], &marks, out);
                    Some(url_end + 1)
                })
            } else {
                None
            };
            match next {
                Some(n) => i = n,
                None => {
                    buf.push(c);
                    i += 1;
                }
            }
        }
        push(&mut buf, base, out);
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    go(&chars, &Marks::default(), &mut out);
    out
}

/// Markdown as the paragraphs it describes.
/// A paragraph markdown asks for: its kind, its runs, and the prefix it was written with.
type Wanted = (Kind, Vec<(String, Marks)>, String);

fn parse(markdown: &str) -> Vec<Wanted> {
    let mut out = Vec::new();
    let mut lines = markdown.lines().peekable();
    while let Some(raw) = lines.next() {
        if raw.trim_start().starts_with("```") {
            for code in lines.by_ref() {
                if code.trim_start().starts_with("```") {
                    break;
                }
                out.push((Kind::Code, vec![(code.to_owned(), Marks::default())], String::new()));
            }
            continue;
        }
        if raw.trim().is_empty() {
            continue;
        }
        let indent = raw.len() - raw.trim_start().len();
        let level = (indent / 2).min(8);
        let line = raw.trim_start();
        let (kind, body) = if let Some(rest) = line.strip_prefix("- [x] ").or_else(|| line.strip_prefix("- [X] ")) {
            (Kind::Check(level, true), rest)
        } else if let Some(rest) = line.strip_prefix("- [ ] ") {
            (Kind::Check(level, false), rest)
        } else if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            (Kind::Bullet(level), rest)
        } else if let Some((n, rest)) =
            line.split_once(". ").filter(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        {
            let _ = n;
            (Kind::Numbered(level), rest)
        } else if let Some(rest) = line.strip_prefix("> ").or_else(|| line.strip_prefix('>')) {
            (Kind::Quote, rest)
        } else if let Some(hashes) =
            line.split_once(' ').filter(|(h, _)| (1..=6).contains(&h.len()) && h.chars().all(|c| c == '#'))
        {
            (Kind::Heading(hashes.0.len()), hashes.1)
        } else {
            (Kind::Paragraph, line)
        };
        let prefix = raw[..raw.len() - body.len()].to_owned();
        out.push((kind, parse_inline(body), prefix));
    }
    out
}

/// The merge-tree operations turning the page's `blocks` into `markdown`, in
/// descending position so each is valid against the version read. Paragraphs
/// that render the same are left alone; a new list item joins its
/// neighbour's list. `author` is the attribution Loop stamps on new text.
fn edit(blocks: &[Block], markdown: &str, author: &Value) -> Vec<Value> {
    let wanted = parse(markdown);
    let old: Vec<String> = blocks.iter().map(Block::line).collect();
    let new: Vec<String> = wanted
        .iter()
        .map(|(k, r, p)| {
            let (kind, runs) = written(k, r, p, None);
            if kind == *k {
                Block { kind, runs, start: 0, marker: 0, props: None }.line()
            } else {
                format!("{p}{}", inline(r))
            }
        })
        .collect();
    // Longest common subsequence of rendered paragraphs.
    let (n, m) = (old.len(), new.len());
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if old[i] == new[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut hunks: Vec<(usize, usize, usize, usize)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && old[i] == new[j] {
            i += 1;
            j += 1;
            continue;
        }
        let (i0, j0) = (i, j);
        while (i < n || j < m) && !(i < n && j < m && old[i] == new[j]) {
            if j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) {
                i += 1;
            } else {
                j += 1;
            }
        }
        hunks.push((i0, i, j0, j));
    }
    let page_end = blocks.last().map(|b| b.marker + usize::from(b.props.is_some())).unwrap_or(0);
    let mut ops = Vec::new();
    for (i0, i1, j0, j1) in hunks.into_iter().rev() {
        let pairs = (i1 - i0).min(j1 - j0);
        // New paragraphs beyond the pairs, inserted where the old hunk ends.
        if j1 - j0 > pairs {
            let at = if i1 < n { blocks[i1].start } else { page_end };
            let neighbour = (i0..i1).rev().chain((0..i0).rev()).map(|k| &blocks[k]).find(|b| b.kind.listed());
            for k in (j0 + pairs..j1).rev() {
                let (kind, runs) = written(&wanted[k].0, &wanted[k].1, &wanted[k].2, neighbour);
                ops.push(insert_marker(at, &kind, neighbour, author));
                for (text, marks) in runs.iter().rev() {
                    ops.push(insert_text(at, text, marks, author));
                }
            }
        }
        for k in (0..(i1 - i0).max(pairs)).rev() {
            let block = &blocks[i0 + k];
            if k >= pairs {
                let end = block.marker + usize::from(block.props.is_some());
                if end > block.start {
                    ops.push(json_remove(block.start, end));
                }
                continue;
            }
            let own = block.kind.listed().then_some(block);
            let (kind, runs) = written(&wanted[j0 + k].0, &wanted[j0 + k].1, &wanted[j0 + k].2, own);
            let runs = &runs;
            if kind != block.kind && block.props.is_some() && !(kind.listed() && block.kind.listed()) {
                ops.push(restyle(block.marker, &kind, &block.kind));
            }
            if block.runs != *runs {
                if block.marker > block.start {
                    ops.push(json_remove(block.start, block.marker));
                }
                for (text, marks) in runs.iter().rev() {
                    ops.push(insert_text(block.start, text, marks, author));
                }
            }
        }
    }
    ops
}

/// What a paragraph is written as: Loop keeps headings and code as a style
/// and list items in a list, but a quote is a component of its own and a list
/// needs one to join, so those stay readable as their markdown prefix.
fn written(kind: &Kind, runs: &[(String, Marks)], prefix: &str, list: Option<&Block>) -> (Kind, Vec<(String, Marks)>) {
    let prefixed = |prefix: String| {
        let mut runs = runs.to_vec();
        match runs.first_mut() {
            Some((text, marks)) if *marks == Marks::default() => text.insert_str(0, &prefix),
            _ => runs.insert(0, (prefix, Marks::default())),
        }
        (Kind::Paragraph, runs)
    };
    match kind {
        Kind::Quote => prefixed("> ".into()),
        Kind::Bullet(_) | Kind::Numbered(_) | Kind::Check(..) if list.is_none() => prefixed(prefix.to_owned()),
        other => (other.clone(), runs.to_vec()),
    }
}

/// The length of a leading list or quote prefix written as text.
fn literal_prefix(text: &str) -> Option<usize> {
    let indent = text.len() - text.trim_start_matches(' ').len();
    let rest = &text[indent..];
    if let Some(p) = ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "> "].iter().find(|p| rest.starts_with(**p)) {
        return Some(indent + p.len());
    }
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    (digits > 0 && rest[digits..].starts_with(". ")).then_some(indent + digits + 2)
}

fn json_remove(from: usize, to: usize) -> Value {
    serde_json::json!({"pos1": from, "pos2": to, "type": 1})
}

fn insert_text(at: usize, text: &str, marks: &Marks, author: &Value) -> Value {
    let mut props: Map<String, Value> = marks.props().into_iter().filter(|(_, v)| !v.is_null()).collect();
    props.insert("attribution".into(), author.clone());
    serde_json::json!({"pos1": at, "seg": {"text": text, "props": props}, "type": 0})
}

fn insert_marker(at: usize, kind: &Kind, neighbour: Option<&Block>, author: &Value) -> Value {
    let mut props = Map::new();
    props.insert("attribution".into(), author.clone());
    props.insert("markerId".into(), Value::String(uuid()));
    props.insert("nodeType".into(), Value::String("Paragraph".into()));
    if let Some(style) = kind.style() {
        props.insert("style!reference".into(), Value::String(style));
    }
    if kind.listed()
        && let Some(list) = neighbour.and_then(|b| b.props.as_ref())
    {
        for (k, v) in list {
            if k.starts_with("list!") {
                props.insert(k.clone(), v.clone());
            }
        }
    }
    serde_json::json!({"pos1": at, "seg": {"marker": {"refType": 1}, "props": props}, "type": 0})
}

/// A marker's style changed: headings, quotes and code are a style; leaving a
/// list drops its reference.
fn restyle(at: usize, to: &Kind, from: &Kind) -> Value {
    let mut props = Map::new();
    props.insert("style!reference".into(), to.style().map(Value::String).unwrap_or(Value::Null));
    if from.listed() && !to.listed() {
        props.insert("list!reference".into(), Value::Null);
    }
    serde_json::json!({"pos1": at, "pos2": at + 1, "props": props, "type": 2})
}

fn uuid() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// Saves `markdown` over the page read at `expected`: the paragraphs that
/// changed are rewritten through Fluid's delta stream, as Loop's own editor
/// does (`joinSession`, socket.io `connect_document`, `submitOp`). A page
/// changed since `expected` answers [`CONFLICT`].
pub async fn save(
    http: &reqwest::Client,
    token: &str,
    push: &str,
    page: &Page,
    expected: i64,
    markdown: &str,
    author: &Value,
) -> Result<Text, rv_provider::rest::RestError> {
    use crate::auth::refusal;
    let current = fetch(http, token, page).await?;
    if current.sequence != expected {
        return Err(refusal(CONFLICT, 409));
    }
    let ops = edit(&current.blocks, markdown, author);
    if ops.is_empty() {
        return Ok(current);
    }
    let sequenced = submit(http, token, push, page, &current, ops).await?;
    // The op stream serves a sequenced op a moment after the socket confirms it.
    for _ in 0..10 {
        let text = fetch(http, token, page).await?;
        if text.sequence >= sequenced {
            return Ok(text);
        }
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    }
    fetch(http, token, page).await
}

/// The error a save answers when the page moved on since it was read.
pub const CONFLICT: &str = "revision_conflict";

async fn submit(
    http: &reqwest::Client,
    token: &str,
    push: &str,
    page: &Page,
    read: &Text,
    ops: Vec<Value>,
) -> Result<i64, rv_provider::rest::RestError> {
    use crate::auth::refusal;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let network = |e: String| rv_provider::rest::RestError::network(e);
    let join = format!("{}/_api/v2.1/drives/{}/items/{}/opStream/joinSession", page.host, page.drive, page.item);
    let response = http
        .post(join)
        .bearer_auth(token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| network(e.to_string()))?;
    let status = response.status().as_u16();
    if status >= 400 {
        return Err(refusal(&format!("notes_join_{status}"), status));
    }
    let session: Value = response.json().await.map_err(|e| network(e.to_string()))?;
    let (Some(socket), Some(id), Some(tenant)) = (
        session["deltaStreamSocketUrl"].as_str(),
        session["id"].as_str(),
        session["runtimeTenantId"].as_str().or(session["tenantId"].as_str()),
    ) else {
        return Err(refusal("notes_join_shape", 200));
    };
    let socket_token = session["socketToken"].as_str().filter(|t| !t.is_empty()).unwrap_or(push);
    let mut url = url::Url::parse(socket).map_err(|e| network(e.to_string()))?;
    url.set_scheme(if url.scheme() == "http" { "ws" } else { "wss" }).ok();
    // The address's path is the socket.io namespace (`/fluid`), served at `/socket.io/`.
    url.set_path("/socket.io/");
    url.query_pairs_mut().append_pair("EIO", "4").append_pair("transport", "websocket");
    let mut request = {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        url.as_str().into_client_request().map_err(|e| network(e.to_string()))?
    };
    for (name, value) in [("origin", "https://teams.microsoft.com"), ("user-agent", "Mozilla/5.0 rocket-vibe")] {
        if let Ok(v) = value.parse() {
            request.headers_mut().insert(name, v);
        }
    }
    let (mut ws, _) =
        tokio::time::timeout(std::time::Duration::from_secs(15), tokio_tungstenite::connect_async(request))
            .await
            .map_err(|_| network("notes socket timeout".into()))?
            .map_err(|e| network(format!("{e} at {}{}", url.host_str().unwrap_or_default(), url.path())))?;
    let emit = |event: &str, args: &[Value]| {
        let mut frame = vec![Value::String(event.to_owned())];
        frame.extend_from_slice(args);
        Message::text(format!("42/fluid,{}", Value::Array(frame)))
    };
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut client_id: Option<String> = None;
    let mut sent = 0usize;
    let mut join_seq: Option<i64> = None;
    let mut acked = 0usize;
    let mut sequenced = 0i64;
    let mut last_seen = read.sequence;
    let mut foreign_text = false;
    let outcome = loop {
        let frame = match tokio::time::timeout_at(deadline, ws.next()).await {
            Err(_) => break Err(network("notes socket: no acknowledgement".into())),
            Ok(None) => break Err(network("notes socket closed".into())),
            Ok(Some(Err(e))) => break Err(network(e.to_string())),
            Ok(Some(Ok(m))) => m,
        };
        let Message::Text(text) = frame else { continue };
        let text = text.as_str();
        if text.starts_with('0') {
            ws.send(Message::text("40/fluid,")).await.map_err(|e| network(e.to_string()))?;
            continue;
        }
        if text == "2" {
            ws.send(Message::text("3")).await.map_err(|e| network(e.to_string()))?;
            continue;
        }
        if text.starts_with("40/fluid") {
            let request = serde_json::json!({
                "client": {
                    "details": {"capabilities": {"interactive": true}, "environment": "; rocket-vibe"},
                    "mode": "write", "permission": [], "scopes": [], "user": {"id": ""}
                },
                "id": id, "mode": "write", "tenantId": tenant, "token": socket_token,
                "versions": ["^0.4.0", "^0.3.0", "^0.2.0", "^0.1.0"],
                "driverVersion": "3.7.0", "nonce": uuid(),
                "supportedFeatures": {"api_get_ops": true, "submit_signals_v2": true}
            });
            ws.send(emit("connect_document", &[request])).await.map_err(|e| network(e.to_string()))?;
            continue;
        }
        let Some(payload) = text.strip_prefix("42/fluid,") else {
            if text.starts_with("44/fluid") {
                break Err(refusal("notes_socket_refused", 403));
            }
            continue;
        };
        let Ok(Value::Array(event)) = serde_json::from_str::<Value>(payload) else { continue };
        let name = event.first().and_then(Value::as_str).unwrap_or_default();
        match name {
            "connect_document_success" => {
                let details = event.get(1).cloned().unwrap_or(Value::Null);
                if details["mode"].as_str() == Some("read") {
                    break Err(refusal("notes_read_only", 403));
                }
                client_id = details["clientId"].as_str().map(str::to_owned);
                for message in details["initialMessages"].as_array().into_iter().flatten() {
                    observe(
                        message,
                        read.sequence,
                        &mut last_seen,
                        &mut foreign_text,
                        &mut join_seq,
                        client_id.as_deref(),
                    );
                }
            }
            "connect_document_error" => {
                let reason = event.get(1).and_then(|e| e["message"].as_str()).unwrap_or_default().to_owned();
                break Err(network(format!("notes_connect {reason}")));
            }
            "nack" => break Err(refusal("notes_nack", 409)),
            "op" => {
                for message in event.get(2).and_then(Value::as_array).into_iter().flatten() {
                    observe(
                        message,
                        read.sequence,
                        &mut last_seen,
                        &mut foreign_text,
                        &mut join_seq,
                        client_id.as_deref(),
                    );
                    if client_id.is_some()
                        && message["clientId"].as_str() == client_id.as_deref()
                        && message["type"].as_str() == Some("op")
                    {
                        acked += 1;
                        sequenced = sequenced.max(message["sequenceNumber"].as_i64().unwrap_or(0));
                    }
                }
            }
            _ => {}
        }
        if foreign_text {
            break Err(refusal(CONFLICT, 409));
        }
        if let (Some(me), Some(_)) = (client_id.as_deref(), join_seq) {
            if sent == 0 {
                let messages: Vec<Value> = ops
                    .iter()
                    .enumerate()
                    .map(|(n, merge)| {
                        let contents = serde_json::json!({"type": "component", "contents": {"address": read.component,
                            "contents": {"content": {"address": "text", "contents": merge}, "type": "op"}}});
                        serde_json::json!({"contents": contents.to_string(), "referenceSequenceNumber": last_seen,
                            "type": "op", "clientSequenceNumber": n + 1})
                    })
                    .collect();
                sent = messages.len();
                ws.send(emit("submitOp", &[Value::String(me.to_owned()), Value::Array(vec![Value::Array(messages)])]))
                    .await
                    .map_err(|e| network(e.to_string()))?;
            }
            if sent > 0 && acked >= sent {
                break Ok(sequenced);
            }
        }
    };
    let _ = ws.close(None).await;
    outcome
}

/// Follows what was sequenced after the page was read: our own join, and any
/// text change someone else made meanwhile.
fn observe(
    message: &Value,
    read: i64,
    last_seen: &mut i64,
    foreign_text: &mut bool,
    join_seq: &mut Option<i64>,
    me: Option<&str>,
) {
    let seq = message["sequenceNumber"].as_i64().unwrap_or(0);
    if seq <= read {
        return;
    }
    *last_seen = (*last_seen).max(seq);
    match message["type"].as_str() {
        Some("join") => {
            let joined = message["data"]
                .as_str()
                .and_then(|d| serde_json::from_str::<Value>(d).ok())
                .and_then(|d| d["clientId"].as_str().map(str::to_owned));
            if me.is_some() && joined.as_deref() == me {
                *join_seq = Some(seq);
            }
        }
        Some("op") if message["clientId"].as_str() != me => *foreign_text = true,
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(segments: Value, ops: Value) -> Value {
        let header = json!({"segmentTexts": segments, "headerMetadata": {"orderedChunkMetadata": [{"id": "header"}], "sequenceNumber": 0}});
        json!({
            "blobs": [{"id": "h", "content": header.to_string(), "encoding": "utf-8"}],
            "latestSequenceNumber": 5,
            "ops": ops,
            "trees": [{"sequenceNumber": 0, "entries": [
                {"path": ".app/.channels/C/.channels/text/content/header", "type": "blob", "id": "h"}
            ]}]
        })
    }

    fn op(seq: i64, merge: Value) -> Value {
        let contents = json!({"type": "component", "contents": {"address": "C", "contents": {"content": {"address": "text", "contents": merge}, "type": "op"}}});
        json!({"op": {"sequenceNumber": seq, "timestamp": 1_000 + seq, "type": "op", "contents": contents.to_string()}, "sequenceNumber": seq})
    }

    fn marker() -> Value {
        json!({"marker": {"refType": 1}, "props": {"nodeType": "Paragraph"}})
    }

    fn by(name: &str, text: &str) -> Value {
        json!({"text": text, "props": {"attribution": {"name": name}}})
    }

    #[test]
    fn a_page_is_found_from_its_created_event_address() {
        let nav = base64::engine::general_purpose::STANDARD.encode(
            "s=%2Fcontentstorage%2FCSP_guid&d=b!drive&f=01ITEM&c=%2F&fluid=1&p=%40fluidx%2Floop-page-container",
        );
        let uri = format!(
            "https://tenant.sharepoint.com/contentstorage/CSP_guid/Document%20Library/19_x_thread_v2/loop_loopThread.loop?nav={nav}"
        );
        assert_eq!(
            page(&uri),
            Some(Page { host: "https://tenant.sharepoint.com".into(), drive: "b!drive".into(), item: "01ITEM".into() })
        );
        assert_eq!(page("https://evil.example.com/x.loop?nav=cz0x"), None);
        assert_eq!(page("not a url"), None);
    }

    /// The shape of a real page (scrubbed): a marker closes its paragraph, and
    /// text typed before it lands in front of it.
    #[test]
    fn typed_text_replays_into_paragraphs_closed_by_their_markers() {
        let grouped = json!({"type": "groupedBatch", "contents": [
            {"contents": {"type": "schema", "contents": {}}},
            {"contents": {"type": "component", "contents": {"address": "C", "contents": {"content": {"address": "text", "contents": {"pos1": 0, "seg": by("Ada", "É"), "type": 0}}, "type": "op"}}}}
        ]});
        let ops = json!([
            {"op": {"sequenceNumber": 1, "timestamp": 1001, "type": "op", "contents": grouped.to_string()}, "sequenceNumber": 1},
            op(2, json!({"pos1": 1, "seg": by("Ada", "lan"), "type": 0})),
            op(3, json!({"pos1": 5, "seg": marker(), "type": 0})),
            op(4, json!({"pos1": 5, "seg": by("Bob", "bonjour"), "type": 0})),
            {"op": {"sequenceNumber": 5, "type": "noop"}, "sequenceNumber": 5}
        ]);
        let text = read(&snapshot(json!([marker()]), ops), &[]).unwrap();
        assert_eq!(text.markdown, "Élan\n\nbonjour");
        assert_eq!(text.sequence, 5);
        assert_eq!(text.updated_by.as_deref(), Some("Bob"));
        assert_eq!(text.updated_at, Some(1004));
    }

    #[test]
    fn later_operations_remove_annotate_and_are_not_replayed_twice() {
        let ops = json!([op(1, json!({"pos1": 0, "seg": by("Ada", "Plan draft"), "type": 0}))]);
        let later = vec![
            op(1, json!({"pos1": 0, "seg": by("Ada", "Plan draft"), "type": 0})),
            op(2, json!({"pos1": 4, "pos2": 10, "type": 1})),
            op(3, json!({"pos1": 4, "pos2": 5, "props": {"nodeType": "Heading2"}, "type": 2})),
            op(4, json!({"pos1": 0, "pos2": 4, "props": {"bold": true}, "type": 2})),
        ];
        let text = read(&snapshot(json!([marker()]), ops), &later).unwrap();
        assert_eq!(text.markdown, "## **Plan**");
        assert_eq!(text.sequence, 4);
    }

    #[test]
    fn lists_checklists_links_and_utf16_positions() {
        let segments = json!([
            {"text": "milk", "props": {}},
            {"marker": {"refType": 1}, "props": {"nodeType": "CheckListItem", "checked": true}},
            {"text": "eggs 🥚", "props": {}},
            {"marker": {"refType": 1}, "props": {"nodeType": "CheckListItem"}},
            {"text": "site", "props": {"link": "https://example.com"}},
            {"marker": {"refType": 1}, "props": {"nodeType": "BulletedListItem"}},
            "a*b"
        ]);
        let later = vec![op(1, json!({"pos1": 12, "seg": by("Ada", "!"), "type": 0}))];
        let text = read(&snapshot(segments, json!([])), &later).unwrap();
        assert_eq!(text.markdown, "- [x] milk\n- [ ] eggs 🥚!\n\n- [site](https://example.com)\n\na\\*b");
    }

    /// A real page's snapshot, its people and ids scrubbed: typed in two
    /// sessions by two people, the second paragraph added by the second.
    #[test]
    fn a_real_snapshot_reads_as_its_two_paragraphs() {
        let snapshot: Value = serde_json::from_str(include_str!("../data/notes-snapshot.json")).unwrap();
        let text = read(&snapshot, &[]).unwrap();
        assert_eq!(text.markdown, "ÉNORME\n\nbjr");
        assert_eq!(text.sequence, 20);
        assert_eq!(text.updated_by.as_deref(), Some("Bob"));
        assert!(text.updated_at.is_some());
    }

    #[test]
    fn a_snapshot_without_text_reads_as_nothing() {
        assert_eq!(read(&json!({"trees": [{"entries": []}]}), &[]), None);
        assert_eq!(read(&snapshot(json!([marker()]), json!([])), &[]).unwrap().markdown, "");
    }

    const SAMPLE: &str = "ÉNORME\n\nbjr\n\n# Heading one\n\n## Second heading\n\nPlain with **bold**, *italic*, ~~struck~~ and [a link](https://example.com/).\n\n- bullet one\n- bullet two\n\n1. first\n2. second\n\n- [x] done item\n- [ ] open item\n\n> a quote\n\n```\nlet x = 1;\n```\n\nÉcrit depuis RocketVibe (test natif)";

    /// A page formatted in Loop (scrubbed): headings are the marker's
    /// `style!reference`, marks `format!*` on the text, links `hyperlink!url`.
    #[test]
    fn a_formatted_page_reads_as_markdown() {
        let snapshot: Value = serde_json::from_str(include_str!("../data/notes-formatted.json")).unwrap();
        let text = read(&snapshot, &[]).unwrap();
        assert_eq!(text.markdown, SAMPLE);
        assert_eq!(text.component, "C");
    }

    /// Replays merge-tree operations the way the service sequences them.
    fn applied(blocks_of: &Text, ops: &[Value]) -> String {
        let mut units = Vec::new();
        for b in &blocks_of.blocks {
            for (t, m) in &b.runs {
                let props = m.props().into_iter().filter(|(_, v)| !v.is_null()).collect::<Map<_, _>>();
                units.extend(t.encode_utf16().map(|u| Unit::Text(u, props.clone())));
            }
            if let Some(p) = &b.props {
                units.push(Unit::Marker(p.clone()));
            }
        }
        let mut scratch = Text::default();
        for op in ops {
            apply(&mut units, op, &mut scratch);
        }
        render(&blocks(&units, &Lists::new()))
    }

    #[test]
    fn saving_unchanged_markdown_sends_nothing() {
        let snapshot: Value = serde_json::from_str(include_str!("../data/notes-formatted.json")).unwrap();
        let text = read(&snapshot, &[]).unwrap();
        assert!(edit(&text.blocks, &text.markdown, &json!({})).is_empty());
    }

    #[test]
    fn an_edit_rewrites_only_what_changed_and_reads_back() {
        let snapshot: Value = serde_json::from_str(include_str!("../data/notes-formatted.json")).unwrap();
        let text = read(&snapshot, &[]).unwrap();
        let wanted = text
            .markdown
            .replace("## Second heading", "### Third level")
            .replace("bjr", "bonjour **à tous**")
            .replace("- bullet two\n", "- bullet two\n- bullet three\n")
            .replace("\n\n> a quote", "");
        let ops = edit(&text.blocks, &wanted, &json!({"name": "Ada"}));
        assert!(ops.len() < 12, "{ops:?}");
        assert!(ops.windows(2).all(|w| w[0]["pos1"].as_u64() >= w[1]["pos1"].as_u64()), "descending");
        assert_eq!(applied(&text, &ops), wanted);
    }

    #[test]
    fn new_paragraphs_carry_their_style_and_marks() {
        let ops = edit(&[], "# Title\n\nhello **world**\n\n- item", &json!({"name": "Ada"}));
        let styles: Vec<_> = ops.iter().filter_map(|o| o.pointer("/seg/props/style!reference")).collect();
        assert_eq!(styles, vec![&json!("Heading 1")]);
        assert!(ops.iter().any(|o| o.pointer("/seg/text") == Some(&json!("world"))
            && o.pointer("/seg/props/format!bold") == Some(&json!(true))));
        assert!(
            ops.iter().any(|o| o.pointer("/seg/text") == Some(&json!("- item"))),
            "a list without a list to join stays readable"
        );
        assert!(ops.iter().all(|o| o.pointer("/seg/props/attribution/name").is_none_or(|n| n == "Ada")));
    }

    #[test]
    fn inline_markdown_parses_back_into_marks() {
        let runs = parse_inline("a **b** *c* ~~d~~ [e](https://x.y/) \\*f");
        let shown: Vec<String> = runs
            .iter()
            .map(|(t, m)| {
                format!(
                    "{t}:{}{}{}{}",
                    u8::from(m.bold),
                    u8::from(m.italic),
                    u8::from(m.struck),
                    m.link.as_deref().unwrap_or("")
                )
            })
            .collect();
        assert_eq!(
            shown,
            vec!["a :000", "b:100", " :000", "c:010", " :000", "d:001", " :000", "e:000https://x.y/", " *f:000"]
        );
    }
}
