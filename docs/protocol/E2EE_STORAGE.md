# Destruction of old keys

The private vault of a device ([`rv-crypto`](../../crates/rv-crypto/README.md)) is
sealed under a 32-byte storage key kept in the platform keystore (keyring, Android
Keystore) with the protected checkpoint. Before this document, that key never
changed: an old copy of the database (a backup, WAL frames, flash remnants) stayed
readable by whoever obtained the key later. Key destruction bounds that exposure.
No production capability is enabled by this document.

## What is destroyed

- **The storage key**, renewed every 30 days (`ROTATION_PERIOD`) and on request. A
  renewal draws a fresh key, seals the vault state and every private block under it
  in one SQLite commit, then replaces the keystore record so the old key no longer
  exists anywhere. Every copy of the database made before then, wherever it went,
  stays sealed for good. The WAL is then checkpointed and truncated, so its frames
  under the old key leave the device.
- **The private keys of expired KeyPackages.** A published package keeps its private
  init and leaf keys until a Welcome consumes it. One never consumed is destroyed
  seven days (`GRACE`) after its expiry, at the next publication or renewal; the
  packages of a publication still pending are kept. A device offline for longer than
  the grace period is readmitted with a fresh package, as for any lost Welcome.
- **MLS epoch secrets** are not kept past their epoch: the groups use OpenMLS's
  default policy (no past epoch, five messages tolerated out of order, a forward
  distance of 1,000), so a key consumed by the ratchet does not survive it.

What a renewal does **not** destroy, by design: the recoverable history (its keys
and codes, [E2EE_HISTORY.md](E2EE_HISTORY.md), [E2EE_HISTORY_BACKUP.md](E2EE_HISTORY_BACKUP.md))
and the identity backup ([E2EE_ROOT_BACKUPS.md](E2EE_ROOT_BACKUPS.md)) remain
readable with their codes; the documents of the archive remain readable on the
device, now under the new key. Deleting a key in the keystore does not guarantee
that the platform erased every internal copy (keychain history, swap).

## Blocks keep their references

Private blocks are referenced by `(id, digest)` from protected records and from
other blocks (the archive's skip lists), where the digest covers the block's sealed
bytes. Re-sealing a block would change its digest. A renewal therefore seals each
block again as an envelope `digest ‖ content` under the new key, with the additional
data `(rocketvibe-private-blob-rekeyed-v1, scope, id)`, and marks its row `rekeyed`.
Reading a rekeyed block authenticates it under the current key and compares the
digest it carries with the reference, so every existing reference stays valid and
a block still cannot be swapped for another. Blocks written after a renewal use the
original format until the next one.

## Crash safety

The keystore record gains an optional `next` key. A renewal writes, in order:

1. the record with the current key, its checkpoint and `next` (the intent);
2. the SQLite commit: state and blocks under `next`, one revision ahead, the
   previous checkpoint inside the authenticated document;
3. the record with `next` as the only key and the new checkpoint.

Opening resolves any interruption: if the database still matches the current key's
checkpoint, the intent is dropped (the next key sealed nothing); if it is one
revision ahead and only `next` opens it with the protected predecessor inside, the
renewal completes. Retirement removes both keys.

## Clients

Both desktop apps and the Android app check the schedule at most once an hour, in
the background, when a private conversation refreshes, and show in the existing
encryption settings when the key was last renewed, when it is next due, and a
"Renew now" button.
