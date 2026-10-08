//! A form a workflow posted (RFC 0004): its card in the message, and the
//! dialog that answers it. The answered message comes back through sync and
//! its card then says who answered.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::native::NativeSession;
use rv_core::native::workflows::{self, FormAnswer, FormField, FormFieldKind, WorkflowForm};

use crate::i18n::{t, tf};
use crate::{on_tokio, widgets};

/// The card: title, who answers, then "Answer", who answered, or that it expired.
pub fn card(session: &Arc<NativeSession>, room: &str, message: &str, form: WorkflowForm, me: &str) -> gtk::Widget {
    let card = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(4)
        .margin_top(4)
        .halign(gtk::Align::Start)
        .css_classes(["card", "workflow-form-card"])
        .build();
    let inner = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(4)
        .margin_top(10)
        .margin_bottom(10)
        .margin_start(12)
        .margin_end(12)
        .build();
    card.append(&inner);
    inner.append(
        &gtk::Label::builder()
            .label(&form.title)
            .wrap(true)
            .xalign(0.0)
            .css_classes(["heading", "workflow-form-title"])
            .build(),
    );
    let audience = match &form.recipient {
        Some(user) => tf("workflows.form_for", &[("user", &user.username)]),
        None => t("workflows.form_anyone").to_owned(),
    };
    inner.append(&gtk::Label::builder().label(audience).wrap(true).xalign(0.0).css_classes(["dim-label"]).build());
    let now = chrono::Utc::now();
    if let Some(by) = &form.answered_by {
        let name = if by.display_name.trim().is_empty() { &by.username } else { &by.display_name };
        inner.append(
            &gtk::Label::builder()
                .label(tf("workflows.form_answered_by", &[("name", name)]))
                .xalign(0.0)
                .css_classes(["workflow-form-answered"])
                .build(),
        );
    } else if !workflows::form_open(&form, now) {
        inner.append(
            &gtk::Label::builder()
                .label(t("workflows.form_expired"))
                .xalign(0.0)
                .css_classes(["dim-label", "workflow-form-expired"])
                .build(),
        );
    } else if workflows::can_answer(&form, me, now) {
        let answer = gtk::Button::builder()
            .label(t("workflows.form_answer"))
            .halign(gtk::Align::Start)
            .margin_top(4)
            .css_classes(["suggested-action", "pill", "workflow-form-answer"])
            .build();
        let (session, room, message) = (session.clone(), room.to_owned(), message.to_owned());
        answer.connect_clicked(move |button| {
            open(button.upcast_ref(), &session, &room, &message, &form);
        });
        inner.append(&answer);
    }
    card.upcast()
}

/// How one field's answer is read back.
enum Input {
    Line(adw::EntryRow),
    Text(gtk::TextView),
    /// The choices shown, after "Choose…" when the field is optional.
    Choice(adw::ComboRow, Vec<String>),
    /// What is ticked: user ids for a person, option texts for a choice of
    /// several answers. One at most unless the field is `multiple`.
    Picked(Rc<RefCell<Vec<String>>>),
}

impl Input {
    fn value(&self) -> FormAnswer {
        match self {
            Input::Line(row) => FormAnswer::One(row.text().to_string()),
            Input::Text(view) => {
                let buffer = view.buffer();
                FormAnswer::One(buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string())
            }
            Input::Choice(row, options) => {
                FormAnswer::One(options.get(row.selected() as usize).cloned().unwrap_or_default())
            }
            Input::Picked(picked) => FormAnswer::Many(picked.borrow().clone()),
        }
    }
}

fn label(field: &FormField) -> String {
    if field.required { format!("{} *", field.label) } else { field.label.clone() }
}

fn input(field: &FormField, form: &WorkflowForm, session: &Arc<NativeSession>, room: &str) -> (gtk::Widget, Input) {
    match field.kind {
        FormFieldKind::Person => person(field, form, session, room),
        FormFieldKind::Choice if field.multiple => {
            let picked = Rc::new(RefCell::new(Vec::new()));
            let expander = adw::ExpanderRow::builder().title(label(field)).expanded(true).build();
            expander.add_css_class("workflow-form-field");
            for option in &field.options {
                expander.add_row(&pick_row(option, None, None, &picked, option));
            }
            (expander.upcast(), Input::Picked(picked))
        }
        FormFieldKind::Text | FormFieldKind::Number => {
            let row = adw::EntryRow::builder().title(label(field)).build();
            row.add_css_class("workflow-form-field");
            if field.kind == FormFieldKind::Number {
                row.set_input_purpose(gtk::InputPurpose::Number);
            }
            (row.clone().upcast(), Input::Line(row))
        }
        FormFieldKind::LongText => {
            let view = gtk::TextView::builder()
                .wrap_mode(gtk::WrapMode::WordChar)
                .accepts_tab(false)
                .top_margin(6)
                .bottom_margin(6)
                .left_margin(6)
                .right_margin(6)
                .height_request(96)
                .build();
            view.add_css_class("workflow-form-field");
            let column = gtk::Box::builder()
                .orientation(gtk::Orientation::Vertical)
                .spacing(4)
                .margin_top(8)
                .margin_bottom(8)
                .margin_start(12)
                .margin_end(12)
                .build();
            column.append(
                &gtk::Label::builder().label(label(field)).xalign(0.0).css_classes(["caption", "dim-label"]).build(),
            );
            column.append(&gtk::Frame::builder().child(&view).build());
            let row = adw::PreferencesRow::builder().activatable(false).focusable(false).child(&column).build();
            (row.upcast(), Input::Text(view))
        }
        FormFieldKind::Choice => {
            let mut options = Vec::new();
            if !field.required {
                options.push(String::new());
            }
            options.extend(field.options.iter().cloned());
            let names: Vec<&str> =
                options.iter().map(|o| if o.is_empty() { t("workflows.form_choose") } else { o.as_str() }).collect();
            let row = adw::ComboRow::builder().title(label(field)).model(&gtk::StringList::new(&names)).build();
            row.add_css_class("workflow-form-field");
            (row.clone().upcast(), Input::Choice(row, options))
        }
    }
}

/// A person field: its people as single-choice rows, or, with no list, the
/// room's members, read as the dialog opens, with a search entry.
fn person(field: &FormField, form: &WorkflowForm, session: &Arc<NativeSession>, room: &str) -> (gtk::Widget, Input) {
    let chosen = Rc::new(RefCell::new(Vec::<String>::new()));
    let multiple = field.multiple;
    let expander = adw::ExpanderRow::builder().title(label(field)).expanded(true).build();
    expander.add_css_class("workflow-form-field");
    expander.add_css_class("workflow-form-person");
    // Each person's row and what a search looks in.
    let rows: Rc<RefCell<Vec<(adw::ActionRow, String)>>> = Rc::default();
    let fill = {
        let (expander, chosen, rows) = (expander.downgrade(), chosen.clone(), rows.clone());
        move |people: Vec<workflows::User>| {
            let Some(expander) = expander.upgrade() else { return };
            // Radios share a group; checkboxes (several answers) do not.
            let mut leader: Option<gtk::CheckButton> = None;
            for user in people {
                let name = workflows::person_name(&user);
                let row = pick_row(&name, Some(&format!("@{}", user.username)), leader.as_ref(), &chosen, &user.id);
                row.add_css_class("workflow-form-person-row");
                if !multiple && leader.is_none() {
                    leader = row.activatable_widget().and_downcast::<gtk::CheckButton>();
                }
                expander.add_row(&row);
                let haystack = format!("{} {}", name, user.username).to_lowercase();
                rows.borrow_mut().push((row, haystack));
            }
        }
    };
    match workflows::field_people(form, field) {
        Some(people) => fill(people),
        None => {
            let search = gtk::SearchEntry::builder()
                .placeholder_text(t("workflows.people_search"))
                .margin_top(6)
                .margin_bottom(6)
                .margin_start(12)
                .margin_end(12)
                .build();
            search.add_css_class("workflow-form-person-search");
            let filter_rows = rows.clone();
            search.connect_search_changed(move |entry| {
                let query = entry.text().trim().to_lowercase();
                for (row, haystack) in filter_rows.borrow().iter() {
                    row.set_visible(query.is_empty() || haystack.contains(&query));
                }
            });
            expander.add_row(&gtk::ListBoxRow::builder().activatable(false).child(&search).build());
            let (s, room) = (session.clone(), room.to_owned());
            glib::spawn_future_local(async move {
                if let Ok(members) = on_tokio(async move { s.form_members(&room).await }).await {
                    fill(members);
                }
            });
        }
    }
    (expander.upcast(), Input::Picked(chosen))
}

/// One pickable row: a radio in `group`'s group, or a checkbox without one.
/// Ticking it puts `value` in `picked`, unticking takes it out.
fn pick_row(
    title: &str,
    subtitle: Option<&str>,
    group: Option<&gtk::CheckButton>,
    picked: &Rc<RefCell<Vec<String>>>,
    value: &str,
) -> adw::ActionRow {
    let row = adw::ActionRow::builder().title(title).use_markup(false).activatable(true).build();
    if let Some(subtitle) = subtitle {
        row.set_subtitle(subtitle);
    }
    let check = gtk::CheckButton::builder().valign(gtk::Align::Center).build();
    check.add_css_class("workflow-form-pick");
    check.set_group(group);
    // A radio leaving its group's choice is toggled off too: the list
    // follows every box, so it holds one value for radios.
    let (picked, value) = (picked.clone(), value.to_owned());
    check.connect_toggled(move |check| {
        let mut list = picked.borrow_mut();
        list.retain(|v| *v != value);
        if check.is_active() {
            list.push(value.clone());
        }
    });
    row.add_prefix(&check);
    row.set_activatable_widget(Some(&check));
    row
}

/// The answer dialog: one row per field, then Submit. A click outside closes
/// it, like Escape, with nothing sent.
pub(crate) fn open(
    parent: &gtk::Widget,
    session: &Arc<NativeSession>,
    room: &str,
    message: &str,
    form: &WorkflowForm,
) -> adw::Dialog {
    let group = adw::PreferencesGroup::new();
    let mut inputs = Vec::new();
    for field in &form.fields {
        let (row, read) = input(field, form, session, room);
        group.add(&row);
        inputs.push((field.id.clone(), read));
    }
    let submit = gtk::Button::builder()
        .label(t("workflows.form_submit"))
        .halign(gtk::Align::End)
        .css_classes(["suggested-action", "pill", "workflow-form-submit"])
        .build();
    let content = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(18)
        .margin_top(12)
        .margin_bottom(24)
        .margin_start(24)
        .margin_end(24)
        .build();
    content.append(&group);
    content.append(&submit);
    let toasts = adw::ToastOverlay::new();
    toasts.set_child(Some(
        &gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_height(true)
            .child(&content)
            .build(),
    ));
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(&toasts));
    let dialog = adw::Dialog::builder().title(&form.title).content_width(480).child(&view).build();
    dialog.add_css_class("workflow-form-dialog");
    let inputs = Rc::new(RefCell::new(inputs));
    // Weak: the dialog and the toasts hold this button.
    let (session, message, weak, toasts) =
        (session.clone(), message.to_owned(), dialog.downgrade(), toasts.downgrade());
    submit.connect_clicked(move |button| {
        let answers: BTreeMap<String, FormAnswer> =
            inputs.borrow().iter().map(|(id, read)| (id.clone(), read.value())).collect();
        let (s, message, weak, toasts) = (session.clone(), message.clone(), weak.clone(), toasts.clone());
        button.set_sensitive(false);
        let button = button.clone();
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { s.answer_form(&message, &answers).await }).await;
            let (Some(dialog), Some(toasts)) = (weak.upgrade(), toasts.upgrade()) else { return };
            button.set_sensitive(true);
            match result {
                Ok(()) => {
                    dialog.close();
                }
                Err(error) => toasts.add_toast(adw::Toast::new(t(workflows::failure_key(&error)))),
            }
        });
    });
    widgets::present(&dialog, Some(parent));
    dialog
}
