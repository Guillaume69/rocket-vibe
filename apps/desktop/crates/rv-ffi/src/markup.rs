//! rv-core renders message bodies as Pango markup for GTK. Swift gets the
//! same bodies as styled runs, so it never parses markup.

use rv_core::markdown::Block;

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
    rv_core::runs::runs(markup)
        .into_iter()
        .map(|r| Run {
            text: r.text,
            bold: r.bold,
            italic: r.italic,
            strike: r.strike,
            code: r.code,
            link: r.link,
            mention: r.mention,
            highlight: r.highlight,
            custom_emoji: r.custom_emoji,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rv_core::markdown;

    fn plain(text: &str) -> Run {
        Run { text: text.into(), ..Default::default() }
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
