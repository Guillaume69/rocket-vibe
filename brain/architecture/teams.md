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

## Done so far

Chats and channels, unread state, history, live messages/edits/reactions/deletions,
and send, edit, delete, react, mark read, the typing indicator and channel thread replies (a `Control/Typing`
chat-service message, the one feature past the core that reuses the already-probed
`/messages` endpoint). Android hides every refused action through `TEAMS_CAPABILITIES`;
GTK and SwiftUI hide the refused message actions, search, the pinned/saved panels and
starting a direct conversation (`Session::provider_actions`, `search_available`,
`marked_available`, `direct_messages_available`).

## Remaining parity, and what each needs

Three features reach the apps from the already-probed hosts (chat service for
typing and thread replies/reads; aggregator for rooms). Every feature below is gated
on one of two things the current inputs do not give, stated per feature so the work is
scoped for a later live pass. "Host" is whether the service address is known (the authz
`regionGtms` map in the capture holds only `chatServiceAfd`, `chatSvcAggAfd`,
`teamsPushServiceAfd`; `middleTier` is discovered too). "Shape" is whether the request
body / response is captured. Verification for every one is a live probe on a self-owned
test tenant.

| Feature | Host | Request/response shape | Blocker |
|---|---|---|---|
| Profiles (name, title, bot) | middleTier (discovered) | `POST beta/users/fetchShortProfile`, body = array of MRIs; response `value[]` with `mri/displayName/userPrincipalName/jobTitle` (`profiles`/`profile` in `teams/sync.rs`, `profileFields` in `providers/teams`) | Wired but FAILING live (probe 2026-10-22): `fetchShortProfile` with the Spaces bearer answered 204 with no body (accepted, no match), likely the `me` id form (needs the `8:orgid:<aad oid>` MRI) or the token audience. Degrades to the name already learned from messages until fixed. Avatars still owed (authenticated image load) |
| Room information (read) | chat service (have) | `GET users/ME/conversations/<id>` → `threadProperties.topic/description/membercount` (`room_info` in `teams/sync.rs`, `roomDetailsOf` in `providers/teams`); not re-probed live | Implemented best effort, the bare-conversation GET shape not probed live: a differing or refused response omits topic/members and the panel still shows the name and kind from the room list (the same skypetoken chat-service path history uses). The members LIST and editing a room are still owed |
| Room favorites (toggle) | aggregator (have) | `POST/DELETE teams/users/me/pinnedChannels`, body NOT captured | Read side works (`isFavorite` on the aggregator entry); the write body is unknown |
| Message pins / saves | none for a message pin (only channel pinning) | not captured | No chat-service message-pin endpoint in the capture |
| Direct message creation | chat service (have) | how a new 1:1 is addressed, not captured | Unknown create/address call |
| Presence | unifiedPresence (discovered) | `POST v1/presence/getpresence/` (MRIs), `PUT v1/me/forceavailability/` | Wired but FAILING live (probe 2026-10-22): getpresence with a skypetoken answered 401. The host wants an AAD bearer for the `presence.teams.microsoft.com` audience, not the skypetoken. Degrades to no dots until fixed |
| Search | search host (discovered: `*.asyncgw.teams.microsoft.com`) | not working: `POST msgsearch/v2/search` answered 404 (probe 2026-10-22). Wrong path/host, or msgsearch is a Substrate proxy with its own path and token | Needs the real path and token before any client work |
| Files | SharePoint/OneDrive (`/_api/v2.x/drives/{}/items/{}`) | drive item metadata on the message; upload session | Needs OneDrive auth beyond the chat token |
| Calls | calling service (`calling_trouterUrl`) | large separate surface | Unverified, large |
| Push | `teamsPushServiceAfd` (have) | FCM registration + registrar channel | Large native surface (killed-app delivery) |
| Quote context | chat service (have) | n/a | Real Teams limit: history pages backward only, no permalink quote |

Nothing has run against more than one tenant; installed Android and macOS runs are
outstanding. See [parity](../parity.md#19-experimental-integrations).

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
