# Decisions

The non-obvious choices behind rocket-vibe and why they were made, grouped by area. Each entry gives the decision, the reason, and the brain doc that describes how it is implemented. Where the original rationale (in `ROADMAP.md`, `CLAUDE.md`, `apps/mobile/WORKSTREAMS.md`) has since been overtaken by the code, the entry says what the code does now.

## Product scope

- **A personal, faster and more reliable client for a self-hosted Rocket.Chat 8.x, not a general product.** The target is `chat.barrut.me` (8.5 LTS), administered by the author. Being admin is what makes direct push feasible. The local test server is pinned to 8.5.1 to match it. See [overview](architecture/overview.md), [rocket-chat](architecture/rocket-chat.md).
- **Android first, distributed by sideload.** No Play Store, no review, no trademark risk; an APK built locally is installed with `adb`. iOS was kept platform-agnostic and is now prepared through the same config plugins, but has never been built with Xcode (`docs/PUSH.md`). See [mobile-native](architecture/mobile-native.md).
- **Deliberately out of scope:** omnichannel/livechat, interactive UiKit blocks (unknown `blocks` are ignored, `attachments` and `md` are rendered), OTR (removed in 8.0), OTA updates. These are recorded debts, to prevent scope drift. Server administration was on this list until October 2026 (below).
- **Server administration in the apps, as a separate screen** (user decision, 2026-10-07). An administrator gets a Dashboard, Moderation, Rooms and Users, reached from the server rail's menu on the open server and from a link under the settings, both shown only to an administrator; it is not a section of the user's own settings, because it acts on other people and the server, not on me. Both providers map to one client model per app, so the screens are written once. See [administration](features/administration.md).
- **Admin rights open no private content.** On RocketVibe an administrator reads a message's text only through an open report, which its reporter chose to disclose, may delete only a reported message, and private (E2EE) messages cannot be reported at all: the server never holds their text, and administration must not become a way around end-to-end encryption or around members' privacy. The admin rooms list shows counts, never conversations.
- **Deleting a RocketVibe account tombstones it and keeps its messages** (user decision, 2026-10-07). Removing the row would break every message's author reference and erase other people's conversations; the account is instead cleared of everything personal and its credentials, renamed `deleted-<id>` (a reserved prefix), and shown as "Deleted user". Rocket.Chat keeps its own behaviour (its erasure setting), which the confirmation states. See `docs/protocol/ADMINISTRATION.md`, "Account deletion". Its former username is retired for good (`retired_usernames`): old mentions, links and screenshots must never come to name someone else.
- **A report keeps the text the reporter saw.** Each RocketVibe report stores the message text at report time, and the admin reads the newest reporter's snapshot, not the live message: an author must not be able to edit a reported message into something harmless before an admin looks, and the snapshot is exactly what the reporter chose to disclose. Reports per reporter are capped (200 open) so reporting cannot flood the administrators.
- **Rocket.Chat's bulk delete is never silent**. `chat.delete` needs room access, and the only way around it, `moderation.user.deleteReportedMessages`, deletes every reported message of that author. The apps use it only after a second, explicit confirmation naming how many messages go, because an admin asking to delete one message must not lose others by surprise. The same care drives the last-owner confirmation: Rocket.Chat would delete or reassign rooms, so the apps first call without `confirmRelinquish` and name those rooms.
- **The Rocket.Chat dashboard opens on cached figures**. `statistics?refresh=true` inserts a statistics document and aggregates the whole workspace, too heavy for every opening; the dashboard shows the stored snapshot with its date and offers a refresh. Each figure is read independently, so a missing permission leaves one figure unknown rather than failing the dashboard.
- **Bots are owned accounts acting with scoped API keys** (user decisions, 2026-10-08; RFC 0003). Anyone may create bots when the administrator opens them to everyone (`user_bots`, off by default); administrators always may. A key is a session of its own device, so every existing check (membership, room rights, read proofs, revocation) applies unchanged, and a route layer admits a key only on the routes of its scopes: deny by default, so a new route stays closed to bots until it is listed. A bot can never do what its owner could not (no administration, no account security, no room creation), cannot sign in, and is flagged on every user the server describes, with a badge in the apps, because anyone can name a bot `admin`. The API reference the apps show is served from the gate's own table, so the documentation cannot drift from what a key really reaches. Bots came before workflows: a workflow engine will be a bot inside the server. See [bots](features/bots.md), `docs/protocol/BOTS.md`.
- **Administrators oversee bots but never act as one** (review of RFC 0003). An administrator lists every bot and its keys, revokes keys and deletes bots, but only the owner creates a key, changes scopes or the profile: otherwise administration would become a way into the private rooms and direct conversations a bot belongs to, which the server otherwise never opens to an administrator. Ten bot creations a day per account, because deleting a bot retires its username for good.
- **Workflows act through their owner's bot, edited in plain forms** (user decisions, 2026-10-08; RFC 0004). Whoever may create a bot may build a workflow; what it posts goes through the bot's own internal session, so scopes, memberships, budgets and the encrypted-room refusal apply without a second set of rules, and a workflow can never do what its bot could not. The editor is a settings page with native forms (a trigger, an ordered list of steps), not a graphical canvas, in all three apps. An administrator oversees workflows (list, disable, delete) but never edits one, for the same reason as bots. See [workflows](features/workflows.md).
- **A run is durable and replay-safe, not a background task.** Each run keeps its own copy of the definition and saves its step and context after every step under a lease, so a restart resumes it and an edit never changes a run already started. A message step posts with the operation id `wf-<run>-<step>`, so a step replayed after a crash is answered with the first post instead of a second one.
- **Room triggers fire for people only** (user decision, 2026-10-08). Joins, reactions and matching messages never start a run when a bot did them: a workflow's own posts can never feed another workflow, so no loop needs detecting. Watching reactions or messages needs the bot's `rooms:read`, because it is reading the room, and both are checked again at every event, not only at save: a room that removed the bot stops feeding it (review of the branch).
- **A bot relays people's words, not their reach** (review of the branch). Values a template takes from people (a command's text, a message, a form answer, a webhook body) never carry `@all` / `@here` into a message, and are percent-encoded in a URL, so whoever triggers a workflow cannot ping a room or redirect a request through the owner's bot. HTTP steps reach ports 80 and 443 only, never through a proxy: a public address of the server's own host would otherwise expose services a firewall keeps out. Administrators overseeing a workflow see its header values hidden: they hold the owner's credentials elsewhere.
- **Bots stay out of encrypted rooms.** An MLS plan must represent every member and a bot has no crypto device: a bot added to an encrypted room would block every encrypted send of the room. The server refuses the membership (`bot_encrypted_room`) and a group transition while a bot is a member (`crypto_bot_member`); a direct conversation with a bot stays plaintext. Holding the keys on the server would break the E2EE promise; a bot with its own device (a visible member holding its own keys) is a later chantier.
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
- **Reaction usage is counted on the device, per account.** The quick reactions are my own habit, not shared data: nothing goes to the server (no new endpoint, nothing another device or the administrator could read), and per account, like the rest of an account's data, so one account's habits never fill another's menu. Mobile keeps it in the account's SQLite (table `emoji_usage`, untouched by purges since no catch-up can rebuild it); the desktop apps in a small per-account file both share on one Mac. A count is lost with the device, which is acceptable for a ranking. See [emoji](features/emoji.md#quick-reactions-and-reacting-with-any-emoji).
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

- **People are named as the Rocket.Chat server says** (user decision, 2026-10-09). The apps follow `UI_Use_Real_Name` like the official clients rather than choosing for the user: off, usernames everywhere; on, real names. Before, the in-app rows showed usernames while pushes showed real names (`sender.name`), which read as a mix-up. An administrator changes it for every client on the server.

## Other servers

- **Mattermost and kChat go through the generic sync path, not a branch of their own.** Their model (channels, memberships, posts, a socket pushing the account's events) maps onto Rocket.Chat's, so one translator writing the neutral rows reuses `SyncEngine`, the stores and the screens. RocketVibe kept its own branch because its journal is applied atomically. See [mattermost-and-kchat](features/mattermost-and-kchat.md).
- **The listener expands events, the translator stays synchronous.** Mattermost names users by id and sends no membership on a new post; `MmLive` resolves users, fetches what an event lacks and derives unread counts locally before the translator runs, instead of making `Translator` asynchronous for every provider.
- **kChat signs in as Infomaniak's own kChat app.** There is no public OAuth client for third parties; the PKCE flow reuses the client id and redirect of Infomaniak's open-source mobile app, which also means the official app can be offered the same redirect. A personal API token is the fallback. Personal use only, like the rest of the project.
- **Media authenticate by header on Mattermost and kChat, images through a local copy.** The server refuses a token in the URL (probed on 11.11), the `MMAUTHTOKEN` cookie would shadow the bearer on every `POST`, and React Native's `<Image>` drops `source.headers` on Android: images are downloaded with the bearer and shown from the cache (`ui/authorizedImage.ts`), downloads and players send the header themselves.
- **A kMeet call opens only on kMeet's origin.** On kChat the call screen's URL comes from a `custom_call` post, which any room member can write, not from a server answer as with Rocket.Chat's `video-conference.join`. The call view holds the camera and microphone, so both apps accept only `https://kmeet.infomaniak.com`, in the post and again at join; the WebView exception of `ROADMAP.md` §4.2 keeps its bound (an origin no message can choose).
- **A 401 signs out of Mattermost only with the server's own body.** The client sits behind proxies and Infomaniak's edge, and Mattermost itself answers a mistyped current password with a 401 in full envelope; a sign-out there would destroy a valid session for a typo or a gateway hiccup, so the rule mirrors Rocket.Chat's `understoodResponse`.
- **Slack and Teams are not reached through their official APIs.** Those deliver real time and push to a server the app would have to run, never to a phone; only their private, session-based APIs can feed a phone directly.

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
- **Settings and administration as a large modal closed by a click outside** (user decision, 2026-10-07). The former narrow preferences dialog stacked a second dialog for security, encryption and devices; a dialog of about 85 % of the window (at most 1100 x 800) with clickable categories on the left holds everything in one place, and a click on the dimmed backdrop, Escape or the close button closes it, as people expect from a modal. On GTK the backdrop is a window handle, so a click there used to drag or maximise the window: `widgets::close_on_backdrop` claims it. The administration reuses the same component (`SidebarDialog`). See [settings](features/settings.md).
- **A click outside a modal closes it, with no action, in every app** (user decision, 2026-10-07, recorded in `CLAUDE.md`). People expect a modal to go away when they click beside it; a dialog that ignores the click reads as frozen. The outside click is the Cancel path: it never confirms, never runs a destructive response. GTK presents every `adw::Dialog` and `adw::AlertDialog` through `widgets::present`, which attaches `widgets::close_on_backdrop` (an alert answers its close response); Android alerts are `cancelable` and sheets dismiss on an outside tap; SwiftUI draws its modals as overlays with a backdrop, because a window-modal `.alert` or `.sheet` on macOS cannot be dismissed by clicking outside.
- **An incoming call dismissed by a click outside is ignored, not declined**. The click-outside rule says an outside click takes no action, and declining is one: it tells the caller and ends the ring. So a click or tap outside, Escape or Back hides the prompt and stops the local ringtone only; the caller hears it ring until it times out as a missed call, and Decline stays an explicit button, in all three apps.
- **SwiftUI settings are an overlay of the window, not a `Settings` scene.** The scene opened a separate, narrow window that could not take the large categorised layout nor close on an outside click; the overlay matches the GTK dialog, and Command-comma still opens it through a `CommandGroup` replacing `.appSettings`.
- **`rv-native` for system integration GLib lacks:** clickable toasts and badges on Windows, `UNUserNotificationCenter` on macOS, tray, single instance, start at login.
- **Text slash commands are written by the client.** `/shrug` and its kind only decorate a message, so the apps write it (`rv_protocol::commands::decorate`) and send it like any other, on Rocket.Chat as on RocketVibe: a server-side command could never write into an encrypted room. The RocketVibe server runs only the commands that act (`apps/server/src/commands.rs`), each through an operation it already had. See [slash-commands](features/slash-commands.md).
- **The server rail polls; it does not connect every account.** Only the open account holds a live connection; each other one is read once a minute (`subscriptions.get` or the native rooms list) for its dot. Keeping every account connected would multiply sockets, sync and battery for one bit of information. See [login-and-servers](features/login-and-servers.md).
- **The server rail can be hidden, and is shown by default** (2026-10-09). Settings > Accounts carries "Hide the server bar", off by default in every app, so an install keeps its rail and the other accounts' unread dots until someone opts out (useful with a single server). Hidden, that page still switches and adds accounts, and the device-wide choice lives on the device (SecureStore on mobile, one config file GTK and SwiftUI share). See [settings](features/settings.md).
- **An account menu at the sidebar's foot, and labelled "+" menus** (user decision, 2026-10-09). The account block shows a gear and opens Settings, Server administration (for an administrator) and Sign out; Sign out left the sidebar header, where it sat next to "+". A bare "+" said nothing about what it adds, so the header's "+" is a menu naming its entries (New message, Create a channel where the server allows it), and the Direct messages and Channels section headers carry their own "+", Channels only where a channel can be created. The menu opens at once; the administrator row joins it when the status answers. Mobile keeps its header gear and its labelled rows. See [room-list](features/room-list.md).
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
- **The SwiftUI app reuses that sidecar rather than LiveKit's Swift SDK** (the first plan).
  The listening features (each person's volume, mute here, input volume and level, RNNoise
  and the voice gate, devices by id) live in the sidecar's own audio path; the Swift SDK
  would have meant writing them a third time, in Swift, and keeping two engines in step on
  the desktop. rv-ffi exports rv-core's `VoiceController` instead, with a supervisor task
  doing what GTK's UI loop does (hang up a declined ring, a direct call left alone), so
  Swift only draws.
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
- **A screen's sound leaves out the call by default.** Sending the call back to the room
  makes everyone hear themselves; the option exists for recording or streaming the whole
  call. Windows excludes the sidecar's own process from the loopback, the cleanest cut;
  Android cannot capture call audio at all and mixes the rest into the microphone track,
  its one recorded track.
- **Linux's screen sound runs in its own binary, `rv-screen-audio`.** libwebrtc defines
  weak stubs of PipeWire's C functions (`pw_init`, `pw_stream_new`...), filled only when
  its own screen capture loads PipeWire; linked into rv-voice, the PipeWire bindings
  called those empty stubs and crashed. The helper links no libwebrtc and hands rv-voice
  raw PCM on a pipe. Leaving the call out means linking every other app's stream to our
  capture node, as venmic does for Discord on Linux: a sink's monitor would carry the call.
- **A new screen share replaces the current one** rather than being refused: switching who
  presents takes one click, and the previous sharer's client stops by itself when the SFU
  revokes its screen source.
- **Original sounds generated from code** (`scripts/sounds`): no sample, no licence to
  track; the ringtone ("Neon Drive") was chosen by ear among four candidates.
- **The desktop sidecar plays and captures the sound itself (cpal), not libwebrtc's device
  module.** That module feeds the microphone to WebRTC and plays the room without a hook:
  no person's volume, no mute for oneself, no input volume, no meter, no third-party noise
  remover. Owning the path costs the echo canceller's reference, which the sidecar now
  hands to WebRTC's audio processing module itself (its own mix). On Linux cpal speaks
  PulseAudio's protocol in pure Rust (PipeWire serves it): its PipeWire host would link
  libpipewire, which libwebrtc's stubs shadow (see `rv-screen-audio`).
- **RNNoise for noise removal, the same port on both apps.** `nnnoiseless` is Rust, BSD,
  with its model built in; WebRTC's own suppression is gentler, and Krisp needs LiveKit
  Cloud. It runs after the echo canceller on desktop; on Android it runs on the captured
  buffer, after the phone's own echo cancellation. Android reaches it through three JNI
  functions in `crates/rv-voice-mobile`, built like the crypto library, rather than a
  bindings generator for so little.
- **Who speaks is told from the sound on the client.** LiveKit's active speakers come from
  the SFU with a fixed threshold and miss a whisper; each client already holds every track,
  so it reads levels itself (RNNoise's voice probability for its own microphone).
- **A direct call ends for both** when one leaves, after a 2 s grace that rides out a
  reconnection or a device switch: two people in a call, alone it is over.

## Repository and process

- **One monorepo, one version per app.** `apps/mobile/app.json` (plus `package.json` and `versionCode` = major×10000 + minor×100 + patch) and `apps/desktop/Cargo.toml`, checked by `scripts/version.mjs`. CI checks an app only when its files change and builds packages only on a `mobile-vX.Y.Z` / `desktop-vX.Y.Z` tag or a manual run; the release notes are the version's changelog section, which is mandatory. See [operations](operations.md).
- **Layered branches merged into `master`.** Commits are prefixed with the branch name and layered (fix, then test, then changelog), merged with a `merge <branch>: <summary>` commit, as `git log` shows.
- **Prove by running.** `npx tsc --noEmit` and a real launch; fixes are proven by removal (the test must fail without the fix). An assertion that passes without any side-effect output is an empty test. See [testing](architecture/testing.md).
- **No secrets in the repo**; `.example` files document them. `apps/mobile/docs/AUDIT.md` is frozen; `apps/mobile/WORKSTREAMS.md` is the source of truth for what to fix next.
- **The code is English; stored names were migrated rather than kept.** Code, comments, docs and both apps now share one vocabulary, so a name in the brain, the mobile code and the desktop code means the same thing and needs no French glossary. Names the mobile app persisted were renamed too, not frozen: migration `apps/mobile/db/migrations/0016_english_names.sql` renames tables and columns in place and rewrites stored values, and `readMovedKey` / `readMovedKeySync` (`apps/mobile/lib/storageKeys.ts`) move each SecureStore key on first read (new key written before the old is deleted), so an upgrade keeps sessions, the local data, the language and pending sends and sign-outs. Names the previous build may still hold outside the app's control keep a one-release alias: old `rocketvibe://salon/` links (posted notifications) are rewritten or accepted, and the native `ReponseNotifReceiver` / `RattrapagePushWorker` classes, the `rv_reponse` reply key and the `rattrapage-push-` work prefix survive for notifications and WorkManager jobs already posted. The legacy names are listed in [glossary](glossary.md#legacy-french-names).


## Web scope, 2026-10-08

The user chose a true server-delivered browser client, on its own branch/worktree, using GTK as the visual reference. The browser signs into only the serving service and one account: no account/server rail. The temporary encryption exclusion was superseded on 2026-10-09 by a request for usable browser E2EE. It reuses the shared Rust MLS engine in a dedicated WASM worker; the server is never given private plaintext or keys. Browser profile storage has no independent native-keyring anti-rollback anchor. Its delivered-code trust boundary and remaining qualification are recorded in `docs/WEB_E2EE.md`. Installed clients retain their existing capabilities.

Sources: apps/web/src/app.ts; apps/web/src/api.ts; docs/rfcs/0005-web-client.md.

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
- `docs/protocol/ADMINISTRATION.md`
- `apps/mobile/lib/emojiUsage.ts`
- `apps/desktop/crates/rv-core/src/emoji_usage.rs`
- `apps/desktop/crates/rv-gtk/src/sidebar_dialog.rs`
- `apps/desktop/crates/rv-gtk/src/widgets.rs`
- `apps/desktop/macos/Sources/RocketVibe/RocketVibeApp.swift`
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
- `apps/mobile/ui/alerts.ts`
- `apps/desktop/macos/Sources/RocketVibe/Modals.swift`
