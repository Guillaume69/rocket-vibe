//! A button retry reuses the original operation after a lost HTTP confirmation.
//! Participant URLs and tokens never enter this table.
use super::*;
use rv_protocol::meetings::StartMeeting;

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
impl NativeStore {
    pub fn meeting_membership(&self, room: &str, membership: &str) -> rusqlite::Result<bool> {
        self.membership_matches_in(&self.conn.lock().unwrap(), room, Some(membership))
    }
    pub fn stage_meeting(&self, room: &str, input: StartMeeting) -> rusqlite::Result<StartMeeting> {
        if !identifier(room)
            || !identifier(&input.operation_id)
            || !identifier(&input.membership_version)
            || input.data_epoch != self.identity.data_epoch
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        self.atomic(|tx| {
            if !self.membership_matches_in(tx, room, Some(&input.membership_version))? {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let saved: Option<(String, String)> = tx
                .query_row("SELECT id,payload FROM native_meeting_intents WHERE rid=?1", [room], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            if let Some((id, payload)) = saved {
                if payload.len() > 4096 {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                let saved: StartMeeting = serde_json::from_str(&payload).map_err(|_| rusqlite::Error::InvalidQuery)?;
                if saved.operation_id != id
                    || !identifier(&id)
                    || saved.membership_version != input.membership_version
                    || saved.data_epoch != input.data_epoch
                {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                return Ok(saved);
            }
            tx.execute(
                "INSERT INTO native_meeting_intents VALUES(?1,?2,?3)",
                params![input.operation_id, room, json(&input)?],
            )?;
            Ok(input)
        })
    }
    pub fn acknowledge_meeting(&self, room: &str, input: &StartMeeting) -> rusqlite::Result<bool> {
        self.atomic(|tx| {
            if input.data_epoch != self.identity.data_epoch
                || !self.membership_matches_in(tx, room, Some(&input.membership_version))?
            {
                return Ok(false);
            }
            Ok(tx.execute(
                "DELETE FROM native_meeting_intents WHERE rid=?1 AND id=?2",
                params![room, input.operation_id],
            )? > 0)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(membership: &str, revision: &str) -> Snapshot {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../../../docs/protocol/v1.fixture.json")).unwrap();
        let mut room: Room = serde_json::from_value(fixture["parity"]["room_details"]["room"].clone()).unwrap();
        room.read_state = Some(Box::new(serde_json::from_value(serde_json::json!({
            "room_id":room.id,"membership_version":membership,"revision":revision,"root_position":"0","reply_position":"0",
            "unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false
        })).unwrap()));
        Snapshot { protocol_version: 1, rooms: vec![room], messages: vec![], cursor: "initial".into() }
    }
    fn input(id: &str, membership: &str) -> StartMeeting {
        StartMeeting { operation_id: id.into(), membership_version: membership.into(), data_epoch: "epoch".into() }
    }
    #[test]
    fn retry_survives_reopen_and_acknowledgement_cannot_delete_a_new_intent() {
        let path = std::env::temp_dir().join(format!("rv-meeting-{:032x}.sqlite", fastrand::u128(..)));
        let identity = Identity { instance_id: "instance".into(), data_epoch: "epoch".into() };
        let state = snapshot("grant", "1");
        let room = &state.rooms[0].id;
        let store = NativeStore::open(&path, identity.clone()).unwrap();
        store.snapshot(&state).unwrap();
        store.stage_meeting(room, input("original", "grant")).unwrap();
        drop(store);
        let store = NativeStore::open(&path, identity).unwrap();
        let replay = store.stage_meeting(room, input("replacement", "grant")).unwrap();
        assert_eq!(replay.operation_id, "original");
        assert!(store.acknowledge_meeting(room, &replay).unwrap());
        store.stage_meeting(room, input("next", "grant")).unwrap();
        assert!(!store.acknowledge_meeting(room, &replay).unwrap());
        assert_eq!(store.stage_meeting(room, input("other", "grant")).unwrap().operation_id, "next");
        drop(store);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn rejoin_and_clear_purge_intents() {
        let store = NativeStore::open(
            Path::new(":memory:"),
            Identity { instance_id: "instance".into(), data_epoch: "epoch".into() },
        )
        .unwrap();
        let state = snapshot("grant", "1");
        let room = &state.rooms[0].id;
        store.snapshot(&state).unwrap();
        let old = store.stage_meeting(room, input("old", "grant")).unwrap();
        store.snapshot(&snapshot("rejoined", "2")).unwrap();
        assert!(store.stage_meeting(room, input("late", "grant")).is_err());
        assert!(!store.acknowledge_meeting(room, &old).unwrap());
        assert_eq!(store.stage_meeting(room, input("new", "rejoined")).unwrap().operation_id, "new");
        store.clear().unwrap();
        store.snapshot(&snapshot("rejoined", "2")).unwrap();
        assert_eq!(store.stage_meeting(room, input("fresh", "rejoined")).unwrap().operation_id, "fresh");
    }
}
