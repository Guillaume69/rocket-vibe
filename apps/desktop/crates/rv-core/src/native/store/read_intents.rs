//! Save original observed reads and favorite commands before any HTTP request.
use super::*;
use rv_protocol::parity::{RoomCommandReceipt, SetRoomFavorite};

#[derive(Clone)]
pub struct PendingRead {
    pub room: String,
    pub membership: String,
    pub root_position: String,
}

pub struct SavedFavorite {
    pub room: String,
    pub membership: String,
    pub input: SetRoomFavorite,
    pub phase: String,
    pub receipt_revision: Option<String>,
    pub error: Option<String>,
}
fn favorite_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedFavorite> {
    let input: SetRoomFavorite =
        serde_json::from_str(&row.get::<_, String>(3)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
    let id: String = row.get(0)?;
    let saved = SavedFavorite {
        room: row.get(1)?,
        membership: row.get(2)?,
        input,
        phase: row.get(4)?,
        receipt_revision: row.get(5)?,
        error: row.get(6)?,
    };
    if saved.input.operation_id != id
        || !identifier(&id)
        || !identifier(&saved.room)
        || !identifier(&saved.membership)
        || !matches!(saved.phase.as_str(), "pending" | "confirmed" | "failed")
        || saved.error.as_ref().is_some_and(|code| !identifier(code))
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let expected = decimal(&saved.input.expected_revision)?;
    let receipt = saved.receipt_revision.as_deref().map(decimal).transpose()?;
    if (saved.phase == "confirmed") != receipt.is_some() || receipt.is_some_and(|p| p < expected) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(saved)
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
const FAVORITE_SELECT: &str =
    "SELECT id,rid,membership,payload,phase,receipt_revision,error FROM native_favorite_intents";
impl NativeStore {
    /// The ID is supplied by the renderer, never replaced with the newest
    /// cached message or a journal watermark while a read waits for retry.
    pub fn stage_read(&self, rid: &str, observed: &str) -> rusqlite::Result<bool> {
        if !identifier(rid) || !identifier(observed) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if !self.same(&tx)? {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let Some(state) = read_states::state_in(&tx, rid)? else {
            return Err(rusqlite::Error::InvalidQuery);
        };
        let membership = state.membership_version.ok_or(rusqlite::Error::InvalidQuery)?;
        let position: Option<String> = tx
            .query_row(
                "SELECT position FROM native_messages WHERE id=?1 AND rid=?2 AND NOT deleted AND position IS NOT NULL",
                params![observed, rid],
                |r| r.get(0),
            )
            .optional()?;
        let Some(position) = position else {
            return Ok(false);
        };
        let position_value = decimal(&position)?;
        if position_value <= decimal(&state.root_position)? {
            return Ok(false);
        }
        let old: Option<String> = tx
            .query_row(
                "SELECT root_position FROM native_read_intents WHERE rid=?1 AND membership=?2",
                params![rid, membership],
                |r| r.get(0),
            )
            .optional()?;
        if old.as_deref().map(decimal).transpose()?.is_some_and(|p| p >= position_value) {
            return Ok(false);
        }
        tx.execute("INSERT INTO native_read_intents(rid,membership,root_position) VALUES(?1,?2,?3) ON CONFLICT(rid) DO UPDATE SET membership=excluded.membership,root_position=excluded.root_position",params![rid,membership,position])?;
        tx.commit()?;
        // Staging a read changes no visible state and must not rearm UI timers.
        Ok(true)
    }
    pub fn pending_reads(&self) -> rusqlite::Result<Vec<PendingRead>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        conn.prepare("SELECT q.rid,q.membership,q.root_position FROM native_read_intents q JOIN native_read_states s ON s.rid=q.rid WHERE q.membership=json_extract(s.payload,'$.membership_version') ORDER BY q.rowid")?
            .query_map([],|r|{let p:String=r.get(2)?;decimal(&p)?;Ok(PendingRead{room:r.get(0)?,membership:r.get(1)?,root_position:p})})?.collect()
    }
    pub fn favorite_intent(&self, rid: &str) -> rusqlite::Result<Option<SavedFavorite>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        conn.query_row(&format!("{FAVORITE_SELECT} WHERE rid=?1"), [rid], favorite_row).optional()
    }
    /// A second desired value never overwrites an unresolved or failed form.
    pub fn stage_favorite(&self, rid: &str, present: bool) -> rusqlite::Result<Option<SavedFavorite>> {
        self.stage_favorite_checked(rid, present, None)
    }
    /// A UI command must keep the exact personal revision it displayed.
    pub fn stage_favorite_from_state(
        &self,
        rid: &str,
        present: bool,
        membership: &str,
        revision: &str,
    ) -> rusqlite::Result<Option<SavedFavorite>> {
        decimal(revision)?;
        self.stage_favorite_checked(rid, present, Some((membership, revision)))
    }
    fn stage_favorite_checked(
        &self,
        rid: &str,
        present: bool,
        expected: Option<(&str, &str)>,
    ) -> rusqlite::Result<Option<SavedFavorite>> {
        if !identifier(rid) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic(|tx| {
            if !self.same(tx)? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let state = read_states::state_in(tx, rid)?.ok_or(rusqlite::Error::InvalidQuery)?;
            if expected.is_some_and(|(membership, revision)| {
                state.membership_version.as_deref() != Some(membership)
                    || state.favorite_revision.as_deref() != Some(revision)
            }) {
                return Ok(None);
            }
            let membership = state.membership_version.ok_or(rusqlite::Error::InvalidQuery)?;
            if let Some(old) =
                tx.query_row(&format!("{FAVORITE_SELECT} WHERE rid=?1"), [rid], favorite_row).optional()?
            {
                return Ok((old.phase != "failed" && old.membership == membership && old.input.present == present)
                    .then_some(old));
            }
            let input = SetRoomFavorite {
                operation_id: format!("{:032x}", fastrand::u128(..)),
                expected_revision: state.favorite_revision.ok_or(rusqlite::Error::InvalidQuery)?,
                present,
            };
            tx.execute(
                "INSERT INTO native_favorite_intents(id,rid,membership,payload) VALUES(?1,?2,?3,?4)",
                params![input.operation_id, rid, membership, json(&input)?],
            )?;
            Ok(Some(SavedFavorite {
                room: rid.into(),
                membership,
                input,
                phase: "pending".into(),
                receipt_revision: None,
                error: None,
            }))
        })
    }
    pub fn pending_favorites(&self) -> rusqlite::Result<Vec<SavedFavorite>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(vec![]);
        }
        conn.prepare(&format!("{FAVORITE_SELECT} WHERE phase IN ('pending','confirmed') ORDER BY rowid"))?
            .query_map([], favorite_row)?
            .collect()
    }
    pub fn confirm_favorite_receipt(&self, receipt: &RoomCommandReceipt, token: u64) -> rusqlite::Result<bool> {
        if !identifier(&receipt.operation_id) || !identifier(&receipt.room_id) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        decimal(&receipt.applied_revision)?;
        self.atomic(|tx| {
            if !self.same(tx)? || token != self.projection_token() {
                return Ok(false);
            }
            let Some(saved) = tx
                .query_row(&format!("{FAVORITE_SELECT} WHERE id=?1"), [&receipt.operation_id], favorite_row)
                .optional()?
            else {
                return Ok(false);
            };
            if saved.room != receipt.room_id
                || decimal(&receipt.applied_revision)? < decimal(&saved.input.expected_revision)?
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let Some(state) = read_states::state_in(tx, &saved.room)? else {
                return Ok(false);
            };
            if state.membership_version.as_deref() != Some(&saved.membership) {
                return Ok(false);
            }
            tx.execute(
                "UPDATE native_favorite_intents SET phase='confirmed',receipt_revision=?2,error=NULL WHERE id=?1",
                params![receipt.operation_id, receipt.applied_revision],
            )?;
            Self::satisfy_read_intents(tx, &state)?;
            // A receipt never assigns its historical preferred value to the cache.
            Ok(true)
        })
    }
    pub fn fail_favorite(&self, rid: &str, id: &str, code: &str) -> rusqlite::Result<()> {
        if !identifier(code) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic(|tx|{if self.same(tx)? {tx.execute("UPDATE native_favorite_intents SET phase='failed',error=?3 WHERE rid=?1 AND id=?2 AND phase='pending'",params![rid,id,code])?;}Ok(())})
    }
    pub fn dismiss_failed_favorite(&self, rid: &str, id: &str) -> rusqlite::Result<bool> {
        self.atomic(|tx| {
            if !self.same(tx)? {
                return Ok(false);
            }
            Ok(tx.execute(
                "DELETE FROM native_favorite_intents WHERE rid=?1 AND id=?2 AND phase='failed'",
                params![rid, id],
            )? > 0)
        })
    }
    pub(super) fn satisfy_read_intents(
        tx: &Transaction,
        state: &rv_protocol::parity::ReadState,
    ) -> rusqlite::Result<()> {
        let Some(membership) = &state.membership_version else {
            return Ok(());
        };
        let confirmed_root = decimal(&state.root_position)?;
        let root: Option<String> = tx
            .query_row(
                "SELECT root_position FROM native_read_intents WHERE rid=?1 AND membership=?2",
                params![state.room_id, membership],
                |r| r.get(0),
            )
            .optional()?;
        if root.as_deref().map(decimal).transpose()?.is_some_and(|p| p <= confirmed_root) {
            tx.execute(
                "DELETE FROM native_read_intents WHERE rid=?1 AND membership=?2",
                params![state.room_id, membership],
            )?;
        }
        let receipt:Option<(String,String)>=tx.query_row("SELECT id,receipt_revision FROM native_favorite_intents WHERE rid=?1 AND membership=?2 AND phase='confirmed'",params![state.room_id,membership],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((id, floor)) = receipt {
            let floor = decimal(&floor)?;
            if state.favorite_revision.as_deref().map(decimal).transpose()?.is_some_and(|p| p >= floor) {
                tx.execute("DELETE FROM native_favorite_intents WHERE id=?1", [id])?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rv_protocol::parity::ReadState;
    fn identity(epoch: &str) -> Identity {
        Identity { instance_id: "instance".into(), data_epoch: epoch.into() }
    }
    fn snapshot(membership: &str) -> Snapshot {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../../../docs/protocol/v1.fixture.json")).unwrap();
        let mut room: Room = serde_json::from_value(fixture["room"].clone()).unwrap();
        room.read_state = Some(Box::new(ReadState {
            room_id: room.id.clone(),
            revision: "10".into(),
            membership_version: Some(membership.into()),
            favorite_revision: Some("9".into()),
            root_position: "0".into(),
            reply_position: "0".into(),
            unread_roots: "2".into(),
            unread_replies: "0".into(),
            mentions: "0".into(),
            group_mentions: "0".into(),
            favorite: false,
        }));
        let mut observed: Message = serde_json::from_value(fixture["message"].clone()).unwrap();
        observed.room_id = room.id.clone();
        observed.id = "observed".into();
        observed.position = "9007199254740993".into();
        let mut newest = observed.clone();
        newest.id = "newest".into();
        newest.position = "9007199254740994".into();
        newest.revision = "11".into();
        Snapshot { protocol_version: 1, rooms: vec![room], messages: vec![observed, newest], cursor: "initial".into() }
    }
    fn store() -> (NativeStore, String) {
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        let snapshot = snapshot("membership");
        let rid = snapshot.rooms[0].id.clone();
        store.snapshot(&snapshot).unwrap();
        (store, rid)
    }
    fn state(store: &NativeStore, rid: &str, revision: &str, root: &str, favorite_revision: &str, favorite: bool) {
        let mut state = store.read_state(rid).unwrap().unwrap();
        state.revision = revision.into();
        state.root_position = root.into();
        state.favorite_revision = Some(favorite_revision.into());
        state.favorite = favorite;
        assert!(store.cache_read_state(&state, store.projection_token()).unwrap());
    }
    fn receipt(saved: &SavedFavorite, revision: &str) -> RoomCommandReceipt {
        RoomCommandReceipt {
            room_id: saved.room.clone(),
            operation_id: saved.input.operation_id.clone(),
            applied_revision: revision.into(),
        }
    }
    #[test]
    fn only_observed_confirmed_messages_advance_and_reads_coalesce_exactly() {
        let (store, rid) = store();
        let mut changes = store.changes();
        store.enqueue("unsent", &rid, "Draft", "alice").unwrap();
        let _ = changes.try_recv();
        assert!(!store.stage_read(&rid, "unsent").unwrap());
        assert!(store.stage_read(&rid, "observed").unwrap());
        assert_eq!(store.pending_reads().unwrap()[0].root_position, "9007199254740993");
        assert!(!store.stage_read(&rid, "observed").unwrap());
        assert!(store.stage_read(&rid, "newest").unwrap());
        assert!(!store.stage_read(&rid, "observed").unwrap());
        assert_eq!(store.pending_reads().unwrap()[0].root_position, "9007199254740994");
        assert!(changes.try_recv().is_err());
        state(&store, &rid, "12", "9007199254740993", "9", false);
        assert_eq!(store.pending_reads().unwrap().len(), 1);
        state(&store, &rid, "13", "9007199254740994", "9", false);
        assert!(store.pending_reads().unwrap().is_empty());
        assert!(!store.stage_read(&rid, "observed").unwrap());
    }
    #[test]
    fn reopening_preserves_original_positions_nonce_and_favorite_cas() {
        let path = std::env::temp_dir().join(format!("rv-read-intents-{:032x}.sqlite", fastrand::u128(..)));
        let initial = snapshot("membership");
        let rid = &initial.rooms[0].id;
        let original = NativeStore::open(&path, identity("epoch")).unwrap();
        original.snapshot(&initial).unwrap();
        original.stage_read(rid, "observed").unwrap();
        let saved = original.stage_favorite(rid, true).unwrap().unwrap();
        drop(original);
        let resumed = NativeStore::open(&path, identity("epoch")).unwrap();
        state(&resumed, rid, "20", "0", "19", false);
        let retry = resumed.stage_favorite(rid, true).unwrap().unwrap();
        assert_eq!(retry.input.operation_id, saved.input.operation_id);
        assert_eq!(retry.input.expected_revision, "9");
        assert_eq!(resumed.pending_reads().unwrap()[0].root_position, "9007199254740993");
        assert!(resumed.stage_favorite(rid, false).unwrap().is_none());
        drop(resumed);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn favorite_receipt_waits_for_fresh_state_and_never_restores_historical_boolean() {
        let (store, rid) = store();
        let saved = store.stage_favorite(&rid, true).unwrap().unwrap();
        assert!(store.confirm_favorite_receipt(&receipt(&saved, "12"), store.projection_token()).unwrap());
        assert!(!store.read_state(&rid).unwrap().unwrap().favorite);
        assert_eq!(store.pending_favorites().unwrap()[0].phase, "confirmed");
        state(&store, &rid, "13", "0", "11", false);
        assert_eq!(store.pending_favorites().unwrap().len(), 1);
        // Another device already removed the favorite after this old receipt.
        state(&store, &rid, "14", "0", "14", false);
        assert!(store.pending_favorites().unwrap().is_empty());
        assert!(!store.read_state(&rid).unwrap().unwrap().favorite);
        assert!(!store.confirm_favorite_receipt(&receipt(&saved, "12"), store.projection_token()).unwrap());
    }
    #[test]
    fn permanent_failure_requires_exact_dismissal_without_replacing_unresolved_intent() {
        let (store, rid) = store();
        let saved = store.stage_favorite(&rid, true).unwrap().unwrap();
        assert!(!store.dismiss_failed_favorite(&rid, &saved.input.operation_id).unwrap());
        store.fail_favorite(&rid, &saved.input.operation_id, "revision_conflict").unwrap();
        assert!(store.stage_favorite(&rid, true).unwrap().is_none());
        assert!(!store.dismiss_failed_favorite(&rid, "wrong-operation").unwrap());
        assert!(store.dismiss_failed_favorite(&rid, &saved.input.operation_id).unwrap());
        let replacement = store.stage_favorite(&rid, false).unwrap().unwrap();
        assert_ne!(replacement.input.operation_id, saved.input.operation_id);
        assert!(!store.dismiss_failed_favorite(&rid, &saved.input.operation_id).unwrap());
    }
    #[test]
    fn rejoin_purges_both_queues_and_late_receipts_cannot_affect_new_membership() {
        let (store, rid) = store();
        store.stage_read(&rid, "observed").unwrap();
        let saved = store.stage_favorite(&rid, true).unwrap().unwrap();
        let token = store.projection_token();
        let mut next = snapshot("rejoined");
        next.rooms[0].read_state.as_mut().unwrap().revision = "20".into();
        store.snapshot(&next).unwrap();
        assert!(store.pending_reads().unwrap().is_empty());
        assert!(store.pending_favorites().unwrap().is_empty());
        let replacement = store.stage_favorite(&rid, false).unwrap().unwrap();
        assert!(!store.confirm_favorite_receipt(&receipt(&saved, "12"), token).unwrap());
        assert_eq!(store.favorite_intent(&rid).unwrap().unwrap().input.operation_id, replacement.input.operation_id);
    }
    #[test]
    fn same_membership_snapshot_preserves_unacknowledged_intentions() {
        let (store, rid) = store();
        store.stage_read(&rid, "observed").unwrap();
        let saved = store.stage_favorite(&rid, true).unwrap().unwrap();
        store.snapshot(&snapshot("membership")).unwrap();
        assert_eq!(store.pending_reads().unwrap()[0].root_position, "9007199254740993");
        assert_eq!(store.favorite_intent(&rid).unwrap().unwrap().input.operation_id, saved.input.operation_id);
        store
            .batch(&SyncBatch {
                protocol_version: 1,
                changes: vec![Change::RoomRemoved { room_id: rid }],
                cursor: "withdrawn".into(),
                has_more: false,
            })
            .unwrap();
        assert!(store.pending_reads().unwrap().is_empty());
        assert!(store.pending_favorites().unwrap().is_empty());
    }
    #[test]
    fn malformed_receipt_or_sqlite_floor_rolls_back_instead_of_panicking() {
        let (store, rid) = store();
        let saved = store.stage_favorite(&rid, true).unwrap().unwrap();
        assert!(store.confirm_favorite_receipt(&receipt(&saved, "8"), store.projection_token()).is_err());
        assert!(store.confirm_favorite_receipt(&receipt(&saved, "012"), store.projection_token()).is_err());
        assert_eq!(store.favorite_intent(&rid).unwrap().unwrap().phase, "pending");
        store
            .conn
            .lock()
            .unwrap()
            .execute("UPDATE native_favorite_intents SET phase='confirmed',receipt_revision='bogus'", [])
            .unwrap();
        assert!(store.pending_favorites().is_err());
        let mut changed = store.read_state(&rid).unwrap().unwrap();
        changed.revision = "20".into();
        assert!(store.cache_read_state(&changed, store.projection_token()).is_err());
        assert_eq!(store.read_state(&rid).unwrap().unwrap().revision, "10");
    }
    #[test]
    fn rendered_favorite_keeps_observed_cas_and_membership_without_optimistic_projection() {
        let (store, rid) = store();
        let mut updated = store.read_state(&rid).unwrap().unwrap();
        updated.revision = "20".into();
        updated.favorite_revision = Some("19".into());
        assert!(store.cache_read_state(&updated, store.projection_token()).unwrap());
        assert!(store.stage_favorite_from_state(&rid, true, "membership", "9").unwrap().is_none());
        assert!(store.stage_favorite_from_state(&rid, true, "obsolete", "19").unwrap().is_none());
        assert!(store.favorite_intent(&rid).unwrap().is_none());
        let saved = store.stage_favorite_from_state(&rid, true, "membership", "19").unwrap().unwrap();
        assert_eq!(saved.input.expected_revision, "19");
        assert!(!store.read_state(&rid).unwrap().unwrap().favorite);
        assert!(store.stage_favorite_from_state(&rid, false, "membership", "19").unwrap().is_none());
        assert_eq!(store.favorite_intent(&rid).unwrap().unwrap().input.operation_id, saved.input.operation_id);
    }
}
