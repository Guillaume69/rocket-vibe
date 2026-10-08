use adw::prelude::*;
use gtk::glib;

use crate::i18n::t;
use crate::widgets;

type Rgba = (f64, f64, f64, f64);

/// Decorative starry sky, as fractions of the page: (x, y, radius px, colour).
const STARS: [(f64, f64, f64, Rgba); 12] = [
    (0.08, 0.12, 5.0, (1.0, 1.0, 1.0, 0.5)),
    (0.83, 0.18, 6.0, (1.0, 0.83, 0.31, 0.7)),
    (0.16, 0.33, 4.5, (0.20, 0.88, 0.82, 0.6)),
    (0.90, 0.43, 5.5, (1.0, 1.0, 1.0, 0.4)),
    (0.07, 0.62, 5.0, (0.65, 0.55, 0.98, 0.55)),
    (0.77, 0.74, 4.5, (0.20, 0.88, 0.82, 0.4)),
    (0.30, 0.85, 4.0, (1.0, 1.0, 1.0, 0.35)),
    (0.62, 0.08, 4.5, (0.65, 0.55, 0.98, 0.5)),
    (0.40, 0.22, 3.5, (1.0, 1.0, 1.0, 0.35)),
    (0.95, 0.88, 5.0, (1.0, 0.83, 0.31, 0.6)),
    (0.22, 0.95, 4.5, (0.65, 0.55, 0.98, 0.5)),
    (0.68, 0.55, 3.5, (1.0, 1.0, 1.0, 0.3)),
];

pub struct LoginPage {
    pub widget: gtk::Overlay,
    credentials: gtk::Box,
    server: gtk::Entry,
    kind: gtk::DropDown,
    /// kChat: the account's team servers, shown when it has several.
    kchat_row: gtk::Box,
    kchat_servers: gtk::DropDown,
    kchat_urls: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
    user: gtk::Entry,
    password: gtk::Entry,
    signup: gtk::CheckButton,
    recovery: gtk::CheckButton,
    recovery_email: std::rc::Rc<crate::login_recovery::RecoveryEmail>,
    invitation: gtk::Entry,
    code_step: gtk::Box,
    code_intro: gtk::Label,
    code_caption: gtk::Label,
    code: gtk::Entry,
    factor_selector: gtk::DropDown,
    native_methods: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
    factor_resume: gtk::Label,
    factor_mail: gtk::Box,
    factor_mail_send: gtk::Button,
    factor_mail_resend: gtk::Button,
    factor_mail_status: gtk::Label,
    mail_known: std::rc::Rc<std::cell::Cell<bool>>,
    error: gtk::Label,
    submit: gtk::Button,
    back: gtk::Button,
    known: gtk::FlowBox,
    cancel: gtk::Button,
}

fn hero() -> gtk::Box {
    let hero = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).margin_bottom(10).build();
    hero.append(&gtk::Label::builder().label("🦄").css_classes(["unicorn-hero"]).build());
    let bars = gtk::Box::builder().spacing(5).halign(gtk::Align::Center).margin_top(8).margin_bottom(8).build();
    for colour in ["rainbow-pink", "rainbow-yellow", "rainbow-cyan", "rainbow-violet"] {
        bars.append(&gtk::Box::builder().css_classes(["rainbow-bar", colour]).build());
    }
    hero.append(&bars);
    hero.append(&widgets::brand("brand-hero"));
    hero.append(&gtk::Label::builder().label(t("login.slogan")).css_classes(["slogan"]).build());
    hero
}

/// Four-pointed sparkles drawn with Cairo, so they need no font.
fn starry(page: &gtk::Widget) -> gtk::Overlay {
    let sky = gtk::DrawingArea::builder().can_target(false).hexpand(true).vexpand(true).build();
    sky.set_draw_func(|_, cr, w, h| {
        for (fx, fy, r, (red, green, blue, alpha)) in STARS {
            let (x, y) = (fx * w as f64, fy * h as f64);
            let r = r * 1.4;
            let k = r * 0.18;
            cr.move_to(x, y - r);
            cr.curve_to(x + k, y - k, x + k, y - k, x + r, y);
            cr.curve_to(x + k, y + k, x + k, y + k, x, y + r);
            cr.curve_to(x - k, y + k, x - k, y + k, x - r, y);
            cr.curve_to(x - k, y - k, x - k, y - k, x, y - r);
            cr.close_path();
            cr.set_source_rgba(red, green, blue, alpha);
            let _ = cr.fill();
        }
    });
    let overlay = gtk::Overlay::new();
    overlay.set_child(Some(&sky));
    overlay.add_overlay(page);
    overlay
}
fn code_fields(code: &gtk::Entry, caption: &gtk::Label, intro: &gtk::Label, method: Option<&str>) {
    let (label, help, secret) = match method {
        Some("email") => (t("login.code_email"), t("login.intro_email"), false),
        Some("password") => (t("login.code_password"), t("login.intro_password"), true),
        Some("recovery_code") => (t("login.code_recovery_code"), t("login.intro_recovery_code"), true),
        _ => (t("login.code_totp"), t("login.intro_totp"), false),
    };
    caption.set_label(label);
    intro.set_label(help);
    code.set_text("");
    code.set_visibility(!secret);
    code.set_input_purpose(if secret { gtk::InputPurpose::FreeForm } else { gtk::InputPurpose::Digits });
    if secret {
        code.remove_css_class("code");
        code.set_placeholder_text(None);
    } else {
        code.add_css_class("code");
        code.set_placeholder_text(Some(if method == Some("email") { "12345678" } else { "123456" }));
    }
}

fn server_kind(kind: &gtk::DropDown) -> rv_core::native::ServerKind {
    use rv_core::native::ServerKind;
    match kind.selected() {
        1 => ServerKind::RocketChat,
        2 => ServerKind::RocketVibe,
        3 => ServerKind::Mattermost,
        4 => ServerKind::Kchat,
        _ => ServerKind::Auto,
    }
}

impl LoginPage {
    pub fn new() -> Self {
        let (server_group, server) = widgets::pill_field(t("login.server"), "chat.example.com", false);
        let (user_group, user) = widgets::pill_field(t("login.user"), "jane.doe", false);
        let (password_group, password) = widgets::pill_field(t("login.password"), "", true);
        let password_caption = password_group.first_child().and_downcast::<gtk::Label>().expect("password caption");
        let credentials = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(14).build();
        credentials.append(&hero());
        credentials.append(&server_group);
        // Found by probing; forced when the probe gets it wrong behind an
        // unusual proxy.
        let kind = gtk::DropDown::from_strings(&[
            t("login.kind_auto"),
            t("login.kind_rocketchat"),
            t("login.kind_rocketvibe"),
            t("login.kind_mattermost"),
            t("login.kind_kchat"),
        ]);
        kind.set_tooltip_text(Some(t("login.kind")));
        let kind_row = gtk::Box::builder().spacing(10).margin_start(14).build();
        kind_row.append(&gtk::Label::builder().label(t("login.kind")).css_classes(["file-detail"]).build());
        kind_row.append(&kind);
        credentials.append(&kind_row);
        let kchat_servers = gtk::DropDown::from_strings(&[]);
        let kchat_row = gtk::Box::builder().spacing(10).margin_start(14).visible(false).build();
        kchat_row.append(&gtk::Label::builder().label(t("login.kchat_server")).css_classes(["file-detail"]).build());
        kchat_row.append(&kchat_servers);
        credentials.append(&kchat_row);
        let probe =
            gtk::Label::builder().css_classes(["probe"]).xalign(0.0).wrap(true).visible(false).margin_start(14).build();
        credentials.append(&probe);
        let known = gtk::FlowBox::builder()
            .selection_mode(gtk::SelectionMode::None)
            .column_spacing(6)
            .row_spacing(6)
            .max_children_per_line(3)
            .visible(false)
            .build();
        credentials.append(&known);
        credentials.append(&user_group);
        credentials.append(&password_group);
        let signup = gtk::CheckButton::builder().label(t("login.create_account")).visible(false).build();
        credentials.append(&signup);
        let recovery = gtk::CheckButton::builder().label(t("login.recover_account")).visible(false).build();
        credentials.append(&recovery);
        let (invitation_group, invitation) = widgets::pill_field(t("login.invitation"), "", true);
        let invitation_caption =
            invitation_group.first_child().and_downcast::<gtk::Label>().expect("invitation caption");
        invitation_group.set_visible(false);
        let invitation_help =
            gtk::Label::builder().label(t("login.invitation_help")).wrap(true).xalign(0.0).visible(false).build();
        credentials.append(&invitation_group);
        credentials.append(&invitation_help);

        let back = gtk::Button::builder().css_classes(["flat", "back-link"]).halign(gtk::Align::Start).build();
        let back_content = gtk::Box::builder().spacing(8).build();
        back_content.append(&gtk::Label::builder().label("‹").css_classes(["chevron"]).build());
        back_content.append(&gtk::Label::new(Some(t("login.sign_in"))));
        back.set_child(Some(&back_content));

        let code_intro =
            gtk::Label::builder().css_classes(["step-intro"]).justify(gtk::Justification::Center).wrap(true).build();
        let (code_group, code) = widgets::pill_field(t("login.code_totp"), "123456", false);
        code.add_css_class("code");
        EditableExt::set_alignment(&code, 0.5);
        code.set_input_purpose(gtk::InputPurpose::Digits);
        let code_caption = code_group.first_child().and_downcast::<gtk::Label>().expect("caption");
        let code_step = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).visible(false).build();
        code_step.append(&back);
        code_step.append(&gtk::Label::builder().label("🛡️").css_classes(["shield"]).margin_top(6).build());
        code_step.append(&gtk::Label::builder().label(t("login.magic")).css_classes(["step-title"]).build());
        code_step.append(&code_intro);
        let factor_selector = gtk::DropDown::builder().visible(false).build();
        let native_methods = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
        let methods = native_methods.clone();
        let factor_mail = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).visible(false).build();
        let factor_mail_send = gtk::Button::builder().label(t("email.send_code")).build();
        let factor_mail_resend = gtk::Button::builder().label(t("email.resend_code")).visible(false).build();
        let factor_mail_status = gtk::Label::builder().wrap(true).xalign(0.0).build();
        let mail_known = std::rc::Rc::new(std::cell::Cell::new(false));
        factor_mail.append(&factor_mail_send);
        factor_mail.append(&factor_mail_resend);
        factor_mail.append(&factor_mail_status);
        factor_selector.connect_selected_notify(glib::clone!(
            #[weak]
            code,
            #[weak]
            code_caption,
            #[weak]
            code_intro,
            #[weak]
            factor_mail,
            move |selector| {
                if let Some(method) = methods.borrow().get(selector.selected() as usize) {
                    code_fields(&code, &code_caption, &code_intro, Some(method));
                    factor_mail.set_visible(method == "email");
                }
            }
        ));
        code_step.append(&factor_selector);
        code_step.append(&factor_mail);
        code_group.set_margin_top(14);
        code_step.append(&code_group);
        let factor_resume = gtk::Label::builder().label(t("login.factor_resume")).wrap(true).visible(false).build();
        code_step.append(&factor_resume);

        let error = gtk::Label::builder().css_classes(["login-error"]).wrap(true).xalign(0.0).visible(false).build();
        let submit = widgets::cta(t("login.sign_in"));
        let recovery_email =
            crate::login_recovery::RecoveryEmail::new(&server, &user, &recovery, &credentials, &submit);
        credentials.append(&recovery_email.widget);
        signup.connect_toggled(glib::clone!(
            #[weak]
            recovery,
            #[weak]
            invitation_caption,
            #[weak]
            password_caption,
            #[weak]
            invitation_group,
            #[weak]
            invitation_help,
            #[weak]
            invitation,
            #[weak]
            submit,
            move |button| {
                if button.is_active() {
                    recovery.set_active(false);
                }
                invitation_caption.set_label(t("login.invitation"));
                password_caption.set_label(t("login.password"));
                invitation_help.set_label(t("login.invitation_help"));
                invitation_group.set_visible(button.is_active());
                invitation_help.set_visible(button.is_active());
                invitation.set_text("");
                submit.set_label(t(if button.is_active() { "login.create_account" } else { "login.sign_in" }));
            }
        ));
        recovery.connect_toggled(glib::clone!(
            #[weak]
            signup,
            #[weak]
            invitation_group,
            #[weak]
            invitation_help,
            #[weak]
            invitation,
            #[weak]
            invitation_caption,
            #[weak]
            password_caption,
            #[weak]
            submit,
            move |button| {
                if button.is_active() {
                    signup.set_active(false);
                }
                invitation_group.set_visible(button.is_active());
                invitation_help.set_visible(button.is_active());
                invitation.set_text("");
                invitation_caption.set_label(t("login.recovery_code"));
                password_caption.set_label(t(if button.is_active() { "login.new_password" } else { "login.password" }));
                invitation_help.set_label(t("login.recovery_help"));
                submit.set_label(t(if button.is_active() { "login.reset_password" } else { "login.sign_in" }));
            }
        ));
        let cancel = gtk::Button::builder().label(t("login.cancel_add")).css_classes(["flat"]).visible(false).build();

        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(16)
            .valign(gtk::Align::Center)
            .margin_top(32)
            .margin_bottom(32)
            .margin_start(26)
            .margin_end(26)
            .build();
        column.append(&credentials);
        column.append(&code_step);
        column.append(&error);
        column.append(&submit);
        column.append(&cancel);
        let clamp = adw::Clamp::builder().maximum_size(400).child(&column).build();
        let scroller = gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).child(&clamp).build();
        let page = adw::ToolbarView::new();
        page.add_top_bar(&adw::HeaderBar::builder().show_title(false).build());
        page.set_content(Some(&scroller));

        server.connect_activate(glib::clone!(
            #[weak]
            user,
            move |_| {
                user.grab_focus();
            }
        ));
        user.connect_activate(glib::clone!(
            #[weak]
            password,
            move |_| {
                password.grab_focus();
            }
        ));

        let generation = std::rc::Rc::new(std::cell::Cell::new(0u64));
        // Another kind asks the probe again, under that kind.
        // kChat: no address and no user, the token names the account and its
        // servers come from the kChat directory.
        kind.connect_selected_notify(glib::clone!(
            #[weak]
            server,
            #[weak]
            server_group,
            #[weak]
            user_group,
            #[weak]
            kchat_row,
            move |kind| {
                let kchat = server_kind(kind) == rv_core::native::ServerKind::Kchat;
                server_group.set_visible(!kchat);
                user_group.set_visible(!kchat);
                kchat_row.set_visible(false);
                server.emit_by_name::<()>("changed", &[])
            }
        ));
        server.connect_changed(glib::clone!(
            #[weak]
            kind,
            #[weak]
            password_caption,
            #[weak]
            recovery_email,
            #[weak]
            probe,
            #[weak]
            signup,
            #[weak]
            recovery,
            move |entry| {
                signup.set_active(false);
                signup.set_visible(false);
                recovery.set_active(false);
                recovery.set_visible(false);
                let current = generation.get() + 1;
                generation.set(current);
                let text = if server_kind(&kind) == rv_core::native::ServerKind::Kchat {
                    rv_core::mattermost::KCHAT_DIRECTORY.to_owned()
                } else {
                    entry.text().to_string()
                };
                let generation = generation.clone();
                let recovery_email = recovery_email.clone();
                glib::timeout_add_local_once(std::time::Duration::from_millis(600), move || {
                    if generation.get() != current {
                        return;
                    }
                    let Some(url) = rv_core::session::normalize_server(&text) else {
                        probe.set_visible(false);
                        return;
                    };
                    let chosen = server_kind(&kind);
                    glib::spawn_future_local(async move {
                        let found = crate::on_tokio(async move { rv_core::server::probe_as(&url, chosen).await }).await;
                        if generation.get() != current {
                            return;
                        }
                        probe.set_visible(true);
                        probe.remove_css_class("bad");
                        let token = matches!(&found, Ok(p) if p.genre == "kchat");
                        password_caption.set_label(t(if token { "login.kchat_token" } else { "login.password" }));
                        match found {
                            Ok(p) if !p.password_login => {
                                probe.add_css_class("bad");
                                probe.set_label(t("login.probe_no_password"));
                            }
                            Ok(p) => {
                                recovery_email.profile(&p);
                                signup.set_visible(p.genre == "rocketvibe" && p.account_invitations);
                                recovery.set_visible(p.genre == "rocketvibe" && p.account_recovery);
                                let product = rv_core::server::product(&p.genre);
                                let mut facts = vec![format!("{product} {}", p.version).trim_end().to_owned()];
                                if token {
                                    facts.push(t("login.kchat_help").to_owned());
                                }
                                if p.two_factor {
                                    facts.push(t("login.probe_2fa").to_owned());
                                }
                                if p.e2e {
                                    facts.push(t("login.probe_e2e").to_owned());
                                }
                                probe.set_label(&facts.join(" · "));
                            }
                            Err(e) => {
                                probe.add_css_class("bad");
                                probe.set_label(t(if e.error.as_deref() == Some("not_native") {
                                    "login.not_rocketvibe"
                                } else {
                                    "login.probe_failed"
                                }));
                            }
                        }
                    });
                });
            }
        ));

        LoginPage {
            widget: starry(page.upcast_ref()),
            credentials,
            server,
            kind,
            kchat_row,
            kchat_servers,
            kchat_urls: std::rc::Rc::default(),
            user,
            password,
            signup,
            recovery,
            recovery_email,
            invitation,
            code_step,
            code_intro,
            code_caption,
            code,
            factor_selector,
            native_methods,
            factor_resume,
            factor_mail,
            factor_mail_send,
            factor_mail_resend,
            factor_mail_status,
            mail_known,
            error,
            submit,
            back,
            known,
            cancel,
        }
    }

    /// Servers signed in to before, most recent first: a click fills the field.
    pub fn set_known(&self, servers: &[String]) {
        while let Some(child) = self.known.first_child() {
            self.known.remove(&child);
        }
        for server in servers {
            let host = url::Url::parse(server)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
                .unwrap_or_else(|| server.clone());
            let chip = gtk::Button::builder().label(host).css_classes(["known-server"]).tooltip_text(server).build();
            let (entry, user, server) = (self.server.clone(), self.user.clone(), server.clone());
            chip.connect_clicked(move |_| {
                entry.set_text(&server);
                user.grab_focus();
            });
            self.known.insert(&chip, -1);
        }
        self.known.set_visible(!servers.is_empty());
    }

    /// Shown while another account is still signed in: back to it.
    pub fn set_cancel(&self, visible: bool) {
        self.cancel.set_visible(visible);
    }

    pub fn connect_cancel(&self, f: impl Fn() + 'static) {
        self.cancel.connect_clicked(move |_| f());
    }

    pub fn connect_submit(&self, f: impl Fn() + Clone + 'static) {
        let g = f.clone();
        self.submit.connect_clicked(move |_| f());
        let h = g.clone();
        self.password.connect_activate(move |_| g());
        self.code.connect_activate(move |_| h());
    }

    pub fn connect_back(&self, f: impl Fn() + 'static) {
        self.back.connect_clicked(move |_| f());
    }
    pub fn connect_mail(&self, f: impl Fn(bool) + Clone + 'static) {
        let resend = f.clone();
        self.factor_mail_send.connect_clicked(move |_| f(false));
        self.factor_mail_resend.connect_clicked(move |_| resend(true));
    }
    pub fn request_native_mail(&self, resend: bool) -> bool {
        if self.is_busy() || !self.factor_mail.is_visible() || (resend && !self.mail_known.get()) {
            return false;
        }
        if resend {
            self.factor_mail_resend.emit_clicked();
        } else {
            self.factor_mail_send.emit_clicked();
        }
        true
    }
    pub fn native_mail_known(&self) -> bool {
        self.mail_known.get()
    }

    /// The address typed; for kChat the team server picked, else the kChat directory.
    pub fn server(&self) -> String {
        if self.server_kind() != rv_core::native::ServerKind::Kchat {
            return self.server.text().into();
        }
        let picked = self.kchat_row.is_visible().then(|| self.kchat_servers.selected() as usize);
        picked
            .and_then(|i| self.kchat_urls.borrow().get(i).cloned())
            .unwrap_or_else(|| rv_core::mattermost::KCHAT_DIRECTORY.to_owned())
    }

    /// The account's kChat team servers, as `(name, url)`, to pick one.
    pub fn show_kchat_servers(&self, servers: &[(String, String)]) {
        let names: Vec<&str> = servers.iter().map(|(name, _)| name.as_str()).collect();
        self.kchat_servers.set_model(Some(&gtk::StringList::new(&names)));
        self.kchat_urls.replace(servers.iter().map(|(_, url)| url.clone()).collect());
        self.kchat_row.set_visible(true);
    }

    pub fn set_server_kind(&self, kind: rv_core::native::ServerKind) {
        use rv_core::native::ServerKind;
        self.kind.set_selected(match kind {
            ServerKind::Auto => 0,
            ServerKind::RocketChat => 1,
            ServerKind::RocketVibe => 2,
            ServerKind::Mattermost => 3,
            ServerKind::Kchat => 4,
        });
    }

    /// The kind of server chosen under the address.
    pub fn server_kind(&self) -> rv_core::native::ServerKind {
        server_kind(&self.kind)
    }

    pub fn set_server(&self, server: &str) {
        self.server.set_text(server);
    }

    pub fn user(&self) -> String {
        self.user.text().into()
    }

    pub fn password(&self) -> String {
        self.password.text().into()
    }
    pub fn invitation(&self) -> Option<String> {
        (self.signup.is_visible() && self.signup.is_active()).then(|| self.invitation.text().trim().to_owned())
    }
    pub fn fill_invitation(&self, token: &str) -> bool {
        if !self.signup.is_visible() {
            return false;
        }
        self.signup.set_active(true);
        self.invitation.set_text(token);
        true
    }
    pub fn recovery_code(&self) -> Option<String> {
        (self.recovery.is_visible() && self.recovery.is_active()).then(|| self.invitation.text().trim().to_owned())
    }
    pub fn fill_recovery(&self, token: &str) -> bool {
        if !self.recovery.is_visible() {
            return false;
        }
        self.recovery.set_active(true);
        self.invitation.set_text(token);
        true
    }
    pub fn clear_secrets(&self) {
        self.recovery_email.close();
        self.password.set_text("");
        self.invitation.set_text("");
        self.signup.set_active(false);
        self.recovery.set_active(false);
        self.code.set_text("");
    }
    pub fn close_recovery_email(&self) {
        self.recovery_email.close();
    }
    pub fn recovery_email_view(&self) -> Option<rv_core::native::email_recovery::FormView> {
        self.recovery_email.view()
    }
    pub fn request_recovery_email(&self) -> bool {
        self.recovery_email.request()
    }
    pub fn focus_recovery_email(&self) {
        self.recovery_email.focus();
    }
    pub fn is_busy(&self) -> bool {
        !self.submit.is_sensitive()
    }

    pub fn code(&self) -> String {
        self.code.text().into()
    }
    pub fn clear_factor_code(&self) {
        self.code.set_text("");
    }
    pub fn has_error(&self) -> bool {
        self.error.is_visible()
    }

    pub fn fill(&self, server: &str, user: &str, password: &str) {
        self.server.set_text(server);
        self.user.set_text(user);
        self.password.set_text(password);
    }

    pub fn set_busy(&self, busy: bool) {
        self.submit.set_sensitive(!busy);
        self.credentials.set_sensitive(!busy);
        self.code_step.set_sensitive(!busy);
        self.cancel.set_sensitive(!busy);
        let asking = self.code_step.is_visible();
        self.submit.set_label(match (busy, asking) {
            (true, _) => t("login.signing_in"),
            (false, true) => t("login.confirm"),
            (false, false) => t(if self.recovery.is_active() {
                "login.reset_password"
            } else if self.signup.is_active() {
                "login.create_account"
            } else {
                "login.sign_in"
            }),
        });
    }

    pub fn set_error(&self, error: Option<&str>) {
        self.error.set_label(error.unwrap_or_default());
        self.error.set_visible(error.is_some());
    }

    /// `Some(method)` switches to the second-factor step, `None` back to credentials.
    pub fn ask_code(&self, method: Option<&str>) {
        let asking = method.is_some();
        self.credentials.set_visible(!asking);
        self.code_step.set_visible(asking);
        self.native_methods.borrow_mut().clear();
        self.factor_selector.set_visible(false);
        self.factor_resume.set_visible(false);
        self.factor_mail.set_visible(false);
        self.factor_mail_status.set_label("");
        self.mail_known.set(false);
        code_fields(&self.code, &self.code_caption, &self.code_intro, method);
        self.set_busy(false);
        if asking {
            self.code.grab_focus();
        } else if self.user.text().is_empty() {
            self.user.grab_focus();
        } else {
            self.password.grab_focus();
        }
    }
    pub fn ask_native_code(&self, saved: &rv_core::native::authentication::LoginChallenge) -> bool {
        use rv_core::native::authentication::method_name;
        let selected = self.native_method();
        let methods = saved.challenge.methods.iter().map(|m| method_name(*m).to_owned()).collect::<Vec<_>>();
        let Some(first) = methods.iter().find(|m| Some(*m) == selected.as_ref()).or_else(|| methods.first()) else {
            return false;
        };
        self.ask_code(Some(first));
        let labels = methods
            .iter()
            .map(|method| {
                t(match method.as_str() {
                    "recovery_code" => "login.factor_backup",
                    "email" => "login.factor_email",
                    _ => "login.factor_totp",
                })
            })
            .collect::<Vec<_>>();
        let model = gtk::StringList::new(&labels);
        let index = methods.iter().position(|m| m == first).unwrap();
        let is_email = first == "email";
        self.native_methods.replace(methods);
        self.factor_selector.set_model(Some(&model));
        self.factor_selector.set_selected(index as u32);
        self.factor_selector.set_visible(labels.len() > 1);
        self.factor_resume.set_visible(saved.pending.is_some());
        self.factor_mail.set_visible(is_email);
        self.mail_known.set(saved.email.as_ref().is_some_and(|i| i.status.is_some()));
        self.factor_mail_send.set_label(t(if saved.email.is_some() {
            "email.resume_delivery"
        } else {
            "email.send_code"
        }));
        self.factor_mail_resend.set_visible(self.mail_known.get());
        self.factor_mail_status.set_label(email_delivery_text(saved.email.as_ref()));
        true
    }
    pub fn native_method(&self) -> Option<String> {
        self.native_methods.borrow().get(self.factor_selector.selected() as usize).cloned()
    }
    pub fn fill_factor(&self, method: &str, code: &str) -> bool {
        let selected = self.native_methods.borrow().iter().position(|m| m == method);
        let Some(selected) = selected else { return false };
        self.factor_selector.set_selected(selected as u32);
        self.code.set_text(code);
        true
    }
}

pub(crate) fn email_delivery_text(intent: Option<&rv_core::native::factor_email::Intent>) -> &'static str {
    use rv_core::native::security::email::EmailDeliveryState;
    t(match intent {
        None => "email.request_code",
        Some(intent) => match intent.status.as_ref().map(|s| &s.delivery) {
            None => "email.delivery_unknown",
            Some(EmailDeliveryState::Queued) => "email.queued",
            Some(EmailDeliveryState::Sending) => "email.sending",
            Some(EmailDeliveryState::Deferred) => "email.deferred",
            Some(EmailDeliveryState::Accepted) => "email.accepted",
            Some(EmailDeliveryState::Exhausted) => "email.exhausted",
        },
    })
}
