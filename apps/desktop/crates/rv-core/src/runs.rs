//! A block's markup as styled runs of text, for views that style text
//! themselves rather than hand Pango the markup: the SwiftUI app, and the GTK
//! text views that hold server emoji as pictures. One pass over the markup,
//! server emoji included, so a style open across an emoji stays open.

use crate::markdown::{self, Block, CUSTOM_MARK};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
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

impl Run {
    fn same_style(&self, other: &Run) -> bool {
        Run { text: String::new(), ..self.clone() } == Run { text: String::new(), ..other.clone() }
    }
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let start = tag.find(&format!("{name}=\""))? + name.len() + 2;
    tag[start..].split('"').next()
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
}

fn push(out: &mut Vec<Run>, run: Run) {
    if run.text.is_empty() {
        return;
    }
    match out.last_mut() {
        Some(last) if last.custom_emoji.is_none() && run.custom_emoji.is_none() && last.same_style(&run) => {
            last.text.push_str(&run.text)
        }
        _ => out.push(run),
    }
}

pub fn runs(markup: &str) -> Vec<Run> {
    let mut out = Vec::new();
    let mut stack: Vec<Run> = vec![Run::default()];
    let mut in_emoji = false;
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
        let end = rest.find(['<', CUSTOM_MARK]).unwrap_or(rest.len());
        let style = stack.last().cloned().unwrap_or_default();
        let text = unescape(&rest[..end]);
        if in_emoji {
            push(&mut out, Run { text: format!(":{text}:"), custom_emoji: Some(text), ..style });
        } else {
            push(&mut out, Run { text, ..style });
        }
        rest = &rest[end..];
        if let Some(after) = rest.strip_prefix(CUSTOM_MARK) {
            in_emoji = !in_emoji;
            rest = after;
        }
    }
    out
}

/// The words a block shows, server emoji as `:code:`.
pub fn plain(markup: &str) -> String {
    runs(markup).into_iter().map(|r| r.text).collect()
}

fn block_text(block: &Block, out: &mut Vec<String>) {
    match block {
        Block::Paragraph(m) | Block::Heading { markup: m, .. } | Block::BigEmoji(m) => out.push(plain(m)),
        Block::Quote(inner) => inner.iter().for_each(|b| block_text(b, out)),
        Block::Code(code) => out.push(code.clone()),
        Block::List(items) => out.extend(items.iter().map(|(marker, m)| format!("{marker} {}", plain(m)))),
        Block::Break => {}
    }
}

/// A message's words, one line per block, as the timeline shows them.
pub fn text(blocks: &[Block]) -> String {
    let mut out = Vec::new();
    blocks.iter().for_each(|b| block_text(b, &mut out));
    out.join("\n")
}

/// A message on one line, formatting gone, for the room list.
pub fn preview(text: &str) -> String {
    let blocks = markdown::render(None, Some(text), &markdown::Context { me: "" });
    self::text(&blocks).split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_run(text: &str) -> Run {
        Run { text: text.into(), ..Default::default() }
    }

    #[test]
    fn styles_nest_and_entities_resolve() {
        let r = runs("a <b>bold <i>both</i></b> &amp; <span strikethrough=\"true\">gone</span>");
        assert_eq!(
            r,
            [
                plain_run("a "),
                Run { text: "bold ".into(), bold: true, ..Default::default() },
                Run { text: "both".into(), bold: true, italic: true, ..Default::default() },
                plain_run(" & "),
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
    fn server_emoji_keep_the_style_around_them() {
        let m = CUSTOM_MARK;
        let r = runs(&format!("<b>{m}party{m} bold</b> <span strikethrough=\"true\">a {m}x{m}{m}y{m} b</span>"));
        assert_eq!(
            r[0],
            Run { text: ":party:".into(), custom_emoji: Some("party".into()), bold: true, ..Default::default() }
        );
        assert_eq!(r[1], Run { text: " bold".into(), bold: true, ..Default::default() });
        assert_eq!(r[2], plain_run(" "));
        assert_eq!(r[3], Run { text: "a ".into(), strike: true, ..Default::default() });
        assert_eq!(r[4].custom_emoji.as_deref(), Some("x"));
        assert_eq!((r[5].custom_emoji.as_deref(), r[5].strike), (Some("y"), true));
        assert_eq!(r[6], Run { text: " b".into(), strike: true, ..Default::default() });
    }

    #[test]
    fn previews_read_as_text() {
        assert_eq!(preview("```\nZOB\n```"), "ZOB");
        assert_eq!(preview("[t.gg](http://t.gg) *bold* ~x~ `c`"), "t.gg bold x c");
        assert_eq!(preview("hi @bob\n\n- one\n- two"), "hi @bob • one • two");
        assert_eq!(preview(":kkk::smile:"), ":kkk: 😄");
        assert_eq!(preview("# Title :party:"), "Title :party:");
    }
}
