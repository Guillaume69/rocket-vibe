//! Settings and my profile, in categories (a sidebar dialog): my account and
//! status, notifications, language, encryption, security, devices and bots
//! (native accounts), the accounts on this machine, the app itself; sign out below.

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
use crate::sidebar_dialog::{Host, SidebarDialog};
use crate::widgets::{self, TileSize};

const NOTIFICATION_CHOICES: [&str; 4] = ["default", "all", "mention", "nothing"];
const LANGUAGE_CHOICES: [&str; 3] = ["auto", "fr", "en"];
mod native_bots;
mod native_profiles;
pub(crate) mod voice;

/// A category of the sidebar: its id, icon and title key. They show in this
/// file's order, each only when it has something for the account.
type Category = (&'static str, &'static str, &'static str);
const ACCOUNT: Category = ("account", "avatar-default-symbolic", "settings.cat.account");
const NOTIFICATIONS: Category =
    ("notifications", "preferences-system-notifications-symbolic", "settings.cat.notifications");
const LANGUAGE: Category = ("language", "preferences-desktop-locale-symbolic", "settings.cat.language");
const VOICE: Category = ("voice", "audio-input-microphone-symbolic", "settings.cat.voice");
const ENCRYPTION: Category = ("encryption", "channel-secure-symbolic", "settings.cat.encryption");
const SECURITY: Category = ("security", "security-high-symbolic", "settings.cat.security");
const DEVICES: Category = ("devices", "computer-symbolic", "settings.cat.devices");
const BOTS: Category = ("bots", "system-run-symbolic", "settings.cat.bots");
const ACCOUNTS: Category = ("accounts", "system-users-symbolic", "settings.cat.accounts");
const APP: Category = ("app", "emblem-system-symbolic", "settings.cat.app");

fn add(dialog: &SidebarDialog, (id, icon, title): Category, page: &adw::PreferencesPage) {
    dialog.add(id, icon, t(title), page);
}

fn add_lazy(
    dialog: &SidebarDialog,
    (id, icon, title): Category,
    build: impl FnOnce(&Host) -> adw::PreferencesPage + 'static,
) {
    dialog.add_lazy(id, icon, t(title), build);
}

/// The dialog, with the server administration (shown to an administrator)
/// and Sign out under the categories it will hold.
fn dialog(parent: &gtk::Widget, admin: rv_core::admin::Admin, sign_out: impl Fn() + 'static) -> SidebarDialog {
    let dialog = SidebarDialog::new(t("settings.title"), "settings-dialog");
    let (screen, parent) = (admin.clone(), parent.clone());
    let link = dialog.add_footer(t("admin.title"), "network-server-symbolic", false, move |host| {
        host.close();
        crate::admin::open(&parent, screen.clone());
    });
    link.add_css_class("settings-admin");
    link.set_visible(false);
    let host = dialog.host();
    glib::spawn_future_local(async move {
        let admin = on_tokio(async move { admin.is_admin().await }).await;
        if host.alive() {
            link.set_visible(admin);
        }
    });
    let button = dialog.add_footer(t("rooms.sign_out"), "system-log-out-symbolic", true, move |host| {
        host.close();
        sign_out();
    });
    button.add_css_class("settings-sign-out");
    dialog
}

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
) -> SidebarDialog {
    let info = &session.info;
    let dialog = dialog(parent.as_ref(), rv_core::admin::Admin::Native(session.clone()), sign_out);
    dialog.dialog().add_css_class("native-profile-settings");
    let host = dialog.host();
    let account = adw::PreferencesPage::new();
    let profile = adw::PreferencesGroup::new();
    let row = adw::ActionRow::builder()
        .title(&info.username)
        .subtitle(format!("@{} · {}", info.username, host_of(&info.base_url)))
        .build();
    row.add_prefix(&widgets::tile(&info.username, &widgets::initial(&info.username), TileSize::Room, false));
    profile.add(&row);
    account.add(&profile);
    let (notifications, language) = (adw::PreferencesPage::new(), adw::PreferencesPage::new());
    native_profiles::settings(
        &host,
        native_profiles::Pages { account: &account, notifications: &notifications, language: &language },
        &row,
        session.clone(),
    );
    let notifier = notifier_group();
    let has_notifications = session.profiles_available() || notifier.is_some();
    if let Some(group) = notifier {
        notifications.add(&group);
    }
    add(&dialog, ACCOUNT, &account);
    if has_notifications {
        add(&dialog, NOTIFICATIONS, &notifications);
    }
    add(&dialog, LANGUAGE, &language);
    if rv_core::voice::available() {
        let voice = adw::PreferencesPage::new();
        voice.add(&voice::group(session.clone()));
        add(&dialog, VOICE, &voice);
    }
    if session.crypto_settings_supported() {
        let s = session.clone();
        add_lazy(&dialog, ENCRYPTION, move |host| crate::native_crypto::page(host, s));
    }
    if session.security_supported() {
        let s = session.clone();
        add_lazy(&dialog, SECURITY, move |host| crate::native_security::page(host, s));
    }
    if session.supported_features().iter().any(|f| f == "device_sessions") {
        let s = session.clone();
        add_lazy(&dialog, DEVICES, move |host| native_devices_page(host, s));
    }
    if session.supported_features().iter().any(|f| f == "bots") {
        let (s, security) = (session.clone(), session.security_supported().then_some(SECURITY.0));
        add_lazy(&dialog, BOTS, move |host| native_bots::page(host, s, security));
    }
    add(&dialog, ACCOUNTS, &accounts_page(&host, info, accounts));
    add(&dialog, APP, &app_page(&host));
    dialog.present(parent);
    dialog
}

fn device_error(error: &rv_core::native::Error) -> &'static str {
    if error.code() == "reauthentication_required" { t("devices.reauth") } else { t("devices.failed") }
}

/// The devices signed in to the account: rename, revoke. Loaded as the
/// category opens.
fn native_devices_page(host: &Host, session: Arc<rv_core::native::NativeSession>) -> adw::PreferencesPage {
    let page = adw::PreferencesPage::builder().css_classes(["native-devices-dialog"]).build();
    let group = adw::PreferencesGroup::builder().title(t("devices.title")).build();
    let status = adw::ActionRow::builder().title(t("devices.loading")).build();
    group.add(&status);
    page.add(&group);
    if session.security_supported() {
        let reauth = adw::ButtonRow::builder()
            .title(t("security.verify"))
            .css_classes(["button", "native-devices-reauth"])
            .build();
        group.add(&reauth);
        let host = host.clone();
        reauth.connect_activated(move |_| host.select(SECURITY.0));
    }
    let host = host.clone();
    glib::spawn_future_local(async move {
        let s = session.clone();
        let result = on_tokio(async move { s.device_sessions().await }).await;
        if !host.alive() {
            return;
        }
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
                    let (h, weak_row) = (host.clone(), row.downgrade());
                    let (s, id) = (session.clone(), device.id.clone());
                    name.connect_apply(move |entry| {
                        let (s, id, label, entry, host, row) = (
                            s.clone(),
                            id.clone(),
                            entry.text().to_string(),
                            entry.clone(),
                            h.clone(),
                            weak_row.clone(),
                        );
                        entry.set_sensitive(false);
                        glib::spawn_future_local(async move {
                            let saved = label.clone();
                            let result = on_tokio(async move { s.rename_device(&id, &saved).await }).await;
                            entry.set_sensitive(true);
                            if !host.alive() {
                                return;
                            }
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
                                Err(error) => host.toast(device_error(&error)),
                            }
                        });
                    });
                    if !device.current {
                        let revoke = adw::ButtonRow::builder()
                            .title(t("devices.revoke"))
                            .css_classes(["button", "destructive-action"])
                            .build();
                        let (s, id, h, weak_row, weak_group) =
                            (session.clone(), device.id, host.clone(), row.downgrade(), group.downgrade());
                        revoke.connect_activated(move |_| {
                            let Some(parent) = h.widget() else { return };
                            let confirm = adw::AlertDialog::builder()
                                .heading(t("devices.confirm"))
                                .body(t("devices.confirm_body"))
                                .default_response("cancel")
                                .close_response("cancel")
                                .build();
                            confirm.add_responses(&[("cancel", t("actions.cancel")), ("revoke", t("devices.revoke"))]);
                            confirm.set_response_appearance("revoke", adw::ResponseAppearance::Destructive);
                            let (s, id, host, row, group) =
                                (s.clone(), id.clone(), h.clone(), weak_row.clone(), weak_group.clone());
                            confirm.connect_response(Some("revoke"), move |_, _| {
                                let (s, id, host, row, group) =
                                    (s.clone(), id.clone(), host.clone(), row.clone(), group.clone());
                                if let Some(row) = row.upgrade() {
                                    row.set_sensitive(false);
                                }
                                glib::spawn_future_local(async move {
                                    let result = on_tokio(async move { s.revoke_device(&id).await }).await;
                                    if host.alive()
                                        && let (Some(row), Some(group)) = (row.upgrade(), group.upgrade())
                                    {
                                        match result {
                                            Ok(()) => group.remove(&row),
                                            Err(error) => {
                                                row.set_sensitive(true);
                                                host.toast(device_error(&error));
                                            }
                                        }
                                    }
                                });
                            });
                            crate::widgets::present(&confirm, Some(&parent));
                        });
                        row.add_row(&revoke);
                    }
                    group.add(&row);
                }
            }
        }
    });
    page
}

fn combo(title: &str, labels: &[&str], selected: usize) -> adw::ComboRow {
    let model = gtk::StringList::new(labels);
    adw::ComboRow::builder().title(title).model(&model).selected(selected as u32).build()
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
) -> SidebarDialog {
    let dialog = dialog(parent.as_ref(), rv_core::admin::Admin::RocketChat(session.clone()), sign_out);
    let host = dialog.host();

    let account = adw::PreferencesPage::new();
    let profile = adw::PreferencesGroup::new();
    let me_row = adw::ActionRow::builder()
        .title(&session.info.username)
        .subtitle(format!("@{} · {}", session.info.username, host_of(&session.info.base_url)))
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
    account.add(&profile);
    let status_group = adw::PreferencesGroup::builder().title(t("settings.status")).build();
    let labels: Vec<&str> = STATUSES.iter().map(|s| t(&format!("presence.{s}"))).collect();
    let status = combo(t("settings.presence"), &labels, 0);
    let status_text = adw::EntryRow::builder().title(t("settings.status_text")).show_apply_button(true).build();
    status_group.add(&status);
    status_group.add(&status_text);
    account.add(&status_group);
    add(&dialog, ACCOUNT, &account);

    let notifications = adw::PreferencesPage::new();
    let notify_group = adw::PreferencesGroup::builder().title(t("settings.notifications")).build();
    let labels: Vec<&str> = NOTIFICATION_CHOICES.iter().map(|c| t(&format!("settings.notify_{c}"))).collect();
    let notify = combo(t("settings.desktop_notifications"), &labels, 0);
    notify_group.add(&notify);
    notifications.add(&notify_group);
    if let Some(group) = notifier_group() {
        notifications.add(&group);
    }
    add(&dialog, NOTIFICATIONS, &notifications);

    let language_page = adw::PreferencesPage::new();
    let language_group = adw::PreferencesGroup::builder().title(t("settings.language")).build();
    let labels: Vec<&str> = LANGUAGE_CHOICES.iter().map(|c| t(&format!("settings.lang_{c}"))).collect();
    let current = LANGUAGE_CHOICES.iter().position(|c| *c == i18n::saved_choice()).unwrap_or(0);
    let language = combo(t("settings.language"), &labels, current);
    language.set_subtitle(t("settings.language_restart"));
    language_group.add(&language);
    language_page.add(&language_group);
    add(&dialog, LANGUAGE, &language_page);

    let encryption = adw::PreferencesPage::new();
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
    encryption.add(&e2e_group);
    add(&dialog, ENCRYPTION, &encryption);
    let (s, h) = (session.clone(), host.clone());
    e2e_button.connect_clicked(move |_| {
        if s.e2e_unlocked() {
            s.e2e_lock();
            e2e_row.set_subtitle(t("e2e.locked"));
            return;
        }
        let parent = h.widget().and_then(|dialog| dialog.parent());
        h.close();
        if let Some(parent) = parent {
            crate::unlock::ask(&parent, s.clone());
        }
    });

    add(&dialog, ACCOUNTS, &accounts_page(&host, &session.info, accounts));
    add(&dialog, APP, &app_page(&host));

    // What `me` says fills the rows; their handlers are connected after, so
    // filling them does not write anything back.
    let me: Rc<RefCell<Option<Me>>> = Rc::default();
    let (s, inner, h, found_me) = (session.clone(), session.clone(), host.clone(), me.clone());
    glib::spawn_future_local(async move {
        let found = on_tokio(async move { s.me().await }).await;
        if !h.alive() {
            return;
        }
        let Ok(found) = found else {
            h.toast(t("info.failed"));
            return;
        };
        if !found.name.is_empty() {
            me_row.set_title(&found.name);
        }
        status.set_selected(STATUSES.iter().position(|s| *s == found.status).unwrap_or(0) as u32);
        status_text.set_text(&found.status_text);
        notify.set_selected(
            NOTIFICATION_CHOICES.iter().position(|c| *c == found.desktop_notifications).unwrap_or(0) as u32
        );
        found_me.replace(Some(found));
        wire_status(&h, &inner, &status, &status_text);
        let s = inner.clone();
        notify.connect_selected_notify(move |row| {
            let value = NOTIFICATION_CHOICES[row.selected() as usize].to_owned();
            let (s, h) = (s.clone(), h.clone());
            glib::spawn_future_local(async move {
                let done =
                    on_tokio(async move { s.set_preference("desktopNotifications", serde_json::json!(value)).await })
                        .await;
                if done.is_err() {
                    h.toast(t("settings.save_failed"));
                }
            });
        });
    });
    language.connect_selected_notify(|row| i18n::save_choice(LANGUAGE_CHOICES[row.selected() as usize]));
    let (s, h) = (session.clone(), host.clone());
    edit.connect_clicked(move |_| {
        if let Some(found) = me.borrow().clone() {
            edit_profile(&h, s.clone(), found);
        }
    });
    dialog.present(parent);
    dialog
}

/// Who shows the notifications, a test, and the system's own settings.
fn notifier_group() -> Option<adw::PreferencesGroup> {
    let group = adw::PreferencesGroup::builder().title(t("settings.desktop_notifications")).build();
    let mut filled = false;
    if let Some(notifier) = crate::notifier::current() {
        let shown_by = adw::ActionRow::builder().title(t("notify.shown_by")).subtitle("…").build();
        let row = shown_by.clone();
        notifier.describe(move |text| row.set_subtitle(&text));
        group.add(&shown_by);
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
        group.add(&test);
        filled = true;
    }
    if let Some(uri) = crate::notifier::system_settings_uri() {
        let system = adw::ButtonRow::builder()
            .title(t("notify.system_settings"))
            .end_icon_name("external-link-symbolic")
            .build();
        system.connect_activated(move |row| crate::cards::open_uri(row, uri));
        group.add(&system);
        filled = true;
    }
    filled.then_some(group)
}

/// The accounts on this machine, and the server of this one.
fn accounts_page(
    host: &Host,
    info: &rv_core::session::SessionInfo,
    actions: Option<Rc<AccountActions>>,
) -> adw::PreferencesPage {
    let page = adw::PreferencesPage::new();
    if let Some(actions) = actions {
        page.add(&accounts_group(host, info, actions));
    }
    let account = adw::PreferencesGroup::builder().title(t("settings.account")).build();
    account.add(&adw::ActionRow::builder().title(t("settings.server")).subtitle(&info.base_url).build());
    page.add(&account);
    page
}

/// Startup and background, then the version, updates and logs.
fn app_page(host: &Host) -> adw::PreferencesPage {
    let page = adw::PreferencesPage::new();
    if crate::background::SUPPORTED {
        page.add(&background_group(host));
    }
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
    let h = host.clone();
    check_now.connect_activated(move |row| {
        row.set_sensitive(false);
        let (row, h) = (row.clone(), h.clone());
        glib::spawn_future_local(async move {
            match crate::updater::check().await {
                Ok(Some(release)) => {
                    h.close();
                    crate::updater::present(release);
                }
                Ok(None) => h.toast(t("settings.updates_none")),
                Err(e) => {
                    eprintln!("Update check failed: {e}");
                    h.toast(t("settings.updates_failed"));
                }
            }
            row.set_sensitive(true);
        });
    });
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
    page
}

/// Closing the window without quitting, and starting at login.
fn background_group(host: &Host) -> adw::PreferencesGroup {
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
    let h = host.clone();
    login.connect_active_notify(move |row| {
        if rv_native::autostart() == row.is_active() {
            return;
        }
        if let Err(e) = rv_native::set_autostart(row.is_active()) {
            eprintln!("Start at login not changed: {e}");
            h.toast(t("settings.start_at_login_failed"));
            row.set_active(rv_native::autostart());
        }
    });
    group.add(&login);
    group
}

/// Every account in the keychain; the others switch on a click.
fn accounts_group(
    host: &Host,
    info: &rv_core::session::SessionInfo,
    actions: Rc<AccountActions>,
) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::builder().title(t("settings.accounts")).build();
    let current = crate::secrets::account_key(info);
    let list = gtk::ListBox::builder().selection_mode(gtk::SelectionMode::None).css_classes(["boxed-list"]).build();
    group.add(&list);
    let add = adw::ButtonRow::builder().title(t("settings.add_account")).start_icon_name("list-add-symbolic").build();
    let (a, h) = (actions.clone(), host.clone());
    add.connect_activated(move |_| {
        h.close();
        (a.add)();
    });
    list.append(&add);
    let host = host.clone();
    glib::spawn_future_local(async move {
        let all = on_tokio(crate::secrets::load_all()).await;
        for info in all.into_iter().rev() {
            let row = adw::ActionRow::builder()
                .title(format!("@{}", info.username))
                .subtitle(host_of(&info.base_url))
                .build();
            if crate::secrets::account_key(&info) == current {
                row.add_suffix(&gtk::Label::builder().label(t("settings.current")).css_classes(["dim-label"]).build());
            } else {
                row.set_activatable(true);
                let (a, h) = (actions.clone(), host.clone());
                row.connect_activated(move |_| {
                    h.close();
                    (a.switch)(info.clone());
                });
            }
            list.prepend(&row);
        }
    });
    group
}

fn host_of(base_url: &str) -> String {
    url::Url::parse(base_url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default()
}

fn wire_status(host: &Host, session: &Arc<Session>, status: &adw::ComboRow, text: &adw::EntryRow) {
    let save = {
        let (session, status, text, host) = (session.clone(), status.clone(), text.clone(), host.clone());
        move || {
            let chosen = STATUSES[status.selected() as usize];
            let (s, message, host) = (session.clone(), text.text().to_string(), host.clone());
            glib::spawn_future_local(async move {
                let done = on_tokio(async move { s.set_status(chosen, &message).await }).await;
                if done.is_err() {
                    host.toast(t("settings.save_failed"));
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
fn edit_profile(host: &Host, session: Arc<Session>, me: Me) {
    edit_profile_for(host, ProfileSource::Legacy(session), me);
}
fn edit_profile_for(host: &Host, source: ProfileSource, me: Me) {
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
    let save = adw::ButtonRow::builder().title(t("settings.save")).css_classes(["button", "suggested-action"]).build();
    save_group.add(&save);
    page.add(&save_group);

    let subpage = host.push(t("settings.edit_profile"), &page);

    if let ProfileSource::Native(session, current) = source {
        native_profiles::editor(
            host,
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
    let (h, s) = (host.clone(), session.clone());
    save.connect_activated(move |_| {
        let data = changes();
        if data.is_empty() {
            h.pop();
            return;
        }
        let password = password.is_visible().then(|| password.text().to_string());
        let two_factor = challenge.borrow().clone().map(|method| two_factor_code(&method, code.text().trim()));
        let (s, challenge, code, h) = (s.clone(), challenge.clone(), code.clone(), h.clone());
        glib::spawn_future_local(async move {
            let done = on_tokio(async move { s.update_basic_info(data, password.as_deref(), two_factor).await }).await;
            if !h.alive() {
                return;
            }
            match done {
                Ok(()) => {
                    h.toast(t("settings.saved"));
                    h.pop();
                }
                Err(RestError { two_factor: Some(c), .. }) => {
                    challenge.replace(Some(c.method.clone()));
                    code.set_visible(true);
                    code.grab_focus();
                    h.toast(t("settings.code_needed"));
                }
                Err(_) => h.toast(t("settings.save_failed")),
            }
        });
    });
    let (h, s) = (host.clone(), session.clone());
    change.connect_clicked(move |button| {
        let filter = gtk::FileFilter::new();
        filter.add_mime_type("image/*");
        let filters = gio::ListStore::new::<gtk::FileFilter>();
        filters.append(&filter);
        let chooser =
            gtk::FileDialog::builder().title(t("settings.photo_change")).filters(&filters).modal(true).build();
        let window = button.root().and_downcast::<gtk::Window>();
        let (s, h) = (s.clone(), h.clone());
        chooser.open(window.as_ref(), None::<&gio::Cancellable>, move |file| {
            let Some(path) = file.ok().and_then(|f| f.path()) else { return };
            let mime = crate::attach::mime_of(&path);
            glib::spawn_future_local(async move {
                let done = on_tokio(async move { s.set_avatar(&path, &mime).await }).await;
                h.toast(t(if done.is_ok() { "settings.saved" } else { "settings.save_failed" }));
            });
        });
    });
    let h = host.clone();
    remove.connect_clicked(move |_| {
        let (s, h) = (session.clone(), h.clone());
        glib::spawn_future_local(async move {
            let done = on_tokio(async move { s.reset_avatar().await }).await;
            h.toast(t(if done.is_ok() { "settings.saved" } else { "settings.save_failed" }));
        });
    });
}
