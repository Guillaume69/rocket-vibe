//! Native provider binding for the existing ChatPage, MessageList and Composer.
use super::*;
use rv_core::native::NativeSession;
use tokio::sync::broadcast::error::RecvError;

impl ChatPage {
    pub fn native_session(&self) -> Option<Arc<NativeSession>> {
        self.native.borrow().clone()
    }

    pub fn set_native_session(self: &Rc<Self>, session: Arc<NativeSession>) {
        self.set_session(None);
        self.native_edit.replace(None);
        self.native.replace(Some(session.clone()));
        self.list.set_native_provider(session.clone());
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
                this.refresh_uploads();
                this.refresh_room_header();
                if let Some(rid) = this.current_rid() {
                    this.on_typing(&rid);
                }
                let changed_membership = this.native_membership.borrow().as_ref().is_some_and(|(rid, previous)| {
                    !this.has_room(rid)
                        || session.store.read_state(rid).ok().flatten().and_then(|s| s.membership_version) != *previous
                });
                if changed_membership {
                    this.invalidate_native_room();
                }
                if let Some(rid) = this.current_rid()
                    && session.store.room_access(&rid).ok().flatten().is_none()
                    && session.supported_features().iter().any(|f| f == "room_info")
                {
                    let access_session = session.clone();
                    runtime().spawn(async move {
                        let _ = access_session.refresh_room_access(&rid).await;
                    });
                }
                if this.current_rid().is_some_and(|rid| !this.has_room(&rid)) {
                    this.invalidate_native_room();
                } else {
                    this.reload_messages();
                    this.schedule_native_read();
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

    pub(super) fn invalidate_native_room(&self) {
        self.native_unread_after.replace(None);
        self.native_read_pending.set(false);
        self.native_read_last.replace(None);
        self.native_membership.replace(None);
        self.native_edit.replace(None);
        self.read_generation.set(self.read_generation.get().wrapping_add(1));
        self.current.replace(None);
        self.thread.replace(None);
        self.composer.unbind_native();
        self.composer.clear_reply();
        self.composer.set_text("");
        self.list.clear();
        self.room_nav.pop_to_tag("room");
        self.content_stack.set_visible_child_name("empty");
        self.split.set_show_content(false);
        for f in self.on_room_changed.borrow().iter() {
            f(None);
        }
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
        session.room_rows().unwrap_or_default()
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
        self.read_generation.set(self.read_generation.get().wrapping_add(1));
        self.native_read_pending.set(false);
        self.native_read_last.replace(None);
        self.native_unread_after.replace(session.store.read_state(rid).ok().flatten().map(|s| s.root_position));
        self.native_edit.replace(None);
        self.native_membership.replace(Some((
            rid.to_owned(),
            session.store.read_state(rid).ok().flatten().and_then(|s| s.membership_version),
        )));
        self.current.replace(Some(OpenRoom {
            rid: room.rid.clone(),
            kind: room.kind,
            name: room.name.clone(),
            read_only: room.read_only,
            encrypted: false,
            avatar: room.avatar_etag.map(|id| format!("rv-avatar:{id}")),
            slug: None,
            dm_other_uid: room.dm_other_uid,
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
        let (access_session, access_room) = (session.clone(), rid.to_owned());
        runtime().spawn(async move {
            let _ = access_session.refresh_room_access(&access_room).await;
        });
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

    /// Capture a displayed ID once; arrivals cannot postpone the pending timer
    /// or replace its target with a newer message from the cache.
    pub(super) fn schedule_native_read(&self) {
        let Some(session) = self.native_session() else {
            return;
        };
        if !session.supported_features().iter().any(|f| f == "read_markers") || self.native_read_pending.get() {
            return;
        }
        let active = self.split.root().and_downcast::<gtk::Window>().is_some_and(|w| {
            w.is_active() && gtk::prelude::RootExt::focus(&w).is_some_and(|f| f.is_ancestor(&self.split))
        });
        if !active || !(self.split.shows_content() || !self.split.is_collapsed()) {
            return;
        }
        let Some((rid, Some(membership))) = self.native_membership.borrow().clone() else {
            return;
        };
        let thread = (self.room_nav.visible_page().and_then(|p| p.tag()).as_deref() == Some("thread"))
            .then(|| self.thread.borrow().clone())
            .flatten();
        let list = thread.as_ref().map_or_else(|| self.list.clone(), |t| t.list.clone());
        if !list.is_pinned() {
            return;
        }
        let root = thread.as_ref().map(|t| t.root_id.clone());
        if thread.as_ref().is_some_and(|t| t.membership.as_deref() != Some(&membership)) {
            return;
        }
        let Some(message) = list.visible_confirmed_id() else {
            return;
        };
        if self.native_read_last.borrow().as_ref() == Some(&message) {
            return;
        }
        let generation = self.read_generation.get();
        let (counter, pending, last, list, split) = (
            self.read_generation.clone(),
            self.native_read_pending.clone(),
            self.native_read_last.clone(),
            list,
            self.split.clone(),
        );
        self.native_read_pending.set(true);
        let navigation = self.room_nav.clone();
        glib::timeout_add_local_once(std::time::Duration::from_millis(1500), move || {
            if counter.get() != generation {
                return;
            }
            pending.set(false);
            let active = split.root().and_downcast::<gtk::Window>().is_some_and(|w| {
                w.is_active() && gtk::prelude::RootExt::focus(&w).is_some_and(|f| f.is_ancestor(&split))
            });
            let in_thread = navigation.visible_page().and_then(|p| p.tag()).as_deref() == Some("thread");
            if active
                && root.is_some() == in_thread
                && (split.shows_content() || !split.is_collapsed())
                && list.is_pinned()
                && !session.is_closed()
            {
                let result = if let Some(root) = &root {
                    session.mark_observed_thread_read(root, &message, &membership)
                } else {
                    session.mark_observed_read_from_membership(&rid, &message, &membership)
                };
                if result.is_ok() {
                    last.replace(Some(message));
                }
                list.notify_visible();
            }
        });
    }

    pub(super) fn open_native_thread(self: &Rc<Self>, root: &str) {
        let (Some(session), Some(rid)) = (self.native_session(), self.current_rid()) else { return };
        if !session.supported_features().iter().any(|f| f == "threads") {
            return;
        }
        if self.thread.borrow().as_ref().is_some_and(|t| t.root_id == root)
            && self.room_nav.visible_page().and_then(|p| p.tag()).as_deref() == Some("thread")
        {
            return;
        }
        self.read_generation.set(self.read_generation.get().wrapping_add(1));
        self.native_read_pending.set(false);
        self.native_read_last.replace(None);
        self.room_nav.pop_to_tag("room");
        let thread = ThreadPage::new_native(self.session.clone(), session.clone(), &rid, root);
        let weak = Rc::downgrade(self);
        thread.list.connect_event(move |event| {
            if let Some(this) = weak.upgrade() {
                this.handle_event(event, true);
            }
        });
        let (weak, s, target, opening, r, root_id) = (
            Rc::downgrade(self),
            session.clone(),
            Rc::downgrade(&thread),
            thread.membership.clone(),
            rid.clone(),
            root.to_owned(),
        );
        thread.composer.connect_submit(move |text| {
            let (Some(this), Some(thread)) = (weak.upgrade(), target.upgrade()) else { return };
            let quotes = thread.composer.native_reply().into_iter().collect::<Vec<_>>();
            match s.send_reply_from_membership(&r, &root_id, &text, opening.as_deref(), &quotes) {
                Ok(_) => thread.composer.clear_reply(),
                Err(error) => {
                    thread.composer.set_text(&text);
                    this.native_error(&error);
                }
            }
        });
        let weak = Rc::downgrade(self);
        thread.composer.connect_edit_last(move || {
            if let Some(this) = weak.upgrade() {
                this.edit_last(true);
            }
        });
        let weak = Rc::downgrade(self);
        thread.list.connect_visible(move || {
            if let Some(this) = weak.upgrade() {
                this.schedule_native_read();
            }
        });
        self.room_nav.push(&thread.page);
        self.thread.replace(Some(thread.clone()));
        thread.reload();
        thread.composer.grab_focus();
        let (weak, r, root_id) = (Rc::downgrade(self), rid, root.to_owned());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { session.load_thread(&r, &root_id).await }).await;
            let Some(this) = weak.upgrade() else { return };
            if this.thread.borrow().as_ref().is_none_or(|current| !Rc::ptr_eq(current, &thread)) {
                return;
            }
            if let Err(error) = result {
                this.native_error(&error);
            }
            thread.reload();
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
        crate::settings::open_native(&self.split, session, self.account_actions.borrow().clone(), move || {
            if let Some(this) = weak.upgrade() {
                for f in this.on_logout.borrow().iter() {
                    f(());
                }
            }
        });
    }

    pub(super) fn native_row_event(self: &Rc<Self>, event: RowEvent, in_thread: bool) {
        match event {
            RowEvent::Retry(id) => self.retry(id),
            RowEvent::React { id, shortcode, add } => self.native_react(id, shortcode, add),
            RowEvent::OpenThread(root) => self.open_thread(&root),
            RowEvent::CancelEdit => {
                self.native_edit.replace(None);
                self.list_of(in_thread).stop_edit();
                self.composer_of(in_thread).grab_focus();
            }
            RowEvent::SaveEdit => {
                let Some((id, revision, initial)) = self.native_edit.borrow_mut().take() else { return };
                let Some((edited, text)) = self.list_of(in_thread).stop_edit() else { return };
                let (Some(session), Some(rid)) = (self.native_session(), self.current_rid()) else { return };
                self.composer_of(in_thread).grab_focus();
                if edited != id || text.trim().is_empty() || text == initial {
                    return;
                }
                let (weak, expected) = (Rc::downgrade(self), session.clone());
                glib::spawn_future_local(async move {
                    let (i, r, v, t) = (id.clone(), rid.clone(), revision.clone(), text.clone());
                    let result = on_tokio(async move { session.edit(&r, &i, &v, &t).await }).await;
                    let Some(this) = weak.upgrade() else { return };
                    if this.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &expected))
                        || this.current_rid().as_deref() != Some(&rid)
                    {
                        return;
                    }
                    if let Err(error) = result {
                        this.native_error(&error);
                        if this.list_of(in_thread).editing().is_none()
                            && let Some(mut row) = this.list_of(in_thread).row(&id)
                        {
                            row.text = Some(text);
                            this.native_edit.replace(Some((id, revision, initial)));
                            this.list_of(in_thread).start_edit(&row);
                        }
                    }
                });
            }
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
                if row.outbox_status.is_none()
                    && let Some(s) = self.native_session()
                    && let Some(link) =
                        rv_core::links::native_permalink(&s.info, &row.rid, Some(&row.id), row.thread_id.as_deref())
                {
                    let button = gtk::Button::builder().label(t("actions.copy_link")).css_classes(["flat"]).build();
                    let (anchor, p) = (anchor.clone(), popover.clone());
                    button.connect_clicked(move |_| {
                        anchor.clipboard().set_text(&link);
                        p.popdown();
                    });
                    list.append(&button);
                }
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
                if row.outbox_status.is_none()
                    && let Some(session) = self.native_session()
                {
                    let (weak, expected, rid) = (Rc::downgrade(self), session.clone(), row.rid.clone());
                    glib::spawn_future_local(async move {
                        let id = row.id.clone();
                        let context = on_tokio(async move { session.message_action_context(&id).await }).await;
                        let Some(this) = weak.upgrade() else { return };
                        if popover.parent().is_none()
                            || this.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &expected))
                            || this.current_rid().as_deref() != Some(&rid)
                        {
                            return;
                        }
                        let Ok((message, rights)) = context else { return };
                        if !message.deleted && expected.supported_features().iter().any(|f| f == "quotes") {
                            let button = gtk::Button::builder().label(t("actions.reply")).css_classes(["flat"]).build();
                            let (weak, s, p, row) = (weak.clone(), expected.clone(), popover.clone(), row.clone());
                            button.connect_clicked(move |_| {
                                if let Some(this) = weak.upgrade()
                                    && this.native_session().is_some_and(|current| Arc::ptr_eq(&current, &s))
                                    && this.current_rid().as_deref() == Some(&row.rid)
                                {
                                    this.start_reply(*row.clone(), in_thread);
                                    p.popdown();
                                }
                            });
                            list.append(&button);
                        }
                        if !in_thread
                            && !message.deleted
                            && message.reply_to.is_none()
                            && message.system.is_none()
                            && expected.can_send_to_room(&rid)
                            && expected.supported_features().iter().any(|f| f == "threads")
                        {
                            let button =
                                gtk::Button::builder().label(t("actions.reply_thread")).css_classes(["flat"]).build();
                            let (weak, p, root) = (weak.clone(), popover.clone(), message.id.clone());
                            button.connect_clicked(move |_| {
                                p.popdown();
                                if let Some(this) = weak.upgrade() {
                                    this.open_thread(&root);
                                }
                            });
                            list.append(&button);
                        }
                        for (key, starred, present, allowed) in [
                            (
                                if message.pinned { "actions.unpin" } else { "actions.pin" },
                                false,
                                !message.pinned,
                                rights.pin,
                            ),
                            (
                                if message.personal_star.as_ref().is_some_and(|s| s.present) {
                                    "actions.unstar"
                                } else {
                                    "actions.star"
                                },
                                true,
                                !message.personal_star.as_ref().is_some_and(|s| s.present),
                                rights.star,
                            ),
                        ] {
                            if !allowed
                                || !expected
                                    .supported_features()
                                    .iter()
                                    .any(|f| f == if starred { "stars" } else { "pins" })
                            {
                                continue;
                            }
                            let button = gtk::Button::builder().label(t(key)).css_classes(["flat"]).build();
                            let (weak, p, s, id, rid) =
                                (weak.clone(), popover.clone(), expected.clone(), row.id.clone(), rid.clone());
                            button.connect_clicked(move |_| {
                                let Some(this) = weak.upgrade() else { return };
                                if this.native_session().is_none_or(|current| !Arc::ptr_eq(&current, &s)) {
                                    return;
                                }
                                p.popdown();
                                let (weak, expected, s, id, rid) =
                                    (weak.clone(), s.clone(), s.clone(), id.clone(), rid.clone());
                                glib::spawn_future_local(async move {
                                    let result =
                                        on_tokio(async move { s.set_mark(&rid, &id, present, starred).await }).await;
                                    if let Err(error) = result
                                        && let Some(this) = weak.upgrade()
                                        && this.native_session().is_some_and(|s| Arc::ptr_eq(&s, &expected))
                                    {
                                        this.native_error(&error);
                                    }
                                });
                            });
                            list.append(&button);
                        }
                        if rights.react && expected.supported_features().iter().any(|f| f == "reactions") {
                            let quick = gtk::Box::builder().spacing(4).margin_bottom(4).build();
                            for shortcode in rv_core::actions::QUICK_REACTIONS {
                                let glyph = rv_core::emoji::unicode(shortcode);
                                let mine = message.reactions.iter().any(|r| {
                                    rv_core::emoji::unicode(&r.emoji) == glyph
                                        && r.users.iter().any(|u| u.id == expected.info.user_id)
                                });
                                let button = gtk::Button::builder()
                                    .label(rv_core::emoji::unicode(shortcode).unwrap_or(shortcode))
                                    .css_classes(if mine {
                                        vec!["quick-reaction", "mine"]
                                    } else {
                                        vec!["quick-reaction"]
                                    })
                                    .build();
                                let (weak, s, p, id) =
                                    (weak.clone(), expected.clone(), popover.clone(), row.id.clone());
                                button.connect_clicked(move |_| {
                                    if let Some(this) = weak.upgrade()
                                        && this.native_session().is_some_and(|current| Arc::ptr_eq(&current, &s))
                                    {
                                        p.popdown();
                                        this.native_react(id.clone(), shortcode.into(), !mine);
                                    }
                                });
                                quick.append(&button);
                            }
                            list.prepend(&quick);
                        }
                        for (key, edit, allowed) in
                            [("actions.edit", true, rights.edit), ("actions.delete", false, rights.delete)]
                        {
                            if !allowed {
                                continue;
                            }
                            let button = gtk::Button::builder().label(t(key)).css_classes(["flat"]).build();
                            let (weak, p, s, r, revision, text, initial) = (
                                weak.clone(),
                                popover.clone(),
                                expected.clone(),
                                row.clone(),
                                rights.revision.clone(),
                                expected
                                    .store
                                    .command_draft(&row.id)
                                    .ok()
                                    .flatten()
                                    .unwrap_or_else(|| message.text.clone()),
                                message.text.clone(),
                            );
                            button.connect_clicked(move |_| {
                                let Some(this) = weak.upgrade() else { return };
                                if this.native_session().is_none_or(|current| !Arc::ptr_eq(&current, &s)) {
                                    return;
                                }
                                p.popdown();
                                if edit {
                                    let mut r = r.clone();
                                    r.text = Some(text.clone());
                                    this.native_edit.replace(Some((r.id.clone(), revision.clone(), initial.clone())));
                                    this.list_of(in_thread).start_edit(&r);
                                } else {
                                    let (weak, s, id, rid, revision) =
                                        (weak.clone(), s.clone(), r.id.clone(), r.rid.clone(), revision.clone());
                                    actions_menu::confirm_delete(Some(this.split.upcast_ref()), move || {
                                        let (weak, s, id, rid, revision) =
                                            (weak.clone(), s.clone(), id.clone(), rid.clone(), revision.clone());
                                        glib::spawn_future_local(async move {
                                            let expected = s.clone();
                                            let result =
                                                on_tokio(async move { s.delete(&rid, &id, &revision).await }).await;
                                            if let Err(error) = result
                                                && let Some(this) = weak.upgrade()
                                                && this.native_session().is_some_and(|s| Arc::ptr_eq(&s, &expected))
                                            {
                                                this.native_error(&error);
                                            }
                                        });
                                    });
                                }
                            });
                            list.append(&button);
                        }
                    });
                }
            }
            _ => {}
        }
    }

    fn native_react(self: &Rc<Self>, id: String, emoji: String, present: bool) {
        let (Some(s), Some(rid)) = (self.native_session(), self.current_rid()) else { return };
        let (weak, expected) = (Rc::downgrade(self), s.clone());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { s.react(&rid, &id, &emoji, present).await }).await;
            if let Err(error) = result
                && let Some(this) = weak.upgrade()
                && this.native_session().is_some_and(|s| Arc::ptr_eq(&s, &expected))
            {
                this.native_error(&error);
            }
        });
    }

    pub(super) fn start_native_edit(self: &Rc<Self>, mut row: rv_core::store::MessageRow, in_thread: bool) {
        let Some(session) = self.native_session() else { return };
        let (weak, expected, rid, id) = (Rc::downgrade(self), session.clone(), row.rid.clone(), row.id.clone());
        glib::spawn_future_local(async move {
            let context = on_tokio(async move { session.message_action_context(&id).await }).await;
            let Some(this) = weak.upgrade() else { return };
            if this.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &expected))
                || this.current_rid().as_deref() != Some(&rid)
            {
                return;
            }
            match context {
                Ok((message, rights)) if rights.edit => {
                    let initial = message.text;
                    let text = expected.store.command_draft(&row.id).ok().flatten().unwrap_or_else(|| initial.clone());
                    row.text = Some(text.clone());
                    this.native_edit.replace(Some((row.id.clone(), rights.revision, initial)));
                    this.list_of(in_thread).start_edit(&row);
                }
                Ok(_) => this.toast(t("edit.too_late").to_owned()),
                Err(error) => this.native_error(&error),
            }
        });
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
        "revision_conflict" => "native.message_changed",
        "message_action_pending" => "native.action_pending",
        "user_not_found" => "native.user_missing",
        _ => "native.error",
    }
}
