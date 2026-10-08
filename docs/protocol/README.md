# RocketVibe native protocol: first increment

The server is experimental. [RFC 0001](../rfcs/0001-rocketvibe-rust-server.md)
describes the destination; this contract covers only the delivered foundation, not full parity.

`crates/rv-protocol` is the source of the DTOs. Its `export-schema` binary produces
`v1.schema.json`. `scripts/generate-native-protocol.mjs` generates the bindings and the
runtime validation in the mobile TypeScript pilot. These generated files
are versioned and checked for zero diff in CI.

The [native in-room search](SEARCH.md) uses PostgreSQL, temporary results
and the existing screens; its encrypted local index remains tied to J4.

[Bot accounts](BOTS.md) act with API keys inside the scopes their owner grants,
out of encrypted rooms ([RFC 0003](../rfcs/0003-bots.md)).

[Profiles and preferences](PROFILES.md) have versioned APIs and a
local storage of protected avatars, wired into the existing screens.

The [native file lifecycle](FILES.md) provides reservation, streamed transfer,
idempotent confirmation and protected download. The SDKs are available;
outboxes and readers of the three clients remain to be wired.

The [native Markdown documents](MARKDOWN.md) are translated to the existing
renderers at the provider boundaries. The source text stays present;
this contract does not carry the Rocket.Chat `md` format.

The [native quotes contract](QUOTES.md) describes references, per-reader resolution
and delivery protections; its wiring into the existing cards
remains a distinct batch before the capability is advertised.

## Other provider research

[Slack Session mode](SLACK_SESSION.md) is a separate researched provider contract:
workspace token/cookie acquisition, cookie-authenticated RTM, HTTP/event mapping,
P01-P23 parity and [qualification probes](SLACK_SESSION_PROBES.md).
Its [evidence ledger](slack-session-evidence.json) distinguishes live observations
from source evidence and untested behaviour. No Slack driver is delivered by this
documentation, and these methods are not native RocketVibe server routes.

## Transport and identity

[Native voice](VOICE.md) gives every room a voice session over the operator's
LiveKit SFU: voice channels, calls from any room and ringing direct calls. The
server mints short join tokens and mirrors who is connected; media never crosses it.

The [temporary presence and typing contract](LIVE.md) defines the two
PUT routes, `GET /api/v1/live` and the WebSocket snapshots negotiated with `live=true`.
These snapshots modify neither the journal nor the resumption cursor.

- Discovery: `GET /.well-known/rocketvibe`, product `rocketvibe`, protocol `1`,
  persistent identity and generation, effective capabilities.
- HTTP base: `/api/v1`, UTF-8 JSON, credentials `Authorization: Bearer <token>`.
- Development listens on loopback. Use HTTPS through a proxy for a device.
- Unknown versions, types and capabilities are not assimilated to Rocket.Chat.
- RFC 3339 UTC dates; opaque IDs; positions / revisions as decimal strings.
  The `RoomPermissions` revision is an opaque token combining policy and
  membership; it is not compared like a journal position.
- Business errors: `{ code, request_id }`. No SQL text or secret in the response.
- `429` keeps this envelope and adds `Retry-After` in whole seconds.
  The native transports keep the delay (capped at 5 min) per login / ticket / snapshot family,
  without revoking the session or blocking reading or logout.
- The Rust transport keeps the identity of the refusal and its delay in the provider,
  the desktop errors and UniFFI; a locally deferred retry keeps the same request ID.

## Available routes

The [J0 parity contracts](PARITY.md), the [full backlog](PARITY.md#full-backlog)
and the [Rocket.Chat inventory](rocketchat-inventory.md) describe the following batches.
The `parity` DTOs of the schema are destination contracts and fixtures; their
presence does not declare the corresponding endpoints available.

| Method | Route | Use |
|---|---|---|
| GET | `/health/live`, `/health/ready` | State of the process and of the database |
| POST | `/auth/login` | `{ username, password }` → session, expiry, user |
| POST | `/auth/start` | Password → `AuthenticationStep`; no bearer before the factor for a protected account |
| POST | `/auth/factors/verify` | `FinishFactor` → session with durable candidate; resumption of the same validation |
| GET | `/me/factors` | Methods, version and remaining backup codes |
| GET | `/me/email` | Private verified contact, versions and context; `no-store` response |
| POST | `/me/email/verification/start`, `/me/email/verification/resume`, `/me/email/verification/confirm`, `/me/email/verification/retire` | Private verification and resumption of the original candidate; [durable SMTP queue and bounds](EMAIL.md) |
| POST | `/me/email/removal/start`, `/me/email/removal/resume`, `/me/email/removal/retire` | Conditional removal of the private contact, receipt resumption and cancellation of the original intent; available without SMTP |
| POST | `/me/factors/totp/setup`, `/me/factors/totp/enable`, `/me/factors/totp/disable` | Proven enrolment and management after recent authentication |
| POST | `/auth/invitations/accept` | `{ token, username, password }` → user; anonymous, no session or admin right |
| POST | `/auth/recovery` | `{ token, username, new_password }` → user kept; revokes the old sessions, normal login afterwards |
| POST | `/auth/logout` | Revoke this session and its WebSocket tickets |
| GET | `/me`, `/users` | Current account; instance directory limited to 100 entries |
| GET | `/me/permissions` | Effective creation and administration rights |
| GET | `/admin/overview`, `/admin/users?q=…&after=…&limit=…`, `/admin/rooms?q=…&after=…&limit=…` | [In-app administration](ADMINISTRATION.md#in-app-administration): counts / versions, accounts and rooms (opaque cursors); `users.admin` only, `no-store` |
| PATCH | `/admin/users/{id}` | `UpdateAdminUser` admin / disabled with expected revision → `AdminUser`; never my own account |
| POST | `/admin/users/{id}/delete` | `DeleteAdminUser`: tombstone, messages kept under a deleted author |
| GET | `/admin/reports/messages?after=…`, `/admin/reports/users?after=…` | Open reports grouped by target, latest first; the text each reporter saw, `author_revision` |
| POST | `/admin/reports/messages/{message}/dismiss`, `/admin/reports/messages/{message}/delete`, `/admin/reports/users/{user}/dismiss` | `{ operation_id }`; deletion only of a reported message |
| POST | `/messages/{message}/report`, `/users/{user}/report` | `ReportInput { operation_id, reason }` by a member; read access required, never oneself, 200 open at most |
| GET | `/rooms/{room}/permissions`, `/messages/{message}/permissions` | Fine-grained rights for a current member; otherwise `404` |
| GET / POST | `/rooms` | Rooms I am a member of; create `{ name, private, operation_id? }` |
| GET | `/rooms/discover?q=…&after=…`, `/rooms/public?q=…&after=…` | Names of public rooms, 20 entries, `PublicRoomPage`; identical aliases |
| POST | `/rooms/{room}/join` | Join a public room oneself; replayable |
| POST | `/direct-messages` | `{ user_id }` → unique DM for this pair |
| POST / DELETE | `/rooms/{room}/members/{user}` | Add / remove, room owner only |
| GET / PATCH | `/rooms/{room}` | Details and versioned settings; modification by the owner outside DMs |
| GET | `/rooms/{room}/members?after=…&revision=…` | Members / roles, pages of 50, current membership required |
| PUT | `/rooms/{room}/members/{user}/role` | Explicit role, expected revision and persistent operation |
| POST | `/rooms/{room}/leave` | Versioned leave outside DMs; last-owner protection |
| GET | `/rooms/{room}/commands/{operation}` | Private receipt of the author, also after leaving |
| GET | `/rooms/{room}/messages?before=…&limit=…` | Roots by descending position, keyset, limit 1-100 |
| POST | `/rooms/{room}/messages` | `{ operation_id, text, quotes?, reply_to? }` → committed message |
| POST | `/uploads` | Private reservation with persistent operation |
| GET / DELETE | `/uploads/{id}` | Private state; abandonment before confirmation |
| PUT | `/uploads/{id}/bytes` | Streamed bytes, size / SHA-256 verified |
| POST | `/uploads/{id}/complete` | Message and descriptor confirmed atomically |
| GET | `/files/{id}` | Protected streamed body; simple `Range` ranges |
| GET | `/messages/{root}/thread?before=…&limit=…` | Root and paginated replies with personal state |
| GET / POST | `/messages/{root}/replies` | Reserved parity route: same thread page; send with implicit root |
| POST | `/messages/{root}/thread/read` | Observed position, monotonic read of this thread only |
| GET | `/messages/{id}` | Current message or tombstone, for a current member |
| PATCH | `/messages/{id}` | `EditMessage` with operation and expected revision; plain Markdown |
| DELETE | `/messages/{id}` | `DeleteMessage` body with operation and expected revision; tombstone |
| PUT | `/messages/{id}/reactions` | `{ operation_id, emoji, present }` → current state of the message |
| GET | `/sync/snapshot` | Consistent view of the rooms, 50 roots and 50 recent replies per room, cursor |
| POST | `/sync/snapshots` | Materialise an immutable view; first `SnapshotPage` |
| GET | `/sync/snapshots/{token}` | Next page bound to the account; cursor only on the last one |
| GET | `/sync/changes?cursor=…` | Ordered batch, next opaque cursor, `has_more` |
| POST | `/sync/ticket` | Single-use WebSocket ticket, valid for 30 seconds |
| GET / upgrade | `/sync/socket?ticket=…&cursor=…` | Same `SyncBatch` format, replay then follow |

Account creation is a local command, not a public HTTP registration.
The [`threads`](THREADS.md) capability is enabled; `uploads`, `push`, `e2ee`, `calls` stay false. `e2ee` is true by default since 6 October 2026 ([RFC 0002, Activation](../rfcs/0002-e2ee-native.md#activation-6-october-2026)); an operator turns it off with `RV_E2EE=false`.
`reactions` advertises explicit additions / removals, available in the three clients.
`room_discovery` advertises the directory and joining; `idempotent_room_creation`
advertises the creation receipts. Their handlers are available in the three clients.
Administration rights do not give access to private conversations.
`administration` advertises the `/admin/*` routes for an account with
`manage_accounts`; `reports` lets members report a message or an account.

`fine_permissions` advertises the rights reads. The booleans describe
the account's authority; the feature capabilities must also be
available before offering an action. The presence of `edit: true` therefore does not
by itself declare an available route. The author has 15 minutes to edit,
the owner / moderator can delete and pin, and a read-only
room blocks new sends by ordinary members. Only owners
invite / remove and configure rooms outside DMs. Each mutation rechecks its
rights in the transaction. A receipt of a creation / send already committed can
still be consulted by its author as a member after restriction, with no new write.
Changes of role, room policy and account rights change their
version; a response prepared before them is revalidated and their updates
wait for the end of a delivery already authorised. No forged client authority
is accepted in the commands.

### Registration by invitation

The [P02 authentication contract](AUTHENTICATION.md) details the TOTP /
backup code routes, the operator key kept outside PostgreSQL, the quotas, resumption after a lost
response and the remaining validations. `second_factors` is additive and depends
on the key configuration; the methods come from the challenge. The server /
SDK foundation does not yet mean that the screens of the three clients are wired.

The additive capability `account_invitations` authorises the form of the native
clients. Older servers that omit it and Rocket.Chat keep their login
flow. The operator CLI issues a CSPRNG code of 32 bytes, valid 1-168 h
(7 days by default). PostgreSQL keeps its SHA-256 and the data
generation. No public registration path and no admin right entered by the client.

`POST /auth/invitations/accept` is anonymous, strict and `no-store`. It creates a
user without a session, then the client uses the normal login. Password:
at least 12 characters and at most 1,024 bytes; ASCII identifier, letters,
digits, hyphens or underscore, 1-128 bytes. The invitation binds a single UID.
A lost confirmation finds this account again with its current identifiers as long
as the code remains valid; it never creates a second account. Password
verified with Argon2, with no fast password hash. A consumption
survives the deletion of the account and does not make the code reusable.

The server rechecks generation, account state and expiry after the locks.
Invalid, expired, revoked codes or codes bound to other identifiers return
`400 invitation_rejected`; malformed inputs: `400 invalid_request`.
The persistent login quotas (global / IP / identifier) are shared
with this route, plus 10 admissions per code and minute. Argon2 shares the
four login slots, held during the computation despite a cancellation.
Revoking the code does not disable the account it has already created. The clients
verify instance / generation before and after creation / login and compare
the UID before saving the session. Code and password stay transient.

### Password recovery

`account_recovery` enables the variant of the existing login screens. The CLI
issues a 32-byte code for an account owner verified by the operator,
kept under SHA-256, bound to its UID, current authority and generation. Duration
1-24 h; 3 active codes per account, 1,000 per generation. The invitation code
cannot serve as a recovery code and vice versa.

The strict anonymous entry changes the Argon2 hash and the login authority, revokes
the devices, their sessions / tickets / receipts and the snapshot / journal resumptions.
It keeps UID, permissions, conversations and encryption data. It
returns `User` with `no-store`, then the client runs the normal login. No
independent factor is disabled and no E2EE key is recovered.

A receipt bound to the new authority allows replay for five minutes with
the new password, with no new reset and no revocation of later
sessions. The other codes are revoked. Expiry after a lock wait,
change of authority / generation, disabled account or wrong code give
`400 recovery_rejected`. Global / IP / identifier login quotas are shared,
plus 10 attempts per code and minute; same Argon2 limit with the permit kept
after cancellation. The login rechecks its hash under lock, preventing an old
password verified before the recovery from creating a session after it.

### Renewal and devices

`POST /auth/renew` takes `{operation_id,next_token}` with the current bearer.
The client produces the next secret with a CSPRNG (32 bytes, lowercase
hexadecimal) and keeps it in secure storage **before** the request. The
server stores only fingerprints, keeps the device identity,
renews the 30-day expiry and invalidates the old bearer and its tickets.
Login / renewal responses carry `Cache-Control: no-store`.

A lost confirmation is resumed with the next secret already kept, or
with the same intent for five minutes. Proposing another successor from
this consumed bearer revokes the device's family. The other devices stay
valid. Limits: 10 new renewals per device and minute, 64 active
devices per account; identical receipts do not consume the quota again.

`GET /me/sessions` exposes only the account's devices, their names, dates,
expiry and `current` indicator. `PATCH /me/sessions/{id}` renames a device;
`DELETE` revokes its family, its receipts and tickets. An identifier of another account
can neither modify nor revoke its session. No bearer or fingerprint is exposed
in the list. Revoking another device requires a login less than
15 minutes old; a rotation does not renew this age. The Rust / TypeScript
resumption primitives are wired into the existing clients: mobile SecureStore,
GTK Secret Service / Credential Manager and Swift Keychain. GTK and Swift
serialise their writes with a common empty lock file; no renewal secret
reaches SQLite. Writes already under way keep the
lock if their caller is cancelled. Login and a daily check trigger
a renewal when less than two days remain before expiry. The existing settings
of the three clients list and rename the devices and revoke another
session after a recent login. The current device uses the existing
logout flow. The activity date is updated at most once every
five minutes by authenticated traffic; this tracking skips a locked device
rather than delaying the request and does not extend the recent login.
Qualification on real systems / devices remains in P01.

### Reactions

The standard shortcodes come from the emoji-toolkit table used by the
clients. The aliases of a glyph are canonicalised, with or without `:`; raw
Unicode and unknown names are refused. The state is unique per message, account and emoji.
A receipt reuses the persisted operation without reapplying an old state: replaying
an addition after a removal returns the current message. An operation already used
with other content is refused. Current membership is required, including to
consult a receipt; read-only blocks new reactions from members.

Limits: 16 reactions per author and message, 32 groups and 256 participations
per message; 30 new message actions per account and minute, shared
with edit / delete. Existing receipts bypass this quota; `429`
provides `Retry-After`. A change increases the revision and emits an upsert without
changing the creation position or the edit marker. Deleting the
message erases the participations and replaces its old events with the tombstone.

### Personal pins and stars

`PUT /messages/{id}/pin` and `/star` take `{operation_id,present}`.
An owner or moderator pins; each member can star for themselves,
including in read-only rooms. New states of a deleted message are refused.
The receipts return the current state without replaying an old intent. The action
quota is shared with reactions, edits and deletions.

`pinned` belongs to the public revision of the message. `personal_star` contains
only the state of the reading account and its own decimal revision; public
events omit this field. A star change publishes an event reserved for
its owner without changing the public revision or the edit marker.
Deletion erases the stars and pins, as well as their old events.

`GET /rooms/{id}/pins` and `/stars` use `limit` (1-100) and `before`, exclusive
creation position, with `has_more`. The stars of another account are excluded.
The clients validate all pages before projecting the result; they refuse
non-decreasing positions and messages from another room.

### Edit and delete

Editing currently accepts `MessageContent.plain` with Markdown and empty lists
of mentions / quotes / files. Other content is refused as
unavailable. The author edits for 15 minutes if they can send; the author within
this delay or the owner / moderator deletes. Editing someone else's message is not
granted by room ownership. `409 revision_conflict` distinguishes a concurrent
state from `409 operation_conflict`, which signals a reused identity.

An applied receipt is replayed without new publication and returns the current state,
including a tombstone after deletion. It stays bound to the account and to the complete
command. Creation, send and actions cannot reuse an identity among themselves.
The initial send keeps its fingerprint even after an edit; its replay restores
neither the old text nor a deleted message. Action receipts keep fingerprints,
no text. These fingerprints serve to compare the commands.

`Message.deleted: true` carries an empty text; `edited_at` marks an edit.
These fields are additive in v1 and the broadcast keeps `message_upsert`. The creation
position does not change, the revision advances. Recent clients hide the
tombstone but keep its revision to refuse old responses. On
a reset, they replace the confirmed history with the snapshot window,
keep drafts / outbox of the rooms present and reject responses
started before this projection. Earlier history is reloaded by pagination.
This step delivers transport and event integration; the persistent commands
and action menus of the three clients are the next batch.

The mutation changes the room's authority version, waits for its deliveries and
invalidates the materialised views of its participants. A build in progress
is found by its account even if its room IDs are not yet published.
Deletion reserves the message and erases the earlier payloads of the active
journal. Handling of backup retention belongs to J5.

### Room creation and discovery

Recent clients record the creation identity in SQLite before the
request. An interrupted form resumes the same identity and the same name / kind
after retry or restart; they do not automatically launch another creation.
After the result is received, the form is finished; a later creation
is a new intent. An older native server still receives `{name,private}`.

The PostgreSQL receipts are bound to the account and persistent. A replay returns the same
room without extra event, after verification of its membership; an
identity used with another name / kind or a send operation produces
`409 operation_conflict`. `operation_id` remains optional for the old v1
clients, which therefore lack this creation guarantee. The name is normalised by `trim`.

The directory exposes only public metadata, searches a literal
substring with no wildcard and uses the ID of the last result as `after`. It gives
access neither to messages nor to the memberships of other accounts. Each delivery
holds the public rooms and rechecks their name / revision / visibility; a
visibility that has become private invalidates a prepared response. Joining targets only
the actor, keeps an existing role and publishes a `room_upsert` with a new
revision for the current members. Private rooms, DMs and absent IDs return
the same `404`. The [P04 details / roles and settings](ROOMS.md) describe the
versioned commands, the receipts and the protection of the last owner.

## Guarantees of the increment

A send intent keeps `operation_id`. Same intent → same message; same
ID with another text / room → `409 operation_conflict`. The HTTP confirmation and
the event come from the same transaction. Send operations are kept
with the messages; tombstones and receipts continue to reserve their identifiers.

The sequencer is transactional. The broadcast rereads the PostgreSQL journal; it
may replay batches. The client integrator must apply the batch and its cursor
in a single local transaction before resuming at this cursor.

Cursors are random and bound to the account / generation. A cursor of another
account, of another generation, expired (7 days without renewal) or pruned
(512 cursors maximum per account) produces `409 sync_reset_required`. They do not reveal
the global positions of inaccessible events. A membership deletion
produces `room_removed` for its former member; replay and history filter the
messages with the present rights. After logout the socket is closed at the next tick.

### Revocation during a delivery

A read captures the opaque version of each membership and the generation before
building its result. Just before delivery, the server rechecks these
versions, the account and the session, then keeps PostgreSQL locks on these
rows. A removal / role change, logout, disabled account or restore
waits for the end of this authorised delivery; a removal followed by re-join does not
validate a response prepared with the old authorisation.
An account activation also carries an opaque version. The write
transactions hold and recheck account / session until the commit; an actor
authenticated before a logout or a deactivation cannot publish afterwards.
Cursor management has its separate lock: a write waiting for the
sequencer does not block the reading of the last committed watermark.

JSON responses hand a single body to the HTTP transport under this lock; the
socket keeps its lock until the end of the frame send. An
abandoned response releases the lock. An unconsumed HTTP body expires after 5 seconds
and can no longer produce content; the WebSocket send keeps its 5 s delay.
The locks are in the database, including between two server processes. The sequencer
increments remain compatible with the generation lock.

A race detected before HTTP delivery gives `409 delivery_revalidate`; the client
resumes with its local intents kept. The socket rereads the journal from
its last sent cursor. The minimal `room_removed` event passes without exposing
the room; no payload follows it on this connection until a new
membership is granted. Another authorised room continues on the same socket.
The materialised views also hold their validity row during delivery.

These guarantees concern authorisation and the order of server emission. Bytes
already handed to the transport may be buffered and arrive later on another
network / another connection; no mechanism erases them on a device.
Any future history, search or files endpoint must use this same
barrier, with its own bounded transfer for objects.

An idle socket receives at least every 15 seconds an empty `SyncBatch`,
with its current cursor and `has_more: false`. The mobile pilot closes and resumes
a connection that has received no frame for more than 45 seconds.

### Materialised snapshots

The additive capability `snapshot_paging` advertises the two new routes. The
mobile and desktop clients use it when present and keep the historical
route for earlier v1 servers. `snapshot_id` and `page_index`
identify a view captured in a single PostgreSQL repeatable read transaction.
The pages are immutable: an arrival during the download will be replayed after
the final cursor. No cursor is published on an intermediate page.

A view contains at most 1,000 rooms, 50 roots and 50 recent replies per room, 1 MiB of JSON
per page and 64 MiB in total. It expires 5 minutes after reservation; 4 views per
account and 16 in the instance, concurrent admissions serialised in the database. Refusal
`429 snapshot_busy` with a 30 s delay or `409 snapshot_limit`; a materialisation
failure cancels its pages and returns its reservation. A build
cancelled with no result stays bounded by these quotas until expiry.

Each page rechecks account, generation and memberships. A removal invalidates all
the account's views in the revocation transaction; a new membership does not
reactivate any old token. Expiry, restore or removal give
`409 sync_reset_required`. Cleanup deletes 8 stale views per pass and
cascades to their pages, without purging the journal or the messages.

The clients verify identity, order, duplicates, references, size, local tokens
and presence of the final cursor alone before atomically replacing their cache.
They bound assembly to 128 pages / 64 MiB / 5 minutes. Rust also bounds
the bytes received before decoding, including a chunked response; the mobile fetch
buffers its native body then checks the size before parsing, and interrupts as soon as
a Content-Length is too large. Memory qualification on Android remains open.

## Known limits

- The [mobile](../NATIVE_MOBILE_PILOT.md) and the [GTK / SwiftUI](../NATIVE_DESKTOP_PILOT.md) clients
  use their existing screens for both providers. Manual trials
  on devices remain open.
- Historical non-paginated snapshot route: maximum 100 rooms (explicit refusal beyond) and 50 roots / 50 recent
  replies per room; maximum JSON size 8 MiB, refusal `409 snapshot_limit` with no
  cursor creation or partial response. The other messages are loaded through
  history. The current clients use the materialised pages described above.
- HTTP / WebSocket batches: maximum 100 events scanned and 1 MiB of JSON. The
  cursor does not advance beyond an event delivered in the next batch.
- Tickets valid for 30 s, maximum 4 unconsumed per session. Startup and a
  pass every minute clean up expired sessions, tickets, cursors
  and quotas in batches of 1,000, without waiting for locked rows. The journal is kept.
- Sessions valid for 30 days and renewable; 2FA not delivered. The concurrency of
  Argon2 computations stays bounded to 4 per process after HTTP cancellation. Login:
  10 attempts per username, 30 per TCP IP and 120 in total per 60 s window, in the database
  and kept after restart; `429 auth_busy` / `auth_rate_limited` with delay.
  No proxy header is accepted as proof of IP; behind a proxy,
  its clients share the quota. Configuration of trusted proxies remains open.
- WebSocket tracking polls the journal every 250 ms and closes the clients
  whose send / close exceeds 5 s. Limit of 128 sockets per process,
  4 per session; `429 socket_limit` with delay as soon as the ticket is requested, then
  a new check at upgrade for concurrent races. Heartbeats are
  present; load and multi-process deployments remain to be qualified.
- The delivery barrier and the HTTP / WebSocket revocations are tested in
  PostgreSQL; load, devices and the remaining functions of the RFC
  must still be qualified before replacing a Rocket.Chat instance.
- Edits / deletions available in the existing clients, with
  SQLite intents and expected revisions. The unread counters and the rest
  of the matrix remain open. Creation is idempotent on the recent clients.

These limits bound the pilot; they do not reduce the scope of the RFC.
