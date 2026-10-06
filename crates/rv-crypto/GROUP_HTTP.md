# HTTP boundary of MLS groups and messages

The `groups::wire` module converts the public DTOs of `rv-protocol::e2ee` into
the protected coordinator. A conversion approves no root, no device
and no MLS epoch. The network and the UI callbacks stay outside the vault
lock; the private validations / decisions and mutations stay in the owned
worker of the coordinator.

## Observations and preparation

[Interrupted transitions](GROUP_SETTLEMENT.md) keep their original in
the vault even after a peer successor. `cancel_group` checkpoints the abandon
intent before HTTP and validates the terminal receipt before releasing the commit.
Accepted rotations stay ordered by the journal.

A Welcome for an already accepted room now goes through a
[readmission](READMISSION.md) preview: `EventKind::Readmission`, fresh package,
confirmation bound to the old state and atomic replacement of the group / cursor
in the same vault. The previous cache stays protected and does not become a
visible page of the new admission. The interfaces remain to be wired up.

The [existing desktop provider](../../apps/desktop/docs/NATIVE_CRYPTO.md)
now attaches this worker to its HTTP client and to its session generation.
`Worker::new_guarded` checks a `Lifecycle` before / after the waits and on
entry to the owned private work. Its stop is terminal and shared between
clones. The validated discovery refreshes the capability guard without a second
request. No network and no vault callback inside this guard. Operations
already in the checkpoint phase finish under their lock and do not return their
result to a closed access. This wiring does not yet fill in the creation /
device / pin controls nor the projection of the interfaces.

`Genesis::from_wire` takes the current roster without a group, a new non-null room
incarnation, the operation and the available package responses.
`Change::from_wire` takes the roster with its head, the explicit withdrawals and the
fresh packages. These objects then go through the previews / confirmations
and preparations described in [GROUP_COMMITS.md](GROUP_COMMITS.md).

The headers must designate the same instance, generation and room. The roster
is complete, bounded to 128 users, sorted and free of duplicates; IDs and nonces
are canonical. Each package response is bounded before decoding. Its real TLS
KeyPackage is validated: suite, signature, public certificate, identity / UID /
device / incarnation and RFC 9420 reference match the metadata.
Neither the server metadata nor this validation replaces the vault pins
or the verification of the certificates at preparation time.

`Submission::to_wire` keeps the original public bytes. It verifies the historical
signature and the exact match between proof, operation, scope, tree,
commit and all targeted Welcomes before encoding. It recreates no commit.
The vault retry remains responsible for verifying current trust / expiry.
Private keys, OpenMLS state, ratchets and signers do not appear in the DTO.

Package references are base64url without padding; incarnations and
receipt fingerprints are lowercase hexadecimal. HTTP revisions / epochs
stay canonical decimal strings within the PostgreSQL `i64` range.
Epoch zero is allowed, revision zero is not. No passage through
a JavaScript number and no normalization of an ambiguous form is performed.

## Reception and resumption

`Receipt::from_wire` decodes the exact receipt for `Coordinator::confirm`; its
fields are all still verified against the private outbox. `Receipt::from_state`
also checks the public proof and the tree digest of a head
response. The flag `needs_rekey = false` is not a permission to encrypt.

`Admission::from_wire` requires the event's targeted Welcome and the independently
observed roster. `Commit::from_wire` concerns a successor without a new local
Welcome. Proof, receipt and digests must match. Their acceptance
remains subject to the real MLS validation, to the approvals and to the nonces in
the vault. An old Welcome is not rejected merely because a more
recent head exists if the observed versions still match its plan.

`wire::validate_page` bounds the page to 16 events, verifies scope, consecutive
revisions starting from the cursor, parent / epoch between events and exact next
cursor. The cumulative payloads respect the 2 MiB bound, with the same
exception as the server for a single complete event. This check does not
replace the catch-up policy across membership changes.
A first parent must still match the local state before merging.

The Rust SDK also bounds the `/api/v1/e2ee/` responses to **4 MiB before Serde**,
via announced length then sum of chunks, for successes and errors. This
bound covers the largest event allowed after JSON / base64 encoding. The
receipts, reads and `Retry-After` rules keep their behavior; an
incorrect response returns `InvalidCrypto` with no private content in the error.

## Experimental asynchronous worker

The optional `native-http` feature exposes `delivery::Worker` on top of the
existing SDK. Each call verifies anonymous discovery, instance / generation,
account and the single current device session. Clones share dispatch order and
stop; a new view generation must stop its old
worker. Crypto and checkpoints run in owned blocking
tasks; no network call takes place under the vault lock. The stop
prevents the publication of the result of an old generation; private work
already launched keeps its lock until it completes.

`preview_genesis` / `preview_change` collect the public roster and packages,
then produce a protected opaque consent. The preparation keeps
the outbox before the network. `resume_group` first looks up the personal receipt;
only a 404 allows the original retry after the trust /
expiry checks. An exact receipt is necessary for the merge. A lost response,
divergent receipt or refusal keep the request for reconciliation.
`publish_packages` / `resume_packages` also follow the receipt lookup
before resending the original batch; the device must already be registered and its
revision comes from the authorized public observation.

A 429 on POST saves in the vault its delay, bounded to 300 seconds.
A new worker / client respects this delay, but may consult a receipt
and complete an already accepted operation. Each call makes one attempt;
the provider must still handle wake-up, suspension and the pace of resumptions.

`events` loads the head and the page from the accepted local receipt, refuses rollback /
observed fork and validates the public envelope. Each event then requires
`preview_event` / `accept_event`, with a roster observed anew at
acceptance. A page or a head is worth no approval.

## Application messages

`MessageSubmission::to_wire` / `from_wire` and `from_delivered` keep the original
proof and ciphertext, with bounded decoding, canonical base64url / JSON,
digest and scope / operation / receipt exactly bound. The receipt conversions
preserve the opaque Header, fingerprint, server ID and decimal position, including
beyond `2^53`. This form validation does not replace the authentication
of the certificate, signature, MLS author and AAD in the vault.

The worker adds `send_message(room, SendMessage)`: observation of the current head /
roster, private preparation / checkpoint, then receipt lookup before POST.
The plaintext document only enters the private task; the transport receives
the already protected opaque bytes. `resume_message(operation)` first looks up
the own receipt from the vault's historical metadata. An exact receipt
confirms the operation without a new send, even after certificate expiry,
roster change or during a POST cooldown. Only a 404 allows
an original retry, after a new check of head, rights, pins and expiry.
A refusal does not silently release the outbox nor re-encrypt its document.
`cancel_message(operation)` explicitly settles the original intent: an
earlier acceptance wins, otherwise the server forbids any late POST and the
vault keeps the document with a terminal marker. Exact replay, expired
certificate and loss of confirmation are handled without new encryption.
[Final settlement](SETTLEMENT.md).

`receive_message(ApplicationMessage)` observes the current group, converts the
frame and calls the coordinator in an owned task. The real author / AAD,
content and ratchet are validated; the plaintext result is only returned after
checkpoint and a check of the worker stop. Reopening, duplicate and own echo
use the retained private content. An unknown message from an old head
stays refused: this API does not yet provide historical catch-up nor a
complete journal prefix checkpoint. Providers must not
advance a page from this message confirmation alone nor keep
the plaintext document in their ordinary public cache.

The initial batch of messages adds five fixture HTTP scenarios: lost confirmation / fresh
worker, real decryption by the peer and the echo, identical retry after absence
of commit, own rotation blocked, divergent receipt, ACK after expiry and
without roster, and durable cooldown leaving the confirmations available.
The ten HTTP scenarios pass in 2.85 s; two conversion scenarios with
real packets pass in 0.89 s. The combined bench is extended to six messages
over three epochs, with responses lost after the real server commits.
It passes in 29.76 s: six message POSTs, six opaque rows, nine delivery
frames and no plaintext document in SQL. The two reopened vaults
find again the rich text, exact quotes, cards and thread reply.
The fixture consumes each epoch before its rotation; it does not qualify
a catch-up of missed epochs. The private suite of this batch counted 118 successes
in 162.91 s, with the ignored child executed by the crash parent, without filter.

## Protected journal pages

`journal_page(room)` uses the vault cursor and the fixed window of the opaque
journal. Decryption, transitions, private content and full prefix share
the same checkpoint. A late error cancels the whole page. The historical
rosters come from the signed plans / real MLS trees; the own admission
must stay identical to the current observation. `journal_last_batch(room)`
resumes the last batch after reopening without new consumption.

Once this journal has started, the ACK of an own rotation keeps the old
epoch until the messages preceding its position have been read. The isolated
message / commit APIs refuse to bypass the order. Six private tests
and the real HTTP / PostgreSQL bench pass; the rules, proofs and limits
are in [JOURNAL.md](JOURNAL.md). The real bench now covers the protected
pages and their replay after reopening; the catch-up of three missed
epochs is proven separately against real MLS groups on disk.

## History of group verifications

Six vault scenarios go through the real DTOs with commits and private databases:
genesis / join / rotation and same epoch secrets, exact HTTP retry,
revisions above JavaScript precision, substituted package metadata,
stale roster / scope / nonces, modified payloads / Welcomes and
pages with a truly missing event. The full private suite counts
96 passing tests, plus the crash child executed by its parent; the six
targeted scenarios are verified again after the chaining was hardened.

Four SDK network tests cover excessive `Content-Length` without a body,
excessive chunks on success and error, JSON / big integers preserved and
`Retry-After` without blocking GETs. The 14 group route tests against
PostgreSQL, including the real SDK over HTTP, also pass.

The worker also goes through HTTP, real MLS and the on-disk vaults in
a deterministic network fixture: lost genesis response and resumption without a
second POST, lost rotation keeping its parent until the receipt then peer
catch-up with the same new secrets, incorrect receipt / changed activation,
429 preserved and stop / identity change. These five scenarios do not by themselves
constitute the combined private worker / Rust server / PostgreSQL bench. The
initial full worker suite counts 100 successes and the crash child
executed by its parent; the five HTTP scenarios are re-verified after the addition
of the rotation case. Formatting and strict Clippy pass with both features.

The combined `delivery_smoke` bench also passes against the real Rust router and
PostgreSQL: devices / certificates registered over HTTP, two publications
of real packages, genesis, targeted Welcome, then rotations by both authors.
The server deliberately loses the response of the first publication and of
each transition after the real commit. Each resumption reopens the vault with a
new Manager / SDK and finds the receipt: two publication POSTs and three
transition POSTs in total, three SQL events, a single Welcome and a single
consumed package. The local parent stays active before ACK and the peers'
MLS secrets agree at each epoch. Sending in plaintext is then refused.

The private fixture is a separate process, with no access to `DATABASE_URL`, with
temporary tokens via stdin. Its SQLite is real; its external checkpoint
storage is simulated in memory. This bench does not prove resumption after destruction
of the private process nor the physical keychains. The real Linux Secret Service
bench remains a distinct proof. The initial combined scenario passes in 12.62 s;
the 15 group route tests pass together in 14.05 s. The scenario is
re-verified after removal of the client SQL environment in 12.36 s.
The `native-crypto-http` CI job always provides the binary and runs this test,
explicitly ignored in the general suites, so as not to mask its
absence with a conditional positive result.

To replay it under Linux with `DATABASE_URL` pointing to a disposable PostgreSQL:

```sh
cargo build --locked --manifest-path crates/rv-crypto/Cargo.toml --features native-http --target-dir target/native-crypto --example delivery_smoke
RV_CRYPTO_HTTP_SMOKE_BINARY="$PWD/target/native-crypto/debug/examples/delivery_smoke" cargo test --locked -p rv-server --lib protected_http_worker_publishes_joins_rotates_and_reconciles_real_postgres -- --ignored --nocapture
```

The journal now authenticates old expired leaves without
authorizing a new POST under these certificates: current reader, same
admission and current pins / revocations remain required. Four additional
MLS scenarios pass; the policy details are in
[JOURNAL.md](JOURNAL.md). Renewal in the apps remains to be wired up.

Scheduling in the providers, reconciliation of refusals,
suspension after withdrawal and readmission in the apps, message projection, files / archives /
import, Android bridge and the existing interfaces remain open. The qualifications
on devices / keychains and the independent review remain necessary.
No E2EE capability is enabled.
