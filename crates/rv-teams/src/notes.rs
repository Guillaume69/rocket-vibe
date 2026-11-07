//! A chat's Notes tab: a Loop page in SharePoint Embedded, read whole and
//! turned into markdown. The page's text is a Fluid merge-tree: the summary in
//! the latest snapshot, then the operations sequenced since, replayed in order.
//! Saving rewrites the paragraphs that changed through Fluid's delta stream.
use base64::Engine;
use rv_provider::rest::RestError;
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
    /// The page's register of its lists, a channel of `component`.
    list_registry: Option<String>,
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

/// A snapshot's tree and blobs, decoded.
struct Store {
    paths: std::collections::HashMap<String, String>,
    blobs: std::collections::HashMap<String, String>,
}

impl Store {
    /// Components and channels attached after the summary join the tree.
    fn attach(&mut self, contents: &Value) {
        match contents["type"].as_str() {
            Some("groupedBatch") => {
                for inner in contents["contents"].as_array().into_iter().flatten() {
                    self.attach(&inner["contents"]);
                }
            }
            Some("attach") => {
                let (id, snapshot) = (&contents["contents"]["id"], &contents["contents"]["snapshot"]);
                if let Some(id) = id.as_str() {
                    self.add_entries(&format!(".app/.channels/{id}"), snapshot);
                }
            }
            Some("component") => {
                let envelope = &contents["contents"];
                if envelope.pointer("/contents/type").and_then(Value::as_str) == Some("attach")
                    && let (Some(component), Some(channel)) =
                        (envelope["address"].as_str(), envelope.pointer("/contents/content/id").and_then(Value::as_str))
                    && let Some(snapshot) = envelope.pointer("/contents/content/snapshot")
                {
                    self.add_entries(&format!(".app/.channels/{component}/.channels/{channel}"), snapshot);
                }
            }
            _ => {}
        }
    }

    fn add_entries(&mut self, folder: &str, tree: &Value) {
        for entry in tree["entries"].as_array().into_iter().flatten() {
            let Some(name) = entry["path"].as_str() else { continue };
            let path = format!("{folder}/{name}");
            match entry["type"].as_str() {
                Some("Blob") => {
                    if let Some(body) = entry.pointer("/value/contents").and_then(Value::as_str) {
                        self.blobs.insert(path.clone(), body.to_owned());
                        self.paths.insert(path.clone(), path);
                    }
                }
                Some("Tree") => self.add_entries(&path, &entry["value"]),
                _ => {}
            }
        }
    }

    fn new(snapshot: &Value) -> Option<Store> {
        let blobs = snapshot["blobs"]
            .as_array()?
            .iter()
            .filter_map(|b| {
                let content = b["content"].as_str()?;
                let text = if b["encoding"].as_str() == Some("base64") {
                    String::from_utf8(base64::engine::general_purpose::STANDARD.decode(content).ok()?).ok()?
                } else {
                    content.to_owned()
                };
                Some((b["id"].as_str()?.to_owned(), text))
            })
            .collect();
        let paths = snapshot
            .pointer("/trees/0/entries")?
            .as_array()?
            .iter()
            .filter_map(|e| Some((e["path"].as_str()?.to_owned(), e["id"].as_str()?.to_owned())))
            .collect();
        Some(Store { paths, blobs })
    }

    fn text(&self, path: &str) -> Option<&str> {
        self.blobs.get(self.paths.get(path)?).map(String::as_str)
    }

    fn json(&self, path: &str) -> Option<Value> {
        serde_json::from_str(self.text(path)?).ok()
    }

    /// A component's package path, as its `.component` file names it.
    fn package(&self, component: &str) -> String {
        self.json(&format!(".app/.channels/{component}/.component"))
            .and_then(|c| c["pkg"].as_str().map(str::to_owned))
            .unwrap_or_default()
    }

    fn component_of_package(&self, package: &str) -> Option<String> {
        let mut found: Vec<String> = self
            .paths
            .keys()
            .filter(|p| p.ends_with("/.component"))
            .filter_map(|p| p.strip_prefix(".app/.channels/")?.split('/').next().map(str::to_owned))
            .filter(|c| self.package(c).contains(package))
            .collect();
        found.sort();
        found.into_iter().next()
    }

    /// Who an inline mention names, as summarised.
    fn mention(&self, component: &str, key: &str) -> Option<Value> {
        let channel = self.json(&format!(".app/.channels/{component}/.channels/{MENTIONS}/header"))?;
        Some(channel.pointer("/content/storage")?.get(key)?.get("value")?.clone())
    }

    /// A key of a component's root directory.
    fn root(&self, component: &str, key: &str) -> Option<Value> {
        let root = self.json(&format!(".app/.channels/{component}/.channels/root/header"))?;
        Some(root.pointer("/content/storage")?.get(key)?.get("value")?.clone())
    }

    /// The components holding a text channel.
    fn stories(&self) -> Vec<String> {
        self.paths
            .keys()
            .filter(|p| p.ends_with("/.channels/text/content/header"))
            .filter_map(|p| p.strip_prefix(".app/.channels/")?.split('/').next().map(str::to_owned))
            .collect()
    }

    /// A text channel's units as summarised, and the sequence number of that summary.
    fn units(&self, component: &str) -> Option<(Vec<Unit>, i64)> {
        let folder = format!(".app/.channels/{component}/.channels/text/content/");
        let header = self.json(&format!("{folder}header"))?;
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
                self.json(&format!("{folder}{chunk}")).unwrap_or(Value::Null)
            };
            for segment in body["segmentTexts"].as_array().into_iter().flatten() {
                units.extend(segment_units(segment));
            }
        }
        Some((units, header.pointer("/headerMetadata/sequenceNumber").and_then(Value::as_i64).unwrap_or(0)))
    }
}

/// The channel of `atMentions` holding who each inline mention names.
const MENTIONS: &str = "instances";

/// The text channels and root keys of a page, once every later operation is replayed.
struct Replayed {
    stories: std::collections::HashMap<String, Vec<Unit>>,
    keys: std::collections::HashMap<(String, String), Value>,
    /// Later operations on the other channels (a table's matrix and sequences), in order.
    channels: std::collections::HashMap<(String, String), Vec<Value>>,
}

/// The page's text from its latest snapshot (`opStream/snapshots/trees/latest`,
/// JSON form) and any operations fetched after it.
pub fn read(snapshot: &Value, later: &[Value]) -> Option<Text> {
    let mut store = Store::new(snapshot)?;
    for entry in snapshot["ops"].as_array().into_iter().flatten().chain(later.iter()) {
        let op = entry.get("op").unwrap_or(entry);
        if let Some(contents) = op["contents"].as_str().and_then(|c| serde_json::from_str::<Value>(c).ok()) {
            store.attach(&contents);
        }
    }
    let names = store.stories();
    let component = names
        .iter()
        .find(|c| store.package(c).contains("LoopCanvasComponentSingleton"))
        .or_else(|| names.iter().min())?
        .clone();
    let (page_units, page_base) = store.units(&component)?;
    let lists = lists_in(&store);
    let mut text = Text { sequence: page_base, component: component.clone(), ..Text::default() };
    let mut replayed = Replayed { stories: Default::default(), keys: Default::default(), channels: Default::default() };
    let summary = snapshot.pointer("/trees/0/sequenceNumber").and_then(Value::as_i64).unwrap_or(0);
    let mut bases = std::collections::HashMap::new();
    for name in &names {
        if let Some((units, base)) = store.units(name) {
            replayed.stories.insert(name.clone(), units);
            bases.insert(name.clone(), base);
        }
    }
    replayed.stories.insert(component.clone(), page_units);
    // A summary keeps the operations since its text was written beside that text.
    for name in &names {
        let later = store.json(&format!(".app/.channels/{name}/.channels/text/content/catchupOps"));
        for entry in later.as_ref().and_then(Value::as_array).into_iter().flatten() {
            let seq = entry["sequenceNumber"].as_i64().unwrap_or(0);
            if let Some(units) = replayed.stories.get_mut(name)
                && seq > bases.get(name).copied().unwrap_or(0)
            {
                apply(units, &entry["contents"], &mut text);
                bases.insert(name.clone(), seq);
            }
        }
    }
    let mut sequenced: Vec<&Value> = snapshot["ops"].as_array().into_iter().flatten().chain(later.iter()).collect();
    sequenced.sort_by_key(|o| sequence_of(o));
    let mut seen = std::collections::HashSet::new();
    for entry in sequenced {
        let seq = sequence_of(entry);
        if !seen.insert(seq) {
            continue;
        }
        let op = entry.get("op").unwrap_or(entry);
        text.sequence = text.sequence.max(seq);
        let Some(contents) = op["contents"].as_str().and_then(|c| serde_json::from_str::<Value>(c).ok()) else {
            continue;
        };
        let mut changed = false;
        for (address, channel, inner) in channel_ops(&contents) {
            if channel != "text" && channel != "root" && seq > summary {
                replayed.channels.entry((address.clone(), channel.clone())).or_default().push(inner.clone());
            }
            if channel == "text" {
                if seq <= bases.get(&address).copied().unwrap_or(0) {
                    continue;
                }
                if let Some(units) = replayed.stories.get_mut(&address) {
                    changed |= apply(units, &inner, &mut text);
                }
            } else if (channel == "root" || channel == MENTIONS)
                && inner["type"].as_str() == Some("set")
                && let Some(key) = inner["key"].as_str()
            {
                replayed
                    .keys
                    .insert((address, key.to_owned()), inner.pointer("/value/value").cloned().unwrap_or(Value::Null));
            }
        }
        if changed {
            text.updated_at = op["timestamp"].as_i64().or(text.updated_at);
        }
    }
    text.sequence = text.sequence.max(snapshot["latestSequenceNumber"].as_i64().unwrap_or(0));
    text.list_registry = store
        .root(&component, "text:list!registry")
        .and_then(|h| handle(&h))
        .map(|url| url.rsplit('/').next().unwrap_or_default().to_owned());
    let page = replayed.stories.get(&component).cloned().unwrap_or_default();
    text.blocks = blocks(&page, &lists);
    for block in &mut text.blocks {
        let url = block.props.as_ref().and_then(|p| p.get("component!url")).and_then(handle);
        if let Some(url) = url {
            block.embedded = Some(Box::new(embedded(&store, &replayed, &lists, url.trim_start_matches('/'))));
        }
    }
    text.markdown = render(&text.blocks);
    Some(text)
}

/// A Fluid handle's address.
fn handle(value: &Value) -> Option<String> {
    value["url"].as_str().filter(|_| value["type"].as_str() == Some("__fluid_handle__")).map(str::to_owned)
}

/// What a `FluidComponent` paragraph holds, as far as the apps show it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Embedded {
    /// A quote or code block: paragraphs in the component's own text channel.
    Story {
        id: String,
        kind: Kind,
        language: Option<String>,
        blocks: Vec<Block>,
    },
    Table(Box<Table>),
    Tasks(Box<TaskList>),
    /// A component the apps do not read: left alone.
    Other,
}

/// A rich text cell: `id` the component owning its text, `None` for a value that cannot be edited.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Cell {
    id: Option<String>,
    runs: Vec<(String, Marks)>,
    /// Where its text ends: its closing paragraph marker stays.
    end: usize,
}

/// One row or column of a table: its id, its entry in the order shown, and
/// where the matrix keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Line {
    id: String,
    entry: String,
    position: usize,
}

/// A table: `grid` holds the column titles then the rows; the rest says where
/// each part lives, for an edit that adds or removes rows and columns.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Table {
    grid: Vec<Vec<Cell>>,
    rows: Vec<Line>,
    columns: Vec<Line>,
    /// The components holding the matrix and the view.
    data: String,
    view: String,
    matrix: String,
    row_sequence: String,
    column_sequence: String,
    view_bag: Option<String>,
    signal: Option<String>,
    counter: Option<String>,
    matrix_rows: usize,
    matrix_columns: usize,
    /// Each column's place in the matrix and its definition.
    definitions: Vec<(usize, Value)>,
    /// The component a label cell's list of labels lives in.
    labels: Option<String>,
}

/// A task list: a table whose rows are shown as tasks.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskList {
    tasks: Vec<Task>,
    table: Table,
}

/// What separates a task's title from its assignees, due date and bucket.
const TASK_DETAILS: &str = " \u{b7} ";

/// A row of a task list.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Task {
    /// The component whose root holds `configuration`, with its `checked`.
    checkbox: String,
    configuration: Value,
    done: bool,
    title: Cell,
    row: Line,
    /// Assignees, due date, bucket: shown after the title, not edited.
    details: Vec<String>,
}

impl Task {
    fn line(&self) -> String {
        let mut line = format!("- [{}] {}", if self.done { "x" } else { " " }, inline(&self.title.runs));
        for detail in &self.details {
            line.push_str(TASK_DETAILS);
            line.push_str(&escaped(detail));
        }
        line
    }
}

/// A checklist line's title, what follows it being a task's details.
fn task_title(typed: &str) -> &str {
    typed.split(TASK_DETAILS).next().unwrap_or(typed)
}

fn cell_of(id: Option<&str>, replayed: &Replayed, lists: &Lists, fallback: &str) -> Cell {
    let units = id.and_then(|id| replayed.stories.get(id));
    let Some(units) = units else {
        let runs = if fallback.is_empty() { Vec::new() } else { vec![(fallback.to_owned(), Marks::default())] };
        return Cell { id: None, runs, end: 0 };
    };
    let mut runs: Vec<(String, Marks)> = Vec::new();
    for block in blocks(units, lists) {
        if !runs.is_empty() && !block.runs.is_empty() {
            runs.push((" ".to_owned(), Marks::default()));
        }
        runs.extend(block.runs);
    }
    let end = units.iter().rposition(|u| matches!(u, Unit::Marker(p) if !inline_marker(p))).unwrap_or(units.len());
    Cell { id: id.map(str::to_owned), runs, end }
}

/// A `SharedMatrix`: rows and columns are handles in the order kept, cells are
/// keyed by the two handles, in a sparse tree keyed by their interleaved bits.
#[derive(Default)]
struct Matrix {
    rows: Vec<u32>,
    columns: Vec<u32>,
    cells: std::collections::HashMap<(u32, u32), Value>,
    next: u32,
}

impl Matrix {
    fn load(store: &Store, data: &str, channel: &str, later: Option<&Vec<Value>>) -> Option<Matrix> {
        let folder = format!(".app/.channels/{data}/.channels/{channel}");
        let vector = |name: &str| -> Vec<u32> {
            store
                .json(&format!("{folder}/{name}/segments/header"))
                .and_then(|h| h["segments"].as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter(|s| s.get("removedSeq").is_none())
                .flat_map(|s| {
                    // A segment newer than the collab window comes wrapped with its sequence.
                    let s = s.get("json").unwrap_or(s);
                    let (length, start) = (s[0].as_u64().unwrap_or(0), s[1].as_u64().unwrap_or(0));
                    (0..length).map(move |i| (start + i) as u32)
                })
                .collect()
        };
        let mut matrix = Matrix { rows: vector("rows"), columns: vector("cols"), ..Matrix::default() };
        fn walk(node: &Value, key: u32, depth: usize, out: &mut Vec<(u32, Value)>) {
            let Some(all) = node.as_array() else { return };
            for (i, v) in all.iter().enumerate() {
                let next = if depth == 0 { 0 } else { key.wrapping_mul(256).wrapping_add(i as u32) };
                match v {
                    Value::Null => {}
                    Value::Array(_) => walk(v, next, depth + 1, out),
                    other => out.push((next, other.clone())),
                }
            }
        }
        let spread = |morton: u32, shift: u32| (0..16).fold(0u32, |n, b| n | (((morton >> (2 * b + shift)) & 1) << b));
        let cells: Value = store.json(&format!("{folder}/cells"))?;
        let mut found = Vec::new();
        if let Some(root) = cells.get(0) {
            walk(root, 0, 0, &mut found);
        }
        matrix.cells = found.into_iter().map(|(k, v)| ((spread(k, 1), spread(k, 0)), v)).collect();
        matrix.next = matrix.rows.iter().chain(&matrix.columns).copied().max().unwrap_or(0) + 1;
        for op in later.into_iter().flatten() {
            matrix.apply(op);
        }
        Some(matrix)
    }

    fn apply(&mut self, op: &Value) {
        let at = |key: &str| op[key].as_u64().map(|p| p as usize);
        match op["type"].as_u64() {
            Some(0) => {
                let Some(pos) = at("pos1") else { return };
                let count = op.pointer("/seg/0").and_then(Value::as_u64).unwrap_or(0) as u32;
                let added: Vec<u32> = (0..count).map(|i| self.next + i).collect();
                self.next += count;
                let line = if op["target"].as_str() == Some("rows") { &mut self.rows } else { &mut self.columns };
                let pos = pos.min(line.len());
                line.splice(pos..pos, added);
            }
            Some(1) => {
                let (Some(from), Some(to)) = (at("pos1"), at("pos2")) else { return };
                let line = if op["target"].as_str() == Some("rows") { &mut self.rows } else { &mut self.columns };
                let to = to.min(line.len());
                if from < to {
                    line.drain(from..to);
                }
            }
            Some(2) => {
                let (Some(row), Some(column)) = (at("row"), at("col")) else { return };
                if let (Some(&r), Some(&c)) = (self.rows.get(row), self.columns.get(column)) {
                    self.cells.insert((r, c), op["value"].clone());
                }
            }
            _ => {}
        }
    }
}

/// The entries of an order channel, oldest logic first, with later operations:
/// (entry id, value, deleted).
fn sequence(store: &Store, view: &str, channel: &str, later: Option<&Vec<Value>>) -> Vec<(String, String, bool)> {
    let mut entries: Vec<(String, String, bool)> = store
        .json(&format!(".app/.channels/{view}/.channels/{channel}/header"))
        .and_then(|s| s["dataArray"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|e| {
            Some((
                e["entryId"].as_str()?.to_owned(),
                e["value"].as_str()?.to_owned(),
                e["isDeleted"].as_bool() == Some(true),
            ))
        })
        .collect();
    let after = |entries: &[(String, String, bool)], op: &Value| {
        op["insertAfterEntryId"].as_str().and_then(|id| entries.iter().position(|e| e.0 == id)).map_or(0, |i| i + 1)
    };
    for op in later.into_iter().flatten() {
        let id = op["entryId"].as_str().unwrap_or_default();
        match op["type"].as_u64() {
            Some(0) => {
                let at = after(&entries, op);
                entries.insert(at, (id.to_owned(), op["value"].as_str().unwrap_or_default().to_owned(), false));
            }
            Some(1) => {
                if let Some(e) = entries.iter_mut().find(|e| e.0 == id) {
                    e.2 = true;
                }
            }
            Some(2) => {
                let Some(from) = entries.iter().position(|e| e.0 == id) else { continue };
                entries[from].2 = true;
                let value = entries[from].1.clone();
                let at = after(&entries, op);
                entries.insert(at, (op["changedToEntryId"].as_str().unwrap_or_default().to_owned(), value, false));
            }
            Some(3) => {
                if let Some(e) = entries.iter_mut().find(|e| e.0 == id) {
                    e.2 = op["isDeleted"].as_bool() == Some(true);
                }
            }
            _ => {}
        }
    }
    entries
}

/// The last part of a handle to a channel: its name.
fn channel_name(value: Option<Value>) -> Option<String> {
    handle(&value?).map(|url| url.rsplit('/').next().unwrap_or_default().to_owned())
}

fn embedded(store: &Store, replayed: &Replayed, lists: &Lists, id: &str) -> Embedded {
    let package = store.package(id);
    if package.contains("BlockQuoteComponentType") || package.contains("BlockCalloutComponentType") {
        return story(replayed, lists, id, Kind::Quote, None);
    }
    if package.contains("CodeBlockComponentType") {
        let language = store.root(id, "text:code!language").and_then(|v| v.as_str().map(str::to_ascii_lowercase));
        return story(replayed, lists, id, Kind::Code, language);
    }
    if package.contains("TableroComponentType") || package.contains("TasklistComponentType") {
        let tasks = package.contains("TasklistComponentType");
        let root = if tasks { task_table(store, id) } else { Some(id.to_owned()) };
        return root.and_then(|root| table(store, replayed, lists, &root, tasks)).unwrap_or(Embedded::Other);
    }
    Embedded::Other
}

/// The table a task list's component names, one component down.
fn task_table(store: &Store, list: &str) -> Option<String> {
    let Some(table) = store.root(list, "tableComponentHandle") else { return Some(list.to_owned()) };
    Some(handle(&table)?.trim_start_matches('/').to_owned())
}

fn story(replayed: &Replayed, lists: &Lists, id: &str, kind: Kind, language: Option<String>) -> Embedded {
    let Some(units) = replayed.stories.get(id) else { return Embedded::Other };
    let inner = blocks(units, lists).into_iter().map(|b| Block { kind: kind.clone(), ..b }).collect();
    Embedded::Story { id: id.to_owned(), kind, language, blocks: inner }
}

fn table(store: &Store, replayed: &Replayed, lists: &Lists, root: &str, tasks: bool) -> Option<Embedded> {
    let view = handle(&store.root(root, "tableViewModelIdKey")?)?.trim_start_matches('/').to_owned();
    let data = handle(&store.root(&view, "tableroDocumentId")?)?.trim_start_matches('/').to_owned();
    let channel = channel_name(store.root(&data, "matrixIdKey"))?;
    let later = |component: &str, channel: &str| replayed.channels.get(&(component.to_owned(), channel.to_owned()));
    let matrix = Matrix::load(store, &data, &channel, later(&data, &channel))?;
    let mut rows_by_id = std::collections::HashMap::new();
    let mut columns_by_id = std::collections::HashMap::new();
    for (&(row, column), value) in &matrix.cells {
        let Some(id) = value["id"].as_str() else { continue };
        if value.get("type").is_some() {
            columns_by_id.insert(id.to_owned(), (column, value.clone()));
        } else {
            rows_by_id.insert(id.to_owned(), row);
        }
    }
    let row_sequence = channel_name(store.root(&view, "rowSequenceKey"))?;
    let column_sequence = channel_name(store.root(&view, "colSequenceKey"))?;
    let position = |line: &[u32], handle: u32| line.iter().position(|h| *h == handle);
    let rows: Vec<Line> = sequence(store, &view, &row_sequence, later(&view, &row_sequence))
        .into_iter()
        .filter(|e| !e.2)
        .filter_map(|(entry, id, _)| {
            let at = position(&matrix.rows, *rows_by_id.get(&id)?)?;
            Some(Line { id, entry, position: at })
        })
        .collect();
    let columns: Vec<Line> = sequence(store, &view, &column_sequence, later(&view, &column_sequence))
        .into_iter()
        .filter(|e| !e.2)
        .filter_map(|(entry, id, _)| {
            let at = position(&matrix.columns, columns_by_id.get(&id)?.0)?;
            Some(Line { id, entry, position: at })
        })
        .collect();
    let component_of = |value: &Value| value.pointer("/value/componentHandle").and_then(handle);
    let cell_at = |row: &Line, column: &Line| {
        let r = rows_by_id.get(&row.id)?;
        let c = columns_by_id.get(&column.id)?.0;
        matrix.cells.get(&(*r, c))
    };
    let labels = rows
        .iter()
        .find_map(|row| {
            let column = columns
                .iter()
                .find(|c| columns_by_id.get(&c.id).is_some_and(|(_, v)| v["type"].as_str() == Some("ILabelData")))?;
            let cell = cell_at(row, column).and_then(component_of)?;
            handle(&store.root(cell.trim_start_matches('/'), "labelComponentHandleKey")?)
        })
        .map(|url| url.trim_start_matches('/').to_owned())
        .or_else(|| store.component_of_package("LabelComponent"));
    let definitions: Vec<(usize, Value)> =
        columns.iter().filter_map(|c| Some((c.position, columns_by_id.get(&c.id)?.1.clone()))).collect();
    let shell = Table {
        grid: Vec::new(),
        rows: rows.clone(),
        columns: columns.clone(),
        view_bag: channel_name(store.root(&view, "viewDataPropertyBagKey")),
        signal: channel_name(store.root(&view, "sharedSignalKey")),
        counter: channel_name(store.root(&data, "columnCounterKey")),
        matrix_rows: matrix.rows.len(),
        matrix_columns: matrix.columns.len(),
        data: data.clone(),
        view: view.clone(),
        matrix: channel.clone(),
        row_sequence: row_sequence.clone(),
        column_sequence: column_sequence.clone(),
        definitions,
        labels,
    };
    if tasks {
        let title_column = columns
            .iter()
            .find(|c| columns_by_id.get(&c.id).is_some_and(|(_, v)| v["type"].as_str() == Some("ICheckboxRichText")))?;
        let mut out = Vec::new();
        for row in &rows {
            let Some(checkbox) = cell_at(row, title_column).and_then(component_of) else { continue };
            let checkbox = checkbox.trim_start_matches('/').to_owned();
            let configuration = replayed
                .keys
                .get(&(checkbox.clone(), "ConfigurationType".to_owned()))
                .cloned()
                .or_else(|| store.root(&checkbox, "ConfigurationType"))?;
            let rich = configuration.get("richTextComponentHandle").and_then(handle);
            let title = cell_of(rich.as_deref().map(|u| u.trim_start_matches('/')), replayed, lists, "");
            if title.runs.is_empty() {
                continue;
            }
            let details = columns
                .iter()
                .filter_map(|column| {
                    let definition = &columns_by_id.get(&column.id)?.1;
                    task_detail(store, replayed, definition, cell_at(row, column)?)
                })
                .collect();
            out.push(Task {
                checkbox,
                done: configuration["checked"].as_bool() == Some(true),
                configuration,
                title,
                row: row.clone(),
                details,
            });
        }
        return Some(Embedded::Tasks(Box::new(TaskList { tasks: out, table: shell })));
    }
    let mut grid = vec![
        columns
            .iter()
            .map(|c| {
                let definition = columns_by_id.get(&c.id).map(|(_, v)| v);
                let id = definition.and_then(|v| v.pointer("/title/componentHandle")).and_then(handle);
                let fallback =
                    definition.and_then(|v| v.pointer("/title/cellValue")).and_then(Value::as_str).unwrap_or_default();
                cell_of(id.as_deref().map(|u| u.trim_start_matches('/')), replayed, lists, fallback)
            })
            .collect::<Vec<_>>(),
    ];
    for row in &rows {
        grid.push(
            columns
                .iter()
                .map(|column| {
                    let value = cell_at(row, column);
                    let id = value.and_then(component_of);
                    let fallback =
                        value.and_then(|v| v.pointer("/value/cellValue")).and_then(Value::as_str).unwrap_or_default();
                    cell_of(id.as_deref().map(|u| u.trim_start_matches('/')), replayed, lists, fallback)
                })
                .collect(),
        );
    }
    Some(Embedded::Table(Box::new(Table { grid, ..shell })))
}

/// A cell of a task's assignees, due date or bucket, as shown after its title.
fn task_detail(store: &Store, replayed: &Replayed, definition: &Value, cell: &Value) -> Option<String> {
    let component = cell.pointer("/value/componentHandle").and_then(handle);
    let component = component.as_deref().map(|c| c.trim_start_matches('/'));
    let detail = match definition["type"].as_str()? {
        "IRichTextData" => {
            let units = replayed.stories.get(component?)?;
            let mut names = Vec::new();
            for unit in units {
                match unit {
                    Unit::Marker(props) => {
                        if let Some(name) = props.get("component!url").and_then(handle).and_then(|url| {
                            let (owner, key) = url.trim_start_matches('/').split_once('/')?;
                            let person = replayed
                                .keys
                                .get(&(owner.to_owned(), key.to_owned()))
                                .cloned()
                                .or_else(|| store.mention(owner, key))?;
                            person["displayName"].as_str().map(str::to_owned)
                        }) {
                            names.push(format!("@{name}"));
                        }
                    }
                    Unit::Text(..) => {}
                }
            }
            names.join(", ")
        }
        "IDateData" => {
            let component = component?;
            let date = replayed
                .keys
                .get(&(component.to_owned(), "DiasKey".to_owned()))
                .cloned()
                .or_else(|| store.root(component, "DiasKey"))?;
            date.pointer("/contentInfo/currentDate")?.as_str()?.replace('/', "-")
        }
        "ILabelData" => cell.pointer("/value/cellValue")?.as_str()?.to_owned(),
        _ => return None,
    };
    (!detail.is_empty()).then_some(detail)
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
    if segment.get("removedSeq").is_some() {
        return Vec::new();
    }
    let segment = segment.get("json").unwrap_or(segment);
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

/// What a sequenced op carries for each channel, as (component, channel,
/// operation), unwrapping grouped batches. A compressed or chunked batch is skipped.
fn channel_ops(contents: &Value) -> Vec<(String, String, Value)> {
    match contents["type"].as_str() {
        Some("groupedBatch") => contents["contents"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|inner| channel_ops(&inner["contents"]))
            .collect(),
        Some("component") => {
            let envelope = &contents["contents"];
            let content = envelope.pointer("/contents/content").cloned().unwrap_or(Value::Null);
            match (envelope["address"].as_str(), content["address"].as_str()) {
                (Some(address), Some(channel)) => {
                    vec![(address.to_owned(), channel.to_owned(), content["contents"].clone())]
                }
                _ => Vec::new(),
            }
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
    /// A line of a pipe table, in an edit: kept as it was typed.
    TableRow,
}

impl Kind {
    fn listed(&self) -> bool {
        self.family().is_some()
    }

    /// The kind of list an item belongs to: lists do not mix them.
    fn family(&self) -> Option<u8> {
        match self {
            Kind::Bullet(_) => Some(1),
            Kind::Numbered(_) => Some(2),
            Kind::Check(..) => Some(3),
            _ => None,
        }
    }

    fn level(&self) -> usize {
        match self {
            Kind::Bullet(l) | Kind::Numbered(l) | Kind::Check(l, _) => *l,
            _ => 0,
        }
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

/// A list item's `list!reference`, `<level>;<list>[;<ticked>]`: its level, its
/// list and whether it is ticked.
fn list_reference(reference: &str, props: &Map<String, Value>) -> (usize, String, bool) {
    let parts: Vec<&str> = reference.split(';').collect();
    match parts.as_slice() {
        [level, list, rest @ ..] => {
            (level.parse::<usize>().unwrap_or(0).min(8), (*list).to_owned(), rest.first() == Some(&"1"))
        }
        _ => (level_of(props), reference.to_owned(), checked(props)),
    }
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
    if let Some(reference) = text_of(props, "list!reference") {
        let (level, list, ticked) = list_reference(&reference, props);
        let format = lists.get(&list).and_then(|formats| formats.get(level)).map(String::as_str).unwrap_or("");
        if format.contains("%cb") || ticked {
            return Kind::Check(level, ticked);
        }
        if format.contains("%cd") && !format.contains("cssClass") {
            return Kind::Numbered(level);
        }
        return Kind::Bullet(level);
    }
    let level = level_of(props);
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
    /// The component this paragraph places, when it places one.
    embedded: Option<Box<Embedded>>,
}

/// What one line of the markdown edits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Part {
    Page,
    Story(usize),
    Separator,
    Row(usize),
    Task(usize),
}

fn cell_markdown(cell: &Cell) -> String {
    inline(&cell.runs).replace('|', "\\|").replace('\n', " ")
}

fn table_line(cells: &[String]) -> String {
    format!("| {} |", cells.join(" | "))
}

impl Block {
    /// The lines this paragraph shows, each with what it edits; a blank
    /// paragraph shows none and stays as it is.
    fn lines(&self) -> Vec<(String, Part)> {
        match self.embedded.as_deref() {
            None if self.runs.iter().all(|(t, _)| t.is_empty()) && self.kind == Kind::Paragraph => Vec::new(),
            None => vec![(self.line(), Part::Page)],
            Some(Embedded::Other) => Vec::new(),
            Some(Embedded::Story { blocks, .. }) => {
                blocks.iter().enumerate().map(|(i, b)| (b.line(), Part::Story(i))).collect()
            }
            Some(Embedded::Tasks(list)) => {
                list.tasks.iter().enumerate().map(|(i, t)| (t.line(), Part::Task(i))).collect()
            }
            Some(Embedded::Table(table)) => {
                let mut out = Vec::new();
                for (i, row) in table.grid.iter().enumerate() {
                    out.push((table_line(&row.iter().map(cell_markdown).collect::<Vec<_>>()), Part::Row(i)));
                    if i == 0 {
                        out.push((table_line(&vec!["---".to_owned(); row.len()]), Part::Separator));
                    }
                }
                out
            }
        }
    }

    /// The paragraph as markdown, a whole component included.
    fn markdown(&self) -> String {
        match self.embedded.as_deref() {
            Some(Embedded::Story { kind: Kind::Code, language, blocks, .. }) => {
                let body = blocks.iter().map(Block::text).collect::<Vec<_>>().join("\n");
                format!("```{}\n{body}\n```", language.as_deref().unwrap_or(""))
            }
            Some(_) => self.lines().into_iter().map(|(line, _)| line).collect::<Vec<_>>().join("\n"),
            None => self.line(),
        }
    }

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
            Kind::TableRow => self.text(),
        }
    }

    fn text(&self) -> String {
        self.runs.iter().map(|(t, _)| t.as_str()).collect()
    }
}

/// The list formats declared anywhere in the snapshot: `List` nodes carry
/// `list!id` and one `list!itemFormat-<level>` per level.
fn lists_in(store: &Store) -> Lists {
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
    for text in store.blobs.values() {
        if text.contains("list!id")
            && let Ok(v) = serde_json::from_str::<Value>(text)
        {
            walk(&v, &mut out);
        }
    }
    out
}

/// A marker inside a line (an emoji, a tab) rather than one closing a paragraph.
fn inline_marker(props: &Map<String, Value>) -> bool {
    matches!(props.get("nodeType").and_then(Value::as_str), Some("Emoji" | "Tab"))
        || props.get("component!display").and_then(Value::as_str) == Some("inline-block")
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
            Unit::Marker(props) if inline_marker(props) => {
                flush(&mut pending, &mut pending_marks, &mut runs);
                let shown = match props.get("nodeType").and_then(Value::as_str) {
                    Some("Tab") => " ".to_owned(),
                    _ => text_of(props, "emoji!value").unwrap_or_default(),
                };
                if !shown.is_empty() {
                    runs.push((shown, Marks::default()));
                }
            }
            Unit::Marker(props) => {
                flush(&mut pending, &mut pending_marks, &mut runs);
                let kind = kind_of(props, lists);
                let mut done = std::mem::take(&mut runs);
                // Loop strikes a ticked item's text; the tick already says it.
                if matches!(kind, Kind::Check(_, true)) {
                    done.iter_mut().for_each(|(_, m)| m.struck = false);
                }
                out.push(Block { kind, runs: done, start, marker: pos, props: Some(props.clone()), embedded: None });
                start = pos + 1;
            }
        }
    }
    flush(&mut pending, &mut pending_marks, &mut runs);
    if !runs.is_empty() {
        out.push(Block { kind: Kind::Paragraph, runs, start, marker: units.len(), props: None, embedded: None });
    }
    out
}

/// The page's markdown: consecutive list items and code lines stay together.
fn render(blocks: &[Block]) -> String {
    let shown: Vec<&Block> = blocks.iter().filter(|b| !b.lines().is_empty()).collect();
    let mut out = String::new();
    let mut previous_family: Option<u8> = None;
    let mut count = 0;
    let mut first = true;
    let mut i = 0;
    while i < shown.len() {
        let block = shown[i];
        if !first {
            let tight = list_family(block).is_some() && list_family(block) == previous_family;
            out.push_str(if tight { "\n" } else { "\n\n" });
        }
        first = false;
        if block.kind == Kind::Code && block.embedded.is_none() {
            let mut lines = Vec::new();
            while i < shown.len() && shown[i].kind == Kind::Code && shown[i].embedded.is_none() {
                lines.push(shown[i].text());
                i += 1;
            }
            out.push_str(&format!("```\n{}\n```", lines.join("\n")));
            previous_family = None;
            continue;
        }
        let family = list_family(block);
        count = if matches!(block.kind, Kind::Numbered(_)) && family == previous_family { count + 1 } else { 1 };
        match block.kind {
            Kind::Numbered(level) if block.embedded.is_none() => {
                out.push_str(&format!("{}{count}. {}", "  ".repeat(level), inline(&block.runs)));
            }
            _ => out.push_str(&block.markdown()),
        }
        previous_family = family;
        i += 1;
    }
    out.trim().to_owned()
}

/// The kind of list a paragraph belongs to, native or written as text:
/// 1 bullets, 2 numbers, 3 checkboxes.
fn list_family(block: &Block) -> Option<u8> {
    if block.embedded.is_some() {
        return None;
    }
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
/// A paragraph markdown asks for: its kind and its runs.
type Wanted = (Kind, Vec<(String, Marks)>);

fn parse(markdown: &str) -> Vec<Wanted> {
    let mut out = Vec::new();
    let mut lines = markdown.lines().peekable();
    while let Some(raw) = lines.next() {
        if raw.trim_start().starts_with("```") {
            for code in lines.by_ref() {
                if code.trim_start().starts_with("```") {
                    break;
                }
                out.push((Kind::Code, vec![(code.to_owned(), Marks::default())]));
            }
            continue;
        }
        if raw.trim().is_empty() {
            continue;
        }
        let bare = raw.trim();
        if bare.len() > 1 && bare.starts_with('|') && bare.ends_with('|') {
            out.push((Kind::TableRow, vec![(bare.to_owned(), Marks::default())]));
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
        out.push((kind, parse_inline(body)));
    }
    out
}

/// What a save asks that a component cannot do: a table keeps its rows and
/// columns, a task list its tasks, unless the whole component goes.
pub const STRUCTURE: &str = "notes_structure";

/// The cells of a typed pipe table line.
fn table_cells(line: &str) -> Vec<String> {
    let inner = line.trim().trim_start_matches('|').trim_end_matches('|');
    let mut out = vec![String::new()];
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                out.last_mut().expect("one cell").push_str("\\|");
                chars.next();
            }
            '|' => out.push(String::new()),
            other => out.last_mut().expect("one cell").push(other),
        }
    }
    out.iter().map(|c| c.trim().to_owned()).collect()
}

/// An operation on a channel of a component, as the runtime submits it.
fn channel_op(component: &str, channel: &str, op: Value) -> Value {
    serde_json::json!({"type": "component", "contents": {"address": component,
        "contents": {"content": {"address": channel, "contents": op}, "type": "op"}}})
}

/// A file of an attached channel or component.
fn attached_file(path: &str, contents: String) -> Value {
    serde_json::json!({"mode": "100644", "path": path, "type": "Blob", "value": {"contents": contents, "encoding": "utf-8"}})
}

fn attached_tree(path: &str, entries: Vec<Value>) -> Value {
    serde_json::json!({"mode": "040000", "path": path, "type": "Tree", "value": {"entries": entries}})
}

fn directory_header(storage: Value) -> String {
    serde_json::json!({"blobs": [], "content": {"ci": {"csn": 0, "ccIds": []}, "storage": storage}}).to_string()
}

const DIRECTORY: &str = "https://graph.microsoft.com/types/directory";

fn attributes(kind: &str) -> String {
    serde_json::json!({"type": kind, "snapshotFormatVersion": "0.1", "packageVersion": "3.7.0"}).to_string()
}

fn plain(value: Value) -> Value {
    serde_json::json!({"type": "Plain", "value": value})
}

fn fluid_handle(url: String) -> Value {
    serde_json::json!({"type": "__fluid_handle__", "url": url})
}

/// A list node's formats, as Loop's own editor writes them.
fn list_formats(family: u8) -> Vec<String> {
    (0..9)
        .map(|level| match family {
            1 => format!("%cssClass-scriptor-listItem-marker-bullet;%cd{}", level % 3),
            2 => format!("%cd{}", level + 3),
            _ => "%cb".to_owned(),
        })
        .collect()
}

/// A directory channel attached to the page.
fn attach_channel(page: &str, channel: &str, storage: Value) -> Value {
    let snapshot = serde_json::json!({"entries": [
        attached_file("header", directory_header(storage)),
        attached_file(".attributes", attributes(DIRECTORY)),
    ]});
    serde_json::json!({"type": "component", "contents": {"address": page, "contents": {
        "content": {"id": channel, "snapshot": snapshot, "type": DIRECTORY}, "type": "attach"}}})
}

/// A component holding one text channel, attached to the page's document.
fn attach_story(
    id: &str,
    package: &str,
    kind: &str,
    root: Value,
    lines: &[Vec<(String, Marks)>],
    author: &Value,
) -> Value {
    let mut storage = root.as_object().cloned().unwrap_or_default();
    storage.insert("defaultContentDirection".into(), plain(Value::String("ltr".into())));
    storage.insert("text:nodeType".into(), plain(Value::String("StoryNode".into())));
    storage.insert("text".into(), plain(fluid_handle(format!("/{id}/text"))));
    let root = directory_header(Value::Object(storage));
    let mut segments = Vec::new();
    let mut length = 0usize;
    for runs in lines {
        for (text, marks) in runs {
            let mut props: Map<String, Value> = marks.props().into_iter().filter(|(_, v)| !v.is_null()).collect();
            props.insert("attribution".into(), author.clone());
            segments.push(serde_json::json!({"text": text, "props": props}));
            length += text.encode_utf16().count();
        }
        segments.push(serde_json::json!({"marker": {"refType": 1}, "props": {
            "attribution": author, "markerId": uuid(), "nodeType": "Paragraph"}}));
        length += 1;
    }
    let content = serde_json::json!({
        "chunkStartSegmentIndex": 0, "chunkSegmentCount": segments.len(), "chunkLengthChars": length,
        "totalLengthChars": length, "totalSegmentCount": segments.len(), "chunkSequenceNumber": 0,
        "segmentTexts": segments,
        "headerMetadata": {"orderedChunkMetadata": [{"id": "header"}], "sequenceNumber": 0,
            "totalLength": length, "totalSegmentCount": segments.len(), "minSequenceNumber": 0},
    });
    let merge_tree = "https://graph.microsoft.com/types/mergeTree";
    let snapshot = serde_json::json!({"entries": [
        attached_file(".component", serde_json::json!({"pkg": package, "summaryFormatVersion": 2, "isRootDataStore": false}).to_string()),
        attached_tree(".channels", vec![
            attached_tree("root", vec![attached_file("header", root), attached_file(".attributes", attributes(DIRECTORY))]),
            attached_tree("text", vec![
                attached_tree("content", vec![attached_file("header", content.to_string())]),
                attached_file(".attributes", attributes(merge_tree)),
            ]),
        ]),
    ]});
    serde_json::json!({"type": "attach", "contents": {"id": id, "snapshot": snapshot, "type": kind}})
}

/// A component holding only directories and arrays, in the shape Loop attaches.
fn attach_store(id: &str, package: &str, kind: &str, channels: Vec<Value>) -> Value {
    let snapshot = serde_json::json!({"entries": [
        attached_file(".component", serde_json::json!({"pkg": package, "summaryFormatVersion": 2, "isRootDataStore": false}).to_string()),
        attached_tree(".channels", channels),
    ]});
    serde_json::json!({"type": "attach", "contents": {"id": id, "snapshot": snapshot, "type": kind}})
}

const TASK_PACKAGE: &str = "\"TasklistComponentType\",\"@ms/tablero\"";

/// Loop's own new table and task list (captured, without who made them): every
/// id replaced, so each use is a component of its own.
const NEW_TABLE: &str = include_str!("../templates/loop-table.json");
const NEW_TASK_LIST: &str = include_str!("../templates/loop-tasklist.json");

fn with_fresh_ids(template: &str) -> String {
    let bytes = template.as_bytes();
    let shape = |at: usize| {
        bytes.len() >= at + 36
            && (0..36).all(|i| {
                let c = bytes[at + i];
                if matches!(i, 8 | 13 | 18 | 23) { c == b'-' } else { c.is_ascii_digit() || (b'a'..=b'f').contains(&c) }
            })
    };
    let mut fresh: std::collections::HashMap<&str, String> = Default::default();
    let mut out = String::with_capacity(template.len());
    let mut at = 0;
    let mut copied = 0;
    while at < bytes.len() {
        if shape(at) {
            out.push_str(&template[copied..at]);
            out.push_str(fresh.entry(&template[at..at + 36]).or_insert_with(uuid));
            at += 36;
            copied = at;
        } else {
            at += 1;
        }
    }
    out.push_str(&template[copied..]);
    out
}

/// A template's components, and what reading them gives.
fn from_template(template: &str, tasks: bool) -> Option<(String, Vec<Value>, Embedded)> {
    let document: Value = serde_json::from_str(&with_fresh_ids(template)).ok()?;
    let root = document["root"].as_str()?.to_owned();
    let attaches = document["attaches"].as_array()?.clone();
    let mut store = Store { paths: Default::default(), blobs: Default::default() };
    for attach in &attaches {
        store.attach(attach);
    }
    let mut replayed = Replayed { stories: Default::default(), keys: Default::default(), channels: Default::default() };
    for name in store.stories() {
        if let Some((units, _)) = store.units(&name) {
            replayed.stories.insert(name, units);
        }
    }
    let holder = if tasks { task_table(&store, &root)? } else { root.clone() };
    let embedded = table(&store, &replayed, &lists_in(&store), &holder, tasks)?;
    Some((root, attaches, embedded))
}

/// A quote component with `lines`.
fn attach_quote(id: &str, lines: &[Vec<(String, Marks)>], author: &Value) -> Value {
    let package = "[\"BlockQuoteComponentType\"]";
    let root = serde_json::json!({"defaultContentLocale": plain(Value::String("en-gb".into()))});
    attach_story(id, package, package, root, lines, author)
}

/// A table cell's text component, as Loop's editor creates it.
fn attach_cell(id: &str, preset: &str, typed: &str, author: &Value) -> Value {
    let root = serde_json::json!({
        "configuration": plain(serde_json::json!({"presetName": preset})),
        "isTextBoxMode": plain(Value::Bool(true)),
        "defaultContentLocale": plain(Value::String("en-us".into())),
    });
    let lines = vec![parse_inline(typed)];
    attach_story(id, "[\"TableroComponentType\",\"IRichTextData\"]", "IRichTextData", root, &lines, author)
}

fn cell_type_props(preset: &str) -> Value {
    serde_json::json!({"initialConfig": {"isTextBoxMode": true, "disableGuestComponents": true,
        "richTextServicesConfiguration": {"presetName": preset}}})
}

/// Aligns two lists of lines: what stays, what changed in place (a gap's lines
/// taken in order), what only one side has.
fn align(old: &[String], new: &[String]) -> Vec<(Option<usize>, Option<usize>)> {
    let (n, m) = (old.len(), new.len());
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if old[i] == new[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && old[i] == new[j] {
            out.push((Some(i), Some(j)));
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
        let pairs = (i - i0).min(j - j0);
        out.extend((0..pairs).map(|k| (Some(i0 + k), Some(j0 + k))));
        out.extend((i0 + pairs..i).map(|k| (Some(k), None)));
        out.extend((j0 + pairs..j).map(|k| (None, Some(k))));
    }
    out
}

/// The marker placing a component on the page.
fn insert_component(at: usize, id: &str, author: &Value) -> Value {
    serde_json::json!({"pos1": at, "type": 0, "seg": {"marker": {"refType": 1}, "props": {
        "attribution": author, "markerId": uuid(), "nodeType": "FluidComponent", "component!display": "block",
        "content!locale": "en-gb", "component!url": fluid_handle(format!("/{id}"))}}})
}

fn list_props(list: &str, kind: &Kind) -> Map<String, Value> {
    let reference = match kind {
        Kind::Check(level, done) => format!("{level};{list};{}", u8::from(*done)),
        other => format!("{};{list}", other.level()),
    };
    let mut props = Map::new();
    props.insert("list!reference".into(), Value::String(reference));
    props.insert("placeholder!attributeText".into(), Value::String("placeholder!addItem".into()));
    props
}

/// The list id of a block's item.
fn list_of(block: &Block) -> Option<String> {
    let props = block.props.as_ref()?;
    let reference = text_of(props, "list!reference")?;
    Some(list_reference(&reference, props).1)
}

/// The operations of one save, gathered per kind so they stay in a valid order.
struct Plan<'a> {
    text: &'a Text,
    author: &'a Value,
    /// New channels and components, first: what comes after refers to them.
    attached: Vec<Value>,
    ops: Vec<Value>,
    registry: Option<String>,
    /// Tasks to add to the list of a block, after an entry of its order.
    tasks_added: Vec<(usize, Option<String>, Vec<Wanted>)>,
    tasks_removed: Vec<(usize, Line)>,
}

impl Plan<'_> {
    /// A task's row: the matrix, the order shown, then a cell per column in the
    /// shape each kind of column takes.
    fn task_row(&mut self, table: &Table, position: usize, after: Option<&str>, wanted: &Wanted) -> (String, Value) {
        let (row, entry) = (uuid(), uuid());
        self.matrix(
            table,
            serde_json::json!({"pos1": position, "seg": [1, -2147483648i64], "type": 0, "target": "rows"}),
        );
        self.matrix(
            table,
            serde_json::json!({"type": 2, "row": position, "col": 0, "fwwMode": false,
            "value": {"metadataProperties": {"persistentData": {}}, "id": row}}),
        );
        let mut order = serde_json::json!({"type": 0, "entryId": entry, "value": row});
        if let Some(previous) = after {
            order["insertAfterEntryId"] = Value::String(previous.to_owned());
        }
        self.ops.push(channel_op(&table.view, &table.row_sequence, order));
        let (title, done) = (inline(&wanted.1), matches!(wanted.0, Kind::Check(_, true)));
        let title = task_title(&title);
        for (column, definition) in &table.definitions {
            let kind = definition["type"].as_str().unwrap_or_default();
            let config = definition.pointer("/dataTypeProps/initialConfig").cloned().unwrap_or(Value::Null);
            let preset =
                config.pointer("/richTextServicesConfiguration/presetName").and_then(Value::as_str).unwrap_or("");
            let story_root = serde_json::json!({
                "configuration": plain(serde_json::json!({"presetName": preset})),
                "isTextBoxMode": plain(Value::Bool(true)),
                "defaultContentLocale": plain(Value::String("en-us".into())),
            });
            let (component, shown) = match kind {
                "ICheckboxRichText" => {
                    let (text, checkbox) = (uuid(), uuid());
                    self.attached.push(attach_story(
                        &text,
                        &format!("[{TASK_PACKAGE},\"ICheckboxRichText\",\"RichText\"]"),
                        "RichText",
                        story_root,
                        &[parse_inline(title)],
                        self.author,
                    ));
                    let root = directory_header(serde_json::json!({"ConfigurationType": plain(serde_json::json!({
                        "checked": done, "richTextUrl": "", "type": "CheckboxText",
                        "richTextComponentHandle": fluid_handle(format!("/{text}")),
                        "richTextServicesConfiguration": {"presetName": preset}, "contentDirection": "ltr"}))}));
                    self.attached.push(attach_store(
                        &checkbox,
                        &format!("[{TASK_PACKAGE},\"ICheckboxRichText\"]"),
                        "ICheckboxRichText",
                        vec![attached_tree(
                            "root",
                            vec![attached_file("header", root), attached_file(".attributes", attributes(DIRECTORY))],
                        )],
                    ));
                    (Some(checkbox), String::new())
                }
                "IRichTextData" => {
                    let text = uuid();
                    self.attached.push(attach_story(
                        &text,
                        &format!("[{TASK_PACKAGE},\"IRichTextData\"]"),
                        "IRichTextData",
                        story_root,
                        &[Vec::new()],
                        self.author,
                    ));
                    (Some(text), String::new())
                }
                "ILabelData" => {
                    let (label, selected) = (uuid(), uuid());
                    let id = config.pointer("/selectedLabelIds/0").and_then(Value::as_str).unwrap_or_default();
                    let name = config["values"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|v| v["id"].as_str() == Some(id))
                        .and_then(|v| v["name"].as_str())
                        .unwrap_or_default()
                        .to_owned();
                    let mut storage = serde_json::json!({
                        "contentLocaleKey": plain(Value::String("en-us".into())),
                        "categoryIdKey": plain(config["categoryId"].clone()),
                        "selectedValuesKey": plain(fluid_handle(format!("/{label}/{selected}"))),
                        "labelPresetsKey": plain(serde_json::json!({})),
                    });
                    if let Some(labels) = &table.labels {
                        storage["labelComponentHandleKey"] = plain(fluid_handle(format!("/{labels}")));
                    }
                    self.attached.push(attach_store(
                        &label,
                        &format!("[{TASK_PACKAGE},\"ILabelData\"]"),
                        "ILabelData",
                        vec![
                            attached_tree(
                                "root",
                                vec![
                                    attached_file("header", directory_header(storage)),
                                    attached_file(".attributes", attributes(DIRECTORY)),
                                ],
                            ),
                            attached_tree(
                                &selected,
                                vec![
                                    attached_file(
                                        "header",
                                        serde_json::json!({"dataArray": [
                                    {"entryId": uuid(), "value": id, "isDeleted": false}]})
                                        .to_string(),
                                    ),
                                    attached_file(
                                        ".attributes",
                                        attributes("https://graph.microsoft.com/types/SharedArray"),
                                    ),
                                ],
                            ),
                        ],
                    ));
                    (Some(label), name)
                }
                _ => (None, String::new()),
            };
            let mut value = serde_json::json!({"cellValue": shown});
            if let Some(component) = component {
                value["componentHandle"] = fluid_handle(format!("/{component}"));
            }
            self.matrix(table, serde_json::json!({"type": 2, "row": position, "col": column, "fwwMode": false, "value": {
                "value": value, "cellDataTypeProps": {"type": kind, "initialConfig": config}, "attribution": self.author}}));
        }
        (entry, serde_json::json!({"rowId": row, "tableEventType": "RowInserted", "viewLayerType": "CoreViewModel"}))
    }

    fn signal(&mut self, table: &Table, events: Vec<Value>) {
        if !events.is_empty()
            && let Some(signal) = &table.signal
        {
            self.ops.push(channel_op(
                &table.view,
                signal,
                serde_json::json!({"type": "signal", "metadata": {
                "consumerMetadata": {"editMode": "edit"}, "tableEventMetadata": events}}),
            ));
        }
    }

    /// Tasks added and removed, appended rows first: removing from the end moves none of them.
    fn task_changes(&mut self) {
        let text = self.text;
        let mut lists: Vec<usize> =
            self.tasks_added.iter().map(|a| a.0).chain(self.tasks_removed.iter().map(|r| r.0)).collect();
        lists.sort_unstable();
        lists.dedup();
        for b in lists {
            let Some(Embedded::Tasks(list)) = text.blocks[b].embedded.as_deref() else { continue };
            let mut events = Vec::new();
            let mut position = list.table.matrix_rows;
            let added: Vec<_> = self.tasks_added.iter().filter(|a| a.0 == b).cloned().collect();
            for (_, after, lines) in added {
                let mut after = after;
                for wanted in &lines {
                    let (entry, event) = self.task_row(&list.table, position, after.as_deref(), wanted);
                    position += 1;
                    after = Some(entry);
                    events.push(event);
                }
            }
            let mut gone: Vec<Line> = self.tasks_removed.iter().filter(|r| r.0 == b).map(|r| r.1.clone()).collect();
            gone.sort_by_key(|l| std::cmp::Reverse(l.position));
            for line in gone {
                self.matrix(
                    &list.table,
                    serde_json::json!({"pos1": line.position, "pos2": line.position + 1, "type": 1, "target": "rows"}),
                );
                self.ops.push(channel_op(
                    &list.table.view,
                    &list.table.row_sequence,
                    serde_json::json!({"type": 1, "entryId": line.entry}),
                ));
                events.push(serde_json::json!({"rowId": line.id, "tableEventType": "RowDeleted", "viewLayerType": "CoreViewModel"}));
            }
            self.signal(&list.table, events);
        }
    }

    /// A new task list on the page, with its tasks.
    fn new_task_list(&mut self, at: usize, lines: &[Wanted]) -> Result<(), RestError> {
        let Some((root, attaches, Embedded::Tasks(list))) = from_template(NEW_TASK_LIST, true) else {
            return Err(refused());
        };
        self.attached.extend(attaches);
        self.page(insert_component(at, &root, self.author));
        let mut after: Option<String> = None;
        let mut events = Vec::new();
        for (k, wanted) in lines.iter().enumerate() {
            let (entry, event) = self.task_row(&list.table, list.table.matrix_rows + k, after.as_deref(), wanted);
            after = Some(entry);
            events.push(event);
        }
        self.signal(&list.table, events);
        Ok(())
    }

    /// A new table on the page, sized and filled from the rows typed.
    fn new_table(&mut self, at: usize, lines: &[String]) -> Result<(), RestError> {
        let Some((root, attaches, Embedded::Table(table))) = from_template(NEW_TABLE, false) else {
            return Err(refused());
        };
        self.attached.extend(attaches);
        self.page(insert_component(at, &root, self.author));
        self.table(&table, lines)
    }

    fn page(&mut self, op: Value) {
        self.ops.push(channel_op(&self.text.component, "text", op));
    }

    /// A new list of this kind: its node and its entry in the page's register.
    fn new_list(&mut self, family: u8) -> String {
        let page = self.text.component.clone();
        let registry = match self.registry.clone() {
            Some(id) => id,
            None => {
                let id = uuid();
                self.attached.push(attach_channel(
                    &page,
                    &id,
                    serde_json::json!({"nodeType": plain(Value::String("ListRegistry".into()))}),
                ));
                self.attached.push(channel_op(
                    &page,
                    "root",
                    serde_json::json!({"key": "text:list!registry", "path": "/", "type": "set",
                    "value": plain(fluid_handle(format!("/{page}/{id}")))}),
                ));
                self.registry = Some(id.clone());
                id
            }
        };
        let list = format!("list!list-{}", uuid());
        let channel = uuid();
        let mut storage = Map::new();
        storage.insert("nodeType".into(), plain(Value::String("List".into())));
        storage.insert("list!id".into(), plain(Value::String(list.clone())));
        for (level, format) in list_formats(family).into_iter().enumerate() {
            storage.insert(format!("list!itemFormat-{level}"), plain(Value::String(format)));
        }
        self.attached.push(attach_channel(&page, &channel, Value::Object(storage)));
        self.attached.push(channel_op(
            &page,
            &registry,
            serde_json::json!({"key": list, "path": "/", "type": "set",
            "value": plain(fluid_handle(format!("/{page}/{channel}")))}),
        ));
        list
    }

    fn matrix(&mut self, table: &Table, op: Value) {
        self.ops.push(channel_op(&table.data, &table.matrix, op));
    }

    /// A new cell's text component, and the matrix's reference to it.
    fn new_cell(&mut self, table: &Table, row: usize, column: usize, typed: &str) {
        let id = uuid();
        self.attached.push(attach_cell(&id, "RichTextCell", typed, self.author));
        self.matrix(table, serde_json::json!({"type": 2, "row": row, "col": column, "fwwMode": false, "value": {
            "value": {"componentHandle": fluid_handle(format!("/{id}")), "cellValue": ""},
            "cellDataTypeProps": {"type": "IRichTextData", "initialConfig": cell_type_props("RichTextCell")["initialConfig"]},
            "attribution": self.author}}));
    }

    /// A table as typed: titles and cells edited in place, rows and columns
    /// added and removed the way Loop's editor does (the matrix, the order
    /// shown, a text component per new cell), then a signal for open editors.
    fn table(&mut self, table: &Table, run: &[String]) -> Result<(), RestError> {
        let is_separator = |line: &str| {
            let cells = table_cells(line);
            !cells.is_empty() && cells.iter().all(|c| !c.is_empty() && c.chars().all(|x| matches!(x, '-' | ':')))
        };
        let mut typed: Vec<Vec<String>> = run.iter().filter(|l| !is_separator(l)).map(|l| table_cells(l)).collect();
        if typed.is_empty() {
            return Err(refused());
        }
        let width = typed.iter().map(Vec::len).max().unwrap_or(0);
        typed.iter_mut().for_each(|row| row.resize(width, String::new()));
        // Columns by their titles, rows by what they hold in the columns kept.
        let titles: Vec<String> = table.grid[0].iter().map(cell_markdown).collect();
        let columns = align(&titles, &typed[0]);
        let kept: Vec<(usize, usize)> = columns.iter().filter_map(|c| Some((c.0?, c.1?))).collect();
        let old_rows: Vec<String> = table.grid[1..]
            .iter()
            .map(|row| kept.iter().map(|(o, _)| cell_markdown(&row[*o])).collect::<Vec<_>>().join("\u{1f}"))
            .collect();
        let new_rows: Vec<String> = typed[1..]
            .iter()
            .map(|row| kept.iter().map(|(_, n)| row[*n].clone()).collect::<Vec<_>>().join("\u{1f}"))
            .collect();
        let rows = align(&old_rows, &new_rows);
        for (old, new) in &kept {
            self.cell(&table.grid[0][*old], &typed[0][*new])?;
        }
        for pair in &rows {
            if let (Some(o), Some(n)) = *pair {
                for (old, new) in &kept {
                    self.cell(&table.grid[o + 1][*old], &typed[n + 1][*new])?;
                }
            }
        }
        let mut events = Vec::new();
        // New columns, at the matrix's end; the order shown says where they fall.
        let mut after: Option<String> = None;
        let mut positions: Vec<usize> = vec![0; width];
        let mut added_columns = 0;
        for (index, pair) in columns.iter().enumerate() {
            match *pair {
                (Some(o), Some(n)) => {
                    positions[n] = table.columns[o].position;
                    after = Some(table.columns[o].entry.clone());
                }
                (None, Some(n)) => {
                    let position = table.matrix_columns + added_columns;
                    added_columns += 1;
                    positions[n] = position;
                    let (column, title, entry) = (uuid(), uuid(), uuid());
                    if let Some(counter) = &table.counter {
                        self.ops.push(channel_op(
                            &table.data,
                            counter,
                            serde_json::json!({"type": "increment", "incrementAmount": 1}),
                        ));
                    }
                    self.matrix(
                        table,
                        serde_json::json!({"pos1": position, "seg": [1, -2147483648i64], "type": 0, "target": "cols"}),
                    );
                    self.attached.push(attach_cell(&title, "TableHeaderCell", &typed[0][n], self.author));
                    self.matrix(
                        table,
                        serde_json::json!({"type": 2, "row": 0, "col": position, "fwwMode": false, "value": {
                            "type": "IRichTextData", "titleType": "IRichTextData", "id": column,
                            "title": {"componentHandle": fluid_handle(format!("/{title}")), "cellValue": typed[0][n]},
                            "dataTypeProps": cell_type_props("RichTextCell"),
                            "titleDataTypeProps": cell_type_props("TableHeaderCell"),
                        }}),
                    );
                    let mut order = serde_json::json!({"type": 0, "entryId": entry, "value": column});
                    if let Some(previous) = &after {
                        order["insertAfterEntryId"] = Value::String(previous.clone());
                    }
                    self.ops.push(channel_op(&table.view, &table.column_sequence, order));
                    after = Some(entry);
                    if let Some(bag) = &table.view_bag {
                        let path = format!("/columnViewDataPropertyBag/{column}");
                        self.ops.push(channel_op(
                            &table.view,
                            bag,
                            serde_json::json!({
                            "subdirName": column, "path": "/columnViewDataPropertyBag", "type": "createSubDirectory"}),
                        ));
                        for (key, value) in [("width", 170), ("minWidth", 56), ("widthRatio", 1)] {
                            self.ops.push(channel_op(
                                &table.view,
                                bag,
                                serde_json::json!({
                                "key": key, "path": path, "type": "set", "value": plain(serde_json::json!(value))}),
                            ));
                        }
                    }
                    for pair in &rows {
                        if let (Some(o), Some(k)) = *pair {
                            self.new_cell(table, table.rows[o].position, position, &typed[k + 1][n]);
                        }
                    }
                    events.push(serde_json::json!({"columnId": column, "columnIndex": index,
                        "tableEventType": "ColumnInserted", "viewLayerType": "CoreViewModel"}));
                }
                _ => {}
            }
        }
        // New rows, the same way.
        let mut after: Option<String> = None;
        let mut added_rows = 0;
        for (index, pair) in rows.iter().enumerate() {
            match *pair {
                (Some(o), Some(_)) => after = Some(table.rows[o].entry.clone()),
                (None, Some(k)) => {
                    let position = table.matrix_rows + added_rows;
                    added_rows += 1;
                    let (row, entry) = (uuid(), uuid());
                    self.matrix(
                        table,
                        serde_json::json!({"pos1": position, "seg": [1, -2147483648i64], "type": 0, "target": "rows"}),
                    );
                    self.matrix(
                        table,
                        serde_json::json!({"type": 2, "row": position, "col": 0, "fwwMode": false,
                        "value": {"metadataProperties": {"persistentData": {}}, "id": row}}),
                    );
                    let mut order = serde_json::json!({"type": 0, "entryId": entry, "value": row});
                    if let Some(previous) = &after {
                        order["insertAfterEntryId"] = Value::String(previous.clone());
                    }
                    self.ops.push(channel_op(&table.view, &table.row_sequence, order));
                    after = Some(entry);
                    for (n, column) in positions.iter().enumerate() {
                        self.new_cell(table, position, *column, &typed[k + 1][n]);
                    }
                    events.push(serde_json::json!({"rowId": row, "rowIndex": index,
                        "tableEventType": "RowInserted", "viewLayerType": "CoreViewModel"}));
                }
                _ => {}
            }
        }
        // Removals last and from the end: appended lines moved nothing.
        let mut gone: Vec<&Line> = rows.iter().filter(|p| p.1.is_none()).filter_map(|p| table.rows.get(p.0?)).collect();
        gone.sort_by_key(|l| std::cmp::Reverse(l.position));
        for line in gone {
            self.matrix(
                table,
                serde_json::json!({"pos1": line.position, "pos2": line.position + 1, "type": 1, "target": "rows"}),
            );
            self.ops.push(channel_op(
                &table.view,
                &table.row_sequence,
                serde_json::json!({"type": 1, "entryId": line.entry}),
            ));
            events.push(
                serde_json::json!({"rowId": line.id, "tableEventType": "RowDeleted", "viewLayerType": "CoreViewModel"}),
            );
        }
        let mut gone: Vec<&Line> =
            columns.iter().filter(|p| p.1.is_none()).filter_map(|p| table.columns.get(p.0?)).collect();
        gone.sort_by_key(|l| std::cmp::Reverse(l.position));
        for line in gone {
            self.matrix(
                table,
                serde_json::json!({"pos1": line.position, "pos2": line.position + 1, "type": 1, "target": "cols"}),
            );
            self.ops.push(channel_op(
                &table.view,
                &table.column_sequence,
                serde_json::json!({"type": 1, "entryId": line.entry}),
            ));
            events.push(serde_json::json!({"columnId": line.id, "tableEventType": "ColumnDeleted", "viewLayerType": "CoreViewModel"}));
        }
        self.signal(table, events);
        Ok(())
    }

    /// Rewrites a cell's text in its own channel.
    fn cell(&mut self, cell: &Cell, typed: &str) -> Result<(), RestError> {
        let runs = parse_inline(typed);
        if inline(&runs) == inline(&cell.runs) {
            return Ok(());
        }
        let Some(id) = cell.id.clone() else { return Err(refused()) };
        if cell.end > 0 {
            self.ops.push(channel_op(&id, "text", json_remove(0, cell.end)));
        }
        for (text, marks) in runs.iter().rev() {
            self.ops.push(channel_op(&id, "text", insert_text(0, text, marks, self.author)));
        }
        Ok(())
    }
}

fn refused() -> RestError {
    crate::auth::refusal(STRUCTURE, 409)
}

/// The operations turning the page into `markdown`, each valid against the
/// version read: within a channel in descending position, and new channels and
/// components before what refers to them. Lines that render the same are left
/// alone. A change a component cannot take is refused whole ([`STRUCTURE`]).
fn edit(text: &Text, markdown: &str, author: &Value) -> Result<Vec<Value>, RestError> {
    let blocks = &text.blocks;
    let wanted = parse(markdown);
    let mut old: Vec<(String, usize, Part)> = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        for (line, part) in block.lines() {
            old.push((line, i, part));
        }
    }
    let new: Vec<String> = wanted
        .iter()
        .map(|(k, r)| {
            if *k == Kind::TableRow {
                return r.first().map(|(t, _)| t.clone()).unwrap_or_default();
            }
            Block { kind: k.clone(), runs: r.clone(), start: 0, marker: 0, props: None, embedded: None }.line()
        })
        .collect();
    // A number is only where the item falls: renumbering edits nothing.
    let canon = |line: &str| {
        let indent = line.len() - line.trim_start().len();
        let digits = line[indent..].chars().take_while(char::is_ascii_digit).count();
        if digits > 0 && line[indent + digits..].starts_with(". ") {
            format!("{}1{}", &line[..indent], &line[indent + digits..])
        } else {
            line.to_owned()
        }
    };
    let old: Vec<(String, usize, Part)> = old.into_iter().map(|(l, b, p)| (canon(&l), b, p)).collect();
    let new: Vec<String> = new.iter().map(|l| canon(l)).collect();
    // Longest common subsequence of rendered lines.
    let (n, m) = (old.len(), new.len());
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if old[i].0 == new[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut hunks: Vec<(usize, usize, usize, usize)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && old[i].0 == new[j] {
            i += 1;
            j += 1;
            continue;
        }
        let (i0, j0) = (i, j);
        while (i < n || j < m) && !(i < n && j < m && old[i].0 == new[j]) {
            if j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) {
                i += 1;
            } else {
                j += 1;
            }
        }
        hunks.push((i0, i, j0, j));
    }
    // Within a hunk, a line pairs with the next one it could become: a quote
    // line with a quote line, a table row with a row, a task with a check item.
    let fits = |part: Part, kind: &Kind, block: usize| match (part, blocks[block].embedded.as_deref()) {
        (Part::Page, _) => *kind != Kind::TableRow,
        (Part::Story(_), Some(Embedded::Story { kind: own, .. })) => own == kind,
        (Part::Row(_) | Part::Separator, _) => *kind == Kind::TableRow,
        (Part::Task(_), _) => matches!(kind, Kind::Check(..)),
        _ => false,
    };
    let mut refined: Vec<(usize, usize, usize, usize)> = Vec::new();
    for &(i0, i1, j0, j1) in &hunks {
        let mut j = j0;
        for (i, &(_, block, part)) in old.iter().enumerate().take(i1).skip(i0) {
            match (j..j1).find(|&f| fits(part, &wanted[f].0, block)) {
                Some(f) => {
                    if f > j {
                        refined.push((i, i, j, f));
                    }
                    refined.push((i, i + 1, f, f + 1));
                    j = f + 1;
                }
                None => refined.push((i, i + 1, j, j)),
            }
        }
        if j < j1 {
            refined.push((i1, i1, j, j1));
        }
    }
    let mut hunks = refined;
    // A table changes as a whole: it takes the run of typed rows one of its
    // lines became, and neither joins the line by line edit.
    let mut matched: Vec<Option<usize>> = vec![None; n];
    {
        let (mut i, mut j) = (0, 0);
        let mut changed = hunks.iter().peekable();
        while i < n || j < m {
            if let Some(&&(i0, i1, j0, j1)) = changed.peek()
                && i == i0
                && j == j0
            {
                if i1 > i0 && j1 > j0 {
                    matched[i0] = Some(j0);
                }
                i = i1;
                j = j1;
                changed.next();
                continue;
            }
            if i < n && j < m {
                matched[i] = Some(j);
            }
            i += 1;
            j += 1;
        }
    }
    let mut table_runs: Vec<(usize, std::ops::Range<usize>)> = Vec::new();
    for (b, block) in blocks.iter().enumerate() {
        if !matches!(block.embedded.as_deref(), Some(Embedded::Table(_))) {
            continue;
        }
        let first = (0..n).filter(|&i| old[i].1 == b).find_map(|i| matched[i]);
        let Some(first) = first.filter(|&f| wanted[f].0 == Kind::TableRow) else { continue };
        let start = (0..first).rev().take_while(|&k| wanted[k].0 == Kind::TableRow).last().unwrap_or(first);
        let end = (first..m).find(|&k| wanted[k].0 != Kind::TableRow).unwrap_or(m);
        table_runs.push((b, start..end));
    }
    let in_run = |j: usize| table_runs.iter().any(|(_, r)| r.contains(&j));
    let in_table = |i: usize| table_runs.iter().any(|(b, _)| *b == old[i].1);
    hunks = hunks
        .into_iter()
        .flat_map(|(i0, i1, j0, j1)| {
            if i1 > i0 {
                return if in_table(i0) { Vec::new() } else { vec![(i0, i1, j0, j1)] };
            }
            let mut parts = Vec::new();
            let mut k = j0;
            while k < j1 {
                if in_run(k) {
                    k += 1;
                    continue;
                }
                let end = (k..j1).find(|&e| in_run(e)).unwrap_or(j1);
                parts.push((i0, i1, k, end));
                k = end;
            }
            parts
        })
        .collect();
    // A component all of whose lines go is removed from the page whole.
    let mut gone = vec![0usize; blocks.len()];
    for &(i0, i1, j0, j1) in &hunks {
        let pairs = (i1 - i0).min(j1 - j0);
        for line in &old[i0 + pairs..i1] {
            gone[line.1] += 1;
        }
    }
    let whole = |b: usize| blocks[b].embedded.is_some() && gone[b] == blocks[b].lines().len();
    let page_end = blocks.last().map(|b| b.marker + usize::from(b.props.is_some())).unwrap_or(0);
    let mut plan = Plan {
        text,
        author,
        attached: Vec::new(),
        ops: Vec::new(),
        registry: text.list_registry.clone(),
        tasks_added: Vec::new(),
        tasks_removed: Vec::new(),
    };
    let mut removed_whole = vec![false; blocks.len()];
    for (b, run) in &table_runs {
        if let Some(Embedded::Table(table)) = blocks[*b].embedded.as_deref() {
            let lines: Vec<String> =
                wanted[run.clone()].iter().map(|w| w.1.first().map(|r| r.0.clone()).unwrap_or_default()).collect();
            plan.table(table, &lines)?;
        }
    }
    for &(i0, i1, j0, j1) in hunks.iter().rev() {
        let pairs = (i1 - i0).min(j1 - j0);
        if j1 - j0 > pairs {
            insert_new(&mut plan, &old, &wanted, (i0, i1), j0 + pairs..j1, page_end)?;
        }
        for k in (0..i1 - i0).rev() {
            let (_, b, part) = old[i0 + k];
            let block = &blocks[b];
            if k >= pairs {
                if whole(b) {
                    if !removed_whole[b] {
                        removed_whole[b] = true;
                        plan.page(json_remove(block.start, block.marker + 1));
                    }
                    continue;
                }
                match (part, block.embedded.as_deref()) {
                    (Part::Page, _) => {
                        let end = block.marker + usize::from(block.props.is_some());
                        if end > block.start {
                            plan.page(json_remove(block.start, end));
                        }
                    }
                    (Part::Story(s), Some(Embedded::Story { id, blocks, .. })) => {
                        let inner = &blocks[s];
                        plan.ops.push(channel_op(id, "text", json_remove(inner.start, inner.marker + 1)));
                    }
                    (Part::Task(t), Some(Embedded::Tasks(list))) => {
                        plan.tasks_removed.push((b, list.tasks[t].row.clone()));
                    }
                    _ => return Err(refused()),
                }
                continue;
            }
            let (kind, runs) = &wanted[j0 + k];
            match (part, block.embedded.as_deref()) {
                (Part::Page, _) => rewrite_page_block(&mut plan, block, kind, runs),
                (Part::Story(s), Some(Embedded::Story { id, kind: own, blocks, .. })) => {
                    if own != kind {
                        return Err(refused());
                    }
                    let inner = &blocks[s];
                    if inner.runs != *runs {
                        if inner.marker > inner.start {
                            plan.ops.push(channel_op(id, "text", json_remove(inner.start, inner.marker)));
                        }
                        for (t, marks) in runs.iter().rev() {
                            plan.ops.push(channel_op(id, "text", insert_text(inner.start, t, marks, author)));
                        }
                    }
                }
                (Part::Task(t), Some(Embedded::Tasks(list))) => {
                    let Kind::Check(_, done) = kind else { return Err(refused()) };
                    let task = &list.tasks[t];
                    let typed = inline(runs);
                    plan.cell(&task.title, if task.details.is_empty() { &typed } else { task_title(&typed) })?;
                    if *done != task.done {
                        let mut configuration = task.configuration.clone();
                        configuration["checked"] = Value::Bool(*done);
                        plan.ops.push(channel_op(
                            &task.checkbox,
                            "root",
                            serde_json::json!({
                            "key": "ConfigurationType", "path": "/", "type": "set", "value": plain(configuration)}),
                        ));
                    }
                }
                _ => return Err(refused()),
            }
        }
    }
    plan.task_changes();
    let mut out = plan.attached;
    out.extend(plan.ops);
    Ok(out)
}

/// The lines a hunk adds beyond those it rewrites: into the quote or code
/// block they extend, else as new paragraphs where the hunk ends. A list
/// item joins the list of its own kind right before it, or starts one, a run
/// of quotes makes one quote component.
fn insert_new(
    plan: &mut Plan,
    old: &[(String, usize, Part)],
    wanted: &[Wanted],
    (i0, i1): (usize, usize),
    added: std::ops::Range<usize>,
    page_end: usize,
) -> Result<(), RestError> {
    let blocks = &plan.text.blocks;
    let author = plan.author;
    let before = i1.checked_sub(1).map(|i| old[i].1).filter(|_| i1 > 0);
    if let Some(Embedded::Story { id, kind: own, blocks: inner, .. }) =
        before.and_then(|b| blocks[b].embedded.as_deref())
        && let Part::Story(line) = old[i1 - 1].2
        && wanted[added.clone()].iter().all(|(k, _)| k == own)
    {
        let at = inner[line].marker + 1;
        for k in added.rev() {
            let mut props = Map::new();
            props.insert("attribution".into(), author.clone());
            props.insert("markerId".into(), Value::String(uuid()));
            props.insert("nodeType".into(), Value::String("Paragraph".into()));
            plan.ops.push(channel_op(
                id,
                "text",
                serde_json::json!({"pos1": at, "seg": {"marker": {"refType": 1}, "props": props}, "type": 0}),
            ));
            for (t, marks) in wanted[k].1.iter().rev() {
                plan.ops.push(channel_op(id, "text", insert_text(at, t, marks, author)));
            }
        }
        return Ok(());
    }
    let all_checks = wanted[added.clone()].iter().all(|(k, _)| matches!(k, Kind::Check(..)));
    let list_before = before.filter(|b| matches!(blocks[*b].embedded.as_deref(), Some(Embedded::Tasks(_))));
    let list_after = old.get(i1).filter(|l| matches!(l.2, Part::Task(_))).map(|l| l.1);
    if all_checks && let Some(b) = list_before.or(list_after) {
        let after = match (list_before, blocks[b].embedded.as_deref(), i1.checked_sub(1).map(|i| old[i].2)) {
            (Some(_), Some(Embedded::Tasks(list)), Some(Part::Task(t))) => Some(list.tasks[t].row.entry.clone()),
            _ => None,
        };
        plan.tasks_added.push((b, after, wanted[added].to_vec()));
        return Ok(());
    }
    let at = if i1 < old.len() {
        let next = old[i1].1;
        if before == Some(next) { blocks.get(next + 1).map_or(page_end, |b| b.start) } else { blocks[next].start }
    } else {
        page_end
    };
    // Written from the end: the page's positions stay those of the version read.
    let mut k = added.end;
    let start = added.start;
    let mut list_ids: std::collections::HashMap<usize, String> = Default::default();
    // Each run of same-kind items shares one list.
    let mut index = start;
    while index < added.end {
        let family = wanted[index].0.family();
        let Some(family) = family else {
            index += 1;
            continue;
        };
        let end = (index..added.end).find(|&e| wanted[e].0.family() != Some(family)).unwrap_or(added.end);
        let previous = if index == start {
            (i0..i1).rev().chain((0..i0).rev()).next().map(|l| &blocks[old[l].1]).filter(|b| b.embedded.is_none())
        } else {
            None
        };
        let list = previous
            .filter(|b| b.kind.family() == Some(family))
            .and_then(list_of)
            .unwrap_or_else(|| plan.new_list(family));
        for e in index..end {
            list_ids.insert(e, list.clone());
        }
        index = end;
    }
    while k > start {
        k -= 1;
        let (kind, runs) = &wanted[k];
        if *kind == Kind::Quote {
            let first = (start..=k).rev().take_while(|&e| wanted[e].0 == Kind::Quote).last().unwrap_or(k);
            let lines: Vec<Vec<(String, Marks)>> = wanted[first..=k].iter().map(|(_, r)| r.clone()).collect();
            let id = uuid();
            plan.attached.push(attach_quote(&id, &lines, author));
            plan.page(insert_component(at, &id, author));
            k = first;
            continue;
        }
        if *kind == Kind::TableRow {
            let first = (start..=k).rev().take_while(|&e| wanted[e].0 == Kind::TableRow).last().unwrap_or(k);
            let lines: Vec<String> =
                wanted[first..=k].iter().map(|(_, r)| r.first().map(|(t, _)| t.clone()).unwrap_or_default()).collect();
            let separated = lines.get(1).is_some_and(|l| {
                let cells = table_cells(l);
                !cells.is_empty() && cells.iter().all(|c| !c.is_empty() && c.chars().all(|x| matches!(x, '-' | ':')))
            });
            if separated {
                plan.new_table(at, &lines)?;
                k = first;
                continue;
            }
            plan.page(insert_marker(at, &Kind::Paragraph, None, author));
            let raw = runs.first().map(|(t, _)| t.clone()).unwrap_or_default();
            plan.page(insert_text(at, &raw, &Marks::default(), author));
            continue;
        }
        if matches!(kind, Kind::Check(..)) {
            let first = (start..=k).rev().take_while(|&e| matches!(wanted[e].0, Kind::Check(..))).last().unwrap_or(k);
            if inline(&wanted[first].1).contains(TASK_DETAILS) {
                plan.new_task_list(at, &wanted[first..=k])?;
                k = first;
                continue;
            }
        }
        plan.page(insert_marker(at, kind, list_ids.get(&k).map(String::as_str), author));
        for (t, marks) in runs.iter().rev() {
            plan.page(insert_text(at, t, marks, author));
        }
    }
    Ok(())
}

/// One paragraph of the page changed: its text, its style, its list, its tick.
fn rewrite_page_block(plan: &mut Plan, block: &Block, kind: &Kind, runs: &[(String, Marks)]) {
    let author = plan.author;
    let (kind, runs) = (kind.clone(), runs.to_vec());
    if block.props.is_some() && kind != block.kind {
        if kind.family().is_some() && kind.family() == block.kind.family() {
            if let Some(list) = list_of(block) {
                let props: Map<String, Value> =
                    list_props(&list, &kind).into_iter().filter(|(k, _)| k == "list!reference").collect();
                plan.page(
                    serde_json::json!({"pos1": block.marker, "pos2": block.marker + 1, "props": props, "type": 2}),
                );
            }
        } else if let Some(family) = kind.family() {
            let list = plan.new_list(family);
            let mut props = list_props(&list, &kind);
            props.insert("style!reference".into(), Value::Null);
            plan.page(serde_json::json!({"pos1": block.marker, "pos2": block.marker + 1, "props": props, "type": 2}));
        } else {
            plan.page(restyle(block.marker, &kind, &block.kind));
        }
    }
    let ticked = |k: &Kind| matches!(k, Kind::Check(_, true));
    if block.runs != runs {
        if block.marker > block.start {
            plan.page(json_remove(block.start, block.marker));
        }
        for (t, marks) in runs.iter().rev() {
            let mut marks = marks.clone();
            marks.struck |= ticked(&kind);
            plan.page(insert_text(block.start, t, &marks, author));
        }
    } else if ticked(&kind) != ticked(&block.kind) && block.marker > block.start {
        // Loop strikes a ticked item's text; only a tick changes it.
        let decoration = if ticked(&kind) { serde_json::json!(["strikethrough"]) } else { Value::Null };
        plan.page(serde_json::json!({"pos1": block.start, "pos2": block.marker,
            "props": {"format!textDecoration": decoration}, "type": 2}));
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

fn insert_marker(at: usize, kind: &Kind, list: Option<&str>, author: &Value) -> Value {
    let mut props = Map::new();
    props.insert("attribution".into(), author.clone());
    props.insert("markerId".into(), Value::String(uuid()));
    props.insert("nodeType".into(), Value::String("Paragraph".into()));
    if let Some(style) = kind.style() {
        props.insert("style!reference".into(), Value::String(style));
    }
    if let Some(list) = list {
        props.extend(list_props(list, kind));
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
    let ops = edit(&current, markdown, author)?;
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
                    .map(|(n, contents)| {
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

    fn merges_on(ops: &[Value], channel: &str) -> Vec<Value> {
        ops.iter()
            .filter(|o| o.pointer("/contents/contents/content/address") == Some(&json!(channel)))
            .filter_map(|o| o.pointer("/contents/contents/content/contents").cloned())
            .collect()
    }

    /// The merge-tree operations of a save on one component's text.
    fn merges(ops: &[Value], component: &str) -> Vec<Value> {
        ops.iter()
            .filter(|o| o.pointer("/contents/address") == Some(&json!(component)))
            .filter(|o| o.pointer("/contents/contents/content/address") == Some(&json!("text")))
            .filter_map(|o| o.pointer("/contents/contents/content/contents").cloned())
            .collect()
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
        assert_eq!(text.sequence, 5);
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
        assert!(edit(&text, &text.markdown, &json!({})).unwrap().is_empty());
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
        let all = edit(&text, &wanted, &json!({"name": "Ada"})).unwrap();
        let ops = merges(&all, &text.component);
        assert!(ops.len() < 12, "{ops:?}");
        assert!(ops.windows(2).all(|w| w[0]["pos1"].as_u64() >= w[1]["pos1"].as_u64()), "descending");
        assert_eq!(applied(&text, &ops), wanted);
    }

    #[test]
    fn new_paragraphs_carry_their_style_and_marks() {
        let empty = Text { component: "C".into(), ..Text::default() };
        let all = edit(&empty, "# Title\n\nhello **world**\n\n- item", &json!({"name": "Ada"})).unwrap();
        let ops = merges(&all, "C");
        let styles: Vec<_> = ops.iter().filter_map(|o| o.pointer("/seg/props/style!reference")).collect();
        assert_eq!(styles, vec![&json!("Heading 1")]);
        assert!(ops.iter().any(|o| o.pointer("/seg/text") == Some(&json!("world"))
            && o.pointer("/seg/props/format!bold") == Some(&json!(true))));
        assert!(ops.iter().all(|o| o.pointer("/seg/props/attribution/name").is_none_or(|n| n == "Ada")));
    }

    /// A page as Loop keeps it (scrubbed from a real one): lists with their
    /// nodes, a quote, a code block, a table and a task list.
    fn blocks_snapshot() -> Value {
        let mut blobs: Vec<Value> = Vec::new();
        let mut entries: Vec<Value> = Vec::new();
        let mut file = |path: String, content: Value| {
            let id = format!("b{}", blobs.len());
            let content = content.as_str().map_or_else(|| content.to_string(), str::to_owned);
            blobs.push(json!({"id": id, "content": content, "encoding": "utf-8"}));
            entries.push(json!({"path": path, "type": "blob", "id": id}));
        };
        let dir = |storage: Value| json!({"content": {"storage": storage}});
        let plain = |v: Value| json!({"type": "Plain", "value": v});
        let url = |u: &str| json!({"type": "__fluid_handle__", "url": u});
        let para = || json!({"marker": {"refType": 1}, "props": {"nodeType": "Paragraph"}});
        let text = |segments: Value| {
            json!({"segmentTexts": segments, "headerMetadata": {
            "orderedChunkMetadata": [{"id": "header"}], "sequenceNumber": 5}})
        };
        let at = |c: &str, rest: &str| format!(".app/.channels/{c}/{rest}");
        let package = |p: &str| json!({"pkg": format!("[\"{p}\"]")});
        let component = |c: &str, reference: Value| {
            json!({"marker": {"refType": 1}, "props": {
            "nodeType": "FluidComponent", "component!url": {"type": "__fluid_handle__", "url": format!("/{c}")}, "x": reference}})
        };
        file(at("P", ".component"), package("LoopCanvasComponentSingleton"));
        file(at("P", ".channels/root/header"), dir(json!({"text:list!registry": plain(url("/P/REG"))})));
        file(
            at("P", ".channels/CHECK/header"),
            dir(json!({
            "list!id": plain(json!("L0")), "list!itemFormat-0": plain(json!("%cb"))})),
        );
        file(
            at("P", ".channels/NUM/header"),
            dir(json!({
            "list!id": plain(json!("L1")), "list!itemFormat-0": plain(json!("%cd3"))})),
        );
        file(
            at("P", ".channels/text/content/header"),
            text(json!([
                "title", para(),
                {"text": "done", "props": {"format!textDecoration": ["strikethrough"]}},
                {"marker": {"refType": 1}, "props": {"nodeType": "Paragraph", "list!reference": "0;L0;1"}},
                "open",
                {"marker": {"refType": 1}, "props": {"nodeType": "Paragraph", "list!reference": "0;L0;0"}},
                "one",
                {"marker": {"refType": 1}, "props": {"nodeType": "Paragraph", "list!reference": "0;L1"}},
                component("Q", json!(1)), component("CODE", json!(2)), component("TB", json!(3)), component("TL", json!(4)),
            ])),
        );
        file(at("Q", ".component"), package("BlockQuoteComponentType"));
        file(at("Q", ".channels/text/content/header"), text(json!(["wise", para()])));
        file(at("CODE", ".component"), package("CodeBlockComponentType"));
        file(at("CODE", ".channels/root/header"), dir(json!({"text:code!language": plain(json!("Python"))})));
        file(at("CODE", ".channels/text/content/header"), text(json!(["x = 1", para()])));
        // Row handles 1 (titles) and 2, column handles 1 (row ids) and 2.
        let cell = |row: u32, column: u32| -> usize {
            (0..8).fold(0, |k, b| {
                k | (((column >> b) & 1) << (2 * b)) as usize | (((row >> b) & 1) << (2 * b + 1)) as usize
            })
        };
        let matrix = |rows: Vec<(u32, u32, Value)>| {
            let mut leaf = vec![Value::Null; 64];
            for (r, c, v) in rows {
                leaf[cell(r, c)] = v;
            }
            json!([[[[[[leaf]]]]], [null], -1])
        };
        file(at("TB", ".component"), package("TableroComponentType"));
        file(at("TB", ".channels/root/header"), dir(json!({"tableViewModelIdKey": plain(url("/TV"))})));
        file(
            at("TV", ".channels/root/header"),
            dir(json!({
            "tableroDocumentId": plain(url("/TD")), "rowSequenceKey": plain(url("/TV/rowSequence-1")),
            "colSequenceKey": plain(url("/TV/colSequence-1")), "viewDataPropertyBagKey": plain(url("/TV/bag")),
            "sharedSignalKey": plain(url("/TV/signal"))})),
        );
        file(
            at("TD", ".channels/root/header"),
            dir(json!({"matrixIdKey": plain(url("/TD/matrixId-1")), "columnCounterKey": plain(url("/TD/counter"))})),
        );
        file(at("TD", ".channels/matrixId-1/rows/segments/header"), json!({"segments": [[2, 1]]}));
        file(at("TD", ".channels/matrixId-1/cols/segments/header"), json!({"segments": [[2, 1]]}));
        file(
            at("TV", ".channels/rowSequence-1/header"),
            json!({"dataArray": [
            {"entryId": "E0", "value": "gone", "isDeleted": true}, {"entryId": "E1", "value": "R", "isDeleted": false}]}),
        );
        file(
            at("TV", ".channels/colSequence-1/header"),
            json!({"dataArray": [{"entryId": "EC", "value": "K", "isDeleted": false}]}),
        );
        file(
            at("TD", ".channels/matrixId-1/cells"),
            matrix(vec![
                (
                    1,
                    2,
                    json!({"id": "K", "type": "IRichTextData", "title": {
                "componentHandle": {"type": "__fluid_handle__", "url": "/HEAD"}, "cellValue": "Col"}}),
                ),
                (2, 1, json!({"id": "R"})),
                (
                    2,
                    2,
                    json!({"value": {"componentHandle": {"type": "__fluid_handle__", "url": "/CELL"}, "cellValue": ""},
                "cellDataTypeProps": {"type": "IRichTextData"}}),
                ),
            ]),
        );
        file(at("HEAD", ".channels/text/content/header"), text(json!(["Col", para()])));
        file(at("CELL", ".channels/text/content/header"), text(json!(["aa", para()])));
        file(at("TL", ".component"), package("TasklistComponentType"));
        file(at("TT", ".component"), package("TasklistComponentType"));
        file(at("TL", ".channels/root/header"), dir(json!({"tableComponentHandle": plain(url("/TT"))})));
        file(at("TT", ".channels/root/header"), dir(json!({"tableViewModelIdKey": plain(url("/LV"))})));
        file(
            at("LV", ".channels/root/header"),
            dir(json!({
            "tableroDocumentId": plain(url("/LD")), "rowSequenceKey": plain(url("/LV/rowSequence-1")),
            "colSequenceKey": plain(url("/LV/colSequence-1"))})),
        );
        file(at("LD", ".channels/root/header"), dir(json!({"matrixIdKey": plain(url("/LD/matrixId-1"))})));
        file(at("LD", ".channels/matrixId-1/rows/segments/header"), json!({"segments": [[2, 1]]}));
        file(at("LD", ".channels/matrixId-1/cols/segments/header"), json!({"segments": [[2, 1]]}));
        file(
            at("LV", ".channels/rowSequence-1/header"),
            json!({"dataArray": [{"entryId": "E1", "value": "T", "isDeleted": false}]}),
        );
        file(
            at("LV", ".channels/colSequence-1/header"),
            json!({"dataArray": [{"entryId": "E2", "value": "TC", "isDeleted": false}]}),
        );
        file(
            at("LD", ".channels/matrixId-1/cells"),
            matrix(vec![
                (1, 2, json!({"id": "TC", "type": "ICheckboxRichText"})),
                (2, 1, json!({"id": "T"})),
                (2, 2, json!({"value": {"componentHandle": {"type": "__fluid_handle__", "url": "/BOX"}}})),
            ]),
        );
        file(
            at("BOX", ".channels/root/header"),
            dir(json!({"ConfigurationType": plain(json!({
            "checked": false, "type": "CheckboxText",
            "richTextComponentHandle": {"type": "__fluid_handle__", "url": "/TITLE"}}))})),
        );
        file(at("TITLE", ".channels/text/content/header"), text(json!(["ship", para()])));
        json!({"blobs": blobs, "latestSequenceNumber": 5, "ops": [], "trees": [{"entries": entries}]})
    }

    const BLOCKS: &str = "title\n\n- [x] done\n- [ ] open\n\n1. one\n\n> wise\n\n```python\nx = 1\n```\n\n| Col |\n| --- |\n| aa |\n\n- [ ] ship";

    #[test]
    fn a_real_pages_blocks_read_as_markdown() {
        assert_eq!(read(&blocks_snapshot(), &[]).unwrap().markdown, BLOCKS);
    }

    #[test]
    fn saving_unchanged_blocks_sends_nothing() {
        let text = read(&blocks_snapshot(), &[]).unwrap();
        assert_eq!(edit(&text, BLOCKS, &json!({})).unwrap(), Vec::<Value>::new());
    }

    fn address(op: &Value) -> (&str, &str) {
        (
            op.pointer("/contents/address").and_then(Value::as_str).unwrap_or(""),
            op.pointer("/contents/contents/content/address").and_then(Value::as_str).unwrap_or(""),
        )
    }

    #[test]
    fn each_block_is_edited_in_its_own_channel() {
        let text = read(&blocks_snapshot(), &[]).unwrap();
        let wanted = BLOCKS
            .replace("> wise", "> wiser")
            .replace("x = 1", "x = 2")
            .replace("| aa |", "| bb |")
            .replace("- [ ] ship", "- [x] shipped");
        let ops = edit(&text, &wanted, &json!({})).unwrap();
        let touched: std::collections::HashSet<_> = ops.iter().map(address).collect();
        let expected: std::collections::HashSet<_> =
            [("Q", "text"), ("CODE", "text"), ("CELL", "text"), ("TITLE", "text"), ("BOX", "root")]
                .into_iter()
                .collect();
        assert_eq!(touched, expected);
        let tick = ops.iter().find(|o| address(o).1 == "root").unwrap();
        let set = tick.pointer("/contents/contents/content/contents").unwrap();
        assert_eq!(set["type"], "set");
        assert_eq!(set["path"], "/");
        assert_eq!(set["key"], "ConfigurationType");
        assert_eq!(set.pointer("/value/value/checked"), Some(&json!(true)));
    }

    #[test]
    fn a_saved_edit_reads_back_as_typed() {
        let snapshot = blocks_snapshot();
        let text = read(&snapshot, &[]).unwrap();
        let wanted = BLOCKS
            .replace("title", "title again")
            .replace("> wise", "> wiser\n> and more")
            .replace("x = 1", "x = 2")
            .replace("| aa |", "| **bb** |")
            .replace("- [ ] ship", "- [x] shipped")
            .replace("- [ ] open", "- [x] open");
        let ops = edit(&text, &wanted, &json!({"name": "Ada"})).unwrap();
        let later: Vec<Value> = ops
            .iter()
            .enumerate()
            .map(|(n, contents)| {
                let seq = 6 + n as i64;
                json!({"op": {"sequenceNumber": seq, "timestamp": 1, "type": "op", "contents": contents.to_string()}, "sequenceNumber": seq})
            })
            .collect();
        assert_eq!(read(&snapshot, &later).unwrap().markdown, wanted);
    }

    #[test]
    fn a_native_tick_moves_the_reference_and_the_strike() {
        let text = read(&blocks_snapshot(), &[]).unwrap();
        let ops = edit(&text, &BLOCKS.replace("- [ ] open", "- [x] open"), &json!({})).unwrap();
        let merges = merges(&ops, "P");
        assert!(merges.iter().any(|o| o.pointer("/props/list!reference") == Some(&json!("0;L0;1"))), "{merges:?}");
        assert!(merges.iter().any(|o| o.pointer("/props/format!textDecoration") == Some(&json!(["strikethrough"]))));
    }

    #[test]
    fn the_templates_read_as_a_table_and_a_task_list() {
        let (_, _, table) = from_template(NEW_TABLE, false).expect("a table");
        assert!(matches!(table, Embedded::Table(_)));
        let (_, _, list) = from_template(NEW_TASK_LIST, true).expect("a task list");
        let Embedded::Tasks(list) = list else { panic!("not tasks") };
        assert!(list.tasks.is_empty());
        assert_eq!(list.table.definitions.len(), 5);
        assert!(list.table.labels.is_some());
    }

    #[test]
    fn tasks_are_added_and_removed_one_at_a_time() {
        let snapshot = blocks_snapshot();
        let text = read(&snapshot, &[]).unwrap();
        let wanted = format!("{BLOCKS}\n- [x] next\n- [ ] last");
        let ops = edit(&text, &wanted, &json!({})).unwrap();
        assert_eq!(saved(&snapshot, &ops), wanted);

        let later: Vec<Value> = ops
            .iter()
            .enumerate()
            .map(|(n, c)| json!({"op": {"sequenceNumber": 6 + n, "timestamp": 1, "type": "op", "contents": c.to_string()}, "sequenceNumber": 6 + n}))
            .collect();
        let grown = read(&snapshot, &later).unwrap();
        let shrunk = wanted.replace("- [x] next\n", "");
        let ops = edit(&grown, &shrunk, &json!({})).unwrap();
        let removal =
            ops.iter().filter_map(|o| o.pointer("/contents/contents/content/contents")).find(|o| o["type"] == 1);
        assert_eq!(removal.unwrap()["target"], "rows");
    }

    #[test]
    fn a_task_edit_leaves_its_details_alone() {
        let line = Task {
            checkbox: "B".into(),
            configuration: json!({}),
            done: false,
            title: Cell { id: None, runs: vec![("dur".into(), Marks::default())], end: 0 },
            row: Line { id: "r".into(), entry: "e".into(), position: 1 },
            details: vec!["@Me".into(), "2026-11-01".into(), "To do".into()],
        }
        .line();
        assert_eq!(line, "- [ ] dur \u{b7} @Me \u{b7} 2026-11-01 \u{b7} To do");
        assert_eq!(task_title("renamed \u{b7} @Me \u{b7} changed"), "renamed");
    }

    #[test]
    fn a_new_table_and_task_list_read_back_as_typed() {
        let snapshot = blocks_snapshot();
        let text = read(&snapshot, &[]).unwrap();
        let wanted = format!(
            "{BLOCKS}\n\nbetween\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | **2** | 3 |\n| 4 | 5 | 6 |\n\nmore\n\n- [ ] one \u{b7} To do\n- [x] two"
        );
        let ops = edit(&text, &wanted, &json!({})).unwrap();
        let read_back = saved(&snapshot, &ops);
        assert!(
            read_back.contains("| A | B | C |\n| --- | --- | --- |\n| 1 | **2** | 3 |\n| 4 | 5 | 6 |"),
            "{read_back}"
        );
        assert!(read_back.ends_with("- [ ] one \u{b7} To do\n- [x] two \u{b7} To do"), "{read_back}");
    }

    #[test]
    fn a_template_uses_new_ids_each_time() {
        let once = with_fresh_ids("/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/x/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
        let (first, second) = once[1..].split_once("/x/").unwrap();
        assert_eq!(first, second);
        assert_ne!(first, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    }

    #[test]
    fn a_summary_can_wrap_recent_segments_and_keep_text_operations_apart() {
        assert_eq!(segment_units(&json!({"json": {"text": "ab"}, "seq": 9})).len(), 2);
        assert!(segment_units(&json!({"json": {"text": "ab"}, "removedSeq": 9})).is_empty());
        let mut snapshot = blocks_snapshot();
        let catchup = json!([{"sequenceNumber": 9, "contents": {"pos1": 0, "seg": {"text": "new "}, "type": 0}}]);
        let path = ".app/.channels/P/.channels/text/content/catchupOps";
        snapshot["trees"][0]["entries"].as_array_mut().unwrap().push(json!({"path": path, "id": "catchup"}));
        snapshot["blobs"].as_array_mut().unwrap().push(json!({"id": "catchup", "content": catchup.to_string()}));
        assert!(read(&snapshot, &[]).unwrap().markdown.starts_with("new title"));
    }

    fn saved(snapshot: &Value, ops: &[Value]) -> String {
        let later: Vec<Value> = ops
            .iter()
            .enumerate()
            .map(|(n, contents)| {
                let seq = 6 + n as i64;
                json!({"op": {"sequenceNumber": seq, "timestamp": 1, "type": "op", "contents": contents.to_string()}, "sequenceNumber": seq})
            })
            .collect();
        read(snapshot, &later).unwrap().markdown
    }

    #[test]
    fn a_table_takes_new_and_removed_rows_and_columns() {
        let snapshot = blocks_snapshot();
        let text = read(&snapshot, &[]).unwrap();
        let table = "| Col |\n| --- |\n| aa |";
        for typed in [
            "| Col |\n| --- |\n| aa |\n| new row |",
            "| Col |\n| --- |\n| new first |\n| aa |",
            "| Col | Two |\n| --- | --- |\n| aa | **b** |",
            "| One | Col |\n| --- | --- |\n| x | aa |",
            "| Col |\n| --- |",
            "| Renamed |\n| --- |\n| changed |\n| and more |",
        ] {
            let wanted = BLOCKS.replace(table, typed);
            let ops = edit(&text, &wanted, &json!({"name": "Ada"})).unwrap();
            assert_eq!(saved(&snapshot, &ops), wanted, "{typed}");
            // Saved again from what it reads as, nothing more is sent.
            let later: Vec<Value> = ops.iter().enumerate().map(|(n, contents)| {
                let seq = 6 + n as i64;
                json!({"op": {"sequenceNumber": seq, "timestamp": 1, "type": "op", "contents": contents.to_string()}, "sequenceNumber": seq})
            }).collect();
            let again = read(&snapshot, &later).unwrap();
            assert_eq!(edit(&again, &wanted, &json!({})).unwrap(), Vec::<Value>::new(), "{typed}");
        }
    }

    #[test]
    fn a_new_row_and_a_removed_one_follow_the_editors_operations() {
        let snapshot = blocks_snapshot();
        let text = read(&snapshot, &[]).unwrap();
        let wanted = BLOCKS.replace("| aa |", "| aa |\n| bb |");
        let ops = edit(&text, &wanted, &json!({"name": "Ada"})).unwrap();
        let on = |channel: &str| merges_on(&ops, channel);
        let matrix = on("matrixId-1");
        assert_eq!(matrix[0], json!({"pos1": 2, "seg": [1, -2147483648i64], "type": 0, "target": "rows"}));
        assert_eq!(matrix[1]["row"], 2);
        assert_eq!(matrix[1]["col"], 0);
        assert!(matrix[1].pointer("/value/metadataProperties").is_some());
        assert_eq!(matrix[2]["col"], 1);
        assert_eq!(on("rowSequence-1")[0]["insertAfterEntryId"], "E1");
        let ops = edit(&text, &BLOCKS.replace("\n| aa |", ""), &json!({})).unwrap();
        let matrix = merges_on(&ops, "matrixId-1");
        assert_eq!(matrix[0], json!({"pos1": 1, "pos2": 2, "type": 1, "target": "rows"}));
        assert_eq!(merges_on(&ops, "rowSequence-1")[0], json!({"type": 1, "entryId": "E1"}));
    }

    #[test]
    fn a_whole_component_can_go() {
        let text = read(&blocks_snapshot(), &[]).unwrap();
        let wanted = BLOCKS.replace("| Col |\n| --- |\n| aa |\n\n", "");
        let ops = edit(&text, &wanted, &json!({})).unwrap();
        let (table_start, table_end) = {
            let b = text.blocks.iter().find(|b| matches!(b.embedded.as_deref(), Some(Embedded::Table(_)))).unwrap();
            (b.start, b.marker + 1)
        };
        assert_eq!(merges(&ops, "P"), vec![json!({"pos1": table_start, "pos2": table_end, "type": 1})]);
    }

    #[test]
    fn new_quotes_and_lists_read_back_before_the_next_summary() {
        let snapshot = blocks_snapshot();
        let text = read(&snapshot, &[]).unwrap();
        let wanted = format!(
            "{BLOCKS}\n\n> a new quote\n> and more\n\nplain\n\n- b1\n- b2\n\n1. n1\n2. n2\n\n- [ ] c1\n- [x] c2"
        );
        let ops = edit(&text, &wanted, &json!({"name": "Ada"})).unwrap();
        let later: Vec<Value> = ops
            .iter()
            .enumerate()
            .map(|(n, contents)| {
                let seq = 6 + n as i64;
                json!({"op": {"sequenceNumber": seq, "timestamp": 1, "type": "op", "contents": contents.to_string()}, "sequenceNumber": seq})
            })
            .collect();
        assert_eq!(read(&snapshot, &later).unwrap().markdown, wanted);
    }

    #[test]
    fn a_new_quote_and_list_are_attached_before_what_refers_to_them() {
        let text = read(&blocks_snapshot(), &[]).unwrap();
        let wanted = format!("{BLOCKS}\n\n> new quote\n\nplain\n\n1. new number");
        let ops = edit(&text, &wanted, &json!({"name": "Ada"})).unwrap();
        let quote = ops.iter().position(|o| o["type"] == "attach").unwrap();
        let placed = ops.iter().position(|o| {
            o.pointer("/contents/contents/content/contents/seg/props/nodeType") == Some(&json!("FluidComponent"))
        });
        assert!(quote < placed.unwrap());
        assert_eq!(ops[quote].pointer("/contents/type"), Some(&json!("[\"BlockQuoteComponentType\"]")));
        let channel = ops.iter().position(|o| o.pointer("/contents/contents/type") == Some(&json!("attach"))).unwrap();
        let registered = ops.iter().position(|o| address(o) == ("P", "REG")).unwrap();
        assert!(channel < registered);
        let item = ops
            .iter()
            .position(|o| o.pointer("/contents/contents/content/contents/seg/props/list!reference").is_some());
        assert!(registered < item.unwrap());
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
