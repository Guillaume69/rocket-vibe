//! The server rail: a button per signed-in account down the window's left
//! edge, the open one marked, a dot on another one with unread messages, and
//! "+" to add an account. Every account stays connected in the background
//! (`rv_core::supervisor`), whose unread state lights the dots.
//! A right click or a long press on a button asks for its menu.
//! Settings > Accounts can hide it (`hidden`, off by default); that page still
//! switches and adds accounts.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gtk::glib;
use gtk::prelude::*;
use rv_core::server_icon::Icon;
use rv_core::session::SessionInfo;

use crate::i18n::t;
use crate::secrets::account_key;
use crate::widgets::{self, TileSize};

type Handler<T> = RefCell<Option<Rc<dyn Fn(T)>>>;
/// A button's account, key, overlay and initial tile.
type Slot = (SessionInfo, String, glib::WeakRef<gtk::Overlay>, gtk::Widget);

pub struct Rail {
    pub root: gtk::Box,
    buttons: gtk::Box,
    accounts: RefCell<Vec<SessionInfo>>,
    active: RefCell<Option<String>>,
    dots: RefCell<HashMap<String, gtk::Widget>>,
    /// Each server's own icon once read (`rv_core::server_icon`), shown at
    /// once on the next rebuild while it is read again.
    icons: RefCell<HashMap<String, gtk::gdk::Texture>>,
    /// The photo bytes each account's tile was last drawn from.
    photo_sources: RefCell<std::collections::HashMap<String, usize>>,
    /// Each button's account, key, overlay and initial tile, to read the icons again.
    slots: RefCell<Vec<Slot>>,
    unread: RefCell<HashMap<String, bool>>,
    /// The muted accounts (`rv_core::account_mute`): dimmed, a muted mark, no dot.
    muted: RefCell<std::collections::HashSet<String>>,
    /// Each account's button and its muted mark, for the muted look.
    muted_looks: RefCell<HashMap<String, (gtk::Button, gtk::Widget)>>,
    /// Bumped by each new account list: a late answer about a list that
    /// changed meanwhile is dropped.
    generation: Cell<u64>,
    on_switch: Handler<SessionInfo>,
    on_add: Handler<()>,
    on_menu: Handler<(gtk::Widget, SessionInfo)>,
}

thread_local! {
    /// The window's rail, for the administration to refresh after an icon change.
    static CURRENT: RefCell<std::rc::Weak<Rail>> = RefCell::default();
}

/// Reads the rail's icons again, when there is a rail.
pub fn reload_icons() {
    if let Some(rail) = CURRENT.with_borrow(std::rc::Weak::upgrade) {
        rail.reload_icons();
    }
}

fn hidden_file() -> std::path::PathBuf {
    crate::config_dir().join("hide-server-rail")
}

fn now_ms() -> i64 {
    glib::real_time() / 1000
}

thread_local! {
    /// The mutes as `mutes` last read them: notifications, rings and the badge
    /// ask here, not the file, and compare a timed mute's end with the clock
    /// (a computer that slept past it is no longer muted).
    static MUTES: RefCell<HashMap<String, rv_core::account_mute::Mute>> = RefCell::default();
}

/// The account's mute now (`rv_core::account_mute`), shared with the SwiftUI app.
pub fn mute_of(info: &SessionInfo) -> Option<rv_core::account_mute::Mute> {
    use rv_core::account_mute::Mute;
    let mute = MUTES.with_borrow(|mutes| mutes.get(&account_key(info)).copied())?;
    match mute {
        Mute::Until(end) if end <= now_ms() => None,
        _ => Some(mute),
    }
}

/// Whether the account is muted now: no notification, sound or ring.
pub fn is_muted(info: &SessionInfo) -> bool {
    mute_of(info).is_some()
}

/// Mutes the account until `until` (ms), or until unmuted with None; `mutes`
/// reads it back.
pub fn mute(info: &SessionInfo, until: Option<i64>) {
    rv_core::account_mute::mute(&crate::config_dir(), &account_key(info), until);
}

pub fn unmute(info: &SessionInfo) {
    rv_core::account_mute::unmute(&crate::config_dir(), &account_key(info));
}

/// Reads the mutes (the SwiftUI app may have changed them): the muted
/// accounts' keys now, and the earliest end of a timed mute.
pub fn mutes() -> (std::collections::HashSet<String>, Option<i64>) {
    use rv_core::account_mute::Mute;
    let active = rv_core::account_mute::active(&crate::config_dir(), now_ms());
    let next = active
        .values()
        .filter_map(|mute| match mute {
            Mute::Until(end) => Some(*end),
            Mute::Forever => None,
        })
        .min();
    let keys = active.keys().cloned().collect();
    MUTES.replace(active);
    (keys, next)
}

/// The digit a Ctrl + key press means, whatever the layout: the key's own
/// symbol, or the digit the same physical key types with Shift (AZERTY types
/// `&` there and `1` shifted), or a keypad digit. None with Shift, Alt or
/// Super held: Ctrl+Shift+7 to 9 format the composer's text.
pub fn shortcut_digit(
    display: &gtk::gdk::Display,
    key: gtk::gdk::Key,
    code: u32,
    state: gtk::gdk::ModifierType,
) -> Option<u32> {
    use gtk::gdk::ModifierType as M;
    if !state.contains(M::CONTROL_MASK) || state.intersects(M::SHIFT_MASK | M::ALT_MASK | M::SUPER_MASK | M::META_MASK)
    {
        return None;
    }
    let digit = |key: gtk::gdk::Key| key.to_unicode().and_then(|c| c.to_digit(10));
    // Only a symbol key falls back to its shifted digit (AZERTY's `&`): a
    // keypad key without NumLock (`KP_End`, `KP_Left`) moves the cursor.
    digit(key).or_else(|| {
        key.to_unicode()?;
        display
            .map_keycode(code)
            .unwrap_or_default()
            .into_iter()
            .find_map(|(entry, key)| (entry.level() == 1).then(|| digit(key)).flatten())
    })
}

/// The user's choice to hide the rail, shared with the SwiftUI app.
pub fn hidden() -> bool {
    hidden_file().exists()
}

/// A server's icon as a square decoded at most 88 pixels wide (twice the
/// tile), whatever size its file declares: a server's file never decodes at
/// full size here, and a non-square one is center-cropped like a tile covers.
pub(crate) fn icon_texture(bytes: &[u8]) -> Option<gtk::gdk::Texture> {
    use gtk::gdk_pixbuf::PixbufLoader;
    const SIDE: i32 = 88;
    let loader = PixbufLoader::new();
    loader.connect_size_prepared(|loader, width, height| {
        let scale = (f64::from(SIDE) / f64::from(width.min(height).max(1))).min(1.0);
        loader.set_size(((f64::from(width) * scale) as i32).max(1), ((f64::from(height) * scale) as i32).max(1));
    });
    loader.write(bytes).ok()?;
    loader.close().ok()?;
    let pixbuf = loader.pixbuf()?;
    let edge = pixbuf.width().min(pixbuf.height());
    let square = pixbuf.new_subpixbuf((pixbuf.width() - edge) / 2, (pixbuf.height() - edge) / 2, edge, edge);
    #[allow(deprecated)]
    Some(gtk::gdk::Texture::for_pixbuf(&square))
}

/// A server's icon at exactly a tile's size. A `gtk::Image` measures its
/// `pixel_size`; a `gtk::Picture` measures its texture, twice the tile.
pub(crate) fn icon_image(texture: Option<&gtk::gdk::Texture>) -> gtk::Image {
    let image = gtk::Image::builder()
        .pixel_size(44)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .overflow(gtk::Overflow::Hidden)
        .css_classes(["rail-icon"])
        .build();
    image.set_paintable(texture);
    image
}

/// What the rail shows of a server: its host, without `www.`.
fn host(info: &SessionInfo) -> String {
    rv_core::supervisor::server_label(info)
}

impl Rail {
    pub fn new() -> Rc<Self> {
        let buttons = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(10).build();
        // A square of the tiles' very size, not a padded button.
        // An image draws its icon centred in its requested size.
        let square = gtk::Image::builder()
            .icon_name("list-add-symbolic")
            .pixel_size(20)
            .width_request(44)
            .height_request(44)
            .css_classes(["rail-add"])
            .build();
        let add = gtk::Button::builder()
            .child(&square)
            .tooltip_text(t("rail.add"))
            .css_classes(["rail-button"])
            .halign(gtk::Align::Center)
            .build();
        let root = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(10)
            .css_classes(["server-rail"])
            .build();
        root.append(&buttons);
        root.append(&add);
        let this = Rc::new(Rail {
            root,
            buttons,
            accounts: RefCell::default(),
            active: RefCell::default(),
            dots: RefCell::default(),
            icons: RefCell::default(),
            photo_sources: RefCell::default(),
            slots: RefCell::default(),
            unread: RefCell::default(),
            muted: RefCell::default(),
            muted_looks: RefCell::default(),
            generation: Cell::new(0),
            on_switch: RefCell::default(),
            on_add: RefCell::default(),
            on_menu: RefCell::default(),
        });
        let weak = Rc::downgrade(&this);
        add.connect_clicked(move |_| {
            if let Some(f) = weak.upgrade().and_then(|this| this.on_add.borrow().clone()) {
                f(());
            }
        });
        CURRENT.with_borrow_mut(|current| *current = Rc::downgrade(&this));
        this
    }

    pub fn connect_switch(&self, f: impl Fn(SessionInfo) + 'static) {
        self.on_switch.replace(Some(Rc::new(f)));
    }

    pub fn connect_add(&self, f: impl Fn(()) + 'static) {
        self.on_add.replace(Some(Rc::new(f)));
    }

    /// The menu of an account's button: the button and the account.
    pub fn connect_menu(&self, f: impl Fn((gtk::Widget, SessionInfo)) + 'static) {
        self.on_menu.replace(Some(Rc::new(f)));
    }

    /// The signed-in accounts and the open one.
    pub fn set_accounts(self: &Rc<Self>, accounts: Vec<SessionInfo>, active: Option<&SessionInfo>) {
        self.generation.set(self.generation.get().wrapping_add(1));
        let active = active.map(account_key);
        self.active.replace(active.clone());
        while let Some(child) = self.buttons.first_child() {
            self.buttons.remove(&child);
        }
        self.dots.borrow_mut().clear();
        self.slots.borrow_mut().clear();
        self.muted_looks.borrow_mut().clear();
        for (slot, info) in accounts.iter().enumerate() {
            let key = account_key(info);
            let open = active.as_deref() == Some(key.as_str());
            let muted = self.muted.borrow().contains(&key);
            let server = host(info);
            let tile = widgets::tile(&key, &widgets::initial(&server), TileSize::Room, false);
            let dot = gtk::Box::builder()
                .css_classes(["rail-dot"])
                .halign(gtk::Align::End)
                .valign(gtk::Align::Start)
                .visible(!open && !muted && self.unread.borrow().get(&key).copied().unwrap_or(false))
                .build();
            let mark = gtk::Image::builder()
                .icon_name("notifications-disabled-symbolic")
                .pixel_size(14)
                .css_classes(["rail-muted-mark"])
                .halign(gtk::Align::End)
                .valign(gtk::Align::End)
                .visible(muted)
                .build();
            let overlay = gtk::Overlay::builder().child(&tile).build();
            overlay.add_overlay(&dot);
            overlay.add_overlay(&mark);
            if let Some(texture) = self.icons.borrow().get(&key) {
                overlay.set_child(Some(&icon_image(Some(texture))));
            }
            // A WhatsApp account has no server icon: its photo comes from `set_photo`.
            if !rv_core::whatsapp::is_whatsapp(info) {
                self.load_icon(info, &key, &overlay, &tile);
            }
            self.slots.borrow_mut().push((info.clone(), key.clone(), overlay.downgrade(), tile.clone()));
            // The first ten say their Ctrl + digit shortcut (`AppWindow::new`'s key handler).
            // The digit keys are named after their digit ("1", "0").
            let shortcut = rv_core::server_rail::shortcut_digit(slot)
                .and_then(|digit| gtk::gdk::Key::from_name(digit.to_string()))
                .map(|key| {
                    let label = gtk::accelerator_get_label(key, gtk::gdk::ModifierType::CONTROL_MASK);
                    format!(" ({label})")
                })
                .unwrap_or_default();
            let button = gtk::Button::builder()
                .child(&overlay)
                .tooltip_text(format!("{} · @{}{shortcut}", server, info.username))
                .css_classes(["rail-button"])
                .halign(gtk::Align::Center)
                .build();
            self.reorderable(&button, &overlay, &key);
            if open {
                button.add_css_class("rail-active");
            }
            if muted {
                button.add_css_class("rail-muted");
            }
            self.muted_looks.borrow_mut().insert(key.clone(), (button.clone(), mark.upcast()));
            let (weak, target) = (Rc::downgrade(self), info.clone());
            button.connect_clicked(move |_| {
                let Some(this) = weak.upgrade() else { return };
                if this.active.borrow().as_deref() == Some(account_key(&target).as_str()) {
                    return;
                }
                if let Some(f) = this.on_switch.borrow().clone() {
                    f(target.clone());
                }
            });
            let menu = {
                let (weak, target, anchor) = (Rc::downgrade(self), info.clone(), button.downgrade());
                move || {
                    let (Some(this), Some(anchor)) = (weak.upgrade(), anchor.upgrade()) else { return };
                    if let Some(f) = this.on_menu.borrow().clone() {
                        f((anchor.upcast(), target.clone()));
                    }
                }
            };
            let click = gtk::GestureClick::builder().button(3).build();
            let open_menu = menu.clone();
            click.connect_pressed(move |gesture, _, _, _| {
                gesture.set_state(gtk::EventSequenceState::Claimed);
                open_menu();
            });
            button.add_controller(click);
            let press = gtk::GestureLongPress::new();
            press.connect_pressed(move |gesture, _, _| {
                gesture.set_state(gtk::EventSequenceState::Claimed);
                menu();
            });
            button.add_controller(press);
            self.buttons.append(&button);
            self.dots.borrow_mut().insert(key, dot.upcast());
        }
        self.accounts.replace(accounts);
        self.apply_visibility();
    }

    /// Opens the account at the rail's `slot` (Ctrl + digit), as its button
    /// does: nothing past the last account or on the open one.
    pub fn open_slot(&self, slot: usize) {
        let Some(target) = self.accounts.borrow().get(slot).cloned() else { return };
        if self.active.borrow().as_deref() == Some(account_key(&target).as_str()) {
            return;
        }
        if let Some(f) = self.on_switch.borrow().clone() {
            f(target);
        }
    }

    /// A button dragged onto another takes its place (`server_rail::reordered`),
    /// kept for the next launch and for the SwiftUI app.
    fn reorderable(self: &Rc<Self>, button: &gtk::Button, overlay: &gtk::Overlay, key: &str) {
        let source = gtk::DragSource::builder().actions(gtk::gdk::DragAction::MOVE).build();
        source.set_content(Some(&gtk::gdk::ContentProvider::for_value(&key.to_value())));
        let icon = overlay.downgrade();
        source.connect_drag_begin(move |source, _| {
            if let Some(overlay) = icon.upgrade() {
                source.set_icon(Some(&gtk::WidgetPaintable::new(Some(&overlay))), 22, 22);
            }
        });
        button.add_controller(source);
        let target = gtk::DropTarget::new(String::static_type(), gtk::gdk::DragAction::MOVE);
        let (weak, key) = (Rc::downgrade(self), key.to_owned());
        target.connect_drop(move |_, value, _, _| {
            let (Some(this), Ok(moved)) = (weak.upgrade(), value.get::<String>()) else { return false };
            let keys: Vec<String> = this.accounts.borrow().iter().map(account_key).collect();
            let Some(order) = rv_core::server_rail::reordered(&keys, &moved, &key) else { return false };
            rv_core::server_rail::save(&crate::config_dir(), &order);
            // Rebuilt once the drop is over: the buttons handling it go.
            glib::idle_add_local_once(move || {
                let mut accounts = this.accounts.borrow().clone();
                accounts.sort_by_key(|info| order.iter().position(|k| *k == account_key(info)));
                let active = this.active.borrow().clone();
                let open = accounts.iter().find(|info| active.as_deref() == Some(account_key(info).as_str())).cloned();
                this.set_accounts(accounts, open.as_ref());
            });
            true
        });
        button.add_controller(target);
    }

    /// Whether the account has unread rooms; the open account's own shows in
    /// its room list, not here.
    pub fn set_unread(&self, key: &str, unread: bool) {
        self.unread.borrow_mut().insert(key.to_owned(), unread);
        let open = self.active.borrow().as_deref() == Some(key);
        let muted = self.muted.borrow().contains(key);
        if let Some(dot) = self.dots.borrow().get(key) {
            dot.set_visible(unread && !open && !muted);
        }
    }

    /// The muted accounts now: dimmed, marked, their dot held back.
    pub fn set_muted(&self, keys: std::collections::HashSet<String>) {
        self.muted.replace(keys);
        let unread: Vec<(String, bool)> = self.unread.borrow().iter().map(|(k, u)| (k.clone(), *u)).collect();
        for (key, unread) in unread {
            self.set_unread(&key, unread);
        }
        let muted = self.muted.borrow();
        for (key, (button, mark)) in self.muted_looks.borrow().iter() {
            let on = muted.contains(key);
            mark.set_visible(on);
            if on {
                button.add_css_class("rail-muted");
            } else {
                button.remove_css_class("rail-muted");
            }
        }
    }

    pub fn forget_unread(&self, key: &str) {
        self.set_unread(key, false);
        self.unread.borrow_mut().remove(key);
    }

    /// Reads the server's icon; it replaces the initial, a server that
    /// dropped its icon goes back to the initial, and a read that concludes
    /// nothing (offline, refused) keeps what is shown. An answer about an
    /// older account list is dropped.
    fn load_icon(self: &Rc<Self>, info: &SessionInfo, key: &str, overlay: &gtk::Overlay, tile: &gtk::Widget) {
        let (weak, generation, key, info) = (Rc::downgrade(self), self.generation.get(), key.to_owned(), info.clone());
        let (overlay, tile) = (overlay.downgrade(), tile.clone());
        glib::spawn_future_local(async move {
            let icon = crate::on_tokio(async move { rv_core::server_icon::fetch(&info).await }).await;
            let (Some(this), Some(overlay)) = (weak.upgrade(), overlay.upgrade()) else { return };
            if this.generation.get() != generation {
                return;
            }
            match icon {
                Icon::Image(bytes) => {
                    if let Some(texture) = icon_texture(&bytes) {
                        overlay.set_child(Some(&icon_image(Some(&texture))));
                        this.icons.borrow_mut().insert(key, texture);
                    }
                }
                Icon::Absent => {
                    overlay.set_child(Some(&tile));
                    this.icons.borrow_mut().remove(&key);
                }
                Icon::Unknown => {}
            }
        });
    }

    /// An account's own photo in place of its initial (a WhatsApp account).
    pub fn set_photo(&self, key: &str, bytes: &std::sync::Arc<[u8]>) {
        let source = bytes.as_ptr() as usize;
        if self.photo_sources.borrow().get(key) == Some(&source) {
            return;
        }
        let Some(texture) = icon_texture(bytes) else { return };
        self.photo_sources.borrow_mut().insert(key.to_owned(), source);
        let slots = self.slots.borrow().clone();
        for (_, slot, overlay, _) in slots {
            if slot == key
                && let Some(overlay) = overlay.upgrade()
            {
                overlay.set_child(Some(&icon_image(Some(&texture))));
            }
        }
        self.icons.borrow_mut().insert(key.to_owned(), texture);
    }

    /// Reads every icon again (an administrator just changed one).
    pub fn reload_icons(self: &Rc<Self>) {
        let slots = self.slots.borrow().clone();
        for (info, key, overlay, tile) in slots {
            if let Some(overlay) = overlay.upgrade() {
                self.load_icon(&info, &key, &overlay, &tile);
            }
        }
    }

    /// Keeps the choice for the next launch and shows or hides the rail now.
    pub fn set_hidden(&self, hide: bool) {
        let file = hidden_file();
        if hide {
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(file, "");
        } else {
            let _ = std::fs::remove_file(file);
        }
        self.apply_visibility();
    }

    fn apply_visibility(&self) {
        self.root.set_visible(!self.accounts.borrow().is_empty() && !hidden());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires a GTK display; run under Xvfb"]
    fn control_and_a_digit_name_a_rail_position() {
        use gtk::gdk::{Key, ModifierType as M};
        gtk::init().unwrap();
        let display = gtk::gdk::Display::default().unwrap();
        // A keycode no key of the layout uses: only the symbol speaks.
        let digit = |key: Key, state: M| shortcut_digit(&display, key, 0, state);
        assert_eq!(digit(Key::_1, M::CONTROL_MASK), Some(1));
        assert_eq!(digit(Key::_0, M::CONTROL_MASK), Some(0));
        assert_eq!(digit(Key::KP_9, M::CONTROL_MASK), Some(9));
        assert_eq!(digit(Key::_1, M::empty()), None, "a digit typed alone");
        assert_eq!(digit(Key::_7, M::CONTROL_MASK | M::SHIFT_MASK), None, "the composer's list shortcut");
        assert_eq!(digit(Key::_1, M::CONTROL_MASK | M::ALT_MASK), None);
        assert_eq!(digit(Key::k, M::CONTROL_MASK), None, "the room switcher");
        // The keypad's 1 without NumLock is End: its key's shifted level is
        // KP_1, which must not count (Ctrl+End moves the cursor). Xvfb's US
        // layout has no AZERTY row, so the symbol fallback itself is not run here.
        for moving in [Key::KP_End, Key::KP_Left] {
            let code = display.map_keyval(moving).and_then(|k| k.first().map(|k| k.keycode()));
            let code = code.expect("the layout has a keypad");
            assert_eq!(shortcut_digit(&display, moving, code, M::CONTROL_MASK), None, "{moving:?}");
        }
    }

    #[test]
    #[ignore = "requires a GTK display; run under Xvfb"]
    fn an_icon_is_exactly_a_tile_whatever_its_file() {
        gtk::init().unwrap();
        let wide = gtk::gdk_pixbuf::Pixbuf::new(gtk::gdk_pixbuf::Colorspace::Rgb, true, 8, 300, 192).unwrap();
        wide.fill(0xff5fa2ff);
        let png = wide.save_to_bufferv("png", &[]).unwrap();
        let texture = icon_texture(&png).unwrap();
        assert_eq!((texture.width(), texture.height()), (88, 88));
        let image = icon_image(Some(&texture));
        for orientation in [gtk::Orientation::Horizontal, gtk::Orientation::Vertical] {
            let (minimum, natural, _, _) = image.measure(orientation, -1);
            assert_eq!((minimum, natural), (44, 44));
        }
    }
}
