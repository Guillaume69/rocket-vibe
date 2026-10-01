//! Native security within the existing preferences dialog. No active account
//! is written; cancelled views retain private durable intents for recovery.
use crate::{
    i18n::{t, tn},
    on_tokio, secrets,
};
use adw::prelude::*;
use gtk::glib;
use rv_core::native::{
    NativeSession,
    authentication::{SecondFactor, method_name},
    security::{Access, FactorAction, FactorState, Guard, ProofAttempt, ProofState, Remote, Scope, Setup},
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

pub fn group(parent: &adw::PreferencesDialog, session: Arc<NativeSession>) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::builder().title(t("security.title")).build();
    let open = adw::ButtonRow::builder().title(t("security.title")).css_classes(["native-security-open"]).build();
    group.add(&open);
    let weak = parent.downgrade();
    open.connect_activated(move |_| {
        if let Some(parent) = weak.upgrade() {
            open_dialog(&parent, session.clone());
        }
    });
    group
}
pub fn open_dialog(parent: &impl IsA<gtk::Widget>, session: Arc<NativeSession>) {
    let dialog = adw::PreferencesDialog::builder()
        .title(t("security.title"))
        .content_width(560)
        .content_height(650)
        .css_classes(["native-security-dialog"])
        .build();
    let page = adw::PreferencesPage::new();
    page.add_css_class("native-security-page");
    let status_group = adw::PreferencesGroup::new();
    let status = adw::ActionRow::builder().title(t("security.loading")).css_classes(["native-security-status"]).build();
    status_group.add(&status);
    page.add(&status_group);
    let password_group = adw::PreferencesGroup::builder().title(t("security.required")).build();
    let password =
        adw::PasswordEntryRow::builder().title(t("login.password")).css_classes(["native-security-password"]).build();
    let password_submit = button("security.verify", "native-security-password-submit");
    password_group.add(&password);
    password_group.add(&password_submit);
    page.add(&password_group);
    let proof_group = adw::PreferencesGroup::builder().title(t("security.required")).build();
    let methods = adw::ComboRow::builder().title(t("security.method")).css_classes(["native-security-method"]).build();
    let proof_code = adw::EntryRow::builder().title(t("login.code_totp")).css_classes(["native-security-code"]).build();
    let proof_submit = button("security.verify", "native-security-proof-submit");
    proof_group.add(&methods);
    proof_group.add(&proof_code);
    proof_group.add(&proof_submit);
    page.add(&proof_group);
    let setup_group =
        adw::PreferencesGroup::builder().title(t("security.setup")).description(t("security.setup_body")).build();
    let secret = private_label("native-security-secret");
    setup_group.add(&secret);
    let (copy_secret, copy_uri) = (
        button("security.copy_secret", "native-security-copy-secret"),
        button("security.copy_uri", "native-security-copy-uri"),
    );
    setup_group.add(&copy_secret);
    setup_group.add(&copy_uri);
    let setup_code =
        adw::EntryRow::builder().title(t("login.code_totp")).css_classes(["native-security-setup-code"]).build();
    let enable = button("security.enable", "native-security-enable");
    setup_group.add(&setup_code);
    setup_group.add(&enable);
    page.add(&setup_group);
    let codes_group =
        adw::PreferencesGroup::builder().title(t("security.codes")).description(t("security.codes_body")).build();
    let codes = private_label("native-security-codes");
    codes_group.add(&codes);
    let (copy_codes, ack) = (
        button("security.copy_codes", "native-security-copy-codes"),
        button("security.saved", "native-security-acknowledge"),
    );
    codes_group.add(&copy_codes);
    codes_group.add(&ack);
    page.add(&codes_group);
    let stale_group = adw::PreferencesGroup::builder().description(t("security.stale")).build();
    let discard = button("security.discard", "native-security-discard");
    stale_group.add(&discard);
    page.add(&stale_group);
    let actions = adw::PreferencesGroup::new();
    let (setup, regenerate, disable) = (
        button("security.setup", "native-security-setup"),
        button("security.regenerate", "native-security-regenerate"),
        button("security.disable", "native-security-disable"),
    );
    disable.add_css_class("destructive-action");
    for row in [&setup, &regenerate, &disable] {
        actions.add(row);
    }
    page.add(&actions);
    let refresh_group = adw::PreferencesGroup::new();
    let refresh = button("security.refresh", "native-security-refresh");
    refresh_group.add(&refresh);
    page.add(&refresh_group);
    dialog.add(&page);
    let state = Rc::new(Controller {
        dialog: dialog.downgrade(),
        session,
        guard: Guard::new(),
        busy: Cell::new(false),
        page,
        status,
        password_group,
        password,
        proof_group,
        methods,
        proof_code,
        setup_group,
        secret,
        setup_code,
        codes_group,
        codes,
        stale_group,
        actions,
        setup,
        regenerate,
        disable,
        proof: RefCell::new(ProofState::Password),
        factor: RefCell::new(FactorState::Idle),
        factor_status: RefCell::new(None),
        scope: RefCell::new(None),
    });
    let close = state.clone();
    dialog.connect_closed(move |_| close.cancel());
    let weak = Rc::downgrade(&state);
    dialog.connect_visible_notify(move |dialog| {
        if !dialog.is_visible()
            && let Some(state) = weak.upgrade()
        {
            state.cancel();
        }
    });
    if let Some(window) = parent.root().and_downcast::<gtk::Window>() {
        let weak = Rc::downgrade(&state);
        window.connect_visible_notify(move |window| {
            if !window.is_visible()
                && let Some(state) = weak.upgrade()
            {
                state.cancel();
                if let Some(dialog) = state.dialog.upgrade() {
                    dialog.close();
                }
            }
        });
    }
    let weak = Rc::downgrade(&state);
    password_submit.connect_activated(move |_| {
        if let Some(state) = weak.upgrade() {
            let password = state.password.text().to_string();
            state.password.set_text("");
            state.run(Work::Password(password));
        }
    });
    let weak = Rc::downgrade(&state);
    proof_submit.connect_activated(move |_| {
        if let Some(state) = weak.upgrade() {
            let work = match &*state.proof.borrow() {
                ProofState::Challenge(saved) => saved
                    .challenge()
                    .and_then(|c| c.methods.get(state.methods.selected() as usize))
                    .map(|method| Work::Proof((**saved).clone(), *method, state.proof_code.text().to_string())),
                _ => None,
            };
            state.proof_code.set_text("");
            if let Some(work) = work {
                state.run(work);
            }
        }
    });
    let weak = Rc::downgrade(&state);
    state.methods.connect_selected_notify(move |row| {
        if let Some(state) = weak.upgrade() {
            state.proof_code.set_text("");
            if let ProofState::Challenge(saved) = &*state.proof.borrow()
                && let Some(method) = saved.challenge().and_then(|c| c.methods.get(row.selected() as usize))
            {
                state.proof_code.set_title(t(if method_name(*method) == "recovery_code" {
                    "login.code_recovery_code"
                } else {
                    "login.code_totp"
                }));
            }
        }
    });
    let weak = Rc::downgrade(&state);
    enable.connect_activated(move |_| {
        if let Some(state) = weak.upgrade() {
            let setup = match &*state.factor.borrow() {
                FactorState::Setup(setup) => Some((**setup).clone()),
                _ => None,
            };
            let code = state.setup_code.text().to_string();
            state.setup_code.set_text("");
            if let Some(setup) = setup {
                state.run(Work::Enable(setup, code));
            }
        }
    });
    for (row, kind) in [(&copy_secret, CopyKind::Secret), (&copy_uri, CopyKind::Uri), (&copy_codes, CopyKind::Codes)] {
        let weak = Rc::downgrade(&state);
        row.connect_activated(move |_| {
            if let Some(state) = weak.upgrade() {
                state.run(Work::Copy(kind));
            }
        });
    }
    for row in [&ack, &discard] {
        let weak = Rc::downgrade(&state);
        row.connect_activated(move |_| {
            if let Some(state) = weak.upgrade() {
                let receipt = match &*state.factor.borrow() {
                    FactorState::Codes { receipt_id, .. } | FactorState::Stale { receipt_id } => {
                        Some(receipt_id.clone())
                    }
                    _ => None,
                };
                if let Some(receipt) = receipt {
                    state.run(Work::Clear(receipt));
                }
            }
        });
    }
    let weak = Rc::downgrade(&state);
    state.setup.connect_activated(move |_| {
        if let Some(state) = weak.upgrade() {
            state.run(Work::Start(FactorAction::Setup));
        }
    });
    for (row, kind, key, body) in [
        (&state.regenerate, FactorAction::Regenerate, "security.regenerate", "security.regenerate_body"),
        (&state.disable, FactorAction::Disable, "security.disable", "security.disable_body"),
    ] {
        let weak = Rc::downgrade(&state);
        row.connect_activated(move |_| {
            let Some(state) = weak.upgrade() else { return };
            if !state.guard.alive() || state.busy.get() {
                return;
            }
            let Some(parent) = state.dialog.upgrade() else { return };
            let alert = adw::AlertDialog::builder()
                .heading(t(key))
                .body(t(body))
                .css_classes(["native-security-confirm"])
                .default_response("cancel")
                .close_response("cancel")
                .build();
            alert.add_responses(&[("cancel", t("actions.cancel")), ("confirm", t(key))]);
            alert.set_response_appearance("confirm", adw::ResponseAppearance::Destructive);
            let weak = Rc::downgrade(&state);
            alert.connect_response(Some("confirm"), move |_, _| {
                if let Some(state) = weak.upgrade() {
                    state.run(Work::Start(kind));
                }
            });
            alert.present(Some(&parent));
        });
    }
    let weak = Rc::downgrade(&state);
    refresh.connect_activated(move |_| {
        if let Some(state) = weak.upgrade() {
            state.run(Work::Refresh);
        }
    });
    state.render();
    dialog.present(Some(parent));
    state.run(Work::Refresh);
}
fn button(key: &str, class: &str) -> adw::ButtonRow {
    adw::ButtonRow::builder().title(t(key)).css_classes([class]).build()
}
fn private_label(class: &str) -> gtk::Label {
    gtk::Label::builder()
        .selectable(false)
        .wrap(true)
        .xalign(0.0)
        .margin_top(10)
        .margin_bottom(10)
        .margin_start(12)
        .margin_end(12)
        .css_classes([class, "monospace"])
        .build()
}
#[derive(Clone, Copy)]
enum CopyKind {
    Secret,
    Uri,
    Codes,
}
enum Work {
    Refresh,
    Password(String),
    Proof(ProofAttempt, SecondFactor, String),
    Start(FactorAction),
    Enable(Setup, String),
    Clear(String),
    Copy(CopyKind),
}
struct Loaded {
    access: Access,
    proof: Option<ProofState>,
    factor: Option<FactorState>,
    status: rv_core::native::security::Status,
    recent: bool,
    clipboard: Option<String>,
}
struct Controller {
    dialog: glib::WeakRef<adw::PreferencesDialog>,
    session: Arc<NativeSession>,
    guard: Guard,
    busy: Cell<bool>,
    page: adw::PreferencesPage,
    status: adw::ActionRow,
    password_group: adw::PreferencesGroup,
    password: adw::PasswordEntryRow,
    proof_group: adw::PreferencesGroup,
    methods: adw::ComboRow,
    proof_code: adw::EntryRow,
    setup_group: adw::PreferencesGroup,
    secret: gtk::Label,
    setup_code: adw::EntryRow,
    codes_group: adw::PreferencesGroup,
    codes: gtk::Label,
    stale_group: adw::PreferencesGroup,
    actions: adw::PreferencesGroup,
    setup: adw::ButtonRow,
    regenerate: adw::ButtonRow,
    disable: adw::ButtonRow,
    proof: RefCell<ProofState>,
    factor: RefCell<FactorState>,
    factor_status: RefCell<Option<rv_core::native::security::Status>>,
    scope: RefCell<Option<Scope>>,
}
impl Controller {
    fn cancel(&self) {
        self.guard.cancel();
        self.clear();
    }
    fn clear(&self) {
        self.password.set_text("");
        self.proof_code.set_text("");
        self.setup_code.set_text("");
        self.secret.set_text("");
        self.codes.set_text("");
        self.proof.replace(ProofState::Password);
        self.factor.replace(FactorState::Idle);
        self.factor_status.replace(None);
    }
    fn render(&self) {
        let proof = self.proof.borrow();
        let loaded = self.factor_status.borrow().is_some();
        self.password_group.set_visible(loaded && matches!(*proof, ProofState::Password));
        self.proof_group.set_visible(matches!(*proof, ProofState::Challenge(_)));
        if let ProofState::Challenge(saved) = &*proof
            && let Some(challenge) = saved.challenge()
        {
            let labels: Vec<_> = challenge
                .methods
                .iter()
                .map(|method| {
                    t(if method_name(*method) == "recovery_code" { "login.factor_backup" } else { "login.factor_totp" })
                })
                .collect();
            let model = gtk::StringList::new(&labels);
            let selected = self.methods.selected();
            self.methods.set_model(Some(&model));
            self.methods.set_selected(if (selected as usize) < labels.len() { selected } else { 0 });
            self.methods.set_visible(labels.len() > 1);
        }
        let factor = self.factor.borrow();
        let supported = self.session.factors_supported();
        let enabled = self.factor_status.borrow().as_ref().is_some_and(|s| s.totp);
        self.setup_group.set_visible(supported && matches!(*factor, FactorState::Setup(_)));
        self.codes_group.set_visible(supported && matches!(*factor, FactorState::Codes { .. }));
        self.stale_group.set_visible(supported && matches!(*factor, FactorState::Stale { .. }));
        self.actions.set_visible(loaded && supported && matches!(*factor, FactorState::Idle));
        self.setup.set_visible(!enabled);
        self.regenerate.set_visible(enabled);
        self.disable.set_visible(enabled);
        self.secret.set_text(match &*factor {
            FactorState::Setup(setup) => &setup.secret,
            _ => "",
        });
        self.codes.set_text(&match &*factor {
            FactorState::Codes { codes, .. } => codes.codes.join("\n"),
            _ => String::new(),
        });
        self.status.set_title(t(if !loaded {
            "security.loading"
        } else if supported {
            if enabled { "security.enabled" } else { "security.disabled" }
        } else {
            "security.title"
        }));
        self.status.set_subtitle(&if enabled {
            self.factor_status
                .borrow()
                .as_ref()
                .map(|s| tn("security.remaining", s.backup_codes_remaining as i64))
                .unwrap_or_default()
        } else {
            t(if matches!(*proof, ProofState::Ready) { "security.ready" } else { "security.required" }).into()
        });
    }
    fn run(self: &Rc<Self>, work: Work) {
        if self.busy.get() || !self.guard.alive() {
            return;
        }
        self.busy.set(true);
        self.page.set_sensitive(false);
        let (session, guard, vault) = (self.session.clone(), self.guard.clone(), secrets::security_vault());
        let mut pinned = self.scope.borrow().clone();
        let expected = match &*self.factor.borrow() {
            FactorState::Setup(s) => Some(s.setup_id.clone()),
            FactorState::Codes { receipt_id, .. } => Some(receipt_id.clone()),
            _ => None,
        };
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let result = on_tokio(async move {
                let refresh = matches!(work, Work::Refresh);
                let mut pending = Some(work);
                let mut retries = 0;
                loop {
                    let work = pending.take().unwrap();
                    let result = async {
                        let access = session.security(guard.clone()).await?;
                        let scope = access.scope().clone();
                        if pinned.as_ref().is_some_and(|expected| expected != &scope) {
                            return Err(rv_core::native::Error::Protocol("server_identity_changed"));
                        }
                        pinned = Some(scope.clone());
                        let mut proof = None;
                        let mut factor = None;
                        let mut clipboard = None;
                        match work {
                            Work::Refresh => {
                                proof = Some(vault.prepare(&scope, &access, "", &guard).await?);
                                if session.factors_supported() {
                                    factor = Some(vault.factor_resume(&scope, &access, &guard).await?);
                                }
                            }
                            Work::Password(password) => {
                                proof = Some(vault.prepare(&scope, &access, &password, &guard).await?)
                            }
                            Work::Proof(saved, method, code) => {
                                proof = Some(vault.finish(&saved, &access, method, &code, &guard).await?)
                            }
                            Work::Start(action) => {
                                factor = Some(vault.factor_start(&scope, &access, action, &guard).await?)
                            }
                            Work::Enable(setup, code) => {
                                factor = Some(vault.factor_enable(&scope, &access, &setup, &code, &guard).await?)
                            }
                            Work::Clear(receipt) => {
                                if vault.factor_clear(&scope, &receipt, &guard).await? {
                                    factor = Some(FactorState::Idle);
                                }
                            }
                            Work::Copy(kind) => {
                                let fresh = vault.factor_resume(&scope, &access, &guard).await?;
                                clipboard = match (&fresh, kind) {
                                    (FactorState::Setup(setup), CopyKind::Secret | CopyKind::Uri)
                                        if expected.as_deref() == Some(&setup.setup_id) =>
                                    {
                                        Some(if matches!(kind, CopyKind::Secret) {
                                            setup.secret.clone()
                                        } else {
                                            setup.provisioning_uri.clone()
                                        })
                                    }
                                    (FactorState::Codes { receipt_id, codes }, CopyKind::Codes)
                                        if expected.as_deref() == Some(receipt_id) =>
                                    {
                                        Some(codes.codes.join("\n"))
                                    }
                                    _ => None,
                                };
                                factor = Some(fresh);
                            }
                        }
                        let status = access.factor_status().await?;
                        let recent = access.status().await?.recent;
                        access.check()?;
                        Ok::<_, rv_core::native::Error>(Loaded { access, proof, factor, status, recent, clipboard })
                    }
                    .await;
                    let retry =
                        result.as_ref().is_err_and(|error| matches!(error.code(), "offline" | "session_closed"));
                    if !refresh || !retry || session.is_closed() || retries >= 2 {
                        return result;
                    }
                    // Refresh only resumes the durable operation. Wait for a new
                    // runner after the source invalidates a factor's old socket;
                    // never resend a password/code or create another intention.
                    retries += 1;
                    for _ in 0..200 {
                        guard.check()?;
                        if session.is_closed() {
                            return Err(rv_core::native::Error::Protocol("session_closed"));
                        }
                        if session.status().connection == rv_core::session::Connection::Online {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    pending = Some(Work::Refresh);
                }
            })
            .await;
            let Some(state) = weak.upgrade() else { return };
            if !state.guard.alive() {
                return;
            }
            state.busy.set(false);
            state.page.set_sensitive(true);
            match result {
                Ok(loaded) => {
                    if loaded.access.check().is_err() {
                        if state.session.is_closed() {
                            state.cancel();
                            if let Some(dialog) = state.dialog.upgrade() {
                                dialog.close();
                            }
                        } else {
                            state.clear();
                            state.render();
                        }
                        return;
                    }
                    state.scope.replace(Some(loaded.access.scope().clone()));
                    if let Some(proof) = loaded.proof {
                        state.proof.replace(proof);
                    }
                    if let Some(factor) = loaded.factor {
                        state.factor.replace(factor);
                    }
                    state.factor_status.replace(Some(loaded.status));
                    if !loaded.recent && matches!(*state.proof.borrow(), ProofState::Ready) {
                        state.proof.replace(ProofState::Password);
                    }
                    state.render();
                    if let Some(value) = loaded.clipboard
                        && let Some(dialog) = state.dialog.upgrade()
                    {
                        dialog.clipboard().set_text(&value);
                        dialog.add_toast(adw::Toast::new(t("security.copied")));
                    }
                }
                Err(error) => {
                    if std::env::var_os("RV_SMOKE_SECURITY").is_some() {
                        eprintln!(
                            "smoke: native security request failed: {}; provider {:?}",
                            error.code(),
                            state.session.status()
                        );
                    }
                    if error.code() == "reauthentication_required" {
                        state.proof.replace(ProofState::Password);
                    }
                    if matches!(error.code(), "server_identity_changed" | "session_rejected")
                        || (error.code() == "session_closed" && state.session.is_closed())
                    {
                        state.cancel();
                        if let Some(dialog) = state.dialog.upgrade() {
                            dialog.close();
                        }
                        return;
                    }
                    if error.code() == "session_closed" {
                        // The runner generation changed, e.g. a factor mutation
                        // invalidated its socket. Discard the stale result and
                        // private display, but allow an explicit refresh to pin
                        // the new runner on this same active family.
                        state.clear();
                    }
                    state.render();
                    if let Some(dialog) = state.dialog.upgrade() {
                        dialog.add_toast(adw::Toast::new(t(
                            if matches!(error.code(), "reauthentication_rejected" | "factor_rejected") {
                                "security.rejected"
                            } else if error.code() == "reauthentication_required" {
                                "security.required"
                            } else {
                                "security.failed"
                            },
                        )));
                    }
                }
            }
        });
    }
}
