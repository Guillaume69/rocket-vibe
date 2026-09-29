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
    static SELECTED: std::cell::RefCell<glib::WeakRef<gtk::Widget>> = std::cell::RefCell::default();
}

/// Message text takes no keyboard focus, so the copy shortcut cannot reach
/// it: the last selection made in a message is remembered for it instead.
/// Only one selection shows at a time, as in a browser: an editor's own
/// selection is dropped.
fn selected(widget: &impl IsA<gtk::Widget>) {
    let widget = widget.upcast_ref::<gtk::Widget>();
    SELECTED.with_borrow(|s| s.set(Some(widget)));
    let focus = widget.root().and_then(|root| root.focus());
    if let Some(editor) = focus.as_ref().and_then(|f| f.downcast_ref::<gtk::TextView>()) {
        let buffer = editor.buffer();
        let at = buffer.iter_at_mark(&buffer.get_insert());
        buffer.select_range(&at, &at);
    } else if let Some(entry) = focus.as_ref().and_then(|f| f.downcast_ref::<gtk::Text>()) {
        let at = entry.position();
        entry.select_region(at, at);
    }
}

/// After a click or a drag in a message: the text under `widget`, if it
/// now holds a selection, is the one the copy shortcut takes; a click that
/// selected nothing drops the previous selection.
pub fn note_selection(widget: &gtk::Widget) {
    let text = std::iter::successors(Some(widget.clone()), |w| w.parent())
        .take(4)
        .find(|w| w.is::<gtk::Label>() || w.is::<gtk::TextView>())
        .filter(|text| match text.downcast_ref::<gtk::Label>() {
            Some(label) => label.selection_bounds().is_some_and(|(a, b)| a != b),
            None => text.downcast_ref::<gtk::TextView>().is_some_and(|v| v.buffer().has_selection()),
        });
    let previous = SELECTED.with_borrow(|s| s.upgrade());
    if previous.is_some() && previous != text {
        clear_selection();
        SELECTED.with_borrow(|s| s.set(None));
    }
    if let Some(text) = text {
        selected(&text);
    }
}

/// Drops the selection made in a message.
pub fn clear_selection() {
    let Some(widget) = SELECTED.with_borrow(|s| s.upgrade()) else { return };
    if let Some(label) = widget.downcast_ref::<gtk::Label>() {
        label.select_region(0, 0);
    } else if let Some(view) = widget.downcast_ref::<gtk::TextView>() {
        let start = view.buffer().start_iter();
        view.buffer().select_range(&start, &start);
    }
}

/// The text last selected in a message, while it is still on screen and selected.
pub fn selected_text() -> Option<String> {
    let widget = SELECTED.with_borrow(|s| s.upgrade()).filter(|w| w.is_mapped())?;
    if let Some(label) = widget.downcast_ref::<gtk::Label>() {
        let (a, b) = label.selection_bounds().filter(|(a, b)| a != b)?;
        let (a, b) = (a.min(b) as usize, a.max(b) as usize);
        return Some(label.text().chars().skip(a).take(b - a).collect());
    }
    let view = widget.downcast_ref::<gtk::TextView>()?;
    let (start, end) = view.buffer().selection_bounds()?;
    Some(view.buffer().text(&start, &end, false).to_string())
}

/// The image of a custom emoji, by shortcode; None when the server has no such emoji.
pub fn set_custom_emoji(f: impl Fn(&str) -> Option<gtk::Widget> + 'static) {
    CUSTOM_EMOJI.with_borrow_mut(|h| *h = Some(std::rc::Rc::new(f)));
}

pub fn custom_emoji(code: &str) -> Option<gtk::Widget> {
    CUSTOM_EMOJI.with_borrow(Clone::clone).and_then(|f| f(code))
}

/// Text with server emoji drawn inline, `emoji` pixels high: a label cannot
/// hold pictures, a read-only text view can. Styled from rv-core's runs.
fn rich(markup: &str, classes: &[&str], emoji: i32) -> gtk::Widget {
    let view = gtk::TextView::builder()
        .editable(false)
        .cursor_visible(false)
        .wrap_mode(gtk::WrapMode::WordChar)
        .focusable(false)
        .css_classes(classes.to_vec())
        .build();
    view.add_css_class("inline-images");
    let buffer = view.buffer();
    for run in rv_core::runs::runs(markup) {
        let mut end = buffer.end_iter();
        if let Some(code) = &run.custom_emoji
            && let Some(image) = custom_emoji(code)
        {
            image.set_size_request(emoji, emoji);
            let from = end.offset();
            let anchor = buffer.create_child_anchor(&mut end);
            view.add_child_at_anchor(&image, &anchor);
            if emoji < 30 && !classes.iter().any(|c| c.starts_with("md-h")) {
                buffer.apply_tag(&style_tag(&buffer, "sink"), &buffer.iter_at_offset(from), &buffer.end_iter());
            }
            continue;
        }
        let from = end.offset();
        buffer.insert(&mut end, &run.text);
        let (start, end) = (buffer.iter_at_offset(from), buffer.end_iter());
        let channel = run.link.as_deref().is_some_and(|l| l.starts_with("rv-room:"));
        let styles = [
            (run.bold || run.mention, "bold"),
            (run.italic, "italic"),
            (run.strike, "strike"),
            (run.code, "code"),
            (run.mention && !channel, "mention"),
            (run.mention && channel, "channel"),
            (run.highlight, "highlight"),
            (run.link.is_some() && !run.mention, "link"),
        ];
        for (on, name) in styles {
            if on {
                buffer.apply_tag(&style_tag(&buffer, name), &start, &end);
            }
        }
        if let Some(href) = &run.link {
            buffer.apply_tag(&link_tag(&buffer, href), &start, &end);
        }
    }
    with_view_links(&view);
    // A text view reports the height of its last layout, not the height for the
    // width it is being given: once laid out at its real width, ask again.
    view.connect_map(|view| {
        let view = view.downgrade();
        glib::timeout_add_local_once(std::time::Duration::from_millis(60), move || {
            if let Some(view) = view.upgrade() {
                view.queue_resize();
            }
        });
    });
    view.upcast()
}

fn style_tag(buffer: &gtk::TextBuffer, name: &str) -> gtk::TextTag {
    let table = buffer.tag_table();
    table.lookup(name).unwrap_or_else(|| {
        let tag = gtk::TextTag::new(Some(name));
        match name {
            "bold" => tag.set_weight(700),
            "italic" => tag.set_style(pango::Style::Italic),
            "strike" => tag.set_strikethrough(true),
            "code" => {
                tag.set_family(Some("monospace"));
                tag.set_background(Some("#1E1B33"));
            }
            "mention" => tag.set_foreground(Some("#FF7AB4")),
            "channel" => tag.set_foreground(Some("#A78BFA")),
            "highlight" => tag.set_background(Some("#4A2140")),
            "sink" => tag.set_rise(-5 * pango::SCALE),
            _ => tag.set_foreground(Some("#5CC8FF")),
        }
        table.add(&tag);
        tag
    })
}

fn link_tag(buffer: &gtk::TextBuffer, href: &str) -> gtk::TextTag {
    let table = buffer.tag_table();
    let name = format!("href:{href}");
    table.lookup(&name).unwrap_or_else(|| {
        let tag = gtk::TextTag::new(Some(&name));
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

/// A label, or a text view when server emoji are drawn in it.
fn body(markup: &str, classes: &[&str]) -> gtk::Widget {
    if markup.contains(rv_core::markdown::CUSTOM_MARK) {
        rich(markup, classes, 20)
    } else {
        text(markup, classes).upcast()
    }
}

fn block(b: &Block, extra: &[&str]) -> gtk::Widget {
    match b {
        Block::Paragraph(markup) => body(markup, &with("message-body", extra)),
        Block::Heading { level, markup } => body(markup, &with(&format!("md-h{level}"), extra)),
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
                row.set_baseline_position(gtk::BaselinePosition::Top);
                row.append(
                    &gtk::Label::builder()
                        .label(marker)
                        .valign(gtk::Align::BaselineFill)
                        .css_classes(with("message-body", extra))
                        .build(),
                );
                let item = body(markup, &with("message-body", extra));
                item.set_hexpand(true);
                item.set_valign(gtk::Align::BaselineFill);
                row.append(&item);
                list.append(&row);
            }
            list.upcast()
        }
        Block::BigEmoji(markup) if markup.contains(rv_core::markdown::CUSTOM_MARK) => {
            rich(markup, &["md-big-emoji"], 48)
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
        let trailing = run.iter().rev().take_while(|m| m.is_empty()).count();
        run.truncate(run.len() - trailing);
        if !run.is_empty() {
            body.append(&text(&run.join("\n"), &with("message-body", extra)));
            run.clear();
        }
        for _ in 0..trailing {
            body.append(&block(&Block::Break, extra));
        }
    };
    for b in blocks {
        match b {
            Block::Paragraph(markup) if !markup.contains(rv_core::markdown::CUSTOM_MARK) => run.push(markup),
            Block::Break if !run.is_empty() => run.push(""),
            _ => {
                flush(&mut run);
                body.append(&block(b, extra));
            }
        }
    }
    flush(&mut run);
    body
}
