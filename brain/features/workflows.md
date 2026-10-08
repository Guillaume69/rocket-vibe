# Workflows (RocketVibe server)

A workflow is a small automation a person builds in the apps: a trigger starts ordered steps, and everything it posts is posted by one of its owner's bots ([bots](bots.md)), so the bot's badge, scopes, memberships, budgets and refusal of encrypted rooms apply. Rocket.Chat servers have no such feature here: `n/a`. Design: `docs/rfcs/0004-workflows.md`; contract: `docs/protocol/WORKFLOWS.md`.

## What the user sees

- **Who may build one**: whoever may create a bot (`AccountPermissions.create_bot`): an administrator always, everyone else when "Users can create bots" is on. 20 workflows per person, 20 steps each.
- **"Workflows" settings page** (shown with the `workflows` capability): the list (trigger in words, on or off, last run and its error), then an editor: name, description, on/off, the acting bot (my live bots, with their scopes), the trigger, the steps (add, move up or down, remove), Save, Test now, Turn off, the last 50 runs, Delete. No graphical canvas: native forms only.
- **Triggers**: a slash command (`/name`, offered in the composer's command list of rooms where its bot is a member), a schedule (every hour at a minute, every day, or on weekdays, at a time in an IANA zone, defaulting to the device's), someone joining a room, a reaction in a room (any emoji or one), a message containing some text (ignoring case), or a webhook (its URL shown once, regenerated on demand after a recent sign-in). The room triggers fire for people only, never for a bot, so a workflow's own posts never start runs; a reaction taken back or an edited message fires nothing. Watching reactions or messages needs the bot's `rooms:read`.
- **Steps**: send a message (to the trigger's room or a fixed one, optionally in the trigger's thread), wait (minutes, hours or days, up to 30 days), call an HTTP service (method, URL, headers, body, the answer saved for later steps, public addresses only), ask a form. Texts are templates: `{{trigger.user.username}}`, a saved step's result, `{{now}}`; each text field lists the variables it may use, one tap inserts one.
- **Forms**: posted by the bot as a card (title, "For @recipient", the field labels, Answer). The recipient (the person who triggered the run) or any member answers in a native sheet: text, long text, number, a choice among options, or a person (among people picked in the editor, or any member of the room who is not a bot, with a search on a long list). A choice or a person field can take several answers: checkboxes instead of radio buttons. The card then reads "Answered by ...", and the run goes on with the answers (`{{x.answers.field}}`, several answers joined by commas, a person's username; `{{x.mentions.owner}}` gives `@alice, @bob` ready to post; `{{x.people.owner.display_name}}`). A form stays open 7 days. The message's text is the form's title, for clients without the card; the apps hide it above the card.

## Server

`apps/server/src/workflows.rs` (definitions, triggers, forms), `workflows/engine.rs` (runs), `workflows/template.rs`, `workflows/schedule.rs` (chrono-tz, DST-aware), migration `0053_workflows.sql`.

- **Definitions** are checked when saved (`check`): the bot is mine and live; `messages:write` for message and form steps, `rooms:read` for the reaction and message triggers; every fixed room has the bot as a member and is plaintext; a command name is not a core command and is unique; a reaction trigger's emoji is known (`emojis::canonical` or a custom emoji code). The owner edits; an administrator lists, disables and deletes any workflow, never edits one (it would act as someone else's bot). Editing never touches started runs: a run keeps the definition it started with.
- **Runs** (`workflow_runs`): `start` checks the budgets (30 runs a minute per workflow in `workflow_windows`, 100 unfinished), stores the definition and the trigger context. `engine::drain`, ticked every second by `main.rs`, fires due schedules, then leases runs (`FOR UPDATE SKIP LOCKED`, a lease id checked on every save, so a run disabled meanwhile stops) and advances them step by step, saving the step and the context after each. A message step posts through the bot's internal session with the operation id `wf-<run>-<step>`, so a step replayed after a crash never posts twice. A 429 or a transient failure retries later (50 attempts), anything else fails the run with the step's error code.
- **Internal bot session**: `ensure_session` gives a bot one `bot_keys` row flagged `internal` (a session of a `Workflows` device whose token is discarded): never listed, counted against the five keys, nor revocable by hand; deleting the bot disables its workflows and cancels their runs.
- **Triggers in the request paths**: `commands::run` hands an unknown name to `run_command` (`workflow_unavailable` when its bot is not in that room or the room is encrypted); joins and invitations call `on_join`, `store::send_in_tx` calls `on_message`, `reactions::apply` calls `on_reaction` (an added reaction only), each skipping bots and swallowing a workflow's 429 so the person's action never fails for it. Their context carries `trigger.user`, `trigger.room`, and for messages and reactions `trigger.message` and `trigger.thread` (the message's thread root, or the message).
- **Webhooks**: `POST /api/v1/hooks/{workflow}/{secret}`, no session, a 16 KiB JSON body, 404 for anything wrong; the secret is stored hashed.
- **HTTP step**: resolves the host and refuses private, loopback and link-local addresses (`link_previews::public_address`), then pins the checked addresses for the request; no redirect, 10 s, 64 KiB kept. `App.private_http` (`RV_WORKFLOW_PRIVATE_HTTP`) lifts the address check for tests and development.
- **Forms**: `workflow_forms` (one per posted message: fields, recipient, answers, expiry, the answering operation). `Message.form` is projected by `MESSAGE_SELECT`, with the users the person fields name; answering (`answer`) checks recipient, required fields and values (a person: in the field's list, or a non-bot member of the room), republishes the message and wakes the run. A person answer is stored as a user id; the engine turns it into the username, the person and the mention when it resumes. A `multiple` field's answer is a list (`FormAnswer::Many`), kept in the order of the field's options or people.

## Mobile

- `ui/workflows.tsx` (`WorkflowsSection`, category `workflows` in `ui/settingsCategories.ts`) over `ui/workflowsModel.ts` (defaults, trigger summaries, variables per step, save bodies, the editor's own checks, error wording, the form's state and answer checks; tested in `ui/workflowsModel.test.ts`). Rooms come from the local `rooms` table (unencrypted ones), people from `NativeChat.users` (bots and deleted accounts left out). Calls go through `NativeChat.workflows` (`providers/rocketvibe/chat.ts`, capability and session checks, operation ids).
- Forms: messages keep the form JSON (`messages.form`, migration `0022_message_form.sql`, written by the native store); `ui/messageRow.tsx` draws `FormCard` and hides a body that only repeats the title; `app/answer-form.tsx` is the answer sheet (`presentation: 'formSheet'`), reading the room's members through `NativeChat.roomMembers` for a person field open to the room.
- Workflow commands: `NativeChat.commands` asks `GET /api/v1/commands?room=` when the server announces `workflows`, so the composer's panel lists them per room.

## Desktop

- rv-core `native/workflows.rs`: the calls (capability, credential refresh, operation ids), `workflow_people` (everyone but bots), `form_members` (a room's members who are not bots), `workflow_rooms` (plaintext rooms), and what both UIs share: error and run wording (`error_key`, `failure_key`, `run_text`), trigger and step summaries, the variables at each step, field ids from labels, waits, the webhook URL, the system's IANA zone, and the form helpers (`checked_answers`, `can_answer`, `text_is_form_title`, `field_people`). The native store keeps a message's `form` column (`store::MessageRow.form`); `NativeSession::room_commands` / `loaded_room_commands` read each room's commands so workflow commands reach the composer. `workflows` is in the client capability mask. Tests: `tests/native_workflows.rs`.
- GTK: `settings/native_workflows.rs`, the Workflows category after Bots (list, editor with the six triggers and four step kinds, a Variables menu inserting into the last focused template field, Save with a reload on `revision_conflict`, Test, Disable, Delete confirmed, runs, the webhook URL in a one-time dialog); `workflow_forms.rs`, the form card in the message row and the answer `adw::Dialog` (closed by a backdrop click): a single choice in a dropdown, a single person in radios, several answers as `gtk::CheckButton`s. Trigger-room and recipient mistakes are left to the server's worded refusal at save. Its editor test runs under Xvfb (`src/tests/workflows.rs`).
- SwiftUI: `WorkflowsModel.swift` and `WorkflowsSection.swift` (category `.workflows`), the form card and answer overlay in `RoomView` (checkbox toggles for several answers), variables inserted at the cursor in the text editors (`TextEditor(text:selection:)`, appended in one-line fields), a save refused locally when a step's room or recipient does not fit the trigger, the webhook URL in `AppModel.workflowWebhook`, shown once; through rv-ffi `native_workflows.rs` and `MessageItem.form`. The app target is compiled by the macOS CI only.

## Limits

- No visual editor and no branching: steps run in order, a failed step ends the run (an HTTP step can be told to carry on).
- The room triggers watch one room each; a message is matched by a plain "contains", not a pattern.
- A form waits up to 7 days; a run waiting on a form or a wait holds one of the workflow's 100 unfinished runs.
- An encrypted room can be neither a trigger room nor a target: the server cannot read or post there as a bot.
- Workflows are RocketVibe only; Rocket.Chat has its own integrations.

## Sources

- docs/rfcs/0004-workflows.md
- docs/protocol/WORKFLOWS.md
- crates/rv-protocol/src/workflows.rs
- crates/rv-client/src/lib.rs
- apps/server/src/workflows.rs
- apps/server/src/workflows/engine.rs
- apps/server/src/workflows/template.rs
- apps/server/src/workflows/schedule.rs
- apps/server/migrations/0053_workflows.sql
- apps/server/src/store.rs
- apps/server/src/reactions.rs
- apps/server/src/commands.rs
- apps/server/tests/workflows.rs
- apps/mobile/ui/workflows.tsx
- apps/mobile/ui/workflowsModel.ts
- apps/mobile/ui/messageRow.tsx
- apps/mobile/app/answer-form.tsx
- apps/mobile/providers/rocketvibe/chat.ts
- apps/mobile/db/migrations/0022_message_form.sql
- apps/desktop/crates/rv-core/src/native/workflows.rs
- apps/desktop/crates/rv-core/src/native.rs
- apps/desktop/crates/rv-core/tests/native_workflows.rs
- apps/desktop/crates/rv-gtk/src/settings/native_workflows.rs
- apps/desktop/crates/rv-gtk/src/workflow_forms.rs
- apps/desktop/crates/rv-gtk/src/tests/workflows.rs
- apps/desktop/crates/rv-ffi/src/native_workflows.rs
- apps/desktop/macos/Sources/RocketVibeKit/WorkflowsModel.swift
- apps/desktop/macos/Sources/RocketVibe/WorkflowsSection.swift
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
