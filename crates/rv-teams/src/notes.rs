//! A chat's Notes tab: a Loop page in SharePoint Embedded, read whole and
//! turned into markdown. The page's text is a Fluid merge-tree: the summary in
//! the latest snapshot, then the operations sequenced since, replayed in order.
//! Read-only: writing means joining Fluid's delta stream.
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
    let mut text = Text { sequence: base, ..Text::default() };
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
    text.markdown = markdown(&units);
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

fn link(props: &Map<String, Value>) -> Option<String> {
    ["link", "hyperlink", "href", "url"].iter().find_map(|k| match props.get(*k) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Object(o)) => o.get("url").or_else(|| o.get("href")).and_then(Value::as_str).map(str::to_owned),
        _ => None,
    })
}

fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '*' | '_' | '[' | ']' | '`') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A run of text with the same inline formatting, as markdown.
fn inline(runs: &[(String, Map<String, Value>)]) -> String {
    runs.iter()
        .map(|(text, props)| {
            if text.trim().is_empty() {
                return text.clone();
            }
            let mut out = escaped(text);
            if flag(props, &["code", "inlineCode"]) {
                out = format!("`{}`", text.replace('`', "'"));
            }
            if flag(props, &["strikethrough", "strike"]) {
                out = format!("~~{out}~~");
            }
            if flag(props, &["italic"]) {
                out = format!("*{out}*");
            }
            if flag(props, &["bold"]) {
                out = format!("**{out}**");
            }
            match link(props) {
                Some(url) => format!("[{out}]({url})"),
                None => out,
            }
        })
        .collect()
}

/// The markdown prefix of a paragraph marker's block kind.
fn block(props: &Map<String, Value>) -> (String, bool) {
    let kind = props.get("nodeType").and_then(Value::as_str).unwrap_or("Paragraph").to_ascii_lowercase();
    let level =
        ["indentLevel", "listLevel", "level"].iter().find_map(|k| props.get(*k).and_then(Value::as_u64)).unwrap_or(0)
            as usize;
    let indent = "  ".repeat(level.min(8));
    if kind.contains("heading") || kind.contains("title") {
        let n = props
            .get("headingLevel")
            .and_then(Value::as_u64)
            .or_else(|| kind.chars().filter(char::is_ascii_digit).collect::<String>().parse().ok())
            .unwrap_or(1)
            .clamp(1, 6) as usize;
        return (format!("{} ", "#".repeat(n)), false);
    }
    if kind.contains("check") || kind.contains("task") || kind.contains("todo") {
        let done = flag(props, &["checked", "isChecked", "completed", "done"]);
        return (format!("{indent}- [{}] ", if done { "x" } else { " " }), true);
    }
    if kind.contains("number") || (kind.contains("ordered") && !kind.contains("unordered")) {
        return (format!("{indent}1. "), true);
    }
    if kind.contains("list") || kind.contains("bullet") {
        return (format!("{indent}- "), true);
    }
    if kind.contains("quote") {
        return ("> ".to_owned(), false);
    }
    if kind.contains("code") {
        return ("```\n".to_owned(), false);
    }
    (String::new(), false)
}

fn markdown(units: &[Unit]) -> String {
    let mut blocks: Vec<(String, bool)> = Vec::new();
    let mut runs: Vec<(String, Map<String, Value>)> = Vec::new();
    let mut pending: Vec<u16> = Vec::new();
    let mut pending_props: Option<Map<String, Value>> = None;
    let flush = |pending: &mut Vec<u16>,
                 props: &mut Option<Map<String, Value>>,
                 runs: &mut Vec<(String, Map<String, Value>)>| {
        if !pending.is_empty() {
            runs.push((String::from_utf16_lossy(pending), props.take().unwrap_or_default()));
            pending.clear();
        }
    };
    for unit in units {
        match unit {
            Unit::Text(u, props) => {
                if pending_props.as_ref().is_some_and(|p| p != props) {
                    flush(&mut pending, &mut pending_props, &mut runs);
                }
                pending_props.get_or_insert_with(|| props.clone());
                pending.push(*u);
            }
            Unit::Marker(props) => {
                flush(&mut pending, &mut pending_props, &mut runs);
                let (prefix, listed) = block(props);
                let body = inline(&runs);
                runs.clear();
                let line =
                    if prefix.starts_with("```") { format!("```\n{body}\n```") } else { format!("{prefix}{body}") };
                blocks.push((line, listed));
            }
        }
    }
    flush(&mut pending, &mut pending_props, &mut runs);
    if !runs.is_empty() {
        blocks.push((inline(&runs), false));
    }
    let mut out = String::new();
    let mut previous_listed = false;
    for (i, (line, listed)) in blocks.iter().enumerate() {
        if i > 0 {
            out.push_str(if *listed && previous_listed { "\n" } else { "\n\n" });
        }
        out.push_str(line);
        previous_listed = *listed;
    }
    out.trim().to_owned()
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
        assert_eq!(text.markdown, "- [x] milk\n- [ ] eggs 🥚!\n- [site](https://example.com)\n\na\\*b");
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
}
