use super::*;
use std::time::{Duration, Instant};

#[allow(clippy::duplicate_mod)]
#[path = "../../../rv-core/tests/common/mod.rs"]
mod http;

fn until(stage: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !check() {
        assert!(Instant::now() < deadline, "native login layout timed out at {stage}");
        while glib::MainContext::default().iteration(false) {}
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn find(widget: &gtk::Widget, predicate: &impl Fn(&gtk::Widget) -> bool) -> Option<gtk::Widget> {
    if predicate(widget) {
        return Some(widget.clone());
    }
    std::iter::successors(widget.first_child(), |child| child.next_sibling()).find_map(|child| find(&child, predicate))
}

fn fits(widget: &gtk::Widget, window: &adw::ApplicationWindow, vertical: bool) -> bool {
    widget.compute_bounds(window).is_some_and(|bounds| {
        bounds.x() >= -2.0
            && bounds.x() + bounds.width() <= window.width() as f32 + 2.0
            && (!vertical || (bounds.y() >= -2.0 && bounds.y() + bounds.height() <= window.height() as f32 + 2.0))
    })
}

#[test]
#[ignore = "requires a GTK display; run under Xvfb"]
fn native_login_modes_fit_narrow_windows_and_scroll_to_their_submit() {
    gtk::init().unwrap();
    adw::init().unwrap();
    crate::style::load();
    let executor = tokio::runtime::Runtime::new().unwrap();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut discovery = fixture["discovery"].clone();
    discovery["capabilities"]["account_invitations"] = serde_json::json!(true);
    discovery["capabilities"]["account_recovery"] = serde_json::json!(true);
    let server = executor.block_on(http::FakeHttp::start(move |request| match request.path() {
        "/.well-known/vibez" => http::respond(200, &discovery.to_string()),
        _ => http::respond(404, "{}"),
    }));
    let app = adw::Application::builder().application_id("me.rocketvibe.LoginLayoutTest").build();
    app.register(None::<&gtk::gio::Cancellable>).unwrap();
    for language in [rv_core::i18n::Lang::En, rv_core::i18n::Lang::Fr] {
        rv_core::i18n::set(language);
        let page = AppWindow::new(&app);
        // Do not start keyring restoration or sign in. Only the real anonymous
        // discovery callback enables the actual native registration controls.
        page.stack.set_visible_child_name("login");
        page.login.fill(server.url.as_str(), "", "");
        page.window.present();
        let signup = find(page.login.widget.upcast_ref(), &|widget| {
            widget
                .downcast_ref::<gtk::CheckButton>()
                .is_some_and(|button| button.label().as_deref() == Some(t("login.create_account")))
        })
        .unwrap()
        .downcast::<gtk::CheckButton>()
        .unwrap();
        let recovery = find(page.login.widget.upcast_ref(), &|widget| {
            widget
                .downcast_ref::<gtk::CheckButton>()
                .is_some_and(|button| button.label().as_deref() == Some(t("login.recover_account")))
        })
        .unwrap()
        .downcast::<gtk::CheckButton>()
        .unwrap();
        until("native discovery modes", || signup.is_visible() && recovery.is_visible());
        let scroll = find(page.login.widget.upcast_ref(), &|widget| widget.is::<gtk::ScrolledWindow>())
            .unwrap()
            .downcast::<gtk::ScrolledWindow>()
            .unwrap();
        for (width, height) in [(1170, 760), (390, 844)] {
            page.window.set_default_size(width, height);
            until("window resize", || page.window.width() <= width && page.window.width() >= width - 12);
            for mode in ["normal", "signup", "recovery"] {
                signup.set_active(mode == "signup");
                recovery.set_active(mode == "recovery");
                let label = t(match mode {
                    "signup" => "login.create_account",
                    "recovery" => "login.reset_password",
                    _ => "login.sign_in",
                });
                let submit = find(page.login.widget.upcast_ref(), &|widget| {
                    widget
                        .downcast_ref::<gtk::Button>()
                        .is_some_and(|button| button.has_css_class("cta") && button.label().as_deref() == Some(label))
                })
                .expect("current mode submit");
                // Let the actual mode's layout settle before scrolling its
                // existing viewport to the bottom, as a user can do.
                let deadline = Instant::now() + Duration::from_millis(100);
                while Instant::now() < deadline {
                    while glib::MainContext::default().iteration(false) {}
                    std::thread::sleep(Duration::from_millis(5));
                }
                let adjustment = scroll.vadjustment();
                adjustment.set_value(adjustment.upper());
                until("visible and fully reachable submit", || fits(&submit, &page.window, true));
                let toolbar = find(page.login.widget.upcast_ref(), &|widget| widget.is::<adw::ToolbarView>()).unwrap();
                assert!(fits(&toolbar, &page.window, false), "{language:?} {mode} toolbar must fit at {width}px");
                let field = find(page.login.widget.upcast_ref(), &|widget| {
                    widget.has_css_class("pill-entry") && widget.is_mapped()
                })
                .unwrap();
                assert!(fits(&field, &page.window, false), "{language:?} {mode} fields must fit at {width}px");
                assert!(submit.is_sensitive());
            }
        }
        gtk::prelude::GtkWindowExt::set_focus(&page.window, None::<&gtk::Widget>);
        page.window.close();
    }
    assert!(server.requests().iter().all(|request| request.method == "GET"));
}
