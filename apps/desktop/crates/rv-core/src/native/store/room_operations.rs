//! Private per-room intentions. Save before HTTP; a journal update never
//! replaces an unresolved operation's original nonce or expected revision.
use super::NativeStore;
use rusqlite::{OptionalExtension, params};
use rv_protocol::parity::{ChangeRoomRole, LeaveRoom, RoomCommandReceipt, UpdateRoom};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RoomOperation {
    Settings { input: UpdateRoom },
    Role { target: String, input: ChangeRoomRole },
    Leave { input: LeaveRoom },
}
impl RoomOperation {
    pub fn id(&self) -> &str {
        match self {
            Self::Settings { input } => &input.operation_id,
            Self::Role { input, .. } => &input.operation_id,
            Self::Leave { input } => &input.operation_id,
        }
    }
    pub fn revision(&self) -> &str {
        match self {
            Self::Settings { input } => &input.expected_revision,
            Self::Role { input, .. } => &input.expected_revision,
            Self::Leave { input } => &input.expected_revision,
        }
    }
    fn valid(&self) -> bool {
        if !identifier(self.id()) || !identifier(self.revision()) {
            return false;
        }
        match self {
            Self::Settings { input } => {
                !input.name.trim().is_empty()
                    && input.name.trim().len() <= 128
                    && !input.name.trim().chars().any(char::is_control)
                    && input.topic.len() <= 1024
                    && input.description.len() <= 4096
                    && input.announcement.len() <= 4096
                    && [&input.topic, &input.description, &input.announcement].iter().all(|s| !s.contains('\0'))
            }
            Self::Role { target, .. } => identifier(target),
            Self::Leave { .. } => true,
        }
    }
    fn normalized(mut self) -> Self {
        if let Self::Settings { input } = &mut self {
            input.name = input.name.trim().into();
        }
        self
    }
    fn same_form(&self, other: &Self) -> bool {
        // Incoming forms may have a newer live revision. Retrying the same
        // fields still uses the saved revision, never silently rebases them.
        let strip = |operation: &Self| {
            let mut value = serde_json::to_value(operation).expect("typed room intention");
            value["input"].as_object_mut().unwrap().remove("operation_id");
            value["input"].as_object_mut().unwrap().remove("expected_revision");
            value
        };
        strip(self) == strip(other)
    }
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub struct SavedRoomOperation {
    pub room: String,
    pub command: RoomOperation,
    pub failed: bool,
    pub error: Option<String>,
}
fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedRoomOperation> {
    let id: String = row.get(0)?;
    let command: RoomOperation =
        serde_json::from_str(&row.get::<_, String>(2)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
    if command.id() != id || !command.valid() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(SavedRoomOperation {
        room: row.get(1)?,
        command,
        failed: row.get::<_, String>(3)? == "failed",
        error: row.get(4)?,
    })
}
impl NativeStore {
    pub fn room_operation(&self, room: &str) -> rusqlite::Result<Option<SavedRoomOperation>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        conn.query_row("SELECT id,rid,payload,state,error FROM native_room_operations WHERE rid=?1", [room], row)
            .optional()
    }
    /// None means another unresolved form occupies this room. Failed forms
    /// require an explicit local dismissal before a replacement can be staged.
    pub fn stage_room_operation(
        &self,
        room: &str,
        command: RoomOperation,
    ) -> rusqlite::Result<Option<SavedRoomOperation>> {
        let command = command.normalized();
        if !identifier(room) || !command.valid() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic(|tx| {
            if !self.same(tx)?
                || !tx.query_row("SELECT EXISTS(SELECT 1 FROM native_rooms WHERE id=?1)", [room], |r| {
                    r.get::<_, bool>(0)
                })?
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            if let Some(previous) = tx
                .query_row("SELECT id,rid,payload,state,error FROM native_room_operations WHERE rid=?1", [room], row)
                .optional()?
            {
                return Ok((!previous.failed && previous.command.same_form(&command)).then_some(previous));
            }
            let payload = serde_json::to_string(&command).map_err(|_| rusqlite::Error::InvalidQuery)?;
            tx.execute(
                "INSERT INTO native_room_operations(id,rid,payload) VALUES(?1,?2,?3)",
                params![command.id(), room, payload],
            )?;
            Ok(Some(SavedRoomOperation { room: room.into(), command, failed: false, error: None }))
        })
    }
    pub fn pending_room_operations(&self) -> rusqlite::Result<Vec<SavedRoomOperation>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        conn.prepare(
            "SELECT id,rid,payload,state,error FROM native_room_operations WHERE state='pending' ORDER BY rowid",
        )?
        .query_map([], row)?
        .collect()
    }
    pub fn fail_room_operation(&self, room: &str, operation: &str, error: &str) -> rusqlite::Result<()> {
        if !identifier(error) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic(|tx| {
            if self.same(tx)? {
                tx.execute(
                    "UPDATE native_room_operations SET state='failed',error=?3 WHERE rid=?1 AND id=?2",
                    params![room, operation, error],
                )?;
            }
            Ok(())
        })
    }
    pub fn dismiss_room_operation(&self, room: &str, operation: &str) -> rusqlite::Result<bool> {
        self.atomic(|tx| {
            if !self.same(tx)? {
                return Ok(false);
            }
            // An ambiguous pending operation cannot be replaced while an HTTP
            // attempt could still apply it. Only permanent failures are editable.
            Ok(tx.execute(
                "DELETE FROM native_room_operations WHERE rid=?1 AND id=?2 AND state='failed'",
                params![room, operation],
            )? > 0)
        })
    }
    pub fn confirm_room_operation(&self, receipt: &RoomCommandReceipt) -> rusqlite::Result<bool> {
        if !identifier(&receipt.operation_id) || !identifier(&receipt.room_id) || !identifier(&receipt.applied_revision)
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic(|tx| {
            if !self.same(tx)? {
                return Ok(false);
            }
            let saved = tx
                .query_row(
                    "SELECT id,rid,payload,state,error FROM native_room_operations WHERE id=?1",
                    [&receipt.operation_id],
                    row,
                )
                .optional()?;
            let Some(saved) = saved else {
                return Ok(false);
            };
            if saved.room != receipt.room_id {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.execute("DELETE FROM native_room_operations WHERE id=?1", [&receipt.operation_id])?;
            // A receipt acknowledges an intention, never projects older settings.
            Ok(true)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::Identity;
    use rv_protocol::{Change, Room, RoomKind, Snapshot, SyncBatch};
    fn identity(epoch: &str) -> Identity {
        Identity { instance_id: "instance".into(), data_epoch: epoch.into() }
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            protocol_version: 1,
            rooms: vec![Room {
                id: "room".into(),
                name: "Room".into(),
                kind: RoomKind::Private,
                revision: "1".into(),
                encrypted: false,
                read_state: None,
            }],
            messages: vec![],
            cursor: "cursor".into(),
        }
    }
    fn settings(operation: &str, revision: &str) -> RoomOperation {
        RoomOperation::Settings {
            input: UpdateRoom {
                operation_id: operation.into(),
                expected_revision: revision.into(),
                name: "  Room  ".into(),
                private: true,
                topic: "Private subject".into(),
                description: "Description".into(),
                announcement: String::new(),
                read_only: false,
            },
        }
    }
    #[test]
    fn original_operation_survives_disk_reopen_live_revision_changes_and_receipt_replay() {
        let path = std::env::temp_dir().join(format!("rv-room-operation-{:032x}.sqlite", fastrand::u128(..)));
        let store = NativeStore::open(&path, identity("epoch")).unwrap();
        store.snapshot(&snapshot()).unwrap();
        let original = store.stage_room_operation("room", settings("original", "original-revision")).unwrap().unwrap();
        assert_eq!(original.command.id(), "original");
        drop(store);
        let store = NativeStore::open(&path, identity("epoch")).unwrap();
        let retry = store.stage_room_operation("room", settings("replacement", "newer-revision")).unwrap().unwrap();
        assert_eq!(retry.command.id(), "original");
        assert_eq!(retry.command.revision(), "original-revision");
        let mut different = settings("different", "fresh");
        if let RoomOperation::Settings { input } = &mut different {
            input.topic = "Other subject".into();
        }
        assert!(store.stage_room_operation("room", different).unwrap().is_none());
        assert!(!store.dismiss_room_operation("room", "original").unwrap());
        let receipt = RoomCommandReceipt {
            operation_id: "original".into(),
            room_id: "room".into(),
            applied_revision: "applied".into(),
        };
        let mut foreign = receipt.clone();
        foreign.room_id = "other".into();
        assert!(store.confirm_room_operation(&foreign).is_err());
        assert!(store.confirm_room_operation(&receipt).unwrap());
        assert!(!store.confirm_room_operation(&receipt).unwrap());
        assert!(store.room_operation("room").unwrap().is_none());
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn failed_forms_require_exact_dismissal_and_withdrawal_purges_private_payloads() {
        let store = NativeStore::open(std::path::Path::new(":memory:"), identity("epoch")).unwrap();
        store.snapshot(&snapshot()).unwrap();
        store.stage_room_operation("room", settings("original", "revision")).unwrap();
        store.fail_room_operation("room", "different", "last_room_owner").unwrap();
        assert!(!store.room_operation("room").unwrap().unwrap().failed);
        store.fail_room_operation("room", "original", "last_room_owner").unwrap();
        assert!(store.room_operation("room").unwrap().unwrap().failed);
        assert!(store.stage_room_operation("room", settings("new", "fresh")).unwrap().is_none());
        assert!(!store.dismiss_room_operation("room", "different").unwrap());
        assert!(store.dismiss_room_operation("room", "original").unwrap());
        store
            .stage_room_operation(
                "room",
                RoomOperation::Leave {
                    input: LeaveRoom { operation_id: "leave".into(), expected_revision: "fresh".into() },
                },
            )
            .unwrap();
        store
            .batch(&SyncBatch {
                protocol_version: 1,
                changes: vec![Change::RoomRemoved { room_id: "room".into() }],
                cursor: "removed".into(),
                has_more: false,
            })
            .unwrap();
        assert!(store.pending_room_operations().unwrap().is_empty());
        assert!(store.room_operation("room").unwrap().is_none());
        store.snapshot(&snapshot()).unwrap();
        assert!(store.room_operation("room").unwrap().is_none());
    }
    #[test]
    fn generation_change_and_sql_failure_never_leave_a_partial_intention() {
        let path = std::env::temp_dir().join(format!("rv-room-generation-{:032x}.sqlite", fastrand::u128(..)));
        let store = NativeStore::open(&path, identity("epoch")).unwrap();
        store.snapshot(&snapshot()).unwrap();
        store.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_room_command BEFORE INSERT ON native_room_operations BEGIN SELECT RAISE(ABORT,'injected write failure'); END;").unwrap();
        assert!(store.stage_room_operation("room", settings("rejected", "revision")).is_err());
        assert!(store.pending_room_operations().unwrap().is_empty());
        store.conn.lock().unwrap().execute_batch("DROP TRIGGER reject_room_command").unwrap();
        store.stage_room_operation("room", settings("saved", "revision")).unwrap();
        drop(store);
        let replacement = NativeStore::open(&path, identity("replacement")).unwrap();
        assert!(replacement.room_operation("room").unwrap().is_none());
        replacement.snapshot(&snapshot()).unwrap();
        assert!(replacement.pending_room_operations().unwrap().is_empty());
        let count: i64 = replacement
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM native_room_operations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        drop(replacement);
        std::fs::remove_file(path).unwrap();
    }
}
