//! Actual existing GTK controls and private keyring; three disposable processes.
use super::{check, find_by_class};
use crate::{i18n::t, window::AppWindow};
use adw::prelude::*;
use gtk::glib;
use std::{rc::Rc, time::Duration};
pub(super) fn install(window: &Rc<AppWindow>) {
    let Ok(phase) = std::env::var("RV_SMOKE_EMAIL_SETTINGS_PHASE") else { return };
    assert!(matches!(phase.as_str(), "enable" | "resume-disable" | "resume-disabled"));
    let window = window.clone();
    glib::spawn_future_local(async move { run(window, &phase).await });
}
async fn until(accept: impl Fn() -> bool) -> bool {
    for _ in 0..400 {
        if accept() {
            return true;
        }
        glib::timeout_future(Duration::from_millis(25)).await;
    }
    check("email settings expected widget state", false, 0);
    false
}
fn activate(root: &gtk::Widget, class: &str) {
    find_by_class(root, class)
        .and_downcast::<adw::ButtonRow>()
        .expect("settings row")
        .emit_by_name::<()>("activated", &[]);
}
async fn idle(root: &gtk::Widget) -> bool {
    until(|| find_by_class(root, "native-security-page").is_some_and(|w| w.is_sensitive())).await
}
async fn confirm(root: &gtk::Widget, enabled: bool) -> bool {
    activate(root, "native-security-email-factor");
    if !until(|| find_by_class(root, "native-security-email-factor-confirm").is_some_and(|w| w.is_mapped())).await {
        return false;
    }
    let alert = find_by_class(root, "native-security-email-factor-confirm").and_downcast::<adw::AlertDialog>().unwrap();
    let class = if enabled { "suggested-action" } else { "destructive-action" };
    let Some(button) = find_by_class(alert.upcast_ref(), class).and_downcast::<gtk::Button>() else {
        check("email profile confirmation button", false, 0);
        return false;
    };
    button.emit_clicked();
    idle(root).await
}
async fn run(window: Rc<AppWindow>, phase: &str) {
    if !until(|| {
        window.chat.native_session().is_some_and(|s| s.status().connection == rv_core::session::Connection::Online)
    })
    .await
    {
        return;
    }
    let session = window.chat.native_session().unwrap();
    check("disposable GTK settings account", session.info.username == "gtk-email", 0);
    let settings = crate::settings::open_native(window.chat.widget(), session, None, || {});
    let root = window.window.upcast_ref::<gtk::Widget>();
    if !until(|| find_by_class(root, "sidebar-category-security").is_some()).await {
        return;
    }
    settings.select("security");
    if !idle(root).await {
        return;
    }
    let current = find_by_class(root, "native-security-email-current").and_downcast::<adw::ActionRow>().unwrap();
    check("verified contact retained", current.subtitle().as_deref() == Some("gtk-email@example.test"), 0);
    if phase == "enable" {
        check(
            "email activation is explicitly offered",
            find_by_class(root, "native-security-email-factor").is_some_and(|w| w.is_mapped() && w.is_sensitive()),
            0,
        );
        if !confirm(root, true).await {
            return;
        }
        println!("smoke: GTK email activation original intent saved after lost ACK");
        window.window.application().unwrap().quit();
        return;
    }
    let codes = find_by_class(root, "native-security-codes").and_downcast::<gtk::Label>().unwrap();
    if phase == "resume-disable" {
        check(
            "email backup receipt recovered after process restart",
            codes.text().lines().count() == 10 && codes.is_mapped(),
            0,
        );
        check(
            "shared regeneration offered only after acknowledgement",
            !find_by_class(root, "native-security-regenerate").unwrap().is_mapped(),
            0,
        );
        activate(root, "native-security-copy-codes");
        if !idle(root).await {
            return;
        }
        let copied = root.clipboard().read_text_future().await.ok().flatten();
        check("email backup copy uses original shared receipt", copied.as_deref() == Some(codes.text().as_str()), 0);
        let backup = codes.text().lines().next().unwrap().to_owned();
        let password = find_by_class(root, "native-security-password").and_downcast::<adw::PasswordEntryRow>().unwrap();
        check("new profile needs full identity confirmation", password.is_mapped(), 0);
        password.set_text("native-pilot-test-password");
        activate(root, "native-security-password-submit");
        if !idle(root).await {
            return;
        }
        activate(root, "native-security-refresh");
        if !idle(root).await {
            return;
        }
        let methods = find_by_class(root, "native-security-method").and_downcast::<adw::ComboRow>().unwrap();
        let labels = methods.model().and_downcast::<gtk::StringList>().unwrap();
        let index =
            (0..labels.n_items()).find(|i| labels.string(*i).as_deref() == Some(t("login.factor_backup"))).unwrap();
        methods.set_selected(index);
        find_by_class(root, "native-security-code").and_downcast::<adw::EntryRow>().unwrap().set_text(&backup);
        activate(root, "native-security-proof-submit");
        if !idle(root).await {
            return;
        }
        activate(root, "native-security-refresh");
        if !idle(root).await {
            return;
        }
        check("full proof recovers without another backup code", !password.is_mapped(), 0);
        activate(root, "native-security-acknowledge");
        if !idle(root).await {
            return;
        }
        check("private backup display cleared on acknowledgement", codes.text().is_empty(), 0);
        check(
            "email-only profile can regenerate common backups",
            find_by_class(root, "native-security-regenerate").unwrap().is_mapped(),
            0,
        );
        check(
            "active email profile blocks contact mutation",
            !find_by_class(root, "native-security-email-remove").unwrap().is_mapped()
                && !find_by_class(root, "native-security-email-address").unwrap().is_mapped(),
            0,
        );
        if !confirm(root, false).await {
            return;
        }
        println!("smoke: GTK email removal original intent saved after lost ACK");
        window.window.application().unwrap().quit();
        return;
    }
    check("last email factor removal clears backup display", codes.text().is_empty(), 0);
    let action = find_by_class(root, "native-security-email-factor").and_downcast::<adw::ButtonRow>().unwrap();
    check("email factor disabled while contact remains", action.title() == t("email.factor_enable"), 0);
    check(
        "contact removal available again",
        find_by_class(root, "native-security-email-remove").unwrap().is_mapped(),
        0,
    );
    println!("smoke: GTK email settings three processes passed");
}
