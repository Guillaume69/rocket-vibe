//! Workflows (RFC 0004, `docs/protocol/WORKFLOWS.md`): a trigger starts a run
//! of steps acting through one of my bots. The calls, and what both desktop
//! editors share: the wording of every refusal, a trigger and a step in
//! words, the variables a step may use, field ids, wait units, the webhook
//! URL, and the checks of a form's answers. A webhook secret comes back once,
//! from `workflow_webhook`, and nothing here keeps it.
use std::collections::BTreeMap;

use super::{Error, NativeSession, room_operation_id};
pub use rv_protocol::User;
pub use rv_protocol::workflows::{
    DESCRIPTION_BYTES, Every, FORM_FIELDS, FormAnswer, FormField, FormFieldKind, FormRecipient, HTTP_HEADERS,
    HttpHeader, HttpMethod, MATCH_BYTES, NAME_BYTES, PEOPLE_PER_FIELD, RunState, STEPS_PER_WORKFLOW, Step,
    TRIGGER_ROOM, Trigger, WAIT_SECONDS, Workflow, WorkflowForm, WorkflowRun,
};

use crate::i18n::{t, tf};

/// Names the server keeps for itself, never a `save_as` nor a field id.
const RESERVED: [&str; 3] = ["trigger", "webhook", "now"];
/// The longest `save_as`, field id or command name.
const IDENTIFIER: usize = 32;
/// A short answer's and a long answer's longest text, in bytes.
const TEXT_ANSWER: usize = 1024;
const LONG_ANSWER: usize = 4096;

/// A workflow's whole definition, as the editor holds it.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub name: String,
    pub description: String,
    pub bot_id: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub steps: Vec<Step>,
}

impl Draft {
    /// A new workflow on `bot_id`: a command, no step yet, on.
    pub fn new(bot_id: &str) -> Self {
        Draft {
            name: String::new(),
            description: String::new(),
            bot_id: bot_id.into(),
            enabled: true,
            trigger: Trigger::Command { name: String::new() },
            steps: Vec::new(),
        }
    }
    pub fn of(workflow: &Workflow) -> Self {
        Draft {
            name: workflow.name.clone(),
            description: workflow.description.clone(),
            bot_id: workflow.bot.id.clone(),
            enabled: workflow.enabled,
            trigger: workflow.trigger.clone(),
            steps: workflow.steps.clone(),
        }
    }
    /// Trimmed as the server stores it: a command loses the `/` typed before
    /// its name, an emoji its colons, a header without a name is dropped, an
    /// empty result name or body is none, and "in the trigger's thread" stays
    /// only where a trigger has a thread (a reaction, a message). Then
    /// `draft_problem` is checked: `invalid_request` for a missing name, else
    /// the code of what the server would refuse.
    pub fn normalized(&self) -> Result<Self, Error> {
        let mut draft = self.clone();
        draft.name = draft.name.trim().to_owned();
        draft.description = draft.description.trim().to_owned();
        if draft.name.is_empty()
            || draft.name.len() > NAME_BYTES
            || draft.description.len() > DESCRIPTION_BYTES
            || draft.bot_id.is_empty()
        {
            return Err(Error::Protocol("invalid_request"));
        }
        match &mut draft.trigger {
            Trigger::Command { name } => *name = name.trim().trim_start_matches('/').to_ascii_lowercase(),
            Trigger::ReactionAdded { emoji, .. } => {
                *emoji = emoji.as_deref().map(|e| e.trim().trim_matches(':').to_owned()).filter(|e| !e.is_empty());
            }
            Trigger::MessagePosted { contains, .. } => *contains = contains.trim().to_owned(),
            Trigger::Schedule { timezone, .. } => *timezone = timezone.trim().to_owned(),
            _ => {}
        }
        let threaded = has_thread(&draft.trigger);
        let named = |name: &mut Option<String>| {
            *name = name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(str::to_owned);
        };
        for step in &mut draft.steps {
            match step {
                Step::Message { in_thread, save_as, .. } => {
                    *in_thread &= threaded;
                    named(save_as);
                }
                Step::Http { url, headers, body, save_as, .. } => {
                    *url = url.trim().to_owned();
                    headers.retain(|h| !h.name.trim().is_empty());
                    for header in headers.iter_mut() {
                        header.name = header.name.trim().to_owned();
                    }
                    if body.as_deref().is_some_and(str::is_empty) {
                        *body = None;
                    }
                    named(save_as);
                }
                Step::Form { title, fields, save_as, .. } => {
                    *title = title.trim().to_owned();
                    *save_as = save_as.trim().to_owned();
                    for field in fields.iter_mut() {
                        field.label = field.label.trim().to_owned();
                        if field.kind != FormFieldKind::Choice {
                            field.options.clear();
                        }
                        if field.kind != FormFieldKind::Person {
                            field.people.clear();
                        }
                        field.multiple &= matches!(field.kind, FormFieldKind::Choice | FormFieldKind::Person);
                    }
                }
                Step::Wait { .. } => {}
            }
        }
        if let Some(code) = draft_problem(&draft) {
            return Err(Error::Protocol(code));
        }
        Ok(draft)
    }
}

/// What the server would refuse in a normalized draft, by its error code
/// (worded by `error_key`), checked before saving: a missing name, a trigger
/// without its settings, "the trigger's room" or "the person who triggered
/// it" under a trigger without one, the limits of steps, fields, headers and
/// people. None: nothing seen here, the server has the last word.
pub fn draft_problem(draft: &Draft) -> Option<&'static str> {
    if draft.name.trim().is_empty()
        || draft.name.len() > NAME_BYTES
        || draft.description.len() > DESCRIPTION_BYTES
        || draft.bot_id.is_empty()
    {
        return Some("invalid_request");
    }
    let trigger_room = match &draft.trigger {
        Trigger::Command { name } if name.trim().trim_start_matches('/').is_empty() => {
            return Some("workflow_command");
        }
        Trigger::MessagePosted { contains, .. } if contains.trim().is_empty() || contains.len() > MATCH_BYTES => {
            return Some("workflow_match");
        }
        Trigger::Schedule { time, timezone, .. } if time_parts(time).is_none() || timezone.trim().is_empty() => {
            return Some("workflow_schedule");
        }
        Trigger::Schedule { every: Every::Week, days, .. } if days.is_empty() => return Some("workflow_schedule"),
        Trigger::Schedule { room, .. }
        | Trigger::MemberJoined { room }
        | Trigger::ReactionAdded { room, .. }
        | Trigger::MessagePosted { room, .. }
            if room.is_empty() =>
        {
            return Some("workflow_room");
        }
        trigger => has_room(trigger),
    };
    if draft.steps.is_empty() || draft.steps.len() > STEPS_PER_WORKFLOW {
        return Some("workflow_steps");
    }
    let room_fits = |room: &str| !room.is_empty() && (room != TRIGGER_ROOM || trigger_room);
    for step in &draft.steps {
        match step {
            Step::Message { room, .. } | Step::Form { room, .. } if !room_fits(room) => return Some("workflow_room"),
            Step::Message { text, .. } if text.trim().is_empty() => return Some("workflow_message"),
            Step::Wait { seconds } if *seconds == 0 || *seconds > WAIT_SECONDS => return Some("workflow_wait"),
            Step::Http { url, headers, .. }
                if headers.len() > HTTP_HEADERS || !(url.starts_with("http://") || url.starts_with("https://")) =>
            {
                return Some("workflow_http");
            }
            Step::Form { recipient, title, fields, save_as, .. } => {
                let bad_field = |f: &FormField| {
                    f.label.trim().is_empty()
                        || f.kind == FormFieldKind::Choice && f.options.is_empty()
                        || f.people.len() > PEOPLE_PER_FIELD
                        || !valid_identifier(&f.id)
                };
                if *recipient == FormRecipient::TriggerUser && !has_person(&draft.trigger)
                    || title.trim().is_empty()
                    || fields.is_empty()
                    || fields.len() > FORM_FIELDS
                    || fields.iter().any(bad_field)
                    || !valid_identifier(save_as)
                {
                    return Some("workflow_form");
                }
            }
            _ => {}
        }
    }
    let saved = saved_names(&draft.steps);
    let mut unique = saved.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != saved.len() || saved.iter().any(|n| !valid_identifier(n)) {
        return Some("workflow_steps");
    }
    None
}

/// Whether the trigger has a thread a message step may answer in (a
/// reaction's or a message's).
pub fn has_thread(trigger: &Trigger) -> bool {
    matches!(trigger, Trigger::ReactionAdded { .. } | Trigger::MessagePosted { .. })
}

/// The plaintext rooms a step or a trigger may name, by name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomChoice {
    pub id: String,
    /// `#name` for a room, `@name` for a direct conversation.
    pub label: String,
}

impl NativeSession {
    /// The server offers workflows and this client handles them.
    pub fn workflows_supported(&self) -> bool {
        self.supported_features().iter().any(|f| f == "workflows")
    }
    fn workflow_access(&self) -> Result<(), Error> {
        self.ready()?;
        if !self.workflows_supported() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        Ok(())
    }
    /// Who may create a bot may create a workflow.
    pub async fn can_create_workflow(&self) -> Result<bool, Error> {
        self.workflow_access()?;
        let permissions = self.client.account_permissions().await?;
        self.ready()?;
        Ok(permissions.create_bot)
    }
    /// My workflows.
    pub async fn workflows(&self) -> Result<Vec<Workflow>, Error> {
        self.workflow_access()?;
        self.refresh_credentials().await?;
        self.workflow_access()?;
        let list = self.client.workflows(false).await?;
        self.ready()?;
        Ok(list.workflows)
    }
    pub async fn workflow(&self, id: &str) -> Result<Workflow, Error> {
        self.workflow_access()?;
        self.refresh_credentials().await?;
        self.workflow_access()?;
        let workflow = self.client.workflow(id).await?;
        self.ready()?;
        Ok(workflow)
    }
    pub async fn create_workflow(&self, draft: &Draft) -> Result<Workflow, Error> {
        self.workflow_access()?;
        let draft = draft.normalized()?;
        let input = rv_protocol::workflows::CreateWorkflow {
            operation_id: room_operation_id(),
            name: draft.name,
            description: draft.description,
            bot_id: draft.bot_id,
            trigger: draft.trigger,
            steps: draft.steps,
            enabled: draft.enabled,
        };
        self.refresh_credentials().await?;
        self.workflow_access()?;
        let workflow = self.client.create_workflow(&input).await?;
        self.ready()?;
        Ok(workflow)
    }
    /// The whole definition at `revision`; `revision_conflict` when it moved
    /// since: read it again before saving.
    pub async fn update_workflow(&self, id: &str, revision: &str, draft: &Draft) -> Result<Workflow, Error> {
        self.workflow_access()?;
        let draft = draft.normalized()?;
        let input = rv_protocol::workflows::UpdateWorkflow {
            operation_id: room_operation_id(),
            revision: revision.into(),
            name: draft.name,
            description: draft.description,
            bot_id: draft.bot_id,
            trigger: draft.trigger,
            steps: draft.steps,
            enabled: draft.enabled,
        };
        self.refresh_credentials().await?;
        self.workflow_access()?;
        let workflow = self.client.update_workflow(id, &input).await?;
        self.ready()?;
        Ok(workflow)
    }
    /// Deletes it and its runs; repeating it is harmless.
    pub async fn delete_workflow(&self, id: &str) -> Result<(), Error> {
        self.workflow_access()?;
        self.refresh_credentials().await?;
        self.workflow_access()?;
        self.client.delete_workflow(id).await?;
        self.ready()
    }
    /// Turns it off and cancels its unfinished runs.
    pub async fn disable_workflow(&self, id: &str) -> Result<Workflow, Error> {
        self.workflow_access()?;
        self.refresh_credentials().await?;
        self.workflow_access()?;
        let workflow = self.client.disable_workflow(id).await?;
        self.ready()?;
        Ok(workflow)
    }
    /// A new webhook URL, server address included: the only time it is shown,
    /// and the previous one stops working. Needs a recent sign-in
    /// (`reauthentication_required`).
    pub async fn workflow_webhook(&self, id: &str) -> Result<String, Error> {
        self.workflow_access()?;
        self.refresh_credentials().await?;
        self.workflow_access()?;
        let secret = self.client.workflow_webhook(id).await?;
        self.ready()?;
        if !secret.path.starts_with("/api/v1/hooks/") || secret.path.chars().any(char::is_whitespace) {
            return Err(Error::Protocol("invalid_request"));
        }
        Ok(webhook_url(&self.info.base_url, &secret.path))
    }
    /// The last 50 runs, newest first.
    pub async fn workflow_runs(&self, id: &str) -> Result<Vec<WorkflowRun>, Error> {
        self.workflow_access()?;
        self.refresh_credentials().await?;
        self.workflow_access()?;
        let list = self.client.workflow_runs(id).await?;
        self.ready()?;
        Ok(list.runs)
    }
    /// Starts a run now, with me as `trigger.user`; its id.
    pub async fn test_workflow(&self, id: &str) -> Result<String, Error> {
        self.workflow_access()?;
        self.refresh_credentials().await?;
        self.workflow_access()?;
        let started = self.client.test_workflow(id).await?;
        self.ready()?;
        Ok(started.run_id)
    }
    /// Answers the form `message` carries, field id to its answer (a list for
    /// a `multiple` field). Checked first against the form as stored, when it
    /// is (`form_required`, `form_value`), which also gives each field the
    /// shape it takes.
    pub async fn answer_form(&self, message: &str, answers: &BTreeMap<String, FormAnswer>) -> Result<(), Error> {
        self.workflow_access()?;
        let answers = match self.store.message_form(message)? {
            Some(form) => checked_answers(&form, answers).map_err(Error::Protocol)?,
            None => answers.clone(),
        };
        let input = rv_protocol::workflows::AnswerForm { operation_id: room_operation_id(), answers };
        self.refresh_credentials().await?;
        self.workflow_access()?;
        self.client.answer_form(message, &input).await?;
        // The answered form comes back through sync; ask for it now.
        self.wake.notify_one();
        self.ready()
    }
    /// The people a `person` field may list (`GET /api/v1/users`): no bot,
    /// no deleted account.
    pub async fn workflow_people(&self) -> Result<Vec<User>, Error> {
        self.workflow_access()?;
        Ok(people_only(self.users().await?))
    }
    /// The members of `room` a `person` field with no list offers: no bot,
    /// no deleted or disabled account. Reads every page (at most 50).
    pub async fn form_members(&self, room: &str) -> Result<Vec<User>, Error> {
        self.workflow_access()?;
        let (mut users, mut after) = (Vec::new(), None::<String>);
        for _ in 0..50 {
            let page = self.room_members(room, after.as_deref(), None).await?;
            users.extend(page.members.into_iter().filter(|m| !m.disabled).map(|m| m.user));
            match page.next {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        Ok(people_only(users))
    }
    /// The rooms a trigger or a step may name: the plaintext ones I see, by label.
    pub fn workflow_rooms(&self) -> Vec<RoomChoice> {
        let mut rooms: Vec<RoomChoice> = self
            .store
            .rooms()
            .unwrap_or_default()
            .into_iter()
            .filter(|room| !room.encrypted)
            .map(|room| RoomChoice { label: room_label(&room), id: room.id })
            .collect();
        rooms.sort_by_key(|room| room.label.to_lowercase());
        rooms
    }
    /// A room id as a trigger or step summary names it: its label when I
    /// see the room, "the trigger's room" for `trigger`, "no room" when
    /// none is chosen yet, else the id.
    pub fn workflow_room_label(&self, id: &str) -> String {
        if id == TRIGGER_ROOM {
            return t("workflows.room_trigger").to_owned();
        }
        if id.is_empty() {
            return t("workflows.room_none").to_owned();
        }
        self.store
            .rooms()
            .unwrap_or_default()
            .into_iter()
            .find(|room| room.id == id)
            .map_or_else(|| id.to_owned(), |room| room_label(&room))
    }
}

fn room_label(room: &rv_protocol::Room) -> String {
    let sigil = if room.kind == rv_protocol::RoomKind::Direct { '@' } else { '#' };
    format!("{sigil}{}", room.name)
}

/// The server's address followed by the path it answered.
pub fn webhook_url(base_url: &str, path: &str) -> String {
    format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// The IANA name of this machine's time zone (`Europe/Paris`); `UTC` when
/// the system does not say.
pub fn system_time_zone() -> String {
    iana_time_zone::get_timezone().ok().filter(|zone| !zone.is_empty()).unwrap_or_else(|| "UTC".into())
}

/// `HH:MM`, 00:00 to 23:59.
pub fn time_text(hour: u32, minute: u32) -> String {
    format!("{:02}:{:02}", hour.min(23), minute.min(59))
}

/// (hour, minute) of `HH:MM`; None when it is not one.
pub fn time_parts(text: &str) -> Option<(u32, u32)> {
    let (hour, minute) = text.split_once(':')?;
    if hour.len() != 2 || minute.len() != 2 {
        return None;
    }
    let (hour, minute) = (hour.parse().ok()?, minute.parse().ok()?);
    (hour < 24 && minute < 60).then_some((hour, minute))
}

/// A field id or a `save_as` from what a person typed: lower case, `[a-z0-9_]`,
/// at most 32 bytes, never a reserved name, and not one of `taken` (a
/// number is added: `name_2`).
pub fn identifier(label: &str, taken: &[String]) -> String {
    let mut id = String::new();
    for c in label.trim().chars().flat_map(char::to_lowercase) {
        let c = fold(c);
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            id.push(c);
        } else if !id.is_empty() && !id.ends_with('_') {
            id.push('_');
        }
    }
    let mut id = id.trim_end_matches('_').chars().take(IDENTIFIER).collect::<String>().trim_end_matches('_').to_owned();
    if id.is_empty() {
        id = "field".into();
    }
    if RESERVED.contains(&id.as_str()) {
        id.push_str("_1");
    }
    if !taken.contains(&id) {
        return id;
    }
    (2..)
        .map(|n| {
            let suffix = format!("_{n}");
            let stem: String = id.chars().take(IDENTIFIER - suffix.len()).collect();
            format!("{}{suffix}", stem.trim_end_matches('_'))
        })
        .find(|candidate| !taken.iter().any(|t| t == candidate))
        .unwrap_or(id)
}

/// The letter under an accent, for ids typed in French.
fn fold(c: char) -> char {
    match c {
        'à' | 'â' | 'ä' | 'á' | 'ã' | 'å' => 'a',
        'ç' => 'c',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'î' | 'ï' | 'í' | 'ì' => 'i',
        'ô' | 'ö' | 'ó' | 'ò' | 'õ' => 'o',
        'ù' | 'û' | 'ü' | 'ú' => 'u',
        'ÿ' | 'ý' => 'y',
        'ñ' => 'n',
        'œ' => 'o',
        'æ' => 'a',
        other => other,
    }
}

/// Whether the server would take `id` as a field id or a `save_as`.
pub fn valid_identifier(id: &str) -> bool {
    (1..=IDENTIFIER).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && !RESERVED.contains(&id)
}

/// The unit a wait is typed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitUnit {
    Seconds,
    Minutes,
    Hours,
    Days,
}

impl WaitUnit {
    pub const ALL: [WaitUnit; 4] = [WaitUnit::Seconds, WaitUnit::Minutes, WaitUnit::Hours, WaitUnit::Days];
    pub fn seconds(self) -> u64 {
        match self {
            WaitUnit::Seconds => 1,
            WaitUnit::Minutes => 60,
            WaitUnit::Hours => 3600,
            WaitUnit::Days => 86_400,
        }
    }
    /// The i18n key of its name in a menu.
    pub fn key(self) -> &'static str {
        match self {
            WaitUnit::Seconds => "workflows.unit.seconds",
            WaitUnit::Minutes => "workflows.unit.minutes",
            WaitUnit::Hours => "workflows.unit.hours",
            WaitUnit::Days => "workflows.unit.days",
        }
    }
}

/// `value` `unit`s in seconds, within what a wait allows (1 s to 30 days).
pub fn wait_seconds(value: u64, unit: WaitUnit) -> u64 {
    value.saturating_mul(unit.seconds()).clamp(1, WAIT_SECONDS)
}

/// A wait as it is typed back: the largest unit it is a whole number of.
pub fn wait_parts(seconds: u64) -> (u64, WaitUnit) {
    let unit = WaitUnit::ALL.into_iter().rev().find(|u| seconds >= u.seconds() && seconds.is_multiple_of(u.seconds()));
    let unit = unit.unwrap_or(WaitUnit::Seconds);
    (seconds / unit.seconds(), unit)
}

/// "5 min", "2 h", "30 j": a wait in words.
pub fn wait_text(seconds: u64) -> String {
    let (value, unit) = wait_parts(seconds);
    let key = match unit {
        WaitUnit::Seconds => "workflows.duration.seconds",
        WaitUnit::Minutes => "workflows.duration.minutes",
        WaitUnit::Hours => "workflows.duration.hours",
        WaitUnit::Days => "workflows.duration.days",
    };
    tf(key, &[("n", &value.to_string())])
}

/// A trigger in words, its rooms named by `room` (an id to a label).
pub fn trigger_summary(trigger: &Trigger, room: &dyn Fn(&str) -> String) -> String {
    match trigger {
        Trigger::Command { name } => tf("workflows.summary.command", &[("name", name)]),
        Trigger::Schedule { every, time, days, timezone, room: id } => {
            let when = match every {
                Every::Hour => {
                    let minute = time_parts(time).map_or_else(|| time.clone(), |(_, m)| format!("{m:02}"));
                    tf("workflows.summary.hour", &[("minute", &minute)])
                }
                Every::Day => tf("workflows.summary.day", &[("time", time)]),
                Every::Week => {
                    let mut sorted = days.clone();
                    sorted.sort_unstable();
                    sorted.dedup();
                    let names: Vec<&str> = sorted.iter().map(|d| t(day_key(*d))).collect();
                    tf("workflows.summary.week", &[("days", &names.join(", ")), ("time", time)])
                }
            };
            tf("workflows.summary.schedule", &[("when", &when), ("zone", timezone), ("room", &room(id))])
        }
        Trigger::MemberJoined { room: id } => tf("workflows.summary.member_joined", &[("room", &room(id))]),
        Trigger::ReactionAdded { room: id, emoji } => match emoji.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
            Some(emoji) => tf("workflows.summary.reaction", &[("emoji", emoji.trim_matches(':')), ("room", &room(id))]),
            None => tf("workflows.summary.any_reaction", &[("room", &room(id))]),
        },
        Trigger::MessagePosted { room: id, contains } => {
            tf("workflows.summary.message_posted", &[("text", contains), ("room", &room(id))])
        }
        Trigger::Webhook {} => t("workflows.summary.webhook").to_owned(),
    }
}

/// The i18n key of a weekday's short name, 1 Monday to 7 Sunday.
pub fn day_key(day: u8) -> &'static str {
    match day {
        1 => "workflows.day.1",
        2 => "workflows.day.2",
        3 => "workflows.day.3",
        4 => "workflows.day.4",
        5 => "workflows.day.5",
        6 => "workflows.day.6",
        _ => "workflows.day.7",
    }
}

/// The i18n key of a trigger kind's name, by its wire name.
pub fn trigger_kind_key(trigger: &Trigger) -> &'static str {
    match trigger {
        Trigger::Command { .. } => "workflows.trigger_kind.command",
        Trigger::Schedule { .. } => "workflows.trigger_kind.schedule",
        Trigger::MemberJoined { .. } => "workflows.trigger_kind.member_joined",
        Trigger::ReactionAdded { .. } => "workflows.trigger_kind.reaction_added",
        Trigger::MessagePosted { .. } => "workflows.trigger_kind.message_posted",
        Trigger::Webhook {} => "workflows.trigger_kind.webhook",
    }
}

/// The i18n key of a step kind's name.
pub fn step_kind_key(step: &Step) -> &'static str {
    match step {
        Step::Message { .. } => "workflows.step.message",
        Step::Wait { .. } => "workflows.step.wait",
        Step::Http { .. } => "workflows.step.http",
        Step::Form { .. } => "workflows.step.form",
    }
}

/// A step in one line, for the list of steps.
pub fn step_summary(step: &Step, room: &dyn Fn(&str) -> String) -> String {
    match step {
        Step::Message { room: id, .. } => tf("workflows.summary.message", &[("room", &room(id))]),
        Step::Wait { seconds } => tf("workflows.summary.wait", &[("duration", &wait_text(*seconds))]),
        Step::Http { method, url, .. } => format!("{} {url}", method.as_str()),
        Step::Form { title, room: id, .. } => tf("workflows.summary.form", &[("title", title), ("room", &room(id))]),
    }
}

/// What a new step of each kind starts as: a message in the trigger's room
/// when the trigger has one, a minute's wait, a GET, a one-field form.
pub fn new_step(kind: &str, trigger: &Trigger, steps: &[Step]) -> Option<Step> {
    let room = if matches!(trigger, Trigger::Webhook {}) { String::new() } else { TRIGGER_ROOM.to_owned() };
    let taken = saved_names(steps);
    Some(match kind {
        "message" => Step::Message { room, text: String::new(), cards: vec![], in_thread: false, save_as: None },
        "wait" => Step::Wait { seconds: 60 },
        "http" => Step::Http {
            method: HttpMethod::Get,
            url: "https://".into(),
            headers: vec![],
            body: None,
            save_as: None,
            continue_on_error: false,
        },
        "form" => Step::Form {
            room,
            recipient: if has_person(trigger) { FormRecipient::TriggerUser } else { FormRecipient::Anyone },
            title: String::new(),
            fields: vec![FormField {
                id: "answer".into(),
                label: String::new(),
                kind: FormFieldKind::Text,
                options: vec![],
                people: vec![],
                multiple: false,
                required: true,
            }],
            save_as: identifier("form", &taken),
        },
        _ => return None,
    })
}

/// Whether the trigger names a person (`trigger.user`), who may then be a
/// form's recipient.
pub fn has_person(trigger: &Trigger) -> bool {
    matches!(
        trigger,
        Trigger::Command { .. }
            | Trigger::MemberJoined { .. }
            | Trigger::ReactionAdded { .. }
            | Trigger::MessagePosted { .. }
    )
}

/// Whether the trigger has a room `room: "trigger"` may name.
pub fn has_room(trigger: &Trigger) -> bool {
    !matches!(trigger, Trigger::Webhook {})
}

/// The step kinds' wire names, in the order the editor offers them.
pub const STEP_KINDS: [&str; 4] = ["message", "wait", "http", "form"];
/// The trigger kinds' wire names, in the order the editor offers them.
pub const TRIGGER_KINDS: [&str; 6] =
    ["command", "schedule", "member_joined", "reaction_added", "message_posted", "webhook"];

/// A trigger of another kind, keeping the room the current one names.
pub fn new_trigger(kind: &str, current: &Trigger) -> Option<Trigger> {
    let room = match current {
        Trigger::Schedule { room, .. }
        | Trigger::MemberJoined { room }
        | Trigger::ReactionAdded { room, .. }
        | Trigger::MessagePosted { room, .. } => room.clone(),
        _ => String::new(),
    };
    Some(match kind {
        "command" => match current {
            Trigger::Command { .. } => current.clone(),
            _ => Trigger::Command { name: String::new() },
        },
        "schedule" => match current {
            Trigger::Schedule { .. } => current.clone(),
            _ => Trigger::Schedule {
                every: Every::Day,
                time: "09:00".into(),
                days: vec![],
                timezone: system_time_zone(),
                room,
            },
        },
        "member_joined" => Trigger::MemberJoined { room },
        "reaction_added" => match current {
            Trigger::ReactionAdded { .. } => current.clone(),
            _ => Trigger::ReactionAdded { room, emoji: None },
        },
        "message_posted" => match current {
            Trigger::MessagePosted { .. } => current.clone(),
            _ => Trigger::MessagePosted { room, contains: String::new() },
        },
        "webhook" => Trigger::Webhook {},
        _ => return None,
    })
}

/// The wire name of a trigger's kind.
pub fn trigger_kind(trigger: &Trigger) -> &'static str {
    match trigger {
        Trigger::Command { .. } => "command",
        Trigger::Schedule { .. } => "schedule",
        Trigger::MemberJoined { .. } => "member_joined",
        Trigger::ReactionAdded { .. } => "reaction_added",
        Trigger::MessagePosted { .. } => "message_posted",
        Trigger::Webhook {} => "webhook",
    }
}

/// The wire name of a step's kind.
pub fn step_kind(step: &Step) -> &'static str {
    match step {
        Step::Message { .. } => "message",
        Step::Wait { .. } => "wait",
        Step::Http { .. } => "http",
        Step::Form { .. } => "form",
    }
}

/// Every `save_as` of these steps.
pub fn saved_names(steps: &[Step]) -> Vec<String> {
    steps
        .iter()
        .filter_map(|step| match step {
            Step::Message { save_as, .. } | Step::Http { save_as, .. } => save_as.clone(),
            Step::Form { save_as, .. } => Some(save_as.clone()),
            Step::Wait { .. } => None,
        })
        .collect()
}

/// The variables the step at `index` may use, without their braces: what the
/// trigger gives, `now`, then what each earlier step saved.
pub fn variables(trigger: &Trigger, steps: &[Step], index: usize) -> Vec<String> {
    let mut names: Vec<String> = match trigger {
        Trigger::Command { .. } => {
            vec!["trigger.user.username", "trigger.user.display_name", "trigger.room.name", "trigger.text"]
        }
        Trigger::Schedule { .. } => vec!["trigger.room.name", "trigger.at"],
        Trigger::MemberJoined { .. } => vec!["trigger.user.username", "trigger.user.display_name", "trigger.room.name"],
        Trigger::ReactionAdded { .. } => vec![
            "trigger.user.username",
            "trigger.user.display_name",
            "trigger.room.name",
            "trigger.emoji",
            "trigger.message.text",
            "trigger.message.author.username",
        ],
        Trigger::MessagePosted { .. } => {
            vec!["trigger.user.username", "trigger.user.display_name", "trigger.room.name", "trigger.message.text"]
        }
        Trigger::Webhook {} => vec!["webhook"],
    }
    .into_iter()
    .map(str::to_owned)
    .collect();
    for step in steps.iter().take(index) {
        match step {
            Step::Message { save_as: Some(name), .. } if valid_identifier(name) => {
                names.push(format!("{name}.message_id"));
            }
            Step::Http { save_as: Some(name), .. } if valid_identifier(name) => {
                names.push(format!("{name}.status"));
                names.push(format!("{name}.body"));
            }
            Step::Form { save_as, fields, .. } if valid_identifier(save_as) => {
                names.push(format!("{save_as}.by.username"));
                names.push(format!("{save_as}.by.display_name"));
                for field in fields.iter().filter(|f| valid_identifier(&f.id)) {
                    let id = &field.id;
                    names.push(format!("{save_as}.answers.{id}"));
                    if field.kind == FormFieldKind::Person {
                        names.push(format!("{save_as}.mentions.{id}"));
                        let person = if field.multiple { format!("{id}.0") } else { id.clone() };
                        names.push(format!("{save_as}.people.{person}.display_name"));
                    }
                }
            }
            _ => {}
        }
    }
    names.push("now".into());
    names
}

/// A variable as it is written in a template.
pub fn placeholder(variable: &str) -> String {
    format!("{{{{{variable}}}}}")
}

/// The people a `person` field offers by name, from those the form resolved,
/// in the field's order (an id the form did not resolve shows as itself);
/// None when it offers any member of the room (`form_members`).
pub fn field_people(form: &WorkflowForm, field: &FormField) -> Option<Vec<User>> {
    if field.kind != FormFieldKind::Person || field.people.is_empty() {
        return None;
    }
    Some(
        field
            .people
            .iter()
            .map(|id| {
                form.people.iter().find(|p| p.id == *id).cloned().unwrap_or_else(|| User {
                    id: id.clone(),
                    username: id.clone(),
                    display_name: String::new(),
                    deleted: false,
                    bot: false,
                })
            })
            .collect(),
    )
}

/// A person as a list shows them: display name, else username.
pub fn person_name(user: &User) -> String {
    if user.display_name.trim().is_empty() { user.username.clone() } else { user.display_name.clone() }
}

/// The people a form's `person` field may name: everyone but bots and
/// deleted accounts, by name.
fn people_only(mut users: Vec<User>) -> Vec<User> {
    users.retain(|u| !u.bot && !u.deleted);
    users.sort_by_key(|u| person_name(u).to_lowercase());
    users.dedup_by(|a, b| a.id == b.id);
    users
}

/// The form a message row carries, if any.
pub fn row_form(row: &crate::store::MessageRow) -> Option<WorkflowForm> {
    serde_json::from_str(row.form.as_deref()?).ok()
}

/// Whether a message's text only repeats its form's title (what a form step
/// posts, for clients without the card): the card says it, the body need not.
pub fn text_is_form_title(text: Option<&str>, form: &WorkflowForm) -> bool {
    text.is_some_and(|text| text.trim() == form.title.trim())
}

/// Whether nobody answered it and it is still open at `now`.
pub fn form_open(form: &WorkflowForm, now: chrono::DateTime<chrono::Utc>) -> bool {
    form.answered_by.is_none()
        && chrono::DateTime::parse_from_rfc3339(&form.expires_at).is_ok_and(|expires| expires > now)
}

/// Whether I (`me`, a user id) may answer it now: open, and mine or anyone's.
pub fn can_answer(form: &WorkflowForm, me: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    form_open(form, now) && form.recipient.as_ref().is_none_or(|r| r.id == me)
}

/// The answers as the server takes them: trimmed, a field left empty left
/// out, one value for a single field and a list for a `multiple` one;
/// `form_required` or `form_value` (several values for a single field, a
/// number that does not parse, a choice not offered, a person not listed, an
/// unknown field, a text too long) otherwise.
pub fn checked_answers(
    form: &WorkflowForm,
    answers: &BTreeMap<String, FormAnswer>,
) -> Result<BTreeMap<String, FormAnswer>, &'static str> {
    if answers.keys().any(|id| !form.fields.iter().any(|f| f.id == *id)) {
        return Err("form_value");
    }
    let mut out = BTreeMap::new();
    for field in &form.fields {
        let mut values: Vec<&str> = answers.get(&field.id).map(FormAnswer::values).unwrap_or_default();
        values.sort_unstable();
        values.dedup();
        if values.is_empty() {
            if field.required {
                return Err("form_required");
            }
            continue;
        }
        if values.len() > 1 && !field.multiple {
            return Err("form_value");
        }
        let fits = |value: &str| match field.kind {
            FormFieldKind::Text => value.len() <= TEXT_ANSWER && !value.contains(['\n', '\0']),
            FormFieldKind::LongText => value.len() <= LONG_ANSWER && !value.contains('\0'),
            FormFieldKind::Number => value.parse::<f64>().is_ok_and(f64::is_finite),
            FormFieldKind::Choice => field.options.iter().any(|o| o == value),
            // A user id; with no list, the server checks room membership.
            FormFieldKind::Person => field.people.is_empty() || field.people.iter().any(|p| p == value),
        };
        if !values.iter().all(|v| fits(v)) {
            return Err("form_value");
        }
        let answer = if field.multiple {
            FormAnswer::Many(values.into_iter().map(str::to_owned).collect())
        } else {
            FormAnswer::One(values[0].to_owned())
        };
        out.insert(field.id.clone(), answer);
    }
    Ok(out)
}

/// The i18n key of a run's state.
pub fn run_state_key(state: RunState) -> &'static str {
    match state {
        RunState::Pending => "workflows.run.pending",
        RunState::Waiting => "workflows.run.waiting",
        RunState::Done => "workflows.run.done",
        RunState::Failed => "workflows.run.failed",
        RunState::Cancelled => "workflows.run.cancelled",
    }
}

/// Why a run failed, from its step's code, in words.
pub fn run_error_text(code: &str) -> String {
    let key = match code {
        "bot_scope_missing" => "workflows.run_error.scope",
        "crypto_required" => "workflows.run_error.encrypted",
        "http_address" => "workflows.run_error.http_address",
        "http_url" => "workflows.run_error.http_url",
        "http_failed" => "workflows.run_error.http_failed",
        "form_expired" => "workflows.run_error.form_expired",
        "bot_unavailable" => "workflows.run_error.bot_unavailable",
        "workflow_retries" => "workflows.run_error.retries",
        "bot_rate_limited" => "workflows.run_error.rate_limited",
        "workflow_room" => "workflows.error_room",
        "workflow_form" => "workflows.error_form",
        _ => return tf("workflows.run_error.other", &[("code", code)]),
    };
    t(key).to_owned()
}

/// A run in one line: its state, its step and why it failed.
pub fn run_text(run: &WorkflowRun) -> String {
    let state = t(run_state_key(run.state));
    let step = tf("workflows.run_step", &[("n", &(run.step + 1).to_string())]);
    match &run.error {
        Some(code) => format!("{state} · {step} · {}", run_error_text(code)),
        None => format!("{state} · {step}"),
    }
}

/// The i18n key of the sentence for a refusal's code and HTTP status (0: no
/// answer), the same in both desktop apps. A code with its own sentence wins;
/// any other 429 is a rate limit.
pub fn error_key(code: &str, status: u16) -> &'static str {
    match code {
        "bots_disabled" => "workflows.error_bots_disabled",
        "workflow_limit" => "workflows.error_limit",
        "workflow_bot" => "workflows.error_bot",
        "bot_scope_missing" => "workflows.error_scope",
        "workflow_bot_not_member" => "workflows.error_not_member",
        "crypto_required" => "workflows.error_encrypted",
        "workflow_room" => "workflows.error_room",
        "workflow_command" => "workflows.error_command",
        "workflow_command_taken" => "workflows.error_command_taken",
        "workflow_schedule" => "workflows.error_schedule",
        "workflow_test_command" => "workflows.error_test_command",
        "workflow_not_webhook" => "workflows.error_not_webhook",
        "workflow_match" => "workflows.error_match",
        "workflow_emoji" => "workflows.error_emoji",
        "workflow_steps" => "workflows.error_steps",
        "workflow_message" => "workflows.error_message",
        "workflow_wait" => "workflows.error_wait",
        "workflow_http" => "workflows.error_http",
        "workflow_form" => "workflows.error_form",
        "revision_conflict" => "workflows.error_conflict",
        "workflow_unavailable" => "workflows.error_unavailable",
        "workflow_rate_limited" => "workflows.error_run_limit",
        "workflow_busy" => "workflows.error_busy",
        "permission_denied" => "workflows.error_permission",
        "form_required" => "workflows.error_form_required",
        "form_value" => "workflows.error_form_value",
        "form_answered" => "workflows.error_form_answered",
        "form_expired" => "workflows.error_form_expired",
        "reauthentication_required" => "workflows.error_reauth",
        "not_found" => "workflows.error_not_found",
        "invalid_request" => "workflows.error_invalid",
        "unsupported_feature" => "workflows.error_unsupported",
        "offline" | "connection_failed" | "session_closed" => "native.offline",
        _ if status == 429 => "workflows.error_rate_limited",
        _ => "workflows.failed",
    }
}

/// `error_key` for a failed call.
pub fn failure_key(error: &Error) -> &'static str {
    let status = match error {
        Error::Network(rv_client::Error::Server { status, .. }) => *status,
        _ => 0,
    };
    error_key(error.code(), status)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODES: [&str; 37] = [
        "workflow_test_command",
        "workflow_not_webhook",
        "workflow_match",
        "workflow_emoji",
        "bots_disabled",
        "workflow_limit",
        "workflow_bot",
        "bot_scope_missing",
        "workflow_bot_not_member",
        "crypto_required",
        "workflow_room",
        "workflow_command",
        "workflow_command_taken",
        "workflow_schedule",
        "workflow_steps",
        "workflow_message",
        "workflow_wait",
        "workflow_http",
        "workflow_form",
        "revision_conflict",
        "workflow_unavailable",
        "workflow_rate_limited",
        "workflow_busy",
        "permission_denied",
        "form_required",
        "form_value",
        "form_answered",
        "form_expired",
        "reauthentication_required",
        "not_found",
        "invalid_request",
        "unsupported_feature",
        "http_address",
        "http_url",
        "http_failed",
        "bot_unavailable",
        "workflow_retries",
    ];

    #[test]
    fn every_code_of_the_contract_has_words() {
        let _serial = crate::i18n::LANGUAGE.lock().unwrap();
        for lang in [crate::i18n::Lang::Fr, crate::i18n::Lang::En] {
            crate::i18n::set(lang);
            for code in CODES {
                assert!(!t(error_key(code, 400)).is_empty(), "{code}");
                assert!(!run_error_text(code).is_empty(), "{code}");
            }
            for state in [RunState::Pending, RunState::Waiting, RunState::Done, RunState::Failed, RunState::Cancelled] {
                assert!(!t(run_state_key(state)).is_empty());
            }
            for unit in WaitUnit::ALL {
                assert!(!t(unit.key()).is_empty());
            }
            for day in 1..=7 {
                assert!(!t(day_key(day)).is_empty());
            }
        }
        crate::i18n::set(crate::i18n::Lang::En);
        assert_eq!(error_key("revision_conflict", 409), "workflows.error_conflict");
        assert_eq!(error_key("workflow_rate_limited", 429), "workflows.error_run_limit", "its own words win");
        assert_eq!(error_key("rate_limited", 429), "workflows.error_rate_limited");
        assert_eq!(error_key("weird", 400), "workflows.failed");
        assert_eq!(run_error_text("http_address"), t("workflows.run_error.http_address"));
        assert_eq!(run_error_text("bot_rate_limited"), t("workflows.run_error.rate_limited"));
        assert!(run_error_text("something_new").contains("something_new"));
        let limited = Error::Network(rv_client::Error::Server {
            status: 429,
            code: "auth_rate_limited".into(),
            request_id: None,
            retry_after: Some(3),
        });
        assert_eq!(failure_key(&limited), "workflows.error_rate_limited");
        assert_eq!(failure_key(&Error::Protocol("form_required")), "workflows.error_form_required");
    }

    #[test]
    fn identifiers_are_made_from_labels() {
        assert_eq!(identifier("What did you do today?", &[]), "what_did_you_do_today");
        assert_eq!(identifier("  Été / Humeur ", &[]), "ete_humeur");
        assert_eq!(identifier("Today", &["today".into()]), "today_2");
        assert_eq!(identifier("Today", &["today".into(), "today_2".into()]), "today_3");
        assert_eq!(identifier("!!!", &[]), "field");
        assert_eq!(identifier("Trigger", &[]), "trigger_1");
        assert_eq!(identifier("now", &[]), "now_1");
        let long = identifier(&"a".repeat(50), &["a".repeat(32)]);
        assert!(long.len() <= 32 && long.ends_with("_2"), "{long}");
        for id in ["what_did_you_do_today", "ete_humeur", "field", "trigger_1", &long] {
            assert!(valid_identifier(id), "{id}");
        }
        assert!(!valid_identifier("webhook") && !valid_identifier("") && !valid_identifier("A"));
    }

    #[test]
    fn waits_are_typed_in_units() {
        assert_eq!(wait_seconds(5, WaitUnit::Minutes), 300);
        assert_eq!(wait_seconds(0, WaitUnit::Seconds), 1);
        assert_eq!(wait_seconds(400, WaitUnit::Days), WAIT_SECONDS);
        assert_eq!(wait_parts(300), (5, WaitUnit::Minutes));
        assert_eq!(wait_parts(7200), (2, WaitUnit::Hours));
        assert_eq!(wait_parts(90), (90, WaitUnit::Seconds));
        assert_eq!(wait_parts(172_800), (2, WaitUnit::Days));
        let _serial = crate::i18n::LANGUAGE.lock().unwrap();
        crate::i18n::set(crate::i18n::Lang::En);
        assert_eq!(wait_text(300), "5 min");
    }

    #[test]
    fn times_read_and_write_as_hh_mm() {
        assert_eq!(time_text(9, 5), "09:05");
        assert_eq!(time_parts("09:30"), Some((9, 30)));
        assert_eq!(time_parts("24:00"), None);
        assert_eq!(time_parts("9:30"), None);
        assert!(!system_time_zone().is_empty());
    }

    #[test]
    fn the_webhook_url_is_the_server_and_the_path() {
        assert_eq!(
            webhook_url("https://chat.example/", "/api/v1/hooks/wf/abc"),
            "https://chat.example/api/v1/hooks/wf/abc"
        );
        assert_eq!(
            webhook_url("https://chat.example", "/api/v1/hooks/wf/abc"),
            "https://chat.example/api/v1/hooks/wf/abc"
        );
    }

    #[test]
    fn triggers_and_steps_read_as_words() {
        let _serial = crate::i18n::LANGUAGE.lock().unwrap();
        crate::i18n::set(crate::i18n::Lang::En);
        let room = |id: &str| format!("#{id}");
        assert_eq!(trigger_summary(&Trigger::Command { name: "standup".into() }, &room), "Command /standup");
        let weekly = Trigger::Schedule {
            every: Every::Week,
            time: "09:30".into(),
            days: vec![5, 1, 1],
            timezone: "Europe/Paris".into(),
            room: "general".into(),
        };
        assert_eq!(trigger_summary(&weekly, &room), "Every Mon, Fri at 09:30 (Europe/Paris), in #general");
        let hourly = Trigger::Schedule {
            every: Every::Hour,
            time: "00:15".into(),
            days: vec![],
            timezone: "UTC".into(),
            room: "ops".into(),
        };
        assert_eq!(trigger_summary(&hourly, &room), "Every hour at :15 (UTC), in #ops");
        assert_eq!(
            trigger_summary(&Trigger::MemberJoined { room: "welcome".into() }, &room),
            "When someone joins #welcome"
        );
        assert_eq!(trigger_summary(&Trigger::Webhook {}, &room), "Incoming webhook");
        let tada = Trigger::ReactionAdded { room: "team".into(), emoji: Some(":tada:".into()) };
        assert_eq!(trigger_summary(&tada, &room), "Reaction :tada: in #team");
        let any = Trigger::ReactionAdded { room: "team".into(), emoji: None };
        assert_eq!(trigger_summary(&any, &room), "Any reaction in #team");
        let posted = Trigger::MessagePosted { room: "help".into(), contains: "urgent".into() };
        assert_eq!(trigger_summary(&posted, &room), "Message containing “urgent” in #help");
        assert_eq!(step_summary(&Step::Wait { seconds: 120 }, &room), "Wait 2 min");
        let http = new_step("http", &Trigger::Webhook {}, &[]).unwrap();
        assert_eq!(step_summary(&http, &room), "GET https://");
    }

    #[test]
    fn new_steps_and_triggers_start_sensibly() {
        let Some(Step::Message { room, .. }) = new_step("message", &Trigger::Webhook {}, &[]) else { panic!() };
        assert!(room.is_empty(), "a webhook has no room to answer in");
        let command = Trigger::Command { name: "x".into() };
        let Some(Step::Form { recipient, save_as, .. }) = new_step("form", &command, &[]) else { panic!() };
        assert_eq!((recipient, save_as.as_str()), (FormRecipient::TriggerUser, "form"));
        let first = new_step("form", &command, &[]).unwrap();
        let Some(Step::Form { save_as, .. }) = new_step("form", &command, &[first]) else { panic!() };
        assert_eq!(save_as, "form_2", "save_as stays unique");
        assert!(new_step("loop", &command, &[]).is_none());
        let joined = Trigger::MemberJoined { room: "r".into() };
        let Some(Trigger::Schedule { room, timezone, .. }) = new_trigger("schedule", &joined) else { panic!() };
        assert_eq!(room, "r");
        assert!(!timezone.is_empty());
        assert_eq!(new_trigger("command", &command), Some(command.clone()), "the same kind is kept");
        assert_eq!(trigger_kind(&joined), "member_joined");
        let Some(Trigger::ReactionAdded { room, emoji }) = new_trigger("reaction_added", &joined) else { panic!() };
        assert_eq!((room.as_str(), emoji), ("r", None));
        let posted = new_trigger("message_posted", &joined).unwrap();
        assert!(has_person(&posted) && has_room(&posted) && !has_room(&Trigger::Webhook {}));
        let Some(Step::Form { recipient, .. }) = new_step("form", &posted, &[]) else { panic!() };
        assert_eq!(recipient, FormRecipient::TriggerUser);
        let reacted = variables(&Trigger::ReactionAdded { room: "r".into(), emoji: None }, &[], 0);
        assert!(reacted.contains(&"trigger.emoji".to_owned()) && reacted.contains(&"trigger.message.text".to_owned()));
        for kind in TRIGGER_KINDS {
            let made = new_trigger(kind, &joined).unwrap();
            assert_eq!(trigger_kind(&made), kind);
            assert!(!t(trigger_kind_key(&made)).is_empty());
        }
    }

    #[test]
    fn a_draft_is_normalized_then_checked_before_saving() {
        let mut draft = Draft::new("bot");
        draft.name = " Triage ".into();
        draft.trigger = Trigger::Webhook {};
        assert_eq!(draft_problem(&draft), Some("workflow_steps"), "no step");
        draft.steps.push(Step::Message {
            room: TRIGGER_ROOM.into(),
            text: "Hi".into(),
            cards: vec![],
            in_thread: true,
            save_as: Some("  ".into()),
        });
        assert_eq!(draft.normalized().unwrap_err().code(), "workflow_room", "a webhook has no room");
        draft.trigger = Trigger::Command { name: "/Triage".into() };
        let normal = draft.normalized().unwrap();
        assert_eq!(normal.name, "Triage");
        assert_eq!(normal.trigger, Trigger::Command { name: "triage".into() });
        let Step::Message { in_thread, save_as, .. } = &normal.steps[0] else { panic!() };
        assert!(!in_thread && save_as.is_none(), "no thread under a command; a blank name is none");
        draft.trigger = Trigger::MessagePosted { room: "r".into(), contains: "help".into() };
        let Step::Message { in_thread, .. } = &draft.normalized().unwrap().steps[0] else { panic!() };
        assert!(in_thread, "a message has a thread");
        draft.steps.push(Step::Http {
            method: HttpMethod::Post,
            url: " https://example.org ".into(),
            headers: vec![
                HttpHeader { name: " X-A ".into(), value: "1".into() },
                HttpHeader { name: " ".into(), value: "2".into() },
            ],
            body: Some(String::new()),
            save_as: None,
            continue_on_error: false,
        });
        let Step::Http { url, headers, body, .. } = &draft.normalized().unwrap().steps[1] else { panic!() };
        assert_eq!(
            (url.as_str(), headers.len(), headers[0].name.as_str(), body),
            ("https://example.org", 1, "X-A", &None)
        );
        let mut form = new_step("form", &Trigger::Webhook {}, &draft.steps).unwrap();
        if let Step::Form { recipient, room, fields, title, .. } = &mut form {
            *title = "Check".into();
            *recipient = FormRecipient::TriggerUser;
            *room = "r".into();
            fields[0].label = "Who".into();
        }
        draft.trigger = Trigger::Schedule {
            every: Every::Day,
            time: "09:00".into(),
            days: vec![],
            timezone: "UTC".into(),
            room: "r".into(),
        };
        draft.steps = vec![form];
        assert_eq!(draft_problem(&draft), Some("workflow_form"), "nobody triggers a schedule");
        draft.trigger = Trigger::MemberJoined { room: "r".into() };
        assert_eq!(draft_problem(&draft), None);
        draft.trigger = Trigger::MessagePosted { room: "r".into(), contains: "x".repeat(MATCH_BYTES + 1) };
        assert_eq!(draft_problem(&draft), Some("workflow_match"));
        draft.trigger = Trigger::Command { name: " ".into() };
        assert_eq!(draft_problem(&draft), Some("workflow_command"));
        draft.name = " ".into();
        assert_eq!(draft_problem(&draft), Some("invalid_request"));
    }

    #[test]
    fn each_step_sees_what_came_before() {
        let steps = vec![
            Step::Form {
                room: "trigger".into(),
                recipient: FormRecipient::TriggerUser,
                title: "Standup".into(),
                fields: vec![FormField {
                    id: "today".into(),
                    label: "Today".into(),
                    kind: FormFieldKind::LongText,
                    options: vec![],
                    people: vec![],
                    multiple: false,
                    required: true,
                }],
                save_as: "standup".into(),
            },
            Step::Http {
                method: HttpMethod::Post,
                url: "https://example.org".into(),
                headers: vec![],
                body: None,
                save_as: Some("log".into()),
                continue_on_error: false,
            },
            Step::Message {
                room: "trigger".into(),
                text: String::new(),
                cards: vec![],
                in_thread: false,
                save_as: None,
            },
        ];
        let command = Trigger::Command { name: "standup".into() };
        let first = variables(&command, &steps, 0);
        assert!(first.contains(&"trigger.text".to_owned()) && first.contains(&"now".to_owned()));
        assert!(!first.iter().any(|v| v.starts_with("standup")));
        let last = variables(&command, &steps, 2);
        for name in ["standup.answers.today", "standup.by.display_name", "log.status", "log.body"] {
            assert!(last.contains(&name.to_owned()), "{name}");
        }
        assert_eq!(variables(&Trigger::Webhook {}, &[], 0), vec!["webhook", "now"]);
        assert_eq!(placeholder("trigger.text"), "{{trigger.text}}");
        assert_eq!(saved_names(&steps), vec!["standup", "log"]);
    }

    fn form() -> WorkflowForm {
        WorkflowForm {
            title: "Standup".into(),
            fields: vec![
                FormField {
                    id: "today".into(),
                    label: "Today".into(),
                    kind: FormFieldKind::LongText,
                    options: vec![],
                    people: vec![],
                    multiple: false,
                    required: true,
                },
                FormField {
                    id: "hours".into(),
                    label: "Hours".into(),
                    kind: FormFieldKind::Number,
                    options: vec![],
                    people: vec![],
                    multiple: false,
                    required: false,
                },
                FormField {
                    id: "mood".into(),
                    label: "Mood".into(),
                    kind: FormFieldKind::Choice,
                    options: vec!["good".into(), "meh".into()],
                    people: vec![],
                    multiple: false,
                    required: false,
                },
                FormField {
                    id: "reviewer".into(),
                    label: "Reviewer".into(),
                    kind: FormFieldKind::Person,
                    options: vec![],
                    people: vec!["bob-id".into()],
                    multiple: false,
                    required: false,
                },
            ],
            recipient: Some(rv_protocol::User {
                id: "alice-id".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                deleted: false,
                bot: false,
            }),
            answered_by: None,
            answered_at: None,
            expires_at: "2026-10-15T09:00:00+00:00".into(),
            people: vec![rv_protocol::User {
                id: "bob-id".into(),
                username: "bob".into(),
                display_name: "Bob".into(),
                deleted: false,
                bot: false,
            }],
        }
    }

    #[test]
    fn a_form_is_answered_by_its_recipient_while_open() {
        let before = chrono::DateTime::parse_from_rfc3339("2026-10-10T09:00:00Z").unwrap().to_utc();
        let after = chrono::DateTime::parse_from_rfc3339("2026-10-16T09:00:00Z").unwrap().to_utc();
        let mut form = form();
        assert!(text_is_form_title(Some(" Standup "), &form) && !text_is_form_title(Some("Hello"), &form));
        assert!(!text_is_form_title(None, &form));
        assert!(can_answer(&form, "alice-id", before));
        assert!(!can_answer(&form, "bob-id", before), "someone else's form");
        assert!(!can_answer(&form, "alice-id", after), "expired");
        form.recipient = None;
        assert!(can_answer(&form, "bob-id", before), "anyone's form");
        form.answered_by = Some(rv_protocol::User {
            id: "bob-id".into(),
            username: "bob".into(),
            display_name: "Bob".into(),
            deleted: false,
            bot: false,
        });
        assert!(!can_answer(&form, "bob-id", before) && !form_open(&form, before));
    }

    #[test]
    fn answers_are_checked_like_the_server() {
        let form = form();
        let answers = |pairs: &[(&str, &str)]| {
            pairs.iter().map(|(k, v)| ((*k).to_owned(), FormAnswer::from(*v))).collect::<BTreeMap<_, _>>()
        };
        let many = |values: &[&str]| FormAnswer::Many(values.iter().map(|v| (*v).to_owned()).collect());
        assert_eq!(
            checked_answers(&form, &answers(&[("today", " Reviews "), ("hours", ""), ("mood", "good")])),
            Ok(answers(&[("today", "Reviews"), ("mood", "good")]))
        );
        assert_eq!(checked_answers(&form, &answers(&[("today", "  ")])), Err("form_required"));
        // A short text is one line; nothing carries a NUL.
        let mut short = form.clone();
        short.fields[0].kind = FormFieldKind::Text;
        assert_eq!(checked_answers(&short, &answers(&[("today", "a\nb")])), Err("form_value"));
        assert_eq!(checked_answers(&form, &answers(&[("today", "a\nb")])).unwrap()["today"], "a\nb".into());
        assert_eq!(checked_answers(&form, &answers(&[("today", "a\0b")])), Err("form_value"));
        assert_eq!(checked_answers(&form, &answers(&[("today", "x"), ("hours", "two")])), Err("form_value"));
        assert_eq!(checked_answers(&form, &answers(&[("today", "x"), ("mood", "great")])), Err("form_value"));
        assert_eq!(checked_answers(&form, &answers(&[("today", "x"), ("other", "y")])), Err("form_value"));
        assert_eq!(checked_answers(&form, &answers(&[("today", &"x".repeat(4097))])), Err("form_value"));
        assert_eq!(
            checked_answers(&form, &answers(&[("today", "x"), ("hours", "7.5")])).unwrap()["hours"],
            "7.5".into()
        );
        assert_eq!(
            checked_answers(&form, &answers(&[("today", "x"), ("reviewer", "bob-id")])).unwrap()["reviewer"],
            "bob-id".into()
        );
        // Several values only for a multiple field, which always gets a list.
        let mut two = answers(&[("today", "x")]);
        two.insert("mood".into(), many(&["good", "meh"]));
        assert_eq!(checked_answers(&form, &two), Err("form_value"));
        let mut multiple = form.clone();
        multiple.fields[2].multiple = true;
        assert_eq!(checked_answers(&multiple, &two).unwrap()["mood"], many(&["good", "meh"]));
        let one = answers(&[("today", "x"), ("mood", "good")]);
        assert_eq!(checked_answers(&multiple, &one).unwrap()["mood"], many(&["good"]));
        let mut list = answers(&[("today", "x")]);
        list.insert("mood".into(), many(&["good"]));
        assert_eq!(checked_answers(&form, &list).unwrap()["mood"], "good".into(), "a single field gets one value");
        list.insert("mood".into(), many(&[]));
        assert!(!checked_answers(&form, &list).unwrap().contains_key("mood"), "nothing picked, left out");
        two.insert("mood".into(), many(&["good", "great"]));
        assert_eq!(checked_answers(&multiple, &two), Err("form_value"));
        assert_eq!(checked_answers(&form, &answers(&[("today", "x"), ("reviewer", "eve-id")])), Err("form_value"));
        let listed = field_people(&form, &form.fields[3]).unwrap();
        assert_eq!((listed[0].username.as_str(), person_name(&listed[0])), ("bob", "Bob".to_owned()));
        assert!(field_people(&form, &form.fields[0]).is_none());
        let mut open = form.clone();
        open.fields[3].people.clear();
        assert!(field_people(&open, &open.fields[3]).is_none(), "any member of the room");
        assert!(checked_answers(&open, &answers(&[("today", "x"), ("reviewer", "eve-id")])).is_ok());
    }
}
