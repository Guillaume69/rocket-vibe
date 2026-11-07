//! A room's notes in a pane beside the conversation: the markdown rendered like
//! messages, an edit mode on the raw text with a formatting bar, saved whole
//! against the revision the edit started from. Whichever provider keeps the
//! notes hands in its own load and save.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use rv_core::markdown;
use rv_core::notes::{CONFLICT, Notes, STRUCTURE};

use crate::composer::{Marks, toolbar};
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

/// An edit left unsaved when the pane closed: its text and the revision it replaces.
#[derive(Debug, Clone)]
pub struct Draft {
    pub text: String,
    pub revision: String,
}

pub struct Page {
    root: adw::ToolbarView,
    source: Source,
    current: RefCell<Notes>,
    stamp: RefCell<Option<String>>,
    editing: Cell<bool>,
    /// What a save replaces: the revision the edit started from, moved only
    /// when a refused save has told the person about the newer one.
    base: RefCell<String>,
    adopt_revision: Cell<bool>,
    stack: gtk::Stack,
    view: gtk::ScrolledWindow,
    editor: gtk::TextView,
    format: gtk::Revealer,
    footer: gtk::Label,
    edit: gtk::Button,
    save: gtk::Button,
    cancel: gtk::Button,
    toasts: adw::ToastOverlay,
}

pub fn panel(room: &str, source: Source, draft: Option<Draft>, on_close: impl Fn() + 'static) -> Rc<Page> {
    let title = gtk::Label::builder()
        .label(format!("{} · {room}", t("notes.title")))
        .ellipsize(gtk::pango::EllipsizeMode::End)
        .css_classes(["heading"])
        .build();
    let header = adw::HeaderBar::builder().title_widget(&title).show_back_button(false).build();
    let close = gtk::Button::builder().icon_name("window-close-symbolic").tooltip_text(t("notes.close")).build();
    close.connect_clicked(move |_| on_close());
    header.pack_start(&close);
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
    let format = gtk::Revealer::builder().reveal_child(false).build();
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
    body.append(&format);
    body.append(&stack);
    body.append(&footer);
    let toasts = adw::ToastOverlay::new();
    toasts.set_child(Some(&body));
    let page = adw::ToolbarView::new();
    page.add_top_bar(&header);
    page.set_content(Some(&toasts));
    format.set_child(Some(&toolbar(&editor, Marks::Notes)));
    let this = Rc::new(Page {
        root: page,
        stamp: RefCell::new((source.stamp)()),
        source,
        current: RefCell::default(),
        editing: Cell::new(false),
        base: RefCell::default(),
        adopt_revision: Cell::new(false),
        stack,
        view,
        editor,
        format,
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
    if let Some(draft) = draft {
        this.edit_text(&draft.text, draft.revision);
    }
    this.reload(true);
    this
}

impl Page {
    pub fn widget(&self) -> &adw::ToolbarView {
        &self.root
    }

    /// The edit in progress, for when the pane closes.
    pub fn draft(&self) -> Option<Draft> {
        if !self.editing.get() {
            return None;
        }
        let buffer = self.editor.buffer();
        Some(Draft {
            text: buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string(),
            revision: self.base.borrow().clone(),
        })
    }

    fn reload(self: &Rc<Self>, first: bool) {
        let weak = Rc::downgrade(self);
        let answer = (self.source.load)();
        glib::spawn_future_local(async move {
            let result = answer.await;
            let Some(this) = weak.upgrade() else { return };
            match result {
                Ok(notes) => {
                    if this.adopt_revision.take() {
                        this.base.replace(notes.revision.clone());
                    }
                    this.current.replace(notes);
                    // While editing, a newer version waits for the save, which says so.
                    if !this.editing.get() {
                        this.show();
                    }
                }
                Err(_) if first && !this.editing.get() => {
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
        self.format.set_reveal_child(false);
        self.edit.set_visible(notes.editable);
        self.save.set_visible(false);
        self.cancel.set_visible(false);
        self.footer.set_label(&edited(&notes));
        self.footer.set_visible(!self.footer.label().is_empty());
    }

    pub fn start_editing(&self) {
        let (text, revision) = {
            let notes = self.current.borrow();
            (notes.markdown.clone(), notes.revision.clone())
        };
        self.edit_text(&text, revision);
    }

    fn edit_text(&self, text: &str, revision: String) {
        self.editing.set(true);
        self.base.replace(revision);
        self.editor.buffer().set_text(text);
        self.format.set_reveal_child(true);
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
        let revision = self.base.borrow().clone();
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
                    this.adopt_revision.set(true);
                    this.reload(false);
                }
                Err(code) if code == STRUCTURE => this.toast(t("notes.structure")),
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
