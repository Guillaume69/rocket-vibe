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
    user: gtk::Entry,
    password: gtk::Entry,
    code_step: gtk::Box,
    code_intro: gtk::Label,
    code_caption: gtk::Label,
    code: gtk::Entry,
    error: gtk::Label,
    submit: gtk::Button,
    back: gtk::Button,
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

impl LoginPage {
    pub fn new() -> Self {
        let (server_group, server) = widgets::pill_field(t("login.server"), "chat.example.com", false);
        let (user_group, user) = widgets::pill_field(t("login.user"), "jane.doe", false);
        let (password_group, password) = widgets::pill_field(t("login.password"), "", true);
        let credentials = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(14).build();
        credentials.append(&hero());
        credentials.append(&server_group);
        credentials.append(&user_group);
        credentials.append(&password_group);

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
        code_group.set_margin_top(14);
        code_step.append(&code_group);

        let error = gtk::Label::builder().css_classes(["login-error"]).wrap(true).xalign(0.0).visible(false).build();
        let submit = widgets::cta(t("login.sign_in"));

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

        LoginPage {
            widget: starry(page.upcast_ref()),
            credentials,
            server,
            user,
            password,
            code_step,
            code_intro,
            code_caption,
            code,
            error,
            submit,
            back,
        }
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

    pub fn server(&self) -> String {
        self.server.text().into()
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

    pub fn code(&self) -> String {
        self.code.text().into()
    }

    pub fn fill(&self, server: &str, user: &str, password: &str) {
        self.server.set_text(server);
        self.user.set_text(user);
        self.password.set_text(password);
    }

    pub fn set_busy(&self, busy: bool) {
        self.submit.set_sensitive(!busy);
        let asking = self.code_step.is_visible();
        self.submit.set_label(match (busy, asking) {
            (true, _) => t("login.signing_in"),
            (false, true) => t("login.confirm"),
            (false, false) => t("login.sign_in"),
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
        self.code.set_text("");
        let (caption, intro, secret) = match method {
            Some("email") => (t("login.code_email"), t("login.intro_email"), false),
            Some("password") => (t("login.code_password"), t("login.intro_password"), true),
            _ => (t("login.code_totp"), t("login.intro_totp"), false),
        };
        self.code_caption.set_label(caption);
        self.code_intro.set_label(intro);
        self.code.set_visibility(!secret);
        self.set_busy(false);
        if asking {
            self.code.grab_focus();
        } else if self.user.text().is_empty() {
            self.user.grab_focus();
        } else {
            self.password.grab_focus();
        }
    }
}
