//! Formatting a draft as Rocket.Chat reads it (`*bold*`, `_italic_`, `~strike~`,
//! `` `code` ``, fences, `> ` quotes, `# ` headings, lists): toolbar edits that
//! toggle markers around a selection or before its lines, and the spans the
//! composer styles as the draft is typed. Offsets count chars, as GTK's do.

/// A draft after an edit, and the selection to leave in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edited {
    pub text: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Quote,
    Heading,
    Bullet,
    Numbered,
}

fn chars(text: &str) -> Vec<char> {
    text.chars().collect()
}

fn string(chars: &[char]) -> String {
    chars.iter().collect()
}

/// Wraps the selection in `marker`, or unwraps it when the markers are already
/// there (just outside the selection, or its own first and last chars). An
/// empty selection gets a pair with the cursor between.
pub fn toggle_wrap(text: &str, start: usize, end: usize, marker: &str) -> Edited {
    let c = chars(text);
    let m = chars(marker);
    let (start, end) = (start.min(c.len()), end.min(c.len()).max(start.min(c.len())));
    let n = m.len();
    let outside = start >= n && end + n <= c.len() && c[start - n..start] == m[..] && c[end..end + n] == m[..];
    if outside && start < end {
        let mut out = c[..start - n].to_vec();
        out.extend_from_slice(&c[start..end]);
        out.extend_from_slice(&c[end + n..]);
        return Edited { text: string(&out), start: start - n, end: end - n };
    }
    let inside = end - start >= 2 * n && c[start..start + n] == m[..] && c[end - n..end] == m[..];
    if inside {
        let mut out = c[..start].to_vec();
        out.extend_from_slice(&c[start + n..end - n]);
        out.extend_from_slice(&c[end..]);
        return Edited { text: string(&out), start, end: end - 2 * n };
    }
    let mut out = c[..start].to_vec();
    out.extend_from_slice(&m);
    out.extend_from_slice(&c[start..end]);
    out.extend_from_slice(&m);
    out.extend_from_slice(&c[end..]);
    Edited { text: string(&out), start: start + n, end: end + n }
}

fn line_prefix(kind: LineKind, number: usize) -> String {
    match kind {
        LineKind::Quote => "> ".into(),
        LineKind::Heading => "# ".into(),
        LineKind::Bullet => "- ".into(),
        LineKind::Numbered => format!("{number}. "),
    }
}

/// The prefix a line already has for `kind`, in chars.
fn has_prefix(line: &str, kind: LineKind) -> Option<usize> {
    match kind {
        LineKind::Numbered => {
            let digits = line.chars().take_while(char::is_ascii_digit).count();
            (digits > 0 && line[digits..].starts_with(". ")).then_some(digits + 2)
        }
        _ => line.starts_with(&line_prefix(kind, 0)).then_some(2),
    }
}

/// Toggles `kind` on every line the selection touches: added to those without
/// it when one lacks it, removed from all otherwise. Numbered lines count from 1.
pub fn toggle_lines(text: &str, start: usize, end: usize, kind: LineKind) -> Edited {
    let c = chars(text);
    let (start, end) = (start.min(c.len()), end.min(c.len()).max(start.min(c.len())));
    let first = c[..start].iter().rposition(|&ch| ch == '\n').map_or(0, |i| i + 1);
    let last = c[end..].iter().position(|&ch| ch == '\n').map_or(c.len(), |i| end + i);
    let block = string(&c[first..last]);
    let lines: Vec<&str> = block.split('\n').collect();
    let all = lines.iter().all(|l| has_prefix(l, kind).is_some());
    let mut shift_start = 0isize;
    let mut new_lines = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        let (new, delta) = match (all, has_prefix(line, kind)) {
            (true, Some(len)) => (line.chars().skip(len).collect::<String>(), -(len as isize)),
            (false, Some(_)) => ((*line).to_owned(), 0),
            _ => {
                let prefix = line_prefix(kind, i + 1);
                (format!("{prefix}{line}"), prefix.chars().count() as isize)
            }
        };
        if i == 0 {
            shift_start = delta;
        }
        new_lines.push(new);
    }
    let replaced = new_lines.join("\n");
    let total = replaced.chars().count() as isize - block.chars().count() as isize;
    let mut out = c[..first].to_vec();
    out.extend(replaced.chars());
    out.extend_from_slice(&c[last..]);
    let clamp = |v: isize, floor: usize| v.max(floor as isize) as usize;
    Edited {
        text: string(&out),
        start: clamp(start as isize + shift_start, first),
        end: clamp(end as isize + total, first),
    }
}

/// The selection as a fenced code block, on lines of its own.
pub fn code_block(text: &str, start: usize, end: usize) -> Edited {
    let c = chars(text);
    let (start, end) = (start.min(c.len()), end.min(c.len()).max(start.min(c.len())));
    let before = if start > 0 && c[start - 1] != '\n' { "\n" } else { "" };
    let after = if end < c.len() && c[end] != '\n' { "\n" } else { "" };
    let open = format!("{before}```\n");
    let mut out = c[..start].to_vec();
    out.extend(open.chars());
    out.extend_from_slice(&c[start..end]);
    out.extend(format!("\n```{after}").chars());
    out.extend_from_slice(&c[end..]);
    let inner = start + open.chars().count();
    Edited { text: string(&out), start: inner, end: inner + (end - start) }
}

/// `[selection](https://)`, the address selected to be typed over.
pub fn link(text: &str, start: usize, end: usize) -> Edited {
    let c = chars(text);
    let (start, end) = (start.min(c.len()), end.min(c.len()).max(start.min(c.len())));
    let address = "https://";
    let mut out = c[..start].to_vec();
    out.push('[');
    out.extend_from_slice(&c[start..end]);
    out.extend("](".chars());
    let at = out.len();
    out.extend(address.chars());
    out.push(')');
    out.extend_from_slice(&c[end..]);
    Edited { text: string(&out), start: at, end: at + address.len() }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Style {
    Bold,
    Italic,
    Strike,
    Code,
    CodeBlock,
    Heading,
    Quote,
    /// Markdown syntax itself (`*`, `> `, `- `…): shown dimmed.
    Marker,
}

/// A styled run of the draft, in chars.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub style: Style,
}

fn style_of(marker: char) -> Style {
    match marker {
        '*' => Style::Bold,
        '_' => Style::Italic,
        '~' => Style::Strike,
        _ => Style::Code,
    }
}

/// Inline markers of one line, from `from` to `to` (chars of `c`).
fn inline(c: &[char], from: usize, to: usize, out: &mut Vec<Span>) {
    let mut i = from;
    while i < to {
        let ch = c[i];
        if matches!(ch, '*' | '_' | '~' | '`') && i + 1 < to && !c[i + 1].is_whitespace() {
            let close = (i + 2..to).find(|&j| c[j] == ch && !c[j - 1].is_whitespace());
            if let Some(j) = close {
                out.push(Span { start: i, end: i + 1, style: Style::Marker });
                out.push(Span { start: i + 1, end: j, style: style_of(ch) });
                out.push(Span { start: j, end: j + 1, style: Style::Marker });
                if ch != '`' {
                    inline(c, i + 1, j, out);
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
}

/// What the composer styles in a draft.
pub fn spans(text: &str) -> Vec<Span> {
    let c = chars(text);
    let mut out = Vec::new();
    let mut line_start = 0;
    let mut fenced = false;
    while line_start <= c.len() {
        let line_end = c[line_start..].iter().position(|&ch| ch == '\n').map_or(c.len(), |i| line_start + i);
        let line = string(&c[line_start..line_end]);
        if line.trim_start().starts_with("```") {
            out.push(Span { start: line_start, end: line_end, style: Style::Marker });
            fenced = !fenced;
        } else if fenced {
            out.push(Span { start: line_start, end: line_end, style: Style::CodeBlock });
        } else {
            let mut body = line_start;
            for (kind, style) in [(LineKind::Heading, Some(Style::Heading)), (LineKind::Quote, Some(Style::Quote))] {
                if let Some(len) = has_prefix(&line, kind) {
                    out.push(Span { start: line_start, end: line_start + len, style: Style::Marker });
                    if let Some(style) = style {
                        let from = if style == Style::Quote { line_start } else { line_start + len };
                        out.push(Span { start: from, end: line_end, style });
                    }
                    body = line_start + len;
                }
            }
            for kind in [LineKind::Bullet, LineKind::Numbered] {
                if let Some(len) = has_prefix(&line, kind) {
                    out.push(Span { start: line_start, end: line_start + len, style: Style::Marker });
                    body = line_start + len;
                }
            }
            inline(&c, body, line_end, &mut out);
        }
        if line_end == c.len() {
            break;
        }
        line_start = line_end + 1;
    }
    out
}

/// The markers the composer hides so the draft reads as formatted text: the
/// inline ones and the heading and quote prefixes, except on the line holding
/// the cursor, where they show to be edited. Bullets, numbers and fences stay.
pub fn hidden_markers(text: &str, cursor: usize) -> Vec<(usize, usize)> {
    let c = chars(text);
    let line_of = |i: usize| c[..i.min(c.len())].iter().filter(|&&ch| ch == '\n').count();
    let cursor_line = line_of(cursor);
    spans(text)
        .into_iter()
        .filter(|s| s.style == Style::Marker)
        .filter(|s| {
            let marker: String = c[s.start..s.end].iter().collect();
            let line_start = s.start == 0 || c[s.start - 1] == '\n';
            let kept = line_start
                && (marker.starts_with("```")
                    || has_prefix(&marker, LineKind::Bullet).is_some()
                    || has_prefix(&marker, LineKind::Numbered).is_some());
            !kept && line_of(s.start) != cursor_line
        })
        .map(|s| (s.start, s.end))
        .collect()
}

/// The words of a draft worth a spell check, in chars: not in code, not part
/// of a link, a mention, a channel or a `:shortcode:`, and without digits.
pub fn words(text: &str) -> Vec<(usize, usize)> {
    let c = chars(text);
    let code: Vec<(usize, usize)> = spans(text)
        .into_iter()
        .filter(|s| matches!(s.style, Style::Code | Style::CodeBlock))
        .map(|s| (s.start, s.end))
        .collect();
    let in_code = |i: usize| code.iter().any(|&(a, b)| i >= a && i < b);
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        if c[i].is_whitespace() {
            i += 1;
            continue;
        }
        let token_end = (i..c.len()).find(|&j| c[j].is_whitespace()).unwrap_or(c.len());
        let token: String = c[i..token_end].iter().collect();
        let skipped = token.contains("://")
            || token.starts_with("www.")
            || token.starts_with('@')
            || token.starts_with('#')
            || token.matches(':').count() >= 2
            || token.contains(['/', '\\', '=', '<', '>', '`']);
        if !skipped {
            let mut j = i;
            while j < token_end {
                while j < token_end && !c[j].is_alphanumeric() {
                    j += 1;
                }
                let start = j;
                while j < token_end
                    && (c[j].is_alphanumeric()
                        || (matches!(c[j], '\'' | '’' | '-') && j + 1 < token_end && c[j + 1].is_alphabetic()))
                {
                    j += 1;
                }
                let word = &c[start..j];
                if word.len() > 1 && !word.iter().any(char::is_ascii_digit) && !in_code(start) {
                    out.push((start, j));
                }
            }
        }
        i = token_end;
    }
    out
}

/// Shift+Enter on a list item: the next item's marker, the same bullet or
/// the next number, at the same indentation. On an item left empty the marker
/// goes and the list ends. None where a plain line break is right: outside a
/// list, before the marker, or inside a code block.
pub fn list_break(text: &str, cursor: usize) -> Option<Edited> {
    let c = chars(text);
    let cursor = cursor.min(c.len());
    let line_start = c[..cursor].iter().rposition(|&ch| ch == '\n').map_or(0, |i| i + 1);
    let line_end = c[line_start..].iter().position(|&ch| ch == '\n').map_or(c.len(), |i| line_start + i);
    let fences = string(&c[..line_start]).lines().filter(|l| l.trim_start().starts_with("```")).count();
    if fences % 2 == 1 {
        return None;
    }
    let line = string(&c[line_start..line_end]);
    let indent: String = line.chars().take_while(|ch| *ch == ' ' || *ch == '\t').collect();
    let rest = &line[indent.len()..];
    let (marker_len, next) = if rest.starts_with("- ") || rest.starts_with("* ") {
        (2, rest[..2].to_owned())
    } else {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 || !rest[digits..].starts_with(". ") {
            return None;
        }
        let number: u64 = rest[..digits].parse().ok()?;
        (digits + 2, format!("{}. ", number + 1))
    };
    let body_start = line_start + indent.chars().count() + marker_len;
    if cursor < body_start {
        return None;
    }
    if string(&c[body_start..line_end]).trim().is_empty() {
        let text = string(&c[..line_start]) + &string(&c[line_end..]);
        return Some(Edited { text, start: line_start, end: line_start });
    }
    let inserted = format!("\n{indent}{next}");
    let at = cursor + inserted.chars().count();
    Some(Edited { text: string(&c[..cursor]) + &inserted + &string(&c[cursor..]), start: at, end: at })
}

/// Code fences as Rocket.Chat's parser needs them, each on a line of its
/// own: a fence closed at the end of a line, or opened and closed on one,
/// would otherwise post a list or stray backticks where the draft showed a
/// code block. A word right after the
/// opening fence stays there, as the language.
pub fn fenced(text: &str) -> String {
    if !text.contains("```") {
        return text.to_owned();
    }
    let language = |rest: &str| rest.chars().all(|c| c.is_ascii_alphanumeric() || "+#_-.".contains(c));
    let mut out: Vec<String> = Vec::new();
    let mut open = false;
    for line in text.split('\n') {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("```") {
            if open {
                out.push("```".to_owned());
                if !rest.trim().is_empty() {
                    out.push(rest.trim_start().to_owned());
                }
                open = false;
            } else if let Some((inside, after)) = rest.split_once("```") {
                out.extend(["```".to_owned(), inside.to_owned(), "```".to_owned()]);
                if !after.trim().is_empty() {
                    out.push(after.trim_start().to_owned());
                }
            } else if language(rest.trim_end()) {
                out.push(line.to_owned());
                open = true;
            } else {
                out.extend(["```".to_owned(), rest.to_owned()]);
                open = true;
            }
        } else if let Some(inside) = line.trim_end().strip_suffix("```").filter(|_| open) {
            out.extend([inside.to_owned(), "```".to_owned()]);
            open = false;
        } else {
            out.push(line.to_owned());
        }
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_breaks_continue_bullets_and_numbers() {
        let at_end = |t: &str| list_break(t, t.chars().count()).map(|e| (e.text, e.start));
        assert_eq!(at_end("- one"), Some(("- one\n- ".into(), 8)));
        assert_eq!(at_end("intro\n* one"), Some(("intro\n* one\n* ".into(), 14)));
        assert_eq!(at_end("9. nine"), Some(("9. nine\n10. ".into(), 12)));
        assert_eq!(at_end("  - sub"), Some(("  - sub\n  - ".into(), 12)));
        assert_eq!(at_end("- one\n- "), Some(("- one\n".into(), 6)));
        assert_eq!(at_end("- one\n3. "), Some(("- one\n".into(), 6)));
        assert_eq!(at_end("plain"), None);
        assert_eq!(at_end("-dash"), None);
        assert_eq!(at_end("```\n- in code"), None);
        assert_eq!(at_end("```\ncode\n```\n- after"), Some(("```\ncode\n```\n- after\n- ".into(), 23)));
        assert_eq!(list_break("- one two", 5).map(|e| e.text), Some("- one\n-  two".into()));
        assert_eq!(list_break("- one", 1), None);
    }

    #[test]
    fn fences_get_lines_of_their_own() {
        assert_eq!(fenced("```\n- one\n- two```"), "```\n- one\n- two\n```");
        assert_eq!(fenced("```- one\n- two```"), "```\n- one\n- two\n```");
        assert_eq!(fenced("```-ZOB-```"), "```\n-ZOB-\n```");
        assert_eq!(fenced("see ```x```"), "see ```x```");
        assert_eq!(fenced("```rust\nfn a() {}\n``` done"), "```rust\nfn a() {}\n```\ndone");
        assert_eq!(fenced("```\nok\n```"), "```\nok\n```");
        assert_eq!(fenced("```x``` after"), "```\nx\n```\nafter");
        assert_eq!(fenced("no code"), "no code");
        assert_eq!(fenced("```\nleft open"), "```\nleft open");
    }

    fn edit(text: &str, start: usize, end: usize) -> Edited {
        Edited { text: text.into(), start, end }
    }

    #[test]
    fn wrapping_toggles() {
        assert_eq!(toggle_wrap("say hi now", 4, 6, "*"), edit("say *hi* now", 5, 7));
        assert_eq!(toggle_wrap("say *hi* now", 5, 7, "*"), edit("say hi now", 4, 6));
        assert_eq!(toggle_wrap("say *hi* now", 4, 8, "*"), edit("say hi now", 4, 6));
        assert_eq!(toggle_wrap("", 0, 0, "~"), edit("~~", 1, 1));
        assert_eq!(toggle_wrap("café", 0, 4, "_"), edit("_café_", 1, 5));
    }

    #[test]
    fn lines_toggle_together() {
        assert_eq!(toggle_lines("a\nb", 0, 3, LineKind::Quote), edit("> a\n> b", 2, 7));
        assert_eq!(toggle_lines("> a\n> b", 2, 7, LineKind::Quote), edit("a\nb", 0, 3));
        assert_eq!(toggle_lines("x\ny\nz", 2, 5, LineKind::Numbered), edit("x\n1. y\n2. z", 5, 11));
        assert_eq!(toggle_lines("- a\nb", 0, 5, LineKind::Bullet), edit("- a\n- b", 0, 7));
        assert_eq!(toggle_lines("", 0, 0, LineKind::Heading), edit("# ", 2, 2));
    }

    #[test]
    fn blocks_and_links() {
        assert_eq!(code_block("see x", 4, 5), edit("see \n```\nx\n```", 9, 10));
        assert_eq!(link("site", 0, 4), edit("[site](https://)", 7, 15));
    }

    #[test]
    fn spans_style_the_draft() {
        let s = spans("a *b* _c_");
        assert!(s.contains(&Span { start: 3, end: 4, style: Style::Bold }));
        assert!(s.contains(&Span { start: 7, end: 8, style: Style::Italic }));
        assert!(s.contains(&Span { start: 2, end: 3, style: Style::Marker }));
        assert!(spans("a * b *").is_empty());
        let s = spans("> quoted\n```\ncode *x*\n```\n# title");
        assert!(s.contains(&Span { start: 0, end: 8, style: Style::Quote }));
        assert!(s.contains(&Span { start: 13, end: 21, style: Style::CodeBlock }));
        assert!(!s.iter().any(|x| x.style == Style::Bold));
        assert!(s.contains(&Span { start: 28, end: 33, style: Style::Heading }));
        let s = spans("`*not bold*`");
        assert!(!s.iter().any(|x| x.style == Style::Bold));
    }

    #[test]
    fn words_worth_checking() {
        let text = "Hello team's café, see https://x.org @bob #général :smile: `codé` v2 à-la-carte *bold*";
        let found: Vec<String> = words(text).iter().map(|&(a, b)| text.chars().skip(a).take(b - a).collect()).collect();
        assert_eq!(found, ["Hello", "team's", "café", "see", "à-la-carte", "bold"]);
    }

    #[test]
    fn markers_hide_away_from_the_cursor() {
        let text = "# Title\n*bold* - no\n- item\n```\nx\n```";
        let hidden = hidden_markers(text, text.len());
        let shown: Vec<String> = hidden.iter().map(|&(a, b)| text.chars().skip(a).take(b - a).collect()).collect();
        assert_eq!(shown, ["# ", "*", "*"]);
        assert!(hidden_markers(text, 9).iter().all(|&(a, _)| a < 8));
    }
}
