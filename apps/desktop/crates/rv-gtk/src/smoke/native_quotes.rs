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
    action_button(root, "actions.reply")
}
fn action_button(root: &gtk::Widget, key: &str) -> Option<gtk::Button> {
    if let Some(button) = root.downcast_ref::<gtk::Button>()
        && button.label().as_deref() == Some(crate::i18n::t(key))
    {
        return Some(button.clone());
    }
    let mut child = root.first_child();
    while let Some(widget) = child {
        if let Some(button) = action_button(&widget, key) {
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
    let activity = session
        .store
        .messages(&rid, 100)
        .unwrap()
        .into_iter()
        .rev()
        .find(|m| m.system_type.as_deref() == Some("room_changed_topic"))
        .unwrap();
    let row = activity.clone().presentation(&rid, &session.info.user_id);
    check(
        "native system row uses existing renderer",
        window
            .chat
            .room_list()
            .row_widget(&activity.id)
            .is_some_and(|widget| contains(&widget, &crate::rows::system_line(&row))),
        (),
    );
    check(
        "native system row has no reply actions",
        !rv_core::actions::has_actions(row.system_type.as_deref(), row.text.as_deref())
            && session.store.quote_selection(&rid, &activity.id).is_err(),
        (),
    );
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
    check(
        "nested native reference reaches the existing card",
        references.first().is_some_and(|q| q.quotes.first().is_some_and(|child| child.text == "GTK nested leaf")),
        (),
    );
    check("GTK clears a successfully queued selection", window.chat.composer().native_reply().is_none(), ());
    for _ in 0..80 {
        if window
            .chat
            .room_list()
            .row_widget(&reply.id)
            .is_some_and(|widget| has_quote(&widget, &source.text) && has_quote(&widget, "GTK nested leaf"))
        {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "existing GTK card renders the native source",
        window.chat.room_list().row_widget(&reply.id).is_some_and(|widget| has_quote(&widget, &source.text)),
        (),
    );
    check(
        "existing GTK card renders the nested native source",
        window.chat.room_list().row_widget(&reply.id).is_some_and(|widget| has_quote(&widget, "GTK nested leaf")),
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
        rv_core::content::quotes(current.attachments.as_deref())
            .first()
            .is_some_and(|q| q.unavailable && q.quotes.is_empty()),
        (),
    );
    window.chat.composer().clear_reply();
    check("native discovery enables threads", session.supported_features().iter().any(|f| f == "threads"), ());
    window.chat.play(
        crate::rows::RowEvent::Menu {
            row: Box::new(current.presentation(&rid, &session.info.user_id)),
            anchor: window.chat.room_list().row_widget(&reply.id).unwrap(),
            x: 10.0,
            y: 10.0,
        },
        false,
    );
    let mut thread_button = None;
    for _ in 0..100 {
        thread_button = action_button(window.window.upcast_ref(), "actions.reply_thread");
        if thread_button.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("existing GTK menu opens a native thread", thread_button.is_some(), ());
    let Some(thread_button) = thread_button else { std::process::exit(1) };
    thread_button.emit_clicked();
    let thread = window.chat.thread().unwrap();
    check("existing GTK thread contains its root", thread.list.row(&reply.id).is_some(), ());
    check(
        "GTK thread draft starts separately",
        thread.composer.text().is_empty() && window.chat.composer().text() == "GTK words survive a stale quote",
        (),
    );
    thread.composer.set_text("GTK reply in the existing thread");
    thread.composer.submit_now();
    let mut child = None;
    for _ in 0..200 {
        child = session
            .store
            .thread_messages(&rid, &reply.id)
            .unwrap()
            .into_iter()
            .find(|m| m.text == "GTK reply in the existing thread" && m.position.is_some());
        if child.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("GTK thread reply is confirmed", child.is_some(), ());
    let Some(child) = child else { std::process::exit(1) };
    for _ in 0..80 {
        if thread.list.row_widget(&child.id).is_some()
            && window.chat.room_list().row(&reply.id).is_some_and(|m| m.thread_count == 1)
        {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("GTK thread reuses the message renderer", thread.list.row_widget(&child.id).is_some(), ());
    check(
        "GTK root counter advances without a second timeline root",
        window.chat.room_list().row(&reply.id).is_some_and(|m| m.thread_count == 1)
            && window.chat.room_list().row(&child.id).is_none(),
        (),
    );
    window.chat.play(
        crate::rows::RowEvent::Menu {
            row: Box::new(child.clone().presentation(&rid, &session.info.user_id)),
            anchor: thread.list.row_widget(&child.id).unwrap(),
            x: 10.0,
            y: 10.0,
        },
        true,
    );
    let mut quote_button = None;
    for _ in 0..80 {
        quote_button = reply_button(window.window.upcast_ref());
        if quote_button.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("GTK thread retains its existing quote action", quote_button.is_some(), ());
    let Some(quote_button) = quote_button else { std::process::exit(1) };
    quote_button.emit_clicked();
    check(
        "GTK thread quote targets its own composer",
        thread.composer.native_reply().is_some() && window.chat.composer().native_reply().is_none(),
        (),
    );
    thread.composer.set_text("GTK citation within the thread");
    thread.composer.submit_now();
    for _ in 0..160 {
        if session.store.thread_messages(&rid, &reply.id).unwrap().iter().any(|m| {
            m.text == "GTK citation within the thread"
                && m.position.is_some()
                && !rv_core::content::quotes(m.attachments.as_deref()).is_empty()
        }) {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "GTK thread preserves native citation references",
        session.store.thread_messages(&rid, &reply.id).unwrap().iter().any(|m| {
            m.text == "GTK citation within the thread"
                && m.position.is_some()
                && !rv_core::content::quotes(m.attachments.as_deref()).is_empty()
        }),
        (),
    );
    thread.composer.set_text("GTK thread draft survives root deletion");
    let (_, rights) = crate::on_tokio({
        let s = session.clone();
        let id = reply.id.clone();
        async move { s.message_action_context(&id).await }
    })
    .await
    .unwrap();
    crate::on_tokio({
        let s = session.clone();
        let id = reply.id.clone();
        let r = rid.clone();
        async move { s.delete(&r, &id, &rights.revision).await }
    })
    .await
    .unwrap();
    for _ in 0..80 {
        if !thread.composer.root.is_visible() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("GTK deleted root makes its thread read-only", !thread.composer.root.is_visible(), ());
    check(
        "GTK deleted root preserves the thread draft",
        session.store.thread_draft_from_membership(&rid, &reply.id, thread.membership.as_deref()).unwrap()
            == "GTK thread draft survives root deletion",
        (),
    );
    std::process::exit(i32::from(super::FAILED.load(std::sync::atomic::Ordering::SeqCst)));
}
