//! Explicit native pilot API. Legacy Chat never receives a native bearer token.
use crate::model::{Account, RvError};
use crate::{Client, accounts, blocking, on_tokio, runtime};
use rv_core::native::NativeSession;
use std::sync::Arc;

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
#[derive(Clone, Debug, uniffi::Record)]
pub struct NativeStatus {
    pub state: crate::ConnectionState,
    pub error: Option<String>,
}
#[derive(uniffi::Object)]
pub struct NativeChat {
    session: Arc<NativeSession>,
    dirs: Arc<accounts::Dirs>,
}
impl Drop for NativeChat {
    fn drop(&mut self) {
        self.session.shutdown();
    }
}

#[uniffi::export]
impl Client {
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
        .map_err(RvError::local)?;
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
            session: NativeSession::start(info, &path).map_err(RvError::local)?,
            dirs: self.dirs.clone(),
        }))
    }
}
#[uniffi::export]
impl NativeChat {
    pub fn account(&self) -> Account {
        crate::account(&self.session.info)
    }
    pub fn status(&self) -> NativeStatus {
        let status = self.session.status();
        NativeStatus { state: crate::state(status.connection), error: status.error }
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
        self.session.shutdown();
    }
    pub async fn history(&self, room: String, older: bool) -> Result<bool, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.history(&room, older).await }).await.map_err(RvError::local)
    }
    pub async fn create_room(&self, name: String, private: bool) -> Result<String, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.create_room(&name, private).await }).await.map_err(RvError::local)
    }
    pub async fn direct(&self, username: String) -> Result<String, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.direct(&username).await }).await.map_err(RvError::local)
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
