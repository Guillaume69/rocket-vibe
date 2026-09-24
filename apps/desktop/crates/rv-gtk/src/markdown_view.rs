//! Widgets for rv-core's markdown blocks.

use gtk::prelude::*;
use gtk::{glib, pango};
use rv_core::markdown::Block;

type LinkHandler = std::rc::Rc<dyn Fn(&str) -> bool>;
type EmojiImage = std::rc::Rc<dyn Fn(&str) -> Option<gtk::Widget>>;

thread_local! {
    static LINKS: std::cell::RefCell<Option<LinkHandler>> = const { std::cell::RefCell::new(None) };
    static CUSTOM_EMOJI: std::cell::RefCell<Option<EmojiImage>> = const { std::cell::RefCell::new(None) };
}

/// The image of a custom emoji, by shortcode; None when the server has no such emoji.
pub fn set_custom_emoji(f: impl Fn(&str) -> Option<gtk::Widget> + 'static) {
    CUSTOM_EMOJI.with_borrow_mut(|h| *h = Some(std::rc::Rc::new(f)));
}

pub fn custom_emoji(code: &str) -> Option<gtk::Widget> {
    CUSTOM_EMOJI.with_borrow(Clone::clone).and_then(|f| f(code))
}

/// Text with custom emoji drawn inline: a label cannot hold pictures, a
/// read-only text view can.
fn with_images(markup: &str, classes: &[&str]) -> gtk::Widget {
    let view = gtk::TextView::builder()
        .editable(false)
        .cursor_visible(false)
        .wrap_mode(gtk::WrapMode::WordChar)
        .focusable(false)
        .css_classes(classes.to_vec())
        .build();
    view.add_css_class("inline-images");
    let buffer = view.buffer();
    for piece in rv_core::markdown::pieces(markup) {
        let mut end = buffer.end_iter();
        match piece {
            rv_core::markdown::Piece::Markup(m) => buffer.insert_markup(&mut end, m),
            rv_core::markdown::Piece::Custom(code) => match custom_emoji(code) {
                Some(image) => {
                    let anchor = buffer.create_child_anchor(&mut end);
                    view.add_child_at_anchor(&image, &anchor);
                }
                None => buffer.insert(&mut end, &format!(":{code}:")),
            },
        }
    }
    view.upcast()
}

/// Our own links (`rv-user:`, `rv-room:`): the handler says whether it took one.
pub fn set_link_handler(f: impl Fn(&str) -> bool + 'static) {
    LINKS.with_borrow_mut(|h| *h = Some(std::rc::Rc::new(f)));
}

fn text(markup: &str, classes: &[&str]) -> gtk::Label {
    let label = gtk::Label::builder()
        .use_markup(true)
        .label(markup)
        .xalign(0.0)
        .wrap(true)
        .wrap_mode(pango::WrapMode::WordChar)
        .selectable(true)
        .css_classes(classes.to_vec())
        .build();
    label.set_focusable(false);
    label.connect_activate_link(|_, uri| {
        let handler = LINKS.with_borrow(Clone::clone);
        if handler.is_some_and(|h| h(uri)) { glib::Propagation::Stop } else { glib::Propagation::Proceed }
    });
    label
}

fn with<'a>(base: &'a str, extra: &[&'a str]) -> Vec<&'a str> {
    std::iter::once(base).chain(extra.iter().copied()).collect()
}

fn block(b: &Block, extra: &[&str]) -> gtk::Widget {
    match b {
        Block::Paragraph(markup) if markup.contains(rv_core::markdown::CUSTOM_MARK) => {
            with_images(markup, &with("message-body", extra))
        }
        Block::Paragraph(markup) => text(markup, &with("message-body", extra)).upcast(),
        Block::Heading { level, markup } => text(markup, &with(&format!("md-h{level}"), extra)).upcast(),
        Block::Quote(inner) => {
            let quote = gtk::Box::builder()
                .orientation(gtk::Orientation::Vertical)
                .spacing(2)
                .css_classes(["md-quote"])
                .build();
            for b in inner {
                quote.append(&block(b, extra));
            }
            quote.upcast()
        }
        Block::Code(code) => {
            let label = gtk::Label::builder()
                .label(code)
                .xalign(0.0)
                .wrap(true)
                .wrap_mode(pango::WrapMode::Char)
                .selectable(true)
                .css_classes(["md-code-text"])
                .build();
            let frame = gtk::Box::builder().css_classes(["md-code"]).build();
            frame.append(&label);
            frame.upcast()
        }
        Block::List(items) => {
            let list = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).build();
            for (marker, markup) in items {
                let row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
                row.append(
                    &gtk::Label::builder()
                        .label(marker)
                        .valign(gtk::Align::Start)
                        .css_classes(with("message-body", extra))
                        .build(),
                );
                let item = text(markup, &with("message-body", extra));
                item.set_hexpand(true);
                row.append(&item);
                list.append(&row);
            }
            list.upcast()
        }
        Block::BigEmoji(glyphs) => {
            gtk::Label::builder().label(glyphs).xalign(0.0).css_classes(["md-big-emoji"]).build().upcast()
        }
        Block::Break => gtk::Box::builder().height_request(8).build().upcast(),
    }
}

/// The message body; `extra` classes (pending, failed) apply to its text.
pub fn view(blocks: &[Block], extra: &[&str]) -> gtk::Box {
    let body = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).build();
    for b in blocks {
        body.append(&block(b, extra));
    }
    body
}
