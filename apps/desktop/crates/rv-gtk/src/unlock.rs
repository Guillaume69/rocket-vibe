//! The E2E password prompt that opens encrypted rooms for this session. It
//! stays up until the password works.

use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::e2e::E2eError;
use rv_core::session::{Session, UnlockError};

use crate::i18n::t;
use crate::on_tokio;

pub fn ask(parent: &impl IsA<gtk::Widget>, session: Arc<Session>) {
    let column =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(12).css_classes(["details"]).build();
    column.append(&gtk::Label::builder().label("🔒").css_classes(["shield"]).build());
    column.append(
        &gtk::Label::builder()
            .label(t("e2e.body"))
            .wrap(true)
            .justify(gtk::Justification::Center)
            .css_classes(["details-sub"])
            .build(),
    );
    let password = gtk::PasswordEntry::builder()
        .placeholder_text(t("e2e.password"))
        .show_peek_icon(true)
        .activates_default(true)
        .build();
    let error = gtk::Label::builder().css_classes(["login-error"]).wrap(true).visible(false).build();
    let unlock =
        gtk::Button::builder().label(t("e2e.unlock")).css_classes(["file-action"]).halign(gtk::Align::End).build();
    column.append(&password);
    column.append(&error);
    column.append(&unlock);
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(&column));
    let dialog =
        adw::Dialog::builder().title(t("e2e.title")).content_width(400).child(&view).default_widget(&unlock).build();
    unlock.connect_clicked(glib::clone!(
        #[weak]
        dialog,
        #[weak]
        password,
        #[weak]
        error,
        move |button| {
            let (s, typed, button) = (session.clone(), password.text().to_string(), button.clone());
            button.set_sensitive(false);
            glib::spawn_future_local(async move {
                let result = on_tokio(async move { s.e2e_unlock(&typed).await }).await;
                button.set_sensitive(true);
                let message = match result {
                    Ok(()) => {
                        dialog.close();
                        return;
                    }
                    Err(UnlockError::Key(E2eError::WrongPassword)) => t("e2e.wrong"),
                    Err(UnlockError::Key(E2eError::NoKeys)) => t("e2e.no_keys"),
                    Err(_) => t("e2e.failed"),
                };
                error.set_label(message);
                error.set_visible(true);
                password.grab_focus();
            });
        }
    ));
    dialog.present(Some(parent));
    password.grab_focus();
}
