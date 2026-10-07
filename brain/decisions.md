# Decisions

The non-obvious choices behind rocket-vibe and why they were made, grouped by area. Each entry gives the decision, the reason, and the brain doc that describes how it is implemented. Where the original rationale (in `ROADMAP.md`, `CLAUDE.md`, `apps/mobile/WORKSTREAMS.md`) has since been overtaken by the code, the entry says what the code does now.

## Product scope

- **A personal, faster and more reliable client for a self-hosted Rocket.Chat 8.x, not a general product.** The target is `chat.barrut.me` (8.5 LTS), administered by the author. Being admin is what makes direct push feasible. The local test server is pinned to 8.5.1 to match it. See [overview](architecture/overview.md), [rocket-chat](architecture/rocket-chat.md).
- **Android first, distributed by sideload.** No Play Store, no review, no trademark risk; an APK built locally is installed with `adb`. iOS was kept platform-agnostic and is now prepared through the same config plugins, but has never been built with Xcode (`docs/PUSH.md`). See [mobile-native](architecture/mobile-native.md).
- **Deliberately out of scope:** server administration, omnichannel/livechat, interactive UiKit blocks (unknown `blocks` are ignored, `attachments` and `md` are rendered), OTR (removed in 8.0), OTA updates. These are recorded debts, to prevent scope drift.
- **E2EE: first "degrade cleanly", then implemented.** The roadmap ruled it out because only 1 room out of 25 is encrypted on the target server and the crypto would take weeks. The degraded behaviour came first (lock icon, hidden preview, placeholder, composer disabled, generic notification), and is still the fallback while locked. The code now decrypts, encrypts messages and encrypts files (`apps/mobile/lib/e2e/`, `apps/desktop/crates/rv-core/src/e2e.rs`). See [e2ee](architecture/e2ee.md), [features/e2ee](features/e2ee.md).
- **Native E2EE is on by default since 6 October 2026, before its independent review.** RFC 0002 planned activation only after an independent review; the owner activated it on the basis of the internal review (`docs/protocol/E2EE_REVIEW.md`), the test suites, the CI qualification of the three apps and real use. The server advertises `e2ee` unless the operator sets `RV_E2EE=false` (`apps/server/src/main.rs`); the opt-in preview flag is gone and the mobile "experimental" notice with it. The review's open items are accepted risks, listed in [RFC 0002, Activation](../docs/rfcs/0002-e2ee-native.md#activation-6-october-2026).
- **Calls: first excluded, then shipped through Jitsi.** The roadmap avoided `@rocket.chat/media-signaling`. Calls now use the server's configured video conference (Jitsi) through `video-conference.join`, acting over REST like everything else. See [calls](features/calls.md).
- **Several servers and accounts side by side.** Tokens and SQLite databases are isolated per (server, account), so signing out of one never touches another. See [login-and-servers](features/login-and-servers.md).
- **A provider façade for a second backend.** Everything that names a Rocket.Chat endpoint or stream is meant to go through `Provider` so a Mattermost (kChat) driver can be added; today only `rocketchat` exists. See [mobile-app](architecture/mobile-app.md).

## Mobile platform constraints

- **Native components by default, in three tiers.** Tier 0 is pure React Native primitives; tier 1 is native bindings that expose an OS capability without imposing a look (`react-native-screens`, safe area, `expo-image`, gesture handler, haptics); tier 2 is a short list of argued exceptions: `@shopify/flash-list` (native view recycling for thousands of messages), `react-native-keyboard-controller` (frame-synced composer, since `KeyboardAvoidingView` is poor on Android), `@rocket.chat/message-parser` (MIT, pure JS, no UI), `react-native-webview` (calls only). Any new UI dependency is justified in its commit against `ROADMAP.md` §4.2. See [stack](stack.md), [mobile-app](architecture/mobile-app.md).
- **Banned outright:** UI kits (NativeBase, Tamagui, gluestack, RN Paper), `react-native-markdown-display`, `react-native-render-html`, `@gorhom/bottom-sheet` (a JS reimplementation of a component the platform has). Bottom sheets are native, `presentation: 'formSheet'` from `react-native-screens` through expo-router. Markdown is rendered from the server's AST into nested `<Text>` (`apps/mobile/ui/markdown.tsx`).
- **One WebView, bounded: the call screen.** The native Jitsi SDK targets RN ~0.79 and bundles `react-native-webrtc`, a fragile bet against RN 0.86. `apps/mobile/app/call/[callId].tsx` is the only route with a WebView, locked on the origin the server designated (`apps/mobile/lib/origin.ts`), because the app holds camera and microphone during the call and Android cannot arbitrate those per origin. Video link previews stay native cards (`apps/mobile/ui/embedCard.tsx`). See [calls](features/calls.md).
- **No EAS, ever, for Android.** Builds are `expo prebuild` + `./gradlew`, locally and on CI. See [operations](operations.md).
- **Continuous Native Generation.** `android/` and `ios/` are gitignored; every native customisation is a config plugin in `apps/mobile/plugins/` or a local module in `apps/mobile/modules/`, because SDK 57's `expo prebuild` wipes and regenerates by default. A native change needs a dev-client rebuild, not a Metro reload. See [mobile-native](architecture/mobile-native.md).
- **Native modules over pure-JS polyfills for heavy work.** E2EE goes through `react-native-quick-crypto` (Nitro, OpenSSL, `node:crypto` API): `apps/mobile/lib/e2e/crypto.ts` imports `crypto`/`buffer`, `apps/mobile/metro.config.js` aliases them to quick-crypto on device, and the same imports resolve to `node:crypto` under Node tests. `expo-crypto` has no RSA. Since tests never run quick-crypto itself, `apps/mobile/lib/e2e/surfaceQuickCrypto.ts` pins the API surface by types. See [e2ee](architecture/e2ee.md).
- **New Architecture is not a safety net.** Mandatory since RN 0.82; `newArchEnabled=false` does nothing.
- **`react-native-reanimated` is accepted, not fought.** It costs RAM, but `expo-router` depends on it directly; dropping it would mean dropping expo-router.
- **Drafts in SQLite, not MMKV.** The roadmap planned MMKV; drafts are debounced (400 ms), so async latency is irrelevant, and a native dependency (full rebuild) was not worth it when the database already holds all local state (`drafts` table, `apps/mobile/ui/drafts.ts`). See [composer](features/composer.md).
- **i18n catalogue typed against French.** `fr` defines the keys; `en` is `Record<TranslationKey, string>`, so `tsc` rejects a missing or extra key. See [i18n](architecture/i18n.md).

## Data model

- **Local SQLite is the source of truth; the UI is a projection.** WebSocket and REST write upserts; screens observe through live queries; the real-time flow is never kept in an in-memory store. This is the direct remedy to the official app's stacked subscriptions, duplicated messages and frozen sends. See [mobile-data](architecture/mobile-data.md), [offline-and-sync](features/offline-and-sync.md).
- **One database per server and per account** (`apps/mobile/db/fileName.ts`): rooms, previews and unread counts are account data.
- **The SQL lives in `apps/mobile/db/upserts.ts` only**, executed as-is by the tests on `node:sqlite`, instead of Drizzle's builder, so the tests exercise the exact query the app sends.
- **One write queue per SQLite connection** (`apps/mobile/db/writeQueue.ts`): transactions are per connection and not reentrant, and a write issued during an open `BEGIN` is absorbed into it and silently rolled back if the batch fails. Found as the most dangerous race of the audit (chantier 2).
- **A private view lives while its room is on screen, sheets and the composer's picker included.** On Android the decrypted projection of an encrypted RocketVibe room (`ui/encryptedConversation.ts`) was disposed on every blur, so each action sheet, the attach menu or the system photo picker emptied the room, rebuilt it from the vault (seconds) and dropped the attachment being picked. It now stays while a `formSheet` of the room is on top or a picker launched from the composer is open (`ui/roomCover.ts`); leaving the room for another screen, the background otherwise, a membership change or a new admission still dispose it at once. See [e2ee-private-actions](features/e2ee-private-actions.md).
- **Volatile things stay volatile.** Presence, typing, server notes and search or pinned/starred results are kept in memory or rendered from the response, never written to SQLite: stale presence from a cache is worse than none.
- **Retention: 500 messages per room** (`MESSAGES_KEPT_PER_ROOM`), purged with a partitioned `DELETE`, sparing optimistic rows and thread roots.
- **The database is not deleted at sign-out.** Deleting it hot broke migrations (memoised per file name), could not wait for in-flight writes, and raced the 30 s sign-out. Decrypted E2EE plaintext is hidden by an `UPDATE` instead; `PRAGMA secure_delete` is an open question (chantier 9).

## Protocol

- **REST to act, DDP to listen.** DDP method calls are deprecated in 8.0 and removed in 9.0. `login` is the only method still called, because a `sub` without an authenticated socket gets `nosub`. See [rocket-chat](architecture/rocket-chat.md), [mobile-transport](architecture/mobile-transport.md).
- **Our own DDP client, written from the spec.** `@rocket.chat/ddp-client` is good but ships without a `license` field and with an Enterprise Edition `LICENSE`; "probably MIT" is not a basis. Its code is not copied. Listening only, the client needs `connect`, `login`, `sub`, `unsub` and event routing.
- **Catch-up in two stages.** `rooms.get` + `subscriptions.get` with `updatedSince` cover every room in two requests; `chat.syncMessages`, one room per call, slow and rate-limited at 10 calls/min, runs only for the displayed room. See [offline-and-sync](features/offline-and-sync.md).
- **Connection setup reads twice on purpose.** `setUpConnection` reads before and after arming subscriptions; the second read guarantees nothing falls between the read and the subscription. Making it conditional was rejected ("À ne pas toucher" in `WORKSTREAMS.md`).
- **Mobile: no `__my_messages__`, a hot-room LRU instead.** Subscribing to the all-rooms key would replace `apps/mobile/ui/hotRooms.ts`, but at the cost of receiving all 25 rooms' traffic continuously (battery, data). The mobile keeps up to 3 recently left rooms subscribed so re-entering skips a 3-4 s `syncMessages`. **The desktop chose the other way:** `rv-core` subscribes to `__my_messages__` at session start and keeps deletions per open room. See [offline-and-sync](features/offline-and-sync.md), [desktop-core](architecture/desktop-core.md).
- **Text outbox with a client-side `_id`.** 24 hex chars generated before display; the server refuses a second message with the same `_id`. A replay answers 400, not success, so the client confirms with `chat.getMessage` before declaring failure (`apps/mobile/lib/outbox.ts`).
- **Upload dedup is entirely local.** Replaying `rooms.mediaConfirm` either posts a duplicate while answering 200 with the first message, or answers `[invalid-file]` for a delivered file: no server answer is usable. The `file_id` from `rooms.media` is persisted (`uploads.file_id`); before confirming again, the client asks SQLite, and when SQLite is silent, refreshes that one room (`refreshRoom`). A client `_id` cannot be passed: the schema is `additionalProperties: false`. Failed uploads are not retried automatically. See [uploads](features/uploads.md).
- **Only a 401 signs out, and only a trusted one.** On 8.5, 401 means "not authenticated" and nothing else (403 permissions, 400 kicked, 400 `totp-invalid`). The hook also requires a Rocket.Chat envelope marker (`success`, `status`, `errorType`), because a reverse proxy answers 401 too, and skips anonymous calls, because `/api/v1/login` maps every failure to 401. No whitelist on the error text: a server rewording would silently bring back the zombie state. See [mobile-transport](architecture/mobile-transport.md), [login-and-servers](features/login-and-servers.md).
- **Optimistic session resume.** The stored session is trusted at start and validated in the background; an unreachable server is not a reason to drop a session.
- **Reconnection: jittered backoff, suspended in background, reset on foreground.** No socket is reopened in the background; coming back resets the backoff (measured 59 ms instead of a 22.7 s armed timer). 429s get a dispersed sleep but no per-route queue: the window is per minute, so only not emitting calls helps.
- **Private edits and deletions are amendments, not server mutations.** On the RocketVibe server the server never sees private text, so it cannot rewrite or erase a message; an edit or deletion is a new encrypted message naming its target, checked by the server only for room, author and thread, and applied by every reader when it projects the journal (newest first, so no separate index). A deletion hides, it cannot recall copies already received. Keeping amendments in the normal outbox gives them resume and cancel for free. Reactions are amendments too, so the server never learns the emoji. See [e2ee-private-actions](features/e2ee-private-actions.md).
- **Private files: an opaque object, the key in the message.** The server keeps its upload routes, quotas and Range downloads but sees only ciphertext of a known size; a fresh key per file travels inside the encrypted document, so access follows the room's members and no key exchange is needed. The private message completes the upload in its own transaction, so no object is reachable without a message. Sealing and opening are streamed in Rust on all three apps (native, not a JS polyfill). See [e2ee-private-files](features/e2ee-private-files.md).
- **Control is delegated inside a history share, not by a new ceremony.** The share already binds a request signed by a verified sibling, a human fingerprint comparison and an HPKE envelope to that request; the private root rides in the same envelope on an explicit, irreversible choice, and is adopted only if it is exactly the account's root. No server route or code transfer was added. See [e2ee-delegation](features/e2ee-delegation.md).
- **Old keys are destroyed by renewing the storage key, not by erasing copies.** Erasure cannot be trusted on flash, in the WAL or in backups; replacing the only key that opens them can. Blocks are re-sealed with their original digest inside so the archive's nested references never change, and the keystore record's `next` key keeps every crash recoverable. The recoverable history keeps its own keys on purpose. See [e2ee-storage-keys](features/e2ee-storage-keys.md).
- **Private search runs on the device, without an index.** The server holds only ciphertext, and a persistent plaintext index would be a second copy of private text outside the protected archive; search instead walks the verified journal (then recovered history) with amendments applied, at the cost of decrypting documents on each search. See [e2ee-private-actions](features/e2ee-private-actions.md).
- **A private message's id is derived from its proof, not chosen by the server.** Amendments, replies and files name their target by id; a server-chosen id bound to nothing signed let the server relabel which message they meant. The id is SHA-256(domain, proof fingerprint) truncated to 16 bytes, and every client refuses another. Found by the internal crypto review, whose findings and open items live in `docs/protocol/E2EE_REVIEW.md` (internal, not the independent review RFC 0002 requires). See [e2ee-private-actions](features/e2ee-private-actions.md).
- **Avatar versions go in the URL query.** `/avatar/<user>` has a 1 h cache and no ETag, so Android's image cache freezes it; `avatarETag` is appended and a no-photo marker is set on reset. See [avatars](features/avatars.md).

## Push

- **Direct FCM HTTP v1 to our own Firebase project.** The public gateway only serves official app ids. A foreground service with a permanent socket is capped by Android 15 and drains battery; local notifications from the socket die with the process. See [notifications](features/notifications.md).
- **The server bundle is patched so official apps keep their push.** The gateway/native choice is global in Rocket.Chat; `docker/patch-push.mjs` routes only `appName: rocket-vibe` tokens natively (and adds an `apns` block for iOS).
- **Hidden-content push is kept** (user decision, 2026-07-16: nothing readable at Google or Apple). Each push carries only a `messageId`; the native service fetches content with `push.get`, with a WorkManager retry on failure (`apps/mobile/plugins/with-fcm-deeplink.js`). Bursts degrade to "New message" because `push.get` shares the 10/min limit. No fix may propose lifting it.
- **iOS uses FCM too**, with a Notification Service Extension doing `push.get`; no APNs settings in Rocket.Chat.

## Desktop

- **Rust, with a UI-free core.** `rv-core` ports the mobile `lib/`, whose tests are the spec; display rules both UIs need (timeline grouping, room avatar rule, i18n table) moved into it so they are not written twice. See [desktop-app](architecture/desktop-app.md), [desktop-core](architecture/desktop-core.md).
- **GTK 4 + libadwaita for Linux, Windows and macOS.** Everything builds in a Fedora container (`apps/desktop/docker/`, `apps/desktop/scripts/build.sh`: fmt, clippy `-D warnings`, tests), so the host needs no Rust or GTK headers. Tokens live in the system keyring, never on disk. See [desktop-gtk](architecture/desktop-gtk.md).
- **Calls in an app window, locked on origin.** WebView2 on Windows, WKWebView on macOS, with the origin rule written once in `apps/desktop/crates/rv-core/src/call.rs`. On Linux, distributions build WebKitGTK without WebRTC, so a Chromium-family browser opens in `--app` mode, else the default browser. See [calls](features/calls.md).
- **macOS GTK draws with cairo** (`GSK_RENDERER=cairo`): the GL renderer drew emoji as `?` and crawled without a GPU. That made the app feel laggy, hence:
- **A SwiftUI app for macOS over `rv-ffi`** (UniFFI proc-macros). `rv-ffi` runs its own tokio runtime rather than UniFFI's, shares accounts, keychain items and databases with the GTK install, and hands Swift parsed records so Swift never parses Rocket.Chat documents. It records voice as AAC `.m4a` (AVFoundation cannot write Ogg/Opus). It is built and notarized on CI but not yet walked against a server on a Mac. See [desktop-macos](architecture/desktop-macos.md).
- **An old message opens in a context window, never stored.** The local store only holds history that runs unbroken to the present; an isolated page written there would hide the hole before it. Paging back from the present until the message is reached cost a page per 50 messages at 10 requests a minute, so a two-year-old search result gave up. The window reads around the message straight from the server and joins the store only once it reaches the local history. See [room-view](features/room-view.md).
- **`rv-native` for system integration GLib lacks:** clickable toasts and badges on Windows, `UNUserNotificationCenter` on macOS, tray, single instance, start at login.
- **Text slash commands are written by the client.** `/shrug` and its kind only decorate a message, so the apps write it (`rv_protocol::commands::decorate`) and send it like any other, on Rocket.Chat as on RocketVibe: a server-side command could never write into an encrypted room. The RocketVibe server runs only the commands that act (`apps/server/src/commands.rs`), each through an operation it already had. See [slash-commands](features/slash-commands.md).
- **The server rail polls; it does not connect every account.** Only the open account holds a live connection; each other one is read once a minute (`subscriptions.get` or the native rooms list) for its dot. Keeping every account connected would multiply sockets, sync and battery for one bit of information. See [login-and-servers](features/login-and-servers.md).
- **The rustls provider is chosen explicitly** (`rv-core/src/tls.rs`): two are compiled in (ring through rv-client's reqwest 0.12, aws-lc-rs through ours), and rustls then panics a `wss://` connection instead of guessing, which silently kept every HTTPS server's live connection down.

## Voice

- **LiveKit, self-hosted, rather than a home-made SFU.** It carries WebRTC, TURN and
  simulcast, and has native SDKs for every client we ship (Android, Swift, Rust). The
  RocketVibe server only mints short tokens and mirrors who is connected. See
  [voice](features/voice.md).
- **The Android engine is a Kotlin module over the LiveKit Android SDK**, not
  `react-native-webrtc`: the latter is a fragile bet under the New Architecture on RN 0.86
  (the same reason the Jitsi SDK was refused), and audio needs no JS-side media.
- **The desktop audio runs in a sidecar process, `rv-voice`.** The `livekit` crate links
  libwebrtc, which ships only for MSVC on Windows while the GTK app builds with MSYS2, and
  it must stay out of rv-ffi's static library. A separate process also keeps a WebRTC crash
  from taking the window down.
- **Presence comes from the SFU, polled.** The server polls LiveKit every 2 s rather than
  trusting client heartbeats (Android suspends JS timers in the background) or webhooks
  (an inbound endpoint for under 2 s gained). Who speaks stays client-side: too fast for a
  2 s snapshot.
- **One voice connection per account**: the LiveKit identity is the account id, so joining
  elsewhere moves the connection, like Discord.
- **Additive wire changes only.** A call's outcome rides on `Message.call` and voice state
  on optional live fields: a new `SystemMessage`, `Change` or `RoomKind` variant would make
  older clients reject whole batches.
- **Encrypted rooms keep their voice end to end, with LiveKit's frame encryption.** The key
  is an MLS exporter secret of the room's group at its epoch, so membership and rotation
  come from the group and the server learns nothing. LiveKit's shared-key mode at index 0
  is the one scheme the Android, Swift and Rust SDKs share; a rotation is a short silence
  between devices that switched and those that did not yet, never plaintext. An encrypted
  session has its own LiveKit room (`rve:`), so a plaintext client can never sit in it.
  The key is the only group secret that leaves Rust (to JS and Kotlin on Android, over the
  sidecar's pipe on desktop): accepted because it opens only this epoch's voice. LiveKit's
  frames do not authenticate the sender among members (`docs/protocol/E2EE_REVIEW.md`).
- **Desktop video frames cross over loopback TCP, not shared memory.** Mapping memory needs
  `unsafe`, which the desktop workspaces deny; a local stream with a random token is safe
  code on all three platforms, and at 15 frames a second per track the copy costs little.
  The sidecar keeps the latest frame per track and drops stale ones, so a slow window never
  slows the call.
- **A new screen share replaces the current one** rather than being refused: switching who
  presents takes one click, and the previous sharer's client stops by itself when the SFU
  revokes its screen source.
- **Original sounds generated from code** (`scripts/sounds`): no sample, no licence to
  track; the ringtone ("Neon Drive") was chosen by ear among four candidates.

## Repository and process

- **One monorepo, one version per app.** `apps/mobile/app.json` (plus `package.json` and `versionCode` = major×10000 + minor×100 + patch) and `apps/desktop/Cargo.toml`, checked by `scripts/version.mjs`. CI checks an app only when its files change and builds packages only on a `mobile-vX.Y.Z` / `desktop-vX.Y.Z` tag or a manual run; the release notes are the version's changelog section, which is mandatory. See [operations](operations.md).
- **Layered branches merged into `master`.** Commits are prefixed with the branch name and layered (fix, then test, then changelog), merged with a `merge <branch>: <summary>` commit, as `git log` shows.
- **Prove by running.** `npx tsc --noEmit` and a real launch; fixes are proven by removal (the test must fail without the fix). An assertion that passes without any side-effect output is an empty test. See [testing](architecture/testing.md).
- **No secrets in the repo**; `.example` files document them. `apps/mobile/docs/AUDIT.md` is frozen; `apps/mobile/WORKSTREAMS.md` is the source of truth for what to fix next.
- **The code is English; stored names were migrated rather than kept.** Code, comments, docs and both apps now share one vocabulary, so a name in the brain, the mobile code and the desktop code means the same thing and needs no French glossary. Names the mobile app persisted were renamed too, not frozen: migration `apps/mobile/db/migrations/0016_english_names.sql` renames tables and columns in place and rewrites stored values, and `readMovedKey` / `readMovedKeySync` (`apps/mobile/lib/storageKeys.ts`) move each SecureStore key on first read (new key written before the old is deleted), so an upgrade keeps sessions, the local data, the language and pending sends and sign-outs. Names the previous build may still hold outside the app's control keep a one-release alias: old `rocketvibe://salon/` links (posted notifications) are rewritten or accepted, and the native `ReponseNotifReceiver` / `RattrapagePushWorker` classes, the `rv_reponse` reply key and the `rattrapage-push-` work prefix survive for notifications and WorkManager jobs already posted. The legacy names are listed in [glossary](glossary.md#legacy-french-names).

## Sources

- `docs/protocol/E2EE_AMENDMENTS.md`
- `docs/protocol/E2EE_FILES.md`
- `docs/protocol/E2EE_STORAGE.md`
- `docs/protocol/E2EE_DELEGATION.md`
- `ROADMAP.md`
- `CLAUDE.md`
- `README.md`
- `apps/mobile/WORKSTREAMS.md`
- `apps/mobile/docs/AUDIT.md`
- `docs/PUSH.md`
- `apps/desktop/README.md`
- `apps/desktop/docs/MACOS-SWIFTUI.md`
- `apps/mobile/package.json`
- `apps/mobile/metro.config.js`
- `apps/mobile/db/schema.ts`
- `apps/mobile/db/writeQueue.ts`
- `apps/mobile/db/store.ts`
- `apps/mobile/db/migrations/0016_english_names.sql`
- `apps/mobile/lib/storageKeys.ts`
- `apps/mobile/lib/roomLink.ts`
- `apps/mobile/lib/rest.ts`
- `apps/mobile/lib/ddp.ts`
- `apps/mobile/lib/connectionSetup.ts`
- `apps/mobile/lib/outbox.ts`
- `apps/mobile/lib/uploadQueue.ts`
- `apps/mobile/lib/e2e/crypto.ts`
- `apps/mobile/ui/hotRooms.ts`
- `apps/mobile/ui/drafts.ts`
- `apps/mobile/app/call/[callId].tsx`
- `apps/mobile/plugins/with-fcm-deeplink.js`
- `docker/patch-push.mjs`
- `apps/desktop/crates/rv-core/src/sync.rs`
- `apps/desktop/crates/rv-core/src/session.rs`
- `apps/desktop/crates/rv-core/src/call.rs`
- `apps/desktop/crates/rv-gtk/src/macos.rs`
- `apps/desktop/crates/rv-native/src/lib.rs`
- `scripts/version.mjs`
