//! Message bodies as blocks of Pango markup. The server pre-parses every
//! message into `md` (@rocket.chat/message-parser's tree); old messages lack
//! it and fall back to plain text. Unknown node types show their text rather
//! than disappear.

use serde_json::Value;

use crate::emoji;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    Paragraph(String),
    Heading {
        level: u8,
        markup: String,
    },
    Quote(Vec<Block>),
    Code(String),
    /// (marker, markup) per item: `•`, `3.`, `☐`/`☑`.
    List(Vec<(String, String)>),
    BigEmoji(String),
    Break,
}

pub struct Context<'a> {
    /// The signed-in username: mentions of it are highlighted.
    pub me: &'a str,
}

pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// Plain text of any node, recursively: the last-resort rendering.
pub fn text_of(node: &Value) -> String {
    match node {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(text_of).collect(),
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("EMOJI") {
                return emoji_text(node);
            }
            if let Some(u) = o.get("unicode").and_then(Value::as_str) {
                return u.to_owned();
            }
            let by_value = o.get("value").map(text_of).unwrap_or_default();
            if !by_value.is_empty() {
                return by_value;
            }
            // TIMESTAMP and friends: `value` is opaque, `fallback` is a Plain node.
            o.get("fallback").map(text_of).unwrap_or_default()
        }
        _ => String::new(),
    }
}

/// Brackets a shortcode with no Unicode glyph: a custom emoji, which the
/// view draws as an image, or shows as `:code:` when the server has none.
pub const CUSTOM_MARK: char = '\u{FFFC}';

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece<'a> {
    Markup(&'a str),
    Custom(&'a str),
}

/// Markup and the custom emoji between its marks, in order.
/// The link at byte `at` of the text `markup` displays (tags gone, entities
/// resolved): what a label shows under the pointer.
pub fn link_at(markup: &str, at: usize) -> Option<String> {
    let (mut shown, mut href, mut rest) = (0usize, None::<String>, markup);
    while let Some(c) = rest.chars().next() {
        if c == '<' {
            let end = rest.find('>')?;
            let tag = &rest[1..end];
            if let Some(attrs) = tag.strip_prefix("a ") {
                href = attrs.split_once("href=\"").and_then(|(_, v)| v.split_once('"')).map(|(v, _)| unescape(v));
            } else if tag == "/a" {
                href = None;
            }
            rest = &rest[end + 1..];
            continue;
        }
        let (width, len) = match c {
            '&' => {
                let end = rest.find(';').unwrap_or(0);
                (unescape(&rest[..=end]).len(), end + 1)
            }
            _ => (c.len_utf8(), c.len_utf8()),
        };
        if at < shown + width {
            return href;
        }
        shown += width;
        rest = &rest[len..];
    }
    None
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
}

pub fn pieces(markup: &str) -> Vec<Piece<'_>> {
    markup
        .split(CUSTOM_MARK)
        .enumerate()
        .filter(|(_, s)| !s.is_empty())
        .map(|(i, s)| if i % 2 == 1 { Piece::Custom(s) } else { Piece::Markup(s) })
        .collect()
}

/// The markup with custom emoji as plain `:code:`.
pub fn without_custom(markup: &str) -> String {
    pieces(markup)
        .into_iter()
        .map(|p| match p {
            Piece::Markup(m) => m.to_owned(),
            Piece::Custom(code) => format!(":{code}:"),
        })
        .collect()
}

fn emoji_text(node: &Value) -> String {
    if let Some(u) = node.get("unicode").and_then(Value::as_str) {
        return u.to_owned();
    }
    match node.pointer("/shortCode").and_then(Value::as_str) {
        Some(code) => emoji::unicode(code).map_or_else(|| format!("{CUSTOM_MARK}{code}{CUSTOM_MARK}"), str::to_owned),
        None => text_of(node.get("value").unwrap_or(&Value::Null)),
    }
}

fn is_emoji(node: &Value) -> bool {
    node.get("type").and_then(Value::as_str) == Some("EMOJI")
        && (node.get("unicode").is_some()
            || node.get("shortCode").and_then(Value::as_str).and_then(emoji::unicode).is_some())
}

fn safe_href(url: &str) -> Option<&str> {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")).then_some(url)
}

fn inline(node: &Value, ctx: &Context) -> String {
    let kind = node.get("type").and_then(Value::as_str).unwrap_or_default();
    let value = node.get("value").unwrap_or(&Value::Null);
    let inner = |v: &Value| match v {
        Value::Array(items) => items.iter().map(|n| inline(n, ctx)).collect::<String>(),
        other => inline(other, ctx),
    };
    match kind {
        "PLAIN_TEXT" => escape(value.as_str().unwrap_or_default()),
        "BOLD" => format!("<b>{}</b>", inner(value)),
        "ITALIC" => format!("<i>{}</i>", inner(value)),
        "STRIKE" => format!("<span strikethrough=\"true\">{}</span>", inner(value)),
        "INLINE_CODE" => {
            format!("<span font_family=\"monospace\" background=\"#1E1B33\">{}</span>", escape(&text_of(value)))
        }
        "LINK" => {
            let src = text_of(value.get("src").unwrap_or(&Value::Null));
            let label = value.get("label").map(inner).filter(|l| !l.trim().is_empty()).unwrap_or_else(|| escape(&src));
            match safe_href(&src) {
                Some(href) => format!("<a href=\"{}\">{label}</a>", escape(href)),
                None => label,
            }
        }
        "MENTION_USER" => {
            let name = text_of(value);
            let mine = name == ctx.me || name == "all" || name == "here";
            let background = if mine { " background=\"#4A2140\"" } else { "" };
            let span = format!("<span foreground=\"#FF7AB4\" weight=\"bold\"{background}>@{}</span>", escape(&name));
            if name == "all" || name == "here" {
                span
            } else {
                format!("<a href=\"rv-user:{}\">{span}</a>", escape(&name))
            }
        }
        "MENTION_CHANNEL" => {
            let name = escape(&text_of(value));
            format!("<a href=\"rv-room:{name}\"><span foreground=\"#A78BFA\" weight=\"bold\">#{name}</span></a>")
        }
        "EMOJI" => escape(&emoji_text(node)),
        _ => escape(&text_of(node)),
    }
}

fn inlines(items: &Value, ctx: &Context) -> String {
    match items {
        Value::Array(nodes) => nodes.iter().map(|n| inline(n, ctx)).collect(),
        other => inline(other, ctx),
    }
}

fn items(node: &Value) -> &[Value] {
    node.get("value").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn block(node: &Value, ctx: &Context) -> Block {
    let kind = node.get("type").and_then(Value::as_str).unwrap_or_default();
    let value = node.get("value").unwrap_or(&Value::Null);
    match kind {
        "PARAGRAPH" => Block::Paragraph(inlines(value, ctx)),
        "HEADING" => Block::Heading {
            level: node.get("level").and_then(Value::as_u64).unwrap_or(1).clamp(1, 4) as u8,
            markup: inlines(value, ctx),
        },
        "QUOTE" => Block::Quote(items(node).iter().map(|b| block(b, ctx)).collect()),
        "CODE" => Block::Code(items(node).iter().map(text_of).collect::<Vec<_>>().join("\n")),
        "UNORDERED_LIST" => Block::List(
            items(node)
                .iter()
                .map(|i| ("•".to_owned(), inlines(i.get("value").unwrap_or(&Value::Null), ctx)))
                .collect(),
        ),
        "ORDERED_LIST" => Block::List(
            items(node)
                .iter()
                .enumerate()
                .map(|(n, i)| {
                    let number = i.get("number").and_then(Value::as_u64).unwrap_or(n as u64 + 1);
                    (format!("{number}."), inlines(i.get("value").unwrap_or(&Value::Null), ctx))
                })
                .collect(),
        ),
        "TASKS" => Block::List(
            items(node)
                .iter()
                .map(|t| {
                    let done = t.get("status").and_then(Value::as_bool) == Some(true);
                    ((if done { "☑" } else { "☐" }).to_owned(), inlines(t.get("value").unwrap_or(&Value::Null), ctx))
                })
                .collect(),
        ),
        "BIG_EMOJI" if items(node).iter().all(is_emoji) && !items(node).is_empty() => {
            Block::BigEmoji(items(node).iter().map(emoji_text).collect::<Vec<_>>().join(" "))
        }
        "BIG_EMOJI" => Block::Paragraph(escape(&items(node).iter().map(text_of).collect::<Vec<_>>().join(" "))),
        "LINE_BREAK" => Block::Break,
        _ => Block::Paragraph(escape(&text_of(node))),
    }
}

/// A quote's permalink (`[ ](…?msg=…)`) is dropped from the body: the quoted
/// message renders apart, as an attachment.
fn is_quote_link(node: &Value) -> bool {
    node.get("type").and_then(Value::as_str) == Some("LINK")
        && {
            let src = text_of(node.pointer("/value/src").unwrap_or(&Value::Null));
            src.contains("?msg=") || src.contains("&msg=")
        }
        && text_of(node.pointer("/value/label").unwrap_or(&Value::Null)).trim().is_empty()
}

fn without_quote_links(tree: Vec<Value>) -> Vec<Value> {
    tree.into_iter()
        .filter_map(|mut block| {
            let is_paragraph = block.get("type").and_then(Value::as_str) == Some("PARAGRAPH");
            let Some(nodes) = block.get_mut("value").and_then(Value::as_array_mut).filter(|_| is_paragraph) else {
                return Some(block);
            };
            if !nodes.iter().any(is_quote_link) {
                return Some(block);
            }
            nodes.retain(|n| !is_quote_link(n));
            if let Some(first) = nodes.first_mut()
                && first.get("type").and_then(Value::as_str) == Some("PLAIN_TEXT")
            {
                let trimmed = first.get("value").and_then(Value::as_str).unwrap_or_default().trim_start().to_owned();
                if trimmed.is_empty() {
                    nodes.remove(0);
                } else {
                    first["value"] = Value::String(trimmed);
                }
            }
            (!nodes.is_empty()).then_some(block)
        })
        .collect()
}

fn plausible(tree: &[Value]) -> bool {
    !tree.is_empty() && tree.iter().all(|n| n.get("type").and_then(Value::as_str).is_some())
}

/// Blocks of a message: its `md` tree when it holds up, else its text.
pub fn render(md: Option<&str>, text: Option<&str>, ctx: &Context) -> Vec<Block> {
    if let Some(tree) = md.and_then(|m| serde_json::from_str::<Vec<Value>>(m).ok()).filter(|t| plausible(t)) {
        return without_quote_links(tree).iter().map(|b| block(b, ctx)).collect();
    }
    match text.filter(|t| !t.trim().is_empty()) {
        Some(t) => vec![Block::Paragraph(escape(t))],
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_emoji_are_marked() {
        let md = json!([{"type":"PARAGRAPH","value":[{"type":"PLAIN_TEXT","value":"a "},
            {"type":"EMOJI","value":{"type":"PLAIN_TEXT","value":"vibe"},"shortCode":"vibe"},
            {"type":"EMOJI","value":{"type":"PLAIN_TEXT","value":"smile"},"shortCode":"smile"}]}]);
        let Block::Paragraph(markup) = &one(md)[0] else { panic!() };
        assert_eq!(pieces(markup), [Piece::Markup("a "), Piece::Custom("vibe"), Piece::Markup("😄")]);
        assert_eq!(without_custom(markup), "a :vibe:😄");
    }
    use serde_json::json;

    const CTX: Context = Context { me: "alice" };

    fn one(md: Value) -> Vec<Block> {
        render(Some(&md.to_string()), None, &CTX)
    }

    fn plain(s: &str) -> Value {
        json!({"type": "PLAIN_TEXT", "value": s})
    }

    #[test]
    fn inline_styles_escape_text() {
        let md = json!([{"type": "PARAGRAPH", "value": [
            plain("a <b> & "),
            {"type": "BOLD", "value": [plain("bold")]},
            {"type": "ITALIC", "value": [plain("it")]},
            {"type": "STRIKE", "value": [plain("x")]},
            {"type": "INLINE_CODE", "value": plain("<code>")},
        ]}]);
        assert_eq!(
            one(md),
            [Block::Paragraph(
                "a &lt;b&gt; &amp; <b>bold</b><i>it</i><span strikethrough=\"true\">x</span>\
                 <span font_family=\"monospace\" background=\"#1E1B33\">&lt;code&gt;</span>"
                    .into()
            )]
        );
    }

    #[test]
    fn links_keep_safe_schemes_only() {
        let link = |src: &str| json!({"type": "LINK", "value": {"src": plain(src), "label": [plain("here")]}});
        let md =
            json!([{"type": "PARAGRAPH", "value": [link("https://ex.org/?a=1&b=2"), link("javascript:alert(1)")]}]);
        assert_eq!(one(md), [Block::Paragraph("<a href=\"https://ex.org/?a=1&amp;b=2\">here</a>here".into())]);
    }

    #[test]
    fn mentions_of_me_are_highlighted() {
        let mention = |u: &str| json!({"type": "MENTION_USER", "value": plain(u)});
        let Block::Paragraph(markup) =
            &one(json!([{"type": "PARAGRAPH", "value": [mention("bob"), mention("alice")]}]))[0]
        else {
            panic!()
        };
        assert!(markup.contains(">@bob</span>") && !markup.split("@bob").next().unwrap().contains("background"));
        assert!(markup.contains("background=\"#4A2140\">@alice</span>"));
        assert!(markup.contains("<a href=\"rv-user:bob\">"));
    }

    #[test]
    fn emojis_resolve_or_stay_literal() {
        let md = json!([{"type": "PARAGRAPH", "value": [
            {"type": "EMOJI", "shortCode": "smile", "value": plain("smile")},
            {"type": "EMOJI", "shortCode": "party_parrot", "value": plain("party_parrot")},
            {"type": "EMOJI", "unicode": "🎉"},
        ]}]);
        let Block::Paragraph(markup) = &one(md)[0] else { panic!() };
        assert_eq!(without_custom(markup), "😄:party_parrot:🎉");
    }

    #[test]
    fn big_emoji_only_when_all_resolve() {
        let e = |c: &str| json!({"type": "EMOJI", "shortCode": c, "value": plain(c)});
        assert_eq!(
            one(json!([{"type": "BIG_EMOJI", "value": [e("smile"), e("tada")]}])),
            [Block::BigEmoji("😄 🎉".into())]
        );
        let blocks = one(json!([{"type": "BIG_EMOJI", "value": [e("custom_one")]}]));
        let [Block::Paragraph(markup)] = &blocks[..] else { panic!("{blocks:?}") };
        assert_eq!(without_custom(markup), ":custom_one:");
    }

    #[test]
    fn blocks() {
        let md = json!([
            {"type": "HEADING", "level": 2, "value": [plain("Title")]},
            {"type": "QUOTE", "value": [{"type": "PARAGRAPH", "value": [plain("quoted")]}]},
            {"type": "CODE", "language": "rust", "value": [
                {"type": "CODE_LINE", "value": plain("fn main() {")},
                {"type": "CODE_LINE", "value": plain("}")},
            ]},
            {"type": "ORDERED_LIST", "value": [{"type": "LIST_ITEM", "number": 3, "value": [plain("three")]}]},
            {"type": "UNORDERED_LIST", "value": [{"type": "LIST_ITEM", "value": [plain("dot")]}]},
            {"type": "TASKS", "value": [{"type": "TASK", "status": true, "value": [plain("done")]}]},
            {"type": "LINE_BREAK", "value": null},
            {"type": "KATEX", "value": "x^2"},
        ]);
        assert_eq!(
            one(md),
            [
                Block::Heading { level: 2, markup: "Title".into() },
                Block::Quote(vec![Block::Paragraph("quoted".into())]),
                Block::Code("fn main() {\n}".into()),
                Block::List(vec![("3.".into(), "three".into())]),
                Block::List(vec![("•".into(), "dot".into())]),
                Block::List(vec![("☑".into(), "done".into())]),
                Block::Break,
                Block::Paragraph("x^2".into()),
            ]
        );
    }

    #[test]
    fn quote_permalinks_are_dropped() {
        let md = json!([{"type": "PARAGRAPH", "value": [
            {"type": "LINK", "value": {"src": plain("https://chat.ex/channel/g?msg=abc"), "label": [plain(" ")]}},
            plain(" my answer"),
        ]}]);
        assert_eq!(one(md), [Block::Paragraph("my answer".into())]);
        let only = json!([{"type": "PARAGRAPH", "value": [
            {"type": "LINK", "value": {"src": plain("https://chat.ex/channel/g?msg=abc"), "label": [plain(" ")]}},
        ]}]);
        assert!(one(only).is_empty());
    }

    #[test]
    fn falls_back_on_text() {
        assert_eq!(render(None, Some("a <b>"), &CTX), [Block::Paragraph("a &lt;b&gt;".into())]);
        assert_eq!(render(Some("[null]"), Some("t"), &CTX), [Block::Paragraph("t".into())]);
        assert_eq!(render(Some("not json"), Some("t"), &CTX), [Block::Paragraph("t".into())]);
        assert!(render(None, Some("  "), &CTX).is_empty());
    }

    #[test]
    fn link_at_maps_shown_text_back_to_its_link() {
        let markup = "Hey <a href=\"rv-user:bob\"><b>@bob</b></a> &amp; <a href=\"rv-room:x&amp;y\">#x&amp;y</a>";
        let shown = "Hey @bob & #x&y";
        assert_eq!(link_at(markup, shown.find('@').unwrap()), Some("rv-user:bob".into()));
        assert_eq!(link_at(markup, shown.find('b').unwrap() + 2), Some("rv-user:bob".into()));
        assert_eq!(link_at(markup, 0), None);
        assert_eq!(link_at(markup, shown.find(" & ").unwrap() + 1), None);
        assert_eq!(link_at(markup, shown.len() - 1), Some("rv-room:x&y".into()));
        assert_eq!(link_at(markup, shown.len()), None);
    }
}
