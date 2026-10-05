# Internal E2EE review (2026-10-06)

An **internal** read-only review of the native end-to-end encryption, run by five
parallel reviewers each holding one area, every finding then checked against the
code before it was fixed or recorded. It is not the independent review that
[RFC 0002](../rfcs/0002-e2ee-native.md) step 6 requires before activation: the same
team wrote and reviewed the code, so it lowers the risk, it does not qualify the
protocol.

## Scope

| Area | Code |
| --- | --- |
| Identity, enrollment, recovery, revocation, renewal, delegation | `crates/rv-crypto/src/{identity,account}`, [IDENTITY.md](../../crates/rv-crypto/IDENTITY.md), [ENROLLMENT.md](../../crates/rv-crypto/ENROLLMENT.md), [E2EE_DELEGATION.md](E2EE_DELEGATION.md) |
| MLS application messages, amendments, journal, KeyPackages | `crates/rv-crypto/src/groups`, `crates/rv-crypto-public/src/messages.rs`, [E2EE_MESSAGES.md](E2EE_MESSAGES.md), [E2EE_AMENDMENTS.md](E2EE_AMENDMENTS.md) |
| History share (path A) and history backup (path B) | `crates/rv-crypto/src/{history,history_backup}.rs`, `groups/archive/recovered.rs`, [E2EE_HISTORY.md](E2EE_HISTORY.md), [E2EE_HISTORY_BACKUP.md](E2EE_HISTORY_BACKUP.md) |
| Local storage, key rotation, encrypted files | `crates/rv-crypto/src/{vault,protected,files}.rs`, [E2EE_STORAGE.md](E2EE_STORAGE.md), [E2EE_FILES.md](E2EE_FILES.md) |
| Trust boundaries: server, mobile bridge, desktop and mobile file handling | `apps/server/src/{files.rs,e2ee}`, `crates/rv-crypto-mobile`, `apps/mobile/ui/nativeFiles.ts`, `apps/desktop/crates/rv-core/src/native/files.rs` |

No finding broke confidentiality against the server alone. The most serious ones
needed a withdrawn device that still holds its keys, or a server that lies about
ids, positions or directories.

## Findings and status

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| I-M1 | Medium | Trust in a sibling device ignored the withdrawals this device had learned: a server that dropped a revocation from the directory made a withdrawn device eligible for a history share and the delegated root | Fixed `8be476b2` (`trusted_sibling`) |
| I-M2 | Medium | The controller could re-certify a withdrawn incarnation | Fixed `8be476b2` |
| I-M3 | Medium | A share (and its delegated root) was sealed without re-checking a target withdrawn since approval | Fixed `8be476b2` (`still_trusted`) |
| I-L1 | Low | A delegated root was adopted before the device's own withdrawal was observed | Fixed `8be476b2` |
| M-F1 | Medium | Private message ids were chosen by the server and bound to nothing signed: it could relabel a message so an edit, deletion, reaction, reply or file named another one | Fixed `89be8c1d`: the id derives from the proof fingerprint and clients refuse any other |
| M-F2 | Low | An amendment positioned at or before its target was applied by some views and ignored by others | Fixed `e9be8439`; the server's choice among one author's edits remains, see open items |
| M-F3 | Low | Two roots sharing an id were handled differently by the live and archive paths | Fixed by M-F1: two messages can no longer share an id |
| M-F4 | Low, availability | Every page walks and re-verifies the whole room index | Open |
| H-1 | Medium | After a history-backup rotation, other devices kept uploading under the retired key; a share could hand out a retired key | Fixed `45e59929`: uploads only under the signed active generation, server refuses others (`history_generation_superseded`) |
| H-2 | Low-Medium | Conflicting recovered copies at one position are resolved silently, in an order a malicious uploader can grind; path B import does not consult directory withdrawals | Open |
| H-3 | Low | Recovered documents could show inside the device's own range (thread filter, search) | Fixed `96791b0f` |
| H-4 | Low, availability | Path B re-seals with the certificate and membership current at upload time: a renewal between PUT and record stalls that period | Open |
| H-5 | Info | Checkpoints are not fresh: the server can serve an older one or omit periods; the shown prefix is shorter but verified | Limitation, documented in E2EE_HISTORY_BACKUP.md |
| H-6 | Low, availability | Each view re-authenticates every recovered record of the room | Open |
| S-1 | Low | `object_size` could wrap on an absurd descriptor size (a panic in debug builds) | Fixed `8be476b2` (saturating) |
| S-2 | Low | One unreadable block row blocked every storage-key rotation, keeping the old key alive | Fixed `8be476b2`: the row is dropped |
| S-3 | Low | A rotation did not read back the blocks it re-sealed | Fixed `8be476b2` |
| S-4 | Low | The partial file of `open_path` could collide with the object being read | Fixed `8be476b2`: random name, `create_new` |
| S-5 | Low, defence in depth | Temporary key copies, serializer reallocations and file buffers are not zeroized | Open |
| T-1 | Low-Medium | Replaying a history-share page held before the current count panicked the handler | Fixed `8be476b2` |
| T-2 | Low-Medium | Mobile kept decrypted private files on disk after their view closed | Fixed `8be476b2` |
| T-3 | Low | Any current member downloaded every encrypted object of the room, including members whose device the message never reached | Fixed `2d9b8d6c`: delivery's admission witness |
| T-4 | Low | An amendment could name a message the device never received | Fixed `2d9b8d6c` |
| T-5 | Low, hardening | The mobile bridge accepts any absolute `file://` path; paths are not confined to the app's directories | Open (the JS layer is trusted app code) |

## Open items

- **Edit order among one author's edits (M-F2).** Journal positions are the
  server's: among several edits of one message, it decides which comes last. MLS
  generation order could bind it; nothing does yet.
- **Recovered conflicts (H-2).** Detect two sources holding one position with
  different ids or digests and refuse or flag them; prefer path A and unrevoked
  sources; check path B certificates against learned withdrawals.
- **Path B reproducibility (H-4).** Pin the certificate in the progress record, as
  `ShareJob` does, and persist the author's membership when indexing.
- **Cost of views (M-F4, H-6).** Stop walks early and cache verified amendments
  instead of re-verifying the room on every page.
- **Zeroization (S-5).** `Zeroizing` temporary key copies, pre-sized serialization
  buffers, zeroized file buffers.
- **Path confinement (T-5).** Have the bridge accept only paths under the cache and
  files directories it knows.

## Known limitation: keystore rollback

The vault's anti-rollback anchor is the keystore record alone. Restoring a keystore
backup together with the matching older database rolls the MLS send state back
(ratchet generations reused) and brings back a destroyed storage key, as
[E2EE_STORAGE.md](E2EE_STORAGE.md) already states for keychain history. Closing it
needs a monotonic counter outside the keystore's backup set, or the server's help.

## Checked and found sound

Domain separation of every signature; canonical, `deny_unknown_fields` signed
encodings; enrollment consent and peer pins; recovery packet binding; MLS header and
proof binding (scope, epoch, author, device, incarnation, kind, target, files);
receive-path checks (AAD, credential, leaf to participant, own messages refused);
journal page binding and witness-filtered delivery; KeyPackage single use; history
key and nonce derivation per rank; the HPKE envelope; vault checkpoint chain and
rotation crash windows; `rv-file-v1` framing; size caps on every bridge action; no
key or plaintext in logs.

## Sources

- crates/rv-crypto/src/account/history.rs
- crates/rv-crypto/src/account/history_backup.rs
- crates/rv-crypto/src/groups/amendments.rs
- crates/rv-crypto/src/groups/journal.rs
- crates/rv-crypto/src/groups/archive/recovered.rs
- crates/rv-crypto/src/vault/blobs.rs
- crates/rv-crypto/src/files.rs
- crates/rv-crypto-public/src/messages.rs
- apps/server/src/files.rs
- apps/server/src/e2ee/groups/messages.rs
- apps/server/src/e2ee/history_backup.rs
