//! "New conversation": find people and public channels, then open the DM or
//! join the channel, or pick several people for a group DM.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;
use rv_core::media::{AvatarTarget, avatar_path};
use rv_core::provider::Chat;
use rv_core::rooms::Found;

use crate::i18n::{t, tf};
use crate::on_tokio;
use crate::rows::{label, with_photo};
use crate::widgets::{self, TileSize};

const DEBOUNCE_MS: u64 = 300;

fn result_row(session: &Chat, found: &Found, joined: bool) -> gtk::Widget {
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

/// The people picked for a group DM, shown as chips with a Start button.
struct Group {
    picked: RefCell<Vec<String>>,
    checks: RefCell<Vec<(String, gtk::CheckButton)>>,
    chips: gtk::Box,
    bar: gtk::Box,
    status: gtk::Label,
}

impl Group {
    fn toggle(self: &Rc<Self>, username: &str, on: bool) {
        let full = tf("group_dm.full", &[("n", &rv_core::session::GROUP_DM_MAX.to_string())]);
        if self.status.label() == full {
            self.status.set_visible(false);
        }
        let mut picked = self.picked.borrow_mut();
        let present = picked.iter().any(|p| p == username);
        if on && !present {
            if picked.len() >= rv_core::session::GROUP_DM_MAX {
                drop(picked);
                self.set_check(username, false);
                self.status.set_label(&full);
                self.status.set_visible(true);
                return;
            }
            picked.push(username.to_owned());
        } else if !on && present {
            picked.retain(|p| p != username);
        }
        drop(picked);
        self.refresh();
    }

    fn set_check(&self, username: &str, on: bool) {
        let check = self.checks.borrow().iter().find(|(name, _)| name == username).map(|(_, check)| check.clone());
        if let Some(check) = check {
            check.set_active(on);
        }
    }

    fn refresh(self: &Rc<Self>) {
        while let Some(child) = self.chips.first_child() {
            self.chips.remove(&child);
        }
        for username in self.picked.borrow().iter() {
            let content = gtk::Box::builder().spacing(4).build();
            content.append(&gtk::Label::new(Some(username)));
            content.append(&gtk::Image::from_icon_name("window-close-symbolic"));
            let chip = gtk::Button::builder()
                .child(&content)
                .tooltip_text(t("group_dm.remove"))
                .css_classes(["pill", "small"])
                .build();
            let (weak, name) = (Rc::downgrade(self), username.clone());
            chip.connect_clicked(move |_| {
                if let Some(group) = weak.upgrade() {
                    group.set_check(&name, false);
                    group.toggle(&name, false);
                }
            });
            self.chips.append(&chip);
        }
        self.bar.set_visible(!self.picked.borrow().is_empty());
    }

    fn check(self: &Rc<Self>, username: &str) -> gtk::CheckButton {
        let check = gtk::CheckButton::builder()
            .active(self.picked.borrow().iter().any(|p| p == username))
            .valign(gtk::Align::Center)
            .tooltip_text(t("group_dm.add"))
            .build();
        let (weak, name) = (Rc::downgrade(self), username.to_owned());
        check.connect_toggled(move |check| {
            if let Some(group) = weak.upgrade() {
                group.toggle(&name, check.is_active());
            }
        });
        self.checks.borrow_mut().push((username.to_owned(), check.clone()));
        check
    }
}

/// "New conversation" for any account. `joined(rid)` says whether I am already
/// in a room, `pick` gets the choice, `create` adds the "new channel" entry
/// where the server has one, and `group` lets several people be picked and
/// started together where the server opens group DMs.
pub fn open_chat(
    parent: &impl IsA<gtk::Widget>,
    session: Chat,
    joined: impl Fn(&str) -> bool + 'static,
    pick: impl Fn(Found) + 'static,
    create: Option<Rc<dyn Fn()>>,
    group: Option<Rc<dyn Fn(Vec<String>)>>,
) {
    let search = gtk::SearchEntry::builder().placeholder_text(t("spotlight.placeholder")).hexpand(true).build();
    let results = gtk::ListBox::builder().selection_mode(gtk::SelectionMode::None).css_classes(["boxed-list"]).build();
    let status = gtk::Label::builder().css_classes(["dim-label"]).visible(false).build();
    let column =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(10).css_classes(["spotlight"]).build();
    column.append(&search);
    let chips = gtk::Box::builder().spacing(6).build();
    let bar = gtk::Box::builder().spacing(8).visible(false).build();
    bar.append(
        &gtk::ScrolledWindow::builder().vscrollbar_policy(gtk::PolicyType::Never).hexpand(true).child(&chips).build(),
    );
    let start = gtk::Button::builder().label(t("group_dm.start")).css_classes(["suggested-action", "pill"]).build();
    bar.append(&start);
    column.append(&bar);
    column.append(&status);
    let picking = group.as_ref().map(|_| {
        Rc::new(Group {
            picked: RefCell::default(),
            checks: RefCell::default(),
            chips: chips.clone(),
            bar: bar.clone(),
            status: status.clone(),
        })
    });
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

    if let (Some(group), Some(picking)) = (group, picking.clone()) {
        let d = dialog.clone();
        start.connect_clicked(move |_| {
            let usernames = picking.picked.borrow().clone();
            if usernames.is_empty() {
                return;
            }
            d.close();
            group(usernames);
        });
    }

    let found: Rc<RefCell<Vec<Found>>> = Rc::default();
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
        #[strong]
        picking,
        move |entry| {
            let query = entry.text().trim().to_owned();
            let current = generation.get() + 1;
            generation.set(current);
            let (session, found, generation, joined, picking) =
                (session.clone(), found.clone(), generation.clone(), joined.clone(), picking.clone());
            glib::timeout_add_local_once(std::time::Duration::from_millis(DEBOUNCE_MS), move || {
                if generation.get() != current {
                    return;
                }
                if query.is_empty() {
                    results.remove_all();
                    if let Some(picking) = &picking {
                        picking.checks.borrow_mut().clear();
                    }
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
                    if let Some(picking) = &picking {
                        picking.checks.borrow_mut().clear();
                    }
                    match answer {
                        Ok(list) => {
                            status.set_visible(list.is_empty());
                            status.set_label(t("spotlight.none"));
                            for item in &list {
                                let joined = matches!(item, Found::Room { id, .. } if joined(id));
                                let row = result_row(&session, item, joined);
                                if let (Some(picking), Found::User { username, .. }) = (&picking, item)
                                    && let Some(row) = row.downcast_ref::<gtk::Box>()
                                {
                                    let check = picking.check(username);
                                    check.set_hexpand(true);
                                    check.set_halign(gtk::Align::End);
                                    row.append(&check);
                                }
                                results.append(&row);
                            }
                            found.replace(list);
                        }
                        Err(e) => {
                            status.set_visible(true);
                            let unsupported = e.error.as_deref() == Some(rv_core::slack::NOT_SUPPORTED);
                            status.set_label(t(if unsupported { "spotlight.unsupported" } else { "spotlight.failed" }));
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
            if let (Some(picking), Found::User { username, .. }) = (&picking, &item)
                && !picking.picked.borrow().is_empty()
            {
                let on = !picking.picked.borrow().iter().any(|p| p == username);
                picking.set_check(username, on);
                return;
            }
            dialog.close();
            pick(item);
        }
    ));
    crate::widgets::present(&dialog, Some(parent));
    search.grab_focus();
}
