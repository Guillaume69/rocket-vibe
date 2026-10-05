# Delivery of native MLS transitions

State as of 4 October 2026: experimental server protocol, Rust / TypeScript SDKs and
PostgreSQL / MLS proofs. `capabilities.e2ee` remains disabled. The experimental
private worker uses these routes; its integration into the providers of the
existing interfaces remains open.
Overall specification: [RFC 0002](../rfcs/0002-e2ee-native.md).

## Routes

All require an active HTTP session; observations and new
transitions require the current membership of the room. Personal receipts and
the abandon of one's own intent remain accessible after removal. Responses
and refusals carry `Cache-Control: no-store`.

| Route under `/api/v1/e2ee/rooms/{room}` | Use |
|---|---|
| `GET /roster` | Policy and membership / activation versions of the active members, with public metadata of the head if any |
| `POST /transitions` | Signed transition, opaque commit, public tree and named Welcomes, in one transaction |
| `GET /state` | Last receipt, signed proof, current tree and `needs_rekey` indication |
| `GET /events?after={revision}` | At most 16 transitions after a canonical decimal revision; Welcome of the calling device only |
| `GET /operations/{operation}` | Durable receipt of this user / device and of this room |
| `POST /operations/{operation}/cancel` | Terminal decision against the original bytes of `GroupSubmission` |
| `GET /key-packages/{user}/{device}` | Observation of a published, active and available KeyPackage of a room member |

Observing a package does not reserve it. Two authors can observe the
same reference; only an accepted transition consumes it. An observation
that has become stale causes a refusal, without silently changing group or key.
The revisions / epochs of the HTTP DTOs remain exact decimal strings.

## Interrupted intent and abandon

The personal receipt is read with the device of the HTTP session, even after
removal from the room or expiry of the crypto certificate. It contains no tree,
commit, Welcome or read permission. The observation routes keep
their current checks. The strict replay of an already accepted POST also returns
its receipt before the membership check.

The abandon transmits the **complete original GroupSubmission**, with an HTTP
limit of 4 MiB. The signed certificate designates the device of the intent: another active
session of the same user can request the exact decision. Without a
known decision, the server authenticates signature, scope and opaque digests;
an expired certificate remains usable for this settlement only, a certificate
issued in the future is rejected. It re-authorizes no leaf or admission.

`GroupSettlement` contains either `accepted` with the original `GroupReceipt`,
or `cancelled` with scope, room, group incarnation, operation, device
and transition fingerprint. The abandon reserves no revision, epoch or
position; it records no commit / tree / Welcome and consumes no
KeyPackage. Its SQL intent fingerprint binds the complete original bytes.

Acceptance and abandon take the same exclusive lock of the author. An
already durable acceptance wins; otherwise the persistent marker forbids any late
POST of this intent. Another body under the same operation is
rejected. An abandoned personal GET returns `409 crypto_group_cancelled`; the
client retrieves the typed decision against its protected original before releasing
the commit. An error code alone is not enough.

New abandons are limited to 256 per day per account. Exact decisions
already known remain replayable beyond the quota. A restore
changing the data epoch rejects the old scope. This decision rests on
the authenticated HTTP server; it is not a cryptographic proof
of the absence of acceptance. [Private vault policy](../../crates/rv-crypto/GROUP_SETTLEMENT.md).

`GroupRoster` gives the instance / data epoch scope, the room,
`authority_version`, the members sorted by UID (`user_id`, `access_version`,
`activation_version`) and `group`, the public head receipt or `null` before genesis.
A member session can observe it before crypto enrollment / admission;
this grants no Welcome, no access to the group and no identity approval.
Administrators without a private membership cannot access it.

The list comes from the same query as the plan validation. It is
complete up to 128 active members; an overflow returns
`409 crypto_group_limit`, without publishing a partial page. A client can
build the plan with these versions, then present its local confirmation.
An observation is not a reservation: a change of policy, departure /
return or reactivation makes the old plan obsolete. The versions are
re-verified at commit before any package consumption.

The own authorization, the membership and the scope are held until submission
of the HTTP body. Removal and change of epoch wait for the response; its lease
expires after five seconds at most and before the actual session expiry.
The activation of another account can change after the SQL view; its version is
an observation, always revalidated at plan submission. The head metadata
of an old epoch is rejected, with no implicit remapping.

## Public proof and client verification

[`rv-crypto-public::groups`](../../crates/rv-crypto-public/src/groups.rs) defines
the `Plan` and the `Transition`. The author's leaf signs
`rocketvibe-group-transition-v1\0` followed by the UTF-8 JSON of the typed `Plan`: order of the
fields of the Rust structure, without spaces, member arrays sorted by UID,
participants sorted by leaf index and Welcomes by device ID. The
internal integers are `u64` verified on the Rust side; the JavaScript transports
keep this proof as opaque bytes and do not rebuild it.

The proof binds:

- instance, data epoch, room and random incarnation of the group;
- operation, expected revision / epoch and fingerprint of the previous transition;
- room policy version, membership and activation nonces of each member;
- user / device / incarnation, root, certificate, leaf index and
  admission reference of each recipient;
- SHA-256 of the TLS bytes of the GroupContext, the commit, the tree and the Welcomes.

The MLS ID is the SHA-256 of the typed Scope framed by `rocketvibe-group-id-v1\0`.
The fingerprint of a transition covers certificate, plan and signature, with the
distinct domain `rocketvibe-group-transition-fingerprint-v1\0`.
The [public vector](../../crates/rv-crypto-public/fixtures/group-transition-v1.json)
and its [Node/OpenSSL verifier](../../crates/rv-crypto-public/scripts/verify-group-vector.mjs)
check this framing independently. The TLS digests of this vector are
synthetic; the PostgreSQL tests also use real MLS groups.

The server verifies possession of the certified leaf, identity / session,
the list of authorized recipients, references and digests. It really validates
the MLS KeyPackages. **It does not verify the cryptographic content of the commit,
of the Welcome or the MLS transcript**, which remain opaque.

Before any local acceptance, the client engine will have to verify the signature,
the pins / consents, the group policy, the true MLS ID / context /
epoch / tree and each leaf identity. An HTTP receipt or `needs_rekey`
replaces none of these verifications. A refused reception must also
restore the ratchets and the MLS writes, as the private vault provides.
This wiring and its network limits are still an activation condition.

## Admission and ordering

A genesis uses `expected_revision=0`, with no parent or expected epoch. The
creator is the owner of the room, or a member of a DM. The room must be empty
of ordinary messages and of still-active cleartext file reservations.
Structured activity messages do not constitute an ordinary history.

A single-leaf genesis is at MLS epoch 0, with no commit or Welcome. A
genesis adding other leaves publishes its epoch 1 commit with their
Welcomes. The creator's initial leaf is at index 0 and has no admission
package. Every other new leaf requires an exact package and Welcome.

For the following transitions, the revision, epoch, incarnation and
fingerprint of the parent must match the server head. Each transition
advances the revision and the epoch by one. The author must have kept their admission
in the previous group; a newly enrolled device cannot take back
control of the group alone.

A kept admission keeps user, device, incarnation, root, MLS index,
package reference and membership / activation nonces. Renewing a
certificate does not authorize changing these identities; its MLS content remains to be
updated and verified in the engine. Leaving then returning, or deactivating
then reactivating the account, requires a new admission and a new Welcome,
even if the apparent list of users is identical.

Each active member must have at least one certified leaf in the plan.
A new member without a ready device blocks the transition. Changes
of membership, policy, certificate or session make the old list
obsolete. `needs_rekey` is an indication recomputed at read time; the future
encrypted send path will have to revalidate this list for each new send.

Head, event, targeted Welcomes, package consumption and receipt are
committed together. The bytes of the consumed packages are deleted, their
references remain withdrawn. A proof, recipient, duration or
CAS error cancels the whole. A strictly identical retry returns the receipt
before re-verifying a certificate that has since expired; it reactivates nothing.
Reusing the ID with other bytes fails. Receipts remain private to the author.

After the genesis, new ordinary messages and cleartext file preparations
are rejected with `crypto_required`. A reverse conversion is not
exposed. Sending encrypted messages and files remains to be integrated before
the apps offer the genesis of a room.

## Revocation and delivery

Persistent per-device / incarnation locks separate group validation
from certificate mutation. Directory writes / deletions take
these locks for modification; a transition takes all the
old and new locks in shared mode, in a stable order, before reading the heads and
consuming the packages. The initial leaf without a package is also protected.
A mutation completed before this acquisition is visible and rejects the stale
admission. A later mutation waits for the commit then forces the next rotation.

Readers hold the authorization of their session, the room and their own
incarnation until submission of the HTTP body. No Welcome is delivered to another
device, an old incarnation or an old membership. The read locks
expire after five seconds at most, shortened by the session / certificate
deadlines. The monotonic deadline is kept during the queries
and the serialization; the body poll checks it even if the expiry worker
has not yet been able to run.

These barriers cannot withdraw bytes already received. The recipient tables
take no foreign key to the heads or remote users during
the commit, to avoid a cycle with the deactivation of an account that waits for its
incarnation lock. The expiries of the participants and packages are re-verified
before commit, after the transactional publication of the fanout.

## Client coordinator: persistent genesis and admission

The private module `rv-crypto::groups` prepares a real genesis in the protected
vault. The local confirmation binds the list, the nonces, the policy, the
packages, the pins, the author certificate and the scope. The tree and the indices
come from a `PublicGroup` validated against the real GroupInfo and the prepared
tree. The local device is bound to the vault incarnation.

The prepared MLS state and the original request are committed together before emission.
The private commit stays pending until a receipt exactly bound to the proof.
A failed checkpoint releases no byte; a reopening recovers the original
request. A change of trust / expiry blocks its retry, but
the receipt lookup allows reconciling an acceptance that already occurred.
Finalizing this historical receipt does not amount to permission for a new send.

Joining now uses this coordinator: preview on a temporary provider,
opaque confirmation then acceptance in the protected transaction.
It compares the package actually consumed, the local certificate / incarnation,
the MLS author of the Welcome, each certified leaf / pin and the ID / context /
tree / epoch with the proof. The list and the nonces must match
the current authorized state observed separately. A signed proof can be valid
and nonetheless rejected if its declarations do not describe the true group.

A failure, even after the MLS creation of the group, cancels consumption and writes.
A success saves the receipt and the group together before returning. The exact
historical retry after a lost checkpoint re-grants no send right.
The tests use real private databases that are reopened and prove the same
epoch secrets. The [protected commit reception](../../crates/rv-crypto/GROUP_COMMITS.md)
now validates the true MLS author, routing AAD, Add proposals and references,
context / tree / leaves, then saves the successor and the receipt. A concurrent
local commit is replaced only after success; a late refusal / interrupted checkpoint
do not lose the old outbox. References already observed stay memorized
after removal. Eleven additional scenarios pass, with 79 vault tests
in total for this reception batch. The coordinator also prepares the
public successors: exact observed head, explicit removals / fresh additions,
current nonces, true renewal of a leaf certificate and original
outbox protected until the receipt. Eleven additional scenarios exercise this
flow, including rotation of a singleton at epoch zero then admission.
Complete private suite: 90 tests passed. Complete catch-up,
messages and the connected scheduler / providers remain open; this is not yet a
connected user flow. No E2EE capability is enabled.

## Limits and executed proofs

The [HTTP client boundary](../../crates/rv-crypto/GROUP_HTTP.md) converts the
observations, packages, preparations, receipts and events to the private
coordinator without exporting its keys. Package metadata compared against the real TLS,
canonical hex / base64url / decimals, digests and consecutive revisions / parents
of pages are checked. The real MLS and the pins remain verified in the vault.
The Rust SDK also rejects successes and crypto errors exceeding 4 MiB, before
JSON and even in chunks. Six conversion tests, four network limit tests
and the 14 PostgreSQL route scenarios pass. Private suite: 96 passed.

The private feature `native-http` adds an asynchronous worker on top of the SDK:
identity / generation / current session verified, crypto in owned
tasks, receipt looked up before the original POST and durable cooldown. Page
reception then preview / confirmation remain distinct with the current roster.
Five HTTP scenarios with a deterministic fixture exercise the real MLS / vault, including
lost genesis / rotation responses, same new secrets at the peer,
diverging receipt, activation change, recreation after 429 and shared stop.
Initial complete suite: 100 successes; the five scenarios are re-verified
after the addition of rotation.

The combined private worker / Rust server / PostgreSQL bench also passes: real
devices enrolled and packages published over HTTP, targeted genesis / admission,
rotations by each peer. After responses cut off following the server commits,
fresh Managers / SDKs reconcile the receipts without a new POST. SQL counts
exactly two publications, three transitions, one Welcome and one package
consumed; the epoch secrets of the two vaults match. The external
checkpoint of the private process is simulated in memory; no qualification of the
keyring or destruction of the private process follows from it. The test explicitly
ignored by default is mandatory in the dedicated job `native-crypto-http`.
The current bench adds messages over three epochs and the abandon of a prepared
rotation: lost terminal response, resumption without republication, late POST
forbidden and same group secrets kept. Three transitions are accepted
and a late attempt is rejected; a group abandon marker is
recorded without a new revision. Scheduling in the providers,
message projection and qualification remain open.
No E2EE capability is enabled.

The limits accumulate: 128 members, 256 devices, MLS index ≤ 4,095,
proof ≤ 256 KiB, tree / commit / individual Welcome ≤ 1 MiB, cumulative opaque
payloads ≤ 2 MiB and HTTP request ≤ 4 MiB. A page contains at most 16 events
and bounds the opaque bytes delivered to about 2 MiB before base64 / JSON encoding.
New transitions are limited to 256 per day per device. The SDKs
respect the crypto timeout while leaving reads / receipts available.

The tests exercise: a real add commit then MLS join through the Welcome
actually delivered, same context / tree, local ciphertext exchange,
removal commit, package consumed only once, replay / restart, concurrent
parent, genesis / refusal of cleartext and earlier uploads, departure / return,
another device of the same account, revocation wait and body expiry.
The HTTP routes are exercised by the real Rust SDK; fixtures / TS transport
preserve revisions above the integer precision of JavaScript.
Six observation scenarios add: complete / sorted private list, session
not enrolled in crypto, deactivated member, old plan after departure / return and
reactivation, limit without a partial page, real lock waits in
PostgreSQL, body expiry and stale head after a change of epoch.
The SDK flow builds its proof with the versions actually obtained over
HTTP; anonymous refusals and successes also carry `no-store`.

The [private messages batch](../../crates/rv-crypto/MESSAGES.md) adds application
ratchets, original outbox, persistent reception / echo and exact receipt in
the protected checkpoint. External routing proof and MLS author / AAD are
verified separately, with a bounded rich document. A kept result is resumed
after reopening; a late refusal consumes neither generation nor position.
The last received position does not amount to validating a complete page of the journal.
The private core remains distinct from the [opaque message routes](E2EE_MESSAGES.md)
and their ordered journal; their wiring to the worker remains open and no
capability is enabled.

Remaining open: continuation of the group coordinator in the vault, consent
ceremony and policy verified in the apps, historical validation and
wiring of message delivery to the vault, Android bridge, existing screens, archives /
files / imported history and independent crypto review. This batch does not close
J4 and does not authorize the J5 switch.
