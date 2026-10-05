# Encrypted history: backup with a recovery code (path B)

Path B of [history on a new device](E2EE_HISTORY.md). Path A needs another device
of the account to be online and approve; path B lets a new device recover the
history **when no old device is left**, with a recovery code the user kept. It
follows the [archive access rules](E2EE_ARCHIVE.md): archive keys are distinct from
the [identity backup](E2EE_ROOT_BACKUPS.md), with their own consent, code, version
and settlement. No production capability is enabled by this document.

Decisions (2026-10-05): a **separate** recovery code, distinct from the identity
backup code; devices that hold the history key upload **continuously** in the
background once the backup is enabled.

## Trust model

- The **history key** is 32 random bytes, generated on a device of the account
  when the user enables the backup. Only that account's devices and the holder of
  the history code ever hold it. The server stores a package sealed under the
  code-derived key, and history records sealed under keys derived from the history
  key; it never sees a key, a code or a document.
- A record is trusted because it decrypts under the history key **and** is attested
  by a device certificate chaining to the account's pinned root. A device withdrawn
  later keeps what it uploaded; the server refuses uploads from a withdrawn or
  unregistered device. A withdrawn device that colluded with the server before its
  withdrawal could have uploaded forged copies of its own observations: the same
  limit as path A, where the sharing device attests what it observed.
- The backup is deliberately recoverable and claims no forward secrecy. Changing
  the code or deleting the package does not invalidate an old copy and its code;
  the user rotates to a new **generation** (new key, new code) when a code may have
  leaked or a device is withdrawn. Older generations stay readable with their code.
- Restoring the history never restores the identity: the new device registers its
  own identity (or restores it from the identity backup) and gets its own Welcome
  to send. Recovered history is read only.

## The history code and key package

The code has 78 characters: `rvh1-`, 64 hexadecimal digits (the 32-byte code key),
`-`, then 8 checksum digits: the first four bytes of
`SHA256("rocketvibe-history-code-v1\0" || key)`. The prefix keeps it from being
typed where the identity code (`rvk1-`) is expected, and the reverse.

Key package v1, JSON in this order:

| Field | Content |
|---|---|
| `header` | `version` (1), `root` (the account root), `generation` (16 random non-zero bytes), `created_at` (Unix seconds) |
| `nonce` | 24 bytes |
| `ciphertext` | XChaCha20-Poly1305 under the code key of `{generation, key}` (the 32-byte history key), AAD `rocketvibe-history-key-v1` NUL compact JSON header |

The publication wraps the package with a body (version, scope, operation, device,
incarnation, device revision, expected active generation revision, SHA-256 of the
canonical package) signed by the **publishing device's leaf** under
`rocketvibe-history-key-publication-v1`, like the identity backup's publication
but signed by a device, so any registered device of the account can enable it.
The server keeps one active package per account with a compare-and-swap revision,
the original receipt per device and operation, and a terminal cancellation, as for
the identity backup.

## Holding the key on several devices

A device holds the history key once it enabled the backup, **entered the code** to
join an existing backup (the package is fetched and opened locally), or received it
in a path A share: the share envelope's plaintext carries `history_key`
`{generation, key}` when the sharing device holds one, so a new device approved by
an old one is ready to upload. A device that already holds a key keeps its own. The key and its generation live in the vault's encrypted records, never in
a UI string; the code is displayed only on explicit request, as the identity code.

## Continuous upload

Every device holding the key uploads, in the background, the documents of its own
verified journal archive, **per period** (room scope, personal grant, admission
witness: the path A binding), as v1 history records (E2EE_HISTORY.md#records). Their
key, `key_id` and nonce come from the period secret
`HKDF-SHA256(history key, info = "rocketvibe-history-backup-period-v1" NUL
period id)` and the document's rank, exactly as in path A. The period is the path A
binding plus the uploading device and incarnation (not its certificate, so a period
continues across certificate renewal); its id is
`SHA256(rocketvibe-history-backup-period-v1 NUL compact JSON [generation, period])`. Pages are re-sealed identically after a lost
upload; the device keeps only, per period, the number of ranks the server holds.

After each page the uploader signs a **checkpoint** with its current certificate
under `rocketvibe-history-backup-checkpoint-v1`, over the body (version, generation,
period, rank count, first and last position, chain digest of the period's record
fingerprints, E2EE_HISTORY.md#share-sharing-device) and its certificate fingerprint.
A period only grows: a checkpoint never shrinks or rewrites a held prefix.

## Recovery on a new device

1. The user enters the history code. The device fetches the active package (or an
   older generation by id), opens it, checks the root against its pinned account
   root and keeps `{generation, key}` in its vault.
2. It lists the backed-up periods with their latest checkpoints, keeps those whose
   checkpoint signature verifies under a certificate of the account (current or
   withdrawn, chaining to the pinned root), and downloads each period by pages.
3. Each record is checked as in path A (attested by the checkpoint's certificate,
   origin scope = period room, increasing positions, rank-bound key material,
   document codec) and stored in the recovered catalog with the job's progress, in
   one protected transaction per page. A period shows up to its verified checkpoint;
   later checkpoints extend it.
4. Several devices may have backed up the same room: the recovered projection shows
   each position once.

## Server API

| Method and route | Who | Effect |
|---|---|---|
| `GET /api/v1/e2ee/history-backup` | Any device of the account | Scope and active key package (or none) |
| `POST /api/v1/e2ee/history-backup` | Registered device | Signed publication of a new generation, CAS on the active revision |
| `GET /api/v1/e2ee/history-backup/operations/{operation}` | Same device | Original receipt |
| `POST /api/v1/e2ee/history-backup/operations/{operation}/cancel` | Same device | Terminal settlement of the intent |
| `GET /api/v1/e2ee/history-backup/periods` | Any device of the account | Backed-up periods of a generation with their latest checkpoint |
| `PUT /api/v1/e2ee/history-backup/periods/{period}/records` | Uploading device | One page and its signed checkpoint (at most 200 records, 4 MiB) |
| `GET /api/v1/e2ee/history-backup/periods/{period}/records?after=` | Any device of the account | Records after a rank, up to the latest checkpoint |

Checks: the uploading device is registered and unrevoked, its certificate attests
every record and signs the checkpoint; ranks are contiguous, positions increasing,
the room one the account can still read at upload; downloads require the account
to still read the room, as path A. Quotas per account: 4 generations a day,
1,000,000 records and 2 GiB stored; the oldest generations beyond the 4 most recent
are deleted by maintenance.

## Adapters

`rv_crypto::account::history_backup` is the shared step: status, review and
preparation of a generation, explicit code view, confirmation, acknowledgement
and cancellation, join with the code, then wire-level upload (`history_backup_upload`
/ `history_backup_uploaded`) and import (`history_backup_next` /
`history_backup_import`). The desktop drives it in `rv-core`
(`enrollment/history_backup.rs`), Android through the bridge's
`history_backup_action` and `providers/rocketvibe/cryptoHistoryBackup.ts`.

**Continuous upload** is triggered after each successful refresh of a private
conversation (new verified messages may be waiting), at most once every 10 minutes
per settings view on the desktop and per account on Android; it only reads the
vault when the device holds no key, and a failure retries next time. The settings
also offer "Back up now" and "Restore the history".

## Public vector

[`history-backup-v1.json`](../../crates/rv-crypto-public/fixtures/history-backup-v1.json)
holds a disposable `rvh1-` code, Alice's desktop certificate, its publication of a
generation, a checkpoint and two of Bob's messages (one a thread reply) as records.
`rv-crypto-public` authenticates the publication, the checkpoint, the records and the
chain; `rv-crypto` reopens it with the code alone; and
[`verify-history-backup-vector.mjs`](../../crates/rv-crypto-public/scripts/verify-history-backup-vector.mjs)
redoes everything with Node/OpenSSL (code checksum, package under the code key,
period id and secret, rank-bound records, checkpoint signature and chain), sharing
its written-out HKDF and XChaCha20-Poly1305 with the path A verifier in
`history-crypto.mjs`. CI runs both.

## Exit criteria for B

- **Done:** public vectors for the key package, the publication and a checkpoint, verified by
  Rust and an independent Node / OpenSSL script.
- Enable, show / confirm the code, join with the code, lost responses at every
  step, rotation to a new generation, a wrong code, another account's package.
- Continuous upload resuming after interruption, growing periods, two devices
  backing up the same room, withdrawal of an uploader.
- Recovery on a blank device with the code only, then continuation of its
  conversations into the recovered history.
- Server tests on PostgreSQL; screens in the GTK, SwiftUI and Android settings.
