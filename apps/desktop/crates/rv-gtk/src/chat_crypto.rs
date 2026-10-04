use super::*;
use rv_core::native::{crypto::enrollment::rooms::messages, security::Guard};

impl ChatPage {
    pub(super) fn close_native_crypto(&self) {
        if let Some(access) = self.native_crypto.take() {
            access.close();
        }
        self.native_crypto_ready.set(false);
        self.native_crypto_restored.set(false);
        self.native_crypto_rows.borrow_mut().clear();
        self.native_crypto_meta.borrow_mut().clear();
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
            let view = access.refresh(before, 50).await?;
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
                self.list.root.set_tooltip_text(Some(t("crypto.observed_time")));
                if !self.native_crypto_restored.replace(true) {
                    self.composer.bind_private(access, &rid, &view.draft);
                }
                let mut incoming = vec![];
                let mut metadata = vec![];
                for message in view.messages {
                    metadata.push((message.row.id.clone(), message.operation, message.position));
                    incoming.push(message.row);
                }
                if older {
                    let ids = incoming.iter().map(|r| r.id.clone()).collect::<std::collections::BTreeSet<_>>();
                    incoming.extend(self.native_crypto_rows.borrow().iter().filter(|r| !ids.contains(&r.id)).cloned());
                    metadata.extend(
                        self.native_crypto_meta.borrow().iter().filter(|(id, _, _)| !ids.contains(id)).cloned(),
                    );
                } else if let Some(oldest) =
                    metadata.iter().filter_map(|(_, _, p)| p.as_deref()).filter_map(|p| p.parse::<u64>().ok()).min()
                {
                    let keep = self
                        .native_crypto_meta
                        .borrow()
                        .iter()
                        .filter_map(|(id, _, p)| {
                            p.as_deref().and_then(|p| p.parse::<u64>().ok()).filter(|p| *p < oldest).map(|_| id.clone())
                        })
                        .collect::<std::collections::BTreeSet<_>>();
                    let mut older_rows = self
                        .native_crypto_rows
                        .borrow()
                        .iter()
                        .filter(|r| keep.contains(&r.id))
                        .cloned()
                        .collect::<Vec<_>>();
                    older_rows.extend(incoming);
                    incoming = older_rows;
                    let mut older_meta = self
                        .native_crypto_meta
                        .borrow()
                        .iter()
                        .filter(|(id, _, _)| keep.contains(id))
                        .cloned()
                        .collect::<Vec<_>>();
                    older_meta.extend(metadata);
                    metadata = older_meta;
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
        glib::spawn_future_local(async move {
            let original = text.clone();
            let result = on_tokio(async move {
                access.set_draft(text.clone()).await?;
                access
                    .send(messages::SendMessage {
                        operation_id: rv_core::native::room_operation_id(),
                        text,
                        reply_to: None,
                        quotes: vec![],
                        cards: vec![],
                    })
                    .await
            })
            .await;
            let Some(page) = weak.upgrade().filter(|p| p.read_generation.get() == generation) else { return };
            if result.is_err() {
                if page.composer.text().is_empty() {
                    page.composer.set_text(&original);
                }
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
