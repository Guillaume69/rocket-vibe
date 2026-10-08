//! Profiles share the existing UI records; private contact/preferences are never cached.
use super::{
    Error, NativeSession, permanent_command_error,
    store::{ProfileOperation, SavedProfileOperation},
};
pub use rv_protocol::live::PresenceStatus;
pub use rv_protocol::{
    parity::{UserPreferences, UserProfile},
    profiles::{AvatarCommand, DesktopNotifications, OwnProfile, ProfileStamp, UpdatePreferences, UpdateProfile},
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::Ordering;

#[derive(Default)]
pub(super) struct AvatarCache {
    entries: HashMap<String, Vec<u8>>,
    order: VecDeque<String>,
    size: usize,
}
impl AvatarCache {
    pub(super) fn get(&mut self, id: &str) -> Option<Vec<u8>> {
        let value = self.entries.get(id)?.clone();
        self.order.retain(|k| k != id);
        self.order.push_back(id.into());
        Some(value)
    }
    pub(super) fn put(&mut self, id: &str, bytes: Vec<u8>) {
        if self.entries.contains_key(id) {
            return;
        }
        while self.entries.len() >= 128 || self.size + bytes.len() > 32 * 1024 * 1024 {
            let Some(old) = self.order.pop_front() else {
                return;
            };
            if let Some(value) = self.entries.remove(&old) {
                self.size -= value.len();
            }
        }
        self.size += bytes.len();
        self.entries.insert(id.into(), bytes);
        self.order.push_back(id.into());
    }
}

impl NativeSession {
    pub fn profiles_available(&self) -> bool {
        self.profiles_supported(false) && !self.is_closed()
    }
    pub fn profile_version(&self) -> String {
        format!(
            "{}:{}:{}:{:?}",
            self.security_generation.load(Ordering::SeqCst),
            self.store.projection_token(),
            self.store.profile_version().unwrap_or_default(),
            self.status().connection
        )
    }
    pub(super) fn apply_live_profiles(&self, state: &rv_protocol::live::LiveState) -> Result<(), Error> {
        if state.limited || state.ttl_ms == 0 || state.ttl_ms > 8000 {
            return Ok(());
        }
        let mut ids = HashSet::new();
        if state.profiles.len() > 512 || state.profiles.iter().any(|p| !ids.insert(&p.user.id)) {
            return Err(Error::Protocol("invalid_profile_stamps"));
        }
        self.store.live_profiles(state, || !self.is_closed())?;
        Ok(())
    }
    /// Both desktop interfaces reuse these existing sidebar records.
    pub fn room_rows(&self) -> Result<Vec<crate::store::RoomRow>, Error> {
        if self.is_closed() {
            return Ok(vec![]);
        }
        let reads = self.supported_features().iter().any(|f| f == "read_markers");
        self.store
            .rooms()?
            .into_iter()
            .map(|room| {
                let peer = self.store.direct_peer(&room.id)?;
                let (unread, mentions, alert) =
                    if reads { super::read_presentation::badges(room.read_state.as_deref()) } else { (0, 0, false) };
                let read_only = !self.room_send_permitted(&room.id);
                let last = self.store.messages(&room.id, 1)?.pop();
                Ok(crate::store::RoomRow {
                    rid: room.id,
                    kind: match room.kind {
                        rv_protocol::RoomKind::Direct => "d",
                        rv_protocol::RoomKind::Private => "p",
                        rv_protocol::RoomKind::Public => "c",
                    }
                    .into(),
                    name: peer
                        .as_ref()
                        .map(|p| {
                            if p.user.display_name.is_empty() {
                                p.user.username.clone()
                            } else {
                                p.user.display_name.clone()
                            }
                        })
                        .unwrap_or(room.name),
                    dm_other_uid: peer.as_ref().map(|p| p.user.id.clone()),
                    avatar_etag: peer.and_then(|p| p.avatar_file_id),
                    last_message: last.as_ref().map(|m| m.text.clone()),
                    last_ts: last.as_ref().map_or(0, |m| m.ts),
                    last_type: last.as_ref().and_then(|m| m.system_type.clone()),
                    last_author: last.map(|m| m.author),
                    unread,
                    mentions,
                    alert,
                    favorite: room.read_state.as_ref().is_some_and(|s| s.favorite),
                    encrypted: room.encrypted,
                    read_only,
                    slug: None,
                    last_encrypted: None,
                    voice: room.voice,
                })
            })
            .collect()
    }
    fn profiles_supported(&self, avatar: bool) -> bool {
        self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.profiles && (!avatar || c.profile_avatars))
    }
    fn profile_generation(&self, generation: u64) -> Result<(), Error> {
        self.ready()?;
        if generation != self.security_generation.load(Ordering::SeqCst) {
            return Err(Error::Protocol("session_closed"));
        }
        Ok(())
    }
    pub async fn profile(&self, key: &str, by_id: bool) -> Result<UserProfile, Error> {
        self.ready()?;
        if !self.profiles_supported(false) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let generation = self.security_generation.load(Ordering::SeqCst);
        let projection = self.store.projection_token();
        let version = self.store.profile_version()?;
        let before = if by_id { self.store.profile_identity(key)?.map(|p| p.revision) } else { None };
        self.identity().await?;
        self.profile_generation(generation)?;
        let profile =
            if by_id { self.client.user_profile(key).await? } else { self.client.lookup_profile(key).await? };
        self.identity().await?;
        self.profile_generation(generation)?;
        if (by_id && profile.user.id != key) || (!by_id && profile.user.username != key) {
            return Err(Error::Protocol("invalid_profile"));
        }
        let after = self.store.profile_identity(&profile.user.id)?.map(|p| p.revision);
        if projection != self.store.projection_token()
            || by_id && after != before && after.as_deref() != Some(profile.revision.as_str())
            || !by_id
                && self.store.profile_version()? != version
                && after.is_some()
                && after.as_deref() != Some(profile.revision.as_str())
        {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        self.cache_profile(&profile, generation, projection)?;
        Ok(profile)
    }
    pub async fn own_profile(&self) -> Result<OwnProfile, Error> {
        self.ready()?;
        if !self.profiles_supported(false) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let generation = self.security_generation.load(Ordering::SeqCst);
        let projection = self.store.projection_token();
        let before = self.store.profile_identity(&self.info.user_id)?.map(|p| p.revision);
        self.identity().await?;
        self.profile_generation(generation)?;
        let own = self.client.own_profile().await?;
        self.identity().await?;
        self.profile_generation(generation)?;
        if own.profile.user.id != self.info.user_id {
            return Err(Error::Protocol("session_rejected"));
        }
        let after = self.store.profile_identity(&self.info.user_id)?.map(|p| p.revision);
        if projection != self.store.projection_token()
            || after != before && after.as_deref() != Some(own.profile.revision.as_str())
        {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        self.cache_profile(&own.profile, generation, projection)?;
        self.update_notification_preference(&own);
        Ok(own)
    }
    fn cache_profile(&self, profile: &UserProfile, generation: u64, projection: u64) -> Result<(), Error> {
        self.store.profile_identities(
            &[ProfileStamp {
                user: profile.user.clone(),
                revision: profile.revision.clone(),
                avatar_file_id: profile.avatar_file_id.clone(),
                status_text: profile.status_text.clone(),
            }],
            || {
                !self.is_closed()
                    && generation == self.security_generation.load(Ordering::SeqCst)
                    && projection == self.store.projection_token()
            },
        )?;
        Ok(())
    }
    pub fn profile_presentation(&self, p: &UserProfile) -> crate::info::Profile {
        crate::info::Profile {
            id: p.user.id.clone(),
            username: p.user.username.clone(),
            name: Some(p.user.display_name.clone()).filter(|v| !v.is_empty()),
            presence: self.live.lock().unwrap().presence(&p.user.id, std::time::Instant::now()),
            status_text: Some(p.status_text.clone()).filter(|v| !v.is_empty()),
            bio: Some(p.bio.clone()).filter(|v| !v.is_empty()),
            avatar_etag: p.avatar_file_id.clone(),
            roles: vec![],
            utc_offset: None,
            bot: p.user.bot,
            bot_owner: p.bot_owner.as_ref().map(|owner| super::shown_username(&owner.username)),
        }
    }
    pub async fn change_profile(&self, command: ProfileOperation) -> Result<OwnProfile, Error> {
        if self.is_closed() {
            return Err(Error::Protocol("session_closed"));
        }
        if !self.profiles_supported(matches!(&command, ProfileOperation::Avatar { .. })) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let saved = self.store.stage_profile_operation(command)?.ok_or(Error::Protocol("profile_action_pending"))?;
        if saved.phase == "proof" {
            return Err(Error::Protocol("reauthentication_required"));
        }
        self.finish_profile_operation(&saved).await
    }
    pub async fn resume_profile_operation(&self, slot: &str) -> Result<OwnProfile, Error> {
        self.ready()?;
        let Some(saved) = self.store.profile_operation(slot)? else {
            // The background worker may have confirmed it before the view's Resume click.
            return self.own_profile().await;
        };
        if saved.phase == "failed" {
            return Err(Error::Protocol("profile_action_pending"));
        }
        if saved.phase == "proof" {
            self.store.mark_profile_operation(&saved, "pending", None)?;
        }
        self.finish_profile_operation(&SavedProfileOperation { phase: "pending".into(), ..saved }).await
    }
    pub async fn dismiss_profile_operation(&self, slot: &str, id: &str) -> Result<bool, Error> {
        self.ready()?;
        let _guard = self.command_lock.lock().await;
        self.ready()?;
        Ok(self.store.dismiss_profile_operation(slot, id)?)
    }
    pub(super) async fn finish_profile_operation(&self, saved: &SavedProfileOperation) -> Result<OwnProfile, Error> {
        let result = self.apply_profile_operation(saved).await;
        if let Err(error) = &result {
            if error.terminal() {
                self.shutdown();
                self.set_failure(error);
            } else if error.code() == "reauthentication_required" {
                self.store.mark_profile_operation(saved, "proof", Some(error.code()))?;
            } else if permanent_command_error(error) {
                self.store.mark_profile_operation(saved, "failed", Some(error.code()))?;
            } else {
                self.wake.notify_one();
            }
        }
        result
    }
    async fn apply_profile_operation(&self, saved: &SavedProfileOperation) -> Result<OwnProfile, Error> {
        let _guard = self.command_lock.lock().await;
        self.ready()?;
        let generation = self.security_generation.load(Ordering::SeqCst);
        self.identity().await?;
        self.profile_generation(generation)?;
        let Some(current) = self
            .store
            .profile_operation(saved.command.slot())?
            .filter(|s| s.phase == "pending" && s.command.id() == saved.command.id())
        else {
            return self.own_profile().await;
        };
        if !self.profiles_supported(matches!(&current.command, ProfileOperation::Avatar { .. })) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let receipt = match &current.command {
            ProfileOperation::Profile { input } => self.client.update_profile(input).await?,
            ProfileOperation::Preferences { input } => self.client.update_preferences(input).await?,
            ProfileOperation::Avatar { input, upload } => {
                let bytes = upload.as_ref().map(|u| u.bytes().ok_or(Error::Protocol("invalid_avatar"))).transpose()?;
                self.client.set_avatar(input, upload.as_ref().map(|u| u.mime.as_str()).zip(bytes)).await?
            }
        };
        self.profile_generation(generation)?;
        let own = self.own_profile().await?;
        self.profile_generation(generation)?;
        self.store.confirm_profile_operation(saved, &receipt, || {
            !self.is_closed() && generation == self.security_generation.load(Ordering::SeqCst)
        })?;
        Ok(own)
    }
    /// A photo still worn: by a person the store knows, or by one of my bots.
    pub fn avatar_current(&self, id: &str) -> Result<bool, Error> {
        if self.is_closed() {
            return Ok(false);
        }
        if self.bot_avatars.lock().unwrap().values().any(|file| file == id) {
            return Ok(true);
        }
        Ok(self.store.avatar_current(id)?)
    }
    pub async fn profile_avatar(&self, id: &str) -> Result<Vec<u8>, Error> {
        self.ready()?;
        if !self.profiles_supported(true) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let generation = self.security_generation.load(Ordering::SeqCst);
        self.identity().await?;
        self.profile_generation(generation)?;
        if id.len() != 64
            || !id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || !self.avatar_current(id)?
        {
            return Err(Error::Protocol("avatar_retired"));
        }
        let _permit = self.avatar_slots.acquire().await.map_err(|_| Error::Protocol("session_closed"))?;
        self.profile_generation(generation)?;
        if !self.avatar_current(id)? {
            return Err(Error::Protocol("avatar_retired"));
        }
        if let Some(bytes) = self.avatars.lock().unwrap().get(id) {
            return Ok(bytes);
        }
        let bytes = self.client.avatar_bytes(id).await?;
        self.identity().await?;
        self.profile_generation(generation)?;
        if !self.avatar_current(id)? {
            return Err(Error::Protocol("avatar_retired"));
        }
        self.avatars.lock().unwrap().put(id, bytes.clone());
        Ok(bytes)
    }
}
