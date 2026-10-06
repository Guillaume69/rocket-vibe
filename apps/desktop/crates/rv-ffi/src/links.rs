use crate::native::NativeChat;
use crate::*;
use rv_core::native::notification_navigation::NavigationQueue;

#[derive(Clone, Debug, uniffi::Record)]
pub struct NotificationNavigation {
    pub id: String,
    pub key: String,
    pub message: String,
}

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
    pub fn begin_notification_navigation(&self) -> Result<String, RvError> {
        NavigationQueue::new(&self.dirs.config).begin().map_err(RvError::local)
    }
    pub fn pending_notification_navigation(&self) -> Result<Option<NotificationNavigation>, RvError> {
        NavigationQueue::new(&self.dirs.config)
            .pending()
            .map(|n| n.map(|n| NotificationNavigation { id: n.id, key: n.key, message: n.message }))
            .map_err(RvError::local)
    }
    pub fn clear_notification_navigation(&self, id: String) -> Result<bool, RvError> {
        NavigationQueue::new(&self.dirs.config).clear(&id).map_err(RvError::local)
    }
    pub fn cancel_notification_navigation(&self) -> Result<(), RvError> {
        NavigationQueue::new(&self.dirs.config).cancel().map_err(RvError::local)
    }
    pub async fn capture_notification_navigation(
        &self,
        id: String,
        key: String,
        message: String,
    ) -> Result<Option<Account>, RvError> {
        let dirs = self.dirs.clone();
        blocking(move || {
            let queue = NavigationQueue::new(&dirs.config);
            let result = (|| {
                let infos = accounts::load_all(&dirs);
                let index = rv_core::native::notifications::notification_account(&key, &infos)
                    .ok_or_else(|| RvError::local("delivery_revalidate"))?;
                let info = &infos[index];
                queue
                    .capture_saved(&id, info, &dirs.database(info), &key, &message)
                    .map(|saved| saved.then(|| account(info)))
                    .map_err(RvError::local)
            })();
            if result.is_err() {
                let _ = queue.clear(&id);
            }
            result
        })
        .await
    }
    /// A cold OS response is saved before account resume or network validation.
    pub async fn queue_notification_reply(
        &self,
        key: String,
        message: String,
        text: String,
    ) -> Result<Account, RvError> {
        let dirs = self.dirs.clone();
        blocking(move || {
            let infos = accounts::load_all(&dirs);
            let index = rv_core::native::notifications::notification_account(&key, &infos)
                .ok_or_else(|| RvError::local("delivery_revalidate"))?;
            let info = &infos[index];
            rv_core::native::notifications::save_notification_reply(info, &dirs.database(info), &key, &message, &text)
                .map_err(RvError::local)?;
            Ok(account(info))
        })
        .await
    }
    pub async fn notification_accounts(&self, key: String) -> Vec<Account> {
        let dirs = self.dirs.clone();
        let infos = blocking(move || accounts::load_all(&dirs)).await;
        rv_core::native::notifications::notification_account(&key, &infos)
            .map(|i| vec![account(&infos[i])])
            .unwrap_or_default()
    }
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
    pub fn capture_notification_navigation(&self, id: String, key: String, message: String) -> Result<bool, RvError> {
        if self.session.is_closed() {
            return Err(RvError::local("delivery_revalidate"));
        }
        NavigationQueue::new(&self.dirs.config)
            .capture(&id, &self.session.info, &self.session.store, &key, &message)
            .map_err(RvError::local)
    }
    pub async fn resolve_notification_navigation(&self, id: String) -> Result<RoomLink, RvError> {
        let s = self.session.clone();
        let queue = NavigationQueue::new(&self.dirs.config);
        on_tokio(async move { s.resolve_notification_navigation(&queue, &id).await })
            .await
            .map(Into::into)
            .map_err(RvError::local)
    }
    pub fn accepts_notification(&self, key: String) -> bool {
        rv_core::native::notifications::notification_account(&key, std::slice::from_ref(&self.session.info)).is_some()
    }
    pub async fn resolve_notification(&self, key: String, message: String) -> Result<RoomLink, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.resolve_notification(&key, &message).await })
            .await
            .map(Into::into)
            .map_err(RvError::local)
    }
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
