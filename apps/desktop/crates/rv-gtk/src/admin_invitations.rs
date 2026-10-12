//! Single-account invitation codes, held only for the life of this page.
use crate::{
    admin::{confirm_class, date_time, error_text, spawn},
    i18n::t,
    sidebar_dialog::Host,
};
use adw::prelude::*;
use rv_core::admin::Admin;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
pub(crate) fn page(admin: &Admin, host: &Host) -> adw::PreferencesPage {
    let page = adw::PreferencesPage::new();
    let form = adw::PreferencesGroup::builder()
        .title(t("admin.cat.invitations"))
        .description(t("admin.invitation_hint"))
        .build();
    let code = adw::EntryRow::builder().title(t("login.invitation")).visible(false).build();
    code.set_editable(false);
    let copy = gtk::Button::with_label(t("admin.invitation_copy"));
    copy.set_visible(false);
    let add = gtk::Button::with_label(t("admin.invitation_create"));
    add.add_css_class("suggested-action");
    let status = adw::ActionRow::builder().title(t("admin.invitation_secret")).visible(false).build();
    form.add(&add);
    form.add(&status);
    form.add(&code);
    form.add(&copy);
    page.add(&form);
    let list = adw::PreferencesGroup::new();
    page.add(&list);
    let refresh = gtk::Button::with_label(t("admin.invitation_refresh"));
    list.set_header_suffix(Some(&refresh));
    let shown: Rc<RefCell<Vec<gtk::Widget>>> = Rc::default();
    let sequence = Rc::new(Cell::new(0u64));
    let reload: Rc<dyn Fn()> = {
        let (admin, host, list, shown, sequence) =
            (admin.clone(), host.clone(), list.clone(), shown.clone(), sequence.clone());
        Rc::new(move || {
            sequence.set(sequence.get() + 1);
            let expected = sequence.get();
            let (work, admin, h, list, shown, sequence) =
                (admin.clone(), admin.clone(), host.clone(), list.clone(), shown.clone(), sequence.clone());
            spawn(&host, async move { work.invitations().await }, move |result| {
                if sequence.get() != expected {
                    return;
                }
                for row in shown.borrow_mut().drain(..) {
                    list.remove(&row);
                }
                let mut widgets = Vec::new();
                match result {
                    Err(e) => {
                        let row = adw::ActionRow::builder().title(error_text(&e)).build();
                        list.add(&row);
                        widgets.push(row.upcast());
                    }
                    Ok(items) => {
                        if items.is_empty() {
                            let row = adw::ActionRow::builder().title(t("admin.invitation_empty")).build();
                            list.add(&row);
                            widgets.push(row.upcast());
                        }
                        for item in items {
                            let expired = chrono::DateTime::parse_from_rfc3339(&item.expires_at)
                                .is_ok_and(|d| d <= chrono::Utc::now());
                            let key = if item.revoked_at.is_some() {
                                "admin.invitation_revoked"
                            } else if item.consumed_at.is_some() {
                                "admin.invitation_used"
                            } else if expired {
                                "admin.invitation_expired"
                            } else {
                                "admin.invitation_active"
                            };
                            let row = adw::ActionRow::builder()
                                .title(&item.id)
                                .subtitle(format!("{} · {}", t(key), date_time(&item.expires_at)))
                                .use_markup(false)
                                .build();
                            if key == "admin.invitation_active" {
                                let revoke = gtk::Button::with_label(t("admin.invitation_revoke"));
                                revoke.set_valign(gtk::Align::Center);
                                row.add_suffix(&revoke);
                                let (a, h, id, row) = (admin.clone(), h.clone(), item.id.clone(), row.clone());
                                revoke.connect_clicked(move |button| {
                                    let (a, h, id, row, button) =
                                        (a.clone(), h.clone(), id.clone(), row.clone(), button.clone());
                                    let parent = h.clone();
                                    confirm_class(
                                        &parent,
                                        t("admin.invitation_revoke"),
                                        t("admin.invitation_revoke_body"),
                                        t("admin.invitation_revoke"),
                                        "admin-confirm",
                                        move || {
                                            let (a, id, row, button) =
                                                (a.clone(), id.clone(), row.clone(), button.clone());
                                            button.set_sensitive(false);
                                            let h2 = h.clone();
                                            spawn(&h, async move { a.revoke_invitation(&id).await }, move |result| {
                                                match result {
                                                    Ok(()) => {
                                                        row.set_subtitle(t("admin.invitation_revoked"));
                                                        button.set_visible(false);
                                                    }
                                                    Err(e) => {
                                                        button.set_sensitive(true);
                                                        h2.toast(error_text(&e));
                                                    }
                                                }
                                            });
                                        },
                                    );
                                });
                            }
                            list.add(&row);
                            widgets.push(row.upcast());
                        }
                    }
                }
                *shown.borrow_mut() = widgets;
            });
        })
    };
    reload();
    let r = reload.clone();
    refresh.connect_clicked(move |_| r());
    let c = code.clone();
    copy.connect_clicked(move |b| b.clipboard().set_text(&c.text()));
    let (admin, host) = (admin.clone(), host.clone());
    add.connect_clicked(move |button| {
        button.set_sensitive(false);
        let (a, h, code, copy, status, button, reload) =
            (admin.clone(), host.clone(), code.clone(), copy.clone(), status.clone(), button.clone(), reload.clone());
        spawn(&host, async move { a.create_invitation(168).await }, move |result| {
            button.set_sensitive(true);
            match result {
                Ok(issued) => {
                    code.set_text(&issued.token);
                    code.set_visible(true);
                    copy.set_visible(true);
                    status.set_visible(true);
                    reload();
                }
                Err(e) => h.toast(error_text(&e)),
            }
        });
    });
    page
}
