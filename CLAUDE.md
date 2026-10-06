# rocket-vibe: standing instructions

Third-party **Rocket.Chat** clients, in a monorepo. This file is reloaded every session. It holds what is expensive to rediscover.

- `apps/mobile/`: the mobile app, Android first, in Expo / React Native. **Its commands (`npm`, `npx`) run from `apps/mobile/`.**
- `apps/desktop/`: the desktop app, in Rust (UI-free core `rv-core`, GTK 4 + libadwaita interface `rv-gtk`). **Every build runs in the Fedora container of `apps/desktop/docker/`** through `apps/desktop/scripts/build.sh` (fmt, clippy `-D warnings`, tests); `scripts/smoke.sh` and `scripts/e2e*.sh` run it under Xvfb against the test server. Its parity with mobile: see "Parity" below.
- `docker/`, `scripts/`: the test Rocket.Chat server and its data, shared by the apps.
- **One version per app**: `apps/mobile/app.json` (with `package.json` and `android.versionCode` = major×10000 + minor×100 + patch) and `apps/desktop/Cargo.toml`; `node scripts/version.mjs mobile|desktop` reads and checks them. CI (`.github/workflows/`) checks an app only when its files change, and builds its packages (APK, archives, installers) only on a tag or a `workflow_dispatch`; a `mobile-vX.Y.Z` / `desktop-vX.Y.Z` tag publishes the release, with the version's section of `apps/<app>/CHANGELOG.md` as notes (Keep a Changelog, required: `node scripts/changelog.mjs`). Every visible change to an app goes into its "Unreleased" section, in English.

- `ROADMAP.md`: the decisions and their justification. Rarely moves.
- `apps/mobile/WORKSTREAMS.md`: the debt found by the 2026-07-25 audit, ticked off as it goes. **Source of truth for "what do we fix next".**
- `apps/mobile/EXECUTION.md`: the product CONSTRUCTION checklist, brought back in line with the code on 2026-07-31 (workstream 16): construction is frozen there, and its "After the checklist" section summarises what shipped continuously since.
- `apps/mobile/docs/AUDIT.md`: the dated audit record: mechanism, failure scenario and fix of each finding. Content-frozen, no longer edited.
- `docs/DEV.md`: the environment and the survey of the target server.
- `brain/`: the knowledge base, see "The brain" below.

## The brain (knowledge base)

`brain/` describes how both apps work (architecture, features on the mobile and desktop sides, the Rocket.Chat contract, decisions, glossary of the project vocabulary), so that a developer or an AI understands them **without reading the source**. Entry point: `brain/BRAIN.md`, which leads to the indexes `brain/architecture/index.md` and `brain/features/index.md`, then to the pages. Read it before searching where something lives, and navigate by the indexes rather than by grepping the whole tree. The `brain` skill carries the procedure.

- It is load-bearing: it must stay TRUE. A change that makes a page wrong fixes the page in the same branch (a `docs(brain): …` layer after the behaviour and its tests).
- The code is the source of truth. If the brain contradicts it, fix the brain.
- New feature → `brain/features/<name>.md` (`## Mobile` and `## Desktop` sections), a line in `brain/features/index.md` and in the catalogue of `brain/BRAIN.md`, its rows in `brain/parity.md`. New subsystem → a `brain/architecture/*.md`.
- The why goes into `brain/decisions.md`, new terms into `brain/glossary.md`. Probed server facts stay here first ("Rocket.Chat facts"); `brain/architecture/rocket-chat.md` points to them.
- In English, dense, no em-dash, source paths rather than copied code; each page ends with `## Sources`.

## Parity

The three apps (Android, GTK, SwiftUI) aim at the same features, and none is the reference: what one app does first, the others owe. `brain/parity.md` keeps the count, row by row, with each app's status (`done`, `partial`, `missing`, `mapped`, `n/a`) and each one's debt.

- Every visible feature reaches all three apps, or its row in `brain/parity.md` says which app owes it (`missing` or `partial`, with what is missing). One or the other, never nothing.
- The row moves in the same branch as the change that moves it (a `docs(brain): …` layer), both ways: an app that catches up sets its cell to `done`, a new feature adds its row with the status of all three.
- `mapped` only when the platform meets the same need another way (Android sharing versus desktop drag and drop), and the note says how. An unintended difference in behaviour is debt, not `mapped`.
- The status is checked in the code of the three apps, not in the changelog or in memory.

## The work loop

**Acceptable base version reached (July 2026): the per-step ceremony is lifted.** We now work light:

1. Implement.
2. Keep the reflex of checking that it holds (`npx tsc --noEmit` in `apps/mobile/` and a real launch when the change touches code), but it is no longer a formal exit criterion that blocks.
3. Commit (conventional message) and `git push origin master`. Once per clone, `git config core.hooksPath .githooks`: the pre-commit hook regenerates the Rocket.Chat inventory CI checks (`docs/DEV.md`).

- **No more systematic `/code-review`.** Review only runs on explicit request.
- No more obligation of a ticked/dated box in `apps/mobile/EXECUTION.md` nor of an `Étape: N.M` trailer (the keyword the history carries). `EXECUTION.md` can still be updated when it clarifies the state, but it is no longer mandatory.

Main branch: **`master`**. Direct commits, no PR.

> Why "prove it by running it" remains a good reflex even without enforcing it: it has already caught a broken `env.sh` I thought was tested, and a `docker compose` that created an admin account **with no password** on a server exposed to the LAN. Rereading code never run is rereading an intention.

## The shell is zsh: three silent-failure traps

1. **A glob with no match is fatal.** `for d in /usr/lib/jvm/*17*` aborts the whole loop if the pattern matches nothing, other candidates included. An unquoted `?` in a URL too: always `curl "…/settings.public?count=0"`. Pass patterns to `find -name "…"`, never to the shell.
2. **An unquoted variable is not word-split.** `for id in $IDS` iterates **once** with the whole string. `$(…)` is split. To loop over a list: `bash -s <<'BASH'`.
3. **A pipe hides the exit code.** `./gradlew … | tail` returns `tail`'s status (0), not the build's. It happened: a failed `assembleRelease` reported as "successful", a nonexistent APK installed on trust. For a build: redirect to a file and test `$?`, or `set -o pipefail`.

Distrust an assertion that passes while no side-effect line was printed: that is an empty test, not a green test.

## Environment

```sh
source apps/mobile/scripts/env.sh     # JAVA_HOME, ANDROID_HOME, PATH, ROOT_URL
cd docker && docker compose up -d     # Rocket.Chat 8.5.1 + MongoDB 8.0 (replica set rs0)
node scripts/seed.mjs                 # test data, idempotent
```

- Linux, Node 24, **Temurin JDK 17.0.19** (enough: RN 0.86 pins `sourceCompatibility 17`, Gradle 9.3.1 accepts 17→24). **JDK 21 not required.**
- Full Android SDK: build-tools 36.0.0, `platforms/android-36`, NDK 27.1.12297006, exactly what the RN 0.86 template requires.
- AVD `duogo_test` (Pixel 7, android-36, `google_apis` image: **Google Play Services are there**, so FCM works on it).
- **No physical phone connected.** The binary criterion of the push *kill gate* (step 2.5b) requires one.
- Android builds **100 % local**: `expo prebuild` + `./gradlew`. **Never EAS.** iOS later, on a Mac.

## Non-negotiable constraints

- **Native components by default.** Firmly forbidden: any UI kit (NativeBase, Tamagui, gluestack, RN Paper), any **WebView** (one single bounded exception: the Jitsi call screen, `apps/mobile/app/call/[callId].tsx`, locked origin, recorded in `ROADMAP.md` §4.2), `react-native-markdown-display`, and **`@gorhom/bottom-sheet`**: bottom sheets are native through `react-native-screens` (`presentation: 'formSheet'`). Every UI dependency is justified in its commit, against `ROADMAP.md` §4.2.
- **Native modules by default, no pure-JS polyfill.** For any heavy computation (crypto, compression, image), prefer a native module (JSI/Nitro) to a pure-JS implementation. E2EE goes through `react-native-quick-crypto` (native OpenSSL `node:crypto` API): `apps/mobile/lib/e2e/crypto.ts` imports `crypto`/`buffer`, Metro aliases them to quick-crypto (`apps/mobile/metro.config.js`), the same imports resolving to `node:crypto` under the Node tests. A native module requires a **dev-client rebuild** (`expo prebuild` + `./gradlew`); a simple Metro reload is not enough.
- `android/` and `ios/` are **gitignored** (CNG). Every native customisation goes through a config plugin: in SDK 57, `expo prebuild` wipes and regenerates by default.
- **No secret in the repo.** `.env`, `.env.local`, `google-services.json`, service-account JSON. `.example` files document them.
- Strict TypeScript, zero implicit `any`. `npx tsc --noEmit` is part of every `[code]` exit criterion.
- **New Architecture mandatory** since RN 0.82: `newArchEnabled=false` no longer has any effect. Do not present it as a safety net.

## Rocket.Chat facts a summary must not lose

Target server: `https://chat.barrut.me`, **version 8.5** (LTS). The local Docker is pinned to it, not to 8.6.

- **`POST /api/v1/rooms.upload` was REMOVED in 8.0.0.** Upload happens in two steps: `rooms.media/:rid` then `rooms.mediaConfirm/:rid/:fileId`. `rooms.media` alone posts no message; forgetting the second step leaves an orphaned file.
- **Replaying `rooms.mediaConfirm` on the same `fileId` is UNDEFINED, and both outcomes are bad** (probed on the 8.5 bench, 2026-07-29, twice, opposite results):
  - **immediate replay** → the server posts a SECOND message (the history does carry two) but answers **200 returning the FIRST**, caption included. A client trusting the response believes in an idempotent confirmation while it has just created a duplicate;
  - **delayed replay** (a few minutes) → **`[invalid-file]`**, a clean refusal. Treated as an ordinary failure, it shows "not sent" on a file that was in fact delivered.

  So there is NO usable server answer: deduplication must be entirely local, on the persisted `file_id` (`uploads.file_id`, workstream 7), and the client must make sure its database KNOWS before deciding, hence the targeted room catch-up when it is silent. And since `mediaConfirm` refuses any extra key (`additionalProperties: false`), a client `_id` is ruled out.
- **DDP method calls are deprecated** (8.0), removal in 9.0. **REST to act, DDP to listen.** Our home-made DDP client only needs `connect`, `login`, `sub`, `unsub` and event routing. No `call`.
- **An out-of-sequence DDP message gets `msg: 'error'`, NEVER the expected answer** (probed on 8.5.1 for `ping`, `sub` and `method`): `{"msg":"error","reason":"Must connect first","offendingMessage":{"msg":"ping","id":"v1"}}`. `offendingMessage` **carries the offending `id`**, so the right pending call can be rejected; without that case it hangs until its timeout and its failure is blamed on the socket (that is what made the premature liveness probe destructive, workstream 8). On the other hand the **`connected`** state (handshake done, `login` not answered yet) **does answer a `pong`**: it can be probed.
- **A 401 means "not authenticated", and NOTHING ELSE** (probed on 8.5.1, 2026-07-30). That is what allows an automatic logout on 401 without wrongly ejecting the user. Everything else uses other statuses: **missing permission → 403** (`error-unauthorized`); **excluded from the room or nonexistent room → 400** (`error-not-allowed`, `error-room-not-found`); **2FA required → 400** (`totp-required`); **wrong 2FA code → 400** (`totp-invalid`, not 401, otherwise a typo would destroy the session). Exact body for a revoked token: `{"success":false,"error":"You must be logged in to do this.","status":"error"}`.
  - **Exception: `/api/v1/login` maps ALL its failures to 401**, with a perfect Rocket.Chat envelope and the same `error: "Unauthorized"`: bogus resume token, empty body, nonexistent user, wrong password are indistinguishable. A client that revokes on 401 MUST therefore leave out anonymous calls (login, but also `resumeSession`, whose token travels in the body), otherwise a failed entry wipes the current session.
  - **"JSON" does not prove "Rocket.Chat"**: a reverse proxy or a gateway readily answers `401 {"message":"Unauthorized"}` or HTML. Require a mark of the envelope (`success`, `status`, `errorType`) before believing the status: see `understoodResponse` in `apps/mobile/lib/rest.ts`.
- **Three internal expo shapes the native push path depends on** (read in expo's code, never guessed; they carry no API guarantee):
  - `Notifications.dismissNotificationAsync` accepts the identifier `expo-notifications://foreign_notifications?[tag=…&]id=<integer>`, which `ExpoPresentationDelegate.parseNotificationIdentifier` translates into `NotificationManagerCompat.cancel(tag, id)`. It is the ONLY bridge to remove from JS a notification posted by our Kotlin, whose id is `rid.hashCode()`, with no tag (`apps/mobile/lib/notificationId.ts`);
  - expo-secure-store stores its entries in the `SecureStore` SharedPreferences under the key `"<keychainService>-<key>"`, `keychainService` being `key_v1` by default (`SecureStoreModule.createKeychainAwareKey`): native code therefore reads `key_v1-preferred-language` (then the pre-0016 `key_v1-langue-preferee`) the same way it reads `key_v1-session-<digest>`;
  - expo-router MERGES a deep link's query params into the route params (`getStateFromPath-forks.parseQueryParams`): `rocketvibe://room/<rid>?host=…` arrives as is in `useLocalSearchParams`. That is what carries the multi-server deep link (an old `salon/` link is rewritten by `app/+native-intent.tsx`).
- **Unauthenticated `GET /api/info` returns the MINOR version only** (`{"version":"8.5", …, "success":true}` on an 8.5.1 server), in a body of about 15 KB most of which is a `supportedVersions` JWT. It lives **outside `/api/v1/`**: `RestClient` reaches it through the `outsideApiV1` option, which gives it the maximum timeout; otherwise a hanging request blocks the login screen forever.
- `@rocket.chat/ddp-client` is technically perfect but ships **without a `license` field**, with an Enterprise Edition `LICENSE`. We write our own, from the DDP spec. **Do not copy its code.** `@rocket.chat/message-parser` is MIT.
- `MONGO_OPLOG_URL` **no longer exists** since 8.0.0 (change streams). The replica set remains mandatory.
- **Push**: the official gateway only routes to the official app ids. On a stock server bundle, `Push_enable_gateway=false` is required (the choice is global: the official apps then lose their push); the bundle patched by `docker/patch-push.mjs` routes by `appName` and lets the gateway stay `true`, a path not yet verified on `chat.barrut.me` (`docs/PUSH.md`). In both cases, the JSON of a Firebase service account goes into `Push_google_api_credentials`. Rocket.Chat speaks **FCM HTTP v1** only (`Push_UseLegacy` survives in 8.5 as a hidden setting nothing reads, see `docs/PUSH.md`). The target workspace **is registered with RC Cloud** (`cloudWorkspaceId` present).
- **Push spike trap**: Rocket.Chat notifies **only offline users**, and by default **only on DM or mention**. An ordinary channel message triggers nothing, whatever the configuration.
- **Typing indicator**: `stream-notify-room/<rid>/user-activity`. Not `/typing`, which is deprecated.
- `chat.syncMessages` handles **one room at a time** and REST is rate-limited (**10 calls/min**, measured: the 11th answers 429 and our client sleeps until the reset, capped at 30 s). Do not loop over all rooms on reconnect. Cursor mode requires `type`: `UPDATED` and `DELETED` are **two requests**, the server refuses to combine them (`error-param-required`).
- **`chat.syncMessages?type=UPDATED` is SLOW on a big room**: 3 to 4 s measured on `chat.barrut.me` to answer "nothing new" (0 documents), against 22 ms on the bench with 3,000 messages. The index is `{rid, ts, _updatedAt}`: filtering on `_updatedAt` alone forces the server to sort the whole room. Nothing on the client side speeds it up; the only way out is not to call it (see `apps/mobile/ui/hotRooms.ts`).
- **`channels.history` with `oldest` answers the NEWEST `count` messages of `[oldest, latest]`, not the first ones after `oldest`** (probed on 8.5.1, 2026-10-05), and `channels.messages` ignores `query` (`sort` and `offset` still apply). No REST call reads forward from an instant: to read on from an old message, size the range so it comes back with less than a page, never trust a full one (`apps/desktop/crates/rv-core/src/context.rs`, `apps/mobile/lib/contextWindow.ts`).
- **One stream covers ALL rooms: `stream-room-messages` with the key `__my_messages__`** (checked on the 8.5 bench, and present in the server bundle as in the types of `@rocket.chat/ddp-client`). That is what the official app does. It delivers **new messages AND edits** (`editedAt`) of all the user's rooms, without opening any of them, but **not deletions**, which stay on `stream-notify-room/<rid>/deleteMessage`, one subscription PER room. The desktop subscribes to it (`MY_MESSAGES`, `apps/desktop/crates/rv-core/src/session.rs`). On mobile, a lead not taken so far: it would replace the LRU of `apps/mobile/ui/hotRooms.ts` with one line in `initialSubscriptions`, at the price of receiving the traffic of the 25 rooms continuously (battery, data).
- **Replaying a client `_id` already accepted by `chat.sendMessage` answers 400** (`Cannot read properties of undefined (reading 'starred')`), not an idempotent success, checked on 8.5. No duplicate is created, but the answer does not tell "already delivered" from "refused": confirm with `chat.getMessage` before declaring failure (see `apps/mobile/lib/outbox.ts`).
- **Avatars: the URL only moves if we move it.** `/avatar/<username>` answers `Cache-Control: public, max-age=3600` and **no HTTP `ETag`** (probed on 8.5); Android's image cache (Fresco) therefore freezes the URI for life. The photo's version lives in `avatarETag`, which must be added AS A QUERY (the server ignores the parameter), otherwise a changed photo never shows. Sources, by freshness: `stream-notify-logged` / **`updateAvatar`** → `args: [{username, etag}]` for a user (never the uid!), `[{rid, etag}]` for a room; `me` (at connection setup, carries `avatarETag`); `users.info` and the Rooms document (`avatarETag`, ABSENT when there is no photo: never overwrite it with null). On DELETION (`users.resetAvatar`), the event arrives **without an etag**: set a marker (`AVATAR_NO_PHOTO`), otherwise the URL falls back to its earlier form, the one the cache serves with the old photo.
- **`/file-upload/…` answers without `Content-Length`** (chunked transfer, seen on `chat.barrut.me` on 2026-09-23): a download progress has no total on the response side. The size is in the message's attachment: `size` (file), `image_size`, `video_size`, `audio_size` (read in the 8.5 send code). See `downloadedFraction` in `apps/mobile/lib/attachment.ts`.
- **A `name` (display name) change is NOT broadcast**: neither `Users:NameChanged` nor `rooms-changed` on 8.5 (probed). Only the avatar and the username propagate live.

### The target server, surveyed without authentication

2FA **enabled, TOTP only** (no email), password fallback enforced. **No OAuth, SAML, CAS or LDAP** → no SSO workstream.
`FileUpload_ProtectFiles = true` **and** `Accounts_AvatarBlockUnauthenticatedAccess = true` → files *and* avatars require `rc_uid`/`rc_token`.
`E2E_Enable = true`, `E2E_Allow_Unencrypted_Messages = false`, but **a single encrypted room out of 25** (`p:laprivitude`). Both apps read and write encrypted rooms, files included (`apps/mobile/lib/e2e/`, `apps/desktop/crates/rv-core/src/e2e.rs`), once the key is unlocked with the E2E password; before that, graceful degradation (`ROADMAP.md` §6.6), because the server **rejects** a plaintext message in an encrypted room (`error-not-allowed`). Neither encrypted-room creation nor key-pair creation.
**Push "hidden content" ACTIVE** (`Push_request_content_from_server`, Premium, default `true` on a licensed workspace, invisible in `settings.public`): each push carries only a `messageId`, **never the content**; the app fetches it with an authenticated `push.get` on receipt, with a WorkManager catch-up on failure (`apps/mobile/plugins/with-fcm-deeplink.js`). We **keep** this setting (user decision 2026-07-16: nothing at Google/Apple). `push.get` is subject to the default REST rate limit (10 req/min): a burst degrades to "New message" before the catch-up.
