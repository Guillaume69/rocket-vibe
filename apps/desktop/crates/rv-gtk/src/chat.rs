use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use chrono::{DateTime, Local, TimeZone};
use gtk::{gdk, gio, glib, pango};
use rv_core::diff::diff_sorted;
use rv_core::media::{AvatarTarget, ImageAttachment, avatar_path, display_size, image_attachments};
use rv_core::session::{Connection, Session};
use rv_core::store::{Change, MessageRow, RoomRow};
use rv_core::sync::HISTORY_PAGE;
use serde_json::Value;

use crate::widgets::{self, TileSize};
use crate::{media, runtime};

const GROUPING_GAP_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Display {
    row: MessageRow,
    show_header: bool,
    show_day: bool,
    /// A continuation row whose minute differs from the row above: the time
    /// goes in the avatar gutter.
    gutter_time: bool,
}

#[derive(Debug, Clone)]
struct OpenRoom {
    rid: String,
    kind: String,
    name: String,
    read_only: bool,
    encrypted: bool,
    avatar: Option<String>,
}

type Callback<T> = RefCell<Vec<Box<dyn Fn(T)>>>;

pub struct ChatPage {
    split: adw::NavigationSplitView,
    account_name: gtk::Label,
    account_host: gtk::Label,
    account_tile: gtk::Box,
    status_dot: gtk::Box,
    comets: Vec<gtk::Box>,
    connection: Cell<Connection>,
    room_title: gtk::Box,
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
    session: Rc<RefCell<Option<Arc<Session>>>>,
    current: RefCell<Option<OpenRoom>>,
    limit: Cell<i64>,
    loading: Cell<bool>,
    has_older: Cell<bool>,
    pinned: Rc<Cell<bool>>,
    /// Refreshes whose scroll adjustments are ours, not the user's.
    settling: Rc<Cell<u32>>,
    on_logout: Callback<()>,
    on_room_changed: Callback<Option<String>>,
    on_rooms_loaded: Callback<()>,
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
    // Images are drawn, not labelled: only other files get a 📎 line.
    list.iter().filter(|a| a.get("image_url").is_none()).find_map(|a| {
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
        let minute = |ts: i64| local(ts).format("%Y%m%d%H%M").to_string();
        let gutter_time = out.last().is_some_and(|prev| minute(prev.row.ts) != minute(row.ts));
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
        out.push(Display { gutter_time: gutter_time && !show_header, row, show_header, show_day });
    }
    out
}

fn label(text: &str, classes: &[&str]) -> gtk::Label {
    gtk::Label::builder().label(text).xalign(0.0).css_classes(classes.to_vec()).build()
}

/// A gradient tile that receives the real photo once (and if) it loads.
fn with_photo(tile: gtk::Widget, session: Option<&Arc<Session>>, path: Option<String>) -> gtk::Widget {
    if let (Some(session), Some(path)) = (session, path) {
        let weak = tile.downgrade();
        media::load(session, &path, move |texture| {
            if let Some(tile) = weak.upgrade() {
                widgets::set_photo(&tile, texture);
            }
        });
    }
    tile
}

/// DM: the other person's photo by uid; channel or group: the room's photo.
/// A locked encrypted room keeps its grey padlock.
fn room_avatar_path(r: &RoomRow) -> Option<String> {
    if r.encrypted {
        return None;
    }
    match (r.kind.as_str(), &r.dm_other_uid) {
        ("d", Some(uid)) => Some(avatar_path(AvatarTarget::Uid(uid), None)),
        ("d", None) => None,
        _ => Some(avatar_path(AvatarTarget::Room(&r.rid), r.avatar_etag.as_deref())),
    }
}

fn user_avatar_path(username: &str) -> Option<String> {
    (!username.is_empty()).then(|| avatar_path(AvatarTarget::User(username), None))
}

fn room_tile(name: &str, kind: &str, encrypted: bool, size: TileSize) -> gtk::Widget {
    if encrypted {
        return widgets::tile(name, "🔒", size, true);
    }
    let glyph = if kind == "d" { widgets::initial(name) } else { "#".to_owned() };
    widgets::tile(name, &glyph, size, false)
}

fn open_viewer(parent: &gtk::Widget, texture: &gdk::Texture, title: &str) {
    let picture = gtk::Picture::builder().paintable(texture).content_fit(gtk::ContentFit::Contain).build();
    let page = adw::ToolbarView::new();
    page.add_top_bar(&adw::HeaderBar::new());
    page.set_content(Some(&picture));
    let (w, h) = (texture.width().clamp(320, 1100), texture.height().clamp(240, 800) + 48);
    let dialog = adw::Dialog::builder().title(title).content_width(w).content_height(h).child(&page).build();
    dialog.present(Some(parent));
}

fn image_widget(session: &Arc<Session>, image: &ImageAttachment) -> gtk::Widget {
    let (w, h) = display_size(image.width, image.height, 120, 360, 300);
    let frame = gtk::Overlay::builder()
        .css_classes(["image-attachment"])
        .width_request(w)
        .height_request(h)
        .halign(gtk::Align::Start)
        .overflow(gtk::Overflow::Hidden)
        .cursor(&gdk::Cursor::from_name("pointer", None).expect("cursor"))
        .margin_top(4)
        .build();
    frame.set_child(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
    let weak = frame.downgrade();
    media::load(session, &image.source, move |texture| {
        if let Some(frame) = weak.upgrade() {
            let picture =
                gtk::Picture::builder().paintable(texture).content_fit(gtk::ContentFit::Cover).can_shrink(true).build();
            frame.add_overlay(&picture);
        }
    });
    let click = gtk::GestureClick::new();
    let (session, source) = (session.clone(), image.source.clone());
    if let Some(alt) = &image.alt {
        frame.set_tooltip_text(Some(alt));
    }
    let title = image.alt.clone().or_else(|| image.title.clone()).unwrap_or_else(|| "Image".to_owned());
    click.connect_released(move |gesture, _, _, _| {
        let Some(widget) = gesture.widget() else { return };
        let title = title.clone();
        media::load(&session, &source, move |texture| open_viewer(&widget, texture, &title));
    });
    frame.add_controller(click);
    frame.upcast()
}

fn room_widget(r: &RoomRow, session: Option<&Arc<Session>>) -> gtk::Widget {
    let unread = r.unread > 0 || r.alert;
    let name = label(&r.name, &["room-name"]);
    name.set_hexpand(true);
    name.set_ellipsize(pango::EllipsizeMode::End);
    let time = label(&short_time(r.last_ts), &["room-time"]);
    let preview = match (&r.last_message, r.encrypted) {
        (Some(m), _) => label(m, &["room-preview"]),
        (None, true) => label("Encrypted message", &["room-preview", "encrypted"]),
        (None, false) => label("", &["room-preview"]),
    };
    preview.set_hexpand(true);
    preview.set_ellipsize(pango::EllipsizeMode::End);
    preview.set_single_line_mode(true);
    if unread {
        for l in [&name, &time, &preview] {
            l.add_css_class("unread");
        }
    }

    let top = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    top.append(&name);
    top.append(&time);
    let bottom = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    bottom.append(&preview);
    if r.unread > 0 {
        bottom.append(&widgets::unread_badge(r.unread, r.mentions));
    }

    let column = gtk::Box::new(gtk::Orientation::Vertical, 2);
    column.set_hexpand(true);
    column.set_valign(gtk::Align::Center);
    column.append(&top);
    column.append(&bottom);

    let row = gtk::Box::builder().spacing(12).margin_top(9).margin_bottom(9).margin_start(10).margin_end(10).build();
    let tile = with_photo(room_tile(&r.name, &r.kind, r.encrypted, TileSize::Room), session, room_avatar_path(r));
    tile.set_valign(gtk::Align::Center);
    row.append(&tile);
    row.append(&column);
    row.upcast()
}

fn day_label(ts: i64) -> String {
    let day = local(ts).date_naive();
    let today = Local::now().date_naive();
    match (today - day).num_days() {
        0 => "Today".to_owned(),
        1 => "Yesterday".to_owned(),
        _ => local(ts).format("%A %-d %B %Y").to_string(),
    }
}

fn message_widget(
    d: &Display,
    my_id: &str,
    session: Option<&Arc<Session>>,
    on_retry: impl Fn(String) + 'static,
) -> gtk::Widget {
    let row = &d.row;
    let outer = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(2)
        .margin_start(16)
        .margin_end(16)
        .margin_top(if d.show_header { 12 } else { 0 })
        .build();

    if d.show_day {
        let day = gtk::Box::builder().spacing(10).margin_top(10).margin_bottom(6).build();
        for part in 0..3 {
            if part == 1 {
                day.append(&label(&day_label(row.ts), &["day-label"]));
            } else {
                let line =
                    gtk::Box::builder().css_classes(["day-line"]).hexpand(true).valign(gtk::Align::Center).build();
                day.append(&line);
            }
        }
        outer.append(&day);
    }

    let body_text = body_of(row);
    if row.system_type.is_some() {
        let system = label(&body_text, &["system-message"]);
        system.set_wrap(true);
        system.set_margin_start(44);
        system.set_margin_top(2);
        system.set_margin_bottom(2);
        outer.append(&system);
        return outer.upcast();
    }

    let author = row.author.clone().unwrap_or_default();
    let line = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    if d.show_header {
        let tile = widgets::tile(&author, &widgets::initial(&author), TileSize::Message, false);
        line.append(&with_photo(tile, session, user_avatar_path(&author)));
    } else {
        let gutter = gtk::Label::builder()
            .label(if d.gutter_time { local(row.ts).format("%H:%M").to_string() } else { String::new() })
            .css_classes(["gutter-time"])
            .width_request(34)
            .valign(gtk::Align::Start)
            .margin_top(4)
            .build();
        line.append(&gutter);
    }

    let column = gtk::Box::new(gtk::Orientation::Vertical, 2);
    column.set_hexpand(true);
    if d.show_header {
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 7);
        let name = label(&author, &["author"]);
        if row.author_id == my_id {
            name.add_css_class("mine");
        }
        header.append(&name);
        let time = label(&local(row.ts).format("%H:%M").to_string(), &["message-time"]);
        time.set_valign(gtk::Align::Baseline);
        header.append(&time);
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
    if !body_text.is_empty() {
        column.append(&body);
    }
    if let Some(session) = session {
        for image in image_attachments(row.attachments.as_deref()) {
            column.append(&image_widget(session, &image));
            if let Some(caption) = &image.description {
                let caption = label(caption, &["message-body"]);
                caption.set_wrap(true);
                column.append(&caption);
            }
        }
    }

    if row.edited || pending || failed || row.thread_count > 0 {
        let footer = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        if row.thread_count > 0 {
            let n = row.thread_count;
            let chip = label(&format!("💬 {n} {}", if n == 1 { "reply" } else { "replies" }), &["thread-chip"]);
            chip.set_margin_top(3);
            footer.append(&chip);
        }
        if row.edited {
            footer.append(&label("(edited)", &["message-note"]));
        }
        if pending {
            footer.append(&label("⏳ sending…", &["message-note"]));
        }
        if failed {
            let retry = gtk::Button::builder().label("⚠️ Failed, retry").css_classes(["flat", "retry"]).build();
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
        let session: Rc<RefCell<Option<Arc<Session>>>> = Rc::default();
        let room_factory = gtk::SignalListItemFactory::new();
        let shared = session.clone();
        room_factory.connect_bind(move |_, item| {
            let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
            let object = item.item().and_downcast::<glib::BoxedAnyObject>().expect("room");
            item.set_child(Some(&room_widget(&object.borrow::<RoomRow>(), shared.borrow().as_ref())));
        });
        let rooms_view = gtk::ListView::new(Some(rooms_selection.clone()), Some(room_factory));
        rooms_view.add_css_class("rooms");

        let status_dot = gtk::Box::builder()
            .css_classes(["status-dot", "offline"])
            .valign(gtk::Align::Center)
            .halign(gtk::Align::Center)
            .build();
        let status_button = gtk::Button::builder()
            .child(&status_dot)
            .css_classes(["flat"])
            .tooltip_text("Offline, click to reconnect")
            .build();
        let logout = gtk::Button::builder()
            .icon_name("system-log-out-symbolic")
            .css_classes(["flat"])
            .tooltip_text("Sign out")
            .build();
        let brand = gtk::Box::builder().spacing(8).build();
        brand.append(&gtk::Label::builder().label("🦄").css_classes(["unicorn-header"]).build());
        brand.append(&widgets::brand("brand-header"));
        let sidebar_header = adw::HeaderBar::builder().show_end_title_buttons(false).build();
        sidebar_header.set_title_widget(Some(&brand));
        sidebar_header.pack_start(&status_button);
        sidebar_header.pack_end(&logout);
        let sidebar_comet = widgets::comet();

        let account_tile = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        let account_name = label("", &["account-name"]);
        let account_host = label("", &["account-host"]);
        let account_text =
            gtk::Box::builder().orientation(gtk::Orientation::Vertical).valign(gtk::Align::Center).build();
        account_text.append(&account_name);
        account_text.append(&account_host);
        let account = gtk::Box::builder().spacing(10).css_classes(["account"]).build();
        account.append(&account_tile);
        account.append(&account_text);

        let sidebar_toolbar = adw::ToolbarView::new();
        sidebar_toolbar.add_top_bar(&sidebar_header);
        sidebar_toolbar.add_top_bar(&sidebar_comet);
        sidebar_toolbar.set_content(Some(
            &gtk::ScrolledWindow::builder()
                .hscrollbar_policy(gtk::PolicyType::Never)
                .child(&rooms_view)
                .margin_top(6)
                .build(),
        ));
        sidebar_toolbar.add_bottom_bar(&account);
        let sidebar_page = adw::NavigationPage::new(&sidebar_toolbar, "rocket-vibe");

        let messages_store = gio::ListStore::new::<glib::BoxedAnyObject>();
        let messages_view =
            gtk::ListView::new(Some(gtk::NoSelection::new(Some(messages_store.clone()))), None::<gtk::ListItemFactory>);
        let messages_scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .child(&messages_view)
            .build();

        let composer = gtk::TextView::builder()
            .wrap_mode(gtk::WrapMode::WordChar)
            .accepts_tab(false)
            .hexpand(true)
            .valign(gtk::Align::Center)
            .top_margin(0)
            .bottom_margin(0)
            .build();
        // `External`: still scrolls past 160 px, but without a scrollbar whose
        // minimum height would make a one-line composer twice as tall.
        let composer_scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vscrollbar_policy(gtk::PolicyType::External)
            .propagate_natural_height(true)
            .max_content_height(160)
            .child(&composer)
            .hexpand(true)
            .build();
        let composer_pill =
            gtk::Box::builder().css_classes(["composer-pill"]).hexpand(true).valign(gtk::Align::End).build();
        composer_pill.append(&composer_scroll);
        let send = gtk::Button::builder()
            .child(&widgets::send_arrow())
            .tooltip_text("Send")
            .css_classes(["send"])
            .valign(gtk::Align::End)
            .build();
        let composer_bar =
            gtk::Box::builder().spacing(10).margin_top(10).margin_bottom(12).margin_start(14).margin_end(14).build();
        composer_bar.append(&composer_pill);
        composer_bar.append(&send);
        let read_only_label = gtk::Label::builder()
            .label("This room is read-only.")
            .css_classes(["dim-label"])
            .margin_top(14)
            .margin_bottom(14)
            .visible(false)
            .build();

        let room_title = gtk::Box::builder().spacing(10).build();
        let room_header = adw::HeaderBar::new();
        room_header.set_title_widget(Some(&room_title));
        let room_comet = widgets::comet();
        let room_view = adw::ToolbarView::new();
        room_view.add_top_bar(&room_header);
        room_view.add_top_bar(&room_comet);
        room_view.set_content(Some(&messages_scroll));
        let bottom = gtk::Box::new(gtk::Orientation::Vertical, 0);
        bottom.append(&composer_bar);
        bottom.append(&read_only_label);
        room_view.add_bottom_bar(&bottom);

        let empty = adw::ToolbarView::new();
        empty.add_top_bar(&adw::HeaderBar::builder().show_title(false).build());
        let empty_content = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(6)
            .valign(gtk::Align::Center)
            .halign(gtk::Align::Center)
            .build();
        empty_content.append(&gtk::Label::builder().label("🦄").css_classes(["unicorn-hero"]).build());
        empty_content.append(&gtk::Label::builder().label("Pick a conversation").css_classes(["empty-title"]).build());
        empty_content.append(
            &gtk::Label::builder().label("Everything is synced and sparkling ✨").css_classes(["empty-hint"]).build(),
        );
        empty.set_content(Some(&empty_content));
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
            account_name,
            account_host,
            account_tile,
            status_dot,
            comets: vec![sidebar_comet, room_comet],
            connection: Cell::new(Connection::Offline),
            room_title,
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
            session,
            current: RefCell::default(),
            limit: Cell::new(HISTORY_PAGE),
            loading: Cell::new(false),
            has_older: Cell::new(true),
            pinned: Rc::new(Cell::new(true)),
            settling: Rc::new(Cell::new(0)),
            on_logout: RefCell::default(),
            on_room_changed: RefCell::default(),
            on_rooms_loaded: RefCell::default(),
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
            let session = this.session.borrow().clone();
            let my_id = session.as_ref().map(|s| s.info.user_id.clone()).unwrap_or_default();
            let w2 = w.clone();
            let widget = message_widget(&object.borrow::<Display>(), &my_id, session.as_ref(), move |id| {
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

    pub fn connect_rooms_loaded(&self, f: impl Fn() + 'static) {
        self.on_rooms_loaded.borrow_mut().push(Box::new(move |()| f()));
    }

    pub fn set_session(&self, session: Option<Arc<Session>>) {
        if let Some(s) = &session {
            let host = url::Url::parse(&s.info.base_url).ok().and_then(|u| u.host_str().map(str::to_owned));
            self.account_name.set_label(&s.info.username);
            self.account_host.set_label(&host.unwrap_or_default());
            while let Some(child) = self.account_tile.first_child() {
                self.account_tile.remove(&child);
            }
            let tile = widgets::tile(&s.info.username, &widgets::initial(&s.info.username), TileSize::Message, false);
            let tile = with_photo(tile, Some(s), user_avatar_path(&s.info.username));
            self.account_tile.append(&tile);
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
        self.connection.set(c);
        self.update_comets();
    }

    fn set_loading(&self, loading: bool) {
        self.loading.set(loading);
        self.update_comets();
    }

    fn update_comets(&self) {
        let active = self.loading.get() || self.connection.get() != Connection::Online;
        for comet in &self.comets {
            if active {
                comet.add_css_class("active");
            } else {
                comet.remove_css_class("active");
            }
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
                open.avatar = room_avatar_path(r);
            }
            self.rooms.replace(rows);
            self.refresh_room_header();
        }
        if !self.rooms.borrow().is_empty() {
            for f in self.on_rooms_loaded.borrow().iter() {
                f(());
            }
        }
    }

    fn refresh_room_header(&self) {
        let Some(open) = self.current.borrow().clone() else { return };
        self.content_page.set_title(&open.name);
        while let Some(child) = self.room_title.first_child() {
            self.room_title.remove(&child);
        }
        let tile = room_tile(&open.name, &open.kind, open.encrypted, TileSize::Header);
        self.room_title.append(&with_photo(tile, self.session.borrow().as_ref(), open.avatar.clone()));
        self.room_title.append(&label(&open.name, &["room-title"]));
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
            encrypted: room.encrypted,
            avatar: room_avatar_path(&room),
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

        self.set_loading(true);
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
                this.set_loading(false);
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
        self.set_loading(true);
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
            this.set_loading(false);
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

    pub fn room_named(&self, name: &str) -> Option<String> {
        self.rooms.borrow().iter().find(|r| r.name == name).map(|r| r.rid.clone())
    }

    pub fn message_count(&self) -> usize {
        self.messages.borrow().len()
    }

    pub fn message_texts(&self) -> Vec<String> {
        self.messages.borrow().iter().map(|d| d.row.text.clone().unwrap_or_default()).collect()
    }

    pub fn room_count(&self) -> usize {
        self.rooms.borrow().len()
    }
}
