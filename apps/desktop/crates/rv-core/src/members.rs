//! A Rocket.Chat room's members, their roles in it, and the room's own
//! settings (topic, description, announcement, read-only): read from the
//! server on demand and never stored, since the local database knows who
//! wrote, not the roster. The rules both desktop UIs share; the REST calls
//! are in `rocketchat::actions`, the session's entry points in `session`.

use serde_json::{Map, Value, json};

use crate::info::RoomInfo;
use crate::live::Presence;
use crate::media::{AvatarTarget, avatar_path};
use crate::rest::RestError;

/// `rooms.membersOrderedByRole` page size.
pub const PAGE: u32 = 50;
/// What a search waits for after the last key, in milliseconds.
pub const SEARCH_DELAY_MS: u32 = 300;

/// The permissions behind each action, from my global and room roles.
pub const SET_MODERATOR: &str = "set-moderator";
pub const SET_OWNER: &str = "set-owner";
pub const REMOVE_USER: &str = "remove-user";
pub const EDIT_ROOM: &str = "edit-room";

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Member {
    pub id: String,
    pub username: String,
    pub name: Option<String>,
    /// The answer's `status`; a live presence, when known, comes first.
    pub presence: Option<Presence>,
    pub avatar_etag: Option<String>,
    /// Roles in the room (`owner`, `moderator`, `leader`...).
    pub roles: Vec<String>,
}

impl Member {
    pub fn shown_name(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.username)
    }

    pub fn avatar(&self) -> String {
        avatar_path(AvatarTarget::User(&self.username), self.avatar_etag.as_deref())
    }

    pub fn has(&self, role: Role) -> bool {
        self.roles.iter().any(|r| r == role.as_str())
    }

    /// The catalog keys of the room roles a row shows, owner first.
    pub fn role_keys(&self) -> Vec<&'static str> {
        [("owner", "members.owner"), ("moderator", "members.moderator"), ("leader", "members.leader")]
            .into_iter()
            .filter(|(role, _)| self.roles.iter().any(|r| r == role))
            .map(|(_, key)| key)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemberPage {
    pub members: Vec<Member>,
    pub total: u32,
}

/// `rooms.membersOrderedByRole`'s answer; entries without an id or a
/// username are dropped. Without `total`, what was read so far.
pub fn member_page(response: &Value, offset: u32) -> MemberPage {
    let members: Vec<Member> = response
        .get("members")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|m| {
            Some(Member {
                id: text(m, "_id")?,
                username: text(m, "username")?,
                name: text(m, "name"),
                presence: m.get("status").and_then(Value::as_str).and_then(Presence::parse),
                avatar_etag: text(m, "avatarETag"),
                roles: m
                    .get("roles")
                    .and_then(Value::as_array)
                    .map(|r| r.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                    .unwrap_or_default(),
            })
        })
        .collect();
    let read = offset + members.len() as u32;
    let total = response.get("total").and_then(Value::as_u64).map_or(read, |t| t as u32);
    MemberPage { members, total }
}

/// The list as shown: the pages read so far for one search, and whether it ended.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MemberList {
    pub members: Vec<Member>,
    pub total: u32,
    ended: bool,
}

impl MemberList {
    pub fn first(page: MemberPage) -> Self {
        let mut list = MemberList { total: page.total, ..Default::default() };
        list.append(page);
        list
    }

    /// Adds a later page's members not already listed: a page with nothing
    /// new ends the list, or it would be asked for forever. The new ones.
    pub fn append(&mut self, page: MemberPage) -> Vec<Member> {
        let fresh: Vec<Member> =
            page.members.into_iter().filter(|m| !self.members.iter().any(|known| known.id == m.id)).collect();
        if fresh.is_empty() {
            self.ended = true;
        }
        self.total = page.total;
        self.members.extend(fresh.iter().cloned());
        fresh
    }

    /// A list carried by a UI between calls (the SwiftUI bridge).
    pub fn from_parts(members: Vec<Member>, total: u32, ended: bool) -> Self {
        MemberList { members, total, ended }
    }

    /// Whether a page with nothing new ended it.
    pub fn ended(&self) -> bool {
        self.ended
    }

    pub fn has_more(&self) -> bool {
        !self.ended && (self.members.len() as u32) < self.total
    }

    /// Where the next page starts.
    pub fn offset(&self) -> u32 {
        self.members.len() as u32
    }

    pub fn member(&self, id: &str) -> Option<&Member> {
        self.members.iter().find(|m| m.id == id)
    }

    /// A role given or taken here, shown at once: the list is not live.
    pub fn set_role(&mut self, id: &str, role: Role, put: bool) -> Option<&Member> {
        let member = self.members.iter_mut().find(|m| m.id == id)?;
        member.roles.retain(|r| r != role.as_str());
        if put {
            member.roles.push(role.as_str().to_owned());
        }
        Some(member)
    }

    /// Someone removed from the room here.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.members.len();
        self.members.retain(|m| m.id != id);
        let removed = self.members.len() < before;
        if removed {
            self.total = self.total.saturating_sub(1);
        }
        removed
    }
}

/// A room role I may give or take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Moderator,
    Owner,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Moderator => "moderator",
            Role::Owner => "owner",
        }
    }
}

/// What my roles let me do on someone else's row.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MemberRights {
    pub moderator: bool,
    pub owner: bool,
    pub remove: bool,
}

impl MemberRights {
    pub fn from_granted(granted: &[String]) -> Self {
        let has = |p: &str| granted.iter().any(|g| g == p);
        MemberRights { moderator: has(SET_MODERATOR), owner: has(SET_OWNER), remove: has(REMOVE_USER) }
    }

    pub fn any(&self) -> bool {
        self.moderator || self.owner || self.remove
    }
}

/// One action on a member's row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberAction {
    /// Give (`true`) or take the role.
    Role(Role, bool),
    /// Out of the room, after a confirmation.
    Remove,
}

impl MemberAction {
    pub fn label_key(self) -> &'static str {
        match self {
            MemberAction::Role(Role::Moderator, true) => "members.set_moderator",
            MemberAction::Role(Role::Moderator, false) => "members.unset_moderator",
            MemberAction::Role(Role::Owner, true) => "members.set_owner",
            MemberAction::Role(Role::Owner, false) => "members.unset_owner",
            MemberAction::Remove => "members.remove",
        }
    }

    /// A stable name for the UI's widgets and tests.
    pub fn id(self) -> &'static str {
        match self {
            MemberAction::Role(Role::Moderator, true) => "set-moderator",
            MemberAction::Role(Role::Moderator, false) => "unset-moderator",
            MemberAction::Role(Role::Owner, true) => "set-owner",
            MemberAction::Role(Role::Owner, false) => "unset-owner",
            MemberAction::Remove => "remove",
        }
    }
}

/// The actions a row offers, in menu order: none on my own row.
pub fn member_actions(rights: MemberRights, member: &Member, me: &str) -> Vec<MemberAction> {
    if member.id == me {
        return Vec::new();
    }
    let mut actions = Vec::new();
    if rights.moderator {
        actions.push(MemberAction::Role(Role::Moderator, !member.has(Role::Moderator)));
    }
    if rights.owner {
        actions.push(MemberAction::Role(Role::Owner, !member.has(Role::Owner)));
    }
    if rights.remove {
        actions.push(MemberAction::Remove);
    }
    actions
}

/// `channels.*` for a channel, `groups.*` for a private group: there is no
/// `rooms.*` route. None for any other room (a DM).
fn route_prefix(kind: &str) -> Option<&'static str> {
    match kind {
        "c" => Some("channels"),
        "p" => Some("groups"),
        _ => None,
    }
}

pub fn role_route(kind: &str, role: Role, put: bool) -> Option<String> {
    let verb = if put { "add" } else { "remove" };
    let name = match role {
        Role::Moderator => "Moderator",
        Role::Owner => "Owner",
    };
    Some(format!("{}.{verb}{name}", route_prefix(kind)?))
}

pub fn kick_route(kind: &str) -> Option<String> {
    Some(format!("{}.kick", route_prefix(kind)?))
}

/// Refusals saying the change is already in place (the routes are not
/// idempotent, probed on 8.5.1): the role is held, or not, or the person has
/// already left. Taken as done.
pub fn already_done(error: &RestError) -> bool {
    matches!(
        error.error_type.as_deref(),
        Some(
            "error-user-already-moderator"
                | "error-user-already-owner"
                | "error-user-not-moderator"
                | "error-user-not-owner"
                | "error-user-not-in-room"
        )
    )
}

/// The sentence for a refused member action.
pub fn error_key(error: &RestError) -> &'static str {
    match error.error_type.as_deref() {
        Some("error-remove-last-owner") => "members.last_owner",
        _ if error.status == 0 => "members.offline",
        _ => "members.action_failed",
    }
}

/// A room's settings as its editor shows them: texts empty when absent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoomSettings {
    pub name: String,
    pub topic: String,
    pub description: String,
    pub announcement: String,
    pub read_only: bool,
}

impl RoomSettings {
    pub fn of(info: &RoomInfo) -> Self {
        let text = |t: &Option<String>| t.clone().unwrap_or_default();
        RoomSettings {
            name: info.name.clone(),
            topic: text(&info.topic),
            description: text(&info.description),
            announcement: text(&info.announcement),
            read_only: info.read_only,
        }
    }
}

/// What a room's editor may change on its server: Rocket.Chat every field
/// `edit-room` grants, Mattermost, kChat, Slack and Teams the name only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EditableSettings {
    pub name: bool,
    pub texts: bool,
    pub read_only: bool,
}

impl EditableSettings {
    pub const ALL: EditableSettings = EditableSettings { name: true, texts: true, read_only: true };
    pub const NAME: EditableSettings = EditableSettings { name: true, texts: false, read_only: false };
}

/// The new name when `after` renames the room, trimmed. A name emptied is
/// refused: Rocket.Chat ignores it silently and Mattermost stores it (both
/// probed on the benches, 2026-10-23).
pub fn renamed(before: &RoomSettings, after: &RoomSettings) -> Result<Option<String>, &'static str> {
    let name = after.name.trim();
    if name == before.name.trim() {
        return Ok(None);
    }
    if name.is_empty() {
        return Err("room_settings.name_empty");
    }
    Ok(Some(name.to_owned()))
}

/// The `rooms.saveRoomSettings` fields of what changed between `before`
/// and `after`, under the server's names (it refuses any other key; an empty
/// string clears a text). None when nothing changed. A new name is
/// `roomName`, which renames the room's address too.
pub fn settings_changes(before: &RoomSettings, after: &RoomSettings) -> Option<Map<String, Value>> {
    let mut fields = Map::new();
    if let Ok(Some(name)) = renamed(before, after) {
        fields.insert("roomName".into(), json!(name));
    }
    for (key, old, new) in [
        ("roomTopic", &before.topic, &after.topic),
        ("roomDescription", &before.description, &after.description),
        ("roomAnnouncement", &before.announcement, &after.announcement),
    ] {
        if old != new {
            fields.insert(key.into(), json!(new));
        }
    }
    if before.read_only != after.read_only {
        fields.insert("readOnly".into(), json!(after.read_only));
    }
    (!fields.is_empty()).then_some(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: &str, roles: &[&str]) -> Member {
        Member {
            id: id.into(),
            username: format!("user-{id}"),
            name: None,
            presence: None,
            avatar_etag: None,
            roles: roles.iter().map(|r| (*r).to_owned()).collect(),
        }
    }

    #[test]
    fn a_page_keeps_the_server_order_and_drops_unreadable_entries() {
        let page = member_page(
            &json!({"members": [
                {"_id": "u1", "username": "admin", "name": "Admin", "status": "online", "roles": ["owner"]},
                {"_id": "u2", "name": "No username"},
                {"_id": "u3", "username": "bob", "status": "nonsense", "avatarETag": "e3", "roles": []}
            ], "total": 120}),
            50,
        );
        assert_eq!(page.total, 120);
        let ids: Vec<_> = page.members.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["u1", "u3"]);
        assert_eq!(page.members[0].presence, Some(Presence::Online));
        assert_eq!(page.members[1].presence, None);
        assert_eq!(page.members[1].avatar(), "/avatar/bob?etag=e3");
        assert_eq!(page.members[1].shown_name(), "bob");
        assert_eq!(member_page(&json!({"members": [{"_id": "u", "username": "x"}]}), 50).total, 51);
    }

    #[test]
    fn a_page_with_nothing_new_ends_the_list() {
        let mut list = MemberList::first(MemberPage { members: vec![member("a", &[]), member("b", &[])], total: 4 });
        assert!(list.has_more());
        assert_eq!(list.offset(), 2);
        // The server's order moved under us: only "c" is new.
        let fresh = list.append(MemberPage { members: vec![member("b", &[]), member("c", &[])], total: 4 });
        assert_eq!(fresh.len(), 1);
        assert!(list.has_more());
        assert!(list.append(MemberPage { members: vec![member("c", &[])], total: 4 }).is_empty());
        assert!(!list.has_more(), "nothing new: the end");
        let full = MemberList::first(MemberPage { members: vec![member("a", &[])], total: 1 });
        assert!(!full.has_more());
    }

    #[test]
    fn roles_change_and_removal_show_at_once() {
        let mut list =
            MemberList::first(MemberPage { members: vec![member("a", &["owner"]), member("b", &[])], total: 2 });
        assert!(list.set_role("b", Role::Moderator, true).is_some_and(|m| m.has(Role::Moderator)));
        assert_eq!(list.member("b").unwrap().role_keys(), ["members.moderator"]);
        list.set_role("b", Role::Moderator, true);
        assert_eq!(list.member("b").unwrap().roles, ["moderator"], "never twice");
        list.set_role("a", Role::Owner, false);
        assert!(list.member("a").unwrap().roles.is_empty());
        assert!(list.set_role("zz", Role::Owner, true).is_none());
        assert!(list.remove("b"));
        assert!(!list.remove("b"));
        assert_eq!((list.members.len(), list.total), (1, 1));
    }

    #[test]
    fn rows_show_owner_moderator_and_leader_only() {
        assert_eq!(
            member("a", &["leader", "custom", "moderator", "owner"]).role_keys(),
            ["members.owner", "members.moderator", "members.leader"]
        );
    }

    #[test]
    fn actions_follow_my_rights_and_the_members_roles() {
        let granted = |p: &[&str]| MemberRights::from_granted(&p.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
        let all = granted(&[SET_MODERATOR, SET_OWNER, REMOVE_USER, "view-room"]);
        let moderator = member("m", &["moderator"]);
        assert_eq!(
            member_actions(all, &moderator, "me"),
            [MemberAction::Role(Role::Moderator, false), MemberAction::Role(Role::Owner, true), MemberAction::Remove]
        );
        assert!(member_actions(all, &member("me", &[]), "me").is_empty(), "not on my own row");
        let some = granted(&[REMOVE_USER]);
        assert_eq!(member_actions(some, &moderator, "me"), [MemberAction::Remove]);
        assert!(!granted(&["edit-room"]).any());
        assert_eq!(MemberAction::Role(Role::Owner, false).label_key(), "members.unset_owner");
    }

    #[test]
    fn routes_follow_the_room_type() {
        assert_eq!(role_route("c", Role::Moderator, true).as_deref(), Some("channels.addModerator"));
        assert_eq!(role_route("p", Role::Owner, false).as_deref(), Some("groups.removeOwner"));
        assert_eq!(role_route("d", Role::Owner, true), None);
        assert_eq!(kick_route("p").as_deref(), Some("groups.kick"));
        assert_eq!(kick_route("d"), None);
    }

    #[test]
    fn refusals_already_in_place_count_as_done() {
        let refused = |kind: &str| RestError {
            status: 400,
            error_type: Some(kind.to_owned()),
            ..RestError::incomplete("refused")
        };
        assert!(already_done(&refused("error-user-already-moderator")));
        assert!(already_done(&refused("error-user-not-in-room")));
        assert!(!already_done(&refused("error-not-allowed")));
        assert_eq!(error_key(&refused("error-remove-last-owner")), "members.last_owner");
        assert_eq!(error_key(&refused("error-not-allowed")), "members.action_failed");
        assert_eq!(error_key(&RestError { status: 0, ..RestError::incomplete("down") }), "members.offline");
    }

    #[test]
    fn only_changed_settings_are_sent() {
        let before = RoomSettings {
            name: "dev".into(),
            topic: "t".into(),
            description: "d".into(),
            announcement: String::new(),
            read_only: false,
        };
        assert_eq!(settings_changes(&before, &before.clone()), None);
        let after = RoomSettings { topic: String::new(), announcement: "Hello".into(), ..before.clone() };
        assert_eq!(
            Value::Object(settings_changes(&before, &after).unwrap()),
            json!({"roomTopic": "", "roomAnnouncement": "Hello"})
        );
        let locked = RoomSettings { read_only: true, ..before.clone() };
        assert_eq!(Value::Object(settings_changes(&before, &locked).unwrap()), json!({"readOnly": true}));
        let moved = RoomSettings { name: " ops ".into(), ..before.clone() };
        assert_eq!(Value::Object(settings_changes(&before, &moved).unwrap()), json!({"roomName": "ops"}));
    }

    #[test]
    fn a_name_is_trimmed_and_never_emptied() {
        let before = RoomSettings { name: "dev".into(), ..Default::default() };
        let named = |name: &str| RoomSettings { name: name.into(), ..before.clone() };
        assert_eq!(renamed(&before, &named(" dev ")), Ok(None));
        assert_eq!(renamed(&before, &named("Ops team")), Ok(Some("Ops team".into())));
        assert_eq!(renamed(&before, &named("  ")), Err("room_settings.name_empty"));
        assert_eq!(settings_changes(&before, &named("")), None);
    }

    #[test]
    fn settings_start_from_the_room_information() {
        let info = RoomInfo {
            id: "r".into(),
            name: "dev".into(),
            kind: "c".into(),
            topic: Some("t".into()),
            announcement: None,
            description: None,
            members: Some(3),
            read_only: true,
            encrypted: false,
            archived: false,
            default: false,
        };
        assert_eq!(
            RoomSettings::of(&info),
            RoomSettings {
                name: "dev".into(),
                topic: "t".into(),
                description: String::new(),
                announcement: String::new(),
                read_only: true
            }
        );
    }
}
