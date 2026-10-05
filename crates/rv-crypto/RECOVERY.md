# E2EE root recovery: format v1

`identity::recovery` backs up the account identity of [RFC 0002](../../docs/rfcs/0002-e2ee-native.md).
It restores the ability to certify a **new leaf**, without exporting
or restoring the old MLS sending state. This batch stays outside the apps and does not
yet recover the historical messages / files.

## Secret and backup

`RecoverySecret::generate` fills a 32-byte key with OS randomness, in a
buffer wiped on drop. The secret has no `Debug`, no `Clone`, no serde. It is
independent of the HTTP password, the sessions and the account recovery
codes. `for_display` produces a temporary `Zeroizing<String>` string, reserved
for the explicit display / copy of the code. No network flow, log or index must
receive it. The adapter will also have to wipe its view state on lock.

The code has 78 characters: `rvk1-`, 64 hexadecimal digits, `-`, then 8 checksum
digits. The latter is made of the first four bytes of
`SHA256("rocketvibe-recovery-code-v1\0" || key)`. It detects typing errors,
without authenticating an account. The parser bounds the size before allocation and
accepts lowercase / uppercase hexadecimal; a password is not a code.

`RootBackup::seal` exports only an encrypted package. XChaCha20Poly1305 uses
this recovery key and a 24-byte OS nonce different for each
backup. The AEAD is the [pinned RustCrypto implementation 0.10.1](https://docs.rs/chacha20poly1305/0.10.1/chacha20poly1305/).
The public root, the random backup ID and its creation instant are
authenticated in the AAD. The service may store the opaque package; it holds
neither the code nor the private key.

## v1 encoding

The [ordered JSON rules](IDENTITY.md) apply. The package has the fields
`header, nonce, ciphertext`. The header has the order
`version, root, backup_id, created_at`; `version=1` fixes XChaCha20Poly1305.
`backup_id` has 16 non-zero bytes, `created_at` is a Unix timestamp in seconds.
Root and byte arrays follow the v1 encoding of the identities.

- AAD: `UTF8("rocketvibe-root-recovery-v1") || 0x00 || JSON_compact(header)`.
- Plaintext: object `root, seed`, with the 32-byte Ed25519 seed; it is bounded
  to 4096 bytes and wiped on drop, as is the temporary decoding buffer.
- Nonce: 24 bytes; ciphertext: at most 4096 bytes plus the 16 bytes of the tag.
- JSON package: at most 24 KiB, accounting for the expansion of the byte
  arrays; unknown fields and unsupported versions are refused.

The root of the plaintext must be identical to the header and to the expected root; the
public key derived from the seed must also match. An authenticated AEAD package
containing another root / seed is refused.

## Restoration and lost confirmation

The first restoration requires a blank OpenMLS vault / provider. It
never replaces an identity or a leaf already present. The adapter
confirms the expected root and verifies account / instance / epoch / generation
of the action before calling `restore` on the protected worker. HTTP does not provide
this consent. The public result only leaves after the checkpoint is confirmed.

In the same commit as the root, `crypto-recovery-import-v1` keeps the
fingerprints of the root and of **this exact package**: SHA-256 of the compact JSON of the package
rebuilt in v1 order. If the checkpoint / result is lost, repeating the
same restoration with the correct code finds the result again. The repetition is
a read: it removes no leaf, request or MLS data created since.
Another package, even for the same root, cannot borrow this receipt. An
incorrect code stays refused on replay.

The new device then generates its key and incarnation through the
[enrollment flow](ENROLLMENT.md). It must receive a new authorized Welcome / commit.
Neither old ratchet, consumed KeyPackage, outbox, correspondent pin,
nor revocation is imported by this package.

## Remaining conditions

Holding the code and the package gives the private root key: both must be
protected. This backup is deliberately recoverable and claims no
forward secrecy. Changing the code or deleting a package from the service **does not
invalidate an old copy** and its code. A compromise requires a new
root and the explicit verification of correspondents; a leaf revocation
alone is not enough. The policy on old copies of the vault stays
that of [README.md](README.md).

The `account::recovery` coordinator now prepares the package / code in
the protected vault before output, requires confirmation of the kept code before
returning the HTTP intent, settles an exact receipt and restores a new leaf.
The server and the transports handle an active version with CAS and distinct
original receipts; see [the backup protocol](../../docs/protocol/E2EE_ROOT_BACKUPS.md).
The terminal settlement of conflicts and the Android / FFI bridge are wired up.
The existing Android settings offer temporary code / confirmation /
resumption / abandon and recovery of an identity on a new device.
The GTK / SwiftUI controls use the same core: explicit display of the
code, publication after confirmation, resumption / abandon and restoration with
examined fingerprint. They wipe the texts and confirmations on close or
when moving to the background. Their CI qualification and the installed applications
remain open.
The E2EE archive and the recovery of its keys have their own format / authorization
still to be defined; this package does not promise automatic access to the history.
Without a saved code or an available root controller, this identity cannot
be recovered. Independent review and installed qualifications remain
activation conditions.

Eight tests cover code / checksum / bounds, nonce / roundtrip, distinct new keys,
alteration / wrong scope / wrong code, inconsistent plaintext,
active vault refused, transactional refusal / reopening and lost checkpoint with
replay preserving the new device. The keychain backend of these tests is
a stand-in; the real Linux keychain is tested separately by the vault.
