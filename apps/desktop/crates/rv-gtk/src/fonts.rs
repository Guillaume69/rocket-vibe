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

/// Nunito declares a 28/1000 em strikeout: about 0.4 px at body size, drawn
/// too faint to see. Raised to `MIN_STRIKEOUT` in the `OS/2` table.
const MIN_STRIKEOUT: i16 = 70;

fn with_visible_strikeout(font: &[u8]) -> Vec<u8> {
    let mut out = font.to_vec();
    let read_u16 = |at: usize| u16::from_be_bytes([font[at], font[at + 1]]) as usize;
    let tables = read_u16(4);
    for i in 0..tables {
        let record = 12 + 16 * i;
        if font.get(record..record + 4) != Some(b"OS/2") {
            continue;
        }
        let offset = u32::from_be_bytes(font[record + 8..record + 12].try_into().expect("offset")) as usize;
        let at = offset + 26;
        if let Some(bytes) = font.get(at..at + 2) {
            let size = i16::from_be_bytes([bytes[0], bytes[1]]);
            if size < MIN_STRIKEOUT {
                out[at..at + 2].copy_from_slice(&MIN_STRIKEOUT.to_be_bytes());
            }
        }
    }
    out
}

pub fn register() {
    let dir = glib::user_cache_dir().join("rocket-vibe-rs").join("fonts");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Some(font_map) = gtk::Label::new(None).pango_context().font_map() else { return };
    for (name, bytes) in FONTS {
        let bytes = with_visible_strikeout(bytes);
        let path = dir.join(name);
        if std::fs::read(&path).ok() != Some(bytes.clone()) && std::fs::write(&path, &bytes).is_err() {
            continue;
        }
        if let Err(e) = font_map.add_font_file(&path) {
            eprintln!("Font {name} not registered: {e}");
        }
    }
}

/// The emoji font the Windows and macOS packages carry beside the app
/// (`share/fonts`), registered so the style's font list can name it.
pub fn register_packaged() {
    let Some(font_map) = gtk::Label::new(None).pango_context().font_map() else { return };
    for share in crate::bundle::share_dirs() {
        let path = share.join("fonts").join("NotoColorEmoji.ttf");
        if path.exists()
            && let Err(e) = font_map.add_font_file(&path)
        {
            eprintln!("Emoji font not registered: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strikeout(font: &[u8]) -> i16 {
        let tables = u16::from_be_bytes([font[4], font[5]]) as usize;
        let record = (0..tables).map(|i| 12 + 16 * i).find(|&r| &font[r..r + 4] == b"OS/2").unwrap();
        let offset = u32::from_be_bytes(font[record + 8..record + 12].try_into().unwrap()) as usize;
        i16::from_be_bytes([font[offset + 26], font[offset + 27]])
    }

    #[test]
    fn every_strikeout_ends_at_least_one_pixel_thick() {
        let nunito = FONTS.iter().find(|(n, _)| n.starts_with("Nunito_400")).unwrap().1;
        assert_eq!(strikeout(nunito), 28);
        for (name, bytes) in FONTS {
            let patched = with_visible_strikeout(bytes);
            assert!(strikeout(&patched) >= MIN_STRIKEOUT, "{name}");
            assert_eq!(with_visible_strikeout(&patched), patched, "{name}: idempotent");
            assert_eq!(patched.len(), bytes.len());
        }
    }
}
