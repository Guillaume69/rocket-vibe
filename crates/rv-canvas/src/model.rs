//! A canvas as Quip's `load-data` describes it: a thread, a document and its
//! sections, each one block of text, a list container or the title.

use crate::inline::{Run, from_html, literal, plain};
use crate::wire::{Malformed, Message};

pub const TYPE_TEXT: u64 = 0;
pub const TYPE_LIST: u64 = 1;
pub const TYPE_TITLE: u64 = 64;

pub const STYLE_PLAIN: u64 = 0;
pub const STYLE_CODE: u64 = 4;
pub const STYLE_BULLET: u64 = 5;
pub const STYLE_NUMBERED: u64 = 6;
pub const STYLE_CHECKLIST: u64 = 7;
pub const STYLE_QUOTE: u64 = 16;
/// Heading levels 1 to 6, in Quip's numbering.
pub const STYLE_HEADINGS: [u64; 6] = [1, 2, 3, 39, 40, 41];

#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    pub id: String,
    pub sequence: u64,
    pub deleted: bool,
    pub position: String,
    pub kind: u64,
    pub style: u64,
    pub text: String,
    pub parent: Option<String>,
    pub parent_style: Option<u64>,
    pub checked: bool,
}

impl Section {
    /// The block's text and formatting; a code block's text is taken as it is.
    pub fn runs(&self) -> Vec<Run> {
        if self.style == STYLE_CODE { literal(&plain(&from_html(&self.text))) } else { from_html(&self.text) }
    }

    pub fn parse(message: &Message) -> Option<Section> {
        let id = message.string(1)?;
        let content = message.message(12);
        let text = content
            .as_ref()
            .and_then(|c| c.message(1))
            .and_then(|t| t.string(1))
            .or_else(|| content.as_ref().and_then(|c| c.message(58)).and_then(|t| t.string(1)))
            .unwrap_or_default();
        let parents = message.message(13);
        Some(Section {
            id,
            sequence: message.int(2).unwrap_or(0),
            deleted: message.int(3).unwrap_or(0) != 0,
            position: message.string(8).unwrap_or_default(),
            kind: message.int(9).unwrap_or(TYPE_TEXT),
            style: message.int(10).unwrap_or(STYLE_PLAIN),
            text,
            parent: parents.as_ref().and_then(|p| p.string(1)).filter(|p| !p.is_empty()),
            parent_style: parents.as_ref().and_then(|p| p.int(4)),
            checked: message.message(16).and_then(|a| a.int(2)) == Some(1),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Canvas {
    pub thread: String,
    pub thread_sequence: u64,
    pub document: String,
    pub document_sequence: u64,
    pub version: u64,
    pub title: String,
    pub sections: Vec<Section>,
}

impl Canvas {
    /// From a `load-data` answer (`syncer.LoadData.ResponseWrapper`: `2` the
    /// response, its `2` the data).
    pub fn from_load_data(bytes: &[u8]) -> Result<Canvas, Malformed> {
        let top = Message::parse(bytes)?;
        let data = top.message(2).and_then(|r| r.message(2)).ok_or(Malformed)?;
        Self::from_data(&data)
    }

    fn from_data(data: &Message) -> Result<Canvas, Malformed> {
        let thread = data.message(3).ok_or(Malformed)?;
        let document = data.message(6).ok_or(Malformed)?;
        let sections: Vec<Section> = data.messages(7).iter().filter_map(Section::parse).collect();
        let title = sections.iter().find(|s| s.kind == TYPE_TITLE).map(|s| s.text.clone()).unwrap_or_default();
        Ok(Canvas {
            thread: thread.string(1).ok_or(Malformed)?,
            thread_sequence: thread.int(2).unwrap_or(0),
            document: document.string(1).ok_or(Malformed)?,
            document_sequence: document.int(2).unwrap_or(0),
            version: document.int(48).unwrap_or(0),
            title,
            sections,
        })
    }

    /// The live blocks in reading order: text blocks and list containers by
    /// position, each container followed by its items.
    pub fn blocks(&self) -> Vec<Block<'_>> {
        let live = |s: &&Section| {
            !s.deleted && matches!(s.kind, TYPE_TEXT | TYPE_LIST) && (s.kind == TYPE_LIST || !s.text.trim().is_empty())
        };
        let mut top: Vec<&Section> = self.sections.iter().filter(live).filter(|s| s.parent.is_none()).collect();
        top.sort_by(|a, b| a.position.cmp(&b.position));
        let mut out = Vec::new();
        for section in top {
            if section.kind == TYPE_LIST {
                let mut items: Vec<&Section> = self
                    .sections
                    .iter()
                    .filter(live)
                    .filter(|s| s.parent.as_deref() == Some(section.id.as_str()))
                    .collect();
                items.sort_by(|a, b| a.position.cmp(&b.position));
                for item in items {
                    out.push(Block::Item { list: section, item });
                }
            } else {
                out.push(Block::Text(section));
            }
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Block<'a> {
    Text(&'a Section),
    Item { list: &'a Section, item: &'a Section },
}
