# Settings

The settings gather my profile, the notification preference, the language, the encryption state, the security and devices of a RocketVibe account, the accounts and server, and app-level switches, in clickable categories. Server-side preferences go through `users.setPreferences`; app-level choices (language, background, updates) stay on the device.

## What lives where

| Setting | Stored | Mobile | Desktop |
|---|---|---|---|
| Notification preference | server, per account (`users.setPreferences`) | `pushNotifications` | `desktopNotifications` |
| Presence and status text | server (`users.setStatus`) | in My profile | in the My account category |
| Profile fields, photo | server | My profile page | Edit profile subpage |
| Language | device | SecureStore `preferred-language` (moved from `langue-preferee` on first read) | file `<config>/rocket-vibe-rs/language` |
| E2EE key | device | Keystore | system keychain |
| Keep running, start at login | device | n/a | Windows, macOS |
| Automatic update checks | device | n/a | file `no-update-check` (absent = on) |

## Layout: the same categories everywhere

The three apps group the settings in one list of categories, in this order, each shown only when it has something for the open account and server: **My account** (profile card, edit profile, presence and status text), **Notifications**, **Language**, **Voice** (desktop only, RocketVibe accounts with voice: microphone, speakers, noise remover; mobile has no voice settings), **Encryption**, **Security**, **Devices**, **Bots** and **Workflows** (RocketVibe accounts only; Bots when the server announces `bots`, [bots.md](bots.md), Workflows when it announces `workflows`, [workflows.md](workflows.md)), **Accounts**, **App**. Under them: **Server administration**, for an administrator of the open server only ([administration.md](administration.md)), and **Sign out**. Desktop shows them as a large modal with the categories on the left (why: [decisions](../decisions.md#desktop)); mobile as a list of full pages.

## Mobile

`app/settings/index.tsx` is the list, opened from the room list: my profile card on top, then one row per visible category (an emoji icon, the label, a one-line hint, a chevron), then the "Server administration" card when `useServerAdmin` (`ui/adminAccess.ts`) says so, and Sign out at the bottom. A row opens `app/settings/[category].tsx`, a full page (several categories have text fields; a `KeyboardAwareScrollView` from react-native-keyboard-controller keeps the field being typed in above the keyboard, which edge-to-edge no longer resizes the window for) rendering `SettingsCategoryContent` from `ui/settingsSections.tsx`, where the former single page's sections moved unchanged; an unknown category redirects to the list. Which categories show is decided by `ui/settingsCategories.ts` (`SETTINGS_CATEGORIES`, `hasContent`, `visibleCategories`, pure and tested), from the server's capabilities: Notifications when it delivers push (Rocket.Chat, RocketVibe taking registrations; not Mattermost nor kChat); Encryption on Rocket.Chat (`e2ee`), on RocketVibe with the encrypted identity block, never on Mattermost or kChat; Security and Devices on RocketVibe when offered; Bots on RocketVibe when the server announces `bots`, Workflows when it announces `workflows`.

- **My account**: the profile card (avatar, name, `@username`, host), opening `/my-profile`, where presence, status text and the profile fields are edited ([room-info-and-profiles.md](room-info-and-profiles.md)); disabled on a RocketVibe server without the `profiles` capability. On Mattermost and kChat, the **Conversation list** card: how people are named and how many direct messages are listed, the account's own preferences ([mattermost-and-kchat.md](mattermost-and-kchat.md)).
- **Notifications**: the push preference, read from `GET me` (`settings.preferences.pushNotifications`) and written with `POST users.setPreferences {data: {pushNotifications}}`; on RocketVibe the native preferences (`ui/nativePreferences.ts`). It is global to the account, not per room. Three choices are offered: all messages, mentions and direct messages, none. The server also knows `default` (follow the server's setting); an account on `default` shows no option ticked until the first choice, which is honest rather than misleading. Save errors show `settings.saveFailed`.
- **Language**: automatic (phone locale), French, English (`LanguagePicker`, `setLanguage` in `ui/i18n.ts`). The switch is live: listeners re-render the app without a restart. "Automatic" deletes the key; an explicit choice is written with `AFTER_FIRST_UNLOCK` so the iOS notification extension can read it with the phone locked, and the Android push service reads the same key to localise native notifications. On RocketVibe the server-side language preference is adopted on this page. Details in [../architecture/i18n.md](../architecture/i18n.md).
- **Encryption**: Rocket.Chat: locked or unlocked state, Unlock (opens `/unlock-e2e`) or Lock (`sync.lockE2E`) ([e2ee.md](e2ee.md)); RocketVibe: the encrypted identity block (`ui/encryptedIdentity.tsx`).
- **Security** (`ui/nativeSecurity.tsx`) and **Devices** (`ui/devices.tsx`): RocketVibe 2FA, codes, email, reauthentication, and device sessions.
- **Bots** (`ui/bots.tsx`): my bots, their scopes, keys and photo ([bots.md](bots.md)).
- **Workflows** (`ui/workflows.tsx`): my workflows and their editor ([workflows.md](workflows.md)).
- **Accounts**: signed in as `@username`, server URL, Change server (`/login?change=1`) ([login-and-servers.md](login-and-servers.md)).
- **App**: the version (`expo-constants` `expoConfig.version`) and, on Rocket.Chat, the diagnostics: "Get the FCM token" (`FcmTokenSection`), which runs `getFcmToken` and prints the token, for push debugging ([notifications.md](notifications.md)).

There is no theme setting: `useColors()` (`ui/theme.ts`) always returns the dark "Nuit Étoilée" palette. A light palette exists as data for a future "day" theme.

## Desktop

### GTK

`rv-gtk/src/settings.rs::open` (Rocket.Chat) and `open_native` (RocketVibe) return a `SidebarDialog` (`rv-gtk/src/sidebar_dialog.rs`), the component the server administration reuses: an `adw::Dialog` of 85 % of the window clamped between 360 x 360 and 1100 x 800, holding an `adw::NavigationSplitView` with the categories in a sidebar `gtk::ListBox` (plus a footer) and, on the right, the chosen category's `adw::PreferencesPage` inside an `adw::NavigationView` (subpages such as Edit profile) inside an `adw::ToastOverlay`. Pages can be built lazily (`add_lazy`); under 640 sp a breakpoint collapses to one pane. Escape, the close button and a click on the dimmed backdrop close it (`widgets::present`, which attaches `widgets::close_on_backdrop` to every dialog of the app). A page talks to the dialog through `Host` (`toast`, `push`, `pop`, `pop_if`, `select`, `close`, `set_badge`). The footer holds "Server administration" (CSS class `settings-admin`, made visible once `Admin::is_admin` answers yes) and Sign out (`settings-sign-out`).

- **My account**: my avatar, name, `@username · host`, an Edit profile subpage (photo change or removal, name, username, email, bio, current password and 2FA code rows revealed when needed); presence (online, away, busy, offline, from `account::STATUSES`) and status text, posted together on change. RocketVibe: `settings/native_profiles.rs` fills the account, notification and language pages.
- **Notifications**: `desktopNotifications` with four choices, `default`, `all`, `mention`, `nothing` (`NOTIFICATION_CHOICES`), saved through `Session::set_preference`, which also updates the in-memory preference that `notify::wanted` reads. "Shown by" names the notification backend (the D-Bus server's name, version and whether it supports inline reply, or the Windows/macOS system), a Test button posts a sample notification, and on Windows and macOS a row opens the OS notification settings (`ms-settings:notifications`, the macOS Notifications pane). RocketVibe accounts get the same notifier rows.
- **Language**: automatic, French, English; takes effect at the next launch (`settings.language_restart`). Automatic follows `glib::language_names()`.
- **Voice** (RocketVibe, when `rv_core::voice::available()`): `settings/voice.rs`, the microphone and speakers the voice sidecar opens, the noise remover and, on Windows and Linux, whether a shared screen's sound carries the call's voices; kept on the machine (`rv_core::voice_prefs`, read by SwiftUI too). See [voice.md](voice.md).
- **Encryption**: Rocket.Chat: state, and a button that locks or opens the unlock dialog. RocketVibe: `native_crypto::page`, built lazily; the recovery and history backup codes it may show are cleared as soon as the page is left (`unmap`), not only when the dialog closes.
- **Security** (`native_security::page`) and **Devices** (`native_devices_page`): RocketVibe only, categories of the dialog rather than separate dialogs.
- **Bots** (`settings/native_bots.rs`): RocketVibe with `bots`, see [bots.md](bots.md).
- **Accounts**: every account signed in on this machine, the current one marked, switch to another, add an account (multi-account details in [login-and-servers.md](login-and-servers.md)); the server URL.
- **App**: background (Windows and macOS only, `background::SUPPORTED`: keep running when the window closes, tray icon or dock; start at login, Windows `Run` key, macOS launch agent, both launching with `--background`), then About: version (`CARGO_PKG_VERSION`), automatic update checks switch, "Check for updates" now ([desktop-updates.md](desktop-updates.md)), and the logs folder (`crashlog::dir()`) with a button to open it. RocketVibe accounts have it too.

Fields are filled from `GET me` (`rv-core/src/account.rs::me`) before their change handlers are connected, so filling them writes nothing back.

### SwiftUI

The settings are an overlay of the main window, not a `Settings` scene (removed): `SettingsOverlay` in `macos/Sources/RocketVibe/SettingsView.swift` puts the panel `SettingsView` in a `PanelOverlay` (dimmed backdrop, a click closes; shared with the administration), sized by `SettingsLayout` (`macos/Sources/RocketVibeKit/Settings.swift`: 85 % of the window, at least 360 x 360, at most 1100 x 800, one pane under 640 points). Command-comma (a `CommandGroup` replacing `.appSettings`) and the account bar's gear open it (`AppModel.openSettings`); Escape and the close button close it (`closeSettings`), and so does leaving for another account. The categories are `SettingsCategory` (same order; `visible(Scope)` decides: My account and Notifications once signed in, Voice when the account has voice (`AppModel.voice`), Encryption for Rocket.Chat's key or RocketVibe crypto, Security and Devices for RocketVibe, Bots with the `bots` feature), then, for an administrator, the "Server administration" link (`AppModel.administrator`, asked again each time the settings open; it closes the settings and opens the administration in the same `PanelOverlay`, [administration.md](administration.md)) and Sign out.

- **My account**: `MyProfileSection` where the provider supports profiles. **Notifications**: `NotificationPreference` for `desktopNotifications`, a test notification, a link to the system settings. **Language**: the same config dir `language` file (or the RocketVibe preference). **Voice**: `VoiceSettings`. **Encryption**: Rocket.Chat state with Lock or Unlock (`UnlockSheet`, a modal overlay), RocketVibe `CryptoSection`. **Security**, **Devices**, **Bots**: `SecuritySection`, `DevicesSection`, `BotsSection`. **Accounts**: resume another, add one, the server. **App**: the version. No update checks, logs folder or background mode yet.

## Parity

[parity](../parity.md) §9: the categories, profile card, notification preference, language, encryption, accounts and the version exist in all three; the Voice category in GTK and SwiftUI, mobile having no voice settings. Mobile only: FCM diagnostic. GTK only: backend description, background and login start, update checks, logs folder. Mobile holds one account per server, so its Accounts page shows only the open one. The language changes live on mobile and after a restart on desktop.

## Sources

- apps/mobile/app/settings/index.tsx
- apps/mobile/app/settings/[category].tsx
- apps/mobile/ui/settingsSections.tsx
- apps/mobile/ui/settingsCategories.ts
- apps/mobile/ui/adminAccess.ts
- apps/mobile/app/my-profile.tsx
- apps/mobile/ui/i18n.ts
- apps/mobile/ui/messages.ts
- apps/mobile/ui/theme.ts
- apps/mobile/lib/push.ts
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/crates/rv-gtk/src/settings/native_profiles.rs
- apps/desktop/crates/rv-gtk/src/settings/voice.rs
- apps/desktop/crates/rv-gtk/src/sidebar_dialog.rs
- apps/desktop/crates/rv-gtk/src/widgets.rs
- apps/desktop/crates/rv-gtk/src/i18n.rs
- apps/desktop/crates/rv-gtk/src/background.rs
- apps/desktop/crates/rv-gtk/src/notifier.rs
- apps/desktop/crates/rv-gtk/src/updater.rs
- apps/desktop/crates/rv-gtk/src/crashlog.rs
- apps/desktop/crates/rv-core/src/account.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-native/src/lib.rs
- apps/desktop/macos/Sources/RocketVibe/SettingsView.swift
- apps/desktop/macos/Sources/RocketVibe/RocketVibeApp.swift
- apps/desktop/macos/Sources/RocketVibeKit/Settings.swift
- apps/desktop/crates/rv-gtk/src/native_crypto/recovery.rs
- apps/mobile/ui/bots.tsx
- apps/mobile/ui/workflows.tsx
- apps/desktop/crates/rv-gtk/src/settings/native_bots.rs
- apps/desktop/macos/Sources/RocketVibe/BotsSection.swift
