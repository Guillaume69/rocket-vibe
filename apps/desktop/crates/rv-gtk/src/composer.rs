//! The message field: grows to `MAX_HEIGHT`, then scrolls; Enter sends,
//! Shift+Enter breaks the line.

use std::cell::RefCell;
use std::rc::Rc;

use gtk::prelude::*;
use gtk::{gdk, glib};

use crate::i18n::t;
use crate::widgets::{self, Handler};

const MAX_HEIGHT: i32 = 160;

pub struct Composer {
    pub root: gtk::Box,
    text: gtk::TextView,
    on_submit: Handler<String>,
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
        pill.append(&stack);
        let send = gtk::Button::builder()
            .child(&widgets::send_arrow())
            .tooltip_text(t("composer.send"))
            .css_classes(["send"])
            .valign(gtk::Align::End)
            .build();
        let root =
            gtk::Box::builder().spacing(10).margin_top(10).margin_bottom(12).margin_start(14).margin_end(14).build();
        root.append(&pill);
        root.append(&send);

        let this = Rc::new(Composer { root, text, on_submit: RefCell::default() });
        let weak = Rc::downgrade(&this);
        send.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.submit();
            }
        });
        let keys = gtk::EventControllerKey::new();
        let weak = Rc::downgrade(&this);
        keys.connect_key_pressed(move |_, key, _, state| {
            let enter = key == gdk::Key::Return || key == gdk::Key::KP_Enter;
            if !enter || state.contains(gdk::ModifierType::SHIFT_MASK) {
                return glib::Propagation::Proceed;
            }
            if let Some(this) = weak.upgrade() {
                this.submit();
            }
            glib::Propagation::Stop
        });
        this.text.add_controller(keys);
        this
    }

    pub fn connect_submit(&self, f: impl Fn(String) + 'static) {
        self.on_submit.replace(Some(Rc::new(f)));
    }

    fn submit(&self) {
        let text = self.text();
        if text.trim().is_empty() {
            return;
        }
        self.text.buffer().set_text("");
        if let Some(submit) = self.on_submit.borrow().clone() {
            submit(text);
        }
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
