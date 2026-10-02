//! Fallible transactions: a failed projection never acknowledges its cursor or outbox echo.
mod membership;
mod read_intents;
mod read_states;
mod room_access;
mod room_operations;
use super::Identity;
pub use read_intents::{PendingRead, SavedFavorite};
pub use room_access::RoomAccess;
pub use room_operations::{RoomOperation, SavedRoomOperation};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use rv_protocol::{Change, Message, Room, Snapshot, SyncBatch, VERSION};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::broadcast;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub id: String,
    pub room_id: String,
    pub text: String,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MessageCommandKind {
    Edit,
    Delete,
    React,
    Pin,
    Star,
}
impl MessageCommandKind {
    fn value(self) -> &'static str {
        match self {
            Self::Edit => "edit",
            Self::Delete => "delete",
            Self::React => "react",
            Self::Pin => "pin",
            Self::Star => "star",
        }
    }
}
#[derive(Clone)]
pub struct PendingCommand {
    pub id: String,
    pub room_id: String,
    pub message_id: String,
    pub kind: MessageCommandKind,
    pub expected_revision: String,
    pub text: String,
}
fn command_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingCommand> {
    let kind: String = row.get(3)?;
    Ok(PendingCommand {
        id: row.get(0)?,
        room_id: row.get(1)?,
        message_id: row.get(2)?,
        kind: match kind.as_str() {
            "edit" => MessageCommandKind::Edit,
            "delete" => MessageCommandKind::Delete,
            "react" => MessageCommandKind::React,
            "pin" => MessageCommandKind::Pin,
            "star" => MessageCommandKind::Star,
            _ => return Err(rusqlite::Error::InvalidQuery),
        },
        expected_revision: row.get(4)?,
        text: row.get(5)?,
    })
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageRow {
    pub id: String,
    pub position: Option<String>,
    pub text: String,
    pub author: String,
    pub body: Option<String>,
    pub author_id: String,
    pub ts: i64,
    pub status: Option<String>,
    pub edited: bool,
    pub reactions: Option<String>,
    pub pinned: bool,
    pub starred: bool,
}
impl MessageRow {
    pub fn presentation(self, rid: &str, uid: &str) -> crate::store::MessageRow {
        let md = super::markdown::cached_tree(self.body.as_deref(), &self.text);
        crate::store::MessageRow {
            id: self.id,
            rid: rid.into(),
            ts: self.ts,
            edited: self.edited,
            reactions: self.reactions,
            pinned: self.pinned,
            starred: self.starred.then(|| uid.into()),
            text: Some(self.text),
            md: Some(md),
            author: Some(self.author),
            author_id: if self.status.is_some() { uid.into() } else { self.author_id },
            outbox_status: self.status.map(|s| if s == "failed" { "failed".into() } else { "pending".into() }),
            ..Default::default()
        }
    }
}
pub struct NativeStore {
    conn: Mutex<Connection>,
    identity: Identity,
    changes: broadcast::Sender<()>,
    projection: AtomicU64,
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
        conn.execute_batch("CREATE TABLE IF NOT EXISTS native_room_operations(id TEXT PRIMARY KEY,rid TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','failed')),error TEXT);")?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS native_room_access(rid TEXT PRIMARY KEY,revision TEXT NOT NULL,read_only INTEGER NOT NULL,can_send INTEGER NOT NULL,role TEXT NOT NULL);")?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS native_read_states(rid TEXT PRIMARY KEY,payload TEXT NOT NULL);
            INSERT INTO native_read_states SELECT id,json_extract(payload,'$.read_state') FROM native_rooms WHERE json_type(payload,'$.read_state')='object' ON CONFLICT(rid) DO NOTHING;")?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS native_read_intents(rid TEXT PRIMARY KEY,membership TEXT NOT NULL,root_position TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS native_favorite_intents(id TEXT NOT NULL UNIQUE,rid TEXT PRIMARY KEY,membership TEXT NOT NULL,payload TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'pending' CHECK(phase IN ('pending','confirmed','failed')),receipt_revision TEXT,error TEXT);")?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS native_commands(id TEXT PRIMARY KEY,rid TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('edit','delete')),expected_revision TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT);")?;
        let command_schema: String =
            conn.query_row("SELECT sql FROM sqlite_master WHERE name='native_commands'", [], |r| r.get(0))?;
        if !command_schema.contains("'star'") {
            conn.execute_batch("BEGIN IMMEDIATE;
                ALTER TABLE native_commands RENAME TO native_commands_previous;
                CREATE TABLE native_commands(id TEXT PRIMARY KEY,rid TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('edit','delete','react','pin','star')),expected_revision TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT);
                INSERT INTO native_commands SELECT * FROM native_commands_previous;
                DROP TABLE native_commands_previous;
                COMMIT;")?;
        }
        let (changes, _) = broadcast::channel(64);
        let columns = conn
            .prepare("PRAGMA table_info(native_messages)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (name, declaration) in [
            ("author_id", "TEXT NOT NULL DEFAULT ''"),
            ("ts", "INTEGER NOT NULL DEFAULT 0"),
            ("deleted", "INTEGER NOT NULL DEFAULT 0"),
            ("edited", "INTEGER NOT NULL DEFAULT 0"),
            ("reactions", "TEXT"),
            ("pinned", "INTEGER NOT NULL DEFAULT 0"),
            ("starred", "INTEGER NOT NULL DEFAULT 0"),
            ("star_revision", "TEXT NOT NULL DEFAULT '0'"),
            ("body", "TEXT"),
        ] {
            if !columns.iter().any(|c| c == name) {
                conn.execute_batch(&format!("ALTER TABLE native_messages ADD COLUMN {name} {declaration}"))?;
            }
        }
        Ok(Self { conn: Mutex::new(conn), identity, changes, projection: AtomicU64::new(0) })
    }
    pub fn changes(&self) -> broadcast::Receiver<()> {
        self.changes.subscribe()
    }
    pub fn clear(&self) -> rusqlite::Result<()> {
        self.atomic_projection(true, |tx| {
            for table in [
                "native_state",
                "native_rooms",
                "native_messages",
                "native_outbox",
                "native_drafts",
                "native_room_creations",
                "native_commands",
                "native_room_operations",
                "native_room_access",
                "native_read_states",
                "native_read_intents",
                "native_favorite_intents",
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
        self.atomic_projection(false, fnc)
    }
    fn atomic_projection<T>(
        &self,
        rotate: bool,
        fnc: impl FnOnce(&Transaction) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        self.atomic_invalidation(|tx| Ok((fnc(tx)?, rotate)))
    }
    fn atomic_invalidation<T>(
        &self,
        fnc: impl FnOnce(&Transaction) -> rusqlite::Result<(T, bool)>,
    ) -> rusqlite::Result<T> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let (result, rotate) = fnc(&tx)?;
        tx.commit()?;
        if rotate {
            self.projection.fetch_add(1, Ordering::SeqCst);
        }
        drop(conn);
        let _ = self.changes.send(());
        Ok(result)
    }
    pub fn projection_token(&self) -> u64 {
        self.projection.load(Ordering::SeqCst)
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
    /// A lost acknowledgement keeps the original revision and operation ID,
    /// even if a journal event already changed the visible message. A different
    /// command cannot overwrite an unresolved intention for this message.
    pub fn command(
        &self,
        rid: &str,
        message: &str,
        revision: &str,
        kind: MessageCommandKind,
        text: &str,
    ) -> rusqlite::Result<Option<PendingCommand>> {
        decimal(revision)?;
        self.atomic(|tx| {
            if !self.same(tx)? { return Err(rusqlite::Error::InvalidQuery); }
            if let Some(previous)=tx.query_row("SELECT id,rid,message_id,kind,expected_revision,text FROM native_commands WHERE message_id=?1 AND state='pending'",[message],command_row).optional()? {
                return Ok((previous.room_id==rid && previous.kind==kind && previous.text==text).then_some(previous));
            }
            let visible=tx.query_row("SELECT 1 FROM native_messages WHERE id=?1 AND rid=?2 AND NOT deleted AND position IS NOT NULL",params![message,rid],|_|Ok(())).optional()?.is_some();
            if !visible {return Err(rusqlite::Error::InvalidQuery);}
            tx.execute("DELETE FROM native_commands WHERE message_id=?1 AND state='failed'",[message])?;
            let command=PendingCommand{id:format!("{:032x}",fastrand::u128(..)),room_id:rid.into(),message_id:message.into(),kind,expected_revision:revision.into(),text:text.into()};
            tx.execute("INSERT INTO native_commands(id,rid,message_id,kind,expected_revision,text) VALUES(?1,?2,?3,?4,?5,?6)",params![command.id,rid,message,kind.value(),revision,text])?;
            Ok(Some(command))
        })
    }
    pub fn pending_commands(&self) -> rusqlite::Result<Vec<PendingCommand>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        conn.prepare("SELECT id,rid,message_id,kind,expected_revision,text FROM native_commands WHERE state='pending' ORDER BY rowid")?.query_map([],command_row)?.collect()
    }
    pub fn fail_command(&self, id: &str, code: &str) -> rusqlite::Result<()> {
        self.atomic(|tx| {
            tx.execute("UPDATE native_commands SET state='failed',error=?2 WHERE id=?1", params![id, code])?;
            Ok(())
        })
    }
    pub fn command_draft(&self, message: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        conn.query_row("SELECT text FROM native_commands WHERE message_id=?1 AND kind='edit'", [message], |r| r.get(0))
            .optional()
    }
    pub fn confirm_command(&self, id: &str, message: &Message, token: u64) -> rusqlite::Result<bool> {
        self.atomic(|tx| {
            if !self.same(tx)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            if token != self.projection_token() {
                return Ok(false);
            }
            let command = tx
                .query_row(
                    "SELECT id,rid,message_id,kind,expected_revision,text FROM native_commands WHERE id=?1",
                    [id],
                    command_row,
                )
                .optional()?;
            let Some(command) = command else {
                return Ok(true);
            };
            if command.message_id != message.id || command.room_id != message.room_id {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Self::message(tx, message)?;
            tx.execute("DELETE FROM native_commands WHERE id=?1", [id])?;
            Ok(true)
        })
    }
    fn room(tx: &Transaction, room: &Room) -> rusqlite::Result<bool> {
        let incoming = decimal(&room.revision)?;
        let previous: Option<String> =
            tx.query_row("SELECT payload FROM native_rooms WHERE id=?1", [&room.id], |r| r.get(0)).optional()?;
        let reset = Self::personal_room(tx, room, previous.is_some())?;
        let mut metadata = room.clone();
        if let Some(previous) = previous {
            let old: Room = serde_json::from_str(&previous).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if decimal(&old.revision)? > incoming {
                metadata = old;
            }
        }
        metadata.read_state = None;
        tx.execute(
            "DELETE FROM native_room_access WHERE rid=?1 AND revision<>?2",
            params![room.id, metadata.revision],
        )?;
        tx.execute(
            "INSERT INTO native_rooms VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
            params![room.id, json(&metadata)?],
        )?;
        Ok(reset)
    }
    fn message(tx: &Transaction, message: &Message) -> rusqlite::Result<()> {
        // Late history/HTTP echoes cannot restore data after a room withdrawal.
        if !tx.query_row("SELECT 1 FROM native_rooms WHERE id=?1", [&message.room_id], |_| Ok(())).optional()?.is_some()
        {
            return Ok(());
        }
        decimal(&message.position)?;
        let revision = decimal(&message.revision)?;
        if message.deleted && !message.text.is_empty() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if let Some(edited) = &message.edited_at {
            chrono::DateTime::parse_from_rfc3339(edited).map_err(|_| rusqlite::Error::InvalidQuery)?;
        }
        chrono::DateTime::parse_from_rfc3339(&message.created_at).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let old = tx
            .query_row("SELECT revision,deleted FROM native_messages WHERE id=?1", [&message.id], |r| {
                Ok((r.get::<_, Option<String>>(0)?, r.get::<_, bool>(1)?))
            })
            .optional()?;
        if old.as_ref().and_then(|r| r.0.as_deref()).map(decimal).transpose()?.is_some_and(|old| old > revision) {
            if !message.deleted && !old.is_some_and(|r| r.1) {
                Self::personal(tx, message)?;
            }
            return Ok(());
        }
        let ts = chrono::DateTime::parse_from_rfc3339(&message.created_at)
            .map_err(|_| rusqlite::Error::InvalidQuery)?
            .timestamp_millis();
        let reactions = if message.reactions.is_empty() {
            None
        } else {
            Some(json(&message.reactions.iter().map(|reaction|(format!(":{}:",reaction.emoji),serde_json::json!({"usernames":reaction.users.iter().map(|user|&user.username).collect::<Vec<_>>()}))).collect::<std::collections::BTreeMap<_,_>>())?)
        };
        let body = if message.deleted { None } else { message.body.as_ref().map(json).transpose()? };
        tx.execute("INSERT INTO native_messages(id,rid,position,revision,text,author,author_id,ts,deleted,edited,reactions,body) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(id) DO UPDATE SET position=excluded.position,revision=excluded.revision,text=excluded.text,author=excluded.author,author_id=excluded.author_id,ts=excluded.ts,deleted=excluded.deleted,edited=excluded.edited,reactions=excluded.reactions,body=excluded.body",params![message.id,message.room_id,message.position,message.revision,message.text,message.author.username,message.author.id,ts,message.deleted,message.edited_at.is_some(),reactions,body])?;
        tx.execute("DELETE FROM native_outbox WHERE id=?1", [&message.id])?;
        tx.execute("UPDATE native_messages SET pinned=?2 WHERE id=?1", params![message.id, message.pinned])?;
        Self::personal(tx, message)?;
        Ok(())
    }
    fn personal(tx: &Transaction, message: &Message) -> rusqlite::Result<()> {
        if message.deleted {
            tx.execute(
                "UPDATE native_messages SET starred=0,star_revision=?2 WHERE id=?1",
                params![message.id, message.revision],
            )?;
        } else if let Some(star) = &message.personal_star {
            let incoming = decimal(&star.revision)?;
            let previous: String =
                tx.query_row("SELECT star_revision FROM native_messages WHERE id=?1", [&message.id], |r| r.get(0))?;
            if incoming >= decimal(&previous)? {
                tx.execute(
                    "UPDATE native_messages SET starred=?2,star_revision=?3 WHERE id=?1",
                    params![message.id, star.present, star.revision],
                )?;
            }
        }
        Ok(())
    }
    fn remove(tx: &Transaction, rid: &str) -> rusqlite::Result<()> {
        tx.execute("DELETE FROM native_rooms WHERE id=?1", [rid])?;
        Self::remove_content(tx, rid)
    }
    fn remove_content(tx: &Transaction, rid: &str) -> rusqlite::Result<()> {
        for table in [
            "native_messages",
            "native_outbox",
            "native_drafts",
            "native_commands",
            "native_room_operations",
            "native_room_access",
            "native_read_states",
            "native_read_intents",
            "native_favorite_intents",
        ] {
            tx.execute(&format!("DELETE FROM {table} WHERE rid=?1"), [rid])?;
        }
        Ok(())
    }
    pub fn snapshot(&self, snapshot: &Snapshot) -> rusqlite::Result<()> {
        if snapshot.protocol_version != VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic_projection(true, |tx| {
            if !self.same(tx)? {
                for table in [
                    "native_rooms",
                    "native_messages",
                    "native_outbox",
                    "native_drafts",
                    "native_room_creations",
                    "native_commands",
                    "native_room_operations",
                    "native_room_access",
                    "native_read_states",
                    "native_read_intents",
                    "native_favorite_intents",
                ] {
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
                // A reset snapshot only includes a bounded recent window. Old
                // confirmed history may contain deletions missed by this cursor.
                // Keep the unsent projection, drafts and outbox for live rooms.
                tx.execute("DELETE FROM native_messages WHERE position IS NOT NULL", [])?;
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
        self.atomic_invalidation(|tx| {
            if !self.same(tx)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let mut rotate = batch.changes.iter().any(|c| matches!(c, Change::RoomRemoved { .. }));
            for change in &batch.changes {
                match change {
                    Change::RoomUpsert(room) => rotate |= Self::room(tx, room)?,
                    Change::MessageUpsert(message) => Self::message(tx, message)?,
                    Change::RoomRemoved { room_id } => Self::remove(tx, room_id)?,
                }
            }
            self.cursor_in(tx, &batch.cursor)?;
            Ok(((), rotate))
        })
    }
    pub fn ingest(&self, messages: &[Message]) -> rusqlite::Result<()> {
        self.ingest_at(messages, self.projection_token()).map(|_| ())
    }
    pub fn ingest_at(&self, messages: &[Message], token: u64) -> rusqlite::Result<bool> {
        self.atomic(|tx| {
            if !self.same(tx)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            if token != self.projection_token() {
                return Ok(false);
            }
            for message in messages {
                Self::message(tx, message)?;
            }
            Ok(true)
        })
    }
    pub fn rooms(&self) -> rusqlite::Result<Vec<Room>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        conn.prepare(
            "SELECT r.payload,s.payload FROM native_rooms r LEFT JOIN native_read_states s ON s.rid=r.id ORDER BY r.id",
        )?
        .query_map([], |r| {
            let value: String = r.get(0)?;
            let mut room: Room = serde_json::from_str(&value).map_err(|_| rusqlite::Error::InvalidQuery)?;
            if let Some(personal) = r.get::<_, Option<String>>(1)? {
                room.read_state =
                    Some(Box::new(serde_json::from_str(&personal).map_err(|_| rusqlite::Error::InvalidQuery)?));
            }
            Ok(room)
        })?
        .collect()
    }
    pub fn messages(&self, rid: &str, limit: usize) -> rusqlite::Result<Vec<MessageRow>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        let mut rows=conn.prepare("SELECT m.id,m.text,m.author,o.status,m.author_id,m.ts,m.edited,m.reactions,m.pinned,m.starred,m.position,m.body FROM native_messages m LEFT JOIN native_outbox o ON o.id=m.id WHERE m.rid=?1 AND NOT m.deleted ORDER BY m.position IS NULL DESC,o.created DESC,length(m.position) DESC,m.position DESC,m.id DESC LIMIT ?2")?.query_map(params![rid,limit as i64],|r|Ok(MessageRow {id:r.get(0)?,text:r.get(1)?,author:r.get(2)?,body:r.get(11)?,status:r.get(3)?,author_id:r.get(4)?,ts:r.get(5)?,edited:r.get(6)?,reactions:r.get(7)?,pinned:r.get(8)?,starred:r.get(9)?,position:r.get(10)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows.reverse();
        Ok(rows)
    }
    pub fn oldest(&self, rid: &str) -> rusqlite::Result<Option<String>> {
        self.conn.lock().unwrap().query_row("SELECT position FROM native_messages WHERE rid=?1 AND position IS NOT NULL ORDER BY length(position),position LIMIT 1",[rid],|r|r.get(0)).optional()
    }
    pub fn selected_messages(&self, ids: &[String]) -> rusqlite::Result<Vec<MessageRow>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        let mut query = conn.prepare("SELECT id,text,author,author_id,ts,edited,reactions,pinned,starred,position,body FROM native_messages WHERE id=?1 AND NOT deleted")?;
        let mut rows = Vec::new();
        for id in ids {
            if let Some(row) = query
                .query_row([id], |r| {
                    Ok(MessageRow {
                        id: r.get(0)?,
                        position: r.get(9)?,
                        body: r.get(10)?,
                        text: r.get(1)?,
                        author: r.get(2)?,
                        author_id: r.get(3)?,
                        ts: r.get(4)?,
                        status: None,
                        edited: r.get(5)?,
                        reactions: r.get(6)?,
                        pinned: r.get(7)?,
                        starred: r.get(8)?,
                    })
                })
                .optional()?
            {
                rows.push(row);
            }
        }
        Ok(rows)
    }
    pub fn enqueue(&self, id: &str, rid: &str, text: &str, username: &str) -> rusqlite::Result<()> {
        self.enqueue_checked(id, rid, text, username, None).map(|_| ())
    }
    pub fn enqueue_from_membership(
        &self,
        id: &str,
        rid: &str,
        text: &str,
        username: &str,
        membership: Option<&str>,
    ) -> rusqlite::Result<bool> {
        self.enqueue_checked(id, rid, text, username, Some(membership))
    }
    fn enqueue_checked(
        &self,
        id: &str,
        rid: &str,
        text: &str,
        username: &str,
        membership: Option<Option<&str>>,
    ) -> rusqlite::Result<bool> {
        self.atomic(|tx| {
            if let Some(expected) = membership
                && !self.membership_matches_in(tx, rid, expected)?
            {
                return Ok(false);
            }
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
            Ok(true)
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
    fn edits_tombstones_and_reset_do_not_resurrect_stale_history() {
        let store = store();
        let initial = snapshot();
        let original = initial.messages[0].clone();
        store.snapshot(&initial).unwrap();
        let mut edited = original.clone();
        edited.text = "edited".into();
        edited.revision = "9007199254740994".into();
        edited.edited_at = Some("2020-01-01T00:00:00Z".into());
        store.ingest(&[edited.clone()]).unwrap();
        store.ingest(std::slice::from_ref(&original)).unwrap();
        let row = store.messages("room-id", 10).unwrap().pop().unwrap();
        assert_eq!(row.text, "edited");
        assert!(row.edited);
        let mut tombstone = edited;
        tombstone.text.clear();
        tombstone.deleted = true;
        tombstone.revision = "9007199254740995".into();
        store.ingest(&[tombstone]).unwrap();
        store.ingest(std::slice::from_ref(&original)).unwrap();
        assert!(store.messages("room-id", 10).unwrap().is_empty());
        assert_eq!(
            store
                .conn
                .lock()
                .unwrap()
                .query_row("SELECT text FROM native_messages WHERE id=?1", [&original.id], |r| r.get::<_, String>(0))
                .unwrap(),
            ""
        );
        store.enqueue("pending", "room-id", "unsent", "alice").unwrap();
        store.set_draft("room-id", "draft").unwrap();
        let old_token = store.projection_token();
        store.snapshot(&Snapshot { messages: vec![], cursor: "reset".into(), ..initial }).unwrap();
        assert!(!store.ingest_at(&[original], old_token).unwrap());
        assert_eq!(store.messages("room-id", 10).unwrap().len(), 1);
        assert_eq!(store.pending().unwrap()[0].id, "pending");
        assert_eq!(store.draft("room-id").unwrap(), "draft");
    }
    #[test]
    fn unresolved_commands_survive_restart_and_keep_the_original_revision() {
        let path = std::env::temp_dir().join(format!("rv-command-{:032x}.sqlite", fastrand::u128(..)));
        let initial = snapshot();
        let message = &initial.messages[0];
        let original = NativeStore::open(&path, identity()).unwrap();
        original.snapshot(&initial).unwrap();
        let pending = original
            .command(&message.room_id, &message.id, &message.revision, MessageCommandKind::Edit, "Edited")
            .unwrap()
            .unwrap();
        drop(original);
        let store = NativeStore::open(&path, identity()).unwrap();
        assert_eq!(store.pending_commands().unwrap()[0].id, pending.id);
        let mut edited = message.clone();
        edited.text = "Edited".into();
        edited.revision = "9007199254740994".into();
        store.ingest(std::slice::from_ref(&edited)).unwrap();
        let replay = store
            .command(&message.room_id, &message.id, &edited.revision, MessageCommandKind::Edit, "Edited")
            .unwrap()
            .unwrap();
        assert_eq!(replay.id, pending.id);
        assert_eq!(replay.expected_revision, message.revision);
        assert!(
            store
                .command(&message.room_id, &message.id, &edited.revision, MessageCommandKind::Delete, "")
                .unwrap()
                .is_none()
        );
        let mut wrong = edited.clone();
        wrong.id = "wrong-message".into();
        assert!(store.confirm_command(&pending.id, &wrong, store.projection_token()).is_err());
        assert_eq!(store.pending_commands().unwrap().len(), 1);
        store.fail_command(&pending.id, "revision_conflict").unwrap();
        assert_eq!(store.command_draft(&message.id).unwrap().as_deref(), Some("Edited"));
        let fresh = store
            .command(&message.room_id, &message.id, &edited.revision, MessageCommandKind::Delete, "")
            .unwrap()
            .unwrap();
        assert_ne!(fresh.id, pending.id);
        let token = store.projection_token();
        store.snapshot(&Snapshot { messages: vec![], ..initial.clone() }).unwrap();
        assert!(!store.confirm_command(&fresh.id, &edited, token).unwrap());
        let mut deleted = edited;
        deleted.text.clear();
        deleted.deleted = true;
        deleted.revision = "9007199254740995".into();
        assert!(store.confirm_command(&fresh.id, &deleted, store.projection_token()).unwrap());
        assert!(store.pending_commands().unwrap().is_empty());
        assert!(store.messages(&message.room_id, 10).unwrap().is_empty());
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn independent_personal_revisions_preserve_new_public_content_and_tombstones() {
        let store = NativeStore::open(Path::new(":memory:"), identity()).unwrap();
        let mut initial = snapshot();
        initial.messages[0].revision = "1".into();
        store.snapshot(&initial).unwrap();
        let mut private = initial.messages[0].clone();
        private.personal_star = Some(Box::new(rv_protocol::PersonalStar { present: true, revision: "3".into() }));
        store.ingest(&[private.clone()]).unwrap();
        let mut public = initial.messages[0].clone();
        public.revision = "4".into();
        public.text = "New public text".into();
        public.pinned = true;
        store.ingest(&[public.clone()]).unwrap();
        let row = store.messages(&public.room_id, 10).unwrap().remove(0);
        assert!(row.starred && row.pinned);
        assert_eq!(row.text, public.text);
        let mut remove = private.clone();
        remove.personal_star = Some(Box::new(rv_protocol::PersonalStar { present: false, revision: "5".into() }));
        store.ingest(&[remove, private.clone()]).unwrap();
        let row = store.messages(&public.room_id, 10).unwrap().remove(0);
        assert!(!row.starred && row.pinned);
        assert_eq!(row.text, public.text);
        public.deleted = true;
        public.text.clear();
        public.revision = "6".into();
        public.pinned = false;
        store.ingest(&[public.clone(), private]).unwrap();
        assert!(store.selected_messages(&[public.id.clone()]).unwrap().is_empty());
        let state: (bool, String) = store
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT starred,star_revision FROM native_messages WHERE id=?1", [public.id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert!(!state.0);
        assert_eq!(state.1, "6");
    }
    #[test]
    fn reaction_migration_preserves_old_commands_and_projects_without_reordering_or_edit_markers() {
        let path = std::env::temp_dir().join(format!("rv-react-upgrade-{:032x}.sqlite", fastrand::u128(..)));
        let initial = snapshot();
        let message = &initial.messages[0];
        let first = NativeStore::open(&path, identity()).unwrap();
        first.snapshot(&initial).unwrap();
        // Recreate the preceding application's schema before upgrading it.
        first.conn.lock().unwrap().execute_batch("DROP TABLE native_commands;
            CREATE TABLE native_commands(id TEXT PRIMARY KEY,rid TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('edit','delete')),expected_revision TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT);").unwrap();
        let old = first
            .command(&message.room_id, &message.id, &message.revision, MessageCommandKind::Edit, "Keep draft")
            .unwrap()
            .unwrap();
        drop(first);
        let store = NativeStore::open(&path, identity()).unwrap();
        assert_eq!(store.pending_commands().unwrap()[0].id, old.id);
        assert_eq!(store.command_draft(&message.id).unwrap().as_deref(), Some("Keep draft"));
        store.fail_command(&old.id, "revision_conflict").unwrap();
        let command = store
            .command(
                &message.room_id,
                &message.id,
                "0",
                MessageCommandKind::React,
                r#"{"emoji":"heart","present":true}"#,
            )
            .unwrap()
            .unwrap();
        let mut reacted = message.clone();
        reacted.reactions =
            vec![rv_protocol::MessageReaction { emoji: "heart".into(), users: vec![message.author.clone()] }];
        reacted.revision = "9007199254740994".into();
        store.confirm_command(&command.id, &reacted, store.projection_token()).unwrap();
        store.ingest(std::slice::from_ref(message)).unwrap();
        let rows = store.messages(&message.room_id, 10).unwrap();
        assert_eq!(rows[0].ts, chrono::DateTime::parse_from_rfc3339(&message.created_at).unwrap().timestamp_millis());
        assert!(!rows[0].edited);
        let groups: serde_json::Value = serde_json::from_str(rows[0].reactions.as_deref().unwrap()).unwrap();
        assert_eq!(groups[":heart:"]["usernames"][0], message.author.username);
        drop(store);
        let reopened = NativeStore::open(&path, identity()).unwrap();
        assert_eq!(reopened.messages(&message.room_id, 10).unwrap()[0].reactions, rows[0].reactions);
        drop(reopened);
        std::fs::remove_file(path).unwrap();
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
