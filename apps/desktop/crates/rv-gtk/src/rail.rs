//! The server rail: a button per signed-in account down the window's left
//! edge, the open one marked, a dot on another one with unread messages, and
//! "+" to add an account. Only the open account is connected: the others are
//! checked every minute with one cheap read (`rv_core::account_unread`).
//! A right click or a long press on a button asks for its menu.
//! Settings > Accounts can hide it (`hidden`, off by default); that page still
//! switches and adds accounts.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use gtk::glib;
use gtk::prelude::*;
use rv_core::server_icon::Icon;
use rv_core::session::SessionInfo;

use crate::i18n::t;
use crate::secrets::account_key;
use crate::widgets::{self, TileSize};

const POLL: Duration = Duration::from_secs(60);

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
    /// Each button's account, key, overlay and initial tile, to read the icons again.
    slots: RefCell<Vec<Slot>>,
    unread: RefCell<HashMap<String, bool>>,
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
    glib::user_config_dir().join("rocket-vibe-rs").join("hide-server-rail")
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
    url::Url::parse(&info.base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_owned()))
        .unwrap_or_else(|| info.base_url.clone())
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
            slots: RefCell::default(),
            unread: RefCell::default(),
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
        let weak = Rc::downgrade(&this);
        glib::timeout_add_local(POLL, move || {
            let Some(this) = weak.upgrade() else { return glib::ControlFlow::Break };
            this.poll();
            glib::ControlFlow::Continue
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

    /// The signed-in accounts and the open one; the dots are checked at once.
    pub fn set_accounts(self: &Rc<Self>, accounts: Vec<SessionInfo>, active: Option<&SessionInfo>) {
        self.generation.set(self.generation.get().wrapping_add(1));
        let active = active.map(account_key);
        // The open account's own unread shows in its room list, not here.
        if let Some(key) = &active {
            self.unread.borrow_mut().remove(key);
        }
        self.active.replace(active.clone());
        while let Some(child) = self.buttons.first_child() {
            self.buttons.remove(&child);
        }
        self.dots.borrow_mut().clear();
        self.slots.borrow_mut().clear();
        for info in &accounts {
            let key = account_key(info);
            let open = active.as_deref() == Some(key.as_str());
            let server = host(info);
            let tile = widgets::tile(&key, &widgets::initial(&server), TileSize::Room, false);
            let dot = gtk::Box::builder()
                .css_classes(["rail-dot"])
                .halign(gtk::Align::End)
                .valign(gtk::Align::Start)
                .visible(!open && self.unread.borrow().get(&key).copied().unwrap_or(false))
                .build();
            let overlay = gtk::Overlay::builder().child(&tile).build();
            overlay.add_overlay(&dot);
            if let Some(texture) = self.icons.borrow().get(&key) {
                overlay.set_child(Some(&icon_image(Some(texture))));
            }
            self.load_icon(info, &key, &overlay, &tile);
            self.slots.borrow_mut().push((info.clone(), key.clone(), overlay.downgrade(), tile.clone()));
            let button = gtk::Button::builder()
                .child(&overlay)
                .tooltip_text(format!("{} · @{}", server, info.username))
                .css_classes(["rail-button"])
                .halign(gtk::Align::Center)
                .build();
            if open {
                button.add_css_class("rail-active");
            }
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
        self.poll();
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

    /// One read per account that is not the open one; a failure leaves the
    /// dot as it was (offline, or a server that refuses for a moment).
    fn poll(self: &Rc<Self>) {
        let generation = self.generation.get();
        let active = self.active.borrow().clone();
        for info in self.accounts.borrow().iter().cloned() {
            let key = account_key(&info);
            if active.as_deref() == Some(key.as_str()) {
                continue;
            }
            let weak = Rc::downgrade(self);
            glib::spawn_future_local(async move {
                let found = crate::on_tokio(async move {
                    if info.native.is_some() {
                        rv_core::account_unread::native(info, Some(crate::secrets::native_credentials())).await.ok()
                    } else {
                        rv_core::account_unread::rocket_chat(&info).await.ok()
                    }
                })
                .await;
                let (Some(this), Some(unread)) = (weak.upgrade(), found) else { return };
                if this.generation.get() != generation {
                    return;
                }
                this.unread.borrow_mut().insert(key.clone(), unread);
                if let Some(dot) = this.dots.borrow().get(&key) {
                    dot.set_visible(unread);
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
