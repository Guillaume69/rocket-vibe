//! Reader-scoped source views, independent from the reply's public revision.
use super::*;
use rv_protocol::{MessageQuote, QuoteExcerpt, parity::QuoteReference};
use serde_json::{Value, json as value};
use std::collections::BTreeSet;

/// A UI selection is bound to the source's current cache and membership.
/// Only reference is retained in the durable send body.
#[derive(Debug, Clone, PartialEq)]
pub struct QuoteSelection {
    pub reference: QuoteReference,
    pub identity: Identity,
    pub membership_version: String,
}

pub struct PublicQuoteSource {
    pub id: String,
    pub excerpt: QuoteExcerpt,
}
pub struct PublicQuoteSources {
    pub membership: String,
    pub messages: Vec<PublicQuoteSource>,
}
/// Only ordinary source rows may cross into a volatile encrypted reader.
pub(super) fn public_sources(
    conn: &Connection,
    rid: &str,
    ids: &[String],
) -> rusqlite::Result<Option<PublicQuoteSources>> {
    // At most 265 rendered rows, eight sources and eight children per source.
    if !identifier(rid) || ids.len() > 20_000 || ids.iter().any(|id| !identifier(id)) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let room: Option<String> =
        conn.query_row("SELECT payload FROM native_rooms WHERE id=?1", [rid], |r| r.get(0)).optional()?;
    let Some(room) = room else { return Ok(None) };
    let room: Room = serde_json::from_str(&room).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if room.encrypted {
        return Ok(None);
    }
    let Some(membership) = read_states::state_in(conn, rid)?.and_then(|s| s.membership_version) else {
        return Ok(None);
    };
    let mut query = conn.prepare(
        "SELECT payload FROM native_quote_sources WHERE id=?1 AND rid=?2 AND membership=?3 AND payload IS NOT NULL",
    )?;
    let mut messages = Vec::new();
    for id in ids {
        let value: Option<String> = query.query_row(params![id, rid, membership], |r| r.get(0)).optional()?;
        if let Some(value) = value {
            let excerpt: QuoteExcerpt = serde_json::from_str(&value).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if excerpt.membership_version != membership
                || position(&excerpt.revision)? == 0
                || excerpt.text.chars().count() > 1024
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            messages.push(PublicQuoteSource { id: id.clone(), excerpt });
        }
    }
    Ok(Some(PublicQuoteSources { membership, messages }))
}

pub(super) fn selection(
    conn: &Connection,
    identity: &Identity,
    rid: &str,
    id: &str,
) -> rusqlite::Result<QuoteSelection> {
    let revision: String = conn.query_row(
        "SELECT revision FROM native_messages WHERE id=?1 AND rid=?2 AND NOT deleted AND position IS NOT NULL AND system_type IS NULL",
        params![id, rid],
        |r| r.get(0),
    )?;
    let membership =
        read_states::state_in(conn, rid)?.and_then(|s| s.membership_version).ok_or(rusqlite::Error::InvalidQuery)?;
    if !identifier(id) || !identifier(rid) || position(&revision)? == 0 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(QuoteSelection {
        reference: QuoteReference { message_id: id.into(), room_id: rid.into(), revision },
        identity: identity.clone(),
        membership_version: membership,
    })
}

pub(super) fn enqueue(
    tx: &Transaction,
    identity: &Identity,
    pending: &Pending,
    selected: &[QuoteSelection],
) -> rusqlite::Result<()> {
    let mut ids = BTreeSet::new();
    if selected.len() > 8 || pending.quotes.len() != selected.len() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    // Validate all sources before writing any reference. Server ACL checks remain final.
    for (selected, reference) in selected.iter().zip(&pending.quotes) {
        if reference.message_id == pending.id
            || !ids.insert(&reference.message_id)
            || &selection(tx, identity, &reference.room_id, &reference.message_id)? != selected
            || &selected.reference != reference
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    for (ordinal, reference) in pending.quotes.iter().enumerate() {
        tx.execute("INSERT INTO native_quote_references(message_id,rid,ordinal,source_id,source_room,observed_revision) VALUES(?1,?2,?3,?4,?5,?6)",params![pending.id,pending.room_id,ordinal as i64,reference.message_id,reference.room_id,reference.revision])?;
    }
    Ok(())
}

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
    // Keep source references, never private descendant copies inside a parent.
    let stored = excerpt.map(|source| QuoteExcerpt {
        author: source.author.clone(),
        text: source.text.clone(),
        created_at: source.created_at.clone(),
        revision: source.revision.clone(),
        membership_version: source.membership_version.clone(),
        files: source.files.clone(),
        references: source.references.clone(),
        quotes: vec![],
    });
    tx.execute("INSERT INTO native_quote_sources(id,rid,membership,view_position,payload) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET membership=excluded.membership,view_position=excluded.view_position,payload=excluded.payload",
        params![id,rid,membership,view,stored.as_ref().map(json).transpose()?])?;
    Ok(())
}

fn source_view(tx: &Transaction, quote: &MessageQuote, depth: usize) -> rusqlite::Result<()> {
    if depth > 2 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let view = position(&quote.view_position)?;
    if view == 0 {
        return Ok(());
    } // Legacy prototypes supply no read authority.
    let reference = &quote.reference;
    if !identifier(&reference.message_id) || !identifier(&reference.room_id) || position(&reference.revision)? == 0 {
        return Err(rusqlite::Error::InvalidQuery);
    }
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
    if let Some(excerpt) = &quote.excerpt {
        super::super::files::validate_descriptors(&excerpt.files, &reference.room_id)
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        let mut ids = BTreeSet::new();
        if excerpt.references.len() > 8
            || excerpt.quotes.len() > 8
            || depth == 2 && !excerpt.quotes.is_empty()
            || excerpt.references.iter().any(|r| {
                !identifier(&r.message_id)
                    || !identifier(&r.room_id)
                    || r.message_id == reference.message_id
                    || !ids.insert(&r.message_id)
                    || position(&r.revision).map_or(true, |n| n == 0)
            })
            || !excerpt.quotes.is_empty()
                && excerpt.quotes.iter().map(|q| &q.reference).collect::<Vec<_>>()
                    != excerpt.references.iter().collect::<Vec<_>>()
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
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
    if let Some(excerpt) = &quote.excerpt {
        for child in &excerpt.quotes {
            source_view(tx, child, depth + 1)?;
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
            source_view(tx, quote, 1)?;
        }
    }
    // A received source edit/tombstone refreshes all cards that reference it.
    if let Some(grant) = read_states::state_in(tx, &message.room_id)?.and_then(|s| s.membership_version)
        && position(&message.revision)? > 0
    {
        let excerpt = (!message.deleted && message.system.is_none()).then(|| QuoteExcerpt {
            author: message.author.as_ref().clone(),
            text: message.text.chars().take(1024).collect(),
            created_at: message.created_at.clone(),
            revision: message.revision.clone(),
            membership_version: grant.clone(),
            files: message.files.clone(),
            references: message.quotes.iter().map(|q| q.reference.clone()).collect(),
            quotes: vec![],
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
        cards.push(quote_card(conn, reference, 1, &[message])?);
    }
    if cards.is_empty() { Ok(None) } else { json(&cards).map(Some) }
}

fn quote_card(conn: &Connection, reference: QuoteReference, depth: usize, path: &[&str]) -> rusqlite::Result<Value> {
    let source: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT membership,payload FROM native_quote_sources WHERE id=?1 AND rid=?2",
            params![reference.message_id, reference.room_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let grant = read_states::state_in(conn, &reference.room_id)?.and_then(|s| s.membership_version);
    let excerpt = source
        .filter(|s| grant.is_some() && s.0 == grant && !path.contains(&reference.message_id.as_str()))
        .and_then(|s| s.1)
        .map(|s| serde_json::from_str::<QuoteExcerpt>(&s).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()?;
    let mut card =
        value!({"message_link":"","native_reference":reference,"native_unavailable":excerpt.is_none(),"text":""});
    if let Some(excerpt) = excerpt {
        let mut children =
            super::super::files::attachments(&excerpt.files).map_err(|_| rusqlite::Error::InvalidQuery)?;
        if depth < 2 {
            let mut next = path.to_vec();
            next.push(&reference.message_id);
            children.extend(
                excerpt
                    .references
                    .into_iter()
                    .map(|r| quote_card(conn, r, depth + 1, &next))
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            );
        }
        if !children.is_empty() {
            card["attachments"] = value!(children);
        }
        card["author_name"] = Value::String(excerpt.author.username);
        card["md"] = value!(super::super::markdown::tree(&rv_protocol::markdown::parse(&excerpt.text)));
        card["text"] = Value::String(excerpt.text);
    }
    Ok(card)
}

#[cfg(test)]
mod tests;
