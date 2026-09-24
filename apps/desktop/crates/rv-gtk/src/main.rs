mod actions_menu;
mod chat;
mod composer;
mod emoji_picker;
mod fonts;
mod i18n;
mod login;
mod markdown_view;
mod media;
mod message_list;
mod rows;
mod secrets;
mod smoke;
mod style;
mod thread;
mod widgets;
mod window;

use std::future::Future;
use std::sync::OnceLock;

use adw::prelude::*;
use gtk::glib;

pub const APP_ID: &str = "me.barrut.RocketVibe";

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

fn main() -> glib::ExitCode {
    let app = adw::Application::builder().application_id(APP_ID).build();
    i18n::init();
    app.connect_startup(|_| style::load());
    app.connect_activate(|app| {
        if let Some(window) = app.active_window() {
            window.present();
            return;
        }
        let window = window::AppWindow::new(app);
        smoke::install(&window);
        window.window.present();
        window.start();
    });
    let code = app.run_with_args::<&str>(&[]);
    if smoke::failed() { glib::ExitCode::FAILURE } else { code }
}
