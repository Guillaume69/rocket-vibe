use crate::native::NativeChat;
use crate::*;

#[derive(Clone, Debug, uniffi::Record)]
pub struct RoomLink {
    pub rid: String,
    pub message: Option<String>,
    pub root: Option<String>,
}
impl From<rv_core::links::RoomLink> for RoomLink {
    fn from(link: rv_core::links::RoomLink) -> Self {
        Self { rid: link.rid, message: link.message, root: link.root }
    }
}

#[uniffi::export]
pub fn parse_room_link(url: String) -> Option<RoomLink> {
    rv_core::links::parse(&url).map(Into::into)
}

#[uniffi::export]
impl Client {
    /// Return only exact provider / service / instance / account matches.
    pub async fn room_link_accounts(&self, url: String) -> Vec<Account> {
        let Some(link) = rv_core::links::parse(&url) else { return vec![] };
        let dirs = self.dirs.clone();
        blocking(move || accounts::load_all(&dirs))
            .await
            .iter()
            .filter(|info| rv_core::links::fits(&link, info))
            .map(account)
            .collect()
    }
}

#[uniffi::export]
impl Chat {
    pub fn accepts_room_link(&self, url: String) -> bool {
        rv_core::links::parse(&url).is_some_and(|l| rv_core::links::fits(&l, &self.session.info))
    }
}

#[uniffi::export]
impl NativeChat {
    pub fn message_rank(&self, room: String, message: String) -> Result<Option<u32>, RvError> {
        self.session.store.message_rank(&room, &message).map_err(RvError::local)
    }
    pub fn accepts_room_link(&self, url: String) -> bool {
        rv_core::links::parse(&url).is_some_and(|l| rv_core::links::fits(&l, &self.session.info))
    }
    pub async fn resolve_room_link(&self, url: String) -> Result<RoomLink, RvError> {
        let link = rv_core::links::parse(&url).ok_or_else(|| RvError::local("invalid_link"))?;
        let s = self.session.clone();
        on_tokio(async move { s.resolve_room_link(link).await }).await.map(Into::into).map_err(RvError::local)
    }
    pub fn permalink(&self, room: String, message: Option<String>, root: Option<String>) -> Option<String> {
        rv_core::links::native_permalink(&self.session.info, &room, message.as_deref(), root.as_deref())
    }
}
