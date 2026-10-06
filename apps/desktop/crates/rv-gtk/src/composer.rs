//! The message field: grows to `MAX_HEIGHT`, then scrolls; Enter sends,
//! Shift+Enter breaks the line.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use gtk::prelude::*;
use gtk::{gdk, gio, glib};
use rv_core::session::Session;

use crate::attach::Picked;
use crate::i18n::{t, tf};
use crate::on_tokio;
use crate::widgets::{self, Handler};

const MAX_HEIGHT: i32 = 160;
#[path = "composer_quotes.rs"]
mod quote_author;

pub struct Composer {
    pub root: gtk::Box,
    text: gtk::TextView,
    on_submit: Handler<String>,
    reply_bar: gtk::Box,
    reply_title: gtk::Label,
    reply_preview: gtk::Label,
    /// The quoted message's permalink, put before the text on send.
    reply_link: RefCell<Option<String>>,
    native_reply: RefCell<Option<rv_core::native::store::QuoteSelection>>,
    private_reply: RefCell<Option<rv_core::native::crypto::enrollment::rooms::messages::QuoteSelection>>,
    private_access: RefCell<Option<rv_core::native::crypto::enrollment::rooms::messages::Access>>,
    quote_author: quote_author::State,
    on_changed: Handler<String>,
    completion: gtk::Popover,
    choices: gtk::ListBox,
    /// (trigger start, text inserted) of each offered choice.
    offered: RefCell<Vec<(usize, String)>>,
    mentions: RefCell<Option<MentionSource>>,
    on_files: Handler<Vec<Picked>>,
    custom_emoji: RefCell<Option<MentionSource>>,
    custom_names: Rc<RefCell<Option<crate::emoji_picker::CustomSource>>>,
    field: gtk::Box,
    record_bar: gtk::Box,
    record_time: gtk::Label,
    recorder: RefCell<Option<crate::recorder::Recorder>>,
    on_error: Handler<String>,
    on_edit_last: Handler<()>,
    staged: Rc<crate::staged::Staged>,
    attach: gtk::Button,
    mic: gtk::Button,
    on_send_files: Handler<Outgoing>,
    commands: RefCell<Commands>,
    note_bar: gtk::Box,
    note_body: gtk::Box,
    note: RefCell<String>,
}

/// The server's slash commands, and what I may run in the bound room.
#[derive(Default)]
struct Commands {
    key: String,
    list: Vec<rv_core::commands::Command>,
    granted: Option<Vec<String>>,
}

type MentionSource = Rc<dyn Fn(&str) -> Vec<String>>;

/// Staged files on their way out: their text, and whether images keep full quality.
pub struct Outgoing {
    pub items: Vec<(Picked, String)>,
    pub caption: String,
    pub original: bool,
}

impl Composer {
    pub fn new() -> Rc<Self> {
        let text = gtk::TextView::builder()
            .wrap_mode(gtk::WrapMode::WordChar)
            .accepts_tab(false)
            .hexpand(true)
            .valign(gtk::Align::Center)
            .top_margin(0)
            .bottom_margin(0)
            .build();
        style_tags(&text.buffer());
        text.buffer().connect_changed(restyle);
        text.buffer().connect_cursor_position_notify(restyle);
        spell_menu(&text);
        let shortcuts = gtk::EventControllerKey::builder().propagation_phase(gtk::PropagationPhase::Capture).build();
        shortcuts.connect_key_pressed(glib::clone!(
            #[weak]
            text,
            #[upgrade_or]
            glib::Propagation::Proceed,
            move |_, key, _, state| {
                use rv_core::compose::LineKind;
                if !state.contains(gdk::ModifierType::CONTROL_MASK) {
                    return glib::Propagation::Proceed;
                }
                let shift = state.contains(gdk::ModifierType::SHIFT_MASK);
                let action = match key.to_lower() {
                    gdk::Key::b => Format::Wrap("*"),
                    gdk::Key::i => Format::Wrap("_"),
                    gdk::Key::x if shift => Format::Wrap("~"),
                    gdk::Key::k => Format::Link,
                    gdk::Key::e if shift => Format::CodeBlock,
                    gdk::Key::e => Format::Wrap("`"),
                    gdk::Key::_7 if shift => Format::Lines(LineKind::Numbered),
                    gdk::Key::_8 if shift => Format::Lines(LineKind::Bullet),
                    gdk::Key::_9 if shift => Format::Lines(LineKind::Quote),
                    _ => return glib::Propagation::Proceed,
                };
                format(&text, action);
                glib::Propagation::Stop
            }
        ));
        text.add_controller(shortcuts);
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::External)
            .overlay_scrolling(false)
            .propagate_natural_height(true)
            .max_content_height(MAX_HEIGHT)
            .child(&text)
            .hexpand(true)
            .build();
        // A scrollbar only when the draft is taller than the cap, decided from
        // the text's measured height: a visible scrollbar adds its minimum
        // length to the composer's height, and deciding from the scroll range
        // caught it mid-layout, one line short, and left it scrolled.
        let fit = glib::clone!(
            #[weak]
            text,
            #[weak]
            scroll,
            move || {
                let width = scroll.width();
                if width <= 0 {
                    return;
                }
                let (_, natural, _, _) = text.measure(gtk::Orientation::Vertical, width);
                let overflows = natural > MAX_HEIGHT;
                let policy = if overflows { gtk::PolicyType::Automatic } else { gtk::PolicyType::External };
                if scroll.vscrollbar_policy() != policy {
                    scroll.set_vscrollbar_policy(policy);
                }
                if !overflows {
                    scroll.vadjustment().set_value(0.0);
                }
            }
        );
        let on_edit = fit.clone();
        text.buffer().connect_changed(move |_| {
            let fit = on_edit.clone();
            glib::idle_add_local_once(fit);
        });
        scroll.hadjustment().connect_changed(move |_| fit());

        let pill = gtk::Box::builder().css_classes(["composer-pill"]).hexpand(true).valign(gtk::Align::End).build();
        let placeholder = gtk::Label::builder()
            .label(t("composer.placeholder"))
            .css_classes(["composer-placeholder"])
            .xalign(0.0)
            .can_target(false)
            .build();
        let stack = gtk::Overlay::builder().child(&scroll).hexpand(true).build();
        stack.add_overlay(&placeholder);
        text.buffer().connect_changed(glib::clone!(
            #[weak]
            placeholder,
            move |buffer| placeholder.set_visible(buffer.char_count() == 0)
        ));
        let attach = gtk::Button::builder()
            .icon_name("mail-attachment-symbolic")
            .tooltip_text(t("attach.choose"))
            .css_classes(["flat", "attach-button"])
            .valign(gtk::Align::End)
            .build();
        pill.append(&attach);
        pill.append(&stack);
        let text_for_picker = text.clone();
        let custom_names: Rc<RefCell<Option<crate::emoji_picker::CustomSource>>> = Rc::default();
        let names = custom_names.clone();
        pill.append(&crate::emoji_picker::button(
            move |glyph| {
                text_for_picker.buffer().insert_at_cursor(glyph);
                text_for_picker.grab_focus();
            },
            Rc::new(move || names.borrow().as_ref().map(|f| f()).unwrap_or_default()),
        ));
        let choices =
            gtk::ListBox::builder().selection_mode(gtk::SelectionMode::Single).css_classes(["completion"]).build();
        let completion = gtk::Popover::builder()
            .child(&choices)
            .autohide(false)
            .has_arrow(false)
            .position(gtk::PositionType::Top)
            .halign(gtk::Align::Start)
            .can_focus(false)
            .build();
        completion.set_parent(&pill);
        let send = gtk::Button::builder()
            .child(&widgets::send_arrow())
            .tooltip_text(t("composer.send"))
            .css_classes(["send"])
            .valign(gtk::Align::End)
            .build();
        let mic = gtk::Button::builder()
            .icon_name("audio-input-microphone-symbolic")
            .tooltip_text(t("voice.record"))
            .css_classes(["flat", "attach-button"])
            .valign(gtk::Align::End)
            .build();
        pill.append(&mic);
        let field = gtk::Box::builder().spacing(10).build();
        field.append(&pill);
        field.append(&send);

        let record_time =
            gtk::Label::builder().label("0:00").css_classes(["record-time"]).hexpand(true).xalign(0.0).build();
        let record_cancel = gtk::Button::builder().label(t("voice.cancel")).css_classes(["flat"]).build();
        // Stopping stages the recording, to be listened to before it goes.
        let record_send = gtk::Button::builder()
            .icon_name("media-playback-stop-symbolic")
            .tooltip_text(t("voice.stop"))
            .css_classes(["send"])
            .build();
        let record_bar = gtk::Box::builder().spacing(10).css_classes(["record-bar"]).visible(false).build();
        record_bar.append(&gtk::Box::builder().css_classes(["record-dot"]).valign(gtk::Align::Center).build());
        record_bar.append(&record_time);
        record_bar.append(&record_cancel);
        record_bar.append(&record_send);

        let reply_title = gtk::Label::builder().xalign(0.0).css_classes(["reply-title"]).build();
        let reply_preview = gtk::Label::builder()
            .xalign(0.0)
            .ellipsize(gtk::pango::EllipsizeMode::End)
            .single_line_mode(true)
            .css_classes(["reply-preview"])
            .build();
        let reply_text = gtk::Box::builder().orientation(gtk::Orientation::Vertical).hexpand(true).build();
        reply_text.append(&reply_title);
        reply_text.append(&reply_preview);
        let reply_close =
            gtk::Button::builder().label("✕").css_classes(["flat", "circular"]).valign(gtk::Align::Center).build();
        let reply_bar = gtk::Box::builder().spacing(8).css_classes(["reply-bar"]).visible(false).build();
        reply_bar.append(&reply_text);
        reply_bar.append(&reply_close);

        let note_body = gtk::Box::builder().orientation(gtk::Orientation::Vertical).css_classes(["note-body"]).build();
        let note_text = gtk::Box::builder().orientation(gtk::Orientation::Vertical).hexpand(true).build();
        note_text.append(
            &gtk::Label::builder().label(t("command.only_you")).xalign(0.0).css_classes(["reply-title"]).build(),
        );
        note_text.append(&note_body);
        let note_close =
            gtk::Button::builder().label("✕").css_classes(["flat", "circular"]).valign(gtk::Align::Start).build();
        let note_bar = gtk::Box::builder().spacing(8).css_classes(["reply-bar", "private-note"]).visible(false).build();
        note_bar.append(&note_text);
        note_bar.append(&note_close);
        note_close.connect_clicked(glib::clone!(
            #[weak]
            note_bar,
            move |_| note_bar.set_visible(false)
        ));

        let staged = crate::staged::Staged::new();
        let root = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(6)
            .margin_top(10)
            .margin_bottom(12)
            .margin_start(14)
            .margin_end(14)
            .build();
        root.append(&note_bar);
        root.append(&reply_bar);
        root.append(&staged.root);
        root.append(&field);
        root.append(
            &gtk::ScrolledWindow::builder()
                .hscrollbar_policy(gtk::PolicyType::External)
                .vscrollbar_policy(gtk::PolicyType::Never)
                .propagate_natural_width(false)
                .child(&toolbar(&text))
                .build(),
        );
        root.append(&record_bar);

        let this = Rc::new(Composer {
            root,
            text,
            on_submit: RefCell::default(),
            reply_bar,
            reply_title,
            reply_preview,
            reply_link: RefCell::default(),
            native_reply: RefCell::default(),
            private_reply: RefCell::default(),
            private_access: RefCell::default(),
            quote_author: quote_author::State::default(),
            on_changed: RefCell::default(),
            completion,
            choices,
            offered: RefCell::default(),
            mentions: RefCell::default(),
            on_files: RefCell::default(),
            custom_emoji: RefCell::default(),
            custom_names,
            field,
            record_bar,
            record_time,
            recorder: RefCell::default(),
            on_error: RefCell::default(),
            on_edit_last: RefCell::default(),
            staged,
            attach: attach.clone(),
            mic: mic.clone(),
            on_send_files: RefCell::default(),
            commands: RefCell::default(),
            note_bar,
            note_body,
            note: RefCell::default(),
        });
        let weak = Rc::downgrade(&this);
        mic.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.start_recording();
            }
        });
        let weak = Rc::downgrade(&this);
        record_cancel.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.stop_recording(false);
            }
        });
        let weak = Rc::downgrade(&this);
        record_send.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.stop_recording(true);
            }
        });
        let weak = Rc::downgrade(&this);
        attach.connect_clicked(move |button| {
            let weak = weak.clone();
            crate::attach::choose(button, move |picked| {
                if let Some(this) = weak.upgrade() {
                    this.emit_files(picked);
                }
            });
        });
        // Files or a picture on the clipboard become an attachment, not text.
        let weak = Rc::downgrade(&this);
        this.text.connect_paste_clipboard(move |view| {
            let clipboard = view.clipboard();
            let formats = clipboard.formats();
            let files = formats.contains_type(gdk::FileList::static_type());
            let picture = !files
                && !formats.contain_mime_type("text/plain")
                && formats.contains_type(gdk::Texture::static_type());
            if !files && !picture {
                return;
            }
            view.stop_signal_emission_by_name("paste-clipboard");
            let weak = weak.clone();
            glib::spawn_future_local(async move {
                let picked = if files {
                    let value =
                        clipboard.read_value_future(gdk::FileList::static_type(), glib::Priority::DEFAULT).await;
                    value
                        .ok()
                        .and_then(|v| v.get::<gdk::FileList>().ok())
                        .map(|l| crate::attach::from_files(&l.files()))
                } else {
                    let texture = clipboard.read_texture_future().await.ok().flatten();
                    texture.and_then(|t| crate::attach::save_texture(&t)).map(|p| vec![p])
                };
                if let (Some(this), Some(picked)) = (weak.upgrade(), picked.filter(|p| !p.is_empty())) {
                    this.emit_files(picked);
                }
            });
        });
        let weak = Rc::downgrade(&this);
        this.text.buffer().connect_changed(move |buffer| {
            let Some(this) = weak.upgrade() else { return };
            let text = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string();
            if let Some(changed) = this.on_changed.borrow().clone() {
                changed(text);
            }
            this.update_completion();
        });
        let weak = Rc::downgrade(&this);
        this.choices.connect_row_activated(move |_, row| {
            if let Some(this) = weak.upgrade() {
                this.accept(row.index());
            }
        });
        // Capture phase: while choices show, arrows, Enter, Tab and Escape
        // drive them instead of the text.
        let navigation = gtk::EventControllerKey::builder().propagation_phase(gtk::PropagationPhase::Capture).build();
        let weak = Rc::downgrade(&this);
        navigation.connect_key_pressed(move |_, key, _, _| {
            let Some(this) = weak.upgrade() else { return glib::Propagation::Proceed };
            if !this.completion.is_visible() {
                return glib::Propagation::Proceed;
            }
            let selected = this.choices.selected_row().map_or(0, |r| r.index());
            let count = this.offered.borrow().len() as i32;
            match key {
                gdk::Key::Down => this.select((selected + 1) % count.max(1)),
                gdk::Key::Up => this.select((selected - 1).rem_euclid(count.max(1))),
                gdk::Key::Return | gdk::Key::KP_Enter | gdk::Key::Tab => this.accept(selected),
                gdk::Key::Escape => this.completion.popdown(),
                _ => return glib::Propagation::Proceed,
            }
            glib::Propagation::Stop
        });
        this.text.add_controller(navigation);
        let weak = Rc::downgrade(&this);
        reply_close.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.clear_reply();
            }
        });
        let weak = Rc::downgrade(&this);
        send.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.submit();
            }
        });
        let keys = gtk::EventControllerKey::new();
        let weak = Rc::downgrade(&this);
        keys.connect_key_pressed(move |_, key, _, state| {
            if key == gdk::Key::Up
                && let Some(this) = weak.upgrade()
                && this.text().is_empty()
                && let Some(f) = this.on_edit_last.borrow().clone()
            {
                f(());
                return glib::Propagation::Stop;
            }
            let enter = key == gdk::Key::Return || key == gdk::Key::KP_Enter;
            if enter
                && state.contains(gdk::ModifierType::SHIFT_MASK)
                && let Some(this) = weak.upgrade()
                && this.continue_list()
            {
                return glib::Propagation::Stop;
            }
            if !enter || state.contains(gdk::ModifierType::SHIFT_MASK) {
                return glib::Propagation::Proceed;
            }
            if let Some(this) = weak.upgrade() {
                this.submit();
            }
            glib::Propagation::Stop
        });
        this.text.add_controller(keys);
        this.watch_ordinary_quotes();
        this
    }

    /// Shift+Enter in a list: the next item's marker comes with the new line.
    fn continue_list(&self) -> bool {
        let buffer = self.text.buffer();
        if buffer.has_selection() {
            return false;
        }
        let text = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string();
        let Some(edited) = rv_core::compose::list_break(&text, self.cursor_offset()) else { return false };
        buffer.begin_user_action();
        buffer.set_text(&edited.text);
        buffer.end_user_action();
        buffer.place_cursor(&buffer.iter_at_offset(edited.start as i32));
        true
    }

    /// Called on every edit, with the whole text: drafts are saved from here.
    pub fn connect_changed(&self, f: impl Fn(String) + 'static) {
        self.on_changed.replace(Some(Rc::new(f)));
    }

    /// Up with nothing typed: the page edits my last message.
    pub fn connect_edit_last(&self, f: impl Fn() + 'static) {
        self.on_edit_last.replace(Some(Rc::new(move |()| f())));
    }

    pub fn connect_error(&self, f: impl Fn(String) + 'static) {
        self.on_error.replace(Some(Rc::new(f)));
    }

    fn report(&self, text: String) {
        if let Some(f) = self.on_error.borrow().clone() {
            f(text);
        }
    }

    pub fn start_recording(self: &Rc<Self>) {
        if !self.mic.is_sensitive() {
            return;
        }
        if self.recorder.borrow().is_some() {
            return;
        }
        match crate::recorder::Recorder::start() {
            Ok(recorder) => {
                self.recorder.replace(Some(recorder));
                self.field.set_visible(false);
                self.record_bar.set_visible(true);
                self.record_time.set_label("0:00");
                let weak = Rc::downgrade(self);
                glib::timeout_add_local(std::time::Duration::from_millis(250), move || {
                    let Some(this) = weak.upgrade() else { return glib::ControlFlow::Break };
                    let failure = this.recorder.borrow().as_ref().and_then(|r| r.failure());
                    if let Some(failure) = failure {
                        this.stop_recording(false);
                        this.report(tf("voice.failed", &[("error", &failure)]));
                        return glib::ControlFlow::Break;
                    }
                    let Some(seconds) = this.recorder.borrow().as_ref().map(|r| r.elapsed().as_secs()) else {
                        return glib::ControlFlow::Break;
                    };
                    this.record_time.set_label(&format!("{}:{:02}", seconds / 60, seconds % 60));
                    glib::ControlFlow::Continue
                });
            }
            Err(e) => self.report(tf("voice.failed", &[("error", &e)])),
        }
    }

    pub fn recording(&self) -> bool {
        self.record_bar.is_visible()
    }

    /// `keep`: the recording joins the files waiting to go, where it can be
    /// listened to and captioned; otherwise it is thrown away.
    pub fn stop_recording(&self, keep: bool) {
        let Some(recorder) = self.recorder.take() else { return };
        self.record_bar.set_visible(false);
        self.field.set_visible(true);
        if !keep {
            recorder.cancel();
            return;
        }
        match recorder.finish() {
            Some(path) => {
                let name = format!("{}-{}.ogg", t("voice.file_name"), chrono::Local::now().format("%Y%m%d-%H%M%S"));
                self.staged.add(vec![Picked { path, name, temporary: true }]);
                self.grab_focus();
            }
            None => self.report(t("voice.empty").to_owned()),
        }
    }

    /// Files to attach: chosen, pasted, or dropped on the page.
    pub fn connect_files(&self, f: impl Fn(Vec<Picked>) + 'static) {
        self.on_files.replace(Some(Rc::new(f)));
    }

    pub fn emit_files(&self, picked: Vec<Picked>) {
        if !self.attach.is_sensitive() {
            return;
        }
        if let Some(f) = self.on_files.borrow().clone() {
            f(picked);
        }
    }

    /// Ties the composer to a room (`thread` None) or a thread: restores its
    /// draft, saves it as it changes, and offers the room's authors after `@`.
    pub fn bind(self: &Rc<Self>, session: &Arc<Session>, rid: &str, thread: Option<&str>) {
        self.unbind_native();
        self.attach.set_sensitive(true);
        self.mic.set_sensitive(true);
        let key = match thread {
            Some(tmid) => format!("{rid}:{tmid}"),
            None => rid.to_owned(),
        };
        self.staged.switch(&key);
        self.on_changed.replace(None);
        self.set_text(&session.store.draft(&key).unwrap_or_default());
        self.completion.popdown();
        self.note_bar.set_visible(false);
        self.load_commands(session, rid, &key);
        let generation = Rc::new(Cell::new(0u64));
        let store = session.store.clone();
        self.connect_changed(move |text| {
            let current = generation.get() + 1;
            generation.set(current);
            let (generation, store, key) = (generation.clone(), store.clone(), key.clone());
            glib::timeout_add_local_once(std::time::Duration::from_millis(400), move || {
                if generation.get() == current {
                    store.write(|w| w.set_draft(&key, &text));
                }
            });
        });
        let (store, rid, me) = (session.store.clone(), rid.to_owned(), session.info.username.clone());
        self.set_mention_source(move |prefix| {
            rv_core::completion::mentions(prefix, &store.recent_authors(&rid, 30), &me, 8)
        });
        let s = session.clone();
        self.custom_emoji.replace(Some(Rc::new(move |prefix: &str| s.custom_emoji_codes(prefix))));
        let s = session.clone();
        self.custom_names.replace(Some(Rc::new(move || s.custom_emoji_names())));
    }

    pub fn bind_native(&self, session: &Arc<rv_core::native::NativeSession>, rid: &str) {
        self.unbind_native();
        let files = session.supported_features().iter().any(|f| f == "uploads");
        self.quote_author.files.set(files);
        self.attach.set_sensitive(files);
        self.mic.set_sensitive(files);
        self.staged.switch(rid);
        self.on_changed.replace(None);
        let membership = session.store.read_state(rid).ok().flatten().and_then(|s| s.membership_version);
        self.set_text(&session.store.draft_from_membership(rid, membership.as_deref()).unwrap_or_default());
        self.completion.popdown();
        self.mentions.replace(None);
        let s = session.clone();
        self.custom_emoji.replace(Some(Rc::new(move |prefix: &str| s.custom_emoji_codes(prefix))));
        let s = session.clone();
        self.custom_names.replace(Some(Rc::new(move || s.custom_emoji_names())));
        let (store, rid, session) = (session.store.clone(), rid.to_owned(), session.clone());
        self.connect_changed(move |text| {
            let _ = store.set_draft_from_membership(&rid, &text, membership.as_deref());
            let (session, rid, membership) = (session.clone(), rid.clone(), membership.clone());
            crate::runtime().spawn(async move {
                let _ = session
                    .set_typing_from_membership(&rid, None, !text.trim().is_empty(), membership.as_deref())
                    .await;
            });
        });
    }
    pub fn unbind_native(&self) {
        self.close_ordinary_quote();
        self.quote_author.binding.set(self.quote_author.binding.get().wrapping_add(1));
        self.quote_author.sending.set(false);
        if let Some(access) = self.private_access.take() {
            access.cancel_quote();
        }
        self.on_changed.replace(None);
        self.completion.popdown();
        // Slash commands and their private notes belong to a Rocket.Chat room.
        self.note_bar.set_visible(false);
        self.commands.replace(Commands::default());
    }
    pub fn bind_private(
        &self,
        access: rv_core::native::crypto::enrollment::rooms::messages::Access,
        rid: &str,
        draft: &str,
    ) {
        self.unbind_native();
        // Encrypted files (E2EE_FILES.md) and voice messages, in the room or a thread.
        self.attach.set_sensitive(access.files_available());
        self.mic.set_sensitive(access.files_available());
        self.staged.switch(rid);
        self.clear_reply();
        self.private_access.replace(Some(access.clone()));
        self.set_text(draft);
        self.connect_changed(move |text| {
            let access = access.clone();
            crate::runtime().spawn(async move {
                let _ = access.set_draft(text).await;
            });
        });
    }
    pub fn bind_native_thread(
        &self,
        session: &Arc<rv_core::native::NativeSession>,
        rid: &str,
        root: &str,
        membership: Option<String>,
    ) {
        self.bind_native(session, rid);
        self.on_changed.replace(None);
        self.set_text(
            &session.store.thread_draft_from_membership(rid, root, membership.as_deref()).unwrap_or_default(),
        );
        let (store, rid, root, session) = (session.store.clone(), rid.to_owned(), root.to_owned(), session.clone());
        self.connect_changed(move |text| {
            let _ = store.set_thread_draft_from_membership(&rid, &root, &text, membership.as_deref());
            let (session, rid, root, membership) = (session.clone(), rid.clone(), root.clone(), membership.clone());
            crate::runtime().spawn(async move {
                let _ = session
                    .set_typing_from_membership(&rid, Some(&root), !text.trim().is_empty(), membership.as_deref())
                    .await;
            });
        });
    }

    /// Fetches the commands offered after `/`, and my permissions in the room
    /// to leave out those I may not run.
    fn load_commands(self: &Rc<Self>, session: &Arc<Session>, rid: &str, key: &str) {
        self.commands.replace(Commands { key: key.to_owned(), ..Default::default() });
        let (weak, s, rid, key) = (Rc::downgrade(self), session.clone(), rid.to_owned(), key.to_owned());
        glib::spawn_future_local(async move {
            let (list, granted) =
                on_tokio(async move { (s.commands().await.map(<[_]>::to_vec), s.permissions(&rid).await) }).await;
            let Some(this) = weak.upgrade() else { return };
            if this.commands.borrow().key != key {
                return;
            }
            this.commands.replace(Commands { key, list: list.unwrap_or_default(), granted });
            this.update_completion();
        });
    }

    /// What the server told me alone here, such as a command's answer.
    pub fn show_private(&self, text: &str, me: &str) {
        while let Some(child) = self.note_body.first_child() {
            self.note_body.remove(&child);
        }
        let blocks = rv_core::markdown::render(None, Some(text), &rv_core::markdown::Context { me });
        self.note_body.append(&crate::markdown_view::view(&blocks, &[]));
        self.note.replace(text.to_owned());
        self.note_bar.set_visible(true);
    }

    /// The private note on show, if any.
    pub fn private_note(&self) -> Option<String> {
        self.note_bar.is_visible().then(|| self.note.borrow().clone())
    }

    /// Usernames offered after `@`, given the prefix typed.
    pub fn set_mention_source(&self, f: impl Fn(&str) -> Vec<String> + 'static) {
        self.mentions.replace(Some(Rc::new(f)));
    }

    fn cursor_offset(&self) -> usize {
        let buffer = self.text.buffer();
        buffer.iter_at_mark(&buffer.get_insert()).offset().max(0) as usize
    }

    fn update_completion(&self) {
        let buffer = self.text.buffer();
        let cursor = buffer.iter_at_mark(&buffer.get_insert());
        let before = buffer.text(&buffer.start_iter(), &cursor, false).to_string();
        let offered: Vec<(String, usize, String, Option<gtk::Widget>)> =
            if let Some(prefix) = rv_core::commands::query(&before) {
                let commands = self.commands.borrow();
                rv_core::commands::complete(&commands.list, prefix, commands.granted.as_deref(), 8)
                    .into_iter()
                    .map(|c| (format!("/{}", c.name), 0, format!("/{} ", c.name), Some(command_choice(c))))
                    .collect()
            } else {
                match rv_core::completion::query(&before) {
                    Some(q) if q.trigger == rv_core::completion::Trigger::Mention => {
                        let source = self.mentions.borrow().clone();
                        source
                            .map(|f| f(&q.prefix))
                            .unwrap_or_default()
                            .into_iter()
                            .map(|name| {
                                let card = crate::markdown_view::mention_preview(&name);
                                (format!("@{name}"), q.start, format!("@{name} "), card)
                            })
                            .collect()
                    }
                    Some(q) => {
                        let custom = self.custom_emoji.borrow().clone().map(|f| f(&q.prefix)).unwrap_or_default();
                        custom
                            .into_iter()
                            .map(|code| {
                                let image = crate::markdown_view::custom_emoji(&code);
                                (format!(":{code}:"), q.start, format!(":{code}: "), image)
                            })
                            .chain(rv_core::emoji::complete(&q.prefix, 8).into_iter().map(|(code, glyph)| {
                                (format!("{glyph}  :{code}:"), q.start, format!("{glyph} "), None)
                            }))
                            .take(8)
                            .collect()
                    }
                    None => Vec::new(),
                }
            };
        while let Some(row) = self.choices.first_child() {
            self.choices.remove(&row);
        }
        if offered.is_empty() {
            self.offered.replace(Vec::new());
            self.completion.popdown();
            return;
        }
        for (label, _, _, preview) in &offered {
            let text = gtk::Label::builder().label(label).xalign(0.0).css_classes(["completion-item"]).build();
            match preview {
                Some(card) if card.has_css_class("mention-card") || card.has_css_class("command-choice") => {
                    self.choices.append(card)
                }
                Some(image) => {
                    image.set_tooltip_text(None);
                    let row = gtk::Box::builder().spacing(8).build();
                    row.append(image);
                    row.append(&text);
                    self.choices.append(&row);
                }
                None => self.choices.append(&text),
            }
        }
        self.offered.replace(offered.into_iter().map(|(_, start, insert, _)| (start, insert)).collect());
        self.select(0);
        self.completion.popup();
    }

    fn select(&self, index: i32) {
        if let Some(row) = self.choices.row_at_index(index) {
            self.choices.select_row(Some(&row));
        }
    }

    fn accept(&self, index: i32) {
        let Some((start, insert)) = self.offered.borrow().get(index as usize).cloned() else { return };
        self.completion.popdown();
        let buffer = self.text.buffer();
        let mut from = buffer.iter_at_offset(start as i32);
        let mut to = buffer.iter_at_offset(self.cursor_offset() as i32);
        buffer.delete(&mut from, &mut to);
        buffer.insert(&mut from, &insert);
        self.text.grab_focus();
    }

    /// The completion choices on offer, as shown.
    pub fn offered(&self) -> Vec<String> {
        self.offered.borrow().iter().map(|(_, insert)| insert.trim_end().to_owned()).collect()
    }

    pub fn accept_first(&self) {
        self.accept(0);
    }

    pub fn connect_submit(&self, f: impl Fn(String) + 'static) {
        self.on_submit.replace(Some(Rc::new(f)));
    }

    /// Arms a reply: the bar shows who and what, the send carries the quote.
    pub fn set_reply(&self, name: &str, preview: &str, permalink: String) {
        self.close_ordinary_quote();
        self.native_reply.replace(None);
        self.private_reply.replace(None);
        self.reply_title.set_label(&tf("composer.replying", &[("name", name)]));
        self.reply_preview.set_label(preview);
        self.reply_link.replace(Some(permalink));
        self.reply_bar.set_visible(true);
        self.grab_focus();
    }

    pub fn clear_reply(&self) {
        self.close_ordinary_quote();
        if let Some(access) = self.private_access.borrow().as_ref() {
            access.cancel_quote();
        }
        self.reply_link.replace(None);
        self.native_reply.replace(None);
        self.private_reply.replace(None);
        self.reply_title.set_label("");
        self.reply_preview.set_label("");
        self.reply_bar.set_visible(false);
    }

    pub fn set_native_reply(&self, name: &str, preview: &str, selection: rv_core::native::store::QuoteSelection) {
        self.set_reply(name, preview, String::new());
        self.reply_link.replace(None);
        self.native_reply.replace(Some(selection));
    }

    pub fn native_reply(&self) -> Option<rv_core::native::store::QuoteSelection> {
        self.native_reply.borrow().clone()
    }
    pub fn set_private_reply(&self, preview: rv_core::native::crypto::enrollment::rooms::messages::QuotePreview) {
        self.set_reply(&preview.author, &preview.text, String::new());
        self.reply_link.replace(None);
        self.private_reply.replace(Some(preview.selection));
    }
    pub fn private_reply(&self) -> Option<rv_core::native::crypto::enrollment::rooms::messages::QuoteSelection> {
        self.private_reply.borrow().clone()
    }
    pub fn quote_generation(&self) -> u64 {
        self.quote_author.epoch.get()
    }
    pub fn refresh_private_reply(
        &self,
        preview: Option<rv_core::native::crypto::enrollment::rooms::messages::QuotePreview>,
    ) {
        let Some(selected) = self.private_reply() else { return };
        match preview {
            Some(value) if value.selection == selected => {
                self.reply_title.set_label(&tf("composer.replying", &[("name", &value.author)]));
                self.reply_preview.set_label(&value.text);
            }
            None => self.clear_reply(),
            _ => (),
        }
    }

    pub fn validate_native_reply(self: &Rc<Self>, store: &rv_core::native::store::NativeStore) {
        self.refresh_ordinary_quote();
        if let Some(selected) = self.native_reply()
            && store.quote_selection(&selected.reference.room_id, &selected.reference.message_id).ok().as_ref()
                != Some(&selected)
        {
            self.reply_title.set_label(t("quote.unavailable"));
            self.reply_preview.set_label("");
        }
    }

    /// Sends as the Enter key would.
    pub fn submit_now(&self) {
        self.submit();
    }

    fn submit(&self) {
        if self.quote_author.sending.get()
            || (self.quote_author.busy.get() && self.quote_author.actor.borrow().is_none())
        {
            return;
        }
        let mut text = self.text();
        let files = !self.staged.is_empty();
        if text.trim().is_empty()
            && !files
            && self.native_reply.borrow().is_none()
            && self.private_reply.borrow().is_none()
        {
            return;
        }
        self.completion.popdown();
        if self.private_reply.borrow().is_none() || self.private_access.borrow().is_some() {
            self.text.buffer().set_text("");
        }
        if let Some(link) = self.reply_link.take() {
            text = rv_core::actions::quote(&link, text.trim());
            self.reply_bar.set_visible(false);
        }
        if files {
            let (items, original) = self.staged.take();
            if let Some(send) = self.on_send_files.borrow().clone() {
                send(Outgoing { items, caption: text, original });
            }
            return;
        }
        if let Some(submit) = self.on_submit.borrow().clone() {
            submit(text);
        }
    }

    /// Files staged in the composer, sent with the text as their caption.
    pub fn connect_send_files(&self, f: impl Fn(Outgoing) + 'static) {
        self.on_send_files.replace(Some(Rc::new(f)));
    }

    /// Adds files to those waiting to be sent.
    pub fn stage(&self, picked: Vec<Picked>) {
        if !self.attach.is_sensitive() {
            return;
        }
        self.staged.add(picked);
        self.grab_focus();
    }

    pub fn staged_names(&self) -> Vec<String> {
        self.staged.names()
    }

    pub fn grab_focus(&self) {
        self.text.grab_focus();
    }

    pub fn text(&self) -> String {
        let buffer = self.text.buffer();
        buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string()
    }

    pub fn set_text(&self, text: &str) {
        self.text.buffer().set_text(text);
    }

    /// Types at the cursor, as the keyboard would.
    pub fn type_text(&self, text: &str) {
        self.text.buffer().insert_at_cursor(text);
    }

    /// A composer inside a `GtkWindowHandle` turns a double click into "maximize".
    pub fn in_window_handle(&self) -> bool {
        self.text.ancestor(gtk::WindowHandle::static_type()).is_some()
    }

    /// (height of the scroller, its vertical scrollbar shown, scroll offset)
    pub fn scroll_state(&self) -> (i32, bool, f64) {
        let scroller = self.text.parent().and_downcast::<gtk::ScrolledWindow>().expect("composer scroller");
        let bar = scroller.vscrollbar();
        (scroller.height(), bar.is_visible() && bar.is_child_visible(), scroller.vadjustment().value())
    }
}

/// `/name params` over what the command does.
fn command_choice(command: &rv_core::commands::Command) -> gtk::Widget {
    let markup = match command.params.as_str() {
        "" => format!("<b>/{}</b>", glib::markup_escape_text(&command.name)),
        params => format!(
            "<b>/{}</b>  <span alpha=\"60%\">{}</span>",
            glib::markup_escape_text(&command.name),
            glib::markup_escape_text(params)
        ),
    };
    let choice = gtk::Box::builder().orientation(gtk::Orientation::Vertical).css_classes(["command-choice"]).build();
    choice.append(
        &gtk::Label::builder().label(markup).use_markup(true).xalign(0.0).css_classes(["completion-item"]).build(),
    );
    if !command.description.is_empty() {
        choice.append(
            &gtk::Label::builder()
                .label(&command.description)
                .xalign(0.0)
                .ellipsize(gtk::pango::EllipsizeMode::End)
                .max_width_chars(48)
                .css_classes(["command-description"])
                .build(),
        );
    }
    choice.upcast()
}

/// What each styled run of the draft looks like as it is typed.
fn style_tags(buffer: &gtk::TextBuffer) {
    let table = buffer.tag_table();
    let tag = |name: &str| gtk::TextTag::builder().name(name).build();
    let bold = tag("bold");
    bold.set_weight(800);
    let italic = tag("italic");
    italic.set_style(gtk::pango::Style::Italic);
    let strike = tag("strike");
    strike.set_strikethrough(true);
    let code = tag("code");
    code.set_family(Some("monospace"));
    code.set_background(Some("#2C2946"));
    let block = tag("codeblock");
    block.set_family(Some("monospace"));
    let heading = tag("heading");
    heading.set_weight(800);
    heading.set_scale(1.2);
    let quote = tag("quote");
    quote.set_foreground(Some("#C9C3E0"));
    quote.set_style(gtk::pango::Style::Italic);
    quote.set_left_margin(12);
    quote.set_paragraph_background(Some("#1E1B33"));
    let misspelled = tag("misspelled");
    misspelled.set_underline(gtk::pango::Underline::Error);
    misspelled.set_underline_rgba(Some(&gdk::RGBA::new(1.0, 0.48, 0.54, 1.0)));
    let marker = tag("marker");
    marker.set_foreground(Some("#6E6890"));
    let hidden = tag("hidden");
    hidden.set_invisible(true);
    for t in [bold, italic, strike, code, block, heading, quote, marker, misspelled, hidden] {
        table.add(&t);
    }
}

fn restyle(buffer: &gtk::TextBuffer) {
    let (start, end) = buffer.bounds();
    buffer.remove_all_tags(&start, &end);
    let text = buffer.text(&start, &end, false);
    for span in rv_core::compose::spans(&text) {
        use rv_core::compose::Style;
        let name = match span.style {
            Style::Bold => "bold",
            Style::Italic => "italic",
            Style::Strike => "strike",
            Style::Code => "code",
            Style::CodeBlock => "codeblock",
            Style::Heading => "heading",
            Style::Quote => "quote",
            Style::Marker => "marker",
        };
        let (from, to) = (buffer.iter_at_offset(span.start as i32), buffer.iter_at_offset(span.end as i32));
        buffer.apply_tag_by_name(name, &from, &to);
    }
    let cursor = buffer.cursor_position().max(0) as usize;
    for (start, end) in rv_core::compose::hidden_markers(&text, cursor) {
        let (from, to) = (buffer.iter_at_offset(start as i32), buffer.iter_at_offset(end as i32));
        buffer.apply_tag_by_name("hidden", &from, &to);
    }
    for (start, end) in rv_core::compose::words(&text) {
        let (from, to) = (buffer.iter_at_offset(start as i32), buffer.iter_at_offset(end as i32));
        if !crate::spell::check(&buffer.text(&from, &to, false)) {
            buffer.apply_tag_by_name("misspelled", &from, &to);
        }
    }
}

#[derive(Clone, Copy)]
enum Format {
    Wrap(&'static str),
    Lines(rv_core::compose::LineKind),
    CodeBlock,
    Link,
}

/// Applies a format to the selection (or at the cursor) and keeps it selected.
fn format(view: &gtk::TextView, format: Format) {
    let buffer = view.buffer();
    let (start, end) = buffer.selection_bounds().unwrap_or_else(|| {
        let cursor = buffer.iter_at_mark(&buffer.get_insert());
        (cursor, cursor)
    });
    let (start, end) = (start.offset() as usize, end.offset() as usize);
    let text = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string();
    let edited = match format {
        Format::Wrap(marker) => rv_core::compose::toggle_wrap(&text, start, end, marker),
        Format::Lines(kind) => rv_core::compose::toggle_lines(&text, start, end, kind),
        Format::CodeBlock => rv_core::compose::code_block(&text, start, end),
        Format::Link => rv_core::compose::link(&text, start, end),
    };
    buffer.begin_user_action();
    buffer.set_text(&edited.text);
    buffer.end_user_action();
    let (from, to) = (buffer.iter_at_offset(edited.start as i32), buffer.iter_at_offset(edited.end as i32));
    buffer.select_range(&from, &to);
    view.grab_focus();
}

fn toolbar(view: &gtk::TextView) -> gtk::Box {
    use rv_core::compose::LineKind;
    let bar = gtk::Box::builder().spacing(2).css_classes(["format-bar"]).build();
    let items: [(&str, Option<&str>, &str, Format); 10] = [
        ("format.bold", None, "<b>B</b>", Format::Wrap("*")),
        ("format.italic", None, "<i>I</i>", Format::Wrap("_")),
        ("format.strike", None, "<s>S</s>", Format::Wrap("~")),
        ("format.heading", None, "H", Format::Lines(LineKind::Heading)),
        ("format.link", None, "", Format::Link),
        ("format.code", None, "&lt;/&gt;", Format::Wrap("`")),
        ("format.code_block", None, "{ }", Format::CodeBlock),
        ("format.quote", None, "<span size=\"150%\">“</span>", Format::Lines(LineKind::Quote)),
        ("format.bullets", Some("view-list-bullet-symbolic"), "", Format::Lines(LineKind::Bullet)),
        ("format.numbers", Some("view-list-ordered-symbolic"), "", Format::Lines(LineKind::Numbered)),
    ];
    for (i, (tip, icon, text, action)) in items.into_iter().enumerate() {
        let button = gtk::Button::builder()
            .tooltip_text(t(tip))
            .css_classes(["flat", "format-button"])
            .focus_on_click(false)
            .build();
        match icon {
            Some(icon) => button.set_icon_name(icon),
            None if text.is_empty() => button.set_child(Some(&widgets::link_glyph())),
            None => button.set_child(Some(&gtk::Label::builder().label(text).use_markup(true).build())),
        }
        let view = view.clone();
        button.connect_clicked(move |_| format(&view, action));
        if i == 3 || i == 7 {
            bar.append(&gtk::Separator::new(gtk::Orientation::Vertical));
        }
        bar.append(&button);
    }
    bar
}

/// Right-click on a word the dictionaries do not know: their suggestions, and
/// "Add to dictionary", above the text view's own menu.
fn spell_menu(view: &gtk::TextView) {
    let group = gio::SimpleActionGroup::new();
    let replace = gio::SimpleAction::new("replace", Some(glib::VariantTy::STRING));
    replace.connect_activate(glib::clone!(
        #[weak]
        view,
        move |_, target| {
            let Some(target) = target.and_then(|v| v.get::<String>()) else { return };
            let mut parts = target.splitn(3, ':');
            let (Some(Ok(start)), Some(Ok(end)), Some(word)) =
                (parts.next().map(str::parse::<i32>), parts.next().map(str::parse::<i32>), parts.next())
            else {
                return;
            };
            let buffer = view.buffer();
            let (mut from, mut to) = (buffer.iter_at_offset(start), buffer.iter_at_offset(end));
            buffer.begin_user_action();
            buffer.delete(&mut from, &mut to);
            buffer.insert(&mut from, word);
            buffer.end_user_action();
        }
    ));
    group.add_action(&replace);
    let learn = gio::SimpleAction::new("learn", Some(glib::VariantTy::STRING));
    learn.connect_activate(glib::clone!(
        #[weak]
        view,
        move |_, word| {
            if let Some(word) = word.and_then(|v| v.get::<String>()) {
                crate::spell::learn(&word);
                restyle(&view.buffer());
            }
        }
    ));
    group.add_action(&learn);
    view.insert_action_group("spell", Some(&group));

    let click = gtk::GestureClick::builder()
        .button(gdk::BUTTON_SECONDARY)
        .propagation_phase(gtk::PropagationPhase::Capture)
        .build();
    click.connect_pressed(glib::clone!(
        #[weak]
        view,
        move |_, _, x, y| {
            let buffer = view.buffer();
            let (bx, by) = view.window_to_buffer_coords(gtk::TextWindowType::Widget, x as i32, y as i32);
            let at = view.iter_at_location(bx, by).map(|i| i.offset() as usize);
            let text = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string();
            let word = at.and_then(|at| rv_core::compose::words(&text).into_iter().find(|&(a, b)| at >= a && at < b));
            let word = word.map(|(a, b)| (a, b, text.chars().skip(a).take(b - a).collect::<String>()));
            let menu = word.filter(|(_, _, w)| !crate::spell::check(w)).map(|(a, b, w)| {
                let menu = gio::Menu::new();
                let suggestions = gio::Menu::new();
                for s in crate::spell::suggest(&w) {
                    let item = gio::MenuItem::new(Some(&s), None);
                    item.set_action_and_target_value(Some("spell.replace"), Some(&format!("{a}:{b}:{s}").to_variant()));
                    suggestions.append_item(&item);
                }
                if suggestions.n_items() == 0 {
                    suggestions.append(Some(t("spell.none")), Some("spell.nothing"));
                }
                menu.append_section(None, &suggestions);
                let learn = gio::MenuItem::new(Some(t("spell.learn")), None);
                learn.set_action_and_target_value(Some("spell.learn"), Some(&w.to_variant()));
                menu.append_item(&learn);
                menu
            });
            view.set_extra_menu(menu.as_ref());
        }
    ));
    view.add_controller(click);
}
