//! The Android kit's signature pieces, rebuilt in GTK: gradient avatar tiles,
//! the gradient logotype, the glowing call-to-action, pill fields, the yellow
//! unread capsule and the sync comet.

use gtk::prelude::*;

const BRAND_STOPS: [(u8, u8, u8); 3] = [(0xFF, 0x5F, 0xA2), (0xA7, 0x8B, 0xFA), (0x34, 0xE1, 0xD0)];
const AVATAR_GRADIENTS: usize = 7;

/// Same hash as the Android app (`degradeAvatar`, over UTF-16 code units), so
/// a person keeps the same colours on every client.
pub fn gradient_index(key: &str) -> usize {
    let mut h: i32 = 0;
    for unit in key.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(unit as i32);
    }
    ((h as i64).abs() % AVATAR_GRADIENTS as i64) as usize
}

pub enum TileSize {
    Room,
    Message,
    Header,
}

/// Rounded square filled with the person's (or room's) gradient.
pub fn tile(key: &str, glyph: &str, size: TileSize, neutral: bool) -> gtk::Widget {
    let (px, class) = match size {
        TileSize::Room => (44, "tile-room"),
        TileSize::Message => (34, "tile-message"),
        TileSize::Header => (30, "tile-header"),
    };
    let gradient = if neutral { "tile-neutral".to_owned() } else { format!("tile-g{}", gradient_index(key)) };
    let label = gtk::Label::builder()
        .label(glyph)
        .css_classes(["tile-glyph"])
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .hexpand(true)
        .vexpand(true)
        .build();
    // Explicitly non-expanding: otherwise the centred glyph's expand flags
    // propagate up and the tile claims half of every row it sits in.
    let tile = gtk::Box::builder()
        .css_classes(["tile", class, gradient.as_str()])
        .width_request(px)
        .height_request(px)
        .hexpand(false)
        .vexpand(false)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Start)
        .build();
    tile.append(&label);
    tile.upcast()
}

pub fn initial(name: &str) -> String {
    name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_else(|| "?".into())
}

fn lerp(a: u8, b: u8, t: f64) -> u8 {
    (a as f64 + (b as f64 - a as f64) * t).round() as u8
}

/// "rocket-vibe" in Baloo 2, each letter tinted along the brand gradient
/// (GTK CSS cannot clip a background to text).
pub fn brand(css_class: &str) -> gtk::Label {
    let text = "rocket-vibe";
    let n = text.chars().count().max(2) - 1;
    let markup: String = text
        .chars()
        .enumerate()
        .map(|(i, c)| {
            let t = i as f64 / n as f64 * (BRAND_STOPS.len() - 1) as f64;
            let seg = (t.floor() as usize).min(BRAND_STOPS.len() - 2);
            let local = t - seg as f64;
            let (a, b) = (BRAND_STOPS[seg], BRAND_STOPS[seg + 1]);
            format!(
                "<span foreground=\"#{:02X}{:02X}{:02X}\">{c}</span>",
                lerp(a.0, b.0, local),
                lerp(a.1, b.1, local),
                lerp(a.2, b.2, local)
            )
        })
        .collect();
    let label = gtk::Label::new(None);
    label.set_markup(&markup);
    label.add_css_class("brand");
    label.add_css_class(css_class);
    label
}

/// Main action: pink-to-violet gradient with a soft pink halo.
pub fn cta(text: &str) -> gtk::Button {
    gtk::Button::builder().label(text).css_classes(["cta"]).build()
}

/// A caption over a pill-shaped entry that rings cyan when focused.
pub fn pill_field(caption: &str, placeholder: &str, password: bool) -> (gtk::Box, gtk::Entry) {
    let entry = gtk::Entry::builder().placeholder_text(placeholder).hexpand(true).build();
    entry.add_css_class("pill-entry");
    if password {
        entry.set_visibility(false);
        entry.set_input_purpose(gtk::InputPurpose::Password);
    }
    let group = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).build();
    group.append(&gtk::Label::builder().label(caption).xalign(0.0).css_classes(["pill-caption"]).build());
    group.append(&entry);
    (group, entry)
}

/// Yellow capsule, dark count; `@n` in pink when you were mentioned.
pub fn unread_badge(unread: i64, mentions: i64) -> gtk::Label {
    let text = if unread > 99 { "99+".to_owned() } else { unread.to_string() };
    let (text, class) = if mentions > 0 { (format!("@{text}"), "badge-mention") } else { (text, "badge-unread") };
    gtk::Label::builder().label(text).css_classes(["badge", class]).valign(gtk::Align::Center).build()
}

/// Thin brand-gradient comet sweeping a header's bottom edge while syncing.
pub fn comet() -> gtk::Box {
    gtk::Box::builder().css_classes(["comet"]).height_request(3).hexpand(true).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gradient_index_matches_the_android_hash() {
        // JS: h = (h * 31 + code) | 0; Math.abs(h) % 7
        assert_eq!(gradient_index(""), 0);
        assert_eq!(gradient_index("bob"), (97_717i64 % 7) as usize);
        assert_ne!(gradient_index("bob"), gradient_index("obb"));
        let long = "a-very-long-display-name-that-overflows-32-bits";
        assert!(gradient_index(long) < AVATAR_GRADIENTS);
    }

    #[test]
    fn initial_is_uppercase() {
        assert_eq!(initial("alice"), "A");
        assert_eq!(initial(""), "?");
    }
}
