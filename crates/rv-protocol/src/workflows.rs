//! Workflows (RFC 0004): a trigger starts a durable run of steps, acting
//! through one of the owner's bots.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const WORKFLOWS_PER_OWNER: i64 = 20;
pub const STEPS_PER_WORKFLOW: usize = 20;
pub const NAME_BYTES: usize = 128;
pub const DESCRIPTION_BYTES: usize = 512;
/// Templates of a step (text, URL, header value, body).
pub const TEMPLATE_BYTES: usize = 8192;
pub const WAIT_SECONDS: u64 = 30 * 24 * 3600;
pub const FORM_FIELDS: usize = 10;
pub const FORM_DAYS: i64 = 7;
pub const RUNS_PER_MINUTE: i64 = 30;
pub const OPEN_RUNS: i64 = 100;
pub const WEBHOOK_BYTES: usize = 16 * 1024;
pub const HTTP_RESPONSE_BYTES: usize = 64 * 1024;
pub const HTTP_HEADERS: usize = 10;
/// The text a `message_posted` trigger looks for, in bytes.
pub const MATCH_BYTES: usize = 100;
/// The people a `person` field offers by name.
pub const PEOPLE_PER_FIELD: usize = 50;

/// What starts a run.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Trigger {
    /// `/name text` in a room where the workflow's bot is a member.
    Command { name: String },
    /// At `time` in `timezone` (IANA), every hour (minutes only), every day,
    /// or on the given ISO weekdays (1 Monday .. 7 Sunday).
    Schedule {
        every: Every,
        time: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        days: Vec<u8>,
        timezone: String,
        room: String,
    },
    /// Someone (never a bot) joins or is added to the room.
    MemberJoined { room: String },
    /// A person (never a bot) adds a reaction to a message of the room: any
    /// emoji, or only `emoji` (a shortcode or a custom emoji's name).
    ReactionAdded {
        room: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        emoji: Option<String>,
    },
    /// A person (never a bot) posts a message whose text contains `contains`,
    /// ignoring case. Edits never fire it.
    MessagePosted { room: String, contains: String },
    /// `POST /api/v1/hooks/{workflow}/{secret}` with a JSON body.
    Webhook {},
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Every {
    Hour,
    Day,
    Week,
}

/// `trigger` (the room the run started from) or a room id.
pub const TRIGGER_ROOM: &str = "trigger";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    Message {
        room: String,
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        cards: Vec<crate::cards::IntegrationCard>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        in_thread: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        save_as: Option<String>,
    },
    Wait {
        seconds: u64,
    },
    Http {
        method: HttpMethod,
        url: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        headers: Vec<HttpHeader>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        save_as: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        continue_on_error: bool,
    },
    Form {
        room: String,
        recipient: FormRecipient,
        title: String,
        fields: Vec<FormField>,
        save_as: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl HttpMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
            HttpMethod::Put => "PUT",
            HttpMethod::Patch => "PATCH",
            HttpMethod::Delete => "DELETE",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormRecipient {
    /// The person whose action started the run (a command, a join).
    TriggerUser,
    /// Any member of the room.
    Anyone,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormField {
    pub id: String,
    pub label: String,
    pub kind: FormFieldKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// `person` only: the user ids it offers; empty, any member of the form's
    /// room who is not a bot.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub people: Vec<String>,
    /// `choice` and `person` only: several answers (checkboxes) instead of one.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub multiple: bool,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormFieldKind {
    Text,
    LongText,
    Number,
    Choice,
    /// Someone: one of `people`, or any member of the room. The answer is a user id.
    Person,
}

/// A workflow as its owner and the administrators see it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct Workflow {
    pub id: String,
    pub owner: crate::User,
    pub bot: crate::User,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub steps: Vec<Step>,
    pub revision: String,
    /// Whether a webhook secret exists; the secret itself is shown once.
    #[serde(default)]
    pub has_webhook: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_fire_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<WorkflowRun>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct WorkflowList {
    pub workflows: Vec<Workflow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateWorkflow {
    pub operation_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub bot_id: String,
    pub trigger: Trigger,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub enabled: bool,
}

/// The whole definition at the expected revision.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateWorkflow {
    pub operation_id: String,
    pub revision: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub bot_id: String,
    pub trigger: Trigger,
    pub steps: Vec<Step>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Pending,
    Waiting,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct WorkflowRun {
    pub id: String,
    pub state: RunState,
    /// The step about to run, or the last one run.
    pub step: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct WorkflowRunList {
    pub runs: Vec<WorkflowRun>,
}

/// The only answer that carries the webhook secret.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct WebhookSecret {
    /// `/api/v1/hooks/{workflow}/{secret}`, to put after the server address.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct RunStarted {
    pub run_id: String,
}

/// A form a workflow posted, carried by its message.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct WorkflowForm {
    pub title: String,
    pub fields: Vec<FormField>,
    /// Only this person may answer; absent: any member of the room.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipient: Option<crate::User>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_by: Option<crate::User>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<String>,
    /// Past it the form takes no answer.
    pub expires_at: String,
    /// The people the `person` fields name, to show them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub people: Vec<crate::User>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AnswerForm {
    pub operation_id: String,
    /// Field id to its value; a number is sent as its text, a `multiple`
    /// field's answers as a list.
    pub answers: std::collections::BTreeMap<String, FormAnswer>,
}

/// One answer, or the list a `multiple` field takes.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(untagged)]
pub enum FormAnswer {
    One(String),
    Many(Vec<String>),
}

impl FormAnswer {
    /// The values, trimmed, the empty ones left out.
    pub fn values(&self) -> Vec<&str> {
        match self {
            Self::One(value) => vec![value.trim()],
            Self::Many(values) => values.iter().map(|v| v.trim()).collect(),
        }
        .into_iter()
        .filter(|v| !v.is_empty())
        .collect()
    }
}

impl From<&str> for FormAnswer {
    fn from(value: &str) -> Self {
        Self::One(value.to_owned())
    }
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct WorkflowsContract {
    pub workflow: Workflow,
    pub workflow_list: WorkflowList,
    pub create_workflow: CreateWorkflow,
    pub update_workflow: UpdateWorkflow,
    pub workflow_run_list: WorkflowRunList,
    pub webhook_secret: WebhookSecret,
    pub run_started: RunStarted,
    pub workflow_form: WorkflowForm,
    pub answer_form: AnswerForm,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triggers_and_steps_are_tagged_by_kind() {
        let trigger: Trigger = serde_json::from_str(
            r#"{"kind":"schedule","every":"week","time":"09:00","days":[1,5],"timezone":"Europe/Paris","room":"r"}"#,
        )
        .unwrap();
        assert!(matches!(
            trigger,
            Trigger::Schedule {
                every: Every::Week,
                ..
            }
        ));
        let step: Step = serde_json::from_str(
            r#"{"kind":"http","method":"POST","url":"https://example.org","save_as":"r"}"#,
        )
        .unwrap();
        assert!(matches!(
            step,
            Step::Http {
                method: HttpMethod::Post,
                ..
            }
        ));
        assert!(serde_json::from_str::<Step>(r#"{"kind":"wait","seconds":5,"x":1}"#).is_err());
    }
}
