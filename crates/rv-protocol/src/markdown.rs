//! Bounded native presentation with CommonMark structure and the existing
//! composers' *bold*, _italic_, ~strike~ conventions. No Rocket.Chat md format.
//! HTML and images remain literal text; renderers never fetch a Markdown image
//! using session credentials. Mentions use the same source rules as notification
//! extraction, including escapes and exclusion of quotes, code and link labels.
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const MAX_DEPTH: usize = 32;
const MAX_EVENTS: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    Native1,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct Document {
    pub format: Format,
    pub nodes: Vec<Node>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Node {
    Text {
        text: String,
    },
    Paragraph {
        children: Vec<Node>,
    },
    Bold {
        children: Vec<Node>,
    },
    Italic {
        children: Vec<Node>,
    },
    Strike {
        children: Vec<Node>,
    },
    InlineCode {
        text: String,
    },
    CodeBlock {
        text: String,
        language: String,
    },
    Heading {
        level: u8,
        children: Vec<Node>,
    },
    Quote {
        children: Vec<Node>,
    },
    List {
        start: Option<u32>,
        children: Vec<Node>,
    },
    ListItem {
        checked: Option<bool>,
        children: Vec<Node>,
    },
    Link {
        href: String,
        children: Vec<Node>,
    },
    Mention {
        name: String,
    },
    RoomMention {
        name: String,
    },
    Emoji {
        shortcode: String,
    },
    Break,
    Rule,
}
impl Node {
    fn children_mut(&mut self) -> Option<&mut Vec<Node>> {
        match self {
            Self::Paragraph { children }
            | Self::Bold { children }
            | Self::Italic { children }
            | Self::Strike { children }
            | Self::Heading { children, .. }
            | Self::Quote { children }
            | Self::List { children, .. }
            | Self::ListItem { children, .. }
            | Self::Link { children, .. } => Some(children),
            _ => None,
        }
    }
}
fn text(value: &str) -> Node {
    Node::Text { text: value.into() }
}
fn plain(source: &str) -> Document {
    Document {
        format: Format::Native1,
        nodes: vec![Node::Paragraph {
            children: vec![text(source)],
        }],
    }
}
struct Frame {
    node: Node,
    excluded: bool,
    image: Option<String>,
}
fn append(stack: &mut [Frame], root: &mut Vec<Node>, node: Node) {
    if let Some(frame) = stack.last_mut() {
        if let Node::CodeBlock { text: code, .. } = &mut frame.node {
            if let Node::Text { text } = node {
                code.push_str(&text);
            }
        } else if let Some(children) = frame.node.children_mut() {
            children.push(node);
        }
    } else {
        root.push(node);
    }
}
fn literal(node: &Node) -> String {
    match node {
        Node::Text { text } | Node::InlineCode { text } | Node::CodeBlock { text, .. } => {
            text.clone()
        }
        Node::Mention { name } => format!("@{name}"),
        Node::RoomMention { name } => format!("#{name}"),
        Node::Emoji { shortcode } => format!(":{shortcode}:"),
        Node::Break => "\n".into(),
        Node::Rule => "---".into(),
        Node::Paragraph { children }
        | Node::Bold { children }
        | Node::Italic { children }
        | Node::Strike { children }
        | Node::Heading { children, .. }
        | Node::Quote { children }
        | Node::List { children, .. }
        | Node::ListItem { children, .. }
        | Node::Link { children, .. } => children.iter().map(literal).collect(),
    }
}
fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-')
}
fn boundary(c: char) -> bool {
    !c.is_alphanumeric() && !matches!(c, '_' | '-' | '.' | '@' | '/' | '\\')
}
fn escaped(source: &str, at: usize) -> bool {
    source.as_bytes()[..at]
        .iter()
        .rev()
        .take_while(|&&b| b == b'\\')
        .count()
        % 2
        == 1
}
fn tokens(source: &str, span: std::ops::Range<usize>, value: &str, mentions: bool) -> Vec<Node> {
    // Entities and parser-normalized text may lose their source offsets. Keep
    // those runs literal rather than resolve a shorter or escaped account name.
    if &source[span.clone()] != value {
        return vec![text(value)];
    }
    let chars: Vec<_> = value.char_indices().collect();
    let mut out = vec![];
    let (mut i, mut consumed) = (0, 0);
    while i < chars.len() {
        let at = chars[i].0;
        let at_boundary = i == 0 || boundary(chars[i - 1].1);
        let prefix: String = chars[i..chars.len().min(i + 8)]
            .iter()
            .map(|c| c.1)
            .collect::<String>()
            .to_ascii_lowercase();
        if at_boundary
            && ["https://", "http://", "ftp://", "mailto:", "www."]
                .iter()
                .any(|p| prefix.starts_with(p))
        {
            while i < chars.len() && !chars[i].1.is_whitespace() {
                i += 1;
            }
            // Bare HTTP links get a safe, literal label, never mention nodes.
            if mentions && (prefix.starts_with("http://") || prefix.starts_with("https://")) {
                let mut end = chars.get(i).map_or(value.len(), |c| c.0);
                while end > at
                    && matches!(
                        value.as_bytes()[end - 1],
                        b'.' | b',' | b';' | b'!' | b'?' | b')'
                    )
                {
                    end -= 1;
                }
                if consumed < at {
                    out.push(text(&value[consumed..at]));
                }
                let href = &value[at..end];
                out.push(Node::Link {
                    href: href.into(),
                    children: vec![text(href)],
                });
                consumed = end;
            }
            continue;
        }
        let c = chars[i].1;
        if mentions && matches!(c, '@' | '#') && at_boundary {
            let start = i + 1;
            i = start;
            while i < chars.len() && name_char(chars[i].1) {
                i += 1;
            }
            let end = chars.get(i).map_or(value.len(), |c| c.0);
            let dotted = chars.get(i).is_some_and(|c| c.1 == '.')
                && chars.get(i + 1).is_some_and(|c| c.1.is_alphanumeric());
            let suffix = chars.get(i).is_some_and(|c| c.1.is_alphanumeric());
            let tail = &source[span.start + end..];
            let encoded = tail.starts_with('&')
                && tail
                    .chars()
                    .take(34)
                    .take_while(|&c| c != ' ' && c != '\n')
                    .any(|c| c == ';');
            if !escaped(source, span.start + at)
                && i > start
                && i - start <= 128
                && !dotted
                && !suffix
                && !encoded
            {
                if consumed < at {
                    out.push(text(&value[consumed..at]));
                }
                let name = value[chars[start].0..end].into();
                out.push(if c == '@' {
                    Node::Mention { name }
                } else {
                    Node::RoomMention { name }
                });
                consumed = end;
            }
            continue;
        }
        if c == ':' && !escaped(source, span.start + at) {
            let start = i + 1;
            let mut end = start;
            while end < chars.len()
                && (chars[end].1.is_ascii_alphanumeric() || matches!(chars[end].1, '_' | '+' | '-'))
            {
                end += 1;
            }
            if end > start && end - start <= 80 && chars.get(end).is_some_and(|c| c.1 == ':') {
                if consumed < at {
                    out.push(text(&value[consumed..at]));
                }
                out.push(Node::Emoji {
                    shortcode: value[chars[start].0..chars[end].0].into(),
                });
                consumed = chars[end].0 + 1;
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    if consumed < value.len() {
        out.push(text(&value[consumed..]));
    }
    out
}

/// CommonMark structure, existing composer styles and task lists. Exhaustion preserves
/// the entire source as plain text; it never truncates or drops a message.
pub fn parse(source: &str) -> Document {
    if source.len() > 32_768 {
        return plain(source);
    }
    let mut root = vec![];
    let mut stack: Vec<Frame> = vec![];
    let options = Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    for (count, (event, span)) in Parser::new_ext(source, options)
        .into_offset_iter()
        .enumerate()
    {
        if count >= MAX_EVENTS {
            return plain(source);
        }
        match event {
            Event::Start(tag) => {
                if stack.len() >= MAX_DEPTH {
                    return plain(source);
                }
                let inherited = stack.last().is_some_and(|f| f.excluded);
                let excluded = inherited
                    || matches!(
                        tag,
                        Tag::CodeBlock(_)
                            | Tag::BlockQuote(_)
                            | Tag::Link { .. }
                            | Tag::Image { .. }
                            | Tag::HtmlBlock
                    );
                let mut image = None;
                let node = match tag {
                    Tag::Paragraph | Tag::HtmlBlock => Node::Paragraph { children: vec![] },
                    Tag::Heading { level, .. } => Node::Heading {
                        level: level as u8,
                        children: vec![],
                    },
                    Tag::BlockQuote(_) => Node::Quote { children: vec![] },
                    Tag::CodeBlock(kind) => Node::CodeBlock {
                        text: String::new(),
                        language: match kind {
                            CodeBlockKind::Fenced(language) => language.into_string(),
                            CodeBlockKind::Indented => String::new(),
                        },
                    },
                    Tag::List(start) => Node::List {
                        start: start.map(|s| s as u32),
                        children: vec![],
                    },
                    Tag::Item => Node::ListItem {
                        checked: None,
                        children: vec![],
                    },
                    Tag::Emphasis | Tag::Strong => {
                        if source.as_bytes().get(span.start) == Some(&b'_') {
                            Node::Italic { children: vec![] }
                        } else {
                            Node::Bold { children: vec![] }
                        }
                    }
                    Tag::Strikethrough => Node::Strike { children: vec![] },
                    Tag::Link { dest_url, .. } => Node::Link {
                        href: dest_url.into_string(),
                        children: vec![],
                    },
                    Tag::Image { dest_url, .. } => {
                        image = Some(dest_url.into_string());
                        Node::Paragraph { children: vec![] }
                    }
                    _ => Node::Paragraph { children: vec![] },
                };
                stack.push(Frame {
                    node,
                    excluded,
                    image,
                });
            }
            Event::End(_) => {
                let Some(frame) = stack.pop() else {
                    return plain(source);
                };
                let node = if let Some(href) = frame.image {
                    text(&format!("![{}]({href})", literal(&frame.node)))
                } else {
                    frame.node
                };
                append(&mut stack, &mut root, node);
            }
            Event::Text(value) => {
                if stack
                    .last()
                    .is_some_and(|f| matches!(f.node, Node::CodeBlock { .. }))
                {
                    append(&mut stack, &mut root, text(&value));
                } else {
                    let allowed = !stack.last().is_some_and(|f| f.excluded);
                    for node in tokens(source, span, &value, allowed) {
                        append(&mut stack, &mut root, node);
                    }
                }
            }
            Event::Code(value) => append(
                &mut stack,
                &mut root,
                Node::InlineCode {
                    text: value.into_string(),
                },
            ),
            Event::Html(value) | Event::InlineHtml(value) => {
                append(&mut stack, &mut root, text(&value))
            }
            Event::SoftBreak | Event::HardBreak => append(&mut stack, &mut root, Node::Break),
            Event::Rule => append(&mut stack, &mut root, Node::Rule),
            Event::TaskListMarker(checked) => {
                if let Some(frame) = stack
                    .iter_mut()
                    .rev()
                    .find(|f| matches!(f.node, Node::ListItem { .. }))
                    && let Node::ListItem { checked: old, .. } = &mut frame.node
                {
                    *old = Some(checked);
                }
            }
            _ => (),
        }
    }
    Document {
        format: Format::Native1,
        nodes: root,
    }
}

pub fn mention_names(source: &str) -> BTreeSet<String> {
    fn collect(nodes: &[Node], names: &mut BTreeSet<String>) {
        for node in nodes {
            match node {
                Node::Mention { name } => {
                    names.insert(name.clone());
                }
                Node::Paragraph { children }
                | Node::Bold { children }
                | Node::Italic { children }
                | Node::Strike { children }
                | Node::Heading { children, .. }
                | Node::List { children, .. }
                | Node::ListItem { children, .. } => collect(children, names),
                _ => (),
            }
        }
    }
    let mut names = BTreeSet::new();
    collect(&parse(source).nodes, &mut names);
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exhausting_depth_or_events_keeps_the_complete_source_literal() {
        for source in [format!("{}deep", "> ".repeat(40)), "x **y** ".repeat(2000)] {
            assert_eq!(parse(&source), plain(&source));
            assert!(mention_names(&source).is_empty());
        }
    }
    #[test]
    fn each_occurrence_keeps_its_source_context_even_with_the_same_name() {
        let document = parse("@alice\n\n> @alice\n\n[@alice](https://a.test)\n\n\\@alice");
        fn count(nodes: &[Node]) -> usize {
            nodes
                .iter()
                .map(|node| match node {
                    Node::Mention { .. } => 1,
                    Node::Paragraph { children }
                    | Node::Bold { children }
                    | Node::Italic { children }
                    | Node::Strike { children }
                    | Node::Heading { children, .. }
                    | Node::Quote { children }
                    | Node::List { children, .. }
                    | Node::ListItem { children, .. }
                    | Node::Link { children, .. } => count(children),
                    _ => 0,
                })
                .sum()
        }
        assert_eq!(count(&document.nodes), 1);
    }
    #[test]
    fn dense_legal_source_remains_smaller_than_a_sync_page() {
        for source in ["@a ".repeat(8192), ":x:".repeat(10_922)] {
            assert!(source.len() <= 32_768);
            assert!(serde_json::to_vec(&parse(&source)).unwrap().len() < 512 * 1024);
        }
    }
}
