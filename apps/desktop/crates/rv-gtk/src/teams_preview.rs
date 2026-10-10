//! Hidden read-only Teams session import. Each request belongs to this panel's generation.
use crate::{i18n::t, widgets};
use adw::prelude::*;
use gtk::glib;
use rv_core::teams::{Conversation, Reader};
use rv_core::teams_handoff::Pairing;
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;
pub struct Preview {
    pub root: gtk::Box,
    form: gtk::Box,
    token: gtk::Entry,
    cookie: gtk::Entry,
    status: gtk::Label,
    content: gtk::Box,
    more: gtk::Button,
    refresh: gtk::Button,
    back: gtk::Button,
    connect: gtk::Button,
    reader: RefCell<Option<Arc<Reader>>>,
    pairing: RefCell<Option<Arc<Pairing>>>,
    room: RefCell<Option<Conversation>>,
    cursor: RefCell<Option<String>>,
    seen: RefCell<HashSet<String>>,
    item_ids: RefCell<HashSet<String>>,
    busy: Cell<bool>,
    generation: Cell<u64>,
}
impl Preview {
    pub fn new() -> Rc<Self> {
        let root = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(10)
            .visible(true)
            .css_classes(["card"])
            .build();
        root.append(&gtk::Label::builder().label(t("teams.title")).xalign(0.0).css_classes(["heading"]).build());
        root.append(&gtk::Label::builder().label(t("teams.previewHelp")).wrap(true).xalign(0.0).build());
        let form = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).build();
        let (token_row, token) = widgets::pill_field(t("teams.key"), "", true);
        let (cookie_row, cookie) = widgets::pill_field(t("teams.response"), "", true);
        let connect = gtk::Button::with_label(t("teams.connect"));
        token.set_editable(false);
        cookie.set_max_length(300000);
        let copy = gtk::Button::with_label(t("teams.copyKey"));
        let pairing = Pairing::new().ok();
        if let Some(p) = &pairing {
            token.set_text(&p.code().unwrap_or_default());
        }
        form.append(&token_row);
        form.append(&copy);
        form.append(&cookie_row);
        form.append(&connect);
        root.append(&form);
        let status = gtk::Label::builder().wrap(true).xalign(0.0).build();
        root.append(&status);
        let back = gtk::Button::builder().label(t("slack.back")).visible(false).build();
        root.append(&back);
        let content = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).build();
        root.append(&content);
        let more = gtk::Button::builder().label(t("slack.more")).visible(false).build();
        root.append(&more);
        let refresh = gtk::Button::builder().label(t("slack.refresh")).visible(false).build();
        root.append(&refresh);
        let disconnect = gtk::Button::with_label(t("slack.disconnect"));
        root.append(&disconnect);
        let hide = gtk::Button::with_label(t("slack.hide"));
        root.append(&hide);
        let this = Rc::new(Self {
            root,
            form,
            token,
            cookie,
            status,
            content,
            more,
            refresh,
            back,
            connect,
            reader: RefCell::new(None),
            pairing: RefCell::new(pairing),
            room: RefCell::new(None),
            cursor: RefCell::new(None),
            seen: RefCell::new(HashSet::new()),
            item_ids: RefCell::new(HashSet::new()),
            busy: Cell::new(false),
            generation: Cell::new(0),
        });
        let entry = this.token.clone();
        copy.connect_clicked(move |_| {
            if let Some(display) = gtk::gdk::Display::default() {
                display.clipboard().set_text(&entry.text());
            }
        });
        let weak = Rc::downgrade(&this);
        this.connect.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.connect();
            }
        });
        let weak = Rc::downgrade(&this);
        disconnect.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.reset();
            }
        });
        let weak = Rc::downgrade(&this);
        hide.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.reset();
                match crate::slack_preview::set_enabled(false) {
                    Ok(()) => this.root.set_visible(false),
                    Err(_) => this.status.set_label(t("slack.unlockFailed")),
                }
            }
        });
        let weak = Rc::downgrade(&this);
        this.back.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade()
                && !this.busy.get()
            {
                this.room.replace(None);
                this.load(false);
            }
        });
        let weak = Rc::downgrade(&this);
        this.more.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.load(true);
            }
        });
        let weak = Rc::downgrade(&this);
        this.refresh.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.load(false);
            }
        });
        let weak = Rc::downgrade(&this);
        this.root.connect_unmap(move |_| {
            if let Some(this) = weak.upgrade() {
                this.reset();
            }
        });
        this
    }
    fn clear_content(&self) {
        while let Some(child) = self.content.first_child() {
            self.content.remove(&child);
        }
        self.item_ids.borrow_mut().clear();
    }
    fn set_busy(&self, value: bool) {
        self.busy.set(value);
        self.connect.set_sensitive(!value);
        self.form.set_sensitive(!value);
        self.content.set_sensitive(!value);
        self.more.set_sensitive(!value);
        self.back.set_sensitive(!value);
        self.refresh.set_sensitive(!value);
    }
    fn reset(&self) {
        self.generation.set(self.generation.get() + 1);
        if let Some(reader) = self.reader.take() {
            reader.close();
        }
        if let Some(p) = self.pairing.take() {
            p.close();
        }
        let pairing = Pairing::new().ok();
        self.token.set_text(&pairing.as_ref().and_then(|p| p.code().ok()).unwrap_or_default());
        self.pairing.replace(pairing);
        self.cookie.set_text("");
        self.room.replace(None);
        self.cursor.replace(None);
        self.seen.borrow_mut().clear();
        self.clear_content();
        self.more.set_visible(false);
        self.refresh.set_visible(false);
        self.back.set_visible(false);
        self.form.set_visible(true);
        self.status.set_label("");
        self.set_busy(false);
    }
    fn connect(self: &Rc<Self>) {
        if self.busy.get() {
            return;
        }
        let reader = match self
            .pairing
            .borrow()
            .as_ref()
            .ok_or(rv_core::teams::Error { code: "pairing_closed", status: 0, retry_after: None })
            .and_then(|p| p.open(self.cookie.text().trim()))
            .and_then(Reader::from_browser)
        {
            Ok(r) => r,
            Err(e) => {
                self.status.set_label(&e.to_string());
                return;
            }
        };
        if let Some(old) = self.reader.replace(Some(reader.clone())) {
            old.close();
        }
        self.set_busy(true);
        self.status.set_label(t("slack.loading"));
        let generation = self.generation.get();
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let found = crate::on_tokio(async move { reader.discover().await }).await;
            let Some(this) = weak.upgrade() else {
                return;
            };
            if this.generation.get() != generation {
                return;
            }
            this.set_busy(false);
            match found {
                Ok(()) => {
                    this.token.set_text("");
                    this.cookie.set_text("");
                    this.form.set_visible(false);
                    this.status.set_label(t("teams.connected"));
                    this.load(false);
                }
                Err(e) => {
                    this.status.set_label(&e.to_string());
                }
            }
        });
    }
    fn load(self: &Rc<Self>, more: bool) {
        if self.busy.get() {
            return;
        }
        let Some(reader) = self.reader.borrow().clone() else {
            return;
        };
        let requested = if more {
            self.cursor.borrow().clone()
        } else {
            self.cursor.replace(None);
            self.seen.borrow_mut().clear();
            self.clear_content();
            None
        };
        if requested.as_ref().is_some_and(|c| self.seen.borrow().contains(c)) {
            self.status.set_label("Teams: pagination_loop");
            return;
        }
        let room = self.room.borrow().clone();
        self.back.set_visible(room.is_some());
        self.set_busy(true);
        self.status.set_label(t("slack.loading"));
        let generation = self.generation.get();
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            enum Page {
                Rooms(Vec<Conversation>),
                Messages(rv_core::teams::History),
            }
            let cursor = requested.clone();
            let selected = room.clone();
            let result = crate::on_tokio(async move {
                match selected {
                    Some(room) => reader.history(&room.id, cursor.as_deref()).await.map(Page::Messages),
                    None => reader.conversations().await.map(Page::Rooms),
                }
            })
            .await;
            let Some(this) = weak.upgrade() else {
                return;
            };
            if this.generation.get() != generation {
                return;
            }
            this.set_busy(false);
            this.refresh.set_visible(true);
            match result {
                Ok(page) => {
                    if let Some(cursor) = requested {
                        this.seen.borrow_mut().insert(cursor);
                    }
                    let next = match page {
                        Page::Rooms(page) => {
                            for room in page {
                                if !this.item_ids.borrow_mut().insert(room.id.clone()) {
                                    continue;
                                }
                                let button = gtk::Button::with_label(&format!(
                                    "{}{}",
                                    if room.kind == "channel" {
                                        "# "
                                    } else if room.kind == "private" {
                                        "🔒 "
                                    } else {
                                        ""
                                    },
                                    room.name
                                ));
                                button.set_sensitive(room.kind != "unsupported");
                                let weak = Rc::downgrade(&this);
                                button.connect_clicked(move |_| {
                                    if let Some(this) = weak.upgrade()
                                        && !this.busy.get()
                                    {
                                        this.room.replace(Some(room.clone()));
                                        this.load(false);
                                    }
                                });
                                this.content.append(&button);
                            }
                            None
                        }
                        Page::Messages(page) => {
                            for message in page.items {
                                if !this.item_ids.borrow_mut().insert(message.key.clone()) {
                                    continue;
                                }
                                let row =
                                    gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).build();
                                let date = message.arrived_at.clone();
                                let text = rv_core::teams::plain_text(&message);
                                row.append(
                                    &gtk::Label::builder()
                                        .label(format!("{} · {}", message.author, date))
                                        .xalign(0.0)
                                        .css_classes(["file-detail"])
                                        .build(),
                                );
                                row.append(
                                    &gtk::Label::builder()
                                        .label(if message.format == "unsupported" || text.is_empty() {
                                            t("teams.unsupported")
                                        } else {
                                            &text
                                        })
                                        .wrap(true)
                                        .selectable(true)
                                        .xalign(0.0)
                                        .build(),
                                );
                                this.content.append(&row);
                            }
                            page.backward_link
                        }
                    };
                    this.more.set_visible(next.is_some());
                    this.cursor.replace(next);
                    this.status.set_label(room.as_ref().map(|r| r.name.as_str()).unwrap_or(t("slack.back")));
                    if this.content.first_child().is_none() {
                        this.content.append(&gtk::Label::new(Some(t("slack.empty"))));
                    }
                }
                Err(e) => {
                    let retry = e.retry_after.map(|n| format!(", {n}s")).unwrap_or_default();
                    this.status.set_label(&format!("{}{retry}", e));
                }
            }
        });
    }
}
