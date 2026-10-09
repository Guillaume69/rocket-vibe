//! The pictures a notification shows, the author's photo and the message's
//! image, as local PNG files: Windows reads no remote image for an unpackaged
//! app, and ours need the session's credentials anyway. Each file is named
//! after its media path (the photo's carries its version), so a known one is
//! not fetched again; files unused for a week go.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use gtk::gdk_pixbuf::Pixbuf;
use gtk::{gio, glib};
use rv_core::notify::Incoming;
use rv_core::session::Session;
use sha2::{Digest, Sha256};

/// `file:` URIs, each left out when it could not be had in time.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Pictures {
    pub avatar: Option<String>,
    pub image: Option<String>,
}

/// A notification waits this long for its pictures, then shows without.
const WAIT: Duration = Duration::from_secs(2);
const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);
/// Windows draws the photo at 48 px, more on a high-DPI screen.
const AVATAR_SIZE: i32 = 128;
/// Twice a toast's width; a tall picture is bounded the same way.
const IMAGE_SIZE: i32 = 728;

fn dir() -> PathBuf {
    glib::user_cache_dir().join("rocket-vibe-rs").join("notifications")
}

fn file_for(dir: &Path, media_path: &str) -> PathBuf {
    let digest = Sha256::digest(media_path.as_bytes());
    let name: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{name}.png"))
}

/// The files of `dir` last used more than `keep` ago.
fn stale(dir: &Path, keep: Duration, now: SystemTime) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| {
            e.metadata().and_then(|m| m.modified()).is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age > keep))
        })
        .map(|e| e.path())
        .collect()
}

thread_local! {
    static PRUNED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn prune_once() {
    if PRUNED.replace(true) {
        return;
    }
    for file in stale(&dir(), KEEP, SystemTime::now()) {
        let _ = std::fs::remove_file(file);
    }
}

/// The bytes behind a media path, unless it is Rocket.Chat's initials
/// placeholder (the system's own icon looks better than a blank tile).
async fn download(session: Arc<Session>, path: Option<String>) -> Option<Vec<u8>> {
    let media = session.media.fetch(&path?).await.ok()?;
    (!media.is_placeholder()).then(|| media.bytes.clone())
}

/// Decoded, scaled into `size`×`size` and written as PNG.
fn write_png(bytes: &[u8], size: i32, file: &Path) -> Option<()> {
    let stream = gio::MemoryInputStream::from_bytes(&glib::Bytes::from(bytes));
    let pixbuf = Pixbuf::from_stream_at_scale(&stream, size, size, true, None::<&gio::Cancellable>).ok()?;
    std::fs::create_dir_all(file.parent()?).ok()?;
    pixbuf.savev(file, "png", &[]).ok()
}

fn uri(file: &Path) -> Option<String> {
    glib::filename_to_uri(file, None).ok().map(String::from)
}

/// A file already made for this path: used again, and marked as such.
fn known(file: &Path) -> Option<String> {
    let handle = std::fs::File::options().append(true).open(file).ok()?;
    let _ = handle.set_modified(SystemTime::now());
    uri(file)
}

/// The notification's pictures, fetched with the session's credentials.
pub async fn fetch(session: Arc<Session>, incoming: &Incoming) -> Pictures {
    prune_once();
    let dir = dir();
    let avatar_file = incoming.avatar.as_deref().map(|p| file_for(&dir, p));
    let image_file = incoming.image.as_deref().map(|p| file_for(&dir, p));
    let mut pictures =
        Pictures { avatar: avatar_file.as_deref().and_then(known), image: image_file.as_deref().and_then(known) };
    let wanted_avatar = incoming.avatar.clone().filter(|_| pictures.avatar.is_none());
    let wanted_image = incoming.image.clone().filter(|_| pictures.image.is_none());
    if wanted_avatar.is_none() && wanted_image.is_none() {
        return pictures;
    }
    let (avatar, image) = crate::on_tokio(async move {
        let both = async { tokio::join!(download(session.clone(), wanted_avatar), download(session, wanted_image)) };
        tokio::time::timeout(WAIT, both).await.unwrap_or_default()
    })
    .await;
    if let (Some(bytes), Some(file)) = (avatar, &avatar_file) {
        pictures.avatar = write_png(&bytes, AVATAR_SIZE, file).and_then(|()| uri(file));
    }
    if let (Some(bytes), Some(file)) = (image, &image_file) {
        pictures.image = write_png(&bytes, IMAGE_SIZE, file).and_then(|()| uri(file));
    }
    pictures
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_named_by_media_path_and_old_ones_go() {
        let dir = std::env::temp_dir().join(format!("rv-pictures-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let photo = file_for(&dir, "/avatar/bob?etag=1");
        assert_eq!(photo, file_for(&dir, "/avatar/bob?etag=1"));
        assert_ne!(photo, file_for(&dir, "/avatar/bob?etag=2"), "a new photo is a new file");
        assert_eq!(photo.extension().unwrap(), "png");
        std::fs::write(&photo, b"x").unwrap();
        let now = SystemTime::now();
        assert!(stale(&dir, KEEP, now).is_empty());
        assert_eq!(stale(&dir, KEEP, now + KEEP + Duration::from_secs(60)), vec![photo.clone()]);
        assert!(known(&photo).is_some_and(|u| u.starts_with("file:")));
        assert!(known(&dir.join("missing.png")).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pictures_are_scaled_into_their_box() {
        let dir = std::env::temp_dir().join(format!("rv-pictures-scale-{}", std::process::id()));
        let source = Pixbuf::new(gtk::gdk_pixbuf::Colorspace::Rgb, true, 8, 400, 1000).unwrap();
        source.fill(0xe86ea7ff);
        let bytes = source.save_to_bufferv("png", &[]).unwrap();
        let file = dir.join("tall.png");
        write_png(&bytes, AVATAR_SIZE, &file).unwrap();
        let written = Pixbuf::from_file(&file).unwrap();
        assert_eq!((written.width(), written.height()), (51, 128));
        assert!(write_png(b"not a picture", AVATAR_SIZE, &dir.join("bad.png")).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
