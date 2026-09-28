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
        Rc::new(ThreadPage { page, list, composer, root_id: root_id.to_owned(), rid: rid.to_owned(), session })
    }

    pub fn reload(&self) {
        if let Some(session) = self.session.borrow().as_ref() {
            self.list.set_rows(session.store.thread_messages(&self.root_id));
        }
    }
}
