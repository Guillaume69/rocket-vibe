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

pub fn install(window: &Rc<AppWindow>) {
    let login = std::env::var("RV_SMOKE_LOGIN").unwrap_or_default();
    let room = std::env::var("RV_SMOKE_ROOM").unwrap_or_default();
    let text = std::env::var("RV_SMOKE_SEND").unwrap_or_default();
    let shot = std::env::var("RV_SMOKE_SHOT").unwrap_or_default();
    let parts: Vec<String> = login.split('|').map(str::to_owned).collect();
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
        println!("smoke: composer {:?}", w.chat.composer_text());
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

type Check = Box<dyn FnOnce(&crate::chat::ChatPage)>;

/// Runs the steps one after another, a beat apart, so the view relayouts between them.
fn in_sequence(chat: std::rc::Rc<crate::chat::ChatPage>, mut steps: std::collections::VecDeque<Check>) {
    let Some(step) = steps.pop_front() else { return };
    step(&chat);
    glib::timeout_add_local_once(Duration::from_millis(40), move || in_sequence(chat, steps));
}

fn composer_state(label: &str, chat: &crate::chat::ChatPage, want_bar: bool, max_height: i32) {
    let (height, bar, offset) = chat.composer_scroll_state();
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
    let handle = chat.composer_in_window_handle();
    println!("smoke: composer in window handle: {handle}");
    if handle {
        FAILED.store(true, Ordering::SeqCst);
    }
    let mut steps: std::collections::VecDeque<Check> = std::collections::VecDeque::new();
    steps.push_back(Box::new(|c| c.set_composer_text("")));
    for i in 0..132 {
        let key = if i % 11 == 10 { " " } else { "a" };
        steps.push_back(Box::new(move |c| c.type_in_composer(key)));
    }
    for _ in 0..5 {
        steps.push_back(Box::new(|_| {}));
    }
    steps.push_back(Box::new(|c| composer_state("two lines typed", c, false, 44)));
    for _ in 0..12 {
        steps.push_back(Box::new(|c| c.type_in_composer("\nanother line")));
    }
    for _ in 0..5 {
        steps.push_back(Box::new(|_| {}));
    }
    steps.push_back(Box::new(|c| composer_state("overflowing", c, true, 170)));
    steps.push_back(Box::new(|c| c.set_composer_text("hi")));
    for _ in 0..5 {
        steps.push_back(Box::new(|_| {}));
    }
    steps.push_back(Box::new(|c| composer_state("one line", c, false, 40)));
    steps.push_back(Box::new(|c| c.set_composer_text(&"aaaaaaaaaa ".repeat(12))));
    in_sequence(chat, steps);
}
