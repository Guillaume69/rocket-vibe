# Protected application messages

Experimental batch of the private coordinator `groups::Coordinator`, outside the apps.
`capabilities.e2ee` stays disabled. The [server routes and the opaque journal](../../docs/protocol/E2EE_MESSAGES.md)
exist separately. The [private HTTP worker](GROUP_HTTP.md) now wires up
sending / resumption and reception. The [protected journal](JOURNAL.md) adds the pages
common to transitions and messages, their checkpoint and the catch-up on
the same admission, including the signatures of leaves expired after
renewal of the reader. [Readmission](READMISSION.md) now replaces
the group in the same vault and excludes the old cache from the current projection.
Its wiring into the apps and their suspension after withdrawal remain open.

## Authentication and content

`rv-crypto-public::messages` defines a canonical header: instance / generation,
room / group incarnation, operation, revision / epoch / head fingerprint,
author / device / incarnation / certificate, `chat` kind and optional thread.
The whole header becomes the AAD of the real MLS `PrivateMessage`. An external proof
signed by the device binds this header, its certificate and the SHA-256 of the ciphertext.
New sends require a certificate valid at the observation date.
The historical journal also authenticates the signatures of expired leaves,
with current reader and current pins / revocations, according to [JOURNAL.md](JOURNAL.md).
The proof allows a public
routing verification; it does not replace the private verification
of the MLS author, the AAD, the recipients and the decrypted content.

`Proof::from_bytes` verifies bounds, form and canonical encoding. Only `verify`
authenticates the certificate and the signature, then verifies the type / group / epoch
of the real TLS message. Decoding or computing a fingerprint confers no
trust. Reception also compares the certificate of the real MLS author and its
leaf with the active list, then the exact AAD with the external header.

The versioned private document reuses `rv_protocol::SendMessage`: Markdown text,
thread reply, quote references with exact decimal revision and
integration cards. The cards and references stay in the ciphertext;
the thread identifier stays a visible routing metadatum. The file
descriptors, edits / deletions and archives are not covered by this batch.
The validation of the document is bounded before copy and identical before encryption
and after decryption. The content must be canonical and match
the authenticated operation / thread.

## Send and receipt

`MessageObservation` requires independently observed head and roster, identical
to the protected active state. Pins, certificates, real MLS leaves and current
membership are re-verified. No new or resent message passes with rekey
needed, local transition or pending MLS proposals. A local
rotation also waits for the confirmation of the messages already prepared.

`prepare_message` encrypts only once then keeps, in the same protected
commit, the consumption of the MLS generation, the original ciphertext, the proof,
the private document and the reception authorization. The bytes only leave after
the external checkpoint is confirmed. The same intent or `retry_message` return
exactly these bytes; the same ID with other content does not re-encrypt.

`pending_message` provides only the public metadata of a receipt
request, even after expiry or revocation. `confirm_message` requires all the
original fields and the same fingerprint; the server ID and position of the first receipt
become immutable. An exact historical ACK grants no right to send again.
The receipt uses a `u64` position bounded to `i64::MAX`; the HTTP / JS adapter
must expose it as a decimal string, without conversion through a JavaScript number.

## Reception and reopening

`receive_message` consumes the real MLS message, verifies its author, its content
and its scope, then keeps together ratchet, proof / ciphertext, private
document, receipt and last received position. The plaintext is only returned after checkpoint.
A late refusal also cancels the generation consumption. Reopening
finds a confirmed result without decrypting again and without a new generation.

An echo of its own send only goes through the original bytes of the protected
outbox: `OwnPrivateMessage` is explicitly unauthenticated by OpenMLS.
A forgotten operation identity or an unknown own ciphertext therefore does not recreate
plaintext. An already kept confirmed echo can be re-read after rotation if
the personal authorization stays identical; this does not allow decrypting
a new message of a past epoch.

A new operation with a position earlier than the last received position
is refused before consumption. The exact replay of a kept result cannot
move this position backwards. This value is not by itself a complete
cursor: the protected journal validates and checkpoints the common pages,
including the commits between messages. The projection into the apps remains to be wired up.
Positions may show gaps for other native events.

## Bounds and proofs

Public proof ≤ 16 KiB; ciphertext ≤ 128 KiB; private document ≤ 64 KiB;
private registry ≤ 4 MiB with 64 kept contents, 8,192 operation identities
and 1,024 group positions. The global vault limits still apply.
`forget_message` requires an exact receipt and removes the private content / ciphertext;
the identity and fingerprint of the receipt stay remembered. When the 64 contents
are reached, the oldest settled ones leave automatically: a retired admission's,
or one already held by the verified journal index of its room's current admission.
Their identity stays marked `evicted` or `retired`; a replay of the exact receipt
reads the body back from that index, never by a new decryption. Pending, cancelling
or cancelled own contents never leave. The cache stays full, and new operations
are suspended, only when nothing settled is left to evict.

The 8,192 identities are a window, not a lifetime bound. Once a body has left the
cache (evicted, retired or forgotten on request), its identity gets a release
order; when the registry is full, the oldest released identities are dropped
first. A dropped received operation stays refused: its stream position never
moves backwards. A dropped own operation ID cannot be published again either,
since the server keeps `(user_id, operation_id)` unique and answers
`409 operation_conflict`. Pending, cancelling, cancelled and cached identities are
never dropped.

The scenarios use real certified groups and reopened SQLite vaults,
with simulated external checkpoint: rich exchange, exact echo, lost / altered ACK,
send / reception checkpoint refused, false AAD / MLS author, late refused
document, altered ciphertext, unknown own ciphertext, really prepared rotation,
order of positions, bounds and explicit release of the cache. They qualify
neither the message network nor the physical devices / keychains.

The initial batch of ten scenarios passes; its full private suite counted 111 successes in
164.33 s under Linux. The only ignored child is executed and killed by its
crash parent. The `curve25519-dalek` arithmetic of the test profile is optimized, with the
coordinator assertions kept; no scenario is removed to save
time. The production profile and the apps' journal do not change.

```sh
cargo test --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --features system-keystore,native-http groups::tests::application_messages
```

Next: history policy for revoked devices, suspension and readmission
in the apps, archive / files, Android bridge and
providers of the existing interfaces, crypto review and native qualifications.

[The final abandon](SETTLEMENT.md) of a personal message is now
checkpointed: original receipt if accepted, otherwise terminal marker and recoverable
private document. The generation stays consumed; the old operation cannot
be reused and no journal position is advanced.
