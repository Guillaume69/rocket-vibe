//! Local SQLite store. One database per (server, account). Every write goes
//! through `Store::write`, which runs in one transaction and broadcasts one
//! change notification after the commit.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use tokio::sync::broadcast;

use crate::normalize::{Message, Room, Subscription};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Change {
    pub rooms: bool,
    pub rids: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxEntry {
    pub id: String,
    pub rid: String,
    pub text: String,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomRow {
    pub rid: String,
    pub kind: String,
    pub name: String,
    pub last_message: Option<String>,
    pub last_ts: i64,
    pub unread: i64,
    pub mentions: i64,
    pub alert: bool,
    pub favorite: bool,
    pub encrypted: bool,
    pub read_only: bool,
    pub dm_other_uid: Option<String>,
    pub avatar_etag: Option<String>,
    /// The room's `name` (its URL slug), unlike `name` above which is for display.
    pub slug: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageRow {
    pub id: String,
    pub ts: i64,
    pub text: Option<String>,
    pub author: Option<String>,
    pub author_id: String,
    pub system_type: Option<String>,
    pub edited: bool,
    pub attachments: Option<String>,
    pub thread_count: i64,
    pub outbox_status: Option<String>,
    pub md: Option<String>,
    pub reactions: Option<String>,
    pub thread_id: Option<String>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS rooms (
  rid TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT,
  display_name TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0,
  read_only INTEGER NOT NULL DEFAULT 0,
  dm_other_uid TEXT,
  last_message TEXT,
  last_message_type TEXT,
  last_message_ts INTEGER,
  avatar_etag TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  rid TEXT PRIMARY KEY,
  sub_id TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  mentions INTEGER NOT NULL DEFAULT 0,
  group_mentions INTEGER NOT NULL DEFAULT 0,
  alert INTEGER NOT NULL DEFAULT 0,
  open INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_sub_id ON subscriptions(sub_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  rid TEXT NOT NULL,
  text TEXT,
  ts INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT,
  system_type TEXT,
  thread_id TEXT,
  thread_count INTEGER NOT NULL DEFAULT 0,
  thread_last INTEGER,
  thread_shown INTEGER NOT NULL DEFAULT 0,
  edited_at INTEGER,
  attachments TEXT,
  reactions TEXT,
  encrypted_raw TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_rid_ts ON messages(rid, ts);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  rid TEXT NOT NULL,
  text TEXT NOT NULL,
  thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
CREATE TABLE IF NOT EXISTS cursors (
  scope TEXT NOT NULL,
  stream TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (scope, stream)
);
"#;

/// Applied in order, once each: `PRAGMA user_version` counts those already run.
/// Append only; never edit a shipped step.
const MIGRATIONS: &[&str] =
    &["ALTER TABLE messages ADD COLUMN md TEXT", "CREATE TABLE drafts (key TEXT PRIMARY KEY, text TEXT NOT NULL)"];

pub struct Store {
    conn: Mutex<Connection>,
    changes: broadcast::Sender<Change>,
}

/// The write side, only reachable inside `Store::write`.
pub struct Writer<'a> {
    conn: &'a Connection,
    change: Change,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        Self::from_connection(Connection::open(path)?)
    }

    pub fn in_memory() -> rusqlite::Result<Store> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> rusqlite::Result<Store> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(SCHEMA)?;
        let applied: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, step) in MIGRATIONS.iter().enumerate().skip(applied.max(0) as usize) {
            conn.execute_batch(step)?;
            conn.pragma_update(None, "user_version", i as i64 + 1)?;
        }
        let (changes, _) = broadcast::channel(256);
        Ok(Store { conn: Mutex::new(conn), changes })
    }

    pub fn changes(&self) -> broadcast::Receiver<Change> {
        self.changes.subscribe()
    }

    pub fn write<R>(&self, f: impl FnOnce(&mut Writer) -> R) -> R {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().expect("begin");
        let (result, change) = {
            let mut writer = Writer { conn: &tx, change: Change::default() };
            let result = f(&mut writer);
            (result, writer.change)
        };
        tx.commit().expect("commit");
        drop(conn);
        if change.rooms || !change.rids.is_empty() {
            let _ = self.changes.send(change);
        }
        result
    }

    pub fn read<R>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> rusqlite::Result<R> {
        f(&self.conn.lock().unwrap())
    }

    pub fn cursor(&self, scope: &str, stream: &str) -> Option<i64> {
        self.read(|c| {
            c.query_row("SELECT value FROM cursors WHERE scope = ?1 AND stream = ?2", params![scope, stream], |r| {
                r.get(0)
            })
            .optional()
        })
        .ok()
        .flatten()
    }

    /// The draft of a room (`rid`) or a thread (`rid:tmid`).
    pub fn draft(&self, key: &str) -> Option<String> {
        self.read(|c| c.query_row("SELECT text FROM drafts WHERE key = ?1", [key], |r| r.get(0)).optional())
            .ok()
            .flatten()
    }

    /// Usernames of the room's recent authors, most recent first.
    pub fn recent_authors(&self, rid: &str, limit: i64) -> Vec<String> {
        self.read(|c| {
            let mut q = c.prepare(
                "SELECT author_name FROM messages WHERE rid = ?1 AND author_name IS NOT NULL AND system_type IS NULL
                 GROUP BY author_name ORDER BY MAX(ts) DESC LIMIT ?2",
            )?;
            q.query_map(params![rid, limit], |r| r.get(0))?.collect()
        })
        .unwrap_or_default()
    }

    pub fn pending_outbox(&self) -> Vec<OutboxEntry> {
        self.read(|c| {
            let mut q = c.prepare(
                "SELECT id, rid, text, thread_id FROM outbox WHERE status = 'pending' ORDER BY created_at, id",
            )?;
            q.query_map([], |r| {
                Ok(OutboxEntry { id: r.get(0)?, rid: r.get(1)?, text: r.get(2)?, thread_id: r.get(3)? })
            })?
            .collect()
        })
        .unwrap_or_default()
    }

    pub fn rooms(&self) -> Vec<RoomRow> {
        self.read(|c| {
            let mut q = c.prepare(
                "SELECT r.rid, r.type, COALESCE(r.display_name, r.name, r.rid), r.last_message,
                        COALESCE(r.last_message_ts, 0), s.unread, s.mentions + s.group_mentions, s.alert,
                        s.favorite, r.encrypted, r.read_only, r.dm_other_uid, r.avatar_etag, r.name
                 FROM rooms r JOIN subscriptions s ON s.rid = r.rid
                 WHERE s.open = 1
                 ORDER BY COALESCE(r.last_message_ts, 0) DESC",
            )?;
            q.query_map([], |r| {
                Ok(RoomRow {
                    rid: r.get(0)?,
                    kind: r.get(1)?,
                    name: r.get(2)?,
                    last_message: r.get(3)?,
                    last_ts: r.get(4)?,
                    unread: r.get(5)?,
                    mentions: r.get(6)?,
                    alert: r.get(7)?,
                    favorite: r.get(8)?,
                    encrypted: r.get(9)?,
                    read_only: r.get(10)?,
                    dm_other_uid: r.get(11)?,
                    avatar_etag: r.get(12)?,
                    slug: r.get(13)?,
                })
            })?
            .collect()
        })
        .unwrap_or_default()
    }

    /// The newest `limit` messages of a room, oldest first. Thread replies
    /// stay in their thread unless also shown in the room (`tshow`).
    pub fn messages(&self, rid: &str, limit: i64) -> Vec<MessageRow> {
        self.message_rows("m.rid = ?1 AND (m.thread_id IS NULL OR m.thread_shown = 1)", rid, limit)
    }

    /// A thread: its root, then every reply, oldest first.
    pub fn thread_messages(&self, root_id: &str) -> Vec<MessageRow> {
        self.message_rows("(m.id = ?1 OR m.thread_id = ?1)", root_id, i64::MAX)
    }

    fn message_rows(&self, filter: &str, key: &str, limit: i64) -> Vec<MessageRow> {
        let sql = format!(
            "SELECT m.id, m.ts, m.text, m.author_name, m.author_id, m.system_type, m.edited_at IS NOT NULL,
                    m.attachments, m.thread_count, o.status, m.md, m.reactions, m.thread_id
             FROM messages m LEFT JOIN outbox o ON o.id = m.id
             WHERE {filter}
             ORDER BY m.ts DESC, m.id DESC LIMIT ?2"
        );
        let mut rows: Vec<MessageRow> = self
            .read(|c| {
                let mut q = c.prepare(&sql)?;
                q.query_map(params![key, limit], |r| {
                    Ok(MessageRow {
                        id: r.get(0)?,
                        ts: r.get(1)?,
                        text: r.get(2)?,
                        author: r.get(3)?,
                        author_id: r.get(4)?,
                        system_type: r.get(5)?,
                        edited: r.get(6)?,
                        attachments: r.get(7)?,
                        thread_count: r.get(8)?,
                        outbox_status: r.get(9)?,
                        md: r.get(10)?,
                        reactions: r.get(11)?,
                        thread_id: r.get(12)?,
                    })
                })?
                .collect()
            })
            .unwrap_or_default();
        rows.reverse();
        rows
    }
}

impl Writer<'_> {
    fn touch_rooms(&mut self) {
        self.change.rooms = true;
    }

    fn touch_messages(&mut self, rid: &str) {
        self.change.rids.insert(rid.to_owned());
    }

    fn rid_of(&self, sql: &str, key: &str) -> Option<String> {
        self.conn.query_row(sql, [key], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn upsert_message(&mut self, m: &Message) {
        // `updated_at` is the server's clock: it arbitrates between the socket
        // and a slower REST read. An optimistic row carries 0, so any server
        // version overwrites it and it never overwrites a real one.
        self.conn
            .execute(
                "INSERT INTO messages (id, rid, text, ts, author_id, author_name, system_type, thread_id,
                   thread_count, thread_last, thread_shown, edited_at, attachments, reactions, encrypted_raw, updated_at, md)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                 ON CONFLICT(id) DO UPDATE SET
                   text = CASE WHEN excluded.system_type = 'e2e' THEN COALESCE(excluded.text, messages.text) ELSE excluded.text END,
                   ts = excluded.ts,
                   author_name = excluded.author_name,
                   system_type = excluded.system_type,
                   thread_id = excluded.thread_id,
                   thread_count = excluded.thread_count,
                   thread_last = excluded.thread_last,
                   thread_shown = excluded.thread_shown,
                   edited_at = excluded.edited_at,
                   attachments = excluded.attachments,
                   reactions = excluded.reactions,
                   encrypted_raw = COALESCE(excluded.encrypted_raw, messages.encrypted_raw),
                   updated_at = excluded.updated_at,
                   md = excluded.md
                 WHERE excluded.updated_at >= messages.updated_at",
                params![
                    m.id, m.rid, m.text, m.ts, m.author_id, m.author_name, m.system_type, m.thread_id,
                    m.thread_count, m.thread_last, m.thread_shown, m.edited_at, m.attachments, m.reactions,
                    m.encrypted_raw, m.updated_at, m.md
                ],
            )
            .expect("upsert message");
        self.touch_messages(&m.rid);
    }

    pub fn upsert_room(&mut self, r: &Room) {
        // COALESCE on fields the server sometimes omits from partial documents.
        // `last_message` is the exception: its absence means the last message
        // was deleted, except in an encrypted room where the server only has
        // ciphertext.
        self.conn
            .execute(
                "INSERT INTO rooms (rid, type, name, display_name, encrypted, read_only, dm_other_uid,
                   last_message, last_message_type, last_message_ts, avatar_etag, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(rid) DO UPDATE SET
                   type = excluded.type,
                   name = COALESCE(excluded.name, rooms.name),
                   display_name = COALESCE(excluded.display_name, rooms.display_name),
                   encrypted = excluded.encrypted,
                   read_only = excluded.read_only,
                   dm_other_uid = COALESCE(excluded.dm_other_uid, rooms.dm_other_uid),
                   last_message = CASE WHEN excluded.encrypted = 1 THEN rooms.last_message ELSE excluded.last_message END,
                   last_message_type = CASE WHEN excluded.encrypted = 1 THEN rooms.last_message_type ELSE excluded.last_message_type END,
                   last_message_ts = COALESCE(excluded.last_message_ts, rooms.last_message_ts),
                   avatar_etag = COALESCE(excluded.avatar_etag, rooms.avatar_etag),
                   updated_at = excluded.updated_at
                 WHERE excluded.updated_at >= rooms.updated_at",
                params![
                    r.rid, r.kind, r.name, r.display_name, r.encrypted, r.read_only, r.dm_other_uid,
                    r.last_message, r.last_message_type, r.last_message_ts, r.avatar_etag, r.updated_at
                ],
            )
            .expect("upsert room");
        self.touch_rooms();
    }

    pub fn upsert_subscription(&mut self, s: &Subscription) {
        self.conn
            .execute(
                "INSERT INTO subscriptions (rid, sub_id, unread, mentions, group_mentions, alert, open, favorite, last_seen, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(rid) DO UPDATE SET
                   sub_id = COALESCE(excluded.sub_id, subscriptions.sub_id),
                   unread = excluded.unread,
                   mentions = excluded.mentions,
                   group_mentions = excluded.group_mentions,
                   alert = excluded.alert,
                   open = excluded.open,
                   favorite = excluded.favorite,
                   last_seen = excluded.last_seen,
                   updated_at = excluded.updated_at
                 WHERE excluded.updated_at >= subscriptions.updated_at",
                params![
                    s.rid, s.sub_id, s.unread, s.mentions, s.group_mentions, s.alert, s.open, s.favorite,
                    s.last_seen, s.updated_at
                ],
            )
            .expect("upsert subscription");
        self.touch_rooms();
    }

    pub fn delete_message(&mut self, id: &str) {
        let Some(rid) = self.rid_of("SELECT rid FROM messages WHERE id = ?1", id) else { return };
        self.conn.execute("DELETE FROM messages WHERE id = ?1", [id]).expect("delete message");
        self.touch_messages(&rid);
    }

    pub fn delete_room(&mut self, rid: &str) {
        for table in ["messages", "subscriptions", "rooms", "outbox"] {
            self.conn.execute(&format!("DELETE FROM {table} WHERE rid = ?1"), [rid]).expect("delete room");
        }
        self.conn.execute("DELETE FROM cursors WHERE scope = ?1", [rid]).expect("delete cursors");
        self.touch_rooms();
        self.touch_messages(rid);
    }

    pub fn delete_by_subscription_id(&mut self, sub_id: &str) {
        if let Some(rid) = self.rid_of("SELECT rid FROM subscriptions WHERE sub_id = ?1", sub_id) {
            self.delete_room(&rid);
        }
    }

    pub fn write_cursor(&mut self, scope: &str, stream: &str, value: i64) {
        self.conn
            .execute(
                "INSERT INTO cursors (scope, stream, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(scope, stream) DO UPDATE SET value = excluded.value WHERE excluded.value > cursors.value",
                params![scope, stream, value],
            )
            .expect("write cursor");
    }

    pub fn cursor(&self, scope: &str, stream: &str) -> Option<i64> {
        self.conn
            .query_row("SELECT value FROM cursors WHERE scope = ?1 AND stream = ?2", params![scope, stream], |r| {
                r.get(0)
            })
            .optional()
            .ok()
            .flatten()
    }

    /// An empty draft is deleted rather than stored.
    pub fn set_draft(&mut self, key: &str, text: &str) {
        if text.trim().is_empty() {
            self.conn.execute("DELETE FROM drafts WHERE key = ?1", [key]).expect("delete draft");
        } else {
            self.conn
                .execute(
                    "INSERT INTO drafts (key, text) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET text = excluded.text",
                    params![key, text],
                )
                .expect("set draft");
        }
    }

    pub fn insert_outbox(&mut self, id: &str, rid: &str, text: &str, thread_id: Option<&str>) {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO outbox (id, rid, text, thread_id) VALUES (?1, ?2, ?3, ?4)",
                params![id, rid, text, thread_id],
            )
            .expect("insert outbox");
        self.touch_messages(rid);
    }

    fn outbox_update(&mut self, sql: &str, p: impl rusqlite::Params) {
        let rid: Option<String> = self.conn.query_row(sql, p, |r| r.get(0)).optional().ok().flatten();
        if let Some(rid) = rid {
            self.touch_messages(&rid);
        }
    }

    pub fn mark_outbox_failed(&mut self, id: &str, error: &str) {
        self.outbox_update(
            "UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ?1 WHERE id = ?2 RETURNING rid",
            params![error, id],
        );
    }

    pub fn mark_outbox_pending(&mut self, id: &str) {
        self.outbox_update("UPDATE outbox SET status = 'pending' WHERE id = ?1 RETURNING rid", params![id]);
    }

    pub fn delete_outbox(&mut self, id: &str) {
        self.outbox_update("DELETE FROM outbox WHERE id = ?1 RETURNING rid", params![id]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, text: Option<&str>, updated_at: i64, rid: &str) -> Message {
        Message {
            id: id.into(),
            rid: rid.into(),
            text: text.map(Into::into),
            ts: 100,
            author_id: "u".into(),
            updated_at,
            ..Default::default()
        }
    }

    fn text_of(store: &Store, id: &str) -> Option<String> {
        store.read(|c| c.query_row("SELECT text FROM messages WHERE id = ?1", [id], |r| r.get(0))).unwrap()
    }

    fn count(store: &Store, table: &str) -> i64 {
        store.read(|c| c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))).unwrap()
    }

    #[test]
    fn migrations_upgrade_an_existing_database() {
        let dir = std::env::temp_dir().join(format!("rv-migrate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let old = Connection::open(&path).unwrap();
            old.execute_batch(SCHEMA).unwrap();
            old.execute("INSERT INTO messages (id, rid, ts, author_id, updated_at) VALUES ('m', 'r', 1, 'u', 1)", [])
                .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let version: i64 = store.read(|c| c.pragma_query_value(None, "user_version", |r| r.get(0))).unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        assert_eq!(store.messages("r", 10)[0].md, None);
        drop(store);
        assert!(Store::open(&path).is_ok(), "reopening must not rerun the steps");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn older_version_never_overwrites_newer() {
        let store = Store::in_memory().unwrap();
        store.write(|w| w.upsert_message(&message("m", Some("v2"), 20, "r")));
        store.write(|w| w.upsert_message(&message("m", Some("v1"), 10, "r")));
        assert_eq!(text_of(&store, "m").as_deref(), Some("v2"));
        store.write(|w| w.upsert_message(&message("m", Some("v3"), 30, "r")));
        assert_eq!(text_of(&store, "m").as_deref(), Some("v3"));
    }

    #[test]
    fn optimistic_row_is_overwritten_and_never_overwrites() {
        let store = Store::in_memory().unwrap();
        store.write(|w| w.upsert_message(&message("m", Some("local"), 0, "r")));
        store.write(|w| w.upsert_message(&message("m", Some("server"), 5, "r")));
        assert_eq!(text_of(&store, "m").as_deref(), Some("server"));
        store.write(|w| w.upsert_message(&message("m", Some("local"), 0, "r")));
        assert_eq!(text_of(&store, "m").as_deref(), Some("server"));
    }

    #[test]
    fn cursor_never_moves_backwards() {
        let store = Store::in_memory().unwrap();
        assert_eq!(store.cursor("*", "rooms"), None);
        store.write(|w| w.write_cursor("*", "rooms", 50));
        store.write(|w| w.write_cursor("*", "rooms", 40));
        assert_eq!(store.cursor("*", "rooms"), Some(50));
        store.write(|w| w.write_cursor("*", "rooms", 60));
        assert_eq!(store.cursor("*", "rooms"), Some(60));
    }

    #[test]
    fn room_keeps_omitted_fields_but_clears_deleted_preview() {
        let store = Store::in_memory().unwrap();
        let full = Room {
            rid: "d1".into(),
            kind: "d".into(),
            display_name: Some("bob".into()),
            last_message: Some("hello".into()),
            last_message_ts: Some(5),
            avatar_etag: Some("e1".into()),
            updated_at: 1,
            ..Default::default()
        };
        store.write(|w| w.upsert_room(&full));
        store.write(|w| {
            w.upsert_room(&Room { rid: "d1".into(), kind: "d".into(), updated_at: 2, ..Default::default() })
        });
        let (name, etag, ts, last): (String, String, i64, Option<String>) = store
            .read(|c| {
                c.query_row("SELECT display_name, avatar_etag, last_message_ts, last_message FROM rooms", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
            })
            .unwrap();
        assert_eq!((name.as_str(), etag.as_str(), ts), ("bob", "e1", 5));
        assert_eq!(last, None);
    }

    #[test]
    fn delete_by_subscription_id_removes_everything() {
        let store = Store::in_memory().unwrap();
        store.write(|w| {
            w.upsert_room(&Room { rid: "c1".into(), kind: "c".into(), updated_at: 1, ..Default::default() });
            w.upsert_subscription(&Subscription {
                rid: "c1".into(),
                sub_id: Some("sub1".into()),
                updated_at: 1,
                ..Default::default()
            });
            w.upsert_message(&message("m", Some("x"), 1, "c1"));
            w.insert_outbox("o", "c1", "pending", None);
        });
        store.write(|w| w.delete_by_subscription_id("sub1"));
        for table in ["rooms", "subscriptions", "messages", "outbox"] {
            assert_eq!(count(&store, table), 0, "{table}");
        }
    }

    #[test]
    fn one_write_notifies_once() {
        let store = Store::in_memory().unwrap();
        let mut changes = store.changes();
        store.write(|w| {
            w.upsert_message(&message("a", Some("1"), 1, "r"));
            w.upsert_message(&message("b", Some("2"), 1, "r"));
            w.upsert_message(&message("c", Some("3"), 1, "other"));
        });
        let change = changes.try_recv().unwrap();
        assert_eq!(change.rids, BTreeSet::from(["other".to_owned(), "r".to_owned()]));
        assert!(changes.try_recv().is_err());
    }

    #[test]
    fn drafts_are_kept_per_key_and_cleared_when_empty() {
        let store = Store::in_memory().unwrap();
        let mut changes = store.changes();
        store.write(|w| w.set_draft("r", "hello"));
        store.write(|w| w.set_draft("r:t", "in thread"));
        assert_eq!(store.draft("r").as_deref(), Some("hello"));
        assert_eq!(store.draft("r:t").as_deref(), Some("in thread"));
        store.write(|w| w.set_draft("r", "  "));
        assert_eq!(store.draft("r"), None);
        assert!(changes.try_recv().is_err(), "drafts do not refresh the lists");
    }

    #[test]
    fn recent_authors_most_recent_first() {
        let store = Store::in_memory().unwrap();
        store.write(|w| {
            for (id, author, ts) in [("a", "bob", 10), ("b", "carol", 20), ("c", "bob", 30)] {
                let mut m = message(id, Some("x"), 1, "r");
                m.ts = ts;
                m.author_name = Some(author.into());
                w.upsert_message(&m);
            }
        });
        assert_eq!(store.recent_authors("r", 10), ["bob", "carol"]);
    }

    #[test]
    fn outbox_lifecycle() {
        let store = Store::in_memory().unwrap();
        store.write(|w| {
            w.insert_outbox("a", "r", "first", None);
            w.insert_outbox("b", "r", "second", Some("thread"));
        });
        assert_eq!(store.pending_outbox().len(), 2);
        assert_eq!(store.pending_outbox()[1].thread_id.as_deref(), Some("thread"));
        store.write(|w| w.mark_outbox_failed("a", "refused"));
        assert_eq!(store.pending_outbox().len(), 1);
        store.write(|w| w.mark_outbox_pending("a"));
        assert_eq!(store.pending_outbox().len(), 2);
        store.write(|w| {
            w.delete_outbox("a");
            w.delete_outbox("b");
        });
        assert!(store.pending_outbox().is_empty());
    }

    #[test]
    fn messages_are_oldest_first_and_carry_outbox_status() {
        let store = Store::in_memory().unwrap();
        store.write(|w| {
            let mut a = message("a", Some("1"), 1, "r");
            a.ts = 10;
            let mut b = message("b", Some("2"), 0, "r");
            b.ts = 20;
            w.upsert_message(&a);
            w.upsert_message(&b);
            w.insert_outbox("b", "r", "2", None);
        });
        let rows = store.messages("r", 50);
        assert_eq!(rows.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(rows[1].outbox_status.as_deref(), Some("pending"));
    }
}
