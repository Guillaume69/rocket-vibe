//! Cached presentation hints are tied to the room's journal revision.
use super::*;
use rv_protocol::parity::RoomDetails;

#[derive(Clone, PartialEq, Eq)]
pub struct RoomAccess {
    pub read_only: bool,
    pub can_send: bool,
    pub role: String,
}
impl NativeStore {
    pub fn room_access(&self, rid: &str) -> rusqlite::Result<Option<RoomAccess>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        conn.query_row("SELECT a.read_only,a.can_send,a.role FROM native_room_access a JOIN native_rooms r ON r.id=a.rid WHERE a.rid=?1 AND a.revision=json_extract(r.payload,'$.revision')", [rid], |r| {
            Ok(RoomAccess { read_only:r.get(0)?,can_send:r.get(1)?,role:r.get(2)? })
        }).optional()
    }
    /// A late HTTP read cannot grant a hint to a newer room or a new membership.
    pub fn cache_room_access(&self, details: &RoomDetails, token: u64) -> rusqlite::Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if !self.same(&tx)? || token != self.projection_token() {
            return Ok(false);
        }
        let current: Option<String> = tx
            .query_row(
                "SELECT json_extract(payload,'$.revision') FROM native_rooms WHERE id=?1",
                [&details.room.id],
                |r| r.get(0),
            )
            .optional()?;
        if current.as_deref() != Some(&details.room.revision) {
            return Ok(false);
        }
        let role = match details.permissions.role {
            rv_protocol::parity::RoomRole::Owner => "owner",
            rv_protocol::parity::RoomRole::Moderator => "moderator",
            rv_protocol::parity::RoomRole::Member => "member",
        };
        let changed = tx.execute("INSERT INTO native_room_access VALUES(?1,?2,?3,?4,?5) ON CONFLICT(rid) DO UPDATE SET revision=excluded.revision,read_only=excluded.read_only,can_send=excluded.can_send,role=excluded.role WHERE revision<>excluded.revision OR read_only<>excluded.read_only OR can_send<>excluded.can_send OR role<>excluded.role", params![details.room.id,details.room.revision,details.read_only,details.permissions.send,role])?;
        tx.commit()?;
        drop(conn);
        if changed > 0 {
            let _ = self.changes.send(());
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity(epoch: &str) -> Identity {
        Identity { instance_id: "fixture-instance".into(), data_epoch: epoch.into() }
    }
    fn details() -> RoomDetails {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../../../docs/protocol/v1.fixture.json")).unwrap();
        serde_json::from_value(fixture["parity"]["room_details"].clone()).unwrap()
    }
    fn snapshot(details: &RoomDetails) -> Snapshot {
        Snapshot { protocol_version: 1, rooms: vec![details.room.clone()], messages: vec![], cursor: "initial".into() }
    }
    #[test]
    fn actor_rights_survive_reopen_and_invalidate_on_new_room_revision() {
        let path = std::env::temp_dir().join(format!("rv-room-access-{:032x}.sqlite", fastrand::u128(..)));
        let mut detail = details();
        detail.read_only = true;
        detail.permissions.send = true;
        let store = NativeStore::open(&path, identity("epoch")).unwrap();
        store.snapshot(&snapshot(&detail)).unwrap();
        assert!(store.cache_room_access(&detail, store.projection_token()).unwrap());
        assert!(store.room_access(&detail.room.id).unwrap().unwrap().can_send);
        drop(store);
        let store = NativeStore::open(&path, identity("epoch")).unwrap();
        assert!(store.room_access(&detail.room.id).unwrap().unwrap().read_only);
        let old = detail.clone();
        detail.room.revision = (detail.room.revision.parse::<u64>().unwrap() + 1).to_string();
        store
            .batch(&SyncBatch {
                protocol_version: 1,
                changes: vec![Change::RoomUpsert(detail.room.clone())],
                cursor: "changed".into(),
                has_more: false,
            })
            .unwrap();
        assert!(store.room_access(&detail.room.id).unwrap().is_none());
        assert!(!store.cache_room_access(&old, store.projection_token()).unwrap());
        detail.permissions.send = false;
        detail.permissions.role = rv_protocol::parity::RoomRole::Member;
        assert!(store.cache_room_access(&detail, store.projection_token()).unwrap());
        assert!(!store.room_access(&detail.room.id).unwrap().unwrap().can_send);
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn withdrawal_rejoin_and_epoch_reset_cannot_restore_old_rights() {
        let detail = details();
        let rid = &detail.room.id;
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        store.snapshot(&snapshot(&detail)).unwrap();
        let token = store.projection_token();
        store.cache_room_access(&detail, token).unwrap();
        store
            .batch(&SyncBatch {
                protocol_version: 1,
                changes: vec![Change::RoomRemoved { room_id: rid.clone() }, Change::RoomUpsert(detail.room.clone())],
                cursor: "rejoined".into(),
                has_more: false,
            })
            .unwrap();
        assert!(store.room_access(rid).unwrap().is_none());
        assert!(!store.cache_room_access(&detail, token).unwrap());
        store.cache_room_access(&detail, store.projection_token()).unwrap();
        store.clear().unwrap();
        assert!(store.room_access(rid).unwrap().is_none());
        assert!(!store.cache_room_access(&detail, token).unwrap());
    }
}
