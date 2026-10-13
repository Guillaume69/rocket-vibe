//! The Activity view: what concerns me across an account's rooms, read from
//! the messages already stored (no server call). Mentions of me, replies in
//! threads I take part in, and my messages others reacted to, newest first,
//! one item per message; then the rooms whose server counts unread mentions
//! the device holds no message for. Each store gives its candidates
//! (`Store::activity_candidates`, `NativeStore::activity_candidates`) and the
//! threads I take part in; `gather` decides. The desktop merges every
//! signed-in account (`merge`).

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::store::{MessageRow, RoomRow};

/// Items an account's activity keeps, and the merged view too.
pub const LIMIT: usize = 100;
/// The newest stored messages read to find them.
pub const CANDIDATES: i64 = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Someone else's message naming me, `@all` or `@here`.
    Mention,
    /// Someone else's reply in a thread I wrote, replied in or follow.
    Reply,
    /// My message, which someone else reacted to.
    Reaction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub kind: Kind,
    /// The room's shown name.
    pub room: String,
    pub message: MessageRow,
    /// The author as the account names people (`Session::person_label`:
    /// Rocket.Chat real names, Mattermost display names); None: the username.
    pub author_label: Option<String>,
    /// For a reaction: who reacted (not me), in order, once each; usernames
    /// from `gather`, shown names once the session names them.
    pub reactors: Vec<String>,
    /// For a reaction: the emojis they used, as shortcodes (`:+1:`).
    pub emojis: Vec<String>,
}

/// A room where the server counts unread mentions of me that no stored
/// message shows (a room never opened on this device).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomMentions {
    pub rid: String,
    pub room: String,
    pub count: i64,
    pub last_ts: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Activity {
    pub rooms: Vec<RoomMentions>,
    pub items: Vec<Item>,
}

/// The account the activity is read for.
#[derive(Debug, Clone, Copy)]
pub struct Me<'a> {
    pub id: &'a str,
    pub username: &'a str,
}

/// The activity from an account's candidate rows (any order), the thread
/// roots I take part in, and its rooms (names and mention counters).
/// Messages of rooms no longer listed are left out.
pub fn gather(rows: Vec<MessageRow>, me: Me<'_>, my_threads: &HashSet<String>, rooms: &[RoomRow]) -> Activity {
    let names: HashMap<&str, &str> = rooms.iter().map(|r| (r.rid.as_str(), r.name.as_str())).collect();
    let mut items: Vec<Item> = rows
        .into_iter()
        .filter_map(|message| {
            let room = (*names.get(message.rid.as_str())?).to_owned();
            // An attachment alone has no words but counts; an encrypted
            // message counts once opened, a system message never.
            let readable = match message.system_type.as_deref() {
                None => true,
                Some("e2e") => message.text.is_some(),
                Some(_) => false,
            };
            if !readable {
                return None;
            }
            let mine = message.author_id == me.id;
            if !mine {
                // RocketVibe's tree renders `@here` as text: the words count too.
                let text = message.text.as_deref();
                let mentioned = crate::notify::mentions(message.md.as_deref(), text, me.username)
                    || crate::notify::names_in_text(text, &["all", "here"]);
                let kind = if mentioned {
                    Kind::Mention
                } else if message.thread_id.as_ref().is_some_and(|root| my_threads.contains(root)) {
                    Kind::Reply
                } else {
                    return None;
                };
                return Some(Item {
                    kind,
                    room,
                    message,
                    author_label: None,
                    reactors: Vec::new(),
                    emojis: Vec::new(),
                });
            }
            let (reactors, emojis) = others_reactions(message.reactions.as_deref(), me.username);
            (!reactors.is_empty()).then_some(Item {
                kind: Kind::Reaction,
                room,
                message,
                author_label: None,
                reactors,
                emojis,
            })
        })
        .collect();
    items.sort_by(|a, b| (b.message.ts, &b.message.id).cmp(&(a.message.ts, &a.message.id)));
    items.dedup_by(|a, b| a.message.id == b.message.id);
    items.truncate(LIMIT);
    // A room counts more unread mentions than the list shows: an old, read
    // mention listed there must not hide the new ones.
    let mut listed: HashMap<&str, i64> = HashMap::new();
    for item in items.iter().filter(|i| i.kind == Kind::Mention) {
        *listed.entry(item.message.rid.as_str()).or_default() += 1;
    }
    let mut unseen: Vec<RoomMentions> = rooms
        .iter()
        .filter(|r| r.mentions > listed.get(r.rid.as_str()).copied().unwrap_or(0))
        .map(|r| RoomMentions { rid: r.rid.clone(), room: r.name.clone(), count: r.mentions, last_ts: r.last_ts })
        .collect();
    unseen.sort_by_key(|r| std::cmp::Reverse(r.last_ts));
    Activity { rooms: unseen, items }
}

/// Who besides me reacted (once each, in order) and with which emojis, from
/// `{":smile:": {"usernames": [...]}}`.
fn others_reactions(json: Option<&str>, me: &str) -> (Vec<String>, Vec<String>) {
    let Some(map) = json.and_then(|j| serde_json::from_str::<serde_json::Map<String, Value>>(j).ok()) else {
        return (Vec::new(), Vec::new());
    };
    let (mut reactors, mut emojis) = (Vec::<String>::new(), Vec::new());
    for (shortcode, entry) in map {
        let others: Vec<&str> = entry
            .get("usernames")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|u| *u != me)
            .collect();
        if others.is_empty() {
            continue;
        }
        emojis.push(shortcode);
        for user in others {
            if !reactors.iter().any(|r| r == user) {
                reactors.push(user.to_owned());
            }
        }
    }
    (reactors, emojis)
}

/// The real names Rocket.Chat stores beside a reaction's usernames
/// (`{":e:": {"usernames": [...], "names": [...]}}`, in the same order, sent
/// when the server shows real names), by username.
pub fn reaction_names(json: Option<&str>) -> HashMap<String, String> {
    let Some(map) = json.and_then(|j| serde_json::from_str::<serde_json::Map<String, Value>>(j).ok()) else {
        return HashMap::new();
    };
    let list = |entry: &Value, key: &str| -> Vec<String> {
        entry
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    map.values()
        .flat_map(|entry| list(entry, "usernames").into_iter().zip(list(entry, "names")))
        .filter(|(_, name)| !name.is_empty())
        .collect()
}

/// Several accounts' activities as one view, each room and item with its
/// account's `K`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged<K> {
    pub rooms: Vec<(K, RoomMentions)>,
    pub items: Vec<(K, Item)>,
    /// More than one account has something: each entry names its server.
    pub several: bool,
}

/// The rooms of every account, then every item newest first, `LIMIT` at most.
pub fn merge<K: Clone>(accounts: Vec<(K, Activity)>) -> Merged<K> {
    let mut rooms = Vec::new();
    let mut items = Vec::new();
    let mut speaking = 0;
    for (key, activity) in accounts {
        speaking += usize::from(!activity.rooms.is_empty() || !activity.items.is_empty());
        rooms.extend(activity.rooms.into_iter().map(|r| (key.clone(), r)));
        items.extend(activity.items.into_iter().map(|i| (key.clone(), i)));
    }
    rooms.sort_by_key(|(_, r)| std::cmp::Reverse(r.last_ts));
    items.sort_by(|(_, a), (_, b)| (b.message.ts, &b.message.id).cmp(&(a.message.ts, &a.message.id)));
    items.truncate(LIMIT);
    Merged { rooms, items, several: speaking > 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: Me<'static> = Me { id: "u-me", username: "me" };

    fn room(rid: &str, mentions: i64, last_ts: i64) -> RoomRow {
        RoomRow { rid: rid.into(), name: format!("#{rid}"), mentions, last_ts, ..Default::default() }
    }

    fn message(id: &str, rid: &str, ts: i64, author: &str, text: &str) -> MessageRow {
        MessageRow {
            id: id.into(),
            rid: rid.into(),
            ts,
            text: Some(text.into()),
            author: Some(author.into()),
            author_id: if author == "me" { "u-me".into() } else { format!("u-{author}") },
            ..Default::default()
        }
    }

    fn mention_md(username: &str) -> String {
        format!(
            r#"[{{"type":"PARAGRAPH","value":[{{"type":"MENTION_USER","value":{{"type":"PLAIN_TEXT","value":"{username}"}}}}]}}]"#
        )
    }

    #[test]
    fn mentions_come_from_the_markdown_else_the_text() {
        let rooms = [room("c1", 0, 1)];
        let mut by_md = message("m1", "c1", 10, "bob", "hey me");
        by_md.md = Some(mention_md("me"));
        let mut other_md = message("m2", "c1", 11, "bob", "@me in code");
        other_md.md = Some(mention_md("carol"));
        let plain = message("m3", "c1", 12, "bob", "ping @me, please");
        let all = message("m4", "c1", 13, "bob", "@here meeting");
        let near = message("m5", "c1", 14, "bob", "@meeting at 3");
        let activity = gather(vec![by_md, other_md, plain, all, near], ME, &HashSet::new(), &rooms);
        let ids: Vec<&str> = activity.items.iter().map(|i| i.message.id.as_str()).collect();
        assert_eq!(ids, ["m4", "m3", "m1"]);
        assert!(activity.items.iter().all(|i| i.kind == Kind::Mention && i.room == "#c1"));
    }

    #[test]
    fn replies_count_in_my_threads_and_a_mention_wins() {
        let rooms = [room("c1", 0, 1)];
        let mut reply = message("r1", "c1", 20, "bob", "agreed");
        reply.thread_id = Some("root-mine".into());
        let mut elsewhere = message("r2", "c1", 21, "bob", "not mine");
        elsewhere.thread_id = Some("root-other".into());
        let mut both = message("r3", "c1", 22, "bob", "@me see this");
        both.thread_id = Some("root-mine".into());
        let mut my_reply = message("r4", "c1", 23, "me", "my own reply");
        my_reply.thread_id = Some("root-mine".into());
        let threads = HashSet::from(["root-mine".to_owned()]);
        let activity = gather(vec![reply, elsewhere, both, my_reply], ME, &threads, &rooms);
        let kinds: Vec<(&str, Kind)> = activity.items.iter().map(|i| (i.message.id.as_str(), i.kind)).collect();
        assert_eq!(kinds, [("r3", Kind::Mention), ("r1", Kind::Reply)]);
    }

    #[test]
    fn my_messages_show_others_reactions_only() {
        let rooms = [room("c1", 0, 1)];
        let mut liked = message("a1", "c1", 30, "me", "shipped");
        liked.reactions = Some(r#"{":+1:":{"usernames":["bob","me"]},":tada:":{"usernames":["carol","bob"]},":eyes:":{"usernames":["me"]}}"#.into());
        let mut self_only = message("a2", "c1", 31, "me", "note");
        self_only.reactions = Some(r#"{":+1:":{"usernames":["me"]}}"#.into());
        let mut theirs = message("a3", "c1", 32, "bob", "their message");
        theirs.reactions = Some(r#"{":+1:":{"usernames":["carol"]}}"#.into());
        let activity = gather(vec![liked, self_only, theirs], ME, &HashSet::new(), &rooms);
        assert_eq!(activity.items.len(), 1);
        let item = &activity.items[0];
        assert_eq!(
            (item.kind, item.reactors.clone(), item.emojis.clone()),
            (Kind::Reaction, vec!["bob".to_owned(), "carol".to_owned()], vec![":+1:".to_owned(), ":tada:".to_owned()])
        );
    }

    #[test]
    fn reaction_names_pair_with_their_usernames() {
        let json = r#"{":+1:":{"usernames":["bob","carol"],"names":["Bob Lee","Carol"]},":tada:":{"usernames":["dan"]},":eyes:":{"usernames":["eve"],"names":[""]}}"#;
        let names = reaction_names(Some(json));
        assert_eq!(names.get("bob").map(String::as_str), Some("Bob Lee"));
        assert_eq!(names.get("carol").map(String::as_str), Some("Carol"));
        assert_eq!((names.get("dan"), names.get("eve")), (None, None), "no name, or an empty one");
        assert!(reaction_names(Some("not json")).is_empty());
    }

    #[test]
    fn unreadable_system_and_unlisted_messages_are_left_out() {
        let rooms = [room("c1", 0, 1)];
        let mut locked = message("x1", "c1", 40, "bob", "");
        locked.text = None;
        locked.system_type = Some("e2e".into());
        let mut opened = message("x2", "c1", 41, "bob", "@me secret");
        opened.system_type = Some("e2e".into());
        let mut joined = message("x3", "c1", 42, "bob", "@me");
        joined.system_type = Some("uj".into());
        let left = message("x4", "gone", 43, "bob", "@me");
        let activity = gather(vec![locked, opened, joined, left], ME, &HashSet::new(), &rooms);
        assert_eq!(activity.items.iter().map(|i| i.message.id.as_str()).collect::<Vec<_>>(), ["x2"]);
    }

    #[test]
    fn rooms_with_more_unread_mentions_than_listed_show() {
        let rooms = [
            room("seen", 1, 5),
            room("unseen", 3, 9),
            room("older", 1, 7),
            room("quiet", 0, 10),
            // One old, read mention listed; three new ones the device lacks.
            room("behind", 3, 8),
        ];
        let rows = vec![message("m1", "seen", 1, "bob", "@me"), message("m2", "behind", 2, "bob", "@me")];
        let activity = gather(rows, ME, &HashSet::new(), &rooms);
        let shown: Vec<(&str, i64)> = activity.rooms.iter().map(|r| (r.rid.as_str(), r.count)).collect();
        assert_eq!(shown, [("unseen", 3), ("behind", 3), ("older", 1)]);
    }

    #[test]
    fn attachments_alone_count_and_here_written_as_text_mentions() {
        let rooms = [room("c1", 0, 1)];
        let mut photo = message("p1", "c1", 50, "me", "");
        photo.text = None;
        photo.reactions = Some(r#"{":+1:":{"usernames":["bob"]}}"#.into());
        let mut file_reply = message("p2", "c1", 51, "bob", "");
        file_reply.text = None;
        file_reply.thread_id = Some("root-mine".into());
        // A RocketVibe tree: `@here` came out as plain text.
        let mut here = message("p3", "c1", 52, "bob", "@here standup");
        here.md = Some(r#"[{"type":"PARAGRAPH","value":[{"type":"PLAIN_TEXT","value":"@here standup"}]}]"#.into());
        let threads = HashSet::from(["root-mine".to_owned()]);
        let activity = gather(vec![photo, file_reply, here], ME, &threads, &rooms);
        let kinds: Vec<(&str, Kind)> = activity.items.iter().map(|i| (i.message.id.as_str(), i.kind)).collect();
        assert_eq!(kinds, [("p3", Kind::Mention), ("p2", Kind::Reply), ("p1", Kind::Reaction)]);
    }

    #[test]
    fn at_most_a_hundred_items_newest_first_across_accounts() {
        let rooms = [room("c1", 0, 1)];
        let rows = (0..150).map(|i| message(&format!("m{i}"), "c1", i, "bob", "@me")).collect();
        let first = gather(rows, ME, &HashSet::new(), &rooms);
        assert_eq!((first.items.len(), first.items[0].message.ts), (LIMIT, 149));
        let second =
            gather(vec![message("late", "c1", 1000, "bob", "@here")], ME, &HashSet::new(), &[room("c1", 1, 2)]);
        let Merged { rooms, items, several } = merge(vec![("a", first), ("b", second), ("c", Activity::default())]);
        assert_eq!((items.len(), items[0].0, items[0].1.message.id.as_str()), (LIMIT, "b", "late"));
        assert!(rooms.is_empty(), "b's one mention is listed");
        assert!(several, "a and b have something; c has nothing");
        assert!(!merge(vec![("a", Activity::default()), ("b", second_only())]).several);
    }

    fn second_only() -> Activity {
        gather(vec![message("only", "c1", 1, "bob", "@me")], ME, &HashSet::new(), &[room("c1", 0, 1)])
    }
}
