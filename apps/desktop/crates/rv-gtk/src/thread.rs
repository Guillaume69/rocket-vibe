//! A thread: its root and every reply, with a composer that answers in it.

use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use rv_core::session::Session;

use crate::composer::Composer;
use crate::i18n::t;
use crate::message_list::{MessageList, Shared};

pub struct ThreadPage {
    pub page: adw::NavigationPage,
    pub list: Rc<MessageList>,
    pub composer: Rc<Composer>,
    pub root_id: String,
    pub rid: String,
    session: Shared<Arc<Session>>,
    native: Option<Arc<rv_core::native::NativeSession>>,
    pub membership: Option<String>,
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
            list,
            composer,
            root_id: root_id.to_owned(),
            rid: rid.to_owned(),
            session,
            native: None,
            membership: None,
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
        owned.composer.bind_native_thread(&native, rid, root, membership.clone());
        owned.native = Some(native);
        owned.membership = membership;
        page
    }

    pub fn reload(&self) {
        if let Some(native) = &self.native {
            let current = native.store.read_state(&self.rid).ok().flatten().and_then(|s| s.membership_version);
            if current != self.membership || current.is_none() || native.is_closed() {
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
            if let Ok(rows) = native.store.thread_messages(&self.rid, &self.root_id) {
                self.list.set_native_rows(
                    rv_core::native::read_presentation::group(rows, &self.rid, &native.info.user_id, None),
                    &native.info.user_id,
                );
            }
            return;
        }
        if let Some(session) = self.session.borrow().as_ref() {
            self.list.set_rows(session.store.thread_messages(&self.root_id));
        }
    }
}
