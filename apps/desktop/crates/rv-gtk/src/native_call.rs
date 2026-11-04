//! A Jitsi Meet call carried natively by the voice sidecar (rv-call's
//! signalling, libwebrtc's media): a small window of its own with who is in
//! the call, who speaks, the call's length, and mute, deafen and hang up.
//! Audio only. A call the sidecar cannot join falls back to the meeting's page.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Instant;

use adw::prelude::*;
use gtk::glib;
use rv_core::voice::{ConnectionState, Ended, JitsiCall, Snapshot, VoiceController};

use crate::i18n::{call_duration, t, tf};
use crate::on_tokio;

/// Opens the call; `fallback` opens the meeting's page instead when the
/// sidecar is missing or could not join.
pub fn open(call: JitsiCall, title: &str, fallback: impl Fn() + 'static) {
    if !rv_core::voice::available() {
        return fallback();
    }
    let voice = VoiceController::new();
    let window = adw::Window::builder()
        .title(tf("call.native_title", &[("room", title)]))
        .default_width(360)
        .default_height(440)
        .build();
    let status = gtk::Label::builder().label(t("call.connecting")).css_classes(["dim-label"]).build();
    let people = gtk::ListBox::builder().css_classes(["boxed-list"]).selection_mode(gtk::SelectionMode::None).build();
    let scroller = gtk::ScrolledWindow::builder().vexpand(true).child(&people).build();
    let mute = gtk::ToggleButton::builder()
        .icon_name("microphone-sensitivity-muted-symbolic")
        .tooltip_text(t("call.mute"))
        .css_classes(["circular"])
        .build();
    let deafen = gtk::ToggleButton::builder()
        .icon_name("audio-volume-muted-symbolic")
        .tooltip_text(t("call.deafen"))
        .css_classes(["circular"])
        .build();
    let hang_up = gtk::Button::builder()
        .icon_name("call-stop-symbolic")
        .tooltip_text(t("call.hang_up"))
        .css_classes(["circular", "destructive-action"])
        .build();
    let controls = gtk::Box::builder().spacing(18).halign(gtk::Align::Center).margin_top(12).margin_bottom(12).build();
    controls.append(&mute);
    controls.append(&deafen);
    controls.append(&hang_up);
    let body = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(12)
        .margin_start(12)
        .margin_end(12)
        .margin_top(12)
        .build();
    body.append(&status);
    body.append(&scroller);
    body.append(&controls);
    let page = adw::ToolbarView::new();
    page.add_top_bar(&adw::HeaderBar::new());
    page.set_content(Some(&body));
    window.set_content(Some(&page));

    let state =
        Rc::new(State { connected_at: Cell::new(None), ever_connected: Cell::new(false), closed: Cell::new(false) });
    let fallback: Rc<dyn Fn()> = Rc::new(fallback);
    let last: Rc<RefCell<Option<Snapshot>>> = Rc::default();

    let v = voice.clone();
    mute.connect_toggled(move |b| {
        let (v, on) = (v.clone(), !b.is_active());
        glib::spawn_future_local(async move { on_tokio(async move { v.set_microphone(on).await }).await });
    });
    let v = voice.clone();
    deafen.connect_toggled(move |b| {
        let (v, on) = (v.clone(), b.is_active());
        glib::spawn_future_local(async move { on_tokio(async move { v.set_deafened(on).await }).await });
    });
    let w = window.downgrade();
    hang_up.connect_clicked(move |_| {
        if let Some(w) = w.upgrade() {
            w.close();
        }
    });
    let (v, s) = (voice.clone(), state.clone());
    window.connect_close_request(move |_| {
        s.closed.set(true);
        let v = v.clone();
        glib::spawn_future_local(async move { on_tokio(async move { v.disconnect().await }).await });
        glib::Propagation::Proceed
    });

    // The snapshot drives the window; the call's length ticks every second.
    let mut changes = voice.changes();
    let (v, w, s, fb) = (voice.clone(), window.downgrade(), state.clone(), fallback.clone());
    let (people_ref, status_ref, last_ref) = (people.clone(), status.clone(), last.clone());
    glib::spawn_future_local(async move {
        loop {
            let snapshot = v.snapshot();
            let Some(window) = w.upgrade() else { return };
            if let Some(ended) = &snapshot.ended {
                if !s.closed.get() {
                    if !s.ever_connected.get() && matches!(ended, Ended::Failed(_)) {
                        fb();
                    }
                    s.closed.set(true);
                    window.close();
                }
                return;
            }
            if snapshot.state == ConnectionState::Connected && !s.ever_connected.get() {
                s.ever_connected.set(true);
                s.connected_at.set(Some(Instant::now()));
            }
            if last_ref.borrow().as_ref() != Some(&snapshot) {
                render(&people_ref, &snapshot);
                *last_ref.borrow_mut() = Some(snapshot);
            }
            status_ref.set_label(&status_text(&s, last_ref.borrow().as_ref()));
            drop(window);
            let _ = glib::future_with_timeout(std::time::Duration::from_secs(1), changes.recv()).await;
        }
    });

    let v = voice.clone();
    let fb = fallback.clone();
    let label = title.to_owned();
    glib::spawn_future_local(async move {
        let joined = on_tokio(async move { v.connect_jitsi(&label, &call).await }).await;
        if let Err(e) = joined {
            eprintln!("Native call not joined ({e}), opening the meeting's page");
            fb();
        }
    });
    window.present();
}

struct State {
    connected_at: Cell<Option<Instant>>,
    ever_connected: Cell<bool>,
    closed: Cell<bool>,
}

fn status_text(state: &State, snapshot: Option<&Snapshot>) -> String {
    let Some(at) = state.connected_at.get() else { return t("call.connecting").to_owned() };
    let alone = snapshot.is_none_or(|s| s.participants.iter().all(|p| p.local));
    if alone { t("call.waiting").to_owned() } else { call_duration(at.elapsed().as_secs()) }
}

fn render(list: &gtk::ListBox, snapshot: &Snapshot) {
    while let Some(row) = list.first_child() {
        list.remove(&row);
    }
    for p in &snapshot.participants {
        let name =
            if p.local { t("call.you").to_owned() } else { p.name.clone().unwrap_or_else(|| p.identity.clone()) };
        let row = adw::ActionRow::builder().title(glib::markup_escape_text(&name).as_str()).build();
        if p.muted {
            row.add_suffix(&gtk::Image::from_icon_name("microphone-sensitivity-muted-symbolic"));
        } else if p.speaking {
            row.add_suffix(&gtk::Image::from_icon_name("audio-volume-high-symbolic"));
        }
        list.append(&row);
    }
}
