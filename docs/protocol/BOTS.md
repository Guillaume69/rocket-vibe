# Bot accounts

Design and rationale: [RFC 0003](../rfcs/0003-bots.md). Types: `crates/rv-protocol/src/bots.rs`.
The server announces the feature with the `bots` capability.

A bot is an account owned by a person. It never signs in: it authenticates with
`Authorization: Bearer rvb_<64 lowercase hex>`, one of its keys, and reaches only
the routes of the scopes its owner granted. It belongs to rooms like anyone,
posts plaintext messages and [integration cards](INTEGRATION_CARDS.md), reads the
journal and the socket like the apps.

## Who may create one

`AccountPermissions.create_bot` (`GET /api/v1/me/permissions`) is true for an
administrator always, and for every other account when the instance setting
`user_bots` is on (off by default). A refused creation answers 403
`bots_disabled`. Ten live bots per owner (`bot_limit`).

## Managing bots (a person's session)

```json
POST /api/v1/bots
{"operation_id": "create-helper", "username": "helper", "display_name": "Helper",
 "description": "Posts the build results", "scopes": ["rooms:read", "messages:write"]}
```

answers a `Bot` (`user.bot` true, `owner`, `scopes`, `disabled`, `live_keys`). The
username follows the rules of any account; a taken or retired one answers 409
`username_taken`. Replaying the same intent returns the same bot.

| Route | Effect |
|---|---|
| `GET /api/v1/bots` | My bots; `?all=true`: every bot, administrators only |
| `PATCH /api/v1/bots/{id}` | `UpdateBot{operation_id, display_name?, description?, scopes?}` |
| `PUT`/`DELETE /api/v1/bots/{id}/avatar` | Sets (PNG or JPEG body, 2 MiB, re-encoded like a person's) or removes the bot's photo; answers the `Bot` |
| `DELETE /api/v1/bots/{id}` | Tombstones the bot: keys revoked, rooms left, username retired. Idempotent |
| `GET /api/v1/bots/{id}/keys` | `BotKeyList` of live keys: `label`, `hint` (last 4 characters), dates |
| `POST /api/v1/bots/{id}/keys` | `CreateBotKey{operation_id, label, expires_in_days?}` → `BotKeyCreated{key, info}` |
| `DELETE /api/v1/bots/{id}/keys/{key}` | Revokes a key. Idempotent |

A person manages their own bots. An administrator oversees every bot (lists it,
its keys, revokes keys, deletes it) but never acts as one: keys, scopes, name and
photo are the owner's alone, so administration is no way into the rooms a bot
belongs to. Someone else's bot answers `not_found`. All these responses are
`Cache-Control: no-store`.

**The key is shown once.** Creating one needs a recent sign-in
(`reauthentication_required` otherwise, as for revoking another device), a bot
that is not disabled (`bot_disabled`) and fewer than five live keys
(`bot_key_limit`). A replay of the same `operation_id` answers 409
`bot_key_replayed`, never the key again: list the keys and revoke the orphan.
`expires_in_days` is 1 to 3650; absent, the key does not expire.

The owner edits the display name, photo, description and scopes; the bot's own
profile is read-only to its keys. A photo spends the owner's profile decode budget
(`profile_rate_limited`). A key's `last_used_at` is recorded by the gate, at most a
minute behind.

## Scopes

| Scope | Routes |
|---|---|
| every key | `GET /me`, `GET /me/profile`, `GET /me/permissions`, emoji catalogue and images, avatars, `GET /bots/reference` |
| `rooms:read` | `GET /rooms`, room details, members, permissions, history, search, pins; a message, its permissions, thread, replies and previews; files; snapshots, changes, socket ticket; `GET /live` |
| `messages:write` | send, reply, edit and delete (its own, or as moderator), typing |
| `files:write` | upload preparation, bytes, status, cancellation, completion (which posts a message: it also needs `messages:write`, the route's `also`) |
| `reactions:write` | `PUT /messages/{id}/reactions` |
| `rooms:join` | public directory, `POST /rooms/{id}/join`, `POST /rooms/{id}/leave` |
| `users:read` | `GET /users`, `/users/lookup`, `/users/{id}` |
| `dm:write` | `POST /direct-messages` |

`GET /api/v1/bots/reference` (any session or key) answers this table as the
server enforces it (`BotReference`: the routes of each scope, the key prefix,
the budgets), so the apps describe the API to their people without a copy that
could drift.

A route of the table without its scope answers 403 `bot_scope_missing`; any
other route answers 403 `bot_forbidden`, whatever the scopes: sign-in and
sessions, its own profile edits, account security, push, `/e2ee/*`, `/admin/*`, `/bots/*` but the reference, voice,
reports, room creation and settings, slash commands. The table is
`ROUTES` in `apps/server/src/bots.rs`; a new route stays closed to keys until it
is listed there.

The socket (`/sync/socket`) is opened with a ticket issued to the key, so the
gate applies when the ticket is asked for; the open socket then checks on every
tick that the bot still holds `rooms:read`, and closes when it does not.

## Limits and refusals

- 60 new sends a minute per bot (sends and replies; replaying an accepted send
  is free) and 10 new direct conversations a minute (reopening an existing one is
  free): 429 `bot_rate_limited` with `Retry-After`.
- Ten bot creations a day per account, deleted bots included (deleting retires the
  username): 429 `bot_create_limit`.
- A bot never joins an encrypted room, by invitation, join or operator: 409
  `bot_encrypted_room`. A group transition (genesis or change) in a room where an
  active bot is a member: 409 `crypto_bot_member`. A direct conversation with a
  bot stays plaintext.
- A deactivated owner deactivates its bots. An administrator disables or
  re-enables a bot through `PATCH /admin/users/{id}`, which also revokes its
  keys, as it revokes a person's sessions. Making a bot an administrator answers
  409 `bot_privilege`; re-enabling a bot that is a member of an encrypted room
  (it may have been disabled when the group began) answers 409
  `bot_encrypted_room`. Deleting a bot revokes its keys in every case.

## Visibility

`User.bot` is set on message authors (`Message.author`), room members, the user
directory, profiles and `/me`. `UserProfile.bot_owner` names the owner of a bot.
Apps show a "BOT" badge next to the name.

## Instance setting

`GET /api/v1/admin/settings` → `InstanceSettings{user_bots}`;
`PATCH /api/v1/admin/settings` with `UpdateInstanceSettings{operation_id, user_bots?}`,
administrators only. CLI: `rv-server set-instance --user-bots true|false`.

## Audit

`bot.created`, `bot.updated`, `bot.deleted`, `bot.key_created`,
`bot.key_revoked`, `bot.avatar`, `instance.settings`, with the acting account.
