//! Personal room versions are independent from room metadata and actor rights.
use super::*;
use rv_protocol::parity::ReadState;

fn validate(state: &ReadState, rid: &str) -> rusqlite::Result<()> {
    if state.room_id != rid {
        return Err(rusqlite::Error::InvalidQuery);
    }
    for value in [
        &state.revision,
        &state.root_position,
        &state.reply_position,
        &state.unread_roots,
        &state.unread_replies,
        &state.mentions,
        &state.group_mentions,
    ] {
        decimal(value)?;
    }
    if let Some(version) = &state.favorite_revision
        && decimal(version)? > decimal(&state.revision)?
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if state.membership_version.as_ref().is_some_and(|v| {
        v.is_empty() || v.len() > 128 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    }) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}
pub(super) fn state_in(conn: &Connection, rid: &str) -> rusqlite::Result<Option<ReadState>> {
    let payload: Option<String> =
        conn.query_row("SELECT payload FROM native_read_states WHERE rid=?1", [rid], |r| r.get(0)).optional()?;
    payload
        .map(|p| {
            let state: ReadState = serde_json::from_str(&p).map_err(|_| rusqlite::Error::InvalidQuery)?;
            validate(&state, rid)?;
            Ok(state)
        })
        .transpose()
}
fn save(tx: &Transaction, state: &ReadState) -> rusqlite::Result<()> {
    tx.execute("INSERT INTO native_read_states(rid,payload) VALUES(?1,?2) ON CONFLICT(rid) DO UPDATE SET payload=excluded.payload",
        params![state.room_id,json(state)?])?;
    NativeStore::satisfy_read_intents(tx, state)
}
impl NativeStore {
    pub fn read_state(&self, rid: &str) -> rusqlite::Result<Option<ReadState>> {
        let conn = self.conn.lock().unwrap();
        if !self.same(&conn)? {
            return Ok(None);
        }
        state_in(&conn, rid)
    }
    /// Called only by the authoritative journal/snapshot, never by an HTTP ack.
    pub(super) fn personal_room(tx: &Transaction, room: &Room, known: bool) -> rusqlite::Result<bool> {
        let Some(next) = &room.read_state else {
            return Ok(false);
        };
        validate(next, &room.id)?;
        let previous = state_in(tx, &room.id)?;
        let mut reset = false;
        if let Some(old) = &previous {
            let next_revision = decimal(&next.revision)?;
            let old_revision = decimal(&old.revision)?;
            if next_revision < old_revision {
                return Ok(false);
            }
            if next_revision == old_revision && next.as_ref() != old {
                return Err(rusqlite::Error::InvalidQuery);
            }
            reset = old.membership_version != next.membership_version;
            if !reset
                && let (Some(next), Some(previous)) = (&next.favorite_revision, &old.favorite_revision)
                && decimal(next)? < decimal(previous)?
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            if !reset
                && (decimal(&next.root_position)? < decimal(&old.root_position)?
                    || decimal(&next.reply_position)? < decimal(&old.reply_position)?)
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
        } else if known && next.membership_version.is_some() {
            // An old cache without a lifetime stamp cannot prove that its
            // unsent intentions survived a withdrawal missed while offline.
            reset = true;
        }
        if reset {
            Self::remove_content(tx, &room.id)?;
        }
        save(tx, next)?;
        Ok(reset)
    }
    /// A late HTTP response can update only the same known membership lifetime.
    pub fn cache_read_state(&self, state: &ReadState, token: u64) -> rusqlite::Result<bool> {
        validate(state, &state.room_id)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if !self.same(&tx)? || token != self.projection_token() {
            return Ok(false);
        }
        let Some(old) = state_in(&tx, &state.room_id)? else {
            return Ok(false);
        };
        if old.membership_version != state.membership_version || decimal(&state.revision)? < decimal(&old.revision)? {
            return Ok(false);
        }
        if decimal(&state.root_position)? < decimal(&old.root_position)?
            || decimal(&state.reply_position)? < decimal(&old.reply_position)?
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if let (Some(next), Some(previous)) = (&state.favorite_revision, &old.favorite_revision)
            && decimal(next)? < decimal(previous)?
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if state.revision == old.revision && *state != old {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let changed = *state != old;
        if changed {
            save(&tx, state)?;
        }
        tx.commit()?;
        drop(conn);
        if changed {
            let _ = self.changes.send(());
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity(epoch: &str) -> Identity {
        Identity { instance_id: "instance".into(), data_epoch: epoch.into() }
    }
    fn room(revision: &str, personal: &str, membership: &str) -> Room {
        Room {
            id: "room".into(),
            name: format!("Room {revision}"),
            kind: rv_protocol::RoomKind::Private,
            revision: revision.into(),
            read_state: Some(Box::new(ReadState {
                room_id: "room".into(),
                revision: personal.into(),
                membership_version: Some(membership.into()),
                favorite_revision: Some(personal.into()),
                root_position: "0".into(),
                reply_position: "0".into(),
                unread_roots: "1".into(),
                unread_replies: "0".into(),
                mentions: "1".into(),
                group_mentions: "0".into(),
                favorite: true,
            })),
        }
    }
    fn snapshot(room: Room) -> Snapshot {
        Snapshot { protocol_version: 1, rooms: vec![room], messages: vec![], cursor: "snapshot".into() }
    }
    fn batch(room: Room) -> SyncBatch {
        SyncBatch {
            protocol_version: 1,
            changes: vec![Change::RoomUpsert(room)],
            cursor: "next".into(),
            has_more: false,
        }
    }
    #[test]
    fn personal_and_metadata_versions_merge_separately_beyond_js_precision() {
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        store.snapshot(&snapshot(room("20", "9007199254740993", "membership"))).unwrap();
        let mut newer = room("10", "9007199254740994", "membership");
        newer.read_state.as_mut().unwrap().favorite = false;
        store.batch(&batch(newer)).unwrap();
        let current = &store.rooms().unwrap()[0];
        assert_eq!(current.revision, "20");
        assert_eq!(current.name, "Room 20");
        assert!(!current.read_state.as_ref().unwrap().favorite);
        store.batch(&batch(room("21", "9007199254740993", "membership"))).unwrap();
        let current = &store.rooms().unwrap()[0];
        assert_eq!(current.revision, "21");
        assert!(!current.read_state.as_ref().unwrap().favorite);
    }
    #[test]
    fn missed_withdrawal_rejoin_purges_old_intentions_and_fences_late_http() {
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        store.snapshot(&snapshot(room("1", "2", "before"))).unwrap();
        store.set_draft("room", "Private draft").unwrap();
        store.enqueue("unsent", "room", "Do not send after rejoin", "alice").unwrap();
        let token = store.projection_token();
        let stale = store.read_state("room").unwrap().unwrap();
        store.batch(&batch(room("4", "5", "after"))).unwrap();
        assert!(store.projection_token() > token);
        assert!(store.pending().unwrap().is_empty());
        assert_eq!(store.draft("room").unwrap(), "");
        assert!(store.messages("room", 50).unwrap().is_empty());
        assert!(!store.cache_read_state(&stale, token).unwrap());
        store.batch(&batch(room("1", "2", "before"))).unwrap();
        assert_eq!(store.read_state("room").unwrap().unwrap().membership_version.as_deref(), Some("after"));
    }
    #[test]
    fn same_membership_role_change_preserves_drafts_and_pending_messages() {
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        store.snapshot(&snapshot(room("1", "2", "same"))).unwrap();
        store.set_draft("room", "Keep draft").unwrap();
        store.enqueue("unsent", "room", "Keep send", "alice").unwrap();
        let token = store.projection_token();
        store.batch(&batch(room("3", "2", "same"))).unwrap();
        assert_eq!(store.projection_token(), token);
        assert_eq!(store.pending().unwrap().len(), 1);
        assert_eq!(store.draft("room").unwrap(), "Keep draft");
    }
    #[test]
    fn personal_cache_survives_reopen_and_is_hidden_from_a_new_epoch() {
        let path = std::env::temp_dir().join(format!("rv-read-state-{:032x}.sqlite", fastrand::u128(..)));
        let store = NativeStore::open(&path, identity("epoch")).unwrap();
        store.snapshot(&snapshot(room("1", "2", "same"))).unwrap();
        drop(store);
        let store = NativeStore::open(&path, identity("epoch")).unwrap();
        assert!(store.read_state("room").unwrap().unwrap().favorite);
        drop(store);
        let store = NativeStore::open(&path, identity("new-epoch")).unwrap();
        assert!(store.read_state("room").unwrap().is_none());
        store.snapshot(&snapshot(room("1", "2", "new-life"))).unwrap();
        assert_eq!(store.read_state("room").unwrap().unwrap().membership_version.as_deref(), Some("new-life"));
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn invalid_personal_state_rolls_back_room_and_cursor_together() {
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        store.snapshot(&snapshot(room("1", "2", "same"))).unwrap();
        let mut invalid = room("3", "4", "same");
        invalid.read_state.as_mut().unwrap().room_id = "another".into();
        assert!(store.batch(&batch(invalid)).is_err());
        assert_eq!(store.cursor().unwrap().as_deref(), Some("snapshot"));
        assert_eq!(store.rooms().unwrap()[0].revision, "1");
        let mut invalid = room("3", "4", "same");
        invalid.read_state.as_mut().unwrap().root_position = "01".into();
        assert!(store.batch(&batch(invalid)).is_err());
    }
    #[test]
    fn learning_a_lifetime_purges_an_unstamped_legacy_outbox() {
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        let mut old = room("1", "2", "same");
        old.read_state = None;
        store.snapshot(&snapshot(old)).unwrap();
        store.enqueue("legacy-unsent", "room", "Unstamped intention", "alice").unwrap();
        store.snapshot(&snapshot(room("1", "2", "same"))).unwrap();
        assert!(store.pending().unwrap().is_empty());
    }
    #[test]
    fn repeated_read_response_does_not_restart_the_ui_read_timer() {
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        store.snapshot(&snapshot(room("1", "2", "same"))).unwrap();
        let mut changes = store.changes();
        let state = store.read_state("room").unwrap().unwrap();
        assert!(store.cache_read_state(&state, store.projection_token()).unwrap());
        assert!(changes.try_recv().is_err());
        let mut changed = state;
        changed.revision = "3".into();
        assert!(store.cache_read_state(&changed, store.projection_token()).unwrap());
        assert!(changes.try_recv().is_ok());
        assert!(store.cache_read_state(&changed, store.projection_token()).unwrap());
        assert!(changes.try_recv().is_err());
    }
    #[test]
    fn personal_updates_keep_effective_rights_and_late_acks_cannot_rewind_favorites() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../../../docs/protocol/v1.fixture.json")).unwrap();
        let mut details: rv_protocol::parity::RoomDetails =
            serde_json::from_value(fixture["parity"]["room_details"].clone()).unwrap();
        details.room = room("1", "2", "same");
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        store.snapshot(&snapshot(details.room.clone())).unwrap();
        assert!(store.cache_room_access(&details, store.projection_token()).unwrap());
        let rights = store.room_access("room").unwrap().unwrap();
        store.batch(&batch(room("1", "3", "same"))).unwrap();
        assert_eq!(store.room_access("room").unwrap().unwrap().can_send, rights.can_send);
        let mut invalid = store.read_state("room").unwrap().unwrap();
        invalid.revision = "4".into();
        invalid.favorite_revision = Some("2".into());
        assert!(store.cache_read_state(&invalid, store.projection_token()).is_err());
        assert_eq!(store.read_state("room").unwrap().unwrap().favorite_revision.as_deref(), Some("3"));
    }
    #[test]
    fn retained_composer_cannot_resave_or_send_after_rejoin_but_roles_keep_current_draft() {
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        store.snapshot(&snapshot(room("1", "2", "original"))).unwrap();
        assert!(store.set_draft_from_membership("room", "Private original", Some("original")).unwrap());
        assert!(
            !store.enqueue_from_membership("missing-send", "absent", "Old buffer", "alice", Some("original")).unwrap()
        );
        store.batch(&batch(room("3", "4", "rejoined"))).unwrap();
        assert_eq!(store.draft_from_membership("room", Some("original")).unwrap(), "");
        assert!(!store.set_draft_from_membership("room", "Late cleanup of old widget", Some("original")).unwrap());
        assert!(!store.enqueue_from_membership("old-send", "room", "Old buffer", "alice", Some("original")).unwrap());
        assert!(store.pending().unwrap().is_empty());
        assert!(store.set_draft_from_membership("room", "New draft", Some("rejoined")).unwrap());
        assert!(!store.set_draft_from_membership("room", "", Some("original")).unwrap());
        store.batch(&batch(room("5", "4", "rejoined"))).unwrap();
        assert_eq!(store.draft_from_membership("room", Some("rejoined")).unwrap(), "New draft");
        assert!(
            store.enqueue_from_membership("current-send", "room", "Current buffer", "alice", Some("rejoined")).unwrap()
        );
        assert_eq!(store.pending().unwrap()[0].id, "current-send");
    }
    #[test]
    fn unstamped_widgets_stay_usable_on_old_servers_but_cannot_write_after_learning_a_lifetime() {
        let store = NativeStore::open(Path::new(":memory:"), identity("epoch")).unwrap();
        let mut old = room("1", "2", "original");
        old.read_state = None;
        store.snapshot(&snapshot(old)).unwrap();
        assert!(store.set_draft_from_membership("room", "Legacy draft", None).unwrap());
        assert!(store.enqueue_from_membership("legacy-send", "room", "Legacy buffer", "alice", None).unwrap());
        store.snapshot(&snapshot(room("3", "4", "known"))).unwrap();
        assert!(!store.set_draft_from_membership("room", "Late legacy cleanup", None).unwrap());
        assert!(!store.enqueue_from_membership("late-send", "room", "Old buffer", "alice", None).unwrap());
        assert!(store.pending().unwrap().is_empty());
        assert_eq!(store.draft("room").unwrap(), "");
    }
}
