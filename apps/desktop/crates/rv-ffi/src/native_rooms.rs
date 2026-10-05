//! Existing room sheets share the native command runner. Saved fields are
//! private account state and are never formatted into error diagnostics.
use crate::{model::RvError, native::NativeChat, on_tokio};
use rv_core::native::{self, store::RoomOperation};
use rv_core::native::{ChangeRoomRole, LeaveRoom, RoomKind, RoomRole, UpdateRoom, room_operation_id};

#[derive(Clone, PartialEq, Eq, uniffi::Record)]
pub struct NativeRoomFields {
    pub name: String,
    pub private_room: bool,
    pub topic: String,
    pub description: String,
    pub announcement: String,
    pub read_only: bool,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeRoomManagement {
    pub info: crate::people::RoomDetails,
    pub revision: String,
    pub fields: NativeRoomFields,
    pub can_send: bool,
    pub can_edit: bool,
    pub can_change_roles: bool,
    pub can_leave: bool,
    pub role: String,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeRoomMember {
    pub id: String,
    pub username: String,
    pub name: String,
    pub role: String,
    pub disabled: bool,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeRoomMemberPage {
    pub revision: String,
    pub members: Vec<NativeRoomMember>,
    pub next: Option<String>,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeRoomIntention {
    /// Local compare-and-delete key; never display or log it.
    pub key: String,
    pub kind: String,
    pub fields: Option<NativeRoomFields>,
    pub target: Option<String>,
    pub role: Option<String>,
    pub failed: bool,
    pub error: Option<String>,
}
fn error(error: native::Error) -> RvError {
    native::rest_error(error).into()
}
fn role(value: RoomRole) -> String {
    match value {
        RoomRole::Owner => "owner",
        RoomRole::Moderator => "moderator",
        RoomRole::Member => "member",
    }
    .into()
}
fn fields(input: &UpdateRoom) -> NativeRoomFields {
    NativeRoomFields {
        name: input.name.clone(),
        private_room: input.private,
        topic: input.topic.clone(),
        description: input.description.clone(),
        announcement: input.announcement.clone(),
        read_only: input.read_only,
    }
}
#[uniffi::export]
impl NativeChat {
    /// Joined-room hints only. The selected destination must be read again
    /// before composing; unknown rights must not hide an unopened room.
    pub fn quote_destinations(&self) -> Result<Vec<String>, RvError> {
        if self.session.is_closed() {
            return Ok(vec![]);
        }
        let private = self.session.crypto_settings_supported();
        let mut candidates = Vec::new();
        for room in self.session.store.rooms().map_err(RvError::local)? {
            if (!room.encrypted || private)
                && self.session.store.room_access(&room.id).map_err(RvError::local)?.is_none_or(|a| a.can_send)
            {
                candidates.push(room.id);
            }
        }
        Ok(candidates)
    }
    pub async fn refresh_room_access(&self, room: String) -> Result<(), RvError> {
        let session = self.session.clone();
        on_tokio(async move { session.refresh_room_access(&room).await }).await.map_err(error)
    }
    pub async fn room_management(&self, room: String) -> Result<NativeRoomManagement, RvError> {
        let session = self.session.clone();
        on_tokio(async move {
            let details = session.room_details(&room).await?;
            let features = session.supported_features();
            Ok(NativeRoomManagement {
                info: rv_core::info::native_room_info(details.clone()).into(),
                revision: details.revision,
                fields: NativeRoomFields {
                    name: details.room.name,
                    private_room: details.room.kind == RoomKind::Private,
                    topic: details.topic,
                    description: details.description,
                    announcement: details.announcement,
                    read_only: details.read_only,
                },
                can_send: details.permissions.send,
                can_edit: details.permissions.change_settings && features.iter().any(|s| s == "room_settings"),
                can_change_roles: details.permissions.role == RoomRole::Owner
                    && details.room.kind != RoomKind::Direct
                    && features.iter().any(|s| s == "room_roles"),
                can_leave: details.room.kind != RoomKind::Direct && features.iter().any(|s| s == "room_leave"),
                role: role(details.permissions.role),
            })
        })
        .await
        .map_err(error)
    }
    pub async fn room_members(
        &self,
        room: String,
        after: Option<String>,
        revision: String,
    ) -> Result<NativeRoomMemberPage, RvError> {
        let session = self.session.clone();
        on_tokio(async move {
            let page = session.room_members(&room, after.as_deref(), Some(&revision)).await?;
            Ok(NativeRoomMemberPage {
                revision: page.revision,
                next: page.next,
                members: page
                    .members
                    .into_iter()
                    .map(|member| NativeRoomMember {
                        id: member.user.id,
                        username: member.user.username,
                        name: member.user.display_name,
                        role: role(member.role),
                        disabled: member.disabled,
                    })
                    .collect(),
            })
        })
        .await
        .map_err(error)
    }
    pub async fn update_room(&self, room: String, revision: String, fields: NativeRoomFields) -> Result<(), RvError> {
        let session = self.session.clone();
        on_tokio(async move {
            session
                .update_room(
                    &room,
                    UpdateRoom {
                        operation_id: room_operation_id(),
                        expected_revision: revision,
                        name: fields.name,
                        private: fields.private_room,
                        topic: fields.topic,
                        description: fields.description,
                        announcement: fields.announcement,
                        read_only: fields.read_only,
                    },
                )
                .await
        })
        .await
        .map_err(error)
    }
    pub async fn change_room_role(
        &self,
        room: String,
        revision: String,
        target: String,
        role: String,
    ) -> Result<(), RvError> {
        let role = match role.as_str() {
            "owner" => RoomRole::Owner,
            "moderator" => RoomRole::Moderator,
            "member" => RoomRole::Member,
            _ => return Err(error(native::Error::Protocol("invalid_room_role"))),
        };
        let session = self.session.clone();
        on_tokio(async move {
            session
                .change_room_role(
                    &room,
                    &target,
                    ChangeRoomRole { operation_id: room_operation_id(), expected_revision: revision, role },
                )
                .await
        })
        .await
        .map_err(error)
    }
    pub async fn leave_room(&self, room: String, revision: String) -> Result<(), RvError> {
        let session = self.session.clone();
        on_tokio(async move {
            session
                .leave_room(&room, LeaveRoom { operation_id: room_operation_id(), expected_revision: revision })
                .await
        })
        .await
        .map_err(error)
    }
    pub fn room_intention(&self, room: String) -> Result<Option<NativeRoomIntention>, RvError> {
        if self.session.is_closed() {
            return Err(error(native::Error::Protocol("session_closed")));
        }
        let Some(saved) = self.session.store.room_operation(&room).map_err(|e| error(e.into()))? else {
            return Ok(None);
        };
        Ok(Some(NativeRoomIntention {
            key: saved.command.id().into(),
            kind: match &saved.command {
                RoomOperation::Settings { .. } => "settings",
                RoomOperation::Role { .. } => "role",
                RoomOperation::Leave { .. } => "leave",
            }
            .into(),
            fields: match &saved.command {
                RoomOperation::Settings { input } => Some(fields(input)),
                _ => None,
            },
            target: match &saved.command {
                RoomOperation::Role { target, .. } => Some(target.clone()),
                _ => None,
            },
            role: match &saved.command {
                RoomOperation::Role { input, .. } => Some(role(input.role)),
                _ => None,
            },
            failed: saved.failed,
            error: saved.error,
        }))
    }
    pub async fn resume_room_intention(&self, room: String) -> Result<(), RvError> {
        let session = self.session.clone();
        on_tokio(async move { session.resume_room_operation(&room).await }).await.map_err(error)
    }
    pub async fn dismiss_room_intention(&self, room: String, key: String) -> Result<bool, RvError> {
        let session = self.session.clone();
        on_tokio(async move { session.dismiss_room_operation(&room, &key).await }).await.map_err(error)
    }
}
