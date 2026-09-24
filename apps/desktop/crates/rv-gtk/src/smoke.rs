//! Unattended end-to-end run, driven by environment variables:
//!   RV_SMOKE_LOGIN  "server|user|password"
//!   RV_SMOKE_ROOM   room name to open once the room list is loaded
//!   RV_SMOKE_SEND   text to send in that room
//!   RV_SMOKE_SHOT   PNG path; the window is rendered after RV_SMOKE_DELAY_MS, then the app quits
//!   RV_SMOKE_EXPECT        `|`-separated texts the open room must show by then
//!   RV_SMOKE_EXPECT_ABSENT `|`-separated texts it must NOT show
//!   RV_SMOKE_SIZE          `WIDTHxHEIGHT` of the window
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
