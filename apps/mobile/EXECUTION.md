# EXECUTION - rocket-vibe

Checklist of the product's CONSTRUCTION. **`ROADMAP.md` says *why*; this document says *what was built, and how*.**

> **Document status (2026-07-31, workstream 16).** The checklist stops at 2026-07-11: once the acceptable
> base version was reached, the per-sub-step ceremony was lifted (`2ac7550`, recorded in
> `CLAUDE.md`) and development went continuous: implement, verify, commit. Everything
> shipped since is summarised in **"After the checklist"** (end of document); the detail
> lives in the git history. **For what gets fixed next, the source of truth is
> `WORKSTREAMS.md`**, the roadmap from the 2026-07-25 audit. The loop described below is
> the construction loop: it no longer applies as is.

---

## The loop, for each sub-step

It runs **in this order**, without skipping a rung.

1. **Read** the sub-step's exit criterion. It is executable: a command whose result settles it.
2. **Implement**, following the standing rules below.
3. **Prove**, the rung one is tempted to skip:
   - `[code]` sub-step → actually run the code (`/verify`, or direct execution and watching the output);
   - `[infra]` sub-step → run the proof command and read its output.
   Rereading code that never ran is rereading an intention.
4. **`/code-review`** on the uncommitted diff, for `[code]` sub-steps only.
5. **Fix** the findings kept. The ones dismissed are noted in the commit message, with the reason.
6. **Tick** the box and date it. The SHA does not go there: a commit cannot contain a SHA it does not have yet. The reverse link goes through the trailer: `git log --grep='Étape: 1.1'`.
7. **Single commit**: the code *and* the ticked box in the same commit. A history where the code exists but the box is empty is a history that lies.
8. **`git push`** to `master`.

### Commit convention

```
<type>(<scope>): <subject in the imperative>

<optional body: dismissed findings and why>

Étape: 1.2
```

`type` ∈ `feat`, `fix`, `build`, `chore`, `docs`, `test`, `refactor`.

### Legend

| Marker | Meaning |
|---|---|
| `@claude` | I do it alone. |
| `@guillaume` | Only you can do it (external account, hardware, secret). **Blocks me.** |
| `@duo` | You provide something, I take it from there. |
| `[code]` | Produces code → full loop with `/code-review`. |
| `[infra]` | Config, environment scripts → proof by command, no review. |
| `[doc]` | Documentation → no review. |

---

## Standing rules

- **No new dependency** unless it fits one of the tiers of `ROADMAP.md` §4.2. Any exception is justified in the commit message.
- Hard bans, as a reminder: UI kit, WebView, `react-native-markdown-display`, `@gorhom/bottom-sheet`. **A single, bounded WebView exception: the Jitsi call screen** (`app/call/[callId].tsx`, locked origin), recorded in `ROADMAP.md` §4.2.
- **Strict** TypeScript, zero implicit `any`. `npx tsc --noEmit` is part of every `[code]` exit criterion.
- `android/` and `ios/` are **gitignored** (CNG). Every native customisation goes through a config plugin. In SDK 57, `expo prebuild` wipes and regenerates by default: a manual edit would be lost.
- No secret in the repo. `google-services.json`, the Firebase service-account JSON and `.env` are gitignored. `.example` files document them.
- One commit ≈ one sub-step. Past ~300 diff lines, review loses precision: split.

---

## What blocks me, and only you can do

To prepare before step 2. Nothing else blocks me before that.

| # | What I need | Why |
|---|---|---|
| ~~B1~~ | ~~A physical Android phone~~: **provided**: Pixel 10 Pro, Android 16, `arm64-v8a`, Play Services present, seen by `adb` (`56211FDCH004E7`). A Pixel is the best case: no vendor overlay kills background services there, so a *kill gate* failure will be a real failure. | ✔ |
| ~~B2~~ | ~~Firebase project + `google-services.json`~~: **provided**: project `rocket-vibe`, `package_name: com.rocketvibe.app`. | ✔ |
| ~~B3~~ | ~~Service-account JSON key~~: **provided**: `rocket-vibe-firebase-adminsdk-*.json`, same project as `google-services.json` (the condition that avoids `SENDER_ID_MISMATCH`). | ✔ |
| B4 | On the phone: **Autostart enabled**, **battery optimisation disabled** for the app | The real factor of everyday push reliability, especially on MIUI/Samsung. |

> **The emulator covers a good part of the path.** The `duogo_test` AVD runs a `google_apis` image: `com.google.android.gms` is present (checked), and FCM needs **Google Play Services**, not the Play Store. So I can prove the whole Firebase → server → token → delivery chain alone. Only "app killed, twice in a row" needs B1.
>
> The Pixel 10 Pro is plugged in and seen by `adb`. I install nothing on it without consent: the chain is already proven on the emulator (`docs/PUSH.md`).

---

## Progress

| Step | Title | Status |
|---|---|---|
| 1 | Verifiable foundation | ✅ 2026-07-10 |
| 2 | Push spike: **kill gate** | ✅ PASS on emulator; 2.5b (Pixel) pending |
| 3 | Transport and data | ✅ 2026-07-10 (3.6 partial) |
| 4 | First vertical slice | ✅ 2026-07-10 (physical-phone gate pending) |
| 5 | Resilience and catch-up | ✅ 2026-07-10 |
| 6 | Integrated push | ✅ 2026-07-10 |
| 7 | Upload | ✅ 2026-07-10 |
| 8 | Offline-first and polish | ✅ 2026-07-11 |
| 9 | "Nuit Étoilée" theme | ✅ 2026-07-11 (9.4 shipped continuously, outside the checklist) |
| - | **After the checklist**: continuous development, then audit and workstreams | ✅ see the section at the end of the document, and `WORKSTREAMS.md` |
| 10 | iOS | ☐ |

---

## Step 1 - Verifiable foundation

> Goal: a home-built APK, built locally, that talks to a real Rocket.Chat server.
> No dependency on you. I can carry it end to end.
> Ref. `ROADMAP.md` §5 phase 0.

- [x] **1.1 - Build environment** · `@claude` · `[infra]`
  Write `scripts/env.sh` (exports `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `PATH`) and `docs/DEV.md`.
  **Exit criterion**: `source scripts/env.sh && java -version 2>&1 | grep -q '17\.0\.19' && adb devices`
  Done: **2026-07-09**. Green under zsh *and* bash. `ROOT_URL` resolved to `http://192.168.1.106:3000`.

- [x] **1.2 - Rocket.Chat server in Docker** · `@claude` · `[infra]`
  `docker/compose.yml`: Rocket.Chat **8.5.1** (the version of `chat.barrut.me`, LTS) + MongoDB **8.0** as **replica set `rs0`** (required: RC reads *change streams*). `ROOT_URL` on the **LAN IP**. `.env.example` versioned, `.env` at `chmod 600` and gitignored.
  **Exit criterion**: `curl -sf $ROOT_URL/api/info | node -e 'process.exit(JSON.parse(require("fs").readFileSync(0)).version.startsWith("8.5")?0:1)'`
  Done: **2026-07-09**. `version = 8.5`, replica set PRIMARY, admin login checked.

- [x] **1.3 - Test data seed** · `@claude` · `[code]`
  `scripts/seed.mjs`: two users, a public channel, a private group, a DM, 12 messages per room, a thread of 3 replies. **Idempotent even after a partial failure**: each message carries a `[seed i/n]` marker, only the missing ones are posted again.
  **Exit criterion**: `node scripts/seed.mjs` twice in a row, then `channels.list` contains `test-public`, with no duplicate.
  Done: **2026-07-10**. Checked on a blank database, then by deleting 2 messages and 1 reply: the rerun posts exactly what is missing.

- [x] **1.4 - Expo skeleton** · `@claude` · `[code]`
  Expo **SDK 57** (RN 0.86, React 19.2.3), `expo-router`, `expo-dev-client`, strict TypeScript, `expo lint`. Template `blank-typescript` rather than `default`: the latter imposes Reanimated and a demo screen. `applicationId = me.barrut.rocketvibe` (will have to match the Firebase `package_name`).
  **Exit criterion**: `npx tsc --noEmit` exits 0, and `expo lint` is clean.
  Done: **2026-07-10**. Both green. *Correction:* Reanimated **is** installed, `expo-router` depends on it directly. See `docs/DEV.md`.

- [x] **1.5 - First local APK** · `@claude` · `[infra]`
  `npx expo prebuild --platform android --clean`, then `./gradlew app:assembleDebug`, then install on the `duogo_test` AVD.
  **Exit criterion**: `./gradlew app:assembleDebug` exits 0; `adb install -r <apk>` succeeds; the app opens without crashing.
  Done: **2026-07-10**. `BUILD SUCCESSFUL in 3m 7s` (Gradle 9.3.1, JDK 17, New Arch + Hermes + edge-to-edge on by default). Universal APK of 248 MB, 4 ABIs. Launched on the AVD through the dev client's deep link: screen rendered, `logcat` free of fatal errors.
  > **Uncertainty #5** (`com.google.gms:google-services` × Gradle 9.3.1) **stays open**: the GMS plugin is not in the project yet. It will be settled at the first build of step 2.2.

- [x] **1.6 - "Server" screen** · `@claude` · `[code]`
  URL entry, `GET /api/info` and `GET /api/v1/settings.public` in parallel, display of the version, authentication methods, 2FA, E2EE and file protection. `lib/server.ts` will be reused by the login screen (3.2).
  **Exit criterion**: on the AVD, the screen shows the Docker server's version.
  Done: **2026-07-10**. Shows `8.5`, `TOTP, email`, files and avatars protected. Cleartext HTTP OK through Expo's debug overlay and `adb reverse tcp:3000`.

- [x] **1.7 - Throwaway DDP spike** · `@claude` · `[code]`
  `scripts/spike-ddp.mjs`: two WebSocket connections (anonymous and authenticated), crossed subscriptions on a private and a public room, trigger message posted over REST.
  **Uncertainty #2 settled**: the DDP login (`method login {resume}`) is **mandatory for any subscription, even on a public channel** (`nosub: not-allowed` otherwise), and the REST token works as is. Full verdict in `docs/DEV.md`.
  **Exit criterion**: the script prints the posted message and exits 0.
  Done: **2026-07-10**. PASS. Realtime proven with the global `WebSocket` (browser API = React Native API).

**Step exit**: an installed APK shows the version of a real Rocket.Chat server, and I know how realtime authenticates.

---

## Step 2 - Push spike · **KILL GATE**

> Goal: prove in a **binary** way that a self-built APK receives a notification **with the app killed**.
> Throwaway code, zero UI. Nothing in step 3 starts before this gate is settled.
> Ref. `ROADMAP.md` §5 phase 1 and §6.1. Prerequisites: **B1 to B4**.

- [~] **2.1 - Provide Firebase access** · `@guillaume` · `[infra]`: **half done**
  ✔ `google-services.json` dropped in (project `rocket-vibe`, sender `321528905029`, `package_name: com.rocketvibe.app`); `app.json` aligned on it (`me.barrut.rocketvibe` → `com.rocketvibe.app`, old APK uninstalled).
  ✖ **The service-account JSON key is missing** (Firebase console → Project settings → Service accounts → Generate new private key; role *Firebase Cloud Messaging API Admin*; *FCM V1* API enabled). It is what the server pastes into `Push_google_api_credentials`; without it, 2.3 and 2.5 are blocked. To be stored **outside the repo** (e.g. `~/rocket-vibe-secrets/`).

- [x] **2.2 - `expo-notifications` integration** · `@claude` · `[code]`
  `lib/push.ts`: `default` channel (HIGH) **before** `requestPermissionsAsync()`, then `getDevicePushTokenAsync()`. Proof button on the server screen.
  **Uncertainty #4 settled, with a nuance**: `POST_NOTIFICATIONS` is absent from `src/main/AndroidManifest.xml` but **present in the merged manifest**: it comes from the `expo-notifications` library manifest, merged at build time. Two FCM `MESSAGING_EVENT` services declared.
  **Uncertainty #5 settled**: `com.google.gms:google-services:4.4.4` × Gradle 9.3.1 → `BUILD SUCCESSFUL`.
  **Exit criterion**: an FCM token is visible.
  Done: **2026-07-10**. The permission dialog shows, and a **real FCM token** (`…:APA91b…`) issued for the `rocket-vibe` project appears on the emulator screen (`google_apis` image, GMS present).

- [x] **2.3 - Configure push on the server side** · `@claude` · `[infra]`: *local Docker server only, `chat.barrut.me` untouched*
  `Push_enable = true`, `Push_enable_gateway = false`, service-account JSON in `Push_google_api_credentials`, workspace restarted.
  **`Push_UseLegacy` does not exist in 8.5**, nor `Push_gcm_api_key`, nor `Push_gcm_project_number`. Legacy is fully removed; 8.x speaks FCM v1 only. The research file was wrong.
  **Changing a privileged setting requires 2FA**: `totp-required`, `method: "password"` → replay with `x-2fa-code: <SHA-256 of the password>` and `x-2fa-method: password`. The mechanism of 3.2, validated ahead of time.
  Done: **2026-07-10**

- [x] **2.4 - Register the token** · `@claude` · `[code]`
  `lib/pushToken.ts`: `registerToken` / `unregisterToken`.
  **Uncertainty #3 settled**, in the code at tag `8.5.0` (`apps/meteor/app/api/server/v1/push.ts`): `appName` is a **free string** (`minLength: 1`, no link to the applicationId); **`DELETE /api/v1/push.token` exists**, body `{ token }`. Strict schema (`additionalProperties: false`). A replayed DELETE answers **404**, tolerated by `unregisterToken` (test on the status, not on the text).
  **Exit criterion**: POST → `success:true`, DELETE → `success:true`, replayed DELETE → 404.
  Done: **2026-07-10**. Contract validated against the Docker 8.5 server (200/200/404).

- [x] **2.5a - The chain, on the emulator** · `@claude` · `[infra]`: **PASS**
  Server → `POST https://fcm.googleapis.com/v1/projects/rocket-vibe/messages:send`, `android.priority: HIGH`. Notification shown (`pkg=com.rocketvibe.app`, `title=admin`), **including with the process killed** (`am kill`), with FCM waking the process.
  > ⚠️ **`am force-stop` ≠ swiping away from recents.** It puts the app in the *stopped* state, where FCM delivers nothing any more. A spike using it would wrongly conclude that push is dead. Use **`am kill`**.
  > ⚠️ Nothing shows **in the foreground**: the message is handed to the app, and `expo-notifications` shows nothing without `setNotificationHandler`. That is not a push failure.
  > ⚠️ Rocket.Chat pushes **only to offline users**, on **DM or mention** only.
  Done: **2026-07-10**. Full verdict in `docs/PUSH.md`.

- [ ] **2.5b - The kill gate, on a physical device** · `@duo` · `[infra]`
  App **swipe-killed** from recents (not `force-stop`) on the Pixel 10 Pro.
  **Exit criterion (binary)**: a **visible** notification arrives **twice in a row**, with the app killed. Confirms Doze and real conditions; the emulator has already validated the chain.
  **Agreed procedure (2026-07-31), to run at the next slot: ten minutes, Pixel plugged in:**
  1. @guillaume swipes the app away from recents (the trap: "forcer l'arrêt" (force stop) puts the app in *stopped*, where FCM delivers NOTHING; a failure with force-stop would prove nothing);
  2. a **second account** sends a DM to `@bernard` (RC pushes only DM/mention, to an offline user). Either @guillaume does it from the web with another account, or he provides a test account / throwaway token for `chat.barrut.me` (OUTSIDE the repo) and Claude triggers the DMs over REST;
  3. Claude observes the notification through `dumpsys notification` (readable with the screen locked), **twice in a row**, and ticks this box.
  Settings already in place on the Pixel: "Données en arrière-plan" (background data) re-enabled + battery whitelist (2026-07-18, durable through Settings).

- [x] **2.6 - Record the verdict** · `@claude` · `[doc]`
  `docs/PUSH.md`: real FCM payload, the three field traps, and the two known defects to fix in 6.3 (`fcm_fallback_notification_channel` channel instead of our `HIGH` one; nothing in the foreground without `setNotificationHandler`).
  **Uncertainty #6 settled**: the server sends **both blocks**, `notification` and `data`. The system shows the first; the deep link's `rid` lives in `data.ejson`.
  Done: **2026-07-10**

**Step exit**: PASS → step 6 can be planned as is. FAIL on an OEM device after battery settings → the verdict stays "FCM viable", and the settings get documented. Total FAIL → switch to plan B of `ROADMAP.md` §6.1, and the "notifications" scope is renegotiated.

---

## Step 3 - Transport and data

> The invisible core. No UI. Everything is testable off-screen.
> Ref. `ROADMAP.md` §5 phase 2 and §6.2.

- [x] **3.1 - Typed REST client** · `@claude` · `[code]`
  `lib/rest.ts`: `RestClient`, auth and 2FA headers, typed errors (`RestError`, `TwoFactorError`), retry on `429` honouring `x-ratelimit-reset`. No third-party HTTP dependency, and **no `react-native` import**: the module runs under Node, so its tests run against real HTTP servers. `lib/server.ts` and `lib/pushToken.ts` now sit on it.
  **Exit criterion**: `npm test` green, `npx tsc --noEmit` green, and real login + 2FA against the Docker server.
  Done: **2026-07-10**. 15 tests green; against the real server: login, authenticated GET, `TwoFactorError` then replay with the password's SHA-256.

- [x] **3.2 - Authentication and 2FA** · `@claude` · `[code]`
  `lib/auth.ts` (pure, hashing injected) + `lib/sessionStore.ts` (`expo-secure-store`, one session per host).
  **Two forms of 2FA found against the real server**: `/api/v1/login` returns `error: 'totp-required'` **without** `errorType`, whereas `/api/v1/settings/*` returns `errorType`. Testing only `errorType` let the login's 2FA pass for an ordinary error.
  **`POST /api/v1/logout` answers 200 with an EMPTY body**: `RestClient` treats it as a success.
  **Uncertainty #1 settled**: 2FA goes through the `x-2fa-code` / `x-2fa-method` headers, never through the body.
  **Exit criterion**: `npm test` green, and against the Docker server: login, `resume`, `/me`, logout, then real 2FA triggered (`email` method).
  Done: **2026-07-10**. 29 tests green; full integration, `sendEmailCode` accepted.

- [x] **3.3 - Mini DDP client** · `@claude` · `[code]`
  `lib/ddp.ts`: listen only. `connect` → `method login {resume}` → `sub` / `unsub` → routing of `changed` / `ready` / `nosub` / `ping`. **No `call`**: DDP method calls are deprecated (8.0), removal in 9.0. `WebSocket` injected, hence testable under Node.
  Subscriptions **deduplicated by `(name, key)` with a reference count**, including for `sub`s in flight in the same tick; otherwise the server duplicates every event. Desired subscriptions survive the socket dropping, so that 5.1 replays them.
  **Exit criterion**: `npm test` green, and against the Docker server: DDP login with the REST token, subscription, REST message received in realtime, `nosub` on an unknown room.
  Done: **2026-07-10**. 48 tests green; integration: no duplicate on two concurrent subscriptions, reconnection after a refused login.

- [x] **3.4 - Local schema** · `@claude` · `[code]`
  Drizzle + `expo-sqlite`, **`enableChangeListener: true`**, WAL. Tables `rooms`, `subscriptions`, `messages` (indexes `(rid, ts)` and `thread_id`), `outbox`, `cursors` (composite key). **One database per host** (`db/fileName.ts`). Migrations generated by `drizzle-kit`, applied before the first render.
  **Exit criterion**: the migrations apply, `useLiveQuery` reacts to a write.
  Done: **2026-07-10**. Checked **on the device** through `sqlite3`: `journal_mode = wal`, 1 migration recorded, the 4 indexes present, and `EXPLAIN QUERY PLAN` confirms `SEARCH messages USING INDEX idx_messages_room_ts`. The debug screen's counters refresh without a reload.

- [x] **3.5 - Sync engine** · `@claude` · `[code]`
  `lib/normalize.ts` (pure translation of Rocket.Chat payloads), `lib/sync.ts` (DDP routing + REST ingestion, behind a `Store` interface), `db/upserts.ts` (the SQL **and** the parameter builders, a single source), `db/store.ts` (`expo-sqlite` implementation).
  Two invariants in the SQL: `ON CONFLICT DO UPDATE` (no duplicate) and `WHERE excluded.updated_at >= …` (**an older event does not overwrite a newer state**: a late REST catch-up does not resurrect an edited message, nor unread counts already reset).
  **Exit criterion**: replaying the same event twice creates no duplicate.
  Done: **2026-07-10**. 89 tests green; end to end against the Docker server: REST ingestion (14 messages), replay → still 14, realtime message written to the database with its `md`, deletion propagated, `ignores: 0`.

- [x] **3.6 - Debug screen** · `@claude` · `[code]`: *first half*
  `app/debug.tsx`: database row counters, insert and purge. It **will not be thrown away**: it is the measuring instrument for the 5.5 torture test. The counters go through `count(*)`, not `select *`.
  **Still to add** (after 3.5): active subscriptions, ping/pong RTT, duplicates detected, sync gaps.
  Done: **2026-07-10**. Partial.

---

## Step 4 - First vertical slice

> Goal: **the APK becomes useful day to day**.
> Ref. `ROADMAP.md` §5 phase 2, §6.3, §6.4.

- [x] **4.0 - Login screen** · `@claude` · `[code]`: *missing from the checklist*
  Step 3.2 shipped the authentication **library**, not its screen. Nothing in 4.1 can load rooms without a session. Screen: server entry (reuses `probeServer`), username, password; interception of `TwoFactorError` and UI by `error.method` (`totp` → 6-digit code, `email` → "envoyer le code" (send the code) button then entry, `password` → password typed again, hashed with SHA-256); session in `expo-secure-store`, resumed at startup by `resumeSession`.
  **Exit criterion**: on the AVD, log in as `alice`, kill the app, relaunch it → still logged in. Then enable TOTP on the account and go round again.
  Checked on the AVD: alice → `am force-stop` → relaunch → still `@alice`; TOTP enabled on `bob` through `method.call/2fa:enable`, full round (TOTP challenge shown, code accepted, session survives the kill), then TOTP disabled. Resuming at startup is optimistic: only a 401 logs out, not a network outage.
  Done: `2026-07-10`

- [x] **4.1 - Room list** · `@claude` · `[code]`: `subscriptions.get` + `rooms.get` merged by `rid`; subscriptions `stream-notify-user/<uid>/subscriptions-changed` and `/rooms-changed`; `fname`, `lastMessage` preview, `unread` badge, sort by activity. **If `room.encrypted`: padlock, and `lastMessage` preview hidden**, since it contains ciphertext.
  Checked on the AVD: message posted over REST → preview updated live; `encrypted` room created over REST → appeared with a padlock and no preview; `subscriptions.read` over REST → badge cleared live (a write to `subscriptions` only: drizzle's `useLiveQuery` listens only to the FROM table, hence two live queries merged in JS). Database **per server and per account** from this step on. Done: `2026-07-10`
- [x] **4.2 - Room screen** · `@claude` · `[code]`: history through `channels.history` / `groups.history` / `im.history` depending on `t`; `@shopify/flash-list` **`inverted`** + `maintainVisibleContentPosition`; keyset pagination `WHERE rid = ? ORDER BY ts DESC`; `sub` on open, **`unsub` on close**; **debounce of incoming messages** (insertions at the head less than ~200 ms apart make the scroll jump).
  **Measured gap from the spec**: no `inverted` prop; in FlashList 2.3.2 it is only compatibility, and its "near the bottom" detection works in raw coordinates (autoscroll and opening aimed at the wrong end, observed on the AVD). The equivalent v2 idiom: ascending data + `startRenderingFromBottom` + `autoscrollToBottomThreshold` + `onStartReached`. Checked on the AVD: opens at the bottom, burst of 8 messages 150 ms apart without a jump, live arrival followed, position held while reading the past. Done: `2026-07-10`
- [x] **4.3 - Markdown rendering** · `@claude` · `[code]`: `@rocket.chat/message-parser` on `msg.md`, rendered as nested `<Text>`. **Fallback to `parse()` mandatory**: `md` is absent from old messages. A sub-project in its own right, not to be underestimated.
  Checked on the AVD: heading, bold/italic/strikethrough, inline and block code, quote, lists, link, mentions, rendered from the server's `md`; the `parse()` fallback and resistance to poisoned `md` are proven by the Node tests (shape guard + per-message render guard: a corrupted message never costs the screen). Done: `2026-07-10`
- [x] **4.4 - System messages** · `@claude` · `[code]`: `t = uj / ul / rm / r / ...`, translation table. Checked on the AVD with real events (kick, invite, setTopic over REST): "a retiré bob du salon" (removed bob from the room), "a ajouté bob au salon" (added bob to the room), "a changé le sujet : …" (changed the topic: …), arriving live. Unknown type → generic sentence, never nothing. Done: `2026-07-10`
- [x] **4.6 - Degradation of encrypted rooms** · `@claude` · `[code]`: the target server has `E2E_Enable = true` and **one encrypted room** (`p:laprivitude`). Messages with `t === 'e2e'` become "🔒 Message chiffré, non pris en charge" (encrypted message, not supported), never the base64 blob; the composer is disabled with the explanation, since the server rejects a cleartext message (`error-not-allowed`, `E2E_Allow_Unencrypted_Messages = false`). See `ROADMAP.md` §6.6.
  Checked on the AVD with an injected `t: e2e` message (simulated base64 blob) in `test-chiffre` (`encrypted: true`): the blob appears nowhere, neither in the list ("Messages chiffrés", encrypted messages) nor in the room ("🔒 … non pris en charge"), and the composer is replaced by the explanation. The blob does not even reach the database (unit-tested since 3.5). Done: `2026-07-10`
- [x] **4.5 - Outbox and optimistic UI** · `@claude` · `[code]`: 24-hex `_id` generated **before** display → `pending` insert → `chat.sendMessage` → reconciliation when the same `_id` comes back. Retry when the network returns, actionable `failed` status.
  **Exit criterion**: kill the app with a `pending` message, relaunch it → the message goes out **without a duplicate** (the server deduplicates on `_id`).
  Checked on the AVD: network cut (`adb reverse --remove`) → message "⏳ envoi…" (sending…) → `am force-stop` → network restored → relaunch → **1 occurrence on the server**, including after a second replay, queue empty. Important finding: replaying an accepted `_id` answers **400**, not an idempotent success (recorded in `CLAUDE.md`), hence the `chat.getMessage` confirmation and reconciliation through any server-origin copy. Done: `2026-07-10`

**Step exit**: I log in (2FA included), I see my rooms, I read, I receive live, I send. On the AVD **and** on a physical device.

---

## Step 5 - Resilience and catch-up

> Ref. `ROADMAP.md` §5 phase 3, §6.2.

- [x] **5.1 - Reconnection** · `@claude` · `[code]`: exponential backoff with jitter (1 s → 30 s). On **every new socket**: reconnection, re-login, **re-subscription to every stream**. A subscription never survives a reconnection.
  The first connection goes through the same driver as reconnections; `connect()` replays every desired subscription; the REST reload and the send-queue flush follow every new socket. Checked on the AVD: socket cut for 12 s (`adb reverse --remove`), restored → a message posted afterwards arrives **live**, without touching the app. Backoff, jitter, restart-in-flight and clean-up of the negotiation timeout tested under Node (138 tests). Done: `2026-07-10`
- [x] **5.2 - Catch-up** · `@claude` · `[code]`: driven by `SyncState`, on `AppState 'active'` and on reconnection. **`chat.syncMessages` handles one room at a time and REST is rate-limited**: do not loop over every room. A `subscriptions.get?updatedSince=` + `rooms.get?updatedSince=` for the bulk, `syncMessages` **only** on open or recently active rooms.
  Cursors = largest `_updatedAt` **ingested** (never the local clock), which never go backwards; `syncMessages` on the active room only; `remove[]` handled with the real server projection (subscription `_id` → `sub_id` column, migration 0001); DDP liveness probe on return to the foreground (half-dead socket detected and reconnected). Checked on the AVD: message posted DURING a socket cut, room open → present after reconnection, through `chat.syncMessages`. Done: `2026-07-10`
- [x] **5.3 - Multi-server** · `@claude` · `[code]`: `Server` registry, tokens **and** SQLite database isolated per host.
  A `known-servers` registry (SecureStore cannot enumerate its keys), switching without logging out from the home screen, background validation after a switch (only a 401 logs out). Checked on the AVD with two hosts (`localhost:3000` = alice, `127.0.0.1:3000` = bob): sessions preserved across switches in both directions, isolated databases (bob sees only his rooms), instant switch through the registry. Done: `2026-07-10`
- [x] **5.4 - Start a conversation** · `@claude` · `[code]`: `GET /api/v1/spotlight?query=`, then `POST /api/v1/im.create` or `POST /api/v1/channels.join`. Without it the app only lists what exists.
  Checked on the AVD: alice joined `#general` (of which she was not a member; the "joined the room" message arrived live), then created the alice↔bob DM and sent the first message, confirmed on bob's side (`im.list`). Rooms ingested from the server's response: navigation does not wait for the stream. Done: `2026-07-10`
- [x] **5.5 - Torture test** · `@claude` · `[code]`: cut Wi-Fi for 30 s ten times, toggle background/foreground twenty times, send fifty quick messages.
  **Exit criterion**: local state == server state. **Zero duplicates, zero missing messages, zero ghost subscriptions**, measured on the 3.6 debug screen.
  Run on the AVD: 10 cuts of 30 s (`adb reverse --remove`), 20 HOME/back cycles, 50 messages 100 ms apart. Result: 50/50 locally, 50 distinct texts, zero `_id` duplicates across the whole table, send queue empty, `ignores: 0`, subscriptions established == desired == 2 (the user streams; the closed room screen had released its own). Note: the test server's REST rate limiter had to be suspended during the burst (10/50 got through otherwise; the server was doing the limiting, and the client was consistent: local == server == 10). The debug screen now shows the engine's counters and the DDP state. Done: `2026-07-10`

---

## Step 6 - Integrated push

> Depends on the verdict of step 2. Ref. `ROADMAP.md` §5 phase 4.

- [x] **6.1 - Token lifecycle** · `@claude` · `[code]`: registration on login, unregistration on logout.
  Checked in MongoDB (`_raix_push_app_tokens`): connection → 1 `gcm` token (appName `rocket-vibe`, alice's userId); "Se déconnecter" (log out) → 0 tokens (unregistered BEFORE the logout, since the call requires authentication; best-effort, 404 = success); re-login → 1 token. Done: `2026-07-10`
- [x] **6.2 - Socket lifecycle** · `@claude` · `[code]`: clean close on `AppState 'background'`, reopening and resync on `'active'`.
  Checked through server presence: alice `online` in the foreground → `offline` 5 s after going to the background (socket closed on purpose, so the push will go out: RC notifies only offline users) → `online` on return (reconnection + re-subscriptions + catch-up through the 5.1/5.2 driver). Done: `2026-07-10`
- [x] **6.3 - Deep link** · `@claude` · `[code]`: notification handler → `expo-router` route to the room; badge consistent with `subscription.unread`; Android notification channels. **`Push_show_message = true` on the target server**: a notification from the encrypted room carries ciphertext → replace it with a generic text.
  Checked on the AVD, full chain: app in the background (socket closed → alice offline) → DM from bob → notification on the `default` channel (`default_notification_channel_id` meta-data set by the config plugin; the `fcm_fallback_notification_channel` of defect 2.x is gone) → **tap → room opens directly** (`data.ejson.rid`), including from cold (`getLastNotificationResponseAsync`). Badge = sum of unread counts (`setBadgeCountAsync`). Encrypted: substitution with a generic text when THE APP is the one displaying; with the app killed, the system displays the server payload as is. The real counter is `Push_show_message=false` on the server, out of our hands (an operations decision). Done: `2026-07-10`

---

## Step 7 - Upload

> Ref. `ROADMAP.md` §5 phase 5. **`rooms.upload` was removed in 8.0.0**, not deprecated.

- [x] **7.1 - Two-step flow** · `@claude` · `[code]`: `POST /api/v1/rooms.media/:rid` then `POST /api/v1/rooms.mediaConfirm/:rid/:fileId`. **`rooms.media` alone posts no message**: forgetting the `mediaConfirm` leaves an orphan file. **Settles uncertainty #7** (response schema of `mediaConfirm`).
  Uncertainty settled against the real server: `media` → `{file:{_id,url}}`; `mediaConfirm` → full `{message}` (`attachments[]` with `title_link`/`image_url`/`image_preview`/`fileId`, `file`, `md`), which goes through ingestion as is. A real upload posted a message in `test-public`. `lib/upload.ts`: pure flow (transport injected), `media` refusal = clear error WITHOUT confirm, empty confirm body when there is no caption (`additionalProperties: false`); `protectedFileUrl` (7.4) laid down along the way. Done: `2026-07-10`
- [x] **7.2 - Transport** · `@claude` · `[code]`: `expo-file-system/legacy` `createUploadTask` in `MULTIPART`, `fieldName: 'file'`, progress through `totalBytesSent`. Integrated into the `Outbox` through the `Upload` table.
  `uploads` table (migration 0002): the intent (local uri, name, type, caption) is persisted BEFORE sending, replayed on every connection; an `uploadAsync` rejection (no HTTP response) counts as status 0 → the row stays `pending`; a purged cache file (kill between selection and replay) is a plain failure, shown in the room with retry/abandon. Checked on the AVD: image sent through the picker → file on the server side, shown in the app. Done: `2026-07-10`
- [x] **7.3 - Selection and validation** · `@claude` · `[code]`: `expo-document-picker`, `expo-image-picker`, compression with `expo-image-manipulator`. Validate `FileUpload_MaxFileSize` and `FileUpload_MediaTypeWhiteList` (read from `settings.public`) **before** the upload.
  📎 button → document picker (covers images; image picker installed for later); photos > 500 KB recompressed as 1920 px JPEG (GIFs spared). **Review finding checked against the server: the `query` parameter of `settings.public` was REMOVED in 7.0**: reading goes through `count=0` + a client-side filter, otherwise validation is a silent no-op. The permissive offline fallback is never memoised. Done: `2026-07-10`
- [x] **7.4 - Protected reads** · `@claude` · `[code]`: if `FileUpload_ProtectFiles`, add `rc_uid` / `rc_token` as query on `/file-upload/:id/:name`.
  `protectedFileUrl` (tested) applied to attachment rendering: images shown with bounded dimensions, other files as links. Checked on the AVD: the uploaded image shows in the room. Done: `2026-07-10`
- [x] **7.5 - Voice messages** · `@claude` · `[code]`: `expo-audio`, `.m4a` AAC, `mimeType: audio/mp4`.
  🎤 in the composer (when the draft is empty) → permission → recording (HIGH_QUALITY preset, `.m4a`) → ⏺ stop → sent through the SAME file pipeline (persisted, validated, replayed). Checked on the AVD: `recording-….m4a | audio/mp4` received on the server side. Received voice messages show as a 🎵 link (in-app playback later). Done: `2026-07-10`

---

## Step 8 - Offline-first and polish

> Ref. `ROADMAP.md` §5 phase 6.

- [x] **8.1 - Unread** · `@claude` · `[code]`: `subscriptions.read`, "new messages" bar through `ls`.
  Marked read on open and on every incoming message while the screen is open (debounced 1.5 s, REST being rate-limited); the bar is placed from a SNAPSHOT of `ls` taken on mount (otherwise the `read` erases it before anyone sees it), before the first message from SOMEONE ELSE posted after it. Checked on the AVD: 2 messages posted with the screen closed → on reopening, the bar sits exactly in the right place; `ls` did not exist before our app's first `read` (bar absent on the first opening, as expected). Done: `2026-07-10`
- [x] **8.2 - Message actions** · `@claude` · `[code]`: `chat.update`, `chat.delete`, `chat.react`, `chat.pinMessage`. Display decision **centralised in a pure function** `(message, currentUser, subscription.roles, permissions, settings)`: the edit window comes from the **settings** (`Message_AllowEditing_BlockEditInMinutes`), not from permissions. Action sheet through `presentation: 'formSheet'` (native).
  Proven on the AVD against the real server: long press → formSheet; someone else's message = react + pin only, mine = everything; `chat.react` (**the server refuses raw unicode, it wants the `:+1:` shortname**), `chat.update` (server `editedBy` + "(modifié)" (edited) live), `chat.pinMessage` (`not-authorized` refusal shown cleanly, then success once owner), `chat.delete` (gone from the server and from the screen). Found along the way: **a FlashList mounted empty** treats the first batch as insertions above the `maintainVisibleContentPosition` anchor → viewport below all content, blank screen on cold start; the list now mounts only once populated. Review (8 angles): **the write queue belongs to the connection, not to the store**: `transaction(fn)` now passes the direct writer to `fn` (re-entrance impossible by construction) and the sending/uploads stores share the same queue, otherwise their writes joined an open `BEGIN` and a batch rollback took them along; `presentation: 'formSheet'` declared in `_layout.tsx` (set from the screen, it arrives after native creation); no actions on outbox rows (an `_id` never accepted by the server); offline, a non-memoised permissive fallback instead of an empty sheet forever; rules cache keyed by `baseUrl` (a global survived a server change); double-tap guard in a ref (React state from a past render let the duplicate through); real RC permissions (`bypass-time-limit-edit-and-delete`, `edit-message`; `force-edit-messages` does not exist); long press forwarded to attachments (a touch born on a Pressable child does not bubble up); `accessible={false}` on the row (TalkBack found ONE merged node). Dismissed, recorded: consolidation of the three `settings.public` readers (postponed, it touches tested 7.x paths); display of received reactions (outside the criterion); `set-state-in-effect` lint in `ui/sync.tsx` (predates the diff). Done: `2026-07-10`
- [x] **8.3 - Threads and discussions** · `@claude` · `[code]`: `tmid`, `tcount`, `tlm`.
  Columns `thread_last` (tlm) and `thread_shown` (tshow), migration 0003. The main feed filters out thread replies (`thread_id IS NULL OR thread_shown`); the root carries "💬 N réponses · HH:MM" (N replies) → `thread/[id]` screen (root + replies, composer with `tmid`, same encrypted/read-only flags as the room). `MessageRow` extracted as a shared component (`ui/messageRow.tsx`). **Checked against 8.5: the default of `channels.history` is ALREADY `showThreadMessages=false`**, made explicit to lock the agreement between server and local filter; otherwise a whole page of hidden replies would make keyset pagination loop. `chat.getThreadMessages` NEVER returns the root (fetched through `chat.getMessage`, essential for a cold direct link) and its `count=0` depends on `API_Allow_Infinite_Count` → defensive pagination in pages of 100. Review: failure of a thread reply visible from the room (banner, since the row is filtered out of the feed); autoscroll near the bottom + scroll on send; round-trip test of the new columns with non-default values (guards against swapping neighbouring parameters). Proven on the AVD: bob's reply hidden from the feed + counter, full thread screen, alice's reply from the app (server `tmid`, 24-hex client id, tcount 2→4, tlm up to date), `tshow` reply visible in the feed AND the thread. Dismissed, recorded: `tshow` replies ingested before 8.3 stay hidden until the next history pass (backfill at 0, no installation in production); thread unread counts (`tunread`) out of scope. Done: `2026-07-10`
- [x] **8.4 - Presence** · `@claude` · `[code]`: `users.presence?from=` and `stream-user-presence`, with **graceful degradation**: `Presence_broadcast_disabled` switches itself on beyond about 200 connections. The UI must never depend on it.
  VOLATILE `PresenceEngine` (never persisted: stale presence is worse than none), `usePresence` hook (useSyncExternalStore, stable identities, no subscription outside DMs), coloured dot on DMs. **Two departures from the plan, recorded.** (1) The stream: the 8.5 subscription to `stream-user-presence` goes through a proprietary protocol (`{added:[uid]}` on a "main" publication per connection, read in the server bundle after a probe showed `ready` without ever receiving anything); the SAME presence is broadcast on `stream-notify-logged`/`user-status` (`[[uid, username, status no., text]]`, 0=offline 1=online 2=away 3=busy), which subscribes like any stream and replays on reconnection. (2) No `?from=` cursor: it would anchor on the LOCAL CLOCK (forbidden by the cursor rule) and the response carries no `_updatedAt`; a full snapshot on every connection, at bounded cost (non-offline only). Review: the REST snapshot never regresses a fresher status from the stream (per-uid sequence guard); a known uid missing from the snapshot goes `offline` (the snapshot includes only non-offline users); loads serialised. **An 8.5 DM's rid is a random ObjectId, NOT the concatenation of the uids**: the other participant comes from the Rooms document's `uids` (`uids` and `usernames` are not aligned with each other) → column `rooms.dm_other_uid`, migration 0004 with a backfill by invalidating the `*/rooms` cursor. Proven on the AVD, measured to the pixel: dot `#f5455c` (busy) on bob's row during his DDP session, `#9ea2a8` (offline) when it closes, live, with no local action. Done: `2026-07-10`
- [x] **8.5 - Search** · `@claude` · `[code]`: `chat.search`.
  "Rechercher dans le salon" (search in the room) screen (🔍 in the room header): `chat.search?roomId=&searchText=` debounced with a sequence guard (same idiom as the 5.4 spotlight), EPHEMERAL results, normalised by `toMessage`, rendered by the shared `MessageRow`, never written to the database. No actions on a result (the sheet reads the database by id, and an old result is not necessarily there) and no jump to the message in the history, both recorded. Review: "recherche" (searching) indicator from the first keystroke (otherwise a false "aucun message" (no messages) during the debounce), error cleared when the field is emptied, `disconnected` gate → login like the other screens. Proven on the AVD: "torture2" → immediate results, gibberish → "Aucun message trouvé" (no message found), "vocal" → empty, rightly (a file's name lives in the attachments, outside full-text). Done: `2026-07-10`
- [x] **8.6 - Typing indicator** · `@claude` · `[code]`: `stream-notify-room/<rid>/user-activity`. **Not `/typing`, which is deprecated.**
  LISTEN only: "bob écrit…" (bob is typing…) above the composer, in a RESERVED height (its appearance does not resize the list). Format probed on 8.5: `args = [username, ['user-typing'] | [], extra]`. Volatile `TypingEngine` per screen, each entry EXPIRES on its own (15 s: the "stop" event from a peer who loses the network will never come); notification on real change only (RC re-emits as a heartbeat while typing, and each heartbeat would re-render the screen). **Departure recorded: we do not EMIT our own typing**: client emission goes through the streamer's DDP method (`allowWrite` of `stream-notify-room`, read in the bundle) with NO REST equivalent at all, and our DDP client is deliberately without `call`; to be reassessed if parity requires it. Review: `user-activity` no longer increments the sync engine's anomaly counter. Proven on the AVD, measured: 555 px of "bob écrit…" text while he types (simulated by a DDP probe), 0 after he stops. Done: `2026-07-10`
- [x] **8.7 - Drafts** · `@claude` · `[code]`: MMKV, per `rid` and per `tmid`.
  **Departure from the plan recorded: SQLite (`drafts` table, migration 0005), not MMKV.** The draft is written DEBOUNCED (400 ms), so the database's asynchronous latency is irrelevant, and one more NATIVE dependency (hence a rebuild) cannot be justified against ROADMAP §4.2 when the database already covers all local state; per (server, account), drafts do not leak from one account to another. Keys `rid` (room) and `rid:tmid` (thread). The composer MOUNTS only once the draft is read, seeded by `useState(initial)` and discarded through `key` when the room changes: no after-the-fact restore, no leak from one room to another; debounce flushed when leaving the screen. Review: flush refs reset (the cleanup also runs on a key change; the old key's text could have replayed under the new one); sending a file no longer erases text typed DURING the upload (functional comparison). Along the way: the three `setState`-in-effect writes flagged by the new React rule are restructured (reset during render, derived state in search). Proven on the AVD: draft typed → app killed → relaunch → text restored in the field; thread draft and room draft independent (round trip, each finds its own). Done: `2026-07-10`
- [x] **8.8 - E2E suite** · `@claude` · `[code]`: Maestro: login, 2FA, send, reconnection, upload.
  `e2e/run.sh` (bash, `set -euo pipefail`, pinned to `ANDROID_SERIAL=emulator-5554`: a personal phone plugged in must never receive the suite) orchestrates 5 YAML flows + node harness: 01 login from a BLANK state (clearState → dev-client launcher → Metro resume, server field PRE-FILLED so cleared first); 02 send; 03 reconnection (REAL cut: `adb reverse --remove`, bob posts meanwhile, restored under a trap); 04 upload through the SYSTEM picker (generated PNG, pushed into Downloads; caption BEFORE the 📎); 05 TOTP 2FA (enabled/disabled by a DDP harness, the only place in the repo allowed to use `method`, as it simulates bob's official app; RFC 6238 TOTP in pure node:crypto). **Maestro asserts are not enough**: the OPTIMISTIC render satisfies 02, the caption still in the composer satisfies 04; `check-server.mjs` settles it over REST (message present, file attached). Traps killed along the way: `hideKeyboard` = sometimes BACK (ejects from the screen, or even the app); the restored 8.7 draft pollutes the field (eraseText every time); RC refuses REUSE of a TOTP code (multi-window attempts) and `/login` puts the error code in `error`, not `errorType`; `console.log` + `process.exit` truncates a pipe (the secret got lost); 2FA secret persisted in /tmp for cleaning up an interrupted run; `launchApp` without `stopApp:false` reloads the whole dev bundle and sometimes falls back to the launcher. `accessibilityLabel` set on 📎/🎤 (needed by Maestro, owed to TalkBack anyway). Proof: full suite GREEN, exit 0, two server truths printed, 2FA cleaned up. Maestro installed from the official GitHub release (documented at the top of the script). Done: `2026-07-10`
- [x] **8.9 - Keyboard over the composer** · `@claude` · `[code]`: first feedback from trying it on the Pixel: the keyboard opened ON TOP of the input field. Cause: edge-to-edge (imposed by Android 15+, hence by SDK 57) neutralises `adjustResize`: the manifest has it, the window no longer resizes.
  Fix modelled on **duogo** (the reference pointed to by @guillaume): `react-native-keyboard-controller` + `reanimated`: `KeyboardProvider` at the root, `KeyboardAvoidingContainer` (`ui/keyboard.tsx`) which animates `paddingBottom = max(bottom inset, keyboard height)` from the frame-by-frame SharedValue (`useReanimatedKeyboardAnimation`), replacing `SafeAreaView edges=['bottom']` on the 5 screens with input (room, thread, login, searches). The "core RN without a dependency" track was dismissed AFTER measuring with a probe: `keyboardDidShow` reports `imeInsets.bottom − barInsets.bottom` (820 px announced for 883 real → composer two-thirds hidden, checked in the source of `ReactRootView`), and the event is single and late, with no tracking. duogo had also dismissed the library's `KeyboardAvoidingView` ("automaticOffset missed at times"). Review (8 angles): the component carries `flex: 1` + background itself (style triplet duplicated across the 5 call sites removed); convention cross-reference added on the remaining `SafeAreaView`s (index, debug); **refuted by running it**: the edit formSheet handles its keyboard natively (field + "Enregistrer" (save) visible above the full keyboard), and keyboard-controller's insets listener survives the sheet's lifecycle; **recorded**: relayout per frame during the animation (an accepted cost of the duogo pattern, to watch on the Pixel, non-inverted FlashList), login fields in the upper half (the padding makes the content scrollable above the keyboard anyway). Proof on the AVD (`hw.keyboard=no` for the duration of the test, restored afterwards): composer sitting RIGHT on the full keyboard, clean open/close round trip, sending with the keyboard open OK; **full E2E suite GREEN, exit 0** after the rebuild (3 native modules added). Done: `2026-07-10`
- [x] **8.10 - Inverted list: the chat docks to the keyboard natively** · `@claude` · `[code]`: second feedback from the Pixel: despite 8.9, list, composer and keyboard stayed "a bit out of sync": FlashList recomputed its window in JS on every frame of the animation (mVCP + autoscroll = after-the-fact correction), @guillaume's diagnosis confirmed.
  Port of the **duogo** idiom (`chat/[id].tsx`, pointed to as the reference): `inverted`, with the most recent in `data[0]`, at native offset 0 = stuck to the composer, so the animated resize needs NO compensation; `maintainVisibleContentPosition={{disabled: true}}` (the native correction fired before the JS snap and overrode it, a duogo scar); incoming messages followed by `scrollToOffset(0)` if "from me or near the bottom" (refs, zero re-renders); `DESC` data as is (no more `reverse()`); the past through `onEndReached` (the end of the data = the visual top); unread bar recomputed in DESC (last occurrence of the predicate, inserted at k+1). Review (2 multi-angle passes): **chronological guard on the snap** (DELETING the head message also changes `data[0]`: a spurious snap in the middle of reading history); **`passExhausted` lock** (`onEndReached` re-arms on EVERY data change: past exhausted + user parked at the top = one identical REST request per incoming message, on a rate-limited API); comments realigned (the header claimed "we do not disturb", the 200 ms smoothing invoked a mechanism that had disappeared, the thread pointed to a room that no longer exists). Dismissed, recorded: the content shift when an incoming message arrives WHILE reading history (an accepted duogo compromise: mVCP would fix it but breaks the snap; smoothing groups bursts); unread bar outside the loaded window (8.1 semantics unchanged); the THREAD keeps the old setup (it is read from its root, a short list; to port if it feels wrong). Proven on the AVD: opens anchored at the bottom, list stuck to the composer with the full keyboard open/closed, incoming message WHILE the keyboard is open stuck to the composer with the unread bar in the right place, send + REST server truth, pagination beyond the initial window (torture2 13:02). **Found along the way: an intermittent native crash of the DEV CLIENT**: Fabric SIGSEGV (`MountingCoordinator::pullTransaction`, JS thread) on the first bundle load after `clearState`, measured **2/8 in dev, 0/8 in release** (the Pixel is not exposed); appeared with reanimated 4.5 (8.9), to follow upstream → `e2e/run.sh` gives the three cold launches a second try (01, 05, reset; TOTP recomputed on retry; replaying 02/04 would post the same message again). Full E2E suite GREEN, exit 0 (this run without a single retry). Done: `2026-07-10`

- [x] **8.11 - Emojis** · `@claude` · `[code]`: third feedback from the Pixel: messages showed `:smile:` instead of 😄. **Rocket.Chat 8.5 never resolves shortcodes**: `msg.md` delivers `{type:'EMOJI', shortCode:'smile'}` with no `unicode` field (probed on the local server, 8 forms); the table belongs to the client, which did not have it.
  A `shortcode → code points` table **generated** (`scripts/generate-emojis.mjs`, `npm run emojis:generate`) from `emoji-toolkit` (the JoyPixels source RC takes its shortnames from, so `:+1:` included) as a **devDependency only**: no runtime dependency, no image, the glyphs are rendered by the system font (ROADMAP §4.2 constraint). Licence checked: emoji-toolkit's `LICENSE.md` separates the **artwork** (restrictive JoyPixels licence, which we do not ship) from the rest: "Javascript, JSON… : MIT". 6222 codes, deterministic output (sort, one winner per collision, 0 diverging). `unicodeOfShortcode`: `typeof`, not `in`: `:constructor:` is a legal shortcode for the server and would surface a function from `Object.prototype` into a `<Text>`.
  **Found along the way, and it is the real lesson: Hermes stores each bytecode string as ASCII (1 B/char) or UTF-16 (2 B/char), and ONE single non-ASCII character switches the WHOLE string.** The table in raw glyphs cost **+399,968 B** of release bundle (the 6222 ASCII keys paid double because of the emojis), predicted at 399,054 B by the model, measured within 914 B. As hexadecimal code points, everything escaped as `\uXXXX` (`piñata` included): **+276,080 B, i.e. 124 KB given back**, for 236 ns of decoding per rendered emoji. A test checks that the table stays pure ASCII and that all 6222 entries decode.
  **Second bug, found while probing**: the parser VALIDATES no shortcode: `:pas_un_emoji_du_tout:` alone on its line comes out of the server as `BIG_EMOJI`, like `:smile:`. The app therefore showed it at 36 px. We now enlarge only if EVERY node resolves. Review (xhigh, 6 angles, independent verify): simplification of the "all resolved" predicate adopted (`every`, instead of two parallel arrays compared by length); `Array.isArray` on `BIG_EMOJI.value`, the only block that still trusted the `md`; reaction bar derived from the table (a single source of truth), `chat.react` still receives the shortname. **Dismissed, recorded**: the review flags that a server CUSTOM emoji, alone on its line, drops from 36 px to 15 px. That is the intended behaviour: a literal `:party_parrot:` at 36 px is the worse of the two wrong renderings. Custom emojis stay out of scope (the local server has none, `emoji-custom.list` empty; the target server cannot be probed without authentication): they degrade to a readable `:name:`. Also dismissed: the body of push notifications, written by the server, keeps its shortcodes.
  Proven on the AVD against the real server, one screen covering the 8 forms: `salut :smile: !` → "salut 😄 !", `:+1:` → 👍 (alias), `unicode direct 😄` intact, `:smile:` alone → 36 px, `:smile: :heart: :+1:` → three big ones, with the ❤️ **red** (`2764-fe0f`, the variation selector; without it the font renders a black text ❤), `:100:` inline, and `:pas_un_emoji_du_tout:` / `:shipit:` as normal text. Reaction from the action sheet → server truth: `{":+1:":{"usernames":["alice"]}}`. `tsc` clean, 191 tests green, full E2E suite GREEN exit 0 on the second launch: the first died at flow 02 on an adb socket closed under Maestro (`IOException: Command failed (tcp:…): closed`), an infra flake unrelated to the diff. **`E2E_EXIT=$?` followed by `tail` in the same command makes the exit code lie**: the shell reports the `tail`'s. Done: `2026-07-10`

- [x] **8.12 - Custom emojis: rendering in messages** · `@claude` · `[code]`: @guillaume: "I'd like to handle custom emojis, the server has loads of them". The first of the three parts he chose (rendering, then reactions, then autocomplete), with "everything animated". **In `msg.md`, a custom emoji is indistinguishable from an unknown one**: `{type:'EMOJI', shortCode:'party_parrot'}`, without `unicode`, exactly the case 8.11 degraded to `:name:`. What tells it apart lives in `emoji-custom.list`: `{name, aliases[], extension}`, probed on the local server (I created customs there). **An alias arrives as its own `shortCode`**, and `/emoji-custom/:alias.:ext` returns a fallback SVG → we index alias→canonical name and build the URL from the name.
  **De-risked before coding**: the hard point was an ANIMATED image inline in the text. A real prototype (debug screen, custom GIF, Metro reload without a rebuild) → two measured facts: React Native's `Image` nests natively inside `<Text>`, and `expo.gif.enabled=true` (already in the template's `gradle.properties`) wires `Fresco animated-gif` → **the GIF animates, inline and large, with NO dependency at all** (5 distinct disc colours across 8 adb captures spaced apart). `expo-image` dismissed, not needed. ROADMAP §4.2 constraint held.
  **Architecture**: SQLite table `custom_emojis` (offline-first; MMKV banned by the project, see `ui/drafts.ts`) → in-memory Map (`lib/customEmojis.ts`), resolved SYNCHRONOUSLY at render like `unicodeOfShortcode`. Loaded from SQLite BEFORE the `ready` phase (offline), refreshed from the server on connection. Rendering: `renderEmoji` returns a Unicode glyph, otherwise a custom `<Image>` (inline 18 px / large 36 px), otherwise `:name:`. Priority to the **character**: a shortcode that is both Unicode and custom renders the glyph (the `:parrot:` alias → 🦜, not the image; a deliberate choice, the canonical name always shows as custom). The first blank login works without a relaunch: `replace()` writes `custom_emojis`, the SQLite change listener breaks the rows' memo (see `ui/messageRow.tsx`), and they re-resolve with the populated Map, proven by `clearState`.
  **Bug caught while probing**: `emoji-custom.list` accepts ONLY `updatedSince`; my `count=0` (copied from `settings.public`) got `success:false`, and my code then read `update ?? []` → it **EMPTIED** the cache. Fixed: no parameter, and the table is replaced only on a list actually received. Regression test added.
  **Review (xhigh, 6 angles, independent verify, 7 findings)** fixed: (1) **cross-server leak**: the index is module state; a fetch from server A resolved AFTER logout re-armed the index and fired an unauthenticated request to A → `isDiscarded` guard before `setCustomEmojis`, in `syncCustomEmojis` AND `restoreCustomEmojis`, with a test; (2) `resizeMode="contain"`: a non-square emoji was cropped by the default `cover`; (3) `seedCustomEmojis` replays the 429 like `api()` (multipart, `FormData` rebuilt per attempt); (4) sync gated ONCE per session (like the push token), no longer on every flap, which meant a full download + rewrite of the whole table; (5) **`buildIndex` in two passes** (names first, aliases next): the doc promised an order independence that first-write-wins betrayed (an earlier alias masked a later name), test for both orders; (6) `ui/markdown.tsx` header rewritten ("no image" contradicted the new remote path); (7) `filterAliases` shared between network ingestion and the SQLite reread. Refuted, dismissed: "frozen GIF" (the animation is proven) and "`ReadClient` duplicates `RestClient`" (deliberate, to test without it).
  Seed enriched (`scripts/emojis-seed.mjs`, frozen base64: party_parrot animated GIF with 5 frames + shipit PNG), idempotent. Proven on the AVD against the real server, one screen covering every case: `:party_parrot:` inline animated, alone and large animated, `:shipit:` inline, and the **mixed BIG_EMOJI** `😄 party_parrot shipit` (Unicode + two customs at 36 px). First `clearState` login: customs shown after the sync, without a relaunch. `tsc` clean, 207 tests green, full E2E suite GREEN exit 0 (anti-regression of the modified sync path; flow 05 and reset on their second try, known dev-client crash). Done: `2026-07-11`

- [x] **8.13 - Custom emojis: autocompletion in the composer** · `@claude` · `[code]`: @guillaume: "when I type `:te`, I'd like autocompletion of the emojis that could match, like `:test:` or `:tete:`". Third and last part of the emoji workstream (after the 8.11/8.12 rendering).
  **Architecture**: PURE testable logic (`lib/emojiCompletion.ts`): `detectEmojiToken` (the `:xxx` token being typed before the caret), `completeEmoji` (ranking standard + custom), `applyCompletion` (replacement); a horizontal strip (`ui/emojiCompletion.tsx`) that resolves the preview and the insertion, wired into BOTH composers (room + thread). Insertion differs: a **standard emoji inserts its glyph** (like Slack/Discord, the emoji appears right away), a **custom one inserts `:name:`** (no glyph: the server re-parses it, rendering turns it into the image). Both go back through the rendering pipeline on send. Ranking: exact, then prefix, then substring; at equal quality, **custom before standard** (that is what the user was looking for). Codes exposed by `codesEmojiStandard()` (lib/emojis) and `customEmojiCodes()` (lib/customEmojis).
  **The lesson, and it cost the review dearly**: controlling a `TextInput`'s `selection` PERMANENTLY makes the caret jump backwards during fast typing on Android (a race between `value` and `selection`: `onChangeText` re-renders with the new value and the old selection). So we IMPOSE the selection only for an instant, right after moving the caret ourselves (insertion, clearing), then release it (`undefined`) as soon as the native side has followed; the field is free during normal typing. A single mechanism, shared by both composers through the `useEmojiCompletion` hook.
  **Review (xhigh, 11 distinct findings)**: fixed: (1, CONFIRMED) the "the `:` opens a word" guard excluded only ASCII → `résumé:tl` opened the strip in the middle of a French word; moved to `\p{L}\p{N}` (accented letters included), checked Hermes-safe on the AVD; (2,3,5) the controlled-caret family (caret jump, selection not reset after an attachment) → the impose-once caret above settles them all; (4) a custom whose name has a capital (`PartyBlob`) never matched a lowercased query → case-insensitive custom comparison, original code kept for the URL; (6, 11) `Set(6222)` and spread of the custom index rebuilt on every keystroke → frozen caches (`Object.freeze`), invalidated when the index is (re)defined; (7) standard array returned by reference (mutation footgun) → frozen; (9, CONFIRMED) caret wiring duplicated in both composers → shared hook. **Dismissed, recorded**: (8) the strip does not refresh if the custom sync lands mid-typing; accepted, the sync arrives once per session on connection, before composing, and the next keystroke recomputes; (10) full sort before slice: the sort covers only the matches (small m), not the 6222.
  Proven on the AVD against the real server: `:par` → `:party_parrot:` (custom, animated image) AT THE TOP, then `:park:` / `:parrot:` / `:parking:` (standards by length); custom tap → `:party_parrot: ` inserted; `:sm` → `:sm:` (🇸🇲, exact) then the smileys; standard tap → **glyph** inserted, and the typing that follows (`ok`) lands after the glyph: the caret does not jump; sending `:party_parrot: 🇸🇲` → custom image + flag rendered. `tsc` clean, lint clean, 231 tests green (including token detection, ranking, case, the accented case). Full E2E suite GREEN exit 0, without retry (01 login, 02 send, 03 reconnection, 04 upload, 05 2FA + alice reset). Done: `2026-07-11`

---

## Step 9 - "Nuit Étoilée" visual theme (design import)

> Import of the `claude.ai/design` design "Dark Little Poney", chosen direction **1a "Nuit Étoilée"** (Starry Night): starry indigo, saturated rainbow, Baloo 2 headings, Nunito body, gradients, avatar tiles, star badges, wordmark. **Dark first** (@guillaume's choice); the light "day" theme (2b, already captured as data) will come later. One screen = one sub-step.

- [x] **9.1 - Theme foundation + Login screen** · `@claude` · `[code]`: @guillaume: "integrate the design, at first dark mode only". File `Dark Little Poney.dc.html` imported through the `claude_design` MCP.
  **Foundation**: `ui/theme.ts` swaps the palette (9 tokens) for the `Colors` interface (≈30 tokens) in two variants, `darkColors` (Nuit Étoilée) AND `lightColors` ("day", captured as data to keep the type honest, same keys); gradients as tuples (`ctaGradient`, `brandGradient`, `avatarGradients`, `neutralGradient`), deterministic `avatarGradient`, `FONTS` = one family per weight. `useColors()` **forced to dark**. Shared primitives in `ui/kit.tsx`: `PrimaryButton` (gradient + `boxShadow` glow), `Brand` (wordmark filled with a gradient through `MaskedView`), `AvatarTile` (gradient tile), `UnreadBadge`.
  **Dependencies (ROADMAP §4.2)**: `expo-linear-gradient` (native Expo binding) and the `@expo-google-fonts/baloo-2`+`nunito` fonts **embedded natively** through the `expo-font` config plugin (7 `.ttf` weights): platform assets/bindings rendered by the native text engine, not a UI kit. `@react-native-masked-view` was **already there** (transitive from `expo-router`, autolinked: zero native modules added for the wordmark). `userInterfaceStyle:"dark"` + light `StatusBar` + dark native headers (Baloo 2 title), so as not to flash white during the screen-by-screen rollout.
  **Login screen** reskinned, **logic intact** (server→credentials→2FA phases, `inFlight` re-entrance guard, TOTP/email/password methods, `<Redirect>`): unicorn + rainbow bars + wordmark, pill field with a cyan ring, 2FA shield crest, decorative starry sky.
  **Review (xhigh, 6 finders + independent verify, 9 findings, all fixed)**: (0, CONFIRMED) `headerShown:false` **trapped** the `?change=1` route (no way back to the app in the server phase) → native header **kept on that route only** (back + accessible title); (1, CONFIRMED) padding moved onto the wrapping `View` → shrunk focus area → a `Pressable` that calls `focus()` on the input; (2, CONFIRMED) the "light switch in one toggle" comment lied (app.json + _layout also need touching) → fixed; (3) `UnreadBadge` without a zero guard → `null` if `n<1`; (4, CONFIRMED) `avatarGradient` summed the char codes (anagrams collided) → polynomial ×31 hash; (5) two avatar gradients exactly inverted → distinct pairs (dark + light); (6, CONFIRMED) the 2FA crest re-implemented the tile → `AvatarTile` gains a `deg` override, reused; (7, CONFIRMED) `StarrySky` re-rendered on every keystroke → `memo`; (8) focus ring hard-coded → derived from `c.cyan`. **Refuted**: `boxShadow` glow under `overflow:hidden` (the background is not clipped; the glow is visible on the capture); `start/end` constants inlined in the crest (pure style, moot after #6).
  Proven on the AVD (dev client, captures): Login **faithful** to the mockup (masked gradient wordmark, pink glow, cyan ring on focus, stars, Baloo 2/Nunito); the native back does appear on "changer de serveur" (change server); screens not yet reskinned (list…) stay readable in dark, without crashing. `tsc` clean, `lint` clean. Release build installed on the Pixel. The remaining screens in 9.2-9.4. Done: `2026-07-11`
- [x] **9.2 - Room list** · `@claude` · `[code]`: header with a DRAWN logo (headerShown:false: the native header does not render the gradient wordmark): unicorn + wordmark + ⚙️ (→ debug); "Nouvelle conversation" (new conversation) row with a gradient ＋ tile; room rows through `RoomAvatar` (kit): neutral padlock if encrypted, first letter for a DM, `#` for a channel; presence dot as an overlay (DM), unread `UnreadBadge` (nothing at zero), functional footer (account/server/FCM/logout) restyled. Proven on the AVD: list faithful to the mockup, avatars with a STABLE tint per name, encrypted as a grey tile + 🔒; no star for lack of unread messages in the test data (expected behaviour). `tsc`/`lint` green. Done: `2026-07-11`
- [x] **9.3 - Room (and thread)** · `@claude` · `[code]`: PRESENTATION only; the heavy machinery stays INTACT (inverted FlashList + mVCP off, keyset pagination `loadMore`/`passExhausted`, DDP subscriptions, outbox, drafts, emoji completion, smoothing, unread bar). Custom `RoomHeader` header (back with a `canGoBack() → replace('/')` fallback, `RoomAvatar`, name, subtitle = DM presence, 🔍); SHARED message row (`ui/messageRow.tsx`, room + thread) with `AvatarTile` + coloured username (first hue of its own gradient) + tertiary timestamp, thread chip as a pill; pink "✦ nouveaux messages" (new messages) separator; pill composer + circular `AvatarTile` as the 🎤/⏹/➤ button. **Review (high, 4 findings, all fixed)**: (1) custom back without an a11y role/label → `accessibilityRole="button"` + label; (2) the avatar initial became a TalkBack node (the row is `accessible={false}`) → subtree `importantForAccessibility="no-hide-descendants"`; (3) unconditional `back()`, dead on a cold deep link → fallback `canGoBack()`, otherwise `replace('/')`; (4) avatar logic duplicated between list and header → shared `RoomAvatar` (extracted in 9.2). Proven on the AVD: header, avatars + coloured usernames, system message in italics, pill composer, mic→send toggle (➤), typing without caret jumps, draft restored, clean back. `tsc`/`lint` green. Done: `2026-07-11`
- [x] **9.4 - Search & action sheet** · `@claude` · `[code]`: search field with a ring, sections with avatars; reaction bar and actions (edit/pin/delete) to the design.
  **Shipped continuously, outside the checklist** (the ceremony had been lifted): the search screens moved to the theme tokens (`useColors`/`FONTS`) with the shared `MessageRow`, and the action sheet became a **native bottom sheet** with haptic feedback (`0ec5477`), reactions included (workstream 11, `592f953`). Pixel fidelity to the mockup was never formally audited; if a gap bothers anyone, it is a touch-up, not a workstream. Done: `2026-07-31` (retroactive observation).

---

## After the checklist - shipped continuously (2026-07-11 → 2026-07-31)

> With the ceremony lifted, the product kept growing at the pace of "implement, verify,
> commit", about 140 commits. This record exists so that no future session
> reimplements or deletes shipped work; each entry cites one or two anchor
> commits, and `git log` carries the rest.

- **Media**: full-screen image viewer with zoom and gestures (`036b84f`, `a3d0abc`), showing the original rather than the 480 px thumbnail (`eccc576`), in-place video playback (`672d727`), voice-message player with an FFT visualiser (`f14ef3d`, `5fb4b9d`), preview cards for YouTube/Dailymotion/Vimeo video links (`fc8ed23`, `7896191`) and generic link previews from `message.urls` (`4c2fb3a`).
- **Attachments and sharing**: preview before sending (`30e1c85`), multi-file thumbnail strip (`7b83cab`), Android `ACTION_SEND` share target (`1a4957b`), "attach" sources menu as a native sheet (`6c406ee`) with the fix for the picker NPE (`c9e6694`, `e06f658`, `ad8ecec`).
- **Video calls (Jitsi)**: `video-conference.join` then the conference in a **WebView bounded to the call screen**, locked origin (`61fc7d4`, `2fa01fa`); availability probe built into opening the info sheet. The WebView exception is recorded in `ROADMAP.md` §4.2. Joining an existing call remains unverified end to end (debt from workstream 3).
- **E2EE reading**: decryption module and unlock engine (`0304124`, `c11fe26`, UI `0d48d93`), legacy v1 keys and AES-CBC `rc.v1`/`rc.v2` messages (`8917eb1`, `410353d`), decrypted previews and padlock in the list (`6d504b4`), crypto moved to the native `react-native-quick-crypto` module (`ead6c25`). Encrypted writing stays out of scope (`ROADMAP.md` §6.6).
- **i18n**: EN/FR foundation and language picker (`b03d273`), migration of the whole app to `t()` (`4dc5df6`), Settings screen (`ce59d26`).
- **Quotes**: reply by quoting through a long press (`d04b9ec`), quoted images and quotes of quotes, depth 2 (`b5d6ab5`); permalink based on `Site_Url` since workstream 15.
- **Multi-provider facade**: `Provider` contract (`fb194c9`), sync core made neutral through `Translator` (`5e84206`), actions behind `ActionsRC` (`4955bac`), assembly and driver selection by session kind (`59bc618`, `eb764a9`), later extended by workstreams 13 to 15 (subscriptions, history, threads).
- **Profiles and identities**: user sheet and room sheet as a preloaded formSheet (`f5d613b`, `fa0db00`, `696ee98`), "Mon profil" (my profile) screen (`a151a3d`), username resolution by uid (`87650b0`), avatar changes propagated everywhere (`d1936b9`, `f98d696`).
- **Hardened push**: conversation notifications grouped by room, `MessagingStyle` (`35d323c`); hidden content fetched through `push.get` with WorkManager catch-up (`5680702`, `57a615f`); dedup of FCM redelivery and a native logbook (`249887e`); deep link repaired, then multi-server (`597c142`, `e32160f`, workstream 10); rocket notification icon (`caeede6`).
- **Sync and performance**: purge of ghost rooms (`aacfe90`), reconciliation of offline deletions (`7d6c9e7`), capped cursor pagination of `chat.syncMessages` (`a19db98`, `ffe1f7c`), hot-room caches (history not reloaded, listening kept after closing; `93a10ce`, `d2d996d`), dead-socket probe (`6dae827`), connection ordered on a signal (`08e82b8`), coalescing of `useLiveQuery` bursts (`05215db`).
- **Composer**: `@username` mention autocompletion (`fcccb79`), emoji completion from a single letter and an emoji browser (`a4300dc`), panel that follows the keyboard (`0313574`).
- **Screens and theme, continuously**: real profile photos with a tile fallback (`7673f3a`), "horn-rocket" icon (`e8bbe6d`), sync comet bar (`c10d68e`), floating typing pill (`da5b704`), list in three sections (`4eff294`), unread capsule (`e50a177`), Material ripple on Pressables (`86f065b`).
- **The audit and the workstreams (2026-07-25 →)**: fan-out survey, 115 findings kept (`50c00dc`, `docs/AUDIT.md`), the `WORKSTREAMS.md` roadmap (`915cfb0`), then workstreams 1 to 16 closed between 2026-07-26 and 2026-07-31 (`3a57bae` → this commit). **`WORKSTREAMS.md` is authoritative on this phase**, residual debts included (kill gate 2.5b, end-to-end calls, visual checks on the Pixel).

---

## Step 10 - iOS

> Off the critical path. Ref. `ROADMAP.md` §5 phase 7. `@guillaume` prerequisites: a Mac, an Apple Developer account ($99/year).

- [ ] **10.1 - iOS `prebuild`** from the same config plugins · `@duo` · `[infra]`
- [ ] **10.2 - APNs push** with a Notification Service Extension · `@claude` · `[code]`
- [ ] **10.3 - Keychain access groups** · `@claude` · `[code]`

---

*Created 2026-07-09. Brought back in line with the code on 2026-07-31 (workstream 16). `ROADMAP.md` sets the decisions; this document tells the construction; `WORKSTREAMS.md` says what moves.*
