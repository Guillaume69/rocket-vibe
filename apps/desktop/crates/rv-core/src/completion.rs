//! `@mention` and `:emoji` completion in the composer: what is being typed
//! at the cursor, and what to offer for it.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Mention,
    Emoji,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Query {
    pub trigger: Trigger,
    /// Char offset of the trigger character in the text.
    pub start: usize,
    pub prefix: String,
}

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || "._+-".contains(c)
}

/// The completion under way when the text before the cursor ends with
/// `@pre` or `:pre`, the trigger opening a word. `:` needs a letter first:
/// `10:30` or a lone `:` is not an emoji being typed.
pub fn query(before_cursor: &str) -> Option<Query> {
    let chars: Vec<char> = before_cursor.chars().collect();
    let mut i = chars.len();
    while i > 0 && word_char(chars[i - 1]) {
        i -= 1;
    }
    let trigger = match chars.get(i.checked_sub(1)?)? {
        '@' => Trigger::Mention,
        ':' => Trigger::Emoji,
        _ => return None,
    };
    let start = i - 1;
    if start > 0 && !chars[start - 1].is_whitespace() {
        return None;
    }
    let prefix: String = chars[i..].iter().collect();
    if trigger == Trigger::Emoji && prefix.is_empty() {
        return None;
    }
    Some(Query { trigger, start, prefix })
}

/// Recent authors first, then `@all` and `@here`; a case-insensitive prefix
/// on the username. A bare `@` offers everyone.
pub fn mentions(prefix: &str, recent: &[String], me: &str, limit: usize) -> Vec<String> {
    let prefix = prefix.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for name in recent.iter().map(String::as_str).chain(["all", "here"]) {
        if name != me && name.to_lowercase().starts_with(&prefix) && !out.iter().any(|n| n == name) {
            out.push(name.to_owned());
        }
    }
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_word_being_typed() {
        assert_eq!(query("hi @bo"), Some(Query { trigger: Trigger::Mention, start: 3, prefix: "bo".into() }));
        assert_eq!(query("@"), Some(Query { trigger: Trigger::Mention, start: 0, prefix: String::new() }));
        assert_eq!(query("so :smi"), Some(Query { trigger: Trigger::Emoji, start: 3, prefix: "smi".into() }));
        assert_eq!(query("at 10:30"), None);
        assert_eq!(query("mail@example"), None);
        assert_eq!(query("done :"), None);
        assert_eq!(query("@bob "), None);
        assert_eq!(query("é @jé"), Some(Query { trigger: Trigger::Mention, start: 2, prefix: "jé".into() }));
    }

    #[test]
    fn mention_candidates() {
        let recent = vec!["bob".to_owned(), "alice".to_owned(), "Bernard".to_owned(), "bob".to_owned()];
        assert_eq!(mentions("b", &recent, "alice", 10), ["bob", "Bernard"]);
        assert_eq!(mentions("", &recent, "alice", 10), ["bob", "Bernard", "all", "here"]);
        assert_eq!(mentions("h", &recent, "alice", 10), ["here"]);
        assert_eq!(mentions("", &recent, "alice", 2).len(), 2);
    }
}
