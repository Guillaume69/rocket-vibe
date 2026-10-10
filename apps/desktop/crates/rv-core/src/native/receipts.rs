//! Read receipts (brain/features/read-receipts.md): "Seen" or "Seen by …"
//! under my latest message of a room's main timeline, from the other
//! members' read positions in the live frame (`LiveRoom.reads`). Never in
//! an encrypted room, never in a thread.
use super::{NativeSession, store::MessageRow};
use crate::i18n::{t, tf, tn};
use crate::timeline::Display;
use rv_protocol::live::ReadMark;
use std::cmp::Ordering;

/// What the rule needs of a timeline message.
#[derive(Debug, Clone, Copy)]
pub struct Candidate<'a> {
    pub id: &'a str,
    pub author_id: &'a str,
    /// The server's position: None while the message is not confirmed.
    pub position: Option<&'a str>,
    /// A system message (a call, a rename…), not someone's words.
    pub system: bool,
    /// A thread reply.
    pub reply: bool,
    /// Still in the outbox (sending or failed).
    pub pending: bool,
}
impl<'a> From<&'a MessageRow> for Candidate<'a> {
    fn from(row: &'a MessageRow) -> Self {
        Candidate {
            id: &row.id,
            author_id: &row.author_id,
            position: row.position.as_deref(),
            system: row.system_type.is_some(),
            reply: row.reply_to.is_some(),
            pending: row.status.is_some(),
        }
    }
}

/// The line and the message it goes under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub message_id: String,
    pub text: String,
}

/// Positions are decimal strings compared as numbers: the longer is greater,
/// equal lengths compare as text.
pub fn compare(a: &str, b: &str) -> Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

fn decimal(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

/// My most recent root message, confirmed by the server, not a system one.
pub fn latest_own<'a>(rows: impl IntoIterator<Item = Candidate<'a>>, me: &str) -> Option<Candidate<'a>> {
    rows.into_iter()
        .filter(|c| c.author_id == me && !c.system && !c.reply && !c.pending && c.position.is_some_and(decimal))
        .max_by(|a, b| compare(a.position.unwrap_or_default(), b.position.unwrap_or_default()))
}

/// The marks at or past `position`, each reader once, never me.
pub fn readers<'a>(position: &str, reads: &'a [ReadMark], me: &str) -> Vec<&'a ReadMark> {
    let mut seen = std::collections::HashSet::new();
    reads
        .iter()
        .filter(|m| m.user_id != me && decimal(&m.root_position))
        .filter(|m| compare(&m.root_position, position) != Ordering::Less)
        .filter(|m| seen.insert(m.user_id.as_str()))
        .collect()
}

/// "Seen" in a direct room; else "Seen by" and up to three names, then
/// "and 1 other" / "and N others". `names` holds each reader's name, None
/// when unknown: such a reader is counted among the others, and with no
/// name known at all the line is "Seen". None without a reader.
pub fn line(direct: bool, names: &[Option<String>]) -> Option<String> {
    if names.is_empty() {
        return None;
    }
    let shown: Vec<&str> = names.iter().flatten().map(String::as_str).take(3).collect();
    if direct || shown.is_empty() {
        return Some(t("receipts.seen").to_owned());
    }
    let others = (names.len() - shown.len()) as i64;
    let listed = shown.join(", ");
    Some(match others {
        0 => tf("receipts.seen_by", &[("names", &listed)]),
        n => tf("receipts.seen_by", &[("names", &tn("receipts.and_others", n).replace("{names}", &listed))]),
    })
}

/// The whole rule: my latest message, its readers, the line. `name` gives a
/// reader's display name, else username, None when unknown.
pub fn receipt<'a>(
    rows: impl IntoIterator<Item = Candidate<'a>>,
    me: &str,
    reads: &[ReadMark],
    direct: bool,
    name: impl Fn(&str) -> Option<String>,
) -> Option<Receipt> {
    let mine = latest_own(rows, me)?;
    let readers = readers(mine.position?, reads, me);
    let names: Vec<Option<String>> = readers.iter().map(|m| name(&m.user_id)).collect();
    Some(Receipt { message_id: mine.id.to_owned(), text: line(direct, &names)? })
}

/// Puts the line on its message's row, and takes it off every other.
pub fn place(display: &mut [Display], receipt: Option<&Receipt>) {
    for row in display {
        row.seen = receipt.filter(|r| r.message_id == row.row.id).map(|r| r.text.clone());
    }
}

/// A display name, else the username; None when both are empty.
fn label(user: &rv_protocol::User) -> Option<String> {
    [&user.display_name, &user.username].into_iter().map(|s| s.trim()).find(|s| !s.is_empty()).map(str::to_owned)
}

impl NativeSession {
    /// The read receipt of a room's main timeline (`rows`, in any order), from
    /// the live frame while it is fresh and of the room's current membership.
    /// None in an encrypted room.
    pub fn read_receipt<'a>(&self, room: &str, rows: impl IntoIterator<Item = Candidate<'a>>) -> Option<Receipt> {
        if !matches!(self.store.room_encrypted(room), Ok(false)) {
            return None;
        }
        let (reads, profiles) = {
            let cache = self.live.lock().unwrap();
            let (reads, membership, profiles) = cache.reads(room, std::time::Instant::now())?;
            let current = self.store.read_state(room).ok().flatten().and_then(|s| s.membership_version);
            if current.as_deref() != Some(membership.as_str()) {
                return None;
            }
            (reads, profiles)
        };
        if reads.is_empty() {
            return None;
        }
        let direct = self.store.room_direct(room).unwrap_or(false);
        receipt(rows, &self.info.user_id, &reads, direct, |uid| {
            profiles
                .iter()
                .find(|u| u.id == uid)
                .and_then(label)
                .or_else(|| self.store.profile_identity(uid).ok().flatten().and_then(|p| label(&p.user)))
        })
    }
    /// A room's main timeline: the rows grouped (`read_presentation::group`)
    /// with the read receipt under my latest message.
    pub fn timeline(&self, rows: Vec<MessageRow>, room: &str, after: Option<&str>) -> Vec<Display> {
        let receipt = self.read_receipt(room, rows.iter().map(Candidate::from));
        let mut display = super::read_presentation::group(rows, room, &self.info.user_id, after);
        place(&mut display, receipt.as_ref());
        display
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{LANGUAGE, Lang, set};

    fn row<'a>(id: &'a str, author: &'a str, position: Option<&'a str>) -> Candidate<'a> {
        Candidate { id, author_id: author, position, system: false, reply: false, pending: false }
    }
    fn mark(user: &str, position: &str) -> ReadMark {
        ReadMark { user_id: user.into(), root_position: position.into() }
    }
    fn names(list: &[&str]) -> Vec<Option<String>> {
        list.iter().map(|n| Some(n.to_string())).collect()
    }

    #[test]
    fn positions_compare_as_numbers() {
        assert_eq!(compare("10", "9"), Ordering::Greater);
        assert_eq!(compare("9", "10"), Ordering::Less);
        assert_eq!(compare("12", "12"), Ordering::Equal);
        assert_eq!(compare("9007199254740993", "9007199254740992"), Ordering::Greater);
    }

    #[test]
    fn my_latest_root_message_skips_others_system_replies_and_unconfirmed() {
        let rows = vec![
            row("old", "me", Some("9")),
            row("mine", "me", Some("10")),
            row("theirs", "bob", Some("11")),
            Candidate { system: true, ..row("call", "me", Some("12")) },
            Candidate { reply: true, ..row("reply", "me", Some("13")) },
            Candidate { pending: true, ..row("queued", "me", None) },
            row("unconfirmed", "me", None),
        ];
        assert_eq!(latest_own(rows.clone(), "me").map(|c| c.id), Some("mine"));
        // Order does not matter: the position decides.
        assert_eq!(latest_own(rows.into_iter().rev(), "me").map(|c| c.id), Some("mine"));
        assert!(latest_own(vec![row("theirs", "bob", Some("1"))], "me").is_none());
    }

    #[test]
    fn readers_are_the_marks_at_or_past_the_message() {
        let reads = vec![mark("bob", "10"), mark("carol", "9"), mark("dan", "100"), mark("me", "10")];
        let found: Vec<_> = readers("10", &reads, "me").iter().map(|m| m.user_id.as_str()).collect();
        assert_eq!(found, ["bob", "dan"]);
        assert!(readers("101", &reads, "me").is_empty());
    }

    #[test]
    fn the_line_says_seen_in_a_direct_room_and_names_up_to_three_in_a_group() {
        let _serial = LANGUAGE.lock().unwrap();
        set(Lang::En);
        assert_eq!(line(true, &[]), None);
        assert_eq!(line(false, &[]), None);
        assert_eq!(line(true, &names(&["Bob"])).as_deref(), Some("Seen"));
        assert_eq!(line(false, &names(&["Bob"])).as_deref(), Some("Seen by Bob"));
        assert_eq!(line(false, &names(&["Bob", "Carol"])).as_deref(), Some("Seen by Bob, Carol"));
        assert_eq!(line(false, &names(&["Bob", "Carol", "Dan"])).as_deref(), Some("Seen by Bob, Carol, Dan"));
        assert_eq!(
            line(false, &names(&["Bob", "Carol", "Dan", "Eve", "Fay"])).as_deref(),
            Some("Seen by Bob, Carol, Dan and 2 others")
        );
        assert_eq!(
            line(false, &names(&["Bob", "Carol", "Dan", "Eve"])).as_deref(),
            Some("Seen by Bob, Carol, Dan and 1 other")
        );
        assert_eq!(line(false, &[None, Some("Bob".into())]).as_deref(), Some("Seen by Bob and 1 other"));
        assert_eq!(line(false, &[None, None]).as_deref(), Some("Seen"));
        set(Lang::Fr);
        assert_eq!(line(true, &names(&["Bob"])).as_deref(), Some("Vu"));
        assert_eq!(line(false, &[None]).as_deref(), Some("Vu"));
        assert_eq!(
            line(false, &names(&["Bob", "Carol", "Dan", "Eve"])).as_deref(),
            Some("Vu par Bob, Carol, Dan et 1 autre")
        );
        assert_eq!(
            line(false, &names(&["Bob", "Carol", "Dan", "Eve", "Fay"])).as_deref(),
            Some("Vu par Bob, Carol, Dan et 2 autres")
        );
        set(Lang::En);
    }

    #[test]
    fn the_receipt_goes_under_my_latest_message_only() {
        let _serial = LANGUAGE.lock().unwrap();
        set(Lang::En);
        let rows = vec![row("old", "me", Some("5")), row("mine", "me", Some("10")), row("theirs", "bob", Some("11"))];
        let name = |uid: &str| match uid {
            "bob" => Some("Bob".to_owned()),
            "carol" => Some("Carol".to_owned()),
            _ => None,
        };
        // Bob read past my message, Carol stopped before it.
        let reads = vec![mark("bob", "11"), mark("carol", "7")];
        let found = receipt(rows.clone(), "me", &reads, false, name).unwrap();
        assert_eq!(found, Receipt { message_id: "mine".into(), text: "Seen by Bob".into() });
        assert_eq!(receipt(rows.clone(), "me", &reads, true, name).unwrap().text, "Seen");
        // Nobody reached it: nothing, not even under the older message.
        assert_eq!(receipt(rows.clone(), "me", &[mark("carol", "7")], false, name), None);
        assert_eq!(receipt(rows, "me", &[], false, name), None);
        let mut display: Vec<Display> = ["old", "mine"]
            .into_iter()
            .map(|id| Display {
                row: crate::store::MessageRow { id: id.into(), ..Default::default() },
                ..Default::default()
            })
            .collect();
        display[0].seen = Some("stale".into());
        place(&mut display, Some(&found));
        assert_eq!(display.iter().map(|d| d.seen.as_deref()).collect::<Vec<_>>(), [None, Some("Seen by Bob")]);
        place(&mut display, None);
        assert!(display.iter().all(|d| d.seen.is_none()));
    }

    #[tokio::test]
    async fn the_session_reads_the_live_frame_for_the_current_membership_only() {
        let _serial = LANGUAGE.lock().unwrap();
        set(Lang::En);
        let f: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
        let info = crate::session::SessionInfo {
            mattermost: None,
            base_url: "http://127.0.0.1:9/native".into(),
            user_id: "me-id".into(),
            username: "me".into(),
            auth_token: "fixture-token".into(),
            native: Some(super::super::Identity {
                instance_id: "fixture-instance".into(),
                data_epoch: "fixture-epoch".into(),
            }),
        };
        let s = NativeSession::start(info, std::path::Path::new(":memory:")).unwrap();
        s.suspend();
        let mut room: rv_protocol::Room = serde_json::from_value(f["room"].clone()).unwrap();
        room.read_state = Some(Box::new(serde_json::from_value(serde_json::json!({"room_id":room.id,"membership_version":"grant","revision":"1","root_position":"0","reply_position":"0","unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false})).unwrap()));
        let message = |id: &str, author: &str, position: &str| {
            let mut m: rv_protocol::Message = serde_json::from_value(f["message"].clone()).unwrap();
            (m.id, m.author.id, m.position, m.revision) = (id.into(), author.into(), position.into(), position.into());
            m
        };
        let snapshot = |room: &rv_protocol::Room| rv_protocol::Snapshot {
            protocol_version: 1,
            rooms: vec![room.clone()],
            messages: vec![
                message("first", "me-id", "10"),
                message("second", "me-id", "11"),
                message("theirs", "alice-id", "12"),
            ],
            cursor: "initial".into(),
        };
        s.store.snapshot(&snapshot(&room)).unwrap();
        let user = |id: &str, name: &str| rv_protocol::User {
            id: id.into(),
            username: name.to_lowercase(),
            display_name: name.into(),
            ..Default::default()
        };
        let mut frame = rv_protocol::live::LiveState {
            emoji_catalog_revision: None,
            profiles: vec![rv_protocol::profiles::ProfileStamp {
                user: user("carol-id", "Carol"),
                revision: "1".into(),
                avatar_file_id: None,
                status_text: String::new(),
            }],
            ttl_ms: 8000,
            limited: false,
            presence: vec![],
            rooms: vec![rv_protocol::live::LiveRoom {
                room_id: room.id.clone(),
                membership_version: "grant".into(),
                direct_peer: None,
                typing: vec![],
                voice: vec![],
                reads: vec![mark("carol-id", "11"), mark("dan-id", "10")],
            }],
            rings: vec![],
        };
        let shown = |s: &NativeSession| {
            s.timeline(s.store.messages(&room.id, 50).unwrap(), &room.id, None)
                .into_iter()
                .filter_map(|d| d.seen.map(|seen| (d.row.id, seen)))
                .collect::<Vec<_>>()
        };
        assert!(shown(&s).is_empty(), "no frame, no line");
        s.live.lock().unwrap().apply(frame.clone(), std::time::Instant::now());
        // Dan read only my older message, and has no name: Carol alone.
        assert_eq!(shown(&s), [("second".to_owned(), "Seen by Carol".to_owned())]);
        frame.rooms[0].reads = vec![mark("carol-id", "12"), mark("dan-id", "11")];
        s.live.lock().unwrap().apply(frame.clone(), std::time::Instant::now());
        assert_eq!(shown(&s), [("second".to_owned(), "Seen by Carol and 1 other".to_owned())]);
        // A frame of another membership is not this room's any more.
        frame.rooms[0].membership_version = "old-grant".into();
        s.live.lock().unwrap().apply(frame.clone(), std::time::Instant::now());
        assert!(shown(&s).is_empty());
        frame.rooms[0].membership_version = "grant".into();
        room.kind = rv_protocol::RoomKind::Direct;
        s.store.snapshot(&snapshot(&room)).unwrap();
        assert!(s.store.room_direct(&room.id).unwrap());
        s.live.lock().unwrap().apply(frame.clone(), std::time::Instant::now());
        assert_eq!(shown(&s), [("second".to_owned(), "Seen".to_owned())]);
        // Never in an encrypted room.
        room.encrypted = true;
        s.store.snapshot(&snapshot(&room)).unwrap();
        s.live.lock().unwrap().apply(frame, std::time::Instant::now());
        assert!(shown(&s).is_empty());
        s.shutdown();
    }
}
