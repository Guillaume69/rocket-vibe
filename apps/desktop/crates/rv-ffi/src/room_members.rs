//! A Rocket.Chat room's members, their roles and its settings for SwiftUI
//! (`rv_core::members`): the list is read from the server and carried by
//! the view between calls, the paging, the menu and the refusals' wording
//! stay rv-core's. Mattermost and kChat have none of it.

use rv_core::members::{self as core, MemberRights as CoreRights, Role};

use crate::model::Presence;
use crate::{Chat, on_tokio};

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RoomMember {
    pub id: String,
    pub username: String,
    pub name: Option<String>,
    /// The live presence when known, else the server's answer.
    pub presence: Option<Presence>,
    pub avatar: String,
    /// Roles in the room (`owner`, `moderator`, `leader`...).
    pub roles: Vec<String>,
    /// The catalog keys of the role chips to show, owner first.
    pub role_keys: Vec<String>,
}

/// The members shown for one search: pass it back for the next page.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MemberList {
    pub members: Vec<RoomMember>,
    pub total: u32,
    pub has_more: bool,
    pub ended: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MemberRights {
    pub moderator: bool,
    pub owner: bool,
    pub remove: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MemberAction {
    SetModerator,
    UnsetModerator,
    SetOwner,
    UnsetOwner,
    /// After a confirmation.
    Remove,
}

/// After an action: the list with the change shown, or the sentence (a
/// catalog key) saying why the server refused, the list unchanged.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MemberActionResult {
    pub list: MemberList,
    pub error: Option<String>,
}

/// What a room's settings editor may change on its server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EditableSettings {
    pub name: bool,
    pub texts: bool,
    pub read_only: bool,
}

/// A room's editable settings; texts empty when absent.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RoomSettings {
    pub name: String,
    pub topic: String,
    pub description: String,
    pub announcement: String,
    pub read_only: bool,
}

impl From<MemberAction> for core::MemberAction {
    fn from(a: MemberAction) -> Self {
        match a {
            MemberAction::SetModerator => core::MemberAction::Role(Role::Moderator, true),
            MemberAction::UnsetModerator => core::MemberAction::Role(Role::Moderator, false),
            MemberAction::SetOwner => core::MemberAction::Role(Role::Owner, true),
            MemberAction::UnsetOwner => core::MemberAction::Role(Role::Owner, false),
            MemberAction::Remove => core::MemberAction::Remove,
        }
    }
}

impl From<core::MemberAction> for MemberAction {
    fn from(a: core::MemberAction) -> Self {
        match a {
            core::MemberAction::Role(Role::Moderator, true) => MemberAction::SetModerator,
            core::MemberAction::Role(Role::Moderator, false) => MemberAction::UnsetModerator,
            core::MemberAction::Role(Role::Owner, true) => MemberAction::SetOwner,
            core::MemberAction::Role(Role::Owner, false) => MemberAction::UnsetOwner,
            core::MemberAction::Remove => MemberAction::Remove,
        }
    }
}

impl From<RoomSettings> for core::RoomSettings {
    fn from(s: RoomSettings) -> Self {
        core::RoomSettings {
            name: s.name,
            topic: s.topic,
            description: s.description,
            announcement: s.announcement,
            read_only: s.read_only,
        }
    }
}

fn to_core(member: &RoomMember) -> core::Member {
    core::Member {
        id: member.id.clone(),
        username: member.username.clone(),
        name: member.name.clone(),
        presence: None,
        avatar_etag: None,
        roles: member.roles.clone(),
    }
}

impl Chat {
    fn member_record(&self, m: core::Member) -> RoomMember {
        RoomMember {
            presence: self.session.presence(&m.id).or(m.presence).map(Presence::from),
            avatar: m.avatar(),
            role_keys: m.role_keys().into_iter().map(str::to_owned).collect(),
            id: m.id,
            username: m.username,
            name: m.name,
            roles: m.roles,
        }
    }

    /// The core list a view carried; each record keeps its own avatar and
    /// presence, which the core list does not need.
    fn core_list(list: &MemberList) -> core::MemberList {
        core::MemberList::from_parts(list.members.iter().map(to_core).collect(), list.total, list.ended)
    }

    /// Back to records, reusing what `old` showed for the members it had.
    fn records(&self, list: core::MemberList, old: &[RoomMember]) -> MemberList {
        let (total, has_more, ended) = (list.total, list.has_more(), list.ended());
        let members = list
            .members
            .into_iter()
            .map(|m| match old.iter().find(|o| o.id == m.id) {
                Some(o) => RoomMember {
                    role_keys: m.role_keys().into_iter().map(str::to_owned).collect(),
                    roles: m.roles,
                    ..o.clone()
                },
                None => self.member_record(m),
            })
            .collect();
        MemberList { members, total, has_more, ended }
    }
}

#[uniffi::export]
impl Chat {
    /// Whether the room's members, roles and settings can be managed here:
    /// a Rocket.Chat channel or private group.
    pub fn members_available(&self, rid: String) -> bool {
        self.session.members_available(&rid)
    }

    /// The first page of the members matching `filter` (searched by the
    /// server), or, given the `list` shown, the next page added to it.
    pub async fn members(
        &self,
        rid: String,
        filter: String,
        list: Option<MemberList>,
    ) -> Result<MemberList, crate::model::RvError> {
        let offset = list.as_ref().map_or(0, |l| l.members.len() as u32);
        let s = self.session.clone();
        let page = on_tokio(async move { s.room_members(&rid, &filter, offset).await }).await?;
        let merged = match &list {
            Some(shown) => {
                let mut core = Self::core_list(shown);
                core.append(page);
                core
            }
            None => core::MemberList::first(page),
        };
        let old: &[RoomMember] = match &list {
            Some(shown) => &shown.members,
            None => &[],
        };
        Ok(self.records(merged, old))
    }

    /// What my global and room roles let me do on others in the room.
    pub async fn member_rights(&self, rid: String) -> MemberRights {
        let s = self.session.clone();
        let r = on_tokio(async move { s.member_rights(&rid).await }).await;
        MemberRights { moderator: r.moderator, owner: r.owner, remove: r.remove }
    }

    /// The menu of a member's row, in order: none on my own.
    pub fn member_actions(&self, rights: MemberRights, member: RoomMember) -> Vec<MemberAction> {
        let rights = CoreRights { moderator: rights.moderator, owner: rights.owner, remove: rights.remove };
        core::member_actions(rights, &to_core(&member), &self.session.info.user_id)
            .into_iter()
            .map(MemberAction::from)
            .collect()
    }

    /// Runs `action` on `user_id`, then shows it in `list` (the list is not live).
    pub async fn run_member_action(
        &self,
        rid: String,
        list: MemberList,
        user_id: String,
        action: MemberAction,
    ) -> MemberActionResult {
        let s = self.session.clone();
        let uid = user_id.clone();
        let done = on_tokio(async move {
            match core::MemberAction::from(action) {
                core::MemberAction::Role(role, put) => s.set_member_role(&rid, &uid, role, put).await,
                core::MemberAction::Remove => s.remove_member(&rid, &uid).await,
            }
        })
        .await;
        match done {
            Ok(()) => {
                let mut core = Self::core_list(&list);
                match core::MemberAction::from(action) {
                    core::MemberAction::Role(role, put) => {
                        core.set_role(&user_id, role, put);
                    }
                    core::MemberAction::Remove => {
                        core.remove(&user_id);
                    }
                }
                MemberActionResult { list: self.records(core, &list.members), error: None }
            }
            Err(e) => MemberActionResult { list, error: Some(core::error_key(&e).to_owned()) },
        }
    }

    /// Whether I may still write while the room is read-only (my roles
    /// grant `post-readonly`): the composers stay.
    pub async fn may_post_read_only(&self, rid: String) -> bool {
        let s = self.session.clone();
        on_tokio(async move { s.may_post_read_only(&rid).await }).await
    }

    /// What the room's settings editor may change here; None when it is not offered.
    pub async fn editable_settings(&self, rid: String) -> Option<EditableSettings> {
        let s = self.session.clone();
        on_tokio(async move { s.editable_settings(&rid).await }).await.map(|e| EditableSettings {
            name: e.name,
            texts: e.texts,
            read_only: e.read_only,
        })
    }

    /// Saves what changed between `before` and `after`; None once saved (or
    /// nothing to save), else the catalog key saying it was refused.
    pub async fn save_room_settings(&self, rid: String, before: RoomSettings, after: RoomSettings) -> Option<String> {
        let s = self.session.clone();
        let (before, after): (core::RoomSettings, core::RoomSettings) = (before.into(), after.into());
        match on_tokio(async move { s.save_room_settings(&rid, &before, &after).await }).await {
            Ok(_) => None,
            Err(e) => Some(if e.status == 0 { "members.offline" } else { "room_settings.failed" }.to_owned()),
        }
    }
}

/// The catalog key of a member action's label.
#[uniffi::export]
pub fn member_action_key(action: MemberAction) -> String {
    core::MemberAction::from(action).label_key().to_owned()
}
