# Encrypted history on a new device (RocketVibe server)

On the RocketVibe native server (MLS end-to-end encryption, not Rocket.Chat E2EE), a newly registered device cannot read messages sent before it joined a room. History recovery lets it ask another device of the same account for the encrypted messages that device already received. The protocol is `docs/protocol/E2EE_HISTORY.md` (path A, device to device); path B (archive-key backup with a recovery code) is not built yet.

## What the user sees

All three apps show an "Encrypted history" block in the existing encryption settings, only on a registered device (identity stage `ready`).

- **New device.** "Ask my other devices for history" publishes a request and shows its fingerprint. "Import received history" says "Waiting for another device" until a share is committed, then imports it page by page and shows "History imported"; the server copy is then deleted.
- **Device that shares.** "Show requests from my devices" lists the requests of the account's other devices ("Request from phone" and the fingerprint). "Review" shows the rooms by name and how many messages each would share; the human compares the fingerprint with the one on the new device, then "Share history" seals, uploads and commits everything. "Resume sharing" continues an interrupted share. With nothing received yet, the review says so and offers no share.
- Only another device listed in the account's verified directory (same root, device, incarnation and leaf key, never revoked) can be offered or imported from; this device never answers its own request.
- **Not yet**: the recovered messages are stored but not shown in conversations, and there is no automatic import.

## Mobile

- `ui/encryptedIdentity.tsx`: the history block of `EncryptedIdentitySection`, with its alert before sharing; room names come from the `rooms` table (`displayName`, then `name`). Strings `private.history*` in `ui/messages.ts`.
- `providers/rocketvibe/cryptoHistory.ts` (`CryptoHistoryAccess`): HTTP and orchestration, abandoning a share whose request is gone or claimed by another device; `transport.ts` carries the seven `/api/v1/e2ee/history/requests` routes.
- The Expo module's `historyAction` calls the Rust bridge `crates/rv-crypto-mobile/src/history.rs`, which keeps offers, previews and the page being uploaded staged in Rust.

## Desktop

- Shared core: `crates/rv-core/src/native/crypto/enrollment/history.rs` (`request_history`, `import_history`, `history_offers`, `preview_history`, `share_history`, `resume_history_share`). Strings `crypto.history_*` in `crates/rv-core/src/i18n.rs`.
- GTK: `crates/rv-gtk/src/native_crypto/history.rs`, a group in the crypto preferences dialog with an `AdwAlertDialog` before sharing; room names from the session store.
- SwiftUI: `macos/Sources/RocketVibe/CryptoHistoryControls.swift` in `CryptoSection`, over `CryptoModel` and the FFI `history_action` (`crates/rv-ffi/src/native_crypto/history.rs`); room names from `AppModel.rooms`.

## Sources

- docs/protocol/E2EE_HISTORY.md
- crates/rv-crypto/src/account/history.rs
- crates/rv-crypto/src/groups/history.rs
- crates/rv-crypto-mobile/src/history.rs
- apps/server/src/e2ee/history.rs
- apps/mobile/ui/encryptedIdentity.tsx
- apps/mobile/providers/rocketvibe/cryptoHistory.ts
- apps/desktop/crates/rv-core/src/native/crypto/enrollment/history.rs
- apps/desktop/crates/rv-gtk/src/native_crypto/history.rs
- apps/desktop/crates/rv-ffi/src/native_crypto/history.rs
- apps/desktop/macos/Sources/RocketVibe/CryptoHistoryControls.swift
- apps/desktop/macos/Sources/RocketVibeKit/CryptoModel.swift
