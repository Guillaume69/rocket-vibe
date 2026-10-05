# Native MLS message delivery

State as of 4 October 2026: opaque server, ordered journal, and experimental Rust /
TypeScript transports. `capabilities.e2ee` stays disabled. The [private HTTP worker](../../crates/rv-crypto/GROUP_HTTP.md)
wires up send / resume and [protected journal pages](../../crates/rv-crypto/JOURNAL.md),
with a checkpoint shared by messages / transitions and catch-up on the same
admission, with historical authentication kept distinct from the current validity
of certificates. Server POSTs keep their current date / roster checks.
Wiring to the interfaces, readmission after removal, archives and files remain
open. This batch does not close J4 and does not allow the J5 switchover.

## Routes

Routes under `/api/v1/e2ee/rooms/{room}`, HTTP session required and
`Cache-Control: no-store` on successes as well as refusals:

| Route | Contract |
|---|---|
| `POST /messages` | `ApplicationSubmission`: scope, operation, canonical proof and MLS ciphertext in unpadded base64url; durable receipt |
| `GET /message-operations/{operation}` | Personal receipt of an operation accepted in this room, without ciphertext |
| `POST /message-operations/{operation}/cancel` | Original opaque intent; durable decision `accepted` or `cancelled` |
| `GET /delivery?after={position}&through={position}` | `DeliveryPage`: opaque transitions and messages in a common order, Welcome targeted at this device |

A new send requires the author's certified session / device, the current
membership, the right to write and an exact group head. All members,
activation nonces, devices, certificates and policy versions of the accepted
plan are revalidated before the commit. A removal, a deactivation or a policy
that has become obsolete first requires the corresponding MLS transition.
Ordinary members of a read-only room cannot publish.

An operation that was already accepted returns the same receipt for the same
intent, even after removal from the room or certificate expiry. The receipt GET
belongs to the user; another active session of this account can read it without
being admitted to the crypto. It gives no ciphertext and grants no right to send.
The current data scope remains mandatory. Another user or room does not find this
receipt. A diverging intent returns `operation_conflict`.

### Definitive abandon and lost confirmation

Abandoning is an explicit request, never a deduction from a `404`, a timeout,
a quota or a group change. It resubmits exactly the `ApplicationSubmission`,
including the original proof and ciphertext; the operation in the path must be
identical. The account lock shared by sends and the other operations serializes
the two outcomes:

- `accepted` contains the original receipt if the message was already accepted,
  even after removal from the room or certificate expiry;
- `cancelled` contains scope, room, operation, canonical Header and public
  fingerprint. No message ID and no position is allocated. The persistent
  personal trace forbids all late POSTs of this intent.

An exact replay returns the same decision after a restart. A diverging reuse of
the operation, including in another room or in an ordinary / upload operation,
remains forbidden. Migration 0041 keeps only the fingerprint of the intent and
the abandon receipt: no plaintext document, no complete proof and no copy of
the ciphertext. A new abandon is limited to 600 per minute and account;
decisions already recorded remain accessible.

An active HTTP session of the owner is enough to request the abandon, including
from another device of their account. An unknown proof must be
cryptographically valid, bound to this owner and to this scope / route;
an expired certificate is authenticated historically, a future certificate is
refused. This check readmits no device and grants no right to read or send.
New publications keep their current certificate / roster checks. Receipts remain
decisions of the authenticated server, without cryptographic proof of
completeness or of non-acceptance against a malicious server.

The worker checkpoints the decision against its protected intent before
publishing it to the provider. A lost abandon confirmation leaves the outbox
uncertain until its exact replay. The private document remains recoverable; a
retry requires a new operation and the current rights / keys. The original MLS
generation remains consumed. The journal is never advanced by an abandon.
The abandon intent is itself checkpointed before HTTP: after a restart,
the retry settles this decision and never republishes the old intent.
The personal GET returns `409 crypto_message_cancelled` for this owner
and this room when an abandon exists. This status pushes the worker to fetch
the exact receipt; no abandon relies on the error code alone.

The persistent limit is 600 new messages per minute and device.
Exact confirmations and retries remain available during this limit.
The operation identity is shared with ordinary sends, creations,
actions, room commands and uploads: no diverging reuse across
these spaces is allowed.

## Public proof and retained data

[`rv-crypto-public::messages`](../../crates/rv-crypto-public/src/messages.rs)
defines Header, Proof and Receipt. The proof binds the scope and incarnation of the group,
operation, accepted head, MLS epoch, author / device / incarnation / certificate,
content type and optional thread root. The certified leaf signs the
routing and the SHA-256 of the ciphertext. The canonical bytes remain opaque in JS.

The server verifies the certificate, its signature, the authorized device, the digests
and the TLS PrivateMessage / Application envelope with expected ID and epoch.
**It does not decrypt the document and does not validate the internal MLS author
or the authenticated AAD**: these checks remain mandatory in the client vault
before projection. An HTTP receipt alone does not prove that a peer can open the content.

PostgreSQL keeps only the proof, the ciphertext, routing metadata and the
receipt. The receipt holds the canonical Header in base64url, the fingerprint of the
proof, the message ID and an exact decimal position. The message ID is not chosen
by the server: it is the first 16 bytes, in lowercase hex, of
SHA-256(`rocketvibe-mls-message-id-v1\0` ‖ proof fingerprint)
(`rv-crypto-public::messages::message_id`), and every client refuses a receipt
whose ID differs. A thread root, an amendment target or a file link therefore
names exactly the message its author signed; the server cannot give two
messages the same ID nor move an ID onto another message. The rich document remains
in the private checkpoint. Ordinary tables do not receive its text.
Routing metadata, notably the thread root, is visible to the server.

A reply must reference an existing opaque root of the same room, accessible
during the admission of the author device. A reply cannot serve as a
new root. Edits, deletions and reactions are amendments, ordinary messages of these
routes, and search runs on the device ([E2EE_AMENDMENTS.md](E2EE_AMENDMENTS.md)).
Encrypted files ride on these messages ([E2EE_FILES.md](E2EE_FILES.md)). Counters and
notifications are not yet wired to them.

## Order, pagination and admissions

The transaction of a transition or message allocates a position in the
instance's native sequencer and writes its frame into `e2ee_delivery`. A confirmation and
its frame are therefore atomic; an exact retry allocates no new position.
The ordinary journal may produce intermediate positions: numeric gaps
are not missing messages.

All HTTP positions are canonical decimal strings between
zero and `i64::MAX`. They must not be converted to JavaScript numbers.
The first page sets `through` to the last crypto position of the room.
Subsequent pages keep this watermark and pass `next` as `after`.
`next: null` closes the range; later arrivals wait for the next range.
Each page holds at most 16 frames and about 2 MiB of opaque bytes before
base64 / JSON. Both transports bound crypto responses to 4 MiB before
JSON decoding. A message proof is bounded to 16 KiB, the ciphertext to 128 KiB
and the POST request to 256 KiB.

The visibility of a frame requires an exact admission witness for the device:
scope, user, device, incarnation, root, leaf index, admission
KeyPackage, membership nonce and activation nonce. Transitions that
preserve this admission preserve access to previous frames; a
certificate renewal alone does not change this witness. A new device,
leave / return or readmission after removal excludes the old frames. The
delivered Welcome belongs only to this admission of this device.

Migration 0040 rebuilds these witnesses from the existing signed
transitions and adds the transitions to the journal in their per-room order,
before the first opaque message. The old group endpoints remain
available; a message client must use the common delivery order.

The response keeps a lease on session, device and personal access until the
body is submitted. A revocation waits for its submission; an unsubmitted body
expires within five seconds at most and before the real session / certificate timeout.
Publications also hold the peers' activation nonces until the commit,
before locking the room, to avoid a race or a cycle with an account
deactivation.

## Verification and remaining work

The PostgreSQL tests exercise real MLS, HTTP and the Rust SDK: concurrent
confirmation / resume after recreation, a single ciphertext and receipt, actual
decryption by the peer, positions beyond `2^53`, interleaved transitions and messages,
fixed watermark, removal / re-membership with a new Welcome, threads,
durable quotas, operation conflicts, refusal of proofs / heads / scopes,
leases and expiry, concurrent publications and peer deactivation.
The exact backfill of the migration is exercised on real transitions.
The common fixtures and the TypeScript transport check types, retries,
watermarks, absence of private / plaintext fields and limits before JSON.

The private worker now validates multi-epoch prefixes on a single
admission, historical authentication of certificates and rotations
concurrent with sends. It also checkpoints the definitive abandon of personal
messages. A last decrypted message position is not proof
of a complete range. Readmission after removal, settlement of uncertain group
transitions, durable private projection, desktop / Android bridges,
trust interfaces, archives, files and independent crypto review
remain criteria of J4.
