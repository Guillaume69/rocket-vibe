# Publication of MLS admission keys

The `packages::Coordinator` module prepares the KeyPackages from the same protected
vault as the identities and groups. It directly uses
`rv_protocol::e2ee::PublishKeyPackages` and `OperationReceipt`: no private HPKE
key, signing seed or MLS ratchet leaves the vault provider.
This contract wiring launches no network request and does not enable E2EE.

## Transport flow

1. After the device is registered, pass its exact decimal revision
   to `prepare(revision, count, now)` on the owned worker of the vault.
2. The engine generates the private keys, the real TLS packages and a random
   operation ID in a transaction. The outbox keeps the exact public DTO,
   its RFC 9420 references and its identity bindings. The result is only
   handed over after the checkpoint is confirmed by the protected storage.
3. Send this DTO through the existing transport `crypto_publish_key_packages` /
   `cryptoPublishKeyPackages`. After a lost response or restart, `retry`
   provides the same public bytes and the same ID. A repeated preparation
   with the same parameters also finds the initial batch; other
   parameters are refused as long as the publication stays pending.
4. `pending_lookup` provides only scope and ID to consult the operations
   route. It does not fabricate an accepted receipt. An expiry, revocation
   or consumption by a Welcome forbids resending, while keeping this
   lookup possible.
5. Hand the real HTTP receipt to `confirm`. Instance, data epoch,
   ID, operation kind, device, incarnation, revision, root and ordered list
   of references must match exactly. Each refusal
   cancels the transaction; the original ACK kept allows resumption after
   a lost checkpoint. A historical ACK reauthorizes no new send.

The last ACK can be replayed without erasing the next outbox. A new
preparation generates its own ID inside the vault; the caller cannot
reuse an old ID to fabricate other keys. A certificate renewal
does not replace the bytes of the request already prepared. Revisions
beyond JavaScript integer precision stay strings; the
bound is that of the PostgreSQL server, canonical positive signed 64-bit integer.

## Duration, consumption and bounds

A batch contains 1 to 8 packages, of 16 KiB TLS at most each. They use
OpenMLS 0.9.0, suite 0x0001, without the last-resort extension. Their maximum duration is
24 hours, bounded by the expiry of the local certificate; the initial date
tolerates five minutes of skew. The duration is also verified with the OpenMLS
system clock. Root, device, incarnation and signing key must
match the installation. A root substitution or local revocation
observed blocks the publications and the group preparations.

The publication keeps the private bundles after the ACK: only a real Welcome
consumes them in the MLS admission transaction. If this Welcome arrives before
the recovery of the publication ACK, the resend is refused but the original
receipt can still be reconciled. The next preparation removes from its
index only the bundles actually absent from the provider after this
consumption; it never recreates their reference.

The index is bounded to 64 kept bundles and its private document to 2 MiB, within
the global 16 MiB vault. Time alone destroys no key: an accepted
Welcome may still wait for an offline device. If the unused keys
occupy this bound, the preparation is refused. The server reconciliation
allowing removal of expired packages never admitted, as well as the handling
of a definitively refused publication or a revision replaced without ACK,
remain to be integrated into the full network flow. There is no automatic
abandon based on a delay or on a mere absence of HTTP response.

This retention does not provide forward secrecy of the old copies of the
vault; the guarantees and limits of the [storage](README.md) still apply.

## Proofs and next steps

Nine scenarios test the real DTO, reopening, the exact MLS references,
decimal revisions, substituted ACK fields, the order of references,
the checkpoint interruptions of preparation / ACK, expiry,
revocation, invalid parameters / clocks, the retention limit and
its release after a real join. A key recovered after an interruption
does allow an MLS join; an already consumed key can no longer
be republished. The public lookup exposes only the ID and the scope.

The nine coordinator scenarios pass, with strict Clippy and the system
backend; the latest vault suites are recorded in the J4 tracking.
The latest changes of the publication module also pass their targeted suite. The Linux /
Windows / macOS CI qualifies its compilation / test platforms; it does
not replace the qualifications of installed keychains or devices.

The optional `native-http` worker now coordinates the transport and its
device observations with this outbox. The combined bench verifies two
real publications over HTTP / PostgreSQL, then MLS admission and rotations:
the first lost response is reconciled from a new Manager / SDK without
resending the POST nor recreating the keys. See [GROUP_HTTP.md](GROUP_HTTP.md) for
the scenario, its commands and the limit of the simulated checkpoint.

Next for J4: reconcile definitive refusals / expired packages and replaced
references, deliver the durable encrypted messages,
then wire the engine into the existing providers and screens. Archives,
files, offline admission across several epochs, import and independent
review remain open. `capabilities.e2ee` stays false.
