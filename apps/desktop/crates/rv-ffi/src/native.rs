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
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeMessage {
    pub id: String,
    pub text: String,
    pub author: String,
    pub status: Option<String>,
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
    session: Arc<NativeSession>,
    dirs: Arc<accounts::Dirs>,
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
    pub async fn is_native_server(&self, server: String) -> Result<bool, RvError> {
        let url =
            rv_core::session::normalize_server(&server).ok_or_else(|| RvError::local("invalid server address"))?;
        on_tokio(async move { rv_core::native::probe(&url).await.map(|p| p.is_some()) }).await.map_err(native_error)
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
        let (dirs, saved) = (self.dirs.clone(), info.clone());
        blocking(move || {
            accounts::remember_server(&dirs, &saved.base_url);
            accounts::save(&dirs, &saved, None)
        })
        .await
        .map_err(RvError::local)?;
        self.start_native(info)
    }
    pub async fn native_resume(&self, key: String) -> Result<Arc<NativeChat>, RvError> {
        let dirs = self.dirs.clone();
        let info = blocking(move || accounts::load_all(&dirs))
            .await
            .into_iter()
            .find(|i| accounts::key(i) == key && i.native.is_some())
            .ok_or_else(|| RvError::local("unknown native account"))?;
        accounts::set_active(&self.dirs, &info);
        self.start_native(info)
    }
}
impl Client {
    fn start_native(&self, info: rv_core::session::SessionInfo) -> Result<Arc<NativeChat>, RvError> {
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
        let (mut changes, mut events) = (self.session.store.changes(), self.session.events());
        let session = Arc::downgrade(&self.session);
        let task = runtime().spawn(async move {
            loop {
                let Some(s) = session.upgrade() else { return };
                listener.on_event(Event::Connection { state: crate::state(s.status().connection) });
                listener.on_event(Event::Resync);
                drop(s);
                let next = tokio::select! { c = changes.recv() => c, e = events.recv() => e };
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
        let rows = self
            .session
            .store
            .rooms()
            .map_err(RvError::local)?
            .into_iter()
            .map(|room| {
                let last = self.session.store.messages(&room.id, 1).ok().and_then(|mut rows| rows.pop());
                rv_core::store::RoomRow {
                    rid: room.id,
                    kind: match room.kind {
                        rv_core::native::RoomKind::Direct => "d",
                        rv_core::native::RoomKind::Private => "p",
                        rv_core::native::RoomKind::Public => "c",
                    }
                    .into(),
                    name: room.name,
                    last_message: last.as_ref().map(|m| m.text.clone()),
                    last_ts: last.as_ref().map_or(0, |m| m.ts),
                    last_author: last.map(|m| m.author),
                    unread: 0,
                    mentions: 0,
                    alert: false,
                    favorite: false,
                    encrypted: false,
                    read_only: false,
                    dm_other_uid: None,
                    avatar_etag: None,
                    slug: None,
                    last_type: None,
                    last_encrypted: None,
                }
            })
            .collect::<Vec<_>>();
        Ok(rv_core::rooms::sections(&rows)
            .into_iter()
            .map(|(section, rows)| RoomGroup {
                section: section.into(),
                rooms: rows
                    .into_iter()
                    .map(|row| {
                        let mut room = model::room(row, None, None);
                        room.avatar = None;
                        room
                    })
                    .collect(),
            })
            .collect())
    }
    /// Preserve journal sequence order, then apply the existing grouping and Markdown renderer.
    pub fn message_items(&self, room: String, limit: u32) -> Result<Vec<MessageItem>, RvError> {
        let rows = self.session.store.messages(&room, limit.clamp(1, 10_000) as usize).map_err(RvError::local)?;
        Ok(native_message_items(rows, &room, &self.session.info.user_id, &self.session.info.username))
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
        on_tokio(async move { s.create_room(&name, private).await }).await.map_err(RvError::local)
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
    pub async fn marked(&self, room: String, starred: bool) -> Result<Vec<MessageItem>, RvError> {
        let (s, rid) = (self.session.clone(), room.clone());
        let messages = on_tokio(async move { s.marked(&rid, starred).await }).await.map_err(native_error)?;
        let ids: Vec<_> = messages.into_iter().map(|m| m.id).collect();
        let rows = self.session.store.selected_messages(&ids).map_err(RvError::local)?;
        Ok(native_message_items(rows, &room, &self.session.info.user_id, &self.session.info.username))
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

fn native_error(error: rv_core::native::Error) -> RvError {
    rv_core::native::rest_error(error).into()
}

fn native_message_items(
    rows: Vec<rv_core::native::store::MessageRow>,
    rid: &str,
    uid: &str,
    username: &str,
) -> Vec<MessageItem> {
    let rows = rows
        .into_iter()
        .map(|row| rv_core::store::MessageRow {
            id: row.id,
            rid: rid.into(),
            ts: row.ts,
            edited: row.edited,
            reactions: row.reactions,
            pinned: row.pinned,
            starred: row.starred.then(|| uid.into()),
            text: Some(row.text),
            author: Some(row.author),
            author_id: if row.status.is_some() { uid.into() } else { row.author_id },
            outbox_status: row.status.map(|s| if s == "failed" { "failed".into() } else { "pending".into() }),
            ..Default::default()
        })
        .collect();
    rv_core::timeline::group(rows)
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
    fn native_rows_use_the_shared_renderer_without_reordering_or_rc_avatars() {
        let row = |id: &str, ts, status| rv_core::native::store::MessageRow {
            id: id.into(),
            text: "**hello** :smile:".into(),
            author: "alice".into(),
            author_id: "alice-id".into(),
            ts,
            status,
            edited: false,
            reactions: None,
            pinned: false,
            starred: false,
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
