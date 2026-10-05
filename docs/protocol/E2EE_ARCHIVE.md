# Encrypted archive: access rules

Policy adopted for RFC 0002. It precedes the implementation of the format and
envelopes; no production archive capability is enabled by this document.

## History boundaries

The archive keeps the documents that were received or sent and authenticated, independently
of the MLS ratchets. Access to it is bound to an identity, a room and a membership
period. The scope includes the instance and its data epoch. The room identifier
or knowing a key does not constitute an authorization to
ask the server for other periods.

| Recipient | Access adopted |
|---|---|
| Device already admitted, current membership | Documents of the authorized period; no implicit opening of another period |
| New device of the same account | Explicit recovery of this account's archives after approval; new Welcome to send |
| New room member | Messages since their admission; no automatic access to the earlier archive |
| Member who leaves then returns | New membership period; the old periods are not merged automatically |
| Removed device | No new packet or key share; copies and keys already held cannot be recalled |
| Account excluded from the room | No new download from the room; its documents already received remain local copies |
| Account whose root alone was restored | No history recovered without additional archive keys or an authorized share |

Recovery by a new device keeps the boundaries of the account's original
membership. It does not turn a new member into a former member.
Sharing an older period requires a separate action, a current authorization
and a preview of the recipients / bounds confirmed by a device that
holds the relevant keys. The initial flow refuses this sharing until its
contract and its interface are delivered. A server administrator has
no keys and cannot alone grant cryptographic access to the content.

Online reads revalidate the rights and the device incarnation before
publishing a response. The list of periods must be complete and protected
against omission / replacement after local observation. Positions and
revisions cross the interfaces as exact decimal strings.

## Removed author and documents already received

The current validity of a device authorizes a new send. It does not by itself decide
whether an already authenticated document must disappear from an archive.
A document already accepted and observed in a protected transaction keeps its
content, its author and its proof of origin after the expiry or removal of that
author. The interface distinguishes this historical state from a device still authorized
to send; it re-establishes no current pin or consent to read it.

A mere date supplied by the server does not prove that a packet precedes a
removal. A packet never observed, signed by a key since removed, cannot
be silently promoted to an old authenticated document. Its historical admission
path requires a dedicated proof and policy; failing that,
it remains unavailable. A restored archive must preserve the original
authentication witnesses; it does not replay an old MLS send and
does not erase known removals in order to accept its signature.

The format will have to bind document, author proof, origin receipt,
room, membership period and position without ambiguity. Replacing a root, a new
server epoch or another incarnation must not reinterpret a historical proof as a current
consent.

## Keys, backups and actions

Archive keys and their envelopes are distinct from the `root-backup` root
backup and from the MLS state. The current root backup will not be
silently extended to include conversations. The backup of archive
keys will have its own consent, version and intent settlement.
Packets will be authenticated before any display or projection creation.

A recoverable archive deliberately keeps access to the archived documents:
it does not promise forward secrecy for these documents. Removing a device
or replacing a backup packet does not destroy an old copy or its
key. Without a key or a device able to authorize a share, lost data
remains unrecoverable.

Edits, deletions and reactions are authenticated events applied to the same
archive ([E2EE_AMENDMENTS.md](E2EE_AMENDMENTS.md)); pins are not yet. A deletion removes the document's projection
according to current rights; it does not guarantee the erasure of an already
exported copy. Private search indexes only the authorized documents in
the client's protected storage. Text, index and keys are never added to the
ordinary cache or to the server's search.

## Criteria before activation

- Versioned format, AEAD and recipient envelopes specified and reviewed.
- Protected transactions keeping content and proof before acknowledgement.
- History beyond the current 64-document cache, pagination and complete threads.
- Refusal of foreign periods, new members and unapproved devices.
- Resumption without duplicates after a storage / network / confirmation interruption.
- New device of the same account with a blank cache and restored root / keys.
- Author removal: already observed document kept, new packet refused.
- Reader removal during download and return with a new membership.
- Server backup / restore and refusal to reinterpret the old epoch.
- Rocket.Chat import keeping proofs and boundaries, with no conversion to cleartext
  on the server.
- Qualification of installed GTK / SwiftUI / Android and independent crypto review.

The rules above fix the recipients and the separation between historical
reading and current authorization. [History on a new device](E2EE_HISTORY.md)
specifies the device-to-device share and, after it, the archive-key backup. The formats, APIs, key backups and
tests for these criteria remain to be implemented.

## First format: immutable document v1

The public packet `rv-crypto-public::archive::Packet` and the private primitives
`rv-crypto::archive` are implemented. This first batch is not yet wired
to the journal, the server or the interfaces; it does not remove the current limit
of 64 documents in the projection. The origin receipt in the tests is synthetic.

The packet contains:

| Field | Binding |
|---|---|
| `header.version` | Version 1 only |
| `header.origin` | Exact receipt: group scope / incarnation, operation, thread, fingerprint of the group and of the intent, author / device / incarnation / certificate, message ID and position |
| `header.author_membership` | Author account and original access / activation versions |
| `header.key_id` | Random 16-byte OS identifier |
| `header.nonce` | Random 24-byte OS nonce |
| `original_certificate` | Historical certificate matching the origin receipt |
| `certificate` | Certificate of the leaf that signs the archive; same immutable root as the original author |
| `ciphertext` | Encrypted canonical document; codec identical to the live private message |
| `signature` | Ed25519 signature of the archive leaf |

`position`, `group_revision` and `epoch` of the public receipt are canonical decimal
strings; the membership versions are the roster's opaque identifiers (the server
draws UUIDs), never parsed as numbers. Integers are bounded
to `i64::MAX`, with zero allowed only for the epoch. The other fields of the
receipt use its existing strict schema; its JSON keys are sorted during
serialization. Canonical decoding rejects extra fields and
ambiguous versions / numbers before accepting the packet.

A random 32-byte OS key encrypts a single document with
XChaCha20-Poly1305. The associated data is
`rocketvibe-archive-document-aad-v1`, a null byte, then the canonical JSON of the
header. The decrypted document keeps operation / thread / quotes / cards and
the same validations as the message codec. Its limit is 64 KiB; that
of the ciphertext is 64 KiB + 16 bytes, and the JSON packet is bounded to 384 KiB.

The signature binds `rocketvibe-archive-document-proof-v1`, a null byte, then the
JSON tuple: header, fingerprint of the original certificate, fingerprint of the archive
certificate, SHA-256 of the ciphertext. The packet fingerprint binds another domain,
`rocketvibe-archive-document-fingerprint-v1`, to its complete canonical bytes.
Both certificates are authenticated; the archive certificate must be
currently valid for a new publication. An expired original
certificate remains a historical reference. A renewed or recovered leaf of
the same root can archive an already observed original without rewriting its proof.
Another root, even with the same account name, is rejected.

Private keys have no diagnostic formatting, no clone, serialization,
display or raw export. Their persistence uses only the records of the
encrypted vault, under a name derived from the exact fingerprint of the packet. A
substituted key or a corrupted AEAD packet is rejected before the document is returned.
Deleting this local key does not invalidate another copy already held.

These signatures prove neither the acceptance date, nor the membership, nor the equality
of the document with its MLS original. The coordinator will have to verify this equality
and keep the observation witness in the same protected transaction before
admitting an archive. Mere decryption does not replace the checks of the
current rights and of the authorized periods defined above.

Five private tests exercise real AEAD, key reopening, exact binding,
substitutions, encoding / limits and a renewed certificate. A public vector with
positions above 2^53 is verified by Rust and independently by
`node crates/rv-crypto-public/scripts/verify-archive-vector.mjs` (Node/OpenSSL),
added to the server check. This vector contains a throwaway certificate and a real
AEAD packet, with no private key; it does not attest a real MLS admission.

Remaining are the admission of portable packets, the recipient envelopes and
backups of their keys, the server transport, the portable packet readers
and the independent qualification. The local catalog of observed originals described
below keeps a proof distinct from the portable packet signed by the author.

## Local storage: encrypted blocks and shared checkpoint

The vault can now keep immutable blocks in `private_blobs`,
in the same SQLite database as the MLS state. Each block is encrypted under the vault
key with XChaCha20-Poly1305, a 24-byte OS nonce and a 16-byte OS identifier.
The AAD binds the domain `rocketvibe-private-blob-v1`, the full scope of the
account / device / epoch / incarnation and this identifier. A reference
binds SHA-256 of the AAD, of the nonce and of the ciphertext. It contains no public
hash of the cleartext document.

The references must be kept in the protected records. The SQL list
of blocks is not a trust index. The observation catalog described
below binds its references to a head protected in these records.
Reading a block by its reference does not constitute an authorization to read a room.

`Manager::transact_with_blobs` keeps the same OS lease and the same checkpoint
as the existing MLS operations. Blocks and references commit in a single
transaction; the result waits for the checkpoint to be written and re-read in
the protected storage. If this write fails, resumption recognizes only
the exact successor, then returns the original without adding a second block.
The written blocks are verified after the state UPDATE, before commit: even a
SQL trigger that erases or substitutes a new block makes the transaction fail.

A block is bounded to 1 MiB and a transaction to 1,024 new blocks. Its payload
does not grow the main 16 MiB snapshot. The old schema is extended in
a transaction; a genesis already containing a block cannot be taken up
as an empty initialization. A block that is omitted, replaced, from another scope or exceeding
its limits is rejected before cleartext leaves. SQL lengths are checked
before allocation.

Five vault tests pass in 8.93 s: 70 blocks of 256 KiB (17.5 MiB) with
reopening and reading after the 64th, absence of cleartext in the DB / WAL, corruption /
omission / other account, full rollback, migration, malicious trigger and
limits / genesis. The eight protected coordinator tests pass in 1.34 s,
including a checkpoint failure followed by a resumption without duplicates and refusal of an
unavailable keyring. The five old vault tests pass in 2.93 s, with a real process
kill and an ignored child entry called by its parent bench.

This storage is internal and bound to the protected installation. It replaces neither
the portable archive packet nor the key envelopes / backups. The
wiring of the local projections is described below; the hot cache
remains bounded to 64 documents, with no automatic eviction at this stage.

## Local catalog of observed originals

MLS reception now writes an immutable encrypted node containing the verified
document, its original public submission, its receipt and the observation date.
The node and its protected head are recorded in the same transaction as the
ratchet and the journal cursor. A cancelled page therefore publishes neither an archive
document nor a ratchet consumption. An already known personal echo returns its
exact reference without adding a second node.

The catalog is bound to the room, to the personal membership and to a witness of the
MLS admission. Renewing a certificate does not merge two admissions.
Reading requires the current local context and the expected group head;
it does not re-approve the original author after their removal. The
session and reader-close checks remain necessary around the result.

The head anchors a chain of authenticated references with power-of-two
jumps to find the old pages of the ordered journal.
Personal echoes received in another order are still kept; in that case
reading walks the chain and selects the requested positions, with
at most the page size in memory. Each rendered document revalidates its original
proof and its format. Pages hold 1 to 200 messages, their positions
remain exact integers and the thread filter is distinct from the main room.

The bench uses two real MLS actors and 130 messages, forgets the cache after
each reception, reopens the vault then reads pages beyond the 64th document,
with positions above 2^53 and refusal of another membership. Two other
scenarios verify rollback / retry, reversed echoes and retention of a known
original after the author's removal. The receipts of these tests remain
synthetic: they do not qualify the server transport of the archive.
The three tests pass in 130.85 s; the 15 reception tests and 13 journal
tests also pass after this wiring.

`Coordinator::observed_archive` exposes this local read to the engine. This
catalog distributes no key and cannot fabricate a signed portable
packet in the name of another author.

## Reading conversations from the archived prefix

A second protected index contains only the documents admitted in a verified
journal page. It references the observation blocks and keeps the
positions / jump references, without duplicating their plaintext. Receiving a personal
echo or observing a message separately is not enough to add it to the prefix.
Index, document, ratchet and cursor commit under the same checkpoint.

`journal_projection` now reads this index in the existing desktop
and Android readers, with the bound of the protected cursor, the thread filter, `has_older`, the
observed thread root and its local counters. `journal_last_batch` finds the
originals even after the hot cache is forgotten. No nested keyring is opened
during the projection. The restored document revalidates its exact submission / receipt.
Removing an admission marks both catalogs as out of projection; a distinct
readmission cannot merge them implicitly.

The old protected cache stays readable when no index exists. The next
reception indexes only its entries already journaled for this membership, before
the new documents. A separate observation stays excluded even if an
empty page advances the cursor beyond its position.

The 15 journal tests pass in 113.26 s, including a run of 70 messages with
both caches forgotten, reopening, old pages, thread root / counters,
resumption of the last page and removed author. Migration of the old cache
and exclusion of an observation outside the prefix also pass. The receipts
remain synthetic. The worker's HTTP bench passes in 1.94 s: lost read
response, real MLS reception, cache forgotten, resumption / projection of the
originals and refusal of a response served under the wrong room path. It
uses a fixture HTTP server; PostgreSQL and installed applications
remain distinct qualifications.

This step wires the reading of locally received originals.

## Hot-cache eviction and quote sources

The hot cache keeps at most 64 clear bodies. When it is full, the next reception
or preparation first evicts the oldest settled bodies, by observation date then
position. A body is settled when its admission was retired, or when it is accepted,
journaled and held by the verified journal index of its room's current
admission, at or below that index's head. Own intents that are pending, being
cancelled or cancelled never leave: their original packet must stay recoverable.
If nothing settled is left, the cache stays full and the operation is refused as
before.

An evicted body keeps its operation identity, its packet and receipt
fingerprints, and an `evicted` (or `retired`) marker. Receiving the exact receipt
again reads the body back from the journal index by its position and compares the
whole receipt; it consumes no ratchet and spends no second decryption. Any other
receipt for that operation is refused, and a retired one stays refused as retired.

`journal_sources` now reads the same index: quote sources cover every verified
document up to the protected cursor, not only the bodies still in the cache. The
old cache remains the fallback while no index exists for the admission.

The test bench sends 30 messages through journal pages with a cache reduced to 16
in tests, never calls `forget_message`, and checks for both actors the newest and
older pages, the 30 quote sources, the last-page replay after reopening, the
empty own outbox, the replay of an evicted receipt and the refusal of a forged
one.

The operation registry keeps a window of 8,192 identities: once a body has left
the cache, its identity gets a release order, and the oldest released identities
are dropped when the registry is full. A dropped received message stays refused by
its stream position; a dropped own operation ID stays unique on the server
(`409 operation_conflict`). A second bench (registry of 40 in tests) sends 60
messages, reads a still-registered evicted body back from the index and refuses
the replay of a dropped one.

Portable recovery remains open. The thread counters and quote sources still walk the
entire local index: a load qualification / a metadata index remain necessary.
