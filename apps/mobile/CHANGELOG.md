# Changelog

Notable changes to the mobile app. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/). The version lives in
`app.json` (with `package.json` and `android.versionCode`); a `mobile-vX.Y.Z` tag publishes the
release, and its notes are that version's section here.

## [Unreleased]

### Added

- Teams (experimental): start a one-to-one chat from New conversation. People are searched across your organisation, as in Teams' own search box, and the chat opens at once; the first message sent creates it on Teams' side. Group chats cannot be started yet.

### Fixed

- Teams (experimental): the first message to someone you never wrote to is delivered; Teams refused it (404) because the chat did not exist yet, so the app now creates the chat first.
- Teams (experimental): channels still showing "1" while Teams shows nothing unread now read as Teams does: a channel hidden from its team's list is never unread, and one Teams flags unread with no message to read is read.
- Teams (experimental): a chat with one person and a bot is named after the person, not "Name, 28:…", and opens as their direct chat; a channel already named after its team reads "Tech - GED", not "Tech · Tech - GED".
- Teams (experimental): a mention shows the person's whole name ("@Marc-Etienne BARRUT", not "@Marc-Etienne" then "BARRUT"), a mention of me is highlighted, and a notification names the people mentioned.
- Teams (experimental): a reply quoting a message shows the quote as a quote card, its author and text apart, instead of the author glued to the text above stray spaces.
- Teams (experimental): reactions such as :loudlycrying: and :smilerobot: show their emoji (😭, 🤖) instead of their name.
- Rocket.Chat, Mattermost and kChat: `@name` and `#name` show as plain text when no such person or room exists, instead of as a mention or a room link. On Rocket.Chat only the people and rooms the server lists for the message stay links; on Mattermost and kChat a username the server does not know and any `#word` (Mattermost links rooms with `~`) stay text. Messages already stored keep their old look until the server sends them again.
- Slack (experimental): "New conversation" finds people and opens a direct conversation with one of them, or a group one with several; it only answered "Search failed".
- Teams (experimental): one-to-one, group and meeting chats missing from the list now show: chats are also read from Teams' own conversation list, page by page, the people in a one-to-one chat named from their profiles, and a chat Teams marks hidden shows again once it has a message. A Teams account no longer offers "New conversation", whose search could only fail.
- Teams (experimental): a channel post shows its subject as a bold title above its text, in the room and the room list, and shows "N replies" under it when it has replies, opening its thread; replies were kept out of the room with no way to reach them. Editing a post with a subject keeps the subject out of its text.
- Teams (experimental): a channel is named after its team too ("Tech · General") wherever it is not under its team's header, in Unread, Favorites and the room's header, so each team's General can be told apart. Channels Teams only shows in the team list (every team's General) are no longer listed as favorites.
- Teams (experimental): channels no longer stay unread for good. A channel never opened or hidden in Teams, or whose last activity is a membership or topic event, showed a "1" that opening it could not clear; opening a room now marks it read up to the last message Teams lists, even when nothing new arrived while the app was open, and its badge goes at once.


## [0.24.0] - 2026-10-25

### Added

- A long press on a link in a message offers to open it or copy its address, instead of the message's actions, whose Copy took the whole message.

### Changed

- Encrypted Vibez conversations respond several times faster, most of all in rooms with some history: the encryption engine no longer decrypts and re-verifies its whole saved state several times for each step of a send.
- WhatsApp (experimental): the WhatsApp engine is rewritten in Rust on whatsapp-rust, the same as the desktop's, in place of the Go engine on whatsmeow. Existing WhatsApp accounts must be linked again once: the new engine cannot read the old one's saved state. The linked device is named Rocket Vibe on the phone, and Settings > App > Open-source licences lists the Rust crates it is built from.

## [0.23.0] - 2026-10-24

### Added

- Microsoft Teams (experimental): images show in the conversation, both those pasted into a message and the preview of an image file.
- Microsoft Teams (experimental): send a file in a chat, not only a channel. Like the Teams app, it is stored in your OneDrive's Microsoft Teams Chat Files folder and shared with the chat's members, without an email.

## [0.22.0] - 2026-10-24

### Fixed
- Microsoft Teams: presence (who is online, away or busy, and setting your own status) now works against the live service, which needed a Microsoft sign-in token for the presence service rather than the chat token.

### Added
- Rename a channel from its information: on Rocket.Chat with the right to edit the room (its address changes with it), the display name on Mattermost and kChat, and the name on Slack and Microsoft Teams (experimental). An empty name is refused. On Slack, the room information (name, topic, purpose and member count) now opens too.
- Microsoft Teams (experimental): calls. A call started in a conversation shows as a call card with Join, and once over as the call's length; Join on a channel call opens the call itself, and the call button (or Join on a chat call) the conversation, in the Teams app (or the browser). The app does not carry a Teams call's audio or video itself.
- Microsoft Teams (experimental): send a file to a channel. It is stored in the channel's SharePoint folder, like the Teams app does, and shows as a downloadable file; no inline image preview yet, and a chat cannot receive files this way.
- Microsoft Teams (experimental): pin and unpin a channel message, see which messages are pinned, and list a room's pinned messages (among its latest 200) in the pinned panel, which shows no saved tab on Teams.
- Microsoft Teams (experimental): download a file shared in a conversation.
- Microsoft Teams (experimental): the room's member list, each person with their role (read-only; Teams offers no add, remove or role change here).
- Microsoft Teams (experimental): search a room's messages (through Microsoft Search); matches show their text, author and time and open the room. Teams' search index has no per-message id, so it cannot jump to the exact message.
- Microsoft Teams (experimental): a room information panel showing the conversation's name, kind and topic, and a profile card on tapping an author or a direct conversation showing their name, work email and whether the account is a bot. The room topic, the profile card and presence (who is online, away or busy) are all read from the live service.

## [0.21.0] - 2026-10-22

### Added

- Settings > Notifications warns when Android does not let the app show an incoming call over the lock screen (Android 14 and later can withdraw it), and its Allow opens the system setting.
- Microsoft Teams as an experimental server kind, behind the nine-activation unlock: sign in with a Microsoft device code (the app shows the code and opens Microsoft's page), then chats and channels with their unread state, history, live new messages, edits, reactions and deletions, and sending, editing, deleting, reacting, marking read, the typing indicator, channel thread replies and presence (who is online, away or busy; setting your own status).
- Group direct messages on Rocket.Chat, Mattermost and kChat accounts: in New conversation, tick several people (up to seven), remove one by tapping their chip, then Start.

### Fixed

- Mattermost and kChat: the first message of a conversation the app did not know yet (a group conversation someone else just started) counts once in the unread badge, not twice.
- Mattermost and kChat: a room no longer keeps 1 unread for good after someone joins, leaves, is added or is removed live; opening it clears it again.
- Mattermost and kChat: a direct or group conversation created elsewhere now shows in the list when its first message is your own, a conversation from past the list's limit comes back with a new message (the oldest one leaving), and on kChat a group conversation you are added to shows without waiting for a message.
- A profile photo with transparent parts (a kChat bot's logo) no longer shows the coloured tile and its initial through it.
- A bot account (kChat, Mattermost, Vibez, or a Rocket.Chat account with the bot role) no longer reads "Offline" on its profile: bots show no presence, and a kChat or Mattermost bot's direct conversation no longer carries a presence dot.
- Mattermost, kChat, Slack and Teams: the room list's preview follows an edit of the last message, and a deleted last message gives way to the one before it (or to nothing) instead of staying in the list. The room keeps its place. A Vibez room's preview no longer shows a thread reply.
- New conversation finds people on Mattermost and kChat accounts, where every search failed.
- Rocket.Chat (Jitsi) and kChat (kMeet) calls go on with the app in the background or the phone locked: the microphone, the camera and the sound no longer cut and the call no longer drops. An ongoing call notification shows the call and hangs up.
- The message bar's buttons line up, the polls, stickers and GIFs button reads "GIF" instead of a second smiley, and the formatting row no longer touches the bar.

### Removed

- The experimental Teams browser-import read preview and its developer browser helper, replaced by the Teams server kind.

## [0.20.0] - 2026-10-17

### Added

- A long press on a reaction under a message shows who reacted: a sheet with a tab per emoji and the people behind it, you first.
- Switching server reopens the room you last had open on that server, unless a link or a notification opens another one.
- Tables written with pipes (`| a | b |`), as Mattermost and Slack integrations post them, show as a grid that scrolls sideways when it is too wide.
- Mattermost and kChat: a link to another post shows that post as a quote under the message, with its files and its author's name, as the official apps do.
- Mattermost and kChat: a reminder the server posts ("Hi there, here's your reminder about this message…") reads in the app's language.
- A post from a Mattermost or kChat incoming webhook, or a Rocket.Chat message sent under an alias, shows under its own name and picture, with the BOT badge for an integration or a bot account (kChat's Euria too), and is grouped apart from its poster's own messages.
- Mattermost and kChat: the buttons of integration cards are drawn and work, in the room and in a post only you can see (kChat's Delete and View reminders): the integration's answer shows as a note only you see or opens its page, and a refusal says "This action failed".
- Mattermost and kChat: the menus of integration cards work too: a tap opens a sheet with the integration's choices, or people or channels searched as you type, and the choice goes to the integration, which answers like a button.

### Changed

- A private room shows a lock on its coloured tile, so it no longer looks like a public channel, which keeps `#`. Encrypted rooms keep their grey lock.
- Mattermost and kChat: a mention shows the person's name under the account's name format, as the official apps do, instead of the username, also for someone the app had not met yet.
- Integration cards (kChat's Euria requests, Mattermost bots) show their text above the card, and their titles, texts and field values formatted: emoji, links, bold.
- Mattermost and kChat: a post only you can see (a command's answer, kChat's confirmation of a reminder) now shows its cards too, and a reminder's confirmation reads in the app's language with its due time instead of the server's English.
- kChat signs in with one button, in a sign-in page inside the app; the personal API token field is gone.
- Experimental Slack accounts sign in with one button, in a sign-in page inside the app, with no browser helper or pasted session; several workspaces are offered to choose from.

### Fixed

- Signing out of one server opens another server you are still signed in to, rather than the server choice with no way back.
- The sign-in page forgets the previous server type's error when you switch type.

## [0.19.0] - 2026-10-15

### Added

- Experimental Slack accounts: behind the experimental unlock (activate the login icon nine times), Slack is a server kind; pair with the browser helper or paste a session, and the account is saved with its conversations, unread counts, history and threads like any other server's. New messages, edits, deletions, reactions, reads and typing arrive live, and you can send messages and thread replies, edit, delete, react and mark read. Slack's emoji, skin tones, custom emoji and status emoji show as in Slack, and a huddle appears as a call card; joining one, or starting one from the call button, opens it in Slack in your browser. Custom emoji whose names have accented letters show too. Images, videos, voice messages and files sent in Slack show in the conversation. You can also send files, search a conversation, pin and save messages (Slack's "saved for later" are your starred messages), and see and set presence.

- An experimental Teams browser-import preview under the same nine-activation unlock as Slack: one-use public-key pairing, native conversation/history views and session-expiry checks. A separate development browser helper is required; real Teams sign-in remains unverified, and persistent accounts, sync and sending are still pending.

### Changed

- WhatsApp is now offered only behind the experimental unlock (activate the login icon nine times), like Slack. The experimental panel no longer has a Slack preview: Slack is a server kind of the login page.

## [0.18.1] - 2026-10-14

### Fixed

- Text messages send again on kChat accounts. Since 0.14.0 every one of them failed ("Failed, retry"), while pictures and files still went out.

## [0.18.0] - 2026-10-14

### Added

- A link to a post on X (Twitter) shows as a card like the post: the author's name, handle and photo, the text, and its picture or video image, as the server collected them. A tap opens the post in the X app or the browser. Rocket.Chat servers collect nothing from X, so on a Rocket.Chat account the app reads the post from X itself (only there).

## [0.17.0] - 2026-10-14

### Changed

- The RocketVibe server is now called Vibez: the server choice at sign-in, labels and messages say Vibez. Saved accounts on such a server must be added again. This version needs Vibez 0.7.0 or later: older RocketVibe servers are no longer recognised, and encrypted rooms from before the rename no longer open.

## [0.16.0] - 2026-10-13

### Added

- Create a channel or a private group on Rocket.Chat accounts: "Create a room" in the room list, with a name and the Private switch. The new room opens at once, and a refused name says why (already taken, or not accepted by the server).
- Activity: a bell in the home header lists the messages that mention you, replies in your threads and your messages others reacted to, newest first, from the messages already on the phone, with the rooms that have unread mentions above them. A tap opens the message, or its thread.

### Changed

- The app's own sounds (incoming call ringtone, ringback, voice session cues) play 30 % quieter.

## [0.15.0] - 2026-10-13

### Added

- Experimental WhatsApp accounts on Android: choose WhatsApp among the server types to link a personal account with a code typed in WhatsApp (or a QR for another phone). Its chats, names, profile photos, messages, reactions, edits, deletions and unread counts appear like any account; photos, videos, voice notes and documents show in the timeline and can be sent, voice notes recorded in the app arriving as real WhatsApp voice notes; you can reply quoting a message, react, edit, delete and read, and see who is typing (and be seen); New conversation finds your contacts, groups or any WhatsApp number; files show while they send. Settings > App lists the open-source licences of the WhatsApp engine. New messages notify with Reply and Mark as read, and "Receive in the background" (notification settings) keeps the account connected with the app closed, under a permanent notification.

### Fixed

- Keep incoming calls visible until Accept or Decline. Tapping outside or pressing Back cannot dismiss the call, including the Android lock-screen prompt; remote cancellation, expiry and account teardown still close it.

## [0.14.0] - 2026-10-12

### Added

- RocketVibe administrators can create, share, list and revoke account invitation codes.
- RocketVibe servers accept a verified email address in place of the username at sign-in.
- Setting up an authenticator on a RocketVibe account shows a QR code of the setup link to scan, next to the key for manual entry, and an "Open in authenticator app" action that hands the link to an authenticator on the same phone.

### Fixed

- The RocketVibe Security settings keep showing the account's status after a change that needed a fresh identity confirmation. The unfinished change (email address, authenticator, backup codes, email codes) appears with Continue and Cancel and completes once the identity is confirmed; "Try again" only appears after a failure.
- Verifying an email address already linked to another RocketVibe account says so instead of showing a generic failure.
- The sign-in field reads "Username" when redeeming a recovery code or an invitation, which take a username only.
- Scope Mattermost and kChat searches to the current channel, direct conversation or group before the server's result limit, so busy teams no longer hide older room matches.
- Mattermost and kChat protected media now belongs to its account and live session. Logout and account switching remove media credentials and cached copies, and late downloads cannot restore them.
- Typing /giphy opens a compact GIF grid immediately. Search updates as you type in both the command and sharing-menu pickers; choosing a GIF highlights it, and Enter or the shared Send button sends it. Search changes discard old selections and stale responses, and cancellation preserves the draft.
- Isolate account databases with a SHA-256 identity, preserve unambiguous legacy drafts and pending sends during upgrade, and reconcile existing reminders with the new identity.
- Commit optimistic messages and their outbox entries together, so a failed queue write leaves no orphaned message.
- Keep Rocket.Chat, Mattermost and kChat HTTP deadlines and cancellation active until the response body finishes.
- Recover Mattermost and kChat sends by a persistent operation marker. Ambiguous legacy matches remain visible for manual retry instead of silently discarding a new identical message.
- Fold room-list sections (unread, favorites, rooms, direct messages, sidebar categories) per account instead of across every server. Each signed-in account starts from the folds shared before, once, and signing out drops the account's folds.

## [0.13.0] - 2026-10-11

### Added

- Quick polls, game-night RSVP cards, private sticker shelves and ephemeral voice reactions on RocketVibe servers in unencrypted rooms.
- A GIF search and selection picker for /giphy, preserving the draft on cancel and supporting thread replies. RocketVibe needs server GIPHY configuration; installed clients also support Rocket.Chat commands.preview.


## [0.12.0] - 2026-10-11

### Added

- Android can check GitHub for a newer mobile APK from Settings > App, show an optional update notice, download with progress and SHA-256 verification, and install through Android confirmation while retaining app data. Update checks and installation recovery work independently of chat accounts.
- "Remind me" in a message's actions, on every server: in 1 hour, in 3 hours, tomorrow at 09:00, or a day and time you pick, up to a year ahead. At that time a notification shows the room, the author and the start of the message, even with the app closed, and opens the message (its thread for a reply). The reminder is kept on the phone only; when Android would deliver it late (exact alarms off, the default from Android 14), the app explains it once and offers "Alarms and reminders", and the Reminders list keeps an Allow banner until it is granted; "Cancel reminder" on the message, or the Reminders list in Settings, removes it, and signing out removes the account's reminders.
- A Read-only switch in the room settings of a Rocket.Chat room (with the right to edit it), saved only when switched; the composer follows the new state. On a RocketVibe server, the room information's member list can now remove a member (confirmed) and add one by username, a member's name opens their profile, and the list reloads after a role change or a membership change.
- A call started in a direct conversation on Rocket.Chat or kChat rings: the incoming call
  card with the ringtone, Accept opens the call, Decline tells the server, a tap outside
  only silences it. On Rocket.Chat the push rings it over the lock screen on Android
  (Accept and Decline in the notification) and as a time-sensitive alert on iOS; kChat
  sends no push to this app, so it rings while the app runs.

### Fixed

- On Rocket.Chat, owners and moderators can still write in a read-only room: the composer stays open for whoever the server lets post there.
- Native Android builds explicitly compile Expo's generated package list so a clean or cached build cannot launch with its modules missing.

## [0.11.0] - 2026-10-11

### Added

- On RocketVibe servers, "Send later" (the chevron beside send, or a long press on send) schedules the typed text: in 1 hour, tomorrow at 08:00, or a day and time you pick, up to 30 days ahead; in a thread it schedules a reply. The server sends it even if the app is closed. A "N scheduled" chip above the composer lists the room's scheduled messages, to cancel one, or to remove one that could not be sent and see why. Not offered in end-to-end encrypted rooms.
- On a RocketVibe account in do not disturb, an incoming call shows in the open app without ringing.
- On RocketVibe servers, read receipts: under your latest message, "Seen" in a direct conversation, "Seen by" and up to three names (then how many others) in a group, updated live. Settings > My account has a "Share read receipts" switch under Privacy; turned off, others no longer see how far you read and you no longer see how far they did.
- The home header can hide or show the server bar directly. A bottom account bar offers my activity from the avatar through a compact native sheet, shows its presence badge and keeps Settings within reach.

- On RocketVibe servers, Settings > Notifications offers "Do not disturb": mute notifications for 1 hour or until 08:00, or set daily quiet hours (22:00 to 08:00 by default, in the phone's time zone). Messages still arrive; push notifications and call rings stop meanwhile.
- A filter field at the top of the room list narrows it to the rooms whose name matches, accents and case aside, best matches first, as the desktop's Ctrl+K switcher ranks them.
- On Rocket.Chat servers, a button in the room header lists the room's threads, all of them or only the ones you follow, latest reply first; a bell on each thread and in the thread's header follows or unfollows it.
- On Rocket.Chat servers, a long press on a room in the list marks it as unread, or as read when it has unread messages.
- On Rocket.Chat servers, the room's information sheet chooses the room's own notifications: default, all messages, mentions or nothing, applied to push and desktop alike.
- The room list shows the time of each room's last message (the hour today, the weekday this week, the date beyond), and the unread badge reads `@n` in pink when you are mentioned, as on the desktop.
- Mentions of you, `@all` and `@here` stand out on a pink tint, as on the desktop.
- Email addresses in messages open the mail app.
- A line break typed in a list item continues the list (`- `, `* `, `1. `), and one on an empty item ends it, as on the desktop.
- A video call card offers "Meeting information": the meeting's link without your personal token, to copy or open in the browser.
- On Rocket.Chat servers, "Forward" in a message's actions sends it, as a quote, to another room you pick.
- A search button in the room list searches messages across every room, among those already on the device, newest first; a result opens the room at the message.
- On Rocket.Chat servers, a thread reply can also be sent to the room ("Also send to the room" above the thread composer).
- On Rocket.Chat servers, the room information sheet shares an invite link to a channel or group (for owners, moderators and admins), valid 7 days, in the server's own address.
- On Rocket.Chat servers, discussions: their card in the parent room opens them (joining a public one), and "Start a discussion" on a message or "New discussion" in the room information creates one.
- A formatting row ("Aa" beside the emoji button): bold, italic, strike, link, code, code block, quote and lists, around the selection, as on the desktop.
- On Rocket.Chat servers, the room information sheet lists the room's members (owners and moderators first, searchable), each opening its profile; a long press makes or removes a moderator or an owner, or removes someone from the room, as your rights allow.
- On Rocket.Chat servers, those allowed to edit a room change its topic, description and announcement from its information sheet.
- My profile can remove my photo (Rocket.Chat and RocketVibe), after a confirmation.

### Changed

- The interface draws its icons with the desktop's monochrome GNOME Adwaita icons, tinted by the theme, instead of colour emoji that looked different on every phone: buttons, headers, menus, settings, administration, voice controls, attachments and file types.
- Screen readers say what those icons alone show: an encrypted room, a voice participant's muted microphone, sound, camera or shared screen, the state of checkboxes.
- The composer is laid out like the desktop's: a single outlined field holding attach, emoji and microphone, lit cyan while typing, and a round send button that stays in place, dimmed while there is nothing to send, and turns into stop while recording.

### Fixed

- On Mattermost and kChat, a thread's "N replies" moves as soon as someone answers, not at the next catch-up.
- On Mattermost and kChat, search in a channel asks the server for that channel's matches only, so a busy team no longer leaves it empty.
- On Mattermost and kChat, a star set or removed in another client shows at once, and a starred message no longer loses its star when it is edited or reacted to.
- On Mattermost and kChat, a muted channel no longer turns bold nor rises into Unread for ordinary messages; a mention still shows its badge.
- On Mattermost and kChat, a room that changed more than a thousand times while the app was away reloads its newest messages instead of keeping a history with holes.
- On Mattermost and kChat, a message whose send answer was lost (a network drop) is looked for before it goes out again, instead of posting it twice once the server has forgotten it.
- On Mattermost and kChat, a message sent again while the server is still saving the first attempt stays "sending" until it shows, instead of turning "not sent".

- Quote cards show emoji as glyphs instead of their `:shortcodes:`.
- The room list previews a reply by its own words and a forwarded message as "↪ Quoted message", no longer by the raw quote link.

- A message the server refused no longer goes out again on every send: it waits for "Retry", so a few refused messages can no longer use up Rocket.Chat's 10 requests a minute and hold back the next message.
- A message sent while the server restarts behind its proxy (a 5xx answer) stays queued instead of showing "not sent".
- Signing out of a RocketVibe server, or switching accounts from it, now forgets that account's names, profile cards, call status and badge, as signing out of Rocket.Chat already did.
- Private quotes and source previews now use the latest verified message edit.
- Keep device-invitation controls available to a room member before MLS admission, while preserving server refusals for an already accepted group.

## [0.10.0] - 2026-10-09

### Added

- The server bar shows each server's own icon when it has one, and administrators set or remove it from the Dashboard (Rocket.Chat and RocketVibe).
- Server administration: administrators add custom emoji (name, aliases, image) and delete them, on Rocket.Chat and RocketVibe servers.
- Settings > Accounts can hide the server bar, giving its width to the conversation list; switching and adding a server stay on that page.

### Fixed

- Rocket.Chat: people are named the way the server says (`UI_Use_Real_Name`): usernames by default, real names when the server shows them, in notifications too, which showed real names while the app showed usernames. Search shows a channel's display name like the list.

## [0.9.1] - 2026-10-09

### Fixed

- RocketVibe workflow messages retain their BOT identity through live author-profile updates when connected to the updated native server.

## [0.9.0] - 2026-10-09

### Added

- A pill over the top of a room, "N new messages since HH:MM", while the first unread
  message is above the view; a tap scrolls to it.
- Bots on a RocketVibe server: a "My bots" settings page lists your bot accounts, creates
  one (when the administrator allows it), edits its description and scopes (each explained,
  with the API routes it opens), creates keys shown once with a ready-to-copy `curl` example,
  revokes keys, renames the bot, sets or removes its photo and deletes a bot. A "BOT" badge marks bots in messages, profiles (with their
  owner) and room members; the administration dashboard has the "Users can create bots"
  switch, and its Users list marks RocketVibe bots and no longer offers making a bot an
  administrator. A room with a bot member cannot be encrypted, and the app says so.
- Workflows on a RocketVibe server: a "Workflows" settings page lists your automations
  (trigger in words, on or off, last run and its error) and edits them: a name, the bot
  they act through, a trigger (a slash command, a schedule by hour, day or week in your
  time zone, someone joining a room, a reaction in a room (any emoji or one), a message
  containing some text, or a webhook whose URL is shown once; the room triggers fire for
  people only, never for a bot), and steps to
  add, reorder and remove (send a message, wait, call an HTTP service, ask a form), with
  the variables each text may use one tap away. Save, test now (a command is tried by
  typing it), turn off, delete and the last 50 runs. A form a workflow posts shows as a card in the room; its recipient, or any
  member, answers it in a native sheet, and the card then says who answered. A form field
  can ask for a person, among a list picked in the editor or any member of the room, and
  a choice or a person field can take several answers, ticked as checkboxes. Workflow
  commands appear in the composer's command list of the rooms where they are offered.

- Mattermost servers: sign in with your username and password (and your MFA code), then
  read and write as on Rocket.Chat: rooms, unread counts and mentions, live messages,
  threads, files, reactions, edits, deletions, pins, saved messages, search in a room,
  room information and profiles, who is typing and presence. Push is not available on
  these servers yet.
- kChat (Infomaniak): choose kChat, no address to type, then sign in with your
  Infomaniak account in the browser or paste an Infomaniak API token, and pick your
  kChat server when the account has several.
- Mattermost and kChat: the server's custom emoji show in messages, reactions, the picker
  and completion.
- kChat: a room read in another kChat app is marked read here at once.
- Mattermost and kChat: people show under your account's name setting (first and last
  name by default on kChat), with their status emoji; conversations you closed in kChat
  stay hidden, and only as many direct messages as your account asks are listed. Both
  settings are in My account, shared with kChat's own apps. Integrations' cards show.
- kChat: start a kMeet call from a room and join one from its card, as with Rocket.Chat's
  calls.
- Mattermost and kChat: the room list follows your sidebar, with your own categories as
  sections in your order and your favourites; favouriting a room from its information
  updates the server's sidebar too.
- The login screen's server type picker offers Mattermost and kChat; in automatic mode
  a Mattermost server and a kChat address are recognised on their own.
### Fixed

- Settings pages keep the field being typed in above the keyboard instead of leaving it
  hidden under it.

## [0.8.0] - 2026-10-08

### Added

- React with any emoji: the message sheet offers the 5 emoji you react with most on this
  account (counted on the phone only), then "+" opens the emoji picker, the server's custom
  emoji included (standard emoji only in a private RocketVibe conversation). On Rocket.Chat a
  reaction goes out under a name the server accepts, and the picker hides the emoji it
  refuses.
- Server administration for administrators, from the settings or a long press on the open
  server's tile: a dashboard (version and whether a newer release exists, uptime, database,
  users, rooms, messages, uploads, open reports), the moderation of reported messages and
  accounts (reasons, dismiss, delete the message, deactivate), every room, discussions and
  teams included, and every account with its actions (admin right, activation, deletion).
  On Rocket.Chat and RocketVibe.
- Rocket.Chat administration: the dashboard opens on the server's last computed figures,
  dated, and a refresh asks for new ones; a figure the account may not read shows as
  unknown instead of failing the dashboard. Deactivating or deleting the last owner of rooms
  asks again, naming the rooms that will be deleted and those whose owner changes; deleting
  says that the person's direct messages go too. A reported message the administrator
  cannot reach offers Rocket.Chat's own deletion of all that author's reported messages,
  explicitly. A message from an encrypted room reads "Encrypted message".
- Report a message from its sheet, or a user from their profile, with a reason the
  administrators read.
- RocketVibe: a deleted account's messages stay, signed "Deleted user".
- Settings show the app's version, in the new App category.

### Changed

- Settings are grouped in categories (My account, Notifications, Language, Encryption,
  Security, Devices, Accounts, App), each on its own page and shown only when it has
  something for the account; Sign out sits at the bottom of the list.
- A tap outside a dialog, or Back, closes it like Cancel, never running its confirming
  action.
- A tap outside the incoming call prompt, or Back, ignores the call: the prompt hides and
  the ringing stops, but the call is not declined.

### Fixed

- Closing the message sheet before its action finished no longer leaves the room as well.

## [0.7.0] - 2026-10-07

### Added

- Voice on a RocketVibe server, Discord style: voice channels you enter with a tap and
  can also write in, and a call in any room from the header's call button. A voice
  screen shows a card per person, lit up while they speak, with microphone, sound,
  speaker and leave controls and the chat one tap away; the people connected appear
  under each room of the list, and a "Voice connected" panel stays at its foot. The
  call keeps going in the background, with an ongoing call notification to mute or leave.
- Calling someone in a direct message rings them, with an original ringtone: a full
  screen incoming call, even locked, to accept or decline. A missed, declined or
  finished call shows its outcome in the conversation, and calling back is one tap.
- "Create a room" on a RocketVibe server, voice channels included.
- An owner can turn a room into a voice channel, or back, from its information's edit form.
- In a voice session, turn your camera on (off by default) and share your screen: one
  screen at a time in a room, a new share replacing the current one. The shared screen
  takes most of the screen, with everyone in a column at its right. The shared screen
  carries its apps' sound (media, games), never the voice chat.
- Voice options beside the microphone: where the sound goes, the input volume with a live
  level meter, the output volume, noise removal (RNNoise, on by default), deafen and the
  screen share's quality.
- A long press on someone in a voice session sets their volume (up to 200 %) or mutes them
  for you only; the choice is remembered.
- The people of a voice session fill the screen as large tiles, and a whisper now lights
  up its tile.
- Tap a shared screen to watch it full screen.
- A direct call ends for you too when the other person hangs up, and you are taken back to
  the conversation when it ends.
- The noise remover also closes your microphone between words, so typing no longer goes
  through.
- Calling again from a direct conversation where you were left alone in the call rings the
  other person once more.
- Voice in encrypted rooms, end-to-end encrypted: the server relays sound it cannot
  hear, under a key only the room's devices share, renewed when its members change.
- Slash commands on a RocketVibe server: /topic, /invite, /kick, /leave, /join,
  /msg and /status run on the server; /me, /shrug, /tableflip, /unflip,
  /lennyface and /gimme are written by the app, so they also work in encrypted
  rooms (on Rocket.Chat too).
- Typing "/" lists every command in a panel that narrows as you type; tap one to
  complete it.
- A server rail down the home screen's left edge: a button per signed-in server to
  switch in one tap, "+" to add one, and a dot on a server with unread messages
  (checked every minute while the app is open).
- The sign-in screen offers the server type under the address: automatic (the default),
  Rocket.Chat or RocketVibe. A forced type is probed alone, for a server whose proxy hides
  what the automatic detection looks for.
- A Rocket.Chat server whose reverse proxy refuses `/.well-known/` (a 403, as on
  chat.barrut.me) is found again: only a positive RocketVibe answer stops the Rocket.Chat
  probe; it used to report "no Rocket.Chat reachable at this address".
- RocketVibe entries concern the native RocketVibe server provider. Rocket.Chat accounts keep
  all their features, and both providers' accounts live side by side in the existing account
  switcher. Native capabilities not implemented yet (production E2EE, among others) stay
  disabled.
- Everything about RocketVibe end-to-end encryption (E2EE) in the entries without a
  "RocketVibe:" prefix near the end of this list is experimental. Production E2EE stays
  disabled, and the panels sit behind the experimental E2EE capabilities.
- Connection to Rocket.Chat and RocketVibe servers in the same screens: room list, search for
  people and DMs, Markdown, text, history and persistent drafts. Sessions stay in the Keystore;
  SQLite keeps messages, cursors and the send queue.
- RocketVibe: the journal resumes after an interruption, sends are replayed with the same
  identifier, and a room's local data is purged when you leave it. A change of server identity
  or generation asks you to sign in again.
- RocketVibe: sign-up on invitation in the existing sign-in screen. Resuming after a lost
  response keeps the same account, and the flow checks the server's identity and generation
  before saving the session.
- RocketVibe: two-factor authentication in the existing form, with an authenticator app (TOTP)
  or a backup code. An interrupted validation resumes from secure storage without consuming a
  second code or touching another account.
- RocketVibe: password recovery with an operator code in the existing sign-in. Your identity
  and conversations are kept, old sessions are revoked, a lost confirmation can be resumed, and
  encryption keys are preserved.
- RocketVibe: a password recovery code can be requested by e-mail in the existing form, with the
  original request resumed from secure storage and the retry delay kept. Clearing the form is
  explicit, and signing in after a reset keeps the installed factors.
- RocketVibe: sessions are renewed before they expire. The saved intent resumes after a lost
  response, and signing in again keeps the account's drafts and outbox.
- RocketVibe: connected devices in the existing settings, with names, activity and expiry
  dates, and revocation after a recent sign-in. Alerts kept from a former account cannot act on
  the new one.
- RocketVibe: server capabilities are checked at every reconnection and limited to the features
  the app supports. Provider diagnostics carry a request identifier.
- RocketVibe: the server's delay is respected after a `429`, without losing the account or
  reconnecting too early. Resuming was tested after a real cursor expiry, with the draft and the
  offline send kept.

- RocketVibe: TOTP setup, private backup codes, replacement and deactivation in the existing
  settings. Interrupted operations resume from secure storage, and codes stay recoverable until
  you confirm them.
- RocketVibe: private e-mail address in the existing settings, with a verification code,
  delivery status and resume from secure storage after an interruption. The typed code stays
  transient, and an old verification never replaces the next one.
- RocketVibe: e-mail codes for sign-in and identity confirmation in the existing screens, with
  explicit delivery and the same candidate resumed from secure storage after a lost response.
  Resends keep the same code and expiry, and the typed code only lives in memory.
- RocketVibe: e-mail codes can be enabled and removed in the existing settings, with a
  confirmation tied to the contact and the factors shown, the receipt resumed from secure
  storage and the shared backup codes presented. Another installed factor is kept, and the
  address must be released from the profile before it is replaced or removed.
- RocketVibe: a profile protected by e-mail only shows as active and can regenerate its shared
  backup codes without SMTP. Requesting or resuming an identity confirmation code clears the
  previous input.
- RocketVibe: the e-mail contact can be removed after confirmation, with the original intent
  resumed from secure storage and a private receipt until you tap Done. A delayed cancellation
  keeps the next contact, and the flow still works without SMTP.
- RocketVibe: a rejected address can be dismissed explicitly before a new entry, without
  blocking the form or erasing the contact already verified.
- RocketVibe: identity confirmation on the current device before a sensitive action, without a
  new session. Typed passwords and codes stay transient, and callbacks from an old screen or
  account cannot start an action.

- RocketVibe: room information shows the topic, description, announcement, member count and
  read-only state from the active provider. It refreshes after a change and hides its data once
  you leave the room. Long texts scroll in the sheet.
- RocketVibe: settings, paginated member list, roles and leaving a room in the existing room
  sheet, according to your current permissions. Interrupted commands resume from their original
  receipt, and a rejected form is kept until you reread it or clear it. The last owner must pass
  the role on before leaving.
- RocketVibe: search and membership for public rooms in the existing screen. An interrupted
  creation keeps its identity in SQLite so it can be retried after reconnecting or restarting
  without creating a second room.
- RocketVibe: the composer follows your effective permissions after a settings or role change.
  Owners and moderators can write in a read-only room, and members see the existing message. An
  old response restores no permission after you leave or after a new room version.
- RocketVibe: favorites in the existing room sheet. Only the confirmed preference changes the
  room's ranking. A pending request shows Resume, and a refusal allows an explicit clear.
  Rocket.Chat keeps its official action through the active provider.
- RocketVibe: confirmed unread and mention badges, and the existing new-messages bar with the
  position captured when you open the room. Read timers use a confirmed message that is really
  visible in the list for the open membership, not just the last cached message. A burst does not
  push the timer back, and going to the background or closing saves what was already seen.
  Badges stay confirmed offline, and the bar remains after acknowledgement.
- RocketVibe: reads and favorites resume from SQLite after an interruption. The observed
  message is kept and the original favorite receipt is recovered, without restoring an old
  preference.
- RocketVibe: presence in DMs and typing in the existing composers, expiring after an outage and
  stopping when the app is suspended. @here mentions target the members present when you send.
- RocketVibe: search in a room's messages through the native provider, in the existing screen.
  Results are temporary, permissions are checked, and Enter reruns the search. Rocket.Chat
  search uses its own provider.
- RocketVibe: system lines for room creations, members and settings changes in the existing
  rows, in French or English, without creating unread counts or message actions on these events.

- RocketVibe: confirmed native messages are rendered by the existing components from a typed
  document shared with the desktop app. The composer's bold, italic and strikethrough
  conventions are kept. Code, quotes, link labels and escaped mentions never become active
  mentions, and Markdown images stay literal until native files arrive.
- RocketVibe: edit and delete in the existing action sheet, according to server permissions.
  Intents and revisions are kept in SQLite and resume after an interruption, and the text of a
  rejected edit stays recoverable when you reopen it. A concurrent conflict is shown without
  overwriting the new text.
- RocketVibe: edits and deletions in the existing screens, with an edit marker, local erasure,
  and revisions that stop a late history from restoring the text. A reset replaces the
  confirmed history while keeping the drafts and send queue of rooms you can still access.
- RocketVibe: editing a native reply keeps its quote references, even if the source was deleted
  or you lost access to it. The saved intent keeps the same content across an outage and a
  restart. An old edit without captured content keeps its draft and asks you to submit again.
- RocketVibe: reactions in the existing action sheet and pills. Emoji aliases are deduplicated,
  and SQLite intents resume after a lost response or restart without changing message order.
- RocketVibe: public pins and personal stars in the existing actions and lists. Intents resume
  after a restart, and stars stay private and keep their state when the message is updated.
- RocketVibe: sends resume after a temporary failure or a lost response, even when the socket
  stays connected. Retries keep the SQLite identity, respect `Retry-After`, and stop when the
  account is suspended or signed out.
- RocketVibe: sends resume automatically after permissions are revalidated, without marking the
  persistent intent as permanently refused.
- RocketVibe: native threads in the existing screen, with a reply counter, quotes in a thread, a
  separate draft and a reply that survives an outage. Reading a thread leaves the others unread.
  Deleting its root keeps the draft and blocks new replies.
- RocketVibe: native quotes in the existing Reply action, banner and composer, including
  without added text. References go to the durable queue, and a rejected selection keeps the
  words you typed. An unavailable source shows an explicit label and its private preview is
  erased.
- RocketVibe: quotes can be nested two levels deep in the existing cards. Each source keeps its
  own permissions, and removing a child source erases its private text without hiding the parent
  that is still accessible, even after a restart.
- RocketVibe: quotes feed the existing cards from a cache that separates references from allowed
  excerpts. Edits, deletions and access removals at the source update the quotes in other
  rooms, and older replies do not restore a deleted excerpt. The SQLite migration is additive,
  and native text is kept even if it looks like an old Rocket.Chat prefix.
- RocketVibe: quotes keep the source message's files, with a protected thumbnail for images and
  a compact summary for documents, voice messages and videos. Removal from the source room or
  deletion of the message removes access to them.
- RocketVibe: file upload with progress, resume after a restart and cancellation from the
  existing controls. Native images, voice messages, videos and documents go through a verified
  private cache and the current players. Streaming from disk requires rebuilding the app with
  the new native module.
- RocketVibe: custom server emojis appear in the existing pickers, completion, messages and
  reactions. Protected images are removed after a catalog update or an account change.
- RocketVibe: integration cards show author, title, text, color and fields in the current
  message rows, for Rocket.Chat and RocketVibe. Native cards follow room permissions and message
  search.
- RocketVibe: link previews for articles, images and videos use the existing cards, with private
  thumbnails tied to the message and to room access. The viewer keeps zoom and saving to the
  gallery, and an edit, an access removal or an account change removes the pixels from memory.
  The native server enables them when an object volume is configured.

- RocketVibe: edit your profile, status and photo in "My profile", with the language
  synchronized with native preferences. A save whose confirmation was lost resumes after a
  restart without overwriting a more recent change. Rejected forms stay recoverable, and a
  username change can ask for the existing identity confirmation. The verified address is
  changed from the security section of the settings.
- RocketVibe: user profiles in the existing sheet, from an author or a mention, with native
  username, name, bio and photo. Identity changes also update messages and DM avatars. Protected
  photos go through the provider and a bounded memory cache purged on account change, and
  preloading refuses responses from the account you left.
- RocketVibe: calls are wired to the room and profile buttons, the call card and the existing
  Jitsi screen. An interrupted attempt resumes the same call on the next tap, even after a
  restart, and account or membership changes and late responses are controlled. The Rocket.Chat
  flow stays available. Media qualification on Jitsi and on a phone is still open.
- RocketVibe: native links per instance and epoch, with proxy paths kept and the registered
  account checked before an explicit switch. The existing menus can copy a message link, and
  notifications also point to the message or thread, with authorized resolution and
  highlighting in the current screens.
- RocketVibe on Android: FCM registrations tied to the RocketVibe account, content fetched
  through a private session, conversation notifications and idempotent deferred replies. Links
  and notification removal respect the instance and account. The Rocket.Chat flow stays
  available. Firebase and phone qualification is still open.

- Crypto vault on Android: a local Kotlin and Rust Expo module tied to the existing provider's
  session lifecycle. Keys and checkpoints stay in the private engine, and small platform records
  are wrapped by a non-exportable Android Keystore key and excluded from automatic backups.
- The vault opens without implicit creation and initializes locally on request. Copied, removed
  or corrupted vaults are refused, and it closes for good after suspension or an account or HTTP
  device change. The Android system lock is held until the real write ends, even after the view
  closes.
- The Gradle build is reproducible for ARM64 and x86-64, with generated Kotlin bindings and an
  instrumentation test on the real Keystore. This storage base does not yet enable pairing,
  groups or the mobile E2EE composer.
- Encrypted pairing on Android: the existing settings use the Rust identity ceremony shared with
  the desktop app. It covers explicit creation, fingerprint comparison on another device,
  preview, a separate approval and manual transfer of the public codes.
- The original registration is kept in the vault before any HTTP call. A lost response resumes
  by reading the receipt without a second submission, and a device or account change, closing
  or a signed revocation refuse late actions. The flow was tested through the Kotlin bindings
  and the real Android Keystore on an emulator. Full groups, mobile conversations and the full
  flow in the installed app still need qualification.
- Encrypted groups on Android: room information and a DM contact's sheet use the same Rust
  engine as the desktop app. They cover publishing invitation keys, creation, adds, removals and
  rotation, membership and re-admission, and received transitions.
- A preview of the recipients and fingerprints comes before a separate confirmation. Consents
  and originals stay in Rust, a lost response is resumed by receipt without a second
  submission, and an abandonment is kept before it is sent to the server.
- The view is tied to the room membership, the projection and the current HTTP device. A new
  submission revalidates the right to send, and an accepted decision stays recoverable read-only.
  Wiring the conversations and the full GUI qualification are still open.
- Contacts' identities: the existing user sheet lets you explicitly view the encrypted identity,
  with a first contact pinned but not verified, fingerprint comparison, and replacement of a
  changed root while keeping the old fingerprint.
- An opaque preview comes before a separate confirmation of the devices. Pins and consents stay
  in the Rust vault. A learned signed revocation stays blocking after reopening and after a
  server omission, and an account or device change or closing prevents a late action. The sheet
  scrolls when available so the actions stay reachable.
- Encrypted conversations on Android: reading and sending text in the existing list and
  composer, with history kept in the Rust vault and the exact order of the private journal.
- Separate private drafts per thread and membership, saved on each keystroke with no network
  request and no write to the ordinary tables. Suspension, sign-out and a membership change
  close the view and hide its content.
- A lost response resumes the original intent by receipt, an abandonment is durable, and the
  abandoned document is restored into an empty draft.
- Times are local observations, and the history is what the vault retained. Actions, search,
  archives and private files are not wired yet.
- Encrypted threads: open and reply in the existing thread screen, with the root and replies
  from the private journal, exact order and a draft separate from the room. A send can be
  resumed or abandoned and its draft restored in the same vault. Leaving the screen or
  suspending the app closes the view and removes the clear text.
- Counters show the replies kept on this device. A root missing from the vault leaves the
  available replies readable and blocks a new send. Full archives are still to come.
- Encrypted quotes: the existing reply menu and banner quote a retained private message,
  including a thread reply. A quote alone can be sent, and only its identifier and revision
  enter the MLS document, with no copy of the excerpt.
- Cards are resolved in the vault, with access checked for each room, two levels and cycle
  cutting. An unavailable source loses its excerpt, and leaving the screen or suspending the
  app also erases the composer preview. A resume keeps the original ciphertext after a lost
  response or a reopening.
- Android can quote an encrypted message in an ordinary room, from the same actions and the same
  composer. Sending keeps only the reference, the server checks the device's history access, and
  no excerpt is provided. Cards and the banner read the allowed sources from the native vault
  into a volatile projection. A removal, a membership change, closing or suspension erase the
  private words, which are never copied to SQLite.
- Existing private cards also read plain sources from their cache, checking the membership and
  the room's unencrypted status. An edit or a removal refreshes the excerpt, and neither an old
  membership nor the ordinary rows of a room that became encrypted can restore it. Encrypted
  descendants are rebuilt in the volatile view, without copying their words to SQLite.
- Reply in another conversation: the existing action sheet offers a destination among the joined
  conversations where sending is allowed, with local search. Private and plain sources can be
  quoted into the allowed ordinary or encrypted destinations, and the composer stays that of the
  chosen room.
- Protected sending accepts plain and private references in the same MLS document. Scope,
  membership, private membership and revision are reread before preparation, and the original
  packet stays recoverable after a lost response. Previews are rechecked when returning to the
  composer and erased when it closes.
- Local encrypted history: conversations read already verified documents from the local archive
  once the warm cache is forgotten, covering older pages, thread roots and counters, and the
  last page after reopening. A removed membership hides its projection. Settled messages
  leave the warm cache and, once settled, the operation registry by themselves, so
  conversations keep receiving past 64 and 8,192 messages and quotes can pick sources from
  the whole verified history. Portable history recovery
  remains open.
- Identity recovery: the existing settings prepare an encrypted copy of the identity and
  temporarily show its code. Publishing requires confirming that the code was kept outside the
  app, and resuming or abandoning keep the original intent after a lost response or a restart.
- A new device can verify its code, then recover the identity with its own keys. Sensitive
  fields are erased when closing or going to the background. This flow does not restore history
  yet.
- Device removal: the existing settings list the other encrypted devices and offer review,
  explicit confirmation and resume of the signed removal, asking for a recent sign-in check
  when needed. The proof and the original request stay in the vault. A lost response, a view
  change or an omission from the directory does not restore the device, and a resume reads the
  receipt before any original send. Conversations must still refresh their recipients, and
  installed qualification and history recovery remain open.
- Device renewal: the existing settings show the certificate expiry and let you request its
  renewal, including after expiry, keeping the same root, incarnation, signing key and vault
  selection. Explicit approval and registration resume their original operation after an
  interruption. The authenticated directory keeps the owner's expired certificates to allow
  this, while correspondents see the valid ones.
- The existing room controls report the renewed certificate from the verified MLS leaf. An
  explicit update and a journal resume gate new sends. The Rust bridge exercises two devices and
  the reception of the renewed commit. Installed qualification is still open.
- The room controls explicitly offer "Replace and reinvite" for a renewed peer. This choice
  pairs the removal of the old device with its addition using a fresh package, and a removal
  alone does not reinvite it. A stale certificate in the view or an unapproved device refuses
  the preparation. The new membership removes the old message cache, and historical archive
  recovery and installed qualification remain open.
- Encrypted history from your other devices, in the existing encryption settings: a new
  device asks for it and shows a fingerprint; another device of the account lists the request,
  shows the rooms and message counts to share, and shares after you compare the fingerprint.
  The new device then imports it page by page and the server copy is deleted. Scrolling past
  the device's own oldest message then continues into the recovered messages, with the time
  the sharing device received them.
- History backup with its own code (`rvh1-…`, separate from the identity code), in the same
  settings: enabling shows the code and publishes once it is saved, other devices join with
  the code, devices holding it upload their encrypted history as messages arrive, and a new
  device restores it with the code alone, even with no other device left. A device approved
  through a history share receives the key with it.
- Edit and delete your own encrypted messages from the message's long-press sheet, in rooms
  and threads. The change is encrypted like a message: other members see the new text with an
  "edited" mark, or the message disappears. Until the server accepts it, the message shows the
  change as pending, with retry and cancel.
- React to encrypted messages from the long-press sheet or the reaction chips, in rooms and
  threads; the server never learns the emoji. Search in an encrypted room runs on the device
  over its private history, recovered history included, and finds edited messages by their
  new text; nothing is sent to the server.
- Send and open files in encrypted rooms: each file is encrypted on the phone before upload,
  its key travels only inside the encrypted message, and the server stores an object it cannot
  read. Images, audio and video show inline as in other rooms; files open, save and share.
- The key that seals this device's encrypted data is renewed every 30 days, and on request
  from the encryption settings, which show when it was last renewed. The old key is
  destroyed, so an old copy of the data can no longer be opened; expired publication keys
  are destroyed along the way.
- Hand control of the account to another of your devices while sharing history with it:
  "Share and hand over control" gives it the account's root key, so it can approve and
  withdraw devices too. The choice is explicit and cannot be taken back.

### Removed

- Jitsi video calls on a RocketVibe server: its rooms call through voice. Rocket.Chat
  calls are unchanged.

### Changed

- The encryption settings no longer warn that device enrollment is experimental:
  native end-to-end encryption is on by default on RocketVibe servers.

## [0.6.0] - 2026-10-06

### Changed

- Tapping a search result now opens the room at that message. A pinned, starred or searched
  message older than what the room has loaded shows the conversation around it, whatever its
  age, instead of "Message not found in recent history". Scrolling reads on in both
  directions; the button at the bottom, or sending a message, comes back to the latest
  messages.

- The app moves its local data, settings and notification links to new internal names on
  the first launch after the update. You stay signed in, with your messages, language,
  collapsed sections and unsent messages; notifications already on screen still open and
  still take replies.

### Fixed

- RocketVibe: confirming an encrypted group review (creation, update, admission) no longer
  fails now and then with "Operation unavailable" while the room is open.
- RocketVibe: an encrypted group update received after the room was read is no longer
  offered for a review that could only fail with "Operation unavailable": reading the room applies it.
- RocketVibe: an open encrypted room refreshes about four times faster: a refresh no longer
  re-checks the device over the network before each of its steps, nor re-reads the same
  directories and member devices several times.
- RocketVibe: an encrypted room stays on screen under its action sheets and while a photo or a
  file is being picked: it no longer empties and reloads for seconds, a picked attachment is
  no longer lost, and an edit, a quote or a reaction no longer fails because the room closed
  under it. The room still closes as soon as it is left.
- RocketVibe: attachments staged in an encrypted room are sent with their caption; the caption
  alone went out and the attachments stayed behind.
- RocketVibe: a quote of an encrypted message, and the "Replying to" banner, name its author
  instead of showing an id.
- Encrypted images keep their proportions; they were cropped into a square.
- The download progress bar of an image, a video or a file shows again.
- Deleting a message asks for confirmation first, as on desktop.
- Files, photos and voice messages can be sent in a thread, encrypted RocketVibe threads
  included; the thread shows their progress and a Retry on failure.
- RocketVibe: a voice message or an audio file in an encrypted room plays: its decrypted copy
  was deleted at each refresh of the room, before the player opened it.
- The send button dims while an encrypted message is being sent, and the composer says it is
  updating the encrypted messages instead of "This channel is read-only".
- RocketVibe: after a member's role or rights change in an encrypted room, the encrypted
  group offers to replace that member's device, the update the group needs before anyone
  can write again.
- RocketVibe: when a member of an encrypted group is not trusted yet, the room information
  says so and what to do (pin their identity and approve their device in their profile)
  instead of a generic "Operation unavailable". The group review names members instead of
  showing their account ids.
- RocketVibe: signed-in devices and the encryption settings load when the settings open
  right after launch; they used to say "Devices could not be managed" until refreshed.
- Avatar tiles take their colour from the person or room again; every tile had the same
  one.
- The room information and profile sheets scroll when their content is taller than the
  screen: the end of a long section, such as the confirmation of an encrypted group
  review, used to sit below the screen, out of reach.
- RocketVibe: an encryption action no longer fails because the open room is reading its
  messages at the same moment; it waits for that read to finish.
- In a RocketVibe private room not yet encrypted, the room info offers the encrypted group
  as on desktop: a member prepares this device for invitations, and the owner creates the
  group. A phone used to be able to join only a group created without it.
- RocketVibe: an obsolete edit keeps the words you typed and reports a conflict, even if the
  cache already received the new version of the message.
- RocketVibe: the cache detects a removal followed by a rejoin even after a missed event and a
  new snapshot, and purges the earlier private history, drafts and intents. A role change keeps
  the current membership's intents, and the first membership witness also purges the intents of
  older caches that had none.
- RocketVibe: open composers and forms start empty on a new membership. Late saves and sends
  from the old composer can no longer overwrite a new draft or requeue the old text, and a role
  change keeps the current draft. A late read callback cannot cross a removal followed by a
  rejoin.

## [0.5.0] - 2026-10-03

### Added

- Slash commands: a `/` at the start of a message suggests the server commands you can run
  in the room, with their parameters and what they do; sending runs it, in the thread when
  you are in one. The server's reply (a room not found, `/help`) shows above the input,
  visible to you alone. A rejected command comes back into the input.

### Fixed

- A long press on a link or a mention opens the message actions, as anywhere else in the
  message; it used to open nothing.

## [0.4.0] - 2026-09-30

### Added

- A Favorites section in the room list, after Unread, for the rooms marked as favorite on
  the server (as in the official client); a room's info screen adds it there or removes it.

### Fixed

- The last-message preview in the room list showed markdown syntax (code delimiters,
  asterisks, link brackets): it now reads as plain text.

## [0.3.1] - 2026-09-29

### Fixed

- Attachments prepared in a room but not yet sent were lost when switching rooms: they now
  wait until you come back.

## [0.3.0] - 2026-09-29

### Added

- Encrypted room: once unlocked, you write in it as anywhere else. The message goes out
  encrypted (mentions still notify); while locked, it waits for the unlock instead of failing.
  You can also edit your messages and reply in a thread there.
- Encrypted room: photos, sounds and videos sent encrypted are displayed (decrypted on the
  device, up to 25 MB), and any encrypted file can be shared or saved in the clear.
  You can also attach files there: they go out encrypted, name and caption included.

### Fixed

- An encrypted room created by an old web client (AES-128 room key) is readable again once
  unlocked, instead of showing only "chiffrés, non pris en charge" ("encrypted, not
  supported") messages.

## [0.2.0] - 2026-09-29

### Added

- Room list: tapping a section title (Unread, Channels, Direct messages) collapses or
  expands it; collapsed, it shows its number of conversations, and the state is kept from
  one launch to the next.
- Room: once scrolled more than a screen up the history, a round button at the bottom right
  brings you back to the latest messages in one gesture.
- Messages: pin and unpin, add to and remove from favorites, from a message's actions. A 📌
  button in the room header opens its pinned messages and your favorites; tapping one scrolls
  the conversation back to it and highlights it, loading older history if needed.
- Composer: attachments wait to be sent as chips (thumbnail or icon, name, format and size,
  ✕ to remove); you can attach several at once, preview them with a tap, and the typed text
  goes out as the first one's caption.

### Changed

- A file the server rejects (size, type) is rejected as soon as it is attached, no longer at
  send time.

### Fixed

- A message's actions follow your actual rights on the server: no more "Épingler" ("Pin")
  without the permission, and a moderator can edit or delete other people's messages.
- A sent file keeps its original name; a copy made by the picker went out under a random
  cache name.
- Sharing to the app while it was not running does open the share screen, on the first try;
  and a share is no longer replayed on every later opening of the app.

## [0.1.0] - 2026-09-27

First published version: Android, for Rocket.Chat 8 or later.

### Added

- Password login with two-factor authentication (TOTP, email, password), session kept in
  secure storage.
- Offline first: one SQLite database per server and per account, which the UI observes;
  REST to act, DDP to listen, automatic reconnection and catch-up.
- Room list by activity, in sections (unread, channels, direct messages), with presence,
  previews, unread badges, and search for people and rooms.
- Message list: native markdown, emojis (custom ones included), mentions, quotes, threads,
  reactions, pinning, editing and deletion, per-room drafts.
- Two-step file upload (photos, downscaled videos, documents, voice messages), with
  progress, resume and cancel.
- Built-in audio and video playback, link previews, and YouTube / Dailymotion / Vimeo cards.
- Typing indicator, "new messages" bar, search within a room.
- FCM push notifications with hidden content, fetched on receipt; reply from the
  notification; room opened by a `rocketvibe://` link.
- Reading end-to-end encrypted rooms after unlocking.
- Jitsi video calls.
- Sharing from other apps to a room.
- Profiles, room info, my profile (status, photo, information).
- Interface in French and English.

[Unreleased]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.24.0...HEAD
[0.24.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.23.0...mobile-v0.24.0
[0.23.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.22.0...mobile-v0.23.0
[0.22.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.21.0...mobile-v0.22.0
[0.21.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.20.0...mobile-v0.21.0
[0.20.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.19.0...mobile-v0.20.0
[0.19.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.18.1...mobile-v0.19.0
[0.18.1]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.18.0...mobile-v0.18.1
[0.18.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.17.0...mobile-v0.18.0
[0.17.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.16.0...mobile-v0.17.0
[0.16.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.15.0...mobile-v0.16.0
[0.15.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.14.0...mobile-v0.15.0
[0.14.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.13.0...mobile-v0.14.0
[0.13.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.12.0...mobile-v0.13.0
[0.12.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.11.0...mobile-v0.12.0
[0.11.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.10.0...mobile-v0.11.0
[0.10.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.9.1...mobile-v0.10.0
[0.9.1]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.9.0...mobile-v0.9.1
[0.9.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.8.0...mobile-v0.9.0
[0.8.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.7.0...mobile-v0.8.0
[0.7.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.6.0...mobile-v0.7.0
[0.6.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.5.0...mobile-v0.6.0
[0.5.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.4.0...mobile-v0.5.0
[0.4.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.3.1...mobile-v0.4.0
[0.3.1]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.3.0...mobile-v0.3.1
[0.3.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.2.0...mobile-v0.3.0
[0.2.0]: https://github.com/Guillaume69/rocket-vibe/compare/mobile-v0.1.0...mobile-v0.2.0
[0.1.0]: https://github.com/Guillaume69/rocket-vibe/releases/tag/mobile-v0.1.0
