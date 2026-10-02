//! References belong to a message. Excerpts belong to an authorized read.
use std::collections::BTreeSet;

use axum::http::StatusCode;
use rv_protocol::{Message, QuoteExcerpt, parity::QuoteReference};
use sqlx::{Postgres, Transaction};

use crate::{
    auth::identifier,
    error::{Error, Result},
    store::{MESSAGE_SELECT, MessageRow},
};

pub(crate) fn valid_references(references: &[QuoteReference], own: &str) -> bool {
    let mut ids = BTreeSet::new();
    references.len() <= 8
        && references.iter().all(|reference| {
            identifier(&reference.room_id)
                && identifier(&reference.message_id)
                && reference.message_id != own
                && ids.insert(&reference.message_id)
                && reference
                    .revision
                    .parse::<i64>()
                    .ok()
                    .is_some_and(|revision| {
                        revision > 0 && revision.to_string() == reference.revision
                    })
        })
}

/// Cross-room quotes acquire domain locks in a single order before memberships,
/// message rows and the journal. Two rooms quoting each other cannot invert it.
pub(crate) async fn lock_rooms(
    tx: &mut Transaction<'_, Postgres>,
    destination: &str,
    references: &[QuoteReference],
) -> Result<()> {
    let mut rooms: BTreeSet<&str> = references.iter().map(|r| r.room_id.as_str()).collect();
    rooms.insert(destination);
    let rooms: Vec<_> = rooms.into_iter().collect();
    sqlx::query("SELECT id FROM rooms WHERE id=ANY($1) ORDER BY id FOR UPDATE")
        .bind(rooms)
        .fetch_all(&mut **tx)
        .await?;
    Ok(())
}

pub(crate) async fn validate(
    tx: &mut Transaction<'_, Postgres>,
    user: &str,
    references: &[QuoteReference],
    retained: &[QuoteReference],
) -> Result<()> {
    for reference in references {
        // Editing the reply may retain an unavailable quote. It never retains
        // the source text: resolution still checks the reader's current grant.
        if retained.contains(reference) {
            continue;
        }
        let revision: Option<i64> = sqlx::query_scalar(
            "SELECT m.revision FROM messages m JOIN members g ON g.room_id=m.room_id AND g.user_id=$3 WHERE m.id=$1 AND m.room_id=$2 AND NOT m.deleted",
        )
        .bind(&reference.message_id)
        .bind(&reference.room_id)
        .bind(user)
        .fetch_optional(&mut **tx)
        .await?;
        let revision = revision.ok_or_else(Error::missing)?;
        if revision.to_string() != reference.revision {
            return Err(Error::new(StatusCode::CONFLICT, "quote_revision_conflict"));
        }
    }
    Ok(())
}

pub(crate) async fn personalize(
    conn: &mut sqlx::PgConnection,
    user: &str,
    messages: &mut [Message],
) -> Result<()> {
    // Treat even an old journal's presentation as untrusted for this reader.
    for message in messages.iter_mut() {
        for quote in &mut message.quotes {
            quote.excerpt = None;
        }
        if message.deleted {
            message.quotes.clear();
        }
    }
    let ids: Vec<_> = messages
        .iter()
        .flat_map(|m| m.quotes.iter().map(|q| q.reference.message_id.as_str()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let query = format!(
        "{MESSAGE_SELECT} WHERE m.id=ANY($1) AND NOT m.deleted AND EXISTS(SELECT 1 FROM members g WHERE g.room_id=m.room_id AND g.user_id=$2)"
    );
    let sources = sqlx::query_as::<_, MessageRow>(&query)
        .bind(&ids)
        .bind(user)
        .fetch_all(&mut *conn)
        .await?;
    let memberships: Vec<(String, String)> = sqlx::query_as(
        "SELECT room_id,membership_version FROM room_read_states WHERE user_id=$1 AND room_id IN (SELECT room_id FROM messages WHERE id=ANY($2))",
    )
    .bind(user)
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await?;
    for quote in messages.iter_mut().flat_map(|m| &mut m.quotes) {
        if let Some(source) = sources
            .iter()
            .find(|s| s.id == quote.reference.message_id && s.room_id == quote.reference.room_id)
            && let Some((_, membership)) = memberships.iter().find(|m| m.0 == source.room_id)
        {
            quote.excerpt = Some(Box::new(QuoteExcerpt {
                author: rv_protocol::User {
                    id: source.author_id.clone(),
                    username: source.username.clone(),
                    display_name: source.display_name.clone(),
                },
                text: source.text.chars().take(1024).collect(),
                created_at: source.created_at.to_rfc3339(),
                revision: source.revision.to_string(),
                membership_version: membership.clone(),
            }));
        }
    }
    Ok(())
}

/// Delivery must lease both the destination and every source whose bytes are
/// included. Unavailable references carry no source-room content to lease.
pub(crate) fn delivery_rooms(messages: &[Message]) -> Vec<String> {
    messages
        .iter()
        .flat_map(|message| {
            std::iter::once(message.room_id.clone()).chain(
                message
                    .quotes
                    .iter()
                    .filter(|q| q.excerpt.is_some())
                    .map(|q| q.reference.room_id.clone()),
            )
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_reject_duplicates_self_noncanonical_revisions_and_bounds() {
        let reference = QuoteReference {
            room_id: "room".into(),
            message_id: "source".into(),
            revision: "9007199254740993".into(),
        };
        assert!(valid_references(std::slice::from_ref(&reference), "reply"));
        assert!(!valid_references(
            std::slice::from_ref(&reference),
            "source"
        ));
        assert!(!valid_references(
            &[reference.clone(), reference.clone()],
            "reply"
        ));
        for revision in ["0", "01", "-1", "9223372036854775808"] {
            assert!(!valid_references(
                &[QuoteReference {
                    revision: revision.into(),
                    ..reference.clone()
                }],
                "reply"
            ));
        }
        let nine: Vec<_> = (0..9)
            .map(|n| QuoteReference {
                message_id: format!("source-{n}"),
                ..reference.clone()
            })
            .collect();
        assert!(!valid_references(&nine, "reply"));
    }
}
