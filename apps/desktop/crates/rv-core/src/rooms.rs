//! The room list as shown: sections, and finding people and channels.

use serde_json::Value;

use crate::store::RoomRow;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Unread,
    Channels,
    Direct,
}

/// Unread first, then channels and groups, then direct messages; each keeps
/// the list's order (latest activity first), and empty sections are left out.
pub fn sections(rooms: &[RoomRow]) -> Vec<(Section, Vec<RoomRow>)> {
    let unread = |r: &RoomRow| r.unread > 0 || r.alert;
    let pick = |f: &dyn Fn(&RoomRow) -> bool| rooms.iter().filter(|r| f(r)).cloned().collect::<Vec<_>>();
    [
        (Section::Unread, pick(&|r| unread(r))),
        (Section::Channels, pick(&|r| !unread(r) && r.kind != "d")),
        (Section::Direct, pick(&|r| !unread(r) && r.kind == "d")),
    ]
    .into_iter()
    .filter(|(_, rows)| !rows.is_empty())
    .collect()
}

/// Rooms with something unread: what the window title counts.
pub fn unread_rooms(rooms: &[RoomRow]) -> usize {
    rooms.iter().filter(|r| r.unread > 0 || r.alert).count()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Found {
    User { id: String, username: String, name: Option<String> },
    Room { id: String, name: String, kind: String },
}

/// `spotlight`: users first, then public rooms.
pub fn spotlight_results(response: &Value) -> Vec<Found> {
    let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let list = |k: &str| response.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let users = list("users").into_iter().filter_map(|u| {
        Some(Found::User { id: text(&u, "_id")?, username: text(&u, "username")?, name: text(&u, "name") })
    });
    let rooms = list("rooms").into_iter().filter_map(|r| {
        Some(Found::Room {
            id: text(&r, "_id")?,
            name: text(&r, "name")?,
            kind: text(&r, "t").unwrap_or_else(|| "c".to_owned()),
        })
    });
    users.chain(rooms).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn room(rid: &str, kind: &str, unread: i64) -> RoomRow {
        RoomRow {
            rid: rid.into(),
            kind: kind.into(),
            name: rid.into(),
            last_message: None,
            last_ts: 0,
            unread,
            mentions: 0,
            alert: false,
            favorite: false,
            encrypted: false,
            read_only: false,
            dm_other_uid: None,
            avatar_etag: None,
            slug: None,
            last_type: None,
            last_author: None,
        }
    }

    #[test]
    fn sections_in_order_without_empties() {
        let rooms = [room("a", "c", 0), room("b", "d", 2), room("c", "p", 0), room("d", "d", 0)];
        let s = sections(&rooms);
        let names: Vec<(Section, Vec<&str>)> =
            s.iter().map(|(k, rows)| (*k, rows.iter().map(|r| r.rid.as_str()).collect())).collect();
        assert_eq!(
            names,
            [(Section::Unread, vec!["b"]), (Section::Channels, vec!["a", "c"]), (Section::Direct, vec!["d"])]
        );
        assert_eq!(sections(&[room("a", "c", 0)]).len(), 1);
        assert_eq!(unread_rooms(&rooms), 1);
    }

    #[test]
    fn spotlight() {
        let found = spotlight_results(&json!({
            "users": [{"_id": "u1", "username": "bob", "name": "Bob"}, {"_id": "u2"}],
            "rooms": [{"_id": "r1", "name": "general", "t": "c"}]
        }));
        assert_eq!(
            found,
            [
                Found::User { id: "u1".into(), username: "bob".into(), name: Some("Bob".into()) },
                Found::Room { id: "r1".into(), name: "general".into(), kind: "c".into() }
            ]
        );
    }
}
