//! Widgets for rv-core's markdown blocks.

use gtk::prelude::*;
use gtk::{glib, pango};
use rv_core::markdown::Block;

type LinkHandler = std::rc::Rc<dyn Fn(&str) -> bool>;
type EmojiImage = std::rc::Rc<dyn Fn(&str) -> Option<gtk::Widget>>;

thread_local! {
    static LINKS: std::cell::RefCell<Option<LinkHandler>> = const { std::cell::RefCell::new(None) };
    static CUSTOM_EMOJI: std::cell::RefCell<Option<EmojiImage>> = const { std::cell::RefCell::new(None) };
    static MENTION_PREVIEW: std::cell::RefCell<Option<EmojiImage>> = const { std::cell::RefCell::new(None) };
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
            rv_core::markdown::Piece::Markup(m) => {
                for (run, href) in rv_core::markdown::link_runs(m) {
                    let mut end = buffer.end_iter();
                    let from = end.offset();
                    buffer.insert_markup(&mut end, &run);
                    if let Some(href) = href {
                        buffer.apply_tag(&link_tag(&buffer, &href), &buffer.iter_at_offset(from), &buffer.end_iter());
                    }
                }
            }
            rv_core::markdown::Piece::Custom(code) => match custom_emoji(code) {
                Some(image) => {
                    let anchor = buffer.create_child_anchor(&mut end);
                    view.add_child_at_anchor(&image, &anchor);
                }
                None => buffer.insert(&mut end, &format!(":{code}:")),
            },
        }
    }
    with_view_links(&view);
    view.upcast()
}

fn link_tag(buffer: &gtk::TextBuffer, href: &str) -> gtk::TextTag {
    let table = buffer.tag_table();
    let name = format!("href:{href}");
    table.lookup(&name).unwrap_or_else(|| {
        let tag = gtk::TextTag::builder().name(&name).foreground("#5CC8FF").build();
        table.add(&tag);
        tag
    })
}

fn view_iter(view: &gtk::TextView, x: f64, y: f64) -> Option<gtk::TextIter> {
    let (bx, by) = view.window_to_buffer_coords(gtk::TextWindowType::Widget, x as i32, y as i32);
    view.iter_at_location(bx, by)
}

fn href_at(iter: &gtk::TextIter) -> Option<String> {
    iter.tags().iter().find_map(|tag| tag.name()?.strip_prefix("href:").map(str::to_owned))
}

/// A text view's links open and preview as a label's do.
fn with_view_links(view: &gtk::TextView) {
    let click = gtk::GestureClick::new();
    click.connect_released(|gesture, _, x, y| {
        let Some(view) = gesture.widget().and_downcast::<gtk::TextView>() else { return };
        if view.buffer().has_selection() {
            return;
        }
        let Some(href) = view_iter(&view, x, y).as_ref().and_then(href_at) else { return };
        let handler = LINKS.with_borrow(Clone::clone);
        if !handler.is_some_and(|h| h(&href)) {
            crate::cards::open_uri(&view, &href);
        }
    });
    view.add_controller(click);
    view.set_has_tooltip(true);
    view.connect_query_tooltip(|view, x, y, _, tooltip| {
        let Some(iter) = view_iter(view, x as f64, y as f64) else { return false };
        if let Some(href) = href_at(&iter) {
            if let Some(card) = href.strip_prefix("rv-user:").and_then(mention_preview) {
                tooltip.set_custom(Some(&card));
                return true;
            }
            tooltip.set_text(Some(&href));
            return true;
        }
        let buffer = view.buffer();
        let text = buffer.slice(&buffer.start_iter(), &buffer.end_iter(), true);
        let Some((index, _)) = text.char_indices().nth(iter.offset().max(0) as usize) else { return false };
        match rv_core::emoji::at(&text, index) {
            Some((glyph, code)) => {
                tooltip.set_markup(Some(&format!(
                    "<span size=\"300%\">{}</span>\n:{}:",
                    glib::markup_escape_text(glyph),
                    glib::markup_escape_text(code)
                )));
                true
            }
            None => false,
        }
    });
}

/// The card shown over a `@mention`, by username.
pub fn set_mention_preview(f: impl Fn(&str) -> Option<gtk::Widget> + 'static) {
    MENTION_PREVIEW.with_borrow_mut(|h| *h = Some(std::rc::Rc::new(f)));
}

/// A server emoji, large, with its shortcode.
pub fn emoji_card(texture: &gtk::gdk::Texture, code: &str) -> gtk::Widget {
    let card = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).build();
    card.append(
        &gtk::Picture::builder()
            .paintable(texture)
            .content_fit(gtk::ContentFit::Contain)
            .width_request(64)
            .height_request(64)
            .build(),
    );
    card.append(&gtk::Label::new(Some(&format!(":{code}:"))));
    card.upcast()
}

/// A person's card, as a mention's hover shows it.
pub fn mention_preview(username: &str) -> Option<gtk::Widget> {
    MENTION_PREVIEW.with_borrow(Clone::clone).and_then(|f| f(username))
}

/// Hovering an emoji shows it large with its shortcode; hovering a mention, its card.
fn with_previews(label: &gtk::Label) {
    label.set_has_tooltip(true);
    label.connect_query_tooltip(|label, x, y, _, tooltip| {
        let layout = label.layout();
        let (dx, dy) = label.layout_offsets();
        let (inside, index, _) = layout.xy_to_index((x - dx) * pango::SCALE, (y - dy) * pango::SCALE);
        if !inside {
            return false;
        }
        let index = index as usize;
        if let Some(link) = rv_core::markdown::link_at(&label.label(), index) {
            let card = link.strip_prefix("rv-user:").and_then(mention_preview);
            if let Some(card) = card {
                tooltip.set_custom(Some(&card));
                return true;
            }
            return false;
        }
        match rv_core::emoji::at(&layout.text(), index) {
            Some((glyph, code)) => {
                tooltip.set_markup(Some(&format!(
                    "<span size=\"300%\">{}</span>\n:{}:",
                    glib::markup_escape_text(glyph),
                    glib::markup_escape_text(code)
                )));
                true
            }
            None => false,
        }
    });
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
    with_previews(&label);
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
            let label = gtk::Label::builder().label(glyphs).xalign(0.0).css_classes(["md-big-emoji"]).build();
            with_previews(&label);
            label.upcast()
        }
        Block::Break => gtk::Box::builder().height_request(8).build().upcast(),
    }
}

/// The message body; `extra` classes (pending, failed) apply to its text.
/// Consecutive plain paragraphs share one label, so the mouse selects across
/// their lines.
pub fn view(blocks: &[Block], extra: &[&str]) -> gtk::Box {
    let body = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).build();
    let mut run: Vec<&str> = Vec::new();
    let flush = |run: &mut Vec<&str>| {
        if !run.is_empty() {
            body.append(&text(&run.join("\n"), &with("message-body", extra)));
            run.clear();
        }
    };
    for b in blocks {
        match b {
            Block::Paragraph(markup) if !markup.contains(rv_core::markdown::CUSTOM_MARK) => run.push(markup),
            _ => {
                flush(&mut run);
                body.append(&block(b, extra));
            }
        }
    }
    flush(&mut run);
    body
}
