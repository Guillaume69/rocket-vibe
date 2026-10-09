//! The administration's Custom emoji category: the server's emoji, each with
//! its image, name and aliases and a delete button, and "Add" opening a form
//! (name, aliases, image file). rv-core's `Admin` does the work for both
//! providers and refreshes the session's index, so pickers follow at once.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::{Rc, Weak};

use adw::prelude::*;
use gtk::gio;
use rv_core::admin::{Admin, AdminEmoji};

use crate::admin::{confirm_class, spawn};
use crate::i18n::{t, tf};
use crate::sidebar_dialog::Host;

/// Reads the list again, once the page exists.
type Reload = Rc<dyn Fn()>;
/// Where the page keeps its reload, for the closures built before it.
type Slot = Rc<RefCell<Option<Reload>>>;

pub(crate) fn page(admin: &Admin, host: &Host) -> adw::PreferencesPage {
    let page = adw::PreferencesPage::builder().css_classes(["admin-emoji"]).build();
    let group = adw::PreferencesGroup::builder().title(t("admin.cat.emoji")).description(t("admin.emoji_hint")).build();
    let add = gtk::Button::builder()
        .icon_name("list-add-symbolic")
        .tooltip_text(t("admin.emoji_add"))
        .css_classes(["flat", "admin-emoji-add"])
        .valign(gtk::Align::Center)
        .build();
    group.set_header_suffix(Some(&add));
    page.add(&group);
    let rows: Rc<RefCell<Vec<gtk::Widget>>> = Rc::default();
    let reload: Slot = Rc::default();
    let load: Reload = {
        // Weak: the slot holds this very closure (and the rows a weak one).
        let (admin, host, group, rows, weak) =
            (admin.clone(), host.clone(), group.clone(), rows.clone(), Rc::downgrade(&reload));
        Rc::new(move || {
            let (work, admin, host2, group, rows, weak) =
                (admin.clone(), admin.clone(), host.clone(), group.clone(), rows.clone(), weak.clone());
            spawn(&host, async move { work.emojis().await }, move |result| {
                let Some(again) = weak.upgrade().and_then(|slot| slot.borrow().as_ref().map(Rc::downgrade)) else {
                    return;
                };
                for row in rows.borrow_mut().drain(..) {
                    group.remove(&row);
                }
                let shown: Vec<gtk::Widget> = match result {
                    Ok(list) if list.is_empty() => {
                        vec![adw::ActionRow::builder().title(t("admin.emoji_empty")).build().upcast()]
                    }
                    Ok(list) => list.into_iter().map(|emoji| row(&admin, &host2, emoji, &again).upcast()).collect(),
                    Err(error) => vec![
                        adw::ActionRow::builder().title(t(rv_core::admin::error_key(&error.code))).build().upcast(),
                    ],
                };
                for widget in &shown {
                    group.add(widget);
                }
                *rows.borrow_mut() = shown;
            });
        })
    };
    reload.replace(Some(load.clone()));
    load();
    // The button keeps the slot, so the reload lives as long as the page.
    let (admin, host) = (admin.clone(), host.clone());
    add.connect_clicked(move |_| {
        if let Some(load) = reload.borrow().clone() {
            form(&admin, &host, load);
        }
    });
    page
}

fn row(admin: &Admin, host: &Host, emoji: AdminEmoji, reload: &Weak<dyn Fn()>) -> adw::ActionRow {
    let aliases: Vec<String> = emoji.aliases.iter().map(|a| format!(":{a}:")).collect();
    let row = adw::ActionRow::builder()
        .title(format!(":{}:", emoji.name))
        .subtitle(aliases.join(" "))
        .use_markup(false)
        .css_classes(["admin-emoji-row"])
        .build();
    if let Some(image) = crate::markdown_view::custom_emoji(&emoji.name) {
        image.set_size_request(32, 32);
        image.set_valign(gtk::Align::Center);
        row.add_prefix(&image);
    }
    let delete = gtk::Button::builder()
        .icon_name("user-trash-symbolic")
        .tooltip_text(t("admin.emoji_delete"))
        .css_classes(["flat", "destructive-action"])
        .valign(gtk::Align::Center)
        .build();
    row.add_suffix(&delete);
    let (admin, host, reload) = (admin.clone(), host.clone(), reload.clone());
    delete.connect_clicked(move |_| {
        let (admin, host, reload, emoji) = (admin.clone(), host.clone(), reload.clone(), emoji.clone());
        let body = tf("admin.emoji_delete_body", &[("name", &emoji.name)]);
        let h = host.clone();
        confirm_class(
            &host,
            t("admin.emoji_delete_title"),
            &body,
            t("admin.emoji_delete"),
            "admin-confirm",
            move || {
                let (admin, host, reload, emoji) = (admin.clone(), h.clone(), reload.clone(), emoji.clone());
                let h = host.clone();
                spawn(&host, async move { admin.delete_emoji(&emoji).await }, move |result| {
                    match result {
                        Ok(()) => h.toast(t("admin.emoji_deleted")),
                        Err(error) => h.toast(t(rv_core::admin::error_key(&error.code))),
                    }
                    if let Some(load) = reload.upgrade() {
                        load();
                    }
                });
            },
        );
    });
    row
}

/// The creation form, pushed over the list; it pops back once added.
fn form(admin: &Admin, host: &Host, reload: Reload) {
    let page = adw::PreferencesPage::builder().css_classes(["admin-emoji-form"]).build();
    let group = adw::PreferencesGroup::new();
    let name = adw::EntryRow::builder().title(t("admin.emoji_name")).build();
    let aliases = adw::EntryRow::builder().title(t("admin.emoji_aliases")).build();
    let image = adw::ActionRow::builder().title(t("admin.emoji_image")).subtitle(t("admin.emoji_image_hint")).build();
    let preview = gtk::Image::builder().pixel_size(32).visible(false).build();
    image.add_prefix(&preview);
    let choose = gtk::Button::builder().label(t("admin.emoji_choose")).valign(gtk::Align::Center).build();
    image.add_suffix(&choose);
    group.add(&name);
    group.add(&aliases);
    group.add(&image);
    page.add(&group);
    let submit = gtk::Button::builder()
        .label(t("admin.emoji_add"))
        .css_classes(["suggested-action", "pill"])
        .halign(gtk::Align::Center)
        .sensitive(false)
        .build();
    let actions = adw::PreferencesGroup::new();
    actions.add(&submit);
    page.add(&actions);
    let file: Rc<RefCell<Option<PathBuf>>> = Rc::default();
    // A name, and an image, before anything is sent.
    let ready = {
        let (name, file, submit) = (name.clone(), file.clone(), submit.clone());
        Rc::new(move || submit.set_sensitive(!name.text().trim().is_empty() && file.borrow().is_some()))
    };
    let r = ready.clone();
    name.connect_changed(move |_| r());
    let (f, p, row, r) = (file.clone(), preview.clone(), image.clone(), ready.clone());
    choose.connect_clicked(move |button| {
        let filter = gtk::FileFilter::new();
        for mime in ["image/png", "image/jpeg", "image/gif"] {
            filter.add_mime_type(mime);
        }
        let filters = gio::ListStore::new::<gtk::FileFilter>();
        filters.append(&filter);
        let chooser = gtk::FileDialog::builder().title(t("admin.emoji_choose")).filters(&filters).modal(true).build();
        let window = button.root().and_downcast::<gtk::Window>();
        let (f, p, row, r) = (f.clone(), p.clone(), row.clone(), r.clone());
        chooser.open(window.as_ref(), None::<&gio::Cancellable>, move |chosen| {
            let Some(path) = chosen.ok().and_then(|c| c.path()) else { return };
            p.set_from_file(Some(&path));
            p.set_visible(true);
            row.set_subtitle(&path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            f.replace(Some(path));
            r();
        });
    });
    let navigation = host.push(t("admin.emoji_add"), &page);
    let (admin, host) = (admin.clone(), host.clone());
    submit.connect_clicked(move |button| {
        let Some(path) = file.borrow().clone() else { return };
        button.set_sensitive(false);
        let (admin, code, alias_text) = (admin.clone(), name.text().to_string(), aliases.text().to_string());
        let (h, button, reload, navigation) = (host.clone(), button.clone(), reload.clone(), navigation.clone());
        spawn(
            &host,
            async move {
                let mime = crate::attach::mime_of(&path);
                let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let bytes = tokio::fs::read(&path).await.map_err(|_| rv_core::admin::AdminError::new("failed"))?;
                admin.create_emoji(&code, &alias_text, &file_name, &mime, bytes).await
            },
            move |result| match result {
                Ok(()) => {
                    h.toast(t("admin.emoji_added"));
                    h.pop_if(&navigation);
                    reload();
                }
                Err(error) => {
                    button.set_sensitive(true);
                    h.toast(t(rv_core::admin::error_key(&error.code)));
                }
            },
        );
    });
}
