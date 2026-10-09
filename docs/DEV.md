# Development environment

## Getting started

```sh
git config core.hooksPath .githooks # once per clone, see below
source apps/mobile/scripts/env.sh   # RV_ENV_VERBOSE=1 to see what is exported
java -version                  # 17.0.19
adb devices
```

The script auto-detects the JDK and the Android SDK, and is **idempotent**: sourcing it several times does not stack `PATH` entries.

It **queries `javac -version`** instead of reading the directory name: `jdk1.8.0_171` contains "17" without being a JDK 17. It accepts majors 17 to 24 and keeps the most recent (`sort -V`, because lexically `jdk-17.0.9` sorts before `jdk-17.0.19`).

Overrides:

| Variable | Effect |
|---|---|
| `RV_JDK_HOME` | Bypasses JDK detection. |
| `RV_ANDROID_HOME` | Bypasses SDK detection. |
| `RV_ROOT_URL` | Pins `ROOT_URL` instead of deriving it from the LAN IP. |
| `RV_ENV_VERBOSE=1` | Prints what is exported. |

The `.githooks/pre-commit` hook regenerates the Rocket.Chat inventory (`docs/protocol/rocketchat-inventory.*`) whenever a commit touches a file it scans, from the staged content only, and adds it to the commit: CI's `inventory-rocketchat.mjs --check` fails on an inventory a moved line made stale. It needs `apps/mobile/node_modules` (`npm ci`); without it, it warns and lets the commit through.

`ROOT_URL` is **recomputed on every source**, because the LAN IP changes (DHCP, VPN, Wi-Fi to Ethernet) and a stale `ROOT_URL` would silently point at the old network. Without a default route, it is **left undefined**, rather than being `http://:3000`.

## The build chain, and why it works as is

The `@react-native-community/template@0.86.0` template requires:

| Requirement | Value | Local status |
|---|---|---|
| `buildToolsVersion` | 36.0.0 | installed |
| `compileSdk` / `targetSdk` | 36 | `platforms/android-36` |
| `minSdk` | 24 | - |
| `ndkVersion` | 27.1.12297006 | installed at the exact version |
| Gradle | 9.3.1 | downloaded by the wrapper |
| `sourceCompatibility` | `VERSION_17` | Temurin 17.0.19 |

**JDK 21 is not required.** Gradle 9.3.1 accepts Java 17 to 24, and React Native pins `sourceCompatibility = VERSION_17`.

## Network

`ROOT_URL` points at the machine's **LAN IP**, not at `10.0.2.2`. Two reasons: a physical device must reach the server, and `ROOT_URL` shapes notification payloads and deep links, so it cannot be both at once.

For the emulator, forward the port rather than changing `ROOT_URL`:

```sh
adb reverse tcp:3000 tcp:3000
```

## Emulator

```sh
emulator -avd duogo_test -no-audio -no-boot-anim -gpu auto &
adb wait-for-device
adb shell getprop sys.boot_completed   # 1 = ready
adb exec-out screencap -p > /tmp/screen.png
```

The `duogo_test` AVD is a Pixel 7, `android-36`, `google_apis` image (x86_64).

Two remarks:

- The `google_apis` image ships **Google Play Services**, which FCM requires. The emulator can therefore validate the push chain (Firebase → server → token → delivery). It reproduces neither Doze nor the process kill, though: the binary criterion of the *kill gate* stays on a physical device.
- `hw.ramSize = 1536M` is a bit tight for Hermes and the bundler. Raise it to `4096` in `~/.android/avd/duogo_test.avd/config.ini` if the bundle crawls.

## Rocket.Chat development server

```sh
cd docker && cp .env.example .env && chmod 600 .env   # fill in ADMIN_PASS
node patch-push.mjs                                   # bundle patched for push, see docs/PUSH.md
docker compose up -d
curl -sf "$ROOT_URL/api/info"                          # {"version":"8.5",...}
```

Pinned to **Rocket.Chat 8.5.1** (the version of `chat.barrut.me`), not to the latest release (8.6.0). Sticking to production avoids API gaps that get paid for at the end. 8.5 is an LTS supported until 2027-06-30.

**MongoDB 8.0 is mandatory**: `https://releases.rocket.chat/8.5.1/info` returns `compatibleMongoVersions: ["8.0"]`. The 6 and 7 series are no longer supported since 8.2.

The **replica set is mandatory**, even with a single node: Rocket.Chat relies on MongoDB *change streams*, which do not exist on a standalone `mongod`. The `mongodb` service's healthcheck initiates the replica set itself, then only turns green once the node is `PRIMARY`: that is what guarantees Rocket.Chat does not start too early.

`MONGO_OPLOG_URL` is **not** set: the variable was removed in 8.0.0.

`ROOT_URL` and `ADMIN_PASS` use the `${VAR:?message}` form: a `docker compose up` without `.env` fails immediately, instead of creating an `admin` account without a password on a server exposed to the LAN.

### Test data

```sh
node scripts/seed.mjs
```

Creates `alice` and `bob`, the public channel `test-public`, the private group `test-prive`, a direct message, 12 messages per room and a thread of 3 replies.

The script is **idempotent, even after an interruption**. Each seeded message carries a `[seed i/12]` marker: a rerun reads the history, computes the missing indices and posts only those. All-or-nothing idempotence ("this room already has messages, skip it") would freeze a room interrupted at 7 messages out of 12 forever.

## Mattermost development server

The protocol it speaks is in [MATTERMOST.md](MATTERMOST.md). The Mattermost (kChat) provider has its own bench: the `mattermost-preview` image, which bundles its database.

```sh
docker compose -f docker/compose.mattermost.yml up -d    # http://localhost:8065
node scripts/seed-mattermost.mjs
```

The seed creates `rvadmin` (the first account, so system admin), `bob` and `carol`, all with the password `Rv-bench-2026!` (override with `MM_PASSWORD`, the URL with `MM_URL`); the team `rv` with its default channels plus `dev` (public) and `secret` (private); a DM between `rvadmin` and `bob`; 12 posts per room and a thread of 3 replies. Idempotent like `seed.mjs`: `[seed i/12]` markers, accounts, team and channels looked up before being created. From the emulator the server is `http://10.0.2.2:8065`, typed with its `http://` (without a scheme the login assumes `https://`).

There is no kChat bench: Infomaniak's server is not public. kChat is exercised by its unit tests and by a real kSuite account.

## DDP spike verdict (step 1.7, uncertainty #2)

`node scripts/spike-ddp.mjs` against the 8.5 Docker server, two WebSocket connections (one anonymous, one authenticated):

- **DDP login is mandatory for any subscription**, including on a **public** channel: without it, `sub stream-room-messages` answers `nosub: not-allowed`. The step 3.3 client will therefore always do `connect` → `method login {resume}` → `sub`, with no anonymous degraded mode to plan for.
- **The same token serves both transports**: `method login {resume: <REST authToken>}` is accepted as is. No second secret to store.
- Real time proven: a message posted via REST arrives through `stream-room-messages` (collection = stream name, key in `fields.eventName`, payload in `fields.args[0]`), and `stream-notify-user <uid>/subscriptions-changed` is emitted right after.
- Node 22+'s **global** `WebSocket` (browser API, the same as React Native) is enough: handshake `{"msg":"connect","version":"1","support":["1"]}`, `ping`/`pong`, `sub`/`ready`/`nosub`.

## What the target server says (`chat.barrut.me`, surveyed without authentication)

| Setting | Value | Consequence |
|---|---|---|
| `version` | `8.5` | `rooms.upload` removed, DDP method calls deprecated. |
| `cloudWorkspaceId` | present | The workspace **is registered on Rocket.Chat Cloud**: the official Push Gateway is active, it will have to be disabled. |
| `Accounts_TwoFactorAuthentication_Enabled` | `true` | 2FA mandatory from step 3.2. |
| `..._By_TOTP_Enabled` / `..._By_Email_Enabled` | `true` / `false` | Only TOTP needs implementing, plus the password fallback. |
| OAuth, SAML, CAS, LDAP | all inactive | **No SSO workstream** in v1. |
| `E2E_Enable` | `true` | A room flagged `encrypted` will be unreadable and closed to writing. To be decided. |
| `E2E_Allow_Unencrypted_Messages` | `false` | The server **rejects** a plaintext message in an encrypted room. |
| `E2E_Enabled_Default_PrivateRooms` | `false` | New private rooms are not encrypted by default. |
| `FileUpload_ProtectFiles` | `true` | Files reachable only when authenticated (`rc_uid`/`rc_token`). |
| `Accounts_AvatarBlockUnauthenticatedAccess` | `true` | Avatars too. |
| `Presence_broadcast_disabled` | `false` | Presence works. |
| `Message_AllowEditing_BlockEditInMinutes` | `0` | No time limit on editing. |

## The app

```sh
cd apps/mobile
npm run typecheck     # tsc --noEmit, strict
npm run lint          # expo lint
npm run prebuild      # expo prebuild --platform android --clean
npm run android       # expo run:android
```

Expo **SDK 57** (React Native 0.86, React 19.2.3), `expo-router` on the native stack of `react-native-screens`.

The skeleton comes from the **`blank-typescript`** template, not `default`: the latter adds a tabbed demo screen and unrequested dependencies. Every dependency is chosen, not endured.

**Correction of an initial claim.** I first wrote that this choice avoided `react-native-reanimated`. That is wrong: `expo-router@57.0.4` depends on it **directly** (and on `react-native-worklets`), as `npm ls react-native-reanimated` shows. Reanimated is therefore present whatever the template, and the Gradle build compiles it. The 25 to 30% memory regression introduced by RN 0.85 applies, and cannot be avoided as long as we use `expo-router`. To watch when profiling; getting rid of it would mean dropping `expo-router` for bare `react-navigation`, which is probably not worth the price.

`applicationId` = `com.rocketvibe.app`. It must match the `package_name` declared in the Firebase project **exactly**, otherwise the GMS Gradle plugin refuses to build.

### Plain HTTP: nothing to do

Android blocks cleartext traffic since `targetSdk 28`, and the dev server is on `http://`. **Expo already handles it**: `prebuild` generates `android/app/src/debug/AndroidManifest.xml` with `usesCleartextTraffic="true"` (plus the `SYSTEM_ALERT_WINDOW` permission for the LogBox overlay). AGP merges this overlay only into the `debug` variant: the `src/main` manifest contains none of it, so the **release stays safe by construction**.

Add **neither** `expo-build-properties` with `usesCleartextTraffic` (it would enable it in release too), **nor** a config plugin that rewrites `src/debug/AndroidManifest.xml`: it would overwrite Expo's file and drop `SYSTEM_ALERT_WINDOW`. Check before acting:

```sh
grep -c usesCleartextTraffic android/app/src/main/AndroidManifest.xml   # 0
grep -c usesCleartextTraffic android/app/src/debug/AndroidManifest.xml  # 1
```

### The `react-dom` override

`expo-router` pulls `react-dom@19.2.7`, which requires `react ^19.2.7`, while Expo SDK 57 pins `react@19.2.3`. Every install fails with `ERESOLVE`. We do not target the web, `react-dom` is only a transitive dependency: we align it on `react` rather than resorting to `--legacy-peer-deps`, which would hide the inconsistency.

```json
"overrides": { "react-dom": "$react" }
```

The `$react` form references the version of the direct `react` dependency: the alignment maintains itself across SDK upgrades. A hard-coded version would drift silently, and would mix two React versions in the devtools bundle.

## iOS

Never compiled to date: everything below was prepared under Linux. iOS push has its own section in `docs/PUSH.md`.

**Build, on a Mac** (Xcode, CocoaPods, an Apple Developer account):

```sh
cd apps/mobile
npx expo prebuild --platform ios      # regenerates ios/ and runs pod install
open ios/rocketvibe.xcworkspace
```

Three targets: `rocketvibe`, `NotificationService` (push, `plugins/with-ios-push.js`) and `ShareExtension` (sharing into the app, expo-share-intent). On all three, Signing & Capabilities → choose the team, or set `ios.appleTeamId` in `app.json`. Automatic signing registers the identifiers of both extensions and the share extension's app group `group.com.rocketvibe.app`.

**What was adapted to iOS**, because the code only targeted Android:

| Topic | Fix |
|---|---|
| Fonts | iOS resolves `fontFamily` by PostScript name (`Baloo2-SemiBold`), Android by file name: `FONTS` picks per platform (`ui/theme.ts`). |
| Touch feedback | `android_ripple` is ignored on iOS: `ui/tappable.tsx` dims the pressed element. |
| Video compression | `video-compressor` has a Swift half (AVFoundation, `AVAssetReader` → `AVAssetWriter`): same output as Media3 on Android, H.264 MP4 at the requested bitrate, short side capped. |
| Downloads | `Downloads` is `null` (iOS has no public folder): "Save" on a file opens the share sheet, which offers "Save to Files". |
| Voice messages | Audio session: recording allowed while recording, playback despite the silent switch (`ui/composer.tsx`, `app/_layout.tsx`). |
| Toasts | `ToastAndroid` does nothing on iOS: a toast drawn by the app (`ui/toast.tsx`). |
| Bottom sheets | Bottom margin above the home indicator (`ui/sheetMargin.ts`). |
| Photo library | Requests JPEG / H.264 instead of HEIC / HEVC, unreadable in a browser. |
| Sharing into the app | Share extension enabled; `app/+native-intent.tsx` keeps its `rocketvibe://dataUrl=…` URL away from expo-router. |
| Permission texts | Camera and microphone cover calls and voice messages; photo library (write) and local network added. |

Checked under Linux: `expo prebuild --platform ios --no-install` (targets, entitlements, Info.plist), `tsc`, the tests, ESLint, and the iOS JS bundle (`expo export --platform ios`).

**First run on an iPhone, to watch**: the fonts (titles in Baloo 2), a voice message recorded then played back with the phone on silent, sharing a photo from Photos, a Jitsi call (camera and microphone), a "Saved" file, and the keyboard under a bottom sheet (keyboard tracking measures from the bottom of the window).

## Tools

`docker` and `docker compose` are available, daemon reachable without `sudo`. `jq` is missing: the scripts use `node` to read JSON.
