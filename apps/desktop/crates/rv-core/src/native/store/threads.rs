//! Thread replies share the message projection, but retain their own drafts and observed reads.
use super::*;
use rv_protocol::{ThreadPage, ThreadReadState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingThreadRead {
    pub root: String,
    pub room: String,
    pub membership: String,
    pub position: String,
}

pub(super) fn initialize(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS native_thread_states(root TEXT PRIMARY KEY,rid TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS native_thread_read_intents(root TEXT PRIMARY KEY,rid TEXT NOT NULL,membership TEXT NOT NULL,position TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS native_thread_drafts(root TEXT PRIMARY KEY,rid TEXT NOT NULL,text TEXT NOT NULL);")
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
pub(super) fn validate_message(message: &Message) -> rusqlite::Result<i64> {
    if message.reply_to.as_ref().is_some_and(|id| !identifier(id) || id == &message.id)
        || message.reply_to.is_some() && (message.thread.is_some() || message.system.is_some())
        || message.system.is_some() && message.thread.is_some()
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if let Some(thread) = &message.thread {
        if let Some(last) = &thread.last_reply_at {
            chrono::DateTime::parse_from_rfc3339(last).map_err(|_| rusqlite::Error::InvalidQuery)?;
        }
        return Ok(decimal(&thread.replies)?.min(i64::MAX as u64) as i64);
    }
    Ok(0)
}
pub(super) const MESSAGE_SELECT: &str = "SELECT m.id,m.text,coalesce(json_extract(u.payload,'$.user.username'),m.author),o.status,m.author_id,m.ts,m.edited,m.reactions,m.pinned,m.starred,m.position,m.body,m.system_type,m.reply_to,m.thread_replies FROM native_messages m LEFT JOIN native_outbox o ON o.id=m.id LEFT JOIN native_users u ON u.uid=m.author_id";
pub(super) fn message_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        id: r.get(0)?,
        text: r.get(1)?,
        author: r.get(2)?,
        status: r.get(3)?,
        author_id: r.get(4)?,
        ts: r.get(5)?,
        edited: r.get(6)?,
        reactions: r.get(7)?,
        pinned: r.get(8)?,
        starred: r.get(9)?,
        position: r.get(10)?,
        body: r.get(11)?,
        system_type: r.get(12)?,
        reply_to: r.get(13)?,
        thread_replies: r.get(14)?,
        attachments: None,
    })
}
pub(super) fn require_root(conn: &Connection, rid: &str, root: &str) -> rusqlite::Result<()> {
    if !identifier(root) || !conn.query_row("SELECT EXISTS(SELECT 1 FROM native_messages WHERE id=?1 AND rid=?2 AND reply_to IS NULL AND system_type IS NULL AND NOT deleted AND position IS NOT NULL)",params![root,rid],|r|r.get::<_,bool>(0))? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}
fn validate_state(state: &ThreadReadState) -> rusqlite::Result<()> {
    if [&state.root_id, &state.room_id, &state.membership_version].into_iter().any(|s| !identifier(s)) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    for value in [&state.position, &state.revision, &state.unread] {
        decimal(value)?;
    }
    Ok(())
}
fn state_in(conn: &Connection, root: &str) -> rusqlite::Result<Option<ThreadReadState>> {
    let raw: Option<String> =
        conn.query_row("SELECT payload FROM native_thread_states WHERE root=?1", [root], |r| r.get(0)).optional()?;
    raw.map(|raw| {
        let state: ThreadReadState = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
        validate_state(&state)?;
        if state.root_id != root {
            return Err(rusqlite::Error::InvalidQuery);
        }
        Ok(state)
    })
    .transpose()
}
fn save(tx: &Transaction, state: &ThreadReadState) -> rusqlite::Result<()> {
    if let Some(old) = state_in(tx, &state.root_id)? {
        if old.room_id != state.room_id || old.membership_version != state.membership_version {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if decimal(&old.revision)? > decimal(&state.revision)? {
            return Ok(());
        }
        if decimal(&old.position)? > decimal(&state.position)? || old.revision == state.revision && old != *state {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    tx.execute("INSERT INTO native_thread_states(root,rid,payload) VALUES(?1,?2,?3) ON CONFLICT(root) DO UPDATE SET payload=excluded.payload",params![state.root_id,state.room_id,json(state)?])?;
    tx.execute("DELETE FROM native_thread_read_intents WHERE root=?1 AND membership=?2 AND (length(position)<length(?3) OR length(position)=length(?3) AND position<=?3)",params![state.root_id,state.membership_version,state.position])?;
    Ok(())
}
impl NativeStore {
    pub fn thread_messages(&self, rid: &str, root: &str) -> rusqlite::Result<Vec<MessageRow>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        let mut rows=conn.prepare(&format!("{MESSAGE_SELECT} WHERE m.rid=?1 AND (m.id=?2 OR m.reply_to=?2) AND NOT m.deleted ORDER BY m.id<>?2,m.position IS NULL,length(m.position),m.position,o.created,m.id"))?.query_map(params![rid,root],message_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        for row in &mut rows {
            row.attachments = files::attachments(&conn, &row.id)?;
        }
        Ok(rows)
    }
    pub fn thread_writable(&self, rid: &str, root: &str) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(self.same(&conn)? && require_root(&conn, rid, root).is_ok())
    }
    pub fn cache_thread(&self, page: &ThreadPage, token: u64) -> rusqlite::Result<bool> {
        validate_state(&page.read_state)?;
        if page.read_state.root_id != page.root.id
            || page.read_state.room_id != page.root.room_id
            || page.root.reply_to.is_some()
            || page.root.system.is_some()
            || page.has_more && page.messages.is_empty()
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let mut previous = u64::MAX;
        for reply in &page.messages {
            let position = decimal(&reply.position)?;
            if position == 0
                || position >= previous
                || reply.room_id != page.root.room_id
                || reply.reply_to.as_deref() != Some(&page.root.id)
                || reply.id == page.root.id
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            previous = position;
        }
        self.atomic(|tx| {
            if token != self.projection_token()
                || !self.membership_matches_in(tx, &page.root.room_id, Some(&page.read_state.membership_version))?
            {
                return Ok(false);
            }
            self.message(tx, &page.root)?;
            for reply in &page.messages {
                self.message(tx, reply)?;
            }
            save(tx, &page.read_state)?;
            Ok(true)
        })
    }
    pub fn cache_thread_read(&self, state: &ThreadReadState, token: u64) -> rusqlite::Result<bool> {
        validate_state(state)?;
        self.atomic(|tx| {
            if token != self.projection_token()
                || !self.membership_matches_in(tx, &state.room_id, Some(&state.membership_version))?
            {
                return Ok(false);
            }
            save(tx, state)?;
            Ok(true)
        })
    }
    pub fn stage_thread_read(&self, root: &str, observed: &str, membership: &str) -> rusqlite::Result<bool> {
        if [root, observed, membership].into_iter().any(|s| !identifier(s)) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let row:Option<(String,String)>=tx.query_row("SELECT rid,position FROM native_messages WHERE id=?1 AND reply_to=?2 AND NOT deleted AND position IS NOT NULL",params![observed,root],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((rid, position)) = row else {
            return Ok(false);
        };
        if !self.membership_matches_in(&tx, &rid, Some(membership))? {
            return Ok(false);
        }
        let value = decimal(&position)?;
        if value == 0
            || state_in(&tx, root)?.as_ref().map(|s| decimal(&s.position)).transpose()?.is_some_and(|p| p >= value)
        {
            return Ok(false);
        }
        let old: Option<String> = tx
            .query_row(
                "SELECT position FROM native_thread_read_intents WHERE root=?1 AND membership=?2",
                params![root, membership],
                |r| r.get(0),
            )
            .optional()?;
        if old.as_deref().map(decimal).transpose()?.is_some_and(|p| p >= value) {
            return Ok(false);
        }
        tx.execute("INSERT INTO native_thread_read_intents(root,rid,membership,position) VALUES(?1,?2,?3,?4) ON CONFLICT(root) DO UPDATE SET rid=excluded.rid,membership=excluded.membership,position=excluded.position",params![root,rid,membership,position])?;
        tx.commit()?;
        Ok(true)
    }
    pub fn pending_thread_reads(&self) -> rusqlite::Result<Vec<PendingThreadRead>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        conn.prepare("SELECT q.root,q.rid,q.membership,q.position FROM native_thread_read_intents q JOIN native_read_states s ON s.rid=q.rid WHERE q.membership=json_extract(s.payload,'$.membership_version') ORDER BY q.rowid")?.query_map([],|r| {
            let position:String=r.get(3)?;decimal(&position)?;
            Ok(PendingThreadRead{root:r.get(0)?,room:r.get(1)?,membership:r.get(2)?,position})
        })?.collect()
    }
    pub fn thread_draft_from_membership(
        &self,
        rid: &str,
        root: &str,
        membership: Option<&str>,
    ) -> rusqlite::Result<String> {
        let conn = self.conn.lock().unwrap();
        if !self.membership_matches_in(&conn, rid, membership)? {
            return Ok(String::new());
        }
        Ok(conn
            .query_row("SELECT text FROM native_thread_drafts WHERE root=?1 AND rid=?2", params![root, rid], |r| {
                r.get(0)
            })
            .optional()?
            .unwrap_or_default())
    }
    pub fn set_thread_draft_from_membership(
        &self,
        rid: &str,
        root: &str,
        text: &str,
        membership: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if !self.membership_matches_in(&tx, rid, membership)? {
            return Ok(false);
        }
        if !identifier(root) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        tx.execute("INSERT INTO native_thread_drafts(root,rid,text) VALUES(?1,?2,?3) ON CONFLICT(root) DO UPDATE SET text=excluded.text WHERE rid=excluded.rid",params![root,rid,text])?;
        tx.commit()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests;
