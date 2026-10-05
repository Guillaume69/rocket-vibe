# Encrypted history on a new device (RocketVibe server)

On the RocketVibe native server (MLS end-to-end encryption, not Rocket.Chat E2EE), a newly registered device cannot read messages sent before it joined a room. History recovery lets it ask another device of the same account for the encrypted messages that device already received. The protocol is `docs/protocol/E2EE_HISTORY.md` (path A, device to device); path B (archive-key backup with a recovery code) is not built yet.

## What the user sees

All three apps show an "Encrypted history" block in the existing encryption settings, only on a registered device (identity stage `ready`).

- **New device.** "Ask my other devices for history" publishes a request and shows its fingerprint. "Import received history" says "Waiting for another device" until a share is committed, then imports it page by page and shows "History imported"; the server copy is then deleted.
- **Device that shares.** "Show requests from my devices" lists the requests of the account's other devices ("Request from phone" and the fingerprint). "Review" shows the rooms by name and how many messages each would share; the human compares the fingerprint with the one on the new device, then "Share history" seals, uploads and commits everything. "Resume sharing" continues an interrupted share. With nothing received yet, the review says so and offers no share.
- Only another device listed in the account's verified directory (same root, device, incarnation and leaf key, never revoked) can be offered or imported from; this device never answers its own request.
- **In conversations.** Once the new device has its own admission to the room, scrolling past its own oldest message continues into the recovered messages, with the time the sharing device received them; a thread started before the device joined shows its recovered root. Recovered messages are read through the same projection as the device's own, so the three apps show them without a separate screen.
- **Not yet**: automatic import, reply counts of recovered roots (own replies only), private quotes of recovered messages.

## History backup with a code (path B)

When no old device is left, a separate history code recovers the history ([E2EE_HISTORY_BACKUP.md](../../docs/protocol/E2EE_HISTORY_BACKUP.md)). A "History backup" block sits in the same settings of all three apps, on a registered device:

- **Enable** draws a history key and an `rvh1-` code (never the identity `rvk1-` code), shows the code on request, and publishes the generation only after "I have saved this code". A lost publication response is found again; the intent can be cancelled. Enabling again rotates to a new generation; older ones stay readable with their code.
- **Join with the code** on another device of the account (or a new one) opens the active generation. A device approved through a path A share also receives the key in the share, unless it already holds one.
- Devices holding the key **upload continuously**: after a private conversation refresh, at most once every 10 minutes, their own periods go up as history records with signed checkpoints. "Back up now" forces it.
- **Restore the history** downloads every backed-up period of the held generation into the same recovered catalog as path A, so conversations continue into it; a position held by several sources shows once.

## Mobile

- `ui/encryptedIdentity.tsx`: the history block of `EncryptedIdentitySection`, with its alert before sharing; room names come from the `rooms` table (`displayName`, then `name`). Strings `private.history*` in `ui/messages.ts`.
- `providers/rocketvibe/cryptoHistory.ts` (`CryptoHistoryAccess`): HTTP and orchestration, abandoning a share whose request is gone or claimed by another device; `transport.ts` carries the seven `/api/v1/e2ee/history/requests` routes.
- The Expo module's `historyAction` calls the Rust bridge `crates/rv-crypto-mobile/src/history.rs`, which keeps offers, previews and the page being uploaded staged in Rust.
- History backup: the same screen's "History backup" block over `providers/rocketvibe/cryptoHistoryBackup.ts` and the bridge's `history_backup_action` (`crates/rv-crypto-mobile/src/history_backup.rs`); `NativeChat.syncHistoryBackupSoon` runs after each private conversation refresh (`ui/encryptedConversation.ts`). Strings `private.historyBackup*`.

## Desktop

- History backup: `crates/rv-core/src/native/crypto/enrollment/history_backup.rs`, triggered after private refreshes from `enrollment/rooms/messages.rs`; GTK `crates/rv-gtk/src/native_crypto/history_backup.rs`; SwiftUI `macos/Sources/RocketVibe/CryptoHistoryBackupControls.swift` over the FFI `history_backup_action`. Strings `crypto.history_backup_*`.
- Shared core: `crates/rv-core/src/native/crypto/enrollment/history.rs` (`request_history`, `import_history`, `history_offers`, `preview_history`, `share_history`, `resume_history_share`). Strings `crypto.history_*` in `crates/rv-core/src/i18n.rs`.
- GTK: `crates/rv-gtk/src/native_crypto/history.rs`, a group in the crypto preferences dialog with an `AdwAlertDialog` before sharing; room names from the session store.
- SwiftUI: `macos/Sources/RocketVibe/CryptoHistoryControls.swift` in `CryptoSection`, over `CryptoModel` and the FFI `history_action` (`crates/rv-ffi/src/native_crypto/history.rs`); room names from `AppModel.rooms`.

Engine side, `journal_projection` (`crates/rv-crypto/src/groups/journal.rs`) completes a page from `recovered_page` / `recovered_root` (`crates/rv-crypto/src/groups/archive/recovered.rs`) once the own history is exhausted; positions at or after the oldest own document never come from the recovered catalog.

## Sources

- docs/protocol/E2EE_HISTORY.md
- docs/protocol/E2EE_HISTORY_BACKUP.md
- crates/rv-crypto/src/history_backup.rs
- crates/rv-crypto/src/account/history_backup.rs
- crates/rv-crypto/src/groups/history_backup.rs
- apps/server/src/e2ee/history_backup.rs
- crates/rv-crypto/src/account/history.rs
- crates/rv-crypto/src/groups/history.rs
- crates/rv-crypto/src/groups/journal.rs
- crates/rv-crypto/src/groups/archive/recovered.rs
- crates/rv-crypto-mobile/src/history.rs
- apps/server/src/e2ee/history.rs
- apps/mobile/ui/encryptedIdentity.tsx
- apps/mobile/providers/rocketvibe/cryptoHistory.ts
- apps/desktop/crates/rv-core/src/native/crypto/enrollment/history.rs
- apps/desktop/crates/rv-gtk/src/native_crypto/history.rs
- apps/desktop/crates/rv-ffi/src/native_crypto/history.rs
- apps/desktop/macos/Sources/RocketVibe/CryptoHistoryControls.swift
- apps/desktop/macos/Sources/RocketVibeKit/CryptoModel.swift
