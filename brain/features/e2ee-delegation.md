# Delegation of control (RocketVibe server)

On the RocketVibe native server (MLS end-to-end encryption, not Rocket.Chat E2EE), the device holding the account's private root is the controller: only it approves and withdraws devices, renews certificates and backs the root up. Delegation hands control to another registered device of the account, so the account keeps a controller when the first is retired. The protocol is `docs/protocol/E2EE_DELEGATION.md`.

## What the user sees

- On the controller, reviewing another device's history request (the existing "Encrypted history" block, [e2ee-history](e2ee-history.md)) now offers, besides "Share history", a destructive **"Share and hand over control"**, with a warning that it cannot be taken back.
- The receiving device imports the share as usual; once the root is adopted, its encryption settings show it controls the account (approve a device, withdraw one, backups).
- Only a device holding the root sees the option. An ordinary share hands nothing over.
- **Not done**: taking control back (only replacing the root does), coordinating several controllers.

## Engine

- `Issuer::export` / `import` (`crates/rv-crypto/src/identity.rs`): the private root out, and in only if it is exactly the account's root with a matching key.
- Share: `ShareJob` records `delegate`; `finish` seals the root in the envelope's `root` field (`crates/rv-crypto/src/history.rs`); `history_share_begin(request, delegate, now)` (`crates/rv-crypto/src/groups/history.rs`) refuses delegation without the root.
- Import: the received root waits under `crypto-delegated-root-v1` in the same commit as the import job; `account::history::adopt_control` (`crates/rv-crypto/src/account/history.rs`) checks and adopts it, replayed on each import step. `SharePreview.can_delegate` tells the UI.

## Mobile

- Bridge `history_action`: the preview returns `can_delegate`, `approve` takes `delegate` (`crates/rv-crypto-mobile/src/history.rs`); `CryptoHistoryAccess.share(preview, delegate)` (`providers/rocketvibe/cryptoHistory.ts`).
- UI: the share alert of `ui/encryptedIdentity.tsx` gains the destructive button; strings `private.historyShareDelegate`, `private.historyDelegateBody`.

## Desktop

- `rv-core` `enrollment/history.rs`: `HistoryApproval.can_delegate`, `share_history(approval, delegate)`.
- GTK: the review `AdwAlertDialog` of `native_crypto/history.rs` gains a destructive "delegate" response; SwiftUI: `CryptoHistoryControls.swift` alert button over `CryptoModel.shareHistory(delegate:)` and the FFI `history_action` (`crates/rv-ffi/src/native_crypto/history.rs`). Strings `crypto.history_share_delegate`, `crypto.history_delegate_body`.

## Sources

- docs/protocol/E2EE_DELEGATION.md
- crates/rv-crypto/src/identity.rs
- crates/rv-crypto/src/history.rs
- crates/rv-crypto/src/groups/history.rs
- crates/rv-crypto/src/account/history.rs
- crates/rv-crypto-mobile/src/history.rs
- apps/mobile/providers/rocketvibe/cryptoHistory.ts
- apps/mobile/ui/encryptedIdentity.tsx
- apps/desktop/crates/rv-core/src/native/crypto/enrollment/history.rs
- apps/desktop/crates/rv-gtk/src/native_crypto/history.rs
- apps/desktop/crates/rv-ffi/src/native_crypto/history.rs
- apps/desktop/macos/Sources/RocketVibe/CryptoHistoryControls.swift
