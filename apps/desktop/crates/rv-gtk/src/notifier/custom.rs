//! RocketVibe notification cards. GTK draws them; Win32 places them without focus.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use gtk::prelude::*;
use gtk::{gio, glib};
use rv_core::notify::Incoming;

use super::Pictures;
use crate::i18n::t;

const LIMIT: usize = 3;
const LIFETIME: Duration = Duration::from_secs(8);

pub(super) struct Backend {
    app: gio::Application,
    cards: RefCell<Vec<Rc<Card>>>,
    action: Rc<dyn Fn(rv_native::Event)>,
    polling: Cell<bool>,
}

struct Card {
    room: String,
    window: gtk::Window,
    entry: gtk::Entry,
    reply: gtk::Revealer,
    hover: Cell<bool>,
    editing: Cell<bool>,
    deadline: Cell<Instant>,
    open: gtk::Button,
    send: gtk::Button,
    reactions: Vec<gtk::Button>,
    read: gtk::Button,
    actions: gtk::Box,
    reply_button: gtk::Button,
}

impl Backend {
    pub(super) fn new(app: &gio::Application, action: Rc<dyn Fn(rv_native::Event)>) -> Rc<Self> {
        Rc::new(Self { app: app.clone(), cards: RefCell::default(), action, polling: Cell::new(false) })
    }

    fn start_poll(self: &Rc<Self>) {
        if self.polling.replace(true) {
            return;
        }
        let weak = Rc::downgrade(self);
        glib::timeout_add_local(Duration::from_millis(200), move || {
            let Some(this) = weak.upgrade() else { return glib::ControlFlow::Break };
            if this.cards.borrow().is_empty() {
                this.polling.set(false);
                return glib::ControlFlow::Break;
            }
            if rv_native::quiet() {
                this.clear();
                return glib::ControlFlow::Continue;
            }
            let expired: Vec<_> = this
                .cards
                .borrow()
                .iter()
                .filter(|card| !card.hover.get() && !card.editing.get() && Instant::now() >= card.deadline.get())
                .cloned()
                .collect();
            for card in expired {
                this.dismiss(&card);
            }
            this.fit(None);
            glib::ControlFlow::Continue
        });
    }

    pub(super) fn clear(&self) {
        let cards = self.cards.take();
        for card in cards {
            card.window.destroy();
        }
    }

    pub(super) fn withdraw(&self, room: &str) {
        let cards: Vec<_> = self.cards.borrow().iter().filter(|c| c.room == room).cloned().collect();
        for card in cards {
            self.dismiss(&card);
        }
    }

    fn dismiss(&self, card: &Rc<Card>) {
        self.cards.borrow_mut().retain(|c| !Rc::ptr_eq(c, card));
        card.window.destroy();
        self.arrange();
    }

    fn emit(&self, card: &Rc<Card>, event: rv_native::Event) {
        self.dismiss(card);
        (self.action)(event);
    }

    fn arrange(&self) -> bool {
        #[cfg(windows)]
        {
            let handles: Vec<_> = self.cards.borrow().iter().rev().map(|c| handle(&c.window)).collect();
            rv_native::notification_place(&handles)
        }
        #[cfg(not(windows))]
        {
            true
        }
    }

    /// False asks the caller to fall back to a system notification.
    fn fit(&self, newest: Option<&Rc<Card>>) -> bool {
        while !self.arrange() {
            let oldest = self
                .cards
                .borrow()
                .iter()
                .find(|c| !c.editing.get() && newest.is_none_or(|n| !Rc::ptr_eq(c, n)))
                .cloned();
            let Some(oldest) = oldest else { return false };
            self.dismiss(&oldest);
        }
        true
    }

    /// False asks the caller to fall back to a system notification.
    pub(super) fn show(self: &Rc<Self>, incoming: &Incoming, pictures: &Pictures) -> bool {
        // Preserve a reply being typed when this room receives another message.
        let previous = self.cards.borrow().iter().find(|c| c.room == incoming.rid).cloned();
        let restore_focus = previous.as_ref().is_some_and(|c| c.editing.get() && c.window.is_active());
        let draft = previous
            .as_ref()
            .filter(|c| c.editing.get() && incoming.body.is_some())
            .map(|c| c.entry.text().to_string());
        if let Some(card) = &previous {
            self.cards.borrow_mut().retain(|c| !Rc::ptr_eq(c, card));
        } else if self.cards.borrow().len() >= LIMIT {
            let oldest = self.cards.borrow().iter().find(|c| !c.editing.get()).cloned();
            let Some(oldest) = oldest else { return false };
            self.dismiss(&oldest);
        }

        let card = self.card(incoming, pictures);
        if let Some(draft) = draft {
            card.entry.set_text(&draft);
            card.editing.set(true);
            card.reply.set_reveal_child(true);
        }
        #[cfg(windows)]
        {
            gtk::prelude::WidgetExt::realize(&card.window);
            if !rv_native::notification_prepare(handle(&card.window)) {
                card.window.destroy();
                if let Some(previous) = previous {
                    self.cards.borrow_mut().push(previous);
                }
                return false;
            }
        }
        self.cards.borrow_mut().push(card.clone());
        // No present(): mapping a notification must not activate the window.
        card.window.set_visible(true);
        if !self.fit(Some(&card)) {
            self.dismiss(&card);
            if let Some(previous) = previous {
                self.cards.borrow_mut().push(previous);
                self.arrange();
            }
            return false;
        }
        if let Some(previous) = previous {
            previous.window.destroy();
        }
        if restore_focus && card.editing.get() {
            #[cfg(windows)]
            rv_native::notification_focus(handle(&card.window));
            card.entry.grab_focus();
        }
        self.start_poll();
        if gtk::Settings::default().is_some_and(|s| s.is_gtk_enable_animations()) {
            card.window.set_opacity(0.0);
            let window = card.window.downgrade();
            let start = Instant::now();
            glib::timeout_add_local(Duration::from_millis(16), move || {
                let Some(window) = window.upgrade().filter(|w| w.is_visible()) else { return glib::ControlFlow::Break };
                let fraction = (start.elapsed().as_secs_f64() / 0.16).min(1.0);
                window.set_opacity(fraction);
                if fraction >= 1.0 { glib::ControlFlow::Break } else { glib::ControlFlow::Continue }
            });
        }
        true
    }

    fn card(self: &Rc<Self>, incoming: &Incoming, pictures: &Pictures) -> Rc<Card> {
        let window = gtk::Window::builder()
            .title("RocketVibe")
            .decorated(false)
            .resizable(false)
            .default_width(380)
            .css_classes(["rv-notification"])
            .build();
        if let Some(app) = self.app.downcast_ref::<gtk::Application>() {
            window.set_application(Some(app));
        }
        let content = gtk::Box::new(gtk::Orientation::Vertical, 10);
        content.add_css_class("rv-notification-card");
        let heading = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let brand = gtk::Label::builder()
            .label("rocket-vibe")
            .hexpand(true)
            .xalign(0.0)
            .css_classes(["brand", "rv-notification-brand"])
            .build();
        let icon = gtk::Image::from_icon_name(crate::APP_ID);
        icon.set_pixel_size(22);
        heading.append(&icon);
        heading.append(&brand);
        let close = gtk::Button::builder()
            .icon_name("window-close-symbolic")
            .tooltip_text(t("notify.dismiss"))
            .focusable(false)
            .css_classes(["flat", "circular"])
            .build();
        heading.append(&close);
        content.append(&heading);

        let open = gtk::Button::builder().focusable(false).css_classes(["flat", "rv-notification-open"]).build();
        let message = gtk::Box::new(gtk::Orientation::Horizontal, 12);
        let avatar = adw::Avatar::new(44, Some(&incoming.author), true);
        if let Some(texture) = texture(pictures.avatar.as_deref()) {
            avatar.set_custom_image(Some(&texture));
        }
        message.append(&avatar);
        let text = gtk::Box::new(gtk::Orientation::Vertical, 3);
        text.set_hexpand(true);
        let room = if incoming.direct { t("notify.direct").to_owned() } else { format!("#{}", incoming.room_name) };
        text.append(
            &gtk::Label::builder()
                .label(room)
                .xalign(0.0)
                .ellipsize(pango::EllipsizeMode::End)
                .css_classes(["rv-notification-room"])
                .build(),
        );
        text.append(
            &gtk::Label::builder()
                .label(&incoming.author)
                .xalign(0.0)
                .ellipsize(pango::EllipsizeMode::End)
                .css_classes(["heading"])
                .build(),
        );
        text.append(
            &gtk::Label::builder()
                .label(incoming.body.as_deref().unwrap_or_else(|| t("message.encrypted")))
                .xalign(0.0)
                .wrap(true)
                .wrap_mode(pango::WrapMode::WordChar)
                .lines(3)
                .max_width_chars(34)
                .ellipsize(pango::EllipsizeMode::End)
                .build(),
        );
        message.append(&text);
        open.set_child(Some(&message));
        content.append(&open);
        if incoming.body.is_some()
            && let Some(texture) = texture(pictures.image.as_deref())
        {
            let picture = gtk::Picture::for_paintable(&texture);
            picture.set_content_fit(gtk::ContentFit::Cover);
            let frame = crate::widgets::media_frame(350, 120, &["rv-notification-image"]);
            frame.add_overlay(&picture);
            content.append(&frame);
        }
        let actions = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        let reply_button =
            gtk::Button::builder().label(t("notify.reply")).focusable(false).css_classes(["flat"]).build();
        actions.append(&reply_button);
        let quick = !incoming.rid.starts_with("rv-native:");
        let reactions: Vec<_> = rv_native::QUICK_REACTIONS
            .iter()
            .map(|(glyph, code)| {
                let button = gtk::Button::builder()
                    .label(*glyph)
                    .tooltip_text(*code)
                    .focusable(false)
                    .css_classes(["flat"])
                    .build();
                button.set_visible(quick);
                actions.append(&button);
                button
            })
            .collect();
        let read = gtk::Button::builder()
            .label(t("notify.read"))
            .focusable(false)
            .hexpand(true)
            .halign(gtk::Align::End)
            .css_classes(["flat"])
            .build();
        read.set_visible(quick);
        actions.append(&read);
        // A test has no destination; encrypted messages have no reply or image.
        actions.set_visible(!incoming.rid.is_empty() && incoming.body.is_some());
        content.append(&actions);
        let reply = gtk::Revealer::builder().transition_type(gtk::RevealerTransitionType::SlideDown).build();
        let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let entry = gtk::Entry::builder().placeholder_text(t("notify.reply_placeholder")).hexpand(true).build();
        let send = gtk::Button::builder()
            .icon_name("mail-send-symbolic")
            .tooltip_text(t("notify.reply"))
            .sensitive(false)
            .css_classes(["suggested-action"])
            .build();
        row.append(&entry);
        row.append(&send);
        reply.set_child(Some(&row));
        content.append(&reply);
        window.set_child(Some(&content));
        let card = Rc::new(Card {
            room: incoming.rid.clone(),
            window,
            entry,
            reply,
            hover: Cell::new(false),
            editing: Cell::new(false),
            deadline: Cell::new(Instant::now() + LIFETIME),
            open,
            send,
            reactions,
            read,
            actions,
            reply_button,
        });

        let (weak, current) = (Rc::downgrade(self), Rc::downgrade(&card));
        close.connect_clicked(move |_| {
            if let (Some(this), Some(card)) = (weak.upgrade(), current.upgrade()) {
                this.dismiss(&card);
            }
        });
        let (weak, current) = (Rc::downgrade(self), Rc::downgrade(&card));
        card.window.connect_close_request(move |_| {
            if let (Some(this), Some(card)) = (weak.upgrade(), current.upgrade()) {
                this.dismiss(&card);
            }
            glib::Propagation::Stop
        });
        let keys = gtk::EventControllerKey::new();
        let (weak, current) = (Rc::downgrade(self), Rc::downgrade(&card));
        keys.connect_key_pressed(move |_, key, _, _| {
            if key == gtk::gdk::Key::Escape {
                if let (Some(this), Some(card)) = (weak.upgrade(), current.upgrade()) {
                    this.dismiss(&card);
                }
                glib::Propagation::Stop
            } else {
                glib::Propagation::Proceed
            }
        });
        card.window.add_controller(keys);
        let motion = gtk::EventControllerMotion::new();
        let current = Rc::downgrade(&card);
        motion.connect_enter(move |_, _, _| {
            if let Some(card) = current.upgrade() {
                card.hover.set(true);
            }
        });
        let current = Rc::downgrade(&card);
        motion.connect_leave(move |_| {
            if let Some(card) = current.upgrade() {
                card.hover.set(false);
                card.deadline.set(Instant::now() + LIFETIME);
            }
        });
        card.window.add_controller(motion);
        let current = Rc::downgrade(&card);
        card.reply_button.connect_clicked(move |_| {
            if let Some(card) = current.upgrade() {
                card.editing.set(!card.editing.get());
                card.reply.set_reveal_child(card.editing.get());
                card.deadline.set(Instant::now() + LIFETIME);
                if card.editing.get() {
                    #[cfg(windows)]
                    rv_native::notification_focus(handle(&card.window));
                    card.entry.grab_focus();
                }
            }
        });
        let current = Rc::downgrade(&card);
        card.entry.connect_changed(move |entry| {
            if let Some(card) = current.upgrade() {
                card.send.set_sensitive(!entry.text().trim().is_empty());
            }
        });
        let (weak, current, rid, id) =
            (Rc::downgrade(self), Rc::downgrade(&card), incoming.rid.clone(), incoming.id.clone());
        card.open.connect_clicked(move |_| {
            if let (Some(this), Some(card)) = (weak.upgrade(), current.upgrade()) {
                if rid.is_empty() {
                    this.dismiss(&card);
                } else {
                    this.emit(&card, rv_native::Event::Open { room: rid.clone(), message: id.clone() });
                }
            }
        });
        let (weak, current, rid, id) =
            (Rc::downgrade(self), Rc::downgrade(&card), incoming.rid.clone(), incoming.id.clone());
        card.send.connect_clicked(move |_| {
            if let (Some(this), Some(card)) = (weak.upgrade(), current.upgrade()) {
                let text = card.entry.text().to_string();
                if !text.trim().is_empty() {
                    this.emit(&card, rv_native::Event::Reply { room: rid.clone(), message: id.clone(), text });
                }
            }
        });
        let send = card.send.downgrade();
        card.entry.connect_activate(move |_| {
            if let Some(send) = send.upgrade().filter(|b| b.is_sensitive()) {
                send.emit_clicked();
            }
        });
        for (button, (_, shortcode)) in card.reactions.iter().zip(rv_native::QUICK_REACTIONS) {
            let (weak, current, rid, id) =
                (Rc::downgrade(self), Rc::downgrade(&card), incoming.rid.clone(), incoming.id.clone());
            button.connect_clicked(move |_| {
                if let (Some(this), Some(card)) = (weak.upgrade(), current.upgrade()) {
                    this.emit(
                        &card,
                        rv_native::Event::React { room: rid.clone(), message: id.clone(), shortcode: shortcode.into() },
                    );
                }
            });
        }
        let (weak, current, rid, id) =
            (Rc::downgrade(self), Rc::downgrade(&card), incoming.rid.clone(), incoming.id.clone());
        card.read.connect_clicked(move |_| {
            if let (Some(this), Some(card)) = (weak.upgrade(), current.upgrade()) {
                this.emit(&card, rv_native::Event::MarkRead { room: rid.clone(), message: id.clone() });
            }
        });
        card
    }
}

fn texture(uri: Option<&str>) -> Option<gtk::gdk::Texture> {
    let file = gio::File::for_uri(uri?);
    // Notification pictures are our authenticated local cache, never remote URIs.
    file.path()?;
    gtk::gdk::Texture::from_file(&file).ok()
}

/// Server-free launch test of the actual widgets, timers and action routing.
pub(super) fn smoke(app: &adw::Application) -> bool {
    let Ok(shot) = std::env::var("RV_SMOKE_CUSTOM_NOTIFICATIONS") else { return false };
    #[cfg(windows)]
    rv_native::init(crate::APP_ID, "rocket-vibe", Box::new(|_| {}));
    let events = Rc::new(RefCell::new(Vec::new()));
    let sent = events.clone();
    let backend = Backend::new(app.upcast_ref(), Rc::new(move |e| sent.borrow_mut().push(e)));
    let sample = |room: &str, id: &str| Incoming {
        rid: room.into(),
        id: id.into(),
        author: "Camille".into(),
        room_name: "design".into(),
        body: Some("The new RocketVibe cards are ready ✨".into()),
        ..Default::default()
    };
    let pictures = Pictures::default();
    #[cfg(windows)]
    let foreground = rv_native::notification_foreground();
    let check = |name: &str, okay: bool| {
        println!("custom notifications: {name}: {okay}");
        assert!(okay, "custom notifications: {name}");
    };
    #[cfg(windows)]
    {
        let notifier = super::Notifier::new(app, |_, _| {}, |_, _, _| {}, |_, _, _| {});
        notifier.set_custom(true).expect("save custom style");
        check("custom style persists", super::custom_enabled());
        notifier.test();
        check("test uses selected backend", notifier.custom.cards.borrow().len() == 1);
        notifier.set_custom(false).expect("save system style");
        check("style switch clears cards", !super::custom_enabled() && notifier.custom.cards.borrow().is_empty());
    }
    for room in ["a", "b", "c", "d"] {
        check("card mapped", backend.show(&sample(room, "m1"), &pictures));
    }
    #[cfg(windows)]
    {
        check("cards do not steal focus", rv_native::notification_foreground() == foreground);
        check(
            "passive tool windows without taskbar entry",
            backend.cards.borrow().iter().all(|c| rv_native::notification_passive(handle(&c.window))),
        );
    }
    check(
        "bounded stack evicts oldest room",
        backend.cards.borrow().len() == 3 && backend.cards.borrow()[0].room == "b",
    );
    let old = backend.cards.borrow()[2].clone();
    old.reply_button.emit_clicked();
    check("reply field expands", old.editing.get() && old.reply.reveals_child());
    old.entry.set_text("A draft worth keeping");
    check("replacement mapped", backend.show(&sample("d", "m2"), &pictures));
    let replacement = backend.cards.borrow()[2].clone();
    check("replacement keeps draft", replacement.editing.get() && replacement.entry.text() == "A draft worth keeping");
    replacement.entry.set_text("  ");
    check("blank reply disabled", !replacement.send.is_sensitive());
    replacement.entry.set_text("Looks great!");
    replacement.send.emit_clicked();
    check(
        "reply targets latest message once",
        *events.borrow()
            == vec![rv_native::Event::Reply { room: "d".into(), message: "m2".into(), text: "Looks great!".into() }],
    );
    check("reply dismisses card", backend.cards.borrow().len() == 2);
    let card = backend.cards.borrow()[0].clone();
    card.reactions[0].emit_clicked();
    check(
        "reaction routing",
        events.borrow().last()
            == Some(&rv_native::Event::React { room: "b".into(), message: "m1".into(), shortcode: ":+1:".into() }),
    );
    let card = backend.cards.borrow()[0].clone();
    card.read.emit_clicked();
    check(
        "mark read routing",
        events.borrow().last() == Some(&rv_native::Event::MarkRead { room: "c".into(), message: "m1".into() }),
    );
    backend.show(&sample("open", "m3"), &pictures);
    let card = backend.cards.borrow()[0].clone();
    card.open.emit_clicked();
    check(
        "open routing",
        events.borrow().last() == Some(&rv_native::Event::Open { room: "open".into(), message: "m3".into() }),
    );
    let encrypted = Incoming { body: None, ..sample("secret", "m4") };
    backend.show(&encrypted, &pictures);
    check("encrypted card hides reply and reactions", !backend.cards.borrow()[0].actions.is_visible());
    backend.withdraw("secret");
    check("read removes room card", backend.cards.borrow().is_empty());
    backend.show(&sample("expire", "m5"), &pictures);
    backend.show(&sample("hover", "m6"), &pictures);
    for card in backend.cards.borrow().iter() {
        card.deadline.set(Instant::now());
    }
    backend.cards.borrow()[1].hover.set(true);
    let app = app.clone();
    glib::timeout_add_local_once(Duration::from_millis(500), move || {
        check("timeout respects hover", backend.cards.borrow().len() == 1 && backend.cards.borrow()[0].room == "hover");
        backend.clear();
        check("account switch clears cards", backend.cards.borrow().is_empty());
        let incoming = Incoming {
            direct: true,
            author: "Camille".into(),
            body: Some("Hey! These notifications feel like RocketVibe now ✨".into()),
            ..sample("preview", "m7")
        };
        let photo = gio::File::for_path("data/icons/hicolor/64x64/apps/com.rocketvibe.app.png").uri().to_string();
        let image = gio::File::for_path("data/windows/installer/wizard-202x386.png").uri().to_string();
        backend.show(&incoming, &Pictures { avatar: Some(photo), image: Some(image) });
        let card = backend.cards.borrow()[0].clone();
        card.hover.set(true);
        let app = app.clone();
        glib::timeout_add_local_once(Duration::from_millis(500), move || {
            check("image preview stays within card width", card.window.width() <= 400);
            let snapshot = gtk::Snapshot::new();
            gtk::WidgetPaintable::new(Some(&card.window)).snapshot(
                &snapshot,
                card.window.width() as f64,
                card.window.height() as f64,
            );
            let saved = snapshot
                .to_node()
                .zip(card.window.renderer())
                .is_some_and(|(node, renderer)| renderer.render_texture(&node, None).save_to_png(&shot).is_ok());
            check("rendered PNG saved", saved);
            backend.clear();
            println!("custom notifications: all checks passed");
            app.quit();
        });
    });
    true
}

#[cfg(windows)]
fn handle(window: &gtk::Window) -> isize {
    window.surface().and_downcast::<gdk4_win32::Win32Surface>().map_or(0, |s| s.handle().0 as isize)
}
