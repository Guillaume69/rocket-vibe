#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod actions_menu;
mod attach;
mod background;
mod badge;
mod bundle;
mod call_window;
mod cards;
mod chat;
mod composer;
mod crashlog;
mod details;
mod emoji_picker;
mod focus;
mod fonts;
mod gst_stream;
mod i18n;
mod icon;
mod login;
mod login_recovery;
mod logs;
#[cfg(target_os = "macos")]
mod macos;
mod markdown_view;
mod marked;
mod media;
mod message_list;
mod native_crypto;
mod native_quote_cards;
mod native_security;
mod notifier;
mod player;
mod rail;
mod reactions;
mod recorder;
mod rows;
mod secrets;
mod settings;
mod sidebar_dialog;
mod sizer;
mod smoke;
mod sounds;
mod spell;
mod spotlight;
mod staged;
mod style;
mod thread;
mod tile_grid;
mod unlock;
mod updater;
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
    if !background::start_hidden() {
        window.window.present();
    }
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
    logs::install();
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
    app.connect_startup(|app| {
        focus::install();
        #[cfg(windows)]
        if !smoke::ime_unpinned() {
            windows::input_method();
        }
        background::install(app);
        // Register the notification action during GApplication startup, before
        // activation: the OS can launch us directly with this target.
        let action = gtk::gio::SimpleAction::new("open-message", Some(&glib::VariantType::new("(ss)").expect("type")));
        let weak = app.downgrade();
        action.connect_activate(move |_, target| {
            if let (Some(app), Some((key, message))) =
                (weak.upgrade(), target.and_then(|v| v.get::<(String, String)>()))
            {
                window_of(&app).open_notification(key, message);
            }
        });
        app.add_action(&action);
        // Notification v2 passes [target, reply] through ActivateAction; GLib
        // 2.86 marshals those two values into this exact nested tuple.
        let reply = gtk::gio::SimpleAction::new(
            "reply-native-notification",
            Some(&glib::VariantType::new("((ss)s)").expect("type")),
        );
        let weak = app.downgrade();
        reply.connect_activate(move |_, target| {
            if let (Some(app), Some(((key, message), text))) =
                (weak.upgrade(), target.and_then(|v| v.get::<((String, String), String)>()))
            {
                window_of(&app).reply_notification(key, message, text);
            }
        });
        app.add_action(&reply);
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
    let mut args: Vec<String> = std::env::args().collect();
    if let Some(code) = smoke::autostart() {
        return code;
    }
    if !rv_native::claim_instance(&args) {
        return glib::ExitCode::SUCCESS;
    }
    #[cfg(windows)]
    rv_native::take_notification_flags(&mut args);
    background::take_flag(&mut args);
    let code = app.run_with_args(&args);
    updater::exec_if_relaunching();
    if smoke::failed() { glib::ExitCode::FAILURE } else { code }
}
