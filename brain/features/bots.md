# Bots (RocketVibe server)

A bot is an account owned by a person, acting with API keys inside the scopes its owner grants. People create and manage their bots in the apps; everyone sees a "BOT" badge next to a bot's name, and its profile names its owner. Rocket.Chat servers have their own bots and integrations, untouched: there the feature is `n/a`. Design: `docs/rfcs/0003-bots.md`; contract: `docs/protocol/BOTS.md`.

## What the user sees

- **Who may create one.** An administrator always; everyone else when the administrator turns on "Users can create bots" (off by default). Otherwise the page explains that bots are not open to everyone. Ten live bots per person, ten creations a day (deleted ones count: deleting retires the username).
- **"My bots" settings page** (shown when the server announces `bots`): the list (photo, name, @username, description, scope count, live keys, disabled state); a creation form (username, display name, description, scopes); a bot's page with its photo (change, remove), display name, description and scopes, its keys and a final deletion (the username is retired).
- **Scopes** are checkboxes with a sentence each (`rooms:read`, `messages:write`, `files:write`, `reactions:write`, `rooms:join`, `users:read`, `dm:write`), and under each an "API" disclosure listing its routes, read from the server (`GET /api/v1/bots/reference`, the gate's own table), so the documentation never drifts from what a key reaches. The page also says what every key may do, that everything else is closed, and the send budgets.
- **Keys**: a label and an optional expiry in days. Creating one needs a recent sign-in, asked like the devices page asks it. The key is shown **once**, with Copy, a warning, and a ready `curl` example (server URL and key filled in); it is never stored. The list shows label, last four characters, dates and last use (recorded by the gate, at most a minute behind); revoking asks for confirmation. Five keys per bot.
- **Badge**: after the author's name in message headers, on room members, on profiles ("Bot of @owner"), and in the administrators' user list.
- **Encrypted rooms**: a bot cannot be invited into one ("Bots can't join an encrypted room"), and a room with a bot member cannot be encrypted ("A bot is a member: this room can't be encrypted"); mobile replaces the encryption actions with that sentence when it sees an active bot among the members.

## Server

`apps/server/src/bots.rs`, migration `0052_bots.sql`.

- A bot is a `users` row with `bot` set, plus a `bots` row (owner, description, scopes). A key is `rvb_` and 64 hex digits, hashed whole into an ordinary `sessions` row of its own `session_devices` row (`bot_keys` links them), so authentication, `lock_active`, read proofs, cursors and socket tickets are unchanged.
- `gate` is a route layer: a person's token passes; a key is admitted only on `ROUTES` entries whose scope it holds, plus the second scope `ALSO` names (completing an upload posts a message: `messages:write` too) (`bot_scope_missing`), never elsewhere (`bot_forbidden`). Deny by default. The bot's own profile is read-only to its keys. An open socket asks `still_reads` on every tick and closes once `rooms:read` is withdrawn.
- Triggers: a bot is never `admin`, never owns a bot, never gets a session that is not one of its keys; an owner deactivated deactivates its bots. Sign-in and operator recovery skip bot accounts.
- Management (`list`, `create`, `update` with the display name, `avatar` (PUT/DELETE `/api/v1/bots/{id}/avatar`, decoded like a person's photo by `profiles::decode_avatar`), `delete`, `keys`, `create_key`, `revoke_key`) reuses the in-app administration receipts (`admin::admit`, `settle`); deletion reuses `admin::tombstone` and then removes the bot's devices (a bot disabled with its owner keeps them through a tombstone that changes no policy). `managed(.., oversight)`: an administrator may list keys, revoke and delete any bot, never create a key, change scopes or the profile, which would let them act as the bot in rooms they are kept out of. The photo spends the owner's `profiles::admission` budget. Audit actions `bot.*`.
- `budget`: 60 new sends (after the replay check) and 10 new direct conversations (after the existing-pair lookup) a minute per bot (`bot_windows`). `refuse_encrypted` guards invitations, joins and the operator; `refuse_group` guards MLS transitions (`e2ee/groups.rs`); `refuse_policy` (from `operator::set_user`) refuses the admin right (`bot_privilege`) and re-enabling a bot that is a member of an encrypted room.
- `User.bot` is filled for message authors, members, the directory, profiles (`bot_owner` too), `/me` and the admin user list. `instance.user_bots` through `GET`/`PATCH /api/v1/admin/settings` and the CLI `set-instance --user-bots`.

## Mobile

- Messages carry `author_bot` (migration `0021_author_bot.sql`), written by the native store only (`providers/rocketvibe/store.ts`, an `UPDATE` after the shared upsert, so the Rocket.Chat path is untouched). Search, pins and encrypted rows have no flag and show no badge.
- `ui/botBadge.tsx` in `ui/messageRow.tsx`, `ui/roomManagement.tsx` (members) and `app/profile.tsx` (with the owner).
- `ui/bots.tsx` (`BotsSection`, category `bots` in `ui/settingsCategories.ts`) over `ui/botsModel.ts` (scope order and sentences, routes per scope, error wording, the curl example). Calls: `providers/rocketvibe/transport.ts`, wrapped by `NativeChat.bots` in `chat.ts` (session, generation and capability checks, operation ids). The new key lives in component state only and is dropped on dismissal or loss of focus; copying works only while focused.
- The photo uses the own-avatar picker (`pickAvatar`, square crop) and `NativeChat.botAvatar`; the header and rows draw it like the admin user list.
- Admin switch: a card in `app/admin/index.tsx`, `userBots`/`setUserBots` in `providers/rocketvibe/admin.ts`.

## Desktop

- rv-core: `store::MessageRow.author_bot` from the native store's `author_bot` column (or the cached profile's `user.bot`); `info::Profile.bot`/`bot_owner`; `native/bots.rs` (the calls, `set_bot_avatar`, `error_key(code, status)`, `failure_key`, `scope_key`, `routes`, `route_text` with a route's second scope, `example`, which on Windows gives a `curl.exe` line cmd.exe accepts); `NativeSession::avatar_current` also accepts the photos of my bots, which the store's user table does not know, so both UIs draw them through `rv-avatar:<id>`; `native/admin.rs` and `admin::Admin::user_bots`/`set_user_bots`; `bots` in the client capability mask. Tests: `tests/native_bots.rs`.
- GTK: `widgets::bot_badge` in `rows.rs`, the profile and members (no encryption identity on a bot's profile); `settings/native_bots.rs` (category shown with `bots`; the photo through `photo_png`, shared with my own photo), the key in a one-time dialog, opened on the application's window when the settings closed while the key was being created (never for another account); the dashboard's "Bots" card with a switch.
- SwiftUI: `BotsModel.swift` and `BotsSection.swift` (the new key in `AppModel.botKey`, in memory, shown by `RootView` whether the settings are open or not, dropped on an account switch), `.bots` in `Settings.swift`, the badge in `RoomView`, `Details` and `NativeRoomControls`, the toggle card in `AdminDashboard`; through rv-ffi `native_bots.rs`, `MessageItem.author_bot`, `Person.bot`/`bot_owner`, `NativeRoomMember.bot`, `ServerAdmin.user_bots`. The app target is compiled by the macOS CI only.

## Web

The server-delivered single-account browser shows the BOT badge on authors, members, profiles and administrator rows, with the owner on the profile. `src/bots.ts` provides owned bot creation, profile/photo/scope editing, reference routes, key creation after recent proof, one-time copyable key dialogs, listing, revocation and confirmed deletion. Administrator user details retain activation and confirmed deletion for bots and hide the administrator-role grant, as GTK does. The dashboard exposes the instance creation policy. `preferences-controls.ts` fences asynchronous results to the account; one-time values never enter browser persistence. Labels and refusals are generated from rv-core. Comprehensive GTK state comparison remains owed.

## Limits

- No bot in an encrypted room; a bot with its own crypto device is a later layer.
- Disabling an owner locks the owner row, then its bots' rows (trigger); a bot transaction locks its own row, then may take a key-share lock on its owner (a mention, a direct conversation). The two can deadlock: Postgres aborts one, which answers 500 and is safe to retry. Rare, left as is.
- `crypto_bot_member` is tested through the apps' fake servers and the server guard's placement, not through a real MLS transition in the server suite.
- Messages cached before the update show no badge until the server sends them again.
- Later layers of RFC 0003: commands declared by bots, outbound events over HTTP, interactive messages. Workflows, the last layer, act through a bot ([workflows](workflows.md)): the engine posts with the bot's internal session (a `bot_keys` row flagged `internal`, never listed, counted nor revocable by hand), and deleting a bot disables its workflows and cancels their runs.

## Sources

- apps/web/src/bots.ts
- apps/web/src/workflows.ts
- apps/web/src/workflow-forms.ts
- apps/web/tests/workflows.mjs

- docs/rfcs/0003-bots.md
- docs/protocol/BOTS.md
- crates/rv-protocol/src/bots.rs
- crates/rv-client/src/lib.rs
- apps/server/src/bots.rs
- apps/server/migrations/0052_bots.sql
- apps/server/src/auth.rs
- apps/server/src/store.rs
- apps/server/src/e2ee/groups.rs
- apps/server/tests/bots.rs
- apps/mobile/ui/bots.tsx
- apps/mobile/ui/botsModel.ts
- apps/mobile/ui/botBadge.tsx
- apps/mobile/providers/rocketvibe/store.ts
- apps/mobile/providers/rocketvibe/chat.ts
- apps/mobile/providers/rocketvibe/transport.ts
- apps/mobile/providers/rocketvibe/admin.ts
- apps/mobile/app/admin/index.tsx
- apps/mobile/db/migrations/0021_author_bot.sql
- apps/desktop/crates/rv-core/src/native/bots.rs
- apps/desktop/crates/rv-core/tests/native_bots.rs
- apps/desktop/crates/rv-gtk/src/settings/native_bots.rs
- apps/desktop/crates/rv-gtk/src/widgets.rs
- apps/desktop/crates/rv-ffi/src/native_bots.rs
- apps/desktop/macos/Sources/RocketVibeKit/BotsModel.swift
- apps/desktop/macos/Sources/RocketVibe/BotsSection.swift
