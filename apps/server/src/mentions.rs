//! Conservative, bounded mention extraction. Code, quotes and link labels do not ping.
use crate::error::Result;
use sqlx::{Postgres, Transaction};
use std::collections::BTreeSet;

fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-')
}
fn boundary(c: char) -> bool {
    !c.is_alphanumeric() && !matches!(c, '_' | '-' | '.' | '@' | '/' | '\\')
}
// Source offsets retain escape information that normalized Markdown text loses.
fn scan(source: &str, span: std::ops::Range<usize>, out: &mut BTreeSet<String>) {
    let slice = &source[span.clone()];
    let chars: Vec<_> = slice.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        let at_boundary = i == 0 || boundary(chars[i - 1].1);
        if at_boundary {
            let prefix: String = chars[i..chars.len().min(i + 8)]
                .iter()
                .map(|c| c.1)
                .collect::<String>()
                .to_ascii_lowercase();
            if ["https://", "http://", "ftp://", "mailto:", "www."]
                .iter()
                .any(|p| prefix.starts_with(p))
            {
                while i < chars.len() && !chars[i].1.is_whitespace() {
                    i += 1;
                }
                continue;
            }
        }
        if chars[i].1 == '@' && at_boundary {
            let escaped = source.as_bytes()[..span.start + chars[i].0]
                .iter()
                .rev()
                .take_while(|&&b| b == b'\\')
                .count()
                % 2
                == 1;
            let start = i + 1;
            i = start;
            while i < chars.len() && name_char(chars[i].1) {
                i += 1;
            }
            let dotted = chars.get(i).is_some_and(|c| c.1 == '.')
                && chars.get(i + 1).is_some_and(|c| c.1.is_alphanumeric());
            let unicode_suffix = chars.get(i).is_some_and(|c| c.1.is_alphanumeric());
            let end = chars.get(i).map_or(span.end, |c| span.start + c.0);
            let tail = &source[end..];
            // Do not resolve a shorter account name from a source name that
            // continues through an HTML entity (e.g. @ali&#99;e).
            let encoded_suffix = tail.starts_with('&')
                && tail
                    .chars()
                    .take(34)
                    .take_while(|&c| c != ' ' && c != '\n')
                    .any(|c| c == ';');
            if !escaped
                && i > start
                && i - start <= 128
                && !dotted
                && !unicode_suffix
                && !encoded_suffix
            {
                out.insert(chars[start..i].iter().map(|c| c.1).collect());
            }
            continue;
        }
        i += 1;
    }
}
fn tokens(text: &str) -> BTreeSet<String> {
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
    let mut out = BTreeSet::new();
    let mut excluded = 0;
    for (event, span) in Parser::new_ext(text, Options::ENABLE_STRIKETHROUGH).into_offset_iter() {
        match event {
            Event::Start(
                Tag::CodeBlock(_) | Tag::BlockQuote(_) | Tag::Link { .. } | Tag::Image { .. },
            ) => excluded += 1,
            Event::End(
                TagEnd::CodeBlock | TagEnd::BlockQuote(_) | TagEnd::Link | TagEnd::Image,
            ) => excluded -= 1,
            Event::Text(_) if excluded == 0 => scan(text, span, &mut out),
            _ => (),
        }
    }
    out
}
pub(crate) async fn capture(
    tx: &mut Transaction<'_, Postgres>,
    message: &str,
    room: &str,
    author: &str,
    text: &str,
) -> Result<()> {
    let mut names = tokens(text);
    let all = names.remove("all");
    // @here depends on the online lease introduced by P12. It never means @all.
    names.remove("here");
    sqlx::query("INSERT INTO message_mentions(message_id,user_id,kind,token) SELECT $1,u.id,'direct',u.username FROM users u JOIN members m ON m.user_id=u.id WHERE m.room_id=$2 AND u.id<>$3 AND NOT u.disabled AND u.username=ANY($4) ON CONFLICT DO NOTHING")
        .bind(message).bind(room).bind(author).bind(names.into_iter().collect::<Vec<_>>()).execute(&mut **tx).await?;
    if all {
        sqlx::query("INSERT INTO message_mentions(message_id,user_id,kind,token) SELECT $1,u.id,'all','all' FROM users u JOIN members m ON m.user_id=u.id WHERE m.room_id=$2 AND u.id<>$3 AND NOT u.disabled ON CONFLICT DO NOTHING")
            .bind(message).bind(room).bind(author).execute(&mut **tx).await?;
    }
    Ok(())
}

/// Editing never adds recipients. Removing a token withdraws its original ping.
pub(crate) async fn retain(
    tx: &mut Transaction<'_, Postgres>,
    message: &str,
    text: Option<&str>,
) -> Result<bool> {
    let names = tokens(text.unwrap_or(""));
    let result =
        sqlx::query("DELETE FROM message_mentions WHERE message_id=$1 AND NOT token=ANY($2)")
            .bind(message)
            .bind(names.into_iter().collect::<Vec<_>>())
            .execute(&mut **tx)
            .await?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::tokens;
    #[test]
    fn exact_tokens_deduplicate_and_do_not_extract_partial_names() {
        assert_eq!(
            tokens("@alice @alice * @bob-user _ @all @here @Bob @alice. @alice.org @aliceé"),
            ["Bob", "alice", "all", "bob-user", "here"]
                .into_iter()
                .map(String::from)
                .collect()
        );
    }
    #[test]
    fn code_and_quotes_do_not_ping_including_multiline_inline_code() {
        assert_eq!(
            tokens(
                "@outside `@inline` ``@wide`@code`` `@first\n@second`\n\n```rust\n@fenced\n```\n\n~~~\n@tilde\n~~~\n\n> @quote\n\n    @indent\n\t@tab"
            ),
            ["outside"].into_iter().map(String::from).collect()
        );
    }
    #[test]
    fn escaping_emails_autolinks_and_labelled_links_do_not_ping() {
        assert_eq!(
            tokens(
                r"\@escaped user@host.tld https://a.test/@path?x=@query FTP://a/@ftp mailto:@mail www.a.test/@www <https://a/@angle> [@label](https://a/(@nested)) @real"
            ),
            ["real"].into_iter().map(String::from).collect()
        );
    }
    #[test]
    fn brackets_without_a_destination_remain_text_and_labels_can_be_nested() {
        assert_eq!(
            tokens("[@visible] [[@nested]](url) @after"),
            ["after", "visible"].into_iter().map(String::from).collect()
        );
    }
    #[test]
    fn styled_mentions_and_reference_links_use_the_markdown_structure() {
        assert_eq!(
            tokens(
                "_@italic_ **@bold** ~~@strike~~ [@reference][ref] ![@image](url)\n\n[ref]: https://example.test"
            ),
            ["bold", "italic", "strike"]
                .into_iter()
                .map(String::from)
                .collect()
        );
    }
    #[test]
    fn entity_encoded_names_do_not_ping_a_shorter_account() {
        assert!(tokens("@ali&#99;e &#64;bob @b&ouml;b").is_empty());
    }
}
