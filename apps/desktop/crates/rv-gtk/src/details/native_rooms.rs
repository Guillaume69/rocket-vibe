use super::{centered, column, dialog, label, t};
use crate::on_tokio;
use adw::prelude::*;
use gtk::glib;
use rv_core::native::{
    ChangeRoomRole, Error, LeaveRoom, NativeSession, RoomDetails, RoomKind, RoomMemberPage, RoomRole, UpdateRoom,
    room_operation_id, store::RoomOperation,
};
use std::{cell::Cell, rc::Rc, sync::Arc};

fn error_key(error: &str) -> &'static str {
    match error {
        "last_room_owner" => "rooms.last_owner",
        "revision_conflict" => "rooms.conflict",
        "room_action_pending" => "rooms.pending",
        "unsupported_feature" => "rooms.unavailable",
        "offline" => "rooms.command_offline",
        "bot_encrypted_room" | "crypto_bot_member" => rv_core::native::bots::error_key(error),
        _ => "rooms.failed",
    }
}
fn button(key: &str) -> gtk::Button {
    gtk::Button::builder().label(t(key)).build()
}
fn attached(parent: &adw::Dialog, child: &adw::Dialog, active: Rc<Cell<bool>>) {
    let weak = child.downgrade();
    parent.connect_closed(move |_| {
        if let Some(child) = weak.upgrade() {
            child.close();
        }
    });
    child.connect_closed(move |_| active.set(false));
}
fn submit<F>(
    button: &gtk::Button,
    status: &gtk::Label,
    active: Rc<Cell<bool>>,
    future: F,
    success: impl FnOnce() + 'static,
) where
    F: std::future::Future<Output = Result<(), Error>> + Send + 'static,
{
    if !active.get() || !button.is_sensitive() {
        return;
    }
    button.set_sensitive(false);
    status.set_text("");
    let (button, status) = (button.clone(), status.clone());
    glib::spawn_future_local(async move {
        let result = on_tokio(future).await;
        if !active.get() {
            return;
        }
        button.set_sensitive(true);
        match result {
            Ok(()) => success(),
            Err(error) => status.set_text(t(error_key(error.code()))),
        }
    });
}
/// The form's starting values. `voice` is Some only where its switch shows:
/// an owner, a room that is not direct, a server announcing voice. None
/// leaves the flag as it is.
fn values(details: &RoomDetails, session: &NativeSession) -> UpdateRoom {
    let voice_editable = details.permissions.role == RoomRole::Owner
        && details.room.kind != RoomKind::Direct
        && session.voice_announced();
    UpdateRoom {
        operation_id: String::new(),
        expected_revision: details.revision.clone(),
        name: details.room.name.clone(),
        private: details.room.kind == RoomKind::Private,
        topic: details.topic.clone(),
        description: details.description.clone(),
        announcement: details.announcement.clone(),
        read_only: details.read_only,
        voice: voice_editable.then_some(details.voice),
    }
}
pub(super) fn controls(
    content: &gtk::Box,
    parent: &adw::Dialog,
    session: Arc<NativeSession>,
    details: RoomDetails,
    active: Rc<Cell<bool>>,
) {
    let rid = details.room.id.clone();
    let status = centered("", &["details-sub"]);
    content.append(&status);
    let saved = session.store.room_operation(&rid).ok().flatten();
    let occupied = saved.is_some();
    if let Some(saved) = saved {
        content.append(&centered(t(if saved.failed { "rooms.rejected" } else { "rooms.pending" }), &["details-sub"]));
        if let Some(error) = &saved.error {
            content.append(&centered(t(error_key(error)), &["details-sub"]));
        }
        let action = button(if saved.failed { "rooms.clear" } else { "rooms.resume" });
        action.add_css_class(if saved.failed { "native-room-intention-clear" } else { "native-room-intention-resume" });
        let (s, r, id, live, label) =
            (session.clone(), rid.clone(), saved.command.id().to_owned(), active.clone(), status.clone());
        action.connect_clicked(move |button| {
            let (s, r, id) = (s.clone(), r.clone(), id.clone());
            submit(
                button,
                &label,
                live.clone(),
                async move {
                    if saved.failed {
                        if !s.dismiss_room_operation(&r, &id).await? {
                            return Err(Error::Protocol("room_action_pending"));
                        }
                        Ok(())
                    } else {
                        s.resume_room_operation(&r).await
                    }
                },
                || {},
            );
        });
        content.append(&action);
        if saved.failed
            && details.permissions.change_settings
            && let RoomOperation::Settings { input } = saved.command
        {
            let review = button("rooms.review");
            let (s, r, live, label, parent) =
                (session.clone(), rid.clone(), active.clone(), status.clone(), parent.downgrade());
            review.connect_clicked(move |button| {
                if !live.get() || !button.is_sensitive() {
                    return;
                }
                button.set_sensitive(false);
                let (s, r, live, label, parent, button, mut input) =
                    (s.clone(), r.clone(), live.clone(), label.clone(), parent.clone(), button.clone(), input.clone());
                glib::spawn_future_local(async move {
                    let work = s.clone();
                    let command_id = input.operation_id.clone();
                    let current = on_tokio(async move {
                        let fresh = work.room_details(&r).await?;
                        if !fresh.permissions.change_settings {
                            return Err(Error::Protocol("room_action_pending"));
                        }
                        if !work.dismiss_room_operation(&r, &command_id).await? {
                            return Err(Error::Protocol("room_action_pending"));
                        }
                        Ok(fresh)
                    })
                    .await;
                    if !live.get() {
                        return;
                    }
                    button.set_sensitive(true);
                    match current {
                        Ok(fresh) => {
                            input.expected_revision = fresh.revision;
                            if let Some(parent) = parent.upgrade() {
                                edit(&parent, s, fresh.room.id, input);
                            }
                        }
                        Err(error) => label.set_text(t(error_key(error.code()))),
                    }
                });
            });
            content.append(&review);
        }
    }
    let features = session.supported_features();
    if details.permissions.change_settings && features.iter().any(|s| s == "room_settings") {
        let edit_button = button("rooms.edit");
        edit_button.add_css_class("native-room-edit");
        edit_button.set_sensitive(!occupied);
        let (s, parent, input, r) = (session.clone(), parent.downgrade(), values(&details, &session), rid.clone());
        let live = active.clone();
        edit_button.connect_clicked(move |_| {
            if live.get()
                && let Some(parent) = parent.upgrade()
            {
                edit(&parent, s.clone(), r.clone(), input.clone());
            }
        });
        content.append(&edit_button);
    }
    let members = button("rooms.members");
    members.add_css_class("native-room-members");
    let (s, members_parent, r, live, revision) =
        (session.clone(), parent.downgrade(), rid.clone(), active.clone(), details.revision.clone());
    let can_roles = details.permissions.role == RoomRole::Owner
        && details.room.kind != RoomKind::Direct
        && features.iter().any(|s| s == "room_roles")
        && !occupied;
    members.connect_clicked(move |_| {
        if live.get()
            && let Some(parent) = members_parent.upgrade()
        {
            roster(&parent, s.clone(), r.clone(), revision.clone(), can_roles);
        }
    });
    content.append(&members);
    if details.room.kind != RoomKind::Direct && features.iter().any(|s| s == "room_leave") {
        let leave = button("rooms.leave");
        leave.add_css_class("native-room-leave");
        leave.set_sensitive(!occupied);
        let (s, parent, r, live, label, revision) =
            (session, parent.downgrade(), rid, active, status, details.revision);
        leave.connect_clicked(move |_| {
            if !live.get() {
                return;
            }
            let Some(parent) = parent.upgrade() else {
                return;
            };
            let alert = adw::AlertDialog::builder()
                .css_classes(["alert", "native-room-leave-confirm"])
                .heading(t("rooms.leave"))
                .body(t("rooms.leave_body"))
                .default_response("cancel")
                .close_response("cancel")
                .build();
            alert.add_responses(&[("cancel", t("actions.cancel")), ("leave", t("rooms.leave"))]);
            alert.set_response_appearance("leave", adw::ResponseAppearance::Destructive);
            let (s, r, live, label, revision) = (s.clone(), r.clone(), live.clone(), label.clone(), revision.clone());
            alert.connect_response(Some("leave"), move |_, _| {
                if !live.get() {
                    return;
                }
                let (s, r, revision) = (s.clone(), r.clone(), revision.clone());
                let action = button("rooms.leave");
                submit(
                    &action,
                    &label,
                    live.clone(),
                    async move {
                        s.leave_room(&r, LeaveRoom { operation_id: room_operation_id(), expected_revision: revision })
                            .await
                    },
                    || {},
                );
            });
            crate::widgets::present(&alert, Some(&parent));
        });
        content.append(&leave);
    }
}
fn text(parent: &gtk::Box, key: &str, value: &str) -> gtk::TextBuffer {
    parent.append(&label(t(key), &["details-section"]));
    let view = gtk::TextView::builder()
        .wrap_mode(gtk::WrapMode::WordChar)
        .top_margin(8)
        .bottom_margin(8)
        .left_margin(8)
        .right_margin(8)
        .build();
    view.buffer().set_text(value);
    view.add_css_class(match key {
        "info.topic" => "native-room-topic",
        "info.description" => "native-room-description",
        _ => "native-room-announcement",
    });
    let buffer = view.buffer();
    parent.append(
        &gtk::ScrolledWindow::builder()
            .min_content_height(80)
            .hscrollbar_policy(gtk::PolicyType::Never)
            .child(&view)
            .build(),
    );
    buffer
}
fn edit(parent: &adw::Dialog, session: Arc<NativeSession>, rid: String, input: UpdateRoom) {
    let content = column();
    content.append(&centered(t("rooms.revision"), &["details-sub"]));
    let name = adw::EntryRow::builder()
        .title(t("native.room_name"))
        .text(&input.name)
        .css_classes(["native-room-name"])
        .build();
    content.append(&name);
    let (topic, description, announcement) = (
        text(&content, "info.topic", &input.topic),
        text(&content, "info.description", &input.description),
        text(&content, "info.announcement", &input.announcement),
    );
    let private = adw::SwitchRow::builder().title(t("native.private")).active(input.private).build();
    let read_only = adw::SwitchRow::builder().title(t("info.read_only")).active(input.read_only).build();
    read_only.add_css_class("native-room-read-only");
    content.append(&private);
    content.append(&read_only);
    // Shown only when the form carries the flag (`values`); otherwise sent as None.
    let voice = input.voice.map(|active| {
        let row = adw::SwitchRow::builder()
            .title(t("voice_session.channel"))
            .subtitle(t("voice_session.channel_hint"))
            .active(active)
            .build();
        row.add_css_class("native-room-voice");
        content.append(&row);
        row
    });
    let status = centered("", &["details-sub"]);
    content.append(&status);
    let save = button("settings.save");
    save.add_css_class("native-room-save");
    content.append(&save);
    let window = dialog(t("rooms.edit"), content.upcast_ref(), 600);
    let active = Rc::new(Cell::new(true));
    attached(parent, &window, active.clone());
    let weak = window.downgrade();
    let buffers = [topic.clone(), description.clone(), announcement.clone()];
    let entry = name.clone();
    window.connect_closed(move |_| {
        entry.set_text("");
        for buffer in &buffers {
            buffer.set_text("");
        }
    });
    save.connect_clicked(move |button| {
        let (s, rid, weak) = (session.clone(), rid.clone(), weak.clone());
        let read = |buffer: &gtk::TextBuffer| buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string();
        let command = UpdateRoom {
            operation_id: room_operation_id(),
            expected_revision: input.expected_revision.clone(),
            name: name.text().into(),
            private: private.is_active(),
            read_only: read_only.is_active(),
            topic: read(&topic),
            description: read(&description),
            announcement: read(&announcement),
            voice: voice.as_ref().map(adw::SwitchRow::is_active),
        };
        submit(button, &status, active.clone(), async move { s.update_room(&rid, command).await }, move || {
            if let Some(window) = weak.upgrade() {
                window.close();
            }
        });
    });
    crate::widgets::present(&window, Some(parent));
}
fn roster(parent: &adw::Dialog, session: Arc<NativeSession>, rid: String, revision: String, can_roles: bool) {
    let content = column();
    let status = centered("", &["details-sub"]);
    content.append(&status);
    let rows = column();
    content.append(&rows);
    let next = button("rooms.more");
    next.set_visible(false);
    content.append(&next);
    let window = dialog(t("rooms.members"), content.upcast_ref(), 540);
    window.add_css_class("native-room-roster");
    let active = Rc::new(Cell::new(true));
    attached(parent, &window, active.clone());
    let after = Rc::new(std::cell::RefCell::new(None));
    let (s, r, rev, live, list, label, n, more, weak) = (
        session.clone(),
        rid.clone(),
        revision.clone(),
        active.clone(),
        rows.clone(),
        status.clone(),
        next.clone(),
        after.clone(),
        window.downgrade(),
    );
    let load = Rc::new(move || {
        let (s, r, rev, live, list, label, n, more, weak) = (
            s.clone(),
            r.clone(),
            rev.clone(),
            live.clone(),
            list.clone(),
            label.clone(),
            n.clone(),
            more.clone(),
            weak.clone(),
        );
        let cursor = more.borrow().clone();
        n.set_sensitive(false);
        glib::spawn_future_local(async move {
            let reader = s.clone();
            let room = r.clone();
            let page = on_tokio(async move { reader.room_members(&room, cursor.as_deref(), Some(&rev)).await }).await;
            if !live.get() {
                return;
            }
            n.set_sensitive(true);
            match page {
                Ok(page) => {
                    *more.borrow_mut() = page.next.clone();
                    n.set_visible(page.next.is_some());
                    if let Some(window) = weak.upgrade() {
                        fill_roster(&list, &label, &window, (s, r), page, can_roles, live);
                    }
                }
                Err(error) => label.set_text(t(error_key(error.code()))),
            }
        });
    });
    let callback = load.clone();
    next.connect_clicked(move |_| callback());
    crate::widgets::present(&window, Some(parent));
    load();
}
fn fill_roster(
    content: &gtk::Box,
    status: &gtk::Label,
    window: &adw::Dialog,
    account: (Arc<NativeSession>, String),
    page: RoomMemberPage,
    can_roles: bool,
    active: Rc<Cell<bool>>,
) {
    let (session, rid) = account;
    for member in page.members {
        let group = adw::PreferencesGroup::builder()
            .title(format!("{} · @{}", member.user.display_name, member.user.username))
            .build();
        group.set_widget_name(&format!("native-room-member-{}", member.user.username));
        if member.user.bot {
            group.set_header_suffix(Some(&crate::widgets::bot_badge()));
        }
        let names = gtk::StringList::new(&[t("rooms.member"), t("rooms.moderator"), t("rooms.owner")]);
        let selected = match member.role {
            RoomRole::Member => 0,
            RoomRole::Moderator => 1,
            RoomRole::Owner => 2,
        };
        let role = adw::ComboRow::builder()
            .title(t(if member.disabled { "rooms.disabled" } else { "rooms.role" }))
            .model(&names)
            .selected(selected)
            .sensitive(can_roles && !member.disabled)
            .build();
        role.add_css_class("native-room-role");
        group.add(&role);
        if can_roles && !member.disabled {
            let apply = button("rooms.apply_role");
            apply.add_css_class("native-room-role-apply");
            group.add(&apply);
            let (s, r, user, revision, live, label, weak) = (
                session.clone(),
                rid.clone(),
                member.user.id,
                page.revision.clone(),
                active.clone(),
                status.clone(),
                window.downgrade(),
            );
            apply.connect_clicked(move |button| {
                let (s, r, user, revision, weak) = (s.clone(), r.clone(), user.clone(), revision.clone(), weak.clone());
                let role = match role.selected() {
                    0 => RoomRole::Member,
                    1 => RoomRole::Moderator,
                    _ => RoomRole::Owner,
                };
                submit(
                    button,
                    &label,
                    live.clone(),
                    async move {
                        s.change_room_role(
                            &r,
                            &user,
                            ChangeRoomRole { operation_id: room_operation_id(), expected_revision: revision, role },
                        )
                        .await
                    },
                    move || {
                        if let Some(window) = weak.upgrade() {
                            window.close();
                        }
                    },
                );
            });
        }
        content.append(&group);
    }
}
