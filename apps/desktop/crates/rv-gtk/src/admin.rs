//! Server administration, for an administrator: a sidebar dialog like the
//! settings with the Dashboard, the Moderation of members' reports, the Rooms,
//! the Users and the Custom emoji (`admin_emoji`; rv-core's `admin`, both
//! providers). Also the Report dialog every member uses on a message or an
//! account.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use rv_core::admin::{
    Admin, AdminError, AdminRoom, AdminUser, KindCounts, Overview, Page, Presence, Product, ReportedMessage,
    ReportedUser, ReportedUserDetails, RoomType,
};
use rv_core::media::{AvatarTarget, avatar_path};

use crate::i18n::{self, t, tf, tn};
use crate::on_tokio;
use crate::sidebar_dialog::{Host, SidebarDialog};
use crate::widgets::{self, TileSize};

type Category = (&'static str, &'static str, &'static str);
const DASHBOARD: Category = ("dashboard", "network-server-symbolic", "admin.cat.dashboard");
const MODERATION: Category = ("moderation", "dialog-warning-symbolic", "admin.cat.moderation");
const ROOMS: Category = ("rooms", "chat-message-new-symbolic", "admin.cat.rooms");
const USERS: Category = ("users", "system-users-symbolic", "admin.cat.users");
const EMOJI: Category = ("emoji", "face-smile-symbolic", "admin.cat.emoji");

/// The administration being shown: the provider, and its dialog.
#[derive(Clone)]
struct Screen {
    admin: Admin,
    host: Host,
}

/// Opens the administration on its Dashboard. The caller checked `is_admin`.
pub fn open(parent: &impl IsA<gtk::Widget>, admin: Admin) -> SidebarDialog {
    let dialog = SidebarDialog::new(t("admin.title"), "admin-dialog");
    let screen = Screen { admin, host: dialog.host() };
    let (id, icon, title) = DASHBOARD;
    dialog.add_content(id, icon, t(title), &dashboard(&screen));
    for (category, build) in
        [(MODERATION, moderation as fn(&Screen) -> adw::PreferencesPage), (ROOMS, rooms), (USERS, users)]
    {
        let (id, icon, title) = category;
        let screen = screen.clone();
        dialog.add_lazy(id, icon, t(title), move |_| build(&screen));
    }
    if screen.admin.emoji_supported() {
        let (id, icon, title) = EMOJI;
        dialog.add_lazy(id, icon, t(title), move |_| crate::admin_emoji::page(&screen.admin, &screen.host));
    }
    dialog.present(parent);
    dialog
}

/// Runs provider work on tokio; `done` only while the dialog is open (the
/// settings' bots page uses it too).
pub(crate) fn spawn<T: Send + 'static>(
    host: &Host,
    work: impl Future<Output = T> + Send + 'static,
    done: impl FnOnce(T) + 'static,
) {
    let host = host.clone();
    glib::spawn_future_local(async move {
        let result = on_tokio(work).await;
        if host.alive() {
            done(result);
        }
    });
}

pub(crate) fn error_text(error: &AdminError) -> &'static str {
    t(rv_core::admin::error_key(&error.code))
}

/// `2026-10-07T09:00:00Z` as a local date.
fn date(text: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(text)
        .map(|d| {
            d.with_timezone(&chrono::Local).format_localized("%e %b %Y", i18n::locale()).to_string().trim().to_owned()
        })
        .unwrap_or_else(|_| text.to_owned())
}

/// `2026-10-07T09:00:00Z` as a local date and time.
pub(crate) fn date_time(text: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(text)
        .map(|d| {
            let local = d.with_timezone(&chrono::Local);
            local.format_localized("%e %b %Y %H:%M", i18n::locale()).to_string().trim().to_owned()
        })
        .unwrap_or_else(|_| text.to_owned())
}

/// A figure, "–" when the server would not say.
fn figure(value: Option<u64>) -> String {
    value.map_or_else(|| t("admin.unknown").to_owned(), |v| v.to_string())
}

fn duration(seconds: u64) -> String {
    let (days, hours, minutes) = (seconds / 86_400, seconds % 86_400 / 3600, seconds % 3600 / 60);
    if days > 0 {
        tf("admin.days", &[("d", &days.to_string()), ("h", &hours.to_string())])
    } else if hours > 0 {
        tf("admin.hours", &[("h", &hours.to_string()), ("m", &minutes.to_string())])
    } else {
        tf("admin.minutes", &[("m", &minutes.to_string())])
    }
}

fn count(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

fn value_row(title: &str, value: &str) -> adw::ActionRow {
    let row = adw::ActionRow::builder().title(title).use_markup(false).build();
    row.add_suffix(&gtk::Label::builder().label(value).selectable(true).css_classes(["admin-value"]).build());
    row
}

/// An instance id (a long hexadecimal string) shown short, whole in its
/// tooltip, with a button copying it.
fn instance_row(id: &str) -> adw::ActionRow {
    let shown =
        if id.chars().count() > 12 { format!("{}…", id.chars().take(12).collect::<String>()) } else { id.to_owned() };
    let row = adw::ActionRow::builder().title(t("admin.instance")).use_markup(false).build();
    row.add_suffix(&gtk::Label::builder().label(&shown).tooltip_text(id).css_classes(["admin-value"]).build());
    let copy = gtk::Button::builder()
        .icon_name("edit-copy-symbolic")
        .tooltip_text(t("actions.copy"))
        .valign(gtk::Align::Center)
        .css_classes(["flat", "admin-copy"])
        .build();
    let id = id.to_owned();
    copy.connect_clicked(move |button| button.clipboard().set_text(&id));
    row.add_suffix(&copy);
    row
}

fn dot(presence: Presence) -> gtk::Widget {
    gtk::Box::builder()
        .css_classes(["presence", presence.key()])
        .valign(gtk::Align::Center)
        .tooltip_text(t(&format!("presence.{}", presence.key())))
        .build()
        .upcast()
}

/// A person's tile with their photo when the server has one.
fn avatar(screen: &Screen, username: &str, version: Option<&str>, size: TileSize) -> gtk::Widget {
    let tile = widgets::tile(username, &widgets::initial(username), size, false);
    match &screen.admin {
        // No version: no photo; the bare URL would show the server's placeholder.
        Admin::RocketChat(s) => crate::rows::with_photo(
            tile,
            Some(s),
            version.filter(|_| !username.is_empty()).map(|v| avatar_path(AvatarTarget::User(username), Some(v))),
        ),
        Admin::Native(s) => crate::rows::with_native_photo(tile, s, version.map(str::to_owned)),
    }
}

fn room_tile(room: &AdminRoom) -> gtk::Widget {
    let glyph = match room.kind {
        RoomType::Public => "#".to_owned(),
        RoomType::Private => "🔒".to_owned(),
        RoomType::Direct => widgets::initial(&room.name),
        RoomType::Discussion => "💬".to_owned(),
    };
    widgets::tile(&room.name, &glyph, TileSize::Message, room.kind == RoomType::Private)
}

/// Asks before an action that cannot be taken back.
fn confirm(host: &Host, heading: &str, body: &str, action: &str, run: impl Fn() + 'static) {
    confirm_class(host, heading, body, action, "admin-confirm", run);
}

/// `confirm`, with a class of its own (the second confirmations, the bots
/// page's).
pub(crate) fn confirm_class(
    host: &Host,
    heading: &str,
    body: &str,
    action: &str,
    class: &str,
    run: impl Fn() + 'static,
) {
    let Some(parent) = host.widget() else { return };
    let alert = adw::AlertDialog::builder()
        .heading(heading)
        .body(body)
        .default_response("cancel")
        .close_response("cancel")
        .prefer_wide_layout(true)
        // A builder's classes replace the dialog's own `alert`, which its whole style needs.
        .css_classes(["alert", class])
        .build();
    alert.add_responses(&[("cancel", t("actions.cancel")), ("confirm", action)]);
    alert.set_response_appearance("confirm", adw::ResponseAppearance::Destructive);
    alert.connect_response(Some("confirm"), move |_, _| run());
    widgets::present(&alert, Some(&parent));
}

/// The rows of one list in a group, with a loading or "Show more" row at
/// its end. A new generation drops a page still on its way.
struct List {
    group: adw::PreferencesGroup,
    rows: RefCell<Vec<gtk::Widget>>,
    tail: RefCell<Option<gtk::Widget>>,
    generation: Cell<u64>,
}

impl List {
    fn new(group: &adw::PreferencesGroup) -> Rc<Self> {
        Rc::new(List {
            group: group.clone(),
            rows: RefCell::default(),
            tail: RefCell::default(),
            generation: Cell::new(0),
        })
    }
    fn push(&self, row: &impl IsA<gtk::Widget>) {
        self.group.add(row);
        self.rows.borrow_mut().push(row.as_ref().clone());
    }
    fn set_tail(&self, row: Option<gtk::Widget>) {
        if let Some(old) = self.tail.replace(row.clone()) {
            self.group.remove(&old);
        }
        if let Some(row) = row {
            self.group.add(&row);
        }
    }
    fn note(&self, text: &str) {
        self.push(&adw::ActionRow::builder().title(text).use_markup(false).css_classes(["admin-note"]).build());
    }
    fn reset(&self) {
        self.generation.set(self.generation.get().wrapping_add(1));
        for row in self.rows.take() {
            self.group.remove(&row);
        }
        self.set_tail(None);
    }
}

type Fetch<T> = Rc<dyn Fn(Option<String>) -> Pin<Box<dyn Future<Output = Result<Page<T>, AdminError>> + Send>>>;
type Render<T> = Rc<dyn Fn(&List, T)>;

/// Loads a page into `list` (the first one with `after` None), then offers the next.
fn fill<T: Send + 'static>(
    host: &Host,
    list: &Rc<List>,
    after: Option<String>,
    empty: &'static str,
    fetch: Fetch<T>,
    render: Render<T>,
) {
    let generation = list.generation.get();
    let first = after.is_none();
    list.set_tail(Some(
        adw::ActionRow::builder().title(t("crypto.loading")).css_classes(["admin-loading"]).build().upcast(),
    ));
    let (h, l) = (host.clone(), list.clone());
    spawn(host, fetch(after), move |result| {
        if l.generation.get() != generation {
            return;
        }
        l.set_tail(None);
        match result {
            Err(error) => l.note(error_text(&error)),
            Ok(page) => {
                if first && page.items.is_empty() {
                    l.note(t(empty));
                }
                for item in page.items {
                    render(&l, item);
                }
                if let Some(next) = page.next {
                    let more = adw::ButtonRow::builder()
                        .title(t("admin.load_more"))
                        .css_classes(["button", "admin-more"])
                        .build();
                    let (h, list) = (h.clone(), l.clone());
                    more.connect_activated(move |_| {
                        fill(&h, &list, Some(next.clone()), empty, fetch.clone(), render.clone());
                    });
                    l.set_tail(Some(more.upcast()));
                }
            }
        }
    });
}

/// The overview's cards in two columns, each one as tall as its cards (no
/// row leaves a hole), one column when the dialog is narrow.
#[derive(Clone)]
struct Cards {
    columns: gtk::Box,
    left: gtk::Box,
    right: gtk::Box,
}

impl Cards {
    fn clear(&self) {
        for column in [&self.left, &self.right] {
            while let Some(child) = column.first_child() {
                column.remove(&child);
            }
        }
    }
    /// To the column with fewer cards: left, right, left... in reading order.
    fn add(&self, group: &adw::PreferencesGroup) {
        let shorter = if self.left.observe_children().n_items() <= self.right.observe_children().n_items() {
            &self.left
        } else {
            &self.right
        };
        group.add_css_class("admin-card");
        shorter.append(group);
    }
}

fn dashboard(screen: &Screen) -> gtk::Widget {
    let column = || {
        gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(30)
            .valign(gtk::Align::Start)
            .hexpand(true)
            .build()
    };
    let (left, right) = (column(), column());
    let columns = gtk::Box::builder().spacing(30).homogeneous(true).css_classes(["admin-cards"]).build();
    columns.append(&left);
    columns.append(&right);
    let clamp = adw::Clamp::builder()
        .maximum_size(1000)
        .tightening_threshold(900)
        .margin_top(30)
        .margin_bottom(36)
        .margin_start(24)
        .margin_end(24)
        .child(&columns)
        .build();
    let cards = Cards { columns: columns.clone(), left, right };
    load_dashboard(screen, &cards, false);
    let scroller =
        gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&clamp).build();
    let bin = adw::BreakpointBin::builder()
        .width_request(300)
        .height_request(200)
        .child(&scroller)
        .css_classes(["admin-dashboard"])
        .build();
    let narrow = adw::Breakpoint::new(adw::BreakpointCondition::new_length(
        adw::BreakpointConditionLengthType::MaxWidth,
        680.0,
        adw::LengthUnit::Sp,
    ));
    narrow.add_setter(&cards.columns, "orientation", Some(&gtk::Orientation::Vertical.to_value()));
    narrow.add_setter(&cards.columns, "homogeneous", Some(&false.to_value()));
    bin.add_breakpoint(narrow);
    bin.upcast()
}

/// The figures; Rocket.Chat's last snapshot unless `refresh` asks new ones
/// (a full aggregation on the server: the refresh button only).
fn load_dashboard(screen: &Screen, cards: &Cards, refresh: bool) {
    cards.clear();
    let waiting = adw::PreferencesGroup::new();
    waiting.add(&adw::ActionRow::builder().title(t("crypto.loading")).build());
    cards.add(&waiting);
    let admin = screen.admin.clone();
    let (s, c) = (screen.clone(), cards.clone());
    spawn(&screen.host, async move { admin.overview(refresh).await }, move |result| {
        c.clear();
        match result {
            Ok(overview) => {
                let reports = overview.reports.messages.unwrap_or(0) + overview.reports.users.unwrap_or(0);
                s.host.set_badge(MODERATION.0, (reports > 0).then(|| reports.to_string()).as_deref());
                for group in overview_groups(&s, &c, &overview) {
                    c.add(&group);
                }
                bots_card(&s, &c);
                icon_card(&s, &c);
            }
            Err(error) => {
                let group = adw::PreferencesGroup::new();
                group.add(&adw::ActionRow::builder().title(error_text(&error)).build());
                c.add(&group);
            }
        }
    });
}

fn kind_group(title: &str, counts: &KindCounts) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::builder().title(title).build();
    for (key, value) in [
        ("admin.total", Some(counts.total)),
        ("admin.public", Some(counts.public)),
        ("admin.private", Some(counts.private)),
        ("admin.direct", Some(counts.direct)),
        ("admin.discussions", counts.discussions),
        ("admin.encrypted", counts.encrypted),
    ] {
        if let Some(value) = value {
            group.add(&value_row(t(key), &value.to_string()));
        }
    }
    group
}

/// The Workspace cards: deployment, users, rooms, messages, uploads, reports.
fn overview_groups(screen: &Screen, cards: &Cards, o: &Overview) -> Vec<adw::PreferencesGroup> {
    let deployment = adw::PreferencesGroup::builder().title(t("admin.deployment")).build();
    let refresh = gtk::Button::builder()
        .icon_name("view-refresh-symbolic")
        .tooltip_text(t("admin.refresh_figures"))
        .valign(gtk::Align::Center)
        .css_classes(["flat", "admin-refresh"])
        .build();
    let (s, c) = (screen.clone(), cards.clone());
    refresh.connect_clicked(move |_| load_dashboard(&s, &c, true));
    deployment.set_header_suffix(Some(&refresh));
    if let Some(as_of) = &o.as_of {
        deployment.set_description(Some(&tf("admin.as_of", &[("date", &date_time(as_of))])));
    }
    let version = value_row(t("admin.version"), &o.version);
    let latest = gtk::Label::builder().css_classes(["admin-update"]).visible(false).build();
    version.add_suffix(&latest);
    let (admin, current) = (screen.admin.clone(), o.version.clone());
    spawn(&screen.host, async move { admin.latest_version().await }, move |found| {
        let Some(found) = found else { return };
        if rv_core::admin::update_available(&current, &found) {
            latest.set_label(&tf("admin.update_available", &[("version", &found)]));
            latest.add_css_class("available");
        } else {
            latest.set_label(t("admin.up_to_date"));
        }
        latest.set_visible(true);
    });
    deployment.add(&version);
    if let Some(uptime) = o.uptime_seconds {
        deployment.add(&value_row(t("admin.uptime"), &duration(uptime)));
    }
    deployment.add(&value_row(t("admin.database"), &o.database));
    for (key, value) in [("admin.migration", &o.migration), ("admin.runtime", &o.runtime)] {
        if let Some(value) = value {
            deployment.add(&value_row(t(key), value));
        }
    }
    if let Some(instance) = &o.instance_id {
        deployment.add(&instance_row(instance));
    }

    let users = adw::PreferencesGroup::builder().title(t("admin.cat.users")).build();
    for (key, value) in [
        ("admin.total", Some(o.users.total)),
        ("admin.active", Some(o.users.active)),
        ("admin.deactivated", Some(o.users.deactivated)),
    ] {
        if let Some(value) = value {
            users.add(&value_row(t(key), &value.to_string()));
        }
    }
    users.add(&value_row(t("admin.admins"), &figure(o.users.admins)));
    for (presence, value) in [
        (Presence::Online, o.users.online),
        (Presence::Away, o.users.away),
        (Presence::Busy, o.users.busy),
        (Presence::Offline, o.users.offline),
    ] {
        let row = value_row(t(&format!("presence.{}", presence.key())), &value.to_string());
        row.add_prefix(&dot(presence));
        users.add(&row);
    }

    let uploads = adw::PreferencesGroup::builder().title(t("admin.uploads")).build();
    uploads.add(&value_row(t("admin.uploads_count"), &o.uploads.count.to_string()));
    uploads.add(&value_row(t("admin.uploads_size"), &glib::format_size(o.uploads.bytes)));

    let reports = adw::PreferencesGroup::builder().title(t("admin.reports")).build();
    reports.add(&value_row(t("admin.reported_messages"), &figure(o.reports.messages)));
    reports.add(&value_row(t("admin.reported_users"), &figure(o.reports.users)));
    let open = adw::ButtonRow::builder()
        .title(t("admin.open_moderation"))
        .end_icon_name("go-next-symbolic")
        .css_classes(["button", "admin-open-moderation"])
        .build();
    let host = screen.host.clone();
    open.connect_activated(move |_| host.select(MODERATION.0));
    reports.add(&open);

    vec![
        deployment,
        users,
        kind_group(t("admin.cat.rooms"), &o.rooms),
        kind_group(t("admin.messages"), &o.messages),
        uploads,
        reports,
    ]
}

/// The server's icon, which the rails of every app show: the current one,
/// Change (a picked image, center-cropped to a square of
/// `server_icon::RC_SIDE` pixels, the size Rocket.Chat demands) and Remove.
fn icon_card(screen: &Screen, cards: &Cards) {
    if !screen.admin.icon_supported() {
        return;
    }
    let group = adw::PreferencesGroup::builder()
        .title(t("admin.icon_title"))
        .description(t("admin.icon_hint"))
        .css_classes(["admin-icon"])
        .build();
    let row = adw::ActionRow::builder().title(t("admin.icon_none")).use_markup(false).build();
    let preview = gtk::Picture::builder()
        .content_fit(gtk::ContentFit::Cover)
        .width_request(44)
        .height_request(44)
        .overflow(gtk::Overflow::Hidden)
        .css_classes(["rail-icon"])
        .visible(false)
        .build();
    row.add_prefix(&preview);
    let change = gtk::Button::builder().label(t("admin.icon_change")).valign(gtk::Align::Center).build();
    let remove = gtk::Button::builder()
        .label(t("admin.icon_remove"))
        .valign(gtk::Align::Center)
        .css_classes(["destructive-action"])
        .visible(false)
        .build();
    row.add_suffix(&change);
    row.add_suffix(&remove);
    group.add(&row);
    cards.add(&group);
    let show: Rc<dyn Fn()> = {
        let (screen, row, preview, remove) = (screen.clone(), row.clone(), preview.clone(), remove.clone());
        Rc::new(move || {
            let info = screen.admin.info().clone();
            let (row, preview, remove) = (row.clone(), preview.clone(), remove.clone());
            spawn(&screen.host, async move { rv_core::server_icon::fetch(&info).await }, move |icon| {
                let texture = match icon {
                    rv_core::server_icon::Icon::Image(bytes) => crate::rail::icon_texture(&bytes),
                    _ => None,
                };
                preview.set_paintable(texture.as_ref());
                preview.set_visible(texture.is_some());
                remove.set_visible(texture.is_some());
                row.set_title(t(if texture.is_some() { "admin.icon_current" } else { "admin.icon_none" }));
            });
        })
    };
    show();
    let (s, again) = (screen.clone(), show.clone());
    change.connect_clicked(move |button| {
        let filter = gtk::FileFilter::new();
        for mime in ["image/png", "image/jpeg"] {
            filter.add_mime_type(mime);
        }
        let filters = gtk::gio::ListStore::new::<gtk::FileFilter>();
        filters.append(&filter);
        let chooser = gtk::FileDialog::builder().title(t("admin.icon_change")).filters(&filters).modal(true).build();
        let window = button.root().and_downcast::<gtk::Window>();
        let (s, again) = (s.clone(), again.clone());
        chooser.open(window.as_ref(), None::<&gtk::gio::Cancellable>, move |file| {
            let Some(path) = file.ok().and_then(|f| f.path()) else { return };
            let Some(png) = square_png(&path, rv_core::server_icon::RC_SIDE) else {
                s.host.toast(t("admin.icon_error_image"));
                return;
            };
            let (admin, host, again) = (s.admin.clone(), s.host.clone(), again.clone());
            spawn(&s.host, async move { admin.set_icon(Some(png)).await }, move |result| {
                match result {
                    Ok(()) => host.toast(t("admin.icon_saved")),
                    Err(error) => host.toast(error_text(&error)),
                }
                again();
                crate::rail::reload_icons();
            });
        });
    });
    let (s, again) = (screen.clone(), show);
    remove.connect_clicked(move |_| {
        let (admin, host, again) = (s.admin.clone(), s.host.clone(), again.clone());
        confirm(
            &s.host,
            t("admin.icon_remove_title"),
            t("admin.icon_remove_body"),
            t("admin.icon_remove"),
            move || {
                let (admin, host, again) = (admin.clone(), host.clone(), again.clone());
                let h = host.clone();
                spawn(&host, async move { admin.set_icon(None).await }, move |result| {
                    match result {
                        Ok(()) => h.toast(t("admin.icon_removed")),
                        Err(error) => h.toast(error_text(&error)),
                    }
                    again();
                    crate::rail::reload_icons();
                });
            },
        );
    });
}

/// An image file as a PNG square of `side` pixels, its center kept.
fn square_png(path: &std::path::Path, side: u32) -> Option<Vec<u8>> {
    let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_file(path).ok()?;
    // A camera photo stands upright, as the profile photo does.
    let pixbuf = pixbuf.apply_embedded_orientation().unwrap_or(pixbuf);
    let edge = pixbuf.width().min(pixbuf.height());
    if edge <= 0 {
        return None;
    }
    let square = pixbuf.new_subpixbuf((pixbuf.width() - edge) / 2, (pixbuf.height() - edge) / 2, edge, edge);
    let scaled = square.scale_simple(side as i32, side as i32, gtk::gdk_pixbuf::InterpType::Bilinear)?;
    scaled.save_to_bufferv("png", &[]).ok()
}

/// RocketVibe with bots: whether every account may create one. The card
/// shows only once the server said (None: no bots there).
fn bots_card(screen: &Screen, cards: &Cards) {
    let admin = screen.admin.clone();
    let (s, c) = (screen.clone(), cards.clone());
    spawn(&screen.host, async move { admin.user_bots().await }, move |found| {
        let Ok(Some(on)) = found else { return };
        let group = adw::PreferencesGroup::builder().title(t("admin.bots")).css_classes(["admin-bots"]).build();
        let switch = adw::SwitchRow::builder()
            .title(t("admin.user_bots"))
            .subtitle(t("admin.user_bots_hint"))
            .active(on)
            .css_classes(["admin-user-bots"])
            .build();
        group.add(&switch);
        c.add(&group);
        // Set back by an answer: not a choice to send again.
        let quiet = Rc::new(Cell::new(false));
        switch.connect_active_notify(move |row| {
            if quiet.get() {
                return;
            }
            let (admin, wanted, row, quiet) = (s.admin.clone(), row.is_active(), row.clone(), quiet.clone());
            row.set_sensitive(false);
            let host = s.host.clone();
            spawn(&s.host, async move { admin.set_user_bots(wanted).await }, move |result| {
                row.set_sensitive(true);
                let now = match result {
                    Ok(now) => now,
                    Err(error) => {
                        host.toast(error_text(&error));
                        !wanted
                    }
                };
                if now != row.is_active() {
                    quiet.set(true);
                    row.set_active(now);
                    quiet.set(false);
                }
            });
        });
    });
}

/// Reported messages and reported accounts; an item opens its reasons and actions.
fn moderation(screen: &Screen) -> adw::PreferencesPage {
    let page = adw::PreferencesPage::builder().css_classes(["admin-moderation"]).build();
    let messages = adw::PreferencesGroup::builder()
        .title(t("admin.reported_messages"))
        .css_classes(["admin-reported-messages"])
        .build();
    let accounts =
        adw::PreferencesGroup::builder().title(t("admin.reported_users")).css_classes(["admin-reported-users"]).build();
    page.add(&messages);
    page.add(&accounts);
    let lists = (List::new(&messages), List::new(&accounts));
    reload_moderation(screen, &lists);
    page
}

type Lists = (Rc<List>, Rc<List>);

fn reload_moderation(screen: &Screen, lists: &Lists) {
    let (messages, accounts) = lists;
    messages.reset();
    accounts.reset();
    let admin = screen.admin.clone();
    let fetch: Fetch<ReportedMessage> = Rc::new(move |after| {
        let admin = admin.clone();
        Box::pin(async move { admin.reported_messages(after.as_deref()).await })
    });
    let (s, l) = (screen.clone(), lists.clone());
    let render: Render<ReportedMessage> = Rc::new(move |list, item| {
        let row = adw::ActionRow::builder()
            .title(message_title(&item))
            .title_lines(2)
            .subtitle(format!(
                "{} · {} · {}",
                item.author.shown(),
                tf("admin.in_room", &[("room", &item.room.name)]),
                tn("admin.reports_count", count(item.count))
            ))
            .use_markup(false)
            .activatable(true)
            .css_classes(["admin-reported-message"])
            .build();
        row.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
        let (s, l) = (s.clone(), l.clone());
        row.connect_activated(move |_| message_page(&s, &l, item.clone()));
        list.push(&row);
    });
    fill(&screen.host, messages, None, "admin.nothing_reported", fetch, render);

    let admin = screen.admin.clone();
    let fetch: Fetch<ReportedUser> = Rc::new(move |after| {
        let admin = admin.clone();
        Box::pin(async move { admin.reported_users(after.as_deref()).await })
    });
    let (s, l) = (screen.clone(), lists.clone());
    let render: Render<ReportedUser> = Rc::new(move |list, item| {
        let name = if item.user.name.is_empty() { item.user.username.clone() } else { item.user.name.clone() };
        let row = adw::ActionRow::builder()
            .title(&name)
            .subtitle(format!("@{} · {}", item.user.username, tn("admin.reports_count", count(item.count))))
            .use_markup(false)
            .activatable(true)
            .css_classes(["admin-reported-user"])
            .build();
        row.add_prefix(&avatar(&s, &item.user.username, item.user.avatar.as_deref(), TileSize::Message));
        row.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
        let (s, l) = (s.clone(), l.clone());
        row.connect_activated(move |_| reported_user_page(&s, &l, item.clone()));
        list.push(&row);
    });
    fill(&screen.host, accounts, None, "admin.nothing_reported", fetch, render);
}

/// The reasons, read when the item opens; `active` learns whether a
/// reported account is still active when the list did not say.
fn reasons_group(
    screen: &Screen,
    work: impl Future<Output = Result<ReportedUserDetails, AdminError>> + Send + 'static,
    active: impl FnOnce(Option<bool>) + 'static,
) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::builder().title(t("admin.reasons")).css_classes(["admin-reasons"]).build();
    let waiting = adw::ActionRow::builder().title(t("crypto.loading")).build();
    group.add(&waiting);
    let g = group.clone();
    spawn(&screen.host, work, move |result| {
        g.remove(&waiting);
        match result {
            Ok(details) => {
                for report in details.reports {
                    g.add(
                        &adw::ActionRow::builder()
                            .title(&report.reason)
                            .subtitle(format!(
                                "{} · {}",
                                tf("admin.reported_by", &[("name", &report.reporter.shown())]),
                                date(&report.at)
                            ))
                            .use_markup(false)
                            .css_classes(["admin-reason"])
                            .build(),
                    );
                }
                active(details.active);
            }
            Err(error) => g.add(&adw::ActionRow::builder().title(error_text(&error)).build()),
        }
    });
    group
}

/// The subpage an action started from, so that its end pops that page only,
/// and only while it is still on top.
type Shown = Rc<RefCell<Option<glib::WeakRef<adw::NavigationPage>>>>;

fn leave(screen: &Screen, shown: &Shown) {
    if let Some(page) = shown.borrow().as_ref().and_then(|p| p.upgrade()) {
        screen.host.pop_if(&page);
    }
}

type Work = Rc<dyn Fn(bool) -> Pin<Box<dyn Future<Output = Result<(), AdminError>> + Send>>>;

/// Runs `work` without relinquishing; when Rocket.Chat answers that the
/// account owns rooms alone, names them in a second confirmation and runs it
/// again relinquishing them.
fn relinquishing(screen: &Screen, work: Work, done: impl Fn(Result<(), AdminError>) + 'static) {
    let (s, w, done) = (screen.clone(), work.clone(), Rc::new(done));
    spawn(&screen.host, work(false), move |result| match result {
        Err(AdminError { code, last_owner: Some(rooms), .. }) if code == "user-last-owner" => {
            let mut body = Vec::new();
            if !rooms.removed.is_empty() {
                body.push(tf("admin.last_owner_removed", &[("rooms", &rooms.removed.join(", "))]));
            }
            if !rooms.transferred.is_empty() {
                body.push(tf("admin.last_owner_transferred", &[("rooms", &rooms.transferred.join(", "))]));
            }
            let (s2, w2, d2) = (s.clone(), w.clone(), done.clone());
            confirm_class(
                &s.host,
                t("admin.last_owner_title"),
                &body.join("\n\n"),
                t("admin.last_owner_confirm"),
                "admin-last-owner",
                move || {
                    let d = d2.clone();
                    spawn(&s2.host, w2(true), move |result| d(result));
                },
            );
        }
        result => done(result),
    });
}

/// A moderation action: on success a toast, back to the lists, reloaded.
fn moderated(screen: &Screen, lists: &Lists, shown: &Shown) -> impl Fn(Result<(), AdminError>) + Clone + 'static {
    let (s, l, shown) = (screen.clone(), lists.clone(), shown.clone());
    move |result| match result {
        Ok(()) => {
            s.host.toast(t("admin.done"));
            leave(&s, &shown);
            reload_moderation(&s, &l);
        }
        Err(error) => s.host.toast(error_text(&error)),
    }
}

fn moderate(
    screen: &Screen,
    lists: &Lists,
    shown: &Shown,
    work: impl Future<Output = Result<(), AdminError>> + Send + 'static,
) {
    spawn(&screen.host, work, moderated(screen, lists, shown));
}

fn action_row(key: &str, class: &str, destructive: bool) -> adw::ButtonRow {
    let row = adw::ButtonRow::builder().title(t(key)).css_classes(["button", class]).build();
    if destructive {
        row.add_css_class("destructive-action");
    }
    row
}

fn message_title(item: &ReportedMessage) -> String {
    if item.deleted {
        t("admin.message_deleted").to_owned()
    } else if item.encrypted {
        t("admin.encrypted_message").to_owned()
    } else {
        item.text.clone()
    }
}

fn message_page(screen: &Screen, lists: &Lists, item: ReportedMessage) {
    let shown: Shown = Rc::default();
    let page = adw::PreferencesPage::builder().css_classes(["admin-message-page"]).build();
    let message = adw::PreferencesGroup::builder().title(t("admin.message")).build();
    message.add(
        &adw::ActionRow::builder()
            .title(message_title(&item))
            .subtitle(format!(
                "{} · {} · {}",
                item.author.shown(),
                tf("admin.in_room", &[("room", &item.room.name)]),
                date(&item.created_at)
            ))
            .use_markup(false)
            .css_classes(["admin-message-text"])
            .build(),
    );
    page.add(&message);
    let admin = screen.admin.clone();
    let reported = item.clone();
    let work = async move {
        let reports = admin.message_reports(&reported).await?;
        Ok(ReportedUserDetails { reports, active: None })
    };
    page.add(&reasons_group(screen, work, |_| {}));
    let actions = adw::PreferencesGroup::new();
    let dismiss = action_row("admin.dismiss", "admin-dismiss", false);
    let (s, l, i, sh) = (screen.clone(), lists.clone(), item.clone(), shown.clone());
    dismiss.connect_activated(move |_| {
        let (admin, item) = (s.admin.clone(), i.clone());
        moderate(&s, &l, &sh, async move { admin.dismiss_message_reports(&item).await });
    });
    actions.add(&dismiss);
    if !item.deleted {
        let delete = action_row("admin.delete_message", "admin-delete-message", true);
        let (s, l, i, sh) = (screen.clone(), lists.clone(), item.clone(), shown.clone());
        delete.connect_activated(move |_| {
            let (s2, l2, i2, sh2) = (s.clone(), l.clone(), i.clone(), sh.clone());
            confirm(
                &s.host,
                t("admin.delete_message"),
                t("admin.delete_message_body"),
                t("actions.delete"),
                move || {
                    let (admin, item) = (s2.admin.clone(), i2.clone());
                    let (s3, l3, i3, sh3) = (s2.clone(), l2.clone(), i2.clone(), sh2.clone());
                    let done = moderated(&s2, &l2, &sh2);
                    spawn(&s2.host, async move { admin.delete_reported_message(&item).await }, move |result| {
                        match result {
                            // Rocket.Chat cannot reach the room: its moderation deletes the author's
                            // reported messages all together, asked explicitly.
                            Err(AdminError { code, count: Some(n), .. }) if code == "moderation_bulk_only" => {
                                let (s4, l4, i4, sh4) = (s3.clone(), l3.clone(), i3.clone(), sh3.clone());
                                confirm_class(
                                    &s3.host,
                                    t("admin.bulk_delete_title"),
                                    &tf("admin.bulk_delete_body", &[("count", &tn("admin.message_count", count(n)))]),
                                    t("admin.bulk_delete"),
                                    "admin-bulk-delete",
                                    move || {
                                        let (admin, item) = (s4.admin.clone(), i4.clone());
                                        moderate(&s4, &l4, &sh4, async move {
                                            admin.delete_author_reported_messages(&item).await
                                        });
                                    },
                                );
                            }
                            result => done(result),
                        }
                    });
                },
            );
        });
        actions.add(&delete);
    }
    if !item.author.deleted && item.author.id != screen.admin.my_id() {
        let deactivate = action_row("admin.deactivate_author", "admin-deactivate-author", true);
        let (s, l, i, sh) = (screen.clone(), lists.clone(), item.clone(), shown.clone());
        deactivate.connect_activated(move |_| {
            let (s2, l2, i2, sh2) = (s.clone(), l.clone(), i.clone(), sh.clone());
            confirm(
                &s.host,
                t("admin.deactivate_author"),
                t("admin.deactivate_body"),
                t("admin.deactivate"),
                move || {
                    let (admin, item) = (s2.admin.clone(), i2.clone());
                    let work: Work = Rc::new(move |relinquish| {
                        let (admin, item) = (admin.clone(), item.clone());
                        Box::pin(async move { admin.deactivate_author(&item, relinquish).await })
                    });
                    relinquishing(&s2, work, moderated(&s2, &l2, &sh2));
                },
            );
        });
        actions.add(&deactivate);
    }
    page.add(&actions);
    let pushed = screen.host.push(t("admin.reported_messages"), &page);
    shown.replace(Some(pushed.downgrade()));
}

fn reported_user_page(screen: &Screen, lists: &Lists, item: ReportedUser) {
    let shown: Shown = Rc::default();
    let page = adw::PreferencesPage::builder().css_classes(["admin-reported-user-page"]).build();
    page.add(&person_group(screen, &item.user));
    let actions = adw::PreferencesGroup::new();
    let dismiss = action_row("admin.dismiss", "admin-dismiss", false);
    let (s, l, i, sh) = (screen.clone(), lists.clone(), item.clone(), shown.clone());
    dismiss.connect_activated(move |_| {
        let (admin, item) = (s.admin.clone(), i.clone());
        moderate(&s, &l, &sh, async move { admin.dismiss_user_reports(&item).await });
    });
    actions.add(&dismiss);
    let deactivate = action_row("admin.deactivate", "admin-deactivate", true);
    // Rocket.Chat's list does not say whether the account is active: offered
    // until the reasons say it no longer is.
    deactivate.set_visible(item.user.id != screen.admin.my_id() && item.active != Some(false));
    let (s, l, i, sh) = (screen.clone(), lists.clone(), item.clone(), shown.clone());
    deactivate.connect_activated(move |_| {
        let (s2, l2, i2, sh2) = (s.clone(), l.clone(), i.clone(), sh.clone());
        confirm(&s.host, t("admin.deactivate"), t("admin.deactivate_body"), t("admin.deactivate"), move || {
            let (admin, user) = (s2.admin.clone(), i2.user.clone());
            let work: Work = Rc::new(move |relinquish| {
                let (admin, user) = (admin.clone(), user.clone());
                Box::pin(async move { admin.set_active(&user, false, relinquish).await.map(|_| ()) })
            });
            relinquishing(&s2, work, moderated(&s2, &l2, &sh2));
        });
    });
    actions.add(&deactivate);
    let admin = screen.admin.clone();
    let reported = item.clone();
    let row = deactivate.downgrade();
    page.add(&reasons_group(screen, async move { admin.user_reports(&reported).await }, move |active| {
        if active == Some(false)
            && let Some(row) = row.upgrade()
        {
            row.set_visible(false);
        }
    }));
    page.add(&actions);
    let pushed = screen.host.push(t("admin.reported_users"), &page);
    shown.replace(Some(pushed.downgrade()));
}

/// A search entry over a list reloaded as one types.
fn searchable<T: Send + 'static>(
    screen: &Screen,
    page: &adw::PreferencesPage,
    placeholder: &str,
    class: &str,
    query: impl Fn(Admin, Option<String>, String) -> Pin<Box<dyn Future<Output = Result<Page<T>, AdminError>> + Send>>
    + 'static,
    render: Render<T>,
) -> Rc<dyn Fn()> {
    let top = adw::PreferencesGroup::new();
    let entry = gtk::SearchEntry::builder().placeholder_text(placeholder).css_classes([class]).build();
    top.add(&entry);
    page.add(&top);
    let results = adw::PreferencesGroup::new();
    page.add(&results);
    let list = List::new(&results);
    let (admin, query) = (screen.admin.clone(), Rc::new(query));
    let (host, l, e) = (screen.host.clone(), list.clone(), entry.clone());
    let reload: Rc<dyn Fn()> = Rc::new(move || {
        l.reset();
        let (admin, query, text) = (admin.clone(), query.clone(), e.text().to_string());
        let fetch: Fetch<T> = Rc::new(move |after| query(admin.clone(), after, text.clone()));
        fill(&host, &l, None, "admin.empty", fetch, render.clone());
    });
    let again = reload.clone();
    entry.connect_search_changed(move |_| again());
    reload();
    reload
}

fn rooms(screen: &Screen) -> adw::PreferencesPage {
    let page = adw::PreferencesPage::builder().css_classes(["admin-rooms"]).build();
    let render: Render<AdminRoom> = Rc::new(|list, room| {
        let mut details =
            vec![tn("admin.members", count(room.members)), tn("admin.message_count", count(room.messages))];
        if let Some(created) = &room.created_at {
            details.push(tf("admin.created", &[("date", &date(created))]));
        }
        let row = adw::ActionRow::builder()
            .title(&room.name)
            .subtitle(details.join(" · "))
            .use_markup(false)
            .css_classes(["admin-room"])
            .build();
        row.add_prefix(&room_tile(&room));
        if room.read_only {
            row.add_suffix(&widgets::badge(t("admin.badge_read_only"), "read-only"));
        }
        if room.encrypted {
            row.add_suffix(&widgets::badge(t("admin.badge_encrypted"), "encrypted"));
        }
        list.push(&row);
    });
    searchable(
        screen,
        &page,
        t("admin.search_rooms"),
        "admin-room-search",
        |admin, after, text| Box::pin(async move { admin.rooms(after.as_deref(), &text).await }),
        render,
    );
    page
}

/// Reloads the users list, once it exists.
type Reload = Rc<RefCell<Option<Rc<dyn Fn()>>>>;

fn users(screen: &Screen) -> adw::PreferencesPage {
    let page = adw::PreferencesPage::builder().css_classes(["admin-users"]).build();
    let reload: Reload = Rc::default();
    let (s, again) = (screen.clone(), reload.clone());
    let render: Render<AdminUser> = Rc::new(move |list, user| {
        let mut details = vec![format!("@{}", user.username), t(&format!("presence.{}", user.status.key())).to_owned()];
        if let Some(seen) = &user.last_seen_at {
            details.push(tf("admin.last_seen", &[("date", &date(seen))]));
        }
        let row = adw::ActionRow::builder()
            .title(if user.name.is_empty() { &user.username } else { &user.name })
            .subtitle(details.join(" · "))
            .use_markup(false)
            .activatable(true)
            .css_classes(["admin-user"])
            .build();
        let tile = avatar(&s, &user.username, user.avatar.as_deref(), TileSize::Message);
        let overlay = gtk::Overlay::builder().child(&tile).valign(gtk::Align::Center).build();
        let presence = dot(user.status);
        presence.add_css_class("presence-badge");
        presence.set_halign(gtk::Align::End);
        presence.set_valign(gtk::Align::End);
        overlay.add_overlay(&presence);
        row.add_prefix(&overlay);
        for (shown, text, kind) in [
            (user.admin, "admin.badge_admin", "admin"),
            (!user.active, "admin.badge_deactivated", "deactivated"),
            (user.bot, "admin.badge_bot", "bot"),
        ] {
            if shown {
                row.add_suffix(&widgets::badge(t(text), kind));
            }
        }
        row.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
        let (s, again) = (s.clone(), again.clone());
        row.connect_activated(move |_| user_page(&s, &again, user.clone()));
        list.push(&row);
    });
    let refresh = searchable(
        screen,
        &page,
        t("admin.search_users"),
        "admin-user-search",
        |admin, after, text| Box::pin(async move { admin.users(after.as_deref(), &text).await }),
        render,
    );
    reload.replace(Some(refresh));
    page
}

/// Photo, name, @username, presence and dates of an account.
fn person_group(screen: &Screen, user: &AdminUser) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::new();
    let name = if user.name.is_empty() { &user.username } else { &user.name };
    let head = adw::ActionRow::builder()
        .title(name)
        .subtitle(format!("@{}", user.username))
        .use_markup(false)
        .css_classes(["admin-person"])
        .build();
    let tile = avatar(screen, &user.username, user.avatar.as_deref(), TileSize::Room);
    tile.set_margin_top(6);
    tile.set_margin_bottom(6);
    head.add_prefix(&tile);
    group.add(&head);
    let presence = value_row(t("settings.presence"), t(&format!("presence.{}", user.status.key())));
    presence.add_prefix(&dot(user.status));
    group.add(&presence);
    if let Some(created) = &user.created_at {
        group.add(&value_row(t("admin.created_label"), &date(created)));
    }
    if let Some(seen) = &user.last_seen_at {
        group.add(&value_row(t("admin.last_seen_label"), &date(seen)));
    }
    group
}

/// An account's actions: admin right, activation, deletion; none on mine.
fn user_page(screen: &Screen, reload: &Reload, user: AdminUser) {
    let shown: Shown = Rc::default();
    let page = adw::PreferencesPage::builder().css_classes(["admin-user-page"]).build();
    page.add(&person_group(screen, &user));
    let actions = adw::PreferencesGroup::new();
    if user.id == screen.admin.my_id() {
        actions.add(&adw::ActionRow::builder().title(t("admin.yourself")).css_classes(["admin-yourself"]).build());
        page.add(&actions);
        screen.host.push(t("admin.cat.users"), &page);
        return;
    }
    let done = {
        let (s, reload, shown) = (screen.clone(), reload.clone(), shown.clone());
        move |result: Result<(), AdminError>| match result {
            Ok(()) => {
                s.host.toast(t("admin.done"));
                leave(&s, &shown);
                if let Some(reload) = reload.borrow().clone() {
                    reload();
                }
            }
            Err(error) => s.host.toast(error_text(&error)),
        }
    };
    // A bot is never an administrator (the server refuses, `bot_privilege`).
    if !user.bot || user.admin {
        let promote =
            action_row(if user.admin { "admin.remove_admin" } else { "admin.make_admin" }, "admin-set-admin", false);
        let (s, u, d) = (screen.clone(), user.clone(), done.clone());
        promote.connect_activated(move |_| {
            let (admin, user, d) = (s.admin.clone(), u.clone(), d.clone());
            spawn(&s.host, async move { admin.set_admin(&user, !user.admin).await.map(|_| ()) }, d);
        });
        actions.add(&promote);
    }
    let activation =
        action_row(if user.active { "admin.deactivate" } else { "admin.activate" }, "admin-set-active", user.active);
    let (s, u, d) = (screen.clone(), user.clone(), done.clone());
    activation.connect_activated(move |_| {
        let (s2, u2, d2) = (s.clone(), u.clone(), d.clone());
        let run = move || {
            let (admin, user) = (s2.admin.clone(), u2.clone());
            let work: Work = Rc::new(move |relinquish| {
                let (admin, user) = (admin.clone(), user.clone());
                Box::pin(async move { admin.set_active(&user, !user.active, relinquish).await.map(|_| ()) })
            });
            relinquishing(&s2, work, d2.clone());
        };
        if u.active {
            confirm(&s.host, t("admin.deactivate"), t("admin.deactivate_body"), t("admin.deactivate"), run);
        } else {
            run();
        }
    });
    actions.add(&activation);
    let delete = action_row("admin.delete_user", "admin-delete-user", true);
    let (s, u) = (screen.clone(), user.clone());
    delete.connect_activated(move |_| {
        let body = match s.admin.product() {
            Product::RocketChat => "admin.delete_user_body_rc",
            Product::RocketVibe => "admin.delete_user_body_rv",
        };
        let (s2, u2, d2) = (s.clone(), u.clone(), done.clone());
        confirm(&s.host, t("admin.delete_user"), t(body), t("actions.delete"), move || {
            let (admin, user) = (s2.admin.clone(), u2.clone());
            let work: Work = Rc::new(move |relinquish| {
                let (admin, user) = (admin.clone(), user.clone());
                Box::pin(async move { admin.delete_user(&user, relinquish).await })
            });
            relinquishing(&s2, work, d2.clone());
        });
    });
    actions.add(&delete);
    page.add(&actions);
    let pushed = screen.host.push(t("admin.cat.users"), &page);
    shown.replace(Some(pushed.downgrade()));
}

/// What a member reports.
pub enum ReportTarget {
    Message(String),
    User(String),
}

/// Asks the reason (required, at most 1,000 characters), sends the report,
/// and says how it went through `toast`.
pub fn report(
    parent: &impl IsA<gtk::Widget>,
    admin: Admin,
    target: ReportTarget,
    toast: Rc<dyn Fn(String)>,
) -> adw::AlertDialog {
    let (heading, body) = match target {
        ReportTarget::Message(_) => ("report.title_message", "report.body_message"),
        ReportTarget::User(_) => ("report.user", "report.body_user"),
    };
    let entry = gtk::Entry::builder()
        .placeholder_text(t("report.reason"))
        .max_length(rv_core::admin::REASON_MAX as i32)
        .activates_default(true)
        .css_classes(["report-reason"])
        .build();
    let alert = adw::AlertDialog::builder()
        .heading(t(heading))
        .body(t(body))
        .extra_child(&entry)
        .default_response("send")
        .close_response("cancel")
        .prefer_wide_layout(true)
        .css_classes(["alert", "report-dialog"])
        .build();
    alert.add_responses(&[("cancel", t("actions.cancel")), ("send", t("report.send"))]);
    alert.set_response_appearance("send", adw::ResponseAppearance::Suggested);
    alert.set_response_enabled("send", false);
    let a = alert.downgrade();
    entry.connect_changed(move |entry| {
        if let Some(alert) = a.upgrade() {
            alert.set_response_enabled("send", rv_core::admin::valid_reason(&entry.text()).is_some());
        }
    });
    let target = Rc::new(target);
    alert.connect_response(Some("send"), move |_, _| {
        let (admin, reason, target, toast) = (admin.clone(), entry.text().to_string(), target.clone(), toast.clone());
        let work = match &*target {
            ReportTarget::Message(id) => {
                let id = id.clone();
                Box::pin(async move { admin.report_message(&id, &reason).await })
                    as Pin<Box<dyn Future<Output = Result<(), AdminError>> + Send>>
            }
            ReportTarget::User(id) => {
                let id = id.clone();
                Box::pin(async move { admin.report_user(&id, &reason).await })
            }
        };
        glib::spawn_future_local(async move {
            let sent = on_tokio(work).await;
            let key = match sent {
                Ok(()) => "report.sent",
                Err(error) => match rv_core::admin::error_key(&error.code) {
                    "admin.failed" => "report.failed",
                    key => key,
                },
            };
            toast(t(key).to_owned());
        });
    });
    widgets::present(&alert, Some(parent.as_ref()));
    alert
}
