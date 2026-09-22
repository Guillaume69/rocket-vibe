//! Protected images (avatars, attachments) as GDK textures. List rows are
//! rebuilt on every bind, so each image is fetched and decoded once, and every
//! widget asking for it meanwhile waits on the same request.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use gtk::{gdk, glib};
use rv_core::session::Session;

use crate::on_tokio;

type Waiter = Box<dyn FnOnce(&gdk::Texture)>;

thread_local! {
    /// `None`: known to have no usable image (placeholder SVG, 404, undecodable).
    static TEXTURES: RefCell<HashMap<String, Option<gdk::Texture>>> = RefCell::default();
    static WAITING: RefCell<HashMap<String, Vec<Waiter>>> = RefCell::default();
}

/// Calls `ready` with the texture, now if it is cached, later once loaded.
/// Never called when there is no image to show.
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
        let texture = on_tokio(async move {
            let media = session.media.fetch(&path).await.ok()?;
            if media.is_placeholder() {
                return None;
            }
            gdk::Texture::from_bytes(&glib::Bytes::from(&media.bytes[..])).ok()
        })
        .await;
        TEXTURES.with_borrow_mut(|t| t.insert(key.clone(), texture.clone()));
        let waiters = WAITING.with_borrow_mut(|w| w.remove(&key)).unwrap_or_default();
        if let Some(texture) = texture {
            for waiter in waiters {
                waiter(&texture);
            }
        }
    });
}

/// Forgets everything: a new session may see different files.
pub fn clear() {
    TEXTURES.with_borrow_mut(HashMap::clear);
}
