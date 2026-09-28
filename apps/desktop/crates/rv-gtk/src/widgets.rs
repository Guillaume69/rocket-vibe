//! The Android kit's signature pieces, rebuilt in GTK: gradient avatar tiles,
//! the gradient logotype, the glowing call-to-action, pill fields, the yellow
//! unread capsule and the sync comet.

use std::cell::RefCell;
use std::rc::Rc;

use gtk::prelude::*;

/// A replaceable callback slot on a component.
pub type Handler<T> = RefCell<Option<Rc<dyn Fn(T)>>>;

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
    Profile,
}

/// Rounded square filled with the person's (or room's) gradient.
pub fn tile(key: &str, glyph: &str, size: TileSize, neutral: bool) -> gtk::Widget {
    let (px, class) = match size {
        TileSize::Room => (44, "tile-room"),
        TileSize::Message => (34, "tile-message"),
        TileSize::Header => (30, "tile-header"),
        TileSize::Profile => (96, "tile-profile"),
    };
    let gradient = if neutral { "tile-neutral".to_owned() } else { format!("tile-g{}", gradient_index(key)) };
    let label = gtk::Label::builder()
        .label(glyph)
        .css_classes(["tile-glyph"])
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .build();
    // Explicitly non-expanding: otherwise the centred glyph's expand flags
    // propagate up and the tile claims half of every row it sits in.
    let tile = gtk::Overlay::builder()
        .css_classes(["tile", class, gradient.as_str()])
        .width_request(px)
        .height_request(px)
        .hexpand(false)
        .vexpand(false)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Start)
        .overflow(gtk::Overflow::Hidden)
        .child(&label)
        .build();
    tile.upcast()
}

/// A frame `width` × `height` when there is room, scaled down in a narrow window.
pub fn media_frame(width: i32, height: i32, classes: &[&str]) -> gtk::Overlay {
    gtk::Overlay::builder()
        .child(&crate::sizer::Sizer::new(width, height))
        .css_classes(classes.to_vec())
        .halign(gtk::Align::Start)
        .overflow(gtk::Overflow::Hidden)
        .build()
}

/// Lays the real photo over a tile; the gradient stays as its backdrop.
pub fn set_photo(tile: &gtk::Widget, texture: &gtk::gdk::Texture) {
    let Some(overlay) = tile.downcast_ref::<gtk::Overlay>() else { return };
    let picture =
        gtk::Picture::builder().paintable(texture).content_fit(gtk::ContentFit::Cover).can_shrink(true).build();
    overlay.add_overlay(&picture);
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

/// Send glyph drawn with Cairo, centred on the button whatever the icon theme:
/// themed arrows (Papirus, Breeze) sit off-centre in their own canvas.
pub fn send_arrow() -> gtk::DrawingArea {
    let area = gtk::DrawingArea::builder()
        .content_width(20)
        .content_height(20)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .can_target(false)
        .build();
    area.set_draw_func(|_, cr, w, h| {
        let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
        cr.set_source_rgb(0.043, 0.035, 0.075);
        cr.set_line_width(2.4);
        cr.set_line_cap(gtk::cairo::LineCap::Round);
        cr.set_line_join(gtk::cairo::LineJoin::Round);
        cr.move_to(cx, cy + 6.5);
        cr.line_to(cx, cy - 6.5);
        cr.move_to(cx - 5.5, cy - 1.0);
        cr.line_to(cx, cy - 6.5);
        cr.line_to(cx + 5.5, cy - 1.0);
        let _ = cr.stroke();
    });
    area
}

/// The four-point star of "✦ New messages": few fonts carry U+2726.
pub fn sparkle() -> gtk::DrawingArea {
    let area = gtk::DrawingArea::builder()
        .content_width(12)
        .content_height(12)
        .valign(gtk::Align::Center)
        .can_target(false)
        .build();
    area.set_draw_func(|_, cr, w, h| {
        let (cx, cy, r) = (w as f64 / 2.0, h as f64 / 2.0, w.min(h) as f64 / 2.0);
        let waist = r * 0.28;
        cr.set_source_rgb(1.0, 0.373, 0.635);
        cr.move_to(cx, cy - r);
        cr.curve_to(cx + waist * 0.4, cy - waist, cx + waist, cy - waist * 0.4, cx + r, cy);
        cr.curve_to(cx + waist, cy + waist * 0.4, cx + waist * 0.4, cy + waist, cx, cy + r);
        cr.curve_to(cx - waist * 0.4, cy + waist, cx - waist, cy + waist * 0.4, cx - r, cy);
        cr.curve_to(cx - waist, cy - waist * 0.4, cx - waist * 0.4, cy - waist, cx, cy - r);
        let _ = cr.fill();
    });
    area
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
