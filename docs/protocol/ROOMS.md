# Room information, members and settings (P04)

The server and the Rust / TypeScript transports expose these v1 routes. The existing
mobile, GTK and SwiftUI room sheets read their information from the chosen
provider. The Rust and mobile controllers save commands before HTTP and
resume their personal receipt after an interruption. The three sheets
offer the settings, the member list, roles and leaving according to the
provider's capabilities and the current rights. The existing Rocket.Chat
journeys remain selected by their provider.

## Reads

`GET /rooms/{id}` returns `RoomDetails`: base room, opaque revision of the
details, topic, description, announcement, read-only, member count and effective
rights of the reader. `GET /rooms/{id}/members` returns `RoomMemberPage`: public
accounts, role and deactivation flag. No email or secret is exposed.
Both reads require a current membership, including for the instance
administrator; a missing or inaccessible room returns `404 not_found`.

The member list is ordered by ID, in pages of 50. `next` becomes the
`after` parameter of the next page, together with the same `revision`. A
change of settings or membership produces `409 revision_conflict`: the
client restarts the list instead of assembling two versions. A leave followed by
re-membership, or a role changed then restored, also change the revision.

This revision follows the settings and the composition / roles of the room;
it does not freeze users' public profiles. Messages do not
modify it. The journal revision `Room.revision` remains a decimal position
and is published in `room_upsert` after a change, including invitation,
removal and public membership. Clients can then invalidate their details.

The reads recheck identity, session, membership, authority and revision of the
details before delivering the HTTP body. The PostgreSQL locks stay held
until its submission, with the time limit of the other reads. A payload
prepared before a revocation or a revision change is not delivered.

## Commands

| Route | Body | Right |
|---|---|---|
| `PATCH /rooms/{id}` | `UpdateRoom` | Owner, non-DM |
| `PUT /rooms/{id}/members/{user}/role` | `ChangeRoomRole` | Owner, target is an active member, non-DM |
| `POST /rooms/{id}/leave` | `LeaveRoom` | Current member, non-DM |
| `GET /rooms/{id}/commands/{operation}` | None | Authenticated author of the receipt |

Each command contains an original `operation_id` and `expected_revision`,
the details revision read by the form. Unknown fields, actor identities
and rights supplied by the client are refused. Rights are recomputed
under lock: an obsolete UI grants nothing.

`UpdateRoom` supplies all the settings: `name`, `private`, `topic`,
`description`, `announcement`, `read_only`. The name is normalized by `trim`,
non-empty, without control characters and limited to 128 UTF-8 bytes. The topic is
limited to 1,024 bytes; description and announcement to 4,096 each. NUL is refused.
A public / private conversion keeps the current members. Read-only
still lets owners / moderators write. A DM cannot be
converted, configured, left nor receive a role transfer through these routes.

Several owners are possible. To transfer responsibility,
promote a member to owner, reread the details, then demote
the former owner or have them leave. The last ownership cannot be
removed: `409 last_room_owner`. Concurrent commands are serialized
on the room and refuse revisions that have become obsolete.

## Lost responses and limits

SQLite keeps at most one unresolved intent per room: closed body,
original identifier, form revision and pending / definitive failure state.
An identical form reuses the original candidate, even after receiving
a more recent revision. A different form stays blocked; only a definitive
failure can be explicitly erased and then replaced. An interruption or
a rate limit keeps the candidate for the retry with backoff.

Each attempt first rereads the personal receipt. Only `404 not_found` authorizes
sending the saved body; any other response is not interpreted as an
absence of the command. A valid receipt erases exactly its intent, without
projecting old settings. Commands share the session's mutation queue.
Identity / generation and lifetime are rechecked; a removal
from the room purges its private forms and a re-membership does not resurrect them.

A successful command returns `RoomCommandReceipt`, limited to `operation_id`,
`room_id`, `applied_revision`. The PostgreSQL receipt is bound to the account and keeps
a fingerprint of the command, without the text of the settings or the member list.
The same ID / body returns the original receipt, even after the author has left
or been demoted. This never restores a membership, a role or an old setting.
A different body or room for this ID produces `409 operation_conflict`.
The private receipt remains consultable after the right on the room is lost. It gives
no access to the current details nor to the receipt of another account.

The IDs share the existing space of sends, room creations and message
actions. An ID already used in another domain is refused. A modification
cancels the materialized or in-construction snapshots concerned and publishes the
updated room. A leave also adds `room_removed` for its author.

The limit is 30 new successful commands per minute and per account.
A `429 room_command_limit` includes `Retry-After`. Reads and receipts
remain accessible; a receipt already recorded does not consume this quota.
Both transports apply the same `room_command` budget to new
mutations and let reads / receipts through during the delay.

The forms keep the displayed revision and save their intent
before HTTP. A lost response allows resuming the original command; a
definitive refusal offers its explicit erasure. Rereading a refused
form checks the current rights before preparing a new command. The
last owner receives an explanation inviting them to promote another member.
The GTK dialogs and the Swift / mobile views discard results after closing,
removal from the room or change of generation. No command identifier is
displayed.

## Composer and effective rights

The three existing composers use `permissions.send`. Read-only
on the room therefore still lets owners and moderators write; a member sees the
existing read-only message. The information sheet keeps the real global
`read_only` setting, distinct from this effective right.

SQLite keeps these indications per account, generation and `Room.revision`.
A different revision invalidates them; opening the room and version
changes reread the rights. Concurrent reads are grouped. An
old HTTP response, a removal / re-membership or a replaced generation cannot
restore the previous indication. A consistent cache remains available
offline; the server still authorizes each send and the existing send queue
keeps its intents. Trials of the installed Android / Windows / macOS
applications remain a separate qualification.
