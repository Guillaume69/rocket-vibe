//! Source mention recognition is shared with the canonical native renderer.
use crate::error::Result;
use rv_protocol::markdown::mention_names as tokens;
use sqlx::{Postgres, Transaction};

pub(crate) async fn capture(
    tx: &mut Transaction<'_, Postgres>,
    message: &str,
    room: &str,
    author: &str,
    text: &str,
) -> Result<()> {
    let mut names = tokens(text);
    let all = names.remove("all");
    let here = names.remove("here");
    sqlx::query("INSERT INTO message_mentions(message_id,user_id,kind,token) SELECT $1,u.id,'direct',u.username FROM users u JOIN members m ON m.user_id=u.id WHERE m.room_id=$2 AND u.id<>$3 AND NOT u.disabled AND u.username=ANY($4) ON CONFLICT DO NOTHING")
        .bind(message).bind(room).bind(author).bind(names.into_iter().collect::<Vec<_>>()).execute(&mut **tx).await?;
    if all {
        sqlx::query("INSERT INTO message_mentions(message_id,user_id,kind,token) SELECT $1,u.id,'all','all' FROM users u JOIN members m ON m.user_id=u.id WHERE m.room_id=$2 AND u.id<>$3 AND NOT u.disabled ON CONFLICT DO NOTHING")
            .bind(message).bind(room).bind(author).execute(&mut **tx).await?;
    }
    if here {
        // Freeze recipients at send; a later login or edit never adds a ping.
        sqlx::query("INSERT INTO message_mentions(message_id,user_id,kind,token) SELECT $1,u.id,'here','here' FROM users u JOIN members m ON m.user_id=u.id CROSS JOIN instance i WHERE m.room_id=$2 AND u.id<>$3 AND NOT u.disabled AND EXISTS(SELECT 1 FROM presence_leases p WHERE p.user_id=u.id AND p.data_epoch=i.data_epoch AND p.expires_at>clock_timestamp() AND p.status IN ('online','busy') AND EXISTS(SELECT 1 FROM sessions s WHERE s.device_id=p.device_id AND s.expires_at>clock_timestamp())) ON CONFLICT DO NOTHING")
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
