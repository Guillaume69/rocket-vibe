# Encrypted files (RocketVibe server)

On the RocketVibe native server (MLS end-to-end encryption, not Rocket.Chat E2EE), files of private rooms are sealed on the device before upload. The server stores an opaque object and never learns the name, type, size of the content or the key, which travels only inside the encrypted message. The protocol is `docs/protocol/E2EE_FILES.md`; the object format `rv-file-v1` has a public vector checked by Node (`crates/rv-crypto-public/fixtures/file-v1.json`, `scripts/verify-file-vector.mjs`).

## What the user sees

- **Sending.** The attach button of an encrypted room works as in an ordinary one (picker, paste, drop, caption on the first file), up to about 100 MB per file. Each file goes in its own private message. Mobile keeps its "reduced quality" option, which compresses before sealing; desktop sends originals.
- **Receiving.** Images, audio and video of the allowed types show inline, other files as cards with open, save and share, like ordinary native files. The first open downloads the object and decrypts it into the app's private cache.
- **Lifetime.** A private file opens only while a private view (the room, a thread, private search results) shows its message; closing the view closes its files, and desktop drops their decrypted cache too.
- A message may carry files without text. Deleting the message hides it for readers but cannot recall the object: the server does not know of private deletions, and members already hold the key.
- **Not done**: voice messages and files sent from a thread in encrypted rooms, quoting a private file elsewhere, resuming an interrupted upload (the attempt fails and can be redone; a prepared message resumes like any private send).

## Engine and server

- Format and streaming seal / open: `crates/rv-crypto/src/files.rs` (64 KiB chunks, XChaCha20-Poly1305 STREAM nonces, size and SHA-256 of the plaintext checked again, partial file published only when valid).
- Descriptor: `EncryptedFile` (`crates/rv-protocol/src/parity.rs`) in `SendMessage.files`; the header lists the same ids in `files` (`crates/rv-crypto-public/src/messages.rs`), checked against the payload on decode; validation in `valid_files` (`crates/rv-crypto/src/groups/messages.rs`). Edits, deletions and reactions carry no file. The ordinary send path refuses `files` (`apps/server/src/store.rs`).
- Server: `apps/server/src/files.rs` takes `encrypted: true` preparations only in rooms with an MLS group (`require_encrypted`), never completes them through `/complete`, and serves them to members as `application/octet-stream`; the private message submission completes them (`apps/server/src/e2ee/groups/messages.rs`, `invalid_encrypted_file`). Migration `0048_e2ee_files.sql`.

## Mobile

- Rust bridge: free functions `seal_file` / `open_file` (`crates/rv-crypto-mobile/src/files.rs`), exposed by the Expo module as `sealFile` / `openFile` (`modules/crypto-native`); the `prepare` command takes `files`.
- Sending: `sendPrivateFile` (`providers/rocketvibe/privateFiles.ts`) seals into `cacheDirectory/private-outbox/`, prepares and streams the object through the file-transfer module (`nativeFileSender`, `ui/nativeFiles.ts`), then `CryptoConversationAccess.send(text, [], files)`. The room screen passes the hook's `files` outbox (`ui/encryptedConversation.ts`) to the composer.
- Rows: `privateFileAttachments` (`cryptoProjection.ts`) shapes them like native attachments; `NativeChat.registerPrivateFiles` / `forgetPrivateFiles` keep the openable ones per view (room and thread hook, `app/message-search.tsx`).
- Opening: the native file reader (`mountNativeFiles`, `ui/nativeFiles.ts`) recognises a registered private id, downloads the object (`copyVerifiedFile` with no digest, the AEAD checks it) and calls `openFile` into the same private cache.

## Desktop

- `rv-core` `native/files.rs`: `private_attachments` emits `rv-file:~<id>` attachments (`~` never occurs in ordinary ids, so every existing renderer and download path takes them); `register_private_files` / `forget_private_files` per view token; `local_file` / `file_media` / `download_file` download the object and open it into the cache; `upload_private_object` seals and uploads.
- `enrollment/rooms/messages.rs`: `Access::send_file`, `files_available`, file attachments on rows and registration in `refresh` and `search`; `close` forgets the view's files.
- GTK: `chat.rs` `send_files` takes `send_private_files` (`chat_crypto.rs`) in an encrypted room; `composer.rs` `bind_private` enables the attach button. SwiftUI: `RoomModel.attach` and `supportsFiles` go through `NativeCryptoMessages.sendFile` / `filesAvailable` (`crates/rv-ffi/src/native_crypto/messages.rs`).

## Sources

- docs/protocol/E2EE_FILES.md
- crates/rv-crypto/src/files.rs
- crates/rv-crypto-public/fixtures/file-v1.json
- crates/rv-crypto-public/scripts/verify-file-vector.mjs
- crates/rv-crypto/src/groups/messages.rs
- crates/rv-crypto-public/src/messages.rs
- crates/rv-protocol/src/parity.rs
- apps/server/src/files.rs
- apps/server/src/e2ee/groups/messages.rs
- apps/server/migrations/0048_e2ee_files.sql
- crates/rv-crypto-mobile/src/files.rs
- apps/mobile/modules/crypto-native/android/src/main/java/com/rocketvibe/crypto/CryptoNativeModule.kt
- apps/mobile/providers/rocketvibe/privateFiles.ts
- apps/mobile/providers/rocketvibe/cryptoProjection.ts
- apps/mobile/ui/encryptedConversation.ts
- apps/mobile/ui/nativeFiles.ts
- apps/desktop/crates/rv-core/src/native/files.rs
- apps/desktop/crates/rv-core/src/native/crypto/enrollment/rooms/messages.rs
- apps/desktop/crates/rv-gtk/src/chat_crypto.rs
- apps/desktop/crates/rv-ffi/src/native_crypto/messages.rs
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
