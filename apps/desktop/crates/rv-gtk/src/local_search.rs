//! Search across rooms, on the device: the words of every message the local
//! store holds (`Session::search_local`), newest first, each under its room's
//! name. `chat.search` takes one room at a time, and asking every room would
//! spend the REST rate limit; the desktop store keeps every message it saw.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::markdown;
use rv_core::session::Session;
use rv_core::store::MessageRow;

use crate::i18n::t;
use crate::rows::{label, local};
use crate::{markdown_view, on_tokio};

/// A dialog with an entry and the hits as you type (a pause of 300 ms); a
/// hit picked closes it and goes there: `go(rid, message id, thread root)`.
pub fn open(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<Session>,
    go: impl Fn(String, String, Option<String>) + 'static,
) -> adw::Dialog {
    let entry = gtk::SearchEntry::builder().placeholder_text(t("local_search.placeholder")).build();
    let scope = gtk::Label::builder().label(t("local_search.scope")).css_classes(["details-sub"]).xalign(0.0).build();
    let status = gtk::Label::builder().css_classes(["details-sub"]).visible(false).margin_top(10).build();
    let results = gtk::Box::builder().orientation(gtk::Orientation::Vertical).build();
    let content =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).css_classes(["details"]).build();
    content.append(&entry);
    content.append(&scope);
    content.append(&status);
    content.append(&results);
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
        .title(t("local_search.title"))
        .content_width(460)
        .content_height(600)
        .child(&view)
        .css_classes(["local-search"])
        .build();
    crate::widgets::present(&dialog, Some(parent));
    entry.grab_focus();
    let weak = dialog.downgrade();
    let go: Rc<dyn Fn(String, String, Option<String>)> = Rc::new(move |rid, id, thread| {
        if let Some(dialog) = weak.upgrade() {
            dialog.close();
        }
        go(rid, id, thread);
    });
    // A later query wins: the answer for "a" never replaces the one for "ab".
    let generation = Rc::new(Cell::new(0u64));
    entry.connect_activate(|entry| {
        entry.emit_by_name::<()>("search-changed", &[]);
    });
    entry.connect_search_changed(move |entry| {
        let query = entry.text().trim().to_owned();
        let current = generation.get() + 1;
        generation.set(current);
        let (session, generation, results, status, go) =
            (session.clone(), generation.clone(), results.clone(), status.clone(), go.clone());
        glib::timeout_add_local_once(std::time::Duration::from_millis(300), move || {
            if generation.get() != current {
                return;
            }
            if query.is_empty() {
                clear(&results);
                status.set_visible(false);
                return;
            }
            glib::spawn_future_local(async move {
                let s = session.clone();
                let found = on_tokio(async move { s.search_local(&query) }).await;
                if generation.get() != current {
                    return;
                }
                clear(&results);
                status.set_visible(found.is_empty());
                status.set_label(t("local_search.none"));
                for row in found {
                    results.append(&hit(&session, row, go.clone()));
                }
            });
        });
    });
    dialog
}

fn clear(results: &gtk::Box) {
    while let Some(child) = results.first_child() {
        results.remove(&child);
    }
}

/// One message found: its room's name, author and date, then its words.
fn hit(session: &Arc<Session>, row: MessageRow, go: Rc<dyn Fn(String, String, Option<String>)>) -> gtk::Widget {
    let room = session.store.room_name(&row.rid).map(|(name, _)| name).unwrap_or_else(|| "…".to_owned());
    let author = session.person_label(&row.author_id).or_else(|| row.author.clone()).unwrap_or_default();
    let (rid, id, thread) = (row.rid.clone(), row.id.clone(), row.thread_id.clone());
    message_entry(
        &format!("local-hit-{}", row.id),
        &room,
        &[(&author, "author")],
        &row,
        &session.info.username,
        move || go(rid.clone(), id.clone(), thread.clone()),
    )
    .upcast()
}

/// A clickable entry of a list across rooms (this search, the Activity
/// view): `open` runs on a click.
pub(crate) fn clickable(name: &str, open: impl Fn() + 'static) -> gtk::Box {
    let entry =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).css_classes(["search-hit"]).build();
    entry.set_widget_name(name);
    entry.set_cursor(gtk::gdk::Cursor::from_name("pointer", None).as_ref());
    let click = gtk::GestureClick::new();
    click.connect_released(move |_, _, _, _| open());
    entry.add_controller(click);
    entry
}

/// Where an entry is: a room's name, cut to the width.
pub(crate) fn place(text: &str) -> gtk::Label {
    let place = label(text, &["room-subtitle", "local-hit-room"]);
    place.set_ellipsize(gtk::pango::EllipsizeMode::End);
    place
}

/// A message entry: `place`, a head of `(text, style class)` labels then
/// the message's date, then its words (`me` highlights my mentions).
pub(crate) fn message_entry(
    name: &str,
    place_text: &str,
    head_labels: &[(&str, &str)],
    row: &MessageRow,
    me: &str,
    open: impl Fn() + 'static,
) -> gtk::Box {
    let entry = clickable(name, open);
    entry.append(&place(place_text));
    let head = gtk::Box::builder().spacing(8).build();
    for (text, class) in head_labels {
        head.append(&label(text, &[class]));
    }
    head.append(&label(&local(row.ts).format("%d/%m/%Y %H:%M").to_string(), &["message-time"]));
    entry.append(&head);
    // An encrypted message's words were opened by the session; its stored `md` is the server's.
    let md = row.md.as_deref().filter(|_| row.system_type.is_none());
    let blocks = markdown::render(md, row.text.as_deref(), &markdown::Context { me, names: None });
    entry.append(&markdown_view::view(&blocks, &[]));
    entry
}
