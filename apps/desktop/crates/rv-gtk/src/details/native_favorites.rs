//! The existing room menu and information panel use one confirmed preference.
use super::t;
use adw::prelude::*;
use gtk::gdk;
use rv_core::native::NativeSession;
use std::{cell::Cell, rc::Rc, sync::Arc};

pub(crate) fn controls(content: &gtk::Box, session: Arc<NativeSession>, rid: &str, active: Rc<Cell<bool>>) {
    if !session.supported_features().iter().any(|f| f == "favorites") {
        return;
    }
    let Some(state) = session.store.read_state(rid).ok().flatten() else { return };
    let (Some(membership), Some(revision)) = (state.membership_version, state.favorite_revision) else { return };
    let saved = session.store.favorite_intent(rid).ok().flatten();
    let status = gtk::Label::new(None);
    status.set_wrap(true);
    status.add_css_class("details-sub");
    let button = gtk::Button::builder()
        .label(t(if state.favorite { "rooms.favorite_remove" } else { "rooms.favorite_add" }))
        .css_classes(["native-room-favorite-action"])
        .build();
    button.set_sensitive(saved.is_none());
    let (s, rid, live, label) = (session.clone(), rid.to_owned(), active.clone(), status.clone());
    button.connect_clicked(move |button| {
        if !live.get() || !button.is_sensitive() {
            return;
        }
        match s.set_favorite_from_state(&rid, !state.favorite, &membership, &revision) {
            Ok(()) => button.set_sensitive(false),
            Err(error) => label.set_text(t(if error.code() == "favorite_state_changed" {
                "rooms.conflict"
            } else {
                "rooms.failed"
            })),
        }
    });
    content.append(&button);
    if let Some(saved) = saved {
        status.set_text(t(if saved.phase == "failed" { "rooms.rejected" } else { "rooms.pending" }));
        let failed = saved.phase == "failed";
        let button = gtk::Button::builder().label(t(if failed { "rooms.clear" } else { "rooms.resume" })).build();
        button.add_css_class(if failed { "native-room-favorite-clear" } else { "native-room-favorite-resume" });
        let (rid, key, label) = (saved.room, saved.input.operation_id, status.clone());
        button.connect_clicked(move |_| {
            if !active.get() || session.is_closed() {
                return;
            }
            let result = if failed {
                session.dismiss_failed_favorite(&rid, &key).map(|_| ())
            } else {
                if session.store.favorite_intent(&rid).ok().flatten().is_none_or(|s| s.input.operation_id != key) {
                    return;
                }
                session.resume_favorite(&rid)
            };
            if result.is_err() {
                label.set_text(t("rooms.failed"));
            }
        });
        content.append(&button);
    }
    content.append(&status);
}
pub(crate) fn menu(widget: &gtk::Widget, session: Arc<NativeSession>, rid: &str) {
    if !session.supported_features().iter().any(|f| f == "favorites") {
        return;
    }
    let membership = session.store.read_state(rid).ok().flatten().and_then(|s| s.membership_version);
    widget.add_css_class("native-room-favorite-context");
    let click = gtk::GestureClick::builder().button(gdk::BUTTON_SECONDARY).build();
    let (target, rid) = (widget.downgrade(), rid.to_owned());
    click.connect_pressed(move |gesture, _, x, y| {
        let Some(widget) = target.upgrade() else { return };
        if session.is_closed()
            || session.store.read_state(&rid).ok().flatten().and_then(|s| s.membership_version) != membership
        {
            return;
        }
        gesture.set_state(gtk::EventSequenceState::Claimed);
        let content = gtk::Box::new(gtk::Orientation::Vertical, 8);
        let active = Rc::new(Cell::new(true));
        controls(&content, session.clone(), &rid, active.clone());
        let popover = gtk::Popover::builder().child(&content).has_arrow(false).build();
        popover.set_parent(&widget);
        popover.set_pointing_to(Some(&gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
        popover.connect_closed(move |p| {
            active.set(false);
            p.unparent();
        });
        popover.popup();
    });
    widget.add_controller(click);
}
