# Workflows

Design and rationale: [RFC 0004](../rfcs/0004-workflows.md). Types:
`crates/rv-protocol/src/workflows.rs`. The server announces the feature with the
`workflows` capability.

A workflow belongs to a person and **acts through one of their bots**
([BOTS.md](BOTS.md)): what it posts is the bot's (badge, scopes, memberships,
budgets, refusal of encrypted rooms). Who may create one is who may create a bot:
`AccountPermissions.create_bot`.

## Definition

```json
{"operation_id": "create-standup", "name": "Standup", "description": "",
 "bot_id": "<one of my bots>", "enabled": true,
 "trigger": {"kind": "command", "name": "standup"},
 "steps": [
   {"kind": "form", "room": "trigger", "recipient": "trigger_user", "title": "Standup",
    "fields": [{"id": "today", "label": "Today", "kind": "long_text", "required": true}],
    "save_as": "standup"},
   {"kind": "message", "room": "trigger", "text": "{{standup.by.display_name}}: {{standup.answers.today}}"}
 ]}
```

### Triggers (`kind`)

| Kind | Fields | The run sees |
|---|---|---|
| `command` | `name`: `[a-z0-9_-]{1,32}`, not a core command, unique | `trigger.user`, `trigger.room`, `trigger.text` |
| `schedule` | `every`: `hour` (fires at the minute of `time`), `day`, `week` (on `days`, 1 Monday to 7 Sunday); `time` `HH:MM`; `timezone` IANA (`Europe/Paris`); `room` | `trigger.room`, `trigger.at` |
| `member_joined` | `room` | `trigger.user`, `trigger.room` |
| `webhook` | none | `webhook` (the JSON body) |

`trigger.user` is `{id, username, display_name}`, `trigger.room` is `{id, name}`.
A test run (`POST /workflows/{id}/test`) has `trigger.kind` `test`, the caller as
`trigger.user`, and the trigger's room when it names one.

### Steps (`kind`)

| Kind | Fields | `save_as` gets |
|---|---|---|
| `message` | `room` (`trigger` or a room id), `text`, `cards?`, `in_thread?`, `save_as?` | `{message_id}` |
| `wait` | `seconds`, 1 to 2,592,000 (30 days) | |
| `http` | `method` (`GET` `POST` `PUT` `PATCH` `DELETE`), `url` (starts with `http://` or `https://`), `headers?` `[{name, value}]` (10 at most), `body?`, `save_as?`, `continue_on_error?` | `{status, body}`: JSON when it parses, else text, 64 KiB at most; `{status: 0, error}` on a failure kept by `continue_on_error` |
| `form` | `room`, `recipient` (`trigger_user` or `anyone`), `title`, `fields` (1 to 10: `{id, label, kind: text\|long_text\|number\|choice, options?, required}`), `save_as` | `{answers: {field id: text}, by: user}` |

- `room: "trigger"` needs a trigger that has a room (not `webhook`). A fixed room
  must be one the bot belongs to, plaintext.
- `message` and `form` need the bot's `messages:write`.
- `save_as` and field ids: `[a-z0-9_]{1,32}`, not `trigger`, `webhook`, `now`.
- `recipient: trigger_user` needs a `command` or `member_joined` trigger.
- Text, URL, header values and body are templates: `{{path.to.value}}` looks up
  the run's context (`trigger`, `webhook`, `now`, every `save_as`); a list index is
  a number (`{{order.body.items.0.name}}`); a missing path renders empty, an object
  or list renders as JSON.
- HTTP reaches public addresses only, 10 s, no redirect followed.

### Limits

20 workflows per person, 20 steps each, 30 runs a minute per workflow (webhook
calls included), 100 unfinished runs per workflow, a form open 7 days.

## Routes (a person's session; never a bot key)

| Route | Effect |
|---|---|
| `GET /api/v1/workflows` | `WorkflowList`, mine; `?all=true` every workflow, administrators only |
| `POST /api/v1/workflows` | `CreateWorkflow` → `Workflow` |
| `GET /api/v1/workflows/{id}` | `Workflow`: definition, `revision`, `has_webhook`, `next_fire_at`, `last_run` |
| `PUT /api/v1/workflows/{id}` | `UpdateWorkflow` (the whole definition, the expected `revision`) → `Workflow`; `revision_conflict` when it moved |
| `DELETE /api/v1/workflows/{id}` | Deletes it and its runs. Idempotent |
| `POST /api/v1/workflows/{id}/disable` | Turns it off and cancels its unfinished runs (owner or administrator) |
| `POST /api/v1/workflows/{id}/webhook` | `WebhookSecret{path}`: a new secret, the only time it is shown; needs a recent sign-in |
| `GET /api/v1/workflows/{id}/runs` | `WorkflowRunList`: the last 50 runs, `state` (`pending`, `waiting`, `done`, `failed`, `cancelled`), `step`, `error` |
| `POST /api/v1/workflows/{id}/test` | `RunStarted{run_id}`: a run now |
| `POST /api/v1/hooks/{id}/{secret}` | No session. JSON body (16 KiB) → `202 RunStarted`; `404` for anything wrong |
| `POST /api/v1/forms/{message}/answer` | `AnswerForm{operation_id, answers}` → `204` |
| `GET /api/v1/commands?room={id}` | The core commands plus the workflow commands offered in that room |

The owner edits; an administrator lists, disables and deletes any workflow, never
edits one (`not_found`). Disabling cancels unfinished runs; editing leaves started
runs on their own definition.

## Forms in messages

A `form` step posts a message whose text is the form's title and whose
`Message.form` is a `WorkflowForm{title, fields, recipient?, answered_by?,
answered_at?, expires_at}`. When answered, the message is published again with
`answered_by`; the apps show the card answered. Answering:

- the recipient only (`permission_denied` for anyone else), any member when there is
  no recipient;
- `form_required` (a required field empty), `form_value` (a number that does not
  parse, a choice not in `options`, an unknown field, a text too long: 1,024 bytes,
  long text 4,096), `form_answered` (someone answered first; the same operation
  again succeeds), `form_expired`.

## Errors

Saving: `bots_disabled`, `workflow_limit`, `workflow_bot` (not my live bot),
`bot_scope_missing`, `workflow_bot_not_member`, `crypto_required` (an encrypted
room), `workflow_room`, `workflow_command`, `workflow_command_taken`,
`workflow_schedule`, `workflow_steps`, `workflow_message`, `workflow_wait`,
`workflow_http`, `workflow_form`, `revision_conflict`. Running a command:
`workflow_unavailable` (its bot is not in that room, or the room is encrypted),
`workflow_rate_limited`, `workflow_busy`. A run's `error`: the failing step's code
(`bot_scope_missing`, `crypto_required`, `http_address`, `http_url`,
`http_failed`, `form_expired`, `bot_unavailable`, `workflow_retries`...).

## Audit

`workflow.created`, `workflow.updated`, `workflow.disabled`, `workflow.deleted`.
