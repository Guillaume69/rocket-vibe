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
- apps/web/src/app.ts
- docs/protocol/PROFILES.md
- docs/protocol/PUSH.md
