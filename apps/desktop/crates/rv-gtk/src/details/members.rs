//! A Rocket.Chat channel's or group's members, from its information
//! dialog: read from the server (`rv_core::members`), owners and moderators
//! first, searched by the server, a page of 50 more at the bottom. A row
//! opens the profile; its menu (or a right click) gives or takes a room role
//! and removes the person, as my roles allow. The list is not live: a
//! change made here updates its row.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::members::{self, Member, MemberAction, MemberList, MemberRights};
use rv_core::session::Session;

use super::{label, t};
use crate::i18n::{tf, tn};
use crate::on_tokio;
use crate::rows::{presence_dot, with_photo};
use crate::widgets::{self, TileSize};

struct Members {
    session: Arc<Session>,
    rid: String,
    list: RefCell<MemberList>,
    rights: Cell<MemberRights>,
    filter: RefCell<String>,
    /// A new search drops a page still on its way for the old one.
    generation: Cell<u64>,
    loading: Cell<bool>,
    active: Cell<bool>,
    rows: gtk::ListBox,
    status: gtk::Label,
    spinner: gtk::Spinner,
    toasts: adw::ToastOverlay,
    dialog: glib::WeakRef<adw::Dialog>,
    profile: Rc<dyn Fn(String)>,
}

/// Opens the list over `parent` (the information dialog), which closes it too.
pub(super) fn open(parent: &adw::Dialog, session: Arc<Session>, rid: String, profile: Rc<dyn Fn(String)>) {
    let search = gtk::SearchEntry::builder()
        .placeholder_text(t("members.search"))
        .search_delay(members::SEARCH_DELAY_MS)
        .hexpand(true)
        .css_classes(["members-search"])
        .build();
    let bar = gtk::Box::builder().margin_start(12).margin_end(12).margin_bottom(6).build();
    bar.append(&search);
    let rows = gtk::ListBox::builder()
        .selection_mode(gtk::SelectionMode::None)
        .css_classes(["boxed-list", "members-list"])
        .build();
    let status = gtk::Label::builder().css_classes(["details-sub"]).wrap(true).visible(false).margin_top(12).build();
    let spinner = gtk::Spinner::builder().spinning(true).margin_top(12).margin_bottom(12).build();
    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(8)
        .margin_start(12)
        .margin_end(12)
        .margin_bottom(12)
        .build();
    column.append(&rows);
    column.append(&status);
    column.append(&spinner);
    let scrolled =
        gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&column).build();
    let toasts = adw::ToastOverlay::new();
    toasts.set_child(Some(&scrolled));
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.add_top_bar(&bar);
    view.set_content(Some(&toasts));
    let dialog = adw::Dialog::builder()
        .title(t("members.title"))
        .content_width(420)
        .content_height(560)
        .css_classes(["room-members-dialog"])
        .child(&view)
        .build();
    let state = Rc::new(Members {
        session,
        rid,
        list: RefCell::default(),
        rights: Cell::default(),
        filter: RefCell::default(),
        generation: Cell::new(0),
        loading: Cell::new(false),
        active: Cell::new(true),
        rows,
        status,
        spinner,
        toasts,
        dialog: dialog.downgrade(),
        profile,
    });
    let weak = dialog.downgrade();
    parent.connect_closed(move |_| {
        if let Some(dialog) = weak.upgrade() {
            dialog.close();
        }
    });
    let s = state.clone();
    dialog.connect_closed(move |_| s.active.set(false));
    let s = state.clone();
    search.connect_search_changed(move |entry| s.reload(entry.text().trim().to_owned()));
    let s = state.clone();
    scrolled.connect_edge_reached(move |_, edge| {
        if edge == gtk::PositionType::Bottom {
            s.more();
        }
    });
    let s = state.clone();
    state.rows.connect_row_activated(move |_, row| {
        if let Some(username) = row.widget_name().strip_prefix("member-") {
            (s.profile)(username.to_owned());
        }
    });
    widgets::present(&dialog, Some(parent));
    // My rights first, so the first rows already carry their menus.
    let s = state.clone();
    glib::spawn_future_local(async move {
        let (session, rid) = (s.session.clone(), s.rid.clone());
        let rights = on_tokio(async move { session.member_rights(&rid).await }).await;
        s.rights.set(rights);
        s.reload(String::new());
    });
}

impl Members {
    /// The first page for `filter`, replacing what is shown.
    fn reload(self: &Rc<Self>, filter: String) {
        if !self.active.get() {
            return;
        }
        self.generation.set(self.generation.get() + 1);
        let generation = self.generation.get();
        *self.filter.borrow_mut() = filter.clone();
        *self.list.borrow_mut() = MemberList::default();
        self.rows.remove_all();
        self.status.set_visible(false);
        self.spinner.set_visible(true);
        self.loading.set(true);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let (session, rid) = (this.session.clone(), this.rid.clone());
            let page = on_tokio(async move { session.room_members(&rid, &filter, 0).await }).await;
            if !this.active.get() || this.generation.get() != generation {
                return;
            }
            this.loading.set(false);
            this.spinner.set_visible(false);
            match page {
                Ok(page) => {
                    *this.list.borrow_mut() = MemberList::first(page);
                    let shown = this.list.borrow().members.clone();
                    for member in &shown {
                        this.rows.append(&this.row(member));
                    }
                    this.after_change();
                }
                Err(e) => {
                    eprintln!("Members not read: {e}");
                    this.status.set_text(t("members.load_failed"));
                    this.status.set_visible(true);
                }
            }
        });
    }

    /// The next page, once the bottom is reached, while there is one.
    fn more(self: &Rc<Self>) {
        if !self.active.get() || self.loading.get() || !self.list.borrow().has_more() {
            return;
        }
        let generation = self.generation.get();
        let (filter, offset) = (self.filter.borrow().clone(), self.list.borrow().offset());
        self.loading.set(true);
        self.spinner.set_visible(true);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let (session, rid) = (this.session.clone(), this.rid.clone());
            let page = on_tokio(async move { session.room_members(&rid, &filter, offset).await }).await;
            if !this.active.get() || this.generation.get() != generation {
                return;
            }
            this.loading.set(false);
            this.spinner.set_visible(false);
            match page {
                Ok(page) => {
                    let fresh = this.list.borrow_mut().append(page);
                    for member in &fresh {
                        this.rows.append(&this.row(member));
                    }
                    this.after_change();
                }
                Err(e) => eprintln!("More members not read: {e}"),
            }
        });
    }

    /// The title counts the members while no search narrows them; an empty
    /// result says so.
    fn after_change(&self) {
        let list = self.list.borrow();
        let empty = list.members.is_empty();
        self.status.set_text(t("members.none"));
        self.status.set_visible(empty);
        if let Some(dialog) = self.dialog.upgrade() {
            let title = if self.filter.borrow().is_empty() {
                tn("members.count", list.total as i64)
            } else {
                t("members.title").to_owned()
            };
            dialog.set_title(&title);
        }
    }

    fn row(self: &Rc<Self>, member: &Member) -> gtk::ListBoxRow {
        let line = gtk::Box::builder().spacing(12).margin_top(6).margin_bottom(6).margin_start(8).margin_end(6).build();
        let tile = widgets::tile(&member.username, &widgets::initial(member.shown_name()), TileSize::Room, false);
        let tile = with_photo(tile, Some(&self.session), Some(member.avatar()));
        let tile = match self.session.presence(&member.id).or(member.presence) {
            Some(p) => {
                let holder = gtk::Overlay::builder().child(&tile).build();
                holder.add_overlay(&presence_dot(p, &["presence-badge"]));
                holder.upcast()
            }
            None => tile,
        };
        tile.set_valign(gtk::Align::Center);
        line.append(&tile);
        let names = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(1).hexpand(true).build();
        names.set_valign(gtk::Align::Center);
        let name = label(member.shown_name(), &["member-name"]);
        name.set_ellipsize(gtk::pango::EllipsizeMode::End);
        names.append(&name);
        let username = label(&format!("@{}", member.username), &["details-sub"]);
        username.set_ellipsize(gtk::pango::EllipsizeMode::End);
        names.append(&username);
        line.append(&names);
        for key in member.role_keys() {
            let chip = label(t(key), &["role-chip", "member-role"]);
            chip.set_valign(gtk::Align::Center);
            line.append(&chip);
        }
        let row = gtk::ListBoxRow::builder().activatable(true).child(&line).css_classes(["member-row"]).build();
        row.set_widget_name(&format!("member-{}", member.username));
        let actions = members::member_actions(self.rights.get(), member, &self.session.info.user_id);
        if !actions.is_empty() {
            let menu = self.menu(member, &actions);
            line.append(&menu);
            // A right click anywhere on the row opens the same menu.
            let click = gtk::GestureClick::builder().button(gtk::gdk::BUTTON_SECONDARY).build();
            let target = menu.downgrade();
            click.connect_pressed(move |gesture, _, _, _| {
                gesture.set_state(gtk::EventSequenceState::Claimed);
                if let Some(menu) = target.upgrade() {
                    menu.popup();
                }
            });
            row.add_controller(click);
        }
        row
    }

    fn menu(self: &Rc<Self>, member: &Member, actions: &[MemberAction]) -> gtk::MenuButton {
        let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).build();
        let popover = gtk::Popover::builder().has_arrow(false).child(&column).css_classes(["member-actions"]).build();
        for &action in actions {
            let button =
                gtk::Button::builder().label(t(action.label_key())).css_classes(["flat", "member-action"]).build();
            button.set_widget_name(action.id());
            if action == MemberAction::Remove {
                button.add_css_class("error");
            }
            if let Some(child) = button.child().and_downcast::<gtk::Label>() {
                child.set_xalign(0.0);
            }
            let (this, id, pop) = (self.clone(), member.id.clone(), popover.downgrade());
            button.connect_clicked(move |_| {
                if let Some(pop) = pop.upgrade() {
                    pop.popdown();
                }
                this.act(&id, action);
            });
            column.append(&button);
        }
        gtk::MenuButton::builder()
            .icon_name("view-more-horizontal-symbolic")
            .tooltip_text(t("members.actions"))
            .valign(gtk::Align::Center)
            .css_classes(["flat", "member-menu"])
            .popover(&popover)
            .build()
    }

    /// Runs `action` on the member `id`: a removal asks first.
    fn act(self: &Rc<Self>, id: &str, action: MemberAction) {
        let Some(member) = self.list.borrow().member(id).cloned() else { return };
        match action {
            MemberAction::Role(role, put) => self.run(member, action, move |s, rid, uid| {
                Box::pin(async move { s.set_member_role(&rid, &uid, role, put).await })
            }),
            MemberAction::Remove => {
                let alert = adw::AlertDialog::builder()
                    .heading(tf("members.remove_title", &[("name", member.shown_name())]))
                    .body(t("members.remove_body"))
                    .default_response("cancel")
                    .close_response("cancel")
                    .css_classes(["alert", "member-remove-confirm"])
                    .build();
                alert.add_responses(&[("cancel", t("actions.cancel")), ("remove", t("members.remove"))]);
                alert.set_response_appearance("remove", adw::ResponseAppearance::Destructive);
                let this = self.clone();
                alert.connect_response(Some("remove"), move |_, _| {
                    this.run(member.clone(), action, |s, rid, uid| {
                        Box::pin(async move { s.remove_member(&rid, &uid).await })
                    });
                });
                widgets::present(&alert, self.dialog.upgrade().as_ref());
            }
        }
    }

    /// Sends the change, then shows it on the row (or takes the row away);
    /// a refusal says why in a toast.
    fn run(
        self: &Rc<Self>,
        member: Member,
        action: MemberAction,
        call: impl FnOnce(
            Arc<Session>,
            String,
            String,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), rv_core::rest::RestError>> + Send>,
        >,
    ) {
        let Some(row) = self.row_of(&member.username) else { return };
        row.set_sensitive(false);
        let future = call(self.session.clone(), self.rid.clone(), member.id.clone());
        let this = self.clone();
        glib::spawn_future_local(async move {
            let done = on_tokio(future).await;
            if !this.active.get() {
                return;
            }
            row.set_sensitive(true);
            match done {
                Ok(()) => this.changed(&member, action, &row),
                Err(e) => {
                    eprintln!("Member change refused: {e}");
                    this.toasts.add_toast(adw::Toast::new(t(members::error_key(&e))));
                }
            }
        });
    }

    fn changed(self: &Rc<Self>, member: &Member, action: MemberAction, row: &gtk::ListBoxRow) {
        let index = row.index();
        match action {
            MemberAction::Role(role, put) => {
                let updated = self.list.borrow_mut().set_role(&member.id, role, put).cloned();
                if let Some(updated) = updated {
                    self.rows.remove(row);
                    self.rows.insert(&self.row(&updated), index);
                }
            }
            MemberAction::Remove => {
                self.list.borrow_mut().remove(&member.id);
                self.rows.remove(row);
                self.after_change();
            }
        }
    }

    fn row_of(&self, username: &str) -> Option<gtk::ListBoxRow> {
        let name = format!("member-{username}");
        std::iter::successors(self.rows.first_child(), |w| w.next_sibling())
            .filter_map(|w| w.downcast::<gtk::ListBoxRow>().ok())
            .find(|row| row.widget_name() == name)
    }
}
