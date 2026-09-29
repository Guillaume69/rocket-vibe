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

/// Each frame of an animation and how long it shows, in milliseconds.
pub type Frames = Rc<Vec<(gdk::Texture, u32)>>;

/// What the frames of one GIF may take in memory, and how many GIFs keep them.
const ANIMATION_BUDGET: usize = 48 << 20;
const ANIMATIONS_KEPT: usize = 8;

thread_local! {
    /// `None`: known to have no usable image (placeholder SVG, 404, undecodable).
    static TEXTURES: RefCell<HashMap<String, Option<gdk::Texture>>> = RefCell::default();
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
    let cached = TEXTURES.with_borrow(|t| t.get(path).cloned());
    match cached {
        Some(Some(texture)) => return ready(&texture),
        Some(None) => return,
        None => {}
    }
    let first = WAITING.with_borrow_mut(|w| {
        let waiters = w.entry(path.to_owned()).or_default();
        waiters.push(Box::new(ready));
        waiters.len() == 1
    });
    if !first {
        return;
    }
    let (session, path) = (session.clone(), path.to_owned());
    glib::spawn_future_local(async move {
        let key = path.clone();
        let loaded = on_tokio(async move {
            let media = session.media.fetch(&path).await.ok()?;
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
        TEXTURES.with_borrow_mut(|t| t.insert(key.clone(), texture.clone()));
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
    ANIMATIONS.with_borrow_mut(Vec::clear);
}
