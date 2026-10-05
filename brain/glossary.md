# Glossary

The vocabulary you meet in rocket-vibe: Rocket.Chat protocol terms, the mobile code's own terms with their location, the expo-router route names, the desktop crates, the project's working words, and the few French names that still matter. Grouped by area, alphabetical within each group.

All code, comments and docs are in English. French survives in two places only: the French UI catalog users see, and the legacy stored names the mobile app still reads once so an upgrade loses nothing (see [Legacy French names](#legacy-french-names) and [decisions](decisions.md)).

## Rocket.Chat protocol

| Term | Meaning | More |
|---|---|---|
| `__my_messages__` | Special key on `stream-room-messages` that delivers new messages and edits of every room of the user, without opening any. Deletions are not on it. The desktop subscribes to it at session start (`MY_MESSAGES` in `rv-core/src/sync.rs`, subscribed in `rv-core/src/session.rs`); the mobile does not. | [decisions](decisions.md), [rocket-chat](architecture/rocket-chat.md) |
| `_updatedAt` | Server modification time on every document. The `updatedSince` cursors of `rooms.get` / `subscriptions.get` and `chat.syncMessages` filter on it. | [offline-and-sync](features/offline-and-sync.md) |
| 2FA challenge | Error `totp-required` (despite the name it covers `totp`, `email` and `password`); `details.method` says which. The same request is replayed with `x-2fa-code` and `x-2fa-method`; for `password` the code is the SHA-256 of the password. A wrong code is `totp-invalid` (400, never 401). | [login-and-servers](features/login-and-servers.md) |
| `avatarETag` | Version of a user's or room's photo. Added to the avatar URL as a query parameter so the image cache refetches; absent when there is no photo. | [avatars](features/avatars.md) |
| DDP | Meteor's WebSocket protocol (`connect`, `login`, `sub`, `unsub`, `added`/`changed`/`removed`, `ready`, `nosub`, `ping`/`pong`). Method calls are deprecated since 8.0, so both clients use it to listen only; `login` is the one method still called. | [mobile-transport](architecture/mobile-transport.md) |
| `e2eKey` | A subscription's room key, encrypted with my RSA public key. Stored on the mobile in `subscriptions.e2e_key`. | [e2ee](architecture/e2ee.md) |
| EJSON | Meteor's JSON dialect: dates arrive as `{"$date": epochMs}`. Push payloads carry the room data as a string in `data.ejson`. | [notifications](features/notifications.md) |
| `fname` | A room's display name (`name` is the slug). | [room-list](features/room-list.md) |
| `ls` | "Last seen" on a subscription: the read marker that places the new-messages bar. | [room-view](features/room-view.md) |
| `md` | The message's markdown AST, pre-parsed by the server (`@rocket.chat/message-parser` format). Missing on old messages, so clients fall back to parsing `msg` locally. | [room-view](features/room-view.md) |
| `mediaConfirm` | `POST rooms.mediaConfirm/:rid/:fileId`, the second half of an upload: it is what posts the message. Replaying it is undefined (a duplicate or `[invalid-file]`). | [uploads](features/uploads.md) |
| `msg`, `t`, `u`, `ts` | A message's text, its system type (`uj`, `ru`, `e2e`, ... absent for an ordinary message), its author `{_id, username, name}` and its timestamp. | [room-view](features/room-view.md) |
| `push.get` | Authenticated call that returns a push's content from its `messageId`; needed because the target server sends pushes without content. | [notifications](features/notifications.md) |
| `push.token` | `POST` registers the FCM token (`type: 'gcm'`, a legacy name, with `appName`); `DELETE` removes it at sign-out. | [notifications](features/notifications.md) |
| `rc_uid` / `rc_token` | Query parameters that authenticate a protected file or avatar URL (`FileUpload_ProtectFiles`, `Accounts_AvatarBlockUnauthenticatedAccess`). They are the session token, so such URLs must never leave the process. | [uploads](features/uploads.md) |
| `rid` | Room id. Joins rooms, subscriptions and messages. | |
| Room type | `t` on a room: `c` public channel, `p` private group, `d` direct message, `l` livechat (`RoomType` in `apps/mobile/db/schema.ts`). | |
| `rooms.media` | First half of an upload (multipart, field `file`). Posts nothing on its own; `rooms.upload` was removed in 8.0. | [uploads](features/uploads.md) |
| `settings.public` | Unauthenticated settings (upload limits, 2FA, E2EE, edit window...), read by the server probe and before uploads. | [rocket-chat](architecture/rocket-chat.md) |
| Spotlight | `GET spotlight?query=`: users and public channels, used to start a conversation. | [search](features/search.md) |
| Stream | A DDP publication named `stream-*`, keyed by an event name: `stream-room-messages` (`<rid>` or `__my_messages__`), `stream-notify-user` (`<uid>/subscriptions-changed`, `/rooms-changed`, `/notification`), `stream-notify-room` (`<rid>/deleteMessage`, `<rid>/user-activity`), `stream-notify-logged` (`user-status`, `updateAvatar`), `stream-user-presence`. | [rocket-chat](architecture/rocket-chat.md) |
| Subscription | The per-user state of a room (unread count, mentions, favourite, open, roles, `ls`, `e2eKey`), distinct from the room shared by all members. | [mobile-data](architecture/mobile-data.md) |
| `syncMessages` | `chat.syncMessages`: the per-room catch-up. One room per call, `type=UPDATED` and `type=DELETED` are two requests, and it is slow on big rooms. | [offline-and-sync](features/offline-and-sync.md) |
| `tmid`, `tcount`, `tlm` | Thread parent id on a reply, reply count and last reply time on the root. | [threads](features/threads.md) |
| `urls` | Link metadata (OpenGraph, oEmbed) the server attaches to a message; the clients render cards from it and scrape nothing. | [room-view](features/room-view.md) |
| `user-activity` | `stream-notify-room/<rid>/user-activity`: the typing indicator (not the deprecated `/typing`). | [composer](features/composer.md) |
| `video-conference.join` | REST call that returns the Jitsi URL (with its JWT) for a call. | [calls](features/calls.md) |

## Mobile: data and sync (`apps/mobile/db/`, `apps/mobile/lib/`)

| Term | Meaning | Where |
|---|---|---|
| Catch-up | Filling a gap after a disconnection: `catchUpGlobal` (two `updatedSince` requests for all rooms) and `catchUpRoom` (`syncMessages` for one room). | `apps/mobile/lib/catchUp.ts` |
| `ClientDdp` | The in-house listen-only DDP client; `subscribe` is reference-counted. | `apps/mobile/lib/ddp.ts` |
| Connection setup (`setUpConnection`) | What runs at every (re)connection, ordering stream subscriptions and REST reads so nothing falls in between. | `apps/mobile/lib/connectionSetup.ts` |
| `cursors` | Sync cursors table, per `scope` (`*` or a `rid`) and per `stream` (`rooms`, `subscriptions`, `messages-deleted`). | `apps/mobile/db/schema.ts` |
| `databaseFileName` | Database file name, derived from host and account: one database per (server, account). | `apps/mobile/db/fileName.ts` |
| Deferred logout (`finishPendingLogouts`) | Finishes a `DELETE push.token` and `logout` that failed offline, from the `pending-logouts` queue. | `apps/mobile/lib/deferredLogout.ts` |
| `drafts` | Composer drafts table, keyed by `rid` or `rid:tmid`; written debounced (`useDraft`). | `apps/mobile/db/schema.ts`, `apps/mobile/ui/drafts.ts` |
| `E2EEngine` | E2EE engine: private key in memory, room key cache, unlock. | `apps/mobile/lib/e2e/engine.ts` |
| Migration (`migrateDatabase`) | Runs drizzle migrations on one database, memoised per file name. | `apps/mobile/db/migrate.ts` |
| `normalize` | Turns server payloads into local rows (`LocalMessage`, `LocalRoom`, `LocalSubscription`); where the server's quirks are absorbed. | `apps/mobile/lib/normalize.ts` |
| Origin (`originOf`, `sameOrigin`) | URL origin (scheme + authority) and comparisons, parsed by hand because React Native's `URL` polyfill never throws. | `apps/mobile/lib/origin.ts` |
| `OutboxEngine`, `outbox` | The text outbox engine (client-side `_id`, optimistic display) and its table (`pending`, `failed`; a sent row is deleted). | `apps/mobile/lib/outbox.ts`, `apps/mobile/db/schema.ts` |
| `PresenceEngine`, `TypingEngine`, `ActivityEngine` | Volatile in-memory stores for presence, typing, and background-fetch activity (scope `'global'` or a `rid`). | `apps/mobile/lib/presence.ts`, `apps/mobile/lib/typing.ts`, `apps/mobile/lib/activity.ts` |
| `Provider` | The neutral facade over a chat server (listener, translator, actions, capabilities); `ProviderKind` is stored in the session as `kind`. Only `rocketchat` exists; a Mattermost (kChat) driver is anticipated. | `apps/mobile/lib/provider.ts`, `apps/mobile/providers/` |
| Quote | Reply-quote: a message starting with `[ ](permalink?msg=<id>)`, which the server turns into an attachment. | `apps/mobile/lib/quote.ts` |
| `RcTranslator` | Decodes Rocket.Chat stream events and documents into neutral `SyncChange` values. | `apps/mobile/providers/rocketchat/translator.ts` |
| `Reconnector` | Reconnection driver: exponential backoff with jitter, 1 s to 30 s; `suspend`/`resume` on background and foreground. | `apps/mobile/lib/reconnect.ts` |
| `RestClient` | The REST client; runs under Node, owns timeouts, 429 sleep and the 401 hook. | `apps/mobile/lib/rest.ts` |
| `sessionStore`, `storageKeys` | Session and fixed-key persistence in `expo-secure-store`, and the derivation of every key name (`STORED_KEYS`, per-server session, per-account E2EE key). | `apps/mobile/lib/sessionStore.ts`, `apps/mobile/lib/storageKeys.ts` |
| `Store` | The storage interface the sync engine writes through, and its factories (`createStore`, `createOutboxStore`, `createUploadStore`, `createDraftStore`, `createEmojiStore`). | `apps/mobile/lib/sync.ts`, `apps/mobile/db/store.ts` |
| `SyncEngine` | Applies stream events and REST documents as upserts. | `apps/mobile/lib/sync.ts` |
| `UploadEngine`, `uploads` | The upload queue engine (validation, two-step upload, `file_id` dedup) and its table (`pending`, `sending`, `failed`). | `apps/mobile/lib/uploadQueue.ts`, `apps/mobile/db/schema.ts` |
| `upserts` | The idempotent SQL, kept in one module and executed as-is by the tests on `node:sqlite`. | `apps/mobile/db/upserts.ts` |
| `users` | Users table: `uid` to current username and `avatar_etag`. | `apps/mobile/db/schema.ts` |
| Write queue (`createWriteQueue`, `serially`) | Serialises every write of ONE SQLite connection, because transactions are per connection and not reentrant. | `apps/mobile/db/writeQueue.ts` |

## Mobile: UI layer (`apps/mobile/ui/`)

| Term | Meaning | Where |
|---|---|---|
| `composer` | Composer shared by room and thread screens. | `apps/mobile/ui/composer.tsx` |
| `generation` | Connection generation counter in `SyncProvider`, bumped at each connection setup; screen caches compare against it. | `apps/mobile/ui/sync.tsx` |
| `homeSections` | The room list grouping (`unread`, `favorites`, `rooms`, `directMessages`) and the folded-section codec. | `apps/mobile/ui/homeSections.ts` |
| Hot rooms (`hotRooms`) | Up to 3 recently left rooms whose subscriptions stay open (LRU), so re-entering needs no slow `syncMessages`. | `apps/mobile/ui/hotRooms.ts` |
| Identities (`identities`, `identityStore`) | `uid` to current username and avatar etags, fed from the `users` table into two module-level stores. | `apps/mobile/ui/identities.tsx`, `apps/mobile/ui/identityStore.ts` |
| `kit`, `theme` | Shared visual bricks and the "Nuit Étoilée" (starry night) theme tokens. | `apps/mobile/ui/kit.tsx`, `apps/mobile/ui/theme.ts` |
| `launchPickerWithRetry` | Launches a native picker with retry over an Android view-tree NPE (the one argued fixed delay in the repo). | `apps/mobile/ui/launchPicker.ts` |
| Live query (`useCoalescedLiveQuery`) | A `useLiveQuery` that coalesces write bursts. | `apps/mobile/ui/liveQuery.ts` |
| Loaded rooms / threads | Which rooms / threads already got their opening load, and under which `generation`. | `apps/mobile/ui/loadedRooms.ts`, `apps/mobile/ui/loadedThreads.ts` |
| `messageJump` | Jump-to-message target, armed by the pinned/starred list or the search. | `apps/mobile/ui/messageJump.ts` |
| `MessageRow` | Message row, shared by room and thread. | `apps/mobile/ui/messageRow.tsx` |
| `messages` | The i18n catalog (`fr` is the reference, `en` typed against it). | `apps/mobile/ui/messages.ts` |
| Open rooms (`openRooms`) | Which room screens are mounted and which one is displayed (the only room the catch-up targets). | `apps/mobile/ui/openRooms.ts` |
| Private notes (`privateNotes`) | The server's answer to a slash command, shown above the composer, in memory only. | `apps/mobile/ui/privateNotes.tsx` |
| Reply target (`reply`) | The channel between the actions sheet and the composer. | `apps/mobile/ui/reply.ts` |
| `sessionToken` | UI session token that lets module-level caches refuse a late write after sign-out. | `apps/mobile/ui/sessionToken.ts` |
| `SessionProvider`, `SyncProvider` | Session lifecycle (optimistic resume, sign-out) and the sync wiring per session. | `apps/mobile/ui/session.tsx`, `apps/mobile/ui/sync.tsx` |
| Smoothed data (`useSmoothedData`) | Throttles bursts of incoming messages so the inverted list does not jump. | `apps/mobile/ui/smoothedData.ts` |
| Staged attachments | Attachments shown as chips before sending. | `apps/mobile/ui/stagedAttachments.tsx` |
| `attachmentSource` | Attachment source channel between the composer and the "attach" sheet. | `apps/mobile/ui/attachmentSource.ts` |
| `transfers` | Downloads in progress (save, share) and their progress. | `apps/mobile/ui/transfers.ts` |
| `unreadBar` | The "new messages" bar projection. | `apps/mobile/ui/unreadBar.ts` |
| Upload probe (`reportUploadEnd`) | Checks DDP liveness after a multipart upload, which can kill the socket silently. | `apps/mobile/ui/uploadProbe.ts` |
| Viewer (`ImageViewerProvider`) | Full-screen image viewer. | `apps/mobile/ui/imageViewer.tsx` |

## Mobile routes (`apps/mobile/app/`)

| Route file | Screen |
|---|---|
| `_layout.tsx` | Root native stack; declares the `formSheet` sheets and the share guard. |
| `index.tsx` | Gate and room list (to `/login` without a session). |
| `login.tsx` | Sign-in: server, credentials, second factor. |
| `room/[rid].tsx` | A room, deep link `rocketvibe://room/<rid>?host=`. |
| `thread/[id].tsx` | A thread, `id` = root message id. |
| `call/[callId].tsx` | Call screen: Jitsi in a full-screen WebView, the only WebView. |
| `message-actions.tsx` | Message actions sheet. |
| `attach.tsx` | "Attach" sheet: attachment sources. |
| `unlock-e2e.tsx` | E2EE unlock sheet. |
| `room-info.tsx` | Room info sheet. |
| `profile.tsx` | A user's profile sheet. |
| `my-profile.tsx` | My profile (edit). |
| `settings.tsx` | Settings. |
| `share.tsx` | Incoming share (Android `ACTION_SEND`). |
| `search.tsx` | Start a conversation (spotlight). |
| `message-search.tsx` | Message search in one room. |
| `marked-messages.tsx` | Pinned and starred messages. |
| `+native-intent.tsx` | Swallows the iOS share extension's `rocketvibe://dataUrl=` reopen and rewrites an old `salon/` room link to `room/`. |

## Mobile native (`apps/mobile/modules/`, `apps/mobile/plugins/`)

| Term | Meaning |
|---|---|
| `downloads` | Android module: copies a file into the public Downloads folder. |
| `fcm-token` | iOS module: hands the APNs token to Firebase and returns the FCM token. |
| `notification-reply` | iOS module: inline reply from a notification, sent natively. |
| `NotificationReplyReceiver`, `PushCatchUpWorker` | The generated Android reply receiver and WorkManager catch-up worker of the push service. |
| `video-compressor` | Module (Media3 on Android, AVFoundation on iOS) that downscales a video before upload. |
| `with-fcm-deeplink.js` | Config plugin injecting the Kotlin FCM service (`push.get`, WorkManager retry, deep links). |
| `with-incoming-share.js`, `with-signature-release.js`, `with-target-architectures.js`, `with-ios-push.js` | Incoming share, release signing, target ABIs, iOS push. |

## Desktop (`apps/desktop/`)

| Term | Meaning | More |
|---|---|---|
| `rv-core` | UI-free Rust core: protocol, SQLite store, sync, outbox, uploads, E2EE, display rules. A port of the mobile `lib/`. | [desktop-core](architecture/desktop-core.md) |
| `rv-ffi` | UniFFI façade over `rv-core` for the SwiftUI app. | [desktop-macos](architecture/desktop-macos.md) |
| `rv-gtk` | The GTK 4 + libadwaita app (Linux, Windows, macOS). | [desktop-gtk](architecture/desktop-gtk.md) |
| `rv-native` | Windows and macOS shims: system notifications, badges, call web views, tray, start at login. | [desktop-gtk](architecture/desktop-gtk.md) |
| `RocketVibeKit`, `RocketVibe` | The SwiftUI app's view models and views (`apps/desktop/macos/Sources/`). | [desktop-macos](architecture/desktop-macos.md) |
| Context window | The history around a message older than what a room has loaded, held in memory and never stored; the list showing it is detached from the present until the window reaches the local history (rv-core `context`, rv-ffi `ContextView`, mobile `lib/contextWindow.ts`). | [room-view](features/room-view.md) |
| `timeline` | rv-core's message-list grouping (headers, day separators, new-messages marker), shared by both UIs. | [room-view](features/room-view.md) |

## Project vocabulary

| Term | Meaning |
|---|---|
| Bench | The local Rocket.Chat 8.5.1 test server in `docker/`. |
| Deliberate deviation | A documented departure from the audit's prescribed fix, with its reason (`apps/mobile/WORKSTREAMS.md`). |
| Kill gate | Phase 1 of `ROADMAP.md`: the binary proof that a self-built APK receives pushes when killed. |
| Proof by removal | Delete the fix, check that the expected tests fail, restore. A removal that changes nothing is an empty test. |
| Step | A step of the (frozen) construction checklist `apps/mobile/EXECUTION.md`, e.g. "8.3". |
| Unreleased | The changelog section every visible change goes into. |
| Workstream | A work item of the 2026-07-25 audit, numbered 1 to 16 in `apps/mobile/WORKSTREAMS.md`. |

## Legacy French names

The code had French names until the English rename. These are the only French words still meaningful, because users see them or an upgrade reads them once.

- **French UI.** The `fr` catalog in `apps/mobile/ui/messages.ts` and the French column of `crates/rv-core/src/i18n.rs` are user-facing text; so are the French native notification strings (`NATIVE_STRINGS` in `apps/mobile/plugins/with-fcm-deeplink.js`, `res/values-fr/strings.xml`) and the theme name "Nuit Étoilée".
- **SQLite.** The pre-0016 table, column and value names (`salons`, `abonnements`, `sortie`, `televersements`, `brouillons`, `utilisateurs`, `etat_synchro`, `emojis_custom`, statuses `en-attente` / `envoi` / `echec`, cursor streams `salons` / `abonnements` / `messages-supprimes`, avatar marker `sans-photo`) appear only in migrations 0000 to 0015 (`apps/mobile/db/migrations/`) and in the rewrite done by `0016_english_names.sql`.
- **SecureStore keys**, moved on first read by `readMovedKey` / `readMovedKeySync` (`STORED_KEYS`, `apps/mobile/lib/storageKeys.ts`): `dernier-serveur`, `serveurs-connus`, `jeton-push-appareil`, `deconnexions-en-suspens`, `sections-repliees`, `langue-preferee`. Inside stored JSON: the session field `genre` (now `kind`), the pending-logout field `jetonPush` (now `pushToken`), the collapsed section keys `nonLus`, `favoris`, `salons`, `messagesPrives` (`apps/mobile/ui/homeSections.ts`).
- **Links.** `rocketvibe://salon/<rid>`, rewritten to `room/` on mobile (`apps/mobile/lib/roomLink.ts`) and accepted by both desktop parsers.
- **Native push, kept one release.** `ReponseNotifReceiver` and `RattrapagePushWorker` (empty subclasses of the new classes), the RemoteInput key `rv_reponse`, the worker input key `ombre`, the work-name prefix `rattrapage-push-` (cancelled alongside `push-catch-up-`), the shown-messages preferences `rvpush-affiches` (read after `rvpush-shown`), the iOS reply action `rv-repondre` (accepted with `rv-reply`), and the native language key `key_v1-langue-preferee` (read after `key_v1-preferred-language`; iOS `langue-preferee`). The debug files `rvpush-journal.log` and `rvpush-sonde` were renamed without a fallback (`rvpush.log`, `rvpush-probe`).

## Sources

- `CLAUDE.md`
- `ROADMAP.md`
- `apps/mobile/WORKSTREAMS.md`
- `apps/mobile/db/schema.ts`
- `apps/mobile/db/writeQueue.ts`
- `apps/mobile/db/store.ts`
- `apps/mobile/db/migrations/0016_english_names.sql`
- `apps/mobile/lib/provider.ts`
- `apps/mobile/lib/connectionSetup.ts`
- `apps/mobile/lib/catchUp.ts`
- `apps/mobile/lib/ddp.ts`
- `apps/mobile/lib/rest.ts`
- `apps/mobile/lib/storageKeys.ts`
- `apps/mobile/lib/roomLink.ts`
- `apps/mobile/ui/identities.tsx`
- `apps/mobile/ui/hotRooms.ts`
- `apps/mobile/ui/homeSections.ts`
- `apps/mobile/ui/sync.tsx`
- `apps/mobile/app/_layout.tsx`
- `apps/mobile/modules/`
- `apps/mobile/plugins/`
- `apps/mobile/plugins/with-fcm-deeplink.js`
- `apps/desktop/crates/rv-core/src/sync.rs`
- `apps/desktop/crates/rv-core/src/session.rs`
- `apps/desktop/crates/rv-native/src/lib.rs`
- `apps/desktop/docs/MACOS-SWIFTUI.md`
