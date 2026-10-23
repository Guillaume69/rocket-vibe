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
and send, edit, delete, react, mark read, the typing indicator, channel thread replies (a `Control/Typing`
chat-service message, the one feature past the core that reuses the already-probed
`/messages` endpoint), pinning/unpinning a channel post (write through the CSA aggregator,
the pinned state read back from the message's `properties.pinned`) and sending a file to a channel
(uploaded to its SharePoint folder through Graph, then a chat-service message carrying it as
`properties.files`, see the table below). Android
hides every refused action through `TEAMS_CAPABILITIES`; GTK and SwiftUI hide the refused message
actions and the panels (`Session::provider_actions` offers pins but not saves, `marked_available`
stays off so the pinned/saved panel is hidden) and starting a direct conversation (`search_available`,
`direct_messages_available`).

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
| Profiles (name, email, bot) | middleTier (discovered) | `POST beta/users/fetchShortProfile`, body = array of MRIs, Spaces bearer; response `{value:[{displayName, userPrincipalName, email, mri, type, userType}]}` (`profiles`/`profile` in `teams/sync.rs`, `profileFields` in `providers/teams`) | WORKING, verified live 2026-10-22 (probe run 4): the Spaces bearer answers 200; the earlier 204s were the probe sending the aggregator bearer, not the client. No job title in the short profile, so the card shows name, email and the bot flag. Avatars still owed (authenticated image load) |
| Room information (read) | chat service (have) | `GET users/ME/conversations/<id>` → `threadProperties.topic` (`room_info` in `teams/sync.rs`, `roomInfo` in `providers/teams`); the member count comes from the roster (`GET /v1/threads/<rid>`), since the conversation document carries none | Topic verified live (probe 2026-10-22: GET conversations/<id> answered 200 with a real `threadProperties.topic`). The panel shows name, kind, topic and member count (room_info fetches the roster and counts it, both apps). Neither the conversation document nor the threads document carries a description: the threads `properties` has `topic` but no `description` (probe run 9, 2026-10-22), so a room description is not a chat-service field at all here (it lives in Graph team metadata, the same new-audience class as files), and the panel shows name, kind, topic and member count. Editing a room is owed, reachable through the internal chat service (the web app's path), not Graph: the Graph path (`PATCH /chats/{id}` or `/teams/{id}/channels/{id}`, needing `Chat.ReadWrite` / `ChannelSettings.ReadWrite.All`) is a dead end for this client (probe run 11 lacks the scopes; a re-auth requesting them is refused AADSTS65002). But the web app edits a topic through the chat service with the skype token, and the chat service's `properties` endpoint is a write target (GET 405). The exact topic-write method/body is to be captured from the web app, then wired like edit/delete/react |
| Members roster (read) | chat service (have) | `GET /v1/threads/<rid>` → `members[].{id: <mri>, role}` (`members`/`roster_page` in `teams/sync.rs`, `listMembers`/`rosterPage` in `providers/teams`), verified live 2026-10-22 (probe run 6). The `conversations/<id>/members` sub-resource 404s; the roster lives on the threads service | Implemented read-only on all apps: the member list shows each person and their role, no add/remove/role-change (Teams gives no such route here, so no rights travel with it) |
| Room favorites (toggle) | aggregator (have) | `POST/DELETE teams/users/me/pinnedChannels`, body NOT captured | Read side works (`isFavorite` on the aggregator entry); the write body is unknown |
| Files (attachments) | Microsoft Graph (`Files.ReadWrite.All`/`Sites.ReadWrite.All`), minted from the same refresh token | A shared file's SharePoint/OneDrive url is downloaded through `GET /shares/u!{base64url(url)}/driveItem/content`, which answers **302** to a pre-signed url (follow it for the bytes); upload is `PUT /me/drive/root:/{name}:/content`. Verified live end to end 2026-10-22 (probe run 12, with the user's authorization for Graph + live writes): a probe file uploaded (201), downloaded directly and through `/shares` (both 302), then deleted (204). The chat-service skype token does NOT reach this (AMS call-recording href 403s it, probe run 6); the Graph token does | **Download and upload IMPLEMENTED on all three (upload channel-only).** The chat-service message's `properties.files[]` (a JSON string) carries each file as `{title, fileInfo.fileUrl}`; `file_attachments` in `teams/translate.rs` keeps only SharePoint/OneDrive files (`is_graph_share`) as the renderer's RC attachment `{title, title_link, type:"file", size}`, so a file message now shows a card. On tap, `Session::download_with_progress` routes a Teams SharePoint url through `TeamsSync::download_file` (Graph `/shares/u!{base64url}/driveItem/content` with the Graph bearer, following the 302 without auth, streaming to disk) instead of the shared `download_protected`. rv-core, so GTK and SwiftUI both get it with no view change. Mobile wires the same: `toMessage` parses `properties.files` (`fileAttachments`/`isGraphShare` in `providers/teams/translate.ts`), and a tap resolves the SharePoint url to its pre-signed Graph download url before the transfer. Because the mediaAuth flow is a per-origin bearer that the Graph `/shares` resolve step does not fit, the resolve goes through a standalone registry (`lib/downloadResolver.ts`, like `lib/mediaAuth.ts`): the Teams provider registers a resolver keyed by the account base url (`client.downloadUrl` reads `@microsoft.graph.downloadUrl` from `GET /shares/u!{base64url}/driveItem`, which needs no auth), and `FileAttachment` passes it as the transfer's `resolve`. Logic-tested; the installed Android run is outstanding (needs a dev-client rebuild and a real file). **Upload (channel):** the clean path does NOT go through Graph `ChannelMessage.Send` (which would mix send paths and break the outbox echo) nor a chat (which needs `Chat.ReadWrite`, AADSTS65002): instead the bytes go to the channel's SharePoint **files folder** via the Graph **drive** (parent team from `me/joinedTeams`, folder from `teams/<g>/channels/<id>/filesFolder`, then `PUT /drives/<drive>/items/<folder>:/<name>:/content`), the item re-read for its `sharepointIds`, and a chat-service `/messages` POST carries it as `properties.files` (the same shape read back) with a stable `clientmessageid` for dedup. Verified live end to end 2026-10-23 (`TEAMS_PROBE_UPLOAD`: joinedTeams 200 → filesFolder 200 → upload 201 → sendMessage 201 → the message reads back with `properties.files` → self-cleaned). Desktop: `TeamsSync::{channel_drive,parent_team,upload_file,file_ref}` + `send_file`, driven by `Uploads::post_teams`; GTK and SwiftUI get it through rv-core with no view change (the legacy composer already enables attach). Mobile: `TeamsUploadQueue` (`providers/teams/uploads.ts`) over the shared upload table, with a **binary-PUT transport** (`transportBinaryExpo`, expo `BINARY_CONTENT` + PUT) chosen for Teams in `ui/sync.tsx`, since the shared multipart-POST transport does not fit Graph `/content`; the client holds the Graph discovery (`channelDrive`/`parentTeam`/`fileRef`). No inline image preview yet (the web app also posts an asyncgw object + `amsreferences`, skipped here, so the file shows as a card not an inline thumbnail), and a chat (no parent team) cannot receive a file this way. SharePoint-REST (addStub/StartUpload/FinishUpload) + new SharePoint/ic3 token audiences, the web app's own path, are avoided; the Graph path reuses the token already minted for download |
| Message pins (channel) | CSA aggregator (have, aggregator bearer) | `POST`/`DELETE {aggregator}/api/v1/teams/<team>/channels/<channel>/posts/<post>/pin` → 201 / 204 (the aggregator bearer, NOT the skype token, NOT Graph). The pinned state is a per-message property: the chat-service message doc carries `properties.pinned` (a JSON string `{creatorId, pinnedTime}`) under the `supportsMessageProperties` view the client already uses, so the pin reflects on ingest with no extra read. The dedicated list routes (`pinnedmessages`, `posts/pinned`) answer 400, so a pinned-messages *panel* list endpoint is not confirmed. Captured + verified live 2026-10-23 by a self-cleaning pin round-trip (probe `TEAMS_PROBE_PIN`): pin 201, read-back shows `properties.pinned`, unpin 204. The GRAPH path stays a dead end (`/chats/{id}/pinnedMessages` needs `Chat.ReadWrite`, refused AADSTS65002). | IMPLEMENTED on all three (channel only; a chat has no parent team here). Desktop: `TeamsSync::set_pinned` + `team_of` + `aggregator_call` (`teams/sync.rs`, `teams/actions.rs`), routed in `Session::pin`/`unpin`, `provider_actions.pins = true`; the flag from `properties.pinned` in `teams/translate.rs`. Mobile: `TeamsClient.setPinned` + `TeamsMessageActions.setPinned`, the provider's `pin`/`unpin` resolving the team from `rooms.entries`, `TEAMS_CAPABILITIES.pins = true` decoupled from the `marks` panel (a new optional `pins?` capability falling back to `marks` in `offered()`). The pinned-messages *panel* (list) and personal saves are owed (no confirmed list endpoint; Teams has no personal save on this surface). |
| Direct message creation | chat service (have) | how a new 1:1 is addressed, not captured | Unknown create/address call |
| Presence | unifiedPresence (discovered) | `POST v1/presence/getpresence/` body `[{mri}]`, `PUT v1/me/forceavailability/`, both with an AAD bearer for the `https://presence.teams.microsoft.com` scope | WORKING, verified live 2026-10-22: getpresence answers `[{mri, etag, status, presence:{availability, activity, deviceType, lastActiveTime}}]`; the client reads `presence.availability`. The skypetoken is refused (401); the presence bearer is a separate cached token |
| Search | Substrate (`substrate.office.com`), AAD bearer for that scope | `POST /search/api/v2/query`, body `{Cvid, Scenario:{Name:"teamsmessages"}, EntityRequests:[{EntityType:"Message", ContentSources:["Teams"], Query:{QueryString}, Size}]}` answers 200 (probe run 5, 2026-10-22). Hits at `EntitySets[0].ResultSets[0].Results[].Source`: `ClientThreadId`/`ClientConversationId` (the `19:` conversation id), `From.EmailAddress.Name`, `Preview`, `DateTimeSent`, `HitHighlightedSummary`. The asyncgw `/msgsearch/v2/search` path is a dead 404. | IMPLEMENTED as a partial (`search` in `teams/sync.rs`/`search_hits`, `searchMessages`/`searchHits` in `providers/teams`): a per-room search queries Substrate globally and keeps the hits whose `ClientConversationId`/`ClientThreadId` is the room. The hit carries an Exchange item id, not the chat-service message id, and `From` only a display name, so the result shows text/author/time and opens the room but cannot jump to the exact message; the id is synthetic and the author MRI is resolved from the directory when known. |
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
