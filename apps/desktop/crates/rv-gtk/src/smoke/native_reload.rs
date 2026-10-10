//! The GTK side of the reload benchmark (`apps/desktop/scripts/native-reload-smoke.sh`,
//! peer `rv-core/examples/native-reload-peer.rs`): with `RV_SMOKE_NATIVE_RELOAD=<dir>`,
//! wait until the open room shows its history, write `open`, then keep the room on
//! screen while the peer's burst arrives, until `done` and the last message of the
//! open room are in. The measures are the `rocket-vibe-reload` trace lines.
use super::check;
use crate::window::AppWindow;
use gtk::{glib, prelude::*};
use std::{path::PathBuf, rc::Rc, time::Duration};

/// The last burst message the peer sends to the open room (one in three of 60).
const LAST_OPEN: &str = "burst 57";

pub(super) fn install(window: &Rc<AppWindow>) {
    let Ok(dir) = std::env::var("RV_SMOKE_NATIVE_RELOAD") else { return };
    let dir = PathBuf::from(dir);
    let weak = Rc::downgrade(window);
    let mut polls = 0;
    glib::timeout_add_local(Duration::from_millis(100), move || {
        let Some(window) = weak.upgrade() else { return glib::ControlFlow::Break };
        polls += 1;
        let online =
            window.chat.native_session().is_some_and(|s| s.status().connection == rv_core::session::Connection::Online);
        if online && window.chat.message_texts().iter().any(|t| t == "history 299") {
            glib::spawn_future_local(run(window, dir.clone()));
            return glib::ControlFlow::Break;
        }
        if polls > 900 {
            check("reload benchmark room loaded", false, window.chat.current_rid());
            std::process::exit(1)
        }
        glib::ControlFlow::Continue
    });
}

async fn run(window: Rc<AppWindow>, dir: PathBuf) {
    check("reload benchmark room shows its history", true, ());
    std::fs::write(dir.join("open"), "").unwrap();
    let mut arrived = false;
    for _ in 0..1800 {
        arrived = dir.join("done").exists() && window.chat.message_texts().iter().any(|t| t == LAST_OPEN);
        if arrived {
            break;
        }
        glib::timeout_future(Duration::from_millis(100)).await;
    }
    check("reload benchmark burst shown", arrived, ());
    // The last reloads of the burst land after its last message.
    glib::timeout_future(Duration::from_secs(2)).await;
    window.window.application().unwrap().quit();
}
