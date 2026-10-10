use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::{gdk, gio, glib};
use rv_core::context::Window;
use rv_core::rooms::Section;
use rv_core::session::{Connection, Session};
use rv_core::store::{Change, MessageRow, RoomRow};
use rv_core::sync::HISTORY_PAGE;

use crate::composer::Composer;
use crate::i18n::{t, tf};
use crate::message_list::MessageList;
use crate::rows::{RowEvent, label, room_avatar_path, room_tile, with_photo};
use crate::runtime;
use crate::thread::ThreadPage;
use crate::widgets::Handler;
use crate::widgets::{self, TileSize};
use crate::{actions_menu, on_tokio};

#[path = "chat_crypto.rs"]
mod crypto;
#[path = "chat_native.rs"]
mod native;
#[path = "chat_quotes.rs"]
mod quotes;
#[path = "chat_voice.rs"]
mod voice;

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

/// A row of the room list: a section title, or a room.
enum RoomItem {
    Header { section: Section, title: String, collapsed: bool, count: usize },
    Room(Box<RoomRow>),
}

/// A row of an action menu: its icon, its words, what it does.
pub(crate) type MenuItem = (&'static str, String, Rc<dyn Fn()>);
/// A section's "+": its tooltip, what it does.
type SectionAdd = (&'static str, Rc<dyn Fn()>);

/// A menu of rows in a popover, each closing it before it runs: the account
/// menu and the "+" menu of the room list.
pub(crate) fn action_popover(items: Vec<MenuItem>) -> gtk::Popover {
    let list = gtk::Box::builder().orientation(gtk::Orientation::Vertical).css_classes(["action-menu"]).build();
    let popover = gtk::Popover::builder().child(&list).has_arrow(false).build();
    for item in items {
        list.append(&menu_row(&popover, item));
    }
    popover
}

fn menu_row(popover: &gtk::Popover, (icon, text, run): MenuItem) -> gtk::Button {
    let content = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    content.append(&gtk::Image::from_icon_name(icon));
    content.append(&gtk::Label::builder().label(&text).xalign(0.0).build());
    let button = gtk::Button::builder().child(&content).css_classes(["flat", "action-menu-row"]).build();
    let weak = popover.downgrade();
    button.connect_clicked(move |_| {
        if let Some(popover) = weak.upgrade() {
            popover.popdown();
        }
        run();
    });
    button
}

/// A section title that folds its rooms away; folded, it tells how many there are.
/// `add`, on Channels and Direct messages: a "+" creating one there.
fn section_header(title: &str, collapsed: bool, count: usize, add: Option<SectionAdd>) -> gtk::Box {
    let header = gtk::Box::builder().spacing(4).css_classes(["section-header"]).build();
    header.set_cursor(gdk::Cursor::from_name("pointer", None).as_ref());
    let chevron = gtk::Image::from_icon_name(if collapsed { "pan-end-symbolic" } else { "pan-down-symbolic" });
    chevron.add_css_class("section-chevron");
    header.append(&chevron);
    header.append(&label(title, &["section-title"]));
    if collapsed {
        header.append(&label(&count.to_string(), &["section-count"]));
    }
    if let Some((tooltip, run)) = add {
        let spacer = gtk::Box::builder().hexpand(true).build();
        header.append(&spacer);
        let plus = gtk::Button::builder()
            .icon_name("list-add-symbolic")
            .tooltip_text(tooltip)
            .css_classes(["flat", "section-add"])
            .valign(gtk::Align::Center)
            .build();
        plus.connect_clicked(move |_| run());
        header.append(&plus);
    }
    header
}

fn collapsed_file() -> std::path::PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs").join("collapsed-sections")
}

/// A right click on a room offers to star it, or to take the star away, and
/// on Rocket.Chat to mark it unread, or read when something in it is unread
/// (`mark` gets the rid and whether to mark it unread).
fn room_menu(widget: &gtk::Widget, session: Arc<Session>, room: &RoomRow, mark: Rc<Handler<(String, bool)>>) {
    let click = gtk::GestureClick::builder().button(gdk::BUTTON_SECONDARY).build();
    let (target, rid, favorite) = (widget.downgrade(), room.rid.clone(), room.favorite);
    let unread = room.unread > 0 || room.alert;
    click.connect_pressed(move |gesture, _, x, y| {
        let Some(widget) = target.upgrade() else { return };
        gesture.set_state(gtk::EventSequenceState::Claimed);
        let (s, r) = (session.clone(), rid.clone());
        let star: Rc<dyn Fn()> = Rc::new(move || {
            let (session, rid) = (s.clone(), r.clone());
            glib::spawn_future_local(async move {
                if let Err(e) = on_tokio(async move { session.set_favorite(&rid, !favorite).await }).await {
                    eprintln!("Favorite not changed: {e}");
                }
            });
        });
        let mut items: Vec<MenuItem> = vec![(
            if favorite { "non-starred-symbolic" } else { "starred-symbolic" },
            t(if favorite { "rooms.favorite_remove" } else { "rooms.favorite_add" }).to_owned(),
            star,
        )];
        if session.unread_marks_available() {
            let (mark, r) = (mark.clone(), rid.clone());
            items.push((
                if unread { "mail-read-symbolic" } else { "mail-unread-symbolic" },
                t(if unread { "rooms.mark_read" } else { "rooms.mark_unread" }).to_owned(),
                Rc::new(move || {
                    if let Some(mark) = mark.borrow().clone() {
                        mark((r.clone(), !unread));
                    }
                }),
            ));
        }
        let popover = action_popover(items);
        popover.set_parent(&widget);
        popover.set_pointing_to(Some(&gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
        popover.connect_closed(|p| p.unparent());
        popover.popup();
    });
    widget.add_controller(click);
}

fn load_collapsed() -> Vec<String> {
    let saved = std::fs::read_to_string(collapsed_file()).unwrap_or_default();
    saved.lines().filter(|l| !l.is_empty()).map(str::to_owned).collect()
}

pub struct ChatPage {
    native: Rc<RefCell<Option<Arc<rv_core::native::NativeSession>>>>,
    native_forward: RefCell<Option<tokio::task::JoinHandle<()>>>,
    native_edit: RefCell<Option<(String, String, String)>>,
    native_crypto: RefCell<Option<rv_core::native::crypto::enrollment::rooms::messages::Access>>,
    native_crypto_ready: Cell<bool>,
    native_crypto_restored: Cell<bool>,
    /// A refresh asked while another load was running: it runs again once
    /// that one ends, or a message just sent waits for the next event to show.
    native_crypto_stale: Cell<bool>,
    native_crypto_rows: RefCell<Vec<rv_core::store::MessageRow>>,
    native_crypto_meta: RefCell<Vec<(String, String, Option<String>)>>,
    native_quote_cards: Rc<crate::native_quote_cards::QuoteCards>,
    native_membership: RefCell<Option<(String, Option<String>)>>,
    native_unread_after: RefCell<Option<String>>,
    native_read_pending: Rc<Cell<bool>>,
    native_read_last: Rc<RefCell<Option<String>>>,
    search_button: gtk::Button,
    /// Search across rooms, on the device (Rocket.Chat and Mattermost).
    local_search_button: gtk::Button,
    marked_button: gtk::Button,
    /// The room's threads (Rocket.Chat only).
    threads_button: gtk::Button,
    root: gtk::Overlay,
    split: adw::NavigationSplitView,
    update_slot: gtk::Box,
    account_name: gtk::Label,
    account_host: gtk::Label,
    account_tile: gtk::Box,
    status_dot: gtk::Box,
    comet: gtk::Box,
    connection: Cell<Connection>,
    room_title: gtk::Box,
    typing_label: gtk::Label,
    upload_strip: gtk::Box,
    call_button: gtk::Button,
    read_generation: Rc<Cell<u64>>,
    rooms_store: gio::ListStore,
    rooms_selection: gtk::SingleSelection,
    rooms: RefCell<Vec<RoomRow>>,
    /// The open quick switcher, so a second Ctrl+K does not stack another.
    switcher: glib::WeakRef<adw::Dialog>,
    /// The rid shown at each position of the list; None for a section title.
    slots: RefCell<Vec<Option<String>>>,
    /// Sections folded in the room list, remembered across launches.
    collapsed: RefCell<Vec<String>>,
    on_unread: Callback<usize>,
    suppress_selection: Cell<bool>,
    content_page: adw::NavigationPage,
    content_stack: gtk::Stack,
    room_nav: adw::NavigationView,
    thread: RefCell<Option<Rc<ThreadPage>>>,
    on_toast: Handler<String>,
    list: Rc<MessageList>,
    composer: Rc<Composer>,
    read_only_label: gtk::Label,
    e2e_banner: gtk::Box,
    e2e_unlock: gtk::Button,
    session: Rc<RefCell<Option<Arc<Session>>>>,
    current: RefCell<Option<OpenRoom>>,
    limit: Cell<i64>,
    loading: Cell<bool>,
    has_older: Cell<bool>,
    /// Old history around a message reached from elsewhere, shown instead of the local one.
    context: RefCell<Option<Window>>,
    on_logout: Callback<()>,
    /// Whether the open account administers its server, once asked (the account menu).
    administrator: Cell<Option<bool>>,
    /// The account menu is shown: a click on the block does not stack another.
    menu_open: Rc<Cell<bool>>,
    on_room_changed: Callback<Option<String>>,
    on_room_opened: Callback<String>,
    on_user_navigation: RefCell<Vec<Box<dyn Fn()>>>,
    account_actions: RefCell<Option<Rc<crate::settings::AccountActions>>>,
    on_rooms_loaded: Callback<()>,
    forward_button: gtk::Button,
    /// Rooms opened, oldest first, and the position of the open one: mouse back and forward walk it.
    history: RefCell<Vec<String>>,
    history_at: Cell<usize>,
    walking: Cell<bool>,
    voice: Rc<voice::VoiceUi>,
}

impl ChatPage {
    pub fn new() -> Rc<Self> {
        let rooms_store = gio::ListStore::new::<glib::BoxedAnyObject>();
        let rooms_selection = gtk::SingleSelection::new(Some(rooms_store.clone()));
        rooms_selection.set_autoselect(false);
        rooms_selection.set_can_unselect(true);
        let session: Rc<RefCell<Option<Arc<Session>>>> = Rc::default();
        let native_session: Rc<RefCell<Option<Arc<rv_core::native::NativeSession>>>> = Rc::default();
        let room_factory = gtk::SignalListItemFactory::new();
        let shared = session.clone();
        let native_shared = native_session.clone();
        let toggle_section: Rc<Handler<Section>> = Rc::default();
        let toggler = toggle_section.clone();
        // The "+" of a section header: set once the page exists.
        let add_in_section: Rc<Handler<Section>> = Rc::default();
        let adder = add_in_section.clone();
        // A room marked unread or read from its menu: set once the page exists.
        let mark_room: Rc<Handler<(String, bool)>> = Rc::default();
        let marker = mark_room.clone();
        let voice_ui = voice::VoiceUi::new();
        let binder = voice_ui.clone();
        room_factory.connect_bind(move |_, item| {
            let item = item.downcast_ref::<gtk::ListItem>().expect("list item");
            let object = item.item().and_downcast::<glib::BoxedAnyObject>().expect("room");
            let entry = object.borrow::<RoomItem>();
            match &*entry {
                RoomItem::Header { section, title, collapsed, count } => {
                    item.set_selectable(false);
                    item.set_activatable(true);
                    let add = match section {
                        Section::Channels if native_shared.borrow().is_some() => Some(t("rooms.new_channel")),
                        Section::Direct => Some(t("rooms.new_message")),
                        _ => None,
                    }
                    .map(|tooltip| {
                        let (adder, section) = (adder.clone(), section.clone());
                        let run: Rc<dyn Fn()> = Rc::new(move || {
                            if let Some(add) = adder.borrow().clone() {
                                add(section.clone());
                            }
                        });
                        (tooltip, run)
                    });
                    let header = section_header(title, *collapsed, *count, add);
                    let (toggler, section) = (toggler.clone(), section.clone());
                    let click = gtk::GestureClick::new();
                    click.connect_released(move |_, _, _, _| {
                        if let Some(toggle) = toggler.borrow().clone() {
                            toggle(section.clone());
                        }
                    });
                    header.add_controller(click);
                    item.set_child(Some(&header));
                }
                RoomItem::Room(room) => {
                    item.set_selectable(true);
                    item.set_activatable(true);
                    let widget = match native_shared.borrow().as_ref() {
                        Some(session) => {
                            binder.bind_room(crate::rows::native_room_widget(room, session), session, &room.rid)
                        }
                        None => crate::rows::room_widget_with_presence(room, shared.borrow().as_ref(), None),
                    };
                    if let Some(session) = shared.borrow().clone() {
                        room_menu(&widget, session, room, marker.clone());
                    } else if let Some(session) = native_shared.borrow().clone() {
                        crate::details::native_favorite_menu(&widget, session, &room.rid);
                    }
                    item.set_child(Some(&widget));
                }
            }
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
        let brand = gtk::Box::builder().spacing(8).build();
        brand.append(&gtk::Label::builder().label("🦄").css_classes(["unicorn-header"]).build());
        brand.append(&widgets::brand("brand-header"));
        let sidebar_header = adw::HeaderBar::new();
        sidebar_header.set_title_widget(Some(&brand));
        let forward_button = gtk::Button::builder()
            .icon_name("go-next-symbolic")
            .css_classes(["flat"])
            .tooltip_text(t("rooms.back_to_room"))
            .visible(false)
            .build();
        sidebar_header.pack_start(&forward_button);
        sidebar_header.pack_start(&status_button);
        // Sign out lives in the account menu, away from "+".
        let new_conversation = gtk::MenuButton::builder()
            .icon_name("list-add-symbolic")
            .css_classes(["flat"])
            .tooltip_text(t("rooms.new"))
            .build();
        sidebar_header.pack_end(&new_conversation);
        let local_search_button = gtk::Button::builder()
            .icon_name("system-search-symbolic")
            .css_classes(["flat"])
            .tooltip_text(format!("{} (Ctrl+Shift+F)", t("local_search.title")))
            .visible(false)
            .build();
        sidebar_header.pack_end(&local_search_button);

        let account_tile = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        let account_name = label("", &["account-name"]);
        let account_host = label("", &["account-host"]);
        let account_text =
            gtk::Box::builder().orientation(gtk::Orientation::Vertical).valign(gtk::Align::Center).build();
        account_text.append(&account_name);
        account_text.append(&account_host);
        let account = gtk::Box::builder().spacing(10).css_classes(["account"]).build();
        account.append(&account_tile);
        account_text.set_hexpand(true);
        account.append(&account_text);
        // Says the block opens something: the account menu.
        account
            .append(&gtk::Image::builder().icon_name("emblem-system-symbolic").css_classes(["account-gear"]).build());
        account.set_cursor(gdk::Cursor::from_name("pointer", None).as_ref());
        account.set_tooltip_text(Some(t("rooms.account_menu")));
        let account_click = gtk::GestureClick::new();
        account.add_controller(account_click.clone());

        let sidebar_toolbar = adw::ToolbarView::new();
        sidebar_toolbar.add_top_bar(&sidebar_header);
        sidebar_toolbar.set_content(Some(
            &gtk::ScrolledWindow::builder()
                .hscrollbar_policy(gtk::PolicyType::Never)
                .child(&rooms_view)
                .margin_top(6)
                .build(),
        ));
        let update_slot = gtk::Box::builder().orientation(gtk::Orientation::Vertical).build();
        sidebar_toolbar.add_bottom_bar(&update_slot);
        sidebar_toolbar.add_bottom_bar(&voice_ui.bar);
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
        call_button.set_cursor(gdk::Cursor::from_name("pointer", None).as_ref());
        room_header.pack_end(&call_button);
        let search_button = gtk::Button::builder()
            .icon_name("system-search-symbolic")
            .css_classes(["flat"])
            .tooltip_text(t("search.title"))
            .build();
        room_header.pack_end(&search_button);
        let marked_button = gtk::Button::builder()
            .icon_name("view-pin-symbolic")
            .css_classes(["flat"])
            .tooltip_text(t("marked.title"))
            .build();
        room_header.pack_end(&marked_button);
        let threads_button = gtk::Button::builder()
            .icon_name("chat-message-new-symbolic")
            .css_classes(["flat"])
            .tooltip_text(t("threads.title"))
            .visible(false)
            .build();
        room_header.pack_end(&threads_button);
        room_title.set_cursor(gdk::Cursor::from_name("pointer", None).as_ref());
        room_title.set_tooltip_text(Some(t("info.room")));
        let title_click = gtk::GestureClick::new();
        room_title.add_controller(title_click.clone());
        let upload_strip = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(4)
            .css_classes(["upload-strip"])
            .visible(false)
            .build();
        let typing_label = gtk::Label::builder().xalign(0.0).css_classes(["typing"]).visible(false).build();
        let room_view = adw::ToolbarView::new();
        room_view.add_top_bar(&room_header);
        // The composer is content, not a bottom bar: libadwaita wraps bars in a
        // GtkWindowHandle, where a double click maximizes the window.
        let room_content = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let e2e_banner = gtk::Box::builder().spacing(10).css_classes(["e2e-banner"]).visible(false).build();
        e2e_banner.append(&gtk::Image::from_icon_name("channel-secure-symbolic"));
        e2e_banner.append(&gtk::Label::builder().label(t("e2e.banner")).hexpand(true).xalign(0.0).wrap(true).build());
        let unlock_button = gtk::Button::builder()
            .label(t("e2e.unlock"))
            .css_classes(["file-action"])
            .valign(gtk::Align::Center)
            .build();
        e2e_banner.append(&unlock_button);
        room_content.append(&e2e_banner);
        room_content.append(&list.root);
        room_content.append(&upload_strip);
        room_content.append(&typing_label);
        // Capture phase: the composer's text view would otherwise take dropped files as text.
        let drop = gtk::DropTarget::builder()
            .actions(gdk::DragAction::COPY)
            .propagation_phase(gtk::PropagationPhase::Capture)
            .build();
        drop.set_types(&[gdk::FileList::static_type(), gdk::Texture::static_type()]);
        room_content.add_css_class("room-content");
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
        // Each page at its own width: a hidden page (the voice page's controls)
        // must not widen the room past a narrow window.
        let content_stack = gtk::Stack::builder().hhomogeneous(false).build();
        content_stack.add_named(&empty, Some("empty"));
        let room_nav = adw::NavigationView::new();
        room_nav.add(&adw::NavigationPage::builder().child(&room_view).title("room").tag("room").build());
        content_stack.add_named(&room_nav, Some("room"));
        content_stack.add_named(&voice_ui.page, Some("voice"));
        let content_page = adw::NavigationPage::new(&content_stack, "rocket-vibe");

        let split = adw::NavigationSplitView::new();
        split.set_sidebar(Some(&sidebar_page));
        split.set_content(Some(&content_page));
        split.set_min_sidebar_width(260.0);
        split.set_max_sidebar_width(400.0);
        let comet = widgets::comet();
        let root = gtk::Overlay::builder().child(&split).build();
        root.add_overlay(&comet);

        let this = Rc::new(ChatPage {
            native: native_session,
            native_forward: RefCell::default(),
            native_edit: RefCell::default(),
            native_crypto: RefCell::default(),
            native_crypto_ready: Cell::new(false),
            native_crypto_restored: Cell::new(false),
            native_crypto_stale: Cell::new(false),
            native_crypto_rows: RefCell::default(),
            native_crypto_meta: RefCell::default(),
            native_quote_cards: crate::native_quote_cards::QuoteCards::new(&list),
            native_membership: RefCell::default(),
            native_unread_after: RefCell::default(),
            native_read_pending: Rc::default(),
            native_read_last: Rc::default(),
            search_button: search_button.clone(),
            local_search_button: local_search_button.clone(),
            marked_button: marked_button.clone(),
            threads_button: threads_button.clone(),
            root,
            split,
            update_slot,
            account_name,
            account_host,
            account_tile,
            status_dot,
            comet,
            connection: Cell::new(Connection::Offline),
            room_title,
            typing_label,
            upload_strip,
            call_button,
            read_generation: Rc::default(),
            rooms_store,
            rooms_selection,
            rooms: RefCell::default(),
            switcher: glib::WeakRef::new(),
            slots: RefCell::default(),
            collapsed: RefCell::new(load_collapsed()),
            on_unread: RefCell::default(),
            suppress_selection: Cell::new(false),
            content_page,
            content_stack,
            room_nav,
            thread: RefCell::default(),
            on_toast: RefCell::default(),
            list,
            composer,
            read_only_label,
            e2e_banner,
            e2e_unlock: unlock_button.clone(),
            session,
            current: RefCell::default(),
            limit: Cell::new(HISTORY_PAGE),
            loading: Cell::new(false),
            has_older: Cell::new(true),
            context: RefCell::default(),
            on_logout: RefCell::default(),
            administrator: Cell::new(None),
            menu_open: Rc::default(),
            on_room_changed: RefCell::default(),
            on_room_opened: RefCell::default(),
            on_user_navigation: RefCell::default(),
            account_actions: RefCell::default(),
            on_rooms_loaded: RefCell::default(),
            forward_button,
            history: RefCell::default(),
            history_at: Cell::new(0),
            walking: Cell::new(false),
            voice: voice_ui,
        });
        let weak = Rc::downgrade(&this);
        toggle_section.replace(Some(Rc::new(move |section| {
            if let Some(this) = weak.upgrade() {
                this.toggle_section(section);
            }
        })));
        this.wire(&status_button);
        this.wire_voice();
        let weak = Rc::downgrade(&this);
        unlock_button.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade()
                && let Some(session) = this.session()
            {
                crate::unlock::ask(&this.split, session);
            }
        });
        let weak = Rc::downgrade(&this);
        let anchor = account.downgrade();
        account_click.connect_released(move |_, _, _, _| {
            if let (Some(this), Some(anchor)) = (weak.upgrade(), anchor.upgrade()) {
                this.account_menu(&anchor);
            }
        });
        let weak = Rc::downgrade(&this);
        mark_room.replace(Some(Rc::new(move |(rid, unread): (String, bool)| {
            if let Some(this) = weak.upgrade() {
                this.mark_room(&rid, unread);
            }
        })));
        let weak = Rc::downgrade(&this);
        add_in_section.replace(Some(Rc::new(move |section| {
            let Some(this) = weak.upgrade() else { return };
            if section == Section::Channels {
                this.native_conversation(false);
            } else {
                this.new_conversation();
            }
        })));
        let weak = Rc::downgrade(&this);
        marked_button.connect_clicked(move |_| {
            let Some(this) = weak.upgrade() else { return };
            let (Some(chat), Some(rid)) = (this.chat(), this.current_rid()) else { return };
            let (target, expected) = (Rc::downgrade(&this), chat.clone());
            crate::marked::open_chat(&this.split, chat, &rid, move |id| {
                if let Some(this) = target.upgrade()
                    && this.chat().is_some_and(|c| c.same(&expected))
                {
                    this.jump_to(&id);
                }
            });
        });
        let weak = Rc::downgrade(&this);
        threads_button.connect_clicked(move |_| {
            let Some(this) = weak.upgrade() else { return };
            if this.native_session().is_some() {
                return;
            }
            let (Some(session), Some(rid)) = (this.session(), this.current_rid()) else { return };
            let (target, expected) = (Rc::downgrade(&this), session.clone());
            crate::threads::open(&this.split, session, &rid, move |id| {
                if let Some(this) = target.upgrade()
                    && this.session().is_some_and(|s| Arc::ptr_eq(&s, &expected))
                {
                    this.open_thread_of(&id);
                }
            });
        });
        let weak = Rc::downgrade(&this);
        search_button.connect_clicked(move |_| {
            let Some(this) = weak.upgrade() else { return };
            let private = this.native_crypto.borrow().clone();
            if let (Some(access), Some(session), Some(rid)) = (private, this.native_session(), this.current_rid()) {
                let target = Rc::downgrade(&this);
                let username = session.info.username.clone();
                crate::details::search_private(&this.split, access, username, &rid, move |id, thread| {
                    let Some(this) = target.upgrade() else { return };
                    match thread {
                        Some(root) => this.open_native_thread(&root),
                        None => this.jump_to(&id),
                    }
                });
            } else if let (Some(chat), Some(rid)) = (this.chat(), this.current_rid()) {
                let target = Rc::downgrade(&this);
                crate::details::search_chat(&this.split, chat, &rid, move |id, thread| {
                    let Some(this) = target.upgrade() else { return };
                    match thread {
                        Some(root) => this.open_thread_of(&root),
                        None => this.jump_to(&id),
                    }
                });
            }
        });
        let weak = Rc::downgrade(&this);
        local_search_button.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.open_local_search();
            }
        });
        let weak = Rc::downgrade(&this);
        title_click.connect_released(move |_, _, _, _| {
            if let Some(this) = weak.upgrade() {
                this.show_room_info();
            }
        });
        let weak = Rc::downgrade(&this);
        crate::markdown_view::set_custom_emoji(move |code| {
            let owner = weak.upgrade()?;
            let (session, path) = if let Some(native) = owner.native_session() {
                let path = native.custom_emoji(code)?;
                (crate::media::Provider::RocketVibe(native), path)
            } else {
                let legacy = owner.session()?;
                let path = legacy.custom_emoji(code)?;
                (crate::media::Provider::RocketChat(legacy), path)
            };
            let frame = gtk::Overlay::builder()
                .width_request(22)
                .height_request(22)
                .valign(gtk::Align::Center)
                .css_classes(["custom-emoji"])
                .tooltip_text(format!(":{code}:"))
                .build();
            frame.set_child(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
            session.watch(&frame, &path, |widget| {
                widget.set_visible(false);
            });
            let (target, code) = (frame.downgrade(), code.to_owned());
            crate::media::load_provider(session, &path, move |texture| {
                if let Some(frame) = target.upgrade() {
                    frame.add_overlay(
                        &gtk::Picture::builder()
                            .paintable(texture)
                            .content_fit(gtk::ContentFit::Contain)
                            .can_shrink(true)
                            .build(),
                    );
                    let texture = texture.clone();
                    frame.set_has_tooltip(true);
                    frame.connect_query_tooltip(move |_, _, _, _, tooltip| {
                        tooltip.set_custom(Some(&crate::markdown_view::emoji_card(&texture, &code)));
                        true
                    });
                }
            });
            Some(frame.upcast())
        });
        let names: Rc<RefCell<std::collections::HashMap<String, Option<String>>>> = Rc::default();
        let weak = Rc::downgrade(&this);
        crate::markdown_view::set_mention_preview(move |username| {
            let session = weak.upgrade()?.session()?;
            if matches!(username, "all" | "here") {
                return None;
            }
            let known = names.borrow().get(username).cloned();
            if known.is_none() {
                names.borrow_mut().insert(username.to_owned(), None);
                let (names, s, user) = (names.clone(), session.clone(), username.to_owned());
                glib::spawn_future_local(async move {
                    let key = user.clone();
                    if let Ok(profile) = on_tokio(async move { s.profile(&key, false).await }).await {
                        names.borrow_mut().insert(user, profile.name);
                    }
                });
            }
            let card = gtk::Box::builder().spacing(10).css_classes(["mention-card"]).build();
            let tile = widgets::tile(username, &widgets::initial(username), TileSize::Message, false);
            card.append(&with_photo(tile, Some(&session), Some(session.user_avatar(username))));
            let text = gtk::Box::builder().orientation(gtk::Orientation::Vertical).valign(gtk::Align::Center).build();
            if let Some(name) = known.flatten().filter(|n| n != username) {
                text.append(&label(&name, &["author"]));
            }
            text.append(&label(&format!("@{username}"), &["room-subtitle"]));
            card.append(&text);
            Some(card.upcast())
        });
        let weak = Rc::downgrade(&this);
        crate::markdown_view::set_link_handler(move |uri| {
            let Some(this) = weak.upgrade() else { return false };
            if let Some(username) = uri.strip_prefix("rv-user:") {
                this.show_profile(username, false);
                true
            } else if let Some(name) = uri.strip_prefix("rv-room:") {
                this.open_room_named(name);
                true
            } else {
                false
            }
        });
        let weak = Rc::downgrade(&this);
        new_conversation.set_create_popup_func(move |button| {
            let Some(this) = weak.upgrade() else { return };
            let (w1, w2) = (Rc::downgrade(&this), Rc::downgrade(&this));
            let mut items: Vec<MenuItem> = vec![(
                "mail-message-new-symbolic",
                t("rooms.new_message").to_owned(),
                Rc::new(move || {
                    if let Some(this) = w1.upgrade() {
                        this.new_conversation();
                    }
                }),
            )];
            // Creating a room: RocketVibe servers.
            if this.native_session().is_some() {
                items.push((
                    "list-add-symbolic",
                    t("rooms.new_channel").to_owned(),
                    Rc::new(move || {
                        if let Some(this) = w2.upgrade() {
                            this.native_conversation(false);
                        }
                    }),
                ));
            }
            button.set_popover(Some(&action_popover(items)));
        });
        let weak = Rc::downgrade(&this);
        drop.connect_drop(move |_, value, _, _| {
            let Some(this) = weak.upgrade() else { return false };
            let picked = if let Ok(list) = value.get::<gdk::FileList>() {
                crate::attach::from_files(&list.files())
            } else if let Ok(texture) = value.get::<gdk::Texture>() {
                crate::attach::save_texture(&texture).into_iter().collect()
            } else {
                Vec::new()
            };
            let droppable = !picked.is_empty() && this.current.borrow().as_ref().is_some_and(|o| !o.read_only);
            if droppable {
                this.attach_files(picked);
            }
            droppable
        });
        let weak = Rc::downgrade(&this);
        rooms_view.connect_activate(move |_, position| {
            let Some(this) = weak.upgrade() else { return };
            let rid = this.slots.borrow().get(position as usize).cloned().flatten();
            if let Some(rid) = rid {
                this.user_navigation();
                this.open_room(&rid);
                this.voice_channel_opened(&rid);
                return;
            }
            let object = this.rooms_store.item(position).and_downcast::<glib::BoxedAnyObject>();
            let section = object.and_then(|o| match &*o.borrow::<RoomItem>() {
                RoomItem::Header { section, .. } => Some(section.clone()),
                RoomItem::Room(_) => None,
            });
            if let Some(section) = section {
                this.toggle_section(section);
            }
        });
        this
    }

    fn wire(self: &Rc<Self>, status_button: &gtk::Button) {
        let weak = Rc::downgrade(self);
        let w = weak.clone();
        self.forward_button.connect_clicked(move |_| {
            if let Some(this) = w.upgrade() {
                this.split.set_show_content(true);
            }
        });
        let mouse = gtk::GestureClick::builder().button(0).propagation_phase(gtk::PropagationPhase::Capture).build();
        let w = weak.clone();
        mouse.connect_pressed(move |gesture, _, _, _| {
            let Some(this) = w.upgrade() else { return };
            match gesture.current_button() {
                8 => this.navigate_back(),
                9 => this.navigate_forward(),
                _ => return,
            }
            gesture.set_state(gtk::EventSequenceState::Claimed);
        });
        self.split.add_controller(mouse);
        let keys = gtk::ShortcutController::new();
        keys.set_scope(gtk::ShortcutScope::Global);
        let w = weak.clone();
        let search = gtk::CallbackAction::new(move |_, _| {
            if let Some(this) = w.upgrade() {
                this.open_local_search();
            }
            glib::Propagation::Stop
        });
        keys.add_shortcut(gtk::Shortcut::new(gtk::ShortcutTrigger::parse_string("<Control><Shift>f"), Some(search)));
        for (trigger, back) in [("<Alt>Left", true), ("<Alt>Right", false)] {
            let w = weak.clone();
            let action = gtk::CallbackAction::new(move |_, _| {
                if let Some(this) = w.upgrade() {
                    if back { this.navigate_back() } else { this.navigate_forward() }
                }
                glib::Propagation::Stop
            });
            keys.add_shortcut(gtk::Shortcut::new(gtk::ShortcutTrigger::parse_string(trigger), Some(action)));
        }
        // The quick room switcher; in the composer, Ctrl+Shift+K is the link.
        let w = weak.clone();
        let switcher = gtk::CallbackAction::new(move |_, _| {
            if let Some(this) = w.upgrade() {
                this.open_switcher();
            }
            glib::Propagation::Stop
        });
        keys.add_shortcut(gtk::Shortcut::new(gtk::ShortcutTrigger::parse_string("<Control>k"), Some(switcher)));
        self.split.add_controller(keys);
        let copy = gtk::EventControllerKey::builder().propagation_phase(gtk::PropagationPhase::Capture).build();
        let w = weak.clone();
        copy.connect_key_pressed(move |controller, key, _, state| {
            let ctrl = state.contains(gdk::ModifierType::CONTROL_MASK);
            if !ctrl || !matches!(key, gdk::Key::c | gdk::Key::C | gdk::Key::Insert | gdk::Key::KP_Insert) {
                return glib::Propagation::Proceed;
            }
            let spanned = w.upgrade().and_then(|this| {
                this.list
                    .selection_text()
                    .or_else(|| this.thread.borrow().as_ref().and_then(|t| t.list.selection_text()))
            });
            if let Some(text) = spanned {
                if let Some(display) = gdk::Display::default() {
                    display.clipboard().set_text(&text);
                }
                return glib::Propagation::Stop;
            }
            let focus = controller.widget().and_then(|w| w.root()).and_then(|root| root.focus());
            let editor_selection = focus.as_ref().is_some_and(|f| {
                f.downcast_ref::<gtk::TextView>().is_some_and(|v| v.buffer().has_selection())
                    || f.downcast_ref::<gtk::Text>().is_some_and(|t| t.selection_bounds().is_some())
            });
            match crate::markdown_view::selected_text().filter(|_| !editor_selection) {
                Some(text) => {
                    if let Some(display) = gdk::Display::default() {
                        display.clipboard().set_text(&text);
                    }
                    glib::Propagation::Stop
                }
                None => glib::Propagation::Proceed,
            }
        });
        self.split.add_controller(copy);
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
        self.list.connect_visible(move || {
            if let Some(this) = w.upgrade() {
                this.schedule_native_read();
            }
        });
        let w = weak.clone();
        self.list.connect_bottom_reached(move || {
            if let Some(this) = w.upgrade().filter(|this| this.context.borrow().is_some()) {
                glib::spawn_future_local(async move {
                    this.context_page(true).await;
                });
            }
        });
        let w = weak.clone();
        self.list.connect_latest(move || {
            if let Some(this) = w.upgrade() {
                this.leave_context();
            }
        });
        let w = weak.clone();
        self.call_button.connect_clicked(move |_| {
            let Some(this) = w.upgrade() else { return };
            if this.native_session().is_some() {
                this.voice_call();
                return;
            }
            let (Some(session), Some(rid)) = (this.session(), this.current_rid()) else { return };
            let room = this.current_name();
            let weak = Rc::downgrade(&this);
            glib::spawn_future_local(async move {
                let url = on_tokio(async move { session.start_call(&rid).await }).await;
                let Some(this) = weak.upgrade() else { return };
                match url {
                    Ok(url) => this.open_call(&url, &room),
                    Err(_) => this.toast(t("call.failed").to_owned()),
                }
            });
        });
        let w = weak.clone();
        self.composer.connect_error(move |text| {
            if let Some(this) = w.upgrade() {
                this.toast(text);
            }
        });
        let w = weak.clone();
        self.composer.connect_send_files(move |outgoing| {
            if let Some(this) = w.upgrade() {
                this.send_files(outgoing);
            }
        });
        let w = weak.clone();
        self.composer.connect_files(move |picked| {
            if let Some(this) = w.upgrade() {
                this.attach_files(picked);
            }
        });
        let w = weak.clone();
        self.composer.connect_edit_last(move || {
            if let Some(this) = w.upgrade() {
                this.edit_last(false);
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
            let rid = this.slots.borrow().get(index as usize).cloned().flatten();
            if let Some(rid) = rid {
                this.user_navigation();
                this.open_room(&rid);
                this.voice_channel_opened(&rid);
            }
        });

        let w = weak.clone();
        status_button.connect_clicked(move |_| {
            if let Some(s) = w.upgrade().and_then(|t| t.native_session()) {
                s.reconnect();
                return;
            }
            if let Some(s) = w.upgrade().and_then(|t| t.session.borrow().clone()) {
                s.reconnect_now();
            }
        });
        // Collapsed, the list shows alone: a room left selected there could not
        // be tapped again (no selection change). Back to the list, nothing is
        // selected; widened again, the open room is highlighted again.
        let w = weak.clone();
        self.split.connect_show_content_notify(move |split| {
            let Some(this) = w.upgrade() else { return };
            this.update_forward();
            if split.is_collapsed() && !split.shows_content() {
                this.select_current(false);
            }
        });
        let w = weak;
        self.split.connect_collapsed_notify(move |split| {
            let Some(this) = w.upgrade() else { return };
            this.update_forward();
            if !split.is_collapsed() {
                this.select_current(true);
            }
        });
    }

    pub fn widget(&self) -> &adw::NavigationSplitView {
        &self.split
    }

    pub fn root(&self) -> &gtk::Overlay {
        &self.root
    }

    /// Above the account, at the foot of the room list: the update card.
    pub fn set_update_notice(&self, notice: Option<&gtk::Widget>) {
        while let Some(child) = self.update_slot.first_child() {
            self.update_slot.remove(&child);
        }
        if let Some(notice) = notice {
            self.update_slot.append(notice);
        }
    }

    pub fn update_notice(&self) -> Option<gtk::Widget> {
        self.update_slot.first_child()
    }

    pub fn connect_toast(&self, f: impl Fn(String) + 'static) {
        self.on_toast.replace(Some(Rc::new(f)));
    }

    pub(crate) fn toast(&self, text: String) {
        if let Some(toast) = self.on_toast.borrow().clone() {
            toast(text);
        }
    }

    fn handle_event(self: &Rc<Self>, event: RowEvent, in_thread: bool) {
        if matches!(&event, RowEvent::OpenThread(_)) {
            self.user_navigation();
        }
        if self.native_session().is_some() {
            self.native_row_event(event, in_thread);
            return;
        }
        let Some(session) = self.session.borrow().clone() else { return };
        match event {
            RowEvent::Retry(id) => self.retry(id),
            RowEvent::React { id, shortcode, add } => {
                if add {
                    crate::reactions::record(&session.info.base_url, &session.info.user_id, &shortcode);
                }
                let weak = Rc::downgrade(self);
                glib::spawn_future_local(async move {
                    if on_tokio(async move { session.react(&id, &shortcode, add).await }).await.is_err()
                        && let Some(this) = weak.upgrade()
                    {
                        this.toast(t("actions.refused").to_owned());
                    }
                });
            }
            RowEvent::CancelEdit => {
                self.list_of(in_thread).stop_edit();
                self.composer_of(in_thread).grab_focus();
            }
            RowEvent::SaveEdit => {
                let list = self.list_of(in_thread);
                let before = list.editing().and_then(|id| list.row(&id)).and_then(|r| r.text);
                let Some((id, text)) = list.stop_edit() else { return };
                self.composer_of(in_thread).grab_focus();
                let Some(rid) = self.current_rid() else { return };
                if text.trim().is_empty() || Some(&text) == before.as_ref() {
                    return;
                }
                let weak = Rc::downgrade(self);
                glib::spawn_future_local(async move {
                    if on_tokio(async move { session.edit(&rid, &id, &text).await }).await.is_err()
                        && let Some(this) = weak.upgrade()
                    {
                        this.toast(t("actions.refused").to_owned());
                    }
                });
            }
            RowEvent::OpenThread(root) => self.open_thread(&root),
            RowEvent::OpenDiscussion(drid) => self.open_discussion(&drid),
            RowEvent::Profile(username) => self.show_profile(&username, false),
            // RocketVibe call rows only.
            RowEvent::VoiceCall { .. } => {}
            RowEvent::JoinCall(call_id) => {
                let weak = Rc::downgrade(self);
                let room = self.current_name();
                glib::spawn_future_local(async move {
                    let url = on_tokio(async move { session.join_call(&call_id).await }).await;
                    let Some(this) = weak.upgrade() else { return };
                    match url {
                        Ok(url) => this.open_call(&url, &room),
                        Err(_) => this.toast(t("call.failed").to_owned()),
                    }
                });
            }
            RowEvent::CallInfo(call_id) => {
                let weak = Rc::downgrade(self);
                glib::spawn_future_local(async move {
                    let link = on_tokio(async move { session.call_link(&call_id).await }).await;
                    let Some(this) = weak.upgrade() else { return };
                    match link {
                        Ok(link) => crate::call_window::info(&this.split, &link),
                        Err(_) => this.toast(t("call.failed").to_owned()),
                    }
                });
            }
            RowEvent::Menu { row, anchor, x, y, link } => {
                let selection = self
                    .list
                    .selection_text()
                    .or_else(|| self.thread.borrow().as_ref().and_then(|t| t.list.selection_text()))
                    .or_else(crate::markdown_view::selected_text);
                if crate::markdown_view::text_menu(&anchor, x, y, selection, link) {
                    return;
                }
                let Some(open) = self.current.borrow().clone() else { return };
                let room = actions_menu::RoomContext {
                    rid: open.rid.clone(),
                    read_only: open.read_only,
                    encrypted: open.encrypted,
                    in_thread,
                };
                let (w1, w2, w3, w4, w5, w6, w7) = (
                    Rc::downgrade(self),
                    Rc::downgrade(self),
                    Rc::downgrade(self),
                    Rc::downgrade(self),
                    Rc::downgrade(self),
                    Rc::downgrade(self),
                    Rc::downgrade(self),
                );
                let handlers = Rc::new(actions_menu::Handlers {
                    reply: Box::new(move |row| {
                        if let Some(this) = w1.upgrade() {
                            this.start_reply(row, in_thread);
                        }
                    }),
                    forward: Box::new(move |row| {
                        if let Some(this) = w6.upgrade() {
                            this.forward_message(&row);
                        }
                    }),
                    discussion: Box::new(move |row| {
                        if let Some(this) = w7.upgrade() {
                            this.start_discussion(Some(&row));
                        }
                    }),
                    thread: Box::new(move |root| {
                        if let Some(this) = w2.upgrade() {
                            this.open_thread(&root);
                        }
                    }),
                    edit: Box::new(move |row| {
                        if let Some(this) = w4.upgrade() {
                            this.list_of(in_thread).start_edit(&row);
                        }
                    }),
                    toast: Box::new(move |text| {
                        if let Some(this) = w3.upgrade() {
                            this.toast(text);
                        }
                    }),
                    report: Box::new(move |id| {
                        if let Some(this) = w5.upgrade() {
                            this.report(crate::admin::ReportTarget::Message(id));
                        }
                    }),
                });
                actions_menu::open(&anchor, x, y, session, *row, room, handlers);
            }
        }
    }

    fn list_of(&self, in_thread: bool) -> Rc<MessageList> {
        match (in_thread, self.thread.borrow().as_ref()) {
            (true, Some(thread)) => thread.list.clone(),
            _ => self.list.clone(),
        }
    }

    fn composer_of(&self, in_thread: bool) -> Rc<Composer> {
        match (in_thread, self.thread.borrow().as_ref()) {
            (true, Some(thread)) => thread.composer.clone(),
            _ => self.composer.clone(),
        }
    }

    /// Up in an empty composer: my last message, edited in place if the server still allows it.
    fn edit_last(self: &Rc<Self>, in_thread: bool) {
        if let Some(session) = self.native_session() {
            if let Some(row) = self.list_of(in_thread).last_mine(&session.info.user_id) {
                if self.current.borrow().as_ref().is_some_and(|r| r.encrypted) {
                    self.start_crypto_edit(row, in_thread);
                } else {
                    self.start_native_edit(row, in_thread);
                }
            }
            return;
        }
        let (Some(session), Some(open)) = (self.session(), self.current.borrow().clone()) else { return };
        let Some(row) = self.list_of(in_thread).last_mine(&session.info.user_id) else { return };
        let room = actions_menu::RoomContext {
            rid: open.rid,
            read_only: open.read_only,
            encrypted: open.encrypted,
            in_thread,
        };
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let allowed = actions_menu::allowed(&session, &row, &room).await;
            let Some(this) = weak.upgrade() else { return };
            if allowed.contains(&rv_core::actions::Action::Edit) {
                this.list_of(in_thread).start_edit(&row);
            } else {
                this.toast(t("edit.too_late").to_owned());
            }
        });
    }

    /// Quoting needs the permalink the server recognises, built on `Site_Url`.
    fn start_reply(self: &Rc<Self>, row: rv_core::store::MessageRow, in_thread: bool) {
        if let Some(session) = self.native_session() {
            let prepared = (|| {
                let selected = session.store.quote_selection(&row.rid, &row.id).ok()?;
                let source = session
                    .store
                    .selected_messages(std::slice::from_ref(&row.id))
                    .ok()?
                    .into_iter()
                    .find(|source| source.id == row.id)?;
                if session.store.quote_selection(&row.rid, &row.id).ok()? != selected {
                    return None;
                }
                Some((selected, source))
            })();
            match prepared {
                Some((selected, source)) => {
                    self.composer_of(in_thread).set_native_reply(&source.author, &source.text, selected)
                }
                None => self.toast(t("quote.unavailable").to_owned()),
            }
            return;
        }
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

    /// The quick room switcher (Ctrl+K): the room picked among the account's opens.
    pub fn open_switcher(self: &Rc<Self>) -> adw::Dialog {
        if let Some(open) = self.switcher.upgrade() {
            return open;
        }
        let rooms = self.rooms.borrow().clone();
        let weak = Rc::downgrade(self);
        let dialog = crate::switcher::open(&self.split, self.session(), rooms, move |rid| {
            let Some(this) = weak.upgrade() else { return };
            // The account may have changed while the dialog was open.
            if !this.rooms.borrow().iter().any(|r| r.rid == rid) {
                return;
            }
            this.user_navigation();
            this.open_room(&rid);
            this.voice_channel_opened(&rid);
        });
        self.switcher.set(Some(&dialog));
        dialog
    }

    /// Forwarding (Rocket.Chat): the room picked in a dialog opens, and the
    /// message's permalink goes there as a quote, through the outbox.
    pub fn forward_message(self: &Rc<Self>, row: &rv_core::store::MessageRow) -> Option<adw::Dialog> {
        let (Some(session), Some(open)) = (self.session(), self.current.borrow().clone()) else { return None };
        let rooms = self.rooms.borrow().clone();
        let (weak, s, id) = (Rc::downgrade(self), session.clone(), row.id.clone());
        Some(crate::forward::open(&self.split, session, rooms, move |target| {
            let Some(this) = weak.upgrade() else { return };
            if this.session().is_none_or(|current| !Arc::ptr_eq(&current, &s)) {
                return;
            }
            this.user_navigation();
            this.open_room(&target);
            let (s, open, id, weak) = (s.clone(), open.clone(), id.clone(), weak.clone());
            glib::spawn_future_local(async move {
                let sent =
                    on_tokio(async move { s.forward(&open.kind, open.slug.as_deref(), &open.rid, &id, &target).await })
                        .await;
                if sent.is_err()
                    && let Some(this) = weak.upgrade()
                {
                    this.toast(t("forward.failed").to_owned());
                }
            });
        }))
    }

    /// "Start a discussion" (a message's menu, `source`) or "New discussion"
    /// (the room's information): the dialog, then the new room opens.
    pub fn start_discussion(self: &Rc<Self>, source: Option<&rv_core::store::MessageRow>) -> Option<adw::Dialog> {
        let (Some(session), Some(open)) = (self.session(), self.current.borrow().clone()) else { return None };
        if !session.discussions_available() {
            return None;
        }
        let (w1, w2, expected) = (Rc::downgrade(self), Rc::downgrade(self), session.clone());
        Some(crate::discussions::create(
            &self.split,
            session,
            &open.rid,
            source,
            move |rid| {
                if let Some(this) = w1.upgrade()
                    && this.session().is_some_and(|s| Arc::ptr_eq(&s, &expected))
                {
                    this.user_navigation();
                    this.reload_rooms();
                    this.open_room(&rid);
                }
            },
            move || {
                if let Some(this) = w2.upgrade() {
                    this.toast(t("discussion.failed").to_owned());
                }
            },
        ))
    }

    /// A discussion card's Open: its room when listed, else joined first when
    /// it belongs to a public channel; one of a private group says it is for
    /// its members.
    pub fn open_discussion(self: &Rc<Self>, drid: &str) {
        self.user_navigation();
        if self.rooms.borrow().iter().any(|r| r.rid == drid) {
            self.open_room(drid);
            return;
        }
        let Some(session) = self.session() else { return };
        let (weak, expected, drid) = (Rc::downgrade(self), session.clone(), drid.to_owned());
        glib::spawn_future_local(async move {
            let rid = drid.clone();
            let access = on_tokio(async move { session.open_discussion(&rid).await }).await;
            let Some(this) = weak.upgrade() else { return };
            if this.session().is_none_or(|s| !Arc::ptr_eq(&s, &expected)) {
                return;
            }
            use rv_core::session::DiscussionAccess;
            match access {
                Ok(DiscussionAccess::Listed | DiscussionAccess::Joined) => {
                    this.reload_rooms();
                    this.open_room(&drid);
                }
                Ok(DiscussionAccess::MembersOnly) => this.toast(t("discussion.unavailable").to_owned()),
                Err(_) => this.toast(t("discussion.open_failed").to_owned()),
            }
        });
    }

    fn open_thread(self: &Rc<Self>, root_id: &str) {
        if self.native_session().is_some() {
            self.open_native_thread(root_id);
            return;
        }
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
        let (weak, rid, root) = (Rc::downgrade(self), open.rid.clone(), root_id.to_owned());
        let composer = Rc::downgrade(&thread.composer);
        // "Also send to the room": one reply at a time, unchecked once it goes.
        thread.also.set_visible(session.also_in_room_available() && !open.read_only);
        let also = thread.also.downgrade();
        thread.composer.connect_submit(move |text| {
            if let (Some(this), Some(composer)) = (weak.upgrade(), composer.upgrade()) {
                let shown = also.upgrade().is_some_and(|also| also.is_visible() && also.is_active());
                if let Some(also) = also.upgrade() {
                    also.set_active(false);
                }
                this.send_or_run_shown(&composer, &rid, Some(&root), text, shown);
            }
        });
        let weak = Rc::downgrade(self);
        thread.composer.connect_edit_last(move || {
            if let Some(this) = weak.upgrade() {
                this.edit_last(true);
            }
        });
        thread.composer.bind(&session, &open.rid, Some(root_id));
        self.wire_thread_files(&thread);
        self.wire_thread_follow(&thread);
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

    /// The thread's bell follows it or stops, by what the store holds of its root now.
    fn wire_thread_follow(self: &Rc<Self>, thread: &Rc<ThreadPage>) {
        let (weak, root) = (Rc::downgrade(self), thread.root_id.clone());
        thread.follow.connect_clicked(move |button| {
            let Some(this) = weak.upgrade() else { return };
            let Some(session) = this.session() else { return };
            let on = !session
                .store
                .messages_by_id(std::slice::from_ref(&root))
                .first()
                .is_some_and(|r| r.followed_by(&session.info.user_id));
            button.set_sensitive(false);
            let (button, weak) = (button.clone(), weak.clone());
            crate::threads::follow(session, root.clone(), on, move |ok| {
                button.set_sensitive(true);
                if let Some(this) = weak.upgrade() {
                    this.toast(
                        t(match (ok, on) {
                            (false, _) => "thread.follow_failed",
                            (true, true) => "thread.followed",
                            (true, false) => "thread.unfollowed",
                        })
                        .to_owned(),
                    );
                }
            });
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
        self.administrator.set(None);
        self.close_native_crypto();
        self.voice.reset();
        self.read_generation.set(self.read_generation.get().wrapping_add(1));
        self.native_read_pending.set(false);
        self.native_read_last.replace(None);
        self.native_unread_after.replace(None);
        self.native_edit.replace(None);
        self.native_membership.replace(None);
        if let Some(forward) = self.native_forward.take() {
            forward.abort();
        }
        if let Some(native) = self.native.take() {
            native.shutdown();
        }
        self.search_button.set_sensitive(true);
        self.marked_button.set_sensitive(true);
        self.local_search_button.set_visible(session.is_some());
        self.set_loading(false);
        if let Some(s) = &session {
            let host = url::Url::parse(&s.info.base_url).ok().and_then(|u| u.host_str().map(str::to_owned));
            self.account_name.set_label(&s.info.username);
            self.account_host.set_label(&host.unwrap_or_default());
            while let Some(child) = self.account_tile.first_child() {
                self.account_tile.remove(&child);
            }
            let tile = widgets::tile(&s.info.username, &widgets::initial(&s.info.username), TileSize::Message, false);
            let tile = with_photo(tile, Some(s), Some(s.user_avatar(&s.info.username)));
            self.account_tile.append(&tile);
        }
        self.session.replace(session);
        self.current.replace(None);
        self.history.borrow_mut().clear();
        self.history_at.set(0);
        self.update_forward();
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
        self.update_comet();
    }

    fn set_loading(&self, loading: bool) {
        self.loading.set(loading);
        self.update_comet();
    }

    fn update_comet(&self) {
        if self.loading.get() || self.connection.get() != Connection::Online {
            self.comet.add_css_class("active");
        } else {
            self.comet.remove_css_class("active");
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
        if self.native_session().is_some() {
            self.schedule_native_read();
            return;
        }
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

    /// The room list's "Mark as unread" (`unread`) or "Mark as read". The room
    /// open when marked unread is left first, as the official web client does:
    /// still open, it would read itself again with the next message or focus.
    pub fn mark_room(self: &Rc<Self>, rid: &str, unread: bool) {
        let Some(session) = self.session() else { return };
        if unread && self.current_rid().as_deref() == Some(rid) {
            self.leave_room();
        }
        let (weak, expected, rid) = (Rc::downgrade(self), session.clone(), rid.to_owned());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move {
                if unread { session.mark_unread(&rid).await } else { session.mark_room_read(&rid).await }
            })
            .await;
            let Some(this) = weak.upgrade() else { return };
            if let Err(e) = result
                && this.session().is_some_and(|s| Arc::ptr_eq(&s, &expected))
            {
                eprintln!("Read state not changed: {e}");
                let empty = e.error_type.as_deref() == Some(rv_core::actions::NOTHING_TO_UNREAD);
                this.toast(t(if empty { "rooms.nothing_unread" } else { "rooms.mark_failed" }).to_owned());
            }
        });
    }

    /// Shows no room: the open one is left, nothing in the list is selected,
    /// and nothing reads it (a pending read is dropped) until it is opened again.
    fn leave_room(&self) {
        self.read_generation.set(self.read_generation.get().wrapping_add(1));
        if let Some(session) = self.session() {
            session.close_room();
        }
        // The composer loses the focus before its page hides.
        if let Some(root) = self.split.root() {
            root.set_focus(None::<&gtk::Widget>);
        }
        self.current.replace(None);
        self.thread.replace(None);
        self.context.replace(None);
        self.room_nav.pop_to_tag("room");
        self.list.set_detached(false);
        self.list.clear();
        self.typing_label.set_visible(false);
        self.call_button.set_visible(false);
        self.threads_button.set_visible(false);
        self.content_stack.set_visible_child_name("empty");
        self.content_page.set_title("rocket-vibe");
        self.split.set_show_content(false);
        self.select_current(false);
        self.update_forward();
        for f in self.on_room_changed.borrow().iter() {
            f(None);
        }
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

    pub fn show_room_info(self: &Rc<Self>) {
        if let Some(session) = self.native_session() {
            let Some(rid) = self.current_rid() else { return };
            if session.profiles_available()
                && let Ok(Some(peer)) = session.store.direct_peer(&rid)
            {
                self.show_profile(&peer.user.id, true);
                return;
            }
            if !session.supported_features().iter().any(|f| f == "room_info") {
                return;
            }
            let weak = Rc::downgrade(self);
            let expected = session.clone();
            let selected = rid.clone();
            crate::details::native_room_info(
                &self.split,
                session,
                &rid,
                Rc::new(move || {
                    if let Some(this) = weak.upgrade()
                        && this.native_session().is_some_and(|s| Arc::ptr_eq(&s, &expected))
                        && this.current_rid().as_deref() == Some(&selected)
                    {
                        this.native_conversation(true);
                    }
                }),
            );
            return;
        }
        let (Some(session), Some(open)) = (self.session(), self.current.borrow().clone()) else { return };
        match (&open.dm_other_uid, open.kind.as_str()) {
            (Some(uid), "d") => self.profile_dialog(uid, true, Some(open.rid.clone())),
            _ => {
                // A discussion of this room, from the information dialog: not in an encrypted one.
                let weak = Rc::downgrade(self);
                let new_discussion: Option<Rc<dyn Fn()>> =
                    (session.discussions_available() && !open.encrypted && !open.read_only).then(|| {
                        Rc::new(move || {
                            if let Some(this) = weak.upgrade() {
                                this.start_discussion(None);
                            }
                        }) as Rc<dyn Fn()>
                    });
                let weak = Rc::downgrade(self);
                let toast: Rc<dyn Fn(String)> = Rc::new(move |text| {
                    if let Some(this) = weak.upgrade() {
                        this.toast(text);
                    }
                });
                let room = crate::details::RoomInfoTarget {
                    rid: &open.rid,
                    name: &open.name,
                    kind: &open.kind,
                    avatar: open.avatar.clone(),
                };
                crate::details::room_info(&self.split, session, room, new_discussion, toast);
            }
        }
    }

    /// Search across rooms, on the device: a hit opens its room at the
    /// message, or the thread of a reply. Not on RocketVibe servers, whose
    /// private conversations keep their own search per room.
    pub fn open_local_search(self: &Rc<Self>) -> Option<adw::Dialog> {
        if self.native_session().is_some() {
            return None;
        }
        let session = self.session()?;
        let (weak, expected) = (Rc::downgrade(self), session.clone());
        Some(crate::local_search::open(&self.split, session, move |rid, id, thread| {
            if let Some(this) = weak.upgrade()
                && this.session().is_some_and(|s| Arc::ptr_eq(&s, &expected))
            {
                this.open_search_hit(&rid, &id, thread);
            }
        }))
    }

    /// A message found across rooms: its room, scrolled to it, or its thread.
    pub fn open_search_hit(self: &Rc<Self>, rid: &str, id: &str, thread: Option<String>) {
        self.user_navigation();
        self.open_room(rid);
        if self.current_rid().as_deref() != Some(rid) {
            self.toast(t("marked.not_loaded").to_owned());
            return;
        }
        match thread {
            Some(root) => self.open_thread_of(&root),
            None => self.jump_to(id),
        }
    }

    /// The administration of the open account, which members' reports also go through.
    pub fn admin(&self) -> Option<rv_core::admin::Admin> {
        if let Some(session) = self.native_session() {
            return Some(rv_core::admin::Admin::Native(session));
        }
        self.session().map(rv_core::admin::Admin::RocketChat)
    }

    /// The server administration of the open account; the caller checked it is an admin.
    pub fn open_admin(self: &Rc<Self>) {
        if let Some(admin) = self.admin() {
            crate::admin::open(&self.split, admin);
        }
    }

    /// Asks a reason and reports a message or an account.
    pub fn report(self: &Rc<Self>, target: crate::admin::ReportTarget) -> Option<adw::AlertDialog> {
        let admin = self.admin()?;
        let weak = Rc::downgrade(self);
        let toast: Rc<dyn Fn(String)> = Rc::new(move |text| {
            if let Some(this) = weak.upgrade() {
                this.toast(text);
            }
        });
        Some(crate::admin::report(&self.split, admin, target, toast))
    }

    pub fn show_profile(self: &Rc<Self>, key: &str, by_id: bool) {
        self.profile_dialog(key, by_id, None);
    }

    /// A profile; `room`, the direct conversation it was opened from.
    fn profile_dialog(self: &Rc<Self>, key: &str, by_id: bool, room: Option<String>) {
        let (w1, w2, w3) = (Rc::downgrade(self), Rc::downgrade(self), Rc::downgrade(self));
        let actions = crate::details::ProfileActions {
            message: Box::new(move |found| {
                if let Some(this) = w1.upgrade() {
                    this.go_to(found);
                }
            }),
            call: Box::new(move |found| {
                let Some(this) = w2.upgrade() else { return };
                let rv_core::rooms::Found::User { id, username, .. } = found else { return };
                if let Some(session) = this.native_session() {
                    let (weak, expected) = (Rc::downgrade(&this), session.clone());
                    glib::spawn_future_local(async move {
                        let rid = on_tokio(async move {
                            if id.is_empty() { session.direct(&username).await } else { session.direct_user(&id).await }
                        })
                        .await;
                        let Some(this) = weak.upgrade() else { return };
                        if this.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &expected)) {
                            return;
                        }
                        match rid {
                            Ok(rid) => {
                                this.reload_rooms();
                                this.join_voice(&rid, expected.voice_participants(&rid).is_empty());
                            }
                            Err(_) => this.toast(t("voice_session.join_failed").to_owned()),
                        }
                    });
                    return;
                }
                let Some(session) = this.session() else { return };
                let weak = Rc::downgrade(&this);
                glib::spawn_future_local(async move {
                    let room = username.clone();
                    let url = on_tokio(async move {
                        let rid = session.open_dm(&username).await?;
                        session.start_call(&rid).await
                    })
                    .await;
                    let Some(this) = weak.upgrade() else { return };
                    match url {
                        Ok(url) => this.open_call(&url, &room),
                        Err(_) => this.toast(t("call.failed").to_owned()),
                    }
                });
            }),
            report: Box::new(move |id| {
                if let Some(this) = w3.upgrade() {
                    this.report(crate::admin::ReportTarget::User(id));
                }
            }),
            room,
        };
        if let Some(chat) = self.chat() {
            crate::details::profile_chat(&self.split, chat, key, by_id, actions);
        }
    }

    /// A `#channel` in a message: open it, joining first if I am not in it.
    fn open_room_named(self: &Rc<Self>, name: &str) {
        self.user_navigation();
        let known = self
            .rooms
            .borrow()
            .iter()
            .find(|r| r.slug.as_deref() == Some(name) || r.name == name)
            .map(|r| r.rid.clone());
        if let Some(rid) = known {
            self.open_room(&rid);
            return;
        }
        let Some(session) = self.session() else { return };
        let (weak, name) = (Rc::downgrade(self), name.to_owned());
        glib::spawn_future_local(async move {
            let info = on_tokio(async move { session.room_by_name(&name).await }).await;
            let Some(this) = weak.upgrade() else { return };
            match info {
                Ok(info) => this.go_to(rv_core::rooms::Found::Room { id: info.id, name: info.name, kind: info.kind }),
                Err(_) => this.toast(t("spotlight.open_failed").to_owned()),
            }
        });
    }

    /// Unlocked or locked: encrypted rows and previews are built again.
    pub fn on_e2e(&self) {
        self.on_avatar();
    }

    /// A photo changed: rows are rebuilt so they ask for the new one.
    pub fn on_avatar(&self) {
        self.load_rooms(true);
        self.list.rebind();
        if let Some(thread) = self.thread.borrow().as_ref() {
            thread.list.rebind();
        }
        self.refresh_room_header();
    }

    /// The account block's menu, shown at once: settings, the server
    /// administration for an administrator, sign out. Whether I administer
    /// is asked once per account (never on Mattermost, which has no
    /// administration here); the row joins an open menu when the answer comes.
    fn account_menu(self: &Rc<Self>, anchor: &gtk::Box) {
        if self.menu_open.get() {
            return;
        }
        let w = Rc::downgrade(self);
        let mut items: Vec<MenuItem> = vec![(
            "emblem-system-symbolic",
            t("settings.title").to_owned(),
            Rc::new(move || {
                if let Some(this) = w.upgrade() {
                    this.open_settings();
                }
            }),
        )];
        if self.administrator.get() == Some(true) {
            items.push(self.admin_item());
        }
        let w = Rc::downgrade(self);
        items.push((
            "system-log-out-symbolic",
            t("rooms.sign_out").to_owned(),
            Rc::new(move || {
                if let Some(this) = w.upgrade() {
                    this.sign_out();
                }
            }),
        ));
        let popover = action_popover(items);
        popover.set_parent(anchor);
        popover.set_position(gtk::PositionType::Top);
        let open = self.menu_open.clone();
        popover.connect_closed(move |popover| {
            open.set(false);
            let popover = popover.clone();
            glib::idle_add_local_once(move || popover.unparent());
        });
        self.menu_open.set(true);
        popover.popup();
        if self.administrator.get().is_some() || self.session().is_some_and(|s| s.info.mattermost.is_some()) {
            return;
        }
        let Some(admin) = self.admin() else { return };
        let (this, menu) = (Rc::downgrade(self), popover.downgrade());
        glib::spawn_future_local(async move {
            let administrator = crate::on_tokio(async move { admin.is_admin().await }).await;
            let Some(this) = this.upgrade() else { return };
            this.administrator.set(Some(administrator));
            if let Some(menu) = menu.upgrade().filter(|m| administrator && m.is_visible())
                && let Some(list) = menu.child().and_downcast::<gtk::Box>()
                && let Some(first) = list.first_child()
            {
                list.insert_child_after(&menu_row(&menu, this.admin_item()), Some(&first));
            }
        });
    }

    fn admin_item(self: &Rc<Self>) -> MenuItem {
        let w = Rc::downgrade(self);
        (
            "network-server-symbolic",
            t("admin.title").to_owned(),
            Rc::new(move || {
                if let Some(this) = w.upgrade() {
                    this.open_admin();
                }
            }),
        )
    }

    fn sign_out(&self) {
        for f in self.on_logout.borrow().iter() {
            f(());
        }
    }

    /// The settings of the open account.
    fn open_settings(self: &Rc<Self>) {
        if self.native_session().is_some() {
            self.native_settings();
            return;
        }
        let Some(session) = self.session() else { return };
        let signer = Rc::downgrade(self);
        let accounts = self.account_actions.borrow().clone();
        crate::settings::open(&self.split, session, accounts, move || {
            if let Some(this) = signer.upgrade() {
                this.sign_out();
            }
        });
    }

    fn new_conversation(self: &Rc<Self>) {
        let Some(chat) = self.chat() else { return };
        let (w1, w2, w3) = (Rc::downgrade(self), Rc::downgrade(self), Rc::downgrade(self));
        // The RocketVibe server creates channels from here too.
        let create: Option<Rc<dyn Fn()>> = chat.native().map(|_| {
            Rc::new(move || {
                if let Some(this) = w3.upgrade() {
                    this.native_conversation(false);
                }
            }) as Rc<dyn Fn()>
        });
        crate::spotlight::open_chat(
            &self.split,
            chat,
            move |rid| w1.upgrade().is_some_and(|this| this.rooms.borrow().iter().any(|r| r.rid == rid)),
            move |found| {
                if let Some(this) = w2.upgrade() {
                    this.go_to(found);
                }
            },
            create,
        );
    }

    /// A person: their DM, created if needed. A channel: joined if needed. Then opened.
    pub fn go_to(self: &Rc<Self>, found: rv_core::rooms::Found) {
        self.user_navigation();
        use rv_core::rooms::Found;
        if let Some(session) = self.native_session() {
            let weak = Rc::downgrade(self);
            let expected = session.clone();
            glib::spawn_future_local(async move {
                let result = on_tokio(async move {
                    match found {
                        Found::User { id, username, .. } => {
                            if id.is_empty() {
                                session.direct(&username).await
                            } else {
                                session.direct_user(&id).await
                            }
                        }
                        Found::Room { id, .. } => session.join_public(&id).await,
                    }
                })
                .await;
                let Some(this) = weak.upgrade() else { return };
                if this.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &expected)) {
                    return;
                }
                match result {
                    Ok(rid) => {
                        this.reload_rooms();
                        this.open_room(&rid);
                    }
                    Err(_) => this.toast(t("spotlight.open_failed").to_owned()),
                }
            });
            return;
        }
        let Some(session) = self.session() else { return };
        let joined = |rid: &str| self.rooms.borrow().iter().any(|r| r.rid == rid);
        let known = match &found {
            Found::Room { id, .. } => joined(id),
            Found::User { .. } => false,
        };
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let rid = match found {
                Found::User { username, .. } => on_tokio(async move { session.open_dm(&username).await }).await,
                Found::Room { id, .. } if known => Ok(id),
                Found::Room { id, .. } => {
                    let rid = id.clone();
                    on_tokio(async move { session.join_channel(&id).await }).await.map(|()| rid)
                }
            };
            let Some(this) = weak.upgrade() else { return };
            match rid {
                Ok(rid) => {
                    this.reload_rooms();
                    this.open_room(&rid);
                }
                Err(_) => this.toast(t("spotlight.open_failed").to_owned()),
            }
        });
    }

    /// Chosen, dropped or pasted: they wait in the composer until sent.
    /// A thread composer stages and sends like the room's, its files and
    /// voice messages (staged files too) answering the thread.
    pub(super) fn wire_thread_files(self: &Rc<Self>, thread: &Rc<ThreadPage>) {
        let (weak, target) = (Rc::downgrade(self), Rc::downgrade(thread));
        thread.composer.connect_files(move |picked| {
            if let Some(thread) = target.upgrade()
                && weak.upgrade().is_some_and(|this| this.current_rid().is_some())
            {
                thread.composer.stage(picked);
            }
        });
        let (weak, target) = (Rc::downgrade(self), Rc::downgrade(thread));
        thread.composer.connect_send_files(move |outgoing| {
            if let (Some(this), Some(thread)) = (weak.upgrade(), target.upgrade()) {
                this.send_files_in(Some(&thread), outgoing);
            }
        });
        let weak = Rc::downgrade(self);
        thread.composer.connect_error(move |text| {
            if let Some(this) = weak.upgrade() {
                this.toast(text);
            }
        });
    }

    fn attach_files(self: &Rc<Self>, picked: Vec<crate::attach::Picked>) {
        if self.current_rid().is_some() {
            self.composer.stage(picked);
        }
    }

    fn send_files(self: &Rc<Self>, outgoing: crate::composer::Outgoing) {
        self.send_files_in(None, outgoing);
    }

    /// Files of the room composer (`thread` None) or of a thread's.
    fn send_files_in(self: &Rc<Self>, thread: Option<&Rc<ThreadPage>>, outgoing: crate::composer::Outgoing) {
        let Some(rid) = self.current_rid() else { return };
        if self.current.borrow().as_ref().is_some_and(|r| r.encrypted) {
            match thread {
                Some(thread) => self.send_thread_private_files(thread, outgoing),
                None => self.send_private_files(outgoing),
            }
            return;
        }
        let provider = if let Some(s) = self.native_session() {
            crate::media::Provider::RocketVibe(s)
        } else if let Some(s) = self.session() {
            crate::media::Provider::RocketChat(s)
        } else {
            return;
        };
        let membership =
            self.native_membership.borrow().as_ref().filter(|(r, _)| r == &rid).and_then(|(_, m)| m.clone());
        let weak = Rc::downgrade(self);
        let toast: Rc<dyn Fn(String)> = Rc::new(move |text| {
            if let Some(this) = weak.upgrade() {
                this.toast(text);
            }
        });
        crate::attach::send_all_provider(
            provider,
            rid,
            thread.map(|t| t.root_id.clone()),
            outgoing.items,
            outgoing.caption,
            !outgoing.original,
            toast,
            membership,
        );
    }

    /// Uploads of the open room not settled yet: progress, or Retry and Discard.
    pub fn refresh_uploads(&self) {
        while let Some(child) = self.upload_strip.first_child() {
            self.upload_strip.remove(&child);
        }
        let Some(rid) = self.current_rid() else { return };
        let native = self.native_session();
        let legacy = self.session();
        let uploads = if let Some(s) = &native {
            s.file_uploads(&rid).unwrap_or_default()
        } else if let Some(s) = &legacy {
            s.store.uploads(&rid)
        } else {
            return;
        };
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
            match native
                .as_ref()
                .and_then(|s| s.upload_progress(&upload.id))
                .or_else(|| legacy.as_ref().and_then(|s| s.uploads.progress(&upload.id)))
            {
                Some(fraction) => column.append(&gtk::ProgressBar::builder().fraction(fraction).build()),
                None => {
                    let reconnecting = legacy.as_ref().is_some_and(|s| s.uploads.reconnecting());
                    let state = match (failed, reconnecting) {
                        (true, _) => "upload.failed",
                        (false, true) => "upload.retrying",
                        (false, false) => "upload.waiting",
                    };
                    column.append(&label(t(state), &["file-detail"]))
                }
            }
            row.append(&column);
            if failed {
                let retry = gtk::Button::builder()
                    .label(t("upload.retry"))
                    .css_classes(["file-action"])
                    .valign(gtk::Align::Center)
                    .build();
                let (s, n, id) = (legacy.clone(), native.clone(), upload.id.clone());
                retry.connect_clicked(move |_| {
                    let (s, n, id) = (s.clone(), n.clone(), id.clone());
                    crate::runtime().spawn(async move {
                        if let Some(s) = s {
                            s.uploads.retry(&id).await;
                        } else if let Some(n) = n {
                            let _ = n.retry_file(&id);
                        }
                    });
                });
                row.append(&retry);
            }
            let discard = gtk::Button::builder()
                .icon_name("window-close-symbolic")
                .tooltip_text(t("upload.discard"))
                .css_classes(["flat", "circular"])
                .valign(gtk::Align::Center)
                .build();
            let (s, n, id) = (legacy.clone(), native.clone(), upload.id.clone());
            discard.connect_clicked(move |_| {
                if let Some(s) = &s {
                    s.uploads.discard(&id);
                } else if let Some(n) = &n {
                    let _ = n.discard_file(&id);
                }
            });
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
        let names = if let Some(session) = self.native_session() {
            session.typing(rid, None)
        } else if let Some(session) = self.session.borrow().clone() {
            session.typing(rid)
        } else {
            return;
        };
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
        self.load_rooms(true);
        self.refresh_room_header();
    }

    pub fn reload_all(&self) {
        self.reload_rooms();
        self.reload_messages();
    }

    fn reload_rooms(&self) {
        self.load_rooms(false);
    }

    /// `force` builds every row again even when the data did not change:
    /// what they show also depends on presence, photos and the E2E lock.
    fn load_rooms(&self, force: bool) {
        let rows = if self.native_session().is_some() {
            self.native_rooms()
        } else {
            self.session.borrow().as_ref().map(|s| s.store.rooms()).unwrap_or_default()
        };
        if force || *self.rooms.borrow() != rows {
            let sections = rv_core::rooms::sections(&rows);
            let titled = sections.len() > 1;
            let mut objects = Vec::new();
            let mut slots = Vec::new();
            for (section, members) in sections {
                let collapsed = titled && self.collapsed.borrow().contains(&section.key());
                if titled {
                    let title = match &section {
                        Section::Unread => t("rooms.section_unread").to_owned(),
                        Section::Favorites => t("rooms.section_favorites").to_owned(),
                        Section::Group { name, .. } => name.clone(),
                        Section::Channels => t("rooms.section_channels").to_owned(),
                        Section::Direct => t("rooms.section_direct").to_owned(),
                    };
                    let count = members.len();
                    objects.push(glib::BoxedAnyObject::new(RoomItem::Header { section, title, collapsed, count }));
                    slots.push(None);
                }
                if collapsed {
                    continue;
                }
                for room in members {
                    slots.push(Some(room.rid.clone()));
                    objects.push(glib::BoxedAnyObject::new(RoomItem::Room(Box::new(room))));
                }
            }
            self.slots.replace(slots);
            crate::badge::set(rv_core::rooms::badge(&rows));
            let unread = rv_core::rooms::unread_rooms(&rows);
            for f in self.on_unread.borrow().iter() {
                f(unread);
            }
            self.suppress_selection.set(true);
            self.rooms_store.splice(0, self.rooms_store.n_items(), &objects);
            self.suppress_selection.set(false);

            if let Some(open) = self.current.borrow_mut().as_mut()
                && let Some(r) = rows.iter().find(|r| r.rid == open.rid)
            {
                open.name = r.name.clone();
                open.read_only = r.read_only;
                open.dm_other_uid = r.dm_other_uid.clone();
                open.avatar = if self.native_session().is_some() {
                    r.avatar_etag.as_ref().map(|id| format!("rv-avatar:{id}"))
                } else {
                    room_avatar_path(r)
                };
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

    pub fn toggle_section(&self, section: Section) {
        {
            let mut collapsed = self.collapsed.borrow_mut();
            let key = section.key();
            match collapsed.iter().position(|s| *s == key) {
                Some(at) => {
                    collapsed.remove(at);
                }
                None => collapsed.push(key),
            }
            let file = collapsed_file();
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(file, collapsed.join("\n"));
        }
        self.load_rooms(true);
    }

    fn select_current(&self, highlight: bool) {
        let current = self.current.borrow().as_ref().map(|r| r.rid.clone());
        let index = current.filter(|_| highlight).and_then(|rid| self.position_of(&rid));
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
        let tile = match self.native_session() {
            Some(session) => crate::rows::with_native_photo(
                tile,
                &session,
                open.avatar.as_deref().and_then(|path| path.strip_prefix("rv-avatar:")).map(str::to_owned),
            ),
            None => with_photo(tile, self.session.borrow().as_ref(), open.avatar.clone()),
        };
        self.room_title.append(&tile);
        let names = gtk::Box::builder().orientation(gtk::Orientation::Vertical).valign(gtk::Align::Center).build();
        let title = label(&open.name, &["room-title"]);
        title.set_ellipsize(gtk::pango::EllipsizeMode::End);
        names.append(&title);
        let presence = open
            .dm_other_uid
            .as_deref()
            .zip(self.session.borrow().clone())
            .and_then(|(uid, s)| s.presence(uid))
            .or_else(|| self.native_session().and_then(|s| s.room_presence(&open.rid)));
        if let Some(p) = presence {
            let line = gtk::Box::builder().spacing(5).build();
            let dot = crate::rows::presence_dot(p, &[]);
            dot.set_valign(gtk::Align::Center);
            line.append(&dot);
            line.append(&label(t(&format!("presence.{}", p.as_str())), &["room-subtitle"]));
            names.append(&line);
        }
        self.room_title.append(&names);
        let unlocked =
            self.native_crypto_ready.get() || self.session.borrow().as_ref().is_some_and(|s| s.e2e_unlocked());
        self.e2e_banner.set_visible(open.encrypted && !unlocked);
        self.e2e_unlock.set_visible(self.session.borrow().is_some());
        // Locked, nothing can leave an encrypted room: the server refuses clear text in it.
        let writable = !open.read_only && (!open.encrypted || unlocked);
        self.composer.root.set_visible(writable);
        self.read_only_label.set_label(t(if open.encrypted { "e2e.read_only" } else { "room.read_only" }));
        self.read_only_label.set_visible(!writable);
    }

    fn reload_messages(&self) {
        let Some(open) = self.current.borrow().clone() else { return };
        if let Some(session) = self.native_session() {
            if open.encrypted {
                self.list.set_native_rows(
                    rv_core::timeline::group(self.native_crypto_rows.borrow().clone()),
                    &session.info.user_id,
                );
                if let Some(thread) = self.thread.borrow().as_ref() {
                    thread.reload();
                }
                return;
            }
            self.composer.validate_native_reply(&session.store);
            self.native_quote_cards.show(
                &session,
                &open.rid,
                None,
                self.limit.get() as usize,
                self.native_unread_after
                    .borrow()
                    .clone()
                    .filter(|_| session.supported_features().iter().any(|f| f == "read_markers")),
            );
            if let Some(thread) = self.thread.borrow().as_ref() {
                thread.reload();
            }
            return;
        }
        let Some(session) = self.session.borrow().clone() else { return };
        let rows = match self.context.borrow().as_ref() {
            // A row the store also holds is the one live events keep up to date.
            Some(window) => {
                let rows = window.rows();
                let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
                let stored: HashMap<String, MessageRow> =
                    session.store.messages_by_id(&ids).into_iter().map(|r| (r.id.clone(), r)).collect();
                rows.into_iter().map(|r| stored.get(&r.id).cloned().unwrap_or(r)).collect()
            }
            None => session.store.messages(&open.rid, self.limit.get()),
        };
        self.list.set_rows(rows);
    }

    /// The oldest message of the local history, which runs unbroken to the present.
    fn local_oldest(&self, session: &Session, rid: &str) -> Option<i64> {
        session.store.messages(rid, self.limit.get()).first().map(|r| r.ts)
    }

    fn show_context(&self, window: Window) {
        let reached = !window.has_newer;
        self.context.replace(Some(window));
        if reached {
            self.merge_context();
        } else {
            self.list.set_detached(true);
            self.reload_messages();
        }
    }

    /// The window reached the local history: it joins it, and the room is live again.
    fn merge_context(&self) {
        let Some(window) = self.context.take() else { return };
        let Some(session) = self.session() else { return };
        session.store.write(|w| {
            for m in window.messages() {
                w.upsert_message(m);
            }
        });
        if let Some(oldest) = window.oldest_ts() {
            self.limit.set(session.store.count_since(window.rid(), oldest).max(self.limit.get()));
        }
        self.has_older.set(window.has_older);
        self.list.set_detached(false);
        self.reload_messages();
    }

    fn leave_context(&self) {
        if self.context.take().is_some() {
            self.list.set_detached(false);
            self.reload_messages();
        }
    }

    /// One more page of the window, older or newer; false when there is none.
    async fn context_page(self: &Rc<Self>, newer: bool) -> bool {
        let Some(mut window) = self.context.borrow().clone() else { return false };
        if self.loading.get() || !(if newer { window.has_newer } else { window.has_older }) {
            return false;
        }
        let Some(session) = self.session() else { return false };
        let local_oldest = self.local_oldest(&session, window.rid());
        self.set_loading(true);
        let window = on_tokio(async move {
            let read = if newer {
                window.newer(&session.sync, local_oldest, chrono::Utc::now().timestamp_millis()).await
            } else {
                window.older(&session.sync).await
            };
            read.map(|()| window)
        })
        .await;
        self.set_loading(false);
        let Ok(window) = window else { return false };
        if !self.context.borrow().as_ref().is_some_and(|c| c.rid() == window.rid()) {
            return false;
        }
        self.show_context(window);
        true
    }

    pub fn open_room(self: &Rc<Self>, rid: &str) {
        if self.native_session().is_some() {
            self.open_native_room(rid);
            return;
        }
        let Some(session) = self.session.borrow().clone() else { return };
        let Some(room) = self.rooms.borrow().iter().find(|r| r.rid == rid).cloned() else { return };
        for f in self.on_room_opened.borrow().iter() {
            f(rid.to_owned());
        }
        if self.current.borrow().as_ref().is_some_and(|c| c.rid == rid) {
            self.split.set_show_content(true);
            return;
        }
        self.remember(rid);
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
        self.threads_button.set_visible(session.threads_available());
        self.call_button.set_icon_name("camera-video-symbolic");
        self.call_button.set_tooltip_text(Some(t("room.call")));
        if !room.read_only {
            let (weak, s, rid) = (Rc::downgrade(self), session.clone(), rid.to_owned());
            let expected = session.clone();
            glib::spawn_future_local(async move {
                let available = on_tokio(async move { s.call_available().await }).await;
                if let Some(this) = weak.upgrade()
                    && this.session().is_some_and(|s| Arc::ptr_eq(&s, &expected))
                    && this.current_rid().as_deref() == Some(rid.as_str())
                {
                    this.call_button.set_visible(available);
                }
            });
        }
        let index = self.position_of(rid);
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
        self.context.replace(None);
        self.list.set_detached(false);
        self.list.clear();
        self.reload_messages();
        self.refresh_uploads();
        self.composer.grab_focus();

        self.set_loading(true);
        let weak = Rc::downgrade(self);
        let (rid, kind) = (room.rid, room.kind);
        let expected = session.clone();
        glib::spawn_future_local(async move {
            let page = crate::on_tokio({
                let (rid, kind) = (rid.clone(), kind.clone());
                async move { session.open_room(&rid, &kind).await }
            })
            .await;
            let Some(this) = weak.upgrade() else { return };
            if this.session().is_none_or(|s| !Arc::ptr_eq(&s, &expected)) {
                return;
            }
            if this.current.borrow().as_ref().is_some_and(|c| c.rid == rid) {
                if let Ok(page) = page {
                    this.has_older.set(page.count as i64 >= HISTORY_PAGE);
                }
                this.set_loading(false);
                if !this.list.holds_reveal() {
                    this.list.scroll_to_bottom();
                }
            }
        });
    }

    /// The room, scrolled to that message: what a notification opens.
    pub fn open_message(self: &Rc<Self>, rid: &str, id: &str) {
        self.open_room(rid);
        if self.current_rid().as_deref() == Some(rid) {
            if let Some(native) = self.native_session()
                && let Ok(Some(rank)) = native.store.message_rank(rid, id)
            {
                self.limit.set(self.limit.get().max(i64::from(rank) + HISTORY_PAGE));
                self.reload_messages();
            }
            self.list.reveal(id);
            self.composer.grab_focus();
        }
    }

    fn load_older(self: &Rc<Self>) {
        let this = self.clone();
        glib::spawn_future_local(async move {
            this.older_page().await;
        });
    }

    /// One more page of history; false when there is none, or one is already coming.
    async fn older_page(self: &Rc<Self>) -> bool {
        if self.context.borrow().is_some() {
            return self.context_page(false).await;
        }
        if self.native_session().is_some() {
            return self.native_history(true).await;
        }
        if self.loading.get() || !self.has_older.get() {
            return false;
        }
        let Some(open) = self.current.borrow().clone() else { return false };
        let Some(session) = self.session.borrow().clone() else { return false };
        let Some(oldest) = self.list.oldest_ts() else { return false };
        self.set_loading(true);
        let (rid, kind) = (open.rid.clone(), open.kind.clone());
        let s = session.clone();
        let page = crate::on_tokio(async move { s.sync.load_history(&rid, &kind, Some(oldest)).await }).await;
        if self.session().is_none_or(|current| !Arc::ptr_eq(&current, &session)) {
            return false;
        }
        let mut loaded = false;
        if self.current.borrow().as_ref().is_some_and(|c| c.rid == open.rid)
            && let Ok(page) = page
        {
            // `inclusive` returns the boundary message again: one row means nothing older.
            if page.count <= 1 {
                self.has_older.set(false);
            }
            // Down to the page and no further: an older message stored on its own
            // (starred, edited) would hide the hole above it.
            if let Some(oldest) = page.oldest_ts {
                self.limit.set(session.store.count_since(&open.rid, oldest));
            }
            self.reload_messages();
            loaded = true;
        }
        self.set_loading(false);
        loaded
    }

    /// Scrolls the open room to a message; one not loaded, however old, is
    /// shown in the history around it until that reaches the local one.
    pub fn jump_to(self: &Rc<Self>, id: &str) {
        self.user_navigation();
        if self.list.row(id).is_some() {
            self.list.reveal(id);
            return;
        }
        if self.native_session().is_some() {
            // A RocketVibe room pages back through its history until it is there.
            self.list.reveal(id);
            let (this, id) = (self.clone(), id.to_owned());
            glib::spawn_future_local(async move {
                for _ in 0..30 {
                    if this.list.row(&id).is_some() || !this.older_page().await {
                        break;
                    }
                }
                if this.list.row(&id).is_none() {
                    this.list.forget_reveal();
                    this.toast(t("marked.not_loaded").to_owned());
                }
            });
            return;
        }
        let (Some(open), Some(session)) = (self.current.borrow().clone(), self.session()) else { return };
        let local_oldest = self.local_oldest(&session, &open.rid);
        self.set_loading(true);
        let (this, id) = (self.clone(), id.to_owned());
        glib::spawn_future_local(async move {
            let (rid, kind, target) = (open.rid.clone(), open.kind.clone(), id.clone());
            let window = on_tokio(async move {
                let now = chrono::Utc::now().timestamp_millis();
                Window::around(&session.sync, &rid, &kind, &target, local_oldest, now).await
            })
            .await;
            this.set_loading(false);
            if this.current_rid().as_deref() != Some(open.rid.as_str()) {
                return;
            }
            match window {
                Ok(Some(window)) => {
                    this.show_context(window);
                    this.list.reveal(&id);
                }
                _ => this.toast(t("marked.not_loaded").to_owned()),
            }
        });
    }

    pub fn send_text(self: &Rc<Self>, text: &str) {
        let Some(open) = self.current.borrow().clone() else { return };
        let Some(text) = self.native_command(&self.composer, &open.rid, text.to_owned()) else { return };
        let text = text.as_str();
        if open.encrypted && self.native_session().is_some() {
            self.send_native_crypto(text.to_owned());
            return;
        }
        if let Some(session) = self.native_session() {
            if self.composer.send_private_reference(text.to_owned()) {
                return;
            }
            let scope = self.native_membership.borrow().clone();
            let Some((rid, membership)) = scope.filter(|(rid, _)| rid == &open.rid) else {
                return;
            };
            let selected = self.composer.native_reply().into_iter().collect::<Vec<_>>();
            if let Err(error) = session.send_quotes_from_membership(&rid, text, membership.as_deref(), &selected) {
                if error.code() == "delivery_revalidate" {
                    self.invalidate_native_room();
                } else {
                    self.composer.set_text(text);
                }
                self.native_error(&error);
            } else {
                self.composer.clear_reply();
            }
            return;
        }
        self.send_or_run(&self.composer, &open.rid, None, text.to_owned());
    }

    /// Sends `text`, or runs it when it names a slash command; a command the
    /// server refuses goes back into `composer`.
    fn send_or_run(self: &Rc<Self>, composer: &Rc<Composer>, rid: &str, thread: Option<&str>, text: String) {
        self.send_or_run_shown(composer, rid, thread, text, false);
    }

    /// `send_or_run`, a thread reply also sent to the room when `shown`.
    fn send_or_run_shown(
        self: &Rc<Self>,
        composer: &Rc<Composer>,
        rid: &str,
        thread: Option<&str>,
        text: String,
        shown: bool,
    ) {
        let Some(session) = self.session.borrow().clone() else { return };
        if (thread.is_none() || shown) && self.list.is_detached() {
            self.list.jump();
        }
        let (rid, thread) = (rid.to_owned(), thread.map(str::to_owned));
        if rv_core::commands::split(&text).is_none() {
            runtime().spawn(async move { session.send_reply(&rid, &text, thread.as_deref(), shown).await });
            return;
        }
        let (weak, composer) = (Rc::downgrade(self), Rc::downgrade(composer));
        glib::spawn_future_local(async move {
            let draft = text.clone();
            let failed = on_tokio(async move {
                match session.run_command(&rid, &text, thread.as_deref()).await {
                    Some(result) => result.err(),
                    None => {
                        session.send_reply(&rid, &text, thread.as_deref(), shown).await;
                        None
                    }
                }
            })
            .await;
            let (Some(this), Some(error)) = (weak.upgrade(), failed) else { return };
            this.toast(tf("command.failed", &[("error", &error.message)]));
            if let Some(composer) = composer.upgrade().filter(|c| c.text().is_empty()) {
                composer.set_text(&draft);
            }
        });
    }

    /// A slash command's answer, shown under the page it was typed in.
    pub fn on_private(&self, rid: &str, text: &str) {
        let Some(session) = self.session.borrow().clone() else { return };
        let me = &session.info.username;
        if let Some(thread) = self.thread.borrow().as_ref().filter(|t| t.rid == rid) {
            thread.composer.show_private(text, me);
            return;
        }
        if self.current.borrow().as_ref().is_some_and(|open| open.rid == rid) {
            self.composer.show_private(text, me);
        }
    }

    fn retry(&self, id: String) {
        if let Some(session) = self.native_session() {
            if let Err(error) = session.retry(&id) {
                self.toast(error.to_string());
            }
            return;
        }
        if let Some(session) = self.session.borrow().clone() {
            runtime().spawn(async move { session.retry(&id).await });
        }
    }

    fn position_of(&self, rid: &str) -> Option<usize> {
        self.slots.borrow().iter().position(|slot| slot.as_deref() == Some(rid))
    }

    pub fn connect_unread_changed(&self, f: impl Fn(usize) + 'static) {
        self.on_unread.borrow_mut().push(Box::new(f));
    }

    pub fn has_room(&self, rid: &str) -> bool {
        self.rooms.borrow().iter().any(|r| r.rid == rid)
    }

    pub fn scroll_list_to_top(&self) {
        self.list.scroll_to_top();
    }

    pub fn scroll_list_to_bottom(&self) {
        self.list.scroll_to_bottom();
    }

    /// What the list shows of a room's unread state: its count and alert.
    pub fn listed_unread(&self, rid: &str) -> Option<(i64, bool)> {
        self.rooms.borrow().iter().find(|r| r.rid == rid).map(|r| (r.unread, r.alert))
    }

    /// The room selected in the list, if any.
    pub fn selected_room(&self) -> Option<String> {
        self.slots.borrow().get(self.rooms_selection.selected() as usize).cloned().flatten()
    }

    pub fn room_named(&self, name: &str) -> Option<String> {
        self.rooms.borrow().iter().find(|r| r.name == name).map(|r| r.rid.clone())
    }

    pub fn message_count(&self) -> usize {
        self.list.len()
    }

    /// What a tap on the room's row does: select it in the list.
    pub fn tap_room(&self, rid: &str) {
        let index = self.position_of(rid);
        if let Some(i) = index {
            self.rooms_selection.set_selected(i as u32);
        }
    }

    /// Mouse back: out of a thread, then from the room to the list when one
    /// pane shows, then to the room opened before.
    pub fn navigate_back(self: &Rc<Self>) {
        if self.room_nav.visible_page().and_then(|p| p.tag()).as_deref() == Some("thread") {
            self.room_nav.pop();
        } else if self.split.is_collapsed() && self.split.shows_content() {
            self.split.set_show_content(false);
        } else if self.history_at.get() > 0 {
            self.walk_to(self.history_at.get() - 1);
        }
    }

    /// Mouse forward: back into the open room from the list, then to the room
    /// left by going back.
    pub fn navigate_forward(self: &Rc<Self>) {
        if self.split.is_collapsed() && !self.split.shows_content() && self.current.borrow().is_some() {
            self.split.set_show_content(true);
        } else if self.history_at.get() + 1 < self.history.borrow().len() {
            self.walk_to(self.history_at.get() + 1);
        }
    }

    fn walk_to(self: &Rc<Self>, at: usize) {
        let Some(rid) = self.history.borrow().get(at).cloned() else { return };
        self.user_navigation();
        self.history_at.set(at);
        self.walking.set(true);
        self.open_room(&rid);
        self.walking.set(false);
    }

    fn remember(&self, rid: &str) {
        if self.walking.get() {
            return;
        }
        let mut history = self.history.borrow_mut();
        if history.get(self.history_at.get()).map(String::as_str) == Some(rid) {
            return;
        }
        let keep = if history.is_empty() { 0 } else { self.history_at.get() + 1 };
        history.truncate(keep);
        history.push(rid.to_owned());
        self.history_at.set(history.len() - 1);
    }

    /// The way back to the open room, on the room list when it shows alone.
    fn update_forward(&self) {
        let alone = self.split.is_collapsed() && !self.split.shows_content();
        self.forward_button.set_visible(alone && self.current.borrow().is_some());
    }

    /// Presses Up in the empty composer.
    pub fn edit_last_mine(self: &Rc<Self>) {
        self.edit_last(false);
    }

    pub fn room_list(&self) -> Rc<MessageList> {
        self.list.clone()
    }

    pub fn offers_way_back(&self) -> bool {
        self.forward_button.is_visible()
    }

    pub fn go_back(&self) {
        self.user_navigation();
        self.split.set_show_content(false);
    }

    pub fn set_account_actions(&self, actions: crate::settings::AccountActions) {
        self.account_actions.replace(Some(Rc::new(actions)));
    }

    pub fn connect_room_opened(&self, f: impl Fn(String) + 'static) {
        self.on_room_opened.borrow_mut().push(Box::new(f));
    }

    pub fn connect_user_navigation(&self, f: impl Fn() + 'static) {
        self.on_user_navigation.borrow_mut().push(Box::new(f));
    }
    fn user_navigation(&self) {
        for f in self.on_user_navigation.borrow().iter() {
            f();
        }
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

    /// The account on screen, whichever server it speaks to: at most one of
    /// `session` and `native` is set (`set_session` and `set_native_session`
    /// each clear the other).
    pub fn chat(&self) -> Option<rv_core::provider::Chat> {
        self.native_session().map(Into::into).or_else(|| self.session().map(Into::into))
    }

    fn current_name(&self) -> String {
        self.current.borrow().as_ref().map(|o| o.name.clone()).unwrap_or_default()
    }

    fn open_call(self: &Rc<Self>, url: &str, room: &str) {
        let weak = Rc::downgrade(self);
        crate::call_window::open(&self.split, url, room, move |text| {
            if let Some(this) = weak.upgrade() {
                this.toast(text);
            }
        });
    }

    pub fn current_rid(&self) -> Option<String> {
        self.current.borrow().as_ref().map(|o| o.rid.clone())
    }

    pub fn composer_rc(&self) -> Rc<Composer> {
        self.composer.clone()
    }

    pub fn composer(&self) -> &Composer {
        &self.composer
    }

    pub fn typing_text(&self) -> Option<String> {
        self.typing_label.is_visible().then(|| self.typing_label.label().to_string())
    }

    pub fn header_presence(&self) -> Option<String> {
        let open = self.current.borrow().clone()?;
        if let Some(session) = self.native_session() {
            return session.room_presence(&open.rid).map(|p| p.as_str().to_owned());
        }
        let session = self.session.borrow().clone()?;
        session.presence(open.dm_other_uid.as_deref()?).map(|p| p.as_str().to_owned())
    }

    pub fn has_new_marker(&self) -> bool {
        self.list.has_new_marker()
    }

    pub fn new_pill_shown(&self) -> bool {
        self.list.new_pill_shown()
    }

    pub fn message_texts(&self) -> Vec<String> {
        self.list.texts()
    }

    /// Rows the room list shows, section titles included.
    pub fn listed_rows(&self) -> u32 {
        self.rooms_store.n_items()
    }

    pub fn room_count(&self) -> usize {
        self.rooms.borrow().len()
    }
}
