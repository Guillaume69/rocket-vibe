# Workflows (RocketVibe server)

A workflow is a small automation a person builds in the apps: a trigger starts ordered steps, and everything it posts is posted by one of its owner's bots ([bots](bots.md)), so the bot's badge, scopes, memberships, budgets and refusal of encrypted rooms apply. Rocket.Chat servers have no such feature here: `n/a`. Design: `docs/rfcs/0004-workflows.md`; contract: `docs/protocol/WORKFLOWS.md`.

## What the user sees

- **Who may build one**: whoever may create a bot (`AccountPermissions.create_bot`): an administrator always, everyone else when "Users can create bots" is on. 20 workflows per person, 20 steps each.
- **"Workflows" settings page** (shown with the `workflows` capability): the list (trigger in words, on or off, last run and its error), then an editor: name, description, on/off, the acting bot (my live bots, with their scopes), the trigger, the steps (add, move up or down, remove), Save, Test now (the saved definition, so not while there are unsaved changes; a command workflow is tried by typing it in a room instead), Turn off (keeping unsaved edits), the last 50 runs, Delete. No graphical canvas: native forms only.
- **Triggers**: a slash command (`/name`, offered in the composer's command list of rooms where its bot is a member), a schedule (every hour at a minute, every day, or on chosen days of the week, at a time in an IANA zone, defaulting to the device's), someone joining a room, a reaction in a room (any emoji or one), a message containing some text (ignoring case), or a webhook (its URL shown once, regenerated on demand after a recent sign-in and a confirmation, since the old URL stops working). The room triggers fire for people only, never for a bot, so a workflow's own posts never start runs; a reaction taken back or an edited message fires nothing. Watching reactions or messages needs the bot's `rooms:read`.
- **Steps**: send a message (to the trigger's room or a fixed one; for a reaction or message trigger, optionally in that message's thread), wait (up to 30 days, in minutes, hours or days; desktop also seconds), call an HTTP service (method, URL, headers, body, the answer saved for later steps, public addresses on ports 80 and 443 only), ask a form. A message's text, the URL, header values and the body are templates: `{{trigger.user.username}}`, a saved step's result, `{{now}}`; each such field lists the variables it may use, one tap inserts one. What people wrote never pings a room through the bot (`@all` / `@here` in a value are neutralised), and values put in a URL are percent-encoded.
- **Forms**: posted by the bot as a card (title, "For @recipient", the field labels, Answer). The recipient (the person who triggered the run) or any member answers in a native sheet: text, long text, number, a choice among options, or a person (among people picked in the editor, or any member of the room who is not a bot, with a search on a long list). A choice or a person field can take several answers: checkboxes instead of radio buttons. The card then reads "Answered by ...", and the run goes on with the answers (`{{x.answers.field}}`, several answers joined by commas, a person's username; `{{x.mentions.owner}}` gives `@alice, @bob` ready to post; `{{x.people.owner.display_name}}`). A form stays open 7 days. The message's text is the form's title, for clients without the card; the apps hide it above the card.

## Server

`apps/server/src/workflows.rs` (definitions, triggers, forms), `workflows/engine.rs` (runs), `workflows/template.rs`, `workflows/schedule.rs` (chrono-tz, DST-aware), migration `0053_workflows.sql`.

- **Definitions** are checked when saved (`check`): the bot is mine and live; `messages:write` for message and form steps, `rooms:read` for the reaction and message triggers; every fixed room has the bot as a member and is plaintext; a command name is not a core command and is unique; a reaction trigger's emoji is known (`emojis::canonical` or a custom emoji code). The owner edits; an administrator lists, disables and deletes any workflow, never edits one (it would act as someone else's bot) and sees HTTP header values hidden (`Row::wire`, they are the owner's credentials elsewhere). Editing never touches started runs: a run keeps the definition and the bot it started with (`workflow_runs.bot_id`). A trigger moved off webhook drops the webhook secret.
- **Runs** (`workflow_runs`): `start` checks the budgets (30 runs a minute per workflow in `workflow_windows`, 100 unfinished), stores the definition, the bot and the trigger context. `engine::drain`, ticked every second by `main.rs`, fires due schedules, then leases runs (`FOR UPDATE SKIP LOCKED`) and advances them step by step: before each step `renew` extends the lease and stops a run cancelled meanwhile (disabling cancels), and the step and the context are saved after each. A message step posts through the bot's internal session with the operation id `wf-<run>-<step>`, so a step replayed after a crash never posts twice; when its text changed since (`{{now}}`), the conflict finds the message already sent. Only a 429 retries later (50 attempts, then `workflow_retries`); anything else fails the run with the step's error code, unless an HTTP step carries on (`continue_on_error`). A test run (`test`) may run a disabled workflow; a command one is refused (`workflow_test_command`), it has no room.
- **Internal bot session**: `ensure_session` gives a bot one `bot_keys` row flagged `internal` (a session of a `Workflows` device whose token is discarded): never listed, never counted against the five keys, never revocable by hand; creating and removing it hold an advisory lock per bot, and `bot_account` makes it again when something removed it (a policy change drops a bot's devices) while the bot is live. Deleting the bot disables its workflows and cancels their runs.
- **Triggers in the request paths**: `commands::run` hands an unknown name to `run_command` (`workflow_unavailable` when its bot is not in that room or the room is encrypted); joins and invitations call `on_join`, `store::send_in_tx` calls `on_message`, `reactions::apply` calls `on_reaction` (an added reaction only), each skipping bots and swallowing a workflow's 429 (or its disappearance meanwhile) so the person's action never fails for it. `watching` checks, at each event, that the bot is still a live member of the room, with `rooms:read` for messages and reactions: a bot taken out of a room stops watching it. Their context carries `trigger.user`, `trigger.room`, and for messages and reactions `trigger.message` and `trigger.thread` (the message's thread root, or the message).
- **Webhooks**: `POST /api/v1/hooks/{workflow}/{secret}`, no session, a 16 KiB JSON body (413 and 400 for a body too large or not JSON), 404 for an unknown or disabled workflow or a wrong secret; the secret is stored hashed.
- **HTTP step**: ports 80 and 443 only, resolves the host and refuses private, loopback and link-local addresses (`link_previews::public_address`), then pins the checked addresses for the request, with no proxy (it would resolve again); no redirect, 10 s, 64 KiB kept. Templates: `template::render_message` for a message's text, `render_url` for the URL. `App.private_http` (`RV_WORKFLOW_PRIVATE_HTTP`) lifts the address check for tests and development.
- **Forms**: `workflow_forms` (one per posted message: fields, recipient, answers, expiry, the answering operation). `Message.form` is projected by `MESSAGE_SELECT`, with the users the person fields name; answering (`answer`) checks recipient, required fields and values (a person: in the field's list, or a non-bot member of the room), republishes the message and wakes the run (an answer landing before the run went to sleep on its form wakes it at that save). A deleted form message carries no form and takes no answer. A person answer is stored as a user id; the engine turns it into the username, the person and the mention when it resumes. A `multiple` field's answer is a list (`FormAnswer::Many`), kept in the order of the field's options or listed people, by username for a field open to the room.

## Mobile

- `ui/workflows.tsx` (`WorkflowsSection`, category `workflows` in `ui/settingsCategories.ts`) over `ui/workflowsModel.ts` (defaults, trigger summaries, variables per step, save bodies, the editor's own checks with the server's byte limits, unsaved changes, error wording, the form's state and answer checks; tested in `ui/workflowsModel.test.ts`). Steps, fields and headers carry stable keys (`useKeys`) so their editors follow them when moved; the draft builds on a `basis` revision, so a refresh or Turn off never replaces unsaved edits and a save on a moved revision reloads and says so. Rooms come from the local `rooms` table (unencrypted ones), people from `NativeChat.users` (bots and deleted accounts left out). Calls go through `NativeChat.workflows` (`providers/rocketvibe/chat.ts`, capability and session checks, operation ids).
- Forms: messages keep the form JSON (`messages.form`, migration `0022_message_form.sql`, written by the native store); `ui/messageRow.tsx` draws `FormCard` and hides a body that only repeats the title; `app/answer-form.tsx` is the answer sheet (`presentation: 'formSheet'`), reading the room's members through `NativeChat.roomMembers` for a person field open to the room (a failed read can be retried).
- Workflow commands: `NativeChat.commands` asks `GET /api/v1/commands?room=` when the server announces `workflows`, so the composer's panel lists them per room.

## Desktop

- rv-core `native/workflows.rs`: the calls (capability, credential refresh, operation ids), `workflow_people` (everyone but bots), `form_members` (a room's members who are not bots), `workflow_rooms` (plaintext rooms), and what both UIs share: error and run wording (`error_key`, `failure_key`, `run_text`), trigger and step summaries, the variables at each step (the same list as mobile), field ids from labels, waits, the webhook URL, the system's IANA zone, `Draft::normalized` with `draft_problem` (the editor's own checks: trigger room, recipient, limits, ids), and the form helpers (`checked_answers`, checked like the server, `can_answer`, `text_is_form_title`, `field_people`). The native store keeps a message's `form` column (`store::MessageRow.form`); `NativeSession::room_commands` / `loaded_room_commands` read each room's commands so workflow commands reach the composer, falling back to the server's cached list, so a typed command never goes out as text; a `literal` description (a workflow's name) is shown as is. `workflows` is in the client capability mask. Tests: `tests/native_workflows.rs`.
- GTK: `settings/native_workflows.rs`, the Workflows category after Bots (list, editor with the six triggers and four step kinds, a Variables menu inserting into the last focused template field, Save with a reload on `revision_conflict`, Test (not while the draft differs from the saved definition, not for a command), Disable taking the new revision, Delete confirmed, runs, the webhook URL in a one-time dialog, replacing one confirmed); `workflow_forms.rs`, the form card in the message row and the answer `adw::Dialog` (closed by a backdrop click): a single choice in a dropdown, a single person in radios, several answers as `gtk::CheckButton`s, author labels never read as markup. Its editor and form-card test (`src/tests/workflows.rs`) runs under Xvfb in `native-server.yml`.
- SwiftUI: `WorkflowsModel.swift` and `WorkflowsSection.swift` (category `.workflows`), the form card and answer overlay in `RoomView` (checkbox toggles for several answers), variables inserted at the cursor in the text editors (`TextEditor(text:selection:)`, appended to a GET or DELETE step's URL), the editor's checks and limits from rv-core (`workflow_draft_problem`, `workflow_limits`), the webhook URL in `AppModel.workflowWebhook`, shown once; through rv-ffi `native_workflows.rs` and `MessageItem.form`. The app target is compiled by the macOS CI only.

## Web

`apps/web/src/workflows.ts` follows the GTK sidebar list and form editor: six triggers, four step kinds, step movement/removal, variable insertion at the last focused field, owned bot selection, saving at the expected revision, saved-definition testing, disable, deletion, last 50 runs and a one-time webhook URL after recent proof. Disable updates the revision and enabled state without discarding unsaved fields. The settings category lists owned definitions, matching GTK; the server-only administrator oversight API does not introduce additional browser categories. Room-scoped completion dispatches names containing digits, underscores and hyphens; malformed slash input cannot become plaintext. `workflow-forms.ts` renders open, answered and expired form cards and validates the five answer kinds, single/multiple choices, resolved people or plaintext room members. Access withdrawal, account changes and answered forms close pending answer dialogs. Full GTK visual-state and trigger/step qualification remains debt.

Workflow message authors keep their bot identity through live profile refreshes. The browser regression verifies the BOT header after actual socket observations and page reload; the server profile projection includes `users.bot`, rather than relying only on the message payload.

## Limits

- No visual editor and no branching: steps run in order, a failed step ends the run (an HTTP step can be told to carry on). A network failure is not retried.
- A command run has no thread: replying in a thread is offered for reaction and message triggers only.
- The room triggers watch one room each; a message is matched by a plain "contains", not a pattern.
- A form waits up to 7 days; a run waiting on a form or a wait holds one of the workflow's 100 unfinished runs.
- An encrypted room can be neither a trigger room nor a target: the server cannot read or post there as a bot.
- Workflows are RocketVibe only; Rocket.Chat has its own integrations.

## Sources

- apps/web/src/bots.ts
- apps/web/src/workflows.ts
- apps/web/src/workflow-forms.ts
- apps/web/tests/workflows.mjs

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
