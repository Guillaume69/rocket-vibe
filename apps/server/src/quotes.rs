//! References belong to a message. Excerpts belong to an authorized read.
use std::collections::BTreeSet;

use axum::http::StatusCode;
use rv_protocol::{Message, QuoteExcerpt, parity::QuoteReference};
use sqlx::{Postgres, Transaction};

use crate::{
    auth::identifier,
    error::{Error, Result},
};

#[derive(sqlx::FromRow)]
struct Resolution {
    message_id: String,
    room_id: String,
    view_position: i64,
    membership_version: Option<String>,
    source_author: Option<String>,
    source_username: Option<String>,
    source_display_name: Option<String>,
    source_text: Option<String>,
    source_created_at: Option<chrono::DateTime<chrono::Utc>>,
    source_revision: Option<i64>,
}
impl Resolution {
    fn excerpt(&self) -> Option<QuoteExcerpt> {
        Some(QuoteExcerpt {
            author: rv_protocol::User {
                id: self.source_author.clone()?,
                username: self.source_username.clone()?,
                display_name: self.source_display_name.clone()?,
            },
            text: self.source_text.clone()?,
            created_at: self.source_created_at?.to_rfc3339(),
            revision: self.source_revision?.to_string(),
            membership_version: self.membership_version.clone()?,
        })
    }
}

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
            quote.view_position = "0".into();
            quote.source_membership_version = None;
        }
        if message.deleted {
            message.quotes.clear();
        }
    }
    let references: Vec<_> = messages
        .iter()
        .flat_map(|m| {
            m.quotes
                .iter()
                .map(|q| (&q.reference.message_id, &q.reference.room_id))
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if references.is_empty() {
        return Ok(());
    }
    let ids: Vec<_> = references.iter().map(|r| r.0.as_str()).collect();
    let rooms: Vec<_> = references.iter().map(|r| r.1.as_str()).collect();
    // One statement gives the watermark, grant and source the same MVCC view,
    // even for the send response's READ COMMITTED pooled connection. In
    // particular, a pre-join unavailable result cannot receive a post-join stamp.
    let resolutions = sqlx::query_as::<_, Resolution>(
        "SELECT q.message_id,q.room_id,i.position AS view_position,s.membership_version,\
         m.author_id AS source_author,u.username AS source_username,u.display_name AS source_display_name,\
         left(m.text,1024) AS source_text,m.created_at AS source_created_at,m.revision AS source_revision \
         FROM unnest($1::text[],$2::text[]) q(message_id,room_id) CROSS JOIN instance i \
         LEFT JOIN room_read_states s ON s.room_id=q.room_id AND s.user_id=$3 \
         LEFT JOIN messages m ON m.id=q.message_id AND m.room_id=q.room_id AND NOT m.deleted AND s.membership_version IS NOT NULL \
         LEFT JOIN users u ON u.id=m.author_id WHERE i.singleton",
    ).bind(ids).bind(rooms).bind(user).fetch_all(&mut *conn).await?;
    for quote in messages.iter_mut().flat_map(|m| &mut m.quotes) {
        if let Some(resolution) = resolutions.iter().find(|s| {
            s.message_id == quote.reference.message_id && s.room_id == quote.reference.room_id
        }) {
            quote.excerpt = resolution.excerpt().map(Box::new);
            quote.view_position = resolution.view_position.to_string();
            quote.source_membership_version = resolution.membership_version.clone();
        }
    }
    Ok(())
}

/// Delivery leases the destination and every included source membership, even
/// when its source is deleted. A grant's absence includes no source authority.
pub(crate) fn delivery_rooms(messages: &[Message]) -> Vec<String> {
    messages
        .iter()
        .flat_map(|message| {
            std::iter::once(message.room_id.clone()).chain(
                message
                    .quotes
                    .iter()
                    .filter(|q| q.excerpt.is_some() || q.source_membership_version.is_some())
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
