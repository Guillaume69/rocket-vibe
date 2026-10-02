//! Reader-scoped source views, independent from the reply's public revision.
use super::*;
use rv_protocol::{MessageQuote, QuoteExcerpt, parity::QuoteReference};
use serde_json::{Value, json as value};
use std::collections::BTreeSet;

pub(super) fn initialize(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS native_quote_references(message_id TEXT NOT NULL,rid TEXT NOT NULL,ordinal INTEGER NOT NULL,source_id TEXT NOT NULL,source_room TEXT NOT NULL,observed_revision TEXT NOT NULL,PRIMARY KEY(message_id,ordinal));
        CREATE INDEX IF NOT EXISTS native_quote_origins ON native_quote_references(source_room,source_id);
        CREATE TABLE IF NOT EXISTS native_quote_sources(id TEXT PRIMARY KEY,rid TEXT NOT NULL,membership TEXT,view_position TEXT NOT NULL,payload TEXT);
        CREATE INDEX IF NOT EXISTS native_quote_source_rooms ON native_quote_sources(rid);")
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn position(value: &str) -> rusqlite::Result<u64> {
    decimal(value).and_then(|n| if n <= i64::MAX as u64 { Ok(n) } else { Err(rusqlite::Error::InvalidQuery) })
}

/// Capture only stable references, even when their source is no longer readable.
pub(super) fn references(conn: &Connection, id: &str) -> rusqlite::Result<Vec<QuoteReference>> {
    conn.prepare("SELECT source_room,source_id,observed_revision FROM native_quote_references WHERE message_id=?1 ORDER BY ordinal")?
        .query_map([id], |r| Ok(QuoteReference {room_id:r.get(0)?,message_id:r.get(1)?,revision:r.get(2)?}))?.collect()
}

/// Null wins a tie. An old HTTP view cannot resurrect an unavailable source.
fn save_source(
    tx: &Transaction,
    id: &str,
    rid: &str,
    membership: Option<&str>,
    view: &str,
    excerpt: Option<&QuoteExcerpt>,
) -> rusqlite::Result<()> {
    let incoming = position(view)?;
    let old = tx
        .query_row("SELECT rid,view_position,payload IS NULL FROM native_quote_sources WHERE id=?1", [id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?))
        })
        .optional()?;
    if let Some((room, revision, unavailable)) = old {
        if room != rid {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let previous = position(&revision)?;
        if incoming < previous || incoming == previous && (unavailable || excerpt.is_some()) {
            return Ok(());
        }
    }
    tx.execute("INSERT INTO native_quote_sources(id,rid,membership,view_position,payload) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET membership=excluded.membership,view_position=excluded.view_position,payload=excluded.payload",
        params![id,rid,membership,view,excerpt.map(json).transpose()?])?;
    Ok(())
}

fn source_view(tx: &Transaction, quote: &MessageQuote) -> rusqlite::Result<()> {
    let view = position(&quote.view_position)?;
    if view == 0 {
        return Ok(());
    } // Legacy prototypes supply no read authority.
    let reference = &quote.reference;
    let current = read_states::state_in(tx, &reference.room_id)?;
    let membership = current.as_ref().and_then(|s| s.membership_version.as_deref());
    if let Some(excerpt) = &quote.excerpt
        && (quote.source_membership_version.as_deref() != Some(&excerpt.membership_version)
            || position(&excerpt.revision)? == 0
            || position(&excerpt.revision)? > view
            || !identifier(&excerpt.author.id)
            || excerpt.text.chars().count() > 1024
            || chrono::DateTime::parse_from_rfc3339(&excerpt.created_at).is_err())
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if let Some(grant) = &quote.source_membership_version {
        if !identifier(grant) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if membership != Some(grant.as_str()) {
            return Ok(());
        }
    } else if membership.is_some() {
        let room: String =
            tx.query_row("SELECT payload FROM native_rooms WHERE id=?1", [&reference.room_id], |r| r.get(0))?;
        let room: Room = serde_json::from_str(&room).map_err(|_| rusqlite::Error::InvalidQuery)?;
        // A pre-join null must not clear the next membership's source views.
        if view <= position(&room.revision)? {
            return Ok(());
        }
        let ids = tx
            .prepare("SELECT id FROM native_quote_sources WHERE rid=?1")?
            .query_map([&reference.room_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in ids {
            save_source(tx, &id, &reference.room_id, None, &quote.view_position, None)?;
        }
    }
    save_source(
        tx,
        &reference.message_id,
        &reference.room_id,
        quote.source_membership_version.as_deref(),
        &quote.view_position,
        quote.excerpt.as_deref(),
    )
}

pub(super) fn project(tx: &Transaction, message: &Message, public_fresh: bool) -> rusqlite::Result<()> {
    if message.quotes.len() > 8 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let mut ids = BTreeSet::new();
    for quote in &message.quotes {
        let r = &quote.reference;
        if !identifier(&r.message_id)
            || !identifier(&r.room_id)
            || r.message_id == message.id
            || !ids.insert(&r.message_id)
            || position(&r.revision)? == 0
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let known: Option<String> = tx
            .query_row("SELECT rid FROM native_messages WHERE id=?1", [&r.message_id], |row| row.get(0))
            .optional()?;
        if known.is_some_and(|rid| rid != r.room_id) {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    if public_fresh {
        tx.execute("DELETE FROM native_quote_references WHERE message_id=?1", [&message.id])?;
        if !message.deleted {
            for (ordinal, quote) in message.quotes.iter().enumerate() {
                let r = &quote.reference;
                tx.execute(
                    "INSERT INTO native_quote_references VALUES(?1,?2,?3,?4,?5,?6)",
                    params![message.id, message.room_id, ordinal as i64, r.message_id, r.room_id, r.revision],
                )?;
            }
        }
    }
    if !message.deleted {
        for quote in &message.quotes {
            source_view(tx, quote)?;
        }
    }
    // A received source edit/tombstone refreshes all cards that reference it.
    if let Some(grant) = read_states::state_in(tx, &message.room_id)?.and_then(|s| s.membership_version)
        && position(&message.revision)? > 0
    {
        let excerpt = (!message.deleted).then(|| QuoteExcerpt {
            author: message.author.as_ref().clone(),
            text: message.text.chars().take(1024).collect(),
            created_at: message.created_at.clone(),
            revision: message.revision.clone(),
            membership_version: grant.clone(),
        });
        save_source(tx, &message.id, &message.room_id, Some(&grant), &message.revision, excerpt.as_ref())?;
    }
    Ok(())
}

/// Only the provider boundary creates the local attachment shape already used
/// by GTK and SwiftUI. No Rocket.Chat URL or attachment enters the wire contract.
pub(super) fn attachments(conn: &Connection, message: &str) -> rusqlite::Result<Option<String>> {
    let rows = conn.prepare("SELECT source_id,source_room,observed_revision FROM native_quote_references WHERE message_id=?1 ORDER BY ordinal")?
        .query_map([message],|r| Ok(QuoteReference {message_id:r.get(0)?,room_id:r.get(1)?,revision:r.get(2)?}))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut cards = vec![];
    for reference in rows {
        let source: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT membership,payload FROM native_quote_sources WHERE id=?1 AND rid=?2",
                params![reference.message_id, reference.room_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let grant = read_states::state_in(conn, &reference.room_id)?.and_then(|s| s.membership_version);
        let excerpt = source
            .filter(|s| grant.is_some() && s.0 == grant)
            .and_then(|s| s.1)
            .map(|s| serde_json::from_str::<QuoteExcerpt>(&s).map_err(|_| rusqlite::Error::InvalidQuery))
            .transpose()?;
        let mut card =
            value!({"message_link":"","native_reference":reference,"native_unavailable":excerpt.is_none(),"text":""});
        if let Some(excerpt) = excerpt {
            card["author_name"] = Value::String(excerpt.author.username);
            card["md"] = value!(super::super::markdown::tree(&rv_protocol::markdown::parse(&excerpt.text)));
            card["text"] = Value::String(excerpt.text);
        }
        cards.push(card);
    }
    if cards.is_empty() { Ok(None) } else { json(&cards).map(Some) }
}

#[cfg(test)]
mod tests;
