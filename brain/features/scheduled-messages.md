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

`apps/web/src/scheduled.ts` holds the offered times (`inOneHour`, `tomorrowMorning`), the bounds (`acceptable`), the room filter (`forRoom`) and the 24-hour `when` label. `App` in `apps/web/src/app.ts`: `canSchedule` (capability, room not encrypted, posting allowed, nothing staged), `sendLater` (the `actionMenu` above the button), `pickTime` (a dialog with a `datetime-local` field), `schedule` (keeps its operation id in `scheduling` until the answer, so a retry of the same text and time replays it; clears the composer and its saved draft only if the text is unchanged), `refreshScheduled` (on room open and every minute from `open`, after each schedule or cancel), `cancelScheduled`, `showScheduled` (the list dialog, Cancel or Remove). The "Send later" button (icon `up`) sits left of send in the room composer (`apps/web/src/ui/application.tsx`) and the thread composer (`apps/web/src/ui/thread.tsx`, with the thread root as `reply_to`); the chip `.scheduled-chip` sits above the room composer. Tests: `apps/web/tests/scheduled.test.ts`, browser `apps/web/tests/scheduled.mjs` (schedule from the menu, the chip, the server row an hour ahead, nothing sent, then Cancel).

## Mobile

Not offered yet.

## Desktop

Not offered yet (GTK, SwiftUI).

## Sources

- crates/rv-protocol/src/scheduled.rs
- apps/server/src/scheduled.rs
- apps/server/src/main.rs
- apps/server/migrations/0057_scheduled_messages.sql
- docs/protocol/SCHEDULED.md
- apps/web/src/scheduled.ts
- apps/web/src/app.ts
- apps/web/src/ui/application.tsx
- apps/web/src/ui/thread.tsx
- apps/web/tests/scheduled.mjs
