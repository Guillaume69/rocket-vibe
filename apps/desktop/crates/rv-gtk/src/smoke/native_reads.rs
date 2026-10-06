//! Actual native read timer, visibility and opening-marker traversal.
use super::check;
use crate::window::AppWindow;
use adw::prelude::*;
use gtk::glib;
use std::{rc::Rc, time::Duration};

pub(super) fn install(window: &Rc<AppWindow>) {
    if std::env::var("RV_SMOKE_READS").as_deref() != Ok("1") {
        return;
    }
    let weak = Rc::downgrade(window);
    let mut polls = 0;
    glib::timeout_add_local(Duration::from_millis(100), move || {
        let Some(window) = weak.upgrade() else {
            return glib::ControlFlow::Break;
        };
        polls += 1;
        if window.chat.native_session().is_some()
            && window.chat.current_rid().is_some()
            && window.chat.room_list().texts().iter().any(|t| t == "Read fixture second")
        {
            glib::spawn_future_local(run(window));
            return glib::ControlFlow::Break;
        }
        if polls >= 200 {
            check("native read room loaded", false, 0);
            return glib::ControlFlow::Break;
        }
        glib::ControlFlow::Continue
    });
}

async fn run(window: Rc<AppWindow>) {
    let session = window.chat.native_session().unwrap();
    assert_eq!(session.info.base_url.trim_end_matches('/'), "http://rv-room-controls-server:3400");
    assert_eq!(session.info.username, "desktop");
    let rid = window.chat.current_rid().unwrap();
    let opening = session.store.read_state(&rid).unwrap().unwrap();
    check(
        "native confirmed unread and mention badges",
        rv_core::native::read_presentation::badges(Some(&opening)) == (2, 1, true),
        true,
    );
    let list = window.chat.room_list();
    check("native opening marker is visible in the existing list", list.has_new_marker(), true);
    session.suspend();
    window.window.set_visible(false);
    glib::timeout_future(Duration::from_millis(1800)).await;
    check("hidden native room queues no read", session.store.pending_reads().unwrap().is_empty(), true);
    window.window.present();
    window.chat.composer().grab_focus();
    for _ in 0..240 {
        list.notify_visible();
        if !session.store.pending_reads().unwrap().is_empty() {
            break;
        }
        glib::timeout_future(Duration::from_millis(25)).await;
    }
    let messages = session.store.messages(&rid, 10).unwrap();
    let latest = messages.last().unwrap();
    let pending = session.store.pending_reads().unwrap();
    check(
        "existing GTK timer saves the displayed confirmed position",
        pending.first().is_some_and(|read| Some(&read.root_position) == latest.position.as_ref()),
        true,
    );
    check(
        "offline read keeps confirmed badges",
        session.store.read_state(&rid).unwrap().unwrap().unread_roots == "2",
        true,
    );
    session.reconnect();
    for _ in 0..240 {
        if session.store.read_state(&rid).unwrap().is_some_and(|s| s.unread_roots == "0")
            && session.store.pending_reads().unwrap().is_empty()
        {
            break;
        }
        glib::timeout_future(Duration::from_millis(25)).await;
    }
    let current = session.store.read_state(&rid).unwrap().unwrap();
    check(
        "native read ACK clears confirmed badges",
        current.unread_roots == "0"
            && current.mentions == "0"
            && Some(&current.root_position) == latest.position.as_ref(),
        true,
    );
    check("opening marker survives the read ACK", list.has_new_marker(), true);
    eprintln!("smoke: native read controls completed");
}
