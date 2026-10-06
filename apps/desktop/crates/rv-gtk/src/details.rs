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
mod native_favorites;
mod native_rooms;
pub(crate) use native_favorites::menu as native_favorite_menu;

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
    let membership = session.store.read_state(rid).ok().flatten().and_then(|s| s.membership_version);
    let content = column();
    loading(&content);
    let dialog = dialog(t("info.room"), content.upcast_ref(), 600);
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
        let mut cached: Option<rv_core::native::RoomDetails> = None;
        while rx.recv().await.is_ok() && active.get() {
            let room = session.store.rooms().ok().and_then(|rooms| rooms.into_iter().find(|r| r.id == rid));
            if session.is_closed()
                || room.is_none()
                || session.store.read_state(&rid).ok().flatten().and_then(|s| s.membership_version) != membership
            {
                dialog.close();
                break;
            }
            let room = room.unwrap();
            let personal = room.read_state.as_ref().map(|s| s.revision.clone());
            let favorite =
                session.store.favorite_intent(&rid).ok().flatten().map(|s| (s.input.operation_id, s.phase, s.error));
            let revision = room.revision;
            let intention = session
                .store
                .room_operation(&rid)
                .ok()
                .flatten()
                .map(|saved| (saved.command.id().to_owned(), saved.failed, saved.error));
            let display_key = (revision.clone(), intention, personal, favorite);
            if displayed.as_ref() == Some(&display_key) {
                continue;
            }
            let (s, r) = (session.clone(), rid.clone());
            let result = if session.status().connection != rv_core::session::Connection::Online {
                cached
                    .clone()
                    .filter(|details| details.room.revision == revision)
                    .ok_or(rv_core::native::Error::Protocol("offline"))
            } else {
                on_tokio(async move { s.room_details(&r).await }).await
            };
            if !active.get() {
                break;
            }
            if session.is_closed()
                || session.store.rooms().is_ok_and(|rooms| !rooms.iter().any(|r| r.id == rid))
                || session.store.read_state(&rid).ok().flatten().and_then(|s| s.membership_version) != membership
            {
                dialog.close();
                break;
            }
            while let Some(child) = content.first_child() {
                content.remove(&child);
            }
            match result {
                Ok(details) => {
                    cached = Some(details.clone());
                    let can_invite = details.permissions.invite;
                    let info = rv_core::info::native_room_info(details.clone());
                    let tile = room_tile(&info.name, &info.kind, false, TileSize::Profile);
                    tile.set_halign(gtk::Align::Center);
                    content.append(&tile);
                    content.append(&centered(&info.name, &["details-name"]));
                    fill_room(&content, &info, &session.info.username);
                    native_favorites::controls(&content, session.clone(), &rid, active.clone());
                    if session.crypto_settings_supported() {
                        crate::native_crypto::room_button(&content, &dialog, session.clone(), rid.clone());
                    }
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
                    native_rooms::controls(&content, &dialog, session.clone(), details, active.clone());
                    displayed = Some(display_key);
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
    pub message: Box<dyn Fn(rv_core::rooms::Found)>,
    pub call: Box<dyn Fn(rv_core::rooms::Found)>,
}

/// A person, from `users.info`: by username, or by id when `by_id`.
pub fn profile(parent: &impl IsA<gtk::Widget>, session: Arc<Session>, key: &str, by_id: bool, actions: ProfileActions) {
    profile_with_source(parent, ProfileSource::Legacy(session), key, by_id, actions);
}
pub fn profile_native(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<rv_core::native::NativeSession>,
    key: &str,
    by_id: bool,
    actions: ProfileActions,
) {
    profile_with_source(parent, ProfileSource::Native(session), key, by_id, actions);
}
#[derive(Clone)]
enum ProfileSource {
    Legacy(Arc<Session>),
    Native(Arc<rv_core::native::NativeSession>),
}
impl ProfileSource {
    fn username(&self) -> &str {
        match self {
            Self::Legacy(s) => &s.info.username,
            Self::Native(s) => &s.info.username,
        }
    }
    fn user_id(&self) -> &str {
        match self {
            Self::Legacy(s) => &s.info.user_id,
            Self::Native(s) => &s.info.user_id,
        }
    }
    fn version(&self) -> Option<String> {
        match self {
            Self::Legacy(_) => None,
            Self::Native(s) => Some(s.profile_version()),
        }
    }
    fn closed(&self) -> bool {
        matches!(self,Self::Native(s) if s.is_closed())
    }
    async fn read(&self, key: &str, by_id: bool) -> Result<Profile, rv_core::rest::RestError> {
        match self {
            Self::Legacy(s) => s.profile(key, by_id).await,
            Self::Native(s) => {
                s.profile(key, by_id).await.map(|p| s.profile_presentation(&p)).map_err(rv_core::native::rest_error)
            }
        }
    }
}
fn profile_with_source(
    parent: &impl IsA<gtk::Widget>,
    source: ProfileSource,
    key: &str,
    by_id: bool,
    actions: ProfileActions,
) {
    let content = column();
    loading(&content);
    let dialog = dialog(t("info.profile"), content.upcast_ref(), 520);
    dialog.add_css_class("user-profile-dialog");
    dialog.present(Some(parent));
    let (mut key, mut by_id) = (key.to_owned(), by_id);
    let actions = Rc::new(actions);
    let active = Rc::new(Cell::new(true));
    let (tx, rx) = async_channel::bounded(1);
    tx.try_send(()).ok();
    let forward = if let ProfileSource::Native(s) = &source {
        let (mut changes, mut events) = (s.store.changes(), s.events());
        Some(crate::runtime().spawn(async move {
            loop {
                tokio::select! {_=changes.recv()=>{},_=events.recv()=>{}};
                if tx.try_send(()).is_err_and(|e| matches!(e, async_channel::TrySendError::Closed(_))) {
                    return;
                }
            }
        }))
    } else {
        None
    };
    let live = active.clone();
    dialog.connect_closed(move |_| {
        live.set(false);
        if let Some(task) = &forward {
            task.abort();
        }
    });
    glib::spawn_future_local(async move {
        let mut displayed = None;
        while rx.recv().await.is_ok() && active.get() {
            if source.closed() {
                dialog.close();
                return;
            }
            let version = source.version();
            if displayed.as_ref() == Some(&version) {
                continue;
            }
            let (s, k) = (source.clone(), key.clone());
            let found = on_tokio(async move { s.read(&k, by_id).await }).await;
            if !active.get() {
                return;
            }
            if source.closed() {
                dialog.close();
                return;
            }
            while let Some(child) = content.first_child() {
                content.remove(&child);
            }
            match found {
                Ok(p) => {
                    key = p.id.clone();
                    by_id = true;
                    fill_profile(&content, &dialog, &source, &p, actions.clone());
                    displayed = Some(source.version());
                }
                Err(_) => {
                    content.append(&centered(t("info.failed"), &["details-sub"]));
                }
            }
        }
    });
}

fn fill_profile(
    content: &gtk::Box,
    dialog: &adw::Dialog,
    session: &ProfileSource,
    p: &Profile,
    actions: Rc<ProfileActions>,
) {
    let tile = widgets::tile(&p.username, &widgets::initial(&p.username), TileSize::Profile, false);
    let tile = match session {
        ProfileSource::Legacy(s) => {
            with_photo(tile, Some(s), Some(avatar_path(AvatarTarget::User(&p.username), p.avatar_etag.as_deref())))
        }
        ProfileSource::Native(s) => crate::rows::with_native_photo(tile, s, p.avatar_etag.clone()),
    };
    tile.set_halign(gtk::Align::Center);
    content.append(&tile);
    content.append(&centered(p.name.as_deref().unwrap_or(&p.username), &["details-name"]));
    content.append(&centered(&format!("@{}", p.username), &["details-sub"]));
    if let Some(presence) = match session {
        ProfileSource::Legacy(s) => s.presence(&p.id).or(p.presence),
        ProfileSource::Native(_) => p.presence,
    } {
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
        section(content, t("info.bio"), bio, session.username());
    }
    if let ProfileSource::Native(native) = session
        && native.crypto_settings_supported()
    {
        crate::native_crypto::profile_button(content, dialog, native.clone(), p.id.clone());
    }
    if p.id != session.user_id() {
        let buttons = gtk::Box::builder().spacing(10).halign(gtk::Align::Center).margin_top(12).build();
        let message = gtk::Button::builder().label(t("info.message")).css_classes(["file-action"]).build();
        let call = gtk::Button::builder().label(t("info.call")).css_classes(["flat"]).build();
        let (a, d, found) = (
            actions.clone(),
            dialog.clone(),
            rv_core::rooms::Found::User { id: p.id.clone(), username: p.username.clone(), name: p.name.clone() },
        );
        message.connect_clicked(move |_| {
            d.close();
            (a.message)(found.clone());
        });
        let (a, d, found) = (
            actions,
            dialog.clone(),
            rv_core::rooms::Found::User { id: p.id.clone(), username: p.username.clone(), name: p.name.clone() },
        );
        call.connect_clicked(move |_| {
            d.close();
            (a.call)(found.clone());
        });
        buttons.append(&message);
        if match session {
            ProfileSource::Legacy(_) => true,
            ProfileSource::Native(session) => session.supported_features().iter().any(|f| f == "calls"),
        } {
            buttons.append(&call);
        }
        content.append(&buttons);
    }
}

/// `chat.search` in the open room, as you type. A result picked closes the
/// dialog and goes to it: `go(message id, thread root)`.
pub fn search(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<Session>,
    rid: &str,
    go: impl Fn(String, Option<String>) + 'static,
) {
    search_with_source(parent, SearchSource::Legacy(session), rid, go);
}
/// The native provider's search, with the same dialog and `go`.
pub fn search_native(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<rv_core::native::NativeSession>,
    rid: &str,
    go: impl Fn(String, Option<String>) + 'static,
) -> adw::Dialog {
    search_with_source(parent, SearchSource::Native(session), rid, go)
}
/// Private search of an encrypted RocketVibe room, on this device only.
pub fn search_private(
    parent: &impl IsA<gtk::Widget>,
    access: rv_core::native::crypto::enrollment::rooms::messages::Access,
    username: String,
    rid: &str,
    go: impl Fn(String, Option<String>) + 'static,
) -> adw::Dialog {
    search_with_source(parent, SearchSource::Private(access, username), rid, go)
}
#[derive(Clone)]
enum SearchSource {
    Legacy(Arc<Session>),
    Native(Arc<rv_core::native::NativeSession>),
    Private(rv_core::native::crypto::enrollment::rooms::messages::Access, String),
}
impl SearchSource {
    fn username(&self) -> &str {
        match self {
            Self::Legacy(s) => &s.info.username,
            Self::Native(s) => &s.info.username,
            Self::Private(_, username) => username,
        }
    }
    fn version(&self) -> Option<String> {
        match self {
            Self::Legacy(_) | Self::Private(..) => None,
            Self::Native(s) => Some(s.search_version().unwrap_or_else(|_| "unavailable".into())),
        }
    }
    async fn search(&self, rid: &str, text: &str) -> Result<Vec<rv_core::normalize::Message>, ()> {
        match self {
            Self::Legacy(s) => s.search(rid, text).await.map_err(|_| ()),
            Self::Native(s) => s.search(rid, text).await.map_err(|_| ()),
            Self::Private(access, _) => Ok(access
                .search(text.to_owned())
                .await
                .map_err(|_| ())?
                .into_iter()
                .map(|m| rv_core::normalize::Message {
                    id: m.row.id,
                    rid: m.row.rid,
                    text: m.row.text,
                    ts: m.row.ts,
                    author_id: m.row.author_id,
                    author_name: m.row.author,
                    thread_id: m.row.thread_id,
                    md: m.row.md,
                    ..Default::default()
                })
                .collect()),
        }
    }
}
fn search_with_source(
    parent: &impl IsA<gtk::Widget>,
    session: SearchSource,
    rid: &str,
    go: impl Fn(String, Option<String>) + 'static,
) -> adw::Dialog {
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
    let weak = dialog.downgrade();
    let go: Rc<dyn Fn(String, Option<String>)> = Rc::new(move |id, thread| {
        if let Some(dialog) = weak.upgrade() {
            dialog.close();
        }
        go(id, thread);
    });
    let generation = Rc::new(Cell::new(0u64));
    if matches!(&session, SearchSource::Native(_)) {
        let (source, generation, results, status) =
            (session.clone(), generation.clone(), results.clone(), status.clone());
        let dialog = dialog.downgrade();
        let mut version = source.version();
        glib::timeout_add_local(std::time::Duration::from_millis(200), move || {
            let Some(dialog) = dialog.upgrade() else { return glib::ControlFlow::Break };
            if !dialog.is_visible() {
                return glib::ControlFlow::Break;
            }
            let next = source.version();
            if next != version {
                version = next;
                generation.set(generation.get() + 1);
                while let Some(child) = results.first_child() {
                    results.remove(&child);
                }
                status.set_visible(true);
                status.set_label(t("search.changed"));
            }
            glib::ControlFlow::Continue
        });
    }
    let rid = rid.to_owned();
    entry.connect_activate(|entry| {
        entry.emit_by_name::<()>("search-changed", &[]);
    });
    entry.connect_search_changed(move |entry| {
        let query = entry.text().trim().to_owned();
        let current = generation.get() + 1;
        generation.set(current);
        let (session, generation, results, status, rid, go) =
            (session.clone(), generation.clone(), results.clone(), status.clone(), rid.clone(), go.clone());
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
            let me = session.username().to_owned();
            let version = session.version();
            glib::spawn_future_local(async move {
                let request = session.clone();
                let found = on_tokio(async move { request.search(&rid, &query).await }).await;
                if generation.get() != current || session.version() != version {
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
                            hit.set_cursor(gtk::gdk::Cursor::from_name("pointer", None).as_ref());
                            let click = gtk::GestureClick::new();
                            let (go, id, thread) = (go.clone(), m.id.clone(), m.thread_id.clone());
                            click.connect_released(move |_, _, _, _| go(id.clone(), thread.clone()));
                            hit.add_controller(click);
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
    dialog
}
