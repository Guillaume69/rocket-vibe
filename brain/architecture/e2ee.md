# End-to-end encryption

Both apps read and write Rocket.Chat 8.5 encrypted rooms (`t: 'e2e'` messages, `rc.v1` and `rc.v2.aes-sha2`) with the same formats the web client produces. The mobile app does it in TypeScript over the `node:crypto` API, served on device by `react-native-quick-crypto`; the desktop does it in Rust over `aws-lc-rs`. This doc covers the wire formats, the key chain and the footguns; the user-facing behaviour is in [../features/e2ee.md](../features/e2ee.md).

## The key chain

Three layers, each unwrapping the next:

1. **The user's private key.** `GET e2e.fetchMyKeys` returns `private_key`, encrypted with the user's E2E password (not the login password). Two schemes coexist, detected from the string itself:
   - **v2**: a JSON envelope `{iv, ciphertext, salt, iterations}`. The salt is the literal ASCII string (`v2:<uid>:<uuid>`), used as-is, never base64-decoded. PBKDF2-SHA256 over the password with the envelope's own salt and iteration count gives a 32-byte key; AES-GCM opens the ciphertext into a JWK RSA private key.
   - **v1** (legacy accounts): `{"$binary": "<b64>"}` or bare base64, whose bytes are `IV(16) || AES-CBC`. PBKDF2-SHA256 with the **user id as salt** and **1000 iterations**. That is why both engines take the `uid`.
2. **The room key.** Each subscription carries `E2EKey` = key id + base64(RSA-OAEP-SHA256 of a JWK AES key). RSA-2048 output is 256 bytes, 344 base64 characters, so the key id is whatever prefix remains: 36 characters (UUID, v2) or 12 (v1). Both apps compute the prefix length instead of hard-coding it, because one account can mix both. The unwrapped JWK's `k` (base64url) is the raw AES key, 16 bytes (`A128CBC`, rooms made by the old web client) or 32 bytes (`A256GCM`).
3. **The message.** `content` = `{algorithm, kid, iv, ciphertext}`. Three shapes are read:
   - `rc.v2` GCM: 12-byte `iv`, tag glued at the end of `ciphertext`;
   - `rc.v2` CBC (old account): 16-byte `iv`;
   - `rc.v1`: no `iv`; `ciphertext` = keyId(12) + base64(IV(16) || AES-CBC).
   The IV length chooses GCM or CBC. The clear text is JSON `{"msg": ..., "attachments": [...]}` (sometimes `text` instead of `msg`); a legacy message whose clear text is not JSON is taken as raw text.

**GCM tag convention.** WebCrypto (server and web client) appends the 16-byte tag to the ciphertext. OpenSSL's `createDecipheriv` wants it separately through `setAuthTag`, so `decryptGcm` splits it. A failed GCM authentication is the only reliable "wrong password" signal; for v1 a broken PKCS#7 padding or a clear text that does not parse as JSON plays that role.

## Writing

`encryptMessage` (mobile) and `encrypt_message` (desktop) follow the room key's size, like WebCrypto importing the JWK by its `alg`: a 16-byte key gives AES-128-CBC with a 16-byte IV, a 32-byte key gives AES-256-GCM with a 12-byte IV and the tag appended. Output is `{algorithm: 'rc.v2.aes-sha2', kid, iv, ciphertext}`.

An encrypted message is sent as `t: 'e2e'`, `e2e: 'pending'`, `content`, plus `e2eMentions: {e2eUserMentions, e2eChannelMentions}`. The server cannot read the text, so it only notifies whom `e2eMentions` names (probed on 8.5). Both apps extract mentions with the web client's rule: `@name` or `#name` at the start or after whitespace, trailing `.`/`-` stripped (`lib/e2e/mentions.ts`, `e2e::mentions`).

**Files.** Each file gets its own fresh AES-256-CTR key and 16-byte initial counter. The ciphertext is uploaded under the SHA-256 of the real file name, as `application/octet-stream`; the attachment inside the encrypted message carries `encryption: {key: <JWK A256CTR>, iv}` and `hashes: {sha256}`. `rooms.mediaConfirm` receives `t: 'e2e'`, an encrypted `content` (text, attachments, `files`, `file`) and an encrypted `fileContent` (the file metadata). CTR has neither padding nor tag: a wrong key yields noise silently, so the SHA-256 of the clear bytes is what rejects it, when the sender provided one. Sending files in an encrypted room also requires the server setting `E2E_Enable_Encrypt_Files`; without it the room accepts no file. See [../features/uploads.md](../features/uploads.md) for the upload pipeline.

## Mobile engine

- **`lib/e2e/crypto.ts`**: pure functions, no React, no network, testable under Node. Imports `crypto` and `buffer`. `metro.config.js` aliases `crypto` to `react-native-quick-crypto` (Nitro native module, OpenSSL, native PBKDF2) and `buffer` to `@craftzdog/react-native-buffer` (the leaf implementation, not quick-crypto's barrel). Under Node tests the alias does not apply and the same imports resolve to `node:crypto`. Adding quick-crypto required a dev-client rebuild; see [mobile-native.md](mobile-native.md).
- **`lib/e2e/surfaceQuickCrypto.ts`**: never executed. It replays every call `crypto.ts` makes against the TYPES of `react-native-quick-crypto` so that `npx tsc --noEmit` breaks if a quick-crypto upgrade drops or changes one. Behaviour is proven only by the vectors in `crypto.test.ts` (Node OpenSSL) and a real unlock on device.
- **`lib/e2e/engine.ts`, `E2EEngine`**: holds the private key in memory, a `rid -> AES key` cache (`roomKeys`) and a `rid -> E2EKey` map. `resume()` reimports a JWK kept in the Keystore; `unlock(password)` fetches, decrypts and persists it; `lock()` forgets everything, memory and Keystore. `decryptContent` and `encrypt` are **synchronous**, so decryption plugs straight into message ingestion. `isUnlocked` is observable through `subscribe`, read by `useE2EUnlocked` (`ui/e2e.ts`) via `useSyncExternalStore`.
- **Key rotation.** Removing a member rotates the room key, so the subscription's `E2EKey` changes. `saveRoomKey` drops the cached AES key when the `E2EKey` differs; without that purge every later message stayed on the placeholder until restart.
- **Storage scope.** The decrypted JWK is kept in expo-secure-store under a key derived from (server, account), `e2eStorageKey` in `lib/storageKeys.ts` (SHA-256 of `baseUrl|userId`, truncated to 32 hex chars). It used to be per server only: the next account on the same server reimported the previous account's key, the import succeeded, the app believed itself unlocked and silently failed every room key. `purgeLegacyE2EKey` erases the old-format entry at session start because the Keystore cannot enumerate its keys.
- **Wiring** (`ui/sync.tsx`): the engine is passed to `SyncEngine` as its `E2EDecryptor`. Ingestion decrypts in place when a key exists and otherwise stores `encryptedRaw` (raw `content` JSON) with `text` null. On unlock, `e2eUnlocked` loads every known room key from the DB, decrypts all `messagesToDecrypt`, refreshes encrypted previews (`updateEncryptedPreview`), then kicks the text outbox and the upload queue, whose encrypted rows were waiting (`KeyWait`). On lock, `e2eRelocked` wipes the clear text of encrypted messages from SQLite. The clear text therefore **lives in the SQLite database while unlocked**. Unlock transitions refresh the context object identity without bumping `generation`, which would have invalidated the room caches and re-fetched history.

## Desktop engine

- **`rv-core/src/e2e.rs`**: the same formats over `aws-lc-rs` (AEAD for GCM, `cipher` for CBC/CTR, `OaepPrivateDecryptingKey` for RSA). aws-lc only imports RSA keys as PKCS#8, so `jwk_to_pkcs8` hand-encodes the DER. Errors: `E2eError::WrongPassword`, `NoKeys` (empty `private_key`), `Undecipherable(&str)`.
- **`Session`** (`rv-core/src/session.rs`) keeps `Mutex<Option<E2eUnlocked>>`: the key, its JWK (for the keychain) and a `rid -> (kid, key)` cache. `room_key` re-unwraps whenever the stored `E2EKey`'s key id differs from the cached one, which covers rotation. `e2e_unlock` calls `e2e.fetchMyKeys`; `e2e_resume(jwk)` imports a kept key; `e2e_export` hands the JWK out; `e2e_lock` drops it. Each transition emits `SessionEvent::E2e`, and unlocking spawns `outbox.process()` and `uploads.process()`.
- **Decrypt on read, not on write.** The store keeps `encrypted_raw`; `Session::open_row` decrypts each encrypted row as it is read and teaches the media cache the file keys (`media.learn_keys`). Locking needs no DB rewrite. A message of mine still in the outbox keeps its own text.
- **Keeping the key.** `rv-gtk` writes the JWK into the account's keychain item (`secrets::save_e2e`, field `e2eKey`, Secret Service through `oo7` on Linux, the `keyring` crate on Windows and macOS) on every `SessionEvent::E2e`, and `secrets::e2e_key` resumes it at session start (`window.rs`). `rv-ffi` does the same for the SwiftUI app (`accounts::save`, `accounts::e2e_key`).
- **Unlock UI**: `rv-gtk/src/unlock.rs` (an `adw::Dialog` with a password entry), the SwiftUI `UnlockSheet` in `RoomView.swift` (a modal overlay of the window), and `AppModel.unlock` which maps `e2e-wrong`, `e2e-no-keys`, `e2e-failed`.

## Footguns

- The salt of a v2 envelope is a literal string. Base64-decoding it gives a wrong key and every password looks wrong.
- Never trust `iv`/`kid` to be present: `rc.v1` content has neither.
- A wrong file key does not throw: check the SHA-256.
- Node tests do not exercise quick-crypto; only the type surface file and a device run do.
- The server rejects clear text in an encrypted room (`error-not-allowed`), so locked clients must queue, never fall back to plain text.
- Not implemented in either app: creating an encrypted room (generating and distributing a room key), and creating or resetting a user key pair.

## Sources

- apps/mobile/lib/e2e/crypto.ts
- apps/mobile/lib/e2e/engine.ts
- apps/mobile/lib/e2e/mentions.ts
- apps/mobile/lib/e2e/surfaceQuickCrypto.ts
- apps/mobile/lib/e2e/crypto.test.ts
- apps/mobile/metro.config.js
- apps/mobile/lib/storageKeys.ts
- apps/mobile/lib/sessionStore.ts
- apps/mobile/lib/sync.ts
- apps/mobile/lib/outbox.ts
- apps/mobile/lib/uploadQueue.ts
- apps/mobile/ui/sync.tsx
- apps/mobile/ui/e2e.ts
- apps/mobile/ui/fileEncryption.ts
- apps/mobile/db/schema.ts
- apps/desktop/crates/rv-core/src/e2e.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/uploads.rs
- apps/desktop/crates/rv-core/src/outbox.rs
- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-gtk/src/unlock.rs
- apps/desktop/crates/rv-gtk/src/secrets.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-ffi/src/lib.rs
- apps/desktop/crates/rv-ffi/src/accounts.rs
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
