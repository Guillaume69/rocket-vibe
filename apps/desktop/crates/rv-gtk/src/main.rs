#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod actions_menu;
mod attach;
mod badge;
mod cards;
mod chat;
mod composer;
mod crashlog;
mod details;
mod emoji_picker;
mod fonts;
mod i18n;
mod icon;
mod login;
#[cfg(target_os = "macos")]
mod macos;
mod markdown_view;
mod marked;
mod media;
mod message_list;
mod notifier;
mod recorder;
mod rows;
mod secrets;
mod settings;
mod sizer;
mod smoke;
mod spell;
mod spotlight;
mod staged;
mod style;
mod thread;
mod unlock;
mod video;
mod widgets;
mod window;
#[cfg(windows)]
mod windows;

use std::future::Future;
use std::sync::OnceLock;

use adw::prelude::*;
use gtk::glib;

pub const APP_ID: &str = "com.rocketvibe.app";

/// The protocol core runs on tokio; GTK owns the main thread. UI code hops
/// over with `on_tokio(..).await` from a `glib::spawn_future_local` future.
pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime")
    })
}

pub async fn on_tokio<F>(future: F) -> F::Output
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    runtime().spawn(future).await.expect("tokio task")
}

thread_local! {
    static WINDOW: std::cell::RefCell<Option<std::rc::Rc<window::AppWindow>>> = const { std::cell::RefCell::new(None) };
}

fn window_of(app: &adw::Application) -> std::rc::Rc<window::AppWindow> {
    if let Some(window) = WINDOW.with_borrow(Clone::clone) {
        window.window.present();
        return window;
    }
    smoke::install_early();
    let window = window::AppWindow::new(app);
    smoke::install(&window);
    window.window.present();
    window.start();
    WINDOW.with_borrow_mut(|w| *w = Some(window.clone()));
    window
}

/// Being single-instance goes through the D-Bus session bus, which Windows
/// lacks: GLib's attempt to start one there aborted the app.
fn application_flags() -> gtk::gio::ApplicationFlags {
    let flags = gtk::gio::ApplicationFlags::HANDLES_OPEN;
    if cfg!(windows) { flags | gtk::gio::ApplicationFlags::NON_UNIQUE } else { flags }
}

fn main() -> glib::ExitCode {
    crashlog::install();
    #[cfg(target_os = "macos")]
    macos::bundle_environment();
    #[cfg(windows)]
    windows::std_streams();
    #[cfg(windows)]
    windows::text_backend();
    // One instance, except on Windows: a `rocketvibe://` link clicked elsewhere reaches the running app.
    let app = adw::Application::builder().application_id(APP_ID).flags(application_flags()).build();
    i18n::init();
    spell::start();
    app.connect_startup(|_| {
        style::load();
        if let Some(display) = gtk::gdk::Display::default() {
            icon::register(&display);
        }
    });
    app.connect_activate(|app| {
        if smoke::gallery(app) {
            return;
        }
        window_of(app);
    });
    app.connect_open(|app, files, _| {
        let window = window_of(app);
        for file in files {
            window.open_link(&file.uri());
        }
    });
    let args: Vec<String> = std::env::args().collect();
    let code = app.run_with_args(&args);
    if smoke::failed() { glib::ExitCode::FAILURE } else { code }
}
