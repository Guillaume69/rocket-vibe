use super::{Error, NativeSession};
use crate::{media::Media, session::Connection};
use std::sync::atomic::Ordering;

impl NativeSession {
    fn emoji_names_visible(&self) -> bool {
        !self.is_closed() && !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| !c.custom_emojis)
    }
    pub fn emoji_version(&self) -> String {
        format!(
            "{}:{}:{:?}",
            self.security_generation.load(Ordering::SeqCst),
            self.store.emoji_revision().unwrap_or_default(),
            self.status().connection
        )
    }
    pub fn custom_emoji(&self, code: &str) -> Option<String> {
        if !self.emoji_names_visible() {
            return None;
        }
        let code = rv_protocol::custom_emojis::shortcode(code)?;
        self.store
            .emoji_catalog()
            .ok()
            .flatten()?
            .items
            .into_iter()
            .find(|e| e.name == code || e.aliases.iter().any(|a| a == code))
            .map(|e| format!("rv-emoji:{}", e.file_id))
    }
    pub fn custom_emoji_names(&self) -> Vec<String> {
        if !self.emoji_names_visible() {
            return vec![];
        }
        self.store.emoji_catalog().ok().flatten().into_iter().flat_map(|c| c.items).map(|e| e.name).collect()
    }
    pub fn custom_emoji_codes(&self, prefix: &str) -> Vec<String> {
        if !self.emoji_names_visible() {
            return vec![];
        }
        let mut codes: Vec<_> = self
            .store
            .emoji_catalog()
            .ok()
            .flatten()
            .into_iter()
            .flat_map(|c| c.items)
            .flat_map(|e| std::iter::once(e.name).chain(e.aliases))
            .filter(|c| c.starts_with(prefix))
            .collect();
        codes.sort();
        codes
    }
    pub fn emoji_current(&self, path: &str) -> bool {
        !self.is_closed()
            && self.verified.load(Ordering::SeqCst)
            && self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.custom_emojis)
            && self.status().connection == Connection::Online
            && path.strip_prefix("rv-emoji:").is_some_and(|id| {
                self.store.emoji_catalog().ok().flatten().is_some_and(|c| c.items.iter().any(|e| e.file_id == id))
            })
    }
    pub async fn refresh_emojis(&self) -> Result<(), Error> {
        let _lock = self.emoji_refresh.lock().await;
        self.ready()?;
        if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.custom_emojis) {
            return Ok(());
        }
        let generation = self.security_generation.load(Ordering::SeqCst);
        let catalog = self.client.emoji_catalog().await?;
        self.identity().await?;
        let valid = || {
            !self.is_closed()
                && generation == self.security_generation.load(Ordering::SeqCst)
                && self.verified.load(Ordering::SeqCst)
        };
        if !valid() {
            return Err(Error::Protocol("session_closed"));
        }
        if self.store.emoji_catalog()?.as_ref() == Some(&catalog) {
            return Ok(());
        }
        if self.store.save_emojis(&catalog, valid)? {
            let _ = self.events.send(());
        }
        Ok(())
    }
    pub(super) async fn observe_emojis(&self, state: &rv_protocol::live::LiveState) -> Result<(), Error> {
        if !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.custom_emojis) {
            return Ok(());
        }
        if state.ttl_ms == 0 || state.ttl_ms > 8000 {
            return Ok(());
        }
        let Some(revision) = &state.emoji_catalog_revision else { return Ok(()) };
        if self.store.emoji_revision()? == *revision && self.store.emoji_catalog()?.is_some() {
            return Ok(());
        }
        if self.store.invalidate_emojis(revision, || !self.is_closed())? {
            let _ = self.events.send(());
        }
        if self.store.emoji_catalog()?.is_none() {
            self.refresh_emojis().await?;
        }
        Ok(())
    }
    pub async fn emoji_media(&self, path: &str) -> Result<Media, Error> {
        self.ready()?;
        let id = path.strip_prefix("rv-emoji:").ok_or(Error::Protocol("emoji_retired"))?;
        let generation = self.security_generation.load(Ordering::SeqCst);
        let _slot = self.avatar_slots.acquire().await.map_err(|_| Error::Protocol("session_closed"))?;
        self.refresh_emojis().await?;
        let item = self
            .store
            .emoji_catalog()?
            .and_then(|c| c.items.into_iter().find(|e| e.file_id == id))
            .ok_or(Error::Protocol("emoji_retired"))?;
        let version = self.store.emoji_revision()?;
        let cached = self.emojis.lock().unwrap().get(id);
        let bytes = match cached {
            Some(bytes) => bytes,
            None => self.client.emoji_bytes(&item).await?,
        };
        self.refresh_emojis().await?;
        self.identity().await?;
        if generation != self.security_generation.load(Ordering::SeqCst)
            || !self.emoji_current(path)
            || self.store.emoji_revision()? != version
        {
            return Err(Error::Protocol("emoji_retired"));
        }
        self.emojis.lock().unwrap().put(id, bytes.clone());
        Ok(Media { bytes, content_type: item.media_type })
    }
}
