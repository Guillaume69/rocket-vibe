//! What the Activity view sorts on a RocketVibe account (`crate::activity`).
use super::*;

impl NativeStore {
    /// Each candidate's room and row, the newest `limit`: others' messages
    /// that may mention me (an `@` in their words) or reply in a thread, and
    /// mine that carry reactions. Deleted ones never.
    pub fn activity_candidates(&self, me: &str, limit: i64) -> rusqlite::Result<Vec<(String, MessageRow)>> {
        let conn = self.conn.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        let select = threads::MESSAGE_SELECT.replacen(" FROM native_messages", ",m.rid FROM native_messages", 1);
        conn.prepare(&format!(
            "{select} WHERE NOT m.deleted AND (
               (m.author_id <> ?1 AND (m.text LIKE '%@%' OR m.reply_to IS NOT NULL))
               OR (m.author_id = ?1 AND m.reactions IS NOT NULL AND m.reactions NOT IN ('', '{{}}', '[]')))
             ORDER BY m.ts DESC, m.id DESC LIMIT ?2"
        ))?
        .query_map(params![me, limit], |r| Ok((r.get(18)?, threads::message_row(r)?)))?
        .collect()
    }

    /// The thread roots I take part in: I wrote the root or a reply, or I
    /// follow it (`Message.personal_follow`, kept in `followed`).
    pub fn my_threads(&self, me: &str) -> rusqlite::Result<std::collections::HashSet<String>> {
        let conn = self.conn.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.same(&conn)? {
            return Ok(Default::default());
        }
        conn.prepare(
            "SELECT DISTINCT reply_to FROM native_messages WHERE reply_to IS NOT NULL AND author_id = ?1
             UNION SELECT r.reply_to FROM native_messages r JOIN native_messages m ON m.id = r.reply_to WHERE m.author_id = ?1
             UNION SELECT id FROM native_messages WHERE author_id = ?1 AND thread_replies > 0
             UNION SELECT id FROM native_messages WHERE followed = 1",
        )?
        .query_map([me], |r| r.get(0))?
        .collect()
    }
}
