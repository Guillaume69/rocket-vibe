//! The app's icon, bundled in the binary: the window shows it wherever the
//! app runs from, installed or not.

use gtk::glib;

const SIZES: [(u32, &[u8]); 3] = [
    (48, include_bytes!("../../../data/icons/hicolor/48x48/apps/com.rocketvibe.app.png")),
    (128, include_bytes!("../../../data/icons/hicolor/128x128/apps/com.rocketvibe.app.png")),
    (256, include_bytes!("../../../data/icons/hicolor/256x256/apps/com.rocketvibe.app.png")),
];

pub fn register(display: &gtk::gdk::Display) {
    let root = glib::user_cache_dir().join("rocket-vibe-rs").join("icons");
    for (size, bytes) in SIZES {
        let dir = root.join("hicolor").join(format!("{size}x{size}")).join("apps");
        let path = dir.join(format!("{}.png", crate::APP_ID));
        if std::fs::read(&path).ok().as_deref() != Some(bytes) {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(&path, bytes);
        }
    }
    gtk::IconTheme::for_display(display).add_search_path(&root);
    gtk::Window::set_default_icon_name(crate::APP_ID);
}
