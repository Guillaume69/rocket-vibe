//! A room's own notifications (Rocket.Chat): Default, All messages, Mentions
//! or Nothing, desktop and push together. Shown from the stored
//! subscription, which the server's broadcasts keep current while it is open.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::actions::ROOM_NOTIFICATION_LEVELS;
use rv_core::session::Session;
use tokio::sync::broadcast::error::RecvError;

use crate::i18n::t;
use crate::on_tokio;

/// Where the stored choice sits among the levels: a room another client
/// silenced shows Nothing, which is what it does.
fn selected(session: &Session, rid: &str) -> u32 {
    let (own, silenced) = session.store.room_notifications(rid);
    let level = if silenced { "nothing" } else { own.as_deref().unwrap_or("default") };
    ROOM_NOTIFICATION_LEVELS.iter().position(|l| *l == level).unwrap_or(0) as u32
}

/// The choice for the room `rid`, or nothing where the server has none.
pub fn group(session: &Arc<Session>, rid: &str) -> Option<gtk::Widget> {
    if !session.room_notifications_available() {
        return None;
    }
    let labels: Vec<&str> = ROOM_NOTIFICATION_LEVELS.iter().map(|l| t(&format!("room_notifications.{l}"))).collect();
    let combo = adw::ComboRow::builder()
        .title(t("room_notifications.title"))
        .model(&gtk::StringList::new(&labels))
        .selected(selected(session, rid))
        .build();
    combo.add_css_class("room-notifications");
    let list = gtk::ListBox::builder()
        .selection_mode(gtk::SelectionMode::None)
        .css_classes(["boxed-list"])
        .margin_top(12)
        .build();
    list.append(&combo);
    let failed = gtk::Label::builder()
        .label(t("room_notifications.failed"))
        .css_classes(["details-sub", "error"])
        .wrap(true)
        .visible(false)
        .build();
    let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).build();
    column.append(&list);
    column.append(&failed);

    // The store's changes (the server's subscription, or a save) move the
    // choice; `quiet` keeps such a move from saving it back.
    let quiet = Rc::new(Cell::new(false));
    let (tx, rx) = async_channel::bounded::<()>(1);
    let (mut changes, watched) = (session.store.changes(), rid.to_owned());
    let forward = crate::runtime().spawn(async move {
        loop {
            match changes.recv().await {
                Ok(change) if !change.rooms && !change.rids.contains(&watched) => continue,
                Err(RecvError::Closed) => return,
                _ => {}
            }
            if let Err(async_channel::TrySendError::Closed(_)) = tx.try_send(()) {
                return;
            }
        }
    });
    let abort = forward.abort_handle();
    column.connect_destroy(move |_| abort.abort());
    let (weak, s, r, q) = (combo.downgrade(), session.clone(), rid.to_owned(), quiet.clone());
    glib::spawn_future_local(async move {
        while rx.recv().await.is_ok() {
            let Some(combo) = weak.upgrade() else { return };
            if combo.is_sensitive() {
                q.set(true);
                combo.set_selected(selected(&s, &r));
                q.set(false);
            }
        }
    });

    let (s, r) = (session.clone(), rid.to_owned());
    combo.connect_selected_notify(move |combo| {
        if quiet.get() {
            return;
        }
        let Some(level) = ROOM_NOTIFICATION_LEVELS.get(combo.selected() as usize) else { return };
        let (session, rid, level) = (s.clone(), r.clone(), (*level).to_owned());
        let (combo, failed, quiet) = (combo.clone(), failed.clone(), quiet.clone());
        combo.set_sensitive(false);
        failed.set_visible(false);
        glib::spawn_future_local(async move {
            let (s, r) = (session.clone(), rid.clone());
            let saved = on_tokio(async move { s.room_notifications(&r, &level).await }).await;
            combo.set_sensitive(true);
            if let Err(e) = saved {
                eprintln!("Room notifications not saved: {e}");
                failed.set_visible(true);
                quiet.set(true);
                combo.set_selected(selected(&session, &rid));
                quiet.set(false);
            }
        });
    });
    Some(column.upcast())
}
