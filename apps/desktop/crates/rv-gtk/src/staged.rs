//! Files waiting in the composer before they are sent: a chip each (thumbnail,
//! name, type and size, remove), a click on it to preview, and the choice of
//! the images' quality. They leave with the text typed, as its caption.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gtk::prelude::*;
use gtk::{gdk, pango};
use rv_core::content::human_size;

use crate::attach::{Picked, mime_of};
use crate::i18n::t;

type Batch = (Vec<(Picked, String)>, bool);

pub struct Staged {
    pub root: gtk::Box,
    chips: gtk::FlowBox,
    original: gtk::CheckButton,
    items: RefCell<Vec<(Picked, String)>>,
    key: RefCell<String>,
    parked: RefCell<HashMap<String, Batch>>,
}

/// The file's kind as people know it: its extension, else the MIME subtype.
fn kind_label(name: &str, mime: &str) -> String {
    let extension = std::path::Path::new(name).extension().and_then(|e| e.to_str()).filter(|e| e.len() <= 5);
    let subtype = mime.rsplit('/').next().unwrap_or(mime).trim_start_matches("x-");
    extension.unwrap_or(subtype).to_uppercase()
}

impl Staged {
    pub fn new() -> Rc<Self> {
        let chips = gtk::FlowBox::builder()
            .selection_mode(gtk::SelectionMode::None)
            .column_spacing(8)
            .row_spacing(8)
            .max_children_per_line(6)
            .homogeneous(false)
            .build();
        let original = gtk::CheckButton::builder().label(t("attach.original")).visible(false).build();
        original.add_css_class("staged-quality");
        let root = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(6)
            .css_classes(["staged"])
            .visible(false)
            .build();
        root.append(&chips);
        root.append(&original);
        Rc::new(Staged {
            root,
            chips,
            original,
            items: RefCell::default(),
            key: RefCell::default(),
            parked: RefCell::default(),
        })
    }

    pub fn add(self: &Rc<Self>, picked: Vec<Picked>) {
        for item in picked {
            let mime = mime_of(&item.path);
            self.items.borrow_mut().push((item, mime));
        }
        self.rebuild();
    }

    pub fn is_empty(&self) -> bool {
        self.items.borrow().is_empty()
    }

    /// What goes, and whether images keep their original quality; the strip empties.
    pub fn take(self: &Rc<Self>) -> (Vec<(Picked, String)>, bool) {
        let items = std::mem::take(&mut *self.items.borrow_mut());
        let original = self.original.is_active();
        self.rebuild();
        (items, original)
    }

    /// Files staged for one room or thread wait there while another is open.
    pub fn switch(self: &Rc<Self>, key: &str) {
        let previous = self.key.replace(key.to_owned());
        if previous == key {
            return;
        }
        let items = std::mem::take(&mut *self.items.borrow_mut());
        if !items.is_empty() {
            self.parked.borrow_mut().insert(previous, (items, self.original.is_active()));
        }
        let (items, original) = self.parked.borrow_mut().remove(key).unwrap_or_default();
        *self.items.borrow_mut() = items;
        self.original.set_active(original);
        self.rebuild();
    }

    pub fn names(&self) -> Vec<String> {
        self.items.borrow().iter().map(|(p, _)| p.name.clone()).collect()
    }

    fn rebuild(self: &Rc<Self>) {
        self.chips.remove_all();
        let items = self.items.borrow().clone();
        for (index, (item, mime)) in items.iter().enumerate() {
            let weak = Rc::downgrade(self);
            let remove = move || {
                let Some(this) = weak.upgrade() else { return };
                let removed = this.items.borrow_mut().remove(index);
                if removed.0.temporary {
                    let _ = std::fs::remove_file(&removed.0.path);
                }
                this.rebuild();
            };
            self.chips.insert(&chip(item, mime, remove), -1);
        }
        self.original.set_visible(items.iter().any(|(_, mime)| mime.starts_with("image/")));
        self.root.set_visible(!items.is_empty());
    }
}

fn chip(item: &Picked, mime: &str, on_remove: impl Fn() + 'static) -> gtk::Widget {
    let chip = gtk::Box::builder().spacing(10).css_classes(["staged-chip"]).build();
    let thumb = gtk::Overlay::builder()
        .width_request(40)
        .height_request(40)
        .overflow(gtk::Overflow::Hidden)
        .css_classes(["staged-thumb"])
        .valign(gtk::Align::Center)
        .build();
    thumb.set_child(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
    let texture = mime.starts_with("image/").then(|| gdk::Texture::from_filename(&item.path).ok()).flatten();
    let audio = mime.starts_with("audio/");
    match &texture {
        Some(texture) => thumb.add_overlay(
            &gtk::Picture::builder().paintable(texture).content_fit(gtk::ContentFit::Cover).can_shrink(true).build(),
        ),
        None => thumb.add_overlay(
            &gtk::Image::builder()
                .icon_name(if audio { "audio-x-generic-symbolic" } else { "text-x-generic-symbolic" })
                .pixel_size(22)
                .css_classes(["staged-icon"])
                .build(),
        ),
    }
    chip.append(&thumb);
    let names = gtk::Box::builder().orientation(gtk::Orientation::Vertical).valign(gtk::Align::Center).build();
    let name = gtk::Label::builder()
        .label(&item.name)
        .xalign(0.0)
        .max_width_chars(22)
        .ellipsize(pango::EllipsizeMode::Middle)
        .css_classes(["file-title"])
        .build();
    names.append(&name);
    let size = std::fs::metadata(&item.path).map(|m| human_size(m.len() as i64)).unwrap_or_default();
    names.append(
        &gtk::Label::builder()
            .label(format!("{} {size}", kind_label(&item.name, mime)))
            .xalign(0.0)
            .css_classes(["file-detail"])
            .build(),
    );
    chip.append(&names);
    // A recording (or any sound) is listened to here, before it goes.
    let player = audio.then(|| audio_toggle(&item.path));
    if let Some(button) = &player {
        chip.append(button);
    }
    chip.set_cursor(gdk::Cursor::from_name("pointer", None).as_ref());
    chip.set_tooltip_text(Some(t("attach.preview")));
    let click = gtk::GestureClick::new();
    let (path, title) = (item.path.clone(), item.name.clone());
    click.connect_released(move |gesture, _, _, _| {
        let Some(widget) = gesture.widget() else { return };
        match (&texture, &player) {
            (Some(texture), _) => crate::rows::open_viewer(&widget, texture, &title, None),
            (None, Some(button)) => button.emit_clicked(),
            (None, None) => crate::cards::open_file(&widget, &path, || {}),
        }
    });
    chip.add_controller(click);
    let remove = gtk::Button::builder()
        .icon_name("window-close-symbolic")
        .tooltip_text(t("attach.remove"))
        .css_classes(["flat", "circular"])
        .valign(gtk::Align::Center)
        .build();
    remove.connect_clicked(move |_| on_remove());
    chip.append(&remove);
    chip.upcast()
}

/// Play / pause of a staged sound, its stream made on the first play and
/// paused when the chip goes.
fn audio_toggle(path: &std::path::Path) -> gtk::Button {
    let button = gtk::Button::builder()
        .icon_name("media-playback-start-symbolic")
        .tooltip_text(t("voice.play"))
        .css_classes(["flat", "circular"])
        .valign(gtk::Align::Center)
        .build();
    let stream: Rc<RefCell<Option<gtk::MediaStream>>> = Rc::default();
    let (path, shared) = (path.to_owned(), stream.clone());
    button.connect_clicked(move |button| {
        let mut slot = shared.borrow_mut();
        let stream = slot.get_or_insert_with(|| {
            let stream = crate::gst_stream::for_file(&path);
            let weak = button.downgrade();
            stream.connect_playing_notify(move |s| {
                if let Some(button) = weak.upgrade() {
                    button.set_icon_name(if s.is_playing() {
                        "media-playback-pause-symbolic"
                    } else {
                        "media-playback-start-symbolic"
                    });
                }
            });
            stream
        });
        if stream.is_playing() {
            stream.pause();
        } else {
            if stream.is_ended() {
                stream.seek(0);
            }
            stream.play();
        }
    });
    button.connect_unrealize(move |_| {
        if let Some(stream) = stream.borrow().as_ref() {
            stream.pause();
        }
    });
    button
}
