//! Hidden read-only Slack connection. Each request belongs to this panel's generation.
use crate::{i18n::t, widgets};
use adw::prelude::*;
use gtk::glib;
use rv_core::slack::{Conversation, Reader};
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;
fn file() -> std::path::PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs").join("experimental-providers")
}
pub fn enabled() -> bool {
    file().exists()
}
fn set_enabled(value: bool) -> std::io::Result<()> {
    let file = file();
    if value {
        std::fs::create_dir_all(file.parent().expect("config dir"))?;
        std::fs::write(file, "")
    } else if file.exists() {
        std::fs::remove_file(file)
    } else {
        Ok(())
    }
}
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
            .visible(enabled())
            .css_classes(["card"])
            .build();
        root.append(&gtk::Label::builder().label(t("slack.title")).xalign(0.0).css_classes(["heading"]).build());
        root.append(&gtk::Label::builder().label(t("slack.previewHelp")).wrap(true).xalign(0.0).build());
        let form = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).build();
        let (token_row, token) = widgets::pill_field(t("slack.token"), "xoxc-…", true);
        let (cookie_row, cookie) = widgets::pill_field(t("slack.cookie"), "xoxd-…", true);
        let connect = gtk::Button::with_label(t("slack.connect"));
        form.append(&token_row);
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
            room: RefCell::new(None),
            cursor: RefCell::new(None),
            seen: RefCell::new(HashSet::new()),
            item_ids: RefCell::new(HashSet::new()),
            busy: Cell::new(false),
            generation: Cell::new(0),
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
                match set_enabled(false) {
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
    pub fn unlock(&self) {
        match set_enabled(true) {
            Ok(()) => self.root.set_visible(true),
            Err(_) => {
                self.root.set_visible(true);
                self.status.set_label(t("slack.unlockFailed"));
            }
        }
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
        self.token.set_text("");
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
        let reader = match Reader::new(self.token.text().to_string(), self.cookie.text().to_string()) {
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
            let found = crate::on_tokio(async move { reader.authenticate().await }).await;
            let Some(this) = weak.upgrade() else {
                return;
            };
            if this.generation.get() != generation {
                return;
            }
            this.set_busy(false);
            match found {
                Ok(who) => {
                    this.token.set_text("");
                    this.cookie.set_text("");
                    this.form.set_visible(false);
                    this.status.set_label(&format!("{} · @{}", who.team, who.user));
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
            self.status.set_label("Slack: pagination_loop");
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
                Rooms(rv_core::slack::Page<Conversation>),
                Messages(rv_core::slack::Page<rv_core::slack::Message>),
            }
            let cursor = requested.clone();
            let selected = room.clone();
            let result = crate::on_tokio(async move {
                match selected {
                    Some(room) => reader.history(&room.id, cursor.as_deref()).await.map(Page::Messages),
                    None => reader.conversations(cursor.as_deref()).await.map(Page::Rooms),
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
                            for room in page.items {
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
                            page.next_cursor
                        }
                        Page::Messages(page) => {
                            for message in page.items {
                                if !this.item_ids.borrow_mut().insert(message.ts.clone()) {
                                    continue;
                                }
                                let row =
                                    gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).build();
                                let date = message
                                    .ts
                                    .split('.')
                                    .next()
                                    .and_then(|s| s.parse::<i64>().ok())
                                    .and_then(|s| chrono::DateTime::from_timestamp(s, 0))
                                    .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
                                    .unwrap_or_default();
                                row.append(
                                    &gtk::Label::builder()
                                        .label(format!("{} · {}", message.user, date))
                                        .xalign(0.0)
                                        .css_classes(["file-detail"])
                                        .build(),
                                );
                                row.append(
                                    &gtk::Label::builder()
                                        .label(if message.text.is_empty() {
                                            t("slack.unsupportedContent")
                                        } else {
                                            &message.text
                                        })
                                        .wrap(true)
                                        .selectable(true)
                                        .xalign(0.0)
                                        .build(),
                                );
                                this.content.append(&row);
                            }
                            page.next_cursor
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
