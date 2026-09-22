//! Baloo 2 (titles) and Nunito (body), the Android app's typefaces, bundled
//! in the binary and registered with Pango at startup.

use gtk::glib;
use gtk::prelude::*;

const FONTS: [(&str, &[u8]); 7] = [
    ("Baloo2_600SemiBold.ttf", include_bytes!("../assets/fonts/Baloo2_600SemiBold.ttf")),
    ("Baloo2_700Bold.ttf", include_bytes!("../assets/fonts/Baloo2_700Bold.ttf")),
    ("Baloo2_800ExtraBold.ttf", include_bytes!("../assets/fonts/Baloo2_800ExtraBold.ttf")),
    ("Nunito_400Regular.ttf", include_bytes!("../assets/fonts/Nunito_400Regular.ttf")),
    ("Nunito_600SemiBold.ttf", include_bytes!("../assets/fonts/Nunito_600SemiBold.ttf")),
    ("Nunito_700Bold.ttf", include_bytes!("../assets/fonts/Nunito_700Bold.ttf")),
    ("Nunito_800ExtraBold.ttf", include_bytes!("../assets/fonts/Nunito_800ExtraBold.ttf")),
];

pub fn register() {
    let dir = glib::user_cache_dir().join("rocket-vibe-rs").join("fonts");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Some(font_map) = gtk::Label::new(None).pango_context().font_map() else { return };
    for (name, bytes) in FONTS {
        let path = dir.join(name);
        if std::fs::read(&path).ok().as_deref() != Some(bytes) && std::fs::write(&path, bytes).is_err() {
            continue;
        }
        if let Err(e) = font_map.add_font_file(&path) {
            eprintln!("Font {name} not registered: {e}");
        }
    }
}
