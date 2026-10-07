# Parity contract and J0 backlog

Reference: [RFC 0001](../rfcs/0001-rocketvibe-rust-server.md), notably §4,
§7-14 and §17. The identifiers P01-P23 cover **every** row of its matrix.
This document fixes the construction decisions of 1 October 2026. It does not
declare the planned functions available, nor an instance fit for the switchover.

## Verifiable inventory

[Generated inventory](rocketchat-inventory.md), [JSON version](rocketchat-inventory.json).
`node scripts/inventory-rocketchat.mjs --check` fails the CI if the sources
and the survey diverge. The scan covers the mobile production files,
drivers, generated native modules, Rust core, GTK, bindings and SwiftUI. It excludes
tests, dependencies, build outputs and generated types of the native protocol.
Literals, stream declarations, resources and call sites are listed
separately; their number is not a number of distinct requests.

The TypeScript parser also reads generic and multi-line calls. For Rust
and Swift, the lexical scan is completed by the review of the transports and dynamic
parameters below. The plugin's Kotlin templates are included; some
references in their comments are also present. The Swift rendering chain
makes no REST call of its own: it goes through `rv-ffi`; its avatar paths
are nevertheless listed.

| Dynamic argument / transport | Reviewed resolution | Batch |
|---|---|---|
| Mobile `historyPath(type)` / Rust `history_endpoint(kind)` | `channels.history`, `groups.history`, `im.history` | P06 |
| Mobile `ActionsRC.list(path)` / Rust `actions::marked(endpoint)` | `chat.getPinnedMessages`, `chat.getStarredMessages` | P10 |
| Star choice | `chat.starMessage`, `chat.unStarMessage` | P10 |
| Upload of an outbox row | `rooms.media/{rid}`, `rooms.mediaConfirm/{rid}/{fileId}` | P14 |
| Multipart avatar / removal | `users.setAvatar`, `users.resetAvatar` | P16 |
| Mobile `expoTransport`, Rust `RestClient::upload` | Two multipart transports; their callers supply the paths above | P14 / P16 |
| Mobile `protectedFileUrl`, Rust `fetch_protected` / `MediaClient::fetch` | Resources `title_link`, `image_url`, `audio_url`, `video_url`; origin verified before credentials | P14 |
| DDP `subscribe(name, key)` | `stream-room-messages`, `stream-notify-user`, `stream-notify-room`, `stream-notify-logged`; keys built inside the driver | P06 / P12 / P16 |
| DDP handshake | `connect`, `login` with resume, `sub`, `unsub`, ping/pong; no business method | P01 / P06 |
| Android Kotlin push | Rocket.Chat: `push.get` / `chat.sendMessage`. RocketVibe: family registry, private fetch, WorkManager and idempotent reply in the existing plugin; Firebase / phone to be qualified | [P17](PUSH.md) |
| Current iOS extension | `GET push.get`; kept on the RC side, native iOS out of RFC scope | P17 |
| Links / quotes | `channel`, `group`, `direct` with `?msg=`, app links `rocketvibe://room/…` | P07 / P21 |

The secondary reads remain in some RC screens. Moving them is
mandatory in the batches concerned. The guard RC transport already rejects the
requests of a native session; no RC-compatible route is added to the server.

## Schemas and availability

The DTOs of [rv-protocol/parity.rs](../../crates/rv-protocol/src/parity.rs) are
part of the [v1 schema](v1.schema.json). Rust and the TypeScript decoder run
the same [fixture](v1.fixture.json), notably with positions above
`2^53`. The root `Contract.parity` is used to export the schemas and test the
fixtures: no HTTP endpoint returns this artificial root.

The added capability fields are additive. An absent field means false. Mobile
and the desktop core intersect the server announcement with the functions actually
implemented in the client; SwiftUI receives the stable list through UniFFI, GTK
consults the same core. Rights remain a server decision per transaction.
A true capability is not enough to authorize an account to invite, edit or read.

The [custom emoji catalog](CUSTOM_EMOJIS.md) provides names, aliases and
protected images to the existing mobile / GTK / SwiftUI components. Reactions
keep their canonical name and their intent when the catalog changes.
The caches are versioned and bound to the generation; installed qualification
and animated desktop rendering remain open in P07 / J3.

Mobile `Provider.identity` exposes kind, origin, account and, for RocketVibe,
instance / generation. Desktop keeps the same data in `SessionInfo`.
The neutral mobile diagnostics keep code, native request ID, status and delay;
only an understood refusal of an authenticated request indicates a rejected session.
A 2FA challenge stays distinct. The desktop core keeps its structured errors;
`request_id` and the server delay also cross the desktop /
UniFFI diagnostics and errors; a deferred retry keeps the identity of the server refusal.

### Rights and reads

Room roles: owner, moderator, member. Permissions are precise
booleans associated with the room / message and its revision. They serve
rendering and are never accepted in a client command. Instance administration
gives no implicit access to a private room or to an E2EE key.
Inviting, removing, pinning, changing settings and editing others are distinct.
Initial choice: room creation by any authenticated account, private invitation by the
owner. The first J2 batch exposes the rights reads, the
owner / moderator / member roles and the transactional application of read-only
mode and creation restrictions. The settings, roles and
leave commands are available on the server / transports side: [P04 contract](ROOMS.md).
The durable reads and commands are wired to the existing cards of the
three clients. The composers use the effective write right, cached
by room generation / version and always enforced by the server.

`ReadState` separates root / reply positions and counters. Only new
visible messages from other authors increase the unread counts; edits, reactions,
system messages and own sends do not. A reply increases the
thread counter and `unread_replies`, without adding a fictitious root. The existing
badges show roots + replies; named mention and `@all` / `@here`
are separate and counted once per message. A read advances by transactional
maximum of positions across two devices; deletion or removal decreases
the counters without changing the read position. The favorite is personal.

The first batch [P05](READ_STATE.md) delivers the personal states of the roots,
monotonic reads and favorites with receipts on the server / transports side. Named
mentions and `@all` are resolved at send time; the SQLite queues and network
resumptions of both clients are delivered. Favorites are wired to the existing GTK,
SwiftUI and mobile cards / menus, with confirmed state and resumption of the original
request. Confirmed badges, separators at the captured position and timers
receiving the visible ID / opening membership are wired in the three
interfaces. `read_markers` is enabled, with no read of a last message from the
cache during a retry. Trials on installed applications remain open;
replies are reserved to P11 and `@here` to the P12 leases.

By default, a membership gives access to the entire history of the room. This choice is
announced to the owner when inviting; a "since membership" setting
then requires its durable bound and its tests on all reads. Neither this
setting nor membership automatically distributes the historical E2EE keys.

Edit: expected revision and persistent operation; proposed initial delay of
15 minutes for the author, configurable. Deletion: tombstone and durable
ID reservation. Reactions / favorites / pins are explicit
`present` states, never toggles. Message favorites are broadcast only to
their owner. Commands reject unknown fields and forged rights.

Reactions are implemented on the server, GTK, SwiftUI and mobile in the
existing interfaces. Aliases are shared and operations kept
in SQLite before sending; a resumption keeps its identity even after reception
of the journal. A different action waits for the resolution of the intent in progress
for this message. PostgreSQL / WebSocket tests and on-disk SQLite cover
lost response, alias, removal, old receipt, quotas, rights, deletion and resumption.
The GTK flow under Xvfb verifies the chips; the Swift models consume
the real bindings and secure storage. Trials on devices remain open.

### Pins and stars

Pins and stars are wired to the existing menus and marked lists of the
three clients. Operations keep their identity after a restart.
Pins require an owner or moderator; a star remains personal,
including in read-only mode. Its independent revision prevents a public event
from erasing it and an old private event from restoring a deleted message.
Lists are paginated by creation position; an inconsistent page does not modify
the cache. The PostgreSQL / SQLite flows and Swift models are verifiable
on the throwaway bench; trials on devices remain an external condition.

### Content, files and keys

`MessageContent` distinguishes cleartext Markdown and encrypted envelope. Mentions and
quotes are typed references; a quote does not bypass the rights
of the source room. Authorizations / excerpts are computed at read time.
An encrypted quote stays in the ciphertext; no cleartext excerpt is
accepted alongside it. `FileDescriptor` contains protected ID, decimal size, fingerprint
and type; no third-party URL to authenticate. The name of an encrypted file is absent.

Upload preparation and confirmation carry a persistent identity. The same
confirmation gives the same message; a lost result can be looked up. The bytes
are finalized before the SQL commit, then reconciled with the orphans. The
[cleartext lifecycle](FILES.md) is delivered on the server / SDK side; outboxes and players
of the apps remain to be wired before their activation.

The key contracts contain only public keys, encrypted backups and
envelopes for named recipients. Their `format` is opaque in J0. The historical salt /
UID and the KDF parameters have their own fields. **The crypto protocol
and its guarantees are not defined by these DTOs**: J4 requires a separate
specification and a review, before announcing E2EE. No fixture format
is usable for encrypting. No secret / ciphertext implements `Debug`.

### Routes frozen for the following batches

All are relative to `/api/v1`; only those of the [README](README.md) are
available. Conditional inputs and quotas will be validated by the domain.

| Batch | Reserved routes |
|---|---|
| Auth | `POST /auth/challenges/{id}/verify`, `/auth/challenges/{id}/email`, `/auth/refresh`, `/auth/recovery`; `GET/DELETE /sessions/{id}` |
| Rights / profiles | `GET /me/permissions`, `/rooms/{id}/permissions`, `/users/{id}`; `PATCH /me`, `/me/preferences`, `/rooms/{id}` |
| Rooms | `GET /rooms/discover`, `POST /rooms/{id}/join`, `GET /rooms/{id}/members`; `PUT/DELETE /rooms/{id}/favorite` |
| Messages | `GET/PATCH/DELETE /messages/{id}`, `GET/POST /messages/{id}/replies`, `GET /rooms/{id}/search` |
| Actions | `PUT/DELETE /messages/{id}/reactions/{emoji}`, `/messages/{id}/pin`, `/messages/{id}/star`; `GET /rooms/{id}/pins`, `/rooms/{id}/stars` |
| Read / states | `PUT /rooms/{id}/read`, `/rooms/{id}/typing`, `/me/presence` |
| Files | `POST /uploads`, `PUT /uploads/{id}/bytes`, `POST /uploads/{id}/complete`, `DELETE /uploads/{id}`, `GET /files/{id}` |
| Push / rendering | `PUT/DELETE /devices/{id}`, `GET /notifications/{id}`, `/emoji` |
| Keys / calls | Prefixes `/e2ee` and `/calls`, details in their dedicated specifications |

Errors have a stable code and request ID. `401 session_rejected` revokes an
authenticated session; business refusal `403`, diverging revision `409 revision_conflict`,
diverging identity `409 operation_conflict`, stale cursor `409 sync_reset_required`,
quota `429` with `Retry-After`. An unknown mandatory event blocks the advance
of the cursor. The bounded structured conflict details will be added with J2.

## Rendering corpus

[Common fixture](rendering.fixture.json): Unicode, nested styles, code,
quotes, lists, heading, mentions, links, standard / custom emojis, literal HTML,
masked permalink and photos / documents / voice notes / videos / quoted files.
It goes through the mobile parser / preview, the GTK renderer and the UniFFI projection
into styled runs used by SwiftUI. A corrupted `md` JSON must keep the text.
The quote preview can take the thumbnail; the viewer takes the full image
file. These two references are explicitly tested in the fixture.
The native file manifests are translated to these presentation models.
These rendering tests do not replace the visual trials on devices (§17).

## Full backlog

"Foundation" means a delivered part, not the exit of the milestone. Each box stays
open as long as the server, the clients concerned and the parity scenario are missing.

| ID / RFC §4 | Batch | State and next exit condition |
|---|---|---|
| P01 Discovery / accounts / sessions | J1-J2 | Secure rotation / resumption, devices, sign-up by invitation, operator / email recovery delivered in the three existing clients; qualification of devices / keyrings to continue |
| P02 2FA | J2 | TOTP / backup codes, reauthentication, verified address / removal, OTP challenges, email factor and email recovery delivered in the 3 clients; qualification on devices and external SMTP to continue |
| P03 Multi-server | J1 | Isolation delivered; validation of devices / links and generations after restore |
| P04 Rooms / DMs | J1-J2 | DMs / members, idempotent creation, discovery / join, details and durable commands for settings / roles / leave in the 3 existing cards, effective write rights in the composers delivered; qualification of installed applications open |
| P05 Favorites / unread / mentions | J2 | Personal states, monotonic reads, named mentions / @all and favorites with receipts delivered; SQLite queues, resumptions and open buffers bound to the membership delivered; favorites, confirmed badges, separators and visible-ID timers wired in the 3 interfaces; qualification of installed applications open; replies P11 and @here P12 |
| P06 History / real time | J1-J2 | Foundation, materialized snapshots and revocation barrier delivered; tombstones / actions J2 |
| P07 Markdown / emojis / quotes | J2-J3 | Native documents and common corpus adapted to the existing renderers; references, excerpts and authorized files wired to the cards, caches and reply controls of the 3 clients; unavailable label, preview purge and durable intents delivered; quotes on two levels with independent access to each source, GTK flows / Swift models and mobile provider against PostgreSQL verified; structured and translated room activities delivered; [custom catalog](CUSTOM_EMOJIS.md), versioned caches and protected readers wired to the existing pickers, completions, messages and reactions; installed qualification and desktop animation open |
| P08 Send / drafts | J1 | Foundation delivered; real crash after commit / lost response, Android ↔ Windows |
| P09 Edit / delete | J2 | API, rights / delays, tombstones, SQLite intents and menus / editors of the 3 clients delivered; device flows to be qualified |
| P10 Reactions / pins / stars | J2 | Idempotent API, aliases, pins, private stars, SQLite intents and existing menus / lists of the 3 clients delivered; device qualification to continue |
| P11 Threads | J2 | API, separate roots / replies, counters, per-thread reads and durable drafts / outbox wired to the existing GTK / SwiftUI / mobile thread screens; quotes in a thread, replay after root deletion and membership purge covered; [contract](THREADS.md), installed qualification open |
| P12 Presence / typing | J2 | Per-device leases, WebSocket photos separate from the journal, expiry and emission / listening wired to the existing composers and indicators; @here resolved at send time; [contract](LIVE.md), installed qualification open |
| P13 Search | J2 / J4 | Authorized PG search, bounded pages, edit / deletion and temporary results wired to the existing screens; [contract](SEARCH.md). Local index of encrypted content and purge on lock still open with J4; installed qualification open |
| P14 Photos / documents / videos / voice notes | J3 | Server / SDK lifecycle delivered; persistent intents, resume / abandon, private cache, quoted files and existing mobile / GTK / SwiftUI components wired; [contract](FILES.md). Core bench and GTK composer / Swift models against PostgreSQL; mobile module to rebuild, codecs and installed qualification open, encrypted J4 |
| P15 Links / cards | J3 | [Previews](LINK_PREVIEWS.md) and [integration cards](INTEGRATION_CARDS.md) wired to the three clients: bounded collection / pinned DNS, leases, private images, revocable cache, search and viewers; bounded structured cards with replay, rights and search index; capabilities enabled, macOS of the desktop reader validated, HTTP / WebSocket / SQLite benches and GTK widget; macOS CI of the integration batch and installed qualification open, encrypted J4 |
| P16 Profiles / settings | J2-J3 | API, durable volume, receipts, public cards and personal forms of the three existing interfaces wired; status, bio, language, notifications, protected avatars, persistent intents, proof / abandon and DMs by UID; names / photos of the desktop lists and headers wired; [contract](PROFILES.md). macOS compilation validated in CI; installed qualification to complete |
| P17 Push / notifications | J3 | Durable tasks, FCM and Kotlin, navigation / idempotent reply; desktop flow wired to the existing GTK / SwiftUI notifications, private mentions captured, preferences and send queue; [contract](PUSH.md). Phone with stopped app, installed system notifications and P21 cold start still open |
| P18 Existing E2EE | J4-J5 | Opaque import / historical parameters, read / send from a blank cache |
| P19 Standalone E2EE | J4 | [RFC 0002](../rfcs/0002-e2ee-native.md): common Rust MLS engine, protected vault / checkpoint, identities / pins / association, server directory, transitions / opaque delivery / intent settlement, renewal / rotation / readmission and signed removal wired to the existing GTK / SwiftUI / Android settings and conversations. Text, threads, quotes / mixed composition, backup and recovery of the HTTP / UI root are implemented. Real Secret Service / Android Keystore, two ABIs, Swift models and macOS build pass in CI for these batches. [Local archive](E2EE_ARCHIVE.md): immutable blocks, observations and verified-page indexes wired to the projections, roots / counters and resumption after the cache is forgotten; 70 / 130 real MLS messages with synthetic receipts verified. No production E2EE capability enabled. Remaining: automatic eviction / sources outside the cache / operation registry / load, keys and transport for historical recovery, private actions / search / files, destruction of old keys / copies, control delegation, full installed flows / Windows ACL / power cut and independent review |
| P20 Jitsi | J4 | **Retired 2026-10-06, replaced by [native voice](VOICE.md).** [Native meetings](MEETINGS.md) and Rust / TypeScript transports: idempotent start, room activity, rights / membership / epoch, short conference JWTs, tokenless link and closing delivered; buttons / profiles / cards / windows of GTK and SwiftUI, existing mobile screen wired, durable start intents and outdated responses rejected; mobile HTTP / WebSocket / SQLite resumption after a lost confirmation verified; trial of service / media / moderation / revocation and devices still open |
| P21 Sharing / deep links | J3 / J5 | [Native links](ROOM_LINKS.md) by complete service / instance / epoch, unambiguous choice, message / thread and copy in the existing menus; decimal positions. Persistent desktop registry, resumption of the recipient account, private validation and idempotent reply; replies kept before HTTP, resumption / concurrency and proof after a lost confirmation verified. Persistent offline click before resumption, reservation / acknowledgement of the last ID, private validation and cancellation by explicit navigation wired to GTK / SwiftUI; reopening, 503, refusals and outdated results verified. GNOME / Windows click and SwiftUI callback wired; Windows COM reply activator and dispatch between real processes verified. Cold Linux reply via portal v2 announcing its support and GLib ≥ 2.86 wired; in-flight replacement / removal and GTK reactivation between real processes verified. Old KDE backend limited to the reply with an active process. Installed qualification and imported old permalinks still open |
| P22 Languages / ergonomics / updates | Cross-cutting | UI kept; translations of the new codes and non-regression of the 3 platforms |
| P23 Administration | J2 / J5 | Bootstrap, invitations / recovery, CLI for accounts / rights / deactivation, rooms / members / settings, receipts, audit and diagnostics wired; creation / membership in the P04 apps; [in-app administration](ADMINISTRATION.md#in-app-administration) API (overview, accounts with tombstone deletion, rooms, reports and moderation) and member reports with Rust / TypeScript transports; [contract](ADMINISTRATION.md). Import / restore and J5 operations, installed qualification open |

Execution order: remaining J1 guarantees, then P01/P02/P04/P05/P09-P13/P16/P23
for J2, J3, J4, J5. Validations requiring an external resource are recorded
and do not prevent independent work on the following batches. The matrix remains
mandatory before declaring the RFC complete.

## Construction assumptions and external validations

Without soliciting the user during the work, we adopt an **initial bench**
of 100 accounts, 50 simultaneously connected devices, 100 rooms per account and
1 million cleartext messages; proposed reference host: 2 vCPU / 4 GiB,
PostgreSQL and local files. These are measurement targets to be published, not
promised capacities. Current limits: materialized snapshot 64 MiB / pages 1 MiB,
old route 8 MiB, batches 1 MiB, 128 sockets
per process. Proposed files: 100 MiB per object, initial quota 50 GiB to be
configured; do not announce these limits before their effective enforcement.

Public sign-up disabled, operator invitation, basic profiles accessible
to authenticated accounts, private email. Session age / 2FA required for
sensitive changes. The Rocket.Chat driver is kept throughout all milestones and
no automatic deletion at switchover; v1 protocol evolves additively.
Capture in maintenance is the first consistent backup; proposed rehearsal
objective RPO 24 h / RTO 1 h, to be measured before any operations commitment.

The following facts cannot be deduced from the repository: rights and exact format
of the source export, available historical keys, hosting machine, SMTP /
Firebase / Jitsi credentials, operations owner, actual archive period,
acceptance of the loss / restore duration. They remain conditions of J4/J5,
without blocking the implementation. No private import or freezing of the source will be done
on the basis of an assumption. The independent crypto review and the physical
Android phone are also external validations, not tests that can be simulated in CI.
