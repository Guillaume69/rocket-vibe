//! A list of messages, newest at the bottom, shared by rooms and threads.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gtk::prelude::*;
use gtk::{gio, glib};
use rv_core::diff::diff_sorted;
use rv_core::session::Session;
use rv_core::store::MessageRow;

use crate::i18n::t;
use crate::rows::{self, Display, RowEvent};
use crate::widgets::Handler;

pub type Shared<T> = Rc<RefCell<Option<T>>>;

/// A place in a message's text: which of its texts, and how many characters in.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Point {
    id: String,
    text: usize,
    offset: i32,
}

/// A selection dragged across messages, from where it started to the pointer.
#[derive(Debug, Clone)]
struct Span {
    anchor: Point,
    focus: Point,
}

/// A place in reading order: row, text in it, character in that.
type Place = (usize, usize, i32);

/// Distance from the list's edge where a selection being dragged scrolls it.
const EDGE: f64 = 28.0;

fn is_text(widget: &gtk::Widget) -> bool {
    widget.downcast_ref::<gtk::Label>().is_some_and(|l| l.is_selectable())
        || widget.downcast_ref::<gtk::TextView>().is_some_and(|v| !v.is_editable())
}

/// A row's texts, in reading order.
fn texts(row: &gtk::Widget) -> Vec<gtk::Widget> {
    let mut out = Vec::new();
    let mut stack = vec![row.clone()];
    while let Some(widget) = stack.pop() {
        if is_text(&widget) {
            out.push(widget);
            continue;
        }
        let children: Vec<gtk::Widget> = std::iter::successors(widget.first_child(), |c| c.next_sibling()).collect();
        stack.extend(children.into_iter().rev());
    }
    out
}

fn words(text: &gtk::Widget) -> String {
    match text.downcast_ref::<gtk::Label>() {
        Some(label) => label.text().to_string(),
        None => text.downcast_ref::<gtk::TextView>().map_or_else(String::new, |v| {
            let buffer = v.buffer();
            buffer.slice(&buffer.start_iter(), &buffer.end_iter(), true).to_string()
        }),
    }
}

/// A text's words and the codes of the server emoji in it.
type Segment = (String, Vec<String>);

/// A text's words, a server emoji standing as U+FFFC as in the text view, and
/// the emoji's `:code:` for each, in order, for copying.
fn segment(text: &gtk::Widget) -> Segment {
    let shown = words(text);
    let Some(view) = text.downcast_ref::<gtk::TextView>() else { return (shown, Vec::new()) };
    let buffer = view.buffer();
    let mut codes = Vec::new();
    let mut iter = buffer.start_iter();
    loop {
        if let Some(anchor) = iter.child_anchor() {
            let code = anchor.widgets().first().and_then(|w| w.tooltip_text()).map(|t| t.to_string());
            codes.push(code.unwrap_or_default());
        }
        if !iter.forward_char() {
            break;
        }
    }
    (shown, codes)
}

/// Characters `start..end` of a segment as they read: emoji by their code.
fn copied(segment: &Segment, start: i32, end: i32) -> String {
    let (shown, codes) = segment;
    let mut code = shown.chars().take(start as usize).filter(|&c| c == '\u{FFFC}').count();
    let mut out = String::new();
    for c in shown.chars().skip(start as usize).take((end - start) as usize) {
        if c == '\u{FFFC}' {
            out.push_str(codes.get(code).map_or(":?:", String::as_str));
            code += 1;
        } else {
            out.push(c);
        }
    }
    out
}

/// The selection's colour over the window's, as GTK draws a selection.
const SPAN_COLOR: (u16, u16, u16) = (0x2828, 0x4d4d, 0x6868);

fn is_span_attribute(attribute: &gtk::pango::Attribute) -> bool {
    attribute.downcast_ref::<gtk::pango::AttrColor>().is_some_and(|c| {
        let color = c.color();
        attribute.type_() == gtk::pango::AttrType::Background
            && (color.red(), color.green(), color.blue()) == SPAN_COLOR
    })
}

/// Marks `range` (characters) of a text as selected, or none of it. Only one
/// label at a time may hold GTK's own selection (it is the system's primary
/// selection), so a selection across texts is drawn rather than made.
fn highlight(text: &gtk::Widget, range: Option<(i32, i32)>) {
    if let Some(label) = text.downcast_ref::<gtk::Label>() {
        let attributes = label.attributes().and_then(|a| a.copy()).unwrap_or_default();
        let marked = !attributes.filter(is_span_attribute).map(|m| m.attributes().is_empty()).unwrap_or(true);
        if marked {
            // GTK merges a label's attributes into those its markup made, in
            // place: only parsing the markup again takes a highlight away.
            let markup = label.label();
            label.set_label("");
            label.set_label(&markup);
        }
        if let Some((start, end)) = range {
            let shown = label.text();
            let byte = |chars: i32| shown.char_indices().nth(chars as usize).map_or(shown.len(), |(i, _)| i) as u32;
            let mut color = gtk::pango::AttrColor::new_background(SPAN_COLOR.0, SPAN_COLOR.1, SPAN_COLOR.2);
            color.set_start_index(byte(start));
            color.set_end_index(byte(end));
            attributes.insert(color);
        }
        if marked || range.is_some() {
            label.set_attributes(Some(&attributes));
        }
    } else if let Some(view) = text.downcast_ref::<gtk::TextView>() {
        let buffer = view.buffer();
        let table = buffer.tag_table();
        let tag = table.lookup("spanned").unwrap_or_else(|| {
            let tag = gtk::TextTag::builder().name("spanned").background("#284D68").build();
            table.add(&tag);
            tag
        });
        buffer.remove_tag(&tag, &buffer.start_iter(), &buffer.end_iter());
        if let Some((start, end)) = range {
            buffer.apply_tag(&tag, &buffer.iter_at_offset(start), &buffer.iter_at_offset(end));
        }
    }
}

/// Drops GTK's own selection in a text.
fn unselect(text: &gtk::Widget) {
    if let Some(label) = text.downcast_ref::<gtk::Label>() {
        label.select_region(0, 0);
    } else if let Some(view) = text.downcast_ref::<gtk::TextView>() {
        let buffer = view.buffer();
        let at = buffer.start_iter();
        buffer.select_range(&at, &at);
    }
}

/// The character under `(x, y)` of `text`, in its own coordinates.
fn offset_at(text: &gtk::Widget, x: f64, y: f64) -> i32 {
    if let Some(label) = text.downcast_ref::<gtk::Label>() {
        let layout = label.layout();
        let (dx, dy) = label.layout_offsets();
        let (_, index, trailing) = layout.xy_to_index(
            ((x - dx as f64) * gtk::pango::SCALE as f64) as i32,
            ((y - dy as f64) * gtk::pango::SCALE as f64) as i32,
        );
        let shown = layout.text();
        let index = (index.max(0) as usize).min(shown.len());
        return (shown[..index].chars().count() as i32 + trailing).min(shown.chars().count() as i32);
    }
    let Some(view) = text.downcast_ref::<gtk::TextView>() else { return 0 };
    let (bx, by) = view.window_to_buffer_coords(gtk::TextWindowType::Widget, x as i32, y as i32);
    view.iter_at_location(bx, by).map_or_else(|| view.buffer().char_count(), |iter| iter.offset())
}

pub struct MessageList {
    /// The scroller, with the button back to the latest message over it.
    pub root: gtk::Overlay,
    scroll: gtk::ScrolledWindow,
    jump: gtk::Button,
    /// The row built for each message on screen, and the texts each message
    /// showed last, for copying a selection that ran past the screen.
    bound: RefCell<HashMap<String, gtk::Widget>>,
    seen: RefCell<HashMap<String, Vec<Segment>>>,
    /// Where the button went down in a text, and the selection once it
    /// left that text for another.
    press: RefCell<Option<Point>>,
    press_at: Cell<Option<(f64, f64)>>,
    span: RefCell<Option<Span>>,
    spanning: Cell<bool>,
    pointer: Cell<(f64, f64)>,
    scroller: RefCell<Option<glib::SourceId>>,
    view: gtk::ListView,
    store: gio::ListStore,
    rows: RefCell<Vec<Display>>,
    pinned: Rc<Cell<bool>>,
    /// Refreshes whose scroll adjustments are ours, not the user's.
    settling: Rc<Cell<u32>>,
    on_event: Handler<RowEvent>,
    on_top: Handler<()>,
    /// (last seen, my uid): the first later message from someone else gets the marker.
    unread_after: RefCell<Option<(i64, String)>>,
    session: Shared<Arc<Session>>,
    /// The message being edited in place and its draft, kept across row rebuilds.
    editing: RefCell<Option<(String, gtk::TextBuffer)>>,
    /// A message to scroll to once it is loaded.
    revealing: RefCell<Option<String>>,
    /// The message marked by the last reveal.
    highlighted: RefCell<Option<String>>,
    native_me: RefCell<String>,
}

impl MessageList {
    /// The existing renderer, preserving native server sequence order.
    pub fn set_native_rows(self: &Rc<Self>, fresh: Vec<MessageRow>, me: &str) {
        let fresh = rows::group(fresh);
        if *self.rows.borrow() == fresh {
            return;
        }
        self.native_me.replace(me.to_owned());
        let old = self.rows.replace(fresh.clone());
        let prefix = old.iter().zip(&fresh).take_while(|(a, b)| a == b).count();
        let suffix = old[prefix..].iter().rev().zip(fresh[prefix..].iter().rev()).take_while(|(a, b)| a == b).count();
        let objects: Vec<_> =
            fresh[prefix..fresh.len() - suffix].iter().cloned().map(glib::BoxedAnyObject::new).collect();
        self.settling.set(self.settling.get() + 1);
        self.store.splice(prefix as u32, (old.len() - prefix - suffix) as u32, &objects);
        if self.pinned.get() {
            self.scroll_to_bottom();
        }
        let (view, store, pinned, settling) =
            (self.view.clone(), self.store.clone(), self.pinned.clone(), self.settling.clone());
        glib::timeout_add_local_once(std::time::Duration::from_millis(120), move || {
            let n = store.n_items();
            if pinned.get() && n > 0 {
                view.scroll_to(n - 1, gtk::ListScrollFlags::NONE, None);
            }
            settling.set(settling.get() - 1);
        });
    }
    pub fn new(session: Shared<Arc<Session>>) -> Rc<Self> {
        let store = gio::ListStore::new::<glib::BoxedAnyObject>();
        let view = gtk::ListView::new(Some(gtk::NoSelection::new(Some(store.clone()))), None::<gtk::ListItemFactory>);
        view.set_vscroll_policy(gtk::ScrollablePolicy::Natural);
        let scroll =
            gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&view).build();
        let jump = gtk::Button::builder()
            .icon_name("go-bottom-symbolic")
            .tooltip_text(t("room.latest"))
            .css_classes(["jump-latest", "circular"])
            .halign(gtk::Align::End)
            .valign(gtk::Align::End)
            .margin_end(18)
            .margin_bottom(12)
            .visible(false)
            .build();
        let root = gtk::Overlay::builder().child(&scroll).build();
        root.add_overlay(&jump);
        let this = Rc::new(MessageList {
            root,
            scroll,
            jump,
            bound: RefCell::default(),
            seen: RefCell::default(),
            press: RefCell::default(),
            press_at: Cell::new(None),
            span: RefCell::default(),
            spanning: Cell::new(false),
            pointer: Cell::new((0.0, 0.0)),
            scroller: RefCell::default(),
            view,
            store,
            rows: RefCell::default(),
            pinned: Rc::new(Cell::new(true)),
            settling: Rc::new(Cell::new(0)),
            on_event: RefCell::default(),
            on_top: RefCell::default(),
            unread_after: RefCell::default(),
            session: session.clone(),
            editing: RefCell::default(),
            revealing: RefCell::default(),
            highlighted: RefCell::default(),
            native_me: RefCell::default(),
        });
        this.wire_selection();
        this.wire(session);
        this
    }

    fn wire(self: &Rc<Self>, session: Shared<Arc<Session>>) {
        let weak = Rc::downgrade(self);
        let factory = gtk::SignalListItemFactory::new();
        factory.connect_setup(|_, item| {
            let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
            item.set_activatable(false);
            item.set_selectable(false);
            item.set_focusable(false);
        });
        let w = weak.clone();
        factory.connect_bind(move |_, item| {
            let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
            let object = item.item().and_downcast::<glib::BoxedAnyObject>().expect("message");
            let session = session.borrow().clone();
            let my_id = session
                .as_ref()
                .map(|s| s.info.user_id.clone())
                .unwrap_or_else(|| w.upgrade().map(|this| this.native_me.borrow().clone()).unwrap_or_default());
            let w2 = w.clone();
            let on_event: rows::OnRowEvent = Rc::new(move |event| {
                if let Some(handler) = w2.upgrade().and_then(|this| this.on_event.borrow().clone()) {
                    handler(event);
                }
            });
            let display = object.borrow::<Display>();
            let editing = w.upgrade().and_then(|this| {
                this.editing.borrow().as_ref().filter(|(id, _)| *id == display.row.id).map(|(_, b)| b.clone())
            });
            let widget = rows::message_widget(&display, &my_id, session.as_ref(), editing.as_ref(), on_event);
            if let Some(this) = w.upgrade() {
                this.bound.borrow_mut().insert(display.row.id.clone(), widget.clone());
                this.seen.borrow_mut().insert(display.row.id.clone(), texts(&widget).iter().map(segment).collect());
                this.apply_to(&display.row.id, &widget);
            }
            if w.upgrade().is_some_and(|this| this.highlighted.borrow().as_deref() == Some(display.row.id.as_str())) {
                widget.add_css_class("revealed");
            }
            item.set_child(Some(&widget));
        });
        let w = weak.clone();
        factory.connect_unbind(move |_, item| {
            let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
            let (Some(this), Some(child)) = (w.upgrade(), item.child()) else { return };
            let id = child.widget_name().to_string();
            let mut bound = this.bound.borrow_mut();
            if bound.get(&id) == Some(&child) {
                bound.remove(&id);
            }
        });
        self.view.set_factory(Some(&factory));

        // The list only estimates its height until rows are realized, so the
        // range keeps growing after an insertion: follow it while pinned.
        let adjustment = self.scroll.vadjustment();
        let w = weak.clone();
        adjustment.connect_value_changed(move |adj| {
            let Some(this) = w.upgrade() else { return };
            if this.settling.get() == 0 {
                this.pinned.set(adj.value() + adj.page_size() >= adj.upper() - 48.0);
            }
            this.jump.set_visible(adj.upper() - adj.value() - adj.page_size() > adj.page_size());
        });
        let w = weak.clone();
        adjustment.connect_changed(move |adj| {
            if w.upgrade().is_some_and(|this| this.pinned.get()) {
                adj.set_value(adj.upper() - adj.page_size());
            }
        });
        let w = weak.clone();
        self.jump.connect_clicked(move |_| {
            if let Some(this) = w.upgrade() {
                this.pinned.set(true);
                this.scroll_to_bottom();
            }
        });
        let w = weak;
        self.scroll.connect_edge_reached(move |_, position| {
            if position == gtk::PositionType::Top
                && let Some(top) = w.upgrade().and_then(|this| this.on_top.borrow().clone())
            {
                top(());
            }
        });
    }

    /// Selecting text: in one text GTK's own selection; dragged on into
    /// another text or message, a selection running across them, in reading
    /// order, as in a browser.
    fn wire_selection(self: &Rc<Self>) {
        let events = gtk::EventControllerLegacy::builder().propagation_phase(gtk::PropagationPhase::Capture).build();
        let weak = Rc::downgrade(self);
        events.connect_event(move |_, event| {
            let Some(this) = weak.upgrade() else { return glib::Propagation::Proceed };
            this.selection_event(event)
        });
        self.view.add_controller(events);
    }

    fn selection_event(self: &Rc<Self>, event: &gtk::gdk::Event) -> glib::Propagation {
        use gtk::gdk::EventType;
        let point = || {
            let native = self.view.native()?;
            let (sx, sy) = native.surface_transform();
            let (x, y) = event.position()?;
            let p = native.compute_point(&self.view, &gtk::graphene::Point::new((x - sx) as f32, (y - sy) as f32))?;
            Some((p.x() as f64, p.y() as f64))
        };
        match event.event_type() {
            EventType::ButtonPress => {
                let primary = event.downcast_ref::<gtk::gdk::ButtonEvent>().is_some_and(|b| b.button() == 1);
                if !primary {
                    return glib::Propagation::Proceed;
                }
                if self.span.borrow().is_some() {
                    self.clear_span();
                }
                let at = point();
                self.press_at.set(at);
                self.press.replace(at.and_then(|(x, y)| self.point_at(x, y, true)));
                self.spanning.set(false);
                glib::Propagation::Proceed
            }
            EventType::MotionNotify => {
                let Some(press) = self.press.borrow().clone() else { return glib::Propagation::Proceed };
                if !event.modifier_state().contains(gtk::gdk::ModifierType::BUTTON1_MASK) {
                    self.end_drag();
                    return glib::Propagation::Proceed;
                }
                let Some((x, y)) = point() else { return glib::Propagation::Proceed };
                self.pointer.set((x, y));
                let Some(focus) = self.point_at(x, y, false) else {
                    return if self.spanning.get() { glib::Propagation::Stop } else { glib::Propagation::Proceed };
                };
                if !self.spanning.get() {
                    if focus.id == press.id && focus.text == press.text {
                        return glib::Propagation::Proceed;
                    }
                    self.spanning.set(true);
                    crate::markdown_view::spanning(self.view.upcast_ref());
                    if let Some(row) = self.bound.borrow().get(&press.id)
                        && let Some(text) = texts(row).get(press.text)
                    {
                        unselect(text);
                    }
                }
                self.span.replace(Some(Span { anchor: press, focus }));
                self.apply();
                self.autoscroll();
                glib::Propagation::Stop
            }
            EventType::ButtonRelease => {
                let spanned = self.spanning.get();
                self.end_drag();
                if spanned {
                    return glib::Propagation::Stop;
                }
                if let Some((x, y)) = self.press_at.take() {
                    let view = self.view.clone();
                    glib::idle_add_local_once(move || {
                        if let Some(widget) = view.pick(x, y, gtk::PickFlags::DEFAULT) {
                            crate::markdown_view::note_selection(&widget);
                        }
                    });
                }
                glib::Propagation::Proceed
            }
            _ => glib::Propagation::Proceed,
        }
    }

    fn end_drag(&self) {
        self.press.replace(None);
        self.spanning.set(false);
        if let Some(source) = self.scroller.take() {
            source.remove();
        }
    }

    /// Near the list's top or bottom, a selection being dragged scrolls it
    /// and follows the text coming into view.
    fn autoscroll(self: &Rc<Self>) {
        let (_, y) = self.pointer.get();
        let near = y < EDGE || y > self.view.height() as f64 - EDGE;
        if !near {
            if let Some(source) = self.scroller.take() {
                source.remove();
            }
            return;
        }
        if self.scroller.borrow().is_some() {
            return;
        }
        let weak = Rc::downgrade(self);
        let source = glib::timeout_add_local(std::time::Duration::from_millis(40), move || {
            let Some(this) = weak.upgrade().filter(|this| this.spanning.get()) else {
                return glib::ControlFlow::Break;
            };
            let (x, y) = this.pointer.get();
            let step = if y < EDGE { -(EDGE - y).max(4.0) } else { (y - this.view.height() as f64 + EDGE).max(4.0) };
            let adjustment = this.scroll.vadjustment();
            adjustment.set_value(adjustment.value() + step);
            let clamped = y.clamp(1.0, this.view.height() as f64 - 1.0);
            if let Some(focus) = this.point_at(x, clamped, false) {
                if let Some(span) = this.span.borrow_mut().as_mut() {
                    span.focus = focus;
                }
                this.apply();
            }
            glib::ControlFlow::Continue
        });
        self.scroller.replace(Some(source));
    }

    /// The message row a widget belongs to, and that row's widget.
    fn row_of(&self, widget: Option<gtk::Widget>) -> Option<(String, gtk::Widget)> {
        let mut widget = widget;
        while let Some(w) = widget {
            let name = w.widget_name();
            if self.bound.borrow().get(name.as_str()) == Some(&w) {
                return Some((name.to_string(), w));
            }
            widget = w.parent();
        }
        None
    }

    /// Where \`(x, y)\` of the list falls in a message's text; \`exact\`: only
    /// right on a text, else the nearest place in the row under it.
    fn point_at(&self, x: f64, y: f64, exact: bool) -> Option<Point> {
        let picked = self.view.pick(x, y, gtk::PickFlags::DEFAULT);
        let (id, row) = self.row_of(picked.clone())?;
        let texts = texts(&row);
        let on =
            picked.and_then(|p| std::iter::successors(Some(p), |w| w.parent()).take_while(|w| *w != row).find(is_text));
        let local = |text: &gtk::Widget, x: f64, y: f64| {
            let p = self.view.compute_point(text, &gtk::graphene::Point::new(x as f32, y as f32))?;
            Some((p.x() as f64, p.y() as f64))
        };
        if let Some(text) = on {
            let index = texts.iter().position(|t| *t == text)?;
            let (lx, ly) = local(&text, x, y)?;
            return Some(Point { id, text: index, offset: offset_at(&text, lx, ly) });
        }
        if exact || texts.is_empty() {
            return None;
        }
        let bounds: Vec<_> = texts.iter().filter_map(|t| t.compute_bounds(&self.view)).collect();
        if bounds.len() != texts.len() {
            return None;
        }
        let above = bounds.iter().rposition(|b| (b.y() as f64) <= y);
        let Some(index) = above else { return Some(Point { id, text: 0, offset: 0 }) };
        let b = &bounds[index];
        let text = &texts[index];
        if y > (b.y() + b.height()) as f64 {
            return Some(Point { id, text: index, offset: words(text).chars().count() as i32 });
        }
        let cx = x.clamp(b.x() as f64 + 1.0, (b.x() + b.width()) as f64 - 1.0);
        let (lx, ly) = local(text, cx, y)?;
        Some(Point { id, text: index, offset: offset_at(text, lx, ly) })
    }

    /// The span's ends in reading order: (row, text, offset) each.
    fn ends(&self, span: &Span) -> Option<(Place, Place)> {
        let rows = self.rows.borrow();
        let at = |p: &Point| rows.iter().position(|d| d.row.id == p.id).map(|r| (r, p.text, p.offset));
        let (a, b) = (at(&span.anchor)?, at(&span.focus)?);
        Some(if a <= b { (a, b) } else { (b, a) })
    }

    /// What of text \`text\` (\`len\` characters) of row \`row\` the span covers.
    fn covered(ends: (Place, Place), row: usize, text: usize, len: i32) -> Option<(i32, i32)> {
        let ((ar, at, ao), (br, bt, bo)) = ends;
        if (row, text) < (ar, at) || (row, text) > (br, bt) {
            return None;
        }
        let start = if (row, text) == (ar, at) { ao } else { 0 };
        let end = if (row, text) == (br, bt) { bo } else { len };
        (start < end).then_some((start, end))
    }

    /// Shows the span in the row built for message \`id\`.
    fn apply_to(&self, id: &str, row: &gtk::Widget) {
        let span = self.span.borrow().clone();
        let ends = span.as_ref().and_then(|s| self.ends(s));
        let index = self.rows.borrow().iter().position(|d| d.row.id == id);
        for (i, text) in texts(row).iter().enumerate() {
            let len = words(text).chars().count() as i32;
            let range = ends.zip(index).and_then(|(ends, r)| Self::covered(ends, r, i, len));
            if span.is_some() || range.is_some() {
                highlight(text, range);
            }
        }
    }

    fn apply(&self) {
        let bound: Vec<(String, gtk::Widget)> =
            self.bound.borrow().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        for (id, row) in bound {
            self.apply_to(&id, &row);
        }
    }

    fn clear_span(&self) {
        if self.span.replace(None).is_none() {
            return;
        }
        let bound: Vec<gtk::Widget> = self.bound.borrow().values().cloned().collect();
        for row in bound {
            for text in texts(&row) {
                highlight(&text, None);
            }
        }
    }

    /// The text of a selection that runs across texts or messages, one line
    /// per text; None when there is none.
    pub fn selection_text(&self) -> Option<String> {
        let span = self.span.borrow().clone()?;
        let ((ar, ..), (br, ..)) = self.ends(&span)?;
        let ends = self.ends(&span)?;
        let rows = self.rows.borrow();
        let mut lines = Vec::new();
        for (r, display) in rows.iter().enumerate().take(br + 1).skip(ar) {
            let id = &display.row.id;
            let segments: Vec<Segment> = match self.bound.borrow().get(id) {
                Some(row) => texts(row).iter().map(segment).collect(),
                None => self.seen.borrow().get(id).cloned().unwrap_or_else(|| {
                    let blocks = rv_core::markdown::render(
                        display.row.md.as_deref(),
                        display.row.text.as_deref(),
                        &rv_core::markdown::Context { me: "" },
                    );
                    vec![(rv_core::runs::text(&blocks), Vec::new())]
                }),
            };
            for (i, segment) in segments.iter().enumerate() {
                let len = segment.0.chars().count() as i32;
                if let Some((start, end)) = Self::covered(ends, r, i, len) {
                    lines.push(copied(segment, start, end));
                }
            }
        }
        let text = lines.join("\n");
        (!text.is_empty()).then_some(text)
    }

    pub fn connect_event(&self, f: impl Fn(RowEvent) + 'static) {
        self.on_event.replace(Some(Rc::new(f)));
    }

    pub fn connect_top_reached(&self, f: impl Fn() + 'static) {
        self.on_top.replace(Some(Rc::new(move |()| f())));
    }

    /// Empties the list and pins it to the bottom again.
    pub fn clear(&self) {
        self.span.replace(None);
        self.seen.borrow_mut().clear();
        self.rows.replace(Vec::new());
        self.store.remove_all();
        self.pinned.set(true);
    }

    pub fn scroll_to_bottom(&self) {
        let n = self.store.n_items();
        if n > 0 {
            self.view.scroll_to(n - 1, gtk::ListScrollFlags::NONE, None);
        }
    }

    /// Applies the new rows as splices, keeping the scroll position.
    pub fn set_rows(self: &Rc<Self>, fresh: Vec<MessageRow>) {
        let mut fresh = rows::group(self.opened(fresh));
        if let Some((seen, me)) = self.unread_after.borrow().as_ref() {
            rv_core::timeline::mark_new(&mut fresh, *seen, me);
        }
        let old = self.rows.replace(fresh.clone());
        let splices = diff_sorted(
            &old,
            &fresh,
            |d| (d.row.ts, d.row.id.clone()),
            |a, b| (a.row.ts, &a.row.id) < (b.row.ts, &b.row.id),
            |a, b| a == b,
        );
        for s in splices {
            let additions: Vec<glib::BoxedAnyObject> =
                fresh[s.insert.clone()].iter().cloned().map(glib::BoxedAnyObject::new).collect();
            self.store.splice(s.at as u32, s.remove as u32, &additions);
        }
        if self.pinned.get() {
            self.scroll_to_bottom();
        }
        // An insertion makes the list re-anchor and re-measure over the next
        // frames: scroll again once it has, and only then listen to the user.
        self.settling.set(self.settling.get() + 1);
        let (view, store, pinned, settling) =
            (self.view.clone(), self.store.clone(), self.pinned.clone(), self.settling.clone());
        glib::timeout_add_local_once(std::time::Duration::from_millis(120), move || {
            let n = store.n_items();
            if pinned.get() && n > 0 {
                view.scroll_to(n - 1, gtk::ListScrollFlags::NONE, None);
            }
            settling.set(settling.get() - 1);
        });
        let waiting = self.revealing.borrow().clone();
        if let Some(id) = waiting.filter(|id| self.rows.borrow().iter().any(|d| d.row.id == *id)) {
            self.reveal(&id);
        }
    }

    pub fn set_unread_after(&self, after: Option<(i64, String)>) {
        self.unread_after.replace(after);
    }

    /// Every row built again, same data: a list view only rebuilds rows
    /// for items it has not seen, so they are all replaced.
    pub fn rebind(&self) {
        if let Some(session) = self.session.borrow().as_ref() {
            for d in self.rows.borrow_mut().iter_mut() {
                d.row = session.open_row(d.row.clone());
            }
        }
        let objects: Vec<glib::BoxedAnyObject> =
            self.rows.borrow().iter().cloned().map(glib::BoxedAnyObject::new).collect();
        self.store.splice(0, self.store.n_items(), &objects);
        if self.pinned.get() {
            self.scroll_to_bottom();
        }
    }

    /// Turns the message's row into an editor holding its text.
    pub fn start_edit(&self, row: &MessageRow) {
        let previous = self.editing.take().map(|(id, _)| id);
        let buffer = gtk::TextBuffer::new(None);
        buffer.set_text(row.text.as_deref().unwrap_or_default());
        self.editing.replace(Some((row.id.clone(), buffer)));
        if let Some(id) = previous {
            self.refresh(&id);
        }
        if let Some(at) = self.refresh(&row.id) {
            self.view.scroll_to(at, gtk::ListScrollFlags::NONE, None);
        }
    }

    /// Ends the edit: the message id and the text typed.
    pub fn stop_edit(&self) -> Option<(String, String)> {
        let (id, buffer) = self.editing.take()?;
        self.refresh(&id);
        Some((id, buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string()))
    }

    /// Scrolls to the message and marks it a moment; if it is not loaded yet,
    /// as soon as it is.
    pub fn reveal(self: &Rc<Self>, id: &str) {
        let Some(at) = self.rows.borrow().iter().position(|d| d.row.id == id) else {
            self.revealing.replace(Some(id.to_owned()));
            return;
        };
        self.revealing.replace(None);
        self.pinned.set(false);
        self.highlighted.replace(Some(id.to_owned()));
        self.refresh(id);
        self.view.scroll_to(at as u32, gtk::ListScrollFlags::NONE, None);
        let (weak, id) = (Rc::downgrade(self), id.to_owned());
        glib::timeout_add_local_once(std::time::Duration::from_millis(2500), move || {
            if let Some(this) = weak.upgrade()
                && this.highlighted.borrow().as_deref() == Some(id.as_str())
            {
                this.highlighted.replace(None);
                this.refresh(&id);
            }
        });
    }

    pub fn forget_reveal(&self) {
        self.revealing.replace(None);
    }

    /// A reveal is under way: the list must not jump to the bottom meanwhile.
    pub fn holds_reveal(&self) -> bool {
        self.revealing.borrow().is_some() || self.highlighted.borrow().is_some()
    }

    pub fn row(&self, id: &str) -> Option<MessageRow> {
        self.rows.borrow().iter().find(|d| d.row.id == id).map(|d| d.row.clone())
    }

    pub fn set_edit_text(&self, text: &str) {
        if let Some((_, buffer)) = self.editing.borrow().as_ref() {
            buffer.set_text(text);
        }
    }

    pub fn editing(&self) -> Option<String> {
        self.editing.borrow().as_ref().map(|(id, _)| id.clone())
    }

    /// My latest message still mine to change: sent, and not a system one.
    pub fn last_mine(&self, my_id: &str) -> Option<MessageRow> {
        self.rows
            .borrow()
            .iter()
            .rev()
            .map(|d| &d.row)
            .find(|r| {
                r.author_id == my_id
                    && r.outbox_status.is_none()
                    && rv_core::actions::has_actions(r.system_type.as_deref(), r.text.as_deref())
            })
            .cloned()
    }

    /// Builds the message's row again; returns its position.
    fn refresh(&self, id: &str) -> Option<u32> {
        let at = self.rows.borrow().iter().position(|d| d.row.id == id)?;
        let object = glib::BoxedAnyObject::new(self.rows.borrow()[at].clone());
        self.store.splice(at as u32, 1, &[object]);
        Some(at as u32)
    }

    pub fn scroll_to_top(&self) {
        self.scroll.vadjustment().set_value(0.0);
    }

    pub fn jump_shown(&self) -> bool {
        self.jump.is_visible()
    }

    /// Clicks the button back to the latest message.
    pub fn jump(&self) {
        self.jump.emit_clicked();
    }

    pub fn is_pinned(&self) -> bool {
        self.pinned.get()
    }

    pub fn has_new_marker(&self) -> bool {
        self.rows.borrow().iter().any(|d| d.new_marker)
    }

    pub fn oldest_ts(&self) -> Option<i64> {
        self.rows.borrow().first().map(|d| d.row.ts)
    }

    pub fn len(&self) -> usize {
        self.rows.borrow().len()
    }

    /// Encrypted rows opened when unlocked: everything downstream reads them as clear ones.
    fn opened(&self, rows: Vec<MessageRow>) -> Vec<MessageRow> {
        match self.session.borrow().as_ref() {
            Some(session) => rows.into_iter().map(|r| session.open_row(r)).collect(),
            None => rows,
        }
    }

    /// What each row reads as, encrypted ones in clear when unlocked.
    pub fn texts(&self) -> Vec<String> {
        self.rows.borrow().iter().map(|d| d.row.text.clone().unwrap_or_default()).collect()
    }
}
