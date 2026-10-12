//! Experimental local WhatsApp window, reusing RocketVibe's timeline and composer.
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use adw::prelude::*;
use gtk::glib;
use rv_core::whatsapp::{Connector, Snapshot};

use crate::rows::RowEvent;

use crate::composer::Composer;
use crate::i18n::t;
use crate::message_list::MessageList;

thread_local! {
    static PILOT: RefCell<Option<Rc<Pilot>>> = const { RefCell::new(None) };
}
pub fn enabled() -> bool {
    std::env::var("RV_WHATSAPP_PILOT").as_deref() == Ok("1")
}
pub fn run() -> glib::ExitCode {
    crate::i18n::init();
    let app = adw::Application::builder().application_id("com.rocketvibe.whatsapp.pilot").build();
    app.connect_startup(|_| {
        crate::style::load();
        crate::focus::install();
        if let Some(display) = gtk::gdk::Display::default() {
            crate::icon::register(&display);
        }
    });
    app.connect_activate(|app| {
        if let Some(pilot) = PILOT.with_borrow(Clone::clone) {
            pilot.window.present();
            return;
        }
        let pilot = Pilot::new(app);
        pilot.window.present();
        pilot.start();
        pilot.smoke();
        PILOT.with_borrow_mut(|slot| *slot = Some(pilot));
    });
    app.run()
}
pub fn show(app: &adw::Application) {
    if let Some(pilot) = PILOT.with_borrow(Clone::clone) {
        pilot.window.present();
        return;
    }
    let pilot = Pilot::new(app);
    pilot.window.present();
    pilot.start();
    pilot.smoke();
    PILOT.with_borrow_mut(|slot| *slot = Some(pilot));
}
type PhotoCache = Rc<RefCell<HashMap<String, (Arc<[u8]>, gtk::gdk::Texture)>>>;
type PhotoTable = Arc<BTreeMap<String, Arc<[u8]>>>;
struct Pilot {
    window: adw::ApplicationWindow,
    stack: gtk::Stack,
    qr: gtk::DrawingArea,
    status: gtk::Label,
    warning: gtk::Label,
    title: gtk::Label,
    list: gtk::ListBox,
    messages: Rc<MessageList>,
    composer: Rc<Composer>,
    connector: RefCell<Option<Arc<Connector>>>,
    revision: Cell<u64>,
    selected: RefCell<String>,
    drafts: RefCell<BTreeMap<String, String>>,
    room_ids: RefCell<Vec<String>>,
    room_signature: RefCell<Vec<(String, String)>>,
    qr_value: RefCell<Option<String>>,
    qr_deadline: RefCell<Option<Instant>>,
    pending: RefCell<Option<(String, String, String)>>,
    /// A send left pending by a helper that was restarted: settled once the
    /// new helper has replayed its cache.
    orphan: RefCell<Option<(String, String, String)>>,
    retry: gtk::Button,
    logout: gtk::Button,
    closing: Cell<bool>,
    /// Decoded photos by JID, with the bytes they came from.
    photos: PhotoCache,
    /// The photo table last drawn, to rebuild rows and tiles when it moves.
    photo_table: RefCell<Option<PhotoTable>>,
    photo_version: Cell<u64>,
    /// The chat and count last marked read, so a paint does not repeat it.
    read_sent: RefCell<Option<(String, u32)>>,
}
impl Pilot {
    fn new(app: &adw::Application) -> Rc<Self> {
        let window = adw::ApplicationWindow::builder()
            .application(app)
            .title(t("wa.title"))
            .default_width(1040)
            .default_height(760)
            .build();
        let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let header = adw::HeaderBar::new();
        header.set_title_widget(Some(&crate::widgets::brand("brand-header")));
        let retry = gtk::Button::builder().label(t("wa.reconnect")).build();
        let logout = gtk::Button::builder().label(t("wa.logout")).sensitive(false).build();
        header.pack_start(&retry);
        header.pack_end(&logout);
        root.append(&header);
        let status = gtk::Label::builder()
            .label(t("wa.connecting"))
            .css_classes(["step-intro"])
            .margin_top(8)
            .margin_bottom(8)
            .build();
        root.append(&status);
        let warning = gtk::Label::builder()
            .wrap(true)
            .css_classes(["error"])
            .margin_start(24)
            .margin_end(24)
            .visible(false)
            .build();
        root.append(&warning);
        let stack = gtk::Stack::builder().vexpand(true).transition_type(gtk::StackTransitionType::Crossfade).build();
        let pairing = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(20)
            .valign(gtk::Align::Center)
            .halign(gtk::Align::Center)
            .margin_start(40)
            .margin_end(40)
            .build();
        pairing.append(&gtk::Label::builder().label(t("wa.link_title")).css_classes(["step-title"]).build());
        pairing.append(
            &gtk::Label::builder()
                .label(t("wa.link_help"))
                .wrap(true)
                .justify(gtk::Justification::Center)
                .max_width_chars(54)
                .build(),
        );
        let qr = gtk::DrawingArea::builder()
            .content_width(280)
            .content_height(280)
            .halign(gtk::Align::Center)
            .visible(false)
            .build();
        qr.update_property(&[gtk::accessible::Property::Label(t("wa.qr"))]);
        pairing.append(&qr);
        pairing.append(
            &gtk::Label::builder()
                .label(t("wa.local"))
                .wrap(true)
                .max_width_chars(58)
                .css_classes(["step-intro"])
                .build(),
        );
        if std::env::var_os("RV_WHATSAPP_SMOKE").is_some() {
            pairing.append(&gtk::Label::new(Some(t("wa.demo"))));
        }
        stack.add_named(&pairing, Some("pairing"));
        let body = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        let list = gtk::ListBox::builder()
            .selection_mode(gtk::SelectionMode::Single)
            .css_classes(["navigation-sidebar"])
            .build();
        let sidebar = gtk::ScrolledWindow::builder()
            .width_request(270)
            .child(&list)
            .hscrollbar_policy(gtk::PolicyType::Never)
            .build();
        body.append(&sidebar);
        body.append(&gtk::Separator::new(gtk::Orientation::Vertical));
        let timeline = gtk::Box::builder().orientation(gtk::Orientation::Vertical).hexpand(true).build();
        let title = gtk::Label::builder()
            .label(t("wa.choose"))
            .xalign(0.0)
            .margin_start(24)
            .margin_top(16)
            .margin_bottom(16)
            .css_classes(["step-title"])
            .build();
        timeline.append(&title);
        let messages = MessageList::new(Rc::new(RefCell::new(None)));
        timeline.append(&messages.root);
        let composer = Composer::new();
        composer.text_only();
        composer.root.set_sensitive(false);
        timeline.append(&composer.root);
        body.append(&timeline);
        stack.add_named(&body, Some("chat"));
        root.append(&stack);
        window.set_content(Some(&root));
        let this = Rc::new(Self {
            window,
            stack,
            qr,
            status,
            warning,
            title,
            list,
            messages,
            composer,
            connector: RefCell::default(),
            revision: Cell::new(u64::MAX),
            selected: RefCell::default(),
            drafts: RefCell::default(),
            room_ids: RefCell::default(),
            room_signature: RefCell::default(),
            qr_value: RefCell::default(),
            qr_deadline: RefCell::default(),
            pending: RefCell::default(),
            orphan: RefCell::default(),
            retry,
            logout,
            closing: Cell::new(false),
            photos: Rc::default(),
            photo_table: RefCell::default(),
            photo_version: Cell::default(),
            read_sent: RefCell::default(),
        });
        let photos = this.photos.clone();
        this.messages
            .set_photos(Rc::new(move |jid: &str| photos.borrow().get(jid).map(|(_, texture)| texture.clone())));
        this.wire();
        this
    }
    fn wire(self: &Rc<Self>) {
        let weak = Rc::downgrade(self);
        self.list.connect_row_selected(move |_, row| {
            if let (Some(this), Some(row)) = (weak.upgrade(), row) {
                let id = this.room_ids.borrow().get(row.index() as usize).cloned();
                if let Some(id) = id {
                    this.open(&id);
                }
            }
        });
        let weak = Rc::downgrade(self);
        self.composer.connect_submit(move |submitted| {
            let Some(this) = weak.upgrade() else { return };
            let chat = this.selected.borrow().clone();
            let (reply, text) = rv_core::whatsapp::split_reply(&submitted);
            if text.trim().is_empty() {
                return;
            }
            let result = this
                .connector
                .borrow()
                .as_ref()
                .ok_or("connector_unavailable".to_owned())
                .and_then(|c| c.send(chat.clone(), text.clone(), reply.clone()));
            match result {
                Ok(id) => {
                    this.pending.replace(Some((chat, id, text)));
                    this.composer.root.set_sensitive(false);
                }
                Err(_) => {
                    this.composer.set_text(&text);
                    this.problem(t("wa.send_failed"));
                }
            }
        });
        // Coming back to the window reads the open chat.
        let weak = Rc::downgrade(self);
        self.window.connect_is_active_notify(move |_| {
            if let Some(this) = weak.upgrade() {
                this.revision.set(u64::MAX);
            }
        });
        let weak = Rc::downgrade(self);
        self.messages.connect_event(move |event| {
            if let Some(this) = weak.upgrade() {
                this.row_event(event);
            }
        });
        let weak = Rc::downgrade(self);
        self.retry.connect_clicked(move |_| {
            let Some(this) = weak.upgrade() else { return };
            let connector = this.connector.borrow().clone();
            match connector {
                // A live helper only needs a new transport (and a new QR when unpaired).
                Some(connector) if !matches!(connector.state().as_str(), "stopped" | "logged_out" | "error") => {
                    if connector.reconnect().is_err() {
                        this.problem(t("wa.connection_failed"));
                    }
                }
                // An ended session needs a new helper, once the old one released its state.
                Some(connector) => {
                    this.retry.set_sensitive(false);
                    connector.stop();
                    glib::spawn_future_local(async move {
                        exit(&connector).await;
                        this.start();
                    });
                }
                None => this.start(),
            }
        });
        let weak = Rc::downgrade(self);
        self.logout.connect_clicked(move |_| {
            let Some(this) = weak.upgrade() else { return };
            if let Some(connector) = this.connector.borrow().as_ref() {
                if connector.logout().is_err() {
                    this.problem(t("wa.connection_failed"));
                }
                this.logout.set_sensitive(false);
            }
        });
        let weak = Rc::downgrade(self);
        self.window.connect_close_request(move |_| {
            let Some(this) = weak.upgrade() else { return glib::Propagation::Proceed };
            if this.closing.replace(true) {
                return glib::Propagation::Stop;
            }
            if let Some(connector) = this.connector.borrow().as_ref() {
                connector.stop();
                let connector = connector.clone();
                let window = this.window.clone();
                let app = this.window.application().expect("app");
                glib::spawn_future_local(async move {
                    exit(&connector).await;
                    window.destroy();
                    // Only now may a new window start a helper on the same state.
                    PILOT.with_borrow_mut(|slot| *slot = None);
                    if enabled() {
                        app.quit();
                    }
                });
                return glib::Propagation::Stop;
            }
            // Closed while the helper starts: `start` stops it when it arrives.
            PILOT.with_borrow_mut(|slot| *slot = None);
            glib::Propagation::Proceed
        });
        let weak = Rc::downgrade(self);
        glib::timeout_add_local(Duration::from_millis(100), move || {
            let Some(this) = weak.upgrade() else { return glib::ControlFlow::Break };
            if this.closing.get() {
                return glib::ControlFlow::Continue;
            }
            let connector = this.connector.borrow().clone();
            if let Some(connector) = connector
                && connector.revision() != this.revision.get()
            {
                let snapshot = connector.snapshot();
                this.revision.set(snapshot.revision);
                this.paint(&snapshot);
            }
            if this.qr_deadline.borrow().is_some_and(|deadline| Instant::now() >= deadline) {
                this.clear_qr();
                this.status.set_label(t("wa.qr_expired"));
                this.retry.set_sensitive(true);
            }
            glib::ControlFlow::Continue
        });
    }
    fn problem(&self, message: &str) {
        self.warning.set_label(message);
        self.warning.set_visible(true);
    }
    fn start(self: &Rc<Self>) {
        if self.closing.get() {
            return;
        }
        self.retry.set_sensitive(false);
        self.warning.set_visible(false);
        self.status.set_label(t("wa.connecting"));
        self.revision.set(u64::MAX);
        self.connector.replace(None);
        self.composer.root.set_sensitive(false);
        if let Some(pending) = self.pending.take() {
            self.orphan.replace(Some(pending));
        }
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let fake = std::env::var("RV_WHATSAPP_SMOKE").ok();
            let program = if fake.is_some() {
                std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.join("fake-whatsapp-sidecar")))
            } else {
                rv_core::whatsapp::locate()
            };
            let data = glib::user_data_dir().join("rocket-vibe-rs");
            let (state, entry) = rv_core::whatsapp::state_location(&data, rv_core::whatsapp::PILOT_STATE);
            let key = if fake.is_some() {
                rv_core::whatsapp::storage_key()
            } else {
                let exists = state.exists();
                crate::on_tokio(async move { crate::secrets::whatsapp_key(&entry, exists).await }).await
            };
            let Some(this) = weak.upgrade().filter(|p| !p.closing.get()) else { return };
            let result = match (program, key) {
                (Some(program), Ok(key)) => {
                    crate::on_tokio(async move { Connector::start(&program, &state, key).await }).await
                }
                _ => Err("connector_unavailable".into()),
            };
            match result {
                Ok(connector) => {
                    if this.closing.get() {
                        connector.stop();
                        return;
                    }
                    if fake.as_deref() == Some("chat") {
                        let _ = connector.reconnect();
                    }
                    this.connector.replace(Some(connector));
                }
                Err(_) => {
                    this.problem(t("wa.start_failed"));
                    this.status.set_label(t("wa.connection_failed"));
                    this.retry.set_sensitive(true);
                }
            }
        });
    }
    fn clear_qr(&self) {
        self.qr.set_visible(false);
        self.qr.set_draw_func(|_, _, _, _| {});
        self.qr_value.replace(None);
        self.qr_deadline.replace(None);
    }
    fn paint(&self, s: &Snapshot) {
        if s.state == "logged_out" {
            self.drafts.borrow_mut().clear();
            self.pending.replace(None);
            self.selected.borrow_mut().clear();
            self.composer.set_text("");
        }
        self.status.set_label(t(&format!("wa.{}", s.state)));
        self.retry.set_sensitive(!matches!(s.state.as_str(), "connecting" | "paired"));
        self.logout.set_sensitive(s.state == "connected");
        self.warning.set_visible(s.error.is_some());
        if let Some(code) = &s.error {
            self.problem(match code.as_str() {
                "send_uncertain" => t("wa.send_uncertain"),
                "client_outdated" => t("wa.client_outdated"),
                "logout_failed" => t("wa.logout_failed"),
                "invalid_send" | "not_connected" | "send_already_recorded" => t("wa.send_failed"),
                "action_failed" => t("wa.action_failed"),
                "edit_expired" => t("wa.edit_expired"),
                "delete_expired" => t("wa.delete_expired"),
                _ if s.state == "error" => t("wa.connection_failed"),
                _ => t("wa.helper_failed"),
            });
        }
        if let Some((code, expiry)) = &s.qr {
            if self.qr_value.borrow().as_deref() != Some(code) {
                self.qr_value.replace(Some(code.clone()));
                self.qr_deadline.replace(Some(Instant::now() + Duration::from_millis(*expiry)));
                show_qr(&self.qr, code);
            }
            self.stack.set_visible_child_name("pairing");
        } else {
            self.clear_qr();
            if !s.messages.is_empty() || s.state == "connected" {
                self.stack.set_visible_child_name("chat");
            } else {
                self.stack.set_visible_child_name("pairing");
            }
        }
        self.refresh_photos(s);
        let mut rooms: BTreeMap<String, (String, i64)> = BTreeMap::new();
        for m in s.messages.values() {
            let entry = rooms.entry(m.chat.clone()).or_insert_with(|| (s.chat_name(m), m.ts));
            entry.1 = entry.1.max(m.ts);
        }
        let mut rooms: Vec<_> = rooms.into_iter().collect();
        rooms.sort_by(|a, b| b.1.1.cmp(&a.1.1).then(a.0.cmp(&b.0)));
        let version = self.photo_version.get().to_string();
        let unread = |id: &str| s.unread.get(id).copied().unwrap_or(0);
        let signature: Vec<_> = rooms
            .iter()
            .map(|(id, (name, _))| (id.clone(), format!("{name} {}", unread(id))))
            .chain(std::iter::once((String::new(), version)))
            .collect();
        if *self.room_signature.borrow() != signature {
            self.room_signature.replace(signature);
            // Selection callbacks must not read a stale index while replacing the list.
            self.room_ids.borrow_mut().clear();
            while let Some(child) = self.list.first_child() {
                self.list.remove(&child);
            }
            self.room_ids.replace(rooms.iter().map(|(id, _)| id.clone()).collect());
            for (id, (name, _)) in &rooms {
                let row = gtk::Box::builder()
                    .spacing(12)
                    .margin_start(12)
                    .margin_end(12)
                    .margin_top(12)
                    .margin_bottom(12)
                    .build();
                let tile = crate::rows::room_tile(
                    name,
                    if id.ends_with("@g.us") { "p" } else { "d" },
                    false,
                    crate::widgets::TileSize::Room,
                );
                if let Some((_, photo)) = self.photos.borrow().get(id) {
                    crate::widgets::set_photo(&tile, photo);
                }
                row.append(&tile);
                let label = gtk::Label::builder()
                    .label(name)
                    .xalign(0.0)
                    .ellipsize(gtk::pango::EllipsizeMode::End)
                    .hexpand(true)
                    .build();
                row.append(&label);
                let count = unread(id);
                if count > 0 {
                    label.add_css_class("unread");
                    row.append(&crate::widgets::unread_badge(count.into(), 0));
                }
                self.list.append(&row);
            }
            let selected = self.selected.borrow().clone();
            let index = self.room_ids.borrow().iter().position(|id| *id == selected).unwrap_or(0);
            self.list.select_row(self.list.row_at_index(index as i32).as_ref());
        }
        // The helper records a send before its network attempt and emits the
        // record first: no record once it refused the send, exited or replayed
        // its cache means the text never left, and only then is it a draft again.
        let pending = self.pending.borrow().clone();
        if let Some((chat, id, text)) = pending {
            let record = s.messages.get(&format!("{chat}:{id}"));
            if record.is_some_and(|m| m.status != "sending") {
                self.pending.replace(None);
            } else if record.is_none() && (s.refused.as_deref() == Some(id.as_str()) || s.exited) {
                self.pending.replace(None);
                self.keep_draft(&chat, &text);
            } else if s.exited {
                self.pending.replace(None);
                self.problem(t("wa.send_uncertain"));
            }
        }
        let orphan = self.orphan.borrow().clone();
        if let Some((chat, id, text)) = orphan
            && s.loaded
        {
            self.orphan.replace(None);
            if !s.messages.contains_key(&format!("{chat}:{id}")) {
                self.keep_draft(&chat, &text);
            }
        }
        self.composer.root.set_sensitive(
            s.state == "connected" && !self.selected.borrow().is_empty() && self.pending.borrow().is_none(),
        );
        self.paint_messages(s);
        self.read_open_chat(s);
    }
    /// The open chat is read while the window has the focus.
    fn read_open_chat(&self, s: &Snapshot) {
        let chat = self.selected.borrow().clone();
        let count = s.unread.get(&chat).copied().unwrap_or(0);
        if count == 0 {
            self.read_sent.replace(None);
            return;
        }
        if chat.is_empty() || s.state != "connected" || !self.window.is_active() {
            return;
        }
        let key = Some((chat.clone(), count));
        if *self.read_sent.borrow() == key {
            return;
        }
        if let Some(connector) = self.connector.borrow().as_ref()
            && connector.mark_read(chat).is_ok()
        {
            self.read_sent.replace(key);
        }
    }
    /// Gives back the text of a send that never left, without overwriting a
    /// newer draft.
    fn keep_draft(&self, chat: &str, text: &str) {
        if *self.selected.borrow() == chat {
            if self.composer.text().trim().is_empty() {
                self.composer.set_text(text);
            }
        } else {
            self.drafts.borrow_mut().entry(chat.to_owned()).or_insert_with(|| text.to_owned());
        }
        self.problem(t("wa.send_failed"));
    }
    fn open(&self, chat: &str) {
        let previous = self.selected.replace(chat.to_owned());
        if previous != chat {
            self.drafts.borrow_mut().insert(previous, self.composer.text());
            self.composer.set_text(self.drafts.borrow().get(chat).map_or("", String::as_str));
        }
        if let Some(connector) = self.connector.borrow().as_ref() {
            let snapshot = connector.snapshot();
            self.paint_messages(&snapshot);
            self.read_open_chat(&snapshot);
        }
    }
    fn paint_messages(&self, s: &Snapshot) {
        let chat = self.selected.borrow().clone();
        let mut messages: Vec<_> = s.messages.values().filter(|m| m.chat == chat).collect();
        messages.sort_by_key(|m| (m.ts, &m.id));
        if let Some(message) = messages.last() {
            self.title.set_label(&s.chat_name(message));
        } else {
            self.title.set_label(t("wa.choose"));
        }
        // My latest settled message says how far it went, as WhatsApp's ticks do.
        let receipt = messages
            .iter()
            .rev()
            .find(|m| m.mine && m.status.is_empty() && !m.deleted)
            .map(|m| (m.id.clone(), m.receipt.clone()));
        let mut rows = crate::rows::group(messages.into_iter().map(|m| s.presentation(m)).collect());
        for row in &mut rows {
            if row.row.outbox_status.as_deref() == Some("uncertain") {
                row.seen = Some(t("wa.send_uncertain").into());
            } else if let Some((id, state)) = &receipt
                && *id == row.row.id
                && !state.is_empty()
            {
                row.seen = Some(t(&format!("wa.{state}")).into());
            }
        }
        self.messages.set_photo_version(self.photo_version.get());
        self.messages.set_native_rows(rows, "me");
    }
    /// Decodes the photos that changed since the last paint.
    fn refresh_photos(&self, s: &Snapshot) {
        if self.photo_table.borrow().as_ref().is_some_and(|table| Arc::ptr_eq(table, &s.avatars)) {
            return;
        }
        self.photo_table.replace(Some(s.avatars.clone()));
        let mut photos = self.photos.borrow_mut();
        photos.retain(|jid, _| s.avatars.contains_key(jid));
        let mut changed = false;
        for (jid, bytes) in s.avatars.iter() {
            if photos.get(jid).is_some_and(|(kept, _)| Arc::ptr_eq(kept, bytes)) {
                continue;
            }
            let texture = gtk::gdk::Texture::from_bytes(&glib::Bytes::from(&bytes[..]));
            if let Ok(texture) = texture {
                photos.insert(jid.clone(), (bytes.clone(), texture));
                changed = true;
            }
        }
        if changed || photos.len() != s.avatars.len() {
            self.photo_version.set(self.photo_version.get() + 1);
        }
    }
    fn row_event(self: &Rc<Self>, event: RowEvent) {
        let Some(connector) = self.connector.borrow().clone() else { return };
        let result = match event {
            RowEvent::React { id, shortcode, add } => {
                connector.react(id, if add { rv_core::whatsapp::reaction_glyph(&shortcode) } else { String::new() })
            }
            RowEvent::Menu { row, anchor, x, y, .. } => {
                self.menu(&connector, *row, &anchor, x, y);
                Ok(())
            }
            RowEvent::SaveEdit => match self.messages.stop_edit() {
                Some((id, text)) if !text.trim().is_empty() => connector.edit(id, text.trim().to_owned()),
                _ => Ok(()),
            },
            RowEvent::CancelEdit => {
                self.messages.stop_edit();
                Ok(())
            }
            _ => Ok(()),
        };
        if result.is_err() {
            self.problem(t("wa.action_failed"));
        }
    }
    /// The actions a WhatsApp message offers: quick reactions, copy, and on my
    /// own messages edit (15 minutes) and delete for everyone (48 hours).
    fn menu(
        self: &Rc<Self>,
        connector: &Arc<Connector>,
        row: rv_core::store::MessageRow,
        anchor: &gtk::Widget,
        x: f64,
        y: f64,
    ) {
        let snapshot = connector.snapshot();
        let Some(message) = snapshot.messages.get(&row.id).cloned() else { return };
        let popover = gtk::Popover::builder().has_arrow(true).build();
        popover.set_parent(anchor);
        popover.set_pointing_to(Some(&gtk::gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
        popover.connect_closed(|popover| popover.unparent());
        let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).build();
        let connected = snapshot.state == "connected";
        if !message.deleted && connected {
            let quick = gtk::Box::builder().spacing(2).build();
            let mine = snapshot.reactions.get(&message.id).and_then(|by| by.get("me")).cloned();
            for code in rv_core::actions::QUICK_REACTIONS {
                let glyph = rv_core::whatsapp::reaction_glyph(code);
                let button = gtk::Button::builder().label(&glyph).css_classes(["flat"]).build();
                let taken = mine.as_deref() == Some(glyph.as_str());
                if taken {
                    button.add_css_class("suggested-action");
                }
                let (connector, id, popover) = (connector.clone(), message.id.clone(), popover.clone());
                let weak = Rc::downgrade(self);
                button.connect_clicked(move |_| {
                    popover.popdown();
                    if connector.react(id.clone(), if taken { String::new() } else { glyph.clone() }).is_err()
                        && let Some(this) = weak.upgrade()
                    {
                        this.problem(t("wa.action_failed"));
                    }
                });
                quick.append(&button);
            }
            column.append(&quick);
        }
        let item = |label: &str| gtk::Button::builder().label(label).css_classes(["flat"]).build();
        if !message.deleted && message.status.is_empty() && connected {
            let reply = item(t("actions.reply"));
            let author = row.author.clone().unwrap_or_default();
            let (weak, popover_c, id, text) =
                (Rc::downgrade(self), popover.clone(), message.id.clone(), message.text.clone());
            reply.connect_clicked(move |_| {
                popover_c.popdown();
                if let Some(this) = weak.upgrade() {
                    let preview: String = text.chars().take(120).collect();
                    this.composer.set_reply(&author, &preview, format!("{}{id}", rv_core::whatsapp::REPLY_LINK));
                }
            });
            column.append(&reply);
        }
        if !message.deleted {
            let copy = item(t("actions.copy"));
            let (text, popover_c) = (message.text.clone(), popover.clone());
            copy.connect_clicked(move |button| {
                button.clipboard().set_text(&text);
                popover_c.popdown();
            });
            column.append(&copy);
        }
        let age = chrono::Utc::now().timestamp_millis() - message.ts;
        let settled = message.mine && !message.deleted && message.status.is_empty() && connected;
        if settled && age < 15 * 60 * 1000 {
            let edit = item(t("actions.edit"));
            let (weak, popover_c) = (Rc::downgrade(self), popover.clone());
            edit.connect_clicked(move |_| {
                popover_c.popdown();
                if let Some(this) = weak.upgrade() {
                    this.messages.start_edit(&row);
                }
            });
            column.append(&edit);
        }
        if settled && age < 48 * 60 * 60 * 1000 {
            let delete = item(t("actions.delete"));
            delete.add_css_class("destructive-action");
            let (weak, popover_c, connector, id) =
                (Rc::downgrade(self), popover.clone(), connector.clone(), message.id);
            delete.connect_clicked(move |_| {
                popover_c.popdown();
                if let Some(this) = weak.upgrade() {
                    this.confirm_delete(connector.clone(), id.clone());
                }
            });
            column.append(&delete);
        }
        if column.first_child().is_none() {
            popover.unparent();
            return;
        }
        popover.set_child(Some(&column));
        popover.popup();
    }
    fn confirm_delete(self: &Rc<Self>, connector: Arc<Connector>, id: String) {
        let dialog = adw::AlertDialog::new(Some(t("wa.delete_title")), Some(t("wa.delete_body")));
        dialog.add_response("cancel", t("actions.cancel"));
        dialog.add_response("delete", t("actions.delete"));
        dialog.set_response_appearance("delete", adw::ResponseAppearance::Destructive);
        dialog.set_default_response(Some("cancel"));
        dialog.set_close_response("cancel");
        let weak = Rc::downgrade(self);
        dialog.connect_response(None, move |_, response| {
            if response == "delete"
                && connector.delete(id.clone()).is_err()
                && let Some(this) = weak.upgrade()
            {
                this.problem(t("wa.action_failed"));
            }
        });
        crate::widgets::present(&dialog, Some(&self.window));
    }
    fn smoke(self: &Rc<Self>) {
        let Some(mode) = std::env::var("RV_WHATSAPP_SMOKE").ok() else { return };
        let weak = Rc::downgrade(self);
        glib::timeout_add_local_once(Duration::from_secs(2), move || {
            if let Some(this) = weak.upgrade()
                && mode == "chat"
            {
                this.open("alice@s.whatsapp.net");
                this.composer.set_text("Native pilot test");
                this.composer.submit_now();
            }
        });
        let weak = Rc::downgrade(self);
        glib::timeout_add_local_once(Duration::from_secs(4), move || {
            let Some(this) = weak.upgrade() else { return };
            let mode = std::env::var("RV_WHATSAPP_SMOKE").unwrap_or_default();
            let snapshot = this.connector.borrow().as_ref().map(|c| c.snapshot()).unwrap_or_default();
            let good = if mode == "qr" {
                this.qr.is_visible() && snapshot.qr.is_some()
            } else {
                snapshot.state == "connected"
                    && snapshot.messages.values().any(|m| m.text == "Native pilot test" && m.status.is_empty())
                    && this.messages.row_widget("alice@s.whatsapp.net:fake-received").is_some()
                    && snapshot.name_of("alice@s.whatsapp.net") == Some("Alice Martin")
                    && this.photos.borrow().contains_key("alice@s.whatsapp.net")
            };
            let shot = std::env::var("RV_WHATSAPP_SMOKE_SHOT").unwrap_or_default();
            let paintable = gtk::WidgetPaintable::new(Some(&this.window));
            let snapshot = gtk::Snapshot::new();
            paintable.snapshot(&snapshot, this.window.width() as f64, this.window.height() as f64);
            let saved = snapshot
                .to_node()
                .zip(this.window.renderer())
                .is_some_and(|(node, renderer)| renderer.render_texture(&node, None).save_to_png(&shot).is_ok());
            println!("whatsapp smoke: native flow={} screenshot={}", good, saved);
            this.window.close();
        });
    }
}
/// Waits for the helper process to end (the connector kills it after 5 s).
async fn exit(connector: &Connector) {
    for _ in 0..80 {
        if connector.exited() {
            return;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
}
fn show_qr(area: &gtk::DrawingArea, code: &str) {
    let Ok(qr) = qrcode::QrCode::new(code.as_bytes()) else { return };
    let width = qr.width();
    area.set_visible(true);
    area.set_draw_func(move |_, cr, w, h| {
        cr.set_antialias(gtk::cairo::Antialias::None);
        let module = (w.min(h) as f64 / (width + 8) as f64).floor().max(1.0);
        let side = module * (width + 8) as f64;
        let x = ((w as f64 - side) / 2.0).floor();
        let y = ((h as f64 - side) / 2.0).floor();
        cr.set_source_rgb(1.0, 1.0, 1.0);
        cr.rectangle(x, y, side, side);
        let _ = cr.fill();
        cr.set_source_rgb(0.0, 0.0, 0.0);
        for row in 0..width {
            for col in 0..width {
                if qr[(col, row)] == qrcode::Color::Dark {
                    cr.rectangle(x + (col + 4) as f64 * module, y + (row + 4) as f64 * module, module, module);
                }
            }
        }
        let _ = cr.fill();
    });
}
