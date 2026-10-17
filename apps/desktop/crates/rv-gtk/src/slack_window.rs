//! Slack's sign-in in a window of the app: a WebKitGTK dialog on Linux,
//! WebView2 or WKWebView through rv-native elsewhere, with no browser to find
//! and drive. Once Slack reaches its desktop handoff or its web client, the
//! window's Slack cookies are read, its store forgotten, and the window
//! closes; closing it first is a cancel.

use std::rc::Rc;

use adw::prelude::*;
use rv_core::slack::browser_login::{WINDOW_COOKIES, WINDOW_START, WindowCookie, window_done, window_page};

use crate::i18n::t;

type Caught = Rc<dyn Fn(String, Vec<WindowCookie>)>;

/// Opens the sign-in; `caught` gets the page it stopped on and the cookies it
/// held. Nothing is called when the window is closed without signing in.
pub fn open(
    anchor: &impl IsA<gtk::Widget>,
    caught: impl Fn(String, Vec<WindowCookie>) + 'static,
) -> Result<(), String> {
    show(anchor.upcast_ref(), Rc::new(caught))
}

#[cfg(target_os = "linux")]
fn show(anchor: &gtk::Widget, caught: Caught) -> Result<(), String> {
    use std::cell::Cell;
    use webkit6::prelude::*;

    let session = webkit6::NetworkSession::new_ephemeral();
    let web = webkit6::WebView::builder().network_session(&session).build();
    if let Some(settings) = WebViewExt::settings(&web) {
        settings.set_enable_developer_extras(false);
        settings.set_enable_webrtc(false);
        settings.set_enable_media_stream(false);
    }
    web.set_vexpand(true);
    let page = adw::ToolbarView::new();
    page.add_top_bar(&adw::HeaderBar::new());
    page.set_content(Some(&web));
    let dialog =
        adw::Dialog::builder().title(t("slack.signIn")).content_width(560).content_height(760).child(&page).build();
    web.connect_permission_request(|_, request| {
        request.deny();
        true
    });
    let reached = Rc::new(Cell::new(false));
    let dialog_weak = dialog.downgrade();
    web.connect_decide_policy(move |web, decision, kind| {
        let Some(action) =
            decision.downcast_ref::<webkit6::NavigationPolicyDecision>().and_then(|d| d.navigation_action())
        else {
            return false;
        };
        let target = action.request().and_then(|r| r.uri()).map(|u| u.to_string()).unwrap_or_default();
        if window_done(&target) {
            decision.ignore();
            if reached.replace(true) {
                return true;
            }
            println!("slack sign-in: session reached");
            let (caught, dialog, session) = (caught.clone(), dialog_weak.clone(), session.clone());
            let Some(manager) = session.cookie_manager() else { return true };
            manager.cookies(WINDOW_COOKIES, None::<&gtk::gio::Cancellable>, move |found| {
                let cookies: Vec<WindowCookie> = found
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|mut c| {
                        Some(WindowCookie {
                            name: c.name()?.to_string(),
                            value: zeroize::Zeroizing::new(c.value()?.to_string()),
                            domain: c.domain()?.to_string(),
                            path: c.path().map(|p| p.to_string()).unwrap_or_else(|| "/".to_owned()),
                            secure: c.is_secure(),
                            http_only: c.is_http_only(),
                        })
                    })
                    .collect();
                if let Some(dialog) = dialog.upgrade() {
                    dialog.close();
                }
                caught(target, cookies);
            });
            return true;
        }
        let clicked = action.is_user_gesture();
        let inside = kind == webkit6::PolicyDecisionType::NavigationAction
            && (target == "about:blank" || window_page(&target) || !clicked);
        if inside {
            return false;
        }
        decision.ignore();
        if clicked && (target.starts_with("https://") || target.starts_with("http://")) {
            crate::cards::open_uri(web, &target);
        }
        true
    });
    web.load_uri(WINDOW_START);
    crate::widgets::present(&dialog, Some(anchor));
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn show(_anchor: &gtk::Widget, caught: Caught) -> Result<(), String> {
    let caught = Rc::new(move |reached: String, cookies: Vec<rv_native::Cookie>| {
        let cookies = cookies
            .into_iter()
            .map(|c| WindowCookie {
                name: c.name,
                value: zeroize::Zeroizing::new(c.value),
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                http_only: c.http_only,
            })
            .collect();
        caught(reached, cookies);
    });
    let sign_in = rv_native::SessionSignIn { page: window_page, done: window_done, cookie_url: WINDOW_COOKIES, caught };
    rv_native::session_sign_in_window(WINDOW_START, t("slack.signIn"), sign_in)
}
