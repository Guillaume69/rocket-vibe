//! The room list as shown: sections, and finding people and channels.

use serde_json::Value;

use crate::store::RoomRow;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Section {
    Unread,
    Favorites,
    /// A sidebar category of my own (Mattermost).
    Group {
        id: String,
        name: String,
    },
    Channels,
    Direct,
}

impl Section {
    /// What the folded-sections file stores.
    pub fn key(&self) -> String {
        match self {
            Section::Unread => "unread".into(),
            Section::Favorites => "favorites".into(),
            Section::Group { id, .. } => format!("group:{id}"),
            Section::Channels => "channels".into(),
            Section::Direct => "direct".into(),
        }
    }

    fn default_rank(&self) -> i64 {
        match self {
            Section::Unread => -1,
            Section::Favorites => 0,
            Section::Channels => 1,
            Section::Direct => 2,
            Section::Group { .. } => 3,
        }
    }
}

/// Unread first, then the rooms I starred, then each category of my own, then
/// channels and groups, then direct messages; each keeps the list's order
/// (latest activity first), and empty sections are left out. After Unread,
/// the sections follow my sidebar order (`group_rank`) when the server has one.
pub fn sections(rooms: &[RoomRow]) -> Vec<(Section, Vec<RoomRow>)> {
    let unread = |r: &RoomRow| r.unread > 0 || r.alert;
    let mut out: Vec<(Section, i64, Vec<RoomRow>)> = Vec::new();
    for room in rooms.iter().filter(|r| !unread(r)) {
        let section = match (&room.group_id, &room.group_name) {
            _ if room.favorite => Section::Favorites,
            (Some(id), Some(name)) => Section::Group { id: id.clone(), name: name.clone() },
            _ if room.kind == "d" => Section::Direct,
            _ => Section::Channels,
        };
        let rank = room.group_rank.unwrap_or_else(|| section.default_rank());
        match out.iter_mut().find(|(s, ..)| *s == section) {
            Some((_, best, rows)) => {
                *best = (*best).min(rank);
                rows.push(room.clone());
            }
            None => out.push((section, rank, vec![room.clone()])),
        }
    }
    out.sort_by_key(|(section, rank, _)| (*rank, section.default_rank()));
    let first = (Section::Unread, rooms.iter().filter(|r| unread(r)).cloned().collect::<Vec<_>>());
    std::iter::once(first)
        .chain(out.into_iter().map(|(section, _, rows)| (section, rows)))
        .filter(|(_, rows)| !rows.is_empty())
        .collect()
}

/// Rooms with something unread: what the window title counts.
pub fn unread_rooms(rooms: &[RoomRow]) -> usize {
    rooms.iter().filter(|r| r.unread > 0 || r.alert).count()
}

/// What the app icon's badge counts: messages that call for me, mentions and
/// direct messages. Plain channel chatter only shows in the title.
pub fn attention(rooms: &[RoomRow]) -> i64 {
    rooms.iter().map(|r| if r.kind == "d" { r.unread } else { r.mentions }).sum()
}

/// What the app icon shows: the count of what calls for me, else a dot for
/// unread chatter, else nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Badge {
    None,
    Dot,
    Count(i64),
}

pub fn badge(rooms: &[RoomRow]) -> Badge {
    match attention(rooms) {
        0 if unread_rooms(rooms) > 0 => Badge::Dot,
        0 => Badge::None,
        n => Badge::Count(n),
    }
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
            last_encrypted: None,
            voice: false,
            ..Default::default()
        }
    }

    #[test]
    fn sections_in_order_without_empties() {
        let rooms = [room("a", "c", 0), room("b", "d", 2), room("c", "p", 0), room("d", "d", 0)];
        let s = sections(&rooms);
        let names: Vec<(Section, Vec<&str>)> =
            s.iter().map(|(k, rows)| (k.clone(), rows.iter().map(|r| r.rid.as_str()).collect())).collect();
        assert_eq!(
            names,
            [(Section::Unread, vec!["b"]), (Section::Channels, vec!["a", "c"]), (Section::Direct, vec!["d"])]
        );
        assert_eq!(sections(&[room("a", "c", 0)]).len(), 1);
        let mut starred = room("e", "d", 0);
        starred.favorite = true;
        let mut starred_unread = room("f", "c", 1);
        starred_unread.favorite = true;
        let kinds: Vec<(Section, usize)> =
            sections(&[starred, starred_unread, room("g", "c", 0)]).iter().map(|(k, r)| (k.clone(), r.len())).collect();
        assert_eq!(kinds, [(Section::Unread, 1), (Section::Favorites, 1), (Section::Channels, 1)]);
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

    #[test]
    fn attention_counts_direct_messages_and_mentions() {
        let mut channel = room("c1", "c", 5);
        channel.mentions = 2;
        let rooms = vec![channel, room("d1", "d", 3), room("c2", "c", 7)];
        assert_eq!(attention(&rooms), 5);
        assert_eq!(attention(&[]), 0);
    }

    #[test]
    fn the_badge_counts_what_calls_for_me_and_dots_the_rest() {
        let mut channel = room("c1", "c", 5);
        assert_eq!(badge(&[channel.clone()]), Badge::Dot);
        channel.mentions = 1;
        assert_eq!(badge(&[channel, room("d1", "d", 2)]), Badge::Count(3));
        let mut alerted = room("c2", "c", 0);
        alerted.alert = true;
        assert_eq!(badge(&[alerted]), Badge::Dot);
        assert_eq!(badge(&[room("c3", "c", 0)]), Badge::None);
    }
}
