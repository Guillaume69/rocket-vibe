//! A message's text read the way Rocket.Chat's message-parser reads it, for
//! messages that come without `md` (bots, integrations, older servers): the
//! same node shapes, so one renderer serves both.

use serde_json::{Value, json};

fn plain(text: &str) -> Value {
    json!({"type": "PLAIN_TEXT", "value": text})
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '.')
}

fn is_code(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-')
}

/// `*bold*`, `_italic_`, `~strike~` (doubled too): the marker hugs its text
/// and closes on the same line.
fn emphasis(chars: &[char], at: usize) -> Option<(&'static str, usize, usize, usize)> {
    let c = chars[at];
    let kind = match c {
        '*' => "BOLD",
        '_' => "ITALIC",
        '~' => "STRIKE",
        _ => return None,
    };
    let before = at.checked_sub(1).map(|i| chars[i]);
    if before.is_some_and(|b| b.is_alphanumeric() && c == '_') {
        return None;
    }
    let width = if chars.get(at + 1) == Some(&c) { 2 } else { 1 };
    let start = at + width;
    if chars.get(start).is_none_or(|n| n.is_whitespace() || *n == c) {
        return None;
    }
    let mut i = start;
    while i < chars.len() {
        if chars[i] == c
            && !chars[i - 1].is_whitespace()
            && (width == 1 || chars.get(i + 1) == Some(&c))
            && (width == 2 || chars.get(i + 1) != Some(&c))
        {
            let after = chars.get(i + width);
            if after.is_none_or(|a| !(a.is_alphanumeric() && c == '_')) {
                return Some((kind, start, i, i + width));
            }
        }
        i += 1;
    }
    None
}

fn url_end(chars: &[char], at: usize) -> Option<usize> {
    let rest: String = chars[at..chars.len().min(at + 8)].iter().collect();
    if !(rest.starts_with("https://") || rest.starts_with("http://")) {
        return None;
    }
    let mut end = at;
    while end < chars.len() && !chars[end].is_whitespace() && chars[end] != '<' && chars[end] != '>' {
        end += 1;
    }
    while end > at && matches!(chars[end - 1], '.' | ',' | ';' | ':' | '!' | '?' | ')' | '\'' | '"') {
        end -= 1;
    }
    Some(end)
}

/// `[label](url)`: the label's end, the url's bounds and the token's end.
fn labelled_link(chars: &[char], at: usize) -> Option<(usize, usize, usize, usize)> {
    let close = (at + 1..chars.len()).find(|&i| chars[i] == ']')?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let url_start = close + 2;
    let url_close = (url_start..chars.len()).find(|&i| chars[i] == ')' || chars[i].is_whitespace())?;
    (chars[url_close] == ')' && url_close > url_start).then_some((close, url_start, url_close, url_close + 1))
}

fn inlines(chars: &[char]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut text = String::new();
    let flush = |text: &mut String, out: &mut Vec<Value>| {
        if !text.is_empty() {
            out.push(plain(text));
            text.clear();
        }
    };
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let boundary = i == 0 || !is_word(chars[i - 1]);
        // `\_` is a literal `_`, as in Rocket.Chat's parser: `¯\_(ツ)_/¯`.
        if c == '\\'
            && let Some(&next) = chars.get(i + 1)
            && next.is_ascii_punctuation()
        {
            text.push(next);
            i += 2;
            continue;
        }
        if c == '`'
            && let Some(end) = (i + 1..chars.len()).find(|&j| chars[j] == '`')
            && end > i + 1
        {
            flush(&mut text, &mut out);
            let code: String = chars[i + 1..end].iter().collect();
            out.push(json!({"type": "INLINE_CODE", "value": plain(&code)}));
            i = end + 1;
            continue;
        }
        if c == '['
            && let Some((close, url_start, url_close, end)) = labelled_link(chars, i)
        {
            flush(&mut text, &mut out);
            let url: String = chars[url_start..url_close].iter().collect();
            out.push(json!({"type": "LINK", "value": {"src": plain(&url), "label": inlines(&chars[i + 1..close])}}));
            i = end;
            continue;
        }
        if boundary && let Some(end) = url_end(chars, i) {
            flush(&mut text, &mut out);
            let url: String = chars[i..end].iter().collect();
            out.push(json!({"type": "LINK", "value": {"src": plain(&url), "label": [plain(&url)]}}));
            i = end;
            continue;
        }
        if c == ':' {
            let end = (i + 1..chars.len()).take_while(|&j| is_code(chars[j])).last().map(|j| j + 1);
            if let Some(end) = end.filter(|&e| chars.get(e) == Some(&':')) {
                flush(&mut text, &mut out);
                let code: String = chars[i + 1..end].iter().collect();
                out.push(json!({"type": "EMOJI", "value": plain(&code), "shortCode": code}));
                i = end + 1;
                continue;
            }
        }
        if (c == '@' || c == '#') && boundary {
            let end = (i + 1..chars.len()).take_while(|&j| is_word(chars[j])).last().map(|j| j + 1);
            if let Some(end) = end {
                let mut end = end;
                while end > i + 1 && chars[end - 1] == '.' {
                    end -= 1;
                }
                flush(&mut text, &mut out);
                let name: String = chars[i + 1..end].iter().collect();
                let kind = if c == '@' { "MENTION_USER" } else { "MENTION_CHANNEL" };
                out.push(json!({"type": kind, "value": plain(&name)}));
                i = end;
                continue;
            }
        }
        if boundary && let Some((kind, start, stop, end)) = emphasis(chars, i) {
            flush(&mut text, &mut out);
            out.push(json!({"type": kind, "value": inlines(&chars[start..stop])}));
            i = end;
            continue;
        }
        text.push(c);
        i += 1;
    }
    flush(&mut text, &mut out);
    out
}

fn line_inlines(line: &str) -> Vec<Value> {
    inlines(&line.chars().collect::<Vec<_>>())
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.chars().take_while(|&c| c == '#').count();
    (1..=4).contains(&level).then(|| line[level..].strip_prefix(' ').map(|rest| (level, rest))).flatten()
}

fn bullet(line: &str) -> Option<&str> {
    line.strip_prefix("- ").or_else(|| line.strip_prefix("* "))
}

fn numbered(line: &str) -> Option<(u64, &str)> {
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    let number = line[..digits].parse().ok()?;
    line[digits..].strip_prefix(". ").map(|rest| (number, rest))
}

fn only_emoji(nodes: &[Value]) -> bool {
    let emoji = nodes.iter().filter(|n| n["type"] == "EMOJI").count();
    emoji > 0
        && emoji <= 3
        && nodes.iter().all(|n| {
            n["type"] == "EMOJI"
                || (n["type"] == "PLAIN_TEXT" && n["value"].as_str().is_some_and(|t| t.trim().is_empty()))
        })
}

/// The blocks of `text`, as `md` would hold them.
pub fn tree(text: &str) -> Vec<Value> {
    let mut blocks: Vec<Value> = Vec::new();
    let lines: Vec<&str> = text.split('\n').collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim_start().starts_with("```") {
            let mut code = Vec::new();
            let mut j = i + 1;
            while j < lines.len() && !lines[j].trim_start().starts_with("```") {
                code.push(json!({"type": "CODE_LINE", "value": plain(lines[j])}));
                j += 1;
            }
            if j < lines.len() {
                blocks.push(json!({"type": "CODE", "language": "none", "value": code}));
                i = j + 1;
                continue;
            }
        }
        if line.trim().is_empty() {
            if !blocks.is_empty() && i + 1 < lines.len() {
                blocks.push(json!({"type": "LINE_BREAK"}));
            }
            i += 1;
            continue;
        }
        if let Some((level, rest)) = heading(line) {
            blocks.push(json!({"type": "HEADING", "level": level, "value": line_inlines(rest)}));
            i += 1;
            continue;
        }
        if line.starts_with("> ") || line == ">" {
            let mut quoted = Vec::new();
            while i < lines.len() && (lines[i].starts_with("> ") || lines[i] == ">") {
                quoted.push(json!({"type": "PARAGRAPH", "value": line_inlines(lines[i].get(2..).unwrap_or_default())}));
                i += 1;
            }
            blocks.push(json!({"type": "QUOTE", "value": quoted}));
            continue;
        }
        if bullet(line).is_some() {
            let mut items = Vec::new();
            while let Some(rest) = lines.get(i).and_then(|l| bullet(l)) {
                items.push(json!({"type": "LIST_ITEM", "value": line_inlines(rest)}));
                i += 1;
            }
            blocks.push(json!({"type": "UNORDERED_LIST", "value": items}));
            continue;
        }
        if numbered(line).is_some() {
            let mut items = Vec::new();
            while let Some((number, rest)) = lines.get(i).and_then(|l| numbered(l)) {
                items.push(json!({"type": "LIST_ITEM", "number": number, "value": line_inlines(rest)}));
                i += 1;
            }
            blocks.push(json!({"type": "ORDERED_LIST", "value": items}));
            continue;
        }
        blocks.push(json!({"type": "PARAGRAPH", "value": line_inlines(line)}));
        i += 1;
    }
    if let [only] = blocks.as_slice()
        && only["type"] == "PARAGRAPH"
        && let Some(nodes) = only["value"].as_array()
        && only_emoji(nodes)
    {
        let emoji: Vec<Value> = nodes.iter().filter(|n| n["type"] == "EMOJI").cloned().collect();
        return vec![json!({"type": "BIG_EMOJI", "value": emoji})];
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types(nodes: &[Value]) -> Vec<&str> {
        nodes.iter().map(|n| n["type"].as_str().unwrap()).collect()
    }

    #[test]
    fn labelled_and_bare_links() {
        let t = tree("[t.gg](http://t.gg) and https://x.y/a?b=1.");
        let nodes = t[0]["value"].as_array().unwrap();
        assert_eq!(types(nodes), ["LINK", "PLAIN_TEXT", "LINK", "PLAIN_TEXT"]);
        assert_eq!(nodes[0]["value"]["src"]["value"], "http://t.gg");
        assert_eq!(nodes[0]["value"]["label"][0]["value"], "t.gg");
        assert_eq!(nodes[2]["value"]["src"]["value"], "https://x.y/a?b=1");
        assert_eq!(nodes[3]["value"], ".");
    }

    #[test]
    fn adjacent_emoji_make_a_big_emoji() {
        let t = tree(":kkk::heil:");
        assert_eq!(types(&t), ["BIG_EMOJI"]);
        let emoji = t[0]["value"].as_array().unwrap();
        assert_eq!((emoji[0]["shortCode"].as_str(), emoji[1]["shortCode"].as_str()), (Some("kkk"), Some("heil")));
        assert_eq!(types(&tree("hi :smile:")[0]["value"].as_array().unwrap()[..]), ["PLAIN_TEXT", "EMOJI"]);
    }

    #[test]
    fn emphasis_code_and_mentions() {
        let t = tree("*bold* _it_ ~~gone~~ `x_y` @bob #general mail@x.y 2*3*4");
        let nodes = t[0]["value"].as_array().unwrap();
        assert_eq!(
            types(nodes),
            [
                "BOLD",
                "PLAIN_TEXT",
                "ITALIC",
                "PLAIN_TEXT",
                "STRIKE",
                "PLAIN_TEXT",
                "INLINE_CODE",
                "PLAIN_TEXT",
                "MENTION_USER",
                "PLAIN_TEXT",
                "MENTION_CHANNEL",
                "PLAIN_TEXT"
            ]
        );
        assert_eq!(nodes[8]["value"]["value"], "bob");
        assert_eq!(nodes[11]["value"], " mail@x.y 2*3*4");
    }

    #[test]
    fn a_backslash_keeps_a_marker_literal() {
        let t = tree(r"ok ¯\_(ツ)_/¯ \*not bold\* a\b");
        assert_eq!(types(t[0]["value"].as_array().unwrap()), ["PLAIN_TEXT"]);
        assert_eq!(t[0]["value"][0]["value"], r"ok ¯_(ツ)_/¯ *not bold* a\b");
    }

    #[test]
    fn blocks_by_line() {
        let t = tree("# Title\n- one\n- two\n3. three\n> said\n\nafter\n```\n- raw *text*\n```");
        assert_eq!(
            types(&t),
            ["HEADING", "UNORDERED_LIST", "ORDERED_LIST", "QUOTE", "LINE_BREAK", "PARAGRAPH", "CODE"]
        );
        assert_eq!(t[2]["value"][0]["number"], 3);
        assert_eq!(t[6]["value"][0]["value"]["value"], "- raw *text*");
    }

    #[test]
    fn an_open_fence_stays_text() {
        assert_eq!(types(&tree("```\nnever closed")), ["PARAGRAPH", "PARAGRAPH"]);
    }
}
