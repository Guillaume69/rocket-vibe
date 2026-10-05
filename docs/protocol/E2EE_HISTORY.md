# Encrypted history: recovery on a new device

Contract for RFC 0002 item "history on a new device". It applies the
[archive access rules](E2EE_ARCHIVE.md): a new device of the same account may
recover that account's history after an explicit approval, within the account's
original membership periods. No production capability is enabled by this document.

Two paths are planned, delivered in this order:

- **A. Device-to-device share.** A device that already holds the history shares it
  with a new device of the same account, after a human approval on the sharing
  device. Specified and implemented first.
- **B. Archive-key backup.** A recovery code protects the archive keys so that a new
  device can recover the history when no old device is left. Its own consent,
  version and settlement; specified after A ships.

## Trust model

- Both devices belong to the same account: their certificates chain to the same
  pinned account root, appear in the verified account directory and are not
  revoked. A server-supplied root, session or notification proves nothing.
- The sharing device must be approved by a human who compares the request
  fingerprint shown on both devices, as for device enrollment. A server-side
  request alone never triggers a share.
- The new device trusts a recovered document because a device of its own account
  attests it: the record is signed by the sharing device's current certificate and
  binds the exact origin receipt and the original author certificate. It does not
  re-verify the MLS original, which the new device never received.
- The server stores and relays opaque bytes. It learns the account, the two
  devices, the rooms, the number and sizes of the records and the positions in
  the receipts it already delivered. It never sees a key or a document.
- A shared history is deliberately recoverable: it has no forward secrecy. A device
  revoked later keeps what it already recovered; revocation stops new shares.

## Boundaries

A share covers, per room, the periods for which the sharing device holds a
verified journal index (its own admissions). Each period keeps its source binding:
room scope, personal grant (access and activation versions) and admission witness.
The new device keeps the periods separate and labels them as recovered history.

- No period the sharing device never observed is invented or merged.
- A new member never receives a share: the request and the share are bound to one
  account, and the server refuses another account's device.
- The server refuses an upload or a download for a room the account currently
  cannot read (excluded or left), as for any online read. Copies already recovered
  stay local.
- Sharing does not admit the new device to any MLS group: sending still requires
  its own Welcome. Recovered history is read only.

## Objects (v1)

The JSON / NUL domain and canonical-decoding rules of [IDENTITY.md](../../crates/rv-crypto/IDENTITY.md)
apply. Integers above `i64::MAX` are refused; positions cross the wire as decimal
strings.

### Request (new device)

| Field | Content |
|---|---|
| `version` | `1` |
| `certificate` | Current certificate of the requesting device, carrying the account root |
| `request_id` | Random 32-byte OS identifier |
| `recipient` | X25519 public key generated for this request only |
| `issued_at`, `expires_at` | Window of at most 7 days |
| `signature` | Requesting leaf, domain `rocketvibe-history-request-v1` |

The request fingerprint is SHA-256 under `rocketvibe-history-request-fingerprint-v1`.
The X25519 private key lives only in the encrypted vault records of the new
device (`crypto-history-request-v1`), with the request. An expired or answered
request is replaced by a new one with a new key.

### Share (sharing device)

A share answers exactly one request fingerprint. It contains:

- `manifest`: per room and period, the source binding, the first and last position,
  the record count and a chain digest: SHA-256 under
  `rocketvibe-history-chain-v1` folded over the record fingerprints in position
  order. The new device refuses a missing, extra, reordered or duplicated record.
- `envelope`: HPKE base mode (RFC 9180) to the request's `recipient` key, suite
  DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305, `info` =
  `rocketvibe-history-share-v1` NUL request fingerprint, `aad` = canonical manifest.
  The plaintext holds one random 32-byte period secret per manifest entry.
- `certificate` and `signature`: current certificate of the sharing device and its
  leaf signature over request fingerprint, manifest and envelope, domain
  `rocketvibe-history-share-v1`.

### Records

Each document travels as a **v1 history record**, sealed by the sharing device
from its verified local observation. An [archive packet](E2EE_ARCHIVE.md) cannot
serve: it requires the archiving device to share the author's account root, and a
shared history is mostly other people's messages. A record holds:

| Field | Content |
|-------|---------|
| `header` | The v1 archive header: exact origin receipt, the author's membership recorded at reception (`author_membership`), `key_id`, `nonce` |
| `original_certificate` | The author's original certificate, whose fingerprint, device and incarnation must match the receipt route |
| `certificate` | Current certificate of the sharing device, which attests the observation |
| `ciphertext` | XChaCha20-Poly1305 of the document payload, AAD = canonical header under `rocketvibe-history-record-aad-v1` |
| `signature` | Leaf signature of the sharing device, domain `rocketvibe-history-record-v1`, over header, original certificate fingerprint, sharing certificate fingerprint and SHA-256 of the ciphertext |

The sharing device must be on the receipt's instance; it need not share the
author's root. Whether it belongs to the receiver's account is the receiver's
check: it must be the share's certificate. Record fingerprints (for the chain)
are SHA-256 under `rocketvibe-history-record-fingerprint-v1` NUL canonical bytes,
and a record's canonical bytes stay under the archive wire limit.

A record's key, `key_id` and nonce are not random: they are the 72 bytes of
HKDF-SHA256 of the period secret (empty salt) with `info` =
`rocketvibe-history-document-v1` NUL the document's rank in the period (from 1, as
a big-endian u64). Only the period secrets travel, inside the envelope; the records
are useless without it. The receiver derives the material for the rank it expects
and checks `key_id` and nonce: a record omitted, repeated or served at another rank
is refused at once, before the chain is complete.

Sealing is deterministic: Ed25519 signatures are, and each rank has its own key
and nonce over an immutable document. A page lost on the way is sealed again byte
for byte, so the sharing device keeps only the period secrets and the running
chain of the pages the server already holds, never the records.

Membership versions (`author_membership`, and the archive header in general) are
opaque identifiers, as the server issues them (UUIDs in production), not decimal
revisions.

## Flow

1. **Request.** The new device creates the request, saves the private key and the
   request in one protected transaction, then publishes it. It shows the request
   fingerprint.
2. **Preview.** Another device of the account lists the pending requests, verifies
   the signature, the certificate against the verified directory (same root, listed,
   not revoked, not itself) and the window, and shows the same fingerprint with the
   rooms and periods it would share. Nothing is sent yet.
3. **Approval.** After the human confirms, the sharing device records a share job
   in its vault: the request, its pinned certificate, and per period the binding, a
   fresh secret and the number of documents its index holds now. It seals and
   uploads the periods page by page, recording each page once the server holds it,
   then draws the envelope once, keeps the signed share and commits it. A lost
   response resumes from the job: same secrets, same records, same share. A renewed
   sharing certificate ends the job; a new approval starts another.
4. **Import.** The new device fetches the share, verifies the sharing certificate
   against its directory, the signature, the request fingerprint, then opens the
   envelope and keeps the share and its secrets as an import job in its vault. Per
   manifest entry it downloads the records by pages, verifies each one (signed by
   the share's certificate, origin scope = entry room, increasing position inside
   the entry bounds, key material of its rank, document codec) and folds the chain,
   then stores the documents in a recovered catalog of its vault, with the job's
   progress, in one protected transaction per page. The entry becomes visible only
   when its count and chain match the manifest.
5. **Acknowledgement.** Once every entry is imported, the new device acknowledges;
   the server deletes the share and its records. Unacknowledged shares expire after
   7 days.

## Reading recovered history

The recovered catalog is separate from the journal indexes of the new device's own
admissions. A recovered period is read with the same projection shape (pages of 1
to 200, `before`, threads, roots and reply counts). Once the new device has its own
admission to a room, the room projection continues into the recovered periods for
positions older than its own first indexed document; positions are never merged
across a period boundary.

## Public vector

[`history-share-v1.json`](../../crates/rv-crypto-public/fixtures/history-share-v1.json)
holds a request from Alice's phone, the share of Alice's desktop and two of Bob's
messages (one a thread reply) as records, with the disposable recipient seed. It is
checked three ways: `rv-crypto-public` authenticates the request, the share, each
record and the chain; `rv-crypto` reopens it as the phone (envelope, rank material,
documents); and
[`verify-history-vector.mjs`](../../crates/rv-crypto-public/scripts/verify-history-vector.mjs)
redoes everything with Node/OpenSSL alone, HPKE key schedule, DeriveKeyPair and
HChaCha20 written out (the latter checked against the XChaCha draft vectors). The
certificates are throwaway and nothing in it attests a real MLS admission.

## Server API

| Method and route | Who | Effect |
|---|---|---|
| `POST /api/v1/e2ee/history/requests` | Requesting device | Stores its signed request (one pending per device) |
| `GET /api/v1/e2ee/history/requests` | Any device of the account | Pending requests of the account |
| `PUT /api/v1/e2ee/history/shares/{share}/records` | Sharing device | One page of records for one manifest entry (at most 200 records, 4 MiB) |
| `POST /api/v1/e2ee/history/shares/{share}` | Sharing device | Commits the signed share once every manifest record is uploaded |
| `GET /api/v1/e2ee/history/requests/{request}/share` | Requesting device | The committed share |
| `GET /api/v1/e2ee/history/shares/{share}/records` | Requesting device | Records of one entry by position pages |
| `POST /api/v1/e2ee/history/shares/{share}/ack` | Requesting device | Deletes the share |

Every route checks the authenticated device against the request or the share, the
account, the device revocations and, for records, the account's current read right
on the room. Upload and commit are idempotent by operation ID.

## Exit criteria for A

- Public vector for request, share, envelope and chain, verified by Rust and by an
  independent Node / OpenSSL script. **Done.**
- Two devices of one account: share of several rooms and periods, lost responses at
  every step, reopening, forged / reordered / missing records, another account's
  device, a revoked device, an expired request.
- Server tests on PostgreSQL for authorization, idempotence, quotas and expiry.
- Approval and import screens in the existing GTK, SwiftUI and Android settings.
- Installed qualification and the independent crypto review stay distinct.
