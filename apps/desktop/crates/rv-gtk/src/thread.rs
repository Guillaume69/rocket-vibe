//! A thread: its root and every reply, with a composer that answers in it.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use rv_core::session::Session;

use crate::composer::Composer;
use crate::i18n::t;
use crate::message_list::{MessageList, Shared};
use rv_core::native::{crypto::enrollment::rooms::messages as private, security::Guard};

pub struct ThreadPage {
    pub page: adw::NavigationPage,
    pub list: Rc<MessageList>,
    pub composer: Rc<Composer>,
    pub root_id: String,
    pub rid: String,
    session: Shared<Arc<Session>>,
    native: Option<Arc<rv_core::native::NativeSession>>,
    pub membership: Option<String>,
    private: bool,
    crypto: RefCell<Option<private::Access>>,
    private_meta: RefCell<Vec<(String, String)>>,
    private_loading: Cell<bool>,
    private_generation: Cell<u64>,
    private_restored: Cell<bool>,
    private_map: Cell<u64>,
    quote_cards: Rc<crate::native_quote_cards::QuoteCards>,
}

impl ThreadPage {
    pub fn new(session: Shared<Arc<Session>>, rid: &str, root_id: &str, read_only: bool) -> Rc<Self> {
        let list = MessageList::new(session.clone());
        let composer = Composer::new();
        composer.root.set_visible(!read_only);
        let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
        content.append(&list.root);
        content.append(&composer.root);
        let view = adw::ToolbarView::new();
        view.add_top_bar(&adw::HeaderBar::new());
        view.set_content(Some(&content));
        let page = adw::NavigationPage::builder().child(&view).title(t("thread.title")).tag("thread").build();
        Rc::new(ThreadPage {
            page,
            quote_cards: crate::native_quote_cards::QuoteCards::new(&list),
            list,
            composer,
            root_id: root_id.to_owned(),
            rid: rid.to_owned(),
            session,
            native: None,
            membership: None,
            private: false,
            crypto: RefCell::default(),
            private_meta: RefCell::default(),
            private_loading: Cell::new(false),
            private_generation: Cell::new(0),
            private_restored: Cell::new(false),
            private_map: Cell::new(0),
        })
    }

    pub fn new_native(
        session: Shared<Arc<Session>>,
        native: Arc<rv_core::native::NativeSession>,
        rid: &str,
        root: &str,
    ) -> Rc<Self> {
        let membership = native.store.read_state(rid).ok().flatten().and_then(|s| s.membership_version);
        let mut page = Self::new(session, rid, root, false);
        let owned = Rc::get_mut(&mut page).expect("new thread page has a single owner");
        owned.list.set_native_provider(native.clone());
        owned.private = native.store.rooms().ok().is_some_and(|rooms| rooms.iter().any(|r| r.id == rid && r.encrypted));
        if owned.private {
            owned.composer.root.set_visible(false);
        } else {
            owned.composer.bind_native_thread(&native, rid, root, membership.clone());
        }
        owned.native = Some(native);
        owned.membership = membership;
        if page.private {
            let weak = Rc::downgrade(&page);
            page.list.root.connect_map(move |_| {
                let Some(page) = weak.upgrade() else { return };
                page.private_map.set(page.private_map.get().wrapping_add(1));
                page.reload();
                let (weak, generation) = (Rc::downgrade(&page), page.private_map.get());
                gtk::glib::timeout_add_local(std::time::Duration::from_secs(10), move || {
                    let Some(page) =
                        weak.upgrade().filter(|p| p.private_map.get() == generation && p.list.root.is_mapped())
                    else {
                        return gtk::glib::ControlFlow::Break;
                    };
                    page.reload();
                    gtk::glib::ControlFlow::Continue
                });
            });
            let weak = Rc::downgrade(&page);
            page.list.root.connect_unmap(move |_| {
                if let Some(page) = weak.upgrade() {
                    page.private_map.set(page.private_map.get().wrapping_add(1));
                    page.close_private();
                }
            });
        }
        page
    }

    pub fn is_private(&self) -> bool {
        self.private
    }
    pub fn close_private(&self) {
        self.quote_cards.close();
        if !self.private {
            return;
        }
        self.private_generation.set(self.private_generation.get().wrapping_add(1));
        self.private_loading.set(false);
        self.private_restored.set(false);
        if let Some(access) = self.crypto.take() {
            access.close();
        }
        self.private_meta.borrow_mut().clear();
        self.composer.unbind_native();
        self.composer.clear_reply();
        self.composer.set_text("");
        self.composer.root.set_visible(false);
        self.list.clear();
    }
    fn private_current(&self) -> bool {
        self.native.as_ref().is_some_and(|native| {
            !native.is_closed()
                && self.membership.is_some()
                && native.store.read_state(&self.rid).ok().flatten().and_then(|s| s.membership_version)
                    == self.membership
                && native.store.rooms().ok().is_some_and(|rooms| rooms.iter().any(|r| r.id == self.rid && r.encrypted))
        })
    }
    pub fn reload(self: &Rc<Self>) {
        if self.private {
            if !self.private_current() || self.crypto.borrow().as_ref().is_some_and(|a| a.check().is_err()) {
                self.close_private();
                return;
            }
            self.reload_private();
            return;
        }
        if let Some(native) = &self.native {
            let current = native.store.read_state(&self.rid).ok().flatten().and_then(|s| s.membership_version);
            let encrypted =
                native.store.rooms().ok().is_none_or(|rooms| rooms.iter().any(|r| r.id == self.rid && r.encrypted));
            if current != self.membership || current.is_none() || native.is_closed() || encrypted {
                self.quote_cards.close();
                self.list.clear();
                self.composer.unbind_native();
                self.composer.set_text("");
                self.composer.root.set_visible(false);
                return;
            }
            self.composer.validate_native_reply(&native.store);
            self.composer.root.set_visible(
                native.can_send_to_room(&self.rid)
                    && native.store.thread_writable(&self.rid, &self.root_id).unwrap_or(false),
            );
            self.quote_cards.show(native, &self.rid, Some(&self.root_id), 200, None);
            return;
        }
        if let Some(session) = self.session.borrow().as_ref() {
            self.list.set_rows(session.store.thread_messages(&self.root_id));
        }
    }
    fn reload_private(self: &Rc<Self>) {
        if !self.list.root.is_mapped() || self.private_loading.replace(true) {
            return;
        }
        let Some(native) = self.native.clone().filter(|s| s.crypto_settings_supported()) else {
            self.private_loading.set(false);
            return;
        };
        let (weak, generation, access, rid, root) = (
            Rc::downgrade(self),
            self.private_generation.get(),
            self.crypto.borrow().clone(),
            self.rid.clone(),
            self.root_id.clone(),
        );
        let path = gtk::glib::user_data_dir().join("rocket-vibe-rs/native-crypto");
        let selected = self.composer.private_reply();
        gtk::glib::spawn_future_local(async move {
            let result = crate::on_tokio(async move {
                let access = match access {
                    Some(access) => access,
                    None => {
                        native
                            .crypto_settings(Guard::new(), path, Arc::new(rv_crypto::protected::system::Keyring))
                            .await?
                            .messages(rid, Some(root))
                            .await?
                    }
                };
                let mut view = access.refresh(None, 200).await?;
                for _ in 0..8 {
                    if !view.catching_up {
                        break;
                    }
                    view = access.refresh(None, 200).await?;
                }
                Ok::<_, rv_core::native::crypto::Error>((access, view))
            })
            .await;
            let Some(page) = weak
                .upgrade()
                .filter(|p| p.private_generation.get() == generation && p.private_current() && p.list.root.is_mapped())
            else {
                if let Ok((access, _)) = result {
                    access.close();
                }
                return;
            };
            page.private_loading.set(false);
            match result {
                Ok((access, view)) => {
                    if access.check().is_err() {
                        page.close_private();
                        return;
                    }
                    page.crypto.replace(Some(access.clone()));
                    if !page.private_restored.replace(true) {
                        page.composer.bind_private(access, &page.rid, &view.draft);
                    }
                    if selected.is_some() && page.composer.private_reply() == selected {
                        page.composer.refresh_private_reply(view.selected_quote);
                    }
                    let has_root = view.messages.iter().any(|m| m.row.id == page.root_id && m.row.thread_id.is_none());
                    page.list.root.set_tooltip_text(Some(t(if has_root {
                        "crypto.retained_threads"
                    } else {
                        "crypto.thread_root_missing"
                    })));
                    page.private_meta.replace(
                        view.messages
                            .iter()
                            .filter(|m| m.delivery != private::Delivery::Journaled)
                            .map(|m| (m.row.id.clone(), m.operation.clone()))
                            .collect(),
                    );
                    page.list.set_native_rows(
                        rv_core::timeline::group(view.messages.into_iter().map(|m| m.row).collect()),
                        &page.native.as_ref().unwrap().info.user_id,
                    );
                    page.composer.root.set_visible(
                        view.can_send && !view.catching_up && page.native.as_ref().unwrap().can_send_to_room(&page.rid),
                    );
                }
                Err(_) => {
                    page.close_private();
                    page.list.root.set_tooltip_text(Some(t("crypto.failed")));
                }
            }
        });
    }
    pub fn send_private(self: &Rc<Self>, text: String) {
        let Some(access) =
            self.crypto.borrow().clone().filter(|_| self.private_current() && self.composer.root.is_visible())
        else {
            self.composer.set_text(&text);
            return;
        };
        let (weak, generation, root) = (Rc::downgrade(self), self.private_generation.get(), self.root_id.clone());
        let selected = self.composer.private_reply();
        let quotes = selected.clone().into_iter().collect::<Vec<_>>();
        gtk::glib::spawn_future_local(async move {
            let original = text.clone();
            let result = crate::on_tokio(async move {
                access.set_draft(text.clone()).await?;
                access
                    .send_selected(
                        private::SendMessage {
                            operation_id: rv_core::native::room_operation_id(),
                            text,
                            reply_to: Some(root),
                            quotes: quotes.iter().map(|s| s.reference.clone()).collect(),
                            cards: vec![],
                        },
                        quotes,
                    )
                    .await
            })
            .await;
            if let Some(page) =
                weak.upgrade().filter(|p| p.private_generation.get() == generation && p.private_current())
            {
                if result.is_err() && page.composer.text().is_empty() {
                    page.composer.set_text(&original);
                } else if result.is_ok() && page.composer.private_reply() == selected {
                    page.composer.clear_reply();
                }
                page.reload();
            }
        });
    }
    pub fn quote_private(self: &Rc<Self>, id: String) {
        let Some(access) = self.crypto.borrow().clone().filter(|_| self.private_current()) else { return };
        let (weak, generation) = (Rc::downgrade(self), self.private_generation.get());
        gtk::glib::spawn_future_local(async move {
            let result = crate::on_tokio(async move { access.select_quote(id).await }).await;
            let Some(page) = weak
                .upgrade()
                .filter(|p| p.private_generation.get() == generation && p.private_current() && p.list.root.is_mapped())
            else {
                return;
            };
            match result {
                Ok(preview) => page.composer.set_private_reply(preview),
                Err(_) => page.list.root.set_tooltip_text(Some(t("quote.unavailable"))),
            }
        });
    }
    pub fn retry_private(self: &Rc<Self>, id: &str, cancel: bool) {
        let Some(access) = self.crypto.borrow().clone().filter(|_| self.private_current()) else {
            return;
        };
        let Some((_, operation)) = self.private_meta.borrow().iter().find(|(row, _)| row == id).cloned() else {
            return;
        };
        let (weak, generation) = (Rc::downgrade(self), self.private_generation.get());
        gtk::glib::spawn_future_local(async move {
            let result = crate::on_tokio(async move {
                if cancel { access.cancel(operation).await } else { access.resume(operation).await }
            })
            .await;
            if let Some(page) =
                weak.upgrade().filter(|p| p.private_generation.get() == generation && p.private_current())
            {
                if result.is_err() {
                    page.list.root.set_tooltip_text(Some(t("crypto.failed")));
                }
                page.reload();
            }
        });
    }
}
