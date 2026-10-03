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

#[derive(Clone, Debug)]
pub struct NotificationReply {
    pub pending: Pending,
    pub target: Notification,
    pub attempted: bool,
}

pub(super) fn initialize(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS native_notifications(id TEXT PRIMARY KEY,rid TEXT NOT NULL,root TEXT,membership TEXT NOT NULL,position TEXT NOT NULL,direct INTEGER NOT NULL,mentioned INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS native_notification_replies(notification TEXT NOT NULL,text_hash TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(notification,text_hash));
        CREATE TABLE IF NOT EXISTS native_notification_actions(id TEXT PRIMARY KEY,notification TEXT NOT NULL,rid TEXT NOT NULL,root TEXT,membership TEXT NOT NULL,position TEXT NOT NULL,attempted INTEGER NOT NULL DEFAULT 0);")
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Notification> {
    Ok(Notification {
        incoming: Incoming {
            id: r.get(0)?,
            rid: r.get(1)?,
            author: String::new(),
            room_name: String::new(),
            body: None,
            direct: r.get(5)?,
            mentions_me: r.get(6)?,
        },
        reply_to: r.get(2)?,
        membership: r.get(3)?,
        position: r.get(4)?,
    })
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
    /// Persist identifiers before handing a notification to the OS. No content
    /// or credentials are duplicated in the action ledger.
    pub fn remember_notification(&self, n: &Notification) -> rusqlite::Result<bool> {
        self.atomic(|tx| {
            if !self.same(tx)? || !valid(tx, n, true)? { return Ok(false) }
            tx.execute("INSERT INTO native_notifications VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO NOTHING", params![n.incoming.id,n.incoming.rid,n.reply_to,n.membership,n.position,n.incoming.direct,n.incoming.mentions_me])?;
            tx.execute("DELETE FROM native_notifications WHERE rowid NOT IN (SELECT rowid FROM native_notifications ORDER BY rowid DESC LIMIT 256)", [])?;
            tx.execute("DELETE FROM native_notification_replies WHERE notification NOT IN (SELECT id FROM native_notifications)", [])?;
            Ok(true)
        })
    }
    pub fn remembered_notifications(&self) -> rusqlite::Result<Vec<Notification>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        conn.prepare(
            "SELECT id,rid,root,membership,position,direct,mentioned FROM native_notifications ORDER BY rowid",
        )?
        .query_map([], row)?
        .collect()
    }
    pub fn remembered_notification(&self, id: &str) -> rusqlite::Result<Option<Notification>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        conn.query_row(
            "SELECT id,rid,root,membership,position,direct,mentioned FROM native_notifications WHERE id=?1",
            [id],
            row,
        )
        .optional()
    }
    pub fn forget_notification(&self, id: &str) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            tx.execute("DELETE FROM native_notifications WHERE id=?1", [id])?;
            tx.execute("DELETE FROM native_notification_replies WHERE notification=?1", [id])?;
            Ok(())
        })
    }
    pub fn enqueue_notification_reply(
        &self,
        n: &Notification,
        text: &str,
        username: &str,
    ) -> rusqlite::Result<Option<String>> {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>();
        // Cold callbacks can open independent connections before account
        // startup. Acquire the writer before reading the receipt to dedupe them.
        self.atomic_immediate(|tx| {
            let membership = read_states::state_in(tx,&n.incoming.rid)?.and_then(|s|s.membership_version);
            let cached = tx.query_row("SELECT deleted,system_type FROM native_messages WHERE id=?1 AND rid=?2",params![n.incoming.id,n.incoming.rid],|r|Ok((r.get::<_,bool>(0)?,r.get::<_,Option<String>>(1)?))).optional()?;
            if !self.same(tx)? || membership.as_deref()!=Some(&n.membership)
                || cached.is_some_and(|(deleted,system)|deleted || system.is_some()) {
                return Ok(None);
            }
            if tx
                .query_row(
                    "SELECT 1 FROM native_notifications WHERE id=?1 AND rid=?2 AND membership=?3 AND position=?4",
                    params![n.incoming.id, n.incoming.rid, n.membership, n.position],
                    |_| Ok(()),
                )
                .optional()?
                .is_none()
            {
                return Ok(None);
            }
            if let Some(id) = tx
                .query_row(
                    "SELECT id FROM native_notification_replies WHERE notification=?1 AND text_hash=?2",
                    params![n.incoming.id, hash],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                return Ok(Some(id));
            }
            let count: u32 = tx.query_row("SELECT COUNT(*) FROM native_notification_actions", [], |r| r.get(0))?;
            if count >= 256 { return Ok(None) }
            let pending = Pending {
                id: format!("{:032x}", fastrand::u128(..)),
                room_id: n.incoming.rid.clone(),
                text: text.into(),
                quotes: vec![],
                reply_to: n.reply_to.clone(),
            };
            // The root may not be cached while offline. The replay loop must
            // resolve it privately before this intention can reach HTTP send.
            self.insert_pending_in(tx, &pending, username)?;
            tx.execute("INSERT INTO native_notification_actions(id,notification,rid,root,membership,position) VALUES(?1,?2,?3,?4,?5,?6)",params![pending.id,n.incoming.id,n.incoming.rid,n.reply_to,n.membership,n.position])?;
            tx.execute(
                "INSERT INTO native_notification_replies VALUES(?1,?2,?3)",
                params![n.incoming.id, hash, pending.id],
            )?;
            Ok(Some(pending.id))
        })
    }
    pub fn notification_valid(&self, n: &Notification, unread: bool) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(self.same(&conn)? && valid(&conn, n, unread)?)
    }

    pub fn pending_notification_replies(&self) -> rusqlite::Result<Vec<NotificationReply>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        conn.prepare("SELECT a.notification,a.rid,a.root,a.membership,a.position,0,0,o.id,o.text,a.attempted FROM native_notification_actions a JOIN native_outbox o ON o.id=a.id WHERE o.status='pending' ORDER BY o.created,o.id")?
            .query_map([],|r| Ok(NotificationReply {target:row(r)?,pending:Pending {id:r.get(7)?,room_id:r.get(1)?,text:r.get(8)?,quotes:vec![],reply_to:r.get(2)?},attempted:r.get(9)?}))?.collect()
    }

    /// Check the durable action, not the OS ledger: a read / preference change
    /// can withdraw a toast after its explicit response has already been queued.
    pub fn notification_reply_current(
        &self,
        reply: &NotificationReply,
        projection: u64,
        attempt: bool,
    ) -> rusqlite::Result<bool> {
        self.atomic(|tx| {
            if projection != self.projection_token() || !self.same(tx)?
                || read_states::state_in(tx,&reply.pending.room_id)?.and_then(|s|s.membership_version).as_deref()!=Some(&reply.target.membership) { return Ok(false) }
            let current = tx.query_row("SELECT 1 FROM native_notification_actions a JOIN native_outbox o ON o.id=a.id WHERE a.id=?1 AND a.notification=?2 AND a.membership=?3 AND o.status='pending'",params![reply.pending.id,reply.target.incoming.id,reply.target.membership],|_|Ok(())).optional()?.is_some();
            if current && attempt { tx.execute("UPDATE native_notification_actions SET attempted=1 WHERE id=?1",[&reply.pending.id])?; }
            Ok(current)
        })
    }
}
