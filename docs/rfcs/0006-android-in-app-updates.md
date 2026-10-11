# RFC 0006: Android updates from GitHub releases

Status: implemented on `codex/android-in-app-update-research`; validation and remaining device qualification below. The release workflow is unchanged.
Date: 2026-10-11.
Research branch: `codex/android-in-app-update-research`.
Inspected worktree base: `db521ac9b2445eaa2579933a8fe0dbbb2698b49a`.

## Conclusion

Yes. The GitHub-distributed Android APK can discover a newer mobile release, download it inside the app, verify its digest, and ask Android to replace the installed package. Recommend an explicit Download and install action followed by the system confirmation flow. This needs a small Kotlin Expo module and native rebuild, with no new third-party updater dependency, EAS, WebView or app server endpoint.

The first APK containing the updater must still be installed through the existing distribution method. It can then update itself to later compatible releases. A release signed with a different key cannot replace the installed app; uninstalling to work around this would remove application data and is not part of the updater.

## Evidence from this repository

| Existing mechanism | Implication |
|---|---|
| `apps/mobile/app.json`: `com.rocketvibe.app`, version `0.10.0`, Android versionCode `1000` | Keep the package identity; obtain the installed version and versionCode from Android for update decisions. |
| `scripts/version.mjs`: versionCode = major * 10000 + minor * 100 + patch | Existing releases have an increasing build number in the current version range. Minor and patch components must stay below 100 for this encoding to remain monotonic across carries. |
| `.github/workflows/mobile.yml`: `mobile-v*` tags, signed `assembleRelease`, one `rocket-vibe-mobile-X.Y.Z.apk` | Existing release assets are directly consumable. CI currently builds arm64-v8a only. |
| `plugins/with-signature-release.js`: dedicated release key, fails without it | The signing design supports replacement updates. Compatibility with any particular installed APK still needs a device check. |
| `apps/desktop/crates/rv-core/src/update.rs` and `rv-gtk/src/updater.rs` | Reuse the product conventions: app-specific tags, numeric versions, periodic checks, manual check, dismiss a version, release notes. Implement Android installation separately. |
| `apps/mobile/ui/settingsSections.tsx`, `AppCategory` | Natural home for Check for updates, the installed version, progress, Retry, and the automatic-check switch. |
| `apps/mobile/modules/downloads/` | Existing Kotlin local-module pattern. This module saves files to public Downloads; it does not install APKs. |
| `apps/mobile/app/_layout.tsx` | An app-wide update host can operate independently of chat accounts and providers. |

### Live unauthenticated GitHub probe

On 2026-10-11, the public repository and release-list API both answered without credentials:

- Repository: `Guillaume69/rocket-vibe`, public.
- First release-list entry: `web-v0.3.0`. A repository-wide latest-release lookup is unsuitable for selecting Android updates.
- 31 release entries returned, including 12 published stable mobile releases.
- Newest published stable mobile release in the returned list: `mobile-v0.9.1`, published `2026-10-09T11:30:23Z`.
- APK: `rocket-vibe-mobile-0.9.1.apk`, uploaded, 93,870,489 bytes (about 89.5 MiB).
- GitHub asset digest: `sha256:02bb936a16dac1d773cbdbb2e21427a230e8274488d722ee36653c5470db7fd5`.
- [Release page](https://github.com/Guillaume69/rocket-vibe/releases/tag/mobile-v0.9.1).

The worktree version is already newer than that published mobile release. A correct checker therefore offers no update on this base. Do not confuse a master version bump with a published APK.

The APK itself was not downloaded or installed during this research. Its package metadata, actual signer and successful replacement of an installed build remain unverified.

## User flow

1. Settings > App shows the installed version and Check for updates. Checks do not depend on signing into a chat server.
2. An optional foreground/startup check, at most every six hours, presents a dismissible update notice. Checking never starts a download or installation by itself. Provide an automatic-check switch.
3. Show available version, APK size, release notes and Download and install. Preserve the notice when dismissed until a newer version arrives; a manual check can show the dismissed version again.
4. Stream the APK to private app storage with progress and Cancel. Verify it before displaying Install.
5. If needed, explain and open Android's app-specific Allow from this source setting for RocketVibe. On return, recheck the permission; returning from Settings does not mean it was granted.
6. Submit a native installation session and present Android's confirmation when requested. A cancellation leaves the current app installed and allows Retry.
7. A successful replacement may terminate the process. On the next launch, reconcile persisted updater state against the actual installed version, clear stale offers and remove old staging files. Do not promise automatic relaunch.

Local databases, drafts, queued work and stored credentials should survive a normal same-package replacement. Validate this with a real upgrade, including existing database migrations; preserve durable writes before installation and avoid starting installation during an active voice call.

## Release discovery

Use the public GitHub release-list API, not `/releases/latest`:

`GET https://api.github.com/repos/Guillaume69/rocket-vibe/releases?per_page=100&page=1`

- Use GitHub's JSON media type, a documented API version, a timeout and a User-Agent. Never send Rocket.Chat credentials or embed a GitHub token.
- Accept only published, non-draft, non-prerelease entries matching strict `^mobile-v(\d+)\.(\d+)\.(\d+)$`.
- Compare numeric tuples, never strings. Pick the greatest published stable mobile version, then require exactly one uploaded asset named `rocket-vibe-mobile-<version>.apk`, positive size and a valid SHA-256 digest.
- Validate the initial asset URL belongs to the expected HTTPS repository release path. Handle GitHub's HTTPS asset redirects without attaching chat authentication headers.
- Paginate rather than assuming the first 30 entries include a mobile release. Use a documented bound, for example five pages, and report an incomplete check if the bound is reached; do not claim Up to date. A future per-app manifest would remove this scanning limit.
- Cache metadata per page with its ETag, and only reuse a 304 response when the corresponding cached page exists. Respect rate-limit reset/Retry-After and back off on failures. Automatic failures stay unobtrusive; manual checks show a clear retryable error.
- Distinguish No newer release, Newer release unavailable for this device, and Check failed. If the newest version lacks a usable APK or digest, report that rather than silently selecting an older release.

Only arm64 devices can use today's CI APK. An x86_64 emulator can exercise metadata and incompatible-device handling but needs a separately built, correctly signed x86_64 APK for installation testing. Release selection must eventually use artifact ABI information if CI starts publishing several APKs.

## Native boundary and verification

Implementation files:

- `apps/mobile/lib/appUpdates.ts`: pure release parsing/selection and check scheduling, with injected fetch/storage for Node tests.
- `apps/mobile/modules/app-updater/`: optional Android Expo module, Kotlin I/O, streaming SHA-256, package inspection, install permission, PackageInstaller session and persistent result state.
- `apps/mobile/ui/appUpdates.tsx`: shared update state and native React Native controls; wire it into existing `AppCategory` and the root layout.
- `apps/mobile/modules/app-updater/android/src/main/AndroidManifest.xml`: CNG-safe manifest contributions for the install permission, non-exported receiver and confirmation activity. The updater needs no manifest config plugin. A separate `with-expo-package-list.js` build plugin explicitly registers Expo's generated Kotlin package list; native validation exposed its omission from the current template's compile inputs.
- Existing English/French dictionaries: all app-visible messages.

Use a native streaming downloader/hash so a roughly 90 MiB APK never travels through JS as bytes or base64. Stage into a dedicated private updater directory with a `.part` suffix; enforce expected byte count, storage budget, timeout and cancellation; close and verify before making the file eligible for installation. Revalidate any reused staged APK.

Require the GitHub SHA-256 digest for the in-app path. Missing digests offer the release page instead. The digest detects corruption against GitHub metadata; it is not an independent publisher signature. Use Android package metadata for preflight checks: package name, versionName matching the selected tag, strictly higher installed versionCode, device SDK/ABI compatibility and signer compatibility. Android's installer performs the final APK signature and replacement validation. Archive metadata inspection alone is not proof of a valid APK signature. Initially support the existing single-key signing setup; any future key rotation needs an explicit signing-lineage design.

Declare `REQUEST_INSTALL_PACKAGES`, check `canRequestPackageInstalls()`, and open `ACTION_MANAGE_UNKNOWN_APP_SOURCES` with `package:com.rocketvibe.app` when needed. This is a special Settings grant, not a normal runtime permission dialog.

Prefer `PackageInstaller` sessions over sharing a file URI: stream the verified APK into the session, fsync, then commit with an explicit result receiver. Handle `STATUS_PENDING_USER_ACTION`, cancellation, blocked/incompatible/storage failures and process death. Persist the session ID and target version natively before commit; callbacks cannot depend on a live JS runtime. Abandon failed/cancelled sessions and clean staged files safely.

For the first implementation use `USER_ACTION_REQUIRED` on Android 12+ and handle confirmation on all supported versions. Android 12+ also documents a conditional self-update route using `USER_ACTION_NOT_REQUIRED` and `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, subject to target-SDK and installer/update-owner requirements. Treat it as a separately tested enhancement; always handle pending user action. Neither route bypasses the user's trusted-source setting.

## Delivery and acceptance

1. Pure discovery plus Settings UI: prove mixed app tags, numeric ordering, drafts/prereleases, missing/wrong/duplicate assets, malformed digests, pagination limits, timeout, rate limiting, cached pages and installed versions newer than GitHub.
2. Native download and installation: plugin/module manifest checks, prebuild and Gradle build, then a signed old-to-new APK upgrade on Android. Use injected release metadata pointing at controlled test assets; do not publish fake GitHub releases for tests.
3. Foreground automatic checks, dismissal and recovery; full upgrade qualification on a real arm64 device, including retained session, SQLite data, drafts/outbox and successful launch after replacement. Test permission refusal, installer cancellation, truncated/corrupt APK, wrong package/key, equal/lower versionCode, unsupported ABI, low storage, backgrounding and process death. Two test versions must use the same release key.

Run mobile typecheck, lint and meaningful Node tests from `apps/mobile/`. New native code requires clean prebuild and a real native build/install; Metro alone cannot prove installation. Android 8+ permission behavior and Android 12+ session behavior need coverage within the application's actual supported OS range.

When implemented, add the English Unreleased changelog entry and update the brain's mobile-native, settings and updater documentation plus parity. Android now implements this updater; `brain/features/mobile-updates.md` describes the code and `brain/parity.md` records its platform status. GTK already implements updates, SwiftUI still owes them, and Web uses server-delivered assets. iOS installation is outside this APK proposal.

## Validation (2026-10-11)

- Mobile TypeScript check passes.
- Full mobile regression suite: 1,708 tests pass, including eight updater discovery/restart tests and two CNG package-list registration guards.
- Full mobile lint: zero errors, five pre-existing warnings outside the updater; the new updater files have zero warnings.
- Kotlin updater compilation and six native stream-verification tests pass: valid streamed bytes, truncation, checksum mismatch, oversized body, cancellation and staged-file revalidation.
- Full x86_64 debug APK build passes, including a clean Expo rebuild with the generated package-list fix. Windows C++ staging uses an ignored local Gradle init script with a short build directory to avoid Nitro's long-path limit.
- Android 36.1 emulator: real GitHub metadata check, installed-version display and automatic-check preference survive relaunch; the app opens the per-source install grant and waits for permission.
- From the app, a private staged same-debug-key x86_64 test APK upgrades 0.10.0 (1000) to 0.10.1 (1001) after Android confirmation. Cancelling leaves 0.10.0 intact and retry succeeds. A private app-data marker survives replacement; the native result receiver records success after the old JS process exits.
- The native downloader fetches the real public 0.9.1 GitHub APK and verifies its expected byte count and SHA-256, then correctly refuses its lower version. Temporary fixture routes, staging and test metadata are removed; no test release is published.
- Production arm64 GitHub APK replacement on a physical device, including retained chat sessions/databases: not yet qualified. The available emulator is x86_64; today's GitHub APK is arm64-only.
## Alternatives

A Check for updates button that opens the matching release page is smaller but still requires the user to download and open the APK manually. Expo JS OTA updates do not replace APK/native-code updates. A third-party installer package is unnecessary given the existing local-module pattern.

## Sources

Repository paths cited above are relative to the repository root. Product context: [desktop updates](../../brain/features/desktop-updates.md), [mobile native layer](../../brain/architecture/mobile-native.md), [settings](../../brain/features/settings.md), [operations](../../brain/operations.md).

Official documentation checked on 2026-10-11:

- [GitHub release-list API and assets metadata](https://docs.github.com/en/rest/releases/releases).
- [Android alternative distribution and per-source opt-in](https://developer.android.com/distribute/marketing-tools/alternative-distribution).
- [Android app signing and update compatibility](https://developer.android.com/studio/publish/app-signing).
- [PackageInstaller sessions and result statuses](https://developer.android.com/reference/android/content/pm/PackageInstaller).
- [SessionParams user-action requirements and conditional self-updates](https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionParams#setRequireUserAction(int)).
- [App-specific install-source settings](https://developer.android.com/reference/android/provider/Settings#ACTION_MANAGE_UNKNOWN_APP_SOURCES).
