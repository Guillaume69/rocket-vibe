# Native files (P14 / J3)

The server and the Rust / TypeScript transports have the cleartext file
lifecycle. `uploads` is announced when the object volume is present. Clients
cross-check this announcement with their own capabilities: outboxes, protected caches,
attachments and players. Mobile now uses its existing queue and components;
its button also requires the native transfer module. GTK / SwiftUI
remain to be wired. Qualification on devices remains open.

## Reservation, bytes and message

All routes require `Authorization: Bearer …` and stay on the pinned origin.
No third-party URL or credential in the query is accepted.

| Method | Route under `/api/v1` | Result |
|---|---|---|
| POST | `/uploads` | `PrepareUpload` → `Upload` reservation |
| GET | `/uploads/{id}` | Private state of the reservation |
| PUT | `/uploads/{id}/bytes` | Binary body → state `ready` |
| POST | `/uploads/{id}/complete` | `CompleteUpload` → confirmed message |
| DELETE | `/uploads/{id}` | Abandon before confirmation |
| GET | `/files/{id}` | Protected bytes of the confirmed file |

`PrepareUpload` carries a persistent operation, room, decimal size,
hexadecimal SHA-256, MIME type, name and `encrypted:false`. The name is never
used as a path on the volume. The response includes `id`, `file`, `state`,
`expires_at` and `message_id`. States: `prepared`, `ready`, `completed`,
`cancelled`, `expired`.

The same preparation returns the same reservation without extending its expiry.
Different arguments under its ID are rejected. The upload is bound to the UID,
the generation and the lifetime of the membership; leaving then rejoining does not
reactivate an old intent. Write rights are checked
before and after the transfer.

The bytes go into a temporary object. Actual size, fingerprint and signature
of the declared format are verified. File and directory are synced before
publishing the PostgreSQL reference. An interruption allows restarting the
whole transfer; no chunked resumption is promised. A ready upload
returns its state without rewriting its bytes. A concurrent transfer receives
`upload_in_progress`; its persistent lease expires after a crash.

Confirmation uses another persistent identity and `plain` content
with `files:[upload_id]`, Markdown, quotes and an optional thread root.
Mentions are resolved by the server from the text. Message, file,
journal, reads and reservation link are confirmed in the same transaction.
A lost response or concurrent confirmations return the same message; a
receipt does not restore an old caption after an edit. An empty caption remains
possible. A concurrent abandon is not undone by the late end of the transfer.

The descriptors accompany history, snapshots and journal. Earlier text
messages stay valid without this field. A deletion exposes a
tombstone without files and cuts off the download. Quoted files remain
a J3 wiring task.

## Delivery and pilot policy

Download requires a confirmation, a current membership and a live
message. The application administrator has no implicit private access.
Before each 256 KiB frame, the server re-checks account, session, generation,
policy and membership, then holds their lease until submission. A lease
expires in five seconds even for an unconsumed body. Removal, logout or
tombstone cuts off the rest; bytes already delivered remain held by the reader.

Simple `Range` ranges return `206` and `Content-Range`; an invalid range
is rejected. Responses: `no-store`, `nosniff`, `Content-Disposition: attachment`
with encoded name. The Rust SDK exposes a streamed upload body and a response to
consume in chunks; the portable TypeScript transport verifies size and MIME.
The mobile wiring will use its native transport to the cache for
large files.

Current fixed policy: 1 byte to 100 MiB per object, ten unfinished
reservations per account, thirty preparations per minute, expiry after 24 h.
An inter-process lock bounds the sum of confirmed files and
unreleased reservations to 50 GiB; an expired reservation stays counted until
its cleanup under lock, so that a confirmation in progress cannot exceed
the quota. This logical quota excludes avatars and orphans.
Four transfers per process, full duration 120 s, wait for an upload
chunk 10 s; SDK 150 s. J5 will expose the operations settings.

Accepted types: generic bytes, text, PDF, ZIP, PNG, JPEG, GIF, WebP, MP3,
Ogg, WAV, MP4 / M4A, MOV and WebM. Their signatures do not fully validate
a codec. HTML and SVG are not declared accepted types. Encrypted
files remain disabled until the J4 protocol; its opaque DTOs do not enable it.

Expired reservations release their reference. The avatar collector
removes unreferenced objects after one hour and also scans active
objects. A finalized write followed by a rollback remains an orphan, with no
message or public route. Confirmed files are kept until the
J5 retention policy, including after the message is deleted.

## Validation and next steps

### Desktop in the existing interfaces

GTK and SwiftUI use the current composers, progress and retry /
abandon actions. `native_file_intents` keeps a streamed private copy,
its fingerprint, the membership and the preparation / confirmation IDs before the network.
A lost response resumes the original intent; a replayed confirmation
projects the current message, including after an edit or deletion. Abandon
is durable and does not mask a confirmation that already won the race.
A reservation proven expired remains in failure; Retry prepares a new
reservation while keeping the message identity.

Manifests are translated to the existing attachments. `rv-file:` URIs
are local handles without a token. Downloads go through the SDK,
to a private `.part` verified by size / SHA-256 before publication. Each
reuse requires an authenticated Range; generation, membership and tombstone
close the access. Swift players receive the core's private path, without an intermediate
public copy. GTK players and Swift modals remove their
content when the local right disappears. Cache limited to 32 files / 512 MiB,
memory preview to 32 MiB and four simultaneous downloads. Search results
keep bounded temporary manifests, without adding history.

The SQLite tests reopen the outbox after two lost responses and verify
the membership / generation boundaries. The real PostgreSQL bench verifies a streamed
upload, a source modified after selection, restart, offline abandon,
cache / backup, refusal of another account and tombstone. Under Xvfb, the existing
GTK composer produces its card and opens the protected file. The real Swift
models and their Secret Service cover sending, players and abandon. These benches
do not attest audio / video codecs or installed applications.

### Mobile in the existing interface

The SQLite migration (now part of `0017_native_provider.sql`, formerly 0030) keeps the original private file, its fingerprint,
the membership and the distinct preparation / confirmation identifiers with the
existing `uploads` row. Retries and progress use the current
controls. An offline abandon is persisted then proven on the server side:
a confirmation already executed is recovered, without claiming to cancel it.

The Expo module `file-transfer` sends the bytes from disk on
Android / iOS, with progress, cancellation, deadline and redirects disabled.
It requires a native rebuild of the app; its absence disables the button.
The Expo download receives the chunks in a private `.part`, checks size / SHA-256,
then publishes the local file. The players and the share sheet receive this
path, with no token in their URLs. Cache reuse requires an authenticated
Range; closing, change of membership / generation and tombstone remove
the accesses. Search results can open a file without becoming
confirmed history. Send copies are separated by account / generation.
Cleanup removes earlier generations and abandoned copies.

The real mobile / HTTP / PostgreSQL / SQLite engine is reopened after the loss of
each of the three responses: a single visible confirmation each time.
Offline abandon is also resumed without a message. Targeted tests: 103 TypeScript
scenarios, including projection, quotes, integrity refusals and origin check.
Typecheck / lint and Android export succeeded; module autolinking verified.
This export is not an APK and does not validate Kotlin / iOS compilation or the
players on devices. These qualifications remain explicitly open.

Seven PostgreSQL scenarios cover concurrency, response loss in the real TypeScript
transport, Rust SDK streaming, size / integrity / type, incomplete
transfer, abandon in progress, expiry, quotas, generation / rejoin,
privacy, tombstones, empty caption and a stop between two frames after removal.
The messages, profiles / avatars, contracts and desktop core compatibility remain
verified. The TypeScript SDK tests check headers, redirects and truncation.

### Quoted files

`QuoteExcerpt.files` carries the descriptors of the current source message. The
resolution checks its room, its membership and its live state in the same
SQL view as the text; the delivery lease covers this room. A quote creates
no file link in the destination room and grants no read right.

The mobile / desktop caches validate the room of each descriptor and keep
the files in the source row bound to the membership. A descendant keeps its
own row; the parent does not keep its private metadata. They can
open a quoted file without fabricating a source message in the history.
Deletion and a more recent unavailable view also remove the authority
of an old manifest still in cache. Removal, rejoin and generation purge
these views. Transfers use the same protected players as ordinary
files and always check the source message on the server side.

The existing quote cards show protected images and summarize
documents / voice notes / videos, without replaying an audio player in the quote.
Files remain present at the second and last level of quote.

Exiting P14 still requires the installed qualification of the
three interfaces, including the codecs and the compilation of the mobile module. J4 completes
encrypted files; J5 adds
configuration, retention, volume backup / restore and capacity.
