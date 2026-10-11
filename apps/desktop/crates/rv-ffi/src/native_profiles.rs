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
    quiet,
    store::{AvatarUpload, ProfileOperation},
};

/// A daily quiet window: minutes since midnight in `time_zone` (IANA).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeQuietHours {
    pub start_minute: u16,
    pub end_minute: u16,
    pub time_zone: String,
}
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativePreferences {
    pub revision: String,
    pub language: String,
    pub clock_24h: bool,
    pub push_enabled: bool,
    pub push_mentions_only: bool,
    pub desktop_notifications: String,
    /// Do not disturb, read only here: `update_preferences` keeps them,
    /// `mute_notifications` and `set_quiet_hours` change them.
    pub quiet_hours: Option<NativeQuietHours>,
    /// The mute's end (Unix seconds), as the server returned it: ahead then.
    pub muted_until: Option<i64>,
    /// Read receipts, both ways; read only here, `set_share_read_receipts`
    /// changes it.
    pub share_read_receipts: bool,
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
fn quiet_hours(window: &QuietHours) -> NativeQuietHours {
    NativeQuietHours {
        start_minute: window.start_minute,
        end_minute: window.end_minute,
        time_zone: window.time_zone.clone(),
    }
}
fn muted_until(value: Option<&str>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value?).ok().map(|d| d.timestamp())
}
/// A change of `preferences` that keeps do not disturb (absent fields).
fn preferences_input(preferences: NativePreferences) -> Result<UpdatePreferences, RvError> {
    let desktop_notifications = serde_json::from_value(serde_json::Value::String(preferences.desktop_notifications))
        .map_err(|_| error(native::Error::Protocol("invalid_preferences")))?;
    Ok(UpdatePreferences {
        operation_id: native::room_operation_id(),
        expected_revision: preferences.revision,
        language: preferences.language,
        clock_24h: preferences.clock_24h,
        push_enabled: preferences.push_enabled,
        push_mentions_only: preferences.push_mentions_only,
        desktop_notifications,
        quiet_hours: None,
        muted_until: None,
        share_read_receipts: None,
    })
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
            quiet_hours: value.preferences.quiet_hours.as_ref().map(quiet_hours),
            muted_until: muted_until(value.preferences.muted_until.as_deref()),
            share_read_receipts: value.preferences.share_read_receipts,
        },
    }
}
/// `22:00` for 1320.
#[uniffi::export]
pub fn quiet_clock(minute: u16) -> String {
    quiet::clock(minute)
}
/// Minutes since midnight of an `HH:MM` text; None when it is not one.
#[uniffi::export]
pub fn quiet_minute(text: String) -> Option<u16> {
    native::workflows::time_parts(text.trim()).map(|(h, m)| (h * 60 + m) as u16)
}
#[uniffi::export]
impl NativeChat {
    pub fn direct_peer_id(&self, room: String) -> Result<Option<String>, RvError> {
        if self.session.is_closed() {
            return Ok(None);
        }
        self.session.store.direct_peer(&room).map(|p| p.map(|p| p.user.id)).map_err(RvError::local)
    }
    pub async fn direct_user(&self, user_id: String) -> Result<String, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.direct_user(&user_id).await }).await.map_err(error)
    }
    pub fn profile_avatar_current(&self, id: String) -> bool {
        self.session.avatar_current(&id).unwrap_or(false)
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
                bot: p.bot,
                bot_owner: p.bot_owner,
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
        let input = preferences_input(preferences)?;
        let s = self.session.clone();
        on_tokio(async move { s.change_profile(ProfileOperation::Preferences { input }).await.map(own) })
            .await
            .map_err(error)
    }
    /// Mutes notifications: `hour` for one hour, `morning` until the next
    /// 08:00 on this machine's clock, anything else unmutes. Only the mute
    /// changes.
    pub async fn mute_notifications(
        &self,
        preferences: NativePreferences,
        choice: String,
    ) -> Result<NativeOwnProfile, RvError> {
        let mut input = preferences_input(preferences)?;
        input.muted_until = Some(quiet::mute_end(&choice, chrono::Local::now()));
        let s = self.session.clone();
        on_tokio(async move { s.change_profile(ProfileOperation::Preferences { input }).await.map(own) })
            .await
            .map_err(error)
    }
    /// Sets the daily quiet window, in this machine's time zone whatever
    /// `window` names, or removes it (None). Only the window changes.
    pub async fn set_quiet_hours(
        &self,
        preferences: NativePreferences,
        window: Option<NativeQuietHours>,
    ) -> Result<NativeOwnProfile, RvError> {
        let window = window
            .map(|w| {
                let window = QuietHours {
                    start_minute: w.start_minute,
                    end_minute: w.end_minute,
                    time_zone: native::workflows::system_time_zone(),
                };
                window.valid().then_some(window).ok_or_else(|| error(native::Error::Protocol("invalid_preferences")))
            })
            .transpose()?;
        let mut input = preferences_input(preferences)?;
        input.quiet_hours = Some(window);
        let s = self.session.clone();
        on_tokio(async move { s.change_profile(ProfileOperation::Preferences { input }).await.map(own) })
            .await
            .map_err(error)
    }
    /// Shares read receipts, both ways, or stops; only that changes.
    pub async fn set_share_read_receipts(
        &self,
        preferences: NativePreferences,
        share: bool,
    ) -> Result<NativeOwnProfile, RvError> {
        let mut input = preferences_input(preferences)?;
        input.share_read_receipts = Some(share);
        let s = self.session.clone();
        on_tokio(async move { s.change_profile(ProfileOperation::Preferences { input }).await.map(own) })
            .await
            .map_err(error)
    }
    /// Whether the account is in do not disturb now: no notification shows.
    pub fn quiet_now(&self) -> bool {
        self.session.quiet_now()
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
                        // Only the changed field is known: None when kept or removed.
                        quiet_hours: input.quiet_hours.clone().flatten().as_ref().map(quiet_hours),
                        muted_until: muted_until(input.muted_until.clone().flatten().as_deref()),
                        // Only a change of it is known here: the default (on) when kept.
                        share_read_receipts: input.share_read_receipts.unwrap_or(true),
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
        let bytes = on_tokio(async move {
            if let Some((room, revision)) = id.strip_prefix("room:").and_then(|v| v.split_once(':')) {
                s.room_avatar(room, revision).await
            } else {
                s.profile_avatar(&id).await
            }
        })
        .await
        .map_err(error)?;
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
