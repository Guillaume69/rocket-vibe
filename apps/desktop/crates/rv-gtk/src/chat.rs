use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use chrono::{DateTime, Local, TimeZone};
use gtk::{gdk, gio, glib, pango};
use rv_core::diff::diff_sorted;
use rv_core::session::{Connection, Session};
use rv_core::store::{Change, MessageRow, RoomRow};
use rv_core::sync::HISTORY_PAGE;
use serde_json::Value;

use crate::runtime;

const GROUPING_GAP_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Display {
    row: MessageRow,
    show_header: bool,
    show_day: bool,
}

#[derive(Debug, Clone)]
struct OpenRoom {
    rid: String,
    kind: String,
    name: String,
    read_only: bool,
}

type Callback<T> = RefCell<Vec<Box<dyn Fn(T)>>>;

pub struct ChatPage {
    split: adw::NavigationSplitView,
    sidebar_title: adw::WindowTitle,
    status_dot: gtk::Box,
    rooms_store: gio::ListStore,
    rooms_selection: gtk::SingleSelection,
    rooms: RefCell<Vec<RoomRow>>,
    suppress_selection: Cell<bool>,
    content_page: adw::NavigationPage,
    content_stack: gtk::Stack,
    messages_store: gio::ListStore,
    messages_view: gtk::ListView,
    messages_scroll: gtk::ScrolledWindow,
    messages: RefCell<Vec<Display>>,
    composer: gtk::TextView,
    composer_bar: gtk::Box,
    read_only_label: gtk::Label,
    session: RefCell<Option<Arc<Session>>>,
    current: RefCell<Option<OpenRoom>>,
    limit: Cell<i64>,
    loading: Cell<bool>,
    has_older: Cell<bool>,
    pinned: Rc<Cell<bool>>,
    /// Refreshes whose scroll adjustments are ours, not the user's.
    settling: Rc<Cell<u32>>,
    on_logout: Callback<()>,
    on_room_changed: Callback<Option<String>>,
}

fn local(ts: i64) -> DateTime<Local> {
    Local.timestamp_millis_opt(ts).single().unwrap_or_default()
}

fn short_time(ts: i64) -> String {
    if ts <= 0 {
        return String::new();
    }
    let t = local(ts);
    let today = Local::now().date_naive();
    let days = (today - t.date_naive()).num_days();
    if days == 0 {
        t.format("%H:%M").to_string()
    } else if days < 7 {
        t.format("%a").to_string()
    } else {
        t.format("%d/%m/%Y").to_string()
    }
}

fn attachment_label(json: Option<&str>) -> Option<String> {
    let list: Vec<Value> = serde_json::from_str(json?).ok()?;
    list.iter().find_map(|a| {
        let title = a.get("title").and_then(Value::as_str).filter(|s| !s.is_empty());
        let description = a.get("description").and_then(Value::as_str).filter(|s| !s.is_empty());
        match (title, description) {
            (Some(t), Some(d)) => Some(format!("📎 {t} - {d}")),
            (Some(t), None) => Some(format!("📎 {t}")),
            _ if a.get("message_link").is_some() => {
                Some(format!("❝ {}", a.get("text").and_then(Value::as_str).unwrap_or_default()))
            }
            _ => None,
        }
    })
}

fn system_text(kind: &str, author: &str, text: &str) -> String {
    match kind {
        "uj" => format!("{author} joined the room"),
        "ul" => format!("{author} left the room"),
        "au" => format!("{author} added {text}"),
        "ru" => format!("{author} removed {text}"),
        "r" => format!("{author} renamed the room to {text}"),
        "room_changed_topic" => format!("{author} changed the topic: {text}"),
        "message_pinned" => format!("{author} pinned a message"),
        "videoconf" => format!("{author} started a call"),
        "e2e" => "Encrypted message".to_owned(),
        _ if text.is_empty() => format!("({kind})"),
        _ => text.to_owned(),
    }
}

fn body_of(row: &MessageRow) -> String {
    let author = row.author.as_deref().unwrap_or_default();
    let text = row.text.as_deref().unwrap_or_default();
    if let Some(kind) = &row.system_type {
        return system_text(kind, author, text);
    }
    match (text.is_empty(), attachment_label(row.attachments.as_deref())) {
        (true, attachment) => attachment.unwrap_or_default(),
        (false, Some(attachment)) => format!("{text}\n{attachment}"),
        (false, None) => text.to_owned(),
    }
}

fn group(rows: Vec<MessageRow>) -> Vec<Display> {
    let mut out: Vec<Display> = Vec::with_capacity(rows.len());
    for row in rows {
        let (show_header, show_day) = match out.last() {
            None => (true, true),
            Some(prev) => {
                let new_day = local(prev.row.ts).date_naive() != local(row.ts).date_naive();
                let header = new_day
                    || row.system_type.is_some()
                    || prev.row.system_type.is_some()
                    || prev.row.author_id != row.author_id
                    || row.ts - prev.row.ts > GROUPING_GAP_MS;
                (header, new_day)
            }
        };
        out.push(Display { row, show_header, show_day });
    }
    out
}

fn label(text: &str, classes: &[&str]) -> gtk::Label {
    gtk::Label::builder().label(text).xalign(0.0).css_classes(classes.to_vec()).build()
}

fn room_widget(r: &RoomRow) -> gtk::Widget {
    let unread = r.unread > 0;
    let prefix = match r.kind.as_str() {
        "c" => "# ",
        "p" => "🔒 ",
        _ => "",
    };
    let name = label(&format!("{prefix}{}", r.name), &["room-name"]);
    name.set_hexpand(true);
    name.set_ellipsize(pango::EllipsizeMode::End);
    let time = label(&short_time(r.last_ts), &["dim-label", "caption", "room-time"]);
    let preview_text = match (&r.last_message, r.encrypted) {
        (Some(m), _) => m.clone(),
        (None, true) => "Encrypted message".to_owned(),
        (None, false) => String::new(),
    };
    let preview = label(&preview_text, &["dim-label"]);
    preview.set_hexpand(true);
    preview.set_ellipsize(pango::EllipsizeMode::End);
    preview.set_single_line_mode(true);
    if unread {
        name.add_css_class("unread");
        time.add_css_class("unread");
    }

    let top = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    top.append(&name);
    top.append(&time);
    let bottom = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    bottom.append(&preview);
    if unread {
        let text = if r.mentions > 0 { format!("@{}", r.unread) } else { r.unread.to_string() };
        let badge = label(&text, &["badge"]);
        if r.mentions > 0 {
            badge.add_css_class("mention");
        }
        badge.set_valign(gtk::Align::Center);
        bottom.append(&badge);
    }

    let column = gtk::Box::new(gtk::Orientation::Vertical, 2);
    column.set_hexpand(true);
    column.set_valign(gtk::Align::Center);
    column.append(&top);
    column.append(&bottom);

    let row = gtk::Box::builder().spacing(12).margin_top(8).margin_bottom(8).margin_start(6).margin_end(6).build();
    row.append(&adw::Avatar::new(40, Some(&r.name), true));
    row.append(&column);
    row.upcast()
}

fn message_widget(d: &Display, my_id: &str, on_retry: impl Fn(String) + 'static) -> gtk::Widget {
    let row = &d.row;
    let outer = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(2)
        .margin_start(16)
        .margin_end(16)
        .margin_top(if d.show_header { 10 } else { 1 })
        .build();

    if d.show_day {
        let day = gtk::Box::builder().spacing(10).margin_top(8).margin_bottom(6).build();
        let left = gtk::Separator::new(gtk::Orientation::Horizontal);
        left.set_hexpand(true);
        left.set_valign(gtk::Align::Center);
        let right = gtk::Separator::new(gtk::Orientation::Horizontal);
        right.set_hexpand(true);
        right.set_valign(gtk::Align::Center);
        day.append(&left);
        day.append(&label(&local(row.ts).format("%A %-d %B %Y").to_string(), &["dim-label", "caption"]));
        day.append(&right);
        outer.append(&day);
    }

    let body_text = body_of(row);
    if row.system_type.is_some() {
        let system = label(&body_text, &["system-message"]);
        system.set_wrap(true);
        system.set_margin_start(48);
        outer.append(&system);
        return outer.upcast();
    }

    let author = row.author.clone().unwrap_or_default();
    let line = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    if d.show_header {
        let avatar = adw::Avatar::new(36, Some(&author), true);
        avatar.set_valign(gtk::Align::Start);
        line.append(&avatar);
    } else {
        line.append(&gtk::Box::builder().width_request(36).build());
    }

    let column = gtk::Box::new(gtk::Orientation::Vertical, 2);
    column.set_hexpand(true);
    if d.show_header {
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let name = label(&author, &["author"]);
        if row.author_id == my_id {
            name.add_css_class("mine");
        }
        header.append(&name);
        header.append(&label(&local(row.ts).format("%H:%M").to_string(), &["dim-label", "caption"]));
        column.append(&header);
    }

    let pending = row.outbox_status.as_deref() == Some("pending");
    let failed = row.outbox_status.as_deref() == Some("failed");
    let body = label(&body_text, &["message-body"]);
    body.set_wrap(true);
    body.set_wrap_mode(pango::WrapMode::WordChar);
    body.set_selectable(true);
    if pending {
        body.add_css_class("pending");
    }
    if failed {
        body.add_css_class("failed");
    }
    column.append(&body);

    if row.edited || failed || row.thread_count > 0 {
        let footer = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        if row.edited {
            footer.append(&label("(edited)", &["dim-label", "caption"]));
        }
        if row.thread_count > 0 {
            let n = row.thread_count;
            footer
                .append(&label(&format!("{n} {}", if n == 1 { "reply" } else { "replies" }), &["replies", "caption"]));
        }
        if failed {
            let retry =
                gtk::Button::builder().label("Not sent. Retry").css_classes(["flat", "error", "caption"]).build();
            let id = row.id.clone();
            retry.connect_clicked(move |_| on_retry(id.clone()));
            footer.append(&retry);
        }
        column.append(&footer);
    }

    line.append(&column);
    outer.append(&line);
    outer.upcast()
}

impl ChatPage {
    pub fn new() -> Rc<Self> {
        let rooms_store = gio::ListStore::new::<glib::BoxedAnyObject>();
        let rooms_selection = gtk::SingleSelection::new(Some(rooms_store.clone()));
        rooms_selection.set_autoselect(false);
        rooms_selection.set_can_unselect(true);
        let room_factory = gtk::SignalListItemFactory::new();
        room_factory.connect_bind(|_, item| {
            let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
            let object = item.item().and_downcast::<glib::BoxedAnyObject>().expect("room");
            item.set_child(Some(&room_widget(&object.borrow::<RoomRow>())));
        });
        let rooms_view = gtk::ListView::new(Some(rooms_selection.clone()), Some(room_factory));
        rooms_view.add_css_class("navigation-sidebar");

        let sidebar_title = adw::WindowTitle::new("", "");
        let status_dot = gtk::Box::builder().css_classes(["status-dot", "offline"]).valign(gtk::Align::Center).build();
        let status_button = gtk::Button::builder()
            .child(&status_dot)
            .css_classes(["flat"])
            .tooltip_text("Offline, click to reconnect")
            .build();
        let logout = gtk::Button::builder().icon_name("system-log-out-symbolic").tooltip_text("Sign out").build();
        let sidebar_header = adw::HeaderBar::new();
        sidebar_header.set_title_widget(Some(&sidebar_title));
        sidebar_header.pack_start(&status_button);
        sidebar_header.pack_end(&logout);
        let sidebar_toolbar = adw::ToolbarView::new();
        sidebar_toolbar.add_top_bar(&sidebar_header);
        sidebar_toolbar.set_content(Some(
            &gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).child(&rooms_view).build(),
        ));
        let sidebar_page = adw::NavigationPage::new(&sidebar_toolbar, "Rooms");

        let messages_store = gio::ListStore::new::<glib::BoxedAnyObject>();
        let messages_view =
            gtk::ListView::new(Some(gtk::NoSelection::new(Some(messages_store.clone()))), None::<gtk::ListItemFactory>);
        let messages_scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .child(&messages_view)
            .build();

        let composer =
            gtk::TextView::builder().wrap_mode(gtk::WrapMode::WordChar).accepts_tab(false).hexpand(true).build();
        let composer_scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_height(true)
            .max_content_height(160)
            .child(&composer)
            .css_classes(["composer"])
            .hexpand(true)
            .build();
        let send = gtk::Button::builder()
            .icon_name("mail-send-symbolic")
            .tooltip_text("Send")
            .css_classes(["circular", "suggested-action"])
            .valign(gtk::Align::End)
            .build();
        let composer_bar =
            gtk::Box::builder().spacing(8).margin_top(10).margin_bottom(10).margin_start(12).margin_end(12).build();
        composer_bar.append(&composer_scroll);
        composer_bar.append(&send);
        let read_only_label = gtk::Label::builder()
            .label("This room is read-only.")
            .css_classes(["dim-label"])
            .margin_top(14)
            .margin_bottom(14)
            .visible(false)
            .build();

        let room_view = adw::ToolbarView::new();
        room_view.add_top_bar(&adw::HeaderBar::new());
        room_view.set_content(Some(&messages_scroll));
        let bottom = gtk::Box::new(gtk::Orientation::Vertical, 0);
        bottom.append(&composer_bar);
        bottom.append(&read_only_label);
        room_view.add_bottom_bar(&bottom);

        let empty = adw::ToolbarView::new();
        empty.add_top_bar(&adw::HeaderBar::builder().show_title(false).build());
        empty.set_content(Some(
            &adw::StatusPage::builder().title("Pick a conversation").icon_name("user-available-symbolic").build(),
        ));
        let content_stack = gtk::Stack::new();
        content_stack.add_named(&empty, Some("empty"));
        content_stack.add_named(&room_view, Some("room"));
        let content_page = adw::NavigationPage::new(&content_stack, "rocket-vibe");

        let split = adw::NavigationSplitView::new();
        split.set_sidebar(Some(&sidebar_page));
        split.set_content(Some(&content_page));
        split.set_min_sidebar_width(260.0);
        split.set_max_sidebar_width(400.0);

        let this = Rc::new(ChatPage {
            split,
            sidebar_title,
            status_dot,
            rooms_store,
            rooms_selection,
            rooms: RefCell::default(),
            suppress_selection: Cell::new(false),
            content_page,
            content_stack,
            messages_store,
            messages_view,
            messages_scroll,
            messages: RefCell::default(),
            composer,
            composer_bar,
            read_only_label,
            session: RefCell::default(),
            current: RefCell::default(),
            limit: Cell::new(HISTORY_PAGE),
            loading: Cell::new(false),
            has_older: Cell::new(true),
            pinned: Rc::new(Cell::new(true)),
            settling: Rc::new(Cell::new(0)),
            on_logout: RefCell::default(),
            on_room_changed: RefCell::default(),
        });
        this.wire(&status_button, &logout, &send);
        this
    }

    fn wire(self: &Rc<Self>, status_button: &gtk::Button, logout: &gtk::Button, send: &gtk::Button) {
        let weak = Rc::downgrade(self);
        let message_factory = gtk::SignalListItemFactory::new();
        message_factory.connect_setup(|_, item| {
            let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
            item.set_activatable(false);
            item.set_selectable(false);
            item.set_focusable(false);
        });
        let w = weak.clone();
        message_factory.connect_bind(move |_, item| {
            let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
            let object = item.item().and_downcast::<glib::BoxedAnyObject>().expect("message");
            let Some(this) = w.upgrade() else { return };
            let my_id = this.session.borrow().as_ref().map(|s| s.info.user_id.clone()).unwrap_or_default();
            let w2 = w.clone();
            let widget = message_widget(&object.borrow::<Display>(), &my_id, move |id| {
                if let Some(this) = w2.upgrade() {
                    this.retry(id);
                }
            });
            item.set_child(Some(&widget));
        });
        self.messages_view.set_factory(Some(&message_factory));

        let w = weak.clone();
        self.rooms_selection.connect_selection_changed(move |selection, _, _| {
            let Some(this) = w.upgrade() else { return };
            if this.suppress_selection.get() {
                return;
            }
            let index = selection.selected();
            let rid = this.rooms.borrow().get(index as usize).map(|r| r.rid.clone());
            if let Some(rid) = rid {
                this.open_room(&rid);
            }
        });

        let w = weak.clone();
        status_button.connect_clicked(move |_| {
            if let Some(s) = w.upgrade().and_then(|t| t.session.borrow().clone()) {
                s.reconnect_now();
            }
        });
        let w = weak.clone();
        logout.connect_clicked(move |_| {
            if let Some(this) = w.upgrade() {
                for f in this.on_logout.borrow().iter() {
                    f(());
                }
            }
        });
        let w = weak.clone();
        send.connect_clicked(move |_| {
            if let Some(this) = w.upgrade() {
                this.send_composer();
            }
        });
        let keys = gtk::EventControllerKey::new();
        let w = weak.clone();
        keys.connect_key_pressed(move |_, key, _, state| {
            let enter = key == gdk::Key::Return || key == gdk::Key::KP_Enter;
            if !enter || state.contains(gdk::ModifierType::SHIFT_MASK) {
                return glib::Propagation::Proceed;
            }
            if let Some(this) = w.upgrade() {
                this.send_composer();
            }
            glib::Propagation::Stop
        });
        self.composer.add_controller(keys);

        // The list only estimates its height until rows are realized, so the
        // range keeps growing after an insertion: follow it while pinned.
        let adjustment = self.messages_scroll.vadjustment();
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
        self.messages_scroll.connect_edge_reached(move |_, position| {
            if position == gtk::PositionType::Top
                && let Some(this) = w.upgrade()
            {
                this.load_older();
            }
        });
    }

    pub fn widget(&self) -> &adw::NavigationSplitView {
        &self.split
    }

    pub fn connect_logout(&self, f: impl Fn() + 'static) {
        self.on_logout.borrow_mut().push(Box::new(move |()| f()));
    }

    pub fn connect_room_changed(&self, f: impl Fn(Option<String>) + 'static) {
        self.on_room_changed.borrow_mut().push(Box::new(f));
    }

    pub fn set_session(&self, session: Option<Arc<Session>>) {
        if let Some(s) = &session {
            let host = url::Url::parse(&s.info.base_url).ok().and_then(|u| u.host_str().map(str::to_owned));
            self.sidebar_title.set_title(&s.info.username);
            self.sidebar_title.set_subtitle(&host.unwrap_or_default());
        }
        self.session.replace(session);
        self.current.replace(None);
        self.messages.replace(Vec::new());
        self.messages_store.remove_all();
        self.content_stack.set_visible_child_name("empty");
        self.content_page.set_title("rocket-vibe");
        self.set_connection(Connection::Offline);
        self.reload_rooms();
        for f in self.on_room_changed.borrow().iter() {
            f(None);
        }
    }

    pub fn set_connection(&self, c: Connection) {
        let (class, tip) = match c {
            Connection::Online => ("online", "Connected"),
            Connection::Connecting => ("connecting", "Connecting…"),
            Connection::Offline => ("offline", "Offline, click to reconnect"),
        };
        self.status_dot.set_css_classes(&["status-dot", class]);
        if let Some(button) = self.status_dot.parent() {
            button.set_tooltip_text(Some(tip));
        }
    }

    pub fn on_change(&self, change: &Change) {
        if change.rooms {
            self.reload_rooms();
        }
        let current = self.current.borrow().as_ref().map(|r| r.rid.clone());
        if current.is_some_and(|rid| change.rids.contains(&rid)) {
            self.reload_messages();
        }
    }

    pub fn reload_all(&self) {
        self.reload_rooms();
        self.reload_messages();
    }

    fn reload_rooms(&self) {
        let rows = self.session.borrow().as_ref().map(|s| s.store.rooms()).unwrap_or_default();
        if *self.rooms.borrow() != rows {
            let objects: Vec<glib::BoxedAnyObject> = rows.iter().cloned().map(glib::BoxedAnyObject::new).collect();
            self.suppress_selection.set(true);
            self.rooms_store.splice(0, self.rooms_store.n_items(), &objects);
            let current = self.current.borrow().as_ref().map(|r| r.rid.clone());
            let index = current.and_then(|rid| rows.iter().position(|r| r.rid == rid));
            self.rooms_selection.set_selected(index.map_or(gtk::INVALID_LIST_POSITION, |i| i as u32));
            self.suppress_selection.set(false);

            if let Some(open) = self.current.borrow_mut().as_mut()
                && let Some(r) = rows.iter().find(|r| r.rid == open.rid)
            {
                open.name = r.name.clone();
                open.read_only = r.read_only;
            }
            self.rooms.replace(rows);
            self.refresh_room_header();
        }
    }

    fn refresh_room_header(&self) {
        let Some(open) = self.current.borrow().clone() else { return };
        self.content_page.set_title(&open.name);
        self.composer_bar.set_visible(!open.read_only);
        self.read_only_label.set_visible(open.read_only);
    }

    fn scroll_to_bottom(&self) {
        let n = self.messages_store.n_items();
        if n > 0 {
            self.messages_view.scroll_to(n - 1, gtk::ListScrollFlags::NONE, None);
        }
    }

    fn reload_messages(&self) {
        let Some(open) = self.current.borrow().clone() else { return };
        let Some(session) = self.session.borrow().clone() else { return };
        let fresh = group(session.store.messages(&open.rid, self.limit.get()));
        let old = self.messages.replace(fresh.clone());
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
            self.messages_store.splice(s.at as u32, s.remove as u32, &additions);
        }
        if self.pinned.get() {
            self.scroll_to_bottom();
        }
        // An insertion makes the list re-anchor and re-measure over the next
        // frames: scroll again once it has, and only then listen to the user.
        self.settling.set(self.settling.get() + 1);
        let (view, store, pinned, settling) =
            (self.messages_view.clone(), self.messages_store.clone(), self.pinned.clone(), self.settling.clone());
        glib::timeout_add_local_once(std::time::Duration::from_millis(120), move || {
            let n = store.n_items();
            if pinned.get() && n > 0 {
                view.scroll_to(n - 1, gtk::ListScrollFlags::NONE, None);
            }
            settling.set(settling.get() - 1);
        });
    }

    pub fn open_room(self: &Rc<Self>, rid: &str) {
        let Some(session) = self.session.borrow().clone() else { return };
        let Some(room) = self.rooms.borrow().iter().find(|r| r.rid == rid).cloned() else { return };
        if self.current.borrow().as_ref().is_some_and(|c| c.rid == rid) {
            self.split.set_show_content(true);
            return;
        }
        self.current.replace(Some(OpenRoom {
            rid: room.rid.clone(),
            kind: room.kind.clone(),
            name: room.name.clone(),
            read_only: room.read_only,
        }));
        let index = self.rooms.borrow().iter().position(|r| r.rid == rid);
        if let Some(i) = index
            && self.rooms_selection.selected() != i as u32
        {
            self.suppress_selection.set(true);
            self.rooms_selection.set_selected(i as u32);
            self.suppress_selection.set(false);
        }
        self.refresh_room_header();
        self.content_stack.set_visible_child_name("room");
        self.split.set_show_content(true);
        for f in self.on_room_changed.borrow().iter() {
            f(Some(room.name.clone()));
        }

        self.limit.set(HISTORY_PAGE);
        self.has_older.set(true);
        self.pinned.set(true);
        self.messages.replace(Vec::new());
        self.messages_store.remove_all();
        self.reload_messages();
        self.composer.grab_focus();

        self.loading.set(true);
        let weak = Rc::downgrade(self);
        let (rid, kind) = (room.rid, room.kind);
        glib::spawn_future_local(async move {
            let page = crate::on_tokio({
                let (rid, kind) = (rid.clone(), kind.clone());
                async move { session.open_room(&rid, &kind).await }
            })
            .await;
            let Some(this) = weak.upgrade() else { return };
            if this.current.borrow().as_ref().is_some_and(|c| c.rid == rid) {
                if let Ok(page) = page {
                    this.has_older.set(page.count as i64 >= HISTORY_PAGE);
                }
                this.loading.set(false);
                this.scroll_to_bottom();
            }
        });
    }

    fn load_older(self: &Rc<Self>) {
        if self.loading.get() || !self.has_older.get() {
            return;
        }
        let Some(open) = self.current.borrow().clone() else { return };
        let Some(session) = self.session.borrow().clone() else { return };
        let Some(oldest) = self.messages.borrow().first().map(|d| d.row.ts) else { return };
        self.loading.set(true);
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let (rid, kind) = (open.rid.clone(), open.kind.clone());
            let page = crate::on_tokio(async move { session.sync.load_history(&rid, &kind, Some(oldest)).await }).await;
            let Some(this) = weak.upgrade() else { return };
            if this.current.borrow().as_ref().is_some_and(|c| c.rid == open.rid)
                && let Ok(page) = page
            {
                // `inclusive` returns the boundary message again: one row means nothing older.
                if page.count <= 1 {
                    this.has_older.set(false);
                }
                this.limit.set(this.limit.get() + HISTORY_PAGE);
                this.reload_messages();
            }
            this.loading.set(false);
        });
    }

    fn send_composer(&self) {
        let buffer = self.composer.buffer();
        let text = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string();
        if text.trim().is_empty() {
            return;
        }
        buffer.set_text("");
        self.send_text(&text);
    }

    pub fn send_text(&self, text: &str) {
        let Some(open) = self.current.borrow().clone() else { return };
        let Some(session) = self.session.borrow().clone() else { return };
        let text = text.to_owned();
        runtime().spawn(async move { session.send(&open.rid, &text).await });
    }

    fn retry(&self, id: String) {
        if let Some(session) = self.session.borrow().clone() {
            runtime().spawn(async move { session.retry(&id).await });
        }
    }
}
