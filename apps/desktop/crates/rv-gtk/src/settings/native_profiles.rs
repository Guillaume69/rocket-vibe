use super::{LANGUAGE_CHOICES, NOTIFICATION_CHOICES, ProfileSource, combo, edit_profile_for, toast_of};
use crate::{
    i18n::{self, t},
    on_tokio,
};
use adw::prelude::*;
use gtk::{gdk_pixbuf, gio, glib};
use rv_core::{
    account::{Me, STATUSES},
    native::{
        Error, NativeSession,
        profiles::*,
        store::{AvatarUpload, ProfileOperation},
    },
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

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
fn submit(parent: &adw::PreferencesDialog, state: State, action: Action, done: impl FnOnce(bool) + 'static) {
    if !state.live.get() || state.session.is_closed() || state.busy.replace(true) {
        return;
    }
    let dialog = parent.downgrade();
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
        if !state.live.get() || state.session.is_closed() {
            return;
        }
        let Some(dialog) = dialog.upgrade() else {
            return;
        };
        let success = result.is_ok();
        match result {
            Ok(own) => {
                state.current.replace(own);
                toast_of(&dialog, t("settings.saved"));
            }
            Err(error) => {
                toast_of(
                    &dialog,
                    t(match error.code() {
                        "reauthentication_required" => "security.required",
                        "revision_conflict" => "profile.conflict",
                        "profile_action_pending" => "profile.pending",
                        _ => "settings.save_failed",
                    }),
                );
                if error.code() == "reauthentication_required" {
                    crate::native_security::open_dialog(&dialog, state.session.clone());
                }
            }
        }
        done(success);
    });
}
fn pending(
    parent: &adw::PreferencesDialog,
    group: &adw::PreferencesGroup,
    rows: &RefCell<Vec<adw::ActionRow>>,
    state: &State,
) {
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
        let (s, dialog, row_weak, group_weak, phase, id, action_slot) = (
            state.clone(),
            parent.downgrade(),
            row.downgrade(),
            group.downgrade(),
            saved.phase.clone(),
            saved.command.id().to_owned(),
            slot.to_owned(),
        );
        action.connect_clicked(move |_| {
            let Some(dialog) = dialog.upgrade() else {
                return;
            };
            let action = if phase == "failed" {
                Action::Discard(action_slot.clone(), id.clone())
            } else {
                Action::Resume(action_slot.clone())
            };
            let (row, group) = (row_weak.clone(), group_weak.clone());
            submit(&dialog, s.clone(), action, move |success| {
                if success && let (Some(row), Some(group)) = (row.upgrade(), group.upgrade()) {
                    group.remove(&row);
                }
            });
        });
        row.add_suffix(&action);
        if saved.phase == "proof" {
            let clear = gtk::Button::builder().label(t("profile.discard")).valign(gtk::Align::Center).build();
            let (s, dialog, id, slot, row_weak, group_weak) = (
                state.clone(),
                parent.downgrade(),
                saved.command.id().to_owned(),
                slot.to_owned(),
                row.downgrade(),
                group.downgrade(),
            );
            clear.connect_clicked(move |_| {
                let Some(dialog) = dialog.upgrade() else {
                    return;
                };
                let (row, group) = (row_weak.clone(), group_weak.clone());
                submit(&dialog, s.clone(), Action::Discard(slot.clone(), id.clone()), move |success| {
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

pub(super) fn settings(
    parent: &adw::PreferencesDialog,
    page: &adw::PreferencesPage,
    row: &adw::ActionRow,
    session: Arc<NativeSession>,
) {
    let language_group = adw::PreferencesGroup::builder().title(t("settings.language")).build();
    let labels: Vec<_> = LANGUAGE_CHOICES.iter().map(|c| t(&format!("settings.lang_{c}"))).collect();
    let language = combo(
        t("settings.language"),
        &labels,
        LANGUAGE_CHOICES.iter().position(|c| *c == i18n::saved_choice()).unwrap_or(0),
    );
    language.set_subtitle(t("settings.language_restart"));
    language_group.add(&language);
    page.add(&language_group);
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
    page.add(&notifications);
    status_group.set_sensitive(false);
    notifications.set_sensitive(false);
    let live = Rc::new(Cell::new(true));
    let active = live.clone();
    parent.connect_closed(move |_| active.set(false));
    let (parent, page, row) = (parent.downgrade(), page.clone(), row.clone());
    glib::spawn_future_local(async move {
        let s = session.clone();
        let found = on_tokio(async move { s.own_profile().await }).await;
        if !live.get() || session.is_closed() {
            return;
        }
        let Some(parent) = parent.upgrade() else {
            return;
        };
        let Ok(found) = found else {
            toast_of(&parent, t("settings.save_failed"));
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
        edit.set_sensitive(true);
        let pending_group = adw::PreferencesGroup::new();
        page.add(&pending_group);
        let filling = Rc::new(Cell::new(false));
        let (s, d) = (state.clone(), parent.downgrade());
        edit.connect_clicked(move |_| {
            if s.busy.get() || !s.live.get() {
                return;
            }
            if let Some(parent) = d.upgrade() {
                edit_profile_for(
                    &parent,
                    ProfileSource::Native(s.session.clone(), s.current.clone()),
                    me(&s.current.borrow()),
                );
            }
        });
        let send_status = {
            let (s, d, status, text, filling) =
                (state.clone(), parent.downgrade(), status.clone(), text.clone(), filling.clone());
            move || {
                if filling.get() || s.busy.get() {
                    return;
                }
                let Some(parent) = d.upgrade() else {
                    return;
                };
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
            let (s, d, filling) = (state.clone(), parent.downgrade(), filling.clone());
            combo.connect_selected_notify(move |row| {
                if filling.get() || s.busy.get() {
                    return;
                }
                let Some(parent) = d.upgrade() else {
                    return;
                };
                let mut preferences = s.current.borrow().preferences.clone();
                if is_language {
                    preferences.language = LANGUAGE_CHOICES[row.selected() as usize].into();
                } else {
                    preferences.desktop_notifications =
                        serde_json::from_value(serde_json::json!(NOTIFICATION_CHOICES[row.selected() as usize]))
                            .unwrap();
                }
                let choice = preferences.language.clone();
                let input = UpdatePreferences {
                    operation_id: rv_core::native::room_operation_id(),
                    expected_revision: preferences.revision,
                    language: preferences.language,
                    clock_24h: preferences.clock_24h,
                    push_enabled: preferences.push_enabled,
                    push_mentions_only: preferences.push_mentions_only,
                    desktop_notifications: preferences.desktop_notifications,
                };
                submit(&parent, s.clone(), Action::Change(ProfileOperation::Preferences { input }), move |success| {
                    if success && is_language {
                        i18n::save_choice(&choice);
                    }
                });
            });
        }
        let (parent, rows) = (parent.downgrade(), RefCell::new(Vec::new()));
        let mut signature = String::new();
        let mut remote_attempt = String::new();
        glib::timeout_add_local(std::time::Duration::from_millis(250), move || {
            if !state.live.get() || state.session.is_closed() {
                return glib::ControlFlow::Break;
            }
            let Some(parent) = parent.upgrade() else {
                return glib::ControlFlow::Break;
            };
            let queued = ["profile", "preferences", "avatar"]
                .map(|slot| state.session.store.profile_operation(slot).ok().flatten());
            let own = state.current.borrow().clone();
            let fresh_signature = format!(
                "{}:{}:{}:{:?}",
                own.profile.revision,
                own.preferences.revision,
                state.busy.get(),
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
                status_group.set_sensitive(!state.busy.get() && queued[0].is_none());
                language.set_sensitive(!state.busy.get() && queued[1].is_none());
                notify.set_sensitive(!state.busy.get() && queued[1].is_none());
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
    parent: &adw::PreferencesDialog,
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
    let (s, d, name, username, bio, button, original) = (
        state.clone(),
        parent.downgrade(),
        fields.name.clone(),
        fields.username.clone(),
        fields.bio.clone(),
        fields.save.clone(),
        base.clone(),
    );
    fields.save.connect_activated(move |_| {
        let Some(parent) = d.upgrade() else {
            return;
        };
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
        let (d, name, username, bio, button, s2, original) = (
            parent.downgrade(),
            name.clone(),
            username.clone(),
            bio.clone(),
            button.clone(),
            s.clone(),
            original.clone(),
        );
        submit(&parent, s.clone(), action, move |success| {
            let Some(parent) = d.upgrade() else {
                return;
            };
            if success && !clearing {
                parent.pop_subpage();
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
    let (s, d) = (state.clone(), parent.downgrade());
    fields.change.connect_clicked(move |button| {
        let Some(parent) = d.upgrade() else {
            return;
        };
        if s.busy.get() || !s.live.get() {
            return;
        }
        let chooser = gtk::FileDialog::builder().title(t("settings.photo_change")).modal(true).build();
        let window = button.root().and_downcast::<gtk::Window>();
        let (s, d) = (s.clone(), parent.downgrade());
        chooser.open(window.as_ref(), None::<&gio::Cancellable>, move |file| {
            let Some(path) = file.ok().and_then(|file| file.path()) else {
                return;
            };
            let Some(parent) = d.upgrade() else {
                return;
            };
            if !s.live.get() || s.session.is_closed() {
                return;
            }
            let Some(png) = gdk_pixbuf::Pixbuf::from_file_at_scale(&path, 512, 512, true)
                .ok()
                .and_then(|p| p.apply_embedded_orientation().unwrap_or(p).save_to_bufferv("png", &[]).ok())
                .filter(|bytes| bytes.len() <= 2 * 1024 * 1024)
            else {
                toast_of(&parent, t("settings.save_failed"));
                return;
            };
            avatar(&parent, s.clone(), Some(png));
        });
    });
    let (s, d) = (state.clone(), parent.downgrade());
    fields.remove.connect_clicked(move |button| {
        if let Some(parent) = d.upgrade() {
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
fn avatar(parent: &adw::PreferencesDialog, state: State, png: Option<Vec<u8>>) {
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
