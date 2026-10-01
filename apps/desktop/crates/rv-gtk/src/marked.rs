//! The room's pinned messages and the ones I starred, in a dialog with a tab
//! each; a click on one goes to it in the room.

use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::session::Session;
use rv_core::store::MessageRow;

use crate::i18n::t;
use crate::on_tokio;
use crate::rows::{label, local};

#[derive(Clone)]
enum Provider {
    RocketChat(Arc<Session>),
    RocketVibe(Arc<rv_core::native::NativeSession>),
}
impl Provider {
    fn username(&self) -> String {
        match self {
            Self::RocketChat(s) => s.info.username.clone(),
            Self::RocketVibe(s) => s.info.username.clone(),
        }
    }
    async fn rows(self, rid: String, starred: bool) -> Result<Vec<MessageRow>, ()> {
        match self {
            Self::RocketChat(s) => s.marked(&rid, starred).await.map_err(|_| ()),
            Self::RocketVibe(s) => {
                let ids = s.marked(&rid, starred).await.map_err(|_| ())?.into_iter().map(|m| m.id).collect::<Vec<_>>();
                Ok(s.store
                    .selected_messages(&ids)
                    .map_err(|_| ())?
                    .into_iter()
                    .map(|r| r.presentation(&rid, &s.info.user_id))
                    .collect())
            }
        }
    }
}

fn entry(row: &MessageRow, me: &str) -> gtk::Widget {
    let column =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).css_classes(["marked-row"]).build();
    let header = gtk::Box::new(gtk::Orientation::Horizontal, 7);
    header.append(&label(row.author.as_deref().unwrap_or_default(), &["author"]));
    header.append(&label(&local(row.ts).format("%d/%m/%Y %H:%M").to_string(), &["message-time"]));
    column.append(&header);
    let blocks = rv_core::markdown::render(row.md.as_deref(), row.text.as_deref(), &rv_core::markdown::Context { me });
    if blocks.is_empty() {
        column.append(&label(t("marked.attachment"), &["message-body"]));
    } else {
        column.append(&crate::markdown_view::view(&blocks, &[]));
    }
    column.upcast()
}

fn page(session: &Provider, rid: &str, starred: bool, go: Rc<dyn Fn(String)>) -> gtk::Widget {
    let stack = gtk::Stack::new();
    stack.add_named(&adw::Spinner::builder().width_request(32).height_request(32).build(), Some("loading"));
    let list = gtk::ListBox::builder()
        .selection_mode(gtk::SelectionMode::None)
        .css_classes(["boxed-list"])
        .valign(gtk::Align::Start)
        .build();
    let scroll =
        gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&list).build();
    stack.add_named(&scroll, Some("list"));
    let empty = adw::StatusPage::builder()
        .icon_name(if starred { "starred-symbolic" } else { "view-pin-symbolic" })
        .title(t(if starred { "marked.no_starred" } else { "marked.no_pinned" }))
        .build();
    stack.add_named(&empty, Some("empty"));
    let failed = adw::StatusPage::builder().icon_name("dialog-warning-symbolic").title(t("info.failed")).build();
    stack.add_named(&failed, Some("failed"));

    let (s, r, me) = (session.clone(), rid.to_owned(), session.username());
    glib::spawn_future_local(glib::clone!(
        #[weak]
        stack,
        #[weak]
        list,
        async move {
            let rows = on_tokio(async move { s.rows(r, starred).await }).await;
            match rows {
                Ok(rows) if rows.is_empty() => stack.set_visible_child_name("empty"),
                Ok(rows) => {
                    for row in &rows {
                        let item = gtk::ListBoxRow::builder().child(&entry(row, &me)).activatable(true).build();
                        list.append(&item);
                    }
                    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
                    list.connect_row_activated(move |_, item| {
                        if let Some(id) = ids.get(item.index() as usize) {
                            go(id.clone());
                        }
                    });
                    stack.set_visible_child_name("list");
                }
                Err(_) => stack.set_visible_child_name("failed"),
            }
        }
    ));
    stack.upcast()
}

pub fn open(parent: &impl IsA<gtk::Widget>, session: Arc<Session>, rid: &str, go: impl Fn(String) + 'static) {
    open_provider(parent, Provider::RocketChat(session), rid, go);
}
pub fn open_native(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<rv_core::native::NativeSession>,
    rid: &str,
    go: impl Fn(String) + 'static,
) {
    open_provider(parent, Provider::RocketVibe(session), rid, go);
}
fn open_provider(parent: &impl IsA<gtk::Widget>, session: Provider, rid: &str, go: impl Fn(String) + 'static) {
    let dialog = adw::Dialog::builder().title(t("marked.title")).content_width(440).content_height(560).build();
    let weak = dialog.downgrade();
    let go: Rc<dyn Fn(String)> = Rc::new(move |id| {
        if let Some(dialog) = weak.upgrade() {
            dialog.close();
        }
        go(id);
    });
    let tabs = adw::ViewStack::new();
    tabs.add_titled_with_icon(
        &page(&session, rid, false, go.clone()),
        Some("pinned"),
        t("marked.pinned"),
        "view-pin-symbolic",
    );
    tabs.add_titled_with_icon(&page(&session, rid, true, go), Some("starred"), t("marked.starred"), "starred-symbolic");
    let switcher = adw::ViewSwitcher::builder().stack(&tabs).policy(adw::ViewSwitcherPolicy::Wide).build();
    let header = adw::HeaderBar::new();
    header.set_title_widget(Some(&switcher));
    let view = adw::ToolbarView::new();
    view.add_top_bar(&header);
    let content = gtk::Box::builder().orientation(gtk::Orientation::Vertical).css_classes(["marked"]).build();
    content.append(&tabs);
    view.set_content(Some(&content));
    dialog.set_child(Some(&view));
    dialog.present(Some(parent));
}
