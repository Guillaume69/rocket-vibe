# Private storage for the native E2EE engine

Rust foundation of [RFC 0002](../../docs/rfcs/0002-e2ee-native.md), separate from the
[MLS prototype](../rv-crypto-spike/README.md). It has its own workspace and lock; the
server does not depend on the vault. The [core of the existing desktop provider](../../apps/desktop/docs/NATIVE_CRYPTO.md)
now consumes it with HTTP and a session-generation guard, with no
activation or implicit opening from the interfaces. The public formats / verifiers are
shared through [`rv-crypto-public`](../rv-crypto-public/README.md), consumed by the
server and re-exported here without any format change. No E2EE capability is enabled.

## Format and transaction

`vault::Vault` stores the OpenMLS RustCrypto 0.6.0 provider and the private
operation records in **a single encrypted SQLite row**. The provider is
rebuilt on every operation; no modified MLS instance is reused
after a refusal. `transact` persists in a single commit the consumption of keys,
the original outbox ciphertext and any receipts / private reception data.
`inspect` persists no mutation; groups and providers
must not escape these callbacks. This Rust API is internal to the future engine,
not an FFI surface that would let the UI modify keys directly.

- XChaCha20Poly1305, 32-byte key, 24-byte OS-random nonce per commit.
  The `rocketvibe-mls-vault-v1` domain, the instance / generation / account /
  device / incarnation scope and the revision are the authenticated associated data.
  [Pinned RustCrypto implementation](https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/).
- An authenticated JSON document contains the OpenMLS storage entries, the
  private records and the previous checkpoint. The serialized document is
  bounded to 16 MiB; the number of entries and the allocations of the SQL read are bounded.
  This full storage is not a large-scale history database.
- SQLite: WAL, `synchronous=FULL`, immediate transaction, temporary files
  in memory. SQL receives only the public revision, the nonce and the ciphertext.
  A crypto refusal, a limit overrun or an SQL failure cancels the operation.
- The file is created exclusively and never replaced. On Unix: mode 0600,
  refusal of links and of group / other permissions, synchronization of the parent on
  creation. The private parent directory owned by the OS user remains a
  precondition of the future adapter. Windows ACLs and OS persistence remain to be qualified.

Owned private buffers are wiped on a best-effort basis when released; no
guarantee is made that all copies held by libraries, RAM, swap
or a system dump are wiped. Key, document, provider and vault
do not implement `Debug`; errors contain no private content.

## Protected checkpoint and recovery

The checkpoint `(revision, SHA-256(AAD || nonce || ciphertext))` is kept
**outside SQLite in the protected storage**, together with the key. Its digest is public;
its protection against replacement comes from the keychain, not from a secret in
SHA-256. Copying it next to the database would defeat the detection of a restore.

1. Save the key in the keychain before `create`. The new vault is blocked.
   Save its initial checkpoint, then call `checkpoint_persisted`.
2. On every `transact`, save the returned checkpoint before publishing the
   network / UI result. The next read and the next transaction stay blocked until
   then. `checkpoint_persisted` requires the exact value; it is not
   proof of the OS write, which is the adapter's responsibility.
3. `open` requires the exact protected head and an authenticated document. An
   old database, another account / device or an altered head is refused.
4. After a crash **between the SQLite commit and the keychain write**, only the head
   exactly one revision ahead is recoverable by `recover_committed`.
   It must contain the protected predecessor in its authenticated document.
   The new checkpoint must then be protected before any use.

The adapter must hold an OS lock per scope during the keychain read,
the transaction, the write and the checkpoint verification. Out-of-order keychain writes
could restore an old marker. An unavailable read
never means absence; an incomplete file, a missing key or an incompatible head require
an explicit stop, never a silent re-creation of the same sending state.

`protected::Manager` wraps this cycle in an owned synchronous worker: OS
lock, keychain read, commit, write conditioned on the predecessor, confirmation
re-read, then return of the result. If the caller abandons the worker,
the OS operation keeps the lock until it completes. The lock is explicitly
released at the end, even if a process launch briefly inherited the descriptor.
Concurrency returns `crypto_storage_busy`, with no second crypto operation.
The scope and the canonical directory are bound to the protected entry: a copy
of the database under another directory / lock cannot fork the same device.

Initialization is explicit and saves the key first. A crash before the
initial checkpoint only allows resuming an authenticated genesis empty of
MLS keys / records. An incomplete file is refused; re-establishment
requires an explicit withdrawal and a new incarnation, with no implicit replacement.
`retire` saves a **keyless** tombstone, then removes only the SQLite files
of that scope. The tombstone and the lock file stay in place:
restoring an old copy does not reactivate the retired incarnation.

The optional `system-keystore` backend uses keyring 3.6.3 with the
explicit features synchronous Secret Service / Linux encrypted transfer, macOS Keychain and
Windows Credential Store, under the service `me.barrut.RocketVibe.crypto.v1`, outside
the Rocket.Chat sessions. [Library contract](https://docs.rs/keyring/3.6.3/keyring/).
Unsupported platforms do not get a fallback mock backend.
Android will require its own Keystore bridge. The session cycle of the desktop core
now stops its access; widgets, the interfaces' ceremony / keychain and
durable withdrawal of the account remain to be wired up.

## Confidentiality limit of old copies

The WAL and the backups contain **old encrypted documents**. With
a durable vault key, they become readable again if that key is compromised.
The checkpoint prevents the engine from reusing them; it does not erase them and
does not provide forward secrecy of the storage. `secure_delete` is not enough to
erase the copies on an SSD, in the WAL or in a backup. The ephemeral
key / rotation policy and the review of their destruction remain conditions of
J4. [OpenMLS storage requirements](https://book.openmls.tech/user_manual/persistence.html).

MLS is not the recoverable archive required by the RFC. This crate still provides
neither archive / files nor an Android bridge. The optional HTTP worker remains
experimental; its access is bound to the desktop core, while the ceremonies,
keychains and projection of the interfaces remain to be wired up. The
[`identity`](IDENTITY.md) module provides Ed25519 roots, certificates, explicit
pins / confirmations and revocations; the new-device ceremony, recovery
and the room admission policy remain to be integrated. The internal
[`enrollment`](ENROLLMENT.md) flow persists the signed request and its exact Grant,
with opaque confirmation and durable replay. The [root recovery](RECOVERY.md)
provides an AEAD backup under a distinct random code and a fresh
transactional restore / exact receipt, without importing the old MLS state.
Windows / macOS keychains, Windows ACLs,
restoration of keychain backups and power loss remain to be qualified.

## Group preparation and receipt

`groups::Coordinator` prepares the genesis in the protected vault. The preview binds the
room scope / incarnation, policy, membership nonces, packages, pins and
local certificate to an opaque confirmation valid for five minutes at most.
Each remote device requires an observed root and a persistent approval.
`LocalDevice::create_bound` also binds the leaf incarnation to the chosen vault
before its creation; the private keys are still generated inside the transaction.

The real MLS commit stays **pending** until the exact receipt: scope, operation,
revision, epoch and transition fingerprint must all match. The signed tree
uses the real leaf indices of a validated `PublicGroup`, without
merging the commit prematurely. Commit, Welcome, proof and MLS state are
persisted together; no byte is handed to the transport before the
protected checkpoint is confirmed. After a stop or a lost response, `retry` finds
the original bytes again, without generating a new genesis.

A change of pins or an expiry forbids retransmission. The receipt lookup
stays available: an already accepted receipt can finalize the historical state,
without re-authorizing a new send. `ready_epoch` is only a diagnostic.

`preview_admission` validates a real Welcome in a temporary copy of the provider:
no package consumption is persisted. The confirmation also binds the current
memberships / activations, observed independently. `accept_admission`
re-verifies the real consumed package, its certificate / incarnation, the MLS author
of the Welcome, each leaf and pin, the ID / context / tree / epoch. Consumption,
joined group and receipt are saved together before any success is returned to the apps.
A late refusal cancels the MLS writes; a lost checkpoint only resumes
the exact historical acceptance. Neither an unknown root nor an unknown device is
approved automatically by a valid transition signature.

The [commit reception](GROUP_COMMITS.md) now verifies the real MLS author,
the routing AADs and the additions / references, then keeps the successor with
its receipt. A concurrent local commit is replaced only after validation; the
refusals also cancel the MLS mutations. References already observed stay
remembered after withdrawal. `confirm` also handles the receipt of a preparation
following an active group; joins preserve the tree configuration.

`preview_change` / `prepare_change` now prepare rotation, additions, withdrawals
and atomic replacement with the observed server head and the current nonces.
The outbox keeps the exact request before checkpoint / network; the group only
merges at the exact receipt. The retained references stay those of their
initial admission; a readmission requires a genuinely fresh package. A renewed
local certificate modifies the actual MLS leaf. See the
[protected transitions](GROUP_COMMITS.md).

The [HTTP boundary](GROUP_HTTP.md) now converts roster / packages /
preparations / receipts / admissions / successors through the shared DTOs, with
canonical encodings, exact revisions, digests and verified page chaining.
The conversions grant no trust and no permission to send. The SDK
bounds the crypto responses before the JSON. The `native-http` feature provides an
asynchronous worker: verified account / device scope, owned private work,
receipt consulted before resending the original and durable POST cooldown after re-creation.
Admission / successor require their preview and confirmation with the current roster.
The HTTP bench uses a deterministic fixture with the real MLS / vault. A
separate private process also runs publication / genesis / admission / two
rotations against the real Rust / PostgreSQL server, with lost responses and
reconciliation without an extra POST. Its external checkpoint is simulated;
scheduling in the apps and the physical qualifications remain open.

The [application message coordinator](MESSAGES.md) now keeps
MLS ratchets, original ciphertext / outbox, private content and receipt / last
reception position in the same checkpoint. Routing, real MLS author and
rich document are authenticated; resends / echoes use the exact protected
bytes and a local rotation waits for the ACKs of pending messages.
Message journal / HTTP, full catch-up and projection in the apps
remain open; E2EE stays disabled. See the
[delivery contract](../../docs/protocol/E2EE_GROUPS.md).

## Verifications

The [publication coordinator](PACKAGES.md) also keeps the genuine private
KeyPackages with their exact public HTTP request before emission.
Reopening / a lost checkpoint resume the original batch; a substituted ACK,
expiry, revocation and an already consumed package are refused. A past receipt
can be reconciled without authorizing a new send. Packages are removed
from the index only after MLS consumption, with a retention bound of 64.
The module uses the shared DTOs; transport / confirmed abandonment / cleanup
of expired ones and wiring into the apps remain to be integrated.

```sh
cargo fmt --manifest-path crates/rv-crypto/Cargo.toml -- --check
cargo clippy --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --all-targets -- -D warnings
cargo test --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target
cargo test --locked --manifest-path crates/rv-crypto/Cargo.toml --features system-keystore --target-dir target
node crates/rv-crypto/scripts/verify-identity-vector.mjs
```

Seventy-nine Linux scenarios pass, including the OpenMLS exchange between two genuine reopened
databases: consumption / original ciphertext preserved, altered reception
cancelled then original accepted, and replay refused. The other proofs cover AEAD,
scopes, restored old head, concurrent author, SQL failure, limits, incomplete
file and Unix permissions / links. Two forced process stops bracket
the SQLite commit: before the commit, original state; after the commit, resumption of only the
authenticated successor. The child test marked `ignored` is executed by this
parent test and killed at the boundary; it is not an omitted scenario.

The coordinator proofs also cover errors / lost responses of the protected
storage, interrupted initial checkpoint, repeatable purge, copied database, parent
permissions and a lock held during a delayed write. The vault's MLS fixtures
use uncertified BasicCredentials. Nine additional identity tests
verify the real KeyPackages / certificates, key / root substitution,
expiry / scope, refusal without approval, old confirmation,
persistent revocation and a root backed up in the vault. The public signed vector
also passes the independent Node verifier. Eleven device-addition scenarios
cover proof of possession, limits / expiry / clock rollback, old confirmation,
substituted Grant, real KeyPackage, transactional refusal and original receipt
found again after a lost checkpoint. The public request / Grant vector
is also verified under Node / OpenSSL.
Eight recovery scenarios verify code / checksum, AEAD / scope / bounds,
consistent private key, refusal of an active vault, transactional refusal, reopening and
replay after a lost checkpoint without erasing the new leaf.
Nine group scenarios verify a real join by Welcome and the same epoch
secrets, commit not merged before the receipt, identical reopening / retry, each
altered receipt field, lost checkpoint, stale consent, pins / revocation,
expired certificate, scope / incarnation, solitary genesis and observation bounds.
Eight join scenarios cover preview without consumption, real persisted
group / same secrets, single-use package, validly signed but false
metadata, different MLS author, corrupted Welcome, room memberships / epoch,
approval of each recipient, application refusal after crypto and historical
resumption after a lost checkpoint.
Nine publication scenarios verify the HTTP DTO, real references / dates,
exact decimal strings, each receipt field, checkpoint resumption,
prohibition of resending after consumption / revocation, join with the
package found again and release of the retention bound after a real admission.
Eleven reception scenarios verify genuine rotations / additions / withdrawals,
signed proof inconsistent with MLS, false author / AAD / Add reference,
reuse after withdrawal, application ciphertext refused without consumption,
nonces requiring readmission, own ACK / concurrent replaced only after
success, late refusal after merge and historical resumption after a lost checkpoint.

[`scripts/keystore-smoke.sh`](scripts/keystore-smoke.sh) uses a **real Linux Secret
Service**, its disposable XDG directories and several CLI processes. One
process is killed after the SQLite commit, before the protected write; a concurrent one
is refused during the lock. A new bus / daemon finds the key again, confirms
the successor and the original outbox bytes, then retires the incarnation.
This bench passes under Fedora in the existing container, with `--cap-add IPC_LOCK`.
No user profile of the host is connected.

The CI has a Linux / Windows / macOS crypto matrix: formatting, Clippy, tests and
compilation of the native backend; Linux also runs the real keychain bench.
The `native-crypto-http` job compiles the separate private binary then exercises the
coordinator over HTTP / PostgreSQL; its tokens go through stdin and the
client process does not receive the SQL credentials. Its simulated external checkpoint
stays distinct from the qualification of the real keychain.
Server / mobile validations and long client drivers remain mandatory for client / server changes,
workflow, unknown base, or a crypto engine consumed by an app. Only crypto
batches that are still isolated, and Markdown, may skip them. Detection targets the exact
private dependency, including renamed / indirect; `rv-crypto-public`
alone does not add a vault to the server. The tests do not qualify
power loss, installed keychains or an independent crypto review.
J4 stays open until integration and review.
