//! A canvas's blocks as the markdown the apps render and edit, and back.
//! One block per line: inline formatting is not carried (none was captured).

use crate::model::*;

/// What a block is, for writing and for comparing an edit with the canvas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// A text section in a style (plain, a heading, code, quote).
    Text(u64),
    /// An item of a list in a style (bullet, numbered, checklist).
    Item(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub kind: Kind,
    pub text: String,
}

pub fn lines_of(canvas: &Canvas) -> Vec<Line> {
    canvas
        .blocks()
        .into_iter()
        .map(|block| match block {
            Block::Text(s) => Line { kind: Kind::Text(s.style), text: s.text.trim_end().to_owned() },
            Block::Item { list, item } => Line { kind: Kind::Item(list.style), text: item.text.trim_end().to_owned() },
        })
        .collect()
}

pub fn to_markdown(canvas: &Canvas) -> String {
    render(&lines_of(canvas))
}

pub fn render(lines: &[Line]) -> String {
    let mut out = String::new();
    let mut previous: Option<&Kind> = None;
    let mut number = 0;
    for (i, line) in lines.iter().enumerate() {
        let in_code = matches!(line.kind, Kind::Text(STYLE_CODE));
        let was_code = matches!(previous, Some(Kind::Text(STYLE_CODE)));
        let same_list = matches!((previous, &line.kind), (Some(Kind::Item(a)), Kind::Item(b)) if a == b);
        if was_code && !in_code {
            out.push_str("```\n");
        }
        if i > 0 && !same_list && !(was_code && in_code) {
            out.push('\n');
        }
        if in_code && !was_code {
            out.push_str("```\n");
        }
        number = if same_list { number + 1 } else { 1 };
        match line.kind {
            Kind::Text(STYLE_CODE) => out.push_str(&line.text),
            Kind::Text(STYLE_QUOTE) => out.push_str(&format!("> {}", line.text)),
            Kind::Text(style) => match STYLE_HEADINGS.iter().position(|h| *h == style) {
                Some(level) => out.push_str(&format!("{} {}", "#".repeat(level + 1), line.text)),
                None => out.push_str(&line.text),
            },
            Kind::Item(STYLE_NUMBERED) => out.push_str(&format!("{number}. {}", line.text)),
            Kind::Item(STYLE_CHECKLIST) => out.push_str(&format!("- [ ] {}", line.text)),
            Kind::Item(_) => out.push_str(&format!("- {}", line.text)),
        }
        out.push('\n');
        previous = Some(&line.kind);
    }
    if matches!(previous, Some(Kind::Text(STYLE_CODE))) {
        out.push_str("```\n");
    }
    out
}

pub fn parse(markdown: &str) -> Vec<Line> {
    let mut out = Vec::new();
    let mut in_code = false;
    for raw in markdown.lines() {
        if raw.trim_start().starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            out.push(Line { kind: Kind::Text(STYLE_CODE), text: raw.to_owned() });
            continue;
        }
        let line = raw.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let trimmed = line.trim_start();
        let (kind, text) = if let Some(rest) = heading(trimmed) {
            rest
        } else if let Some(rest) = trimmed.strip_prefix("> ").or_else(|| trimmed.strip_prefix('>')) {
            (Kind::Text(STYLE_QUOTE), rest.to_owned())
        } else if let Some(rest) = checkbox(trimmed) {
            (Kind::Item(STYLE_CHECKLIST), rest.to_owned())
        } else if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
            (Kind::Item(STYLE_BULLET), rest.to_owned())
        } else if let Some(rest) = numbered(trimmed) {
            (Kind::Item(STYLE_NUMBERED), rest.to_owned())
        } else {
            (Kind::Text(STYLE_PLAIN), line.to_owned())
        };
        out.push(Line { kind, text });
    }
    out
}

fn heading(line: &str) -> Option<(Kind, String)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    let rest = line[hashes..].strip_prefix(' ')?;
    (1..=6).contains(&hashes).then(|| (Kind::Text(STYLE_HEADINGS[hashes - 1]), rest.to_owned()))
}

fn checkbox(line: &str) -> Option<&str> {
    ["- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] "].iter().find_map(|p| line.strip_prefix(p))
}

fn numbered(line: &str) -> Option<&str> {
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    (digits > 0).then(|| line[digits..].strip_prefix(". ")).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_round_trips_through_lines() {
        let md = "# Title\n\nA paragraph.\n\n- one\n- two\n\n1. first\n2. second\n\n- [ ] task\n\n> quoted\n\n```\nlet x = 1;\nlet y = 2;\n```\n";
        let lines = parse(md);
        assert_eq!(lines.len(), 10);
        assert_eq!(lines[0], Line { kind: Kind::Text(1), text: "Title".into() });
        assert_eq!(lines[4].kind, Kind::Item(STYLE_NUMBERED));
        assert_eq!(lines[6].kind, Kind::Item(STYLE_CHECKLIST));
        assert_eq!(render(&lines), md);
    }
}
