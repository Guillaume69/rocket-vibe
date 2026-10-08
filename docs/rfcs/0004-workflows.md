# RFC 0004: Workflows on the RocketVibe server

| Field | Value |
|---|---|
| Date | 8 October 2026 |
| Status | Draft, implementation on `feature/workflows` |
| Reference | RFC 0003 (bots), its layer 4; `docs/protocol/BOTS.md` |
| Clients | Providers of the current mobile, GTK and SwiftUI apps (RocketVibe server only) |

## 1. Summary

A **workflow** is a small automation a person builds in the apps, in the spirit
of Slack's Workflow Builder: one **trigger** (a slash command, a schedule,
someone joining a room, an incoming webhook) starts a **run**, which goes through
a list of **steps** (send a message, wait, call an HTTP service, ask a form and
wait for the answer). Values flow between steps as `{{variables}}`.

A workflow **acts through one of its owner's bots** (RFC 0003). Every message it
posts is the bot's: the BOT badge, the bot's scopes, its room memberships, its
budgets and its refusal of encrypted rooms all apply unchanged. A workflow can do
nothing its bot could not. Who may create one is who may create a bot: an
administrator always, everyone when the instance allows bots.

Rocket.Chat servers have their own automation; there the feature is `n/a`.

## 2. Goals and non-goals

Goals: the four triggers and four steps above; a simple editor in the three apps
(a trigger, an ordered list of steps, native forms, no canvas); durable runs that
survive a restart and never post twice; a run history per workflow; forms
answered natively in the room.

Non-goals of this layer: branching and loops, steps that call another workflow,
spreadsheets or lists, third-party connectors, workflows in encrypted rooms, a
visual builder.

## 3. Data model (migration `0053_workflows.sql`)

- `workflows(id, owner_id → users, bot_id → bots, name, description, enabled,
  trigger jsonb, steps jsonb, revision, command (unique among live workflows),
  webhook_hash, next_fire_at, created_at, updated_at, operation_id)`.
- `workflow_runs(id, workflow_id, revision, definition jsonb (the steps as they
  were when the run began), context jsonb, step, state, wake_at, lease_id,
  lease_expires_at, attempts, error, created_at, updated_at)`. States:
  `pending`, `waiting` (a wait or a form), `done`, `failed`, `cancelled`.
- `workflow_forms(message_id → messages, run_id, step, recipient_id, fields,
  answers, answered_by, answered_at)`.
- The engine acts with a **workflow session** of the bot: a key of its own
  (`bot_keys.internal`), never listed nor counted among the bot's keys, created
  with the first workflow on that bot and removed with the last. Authentication,
  `lock_active` and the send path apply unchanged; scopes are checked per step.

Limits: 20 workflows per owner, 20 steps per workflow, 30 runs a minute per
workflow, 100 unfinished runs per workflow, a wait of at most 30 days, a form open
at most 7 days.

## 4. Triggers

| Kind | Definition | Context it gives the run |
|---|---|---|
| `command` | `{name}`: an identifier, not a core command | `trigger.user`, `trigger.room`, `trigger.text` (what follows the name) |
| `schedule` | `{every: "hour" \| "day" \| "week", time: "HH:MM", days: [1-7], timezone: IANA name, room}` | `trigger.room`, `trigger.at` |
| `member_joined` | `{room}` | `trigger.user`, `trigger.room` |
| `reaction_added` | `{room, emoji?}`: any reaction, or one emoji | `trigger.user`, `trigger.room`, `trigger.message`, `trigger.thread`, `trigger.emoji` |
| `message_posted` | `{room, contains}`: a text found ignoring case | `trigger.user`, `trigger.room`, `trigger.message`, `trigger.thread` |
| `webhook` | `{}`; its secret is shown once, rotated on demand | `webhook` (the JSON body, at most 16 KiB) |

- A command workflow is offered in a room where its bot is a member:
  `GET /api/v1/commands?room=` adds `{command, params, description}` entries for
  them, and `POST /commands/run` with that name starts a run. The person who runs
  it must be a member of the room; the room must be plaintext.
- A schedule fires at `next_fire_at`, computed in its time zone (daylight saving
  included); a missed firing (server down) fires once on restart, never several.
- `member_joined`, `reaction_added` and `message_posted` fire for people (never
  bots), so a workflow's own posts never start another run; the last two need the
  bot's `rooms:read`. All three check, when the event happens, that the bot is still
  a live member of the room.
- A webhook is `POST /api/v1/hooks/{workflow}/{secret}`, without a session: the
  secret is the credential, stored hashed. It answers `202 {run_id}`; 404 for a
  wrong secret or a disabled workflow (indistinguishable); 429 past the budget;
  413 or 400 for a body too large or not JSON.

## 5. Steps

| Kind | Definition | Saves |
|---|---|---|
| `message` | `{room: "trigger" \| id, text, cards?, in_thread?: bool}` | `{message_id}` |
| `wait` | `{seconds}` (1 s to 30 days) | nothing |
| `http` | `{method, url, headers?, body?, save_as?, continue_on_error?}` | `{status, body}` (JSON when it parses, else text, at most 64 KiB) |
| `form` | `{room: "trigger" \| id, recipient: "trigger_user" \| "anyone", title, fields: [{id, label, kind: text \| long_text \| number \| choice \| person, options?, people?, multiple?, required}], save_as}` | `{answers: {id: value}, by, people, mentions}` |

- `message` and `form` need the bot's `messages:write`; they post through the
  normal send path as the bot, with the operation id `wf-<run>-<step>`, so a step
  retried after a crash never posts twice.
- `http` reaches public addresses only (the link-preview collector's rule), on
  ports 80 and 443, never through a proxy, 10 s, no redirect, no credentials of the
  server. A failure fails
  the run, unless the step says `continue_on_error`.
- `form` posts a message carrying a form (`Message.form`); the run waits. The
  recipient (or any member of the room for `anyone`) answers with
  `POST /api/v1/forms/{message}/answer {operation_id, answers}`; the message then
  shows who answered, the run resumes with the answers. An unanswered form expires
  after 7 days and fails the run.

**Variables.** A message's text, URLs, header values and bodies are templates (a
form's title is not); in a text, values never carry `@all` / `@here`, in a URL they
are percent-encoded: `{{trigger.user.username}}`,
`{{trigger.room.name}}`, `{{trigger.text}}`, `{{webhook.order.id}}`,
`{{<save_as>.status}}`, `{{<save_as>.body.items.0.name}}`, `{{<save_as>.answers.reason}}`,
`{{now}}`. A path that does not exist renders empty. No logic, no code.

## 6. Engine

A worker (one tick a second) leases due runs (`state` pending or waiting with
`wake_at` in the past) with `FOR UPDATE SKIP LOCKED`, as the push and mail
workers do, and executes steps until a wait, a form or the end, persisting the
step index and the context after each step. A lease lost to a crash is taken
again after it expires. The schedule scanner creates runs for due schedules in the
same tick and moves `next_fire_at`.

A run fails with its step's error code (`bot_scope_missing`, `crypto_required`,
`http_failed`, `form_expired`...), shown in the history; only a `429` is retried
(50 attempts, then `workflow_retries`). Each step renews the lease and stops a
cancelled run. Disabling a workflow cancels its unfinished runs; editing it does
not touch runs already started (they carry their definition and their bot).

## 7. API (a person's session; owner only, administrators oversee)

| Route | Effect |
|---|---|
| `GET /api/v1/workflows` | Mine; `?all=true` every workflow for an administrator |
| `POST /api/v1/workflows` | `CreateWorkflow{operation_id, name, description, bot_id, trigger, steps, enabled}` |
| `GET /api/v1/workflows/{id}` | The definition |
| `PUT /api/v1/workflows/{id}` | `UpdateWorkflow{operation_id, revision, name, description, bot_id, trigger, steps, enabled}`, the whole definition at the expected revision |
| `DELETE /api/v1/workflows/{id}` | Deletes it and its runs |
| `POST /api/v1/workflows/{id}/webhook` | A new webhook secret, shown once (the old one stops working) |
| `GET /api/v1/workflows/{id}/runs` | The last 50 runs: state, step, error, dates |
| `POST /api/v1/workflows/{id}/test` | Starts a run now, enabled or not, with the caller as `trigger.user`; a command is tried by typing it |
| `POST /api/v1/hooks/{id}/{secret}` | The webhook trigger (no session) |
| `POST /api/v1/forms/{message}/answer` | Answers a form |

Validation happens at save: the bot must be the owner's and live; a `message` or
`form` step needs `messages:write` on that bot; a fixed room must be one the bot
belongs to and plaintext; the command name must be free. An administrator lists,
disables and deletes any workflow, never edits one (it would act as someone's
bot). Bot keys never reach these routes. Capability `workflows`.

## 8. What the apps show

- A **Workflows** settings page: the list (name, trigger, on or off, last run), a
  simple editor (name, bot, trigger and its settings, steps to add, edit, reorder
  and remove, each with a native form and the variables it may use), the run
  history, the webhook URL and secret shown once, a Test button.
- **Forms** in the room: a card with the form's title and an Answer action
  opening a native sheet with its fields; once answered, the card says by whom.
- Workflow commands in the command panel, like any command.

## 9. Delivery in this branch

1. Server: migration, definitions and validation, engine and steps, triggers,
   forms, API, tests.
2. `rv-protocol` types and schema, `rv-client` methods.
3. Apps: the Workflows page and its editor, form cards and the answer sheet, in
   mobile, GTK and SwiftUI.
4. Brain: `brain/features/workflows.md`, parity rows, glossary, decisions.
