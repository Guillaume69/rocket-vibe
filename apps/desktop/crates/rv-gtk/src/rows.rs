//! One room row, one message row: widgets built from store rows.

use std::sync::Arc;

use adw::prelude::*;
use chrono::{DateTime, Local, TimeZone};
use gtk::{gdk, pango};
use rv_core::media::{AvatarTarget, ImageAttachment, avatar_path, display_size, image_attachments};
use rv_core::session::Session;
use rv_core::store::{MessageRow, RoomRow};
use rv_core::{content, markdown};

use crate::i18n::{self, t, tn};
use crate::widgets::{self, TileSize};
use crate::{cards, markdown_view, media};

const GROUPING_GAP_MS: i64 = 5 * 60 * 1000;

/// What a message row asks of the page showing it.
pub enum RowEvent {
    Retry(String),
    /// The actions menu, at `(x, y)` in `anchor`'s coordinates.
    Menu {
        row: Box<MessageRow>,
        anchor: gtk::Widget,
        x: f64,
        y: f64,
    },
    JoinCall(String),
    /// Someone's profile, by username.
    Profile(String),
    React {
        id: String,
        shortcode: String,
        add: bool,
    },
    OpenThread(String),
}

pub type OnRowEvent = std::rc::Rc<dyn Fn(RowEvent)>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Display {
    pub row: MessageRow,
    pub show_header: bool,
    pub show_day: bool,
    /// A continuation row whose minute differs from the row above: the time
    /// goes in the avatar gutter.
    pub gutter_time: bool,
    /// The first message I have not read: "✦ New messages" above it.
    pub new_marker: bool,
}

pub fn local(ts: i64) -> DateTime<Local> {
    Local.timestamp_millis_opt(ts).single().unwrap_or_default()
}

pub fn short_time(ts: i64) -> String {
    if ts <= 0 {
        return String::new();
    }
    let t = local(ts);
    let today = Local::now().date_naive();
    let days = (today - t.date_naive()).num_days();
    if days == 0 {
        t.format("%H:%M").to_string()
    } else if days < 7 {
        t.format_localized("%a", i18n::locale()).to_string()
    } else {
        t.format("%d/%m/%Y").to_string()
    }
}

/// A system message reads as a sentence after its author's name.
pub fn system_line(row: &MessageRow) -> String {
    let author = row.author.as_deref().unwrap_or_default();
    match row.system_type.as_deref() {
        Some("e2e") => t("message.encrypted").to_owned(),
        Some(kind) => format!("{author} {}", i18n::system_message(kind, row.text.as_deref().unwrap_or_default())),
        None => String::new(),
    }
}

pub fn group(rows: Vec<MessageRow>) -> Vec<Display> {
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
        out.push(Display { gutter_time: gutter_time && !show_header, row, show_header, show_day, new_marker: false });
    }
    out
}

pub fn presence_dot(p: rv_core::live::Presence, classes: &[&str]) -> gtk::Widget {
    let dot = gtk::Box::builder()
        .css_classes(["presence", p.as_str()])
        .halign(gtk::Align::End)
        .valign(gtk::Align::End)
        .tooltip_text(t(&format!("presence.{}", p.as_str())))
        .build();
    for class in classes {
        dot.add_css_class(class);
    }
    dot.upcast()
}

pub fn label(text: &str, classes: &[&str]) -> gtk::Label {
    gtk::Label::builder().label(text).xalign(0.0).css_classes(classes.to_vec()).build()
}

/// A gradient tile that receives the real photo once (and if) it loads.
pub fn with_photo(tile: gtk::Widget, session: Option<&Arc<Session>>, path: Option<String>) -> gtk::Widget {
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
pub fn room_avatar_path(r: &RoomRow) -> Option<String> {
    if r.encrypted {
        return None;
    }
    match (r.kind.as_str(), &r.dm_other_uid) {
        ("d", Some(uid)) => Some(avatar_path(AvatarTarget::Uid(uid), None)),
        ("d", None) => None,
        _ => Some(avatar_path(AvatarTarget::Room(&r.rid), r.avatar_etag.as_deref())),
    }
}

/// A click on an author's photo or name opens their profile.
fn opens_profile(widget: &impl IsA<gtk::Widget>, on_event: OnRowEvent, username: &str) {
    let click = gtk::GestureClick::new();
    let username = username.to_owned();
    click.connect_released(move |_, _, _, _| on_event(RowEvent::Profile(username.clone())));
    widget.as_ref().set_cursor(gdk::Cursor::from_name("pointer", None).as_ref());
    widget.as_ref().add_controller(click);
}

pub fn room_tile(name: &str, kind: &str, encrypted: bool, size: TileSize) -> gtk::Widget {
    if encrypted {
        return widgets::tile(name, "🔒", size, true);
    }
    let glyph = if kind == "d" { widgets::initial(name) } else { "#".to_owned() };
    widgets::tile(name, &glyph, size, false)
}

pub fn open_viewer(parent: &gtk::Widget, texture: &gdk::Texture, title: &str) {
    let picture = gtk::Picture::builder().paintable(texture).content_fit(gtk::ContentFit::Contain).build();
    let page = adw::ToolbarView::new();
    page.add_top_bar(&adw::HeaderBar::new());
    page.set_content(Some(&picture));
    let (w, h) = (texture.width().clamp(320, 1100), texture.height().clamp(240, 800) + 48);
    let dialog = adw::Dialog::builder().title(title).content_width(w).content_height(h).child(&page).build();
    dialog.present(Some(parent));
}

pub fn image_widget(session: &Arc<Session>, image: &ImageAttachment) -> gtk::Widget {
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
    let title = image.alt.clone().or_else(|| image.title.clone()).unwrap_or_else(|| t("message.image").to_owned());
    click.connect_released(move |gesture, _, _, _| {
        let Some(widget) = gesture.widget() else { return };
        let title = title.clone();
        media::load(&session, &source, move |texture| open_viewer(&widget, texture, &title));
    });
    frame.add_controller(click);
    frame.upcast()
}

pub fn room_widget(r: &RoomRow, session: Option<&Arc<Session>>) -> gtk::Widget {
    let unread = r.unread > 0 || r.alert;
    let name = label(&r.name, &["room-name"]);
    name.set_hexpand(true);
    name.set_ellipsize(pango::EllipsizeMode::End);
    let time = label(&short_time(r.last_ts), &["room-time"]);
    let system = r.last_type.as_deref().filter(|kind| *kind != "e2e");
    let preview = match (&r.last_message, r.encrypted) {
        _ if let Some(kind) = system => {
            let param = r.last_message.as_deref().unwrap_or_default();
            let author = r.last_author.as_deref().unwrap_or_default();
            label(format!("{author} {}", i18n::system_message(kind, param)).trim(), &["room-preview"])
        }
        (Some(m), _) => {
            label(&rv_core::emoji::replace_shortcodes(rv_core::actions::strip_quote_prefix(m)), &["room-preview"])
        }
        (None, true) => label(t("rooms.encrypted"), &["room-preview", "encrypted"]),
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
    let presence = r.dm_other_uid.as_deref().zip(session).and_then(|(uid, s)| s.presence(uid));
    let tile = match presence {
        Some(p) => {
            let holder = gtk::Overlay::builder().child(&tile).build();
            holder.add_overlay(&presence_dot(p, &["presence-badge"]));
            holder.upcast()
        }
        None => tile,
    };
    tile.set_valign(gtk::Align::Center);
    row.append(&tile);
    row.append(&column);
    row.upcast()
}

pub fn day_label(ts: i64) -> String {
    let day = local(ts).date_naive();
    let today = Local::now().date_naive();
    match (today - day).num_days() {
        0 => t("day.today").to_owned(),
        1 => t("day.yesterday").to_owned(),
        _ => local(ts).format_localized("%A %-d %B %Y", i18n::locale()).to_string(),
    }
}

pub fn message_widget(d: &Display, my_id: &str, session: Option<&Arc<Session>>, on_event: OnRowEvent) -> gtk::Widget {
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

    let is_call = row.system_type.as_deref() == Some("videoconf");
    if d.new_marker {
        let marker = gtk::Box::builder().spacing(6).margin_top(8).margin_bottom(4).build();
        marker.append(&widgets::sparkle());
        marker.append(&label(t("room.new_messages"), &["new-marker"]));
        marker.append(&gtk::Box::builder().css_classes(["new-line"]).hexpand(true).valign(gtk::Align::Center).build());
        outer.append(&marker);
    }

    if row.system_type.is_some() && !is_call {
        let system = label(&system_line(row), &["system-message"]);
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
        let tile = with_photo(tile, session, session.filter(|_| !author.is_empty()).map(|s| s.user_avatar(&author)));
        opens_profile(&tile, on_event.clone(), &author);
        line.append(&tile);
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
        opens_profile(&name, on_event.clone(), &author);
        header.append(&name);
        let time = label(&local(row.ts).format("%H:%M").to_string(), &["message-time"]);
        time.set_valign(gtk::Align::Baseline);
        header.append(&time);
        column.append(&header);
    }

    let pending = row.outbox_status.as_deref() == Some("pending");
    let failed = row.outbox_status.as_deref() == Some("failed");
    let me = session.map(|s| s.info.username.clone()).unwrap_or_default();
    let blocks = if is_call {
        Vec::new()
    } else {
        markdown::render(row.md.as_deref(), row.text.as_deref(), &markdown::Context { me: &me })
    };
    if let Some(session) = session {
        for q in content::quotes(row.attachments.as_deref()) {
            column.append(&cards::quote(session, &q, &me));
        }
    }
    let state: &[&str] = match (pending, failed) {
        (true, _) => &["pending"],
        (_, true) => &["failed"],
        _ => &[],
    };
    if !blocks.is_empty() {
        column.append(&markdown_view::view(&blocks, state));
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
        for f in content::files(row.attachments.as_deref()) {
            column.append(&cards::file(session, &f));
        }
        for video in content::video_links(row.text.as_deref().unwrap_or_default(), row.urls.as_deref(), 3) {
            column.append(&cards::video_link(session, &video));
        }
        for preview in content::link_previews(row.urls.as_deref(), 3) {
            column.append(&cards::link_preview(session, &preview));
        }
    }
    if is_call {
        column.append(&cards::call(row.call_id.as_deref(), on_event.clone()));
    }

    let me = session.map(|s| s.info.username.as_str()).unwrap_or_default();
    let reactions = rv_core::actions::reactions(row.reactions.as_deref(), me);
    if !reactions.is_empty() {
        let chips = gtk::FlowBox::builder()
            .selection_mode(gtk::SelectionMode::None)
            .column_spacing(6)
            .row_spacing(6)
            .max_children_per_line(24)
            .halign(gtk::Align::Start)
            .margin_top(4)
            .build();
        for reaction in reactions {
            let glyph =
                rv_core::emoji::unicode(&reaction.shortcode).map_or_else(|| reaction.shortcode.clone(), str::to_owned);
            let chip = gtk::Button::builder()
                .label(format!("{glyph} {}", reaction.count))
                .css_classes(if reaction.mine { vec!["reaction", "mine"] } else { vec!["reaction"] })
                .build();
            let (on_event, id) = (on_event.clone(), row.id.clone());
            chip.connect_clicked(move |_| {
                on_event(RowEvent::React { id: id.clone(), shortcode: reaction.shortcode.clone(), add: !reaction.mine })
            });
            chips.insert(&chip, -1);
        }
        column.append(&chips);
    }

    if row.edited || pending || failed || row.thread_count > 0 {
        let footer = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        if row.thread_count > 0 {
            let n = row.thread_count;
            let chip = gtk::Button::builder()
                .label(format!("💬 {}", tn("message.replies", n)))
                .css_classes(["thread-chip"])
                .margin_top(3)
                .build();
            let (on_event, id) = (on_event.clone(), row.id.clone());
            chip.connect_clicked(move |_| on_event(RowEvent::OpenThread(id.clone())));
            footer.append(&chip);
        }
        if row.edited {
            footer.append(&label(t("message.edited"), &["message-note"]));
        }
        if pending {
            footer.append(&label(t("message.sending"), &["message-note"]));
        }
        if failed {
            let retry = gtk::Button::builder().label(t("message.failed")).css_classes(["flat", "retry"]).build();
            let (on_event, id) = (on_event.clone(), row.id.clone());
            retry.connect_clicked(move |_| on_event(RowEvent::Retry(id.clone())));
            footer.append(&retry);
        }
        column.append(&footer);
    }

    let more = gtk::Button::builder()
        .label("⋯")
        .css_classes(["flat", "row-more"])
        .valign(gtk::Align::Start)
        .tooltip_text(t("actions.more"))
        .build();
    let (on_menu, menu_row) = (on_event.clone(), row.clone());
    more.connect_clicked(move |button| {
        let (w, h) = (button.width() as f64, button.height() as f64);
        on_menu(RowEvent::Menu { row: Box::new(menu_row.clone()), anchor: button.clone().upcast(), x: w / 2.0, y: h });
    });
    let right_click = gtk::GestureClick::builder().button(gdk::BUTTON_SECONDARY).build();
    let (on_menu, menu_row, target) = (on_event, row.clone(), outer.clone());
    right_click.connect_pressed(move |gesture, _, x, y| {
        gesture.set_state(gtk::EventSequenceState::Claimed);
        on_menu(RowEvent::Menu { row: Box::new(menu_row.clone()), anchor: target.clone().upcast(), x, y });
    });
    outer.add_controller(right_click);
    line.append(&column);
    line.append(&more);
    outer.add_css_class("message");
    outer.append(&line);
    outer.upcast()
}
