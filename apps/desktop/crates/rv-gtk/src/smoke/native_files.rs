//! Exercise attachment selection, progress and the existing file card without screenshots.
use super::check;
use crate::window::AppWindow;
use gtk::{glib, prelude::*};
use std::{rc::Rc, time::Duration};
pub(super) fn install(window: &Rc<AppWindow>) {
    if std::env::var("RV_SMOKE_NATIVE_FILES").as_deref() != Ok("1") {
        return;
    }
    let weak = Rc::downgrade(window);
    let mut polls = 0;
    glib::timeout_add_local(Duration::from_millis(100), move || {
        let Some(window) = weak.upgrade() else { return glib::ControlFlow::Break };
        polls += 1;
        if window.chat.native_session().is_some_and(|s| s.status().connection == rv_core::session::Connection::Online)
            && window.chat.current_rid().is_some()
        {
            glib::spawn_future_local(run(window));
            return glib::ControlFlow::Break;
        }
        if polls > 300 {
            check("native file room loaded", false, ());
            std::process::exit(1)
        }
        glib::ControlFlow::Continue
    });
}
async fn run(window: Rc<AppWindow>) {
    let session = window.chat.native_session().unwrap();
    let rid = window.chat.current_rid().unwrap();
    let path = std::env::temp_dir().join(format!("gtk-file-{}.txt", std::process::id()));
    std::fs::write(&path, "the existing GTK composer uploads this file").unwrap();
    let composer = window.chat.composer_rc();
    composer.stage(vec![crate::attach::Picked { path: path.clone(), name: "gtk-file.txt".into(), temporary: false }]);
    composer.set_text("GTK native file caption");
    check("existing GTK attachment staging", composer.staged_names().iter().any(|name| name == "gtk-file.txt"), ());
    composer.submit_now();
    let mut received = None;
    for _ in 0..300 {
        received = session
            .store
            .messages(&rid, 50)
            .unwrap()
            .into_iter()
            .find(|m| m.text == "GTK native file caption" && m.attachments.is_some());
        if received.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    check("existing GTK composer confirms native file", received.is_some(), ());
    let row = received.unwrap();
    let files = rv_core::content::files(row.attachments.as_deref());
    check("native manifest uses existing file card", files.len() == 1, files.len());
    let local =
        crate::cards::local_copy(crate::media::Provider::RocketVibe(session.clone()), files[0].clone()).await.unwrap();
    check(
        "native GTK protected reader",
        std::fs::read_to_string(local).unwrap() == "the existing GTK composer uploads this file",
        (),
    );
    check("native GTK upload strip settled", session.file_uploads(&rid).unwrap().is_empty(), ());
    for _ in 0..30 {
        if super::find_by_class(window.chat.widget().upcast_ref(), "file-card").is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    check(
        "native GTK file widget rendered",
        super::find_by_class(window.chat.widget().upcast_ref(), "file-card").is_some(),
        (),
    );
    let selection = session.store.quote_selection(&rid, &row.id).unwrap();
    let membership = session.store.read_state(&rid).unwrap().unwrap().membership_version.unwrap();
    let quoted = session.send_quotes_from_membership(&rid, "GTK quoted file", Some(&membership), &[selection]).unwrap();
    for _ in 0..300 {
        if session.store.messages(&rid, 50).unwrap().iter().any(|m| m.id == quoted && m.status.is_none()) {
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    let quoted_row = session.store.messages(&rid, 50).unwrap().into_iter().find(|m| m.id == quoted).unwrap();
    let quotes = rv_core::content::quotes(quoted_row.attachments.as_deref());
    check(
        "native GTK quoted file metadata",
        quotes.len() == 1 && quotes[0].files.len() == 1 && quotes[0].files[0].title == "gtk-file.txt",
        (),
    );
    for _ in 0..30 {
        if super::find_by_class(window.chat.widget().upcast_ref(), "quote-card").is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    check(
        "existing GTK quote card rendered",
        super::find_by_class(window.chat.widget().upcast_ref(), "quote-card").is_some(),
        (),
    );
    if std::env::var("RV_SMOKE_NATIVE_EMOJIS").as_deref() == Ok("1") {
        check("native GTK custom catalogue", session.custom_emoji_names().iter().any(|c| c == "party_parrot"), ());
        check(
            "native GTK custom alias",
            session.custom_emoji("party_parrot") == session.custom_emoji("vibe_parrot"),
            (),
        );
        composer.set_text("GTK :vibe_parrot: custom emoji");
        composer.submit_now();
        let mut rendered = false;
        for _ in 0..100 {
            rendered = super::find_by_class(window.chat.widget().upcast_ref(), "custom-emoji")
                .and_then(|w| w.last_child())
                .and_then(|w| w.downcast::<gtk::Picture>().ok())
                .is_some_and(|p| p.paintable().is_some());
            if rendered {
                break;
            }
            glib::timeout_future(Duration::from_millis(100)).await;
        }
        check("native GTK custom emoji rendered", rendered, ());
    }
    let _ = std::fs::remove_file(path);
    window.window.application().unwrap().quit();
}
