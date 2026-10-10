# Do not disturb (RocketVibe server)

An account on a RocketVibe server can silence its notifications on a schedule (quiet hours: a daily window such as 22:00 to 08:00) or until an instant (a mute: for one hour, until tomorrow morning). Messages still arrive and count as unread in every app; only alerts stop: no push, no call ring on the phone, no desktop or browser notification. Rocket.Chat and Mattermost accounts have no such setting here.

## The contract

- Preferences (`docs/protocol/PROFILES.md`): `quiet_hours` (`QuietHours` in `crates/rv-protocol/src/profiles.rs`: `start_minute`, `end_minute` since midnight, distinct, below 1440, `start_minute > end_minute` when it crosses midnight, `time_zone` an IANA name, the device's when saved) and `muted_until` (RFC 3339, at most seven days ahead). In `UpdatePreferences` both are `Option<Option<_>>`: **absent keeps**, `null` removes, so a client that does not send them never wipes them; `UserPreferences` returns them, `muted_until` only while it is in the future. `QuietHours::covers` is the rule every client applies.
- Server (`docs/protocol/PUSH.md`): `account_quiet` (migration `0055_quiet_hours.sql`) reads the window in its own zone (`now() AT TIME ZONE`) and the mute. `audible_push_recipients`, the eligible recipients minus those in do not disturb, decides capture (`push.rs`, the send transaction) and delivery (the worker's claim, and the retirement of pending pushes): a message sent in quiet hours never pushes, it is not deferred. Reading a delivered push's content and replying from it keep `eligible_push_recipients`, so a notification shown before quiet hours still answers. A call ring to an account in do not disturb is skipped like one to a busy callee (`voice.rs`, `start_ring`). Validation: the window (`QuietHours::valid`), the zone (`chrono_tz`), the instant (`profiles.rs`); tests in `apps/server/src/push/tests.rs`.
- The apps' own notifications follow the same rule locally, with the device's clock.

## Web

Settings > Notifications, group "Do not disturb" (`panels.ts`): a "Mute notifications" choice (for 1 hour, until 08:00, unmute; the row says until when) and "Quiet hours" (a switch and two time fields, saved on change with the browser's time zone, `Intl.DateTimeFormat().resolvedOptions().timeZone`). `quietNow` (`src/quiet.ts`, tested in `tests/quiet.test.ts`, `minuteIn` reading the window's zone through `Intl`) stops `App.notify` while quiet.

## Mobile

Not offered yet: the server holds push back for a mobile account too, but the app cannot set the schedule.

## Desktop

- **The rule** (`rv-core/src/native/quiet.rs`): `quiet` (muted, `mute_ahead`, or `in_quiet_hours`) reads the window in its own zone through `chrono-tz` (`minute_in`; this machine's local time when the name does not parse), the same answer as the server's `account_quiet`; `mute_end` turns a choice into `muted_until` (`hour`: one hour from now, `morning`: the next 08:00 on this machine's clock, `next_morning`), `window` two `HH:MM` texts into a `QuietHours` carrying this machine's zone (`workflows::system_time_zone`, `iana-time-zone`). Unit tests: a window across midnight, a zone other than UTC (Paris, New York), an unknown zone, a mute, the choices.
- **The app's own alerts** (`rv-core/src/native/notifications.rs`): `update_notification_preference` keeps the account's window and mute beside `desktop_notifications` (`do_not_disturb`, refreshed at connection, each minute and after every own-profile read), and `publish_notifications` drops every new notification while `NativeSession::quiet_now` holds: like the server, a message received in do not disturb never alerts later. A notification shown before stays, and its click and reply still work. Tested in `native_preferences_thread_replies_and_account_scope_survive_dispatch` (a mute, a window in Tokyo time, then a window that does not cover now). This covers GTK and SwiftUI, which both receive native notifications through `NativeSession::incoming`.
- **GTK** (`rv-gtk/src/settings/native_profiles.rs`, Settings > Notifications, group "Do not disturb" under the notification choice): a "Mute notifications" combo row (Off or Muted, For 1 hour, Until 08:00, Unmute when muted; the subtitle says "Until HH:MM", and turns back to Off by itself when the mute ends) and a "Quiet hours" expander row whose switch saves at once (on with the two times shown, 22:00 to 08:00 by default; off removes the window), its subtitle "Every day, <zone>", and From and To entry rows saved by their apply button (`dnd.invalid_time` toast for a bad or empty window). Each save is an `UpdatePreferences` with only the changed field set (`preferences_input` leaves both absent, which keeps them), queued and resumable like the other preferences; while one is pending the rows show it and are not editable.
- **SwiftUI** (`macos/Sources/RocketVibe/SettingsView.swift` `DoNotDisturbSection`, under the Notifications section for a RocketVibe account; `MyProfileModel.mute` / `setQuietHours`): the same picker (redrawn each half minute so an ended mute reads Off), a "Quiet hours" toggle and two time fields saved on Return. rv-ffi (`native_profiles.rs`): `NativePreferences` carries `quiet_hours` (`NativeQuietHours`) and `muted_until` (Unix seconds) read only, `update_preferences` keeps them, `mute_notifications` and `set_quiet_hours` (the window saved in this machine's zone) change one each, `quiet_now`, and the free `quiet_clock` / `quiet_minute`.

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
- apps/web/src/app.ts
- apps/desktop/crates/rv-core/src/native/quiet.rs
- apps/desktop/crates/rv-core/src/native/notifications.rs
- apps/desktop/crates/rv-gtk/src/settings/native_profiles.rs
- apps/desktop/crates/rv-ffi/src/native_profiles.rs
- apps/desktop/macos/Sources/RocketVibe/SettingsView.swift
- apps/desktop/macos/Sources/RocketVibeKit/MyProfileModel.swift
- docs/protocol/PROFILES.md
- docs/protocol/PUSH.md
