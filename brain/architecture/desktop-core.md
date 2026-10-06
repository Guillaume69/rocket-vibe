# Desktop core: rv-core

`rv-core` (`apps/desktop/crates/rv-core`) is the desktop's Rocket.Chat client with no UI: REST and DDP transports, a SQLite store per account, sync, the outbox, uploads, E2EE, and the display rules both desktop UIs share. It ports the mobile app's `lib/`, whose tests are its spec. The guiding rule is the mobile one: the socket and REST both write into SQLite, and the UI only observes the store.

Context: [desktop-app.md](desktop-app.md) for the crate layout, [rocket-chat.md](rocket-chat.md) for the server contract this code relies on, [mobile-transport.md](mobile-transport.md) and [mobile-data.md](mobile-data.md) for the mobile counterparts.

## Async model

- Everything async runs on **tokio** (multi-thread). `rv-core` does not create a runtime: the UI does (`rv-gtk/src/main.rs` and `rv-ffi/src/lib.rs` each build one with 2 workers). `Session::start` spawns tasks and must be called with that runtime entered.
- Long-lived pieces are **actors or broadcasters**, never callbacks into the UI:
  - the DDP client is one actor task owning the socket; `DdpHandle` only sends it commands over an unbounded mpsc;
  - the store broadcasts a `store::Change { rooms: bool, rids: BTreeSet<String> }` after each committed write (tokio `broadcast`, capacity 256);
  - the session broadcasts `SessionEvent`s (capacity 32): `Connection`, `Expired`, `Typing(rid)`, `Presence`, `Upload(rid)`, `Avatar`, `E2e`, `Incoming`, `Private { rid, text }`;
  - uploads broadcast the rid whose progress moved; the session forwards that as `SessionEvent::Upload`.
- Background tasks hold a `Weak<Session>`, so dropping the last `Arc` stops them; `Session::shutdown` closes the socket and aborts the listener, token watcher and upload forwarder.
- **The store is synchronous.** `Store` wraps one `rusqlite::Connection` in a `std::sync::Mutex`. Reads (`rooms()`, `messages()`...) are plain function calls, and both UIs call them on their main thread. Footgun: a long write on a tokio worker blocks a UI read for its duration; keep writes short and never hold the lock across an `.await` (`Store::write` takes a sync closure, which enforces it).
- Broadcast receivers can lag. Both UI bridges treat a `Lagged` on store changes as "reload everything" and drop lagged session events (see [desktop-gtk.md](desktop-gtk.md#threading-model)).

## Module map

| Module | Responsibility |
|---|---|
| `session` | Login, wiring of every piece, live-event routing, reconnection, every action a UI calls |
| `rest` | REST client: auth headers, 401 discrimination, 2FA challenges, 429 back-off, timeouts, uploads/downloads |
| `ddp` | Listen-only DDP actor: connect, `login` resume, ref-counted subscriptions, liveness probe |
| `store` | SQLite schema, migrations, `_updatedAt`-arbitrated upserts, cursors, outbox and upload rows, drafts |
| `sync` | Stream events and REST pages into the store: global catch-up, per-room catch-up, history paging |
| `context` | A window of old history around one message, read from the server and never stored, paged both ways without a hole; see [../features/room-view.md](../features/room-view.md) |
| `outbox` | Optimistic send with a client `_id`, replay-safe delivery check |
| `uploads` | Two-step upload queue with persisted `fileId`, offline retry, discard |
| `normalize` | Rocket.Chat documents to local rows; every document-shape quirk lives here |
| `live` | What is only streamed: typing, presence, private notes |
| `e2e` | Encrypted rooms (`rc.v1`/`rc.v2`): key unlock, room keys, message and file crypto; see [e2ee.md](e2ee.md) |
| `media` | Avatar paths with etags, protected URLs (`rc_uid`/`rc_token`), the in-memory media cache |
| `markdown`, `parse`, `runs` | Message bodies: server `md` tree (or a local parse of the text) to blocks of Pango markup, and to styled runs |
| `timeline`, `diff` | Author grouping, day separators, "new messages" marker; list refreshes as splices |
| `rooms` | Room-list sections, unread counts, badge, spotlight results |
| `actions`, `commands`, `completion`, `compose`, `emoji`, `content` | Message actions and permissions, slash commands, `@`/`:` completion, formatting toolbar, emoji table, attachments and link cards |
| `notify`, `links`, `call`, `player`, `info`, `account`, `server`, `update`, `i18n`, `animation` | Notification rules, `rocketvibe://` links, call-origin rule, video embed page, on-demand details, my account, server probe, self-update, the shared catalog (see [i18n.md](i18n.md)), GIF frames |

## session

`session::login` posts `login` as an anonymous call (so a 401 there can never revoke anything) and returns `SessionInfo { base_url, user_id, username, auth_token }`. For the `password` 2FA method, `two_factor_code` sends the SHA-256 hex of the password; `request_email_code` triggers `users.2fa.sendEmailCode` when the email challenge says no code was generated yet.

`Session::start(info, db_path)` opens the store, builds `RestClient` (credentials set), `SyncEngine`, `Outbox`, `MediaCache`, `Uploads`, spawns the DDP actor and registers the account-wide subscriptions before the socket even opens:

- `stream-notify-user`: `<uid>/subscriptions-changed`, `<uid>/rooms-changed`, `<uid>/message` (slash-command answers);
- `stream-room-messages` / `__my_messages__`: new messages and edits of every room;
- `stream-notify-logged`: `user-status` (presence) and `updateAvatar`.

It then opens the socket and immediately spawns a first catch-up, not sequenced behind the socket negotiation, because that read is the one the user waits for. A second catch-up runs on every `DdpEvent::Authenticated`, but only after `ddp.subscriptions_armed()` resolves: the subscriptions are live before the REST read starts, so no event can fall between the two transports.

`catch_up`: `sync.catch_up_global()`, then, if that worked, `outbox.process()` and `uploads.process()`; then presence (`users.presence`); then once per session (`OnceCell`) the custom emoji list, `me` (notification preference) and `reconcile_rooms`; finally history and edit/deletion catch-up of the open room. Things that do not change between reconnections are read once because the REST budget is 10 calls a minute.

`open_room(rid, kind)` swaps the per-room subscriptions (`<rid>/deleteMessage`, `<rid>/user-activity`; deletions are not on `__my_messages__`), marks the room read in the background, loads the newest page, and runs `catch_up_room` once per session per room (tracked in `synced`).

Reconnection: on `DdpEvent::Lost` the listener waits `min(1000 << attempt, 30 s) + jitter(0..1 s)` and reopens; `Authenticated` resets the attempt counter. `reconnect_now()` skips the wait.

Session death: `RestClient` broadcasts the token it SENT whenever a call fails with `is_token_rejected` (401 with a Rocket.Chat envelope and no 2FA challenge). `watch_token` only emits `SessionEvent::Expired` if that token is the session's own, so a late 401 from a replaced session never logs out the new one.

Live routing (`apply_live`): presence, private notes, avatar changes (user etags kept in memory, room etags written to the store; a removal without etag becomes `media::NO_PHOTO`) and typing are handled in the session; everything else goes to `sync.apply_event`. Before that, a `stream-room-messages` event is checked by `incoming()`: not mine, not an edit, not a system message (except `e2e`), not already stored, and wanted by `notify::wanted` (`all`, `nothing`, else DMs and mentions). The resulting `SessionEvent::Incoming` carries no body for an encrypted message.

The rest of `Session` is the UI's API: send/retry/edit/delete/react/pin/star, threads (`load_thread` pages `chat.getThreadMessages` by full pages and fetches the root, which that endpoint never returns), permissions (from `permissions.listAll` and my roles, fetched once), slash commands, room info, profiles, search, spotlight, DMs, calls, avatars, status, E2E lock/unlock, downloads (written through a temporary name, decrypted once whole in an encrypted room).

## rest

- One `reqwest::Client` per `RestClient` with a 15 s timeout (`TIMEOUT`); `upload` and `download_protected` bypass it (upload timeout grows with the size, download ends only after a stall).
- Credentials are read **before** the request leaves, so the token compared on a 401 is the one sent, not the current one.
- 429: up to 3 retries, sleeping until `x-ratelimit-reset` + 250 ms (or `1000 << attempt` without it), plus 0 to 500 ms jitter so parallel calls do not collide again, capped at 30 s.
- Network failure: status 0. Replayed once after 400 ms only when `retry_on_network_error` is set, which is for idempotent writes; never for `chat.sendMessage`, whose dedup lives in the outbox.
- `interpret` requires a mark of the Rocket.Chat envelope before believing a status (`understood`), recognises 2FA both as `error` (on `/login`) and `errorType` (elsewhere), and accepts the empty 200 of `logout`.
- `outside_api_v1` reaches `/api/info`, the only route used outside `/api/v1/`.

## ddp

States `Closed`, `Connecting`, `Connected` (handshake done), `Authenticated`. The actor's loop `select!`s over commands, the pending connect, socket frames and the next deadline. Mechanisms worth knowing:

- **Listen-only.** The only method ever called is `login` with the resume token; everything else is `sub`/`unsub`.
- **Desired subscriptions** are a map keyed by `(name, key)` with a ref count. A `sub` goes on the wire only when authenticated and not already established or in flight; all are replayed after each reconnection. A failed sub stays desired and is retried at the next login.
- **Epochs.** Each teardown bumps an epoch; frames from the old socket are discarded.
- **Liveness.** Timeouts: requests 10 s, silence 45 s (the server pings every 30 s), watchdog tick 15 s. After 45 s of silence the actor sends its own `ping` and only a missing `pong` kills the socket. It never probes before the handshake: 8.5 answers an early `ping` with `msg: 'error'`. Such errors carry `offendingMessage.id`, which settles only that wait.
- `close()` is voluntary and never reported as `Lost`.

## store

One database per (server, account). `Store::open` sets WAL, runs `SCHEMA` (`rooms`, `subscriptions`, `messages`, `outbox`, `cursors`, `CREATE ... IF NOT EXISTS`), then the append-only `MIGRATIONS` list, counted by `PRAGMA user_version` (adding `md`, `drafts`, `urls`/`call_id`, `last_message_author`, `uploads`, E2E columns, `pinned`/`starred`, `roles`). Never edit a shipped migration step; append one.

Every write goes through `Store::write(|w| ...)`: one transaction, and one `Change` broadcast after the commit listing whether the room list changed and which rids' messages did. A write that touched nothing broadcasts nothing.

Invariants enforced in SQL:

- `upsert_message` only overwrites when `excluded.updated_at >= messages.updated_at`: the server's `_updatedAt` arbitrates between a socket event and a slower REST read. An optimistic outbox row carries `updated_at = 0`, so any server version replaces it and it never replaces a real one. For encrypted messages, text and `encrypted_raw` are COALESCEd so a ciphertext-only update does not erase what is known.
- `upsert_room` COALESCEs fields the server omits from partial documents, except `last_message`, whose absence means the last message was deleted (but not in an encrypted room, where the server only has ciphertext).
- `write_cursor` only moves forward.
- Subscription removals carry only the subscription `_id`: `delete_by_subscription_id` finds the room from it rather than upserting a ghost.

## sync

- `catch_up_global`: `rooms.get` and `subscriptions.get` in parallel with `updatedSince` from the `*` cursors, so every room and counter comes back in two requests; without a cursor it is the full load.
- `reconcile_rooms` (once per session): purges rooms missing from the full subscription list, but never on an empty list.
- `catch_up_room`: `chat.syncMessages` for `UPDATED`, then `DELETED` (two requests: the server refuses to combine them), 50 per page, at most 2 pages per kind; the cursor keeps the rest for later. The first time, the `messages-deleted` cursor is seeded from the messages cursor instead of being queried.
- `load_history`: `channels.history` / `groups.history` / `im.history` by kind, 50 per page, `inclusive=true` (two messages can share a millisecond; without it the boundary's twin would be a permanent hole), `showThreadMessages=false`. Seeds the room's messages cursor on first load.
- `apply_event` handles both shapes of `stream-notify-user` (`[action, doc]` on 8.5, the bare document elsewhere).

Hot rooms, offline behaviour and how this compares to mobile: [../features/offline-and-sync.md](../features/offline-and-sync.md).

## outbox

`enqueue` generates a 24-hex-char `_id` client side, writes the optimistic message and the outbox row in one transaction, and returns. `process` is re-entrant: a call during a pass sets `again` and the running pass loops. Per pending row:

- success: delete the row, ingest the returned message;
- status 0: stop the pass (unreachable), the row stays pending;
- any other error: ask `chat.getMessage` whether the `_id` exists, because replaying an accepted `_id` answers 400 on 8.5. Found: ingest and delete. Not found: mark `failed`. Could not ask (status 0 or 429, `getMessage` sharing the send quota): stop the pass rather than burn the quota on the next rows.

In an encrypted room the text is encrypted at send time through an encryptor closure the session installs; while locked the row waits instead of failing. The explicit retry is `Session::retry`.

## uploads

`Uploads` persists each file in the `uploads` table (`pending`, `sending`, `failed`) and sends it in two steps, `rooms.media/<rid>` then `rooms.mediaConfirm/<rid>/<fileId>`. The `fileId` is saved **between** the steps. Before replaying a confirm, `already_posted` checks the store for a message carrying that file, and if the store knows nothing it reloads the room's newest page and asks again, since the server's answer to a replayed confirm cannot be trusted ([rocket-chat.md](rocket-chat.md)). Other rules:

- `validate` applies `FileUpload_MaxFileSize`, `FileUpload_MediaTypeWhiteList` (`image/*` patterns) and refuses files in encrypted rooms when encrypted files are off.
- `claim_upload` makes a row `sending` atomically; at construction every `sending` row is rearmed to `pending` (only a dead run can leave one).
- Offline: the pass stops and schedules itself again after 2, 5, 15, 30 s, without waiting for the socket.
- `discard` removes the row and aborts the byte transfer; after the confirm nothing can take the message back. Temporary files (reduced images, pasted pictures) are deleted once settled.
- Encrypted rooms: the file is encrypted under its own key and uploaded under the SHA-256 of its name; the key lives in memory only between the two steps, so a crash in between uploads it again.

Feature-level detail: [../features/uploads.md](../features/uploads.md).

## Display helpers

- `markdown::render` turns the server's `md` tree into `Block`s of Pango markup; messages without `md` go through `parse::tree`, which produces the same node shapes, so one renderer serves both; a backslash before punctuation keeps it literal, as message-parser does. The room list previews (`runs::preview`) go through it too. Unknown nodes show their text. `runs` re-reads that markup as styled runs for the SwiftUI app and for GTK text views that hold custom emoji as pictures.
- `timeline::group` sets author headers (new day, system message, other author, or a gap), day separators and gutter times; `mark_new` puts the "new messages" marker on the first later message from someone else. `diff::diff_sorted` turns old and new sorted lists into splices so list views keep scroll position and widgets.
- `media::protected_url` adds `rc_uid`/`rc_token` only when the URL's origin is our server's: attachment URLs come from message fields, so from anyone. `MediaCache` keeps up to 400 fetched files in memory (cleared wholesale when full) and decrypts files of encrypted rooms whose keys it learnt.

## Tests

Unit tests sit next to the code; integration tests in `crates/rv-core/tests/` (`rest`, `ddp`, `sync`, `outbox`, `uploads`, `actions`) run against fake HTTP and WebSocket servers (`tests/common/mod.rs`). See [testing.md](testing.md).

## Sources

- apps/desktop/crates/rv-core/Cargo.toml
- apps/desktop/crates/rv-core/src/lib.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/rest.rs
- apps/desktop/crates/rv-core/src/ddp.rs
- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-core/src/sync.rs
- apps/desktop/crates/rv-core/src/outbox.rs
- apps/desktop/crates/rv-core/src/uploads.rs
- apps/desktop/crates/rv-core/src/normalize.rs
- apps/desktop/crates/rv-core/src/live.rs
- apps/desktop/crates/rv-core/src/media.rs
- apps/desktop/crates/rv-core/src/notify.rs
- apps/desktop/crates/rv-core/src/markdown.rs
- apps/desktop/crates/rv-core/src/parse.rs
- apps/desktop/crates/rv-core/src/runs.rs
- apps/desktop/crates/rv-core/src/timeline.rs
- apps/desktop/crates/rv-core/src/context.rs
- apps/desktop/crates/rv-core/src/diff.rs
- apps/desktop/crates/rv-core/src/rooms.rs
- apps/desktop/crates/rv-core/src/server.rs
- apps/desktop/crates/rv-core/src/e2e.rs
- apps/desktop/crates/rv-core/src/update.rs
- apps/desktop/crates/rv-core/tests/
