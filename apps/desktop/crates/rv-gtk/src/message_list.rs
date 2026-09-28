//! A list of messages, newest at the bottom, shared by rooms and threads.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use gtk::prelude::*;
use gtk::{gio, glib};
use rv_core::diff::diff_sorted;
use rv_core::session::Session;
use rv_core::store::MessageRow;

use crate::rows::{self, Display, RowEvent};
use crate::widgets::Handler;

pub type Shared<T> = Rc<RefCell<Option<T>>>;

pub struct MessageList {
    pub scroll: gtk::ScrolledWindow,
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
}

impl MessageList {
    pub fn new(session: Shared<Arc<Session>>) -> Rc<Self> {
        let store = gio::ListStore::new::<glib::BoxedAnyObject>();
        let view = gtk::ListView::new(Some(gtk::NoSelection::new(Some(store.clone()))), None::<gtk::ListItemFactory>);
        let scroll =
            gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&view).build();
        let this = Rc::new(MessageList {
            scroll,
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
        });
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
            item.set_child(Some(&widget));
        });
        self.view.set_factory(Some(&factory));

        // The list only estimates its height until rows are realized, so the
        // range keeps growing after an insertion: follow it while pinned.
        let adjustment = self.scroll.vadjustment();
        let w = weak.clone();
        adjustment.connect_value_changed(move |adj| {
            if let Some(this) = w.upgrade()
                && this.settling.get() == 0
            {
                this.pinned.set(adj.value() + adj.page_size() >= adj.upper() - 48.0);
            }
        });
        let w = weak.clone();
        adjustment.connect_changed(move |adj| {
            if w.upgrade().is_some_and(|this| this.pinned.get()) {
                adj.set_value(adj.upper() - adj.page_size());
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
    pub fn set_rows(&self, fresh: Vec<MessageRow>) {
        let mut fresh = rows::group(fresh);
        if let Some((seen, me)) = self.unread_after.borrow().as_ref()
            && let Some(first) =
                fresh.iter_mut().find(|d| d.row.ts > *seen && d.row.author_id != *me && d.row.outbox_status.is_none())
        {
            first.new_marker = true;
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
    }

    pub fn set_unread_after(&self, after: Option<(i64, String)>) {
        self.unread_after.replace(after);
    }

    /// Every row built again, same data: a list view only rebuilds rows
    /// for items it has not seen, so they are all replaced.
    pub fn rebind(&self) {
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

    /// What each row reads as, encrypted ones in clear when unlocked.
    pub fn texts(&self) -> Vec<String> {
        let session = self.session.borrow().clone();
        let clear = |r: &MessageRow| {
            let raw = r.encrypted_raw.as_deref()?;
            session.as_ref()?.decrypt(&r.rid, raw)
        };
        self.rows.borrow().iter().map(|d| clear(&d.row).or_else(|| d.row.text.clone()).unwrap_or_default()).collect()
    }
}
