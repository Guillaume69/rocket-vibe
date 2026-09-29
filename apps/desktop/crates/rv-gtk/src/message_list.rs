//! A list of messages, newest at the bottom, shared by rooms and threads.

use std::cell::{Cell, RefCell};
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

/// The avatar and time column of a row: pressing there picks whole messages.
const GUTTER: f64 = 60.0;

pub struct MessageList {
    /// The scroller, with the button back to the latest message over it.
    pub root: gtk::Overlay,
    scroll: gtk::ScrolledWindow,
    jump: gtk::Button,
    /// Whole messages picked in the gutter, and the bar that copies them.
    pick_bar: gtk::Box,
    pick_label: gtk::Label,
    picked: RefCell<Vec<String>>,
    anchor: RefCell<Option<String>>,
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
}

impl MessageList {
    pub fn new(session: Shared<Arc<Session>>) -> Rc<Self> {
        let store = gio::ListStore::new::<glib::BoxedAnyObject>();
        let view = gtk::ListView::new(Some(gtk::NoSelection::new(Some(store.clone()))), None::<gtk::ListItemFactory>);
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
        let pick_label = gtk::Label::builder().css_classes(["pick-count"]).build();
        let pick_copy = gtk::Button::builder().label(t("pick.copy")).css_classes(["pick-copy"]).build();
        let pick_clear = gtk::Button::builder()
            .icon_name("window-close-symbolic")
            .tooltip_text(t("pick.clear"))
            .css_classes(["flat", "circular"])
            .build();
        let pick_bar = gtk::Box::builder()
            .spacing(10)
            .css_classes(["pick-bar"])
            .halign(gtk::Align::Center)
            .valign(gtk::Align::Start)
            .margin_top(8)
            .visible(false)
            .build();
        pick_bar.append(&pick_label);
        pick_bar.append(&pick_copy);
        pick_bar.append(&pick_clear);
        root.add_overlay(&pick_bar);
        let this = Rc::new(MessageList {
            root,
            scroll,
            jump,
            pick_bar,
            pick_label,
            picked: RefCell::default(),
            anchor: RefCell::default(),
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
        });
        let weak = Rc::downgrade(&this);
        pick_copy.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.copy_picked();
            }
        });
        let weak = Rc::downgrade(&this);
        pick_clear.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.clear_picked();
            }
        });
        this.wire_picking();
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
            let my_id = session.as_ref().map(|s| s.info.user_id.clone()).unwrap_or_default();
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
            if w.upgrade().is_some_and(|this| this.picked.borrow().contains(&display.row.id)) {
                widget.add_css_class("picked");
            }
            if w.upgrade().is_some_and(|this| this.highlighted.borrow().as_deref() == Some(display.row.id.as_str())) {
                widget.add_css_class("revealed");
            }
            item.set_child(Some(&widget));
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

    /// Pressing in the gutter (avatar, time) and dragging picks whole messages,
    /// Shift extends from the last one; inside a message the text selects as usual.
    fn wire_picking(self: &Rc<Self>) {
        let drag = gtk::GestureDrag::builder().propagation_phase(gtk::PropagationPhase::Capture).build();
        let weak = Rc::downgrade(self);
        drag.connect_drag_begin(move |gesture, x, y| {
            let Some(this) = weak.upgrade() else { return };
            let id = (x < GUTTER).then(|| this.id_at(x, y)).flatten();
            let Some(id) = id else {
                gesture.set_state(gtk::EventSequenceState::Denied);
                return;
            };
            gesture.set_state(gtk::EventSequenceState::Claimed);
            this.view.set_focusable(true);
            this.view.grab_focus();
            let shift = gesture.current_event_state().contains(gtk::gdk::ModifierType::SHIFT_MASK);
            let anchor = this.anchor.borrow().clone().filter(|_| shift);
            match anchor {
                Some(anchor) => this.pick_range(&anchor, &id),
                None => {
                    this.anchor.replace(Some(id.clone()));
                    let already = this.picked.borrow().len() == 1 && this.picked.borrow()[0] == id;
                    this.set_picked(if already { Vec::new() } else { vec![id] });
                }
            }
        });
        let weak = Rc::downgrade(self);
        drag.connect_drag_update(move |gesture, dx, dy| {
            let (Some(this), Some((x, y))) = (weak.upgrade(), gesture.start_point()) else { return };
            let anchor = this.anchor.borrow().clone();
            if let (Some(anchor), Some(id)) = (anchor, this.id_at(x + dx, y + dy)) {
                this.pick_range(&anchor, &id);
            }
        });
        self.view.add_controller(drag);
        let keys = gtk::EventControllerKey::new();
        let weak = Rc::downgrade(self);
        keys.connect_key_pressed(move |_, key, _, state| {
            let Some(this) = weak.upgrade().filter(|this| !this.picked.borrow().is_empty()) else {
                return glib::Propagation::Proceed;
            };
            match key {
                gtk::gdk::Key::c if state.contains(gtk::gdk::ModifierType::CONTROL_MASK) => this.copy_picked(),
                gtk::gdk::Key::Escape => this.clear_picked(),
                _ => return glib::Propagation::Proceed,
            }
            glib::Propagation::Stop
        });
        self.view.add_controller(keys);
    }

    /// The message whose row is at `(x, y)` of the list.
    fn id_at(&self, x: f64, y: f64) -> Option<String> {
        let mut widget = self.view.pick(x, y, gtk::PickFlags::DEFAULT);
        while let Some(w) = widget {
            let name = w.widget_name();
            if self.rows.borrow().iter().any(|d| d.row.id == name.as_str()) {
                return Some(name.to_string());
            }
            widget = w.parent();
        }
        None
    }

    fn pick_range(&self, from: &str, to: &str) {
        let rows = self.rows.borrow();
        let at = |id: &str| rows.iter().position(|d| d.row.id == id);
        let (Some(a), Some(b)) = (at(from), at(to)) else { return };
        let ids = rows[a.min(b)..=a.max(b)]
            .iter()
            .filter(|d| rv_core::actions::has_actions(d.row.system_type.as_deref(), d.row.text.as_deref()))
            .map(|d| d.row.id.clone())
            .collect();
        drop(rows);
        self.set_picked(ids);
    }

    fn set_picked(&self, ids: Vec<String>) {
        let before = self.picked.replace(ids);
        let now = self.picked.borrow().clone();
        for id in before.iter().filter(|id| !now.contains(id)).chain(now.iter().filter(|id| !before.contains(id))) {
            self.refresh(id);
        }
        self.pick_bar.set_visible(!now.is_empty());
        self.pick_label.set_label(&crate::i18n::tn("pick.count", now.len() as i64));
    }

    pub fn clear_picked(&self) {
        self.anchor.replace(None);
        self.set_picked(Vec::new());
    }

    /// The picked messages as text, oldest first: author and time, then the words.
    pub fn picked_text(&self) -> String {
        let picked = self.picked.borrow();
        self.rows
            .borrow()
            .iter()
            .filter(|d| picked.contains(&d.row.id))
            .map(|d| {
                let words = rv_core::actions::copyable_text(d.row.text.as_deref())
                    .map_or_else(|| t("pick.attachment").to_owned(), str::to_owned);
                let when = rows::local(d.row.ts).format("%d/%m/%Y %H:%M");
                format!("{} · {when}\n{words}", d.row.author.as_deref().unwrap_or_default())
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    fn copy_picked(&self) {
        self.root.clipboard().set_text(&self.picked_text());
        self.clear_picked();
    }

    pub fn connect_event(&self, f: impl Fn(RowEvent) + 'static) {
        self.on_event.replace(Some(Rc::new(f)));
    }

    pub fn connect_top_reached(&self, f: impl Fn() + 'static) {
        self.on_top.replace(Some(Rc::new(move |()| f())));
    }

    /// Empties the list and pins it to the bottom again.
    pub fn clear(&self) {
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
