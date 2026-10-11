//! A Rocket.Chat room's topic, description, announcement and read-only
//! flag, edited from its information dialog by those my roles grant
//! `edit-room`. Save sends only what changed (`rv_core::members::
//! settings_changes`); the information dialog then reads the room again.
//! Renaming is left out on purpose: it moves the room's address.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::members::RoomSettings;
use rv_core::session::Session;

use super::{centered, column, dialog, label, t};
use crate::on_tokio;

fn text_field(parent: &gtk::Box, key: &str, class: &str, value: &str) -> gtk::TextBuffer {
    parent.append(&label(t(key), &["details-section"]));
    let view = gtk::TextView::builder()
        .wrap_mode(gtk::WrapMode::WordChar)
        .top_margin(8)
        .bottom_margin(8)
        .left_margin(8)
        .right_margin(8)
        .css_classes([class])
        .build();
    view.buffer().set_text(value);
    parent.append(
        &gtk::ScrolledWindow::builder()
            .min_content_height(72)
            .hscrollbar_policy(gtk::PolicyType::Never)
            .child(&view)
            .build(),
    );
    view.buffer()
}

fn read(buffer: &gtk::TextBuffer) -> String {
    buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string()
}

/// Opens the editor over `parent`, starting from `before`; `saved` runs once
/// the server took the change.
pub(super) fn edit(
    parent: &adw::Dialog,
    session: Arc<Session>,
    rid: String,
    before: RoomSettings,
    saved: Rc<dyn Fn()>,
) -> adw::Dialog {
    let content = column();
    let topic = text_field(&content, "info.topic", "room-topic", &before.topic);
    let description = text_field(&content, "info.description", "room-description", &before.description);
    let announcement = text_field(&content, "info.announcement", "room-announcement", &before.announcement);
    let read_only = adw::SwitchRow::builder()
        .title(t("room_settings.read_only"))
        .subtitle(t("room_settings.read_only_hint"))
        .active(before.read_only)
        .css_classes(["room-read-only"])
        .build();
    let flags = gtk::ListBox::builder()
        .selection_mode(gtk::SelectionMode::None)
        .css_classes(["boxed-list"])
        .margin_top(8)
        .build();
    flags.append(&read_only);
    content.append(&flags);
    let status = centered("", &["details-sub"]);
    content.append(&status);
    let save = gtk::Button::builder()
        .label(t("settings.save"))
        .halign(gtk::Align::Center)
        .sensitive(false)
        .css_classes(["suggested-action", "pill", "room-settings-save"])
        .build();
    content.append(&save);
    let window = dialog(t("room_settings.edit"), content.upcast_ref(), 560);
    window.add_css_class("room-settings-dialog");

    let current = {
        let (topic, description, announcement, read_only) =
            (topic.clone(), description.clone(), announcement.clone(), read_only.clone());
        Rc::new(move || RoomSettings {
            topic: read(&topic),
            description: read(&description),
            announcement: read(&announcement),
            read_only: read_only.is_active(),
        })
    };
    let busy = Rc::new(Cell::new(false));
    // Save only means something once a field moved.
    let refresh = {
        let (save, current, before, busy) = (save.clone(), current.clone(), before.clone(), busy.clone());
        Rc::new(move || save.set_sensitive(!busy.get() && current() != before))
    };
    for buffer in [&topic, &description, &announcement] {
        let r = refresh.clone();
        buffer.connect_changed(move |_| r());
    }
    let r = refresh.clone();
    read_only.connect_active_notify(move |_| r());

    let active = Rc::new(Cell::new(true));
    let live = active.clone();
    window.connect_closed(move |_| live.set(false));
    let weak = window.downgrade();
    parent.connect_closed(move |_| {
        if let Some(window) = weak.upgrade() {
            window.close();
        }
    });
    let weak = window.downgrade();
    save.connect_clicked(move |button| {
        let after = current();
        if busy.get() || after == before {
            return;
        }
        busy.set(true);
        button.set_sensitive(false);
        status.set_text("");
        let (s, r, before, status, busy, refresh, saved, weak, active) = (
            session.clone(),
            rid.clone(),
            before.clone(),
            status.clone(),
            busy.clone(),
            refresh.clone(),
            saved.clone(),
            weak.clone(),
            active.clone(),
        );
        glib::spawn_future_local(async move {
            let done = on_tokio(async move { s.save_room_settings(&r, &before, &after).await }).await;
            if !active.get() {
                return;
            }
            busy.set(false);
            match done {
                Ok(_) => {
                    if let Some(window) = weak.upgrade() {
                        window.close();
                    }
                    saved();
                }
                Err(e) => {
                    eprintln!("Room settings refused: {e}");
                    status.set_text(t(if e.status == 0 { "members.offline" } else { "room_settings.failed" }));
                    refresh();
                }
            }
        });
    });
    crate::widgets::present(&window, Some(parent));
    window
}
