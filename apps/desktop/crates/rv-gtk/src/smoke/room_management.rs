//! Disposable-only traversal of the actual room forms at a narrow window size.
use super::{check, find_by_class};
use crate::{on_tokio, window::AppWindow};
use adw::prelude::*;
use gtk::glib;
use std::{rc::Rc, time::Duration};
pub(super) fn install(window: &Rc<AppWindow>) {
    let Ok(phase) = std::env::var("RV_SMOKE_ROOM_MANAGEMENT") else {
        return;
    };
    assert!(matches!(phase.as_str(), "settings" | "last-owner" | "roles" | "flow" | "favorites"));
    let weak = Rc::downgrade(window);
    let mut polls = 0;
    glib::timeout_add_local(Duration::from_millis(100), move || {
        let Some(window) = weak.upgrade() else {
            return glib::ControlFlow::Break;
        };
        polls += 1;
        if find_by_class(window.window.upcast_ref(), "native-room-edit").is_some() {
            let phase = phase.clone();
            glib::spawn_future_local(async move {
                run(window, phase).await;
            });
            return glib::ControlFlow::Break;
        }
        if polls >= 200 {
            check("room controls loaded", false, 0);
            return glib::ControlFlow::Break;
        }
        glib::ControlFlow::Continue
    });
}
async fn wait(root: &gtk::Widget, class: &str) -> gtk::Widget {
    for _ in 0..240 {
        if let Some(widget) = find_by_class(root, class)
            && widget.is_mapped()
        {
            return widget;
        }
        glib::timeout_future(Duration::from_millis(25)).await;
    }
    panic!("Room control did not become available: {class}");
}
async fn closed(root: &gtk::Widget, class: &str) {
    for _ in 0..240 {
        if find_by_class(root, class).is_none() {
            return;
        }
        glib::timeout_future(Duration::from_millis(25)).await;
    }
    panic!("Room control did not close: {class}");
}
fn named(root: &gtk::Widget, name: &str) -> Option<gtk::Widget> {
    if root.widget_name() == name {
        return Some(root.clone());
    }
    let mut child = root.first_child();
    while let Some(widget) = child {
        if let Some(found) = named(&widget, name) {
            return Some(found);
        }
        child = widget.next_sibling();
    }
    None
}
async fn role(root: &gtk::Widget, user: &str, selected: u32) {
    wait(root, "native-room-members").await.downcast::<gtk::Button>().unwrap().emit_clicked();
    let roster = wait(root, "native-room-roster").await;
    let mut group = None;
    for _ in 0..240 {
        group = named(&roster, &format!("native-room-member-{user}"));
        if group.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(25)).await;
    }
    let group = group.expect("Room member row did not load");
    find_by_class(&group, "native-room-role").and_downcast::<adw::ComboRow>().unwrap().set_selected(selected);
    find_by_class(&group, "native-room-role-apply").and_downcast::<gtk::Button>().unwrap().emit_clicked();
    closed(root, "native-room-roster").await;
}
async fn run(window: Rc<AppWindow>, phase: String) {
    let session = window.chat.native_session().unwrap();
    assert_eq!(session.info.base_url.trim_end_matches('/'), "http://rv-room-controls-server:3400");
    assert_eq!(session.info.username, "desktop");
    let name = std::env::var("RV_SMOKE_ROOM").unwrap();
    let rid = session.store.rooms().unwrap().into_iter().find(|room| room.name == name).unwrap().id;
    let root = window.window.upcast_ref::<gtk::Widget>();
    if phase == "favorites" {
        check(
            "GTK native room context menu installed",
            find_by_class(root, "native-room-favorite-context").is_some(),
            true,
        );
        let original = session.store.read_state(&rid).unwrap().unwrap();
        session.suspend();
        wait(root, "native-room-favorite-action").await.downcast::<gtk::Button>().unwrap().emit_clicked();
        wait(root, "native-room-favorite-resume").await;
        check(
            "GTK favorite is visibly pending while offline",
            !session.store.read_state(&rid).unwrap().unwrap().favorite
                && session.store.favorite_intent(&rid).unwrap().is_some(),
            true,
        );
        session.reconnect();
        for _ in 0..240 {
            if session.store.read_state(&rid).unwrap().is_some_and(|s| s.favorite)
                && session.store.favorite_intent(&rid).unwrap().is_none()
            {
                break;
            }
            glib::timeout_future(Duration::from_millis(25)).await;
        }
        check("GTK favorite confirmed by the server", session.store.read_state(&rid).unwrap().unwrap().favorite, true);
        check(
            "GTK stale preference click refuses to stage a different request",
            session
                .set_favorite_from_state(
                    &rid,
                    false,
                    original.membership_version.as_deref().unwrap(),
                    original.favorite_revision.as_deref().unwrap(),
                )
                .is_err(),
            true,
        );
        for _ in 0..240 {
            if let Some(button) = find_by_class(root, "native-room-favorite-action").and_downcast::<gtk::Button>()
                && button.is_sensitive()
                && button.label().as_deref() == Some(super::super::i18n::t("rooms.favorite_remove"))
            {
                button.emit_clicked();
                break;
            }
            glib::timeout_future(Duration::from_millis(25)).await;
        }
        for _ in 0..240 {
            if session.store.read_state(&rid).unwrap().is_some_and(|s| !s.favorite)
                && session.store.favorite_intent(&rid).unwrap().is_none()
            {
                break;
            }
            glib::timeout_future(Duration::from_millis(25)).await;
        }
        check(
            "GTK favorite removal confirmed",
            !session.store.read_state(&rid).unwrap().unwrap().favorite
                && session.store.favorite_intent(&rid).unwrap().is_none(),
            true,
        );
        eprintln!("smoke: native favorites completed");
        return;
    }
    if phase == "flow" {
        window.chat.composer().set_text("Draft belonging to the original membership");
    }
    if phase == "settings" || phase == "flow" {
        wait(root, "native-room-edit").await.downcast::<gtk::Button>().unwrap().emit_clicked();
        wait(root, "native-room-name").await.downcast::<adw::EntryRow>().unwrap().set_text("Salon réglé depuis GTK");
        for (class, value) in [
            ("native-room-topic", "Sujet depuis le formulaire GTK"),
            ("native-room-description", "Description conservée depuis la fiche existante."),
            ("native-room-announcement", "Annonce depuis GTK"),
        ] {
            wait(root, class).await.downcast::<gtk::TextView>().unwrap().buffer().set_text(value);
        }
        if phase == "flow" {
            wait(root, "native-room-read-only").await.downcast::<adw::SwitchRow>().unwrap().set_active(true);
        }
        wait(root, "native-room-save").await.downcast::<gtk::Button>().unwrap().emit_clicked();
        closed(root, "native-room-name").await;
        let (s, r) = (session.clone(), rid.clone());
        let details = on_tokio(async move { s.room_details(&r).await }).await.unwrap();
        check(
            "GTK room settings applied from existing form",
            details.room.name == "Salon réglé depuis GTK" && details.topic == "Sujet depuis le formulaire GTK",
            true,
        );
        if phase == "flow" {
            for _ in 0..240 {
                if window.chat.composer().root.is_visible() {
                    break;
                }
                glib::timeout_future(Duration::from_millis(25)).await;
            }
            check(
                "GTK read-only owner can compose",
                window.chat.composer().root.is_visible() && details.read_only,
                true,
            );
        }
    }
    if phase == "last-owner" {
        wait(root, "native-room-leave").await.downcast::<gtk::Button>().unwrap().emit_clicked();
        let alert = wait(root, "native-room-leave-confirm").await;
        find_by_class(&alert, "destructive-action").and_downcast::<gtk::Button>().unwrap().emit_clicked();
        closed(root, "native-room-leave-confirm").await;
        wait(root, "native-room-intention-clear").await;
        let saved = session.store.room_operation(&rid).unwrap().unwrap();
        check(
            "GTK last-owner rejection retains the request",
            saved.failed && saved.error.as_deref() == Some("last_room_owner"),
            true,
        );
    }
    if phase == "roles" || phase == "flow" {
        role(root, "mobile", 2).await;
        let (s, r) = (session.clone(), rid.clone());
        let page = on_tokio(async move { s.room_members(&r, None, None).await }).await.unwrap();
        check(
            "GTK promotes another owner",
            page.members.iter().filter(|m| m.role == rv_core::native::RoomRole::Owner).count() == 2,
            true,
        );
        if phase == "roles" {
            wait(root, "native-room-members").await.downcast::<gtk::Button>().unwrap().emit_clicked();
            wait(root, "native-room-roster").await;
        } else {
            role(root, "desktop", 0).await;
            for _ in 0..240 {
                if !window.chat.composer().root.is_visible() {
                    break;
                }
                glib::timeout_future(Duration::from_millis(25)).await;
            }
            check("GTK demoted read-only member cannot compose", !window.chat.composer().root.is_visible(), true);
            check(
                "GTK role changes preserve the open draft",
                window.chat.composer().text() == "Draft belonging to the original membership"
                    && session.store.draft(&rid).unwrap() == "Draft belonging to the original membership",
                true,
            );
            wait(root, "native-room-leave").await.downcast::<gtk::Button>().unwrap().emit_clicked();
            let alert = wait(root, "native-room-leave-confirm").await;
            find_by_class(&alert, "destructive-action").and_downcast::<gtk::Button>().unwrap().emit_clicked();
            closed(root, "native-room-leave-confirm").await;
            for _ in 0..240 {
                if !session.store.rooms().unwrap().iter().any(|room| room.id == rid) && !window.chat.shows_room() {
                    break;
                }
                glib::timeout_future(Duration::from_millis(25)).await;
            }
            check(
                "GTK departure removes its room and saved fields",
                !session.store.rooms().unwrap().iter().any(|room| room.id == rid)
                    && session.store.room_operation(&rid).unwrap().is_none(),
                true,
            );
            check(
                "GTK departure clears the open composer and private views",
                !window.chat.shows_room()
                    && window.chat.composer().text().is_empty()
                    && window.chat.message_count() == 0,
                true,
            );
            closed(root, "native-room-edit").await;
        }
    }
    eprintln!("smoke: native room controls completed");
}
