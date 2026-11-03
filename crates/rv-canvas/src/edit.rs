//! An edited markdown as the sections Quip's editor would save: the blocks
//! that changed, each with the Automerge document of its text, in the shapes a
//! person's session sent (captured 2026-11-03).

use automerge::transaction::{CommitOptions, Transactable};
use automerge::{ActorId, AutoCommit, ChangeHash, ObjType, ROOT, ReadDoc};

use crate::markdown::{Kind, Line, lines_of, parse};
use crate::model::*;
use crate::wire::Message;

/// One editing session: `id` names it on the wire, its documents' actor is
/// `id` followed by `suffix` (12 and 8 hex characters, drawn by the caller).
#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub suffix: String,
    pub now_secs: i64,
}

/// What a save sends: `data_binary`, empty when nothing changed.
#[derive(Debug, Clone, Default)]
pub struct Edit {
    pub data: Vec<u8>,
    pub changed: usize,
}

const END: &str = "\u{feff}";

pub fn plan(canvas: &Canvas, markdown: &str, session: &Session) -> Edit {
    let old_blocks = canvas.blocks();
    let old = lines_of(canvas);
    let new = parse(markdown);
    let pairs = align(&old, &new);
    let mut out = Writer { session, trace: 0, sections: Vec::new(), canvas };

    let mut last_top: Option<String> = None;
    let mut last_item: std::collections::HashMap<String, String> = Default::default();
    let mut current_list: Option<(u64, String)> = None;
    let mut deleted_items: std::collections::HashMap<String, usize> = Default::default();

    for (step, pair) in pairs.iter().enumerate() {
        match *pair {
            Pair::Keep(o, _) | Pair::Update(o, _) => {
                let (top_key, list) = match old_blocks[o] {
                    Block::Text(s) => (s.position.clone(), None),
                    Block::Item { list, item } => {
                        last_item.insert(list.id.clone(), item.position.clone());
                        (list.position.clone(), Some((list.style, list.id.clone())))
                    }
                };
                last_top = Some(top_key);
                current_list = list;
                if let Pair::Update(o, n) = *pair {
                    let section = match old_blocks[o] {
                        Block::Text(s) => s,
                        Block::Item { item, .. } => item,
                    };
                    let style = match new[n].kind {
                        Kind::Text(style) => Some(style),
                        Kind::Item(_) => None,
                    };
                    out.update(section, &new[n].text, style);
                }
            }
            Pair::Delete(o) => {
                let section = match old_blocks[o] {
                    Block::Text(s) => s,
                    Block::Item { list, item } => {
                        *deleted_items.entry(list.id.clone()).or_default() += 1;
                        item
                    }
                };
                out.delete(section);
            }
            Pair::Insert(n) => {
                let line = &new[n];
                let upper_top = next_top(&pairs[step + 1..], &old_blocks);
                match line.kind {
                    Kind::Text(style) => {
                        let key = between(last_top.as_deref(), upper_top.as_deref());
                        out.insert_text(style, &line.text, &key);
                        last_top = Some(key);
                        current_list = None;
                    }
                    Kind::Item(style) => {
                        let list = match &current_list {
                            Some((s, id)) if *s == style => id.clone(),
                            _ => {
                                let key = between(last_top.as_deref(), upper_top.as_deref());
                                let id = out.insert_list(style, &key);
                                last_top = Some(key);
                                current_list = Some((style, id.clone()));
                                id
                            }
                        };
                        let lower = last_item.get(&list).cloned();
                        let upper = next_item(&pairs[step + 1..], &old_blocks, &list);
                        let key = between(lower.as_deref(), upper.as_deref());
                        let path = format!("{}-{key}", out.list_position(&list));
                        out.insert_item(&list, style, &line.text, &key, &path);
                        last_item.insert(list, key);
                    }
                }
            }
        }
    }
    for (list, gone) in deleted_items {
        let remaining = canvas.sections.iter().filter(|s| !s.deleted && s.parent.as_deref() == Some(&list)).count();
        if remaining == gone
            && let Some(section) = canvas.sections.iter().find(|s| s.id == list)
        {
            out.delete_list(section);
        }
    }
    out.finish()
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Pair {
    Keep(usize, usize),
    Update(usize, usize),
    Delete(usize),
    Insert(usize),
}

/// The old and new lines matched: equal lines kept (longest common
/// subsequence), and between them an old line of the same family rewritten in
/// place rather than deleted and inserted.
fn align(old: &[Line], new: &[Line]) -> Vec<Pair> {
    let (n, m) = (old.len(), new.len());
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if old[i] == new[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut keeps = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if old[i] == new[j] {
            keeps.push((i, j));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    keeps.push((n, m));
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    for (ki, kj) in keeps {
        let (mut a, mut b) = (i, j);
        while a < ki && b < kj {
            if same_family(&old[a].kind, &new[b].kind) {
                out.push(Pair::Update(a, b));
            } else {
                out.push(Pair::Delete(a));
                out.push(Pair::Insert(b));
            }
            a += 1;
            b += 1;
        }
        out.extend((a..ki).map(Pair::Delete));
        out.extend((b..kj).map(Pair::Insert));
        if ki < n {
            out.push(Pair::Keep(ki, kj));
        }
        i = ki + 1;
        j = kj + 1;
    }
    out
}

fn same_family(a: &Kind, b: &Kind) -> bool {
    match (a, b) {
        (Kind::Text(_), Kind::Text(_)) => true,
        (Kind::Item(x), Kind::Item(y)) => x == y,
        _ => false,
    }
}

fn next_top(rest: &[Pair], old: &[Block<'_>]) -> Option<String> {
    rest.iter().find_map(|p| match *p {
        Pair::Keep(o, _) | Pair::Update(o, _) => Some(match old[o] {
            Block::Text(s) => s.position.clone(),
            Block::Item { list, .. } => list.position.clone(),
        }),
        _ => None,
    })
}

fn next_item(rest: &[Pair], old: &[Block<'_>], list: &str) -> Option<String> {
    rest.iter().find_map(|p| match *p {
        Pair::Keep(o, _) | Pair::Update(o, _) => match old[o] {
            Block::Item { list: l, item } if l.id == list => Some(item.position.clone()),
            _ => None,
        },
        _ => None,
    })
}

/// A position strictly between `lower` and `upper` in Quip's letter keys.
pub fn between(lower: Option<&str>, upper: Option<&str>) -> String {
    let digits = |s: &str| {
        s.split(':').next().unwrap_or("").bytes().map(|b| b.saturating_sub(b'a').min(25)).collect::<Vec<u8>>()
    };
    let lo = lower.map(digits).unwrap_or_default();
    if upper.is_none()
        && let Some(last) = lo.last()
        && *last < 24
    {
        let mut next = lo.clone();
        *next.last_mut().expect("not empty") += 1;
        return next.into_iter().map(|d| char::from(b'a' + d)).collect();
    }
    let mut hi = upper.map(digits);
    let mut out = Vec::new();
    for i in 0.. {
        let l = *lo.get(i).unwrap_or(&0);
        let h = match &hi {
            Some(h) => *h.get(i).unwrap_or(&0),
            None => 26,
        };
        if h > l + 1 {
            out.push(l + (h - l) / 2);
            break;
        }
        out.push(l);
        if h > l {
            hi = None;
        }
    }
    out.into_iter().map(|d| char::from(b'a' + d)).collect()
}

struct Writer<'a> {
    session: &'a Session,
    trace: u64,
    sections: Vec<Message>,
    canvas: &'a Canvas,
}

impl Writer<'_> {
    fn actor(&self) -> ActorId {
        let hex = format!("{}{}", self.session.id, self.session.suffix);
        let bytes: Vec<u8> =
            (0..hex.len() / 2).filter_map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()).collect();
        ActorId::from(bytes)
    }

    fn commit(&self, doc: &mut AutoCommit) -> ChangeHash {
        doc.commit_with(CommitOptions::default().with_time(self.session.now_secs));
        doc.get_heads()[0]
    }

    /// A document holding `text` as its first change, as a session opens a block.
    fn open(&self, text: &str) -> (AutoCommit, ChangeHash) {
        let mut doc = AutoCommit::new().with_actor(self.actor());
        doc.put(ROOT, "deleted", false).expect("a fresh document takes a key");
        let body = doc.put_object(ROOT, "text", ObjType::Text).expect("a fresh document takes a text");
        doc.splice_text(&body, 0, 0, &format!("{text}{END}")).expect("a fresh text takes a splice");
        let head = self.commit(&mut doc);
        (doc, head)
    }

    fn trace(&mut self) -> String {
        let n = self.trace;
        self.trace += 1;
        format!("{}-{n}", self.session.id)
    }

    fn new_id(&self, n: usize) -> String {
        format!("temp:C:eTd{}{}{:05x}", self.session.id, &self.session.suffix[..8.min(self.session.suffix.len())], n)
    }

    fn crdt(id: &str, base: u64, saved: u64, doc: &mut AutoCommit) -> Message {
        Message::default().with_str(1, id).with_int(2, base).with_int(3, saved).with_bytes(5, doc.save())
    }

    fn update(&mut self, section: &Section, text: &str, style: Option<u64>) {
        let (mut doc, opened) = self.open(&section.text);
        let mut crdt = if text != section.text {
            let body = doc.get(ROOT, "text").ok().flatten().map(|(_, id)| id).expect("an opened document has a text");
            let (start, removed, inserted) = splice(&section.text, text);
            doc.splice_text(&body, start, removed as isize, inserted).expect("an edit fits its text");
            let head = self.commit(&mut doc);
            Self::crdt(&section.id, section.sequence, section.sequence, &mut doc)
                .with_str(6, &opened.to_string())
                .with_str(8, &opened.to_string())
                .with_message(11, &Message::default().with_str(1, &opened.to_string()).with_int(2, section.sequence))
                .with_str(12, &head.to_string())
        } else {
            Self::crdt(&section.id, section.sequence, section.sequence, &mut doc)
        };
        crdt.fields.sort_by_key(|(n, _)| *n);
        let trace = self.trace();
        let mut message =
            Message::default().with_str(1, &section.id).with_int(2, section.sequence).with_int(9, section.kind);
        if let Some(style) = style {
            message = message.with_int(10, style);
        }
        let message = message
            .with_message(12, &text_content(text))
            .with_bytes(13, parents_of(section))
            .with_int(19, 1)
            .with_int(20, 1)
            .with_str(33, &trace)
            .with_message(38, &crdt);
        self.sections.push(message);
    }

    fn delete(&mut self, section: &Section) {
        let (mut doc, opened) = self.open(&section.text);
        doc.put(ROOT, "deleted", true).expect("an opened document takes a key");
        let head = self.commit(&mut doc);
        let crdt = Self::crdt(&section.id, section.sequence, section.sequence, &mut doc)
            .with_str(6, &opened.to_string())
            .with_str(8, &opened.to_string())
            .with_message(11, &Message::default().with_str(1, &opened.to_string()).with_int(2, section.sequence))
            .with_str(12, &head.to_string());
        let trace = self.trace();
        self.sections.push(
            Message::default()
                .with_str(1, &section.id)
                .with_int(2, section.sequence)
                .with_int(3, 1)
                .with_int(9, section.kind)
                .with_bytes(13, parents_of(section))
                .with_int(19, 1)
                .with_int(20, 1)
                .with_str(33, &trace)
                .with_message(38, &crdt),
        );
    }

    fn delete_list(&mut self, section: &Section) {
        let trace = self.trace();
        self.sections.push(
            Message::default()
                .with_str(1, &section.id)
                .with_int(2, section.sequence)
                .with_int(3, 1)
                .with_int(9, TYPE_LIST)
                .with_int(10, section.style)
                .with_int(19, 1)
                .with_int(20, 1)
                .with_str(33, &trace),
        );
    }

    fn fresh(&mut self, id: &str, kind: u64, style: u64, key: &str, path: &str, parents: Vec<u8>) -> Message {
        let trace = self.trace();
        Message::default()
            .with_str(1, id)
            .with_int(2, 0)
            .with_int(3, 0)
            .with_str(8, &format!("{key}:temp"))
            .with_int(9, kind)
            .with_int(10, style)
            .with_int(11, 0)
            .with_bytes(12, Vec::new())
            .with_bytes(13, parents)
            .with_message(16, &Message::default().with_int(4, 0))
            .with_int(19, 1)
            .with_int(20, 1)
            .with_str(21, path)
            .with_int(29, 0)
            .with_str(33, &trace)
            .with_int(35, 0)
    }

    fn insert_text(&mut self, style: u64, text: &str, key: &str) {
        let id = self.new_id(self.sections.len());
        let (mut doc, _) = self.open(text);
        let mut message = self.fresh(&id, TYPE_TEXT, style, key, &format!("{key}:temp"), Vec::new());
        set_content(&mut message, text);
        message = message.with_message(38, &Self::crdt(&id, 0, 0, &mut doc)).with_int(39, 0);
        self.sections.push(message);
    }

    fn insert_list(&mut self, style: u64, key: &str) -> String {
        let id = self.new_id(self.sections.len());
        let message = self.fresh(&id, TYPE_LIST, style, key, &format!("{key}:temp"), Vec::new());
        self.sections.push(message);
        id
    }

    fn list_position(&self, list: &str) -> String {
        if let Some(section) = self.canvas.sections.iter().find(|s| s.id == list) {
            return section.position.clone();
        }
        self.sections
            .iter()
            .find(|m| m.string(1).as_deref() == Some(list))
            .and_then(|m| m.string(8))
            .unwrap_or_default()
    }

    fn insert_item(&mut self, list: &str, style: u64, text: &str, key: &str, path: &str) {
        let id = self.new_id(self.sections.len());
        let (mut doc, _) = self.open(text);
        let parents = Message::default().with_str(1, list).with_int(4, style).encode();
        let mut message = self.fresh(&id, TYPE_TEXT, STYLE_PLAIN, key, &format!("{path}:temp"), parents);
        set_content(&mut message, text);
        message = message.with_message(38, &Self::crdt(&id, 0, 0, &mut doc)).with_int(39, 0);
        self.sections.push(message);
    }

    fn finish(self) -> Edit {
        if self.sections.is_empty() {
            return Edit::default();
        }
        let changed = self.sections.len();
        let mut top = Message::default();
        for section in &self.sections {
            top = top.with_message(1, section);
        }
        let title = Message::default().with_str(1, "text").with_str(2, &self.canvas.title);
        let rich = Message::default()
            .with_str(1, "rich_text")
            .with_message(2, &Message::default().with_str(1, "rich_text_section").with_message(2, &title));
        top = top.with_message(14, &rich);
        Edit { data: top.encode(), changed }
    }
}

fn text_content(text: &str) -> Message {
    Message::default().with_message(1, &Message::default().with_str(1, text))
}

fn set_content(message: &mut Message, text: &str) {
    if let Some(slot) = message.fields.iter_mut().find(|(n, _)| *n == 12) {
        slot.1 = crate::wire::Value::Bytes(text_content(text).encode());
    }
}

fn parents_of(section: &Section) -> Vec<u8> {
    match (&section.parent, section.parent_style) {
        (Some(parent), Some(style)) => Message::default().with_str(1, parent).with_int(4, style).encode(),
        (Some(parent), None) => Message::default().with_str(1, parent).encode(),
        _ => Vec::new(),
    }
}

/// The single splice turning `old` into `new`, in characters (Automerge text
/// indexes count Unicode scalar values by default).
fn splice<'a>(old: &str, new: &'a str) -> (usize, usize, &'a str) {
    let a: Vec<char> = old.chars().collect();
    let b: Vec<char> = new.chars().collect();
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..].iter().rev().zip(b[prefix..].iter().rev()).take_while(|(x, y)| x == y).count();
    let start_byte = new.char_indices().nth(prefix).map(|(i, _)| i).unwrap_or(new.len());
    let end_byte = new.char_indices().nth(b.len() - suffix).map(|(i, _)| i).unwrap_or(new.len());
    (prefix, a.len() - prefix - suffix, &new[start_byte..end_byte])
}

/// The text of a block's document, without the end mark.
pub fn document_text(bytes: &[u8]) -> Option<(bool, String)> {
    let doc = automerge::Automerge::load(bytes).ok()?;
    let deleted = matches!(doc.get(ROOT, "deleted").ok()??.0, automerge::Value::Scalar(ref s) if s.as_ref() == &automerge::ScalarValue::Boolean(true));
    let (_, text) = doc.get(ROOT, "text").ok()??;
    Some((deleted, doc.text(&text).ok()?.trim_end_matches(END).to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section(id: &str, position: &str, kind: u64, style: u64, text: &str, parent: Option<&str>) -> Section {
        Section {
            id: id.into(),
            sequence: 13000,
            deleted: false,
            position: position.into(),
            kind,
            style,
            text: text.into(),
            parent: parent.map(Into::into),
            parent_style: parent.map(|_| STYLE_BULLET),
        }
    }

    fn canvas() -> Canvas {
        Canvas {
            thread: "eTdthread".into(),
            document: "eTddoc".into(),
            title: "Notes".into(),
            sections: vec![
                section("t", "aaa", TYPE_TITLE, 48, "Notes", None),
                section("h", "aab", TYPE_TEXT, 1, "Heading", None),
                section("p", "aac", TYPE_TEXT, 0, "First line", None),
                section("l", "aad", TYPE_LIST, STYLE_BULLET, "", None),
                section("i1", "aada", TYPE_TEXT, 0, "one", Some("l")),
                section("i2", "aadb", TYPE_TEXT, 0, "two", Some("l")),
            ],
            ..Canvas::default()
        }
    }

    fn session() -> Session {
        Session { id: "0123456789ab".into(), suffix: "cdef0123".into(), now_secs: 1_793_745_813 }
    }

    fn sections_of(edit: &Edit) -> Vec<Message> {
        Message::parse(&edit.data).unwrap().messages(1)
    }

    #[test]
    fn the_canvas_reads_as_markdown() {
        assert_eq!(crate::markdown::to_markdown(&canvas()), "# Heading\n\nFirst line\n\n- one\n- two\n");
    }

    #[test]
    fn an_unchanged_canvas_sends_nothing() {
        let md = crate::markdown::to_markdown(&canvas());
        assert_eq!(plan(&canvas(), &md, &session()).changed, 0);
    }

    #[test]
    fn a_changed_line_is_rewritten_in_place_on_the_opened_text() {
        let edit = plan(&canvas(), "# Heading\n\nFirst line, edited\n\n- one\n- two\n", &session());
        let sections = sections_of(&edit);
        assert_eq!(sections.len(), 1);
        let s = &sections[0];
        assert_eq!(s.string(1).as_deref(), Some("p"));
        assert_eq!(s.int(2), Some(13000));
        let crdt = s.message(38).unwrap();
        assert_eq!((crdt.int(2), crdt.int(3)), (Some(13000), Some(13000)));
        assert_eq!(document_text(crdt.bytes(5).unwrap()), Some((false, "First line, edited".into())));
        let doc = automerge::Automerge::load(crdt.bytes(5).unwrap()).unwrap();
        assert_eq!(doc.get_changes(&[]).len(), 2);
        assert_eq!(crdt.string(12), Some(doc.get_heads()[0].to_string()));
        assert_eq!(doc.get_changes(&[])[0].actor_id().to_hex_string(), "0123456789abcdef0123");
    }

    #[test]
    fn a_new_paragraph_and_a_new_item_get_positions_between_their_neighbours() {
        let edit =
            plan(&canvas(), "# Heading\n\nFirst line\n\nInserted\n\n- one\n- one and a half\n- two\n", &session());
        let sections = sections_of(&edit);
        assert_eq!(sections.len(), 2);
        let para = &sections[0];
        let key = para.string(8).unwrap();
        assert!(key.ends_with(":temp"));
        let key = key.trim_end_matches(":temp");
        assert!("aac" < key && key < "aad", "{key}");
        let item = &sections[1];
        assert_eq!(item.message(13).unwrap().string(1).as_deref(), Some("l"));
        let item_key = item.string(8).unwrap();
        let item_key = item_key.trim_end_matches(":temp");
        assert!("aada" < item_key && item_key < "aadb", "{item_key}");
        assert_eq!(item.string(21).as_deref(), Some(format!("aad-{item_key}:temp").as_str()));
    }

    #[test]
    fn a_removed_line_is_deleted_and_an_emptied_list_goes_with_it() {
        let edit = plan(&canvas(), "# Heading\n\nFirst line\n", &session());
        let sections = sections_of(&edit);
        let deleted: Vec<String> =
            sections.iter().filter(|s| s.int(3) == Some(1)).filter_map(|s| s.string(1)).collect();
        assert_eq!(deleted, ["i1", "i2", "l"]);
        let crdt = sections[0].message(38).unwrap();
        assert_eq!(document_text(crdt.bytes(5).unwrap()).map(|(d, _)| d), Some(true));
    }

    #[test]
    fn a_style_change_keeps_the_section_and_its_text() {
        let edit = plan(&canvas(), "## Heading\n\nFirst line\n\n- one\n- two\n", &session());
        let sections = sections_of(&edit);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].int(10), Some(2));
        assert_eq!(sections[0].message(38).unwrap().string(12), None);
    }

    #[test]
    fn a_new_list_gets_its_container() {
        let edit = plan(&canvas(), "# Heading\n\nFirst line\n\n- one\n- two\n\n1. numbered\n", &session());
        let sections = sections_of(&edit);
        assert_eq!(sections.len(), 2);
        assert_eq!((sections[0].int(9), sections[0].int(10)), (Some(TYPE_LIST), Some(STYLE_NUMBERED)));
        let list = sections[0].string(1).unwrap();
        assert_eq!(sections[1].message(13).unwrap().string(1), Some(list));
    }

    #[test]
    fn an_item_added_at_the_end_follows_the_last_one() {
        let edit = plan(&canvas(), "# Heading\n\nFirst line\n\n- one\n- two\n- three\n", &session());
        let sections = sections_of(&edit);
        assert_eq!(sections.len(), 1);
        let key = sections[0].string(8).unwrap();
        assert!(key.trim_end_matches(":temp") > "aadb", "{key}");
    }

    #[test]
    fn keys_fall_strictly_between() {
        for (lo, hi) in [
            (Some("aab"), Some("aac")),
            (None, Some("aab")),
            (Some("aabz"), Some("aac")),
            (Some("zz"), None),
            (Some("aah"), None),
        ] {
            let k = between(lo, hi);
            assert!(lo.is_none_or(|l| l < k.as_str()) && hi.is_none_or(|h| k.as_str() < h), "{lo:?} {k} {hi:?}");
        }
        assert_eq!(between(Some("aah"), None), "aai");
    }
}
