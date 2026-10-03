//! Protected images (avatars, attachments) as GDK textures. List rows are
//! rebuilt on every bind, so each image is fetched and decoded once, and every
//! widget asking for it meanwhile waits on the same request. An animated GIF
//! keeps its frames too, for the pictures that play it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gtk::prelude::*;
use gtk::{gdk, glib};
use rv_core::session::Session;

use crate::on_tokio;

type Waiter = Box<dyn FnOnce(&gdk::Texture)>;

#[derive(Clone)]
pub enum Provider {
    RocketChat(Arc<Session>),
    RocketVibe(Arc<rv_core::native::NativeSession>),
}
impl From<Arc<Session>> for Provider {
    fn from(s: Arc<Session>) -> Self {
        Self::RocketChat(s)
    }
}
impl Provider {
    pub fn watch(&self, widget: &impl IsA<gtk::Widget>, path: &str, expired: impl FnOnce(&gtk::Widget) + 'static) {
        if matches!(self, Self::RocketChat(_)) {
            return;
        }
        let (weak, provider, path) = (widget.as_ref().downgrade(), self.clone(), path.to_owned());
        let key = provider.key(&path);
        let mut expired = Some(expired);
        glib::timeout_add_local(Duration::from_millis(500), move || {
            let Some(widget) = weak.upgrade() else { return glib::ControlFlow::Break };
            if !provider.current(&path) || path.starts_with("rv-preview:") && provider.key(&path) != key {
                if path.starts_with("rv-preview:") {
                    PREVIEW_TEXTURES.with_borrow_mut(|entries| entries.retain(|(stored, _)| stored != &key));
                }
                expired.take().unwrap()(&widget);
                return glib::ControlFlow::Break;
            }
            glib::ControlFlow::Continue
        });
    }
    fn key(&self, path: &str) -> String {
        match self {
            Self::RocketChat(_) => path.into(),
            Self::RocketVibe(s) if path.starts_with("rv-preview:") => {
                format!("{}:{}:{}:{path}", s.info.base_url, s.info.user_id, s.preview_scope(path).unwrap_or_default())
            }
            Self::RocketVibe(s) => format!(
                "{}:{}:{:?}:{}:{}:{}:{path}",
                s.info.base_url,
                s.info.user_id,
                s.info.native,
                s.store.projection_token(),
                s.store.search_token(),
                s.emoji_version()
            ),
        }
    }
    pub fn current(&self, path: &str) -> bool {
        match self {
            Self::RocketChat(_) => true,
            Self::RocketVibe(s) => {
                if path.starts_with("rv-preview:") {
                    s.preview_current(path)
                } else if path.starts_with("rv-emoji:") {
                    s.emoji_current(path)
                } else {
                    s.file_current(path)
                }
            }
        }
    }
    async fn fetch(&self, path: &str) -> Option<Arc<rv_core::media::Media>> {
        match self {
            Self::RocketChat(s) => s.media.fetch(path).await.ok(),
            Self::RocketVibe(s) => {
                if path.starts_with("rv-preview:") {
                    s.preview_media(path).await.ok().map(Arc::new)
                } else if path.starts_with("rv-emoji:") {
                    s.emoji_media(path).await.ok().map(Arc::new)
                } else {
                    s.file_media(path).await.ok().map(Arc::new)
                }
            }
        }
    }
    pub async fn download(&self, path: &str, dest: &std::path::Path) -> bool {
        match self {
            Self::RocketChat(s) => s.download_to(path, dest).await.is_ok(),
            Self::RocketVibe(s) => {
                if path.starts_with("rv-preview:") {
                    s.download_preview(path, dest).await.is_ok()
                } else {
                    s.download_file(path, dest).await.is_ok()
                }
            }
        }
    }
    pub async fn local(&self, file: &rv_core::content::FileAttachment) -> Option<std::path::PathBuf> {
        match self {
            Self::RocketChat(s) => crate::cards::legacy_local_copy(s.clone(), file.clone()).await,
            Self::RocketVibe(s) => {
                let (s, path) = (s.clone(), file.url.clone());
                on_tokio(async move { s.local_file(&path).await.ok() }).await
            }
        }
    }
}

/// Each frame of an animation and how long it shows, in milliseconds.
pub type Frames = Rc<Vec<(gdk::Texture, u32)>>;

/// What the frames of one GIF may take in memory, and how many GIFs keep them.
const ANIMATION_BUDGET: usize = 48 << 20;
const ANIMATIONS_KEPT: usize = 8;

thread_local! {
    /// `None`: known to have no usable image (placeholder SVG, 404, undecodable).
    static TEXTURES: RefCell<HashMap<String, Option<gdk::Texture>>> = RefCell::default();
    static PREVIEW_TEXTURES: RefCell<Vec<(String,gdk::Texture)>> = RefCell::default();
    static WAITING: RefCell<HashMap<String, Vec<Waiter>>> = RefCell::default();
    static ANIMATIONS: RefCell<Vec<(String, Frames)>> = RefCell::default();
}

fn texture(width: u32, height: u32, rgba: Vec<u8>) -> gdk::Texture {
    let stride = width as usize * 4;
    gdk::MemoryTexture::new(
        width as i32,
        height as i32,
        gdk::MemoryFormat::R8g8b8a8,
        &glib::Bytes::from_owned(rgba),
        stride,
    )
    .upcast()
}

/// Calls `ready` with the texture (a GIF's first frame), now if it is cached,
/// later once loaded. Never called when there is no image to show.
pub fn load(session: &Arc<Session>, path: &str, ready: impl FnOnce(&gdk::Texture) + 'static) {
    load_provider(Provider::RocketChat(session.clone()), path, ready)
}
pub fn load_provider(session: Provider, path: &str, ready: impl FnOnce(&gdk::Texture) + 'static) {
    if !session.current(path) {
        return;
    }
    let cache_key = session.key(path);
    let private_preview = matches!(session, Provider::RocketVibe(_)) && path.starts_with("rv-preview:");
    let cached = if private_preview {
        PREVIEW_TEXTURES.with_borrow_mut(|entries| {
            entries.iter().position(|(key, _)| key == &cache_key).map(|index| {
                let entry = entries.remove(index);
                let texture = entry.1.clone();
                entries.push(entry);
                Some(texture)
            })
        })
    } else if matches!(session, Provider::RocketVibe(_)) {
        None
    } else {
        TEXTURES.with_borrow(|t| t.get(&cache_key).cloned())
    };
    match cached {
        Some(Some(texture)) => return ready(&texture),
        Some(None) => return,
        None => {}
    }
    let first = WAITING.with_borrow_mut(|w| {
        let waiters = w.entry(cache_key.clone()).or_default();
        waiters.push(Box::new(ready));
        waiters.len() == 1
    });
    if !first {
        return;
    }
    let (session, path) = (session.clone(), path.to_owned());
    glib::spawn_future_local(async move {
        let key = cache_key;
        let (authority, source) = (session.clone(), path.clone());
        let loaded = on_tokio(async move {
            let media = session.fetch(&path).await?;
            if media.is_placeholder() {
                return None;
            }
            if let Some(animation) = rv_core::animation::decode(&media.bytes, ANIMATION_BUDGET) {
                let (w, h) = (animation.width, animation.height);
                let frames: Vec<(gdk::Texture, u32)> =
                    animation.frames.into_iter().map(|f| (texture(w, h, f.rgba), f.delay_ms)).collect();
                return Some((frames[0].0.clone(), (frames.len() > 1).then_some(frames)));
            }
            let still = gdk::Texture::from_bytes(&glib::Bytes::from(&media.bytes[..])).ok()?;
            Some((still, None))
        })
        .await;
        let (texture, frames) = match loaded {
            Some((texture, frames)) => (Some(texture), frames),
            None => (None, None),
        };
        if let Some(frames) = frames {
            ANIMATIONS.with_borrow_mut(|a| {
                if a.len() >= ANIMATIONS_KEPT {
                    a.remove(0);
                }
                a.push((key.clone(), Rc::new(frames)));
            });
        }
        let texture = texture.filter(|_| {
            authority.current(&source) && (!source.starts_with("rv-preview:") || authority.key(&source) == key)
        });
        if private_preview {
            if let Some(texture) = &texture {
                PREVIEW_TEXTURES.with_borrow_mut(|entries| {
                    let cost = |texture: &gdk::Texture| texture.width() as usize * texture.height() as usize * 4;
                    let mut bytes: usize = entries.iter().map(|(_, t)| cost(t)).sum();
                    while entries.len() >= 128 || bytes + cost(texture) > 32 * 1024 * 1024 {
                        if entries.is_empty() {
                            return;
                        }
                        bytes -= cost(&entries.remove(0).1);
                    }
                    entries.push((key.clone(), texture.clone()));
                });
            }
        } else {
            TEXTURES.with_borrow_mut(|t| {
                if t.len() >= 400 {
                    t.clear();
                }
                t.insert(key.clone(), texture.clone())
            });
        }
        let waiters = WAITING.with_borrow_mut(|w| w.remove(&key)).unwrap_or_default();
        if let Some(texture) = texture {
            for waiter in waiters {
                waiter(&texture);
            }
        }
    });
}

/// The frames of an animated GIF already loaded from `path`.
pub fn frames(path: &str) -> Option<Frames> {
    ANIMATIONS.with_borrow(|a| a.iter().find(|(p, _)| p == path).map(|(_, f)| f.clone()))
}
pub fn provider_frames(provider: &Provider, path: &str) -> Option<Frames> {
    frames(&provider.key(path))
}

/// Plays `frames` in `picture` for as long as it exists, only while it is on
/// screen.
pub fn play(picture: &gtk::Picture, frames: Frames) {
    fn tick(picture: glib::WeakRef<gtk::Picture>, frames: Frames, index: usize) {
        let Some(shown) = picture.upgrade() else { return };
        let (next, wait) = if shown.is_mapped() {
            let next = (index + 1) % frames.len();
            shown.set_paintable(Some(&frames[next].0));
            (next, frames[next].1)
        } else {
            (index, 500)
        };
        glib::timeout_add_local_once(Duration::from_millis(u64::from(wait)), move || tick(picture, frames, next));
    }
    picture.set_paintable(Some(&frames[0].0));
    let wait = frames[0].1;
    let weak = picture.downgrade();
    glib::timeout_add_local_once(Duration::from_millis(u64::from(wait)), move || tick(weak, frames, 0));
}

/// Forgets everything: a new session may see different files.
pub fn clear() {
    TEXTURES.with_borrow_mut(HashMap::clear);
    PREVIEW_TEXTURES.with_borrow_mut(Vec::clear);
    ANIMATIONS.with_borrow_mut(Vec::clear);
}
