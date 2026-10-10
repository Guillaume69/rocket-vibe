# Do not disturb (RocketVibe server)

An account on a RocketVibe server can silence its notifications on a schedule (quiet hours: a daily window such as 22:00 to 08:00) or until an instant (a mute: for one hour, until tomorrow morning). Messages still arrive and count as unread in every app; only alerts stop: no push, no call ring on the phone, no desktop or browser notification. Rocket.Chat and Mattermost accounts have no such setting here.

## The contract

- Preferences (`docs/protocol/PROFILES.md`): `quiet_hours` (`QuietHours` in `crates/rv-protocol/src/profiles.rs`: `start_minute`, `end_minute` since midnight, distinct, below 1440, `start_minute > end_minute` when it crosses midnight, `time_zone` an IANA name, the device's when saved) and `muted_until` (RFC 3339, at most seven days ahead). In `UpdatePreferences` both are `Option<Option<_>>`: **absent keeps**, `null` removes, so a client that does not send them never wipes them; `UserPreferences` returns them, `muted_until` only while it is in the future. `QuietHours::covers` is the rule every client applies.
- Server (`docs/protocol/PUSH.md`): `account_quiet` (migration `0055_quiet_hours.sql`) reads the window in its own zone (`now() AT TIME ZONE`) and the mute. `audible_push_recipients`, the eligible recipients minus those in do not disturb, decides capture (`push.rs`, the send transaction) and delivery (the worker's claim, and the retirement of pending pushes): a message sent in quiet hours never pushes, it is not deferred. Reading a delivered push's content and replying from it keep `eligible_push_recipients`, so a notification shown before quiet hours still answers. A call ring to an account in do not disturb is skipped like one to a busy callee (`voice.rs`, `start_ring`). Validation: the window (`QuietHours::valid`), the zone (`chrono_tz`), the instant (`profiles.rs`); tests in `apps/server/src/push/tests.rs`.
- The apps' own notifications follow the same rule locally, with the device's clock.

## Web

Settings > Notifications, group "Do not disturb" (`panels.ts`): a "Mute notifications" choice (for 1 hour, until 08:00, unmute; the row says until when) and "Quiet hours" (a switch and two time fields, saved on change with the browser's time zone, `Intl.DateTimeFormat().resolvedOptions().timeZone`). `quietNow` (`src/quiet.ts`, tested in `tests/quiet.test.ts`, `minuteIn` reading the window's zone through `Intl`) stops `App.notify` while quiet. Saves run one after another, each with the revision the previous one left (two quick edits would otherwise race to the same revision). Browser test: `tests/quiet.mjs` (mute, schedule with the browser's zone, edits that keep the other field, no error).

## Mobile

Settings > Notifications, under the push choice, on a RocketVibe account only: a "Do not disturb" card (`ui/doNotDisturb.tsx`, `DoNotDisturbCard`). "Mute notifications" says Off or until when (the hour today, the day and hour beyond) and offers chips: for 1 hour, until 08:00 (`nextMorning`, shown in the app's time format), and Unmute while muted. "Quiet hours" is a native `Switch` and, while on, two HH:MM `PillField`s (22:00 to 08:00 by default, `DEFAULT_QUIET`), saved when a field is left, with the phone's IANA zone (`deviceTimeZone`, `ui/workflowsModel.ts`); an equal or unreadable pair shows `settings.quietInvalid` and sends nothing. No modal, no new dependency. "On right now" shows while `quietNow` holds (re-read every 30 s).

Writes go through `useNativePreferences` (`ui/nativePreferences.ts`) and `NativeChat.updateOwnPreferences`, whose command is `preferencesInput` (`providers/rocketvibe/profileOperations.ts`): `quiet_hours` and `muted_until` are put in only when the change names them, `null` to remove, so the mute never resends the schedule, nor the reverse, and a push level or language save leaves both absent (tested in `providers/rocketvibe/profiles.test.ts`, the store's decode and the transport included). The page shows one save state below both cards (`NativeSaveState`: the error, Retry or Cancel of a pending command).

`lib/quiet.ts` is the web's rule ported (`covers`, `minuteIn`, `quietNow`, `mutedUntil`, `clock`, `minuteOf`, `nextMorning`, `validWindow`; `lib/quiet.test.ts`). `minuteIn` asks Hermes' `Intl.DateTimeFormat` for the window's zone through `format` and a parse (no `formatToParts`), and falls back to the phone's clock if the engine refuses the zone.

The app raises no notification of its own for a RocketVibe message: every message notification is an FCM push the server sent (`plugins/native-push-source.js`, `ui/notifications.tsx` only displays received pushes), and the server sends none while quiet. Incoming calls: the server skips the system ring (`VoiceRinging`), but with the app open the in-app ring prompt and its ringtone (`VoiceRingHost`, `ui/voice.tsx`, from the live `rings`) still show, as for a busy callee and as on the web.

## Desktop

Not offered yet (GTK, SwiftUI): the server holds push back, the desktop's own notifications do not follow it.

## Sources

- crates/rv-protocol/src/profiles.rs
- crates/rv-protocol/src/parity.rs
- apps/server/migrations/0055_quiet_hours.sql
- apps/server/src/profiles.rs
- apps/server/src/push.rs
- apps/server/src/voice.rs
- apps/server/src/push/tests.rs
- apps/web/src/quiet.ts
- apps/web/src/panels.ts
- apps/mobile/lib/quiet.ts
- apps/mobile/ui/doNotDisturb.tsx
- apps/mobile/ui/settingsSections.tsx
- apps/mobile/ui/nativePreferences.ts
- apps/mobile/providers/rocketvibe/profileOperations.ts
- apps/mobile/ui/voice.tsx
- apps/web/src/app.ts
- apps/web/tests/quiet.mjs
- docs/protocol/PROFILES.md
- docs/protocol/PUSH.md
