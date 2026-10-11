# Android app updates

Android checks the public GitHub releases for a newer mobile APK and installs it through Android's package installer. Checks, downloads and installation are app-wide, independent of chat accounts. The first APK containing the updater still needs installation through the existing APK distribution path. This updates the full application, including native code; there is no JS OTA service.

## Mobile

`ui/appUpdates.tsx` owns one subscribable store. `AppUpdateHost` in the root layout initializes native state and persisted preferences, checks on foreground/startup at most every six hours, and shows a dismissible notice for a newer version. It never automatically downloads or installs. Settings > App embeds `AppUpdatesCard`; the notice opens `/app-update`, which is accessible before login. Both views share Check for updates, automatic checks, version, release notes, download progress/Cancel, install-source permission, Install and retry states. English/French strings live in `ui/messages.ts`.

Preferences (`app-updates.json` in the document directory) persist the last successful check, retry time, dismissed version and latest offer. An explicit check can show a dismissed version, but respects a server retry time. Cached offers are revalidated against the installed version and current release rules after restart. Per-page API ETags and compact release data live in the app cache. Check failures never become Up to date, and automatic failures stay unobtrusive.

`lib/appUpdates.ts` reads the public release list in pages of 100, up to five pages. It accepts published stable `mobile-vX.Y.Z` tags, compares numeric tuples and selects the newest version before validating its asset. Pagination reaching its bound fails the check rather than claiming there is no update. The exact asset name/path, uploaded state, positive bounded size and SHA-256 digest are required. An unusable newest release offers its release page, never an older APK. No GitHub token or chat credentials travel with requests. Today's release workflow publishes arm64-v8a only; other devices receive an unsupported-device message.

The Android-only local Expo module `modules/app-updater` streams an APK into its own private `files/app-updater` directory. The same `VerifiedDownload` routine checks size, SHA-256 and cancellation for downloads and revalidates staged files before installation. It also checks package identity, advertised version, strictly higher Android versionCode, minimum SDK, native ABI and the existing single signing key. Android performs the final APK signature/replacement validation. Different signing keys do not trigger uninstall or data deletion.

The module manifest merges `REQUEST_INSTALL_PACKAGES`, a non-exported result receiver and confirmation activity through CNG. `canRequestPackageInstalls()` is checked before committing; Android's app-specific trusted-source settings open only on the user's action. A verified APK goes into a `PackageInstaller` session, fsyncs and commits to an explicit mutable result PendingIntent. Android 12+ sessions require user action. Installation is refused while a native voice session is active or the app is not foregrounded. The current implementation does not request silent-update privileges.

Session ID, target APK version/code, checksum, size and result state persist in native SharedPreferences before commit. The receiver handles confirmation, success, cancellation and failure without a JS runtime. A pending confirmation gets a native notification; foreground users also see Android's confirmation immediately. The notification's OS-held PendingIntent remains usable after process death. On return, the app refreshes permission/session state; an interrupted confirmation can be cancelled and retried. A successful replacement may terminate the old process, so the next launch reconciles the installed code and removes stale staging state. Normal package replacement retains local data; the updater never uninstalls the app.

iOS has no APK installation API and this module is absent there. A config/native module change requires a clean prebuild and native rebuild, not a Metro reload.

## Desktop

GTK already has [its own updater](desktop-updates.md), with platform-specific installation. SwiftUI has no updater yet. The Android module does not change either implementation.

## Web

The server delivers browser assets; refreshing the served client maps the update need without installing an APK. See [web client](web-client.md).

## Qualification

The implementation and validation record are tracked in [RFC 0006](../../docs/rfcs/0006-android-in-app-updates.md). Device replacement, retained sessions/data and native permission behavior are separate from pure discovery tests. Production GitHub APKs are arm64-only, so emulator fixtures need compatible, same-key APKs. A real arm64 upgrade remains required before claiming that production-device path qualified.

## Sources

- apps/mobile/plugins/with-expo-package-list.js

- apps/mobile/lib/appUpdates.ts
- apps/mobile/lib/appUpdates.test.ts
- apps/mobile/ui/appUpdates.tsx
- apps/mobile/ui/messages.ts
- apps/mobile/ui/settingsSections.tsx
- apps/mobile/app/app-update.tsx
- apps/mobile/app/_layout.tsx
- apps/mobile/modules/app-updater/index.ts
- apps/mobile/modules/app-updater/expo-module.config.json
- apps/mobile/modules/app-updater/android/src/main/AndroidManifest.xml
- apps/mobile/modules/app-updater/android/src/main/java/com/rocketvibe/updater/AppUpdaterModule.kt
- apps/mobile/modules/app-updater/android/src/main/java/com/rocketvibe/updater/UpdateResultReceiver.kt
- apps/mobile/modules/app-updater/android/src/main/java/com/rocketvibe/updater/VerifiedDownload.kt
- apps/mobile/modules/app-updater/android/src/test/java/com/rocketvibe/updater/VerifiedDownloadTest.kt
- .github/workflows/mobile.yml
- scripts/version.mjs
