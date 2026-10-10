//! The quick room switcher (Ctrl+K): a dialog lists the account's rooms,
//! searched by name (`rv_core::rooms::switcher_matches`), and the one picked
//! opens. Enter opens the first, the arrows move through the list.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::{gdk, glib};
use rv_core::session::Session;
use rv_core::store::RoomRow;

use crate::i18n::t;
use crate::rows::{label, room_avatar_path, room_tile, with_photo};
use crate::widgets::{self, TileSize};

fn row(session: Option<&Arc<Session>>, room: &RoomRow) -> gtk::ListBoxRow {
    let tile = with_photo(
        room_tile(&room.name, &room.kind, room.encrypted, TileSize::Message),
        session,
        session.and_then(|_| room_avatar_path(room)),
    );
    tile.set_valign(gtk::Align::Center);
    let unread = room.unread > 0 || room.alert;
    let name = label(
        &format!("{}{}", if room.kind == "c" { "#" } else { "" }, room.name),
        if unread { &["unread"] } else { &[] },
    );
    name.set_ellipsize(gtk::pango::EllipsizeMode::End);
    name.set_hexpand(true);
    let line = gtk::Box::builder().spacing(10).margin_top(6).margin_bottom(6).margin_start(8).margin_end(8).build();
    line.append(&tile);
    line.append(&name);
    if room.unread > 0 {
        let badge = widgets::unread_badge(room.unread, room.mentions);
        badge.set_valign(gtk::Align::Center);
        line.append(&badge);
    }
    let row = gtk::ListBoxRow::builder().child(&line).activatable(true).build();
    row.set_widget_name(&format!("switcher-{}", room.rid));
    row
}

/// Scrolls `scroll` just enough for `row` to show whole.
fn reveal(scroll: &gtk::ScrolledWindow, row: &gtk::ListBoxRow) {
    let Some(child) = scroll.child() else { return };
    let Some(bounds) = row.compute_bounds(&child) else { return };
    let adjustment = scroll.vadjustment();
    let (top, bottom) = (f64::from(bounds.y()), f64::from(bounds.y() + bounds.height()));
    if top < adjustment.value() {
        adjustment.set_value(top);
    } else if bottom > adjustment.value() + adjustment.page_size() {
        adjustment.set_value(bottom - adjustment.page_size());
    }
}

/// The account's rooms (`rooms`, the list as shown); `chosen` gets the one
/// picked, once the dialog closed. `session` loads the photos of a
/// Rocket.Chat or Mattermost account; without it the tiles stay drawn.
pub fn open(
    parent: &impl IsA<gtk::Widget>,
    session: Option<Arc<Session>>,
    rooms: Vec<RoomRow>,
    chosen: impl Fn(String) + 'static,
) -> adw::Dialog {
    let dialog = adw::Dialog::builder().title(t("switcher.title")).content_width(420).content_height(560).build();
    dialog.add_css_class("switcher-dialog");
    let search = gtk::SearchEntry::builder().placeholder_text(t("switcher.placeholder")).hexpand(true).build();
    search.set_widget_name("switcher-search");
    let list = gtk::ListBox::builder()
        .selection_mode(gtk::SelectionMode::Browse)
        .css_classes(["boxed-list"])
        .valign(gtk::Align::Start)
        .build();
    let empty = label(t("switcher.none"), &["details-sub"]);
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

    let shown: Rc<RefCell<Vec<String>>> = Rc::default();
    let fill = {
        let (list, empty, shown) = (list.clone(), empty.clone(), shown.clone());
        move |query: &str| {
            list.remove_all();
            let found = rv_core::rooms::switcher_matches(&rooms, query);
            for room in &found {
                list.append(&row(session.as_ref(), room));
            }
            empty.set_visible(found.is_empty());
            list.set_visible(!found.is_empty());
            list.select_row(list.row_at_index(0).as_ref());
            shown.replace(found.into_iter().map(|r| r.rid).collect());
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
    // The focus stays in the search field: Enter opens the selected row, the
    // arrows move the selection.
    let picked = list.clone();
    search.connect_activate(move |_| {
        if let Some(row) = picked.selected_row().or_else(|| picked.row_at_index(0)) {
            row.activate();
        }
    });
    let keys = gtk::EventControllerKey::builder().propagation_phase(gtk::PropagationPhase::Capture).build();
    let (moved, scrolled) = (list.clone(), scroll.clone());
    keys.connect_key_pressed(move |_, key, _, _| {
        let step = match key {
            gdk::Key::Down | gdk::Key::KP_Down => 1,
            gdk::Key::Up | gdk::Key::KP_Up => -1,
            _ => return glib::Propagation::Proceed,
        };
        let at = moved.selected_row().map_or(-1, |r| r.index());
        if let Some(row) = moved.row_at_index((at + step).max(0)) {
            moved.select_row(Some(&row));
            reveal(&scrolled, &row);
        }
        glib::Propagation::Stop
    });
    search.add_controller(keys);
    widgets::present(&dialog, Some(parent));
    search.grab_focus();
    dialog
}
