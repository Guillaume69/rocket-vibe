# Destruction of old keys (RocketVibe server)

On the RocketVibe native server (MLS end-to-end encryption, not Rocket.Chat E2EE), each device keeps its private state in a vault sealed under a storage key held by the platform keystore. That key is renewed every 30 days and on request, destroying the old one, so a copy of the database made earlier (backup, journal, flash remnants) can never be opened again. Expired KeyPackage keys are destroyed on the way. The protocol is `docs/protocol/E2EE_STORAGE.md`.

## What the user sees

- In the existing encryption settings of all three apps, once the device has an identity: a "Storage key" block saying when the key was last renewed (or that it never was), when the next renewal is due, and a "Renew now" button.
- Nothing else: renewals happen in the background, at most checked once an hour when a private conversation refreshes. Messages, history, recovered history and backups read exactly as before.
- **Not done**: proving that the platform keystore erased its internal copies (keychain history, swap); a renewal does not touch the recoverable history keys or the identity backup, which stay readable with their codes by design.

## Engine

- `Vault::rotate` / `scrub` (`crates/rv-crypto/src/vault.rs`): state and every block sealed again under the next key in one commit, then the WAL truncated. Blocks are re-sealed as `digest ‖ content` with a `rekeyed` marker (`crates/rv-crypto/src/vault/blobs.rs`), so references, including those nested in archive blocks, stay valid.
- `Manager::rotate` / `rotated_at` / `rotate_if_due` (`crates/rv-crypto/src/protected.rs`): the keystore record's `next` key makes the three writes (intent, commit, switch) resumable on either side at the next opening.
- `packages::Coordinator::prune` (`crates/rv-crypto/src/packages.rs`): unconsumed packages expired for more than `GRACE` (7 days) lose their private keys, except those of a pending publication.
- `account::storage` (`crates/rv-crypto/src/account/storage.rs`): `storage_status`, `renew_storage` (prune, then rotate) and `renew_storage_if_due`, shared by desktop and mobile.

## Mobile

- Bridge: `storage_action` (`crates/rv-crypto-mobile/src/storage.rs`, actions `view`, `renew`, `renew_if_due`) through the Expo module's `storageAction`.
- `providers/rocketvibe/cryptoStorageKey.ts` (`CryptoStorageKeyAccess`); `NativeChat.renewStorageSoon`, called after private conversation refreshes (`ui/encryptedConversation.ts`).
- UI: the "Storage key" block of `EncryptedIdentitySection` (`ui/encryptedIdentity.tsx`); strings `private.storage*`.

## Desktop

- `rv-core` `enrollment/storage.rs`: `storage_status`, `renew_storage`, `renew_storage_soon` (called from `enrollment/rooms/messages.rs` refreshes). A renewal re-seals the whole vault and writes the keystore, seconds on a slow Windows machine, longer than the vault lease's 2 s wait: it holds the session's `vault_gate` exclusively (`crypto::Context::exclusive`), and every private-conversation operation takes it shared (`Access::call`), so a draft or a send that comes during a renewal waits for its end instead of failing `Busy`.
- GTK: `native_crypto/storage.rs`, a group in the crypto preferences loaded with each account view; SwiftUI: `CryptoStorageControls.swift` in `CryptoSection` over `CryptoModel.renewStorage` and the FFI `storage_action` (`crates/rv-ffi/src/native_crypto/storage.rs`). Strings `crypto.storage_*`.

## Sources

- docs/protocol/E2EE_STORAGE.md
- crates/rv-crypto/src/vault.rs
- crates/rv-crypto/src/vault/blobs.rs
- crates/rv-crypto/src/protected.rs
- crates/rv-crypto/src/packages.rs
- crates/rv-crypto/src/account/storage.rs
- crates/rv-crypto-mobile/src/storage.rs
- apps/mobile/providers/rocketvibe/cryptoStorageKey.ts
- apps/mobile/ui/encryptedIdentity.tsx
- apps/desktop/crates/rv-core/src/native/crypto/enrollment/storage.rs
- apps/desktop/crates/rv-gtk/src/native_crypto/storage.rs
- apps/desktop/crates/rv-ffi/src/native_crypto/storage.rs
- apps/desktop/macos/Sources/RocketVibe/CryptoStorageControls.swift
