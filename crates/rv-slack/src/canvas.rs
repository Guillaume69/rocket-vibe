//! A channel's canvas as notes: the canvas file Slack serves as HTML, read
//! back into the markdown the apps render, and written with `canvases.edit`.
//! Only the tags a canvas holds are understood; anything else keeps its text.

use serde_json::Value;

/// Where a conversation's canvas lives: its file id, from `conversations.info`.
pub fn canvas_file(conversation: &Value) -> Option<String> {
    let properties = conversation.get("properties")?;
    let direct = properties.pointer("/canvas/file_id").and_then(Value::as_str);
    let tab = || {
        properties.get("tabs")?.as_array()?.iter().find_map(|tab| {
            (tab.get("type").and_then(Value::as_str) == Some("canvas"))
                .then(|| tab.pointer("/data/file_id").and_then(Value::as_str))
                .flatten()
        })
    };
    direct.or_else(tab).filter(|id| !id.is_empty()).map(str::to_owned)
}

/// The markdown of a canvas's HTML.
pub fn markdown(html: &str) -> String {
    let mut out = Writer::default();
    let mut rest = body(html);
    while !rest.is_empty() {
        match rest.find('<') {
            Some(0) => {
                let end = rest.find('>').map_or(rest.len(), |i| i + 1);
                out.tag(&rest[..end]);
                rest = &rest[end..];
            }
            Some(i) => {
                out.text(&entities(&rest[..i]));
                rest = &rest[i..];
            }
            None => {
                out.text(&entities(rest));
                rest = "";
            }
        }
    }
    out.finish()
}

fn body(html: &str) -> &str {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<body").and_then(|i| lower[i..].find('>').map(|j| i + j + 1)).unwrap_or(0);
    let end = lower.rfind("</body>").filter(|&e| e >= start).unwrap_or(html.len());
    &html[start..end]
}

#[derive(Default)]
struct Writer {
    blocks: Vec<String>,
    line: String,
    /// Open lists: ordered, and the next number.
    lists: Vec<(bool, u32)>,
    pre: bool,
    quote: bool,
    link: Option<String>,
    skip: u32,
    /// A top-level list just closed: the next item starts a new block.
    list_ended: bool,
}

impl Writer {
    fn tag(&mut self, raw: &str) {
        let inner = raw.trim_start_matches('<').trim_end_matches('>').trim_end_matches('/');
        let closing = inner.starts_with('/');
        let inner = inner.trim_start_matches('/');
        let name = inner.split(|c: char| c.is_whitespace()).next().unwrap_or("").to_ascii_lowercase();
        let attr = |key: &str| attribute(inner, key);
        if matches!(name.as_str(), "script" | "style" | "head" | "title") {
            if closing {
                self.skip = self.skip.saturating_sub(1);
            } else {
                self.skip += 1;
            }
            return;
        }
        if self.skip > 0 {
            return;
        }
        match (name.as_str(), closing) {
            ("h1" | "h2" | "h3" | "h4" | "h5" | "h6", false) => {
                self.flush();
                let level = name[1..].parse::<usize>().unwrap_or(1).min(3);
                self.line.push_str(&"#".repeat(level));
                self.line.push(' ');
            }
            ("p" | "div" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6", _) => self.flush(),
            ("br", _) => {
                if self.pre {
                    self.line.push('\n');
                } else {
                    self.flush();
                }
            }
            ("ul", false) => {
                self.flush();
                self.lists.push((false, 1));
            }
            ("ol", false) => {
                self.flush();
                self.lists.push((true, 1));
            }
            ("ul" | "ol", true) => {
                self.flush();
                self.lists.pop();
                self.list_ended = self.lists.is_empty();
            }
            ("li", false) => {
                self.flush();
                let depth = self.lists.len().saturating_sub(1);
                self.line.push_str(&"  ".repeat(depth));
                match self.lists.last_mut() {
                    Some((true, n)) => {
                        self.line.push_str(&format!("{n}. "));
                        *n += 1;
                    }
                    _ => self.line.push_str("- "),
                }
                let class = attr("class").unwrap_or_default();
                if class.split_whitespace().any(|c| c == "checked") {
                    self.line.push_str("[x] ");
                } else if class.split_whitespace().any(|c| c == "unchecked" || c == "checklist-item") {
                    self.line.push_str("[ ] ");
                }
            }
            ("li", true) => self.flush(),
            ("b" | "strong", _) => self.line.push_str("**"),
            ("i" | "em", _) => self.line.push('_'),
            ("s" | "del" | "strike", _) => self.line.push('~'),
            ("code", _) if !self.pre => self.line.push('`'),
            ("pre", false) => {
                self.flush();
                self.pre = true;
                self.line.push_str("```\n");
            }
            ("pre", true) => {
                self.line.push_str("\n```");
                self.pre = false;
                self.flush();
            }
            ("blockquote", open) => {
                self.flush();
                self.quote = !open;
            }
            ("hr", _) => {
                self.flush();
                self.blocks.push("---".into());
            }
            ("a", false) => {
                self.link = attr("href").filter(|h| h.starts_with("https://") || h.starts_with("http://"));
                if self.link.is_some() {
                    self.line.push('[');
                }
            }
            ("a", true) => {
                if let Some(href) = self.link.take() {
                    self.line.push_str(&format!("]({href})"));
                }
            }
            ("td" | "th", true) => self.line.push_str(" | "),
            ("tr", true) => self.flush(),
            _ => {}
        }
    }

    fn text(&mut self, text: &str) {
        if self.skip > 0 {
            return;
        }
        if self.pre {
            self.line.push_str(text);
            return;
        }
        let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if collapsed.is_empty() {
            if text.chars().any(char::is_whitespace) && !self.line.ends_with(' ') && !self.line.is_empty() {
                self.line.push(' ');
            }
            return;
        }
        if text.starts_with(char::is_whitespace) && !self.line.is_empty() && !self.line.ends_with(' ') {
            self.line.push(' ');
        }
        self.line.push_str(&collapsed);
        if text.ends_with(char::is_whitespace) {
            self.line.push(' ');
        }
    }

    fn flush(&mut self) {
        let line = self.line.trim_end().to_owned();
        self.line.clear();
        if line.trim().is_empty() {
            return;
        }
        let line = if self.quote { format!("> {line}") } else { line };
        // List items stay together; everything else is its own paragraph.
        let item = |l: &str| {
            let t = l.trim_start();
            t.starts_with("- ") || t.split_once(". ").is_some_and(|(n, _)| n.bytes().all(|b| b.is_ascii_digit()))
        };
        match self.blocks.last_mut() {
            Some(last) if !self.list_ended && item(&line) && item(last.lines().last().unwrap_or("")) => {
                last.push('\n');
                last.push_str(&line);
            }
            _ => self.blocks.push(line),
        }
        self.list_ended = false;
    }

    fn finish(mut self) -> String {
        self.flush();
        self.blocks.join("\n\n")
    }
}

fn attribute(tag: &str, key: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let at = lower.find(&format!("{key}="))? + key.len() + 1;
    let rest = &tag[at..];
    let value = match rest.chars().next()? {
        quote @ ('"' | '\'') => rest[1..].split(quote).next()?,
        _ => rest.split(|c: char| c.is_whitespace()).next()?,
    };
    Some(entities(value))
}

fn entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let decoded = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ => name
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_channel_canvas_is_found_in_its_properties_or_its_tabs() {
        assert_eq!(canvas_file(&json!({"properties": {"canvas": {"file_id": "F1"}}})).as_deref(), Some("F1"));
        let tabs = json!({"properties": {"tabs": [{"type": "files"}, {"type": "canvas", "data": {"file_id": "F2"}}]}});
        assert_eq!(canvas_file(&tabs).as_deref(), Some("F2"));
        assert_eq!(canvas_file(&json!({"properties": {}})), None);
        assert_eq!(canvas_file(&json!({})), None);
    }

    #[test]
    fn canvas_html_reads_as_markdown() {
        let html = "<html><head><title>x</title><style>p{}</style></head><body>\
            <h1>Plan &amp; goals</h1><p>Ship <b>notes</b>, <i>then</i> <a href=\"https://example.com/a?b=1&amp;c=2\">docs</a>.</p>\
            <ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>\
            <ol><li>first</li><li>second</li></ol>\
            <ul class=\"checklist\"><li class=\"checked\">done</li><li class=\"unchecked\">todo</li></ul>\
            <pre><code>let x = 1;\nlet y = 2;</code></pre>\
            <blockquote><p>quoted</p></blockquote><hr/><p>a&nbsp;b &#233;&#x1F680; <code>tt</code></p>\
            <script>alert(1)</script></body></html>";
        assert_eq!(
            markdown(html),
            "# Plan & goals\n\n\
             Ship **notes**, _then_ [docs](https://example.com/a?b=1&c=2).\n\n\
             - one\n- two\n  - nested\n\n\
             1. first\n2. second\n\n\
             - [x] done\n- [ ] todo\n\n\
             ```\nlet x = 1;\nlet y = 2;\n```\n\n\
             > quoted\n\n---\n\n\
             a b é🚀 `tt`"
        );
    }

    #[test]
    fn a_link_to_anything_but_the_web_keeps_its_text_only() {
        assert_eq!(markdown("<p><a href=\"javascript:alert(1)\">click</a></p>"), "click");
        assert_eq!(markdown("plain &unknown; text"), "plain &unknown; text");
        assert_eq!(markdown(""), "");
    }
}
