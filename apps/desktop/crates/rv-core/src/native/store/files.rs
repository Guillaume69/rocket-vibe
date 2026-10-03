//! Native file manifests and upload intentions share the membership transaction.
use super::*;
use rv_protocol::parity::{CompleteUpload, FileDescriptor, PrepareUpload};

#[derive(Clone, Serialize, Deserialize)]
pub struct FileIntent {
    pub id: String,
    pub rid: String,
    pub membership: String,
    pub path: String,
    pub prepare: PrepareUpload,
    pub complete: CompleteUpload,
    pub cancelling: bool,
    pub failed: bool,
    #[serde(default)]
    pub error: Option<String>,
}
use serde::{Deserialize, Serialize};

pub(super) fn initialize(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS native_file_intents(id TEXT PRIMARY KEY,rid TEXT NOT NULL,payload TEXT NOT NULL);",
    )
}
pub(super) fn attachments(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    let raw: Option<String> = conn
        .query_row("SELECT files FROM native_messages WHERE id=?1 AND NOT deleted", [id], |r| r.get(0))
        .optional()?
        .flatten();
    let files: Vec<FileDescriptor> = raw
        .map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()?
        .unwrap_or_default();
    let mut cards = super::super::files::attachments(&files).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if let Some(quotes) = quotes::attachments(conn, id)? {
        let quotes: Vec<serde_json::Value> =
            serde_json::from_str(&quotes).map_err(|_| rusqlite::Error::InvalidQuery)?;
        cards.extend(quotes);
    }
    if cards.is_empty() { Ok(None) } else { json(&cards).map(Some) }
}
impl NativeStore {
    pub fn file_intents(&self) -> rusqlite::Result<Vec<FileIntent>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        conn.prepare("SELECT payload FROM native_file_intents ORDER BY rowid")?
            .query_map([], |r| {
                serde_json::from_str(&r.get::<_, String>(0)?).map_err(|_| rusqlite::Error::InvalidQuery)
            })?
            .collect()
    }
    pub fn save_file_intent(&self, intent: &FileIntent) -> rusqlite::Result<bool> {
        self.atomic(|tx| {
            if !self.same(tx)? || read_states::state_in(tx,&intent.rid)?.and_then(|s|s.membership_version).as_deref()!=Some(&intent.membership) {return Ok(false)}
            tx.execute("INSERT INTO native_file_intents VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",params![intent.id,intent.rid,json(intent)?])?;
            Ok(true)
        })
    }
    pub fn finish_file_intent(&self, intent: &FileIntent, receipt: Option<&Message>) -> rusqlite::Result<bool> {
        self.atomic(|tx| {
            if !self.same(tx)?
                || read_states::state_in(tx, &intent.rid)?.and_then(|s| s.membership_version).as_deref()
                    != Some(&intent.membership)
            {
                return Ok(false);
            }
            if let Some(message) = receipt {
                if message.id != intent.complete.operation_id || message.room_id != intent.rid {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                self.message(tx, message)?;
            }
            tx.execute("DELETE FROM native_file_intents WHERE id=?1", [&intent.id])?;
            Ok(true)
        })
    }
    pub fn file_intent_state(&self, id: &str, cancelling: bool, failed: bool) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            tx.execute("UPDATE native_file_intents SET payload=json_set(payload,'$.cancelling',json(CASE WHEN ?2 OR json_extract(payload,'$.cancelling') THEN 'true' ELSE 'false' END),'$.failed',json(CASE WHEN ?3 THEN 'true' ELSE 'false' END)) WHERE id=?1",params![id,cancelling,failed])?;
            Ok(())
        })
    }
    pub fn fail_file_intent(&self, id: &str, error: &str) -> rusqlite::Result<()> {
        self.atomic(|tx|{tx.execute("UPDATE native_file_intents SET payload=json_set(payload,'$.failed',json('true'),'$.error',?2) WHERE id=?1",params![id,error])?;Ok(())})
    }
    pub fn retry_file_intent(&self, id: &str) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            let raw: Option<String> =
                tx.query_row("SELECT payload FROM native_file_intents WHERE id=?1", [id], |r| r.get(0)).optional()?;
            let Some(raw) = raw else { return Ok(()) };
            let mut intent: FileIntent = serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if intent.failed && intent.error.as_deref() == Some("upload_expired") && !intent.cancelling {
                // The expired reservation proved that no message was confirmed.
                intent.prepare.operation_id = format!("{:032x}", fastrand::u128(..));
            }
            intent.failed = false;
            intent.error = None;
            tx.execute("UPDATE native_file_intents SET payload=?2 WHERE id=?1", params![id, json(&intent)?])?;
            Ok(())
        })
    }
    pub fn file_descriptor(&self, id: &str) -> rusqlite::Result<Option<FileDescriptor>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        let quoted: Option<String> = conn.query_row(
            "SELECT f.value FROM native_quote_sources q JOIN native_read_states s ON s.rid=q.rid,json_each(q.payload,'$.files') f WHERE q.membership=json_extract(s.payload,'$.membership_version') AND json_extract(f.value,'$.id')=?1 LIMIT 1", [id], |r| r.get(0)).optional()?;
        let raw = match quoted {
            Some(raw) => Some(raw),
            None => conn.query_row("SELECT f.value FROM native_messages m JOIN native_rooms r ON r.id=m.rid,json_each(m.files) f LEFT JOIN native_quote_sources q ON q.id=m.id WHERE NOT m.deleted AND (q.id IS NULL OR q.payload IS NOT NULL) AND json_extract(f.value,'$.id')=?1 LIMIT 1",[id],|r|r.get(0)).optional()?,
        };
        raw.map(|s| serde_json::from_str(&s).map_err(|_| rusqlite::Error::InvalidQuery)).transpose()
    }
}
