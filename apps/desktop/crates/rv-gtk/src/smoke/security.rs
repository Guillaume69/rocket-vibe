//! Connected, disposable-only security settings check. Secrets are compared in
//! memory, never printed or rendered in a saved screenshot.
use super::{check, find_by_class};
use crate::{on_tokio, window::AppWindow};
use adw::prelude::*;
use gtk::glib;
use rv_core::native::security::{FactorState, Guard, Remote, email};
use std::{rc::Rc, time::Duration};

pub(super) fn install(window: &Rc<AppWindow>) {
    let Ok(phase) = std::env::var("RV_SMOKE_SECURITY") else { return };
    assert!(matches!(phase.as_str(), "proof-regenerate" | "restart-ack-disable"));
    let weak = Rc::downgrade(window);
    let mut polls = 0;
    glib::timeout_add_local(Duration::from_millis(100), move || {
        let Some(window) = weak.upgrade() else { return glib::ControlFlow::Break };
        polls += 1;
        if let Some(session) = window.chat.native_session()
            && session.security_supported()
            && session.status().connection == rv_core::session::Connection::Online
        {
            assert_eq!(session.info.username, "gtk-security");
            assert_eq!(session.info.base_url.trim_end_matches('/'), "http://factor-proxy:3401");
            let phase = phase.clone();
            glib::spawn_future_local(async move { run(window, phase).await });
            return glib::ControlFlow::Break;
        }
        if polls >= 160 {
            if let Some(session) = window.chat.native_session() {
                eprintln!("smoke: security provider failed to connect: {:?}", session.status());
            }
            check("security settings connected provider", false, polls);
            return glib::ControlFlow::Break;
        }
        glib::ControlFlow::Continue
    });
}
async fn wait(root: &gtk::Widget, class: &str, accept: impl Fn(&gtk::Widget) -> bool) -> Option<gtk::Widget> {
    for _ in 0..200 {
        if let Some(widget) = find_by_class(root, class)
            && accept(&widget)
        {
            return Some(widget);
        }
        glib::timeout_future(Duration::from_millis(25)).await;
    }
    check("security widget state reached", false, 0);
    None
}
async fn idle(root: &gtk::Widget) -> bool {
    wait(root, "native-security-page", |w| w.is_sensitive()).await.is_some()
}
fn activate(root: &gtk::Widget, class: &str) {
    let row = find_by_class(root, class).and_downcast::<adw::ButtonRow>().expect("security button");
    row.emit_by_name::<()>("activated", &[]);
}
async fn confirm(root: &gtk::Widget, class: &str) -> bool {
    activate(root, class);
    let Some(alert) = wait(root, "native-security-confirm", |_| true).await.and_downcast::<adw::AlertDialog>() else {
        return false;
    };
    let Some(button) =
        wait(alert.upcast_ref(), "destructive-action", |w| w.is::<gtk::Button>()).await.and_downcast::<gtk::Button>()
    else {
        return false;
    };
    button.emit_clicked();
    idle(root).await
}
async fn open(root: &gtk::Widget) -> bool {
    if wait(root, "native-security-open", |_| true).await.is_none() {
        return false;
    }
    activate(root, "native-security-open");
    wait(root, "native-security-page", |_| true).await.is_some() && idle(root).await
}
async fn run(window: Rc<AppWindow>, phase: String) {
    let session = window.chat.native_session().unwrap();
    crate::settings::open_native(window.chat.widget(), session.clone(), None, || {});
    let root = window.window.upcast_ref::<gtk::Widget>();
    if !open(root).await {
        return;
    }
    let codes = find_by_class(root, "native-security-codes").and_downcast::<gtk::Label>().unwrap();
    if phase == "proof-regenerate" {
        let password = find_by_class(root, "native-security-password").and_downcast::<adw::PasswordEntryRow>().unwrap();
        check("aged family requests explicit identity confirmation", password.is_mapped(), 0);
        password.set_text("native-pilot-test-password");
        activate(root, "native-security-password-submit");
        check("security password cleared before dispatch", password.text().is_empty(), 0);
        if !idle(root).await {
            return;
        }
        check("lost proof-start response keeps recoverable view", password.is_mapped(), 0);
        activate(root, "native-security-refresh");
        if !idle(root).await {
            return;
        }
        let code = find_by_class(root, "native-security-code").and_downcast::<adw::EntryRow>().unwrap();
        check("proof-start resumes without entering password again", code.is_mapped(), 0);
        let methods = find_by_class(root, "native-security-method").and_downcast::<adw::ComboRow>().unwrap();
        methods.set_selected(1);
        code.set_text("INVALID-BACKUP");
        activate(root, "native-security-proof-submit");
        if !idle(root).await {
            return;
        }
        check("incorrect identity factor remains retryable", code.is_mapped() && code.text().is_empty(), 0);
        check("incorrect factor preserves the selected backup method", methods.selected() == 1, 0);
        let path = std::env::var("RV_NATIVE_SECURITY_FACTOR_FILE").unwrap();
        let fixture: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        code.set_text(fixture["codes"][1].as_str().unwrap());
        activate(root, "native-security-proof-submit");
        if !idle(root).await {
            return;
        }
        check("lost proof-finish response clears typed factor", code.text().is_empty() && code.is_mapped(), 0);
        activate(root, "native-security-refresh");
        if !idle(root).await {
            return;
        }
        check("accepted identity proof resumes without another factor", !code.is_mapped() && !password.is_mapped(), 0);
        let s = session.clone();
        let previous = on_tokio(async move { s.security(Guard::new()).await }).await.unwrap();
        if !confirm(root, "native-security-regenerate").await {
            return;
        }
        check("lost regeneration response has no unconfirmed code bag", codes.text().is_empty(), 0);
        for _ in 0..400 {
            if previous.check().is_err() {
                break;
            }
            glib::timeout_future(Duration::from_millis(25)).await;
        }
        check("regeneration fences the previous socket generation", previous.check().is_err(), 0);
        activate(root, "native-security-refresh");
        if !idle(root).await {
            return;
        }
    }
    let s = session.clone();
    let private = on_tokio(async move {
        let access = s.security(Guard::new()).await?;
        crate::secrets::security_vault().factor_resume(access.scope(), &access, &access.guard()).await
    })
    .await;
    let matches = matches!(private, Ok(FactorState::Codes { codes: ref bag, .. }) if bag.codes.len()==10 && bag.codes.join("\n")==codes.text());
    check("security code bag matches private Secret Service receipt", matches, 0);
    let fits = find_by_class(root, "native-security-dialog").is_some_and(|dialog| {
        codes
            .compute_bounds(&dialog)
            .is_some_and(|bounds| bounds.x() >= 0.0 && bounds.x() + bounds.width() <= dialog.width() as f32)
    });
    check("security code bag fits narrow existing preferences", fits, 0);
    let email_code = find_by_class(root, "native-security-email-code").and_downcast::<adw::PasswordEntryRow>().unwrap();
    let email_current = find_by_class(root, "native-security-email-current").and_downcast::<adw::ActionRow>().unwrap();
    if phase == "proof-regenerate" {
        check("email verification requires configured private capability", session.email_supported(), 0);
        let address = find_by_class(root, "native-security-email-address").and_downcast::<adw::EntryRow>().unwrap();
        address.set_text("gtk-security@example.test");
        activate(root, "native-security-email-start");
        check("email address clears before dispatch", address.text().is_empty(), 0);
        if !idle(root).await {
            return;
        }
        check("lost email start does not display an unconfirmed attempt", !email_code.is_visible(), 0);
        activate(root, "native-security-refresh");
        if !idle(root).await {
            return;
        }
        check("email start resumes the original private candidate", email_code.is_visible(), 0);
        email_code.set_text("00000000");
    } else {
        check("pending email survives actual process and keyring restart", email_code.is_visible(), 0);
        let path = std::env::var("RV_NATIVE_SECURITY_EMAIL_FILE").unwrap();
        let mut delivered = None;
        for _ in 0..200 {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                delivered = serde_json::from_str::<serde_json::Value>(&raw).ok();
                if delivered.is_some() {
                    break;
                }
            }
            glib::timeout_future(Duration::from_millis(25)).await;
        }
        let delivered = delivered.expect("disposable TLS relay delivered mail into private volume");
        check(
            "TLS mail reaches only the intended disposable contact",
            delivered["address"] == "gtk-security@example.test",
            0,
        );
        email_code.set_text(delivered["code"].as_str().unwrap());
        activate(root, "native-security-email-confirm");
        check("email code clears before confirmation dispatch", email_code.text().is_empty(), 0);
        if !idle(root).await {
            return;
        }
        check("lost mail confirmation keeps the recoverable original view", email_code.is_visible(), 0);
        activate(root, "native-security-refresh");
        if !idle(root).await {
            return;
        }
        check(
            "accepted mail confirmation resumes without another code",
            !email_code.is_visible() && email_current.subtitle().as_deref() == Some("gtk-security@example.test"),
            0,
        );
        activate(root, "native-security-email-acknowledge");
        if !idle(root).await {
            return;
        }
        let s = session.clone();
        let restored = on_tokio(async move {
            let access = s.security(Guard::new()).await?;
            crate::secrets::security_vault().email_resume(access.scope(), &access, &access.guard()).await
        })
        .await;
        check(
            "explicit mail acknowledgement removes only its private receipt",
            matches!(restored, Ok(email::View { state: email::State::Idle, .. })),
            0,
        );
        let address = find_by_class(root, "native-security-email-address").and_downcast::<adw::EntryRow>().unwrap();
        address.set_text("bad@@example.test");
        activate(root, "native-security-email-start");
        if !idle(root).await {
            return;
        }
        let retire = find_by_class(root, "native-security-email-retire").unwrap();
        check("refused mail address remains explicitly cancellable", retire.is_visible(), 0);
        activate(root, "native-security-email-retire");
        if !idle(root).await {
            return;
        }
        check(
            "cancelling refused mail preserves the verified contact",
            address.is_visible() && email_current.subtitle().as_deref() == Some("gtk-security@example.test"),
            0,
        );
    }
    if phase == "restart-ack-disable" {
        activate(root, "native-security-acknowledge");
        if !idle(root).await {
            return;
        }
        check("explicit saved-code action clears private display", codes.text().is_empty(), 0);
        let s = session.clone();
        let previous = on_tokio(async move { s.security(Guard::new()).await }).await.unwrap();
        if !confirm(root, "native-security-disable").await {
            return;
        }
        // The source closes the old socket asynchronously after the mutation.
        // Observe that boundary before requesting a fresh UI generation.
        for _ in 0..400 {
            if previous.check().is_err() {
                break;
            }
            glib::timeout_future(Duration::from_millis(25)).await;
        }
        check("factor mutation fences the previous socket generation", previous.check().is_err(), 0);
        let mut disabled = false;
        for _ in 0..200 {
            if session.status().connection == rv_core::session::Connection::Online {
                let s = session.clone();
                disabled = on_tokio(async move {
                    let access = s.security(Guard::new()).await?;
                    access.factor_status().await
                })
                .await
                .is_ok_and(|status| !status.totp);
                if disabled {
                    break;
                }
            }
            glib::timeout_future(Duration::from_millis(25)).await;
        }
        check("lost disable response resumes the committed result", disabled, 0);
        activate(root, "native-security-refresh");
        if !idle(root).await {
            return;
        }
        let status = find_by_class(root, "native-security-status").and_downcast::<adw::ActionRow>().unwrap();
        check(
            "security refresh follows the renewed socket generation",
            status.title() == crate::i18n::t("security.disabled"),
            0,
        );
    }
    let dialog = find_by_class(root, "native-security-dialog").and_downcast::<adw::PreferencesDialog>().unwrap();
    dialog.close();
    glib::timeout_future(Duration::from_millis(500)).await;
    check("closing security removes private visible code bag", codes.text().is_empty(), 0);
    check(
        "closing security clears transient mail inputs and display",
        email_code.text().is_empty() && email_current.subtitle().as_deref().is_none_or(str::is_empty),
        0,
    );
    if phase == "restart-ack-disable" {
        let _ = open(root).await;
    }
    println!("smoke: native security phase {phase} completed");
}
