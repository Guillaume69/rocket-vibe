//! The server rail: a button per signed-in account down the window's left
//! edge, the open one marked, a dot on another one with unread messages, and
//! "+" to add an account. Only the open account is connected: the others are
//! checked every minute with one cheap read (`rv_core::account_unread`).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use gtk::glib;
use gtk::prelude::*;
use rv_core::session::SessionInfo;

use crate::i18n::t;
use crate::secrets::account_key;
use crate::widgets::{self, TileSize};

const POLL: Duration = Duration::from_secs(60);

type Handler<T> = RefCell<Option<Rc<dyn Fn(T)>>>;

pub struct Rail {
    pub root: gtk::Box,
    buttons: gtk::Box,
    accounts: RefCell<Vec<SessionInfo>>,
    active: RefCell<Option<String>>,
    dots: RefCell<HashMap<String, gtk::Widget>>,
    unread: RefCell<HashMap<String, bool>>,
    /// Bumped by each new account list: a late answer about a list that
    /// changed meanwhile is dropped.
    generation: Cell<u64>,
    on_switch: Handler<SessionInfo>,
    on_add: Handler<()>,
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
            unread: RefCell::default(),
            generation: Cell::new(0),
            on_switch: RefCell::default(),
            on_add: RefCell::default(),
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
        this
    }

    pub fn connect_switch(&self, f: impl Fn(SessionInfo) + 'static) {
        self.on_switch.replace(Some(Rc::new(f)));
    }

    pub fn connect_add(&self, f: impl Fn(()) + 'static) {
        self.on_add.replace(Some(Rc::new(f)));
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
            self.buttons.append(&button);
            self.dots.borrow_mut().insert(key, dot.upcast());
        }
        self.root.set_visible(!accounts.is_empty());
        self.accounts.replace(accounts);
        self.poll();
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
