//! Cross-room navigation carries only a scoped reference. Source words are
//! resolved again by the destination's existing composer.
use super::*;
use rv_core::native::{NativeSession, crypto::enrollment::rooms::messages, security::Guard, store::QuoteSelection};

#[derive(Clone)]
enum Transfer {
    Ordinary(QuoteSelection),
    Private(messages::QuoteSelection),
}
impl Transfer {
    fn reference(&self) -> (&str, &str) {
        let reference = match self {
            Self::Ordinary(s) => &s.reference,
            Self::Private(s) => &s.reference,
        };
        (&reference.room_id, &reference.message_id)
    }
    fn matches(&self, selected: &messages::QuoteSelection) -> bool {
        match self {
            Self::Private(s) => s == selected,
            Self::Ordinary(s) => {
                s.reference == selected.reference
                    && s.identity.instance_id == selected.instance
                    && s.identity.data_epoch == selected.data_epoch
                    && s.membership_version == selected.membership
                    && selected.admission.is_none()
            }
        }
    }
}
impl ChatPage {
    fn quote_scope(&self, session: &Arc<NativeSession>, room: &str, generation: u64) -> bool {
        self.read_generation.get() == generation
            && self.current_rid().as_deref() == Some(room)
            && self.native_session().is_some_and(|s| Arc::ptr_eq(&s, session) && !s.is_closed())
    }
    pub(super) fn quote_elsewhere(self: &Rc<Self>, room: String, message: String) {
        let Some(session) = self.native_session() else { return };
        let generation = self.read_generation.get();
        if !self.quote_scope(&session, &room, generation) {
            return;
        }
        let Some(source) = self.rooms.borrow().iter().find(|r| r.rid == room).cloned() else { return };
        let (weak, expected) = (Rc::downgrade(self), session.clone());
        glib::spawn_future_local(async move {
            let transfer = if source.encrypted {
                let (r, id) = (room.clone(), message.clone());
                let path = glib::user_data_dir().join("rocket-vibe-rs/native-crypto");
                on_tokio(async move {
                    let access = session
                        .crypto_settings(Guard::new(), path, Arc::new(rv_crypto::protected::system::Keyring))
                        .await?
                        .messages(r, None)
                        .await?;
                    let result =
                        access.select_source_quote(source.rid, id).await.map(|p| Transfer::Private(p.selection));
                    access.close();
                    result
                })
                .await
                .ok()
            } else {
                session.store.quote_selection(&room, &message).ok().map(Transfer::Ordinary)
            };
            let Some(this) = weak.upgrade().filter(|p| p.quote_scope(&expected, &room, generation)) else { return };
            match transfer {
                Some(transfer) => this.quote_destination(expected, room, generation, transfer),
                None => this.toast(t("quote.unavailable").into()),
            }
        });
    }
    fn quote_destination(
        self: &Rc<Self>,
        session: Arc<NativeSession>,
        source: String,
        generation: u64,
        transfer: Transfer,
    ) {
        let candidates = self
            .rooms
            .borrow()
            .iter()
            .filter(|r| {
                r.rid != source
                    && session.store.room_access(&r.rid).is_ok_and(|access| access.is_none_or(|a| a.can_send))
                    && (!r.encrypted || session.crypto_settings_supported())
            })
            .cloned()
            .collect::<Vec<_>>();
        let search = gtk::SearchEntry::builder()
            .placeholder_text(t("spotlight.placeholder"))
            .hexpand(true)
            .css_classes(["quote-destination-search"])
            .build();
        let list = gtk::ListBox::builder().selection_mode(gtk::SelectionMode::None).css_classes(["boxed-list"]).build();
        let column =
            gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(10).css_classes(["spotlight"]).build();
        column.append(&search);
        if candidates.is_empty() {
            column.append(&gtk::Label::new(Some(t("quote.destination_empty"))));
        }
        column.append(&gtk::ScrolledWindow::builder().min_content_height(300).vexpand(true).child(&list).build());
        let view = adw::ToolbarView::new();
        view.add_top_bar(&adw::HeaderBar::new());
        view.set_content(Some(&column));
        let dialog = adw::Dialog::builder()
            .css_classes(["quote-destination-dialog"])
            .title(t("quote.destination"))
            .content_width(420)
            .content_height(440)
            .child(&view)
            .build();
        let entry = search.downgrade();
        list.set_filter_func(move |row| {
            let query = entry.upgrade().map(|e| e.text().to_lowercase()).unwrap_or_default();
            row.child()
                .and_downcast::<gtk::Button>()
                .and_then(|b| b.label())
                .is_some_and(|name| name.to_lowercase().contains(query.trim()))
        });
        let results = list.downgrade();
        search.connect_search_changed(move |_| {
            if let Some(list) = results.upgrade() {
                list.invalidate_filter();
            }
        });
        for room in candidates {
            let button = gtk::Button::builder().label(&room.name).css_classes(["flat"]).build();
            let (weak, dialog, session, source, transfer) =
                (Rc::downgrade(self), dialog.clone(), session.clone(), source.clone(), transfer.clone());
            button.connect_clicked(move |_| {
                dialog.close();
                let Some(this) = weak.upgrade().filter(|p| p.quote_scope(&session, &source, generation)) else {
                    return;
                };
                let (this, session, transfer, target) =
                    (this.clone(), session.clone(), transfer.clone(), room.rid.clone());
                let source = source.clone();
                glib::spawn_future_local(async move {
                    this.accept_transferred_quote(session, target, transfer, source, generation).await;
                });
            });
            list.append(&button);
        }
        dialog.present(Some(&self.split));
        search.grab_focus();
    }
    async fn accept_transferred_quote(
        self: &Rc<Self>,
        session: Arc<NativeSession>,
        room: String,
        transfer: Transfer,
        source: String,
        navigation: u64,
    ) {
        if !self.quote_scope(&session, &source, navigation) {
            return;
        }
        let (s, target) = (session.clone(), room.clone());
        let details = on_tokio(async move { s.room_details(&target).await }).await;
        if !self.quote_scope(&session, &source, navigation) {
            return;
        }
        if !details.is_ok_and(|d| d.permissions.send) {
            self.toast(t("quote.unavailable").into());
            return;
        }
        if let Transfer::Ordinary(selected) = &transfer
            && session.store.quote_selection(&selected.reference.room_id, &selected.reference.message_id).ok().as_ref()
                != Some(selected)
        {
            self.toast(t("quote.unavailable").into());
            return;
        }
        self.open_native_room(&room);
        let generation = self.read_generation.get();
        if !self.quote_scope(&session, &room, generation) {
            return;
        }
        let encrypted = self.current.borrow().as_ref().is_some_and(|r| r.encrypted);
        if encrypted {
            self.crypto_history(false).await;
            if !self.quote_scope(&session, &room, generation) || !self.native_crypto_ready.get() {
                return;
            }
            let Some(access) = self.native_crypto.borrow().clone() else { return };
            self.composer.clear_reply();
            let quote_generation = self.composer.quote_generation();
            let (source, message) = transfer.reference();
            let (source, message) = (source.to_owned(), message.to_owned());
            let result = on_tokio(async move { access.select_source_quote(source, message).await }).await;
            if !self.quote_scope(&session, &room, generation) || self.composer.quote_generation() != quote_generation {
                return;
            }
            match result {
                Ok(preview) if transfer.matches(&preview.selection) => self.composer.set_private_reply(preview),
                _ => self.toast(t("quote.unavailable").into()),
            }
        } else {
            match transfer {
                Transfer::Private(selected) => self.composer.set_ordinary_private_quote(session, room, None, selected),
                Transfer::Ordinary(selected) => {
                    let reference = &selected.reference;
                    if session.store.quote_selection(&reference.room_id, &reference.message_id).ok().as_ref()
                        != Some(&selected)
                    {
                        self.toast(t("quote.unavailable").into());
                        return;
                    }
                    if let Ok(rows) = session.store.selected_messages(std::slice::from_ref(&reference.message_id))
                        && let Some(row) = rows.into_iter().find(|r| r.id == reference.message_id)
                        && session.store.quote_selection(&reference.room_id, &reference.message_id).ok().as_ref()
                            == Some(&selected)
                    {
                        self.composer.set_native_reply(&row.author, &row.text, selected);
                    }
                }
            }
        }
    }
}
