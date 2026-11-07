//! A block's inline formatting: the HTML a canvas stores, the markdown the apps
//! edit, and the runs of text between them. Markdown has no underline: it stays
//! on the text an edit leaves alone (`keep_underline`).

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Marks {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub struck: bool,
    pub code: bool,
    pub link: Option<String>,
}

pub type Run = (String, Marks);

fn push(out: &mut Vec<Run>, text: &str, marks: &Marks) {
    if text.is_empty() {
        return;
    }
    match out.last_mut() {
        Some((t, m)) if m == marks => t.push_str(text),
        _ => out.push((text.to_owned(), marks.clone())),
    }
}

pub fn plain(runs: &[Run]) -> String {
    runs.iter().map(|(text, _)| text.as_str()).collect()
}

pub fn literal(text: &str) -> Vec<Run> {
    let mut out = Vec::new();
    push(&mut out, text, &Marks::default());
    out
}

pub fn from_html(html: &str) -> Vec<Run> {
    let mut out = Vec::new();
    let mut open: Vec<(String, Option<String>)> = Vec::new();
    let mut rest = html;
    while !rest.is_empty() {
        let at = rest.find('<').unwrap_or(rest.len());
        push(&mut out, &unescape(&rest[..at]), &marks_of(&open));
        rest = &rest[at..];
        if rest.is_empty() {
            break;
        }
        let tag_end =
            rest.find('>').filter(|_| rest[1..].chars().next().is_some_and(|c| c == '/' || c.is_ascii_alphabetic()));
        let Some(end) = tag_end else {
            push(&mut out, "<", &marks_of(&open));
            rest = &rest[1..];
            continue;
        };
        let tag = &rest[1..end];
        rest = &rest[end + 1..];
        if let Some(name) = tag.strip_prefix('/') {
            let name = name.trim().to_ascii_lowercase();
            if let Some(found) = open.iter().rposition(|(n, _)| *n == name) {
                open.remove(found);
            }
        } else {
            let name = tag.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("").to_ascii_lowercase();
            let href = tag.split_once("href=\"").and_then(|(_, v)| v.split_once('"')).map(|(v, _)| unescape(v));
            if !tag.ends_with('/') {
                open.push((name, href));
            }
        }
    }
    out
}

fn marks_of(open: &[(String, Option<String>)]) -> Marks {
    let mut marks = Marks::default();
    for (name, href) in open {
        match name.as_str() {
            "b" | "strong" => marks.bold = true,
            "i" | "em" => marks.italic = true,
            "u" => marks.underline = true,
            "del" | "s" | "strike" => marks.struck = true,
            "code" => marks.code = true,
            "a" => marks.link = href.clone().or(marks.link.take()),
            _ => {}
        }
    }
    marks
}

fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let entity = rest[1..].find(';').filter(|n| *n <= 8).map(|n| &rest[1..n + 1]);
        let decoded = entity.and_then(|e| match e {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            _ => e
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| e.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        });
        match (entity, decoded) {
            (Some(e), Some(c)) => {
                out.push(c);
                rest = &rest[e.len() + 2..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn to_html(runs: &[Run]) -> String {
    runs.iter()
        .map(|(text, marks)| {
            let mut out = escape_html(text);
            for (on, tag) in [
                (marks.code, "code"),
                (marks.struck, "del"),
                (marks.underline, "u"),
                (marks.italic, "i"),
                (marks.bold, "b"),
            ] {
                if on {
                    out = format!("<{tag}>{out}</{tag}>");
                }
            }
            match &marks.link {
                Some(url) => format!("<a href=\"{}\">{out}</a>", escape_html(url).replace('"', "&quot;")),
                None => out,
            }
        })
        .collect()
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

#[derive(Clone, PartialEq)]
enum Wrap {
    Link(String),
    Bold,
    Italic,
    Struck,
}

impl Wrap {
    fn open(&self) -> &'static str {
        match self {
            Wrap::Link(_) => "[",
            Wrap::Bold => "**",
            Wrap::Italic => "*",
            Wrap::Struck => "~~",
        }
    }

    fn close(&self) -> String {
        match self {
            Wrap::Link(url) => format!("]({url})"),
            other => other.open().to_owned(),
        }
    }
}

fn wraps(marks: &Marks) -> Vec<Wrap> {
    let mut out = Vec::new();
    if let Some(url) = &marks.link {
        out.push(Wrap::Link(url.clone()));
    }
    if marks.bold {
        out.push(Wrap::Bold);
    }
    if marks.italic {
        out.push(Wrap::Italic);
    }
    if marks.struck {
        out.push(Wrap::Struck);
    }
    out
}

/// Marks that continue across runs stay open, so `**a *b***` is not cut in two.
pub fn to_markdown(runs: &[Run]) -> String {
    let mut out = String::new();
    let mut open: Vec<Wrap> = Vec::new();
    for (text, marks) in runs {
        let wanted = wraps(marks);
        let same = open.iter().zip(&wanted).take_while(|(a, b)| a == b).count();
        for wrap in open.drain(same..).rev() {
            out.push_str(&wrap.close());
        }
        for wrap in &wanted[same..] {
            out.push_str(wrap.open());
            open.push(wrap.clone());
        }
        if marks.code {
            out.push('`');
            out.push_str(&text.replace('`', "'"));
            out.push('`');
        } else {
            out.push_str(&escaped(text));
        }
    }
    for wrap in open.iter().rev() {
        out.push_str(&wrap.close());
    }
    out
}

pub fn from_markdown(text: &str) -> Vec<Run> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    parse(&chars, &Marks::default(), &mut out);
    out
}

fn find(chars: &[char], from: usize, pattern: &[char]) -> Option<usize> {
    let mut at = from;
    while at + pattern.len() <= chars.len() {
        if chars[at] == '\\' {
            at += 2;
            continue;
        }
        if chars[at..at + pattern.len()] == *pattern {
            return Some(at);
        }
        at += 1;
    }
    None
}

/// `*` and `_` around spaces or inside a word are ordinary characters.
fn emphasis_end(chars: &[char], at: usize) -> Option<usize> {
    let mark = chars[at];
    let word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric());
    if chars.get(at + 1).is_none_or(|c| c.is_whitespace()) || (mark == '_' && at > 0 && word(chars.get(at - 1))) {
        return None;
    }
    let mut from = at + 1;
    while let Some(end) = find(chars, from, &[mark]) {
        if !chars[end - 1].is_whitespace() && !(mark == '_' && word(chars.get(end + 1))) && end > at + 1 {
            return Some(end);
        }
        from = end + 1;
    }
    None
}

fn parse(chars: &[char], base: &Marks, out: &mut Vec<Run>) {
    let mut buffer = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            buffer.push(chars[i + 1]);
            i += 2;
            continue;
        }
        let span: Option<(usize, usize, usize, Marks)> = if chars[i..].starts_with(&['*', '*']) {
            find(chars, i + 2, &['*', '*'])
                .filter(|end| *end > i + 2)
                .map(|end| (i + 2, end, end + 2, Marks { bold: true, ..base.clone() }))
        } else if chars[i..].starts_with(&['~', '~']) {
            find(chars, i + 2, &['~', '~'])
                .filter(|end| *end > i + 2)
                .map(|end| (i + 2, end, end + 2, Marks { struck: true, ..base.clone() }))
        } else if c == '*' || c == '_' {
            emphasis_end(chars, i).map(|end| (i + 1, end, end + 1, Marks { italic: true, ..base.clone() }))
        } else if c == '[' {
            find(chars, i + 1, &[']']).filter(|close| chars.get(close + 1) == Some(&'(')).and_then(|close| {
                let end = find(chars, close + 2, &[')'])?;
                let link = chars[close + 2..end].iter().collect();
                Some((i + 1, close, end + 1, Marks { link: Some(link), ..base.clone() }))
            })
        } else {
            None
        };
        if let Some((from, to, next, marks)) = span {
            push(out, &buffer, base);
            buffer.clear();
            parse(&chars[from..to], &marks, out);
            i = next;
            continue;
        }
        if c == '`'
            && let Some(end) = find(chars, i + 1, &['`'])
        {
            push(out, &buffer, base);
            buffer.clear();
            let code: String = chars[i + 1..end].iter().collect();
            push(out, &code, &Marks { code: true, ..base.clone() });
            i = end + 1;
            continue;
        }
        buffer.push(c);
        i += 1;
    }
    push(out, &buffer, base);
}

/// The underline `old` had on the text `new` leaves unchanged at either end.
pub fn keep_underline(old: &[Run], new: &[Run]) -> Vec<Run> {
    if !old.iter().any(|(_, m)| m.underline) {
        return new.to_vec();
    }
    let flags: Vec<(char, bool)> = old.iter().flat_map(|(t, m)| t.chars().map(|c| (c, m.underline))).collect();
    let target: Vec<char> = new.iter().flat_map(|(t, _)| t.chars()).collect();
    let prefix = flags.iter().zip(&target).take_while(|((a, _), b)| a == *b).count();
    let suffix =
        flags[prefix..].iter().rev().zip(target[prefix..].iter().rev()).take_while(|((a, _), b)| a == *b).count();
    let mut out = Vec::new();
    let mut at = 0;
    for (text, marks) in new {
        for c in text.chars() {
            let underline = if at < prefix {
                flags[at].1
            } else if at >= target.len() - suffix {
                flags[flags.len() - (target.len() - at)].1
            } else {
                false
            };
            let mut buffer = [0; 4];
            push(&mut out, c.encode_utf8(&mut buffer), &Marks { underline, ..marks.clone() });
            at += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPTURED: &str = "<a href=\"https://example.com/rv\">A</a> <i>paragraph</i> <del>written</del> <code>by</code> <b>RocketVibe</b>.";

    #[test]
    fn a_captured_block_reads_as_markdown_and_back() {
        let runs = from_html(CAPTURED);
        assert_eq!(plain(&runs), "A paragraph written by RocketVibe.");
        let md = to_markdown(&runs);
        assert_eq!(md, "[A](https://example.com/rv) *paragraph* ~~written~~ `by` **RocketVibe**.");
        assert_eq!(from_markdown(&md), runs);
        assert_eq!(to_html(&runs), CAPTURED);
    }

    #[test]
    fn entities_decode_and_encode() {
        let runs = from_html("a &amp; b &lt;c&gt; &#39;d&#x27;");
        assert_eq!(plain(&runs), "a & b <c> 'd'");
        assert_eq!(to_html(&runs), "a &amp; b &lt;c&gt; 'd'");
    }

    #[test]
    fn nested_marks_are_kept() {
        let runs = from_html("<b><i>both</i> bold</b>");
        assert_eq!(to_markdown(&runs), "***both* bold**");
        assert_eq!(from_markdown("***both* bold**"), runs);
        assert_eq!(runs[0].1, Marks { bold: true, italic: true, ..Marks::default() });
        assert_eq!(runs[1].1, Marks { bold: true, ..Marks::default() });
    }

    #[test]
    fn literal_marks_survive_being_escaped() {
        let runs = literal("2 * 3 and snake_case_word [x](y)");
        assert_eq!(from_markdown(&to_markdown(&runs)), runs);
    }

    #[test]
    fn stray_marks_stay_text() {
        for text in ["2 * 3 * 4", "snake_case_word", "**", "a ~~ b", "`open", "[x] y"] {
            assert_eq!(plain(&from_markdown(text)), text, "{text}");
        }
    }

    #[test]
    fn underscores_read_as_italic() {
        assert_eq!(to_markdown(&from_markdown("an _italic_ word")), "an *italic* word");
    }

    #[test]
    fn underline_stays_on_what_an_edit_left_alone() {
        let old = from_html("one <u>two</u> three");
        let new = keep_underline(&old, &from_markdown("one two three four"));
        assert_eq!(to_html(&new), "one <u>two</u> three four");
        let new = keep_underline(&old, &from_markdown("zero one two three"));
        assert_eq!(to_html(&new), "zero one <u>two</u> three");
    }
}
