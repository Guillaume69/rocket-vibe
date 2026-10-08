//! Workflows (RFC 0004, `docs/protocol/WORKFLOWS.md`): my workflows, each a
//! trigger and steps acting through one of my bots, with a simple editor
//! (no canvas), its run history, and a webhook URL shown once, in a dialog,
//! and never kept.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::native::NativeSession;
use rv_core::native::bots::Bot;
use rv_core::native::workflows::{
    self, Draft, Every, FormField, FormFieldKind, FormRecipient, HttpHeader, HttpMethod, PEOPLE_PER_FIELD, RoomChoice,
    Step, TRIGGER_ROOM, Trigger, WaitUnit, Workflow,
};

use super::native_bots::{Rows, active_window, copyable};
use crate::admin::{confirm_class, date_time, spawn};
use crate::i18n::{t, tf};
use crate::on_tokio;
use crate::sidebar_dialog::Host;
use crate::widgets;

fn error_text(error: &rv_core::native::Error) -> &'static str {
    t(workflows::failure_key(error))
}

/// The page's state, shared by the editors it opens.
#[derive(Clone)]
struct Ctx {
    host: Host,
    session: Arc<NativeSession>,
    list: Rc<Rows>,
    /// My bots, from the last load: the editor's bot picker.
    bots: Rc<RefCell<Vec<Bot>>>,
    /// The Security category, where a recent sign-in is made; None without one.
    security: Option<&'static str>,
}

fn confirm(host: &Host, heading: &str, body: &str, action: &str, run: impl Fn() + 'static) {
    confirm_class(host, heading, body, action, "workflow-confirm", run);
}

/// The Workflows category: my workflows, then "Create a workflow" when I may.
pub(super) fn page(host: &Host, session: Arc<NativeSession>, security: Option<&'static str>) -> adw::PreferencesPage {
    let page = adw::PreferencesPage::new();
    page.add_css_class("native-workflows");
    let group = adw::PreferencesGroup::builder().title(t("workflows.title")).description(t("workflows.intro")).build();
    let refresh = gtk::Button::builder()
        .icon_name("view-refresh-symbolic")
        .tooltip_text(t("security.refresh"))
        .valign(gtk::Align::Center)
        .css_classes(["flat"])
        .build();
    group.set_header_suffix(Some(&refresh));
    page.add(&group);
    let ctx = Ctx { host: host.clone(), session, list: Rows::new(&group), bots: Rc::default(), security };
    let again = ctx.clone();
    refresh.connect_clicked(move |_| reload(&again));
    reload(&ctx);
    page
}

/// Reads my workflows, my bots and whether I may create a workflow again.
fn reload(ctx: &Ctx) {
    ctx.list.clear();
    ctx.list.note(t("workflows.loading"));
    let s = ctx.session.clone();
    let c = ctx.clone();
    spawn(
        &ctx.host,
        async move {
            let mine = s.workflows().await;
            let can = s.can_create_workflow().await.unwrap_or(false);
            let bots = s.bots().await.unwrap_or_default();
            (mine, can, bots)
        },
        move |(mine, can, bots)| {
            c.bots.replace(bots.into_iter().filter(|b| !b.disabled).collect());
            c.list.clear();
            match mine {
                Err(error) => c.list.note(error_text(&error)),
                Ok(mine) => {
                    if mine.is_empty() {
                        c.list.note(t("workflows.empty"));
                    }
                    for workflow in mine {
                        c.list.add(&workflow_row(&c, workflow));
                    }
                }
            }
            if !can {
                c.list.note(t("workflows.closed"));
            } else if c.bots.borrow().is_empty() {
                c.list.note(t("workflows.no_bot"));
            } else {
                let create =
                    adw::ButtonRow::builder().title(t("workflows.create")).start_icon_name("list-add-symbolic").build();
                create.add_css_class("workflow-create");
                let again = c.clone();
                create.connect_activated(move |_| editor(&again, None));
                c.list.add(&create);
            }
        },
    );
}

fn room_label(ctx: &Ctx) -> impl Fn(&str) -> String + 'static {
    let s = ctx.session.clone();
    move |id: &str| s.workflow_room_label(id)
}

fn workflow_row(ctx: &Ctx, workflow: Workflow) -> adw::ActionRow {
    let summary = workflows::trigger_summary(&workflow.trigger, &room_label(ctx));
    let run = workflow.last_run.as_ref().map_or_else(
        || t("workflows.never_run").to_owned(),
        |run| tf("workflows.last_run", &[("run", &workflows::run_text(run))]),
    );
    let row = adw::ActionRow::builder()
        .title(&workflow.name)
        .subtitle(format!("{summary}\n{run}"))
        .subtitle_lines(3)
        .use_markup(false)
        .activatable(true)
        .build();
    row.add_css_class("workflow-row");
    let state = if workflow.enabled {
        widgets::badge(t("workflows.on"), "workflow-on")
    } else {
        widgets::badge(t("workflows.off"), "deactivated")
    };
    row.add_suffix(&state);
    row.add_suffix(&gtk::Image::from_icon_name("go-next-symbolic"));
    let c = ctx.clone();
    row.connect_activated(move |_| editor(&c, Some(workflow.clone())));
    row
}

/// A template field the Variables menu writes into.
#[derive(Clone)]
/// Weak: the field's own handlers hold it.
enum Field {
    Line(glib::WeakRef<gtk::Editable>),
    Text(glib::WeakRef<gtk::TextView>),
}

impl Field {
    fn line(editable: &impl IsA<gtk::Editable>) -> Self {
        Field::Line(editable.upcast_ref::<gtk::Editable>().downgrade())
    }
    fn text(view: &gtk::TextView) -> Self {
        Field::Text(view.downgrade())
    }
    fn insert(&self, text: &str) {
        match self {
            Field::Line(editable) => {
                let Some(editable) = editable.upgrade() else { return };
                let mut position = editable.position();
                editable.insert_text(text, &mut position);
                editable.set_position(position);
                editable.grab_focus();
            }
            Field::Text(view) => {
                let Some(view) = view.upgrade() else { return };
                view.buffer().insert_at_cursor(text);
                view.grab_focus();
            }
        }
    }
}

/// The template field of a step chosen last, where a variable goes.
type Target = Rc<RefCell<Option<Field>>>;

/// Remembers `field` as the step's target when it takes the focus.
fn follow(widget: &impl IsA<gtk::Widget>, target: &Target, field: Field) {
    let focus = gtk::EventControllerFocus::new();
    let (target, chosen) = (target.clone(), RefCell::new(Some(field)));
    focus.connect_enter(move |_| {
        if let Some(field) = chosen.borrow().clone() {
            target.replace(Some(field));
        }
    });
    widget.add_controller(focus);
}

/// One open editor: the definition being edited and its page.
struct Editor {
    ctx: Ctx,
    /// None until the workflow is created.
    id: Option<String>,
    revision: String,
    has_webhook: bool,
    draft: RefCell<Draft>,
    /// Weak, like every widget here: the widgets' handlers hold the editor.
    page: glib::WeakRef<adw::PreferencesPage>,
    trigger_rows: Rc<Rows>,
    steps: RefCell<Vec<glib::WeakRef<adw::PreferencesGroup>>>,
    /// The groups after the steps, put back after them on each rebuild.
    tail: RefCell<Vec<glib::WeakRef<adw::PreferencesGroup>>>,
    rooms: Vec<RoomChoice>,
    enabled: glib::WeakRef<adw::SwitchRow>,
    /// The run history's rows, for a saved workflow.
    runs: RefCell<Option<Rc<Rows>>>,
    /// Everyone a person field may list, read as the editor opens.
    people: RefCell<Vec<workflows::User>>,
    shown: RefCell<glib::WeakRef<adw::NavigationPage>>,
}

type Ed = Rc<Editor>;

/// Opens the editor of `workflow`, or of a new one.
fn editor(ctx: &Ctx, workflow: Option<Workflow>) {
    open_editor(ctx, workflow);
}

fn open_editor(ctx: &Ctx, workflow: Option<Workflow>) -> Ed {
    let first_bot = ctx.bots.borrow().first().map(|b| b.user.id.clone()).unwrap_or_default();
    let draft = workflow.as_ref().map_or_else(|| Draft::new(&first_bot), Draft::of);
    let page = adw::PreferencesPage::new();
    page.add_css_class("native-workflow");
    let trigger = adw::PreferencesGroup::builder().title(t("workflows.trigger")).build();
    let ed = Rc::new(Editor {
        ctx: ctx.clone(),
        id: workflow.as_ref().map(|w| w.id.clone()),
        revision: workflow.as_ref().map(|w| w.revision.clone()).unwrap_or_default(),
        has_webhook: workflow.as_ref().is_some_and(|w| w.has_webhook),
        draft: RefCell::new(draft),
        page: page.downgrade(),
        trigger_rows: Rows::new(&trigger),
        steps: RefCell::default(),
        tail: RefCell::default(),
        rooms: ctx.session.workflow_rooms(),
        enabled: glib::WeakRef::new(),
        runs: RefCell::default(),
        people: RefCell::default(),
        shown: RefCell::default(),
    });
    page.add(&general_group(&ed, workflow.as_ref()));
    trigger_group(&ed, &trigger);
    page.add(&trigger);
    let mut tail = vec![add_step_group(&ed), actions_group(&ed, workflow.as_ref())];
    if ed.id.is_some() {
        tail.push(runs_group(&ed));
        tail.push(danger_group(&ed, workflow.as_ref().map_or("", |w| w.name.as_str())));
    }
    ed.tail.replace(tail.iter().map(|g| g.downgrade()).collect());
    // `tail` keeps them until the page holds them.
    rebuild_steps(&ed);
    let title = workflow.as_ref().map_or_else(|| t("workflows.new").to_owned(), |w| w.name.clone());
    let shown = ctx.host.push(&title, &page);
    ed.shown.borrow().set(Some(&shown));
    let (s, e) = (ctx.session.clone(), ed.clone());
    spawn(&ctx.host, async move { s.workflow_people().await }, move |people| {
        let Ok(people) = people else { return };
        e.people.replace(people);
        // The person fields' rows can now name people and offer them.
        let named = e.draft.borrow().steps.iter().any(
            |step| matches!(step, Step::Form { fields, .. } if fields.iter().any(|f| f.kind == FormFieldKind::Person)),
        );
        if named {
            rebuild_steps(&e);
        }
    });
    ed
}

/// Closes this editor when it is the page in front.
fn close(ed: &Ed) {
    if let Some(shown) = ed.shown.borrow().upgrade() {
        ed.ctx.host.pop_if(&shown);
    }
}

fn entry(title: &str, text: &str, class: &str) -> adw::EntryRow {
    let row = adw::EntryRow::builder().title(title).text(text).build();
    row.add_css_class(class);
    row
}

fn combo(title: &str, names: &[&str], selected: usize, class: &str) -> adw::ComboRow {
    let row = adw::ComboRow::builder()
        .title(title)
        .model(&gtk::StringList::new(names))
        .selected(selected.min(names.len().saturating_sub(1)) as u32)
        .build();
    row.add_css_class(class);
    row
}

fn switch(title: &str, active: bool, class: &str) -> adw::SwitchRow {
    let row = adw::SwitchRow::builder().title(title).active(active).build();
    row.add_css_class(class);
    row
}

fn button_row(title: &str, classes: &[&str]) -> adw::ButtonRow {
    let row = adw::ButtonRow::builder().title(title).build();
    for class in classes {
        row.add_css_class(class);
    }
    row
}

/// A titled multi-line text, for a message or a body.
fn text_area(title: &str, text: &str, class: &str) -> (adw::PreferencesRow, gtk::TextView) {
    let view = gtk::TextView::builder()
        .wrap_mode(gtk::WrapMode::WordChar)
        .accepts_tab(false)
        .top_margin(6)
        .bottom_margin(6)
        .left_margin(6)
        .right_margin(6)
        .height_request(72)
        .build();
    view.add_css_class(class);
    view.buffer().set_text(text);
    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(4)
        .margin_top(8)
        .margin_bottom(8)
        .margin_start(12)
        .margin_end(12)
        .build();
    column.append(&gtk::Label::builder().label(title).xalign(0.0).css_classes(["caption", "dim-label"]).build());
    let frame = gtk::Frame::builder().child(&view).build();
    column.append(&frame);
    let row = adw::PreferencesRow::builder().activatable(false).focusable(false).child(&column).build();
    (row, view)
}

fn on_text(view: &gtk::TextView, changed: impl Fn(String) + 'static) {
    view.buffer().connect_changed(move |buffer| {
        changed(buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string());
    });
}

/// Applies `change` to the step at `index`, when it is still there.
fn with_step(ed: &Ed, index: usize, change: impl FnOnce(&mut Step)) {
    if let Some(step) = ed.draft.borrow_mut().steps.get_mut(index) {
        change(step);
    }
}

/// Name, description, bot and the enabled switch.
fn general_group(ed: &Ed, workflow: Option<&Workflow>) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::new();
    let draft = ed.draft.borrow().clone();
    let name = entry(t("workflows.name"), &draft.name, "workflow-name");
    let e = ed.clone();
    name.connect_changed(move |row| e.draft.borrow_mut().name = row.text().to_string());
    group.add(&name);
    let description = entry(t("workflows.description"), &draft.description, "workflow-description");
    let e = ed.clone();
    description.connect_changed(move |row| e.draft.borrow_mut().description = row.text().to_string());
    group.add(&description);
    let mut bots: Vec<(String, String)> = ed
        .ctx
        .bots
        .borrow()
        .iter()
        .map(|b| (b.user.id.clone(), format!("{} (@{})", b.user.display_name, b.user.username)))
        .collect();
    if let Some(w) = workflow
        && !bots.iter().any(|(id, _)| *id == w.bot.id)
    {
        bots.push((w.bot.id.clone(), format!("@{}", w.bot.username)));
    }
    let names: Vec<&str> = bots.iter().map(|(_, name)| name.as_str()).collect();
    let selected = bots.iter().position(|(id, _)| *id == draft.bot_id).unwrap_or(0);
    let bot = combo(t("workflows.bot"), &names, selected, "workflow-bot");
    let e = ed.clone();
    bot.connect_selected_notify(move |row| {
        if let Some((id, _)) = bots.get(row.selected() as usize) {
            e.draft.borrow_mut().bot_id = id.clone();
        }
    });
    group.add(&bot);
    let enabled = switch(t("workflows.enabled"), draft.enabled, "workflow-enabled");
    let e = ed.clone();
    enabled.connect_active_notify(move |row| e.draft.borrow_mut().enabled = row.is_active());
    group.add(&enabled);
    ed.enabled.set(Some(&enabled));
    if let Some(at) = workflow.and_then(|w| w.next_fire_at.as_deref()) {
        group.set_description(Some(&tf("workflows.next_fire", &[("at", &date_time(at))])));
    }
    group
}

/// The rooms to pick from: "the trigger's room" first when it may be one,
/// then my plaintext rooms, and the current choice even when I do not see it.
fn room_options(ed: &Ed, current: &str, trigger_room: bool) -> Vec<(String, String)> {
    let mut options = Vec::new();
    if current.is_empty() {
        options.push((String::new(), t("workflows.room_none").to_owned()));
    }
    if trigger_room {
        options.push((TRIGGER_ROOM.to_owned(), t("workflows.room_trigger").to_owned()));
    }
    options.extend(ed.rooms.iter().map(|r| (r.id.clone(), r.label.clone())));
    if !current.is_empty() && !options.iter().any(|(id, _)| id == current) {
        options.push((current.to_owned(), ed.ctx.session.workflow_room_label(current)));
    }
    options
}

fn room_combo(ed: &Ed, current: &str, trigger_room: bool, changed: impl Fn(String) + 'static) -> adw::ComboRow {
    let options = room_options(ed, current, trigger_room);
    let names: Vec<&str> = options.iter().map(|(_, label)| label.as_str()).collect();
    let selected = options.iter().position(|(id, _)| id == current).unwrap_or(0);
    let row = combo(t("workflows.room"), &names, selected, "workflow-room");
    row.set_subtitle(t("workflows.room_hint"));
    row.connect_selected_notify(move |row| {
        if let Some((id, _)) = options.get(row.selected() as usize) {
            changed(id.clone());
        }
    });
    row
}

/// The trigger's kind, then its own settings below it (`trigger_rows`).
fn trigger_group(ed: &Ed, group: &adw::PreferencesGroup) {
    let current = workflows::trigger_kind(&ed.draft.borrow().trigger);
    let names: Vec<&str> =
        workflows::TRIGGER_KINDS.iter().map(|kind| t(&format!("workflows.trigger_kind.{kind}"))).collect();
    let selected = workflows::TRIGGER_KINDS.iter().position(|k| *k == current).unwrap_or(0);
    let kind = combo(t("workflows.trigger_kind"), &names, selected, "workflow-trigger-kind");
    group.add(&kind);
    let e = ed.clone();
    kind.connect_selected_notify(move |row| {
        let Some(kind) = workflows::TRIGGER_KINDS.get(row.selected() as usize) else { return };
        let next = workflows::new_trigger(kind, &e.draft.borrow().trigger);
        if let Some(next) = next {
            e.draft.borrow_mut().trigger = next;
            trigger_rows(&e);
            // What "the trigger's room" and the variables mean moved with it.
            rebuild_steps(&e);
        }
    });
    trigger_rows(ed);
}

/// The settings of the trigger's kind, rebuilt when the kind changes.
fn trigger_rows(ed: &Ed) {
    let rows = ed.trigger_rows.clone();
    rows.clear();
    let trigger = ed.draft.borrow().trigger.clone();
    match trigger {
        Trigger::Command { name } => {
            let row = entry(t("workflows.command_name"), &name, "workflow-command");
            row.add_prefix(&gtk::Label::new(Some("/")));
            let e = ed.clone();
            row.connect_changed(move |row| {
                if let Trigger::Command { name } = &mut e.draft.borrow_mut().trigger {
                    *name = row.text().to_string();
                }
            });
            rows.add(&row);
            rows.note(t("workflows.command_hint"));
        }
        Trigger::Schedule { every, time, days, timezone, room } => {
            schedule_rows(ed, &rows, every, &time, &days, &timezone, &room)
        }
        Trigger::MemberJoined { room } => {
            let e = ed.clone();
            rows.add(&room_combo(ed, &room, false, move |id| {
                if let Trigger::MemberJoined { room } = &mut e.draft.borrow_mut().trigger {
                    *room = id;
                }
            }));
        }
        Trigger::ReactionAdded { room, emoji } => {
            let e = ed.clone();
            rows.add(&room_combo(ed, &room, false, move |id| {
                if let Trigger::ReactionAdded { room, .. } = &mut e.draft.borrow_mut().trigger {
                    *room = id;
                }
            }));
            let row = entry(t("workflows.emoji"), emoji.as_deref().unwrap_or_default(), "workflow-emoji");
            row.add_prefix(&gtk::Label::new(Some(":")));
            row.add_suffix(&gtk::Label::new(Some(":")));
            let e = ed.clone();
            row.connect_changed(move |row| {
                let text = row.text().trim().trim_matches(':').to_owned();
                if let Trigger::ReactionAdded { emoji, .. } = &mut e.draft.borrow_mut().trigger {
                    *emoji = (!text.is_empty()).then_some(text);
                }
            });
            rows.add(&row);
            rows.note(t("workflows.emoji_hint"));
        }
        Trigger::MessagePosted { room, contains } => {
            let e = ed.clone();
            rows.add(&room_combo(ed, &room, false, move |id| {
                if let Trigger::MessagePosted { room, .. } = &mut e.draft.borrow_mut().trigger {
                    *room = id;
                }
            }));
            let row = entry(t("workflows.contains"), &contains, "workflow-contains");
            let e = ed.clone();
            row.connect_changed(move |row| {
                if let Trigger::MessagePosted { contains, .. } = &mut e.draft.borrow_mut().trigger {
                    *contains = row.text().to_string();
                }
            });
            rows.add(&row);
            rows.note(t("workflows.contains_hint"));
        }
        Trigger::Webhook {} => webhook_rows(ed, &rows),
    }
}

const EVERY: [Every; 3] = [Every::Hour, Every::Day, Every::Week];

#[allow(clippy::too_many_arguments)]
fn schedule_rows(ed: &Ed, rows: &Rc<Rows>, every: Every, time: &str, days: &[u8], timezone: &str, room: &str) {
    /// Changes the schedule in the draft.
    fn edit(ed: &Ed, change: impl FnOnce(&mut Every, &mut String, &mut Vec<u8>, &mut String)) {
        if let Trigger::Schedule { every, time, days, timezone, .. } = &mut ed.draft.borrow_mut().trigger {
            change(every, time, days, timezone);
        }
    }
    let (hour, minute) = workflows::time_parts(time).unwrap_or((9, 0));
    let names = [t("workflows.every.hour"), t("workflows.every.day"), t("workflows.every.week")];
    let repeat =
        combo(t("workflows.every"), &names, EVERY.iter().position(|e| *e == every).unwrap_or(1), "workflow-every");
    rows.add(&repeat);
    let hours = adw::SpinRow::with_range(0.0, 23.0, 1.0);
    hours.set_title(t("workflows.time"));
    hours.set_value(f64::from(hour));
    hours.set_visible(every != Every::Hour);
    hours.add_css_class("workflow-hour");
    rows.add(&hours);
    let minutes = adw::SpinRow::with_range(0.0, 59.0, 1.0);
    minutes.set_title(t("workflows.minute"));
    minutes.set_value(f64::from(minute));
    minutes.add_css_class("workflow-minute");
    rows.add(&minutes);
    let day_row = adw::ActionRow::builder().title(t("workflows.days")).build();
    day_row.add_css_class("workflow-days");
    let toggles = gtk::Box::builder().css_classes(["linked"]).valign(gtk::Align::Center).build();
    for day in 1..=7u8 {
        let toggle = gtk::ToggleButton::builder().label(t(workflows::day_key(day))).active(days.contains(&day)).build();
        let e = ed.clone();
        toggle.connect_toggled(move |toggle| {
            let on = toggle.is_active();
            edit(&e, |_, _, days, _| {
                days.retain(|d| *d != day);
                if on {
                    days.push(day);
                    days.sort_unstable();
                }
            });
        });
        toggles.append(&toggle);
    }
    day_row.add_suffix(&toggles);
    day_row.set_visible(every == Every::Week);
    rows.add(&day_row);
    let zone = entry(t("workflows.timezone"), timezone, "workflow-timezone");
    zone.set_tooltip_text(Some(t("workflows.timezone_hint")));
    let e = ed.clone();
    zone.connect_changed(move |row| {
        let text = row.text().trim().to_owned();
        edit(&e, |_, _, _, timezone| *timezone = text);
    });
    rows.add(&zone);
    let e = ed.clone();
    rows.add(&room_combo(ed, room, false, move |id| {
        if let Trigger::Schedule { room, .. } = &mut e.draft.borrow_mut().trigger {
            *room = id;
        }
    }));
    // Weak: each spin row holds this in its own handler.
    let time_changed = {
        let (e, hours, minutes) = (ed.clone(), hours.downgrade(), minutes.downgrade());
        move || {
            let (Some(hours), Some(minutes)) = (hours.upgrade(), minutes.upgrade()) else { return };
            let text = workflows::time_text(hours.value() as u32, minutes.value() as u32);
            edit(&e, |_, time, _, _| *time = text);
        }
    };
    let changed = Rc::new(time_changed);
    let again = changed.clone();
    hours.connect_value_notify(move |_| again());
    let again = changed.clone();
    minutes.connect_value_notify(move |_| again());
    let e = ed.clone();
    repeat.connect_selected_notify(move |row| {
        let Some(chosen) = EVERY.get(row.selected() as usize).copied() else { return };
        edit(&e, |every, _, _, _| *every = chosen);
        hours.set_visible(chosen != Every::Hour);
        day_row.set_visible(chosen == Every::Week);
    });
}

/// A webhook has no settings; its URL is made on demand, once saved.
fn webhook_rows(ed: &Ed, rows: &Rc<Rows>) {
    let Some(id) = ed.id.clone() else {
        rows.note(t("workflows.webhook_save_first"));
        return;
    };
    if ed.has_webhook {
        rows.note(t("workflows.webhook_exists"));
    }
    let generate = button_row(
        t(if ed.has_webhook { "workflows.webhook_regenerate" } else { "workflows.webhook_generate" }),
        &["workflow-webhook"],
    );
    let c = ed.ctx.clone();
    generate.connect_activated(move |button| {
        let (s, id) = (c.session.clone(), id.clone());
        button.set_sensitive(false);
        let (c, button) = (c.clone(), button.clone());
        // Not `spawn`: the server made the secret, which it never shows again,
        // so it is shown even when the settings closed meanwhile.
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { s.workflow_webhook(&id).await }).await;
            if !c.host.alive() {
                if let Ok(url) = result
                    && !c.session.is_closed()
                {
                    show_webhook(active_window().as_ref(), &url);
                }
                return;
            }
            button.set_sensitive(true);
            match result {
                Ok(url) => show_webhook(c.host.widget().as_ref(), &url),
                Err(error) => c.host.toast(error_text(&error)),
            }
        });
    });
    rows.add(&generate);
    if let Some(security) = ed.ctx.security {
        let reauth = button_row(t("security.verify"), &["workflow-reauth"]);
        let host = ed.ctx.host.clone();
        reauth.connect_activated(move |_| host.select(security));
        rows.add(&reauth);
    }
}

/// The webhook's URL, once: copy it now, it will not be shown again.
fn show_webhook(parent: Option<&gtk::Widget>, url: &str) {
    let content = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(12)
        .margin_top(18)
        .margin_bottom(24)
        .margin_start(24)
        .margin_end(24)
        .css_classes(["workflow-webhook-dialog"])
        .build();
    content.append(
        &gtk::Label::builder()
            .label(t("workflows.webhook_once"))
            .wrap(true)
            .xalign(0.0)
            .css_classes(["workflow-webhook-warning"])
            .build(),
    );
    content.append(&copyable(url, "workflow-webhook-url"));
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(&content));
    let dialog = adw::Dialog::builder().title(t("workflows.webhook_title")).content_width(560).child(&view).build();
    widgets::present(&dialog, parent);
}

/// Puts the step groups back from the draft, then the groups after them.
fn rebuild_steps(ed: &Ed) {
    let Some(page) = ed.page.upgrade() else { return };
    let tail: Vec<adw::PreferencesGroup> = ed.tail.borrow().iter().filter_map(|g| g.upgrade()).collect();
    let steps: Vec<adw::PreferencesGroup> = ed.steps.take().iter().filter_map(|g| g.upgrade()).collect();
    // The first time, the groups after the steps are not on the page yet.
    for group in steps.iter().chain(&tail).filter(|g| g.parent().is_some()) {
        page.remove(group);
    }
    let count = ed.draft.borrow().steps.len();
    let groups: Vec<adw::PreferencesGroup> = (0..count).map(|index| step_group(ed, index)).collect();
    for group in &groups {
        page.add(group);
    }
    if groups.is_empty() {
        let empty =
            adw::PreferencesGroup::builder().title(t("workflows.steps")).description(t("workflows.no_steps")).build();
        page.add(&empty);
        ed.steps.replace(vec![empty.downgrade()]);
    } else {
        ed.steps.replace(groups.iter().map(|g| g.downgrade()).collect());
    }
    for group in &tail {
        page.add(group);
    }
}

fn icon_button(icon: &str, tooltip: &str, class: &str) -> gtk::Button {
    let button = gtk::Button::builder().icon_name(icon).tooltip_text(tooltip).valign(gtk::Align::Center).build();
    button.add_css_class("flat");
    button.add_css_class(class);
    button
}

/// One step: its kind and summary, its controls (variables, move, remove),
/// then its own settings.
fn step_group(ed: &Ed, index: usize) -> adw::PreferencesGroup {
    let (step, count, trigger) = {
        let draft = ed.draft.borrow();
        (draft.steps[index].clone(), draft.steps.len(), draft.trigger.clone())
    };
    let title = format!(
        "{} · {}",
        tf("workflows.step_number", &[("n", &(index + 1).to_string())]),
        t(workflows::step_kind_key(&step))
    );
    let group = adw::PreferencesGroup::builder().title(title).build();
    group.add_css_class("workflow-step");
    let controls = gtk::Box::builder().spacing(2).build();
    let target: Target = Rc::default();
    if matches!(step, Step::Message { .. } | Step::Http { .. }) {
        controls.append(&variables_button(ed, index, &target));
    }
    let up = icon_button("go-up-symbolic", t("workflows.move_up"), "workflow-step-up");
    up.set_sensitive(index > 0);
    let e = ed.clone();
    up.connect_clicked(move |_| {
        e.draft.borrow_mut().steps.swap(index - 1, index);
        rebuild_steps(&e);
    });
    controls.append(&up);
    let down = icon_button("go-down-symbolic", t("workflows.move_down"), "workflow-step-down");
    down.set_sensitive(index + 1 < count);
    let e = ed.clone();
    down.connect_clicked(move |_| {
        e.draft.borrow_mut().steps.swap(index, index + 1);
        rebuild_steps(&e);
    });
    controls.append(&down);
    let remove = icon_button("user-trash-symbolic", t("workflows.step_remove"), "workflow-step-remove");
    let e = ed.clone();
    remove.connect_clicked(move |_| {
        let e = e.clone();
        let heading = tf("workflows.step_remove_confirm", &[("n", &(index + 1).to_string())]);
        confirm(
            &e.ctx.host.clone(),
            &heading,
            t("workflows.step_remove_body"),
            t("workflows.step_remove"),
            move || {
                if index < e.draft.borrow().steps.len() {
                    e.draft.borrow_mut().steps.remove(index);
                    rebuild_steps(&e);
                }
            },
        );
    });
    controls.append(&remove);
    group.set_header_suffix(Some(&controls));
    let has_room = workflows::has_room(&trigger);
    match step {
        Step::Message { room, text, in_thread, save_as, .. } => {
            let e = ed.clone();
            group.add(&room_combo(ed, &room, has_room, move |id| {
                with_step(&e, index, |step| {
                    if let Step::Message { room, .. } = step {
                        *room = id;
                    }
                })
            }));
            let (row, view) = text_area(t("workflows.text"), &text, "workflow-text");
            let e = ed.clone();
            on_text(&view, move |value| {
                with_step(&e, index, |step| {
                    if let Step::Message { text, .. } = step {
                        *text = value;
                    }
                })
            });
            target.replace(Some(Field::text(&view)));
            follow(&view, &target, Field::text(&view));
            group.add(&row);
            let thread = switch(t("workflows.in_thread"), in_thread, "workflow-in-thread");
            let e = ed.clone();
            thread.connect_active_notify(move |row| {
                let on = row.is_active();
                with_step(&e, index, |step| {
                    if let Step::Message { in_thread, .. } = step {
                        *in_thread = on;
                    }
                })
            });
            group.add(&thread);
            group.add(&save_as_row(ed, index, save_as.as_deref().unwrap_or_default()));
        }
        Step::Wait { seconds } => wait_rows(ed, &group, index, seconds),
        Step::Http { method, url, headers, body, save_as, continue_on_error } => {
            http_rows(ed, &group, index, &target, method, &url, &headers, body.as_deref().unwrap_or_default());
            group.add(&save_as_row(ed, index, save_as.as_deref().unwrap_or_default()));
            let keep_going = switch(t("workflows.continue_on_error"), continue_on_error, "workflow-continue");
            let e = ed.clone();
            keep_going.connect_active_notify(move |row| {
                let on = row.is_active();
                with_step(&e, index, |step| {
                    if let Step::Http { continue_on_error, .. } = step {
                        *continue_on_error = on;
                    }
                })
            });
            group.add(&keep_going);
        }
        Step::Form { room, recipient, title, fields, save_as } => {
            form_rows(ed, &group, index, has_room, &room, recipient, &title, &fields);
            group.add(&save_as_row(ed, index, &save_as));
        }
    }
    group
}

/// "Keep the result as": a name later steps read; empty keeps nothing
/// (a form always keeps its answers).
fn save_as_row(ed: &Ed, index: usize, current: &str) -> adw::EntryRow {
    let row = entry(t("workflows.save_as"), current, "workflow-save-as");
    row.set_tooltip_text(Some(t("workflows.save_as_hint")));
    let e = ed.clone();
    row.connect_changed(move |row| {
        let value = row.text().trim().to_owned();
        with_step(&e, index, |step| match step {
            Step::Message { save_as, .. } | Step::Http { save_as, .. } => {
                *save_as = (!value.is_empty()).then_some(value);
            }
            Step::Form { save_as, .. } => *save_as = value,
            Step::Wait { .. } => {}
        })
    });
    row
}

/// The variables a step may use, inserted where its last chosen template
/// field has the cursor.
fn variables_button(ed: &Ed, index: usize, target: &Target) -> gtk::MenuButton {
    let list =
        gtk::ListBox::builder().selection_mode(gtk::SelectionMode::None).css_classes(["navigation-sidebar"]).build();
    let scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .propagate_natural_height(true)
        .max_content_height(360)
        .child(&list)
        .build();
    let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).build();
    column.append(
        &gtk::Label::builder()
            .label(t("workflows.variables_hint"))
            .wrap(true)
            .max_width_chars(36)
            .xalign(0.0)
            .css_classes(["caption", "dim-label"])
            .build(),
    );
    column.append(&scroller);
    let popover = gtk::Popover::builder().child(&column).build();
    let button = gtk::MenuButton::builder()
        .icon_name("insert-text-symbolic")
        .tooltip_text(t("workflows.variables"))
        .popover(&popover)
        .valign(gtk::Align::Center)
        .build();
    button.add_css_class("flat");
    button.add_css_class("workflow-variables");
    let (e, target) = (ed.clone(), target.clone());
    popover.connect_show(move |popover| {
        while let Some(row) = list.first_child() {
            list.remove(&row);
        }
        let names = {
            let draft = e.draft.borrow();
            workflows::variables(&draft.trigger, &draft.steps, index)
        };
        if names.is_empty() {
            list.append(&gtk::Label::new(Some(t("workflows.no_variables"))));
        }
        for name in names {
            let row =
                gtk::Button::builder().label(workflows::placeholder(&name)).css_classes(["flat", "monospace"]).build();
            let (target, popover) = (target.clone(), popover.downgrade());
            row.connect_clicked(move |_| {
                if let Some(popover) = popover.upgrade() {
                    popover.popdown();
                }
                if let Some(field) = target.borrow().clone() {
                    field.insert(&workflows::placeholder(&name));
                }
            });
            list.append(&row);
        }
    });
    button
}

fn wait_rows(ed: &Ed, group: &adw::PreferencesGroup, index: usize, seconds: u64) {
    let (value, unit) = workflows::wait_parts(seconds);
    let amount = adw::SpinRow::with_range(1.0, workflows::WAIT_SECONDS as f64, 1.0);
    amount.set_title(t("workflows.wait_for"));
    amount.set_value(value as f64);
    amount.add_css_class("workflow-wait");
    group.add(&amount);
    let names: Vec<&str> = WaitUnit::ALL.iter().map(|u| t(u.key())).collect();
    let units =
        combo(t("workflows.unit"), &names, WaitUnit::ALL.iter().position(|u| *u == unit).unwrap_or(0), "workflow-unit");
    group.add(&units);
    // Weak: each row holds this in its own handler.
    let changed = {
        let (e, amount, units) = (ed.clone(), amount.downgrade(), units.downgrade());
        Rc::new(move || {
            let (Some(amount), Some(units)) = (amount.upgrade(), units.upgrade()) else { return };
            let unit = WaitUnit::ALL.get(units.selected() as usize).copied().unwrap_or(WaitUnit::Seconds);
            let total = workflows::wait_seconds(amount.value() as u64, unit);
            with_step(&e, index, |step| {
                if let Step::Wait { seconds } = step {
                    *seconds = total;
                }
            })
        })
    };
    let again = changed.clone();
    amount.connect_value_notify(move |_| again());
    units.connect_selected_notify(move |_| changed());
}

const METHODS: [HttpMethod; 5] =
    [HttpMethod::Get, HttpMethod::Post, HttpMethod::Put, HttpMethod::Patch, HttpMethod::Delete];

#[allow(clippy::too_many_arguments)]
fn http_rows(
    ed: &Ed,
    group: &adw::PreferencesGroup,
    index: usize,
    target: &Target,
    method: HttpMethod,
    url: &str,
    headers: &[HttpHeader],
    body: &str,
) {
    let names: Vec<&str> = METHODS.iter().map(|m| m.as_str()).collect();
    let verb =
        combo(t("workflows.method"), &names, METHODS.iter().position(|m| *m == method).unwrap_or(0), "workflow-method");
    let e = ed.clone();
    verb.connect_selected_notify(move |row| {
        let Some(chosen) = METHODS.get(row.selected() as usize).copied() else { return };
        with_step(&e, index, |step| {
            if let Step::Http { method, .. } = step {
                *method = chosen;
            }
        })
    });
    group.add(&verb);
    let address = entry(t("workflows.url"), url, "workflow-url");
    let e = ed.clone();
    address.connect_changed(move |row| {
        let value = row.text().to_string();
        with_step(&e, index, |step| {
            if let Step::Http { url, .. } = step {
                *url = value;
            }
        })
    });
    let line: gtk::Editable = address.clone().upcast();
    target.replace(Some(Field::line(&line)));
    follow(&address, target, Field::line(&line));
    group.add(&address);
    let list = adw::ExpanderRow::builder().title(t("workflows.headers")).subtitle(headers.len().to_string()).build();
    list.add_css_class("workflow-headers");
    for (position, header) in headers.iter().enumerate() {
        list.add_row(&header_row(ed, index, position, header, target));
    }
    if headers.len() < workflows::HTTP_HEADERS {
        let add = button_row(t("workflows.header_add"), &["workflow-header-add"]);
        let e = ed.clone();
        add.connect_activated(move |_| {
            with_step(&e, index, |step| {
                if let Step::Http { headers, .. } = step {
                    headers.push(HttpHeader { name: String::new(), value: String::new() });
                }
            });
            rebuild_steps(&e);
        });
        list.add_row(&add);
    }
    group.add(&list);
    let (row, view) = text_area(t("workflows.body"), body, "workflow-body");
    let e = ed.clone();
    on_text(&view, move |value| {
        with_step(&e, index, |step| {
            if let Step::Http { body, .. } = step {
                *body = (!value.is_empty()).then_some(value);
            }
        })
    });
    follow(&view, target, Field::text(&view));
    group.add(&row);
}

fn header_row(ed: &Ed, index: usize, position: usize, header: &HttpHeader, target: &Target) -> gtk::Widget {
    /// Changes the header at `position` of the step at `index`.
    fn edit(ed: &Ed, index: usize, position: usize, change: impl FnOnce(&mut HttpHeader)) {
        with_step(ed, index, |step| {
            if let Step::Http { headers, .. } = step
                && let Some(header) = headers.get_mut(position)
            {
                change(header);
            }
        })
    }
    let line = gtk::Box::builder().spacing(6).margin_top(6).margin_bottom(6).margin_start(12).margin_end(6).build();
    let name =
        gtk::Entry::builder().placeholder_text(t("workflows.header_name")).text(&header.name).hexpand(true).build();
    name.add_css_class("workflow-header-name");
    let e = ed.clone();
    name.connect_changed(move |entry| {
        let value = entry.text().to_string();
        edit(&e, index, position, |header| header.name = value);
    });
    line.append(&name);
    let value =
        gtk::Entry::builder().placeholder_text(t("workflows.header_value")).text(&header.value).hexpand(true).build();
    value.add_css_class("workflow-header-value");
    let e = ed.clone();
    value.connect_changed(move |entry| {
        let text = entry.text().to_string();
        edit(&e, index, position, |header| header.value = text);
    });
    follow(&value, target, Field::line(&value));
    line.append(&value);
    let remove = icon_button("list-remove-symbolic", t("workflows.header_remove"), "workflow-header-remove");
    let e = ed.clone();
    remove.connect_clicked(move |_| {
        with_step(&e, index, |step| {
            if let Step::Http { headers, .. } = step
                && position < headers.len()
            {
                headers.remove(position);
            }
        });
        rebuild_steps(&e);
    });
    line.append(&remove);
    gtk::ListBoxRow::builder().activatable(false).child(&line).build().upcast()
}

const FIELD_KINDS: [FormFieldKind; 5] =
    [FormFieldKind::Text, FormFieldKind::LongText, FormFieldKind::Number, FormFieldKind::Choice, FormFieldKind::Person];

fn field_kind_key(kind: FormFieldKind) -> &'static str {
    match kind {
        FormFieldKind::Text => "workflows.field.text",
        FormFieldKind::LongText => "workflows.field.long_text",
        FormFieldKind::Number => "workflows.field.number",
        FormFieldKind::Choice => "workflows.field.choice",
        FormFieldKind::Person => "workflows.field.person",
    }
}

#[allow(clippy::too_many_arguments)]
fn form_rows(
    ed: &Ed,
    group: &adw::PreferencesGroup,
    index: usize,
    has_room: bool,
    room: &str,
    recipient: FormRecipient,
    title: &str,
    fields: &[FormField],
) {
    let e = ed.clone();
    group.add(&room_combo(ed, room, has_room, move |id| {
        with_step(&e, index, |step| {
            if let Step::Form { room, .. } = step {
                *room = id;
            }
        })
    }));
    let recipients = [FormRecipient::TriggerUser, FormRecipient::Anyone];
    let names = [t("workflows.recipient.trigger_user"), t("workflows.recipient.anyone")];
    let who = combo(
        t("workflows.recipient"),
        &names,
        recipients.iter().position(|r| *r == recipient).unwrap_or(1),
        "workflow-recipient",
    );
    let e = ed.clone();
    who.connect_selected_notify(move |row| {
        let Some(chosen) = recipients.get(row.selected() as usize).copied() else { return };
        with_step(&e, index, |step| {
            if let Step::Form { recipient, .. } = step {
                *recipient = chosen;
            }
        })
    });
    group.add(&who);
    let heading = entry(t("workflows.form_title"), title, "workflow-form-title");
    let e = ed.clone();
    heading.connect_changed(move |row| {
        let value = row.text().to_string();
        with_step(&e, index, |step| {
            if let Step::Form { title, .. } = step {
                *title = value;
            }
        })
    });
    group.add(&heading);
    for (position, field) in fields.iter().enumerate() {
        group.add(&field_row(ed, index, position, field));
    }
    if fields.len() < workflows::FORM_FIELDS {
        let add = button_row(t("workflows.field_add"), &["workflow-field-add"]);
        let e = ed.clone();
        add.connect_activated(move |_| {
            with_step(&e, index, |step| {
                if let Step::Form { fields, .. } = step {
                    let taken: Vec<String> = fields.iter().map(|f| f.id.clone()).collect();
                    fields.push(FormField {
                        id: workflows::identifier("field", &taken),
                        label: String::new(),
                        kind: FormFieldKind::Text,
                        options: vec![],
                        people: vec![],
                        multiple: false,
                        required: false,
                    });
                }
            });
            rebuild_steps(&e);
        });
        group.add(&add);
    }
}

/// One field of a form: its label (its id follows it while the field is
/// new), its kind, its options for a choice, whether it is required.
fn field_row(ed: &Ed, index: usize, position: usize, field: &FormField) -> adw::ExpanderRow {
    /// Changes the field at `position` of the form step at `index`.
    fn edit(ed: &Ed, index: usize, position: usize, change: impl FnOnce(&mut FormField, &[String])) {
        with_step(ed, index, |step| {
            if let Step::Form { fields, .. } = step {
                let others: Vec<String> =
                    fields.iter().enumerate().filter(|(i, _)| *i != position).map(|(_, f)| f.id.clone()).collect();
                if let Some(field) = fields.get_mut(position) {
                    change(field, &others);
                }
            }
        })
    }
    let shown = |field: &FormField| {
        if field.label.trim().is_empty() { t("workflows.field_label").to_owned() } else { field.label.clone() }
    };
    let row = adw::ExpanderRow::builder()
        .title(glib::markup_escape_text(&shown(field)))
        .subtitle(tf("workflows.field_id", &[("id", &field.id)]))
        .build();
    row.add_css_class("workflow-field");
    // A field nobody labelled yet takes its id from the label typed.
    let fresh = Rc::new(Cell::new(field.label.trim().is_empty()));
    let label = entry(t("workflows.field_label"), &field.label, "workflow-field-label");
    // Weak: the expander holds the label, and so this handler.
    let (e, expander) = (ed.clone(), row.downgrade());
    label.connect_changed(move |entry| {
        let Some(expander) = expander.upgrade() else { return };
        let text = entry.text().to_string();
        let mut id = None;
        edit(&e, index, position, |field, others| {
            field.label = text.clone();
            if fresh.get() {
                field.id = workflows::identifier(&text, others);
            }
            id = Some(field.id.clone());
        });
        expander.set_title(&glib::markup_escape_text(if text.trim().is_empty() {
            t("workflows.field_label")
        } else {
            &text
        }));
        if let Some(id) = id {
            expander.set_subtitle(&tf("workflows.field_id", &[("id", &id)]));
        }
    });
    row.add_row(&label);
    let names: Vec<&str> = FIELD_KINDS.iter().map(|k| t(field_kind_key(*k))).collect();
    let kind = combo(
        t("workflows.field_kind"),
        &names,
        FIELD_KINDS.iter().position(|k| *k == field.kind).unwrap_or(0),
        "workflow-field-kind",
    );
    row.add_row(&kind);
    let options = entry(t("workflows.field_options"), &field.options.join(", "), "workflow-field-options");
    options.set_visible(field.kind == FormFieldKind::Choice);
    let e = ed.clone();
    options.connect_changed(move |entry| {
        let list: Vec<String> =
            entry.text().split(',').map(|o| o.trim().to_owned()).filter(|o| !o.is_empty()).collect();
        edit(&e, index, position, |field, _| field.options = list);
    });
    // Several answers: checkboxes rather than radios, for a choice or a person.
    let picks = |kind: FormFieldKind| matches!(kind, FormFieldKind::Choice | FormFieldKind::Person);
    let several = switch(t("workflows.field_multiple"), field.multiple, "workflow-field-multiple");
    several.set_visible(picks(field.kind));
    let e = ed.clone();
    several.connect_active_notify(move |row| {
        let on = row.is_active();
        edit(&e, index, position, |field, _| field.multiple = on);
    });
    let (e, choices, was, several_row) = (ed.clone(), options.clone(), field.kind, several.clone());
    kind.connect_selected_notify(move |row| {
        let Some(chosen) = FIELD_KINDS.get(row.selected() as usize).copied() else { return };
        edit(&e, index, position, |field, _| {
            field.kind = chosen;
            if chosen != FormFieldKind::Person {
                field.people.clear();
            }
            if !picks(chosen) {
                field.multiple = false;
            }
        });
        choices.set_visible(chosen == FormFieldKind::Choice);
        several_row.set_visible(picks(chosen));
        if !picks(chosen) {
            several_row.set_active(false);
        }
        // A person field has its own rows, put in or taken out.
        if (chosen == FormFieldKind::Person) != (was == FormFieldKind::Person) {
            rebuild_steps(&e);
        }
    });
    row.add_row(&options);
    row.add_row(&several);
    if field.kind == FormFieldKind::Person {
        people_rows(ed, &row, index, position, &field.people);
    }
    let required = switch(t("workflows.field_required"), field.required, "workflow-field-required");
    let e = ed.clone();
    required.connect_active_notify(move |row| {
        let on = row.is_active();
        edit(&e, index, position, |field, _| field.required = on);
    });
    row.add_row(&required);
    let remove = button_row(t("workflows.field_remove"), &["destructive-action", "workflow-field-remove"]);
    let e = ed.clone();
    remove.connect_activated(move |_| {
        with_step(&e, index, |step| {
            if let Step::Form { fields, .. } = step
                && position < fields.len()
            {
                fields.remove(position);
            }
        });
        rebuild_steps(&e);
    });
    row.add_row(&remove);
    row
}

/// Changes the people of the field at `position` of the form step at `index`.
fn edit_people(ed: &Ed, index: usize, position: usize, change: impl FnOnce(&mut Vec<String>)) {
    with_step(ed, index, |step| {
        if let Step::Form { fields, .. } = step
            && let Some(field) = fields.get_mut(position)
        {
            change(&mut field.people);
        }
    })
}

/// A person field: any member of the room, or these people (removable
/// rows, then "Add a person" with a search over everyone but bots).
fn people_rows(ed: &Ed, row: &adw::ExpanderRow, index: usize, position: usize, chosen: &[String]) {
    let names = [t("workflows.people_any"), t("workflows.people_these")];
    let mode = combo(t("workflows.field.person"), &names, usize::from(!chosen.is_empty()), "workflow-people-mode");
    row.add_row(&mode);
    let everyone = ed.people.borrow().clone();
    for id in chosen {
        let user = everyone.iter().find(|u| u.id == *id);
        let person = adw::ActionRow::builder()
            .title(user.map_or_else(|| id.clone(), workflows::person_name))
            .subtitle(user.map_or_else(String::new, |u| format!("@{}", u.username)))
            .use_markup(false)
            .build();
        person.add_css_class("workflow-person");
        let remove = icon_button("list-remove-symbolic", t("workflows.people_remove"), "workflow-person-remove");
        let (e, id) = (ed.clone(), id.clone());
        remove.connect_clicked(move |_| {
            edit_people(&e, index, position, |people| people.retain(|p| *p != id));
            rebuild_steps(&e);
        });
        person.add_suffix(&remove);
        row.add_row(&person);
    }
    let add = adw::ActionRow::builder().title(t("workflows.people_add")).visible(!chosen.is_empty()).build();
    add.add_css_class("workflow-person-add");
    let list =
        gtk::ListBox::builder().selection_mode(gtk::SelectionMode::None).css_classes(["navigation-sidebar"]).build();
    let search = gtk::SearchEntry::builder().placeholder_text(t("workflows.people_search")).build();
    let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).build();
    column.append(&search);
    column.append(
        &gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_height(true)
            .max_content_height(320)
            .child(&list)
            .build(),
    );
    let popover = gtk::Popover::builder().child(&column).build();
    let pick = gtk::MenuButton::builder()
        .icon_name("list-add-symbolic")
        .tooltip_text(t("workflows.people_add"))
        .popover(&popover)
        .valign(gtk::Align::Center)
        .build();
    pick.add_css_class("flat");
    pick.add_css_class("workflow-person-pick");
    let taken: Vec<String> = chosen.to_vec();
    let mut entries = Vec::new();
    for user in everyone.into_iter().filter(|u| !taken.contains(&u.id)) {
        let button = gtk::Button::builder()
            .label(format!("{} (@{})", workflows::person_name(&user), user.username))
            .css_classes(["flat"])
            .build();
        let (e, id, full, popover) =
            (ed.clone(), user.id.clone(), taken.len() >= PEOPLE_PER_FIELD, popover.downgrade());
        button.connect_clicked(move |_| {
            if let Some(popover) = popover.upgrade() {
                popover.popdown();
            }
            if full {
                e.ctx.host.toast(t("workflows.people_limit"));
                return;
            }
            edit_people(&e, index, position, |people| {
                if !people.contains(&id) {
                    people.push(id.clone());
                }
            });
            rebuild_steps(&e);
        });
        list.append(&button);
        let haystack = format!("{} {}", workflows::person_name(&user), user.username).to_lowercase();
        entries.push((button.downgrade(), haystack));
    }
    search.connect_search_changed(move |entry| {
        let query = entry.text().trim().to_lowercase();
        for (button, haystack) in &entries {
            if let Some(button) = button.upgrade() {
                // The ListBox wraps each button in a row: hide that.
                if let Some(parent) = button.parent() {
                    parent.set_visible(query.is_empty() || haystack.contains(&query));
                }
            }
        }
    });
    add.add_suffix(&pick);
    row.add_row(&add);
    let (e, shown) = (ed.clone(), add.downgrade());
    mode.connect_selected_notify(move |mode| {
        let these = mode.selected() == 1;
        if let Some(add) = shown.upgrade() {
            add.set_visible(these);
        }
        if !these {
            edit_people(&e, index, position, Vec::clear);
            rebuild_steps(&e);
        }
    });
}

/// "Add a step": one button per kind.
fn add_step_group(ed: &Ed) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::new();
    let row = adw::ActionRow::builder().title(t("workflows.add_step")).build();
    row.add_css_class("workflow-add-step");
    let kinds = gtk::Box::builder().spacing(6).valign(gtk::Align::Center).build();
    for kind in workflows::STEP_KINDS {
        let button = gtk::Button::builder().label(t(&format!("workflows.step.{kind}"))).build();
        button.add_css_class(&format!("workflow-add-{kind}"));
        let e = ed.clone();
        button.connect_clicked(move |_| {
            let step = {
                let draft = e.draft.borrow();
                workflows::new_step(kind, &draft.trigger, &draft.steps)
            };
            if let Some(step) = step {
                if e.draft.borrow().steps.len() >= workflows::STEPS_PER_WORKFLOW {
                    e.ctx.host.toast(t("workflows.error_steps"));
                    return;
                }
                e.draft.borrow_mut().steps.push(step);
                rebuild_steps(&e);
            }
        });
        kinds.append(&button);
    }
    let scroller = gtk::ScrolledWindow::builder()
        .vscrollbar_policy(gtk::PolicyType::Never)
        .hscrollbar_policy(gtk::PolicyType::Automatic)
        .propagate_natural_width(true)
        .child(&kinds)
        .build();
    row.add_suffix(&scroller);
    group.add(&row);
    group
}

/// Save, and for a saved workflow Test and Disable.
fn actions_group(ed: &Ed, workflow: Option<&Workflow>) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::new();
    let save = button_row(t("workflows.save"), &["suggested-action", "workflow-save"]);
    let e = ed.clone();
    save.connect_activated(move |button| save_workflow(&e, button));
    group.add(&save);
    if let Some(id) = ed.id.clone() {
        let test = button_row(t("workflows.test"), &["workflow-test"]);
        let (c, test_id) = (ed.ctx.clone(), id.clone());
        let e = ed.clone();
        test.connect_activated(move |button| {
            let (s, id) = (c.session.clone(), test_id.clone());
            button.set_sensitive(false);
            let (c, button, e) = (c.clone(), button.clone(), e.clone());
            spawn(&c.host.clone(), async move { s.test_workflow(&id).await }, move |result| {
                button.set_sensitive(true);
                match result {
                    Ok(_) => {
                        c.host.toast(t("workflows.tested"));
                        load_runs(&e);
                    }
                    Err(error) => c.host.toast(error_text(&error)),
                }
            });
        });
        group.add(&test);
        if workflow.is_some_and(|w| w.enabled) {
            let disable = button_row(t("workflows.disable"), &["workflow-disable"]);
            let e = ed.clone();
            disable.connect_activated(move |button| {
                let (s, id) = (e.ctx.session.clone(), id.clone());
                button.set_sensitive(false);
                let (e, button) = (e.clone(), button.clone());
                spawn(&e.ctx.host.clone(), async move { s.disable_workflow(&id).await }, move |result| match result {
                    Ok(_) => {
                        e.draft.borrow_mut().enabled = false;
                        if let Some(switch) = e.enabled.upgrade() {
                            switch.set_active(false);
                        }
                        button.set_visible(false);
                        e.ctx.host.toast(t("workflows.disabled"));
                        reload(&e.ctx);
                    }
                    Err(error) => {
                        button.set_sensitive(true);
                        e.ctx.host.toast(error_text(&error));
                    }
                });
            });
            group.add(&disable);
        }
    }
    group
}

/// Creates the workflow, or saves it at the revision it was read at. A
/// conflict reads it again and reopens it; a success reopens it as saved.
fn save_workflow(ed: &Ed, button: &adw::ButtonRow) {
    let (s, draft, id, revision) =
        (ed.ctx.session.clone(), ed.draft.borrow().clone(), ed.id.clone(), ed.revision.clone());
    button.set_sensitive(false);
    let (e, button) = (ed.clone(), button.clone());
    spawn(
        &ed.ctx.host.clone(),
        async move {
            let saved = match &id {
                Some(id) => s.update_workflow(id, &revision, &draft).await,
                None => s.create_workflow(&draft).await,
            };
            match (saved, id) {
                (Err(error), Some(id)) if error.code() == "revision_conflict" => {
                    let fresh = s.workflow(&id).await.ok();
                    (Err(error), fresh)
                }
                (result, _) => (result, None),
            }
        },
        move |(result, fresh)| {
            button.set_sensitive(true);
            match result {
                Ok(workflow) => {
                    e.ctx.host.toast(t(if e.id.is_some() { "workflows.saved" } else { "workflows.created" }));
                    close(&e);
                    reload(&e.ctx);
                    editor(&e.ctx, Some(workflow));
                }
                Err(error) => {
                    e.ctx.host.toast(error_text(&error));
                    if let Some(workflow) = fresh {
                        close(&e);
                        editor(&e.ctx, Some(workflow));
                    }
                }
            }
        },
    );
}

/// The last runs of a saved workflow, newest first.
fn runs_group(ed: &Ed) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::builder().title(t("workflows.runs")).build();
    group.add_css_class("workflow-runs");
    let refresh = icon_button("view-refresh-symbolic", t("security.refresh"), "workflow-runs-refresh");
    group.set_header_suffix(Some(&refresh));
    ed.runs.replace(Some(Rows::new(&group)));
    let e = ed.clone();
    refresh.connect_clicked(move |_| load_runs(&e));
    load_runs(ed);
    group
}

fn load_runs(ed: &Ed) {
    let (Some(id), Some(rows)) = (ed.id.clone(), ed.runs.borrow().clone()) else { return };
    rows.clear();
    rows.note(t("crypto.loading"));
    let s = ed.ctx.session.clone();
    spawn(&ed.ctx.host, async move { s.workflow_runs(&id).await }, move |result| {
        rows.clear();
        match result {
            Err(error) => rows.note(error_text(&error)),
            Ok(runs) if runs.is_empty() => rows.note(t("workflows.no_runs")),
            Ok(runs) => {
                for run in runs {
                    let row = adw::ActionRow::builder()
                        .title(workflows::run_text(&run))
                        .subtitle(date_time(&run.created_at))
                        .title_lines(3)
                        .use_markup(false)
                        .build();
                    row.add_css_class("workflow-run");
                    rows.add(&row);
                }
            }
        }
    });
}

/// Deleting it, after a confirmation.
fn danger_group(ed: &Ed, name: &str) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::new();
    let delete = button_row(t("workflows.delete"), &["destructive-action", "workflow-delete"]);
    group.add(&delete);
    let (e, name) = (ed.clone(), name.to_owned());
    delete.connect_activated(move |_| {
        let Some(id) = e.id.clone() else { return };
        let e = e.clone();
        let heading = tf("workflows.delete_confirm", &[("name", &name)]);
        confirm(&e.ctx.host.clone(), &heading, t("workflows.delete_body"), t("workflows.delete"), move || {
            let (s, id, e) = (e.ctx.session.clone(), id.clone(), e.clone());
            spawn(&e.ctx.host.clone(), async move { s.delete_workflow(&id).await }, move |result| match result {
                Ok(()) => {
                    close(&e);
                    reload(&e.ctx);
                }
                Err(error) => e.ctx.host.toast(error_text(&error)),
            });
        });
    });
    group
}

#[cfg(test)]
#[path = "../tests/workflows.rs"]
mod tests;
