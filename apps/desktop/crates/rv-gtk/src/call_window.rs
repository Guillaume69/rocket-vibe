//! Calls open in a window of their own, not in a browser tab: WebView2 on
//! Windows and WKWebView on macOS, through rv-native, locked on the call's
//! origin. Linux distributions build WebKitGTK without WebRTC, which the
//! meeting needs, so there the call opens as an app window of a Chromium
//! browser when one is installed. Otherwise the browser takes the call and a
//! toast says why.

use adw::prelude::*;

use crate::i18n::t;

#[cfg(target_os = "linux")]
const APP_MODE_BROWSERS: [&str; 9] = [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "brave",
    "brave-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "vivaldi",
];

#[cfg(target_os = "linux")]
fn open_window(url: &str, _room: &str, fallback: impl Fn() + 'static) {
    use gtk::glib;
    let Some(browser) = APP_MODE_BROWSERS.iter().find_map(glib::find_program_in_path) else {
        return fallback();
    };
    let profile = glib::user_data_dir().join("rocket-vibe-rs").join("call-window");
    let spawned = std::process::Command::new(&browser)
        .arg(format!("--app={url}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--class=rocket-vibe-call")
        .args(["--no-first-run", "--no-default-browser-check"])
        .spawn();
    match spawned {
        Ok(mut child) => {
            eprintln!("Call in an app window of {}", browser.display());
            std::thread::spawn(move || child.wait());
        }
        Err(e) => {
            eprintln!("Call window not started: {e}");
            fallback();
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn open_window(url: &str, room: &str, fallback: impl Fn() + 'static) {
    let title = crate::i18n::tf("call.window_title", &[("room", room)]);
    if let Err(e) = rv_native::call_window(url, &title, rv_core::call::allowed) {
        eprintln!("Call window not opened: {e}");
        fallback();
    }
}

/// The call at `url`, in its own window; `toast` says so when it goes to the browser instead.
pub fn open(widget: &impl IsA<gtk::Widget>, url: &str, room: &str, toast: impl Fn(String) + 'static) {
    let (anchor, target) = (widget.clone().upcast::<gtk::Widget>(), url.to_owned());
    open_window(url, room, move || {
        crate::cards::open_uri(&anchor, &target);
        toast(t("call.in_browser").to_owned());
    });
}

/// The meeting's link, to copy or open in the browser, like the official client's info button.
pub fn info(widget: &impl IsA<gtk::Widget>, link: &str) {
    let dialog = adw::AlertDialog::builder().heading(t("call.info")).body(t("call.link")).build();
    let label = gtk::Label::builder().label(link).selectable(true).wrap(true).css_classes(["call-link"]).build();
    dialog.set_extra_child(Some(&label));
    dialog.add_responses(&[
        ("close", t("call.close")),
        ("copy", t("call.copy_link")),
        ("open", t("call.open_browser")),
    ]);
    dialog.set_default_response(Some("copy"));
    dialog.set_close_response("close");
    let (anchor, link) = (widget.clone().upcast::<gtk::Widget>(), link.to_owned());
    dialog.connect_response(None, move |_, response| match response {
        "copy" => {
            if let Some(display) = gtk::gdk::Display::default() {
                display.clipboard().set_text(&link);
            }
        }
        "open" => crate::cards::open_uri(&anchor, &link),
        _ => {}
    });
    dialog.present(Some(widget));
}
