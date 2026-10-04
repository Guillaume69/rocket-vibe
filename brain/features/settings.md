# Settings

The settings screen gathers my profile, the notification preference, the language, the encryption state, the account and server, and app-level switches. Server-side preferences go through `users.setPreferences`; app-level choices (language, background, updates) stay on the device.

## What lives where

| Setting | Stored | Mobile | Desktop |
|---|---|---|---|
| Notification preference | server, per account (`users.setPreferences`) | `pushNotifications` | `desktopNotifications` |
| Presence and status text | server (`users.setStatus`) | in My profile | in Settings |
| Profile fields, photo | server | My profile page | Edit profile subpage |
| Language | device | SecureStore `langue-preferee` | file `<config>/rocket-vibe-rs/language` |
| E2EE key | device | Keystore | system keychain |
| Keep running, start at login | device | n/a | Windows, macOS |
| Automatic update checks | device | n/a | file `no-update-check` (absent = on) |

## Mobile

`app/parametres.tsx`, a page opened from the room list. Sections, in order:

- **Profile card**: avatar, name, link to `/mon-profil` ([room-info-and-profiles.md](room-info-and-profiles.md)).
- **Notifications**: the push preference, read from `GET me` (`settings.preferences.pushNotifications`) and written with `POST users.setPreferences {data: {pushNotifications}}`. It is global to the account, not per room. Three choices are offered: all messages, mentions and direct messages, none. The server also knows `default` (follow the server's setting); an account on `default` shows no option ticked until the first choice, which is honest rather than misleading. Save errors show `parametres.enregistrementImpossible`.
- **Language**: automatic (phone locale), French, English (`SelecteurLangue`, `definirLangue` in `ui/i18n.ts`). The switch is live: listeners re-render the app without a restart. "Automatic" deletes the key; an explicit choice is written with `AFTER_FIRST_UNLOCK` so the iOS notification extension can read it with the phone locked, and the Android push service reads the same key to localise native notifications. Details in [../architecture/i18n.md](../architecture/i18n.md).
- **Encryption**: locked or unlocked state, Unlock (opens `/deverrouiller-e2e`) or Lock (`synchro.verrouillerE2E`) ([e2ee.md](e2ee.md)).
- **Account**: signed in as `@username`, server URL.
- **Diagnostics**: "Get the FCM token" (`SectionJetonFcm`), which runs `obtenirJetonFcm` and prints the token, for push debugging ([notifications.md](notifications.md)).
- **Change server** (`/connexion?changer=1`) and **Sign out** ([login-and-servers.md](login-and-servers.md)).

There is no theme setting: `useCouleurs()` (`ui/theme.ts`) always returns the dark "Nuit Étoilée" palette. A light palette exists as data for a future "day" theme.

## Desktop

`rv-gtk/src/settings.rs::open`, an `adw::PreferencesDialog`:

- **Profile**: my avatar, name, `@username · host`, an Edit profile subpage (photo change or removal, name, username, email, bio, current password and 2FA code rows revealed when needed).
- **Status**: presence (online, away, busy, offline, from `account::STATUSES`) and status text; both are posted together on change.
- **Notifications**: `desktopNotifications` with four choices, `default`, `all`, `mention`, `nothing` (`NOTIFICATION_CHOICES`), saved through `Session::set_preference`, which also updates the in-memory preference that `notify::wanted` reads. "Shown by" names the notification backend (the D-Bus server's name, version and whether it supports inline reply, or the Windows/macOS system), a Test button posts a sample notification, and on Windows and macOS a row opens the OS notification settings (`ms-settings:notifications`, the macOS Notifications pane).
- **Background** (Windows and macOS only, `background::SUPPORTED`): keep running when the window closes (tray icon or dock), start at login (Windows `Run` key, macOS launch agent, both launching with `--background`).
- **Language**: automatic, French, English; takes effect at the next launch (`settings.language_restart`). Automatic follows `glib::language_names()`.
- **Encryption**: state, and a button that locks or opens the unlock dialog.
- **Accounts**: every account signed in on this machine, the current one marked, switch to another, add an account (multi-account details in [login-and-servers.md](login-and-servers.md)).
- **Account**: server URL, sign out.
- **About**: version (`CARGO_PKG_VERSION`), automatic update checks switch, "Check for updates" now ([desktop-updates.md](desktop-updates.md)), and the logs folder (`crashlog::dir()`) with a button to open it.

Fields are filled from `GET me` (`rv-core/src/account.rs::me`) before their change handlers are connected, so filling them writes nothing back.

**SwiftUI** (`macos/Sources/RocketVibe/SettingsView.swift`): accounts (resume, add, sign out), My profile, E2EE status with Lock, language picker (stored in the same config dir `language` file), notifications (`NotificationPreference` for `desktopNotifications`, test, system settings link), and the version. No update checks and no background mode yet.

## Parity

PARITY §9: profile card, notification preference, language, E2EE status, account and server exist in both apps. Mobile only: FCM diagnostic. Desktop only: backend description and test notification, background and login start, update checks, logs folder, multi-account list in settings. The language changes live on mobile and after a restart on desktop.

## Sources

- apps/mobile/app/parametres.tsx
- apps/mobile/app/mon-profil.tsx
- apps/mobile/ui/i18n.ts
- apps/mobile/ui/messages.ts
- apps/mobile/ui/theme.ts
- apps/mobile/lib/push.ts
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/crates/rv-gtk/src/i18n.rs
- apps/desktop/crates/rv-gtk/src/background.rs
- apps/desktop/crates/rv-gtk/src/notifier.rs
- apps/desktop/crates/rv-gtk/src/updater.rs
- apps/desktop/crates/rv-gtk/src/crashlog.rs
- apps/desktop/crates/rv-core/src/account.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-native/src/lib.rs
- apps/desktop/macos/Sources/RocketVibe/SettingsView.swift
- brain/parity.md
