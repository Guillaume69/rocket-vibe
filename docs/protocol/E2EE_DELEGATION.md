# Delegation of control

An account's E2EE identity is an Ed25519 root ([IDENTITY.md](../../crates/rv-crypto/IDENTITY.md)).
The device holding its private key, the **controller**, is the only one that approves a
new device, withdraws one, renews certificates and backs the root up; the others are
delegated devices with only their own certified leaf. Before this document, control
moved only through the root backup code ([E2EE_ROOT_BACKUPS.md](E2EE_ROOT_BACKUPS.md)).
Delegation hands it to another registered device of the same account, so the account
keeps a controller when the first one is retired. No production capability is enabled
by this document.

## Carried by a history share

Delegation reuses the device-to-device history share ([E2EE_HISTORY.md](E2EE_HISTORY.md)),
which already has every property it needs: the receiving device publishes a request
signed by its certified leaf with a fresh X25519 key; the controller checks that the
request comes from a device of its own verified directory (same root, never revoked),
the human compares the request fingerprint shown on both devices, and the envelope is
sealed with HPKE to that key, bound to the request fingerprint and the manifest.

When the controller's human chooses **"Share and hand over control"**, the envelope's
plaintext gains a `root` field: the private root (`{root, seed}` as stored by
`Issuer::save`), hex. The choice is recorded in the share job before any upload, so a
resumed share keeps it; it can be added to an unfinished job but never removed, and
only a device holding the root can make it. An ordinary share omits the field; the
public vector is unchanged.

## Adoption

Opening the share keeps the received root aside, in the same commit as the import job.
The account then adopts it only if it is **exactly the account's root** and its seed
derives that root's public key: the root is saved and the device becomes a controller.
Any other root is dropped. Adoption is replayable after a crash and runs on every import
step until done.

## Limits

- Control cannot be taken back: once a device holds the root, only replacing the root
  (a new identity, with every pin verified again) removes its power. The apps say so
  before the human confirms.
- Several devices may hold the root at once; nothing coordinates them beyond the
  server's CAS on device registrations and revocations.
- The server learns nothing: the root travels only inside the HPKE envelope.
