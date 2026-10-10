# Scheduled messages (RocketVibe server)

On a RocketVibe server, a text message can be written now and sent later: the server keeps it and sends it for its author at the chosen time, even if no app runs then. The author sees, in the room, what waits to be sent, and can cancel it. Rocket.Chat 8.5 has no such feature (only the app could hold the message, and it would only leave while the app runs) and Mattermost's is not mapped: neither offers it here.

## The contract

`docs/protocol/SCHEDULED.md`: `POST /api/v1/rooms/{id}/scheduled` (`ScheduleMessage`: `operation_id`, `text`, optional `reply_to`, `send_at` between one minute and 30 days ahead), `GET /api/v1/scheduled` (the account's pending and failed ones, every room), `DELETE /api/v1/scheduled/{id}`; the capability `scheduled_messages`. Types in `crates/rv-protocol/src/scheduled.rs`. Server: `apps/server/src/scheduled.rs` (commands, `drain`, the worker started in `main.rs` every 5 seconds), migration `0057_scheduled_messages.sql`. Sending goes through the ordinary send path as the author (one of their live sessions), with the scheduled row's `operation_id`, so a crashed worker never sends twice. A refusal turns the row `failed` with a code (`not_found`/`forbidden`-like refusals, `encrypted_room`, `no_session`), kept until its author removes it. Text only (a thread reply allowed); never in an end-to-end encrypted room. Tests: `apps/server/src/scheduled.rs`.

## What every app shows (the rule)

- Only when the server announces `scheduled_messages`, in a room that is not end-to-end encrypted, with text in the composer and nothing staged (no file).
- "Send later" next to the send button (an icon of the app's own set, never an emoji) offers: "In 1 hour", "Tomorrow at 08:00" (08:00 the next day on the device's clock), and "Pick a time" (a date and a time, at least a minute ahead, at most 30 days). Choosing sends `ScheduleMessage` with a new operation id (kept until the answer, so a retry replays it), `reply_to` set in a thread's composer; on success the composer clears and a short notice says "Scheduled for <day and time>".
- Above the composer, while the room has scheduled messages of mine (pending or failed): a chip "N scheduled" (FR "N programmé(s)"). It opens the list of this room's: time, the text (one or two lines), and Cancel; a failed one says it could not be sent (and why, briefly) and offers Remove. The list is read from `GET /api/v1/scheduled` (filtered to the room) when the room opens, after each schedule or cancel, and every minute while the room is shown, since a sent one leaves silently.
- FR / EN: "Send later" / "Envoyer plus tard", "In 1 hour" / "Dans 1 heure", "Tomorrow at 08:00" / "Demain à 08:00", "Pick a time" / "Choisir l'heure", "Scheduled for …" / "Programmé pour …", "Cancel" / "Annuler", "Could not be sent" / "N'a pas pu être envoyé", "Remove" / "Retirer".
- Every dialog or sheet closes on a click or tap outside, with nothing scheduled or cancelled.

## Web

Not offered yet.

## Mobile

Not offered yet.

## Desktop

GTK and SwiftUI, over rv-core; RocketVibe accounts only (Rocket.Chat, Mattermost and kChat sessions never arm it).

- **rv-core** (`rv-core/src/native/scheduled.rs`): `NativeSession::scheduled_supported` (the capability, which the desktop's client mask in `supported_features` turns on), `can_schedule(room)` (that, and the room not encrypted in the store), `schedule_message(room, reply_to, text, at)`, `scheduled_messages(room)` (`GET /api/v1/scheduled` filtered to the room) and `cancel_scheduled(id)`. Scheduling trims the text, refuses locally an encrypted room (`encrypted_room`), an empty or oversized text (`invalid_request`) and a time outside one minute to 30 days (`scheduled_time`, `accepted`), then checks the server's identity. **The operation id** lives in `Attempts`, keyed by (room, thread root, text): an attempt without an answer (network failure, 5xx, 429) leaves it there, so the next attempt of the same message replays it and the server answers the message it already made; any other answer removes it, and the next one is a new message. Pure helpers both UIs share: `in_one_hour`, `tomorrow_morning` (08:00 the next day on the given clock, the next whole hour when a clock change skips 08:00), `earliest`, `latest`, `when` ("today at 14:30", "tomorrow at 08:00", else "Oct 20 at 09:05" / "20/10 à 09:05", the year when it differs), `scheduled_notice` ("Scheduled for …"), `failure_key` (a failed one's code in a few words: encrypted room, no session left, no longer allowed to write; nothing for another code) and `error_key` (a refused schedule or cancel, `scheduled_sending` and `not_found` included). Strings: `scheduled.*` in `rv-core/src/i18n.rs`. The HTTP calls are `rv-client`'s `schedule_message`, `scheduled_messages`, `cancel_scheduled`. Tests: the module's own, and `rv-core/tests/native_scheduled.rs` over the fake HTTP server (a lost answer replayed with the same id, a thread reply under a new one, the local refusals sending nothing, the list filtered to one room, cancel and its refusals, the capability withdrawn).
- **GTK** (`rv-gtk/src/scheduled.rs`, `composer.rs`): a chevron (`pan-up-symbolic`, a `gtk::MenuButton`) between the field and the send button, shown only while a `Scheduler` is armed, the field has text, nothing is staged, no quote or reply is armed and no recording runs (`Composer::update_later`). Its popover offers the three choices; "Pick a time" is an `adw::AlertDialog` with a `gtk::Calendar` and two two-digit spin buttons, its Schedule response enabled only inside the window, presented through `widgets::present` (closes on its backdrop). Popovers close on a click outside. On success the field clears if it still holds what was scheduled, and the toast says "Scheduled for …"; a refusal toasts its sentence and keeps the text. Above the field, the chip "N scheduled" opens a popover list: when (or "Could not be sent: <why>"), "Thread reply" in the room's list, two lines of text, Cancel or Remove. `Composer::bind_native` and `bind_native_thread` record the room (and root) and `rearm_schedule` arms or drops the `Scheduler`; `ChatPage::on_native_change` calls it again for the room's and the thread's composer, so the capability or the room's encryption changing follows. A thread's composer schedules a reply and lists only that thread's. The `Scheduler` reads the list when armed, after each schedule or cancel, when the composer is mapped again, and every 60 s while it is on screen; an older read never overwrites a newer one. Smoke: `RV_SMOKE_SCHEDULE=<tag>` (`smoke.rs`).
- **SwiftUI** (`macos/Sources/RocketVibe/Scheduled.swift`, `Composer.swift`, `RocketVibeKit/ScheduledModel.swift`): rv-ffi `native_scheduled.rs` exports `can_schedule`, `schedule_times` (the menu's instants and the window, Unix seconds), `schedule_message` (answers the notice, a refusal worded as `RvError::Local`), `scheduled_messages(room, root)` (`ScheduledItem`, already worded) and `cancel_scheduled`. `RoomModel.supportsScheduling` and `scheduleDraft(at:)` (the draft clears unless typed over); a SwiftUI `Menu` on a `chevron.up` symbol by the send button under the same conditions as GTK; `ScheduledChip` above the composer; the list (`ScheduledList`) and "Pick a time" (`PickTimeCard`, graphical date and hour-minute pickers) are `modalOverlay` cards over the window's backdrop. `ScheduledModel.run` reads the list when the composer's room appears, then every minute, inside a `.task` keyed on the room model, which the room's leaving cancels.
- Run: GTK against a real RocketVibe server (2026-10-11, the Fedora container under Xvfb, `RV_SMOKE_SCHEDULE`): hidden with an empty field, offered with text, "In 1 hour" cleared the field and showed "1 scheduled", the server listed it, a cancel removed it and the chip left. The list popover and "Pick a time" were not clicked through. SwiftUI: `RocketVibeKit` (the model and the `RoomModel` extension) builds on Linux against the generated bindings; the views are checked by `swiftc -parse` and the macOS CI only.

## Sources

- crates/rv-protocol/src/scheduled.rs
- apps/server/src/scheduled.rs
- apps/server/src/main.rs
- apps/server/migrations/0057_scheduled_messages.sql
- docs/protocol/SCHEDULED.md
- crates/rv-client/src/lib.rs
- apps/desktop/crates/rv-core/src/native/scheduled.rs
- apps/desktop/crates/rv-core/src/native.rs
- apps/desktop/crates/rv-core/src/i18n.rs
- apps/desktop/crates/rv-core/tests/native_scheduled.rs
- apps/desktop/crates/rv-gtk/src/scheduled.rs
- apps/desktop/crates/rv-gtk/src/composer.rs
- apps/desktop/crates/rv-gtk/src/chat_native.rs
- apps/desktop/crates/rv-gtk/src/smoke.rs
- apps/desktop/crates/rv-ffi/src/native_scheduled.rs
- apps/desktop/macos/Sources/RocketVibeKit/ScheduledModel.swift
- apps/desktop/macos/Sources/RocketVibe/Scheduled.swift
- apps/desktop/macos/Sources/RocketVibe/Composer.swift
