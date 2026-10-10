//! Forwarding a message (Rocket.Chat): a dialog lists the rooms it can go to,
//! searched by name, and the one clicked receives it as a quote.

use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use rv_core::session::Session;
use rv_core::store::RoomRow;

use crate::i18n::t;
use crate::rows::{label, room_avatar_path, room_tile, with_photo};
use crate::widgets::TileSize;

fn row(session: &Arc<Session>, room: &RoomRow) -> gtk::ListBoxRow {
    let tile =
        with_photo(room_tile(&room.name, &room.kind, false, TileSize::Message), Some(session), room_avatar_path(room));
    tile.set_valign(gtk::Align::Center);
    let name = label(&format!("{}{}", if room.kind == "c" { "#" } else { "" }, room.name), &[]);
    name.set_ellipsize(gtk::pango::EllipsizeMode::End);
    name.set_hexpand(true);
    let line = gtk::Box::builder().spacing(10).margin_top(6).margin_bottom(6).margin_start(8).margin_end(8).build();
    line.append(&tile);
    line.append(&name);
    let row = gtk::ListBoxRow::builder().child(&line).activatable(true).build();
    row.set_widget_name(&format!("forward-{}", room.rid));
    row
}

/// The rooms `rooms` (the list as shown) a message can be forwarded to; `chosen`
/// gets the one clicked, once the dialog closed.
pub fn open(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<Session>,
    rooms: Vec<RoomRow>,
    chosen: impl Fn(String) + 'static,
) -> adw::Dialog {
    let dialog = adw::Dialog::builder().title(t("forward.title")).content_width(420).content_height(560).build();
    dialog.add_css_class("forward-dialog");
    let search = gtk::SearchEntry::builder().placeholder_text(t("forward.placeholder")).hexpand(true).build();
    let list = gtk::ListBox::builder()
        .selection_mode(gtk::SelectionMode::None)
        .css_classes(["boxed-list"])
        .valign(gtk::Align::Start)
        .build();
    let empty = label(t("forward.none"), &["details-sub"]);
    empty.set_xalign(0.5);
    empty.set_margin_top(24);
    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(12)
        .margin_top(12)
        .margin_bottom(12)
        .margin_start(12)
        .margin_end(12)
        .build();
    column.append(&search);
    column.append(&list);
    column.append(&empty);
    let scroll =
        gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&column).build();
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(&scroll));
    dialog.set_child(Some(&view));

    let shown: Rc<std::cell::RefCell<Vec<String>>> = Rc::default();
    let fill = {
        let (list, empty, shown, session) = (list.clone(), empty.clone(), shown.clone(), session.clone());
        move |query: &str| {
            list.remove_all();
            let targets = rv_core::rooms::forward_targets(&rooms, query);
            for room in &targets {
                list.append(&row(&session, room));
            }
            empty.set_visible(targets.is_empty());
            list.set_visible(!targets.is_empty());
            shown.replace(targets.into_iter().map(|r| r.rid).collect());
        }
    };
    fill("");
    search.connect_search_changed(move |entry| fill(&entry.text()));
    let weak = dialog.downgrade();
    list.connect_row_activated(move |_, row| {
        let Some(rid) = shown.borrow().get(row.index() as usize).cloned() else { return };
        if let Some(dialog) = weak.upgrade() {
            dialog.close();
        }
        chosen(rid);
    });
    let first = list.clone();
    search.connect_activate(move |_| {
        if let Some(row) = first.row_at_index(0) {
            row.activate();
        }
    });
    crate::widgets::present(&dialog, Some(parent));
    search.grab_focus();
    dialog
}
