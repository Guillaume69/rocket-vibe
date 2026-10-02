//! The existing sign-in form displays only the anonymous request's safe view.
use crate::i18n::{t, tf};
use adw::prelude::*;
use gtk::glib;
use rv_core::native::{
    Identity,
    email_recovery::{Form, Scope},
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

pub struct RecoveryEmail {
    pub widget: gtk::Box,
    status: gtk::Label,
    error: gtk::Label,
    send: gtk::Button,
    forget: gtk::Button,
    forget_help: gtk::Label,
    server: gtk::Entry,
    user: gtk::Entry,
    recovery: gtk::CheckButton,
    credentials: gtk::Box,
    submit: gtk::Button,
    profile: RefCell<Option<(String, Identity)>>,
    form: RefCell<Option<Arc<Form>>>,
    generation: Cell<u64>,
    busy: Cell<bool>,
}
impl Drop for RecoveryEmail {
    fn drop(&mut self) {
        if let Some(form) = self.form.get_mut().take() {
            form.close();
        }
    }
}
impl RecoveryEmail {
    pub fn new(
        server: &gtk::Entry,
        user: &gtk::Entry,
        recovery: &gtk::CheckButton,
        credentials: &gtk::Box,
        submit: &gtk::Button,
    ) -> Rc<Self> {
        let widget = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).visible(false).build();
        let status = gtk::Label::builder().wrap(true).xalign(0.0).build();
        let error = gtk::Label::builder().wrap(true).xalign(0.0).css_classes(["login-error"]).visible(false).build();
        let send = gtk::Button::builder().label(t("recovery_email.send")).build();
        let forget = gtk::Button::builder().label(t("recovery_email.forget")).visible(false).build();
        let forget_help =
            gtk::Label::builder().label(t("recovery_email.forget_help")).wrap(true).xalign(0.0).visible(false).build();
        for child in [
            status.upcast_ref::<gtk::Widget>(),
            send.upcast_ref(),
            forget.upcast_ref(),
            forget_help.upcast_ref(),
            error.upcast_ref(),
        ] {
            widget.append(child);
        }
        let this = Rc::new(Self {
            widget,
            status,
            error,
            send,
            forget,
            forget_help,
            server: server.clone(),
            user: user.clone(),
            recovery: recovery.clone(),
            credentials: credentials.clone(),
            submit: submit.clone(),
            profile: RefCell::default(),
            form: RefCell::default(),
            generation: Cell::default(),
            busy: Cell::default(),
        });
        let weak = Rc::downgrade(&this);
        user.connect_changed(move |_| {
            if let Some(this) = weak.upgrade() {
                this.refresh();
            }
        });
        let weak = Rc::downgrade(&this);
        server.connect_changed(move |_| {
            if let Some(this) = weak.upgrade() {
                this.profile.replace(None);
                this.refresh();
            }
        });
        let weak = Rc::downgrade(&this);
        recovery.connect_toggled(move |_| {
            if let Some(this) = weak.upgrade() {
                this.refresh();
            }
        });
        for (button, forget) in [(&this.send, false), (&this.forget, true)] {
            let weak = Rc::downgrade(&this);
            button.connect_clicked(move |_| {
                if let Some(this) = weak.upgrade() {
                    this.act(forget);
                }
            });
        }
        let weak = Rc::downgrade(&this);
        glib::timeout_add_local(std::time::Duration::from_secs(1), move || {
            let Some(this) = weak.upgrade() else { return glib::ControlFlow::Break };
            this.render();
            glib::ControlFlow::Continue
        });
        this
    }
    pub fn profile(self: &Rc<Self>, profile: &rv_core::server::ServerProfile) {
        self.profile.replace(if profile.genre == "rocketvibe" && profile.account_recovery && profile.email_recovery {
            profile.native_identity.clone().map(|i| (profile.base_url.clone(), i))
        } else {
            None
        });
        self.refresh();
    }
    pub fn close(&self) {
        self.generation.set(self.generation.get().wrapping_add(1));
        if let Some(form) = self.form.replace(None) {
            form.close();
        }
        if self.busy.replace(false) {
            self.credentials.set_sensitive(true);
            self.submit.set_sensitive(true);
        }
        self.widget.set_visible(false);
    }
    fn refresh(self: &Rc<Self>) {
        self.close();
        self.error.set_visible(false);
        if !self.recovery.is_active() {
            return;
        }
        let Some((base, identity)) = self.profile.borrow().clone() else { return };
        let Some(url) = rv_core::session::normalize_server(&self.server.text()) else { return };
        if url.as_str().trim_end_matches('/') != base {
            return;
        }
        let username = self.user.text().trim().to_owned();
        let Ok(scope) = Scope::from_identity(&base, &username, &identity) else { return };
        self.widget.set_visible(true);
        self.send.set_visible(true);
        self.send.set_sensitive(false);
        self.forget.set_visible(false);
        self.forget_help.set_visible(false);
        self.status.set_label(t("recovery_email.loading"));
        let (weak, generation) = (Rc::downgrade(self), self.generation.get());
        glib::timeout_add_local_once(std::time::Duration::from_millis(350), move || {
            let Some(this) = weak.upgrade() else { return };
            if this.generation.get() != generation {
                return;
            }
            glib::spawn_future_local(async move {
                let result =
                    crate::on_tokio(async move { Form::open(crate::secrets::email_recovery_vault(), scope).await })
                        .await;
                if this.generation.get() != generation {
                    if let Ok(form) = result {
                        form.close();
                    }
                    return;
                }
                match result {
                    Ok(form) => {
                        this.form.replace(Some(Arc::new(form)));
                        this.render();
                    }
                    Err(_) => {
                        this.error.set_label(t("recovery_email.storage"));
                        this.error.set_visible(true);
                    }
                }
            });
        });
    }
    pub fn view(&self) -> Option<rv_core::native::email_recovery::FormView> {
        self.form.borrow().as_ref().and_then(|f| f.view())
    }
    pub fn request(&self) -> bool {
        if !self.widget.is_visible()
            || !self.send.is_visible()
            || !self.send.is_sensitive()
            || !self.submit.is_sensitive()
        {
            return false;
        }
        self.send.emit_clicked();
        true
    }
    pub fn focus(&self) {
        if self.send.is_visible() {
            self.send.grab_focus();
        } else if self.forget.is_visible() {
            self.forget.grab_focus();
        }
    }
    fn render(&self) {
        let Some(view) = self.form.borrow().as_ref().and_then(|f| f.view()) else { return };
        let text = t(if view.identity_changed {
            "recovery_email.changed"
        } else if view.expired {
            "recovery_email.expired"
        } else if view.accepted {
            "recovery_email.accepted"
        } else if view.requested {
            "recovery_email.pending"
        } else {
            "recovery_email.help"
        });
        self.status.set_label(&if view.retry_after_seconds > 0 {
            format!("{text}\n{}", tf("recovery_email.wait", &[("seconds", &view.retry_after_seconds.to_string())]))
        } else {
            text.into()
        });
        self.send.set_visible(!view.accepted && !view.expired && !view.identity_changed);
        self.send.set_sensitive(!self.busy.get() && view.retry_after_seconds == 0);
        self.send.set_label(t(if view.requested { "recovery_email.retry" } else { "recovery_email.send" }));
        self.forget.set_visible(view.requested);
        self.forget.set_sensitive(!self.busy.get());
        self.forget_help.set_visible(view.requested);
    }
    fn act(self: &Rc<Self>, forget: bool) {
        if self.busy.get() || !self.submit.is_sensitive() {
            return;
        }
        let Some(form) = self.form.borrow().clone() else { return };
        let Some(view) = form.view() else { return };
        if !forget && (view.expired || view.identity_changed || view.accepted || view.retry_after_seconds > 0) {
            return;
        }
        self.busy.set(true);
        self.error.set_visible(false);
        self.credentials.set_sensitive(false);
        self.submit.set_sensitive(false);
        self.render();
        let (this, generation) = (self.clone(), self.generation.get());
        glib::spawn_future_local(async move {
            let result = crate::on_tokio(async move {
                if forget { form.forget(view.revision).await } else { form.submit(view.revision).await }
            })
            .await;
            if this.generation.get() != generation {
                return;
            }
            this.busy.set(false);
            this.credentials.set_sensitive(true);
            this.submit.set_sensitive(true);
            if let Err(e) = result {
                let e = rv_core::native::rest_error(e);
                this.error.set_label(t(if e.status == 429 {
                    "recovery_email.limited"
                } else if e.error.as_deref() == Some("server_identity_changed") {
                    "recovery_email.changed"
                } else if e.error.as_deref() == Some("secure_storage_unavailable") {
                    "recovery_email.storage"
                } else {
                    "recovery_email.failed"
                }));
                this.error.set_visible(true);
            }
            this.render();
        });
    }
}
