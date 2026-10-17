//! Infomaniak's sign-in page for kChat, in a window of the app: a WebKitGTK
//! dialog on Linux, WebView2 or WKWebView through rv-native elsewhere. The
//! window catches the `com.infomaniak.chat://` redirect no desktop browser
//! would hand back; closing it is a cancel.

use std::cell::Cell;
use std::rc::Rc;

use adw::prelude::*;
use rv_core::mattermost::oauth::{self, Pkce};

use crate::i18n::t;

#[cfg(target_os = "linux")]
thread_local! {
    static SHOWN: std::cell::RefCell<gtk::glib::WeakRef<webkit6::WebView>> = std::cell::RefCell::default();
}

/// Opens the sign-in; `done` gets the Infomaniak bearer, or why there is none.
/// Nothing is called when the window is closed without signing in.
pub fn open(anchor: &impl IsA<gtk::Widget>, done: impl Fn(Result<String, String>) + 'static) {
    let pkce = match Pkce::new() {
        Ok(pkce) => pkce,
        Err(e) => return done(Err(e.to_string())),
    };
    let url = pkce.authorize_url();
    let handled = Rc::new(Cell::new(false));
    let done: Rc<dyn Fn(Result<String, String>)> = Rc::new(done);
    let failed = done.clone();
    let caught = Rc::new(move |redirect: String| {
        if handled.replace(true) {
            return;
        }
        println!("sign-in: redirect caught");
        let code = match pkce.code_from_redirect(&redirect) {
            Ok(code) => code,
            Err(e) => return done(Err(e.to_string())),
        };
        let (pkce, done) = (pkce.clone(), done.clone());
        gtk::glib::spawn_future_local(async move {
            let token = crate::on_tokio(async move { pkce.exchange(&code).await }).await;
            done(token.map_err(|e| e.to_string()));
        });
    });
    if let Err(e) = show(anchor.upcast_ref(), &url, caught) {
        eprintln!("Sign-in window not opened: {e}");
        failed(Err(e));
    }
}

#[cfg(target_os = "linux")]
fn show(anchor: &gtk::Widget, url: &str, caught: Rc<dyn Fn(String)>) -> Result<(), String> {
    use webkit6::prelude::*;

    let web = webkit6::WebView::builder().network_session(&webkit6::NetworkSession::new_ephemeral()).build();
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
        adw::Dialog::builder().title(t("login.infomaniak")).content_width(520).content_height(720).child(&page).build();
    web.connect_permission_request(|_, request| {
        request.deny();
        true
    });
    let take = {
        let dialog = dialog.downgrade();
        move |target: &str| {
            if let Some(dialog) = dialog.upgrade() {
                dialog.close();
            }
            caught(target.to_owned());
        }
    };
    let on_failure = take.clone();
    web.connect_decide_policy(move |web, decision, kind| {
        let Some(action) =
            decision.downcast_ref::<webkit6::NavigationPolicyDecision>().and_then(|d| d.navigation_action())
        else {
            return false;
        };
        let target = action.request().and_then(|r| r.uri()).map(|u| u.to_string()).unwrap_or_default();
        if oauth::is_redirect(&target) {
            decision.ignore();
            take(&target);
            return true;
        }
        // WebKitGTK does not say which frame navigates: what no click started
        // (the page's reCAPTCHA frames, its script redirects) stays in the window.
        let clicked = action.is_user_gesture();
        let inside = kind == webkit6::PolicyDecisionType::NavigationAction
            && (target == "about:blank" || oauth::is_sign_in_page(&target) || !clicked);
        if inside {
            return false;
        }
        decision.ignore();
        if kind == webkit6::PolicyDecisionType::NewWindowAction && oauth::is_sign_in_page(&target) {
            web.load_uri(&target);
            return true;
        }
        if !clicked {
            return true;
        }
        println!("sign-in: left for the browser {target}");
        if target.starts_with("https://") || target.starts_with("http://") {
            crate::cards::open_uri(web, &target);
        }
        true
    });
    web.connect_load_failed(move |_, _, failing, _| {
        if oauth::is_redirect(failing) {
            on_failure(failing);
            return true;
        }
        false
    });
    web.connect_load_changed(|web, event| {
        if event == webkit6::LoadEvent::Finished {
            println!("sign-in: loaded {}", web.uri().unwrap_or_default());
        }
    });
    web.load_uri(url);
    SHOWN.with_borrow_mut(|shown| shown.set(Some(&web)));
    crate::widgets::present(&dialog, Some(anchor));
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn show(_anchor: &gtk::Widget, url: &str, caught: Rc<dyn Fn(String)>) -> Result<(), String> {
    let sign_in = rv_native::SignIn { page: oauth::is_sign_in_page, redirect: oauth::is_redirect, caught };
    rv_native::sign_in_window(url, t("login.infomaniak"), sign_in)
}

/// The smoke run's stand-in for a finished sign-in: once Infomaniak's page has
/// loaded, it navigates to the redirect with a state no request made.
#[cfg(target_os = "linux")]
pub fn forge_redirect() -> bool {
    use webkit6::prelude::*;

    let Some(web) = SHOWN.with_borrow(|shown| shown.upgrade()) else { return false };
    if web.is_loading() || !web.uri().is_some_and(|u| u.starts_with("https://login.infomaniak.com/")) {
        return false;
    }
    let forged = format!("location.href = '{}?code=smoke&state=forged'", oauth::KCHAT_REDIRECT);
    web.evaluate_javascript(&forged, None, None, None::<&gtk::gio::Cancellable>, |_| {});
    true
}

#[cfg(not(target_os = "linux"))]
pub fn forge_redirect() -> bool {
    false
}

/// Whether the sign-in window is still on screen.
#[cfg(target_os = "linux")]
pub fn is_open() -> bool {
    SHOWN.with_borrow(|shown| shown.upgrade()).is_some_and(|web| web.root().is_some())
}

#[cfg(not(target_os = "linux"))]
pub fn is_open() -> bool {
    false
}
