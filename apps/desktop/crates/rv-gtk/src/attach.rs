//! Files on their way into a room: picked, dropped or pasted, then shown in a
//! staged in the composer (caption, image quality) before they are queued for upload.

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::{gdk, gdk_pixbuf, gio, glib};
use rv_core::session::Session;
use rv_core::uploads::Refusal;

use crate::i18n::{t, tf};
use crate::on_tokio;

/// A reduced image is at most this wide or tall.
const REDUCED_SIDE: i32 = 1920;

#[derive(Debug, Clone)]
pub struct Picked {
    pub path: PathBuf,
    /// The name the room sees.
    pub name: String,
    /// Our own copy (a pasted picture): deleted once uploaded.
    pub temporary: bool,
}

fn scratch_dir() -> PathBuf {
    let dir = glib::user_cache_dir().join("rocket-vibe-rs").join("outgoing");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn scratch_file(name: &str) -> PathBuf {
    scratch_dir().join(format!("{:08x}-{name}", glib::random_int()))
}

pub fn mime_of(path: &Path) -> String {
    let data = std::fs::read(path).ok().map(|b| b.into_iter().take(4096).collect::<Vec<u8>>());
    let (content_type, _) = gio::content_type_guess(Some(path), data.as_deref());
    gio::content_type_get_mime_type(&content_type)
        .map_or_else(|| "application/octet-stream".to_owned(), |m| m.to_string())
}

fn reducible(mime: &str) -> bool {
    matches!(mime, "image/jpeg" | "image/png" | "image/webp" | "image/bmp" | "image/tiff")
}

/// A pasted picture, saved as PNG so it can travel like any file.
pub fn save_texture(texture: &gdk::Texture) -> Option<Picked> {
    let path = scratch_file("pasted.png");
    texture.save_to_png(&path).ok()?;
    Some(Picked { path, name: format!("{}.png", t("attach.pasted_name")), temporary: true })
}

pub fn from_files(files: &[gio::File]) -> Vec<Picked> {
    files
        .iter()
        .filter_map(|f| f.path())
        .filter(|p| p.is_file())
        .map(|path| Picked {
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path,
            temporary: false,
        })
        .collect()
}

/// The desktop's file chooser; several files at once.
pub fn choose(parent: &impl IsA<gtk::Widget>, done: impl Fn(Vec<Picked>) + 'static) {
    let window = parent.root().and_downcast::<gtk::Window>();
    let dialog = gtk::FileDialog::builder().title(t("attach.choose")).modal(true).build();
    dialog.open_multiple(window.as_ref(), None::<&gio::Cancellable>, move |result| {
        let Ok(model) = result else { return };
        let files: Vec<gio::File> = (0..model.n_items()).filter_map(|i| model.item(i).and_downcast()).collect();
        let picked = from_files(&files);
        if !picked.is_empty() {
            done(picked);
        }
    });
}

/// A copy scaled to fit `REDUCED_SIDE`, as JPEG; None when it would not be smaller.
fn reduce(path: &Path) -> Option<PathBuf> {
    let (_, width, height) = gdk_pixbuf::Pixbuf::file_info(path)?;
    if width <= REDUCED_SIDE && height <= REDUCED_SIDE && std::fs::metadata(path).ok()?.len() < 1024 * 1024 {
        return None;
    }
    let pixbuf = gdk_pixbuf::Pixbuf::from_file_at_scale(path, REDUCED_SIDE, REDUCED_SIDE, true).ok()?;
    let pixbuf = pixbuf.apply_embedded_orientation().unwrap_or(pixbuf);
    let stem = path.file_stem().map_or_else(|| "image".to_owned(), |s| s.to_string_lossy().into_owned());
    let out = scratch_file(&format!("{stem}.jpg"));
    pixbuf.savev(&out, "jpeg", &[("quality", "82")]).ok()?;
    Some(out)
}

fn refusal_text(refusal: &Refusal, name: &str) -> String {
    match refusal {
        Refusal::TooLarge { max_mb } => tf("attach.too_large", &[("name", name), ("max", max_mb)]),
        Refusal::TypeNotAllowed { mime } => tf("attach.type_refused", &[("name", name), ("type", mime)]),
    }
}

pub fn send_all(
    session: Arc<Session>,
    rid: String,
    items: Vec<(Picked, String)>,
    caption: String,
    reduce_images: bool,
    toast: Rc<dyn Fn(String)>,
) {
    glib::spawn_future_local(async move {
        for (i, (item, mime)) in items.into_iter().enumerate() {
            let reduced = if reduce_images && reducible(&mime) { reduce(&item.path) } else { None };
            let (path, name, mime, temporary) = match reduced {
                Some(copy) => {
                    if item.temporary {
                        let _ = std::fs::remove_file(&item.path);
                    }
                    let stem = Path::new(&item.name)
                        .file_stem()
                        .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
                    (copy, format!("{stem}.jpg"), "image/jpeg".to_owned(), true)
                }
                None => (item.path.clone(), item.name.clone(), mime, item.temporary),
            };
            let caption = (i == 0 && !caption.trim().is_empty()).then(|| caption.clone());
            let (s, r, p, n) = (session.clone(), rid.clone(), path.clone(), name.clone());
            let result =
                on_tokio(async move { s.attach(&r, &p, &n, &mime, caption.as_deref(), temporary).await }).await;
            if let Err(refusal) = result {
                if temporary {
                    let _ = std::fs::remove_file(&path);
                }
                toast(refusal_text(&refusal, &name));
            }
        }
    });
}
