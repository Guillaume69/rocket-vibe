# The Rocket.Chat server contract

What both clients rely on from Rocket.Chat 8.5 (the target `chat.barrut.me` and the local Docker bench, pinned to 8.5.1): REST to act, DDP to listen, and the endpoints, streams, status codes and limits each app actually uses. The probed, dated facts live in the root [`CLAUDE.md`](../../CLAUDE.md) ("Faits sur Rocket.Chat qu'un résumé ne doit pas perdre"), which stays the canonical record; this page maps them onto the code.

## The split: REST to act, DDP to listen

DDP method calls are deprecated since 8.0 and announced for removal in 9.0. Both clients therefore send every action over REST and use the WebSocket only to receive. The one DDP method still called is `login` (with `{resume: authToken}`, the same token REST got from `POST /api/v1/login`), because a `sub` without an authenticated socket gets `nosub: not-allowed`, even on a public channel.

- Mobile: `ClientRest` in `apps/mobile/lib/rest.ts`, `ClientDdp` in `apps/mobile/lib/ddp.ts`. See [mobile-transport.md](mobile-transport.md).
- Desktop: `RestClient` in `apps/desktop/crates/rv-core/src/rest.rs`, the DDP actor in `apps/desktop/crates/rv-core/src/ddp.rs`. See [desktop-core.md](desktop-core.md).

Both DDP clients are written from the DDP spec. `@rocket.chat/ddp-client` ships without a `license` field and with an Enterprise Edition `LICENSE`, so its code is never copied.

## Streams subscribed

All subscriptions use Rocket.Chat's "streamer" convention: `params: [key, {useCollection: false, args: []}]`, events arrive as `msg: 'changed'` with the stream in `collection`, the key in `fields.eventName` and the payload in `fields.args`.

| Stream / key | Payload | Mobile | Desktop |
|---|---|---|---|
| `stream-notify-user` / `<uid>/subscriptions-changed` | `[action, subscription]`; `removed` carries only the subscription `_id` | always | always |
| `stream-notify-user` / `<uid>/rooms-changed` | `[action, room]` (room carries `lastMessage`) | always | always |
| `stream-notify-user` / `<uid>/message` | private bot answers, e.g. a slash command's reply | always | always |
| `stream-notify-logged` / `user-status` | `[[uid, username, statusCode, text]]` | always | always |
| `stream-notify-logged` / `updateAvatar` | `[{username, etag}]` or `[{rid, etag}]`, no `etag` on reset | always | always |
| `stream-room-messages` / `<rid>` | the message document in `args[0]` | per open room | not used |
| `stream-room-messages` / `__my_messages__` | new messages and edits of every room | not used | always |
| `stream-notify-room` / `<rid>/deleteMessage` | `{_id}` | per open room | open room only |
| `stream-notify-room` / `<rid>/user-activity` | `[username, ["user-typing"]]`, empty list = stopped | per open room | open room only |

Where the lists live: mobile `souscriptionsInitiales()` and `souscriptionsSalon(rid)` in `apps/mobile/fournisseurs/rocketchat/index.ts`; desktop `Session::start` and `Session::open_room` in `apps/desktop/crates/rv-core/src/session.rs`.

The two apps differ on `__my_messages__`. Desktop subscribes to it once, so every room's new messages and edits reach SQLite and the notifier without opening the room. Mobile does not (CLAUDE.md records it as "piste non retenue"): it listens to `stream-room-messages/<rid>` for the open room, keeps up to three recently left rooms subscribed (`apps/mobile/ui/salonChaud.ts`), and relies on `rooms-changed` for list previews and on push for notifications. Deletions are never on `__my_messages__`, so both apps subscribe to `deleteMessage` per room.

Presence uses `stream-notify-logged/user-status`, not `stream-user-presence`: on 8.5 the latter uses a proprietary `{added: [uid]}` protocol on a per-connection publication that a replayable `sub` cannot express (`apps/mobile/lib/presence.ts`). Typing uses `user-activity`, not the deprecated `/typing`.

## REST endpoints by purpose

All paths are under `/api/v1/` except `/api/info`, which both clients reach through an explicit opt-out (`horsApiV1` on mobile, the `api/info` path in `apps/desktop/crates/rv-core/src/server.rs`) so it keeps the 15 s timeout.

| Purpose | Endpoints | Mobile | Desktop |
|---|---|---|---|
| Server discovery | `GET /api/info` (anonymous: minor version only, `8.5`), `settings.public` | `lib/server.ts` | `server.rs` |
| Auth | `login` (password, resume, 2FA headers `x-2fa-code` / `x-2fa-method`), `users.2fa.sendEmailCode`, `logout` | `lib/auth.ts` | `session.rs` |
| Room list catch-up | `rooms.get?updatedSince=`, `subscriptions.get?updatedSince=`, full `subscriptions.get` for reconciliation | `lib/rattrapage.ts` | `sync.rs` |
| History | `channels.history` / `groups.history` / `im.history` by room type `c` / `p` / other, with `inclusive=true`, `showThreadMessages=false`, `count=50` | `fournisseurs/rocketchat/historique.ts` | `sync.rs` |
| Per-room catch-up | `chat.syncMessages` in cursor mode (`type`, `next`, `count`) | `lib/rattrapage.ts` | `sync.rs` |
| Threads | `chat.getMessage` (the root), `chat.getThreadMessages` | `historique.ts` | `session.rs` |
| Sending | `chat.sendMessage` with a client `_id`, `chat.getMessage` to confirm | `lib/envoi.ts` | `outbox.rs` |
| Uploads | `rooms.media/:rid` then `rooms.mediaConfirm/:rid/:fileId` | `lib/upload.ts`, `lib/envoiFichiers.ts` | `uploads.rs` |
| Message actions | `chat.update`, `chat.delete`, `chat.react`, `chat.pinMessage` / `chat.unPinMessage`, `chat.starMessage` / `chat.unStarMessage`, `chat.getPinnedMessages` / `chat.getStarredMessages` | `fournisseurs/rocketchat/actions.ts` | `actions.rs`, `session.rs` |
| Read state, favourites | `subscriptions.read`, `rooms.favorite` | `actions.ts`, `app/salon-info.tsx` | `actions.rs`, `session.rs` |
| Search | `spotlight`, `chat.search` | `app/recherche.tsx`, `ui/rechercheDebouncee.ts` | `session.rs` |
| Rooms and people | `rooms.info`, `users.info`, `im.create`; desktop also `channels.join` | `app/`, `lib/profilPreload.ts` | `info.rs`, `session.rs` |
| Profile | `me`, `users.setStatus`, `users.updateOwnBasicInfo`, `users.setAvatar`, `users.resetAvatar`, `users.setPreferences` | `lib/monProfil.ts`, `lib/upload.ts` | `account.rs`, `session.rs` |
| Presence | `users.presence` (full snapshot, non-offline users only) | `lib/presence.ts` | `session.rs`, `live.rs` |
| Permissions | `permissions.listAll` | `lib/permissions.ts` | `session.rs` |
| Slash commands | `commands.list`, `commands.run` | `lib/commandes.ts` | `session.rs` |
| Custom emoji | `emoji-custom.list` | `lib/emojisCustom.ts` | `session.rs` |
| E2EE | `e2e.fetchMyKeys` | `lib/e2e/moteur.ts` | `session.rs` |
| Calls | `video-conference.capabilities`, `.start`, `.join`; desktop also `.info` | `lib/appel.ts` | `actions.rs`, `session.rs` |
| Push (mobile only) | `POST` / `DELETE push.token`; `push.get` from native code | `lib/pushToken.ts`, `plugins/with-fcm-deeplink.js` | - |

Mobile code reaches Rocket.Chat only through the `Fournisseur` facade (`apps/mobile/lib/fournisseur.ts`), whose Rocket.Chat driver is `apps/mobile/fournisseurs/rocketchat/`. Screens never name an endpoint for history, threads or subscriptions.

## Status codes and the response envelope

- **A 401 means "not authenticated" and nothing else** on 8.5. Missing permission is 403, excluded or unknown room is 400, a 2FA challenge is 400 (`totp-required`, `totp-invalid`). Both clients have one predicate allowed to trigger an automatic logout: `estJetonRefuse` (`apps/mobile/lib/rest.ts`) and `is_token_rejected` (`apps/desktop/crates/rv-core/src/rest.rs`). It requires status 401, not a 2FA error, and a body that carries the Rocket.Chat envelope (`success` boolean, `status: 'error'`, or `errorType`), because a proxy or captive portal also answers 401.
- **`/api/v1/login` maps every failure to 401.** Calls that carry no auth headers (login, session resume, which sends the token in the body) are flagged anonymous and never fire the token-rejected hook. The mobile resume check applies `estJetonRefuse` itself (`apps/mobile/ui/session.tsx`).
- The hook passes the token **actually sent**, captured before the request. A late 401 for a token that has since been replaced is ignored by the subscriber, so it cannot wipe a fresh session.
- 2FA arrives two ways: `{error: 'totp-required'}` on `/login`, `{errorType: 'totp-required'}` elsewhere. The method expected is in `details.method`; for `password` the code is the SHA-256 of the password.
- Failure is `success: false` on `/api/v1/*` and `status: 'error'` on `/login`. `POST logout` answers 200 with an empty body, which both clients read as success.

## Rate limiting

REST is limited to 10 calls a minute by default (measured); the 11th answers 429 with `x-ratelimit-reset` (epoch ms). Both clients retry a 429 up to three times, sleeping until the reset plus 250 ms (or exponential backoff without the header), plus up to 500 ms of jitter so concurrent calls do not wake together, capped at 30 s. The consequences shape the sync design:

- `chat.syncMessages` takes one room at a time, so neither app loops over all rooms on reconnection. Global state comes from the two `updatedSince` deltas; per-room catch-up is for the open room only. See [../features/offline-and-sync.md](../features/offline-and-sync.md).
- `chat.getMessage` shares the budget with `chat.sendMessage`, so a 429 while confirming a send counts as "unknown", never as "not delivered".
- One-off reads (custom emoji, reconciliation, `me`, permissions, settings) are made once per session, not once per reconnection.

## Messages, cursors and timestamps

- `_updatedAt` is the server's clock and arbitrates every upsert in both stores (`WHERE excluded.updated_at >= ...`). Cursors are the largest `_updatedAt` ingested, never the local clock, and never move backwards.
- `chat.syncMessages?lastUpdate=` is unbounded (`count` is ignored; 1.85 MB for 3,000 messages measured). Since 7.5 cursor mode (`type=UPDATED|DELETED`, `next=<epoch ms>`, `count`) pages properly; `UPDATED` and `DELETED` are separate requests, and `lastUpdate` must be absent or it wins. The server advances with a strict `$gt`, so a group of identical `_updatedAt` larger than one page (an `updateMany`, such as a username rename) is partly skipped for good.
- `chat.syncMessages?type=UPDATED` is slow on a big room (3 to 4 s to report nothing on `chat.barrut.me`): the index is `{rid, ts, _updatedAt}`. The only remedy is not calling it, which is what mobile's hot rooms and desktop's per-session `synced` set do.
- Replaying an accepted `_id` on `chat.sendMessage` answers 400 (`Cannot read properties of undefined (reading 'starred')`) without creating a duplicate. Both outboxes ask `chat.getMessage` before declaring a failure.

## Uploads

`rooms.upload` was removed in 8.0. Files go up with `rooms.media/:rid` (multipart, field `file`; returns `file._id`), then `rooms.mediaConfirm/:rid/:fileId` posts the message; forgetting the confirm leaves an orphan file. Replaying the confirm is undetermined: an immediate replay posts a second message but answers 200 with the first, a later one answers `invalid-file`. Both apps persist the `fileId` before confirming and decide locally whether the message exists, refreshing the room first when the database knows nothing (`apps/mobile/lib/envoiFichiers.ts`, `apps/desktop/crates/rv-core/src/uploads.rs`). `mediaConfirm` rejects extra keys, so a client `_id` is impossible. `/file-upload/...` downloads have no `Content-Length`; the size comes from the attachment. Details in [../features/uploads.md](../features/uploads.md).

## Other facts the code depends on

- `FileUpload_ProtectFiles` and `Accounts_AvatarBlockUnauthenticatedAccess` are on for the target: files and avatars need `rc_uid` / `rc_token`.
- Avatars carry no HTTP `ETag`; the version (`avatarETag`) is added to the URL query to bust the image cache, and `updateAvatar` without `etag` means the photo was reset. See [../features/avatars.md](../features/avatars.md).
- A change of display `name` is not broadcast at all; only avatar and username changes propagate live.
- Push only notifies offline users, and by default only on DMs and mentions. With hidden content on, a push carries only a `messageId`, fetched with `push.get`. See [../features/notifications.md](../features/notifications.md).
- E2EE rooms reject plain messages (`error-not-allowed`). See [e2ee.md](e2ee.md).
- `MONGO_OPLOG_URL` is gone since 8.0 (change streams), but the replica set is still required by the test server in `docker/`.

## Sources

- CLAUDE.md
- ROADMAP.md
- docs/DEV.md
- apps/mobile/lib/rest.ts
- apps/mobile/lib/ddp.ts
- apps/mobile/lib/fournisseur.ts
- apps/mobile/fournisseurs/rocketchat/index.ts
- apps/mobile/fournisseurs/rocketchat/traducteur.ts
- apps/mobile/fournisseurs/rocketchat/historique.ts
- apps/mobile/fournisseurs/rocketchat/actions.ts
- apps/mobile/lib/rattrapage.ts
- apps/mobile/lib/envoi.ts
- apps/mobile/lib/upload.ts
- apps/mobile/lib/envoiFichiers.ts
- apps/mobile/lib/server.ts
- apps/mobile/lib/auth.ts
- apps/mobile/lib/presence.ts
- apps/mobile/lib/pushToken.ts
- apps/mobile/ui/session.tsx
- apps/mobile/plugins/with-fcm-deeplink.js
- apps/desktop/crates/rv-core/src/rest.rs
- apps/desktop/crates/rv-core/src/ddp.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/sync.rs
- apps/desktop/crates/rv-core/src/live.rs
- apps/desktop/crates/rv-core/src/outbox.rs
- apps/desktop/crates/rv-core/src/uploads.rs
- apps/desktop/crates/rv-core/src/server.rs
- apps/desktop/crates/rv-core/src/actions.rs
- apps/desktop/crates/rv-core/src/info.rs
- apps/desktop/crates/rv-core/src/account.rs
