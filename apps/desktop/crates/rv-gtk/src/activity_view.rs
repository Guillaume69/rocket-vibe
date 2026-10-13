//! The Activity view (`rv_core::activity`): every signed-in account's
//! mentions of me, replies in my threads and reactions to my messages, read
//! from the stored messages, then the rooms whose unread mentions no stored
//! message shows. Built by the window, which holds every account
//! (`Supervisor::activity`) and opens the one an entry belongs to.

use std::rc::Rc;

use adw::prelude::*;
use rv_core::activity::{Item, Kind, Merged, RoomMentions};
use rv_core::markdown;
use rv_core::session::SessionInfo;

use crate::i18n::{t, tf, tn};
use crate::markdown_view;
use crate::rows::{label, local};

/// Where an entry leads: the account, the room, the message (None: the
/// room itself) and the thread it replies in.
pub struct Target {
    pub account: SessionInfo,
    pub rid: String,
    pub message: Option<String>,
    pub thread: Option<String>,
}

/// The dialog. An entry picked closes it and goes there (`go`); with
/// several accounts each entry names its server. Closes on its backdrop.
pub fn open(
    parent: &impl IsA<gtk::Widget>,
    activity: Merged<SessionInfo>,
    go: impl Fn(Target) + 'static,
) -> adw::Dialog {
    let Merged { rooms, items, several } = activity;
    let content =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).css_classes(["details"]).build();
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(
        &gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_height(true)
            .child(&content)
            .build(),
    ));
    let dialog = adw::Dialog::builder()
        .title(t("activity.title"))
        .content_width(480)
        .content_height(620)
        .child(&view)
        .css_classes(["local-search", "activity-view"])
        .build();
    let weak = dialog.downgrade();
    let go: Rc<dyn Fn(Target)> = Rc::new(move |target| {
        if let Some(dialog) = weak.upgrade() {
            dialog.close();
        }
        go(target);
    });
    if rooms.is_empty() && items.is_empty() {
        let empty = label(t("activity.empty"), &["details-sub"]);
        empty.set_wrap(true);
        content.append(&empty);
    }
    if !rooms.is_empty() {
        content.append(&label(t("activity.rooms"), &["heading"]));
        for (info, room) in rooms {
            content.append(&room_entry(info, room, several, go.clone()));
        }
    }
    if !items.is_empty() {
        content.append(&label(t("activity.recent"), &["heading"]));
        for (info, item) in items {
            content.append(&item_entry(info, item, several, go.clone()));
        }
    }
    crate::widgets::present(&dialog, Some(parent));
    dialog
}

/// An entry's frame: clickable, leading to `target`.
fn entry(name: String, target: Target, go: Rc<dyn Fn(Target)>) -> gtk::Box {
    let entry =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).css_classes(["search-hit"]).build();
    entry.set_widget_name(&name);
    entry.set_cursor(gtk::gdk::Cursor::from_name("pointer", None).as_ref());
    let click = gtk::GestureClick::new();
    let target = std::cell::RefCell::new(Some(target));
    click.connect_released(move |_, _, _, _| {
        if let Some(target) = target.borrow_mut().take() {
            go(target);
        }
    });
    entry.add_controller(click);
    entry
}

/// The room's name, after its server when several accounts are shown.
fn where_label(info: &SessionInfo, room: &str, several: bool) -> gtk::Label {
    let text = if several { format!("{} · {room}", rv_core::supervisor::server_label(info)) } else { room.to_owned() };
    let label = label(&text, &["room-subtitle", "local-hit-room"]);
    label.set_ellipsize(gtk::pango::EllipsizeMode::End);
    label
}

fn room_entry(info: SessionInfo, room: RoomMentions, several: bool, go: Rc<dyn Fn(Target)>) -> gtk::Widget {
    let name = format!("activity-room-{}", room.rid);
    let place = where_label(&info, &room.room, several);
    let target = Target { account: info, rid: room.rid, message: None, thread: None };
    let entry = entry(name, target, go);
    entry.append(&place);
    entry.append(&label(&tn("activity.room_mentions", room.count), &["author"]));
    entry.upcast()
}

fn item_entry(info: SessionInfo, item: Item, several: bool, go: Rc<dyn Fn(Target)>) -> gtk::Widget {
    let row = item.message;
    let what = match item.kind {
        Kind::Mention => t("activity.mention").to_owned(),
        Kind::Reply => t("activity.reply").to_owned(),
        Kind::Reaction => {
            let emojis: Vec<&str> =
                item.emojis.iter().map(|code| rv_core::emoji::unicode(code).unwrap_or(code.as_str())).collect();
            tf("activity.reaction", &[("names", &item.reactors.join(", ")), ("emojis", &emojis.join(" "))])
        }
    };
    let place = where_label(&info, &item.room, several);
    let me = info.username.clone();
    let target =
        Target { account: info, rid: row.rid.clone(), message: Some(row.id.clone()), thread: row.thread_id.clone() };
    let entry = entry(format!("activity-item-{}", row.id), target, go);
    entry.append(&place);
    let head = gtk::Box::builder().spacing(8).build();
    head.append(&label(&what, &["author"]));
    if item.kind != Kind::Reaction {
        head.append(&label(row.author.as_deref().unwrap_or_default(), &["message-time"]));
    }
    head.append(&label(&local(row.ts).format("%d/%m/%Y %H:%M").to_string(), &["message-time"]));
    entry.append(&head);
    let md = row.md.as_deref().filter(|_| row.system_type.is_none());
    let blocks = markdown::render(md, row.text.as_deref(), &markdown::Context { me: &me });
    entry.append(&markdown_view::view(&blocks, &[]));
    entry.upcast()
}
