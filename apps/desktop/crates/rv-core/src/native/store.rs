//! Fallible transactions: a failed projection never acknowledges its cursor or outbox echo.
use super::Identity;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use rv_protocol::{Change, Message, Room, Snapshot, SyncBatch, VERSION};
use std::path::Path;
use std::sync::Mutex;
use tokio::sync::broadcast;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub id: String,
    pub room_id: String,
    pub text: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageRow {
    pub id: String,
    pub text: String,
    pub author: String,
    pub author_id: String,
    pub ts: i64,
    pub status: Option<String>,
}
pub struct NativeStore {
    conn: Mutex<Connection>,
    identity: Identity,
    changes: broadcast::Sender<()>,
}
fn json<T: serde::Serialize>(value: &T) -> rusqlite::Result<String> {
    serde_json::to_string(value).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}
fn decimal(value: &str) -> rusqlite::Result<u64> {
    value.parse::<u64>().ok().filter(|n| n.to_string() == value).ok_or(rusqlite::Error::InvalidQuery)
}
impl NativeStore {
    pub fn open(path: &Path, identity: Identity) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS native_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),instance TEXT NOT NULL,epoch TEXT NOT NULL,cursor TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS native_rooms(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS native_messages(id TEXT PRIMARY KEY,rid TEXT NOT NULL,position TEXT,revision TEXT,text TEXT NOT NULL,author TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS native_messages_room ON native_messages(rid);
            CREATE TABLE IF NOT EXISTS native_outbox(id TEXT PRIMARY KEY,rid TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,created INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS native_drafts(rid TEXT PRIMARY KEY,text TEXT NOT NULL);")?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS native_room_creations(id TEXT PRIMARY KEY,name TEXT NOT NULL,private INTEGER NOT NULL,UNIQUE(name,private));")?;
        let (changes, _) = broadcast::channel(64);
        let columns = conn
            .prepare("PRAGMA table_info(native_messages)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (name, declaration) in [("author_id", "TEXT NOT NULL DEFAULT ''"), ("ts", "INTEGER NOT NULL DEFAULT 0")] {
            if !columns.iter().any(|c| c == name) {
                conn.execute_batch(&format!("ALTER TABLE native_messages ADD COLUMN {name} {declaration}"))?;
            }
        }
        Ok(Self { conn: Mutex::new(conn), identity, changes })
    }
    pub fn changes(&self) -> broadcast::Receiver<()> {
        self.changes.subscribe()
    }
    pub fn clear(&self) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            for table in [
                "native_state",
                "native_rooms",
                "native_messages",
                "native_outbox",
                "native_drafts",
                "native_room_creations",
            ] {
                tx.execute(&format!("DELETE FROM {table}"), [])?;
            }
            Ok(())
        })
    }
    fn same(&self, conn: &Connection) -> rusqlite::Result<bool> {
        Ok(conn
            .query_row("SELECT instance,epoch FROM native_state WHERE singleton=1", [], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .optional()?
            .is_some_and(|(instance, epoch)| {
                instance == self.identity.instance_id && epoch == self.identity.data_epoch
            }))
    }
    fn atomic<T>(&self, fnc: impl FnOnce(&Transaction) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let result = fnc(&tx)?;
        tx.commit()?;
        drop(conn);
        let _ = self.changes.send(());
        Ok(result)
    }
    pub fn cursor(&self) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        conn.query_row("SELECT cursor FROM native_state WHERE singleton=1", [], |r| r.get(0)).optional()
    }
    fn cursor_in(&self, tx: &Transaction, cursor: &str) -> rusqlite::Result<()> {
        tx.execute("INSERT INTO native_state VALUES(1,?1,?2,?3) ON CONFLICT(singleton) DO UPDATE SET instance=excluded.instance,epoch=excluded.epoch,cursor=excluded.cursor",params![self.identity.instance_id,self.identity.data_epoch,cursor])?;
        Ok(())
    }
    /// Repeating an unresolved form, including after process restart, retains
    /// its intent. A received result completes it; transport failure does not.
    pub fn room_creation(&self, name: &str, private: bool) -> rusqlite::Result<String> {
        self.atomic(|tx| {
            if !self.same(tx)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            if let Some(id) = tx
                .query_row(
                    "SELECT id FROM native_room_creations WHERE name=?1 AND private=?2",
                    params![name, private],
                    |r| r.get(0),
                )
                .optional()?
            {
                return Ok(id);
            }
            let id = format!("{:032x}", fastrand::u128(..));
            tx.execute(
                "INSERT INTO native_room_creations(id,name,private) VALUES(?1,?2,?3)",
                params![id, name, private],
            )?;
            Ok(id)
        })
    }
    pub fn complete_room_creation(&self, id: &str) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            tx.execute("DELETE FROM native_room_creations WHERE id=?1", [id])?;
            Ok(())
        })
    }
    fn room(tx: &Transaction, room: &Room) -> rusqlite::Result<()> {
        tx.execute(
            "INSERT INTO native_rooms VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
            params![room.id, json(room)?],
        )?;
        Ok(())
    }
    fn message(tx: &Transaction, message: &Message) -> rusqlite::Result<()> {
        // Late history/HTTP echoes cannot restore data after a room withdrawal.
        if !tx.query_row("SELECT 1 FROM native_rooms WHERE id=?1", [&message.room_id], |_| Ok(())).optional()?.is_some()
        {
            return Ok(());
        }
        decimal(&message.position)?;
        let revision = decimal(&message.revision)?;
        chrono::DateTime::parse_from_rfc3339(&message.created_at).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let old = tx
            .query_row("SELECT revision FROM native_messages WHERE id=?1", [&message.id], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten();
        if old.as_deref().map(decimal).transpose()?.is_some_and(|old| old > revision) {
            return Ok(());
        }
        let ts = chrono::DateTime::parse_from_rfc3339(&message.created_at)
            .map_err(|_| rusqlite::Error::InvalidQuery)?
            .timestamp_millis();
        tx.execute("INSERT INTO native_messages(id,rid,position,revision,text,author,author_id,ts) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET position=excluded.position,revision=excluded.revision,text=excluded.text,author=excluded.author,author_id=excluded.author_id,ts=excluded.ts",params![message.id,message.room_id,message.position,message.revision,message.text,message.author.username,message.author.id,ts])?;
        tx.execute("DELETE FROM native_outbox WHERE id=?1", [&message.id])?;
        Ok(())
    }
    fn remove(tx: &Transaction, rid: &str) -> rusqlite::Result<()> {
        tx.execute("DELETE FROM native_rooms WHERE id=?1", [rid])?;
        for table in ["native_messages", "native_outbox", "native_drafts"] {
            tx.execute(&format!("DELETE FROM {table} WHERE rid=?1"), [rid])?;
        }
        Ok(())
    }
    pub fn snapshot(&self, snapshot: &Snapshot) -> rusqlite::Result<()> {
        if snapshot.protocol_version != VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic(|tx| {
            if !self.same(tx)? {
                for table in
                    ["native_rooms", "native_messages", "native_outbox", "native_drafts", "native_room_creations"]
                {
                    tx.execute(&format!("DELETE FROM {table}"), [])?;
                }
            } else {
                let known = tx
                    .prepare("SELECT id FROM native_rooms")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for id in known {
                    if !snapshot.rooms.iter().any(|r| r.id == id) {
                        Self::remove(tx, &id)?;
                    }
                }
            }
            for room in &snapshot.rooms {
                Self::room(tx, room)?;
            }
            for message in &snapshot.messages {
                Self::message(tx, message)?;
            }
            self.cursor_in(tx, &snapshot.cursor)
        })
    }
    pub fn batch(&self, batch: &SyncBatch) -> rusqlite::Result<()> {
        if batch.protocol_version != VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic(|tx| {
            if !self.same(tx)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            for change in &batch.changes {
                match change {
                    Change::RoomUpsert(room) => Self::room(tx, room)?,
                    Change::MessageUpsert(message) => Self::message(tx, message)?,
                    Change::RoomRemoved { room_id } => Self::remove(tx, room_id)?,
                }
            }
            self.cursor_in(tx, &batch.cursor)
        })
    }
    pub fn ingest(&self, messages: &[Message]) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            if !self.same(tx)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            for message in messages {
                Self::message(tx, message)?;
            }
            Ok(())
        })
    }
    pub fn rooms(&self) -> rusqlite::Result<Vec<Room>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        conn.prepare("SELECT payload FROM native_rooms ORDER BY id")?
            .query_map([], |r| {
                let value: String = r.get(0)?;
                serde_json::from_str(&value)
                    .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
            })?
            .collect()
    }
    pub fn messages(&self, rid: &str, limit: usize) -> rusqlite::Result<Vec<MessageRow>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        let mut rows=conn.prepare("SELECT m.id,m.text,m.author,o.status,m.author_id,m.ts FROM native_messages m LEFT JOIN native_outbox o ON o.id=m.id WHERE m.rid=?1 ORDER BY m.position IS NULL DESC,o.created DESC,length(m.position) DESC,m.position DESC,m.id DESC LIMIT ?2")?.query_map(params![rid,limit as i64],|r|Ok(MessageRow {id:r.get(0)?,text:r.get(1)?,author:r.get(2)?,status:r.get(3)?,author_id:r.get(4)?,ts:r.get(5)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows.reverse();
        Ok(rows)
    }
    pub fn oldest(&self, rid: &str) -> rusqlite::Result<Option<String>> {
        self.conn.lock().unwrap().query_row("SELECT position FROM native_messages WHERE rid=?1 AND position IS NOT NULL ORDER BY length(position),position LIMIT 1",[rid],|r|r.get(0)).optional()
    }
    pub fn enqueue(&self, id: &str, rid: &str, text: &str, username: &str) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            if !self.same(tx)?
                || tx.query_row("SELECT 1 FROM native_rooms WHERE id=?1", [rid], |_| Ok(())).optional()?.is_none()
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.execute(
                "INSERT INTO native_messages(id,rid,text,author,ts) VALUES(?1,?2,?3,?4,?5)",
                params![id, rid, text, username, chrono::Utc::now().timestamp_millis()],
            )?;
            tx.execute(
                "INSERT INTO native_outbox(id,rid,text,created) VALUES(?1,?2,?3,?4)",
                params![id, rid, text, chrono::Utc::now().timestamp_millis()],
            )?;
            Ok(())
        })
    }
    pub fn pending(&self) -> rusqlite::Result<Vec<Pending>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        conn.prepare("SELECT id,rid,text FROM native_outbox WHERE status='pending' ORDER BY created,id")?
            .query_map([], |r| Ok(Pending { id: r.get(0)?, room_id: r.get(1)?, text: r.get(2)? }))?
            .collect()
    }
    pub fn fail(&self, id: &str, error: &str) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            tx.execute("UPDATE native_outbox SET status='failed',error=?2 WHERE id=?1", params![id, error])?;
            Ok(())
        })
    }
    pub fn retry(&self, id: &str) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            tx.execute("UPDATE native_outbox SET status='pending',error=NULL WHERE id=?1", [id])?;
            Ok(())
        })
    }
    pub fn abandon(&self, id: &str) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            tx.execute("DELETE FROM native_messages WHERE id=?1 AND position IS NULL", [id])?;
            tx.execute("DELETE FROM native_outbox WHERE id=?1", [id])?;
            Ok(())
        })
    }
    pub fn draft(&self, rid: &str) -> rusqlite::Result<String> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(String::new());
        }
        Ok(conn
            .query_row("SELECT text FROM native_drafts WHERE rid=?1", [rid], |r| r.get(0))
            .optional()?
            .unwrap_or_default())
    }
    pub fn set_draft(&self, rid: &str, text: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)?
            || conn.query_row("SELECT 1 FROM native_rooms WHERE id=?1", [rid], |_| Ok(())).optional()?.is_none()
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        // A draft write does not invalidate message/room projections on every keystroke.
        conn.execute(
            "INSERT INTO native_drafts VALUES(?1,?2) ON CONFLICT(rid) DO UPDATE SET text=excluded.text",
            params![rid, text],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap()
    }
    fn identity() -> Identity {
        Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() }
    }
    fn snapshot() -> Snapshot {
        let fixture = fixture();
        Snapshot {
            protocol_version: 1,
            rooms: vec![serde_json::from_value(fixture["room"].clone()).unwrap()],
            messages: vec![serde_json::from_value(fixture["message"].clone()).unwrap()],
            cursor: "initial".into(),
        }
    }
    fn store() -> NativeStore {
        NativeStore::open(Path::new(":memory:"), identity()).unwrap()
    }
    #[test]
    fn cursor_and_echo_roll_back_together() {
        let store = store();
        let snapshot = snapshot();
        store.snapshot(&snapshot).unwrap();
        let message = snapshot.messages[0].clone();
        store.enqueue("pending", &message.room_id, "queued", "alice").unwrap();
        store
            .conn
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_cursor BEFORE UPDATE ON native_state BEGIN SELECT RAISE(ABORT,'injected'); END;",
            )
            .unwrap();
        let mut echo = message;
        echo.id = "pending".into();
        echo.text = "confirmed".into();
        assert!(
            store
                .batch(&SyncBatch {
                    protocol_version: 1,
                    changes: vec![Change::MessageUpsert(echo)],
                    cursor: "next".into(),
                    has_more: false
                })
                .is_err()
        );
        assert_eq!(store.cursor().unwrap().as_deref(), Some("initial"));
        assert_eq!(store.pending().unwrap().len(), 1);
        assert_eq!(store.messages("room-id", 100).unwrap().last().unwrap().text, "queued");
    }
    #[test]
    fn unresolved_room_creation_survives_reopen_and_reuses_its_intent() {
        let path = std::env::temp_dir().join(format!("rv-room-{:032x}.sqlite", fastrand::u128(..)));
        let original = NativeStore::open(&path, identity()).unwrap();
        original.snapshot(&snapshot()).unwrap();
        let id = original.room_creation("Durable room", true).unwrap();
        drop(original);
        let resumed = NativeStore::open(&path, identity()).unwrap();
        assert_eq!(resumed.room_creation("Durable room", true).unwrap(), id);
        resumed.complete_room_creation(&id).unwrap();
        assert_ne!(resumed.room_creation("Durable room", true).unwrap(), id);
        resumed.clear().unwrap();
        drop(resumed);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn withdrawal_and_late_history_cannot_restore_private_data() {
        let store = store();
        let snapshot = snapshot();
        store.snapshot(&snapshot).unwrap();
        store.enqueue("pending", "room-id", "queued", "alice").unwrap();
        store.set_draft("room-id", "draft").unwrap();
        store
            .batch(&SyncBatch {
                protocol_version: 1,
                changes: vec![Change::RoomRemoved { room_id: "room-id".into() }],
                cursor: "removed".into(),
                has_more: false,
            })
            .unwrap();
        store.ingest(&snapshot.messages).unwrap();
        assert!(store.messages("room-id", 100).unwrap().is_empty());
        assert!(store.pending().unwrap().is_empty());
        assert_eq!(store.draft("room-id").unwrap(), "");
    }
    #[test]
    fn exact_positions_survive_replay_and_ignore_wall_clock() {
        let store = store();
        let mut snapshot = snapshot();
        let mut later = snapshot.messages[0].clone();
        later.id = "later".into();
        later.position = "9007199254740994".into();
        later.revision = later.position.clone();
        later.created_at = "2020-01-01T00:00:00Z".into();
        snapshot.messages.push(later);
        store.snapshot(&snapshot).unwrap();
        store.snapshot(&snapshot).unwrap();
        let messages = store.messages("room-id", 100).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].id, "later");
        assert_eq!(store.oldest("room-id").unwrap().as_deref(), Some("9007199254740993"));
    }
    #[test]
    fn reopening_disk_preserves_outbox_and_new_generation_hides_and_drops_it() {
        let path = std::env::temp_dir().join(format!("rv-native-{:032x}.sqlite", fastrand::u128(..)));
        {
            let store = NativeStore::open(&path, identity()).unwrap();
            store.snapshot(&snapshot()).unwrap();
            store.enqueue("durable", "room-id", "queued", "alice").unwrap();
        }
        {
            let store = NativeStore::open(&path, identity()).unwrap();
            assert_eq!(store.pending().unwrap()[0].id, "durable");
            assert_eq!(store.cursor().unwrap().as_deref(), Some("initial"));
        }
        {
            let store = NativeStore::open(&path, Identity { data_epoch: "new".into(), ..identity() }).unwrap();
            assert!(store.rooms().unwrap().is_empty());
            assert!(store.pending().unwrap().is_empty());
            assert!(store.enqueue("new", "room-id", "forbidden", "alice").is_err());
            store
                .snapshot(&Snapshot { protocol_version: 1, rooms: vec![], messages: vec![], cursor: "fresh".into() })
                .unwrap();
            assert!(store.pending().unwrap().is_empty());
        }
        std::fs::remove_file(path).unwrap();
    }
}
