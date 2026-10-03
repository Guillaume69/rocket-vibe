use crate::{
    MediaData,
    model::{Presence, RvError},
    native::NativeChat,
    on_tokio,
    people::{Me, Person},
};
use rv_core::native::{
    self,
    profiles::*,
    store::{AvatarUpload, ProfileOperation},
};

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativePreferences {
    pub revision: String,
    pub language: String,
    pub clock_24h: bool,
    pub push_enabled: bool,
    pub push_mentions_only: bool,
    pub desktop_notifications: String,
}
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeOwnProfile {
    pub me: Me,
    pub revision: String,
    pub preferences: NativePreferences,
}
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeProfileIntention {
    pub key: String,
    pub slot: String,
    pub phase: String,
    pub error: Option<String>,
    pub fields: Option<Me>,
    pub preferences: Option<NativePreferences>,
    pub photo: Option<Vec<u8>>,
}
fn error(e: native::Error) -> RvError {
    native::rest_error(e).into()
}
fn notification(v: DesktopNotifications) -> String {
    match v {
        DesktopNotifications::Default => "default",
        DesktopNotifications::All => "all",
        DesktopNotifications::Mention => "mention",
        DesktopNotifications::Nothing => "nothing",
    }
    .into()
}
fn status(v: PresenceStatus) -> String {
    match v {
        PresenceStatus::Online => "online",
        PresenceStatus::Away => "away",
        PresenceStatus::Busy => "busy",
        PresenceStatus::Offline => "offline",
    }
    .into()
}
fn own(value: OwnProfile) -> NativeOwnProfile {
    let p = value.profile;
    NativeOwnProfile {
        me: Me {
            username: p.user.username,
            name: p.user.display_name,
            email: value.email.unwrap_or_default(),
            status: status(p.status),
            status_text: p.status_text,
            bio: p.bio,
            avatar: p.avatar_file_id.map(|id| format!("rv-avatar:{id}")).unwrap_or_default(),
            desktop_notifications: notification(value.preferences.desktop_notifications),
        },
        revision: p.revision,
        preferences: NativePreferences {
            revision: value.preferences.revision,
            language: value.preferences.language,
            clock_24h: value.preferences.clock_24h,
            push_enabled: value.preferences.push_enabled,
            push_mentions_only: value.preferences.push_mentions_only,
            desktop_notifications: notification(value.preferences.desktop_notifications),
        },
    }
}
#[uniffi::export]
impl NativeChat {
    pub async fn direct_user(&self, user_id: String) -> Result<String, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.direct_user(&user_id).await }).await.map_err(error)
    }
    pub fn profile_avatar_current(&self, id: String) -> bool {
        !self.session.is_closed() && self.session.store.avatar_current(&id).unwrap_or(false)
    }
    pub fn user_avatar(&self, username: String) -> Option<String> {
        if self.session.is_closed() {
            return None;
        }
        self.session.store.profile_avatar_path(&username).ok().flatten()
    }
    pub fn profiles_available(&self) -> bool {
        self.session.profiles_available()
    }
    pub fn profile_version(&self) -> String {
        self.session.profile_version()
    }
    pub async fn person(&self, key: String, by_id: bool) -> Result<Person, RvError> {
        let session = self.session.clone();
        on_tokio(async move {
            let raw = session.profile(&key, by_id).await?;
            let p = session.profile_presentation(&raw);
            Ok(Person {
                id: p.id,
                username: p.username,
                name: p.name,
                presence: p.presence.map(Presence::from),
                status_text: p.status_text,
                roles: p.roles,
                local_time: None,
                bio: p.bio,
                avatar: p.avatar_etag.map(|id| format!("rv-avatar:{id}")).unwrap_or_default(),
            })
        })
        .await
        .map_err(error)
    }
    pub async fn own_profile(&self) -> Result<NativeOwnProfile, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.own_profile().await.map(own) }).await.map_err(error)
    }
    pub async fn update_own_profile(&self, revision: String, after: Me) -> Result<NativeOwnProfile, RvError> {
        let status = serde_json::from_value(serde_json::Value::String(after.status))
            .map_err(|_| error(native::Error::Protocol("invalid_profile")))?;
        let input = UpdateProfile {
            operation_id: native::room_operation_id(),
            expected_revision: revision,
            username: after.username,
            display_name: after.name,
            bio: after.bio,
            status,
            status_text: after.status_text,
        };
        let s = self.session.clone();
        on_tokio(async move { s.change_profile(ProfileOperation::Profile { input }).await.map(own) })
            .await
            .map_err(error)
    }
    pub async fn update_preferences(&self, preferences: NativePreferences) -> Result<NativeOwnProfile, RvError> {
        let desktop_notifications =
            serde_json::from_value(serde_json::Value::String(preferences.desktop_notifications))
                .map_err(|_| error(native::Error::Protocol("invalid_preferences")))?;
        let input = UpdatePreferences {
            operation_id: native::room_operation_id(),
            expected_revision: preferences.revision,
            language: preferences.language,
            clock_24h: preferences.clock_24h,
            push_enabled: preferences.push_enabled,
            push_mentions_only: preferences.push_mentions_only,
            desktop_notifications,
        };
        let s = self.session.clone();
        on_tokio(async move { s.change_profile(ProfileOperation::Preferences { input }).await.map(own) })
            .await
            .map_err(error)
    }
    pub async fn change_avatar(
        &self,
        revision: String,
        mime: Option<String>,
        bytes: Vec<u8>,
    ) -> Result<NativeOwnProfile, RvError> {
        if mime.is_none() && !bytes.is_empty() {
            return Err(error(native::Error::Protocol("invalid_avatar")));
        }
        let upload = mime.map(|mime| AvatarUpload::from_bytes(mime, &bytes));
        let input = AvatarCommand { operation_id: native::room_operation_id(), expected_revision: revision };
        let s = self.session.clone();
        on_tokio(async move { s.change_profile(ProfileOperation::Avatar { input, upload }).await.map(own) })
            .await
            .map_err(error)
    }
    pub fn profile_intention(&self, slot: String) -> Result<Option<NativeProfileIntention>, RvError> {
        if self.session.is_closed() {
            return Err(error(native::Error::Protocol("session_closed")));
        }
        self.session
            .store
            .profile_operation(&slot)
            .map_err(RvError::local)?
            .map(|saved| {
                let fields = match &saved.command {
                    ProfileOperation::Profile { input } => Some(Me {
                        username: input.username.clone(),
                        name: input.display_name.clone(),
                        email: String::new(),
                        status: status(input.status),
                        status_text: input.status_text.clone(),
                        bio: input.bio.clone(),
                        avatar: String::new(),
                        desktop_notifications: "default".into(),
                    }),
                    _ => None,
                };
                let preferences = match &saved.command {
                    ProfileOperation::Preferences { input } => Some(NativePreferences {
                        revision: input.expected_revision.clone(),
                        language: input.language.clone(),
                        clock_24h: input.clock_24h,
                        push_enabled: input.push_enabled,
                        push_mentions_only: input.push_mentions_only,
                        desktop_notifications: notification(input.desktop_notifications),
                    }),
                    _ => None,
                };
                let photo = match &saved.command {
                    ProfileOperation::Avatar { upload: Some(upload), .. } => upload.bytes(),
                    _ => None,
                };
                Ok(NativeProfileIntention {
                    key: saved.command.id().into(),
                    slot: saved.command.slot().into(),
                    phase: saved.phase,
                    error: saved.error,
                    fields,
                    preferences,
                    photo,
                })
            })
            .transpose()
    }
    pub async fn resume_profile_intention(&self, slot: String) -> Result<NativeOwnProfile, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.resume_profile_operation(&slot).await.map(own) }).await.map_err(error)
    }
    pub async fn dismiss_profile_intention(&self, slot: String, key: String) -> Result<bool, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.dismiss_profile_operation(&slot, &key).await }).await.map_err(error)
    }
    pub async fn profile_avatar(&self, id: String) -> Result<MediaData, RvError> {
        let s = self.session.clone();
        let bytes = on_tokio(async move { s.profile_avatar(&id).await }).await.map_err(error)?;
        Ok(MediaData { bytes, content_type: "image/png".into(), placeholder: false })
    }
}
impl NativeChat {
    pub(crate) fn with_profile_avatars(
        &self,
        mut items: Vec<crate::model::MessageItem>,
    ) -> Vec<crate::model::MessageItem> {
        for item in &mut items {
            item.avatar = self
                .session
                .store
                .profile_identity(&item.author_id)
                .ok()
                .flatten()
                .and_then(|p| p.avatar_file_id)
                .map(|id| format!("rv-avatar:{id}"))
                .unwrap_or_default();
        }
        items
    }
}
