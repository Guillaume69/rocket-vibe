//! The Rocket.Chat → RocketVibe mapping rules that need no database
//! (docs/protocol/IMPORT.md, "Mapping").
use rv_protocol::{User, parity::RoomRole, system::SystemMessage};
use std::collections::HashSet;

use crate::auth::identifier;

/// A username as the native server accepts it: anything outside
/// `[A-Za-z0-9_-]` becomes `_`, and one already taken gets `-2`, `-3`…
pub fn username(source: &str, taken: &mut HashSet<String>) -> String {
    let mut base: String = source
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    base.truncate(120);
    if base.is_empty() {
        base = "user".into();
    }
    let mut name = base.clone();
    let mut n = 2;
    while !taken.insert(name.to_lowercase()) {
        name = format!("{base}-{n}");
        n += 1;
    }
    name
}

/// A Rocket.Chat id kept when it is a native identifier.
pub fn id(source: &str) -> Option<&str> {
    identifier(source).then_some(source)
}

/// Text cut to `max` bytes on a character boundary; whether it was cut.
pub fn truncate(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.into(), false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].into(), true)
}

/// A display name the server accepts: trimmed, no control characters, at
/// most 256 bytes, the username when nothing is left.
pub fn display_name(name: Option<&str>, username: &str) -> String {
    let clean: String = name
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let (clean, _) = truncate(clean.trim(), 256);
    let clean = clean.trim().to_owned();
    if clean.is_empty() {
        username.into()
    } else {
        clean
    }
}

/// A room name the server accepts: trimmed, no control characters, at most
/// 128 bytes.
pub fn room_name(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !c.is_control()).collect();
    let (clean, _) = truncate(clean.trim(), 128);
    let clean = clean.trim().to_owned();
    if clean.is_empty() {
        "room".into()
    } else {
        clean
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoomKind {
    Public,
    Private,
    Direct,
}

/// What becomes of a room; `Err` is the reason it is skipped.
pub fn room_kind(t: &str, encrypted: bool, members: &[&str]) -> Result<RoomKind, &'static str> {
    if encrypted {
        return Err("encrypted_room");
    }
    match t {
        "c" => Ok(RoomKind::Public),
        "p" => Ok(RoomKind::Private),
        "d" if members.contains(&"rocket.cat") => Err("bot_direct_room"),
        "d" => match members.iter().collect::<HashSet<_>>().len() {
            2 => Ok(RoomKind::Direct),
            n if n > 2 => Ok(RoomKind::Private),
            _ => Err("self_direct_room"),
        },
        "l" => Err("livechat_room"),
        _ => Err("unsupported_room_type"),
    }
}

/// A subscription's role: the highest native role among Rocket.Chat's.
pub fn role(roles: &[&str]) -> RoomRole {
    if roles.contains(&"owner") {
        RoomRole::Owner
    } else if roles.contains(&"moderator") {
        RoomRole::Moderator
    } else {
        RoomRole::Member
    }
}

/// A Rocket.Chat system message as its native kind; `None` for one without
/// a native equivalent. `msg` holds the subject (a username, a topic…),
/// `user` resolves a username to a native account.
pub fn system(
    t: &str,
    msg: &str,
    role: Option<&str>,
    user: impl Fn(&str) -> Option<User>,
) -> Option<SystemMessage> {
    Some(match t {
        "uj" | "ujt" => SystemMessage::MemberJoined {},
        "ul" | "ult" => SystemMessage::MemberLeft {},
        "au" | "added-user-to-team" => SystemMessage::MemberAdded { user: user(msg)? },
        "ru" | "removed-user-from-team" => SystemMessage::MemberRemoved { user: user(msg)? },
        "r" => SystemMessage::RoomRenamed { name: msg.into() },
        "room_changed_topic" => SystemMessage::TopicChanged {
            topic: truncate(msg, 1024).0,
        },
        "room_changed_description" => SystemMessage::DescriptionChanged {
            description: truncate(msg, 4096).0,
        },
        "room_changed_announcement" => SystemMessage::AnnouncementChanged {
            announcement: truncate(msg, 4096).0,
        },
        "room_changed_privacy" => SystemMessage::PrivacyChanged {
            private: msg == "private",
        },
        "room-set-read-only" => SystemMessage::ReadOnlyChanged { read_only: true },
        "room-removed-read-only" => SystemMessage::ReadOnlyChanged { read_only: false },
        "subscription-role-added" | "subscription-role-removed" => {
            let role = match role? {
                "owner" => RoomRole::Owner,
                "moderator" => RoomRole::Moderator,
                _ => return None,
            };
            let user = user(msg)?;
            if t == "subscription-role-added" {
                SystemMessage::RoleChanged {
                    user,
                    previous_role: RoomRole::Member,
                    role,
                }
            } else {
                SystemMessage::RoleChanged {
                    user,
                    previous_role: role,
                    role: RoomRole::Member,
                }
            }
        }
        _ => return None,
    })
}

/// The message ids a Rocket.Chat quote prefix names (`[ ](…?msg=ID) `, one
/// or several), and the text after it.
pub fn quotes(text: &str) -> (Vec<String>, &str) {
    let mut ids = Vec::new();
    let mut rest = text;
    while let Some(after) = rest.strip_prefix("[ ](") {
        let Some(close) = after.find(')') else { break };
        let link = &after[..close];
        let Some(id) = link
            .split(['?', '&'])
            .find_map(|part| part.strip_prefix("msg="))
            .filter(|id| identifier(id))
        else {
            break;
        };
        ids.push(id.to_owned());
        rest = after[close + 1..].trim_start();
    }
    if ids.is_empty() {
        (ids, text)
    } else {
        (ids, rest)
    }
}

/// A reaction as the native server names it: a canonical emoji or one of the
/// imported custom emojis.
pub fn reaction(code: &str, custom: &HashSet<String>) -> Option<String> {
    let bare = code.trim_matches(':');
    rv_protocol::emojis::canonical(bare)
        .map(str::to_owned)
        .or_else(|| custom.contains(bare).then(|| bare.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bob(name: &str) -> Option<User> {
        (name == "bob").then(|| User {
            id: "b".into(),
            username: "bob".into(),
            display_name: "Bob".into(),
        })
    }

    #[test]
    fn usernames_become_native_and_unique() {
        let mut taken = HashSet::new();
        assert_eq!(username("alice", &mut taken), "alice");
        assert_eq!(username("jean.dupont", &mut taken), "jean_dupont");
        assert_eq!(username("jean_dupont", &mut taken), "jean_dupont-2");
        assert_eq!(
            username("Alice", &mut taken),
            "Alice-2",
            "usernames compare without case"
        );
        assert_eq!(username("", &mut taken), "user");
    }

    #[test]
    fn rooms_map_or_say_why_not() {
        assert_eq!(room_kind("c", false, &[]), Ok(RoomKind::Public));
        assert_eq!(room_kind("p", false, &[]), Ok(RoomKind::Private));
        assert_eq!(room_kind("d", false, &["a", "b"]), Ok(RoomKind::Direct));
        assert_eq!(
            room_kind("d", false, &["a", "b", "c"]),
            Ok(RoomKind::Private)
        );
        assert_eq!(room_kind("d", false, &["a", "a"]), Err("self_direct_room"));
        assert_eq!(
            room_kind("d", false, &["a", "rocket.cat"]),
            Err("bot_direct_room")
        );
        assert_eq!(room_kind("p", true, &[]), Err("encrypted_room"));
        assert_eq!(room_kind("l", false, &[]), Err("livechat_room"));
        assert_eq!(role(&["leader", "moderator"]), RoomRole::Moderator);
        assert_eq!(role(&["owner", "moderator"]), RoomRole::Owner);
    }

    #[test]
    fn system_messages_map_to_their_native_kind() {
        assert_eq!(
            system("uj", "", None, bob),
            Some(SystemMessage::MemberJoined {})
        );
        assert!(matches!(
            system("au", "bob", None, bob),
            Some(SystemMessage::MemberAdded { .. })
        ));
        assert_eq!(
            system("au", "nobody", None, bob),
            None,
            "an unknown subject is skipped"
        );
        assert_eq!(
            system("room_changed_topic", "Plans", None, bob),
            Some(SystemMessage::TopicChanged {
                topic: "Plans".into()
            })
        );
        assert!(matches!(
            system("subscription-role-added", "bob", Some("owner"), bob),
            Some(SystemMessage::RoleChanged {
                role: RoomRole::Owner,
                ..
            })
        ));
        assert_eq!(system("message_pinned", "", None, bob), None);
    }

    #[test]
    fn quote_prefixes_give_their_targets() {
        let (ids, rest) = quotes(
            "[ ](https://chat/channel/x?msg=Abc123) [ ](https://chat/x?a=1&msg=Def456) Text",
        );
        assert_eq!(ids, ["Abc123", "Def456"]);
        assert_eq!(rest, "Text");
        assert_eq!(
            quotes("[ ](https://chat/no-id) Text").1,
            "[ ](https://chat/no-id) Text"
        );
        assert!(quotes("plain").0.is_empty());
    }

    #[test]
    fn text_is_cut_on_a_character_boundary() {
        assert_eq!(truncate("héllo", 2), ("h".into(), true));
        assert_eq!(truncate("abc", 5), ("abc".into(), false));
        assert_eq!(display_name(Some("  \u{7}Bob  "), "bob"), "Bob");
        assert_eq!(display_name(None, "bob"), "bob");
        assert_eq!(room_name("  "), "room");
    }

    #[test]
    fn reactions_name_a_known_emoji() {
        let custom: HashSet<String> = ["party_parrot".to_owned()].into();
        assert_eq!(reaction(":+1:", &custom).as_deref(), Some("thumbsup"));
        assert_eq!(
            reaction(":party_parrot:", &custom).as_deref(),
            Some("party_parrot")
        );
        assert_eq!(reaction(":nope_nope:", &custom), None);
    }
}
