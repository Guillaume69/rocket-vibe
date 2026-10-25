//! `RV_SMOKE_WHATSAPP=<directory>`: a WhatsApp account added and used end to
//! end against the synthetic helper (`RV_WHATSAPP_HELPER`, the rv-core
//! `fake-whatsapp-sidecar`, which "scans" its QR itself after
//! `RV_FAKE_WHATSAPP_SCAN_MS`). Never run it against a real account.
//!
//! 1. The login page's Connect WhatsApp opens the dialog with a QR
//!    (`<directory>/link.png`).
//! 2. Once linked, the account is the open one, in the rail; its
//!    conversations fill the room list with names, a photo and an unread count.
//! 3. A chat opens with its messages, a reaction and a reply's quote; the
//!    composer has no file or voice buttons; a text sent through it arrives
//!    (`<directory>/chat.png`).
//! 4. "New conversation" finds Bob among the contacts; his chat opens before
//!    any message and takes one; my photo is shown for my messages.
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use rv_core::whatsapp_session::WaSession;

use adw::prelude::*;
use gtk::glib;

use super::{check, find_by_class};
use crate::window::AppWindow;

pub fn install(window: &Rc<AppWindow>) {
    let Ok(out) = std::env::var("RV_SMOKE_WHATSAPP") else { return };
    let weak = Rc::downgrade(window);
    let pressed = Rc::new(std::cell::Cell::new(false));
    window.connect_login_shown(move || {
        let Some(w) = weak.upgrade() else { return };
        if pressed.replace(true) {
            return;
        }
        w.login.press_whatsapp();
        let (weak, out) = (Rc::downgrade(&w), out.clone());
        glib::timeout_add_local_once(Duration::from_millis(1500), move || {
            let Some(w) = weak.upgrade() else { return };
            let root: gtk::Widget = w.window.clone().upcast();
            let qr = find_by_class(&root, "whatsapp-qr");
            check("whatsapp link dialog shows a QR", qr.as_ref().is_some_and(|q| q.is_visible()), qr.is_some());
            shot(&w, &format!("{out}/link.png"));
            linked(w, out);
        });
    });
}

/// Waits for the account to open after the synthetic scan, then uses it.
fn linked(window: Rc<AppWindow>, out: String) {
    let mut polls = 0;
    glib::timeout_add_local(Duration::from_millis(250), move || {
        polls += 1;
        let session = window.chat.whatsapp_session();
        let ready = session.as_ref().is_some_and(|s| s.room_rows().len() == 2);
        if !ready && polls < 60 {
            return glib::ControlFlow::Continue;
        }
        check("whatsapp account opened after the scan", ready, polls);
        let Some(session) = session else {
            window.window.close();
            return glib::ControlFlow::Break;
        };
        let active = crate::secrets::active().unwrap_or_default();
        check("whatsapp account is the active one", active.starts_with("whatsapp://"), &active);
        let rows = session.room_rows();
        let alice = rows.iter().find(|r| r.rid == "alice@s.whatsapp.net");
        check(
            "whatsapp names in the room list",
            alice.is_some_and(|r| r.name == "Alice Martin"),
            alice.map(|r| &r.name),
        );
        let friends = rows.iter().find(|r| r.rid == "friends@g.us");
        check("whatsapp unread count", friends.is_some_and(|r| r.unread == 2), friends.map(|r| r.unread));
        window.chat.open_room("alice@s.whatsapp.net");
        let (window, out) = (window.clone(), out.clone());
        glib::timeout_add_local_once(Duration::from_millis(800), move || {
            let list = window.chat.message_list();
            check(
                "whatsapp chat shows its messages",
                list.row_widget("alice@s.whatsapp.net:fake-received").is_some()
                    && list.row_widget("alice@s.whatsapp.net:fake-reply").is_some(),
                list.len(),
            );
            check("whatsapp composer offers files and voice notes", window.chat.composer_tools_shown(), ());
            check(
                "whatsapp photo and voice note rows",
                list.row_widget("alice@s.whatsapp.net:fake-photo").is_some()
                    && list.row_widget("alice@s.whatsapp.net:fake-voice").is_some(),
                (),
            );
            window.chat.send_text(THAI);
            let (window, session) = (window.clone(), session.clone());
            glib::timeout_add_local_once(Duration::from_millis(1200), move || {
                let sent = session.snapshot().messages.values().any(|m| m.mine && m.text == THAI);
                check("whatsapp text sent through the composer", sent, ());
                // Drawing the photo asked the helper for its file.
                let fetched = std::env::temp_dir().join("rv-fake-whatsapp-alice_s.whatsapp.net_fake-photo").exists();
                check("whatsapp photo fetched for the timeline", fetched, ());
                let own = session.info.user_id.clone();
                check("whatsapp my photo arrived", session.photo(&own).is_some(), &own);
                shot(&window, &format!("{out}/chat.png"));
                selection_survives_a_rebuild(&window);
                new_conversation(window.clone(), session.clone());
            });
        });
        glib::ControlFlow::Break
    });
}

/// A photo or a receipt arriving builds the rows again: a selection made in
/// a message must still be the one the copy shortcut takes.
fn selection_survives_a_rebuild(window: &AppWindow) {
    let list = window.chat.message_list();
    let text = list
        .row_widget("alice@s.whatsapp.net:fake-received")
        .and_then(|row| crate::message_list::texts(&row).into_iter().next())
        .and_then(|text| text.downcast::<gtk::Label>().ok());
    let Some(text) = text else {
        check("whatsapp message text to select", false, ());
        return;
    };
    text.select_region(0, 7);
    crate::markdown_view::note_selection(text.upcast_ref());
    let before = crate::markdown_view::selected_text();
    list.rebind();
    let after = crate::markdown_view::selected_text();
    check("whatsapp selection survives a rebuild", before.is_some() && after == before, (before, after));
    crate::markdown_view::clear_selection();
}

/// A conversation started from the contacts, before its first message.
fn new_conversation(window: Rc<AppWindow>, session: Arc<WaSession>) {
    glib::spawn_future_local(async move {
        let chat = window.chat.chat().expect("the WhatsApp account");
        let found = crate::on_tokio(async move { chat.spotlight("bob").await }).await.unwrap_or_default();
        check("whatsapp new conversation finds a contact", found.len() == 1, found.len());
        if let Some(bob) = found.into_iter().next() {
            window.chat.go_to(bob);
        }
        check(
            "whatsapp new conversation opens before its first message",
            window.chat.current_rid().as_deref() == Some("bob@s.whatsapp.net"),
            window.chat.current_rid(),
        );
        window.chat.send_text("Hello Bob");
        glib::timeout_future(Duration::from_millis(1200)).await;
        let sent = session.snapshot().messages.values().any(|m| m.chat == "bob@s.whatsapp.net" && m.mine);
        check("whatsapp new conversation takes a message", sent, ());
        // A photo through the composer's send of files.
        let path = std::env::temp_dir().join("rv-smoke-whatsapp-photo.png");
        let bytes = glib::base64_decode(PNG);
        let _ = std::fs::write(&path, bytes);
        let picked = crate::attach::Picked { path, name: "photo.png".into(), temporary: false };
        window.chat.send_files_now(vec![(picked, "image/png".into())], "Une photo".into());
        glib::timeout_future(Duration::from_millis(1500)).await;
        let photo = session
            .snapshot()
            .messages
            .values()
            .any(|m| m.chat == "bob@s.whatsapp.net" && m.mine && m.kind == "image" && m.text == "Une photo");
        check("whatsapp photo sent with its caption", photo, ());
        window.window.close();
    });
}

/// A 32x32 PNG for the photo sent.
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mOQq7hDU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAKHFyEyREEL5AAAAAElFTkSuQmCC";

fn shot(window: &AppWindow, path: &str) {
    let paintable = gtk::WidgetPaintable::new(Some(&window.window));
    let snapshot = gtk::Snapshot::new();
    paintable.snapshot(&snapshot, window.window.width() as f64, window.window.height() as f64);
    let saved = snapshot
        .to_node()
        .zip(window.window.renderer())
        .is_some_and(|(node, renderer)| renderer.render_texture(&node, None).save_to_png(path).is_ok());
    check("whatsapp screenshot", saved, path);
}

/// Thai marks stack above and below the line: the read receipt under it must still show whole.
const THAI: &str = "ยึดครอง แต่ไม่แน่ใจว่าจำถูกหรือเปล่า";
