//! A WhatsApp account in the ChatPage: its conversations in the room list,
//! its chats in the timeline and composer, text only. What WhatsApp lacks
//! here (threads, calls, search, pins, uploads, room settings) stays hidden.
use super::*;
use rv_core::whatsapp_session::WaSession;

/// Decoded photos by JID, with the bytes they came from.
pub(super) type WaPhotos = Rc<RefCell<HashMap<String, (Arc<[u8]>, gtk::gdk::Texture)>>>;
/// The helper's photo table a decoding came from.
pub(super) type WaPhotoTable = Arc<std::collections::BTreeMap<String, Arc<[u8]>>>;

impl ChatPage {
    pub fn whatsapp_session(&self) -> Option<Arc<WaSession>> {
        self.whatsapp.borrow().clone()
    }

    pub fn set_whatsapp_session(self: &Rc<Self>, session: Arc<WaSession>) {
        self.set_session(None);
        self.whatsapp.replace(Some(session.clone()));
        self.wa_photos.borrow_mut().clear();
        self.wa_photo_table.replace(None);
        self.collapsed.replace(folded_sections(&session.info));
        // My messages are authored by "me": their photo is my account's.
        let (photos, me) = (self.wa_photos.clone(), session.info.user_id.clone());
        self.list.set_media(Some(crate::media::Provider::WhatsApp(session.clone())));
        self.list.set_photos(Rc::new(move |jid: &str| {
            let jid = if jid == "me" { me.as_str() } else { jid };
            photos.borrow().get(jid).map(|(_, texture)| texture.clone())
        }));
        self.search_button.set_visible(false);
        self.marked_button.set_visible(false);
        self.local_search_button.set_visible(false);
        self.account_name.set_label(&session.info.username);
        self.account_host.set_label("WhatsApp");
        self.set_connection(session.connection());
        self.refresh_whatsapp_photos(&session);
        self.whatsapp_account_tile(&session);
        self.reload_rooms();
    }

    /// The account's tile under the room list, with my photo once it came.
    fn whatsapp_account_tile(&self, session: &WaSession) {
        while let Some(child) = self.account_tile.first_child() {
            self.account_tile.remove(&child);
        }
        let tile =
            widgets::tile(&session.info.username, &widgets::initial(&session.info.username), TileSize::Message, false);
        if let Some(photo) = self.whatsapp_photo(&session.info.user_id) {
            widgets::set_photo(&tile, &photo);
        }
        self.account_tile.append(&tile);
    }

    /// The account changed (the window folds bursts): read the page again.
    pub fn on_whatsapp_change(self: &Rc<Self>) {
        let Some(session) = self.whatsapp_session() else { return };
        self.set_connection(session.connection());
        let photos_moved = self.refresh_whatsapp_photos(&session);
        self.reload_rooms();
        if photos_moved {
            self.refresh_room_header();
            self.whatsapp_account_tile(&session);
        }
        self.reload_messages();
        for (chat, text) in session.returned_drafts() {
            if self.current_rid().as_deref() == Some(chat.as_str()) {
                if self.composer.text().trim().is_empty() {
                    self.composer.set_text(&text);
                }
            } else if session.draft(&chat).trim().is_empty() {
                session.set_draft(&chat, &text);
            }
            self.toast(t("wa.send_failed").to_owned());
        }
        if session.take_uncertain() > 0 {
            self.toast(t("wa.send_uncertain").to_owned());
        }
        if let Some(code) = session.snapshot().error.filter(|_| session.connection() == Connection::Online) {
            match code.as_str() {
                "action_failed" | "edit_expired" | "delete_expired" | "logout_failed"
                    if self.wa_error.replace(Some(code.clone())).as_deref() != Some(code.as_str()) =>
                {
                    self.toast(t(&format!("wa.{code}")).to_owned());
                }
                _ => {}
            }
        } else {
            self.wa_error.replace(None);
        }
        let sending = self.current_rid().is_some_and(|rid| session.sending(&rid));
        let reopened = !sending && !self.composer.root.is_sensitive();
        self.composer.root.set_sensitive(!sending);
        // Disabled while it sent, the composer took the window's focus with it.
        if reopened && self.split.root().is_some_and(|root| root.focus().is_none()) {
            self.composer.grab_focus();
        }
        self.schedule_whatsapp_read();
        self.whatsapp_presence();
        if let Some(rid) = self.current_rid() {
            self.on_typing(&rid);
            // A typing WhatsApp never ends by itself fades: look again then.
            if !session.typing(&rid).is_empty() {
                let weak = Rc::downgrade(self);
                glib::timeout_add_local_once(std::time::Duration::from_secs(13), move || {
                    if let Some(this) = weak.upgrade()
                        && let Some(rid) = this.current_rid()
                    {
                        this.on_typing(&rid);
                    }
                });
            }
        }
    }

    /// Online while this account is in front in the focused window.
    pub fn whatsapp_presence(&self) {
        let Some(session) = self.whatsapp_session() else { return };
        let active = self.split.root().and_downcast::<gtk::Window>().is_some_and(|w| w.is_active());
        session.set_available(active);
    }

    /// Decodes the photos that changed; true when any did.
    fn refresh_whatsapp_photos(&self, session: &WaSession) -> bool {
        let table = session.snapshot().avatars;
        if self.wa_photo_table.borrow().as_ref().is_some_and(|kept| Arc::ptr_eq(kept, &table)) {
            return false;
        }
        self.wa_photo_table.replace(Some(table.clone()));
        let mut photos = self.wa_photos.borrow_mut();
        let before = photos.len();
        photos.retain(|jid, _| table.contains_key(jid));
        let mut changed = photos.len() != before;
        for (jid, bytes) in table.iter() {
            if photos.get(jid).is_some_and(|(kept, _)| Arc::ptr_eq(kept, bytes)) {
                continue;
            }
            if let Ok(texture) = gtk::gdk::Texture::from_bytes(&glib::Bytes::from(&bytes[..])) {
                photos.insert(jid.clone(), (bytes.clone(), texture));
                changed = true;
            }
        }
        if changed {
            self.wa_photo_version.set(self.wa_photo_version.get() + 1);
            self.list.set_photo_version(self.wa_photo_version.get());
        }
        changed
    }

    pub(super) fn whatsapp_photo(&self, jid: &str) -> Option<gtk::gdk::Texture> {
        self.wa_photos.borrow().get(jid).map(|(_, texture)| texture.clone())
    }

    pub(super) fn open_whatsapp_room(self: &Rc<Self>, rid: &str) {
        let Some(session) = self.whatsapp_session() else { return };
        let Some(room) = self.rooms.borrow().iter().find(|r| r.rid == rid).cloned() else { return };
        if self.current_rid().as_deref() == Some(rid) {
            self.content_stack.set_visible_child_name("room");
            self.split.set_show_content(true);
            return;
        }
        self.remember(rid);
        self.current.replace(Some(OpenRoom {
            rid: room.rid.clone(),
            kind: room.kind,
            name: room.name.clone(),
            read_only: false,
            post_read_only: false,
            encrypted: false,
            avatar: None,
            slug: None,
            dm_other_uid: None,
        }));
        self.typing_label.set_visible(false);
        self.call_button.set_visible(false);
        self.threads_button.set_visible(false);
        self.upload_strip.set_visible(false);
        self.list.set_unread_after(None);
        self.select_current(true);
        self.refresh_room_header();
        self.content_stack.set_visible_child_name("room");
        self.split.set_show_content(true);
        self.room_nav.pop_to_tag("room");
        self.thread.replace(None);
        self.has_older.set(false);
        self.set_loading(false);
        self.composer.clear_reply();
        self.composer.bind_whatsapp(&session, rid);
        self.composer.root.set_sensitive(!session.sending(rid));
        self.list.clear();
        self.reload_messages();
        self.composer.grab_focus();
        for f in self.on_room_opened.borrow().iter() {
            f(rid.to_owned());
        }
        for f in self.on_room_changed.borrow().iter() {
            f(Some(room.name.clone()));
        }
        self.schedule_whatsapp_read();
    }

    /// The open chat is read while it is on screen in the focused window.
    pub(super) fn schedule_whatsapp_read(&self) {
        let (Some(session), Some(rid)) = (self.whatsapp_session(), self.current_rid()) else { return };
        let active = self.split.root().and_downcast::<gtk::Window>().is_some_and(|w| w.is_active());
        let visible = self.split.shows_content() || !self.split.is_collapsed();
        if active && visible {
            session.mark_read(&rid);
        }
    }

    pub(super) fn send_whatsapp(self: &Rc<Self>, submitted: &str) {
        let (Some(session), Some(rid)) = (self.whatsapp_session(), self.current_rid()) else { return };
        let (reply, text) = rv_core::whatsapp::split_reply(submitted);
        if text.trim().is_empty() {
            return;
        }
        session.set_typing(&rid, false);
        match session.send(&rid, &text, reply) {
            Ok(()) => {
                self.composer.clear_reply();
                self.composer.root.set_sensitive(false);
                session.set_draft(&rid, "");
            }
            Err(_) => {
                self.composer.set_text(&text);
                self.toast(t("wa.send_failed").to_owned());
            }
        }
    }

    pub(super) fn whatsapp_row_event(self: &Rc<Self>, event: RowEvent) {
        let Some(session) = self.whatsapp_session() else { return };
        let result = match event {
            RowEvent::React { id, shortcode, add } => {
                session.react(&id, if add { rv_core::whatsapp::reaction_glyph(&shortcode) } else { String::new() })
            }
            RowEvent::Menu { row, anchor, x, y, .. } => {
                self.whatsapp_menu(&session, *row, &anchor, x, y);
                Ok(())
            }
            RowEvent::SaveEdit => match self.list.stop_edit() {
                Some((id, text)) if !text.trim().is_empty() => {
                    self.composer.grab_focus();
                    session.edit(&id, text.trim().to_owned())
                }
                _ => Ok(()),
            },
            RowEvent::CancelEdit => {
                self.list.stop_edit();
                self.composer.grab_focus();
                Ok(())
            }
            // An unconfirmed send is never sent again from here: it may have arrived.
            RowEvent::Retry(_) => {
                self.toast(t("wa.send_uncertain").to_owned());
                Ok(())
            }
            _ => Ok(()),
        };
        if result.is_err() {
            self.toast(t("wa.action_failed").to_owned());
        }
    }

    /// My last message, edited in place while WhatsApp still allows it.
    pub(super) fn edit_last_whatsapp(self: &Rc<Self>) {
        let Some(session) = self.whatsapp_session() else { return };
        let Some(row) = self.list.last_mine("me") else { return };
        let editable = session
            .snapshot()
            .messages
            .get(&row.id)
            .is_some_and(|m| m.status.is_empty() && !m.deleted && now_ms() - m.ts < EDIT_WINDOW_MS);
        if editable {
            self.list.start_edit(&row);
        } else {
            self.toast(t("wa.edit_expired").to_owned());
        }
    }

    /// The actions of a WhatsApp message: quick reactions, reply, copy, and on
    /// my own messages edit (15 minutes) and delete for everyone (48 hours).
    fn whatsapp_menu(
        self: &Rc<Self>,
        session: &Arc<WaSession>,
        row: rv_core::store::MessageRow,
        anchor: &gtk::Widget,
        x: f64,
        y: f64,
    ) {
        let snapshot = session.snapshot();
        let Some(message) = snapshot.messages.get(&row.id).cloned() else { return };
        let popover = gtk::Popover::builder().has_arrow(true).build();
        popover.set_parent(anchor);
        popover.set_pointing_to(Some(&gtk::gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
        popover.connect_closed(|popover| popover.unparent());
        let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).build();
        let connected = snapshot.state == "connected";
        if !message.deleted && connected {
            let quick = gtk::Box::builder().spacing(2).build();
            let mine = snapshot.reactions.get(&message.id).and_then(|by| by.get("me")).cloned();
            for code in rv_core::actions::QUICK_REACTIONS {
                let glyph = rv_core::whatsapp::reaction_glyph(code);
                let button = gtk::Button::builder().label(&glyph).css_classes(["flat"]).build();
                let taken = mine.as_deref() == Some(glyph.as_str());
                if taken {
                    button.add_css_class("suggested-action");
                }
                let (weak, session, id, popover) =
                    (Rc::downgrade(self), session.clone(), message.id.clone(), popover.clone());
                button.connect_clicked(move |_| {
                    popover.popdown();
                    if session.react(&id, if taken { String::new() } else { glyph.clone() }).is_err()
                        && let Some(this) = weak.upgrade()
                    {
                        this.toast(t("wa.action_failed").to_owned());
                    }
                });
                quick.append(&button);
            }
            column.append(&quick);
        }
        let item = |label: &str| gtk::Button::builder().label(label).css_classes(["flat"]).build();
        if !message.deleted && message.status.is_empty() && connected {
            let reply = item(t("actions.reply"));
            let author = row.author.clone().unwrap_or_default();
            let (weak, popover_c, id, text) =
                (Rc::downgrade(self), popover.clone(), message.id.clone(), message.text.clone());
            reply.connect_clicked(move |_| {
                popover_c.popdown();
                if let Some(this) = weak.upgrade() {
                    let preview: String = text.chars().take(120).collect();
                    this.composer.set_reply(&author, &preview, format!("{}{id}", rv_core::whatsapp::REPLY_LINK));
                }
            });
            column.append(&reply);
        }
        if !message.deleted {
            let copy = item(t("actions.copy"));
            let (text, popover_c) = (message.text.clone(), popover.clone());
            copy.connect_clicked(move |button| {
                button.clipboard().set_text(&text);
                popover_c.popdown();
            });
            column.append(&copy);
        }
        let age = now_ms() - message.ts;
        let settled = message.mine && !message.deleted && message.status.is_empty() && connected;
        if settled && age < EDIT_WINDOW_MS {
            let edit = item(t("actions.edit"));
            let (weak, popover_c) = (Rc::downgrade(self), popover.clone());
            edit.connect_clicked(move |_| {
                popover_c.popdown();
                if let Some(this) = weak.upgrade() {
                    this.list.start_edit(&row);
                }
            });
            column.append(&edit);
        }
        if settled && age < DELETE_WINDOW_MS {
            let delete = item(t("actions.delete"));
            delete.add_css_class("destructive-action");
            let (weak, popover_c, id) = (Rc::downgrade(self), popover.clone(), message.id);
            delete.connect_clicked(move |_| {
                popover_c.popdown();
                if let Some(this) = weak.upgrade() {
                    this.confirm_whatsapp_delete(id.clone());
                }
            });
            column.append(&delete);
        }
        if column.first_child().is_none() {
            popover.unparent();
            return;
        }
        popover.set_child(Some(&column));
        popover.popup();
    }

    fn confirm_whatsapp_delete(self: &Rc<Self>, id: String) {
        let dialog = adw::AlertDialog::new(Some(t("wa.delete_title")), Some(t("wa.delete_body")));
        dialog.add_response("cancel", t("actions.cancel"));
        dialog.add_response("delete", t("actions.delete"));
        dialog.set_response_appearance("delete", adw::ResponseAppearance::Destructive);
        dialog.set_default_response(Some("cancel"));
        dialog.set_close_response("cancel");
        let weak = Rc::downgrade(self);
        dialog.connect_response(None, move |_, response| {
            let Some(this) = weak.upgrade() else { return };
            if response == "delete"
                && let Some(session) = this.whatsapp_session()
                && session.delete(&id).is_err()
            {
                this.toast(t("wa.action_failed").to_owned());
            }
        });
        widgets::present(&dialog, Some(&self.split));
    }
}

/// WhatsApp's own windows: recipients ignore later edits and revocations.
const EDIT_WINDOW_MS: i64 = 15 * 60 * 1000;
const DELETE_WINDOW_MS: i64 = 48 * 60 * 60 * 1000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
