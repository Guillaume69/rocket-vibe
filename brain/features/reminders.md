# Reminders ("Remind me")

A message can be turned into a personal reminder: at the chosen time the app notifies me with the message and opens it on a tap. Reminders live **on the device**, in each app's own store, for every server kind (Rocket.Chat, Mattermost, kChat, RocketVibe): no server stores or sends them, so none is needed and none is told (user decision 2026-10-11, over a RocketVibe server-side variant). They are therefore not shared between my devices.

## What every app does (the rule)

- **Set**: "Remind me" in a message's action menu (any message that has an id, mine or someone else's, in a room or a thread, encrypted rooms included once the text is readable) offers "In 1 hour", "In 3 hours", "Tomorrow at 09:00" (09:00 the next day on the device's clock) and "Pick a time" (a date and a time, at least a minute ahead, at most a year). Choosing stores the reminder and shows a short notice "Reminder set for <day and time>". One reminder per message and account: setting it again replaces the time.
- **Stored**: account, room id, room name, message id, the thread root when the message is a reply, author's display name, an excerpt of the text (first 140 characters, plain text, "Attachment" or "Message" when it has none), the due time, the creation time. Nothing leaves the device.
- **Fire**: at the due time a system notification titled "Reminder" with "<room name>" and "<author>: <excerpt>"; a tap opens the account, the room and the message (the thread when it is a reply), like a search result does. The reminder is then removed. An app that was not running at the due time fires it as soon as it starts (once, then removes it); a reminder more than 7 days late is dropped silently. Mobile schedules the notification with the system so it fires with the app closed.
- **See and cancel**: on the message, "Remind me" becomes "Cancel reminder" (showing its time) while one is pending. A "Reminders" list (reachable from the account/settings menu of each app) shows the pending ones of the current account, soonest first: time, room, author and excerpt; a row opens the message, "Cancel" removes it.
- **Sign out**: removing an account removes its reminders (and their scheduled system notifications).
- Every dialog or sheet closes on a click or tap outside, with nothing set or cancelled. Icons from each app's own set, never an emoji.
- FR / EN: "Remind me" / "Me le rappeler", "In 1 hour" / "Dans 1 heure", "In 3 hours" / "Dans 3 heures", "Tomorrow at 09:00" / "Demain à 09:00", "Pick a time" / "Choisir l'heure", "Reminder set for …" / "Rappel prévu pour …", "Cancel reminder" / "Annuler le rappel", "Reminders" / "Rappels", "Reminder" / "Rappel", "No reminders" / "Aucun rappel", "Cancel" / "Annuler".

## Web

`apps/web/src/reminders.ts` holds the reminder record, the offered times (`inHours`, `tomorrowNine`), the bounds (`acceptable`), the excerpt and which are due (`due`: fire, or drop when more than 7 days late). Reminders live in the browser's IndexedDB, store `reminders` (`apps/web/src/store.ts`, database version 5), keyed `<account>:<message>`, removed with the account by `purge`. `App` (`apps/web/src/app.ts`): `loadReminders` when an account activates (then `checkReminders` every 15 seconds while the tab is open, the timer cleared by `stop`), `checkReminders` (a due one is fired only by the tab that removes it from the store, so two tabs never fire it twice), `fireReminder` (a system notification when the page holds the permission, else a "Reminder" dialog with Open), `openReminder` (`GET /api/v1/messages/{id}` then `jumpTo`, the room when the message is gone), `setReminder` (replaces the message's earlier one), `cancelReminder`, `remindMenu` (the `actionMenu` from the message's menu button), `pickReminderTime` (a `datetime-local` dialog), `showReminders` (the list, from the account menu). The message menu shows "Remind me" or "Cancel reminder (<time>)". A tab that is closed at the due time fires the reminder when the page next opens. Tests: `apps/web/tests/reminders.test.ts`; browser `apps/web/tests/reminders.mjs` (set from the menu, the menu then offers to cancel, the list shows and cancels it, a reminder already due when the page opens fires a dialog whose Open leads to the message and leaves the store).

## Mobile

Every server kind (Rocket.Chat, Mattermost, kChat, RocketVibe): nothing goes through a provider.

- **Store**: table `reminders` of the account's database (migration `0030_reminders.sql`, `db/schema.ts`): `message_id` (primary key, so one per message and account), `rid`, `room_name`, `thread_id`, `author`, `excerpt`, `due_at`, `created_at`, and `scheduled` (the system holds, or held then fired, its notification). SQL in `db/upserts.ts` (`UPSERT_REMINDER` clears `scheduled` on a new time; `MARK_REMINDER_SCHEDULED` and `DELETE_DUE_REMINDER` act only on the time they name, so a late answer never touches a time set again meanwhile), `createReminderStore` in `db/store.ts`. Device data: the room purges leave it alone, but `NativeStore.prepare()` empties it with the projection, a new data epoch's messages not being the ones reminded of.
- **Rules** (`lib/reminders.ts`, Node-pure): `inHours` (to the minute), `tomorrowAt(now, 9)` (the next day on the device's clock), `remindable` (a minute to `latestReminder`, a year ahead, 29 February kept in February), the day stepper's `addDays` / `addMonths` / `clampDay`, `reminderExcerpt` (a Rocket.Chat quote's permalink, emphasis and code marks dropped, whitespace collapsed, 140 characters counted as code points, else "Attachment" / "Message"), the notification's identifier `reminder:<account key>:<message id>` (the account key is the database file's (server, account) slug, `reminderAccountKey`), `reminderContent` (title "Reminder", subtitle the room, which Android shows as the sub-text, body "<author>: <excerpt>", `data.reminder` with the account, server, user, room, message, due time and link) and its check `reminderPayload`, and `plainReminderLink` (`rocketvibe://room/<rid>?host=…&msg=…&tmid=…`; a RocketVibe account takes `nativeRoomPermalink`, which also names the instance and data epoch).
- **System** (`ui/reminders.ts`): `SyncProvider` mounts the store with the session (`mountReminders`, both drivers, next to the emoji usage). Scheduling is `scheduleNotificationAsync` with a `date` trigger on the Android channel `reminders` ("Reminders", HIGH, created on first use; messages keep `default`). expo-notifications 57 sets an exact alarm only when `canScheduleExactAlarms()`, else an inexact `setAndAllowWhileIdle` (read in `ExpoSchedulingDelegate.kt`): `app.json` declares `SCHEDULE_EXACT_ALARM`, granted at install on Android 12 and 13, off by default from 14 (the reminder then fires within the system's inexact window). Setting asks for the notification permission when the system still allows asking; refused, the reminder is kept and listed and the notice says notifications are off.
- **Reconciliation** (`planReconcile`, `reconcileReminders`), on mount and at each return to the front, one run at a time: a reminder still to come keeps its one notification (the identifier makes a second impossible), or gets one, or has it replaced when its time differs; a due one that was handed over and is no longer held was fired by the system and is removed; one never handed over, or still held although due (expo keeps the request when a force stop kills its alarm), is shown now and removed, unless more than 7 days late, then dropped. A held reminder notification of this account without a row is cancelled, and so is one of an account whose session is no longer on the device. A failed schedule leaves the row unmarked for the next run. Not covered: expo drops a past-due request at boot, so a reminder due while the phone was off is taken as fired and not shown.
- **Fire and tap**: in front, `ui/notifications.tsx`'s handler shows a reminder with its sound and removes it at once (`reminderShown`). A tap (running, or `getLastNotificationResponseAsync` on a cold start) pushes `/room/<rid>` with the payload's link as `roomLink`: another server's account asks to switch first (`OtherServer`), then RocketVibe resolves the link (`resolveRoomLink`), and Rocket.Chat and Mattermost now honour its `msg` and `tmid` too (`app/room/[rid].tsx`): the thread for a reply, else a jump to the message (`ui/messageJump.ts`).
- **Message sheet** (`app/message-actions.tsx`): "Remind me" (bell icon) for any message with an id that is not deleted nor a system event, an encrypted one once its text is readable; it arms the message (`armReminder`: room title, the author's shown name, the excerpt) and opens `app/remind-me.tsx`, a native formSheet declared in `app/_layout.tsx`: In 1 hour, In 3 hours, Tomorrow at 09:00 (each with its time or day), Pick a time (a day stepper, one day `‹ ›` or one month `« »` at a time between today and a year ahead, and a typed HH:MM, the approach of `app/send-later.tsx`, no picker dependency). Choosing stores, schedules and toasts "Reminder set for <weekday, date, time>" (`reminderFormatter`, the year when it is not this one). While one is pending the sheet shows "Cancel reminder (<time>)" instead, which removes the row, its scheduled notification and one still shown.
- **List** (`app/reminders.tsx`, a Settings row "Reminders"): the account's reminders still to come, read live from the table, soonest first: time, room (and "Thread reply"), author and excerpt; a row opens the message like a search result, "Cancel" removes it. "No reminders" when empty.
- **Sign-out**: `clearTraces` (`ui/session.tsx`: log out, a revoked token, a refused resume) calls `forgetReminders`: the account's scheduled and shown reminder notifications go, and its rows, through the store if still mounted, else the account's (cached) database.
- Sheets close on a tap outside with nothing set or cancelled. Strings: `reminders.*` in `ui/messages.ts`.
- Tests: `lib/reminders.test.ts` (times, bounds, stepper, excerpt, identifiers, content and payload, the link and its match, the plan: kept, scheduled, replaced, fired, missed, lost, over 7 days, orphans, signed-out accounts, a failed schedule retried), `db/upserts.test.ts` (the SQL), `db/schema.test.ts` (the migration). Not yet run on the emulator.

## Desktop

Not offered yet (GTK, SwiftUI).

## Sources

- brain/decisions.md
- apps/web/src/reminders.ts
- apps/web/src/app.ts
- apps/web/src/store.ts
- apps/web/tests/reminders.mjs
- apps/mobile/lib/reminders.ts
- apps/mobile/lib/reminders.test.ts
- apps/mobile/ui/reminders.ts
- apps/mobile/ui/notifications.tsx
- apps/mobile/ui/session.tsx
- apps/mobile/ui/sync.tsx
- apps/mobile/ui/messages.ts
- apps/mobile/app/message-actions.tsx
- apps/mobile/app/remind-me.tsx
- apps/mobile/app/reminders.tsx
- apps/mobile/app/room/[rid].tsx
- apps/mobile/app/settings/index.tsx
- apps/mobile/app/_layout.tsx
- apps/mobile/app.json
- apps/mobile/db/schema.ts
- apps/mobile/db/upserts.ts
- apps/mobile/db/store.ts
- apps/mobile/db/migrations/0030_reminders.sql
- apps/mobile/providers/rocketvibe/store.ts
- apps/mobile/node_modules/expo-notifications/android/src/main/java/expo/modules/notifications/service/delegates/ExpoSchedulingDelegate.kt
