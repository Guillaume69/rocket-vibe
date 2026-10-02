//! The existing reply bar, composer and quote cards against a native server.
use super::check;
use crate::window::AppWindow;
use gtk::{glib, prelude::*};
use std::{rc::Rc, time::Duration};

pub(super) fn install(window: &Rc<AppWindow>) {
    if std::env::var("RV_SMOKE_QUOTES").as_deref() != Ok("1") {
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
            && window.chat.room_list().texts().iter().any(|text| text.contains("GTK quote source"))
        {
            glib::spawn_future_local(run(window));
            return glib::ControlFlow::Break;
        }
        if polls >= 600 {
            check("native quote fixture loaded", false, ());
            std::process::exit(1);
        }
        glib::ControlFlow::Continue
    });
}

fn contains(root: &gtk::Widget, text: &str) -> bool {
    if root.downcast_ref::<gtk::Label>().is_some_and(|label| label.text().contains(text)) {
        return true;
    }
    let mut child = root.first_child();
    while let Some(widget) = child {
        if contains(&widget, text) {
            return true;
        }
        child = widget.next_sibling();
    }
    false
}

fn reply_button(root: &gtk::Widget) -> Option<gtk::Button> {
    if let Some(button) = root.downcast_ref::<gtk::Button>()
        && button.label().as_deref() == Some(crate::i18n::t("actions.reply"))
    {
        return Some(button.clone());
    }
    let mut child = root.first_child();
    while let Some(widget) = child {
        if let Some(button) = reply_button(&widget) {
            return Some(button);
        }
        child = widget.next_sibling();
    }
    None
}

fn occurrences(root: &gtk::Widget, text: &str) -> usize {
    let mut count = usize::from(
        root.downcast_ref::<gtk::Label>().is_some_and(|label| label.text().contains(text))
            || root.downcast_ref::<gtk::TextView>().is_some_and(|view| {
                let buffer = view.buffer();
                buffer.text(&buffer.start_iter(), &buffer.end_iter(), true).contains(text)
            }),
    );
    let mut child = root.first_child();
    while let Some(widget) = child {
        count += occurrences(&widget, text);
        child = widget.next_sibling();
    }
    count
}

fn has_quote(root: &gtk::Widget, text: &str) -> bool {
    if root.has_css_class("quote-card") && occurrences(root, text) > 0 {
        return true;
    }
    let mut child = root.first_child();
    while let Some(widget) = child {
        if has_quote(&widget, text) {
            return true;
        }
        child = widget.next_sibling();
    }
    false
}

async fn run(window: Rc<AppWindow>) {
    let session = window.chat.native_session().unwrap();
    check("native discovery enables quotes", session.supported_features().iter().any(|f| f == "quotes"), ());
    let rid = window.chat.current_rid().unwrap();
    let source =
        session.store.messages(&rid, 100).unwrap().into_iter().rev().find(|m| m.text == "GTK quote source").unwrap();
    let reply_text = format!("GTK quoted reply {}", source.id);
    window.chat.play(
        crate::rows::RowEvent::Menu {
            row: Box::new(source.clone().presentation(&rid, &session.info.user_id)),
            anchor: window.chat.room_list().row_widget(&source.id).unwrap(),
            x: 10.0,
            y: 10.0,
        },
        false,
    );
    let mut button = None;
    for _ in 0..100 {
        button = reply_button(window.window.upcast_ref());
        if button.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("existing GTK menu exposes native reply", button.is_some(), ());
    let Some(button) = button else {
        std::process::exit(1);
    };
    button.emit_clicked();
    check("existing GTK reply bar holds a native selection", window.chat.composer().native_reply().is_some(), ());
    window.chat.composer().set_text(&reply_text);
    window.chat.composer().submit_now();
    let mut reply = None;
    for _ in 0..240 {
        reply = session
            .store
            .messages(&rid, 100)
            .unwrap()
            .into_iter()
            .find(|m| m.text == reply_text && m.position.is_some());
        if reply.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("GTK quote is confirmed once", reply.is_some(), ());
    let Some(reply) = reply else {
        std::process::exit(1);
    };
    let references = rv_core::content::quotes(reply.attachments.as_deref());
    check("native reference reaches the existing card", references.len() == 1 && references[0].text == source.text, ());
    check("GTK clears a successfully queued selection", window.chat.composer().native_reply().is_none(), ());
    for _ in 0..80 {
        if window.chat.room_list().row_widget(&reply.id).is_some_and(|widget| has_quote(&widget, &source.text)) {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "existing GTK card renders the native source",
        window.chat.room_list().row_widget(&reply.id).is_some_and(|widget| has_quote(&widget, &source.text)),
        (),
    );
    window.chat.start_quote(source.clone().presentation(&rid, &session.info.user_id));
    let (_, permissions) = crate::on_tokio({
        let s = session.clone();
        let id = source.id.clone();
        async move { s.message_action_context(&id).await }
    })
    .await
    .unwrap();
    crate::on_tokio({
        let s = session.clone();
        let id = source.id.clone();
        let r = rid.clone();
        async move { s.delete(&r, &id, &permissions.revision).await }
    })
    .await
    .unwrap();
    for _ in 0..80 {
        if !contains(window.chat.composer().root.upcast_ref(), "GTK quote source") {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "GTK discards the private open preview",
        !contains(window.chat.composer().root.upcast_ref(), "GTK quote source"),
        (),
    );
    window.chat.composer().set_text("GTK words survive a stale quote");
    window.chat.composer().submit_now();
    check(
        "GTK preserves words after local quote rejection",
        window.chat.composer().text() == "GTK words survive a stale quote",
        (),
    );
    check("GTK keeps the rejected selection actionable", window.chat.composer().native_reply().is_some(), ());
    let current = session.store.messages(&rid, 100).unwrap().into_iter().find(|m| m.id == reply.id).unwrap();
    check(
        "existing card marks a deleted source unavailable",
        rv_core::content::quotes(current.attachments.as_deref()).first().is_some_and(|q| q.unavailable),
        (),
    );
    window.chat.composer().clear_reply();
    std::process::exit(i32::from(super::FAILED.load(std::sync::atomic::Ordering::SeqCst)));
}
