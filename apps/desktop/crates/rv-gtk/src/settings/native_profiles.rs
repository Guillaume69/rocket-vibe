use super::{LANGUAGE_CHOICES, NOTIFICATION_CHOICES, ProfileSource, SECURITY, combo, edit_profile_for};
use crate::{
    i18n::{self, t},
    on_tokio,
    sidebar_dialog::Host,
};
use adw::prelude::*;
use gtk::{gdk_pixbuf, gio, glib};
use rv_core::{
    account::{Me, STATUSES},
    native::{
        Error, NativeSession,
        profiles::*,
        quiet,
        store::{AvatarUpload, ProfileOperation},
    },
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

/// A chosen picture as a native photo: upright, at most 512 pixels, PNG, at
/// most 2 MiB; None when it is no image or still too heavy.
pub(super) fn photo_png(path: &std::path::Path) -> Option<Vec<u8>> {
    gdk_pixbuf::Pixbuf::from_file_at_scale(path, 512, 512, true)
        .ok()
        .and_then(|p| p.apply_embedded_orientation().unwrap_or(p).save_to_bufferv("png", &[]).ok())
        .filter(|bytes| bytes.len() <= 2 * 1024 * 1024)
}

fn me(own: &OwnProfile) -> Me {
    let p = &own.profile;
    Me {
        username: p.user.username.clone(),
        name: p.user.display_name.clone(),
        email: own.email.clone().unwrap_or_default(),
        bio: p.bio.clone(),
        status: serde_json::to_value(p.status).unwrap().as_str().unwrap().into(),
        status_text: p.status_text.clone(),
        avatar_etag: p.avatar_file_id.clone(),
        desktop_notifications: serde_json::to_value(own.preferences.desktop_notifications)
            .unwrap()
            .as_str()
            .unwrap()
            .into(),
    }
}
fn command(own: &OwnProfile, fields: Me) -> ProfileOperation {
    ProfileOperation::Profile {
        input: UpdateProfile {
            operation_id: rv_core::native::room_operation_id(),
            expected_revision: own.profile.revision.clone(),
            username: fields.username,
            display_name: fields.name,
            bio: fields.bio,
            status: serde_json::from_value(serde_json::json!(fields.status)).unwrap(),
            status_text: fields.status_text,
        },
    }
}
/// A preferences change that keeps do not disturb as it is: the caller sets
/// the one field it changes.
fn preferences_input(preferences: &UserPreferences) -> UpdatePreferences {
    UpdatePreferences {
        operation_id: rv_core::native::room_operation_id(),
        expected_revision: preferences.revision.clone(),
        language: preferences.language.clone(),
        clock_24h: preferences.clock_24h,
        push_enabled: preferences.push_enabled,
        push_mentions_only: preferences.push_mentions_only,
        desktop_notifications: preferences.desktop_notifications,
        // Absent keeps them.
        quiet_hours: None,
        muted_until: None,
        share_read_receipts: None,
    }
}
#[derive(Clone)]
struct State {
    session: Arc<NativeSession>,
    current: Rc<RefCell<OwnProfile>>,
    live: Rc<Cell<bool>>,
    busy: Rc<Cell<bool>>,
}
enum Action {
    Change(ProfileOperation),
    Resume(String),
    Discard(String, String),
}
fn submit(host: &Host, state: State, action: Action, done: impl FnOnce(bool) + 'static) {
    if !state.live.get() || state.session.is_closed() || state.busy.replace(true) {
        return;
    }
    let host = host.clone();
    glib::spawn_future_local(async move {
        let session = state.session.clone();
        let result = on_tokio(async move {
            match action {
                Action::Change(command) => session.change_profile(command).await,
                Action::Resume(slot) => session.resume_profile_operation(&slot).await,
                Action::Discard(slot, id) => {
                    if !session.dismiss_profile_operation(&slot, &id).await? {
                        return Err(Error::Protocol("profile_action_pending"));
                    }
                    session.own_profile().await
                }
            }
        })
        .await;
        state.busy.set(false);
        if !state.live.get() || state.session.is_closed() || !host.alive() {
            return;
        }
        let success = result.is_ok();
        match result {
            Ok(own) => {
                state.current.replace(own);
                host.toast(t("settings.saved"));
            }
            Err(error) => {
                host.toast(t(match error.code() {
                    "reauthentication_required" => "security.required",
                    "revision_conflict" => "profile.conflict",
                    "profile_action_pending" => "profile.pending",
                    _ => "settings.save_failed",
                }));
                if error.code() == "reauthentication_required" {
                    host.select(SECURITY.0);
                }
            }
        }
        done(success);
    });
}
fn pending(host: &Host, group: &adw::PreferencesGroup, rows: &RefCell<Vec<adw::ActionRow>>, state: &State) {
    for row in rows.take() {
        if row.parent().is_some() {
            group.remove(&row);
        }
    }
    for slot in ["profile", "preferences", "avatar"] {
        let Some(saved) = state.session.store.profile_operation(slot).ok().flatten() else {
            continue;
        };
        let row = adw::ActionRow::builder().title(t(&format!("profile.pending_{slot}"))).build();
        row.set_subtitle(t(if saved.phase == "proof" {
            "security.required"
        } else if saved.phase == "failed" {
            "settings.save_failed"
        } else {
            "profile.pending"
        }));
        let action = gtk::Button::builder()
            .label(t(if saved.phase == "failed" { "profile.discard" } else { "profile.resume" }))
            .valign(gtk::Align::Center)
            .build();
        let (s, h, row_weak, group_weak, phase, id, action_slot) = (
            state.clone(),
            host.clone(),
            row.downgrade(),
            group.downgrade(),
            saved.phase.clone(),
            saved.command.id().to_owned(),
            slot.to_owned(),
        );
        action.connect_clicked(move |_| {
            let action = if phase == "failed" {
                Action::Discard(action_slot.clone(), id.clone())
            } else {
                Action::Resume(action_slot.clone())
            };
            let (row, group) = (row_weak.clone(), group_weak.clone());
            submit(&h, s.clone(), action, move |success| {
                if success && let (Some(row), Some(group)) = (row.upgrade(), group.upgrade()) {
                    group.remove(&row);
                }
            });
        });
        row.add_suffix(&action);
        if saved.phase == "proof" {
            let clear = gtk::Button::builder().label(t("profile.discard")).valign(gtk::Align::Center).build();
            let (s, h, id, slot, row_weak, group_weak) = (
                state.clone(),
                host.clone(),
                saved.command.id().to_owned(),
                slot.to_owned(),
                row.downgrade(),
                group.downgrade(),
            );
            clear.connect_clicked(move |_| {
                let (row, group) = (row_weak.clone(), group_weak.clone());
                submit(&h, s.clone(), Action::Discard(slot.clone(), id.clone()), move |success| {
                    if success && let (Some(row), Some(group)) = (row.upgrade(), group.upgrade()) {
                        group.remove(&row);
                    }
                });
            });
            row.add_suffix(&clear);
        }
        group.add(&row);
        rows.borrow_mut().push(row);
    }
}

/// The categories this fills: status and pending changes on my account,
/// the notification preference, the language.
pub(super) struct Pages<'a> {
    pub account: &'a adw::PreferencesPage,
    pub notifications: &'a adw::PreferencesPage,
    pub language: &'a adw::PreferencesPage,
}

pub(super) fn settings(host: &Host, pages: Pages, row: &adw::ActionRow, session: Arc<NativeSession>) {
    let page = pages.account;
    let language_group = adw::PreferencesGroup::builder().title(t("settings.language")).build();
    let labels: Vec<_> = LANGUAGE_CHOICES.iter().map(|c| t(&format!("settings.lang_{c}"))).collect();
    let language = combo(
        t("settings.language"),
        &labels,
        LANGUAGE_CHOICES.iter().position(|c| *c == i18n::saved_choice()).unwrap_or(0),
    );
    language.set_subtitle(t("settings.language_restart"));
    language_group.add(&language);
    pages.language.add(&language_group);
    if !session.profiles_available() {
        language.connect_selected_notify(|row| i18n::save_choice(LANGUAGE_CHOICES[row.selected() as usize]));
        return;
    }
    language.set_sensitive(false);
    let edit = gtk::Button::builder()
        .label(t("settings.edit_profile"))
        .valign(gtk::Align::Center)
        .css_classes(["flat", "native-profile-edit"])
        .sensitive(false)
        .build();
    row.add_suffix(&edit);
    let status_group = adw::PreferencesGroup::builder().title(t("settings.status")).build();
    let status =
        combo(t("settings.presence"), &STATUSES.iter().map(|s| t(&format!("presence.{s}"))).collect::<Vec<_>>(), 0);
    let text = adw::EntryRow::builder().title(t("settings.status_text")).show_apply_button(true).build();
    status_group.add(&status);
    status_group.add(&text);
    page.add(&status_group);
    let notifications = adw::PreferencesGroup::builder().title(t("settings.notifications")).build();
    let notify = combo(
        t("settings.desktop_notifications"),
        &NOTIFICATION_CHOICES.iter().map(|s| t(&format!("settings.notify_{s}"))).collect::<Vec<_>>(),
        0,
    );
    notifications.add(&notify);
    pages.notifications.add(&notifications);
    // Do not disturb: the server holds push and call rings back, and this
    // app's own notifications follow (`NativeSession::quiet_now`).
    let dnd = adw::PreferencesGroup::builder().title(t("dnd.title")).description(t("dnd.description")).build();
    let mute_choices = gtk::StringList::new(&[t("dnd.off"), t("dnd.hour"), t("dnd.morning")]);
    let mute = adw::ComboRow::builder().title(t("dnd.mute")).model(&mute_choices).build();
    mute.add_css_class("native-dnd-mute");
    let quiet_row = adw::ExpanderRow::builder()
        .title(t("dnd.quiet_hours"))
        .show_enable_switch(true)
        .enable_expansion(false)
        .css_classes(["native-quiet-hours"])
        .build();
    let from = adw::EntryRow::builder()
        .title(t("dnd.from"))
        .show_apply_button(true)
        .text(quiet::clock(quiet::DEFAULT_START))
        .css_classes(["native-quiet-from"])
        .build();
    let to = adw::EntryRow::builder()
        .title(t("dnd.to"))
        .show_apply_button(true)
        .text(quiet::clock(quiet::DEFAULT_END))
        .css_classes(["native-quiet-to"])
        .build();
    quiet_row.add_row(&from);
    quiet_row.add_row(&to);
    dnd.add(&mute);
    dnd.add(&quiet_row);
    pages.notifications.add(&dnd);
    status_group.set_sensitive(false);
    notifications.set_sensitive(false);
    dnd.set_sensitive(false);
    let live = Rc::new(Cell::new(true));
    let active = live.clone();
    host.connect_closed(move || active.set(false));
    let (parent, page, row) = (host.clone(), page.clone(), row.clone());
    glib::spawn_future_local(async move {
        let s = session.clone();
        let found = on_tokio(async move { s.own_profile().await }).await;
        if !live.get() || session.is_closed() || !parent.alive() {
            return;
        }
        let Ok(found) = found else {
            parent.toast(t("settings.save_failed"));
            return;
        };
        let state = State { session, current: Rc::new(RefCell::new(found)), live, busy: Rc::new(Cell::new(false)) };
        let fields = me(&state.current.borrow());
        row.set_title(&fields.name);
        status.set_selected(STATUSES.iter().position(|s| *s == fields.status).unwrap_or(0) as u32);
        text.set_text(&fields.status_text);
        language.set_selected(
            LANGUAGE_CHOICES.iter().position(|s| *s == state.current.borrow().preferences.language).unwrap_or(0) as u32,
        );
        notify.set_selected(
            NOTIFICATION_CHOICES.iter().position(|s| *s == fields.desktop_notifications).unwrap_or(0) as u32
        );
        language.set_sensitive(true);
        status_group.set_sensitive(true);
        notifications.set_sensitive(true);
        dnd.set_sensitive(true);
        edit.set_sensitive(true);
        let pending_group = adw::PreferencesGroup::new();
        page.add(&pending_group);
        let filling = Rc::new(Cell::new(false));
        let (s, d) = (state.clone(), parent.clone());
        edit.connect_clicked(move |_| {
            if s.busy.get() || !s.live.get() {
                return;
            }
            edit_profile_for(&d, ProfileSource::Native(s.session.clone(), s.current.clone()), me(&s.current.borrow()));
        });
        let send_status = {
            let (s, parent, status, text, filling) =
                (state.clone(), parent.clone(), status.clone(), text.clone(), filling.clone());
            move || {
                if filling.get() || s.busy.get() {
                    return;
                }
                let mut fields = me(&s.current.borrow());
                fields.status = STATUSES[status.selected() as usize].into();
                fields.status_text = text.text().to_string();
                let change = command(&s.current.borrow(), fields);
                submit(&parent, s.clone(), Action::Change(change), |_| {});
            }
        };
        let again = send_status.clone();
        status.connect_selected_notify(move |_| again());
        text.connect_apply(move |_| send_status());
        for (combo, is_language) in [(&language, true), (&notify, false)] {
            let (s, parent, filling) = (state.clone(), parent.clone(), filling.clone());
            combo.connect_selected_notify(move |row| {
                if filling.get() || s.busy.get() {
                    return;
                }
                let mut preferences = s.current.borrow().preferences.clone();
                if is_language {
                    preferences.language = LANGUAGE_CHOICES[row.selected() as usize].into();
                } else {
                    preferences.desktop_notifications =
                        serde_json::from_value(serde_json::json!(NOTIFICATION_CHOICES[row.selected() as usize]))
                            .unwrap();
                }
                let choice = preferences.language.clone();
                let input = preferences_input(&preferences);
                submit(&parent, s.clone(), Action::Change(ProfileOperation::Preferences { input }), move |success| {
                    if success && is_language {
                        i18n::save_choice(&choice);
                    }
                });
            });
        }
        {
            let (s, parent, filling) = (state.clone(), parent.clone(), filling.clone());
            mute.connect_selected_notify(move |row| {
                if filling.get() || s.busy.get() {
                    return;
                }
                let choice = match row.selected() {
                    1 => "hour",
                    2 => "morning",
                    3 => "off",
                    _ => return,
                };
                let mut input = preferences_input(&s.current.borrow().preferences);
                input.muted_until = Some(quiet::mute_end(choice, chrono::Local::now()));
                submit(&parent, s.clone(), Action::Change(ProfileOperation::Preferences { input }), |_| {});
            });
        }
        // The switch saves at once (on with the two times shown, off removes
        // the window); a time is saved by its apply button.
        let send_window: Rc<dyn Fn()> = {
            let (s, parent, filling) = (state.clone(), parent.clone(), filling.clone());
            let (quiet_row, from, to) = (quiet_row.downgrade(), from.downgrade(), to.downgrade());
            Rc::new(move || {
                let (Some(quiet_row), Some(from), Some(to)) = (quiet_row.upgrade(), from.upgrade(), to.upgrade())
                else {
                    return;
                };
                if filling.get() || s.busy.get() {
                    return;
                }
                let window = if quiet_row.enables_expansion() {
                    let Some(window) = quiet::window(&from.text(), &to.text()) else {
                        from.add_css_class("error");
                        to.add_css_class("error");
                        parent.toast(t("dnd.invalid_time"));
                        return;
                    };
                    Some(window)
                } else {
                    None
                };
                from.remove_css_class("error");
                to.remove_css_class("error");
                let mut input = preferences_input(&s.current.borrow().preferences);
                input.quiet_hours = Some(window);
                submit(&parent, s.clone(), Action::Change(ProfileOperation::Preferences { input }), |_| {});
            })
        };
        let again = send_window.clone();
        quiet_row.connect_enable_expansion_notify(move |_| again());
        let again = send_window.clone();
        from.connect_apply(move |_| again());
        to.connect_apply(move |_| send_window());
        let rows = RefCell::new(Vec::new());
        let mut signature = String::new();
        let mut remote_attempt = String::new();
        glib::timeout_add_local(std::time::Duration::from_millis(250), move || {
            if !state.live.get() || state.session.is_closed() || !parent.alive() {
                return glib::ControlFlow::Break;
            }
            let queued = ["profile", "preferences", "avatar"]
                .map(|slot| state.session.store.profile_operation(slot).ok().flatten());
            let own = state.current.borrow().clone();
            // A mute that ends shows as off without waiting for the server.
            let muted_now = quiet::muted_until(&own.preferences, chrono::Utc::now()).is_some();
            let fresh_signature = format!(
                "{}:{}:{}:{}:{:?}",
                own.profile.revision,
                own.preferences.revision,
                state.busy.get(),
                muted_now,
                queued.iter().map(|op| op.as_ref().map(|op| (op.command.id(), op.phase.as_str()))).collect::<Vec<_>>()
            );
            if fresh_signature != signature {
                signature = fresh_signature;
                filling.set(true);
                let mut fields = me(&own);
                let mut preferences = own.preferences.clone();
                if let Some(saved) = &queued[0]
                    && let ProfileOperation::Profile { input } = &saved.command
                {
                    fields.status = serde_json::to_value(input.status).unwrap().as_str().unwrap().into();
                    fields.status_text = input.status_text.clone();
                }
                if let Some(saved) = &queued[1]
                    && let ProfileOperation::Preferences { input } = &saved.command
                {
                    preferences.language = input.language.clone();
                    preferences.desktop_notifications = input.desktop_notifications;
                    if let Some(window) = &input.quiet_hours {
                        preferences.quiet_hours = window.clone();
                    }
                    if let Some(until) = &input.muted_until {
                        preferences.muted_until = until.clone();
                    }
                }
                row.set_title(&own.profile.user.display_name);
                status.set_selected(STATUSES.iter().position(|s| *s == fields.status).unwrap_or(0) as u32);
                text.set_text(&fields.status_text);
                language
                    .set_selected(LANGUAGE_CHOICES.iter().position(|s| *s == preferences.language).unwrap_or(0) as u32);
                if i18n::saved_choice() != preferences.language {
                    i18n::save_choice(&preferences.language);
                }
                let notifications = serde_json::to_value(preferences.desktop_notifications).unwrap();
                notify.set_selected(
                    NOTIFICATION_CHOICES.iter().position(|s| Some(*s) == notifications.as_str()).unwrap_or(0) as u32,
                );
                let until = quiet::muted_until(&preferences, chrono::Utc::now());
                let mut choices =
                    vec![t(if until.is_some() { "dnd.muted" } else { "dnd.off" }), t("dnd.hour"), t("dnd.morning")];
                if until.is_some() {
                    choices.push(t("dnd.unmute"));
                }
                mute_choices.splice(0, mute_choices.n_items(), &choices);
                mute.set_selected(0);
                let until_text = until
                    .map(|until| until.with_timezone(&chrono::Local).format("%H:%M").to_string())
                    .map(|time| i18n::tf("dnd.until", &[("time", &time)]))
                    .unwrap_or_default();
                mute.set_subtitle(&until_text);
                let window = preferences.quiet_hours.as_ref();
                quiet_row.set_enable_expansion(window.is_some());
                quiet_row.set_subtitle(
                    &window.map(|w| i18n::tf("dnd.every_day", &[("zone", &w.time_zone)])).unwrap_or_default(),
                );
                from.set_text(&quiet::clock(window.map_or(quiet::DEFAULT_START, |w| w.start_minute)));
                to.set_text(&quiet::clock(window.map_or(quiet::DEFAULT_END, |w| w.end_minute)));
                from.remove_css_class("error");
                to.remove_css_class("error");
                status_group.set_sensitive(!state.busy.get() && queued[0].is_none());
                language.set_sensitive(!state.busy.get() && queued[1].is_none());
                notify.set_sensitive(!state.busy.get() && queued[1].is_none());
                mute.set_sensitive(!state.busy.get() && queued[1].is_none());
                quiet_row.set_sensitive(!state.busy.get() && queued[1].is_none());
                edit.set_sensitive(!state.busy.get());
                pending(&parent, &pending_group, &rows, &state);
                filling.set(false);
            }
            let head = state.session.store.profile_identity(&state.session.info.user_id).ok().flatten();
            if let Some(head) = head
                && head.revision != own.profile.revision
                && !state.busy.get()
            {
                let key = format!("{}:{:?}", head.revision, state.session.status().connection);
                if key != remote_attempt {
                    remote_attempt = key;
                    state.busy.set(true);
                    let state = state.clone();
                    glib::spawn_future_local(async move {
                        let session = state.session.clone();
                        let own = on_tokio(async move { session.own_profile().await }).await;
                        state.busy.set(false);
                        if state.live.get()
                            && !state.session.is_closed()
                            && let Ok(own) = own
                        {
                            state.current.replace(own);
                        }
                    });
                }
            }
            glib::ControlFlow::Continue
        });
    });
}

pub(super) struct Fields {
    pub name: adw::EntryRow,
    pub username: adw::EntryRow,
    pub email: adw::EntryRow,
    pub bio: adw::EntryRow,
    pub save: adw::ButtonRow,
    pub change: gtk::Button,
    pub remove: gtk::Button,
    pub photo_row: adw::ActionRow,
    pub photo: gtk::Widget,
}
pub(super) fn editor(
    parent: &Host,
    subpage: &adw::NavigationPage,
    session: Arc<NativeSession>,
    current: Rc<RefCell<OwnProfile>>,
    fields: Fields,
) {
    fields.email.set_editable(false);
    fields.email.set_tooltip_text(Some(t("profile.email_verified")));
    for (row, class) in [
        (&fields.name, "native-profile-name"),
        (&fields.username, "native-profile-username"),
        (&fields.bio, "native-profile-bio"),
    ] {
        row.add_css_class(class);
    }
    fields.save.add_css_class("native-profile-save");
    let live = Rc::new(Cell::new(true));
    let active = live.clone();
    subpage.connect_unmap(move |_| active.set(false));
    let state = State { session, current, live, busy: Rc::new(Cell::new(false)) };
    let base = Rc::new(RefCell::new(state.current.borrow().clone()));
    let restore = state.session.store.profile_operation("profile").ok().flatten();
    if let Some(saved) = &restore {
        if let ProfileOperation::Profile { input } = &saved.command {
            fields.name.set_text(&input.display_name);
            fields.username.set_text(&input.username);
            fields.bio.set_text(&input.bio);
        }
        fields.name.set_sensitive(false);
        fields.username.set_sensitive(false);
        fields.bio.set_sensitive(false);
        fields.save.set_title(t(if saved.phase == "failed" { "profile.discard" } else { "profile.resume" }));
    }
    let (s, host, name, username, bio, button, original) = (
        state.clone(),
        parent.clone(),
        fields.name.clone(),
        fields.username.clone(),
        fields.bio.clone(),
        fields.save.clone(),
        base.clone(),
    );
    fields.save.connect_activated(move |_| {
        let saved = s.session.store.profile_operation("profile").ok().flatten();
        let clearing = saved.as_ref().is_some_and(|saved| saved.phase == "failed");
        let action = if let Some(saved) = saved {
            if clearing {
                Action::Discard("profile".into(), saved.command.id().into())
            } else {
                Action::Resume("profile".into())
            }
        } else if button.title() == t("profile.resume") {
            Action::Resume("profile".into())
        } else {
            let mut after = me(&s.current.borrow());
            after.name = name.text().trim().into();
            after.username = username.text().trim().into();
            after.bio = bio.text().to_string();
            Action::Change(command(&original.borrow(), after))
        };
        let (d, name, username, bio, button, s2, original) =
            (host.clone(), name.clone(), username.clone(), bio.clone(), button.clone(), s.clone(), original.clone());
        submit(&host, s.clone(), action, move |success| {
            if success && !clearing {
                d.pop();
                return;
            }
            if success && clearing {
                let fresh = s2.current.borrow().clone();
                name.set_text(&fresh.profile.user.display_name);
                username.set_text(&fresh.profile.user.username);
                bio.set_text(&fresh.profile.bio);
                original.replace(fresh);
            }
            let pending = s2.session.store.profile_operation("profile").ok().flatten();
            for row in [&name, &username, &bio] {
                row.set_sensitive(pending.is_none());
            }
            button.set_title(t(if pending.as_ref().is_some_and(|saved| saved.phase == "failed") {
                "profile.discard"
            } else if pending.is_some() {
                "profile.resume"
            } else {
                "settings.save"
            }));
        });
    });
    let (s, d) = (state.clone(), parent.clone());
    fields.change.connect_clicked(move |button| {
        if s.busy.get() || !s.live.get() || !d.alive() {
            return;
        }
        let chooser = gtk::FileDialog::builder().title(t("settings.photo_change")).modal(true).build();
        let window = button.root().and_downcast::<gtk::Window>();
        let (s, parent) = (s.clone(), d.clone());
        chooser.open(window.as_ref(), None::<&gio::Cancellable>, move |file| {
            let Some(path) = file.ok().and_then(|file| file.path()) else {
                return;
            };
            if !s.live.get() || s.session.is_closed() || !parent.alive() {
                return;
            }
            let Some(png) = photo_png(&path) else {
                parent.toast(t("settings.save_failed"));
                return;
            };
            avatar(&parent, s.clone(), Some(png));
        });
    });
    let (s, parent) = (state.clone(), parent.clone());
    fields.remove.connect_clicked(move |button| {
        if parent.alive() {
            if s.session.store.profile_operation("avatar").ok().flatten().is_none()
                && button.label().is_some_and(|label| label == t("profile.resume") || label == t("profile.discard"))
            {
                submit(&parent, s.clone(), Action::Resume("avatar".into()), |_| {});
            } else {
                avatar(&parent, s.clone(), None);
            }
        }
    });
    let mut shown = state.current.borrow().profile.avatar_file_id.clone();
    let mut tile = fields.photo;
    glib::timeout_add_local(std::time::Duration::from_millis(250), move || {
        if !state.live.get() || state.session.is_closed() {
            return glib::ControlFlow::Break;
        }
        let own = state.current.borrow().clone();
        let mut old = me(&base.borrow());
        let mut fresh = me(&own);
        old.avatar_etag = None;
        fresh.avatar_etag = None;
        old.email.clear();
        fresh.email.clear();
        old.desktop_notifications.clear();
        fresh.desktop_notifications.clear();
        if old == fresh {
            base.replace(own.clone());
        }
        let queued = state.session.store.profile_operation("avatar").ok().flatten();
        fields.change.set_sensitive(!state.busy.get() && queued.is_none());
        fields.remove.set_sensitive(!state.busy.get());
        fields.remove.set_label(t(if queued.as_ref().is_some_and(|op| op.phase == "failed") {
            "profile.discard"
        } else if queued.is_some() {
            "profile.resume"
        } else {
            "settings.photo_remove"
        }));
        if own.profile.avatar_file_id != shown {
            fields.photo_row.remove(&tile);
            tile = crate::rows::with_native_photo(
                crate::widgets::tile(
                    &own.profile.user.username,
                    &crate::widgets::initial(&own.profile.user.username),
                    crate::widgets::TileSize::Room,
                    false,
                ),
                &state.session,
                own.profile.avatar_file_id.clone(),
            );
            tile.set_margin_top(6);
            tile.set_margin_bottom(6);
            fields.photo_row.add_prefix(&tile);
            shown = own.profile.avatar_file_id;
        }
        glib::ControlFlow::Continue
    });
}
fn avatar(parent: &Host, state: State, png: Option<Vec<u8>>) {
    let action = if let Some(saved) = state.session.store.profile_operation("avatar").ok().flatten() {
        if saved.phase == "failed" {
            Action::Discard("avatar".into(), saved.command.id().into())
        } else {
            Action::Resume("avatar".into())
        }
    } else {
        let input = AvatarCommand {
            operation_id: rv_core::native::room_operation_id(),
            expected_revision: state.current.borrow().profile.revision.clone(),
        };
        Action::Change(ProfileOperation::Avatar {
            input,
            upload: png.map(|bytes| AvatarUpload::from_bytes("image/png".into(), &bytes)),
        })
    };
    submit(parent, state, action, |_| {});
}
