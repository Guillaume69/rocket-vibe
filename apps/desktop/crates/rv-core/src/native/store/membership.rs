//! Widget lifetimes also fence writes queued after an authoritative cache purge.
use super::*;
impl NativeStore {
    pub(super) fn membership_matches_in(
        &self,
        conn: &Connection,
        rid: &str,
        expected: Option<&str>,
    ) -> rusqlite::Result<bool> {
        if !self.same(conn)?
            || !conn
                .query_row("SELECT EXISTS(SELECT 1 FROM native_rooms WHERE id=?1)", [rid], |r| r.get::<_, bool>(0))?
        {
            return Ok(false);
        }
        Ok(read_states::state_in(conn, rid)?.as_ref().and_then(|s| s.membership_version.as_deref()) == expected)
    }
    pub fn draft_from_membership(&self, rid: &str, expected: Option<&str>) -> rusqlite::Result<String> {
        let conn = self.conn.lock().unwrap();
        if !self.membership_matches_in(&conn, rid, expected)? {
            return Ok(String::new());
        }
        Ok(conn
            .query_row("SELECT text FROM native_drafts WHERE rid=?1", [rid], |r| r.get(0))
            .optional()?
            .unwrap_or_default())
    }
    pub fn set_draft_from_membership(&self, rid: &str, text: &str, expected: Option<&str>) -> rusqlite::Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if !self.membership_matches_in(&tx, rid, expected)? {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO native_drafts VALUES(?1,?2) ON CONFLICT(rid) DO UPDATE SET text=excluded.text",
            params![rid, text],
        )?;
        tx.commit()?;
        // Keystrokes never invalidate the rendered room/message projections.
        Ok(true)
    }
}
