//! A room's notes in a dialog: the markdown rendered like messages, an edit
//! mode on the raw text, saved whole against the revision it was read at.
//! Whichever provider keeps the notes hands in its own load and save.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use rv_core::markdown;
use rv_core::notes::{CONFLICT, Notes};

use crate::i18n::{t, tf};
use crate::rows::short_time;

pub type Answer = Pin<Box<dyn Future<Output = Result<Notes, String>>>>;

/// How one provider reads and writes a room's notes.
pub struct Source {
    pub load: Box<dyn Fn() -> Answer>,
    /// The whole markdown and the revision it replaces.
    pub save: Box<dyn Fn(String, String) -> Answer>,
    /// Changes when the notes may have changed elsewhere; polled while shown.
    pub stamp: Box<dyn Fn() -> Option<String>>,
    /// The signed-in username, for mentions.
    pub me: String,
}

struct Page {
    source: Source,
    current: RefCell<Notes>,
    stamp: RefCell<Option<String>>,
    editing: Cell<bool>,
    stack: gtk::Stack,
    view: gtk::ScrolledWindow,
    editor: gtk::TextView,
    footer: gtk::Label,
    edit: gtk::Button,
    save: gtk::Button,
    cancel: gtk::Button,
    toasts: adw::ToastOverlay,
}

pub fn open(parent: &impl IsA<gtk::Widget>, room: &str, source: Source) {
    let header = adw::HeaderBar::new();
    let edit = gtk::Button::builder().label(t("notes.edit")).visible(false).build();
    let save = gtk::Button::builder().label(t("notes.save")).css_classes(["suggested-action"]).visible(false).build();
    let cancel = gtk::Button::builder().label(t("notes.cancel")).visible(false).build();
    header.pack_start(&cancel);
    header.pack_end(&edit);
    header.pack_end(&save);
    let view = gtk::ScrolledWindow::builder().vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).build();
    let editor = gtk::TextView::builder()
        .monospace(true)
        .wrap_mode(gtk::WrapMode::WordChar)
        .top_margin(12)
        .bottom_margin(12)
        .left_margin(12)
        .right_margin(12)
        .build();
    let editor_scroll = gtk::ScrolledWindow::builder().vexpand(true).child(&editor).build();
    let stack = gtk::Stack::new();
    stack.add_named(
        &gtk::Spinner::builder().spinning(true).halign(gtk::Align::Center).valign(gtk::Align::Center).build(),
        Some("loading"),
    );
    stack.add_named(&view, Some("view"));
    stack.add_named(&editor_scroll, Some("edit"));
    let footer = gtk::Label::builder()
        .xalign(0.0)
        .css_classes(["dim-label", "caption"])
        .margin_start(12)
        .margin_end(12)
        .margin_top(6)
        .margin_bottom(6)
        .build();
    let body = gtk::Box::builder().orientation(gtk::Orientation::Vertical).build();
    body.append(&stack);
    body.append(&footer);
    let toasts = adw::ToastOverlay::new();
    toasts.set_child(Some(&body));
    let page = adw::ToolbarView::new();
    page.add_top_bar(&header);
    page.set_content(Some(&toasts));
    let dialog = adw::Dialog::builder()
        .title(format!("{} · {room}", t("notes.title")))
        .content_width(640)
        .content_height(560)
        .child(&page)
        .build();
    let this = Rc::new(Page {
        stamp: RefCell::new((source.stamp)()),
        source,
        current: RefCell::default(),
        editing: Cell::new(false),
        stack,
        view,
        editor,
        footer,
        edit,
        save,
        cancel,
        toasts,
    });
    let weak = Rc::downgrade(&this);
    this.edit.connect_clicked(move |_| {
        if let Some(this) = weak.upgrade() {
            this.start_editing();
        }
    });
    let weak = Rc::downgrade(&this);
    this.cancel.connect_clicked(move |_| {
        if let Some(this) = weak.upgrade() {
            this.editing.set(false);
            this.show();
        }
    });
    let weak = Rc::downgrade(&this);
    this.save.connect_clicked(move |_| {
        if let Some(this) = weak.upgrade() {
            this.commit();
        }
    });
    let weak = Rc::downgrade(&this);
    glib::timeout_add_local(std::time::Duration::from_secs(2), move || {
        let Some(this) = weak.upgrade() else { return glib::ControlFlow::Break };
        let stamp = (this.source.stamp)();
        if stamp != *this.stamp.borrow() {
            this.stamp.replace(stamp);
            this.reload(false);
        }
        glib::ControlFlow::Continue
    });
    // The poll above holds the page weakly: the dialog keeps it alive.
    let kept = this.clone();
    dialog.connect_closed(move |_| {
        let _ = &kept;
    });
    this.reload(true);
    crate::widgets::present(&dialog, Some(parent));
}

impl Page {
    fn reload(self: &Rc<Self>, first: bool) {
        let weak = Rc::downgrade(self);
        let answer = (self.source.load)();
        glib::spawn_future_local(async move {
            let result = answer.await;
            let Some(this) = weak.upgrade() else { return };
            match result {
                Ok(notes) => {
                    this.current.replace(notes);
                    // While editing, a newer version waits for the save, which says so.
                    if !this.editing.get() {
                        this.show();
                    }
                }
                Err(_) if first => {
                    this.stack.set_visible_child_name("view");
                    this.view.set_child(Some(&placeholder(t("notes.load_failed"))));
                }
                Err(_) => {}
            }
        });
    }

    fn show(&self) {
        let notes = self.current.borrow();
        let content: gtk::Widget = if notes.markdown.trim().is_empty() {
            placeholder(t("notes.empty")).upcast()
        } else {
            let ctx = markdown::Context { me: &self.source.me, names: None };
            let rendered =
                crate::markdown_view::view(&markdown::render(None, Some(&notes.markdown), &ctx), &["notes-text"]);
            rendered.set_margin_start(16);
            rendered.set_margin_end(16);
            rendered.set_margin_top(12);
            rendered.set_margin_bottom(12);
            rendered.set_valign(gtk::Align::Start);
            rendered.upcast()
        };
        self.view.set_child(Some(&content));
        self.stack.set_visible_child_name("view");
        self.edit.set_visible(notes.editable);
        self.save.set_visible(false);
        self.cancel.set_visible(false);
        self.footer.set_label(&edited(&notes));
        self.footer.set_visible(!self.footer.label().is_empty());
    }

    fn start_editing(&self) {
        self.editing.set(true);
        self.editor.buffer().set_text(&self.current.borrow().markdown);
        self.stack.set_visible_child_name("edit");
        self.edit.set_visible(false);
        self.save.set_visible(true);
        self.save.set_sensitive(true);
        self.cancel.set_visible(true);
        self.editor.grab_focus();
    }

    fn commit(self: &Rc<Self>) {
        let buffer = self.editor.buffer();
        let text = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string();
        let revision = self.current.borrow().revision.clone();
        self.save.set_sensitive(false);
        let weak = Rc::downgrade(self);
        let answer = (self.source.save)(text, revision);
        glib::spawn_future_local(async move {
            let result = answer.await;
            let Some(this) = weak.upgrade() else { return };
            this.save.set_sensitive(true);
            match result {
                Ok(notes) => {
                    this.current.replace(notes);
                    this.stamp.replace((this.source.stamp)());
                    this.editing.set(false);
                    this.show();
                }
                Err(code) if code == CONFLICT => {
                    // Keep the text; the next save goes over the newer version.
                    this.toast(t("notes.conflict"));
                    this.reload(false);
                }
                Err(_) => this.toast(t("notes.save_failed")),
            }
        });
    }

    fn toast(&self, text: &str) {
        self.toasts.add_toast(adw::Toast::new(text));
    }
}

fn placeholder(text: &str) -> gtk::Label {
    gtk::Label::builder()
        .label(text)
        .wrap(true)
        .css_classes(["dim-label"])
        .margin_top(24)
        .margin_bottom(24)
        .margin_start(16)
        .margin_end(16)
        .valign(gtk::Align::Start)
        .build()
}

fn edited(notes: &Notes) -> String {
    match (notes.updated_by.as_deref(), notes.updated_ms()) {
        (Some(name), Some(at)) => tf("notes.edited", &[("name", name), ("time", &short_time(at))]),
        _ => String::new(),
    }
}
