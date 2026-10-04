# Desktop updates

The GTK desktop app updates itself from the repository's GitHub releases: it checks at startup (at most every 6 hours) or on demand, offers a newer version in a card, then replaces itself in place on Linux, runs the installer on Windows, or opens the disk image on macOS. The mobile app has no equivalent (APKs are installed by hand or from the release page), and the SwiftUI app has no updater yet.

## Where releases come from

- Monorepo tags are per app: `desktop-vX.Y.Z` and `mobile-vX.Y.Z`. Only `desktop-v` tags count (`update::TAG_PREFIX`); drafts and pre-releases are skipped. The release list is `https://api.github.com/repos/Guillaume69/rocket-vibe/releases?per_page=30` (`update::REPO`); `ROCKET_VIBE_RELEASES` points at another list (the smoke tests and `scripts/install.sh` honour it).
- `.github/workflows/desktop.yml` builds and attaches the assets on a tag. Each platform picks its asset by suffix (`Platform::asset_suffix`):

| Platform (`Platform::current`) | Asset suffix | Install |
|---|---|---|
| Linux x86_64, run from an AppImage (`APPIMAGE` set) | `-linux-x86_64.AppImage` | replace the AppImage file in place |
| Linux x86_64, tarball | `-linux-x86_64.tar.gz` | extract, replace the running binary |
| Windows x86_64 | `-windows-x86_64-setup.exe` | run the installer silently |
| macOS arm64 | `-macos-arm64.dmg` | download and open the image |

Any other platform, or a release without a matching asset, gets the release page instead.
- Versions compare as `(major, minor, patch)` tuples (`parse_version` accepts `v0.3.0`, `0.3`, ignores `-rc1`/`+meta`); `is_newer` is strict.

## Checking

`rv-gtk/src/updater.rs`:
- **State** is a JSON file in the user cache dir, `rocket-vibe-rs/update.json` (`update::Checked`): when it last checked (`at_ms`), the newest release seen, and the version whose card was dismissed. A check is due after `CHECK_EVERY_MS` (6 h), when it never ran, or when the clock went backwards. `for_platform` forgets a cached release whose asset belongs to another install type (a tarball's check read by an AppImage), so it is due again.
- **Startup** (`updater::startup`, called from `Window::start`): unless automatic checks are off, the cached offer is shown at once, then a fresh check runs if due, and a newer offer replaces it.
- **Manual**: Settings, About, "Check for updates" (`updater::check`) asks GitHub regardless and offers even a dismissed version; "no update" or a failure shows a toast.
- **Off switch**: Settings' "Check automatically" toggles the empty file `<config>/rocket-vibe-rs/no-update-check` (present = off).
- `RV_SMOKE_UPDATE_FROM` makes the app pretend to run an older version (`running_version`), for the smoke run.

## The card and the install

`updater::card` sits in the chat view (`chat.set_update_notice`, wired by `updater::set_presenter` in `window.rs`): "version X available", Install (Download on macOS), Release notes (opens the release page), and a close button that records the version as dismissed so it never shows again automatically.

Install (`updater::install`) downloads with progress through `update::download`, which writes to a `.part` file, rejects a body shorter than `Content-Length` ("download cut short") and renames it into place. There is **no signature or checksum check** on the download beyond that length check and HTTPS.

- **Linux AppImage**: download into the cache staging dir, copy beside the running AppImage as `.<name>.new`, make it executable, `rename` over the original (atomic on the same filesystem). The file replaced is `$APPIMAGE`, canonicalised.
- **Linux tarball**: extract with `tar -xzf`, find `rocket-vibe-gtk` at the top or one level down, and replace the running executable the same way.
- After an in-place replacement the button becomes Restart. `relaunch()` sets a flag and the app quits; after GTK's main loop returns, `exec_if_relaunching` (`main.rs`) `exec`s the new binary in place of the process. Spawning a child to relaunch raced the single instance that was still quitting, and some sessions kill what a quitting app leaves behind.
- Any in-place failure opens the release page instead of erroring.
- **Windows**: only for an install made by the installer (an `unins000.exe` next to the app folder); the setup is downloaded to the temp dir and started with `/SILENT /SUPPRESSMSGBOXES /NORESTART /relaunch=1`, then the app quits so it can be replaced. A zip install gets the release page.
- **macOS**: the DMG is downloaded to the downloads folder and opened for the user to copy the app; the signed, notarised bundle is never patched in place.

## Parity

Desktop only (PARITY §9, "the desktop equivalent of the store"); the SwiftUI app: not yet. For a first install on Linux, `scripts/install.sh` fetches the newest `desktop-v*` AppImage into `~/.local/bin/rocket-vibe.AppImage`, which the card then updates in place ([../operations.md](../operations.md)).

## Sources

- apps/desktop/crates/rv-core/src/update.rs
- apps/desktop/crates/rv-gtk/src/updater.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-gtk/src/main.rs
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/crates/rv-gtk/src/smoke.rs
- apps/desktop/scripts/install.sh
- apps/desktop/scripts/smoke.sh
- .github/workflows/desktop.yml
- apps/desktop/docs/PARITY.md
- apps/desktop/README.md
