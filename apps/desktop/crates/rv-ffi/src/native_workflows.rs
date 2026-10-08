//! Workflows (RFC 0004): my workflows, their editor's helpers and run
//! history, and the answer to a form, over rv-core's `native::workflows`.
//! Kinds cross as their wire names (`command`, `long_text`...). A webhook URL
//! crosses once, from `workflow_webhook`, and nothing here keeps it.
use std::collections::{BTreeMap, HashMap};

use crate::{model::RvError, native::NativeChat, native::native_error, on_tokio};
use rv_core::native::workflows::{
    self, Draft, Every, FormField, FormFieldKind, FormRecipient, HttpHeader, HttpMethod, RunState, Step, Trigger,
    WaitUnit, Workflow, WorkflowForm, WorkflowRun,
};

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeWorkflowUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
}

/// What starts a run. `every` is `hour`, `day` or `week`; `days` 1 Monday to
/// 7 Sunday; `room` a room id; `emoji` None: any reaction; `contains` the
/// text a message must contain, ignoring case.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NativeWorkflowTrigger {
    Command { name: String },
    Schedule { every: String, time: String, days: Vec<u8>, timezone: String, room: String },
    MemberJoined { room: String },
    ReactionAdded { room: String, emoji: Option<String> },
    MessagePosted { room: String, contains: String },
    Webhook,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeHttpHeader {
    pub name: String,
    pub value: String,
}

/// A form's field; `kind` is `text`, `long_text`, `number`, `choice` or
/// `person`. A person field's `people` are user ids (at most 50); empty:
/// any member of the form's room. Its answer is a user id.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeFormField {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub options: Vec<String>,
    pub people: Vec<String>,
    pub required: bool,
}

/// One step. `room` is `trigger` or a room id; a message's `cards` are its
/// integration cards as JSON, kept as they are (the editor does not change
/// them); `method` is `GET` `POST` `PUT` `PATCH` `DELETE`; `recipient` is
/// `trigger_user` or `anyone`.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum NativeWorkflowStep {
    Message {
        room: String,
        text: String,
        in_thread: bool,
        save_as: Option<String>,
        cards: String,
    },
    Wait {
        seconds: u64,
    },
    Http {
        method: String,
        url: String,
        headers: Vec<NativeHttpHeader>,
        body: Option<String>,
        save_as: Option<String>,
        continue_on_error: bool,
    },
    Form {
        room: String,
        recipient: String,
        title: String,
        fields: Vec<NativeFormField>,
        save_as: String,
    },
}

/// A run; `state` is `pending`, `waiting`, `done`, `failed` or `cancelled`,
/// `text` the line the history shows (state, step, why it failed).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeWorkflowRun {
    pub id: String,
    pub state: String,
    pub step: u32,
    pub error: Option<String>,
    pub text: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeWorkflow {
    pub id: String,
    pub owner: NativeWorkflowUser,
    pub bot: NativeWorkflowUser,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub trigger: NativeWorkflowTrigger,
    pub steps: Vec<NativeWorkflowStep>,
    pub revision: String,
    pub has_webhook: bool,
    pub next_fire_at: Option<String>,
    pub last_run: Option<NativeWorkflowRun>,
    /// The trigger in words, its rooms named.
    pub summary: String,
    pub created_at: String,
    pub updated_at: String,
}

/// The whole definition the editor saves.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeWorkflowDraft {
    pub name: String,
    pub description: String,
    pub bot_id: String,
    pub enabled: bool,
    pub trigger: NativeWorkflowTrigger,
    pub steps: Vec<NativeWorkflowStep>,
}

/// A plaintext room a trigger or a step may name.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeRoomChoice {
    pub id: String,
    /// `#name`, or `@name` for a direct conversation.
    pub label: String,
}

/// A wait as it is typed: a value and a unit (`seconds`, `minutes`, `hours`, `days`).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct NativeWaitParts {
    pub value: u64,
    pub unit: String,
}

/// The form a message carries, as the card shows it.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FormItem {
    pub title: String,
    /// The username of the only person who may answer; None: any member.
    pub recipient: Option<String>,
    /// Who answered, by display name (else username).
    pub answered_by: Option<String>,
    /// Open, and mine or anyone's.
    pub can_answer: bool,
    /// Past its date and unanswered.
    pub expired: bool,
    pub fields: Vec<NativeFormField>,
    /// The people the person fields name, to show them.
    pub people: Vec<NativeWorkflowUser>,
}

fn user(u: workflows::User) -> NativeWorkflowUser {
    NativeWorkflowUser { id: u.id, username: u.username, display_name: u.display_name }
}

fn every_name(every: Every) -> &'static str {
    match every {
        Every::Hour => "hour",
        Every::Day => "day",
        Every::Week => "week",
    }
}

fn kind_name(kind: FormFieldKind) -> &'static str {
    match kind {
        FormFieldKind::Text => "text",
        FormFieldKind::LongText => "long_text",
        FormFieldKind::Number => "number",
        FormFieldKind::Choice => "choice",
        FormFieldKind::Person => "person",
    }
}

fn kind_of(name: &str) -> FormFieldKind {
    match name {
        "long_text" => FormFieldKind::LongText,
        "number" => FormFieldKind::Number,
        "choice" => FormFieldKind::Choice,
        "person" => FormFieldKind::Person,
        _ => FormFieldKind::Text,
    }
}

fn method_of(name: &str) -> HttpMethod {
    match name.to_ascii_uppercase().as_str() {
        "POST" => HttpMethod::Post,
        "PUT" => HttpMethod::Put,
        "PATCH" => HttpMethod::Patch,
        "DELETE" => HttpMethod::Delete,
        _ => HttpMethod::Get,
    }
}

fn unit_name(unit: WaitUnit) -> &'static str {
    match unit {
        WaitUnit::Seconds => "seconds",
        WaitUnit::Minutes => "minutes",
        WaitUnit::Hours => "hours",
        WaitUnit::Days => "days",
    }
}

fn unit_of(name: &str) -> WaitUnit {
    WaitUnit::ALL.into_iter().find(|u| unit_name(*u) == name).unwrap_or(WaitUnit::Seconds)
}

fn field(f: FormField) -> NativeFormField {
    NativeFormField {
        id: f.id,
        label: f.label,
        kind: kind_name(f.kind).into(),
        options: f.options,
        people: f.people,
        required: f.required,
    }
}

fn core_field(f: NativeFormField) -> FormField {
    FormField {
        id: f.id,
        label: f.label,
        kind: kind_of(&f.kind),
        options: f.options,
        people: f.people,
        required: f.required,
    }
}

pub(crate) fn trigger(t: Trigger) -> NativeWorkflowTrigger {
    match t {
        Trigger::Command { name } => NativeWorkflowTrigger::Command { name },
        Trigger::Schedule { every, time, days, timezone, room } => {
            NativeWorkflowTrigger::Schedule { every: every_name(every).into(), time, days, timezone, room }
        }
        Trigger::MemberJoined { room } => NativeWorkflowTrigger::MemberJoined { room },
        Trigger::ReactionAdded { room, emoji } => NativeWorkflowTrigger::ReactionAdded { room, emoji },
        Trigger::MessagePosted { room, contains } => NativeWorkflowTrigger::MessagePosted { room, contains },
        Trigger::Webhook {} => NativeWorkflowTrigger::Webhook,
    }
}

pub(crate) fn core_trigger(t: NativeWorkflowTrigger) -> Trigger {
    match t {
        NativeWorkflowTrigger::Command { name } => Trigger::Command { name },
        NativeWorkflowTrigger::Schedule { every, time, days, timezone, room } => Trigger::Schedule {
            every: match every.as_str() {
                "hour" => Every::Hour,
                "week" => Every::Week,
                _ => Every::Day,
            },
            time,
            days,
            timezone,
            room,
        },
        NativeWorkflowTrigger::MemberJoined { room } => Trigger::MemberJoined { room },
        NativeWorkflowTrigger::ReactionAdded { room, emoji } => Trigger::ReactionAdded { room, emoji },
        NativeWorkflowTrigger::MessagePosted { room, contains } => Trigger::MessagePosted { room, contains },
        NativeWorkflowTrigger::Webhook => Trigger::Webhook {},
    }
}

pub(crate) fn step(s: Step) -> NativeWorkflowStep {
    match s {
        Step::Message { room, text, cards, in_thread, save_as } => NativeWorkflowStep::Message {
            room,
            text,
            in_thread,
            save_as,
            cards: if cards.is_empty() { String::new() } else { serde_json::to_string(&cards).unwrap_or_default() },
        },
        Step::Wait { seconds } => NativeWorkflowStep::Wait { seconds },
        Step::Http { method, url, headers, body, save_as, continue_on_error } => NativeWorkflowStep::Http {
            method: method.as_str().into(),
            url,
            headers: headers.into_iter().map(|h| NativeHttpHeader { name: h.name, value: h.value }).collect(),
            body,
            save_as,
            continue_on_error,
        },
        Step::Form { room, recipient, title, fields, save_as } => NativeWorkflowStep::Form {
            room,
            recipient: match recipient {
                FormRecipient::TriggerUser => "trigger_user",
                FormRecipient::Anyone => "anyone",
            }
            .into(),
            title,
            fields: fields.into_iter().map(field).collect(),
            save_as,
        },
    }
}

pub(crate) fn core_step(s: NativeWorkflowStep) -> Step {
    let named = |name: Option<String>| name.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty());
    match s {
        NativeWorkflowStep::Message { room, text, in_thread, save_as, cards } => Step::Message {
            room,
            text,
            cards: serde_json::from_str(&cards).unwrap_or_default(),
            in_thread,
            save_as: named(save_as),
        },
        NativeWorkflowStep::Wait { seconds } => Step::Wait { seconds },
        NativeWorkflowStep::Http { method, url, headers, body, save_as, continue_on_error } => Step::Http {
            method: method_of(&method),
            url: url.trim().to_owned(),
            headers: headers
                .into_iter()
                .filter(|h| !h.name.trim().is_empty())
                .map(|h| HttpHeader { name: h.name.trim().to_owned(), value: h.value })
                .collect(),
            body: body.filter(|b| !b.is_empty()),
            save_as: named(save_as),
            continue_on_error,
        },
        NativeWorkflowStep::Form { room, recipient, title, fields, save_as } => Step::Form {
            room,
            recipient: if recipient == "trigger_user" { FormRecipient::TriggerUser } else { FormRecipient::Anyone },
            title,
            fields: fields.into_iter().map(core_field).collect(),
            save_as: save_as.trim().to_owned(),
        },
    }
}

fn state_name(state: RunState) -> &'static str {
    match state {
        RunState::Pending => "pending",
        RunState::Waiting => "waiting",
        RunState::Done => "done",
        RunState::Failed => "failed",
        RunState::Cancelled => "cancelled",
    }
}

fn run(r: WorkflowRun) -> NativeWorkflowRun {
    NativeWorkflowRun {
        text: workflows::run_text(&r),
        id: r.id,
        state: state_name(r.state).into(),
        step: r.step,
        error: r.error,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

fn draft(d: NativeWorkflowDraft) -> Draft {
    Draft {
        name: d.name,
        description: d.description,
        bot_id: d.bot_id,
        enabled: d.enabled,
        trigger: core_trigger(d.trigger),
        steps: d.steps.into_iter().map(core_step).collect(),
    }
}

/// The form a message row carries, for `me` (a user id).
pub(crate) fn form_item(form: WorkflowForm, me: &str) -> FormItem {
    let now = chrono::Utc::now();
    FormItem {
        can_answer: workflows::can_answer(&form, me, now),
        expired: form.answered_by.is_none() && !workflows::form_open(&form, now),
        title: form.title,
        recipient: form.recipient.map(|r| r.username),
        answered_by: form
            .answered_by
            .map(|u| if u.display_name.trim().is_empty() { u.username } else { u.display_name }),
        fields: form.fields.into_iter().map(field).collect(),
        people: form.people.into_iter().map(user).collect(),
    }
}

impl NativeChat {
    fn workflow(&self, w: Workflow) -> NativeWorkflow {
        let session = self.session.clone();
        let summary = workflows::trigger_summary(&w.trigger, &|id| session.workflow_room_label(id));
        NativeWorkflow {
            id: w.id,
            owner: user(w.owner),
            bot: user(w.bot),
            name: w.name,
            description: w.description,
            enabled: w.enabled,
            trigger: trigger(w.trigger),
            steps: w.steps.into_iter().map(step).collect(),
            revision: w.revision,
            has_webhook: w.has_webhook,
            next_fire_at: w.next_fire_at,
            last_run: w.last_run.map(run),
            summary,
            created_at: w.created_at,
            updated_at: w.updated_at,
        }
    }
}

#[uniffi::export]
impl NativeChat {
    /// The server offers workflows.
    pub fn workflows_supported(&self) -> bool {
        self.session.workflows_supported()
    }
    /// Who may create a bot may create a workflow.
    pub async fn can_create_workflow(&self) -> Result<bool, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.can_create_workflow().await }).await.map_err(native_error)
    }
    pub async fn workflows(&self) -> Result<Vec<NativeWorkflow>, RvError> {
        let s = self.session.clone();
        let list = on_tokio(async move { s.workflows().await }).await.map_err(native_error)?;
        Ok(list.into_iter().map(|w| self.workflow(w)).collect())
    }
    pub async fn get_workflow(&self, id: String) -> Result<NativeWorkflow, RvError> {
        let s = self.session.clone();
        let found = on_tokio(async move { s.workflow(&id).await }).await.map_err(native_error)?;
        Ok(self.workflow(found))
    }
    pub async fn create_workflow(&self, draft: NativeWorkflowDraft) -> Result<NativeWorkflow, RvError> {
        let (s, input) = (self.session.clone(), self::draft(draft));
        let made = on_tokio(async move { s.create_workflow(&input).await }).await.map_err(native_error)?;
        Ok(self.workflow(made))
    }
    /// The whole definition at `revision`; `revision_conflict` when it moved.
    pub async fn update_workflow(
        &self,
        id: String,
        revision: String,
        draft: NativeWorkflowDraft,
    ) -> Result<NativeWorkflow, RvError> {
        let (s, input) = (self.session.clone(), self::draft(draft));
        let saved =
            on_tokio(async move { s.update_workflow(&id, &revision, &input).await }).await.map_err(native_error)?;
        Ok(self.workflow(saved))
    }
    pub async fn delete_workflow(&self, id: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.delete_workflow(&id).await }).await.map_err(native_error)
    }
    /// Turns it off and cancels its unfinished runs.
    pub async fn disable_workflow(&self, id: String) -> Result<NativeWorkflow, RvError> {
        let s = self.session.clone();
        let off = on_tokio(async move { s.disable_workflow(&id).await }).await.map_err(native_error)?;
        Ok(self.workflow(off))
    }
    /// The webhook URL, once. Needs a recent sign-in (`reauthentication_required`).
    pub async fn workflow_webhook(&self, id: String) -> Result<String, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.workflow_webhook(&id).await }).await.map_err(native_error)
    }
    pub async fn workflow_runs(&self, id: String) -> Result<Vec<NativeWorkflowRun>, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.workflow_runs(&id).await })
            .await
            .map_err(native_error)?
            .into_iter()
            .map(run)
            .collect())
    }
    /// Starts a run now; its id.
    pub async fn test_workflow(&self, id: String) -> Result<String, RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.test_workflow(&id).await }).await.map_err(native_error)
    }
    /// Answers the form `message` carries, field id to text.
    pub async fn answer_form(&self, message: String, answers: HashMap<String, String>) -> Result<(), RvError> {
        let (s, answers): (_, BTreeMap<_, _>) = (self.session.clone(), answers.into_iter().collect());
        on_tokio(async move { s.answer_form(&message, &answers).await }).await.map_err(native_error)
    }
    /// The people a person field may list: no bot, no deleted account.
    pub async fn workflow_people(&self) -> Result<Vec<NativeWorkflowUser>, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.workflow_people().await })
            .await
            .map_err(native_error)?
            .into_iter()
            .map(user)
            .collect())
    }
    /// The members of `room` a person field with no list offers when answering.
    pub async fn form_members(&self, room: String) -> Result<Vec<NativeWorkflowUser>, RvError> {
        let s = self.session.clone();
        Ok(on_tokio(async move { s.form_members(&room).await })
            .await
            .map_err(native_error)?
            .into_iter()
            .map(user)
            .collect())
    }
    /// The plaintext rooms a trigger or a step may name.
    pub fn workflow_rooms(&self) -> Vec<NativeRoomChoice> {
        self.session.workflow_rooms().into_iter().map(|r| NativeRoomChoice { id: r.id, label: r.label }).collect()
    }
    /// A room id in words: its label, "the trigger's room", or "no room chosen".
    pub fn workflow_room_label(&self, id: String) -> String {
        self.session.workflow_room_label(&id)
    }
    pub fn workflow_trigger_summary(&self, trigger: NativeWorkflowTrigger) -> String {
        let s = self.session.clone();
        workflows::trigger_summary(&core_trigger(trigger), &|id| s.workflow_room_label(id))
    }
    pub fn workflow_step_summary(&self, step: NativeWorkflowStep) -> String {
        let s = self.session.clone();
        workflows::step_summary(&core_step(step), &|id| s.workflow_room_label(id))
    }
}

/// The i18n key of the text for a workflow refusal's code and HTTP status
/// (0: no answer), as the GTK app shows it.
#[uniffi::export]
pub fn workflow_error_key(code: String, status: u16) -> String {
    workflows::error_key(&code, status).to_owned()
}

/// Why a run failed, from its step's code, in words.
#[uniffi::export]
pub fn workflow_run_error_text(code: String) -> String {
    workflows::run_error_text(&code)
}

/// The variables the step at `index` may use, without their braces.
#[uniffi::export]
pub fn workflow_variables(trigger: NativeWorkflowTrigger, steps: Vec<NativeWorkflowStep>, index: u32) -> Vec<String> {
    let steps: Vec<Step> = steps.into_iter().map(core_step).collect();
    workflows::variables(&core_trigger(trigger), &steps, index as usize)
}

/// `{{variable}}`, as a template writes it.
#[uniffi::export]
pub fn workflow_placeholder(variable: String) -> String {
    workflows::placeholder(&variable)
}

/// A field id or a result name from a label, unique among `taken`.
#[uniffi::export]
pub fn workflow_identifier(label: String, taken: Vec<String>) -> String {
    workflows::identifier(&label, &taken)
}

/// Every wait unit's name, smallest first.
#[uniffi::export]
pub fn workflow_wait_units() -> Vec<String> {
    WaitUnit::ALL.into_iter().map(|u| unit_name(u).to_owned()).collect()
}

/// The i18n key of a wait unit's name.
#[uniffi::export]
pub fn workflow_wait_unit_key(unit: String) -> String {
    unit_of(&unit).key().to_owned()
}

/// `value` `unit`s in seconds, 1 s to 30 days.
#[uniffi::export]
pub fn workflow_wait_seconds(value: u64, unit: String) -> u64 {
    workflows::wait_seconds(value, unit_of(&unit))
}

/// A wait as it is typed back: the largest whole unit.
#[uniffi::export]
pub fn workflow_wait_parts(seconds: u64) -> NativeWaitParts {
    let (value, unit) = workflows::wait_parts(seconds);
    NativeWaitParts { value, unit: unit_name(unit).into() }
}

/// What a new step of `kind` (`message`, `wait`, `http`, `form`) starts as.
#[uniffi::export]
pub fn workflow_new_step(
    kind: String,
    trigger: NativeWorkflowTrigger,
    steps: Vec<NativeWorkflowStep>,
) -> Option<NativeWorkflowStep> {
    let steps: Vec<Step> = steps.into_iter().map(core_step).collect();
    workflows::new_step(&kind, &core_trigger(trigger), &steps).map(step)
}

/// The trigger kinds' wire names, in the order the editor offers them.
#[uniffi::export]
pub fn workflow_trigger_kinds() -> Vec<String> {
    workflows::TRIGGER_KINDS.iter().map(|k| (*k).to_owned()).collect()
}

/// Whether the trigger names a person, who may then answer a form
/// (`recipient: trigger_user`).
#[uniffi::export]
pub fn workflow_trigger_has_person(trigger: NativeWorkflowTrigger) -> bool {
    workflows::has_person(&core_trigger(trigger))
}

/// A trigger of `kind` (`command`, `schedule`, `member_joined`,
/// `reaction_added`, `message_posted`, `webhook`),
/// keeping the room `current` names.
#[uniffi::export]
pub fn workflow_new_trigger(kind: String, current: NativeWorkflowTrigger) -> Option<NativeWorkflowTrigger> {
    workflows::new_trigger(&kind, &core_trigger(current)).map(trigger)
}

/// The IANA name of this machine's time zone.
#[uniffi::export]
pub fn workflow_system_time_zone() -> String {
    workflows::system_time_zone()
}

/// The i18n key of a weekday's short name, 1 Monday to 7 Sunday.
#[uniffi::export]
pub fn workflow_day_key(day: u8) -> String {
    workflows::day_key(day).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_cross_and_come_back_unchanged() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
        let workflow: Workflow = serde_json::from_value(fixture["workflows"]["workflow"].clone()).unwrap();
        let crossed: Vec<Step> = workflow.steps.clone().into_iter().map(step).map(core_step).collect();
        assert_eq!(crossed, workflow.steps);
        assert_eq!(core_trigger(trigger(workflow.trigger.clone())), workflow.trigger);
        let schedule: Trigger =
            serde_json::from_value(fixture["workflows"]["create_workflow"]["trigger"].clone()).unwrap();
        assert_eq!(core_trigger(trigger(schedule.clone())), schedule);
        assert_eq!(core_trigger(NativeWorkflowTrigger::Webhook), Trigger::Webhook {});
        for kind in workflow_trigger_kinds() {
            let made = workflow_new_trigger(kind, NativeWorkflowTrigger::MemberJoined { room: "r".into() }).unwrap();
            assert_eq!(trigger(core_trigger(made.clone())), made);
        }
        assert!(workflow_trigger_has_person(NativeWorkflowTrigger::ReactionAdded { room: "r".into(), emoji: None }));
        assert!(!workflow_trigger_has_person(NativeWorkflowTrigger::Webhook));
    }

    #[test]
    fn helpers_cross_by_their_wire_names() {
        assert_eq!(workflow_error_key("revision_conflict".into(), 409), "workflows.error_conflict");
        assert_eq!(workflow_wait_units(), ["seconds", "minutes", "hours", "days"]);
        assert_eq!(workflow_wait_seconds(5, "minutes".into()), 300);
        assert_eq!(workflow_wait_parts(7200), NativeWaitParts { value: 2, unit: "hours".into() });
        assert_eq!(workflow_wait_unit_key("days".into()), "workflows.unit.days");
        assert_eq!(workflow_identifier("Today".into(), vec!["today".into()]), "today_2");
        assert_eq!(workflow_placeholder("now".into()), "{{now}}");
        let Some(NativeWorkflowStep::Wait { seconds }) =
            workflow_new_step("wait".into(), NativeWorkflowTrigger::Webhook, vec![])
        else {
            panic!()
        };
        assert_eq!(seconds, 60);
        assert!(matches!(
            workflow_new_trigger("member_joined".into(), NativeWorkflowTrigger::Webhook),
            Some(NativeWorkflowTrigger::MemberJoined { .. })
        ));
        assert_eq!(
            workflow_variables(NativeWorkflowTrigger::Webhook, vec![], 0),
            vec!["webhook".to_owned(), "now".to_owned()]
        );
        // An empty header name and an empty result name are dropped, not sent.
        let http = core_step(NativeWorkflowStep::Http {
            method: "post".into(),
            url: " https://example.org ".into(),
            headers: vec![NativeHttpHeader { name: " ".into(), value: "x".into() }],
            body: Some(String::new()),
            save_as: Some(" ".into()),
            continue_on_error: false,
        });
        assert_eq!(
            http,
            Step::Http {
                method: HttpMethod::Post,
                url: "https://example.org".into(),
                headers: vec![],
                body: None,
                save_as: None,
                continue_on_error: false,
            }
        );
    }

    #[test]
    fn a_form_shows_who_may_answer() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
        let mut form: WorkflowForm = serde_json::from_value(fixture["workflows"]["workflow_form"].clone()).unwrap();
        form.expires_at = (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        let mine = form_item(form.clone(), "alice-id");
        assert!(mine.can_answer && !mine.expired);
        assert_eq!(mine.recipient.as_deref(), Some("alice"));
        assert_eq!(mine.fields[0].kind, "long_text");
        assert!(!form_item(form.clone(), "bob-id").can_answer);
        form.expires_at = "2020-01-01T00:00:00+00:00".into();
        let late = form_item(form, "alice-id");
        assert!(late.expired && !late.can_answer);
    }
}
