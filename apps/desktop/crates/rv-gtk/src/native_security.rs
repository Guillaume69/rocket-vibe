//! Native security, the Security category of the settings. No active account
//! is written; cancelled views retain private durable intents for recovery.
use crate::{
    i18n::{t, tn},
    on_tokio, secrets,
    sidebar_dialog::Host,
};
use adw::prelude::*;
use email::{EmailDeliveryState, EmailStatus};
use gtk::glib;
use rv_core::native::{
    NativeSession,
    authentication::{SecondFactor, method_name},
    security::{
        Access, EmailFactorExpectation, FactorAction, FactorState, Guard, ProofAttempt, ProofState, Remote, Scope,
        Setup, email,
    },
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

/// The category's page; it loads the account's state as it is built, and
/// forgets what it showed when the settings close.
pub fn page(host: &Host, session: Arc<NativeSession>) -> adw::PreferencesPage {
    let page = adw::PreferencesPage::new();
    page.add_css_class("native-security-page");
    page.add_css_class("native-security-dialog");
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
    let proof_mail_send = button("email.send_code", "native-security-proof-mail-send");
    let proof_mail_resend = button("email.resend_code", "native-security-proof-mail-resend");
    let proof_mail_status = adw::ActionRow::builder().css_classes(["native-security-proof-mail-status"]).build();
    proof_group.add(&methods);
    proof_group.add(&proof_mail_send);
    proof_group.add(&proof_mail_resend);
    proof_group.add(&proof_mail_status);
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
    let email_group = adw::PreferencesGroup::builder().title(t("email.title")).description(t("email.private")).build();
    let email_current =
        adw::ActionRow::builder().title(t("email.none")).css_classes(["native-security-email-current"]).build();
    let email_address =
        adw::EntryRow::builder().title(t("email.address")).css_classes(["native-security-email-address"]).build();
    let email_start = button("email.start", "native-security-email-start");
    let email_remove = button("email.remove", "native-security-email-remove");
    email_remove.add_css_class("destructive-action");
    let email_factor_status = adw::ActionRow::builder().css_classes(["native-security-email-factor-status"]).build();
    let email_factor = button("email.factor_enable", "native-security-email-factor");
    let email_pending =
        adw::ActionRow::builder().title(t("email.pending")).css_classes(["native-security-email-pending"]).build();
    let email_code =
        adw::PasswordEntryRow::builder().title(t("email.code")).css_classes(["native-security-email-code"]).build();
    let email_confirm = button("email.confirm", "native-security-email-confirm");
    let email_cancel = button("email.cancel", "native-security-email-cancel");
    let email_verified = adw::ActionRow::builder().title(t("email.verified")).build();
    let email_ack = button("email.done", "native-security-email-acknowledge");
    let email_stale = adw::ActionRow::builder().title(t("email.stale")).build();
    let email_retire = button("email.restart", "native-security-email-retire");
    email_group.add(&email_current);
    email_group.add(&email_factor_status);
    email_group.add(&email_factor);
    email_group.add(&email_address);
    email_group.add(&email_start);
    email_group.add(&email_remove);
    email_group.add(&email_pending);
    email_group.add(&email_code);
    email_group.add(&email_confirm);
    email_group.add(&email_cancel);
    email_group.add(&email_verified);
    email_group.add(&email_ack);
    email_group.add(&email_stale);
    email_group.add(&email_retire);
    page.add(&email_group);
    let refresh_group = adw::PreferencesGroup::new();
    let refresh = button("security.refresh", "native-security-refresh");
    refresh_group.add(&refresh);
    page.add(&refresh_group);
    let state = Rc::new(Controller {
        host: host.clone(),
        session,
        guard: Guard::new(),
        busy: Cell::new(false),
        page: page.clone(),
        status,
        password_group,
        password,
        proof_group,
        methods,
        proof_code,
        proof_mail_send,
        proof_mail_resend,
        proof_mail_status,
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
        email_group,
        email_current,
        email_address,
        email_start,
        email_remove,
        email_factor_status,
        email_factor,
        email_pending,
        email_code,
        email_confirm,
        email_cancel,
        email_verified,
        email_ack,
        email_stale,
        email_retire,
        email: RefCell::new(None),
        email_revision: Cell::new(0),
        proof: RefCell::new(ProofState::Password),
        factor: RefCell::new(FactorState::Idle),
        factor_status: RefCell::new(None),
        scope: RefCell::new(None),
    });
    let close = state.clone();
    host.connect_closed(move || close.cancel());
    if let Some(window) = host.widget().and_then(|dialog| dialog.root()).and_downcast::<gtk::Window>() {
        let weak = Rc::downgrade(&state);
        window.connect_visible_notify(move |window| {
            if !window.is_visible()
                && let Some(state) = weak.upgrade()
            {
                state.cancel();
                state.host.close();
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
    for (row, resend) in [(&state.proof_mail_send, false), (&state.proof_mail_resend, true)] {
        let weak = Rc::downgrade(&state);
        row.connect_activated(move |_| {
            let Some(state) = weak.upgrade() else { return };
            let saved = match &*state.proof.borrow() {
                ProofState::Challenge(saved) => Some((**saved).clone()),
                _ => None,
            };
            state.proof_code.set_text("");
            if let Some(saved) = saved {
                state.run(Work::ProofMail(saved, resend));
            }
        });
    }
    let weak = Rc::downgrade(&state);
    state.methods.connect_selected_notify(move |row| {
        if let Some(state) = weak.upgrade() {
            state.proof_code.set_text("");
            if let ProofState::Challenge(saved) = &*state.proof.borrow()
                && let Some(method) = saved.challenge().and_then(|c| c.methods.get(row.selected() as usize))
            {
                state.proof_code.set_title(t(match method_name(*method) {
                    "recovery_code" => "login.code_recovery_code",
                    "email" => "email.code",
                    _ => "login.code_totp",
                }));
            }
            state.render_proof_mail();
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
            let Some(parent) = state.host.widget() else { return };
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
    state.email_factor.connect_activated(move |_| {
        let Some(state) = weak.upgrade() else { return };
        if !state.guard.alive()
            || state.busy.get()
            || !state.session.email_factors_supported()
            || !matches!(*state.factor.borrow(), FactorState::Idle)
        {
            return;
        }
        let Some(contact) = state.email.borrow().as_ref().and_then(|view| {
            (matches!(view.state, email::State::Idle) && view.status.address.is_some()).then(|| view.status.clone())
        }) else {
            return;
        };
        let Some(factors) = state.factor_status.borrow().clone() else { return };
        let enabled = !factors.email;
        if enabled && !state.session.email_factor_delivery_supported() {
            return;
        }
        let expected = EmailFactorExpectation { contact, factors, enabled };
        let revision = state.email_revision.get();
        let Some(parent) = state.host.widget() else { return };
        let key = if enabled { "email.factor_enable" } else { "email.factor_disable" };
        let body = if enabled { "email.factor_enable_body" } else { "email.factor_disable_body" };
        let alert = adw::AlertDialog::builder()
            .heading(t(key))
            .body(format!("{}\n\n{}", expected.contact.address.as_deref().unwrap_or(""), t(body)))
            .css_classes(["native-security-email-factor-confirm"])
            .default_response("cancel")
            .close_response("cancel")
            .build();
        alert.add_responses(&[("cancel", t("actions.cancel")), ("confirm", t(key))]);
        alert.set_response_appearance(
            "confirm",
            if enabled { adw::ResponseAppearance::Suggested } else { adw::ResponseAppearance::Destructive },
        );
        let weak = Rc::downgrade(&state);
        alert.connect_response(Some("confirm"), move |_, _| {
            if let Some(state) = weak.upgrade()
                && state.email_revision.get() == revision
            {
                state.email_address.set_text("");
                state.email_code.set_text("");
                state.proof_code.set_text("");
                state.run(Work::EmailFactor(expected.clone()));
            }
        });
        alert.present(Some(&parent));
    });
    let weak = Rc::downgrade(&state);
    state.email_start.connect_activated(move |_| {
        if let Some(state) = weak.upgrade() {
            let expected = state
                .email
                .borrow()
                .as_ref()
                .and_then(|view| matches!(view.state, email::State::Idle).then(|| view.status.clone()));
            let address = state.email_address.text().trim().to_owned();
            state.email_address.set_text("");
            if let Some(expected) = expected {
                state.run(Work::EmailStart(address, expected));
            }
        }
    });
    let weak = Rc::downgrade(&state);
    state.email_remove.connect_activated(move |_| {
        let Some(state) = weak.upgrade() else { return };
        if !state.guard.alive() || state.busy.get() || !state.session.email_removal_supported() {
            return;
        }
        let Some(expected) = state.email.borrow().as_ref().and_then(|view| {
            (matches!(view.state, email::State::Idle) && view.status.address.is_some()).then(|| view.status.clone())
        }) else {
            return;
        };
        let revision = state.email_revision.get();
        let Some(parent) = state.host.widget() else { return };
        let alert = adw::AlertDialog::builder()
            .heading(t("email.remove"))
            .body(format!("{}\n\n{}", expected.address.as_deref().unwrap_or(""), t("email.remove_body")))
            .css_classes(["native-security-email-remove-confirm"])
            .default_response("cancel")
            .close_response("cancel")
            .build();
        alert.add_responses(&[("cancel", t("actions.cancel")), ("confirm", t("email.remove"))]);
        alert.set_response_appearance("confirm", adw::ResponseAppearance::Destructive);
        let weak = Rc::downgrade(&state);
        alert.connect_response(Some("confirm"), move |_, _| {
            if let Some(state) = weak.upgrade()
                && state.email_revision.get() == revision
                && state.email.borrow().as_ref().is_some_and(|view| matches!(view.state, email::State::Idle))
            {
                state.email_address.set_text("");
                state.email_code.set_text("");
                state.run(Work::EmailRemove(expected.clone()));
            }
        });
        alert.present(Some(&parent));
    });
    let weak = Rc::downgrade(&state);
    state.email_confirm.connect_activated(move |_| {
        if let Some(state) = weak.upgrade() {
            let receipt = state.email.borrow().as_ref().and_then(|view| {
                if let email::State::Pending { receipt_id, .. } = &view.state { Some(receipt_id.clone()) } else { None }
            });
            let code = state.email_code.text().trim().to_owned();
            state.email_code.set_text("");
            if let Some(receipt) = receipt {
                state.run(Work::EmailConfirm(receipt, code));
            }
        }
    });
    for (row, acknowledge) in [(&state.email_cancel, false), (&state.email_retire, false), (&state.email_ack, true)] {
        let weak = Rc::downgrade(&state);
        row.connect_activated(move |_| {
            if let Some(state) = weak.upgrade() {
                let receipt = state.email.borrow().as_ref().and_then(|view| view.state.receipt().map(str::to_owned));
                state.email_code.set_text("");
                if let Some(receipt) = receipt {
                    state.run(if acknowledge { Work::EmailAck(receipt) } else { Work::EmailCancel(receipt) });
                }
            }
        });
    }
    let weak = Rc::downgrade(&state);
    refresh.connect_activated(move |_| {
        if let Some(state) = weak.upgrade() {
            state.run(Work::Refresh);
        }
    });
    state.render();
    state.run(Work::Refresh);
    page
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
    ProofMail(ProofAttempt, bool),
    Start(FactorAction),
    EmailFactor(EmailFactorExpectation),
    Enable(Setup, String),
    Clear(String),
    Copy(CopyKind),
    EmailStart(String, EmailStatus),
    EmailRemove(EmailStatus),
    EmailConfirm(String, String),
    EmailCancel(String),
    EmailAck(String),
}
struct Loaded {
    access: Access,
    proof: Option<ProofState>,
    factor: Option<FactorState>,
    status: rv_core::native::security::Status,
    recent: bool,
    clipboard: Option<String>,
    email: Option<email::View>,
}
struct Controller {
    host: Host,
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
    proof_mail_send: adw::ButtonRow,
    proof_mail_resend: adw::ButtonRow,
    proof_mail_status: adw::ActionRow,
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
    email_group: adw::PreferencesGroup,
    email_current: adw::ActionRow,
    email_address: adw::EntryRow,
    email_start: adw::ButtonRow,
    email_remove: adw::ButtonRow,
    email_factor_status: adw::ActionRow,
    email_factor: adw::ButtonRow,
    email_pending: adw::ActionRow,
    email_code: adw::PasswordEntryRow,
    email_confirm: adw::ButtonRow,
    email_cancel: adw::ButtonRow,
    email_verified: adw::ActionRow,
    email_ack: adw::ButtonRow,
    email_stale: adw::ActionRow,
    email_retire: adw::ButtonRow,
    email: RefCell<Option<email::View>>,
    email_revision: Cell<u64>,
    proof: RefCell<ProofState>,
    factor: RefCell<FactorState>,
    factor_status: RefCell<Option<rv_core::native::security::Status>>,
    scope: RefCell<Option<Scope>>,
}
impl Controller {
    fn render_proof_mail(&self) {
        let proof = self.proof.borrow();
        let saved = match &*proof {
            ProofState::Challenge(saved) => Some(saved),
            _ => None,
        };
        let selected = saved.and_then(|s| s.challenge()).and_then(|c| c.methods.get(self.methods.selected() as usize));
        let email = selected.is_some_and(|m| matches!(m, SecondFactor::Email));
        let intent = saved.and_then(|s| s.email());
        self.proof_mail_send.set_visible(email);
        self.proof_mail_send.set_sensitive(intent.is_some() || self.session.email_factor_delivery_supported());
        self.proof_mail_send.set_title(t(if intent.is_some() { "email.resume_delivery" } else { "email.send_code" }));
        self.proof_mail_resend.set_visible(email && intent.is_some_and(|i| i.status.is_some()));
        self.proof_mail_resend.set_sensitive(self.session.email_factor_delivery_supported());
        self.proof_mail_status.set_visible(email);
        self.proof_mail_status.set_title(t("email.code"));
        self.proof_mail_status.set_subtitle(crate::login::email_delivery_text(intent));
    }
    fn cancel(&self) {
        self.guard.cancel();
        self.clear();
    }
    fn clear(&self) {
        self.password.set_text("");
        self.proof_code.set_text("");
        self.proof_mail_status.set_subtitle("");
        self.setup_code.set_text("");
        self.secret.set_text("");
        self.codes.set_text("");
        self.proof.replace(ProofState::Password);
        self.factor.replace(FactorState::Idle);
        self.factor_status.replace(None);
        self.email_address.set_text("");
        self.email_code.set_text("");
        self.email_current.set_subtitle("");
        self.email_pending.set_subtitle("");
        self.email.replace(None);
        self.email_revision.set(self.email_revision.get().wrapping_add(1));
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
                    t(match method_name(*method) {
                        "recovery_code" => "login.factor_backup",
                        "email" => "login.factor_email",
                        _ => "login.factor_totp",
                    })
                })
                .collect();
            let model = gtk::StringList::new(&labels);
            let selected = self.methods.selected();
            self.methods.set_model(Some(&model));
            self.methods.set_selected(if (selected as usize) < labels.len() { selected } else { 0 });
            self.methods.set_visible(labels.len() > 1);
        }
        self.render_proof_mail();
        let factor = self.factor.borrow();
        let supported = self.session.factors_supported();
        let email_factors = self.session.email_factors_supported();
        let totp = self.factor_status.borrow().as_ref().is_some_and(|s| s.totp);
        let enabled = self.factor_status.borrow().as_ref().is_some_and(|s| s.totp || s.email);
        self.setup_group.set_visible(supported && matches!(*factor, FactorState::Setup(_)));
        self.codes_group.set_visible((supported || email_factors) && matches!(*factor, FactorState::Codes { .. }));
        self.stale_group.set_visible((supported || email_factors) && matches!(*factor, FactorState::Stale { .. }));
        self.actions.set_visible(loaded && supported && matches!(*factor, FactorState::Idle));
        self.setup.set_visible(!totp);
        self.regenerate.set_visible(enabled);
        self.disable.set_visible(totp);
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
        } else if supported || email_factors {
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
        let email = self.email.borrow();
        let email_loaded = loaded && self.session.email_supported() && email.is_some();
        self.email_group.set_visible(email_loaded);
        let ready = matches!(*proof, ProofState::Ready);
        let phase = email.as_ref().map(|view| &view.state);
        let email_enabled = self.factor_status.borrow().as_ref().is_some_and(|s| s.email);
        self.email_factor_status.set_visible(email_factors);
        self.email_factor_status.set_title(t(if email_enabled {
            "email.factor_enabled"
        } else {
            "email.factor_disabled"
        }));
        self.email_factor_status.set_subtitle(if email_enabled { t("email.factor_contact") } else { "" });
        self.email_factor.set_visible(
            email_factors
                && matches!(*factor, FactorState::Idle)
                && matches!(phase, Some(email::State::Idle))
                && email.as_ref().is_some_and(|view| view.status.address.is_some()),
        );
        self.email_factor.set_title(t(if email_enabled { "email.factor_disable" } else { "email.factor_enable" }));
        self.email_factor.set_sensitive(ready && (email_enabled || self.session.email_factor_delivery_supported()));
        let can_verify =
            !email_enabled && self.session.email_verification_supported() && matches!(phase, Some(email::State::Idle));
        self.email_address.set_visible(can_verify);
        self.email_start.set_visible(can_verify);
        self.email_start.set_sensitive(ready);
        self.email_remove.set_visible(
            self.session.email_removal_supported()
                && !email_enabled
                && matches!(phase, Some(email::State::Idle))
                && email.as_ref().is_some_and(|view| view.status.address.is_some()),
        );
        self.email_remove.set_sensitive(ready);
        self.email_pending
            .set_visible(matches!(phase, Some(email::State::Pending { .. } | email::State::RemovalPending { .. })));
        self.email_code.set_visible(matches!(phase, Some(email::State::Pending { .. })));
        self.email_confirm.set_visible(matches!(phase, Some(email::State::Pending { .. })));
        self.email_confirm.set_sensitive(ready);
        self.email_cancel
            .set_visible(matches!(phase, Some(email::State::Pending { .. } | email::State::RemovalPending { .. })));
        self.email_cancel.set_title(t(if matches!(phase, Some(email::State::RemovalPending { .. })) {
            "email.cancel_removal"
        } else {
            "email.cancel"
        }));
        self.email_verified
            .set_visible(matches!(phase, Some(email::State::Verified { .. } | email::State::Removed { .. })));
        self.email_verified.set_title(t(if matches!(phase, Some(email::State::Removed { .. })) {
            "email.removed"
        } else {
            "email.verified"
        }));
        self.email_ack.set_visible(matches!(phase, Some(email::State::Verified { .. } | email::State::Removed { .. })));
        self.email_stale
            .set_visible(matches!(phase, Some(email::State::Stale { .. } | email::State::RemovalStale { .. })));
        self.email_stale.set_title(t(if matches!(phase, Some(email::State::RemovalStale { .. })) {
            "email.removal_stale"
        } else {
            "email.stale"
        }));
        self.email_retire
            .set_visible(matches!(phase, Some(email::State::Stale { .. } | email::State::RemovalStale { .. })));
        self.email_retire.set_title(t(if matches!(phase, Some(email::State::RemovalStale { .. })) {
            "email.close_removal"
        } else {
            "email.restart"
        }));
        self.email_current.set_title(t(if email.as_ref().is_some_and(|view| view.status.address.is_some()) {
            "email.current"
        } else {
            "email.none"
        }));
        self.email_current.set_subtitle(email.as_ref().and_then(|view| view.status.address.as_deref()).unwrap_or(""));
        if let Some(email::State::Pending { address, delivery, .. }) = phase {
            self.email_pending.set_title(t("email.pending"));
            self.email_pending.set_subtitle(&format!(
                "{address}\n{}",
                t(match delivery {
                    EmailDeliveryState::Queued => "email.queued",
                    EmailDeliveryState::Sending => "email.sending",
                    EmailDeliveryState::Deferred => "email.deferred",
                    EmailDeliveryState::Accepted => "email.accepted",
                    EmailDeliveryState::Exhausted => "email.exhausted",
                })
            ));
        } else {
            self.email_pending.set_title(t("email.removal_pending"));
            self.email_pending.set_subtitle("");
        }
        if !ready {
            self.email_code.set_text("");
        }
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
        let refresh_mail = matches!(work, Work::ProofMail(..));
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
                        let mut email = None;
                        match work {
                            Work::Refresh => {
                                proof = Some(vault.prepare(&scope, &access, "", &guard).await?);
                                if session.factors_supported() || session.email_factors_supported() {
                                    factor = Some(vault.factor_resume(&scope, &access, &guard).await?);
                                }
                            }
                            Work::Password(password) => {
                                proof = Some(vault.prepare(&scope, &access, &password, &guard).await?)
                            }
                            Work::Proof(saved, method, code) => {
                                proof = Some(vault.finish(&saved, &access, method, &code, &guard).await?)
                            }
                            Work::ProofMail(saved, resend) => {
                                proof = Some(vault.send_email(&saved, &access, resend, &guard).await?)
                            }
                            Work::Start(action) => {
                                factor = Some(vault.factor_start(&scope, &access, action, &guard).await?)
                            }
                            Work::EmailFactor(expected) => {
                                if !session.email_factors_supported() {
                                    return Err(rv_core::native::Error::Protocol("unsupported_feature"));
                                }
                                factor = Some(vault.factor_email_start(&scope, &access, &expected, &guard).await?);
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
                            Work::EmailStart(address, expected) => {
                                if !session.email_verification_supported() {
                                    return Err(rv_core::native::Error::Protocol("unsupported_feature"));
                                }
                                email = Some(vault.email_start(&scope, &access, &address, &expected, &guard).await?)
                            }
                            Work::EmailRemove(expected) => {
                                if !session.email_removal_supported() {
                                    return Err(rv_core::native::Error::Protocol("unsupported_feature"));
                                }
                                email = Some(vault.email_remove(&scope, &access, &expected, &guard).await?)
                            }
                            Work::EmailConfirm(receipt, code) => {
                                email = Some(vault.email_confirm(&scope, &access, &receipt, &code, &guard).await?)
                            }
                            Work::EmailCancel(receipt) => {
                                email = Some(vault.email_cancel(&scope, &access, &receipt, &guard).await?)
                            }
                            Work::EmailAck(receipt) => {
                                email = Some(vault.email_acknowledge(&scope, &access, &receipt, &guard).await?)
                            }
                        }
                        if email.is_none() && session.email_supported() {
                            email = Some(vault.email_resume(&scope, &access, &guard).await?);
                        }
                        let status = access.factor_status().await?;
                        let recent = access.status().await?.recent;
                        access.check()?;
                        Ok::<_, rv_core::native::Error>(Loaded {
                            access,
                            proof,
                            factor,
                            status,
                            recent,
                            clipboard,
                            email,
                        })
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
                            state.host.close();
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
                    state.email_code.set_text("");
                    state.email.replace(loaded.email);
                    state.email_revision.set(state.email_revision.get().wrapping_add(1));
                    if !loaded.recent && matches!(*state.proof.borrow(), ProofState::Ready) {
                        state.proof.replace(ProofState::Password);
                    }
                    state.render();
                    if let Some(value) = loaded.clipboard
                        && let Some(dialog) = state.host.widget()
                    {
                        dialog.clipboard().set_text(&value);
                        state.host.toast(t("security.copied"));
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
                        state.host.close();
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
                    if state.host.alive() {
                        state.host.toast(t(if error.code() == "invalid_email_address" {
                            "email.invalid"
                        } else if error.code() == "email_verification_rejected" {
                            "email.rejected"
                        } else if error.code() == "email_removal_rejected" {
                            "email.removal_stale"
                        } else if matches!(
                            error.code(),
                            "email_queue_limit" | "email_delivery_limit" | "email_resend_cooldown"
                        ) {
                            "email.limited"
                        } else if matches!(error.code(), "reauthentication_rejected" | "factor_rejected") {
                            "security.rejected"
                        } else if error.code() == "reauthentication_required" {
                            "security.required"
                        } else {
                            "security.failed"
                        }));
                    }
                    if refresh_mail && state.guard.alive() {
                        state.run(Work::Refresh);
                    }
                }
            }
        });
    }
}
