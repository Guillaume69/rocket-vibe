//! "New conversation": find people and public channels, then open the DM or
//! join the channel.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::media::{AvatarTarget, avatar_path};
use rv_core::rooms::Found;
use rv_core::session::Session;

use crate::i18n::t;
use crate::on_tokio;
use crate::rows::{label, with_photo};
use crate::widgets::{self, TileSize};

const DEBOUNCE_MS: u64 = 300;

#[derive(Clone)]
enum Source {
    RocketChat(Arc<Session>),
    Native(Arc<rv_core::native::NativeSession>),
}
impl Source {
    async fn spotlight(&self, query: &str) -> Result<Vec<Found>, String> {
        match self {
            Self::RocketChat(session) => session.spotlight(query).await.map_err(|e| e.to_string()),
            Self::Native(session) => session.spotlight(query).await.map_err(|e| e.to_string()),
        }
    }
    fn legacy(&self) -> Option<&Arc<Session>> {
        if let Self::RocketChat(session) = self { Some(session) } else { None }
    }
}

fn result_row(session: &Source, found: &Found, joined: bool) -> gtk::Widget {
    let row = gtk::Box::builder().spacing(12).css_classes(["spotlight-row"]).build();
    let (tile, title, detail) = match found {
        Found::User { username, name, .. } => (
            with_photo(
                widgets::tile(username, &widgets::initial(username), TileSize::Message, false),
                session.legacy(),
                session.legacy().map(|_| avatar_path(AvatarTarget::User(username), None)),
            ),
            name.clone().unwrap_or_else(|| username.clone()),
            format!("@{username}"),
        ),
        Found::Room { name, .. } => (
            widgets::tile(name, "#", TileSize::Message, false),
            name.clone(),
            if joined { String::new() } else { t("spotlight.join").to_owned() },
        ),
    };
    row.append(&tile);
    let names = gtk::Box::builder().orientation(gtk::Orientation::Vertical).valign(gtk::Align::Center).build();
    names.append(&label(&title, &["room-name"]));
    if !detail.is_empty() {
        names.append(&label(&detail, &["room-preview"]));
    }
    row.append(&names);
    row.upcast()
}

/// `joined(rid)` says whether I am already in a room; `pick` gets the choice.
pub fn open(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<Session>,
    joined: impl Fn(&str) -> bool + 'static,
    pick: impl Fn(Found) + 'static,
) {
    open_source(parent, Source::RocketChat(session), joined, pick, None);
}

pub fn open_native(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<rv_core::native::NativeSession>,
    joined: impl Fn(&str) -> bool + 'static,
    pick: impl Fn(Found) + 'static,
    create: impl Fn() + 'static,
) {
    open_source(parent, Source::Native(session), joined, pick, Some(Rc::new(create)));
}

fn open_source(
    parent: &impl IsA<gtk::Widget>,
    session: Source,
    joined: impl Fn(&str) -> bool + 'static,
    pick: impl Fn(Found) + 'static,
    create: Option<Rc<dyn Fn()>>,
) {
    let search = gtk::SearchEntry::builder().placeholder_text(t("spotlight.placeholder")).hexpand(true).build();
    let results = gtk::ListBox::builder().selection_mode(gtk::SelectionMode::None).css_classes(["boxed-list"]).build();
    let status = gtk::Label::builder().css_classes(["dim-label"]).visible(false).build();
    let column =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(10).css_classes(["spotlight"]).build();
    column.append(&search);
    column.append(&status);
    column.append(
        &gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .min_content_height(320)
            .vexpand(true)
            .child(&results)
            .build(),
    );
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(&column));
    let dialog =
        adw::Dialog::builder().title(t("rooms.new")).content_width(420).content_height(480).child(&view).build();
    if let Some(create) = create {
        let button = gtk::Button::builder().label(t("native.create")).build();
        let d = dialog.clone();
        button.connect_clicked(move |_| {
            d.close();
            create();
        });
        column.append(&button);
    }

    let found: Rc<std::cell::RefCell<Vec<Found>>> = Rc::default();
    let generation = Rc::new(Cell::new(0u64));
    let joined = Rc::new(joined);
    search.connect_search_changed(glib::clone!(
        #[weak]
        results,
        #[weak]
        status,
        #[strong]
        session,
        #[strong]
        found,
        #[strong]
        generation,
        #[strong]
        joined,
        move |entry| {
            let query = entry.text().trim().to_owned();
            let current = generation.get() + 1;
            generation.set(current);
            let (session, found, generation, joined) =
                (session.clone(), found.clone(), generation.clone(), joined.clone());
            glib::timeout_add_local_once(std::time::Duration::from_millis(DEBOUNCE_MS), move || {
                if generation.get() != current {
                    return;
                }
                if query.is_empty() {
                    results.remove_all();
                    status.set_visible(false);
                    return;
                }
                glib::spawn_future_local(async move {
                    let s = session.clone();
                    let answer = on_tokio(async move { s.spotlight(&query).await }).await;
                    if generation.get() != current {
                        return;
                    }
                    results.remove_all();
                    match answer {
                        Ok(list) => {
                            status.set_visible(list.is_empty());
                            status.set_label(t("spotlight.none"));
                            for item in &list {
                                let joined = matches!(item, Found::Room { id, .. } if joined(id));
                                results.append(&result_row(&session, item, joined));
                            }
                            found.replace(list);
                        }
                        Err(_) => {
                            status.set_visible(true);
                            status.set_label(t("spotlight.failed"));
                        }
                    }
                });
            });
        }
    ));
    results.set_activate_on_single_click(true);
    results.connect_row_activated(glib::clone!(
        #[weak]
        dialog,
        move |_, row| {
            let Some(item) = found.borrow().get(row.index() as usize).cloned() else { return };
            dialog.close();
            pick(item);
        }
    ));
    dialog.present(Some(parent));
    search.grab_focus();
}
