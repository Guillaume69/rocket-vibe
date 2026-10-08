# Bots (RocketVibe server)

A bot is an account owned by a person, acting with API keys inside the scopes its owner grants. People create and manage their bots in the apps; everyone sees a "BOT" badge next to a bot's name, and its profile names its owner. Rocket.Chat servers have their own bots and integrations, untouched: there the feature is `n/a`. Design: `docs/rfcs/0003-bots.md`; contract: `docs/protocol/BOTS.md`.

## What the user sees

- **Who may create one.** An administrator always; everyone else when the administrator turns on "Users can create bots" (off by default). Otherwise the page explains that bots are not open to everyone. Ten bots per person.
- **"My bots" settings page** (shown when the server announces `bots`): the list (name, @username, description, scope count, live keys, disabled state); a creation form (username, display name, description, scopes); a bot's page with its description and scopes, its keys and a final deletion (the username is retired).
- **Scopes** are checkboxes with a sentence each (`rooms:read`, `messages:write`, `files:write`, `reactions:write`, `rooms:join`, `users:read`, `dm:write`), and under each an "API" disclosure listing its routes, read from the server (`GET /api/v1/bots/reference`, the gate's own table), so the documentation never drifts from what a key reaches. The page also says what every key may do, that everything else is closed, and the send budgets.
- **Keys**: a label and an optional expiry in days. Creating one needs a recent sign-in, asked like the devices page asks it. The key is shown **once**, with Copy, a warning, and a ready `curl` example (server URL and key filled in); it is never stored. The list shows label, last four characters, dates and last use; revoking asks for confirmation. Five keys per bot.
- **Badge**: after the author's name in message headers, on room members, on profiles ("Bot of @owner"), and in the administrators' user list.
- **Encrypted rooms**: a bot cannot be invited into one ("Bots can't join an encrypted room"), and a room with a bot member cannot be encrypted ("A bot is a member: this room can't be encrypted"); mobile replaces the encryption actions with that sentence when it sees an active bot among the members.

## Server

`apps/server/src/bots.rs`, migration `0052_bots.sql`.

- A bot is a `users` row with `bot` set, plus a `bots` row (owner, description, scopes). A key is `rvb_` and 64 hex digits, hashed whole into an ordinary `sessions` row of its own `session_devices` row (`bot_keys` links them), so authentication, `lock_active`, read proofs, cursors and socket tickets are unchanged.
- `gate` is a route layer: a person's token passes; a key is admitted only on `ROUTES` entries whose scope it holds (`bot_scope_missing`), never elsewhere (`bot_forbidden`). Deny by default.
- Triggers: a bot is never `admin`, never owns a bot, never gets a session that is not one of its keys; an owner deactivated deactivates its bots. Sign-in and operator recovery skip bot accounts.
- Management (`list`, `create`, `update`, `delete`, `keys`, `create_key`, `revoke_key`) reuses the in-app administration receipts (`admin::admit`, `settle`); deletion reuses `admin::tombstone`. Audit actions `bot.*`.
- `budget`: 60 sends and 10 new direct conversations a minute per bot (`bot_windows`). `refuse_encrypted` guards invitations, joins and the operator; `refuse_group` guards MLS transitions (`e2ee/groups.rs`).
- `User.bot` is filled for message authors, members, the directory, profiles (`bot_owner` too), `/me` and the admin user list. `instance.user_bots` through `GET`/`PATCH /api/v1/admin/settings` and the CLI `set-instance --user-bots`.

## Mobile

- Messages carry `author_bot` (migration `0021_author_bot.sql`), written by the native store only (`providers/rocketvibe/store.ts`, an `UPDATE` after the shared upsert, so the Rocket.Chat path is untouched). Search, pins and encrypted rows have no flag and show no badge.
- `ui/botBadge.tsx` in `ui/messageRow.tsx`, `ui/roomManagement.tsx` (members) and `app/profile.tsx` (with the owner).
- `ui/bots.tsx` (`BotsSection`, category `bots` in `ui/settingsCategories.ts`) over `ui/botsModel.ts` (scope order and sentences, routes per scope, error wording, the curl example). Calls: `providers/rocketvibe/transport.ts`, wrapped by `NativeChat.bots` in `chat.ts` (session, generation and capability checks, operation ids). The new key lives in component state only and is dropped on dismissal or loss of focus; copying works only while focused.
- Admin switch: a card in `app/admin/index.tsx`, `userBots`/`setUserBots` in `providers/rocketvibe/admin.ts`.

## Desktop

- rv-core: `store::MessageRow.author_bot` from the native store's `author_bot` column (or the cached profile's `user.bot`); `info::Profile.bot`/`bot_owner`; `native/bots.rs` (the calls, `error_key`, `scope_key`, `routes`, `example`); `native/admin.rs` and `admin::Admin::user_bots`/`set_user_bots`; `bots` in the client capability mask. Tests: `tests/native_bots.rs`.
- GTK: `widgets::bot_badge` in `rows.rs`, the profile and members; `settings/native_bots.rs` (category shown with `bots`), the key in a one-time dialog; the dashboard's "Bots" card with a switch.
- SwiftUI: `BotsModel.swift` and `BotsSection.swift`, `.bots` in `Settings.swift`, the badge in `RoomView`, `Details` and `NativeRoomControls`, the toggle card in `AdminDashboard`; through rv-ffi `native_bots.rs`, `MessageItem.author_bot`, `Person.bot`/`bot_owner`, `NativeRoomMember.bot`, `ServerAdmin.user_bots`. The app target is compiled by the macOS CI only.

## Limits

- No bot in an encrypted room; a bot with its own crypto device is a later layer.
- Messages cached before the update show no badge until the server sends them again.
- The owner cannot rename the bot or set its avatar from the apps: the bot does it with its key through `/me`.
- Later layers of RFC 0003: commands declared by bots, outbound events over HTTP, interactive messages, workflows.

## Sources

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
