//! Real GTK/private keyring/HTTP/TLS OTP bench. No secret is logged or captured.
use super::{check, find_by_class};
use crate::window::AppWindow;
use adw::prelude::*;
use gtk::glib;
use std::{rc::Rc, time::Duration};

pub(super) fn install(window: &Rc<AppWindow>) {
    let Ok(phase) = std::env::var("RV_SMOKE_EMAIL_OTP_PHASE") else { return };
    assert!(matches!(phase.as_str(), "login-delivery" | "login-proof" | "reauth-finish"));
    let window = window.clone();
    glib::spawn_future_local(async move {
        run(window, &phase).await;
    });
}
async fn until(accept: impl Fn() -> bool) -> bool {
    for _ in 0..400 {
        if accept() {
            return true;
        }
        glib::timeout_future(Duration::from_millis(25)).await;
    }
    check("email OTP widget reached expected state", false, 0);
    false
}
async fn mail(sequence: u64) -> Option<String> {
    let path = std::env::var("RV_NATIVE_EMAIL_OTP_FILE").expect("private fixture path");
    for _ in 0..400 {
        if let Ok(raw) = std::fs::read_to_string(&path)
            && let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw)
            && value["sequence"].as_u64() == Some(sequence)
            && let Some(code) = value["code"].as_str()
            && code.len() == 8
            && code.bytes().all(|b| b.is_ascii_digit())
        {
            return Some(code.into());
        }
        glib::timeout_future(Duration::from_millis(25)).await;
    }
    check("actual TLS email arrived", false, 0);
    None
}
fn activate(root: &gtk::Widget, class: &str) {
    find_by_class(root, class)
        .and_downcast::<adw::ButtonRow>()
        .expect("OTP button")
        .emit_by_name::<()>("activated", &[]);
}
async fn idle(root: &gtk::Widget) -> bool {
    until(|| find_by_class(root, "native-security-page").is_some_and(|w| w.is_sensitive())).await
}
async fn run(window: Rc<AppWindow>, phase: &str) {
    if phase != "reauth-finish" {
        if !until(|| !window.login.is_busy() && window.login.fill_factor("email", "")).await {
            return;
        }
        check("email code input starts transient and empty", window.login.code().is_empty(), 0);
        if phase == "login-delivery" {
            check("unconfirmed delivery cannot be resent", !window.login.request_native_mail(true), 0);
            check("explicit GTK email send", window.login.request_native_mail(false), 0);
            if !until(|| !window.login.is_busy()).await {
                return;
            }
            check(
                "lost delivery acknowledgement stays unconfirmed",
                !window.login.native_mail_known() && window.login.has_error(),
                0,
            );
            if mail(2).await.is_none() {
                return;
            }
            check("delivery does not install a session", window.chat.native_session().is_none(), 0);
            println!("smoke: GTK email OTP login delivery saved for next process");
            // The ordinary smoke timer captures only this empty code form.
            return;
        }
        check("restart recovers original email candidate", window.login.request_native_mail(false), 0);
        if !until(|| !window.login.is_busy() && window.login.native_mail_known()).await {
            return;
        }
        // A real button click during the server's cooldown must not enqueue mail.
        check("known delivery offers explicit resend", window.login.request_native_mail(true), 0);
        if !until(|| !window.login.is_busy()).await {
            return;
        }
        check("cooldown refuses GTK resend", window.login.has_error(), 0);
        let Some(code) = mail(2).await else { return };
        window.login.fill_factor("email", &code);
        window.submit_login();
        if !until(|| !window.login.is_busy()).await {
            return;
        }
        check(
            "lost code reply cannot activate login",
            window.chat.native_session().is_none() && window.login.code().is_empty(),
            0,
        );
        window.submit_login(); // recover the accepted durable bearer without another code
    }
    if !until(|| {
        window.chat.native_session().is_some_and(|s| s.status().connection == rv_core::session::Connection::Online)
    })
    .await
    {
        return;
    }
    let session = window.chat.native_session().unwrap();
    check("GTK OTP connects the expected native account", session.info.username == "gtk-email", 0);
    let initial_token = session.credential_info().auth_token;
    let settings = crate::settings::open_native(window.chat.widget(), session.clone(), None, || {});
    let root = window.window.upcast_ref::<gtk::Widget>();
    if !until(|| find_by_class(root, "sidebar-category-security").is_some()).await {
        return;
    }
    settings.select("security");
    if !idle(root).await {
        return;
    }
    if phase == "login-proof" {
        let password = find_by_class(root, "native-security-password").and_downcast::<adw::PasswordEntryRow>().unwrap();
        check("email family requests an explicit identity proof", password.is_mapped(), 0);
        password.set_text("native-pilot-test-password");
        activate(root, "native-security-password-submit");
        if !idle(root).await {
            return;
        }
        activate(root, "native-security-refresh");
        if !idle(root).await {
            return;
        }
        let send = find_by_class(root, "native-security-proof-mail-send").unwrap();
        check("GTK proof offers email delivery", send.is_mapped() && send.is_sensitive(), 0);
        activate(root, "native-security-proof-mail-send");
        if !idle(root).await {
            return;
        }
        if mail(3).await.is_none() {
            return;
        }
        let code = find_by_class(root, "native-security-code").and_downcast::<adw::EntryRow>().unwrap();
        check("proof mail keeps code transient", code.text().is_empty(), 0);
        check("proof mail retains the active credential", session.credential_info().auth_token == initial_token, 0);
        println!("smoke: GTK email OTP proof delivery saved for next process");
        window.window.application().unwrap().quit();
        return;
    }
    let send = find_by_class(root, "native-security-proof-mail-send").and_downcast::<adw::ButtonRow>().unwrap();
    check(
        "restarted proof resumes its mail without sending",
        send.title() == crate::i18n::t("email.resume_delivery"),
        0,
    );
    activate(root, "native-security-proof-mail-send");
    if !idle(root).await {
        return;
    }
    let Some(code) = mail(3).await else { return };
    let field = find_by_class(root, "native-security-code").and_downcast::<adw::EntryRow>().unwrap();
    field.set_text(&code);
    activate(root, "native-security-proof-submit");
    if !idle(root).await {
        return;
    }
    check("email proof code is cleared after a lost reply", field.text().is_empty(), 0);
    activate(root, "native-security-refresh");
    if !idle(root).await {
        return;
    }
    check("original email proof is accepted without another code", !field.is_mapped(), 0);
    check(
        "identity confirmation keeps its credential family",
        session.credential_info().auth_token == initial_token,
        0,
    );
    settings.dialog().close();
    check("closing OTP settings clears the input", field.text().is_empty(), 0);
    println!("smoke: GTK email OTP login and proof across three keyring processes completed");
}
