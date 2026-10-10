//! The existing reply bar, composer and quote cards against a native server.
use super::check;
use crate::window::AppWindow;
use adw::prelude::AdwDialogExt;
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
    button_with_label(root, crate::i18n::t(key))
}
fn button_with_label(root: &gtk::Widget, label: &str) -> Option<gtk::Button> {
    if let Some(button) = root.downcast_ref::<gtk::Button>()
        && button.label().as_deref() == Some(label)
    {
        return Some(button.clone());
    }
    let mut child = root.first_child();
    while let Some(widget) = child {
        if let Some(button) = button_with_label(&widget, label) {
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
fn has_photo(root: &gtk::Widget) -> bool {
    if root.downcast_ref::<gtk::Picture>().and_then(|p| p.paintable()).is_some() {
        return true;
    }
    let mut child = root.first_child();
    while let Some(widget) = child {
        if has_photo(&widget) {
            return true;
        }
        child = widget.next_sibling();
    }
    false
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
    window.chat.show_profile(&session.info.user_id, true);
    let mut profile = None;
    for _ in 0..200 {
        profile = super::find_by_class(window.window.upcast_ref(), "user-profile-dialog")
            .filter(|dialog| contains(dialog, &format!("@{}", session.info.username)));
        if profile.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(20)).await;
    }
    check("native profile uses existing GTK dialog", profile.is_some(), ());
    profile.unwrap().downcast::<adw::Dialog>().unwrap().close();
    let settings = crate::settings::open_native(window.chat.widget(), session.clone(), None, || {});
    let mut edit = None;
    for _ in 0..200 {
        edit = super::find_by_class(window.window.upcast_ref(), "native-profile-edit")
            .and_then(|widget| widget.downcast::<gtk::Button>().ok())
            .filter(|button| button.is_sensitive());
        if edit.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(20)).await;
    }
    check("native personal profile loads in existing settings", edit.is_some(), ());
    edit.unwrap().emit_clicked();
    let field = super::find_by_class(window.window.upcast_ref(), "native-profile-bio")
        .unwrap()
        .downcast::<adw::EntryRow>()
        .unwrap();
    let bio = format!("GTK personal profile {}", session.info.user_id);
    field.set_text(&bio);
    super::find_by_class(window.window.upcast_ref(), "native-profile-save")
        .unwrap()
        .downcast::<adw::ButtonRow>()
        .unwrap()
        .emit_by_name::<()>("activated", &[]);
    let mut saved = false;
    for _ in 0..100 {
        let session = session.clone();
        let found = crate::on_tokio(async move { session.own_profile().await }).await;
        if found.is_ok_and(|own| own.profile.bio == bio) {
            saved = true;
            break;
        }
        glib::timeout_future(Duration::from_millis(20)).await;
    }
    check("existing GTK personal form saves native profile", saved, ());
    check(
        "native settings are the sidebar dialog",
        super::find_by_class(window.window.upcast_ref(), "native-profile-settings")
            .is_some_and(|w| w.is::<adw::Dialog>()),
        (),
    );
    settings.dialog().close();
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
            link: None,
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
            link: None,
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
            link: None,
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
    cross_room_quotes(&window, &session, &rid).await;
    search_controls(&window, &session, &rid).await;
    live_controls(&window, &session).await;
    std::process::exit(i32::from(super::FAILED.load(std::sync::atomic::Ordering::SeqCst)));
}

async fn cross_room_quotes(
    window: &Rc<AppWindow>,
    session: &std::sync::Arc<rv_core::native::NativeSession>,
    rid: &str,
) {
    let name = format!("gtk-quote-target-{}", rv_core::native::room_operation_id());
    let (s, target_name) = (session.clone(), name.clone());
    let target = crate::on_tokio(async move { s.create_room(&target_name, true, false).await }).await.unwrap();
    for _ in 0..120 {
        if window.chat.has_room(&target) {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("GTK quote destination is joined", window.chat.has_room(&target), ());
    window.chat.open_room(&target);
    window.chat.open_room(rid);
    let id = session.send(rid, "GTK cross-room source").unwrap();
    let mut source = None;
    for _ in 0..120 {
        source = session.store.messages(rid, 100).unwrap().into_iter().find(|m| m.id == id && m.position.is_some());
        if source.is_some()
            && window.chat.current_rid().as_deref() == Some(rid)
            && window.chat.room_list().row(&id).is_some_and(|row| row.outbox_status.is_none())
            && session.status().connection == rv_core::session::Connection::Online
        {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    let source = source.unwrap();
    check(
        "GTK cross-room source is confirmed in the rendered timeline",
        window.chat.room_list().row(&id).is_some_and(|row| row.outbox_status.is_none()),
        (),
    );
    window.chat.play(
        crate::rows::RowEvent::Menu {
            row: Box::new(window.chat.room_list().row(&id).unwrap()),
            anchor: window.chat.room_list().row_widget(&id).unwrap(),
            x: 10.0,
            y: 10.0,
            link: None,
        },
        false,
    );
    let mut button = None;
    for _ in 0..100 {
        button = action_button(window.window.upcast_ref(), "quote.elsewhere");
        if button.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("GTK existing menu exposes destination chooser", button.is_some(), ());
    if button.is_none() {
        let context = session.message_action_context(&source.id).await;
        eprintln!(
            "smoke: quote menu diagnostics: connection {:?}, selection {}, mapped {}, context {:?}",
            session.status().connection,
            crate::markdown_view::selected_text().is_some(),
            window.chat.room_list().row_widget(&id).is_some_and(|row| row.is_mapped()),
            context.err().map(|error| error.code().to_owned()),
        );
    }
    let Some(button) = button else { std::process::exit(1) };
    button.emit_clicked();
    let mut dialog = None;
    for _ in 0..100 {
        dialog = super::find_by_class(window.window.upcast_ref(), "quote-destination-dialog");
        if dialog.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("GTK destination dialog is rendered", dialog.is_some(), ());
    let Some(dialog) = dialog else { std::process::exit(1) };
    let entry =
        super::find_by_class(&dialog, "quote-destination-search").unwrap().downcast::<gtk::SearchEntry>().unwrap();
    entry.set_text(&name);
    let choice = button_with_label(&dialog, &name).unwrap();
    choice.emit_clicked();
    for _ in 0..100 {
        if window.chat.current_rid().as_deref() == Some(&target) && window.chat.composer().native_reply().is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "GTK chooser transfers a reference into existing composer",
        window.chat.current_rid().as_deref() == Some(&target)
            && window
                .chat
                .composer()
                .native_reply()
                .is_some_and(|s| s.reference.room_id == rid && s.reference.message_id == id),
        (),
    );
    window.chat.composer().set_text("GTK cross-room reference");
    window.chat.composer().submit_now();
    let mut parent = None;
    for _ in 0..160 {
        parent = session
            .store
            .messages(&target, 100)
            .unwrap()
            .into_iter()
            .find(|m| m.text == "GTK cross-room reference" && m.position.is_some());
        if parent.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("GTK cross-room reference is confirmed", parent.is_some(), ());
    let Some(parent) = parent else { std::process::exit(1) };
    let quotes = rv_core::content::quotes(parent.attachments.as_deref());
    check(
        "GTK cross-room source renders through current quote cards",
        quotes.first().is_some_and(|q| !q.unavailable && q.author.as_deref() == Some(session.info.username.as_str())),
        (),
    );
    window.chat.open_room(rid);
}

fn search_entry(root: &gtk::Widget) -> Option<gtk::SearchEntry> {
    if let Ok(entry) = root.clone().downcast::<gtk::SearchEntry>() {
        return Some(entry);
    }
    let mut child = root.first_child();
    while let Some(widget) = child {
        if let Some(entry) = search_entry(&widget) {
            return Some(entry);
        }
        child = widget.next_sibling();
    }
    None
}
async fn search_controls(window: &Rc<AppWindow>, session: &std::sync::Arc<rv_core::native::NativeSession>, rid: &str) {
    let membership = session.store.read_state(rid).unwrap().unwrap().membership_version;
    let id = session.send_from_membership(rid, "GTK native search needle", membership.as_deref()).unwrap();
    for _ in 0..100 {
        if session.store.messages(rid, 100).unwrap().iter().any(|m| m.id == id && m.position.is_some()) {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    let dialog = crate::details::search_native(window.chat.widget(), session.clone(), rid, |_, _| {});
    let entry = search_entry(dialog.upcast_ref()).unwrap();
    entry.set_text("needle");
    for _ in 0..100 {
        if contains(dialog.upcast_ref(), "GTK native search needle") {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "native search uses existing GTK search dialog",
        contains(dialog.upcast_ref(), "GTK native search needle"),
        (),
    );
    entry.set_text("missingnativeword");
    for _ in 0..100 {
        if !contains(dialog.upcast_ref(), "GTK native search needle") {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "native GTK search clears previous query results",
        !contains(dialog.upcast_ref(), "GTK native search needle"),
        (),
    );
    entry.set_text("needle");
    for _ in 0..100 {
        if contains(dialog.upcast_ref(), "GTK native search needle") {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    session.suspend();
    for _ in 0..30 {
        if !contains(dialog.upcast_ref(), "GTK native search needle") {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "native GTK search forgets results on suspension",
        !contains(dialog.upcast_ref(), "GTK native search needle"),
        (),
    );
    adw::prelude::AdwDialogExt::close(&dialog);
    session.reconnect();
    for _ in 0..100 {
        if session.status().connection == rv_core::session::Connection::Online {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
}

async fn live_controls(window: &Rc<AppWindow>, session: &std::sync::Arc<rv_core::native::NativeSession>) {
    let current = session.clone();
    let peer = crate::runtime()
        .spawn(async move {
            let url = url::Url::parse(&current.info.base_url).unwrap();
            let discovery = rv_core::native::probe(&url).await.unwrap().unwrap();
            let info = rv_core::native::login(&url, &discovery, "mobile", "native-pilot-test-password").await.unwrap();
            rv_core::native::NativeSession::start(info, std::path::Path::new(":memory:")).unwrap()
        })
        .await
        .unwrap();
    for _ in 0..200 {
        if peer.status().connection == rv_core::session::Connection::Online {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "native GTK DM peer is online before editing its profile",
        peer.status().connection == rv_core::session::Connection::Online,
        (),
    );
    let png = gtk::gdk_pixbuf::Pixbuf::new(gtk::gdk_pixbuf::Colorspace::Rgb, true, 8, 4, 4).unwrap();
    png.fill(0xff5fa2ff);
    let bytes = png.save_to_bufferv("png", &[]).unwrap();
    let current = peer.clone();
    let own = crate::on_tokio(async move {
        let own = current.own_profile().await.unwrap();
        let updated = current
            .change_profile(rv_core::native::store::ProfileOperation::Profile {
                input: rv_core::native::profiles::UpdateProfile {
                    operation_id: rv_core::native::room_operation_id(),
                    expected_revision: own.profile.revision,
                    username: own.profile.user.username,
                    display_name: "GTK current DM peer".into(),
                    bio: "GTK DM peer public bio".into(),
                    status: own.profile.status,
                    status_text: own.profile.status_text,
                },
            })
            .await
            .unwrap();
        current
            .change_profile(rv_core::native::store::ProfileOperation::Avatar {
                input: rv_core::native::profiles::AvatarCommand {
                    operation_id: rv_core::native::room_operation_id(),
                    expected_revision: updated.profile.revision,
                },
                upload: Some(rv_core::native::store::AvatarUpload::from_bytes("image/png".into(), &bytes)),
            })
            .await
            .unwrap()
    })
    .await;
    let current = session.clone();
    let dm = crate::runtime().spawn(async move { current.direct("mobile").await.unwrap() }).await.unwrap();
    for _ in 0..300 {
        if session.store.rooms().unwrap().iter().any(|r| r.id == dm) && peer.store.read_state(&dm).unwrap().is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    window.chat.open_room(&dm);
    for _ in 0..200 {
        if window.chat.header_presence().as_deref() == Some("online") {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "native presence uses existing GTK DM header",
        window.chat.header_presence().as_deref() == Some("online"),
        (),
    );
    for _ in 0..100 {
        if occurrences(window.window.upcast_ref(), "GTK current DM peer") >= 2
            && super::find_by_class(window.window.upcast_ref(), "tile-header").is_some_and(|tile| has_photo(&tile))
        {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "native current DM name uses existing GTK list and header",
        occurrences(window.window.upcast_ref(), "GTK current DM peer") >= 2,
        (),
    );
    check(
        "native protected DM photo uses existing GTK header",
        super::find_by_class(window.window.upcast_ref(), "tile-header").is_some_and(|tile| has_photo(&tile)),
        (),
    );
    window.chat.show_room_info();
    for _ in 0..100 {
        if super::find_by_class(window.window.upcast_ref(), "user-profile-dialog")
            .is_some_and(|p| contains(&p, "GTK DM peer public bio"))
        {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    let profile = super::find_by_class(window.window.upcast_ref(), "user-profile-dialog").unwrap();
    check("native DM information opens existing profile by UID", contains(&profile, "GTK DM peer public bio"), ());
    profile.downcast::<adw::Dialog>().unwrap().close();
    let current = peer.clone();
    crate::on_tokio(async move {
        current
            .change_profile(rv_core::native::store::ProfileOperation::Avatar {
                input: rv_core::native::profiles::AvatarCommand {
                    operation_id: rv_core::native::room_operation_id(),
                    expected_revision: own.profile.revision,
                },
                upload: None,
            })
            .await
            .unwrap()
    })
    .await;
    for _ in 0..100 {
        if super::find_by_class(window.window.upcast_ref(), "tile-header").is_some_and(|tile| !has_photo(&tile)) {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "native retired DM photo leaves existing GTK header",
        super::find_by_class(window.window.upcast_ref(), "tile-header").is_some_and(|tile| !has_photo(&tile)),
        (),
    );
    let grant = peer.store.read_state(&dm).unwrap().unwrap().membership_version;
    let (p, r, g) = (peer.clone(), dm.clone(), grant.clone());
    crate::runtime()
        .spawn(async move {
            p.set_typing_from_membership(&r, None, true, g.as_deref()).await.unwrap();
        })
        .await
        .unwrap();
    for _ in 0..120 {
        if window.chat.typing_text().is_some_and(|text| text.contains("mobile")) {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "native typing uses existing GTK label",
        window.chat.typing_text().is_some_and(|text| text.contains("mobile")),
        (),
    );
    window.chat.composer().set_text("GTK emits native typing");
    for _ in 0..120 {
        if peer.typing(&dm, None).iter().any(|u| u == "desktop") {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("existing GTK composer emits native typing", peer.typing(&dm, None).iter().any(|u| u == "desktop"), ());
    window.chat.composer().set_text("");
    for _ in 0..120 {
        if peer.typing(&dm, None).is_empty() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("empty GTK composer emits stop", peer.typing(&dm, None).is_empty(), ());
    let (p, r, g) = (peer.clone(), dm.clone(), grant);
    crate::runtime()
        .spawn(async move {
            p.set_typing_from_membership(&r, None, false, g.as_deref()).await.unwrap();
        })
        .await
        .unwrap();
    for _ in 0..120 {
        if window.chat.typing_text().is_none() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check("native GTK typing clears on stop", window.chat.typing_text().is_none(), ());
    session.suspend();
    for _ in 0..120 {
        if window.chat.header_presence().is_none() && window.chat.typing_text().is_none() {
            break;
        }
        glib::timeout_future(Duration::from_millis(50)).await;
    }
    check(
        "GTK loses ephemeral observations when suspended",
        window.chat.header_presence().is_none() && window.chat.typing_text().is_none(),
        (),
    );
    peer.shutdown();
}
