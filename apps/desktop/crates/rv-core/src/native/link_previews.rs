//! Private preview manifests projected into the existing cards and media readers.
use super::{Error, NativeSession};
use crate::{media::Media, session::Connection};
use rv_protocol::link_previews::{LinkPreview, PreviewImage};
use std::collections::HashMap;
use std::sync::{Mutex, atomic::Ordering};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Access {
    pub message: String,
    pub room: String,
    pub membership: String,
    pub image: PreviewImage,
    pub scope: String,
}
#[derive(Default)]
pub(super) struct Previews {
    cache: Mutex<super::profiles::AvatarCache>,
    views: Mutex<HashMap<String, (Access, String)>>,
}
pub(super) fn urls(message: &rv_protocol::Message) -> Result<Option<String>, Error> {
    if !rv_protocol::link_previews::validate(&message.previews) {
        return Err(Error::Protocol("invalid_preview"));
    }
    if (message.deleted || message.system.is_some()) && !message.previews.is_empty() {
        return Err(Error::Protocol("invalid_preview"));
    }
    if message.deleted || message.system.is_some() {
        return Ok(None);
    }
    let mut entries = vec![serde_json::json!({"native_message":message.id})];
    entries.extend(
        message
            .previews
            .iter()
            .map(|preview| serde_json::json!({"url":preview.url,"native_message":message.id,"native_preview":preview})),
    );
    serde_json::to_string(&entries).map(Some).map_err(|_| Error::Protocol("invalid_preview"))
}
pub(super) fn path(message: &str, image: &str) -> String {
    format!("rv-preview:{message}/{image}")
}
pub(super) fn parts(path: &str) -> Option<(&str, &str)> {
    let (message, image) = path.strip_prefix("rv-preview:")?.split_once('/')?;
    (!message.is_empty()
        && message.len() <= 128
        && message.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        && image.len() == 64
        && image.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then_some((message, image))
}
impl NativeSession {
    fn preview_access(&self, path: &str) -> Result<Access, Error> {
        if self.is_closed()
            || !self.verified.load(Ordering::SeqCst)
            || self.status().connection != Connection::Online
            || !self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.link_previews)
        {
            return Err(Error::Protocol("preview_unavailable"));
        }
        let (message, image) = parts(path).ok_or(Error::Protocol("invalid_preview"))?;
        if let Some(access) = self.store.preview_access(message, image)? {
            return Ok(access);
        }
        let version = self.search_version()?;
        self.previews
            .views
            .lock()
            .unwrap()
            .get(path)
            .filter(|(access, stamp)| {
                *stamp == version
                    && self.store.read_state(&access.room).ok().flatten().and_then(|s| s.membership_version).as_deref()
                        == Some(&access.membership)
            })
            .map(|(access, _)| access.clone())
            .ok_or(Error::Protocol("preview_unavailable"))
    }
    pub fn preview_scope(&self, path: &str) -> Option<String> {
        self.preview_access(path).ok().map(|a| a.scope)
    }
    pub fn preview_current(&self, path: &str) -> bool {
        self.preview_scope(path).is_some()
    }
    pub(super) fn cache_search_previews(
        &self,
        page: &rv_protocol::search::SearchPage,
        version: &str,
        membership: &str,
    ) -> Result<(), Error> {
        let mut entries = Vec::new();
        for message in &page.messages {
            urls(message)?;
            for preview in &message.previews {
                if let Some(image) = &preview.image {
                    entries.push(self.store.preview_scope(
                        message.id.clone(),
                        message.room_id.clone(),
                        membership.into(),
                        image.clone(),
                    ));
                }
            }
        }
        if version != self.search_version()? {
            return Err(Error::Protocol("delivery_revalidate"));
        }
        let mut views = self.previews.views.lock().unwrap();
        if views.len() + entries.len() > 128 {
            views.clear();
        }
        for access in entries.into_iter().take(128) {
            views.insert(path(&access.message, &access.image.file_id), (access, version.into()));
        }
        Ok(())
    }
    pub async fn preview_media(&self, path: &str) -> Result<Media, Error> {
        self.ready()?;
        let _slot = self.avatar_slots.acquire().await.map_err(|_| Error::Protocol("session_closed"))?;
        let generation = self.security_generation.load(Ordering::SeqCst);
        let access = self.preview_access(path)?;
        self.identity().await?;
        let cached = self.previews.cache.lock().unwrap().get(&access.scope);
        let bytes = match cached {
            Some(bytes) => bytes,
            None => self.client.preview_image(&access.message, &access.image).await?,
        };
        let message = self.client.message(&access.message).await?;
        self.identity().await?;
        if generation != self.security_generation.load(Ordering::SeqCst)
            || self.preview_scope(path).as_deref() != Some(&access.scope)
            || message.room_id != access.room
            || message.deleted
            || message.system.is_some()
            || !message.previews.iter().any(|p| p.image.as_ref() == Some(&access.image))
        {
            return Err(Error::Protocol("preview_unavailable"));
        }
        self.previews.cache.lock().unwrap().put(&access.scope, bytes.clone());
        Ok(Media { bytes, content_type: "image/png".into() })
    }
    pub async fn download_preview(&self, path: &str, destination: &std::path::Path) -> Result<(), Error> {
        let scope = self.preview_scope(path).ok_or(Error::Protocol("preview_unavailable"))?;
        let media = self.preview_media(path).await?;
        let parent = destination.parent().ok_or(Error::Protocol("file_io_failed"))?;
        let temporary = parent.join(format!(".rv-preview-{:032x}.part", fastrand::u128(..)));
        let result = async {
            tokio::fs::write(&temporary, media.bytes).await.map_err(|_| Error::Protocol("file_io_failed"))?;
            if self.preview_scope(path).as_deref() != Some(&scope) {
                return Err(Error::Protocol("preview_unavailable"));
            }
            tokio::fs::rename(&temporary, destination).await.map_err(|_| Error::Protocol("file_io_failed"))
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
        }
        result
    }
}

pub(crate) fn from_entry(entry: &serde_json::Value) -> Option<(LinkPreview, String)> {
    let preview: LinkPreview = serde_json::from_value(entry.get("native_preview")?.clone()).ok()?;
    if !rv_protocol::link_previews::validate(std::slice::from_ref(&preview)) {
        return None;
    }
    if entry.get("url")?.as_str()? != preview.url {
        return None;
    }
    let message = entry.get("native_message")?.as_str()?;
    let image = preview.image.as_ref().map(|i| path(message, &i.file_id));
    if image.as_deref().is_some_and(|p| parts(p).is_none()) {
        return None;
    }
    Some((preview, image.unwrap_or_default()))
}
