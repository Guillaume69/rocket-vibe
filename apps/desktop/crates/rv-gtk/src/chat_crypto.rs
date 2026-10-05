use super::*;
use rv_core::native::{crypto::enrollment::rooms::messages, security::Guard};

impl ChatPage {
    pub(super) fn close_native_crypto(&self) {
        self.native_quote_cards.close();
        if let Some(thread) = self.thread.borrow().as_ref() {
            thread.close_private();
        }
        if let Some(access) = self.native_crypto.take() {
            access.close();
        }
        self.native_crypto_ready.set(false);
        self.native_crypto_restored.set(false);
        self.native_crypto_rows.borrow_mut().clear();
        self.native_crypto_meta.borrow_mut().clear();
        self.composer.clear_reply();
        self.list.root.set_tooltip_text(None);
    }
    pub(super) async fn crypto_history(self: &Rc<Self>, older: bool) -> bool {
        if self.loading.get() {
            return false;
        }
        let (Some(session), Some(rid)) = (self.native_session(), self.current_rid()) else { return false };
        if !session.crypto_settings_supported() {
            return false;
        }
        let generation = self.read_generation.get();
        let selected = self.composer.private_reply();
        let before = if older {
            self.native_crypto_meta
                .borrow()
                .iter()
                .filter_map(|(_, _, p)| p.as_ref())
                .filter_map(|p| p.parse::<u64>().ok())
                .min()
                .map(|p| p.to_string())
        } else {
            None
        };
        if older && before.is_none() {
            return false;
        }
        self.set_loading(true);
        let access = self.native_crypto.borrow().clone();
        let (expected, room) = (session.clone(), rid.clone());
        let path = glib::user_data_dir().join("rocket-vibe-rs/native-crypto");
        let result = on_tokio(async move {
            let access = match access {
                Some(access) => access,
                None => {
                    session
                        .crypto_settings(Guard::new(), path, Arc::new(rv_crypto::protected::system::Keyring))
                        .await?
                        .messages(room, None)
                        .await?
                }
            };
            let view = access.refresh(None, 200).await?;
            Ok::<_, rv_core::native::crypto::Error>((access, view))
        })
        .await;
        if self.read_generation.get() != generation || self.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &expected))
        {
            if let Ok((access, _)) = result {
                access.close();
            }
            return false;
        }
        self.set_loading(false);
        match result {
            Ok((access, view)) => {
                self.native_crypto.replace(Some(access.clone()));
                self.list.root.set_tooltip_text(Some(t("crypto.retained_threads")));
                if !self.native_crypto_restored.replace(true) {
                    self.composer.bind_private(access, &rid, &view.draft);
                }
                if selected.is_some() && self.composer.private_reply() == selected {
                    self.composer.refresh_private_reply(view.selected_quote);
                }
                let mut incoming = vec![];
                let mut metadata = vec![];
                for message in view.messages {
                    metadata.push((message.row.id.clone(), message.operation, message.position));
                    incoming.push(message.row);
                }
                self.native_crypto_rows.replace(incoming);
                self.native_crypto_meta.replace(metadata);
                self.native_crypto_ready.set(view.can_send && !view.catching_up);
                self.has_older.set(view.has_older);
                self.reload_messages();
                self.refresh_room_header();
                if view.catching_up {
                    let weak = Rc::downgrade(self);
                    glib::timeout_add_local_once(std::time::Duration::from_millis(150), move || {
                        if let Some(page) = weak.upgrade().filter(|p| p.read_generation.get() == generation) {
                            glib::spawn_future_local(async move {
                                page.crypto_history(false).await;
                            });
                        }
                    });
                }
                true
            }
            Err(_) => {
                self.native_crypto_ready.set(false);
                if self.native_crypto.borrow().as_ref().is_some_and(|a| a.check().is_err()) {
                    self.close_native_crypto();
                    self.composer.unbind_native();
                    self.composer.set_text("");
                    self.list.clear();
                }
                self.refresh_room_header();
                self.toast(t("crypto.failed").to_owned());
                false
            }
        }
    }
    pub(super) fn send_native_crypto(self: &Rc<Self>, text: String) {
        let Some(access) = self.native_crypto.borrow().clone().filter(|_| self.native_crypto_ready.get()) else {
            self.composer.set_text(&text);
            return;
        };
        let (weak, generation) = (Rc::downgrade(self), self.read_generation.get());
        let selected = self.composer.private_reply();
        let quotes = selected.clone().into_iter().collect::<Vec<_>>();
        glib::spawn_future_local(async move {
            let original = text.clone();
            let result = on_tokio(async move {
                access.set_draft(text.clone()).await?;
                access
                    .send_selected(
                        messages::SendMessage {
                            operation_id: rv_core::native::room_operation_id(),
                            text,
                            reply_to: None,
                            quotes: quotes.iter().map(|s| s.reference.clone()).collect(),
                            cards: vec![],
                            files: vec![],
                        },
                        quotes,
                    )
                    .await
            })
            .await;
            let Some(page) = weak.upgrade().filter(|p| p.read_generation.get() == generation) else { return };
            if result.is_err() {
                if page.composer.text().is_empty() {
                    page.composer.set_text(&original);
                }
                page.toast(t("crypto.failed").to_owned());
            } else if page.composer.private_reply() == selected {
                page.composer.clear_reply();
            }
            page.crypto_history(false).await;
        });
    }
    /// Encrypted files, one private message each, the caption on the first.
    /// Originals only: reducing a picture would need a plaintext copy here.
    pub(super) fn send_private_files(self: &Rc<Self>, outgoing: crate::composer::Outgoing) {
        let Some(access) = self.native_crypto.borrow().clone().filter(|_| self.native_crypto_ready.get()) else {
            self.toast(t("crypto.failed").to_owned());
            return;
        };
        let (weak, generation) = (Rc::downgrade(self), self.read_generation.get());
        glib::spawn_future_local(async move {
            for (i, (item, mime)) in outgoing.items.into_iter().enumerate() {
                let caption = if i == 0 { outgoing.caption.clone() } else { String::new() };
                let (access, path, name) = (access.clone(), item.path.clone(), item.name.clone());
                let result = on_tokio(async move { access.send_file(path, name, mime, caption).await }).await;
                if item.temporary {
                    let _ = std::fs::remove_file(&item.path);
                }
                let Some(page) = weak.upgrade().filter(|p| p.read_generation.get() == generation) else { return };
                match result {
                    Err(rv_core::native::crypto::Error::Session(rv_core::native::Error::Protocol("too-large:100"))) => {
                        page.toast(crate::i18n::tf("attach.too_large", &[("name", &item.name), ("max", "100")]))
                    }
                    Err(_) => page.toast(t("crypto.failed").to_owned()),
                    Ok(()) => (),
                }
                page.crypto_history(false).await;
            }
        });
    }
    pub(super) fn quote_native_crypto(self: &Rc<Self>, id: String) {
        let Some(access) = self.native_crypto.borrow().clone().filter(|_| self.native_crypto_ready.get()) else {
            return;
        };
        let (weak, generation) = (Rc::downgrade(self), self.read_generation.get());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { access.select_quote(id).await }).await;
            let Some(page) = weak.upgrade().filter(|p| p.read_generation.get() == generation) else { return };
            match result {
                Ok(preview) => page.composer.set_private_reply(preview),
                Err(_) => page.toast(t("quote.unavailable").to_owned()),
            }
        });
    }
    /// Edits my private message in place; saving sends an encrypted edit.
    pub(super) fn start_crypto_edit(self: &Rc<Self>, row: rv_core::store::MessageRow, in_thread: bool) {
        if row.outbox_status.is_some() {
            return;
        }
        self.native_edit.replace(Some((row.id.clone(), String::new(), row.text.clone().unwrap_or_default())));
        self.list_of(in_thread).start_edit(&row);
    }
    /// Sends an encrypted edit (`Some(text)`) or deletion (`None`).
    pub(super) fn crypto_amend(self: &Rc<Self>, id: String, text: Option<String>, in_thread: bool) {
        if in_thread {
            if let Some(thread) = self.thread.borrow().as_ref() {
                thread.amend_private(id, text);
            }
            return;
        }
        let Some(access) = self.native_crypto.borrow().clone() else { return };
        let (weak, generation) = (Rc::downgrade(self), self.read_generation.get());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { access.amend(id, text).await }).await;
            let Some(page) = weak.upgrade().filter(|p| p.read_generation.get() == generation) else { return };
            if result.is_err() {
                page.toast(t("crypto.failed").to_owned());
            }
            page.crypto_history(false).await;
        });
    }
    /// Sends an encrypted reaction (`present`) or its withdrawal.
    pub(super) fn crypto_react(self: &Rc<Self>, id: String, emoji: String, present: bool, in_thread: bool) {
        if in_thread {
            if let Some(thread) = self.thread.borrow().as_ref() {
                thread.react_private(id, emoji, present);
            }
            return;
        }
        let Some(access) = self.native_crypto.borrow().clone() else { return };
        let (weak, generation) = (Rc::downgrade(self), self.read_generation.get());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { access.react(id, emoji, present).await }).await;
            let Some(page) = weak.upgrade().filter(|p| p.read_generation.get() == generation) else { return };
            if result.is_err() {
                page.toast(t("crypto.failed").to_owned());
            }
            page.crypto_history(false).await;
        });
    }
    pub(super) fn crypto_retry(self: &Rc<Self>, id: String, cancel: bool) {
        let Some(access) = self.native_crypto.borrow().clone() else { return };
        let Some((_, operation, _)) = self.native_crypto_meta.borrow().iter().find(|(m, _, _)| m == &id).cloned()
        else {
            return;
        };
        let (weak, generation) = (Rc::downgrade(self), self.read_generation.get());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move {
                if cancel { access.cancel(operation).await } else { access.resume(operation).await }
            })
            .await;
            let Some(page) = weak.upgrade().filter(|p| p.read_generation.get() == generation) else { return };
            if result.is_err() {
                page.toast(t("crypto.failed").to_owned());
            }
            page.crypto_history(false).await;
        });
    }
}
