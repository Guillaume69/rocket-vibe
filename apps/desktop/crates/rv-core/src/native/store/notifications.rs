//! Live creation candidates share the projection transaction and its cursor.
use super::*;
use crate::notify::Incoming;
use rv_protocol::RoomKind;

#[derive(Clone, Debug)]
pub struct Notification {
    pub incoming: Incoming,
    pub reply_to: Option<String>,
    pub(crate) membership: String,
    position: String,
}

pub(super) fn capture(tx: &Transaction, batch: &SyncBatch, me: &str) -> rusqlite::Result<Vec<Notification>> {
    let mut out = vec![];
    let mut seen = std::collections::HashSet::new();
    for change in &batch.changes {
        let Change::MessageUpsert(m) = change else { continue };
        if !seen.insert(&m.id) {
            continue;
        }
        if m.author.id == me || m.deleted || m.system.is_some() || m.edited_at.is_some() || m.position != m.revision {
            continue;
        }
        // A history read, prior live delivery or HTTP echo already owns this ID.
        if tx.query_row("SELECT 1 FROM native_messages WHERE id=?1", [&m.id], |_| Ok(())).optional()?.is_some() {
            continue;
        }
        let Some(state) = read_states::state_in(tx, &m.room_id)? else { continue };
        let Some(membership) = state.membership_version else { continue };
        let raw: Option<String> =
            tx.query_row("SELECT payload FROM native_rooms WHERE id=?1", [&m.room_id], |r| r.get(0)).optional()?;
        let Some(raw) = raw else { continue };
        let room: Room = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let body = if !m.text.trim().is_empty() {
            crate::emoji::replace_shortcodes(m.text.trim())
        } else if let Some(file) = m.files.first() {
            format!("📎 {}", file.filename.as_deref().unwrap_or_default())
        } else if let Some(card) = m.cards.first() {
            card.title.clone().unwrap_or_else(|| "↪".into())
        } else {
            "↪".into()
        };
        let incoming = Incoming {
            rid: m.room_id.clone(),
            id: m.id.clone(),
            author: if m.author.display_name.is_empty() {
                m.author.username.clone()
            } else {
                m.author.display_name.clone()
            },
            room_name: room.name,
            direct: room.kind == RoomKind::Direct,
            body: Some(body.chars().take(2048).collect()),
            mentions_me: m.personal_mention.unwrap_or(false),
        };
        out.push(Notification { incoming, reply_to: m.reply_to.clone(), membership, position: m.position.clone() });
    }
    Ok(out)
}

pub(super) fn valid(conn: &Connection, n: &Notification, unread: bool) -> rusqlite::Result<bool> {
    let Some(state) = read_states::state_in(conn, &n.incoming.rid)? else { return Ok(false) };
    if state.membership_version.as_deref() != Some(&n.membership) {
        return Ok(false);
    }
    let revision: Option<String> = conn
        .query_row(
            "SELECT revision FROM native_messages WHERE id=?1 AND rid=?2 AND NOT deleted AND system_type IS NULL",
            params![n.incoming.id, n.incoming.rid],
            |r| r.get(0),
        )
        .optional()?;
    if revision.is_none() || unread && revision.as_deref() != Some(&n.position) {
        return Ok(false);
    }
    if !unread {
        return Ok(true);
    }
    let read = if let Some(root) = &n.reply_to {
        let thread: Option<String> = conn
            .query_row(
                "SELECT json_extract(payload,'$.position') FROM native_thread_states WHERE root=?1",
                [root],
                |r| r.get(0),
            )
            .optional()?;
        decimal(&state.reply_position)?.max(thread.as_deref().map(decimal).transpose()?.unwrap_or(0))
    } else {
        decimal(&state.root_position)?
    };
    Ok(decimal(&n.position)? > read)
}

impl NativeStore {
    pub fn notification_valid(&self, n: &Notification, unread: bool) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(self.same(&conn)? && valid(&conn, n, unread)?)
    }
}
