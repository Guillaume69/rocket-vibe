# Device enrollment: isolated engine v1

`identity::enrollment` completes the [certified identities](IDENTITY.md) with a
proof of possession, a local approval bound to the exact request and its durable
private receipt. No additional capability or interface is enabled.

## Flow and storage

1. In a new vault, `LocalDevice::create` generates an Ed25519 leaf key
   and a random incarnation. The expected root must already have been confirmed
   by the identity flow; a root supplied over HTTP does not become trusted
   because it appears in the request. An existing key is not replaced.
2. `request` creates and saves a request signed by this **leaf key**.
   It binds root, device, incarnation, a random 32-byte ID, key and a window
   of at most 10 minutes. A replay resumes exactly the same request / expiry.
   An expired request may be replaced, keeping the key and the incarnation.
3. On the controller that holds the private root, `Issuer::preview_request`
   verifies the proof and returns an opaque consent bound to the root, request,
   registry state and chosen certificate expiry. The UI will have to present the
   fingerprint / QR of the request to compare with the new device. A
   server notification, HTTP session or proof of possession is not a human
   agreement. The token cannot be deserialized from the network.
4. After confirmation, `approve_request` signs the certificate and a `Grant` that
   binds this certificate to the fingerprint of the request. The `crypto-issuance-v1`
   registry persists this result in the same commit. Repeating this request returns the
   original Grant; reusing its ID with other content or confirming another
   request with a stale preview is refused.
5. The new device verifies the Grant, its root signature and its exact link
   to the private request still pending. `install` saves the certificate and
   removes this pending state. A different key / incarnation or an old Grant
   presented for a new request is refused. An already installed replay does not
   remove another pending renewal request.

`crypto-device-v1` contains the leaf seed, the request and the Grant in
the encrypted records of the vault. `LocalDevice` has no `Debug`, no `Clone`,
and no private export. It implements the
[OpenMLS 0.6.0 `Signer`](https://docs.rs/openmls_traits/0.6.0/openmls_traits/signatures/trait.Signer.html)
to create the KeyPackages / messages with the certified key. An object loaded
before another write cannot overwrite the new record.

These methods are internal: they run inside a
`protected::Manager::transact` callback on the owned worker. The request or the Grant
is only handed to delivery after the protected checkpoint is confirmed. A
refusal cancels the registry; if the checkpoint write fails after the commit,
resumption finds the original Grant again. The MLS state / `LocalDevice` must not
leave the callback, nor be reused after a refused transaction.

The registry keeps at most 256 still-replayable receipts / 2 MiB. Receipts whose
request has expired are removed on a new issuance; the expired
request stays refused before this processing. The last issuance instant is
persisted: a clock rollback before this marker does not reopen an
old window after purge. `now` comes from the worker's local clock, never from HTTP.
These bounds do not evict a still-replayable decision to make room.

## v1 frames and vector

The JSON / NUL domain rules of [IDENTITY.md](IDENTITY.md) apply:

| Object | Payload order | Domain |
| --- | --- | --- |
| Request body | `version, root, device, incarnation, request_id, signature_key, issued_at, expires_at` | `rocketvibe-device-request-v1`, leaf signature |
| Request | `body, signature` | `rocketvibe-request-fingerprint-v1`, SHA-256 |
| Grant | array `[request_fingerprint, certificate]` | `rocketvibe-device-grant-v1`, root signature |

The network Grant JSON contains `request, certificate, signature`. The explicit
`from_bytes` decoders are bounded to 4096 bytes for a request and
8192 for a Grant; unknown fields / duplicates / legacy formats are refused.
Decoding is not verifying: the verification and the scope / pending
checks must then be called. Signatures and fingerprints are byte arrays;
nested objects follow their v1 order.

The [public vector](fixtures/enrollment-v1.json) uses the same public fixture
seeds as the certificate, and a request ID `[5; 32]`. It passes the
Rust production verifiers and the independent Node / OpenSSL verifier:

```sh
node crates/rv-crypto/scripts/verify-identity-vector.mjs
cargo run --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --example enrollment_vector
```

## Renewal of the registered incarnation

The shared coordinator offers an explicit renewal request.
It authenticates the historical certificate and the current receipt of the device,
including after expiry, without using them to authorize a new MLS send.
A date earlier than the issuance, a replaced root, a substituted revision
or a signed withdrawal refuses the ceremony. The directory certificate must
be exactly the installed one, not merely contain the same public key.

The request keeps root, incarnation, signing key and vault. A second
device transmits its request to its root controller; the controller compares
and approves explicitly, even if its own leaf certificate has expired.
The expiry of this leaf does not destroy its root authority. A request
still valid is resumed without extending its duration; its renewal after
expiry creates a new request and invalidates the old approval.

The previous valid certificate can still be used as long as only the request
is pending. Installing the Grant keeps the previous certificate and receipt
as a private baseline, checkpoints the original record and suspends
new conversation accesses until its exact ACK. The desktop adapter closes
the previous workers at this installation. A server that accepted the POST
before a lost response is queried by the original ID before any new
publication; revision, scope, device, incarnation and root of the receipt are
checked. The old baseline is only deleted after this ACK.

Earlier records stay readable; the optional private renewal field
is only written during this intent. The Android, GTK and SwiftUI settings
expose the expiry, the request / approval and the resumption.
They do not automatically emit an MLS commit. The existing controls of
each room flag the gap between its effectively verified MLS leaf
and the installed certificate; the explicit transition updates this leaf.
The new certificate does not authorize a send before this update. The accepted
HTTP receipt keeps the old epoch until the exact position of the commit
in the journal, in order to read the preceding messages. History and draft
stay in the same vault. The desktop bench exercises renewal, real HTTP,
lost rotation, resumption without a second POST and a new send; the mobile bridge
exercises two MLS actors and the reception of the renewed commit. The mobile receipts
of this bench are synthetic. The controls of the three clients now allow
explicitly replacing a renewed peer: withdrawing its previous leaf
and adding a fresh package in the same commit. A rotation
keeping an expired peer and an addition without withdrawal stay refused. A readmission
Welcome is required; its preview does not replace the group, its confirmation
removes the old message cache and its drafts. This change does not promise
an archive recovery. The engine test exercises the two expired certificates
and real MLS messages; the desktop core bench exercises selection,
HTTP and original resumption. Running the extended server bench and the
installed flows remain to be qualified.
The coordinator tests exercise expiry, second device, reopening,
incorrect receipt, changed directory and withdrawal; the desktop bench exercises real HTTP,
previous workers and lost response. Installed qualification and review remain
distinct conditions.

## Next exit conditions

Independent withdrawal uses `account::Coordinator::preview_withdrawal`
then `prepare_withdrawal` after confirmation. The opaque preview binds scope,
certificate / incarnation / revision of the target, and the exact certificate and receipt of the
controller. Another controller, a replaced target, a renewal request
or a changed certificate refuses its preparation. Expiry
does not remove root authority: the controller's authenticated historical certificate
remains necessary, without allowing a new MLS send.

The signed withdrawal and the original `RevokeDevice` are checkpointed together before
HTTP. From this confirmation, the withdrawal stays learned, even after an omission
from the directory or a reopening; only the proof for the already
established local identity is learned. An existing pin applies it immediately,
a later explicit first pin cannot resurrect the device. No device pin / agreement
is created by the withdrawal. `acknowledge_withdrawal` requires the exact receipt
of the controller and only settles the intent, without erasing the proof.
The controller's renewal waits for this ACK. The adapters reuse
their sessions and query the receipt before any original POST.
Closing during the checkpoint: the worker finishes its save, its old
viewer publishes nothing and the next view finds the exact intent again.

The existing GTK / SwiftUI / Android settings offer review, explicit confirmation
and resumption of the withdrawal. Their CI / installed qualification, the visible
recovery and the history policy after withdrawal remain distinct
conditions. Groups must still remove their old leaf
through an MLS commit; a withdrawal neither recovers nor erases the historical archive.

An installed Grant adds **neither a correspondent pin nor a room leaf**.
`Pins` and the group policy require their own approvals / commits.
The private root stays on the controller; it is not transmitted to the new
device by this format. The [root recovery](RECOVERY.md) uses a random code
distinct from the HTTP password and creates a new leaf flow.
Delegation of control and visible recovery remain to be integrated. Revoking a
leaf does not withdraw an already compromised private root.

Requests / Grants are transferred explicitly between devices. The account /
epoch / UI guards, the Android bridge and the existing security screens
are wired up; their full installed flows, the replacement of renewed
peers with the real server and the independent review remain to be qualified.
The restoration of a root must never restore an old MLS sending state.
Archive / files, room protocol and independent review remain open.

Eleven tests cover altered proofs, expiry / clock rollback, real KeyPackage,
substituted Grant, stale local object, limits / purge / parsers, transaction
refusal, vault reopening and lost checkpoint. They are engine
proofs, without qualification of a flow on an installed device.
