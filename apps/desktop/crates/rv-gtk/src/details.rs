//! Details on demand: a room's information, a person's profile, and search
//! in the room's messages.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::info::{Profile, RoomInfo, local_time};
use rv_core::markdown;
use rv_core::media::{AvatarTarget, avatar_path};
use rv_core::session::Session;

use crate::i18n::{t, tf, tn};
use crate::rows::{label, local, presence_dot, room_tile, with_photo};
use crate::widgets::{self, TileSize};
use crate::{markdown_view, on_tokio};

fn dialog(title: &str, content: &gtk::Widget, height: i32) -> adw::Dialog {
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(
        &gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_height(true)
            .child(content)
            .build(),
    ));
    adw::Dialog::builder().title(title).content_width(420).content_height(height).child(&view).build()
}

fn column() -> gtk::Box {
    gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).css_classes(["details"]).build()
}

fn centered(text: &str, classes: &[&str]) -> gtk::Label {
    let l = label(text, classes);
    l.set_xalign(0.5);
    l.set_wrap(true);
    l.set_justify(gtk::Justification::Center);
    l
}

fn section(parent: &gtk::Box, title: &str, text: &str, me: &str) {
    parent.append(&label(title, &["details-section"]));
    let blocks = markdown::render(None, Some(text), &markdown::Context { me });
    parent.append(&markdown_view::view(&blocks, &[]));
}

fn loading(parent: &gtk::Box) -> gtk::Spinner {
    let spinner = gtk::Spinner::builder().spinning(true).margin_top(12).build();
    parent.append(&spinner);
    spinner
}

/// Channel or group: its name, flags, members and texts from `rooms.info`.
pub fn room_info(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<Session>,
    rid: &str,
    name: &str,
    kind: &str,
    avatar: Option<String>,
) {
    let content = column();
    let tile = with_photo(room_tile(name, kind, false, TileSize::Profile), Some(&session), avatar);
    tile.set_halign(gtk::Align::Center);
    content.append(&tile);
    content.append(&centered(name, &["details-name"]));
    let spinner = loading(&content);
    let dialog = dialog(t("info.room"), content.upcast_ref(), 460);
    dialog.present(Some(parent));
    let rid = rid.to_owned();
    let me = session.info.username.clone();
    glib::spawn_future_local(async move {
        let info = on_tokio(async move { session.room_info(&rid).await }).await;
        spinner.set_visible(false);
        match info {
            Ok(info) => fill_room(&content, &info, &me),
            Err(_) => content.append(&centered(t("info.failed"), &["details-sub"])),
        }
    });
}

fn fill_room(content: &gtk::Box, info: &RoomInfo, me: &str) {
    let mut facts = vec![
        t(if info.kind == "d" {
            "native.direct"
        } else if info.kind == "p" {
            "info.private"
        } else {
            "info.public"
        })
        .to_owned(),
    ];
    if let Some(n) = info.members {
        facts.push(tn("info.members", n));
    }
    for (flag, key) in [
        (info.read_only, "info.read_only"),
        (info.encrypted, "info.encrypted"),
        (info.archived, "info.archived"),
        (info.default, "info.default"),
    ] {
        if flag {
            facts.push(t(key).to_owned());
        }
    }
    content.append(&centered(&facts.join(" · "), &["details-sub"]));
    for (text, key) in [
        (&info.topic, "info.topic"),
        (&info.announcement, "info.announcement"),
        (&info.description, "info.description"),
    ] {
        if let Some(text) = text {
            section(content, t(key), text, me);
        }
    }
    if info.topic.is_none() && info.announcement.is_none() && info.description.is_none() {
        content.append(&centered(t("info.nothing"), &["details-sub"]));
    }
}

/// Same information dialog, fed by the native provider. A room removal or an
/// account switch closes it; the original invitation form remains accessible.
pub fn native_room_info(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<rv_core::native::NativeSession>,
    rid: &str,
    invite: Rc<dyn Fn()>,
) {
    use tokio::sync::broadcast::error::RecvError;
    let content = column();
    loading(&content);
    let dialog = dialog(t("info.room"), content.upcast_ref(), 460);
    let active = Rc::new(Cell::new(true));
    let (tx, rx) = async_channel::bounded(1);
    let (mut changes, mut events) = (session.store.changes(), session.events());
    tx.try_send(()).ok();
    let forward = crate::runtime().spawn(async move {
        loop {
            let update = tokio::select! { result = changes.recv() => result, result = events.recv() => result };
            if matches!(update, Err(RecvError::Closed)) {
                return;
            }
            if let Err(async_channel::TrySendError::Closed(_)) = tx.try_send(()) {
                return;
            }
        }
    });
    let abort = forward.abort_handle();
    let live = active.clone();
    dialog.connect_closed(move |_| {
        live.set(false);
        abort.abort();
    });
    dialog.present(Some(parent));
    let rid = rid.to_owned();
    glib::spawn_future_local(async move {
        let mut displayed = None;
        while rx.recv().await.is_ok() && active.get() {
            let room = session.store.rooms().ok().and_then(|rooms| rooms.into_iter().find(|r| r.id == rid));
            if session.is_closed() || room.is_none() {
                dialog.close();
                break;
            }
            let revision = room.unwrap().revision;
            if displayed.as_ref() == Some(&revision) {
                continue;
            }
            let (s, r) = (session.clone(), rid.clone());
            let result = on_tokio(async move { s.room_details(&r).await }).await;
            if !active.get() {
                break;
            }
            if session.is_closed() || session.store.rooms().is_ok_and(|rooms| !rooms.iter().any(|r| r.id == rid)) {
                dialog.close();
                break;
            }
            while let Some(child) = content.first_child() {
                content.remove(&child);
            }
            match result {
                Ok(details) => {
                    let can_invite = details.permissions.invite;
                    let info = rv_core::info::native_room_info(details);
                    let tile = room_tile(&info.name, &info.kind, false, TileSize::Profile);
                    tile.set_halign(gtk::Align::Center);
                    content.append(&tile);
                    content.append(&centered(&info.name, &["details-name"]));
                    fill_room(&content, &info, &session.info.username);
                    if can_invite {
                        let button = gtk::Button::builder().label(t("native.invite")).build();
                        let (callback, live) = (invite.clone(), active.clone());
                        button.connect_clicked(move |_| {
                            if live.get() {
                                callback();
                            }
                        });
                        content.append(&button);
                    }
                    displayed = Some(revision);
                }
                Err(_) => {
                    displayed = None;
                    content.append(&centered(t("info.failed"), &["details-sub"]));
                }
            }
        }
    });
}

/// What the profile's buttons do.
pub struct ProfileActions {
    pub message: Box<dyn Fn(String)>,
    pub call: Box<dyn Fn(String)>,
}

/// A person, from `users.info`: by username, or by id when `by_id`.
pub fn profile(parent: &impl IsA<gtk::Widget>, session: Arc<Session>, key: &str, by_id: bool, actions: ProfileActions) {
    let content = column();
    let spinner = loading(&content);
    let dialog = dialog(t("info.profile"), content.upcast_ref(), 520);
    dialog.present(Some(parent));
    let (key, s) = (key.to_owned(), session.clone());
    let actions = Rc::new(actions);
    glib::spawn_future_local(async move {
        let found = on_tokio(async move { s.profile(&key, by_id).await }).await;
        spinner.set_visible(false);
        match found {
            Ok(p) => fill_profile(&content, &dialog, &session, &p, actions),
            Err(_) => content.append(&centered(t("info.failed"), &["details-sub"])),
        }
    });
}

fn fill_profile(
    content: &gtk::Box,
    dialog: &adw::Dialog,
    session: &Arc<Session>,
    p: &Profile,
    actions: Rc<ProfileActions>,
) {
    let tile = widgets::tile(&p.username, &widgets::initial(&p.username), TileSize::Profile, false);
    let tile =
        with_photo(tile, Some(session), Some(avatar_path(AvatarTarget::User(&p.username), p.avatar_etag.as_deref())));
    tile.set_halign(gtk::Align::Center);
    content.append(&tile);
    content.append(&centered(p.name.as_deref().unwrap_or(&p.username), &["details-name"]));
    content.append(&centered(&format!("@{}", p.username), &["details-sub"]));
    if let Some(presence) = session.presence(&p.id).or(p.presence) {
        let line = gtk::Box::builder().spacing(6).halign(gtk::Align::Center).build();
        let dot = presence_dot(presence, &[]);
        dot.set_valign(gtk::Align::Center);
        line.append(&dot);
        let text = match &p.status_text {
            Some(status) => format!("{} · {status}", t(&format!("presence.{}", presence.as_str()))),
            None => t(&format!("presence.{}", presence.as_str())).to_owned(),
        };
        line.append(&label(&text, &["details-sub"]));
        content.append(&line);
    }
    if !p.roles.is_empty() {
        let roles = gtk::Box::builder().spacing(6).halign(gtk::Align::Center).margin_top(4).build();
        for role in &p.roles {
            roles.append(&label(role, &["role-chip"]));
        }
        content.append(&roles);
    }
    if let Some(offset) = p.utc_offset {
        content.append(&centered(
            &tf("info.local_time", &[("time", &local_time(offset, chrono::Utc::now()))]),
            &["details-sub"],
        ));
    }
    if let Some(bio) = &p.bio {
        section(content, t("info.bio"), bio, &session.info.username);
    }
    if p.username != session.info.username {
        let buttons = gtk::Box::builder().spacing(10).halign(gtk::Align::Center).margin_top(12).build();
        let message = gtk::Button::builder().label(t("info.message")).css_classes(["file-action"]).build();
        let call = gtk::Button::builder().label(t("info.call")).css_classes(["flat"]).build();
        let (a, d, username) = (actions.clone(), dialog.clone(), p.username.clone());
        message.connect_clicked(move |_| {
            d.close();
            (a.message)(username.clone());
        });
        let (a, d, username) = (actions, dialog.clone(), p.username.clone());
        call.connect_clicked(move |_| {
            d.close();
            (a.call)(username.clone());
        });
        buttons.append(&message);
        buttons.append(&call);
        content.append(&buttons);
    }
}

/// `chat.search` in the open room, as you type.
pub fn search(parent: &impl IsA<gtk::Widget>, session: Arc<Session>, rid: &str) {
    let entry = gtk::SearchEntry::builder().placeholder_text(t("search.placeholder")).build();
    let results = gtk::Box::builder().orientation(gtk::Orientation::Vertical).build();
    let status = gtk::Label::builder().css_classes(["details-sub"]).visible(false).margin_top(10).build();
    let content = column();
    content.append(&entry);
    content.append(&status);
    content.append(&results);
    let dialog = dialog(t("search.title"), content.upcast_ref(), 560);
    dialog.present(Some(parent));
    entry.grab_focus();
    let generation = Rc::new(Cell::new(0u64));
    let rid = rid.to_owned();
    entry.connect_search_changed(move |entry| {
        let query = entry.text().trim().to_owned();
        let current = generation.get() + 1;
        generation.set(current);
        let (session, generation, results, status, rid) =
            (session.clone(), generation.clone(), results.clone(), status.clone(), rid.clone());
        glib::timeout_add_local_once(std::time::Duration::from_millis(350), move || {
            if generation.get() != current {
                return;
            }
            while let Some(child) = results.first_child() {
                results.remove(&child);
            }
            if query.is_empty() {
                status.set_visible(false);
                return;
            }
            let me = session.info.username.clone();
            glib::spawn_future_local(async move {
                let found = on_tokio(async move { session.search(&rid, &query).await }).await;
                if generation.get() != current {
                    return;
                }
                match found {
                    Ok(messages) => {
                        status.set_visible(messages.is_empty());
                        status.set_label(t("search.none"));
                        for m in messages {
                            let hit = gtk::Box::builder()
                                .orientation(gtk::Orientation::Vertical)
                                .spacing(2)
                                .css_classes(["search-hit"])
                                .build();
                            let head = gtk::Box::builder().spacing(8).build();
                            head.append(&label(m.author_name.as_deref().unwrap_or_default(), &["author"]));
                            head.append(&label(&local(m.ts).format("%d/%m/%Y %H:%M").to_string(), &["message-time"]));
                            hit.append(&head);
                            let blocks =
                                markdown::render(m.md.as_deref(), m.text.as_deref(), &markdown::Context { me: &me });
                            hit.append(&markdown_view::view(&blocks, &[]));
                            results.append(&hit);
                        }
                    }
                    Err(_) => {
                        status.set_visible(true);
                        status.set_label(t("search.failed"));
                    }
                }
            });
        });
    });
}
