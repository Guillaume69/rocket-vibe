# Decisions

The non-obvious choices behind rocket-vibe and why they were made, grouped by area. Each entry gives the decision, the reason, and the brain doc that describes how it is implemented. Where the original rationale (in `ROADMAP.md`, `CLAUDE.md`, `apps/mobile/CHANTIERS.md`) has since been overtaken by the code, the entry says what the code does now.

## Product scope

- **A personal, faster and more reliable client for a self-hosted Rocket.Chat 8.x, not a general product.** The target is `chat.barrut.me` (8.5 LTS), administered by the author. Being admin is what makes direct push feasible. The local test server is pinned to 8.5.1 to match it. See [overview](architecture/overview.md), [rocket-chat](architecture/rocket-chat.md).
- **Android first, distributed by sideload.** No Play Store, no review, no trademark risk; an APK built locally is installed with `adb`. iOS was kept platform-agnostic and is now prepared through the same config plugins, but has never been built with Xcode (`docs/PUSH.md`). See [mobile-native](architecture/mobile-native.md).
- **Deliberately out of scope:** server administration, omnichannel/livechat, interactive UiKit blocks (unknown `blocks` are ignored, `attachments` and `md` are rendered), OTR (removed in 8.0), OTA updates. These are recorded debts, to prevent scope drift.
- **E2EE: first "degrade cleanly", then implemented.** The roadmap ruled it out because only 1 room out of 25 is encrypted on the target server and the crypto would take weeks. The degraded behaviour came first (lock icon, hidden preview, placeholder, composer disabled, generic notification), and is still the fallback while locked. The code now decrypts, encrypts messages and encrypts files (`apps/mobile/lib/e2e/`, `apps/desktop/crates/rv-core/src/e2e.rs`). See [e2ee](architecture/e2ee.md), [features/e2ee](features/e2ee.md).
- **Calls: first excluded, then shipped through Jitsi.** The roadmap avoided `@rocket.chat/media-signaling`. Calls now use the server's configured video conference (Jitsi) through `video-conference.join`, acting over REST like everything else. See [calls](features/calls.md).
- **Several servers and accounts side by side.** Tokens and SQLite databases are isolated per (server, account), so signing out of one never touches another. See [login-and-servers](features/login-and-servers.md).
- **A provider façade for a second backend.** Everything that names a Rocket.Chat endpoint or stream is meant to go through `Fournisseur` (provider) so a Mattermost (kChat) driver can be added; today only `rocketchat` exists. See [mobile-app](architecture/mobile-app.md).

## Mobile platform constraints

- **Native components by default, in three tiers.** Tier 0 is pure React Native primitives; tier 1 is native bindings that expose an OS capability without imposing a look (`react-native-screens`, safe area, `expo-image`, gesture handler, haptics); tier 2 is a short list of argued exceptions: `@shopify/flash-list` (native view recycling for thousands of messages), `react-native-keyboard-controller` (frame-synced composer, since `KeyboardAvoidingView` is poor on Android), `@rocket.chat/message-parser` (MIT, pure JS, no UI), `react-native-webview` (calls only). Any new UI dependency is justified in its commit against `ROADMAP.md` §4.2. See [stack](stack.md), [mobile-app](architecture/mobile-app.md).
- **Banned outright:** UI kits (NativeBase, Tamagui, gluestack, RN Paper), `react-native-markdown-display`, `react-native-render-html`, `@gorhom/bottom-sheet` (a JS reimplementation of a component the platform has). Bottom sheets are native, `presentation: 'formSheet'` from `react-native-screens` through expo-router. Markdown is rendered from the server's AST into nested `<Text>` (`apps/mobile/ui/markdown.tsx`).
- **One WebView, bounded: the call screen.** The native Jitsi SDK targets RN ~0.79 and bundles `react-native-webrtc`, a fragile bet against RN 0.86. `apps/mobile/app/appel/[callId].tsx` is the only route with a WebView, locked on the origin the server designated (`apps/mobile/lib/origine.ts`), because the app holds camera and microphone during the call and Android cannot arbitrate those per origin. Video link previews stay native cards (`apps/mobile/ui/carteEmbed.tsx`). See [calls](features/calls.md).
- **No EAS, ever, for Android.** Builds are `expo prebuild` + `./gradlew`, locally and on CI. See [operations](operations.md).
- **Continuous Native Generation.** `android/` and `ios/` are gitignored; every native customisation is a config plugin in `apps/mobile/plugins/` or a local module in `apps/mobile/modules/`, because SDK 57's `expo prebuild` wipes and regenerates by default. A native change needs a dev-client rebuild, not a Metro reload. See [mobile-native](architecture/mobile-native.md).
- **Native modules over pure-JS polyfills for heavy work.** E2EE goes through `react-native-quick-crypto` (Nitro, OpenSSL, `node:crypto` API): `apps/mobile/lib/e2e/crypto.ts` imports `crypto`/`buffer`, `apps/mobile/metro.config.js` aliases them to quick-crypto on device, and the same imports resolve to `node:crypto` under Node tests. `expo-crypto` has no RSA. Since tests never run quick-crypto itself, `apps/mobile/lib/e2e/surfaceQuickCrypto.ts` pins the API surface by types. See [e2ee](architecture/e2ee.md).
- **New Architecture is not a safety net.** Mandatory since RN 0.82; `newArchEnabled=false` does nothing.
- **`react-native-reanimated` is accepted, not fought.** It costs RAM, but `expo-router` depends on it directly; dropping it would mean dropping expo-router.
- **Drafts in SQLite, not MMKV.** The roadmap planned MMKV; drafts are debounced (400 ms), so async latency is irrelevant, and a native dependency (full rebuild) was not worth it when the database already holds all local state (`brouillons` table, `apps/mobile/ui/brouillons.ts`). See [composer](features/composer.md).
- **i18n catalogue typed against French.** `fr` defines the keys; `en` is `Record<CleTraduction, string>`, so `tsc` rejects a missing or extra key. See [i18n](architecture/i18n.md).

## Data model

- **Local SQLite is the source of truth; the UI is a projection.** WebSocket and REST write upserts; screens observe through live queries; the real-time flow is never kept in an in-memory store. This is the direct remedy to the official app's stacked subscriptions, duplicated messages and frozen sends. See [mobile-data](architecture/mobile-data.md), [offline-and-sync](features/offline-and-sync.md).
- **One database per server and per account** (`apps/mobile/db/nomFichier.ts`): rooms, previews and unread counts are account data.
- **The SQL lives in `apps/mobile/db/upserts.ts` only**, executed as-is by the tests on `node:sqlite`, instead of Drizzle's builder, so the tests exercise the exact query the app sends.
- **One write queue per SQLite connection** (`apps/mobile/db/fileEcritures.ts`): transactions are per connection and not reentrant, and a write issued during an open `BEGIN` is absorbed into it and silently rolled back if the batch fails. Found as the most dangerous race of the audit (chantier 2).
- **Volatile things stay volatile.** Presence, typing, server notes and search or pinned/starred results are kept in memory or rendered from the response, never written to SQLite: stale presence from a cache is worse than none.
- **Retention: 500 messages per room** (`MESSAGES_GARDES_PAR_SALON`), purged with a partitioned `DELETE`, sparing optimistic rows and thread roots.
- **The database is not deleted at sign-out.** Deleting it hot broke migrations (memoised per file name), could not wait for in-flight writes, and raced the 30 s sign-out. Decrypted E2EE plaintext is hidden by an `UPDATE` instead; `PRAGMA secure_delete` is an open question (chantier 9).

## Protocol

- **REST to act, DDP to listen.** DDP method calls are deprecated in 8.0 and removed in 9.0. `login` is the only method still called, because a `sub` without an authenticated socket gets `nosub`. See [rocket-chat](architecture/rocket-chat.md), [mobile-transport](architecture/mobile-transport.md).
- **Our own DDP client, written from the spec.** `@rocket.chat/ddp-client` is good but ships without a `license` field and with an Enterprise Edition `LICENSE`; "probably MIT" is not a basis. Its code is not copied. Listening only, the client needs `connect`, `login`, `sub`, `unsub` and event routing.
- **Catch-up in two stages.** `rooms.get` + `subscriptions.get` with `updatedSince` cover every room in two requests; `chat.syncMessages`, one room per call, slow and rate-limited at 10 calls/min, runs only for the displayed room. See [offline-and-sync](features/offline-and-sync.md).
- **Hook-up reads twice on purpose.** `raccorder` reads before and after arming subscriptions; the second read guarantees nothing falls between the read and the subscription. Making it conditional was rejected ("À ne pas toucher" in `CHANTIERS.md`).
- **Mobile: no `__my_messages__`, a hot-room LRU instead.** Subscribing to the all-rooms key would replace `apps/mobile/ui/salonChaud.ts`, but at the cost of receiving all 25 rooms' traffic continuously (battery, data). The mobile keeps up to 3 recently left rooms subscribed so re-entering skips a 3-4 s `syncMessages`. **The desktop chose the other way:** `rv-core` subscribes to `__my_messages__` at session start and keeps deletions per open room. See [offline-and-sync](features/offline-and-sync.md), [desktop-core](architecture/desktop-core.md).
- **Text outbox with a client-side `_id`.** 24 hex chars generated before display; the server refuses a second message with the same `_id`. A replay answers 400, not success, so the client confirms with `chat.getMessage` before declaring failure (`apps/mobile/lib/envoi.ts`).
- **Upload dedup is entirely local.** Replaying `rooms.mediaConfirm` either posts a duplicate while answering 200 with the first message, or answers `[invalid-file]` for a delivered file: no server answer is usable. The `file_id` from `rooms.media` is persisted (`televersements.file_id`); before confirming again, the client asks SQLite, and when SQLite is silent, refreshes that one room (`rafraichirSalon`). A client `_id` cannot be passed: the schema is `additionalProperties: false`. Failed uploads are not retried automatically. See [uploads](features/uploads.md).
- **Only a 401 signs out, and only a trusted one.** On 8.5, 401 means "not authenticated" and nothing else (403 permissions, 400 kicked, 400 `totp-invalid`). The hook also requires a Rocket.Chat envelope marker (`success`, `status`, `errorType`), because a reverse proxy answers 401 too, and skips anonymous calls, because `/api/v1/login` maps every failure to 401. No whitelist on the error text: a server rewording would silently bring back the zombie state. See [mobile-transport](architecture/mobile-transport.md), [login-and-servers](features/login-and-servers.md).
- **Optimistic session resume.** The stored session is trusted at start and validated in the background; an unreachable server is not a reason to drop a session.
- **Reconnection: jittered backoff, suspended in background, reset on foreground.** No socket is reopened in the background; coming back resets the backoff (measured 59 ms instead of a 22.7 s armed timer). 429s get a dispersed sleep but no per-route queue: the window is per minute, so only not emitting calls helps.
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
- **`rv-native` for system integration GLib lacks:** clickable toasts and badges on Windows, `UNUserNotificationCenter` on macOS, tray, single instance, start at login.

## Repository and process

- **One monorepo, one version per app.** `apps/mobile/app.json` (plus `package.json` and `versionCode` = major×10000 + minor×100 + patch) and `apps/desktop/Cargo.toml`, checked by `scripts/version.mjs`. CI checks an app only when its files change and builds packages only on a `mobile-vX.Y.Z` / `desktop-vX.Y.Z` tag or a manual run; the release notes are the version's changelog section, which is mandatory. See [operations](operations.md).
- **Layered branches merged into `master`.** Commits are prefixed with the branch name and layered (fix, then test, then changelog), merged with a `merge <branch>: <summary>` commit, as `git log` shows.
- **Prove by running.** `npx tsc --noEmit` and a real launch; fixes are proven by removal (the test must fail without the fix). An assertion that passes without any side-effect output is an empty test. See [testing](architecture/testing.md).
- **No secrets in the repo**; `.example` files document them. `apps/mobile/docs/AUDIT.md` is frozen; `apps/mobile/CHANTIERS.md` is the source of truth for what to fix next.

## Sources

- `ROADMAP.md`
- `CLAUDE.md`
- `README.md`
- `apps/mobile/CHANTIERS.md`
- `apps/mobile/docs/AUDIT.md`
- `docs/PUSH.md`
- `apps/desktop/README.md`
- `apps/desktop/docs/MACOS-SWIFTUI.md`
- `apps/desktop/docs/PARITY.md`
- `apps/mobile/package.json`
- `apps/mobile/metro.config.js`
- `apps/mobile/db/schema.ts`
- `apps/mobile/db/fileEcritures.ts`
- `apps/mobile/db/depot.ts`
- `apps/mobile/lib/rest.ts`
- `apps/mobile/lib/ddp.ts`
- `apps/mobile/lib/raccordement.ts`
- `apps/mobile/lib/envoi.ts`
- `apps/mobile/lib/envoiFichiers.ts`
- `apps/mobile/lib/e2e/crypto.ts`
- `apps/mobile/ui/salonChaud.ts`
- `apps/mobile/ui/brouillons.ts`
- `apps/mobile/app/appel/[callId].tsx`
- `apps/mobile/plugins/with-fcm-deeplink.js`
- `docker/patch-push.mjs`
- `apps/desktop/crates/rv-core/src/sync.rs`
- `apps/desktop/crates/rv-core/src/session.rs`
- `apps/desktop/crates/rv-core/src/call.rs`
- `apps/desktop/crates/rv-gtk/src/macos.rs`
- `apps/desktop/crates/rv-native/src/lib.rs`
- `scripts/version.mjs`
