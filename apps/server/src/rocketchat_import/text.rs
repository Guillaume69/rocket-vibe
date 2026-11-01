//! The pure part of the import: names, message text, reactions and quotes
//! turned from Rocket.Chat's form into Vibez's.

use std::collections::HashMap;

/// A Vibez username for a Rocket.Chat one: Vibez allows `[A-Za-z0-9_-]` only,
/// so `rocket.cat` becomes `rocket_cat`. Collisions are resolved by the caller.
pub fn username(rc: &str) -> String {
    let mut name: String = rc
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    if name.is_empty() {
        name.push_str("user");
    }
    if crate::auth::reserved_username(&name) {
        name.insert_str(0, "rc_");
    }
    name
}

/// A Vibez message id for a Rocket.Chat one, the same on every pass.
pub fn message_id(rc: &str) -> String {
    let id = format!("rc-{rc}");
    if crate::auth::identifier(&id) {
        id
    } else {
        format!("rc-{}", &crate::auth::hash_token(rc)[..40])
    }
}

/// A custom emoji name Vibez accepts: lowercase, digits, `_`, `+`, `-`.
pub fn emoji_name(rc: &str) -> Option<String> {
    let name: String = rc
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || "_+-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    (!name.is_empty()).then_some(name)
}

/// Rocket.Chat writes a quote as `[ ](<link to the message>)` in front of the
/// reply; the quoted message travels as an attachment, so the link goes.
pub fn without_quote_links(text: &str) -> &str {
    let mut rest = text;
    while let Some(after) = rest.strip_prefix("[ ](") {
        match after.find(')') {
            Some(end) => rest = after[end + 1..].trim_start(),
            None => break,
        }
    }
    rest
}

/// The message id a Rocket.Chat permalink names (`...?msg=<id>`).
pub fn linked_message(link: &str) -> Option<&str> {
    let query = link.split_once('?')?.1;
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("msg="))
        .map(|id| id.split('#').next().unwrap_or(id))
        .filter(|id| !id.is_empty())
}

/// `@name` mentions renamed along with their account (`@rocket.cat` →
/// `@rocket_cat`); `@all`, `@here` and unknown names stay as written.
pub fn renamed_mentions(text: &str, renamed: &HashMap<String, String>) -> String {
    if renamed.is_empty() || !text.contains('@') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('@') {
        let (before, after) = rest.split_at(at);
        out.push_str(before);
        let name_len = after[1..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || "._-".contains(c)))
            .unwrap_or(after.len() - 1);
        let mut name = &after[1..1 + name_len];
        // A sentence ending right after the name keeps its full stop.
        while name.ends_with('.') {
            name = &name[..name.len() - 1];
        }
        let attached = before
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric());
        match renamed.get(name).filter(|_| !attached) {
            Some(new) => {
                out.push('@');
                out.push_str(new);
            }
            None => {
                out.push('@');
                out.push_str(name);
            }
        }
        rest = &after[1 + name.len()..];
    }
    out.push_str(rest);
    out
}

/// A Vibez reaction for a Rocket.Chat one (`:+1:`): a standard shortname, or
/// the name of a custom emoji this import created.
pub fn reaction(rc: &str, custom: &HashMap<String, String>) -> Option<String> {
    let code = rc
        .strip_prefix(':')
        .and_then(|s| s.strip_suffix(':'))
        .unwrap_or(rc);
    rv_protocol::emojis::canonical(code)
        .map(str::to_owned)
        .or_else(|| custom.get(code).cloned())
}

/// `value` cut to `max` bytes on a character boundary.
pub fn bounded(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

/// A quote whose message did not come over, written into the text instead.
pub fn quoted_text(author: Option<&str>, text: &str) -> String {
    let mut out = String::new();
    if let Some(author) = author.filter(|a| !a.is_empty()) {
        out.push_str(&format!("> **{author}**\n"));
    }
    for line in text.lines() {
        out.push_str("> ");
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_keep_the_characters_vibez_allows() {
        assert_eq!(username("rocket.cat"), "rocket_cat");
        assert_eq!(username("marc-etienne.barrut"), "marc-etienne_barrut");
        assert_eq!(username("bob"), "bob");
        assert_eq!(username("deleted-x"), "rc_deleted-x");
        assert_eq!(username("é"), "_");
        assert!(crate::auth::identifier(&username("a b@c")));
    }

    #[test]
    fn message_ids_are_stable_identifiers() {
        assert_eq!(message_id("nKaXNL9ckiRzyfKFK"), "rc-nKaXNL9ckiRzyfKFK");
        let odd = message_id("a/b c");
        assert!(crate::auth::identifier(&odd));
        assert_eq!(odd, message_id("a/b c"));
    }

    #[test]
    fn quote_links_and_permalinks() {
        assert_eq!(
            without_quote_links("[ ](http://h/channel/x?msg=abc) [ ](http://h/x?msg=d) reply"),
            "reply"
        );
        assert_eq!(without_quote_links("plain [ ] text"), "plain [ ] text");
        assert_eq!(
            linked_message("http://h/channel/test?msg=nKaXNL9cki"),
            Some("nKaXNL9cki")
        );
        assert_eq!(
            linked_message("http://h/direct/a?x=1&msg=zz#frag"),
            Some("zz")
        );
        assert_eq!(linked_message("http://h/channel/test"), None);
    }

    #[test]
    fn mentions_follow_renamed_accounts() {
        let renamed = HashMap::from([("rocket.cat".to_owned(), "rocket_cat".to_owned())]);
        assert_eq!(
            renamed_mentions("hi @rocket.cat. and @bob, @all", &renamed),
            "hi @rocket_cat. and @bob, @all"
        );
        assert_eq!(
            renamed_mentions("mail me@rocket.cat", &renamed),
            "mail me@rocket.cat"
        );
        assert_eq!(renamed_mentions("@", &renamed), "@");
    }

    #[test]
    fn reactions_become_shortnames_or_imported_emoji() {
        let custom = HashMap::from([("party_parrot".to_owned(), "party_parrot".to_owned())]);
        assert_eq!(
            reaction(":+1:", &custom),
            rv_protocol::emojis::canonical("+1").map(str::to_owned)
        );
        assert_eq!(
            reaction(":party_parrot:", &custom).as_deref(),
            Some("party_parrot")
        );
        assert_eq!(reaction(":nope_not_here:", &custom), None);
        assert_eq!(
            emoji_name("Party Parrot!").as_deref(),
            Some("party_parrot_")
        );
    }

    #[test]
    fn bounded_text_and_inline_quotes() {
        assert_eq!(bounded("héllo", 2), "h");
        assert_eq!(bounded("abc", 10), "abc");
        assert_eq!(quoted_text(Some("bob"), "a\nb"), "> **bob**\n> a\n> b\n");
    }
}
