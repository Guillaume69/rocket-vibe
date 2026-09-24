//! A list of messages, newest at the bottom, shared by rooms and threads.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use gtk::prelude::*;
use gtk::{gio, glib};
use rv_core::diff::diff_sorted;
use rv_core::session::Session;
use rv_core::store::MessageRow;

use crate::rows::{self, Display};
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
    on_retry: Handler<String>,
    on_top: Handler<()>,
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
            on_retry: RefCell::default(),
            on_top: RefCell::default(),
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
            let widget = rows::message_widget(&object.borrow::<Display>(), &my_id, session.as_ref(), move |id| {
                if let Some(retry) = w2.upgrade().and_then(|this| this.on_retry.borrow().clone()) {
                    retry(id);
                }
            });
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

    pub fn connect_retry(&self, f: impl Fn(String) + 'static) {
        self.on_retry.replace(Some(Rc::new(f)));
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
        let fresh = rows::group(fresh);
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

    pub fn oldest_ts(&self) -> Option<i64> {
        self.rows.borrow().first().map(|d| d.row.ts)
    }

    pub fn len(&self) -> usize {
        self.rows.borrow().len()
    }

    pub fn texts(&self) -> Vec<String> {
        self.rows.borrow().iter().map(|d| d.row.text.clone().unwrap_or_default()).collect()
    }
}
