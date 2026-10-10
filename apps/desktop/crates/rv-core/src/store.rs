//! Local SQLite store. One database per (server, account). Every write goes
//! through `Store::write`, which runs in one transaction and broadcasts one
//! change notification after the commit.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

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
    pub created_at: i64,
    /// A thread reply also sent to the room (`tshow`): a replay keeps it.
    pub shown: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadRow {
    pub id: String,
    pub rid: String,
    pub path: String,
    pub name: String,
    pub mime: String,
    pub caption: Option<String>,
    /// Set once the bytes are on the server, BEFORE the confirm: a confirm
    /// replayed on the same file posts a second message (see uploads.rs).
    pub file_id: Option<String>,
    /// `pending`, `sending` or `failed`.
    pub status: String,
    /// The file is our own copy (a reduced image, a pasted picture): deleted once settled.
    pub temporary: bool,
    /// The thread the file answers (`tmid` of the confirmation); `None` in the room.
    pub tmid: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
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
    /// The last message's system type (`uj`, `videoconf`…), None for a plain message.
    pub last_type: Option<String>,
    pub last_author: Option<String>,
    pub last_encrypted: Option<String>,
    /// A native voice channel: selecting it joins its voice session. False on Rocket.Chat.
    pub voice: bool,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub group_rank: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MessageRow {
    pub id: String,
    pub rid: String,
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
    pub encrypted_raw: Option<String>,
    pub urls: Option<String>,
    pub call_id: Option<String>,
    pub pinned: bool,
    /// The users who starred it, by id, comma-separated.
    pub starred: Option<String>,
    /// A thread root's last reply time (`tlm`).
    pub thread_last: Option<i64>,
    /// A thread root's followers, by id, comma-separated. Always None outside Rocket.Chat.
    pub thread_followers: Option<String>,
    /// Written by a bot account (RocketVibe, RFC 0003): a "BOT" badge beside
    /// the name. Always false on Rocket.Chat.
    pub author_bot: bool,
    /// A form a workflow asks (RocketVibe, RFC 0004), as JSON: read it with
    /// `native::workflows::row_form`. Always None on Rocket.Chat.
    pub form: Option<String>,
    /// A `discussion-created` message's discussion (`drid`), its message
    /// count (`dcount`) and last message time (`dlm`). Rocket.Chat only.
    pub discussion_id: Option<String>,
    pub discussion_count: i64,
    pub discussion_last: Option<i64>,
}

impl From<&Message> for MessageRow {
    fn from(m: &Message) -> Self {
        MessageRow {
            id: m.id.clone(),
            rid: m.rid.clone(),
            ts: m.ts,
            text: m.text.clone(),
            author: m.author_name.clone(),
            author_id: m.author_id.clone(),
            system_type: m.system_type.clone(),
            edited: m.edited_at.is_some(),
            attachments: m.attachments.clone(),
            thread_count: m.thread_count,
            outbox_status: None,
            md: m.md.clone(),
            reactions: m.reactions.clone(),
            thread_id: m.thread_id.clone(),
            encrypted_raw: m.encrypted_raw.clone(),
            urls: m.urls.clone(),
            call_id: m.call_id.clone(),
            pinned: m.pinned,
            starred: m.starred.clone(),
            thread_last: m.thread_last,
            thread_followers: m.thread_followers.clone(),
            author_bot: false,
            form: None,
            discussion_id: m.discussion_id.clone(),
            discussion_count: m.discussion_count,
            discussion_last: m.discussion_last,
        }
    }
}

impl MessageRow {
    pub fn starred_by(&self, uid: &str) -> bool {
        self.starred.as_deref().is_some_and(|ids| ids.split(',').any(|id| id == uid))
    }

    /// I follow this thread: its replies notify me.
    pub fn followed_by(&self, uid: &str) -> bool {
        self.thread_followers.as_deref().is_some_and(|ids| ids.split(',').any(|id| id == uid))
    }
}

/// A room's messages as its screen shows them: thread replies only when also sent to the room.
const ROOM_SHOWN: &str = "m.rid = ?1 AND (m.thread_id IS NULL OR m.thread_shown = 1)";

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
const MIGRATIONS: &[&str] = &[
    "ALTER TABLE messages ADD COLUMN md TEXT",
    "CREATE TABLE drafts (key TEXT PRIMARY KEY, text TEXT NOT NULL)",
    "ALTER TABLE messages ADD COLUMN urls TEXT; ALTER TABLE messages ADD COLUMN call_id TEXT",
    "ALTER TABLE rooms ADD COLUMN last_message_author TEXT",
    "CREATE TABLE uploads (id TEXT PRIMARY KEY, rid TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
       mime TEXT NOT NULL, caption TEXT, file_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
       temporary INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
    "ALTER TABLE subscriptions ADD COLUMN e2e_key TEXT; ALTER TABLE rooms ADD COLUMN last_encrypted TEXT",
    "ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0; ALTER TABLE messages ADD COLUMN starred TEXT",
    "ALTER TABLE subscriptions ADD COLUMN roles TEXT; DELETE FROM cursors WHERE stream = 'subscriptions'",
    "ALTER TABLE uploads ADD COLUMN tmid TEXT",
    "ALTER TABLE subscriptions ADD COLUMN group_id TEXT; ALTER TABLE subscriptions ADD COLUMN group_name TEXT;
     ALTER TABLE subscriptions ADD COLUMN group_rank INTEGER",
    "CREATE TABLE people (uid TEXT PRIMARY KEY, name TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
     CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "ALTER TABLE messages ADD COLUMN thread_followers TEXT",
    // Every subscription comes again, so the rooms already stored get theirs.
    "ALTER TABLE subscriptions ADD COLUMN notifications TEXT;
     ALTER TABLE subscriptions ADD COLUMN notifications_off INTEGER NOT NULL DEFAULT 0;
     DELETE FROM cursors WHERE stream = 'subscriptions'",
    "ALTER TABLE outbox ADD COLUMN shown INTEGER NOT NULL DEFAULT 0",
    // A discussion card's room; the stored `discussion-created` messages get
    // theirs from the next history page that carries them again.
    "ALTER TABLE messages ADD COLUMN discussion_id TEXT;
     ALTER TABLE messages ADD COLUMN discussion_count INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE messages ADD COLUMN discussion_last INTEGER",
];

/// How many messages a search across rooms answers at most.
pub const SEARCH_LIMIT: i64 = 60;

/// `term` as a `LIKE` pattern (`ESCAPE '\'`): `%`, `_` and the backslash
/// itself taken literally, anywhere in the text.
pub fn search_pattern(term: &str) -> String {
    let mut pattern = String::from("%");
    for c in term.trim().chars() {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

/// What a search across rooms reads: ordinary messages, and encrypted ones
/// whose words the store holds (a sealed one has none). `LIKE` ignores ASCII
/// case only.
const SEARCHED: &str = r"m.text LIKE ?1 ESCAPE '\' AND (m.system_type IS NULL OR m.system_type = 'e2e')";

/// A room's shown name (rooms aliased `r`): a two-person DM under its peer's
/// real name when the Rocket.Chat server shows real names
/// (`UI_Use_Real_Name`, kept as `server_settings.real_names`), else its own.
const ROOM_TITLE: &str = "COALESCE(CASE WHEN r.type = 'd'
      AND (SELECT value FROM server_settings WHERE key = 'real_names') = '1'
    THEN (SELECT name FROM people WHERE uid = r.dm_other_uid) END, r.display_name, r.name, r.rid)";

pub struct Store {
    conn: Mutex<Connection>,
    changes: broadcast::Sender<Change>,
}

/// The write side, only reachable inside `Store::write`.
pub struct Writer<'a> {
    conn: &'a Connection,
    change: Change,
    /// The first statement that failed: the whole write then rolls back.
    failed: Failure<'a>,
}

struct Failure<'a> {
    conn: &'a Connection,
    first: Option<(&'static str, rusqlite::Error)>,
}

/// A failed statement is noted on the writer instead of panicking: a full
/// disk or an I/O error rolls one write back, it no longer takes the app down
/// (a panic used to poison the connection's mutex, and every later read, the
/// GTK main thread's included, panicked in turn).
trait OrNote<T> {
    fn or_note(self, failed: &mut Failure, what: &'static str) -> T;
}

impl<T: Default> OrNote<T> for rusqlite::Result<T> {
    fn or_note(self, failed: &mut Failure, what: &'static str) -> T {
        self.unwrap_or_else(|e| {
            // SQLite rolls some errors' transaction back by itself (full disk,
            // I/O): reopen one, so the statements still to come in this write
            // cannot commit on their own, and are rolled back with it.
            if failed.conn.is_autocommit() {
                let _ = failed.conn.execute_batch("BEGIN");
            }
            failed.first.get_or_insert((what, e));
            T::default()
        })
    }
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        Self::from_connection(Connection::open(path)?)
    }

    pub fn in_memory() -> rusqlite::Result<Store> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> rusqlite::Result<Store> {
        // The GTK and SwiftUI apps may open the same database on macOS: wait
        // for the other's write rather than fail on SQLITE_BUSY.
        conn.busy_timeout(Duration::from_secs(5))?;
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

    /// The connection, even after a panic elsewhere left the mutex poisoned:
    /// an interrupted transaction is rolled back when it drops, so the
    /// connection itself is sound.
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Lets go of the database file now, whoever still holds this store: a
    /// catch-up or a send still running after `Session::shutdown` keeps an
    /// `Arc<Store>`, and Windows refuses to delete a file SQLite holds open, so
    /// a signed-out account's messages stayed on disk. Afterwards the store
    /// is an empty in-memory database: reads find nothing and writes roll back.
    pub fn close(&self) {
        let Ok(memory) = Connection::open_in_memory() else { return };
        let old = std::mem::replace(&mut *self.conn(), memory);
        if let Err((_, error)) = old.close() {
            eprintln!("rocket-vibe: closing the local database failed: {error}");
        }
    }

    /// Deletes a database and its WAL files, once `close`d; a failure other
    /// than "already gone" is reported, never silent.
    pub fn remove_files(path: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let mut file = path.as_os_str().to_owned();
            file.push(suffix);
            if let Err(error) = std::fs::remove_file(&file)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                eprintln!("rocket-vibe: could not delete {}: {error}", file.to_string_lossy());
            }
        }
    }

    /// One transaction. A statement that fails rolls the whole write back and
    /// broadcasts nothing; `f`'s result is still returned (its failed
    /// statements counted as no rows), as a read that fails returns nothing.
    pub fn write<R>(&self, f: impl FnOnce(&mut Writer) -> R) -> R {
        let mut conn = self.conn();
        // BEGIN (deferred) takes no lock: it cannot meet a busy database.
        let tx = conn.transaction().expect("begin");
        let (result, change, failed) = {
            let mut writer =
                Writer { conn: &tx, change: Change::default(), failed: Failure { conn: &tx, first: None } };
            let result = f(&mut writer);
            (result, writer.change, writer.failed.first)
        };
        let failed = match failed {
            Some(failed) => {
                drop(tx); // rolls back
                Some(failed)
            }
            None => tx.commit().err().map(|e| ("commit", e)),
        };
        drop(conn);
        if let Some((what, error)) = failed {
            eprintln!("rocket-vibe: local database write rolled back ({what}): {error}");
            return result;
        }
        if change.rooms || !change.rids.is_empty() {
            let _ = self.changes.send(change);
        }
        result
    }

    pub fn read<R>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> rusqlite::Result<R> {
        f(&self.conn())
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

    fn upload_rows(&self, filter: &str, key: &str) -> Vec<UploadRow> {
        let sql = format!(
            "SELECT id, rid, path, name, mime, caption, file_id, status, temporary, tmid FROM uploads
             WHERE {filter} ORDER BY created_at, id"
        );
        self.read(|c| {
            let mut q = c.prepare(&sql)?;
            q.query_map([key], |r| {
                Ok(UploadRow {
                    id: r.get(0)?,
                    rid: r.get(1)?,
                    path: r.get(2)?,
                    name: r.get(3)?,
                    mime: r.get(4)?,
                    caption: r.get(5)?,
                    file_id: r.get(6)?,
                    status: r.get(7)?,
                    temporary: r.get(8)?,
                    tmid: r.get(9)?,
                })
            })?
            .collect()
        })
        .unwrap_or_default()
    }

    /// Every upload of the room not settled yet, in order.
    pub fn uploads(&self, rid: &str) -> Vec<UploadRow> {
        self.upload_rows("rid = ?1", rid)
    }

    pub fn pending_uploads(&self) -> Vec<UploadRow> {
        self.upload_rows("status = ?1", "pending")
    }

    pub fn upload(&self, id: &str) -> Option<UploadRow> {
        self.upload_rows("id = ?1", id).into_iter().next()
    }

    /// Whether a message of the room already carries this uploaded file.
    pub fn file_posted(&self, rid: &str, file_id: &str) -> bool {
        let pattern = format!("%/file-upload/{file_id}/%");
        let mattermost = format!("%/api/v4/files/{file_id}\"%");
        self.read(|c| {
            c.query_row(
                "SELECT 1 FROM messages WHERE rid = ?1 AND (attachments LIKE ?2 OR attachments LIKE ?3) LIMIT 1",
                params![rid, pattern, mattermost],
                |_| Ok(()),
            )
            .optional()
        })
        .ok()
        .flatten()
        .is_some()
    }

    pub fn room_kind(&self, rid: &str) -> Option<String> {
        self.read(|c| c.query_row("SELECT type FROM rooms WHERE rid = ?1", [rid], |r| r.get(0)).optional())
            .ok()
            .flatten()
    }

    pub fn has_message(&self, id: &str) -> bool {
        self.read(|c| c.query_row("SELECT 1 FROM messages WHERE id = ?1", [id], |_| Ok(())).optional())
            .ok()
            .flatten()
            .is_some()
    }

    /// Whether the Rocket.Chat server shows people by their real name
    /// (`UI_Use_Real_Name`), as last read; false until then and elsewhere.
    pub fn real_names(&self) -> bool {
        self.read(|c| {
            c.query_row("SELECT value FROM server_settings WHERE key = 'real_names'", [], |r| r.get::<_, String>(0))
                .optional()
        })
        .ok()
        .flatten()
        .as_deref()
            == Some("1")
    }

    /// A person's real name as messages, DM subscriptions or a profile gave it.
    pub fn person_name(&self, uid: &str) -> Option<String> {
        self.read(|c| c.query_row("SELECT name FROM people WHERE uid = ?1", [uid], |r| r.get(0)).optional())
            .ok()
            .flatten()
    }

    /// The room's display name and type.
    pub fn room_name(&self, rid: &str) -> Option<(String, String)> {
        self.read(|c| {
            c.query_row(&format!("SELECT {ROOM_TITLE}, r.type FROM rooms r WHERE r.rid = ?1"), [rid], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
        })
        .ok()
        .flatten()
    }

    /// My wrapped copy of the room's key, in an encrypted room.
    /// My roles in the room.
    pub fn room_roles(&self, rid: &str) -> Vec<String> {
        let roles: Option<String> = self
            .read(|c| c.query_row("SELECT roles FROM subscriptions WHERE rid = ?1", [rid], |r| r.get(0)).optional())
            .ok()
            .flatten()
            .flatten();
        roles.map(|r| r.split(',').map(str::to_owned).collect()).unwrap_or_default()
    }

    pub fn room_encrypted(&self, rid: &str) -> bool {
        self.read(|c| c.query_row("SELECT encrypted FROM rooms WHERE rid = ?1", [rid], |r| r.get(0)).optional())
            .ok()
            .flatten()
            .unwrap_or(false)
    }

    /// A message's `t`, when it is a system or encrypted one.
    pub fn message_type(&self, id: &str) -> Option<String> {
        self.read(|c| c.query_row("SELECT system_type FROM messages WHERE id = ?1", [id], |r| r.get(0)).optional())
            .ok()
            .flatten()
            .flatten()
    }

    pub fn e2e_key(&self, rid: &str) -> Option<String> {
        self.read(|c| c.query_row("SELECT e2e_key FROM subscriptions WHERE rid = ?1", [rid], |r| r.get(0)).optional())
            .ok()
            .flatten()
            .flatten()
    }

    /// The room's own desktop notification choice (`None`: the account's) and
    /// whether another client silenced it (`disableNotifications`).
    pub fn room_notifications(&self, rid: &str) -> (Option<String>, bool) {
        self.read(|c| {
            c.query_row("SELECT notifications, notifications_off FROM subscriptions WHERE rid = ?1", [rid], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
        })
        .ok()
        .flatten()
        .unwrap_or((None, false))
    }

    /// When I last read the room (`ls`), as the server last told us.
    pub fn last_seen(&self, rid: &str) -> Option<i64> {
        self.read(|c| c.query_row("SELECT last_seen FROM subscriptions WHERE rid = ?1", [rid], |r| r.get(0)).optional())
            .ok()
            .flatten()
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
                "SELECT id, rid, text, thread_id, CAST(created_at AS INTEGER), shown FROM outbox WHERE status = 'pending' ORDER BY created_at, id",
            )?;
            q.query_map([], |r| {
                Ok(OutboxEntry {
                    id: r.get(0)?,
                    rid: r.get(1)?,
                    text: r.get(2)?,
                    thread_id: r.get(3)?,
                    created_at: r.get(4)?,
                    shown: r.get(5)?,
                })
            })?
            .collect()
        })
        .unwrap_or_default()
    }

    pub fn rooms(&self) -> Vec<RoomRow> {
        self.read(|c| {
            let mut q = c.prepare(&format!(
                "SELECT r.rid, r.type, {ROOM_TITLE}, r.last_message,
                        COALESCE(r.last_message_ts, 0), s.unread, s.mentions + s.group_mentions, s.alert,
                        s.favorite, r.encrypted, r.read_only, r.dm_other_uid, r.avatar_etag, r.name,
                        r.last_message_type, r.last_message_author, r.last_encrypted,
                        s.group_id, s.group_name, s.group_rank
                 FROM rooms r JOIN subscriptions s ON s.rid = r.rid
                 WHERE s.open = 1
                 ORDER BY COALESCE(r.last_message_ts, 0) DESC",
            ))?;
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
                    last_type: r.get(14)?,
                    last_author: r.get(15)?,
                    last_encrypted: r.get(16)?,
                    voice: false,
                    group_id: r.get(17)?,
                    group_name: r.get(18)?,
                    group_rank: r.get(19)?,
                })
            })?
            .collect()
        })
        .unwrap_or_default()
    }

    /// The newest `limit` messages of a room, oldest first. Thread replies
    /// stay in their thread unless also shown in the room (`tshow`).
    pub fn messages(&self, rid: &str, limit: i64) -> Vec<MessageRow> {
        self.message_rows(ROOM_SHOWN, rid, limit)
    }

    /// How many of the room's messages `messages` would show from `ts` on.
    pub fn count_since(&self, rid: &str, ts: i64) -> i64 {
        self.read(|c| {
            c.query_row(
                &format!("SELECT COUNT(*) FROM messages m WHERE {ROOM_SHOWN} AND m.ts >= ?2"),
                params![rid, ts],
                |r| r.get(0),
            )
        })
        .unwrap_or(0)
    }

    /// These messages, in this order; the ones not stored are left out.
    pub fn messages_by_id(&self, ids: &[String]) -> Vec<MessageRow> {
        ids.iter().filter_map(|id| self.message_rows("m.id = ?1", id, 1).pop()).collect()
    }

    /// A thread: its root, then every reply, oldest first.
    pub fn thread_messages(&self, root_id: &str) -> Vec<MessageRow> {
        self.message_rows("(m.id = ?1 OR m.thread_id = ?1)", root_id, i64::MAX)
    }

    /// The stored messages of every room whose words contain `term`, newest
    /// first, `limit` at most: ordinary ones and encrypted ones whose words
    /// the store holds (mine still in the outbox). Those it holds sealed are
    /// [`Store::sealed_messages`], which only the session can open.
    pub fn search_messages(&self, term: &str, limit: i64) -> Vec<MessageRow> {
        if term.trim().is_empty() {
            return Vec::new();
        }
        let mut rows = self.message_rows(SEARCHED, &search_pattern(term), limit);
        rows.reverse();
        rows
    }

    /// Every encrypted message stored without its words, oldest first.
    pub fn sealed_messages(&self) -> Vec<MessageRow> {
        self.message_rows("m.system_type = ?1 AND m.text IS NULL AND m.encrypted_raw IS NOT NULL", "e2e", i64::MAX)
    }

    /// Whether the room is in my list (an open subscription).
    pub fn listed(&self, rid: &str) -> bool {
        self.read(|c| {
            c.query_row("SELECT 1 FROM subscriptions WHERE rid = ?1 AND open = 1", [rid], |_| Ok(())).optional()
        })
        .ok()
        .flatten()
        .is_some()
    }

    fn message_rows(&self, filter: &str, key: &str, limit: i64) -> Vec<MessageRow> {
        let sql = format!(
            "SELECT m.id, m.ts, m.text, m.author_name, m.author_id, m.system_type, m.edited_at IS NOT NULL,
                    m.attachments, m.thread_count, o.status, m.md, m.reactions, m.thread_id, m.urls, m.call_id, m.encrypted_raw, m.rid,
                    m.pinned, m.starred, m.thread_last, m.thread_followers,
                    m.discussion_id, m.discussion_count, m.discussion_last
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
                        urls: r.get(13)?,
                        call_id: r.get(14)?,
                        encrypted_raw: r.get(15)?,
                        rid: r.get(16)?,
                        pinned: r.get(17)?,
                        starred: r.get(18)?,
                        thread_last: r.get(19)?,
                        thread_followers: r.get(20)?,
                        author_bot: false,
                        form: None,
                        discussion_id: r.get(21)?,
                        discussion_count: r.get(22)?,
                        discussion_last: r.get(23)?,
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

    /// The server's `UI_Use_Real_Name`; the list redraws when it changes.
    pub fn set_real_names(&mut self, on: bool) {
        let changed = self
            .conn
            .execute(
                "INSERT INTO server_settings (key, value) VALUES ('real_names', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value",
                [if on { "1" } else { "0" }],
            )
            .or_note(&mut self.failed, "real names setting");
        if changed > 0 {
            self.touch_rooms();
        }
    }

    /// A person's real name as of `seen` (a message's `_updatedAt`, or now
    /// for `me` and a DM's subscription): an older one never replaces a newer
    /// one (a history page of old messages after a rename), an absent or
    /// empty one never erases one. A change redraws the list, whose DMs may
    /// show it.
    pub fn note_person(&mut self, uid: &str, name: Option<&str>, seen: i64) {
        let Some(name) = name.filter(|n| !n.is_empty()) else { return };
        let changed = self
            .conn
            .execute(
                "INSERT INTO people (uid, name, seen) VALUES (?1, ?2, ?3)
                 ON CONFLICT(uid) DO UPDATE SET name = excluded.name, seen = excluded.seen
                 WHERE excluded.seen >= people.seen AND people.name IS NOT excluded.name",
                params![uid, name, seen],
            )
            .or_note(&mut self.failed, "note person");
        if changed > 0 {
            self.touch_rooms();
        }
    }

    /// A message's author's real name, from the raw document.
    pub fn note_author(&mut self, raw: &serde_json::Value) {
        if let Some(uid) = raw.pointer("/u/_id").and_then(serde_json::Value::as_str) {
            let seen = raw.get("_updatedAt").and_then(crate::normalize::to_epoch).unwrap_or(0);
            self.note_person(uid, raw.pointer("/u/name").and_then(serde_json::Value::as_str), seen);
        }
    }

    /// A two-person DM's subscription: `fname` is the other person's real
    /// name, written on the room's other party once the room is known.
    pub fn note_dm_name(&mut self, raw: &serde_json::Value) {
        if raw.get("t").and_then(serde_json::Value::as_str) != Some("d") {
            return;
        }
        let (Some(rid), Some(name)) = (
            raw.get("rid").and_then(serde_json::Value::as_str),
            raw.get("fname").and_then(serde_json::Value::as_str).filter(|n| !n.is_empty()),
        ) else {
            return;
        };
        let peer: Option<String> = self
            .conn
            .query_row("SELECT dm_other_uid FROM rooms WHERE rid = ?1", [rid], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        if let Some(peer) = peer {
            self.note_person(&peer, Some(name), chrono::Utc::now().timestamp_millis());
        }
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
                   thread_count, thread_last, thread_shown, edited_at, attachments, reactions, encrypted_raw, updated_at, md, urls, call_id,
                   pinned, starred, thread_followers, discussion_id, discussion_count, discussion_last)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
                   ?23, ?24, ?25)
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
                   md = excluded.md,
                   urls = excluded.urls,
                   call_id = excluded.call_id,
                   pinned = excluded.pinned,
                   starred = excluded.starred,
                   thread_followers = excluded.thread_followers,
                   discussion_id = excluded.discussion_id,
                   discussion_count = excluded.discussion_count,
                   discussion_last = excluded.discussion_last
                 WHERE excluded.updated_at >= messages.updated_at",
                params![
                    m.id, m.rid, m.text, m.ts, m.author_id, m.author_name, m.system_type, m.thread_id,
                    m.thread_count, m.thread_last, m.thread_shown, m.edited_at, m.attachments, m.reactions,
                    m.encrypted_raw, m.updated_at, m.md, m.urls, m.call_id, m.pinned, m.starred,
                    m.thread_followers, m.discussion_id, m.discussion_count, m.discussion_last
                ],
            )
            .or_note(&mut self.failed, "upsert message");
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
                   last_message, last_message_type, last_message_ts, avatar_etag, updated_at, last_message_author, last_encrypted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(rid) DO UPDATE SET
                   type = excluded.type,
                   name = COALESCE(excluded.name, rooms.name),
                   display_name = COALESCE(excluded.display_name, rooms.display_name),
                   encrypted = excluded.encrypted,
                   read_only = excluded.read_only,
                   dm_other_uid = COALESCE(excluded.dm_other_uid, rooms.dm_other_uid),
                   last_message = CASE WHEN excluded.encrypted = 1 OR ?15 THEN rooms.last_message ELSE excluded.last_message END,
                   last_message_type = CASE WHEN excluded.encrypted = 1 OR ?15 THEN rooms.last_message_type ELSE excluded.last_message_type END,
                   last_message_author = CASE WHEN ?15 THEN rooms.last_message_author ELSE COALESCE(excluded.last_message_author, rooms.last_message_author) END,
                   last_message_ts = COALESCE(excluded.last_message_ts, rooms.last_message_ts),
                   avatar_etag = COALESCE(excluded.avatar_etag, rooms.avatar_etag),
                   updated_at = excluded.updated_at,
                   last_encrypted = CASE WHEN excluded.encrypted = 1 THEN COALESCE(excluded.last_encrypted, rooms.last_encrypted) ELSE NULL END
                 WHERE excluded.updated_at >= rooms.updated_at",
                params![
                    r.rid, r.kind, r.name, r.display_name, r.encrypted, r.read_only, r.dm_other_uid,
                    r.last_message, r.last_message_type, r.last_message_ts, r.avatar_etag, r.updated_at,
                    r.last_message_author, r.last_encrypted, r.keep_preview
                ],
            )
            .or_note(&mut self.failed, "upsert room");
        self.touch_rooms();
    }

    pub fn upsert_subscription(&mut self, s: &Subscription) {
        self.conn
            .execute(
                "INSERT INTO subscriptions (rid, sub_id, unread, mentions, group_mentions, alert, open, favorite, last_seen, updated_at, e2e_key, roles,
                                            group_id, group_name, group_rank, notifications, notifications_off)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                 ON CONFLICT(rid) DO UPDATE SET
                   sub_id = COALESCE(excluded.sub_id, subscriptions.sub_id),
                   unread = excluded.unread,
                   mentions = excluded.mentions,
                   group_mentions = excluded.group_mentions,
                   alert = excluded.alert,
                   open = excluded.open,
                   favorite = excluded.favorite,
                   last_seen = excluded.last_seen,
                   updated_at = excluded.updated_at,
                   e2e_key = COALESCE(excluded.e2e_key, subscriptions.e2e_key),
                   roles = excluded.roles,
                   group_id = excluded.group_id,
                   group_name = excluded.group_name,
                   group_rank = excluded.group_rank,
                   notifications = excluded.notifications,
                   notifications_off = excluded.notifications_off
                 WHERE excluded.updated_at >= subscriptions.updated_at",
                params![
                    s.rid, s.sub_id, s.unread, s.mentions, s.group_mentions, s.alert, s.open, s.favorite,
                    s.last_seen, s.updated_at, s.e2e_key, s.roles, s.group_id, s.group_name, s.group_rank,
                    s.notifications, s.notifications_off
                ],
            )
            .or_note(&mut self.failed, "upsert subscription");
        self.touch_rooms();
    }

    pub fn delete_message(&mut self, id: &str) {
        let Some(rid) = self.rid_of("SELECT rid FROM messages WHERE id = ?1", id) else { return };
        self.conn.execute("DELETE FROM messages WHERE id = ?1", [id]).or_note(&mut self.failed, "delete message");
        self.touch_messages(&rid);
    }

    /// Every room whose rid is not in `live`, with all it holds.
    pub fn purge_rooms_except(&mut self, live: &[String]) {
        let known: Vec<String> = self
            .conn
            .prepare("SELECT rid FROM rooms UNION SELECT rid FROM subscriptions")
            .and_then(|mut q| q.query_map([], |r| r.get(0)).map(|rows| rows.filter_map(Result::ok).collect()))
            .or_note(&mut self.failed, "rooms");
        for rid in known.iter().filter(|rid| !live.contains(rid)) {
            self.delete_room(rid);
        }
    }

    pub fn delete_room(&mut self, rid: &str) {
        for table in ["messages", "subscriptions", "rooms", "outbox", "uploads"] {
            self.conn
                .execute(&format!("DELETE FROM {table} WHERE rid = ?1"), [rid])
                .or_note(&mut self.failed, "delete room");
        }
        self.conn.execute("DELETE FROM cursors WHERE scope = ?1", [rid]).or_note(&mut self.failed, "delete cursors");
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
            .or_note(&mut self.failed, "write cursor");
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

    pub fn insert_upload(&mut self, u: &UploadRow, now: i64) {
        self.conn
            .execute(
                "INSERT INTO uploads (id, rid, path, name, mime, caption, file_id, status, temporary, created_at, tmid)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![u.id, u.rid, u.path, u.name, u.mime, u.caption, u.file_id, u.status, u.temporary, now, u.tmid],
            )
            .or_note(&mut self.failed, "insert upload");
        self.touch_messages(&u.rid);
    }

    fn touch_upload(&mut self, id: &str) {
        if let Some(rid) = self.rid_of("SELECT rid FROM uploads WHERE id = ?1", id) {
            self.touch_messages(&rid);
        }
    }

    /// Takes a pending upload for sending; false if someone else already did.
    pub fn claim_upload(&mut self, id: &str) -> bool {
        let n = self
            .conn
            .execute("UPDATE uploads SET status = 'sending' WHERE id = ?1 AND status = 'pending'", [id])
            .or_note(&mut self.failed, "claim upload");
        self.touch_upload(id);
        n == 1
    }

    pub fn set_upload_status(&mut self, id: &str, status: &str) {
        self.conn
            .execute("UPDATE uploads SET status = ?2 WHERE id = ?1", [id, status])
            .or_note(&mut self.failed, "upload status");
        self.touch_upload(id);
    }

    /// Uploads a previous run left half-sent go back in the queue.
    pub fn rearm_sending_uploads(&mut self) {
        self.conn
            .execute("UPDATE uploads SET status = 'pending' WHERE status = 'sending'", [])
            .or_note(&mut self.failed, "rearm");
    }

    /// I follow a thread (`on`) or stop: its root's followers gain or lose
    /// me until the server's copy of the root arrives. Its `updated_at` stays,
    /// so that copy, newer, always replaces this guess.
    pub fn set_thread_follower(&mut self, root: &str, uid: &str, on: bool) {
        let Some(rid) = self.rid_of("SELECT rid FROM messages WHERE id = ?1", root) else { return };
        let current: Option<String> = self
            .conn
            .query_row("SELECT thread_followers FROM messages WHERE id = ?1", [root], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
            .flatten();
        let mut ids: Vec<&str> =
            current.as_deref().unwrap_or_default().split(',').filter(|id| !id.is_empty()).collect();
        let present = ids.contains(&uid);
        if present == on {
            return;
        }
        if on {
            ids.push(uid);
        } else {
            ids.retain(|id| *id != uid);
        }
        let joined = (!ids.is_empty()).then(|| ids.join(","));
        self.conn
            .execute("UPDATE messages SET thread_followers = ?2 WHERE id = ?1", params![root, joined])
            .or_note(&mut self.failed, "thread follower");
        self.touch_messages(&rid);
    }

    pub fn set_favorite(&mut self, rid: &str, on: bool) {
        self.conn
            .execute("UPDATE subscriptions SET favorite = ?2 WHERE rid = ?1", params![rid, on])
            .or_note(&mut self.failed, "favorite");
        self.touch_rooms();
    }

    /// The room list's "mark as unread" (`unread`) or "mark as read", shown at
    /// once: the subscription the server then broadcasts, newer, replaces it.
    pub fn set_unread_mark(&mut self, rid: &str, unread: bool) {
        let sql = if unread {
            "UPDATE subscriptions SET unread = MAX(unread, 1), alert = 1 WHERE rid = ?1"
        } else {
            "UPDATE subscriptions SET unread = 0, mentions = 0, group_mentions = 0, alert = 0 WHERE rid = ?1"
        };
        self.conn.execute(sql, [rid]).or_note(&mut self.failed, "unread mark");
        self.touch_rooms();
    }

    /// The room's own notification choice, saved on the server: shown at once,
    /// the subscription the server then broadcasts confirming it. Any choice
    /// lifts another client's `disableNotifications`, which the save cleared too.
    pub fn set_room_notifications(&mut self, rid: &str, level: Option<&str>) {
        self.conn
            .execute(
                "UPDATE subscriptions SET notifications = ?2, notifications_off = 0 WHERE rid = ?1",
                params![rid, level],
            )
            .or_note(&mut self.failed, "room notifications");
        self.touch_rooms();
    }

    /// A room's photo changed (or went: `NO_PHOTO`).
    pub fn set_room_avatar(&mut self, rid: &str, etag: &str) {
        self.conn
            .execute("UPDATE rooms SET avatar_etag = ?2 WHERE rid = ?1", [rid, etag])
            .or_note(&mut self.failed, "room avatar");
        self.touch_rooms();
    }

    pub fn set_upload_file_id(&mut self, id: &str, file_id: &str) {
        self.conn
            .execute("UPDATE uploads SET file_id = ?2 WHERE id = ?1", [id, file_id])
            .or_note(&mut self.failed, "upload file id");
    }

    pub fn delete_upload(&mut self, id: &str) {
        self.touch_upload(id);
        self.conn.execute("DELETE FROM uploads WHERE id = ?1", [id]).or_note(&mut self.failed, "delete upload");
    }

    /// An empty draft is deleted rather than stored.
    pub fn set_draft(&mut self, key: &str, text: &str) {
        if text.trim().is_empty() {
            self.conn.execute("DELETE FROM drafts WHERE key = ?1", [key]).or_note(&mut self.failed, "delete draft");
        } else {
            self.conn
                .execute(
                    "INSERT INTO drafts (key, text) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET text = excluded.text",
                    params![key, text],
                )
                .or_note(&mut self.failed, "set draft");
        }
    }

    pub fn insert_outbox(&mut self, id: &str, rid: &str, text: &str, thread_id: Option<&str>) {
        self.insert_reply(id, rid, text, thread_id, false);
    }

    /// `insert_outbox`, with `shown` for a thread reply also sent to the room (`tshow`).
    pub fn insert_reply(&mut self, id: &str, rid: &str, text: &str, thread_id: Option<&str>, shown: bool) {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO outbox (id, rid, text, thread_id, shown) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, rid, text, thread_id, shown && thread_id.is_some()],
            )
            .or_note(&mut self.failed, "insert outbox");
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
    fn thread_followers_round_trip_and_follow_locally() {
        let store = Store::in_memory().unwrap();
        let root = Message {
            thread_count: 2,
            thread_last: Some(50),
            thread_followers: Some("a,b".into()),
            ..message("root", Some("x"), 10, "r")
        };
        store.write(|w| w.upsert_message(&root));
        let row = store.messages_by_id(&["root".into()]).pop().unwrap();
        assert_eq!((row.thread_last, row.thread_followers.as_deref()), (Some(50), Some("a,b")));
        assert!(row.followed_by("b") && !row.followed_by("me"));

        let mut changes = store.changes();
        store.write(|w| w.set_thread_follower("root", "me", true));
        assert!(changes.try_recv().unwrap().rids.contains("r"));
        store.write(|w| w.set_thread_follower("root", "me", true));
        assert_eq!(store.messages_by_id(&["root".into()])[0].thread_followers.as_deref(), Some("a,b,me"));
        store.write(|w| {
            w.set_thread_follower("root", "a", false);
            w.set_thread_follower("root", "b", false);
            w.set_thread_follower("root", "me", false);
        });
        assert_eq!(store.messages_by_id(&["root".into()])[0].thread_followers, None);
        // The server's copy, newer than the guess, replaces it.
        store.write(|w| w.upsert_message(&Message { thread_followers: Some("a".into()), ..root.clone() }));
        assert_eq!(store.messages_by_id(&["root".into()])[0].thread_followers.as_deref(), Some("a"));
        store.write(|w| w.set_thread_follower("unknown", "me", true));
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
    fn a_dm_shows_its_peer_by_real_name_only_when_the_server_does() {
        let store = Store::in_memory().unwrap();
        let dm = Room {
            rid: "d".into(),
            kind: "d".into(),
            display_name: Some("bob".into()),
            dm_other_uid: Some("u2".into()),
            updated_at: 1,
            ..Room::default()
        };
        store.write(|w| {
            w.upsert_room(&dm);
            w.upsert_subscription(&Subscription {
                rid: "d".into(),
                open: true,
                updated_at: 1,
                ..Subscription::default()
            });
            w.note_dm_name(&serde_json::json!({"rid": "d", "t": "d", "name": "bob", "fname": "Bob Durand"}));
            w.note_author(&serde_json::json!({"u": {"_id": "u3", "username": "carol", "name": "Carol"}}));
            w.note_author(&serde_json::json!({"u": {"_id": "u3", "username": "carol"}}));
        });
        assert_eq!(store.person_name("u2").as_deref(), Some("Bob Durand"));
        assert_eq!(store.person_name("u3").as_deref(), Some("Carol"), "an absent name erases nothing");
        assert!(!store.real_names());
        assert_eq!(store.room_name("d").map(|(name, _)| name).as_deref(), Some("bob"));
        store.write(|w| w.set_real_names(true));
        assert!(store.real_names());
        assert_eq!(store.room_name("d").map(|(name, _)| name).as_deref(), Some("Bob Durand"));
        assert_eq!(store.rooms()[0].name, "Bob Durand");
        store.write(|w| w.set_real_names(false));
        assert_eq!(store.rooms()[0].name, "bob", "off again: the username");
    }

    #[test]
    fn an_unread_mark_shows_until_the_server_says_otherwise() {
        let store = Store::in_memory().unwrap();
        let room = Room {
            rid: "r".into(),
            kind: "c".into(),
            display_name: Some("r".into()),
            updated_at: 1,
            ..Room::default()
        };
        let sub = |unread: i64, alert: bool, updated_at: i64| Subscription {
            rid: "r".into(),
            open: true,
            unread,
            alert,
            mentions: 2,
            updated_at,
            ..Subscription::default()
        };
        store.write(|w| {
            w.upsert_room(&room);
            w.upsert_subscription(&sub(0, false, 10));
            w.set_unread_mark("r", true);
        });
        let r = &store.rooms()[0];
        assert_eq!((r.unread, r.alert), (1, true));
        store.write(|w| w.upsert_subscription(&sub(3, true, 20)));
        assert_eq!(store.rooms()[0].unread, 3, "the server's newer copy wins");
        store.write(|w| w.set_unread_mark("r", false));
        let r = &store.rooms()[0];
        assert_eq!((r.unread, r.mentions, r.alert), (0, 0, false));
    }

    #[test]
    fn a_rooms_own_notifications_round_trip() {
        let store = Store::in_memory().unwrap();
        let sub = |notifications: Option<&str>, off: bool, updated_at: i64| Subscription {
            rid: "r".into(),
            open: true,
            notifications: notifications.map(str::to_owned),
            notifications_off: off,
            updated_at,
            ..Subscription::default()
        };
        assert_eq!(store.room_notifications("r"), (None, false), "an unknown room: the account's");
        store.write(|w| w.upsert_subscription(&sub(Some("nothing"), true, 10)));
        assert_eq!(store.room_notifications("r"), (Some("nothing".into()), true));
        store.write(|w| w.set_room_notifications("r", Some("all")));
        assert_eq!(store.room_notifications("r"), (Some("all".into()), false));
        store.write(|w| w.upsert_subscription(&sub(None, false, 20)));
        assert_eq!(store.room_notifications("r"), (None, false), "absence is the default, not a gap");
    }

    #[test]
    fn an_older_message_never_renames_a_person_back() {
        let store = Store::in_memory().unwrap();
        let said =
            |name: &str, at: i64| serde_json::json!({"u": {"_id": "u1", "name": name}, "_updatedAt": {"$date": at}});
        store.write(|w| w.note_author(&said("Alice Martin", 200)));
        store.write(|w| w.note_author(&said("Alice Old", 100)));
        assert_eq!(store.person_name("u1").as_deref(), Some("Alice Martin"));
        store.write(|w| w.note_author(&said("Alice Durand", 300)));
        assert_eq!(store.person_name("u1").as_deref(), Some("Alice Durand"));
        // A DM's subscription names the person as of now.
        let dm = Room {
            rid: "d".into(),
            kind: "d".into(),
            dm_other_uid: Some("u1".into()),
            updated_at: 1,
            ..Room::default()
        };
        store.write(|w| {
            w.upsert_room(&dm);
            w.note_dm_name(&serde_json::json!({"rid": "d", "t": "d", "fname": "Alice D."}));
            w.note_author(&said("Alice Durand", 400));
        });
        assert_eq!(store.person_name("u1").as_deref(), Some("Alice D."), "a message older than now is older");
    }

    #[test]
    fn count_since_counts_what_the_room_shows() {
        let store = Store::in_memory().unwrap();
        store.write(|w| {
            for (id, ts) in [("old", 10), ("a", 100), ("b", 200)] {
                w.upsert_message(&Message { ts, ..message(id, Some("x"), 1, "r") });
            }
            w.upsert_message(&Message { ts: 150, thread_id: Some("a".into()), ..message("reply", Some("x"), 1, "r") });
            w.upsert_message(&Message { ts: 300, ..message("elsewhere", Some("x"), 1, "s") });
        });
        assert_eq!(store.count_since("r", 100), 2);
        assert_eq!(store.count_since("r", 0), 3);
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
    fn a_reply_also_sent_to_the_room_keeps_it_in_the_outbox() {
        let store = Store::in_memory().unwrap();
        store.write(|w| {
            w.insert_reply("a", "r", "shown", Some("root"), true);
            w.insert_reply("b", "r", "hidden", Some("root"), false);
            w.insert_reply("c", "r", "no thread", None, true);
        });
        let shown: Vec<(String, bool)> = store.pending_outbox().into_iter().map(|e| (e.id, e.shown)).collect();
        assert_eq!(shown, [("a".into(), true), ("b".into(), false), ("c".into(), false)]);
    }

    #[test]
    fn search_across_rooms_reads_words_newest_first() {
        let store = Store::in_memory().unwrap();
        store.write(|w| {
            let at = |id: &str, text: Option<&str>, ts: i64, rid: &str| Message { ts, ..message(id, text, 1, rid) };
            w.upsert_message(&at("old", Some("Hello world"), 10, "r"));
            w.upsert_message(&at("new", Some("hello again"), 30, "s"));
            w.upsert_message(&at("reply", Some("a HELLO in a thread"), 20, "r"));
            w.upsert_message(&at("other", Some("goodbye"), 40, "r"));
            w.upsert_message(&Message { system_type: Some("uj".into()), ..at("joined", Some("hello"), 50, "r") });
            // Sealed: its words are not stored. Mine still in the outbox: they are.
            w.upsert_message(&Message {
                system_type: Some("e2e".into()),
                encrypted_raw: Some("{}".into()),
                ..at("sealed", None, 60, "p")
            });
            w.upsert_message(&Message { system_type: Some("e2e".into()), ..at("mine", Some("hello secret"), 70, "p") });
            w.upsert_message(&at("percent", Some("100% sure_thing \\o/"), 80, "r"));
            w.upsert_message(&at("decoy", Some("1000 sureXthing \\xo/"), 90, "r"));
        });
        let ids =
            |term: &str, limit: i64| store.search_messages(term, limit).into_iter().map(|m| m.id).collect::<Vec<_>>();
        assert_eq!(ids("hello", 60), ["mine", "new", "reply", "old"], "ASCII case ignored, system lines left out");
        assert_eq!(ids("hello", 2), ["mine", "new"]);
        assert_eq!(ids("0%", 60), ["percent"], "% is literal");
        assert_eq!(ids("e_t", 60), ["percent"], "_ is literal");
        assert_eq!(ids("\\o", 60), ["percent"], "the backslash is literal");
        assert!(ids("  ", 60).is_empty());
        assert_eq!(store.sealed_messages().into_iter().map(|m| m.id).collect::<Vec<_>>(), ["sealed"]);
        assert_eq!(search_pattern(" a%b_c\\ "), "%a\\%b\\_c\\\\%");
    }

    #[test]
    fn a_discussion_card_keeps_its_room() {
        let store = Store::in_memory().unwrap();
        let created = Message {
            system_type: Some("discussion-created".into()),
            discussion_id: Some("d1".into()),
            discussion_count: 3,
            discussion_last: Some(99),
            ..message("m", Some("Plans"), 1, "r")
        };
        store.write(|w| w.upsert_message(&created));
        let row = store.messages("r", 10).pop().unwrap();
        assert_eq!(
            (row.discussion_id.as_deref(), row.discussion_count, row.discussion_last),
            (Some("d1"), 3, Some(99))
        );
        store.write(|w| w.upsert_message(&Message { discussion_count: 4, updated_at: 2, ..created.clone() }));
        assert_eq!(store.messages("r", 10)[0].discussion_count, 4);
        assert!(!store.listed("d1"));
        store.write(|w| {
            w.upsert_subscription(&Subscription { rid: "d1".into(), open: true, updated_at: 1, ..Default::default() })
        });
        assert!(store.listed("d1"));
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

    #[test]
    fn a_failed_statement_rolls_the_write_back_without_panicking() {
        let store = Store::in_memory().unwrap();
        let mut changes = store.changes();
        let upload = UploadRow {
            id: "up".into(),
            rid: "r".into(),
            path: "/tmp/a".into(),
            name: "a".into(),
            mime: "text/plain".into(),
            caption: None,
            file_id: None,
            status: "pending".into(),
            temporary: false,
            tmid: None,
        };
        // The second insert breaks the primary key: the outbox row written
        // before it goes too, and nothing is broadcast.
        store.write(|w| {
            w.insert_outbox("o1", "r", "hi", None);
            w.insert_upload(&upload, 0);
            w.insert_upload(&upload, 0);
        });
        assert_eq!(count(&store, "outbox"), 0);
        assert_eq!(count(&store, "uploads"), 0);
        assert!(changes.try_recv().is_err());
        // The store is still usable, reads and writes alike.
        store.write(|w| w.insert_outbox("o2", "r", "again", None));
        assert_eq!(count(&store, "outbox"), 1);
    }

    #[test]
    fn statements_after_an_automatic_rollback_do_not_commit_alone() {
        let store = Store::in_memory().unwrap();
        store.write(|w| {
            // What SQLite does by itself on a full disk: the transaction is gone.
            w.conn.execute_batch("ROLLBACK").unwrap();
            let failed: rusqlite::Result<usize> = w.conn.execute("INSERT INTO missing_table VALUES (1)", []);
            failed.or_note(&mut w.failed, "simulated");
            w.insert_outbox("o1", "r", "hi", None);
        });
        assert_eq!(count(&store, "outbox"), 0);
        store.write(|w| w.insert_outbox("o2", "r", "again", None));
        assert_eq!(count(&store, "outbox"), 1);
    }

    #[test]
    fn close_releases_the_file_while_the_store_is_still_shared() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("account.sqlite");
        let store = std::sync::Arc::new(Store::open(&path).unwrap());
        let straggler = store.clone(); // a catch-up still running after shutdown
        store.write(|w| w.insert_outbox("o1", "r", "hi", None));
        store.close();
        for suffix in ["", "-wal", "-shm"] {
            let mut file = path.clone().into_os_string();
            file.push(suffix);
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => panic!("{suffix}: {e}"),
            }
        }
        assert!(!path.exists());
        // The late task neither panics nor recreates the file.
        straggler.write(|w| w.insert_outbox("o2", "r", "late", None));
        assert!(straggler.pending_outbox().is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn a_panic_inside_a_write_does_not_poison_the_store() {
        let store = std::sync::Arc::new(Store::in_memory().unwrap());
        let inner = store.clone();
        let outcome = std::thread::spawn(move || {
            inner.write(|w| {
                w.insert_outbox("o1", "r", "hi", None);
                panic!("caller bug");
            })
        })
        .join();
        assert!(outcome.is_err());
        assert_eq!(count(&store, "outbox"), 0);
        store.write(|w| w.insert_outbox("o2", "r", "again", None));
        assert_eq!(count(&store, "outbox"), 1);
    }
}
