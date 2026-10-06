//! Explicit native pilot API. Legacy Chat never receives a native bearer token.
use crate::model::{self, Account, MessageItem, RoomGroup, RvError};
use crate::{Client, Event, Found, Listener, accounts, blocking, on_tokio, runtime};
use rv_core::native::NativeSession;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast::error::RecvError;

struct CredentialStore {
    dirs: Arc<accounts::Dirs>,
}
impl rv_core::native::credentials::Provider for CredentialStore {
    fn resume(&self, expected: rv_core::session::SessionInfo) -> rv_core::native::credentials::CredentialFuture {
        let dirs = self.dirs.clone();
        Box::pin(async move {
            use rv_core::native::{Error, credentials};
            let lease = Arc::new(credentials::lease(&dirs.config, &expected).await?);
            let key = expected.clone();
            let reading = lease.clone();
            let record = blocking(move || {
                let _lease = reading;
                accounts::native_record(&key)
            })
            .await
            .map_err(|_| Error::Protocol("secure_storage_unavailable"))?;
            if record.info.base_url != expected.base_url
                || record.info.user_id != expected.user_id
                || record.info.native != expected.native
            {
                return Err(Error::Protocol("server_identity_changed"));
            }
            let prior = Arc::new(Mutex::new(record.info.auth_token.clone()));
            let fresh = credentials::prepare(record, move |record| {
                let (lease, prior) = (lease.clone(), prior.clone());
                async move {
                    let token = prior.lock().unwrap().clone();
                    let next = record.info.auth_token.clone();
                    blocking(move || {
                        let _lease = lease;
                        accounts::replace_native_record(&record, &token)
                    })
                    .await
                    .map_err(|_| Error::Protocol("secure_storage_unavailable"))?;
                    *prior.lock().unwrap() = next;
                    Ok(())
                }
            })
            .await?;
            Ok(fresh.info)
        })
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeRoom {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub encrypted: bool,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeMessage {
    pub id: String,
    pub text: String,
    pub author: String,
    pub status: Option<String>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeQuoteSelection {
    pub message_id: String,
    pub room_id: String,
    pub revision: String,
    pub instance_id: String,
    pub data_epoch: String,
    pub membership_version: String,
}
impl From<rv_core::native::store::QuoteSelection> for NativeQuoteSelection {
    fn from(value: rv_core::native::store::QuoteSelection) -> Self {
        Self {
            message_id: value.reference.message_id,
            room_id: value.reference.room_id,
            revision: value.reference.revision,
            instance_id: value.identity.instance_id,
            data_epoch: value.identity.data_epoch,
            membership_version: value.membership_version,
        }
    }
}
impl NativeQuoteSelection {
    fn into_core(self) -> rv_core::native::store::QuoteSelection {
        rv_core::native::store::QuoteSelection {
            reference: rv_core::native::store::QuoteReference {
                message_id: self.message_id,
                room_id: self.room_id,
                revision: self.revision,
            },
            identity: rv_core::native::Identity { instance_id: self.instance_id, data_epoch: self.data_epoch },
            membership_version: self.membership_version,
        }
    }
}
#[derive(Clone, uniffi::Record)]
pub struct NativeMessageActions {
    pub message_id: String,
    pub text: String,
    pub revision: String,
    pub edit: bool,
    pub delete: bool,
    pub react: bool,
    pub pin: bool,
    pub star: bool,
    pub edit_until: Option<String>,
    pub draft: Option<String>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeStatus {
    pub state: crate::ConnectionState,
    pub error: Option<String>,
    pub request_id: Option<String>,
    pub retry_after: Option<u64>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeNotificationTarget {
    pub rid: String,
    pub root: Option<String>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeRoomReadState {
    pub membership: String,
    pub root_position: String,
    pub reply_position: String,
    pub unread_roots: String,
    pub unread_replies: String,
    pub mentions: String,
    pub group_mentions: String,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeFavoriteIntention {
    pub key: String,
    pub present: bool,
    pub failed: bool,
    pub error: Option<String>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeFavoriteState {
    pub membership: String,
    pub revision: String,
    pub present: bool,
    pub intention: Option<NativeFavoriteIntention>,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeDeviceSession {
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub last_seen_at: String,
    pub expires_at: String,
    pub current: bool,
}
#[derive(uniffi::Object)]
pub struct NativeChat {
    pub(crate) session: Arc<NativeSession>,
    pub(crate) dirs: Arc<accounts::Dirs>,
    forward: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Drop for NativeChat {
    fn drop(&mut self) {
        if let Some(task) = self.forward.lock().unwrap().take() {
            task.abort();
        }
        self.session.shutdown();
    }
}

#[uniffi::export]
impl Client {
    /// Whether the signed-in account `key` (not the open one) has unread
    /// messages, for the dot in the server rail: one read, never its store.
    /// `None` when it cannot tell (offline, refused, unknown key).
    pub async fn account_unread(&self, key: String) -> Option<bool> {
        let dirs = self.dirs.clone();
        let info = blocking(move || {
            crate::accounts::load_all(&dirs).into_iter().find(|info| crate::accounts::key(info) == key)
        })
        .await?;
        let store = Arc::new(CredentialStore { dirs: self.dirs.clone() });
        on_tokio(async move {
            if info.native.is_some() {
                rv_core::account_unread::native(info, Some(store)).await.ok()
            } else {
                rv_core::account_unread::rocket_chat(&info).await.ok()
            }
        })
        .await
    }
    /// Whether the address is a RocketVibe server, under the user's choice of kind.
    pub async fn is_native_server(&self, server: String, kind: crate::model::ServerChoice) -> Result<bool, RvError> {
        let url =
            rv_core::session::normalize_server(&server).ok_or_else(|| RvError::local("invalid server address"))?;
        on_tokio(async move { rv_core::native::probe_as(&url, kind.into()).await.map(|p| p.is_some()) })
            .await
            .map_err(native_error)
    }
    pub async fn native_login(
        &self,
        server: String,
        user: String,
        password: String,
    ) -> Result<Arc<NativeChat>, RvError> {
        let url =
            rv_core::session::normalize_server(&server).ok_or_else(|| RvError::local("invalid server address"))?;
        let info = on_tokio(async move {
            let discovery =
                rv_core::native::probe(&url).await?.ok_or(rv_core::native::Error::Protocol("not_native"))?;
            rv_core::native::login(&url, &discovery, &user, &password).await
        })
        .await
        .map_err(native_error)?;
        self.save_native_login(info).await
    }
    pub async fn native_register(
        &self,
        server: String,
        user: String,
        password: String,
        invitation: String,
    ) -> Result<Arc<NativeChat>, RvError> {
        let url =
            rv_core::session::normalize_server(&server).ok_or_else(|| RvError::local("invalid server address"))?;
        let info = on_tokio(async move {
            let discovery =
                rv_core::native::probe(&url).await?.ok_or(rv_core::native::Error::Protocol("not_native"))?;
            rv_core::native::register(&url, &discovery, &invitation, &user, &password).await
        })
        .await
        .map_err(native_error)?;
        self.save_native_login(info).await
    }
    pub async fn native_resume(&self, key: String) -> Result<Arc<NativeChat>, RvError> {
        let dirs = self.dirs.clone();
        let info = blocking(move || accounts::load_all(&dirs))
            .await
            .into_iter()
            .find(|i| accounts::key(i) == key && i.native.is_some())
            .ok_or_else(|| RvError::local("unknown native account"))?;
        self.start_native(info)
    }
    pub async fn native_recover(
        &self,
        server: String,
        user: String,
        password: String,
        code: String,
    ) -> Result<Arc<NativeChat>, RvError> {
        let url =
            rv_core::session::normalize_server(&server).ok_or_else(|| RvError::local("invalid server address"))?;
        let info = on_tokio(async move {
            let discovery =
                rv_core::native::probe(&url).await?.ok_or(rv_core::native::Error::Protocol("not_native"))?;
            rv_core::native::recover(&url, &discovery, &code, &user, &password).await
        })
        .await
        .map_err(native_error)?;
        self.save_native_login(info).await
    }
}
impl Client {
    async fn save_native_login(&self, info: rv_core::session::SessionInfo) -> Result<Arc<NativeChat>, RvError> {
        let (dirs, saved) = (self.dirs.clone(), info.clone());
        blocking(move || {
            accounts::remember_server(&dirs, &saved.base_url);
            accounts::save(&dirs, &saved, None)
        })
        .await
        .map_err(RvError::local)?;
        self.start_native(info)
    }
    pub(crate) fn start_native(&self, info: rv_core::session::SessionInfo) -> Result<Arc<NativeChat>, RvError> {
        let path = self.dirs.database(&info);
        let _guard = runtime().enter();
        Ok(Arc::new(NativeChat {
            session: NativeSession::start_with_credentials(
                info,
                &path,
                Some(Arc::new(CredentialStore { dirs: self.dirs.clone() })),
            )
            .map_err(RvError::local)?,
            dirs: self.dirs.clone(),
            forward: Mutex::default(),
        }))
    }
}
#[uniffi::export]
impl NativeChat {
    pub fn typing(&self, room: String, root: Option<String>) -> Vec<String> {
        self.session.typing(&room, root.as_deref())
    }
    pub async fn set_typing(
        &self,
        room: String,
        root: Option<String>,
        active: bool,
        membership: Option<String>,
    ) -> Result<(), RvError> {
        let session = self.session.clone();
        on_tokio(async move {
            session.set_typing_from_membership(&room, root.as_deref(), active, membership.as_deref()).await
        })
        .await
        .map_err(native_error)
    }
    pub async fn room_details(&self, room: String) -> Result<crate::people::RoomDetails, RvError> {
        let session = self.session.clone();
        Ok(on_tokio(async move { session.room_info(&room).await }).await.map_err(native_error)?.into())
    }
    pub fn room_revision(&self, room: String) -> Result<String, RvError> {
        if self.session.is_closed() {
            return Err(native_error(rv_core::native::Error::Protocol("session_closed")));
        }
        self.session
            .store
            .rooms()
            .map_err(|e| native_error(e.into()))?
            .into_iter()
            .find(|r| r.id == room)
            .map(|r| r.revision)
            .ok_or_else(|| native_error(rv_core::native::Error::Protocol("room_missing")))
    }
    /// Synchronous: the UI calls this only after its account-selection guard.
    pub fn activate_account(&self) {
        accounts::remember_server(&self.dirs, &self.session.info.base_url);
        accounts::set_active(&self.dirs, &self.session.info);
    }
    pub async fn device_sessions(&self) -> Result<Vec<NativeDeviceSession>, RvError> {
        let s = self.session.clone();
        let devices = on_tokio(async move { s.device_sessions().await }).await.map_err(native_error)?;
        Ok(devices
            .into_iter()
            .map(|d| NativeDeviceSession {
                id: d.id,
                label: d.label,
                created_at: d.created_at,
                last_seen_at: d.last_seen_at,
                expires_at: d.expires_at,
                current: d.current,
            })
            .collect())
    }
    pub async fn rename_device(&self, id: String, label: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.rename_device(&id, &label).await }).await.map_err(native_error)
    }
    pub async fn revoke_device(&self, id: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.revoke_device(&id).await }).await.map_err(native_error)
    }
    /// Shared UI events; callbacks cease when this provider is shut down.
    pub fn set_listener(&self, listener: Arc<dyn Listener>) {
        let (mut changes, mut events, mut incoming) =
            (self.session.store.changes(), self.session.events(), self.session.incoming());
        let session = Arc::downgrade(&self.session);
        let task = runtime().spawn(async move {
            let mut profiles = String::new();
            loop {
                let Some(s) = session.upgrade() else { return };
                let version = format!("{}:{}:{}", s.profile_version(), s.file_version(), s.emoji_version());
                if version != profiles {
                    profiles = version;
                    listener.on_event(Event::Avatar);
                }
                listener.on_event(Event::Connection { state: crate::state(s.status().connection) });
                listener.on_event(Event::Resync);
                drop(s);
                let next = tokio::select! {
                    c = changes.recv() => c, e = events.recv() => e,
                    n = incoming.recv() => {
                        match n {
                            Ok(n) => if let Some(s)=session.upgrade() && s.notification_current(&n) {
                                listener.on_event(crate::event(rv_core::session::SessionEvent::Incoming(Box::new(n))));
                            },
                            Err(RecvError::Closed)=>return,
                            Err(RecvError::Lagged(_))=>{},
                        }
                        continue;
                    }
                };
                if matches!(next, Err(RecvError::Closed)) {
                    return;
                }
            }
        });
        if let Some(old) = self.forward.lock().unwrap().replace(task) {
            old.abort();
        }
    }
    /// The existing sidebar consumes the same grouped rows for both providers.
    pub fn room_groups(&self) -> Result<Vec<RoomGroup>, RvError> {
        let rows = self.session.room_rows().map_err(native_error)?;
        Ok(rv_core::rooms::sections(&rows)
            .into_iter()
            .map(|(section, rows)| RoomGroup {
                section: section.into(),
                rooms: rows
                    .into_iter()
                    .map(|row| {
                        let presence = self.session.room_presence(&row.rid).map(crate::Presence::from);
                        let avatar = row.avatar_etag.clone().map(|id| format!("rv-avatar:{id}"));
                        let mut room = model::room(row, None, presence);
                        room.avatar = avatar;
                        room
                    })
                    .collect(),
            })
            .collect())
    }
    pub fn notification_key(&self, rid: String) -> String {
        self.session.notification_key(&rid)
    }
    pub fn notification_target(&self, key: String, message: String) -> Option<NativeNotificationTarget> {
        self.session.notification_target(&key, &message).map(|(rid, root)| NativeNotificationTarget { rid, root })
    }
    pub fn reply_notification(&self, key: String, message: String, text: String) -> Result<String, RvError> {
        self.session.reply_notification(&key, &message, &text).map_err(native_error)
    }
    pub fn withdrawn_notifications(&self) -> Vec<String> {
        self.session.withdrawn_notifications()
    }

    /// Preserve journal sequence order, then apply the existing grouping and Markdown renderer.
    pub fn message_items(&self, room: String, limit: u32) -> Result<Vec<MessageItem>, RvError> {
        let rows = self.session.store.messages(&room, limit.clamp(1, 10_000) as usize).map_err(RvError::local)?;
        Ok(self.with_profile_avatars(native_message_items(
            rows,
            &room,
            &self.session.info.user_id,
            &self.session.info.username,
            None,
        )))
    }
    pub fn thread_message_items(
        &self,
        room: String,
        root: String,
        membership: String,
    ) -> Result<Vec<MessageItem>, RvError> {
        self.room_revision(room.clone())?;
        if self.membership_version(room.clone())?.as_deref() != Some(membership.as_str()) {
            return Ok(vec![]);
        }
        let rows = self.session.store.thread_messages(&room, &root).map_err(RvError::local)?;
        Ok(self.with_profile_avatars(native_message_items(
            rows,
            &room,
            &self.session.info.user_id,
            &self.session.info.username,
            None,
        )))
    }
    pub async fn load_thread(&self, room: String, root: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.load_thread(&room, &root).await }).await.map_err(native_error)
    }
    pub fn thread_writable(&self, room: String, root: String) -> Result<bool, RvError> {
        self.room_revision(room.clone())?;
        self.session.store.thread_writable(&room, &root).map_err(RvError::local)
    }
    pub fn message_items_from_boundary(
        &self,
        room: String,
        limit: u32,
        membership: String,
        root_position: String,
    ) -> Result<Vec<MessageItem>, RvError> {
        self.room_revision(room.clone())?;
        if self
            .session
            .store
            .read_state(&room)
            .map_err(RvError::local)?
            .as_ref()
            .and_then(|s| s.membership_version.as_deref())
            != Some(membership.as_str())
        {
            return Ok(vec![]);
        }
        let rows = self.session.store.messages(&room, limit.clamp(1, 10_000) as usize).map_err(RvError::local)?;
        Ok(self.with_profile_avatars(native_message_items(
            rows,
            &room,
            &self.session.info.user_id,
            &self.session.info.username,
            self.session.supported_features().iter().any(|f| f == "read_markers").then_some(root_position.as_str()),
        )))
    }
    pub async fn spotlight(&self, query: String) -> Result<Vec<Found>, RvError> {
        let s = self.session.clone();
        let found = on_tokio(async move { s.spotlight(&query).await }).await.map_err(native_error)?;
        Ok(found
            .into_iter()
            .map(|f| match f {
                rv_core::rooms::Found::User { id, username, name } => Found::User { id, username, name },
                rv_core::rooms::Found::Room { id, name, kind } => Found::Room { id, name, kind },
            })
            .collect())
    }
    pub fn account(&self) -> Account {
        crate::account(&self.session.info)
    }
    pub fn status(&self) -> NativeStatus {
        let status = self.session.status();
        NativeStatus {
            state: crate::state(status.connection),
            error: status.error,
            request_id: status.request_id,
            retry_after: status.retry_after,
        }
    }
    pub fn supported_features(&self) -> Vec<String> {
        self.session.supported_features()
    }
    pub fn room_read_state(&self, room: String) -> Result<Option<NativeRoomReadState>, RvError> {
        self.room_revision(room.clone())?;
        let Some(state) = self.session.store.read_state(&room).map_err(RvError::local)? else { return Ok(None) };
        let Some(membership) = state.membership_version else { return Ok(None) };
        Ok(Some(NativeRoomReadState {
            membership,
            root_position: state.root_position,
            reply_position: state.reply_position,
            unread_roots: state.unread_roots,
            unread_replies: state.unread_replies,
            mentions: state.mentions,
            group_mentions: state.group_mentions,
        }))
    }
    pub fn mark_observed_read(&self, room: String, message: String, membership: String) -> Result<bool, RvError> {
        self.session.mark_observed_read_from_membership(&room, &message, &membership).map_err(native_error)
    }
    pub fn mark_observed_thread_read(
        &self,
        root: String,
        message: String,
        membership: String,
    ) -> Result<bool, RvError> {
        self.session.mark_observed_thread_read(&root, &message, &membership).map_err(native_error)
    }
    pub fn favorite_state(&self, room: String) -> Result<Option<NativeFavoriteState>, RvError> {
        self.room_revision(room.clone())?;
        let Some(state) = self.session.store.read_state(&room).map_err(RvError::local)? else { return Ok(None) };
        let (Some(membership), Some(revision)) = (state.membership_version, state.favorite_revision) else {
            return Ok(None);
        };
        let intention = self
            .session
            .store
            .favorite_intent(&room)
            .map_err(RvError::local)?
            .filter(|s| s.membership == membership)
            .map(|s| NativeFavoriteIntention {
                key: s.input.operation_id,
                present: s.input.present,
                failed: s.phase == "failed",
                error: s.error,
            });
        Ok(Some(NativeFavoriteState { membership, revision, present: state.favorite, intention }))
    }
    pub fn set_favorite_from_state(
        &self,
        room: String,
        present: bool,
        membership: String,
        revision: String,
    ) -> Result<(), RvError> {
        self.session.set_favorite_from_state(&room, present, &membership, &revision).map_err(native_error)
    }
    pub fn resume_favorite(&self, room: String, key: String) -> Result<(), RvError> {
        self.room_revision(room.clone())?;
        if self
            .session
            .store
            .favorite_intent(&room)
            .map_err(RvError::local)?
            .is_none_or(|s| s.input.operation_id != key)
        {
            return Err(native_error(rv_core::native::Error::Protocol("favorite_action_missing")));
        }
        self.session.resume_favorite(&room).map_err(native_error)
    }
    pub fn dismiss_failed_favorite(&self, room: String, key: String) -> Result<bool, RvError> {
        self.session.dismiss_failed_favorite(&room, &key).map_err(native_error)
    }
    pub fn security_supported(&self) -> bool {
        self.session.security_supported()
    }
    pub fn crypto_settings_supported(&self) -> bool {
        self.session.crypto_settings_supported()
    }
    pub async fn crypto_messages(
        &self,
        room: String,
        thread: Option<String>,
    ) -> Result<Arc<crate::native_crypto::messages::NativeCryptoMessages>, RvError> {
        let (session, dirs) = (self.session.clone(), self.dirs.clone());
        on_tokio(async move {
            crate::native_crypto::messages::NativeCryptoMessages::open(session, dirs, room, thread).await
        })
        .await
        .map_err(crate::native_crypto::error)
    }
    pub async fn crypto_quote_composer(
        &self,
        room: String,
        thread: Option<String>,
    ) -> Result<Arc<crate::native_crypto::quote_composer::NativeCryptoQuoteComposer>, RvError> {
        let (session, dirs) = (self.session.clone(), self.dirs.clone());
        on_tokio(async move {
            crate::native_crypto::quote_composer::NativeCryptoQuoteComposer::open(session, dirs, room, thread).await
        })
        .await
        .map_err(crate::native_crypto::error)
    }
    pub async fn crypto_quote_reader(
        &self,
        room: String,
    ) -> Result<Arc<crate::native_crypto::quote_reader::NativeCryptoQuoteReader>, RvError> {
        let (session, dirs) = (self.session.clone(), self.dirs.clone());
        on_tokio(
            async move { crate::native_crypto::quote_reader::NativeCryptoQuoteReader::open(session, dirs, room).await },
        )
        .await
        .map_err(crate::native_crypto::error)
    }
    pub async fn crypto_room(
        &self,
        room: String,
    ) -> Result<Arc<crate::native_crypto::rooms::NativeCryptoRoom>, RvError> {
        let (session, dirs) = (self.session.clone(), self.dirs.clone());
        on_tokio(async move { crate::native_crypto::rooms::NativeCryptoRoom::open(session, dirs, room).await })
            .await
            .map_err(|e| match e {
                rv_core::native::crypto::Error::Session(e) => native_error(e),
                _ => RvError::Local { message: "crypto_operation_failed".into() },
            })
    }
    pub async fn crypto_peer(
        &self,
        user: String,
    ) -> Result<Arc<crate::native_crypto::peers::NativeCryptoPeer>, RvError> {
        let (session, dirs) = (self.session.clone(), self.dirs.clone());
        on_tokio(async move { crate::native_crypto::peers::NativeCryptoPeer::open(session, dirs, user).await })
            .await
            .map_err(|e| match e {
                rv_core::native::crypto::Error::Session(e) => native_error(e),
                _ => RvError::Local { message: "crypto_operation_failed".into() },
            })
    }
    pub async fn crypto_settings(&self) -> Result<Arc<crate::native_crypto::NativeCrypto>, RvError> {
        let (session, dirs) = (self.session.clone(), self.dirs.clone());
        on_tokio(async move { crate::native_crypto::NativeCrypto::open(session, dirs).await }).await.map_err(
            |e| match e {
                rv_core::native::crypto::Error::Session(e) => native_error(e),
                _ => RvError::Local { message: "crypto_operation_failed".into() },
            },
        )
    }
    pub async fn security(&self) -> Result<Arc<crate::native_security::NativeSecurity>, RvError> {
        let (session, dirs) = (self.session.clone(), self.dirs.clone());
        on_tokio(async move { crate::native_security::NativeSecurity::open(session, dirs).await })
            .await
            .map_err(native_error)
    }
    pub fn rooms(&self) -> Result<Vec<NativeRoom>, RvError> {
        Ok(self
            .session
            .store
            .rooms()
            .map_err(RvError::local)?
            .into_iter()
            .map(|r| NativeRoom {
                id: r.id,
                name: r.name,
                encrypted: r.encrypted,
                kind: match r.kind {
                    rv_core::native::RoomKind::Public => "public",
                    rv_core::native::RoomKind::Private => "private",
                    rv_core::native::RoomKind::Direct => "direct",
                }
                .into(),
            })
            .collect())
    }
    pub fn messages(&self, room: String, limit: u32) -> Result<Vec<NativeMessage>, RvError> {
        Ok(self
            .session
            .store
            .messages(&room, limit.clamp(1, 10_000) as usize)
            .map_err(RvError::local)?
            .into_iter()
            .map(|m| NativeMessage { id: m.id, text: m.text, author: m.author, status: m.status })
            .collect())
    }
    pub fn send(&self, room: String, text: String) -> Result<String, RvError> {
        self.session.send(&room, &text).map_err(RvError::local)
    }
    pub fn membership_version(&self, room: String) -> Result<Option<String>, RvError> {
        self.room_revision(room.clone())?;
        Ok(self.session.store.read_state(&room).map_err(RvError::local)?.and_then(|s| s.membership_version))
    }
    pub fn send_from_membership(
        &self,
        room: String,
        text: String,
        membership: Option<String>,
    ) -> Result<String, RvError> {
        self.session.send_from_membership(&room, &text, membership.as_deref()).map_err(native_error)
    }
    pub fn quote_selection(&self, room: String, message_id: String) -> Result<NativeQuoteSelection, RvError> {
        self.room_revision(room.clone())?;
        self.session.store.quote_selection(&room, &message_id).map(Into::into).map_err(RvError::local)
    }
    pub fn send_quotes_from_membership(
        &self,
        room: String,
        text: String,
        membership: Option<String>,
        quotes: Vec<NativeQuoteSelection>,
    ) -> Result<String, RvError> {
        let quotes: Vec<_> = quotes.into_iter().map(NativeQuoteSelection::into_core).collect();
        self.session.send_quotes_from_membership(&room, &text, membership.as_deref(), &quotes).map_err(native_error)
    }
    pub fn draft_from_membership(&self, room: String, membership: Option<String>) -> Result<String, RvError> {
        self.session.store.draft_from_membership(&room, membership.as_deref()).map_err(RvError::local)
    }
    pub fn send_reply_from_membership(
        &self,
        room: String,
        root: String,
        text: String,
        membership: Option<String>,
        quotes: Vec<NativeQuoteSelection>,
    ) -> Result<String, RvError> {
        let quotes: Vec<_> = quotes.into_iter().map(NativeQuoteSelection::into_core).collect();
        self.session
            .send_reply_from_membership(&room, &root, &text, membership.as_deref(), &quotes)
            .map_err(native_error)
    }
    pub fn thread_draft_from_membership(
        &self,
        room: String,
        root: String,
        membership: Option<String>,
    ) -> Result<String, RvError> {
        self.session.store.thread_draft_from_membership(&room, &root, membership.as_deref()).map_err(RvError::local)
    }
    pub fn set_thread_draft_from_membership(
        &self,
        room: String,
        root: String,
        text: String,
        membership: Option<String>,
    ) -> Result<(), RvError> {
        if self.session.is_closed()
            || !self
                .session
                .store
                .set_thread_draft_from_membership(&room, &root, &text, membership.as_deref())
                .map_err(RvError::local)?
        {
            return Err(native_error(rv_core::native::Error::Protocol("delivery_revalidate")));
        }
        Ok(())
    }
    pub fn set_draft_from_membership(
        &self,
        room: String,
        text: String,
        membership: Option<String>,
    ) -> Result<(), RvError> {
        if self.session.is_closed()
            || !self
                .session
                .store
                .set_draft_from_membership(&room, &text, membership.as_deref())
                .map_err(RvError::local)?
        {
            return Err(native_error(rv_core::native::Error::Protocol("delivery_revalidate")));
        }
        Ok(())
    }
    pub fn retry(&self, id: String) -> Result<(), RvError> {
        self.session.retry(&id).map_err(RvError::local)
    }
    pub fn abandon(&self, id: String) -> Result<(), RvError> {
        self.session.abandon(&id).map_err(RvError::local)
    }
    pub fn draft(&self, room: String) -> Result<String, RvError> {
        self.session.store.draft(&room).map_err(RvError::local)
    }
    pub fn set_draft(&self, room: String, text: String) -> Result<(), RvError> {
        self.session.store.set_draft(&room, &text).map_err(RvError::local)
    }
    pub fn reconnect(&self) {
        self.session.reconnect();
    }
    pub fn suspend(&self) {
        self.session.suspend();
    }
    pub fn shutdown(&self) {
        if let Some(task) = self.forward.lock().unwrap().take() {
            task.abort();
        }
        self.session.shutdown();
    }
    pub async fn history(&self, room: String, older: bool) -> Result<bool, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.history(&room, older).await }).await.map_err(RvError::local)
    }
    pub async fn message_actions(&self, message_id: String) -> Result<NativeMessageActions, RvError> {
        let s = self.session.clone();
        let (message, rights) =
            on_tokio(async move { s.message_action_context(&message_id).await }).await.map_err(native_error)?;
        let draft = self.session.store.command_draft(&message.id).map_err(RvError::local)?;
        Ok(NativeMessageActions {
            message_id: message.id,
            text: message.text,
            revision: rights.revision,
            edit: rights.edit,
            delete: rights.delete,
            react: rights.react,
            pin: rights.pin,
            star: rights.star,
            edit_until: rights.edit_until,
            draft,
        })
    }
    pub async fn edit(&self, room: String, message_id: String, revision: String, text: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.edit(&room, &message_id, &revision, &text).await }).await.map_err(native_error)
    }
    pub async fn delete(&self, room: String, message_id: String, revision: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.delete(&room, &message_id, &revision).await }).await.map_err(native_error)
    }
    pub async fn react(&self, room: String, message_id: String, emoji: String, present: bool) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.react(&room, &message_id, &emoji, present).await }).await.map_err(native_error)
    }
    pub async fn create_room(&self, name: String, private: bool) -> Result<String, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.create_room(&name, private, false).await }).await.map_err(RvError::local)
    }
    pub async fn set_mark(
        &self,
        room: String,
        message_id: String,
        present: bool,
        starred: bool,
    ) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.set_mark(&room, &message_id, present, starred).await }).await.map_err(native_error)
    }
    pub fn search_version(&self) -> Result<String, RvError> {
        self.session.search_version().map_err(native_error)
    }
    pub async fn search(&self, room: String, text: String) -> Result<Vec<crate::people::SearchHit>, RvError> {
        let s = self.session.clone();
        let found = on_tokio(async move { s.search(&room, &text).await }).await.map_err(native_error)?;
        let ctx = rv_core::markdown::Context { me: &self.session.info.username };
        Ok(found
            .into_iter()
            .map(|m| crate::people::SearchHit {
                body: crate::markup::blocks(rv_core::markdown::render(m.md.as_deref(), m.text.as_deref(), &ctx)),
                author: m.author_name.unwrap_or_default(),
                id: m.id,
                ts: m.ts,
            })
            .collect())
    }
    pub async fn marked(&self, room: String, starred: bool) -> Result<Vec<MessageItem>, RvError> {
        let (s, rid) = (self.session.clone(), room.clone());
        let messages = on_tokio(async move { s.marked(&rid, starred).await }).await.map_err(native_error)?;
        let ids: Vec<_> = messages.into_iter().map(|m| m.id).collect();
        let rows = self.session.store.selected_messages(&ids).map_err(RvError::local)?;
        Ok(self.with_profile_avatars(native_message_items(
            rows,
            &room,
            &self.session.info.user_id,
            &self.session.info.username,
            None,
        )))
    }
    pub async fn direct(&self, username: String) -> Result<String, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.direct(&username).await }).await.map_err(RvError::local)
    }
    pub async fn join_public(&self, room: String) -> Result<String, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.join_public(&room).await }).await.map_err(native_error)
    }
    pub async fn invite(&self, room: String, username: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.invite(&room, &username).await }).await.map_err(RvError::local)
    }
    pub async fn logout(&self) -> Result<(), RvError> {
        let s = self.session.clone();
        if let Err(error) = on_tokio(async move { s.logout().await }).await
            && !matches!(error.code(), "session_rejected" | "server_identity_changed")
        {
            return Err(RvError::local(error));
        }
        self.session.shutdown();
        self.session.store.clear().map_err(RvError::local)?;
        let (dirs, info) = (self.dirs.clone(), self.session.info.clone());
        blocking(move || accounts::remove(&dirs, &info)).await;
        Ok(())
    }
}

/// What a draft run as a slash command left to do.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum CommandRun {
    /// Not a command the server lists: send the draft as it is.
    NotCommand,
    /// A text command (`/shrug`): send this instead, the way the room sends.
    Message { text: String },
    /// Done by the server, or nothing to send.
    Done,
}

#[uniffi::export]
impl NativeChat {
    /// Reads the server's slash commands, once, for `suggestions`.
    pub async fn prepare_commands(&self) {
        let s = self.session.clone();
        on_tokio(async move {
            let _ = s.commands().await;
        })
        .await
    }
    /// Runs `text` as a slash command when it names one the server lists. A
    /// refusal's message says why, in words.
    pub async fn run_command(&self, room: String, text: String) -> Result<CommandRun, RvError> {
        let s = self.session.clone();
        match on_tokio(async move { s.run_command(&room, &text).await }).await {
            None => Ok(CommandRun::NotCommand),
            Some(Ok(rv_core::commands::Run::Message(text))) => Ok(CommandRun::Message { text }),
            Some(Ok(rv_core::commands::Run::Done)) => Ok(CommandRun::Done),
            Some(Err(error)) => Err(RvError::Local {
                message: rv_core::i18n::t(rv_core::commands::error_key(error.code()).unwrap_or("native.error"))
                    .to_owned(),
            }),
        }
    }
}

fn native_error(error: rv_core::native::Error) -> RvError {
    rv_core::native::rest_error(error).into()
}

fn native_message_items(
    rows: Vec<rv_core::native::store::MessageRow>,
    rid: &str,
    uid: &str,
    username: &str,
    after: Option<&str>,
) -> Vec<MessageItem> {
    rv_core::native::read_presentation::group(rows, rid, uid, after)
        .into_iter()
        .map(|row| {
            let mut item = model::message(row, uid, username);
            item.avatar.clear();
            item
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reader_scoped_quotes_cross_sqlite_and_the_existing_swift_message_models() {
        use serde_json::json;
        let store = rv_core::native::store::NativeStore::open(
            std::path::Path::new(":memory:"),
            rv_core::native::Identity { instance_id: "instance".into(), data_epoch: "epoch".into() },
        )
        .unwrap();
        let author = json!({"id":"alice-id","username":"alice","display_name":"Alice"});
        let source = json!({"id":"source","room_id":"origin","author":author,"text":"","created_at":"2026-10-02T08:00:00Z","position":"10","revision":"30","deleted":true});
        store.snapshot(&serde_json::from_value(json!({
            "protocol_version":1,"cursor":"initial",
            "rooms":[{"id":"destination","name":"Destination","kind":"private","revision":"1"},{"id":"origin","name":"Origin","kind":"private","revision":"1","read_state":{
                "room_id":"origin","revision":"1","membership_version":"source-grant","favorite_revision":"1","root_position":"0","reply_position":"0","unread_roots":"0","unread_replies":"0","mentions":"0","group_mentions":"0","favorite":false
            }}],
            "messages":[{"id":"reply","room_id":"destination","author":author,"text":"Réponse","created_at":"2026-10-02T08:00:00Z","position":"20","revision":"20","quotes":[{
                "reference":{"room_id":"origin","message_id":"source","revision":"10"},"view_position":"20","source_membership_version":"source-grant","excerpt":{
                    "author":author,"text":"`<secret>` *gras*","created_at":"2026-10-02T08:00:00Z","revision":"10","membership_version":"source-grant"
                }
            }]}]
        })).unwrap()).unwrap();
        let items =
            || native_message_items(store.messages("destination", 50).unwrap(), "destination", "me", "me", None);
        let before = items();
        assert_eq!(before[0].quotes.len(), 1);
        assert!(!before[0].quotes[0].unavailable);
        assert_eq!(before[0].quotes[0].author.as_deref(), Some("alice"));
        let crate::markup::BodyBlock::Paragraph { runs } = &before[0].quotes[0].body[0] else {
            panic!("missing quoted body")
        };
        assert!(runs.iter().any(|r| r.code && r.text == "<secret>"));
        assert!(runs.iter().any(|r| r.bold && r.text == "gras"));
        store.ingest(&[serde_json::from_value(source).unwrap()]).unwrap();
        let after = items();
        assert_eq!(after[0].quotes.len(), 1);
        assert!(after[0].quotes[0].unavailable);
        assert!(after[0].quotes[0].author.is_none());
        assert!(after[0].quotes[0].body.is_empty());
        assert_eq!(after[0].text.as_deref(), Some("Réponse"));
    }
    #[test]
    fn native_rows_use_the_shared_renderer_without_reordering_or_rc_avatars() {
        let row = |id: &str, ts, status| rv_core::native::store::MessageRow {
            id: id.into(),
            position: None,
            text: "**hello** :smile:".into(),
            body: None,
            system_type: None,
            attachments: None,
            urls: None,
            author: "alice".into(),
            author_id: "alice-id".into(),
            ts,
            status,
            edited: false,
            reactions: None,
            pinned: false,
            starred: false,
            reply_to: None,
            thread_replies: 0,
        };
        let items = native_message_items(
            vec![
                row("later-clock", 2000, None),
                row("later-sequence", 1000, None),
                row("pending", 3000, Some("failed".into())),
            ],
            "room",
            "me",
            "me",
            None,
        );
        assert_eq!(
            items.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["later-clock", "later-sequence", "pending"]
        );
        assert!(!items[0].body.is_empty());
        assert!(!items[0].mine);
        assert!(items[2].mine);
        assert_eq!(items[2].delivery, model::Delivery::Failed);
        assert!(items.iter().all(|m| m.avatar.is_empty()));
    }
}
