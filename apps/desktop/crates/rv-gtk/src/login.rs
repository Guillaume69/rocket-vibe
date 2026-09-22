use adw::prelude::*;
use gtk::glib;

pub struct LoginPage {
    pub widget: adw::ToolbarView,
    subtitle: gtk::Label,
    credentials: adw::PreferencesGroup,
    server: adw::EntryRow,
    user: adw::EntryRow,
    password: adw::PasswordEntryRow,
    code_group: adw::PreferencesGroup,
    code: adw::EntryRow,
    error: gtk::Label,
    submit: gtk::Button,
    back: gtk::Button,
}

impl LoginPage {
    pub fn new() -> Self {
        let brand = gtk::Label::builder().label("rocket-vibe").css_classes(["brand"]).build();
        let subtitle = gtk::Label::builder()
            .label("Sign in to your Rocket.Chat server.")
            .css_classes(["dim-label"])
            .wrap(true)
            .justify(gtk::Justification::Center)
            .build();

        let server = adw::EntryRow::builder().title("Server").build();
        let user = adw::EntryRow::builder().title("Username or email").build();
        let password = adw::PasswordEntryRow::builder().title("Password").build();
        let credentials = adw::PreferencesGroup::new();
        credentials.add(&server);
        credentials.add(&user);
        credentials.add(&password);

        let code = adw::EntryRow::builder().title("Code").build();
        let code_group = adw::PreferencesGroup::builder().visible(false).build();
        code_group.add(&code);

        let error = gtk::Label::builder().css_classes(["error"]).wrap(true).visible(false).build();
        let submit = gtk::Button::builder().label("Sign in").css_classes(["suggested-action", "pill"]).build();
        let back = gtk::Button::builder().label("Back").css_classes(["flat"]).visible(false).build();

        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(18)
            .valign(gtk::Align::Center)
            .margin_top(24)
            .margin_bottom(24)
            .margin_start(16)
            .margin_end(16)
            .build();
        for w in [
            brand.upcast_ref::<gtk::Widget>(),
            subtitle.upcast_ref(),
            credentials.upcast_ref(),
            code_group.upcast_ref(),
            error.upcast_ref(),
            submit.upcast_ref(),
            back.upcast_ref(),
        ] {
            column.append(w);
        }
        let clamp = adw::Clamp::builder().maximum_size(420).child(&column).build();
        let widget = adw::ToolbarView::new();
        widget.add_top_bar(&adw::HeaderBar::builder().show_title(false).build());
        widget.set_content(Some(&clamp));

        server.connect_entry_activated(glib::clone!(
            #[weak]
            user,
            move |_| {
                user.grab_focus();
            }
        ));
        user.connect_entry_activated(glib::clone!(
            #[weak]
            password,
            move |_| {
                password.grab_focus();
            }
        ));

        LoginPage { widget, subtitle, credentials, server, user, password, code_group, code, error, submit, back }
    }

    pub fn connect_submit(&self, f: impl Fn() + Clone + 'static) {
        let g = f.clone();
        self.submit.connect_clicked(move |_| f());
        let h = g.clone();
        self.password.connect_entry_activated(move |_| g());
        self.code.connect_entry_activated(move |_| h());
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

    pub fn set_busy(&self, busy: bool) {
        self.submit.set_sensitive(!busy);
        let asking = self.code_group.is_visible();
        self.submit.set_label(match (busy, asking) {
            (true, _) => "Signing in…",
            (false, true) => "Verify",
            (false, false) => "Sign in",
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
        self.code_group.set_visible(asking);
        self.back.set_visible(asking);
        self.code.set_text("");
        self.subtitle.set_label(match method {
            Some("totp") => "Enter the code from your authenticator app.",
            Some("email") => "Enter the code sent to your email.",
            Some(_) => "Confirm your password.",
            None => "Sign in to your Rocket.Chat server.",
        });
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
