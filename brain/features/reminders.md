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

Not offered yet (GTK, SwiftUI).

## Sources

- brain/decisions.md
