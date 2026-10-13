# Settings

The settings gather my profile, the notification preference, the language, the encryption state, the security and devices of a Vibez account, the accounts and server, and app-level switches, in clickable categories. Server-side preferences go through `users.setPreferences`; app-level choices (language, background, updates) stay on the device.

## What lives where

| Setting | Stored | Mobile | Desktop |
|---|---|---|---|
| Notification preference | server, per account (`users.setPreferences`) | `pushNotifications` | `desktopNotifications` |
| Do not disturb (Vibez: quiet hours, a mute) | server, per account (`quiet_hours`, `muted_until`) | Notifications category, [do-not-disturb.md](do-not-disturb.md) | Notifications category, [do-not-disturb.md](do-not-disturb.md) |
| Read receipts (Vibez: share them, both ways) | server, per account (`share_read_receipts`) | My account, "Privacy" card, [read-receipts.md](read-receipts.md) | not offered yet |
| Presence and status text | server (`users.setStatus`) | in My profile | in the My account category |
| Profile fields, photo | server | My profile page | Edit profile subpage |
| Language | device | SecureStore `preferred-language` (moved from `langue-preferee` on first read) | file `<config>/rocket-vibe-rs/language` |
| E2EE key | device | Keystore | system keychain |
| Keep running, start at login | device | n/a | Windows, macOS |
| Automatic update checks | device | Android: `app-updates.json` | file `no-update-check` (absent = on) |
| Hide the server rail | device | SecureStore `hide-server-rail` (`1` = hidden) | file `hide-server-rail` (present = hidden), GTK and SwiftUI |

## Layout: the same categories everywhere

The three apps group the settings in one list of categories, in this order, each shown only when it has something for the open account and server: **My account** (profile card, edit profile, presence and status text), **Notifications**, **Language**, **Voice** (desktop only, Vibez accounts with voice: microphone, speakers, noise remover; mobile has no voice settings), **Encryption**, **Security**, **Devices**, **Bots** and **Workflows** (Vibez accounts only; Bots when the server announces `bots`, [bots.md](bots.md), Workflows when it announces `workflows`, [workflows.md](workflows.md)), **Accounts**, **App**. Under them: **Server administration**, for an administrator of the open server only ([administration.md](administration.md)), and **Sign out**. Desktop shows them as a large modal with the categories on the left (why: [decisions](../decisions.md#desktop)); mobile as a list of full pages.

## Security: unfinished changes

Every sensitive Security change (verify or remove the email address, set up or disable the authenticator, replace backup codes, enable or disable email codes) saves its intent privately on the device BEFORE its request, and every opening of the page replays it so a lost answer is recovered. The server checks an already accepted receipt before the recent-proof check, so a replay that answers 403 `reauthentication_required` proves the change was NOT applied (probed on 0.4.0). The replay therefore never fails the page: rv-core maps it to `FactorState::Pending { receipt_id, action: PendingFactor }` (`native/security.rs`, `security/email_settings.rs`) or `email::State::AwaitingProof { receipt_id, address }` (an unsent verification; a removal already uses `RemovalPending`, `security/email.rs`), and mobile mirrors it (`factorVault.ts` `{kind:'pending'}`, `emailVault.ts` `{kind:'awaiting_proof'}`). The page shows the status, then the unfinished change with **Continue** (asks for the identity first when the proof is not recent, then replays) and **Cancel** (clears the factor intent, or retires the email verification or removal). Confirming the identity also resumes the pending factor and email intents. "Try again" only shows after a failed load or action. Before this, GTK and SwiftUI failed the whole load and stayed on "Loading security…" with only "Resume or refresh", which replayed the same refused request.

## Mobile

`app/settings/index.tsx` is the list, opened from the room list: my profile card on top, then one row per visible category (the desktop's Adwaita icon for it, `ui/settingsCategories.ts`; the label, a one-line hint, a chevron), then a "Reminders" card for every account (`app/reminders.tsx`, [reminders.md](reminders.md#mobile)), then the "Server administration" card when `useServerAdmin` (`ui/adminAccess.ts`) says so, and Sign out at the bottom. A row opens `app/settings/[category].tsx`, a full page (several categories have text fields; a `KeyboardAwareScrollView` from react-native-keyboard-controller keeps the field being typed in above the keyboard, which edge-to-edge no longer resizes the window for) rendering `SettingsCategoryContent` from `ui/settingsSections.tsx`, where the former single page's sections moved unchanged; an unknown category redirects to the list. Which categories show is decided by `ui/settingsCategories.ts` (`SETTINGS_CATEGORIES`, `hasContent`, `visibleCategories`, pure and tested), from the server's capabilities: Notifications when it delivers push (Rocket.Chat, Vibez taking registrations; not Mattermost nor kChat); Encryption on Rocket.Chat (`e2ee`), on Vibez with the encrypted identity block, never on Mattermost or kChat; Security and Devices on Vibez when offered; Bots on Vibez when the server announces `bots`, Workflows when it announces `workflows`.

- **My account**: the profile card (avatar, name, `@username`, host), opening `/my-profile`, where presence, status text and the profile fields are edited ([room-info-and-profiles.md](room-info-and-profiles.md)); disabled on a Vibez server without the `profiles` capability. On Mattermost and kChat, the **Conversation list** card: how people are named and how many direct messages are listed, the account's own preferences ([mattermost-and-kchat.md](mattermost-and-kchat.md)). On Vibez, the **Privacy** card: the "Share read receipts" switch ([read-receipts.md](read-receipts.md)), with the native preferences' save state under it.
- **Notifications**: the push preference, read from `GET me` (`settings.preferences.pushNotifications`) and written with `POST users.setPreferences {data: {pushNotifications}}`; on Vibez the native preferences (`ui/nativePreferences.ts`). It is global to the account, not per room. Three choices are offered: all messages, mentions and direct messages, none. The server also knows `default` (follow the server's setting); an account on `default` shows no option ticked until the first choice, which is honest rather than misleading. Save errors show `settings.saveFailed`. On Vibez a "Do not disturb" card follows (a mute, daily quiet hours, [do-not-disturb.md](do-not-disturb.md)), and one save state under both cards gives the error and Retry or Cancel of a pending command.
- **Language**: automatic (phone locale), French, English (`LanguagePicker`, `setLanguage` in `ui/i18n.ts`). The switch is live: listeners re-render the app without a restart. "Automatic" deletes the key; an explicit choice is written with `AFTER_FIRST_UNLOCK` so the iOS notification extension can read it with the phone locked, and the Android push service reads the same key to localise native notifications. On Vibez the server-side language preference is adopted on this page. Details in [../architecture/i18n.md](../architecture/i18n.md).
- **Encryption**: Rocket.Chat: locked or unlocked state, Unlock (opens `/unlock-e2e`) or Lock (`sync.lockE2E`) ([e2ee.md](e2ee.md)); Vibez: the encrypted identity block (`ui/encryptedIdentity.tsx`).
- **Security** (`ui/nativeSecurity.tsx`) and **Devices** (`ui/devices.tsx`): Vibez 2FA, codes, email, reauthentication, and device sessions. Setting up an authenticator shows the setup link's QR code (`ui/qrCode.tsx`, see [Authenticator QR code](#authenticator-qr-code)) above the key, then "Open in authenticator app" (`Linking.openURL` on the `otpauth://` link after re-reading the setup, `security.noAuthenticator` when no app takes it), copy key and copy link.
- **Bots** (`ui/bots.tsx`): my bots, their scopes, keys and photo ([bots.md](bots.md)).
- **Workflows** (`ui/workflows.tsx`): my workflows and their editor ([workflows.md](workflows.md)).
- **Accounts**: signed in as `@username`, server URL, the "Hide the server bar" switch (`ui/serverRailSetting.ts`), Change server (`/login?change=1`) ([login-and-servers.md](login-and-servers.md)).
- **App**: the version (`expo-constants` `expoConfig.version`), the Android [GitHub APK updater](mobile-updates.md) (installed native version, Check for updates, automatic checks, download progress, install permission and confirmation), and, on Rocket.Chat, the diagnostics: "Get the FCM token" (`FcmTokenSection`), which runs `getFcmToken` and prints the token, for push debugging ([notifications.md](notifications.md)).

There is no theme setting: `useColors()` (`ui/theme.ts`) always returns the dark "Nuit Étoilée" palette. A light palette exists as data for a future "day" theme.

## Desktop

### GTK

`rv-gtk/src/settings.rs::open` (Rocket.Chat) and `open_native` (Vibez) return a `SidebarDialog` (`rv-gtk/src/sidebar_dialog.rs`), the component the server administration reuses: an `adw::Dialog` of 85 % of the window clamped between 360 x 360 and 1100 x 800, holding an `adw::NavigationSplitView` with the categories in a sidebar `gtk::ListBox` (plus a footer) and, on the right, the chosen category's `adw::PreferencesPage` inside an `adw::NavigationView` (subpages such as Edit profile) inside an `adw::ToastOverlay`. Pages can be built lazily (`add_lazy`); under 640 sp a breakpoint collapses to one pane. Escape, the close button and a click on the dimmed backdrop close it (`widgets::present`, which attaches `widgets::close_on_backdrop` to every dialog of the app). A page talks to the dialog through `Host` (`toast`, `push`, `pop`, `pop_if`, `select`, `close`, `set_badge`). The footer holds "Server administration" (CSS class `settings-admin`, made visible once `Admin::is_admin` answers yes) and Sign out (`settings-sign-out`).

- **My account**: my avatar, name, `@username · host`, an Edit profile subpage (photo change or removal, name, username, email, bio, current password and 2FA code rows revealed when needed); presence (online, away, busy, offline, from `account::STATUSES`) and status text, posted together on change. Vibez: `settings/native_profiles.rs` fills the account, notification and language pages; the account page ends with a "Privacy" group, the read receipts switch ([read-receipts.md](read-receipts.md)).
- The GTK account footer's activity popover uses green/yellow/red/gray circles through `rows::presence_dot`, sharing the CSS of the avatar badges; its connection dot still reports transport state separately.
- **Notifications**: `desktopNotifications` with four choices, `default`, `all`, `mention`, `nothing` (`NOTIFICATION_CHOICES`), saved through `Session::set_preference`, which also updates the in-memory preference that `notify::wanted` reads. Vibez accounts add a "Do not disturb" group (a mute for an hour or until 08:00, quiet hours with a switch and two times), see [do-not-disturb.md](do-not-disturb.md). "Shown by" names the notification backend (the D-Bus server's name, version and whether it supports inline reply, or the Windows/macOS system), a Test button posts a sample notification, and on Windows and macOS a row opens the OS notification settings (`ms-settings:notifications`, the macOS Notifications pane). Vibez accounts get the same notifier rows.
- **Language**: automatic, French, English; takes effect at the next launch (`settings.language_restart`). Automatic follows `glib::language_names()`.
- **Voice** (Vibez, when `rv_core::voice::available()`): `settings/voice.rs`, the microphone and speakers the voice sidecar opens, the noise remover and, on Windows and Linux, whether a shared screen's sound carries the call's voices; kept on the machine (`rv_core::voice_prefs`, read by SwiftUI too). See [voice.md](voice.md).
- **Encryption**: Rocket.Chat: state, and a button that locks or opens the unlock dialog. Vibez: `native_crypto::page`, built lazily; the recovery and history backup codes it may show are cleared as soon as the page is left (`unmap`), not only when the dialog closes.
- **Security** (`native_security::page`) and **Devices** (`native_devices_page`): Vibez only, categories of the dialog rather than separate dialogs. The authenticator setup group renders its copy/code/action rows first, then the setup link's QR code (`totp_qr.rs`, a `gtk::DrawingArea` painted with cairo, whole pixels per module, no antialiasing) and key as the group's extra widgets; `clear` drops the QR with the key. Accepted recovery-code actions likewise precede the code bag.
- **Bots** (`settings/native_bots.rs`): Vibez with `bots`, see [bots.md](bots.md).
- **Accounts** (`accounts_page`): every account signed in on this machine, the current one marked, switch to another, add an account (multi-account details in [login-and-servers.md](login-and-servers.md)); the "Hide the server bar" switch (an `adw::SwitchRow`, `AccountActions::hide_rail`, reading `rail::hidden`), whose subtitle says switching and adding stay possible there; the server URL.
- **App**: background (Windows and macOS only, `background::SUPPORTED`: keep running when the window closes, tray icon or dock; start at login, Windows `Run` key, macOS launch agent, both launching with `--background`), then About: version (`CARGO_PKG_VERSION`), automatic update checks switch, "Check for updates" now ([desktop-updates.md](desktop-updates.md)), and the logs folder (`crashlog::dir()`) with a button to open it. Vibez accounts have it too.

Fields are filled from `GET me` (`rv-core/src/account.rs::me`) before their change handlers are connected, so filling them writes nothing back.

### SwiftUI

The settings are an overlay of the main window, not a `Settings` scene (removed): `SettingsOverlay` in `macos/Sources/RocketVibe/SettingsView.swift` puts the panel `SettingsView` in a `PanelOverlay` (dimmed backdrop, a click closes; shared with the administration), sized by `SettingsLayout` (`macos/Sources/RocketVibeKit/Settings.swift`: 85 % of the window, at least 360 x 360, at most 1100 x 800, one pane under 640 points). Command-comma (a `CommandGroup` replacing `.appSettings`) and the account bar's menu (Settings, Server administration, Sign out) open it (`AppModel.openSettings`); Escape and the close button close it (`closeSettings`), and so does leaving for another account. The categories are `SettingsCategory` (same order; `visible(Scope)` decides: My account and Notifications once signed in, Voice when the account has voice (`AppModel.voice`), Encryption for Rocket.Chat's key or Vibez crypto, Security and Devices for Vibez, Bots with the `bots` feature), then, for an administrator, the "Server administration" link (`AppModel.administrator`, asked again each time the settings open; it closes the settings and opens the administration in the same `PanelOverlay`, [administration.md](administration.md)) and Sign out.

- **My account**: `MyProfileSection` where the provider supports profiles; for a Vibez account, `PrivacySection`, the read receipts switch ([read-receipts.md](read-receipts.md)). **Notifications**: `NotificationPreference` for `desktopNotifications`, a test notification, a link to the system settings; for a Vibez account, `DoNotDisturbSection` ([do-not-disturb.md](do-not-disturb.md)). **Language**: the same config dir `language` file (or the Vibez preference). **Voice**: `VoiceSettings`. **Encryption**: Rocket.Chat state with Lock or Unlock (`UnlockSheet`, a modal overlay), Vibez `CryptoSection`. **Security**, **Devices**, **Bots**: `SecuritySection` (the authenticator setup shows `TotpQrCode`, CoreImage's `CIFilter.qrCodeGenerator` at correction level M composited over a white square four modules wider on each side, drawn without interpolation; not compiled by the Linux check), `DevicesSection`, `BotsSection`. **Accounts**: resume another, add one, the "Hide the server bar" `Toggle` (`AppModel.railHidden` / `setRailHidden`), the server. **App**: the version. No update checks, logs folder or background mode yet.

## Web

Categories retain their drafts and scroll position until the owning dialog closes. Server-backed mutations invalidate only affected pages. Native profile/photo rows, notification backend/test groups, quiet-hours expansion and inline factor/email ceremonies follow GTK's layouts. Account security status remains visible during authenticator setup and backup-code acknowledgement and refreshes after the actual factor change. Crypto controls remain active when a cached page is temporarily detached; peer device approval requires typed fingerprint confirmation. Workflows and bots retain native grouped/expanded forms. The screen inventory and actual runtime checks are in `docs/WEB_GTK_SCREEN_AUDIT.md`.

Security now retains unfinished sensitive actions across reopening and reload (`src/security-intents.ts`, `security.ts`, `email.ts`). It saves the original operation and requested factor/contact versions before sending, including the explicit enable/disable direction for email codes. Recovery probes accepted receipts before requiring fresh proof. Refused uncommitted actions show the current account status and native Continue/Cancel controls; Continue uses the same proof operation through password and second-factor confirmation. Cancel clears only the matching factor intent, or retires the original email head without proving identity. Accepted recovery-code bags and verified/removed email receipts stay until acknowledgement, and stale versions cannot silently mint replacement codes. A directionless legacy email-factor intent is shown as stale rather than guessed from current status.

`src/security-vault.ts` uses the existing AES-GCM vault envelope with a nonextractable key and origin/instance/epoch/account/device/purpose scope. Its separate operations namespace is ignored by ordinary send/renew pumps and removed by normal account purge. Named locks and account/generation/token checks prevent late encryption, replay, cancellation and acknowledgement from replacing a newer intent or restoring a signed-out account's record. Setup secrets and recovery codes are ciphertext in persistent storage; entered passwords and one-time codes are never persisted. Model/vault tests and `tests/security-pending.mjs` cover real committed lost answers, expired-proof Continue/Cancel, exact original receipts and both email-code directions.

The anonymous login-factor ceremony uses a separate account-prefixed, challenge-bound sealed receipt (`src/factor-auth-vault.ts`), described in [login and servers](login-and-servers.md#web). It preserves GTK's native method/Confirm/refusal captions, accepted-finish blank-code replay and explicit email Send/Resume/Resend controls. This record contains receipt IDs and a sealed successor token, never an entered code or password; it does not share the sensitive-settings intent or MLS vault namespace.

The settings dialog (`settings` in `apps/web/src/panels.ts`) follows GTK's categories ([web-client](web-client.md)). **App** shows the version (the server's, `server_version` from discovery) and **Diagnostics**, the browser's mapping of GTK's logs folder: a browser has no folder to open, so `src/diagnostics.ts` keeps a ring of the 200 latest client-side events in memory (errors the app reported through `toast`, uncaught errors and rejections from `installDiagnostics` in `main.ts`, connection state changes from `App.setConnection`, sign-out deferrals and replays, retention counts) and the row downloads them as `vibez-diagnostics-<time>.txt` with the version, user agent, language and connection state. Never recorded: tokens, message text, names. An API error keeps only its status and code, any other error its type and a message passed through `scrub` (quoted text, email addresses, URL queries and opaque runs of 20 or more characters removed, 200 characters at most); strings shown to the user are not recorded. The ring lives as long as the tab. Unit tests `tests/diagnostics.test.ts`; `tests/logout-replay.mjs` downloads it and checks no token or name is in it.

## Authenticator QR code

Setting up an authenticator on a Vibez account (Security category, `POST /api/v1/me/factors/totp/setup`) shows a QR code of the `provisioning_uri` the server returns, in all four apps, beside the key and the copy or open actions that stay for manual entry. The server builds the link (`factor_crypto::provisioning_uri` in `apps/server`): Key Uri Format, label `Vibez-<first 8 of the instance id>:<username>`, `issuer=` repeated, SHA1, 6 digits, 30 s, label and issuer percent-encoded; a 20-byte secret makes it about 140 bytes, a version 8 symbol at correction level M. Every app draws only a link starting `otpauth://totp/` and paints black modules on a white square with a four-module quiet zone whatever the theme, so it scans in dark mode too. The link and the matrix are never logged. Encoders: web and mobile use `uqr` (MIT, a port of Project Nayuki's generator; `apps/web/src/totp-qr.ts` as an SVG path, `apps/mobile/ui/totpQr.ts` as runs of plain views), GTK the `qrcode` crate without default features, SwiftUI CoreImage. Rocket.Chat, Mattermost and kChat accounts have no authenticator enrolment in the apps (only the login challenge), so no QR there.

## Parity

[parity](../parity.md) §9: the categories, profile card, notification preference, language, encryption, accounts and the version exist in all three; the Voice category in GTK and SwiftUI, mobile having no voice settings. Mobile only: FCM diagnostic. GTK only: backend description, background and login start, update checks, logs folder (the web maps it with its Diagnostics download). Mobile holds one account per server, so its Accounts page shows only the open one. The language changes live on mobile and after a restart on desktop.

## Sources

- apps/web/src/sidebar.ts
- apps/web/src/settings-parity.css
- apps/web/src/crypto/settings-controls.ts
- docs/WEB_GTK_SCREEN_AUDIT.md
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/native_security.rs
- apps/desktop/crates/rv-core/src/native/security.rs
- apps/desktop/crates/rv-core/src/native/security/email.rs
- apps/desktop/crates/rv-ffi/src/native_security.rs
- apps/desktop/macos/Sources/RocketVibe/SecuritySection.swift
- apps/mobile/ui/nativeSecurity.tsx
- apps/mobile/providers/vibez/factorVault.ts
- apps/mobile/providers/vibez/emailVault.ts
- apps/web/src/email.ts

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
- apps/desktop/macos/Sources/RocketVibeKit/MyProfileModel.swift
- apps/desktop/crates/rv-core/src/native/quiet.rs
- apps/desktop/macos/Sources/RocketVibe/RocketVibeApp.swift
- apps/desktop/macos/Sources/RocketVibeKit/Settings.swift
- apps/desktop/crates/rv-gtk/src/native_crypto/recovery.rs
- apps/mobile/ui/bots.tsx
- apps/mobile/ui/workflows.tsx
- apps/desktop/crates/rv-gtk/src/settings/native_bots.rs
- apps/desktop/macos/Sources/RocketVibe/BotsSection.swift
- apps/mobile/ui/serverRailSetting.ts
- apps/mobile/ui/doNotDisturb.tsx
- apps/desktop/crates/rv-gtk/src/rail.rs
- apps/web/src/panels.ts
- apps/web/src/diagnostics.ts
- apps/web/tests/diagnostics.test.ts
- apps/server/src/factor_crypto.rs
- apps/web/src/security.ts
- apps/web/src/security-intents.ts
- apps/web/src/security-vault.ts
- apps/web/src/email.ts
- apps/web/tests/security-intents.test.ts
- apps/web/tests/security-vault.test.ts
- apps/web/tests/security-pending.mjs
- apps/web/src/totp-qr.ts
- apps/web/tests/totp-qr.test.ts
- apps/mobile/ui/nativeSecurity.tsx
- apps/mobile/ui/qrCode.tsx
- apps/mobile/ui/totpQr.ts
- apps/mobile/ui/totpQr.test.ts
- apps/desktop/crates/rv-gtk/src/native_security.rs
- apps/desktop/crates/rv-gtk/src/totp_qr.rs
- apps/desktop/macos/Sources/RocketVibe/SecuritySection.swift
- apps/desktop/macos/Sources/RocketVibe/TotpQrCode.swift
