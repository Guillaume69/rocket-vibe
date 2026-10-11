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

Not offered yet.

## Mobile

Not offered yet.

## Desktop

GTK and SwiftUI share one store and one rule, in rv-core; neither can wake up on its own, so a reminder due while the app was closed fires at its next start (the decision's accepted cost).

- **Store** (`rv-core/src/reminders.rs`, `Reminders::new(<config>/rocket-vibe-rs)`): one JSON file per account, `reminders/<host>[_<port>]-<user id>[-<RocketVibe instance>].json`, holding the account (`Owner`: server URL, user id, RocketVibe instance and data epoch, never a token) and its `Reminder`s (room id and name, message id, thread root, author, excerpt, due and creation times in Unix seconds). A file per account rather than the account's SQLite: the timer reads every account's reminders without opening their databases, signing out deletes one file, and the GTK and SwiftUI apps on one Mac share the directory as they share the quick-reaction counts ([emoji](emoji.md#quick-reactions-and-reacting-with-any-emoji)). Every change re-reads the file under a process lock and an advisory file lock (`reminders/.lock`), then writes through a temporary file of its own name, so the two apps merge and only one fires a given reminder; an emptied file is deleted. `set` replaces a reminder about the same message; `get`, `pending` (soonest first), `cancel`, `remove_account`.
- **Rule**: `excerpt` (the message's words on one line through `runs::preview`, quote links stripped, the first 140 characters; "Attachment" or "Message"), `in_hours`, `tomorrow_at_nine` (09:00 the next day on the local clock, the next whole hour when a clock change skips it), `accepted` (one minute to 365 days), `when` and `notice` (the scheduled messages' wording, "tomorrow at 09:00"), `cancel_label`. `take_due(now)` hands every account's due reminders out once and removes them, dropping those more than 7 days late; `wait(now)` says when to look again (the next due time, at least 1 s, at most 60 s so a reminder the other app set is seen). Each `Fired` carries a key (`rv-reminder:<file>:<message id>`) and a `link` built by `reminders::link`: `rocketvibe://room/<rid>?host=…&userId=…&msg=…[&tmid=…]`, plus the RocketVibe identity for such an account. `links::parse` accepts a `userId` beside a `host` for any account (before, only RocketVibe links could carry it): it pins the account, never widens the choice.
- **Timer and notification, GTK** (`rv-gtk/src/reminders.rs`): `start` runs once the window's notifier exists (missed ones fire at once), a one-shot GLib timeout re-armed with `wait`, and `poke` after each set. `Notifier::remind` (`rv-gtk/src/notifier.rs`) shows "Reminder" with "<room>" and "<author>: <excerpt>" through the same backends as message notifications: `org.freedesktop.Notifications` (the key and link recorded as the notification's room and message), rv-native toasts (on Windows activated as the `rocketvibe://` link itself), or `gio::Notification` (`app.open-message`). A click reaches the notifier's `open` callback or `AppWindow::open_notification`, which recognise the key's prefix and call `AppWindow::open_link`: the account is switched to if needed, then the room, the message, and the thread for a reply (`show_room_link`).
- **GTK menus**: "Remind me" in both message menus (`actions_menu.rs` for Rocket.Chat, Mattermost and kChat, `chat_native.rs` for RocketVibe), for any sent message that is not a system line (`reminders::offered`). Clicking it swaps the popover's content for the four choices, so a click outside still closes it with nothing set. "Pick a time" is the scheduled messages' dialog (`scheduled::pick_time`: an `adw::AlertDialog` with a calendar and hour and minute spins, through `widgets::present`) with the reminders' words and bounds. While one is pending the entry reads "Cancel reminder (<when>)". A toast says "Reminder set for <when>" or "Reminder cancelled".
- **GTK list**: "Reminders" (`alarm-symbolic`) in the account menu at the sidebar's foot, under Settings, opens `reminders::list`, an `adw::Dialog` of the account's pending ones, soonest first (when, "room · author", the excerpt on two lines, Cancel). A row opens its message through the same link; the list redraws when one fires or changes (`reminders::changed`).
- **Signing out**: GTK's `logout` and an expired session call `reminders::forget`; rv-ffi's `accounts::remove` (sign-out, RocketVibe logout, expired session) does the same.
- **SwiftUI** (`rv-ffi/src/reminders.rs`, `RocketVibeKit/RemindersModel.swift`, `RocketVibe/Reminders.swift`): rv-ffi exports `reminder_times`, on `Chat` and `NativeChat` `set_reminder(draft, due)` (the notice, or a worded refusal), `reminder(message_id)`, `reminders()` and `cancel_reminder`, and on `Client` `take_due_reminders` and `reminder_wait_seconds`. `AppModel.startReminders` loops on them (restarted after each set) and hands each fired one to `onReminder`, which `Notifier.showReminder` turns into a `UNUserNotificationCenter` notification (the room as subtitle, the link in its `userInfo`); its click calls `AppModel.openLink`. The message context menu offers a "Remind me" submenu (`alarm`) whose "Pick a time…" opens `PickTimeCard(reminder:)` in a `modalOverlay`, or "Cancel reminder (<when>)"; the account menu's "Reminders" opens `RemindersList` in a `modalOverlay` (`AppModel.remindersShown`). `remindersRevision` makes the menu and the list read the store again.
- **Proof**: rv-core unit tests (round trip, replace, cancel, due and missed firing with their links, the 7-day drop, account removal, excerpts, times), rv-ffi's (the GTK directory, firing once, forgetting), and the GTK smoke `RV_SMOKE_REMINDERS=<other room>` (`rv-gtk/src/smoke/reminders.rs`) against Rocket.Chat 8.5: set and cancel from the menu, a late one dropped, a near one notified once and gone, its click opening the message from another room, the list's cancel, removal with the account. RocketVibeKit builds and its tests pass on Linux against the generated bindings; the SwiftUI views are parsed there and built by the macOS CI only.

## Sources

- brain/decisions.md
- apps/desktop/crates/rv-core/src/reminders.rs
- apps/desktop/crates/rv-core/src/links.rs
- apps/desktop/crates/rv-gtk/src/reminders.rs
- apps/desktop/crates/rv-gtk/src/notifier.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-gtk/src/actions_menu.rs
- apps/desktop/crates/rv-gtk/src/chat_native.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/scheduled.rs
- apps/desktop/crates/rv-gtk/src/smoke/reminders.rs
- apps/desktop/crates/rv-ffi/src/reminders.rs
- apps/desktop/crates/rv-ffi/src/accounts.rs
- apps/desktop/macos/Sources/RocketVibeKit/RemindersModel.swift
- apps/desktop/macos/Sources/RocketVibe/Reminders.swift
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/desktop/macos/Sources/RocketVibe/Notifier.swift
- apps/desktop/macos/Sources/RocketVibe/Scheduled.swift
