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

The aggregator's `api/v2/teams/users/me` lists every team with its channels and chats
(one-to-one, group, meeting) in one call: names, members, last message and my read
state. It leaves many chats out (seen on a live tenant: one group chat listed where
Teams showed dozens of one-to-one and meeting chats), so the chat service's own
`users/ME/conversations?view=...&pageSize=100&startTime=1` is also read, walked back
through `_metadata.backwardLink` on the chat host (at most 10 pages), and every chat it
lists that the snapshot lacks joins the list in the aggregator's shape (`listed_chat` /
`listedChat`: topic, kind, last message, `properties.consumptionhorizon`'s first field
as the horizon, and a one-to-one chat's two members read from its
`19:<a>_<b>@unq.gbl.spaces` id); channels (`@thread.tacv2`, `space`/`topic` threads),
`48:` system conversations and chats with no message are skipped, and unknown
one-to-one peers are named from their short profiles (`listing` in `teams/sync.rs`,
`entries` in `providers/teams`). That route's list shape was read only for ids
(the shapes probe); the other fields are the chat service's message and property names,
not yet seen in that list. A chat Teams marks `hidden` is listed again once its last
message is one the list previews. A reconcile keeps the rooms the last catch-up filed,
so a chat the snapshot has not caught up with yet is not purged. A chat with no topic is named from its members, after its last message has taught
the directory the sender's name. A channel is named "Team · Channel" (its own name stays
the room's `name`, which room information and the rename field show), the list dropping
the team under that team's own header. A channel's `isFavorite` is Teams' older "shown in
the team list" (every team's General carries it), not a favorite: a channel is a
favorite only when `isPinned`, a chat when `isFavorite` (the channel flag's name is
inferred, not yet seen on a pinned channel). Teams gives no unread count: an unread room counts one,
from `isRead` (`isMessageRead`) when the entry carries it, else from a last message newer
than my `consumptionHorizon`, and never when the last message is mine. A last message that
is a `ThreadActivity/*` or `Control/*` event does not count (the store keeps none of them,
so nothing could be read past it), and a channel with no horizon at all (never opened, or
hidden in Teams) is read, as Teams shows it; a chat with no horizon stays unread
(`subscription` in `crates/rv-teams/src/translate.rs`, `toSubscription` in
`packages/provider-teams/src/translate.ts`).

History comes from the chat service, `users/ME/conversations/<id>/messages`, newest
page first (50), with a `backwardLink` to the older page. Paging is backward only:
there is no window of the past, so `historyRange` (quote context) is refused. A
backward link is followed only on the chat service's own host and path. A catch-up
reads from the newest known id (`startTime`); a full page means a gap, and the room's
stored messages are replaced by the newest page.

Messages are `RichText/Html` or `Text`; the HTML becomes markdown (bold, italic,
strike, code, links, lists, mentions as `@Name`, Teams emoji as their glyph), scripts,
styles and remote images dropped. A channel post's subject (`properties.subject`, or
`subject` on a list entry) is its title: the text starts with it in bold, and an edit
sends the body without it, the subject staying the message's own property (`body_text`,
`without_subject` in `rv-teams`; `bodyText`, `withoutSubject` in `provider-teams`; the
field's place inferred from the chat service's message properties, not yet seen on a
live post). A reply carries `;messageid=<post>` in its `conversationLink`; Teams sends
no reply count, so each post's count and last reply time are counted from the replies
read with it and moved by every live reply or deletion (`Store::recount_threads` after
each Teams write on the desktops, `TeamsThreads` and the `thread` live event turned into
`thread-counters` on Android), which shows "N replies" under the post and opens its
thread. Ids are `<conversation>/<server id>`. Reactions are
`properties.emotions`, keyed by Teams' classic names (`like`, `heart`, `laugh`,
`surprised`, `sad`, `angry`): the apps offer only those. Reading moves my
`consumptionhorizon` to the newest message, never back: the newer of the newest stored
(or live) message and the aggregator entry's `lastMessage.id`, so an event the store never
keeps is still read past; the room's row turns read at once (`unmarked_newest` and
`note_marked` in `teams/sync.rs`, `markRead` in `providers/teams`).

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
`properties.files`) and calls handed to Teams itself (call cards from `Event/Call`, Join opening the
call's or the conversation's deep link, see the table below). Android
hides every refused action through `TEAMS_CAPABILITIES`; GTK and SwiftUI hide the refused message
actions (`Session::provider_actions` offers pins but not saves, so the marked panel shows its
pinned tab only) and starting a direct conversation (`direct_messages_available`).

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
| Room favorites (toggle) | aggregator (have) | `POST/DELETE teams/users/me/pinnedChannels`, body NOT captured | Read side: a chat's `isFavorite`, a channel's `isPinned` (a channel's `isFavorite` means "shown in the team list"); the write body is unknown |
| Files (attachments) | Microsoft Graph (`Files.ReadWrite.All`/`Sites.ReadWrite.All`), minted from the same refresh token | A shared file's SharePoint/OneDrive url is downloaded through `GET /shares/u!{base64url(url)}/driveItem/content`, which answers **302** to a pre-signed url (follow it for the bytes); upload is `PUT /me/drive/root:/{name}:/content`. Verified live end to end 2026-10-22 (probe run 12, with the user's authorization for Graph + live writes): a probe file uploaded (201), downloaded directly and through `/shares` (both 302), then deleted (204). The chat-service skype token does NOT reach this (AMS call-recording href 403s it, probe run 6); the Graph token does | **Download and upload IMPLEMENTED on all three (upload channel-only).** The chat-service message's `properties.files[]` (a JSON string) carries each file as `{title, fileInfo.fileUrl}`; `file_attachments` in `teams/translate.rs` keeps only SharePoint/OneDrive files (`is_graph_share`) as the renderer's RC attachment `{title, title_link, type:"file", size}`, so a file message now shows a card. On tap, `Session::download_with_progress` routes a Teams SharePoint url through `TeamsSync::download_file` (Graph `/shares/u!{base64url}/driveItem/content` with the Graph bearer, following the 302 without auth, streaming to disk) instead of the shared `download_protected`. rv-core, so GTK and SwiftUI both get it with no view change. Mobile wires the same: `toMessage` parses `properties.files` (`fileAttachments`/`isGraphShare` in `packages/provider-teams/src/translate.ts`), and a tap resolves the SharePoint url to its pre-signed Graph download url before the transfer. Because the mediaAuth flow is a per-origin bearer that the Graph `/shares` resolve step does not fit, the resolve goes through a standalone registry (`packages/provider-api/src/downloadResolver.ts`, like `packages/provider-api/src/mediaAuth.ts`): the Teams provider registers a resolver keyed by the account base url (`client.downloadUrl` reads `@microsoft.graph.downloadUrl` from `GET /shares/u!{base64url}/driveItem`, which needs no auth), and `FileAttachment` passes it as the transfer's `resolve`. Logic-tested; the installed Android run is outstanding (needs a dev-client rebuild and a real file). **Upload (channel):** the clean path does NOT go through Graph `ChannelMessage.Send` (which would mix send paths and break the outbox echo) nor a chat (which needs `Chat.ReadWrite`, AADSTS65002): instead the bytes go to the channel's SharePoint **files folder** via the Graph **drive** (parent team from `me/joinedTeams`, folder from `teams/<g>/channels/<id>/filesFolder`, then `PUT /drives/<drive>/items/<folder>:/<name>:/content`), the item re-read for its `sharepointIds`, and a chat-service `/messages` POST carries it as `properties.files` (the same shape read back) with a stable `clientmessageid` for dedup. Verified live end to end 2026-10-23 (`TEAMS_PROBE_UPLOAD`: joinedTeams 200 → filesFolder 200 → upload 201 → sendMessage 201 → the message reads back with `properties.files` → self-cleaned). Desktop: `TeamsSync::{channel_drive,parent_team,upload_file,file_ref}` + `send_file`, driven by `Uploads::post_teams`; GTK and SwiftUI get it through rv-core with no view change (the legacy composer already enables attach). Mobile: `TeamsUploadQueue` (`packages/provider-teams/src/uploads.ts`) over the shared upload table, with a **binary-PUT transport** (`transportBinaryExpo`, expo `BINARY_CONTENT` + PUT) chosen for Teams in `ui/sync.tsx`, since the shared multipart-POST transport does not fit Graph `/content`; the client holds the Graph discovery (`channelDrive`/`parentTeam`/`fileRef`). No inline image preview yet (the web app also posts an asyncgw object + `amsreferences`, skipped here, so the file shows as a card not an inline thumbnail), and a chat's file goes to my OneDrive's `Microsoft Teams Chat Files` folder (made when missing), then is shared with the chat's other members by AAD object id from the thread roster (`driveItem/invite`, `sendInvitation: false`, read; verified live 2026-10-24 on a channel's members: 200, 2 grants read back), through `TeamsSync::chat_files_folder` / `share_with_chat` (mobile `TeamsClient.chatFilesFolder` / `shareWithChat`, `isChat` from the room list); a channel's thread roster lists only me, Graph `teams/<g>/channels/<c>/members` lists its members. SharePoint-REST (addStub/StartUpload/FinishUpload) + new SharePoint/ic3 token audiences, the web app's own path, are avoided; the Graph path reuses the token already minted for download |
| Images (object store) | asyncgw (`routes.ams`, e.g. `fr-prod.asyncgw.teams.microsoft.com`) | A pasted image is `<img src="https://<region>.asyncgw.teams.microsoft.com/v1/objects/<id>/views/imgo">` in the message HTML; a file's preview is `properties.files[].filePreview.{previewUrl,previewWidth,previewHeight}` with the object in `amsreferences`. Reading `views/imgo` takes `authorization: skype_token <skype>` (or the `ic3.teams.office.com` bearer): 200 `image/jpeg`, 401 without (probed live 2026-10-24). Creating an object (`POST /v1/objects/ {type:"pish/image", permissions:{<conversation>:["read"]}, sharingMode:"Attached", filename}` then `PUT .../content/imgpsh`) takes the ic3 bearer but answers 400 "The platform id could not be created from the ... 'User-Agent' header" for any agent but Microsoft's own clients (an honest `RocketVibe/<version> (<os>)` included) | Reading IMPLEMENTED on all three: `is_teams_image` / `inline_images` / `file_attachments` (`teams/translate.rs`, mobile `isTeamsImage` / `fileAttachments` in `packages/provider-teams/src/translate.ts`) turn them into `image_url` attachments with `image_dimensions`; the desktop media cache routes them to `TeamsSync::fetch_image` (`MediaCache::for_teams`), mobile registers a media lease on the `ams` origin renewed with every skype token (`TeamsOptions.onSkype`). Writing is NOT done: a file the apps send has no preview image, because the store refuses any client that does not present itself as Microsoft's (decision 2026-10-24) |
| Message pins (channel) | CSA aggregator (have, aggregator bearer) | `POST`/`DELETE {aggregator}/api/v1/teams/<team>/channels/<channel>/posts/<post>/pin` → 201 / 204 (the aggregator bearer, NOT the skype token, NOT Graph). The pinned state is a per-message property: the chat-service message doc carries `properties.pinned` (a JSON string `{creatorId, pinnedTime}`) under the `supportsMessageProperties` view the client already uses, so the pin reflects on ingest with no extra read. The dedicated list routes (`pinnedmessages`, `posts/pinned`) answer 400, and Teams' web app makes no request when its pinned view opens (HAR of 2026-10-23): it filters the messages it holds on `properties.pinned`. Captured + verified live 2026-10-23 by a self-cleaning pin round-trip (probe `TEAMS_PROBE_PIN`): pin 201, read-back shows `properties.pinned`, unpin 204. The GRAPH path stays a dead end (`/chats/{id}/pinnedMessages` needs `Chat.ReadWrite`, refused AADSTS65002). | IMPLEMENTED on all three (channel only; a chat has no parent team here). Desktop: `TeamsSync::set_pinned` + `team_of` + `aggregator_call` (`teams/sync.rs`, `teams/actions.rs`), routed in `Session::pin`/`unpin`, `provider_actions.pins = true`; the flag from `properties.pinned` in `teams/translate.rs`. Mobile: `TeamsClient.setPinned` + `TeamsMessageActions.setPinned`, the provider's `pin`/`unpin` resolving the team from `rooms.entries`, `TEAMS_CAPABILITIES.marks = true` with `stars = false` (an optional capability falling back to `marks`, hiding the star actions and the starred tab). **Pinned panel**, like the web app: the room's newest 200 messages read with that view, the pinned ones listed newest first (`TeamsSync::pinned`, `Session::marked`; mobile `teamsPinned` in `packages/provider-teams/src/index.ts`); an older pin is not listed. The panel drops its starred tab when the provider has no stars (`marked.rs`, `MarkedView` through `RoomModel.supportsStars`, `app/marked-messages.tsx`). Personal saves are owed (Teams has no personal save on this surface). |
| Channel rename | Teams' templates service under the aggregator host's `/fabric/` route, a `https://templates.teams.microsoft.com` AAD bearer (minted from the same refresh token) | `PATCH {aggregator with /api/csa/ → /fabric/}/templates/api/teams/<groupId>/channels/OID:<substrateGroupId>@<tenant>?forceSync=false {"displayName"}` → 204; an unchanged name answers 400. `groupId` (the team's Graph group) and `substrateGroupId` sit on the aggregator channel entry. Every other token (skype, Spaces, aggregator, Graph, ...) answers 401 `NoAuthenticationToken`. Captured from the web app (the scope from its `/oauth2/v2.0/token` request in a HAR), verified live 2026-10-23 by a self-restoring rename (`TEAMS_PROBE_RENAME`: 204, Graph read the new name, restored 204) | IMPLEMENTED on all three, channels only (a chat has no team): `TeamsSync::rename` / `renamable` (`Tokens::templates`), `TeamsClient.rename` (`TokenSet.templates`) with the provider's `editableSettings` / `saveRoomSettings`; the entry's `displayName` is rewritten so the room list follows. Topic and description through this route are not probed |
| Direct message creation | chat service (have) | how a new 1:1 is addressed, not captured | Unknown create/address call |
| Presence | unifiedPresence (discovered) | `POST v1/presence/getpresence/` body `[{mri}]`, `PUT v1/me/forceavailability/`, both with an AAD bearer for the `https://presence.teams.microsoft.com` scope | WORKING, verified live 2026-10-22: getpresence answers `[{mri, etag, status, presence:{availability, activity, deviceType, lastActiveTime}}]`; the client reads `presence.availability`. The skypetoken is refused (401); the presence bearer is a separate cached token |
| Search | Substrate (`substrate.office.com`), AAD bearer for that scope | `POST /search/api/v2/query`, body `{Cvid, Scenario:{Name:"teamsmessages"}, EntityRequests:[{EntityType:"Message", ContentSources:["Teams"], Query:{QueryString}, Size}]}` answers 200 (probe run 5, 2026-10-22). Hits at `EntitySets[0].ResultSets[0].Results[].Source`: `ClientThreadId`/`ClientConversationId` (the `19:` conversation id), `From.EmailAddress.Name`, `Preview`, `DateTimeSent`, `HitHighlightedSummary`. The asyncgw `/msgsearch/v2/search` path is a dead 404. | IMPLEMENTED as a partial (`search` in `teams/sync.rs`/`search_hits`, `searchMessages`/`searchHits` in `providers/teams`): a per-room search queries Substrate globally and keeps the hits whose `ClientConversationId`/`ClientThreadId` is the room. The hit carries an Exchange item id, not the chat-service message id, and `From` only a display name, so the result shows text/author/time and opens the room but cannot jump to the exact message; the id is synthetic and the author MRI is resolved from the directory when known. |
| Calls | Teams itself (deep links), like Slack's huddles; the calling service (`calling_trouterUrl`, flightproxy `epconv`/`conv` with an SDP offer, captured 2026-10-23) is NOT used | A call is an `Event/Call` chat-service message. Its start (`callStarted`, a `callId`) is a channel's reply-chain root, and its content is never rewritten after the call. Its end is a separate `Event/Call` reply on that root (`parentMessageId`, or `;messageid=` in the history's `conversationLink`) with `<ended/>`, `callEventType` `callEnded` and each participant's `<duration>` in seconds. Read from a live channel call, 2026-10-23. Teams' web app joins a channel call by `https://teams.microsoft.com/l/meetup-join/<thread, %3a/%40 escaped>/<callStarted message id>?context={"Tid":"<tenant>","Oid":"<organizer object id>"}`, the organizer being the start message's author (read in the web app's call metadata in a HAR, 2026-10-23). Deep links: `https://teams.microsoft.com/l/channel/<channel>/<name>?groupId=<Graph group id>&tenantId=<tenant>` and `https://teams.microsoft.com/l/chat/<chat>/conversations?tenantId=<tenant>` | IMPLEMENTED on all three as a hand-off, no native media (a WebRTC stack is out of scope; user decision 2026-10-23: open a web view on the call like kChat and Slack). The start is a `videoconf` card whose call id is its own message id; the end is drawn in its place (the start's id and time, a message id being its arrival time) as a `videoconf-ended` with the longest participant duration, its newer `updated_at` replacing the running card in either store whatever arrives first. A channel card's Join and info link open the call itself (`meetup_link`, the start message re-read for its author's `8:orgid:` object id, `TeamsSync::join_url`); a chat card's Join and the header call button open the conversation's deep link, a channel's group id read from its aggregator entry (`groupId`), else from Graph (`me/joinedTeams` scan, as for uploads). Desktop: `call_message`/`call_card`/`channel_link`/`chat_link` in `teams/translate.rs`, `TeamsSync::call_url`, routed by `Session::start_call`/`join_call`/`call_link`. On Linux GTK opens it as a Chromium app window (unrestricted, its profile keeps the sign-in); on macOS and Windows a call window kept on Microsoft's pages (`translate::call_allowed`: its web app, CDNs and sign-in, so a tenant federated to its own identity provider signs in through the browser), through `call_window::open_teams` (GTK) and `CallWindow`'s Teams mode with a persistent store (SwiftUI, `teams_call_allowed`). Mobile: `teamsCalls` (`packages/provider-teams/src/calls.ts`, `meetupLink` in `translate.ts`), `TEAMS_CAPABILITIES.videoCall`; the call screen hands the link to the system like Slack's, so the installed Teams app takes it through its app link, else the browser. A chat call has no join link of its own here, so it lands on the conversation, whose page shows the running call's Join. Unverified in an installed app |
| Push | `teamsPushServiceAfd` (have) | FCM registration + registrar channel | Large native surface (killed-app delivery) |
| Quote context | chat service (have) | n/a | Real Teams limit: history pages backward only, no permalink quote |

Nothing has run against more than one tenant; installed Android and macOS runs are
outstanding. See [parity](../parity.md#19-experimental-integrations).

## Mobile

packages/provider-teams/: `auth.ts` (device code, approval, routes, tokens, resume),
`client.ts` (the two credentials, one renewal on 401), `translate.ts`, `sync.ts`
(`TeamsSync`, `TeamsTranslator`, `TeamsRooms`), `trouter.ts` (`TeamsTrouter`, the
Listener), `outbox.ts` (`TeamsOutbox`, `TeamsMessageActions`), `index.ts`
(`createTeamsProvider`, `TEAMS_CAPABILITIES`). app/login.tsx offers the kind behind
the unlock: a button asks the code, which shows with a button opening Microsoft's page
and Cancel; approval connects the account like any other. lib/sessionTransport.ts
resumes it; ui/session.tsx registers the credential sink.

## Desktop

crates/rv-teams/src/: `auth.rs`, `client.rs`, `translate.rs`, `frames.rs`, `live.rs` (the
Trouter actor behind the shared `LiveEvent` feed), `service.rs` (every call once signed in);
rv-core/src/teams/: `sync.rs` and `actions.rs`, which call the service and write the store, and the conversion of rv-teams' `Session`, wired as
`Backend::Teams` in session.rs and `ServerKind::Teams`. GTK login.rs shows the code and
Microsoft's link (`show_teams_code`) and waits with Cancel (window.rs
`start_teams_login`); rv-ffi teams.rs exposes `TeamsSignIn` to SwiftUI's LoginModel and
LoginView. Rocket.Chat's own GIFs, stickers, encryption settings, server icon and X
cards are left out of Teams accounts (`info.teams`, `is_teams`).

## Sources

- packages/provider-teams/src/auth.ts
- packages/provider-teams/src/client.ts
- packages/provider-teams/src/translate.ts
- packages/provider-teams/src/sync.ts
- packages/provider-teams/src/trouter.ts
- packages/provider-teams/src/outbox.ts
- packages/provider-teams/src/index.ts
- packages/provider-teams/src/provider.test.ts
- apps/mobile/app/login.tsx
- apps/mobile/lib/sessionTransport.ts
- crates/rv-teams/src/
- apps/desktop/crates/rv-core/src/teams/
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-gtk/src/login.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-ffi/src/teams.rs
- apps/desktop/macos/Sources/RocketVibeKit/LoginModel.swift
- apps/desktop/macos/Sources/RocketVibe/LoginView.swift
- docs/protocol/MICROSOFT_TEAMS.md
