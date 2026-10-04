//! Settings and my profile: account, status, desktop notifications,
//! language, encryption, sign out.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::{gio, glib};
use rv_core::account::{Me, STATUSES, basic_info_changes, needs_password};
use rv_core::media::{AvatarTarget, avatar_path};
use rv_core::rest::RestError;
use rv_core::session::{Session, two_factor_code};

use crate::i18n::{self, t};
use crate::on_tokio;
use crate::rows::with_photo;
use crate::widgets::{self, TileSize};

const NOTIFICATION_CHOICES: [&str; 4] = ["default", "all", "mention", "nothing"];
const LANGUAGE_CHOICES: [&str; 3] = ["auto", "fr", "en"];
mod native_profiles;

#[derive(Clone)]
enum ProfileSource {
    Legacy(Arc<Session>),
    Native(Arc<rv_core::native::NativeSession>, Rc<RefCell<rv_core::native::profiles::OwnProfile>>),
}

/// Account selection and local preferences are shared by both providers.
pub fn open_native(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<rv_core::native::NativeSession>,
    accounts: Option<Rc<AccountActions>>,
    sign_out: impl Fn() + 'static,
) {
    let info = &session.info;
    let dialog = adw::PreferencesDialog::builder().title(t("settings.title")).build();
    dialog.add_css_class("native-profile-settings");
    let page = adw::PreferencesPage::builder().title(t("settings.title")).icon_name("emblem-system-symbolic").build();
    let profile = adw::PreferencesGroup::new();
    let row = adw::ActionRow::builder().title(&info.username).subtitle(&info.base_url).build();
    row.add_prefix(&widgets::tile(&info.username, &widgets::initial(&info.username), TileSize::Room, false));
    profile.add(&row);
    page.add(&profile);
    if let Some(actions) = accounts {
        page.add(&accounts_group(&dialog, info, actions));
    }
    if session.supported_features().iter().any(|f| f == "device_sessions") {
        page.add(&native_devices_group(&dialog, session.clone()));
    }
    if session.security_supported() {
        page.add(&crate::native_security::group(&dialog, session.clone()));
    }
    if session.crypto_settings_supported() {
        page.add(&crate::native_crypto::group(&dialog, session.clone()));
    }
    if crate::background::SUPPORTED {
        page.add(&background_group(&dialog));
    }
    native_profiles::settings(&dialog, &page, &row, session.clone());
    let group = adw::PreferencesGroup::builder().title(t("settings.account")).build();
    let logout = adw::ButtonRow::builder().title(t("rooms.sign_out")).css_classes(["destructive-action"]).build();
    let d = dialog.clone();
    logout.connect_activated(move |_| {
        d.close();
        sign_out();
    });
    group.add(&logout);
    page.add(&group);
    dialog.add(&page);
    dialog.present(Some(parent));
}

fn device_error(error: &rv_core::native::Error) -> &'static str {
    if error.code() == "reauthentication_required" { t("devices.reauth") } else { t("devices.failed") }
}

fn native_devices_group(
    dialog: &adw::PreferencesDialog,
    session: Arc<rv_core::native::NativeSession>,
) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::builder().title(t("devices.title")).build();
    let load = adw::ButtonRow::builder().title(t("devices.title")).css_classes(["native-devices-open"]).build();
    group.add(&load);
    let parent = dialog.downgrade();
    load.connect_activated(move |_| {
        let Some(parent) = parent.upgrade() else { return };
        let dialog = adw::PreferencesDialog::builder()
            .title(t("devices.title"))
            .content_width(560)
            .content_height(560)
            .css_classes(["native-devices-dialog"])
            .build();
        let page = adw::PreferencesPage::new();
        let group = adw::PreferencesGroup::new();
        let status = adw::ActionRow::builder().title(t("devices.loading")).build();
        group.add(&status);
        page.add(&group);
        dialog.add(&page);
        if session.security_supported() {
            let reauth =
                adw::ButtonRow::builder().title(t("security.verify")).css_classes(["native-devices-reauth"]).build();
            group.add(&reauth);
            let (parent, s) = (dialog.downgrade(), session.clone());
            reauth.connect_activated(move |_| {
                if let Some(parent) = parent.upgrade() {
                    crate::native_security::open_dialog(&parent, s.clone());
                }
            });
        }
        dialog.present(Some(&parent));
        let weak = dialog.downgrade();
        let session = session.clone();
        glib::spawn_future_local(async move {
            let s = session.clone();
            let result = on_tokio(async move { s.device_sessions().await }).await;
            let Some(dialog) = weak.upgrade() else { return };
            group.remove(&status);
            match result {
                Err(error) => group.add(&adw::ActionRow::builder().title(device_error(&error)).build()),
                Ok(devices) => {
                    for device in devices {
                        let title = if device.label.is_empty() { t("devices.unnamed") } else { &device.label };
                        let row = adw::ExpanderRow::builder()
                            .title(glib::markup_escape_text(title))
                            .subtitle(if device.current { t("devices.current") } else { "" })
                            .build();
                        let name = adw::EntryRow::builder()
                            .title(t("devices.name"))
                            .text(&device.label)
                            .show_apply_button(true)
                            .build();
                        if device.current {
                            name.add_css_class("native-device-current-name");
                        }
                        row.add_row(&name);
                        for (key, value) in [
                            ("devices.created", &device.created_at),
                            ("devices.seen", &device.last_seen_at),
                            ("devices.expires", &device.expires_at),
                        ] {
                            row.add_row(&adw::ActionRow::builder().title(t(key)).subtitle(value).build());
                        }
                        let (weak_dialog, weak_row) = (dialog.downgrade(), row.downgrade());
                        let (s, id) = (session.clone(), device.id.clone());
                        name.connect_apply(move |entry| {
                            let (s, id, label, entry, parent, row) = (
                                s.clone(),
                                id.clone(),
                                entry.text().to_string(),
                                entry.clone(),
                                weak_dialog.clone(),
                                weak_row.clone(),
                            );
                            entry.set_sensitive(false);
                            glib::spawn_future_local(async move {
                                let saved = label.clone();
                                let result = on_tokio(async move { s.rename_device(&id, &saved).await }).await;
                                entry.set_sensitive(true);
                                if let Some(dialog) = parent.upgrade() {
                                    match result {
                                        Ok(()) => {
                                            if let Some(row) = row.upgrade() {
                                                row.set_title(&glib::markup_escape_text(if label.is_empty() {
                                                    t("devices.unnamed")
                                                } else {
                                                    &label
                                                }));
                                            }
                                        }
                                        Err(error) => toast_of(&dialog, device_error(&error)),
                                    }
                                }
                            });
                        });
                        if !device.current {
                            let revoke = adw::ButtonRow::builder()
                                .title(t("devices.revoke"))
                                .css_classes(["destructive-action"])
                                .build();
                            let (s, id, parent, weak_row, weak_group) =
                                (session.clone(), device.id, dialog.downgrade(), row.downgrade(), group.downgrade());
                            revoke.connect_activated(move |_| {
                                let Some(parent) = parent.upgrade() else { return };
                                let confirm = adw::AlertDialog::builder()
                                    .heading(t("devices.confirm"))
                                    .body(t("devices.confirm_body"))
                                    .default_response("cancel")
                                    .close_response("cancel")
                                    .build();
                                confirm
                                    .add_responses(&[("cancel", t("actions.cancel")), ("revoke", t("devices.revoke"))]);
                                confirm.set_response_appearance("revoke", adw::ResponseAppearance::Destructive);
                                let (s, id, response_parent, row, group) =
                                    (s.clone(), id.clone(), parent.downgrade(), weak_row.clone(), weak_group.clone());
                                confirm.connect_response(Some("revoke"), move |_, _| {
                                    let (s, id, parent, row, group) =
                                        (s.clone(), id.clone(), response_parent.clone(), row.clone(), group.clone());
                                    if let Some(row) = row.upgrade() {
                                        row.set_sensitive(false);
                                    }
                                    glib::spawn_future_local(async move {
                                        let result = on_tokio(async move { s.revoke_device(&id).await }).await;
                                        if let (Some(dialog), Some(row), Some(group)) =
                                            (parent.upgrade(), row.upgrade(), group.upgrade())
                                        {
                                            match result {
                                                Ok(()) => group.remove(&row),
                                                Err(error) => {
                                                    row.set_sensitive(true);
                                                    toast_of(&dialog, device_error(&error));
                                                }
                                            }
                                        }
                                    });
                                });
                                confirm.present(Some(&parent));
                            });
                            row.add_row(&revoke);
                        }
                        group.add(&row);
                    }
                }
            }
        });
    });
    group
}

fn combo(title: &str, labels: &[&str], selected: usize) -> adw::ComboRow {
    let model = gtk::StringList::new(labels);
    adw::ComboRow::builder().title(title).model(&model).selected(selected as u32).build()
}

fn toast_of(dialog: &adw::PreferencesDialog, text: &str) {
    dialog.add_toast(adw::Toast::new(text));
}

/// Switching between the accounts signed in on this machine, or adding one.
pub struct AccountActions {
    pub switch: Box<dyn Fn(rv_core::session::SessionInfo)>,
    pub add: Box<dyn Fn()>,
}

/// `sign_out` ends the session the way the header's button does.
pub fn open(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<Session>,
    accounts: Option<Rc<AccountActions>>,
    sign_out: impl Fn() + 'static,
) {
    let dialog = adw::PreferencesDialog::builder().title(t("settings.title")).build();
    let page = adw::PreferencesPage::builder().title(t("settings.title")).icon_name("emblem-system-symbolic").build();
    dialog.add(&page);

    let profile = adw::PreferencesGroup::new();
    let me_row = adw::ActionRow::builder()
        .title(&session.info.username)
        .subtitle(format!("@{} · {}", session.info.username, host(&session)))
        .build();
    let photo = with_photo(
        widgets::tile(&session.info.username, &widgets::initial(&session.info.username), TileSize::Room, false),
        Some(&session),
        Some(session.user_avatar(&session.info.username)),
    );
    photo.set_margin_top(6);
    photo.set_margin_bottom(6);
    me_row.add_prefix(&photo);
    let edit = gtk::Button::builder()
        .label(t("settings.edit_profile"))
        .valign(gtk::Align::Center)
        .css_classes(["flat"])
        .build();
    me_row.add_suffix(&edit);
    profile.add(&me_row);
    page.add(&profile);

    let status_group = adw::PreferencesGroup::builder().title(t("settings.status")).build();
    let labels: Vec<&str> = STATUSES.iter().map(|s| t(&format!("presence.{s}"))).collect();
    let status = combo(t("settings.presence"), &labels, 0);
    let status_text = adw::EntryRow::builder().title(t("settings.status_text")).show_apply_button(true).build();
    status_group.add(&status);
    status_group.add(&status_text);
    page.add(&status_group);

    let notify_group = adw::PreferencesGroup::builder().title(t("settings.notifications")).build();
    let labels: Vec<&str> = NOTIFICATION_CHOICES.iter().map(|c| t(&format!("settings.notify_{c}"))).collect();
    let notify = combo(t("settings.desktop_notifications"), &labels, 0);
    notify_group.add(&notify);
    if let Some(notifier) = crate::notifier::current() {
        let shown_by = adw::ActionRow::builder().title(t("notify.shown_by")).subtitle("…").build();
        let row = shown_by.clone();
        notifier.describe(move |text| row.set_subtitle(&text));
        notify_group.add(&shown_by);
        let test = adw::ActionRow::builder().title(t("notify.test")).subtitle(t("notify.test_hint")).build();
        let send = gtk::Button::builder()
            .icon_name("preferences-system-notifications-symbolic")
            .tooltip_text(t("notify.test"))
            .css_classes(["flat"])
            .valign(gtk::Align::Center)
            .build();
        send.connect_clicked(move |_| notifier.test());
        test.add_suffix(&send);
        test.set_activatable_widget(Some(&send));
        notify_group.add(&test);
    }
    if let Some(uri) = crate::notifier::system_settings_uri() {
        let system = adw::ButtonRow::builder()
            .title(t("notify.system_settings"))
            .end_icon_name("external-link-symbolic")
            .build();
        system.connect_activated(move |row| crate::cards::open_uri(row, uri));
        notify_group.add(&system);
    }
    page.add(&notify_group);
    if crate::background::SUPPORTED {
        page.add(&background_group(&dialog));
    }

    let language_group = adw::PreferencesGroup::builder().title(t("settings.language")).build();
    let labels: Vec<&str> = LANGUAGE_CHOICES.iter().map(|c| t(&format!("settings.lang_{c}"))).collect();
    let current = LANGUAGE_CHOICES.iter().position(|c| *c == i18n::saved_choice()).unwrap_or(0);
    let language = combo(t("settings.language"), &labels, current);
    language.set_subtitle(t("settings.language_restart"));
    language_group.add(&language);
    page.add(&language_group);

    let e2e_group = adw::PreferencesGroup::new();
    let unlocked = session.e2e_unlocked();
    let e2e_row = adw::ActionRow::builder()
        .title(t("e2e.status"))
        .subtitle(t(if unlocked { "e2e.unlocked" } else { "e2e.locked" }))
        .build();
    let e2e_button = gtk::Button::builder()
        .label(t(if unlocked { "e2e.lock" } else { "e2e.unlock" }))
        .valign(gtk::Align::Center)
        .css_classes(["flat"])
        .build();
    e2e_row.add_suffix(&e2e_button);
    e2e_group.add(&e2e_row);
    page.add(&e2e_group);
    let s = session.clone();
    e2e_button.connect_clicked(glib::clone!(
        #[weak]
        dialog,
        move |_| {
            if s.e2e_unlocked() {
                s.e2e_lock();
                e2e_row.set_subtitle(t("e2e.locked"));
                return;
            }
            let parent = dialog.parent();
            dialog.close();
            if let Some(parent) = parent {
                crate::unlock::ask(&parent, s.clone());
            }
        }
    ));

    if let Some(actions) = accounts {
        page.add(&accounts_group(&dialog, &session.info, actions));
    }

    let account = adw::PreferencesGroup::builder().title(t("settings.account")).build();
    let server_row = adw::ActionRow::builder().title(t("settings.server")).subtitle(&session.info.base_url).build();
    account.add(&server_row);
    let sign_out_row = adw::ButtonRow::builder().title(t("rooms.sign_out")).css_classes(["destructive-action"]).build();
    account.add(&sign_out_row);
    page.add(&account);

    let about = adw::PreferencesGroup::builder().title(t("settings.about")).build();
    about.add(&adw::ActionRow::builder().title(t("settings.version")).subtitle(env!("CARGO_PKG_VERSION")).build());
    let auto_update = adw::SwitchRow::builder()
        .title(t("settings.updates_auto"))
        .subtitle(t("settings.updates_auto_hint"))
        .active(crate::updater::automatic())
        .build();
    auto_update.connect_active_notify(|row| crate::updater::set_automatic(row.is_active()));
    about.add(&auto_update);
    let check_now = adw::ButtonRow::builder().title(t("settings.updates_check")).build();
    check_now.connect_activated(glib::clone!(
        #[weak]
        dialog,
        move |row| {
            row.set_sensitive(false);
            let row = row.clone();
            glib::spawn_future_local(async move {
                match crate::updater::check().await {
                    Ok(Some(release)) => {
                        dialog.close();
                        crate::updater::present(release);
                    }
                    Ok(None) => toast_of(&dialog, t("settings.updates_none")),
                    Err(e) => {
                        eprintln!("Update check failed: {e}");
                        toast_of(&dialog, t("settings.updates_failed"));
                    }
                }
                row.set_sensitive(true);
            });
        }
    ));
    about.add(&check_now);
    let logs_dir = crate::crashlog::dir();
    let logs_row = adw::ActionRow::builder()
        .title(t("settings.logs"))
        .subtitle(logs_dir.to_string_lossy())
        .subtitle_selectable(true)
        .build();
    let open_logs = gtk::Button::builder()
        .icon_name("folder-open-symbolic")
        .tooltip_text(t("settings.logs_open"))
        .css_classes(["flat"])
        .valign(gtk::Align::Center)
        .build();
    open_logs.connect_clicked(move |button| crate::cards::open_file(button, &logs_dir, || {}));
    logs_row.add_suffix(&open_logs);
    about.add(&logs_row);
    page.add(&about);

    // What `me` says fills the rows; their handlers are connected after, so
    // filling them does not write anything back.
    let me: Rc<RefCell<Option<Me>>> = Rc::default();
    let (s, inner) = (session.clone(), session.clone());
    glib::spawn_future_local(glib::clone!(
        #[weak]
        dialog,
        #[strong]
        me,
        async move {
            let Ok(found) = on_tokio(async move { s.me().await }).await else {
                toast_of(&dialog, t("info.failed"));
                return;
            };
            if !found.name.is_empty() {
                me_row.set_title(&found.name);
            }
            status.set_selected(STATUSES.iter().position(|s| *s == found.status).unwrap_or(0) as u32);
            status_text.set_text(&found.status_text);
            notify.set_selected(
                NOTIFICATION_CHOICES.iter().position(|c| *c == found.desktop_notifications).unwrap_or(0) as u32,
            );
            me.replace(Some(found));
            wire_status(&dialog, &inner, &status, &status_text);
            let s = inner.clone();
            notify.connect_selected_notify(glib::clone!(
                #[weak]
                dialog,
                move |row| {
                    let value = NOTIFICATION_CHOICES[row.selected() as usize].to_owned();
                    let s = s.clone();
                    glib::spawn_future_local(async move {
                        let done = on_tokio(async move {
                            s.set_preference("desktopNotifications", serde_json::json!(value)).await
                        })
                        .await;
                        if done.is_err() {
                            toast_of(&dialog, t("settings.save_failed"));
                        }
                    });
                }
            ));
        }
    ));
    language.connect_selected_notify(|row| i18n::save_choice(LANGUAGE_CHOICES[row.selected() as usize]));
    sign_out_row.connect_activated(glib::clone!(
        #[weak]
        dialog,
        move |_| {
            dialog.close();
            sign_out();
        }
    ));
    let s = session.clone();
    edit.connect_clicked(glib::clone!(
        #[weak]
        dialog,
        move |_| {
            if let Some(found) = me.borrow().clone() {
                edit_profile(&dialog, s.clone(), found);
            }
        }
    ));
    dialog.present(Some(parent));
}

/// Every account in the keychain; the others switch on a click.
/// Closing the window without quitting, and starting at login.
fn background_group(dialog: &adw::PreferencesDialog) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::builder().title(t("settings.background")).build();
    let where_hint = if cfg!(windows) { "settings.keep_running_tray" } else { "settings.keep_running_dock" };
    let keep = adw::SwitchRow::builder()
        .title(t("settings.keep_running"))
        .subtitle(t(where_hint))
        .active(crate::background::keep_running())
        .build();
    keep.connect_active_notify(|row| crate::background::set_keep_running(row.is_active()));
    group.add(&keep);
    let login = adw::SwitchRow::builder()
        .title(t("settings.start_at_login"))
        .subtitle(t("settings.start_at_login_hint"))
        .active(rv_native::autostart())
        .sensitive(rv_native::autostart_supported())
        .build();
    login.connect_active_notify(glib::clone!(
        #[weak]
        dialog,
        move |row| {
            if rv_native::autostart() == row.is_active() {
                return;
            }
            if let Err(e) = rv_native::set_autostart(row.is_active()) {
                eprintln!("Start at login not changed: {e}");
                toast_of(&dialog, t("settings.start_at_login_failed"));
                row.set_active(rv_native::autostart());
            }
        }
    ));
    group.add(&login);
    group
}

fn accounts_group(
    dialog: &adw::PreferencesDialog,
    info: &rv_core::session::SessionInfo,
    actions: Rc<AccountActions>,
) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::builder().title(t("settings.accounts")).build();
    let current = crate::secrets::account_key(info);
    let list = gtk::ListBox::builder().selection_mode(gtk::SelectionMode::None).css_classes(["boxed-list"]).build();
    group.add(&list);
    let add = adw::ButtonRow::builder().title(t("settings.add_account")).start_icon_name("list-add-symbolic").build();
    let (a, d) = (actions.clone(), dialog.downgrade());
    add.connect_activated(move |_| {
        if let Some(d) = d.upgrade() {
            d.close();
        }
        (a.add)();
    });
    list.append(&add);
    let dialog = dialog.downgrade();
    glib::spawn_future_local(async move {
        let all = on_tokio(crate::secrets::load_all()).await;
        for info in all.into_iter().rev() {
            let host =
                url::Url::parse(&info.base_url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
            let row = adw::ActionRow::builder().title(format!("@{}", info.username)).subtitle(host).build();
            if crate::secrets::account_key(&info) == current {
                row.add_suffix(&gtk::Label::builder().label(t("settings.current")).css_classes(["dim-label"]).build());
            } else {
                row.set_activatable(true);
                let (a, d) = (actions.clone(), dialog.clone());
                row.connect_activated(move |_| {
                    if let Some(d) = d.upgrade() {
                        d.close();
                    }
                    (a.switch)(info.clone());
                });
            }
            list.prepend(&row);
        }
    });
    group
}

fn host(session: &Session) -> String {
    url::Url::parse(&session.info.base_url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default()
}

fn wire_status(dialog: &adw::PreferencesDialog, session: &Arc<Session>, status: &adw::ComboRow, text: &adw::EntryRow) {
    let save = {
        let (session, status, text, dialog) = (session.clone(), status.clone(), text.clone(), dialog.downgrade());
        move || {
            let chosen = STATUSES[status.selected() as usize];
            let (s, message, dialog) = (session.clone(), text.text().to_string(), dialog.clone());
            glib::spawn_future_local(async move {
                let done = on_tokio(async move { s.set_status(chosen, &message).await }).await;
                if let (Err(_), Some(dialog)) = (done, dialog.upgrade()) {
                    toast_of(&dialog, t("settings.save_failed"));
                }
            });
        }
    };
    let again = save.clone();
    status.connect_selected_notify(move |_| again());
    text.connect_apply(move |_| save());
}

/// Name, username, email, bio and photo. Username and email changes ask for
/// the current password, and maybe a second factor.
fn edit_profile(parent: &adw::PreferencesDialog, session: Arc<Session>, me: Me) {
    edit_profile_for(parent, ProfileSource::Legacy(session), me);
}
fn edit_profile_for(parent: &adw::PreferencesDialog, source: ProfileSource, me: Me) {
    let page = adw::PreferencesPage::new();
    let photo_group = adw::PreferencesGroup::new();
    let photo_row = adw::ActionRow::builder().title(t("settings.photo")).build();
    let tile = widgets::tile(&me.username, &widgets::initial(&me.username), TileSize::Room, false);
    let photo = match &source {
        ProfileSource::Legacy(session) => with_photo(
            tile,
            Some(session),
            Some(avatar_path(AvatarTarget::User(&me.username), me.avatar_etag.as_deref())),
        ),
        ProfileSource::Native(session, _) => crate::rows::with_native_photo(tile, session, me.avatar_etag.clone()),
    };
    photo.set_margin_top(6);
    photo.set_margin_bottom(6);
    photo_row.add_prefix(&photo);
    let change = gtk::Button::builder()
        .label(t("settings.photo_change"))
        .valign(gtk::Align::Center)
        .css_classes(["flat"])
        .build();
    let remove = gtk::Button::builder()
        .label(t("settings.photo_remove"))
        .valign(gtk::Align::Center)
        .css_classes(["flat"])
        .build();
    photo_row.add_suffix(&change);
    photo_row.add_suffix(&remove);
    photo_group.add(&photo_row);
    page.add(&photo_group);

    let group = adw::PreferencesGroup::new();
    let name = adw::EntryRow::builder().title(t("settings.name")).text(&me.name).build();
    let username = adw::EntryRow::builder().title(t("settings.username")).text(&me.username).build();
    let email = adw::EntryRow::builder().title(t("settings.email")).text(&me.email).build();
    let bio = adw::EntryRow::builder().title(t("info.bio")).text(&me.bio).build();
    let password = adw::PasswordEntryRow::builder().title(t("settings.current_password")).visible(false).build();
    let code = adw::EntryRow::builder().title(t("settings.code")).visible(false).build();
    for row in [
        name.upcast_ref::<gtk::Widget>(),
        username.upcast_ref(),
        email.upcast_ref(),
        bio.upcast_ref(),
        password.upcast_ref(),
        code.upcast_ref(),
    ] {
        group.add(row);
    }
    page.add(&group);
    let save_group = adw::PreferencesGroup::new();
    let save = adw::ButtonRow::builder().title(t("settings.save")).css_classes(["suggested-action"]).build();
    save_group.add(&save);
    page.add(&save_group);

    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(&page));
    let subpage = adw::NavigationPage::builder().title(t("settings.edit_profile")).child(&view).build();
    parent.push_subpage(&subpage);

    if let ProfileSource::Native(session, current) = source {
        native_profiles::editor(
            parent,
            &subpage,
            session,
            current,
            native_profiles::Fields { name, username, email, bio, save, change, remove, photo_row, photo },
        );
        return;
    }
    let ProfileSource::Legacy(session) = source else { unreachable!() };

    let changes = {
        let (me, name, username, email, bio) = (me.clone(), name.clone(), username.clone(), email.clone(), bio.clone());
        move || {
            let after = Me {
                name: name.text().trim().to_owned(),
                username: username.text().trim().to_owned(),
                email: email.text().trim().to_owned(),
                bio: bio.text().trim().to_owned(),
                ..me.clone()
            };
            basic_info_changes(&me, &after)
        }
    };
    let reveal = {
        let (changes, password) = (changes.clone(), password.clone());
        move || password.set_visible(needs_password(&changes()))
    };
    for row in [&username, &email] {
        let reveal = reveal.clone();
        row.connect_changed(move |_| reveal());
    }
    let challenge: Rc<RefCell<Option<String>>> = Rc::default();
    save.connect_activated(glib::clone!(
        #[weak]
        parent,
        #[strong]
        session,
        move |_| {
            let data = changes();
            if data.is_empty() {
                parent.pop_subpage();
                return;
            }
            let password = password.is_visible().then(|| password.text().to_string());
            let two_factor = challenge.borrow().clone().map(|method| two_factor_code(&method, code.text().trim()));
            let (s, challenge, code) = (session.clone(), challenge.clone(), code.clone());
            glib::spawn_future_local(async move {
                let done =
                    on_tokio(async move { s.update_basic_info(data, password.as_deref(), two_factor).await }).await;
                match done {
                    Ok(()) => {
                        toast_of(&parent, t("settings.saved"));
                        parent.pop_subpage();
                    }
                    Err(RestError { two_factor: Some(c), .. }) => {
                        challenge.replace(Some(c.method.clone()));
                        code.set_visible(true);
                        code.grab_focus();
                        toast_of(&parent, t("settings.code_needed"));
                    }
                    Err(_) => toast_of(&parent, t("settings.save_failed")),
                }
            });
        }
    ));
    change.connect_clicked(glib::clone!(
        #[weak]
        parent,
        #[strong]
        session,
        move |button| {
            let filter = gtk::FileFilter::new();
            filter.add_mime_type("image/*");
            let filters = gio::ListStore::new::<gtk::FileFilter>();
            filters.append(&filter);
            let chooser =
                gtk::FileDialog::builder().title(t("settings.photo_change")).filters(&filters).modal(true).build();
            let window = button.root().and_downcast::<gtk::Window>();
            let s = session.clone();
            chooser.open(window.as_ref(), None::<&gio::Cancellable>, move |file| {
                let Some(path) = file.ok().and_then(|f| f.path()) else { return };
                let mime = crate::attach::mime_of(&path);
                glib::spawn_future_local(async move {
                    let done = on_tokio(async move { s.set_avatar(&path, &mime).await }).await;
                    toast_of(&parent, t(if done.is_ok() { "settings.saved" } else { "settings.save_failed" }));
                });
            });
        }
    ));
    remove.connect_clicked(glib::clone!(
        #[weak]
        parent,
        move |_| {
            let s = session.clone();
            glib::spawn_future_local(async move {
                let done = on_tokio(async move { s.reset_avatar().await }).await;
                toast_of(&parent, t(if done.is_ok() { "settings.saved" } else { "settings.save_failed" }));
            });
        }
    ));
}
