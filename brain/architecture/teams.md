# Teams provider

Microsoft Teams is an experimental server kind behind the nine-activation login unlock
on Android, GTK and SwiftUI, beside Slack: a saved account signed in with a Microsoft
device code, its chats and channels in the local store, history, live updates over
Trouter, and text, edit, delete, react and mark read written back. It replaced the
transient browser-import read preview, gone from every app with its developer helper.
The protocol and its probes are in [MICROSOFT_TEAMS.md](../../docs/protocol/MICROSOFT_TEAMS.md).

## Sign-in

Device code against `login.microsoftonline.com/organizations/oauth2/v2.0`, with the
public client id of Microsoft's own Teams desktop and mobile apps (`1fec8e78-…`, probed
live; the web client `5e3ce6c0-…` is refused as confidential, AADSTS7000218). The app
asks `/devicecode`, shows the user code and Microsoft's page, then polls `/token` at the
interval Microsoft gives until approval, refusal (`declined`), expiry (`expired`) or
Cancel. The person signs in on Microsoft's page, MFA and conditional access included;
the app never sees a password. Only work or school accounts (`organizations`).

The account keeps the tenant id and the refresh token, nothing else: Android in the
session's SecureStore record (`teamsTenantId`, `teamsRefresh`), the desktop in its
account vault (`TeamsAccount`, `from_secret` / `write_secret`). Microsoft rotates the
refresh token on each use (about ninety days, sliding); each app writes the new one back
through a credential sink (`setTeamsCredentialSink`, `set_credential_sink`) the moment it
arrives, so a restart never reuses a spent token. Access tokens live in memory only,
one per audience: the aggregator, Spaces, and the chat service's Skype token from
`authsvc/v1.0/authz`. Authz also hands out the routes (chat service, aggregator,
Trouter, registrar, AMS, middle tier), each checked against Microsoft host suffixes
before use. Sign-out is local: the refresh token is dropped, no revocation is called.

## Rooms, history, reads

The aggregator's `api/v2/teams/users/me` lists every chat (one-to-one, group, meeting)
and every team with its channels in one call: names, members, last message and my read
state. A chat with no topic is named from its members, after its last message has taught
the directory the sender's name. Teams gives no unread count: an unread room counts one,
from `isRead` and whether the last message is mine.

History comes from the chat service, `users/ME/conversations/<id>/messages`, newest
page first (50), with a `backwardLink` to the older page. Paging is backward only:
there is no window of the past, so `historyRange` (quote context) is refused. A
backward link is followed only on the chat service's own host and path. A catch-up
reads from the newest known id (`startTime`); a full page means a gap, and the room's
stored messages are replaced by the newest page.

Messages are `RichText/Html` or `Text`; the HTML becomes markdown (bold, italic,
strike, code, links, lists, mentions as `@Name`, Teams emoji as their glyph), scripts,
styles and remote images dropped. Ids are `<conversation>/<server id>`. Reactions are
`properties.emotions`, keyed by Teams' classic names (`like`, `heart`, `laugh`,
`surprised`, `sad`, `angry`): the apps offer only those. Reading moves my
`consumptionhorizon` to the newest message, never back.

## Live

Trouter v4: allocate (`/v4/a`), socket.io 0.9 handshake (with `cor_id` and `con_num`,
else 400), WebSocket, `user.authenticate` with the Skype token, then a registrar POST
for the endpoint. Pushed requests (`3:` frames) are acknowledged and carry
`NewMessage`, `MessageUpdate` (edits by `edittime`, reactions by `emotions`, deletions
by `deletetime`) and `ConversationUpdate`. Every conversation arrives on the one socket;
nothing is subscribed per room. A new message also rewrites its room's last message and
unread state. `trouter.message_loss` or a dropped socket reconnects, then catches up.

## Writes

A message goes out as HTML (`POST …/messages`) with a client id derived from the
outbox row (digits, stable across retries). Teams mints the message id, so delivery is
proved by finding my message carrying that client id in the conversation; a lost answer
or a replay looks for it before sending again, and a window full of other messages
marks the row uncertain rather than sending twice. Edit is a `PUT` of the message,
delete a `DELETE`, a reaction a `PUT` / `DELETE` of `properties?name=emotions`.

## Not yet

Files (AMS), channel threads, pins, saves, search, profiles and presence, room info and
members, typing, calls and push are refused by the provider: Android hides them through
its capabilities; GTK and SwiftUI can still offer some of them and get a "not
supported" error (see [parity](../parity.md#19-experimental-integrations)). Nothing has
run against more than one tenant; installed Android and macOS runs are outstanding.

## Mobile

providers/teams/: `auth.ts` (device code, approval, routes, tokens, resume),
`client.ts` (the two credentials, one renewal on 401), `translate.ts`, `sync.ts`
(`TeamsSync`, `TeamsTranslator`, `TeamsRooms`), `trouter.ts` (`TeamsTrouter`, the
Listener), `outbox.ts` (`TeamsOutbox`, `TeamsMessageActions`), `index.ts`
(`createTeamsProvider`, `TEAMS_CAPABILITIES`). app/login.tsx offers the kind behind
the unlock: a button asks the code, which shows with a button opening Microsoft's page
and Cancel; approval connects the account like any other. lib/sessionTransport.ts
resumes it; ui/session.tsx registers the credential sink.

## Desktop

rv-core/src/teams/: `auth.rs`, `client.rs`, `translate.rs`, `sync.rs`, `actions.rs`,
`frames.rs`, `live.rs` (the Trouter actor behind the shared `LiveEvent` feed), wired as
`Backend::Teams` in session.rs and `ServerKind::Teams`. GTK login.rs shows the code and
Microsoft's link (`show_teams_code`) and waits with Cancel (window.rs
`start_teams_login`); rv-ffi teams.rs exposes `TeamsSignIn` to SwiftUI's LoginModel and
LoginView. Rocket.Chat's own GIFs, stickers, encryption settings, server icon and X
cards are left out of Teams accounts (`info.teams`, `is_teams`).

## Sources

- apps/mobile/providers/teams/auth.ts
- apps/mobile/providers/teams/client.ts
- apps/mobile/providers/teams/translate.ts
- apps/mobile/providers/teams/sync.ts
- apps/mobile/providers/teams/trouter.ts
- apps/mobile/providers/teams/outbox.ts
- apps/mobile/providers/teams/index.ts
- apps/mobile/providers/teams/provider.test.ts
- apps/mobile/app/login.tsx
- apps/mobile/lib/sessionTransport.ts
- apps/desktop/crates/rv-core/src/teams/
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-gtk/src/login.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-ffi/src/teams.rs
- apps/desktop/macos/Sources/RocketVibeKit/LoginModel.swift
- apps/desktop/macos/Sources/RocketVibe/LoginView.swift
- docs/protocol/MICROSOFT_TEAMS.md
