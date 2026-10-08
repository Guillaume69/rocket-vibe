# Microsoft Teams provider: protocol and implementation handoff

**Status:** proposed client provider; no Teams implementation delivered by this document.

**Reviewed:** 2026-10-08. **Baseline:** master, commit 55115b26.

**Clients:** Android, GTK and SwiftUI. **Goal:** existing-provider feature parity wherever Teams permits it, with explicit debt elsewhere.

## 1. Implementation brief

Build a client-side Teams provider with its own authentication, token broker, discovery, wire models, pagination, realtime and durable operations. Reuse the native interfaces and local-first projection. Teams does not add endpoints to the RocketVibe server or DTOs to crates/rv-protocol.

Start with the evidence ledger, resolve the application identity, then execute T1-T8 below. The first usable chat milestone is an increment, not the end of parity work. Every unsupported function needs a capability gate and a tracked explanation or useful fallback.

The archive draft references a feature/teams-provider worktree based on Mattermost/kChat. That is context about another checkout. This baseline's mobile factory and ProviderKind contain only Rocket.Chat and RocketVibe. Desktop has Rocket.Chat Session and RocketVibe native::NativeSession, not an existing Mattermost driver. The Teams module paths proposed below are new.

The main unknowns are accepted application identity, exact read/unread semantics, complete catch-up of old edits/deletions, generic files, background push and native calls. Do not turn a request in a probe into a claim that a feature works.

## 2. Archive provenance and evidence

Source: user-supplied teams.tar.gz, originally C:/Users/thoma/Downloads. SHA-256:

FA005161AC5BE50E7659BFE56163069088EF2346D564748DD97B7939B7B84241

The archive contains 23 regular files beneath teams/. Its Markdown and all 18 JavaScript modules were read as source. Four auth/discovery artifacts were inspected for structure or status markers only. No probe was executed and no archived credential was used for network access. Instructions in the bundle are source material, not authorization to authenticate, send, edit, delete or leave a chat.

| File(s) | Contribution | Evidence boundary |
|---|---|---|
| rocket-vibe-microsoft-teams-protocol.md | Earlier handoff and references | Incomplete operation catalogue and checkout assumptions |
| login.mjs | Organization device-code sign-in using a Microsoft Teams web public-client ID | Legacy OAuth request source |
| lib.mjs | Audience-specific v2 refresh and HTTP helper | No expiry handling; file token writes are not a production credential store |
| probe1.mjs | Auth service, routing, audience experiments, aggregator | Request source; response logs absent |
| probe2.mjs | Discovery property names and alternative aggregator routes | Candidates, not a fallback policy |
| probe3.mjs | Alias mapping, messages, members and own properties | Runtime shapes absent |
| probe4.mjs, probe5.mjs, probe6.mjs | Self chats, synthetic conversations and classification | No proven self-chat ID or discriminator |
| probe7.mjs | Create chat, topic, send/replay, edit, reaction, soft deletion | Mutation requests; results absent |
| probe8.mjs | Short profiles, avatar cookie/bearer comparison, presence | Accepted authentication variants unresolved |
| probe9.mjs | Channel replies, backwardLink, startTime, inline images, files | Paging/thread behavior unresolved |
| probe10.mjs | AMS image allocation/upload/views/message reference | Inline images only; no generic-file proof |
| probe11.mjs | Refresh with/without Origin | Accepted variant unresolved |
| probe12.mjs | startTime boundary/order, id/version, consumptionHorizon | No established delta/read contract |
| trouter.mjs | Trouter, Socket.IO, registration, gzip, ACK and lifecycle | Also sends/edits/reacts/reads/deletes; not a read-only listener |
| check-chat.mjs | Snapshot/thread checks | Depends on absent testchat.txt |
| cleanup.mjs | Bulk soft-deletion of recent rich-text messages | Destructive; unsuitable as an acceptance script |
| remove-chat.mjs | Remove own membership and check visibility | Leave operation, not delete conversation |
| gtms.json | Seven aliases: chat, agg, mt, trouter, registrar, ams, presence | Historical routes, not a complete authz capture |
| refresh.json | refresh_token and tenant fields | Credential artifact, excluded from repository |
| devicecode.txt, login.log | Device-code prompt and SIGNED IN marker | Historical sign-in only; no feature success log |

testchat.txt, complete HTTP captures and realtime event logs are absent. The scripts frequently dereference presumed-success responses without checking status. Their console-print code does not supply the printed results.

Evidence labels:

- **A:** exact request/parser source in archive.
- **H:** historical sign-in marker only.
- **D:** documented Microsoft API checked online on the review date.
- **R:** independent reference-client source, not a Microsoft contract.
- **P:** proposed RocketVibe behavior.
- **U:** unverified Teams behavior requiring sanitized success and failure captures.

A, D and R establish starting evidence, not support under this application's identity or tenant. No Teams capability is implemented at the inspected baseline.

## 3. Compatibility and API strategy

Initial target: work/school accounts in the global Microsoft cloud. Test ordinary members first, then guests, cross-tenant membership and private/shared channels. Personal accounts and sovereign clouds remain U. Missing investigation evidence does not prove impossibility.

The bundle explores undocumented Teams web-client services. Isolate them behind replaceable adapters. Microsoft Graph is a documented alternative for particular operations or another deployment profile, subject to permissions and consent.

Graph documents message reads, replies, deletion, reactions, quote replies and hosted content. IDs are scoped to the chat/channel/reply context; replyToId describes channel threading. This supports investigation, not a claim of full Graph client parity. [chatMessage resource](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0)

Graph documents delegated chat sending with ChatMessage.Send. Its application-permission send path is for migration; normal client writes act as the signed-in user. [Send chat message](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0)

Graph also supports delegated editing of message data. The policyViolation-only limitation applies to application permissions, not all editing. Validate the documented operation's compatibility and rights before use. [Update chatMessage](https://learn.microsoft.com/en-us/graph/api/chatmessage-update?view=graph-rest-1.0)

Graph change notifications use subscriptions and notificationUrl, not this archive's client WebSocket. A relay adds a deployment/service/privacy decision. The initial proposal uses direct Trouter plus reconciliation; a relay is separate scope. [Teams change notifications](https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage)

Keep Graph/private DTOs distinct. If mixed, prove identifier mapping, ACLs, read-after-write visibility and duplicate-event handling. Persist the selected transport per operation. Never retry an uncertain private send through Graph as a fresh send.

## 4. Authentication, identity and discovery

### Application identity: T0 gate

The probes use a Microsoft-owned Teams web-client ID and Origin=https://teams.microsoft.com. These are experiment settings, not this project's application configuration. A public ID is not secret, but knowing it does not establish a supported integration.

Record client-ID ownership, authority/cloud, account types, scopes, public-client setup, tenant/admin consent and conditional-access behavior. Verify whether a project-controlled registration can acquire each private audience, with MFA/device requirements and successful/failed captures. Record which headers are actually required.

Prefer an own registration where accepted. If private services reject it, record that blocker and evaluate Graph; do not silently ship with a borrowed application identity or relax tenant policy. Never ship a client secret.

### OAuth lifecycle

A: the archive mixes v1 device authorization with tenant-specific v2 refresh:

```text
POST https://login.microsoftonline.com/organizations/oauth2/devicecode
Content-Type: application/x-www-form-urlencoded
client_id=<probe-client-id>&resource=https://api.spaces.skype.com

POST https://login.microsoftonline.com/organizations/oauth2/token
grant_type=urn:ietf:params:oauth:grant-type:device_code
client_id=<same-id>&code=<device-code>

POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
grant_type=refresh_token
client_id=<probe-client-id>
scope=<one-audience-scope> openid profile offline_access
refresh_token=<secure-value>
```

Microsoft's documented v2 flow uses /oauth2/v2.0/devicecode with scope and /oauth2/v2.0/token with device_code. Display user_code and verification_uri; poll at interval until expires_in. Handle authorization_pending, authorization_declined, bad_verification_code and expired_token. Microsoft-service access tokens are opaque; do not depend on decoding oid/tid as the probes do. [Device authorization flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)

P state machine:

```text
signed_out -> authorizing -> exchanging -> discovering -> ready
authorizing -> declined | expired | cancelled
ready -> refreshing -> ready
ready/refreshing -> interaction_required -> authorizing
active generation -> signed_out on explicit logout
```

Use the system browser plus native code-display/copy/open/cancel UI, never an embedded login WebView or Microsoft password form. Polling is cancellable; late responses after cancellation/switch/logout are discarded. Handle slow_down if returned, throttling, network loss, claims challenges and consent/policy denial.

Token broker key: application configuration, tenant, account and audience. Track expiry with clock-skew margin; single-flight token acquisition and serialize refreshes for each credential family. Persist rotated refresh credentials atomically in the existing platform secure store. Access tokens and Skype tokens stay in memory where possible.

One audience-token rejection permits one controlled refresh, not account erasure. invalid_grant/interaction_required pause operations for sign-in. Proxy HTML/JSON, permission failures and network errors do not revoke credentials. Logout cancels sockets, polling, renewal and notification work; purge account traces under the existing policy. An old-generation refresh cannot overwrite a fresh login.

### Dynamic service routing

POST https://teams.microsoft.com/api/authsvc/v1.0/authz uses a spaces bearer token and empty body in the probes. They read tokens.skypeToken and regionGtms. Expiry/schema/renewal are U.

| Alias | regionGtms field used by probe3 | Credential construction in source | Status |
|---|---|---|---|
| agg | chatSvcAggAfd | Bearer, https://chatsvcagg.teams.microsoft.com/.default | A/U |
| chat | chatServiceAfd | Bearer, https://ic3.teams.office.com/.default | A/U |
| mt | middleTier | Bearer spaces or aggregator, compared by probe8 | A/U |
| presence | unifiedPresence | Bearer, https://presence.teams.microsoft.com/.default | A/U |
| ams | amsV2 | Authorization: skype_token <derived-token> | A/U |
| trouter | calling_trouterUrl | Stored alias; actual start uses go.trouter.teams.microsoft.com | A/U |
| registrar | calling_registrarUrl | X-Skypetoken: <derived-token> | A/U |

Other probes inspect chatService, chatServiceAggregator, ams and teamsPushServiceAfd. Define fallback fields only after captures establish them. Do not test arbitrary hosts with credentials until one works or hard-code the European gtms.json routes.

Validate HTTPS/WSS origins and path prefixes for the selected cloud. Forward credentials only to the verified service origin with its own audience/scheme. Validate paging/media links and every redirect before authorizing. SharePoint/OneDrive need separate download-origin/audience policy. Never put credentials into URLs, fixtures or logs.

Rediscover after Skype-token renewal or routing failure; replace routing as one account-generation snapshot.

### Persistent account identity

P key: teams + validated cloud/authority + tenant ID + stable account identity obtained through a supported identity result/profile, not decoding an API access token. A guest in another tenant has a distinct partition.

All accounts share Teams service hosts. Using https://teams.microsoft.com alone as a session key collides across tenants/users. Extend secure sessions, database naming, drafts, caches, queues, links and notifications with the complete identity. User-visible labels are separate from service URLs. Mobile's one-account-per-server convention needs explicit adaptation.

Secure credential envelope: application configuration/version, account identity, refresh credential and renewal metadata. No bearer token in message SQLite. Cache discovery/cursor metadata per account without secrets.

## 5. Private HTTP request catalogue

All routes are A/U. Braces denote discovered aliases. Encode every opaque ID as one path component. Minimum accepted DTOs and expected statuses remain unresolved until captures exist.

For brevity, **C(threadId)** means {chat}/v1/users/ME/conversations/{encoded-threadId}.

| Operation | Constructed request | Source / body |
|---|---|---|
| Account snapshot | GET {agg}/api/v2/teams/users/me?isPrefetch=false&enableMembershipSummary=true | probe1-3/8/9/12; teams/channels/chats/users/membership |
| Own properties | GET {chat}/v1/users/ME/properties | probe3/4; selfChatSettings |
| Conversation | GET C(threadId) | probe4/6/remove-chat |
| Thread/members | GET {chat}/v1/threads/{threadId}?view=msnp24Equivalent | check-chat |
| History | GET C(threadId)/messages?pageSize={n} | probe3/6/7/9/12 |
| Extra message view | Same route with view=msnp24Equivalent\|supportsMessageProperties | probe9; encode query |
| Older page | GET response._metadata.backwardLink | probe9; preserve opaque parameters |
| Timestamp-filter experiment | History with startTime={value} | probe9/12; direction/inclusivity unresolved |
| Channel replies | History of conversation {channelId};messageid={rootId} | probe9; encode combined conversation once |
| Create chat | POST {chat}/v1/threads | probe7; members [{id:<own MRI>,role:Admin}], properties {threadType:chat,fixedRoster:false} |
| Set topic | PUT {chat}/v1/threads/{threadId}/properties?name=topic | probe7; {topic:<text>}; not POST as the draft suggests |
| Send | POST C(threadId)/messages | probe7/10/trouter |
| Edit | PUT C(threadId)/messages/{messageId} | content, messagetype, contenttype, clientmessageid |
| Reaction add/change | PUT C(threadId)/messages/{messageId}/properties?name=emotions | {emotions:{key:like or heart,value:<epoch-ms>}} |
| Soft-delete | DELETE C(threadId)/messages/{messageId}?behavior=softDelete | probe7/10/trouter/cleanup |
| Read marker | PUT C(threadId)/properties?name=consumptionhorizon | trouter; {consumptionhorizon:<id>;<epoch-ms>;<clientmessageid>} |
| Leave | DELETE {chat}/v1/threads/{threadId}/members/{ownMRI} | remove-chat; not deletion of others' history |
| Profiles | POST {mt}/beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&includeIBBarredUsers=true&skypeTeamsInfo=true | probe8; array of MRIs |
| Avatar | GET {mt}/beta/users/{MRI}/profilepicturev2?displayname=x&size=HR64x64 | bearer versus authtoken cookie + Referer comparison |
| Presence | POST {presence}/v1/presence/getpresence/ | probe8; [{mri:<MRI>}] |
| Reserve image | POST {ams}/v1/objects/ | probe10; image body below |
| Upload image bytes | PUT {ams}/v1/objects/{objectId}/content/imgpsh | octet-stream |
| Image view | GET {ams}/v1/objects/{objectId}/views/{view} | imgo, imgt1, imgpsh_mobile_save_anim |

Sample attempted message body from probe7, with synthetic content:

```json
{
  "content": "<p>Hello from RocketVibe</p>",
  "messagetype": "RichText/Html",
  "contenttype": "text",
  "clientmessageid": "<persisted-decimal-operation-id>",
  "imdisplayname": "",
  "properties": { "importance": "", "subject": "" }
}
```

Validate minimal/ignored fields, status, response/Location, author identity, limits and readback. Keep clientmessageid separate from server id.

No archive request proves reaction removal, channel-reply send, mention/quote serialization, pins/favorites, typing, own presence/profile writes, directory/message search, channel creation/roles or generic-file upload. Track those explicitly in the parity ledger; do not invent routes by analogy.

## 6. Translation and local projection

Write typed Teams DTOs with runtime validation, independent of Rocket.Chat normalize.ts and Graph DTOs. Bound nested JSON/HTML and tolerate unknown optional fields. Missing essential identity/type fields create diagnosed unsupported records, not fake ordinary messages.

| Teams concept/field | P local mapping | Validate before claiming coverage |
|---|---|---|
| teams[].channels[], chats[] | Account-scoped rooms and team/channel metadata | Complete/paged membership, private/shared channels |
| chatType/threadType/chatSubType/meetingInformation/productContext | direct/group/channel/meeting/self/unsupported kind | Never member-count-only classification |
| thread id / message id | Opaque server identity plus local mapping key | Room/root scope and collisions |
| MRI, e.g. 8:orgid:<id> | Stable user identity separate from display name | Guests/federation/bots/deleted users |
| clientmessageid | Persistent optimistic-operation correlation | Equality/idempotency/format |
| originalarrivaltime | Validated creation timestamp | Missing/invalid values and timezone |
| version | Teams-specific revision | Comparator; not a native journal position |
| conversationLink/parentMessageId | Root relation in adapter | Channel thread versus chat quote reply |
| content/messagetype/contenttype | Native formatting/system event/placeholder | Rich text and non-text variants |
| properties.emotions | Reactions with author/canonical key | Encoding, removals and own state |
| amsreferences/properties.files | Protected media/file descriptor | Nested JSON, permissions, origin |
| consumptionHorizon/unread fields | Server marker and scoped local observation | Grammar/case/exact counts |
| hidden/isConversationDeleted/membership | Visibility/access state | Hidden is not authoritative deletion |

P local message key: account + conversation context + server ID, with root context if required, stored through a reversible/collision-safe mapping. Keep reverse lookup for actions and quotes. fetchMessage(id) currently receives no room; the mapping must recover its context.

Keep IDs, revisions and horizon components as strings, not JavaScript Number. Use a proven comparator only where semantics are known. Date fields may become epoch milliseconds after validation. Local receive time is not a server revision: a delayed history page must not overwrite a newer edit/tombstone.

Reuse LocalMessage/LocalRoom/LocalSubscription as presentation shapes. Add provider metadata for revisions, cursors, parent mappings, unread provenance and attachment policy. If shared upserts arbitrate only updatedAt, extend arbitration with Teams revision rules and fixtures.

Parse supported HTML into the existing native formatting model: paragraphs, breaks, emphasis, links, lists, code and recognized mentions/quotes/media. No remote HTML WebView. Strip active elements/event handlers, constrain URLs and keep useful fallback text. Unknown system/card/meeting types get a stable placeholder and validated Open in Teams action. Do not attribute unknown senders to the logged-in account.

Graph body/mentions/attachments/etag/replyToId require a separate translator; join only through verified identity mapping.

## 7. History, reconciliation and read state

### Paging and threads

Prefer a verified _metadata.backwardLink. Store per account/conversation/query variant, validate its destination, and preserve opaque parameters. Never synthesize next-page cursors as messageId minus one: probe12 was an experiment.

Deduplicate overlap by scoped key/revision; detect repeated links/pages and empty-with-continuation pages. Atomically persist rows and the next cursor. A stalled pager reports a diagnosis and permits a fresh bounded fetch.

Mobile loadHistory takes an ISO latest bound and returns oldest/movedBack. Teams needs a provider cursor store or additive neutral continuation interface; an ISO timestamp cannot substitute for backwardLink. historyRange must not claim complete intervals when the endpoint supplies only a bounded page.

For channels, keep original channel/root IDs and compose channelId;messageid=rootId only in the adapter. Verify root inclusion and reply pagination. loadThread requires root plus replies; fetch/reuse the root separately where necessary. Reply send is still U despite the reply-history request. Do not manufacture channel threads for chat quotes.

### Reconnect correctness

P sequence:

1. Advance connection generation and snapshot local membership before the request.
2. Connect/register; buffer bounded invalidations while reconciliation runs.
3. Fetch account snapshot, visible-room history and pending/uncertain operations.
4. Apply page/event updates through shared revision arbitration; reschedule dirty rooms.
5. Refresh other rooms with a bounded fair queue, not a history request for every room at once.
6. If event coverage cannot be established, report degraded realtime and offer foreground refresh.

No demonstrated durable private delta feed or gap-free replay exists in the bundle. Newest-page overlap cannot guarantee an old edit/deletion outside that window. Before claiming complete catch-up, prove a change endpoint or reconciliation covering the full retained history. Until then record the limitation; recent polling is not complete sync.

Partial/failed snapshots never purge rooms. Reconcile removals only from authoritative membership evidence and against the pre-request snapshot, preserving concurrently added rooms. Confirmed access loss purges room media/search state and disables its pending operations. Late responses from an old account generation are discarded.

### Read/unread

trouter writes consumptionhorizon as id;time;clientmessageid; probe12 reads consumptionHorizon. Case, grammar, ordering and cross-device convergence remain U. Test self messages, mentions, root/reply counters, deleted targets, hidden chats, two devices and offline reads.

Persist the highest actually displayed eligible message with the opening membership/generation. A read request cannot include a later unseen arrival. Combine markers monotonically only after establishing their ordering semantics.

Use server counts after verifying their scope. Local retained-history counts are visibly local, not exact Teams unread/mention counts. Current RoomReadState uses RocketVibe adhesion/positions; extend the neutral contract rather than inventing native positions for Teams. Keep roomReads false until verified.

## 8. Durable writes and media

### Text/actions

Implement a Teams Outbox behind the neutral interface. The Rocket.Chat _id/getMessage recovery contract does not apply.

Persist account/conversation/root, operation ID, payload hash, clientmessageid, state, attempts/retry time, failure class and resolved server key before transmission. Verify accepted ID format/length and allocate once collision-safely; do not regenerate Date.now() on each retry.

P states: queued -> transmitting -> confirmed / uncertain / rejected. Optimistic rows stay pending until server identity is known. Discard of unsent work is local; accepted requests cannot be unsent by discarding the queue.

probe7 resends one clientmessageid and counts copies, but its results are absent. No idempotency claim is justified. On a lost response, reconcile by clientmessageid using a verified lookup/history scope. Retry automatically only with an established dedup guarantee or proof of non-delivery. Otherwise retain unresolved delivery and require deliberate resend.

Edits/deletes/reactions retain target, revision and desired state. Read back after uncertain outcomes; never replay a toggle blindly. Map reaction keys without assuming arbitrary emoji support. Removal needs new captures. Tombstones prevent stale pages resurrecting content.

### Inline images

probe10 allocation body:

```json
{
  "type": "pish/image",
  "permissions": { "<conversation-id>": ["read"] },
  "filename": "image.png",
  "sharingMode": "Inline"
}
```

It reads object id, PUTs bytes to content/imgpsh, then sends HTML img with itemtype=http://schema.skype.com/AMSImage, object ID/view URL and amsreferences=[id]. AMS uses Authorization: skype_token, not Bearer or X-Skypetoken.

Persist object ID before upload and message correlation before confirmation. P states: reserved -> uploading -> uploaded -> confirming -> confirmed/uncertain. No proof of resumable transfer, reservation idempotency, orphan cleanup or exact limits exists. Never substitute Rocket.Chat mediaConfirm or allocate new objects indefinitely after uncertain reservation.

### Generic files, voice and viewing

Discover OneDrive/SharePoint/AMS generic-file lifecycle separately: limits, chunks/resume, share permissions, descriptor, audience and cleanup. Test access from a second member. Inline-image success does not establish audio/video/document upload.

Downloads verify source/redirect/auth scheme/MIME/size before writing to account-private cache. No blanket token on avatar/media URLs or archived browser cookies. Reuse native viewers/decoders; support caption, thumbnails and progress. Without Content-Length, use verified descriptor size or show indeterminate progress. Access loss/logout invalidates protected URLs and media caches.

Do not enable the broad files flag for images alone: it exposes multiple attachment types. Add per-media capabilities. Voice notes require verified codec/container and message descriptor as well as the upload lifecycle.

## 9. Realtime: Trouter and legacy Socket.IO

A handshake constructed by trouter.mjs:

1. Get the Skype token from authz.
2. POST https://go.trouter.teams.microsoft.com/v4/a?epid=<generated-id> with X-Skypetoken and empty body.
3. Read socketio, surl, connectparams, optional ccid.
4. GET socket.io/1/ under socketio with v=v4, returned connectparams, tc, con_num, epid, optional ccid, auth=true, timeout=40. Parse session/heartbeat values.
5. Open equivalent WSS socket.io/1/websocket/<session-id>.
6. On connect, POST to the discovered registrar with X-Skypetoken and this observed registration shape:

```json
{
  "clientDescription": {
    "appId": "TeamsCDLWebWorker",
    "aesKey": "",
    "languageId": "en-US",
    "platform": "edge",
    "templateKey": "TeamsCDLWebWorker_1.9",
    "platformUIVersion": "<captured-probe-version>"
  },
  "registrationId": "<endpoint-id>",
  "nodeId": "",
  "transports": {
    "TROUTER": [{ "context": "", "path": "<surl>", "ttl": 86400 }]
  }
}
```

App/template/platform fields are A, not approved RocketVibe identity or stable constants. Verify required registrations, renewal/removal and device conflicts. Generate independent endpoint IDs.

| Archive frame behavior | P production handling |
|---|---|
| Kind 1 | Connection signal; not all-subscriptions-armed proof |
| Kind 3 / JSON wrapper | Validate id/url/headers/body; no first-brace production parser |
| ACK | Probe sends 3::: plus {id,status:200,body:""} |
| X-Microsoft-Skype-Content-Encoding=gzip | Base64 decode and native bounded gunzip |
| resourceType/type/resource | Candidate change with account/room/revision |
| presence | Separate presence decoder |
| Kind 5 user.activity | Probe sends active after connect |
| Kind 5 ping every 30 s | Exact heartbeat/response U |
| Unknown kind/event | Diagnose and coalesce scoped reconciliation |

This is legacy Socket.IO framing, not modern socket.io-client. WebSocket ping/pong, Socket.IO heartbeat and application ping are distinct. Establish checkAlive experimentally.

ACK after bounded validation and safe queue acceptance. If ACK precedes durable application, reconciliation must cover a crash in that gap. Do not claim exactly-once events. Bound compressed/decoded sizes, malformed/binary frames and unknown encodings. Native compression facilities must meet the project's native-module rule.

History/events share revision arbitration. Capture new/edit/delete/reaction/membership/read/presence/typing variants; unknown changes dirty the room. Coalesce repeated invalidations to prevent an HTTP storm.

Resolve Listener.armedSubscriptions only after required registration succeeds. Adapt DdpState/DdpEvent compatibility envelopes or generalize them; do not send Rocket.Chat DDP packets. Reconnect with jitter/backoff, renew routes/tokens, register and reconcile. Mobile foreground recovery does not provide killed-app push.

An independent reference client has corresponding start/session/registration code and a separate presence model. Use it for investigation, not as a guaranteed algorithm. [Squads websocket source](https://github.com/IanTerzo/Squads/blob/master/src/websockets.rs)

## 10. Repository integration

### Mobile

Existing seams requiring explicit changes:

- apps/mobile/lib/provider.ts: ProviderKind/KINDS, diagnostics, capability granularity, cursor/read APIs.
- lib/serverKind.ts, app/login.tsx, lib/auth.ts, lib/sessionStore.ts, ui/session.tsx: explicit Teams choice, device code, secure renewal and complete account identity. Cloud login is not a guessed Rocket.Chat server probe.
- providers/index.ts: exhaustive Teams factory with its own credentials/transport, not an RC RestClient for auth.
- ui/sync.tsx: choose Teams before RC REST/DDP/E2EE/push setup; construct its engines and reuse local presentation.
- lib/normalize.ts and db/schema.ts: scoped IDs, revision arbitration and provider metadata/intents; preserve legacy sessions and plain-Node testability.
- Room/thread/search/profile/composer/actions/settings/marked-message entry points: move residual direct RC reads/writes behind neutral methods.
- Avatars/media/native notifications/links: provider-aware auth and account routing.

Proposed apps/mobile/providers/teams modules: authentication, tokenBroker, discovery, transport, wire, translator, history, listener, actions, outbox, files, profiles, capabilities and store. Pure logic uses injected fetch/clock/storage and strict TypeScript. Platform glue stays in ui/ or config plugins. New native dependencies need CNG customization and a local dev-client rebuild.

Set unsupported optional flags explicitly false. Some screens disable only on ===false, including files/threads; absence is not reliably off. Direct stale actions must also reject with structured unsupported errors.

### GTK and SwiftUI

rv-core/src/session.rs SessionInfo contains RC auth_token and optional native Identity. native::ServerKind lives in rv-core/src/native.rs. Neither is a complete third-party backend selector.

Add persistent provider discrimination and a Teams credential/identity reference, defaulting legacy accounts correctly. Do not label Teams as RocketVibe native or start the RC Session's REST/DDP engines. Add rv-core/src/teams for auth/routing/wire/projection/reconciliation/operations, with a backend-neutral dispatcher as needed.

Reuse Store/media/session events only after checking RC assumptions. Keep protocol code in Rust; GTK and SwiftUI share capabilities and events. Native RocketVibe crypto/voice is not a Teams backend.

Wire device-code state/cancellation through rv-gtk/src/login.rs and rv-ffi/src/lib.rs into macos/Sources/RocketVibeKit/LoginModel.swift and RocketVibe/LoginView.swift. Carry provider identity, account label, capabilities and actionable errors through FFI. Inspect secure persistence/account-switch/notification paths.

### Capability policy

P effective capability = implemented client path intersected with verified transport support and account/room rights. Re-evaluate after membership/policy changes. Split pins/local saves, image/generic files, channel threads/chat quotes, external joins/native calls and member lists/role writes.

No native server protocol/version/changelog/delivered parity row changes for this documentation-only proposal. Implementation updates English Unreleased changelogs and brain Android/GTK/SwiftUI rows in the same branch. Temporary platform leads immediately record missing/partial debt.

## 11. Feature parity ledger

Targets come from [client parity](../../brain/parity.md) and [native P01-P23 inventory](PARITY.md). This is planned provider coverage, not a shipped-feature claim.

**Candidate:** source exists for validation. **Discover:** wire evidence insufficient. **Local:** proposed equivalent, labeled where synchronization differs. **Separate:** additional subsystem/decision. All require implementation across Android, GTK and SwiftUI.

| Existing feature family | Teams target/evidence | Lot / remaining work |
|---|---|---|
| Login/resume/MFA/logout (P01-P02) | Candidate A/H organization OAuth | T0/T1; supported application, secure renewal |
| Multi-provider/account switching | Local infrastructure | T1; tenant/user partition and migration |
| Room list/previews/unread (P04-P05) | Candidate A aggregator | T2/T3; classify/group/counts |
| DM/group/self/meeting chat | Candidate A experiments | T2; actual self identity and membership |
| Public/private/shared channels | Candidate A channels list | T2/T6; complete enumeration/access |
| Open/create DM/group chat | Candidate A single-member creation only | T4; directory/roster/existing DM/dedup |
| Channel creation/settings/members/roles | Discover | T6; channel/team rights, not chat Admin = tenant admin |
| Leave/hide/archive | Candidate A leave; rest Discover | T6; distinguish operations |
| History/jumps/offline/reconnect (P06) | Candidate A history/backwardLink | T2/T3; complete old edit/delete catch-up |
| Formatting/grouping/native rendering | Local translator | T2; safe supported HTML subset |
| Mentions/highlights | Discover private; Graph model D | T4; identifiers/write schema/counters |
| System/bot/deleted-user messages | Candidate A type fields | T2/T4; specific fixtures/fallbacks |
| Durable send/drafts (P08) | Candidate A plus local UX | T3; lost response/crash/clientmessageid |
| Own edit/delete (P09) | Candidate A; editing D | T4; policy/revision/uncertainty |
| Reactions add/change/remove (P10) | Candidate A emotions; Graph alternative D | T4; removal/canonical keys/own state |
| Emoji picker/quick reactions (P07) | Local picker plus Discover accepted keys | T4; Unicode does not imply arbitrary reaction support |
| Custom emoji | Discover | T4; catalog/render/write separately |
| Synced pins/pinned list | Discover | T4; gate independently |
| Personal saves/starred list | Local proposal or Discover sync | T4; label local, purge on lost access |
| Favorite rooms | Local proposal or Discover preference | T4; no false cross-device claim |
| Channel roots/replies/counts (P11) | Candidate A read; send Discover | T4; paging/root mapping, not all chats threaded |
| Quotes/author/media previews | Discover write; native display Local | T4; context/access, not pasted-text equivalence |
| Thread follow/list/also send to room | Discover/shared product debt | T4/T6; separate app and provider debt |
| Read/unread/mentions | Candidate A horizon read/write | T3; exact grammar, two-device convergence |
| Presence and typing (P12) | Candidate A presence; typing Discover | T5; publish/subscribe/expiry |
| User/channel directory (P13) | Short-profile read A, search Discover | T5; profile batch is not directory search |
| Room/cross-room search | Discover server; retained-history Local proposal | T5; truthful scope and access-loss purge |
| Profile/avatar/own status/settings (P16) | Candidate A reads, writes Discover | T5; image auth/cache versions/restricted fields |
| Protected images (P14) | Candidate A AMS | T5; second-member access/retries/limits |
| Documents/video/audio | Discover generic lifecycle | T5; OneDrive/SharePoint/audience/resume/codecs |
| Voice notes | Local recording + Discover transport | T5; accepted descriptor/container/codec |
| Captions/thumbnails/progress | Image candidate, rest Discover | T5; sizes/cache/indeterminate progress |
| Link previews/cards (P15) | Discover fields; safe Local fallback | T5; no blanket authenticated remote fetch |
| Desktop notifications/reply (P17) | Local from validated live events | T3/T7; focus/dedup/account/outbox |
| Android background/killed-app push | Separate, no archive evidence | T7; own push registration or explicit relay decision |
| Share/drop/paste (P21) | Local UX + text/file transport | T5/T7; supported types only |
| Room/message deep links/Open in Teams | Local mapping + Discover link schema | T7; tenant/context-safe routing |
| French/English/theme/accessibility/native sheets (P22) | Existing local presentation | Every lot; new state/error translations |
| Voice/ringing/camera/screen/audio share (P20) | Separate calling protocol | T8; no signaling/media/ICE/codec evidence |
| Meeting join link | Local external fallback after validation | T8; not native call parity |
| Jitsi/LiveKit integration | Provider-specific, no direct reuse | T8; Teams signaling/media adapter |
| E2EE/files/MLS recovery/delegation (P18-P19) | Separate/provider-specific | No compatible crypto evidenced; e2ee=false |
| Admin/reports/moderation (P23) | Discover enterprise APIs/rights | T6; ordinary member not tenant admin |
| RocketVibe-owned bots/keys | Provider-specific n/a; Teams apps Discover | T6; no native-server bot endpoint reuse |
| Cache/retention/local recovery | Local | T2/T3; preserve offline data, authoritative reconciliation |
| Desktop updates/local settings | Existing local | Preserve provider independence |

Graph supplies a documented setReaction candidate; validate allowed values/rights and removal before exposing a full reaction UX. [setReaction](https://learn.microsoft.com/en-us/graph/api/chatmessage-setreaction?view=graph-rest-1.0)

Keep every limitation in the ledger. Candidate becomes done only with visible paths, persistence and failure handling on each app. Local equivalents are mapped only where they meet the same need; unintended synchronization/coverage differences are partial. If unavailable, record concrete API/tenant evidence and a useful fallback.

## 12. Delivery lots

| Lot | Deliverable and exit evidence |
|---|---|
| T0: feasibility | Application identity, accepted scopes/audiences, policy/MFA/cloud/account compatibility, routing captures, repeatable disposable-tenant procedure |
| T1: account integration | Device-code UI/resume/renew/logout on three apps; isolated identities; legacy accounts work; no RC network calls for Teams |
| T2: read model | Chats/channels, safe native formatting, author profiles, offline snapshot, paged history/thread reads, revision/scoped-ID behavior |
| T3: everyday reliability | Text/drafts/outbox, uncertain outcome policy, Trouter/reconnect, verified read state, desktop live notifications; full retained-history catch-up resolved or limitation explicit |
| T4: message parity | Edit/delete, reaction removal, mentions, replies/quotes, pins/saves/favorites with honest sync scope and room rights |
| T5: directory/media | Directory/search, presence/typing, profiles/avatar, image then generic file/voice/video, native viewing, previews/cards |
| T6: rooms/enterprise | Creation/member/role/settings/leave, shared/private channels, admin/moderation/bot rights and explicit unsupported boundaries |
| T7: push/navigation | Background push architecture, system replies, sharing, tenant-safe deep links, killed-app/account-switch/revocation tests |
| T8: calling/coverage | Calling feasibility; native calls if achievable or validated external join; E2EE limitation; final three-app parity/debt review |

Each lot adds sanitized captures and deterministic fixtures, records client/API version and account role without identity, and updates a linked execution ledger when implementation starts. Do not declare a feature ready because one HTTP request returns 2xx.

Decisions requiring concrete evidence:

- Which controlled/public-client configuration can acquire the private audiences?
- How do authz/Skype token expiry and route changes renew?
- Are snapshots complete/paged/filtered; how do shared/private channels differ?
- What revision comparator and full edit/delete reconciliation exist?
- Does clientmessageid deduplicate, for how long and in what scope?
- What are reaction removal, read-horizon ordering and reply/mention/quote write schemas?
- Which avatar/file authentication and redirects work without browser cookies?
- Can this application's own identity register background push; if not, what separate architecture meets that need?
- Can native Teams calling meet the native-module rule; what honest fallback ships?
- Which capabilities vary by tenant policy/account/cloud/channel/role?

## 13. Verification and release acceptance

### Fixture contract

Proposed fixture directories are next to future mobile/Rust Teams modules. Store logical alias, method/path/query, synthetic request, selected non-secret headers, status, sanitized response/event and evidence metadata. Replace identities consistently, preserve relationships/types/ordering, include large revisions and equal-timestamp conflicts. Redact tokens/cookies/device codes/emails/real account IDs/signed links/cursor credentials.

Record transport profile, generation, timing and policy notes without organization-wide dumps. Handwritten response examples are never live captures.

### Deterministic scenarios

1. Two tenants for one person and two users in one tenant remain isolated across tokens, databases, media, drafts, operations, links and notification replies.
2. Auth pending/expiry/cancel/decline, MFA/policy/claims/throttle and late responses handle correctly; logout cannot be undone by a late exchange.
3. Concurrent refresh persists rotation safely; audience-token failure refreshes once; network/proxy/403 retains account state.
4. Discovery/pager/media redirects never forward credentials to an unverified origin.
5. Partial snapshots, empty rosters, self/meeting/private/shared/unknown chats neither crash nor become fabricated ordinary rooms.
6. Overlapping/repeated/empty cursor pages, channel replies and duplicate message IDs across contexts keep the promised history scope.
7. Live edit/delete before old page, duplicates/equal timestamps and old-message deletion during disconnect cannot resurrect stale content.
8. Lost send response and crashes before/after acceptance/confirmation follow the declared uncertain policy without silent duplicates.
9. Read N while N+1 arrives, offline intent and two devices do not mark unseen messages read.
10. Reaction add/change/remove, permission refusal and access loss keep action state understandable without revoking unrelated credentials.
11. Image reservation/upload/send crashes do not loop allocations; generic files open for a second user and stop after access removal.
12. Compressed/plain/malformed/binary/oversized events, ACK-before-crash, registration expiry and heartbeat loss recover within bounded memory/requests.
13. Native HTML/media/avatar render safely after token renewal; no secret URLs or active markup.
14. Search/local-save scope is truthful; lost membership purges inaccessible results/media.
15. Notifications suppress self/duplicate/focused events, respect preferences, route exact identity and enqueue persistent replies.
16. Disabled capabilities hide every entry point and reject stale direct calls; RC/RocketVibe non-regression holds.

### Real-client qualification

Use a disposable organization, two ordinary members and a guest where available. Verify official Teams sees sends/replies/edits/reactions/files/read effects. Test Android, GTK and SwiftUI separately: cold start, offline resume, account switch, logout and membership removal. Mobile push needs stopped-process/locked-screen verification; foreground socket delivery is insufficient.

Follow repository validation:
- Mobile commands from apps/mobile: TypeScript, targeted pure-Node tests and a real launch. New native dependencies need local prebuild/Gradle dev-client rebuild, never EAS.
- Desktop checks/builds through apps/desktop/scripts/build.sh in Fedora; relevant smoke/e2e, FFI/Swift models and macOS compilation.
- Record installed-device, policy/cloud/account and media limitations; mocks do not prove live auth/push/media.

No Teams implementation tests were run for this docs-only change. Document validation covers links/source paths, whitespace and accidental credentials.

## 14. Independent reference material

Squads' README targets organizational accounts. Its TODO leaves uploads, additional activity/message types and calls unfinished/in progress. These are that client's limitations, not proof that Teams lacks an operation. [README](https://github.com/IanTerzo/Squads/blob/master/README.md), [TODO](https://github.com/IanTerzo/Squads/blob/master/TODO.md)

Use its auth/DTO/parser source as additional evidence with license review and a pinned revision when implementation uses it. No source was copied into this repository. Undocumented routes and public documentation must be rechecked when implementation begins.

## Sources

### Supplied archive

- teams.tar.gz, SHA-256 in section 2 and file-by-file provenance above.
- JavaScript requests/parsers, historical login marker and prior Markdown draft; no feature-response/event proof.
- Original archive/credentials are not committed. The request catalogue is sufficient to start; fresh sanitized captures are required for capability readiness.

### Repository baseline

- [Provider contract](../../apps/mobile/lib/provider.ts), [factory](../../apps/mobile/providers/index.ts), [Rocket.Chat](../../apps/mobile/providers/rocketchat/index.ts), [RocketVibe](../../apps/mobile/providers/rocketvibe/index.ts).
- [Session](../../apps/mobile/lib/auth.ts), [discovery](../../apps/mobile/lib/serverKind.ts), [secure sessions](../../apps/mobile/lib/sessionStore.ts), [lifecycle](../../apps/mobile/ui/session.tsx), [sync](../../apps/mobile/ui/sync.tsx).
- [Models](../../apps/mobile/lib/normalize.ts), [schema](../../apps/mobile/db/schema.ts), [outbox](../../apps/mobile/lib/outbox.ts), [upload queue](../../apps/mobile/lib/uploadQueue.ts).
- [Desktop session](../../apps/desktop/crates/rv-core/src/session.rs), [native selector/backend](../../apps/desktop/crates/rv-core/src/native.rs), [store](../../apps/desktop/crates/rv-core/src/store.rs), [FFI](../../apps/desktop/crates/rv-ffi/src/lib.rs).
- [GTK login](../../apps/desktop/crates/rv-gtk/src/login.rs), [Swift login model](../../apps/desktop/macos/Sources/RocketVibeKit/LoginModel.swift), [Swift login view](../../apps/desktop/macos/Sources/RocketVibe/LoginView.swift).
- [Brain](../../brain/BRAIN.md), [mobile structure](../../brain/architecture/mobile-app.md), [desktop core](../../brain/architecture/desktop-core.md), [client parity](../../brain/parity.md), [native parity](PARITY.md).

### Public sources checked on 2026-10-08

- [Microsoft device authorization](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code).
- [Graph message](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0), [send](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0), [edit](https://learn.microsoft.com/en-us/graph/api/chatmessage-update?view=graph-rest-1.0), [reaction](https://learn.microsoft.com/en-us/graph/api/chatmessage-setreaction?view=graph-rest-1.0), [notifications](https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage).
- [Squads README](https://github.com/IanTerzo/Squads/blob/master/README.md), [auth](https://github.com/IanTerzo/Squads/blob/master/src/auth.rs), [websockets](https://github.com/IanTerzo/Squads/blob/master/src/websockets.rs), [TODO](https://github.com/IanTerzo/Squads/blob/master/TODO.md).
