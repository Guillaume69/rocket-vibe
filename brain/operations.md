# Operations

How to set up a machine, run the shared Rocket.Chat test server, build and run each app, and how CI, versions, releases and secrets work. Everything is local: the mobile app builds with `expo prebuild` and Gradle (never EAS), the desktop app inside a Fedora container.

## Environment (`apps/mobile/scripts/env.sh`)

`source apps/mobile/scripts/env.sh` prepares a shell for Android work. It is idempotent (PATH entries are not stacked) and:

- finds a JDK 17 to 24 by asking `javac -version`, not by reading the directory name (`jdk1.8.0_171` contains "17"), newest first with `sort -V`, under `~/android-build` then `/usr/lib/jvm`;
- finds the Android SDK in `~/Android/Sdk`, `~/Android/sdk` or `/opt/android-sdk`;
- exports `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and prepends `platform-tools`, `emulator` and `cmdline-tools/latest/bin` to `PATH`;
- recomputes `ROOT_URL=http://<LAN IP>:3000` on every source (the IP changes with DHCP, VPN, Wi-Fi), exports `RV_LAN_IP`, and leaves `ROOT_URL` unset rather than `http://:3000` when there is no default route;
- sources `~/.config/rocket-vibe/signature.env` when present (the release signing key, see Secrets).

Overrides: `RV_JDK_HOME`, `RV_ANDROID_HOME`, `RV_ROOT_URL`; `RV_ENV_VERBOSE=1` prints what was exported. The script fails (returns 1) when no JDK or SDK is found.

`ROOT_URL` is the LAN IP, not `10.0.2.2`, because a physical phone must reach the server and Rocket.Chat builds push payloads and deep links from it. The emulator reaches it with `adb reverse tcp:3000 tcp:3000`. The reference AVD is `duogo_test` (Pixel 7, android-36, `google_apis` x86_64, so FCM works).

## Test server (`docker/`)

```sh
cd docker && cp .env.example .env && chmod 600 .env   # set ROOT_URL and ADMIN_PASS
node patch-push.mjs                                    # once per RC_VERSION
docker compose up -d
curl -sf "$ROOT_URL/api/info"                          # {"version":"8.5",...}
node ../scripts/seed.mjs
```

- `compose.yml` runs Rocket.Chat `8.5.1` and MongoDB `8.0` as project `rocket-vibe`. MongoDB's healthcheck initiates replica set `rs0` itself, only on error code 94 (`NotYetInitialized`), and turns healthy once the node is `PRIMARY`; Rocket.Chat waits for that.
- `ROOT_URL` and `ADMIN_PASS` use `${VAR:?message}`: `up` fails at once without `docker/.env` instead of creating an `admin` account with an empty password on a LAN-exposed server.
- `OVERWRITE_SETTING_Show_Setup_Wizard=completed` gets the admin UI past the setup wizard. Settings meant to be toggled during tests (2FA, `Push_*`, E2E) deliberately have no `OVERWRITE_SETTING_`.
- `MONGO_OPLOG_URL` is absent on purpose: removed in 8.0.0.
- On a Linux kernel 6.19 or later set `MONGODB_VERSION=8.0.4-ubi8` in `.env`: mongod 8.0.5+ refuses to start there.

### The push-patched bundle (`docker/patch-push.mjs`)

The compose file bind-mounts `docker/patched/app-${RC_VERSION}.js` over the server bundle with `create_host_path: false`, so **`up` fails until `node docker/patch-push.mjs` has been run for that version** (output gitignored). The script extracts `app.js` from the image and applies two edits, each anchored on a snippet that must appear exactly once and keeping the line count so `app.js.map` stays aligned: gateway routing skips tokens whose `appName` is `rocket-vibe` (ours go native through our Firebase project, the official apps keep the gateway), and an `apns` block (`mutable-content`, `thread-id`) is added to the FCM message. `node docker/patch-push.mjs <image:tag>` patches another image, such as production's. Details in [features/notifications.md](features/notifications.md).

### Seed data (`scripts/seed.mjs`)

Reads `docker/.env` (it is authoritative: a different `$ROOT_URL` in the shell only triggers a warning), logs in as the admin and creates, idempotently:

- users `alice` / `alice-dev-2026` and `bob` / `bob-dev-2026`, created unverified so email 2FA never locks them out;
- public channel `test-public` (alice, bob), private group `test-prive` (alice), a DM with alice;
- custom emoji `party_parrot` (animated GIF, alias `parrot`) and `shipit` (PNG), from `scripts/emojis-seed.mjs`;
- 12 messages in each of the three rooms and a thread of 3 replies in `test-public`.

Each message carries a `[seed i/n]` marker; a rerun reads the history and posts only the missing indices, so a run killed halfway resumes. REST 429s are retried using `x-ratelimit-reset`. `npm run seed` in `apps/mobile` runs the same script. `scripts/spike-ddp.mjs` is the throwaway phase-0 DDP spike, kept for reference.

## Mobile: build and run

All commands run from `apps/mobile/`.

```sh
npm install                 # postinstall runs patch-package
source scripts/env.sh
npm run prebuild            # expo prebuild --platform android --clean: regenerates android/
npm run android             # expo run:android: debug build, install, start Metro
npm start                   # Metro only (expo start --dev-client)
```

- `android/` and `ios/` are gitignored and wiped by every prebuild; native changes go through config plugins in `plugins/`. Adding or changing a native module needs a prebuild and a Gradle build, not a Metro reload.
- `google-services.json` must sit in `apps/mobile/` (referenced by `app.json`), its `package_name` equal to `com.rocketvibe.app`, or the GMS Gradle plugin refuses to build.
- Cleartext HTTP is allowed only in the debug variant (Expo's generated `src/debug/AndroidManifest.xml`). A release APK cannot reach `http://…:3000`: use a debug build and Metro against the local server.
- Release: `source scripts/env.sh && cd android && ./gradlew assembleRelease`, then `adb install -r app/build/outputs/apk/release/app-release.apk`. `plugins/with-signature-release.js` signs with the app's own key from `RV_KEYSTORE*` and makes any Release task fail when `RV_KEYSTORE` is empty, rather than falling back to the debug key (an APK signed with another key will not install over the previous one).
- Checks: `npx tsc --noEmit` (or `npm run typecheck`), `npm run lint`, `npm test`. `npm run db:generate` regenerates Drizzle migrations; `npm run emojis:generate` the emoji table.
- iOS has never been compiled; it is prepared for `npx expo prebuild --platform ios` on a Mac (see `docs/DEV.md`).

Pipes hide exit codes in zsh scripts: for a Gradle build, redirect to a file and test `$?`, or `set -o pipefail`.

## Desktop: build and run

All commands run from `apps/desktop/`.

| Command | What it does |
|---|---|
| `scripts/build.sh` | Builds image `rocket-vibe-rs-build` from `docker/Dockerfile` (Fedora 44), caches cargo in volume `rv-cargo`, then runs `cargo fmt --check`, `clippy --workspace --all-targets -D warnings`, `cargo test --workspace`, `cargo build --workspace`. `PROFILE=release` switches the profile. |
| `./target/debug/rocket-vibe-gtk` | Runs on a host with the container's GTK and libadwaita (a Fedora 44 host). |
| `scripts/install-desktop.sh` | After `PROFILE=release scripts/build.sh`: installs a launcher entry pointing at this checkout's release binary, icons, and the `rocketvibe://` handler. |
| `scripts/smoke.sh`, `scripts/e2e.sh`, `scripts/e2e-actions.sh`, `scripts/coverage.sh` | Headless runs and coverage in the build image, see [architecture/testing.md](architecture/testing.md). |
| `scripts/package-appimage.sh` | The AppImage, built in pkgforge-dev's Arch image (`scripts/appimage-build.sh`): quick-sharun bundles every loaded library, glibc included, plus dictionaries and the emoji font. Output `dist/rocket-vibe-desktop-<version>-linux-x86_64.AppImage`. |
| `scripts/package-windows.sh <version>` | In an MSYS2 UCRT64 shell after a release build: a self-contained folder and zip (DLLs, GStreamer plugins, schemas, icons, `WebView2Loader.dll`). The Inno Setup script is `data/windows/rocket-vibe.iss`. |
| `scripts/package-macos.sh <version>` | On macOS with Homebrew: `rocket-vibe.app` with its libraries rewritten by dylibbundler (fails if anything still points into Homebrew), signed with `MACOS_SIGN_IDENTITY` or ad hoc, in a DMG. |
| `scripts/install.sh` | End-user Linux install, no root: downloads the newest `desktop-v*` release's AppImage to `~/.local/bin/rocket-vibe.AppImage`, adds a launcher entry, icons and the link handler; `--uninstall` removes them but keeps accounts and messages in `~/.config/rocket-vibe-rs` and `~/.local/share/rocket-vibe-rs`. |
| `node scripts/generate-emojis.mjs [emoji-toolkit dir]` | Regenerates `crates/rv-core/data/emojis.tsv`. |

The SwiftUI app (`apps/desktop/macos/`): `scripts/generate.sh` builds rv-ffi and writes the Swift bindings and C header (gitignored) and prints the library dir; then `swift build`, `swift test`, `swift run rv-rooms`. `scripts/check-linux.sh` builds and tests every non-AppKit target in the `swift:6.1-noble` container. `scripts/package.sh <version>` makes the signed `rocket-vibe SwiftUI.app` and its DMG.

Runtime files: config in `~/.config/rocket-vibe-rs`, data in `~/.local/share/rocket-vibe-rs`, cache (including `crash.log`) in `~/.cache/rocket-vibe-rs`; on Windows the log is `%LOCALAPPDATA%\rocket-vibe-rs\rocket-vibe.log`.

## CI (`.github/workflows/`)

Each workflow runs only when its app's files, `scripts/version.mjs` or the workflow itself change. A push or PR only checks; packages are built on a release tag or a manual `workflow_dispatch`.

| Workflow | Triggers | Always | Tag or dispatch only |
|---|---|---|---|
| `mobile.yml` | push to `master`, tags `mobile-v*`, PRs, dispatch | `check`: version check, `npm ci`, `tsc --noEmit`, `npm run lint`, `npm test` | `android`: SDK pieces, `google-services.json` and keystore from secrets, `expo prebuild`, `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` with ccache, `apksigner verify`, artifact `rocket-vibe-mobile-<v>.apk`; `release` on a tag |
| `desktop.yml` | push to `master`, tags `desktop-v*`, PRs, dispatch | `version`; `linux` in `fedora:44`: fmt, clippy `-D warnings`, `cargo test --workspace` | release build and `.tar.gz`; `appimage` and `appimage-smoke` (the AppImage on `ubuntu:22.04` with no GTK: gallery, 3 media must play); `windows` (rv-core tests, release build, zip, Inno Setup installer, then an install, launch, background start, autostart, gallery, call window, player and soak round trip, and uninstall); `macos` (rv-core tests, release build, signing, notarization, Gatekeeper check, then the bundle started with Homebrew moved aside); `macos-swiftui` (calls `desktop-swiftui.yml`); `release` on a tag |
| `desktop-swiftui.yml` | pushes to branches other than `master` touching `macos/`, `rv-ffi` or itself; `workflow_call`; dispatch | On `macos-15`: generate bindings, `swift build`, `swift test`, `swift run rv-rooms`, sign, package, notarize, start the app (login, gallery, 45 s soak, scroll benchmark reported as a trend) | |

Path filters do not apply to tag pushes, so a release tag always builds. Maestro and the desktop e2e scripts need a live server and do not run in CI.

## Versions and changelogs

- `node scripts/version.mjs mobile|desktop [--tag <tag>]` prints the version. For mobile it fails unless `package.json` equals `app.json` and `android.versionCode == major*10000 + minor*100 + patch` (so each release installs over the last); for desktop it reads `[workspace.package] version`. With `--tag` the tag must be exactly `<app>-v<version>`.
- `node scripts/changelog.mjs mobile|desktop <version>` prints that version's section of `apps/<app>/CHANGELOG.md` (Keep a Changelog) and fails if it is missing or empty.
- Every user-visible change goes under `## [Unreleased]` in that app's changelog, in English.

## Release flow

1. Move the unreleased section under `## [X.Y.Z] - <date>` and update the compare links.
2. Bump the version: mobile in `app.json` (`version` and `android.versionCode`) and `package.json`; desktop in `Cargo.toml`, and refresh `Cargo.lock` (CI builds with `--locked`).
3. Commit, merge to `master`, push a tag `mobile-vX.Y.Z` or `desktop-vX.Y.Z`.
4. The workflow checks tag against version and the changelog section first, builds every package, then `softprops/action-gh-release` creates "Mobile X.Y.Z" (the APK) or "Desktop X.Y.Z" (`.tar.gz`, `.AppImage`, `.zip`, `-setup.exe`, the GTK and SwiftUI `.dmg`) with the changelog section as notes.

The desktop app updates itself from these GitHub releases, see [features/desktop-updates.md](features/desktop-updates.md).

## Secrets

Nothing secret is committed. Gitignored at the root and in `apps/mobile`: `.env`, `.env.local`, `google-services.json`, `GoogleService-Info.plist`, `*-service-account*.json`, `*firebase-adminsdk*.json`, plus `*.keystore`, `*.apk`, `*.aab` in mobile.

| Secret | Local home | CI secret |
|---|---|---|
| Test server admin password and `ROOT_URL` | `docker/.env` (`chmod 600`) | none |
| Firebase Android config | `apps/mobile/google-services.json` | `GOOGLE_SERVICES_JSON` |
| Firebase iOS config | `apps/mobile/GoogleService-Info.plist` | none |
| Android release key | `~/.config/rocket-vibe/release.keystore` and `signature.env` (`RV_KEYSTORE`, `RV_KEYSTORE_PASSWORD`, `RV_KEY_ALIAS`, `RV_KEY_PASSWORD`) | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` (used for both passwords, alias `rocket-vibe`) |
| Apple Developer ID certificate | `~/.config/rocket-vibe/apple/` | `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD` |
| App Store Connect API key (notarization) | `~/.config/rocket-vibe/apple/` | `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID` |
| Firebase service account (server side) | pasted into the server setting `Push_google_api_credentials` | none |

The mobile Android job fails loudly without its two secrets. Without the Apple secrets, the macOS jobs sign ad hoc and skip notarization. The release keystore and the Apple certificate's private key cannot be recovered: losing the keystore means no update installs over existing APKs. Desktop session tokens live in the system keychain (Secret Service on Linux), mobile ones in `expo-secure-store`.

## Sources

- `apps/mobile/scripts/env.sh`
- `docker/compose.yml`
- `docker/.env.example`
- `docker/patch-push.mjs`
- `scripts/seed.mjs`
- `scripts/emojis-seed.mjs`
- `scripts/spike-ddp.mjs`
- `scripts/version.mjs`
- `scripts/changelog.mjs`
- `apps/mobile/package.json`
- `apps/mobile/app.json`
- `apps/mobile/.gitignore`
- `apps/mobile/plugins/with-signature-release.js`
- `apps/desktop/scripts/build.sh`
- `apps/desktop/scripts/install-desktop.sh`
- `apps/desktop/scripts/install.sh`
- `apps/desktop/scripts/package-appimage.sh`
- `apps/desktop/scripts/appimage-build.sh`
- `apps/desktop/scripts/package-windows.sh`
- `apps/desktop/scripts/package-macos.sh`
- `apps/desktop/scripts/generate-emojis.mjs`
- `apps/desktop/data/windows/rocket-vibe.iss`
- `apps/desktop/macos/scripts/generate.sh`
- `apps/desktop/macos/scripts/check-linux.sh`
- `apps/desktop/macos/scripts/package.sh`
- `apps/mobile/CHANGELOG.md`
- `apps/desktop/CHANGELOG.md`
- `.github/workflows/mobile.yml`
- `.github/workflows/desktop.yml`
- `.github/workflows/desktop-swiftui.yml`
- `.gitignore`
- `docs/DEV.md`
- `docs/PUSH.md`
