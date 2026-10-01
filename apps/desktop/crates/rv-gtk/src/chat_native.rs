//! Native provider binding for the existing ChatPage, MessageList and Composer.
use super::*;
use rv_core::native::{NativeSession, RoomKind};
use tokio::sync::broadcast::error::RecvError;

impl ChatPage {
    pub fn native_session(&self) -> Option<Arc<NativeSession>> {
        self.native.borrow().clone()
    }

    pub fn set_native_session(self: &Rc<Self>, session: Arc<NativeSession>) {
        self.set_session(None);
        self.native.replace(Some(session.clone()));
        self.native_features(&session);
        self.account_name.set_label(&session.info.username);
        let host = url::Url::parse(&session.info.base_url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_default();
        self.account_host.set_label(&host);
        while let Some(child) = self.account_tile.first_child() {
            self.account_tile.remove(&child);
        }
        self.account_tile.append(&widgets::tile(
            &session.info.username,
            &widgets::initial(&session.info.username),
            TileSize::Message,
            false,
        ));
        self.reload_rooms();
        let (tx, rx) = async_channel::bounded(1);
        let (mut changes, mut events) = (session.store.changes(), session.events());
        self.native_forward.replace(Some(runtime().spawn(async move {
            loop {
                let change = tokio::select! { c = changes.recv() => c, e = events.recv() => e };
                if matches!(change, Err(RecvError::Closed)) {
                    return;
                }
                if tx.send(()).await.is_err() {
                    return;
                }
            }
        })));
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            while rx.recv().await.is_ok() {
                let Some(this) = weak.upgrade() else {
                    return;
                };
                if this.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &session)) {
                    return;
                }
                let status = session.status();
                let changed = this.connection.get() != status.connection;
                this.set_connection(status.connection);
                this.native_features(&session);
                this.reload_rooms();
                if this.current_rid().is_some_and(|rid| !this.has_room(&rid)) {
                    this.current.replace(None);
                    this.list.clear();
                    this.composer.set_text("");
                    this.content_stack.set_visible_child_name("empty");
                    this.split.set_show_content(false);
                } else {
                    this.reload_messages();
                    if changed && status.connection == Connection::Online && this.current_rid().is_some() {
                        let page = this.clone();
                        glib::spawn_future_local(async move {
                            page.native_history(false).await;
                        });
                    }
                }
                if changed && let Some(error) = status.error {
                    this.toast(t(native_error_key(&error)).to_owned());
                }
            }
        });
    }

    fn native_features(&self, session: &NativeSession) {
        let features = session.supported_features();
        let supports = |feature| features.iter().any(|f| f == feature);
        self.search_button.set_sensitive(supports("search"));
        self.marked_button.set_sensitive(supports("pins") && supports("stars"));
    }

    pub(super) fn native_rooms(&self) -> Vec<RoomRow> {
        let Some(session) = self.native_session() else {
            return vec![];
        };
        session
            .store
            .rooms()
            .unwrap_or_default()
            .into_iter()
            .map(|room| {
                let last = session.store.messages(&room.id, 1).ok().and_then(|mut r| r.pop());
                RoomRow {
                    rid: room.id,
                    kind: match room.kind {
                        RoomKind::Direct => "d",
                        RoomKind::Private => "p",
                        RoomKind::Public => "c",
                    }
                    .into(),
                    name: room.name,
                    last_message: last.as_ref().map(|r| r.text.clone()),
                    last_ts: last.as_ref().map_or(0, |r| r.ts),
                    unread: 0,
                    mentions: 0,
                    alert: false,
                    favorite: false,
                    encrypted: false,
                    read_only: false,
                    dm_other_uid: None,
                    avatar_etag: None,
                    slug: None,
                    last_type: None,
                    last_author: last.map(|r| r.author),
                    last_encrypted: None,
                }
            })
            .collect()
    }

    pub(super) fn open_native_room(self: &Rc<Self>, rid: &str) {
        let Some(session) = self.native_session() else {
            return;
        };
        let Some(room) = self.rooms.borrow().iter().find(|r| r.rid == rid).cloned() else {
            return;
        };
        if self.current_rid().as_deref() == Some(rid) {
            self.split.set_show_content(true);
            return;
        }
        self.remember(rid);
        self.current.replace(Some(OpenRoom {
            rid: room.rid.clone(),
            kind: room.kind,
            name: room.name.clone(),
            read_only: false,
            encrypted: false,
            avatar: None,
            slug: None,
            dm_other_uid: None,
        }));
        self.typing_label.set_visible(false);
        self.call_button.set_visible(false);
        self.upload_strip.set_visible(false);
        self.list.set_unread_after(None);
        self.select_current(true);
        self.refresh_room_header();
        self.content_stack.set_visible_child_name("room");
        self.split.set_show_content(true);
        self.room_nav.pop_to_tag("room");
        self.thread.replace(None);
        self.limit.set(HISTORY_PAGE);
        self.has_older.set(true);
        self.set_loading(false);
        self.composer.clear_reply();
        self.composer.bind_native(&session, rid);
        self.list.clear();
        self.reload_messages();
        self.composer.grab_focus();
        for f in self.on_room_opened.borrow().iter() {
            f(rid.to_owned());
        }
        for f in self.on_room_changed.borrow().iter() {
            f(Some(room.name.clone()));
        }
        let this = self.clone();
        glib::spawn_future_local(async move {
            this.native_history(false).await;
        });
    }

    pub(super) async fn native_history(self: &Rc<Self>, older: bool) -> bool {
        if self.loading.get() || (older && !self.has_older.get()) {
            return false;
        }
        let (Some(session), Some(rid)) = (self.native_session(), self.current_rid()) else {
            return false;
        };
        if session.status().connection != Connection::Online {
            return false;
        }
        self.set_loading(true);
        let (s, r) = (session.clone(), rid.clone());
        let result = on_tokio(async move { s.history(&r, older).await }).await;
        if self.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &session))
            || self.current_rid().as_deref() != Some(&rid)
        {
            return false;
        }
        self.set_loading(false);
        match result {
            Ok(more) => {
                self.has_older.set(more);
                if older {
                    self.limit.set(self.limit.get() + HISTORY_PAGE);
                }
                self.reload_messages();
                true
            }
            Err(error) => {
                self.native_error(&error);
                false
            }
        }
    }

    pub fn native_error(&self, error: &rv_core::native::Error) {
        self.toast(t(native_error_key(error.code())).to_owned());
    }

    pub(super) fn native_settings(self: &Rc<Self>) {
        let Some(session) = self.native_session() else {
            return;
        };
        let weak = Rc::downgrade(self);
        crate::settings::open_native(&self.split, &session.info, self.account_actions.borrow().clone(), move || {
            if let Some(this) = weak.upgrade() {
                for f in this.on_logout.borrow().iter() {
                    f(());
                }
            }
        });
    }

    pub(super) fn native_row_event(self: &Rc<Self>, event: RowEvent) {
        match event {
            RowEvent::Retry(id) => self.retry(id),
            RowEvent::Menu { row, anchor, x, y } => {
                let popover = gtk::Popover::builder().has_arrow(false).build();
                popover.set_parent(&anchor);
                popover.set_pointing_to(Some(&gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
                let list = gtk::Box::new(gtk::Orientation::Vertical, 0);
                let copy = gtk::Button::builder().label(t("actions.copy")).css_classes(["flat"]).build();
                let (a, text, p) = (anchor.clone(), row.text.clone().unwrap_or_default(), popover.clone());
                copy.connect_clicked(move |_| {
                    a.clipboard().set_text(&text);
                    p.popdown();
                });
                list.append(&copy);
                if row.outbox_status.as_deref() == Some("failed") {
                    for (key, abandon) in [("native.retry", false), ("native.abandon", true)] {
                        let button = gtk::Button::builder().label(t(key)).css_classes(["flat"]).build();
                        let (weak, id, p) = (Rc::downgrade(self), row.id.clone(), popover.clone());
                        button.connect_clicked(move |_| {
                            if let Some(this) = weak.upgrade() {
                                if abandon {
                                    if let Some(s) = this.native_session()
                                        && let Err(e) = s.store.abandon(&id)
                                    {
                                        this.toast(e.to_string());
                                    }
                                } else {
                                    this.retry(id.clone());
                                }
                            }
                            p.popdown();
                        });
                        list.append(&button);
                    }
                }
                popover.set_child(Some(&list));
                popover.connect_closed(|p| p.unparent());
                popover.popup();
            }
            _ => {}
        }
    }

    pub(super) fn native_conversation(self: &Rc<Self>, invite: bool) {
        let Some(session) = self.native_session() else {
            return;
        };
        let dialog =
            adw::PreferencesDialog::builder().title(t(if invite { "native.invite" } else { "rooms.new" })).build();
        let page = adw::PreferencesPage::new();
        let group = adw::PreferencesGroup::new();
        let entry = adw::EntryRow::builder().title(t("native.username")).build();
        group.add(&entry);
        let button = adw::ButtonRow::builder().title(t(if invite { "native.invite" } else { "native.direct" })).build();
        group.add(&button);
        let (weak, d, s, r) = (Rc::downgrade(self), dialog.clone(), session.clone(), self.current_rid());
        button.connect_activated(move |b| {
            b.set_sensitive(false);
            let (weak, d, s, r, username, b) =
                (weak.clone(), d.clone(), s.clone(), r.clone(), entry.text().to_string(), b.clone());
            let expected = s.clone();
            glib::spawn_future_local(async move {
                let result = on_tokio(async move {
                    if invite {
                        s.invite(r.as_deref().unwrap_or_default(), &username).await.map(|()| r.unwrap_or_default())
                    } else {
                        s.direct(&username).await
                    }
                })
                .await;
                b.set_sensitive(true);
                let Some(this) = weak.upgrade() else {
                    return;
                };
                if this.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &expected)) {
                    return;
                }
                match result {
                    Ok(rid) => {
                        d.close();
                        this.reload_rooms();
                        this.open_room(&rid);
                    }
                    Err(e) => d.add_toast(adw::Toast::new(t(native_error_key(e.code())))),
                }
            });
        });
        page.add(&group);
        if !invite {
            let group = adw::PreferencesGroup::new();
            let name = adw::EntryRow::builder().title(t("native.room_name")).build();
            let private = adw::SwitchRow::builder().title(t("native.private")).active(true).build();
            let create = adw::ButtonRow::builder().title(t("native.create")).build();
            group.add(&name);
            group.add(&private);
            group.add(&create);
            let (weak, d, s) = (Rc::downgrade(self), dialog.clone(), session.clone());
            create.connect_activated(move |b| {
                b.set_sensitive(false);
                let (weak, d, s, name, private, b) =
                    (weak.clone(), d.clone(), s.clone(), name.text().to_string(), private.is_active(), b.clone());
                let expected = s.clone();
                glib::spawn_future_local(async move {
                    let result = on_tokio(async move { s.create_room(&name, private).await }).await;
                    b.set_sensitive(true);
                    let Some(this) = weak.upgrade() else {
                        return;
                    };
                    if this.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &expected)) {
                        return;
                    }
                    match result {
                        Ok(rid) => {
                            d.close();
                            this.reload_rooms();
                            this.open_room(&rid);
                        }
                        Err(e) => d.add_toast(adw::Toast::new(t(native_error_key(e.code())))),
                    }
                });
            });
            page.add(&group);
        }
        dialog.add(&page);
        dialog.present(Some(&self.split));
    }
}

fn native_error_key(code: &str) -> &'static str {
    match code {
        "server_identity_changed" => "native.identity_changed",
        "session_rejected" => "login.expired",
        "offline" => "native.offline",
        "user_not_found" => "native.user_missing",
        _ => "native.error",
    }
}
