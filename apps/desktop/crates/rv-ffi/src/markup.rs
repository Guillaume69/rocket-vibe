//! rv-core renders message bodies as Pango markup for GTK. Swift gets the
//! same bodies as styled runs, so it never parses markup.

use rv_core::markdown::{self, Block};

#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct Run {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub code: bool,
    /// `https:`, `mailto:`, `rv-user:<username>` or `rv-room:<name>`.
    pub link: Option<String>,
    pub mention: bool,
    /// A mention of me, `@all` or `@here`.
    pub highlight: bool,
    /// A server emoji with no Unicode glyph, by shortcode: `text` holds `:code:`.
    pub custom_emoji: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ListItem {
    pub marker: String,
    pub runs: Vec<Run>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum BodyBlock {
    Paragraph { runs: Vec<Run> },
    Heading { level: u8, runs: Vec<Run> },
    Quote { blocks: Vec<BodyBlock> },
    Code { text: String },
    List { items: Vec<ListItem> },
    BigEmoji { runs: Vec<Run> },
    Break,
}

pub fn blocks(rendered: Vec<Block>) -> Vec<BodyBlock> {
    rendered
        .into_iter()
        .map(|b| match b {
            Block::Paragraph(m) => BodyBlock::Paragraph { runs: runs(&m) },
            Block::Heading { level, markup } => BodyBlock::Heading { level, runs: runs(&markup) },
            Block::Quote(inner) => BodyBlock::Quote { blocks: blocks(inner) },
            Block::Code(text) => BodyBlock::Code { text },
            Block::List(items) => BodyBlock::List {
                items: items.into_iter().map(|(marker, m)| ListItem { marker, runs: runs(&m) }).collect(),
            },
            Block::BigEmoji(m) => BodyBlock::BigEmoji { runs: runs(&m) },
            Block::Break => BodyBlock::Break,
        })
        .collect()
}

pub fn runs(markup: &str) -> Vec<Run> {
    let mut out = Vec::new();
    for piece in markdown::pieces(markup) {
        match piece {
            markdown::Piece::Markup(m) => parse(m, &mut out),
            markdown::Piece::Custom(code) => {
                out.push(Run { text: format!(":{code}:"), custom_emoji: Some(code.to_owned()), ..Default::default() })
            }
        }
    }
    out
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let start = tag.find(&format!("{name}=\""))? + name.len() + 2;
    tag[start..].split('"').next()
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
}

fn parse(markup: &str, out: &mut Vec<Run>) {
    let mut stack: Vec<Run> = vec![Run::default()];
    let mut rest = markup;
    while !rest.is_empty() {
        if rest.starts_with('<') {
            let Some(end) = rest.find('>') else { break };
            let tag = &rest[1..end];
            rest = &rest[end + 1..];
            if tag.starts_with('/') {
                if stack.len() > 1 {
                    stack.pop();
                }
                continue;
            }
            let mut style = stack.last().cloned().unwrap_or_default();
            style.text.clear();
            match tag.split(' ').next().unwrap_or_default() {
                "b" => style.bold = true,
                "i" => style.italic = true,
                "a" => style.link = attribute(tag, "href").map(unescape),
                "span" => {
                    if attribute(tag, "strikethrough") == Some("true") {
                        style.strike = true;
                    }
                    if attribute(tag, "font_family") == Some("monospace") {
                        style.code = true;
                    }
                    if attribute(tag, "weight") == Some("bold") {
                        style.mention = true;
                    }
                    if attribute(tag, "foreground").is_some() && attribute(tag, "background").is_some() {
                        style.highlight = true;
                    }
                }
                _ => {}
            }
            stack.push(style);
            continue;
        }
        let end = rest.find('<').unwrap_or(rest.len());
        let mut run = stack.last().cloned().unwrap_or_default();
        run.text = unescape(&rest[..end]);
        rest = &rest[end..];
        match out.last_mut() {
            Some(last) if Run { text: String::new(), ..last.clone() } == Run { text: String::new(), ..run.clone() } => {
                last.text.push_str(&run.text)
            }
            _ => out.push(run),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(text: &str) -> Run {
        Run { text: text.into(), ..Default::default() }
    }

    #[test]
    fn styles_nest_and_entities_resolve() {
        let r = runs("a <b>bold <i>both</i></b> &amp; <span strikethrough=\"true\">gone</span>");
        assert_eq!(
            r,
            [
                plain("a "),
                Run { text: "bold ".into(), bold: true, ..Default::default() },
                Run { text: "both".into(), bold: true, italic: true, ..Default::default() },
                plain(" & "),
                Run { text: "gone".into(), strike: true, ..Default::default() },
            ]
        );
    }

    #[test]
    fn code_links_and_mentions() {
        let r = runs(concat!(
            "<span font_family=\"monospace\" background=\"#1E1B33\">x &lt; y</span>",
            "<a href=\"https://a.example/?q=1&amp;r=2\">site</a>",
            "<a href=\"rv-user:bob\"><span foreground=\"#FF7AB4\" weight=\"bold\">@bob</span></a>",
            "<span foreground=\"#FF7AB4\" weight=\"bold\" background=\"#4A2140\">@all</span>",
        ));
        assert!(r[0].code && r[0].text == "x < y");
        assert_eq!(r[1].link.as_deref(), Some("https://a.example/?q=1&r=2"));
        assert_eq!((r[2].link.as_deref(), r[2].mention, r[2].highlight), (Some("rv-user:bob"), true, false));
        assert_eq!((r[3].text.as_str(), r[3].mention, r[3].highlight), ("@all", true, true));
    }

    #[test]
    fn custom_emoji_become_their_own_run() {
        let r = runs(&format!("hi {m}party{m}!", m = markdown::CUSTOM_MARK));
        assert_eq!(r[1], Run { text: ":party:".into(), custom_emoji: Some("party".into()), ..Default::default() });
        assert_eq!(r[2], plain("!"));
    }

    #[test]
    fn a_whole_message() {
        let md = r#"[{"type":"PARAGRAPH","value":[{"type":"PLAIN_TEXT","value":"hello "},{"type":"BOLD","value":[{"type":"PLAIN_TEXT","value":"world"}]}]},
            {"type":"UNORDERED_LIST","value":[{"type":"LIST_ITEM","value":[{"type":"PLAIN_TEXT","value":"one"}]}]}]"#;
        let b = blocks(markdown::render(Some(md), None, &markdown::Context { me: "me" }));
        assert_eq!(
            b,
            [
                BodyBlock::Paragraph {
                    runs: vec![plain("hello "), Run { text: "world".into(), bold: true, ..Default::default() }]
                },
                BodyBlock::List { items: vec![ListItem { marker: "•".into(), runs: vec![plain("one")] }] },
            ]
        );
    }
}
