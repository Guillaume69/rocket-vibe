//! Unattended end-to-end run, driven by environment variables:
//!   RV_SMOKE_LOGIN  "server|user|password"
//!   RV_SMOKE_ROOM   room name to open once the room list is loaded
//!   RV_SMOKE_SEND   text to send in that room
//!   RV_SMOKE_SHOT   PNG path; the window is rendered after RV_SMOKE_DELAY_MS, then the app quits
//!   RV_SMOKE_EXPECT        `|`-separated texts the open room must show by then
//!   RV_SMOKE_EXPECT_ABSENT `|`-separated texts it must NOT show
//!   RV_SMOKE_SIZE          `WIDTHxHEIGHT` of the window
//!   RV_SMOKE_COMPOSER=1    checks the composer: no window handle around it, a scrollbar
//!                          only once it overflows, one line high when short
//!   RV_SMOKE_ACTIONS=<tag>  reacts to bob's last message, quotes it, edits my last one,
//!                          replies in a thread, then opens the actions menu; texts carry <tag>
//!   RV_SMOKE_DRAFTS=<other room>  completes `@bo` and `:smil`, leaves a draft, opens the
//!                          other room and comes back: the draft must be restored
//!   RV_SMOKE_FILES=1       fetches every file attached in the room to the local cache
//!   RV_SMOKE_UPLOAD="<path>|<caption>"  sends the file as the dialog's Send does, images reduced
//!   RV_SMOKE_SPOTLIGHT=<query>  finds a channel, joins it and opens it
//!   RV_SMOKE_DETAILS=profile:<user> | room | search:<text> | settings  checks the read and opens the dialog
//!   RV_SMOKE_NOTIFY=<reply>  stands in for the desktop's notification server (inline reply
//!                          included), and answers the first notification with <reply>
//!   RV_SMOKE_SECOND="<user>|<password>"  adds a second account on the same server,
//!                          then switches back to the first
//!   RV_SMOKE_E2E=<password>  unlocks encrypted rooms (a wrong one first must be refused)
//!   RV_SMOKE_REENTER=1     after opening the room: back to the list, tap the same room, expect it open
//! A failed expectation makes the process exit with status 1.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use adw::prelude::*;
use gtk::glib;

use crate::window::AppWindow;

static FAILED: AtomicBool = AtomicBool::new(false);

pub fn failed() -> bool {
    FAILED.load(Ordering::SeqCst)
}

fn list(var: &str) -> Vec<String> {
    std::env::var(var).unwrap_or_default().split('|').filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

pub fn install_early() {
    if let Ok(reply) = std::env::var("RV_SMOKE_NOTIFY")
        && !reply.is_empty()
    {
        fake_notification_server(reply);
    }
}

pub fn install(window: &Rc<AppWindow>) {
    let login = std::env::var("RV_SMOKE_LOGIN").unwrap_or_default();
    let room = std::env::var("RV_SMOKE_ROOM").unwrap_or_default();
    let text = std::env::var("RV_SMOKE_SEND").unwrap_or_default();
    let shot = std::env::var("RV_SMOKE_SHOT").unwrap_or_default();
    let parts: Vec<String> = login.split('|').map(str::to_owned).collect();
    let server = parts.first().cloned().unwrap_or_default();
    if let Some((w, h)) = std::env::var("RV_SMOKE_SIZE").ok().and_then(|s| {
        let (w, h) = s.split_once('x')?;
        Some((w.parse().ok()?, h.parse().ok()?))
    }) {
        window.window.set_default_size(w, h);
    }

    if parts.len() == 3 {
        let weak = Rc::downgrade(window);
        let tried = Rc::new(Cell::new(false));
        window.connect_login_shown(move || {
            let Some(w) = weak.upgrade() else { return };
            if !tried.replace(true) {
                w.login.fill(&parts[0], &parts[1], &parts[2]);
                glib::idle_add_local_once(move || w.submit_login());
            }
        });
    }

    if let Some((user, password)) = std::env::var("RV_SMOKE_SECOND").ok().and_then(|s| {
        let (u, p) = s.split_once('|')?;
        Some((u.to_owned(), p.to_owned()))
    }) && !server.is_empty()
    {
        second_account(window, server, user, password);
    }

    if !room.is_empty() {
        let weak = Rc::downgrade(window);
        let opened = Rc::new(Cell::new(false));
        window.chat.connect_rooms_loaded(move || {
            let Some(w) = weak.upgrade() else { return };
            if opened.get() {
                return;
            }
            let Some(rid) = w.chat.room_named(&room) else { return };
            opened.set(true);
            w.chat.open_room(&rid);
            if std::env::var("RV_SMOKE_COMPOSER").as_deref() == Ok("1") {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(2000), move || composer_checks(chat));
            }
            if let Ok(tag) = std::env::var("RV_SMOKE_ACTIONS")
                && !tag.is_empty()
            {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(3000), move || action_checks(chat, tag));
            }
            if let Ok(other) = std::env::var("RV_SMOKE_DRAFTS")
                && let Some(other) = w.chat.room_named(&other)
            {
                let chat = w.chat.clone();
                let back = rid.clone();
                glib::timeout_add_local_once(Duration::from_millis(2000), move || draft_checks(chat, back, other));
            }
            if std::env::var("RV_SMOKE_FILES").as_deref() == Ok("1") {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(2000), move || file_checks(chat));
            }
            if let Ok(spec) = std::env::var("RV_SMOKE_UPLOAD")
                && let Some((path, caption)) = spec.split_once('|')
                && let Some(session) = w.chat.session()
            {
                let item = crate::attach::Picked { path: path.into(), name: "stripes.png".into(), temporary: false };
                let mime = crate::attach::mime_of(&item.path);
                let (rid, caption) = (rid.clone(), caption.to_owned());
                let toast: std::rc::Rc<dyn Fn(String)> = std::rc::Rc::new(|text| {
                    println!("smoke: upload refused: {text}");
                    FAILED.store(true, Ordering::SeqCst);
                });
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    crate::attach::send_all(session, rid, vec![(item, mime)], caption, true, toast)
                });
            }
            if let Ok(query) = std::env::var("RV_SMOKE_SPOTLIGHT")
                && !query.is_empty()
                && let Some(session) = w.chat.session()
            {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    glib::spawn_future_local(async move {
                        let q = query.clone();
                        let found =
                            crate::on_tokio(async move { session.spotlight(&q).await }).await.unwrap_or_default();
                        let room = found
                            .into_iter()
                            .find(|f| matches!(f, rv_core::rooms::Found::Room { name, .. } if *name == query));
                        check("spotlight finds the channel", room.is_some(), &room);
                        if let Some(room) = room {
                            chat.go_to(room);
                        }
                    });
                });
            }
            if let Ok(what) = std::env::var("RV_SMOKE_DETAILS")
                && !what.is_empty()
                && let Some(session) = w.chat.session()
            {
                let (chat, rid) = (w.chat.clone(), rid.clone());
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    details_checks(chat, session, rid, what)
                });
            }
            if let Ok(password) = std::env::var("RV_SMOKE_E2E")
                && !password.is_empty()
                && let Some(session) = w.chat.session()
            {
                glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                    glib::spawn_future_local(async move {
                        let s = session.clone();
                        let wrong = crate::on_tokio(async move { s.e2e_unlock("not the password").await }).await;
                        check("wrong E2E password refused", wrong.is_err(), &wrong);
                        let s = session.clone();
                        let right = crate::on_tokio(async move { s.e2e_unlock(&password).await }).await;
                        check("E2E unlocked", right.is_ok(), &right);
                    });
                });
            }
            if std::env::var("RV_SMOKE_REENTER").as_deref() == Ok("1") {
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(2500), move || {
                    chat.go_back();
                    let shown_after_back = chat.shows_room();
                    chat.tap_room(&rid);
                    let reopened = chat.shows_room();
                    println!("smoke: reenter back={shown_after_back} reopened={reopened}");
                    if shown_after_back || !reopened {
                        FAILED.store(true, Ordering::SeqCst);
                    }
                });
            }
            if !text.is_empty() {
                let text = text.clone();
                let chat = w.chat.clone();
                glib::timeout_add_local_once(Duration::from_millis(1500), move || chat.send_text(&text));
            }
        });
    }

    if shot.is_empty() {
        return;
    }
    let delay = std::env::var("RV_SMOKE_DELAY_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(8000);
    let weak = Rc::downgrade(window);
    glib::timeout_add_local_once(Duration::from_millis(delay), move || {
        let Some(w) = weak.upgrade() else { return };
        println!("smoke: rooms {} messages {}", w.chat.room_count(), w.chat.message_count());
        println!("smoke: composer {:?}", w.chat.composer().text());
        println!(
            "smoke: typing {:?} presence {:?} new-marker {}",
            w.chat.typing_text(),
            w.chat.header_presence(),
            w.chat.has_new_marker()
        );
        let texts = w.chat.message_texts();
        for wanted in list("RV_SMOKE_EXPECT") {
            let found = texts.iter().filter(|t| t.contains(&wanted)).count();
            println!(
                "smoke: expect {wanted:?}: {}",
                if found == 1 { "ok".to_owned() } else { format!("FAILED ({found} found)") }
            );
            if found != 1 {
                FAILED.store(true, Ordering::SeqCst);
            }
        }
        for unwanted in list("RV_SMOKE_EXPECT_ABSENT") {
            let found = texts.iter().any(|t| t.contains(&unwanted));
            println!("smoke: absent {unwanted:?}: {}", if found { "FAILED" } else { "ok" });
            if found {
                FAILED.store(true, Ordering::SeqCst);
            }
        }
        let width = w.window.width();
        let height = w.window.height();
        let paintable = gtk::WidgetPaintable::new(Some(&w.window));
        let snapshot = gtk::Snapshot::new();
        paintable.snapshot(&snapshot, width as f64, height as f64);
        let saved = snapshot
            .to_node()
            .zip(w.window.renderer())
            .map(|(node, renderer)| renderer.render_texture(&node, None).save_to_png(&shot).is_ok());
        println!("smoke: screenshot saved {}", saved.unwrap_or(false));
        w.window.application().expect("application").quit();
    });
}

type Check = Box<dyn FnOnce(&Rc<crate::chat::ChatPage>)>;

/// Runs the steps one after another, a beat apart, so the view relayouts between them.
fn in_sequence(chat: std::rc::Rc<crate::chat::ChatPage>, mut steps: std::collections::VecDeque<Check>) {
    let Some(step) = steps.pop_front() else { return };
    step(&chat);
    glib::timeout_add_local_once(Duration::from_millis(40), move || in_sequence(chat, steps));
}

fn composer_state(label: &str, chat: &crate::chat::ChatPage, want_bar: bool, max_height: i32) {
    let (height, bar, offset) = chat.composer().scroll_state();
    let ok = bar == want_bar && height <= max_height && (want_bar || offset == 0.0);
    println!(
        "smoke: composer {label}: {height}px scrollbar={bar} offset={offset} {}",
        if ok { "ok" } else { "FAILED" }
    );
    if !ok {
        FAILED.store(true, Ordering::SeqCst);
    }
}

/// The composer: no window handle around it; typed text that wraps grows it
/// without scrolling; past 160 px it scrolls, with a scrollbar; back to one line.
fn composer_checks(chat: std::rc::Rc<crate::chat::ChatPage>) {
    let handle = chat.composer().in_window_handle();
    println!("smoke: composer in window handle: {handle}");
    if handle {
        FAILED.store(true, Ordering::SeqCst);
    }
    let mut steps: std::collections::VecDeque<Check> = std::collections::VecDeque::new();
    steps.push_back(Box::new(|c| c.composer().set_text("")));
    for i in 0..132 {
        let key = if i % 11 == 10 { " " } else { "a" };
        steps.push_back(Box::new(move |c| c.composer().type_text(key)));
    }
    for _ in 0..5 {
        steps.push_back(Box::new(|_| {}));
    }
    steps.push_back(Box::new(|c| composer_state("two lines typed", c, false, 44)));
    for _ in 0..12 {
        steps.push_back(Box::new(|c| c.composer().type_text("\nanother line")));
    }
    for _ in 0..5 {
        steps.push_back(Box::new(|_| {}));
    }
    steps.push_back(Box::new(|c| composer_state("overflowing", c, true, 170)));
    steps.push_back(Box::new(|c| c.composer().set_text("hi")));
    for _ in 0..5 {
        steps.push_back(Box::new(|_| {}));
    }
    steps.push_back(Box::new(|c| composer_state("one line", c, false, 40)));
    steps.push_back(Box::new(|c| c.composer().set_text(&"aaaaaaaaaa ".repeat(12))));
    in_sequence(chat, steps);
}

/// Plays the message actions the way clicks would, on the latest messages.
fn action_checks(chat: std::rc::Rc<crate::chat::ChatPage>, tag: String) {
    use crate::rows::RowEvent;
    let (Some(session), Some(rid)) = (chat.session(), chat.current_rid()) else { return };
    let rows = session.store.messages(&rid, 200);
    let theirs = rows.iter().rev().find(|r| r.author.as_deref() == Some("bob") && r.system_type.is_none()).cloned();
    let mine = rows.iter().rev().find(|r| r.author_id == session.info.user_id && r.system_type.is_none()).cloned();
    let root = rows.iter().rev().find(|r| r.thread_count > 0).cloned();
    println!(
        "smoke: actions on bob={:?} mine={:?} thread={:?}",
        theirs.as_ref().map(|r| &r.id),
        mine.as_ref().map(|r| &r.id),
        root.as_ref().map(|r| &r.id)
    );
    let Some(theirs) = theirs else { return FAILED.store(true, Ordering::SeqCst) };
    chat.play(RowEvent::React { id: theirs.id.clone(), shortcode: ":+1:".into(), add: true }, false);
    chat.start_quote(theirs.clone());
    let quoted = chat.clone();
    let reply = format!("{tag} reply");
    glib::timeout_add_local_once(Duration::from_millis(800), move || {
        quoted.composer().set_text(&reply);
        quoted.composer().submit_now();
    });
    if let Some(mine) = mine {
        let (s, rid, text) = (session.clone(), rid.clone(), format!("{tag} edited"));
        crate::runtime().spawn(async move {
            let _ = s.edit(&rid, &mine.id, &text).await;
        });
    }
    if let Some(root) = root {
        let (threaded, text) = (chat.clone(), format!("{tag} in thread"));
        glib::timeout_add_local_once(Duration::from_millis(1600), move || {
            threaded.open_thread_of(&root.id);
            glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                if let Some(thread) = threaded.thread() {
                    thread.composer.set_text(&text);
                    thread.composer.submit_now();
                }
            });
        });
    }
    let menu = chat.clone();
    glib::timeout_add_local_once(Duration::from_millis(6500), move || {
        if let Some(thread) = menu.thread() {
            println!("smoke: thread shows {} message(s): {:?}", thread.list.len(), thread.list.texts().last());
        }
    });
}

fn check(label: &str, ok: bool, detail: impl std::fmt::Debug) {
    println!("smoke: {label}: {detail:?} {}", if ok { "ok" } else { "FAILED" });
    if !ok {
        FAILED.store(true, Ordering::SeqCst);
    }
}

/// Completion, then a draft kept across a room switch.
fn draft_checks(chat: std::rc::Rc<crate::chat::ChatPage>, back: String, other: String) {
    let mut steps: std::collections::VecDeque<Check> = std::collections::VecDeque::new();
    steps.push_back(Box::new(|c| {
        c.composer().set_text("");
        c.composer().type_text("hi @bo");
    }));
    steps.push_back(Box::new(|c| {
        let offered = c.composer().offered();
        check("mention offered", offered.first().is_some_and(|o| o == "@bob"), &offered);
        c.composer().accept_first();
        check("mention inserted", c.composer().text() == "hi @bob ", c.composer().text());
        c.composer().type_text(":smil");
    }));
    steps.push_back(Box::new(|c| {
        let offered = c.composer().offered();
        check("emoji offered", !offered.is_empty(), &offered);
        c.composer().accept_first();
        let text = c.composer().text();
        check("emoji inserted", !text.contains(':') && text.len() > "hi @bob ".len(), &text);
        c.composer().type_text("draft kept");
    }));
    for _ in 0..15 {
        steps.push_back(Box::new(|_| {}));
    }
    steps.push_back(Box::new(move |c| {
        let kept = c.composer().text();
        c.open_room(&other);
        check("other room starts empty", c.composer().text().is_empty(), c.composer().text());
        c.open_room(&back);
        check("draft restored", c.composer().text() == kept, c.composer().text());
        c.composer().set_text("");
    }));
    in_sequence(chat, steps);
}

fn file_checks(chat: std::rc::Rc<crate::chat::ChatPage>) {
    let (Some(session), Some(rid)) = (chat.session(), chat.current_rid()) else { return };
    let files: Vec<_> = session
        .store
        .messages(&rid, 200)
        .iter()
        .flat_map(|r| rv_core::content::files(r.attachments.as_deref()))
        .collect();
    check("files attached", !files.is_empty(), files.len());
    glib::spawn_future_local(async move {
        for f in files {
            let path = crate::cards::local_copy(session.clone(), f.clone()).await;
            let size = path.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len() as i64);
            check(&format!("file {}", f.title), size.is_some() && (f.size.is_none() || size == f.size), size);
        }
    });
}

fn details_checks(
    chat: std::rc::Rc<crate::chat::ChatPage>,
    session: std::sync::Arc<rv_core::session::Session>,
    rid: String,
    what: String,
) {
    glib::spawn_future_local(async move {
        if let Some(user) = what.strip_prefix("profile:") {
            let (s, u) = (session.clone(), user.to_owned());
            let p = crate::on_tokio(async move { s.profile(&u, false).await }).await;
            check("profile read", p.as_ref().is_ok_and(|p| p.username == user), p.as_ref().map(|p| &p.username));
            chat.show_profile(user, false);
        } else if what == "room" {
            let (s, r) = (session.clone(), rid.clone());
            let info = crate::on_tokio(async move { s.room_info(&r).await }).await;
            check("room info read", info.as_ref().is_ok_and(|i| i.members.is_some()), info.as_ref().map(|i| i.members));
            chat.show_room_info();
        } else if what == "settings" {
            let s = session.clone();
            let round = crate::on_tokio(async move {
                let before = s.me().await?;
                s.set_status("away", "smoke test").await?;
                s.set_preference("desktopNotifications", serde_json::json!("mention")).await?;
                let after = s.me().await?;
                s.set_status(&before.status, &before.status_text).await?;
                s.set_preference("desktopNotifications", serde_json::json!(before.desktop_notifications)).await?;
                Ok::<_, rv_core::rest::RestError>(after)
            })
            .await;
            check(
                "status and preference saved",
                round.as_ref().is_ok_and(|m| {
                    m.status == "away" && m.status_text == "smoke test" && m.desktop_notifications == "mention"
                }),
                round.as_ref().map(|m| (m.status.clone(), m.desktop_notifications.clone())),
            );
            crate::settings::open(chat.widget(), session, None, || {});
        } else if let Some(text) = what.strip_prefix("search:") {
            let (s, r, q) = (session.clone(), rid.clone(), text.to_owned());
            let hits = crate::on_tokio(async move { s.search(&r, &q).await }).await.unwrap_or_default();
            check("search finds", hits.iter().any(|m| m.text.as_deref().is_some_and(|t| t.contains(text))), hits.len());
            crate::details::search(chat.widget(), session, &rid);
        }
    });
}

const NOTIFICATIONS_XML: &str = r#"<node><interface name="org.freedesktop.Notifications">
  <method name="GetCapabilities"><arg type="as" direction="out"/></method>
  <method name="Notify"><arg type="s"/><arg type="u"/><arg type="s"/><arg type="s"/><arg type="s"/>
    <arg type="as"/><arg type="a{sv}"/><arg type="i"/><arg type="u" direction="out"/></method>
  <method name="CloseNotification"><arg type="u"/></method>
</interface></node>"#;

/// Owns `org.freedesktop.Notifications` on the session bus, prints each
/// notification, and replies inline to the first one.
fn fake_notification_server(reply: String) {
    use gtk::gio;
    let Ok(connection) = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>) else {
        println!("smoke: no session bus");
        return FAILED.store(true, Ordering::SeqCst);
    };
    let info = gio::DBusNodeInfo::for_xml(NOTIFICATIONS_XML).expect("introspection");
    let interface = info.lookup_interface("org.freedesktop.Notifications").expect("interface");
    let replied = Cell::new(false);
    let registration = connection
        .register_object("/org/freedesktop/Notifications", &interface)
        .method_call(move |connection, _, _, _, method, parameters, invocation| match method {
            "GetCapabilities" => {
                invocation.return_value(Some(&(vec!["body", "actions", "inline-reply"],).to_variant()))
            }
            "Notify" => {
                let summary = parameters.child_value(3).get::<String>().unwrap_or_default();
                let body = parameters.child_value(4).get::<String>().unwrap_or_default();
                let actions = parameters.child_value(5).get::<Vec<String>>().unwrap_or_default();
                println!(
                    "smoke: notification {summary:?} {body:?} inline-reply={}",
                    actions.iter().any(|a| a == "inline-reply")
                );
                invocation.return_value(Some(&(7u32,).to_variant()));
                if !replied.replace(true) {
                    let (connection, reply) = (connection.clone(), reply.clone());
                    glib::timeout_add_local_once(Duration::from_millis(300), move || {
                        let _ = connection.emit_signal(
                            None,
                            "/org/freedesktop/Notifications",
                            "org.freedesktop.Notifications",
                            "NotificationReplied",
                            Some(&(7u32, reply).to_variant()),
                        );
                    });
                }
            }
            _ => invocation.return_value(None),
        })
        .build();
    if registration.is_err() {
        println!("smoke: could not serve notifications");
        return FAILED.store(true, Ordering::SeqCst);
    }
    let _ = connection.call_sync(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "RequestName",
        Some(&("org.freedesktop.Notifications", 4u32).to_variant()),
        None,
        gio::DBusCallFlags::NONE,
        2000,
        None::<&gio::Cancellable>,
    );
}

/// First account loaded → add the second → it loads → back to the first.
fn second_account(window: &Rc<AppWindow>, server: String, user: String, password: String) {
    let step = Rc::new(Cell::new(0u8));
    let first: Rc<std::cell::RefCell<Option<rv_core::session::SessionInfo>>> = Rc::default();
    let weak = Rc::downgrade(window);
    window.chat.connect_rooms_loaded(move || {
        let Some(w) = weak.upgrade() else { return };
        let Some(session) = w.chat.session() else { return };
        match step.get() {
            0 => {
                step.set(1);
                first.replace(Some(session.info.clone()));
                let (w, server, user, password) = (w.clone(), server.clone(), user.clone(), password.clone());
                glib::timeout_add_local_once(Duration::from_millis(1000), move || {
                    w.add_account();
                    w.login.fill(&server, &user, &password);
                    w.submit_login();
                });
            }
            1 if session.info.username == user => {
                step.set(2);
                check("second account signed in", true, &session.info.username);
                let (w, first) = (w.clone(), first.borrow().clone());
                glib::timeout_add_local_once(Duration::from_millis(1000), move || {
                    if let Some(first) = first {
                        w.switch_to(first);
                    }
                });
            }
            2 if Some(&session.info.username) == first.borrow().as_ref().map(|f| &f.username) => {
                step.set(3);
                check("switched back", w.chat.room_count() > 0, &session.info.username);
            }
            _ => {}
        }
    });
}
