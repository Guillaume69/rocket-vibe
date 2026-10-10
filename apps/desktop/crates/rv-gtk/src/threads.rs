//! A room's threads (Rocket.Chat), in a dialog with a tab for every thread
//! and one for those I follow, by pages of 50, the most recently answered
//! first. A bell follows or unfollows one; a click opens it.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::session::Session;
use rv_core::store::MessageRow;

use crate::i18n::{t, tf, tn};
use crate::on_tokio;
use crate::rows::{label, local, short_time};

const PAGE: u32 = 50;

/// The bell says whether I follow the thread; its tooltip, what a click does.
pub fn bell(button: &gtk::Button, following: bool) {
    button.set_icon_name(if following {
        "preferences-system-notifications-symbolic"
    } else {
        "notifications-disabled-symbolic"
    });
    button.set_tooltip_text(Some(t(if following { "thread.unfollow" } else { "thread.follow" })));
}

/// Follows `root` (`on`) or stops, then hands the outcome back on the GTK side.
pub fn follow(session: Arc<Session>, root: String, on: bool, done: impl FnOnce(bool) + 'static) {
    glib::spawn_future_local(async move {
        let result = on_tokio(async move { session.follow_thread(&root, on).await }).await;
        done(result.is_ok());
    });
}

/// What a root says, on a few lines: its text, else that it is a file or locked.
fn preview(row: &MessageRow) -> String {
    match row.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(text) => text.to_owned(),
        None if row.system_type.as_deref() == Some(rv_core::normalize::ENCRYPTED_TYPE) => {
            t("message.encrypted").to_owned()
        }
        None => t("marked.attachment").to_owned(),
    }
}

fn summary(row: &MessageRow) -> String {
    let time = row.thread_last.map(short_time).unwrap_or_default();
    let replies = tn("message.replies", row.thread_count);
    if time.is_empty() { replies } else { tf("threads.summary", &[("replies", &replies), ("time", &time)]) }
}

struct Page {
    session: Arc<Session>,
    rid: String,
    following: bool,
    stack: gtk::Stack,
    list: gtk::ListBox,
    more: gtk::Button,
    toasts: adw::ToastOverlay,
    ids: RefCell<Vec<String>>,
    offset: Cell<u32>,
    loading: Cell<bool>,
    started: Cell<bool>,
    /// Bumped by `reset`: an answer for an earlier listing is dropped.
    generation: Cell<u64>,
    /// After I follow or unfollow a thread here: the other tab is out of date.
    on_follow: RefCell<Option<Rc<dyn Fn()>>>,
}

impl Page {
    fn new(
        session: Arc<Session>,
        rid: &str,
        following: bool,
        toasts: &adw::ToastOverlay,
        go: Rc<dyn Fn(String)>,
    ) -> Rc<Self> {
        let stack = gtk::Stack::new();
        stack.add_named(&adw::Spinner::builder().width_request(32).height_request(32).build(), Some("loading"));
        let list = gtk::ListBox::builder()
            .selection_mode(gtk::SelectionMode::None)
            .css_classes(["boxed-list"])
            .valign(gtk::Align::Start)
            .build();
        let more = gtk::Button::builder()
            .label(t("threads.more"))
            .css_classes(["pill"])
            .halign(gtk::Align::Center)
            .margin_top(10)
            .visible(false)
            .build();
        let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).build();
        column.append(&list);
        column.append(&more);
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .vexpand(true)
            .child(&column)
            .build();
        stack.add_named(&scroll, Some("list"));
        let empty = adw::StatusPage::builder()
            .icon_name(if following {
                "preferences-system-notifications-symbolic"
            } else {
                "chat-message-new-symbolic"
            })
            .title(t(if following { "threads.none_following" } else { "threads.none" }))
            .build();
        stack.add_named(&empty, Some("empty"));
        let retry = gtk::Button::builder()
            .label(t("native.retry"))
            .css_classes(["pill", "suggested-action"])
            .halign(gtk::Align::Center)
            .build();
        let failed = adw::StatusPage::builder()
            .icon_name("dialog-warning-symbolic")
            .title(t("info.failed"))
            .child(&retry)
            .build();
        stack.add_named(&failed, Some("failed"));

        let page = Rc::new(Page {
            session,
            rid: rid.to_owned(),
            following,
            stack,
            list,
            more,
            toasts: toasts.clone(),
            ids: RefCell::default(),
            offset: Cell::new(0),
            loading: Cell::new(false),
            started: Cell::new(false),
            generation: Cell::new(0),
            on_follow: RefCell::default(),
        });
        let weak = Rc::downgrade(&page);
        retry.connect_clicked(move |_| {
            if let Some(page) = weak.upgrade() {
                page.reset();
                page.ensure();
            }
        });
        let weak = Rc::downgrade(&page);
        page.more.connect_clicked(move |_| {
            if let Some(page) = weak.upgrade() {
                page.load();
            }
        });
        let weak = Rc::downgrade(&page);
        scroll.connect_edge_reached(move |_, position| {
            if position == gtk::PositionType::Bottom
                && let Some(page) = weak.upgrade()
                && page.more.is_visible()
            {
                page.load();
            }
        });
        let weak = Rc::downgrade(&page);
        page.list.connect_row_activated(move |_, item| {
            let Some(page) = weak.upgrade() else { return };
            let id = page.ids.borrow().get(item.index() as usize).cloned();
            if let Some(id) = id {
                go(id);
            }
        });
        page
    }

    /// Loads the first page the first time the tab shows.
    fn ensure(self: &Rc<Self>) {
        if !self.started.replace(true) {
            self.stack.set_visible_child_name("loading");
            self.load();
        }
    }

    /// Forgets the listing: the next `ensure` starts over.
    fn reset(&self) {
        self.generation.set(self.generation.get().wrapping_add(1));
        self.started.set(false);
        self.loading.set(false);
        self.offset.set(0);
        self.ids.borrow_mut().clear();
        self.list.remove_all();
        self.more.set_visible(false);
    }

    fn load(self: &Rc<Self>) {
        if self.loading.replace(true) {
            return;
        }
        let (s, rid, following, offset, generation) =
            (self.session.clone(), self.rid.clone(), self.following, self.offset.get(), self.generation.get());
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { s.threads(&rid, following, offset, PAGE).await }).await;
            let Some(page) = weak.upgrade().filter(|p| p.generation.get() == generation) else { return };
            page.loading.set(false);
            match result {
                Ok((rows, total)) => {
                    if offset == 0 && rows.is_empty() {
                        page.stack.set_visible_child_name("empty");
                        return;
                    }
                    for row in rows.iter().filter(|r| !page.ids.borrow().contains(&r.id)) {
                        let row = page.session.open_row(row.clone());
                        page.list.append(&page.entry(&row));
                        page.ids.borrow_mut().push(row.id);
                    }
                    let next = offset + rows.len() as u32;
                    page.offset.set(next);
                    page.more.set_visible(!rows.is_empty() && next < total);
                    page.stack.set_visible_child_name("list");
                }
                Err(_) if offset == 0 => page.stack.set_visible_child_name("failed"),
                Err(_) => page.toasts.add_toast(adw::Toast::new(t("info.failed"))),
            }
        });
    }

    fn entry(self: &Rc<Self>, row: &MessageRow) -> gtk::ListBoxRow {
        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(2)
            .hexpand(true)
            .css_classes(["marked-row"])
            .build();
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 7);
        header.append(&label(row.author.as_deref().unwrap_or_default(), &["author"]));
        header.append(&label(&local(row.ts).format("%d/%m/%Y %H:%M").to_string(), &["message-time"]));
        column.append(&header);
        let text = label(&preview(row), &["message-body"]);
        text.set_wrap(true);
        text.set_wrap_mode(gtk::pango::WrapMode::WordChar);
        text.set_lines(3);
        text.set_ellipsize(gtk::pango::EllipsizeMode::End);
        column.append(&text);
        column.append(&label(&summary(row), &["message-time"]));

        let following = Rc::new(Cell::new(row.followed_by(&self.session.info.user_id)));
        let button = gtk::Button::builder().css_classes(["flat", "circular"]).valign(gtk::Align::Center).build();
        bell(&button, following.get());
        let (weak, root) = (Rc::downgrade(self), row.id.clone());
        button.connect_clicked(move |button| {
            let Some(page) = weak.upgrade() else { return };
            let on = !following.get();
            button.set_sensitive(false);
            let (button, following, weak) = (button.clone(), following.clone(), weak.clone());
            follow(page.session.clone(), root.clone(), on, move |ok| {
                button.set_sensitive(true);
                let Some(page) = weak.upgrade() else { return };
                if ok {
                    following.set(on);
                    bell(&button, on);
                    page.toasts.add_toast(adw::Toast::new(t(if on { "thread.followed" } else { "thread.unfollowed" })));
                    let changed = page.on_follow.borrow().clone();
                    if let Some(changed) = changed {
                        changed();
                    }
                } else {
                    page.toasts.add_toast(adw::Toast::new(t("thread.follow_failed")));
                }
            });
        });

        let line = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        line.append(&column);
        line.append(&button);
        gtk::ListBoxRow::builder().child(&line).activatable(true).build()
    }
}

/// The room's threads; `go` opens the one clicked, once the dialog closed.
pub fn open(parent: &impl IsA<gtk::Widget>, session: Arc<Session>, rid: &str, go: impl Fn(String) + 'static) {
    let dialog = adw::Dialog::builder().title(t("threads.title")).content_width(460).content_height(600).build();
    let weak = dialog.downgrade();
    let go: Rc<dyn Fn(String)> = Rc::new(move |id| {
        if let Some(dialog) = weak.upgrade() {
            dialog.close();
        }
        go(id);
    });
    let toasts = adw::ToastOverlay::new();
    let all = Page::new(session.clone(), rid, false, &toasts, go.clone());
    let mine = Page::new(session, rid, true, &toasts, go);
    let (to_all, to_mine) = (Rc::downgrade(&all), Rc::downgrade(&mine));
    all.on_follow.replace(Some(Rc::new(move || {
        if let Some(page) = to_mine.upgrade() {
            page.reset();
        }
    })));
    mine.on_follow.replace(Some(Rc::new(move || {
        if let Some(page) = to_all.upgrade() {
            page.reset();
        }
    })));
    let tabs = adw::ViewStack::new();
    tabs.add_titled_with_icon(&all.stack, Some("all"), t("threads.all"), "chat-message-new-symbolic");
    tabs.add_titled_with_icon(
        &mine.stack,
        Some("following"),
        t("threads.following"),
        "preferences-system-notifications-symbolic",
    );
    let pages = [all.clone(), mine.clone()];
    tabs.connect_visible_child_name_notify(move |tabs| {
        let shown = if tabs.visible_child_name().as_deref() == Some("following") { &pages[1] } else { &pages[0] };
        shown.ensure();
    });
    all.ensure();
    let switcher = adw::ViewSwitcher::builder().stack(&tabs).policy(adw::ViewSwitcherPolicy::Wide).build();
    let header = adw::HeaderBar::new();
    header.set_title_widget(Some(&switcher));
    let view = adw::ToolbarView::new();
    view.add_top_bar(&header);
    let content = gtk::Box::builder().orientation(gtk::Orientation::Vertical).css_classes(["marked"]).build();
    content.append(&tabs);
    toasts.set_child(Some(&content));
    view.set_content(Some(&toasts));
    dialog.set_child(Some(&view));
    crate::widgets::present(&dialog, Some(parent));
}
