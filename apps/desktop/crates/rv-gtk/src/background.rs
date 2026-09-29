//! Life beyond the window, on Windows and macOS: closing it keeps the app
//! running (the tray icon or the dock brings it back), the app can start at
//! login without it, and Quit (tray menu, Cmd+Q, Ctrl+Q) really leaves. On
//! Linux, closing quits as before: its desktops agree on no tray.

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;

use adw::prelude::*;
use gtk::{gio, glib};

use crate::i18n::t;

pub const SUPPORTED: bool = cfg!(any(windows, target_os = "macos"));

thread_local! {
    static QUITTING: Cell<bool> = const { Cell::new(false) };
    static HIDDEN_START: Cell<bool> = const { Cell::new(false) };
}

fn off_file() -> PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs").join("quit-on-close")
}

/// Whether closing the window leaves the app running.
pub fn keep_running() -> bool {
    SUPPORTED && !off_file().exists()
}

pub fn set_keep_running(on: bool) {
    if on {
        let _ = std::fs::remove_file(off_file());
    } else if let Some(dir) = off_file().parent() {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(off_file(), "");
    }
    tray();
}

/// Takes `--background` out of the arguments GTK parses; the first window
/// then stays hidden, when something can bring it back.
pub fn take_flag(args: &mut Vec<String>) {
    let before = args.len();
    args.retain(|a| a != rv_native::BACKGROUND_FLAG);
    HIDDEN_START.set(args.len() != before && keep_running());
}

/// Once, for the first window.
pub fn start_hidden() -> bool {
    let hidden = HIDDEN_START.replace(false);
    if hidden {
        println!("background: started without the window");
    }
    hidden
}

pub fn quitting() -> bool {
    QUITTING.get()
}

/// Closes the windows for real and leaves.
pub fn quit(app: &gtk::Application) {
    QUITTING.set(true);
    for window in app.windows() {
        window.close();
    }
    app.quit();
}

/// The notification-area icon, while the app keeps running without its window.
fn tray() {
    if keep_running() {
        rv_native::tray(Some(rv_native::TrayLabels { open: t("tray.open"), quit: t("tray.quit") }));
    } else {
        rv_native::tray(None);
    }
}

/// The quit action, and the tray, the dock and later launches wired to `app`.
pub fn install(app: &adw::Application) {
    let action = gio::SimpleAction::new("quit", None);
    action.connect_activate(glib::clone!(
        #[weak]
        app,
        move |_, _| quit(app.upcast_ref())
    ));
    app.add_action(&action);
    app.set_accels_for_action("app.quit", &["<Primary>q"]);
    let weak = app.downgrade();
    rv_native::app_events(Rc::new(move |event| {
        let weak = weak.clone();
        glib::idle_add_local_once(move || {
            let Some(app) = weak.upgrade() else { return };
            match event {
                rv_native::AppEvent::Show => app.activate(),
                rv_native::AppEvent::Quit => quit(app.upcast_ref()),
                rv_native::AppEvent::Open(link) => app.open(&[gio::File::for_uri(&link)], ""),
            }
        });
    }));
    tray();
}
