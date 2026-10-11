//! "Remind me" (brain/features/reminders.md): the message menus' entry and its
//! choices, "Pick a time", the Reminders list of the account menu, and the
//! timer that fires due reminders as notifications. The reminders themselves
//! live on the device, in `rv_core::reminders` (the directory the SwiftUI app
//! shares on a Mac).

use std::cell::RefCell;
use std::rc::Rc;

use adw::prelude::*;
use chrono::{Local, Utc};
use gtk::glib;
use rv_core::reminders::{self, Reminder, Reminders};
use rv_core::session::SessionInfo;

use crate::i18n::t;
use crate::notifier::Notifier;

/// The device's reminders, beside the app's other small files.
pub fn store() -> Reminders {
    Reminders::new(&glib::user_config_dir().join("rocket-vibe-rs"))
}

thread_local! {
    /// The notifier fired reminders go to, and the timer's next look.
    static DRIVER: RefCell<Option<(Rc<Notifier>, Option<glib::SourceId>)>> = const { RefCell::new(None) };
}

/// Starts firing reminders through `notifier`: the missed ones at once (those
/// more than 7 days late dropped), then each at its time.
pub fn start(notifier: Rc<Notifier>) {
    DRIVER.with_borrow_mut(|d| *d = Some((notifier, None)));
    check();
}

/// Looks again now: a reminder was just set, maybe a minute away.
pub fn poke() {
    let running = DRIVER.with_borrow_mut(|d| {
        let Some((_, timer)) = d.as_mut() else { return false };
        if let Some(timer) = timer.take() {
            timer.remove();
        }
        true
    });
    if running {
        check();
    }
}

fn check() {
    let store = store();
    let now = Utc::now().timestamp();
    let fired = store.take_due(now);
    let notifier = DRIVER.with_borrow(|d| d.as_ref().map(|(n, _)| n.clone()));
    if let Some(notifier) = &notifier {
        for reminder in &fired {
            notifier.remind(reminder);
        }
    }
    if !fired.is_empty() {
        changed();
    }
    let wait = store.wait(Utc::now().timestamp());
    let timer = glib::timeout_add_local_once(wait, || {
        DRIVER.with_borrow_mut(|d| {
            if let Some((_, timer)) = d.as_mut() {
                timer.take();
            }
        });
        check();
    });
    DRIVER.with_borrow_mut(|d| match d.as_mut() {
        Some((_, slot)) => {
            if let Some(old) = slot.replace(timer) {
                old.remove();
            }
        }
        None => timer.remove(),
    });
}

/// A watcher of `changed`, by the id `connect_changed` gave it.
type Watcher = (u64, Rc<dyn Fn()>);

thread_local! {
    /// What redraws when reminders change: the open list.
    static WATCHERS: RefCell<Vec<Watcher>> = const { RefCell::new(Vec::new()) };
    static NEXT_WATCH: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Reminders were set, cancelled or fired.
pub fn changed() {
    let watchers: Vec<Rc<dyn Fn()>> = WATCHERS.with_borrow(|w| w.iter().map(|(_, f)| f.clone()).collect());
    for watcher in watchers {
        watcher();
    }
}

pub fn connect_changed(f: impl Fn() + 'static) -> u64 {
    let id = NEXT_WATCH.with(|n| {
        n.set(n.get() + 1);
        n.get()
    });
    WATCHERS.with_borrow_mut(|w| w.push((id, Rc::new(f))));
    id
}

pub fn disconnect_changed(id: u64) {
    WATCHERS.with_borrow_mut(|w| w.retain(|(watch, _)| *watch != id));
}

/// Signing out: the account's reminders go with it.
pub fn forget(info: &SessionInfo) {
    store().remove_account(info);
}

/// What a reminder about a message keeps of it.
#[derive(Clone)]
pub struct Draft {
    pub rid: String,
    pub room_name: String,
    pub message_id: String,
    pub thread_id: Option<String>,
    pub author: String,
    pub text: Option<String>,
    pub has_attachment: bool,
}

impl Draft {
    /// A message row of the open room.
    pub fn of(row: &rv_core::store::MessageRow, room_name: &str) -> Self {
        Draft {
            rid: row.rid.clone(),
            room_name: room_name.to_owned(),
            message_id: row.id.clone(),
            thread_id: row.thread_id.clone(),
            author: row.author.clone().filter(|a| !a.is_empty()).unwrap_or_else(|| row.author_id.clone()),
            text: row.text.clone(),
            has_attachment: row.attachments.as_deref().is_some_and(|a| a.trim_start().starts_with('[') && a.len() > 2),
        }
    }

    fn reminder(&self, due: i64) -> Reminder {
        Reminder::about(
            &self.rid,
            &self.room_name,
            &self.message_id,
            self.thread_id.as_deref(),
            &self.author,
            self.text.as_deref(),
            self.has_attachment,
            due,
            Utc::now().timestamp(),
        )
    }
}

/// Whether a message row can carry a reminder: a sent message, not a system line.
pub fn offered(row: &rv_core::store::MessageRow) -> bool {
    row.outbox_status.is_none() && row.system_type.is_none() && !row.id.is_empty()
}

/// The message menu's entry: "Remind me", which swaps the menu for its
/// choices, or "Cancel reminder (<when>)" while one is pending.
pub fn menu_item(popover: &gtk::Popover, info: &SessionInfo, draft: Draft, toast: Rc<dyn Fn(String)>) -> gtk::Button {
    let pending = store().get(info, &draft.message_id);
    let label = pending.as_ref().map_or_else(|| t("reminders.remind_me").to_owned(), reminders::cancel_label);
    let button = gtk::Button::builder().css_classes(["flat", "menu-action", "reminder-action"]).build();
    button.set_child(Some(&gtk::Label::builder().label(&label).xalign(0.0).build()));
    let (popover, info) = (popover.clone(), info.clone());
    button.connect_clicked(move |_| {
        if pending.is_some() {
            popover.popdown();
            match store().cancel(&info, &draft.message_id) {
                Ok(_) => toast(t("reminders.cancelled").to_owned()),
                Err(_) => toast(t("reminders.not_saved").to_owned()),
            }
            changed();
            return;
        }
        popover.set_child(Some(&choices(&popover, &info, &draft, &toast)));
    });
    button
}

/// In 1 hour, in 3 hours, tomorrow at 09:00, or a time to pick. A click
/// outside the menu closes it with nothing set.
fn choices(popover: &gtk::Popover, info: &SessionInfo, draft: &Draft, toast: &Rc<dyn Fn(String)>) -> gtk::Box {
    let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).build();
    column.append(
        &gtk::Label::builder()
            .label(t("reminders.remind_me"))
            .xalign(0.0)
            .css_classes(["heading", "scheduled-title"])
            .build(),
    );
    for key in ["reminders.in_hour", "reminders.in_three_hours", "reminders.tomorrow", "reminders.pick"] {
        let button = gtk::Button::builder().css_classes(["flat", "menu-action", "reminder-choice"]).build();
        button.set_child(Some(&gtk::Label::builder().label(t(key)).xalign(0.0).build()));
        let (popover, info, draft, toast) = (popover.clone(), info.clone(), draft.clone(), toast.clone());
        button.connect_clicked(move |_| {
            let parent = popover.parent();
            popover.popdown();
            let now = Utc::now();
            let due = match key {
                "reminders.in_hour" => reminders::in_hours(now, 1),
                "reminders.in_three_hours" => reminders::in_hours(now, 3),
                "reminders.tomorrow" => reminders::tomorrow_at_nine(&Local::now()),
                _ => {
                    let Some(parent) = parent else { return };
                    let (info, draft, toast) = (info.clone(), draft.clone(), toast.clone());
                    pick(&parent, move |at| set(&info, &draft, at.timestamp(), &toast));
                    return;
                }
            };
            set(&info, &draft, due.timestamp(), &toast);
        });
        column.append(&button);
    }
    column
}

/// Stores the reminder and says when it will come.
pub fn set(info: &SessionInfo, draft: &Draft, due: i64, toast: &Rc<dyn Fn(String)>) {
    match store().set(info, draft.reminder(due)) {
        Ok(()) => toast(reminders::notice(due)),
        Err(_) => toast(t("reminders.not_saved").to_owned()),
    }
    poke();
    changed();
}

/// "Pick a time": a date and a time, at least a minute and at most a year ahead.
fn pick(parent: &gtk::Widget, chosen: impl Fn(chrono::DateTime<Utc>) + 'static) {
    crate::scheduled::pick_time(
        parent,
        crate::scheduled::PickWords {
            heading: t("reminders.pick"),
            hint: t("reminders.pick_hint"),
            cancel: t("reminders.cancel"),
            confirm: t("reminders.remind_me"),
        },
        reminders::accepted,
        chosen,
    );
}

/// The Reminders list of the account menu: the account's pending ones,
/// soonest first, with when, the room, the author and the excerpt; a row
/// opens its message, Cancel removes it. A click outside closes it.
pub fn list(parent: &impl IsA<gtk::Widget>, info: SessionInfo, open: Rc<dyn Fn(Reminder)>) -> adw::Dialog {
    let dialog = adw::Dialog::builder().title(t("reminders.title")).content_width(440).content_height(520).build();
    dialog.add_css_class("reminders-dialog");
    let rows = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(6)
        .margin_top(12)
        .margin_bottom(12)
        .margin_start(12)
        .margin_end(12)
        .build();
    let scroll =
        gtk::ScrolledWindow::builder().hscrollbar_policy(gtk::PolicyType::Never).vexpand(true).child(&rows).build();
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(&scroll));
    dialog.set_child(Some(&view));
    let filler: Rc<dyn Fn()> = {
        let (rows, dialog) = (rows.clone(), dialog.downgrade());
        Rc::new(move || {
            while let Some(child) = rows.first_child() {
                rows.remove(&child);
            }
            let pending = store().pending(&info);
            if pending.is_empty() {
                rows.append(
                    &gtk::Label::builder()
                        .label(t("reminders.empty"))
                        .margin_top(24)
                        .css_classes(["dim-label", "reminders-empty"])
                        .build(),
                );
            }
            for reminder in pending {
                rows.append(&row(&reminder, &info, &dialog, &open));
            }
        })
    };
    filler();
    // The list follows what fires or changes while it is open.
    let refresh = Rc::downgrade(&filler);
    let watch = connect_changed(move || {
        if let Some(fill) = refresh.upgrade() {
            fill();
        }
    });
    // The dialog keeps its rows' filler alive while it is open.
    let kept = RefCell::new(Some(filler));
    dialog.connect_closed(move |_| {
        disconnect_changed(watch);
        kept.take();
    });
    crate::widgets::present(&dialog, Some(parent));
    dialog
}

fn row(
    reminder: &Reminder,
    info: &SessionInfo,
    dialog: &glib::WeakRef<adw::Dialog>,
    open: &Rc<dyn Fn(Reminder)>,
) -> gtk::Box {
    let line = gtk::Box::builder().spacing(10).css_classes(["scheduled-row", "reminder-row"]).build();
    let text = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).hexpand(true).build();
    text.append(&gtk::Label::builder().label(reminder.when()).xalign(0.0).css_classes(["scheduled-when"]).build());
    text.append(
        &gtk::Label::builder()
            .label(format!("{} · {}", reminder.room_name, reminder.author))
            .xalign(0.0)
            .ellipsize(gtk::pango::EllipsizeMode::End)
            .css_classes(["dim-label"])
            .build(),
    );
    text.append(
        &gtk::Label::builder()
            .label(&reminder.excerpt)
            .xalign(0.0)
            .wrap(true)
            .wrap_mode(gtk::pango::WrapMode::WordChar)
            .lines(2)
            .ellipsize(gtk::pango::EllipsizeMode::End)
            .max_width_chars(48)
            .css_classes(["scheduled-text"])
            .build(),
    );
    let go = gtk::Button::builder().child(&text).hexpand(true).css_classes(["flat", "reminder-open"]).build();
    let (dialog_, open, target) = (dialog.clone(), open.clone(), reminder.clone());
    go.connect_clicked(move |_| {
        if let Some(dialog) = dialog_.upgrade() {
            dialog.close();
        }
        open(target.clone());
    });
    line.append(&go);
    let cancel = gtk::Button::builder()
        .label(t("reminders.cancel"))
        .valign(gtk::Align::Center)
        .css_classes(["flat", "reminder-cancel"])
        .build();
    let (info, id) = (info.clone(), reminder.message_id.clone());
    cancel.connect_clicked(move |_| {
        let _ = store().cancel(&info, &id);
        // The open list redraws through `changed`.
        changed();
    });
    line.append(&cancel);
    line
}
