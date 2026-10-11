//! Native controls driven against a local command-preview fixture or live app.
use super::{check, find_by_class, find_named};
use adw::prelude::*;
use gtk::glib;
use std::{rc::Rc, time::Duration};

pub async fn run(chat: Rc<crate::chat::ChatPage>) {
    let composer = chat.composer_rc();
    composer.set_text("");
    composer.grab_focus();
    composer.type_text("/giphy wave");
    let mut dialog = None;
    for _ in 0..50 {
        dialog = composer.gif_picker();
        if dialog.is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    check("typing /giphy opens the GIF picker without submitting", dialog.is_some(), ());
    let Some(d) = dialog else { return };
    let Some(q) = find_named(d.upcast_ref(), "gif-search").and_downcast::<gtk::Entry>() else { return };
    let Some(send) = find_named(d.upcast_ref(), "gif-send").and_downcast::<gtk::Button>() else { return };
    let Some(grid) = find_named(d.upcast_ref(), "gif-grid").and_downcast::<gtk::FlowBox>() else { return };
    let first =
        |grid: &gtk::FlowBox| find_by_class(grid.upcast_ref(), "gif-choice").and_downcast::<gtk::ToggleButton>();
    for _ in 0..100 {
        if first(&grid).is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    let Some(choice) = first(&grid) else {
        check("GIF results render", false, ());
        return;
    };
    check("Send waits for selection", !send.is_sensitive(), ());
    choice.set_active(true);
    check(
        "selection enables Send and keeps the draft",
        send.is_sensitive() && composer.text() == "/giphy wave",
        composer.text(),
    );
    q.set_text("cats");
    check("changing search clears the selection immediately", !send.is_sensitive() && first(&grid).is_none(), ());
    for _ in 0..100 {
        if first(&grid).is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    let Some(choice) = first(&grid) else {
        check("live search refreshes results", false, ());
        return;
    };
    check("live search refreshes results", true, ());
    choice.set_active(true);
    if std::env::var("RV_SMOKE_GIPHY").as_deref() == Ok("hold") {
        return;
    }
    d.close();
    glib::timeout_future(Duration::from_millis(200)).await;
    check("cancel keeps the draft", composer.text() == "/giphy wave", composer.text());
    composer.submit_now();
    glib::timeout_future(Duration::from_millis(300)).await;
    check("Send reopens a cancelled GIF picker", composer.gif_picker().is_some(), ());
    let Some(d) = composer.gif_picker() else { return };
    let Some(grid) = find_named(d.upcast_ref(), "gif-grid").and_downcast::<gtk::FlowBox>() else { return };
    let Some(send) = find_named(d.upcast_ref(), "gif-send").and_downcast::<gtk::Button>() else { return };
    for _ in 0..100 {
        if first(&grid).is_some() {
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    let Some(choice) = first(&grid) else {
        check("reopened GIF results render", false, ());
        return;
    };
    choice.set_active(true);
    send.emit_clicked();
    send.emit_clicked();
    for _ in 0..100 {
        if composer.text().is_empty() && !d.is_mapped() {
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    check(
        "successful GIF send clears only the unchanged draft",
        composer.text().is_empty() && !d.is_mapped(),
        composer.text(),
    );
}
