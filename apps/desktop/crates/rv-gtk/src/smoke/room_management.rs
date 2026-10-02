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
    assert!(matches!(phase.as_str(), "settings" | "last-owner" | "roles" | "flow"));
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
        wait(root, "native-room-save").await.downcast::<gtk::Button>().unwrap().emit_clicked();
        closed(root, "native-room-name").await;
        let (s, r) = (session.clone(), rid.clone());
        let details = on_tokio(async move { s.room_details(&r).await }).await.unwrap();
        check(
            "GTK room settings applied from existing form",
            details.room.name == "Salon réglé depuis GTK" && details.topic == "Sujet depuis le formulaire GTK",
            true,
        );
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
            wait(root, "native-room-leave").await.downcast::<gtk::Button>().unwrap().emit_clicked();
            let alert = wait(root, "native-room-leave-confirm").await;
            find_by_class(&alert, "destructive-action").and_downcast::<gtk::Button>().unwrap().emit_clicked();
            closed(root, "native-room-leave-confirm").await;
            for _ in 0..240 {
                if !session.store.rooms().unwrap().iter().any(|room| room.id == rid) {
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
        }
    }
    eprintln!("smoke: native room controls completed");
}
