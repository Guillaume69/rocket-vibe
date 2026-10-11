//! `RV_SMOKE_REMINDERS=<other room>` with `RV_SMOKE_ROOM`: "Remind me" end to
//! end on a Rocket.Chat, Mattermost or kChat account. The smoke serves
//! `org.freedesktop.Notifications` itself (unless `RV_SMOKE_NOTIFY` does) and
//! records what it is asked to show.
//!
//! 1. The open room's last message: its menu offers "Remind me", whose "In 1
//!    hour" stores a reminder an hour ahead; the menu then offers "Cancel
//!    reminder", which removes it.
//! 2. One reminder 8 days late (an app that was not running) and one 4 s ahead,
//!    set the way the menu sets them but past the one-minute minimum of "Pick
//!    a time" (the smoke's only shortcut): the late one is dropped without a
//!    word, the other fires once as a "Reminder" notification naming the room
//!    and the excerpt, and leaves the store.
//! 3. From <other room>, a click on that notification opens the room on the
//!    message.
//! 4. The Reminders list shows a pending one; its Cancel removes it.
//! 5. Removing the account removes its reminders.
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use adw::prelude::*;
use gtk::{gio, glib};

use super::{FAILED, NOTIFICATIONS_XML, check, find_by_class};
use crate::window::AppWindow;
use std::sync::atomic::Ordering;

thread_local! {
    /// (id, summary, body) of each notification the smoke was asked to show.
    static SHOWN: RefCell<Vec<(u32, String, String)>> = const { RefCell::new(Vec::new()) };
    static BUS: RefCell<Option<gio::DBusConnection>> = const { RefCell::new(None) };
}

fn wanted() -> Option<String> {
    std::env::var("RV_SMOKE_REMINDERS").ok().filter(|v| !v.is_empty())
}

/// Before the window: the notifier asks the server's capabilities at once.
pub(super) fn install_early() {
    if wanted().is_none() || std::env::var("RV_SMOKE_NOTIFY").is_ok_and(|v| !v.is_empty()) {
        return;
    }
    let Ok(connection) = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>) else {
        println!("smoke: no session bus");
        return FAILED.store(true, Ordering::SeqCst);
    };
    let info = gio::DBusNodeInfo::for_xml(NOTIFICATIONS_XML).expect("introspection");
    let interface = info.lookup_interface("org.freedesktop.Notifications").expect("interface");
    let registration = connection
        .register_object("/org/freedesktop/Notifications", &interface)
        .method_call(move |_, _, _, _, method, parameters, invocation| match method {
            "GetCapabilities" => invocation.return_value(Some(&(vec!["body", "actions"],).to_variant())),
            "GetServerInformation" => {
                invocation.return_value(Some(&("smoke-notifications", "rocket-vibe", "1.0", "1.2").to_variant()))
            }
            "Notify" => {
                let summary = parameters.child_value(3).get::<String>().unwrap_or_default();
                let body = parameters.child_value(4).get::<String>().unwrap_or_default();
                let id = SHOWN.with_borrow_mut(|shown| {
                    let id = 100 + shown.len() as u32;
                    shown.push((id, summary.clone(), body.clone()));
                    id
                });
                println!("smoke: notification {id} {summary:?} {body:?}");
                invocation.return_value(Some(&(id,).to_variant()));
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
    BUS.with_borrow_mut(|bus| *bus = Some(connection));
}

pub(super) fn install(window: &Rc<AppWindow>) {
    let Some(other) = wanted() else { return };
    let weak = Rc::downgrade(window);
    let mut polls = 0;
    glib::timeout_add_local(Duration::from_millis(250), move || {
        let Some(window) = weak.upgrade() else { return glib::ControlFlow::Break };
        polls += 1;
        let loaded = window.chat.current_rid().is_some() && window.chat.room_list().len() > 0;
        if loaded {
            // The history settles first.
            let (window, other) = (window.clone(), other.clone());
            glib::timeout_add_local_once(Duration::from_millis(3000), move || {
                glib::spawn_future_local(run(window, other));
            });
            return glib::ControlFlow::Break;
        }
        if polls > 240 {
            check("reminders: the room opened", false, window.chat.current_rid());
            std::process::exit(1)
        }
        glib::ControlFlow::Continue
    });
}

async fn wait(ms: u64) {
    glib::timeout_future(Duration::from_millis(ms)).await;
}

/// Opens the message's menu and answers its reminder entry, once built.
async fn reminder_entry(window: &Rc<AppWindow>, row: &rv_core::store::MessageRow) -> Option<gtk::Button> {
    let anchor: gtk::Widget = window.chat.widget().clone().upcast();
    let event = crate::rows::RowEvent::Menu {
        row: Box::new(row.clone()),
        anchor: anchor.clone(),
        x: 320.0,
        y: 240.0,
        link: None,
    };
    window.chat.play(event, false);
    for _ in 0..40 {
        wait(250).await;
        if let Some(button) = find_by_class(&anchor, "reminder-action").and_downcast::<gtk::Button>()
            && button.is_mapped()
        {
            return Some(button);
        }
    }
    None
}

fn label_of(button: &gtk::Button) -> String {
    button.child().and_downcast::<gtk::Label>().map(|l| l.label().to_string()).unwrap_or_default()
}

async fn run(window: Rc<AppWindow>, other: String) {
    checks(&window, other).await;
    println!("smoke: reminders done");
    wait(500).await;
    if let Some(app) = window.window.application() {
        app.quit();
    }
}

async fn checks(window: &Rc<AppWindow>, other: String) {
    let chat = window.chat.clone();
    let (Some(info), Some(rid)) = (chat.chat().map(|c| c.info().clone()), chat.current_rid()) else {
        return check("reminders: an account and a room", false, ());
    };
    let Some(session) = chat.session() else { return check("reminders: a Rocket.Chat session", false, ()) };
    let store = crate::reminders::store();
    store.remove_account(&info);
    let rows: Vec<_> = session
        .store
        .messages(&rid, 200)
        .into_iter()
        .filter(|r| crate::reminders::offered(r) && r.thread_id.is_none())
        .collect();
    let (Some(last), Some(earlier)) = (rows.last().cloned(), rows.iter().rev().nth(1).cloned()) else {
        return check("reminders: two messages in the room", false, rows.len());
    };
    let name = window.chat.current_name();
    println!("smoke: reminders on {} in {name:?}", last.id);

    // 1. The menu sets, then cancels.
    let Some(entry) = reminder_entry(window, &last).await else {
        return check("reminders: the message menu offers Remind me", false, ());
    };
    check(
        "reminders: the entry says Remind me",
        label_of(&entry) == crate::i18n::t("reminders.remind_me"),
        label_of(&entry),
    );
    entry.emit_clicked();
    wait(300).await;
    let anchor: gtk::Widget = chat.widget().clone().upcast();
    let Some(in_hour) = find_by_class(&anchor, "reminder-choice").and_downcast::<gtk::Button>() else {
        return check("reminders: the choices show", false, ());
    };
    in_hour.emit_clicked();
    wait(300).await;
    let now = chrono::Utc::now().timestamp();
    let set = store.get(&info, &last.id);
    check(
        "reminders: In 1 hour stores one an hour ahead",
        set.as_ref().is_some_and(|r| (r.due - now - 3600).abs() < 30 && r.rid == rid),
        &set,
    );
    let Some(entry) = reminder_entry(window, &last).await else {
        return check("reminders: the menu again", false, ());
    };
    let label = label_of(&entry);
    check(
        "reminders: the menu offers Cancel reminder with its time",
        label.starts_with(crate::i18n::t("reminders.cancel_reminder")) && label.contains(':'),
        &label,
    );
    entry.emit_clicked();
    wait(300).await;
    check("reminders: Cancel reminder removes it", store.get(&info, &last.id).is_none(), ());

    // 2. A late one dropped, a near one fired once.
    let draft = |row: &rv_core::store::MessageRow| crate::reminders::Draft::of(row, &name);
    let stale = rv_core::reminders::Reminder::about(
        &rid,
        &name,
        &earlier.id,
        None,
        "x",
        earlier.text.as_deref(),
        false,
        now - 8 * 24 * 3600,
        now - 9 * 24 * 3600,
    );
    let _ = store.set(&info, stale);
    let toast: Rc<dyn Fn(String)> = Rc::new(|text| println!("smoke: reminders toast {text:?}"));
    let before = SHOWN.with_borrow(Vec::len);
    crate::reminders::set(&info, &draft(&last), now + 4, &toast);
    check("reminders: the late one is dropped at once", store.get(&info, &earlier.id).is_none(), ());
    check("reminders: the near one waits", store.get(&info, &last.id).is_some(), ());
    let mut fired = None;
    for _ in 0..40 {
        wait(250).await;
        fired = SHOWN
            .with_borrow(|shown| shown[before..].iter().find(|(_, s, _)| s == rv_core::reminders::title()).cloned());
        if fired.is_some() {
            break;
        }
    }
    let excerpt = rv_core::reminders::excerpt(last.text.as_deref(), last.attachments.is_some());
    check(
        "reminders: a Reminder notification names the room and the excerpt",
        fired.as_ref().is_some_and(|(_, _, body)| {
            body.contains(&name) && body.contains(&glib::markup_escape_text(&excerpt).to_string())
        }),
        &fired,
    );
    check("reminders: a fired one leaves the store", store.pending(&info).is_empty(), store.pending(&info));
    wait(1500).await;
    let reminders_shown =
        SHOWN.with_borrow(|shown| shown[before..].iter().filter(|(_, s, _)| s == rv_core::reminders::title()).count());
    check("reminders: fired once, the late one never", reminders_shown == 1, reminders_shown);

    // 3. Its click opens the message, from another room.
    if let Some((id, _, _)) = fired {
        if let Some(elsewhere) = chat.room_named(&other) {
            chat.open_room(&elsewhere);
            wait(1500).await;
        }
        if let Some(bus) = BUS.with_borrow(Clone::clone) {
            let _ = bus.emit_signal(
                None,
                "/org/freedesktop/Notifications",
                "org.freedesktop.Notifications",
                "ActionInvoked",
                Some(&(id, "default").to_variant()),
            );
        }
        wait(1200).await;
        let (open, revealed) = (chat.current_rid(), chat.room_list().holds_reveal());
        check(
            "reminders: the notification's click opens the room on its message",
            open.as_deref() == Some(&rid) && revealed,
            (open, revealed),
        );
    }

    // 4. The list cancels.
    crate::reminders::set(&info, &draft(&last), now + 7200, &toast);
    let Some(dialog) = chat.open_reminders() else { return check("reminders: the list opens", false, ()) };
    wait(500).await;
    let root: gtk::Widget = dialog.clone().upcast();
    check("reminders: the list shows the pending one", find_by_class(&root, "reminder-row").is_some(), ());
    if let Some(cancel) = find_by_class(&root, "reminder-cancel").and_downcast::<gtk::Button>() {
        cancel.emit_clicked();
    }
    wait(300).await;
    check("reminders: the list's Cancel removes it", store.pending(&info).is_empty(), ());
    check("reminders: the list then says none", find_by_class(&root, "reminders-empty").is_some(), ());
    dialog.close();

    // 5. Signing out takes them along.
    crate::reminders::set(&info, &draft(&last), now + 7200, &toast);
    crate::reminders::forget(&info);
    check("reminders: removing the account removes its reminders", store.pending(&info).is_empty(), ());
}
