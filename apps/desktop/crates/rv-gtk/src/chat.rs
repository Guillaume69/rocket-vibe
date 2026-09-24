use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::{gdk, gio, glib};
use rv_core::session::{Connection, Session};
use rv_core::store::{Change, RoomRow};
use rv_core::sync::HISTORY_PAGE;

use crate::composer::Composer;
use crate::i18n::{t, tf};
use crate::message_list::MessageList;
use crate::rows::{RowEvent, label, room_avatar_path, room_tile, room_widget, user_avatar_path, with_photo};
use crate::runtime;
use crate::thread::ThreadPage;
use crate::widgets::Handler;
use crate::widgets::{self, TileSize};
use crate::{actions_menu, on_tokio};

#[derive(Debug, Clone)]
struct OpenRoom {
    rid: String,
    kind: String,
    name: String,
    read_only: bool,
    encrypted: bool,
    avatar: Option<String>,
    slug: Option<String>,
    dm_other_uid: Option<String>,
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
    typing_label: gtk::Label,
    upload_strip: gtk::Box,
    call_button: gtk::Button,
    read_generation: Rc<Cell<u64>>,
    rooms_store: gio::ListStore,
    rooms_selection: gtk::SingleSelection,
    rooms: RefCell<Vec<RoomRow>>,
    suppress_selection: Cell<bool>,
    content_page: adw::NavigationPage,
    content_stack: gtk::Stack,
    room_nav: adw::NavigationView,
    thread: RefCell<Option<Rc<ThreadPage>>>,
    on_toast: Handler<String>,
    list: Rc<MessageList>,
    composer: Rc<Composer>,
    read_only_label: gtk::Label,
    session: Rc<RefCell<Option<Arc<Session>>>>,
    current: RefCell<Option<OpenRoom>>,
    limit: Cell<i64>,
    loading: Cell<bool>,
    has_older: Cell<bool>,
    on_logout: Callback<()>,
    on_room_changed: Callback<Option<String>>,
    on_rooms_loaded: Callback<()>,
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
        let status_button =
            gtk::Button::builder().child(&status_dot).css_classes(["flat"]).tooltip_text(t("rooms.offline")).build();
        let logout = gtk::Button::builder()
            .icon_name("system-log-out-symbolic")
            .css_classes(["flat"])
            .tooltip_text(t("rooms.sign_out"))
            .build();
        let brand = gtk::Box::builder().spacing(8).build();
        brand.append(&gtk::Label::builder().label("🦄").css_classes(["unicorn-header"]).build());
        brand.append(&widgets::brand("brand-header"));
        let sidebar_header = adw::HeaderBar::new();
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

        let list = MessageList::new(session.clone());
        let composer = Composer::new();
        let read_only_label = gtk::Label::builder()
            .label(t("room.read_only"))
            .css_classes(["dim-label"])
            .margin_top(14)
            .margin_bottom(14)
            .visible(false)
            .build();

        let room_title = gtk::Box::builder().spacing(10).build();
        let room_header = adw::HeaderBar::new();
        room_header.set_title_widget(Some(&room_title));
        let call_button = gtk::Button::builder()
            .icon_name("camera-video-symbolic")
            .css_classes(["flat"])
            .tooltip_text(t("room.call"))
            .visible(false)
            .build();
        room_header.pack_end(&call_button);
        let upload_strip = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(4)
            .css_classes(["upload-strip"])
            .visible(false)
            .build();
        let typing_label = gtk::Label::builder().xalign(0.0).css_classes(["typing"]).visible(false).build();
        let room_comet = widgets::comet();
        let room_view = adw::ToolbarView::new();
        room_view.add_top_bar(&room_header);
        room_view.add_top_bar(&room_comet);
        // The composer is content, not a bottom bar: libadwaita wraps bars in a
        // GtkWindowHandle, where a double click maximizes the window.
        let room_content = gtk::Box::new(gtk::Orientation::Vertical, 0);
        room_content.append(&list.scroll);
        room_content.append(&upload_strip);
        room_content.append(&typing_label);
        let drop = gtk::DropTarget::new(gdk::FileList::static_type(), gdk::DragAction::COPY);
        room_content.add_controller(drop.clone());
        room_content.append(&composer.root);
        room_content.append(&read_only_label);
        room_view.set_content(Some(&room_content));

        let empty = adw::ToolbarView::new();
        empty.add_top_bar(&adw::HeaderBar::builder().show_title(false).build());
        let empty_content = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(6)
            .valign(gtk::Align::Center)
            .halign(gtk::Align::Center)
            .build();
        empty_content.append(&gtk::Label::builder().label("🦄").css_classes(["unicorn-hero"]).build());
        empty_content.append(&gtk::Label::builder().label(t("room.pick")).css_classes(["empty-title"]).build());
        empty_content.append(&gtk::Label::builder().label(t("room.synced")).css_classes(["empty-hint"]).build());
        empty.set_content(Some(&empty_content));
        let content_stack = gtk::Stack::new();
        content_stack.add_named(&empty, Some("empty"));
        let room_nav = adw::NavigationView::new();
        room_nav.add(&adw::NavigationPage::builder().child(&room_view).title("room").tag("room").build());
        content_stack.add_named(&room_nav, Some("room"));
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
            typing_label,
            upload_strip,
            call_button,
            read_generation: Rc::default(),
            rooms_store,
            rooms_selection,
            rooms: RefCell::default(),
            suppress_selection: Cell::new(false),
            content_page,
            content_stack,
            room_nav,
            thread: RefCell::default(),
            on_toast: RefCell::default(),
            list,
            composer,
            read_only_label,
            session,
            current: RefCell::default(),
            limit: Cell::new(HISTORY_PAGE),
            loading: Cell::new(false),
            has_older: Cell::new(true),
            on_logout: RefCell::default(),
            on_room_changed: RefCell::default(),
            on_rooms_loaded: RefCell::default(),
        });
        this.wire(&status_button, &logout);
        let weak = Rc::downgrade(&this);
        drop.connect_drop(move |_, value, _, _| {
            let (Some(this), Ok(list)) = (weak.upgrade(), value.get::<gdk::FileList>()) else { return false };
            let picked = crate::attach::from_files(&list.files());
            let droppable = !picked.is_empty() && this.current.borrow().as_ref().is_some_and(|o| !o.read_only);
            if droppable {
                this.attach_files(picked);
            }
            droppable
        });
        let weak = Rc::downgrade(&this);
        rooms_view.connect_activate(move |_, position| {
            let Some(this) = weak.upgrade() else { return };
            let rid = this.rooms.borrow().get(position as usize).map(|r| r.rid.clone());
            if let Some(rid) = rid {
                this.open_room(&rid);
            }
        });
        this
    }

    fn wire(self: &Rc<Self>, status_button: &gtk::Button, logout: &gtk::Button) {
        let weak = Rc::downgrade(self);
        let w = weak.clone();
        self.list.connect_event(move |event| {
            if let Some(this) = w.upgrade() {
                this.handle_event(event, false);
            }
        });
        let w = weak.clone();
        self.room_nav.connect_popped(move |_, page| {
            if page.tag().as_deref() == Some("thread")
                && let Some(this) = w.upgrade()
            {
                this.thread.replace(None);
            }
        });
        let w = weak.clone();
        self.list.connect_top_reached(move || {
            if let Some(this) = w.upgrade() {
                this.load_older();
            }
        });
        let w = weak.clone();
        self.call_button.connect_clicked(move |_| {
            let Some(this) = w.upgrade() else { return };
            let (Some(session), Some(rid)) = (this.session(), this.current_rid()) else { return };
            let weak = Rc::downgrade(&this);
            glib::spawn_future_local(async move {
                let url = on_tokio(async move { session.start_call(&rid).await }).await;
                let Some(this) = weak.upgrade() else { return };
                match url {
                    Ok(url) => crate::cards::open_uri(&this.split, &url),
                    Err(_) => this.toast(t("call.failed").to_owned()),
                }
            });
        });
        let w = weak.clone();
        self.composer.connect_files(move |picked| {
            if let Some(this) = w.upgrade() {
                this.attach_files(picked);
            }
        });
        let w = weak.clone();
        self.composer.connect_submit(move |text| {
            if let Some(this) = w.upgrade() {
                this.send_text(&text);
            }
        });

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
        // Collapsed, the list shows alone: a room left selected there could not
        // be tapped again (no selection change). Back to the list, nothing is
        // selected; widened again, the open room is highlighted again.
        let w = weak.clone();
        self.split.connect_show_content_notify(move |split| {
            if let Some(this) = w.upgrade()
                && split.is_collapsed()
                && !split.shows_content()
            {
                this.select_current(false);
            }
        });
        let w = weak;
        self.split.connect_collapsed_notify(move |split| {
            if let Some(this) = w.upgrade()
                && !split.is_collapsed()
            {
                this.select_current(true);
            }
        });
    }

    pub fn widget(&self) -> &adw::NavigationSplitView {
        &self.split
    }

    pub fn connect_toast(&self, f: impl Fn(String) + 'static) {
        self.on_toast.replace(Some(Rc::new(f)));
    }

    fn toast(&self, text: String) {
        if let Some(toast) = self.on_toast.borrow().clone() {
            toast(text);
        }
    }

    fn handle_event(self: &Rc<Self>, event: RowEvent, in_thread: bool) {
        let Some(session) = self.session.borrow().clone() else { return };
        match event {
            RowEvent::Retry(id) => self.retry(id),
            RowEvent::React { id, shortcode, add } => {
                let weak = Rc::downgrade(self);
                glib::spawn_future_local(async move {
                    if on_tokio(async move { session.react(&id, &shortcode, add).await }).await.is_err()
                        && let Some(this) = weak.upgrade()
                    {
                        this.toast(t("actions.refused").to_owned());
                    }
                });
            }
            RowEvent::OpenThread(root) => self.open_thread(&root),
            RowEvent::JoinCall(call_id) => {
                let weak = Rc::downgrade(self);
                glib::spawn_future_local(async move {
                    let url = on_tokio(async move { session.join_call(&call_id).await }).await;
                    let Some(this) = weak.upgrade() else { return };
                    match url {
                        Ok(url) => crate::cards::open_uri(&this.split, &url),
                        Err(_) => this.toast(t("call.failed").to_owned()),
                    }
                });
            }
            RowEvent::Menu { row, anchor, x, y } => {
                let Some(open) = self.current.borrow().clone() else { return };
                let room = actions_menu::RoomContext {
                    rid: open.rid.clone(),
                    read_only: open.read_only,
                    encrypted: open.encrypted,
                    in_thread,
                };
                let (w1, w2, w3) = (Rc::downgrade(self), Rc::downgrade(self), Rc::downgrade(self));
                let handlers = Rc::new(actions_menu::Handlers {
                    reply: Box::new(move |row| {
                        if let Some(this) = w1.upgrade() {
                            this.start_reply(row, in_thread);
                        }
                    }),
                    thread: Box::new(move |root| {
                        if let Some(this) = w2.upgrade() {
                            this.open_thread(&root);
                        }
                    }),
                    toast: Box::new(move |text| {
                        if let Some(this) = w3.upgrade() {
                            this.toast(text);
                        }
                    }),
                });
                actions_menu::open(&anchor, x, y, session, *row, room, handlers);
            }
        }
    }

    /// Quoting needs the permalink the server recognises, built on `Site_Url`.
    fn start_reply(self: &Rc<Self>, row: rv_core::store::MessageRow, in_thread: bool) {
        let Some(session) = self.session.borrow().clone() else { return };
        let Some(open) = self.current.borrow().clone() else { return };
        let composer = match (in_thread, self.thread.borrow().as_ref()) {
            (true, Some(thread)) => thread.composer.clone(),
            _ => self.composer.clone(),
        };
        let name = row.author.clone().unwrap_or_default();
        let preview = rv_core::actions::copyable_text(row.text.as_deref()).unwrap_or_default().to_owned();
        glib::spawn_future_local(async move {
            let link =
                on_tokio(async move { session.permalink(&open.kind, open.slug.as_deref(), &open.rid, &row.id).await })
                    .await;
            composer.set_reply(&name, &preview, link);
        });
    }

    fn open_thread(self: &Rc<Self>, root_id: &str) {
        let Some(session) = self.session.borrow().clone() else { return };
        let Some(open) = self.current.borrow().clone() else { return };
        if self.thread.borrow().as_ref().is_some_and(|t| t.root_id == root_id) {
            return;
        }
        self.room_nav.pop_to_tag("room");
        let thread = ThreadPage::new(self.session.clone(), &open.rid, root_id, open.read_only);
        let weak = Rc::downgrade(self);
        thread.list.connect_event(move |event| {
            if let Some(this) = weak.upgrade() {
                this.handle_event(event, true);
            }
        });
        let (s, rid, root) = (session.clone(), open.rid.clone(), root_id.to_owned());
        thread.composer.connect_submit(move |text| {
            let (s, rid, root) = (s.clone(), rid.clone(), root.clone());
            runtime().spawn(async move { s.send_in(&rid, &text, Some(&root)).await });
        });
        thread.composer.bind(&session, &open.rid, Some(root_id));
        self.room_nav.push(&thread.page);
        thread.reload();
        thread.composer.grab_focus();
        self.thread.replace(Some(thread.clone()));
        let root = root_id.to_owned();
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let loaded = on_tokio(async move { session.load_thread(&root).await }).await;
            if let Some(this) = weak.upgrade() {
                if loaded.is_err() {
                    this.toast(t("thread.not_found").to_owned());
                }
                thread.reload();
            }
        });
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
        self.list.clear();
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
            Connection::Online => ("online", t("rooms.online")),
            Connection::Connecting => ("connecting", t("rooms.connecting")),
            Connection::Offline => ("offline", t("rooms.offline")),
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
            self.refresh_uploads();
            self.schedule_read();
        }
        let thread = self.thread.borrow().clone();
        if let Some(thread) = thread
            && change.rids.contains(&thread.rid)
        {
            thread.reload();
        }
    }

    /// Marks the open room read a moment after new messages, if I am looking at them.
    fn schedule_read(&self) {
        let generation = self.read_generation.get() + 1;
        self.read_generation.set(generation);
        let (counter, list, split) = (self.read_generation.clone(), self.list.clone(), self.split.clone());
        let (Some(session), Some(rid)) = (self.session.borrow().clone(), self.current_rid()) else { return };
        glib::timeout_add_local_once(std::time::Duration::from_millis(1500), move || {
            let active = split.root().and_downcast::<gtk::Window>().is_some_and(|w| w.is_active());
            let visible = split.shows_content() || !split.is_collapsed();
            if counter.get() == generation && active && visible && list.is_pinned() {
                crate::runtime().spawn(async move { session.mark_read(&rid).await });
            }
        });
    }

    /// Back to the window: what arrived meanwhile in the open room is now seen.
    pub fn window_activated(&self) {
        let unread = self
            .current_rid()
            .and_then(|rid| self.rooms.borrow().iter().find(|r| r.rid == rid).map(|r| r.unread > 0 || r.alert));
        if unread == Some(true) {
            self.schedule_read();
        }
    }

    fn attach_files(self: &Rc<Self>, picked: Vec<crate::attach::Picked>) {
        let (Some(session), Some(rid)) = (self.session(), self.current_rid()) else { return };
        let weak = Rc::downgrade(self);
        let toast: Rc<dyn Fn(String)> = Rc::new(move |text| {
            if let Some(this) = weak.upgrade() {
                this.toast(text);
            }
        });
        crate::attach::confirm(&self.split, session, rid, picked, toast);
    }

    /// Uploads of the open room not settled yet: progress, or Retry and Discard.
    pub fn refresh_uploads(&self) {
        while let Some(child) = self.upload_strip.first_child() {
            self.upload_strip.remove(&child);
        }
        let (Some(session), Some(rid)) = (self.session(), self.current_rid()) else { return };
        let uploads = session.store.uploads(&rid);
        self.upload_strip.set_visible(!uploads.is_empty());
        for upload in uploads {
            let failed = upload.status == "failed";
            let row = gtk::Box::builder().spacing(10).css_classes(["upload-row"]).build();
            if failed {
                row.add_css_class("failed");
            }
            let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).hexpand(true).build();
            let name = label(&upload.name, &["file-title"]);
            name.set_ellipsize(gtk::pango::EllipsizeMode::Middle);
            column.append(&name);
            match session.uploads.progress(&upload.id) {
                Some(fraction) => column.append(&gtk::ProgressBar::builder().fraction(fraction).build()),
                None => {
                    column.append(&label(t(if failed { "upload.failed" } else { "upload.waiting" }), &["file-detail"]))
                }
            }
            row.append(&column);
            if failed {
                let retry = gtk::Button::builder()
                    .label(t("upload.retry"))
                    .css_classes(["file-action"])
                    .valign(gtk::Align::Center)
                    .build();
                let (s, id) = (session.clone(), upload.id.clone());
                retry.connect_clicked(move |_| {
                    let (s, id) = (s.clone(), id.clone());
                    crate::runtime().spawn(async move { s.uploads.retry(&id).await });
                });
                row.append(&retry);
            }
            let discard = gtk::Button::builder()
                .icon_name("window-close-symbolic")
                .tooltip_text(t("upload.discard"))
                .css_classes(["flat", "circular"])
                .valign(gtk::Align::Center)
                .build();
            let (s, id) = (session.clone(), upload.id.clone());
            discard.connect_clicked(move |_| s.uploads.discard(&id));
            row.append(&discard);
            self.upload_strip.append(&row);
        }
    }

    pub fn on_upload(&self, rid: &str) {
        if self.current_rid().as_deref() == Some(rid) {
            self.refresh_uploads();
        }
    }

    pub fn on_typing(&self, rid: &str) {
        if self.current_rid().as_deref() != Some(rid) {
            return;
        }
        let Some(session) = self.session.borrow().clone() else { return };
        let names = session.typing(rid);
        let text = match names.as_slice() {
            [] => String::new(),
            [a] => tf("typing.one", &[("a", a)]),
            [a, b] => tf("typing.two", &[("a", a), ("b", b)]),
            _ => tf("typing.many", &[("n", &names.len().to_string())]),
        };
        self.typing_label.set_visible(!text.is_empty());
        self.typing_label.set_label(&text);
    }

    pub fn on_presence(&self) {
        let n = self.rooms_store.n_items();
        self.rooms_store.items_changed(0, n, n);
        self.refresh_room_header();
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
            self.suppress_selection.set(false);

            if let Some(open) = self.current.borrow_mut().as_mut()
                && let Some(r) = rows.iter().find(|r| r.rid == open.rid)
            {
                open.name = r.name.clone();
                open.read_only = r.read_only;
                open.avatar = room_avatar_path(r);
            }
            self.rooms.replace(rows);
            self.select_current(!(self.split.is_collapsed() && !self.split.shows_content()));
            self.refresh_room_header();
        }
        if !self.rooms.borrow().is_empty() {
            for f in self.on_rooms_loaded.borrow().iter() {
                f(());
            }
        }
    }

    fn select_current(&self, highlight: bool) {
        let current = self.current.borrow().as_ref().map(|r| r.rid.clone());
        let index = current.filter(|_| highlight).and_then(|rid| self.rooms.borrow().iter().position(|r| r.rid == rid));
        self.suppress_selection.set(true);
        self.rooms_selection.set_selected(index.map_or(gtk::INVALID_LIST_POSITION, |i| i as u32));
        self.suppress_selection.set(false);
    }

    fn refresh_room_header(&self) {
        let Some(open) = self.current.borrow().clone() else { return };
        self.content_page.set_title(&open.name);
        while let Some(child) = self.room_title.first_child() {
            self.room_title.remove(&child);
        }
        let tile = room_tile(&open.name, &open.kind, open.encrypted, TileSize::Header);
        self.room_title.append(&with_photo(tile, self.session.borrow().as_ref(), open.avatar.clone()));
        let names = gtk::Box::builder().orientation(gtk::Orientation::Vertical).valign(gtk::Align::Center).build();
        names.append(&label(&open.name, &["room-title"]));
        let presence =
            open.dm_other_uid.as_deref().zip(self.session.borrow().clone()).and_then(|(uid, s)| s.presence(uid));
        if let Some(p) = presence {
            let line = gtk::Box::builder().spacing(5).build();
            let dot = crate::rows::presence_dot(p, &[]);
            dot.set_valign(gtk::Align::Center);
            line.append(&dot);
            line.append(&label(t(&format!("presence.{}", p.as_str())), &["room-subtitle"]));
            names.append(&line);
        }
        self.room_title.append(&names);
        self.composer.root.set_visible(!open.read_only);
        self.read_only_label.set_visible(open.read_only);
    }

    fn reload_messages(&self) {
        let Some(open) = self.current.borrow().clone() else { return };
        let Some(session) = self.session.borrow().clone() else { return };
        self.list.set_rows(session.store.messages(&open.rid, self.limit.get()));
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
            slug: room.slug.clone(),
            dm_other_uid: room.dm_other_uid.clone(),
        }));
        let unread = room.unread > 0 || room.alert;
        let seen = session.store.last_seen(rid).filter(|_| unread);
        self.list.set_unread_after(seen.map(|ls| (ls, session.info.user_id.clone())));
        self.typing_label.set_visible(false);
        self.call_button.set_visible(false);
        if !room.read_only {
            let (weak, s, rid) = (Rc::downgrade(self), session.clone(), rid.to_owned());
            glib::spawn_future_local(async move {
                let available = on_tokio(async move { s.call_available().await }).await;
                if let Some(this) = weak.upgrade()
                    && this.current_rid().as_deref() == Some(rid.as_str())
                {
                    this.call_button.set_visible(available);
                }
            });
        }
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
        self.room_nav.pop_to_tag("room");
        self.thread.replace(None);
        self.composer.clear_reply();
        self.composer.bind(&session, rid, None);
        self.list.clear();
        self.reload_messages();
        self.refresh_uploads();
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
                this.list.scroll_to_bottom();
            }
        });
    }

    fn load_older(self: &Rc<Self>) {
        if self.loading.get() || !self.has_older.get() {
            return;
        }
        let Some(open) = self.current.borrow().clone() else { return };
        let Some(session) = self.session.borrow().clone() else { return };
        let Some(oldest) = self.list.oldest_ts() else { return };
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
        self.list.len()
    }

    /// What a tap on the room's row does: select it in the list.
    pub fn tap_room(&self, rid: &str) {
        let index = self.rooms.borrow().iter().position(|r| r.rid == rid);
        if let Some(i) = index {
            self.rooms_selection.set_selected(i as u32);
        }
    }

    pub fn go_back(&self) {
        self.split.set_show_content(false);
    }

    pub fn shows_room(&self) -> bool {
        !self.split.is_collapsed() || self.split.shows_content()
    }

    /// Plays a row event as a click would.
    pub fn play(self: &Rc<Self>, event: RowEvent, in_thread: bool) {
        self.handle_event(event, in_thread);
    }

    pub fn start_quote(self: &Rc<Self>, row: rv_core::store::MessageRow) {
        self.start_reply(row, false);
    }

    pub fn open_thread_of(self: &Rc<Self>, root_id: &str) {
        self.open_thread(root_id);
    }

    pub fn thread(&self) -> Option<Rc<ThreadPage>> {
        self.thread.borrow().clone()
    }

    pub fn session(&self) -> Option<Arc<Session>> {
        self.session.borrow().clone()
    }

    pub fn current_rid(&self) -> Option<String> {
        self.current.borrow().as_ref().map(|o| o.rid.clone())
    }

    pub fn composer(&self) -> &Composer {
        &self.composer
    }

    pub fn typing_text(&self) -> Option<String> {
        self.typing_label.is_visible().then(|| self.typing_label.label().to_string())
    }

    pub fn header_presence(&self) -> Option<String> {
        let open = self.current.borrow().clone()?;
        let session = self.session.borrow().clone()?;
        session.presence(open.dm_other_uid.as_deref()?).map(|p| p.as_str().to_owned())
    }

    pub fn has_new_marker(&self) -> bool {
        self.list.has_new_marker()
    }

    pub fn message_texts(&self) -> Vec<String> {
        self.list.texts()
    }

    pub fn room_count(&self) -> usize {
        self.rooms.borrow().len()
    }
}
