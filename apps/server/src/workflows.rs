//! Workflows (RFC 0004, `docs/protocol/WORKFLOWS.md`): definitions, their
//! validation, the triggers that start runs, and forms. The runs themselves are
//! `engine`. A workflow acts through one of its owner's bots: everything it posts
//! goes through the bot's own session, so the bot's scopes, memberships, budgets
//! and refusal of encrypted rooms apply.
use crate::{
    App,
    admin::{admit, fingerprint, settle},
    auth::{self, Account, random_token},
    error::{Error, Result},
    operator,
};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rv_protocol::{
    User,
    workflows::{
        AnswerForm, CreateWorkflow, DESCRIPTION_BYTES, FORM_FIELDS, FormFieldKind, FormRecipient,
        HTTP_HEADERS, MATCH_BYTES, NAME_BYTES, OPEN_RUNS, PEOPLE_PER_FIELD, RUNS_PER_MINUTE,
        RunStarted, RunState, STEPS_PER_WORKFLOW, Step, TEMPLATE_BYTES, TRIGGER_ROOM, Trigger,
        UpdateWorkflow, WAIT_SECONDS, WEBHOOK_BYTES, WORKFLOWS_PER_OWNER, WebhookSecret, Workflow,
        WorkflowList, WorkflowRun, WorkflowRunList,
    },
};
use serde_json::{Value, json};
use sqlx::{FromRow, Postgres, Transaction, types::Json};

pub mod engine;
mod schedule;
mod template;

fn refused(code: &'static str) -> Error {
    Error::new(StatusCode::BAD_REQUEST, code)
}

fn short_text(value: &str, limit: usize) -> bool {
    value.len() <= limit && !value.contains('\0')
}

fn variable_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && !matches!(value, "trigger" | "webhook" | "now")
}

fn command_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
        && !rv_protocol::commands::catalogue()
            .commands
            .iter()
            .any(|c| c.command == value)
}

/// The rooms a trigger gives its run, for `"trigger"` in a step.
fn trigger_room(trigger: &Trigger) -> bool {
    !matches!(trigger, Trigger::Webhook {})
}

fn trigger_user(trigger: &Trigger) -> bool {
    matches!(
        trigger,
        Trigger::Command { .. }
            | Trigger::MemberJoined { .. }
            | Trigger::ReactionAdded { .. }
            | Trigger::MessagePosted { .. }
    )
}

fn reads(scopes: &[String]) -> Result<()> {
    if scopes.iter().any(|s| s == "rooms:read") {
        Ok(())
    } else {
        Err(Error::new(StatusCode::FORBIDDEN, "bot_scope_missing"))
    }
}

/// What a valid definition implies for its row.
struct Checked {
    command: Option<String>,
    next_fire_at: Option<DateTime<Utc>>,
}

/// A room a workflow may post into or watch: its bot belongs to it and it is
/// plaintext (a bot is never in an encrypted room, RFC 0003 §8).
async fn bot_room(tx: &mut Transaction<'_, Postgres>, bot: &str, room: &str) -> Result<()> {
    if !auth::identifier(room) {
        return Err(refused("workflow_room"));
    }
    let (member, encrypted): (bool, bool) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM members WHERE room_id=$1 AND user_id=$2),EXISTS(SELECT 1 FROM e2ee_groups WHERE room_id=$1)")
        .bind(room)
        .bind(bot)
        .fetch_one(&mut **tx)
        .await?;
    if !member {
        return Err(refused("workflow_bot_not_member"));
    }
    if encrypted {
        return Err(Error::new(StatusCode::CONFLICT, "crypto_required"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn check(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    workflow: Option<&str>,
    name: &str,
    description: &str,
    bot: &str,
    trigger: &Trigger,
    steps: &[Step],
) -> Result<Checked> {
    if name.trim().is_empty()
        || !short_text(name, NAME_BYTES)
        || name.chars().any(char::is_control)
        || !short_text(description, DESCRIPTION_BYTES)
    {
        return Err(Error::invalid());
    }
    // The bot is mine and live: a workflow never acts as someone else's bot.
    let scopes: Option<Vec<String>> = sqlx::query_scalar("SELECT b.scopes FROM bots b JOIN users u ON u.id=b.user_id WHERE b.user_id=$1 AND b.owner_id=$2 AND NOT u.disabled AND NOT u.deleted")
        .bind(bot)
        .bind(&actor.id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(scopes) = scopes else {
        return Err(refused("workflow_bot"));
    };
    let writes = scopes.iter().any(|s| s == "messages:write");
    if steps.is_empty() || steps.len() > STEPS_PER_WORKFLOW {
        return Err(refused("workflow_steps"));
    }
    let mut checked = Checked {
        command: None,
        next_fire_at: None,
    };
    match trigger {
        Trigger::Command { name } => {
            if !command_name(name) {
                return Err(refused("workflow_command"));
            }
            let taken: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM workflows WHERE command=$1 AND id IS DISTINCT FROM $2)",
            )
            .bind(name)
            .bind(workflow)
            .fetch_one(&mut **tx)
            .await?;
            if taken {
                return Err(Error::new(StatusCode::CONFLICT, "workflow_command_taken"));
            }
            checked.command = Some(name.clone());
        }
        Trigger::Schedule {
            every,
            time,
            days,
            timezone,
            room,
        } => {
            let (Some(at), Some(zone)) = (schedule::time(time), schedule::zone(timezone)) else {
                return Err(refused("workflow_schedule"));
            };
            if days.iter().any(|d| !(1..=7).contains(d)) {
                return Err(refused("workflow_schedule"));
            }
            checked.next_fire_at = Some(
                schedule::next(*every, at, days, zone, Utc::now())
                    .ok_or_else(|| refused("workflow_schedule"))?,
            );
            bot_room(tx, bot, room).await?;
        }
        Trigger::MemberJoined { room } => bot_room(tx, bot, room).await?,
        // Watching what is said in a room is reading it: the bot's `rooms:read`.
        Trigger::ReactionAdded { room, emoji } => {
            if let Some(emoji) = emoji {
                let code = emoji.trim_matches(':');
                let custom: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM custom_emoji_codes WHERE code=$1)",
                )
                .bind(code)
                .fetch_one(&mut **tx)
                .await?;
                if rv_protocol::emojis::canonical(code).is_none() && !custom {
                    return Err(refused("workflow_emoji"));
                }
            }
            reads(&scopes)?;
            bot_room(tx, bot, room).await?;
        }
        Trigger::MessagePosted { room, contains } => {
            if contains.trim().is_empty() || !short_text(contains, MATCH_BYTES) {
                return Err(refused("workflow_match"));
            }
            reads(&scopes)?;
            bot_room(tx, bot, room).await?;
        }
        Trigger::Webhook {} => {}
    }
    for step in steps {
        match step {
            Step::Message {
                room,
                text,
                cards,
                save_as,
                ..
            } => {
                if !writes {
                    return Err(Error::new(StatusCode::FORBIDDEN, "bot_scope_missing"));
                }
                step_room(tx, bot, trigger, room).await?;
                if (text.trim().is_empty() && cards.is_empty())
                    || !short_text(text, TEMPLATE_BYTES)
                    || !rv_protocol::cards::validate(cards)
                    || save_as.as_deref().is_some_and(|s| !variable_name(s))
                {
                    return Err(refused("workflow_message"));
                }
            }
            Step::Wait { seconds } => {
                if !(1..=WAIT_SECONDS).contains(seconds) {
                    return Err(refused("workflow_wait"));
                }
            }
            Step::Http {
                url,
                headers,
                body,
                save_as,
                ..
            } => {
                let literal = url.trim_start();
                if !(literal.starts_with("https://") || literal.starts_with("http://"))
                    || !short_text(url, 2048)
                    || headers.len() > HTTP_HEADERS
                    || headers.iter().any(|h| {
                        h.name.is_empty()
                            || h.name.len() > 64
                            || !h
                                .name
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                            || matches!(
                                h.name.to_ascii_lowercase().as_str(),
                                "host" | "content-length" | "transfer-encoding" | "connection"
                            )
                            || !short_text(&h.value, 1024)
                            || h.value.contains(['\r', '\n'])
                    })
                    || body
                        .as_deref()
                        .is_some_and(|b| !short_text(b, TEMPLATE_BYTES))
                    || save_as.as_deref().is_some_and(|s| !variable_name(s))
                {
                    return Err(refused("workflow_http"));
                }
            }
            Step::Form {
                room,
                recipient,
                title,
                fields,
                save_as,
            } => {
                if !writes {
                    return Err(Error::new(StatusCode::FORBIDDEN, "bot_scope_missing"));
                }
                step_room(tx, bot, trigger, room).await?;
                let mut ids = std::collections::BTreeSet::new();
                if title.trim().is_empty()
                    || !short_text(title, 256)
                    || fields.is_empty()
                    || fields.len() > FORM_FIELDS
                    || !variable_name(save_as)
                    || (*recipient == FormRecipient::TriggerUser && !trigger_user(trigger))
                    || fields.iter().any(|f| {
                        !variable_name(&f.id)
                            || !ids.insert(f.id.as_str())
                            || f.label.trim().is_empty()
                            || !short_text(&f.label, 256)
                            || (f.kind == FormFieldKind::Choice) != !f.options.is_empty()
                            || (f.kind != FormFieldKind::Person && !f.people.is_empty())
                            || (f.multiple
                                && !matches!(f.kind, FormFieldKind::Choice | FormFieldKind::Person))
                            || f.people.len() > PEOPLE_PER_FIELD
                            || f.people.iter().any(|p| !auth::identifier(p))
                            || f.options.len() > 20
                            || f.options
                                .iter()
                                .any(|o| o.trim().is_empty() || !short_text(o, 128))
                    })
                {
                    return Err(refused("workflow_form"));
                }
                // The people a field names are people, still here.
                let named: Vec<String> = fields.iter().flat_map(|f| f.people.clone()).collect();
                let known: i64 = sqlx::query_scalar("SELECT count(DISTINCT id) FROM users WHERE id=ANY($1) AND NOT bot AND NOT deleted AND NOT disabled")
                    .bind(&named)
                    .fetch_one(&mut **tx)
                    .await?;
                let distinct: std::collections::BTreeSet<&String> = named.iter().collect();
                if known as usize != distinct.len() {
                    return Err(refused("workflow_form"));
                }
            }
        }
    }
    Ok(checked)
}

async fn step_room(
    tx: &mut Transaction<'_, Postgres>,
    bot: &str,
    trigger: &Trigger,
    room: &str,
) -> Result<()> {
    if room == TRIGGER_ROOM {
        if !trigger_room(trigger) {
            return Err(refused("workflow_room"));
        }
        // A command's room is checked when it runs; the others are the trigger's.
        return Ok(());
    }
    bot_room(tx, bot, room).await
}

#[derive(FromRow)]
struct Row {
    id: String,
    owner_id: String,
    owner_username: String,
    owner_display_name: String,
    bot_id: String,
    bot_username: String,
    bot_display_name: String,
    name: String,
    description: String,
    enabled: bool,
    trigger: Json<Trigger>,
    steps: Json<Vec<Step>>,
    revision: String,
    has_webhook: bool,
    next_fire_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    run_id: Option<String>,
    run_state: Option<String>,
    run_step: Option<i32>,
    run_error: Option<String>,
    run_created_at: Option<DateTime<Utc>>,
    run_updated_at: Option<DateTime<Utc>>,
}

const SELECT: &str = "SELECT w.id,w.owner_id,o.username AS owner_username,o.display_name AS owner_display_name,w.bot_id,b.username AS bot_username,b.display_name AS bot_display_name,w.name,w.description,w.enabled,w.trigger,w.steps,w.revision,w.webhook_hash IS NOT NULL AS has_webhook,w.next_fire_at,w.created_at,w.updated_at,r.id AS run_id,r.state AS run_state,r.step AS run_step,r.error AS run_error,r.created_at AS run_created_at,r.updated_at AS run_updated_at FROM workflows w JOIN users o ON o.id=w.owner_id JOIN users b ON b.id=w.bot_id LEFT JOIN LATERAL (SELECT * FROM workflow_runs x WHERE x.workflow_id=w.id ORDER BY x.created_at DESC,x.id LIMIT 1) r ON true";

fn state(value: &str) -> RunState {
    match value {
        "pending" => RunState::Pending,
        "waiting" => RunState::Waiting,
        "done" => RunState::Done,
        "cancelled" => RunState::Cancelled,
        _ => RunState::Failed,
    }
}

fn person(id: String, username: String, display_name: String, bot: bool) -> User {
    User {
        id,
        username,
        display_name,
        bot,
        ..Default::default()
    }
}

/// What an administrator overseeing someone else's workflow sees of a header.
const HIDDEN: &str = "••••";

impl Row {
    /// `viewer` other than the owner (an administrator's oversight) gets the
    /// HTTP header values hidden: they are the owner's credentials elsewhere.
    fn wire(self, viewer: &str) -> Workflow {
        let mut steps = self.steps.0;
        if viewer != self.owner_id {
            for step in &mut steps {
                if let Step::Http { headers, .. } = step {
                    for header in headers {
                        header.value = HIDDEN.to_owned();
                    }
                }
            }
        }
        let last_run = match (self.run_id, self.run_created_at, self.run_updated_at) {
            (Some(id), Some(created), Some(updated)) => Some(WorkflowRun {
                id,
                state: state(self.run_state.as_deref().unwrap_or("failed")),
                step: self.run_step.unwrap_or(0) as u32,
                error: self.run_error,
                created_at: created.to_rfc3339(),
                updated_at: updated.to_rfc3339(),
            }),
            _ => None,
        };
        Workflow {
            id: self.id,
            owner: person(
                self.owner_id,
                self.owner_username,
                self.owner_display_name,
                false,
            ),
            bot: person(self.bot_id, self.bot_username, self.bot_display_name, true),
            name: self.name,
            description: self.description,
            enabled: self.enabled,
            trigger: self.trigger.0,
            steps,
            revision: self.revision,
            has_webhook: self.has_webhook,
            next_fire_at: self.next_fire_at.map(|t| t.to_rfc3339()),
            last_run,
            created_at: self.created_at.to_rfc3339(),
            updated_at: self.updated_at.to_rfc3339(),
        }
    }
}

async fn row(tx: &mut Transaction<'_, Postgres>, id: &str, viewer: &str) -> Result<Workflow> {
    let row: Row = sqlx::query_as(&format!("{SELECT} WHERE w.id=$1"))
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(Error::missing)?;
    Ok(row.wire(viewer))
}

/// Locks a workflow the actor may manage: its owner, or (`oversight`) an
/// administrator, who may look, disable and delete, never edit.
async fn managed(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    id: &str,
    oversight: bool,
) -> Result<()> {
    if !auth::identifier(id) {
        return Err(Error::invalid());
    }
    let owner: Option<String> =
        sqlx::query_scalar("SELECT owner_id FROM workflows WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    match owner {
        Some(owner) if owner == actor.id || (oversight && actor.admin) => Ok(()),
        _ => Err(Error::missing()),
    }
}

fn person_only(actor: &Account) -> Result<()> {
    if actor.bot {
        return Err(Error::forbidden());
    }
    Ok(())
}

pub(crate) async fn list(app: &App, actor: &Account, all: bool) -> Result<WorkflowList> {
    person_only(actor)?;
    if all {
        crate::admin::require_admin(actor)?;
    }
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "{SELECT} WHERE ($1 OR w.owner_id=$2) ORDER BY lower(w.name),w.id LIMIT 500"
    ))
    .bind(all)
    .bind(&actor.id)
    .fetch_all(&app.pool)
    .await?;
    Ok(WorkflowList {
        workflows: rows.into_iter().map(|r| r.wire(&actor.id)).collect(),
    })
}

pub(crate) async fn get(app: &App, actor: &Account, id: &str) -> Result<Workflow> {
    person_only(actor)?;
    let mut tx = app.pool.begin().await?;
    managed(&mut tx, actor, id, true).await?;
    let workflow = row(&mut tx, id, &actor.id).await?;
    tx.commit().await?;
    Ok(workflow)
}

pub(crate) async fn create(app: &App, actor: &Account, input: CreateWorkflow) -> Result<Workflow> {
    person_only(actor)?;
    let hash = fingerprint(json!([
        "workflow.create",
        input.name,
        input.description,
        input.bot_id,
        input.trigger,
        input.steps,
        input.enabled
    ]));
    let (mut tx, replay) = admit(app, actor, false, &input.operation_id, &hash).await?;
    if replay {
        let id: String =
            sqlx::query_scalar("SELECT id FROM workflows WHERE owner_id=$1 AND operation_id=$2")
                .bind(&actor.id)
                .bind(&input.operation_id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(Error::missing)?;
        let workflow = row(&mut tx, &id, &actor.id).await?;
        tx.commit().await?;
        return Ok(workflow);
    }
    allowed(&mut tx, actor).await?;
    let owned: i64 = sqlx::query_scalar("SELECT count(*) FROM workflows WHERE owner_id=$1")
        .bind(&actor.id)
        .fetch_one(&mut *tx)
        .await?;
    if owned >= WORKFLOWS_PER_OWNER {
        return Err(Error::new(StatusCode::CONFLICT, "workflow_limit"));
    }
    let checked = check(
        &mut tx,
        actor,
        None,
        &input.name,
        &input.description,
        &input.bot_id,
        &input.trigger,
        &input.steps,
    )
    .await?;
    let id = random_token()[..24].to_owned();
    sqlx::query("INSERT INTO workflows(id,owner_id,bot_id,name,description,enabled,trigger,steps,command,next_fire_at,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(&id)
        .bind(&actor.id)
        .bind(&input.bot_id)
        .bind(input.name.trim())
        .bind(&input.description)
        .bind(input.enabled)
        .bind(Json(&input.trigger))
        .bind(Json(&input.steps))
        .bind(&checked.command)
        .bind(checked.next_fire_at)
        .bind(&input.operation_id)
        .execute(&mut *tx)
        .await
        .map_err(unique_command)?;
    engine::ensure_session(&mut tx, &input.bot_id).await?;
    operator::record(
        &mut tx,
        "workflow.created",
        &id,
        json!({"bot":input.bot_id,"enabled":input.enabled}),
    )
    .await?;
    let workflow = row(&mut tx, &id, &actor.id).await?;
    settle(tx, actor, &input.operation_id, &hash).await?;
    Ok(workflow)
}

fn unique_command(error: sqlx::Error) -> Error {
    match &error {
        sqlx::Error::Database(e) if e.is_unique_violation() => {
            Error::new(StatusCode::CONFLICT, "workflow_command_taken")
        }
        _ => error.into(),
    }
}

/// Who may create a workflow is who may create a bot (RFC 0003 §3).
async fn allowed(tx: &mut Transaction<'_, Postgres>, actor: &Account) -> Result<()> {
    let user_bots: bool = sqlx::query_scalar("SELECT user_bots FROM instance WHERE singleton")
        .fetch_one(&mut **tx)
        .await?;
    if !actor.admin && !user_bots {
        return Err(Error::new(StatusCode::FORBIDDEN, "bots_disabled"));
    }
    Ok(())
}

pub(crate) async fn update(
    app: &App,
    actor: &Account,
    id: &str,
    input: UpdateWorkflow,
) -> Result<Workflow> {
    person_only(actor)?;
    let hash = fingerprint(json!([
        "workflow.update",
        id,
        input.revision,
        input.name,
        input.description,
        input.bot_id,
        input.trigger,
        input.steps,
        input.enabled
    ]));
    let (mut tx, replay) = admit(app, actor, false, &input.operation_id, &hash).await?;
    if replay {
        let workflow = row(&mut tx, id, &actor.id).await?;
        tx.commit().await?;
        return Ok(workflow);
    }
    managed(&mut tx, actor, id, false).await?;
    let (revision, old_bot): (String, String) =
        sqlx::query_as("SELECT revision,bot_id FROM workflows WHERE id=$1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if revision != input.revision {
        return Err(Error::new(StatusCode::CONFLICT, "revision_conflict"));
    }
    let checked = check(
        &mut tx,
        actor,
        Some(id),
        &input.name,
        &input.description,
        &input.bot_id,
        &input.trigger,
        &input.steps,
    )
    .await?;
    // A trigger moved off webhook forgets its secret: switching back needs a new one.
    sqlx::query("UPDATE workflows SET name=$2,description=$3,bot_id=$4,enabled=$5,trigger=$6,steps=$7,command=$8,next_fire_at=$9,webhook_hash=CASE WHEN $6->>'kind'='webhook' THEN webhook_hash END,revision=gen_random_uuid()::text,updated_at=clock_timestamp() WHERE id=$1")
        .bind(id)
        .bind(input.name.trim())
        .bind(&input.description)
        .bind(&input.bot_id)
        .bind(input.enabled)
        .bind(Json(&input.trigger))
        .bind(Json(&input.steps))
        .bind(&checked.command)
        .bind(checked.next_fire_at)
        .execute(&mut *tx)
        .await
        .map_err(unique_command)?;
    if !input.enabled {
        cancel_runs(&mut tx, id).await?;
    }
    engine::ensure_session(&mut tx, &input.bot_id).await?;
    if old_bot != input.bot_id {
        engine::release_session(&mut tx, &old_bot).await?;
    }
    operator::record(
        &mut tx,
        "workflow.updated",
        id,
        json!({"enabled":input.enabled}),
    )
    .await?;
    let workflow = row(&mut tx, id, &actor.id).await?;
    settle(tx, actor, &input.operation_id, &hash).await?;
    Ok(workflow)
}

async fn cancel_runs(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<()> {
    sqlx::query("UPDATE workflow_runs SET state='cancelled',lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE workflow_id=$1 AND state IN ('pending','waiting')")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Owner or administrator: stops it and its unfinished runs.
pub(crate) async fn disable(app: &App, actor: &Account, id: &str) -> Result<Workflow> {
    person_only(actor)?;
    let operation = random_token()[..32].to_owned();
    let hash = fingerprint(json!(["workflow.disable", id, operation]));
    let (mut tx, _) = admit(app, actor, false, &operation, &hash).await?;
    managed(&mut tx, actor, id, true).await?;
    sqlx::query("UPDATE workflows SET enabled=false,revision=gen_random_uuid()::text,updated_at=clock_timestamp() WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    cancel_runs(&mut tx, id).await?;
    operator::record(&mut tx, "workflow.disabled", id, json!({})).await?;
    let workflow = row(&mut tx, id, &actor.id).await?;
    settle(tx, actor, &operation, &hash).await?;
    Ok(workflow)
}

pub(crate) async fn delete(app: &App, actor: &Account, id: &str) -> Result<()> {
    person_only(actor)?;
    let operation = random_token()[..32].to_owned();
    let hash = fingerprint(json!(["workflow.delete", id]));
    let (mut tx, _) = admit(app, actor, false, &operation, &hash).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflows WHERE id=$1)")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if !exists {
        tx.commit().await?;
        return Ok(());
    }
    managed(&mut tx, actor, id, true).await?;
    let bot: String = sqlx::query_scalar("DELETE FROM workflows WHERE id=$1 RETURNING bot_id")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    engine::release_session(&mut tx, &bot).await?;
    operator::record(&mut tx, "workflow.deleted", id, json!({})).await?;
    settle(tx, actor, &operation, &hash).await?;
    Ok(())
}

/// A new webhook secret, the only time it is shown; the old one stops working.
pub(crate) async fn webhook(app: &App, actor: &Account, id: &str) -> Result<WebhookSecret> {
    person_only(actor)?;
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    managed(&mut tx, actor, id, false).await?;
    let kind: Json<Trigger> = sqlx::query_scalar("SELECT trigger FROM workflows WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if !matches!(kind.0, Trigger::Webhook {}) {
        return Err(refused("workflow_not_webhook"));
    }
    crate::factors::recent(&mut tx, actor).await?;
    let secret = random_token();
    sqlx::query("UPDATE workflows SET webhook_hash=$2,updated_at=clock_timestamp() WHERE id=$1")
        .bind(id)
        .bind(auth::hash_token(&secret))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(WebhookSecret {
        path: format!("/api/v1/hooks/{id}/{secret}"),
    })
}

pub(crate) async fn runs(app: &App, actor: &Account, id: &str) -> Result<WorkflowRunList> {
    person_only(actor)?;
    let mut tx = app.pool.begin().await?;
    managed(&mut tx, actor, id, true).await?;
    type RunRow = (
        String,
        String,
        i32,
        Option<String>,
        DateTime<Utc>,
        DateTime<Utc>,
    );
    let rows: Vec<RunRow> = sqlx::query_as("SELECT id,state,step,error,created_at,updated_at FROM workflow_runs WHERE workflow_id=$1 ORDER BY created_at DESC,id LIMIT 50")
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(WorkflowRunList {
        runs: rows
            .into_iter()
            .map(
                |(id, state_name, step, error, created, updated)| WorkflowRun {
                    id,
                    state: state(&state_name),
                    step: step as u32,
                    error,
                    created_at: created.to_rfc3339(),
                    updated_at: updated.to_rfc3339(),
                },
            )
            .collect(),
    })
}

fn user_json(id: &str, username: &str, display_name: &str) -> Value {
    json!({"id": id, "username": username, "display_name": display_name})
}

async fn user_context(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<Value> {
    let (username, display_name): (String, String) =
        sqlx::query_as("SELECT username,display_name FROM users WHERE id=$1")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    Ok(user_json(id, &username, &display_name))
}

async fn room_context(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<Value> {
    let name: String = sqlx::query_scalar("SELECT name FROM rooms WHERE id=$1")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(json!({"id": id, "name": name}))
}

/// Starts a run of an enabled workflow with its current definition and bot,
/// inside the caller's transaction; refuses past the workflow's budgets.
pub(crate) async fn start(
    tx: &mut Transaction<'_, Postgres>,
    workflow: &str,
    trigger: Value,
) -> Result<String> {
    start_run(tx, workflow, trigger, true).await
}

async fn start_run(
    tx: &mut Transaction<'_, Postgres>,
    workflow: &str,
    trigger: Value,
    enabled_only: bool,
) -> Result<String> {
    let definition: Option<(String, Json<Vec<Step>>, String)> = sqlx::query_as(
        "SELECT revision,steps,bot_id FROM workflows WHERE id=$1 AND (enabled OR NOT $2) FOR SHARE",
    )
    .bind(workflow)
    .bind(enabled_only)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((revision, steps, bot)) = definition else {
        return Err(Error::missing());
    };
    let (attempts, retry): (i32, i64) = sqlx::query_as("INSERT INTO workflow_windows(workflow_id,attempts,expires_at) VALUES($1,1,clock_timestamp()+interval '60 seconds') ON CONFLICT(workflow_id) DO UPDATE SET attempts=CASE WHEN workflow_windows.expires_at<=clock_timestamp() THEN 1 ELSE workflow_windows.attempts+1 END,expires_at=CASE WHEN workflow_windows.expires_at<=clock_timestamp() THEN clock_timestamp()+interval '60 seconds' ELSE workflow_windows.expires_at END RETURNING attempts,GREATEST(1,ceil(extract(epoch from expires_at-clock_timestamp())))::bigint")
        .bind(workflow)
        .fetch_one(&mut **tx)
        .await?;
    if i64::from(attempts) > RUNS_PER_MINUTE {
        return Err(Error::throttled("workflow_rate_limited", retry as u64));
    }
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workflow_runs WHERE workflow_id=$1 AND state IN ('pending','waiting')",
    )
    .bind(workflow)
    .fetch_one(&mut **tx)
    .await?;
    if open >= OPEN_RUNS {
        return Err(Error::throttled("workflow_busy", 60));
    }
    let id = random_token()[..24].to_owned();
    sqlx::query("INSERT INTO workflow_runs(id,workflow_id,revision,definition,context,bot_id) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(&id)
        .bind(workflow)
        .bind(revision)
        .bind(steps)
        .bind(Json(trigger))
        .bind(bot)
        .execute(&mut **tx)
        .await?;
    Ok(id)
}

/// `POST /workflows/{id}/test`: a run now, enabled or not, the owner as
/// `trigger.user`, in the room the trigger names. A command names no room: it is
/// tried by typing it in one (`workflow_test_command`).
pub(crate) async fn test(app: &App, actor: &Account, id: &str) -> Result<RunStarted> {
    person_only(actor)?;
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    managed(&mut tx, actor, id, false).await?;
    let trigger: Json<Trigger> = sqlx::query_scalar("SELECT trigger FROM workflows WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if matches!(trigger.0, Trigger::Command { .. }) {
        return Err(refused("workflow_test_command"));
    }
    let mut context = json!({"kind": "test", "user": user_context(&mut tx, &actor.id).await?});
    if let Trigger::Schedule { room, .. }
    | Trigger::MemberJoined { room }
    | Trigger::ReactionAdded { room, .. }
    | Trigger::MessagePosted { room, .. } = &trigger.0
    {
        context["room"] = room_context(&mut tx, room).await?;
    }
    let run_id = start_run(
        &mut tx,
        id,
        json!({"trigger": context, "webhook": {}}),
        false,
    )
    .await?;
    tx.commit().await?;
    Ok(RunStarted { run_id })
}

/// Workflow commands a person may run in a room: its bot belongs to it, so do
/// they, and the room is plaintext.
pub(crate) async fn commands(
    app: &App,
    actor: &Account,
    room: &str,
) -> Result<Vec<rv_protocol::commands::SlashCommand>> {
    if !auth::identifier(room) {
        return Err(Error::invalid());
    }
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT w.command,w.name FROM workflows w WHERE w.enabled AND w.command IS NOT NULL AND EXISTS(SELECT 1 FROM members m WHERE m.room_id=$1 AND m.user_id=w.bot_id) AND EXISTS(SELECT 1 FROM members m WHERE m.room_id=$1 AND m.user_id=$2) AND NOT EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=$1) ORDER BY w.command")
        .bind(room)
        .bind(&actor.id)
        .fetch_all(&app.pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(command, name)| rv_protocol::commands::SlashCommand {
            command,
            params: String::new(),
            description: name,
            client_side: false,
        })
        .collect())
}

/// `commands::run` for a name no core command has. `None`: no workflow either.
pub(crate) async fn run_command(
    app: &App,
    actor: &Account,
    room: &str,
    name: &str,
    text: &str,
) -> Result<Option<()>> {
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let workflow: Option<(String, String)> =
        sqlx::query_as("SELECT id,bot_id FROM workflows WHERE command=$1 AND enabled")
            .bind(name)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((workflow, bot)) = workflow else {
        return Ok(None);
    };
    crate::store::require_member(&mut tx, room, &actor.id).await?;
    bot_room(&mut tx, &bot, room)
        .await
        .map_err(|_| Error::new(StatusCode::CONFLICT, "workflow_unavailable"))?;
    let trigger = json!({
        "kind": "command",
        "user": user_context(&mut tx, &actor.id).await?,
        "room": room_context(&mut tx, room).await?,
        "text": text,
    });
    start(&mut tx, &workflow, json!({"trigger": trigger})).await?;
    tx.commit().await?;
    Ok(Some(()))
}

/// Called inside a join or an invitation: runs the room's `member_joined`
/// workflows for a person. A workflow past its budget is skipped, never the join.
pub(crate) async fn on_join(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    user: &str,
) -> Result<()> {
    let bot: bool = sqlx::query_scalar("SELECT bot FROM users WHERE id=$1")
        .bind(user)
        .fetch_one(&mut **tx)
        .await?;
    if bot {
        return Ok(());
    }
    let workflows = watching(tx, room, "member_joined").await?;
    if workflows.is_empty() {
        return Ok(());
    }
    let trigger = json!({
        "kind": "member_joined",
        "user": user_context(tx, user).await?,
        "room": room_context(tx, room).await?,
    });
    fire(tx, workflows.into_iter().map(|(id, _)| id), trigger).await
}

/// Called inside a person's new message (never an edit, never a bot's): runs
/// the room's `message_posted` workflows whose text it contains, ignoring case.
pub(crate) async fn on_message(
    tx: &mut Transaction<'_, Postgres>,
    author: &Account,
    room: &str,
    message: &rv_protocol::Message,
) -> Result<()> {
    if author.bot || message.text.is_empty() {
        return Ok(());
    }
    let text = message.text.to_lowercase();
    let matching: Vec<String> = watching(tx, room, "message_posted")
        .await?
        .into_iter()
        .filter_map(|(id, trigger)| match trigger.0 {
            Trigger::MessagePosted { contains, .. }
                if text.contains(&contains.trim().to_lowercase()) =>
            {
                Some(id)
            }
            _ => None,
        })
        .collect();
    if matching.is_empty() {
        return Ok(());
    }
    let trigger = message_trigger(tx, "message_posted", &author.id, room, message).await?;
    fire(tx, matching, trigger).await
}

/// Called inside a person's new reaction (never a bot's, never a removal):
/// runs the room's `reaction_added` workflows for any emoji or for this one.
/// `emoji` is the stored name, `requested` the code the person sent.
pub(crate) async fn on_reaction(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    room: &str,
    message: &rv_protocol::Message,
    emoji: &str,
    requested: &str,
) -> Result<()> {
    if actor.bot {
        return Ok(());
    }
    let canonical = rv_protocol::emojis::canonical(emoji).unwrap_or(emoji);
    let matching: Vec<String> = watching(tx, room, "reaction_added")
        .await?
        .into_iter()
        .filter_map(|(id, trigger)| match trigger.0 {
            Trigger::ReactionAdded { emoji: None, .. } => Some(id),
            Trigger::ReactionAdded {
                emoji: Some(wanted),
                ..
            } => {
                let wanted = wanted.trim_matches(':');
                (wanted == requested
                    || wanted == emoji
                    || rv_protocol::emojis::canonical(wanted) == Some(canonical))
                .then_some(id)
            }
            _ => None,
        })
        .collect();
    if matching.is_empty() {
        return Ok(());
    }
    let mut trigger = message_trigger(tx, "reaction_added", &actor.id, room, message).await?;
    trigger["emoji"] = json!(canonical);
    fire(tx, matching, trigger).await
}

/// The enabled workflows a room's event may start, with their trigger.
async fn watching(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
    kind: &str,
) -> Result<Vec<(String, Json<Trigger>)>> {
    // Checked when the event happens, not only when saved: a bot removed from the
    // room, disabled, or stripped of `rooms:read` stops watching it.
    Ok(sqlx::query_as(
        "SELECT w.id,w.trigger FROM workflows w JOIN users b ON b.id=w.bot_id JOIN bots s ON s.user_id=w.bot_id WHERE w.enabled AND w.trigger->>'room'=$1 AND w.trigger->>'kind'=$2 AND NOT b.disabled AND NOT b.deleted AND EXISTS(SELECT 1 FROM members m WHERE m.room_id=$1 AND m.user_id=w.bot_id) AND ($2='member_joined' OR 'rooms:read'=ANY(s.scopes)) AND NOT EXISTS(SELECT 1 FROM e2ee_groups g WHERE g.room_id=$1)",
    )
    .bind(room)
    .bind(kind)
    .fetch_all(&mut **tx)
    .await?)
}

/// `trigger` for an event about a message: who acted, where, the message, and
/// its thread (its root, or itself) for a step that replies in it.
async fn message_trigger(
    tx: &mut Transaction<'_, Postgres>,
    kind: &str,
    user: &str,
    room: &str,
    message: &rv_protocol::Message,
) -> Result<Value> {
    Ok(json!({
        "kind": kind,
        "user": user_context(tx, user).await?,
        "room": room_context(tx, room).await?,
        "message": {
            "id": message.id,
            "text": message.text,
            "author": user_json(&message.author.id, &message.author.username, &message.author.display_name),
        },
        "thread": message.reply_to.as_deref().unwrap_or(&message.id),
    }))
}

/// Starts each workflow's run; one past its budget, or disabled or deleted since
/// it was read, is skipped, never the event.
async fn fire(
    tx: &mut Transaction<'_, Postgres>,
    workflows: impl IntoIterator<Item = String>,
    trigger: Value,
) -> Result<()> {
    for workflow in workflows {
        match start(tx, &workflow, json!({"trigger": trigger})).await {
            Ok(_) => {}
            Err(error)
                if error.status == StatusCode::TOO_MANY_REQUESTS
                    || error.status == StatusCode::NOT_FOUND => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// `POST /api/v1/hooks/{id}/{secret}`: the secret is the credential. A wrong
/// secret, an unknown or disabled workflow all answer `not_found`.
pub(crate) async fn hook(app: &App, id: &str, secret: &str, body: &[u8]) -> Result<RunStarted> {
    if !auth::identifier(id) || secret.len() != 64 {
        return Err(Error::missing());
    }
    if body.len() > WEBHOOK_BYTES {
        return Err(Error::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "webhook_too_large",
        ));
    }
    let payload: Value = if body.iter().all(u8::is_ascii_whitespace) {
        json!({})
    } else {
        serde_json::from_slice(body).map_err(|_| refused("webhook_json"))?
    };
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let matches: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflows WHERE id=$1 AND enabled AND webhook_hash=$2 AND trigger->>'kind'='webhook')")
        .bind(id)
        .bind(auth::hash_token(secret))
        .fetch_one(&mut *tx)
        .await?;
    if !matches {
        return Err(Error::missing());
    }
    let run_id = start(
        &mut tx,
        id,
        json!({"trigger": {"kind": "webhook"}, "webhook": payload}),
    )
    .await?;
    tx.commit().await?;
    Ok(RunStarted { run_id })
}

/// Answers a form a run waits on: the recipient, or any member of the room
/// for an open form. The message shows who answered; the run resumes.
pub(crate) async fn answer(
    app: &App,
    actor: &Account,
    message: &str,
    input: AnswerForm,
) -> Result<()> {
    person_only(actor)?;
    if !auth::identifier(message) || !auth::identifier(&input.operation_id) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    type FormRow = (
        String,
        String,
        Option<String>,
        Json<Vec<rv_protocol::workflows::FormField>>,
        Option<String>,
        Option<String>,
        bool,
    );
    let form: Option<FormRow> = sqlx::query_as("SELECT run_id,room_id,recipient_id,fields,answered_by,operation_id,expires_at<=clock_timestamp() FROM workflow_forms f WHERE message_id=$1 AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=f.message_id AND m.deleted) FOR UPDATE")
        .bind(message)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((run, room, recipient, fields, answered_by, operation, expired)) = form else {
        return Err(Error::missing());
    };
    crate::store::require_member(&mut tx, &room, &actor.id).await?;
    if recipient.as_deref().is_some_and(|r| r != actor.id) {
        return Err(Error::forbidden());
    }
    if let Some(by) = answered_by {
        // The same answer again is the same success; anyone else is too late.
        if by == actor.id && operation.as_deref() == Some(input.operation_id.as_str()) {
            tx.commit().await?;
            return Ok(());
        }
        return Err(Error::new(StatusCode::CONFLICT, "form_answered"));
    }
    if expired {
        return Err(Error::new(StatusCode::CONFLICT, "form_expired"));
    }
    let mut answers = serde_json::Map::new();
    for field in &fields.0 {
        let mut values = input
            .answers
            .get(&field.id)
            .map(|v| v.values())
            .unwrap_or_default();
        values.sort_unstable();
        values.dedup();
        if values.is_empty() {
            if field.required {
                return Err(refused("form_required"));
            }
            continue;
        }
        if values.len() > 1 && !field.multiple {
            return Err(refused("form_value"));
        }
        for value in &values {
            let value = *value;
            let ok = match field.kind {
            FormFieldKind::Text => value.len() <= 1024 && !value.contains('\n'),
            FormFieldKind::LongText => value.len() <= 4096,
            FormFieldKind::Number => value.parse::<f64>().is_ok_and(f64::is_finite),
            FormFieldKind::Choice => field.options.iter().any(|o| o == value),
            FormFieldKind::Person => {
                auth::identifier(value)
                    && (field.people.is_empty() || field.people.iter().any(|p| p == value))
                    && sqlx::query_scalar::<_, bool>(
                        "SELECT EXISTS(SELECT 1 FROM users u WHERE u.id=$1 AND NOT u.bot AND NOT u.deleted AND NOT u.disabled AND ($3 OR EXISTS(SELECT 1 FROM members m WHERE m.room_id=$2 AND m.user_id=u.id)))",
                    )
                    .bind(value)
                    .bind(&room)
                    .bind(!field.people.is_empty())
                    .fetch_one(&mut *tx)
                    .await?
            }
            };
            if !ok || value.contains('\0') {
                return Err(refused("form_value"));
            }
        }
        // A multiple field keeps the order its options or people have.
        let answer = if field.multiple {
            let order: &[String] = if field.kind == FormFieldKind::Choice {
                &field.options
            } else {
                &field.people
            };
            values.sort_by_key(|v| order.iter().position(|o| o == v).unwrap_or(usize::MAX));
            json!(values)
        } else {
            json!(values[0])
        };
        answers.insert(field.id.clone(), answer);
    }
    if input
        .answers
        .keys()
        .any(|k| !fields.0.iter().any(|f| &f.id == k))
    {
        return Err(refused("form_value"));
    }
    sqlx::query("UPDATE workflow_forms SET answers=$2,answered_by=$3,answered_at=clock_timestamp(),operation_id=$4 WHERE message_id=$1")
        .bind(message)
        .bind(Json(Value::Object(answers)))
        .bind(&actor.id)
        .bind(&input.operation_id)
        .execute(&mut *tx)
        .await?;
    crate::store::republish(&mut tx, &room, message).await?;
    sqlx::query(
        "UPDATE workflow_runs SET wake_at=clock_timestamp() WHERE id=$1 AND state='waiting'",
    )
    .bind(&run)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
