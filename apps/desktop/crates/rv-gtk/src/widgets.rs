//! The Android kit's signature pieces, rebuilt in GTK: gradient avatar tiles,
//! the gradient logotype, the glowing call-to-action, pill fields, the yellow
//! unread capsule and the sync comet.

use std::cell::RefCell;
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;

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
    let label = gtk::Label::builder()
        .label(glyph)
        .css_classes(["tile-glyph"])
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .build();
    tile_with(key, &label, size, neutral)
}

/// A tile holding a symbolic icon rather than a character: a locked room, a
/// discussion. Never an emoji, which the font draws in colour.
pub fn icon_tile(key: &str, icon: &str, size: TileSize, neutral: bool) -> gtk::Widget {
    let px = match size {
        TileSize::Room => 20,
        TileSize::Message => 16,
        TileSize::Header => 14,
        TileSize::Profile => 40,
    };
    let image = gtk::Image::builder()
        .icon_name(icon)
        .pixel_size(px)
        .css_classes(["tile-glyph"])
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .build();
    tile_with(key, &image, size, neutral)
}

/// A symbolic icon before a widget, where an emoji used to mark it.
pub fn with_icon(icon: &str, widget: &impl IsA<gtk::Widget>, classes: &[&str]) -> gtk::Box {
    let row = gtk::Box::builder().spacing(6).build();
    for class in classes {
        row.add_css_class(class);
    }
    row.append(&gtk::Image::builder().icon_name(icon).valign(gtk::Align::Center).build());
    row.append(widget);
    row
}

fn tile_with(key: &str, child: &impl IsA<gtk::Widget>, size: TileSize, neutral: bool) -> gtk::Widget {
    let (px, class) = match size {
        TileSize::Room => (44, "tile-room"),
        TileSize::Message => (34, "tile-message"),
        TileSize::Header => (30, "tile-header"),
        TileSize::Profile => (96, "tile-profile"),
    };
    let gradient = if neutral { "tile-neutral".to_owned() } else { format!("tile-g{}", gradient_index(key)) };
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
        .child(child)
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

/// On Windows, the taskbar button's badge needs the window's handle, known once it is mapped.
pub fn badge_follows(window: &impl IsA<gtk::Window>) {
    #[cfg(windows)]
    {
        let hand_over = |window: &gtk::Window| {
            if let Some(surface) = window.surface().and_downcast::<gdk4_win32::Win32Surface>() {
                rv_native::set_window(surface.handle().0 as isize);
            }
        };
        if window.as_ref().is_mapped() {
            hand_over(window.as_ref());
        }
        window.as_ref().connect_map(move |window| hand_over(window));
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// Lays the real photo over a tile and drops the gradient and glyph under it,
/// so a transparent photo does not show them through.
pub fn set_photo(tile: &gtk::Widget, texture: &gtk::gdk::Texture) {
    let Some(overlay) = tile.downcast_ref::<gtk::Overlay>() else { return };
    for class in overlay.css_classes() {
        if is_gradient_class(&class) {
            overlay.remove_css_class(&class);
        }
    }
    if let Some(child) = overlay.child() {
        child.set_opacity(0.0);
    }
    let picture =
        gtk::Picture::builder().paintable(texture).content_fit(gtk::ContentFit::Cover).can_shrink(true).build();
    overlay.add_overlay(&picture);
}

fn is_gradient_class(class: &str) -> bool {
    class == "tile-neutral"
        || class.strip_prefix("tile-g").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
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

/// A small capsule beside a name: `admin`, `deactivated`, `bot`...
pub fn badge(text: &str, kind: &str) -> gtk::Label {
    gtk::Label::builder().label(text).valign(gtk::Align::Center).css_classes(["admin-badge", kind]).build()
}

/// "BOT", beside the name of a bot account (RFC 0003).
pub fn bot_badge() -> gtk::Label {
    let label = badge(crate::i18n::t("bots.badge"), "bot");
    label.add_css_class("bot-badge");
    label
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

/// A round play badge: a font's ▶ comes as a colour emoji on a square tile.
pub fn play_badge(size: i32) -> gtk::DrawingArea {
    let area = gtk::DrawingArea::builder()
        .content_width(size)
        .content_height(size)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .can_target(false)
        .build();
    area.set_draw_func(|_, cr, w, h| {
        let (cx, cy, r) = (w as f64 / 2.0, h as f64 / 2.0, w.min(h) as f64 / 2.0);
        cr.set_source_rgba(0.0, 0.0, 0.0, 0.55);
        cr.arc(cx, cy, r, 0.0, std::f64::consts::TAU);
        let _ = cr.fill();
        let side = r * 0.8;
        cr.set_source_rgb(1.0, 1.0, 1.0);
        cr.move_to(cx - side * 0.35, cy - side / 2.0);
        cr.line_to(cx + side * 0.55, cy);
        cr.line_to(cx - side * 0.35, cy + side / 2.0);
        cr.close_path();
        let _ = cr.fill();
    });
    area
}

/// A chain link, in the text colour: the icon themes' "insert link" reads as anything but.
pub fn link_glyph() -> gtk::DrawingArea {
    let area = gtk::DrawingArea::builder()
        .content_width(16)
        .content_height(16)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .can_target(false)
        .build();
    area.set_draw_func(|area, cr, w, h| {
        let color = area.color();
        cr.set_source_rgba(color.red().into(), color.green().into(), color.blue().into(), color.alpha().into());
        cr.set_line_width(1.8);
        cr.translate(w as f64 / 2.0, h as f64 / 2.0);
        cr.rotate(-std::f64::consts::FRAC_PI_4);
        for dx in [-3.2, 3.2] {
            let (x, y, len, r) = (dx - 4.2, -2.6, 8.4, 2.6);
            cr.new_sub_path();
            cr.arc(x + len - r, y + r, r, -std::f64::consts::FRAC_PI_2, std::f64::consts::FRAC_PI_2);
            cr.arc(x + r, y + r, r, std::f64::consts::FRAC_PI_2, 3.0 * std::f64::consts::FRAC_PI_2);
            cr.close_path();
        }
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

/// Thin brand-gradient comet sweeping the window's top edge while syncing.
pub fn comet() -> gtk::Box {
    gtk::Box::builder().css_classes(["comet"]).height_request(3).valign(gtk::Align::Start).can_target(false).build()
}

/// An incoming call needs an explicit answer. Remote endings and account
/// teardown still force-close it after removing its active ring record.
pub fn incoming_call_alert(body: &str) -> adw::AlertDialog {
    let dialog = adw::AlertDialog::builder()
        .heading(crate::i18n::t("voice_session.incoming"))
        .body(body)
        .default_response("accept")
        .close_response("ignore")
        .can_close(false)
        .build();
    dialog.add_responses(&[
        ("decline", crate::i18n::t("voice_session.decline")),
        ("accept", crate::i18n::t("voice_session.accept")),
    ]);
    dialog.set_response_appearance("decline", adw::ResponseAppearance::Destructive);
    dialog.set_response_appearance("accept", adw::ResponseAppearance::Suggested);
    dialog
}

/// Presents every dialog through the same backdrop handling. Dismissible
/// dialogs close like Escape; incoming calls keep waiting for an answer.
pub fn present(dialog: &impl IsA<adw::Dialog>, parent: Option<&impl IsA<gtk::Widget>>) {
    dialog.present(parent);
    close_on_backdrop(dialog.upcast_ref());
}

fn dimming(widget: &gtk::Widget) -> Option<gtk::Widget> {
    if widget.css_name() == "dimming" {
        return Some(widget.clone());
    }
    std::iter::successors(widget.first_child(), |w| w.next_sibling()).find_map(|child| dimming(&child))
}

/// The dimmed backdrop around a dialog is a window handle: a click there
/// started a window drag and a double click maximized the window. A click on
/// it closes a dismissible dialog instead. A window resize can switch the dialog
/// between a floating and a bottom sheet, which builds a new backdrop: the
/// watch is armed again then, until the dialog closes.
pub fn close_on_backdrop(dialog: &adw::Dialog) {
    arm(dialog);
    let Some(window) = dialog.root().and_downcast::<gtk::Window>() else { return };
    let handlers: Vec<glib::SignalHandlerId> = ["default-width", "default-height", "maximized", "fullscreened"]
        .into_iter()
        .map(|property| {
            let weak = dialog.downgrade();
            window.connect_notify_local(Some(property), move |_, _| {
                if let Some(dialog) = weak.upgrade() {
                    arm(&dialog);
                }
            })
        })
        .collect();
    let (window, handlers) = (window.downgrade(), RefCell::new(Some(handlers)));
    dialog.connect_closed(move |_| {
        if let (Some(window), Some(handlers)) = (window.upgrade(), handlers.take()) {
            for handler in handlers {
                window.disconnect(handler);
            }
        }
    });
}

/// Looks for the backdrop until it has its click (it exists once the dialog
/// laid itself out), then stops; stops too when the dialog left its host.
fn arm(dialog: &adw::Dialog) {
    let weak = dialog.downgrade();
    let mut tries = 0;
    glib::timeout_add_local(std::time::Duration::from_millis(60), move || {
        tries += 1;
        let Some(dialog) = weak.upgrade().filter(|d| d.parent().is_some()) else {
            return glib::ControlFlow::Break;
        };
        let Some(backdrop) = dimming(dialog.upcast_ref()) else {
            return if tries < 50 { glib::ControlFlow::Continue } else { glib::ControlFlow::Break };
        };
        if backdrop.has_css_class("closes-dialog") {
            return glib::ControlFlow::Break;
        }
        backdrop.add_css_class("closes-dialog");
        let click = gtk::GestureClick::builder().button(0).propagation_phase(gtk::PropagationPhase::Capture).build();
        click.connect_pressed(|gesture, _, _, _| {
            gesture.set_state(gtk::EventSequenceState::Claimed);
        });
        let weak = dialog.downgrade();
        click.connect_released(move |_, _, _, _| {
            if let Some(dialog) = weak.upgrade().filter(|dialog| dialog.can_close()) {
                dialog.close();
            }
        });
        backdrop.add_controller(click);
        glib::ControlFlow::Break
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn settle(ms: u64) {
        let context = glib::MainContext::default();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        while std::time::Instant::now() < deadline {
            while context.pending() {
                context.iteration(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    fn descendants(widget: &gtk::Widget) -> Vec<gtk::Widget> {
        let mut widgets = vec![widget.clone()];
        for child in std::iter::successors(widget.first_child(), |w| w.next_sibling()) {
            widgets.extend(descendants(&child));
        }
        widgets
    }

    fn click_backdrop(dialog: &adw::Dialog) {
        let backdrop = dimming(dialog.upcast_ref()).expect("the presented dialog's own backdrop");
        let controllers = backdrop.observe_controllers();
        let click = (0..controllers.n_items())
            .filter_map(|i| controllers.item(i).and_downcast::<gtk::GestureClick>())
            .find(|c| c.button() == 0 && c.propagation_phase() == gtk::PropagationPhase::Capture)
            .expect("the app's backdrop click handler");
        click.emit_by_name::<()>("released", &[&1i32, &5f64, &5f64]);
        settle(150);
    }

    /// Activate libadwaita's actual Escape binding, including its can-close
    /// check, rather than emitting a response or testing only a property.
    fn escape(window: &adw::Window) {
        for widget in descendants(window.upcast_ref()) {
            let controllers = widget.observe_controllers();
            for controller in
                (0..controllers.n_items()).filter_map(|i| controllers.item(i).and_downcast::<gtk::ShortcutController>())
            {
                for shortcut in
                    (0..controller.n_items()).filter_map(|i| controller.item(i).and_downcast::<gtk::Shortcut>())
                {
                    if shortcut.trigger().and_downcast::<gtk::KeyvalTrigger>().is_some_and(|trigger| {
                        trigger.keyval() == gtk::gdk::Key::Escape && trigger.modifiers().is_empty()
                    }) {
                        shortcut.action().expect("Escape's action").activate(
                            gtk::ShortcutActionFlags::empty(),
                            &widget,
                            shortcut.arguments().as_ref(),
                        );
                        settle(150);
                        return;
                    }
                }
            }
        }
        panic!("the presented dialog must expose libadwaita's Escape binding");
    }

    #[test]
    #[ignore = "requires a GTK display; run under Xvfb"]
    fn incoming_calls_require_answers_and_keep_remote_and_account_closure() {
        adw::init().unwrap();
        let window = adw::Window::builder().default_width(1280).default_height(900).build();
        window.set_content(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
        window.present();
        settle(200);

        // The same production prompt serves Rocket.Chat, kChat, native voice
        // and background accounts. Real buttons and notification responses
        // both retire the active ring before force-closing it.
        for body in ["Alice is calling", "Alice is calling on another account"] {
            for (response, notification) in [("accept", false), ("decline", false), ("accept", true), ("decline", true)]
            {
                let dialog = incoming_call_alert(body);
                let active = Rc::new(Cell::new(true));
                let answers: Rc<RefCell<Vec<String>>> = Rc::default();
                let (pending, log) = (active.clone(), answers.clone());
                dialog.connect_response(None, move |dialog, response| {
                    if !pending.replace(false) {
                        return;
                    }
                    log.borrow_mut().push(response.to_owned());
                    dialog.force_close();
                });
                let attempts = Rc::new(Cell::new(0));
                let attempts_log = attempts.clone();
                dialog.connect_close_attempt(move |_| attempts_log.set(attempts_log.get() + 1));
                present(&dialog, Some(&window));
                settle(350);

                click_backdrop(dialog.upcast_ref());
                assert!(dialog.is_mapped() && active.get(), "a backdrop click must keep the ring active");
                assert!(answers.borrow().is_empty(), "a backdrop click never answers or ignores the ring");
                escape(&window);
                assert!(attempts.get() > 0, "the actual Escape close attempt reached the dialog");
                assert!(dialog.is_mapped() && active.get(), "Escape must keep the ring active");
                assert!(answers.borrow().is_empty(), "Escape never answers or ignores the ring");

                if notification {
                    dialog.emit_by_name::<()>("response", &[&response]);
                } else {
                    let label = crate::i18n::t(if response == "accept" {
                        "voice_session.accept"
                    } else {
                        "voice_session.decline"
                    });
                    let button = descendants(dialog.upcast_ref())
                        .into_iter()
                        .filter_map(|widget| widget.downcast::<gtk::Button>().ok())
                        .find(|button| button.label().as_deref() == Some(label))
                        .expect("the production response button");
                    button.emit_clicked();
                }
                settle(350);
                assert!(!dialog.is_mapped() && !active.get(), "the explicit answer closes and retires the prompt");
                assert_eq!(*answers.borrow(), [response], "the chosen answer is handled exactly once");
            }
        }

        // Remote end and account teardown remove the active record first.
        // The forced close still works without accepting or declining it.
        for _ in ["remote ended", "account closed"] {
            let dialog = incoming_call_alert("Alice is calling");
            let active = Rc::new(Cell::new(true));
            let answers: Rc<RefCell<Vec<String>>> = Rc::default();
            let (pending, log) = (active.clone(), answers.clone());
            dialog.connect_response(None, move |_, response| {
                if pending.get() {
                    log.borrow_mut().push(response.to_owned());
                }
            });
            present(&dialog, Some(&window));
            settle(350);
            active.set(false);
            dialog.force_close();
            settle(350);
            assert!(!dialog.is_mapped(), "remote and account termination still close the prompt");
            assert!(answers.borrow().is_empty(), "a withdrawn ring sends no answer");
        }

        // Ordinary confirmation dialogs retain their Cancel dismissal.
        for outside in [true, false] {
            let dialog = adw::AlertDialog::builder().heading("Delete?").close_response("cancel").build();
            dialog.add_responses(&[("cancel", "Cancel"), ("delete", "Delete")]);
            let answers: Rc<RefCell<Vec<String>>> = Rc::default();
            let log = answers.clone();
            dialog.connect_response(None, move |_, response| log.borrow_mut().push(response.to_owned()));
            present(&dialog, Some(&window));
            settle(350);
            if outside {
                click_backdrop(dialog.upcast_ref());
            } else {
                escape(&window);
            }
            settle(350);
            assert!(!dialog.is_mapped(), "ordinary confirmations remain dismissible");
            assert_eq!(*answers.borrow(), ["cancel"], "dismissal cancels, never deletes");
        }
        window.close();
    }

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
