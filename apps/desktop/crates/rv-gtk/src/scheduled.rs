//! Scheduled messages on a RocketVibe server (`scheduled_messages`): the
//! "Send later" menu by the send button, the "N scheduled" chip above the
//! composer and the list it opens. The rule every app follows is in
//! `brain/features/scheduled-messages.md`; times and words come from
//! `rv_core::native::scheduled`.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use chrono::{DateTime, Datelike, Local, TimeZone, Timelike, Utc};
use gtk::glib;
use rv_core::native::{NativeSession, scheduled};

use crate::i18n::{t, tn};
use crate::on_tokio;

/// How often the list is read again while its room shows: a sent one leaves silently.
const REFRESH_SECONDS: u32 = 60;

/// One composer's scheduled messages: its room's (or its thread's only).
pub struct Scheduler {
    pub session: Arc<NativeSession>,
    pub room: String,
    pub root: Option<String>,
    chip: gtk::Button,
    /// The composer: the list is read again only while it is on screen.
    host: gtk::Widget,
    items: RefCell<Vec<scheduled::ScheduledMessage>>,
    /// Reads in flight: only the latest one's answer is shown.
    reads: Cell<u64>,
    timer: RefCell<Option<glib::SourceId>>,
    mapped: RefCell<Option<glib::SignalHandlerId>>,
    /// The open list, rebuilt when a read changes it.
    list: RefCell<Option<(gtk::Popover, gtk::Box)>>,
    report: Rc<dyn Fn(String)>,
}

impl Drop for Scheduler {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.remove();
        }
        if let Some(handler) = self.mapped.take() {
            self.host.disconnect(handler);
        }
        if let Some((popover, _)) = self.list.take() {
            popover.popdown();
        }
        self.chip.set_visible(false);
    }
}

impl Scheduler {
    pub fn new(
        session: Arc<NativeSession>,
        room: &str,
        root: Option<&str>,
        chip: &gtk::Button,
        host: &gtk::Widget,
        report: Rc<dyn Fn(String)>,
    ) -> Rc<Self> {
        let this = Rc::new(Scheduler {
            session,
            room: room.to_owned(),
            root: root.map(str::to_owned),
            chip: chip.clone(),
            host: host.clone(),
            items: RefCell::default(),
            reads: Cell::new(0),
            timer: RefCell::default(),
            mapped: RefCell::default(),
            list: RefCell::default(),
            report,
        });
        this.chip.set_visible(false);
        let weak = Rc::downgrade(&this);
        let timer = glib::timeout_add_seconds_local(REFRESH_SECONDS, move || {
            let Some(this) = weak.upgrade() else { return glib::ControlFlow::Break };
            if this.host.is_mapped() {
                this.refresh();
            }
            glib::ControlFlow::Continue
        });
        this.timer.replace(Some(timer));
        // Back on screen (a thread closed over the room): read it again.
        let weak = Rc::downgrade(&this);
        let mapped = host.connect_map(move |_| {
            if let Some(this) = weak.upgrade() {
                this.refresh();
            }
        });
        this.mapped.replace(Some(mapped));
        this.refresh();
        this
    }

    /// Reads the list from the server and shows it.
    pub fn refresh(self: &Rc<Self>) {
        let read = self.reads.get().wrapping_add(1);
        self.reads.set(read);
        let (weak, session, room) = (Rc::downgrade(self), self.session.clone(), self.room.clone());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { session.scheduled_messages(&room).await }).await;
            let Some(this) = weak.upgrade() else { return };
            if this.reads.get() != read {
                return;
            }
            // Offline or refused: the last list stays.
            if let Ok(list) = result {
                let root = this.root.clone();
                this.items.replace(list.into_iter().filter(|m| root.is_none() || m.reply_to == root).collect());
                this.show();
            }
        });
    }

    fn show(self: &Rc<Self>) {
        let count = self.items.borrow().len();
        self.chip.set_label(&tn("scheduled.chip", count as i64));
        self.chip.set_visible(count > 0);
        let open = self.list.borrow().clone();
        if let Some((popover, rows)) = open {
            if count == 0 {
                popover.popdown();
            } else {
                self.fill(&rows);
            }
        }
    }

    /// The scheduled messages here: time, text, and Cancel; a failed one says
    /// it could not be sent (and why) and offers Remove.
    pub fn open_list(self: &Rc<Self>) {
        if let Some((popover, _)) = self.list.borrow().as_ref() {
            popover.popup();
            return;
        }
        let rows = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).build();
        let scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_height(true)
            .max_content_height(360)
            .min_content_width(320)
            .child(&rows)
            .build();
        let panel = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).build();
        panel.append(
            &gtk::Label::builder()
                .label(t("scheduled.title"))
                .xalign(0.0)
                .css_classes(["heading", "scheduled-title"])
                .build(),
        );
        panel.append(&scroll);
        // A popover closes on a click outside, with nothing cancelled.
        let popover = gtk::Popover::builder()
            .child(&panel)
            .position(gtk::PositionType::Top)
            .css_classes(["scheduled-list"])
            .build();
        popover.set_parent(&self.chip);
        let weak = Rc::downgrade(self);
        popover.connect_closed(move |popover| {
            popover.unparent();
            if let Some(this) = weak.upgrade() {
                this.list.replace(None);
            }
        });
        self.list.replace(Some((popover.clone(), rows.clone())));
        self.fill(&rows);
        popover.popup();
        self.refresh();
    }

    fn fill(self: &Rc<Self>, rows: &gtk::Box) {
        while let Some(child) = rows.first_child() {
            rows.remove(&child);
        }
        let items = self.items.borrow().clone();
        if items.is_empty() {
            rows.append(
                &gtk::Label::builder().label(t("scheduled.empty")).xalign(0.0).css_classes(["dim-label"]).build(),
            );
            return;
        }
        let now = Local::now();
        for item in items {
            let failed = item.state == scheduled::ScheduledState::Failed;
            let row = gtk::Box::builder().spacing(10).css_classes(["scheduled-row"]).build();
            let text = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).hexpand(true).build();
            let when = scheduled::send_at(&item).map(|at| scheduled::when(at, &now)).unwrap_or(item.send_at.clone());
            let mut heading = when;
            if failed {
                heading = t("scheduled.failed").to_owned();
                if let Some(reason) = scheduled::failure_key(item.error.as_deref()) {
                    heading = format!("{heading}: {}", t(reason));
                }
            } else if item.reply_to.is_some() && self.root.is_none() {
                heading = format!("{heading} · {}", t("scheduled.thread"));
            }
            let mut classes = vec!["scheduled-when"];
            if failed {
                classes.push("error");
            }
            text.append(&gtk::Label::builder().label(&heading).xalign(0.0).wrap(true).css_classes(classes).build());
            text.append(
                &gtk::Label::builder()
                    .label(&item.text)
                    .xalign(0.0)
                    .wrap(true)
                    .wrap_mode(gtk::pango::WrapMode::WordChar)
                    .lines(2)
                    .ellipsize(gtk::pango::EllipsizeMode::End)
                    .max_width_chars(48)
                    .css_classes(["scheduled-text"])
                    .build(),
            );
            row.append(&text);
            let action = gtk::Button::builder()
                .label(t(if failed { "scheduled.remove" } else { "scheduled.cancel" }))
                .valign(gtk::Align::Center)
                .css_classes(["flat"])
                .build();
            let (weak, id) = (Rc::downgrade(self), item.id.clone());
            action.connect_clicked(move |button| {
                if let Some(this) = weak.upgrade() {
                    button.set_sensitive(false);
                    this.cancel(id.clone());
                }
            });
            row.append(&action);
            rows.append(&row);
        }
    }

    fn cancel(self: &Rc<Self>, id: String) {
        let (weak, session) = (Rc::downgrade(self), self.session.clone());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { session.cancel_scheduled(&id).await }).await;
            let Some(this) = weak.upgrade() else { return };
            if let Err(error) = result {
                (this.report)(t(scheduled::error_key(error.code())).to_owned());
            }
            this.refresh();
        });
    }

    /// Schedules `text` at `at`; `done` runs on success, the list is read again.
    pub fn schedule(self: &Rc<Self>, text: String, at: DateTime<Utc>, done: impl FnOnce() + 'static) {
        let (weak, session, room, root) =
            (Rc::downgrade(self), self.session.clone(), self.room.clone(), self.root.clone());
        glib::spawn_future_local(async move {
            let result =
                on_tokio(async move { session.schedule_message(&room, root.as_deref(), &text, at).await }).await;
            let Some(this) = weak.upgrade() else { return };
            match result {
                Ok(made) => {
                    done();
                    (this.report)(scheduled::scheduled_notice(scheduled::send_at(&made).unwrap_or(at)));
                }
                Err(error) => (this.report)(t(scheduled::error_key(error.code())).to_owned()),
            }
            this.refresh();
        });
    }
}

/// The "Send later" choices, under the chevron by the send button.
pub fn menu(button: &gtk::MenuButton, choose: impl Fn(Choice) + 'static) {
    let list = gtk::Box::builder().orientation(gtk::Orientation::Vertical).build();
    list.append(
        &gtk::Label::builder()
            .label(t("scheduled.send_later"))
            .xalign(0.0)
            .css_classes(["heading", "scheduled-title"])
            .build(),
    );
    let popover = gtk::Popover::builder().child(&list).position(gtk::PositionType::Top).build();
    let choose = Rc::new(choose);
    for (key, choice) in [
        ("scheduled.in_hour", Choice::InOneHour),
        ("scheduled.tomorrow_morning", Choice::TomorrowMorning),
        ("scheduled.pick", Choice::Pick),
    ] {
        let item = gtk::Button::builder()
            .child(&gtk::Label::builder().label(t(key)).xalign(0.0).build())
            .css_classes(["flat"])
            .build();
        let (popover, choose) = (popover.clone(), choose.clone());
        item.connect_clicked(move |_| {
            popover.popdown();
            choose(choice);
        });
        list.append(&item);
    }
    button.set_popover(Some(&popover));
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    InOneHour,
    TomorrowMorning,
    Pick,
}

/// "Pick a time": a date and a time, at least a minute and at most 30 days
/// ahead. A click outside closes it with nothing scheduled.
pub fn pick(parent: &gtk::Widget, chosen: impl Fn(DateTime<Utc>) + 'static) {
    // An hour from now, on the next quarter.
    let start = Local::now() + chrono::Duration::hours(1);
    let start = start + chrono::Duration::minutes(i64::from((15 - start.minute() % 15) % 15));
    let calendar = gtk::Calendar::new();
    if let Ok(day) = glib::DateTime::from_local(start.year(), start.month() as i32, start.day() as i32, 0, 0, 0.0) {
        calendar.select_day(&day);
    }
    let hour = two_digits(23, start.hour());
    let minute = two_digits(59, start.minute());
    let clock = gtk::Box::builder().spacing(6).halign(gtk::Align::Center).build();
    clock.append(&gtk::Label::new(Some(t("scheduled.time"))));
    clock.append(&hour);
    clock.append(&gtk::Label::new(Some(":")));
    clock.append(&minute);
    let content = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(10).build();
    content.append(&calendar);
    content.append(&clock);
    let alert = adw::AlertDialog::builder()
        .heading(t("scheduled.pick"))
        .body(t("scheduled.pick_hint"))
        .extra_child(&content)
        .default_response("schedule")
        .close_response("cancel")
        .css_classes(["alert", "scheduled-pick"])
        .build();
    alert.add_responses(&[("cancel", t("scheduled.cancel")), ("schedule", t("scheduled.schedule"))]);
    alert.set_response_appearance("schedule", adw::ResponseAppearance::Suggested);
    let instant = {
        let (calendar, hour, minute) = (calendar.clone(), hour.clone(), minute.clone());
        Rc::new(move || {
            let day = calendar.date();
            chrono::NaiveDate::from_ymd_opt(day.year(), day.month() as u32, day.day_of_month() as u32)
                .and_then(|date| date.and_hms_opt(hour.value_as_int() as u32, minute.value_as_int() as u32, 0))
                .and_then(|naive| Local.from_local_datetime(&naive).earliest())
                .map(|at| at.with_timezone(&Utc))
        })
    };
    let check = {
        let (alert, instant) = (alert.downgrade(), instant.clone());
        Rc::new(move || {
            if let Some(alert) = alert.upgrade() {
                let valid = instant().is_some_and(|at| scheduled::accepted(at, Utc::now()));
                alert.set_response_enabled("schedule", valid);
            }
        })
    };
    let c = check.clone();
    calendar.connect_day_selected(move |_| c());
    let c = check.clone();
    hour.connect_value_changed(move |_| c());
    let c = check.clone();
    minute.connect_value_changed(move |_| c());
    check();
    alert.connect_response(Some("schedule"), move |_, _| {
        if let Some(at) = instant() {
            chosen(at);
        }
    });
    crate::widgets::present(&alert, Some(parent));
}

/// A 00 to `max` spin button that shows two digits.
fn two_digits(max: u32, value: u32) -> gtk::SpinButton {
    let spin = gtk::SpinButton::with_range(0.0, f64::from(max), 1.0);
    spin.set_wrap(true);
    spin.set_numeric(true);
    spin.set_width_chars(2);
    spin.set_value(f64::from(value.min(max)));
    spin.connect_output(|spin| {
        spin.set_text(&format!("{:02}", spin.value_as_int()));
        glib::Propagation::Stop
    });
    spin
}

/// The instant a choice of the menu stands for (None: "Pick a time" asks).
pub fn instant(choice: Choice) -> Option<DateTime<Utc>> {
    match choice {
        Choice::InOneHour => Some(scheduled::in_one_hour(Utc::now())),
        Choice::TomorrowMorning => Some(scheduled::tomorrow_morning(&Local::now())),
        Choice::Pick => None,
    }
}
