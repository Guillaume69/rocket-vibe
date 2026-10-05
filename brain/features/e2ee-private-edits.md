# Encrypted edits and deletions (RocketVibe server)

On the RocketVibe native server (MLS end-to-end encryption, not Rocket.Chat E2EE), the author of a private message can edit or delete it. Both are **amendments**: ordinary encrypted messages of the room whose authenticated header names the amended message. The protocol is `docs/protocol/E2EE_AMENDMENTS.md`.

## What the user sees

- **Edit and Delete** appear on the user's own journaled private messages, in rooms and threads, next to Reply and Copy. Edit opens the existing in-place editor with the current text; Delete asks for confirmation on desktop.
- **For everyone in the room**, an edited message shows its new text and the "edited" mark; a deleted one leaves the list and the thread's reply count, and a deleted thread root is no longer shown and its thread can no longer be answered.
- **Pending change.** Until the server accepts it, the author's message already shows the new text, with the usual pending mark, Retry and Cancel. Cancelling leaves the message as it was.
- Only the author amends. An edit by anyone else is refused before sending, by the server, and ignored by readers. A deletion is final; the latest edit wins.
- Recovered history (path A share or path B backup) carries the amendments, so recovered messages show edited or disappear too.
- **Not done**: editing quotes or cards of a private message (an edit changes text only), an edit history, deleting someone else's message as a moderator.

## Engine and server

- Header: `kind` (`chat`, `edit`, `delete`) and `target` in `crates/rv-crypto-public/src/messages.rs`; `target` is skipped when absent, so older vectors are unchanged.
- `Coordinator::prepare_amendment` (`crates/rv-crypto/src/groups/messages.rs`) finds the target in the room's verified archive (`journal_archive_find`, `crates/rv-crypto/src/groups/archive/journal.rs`), checks the author and that it is not itself an amendment, and prepares an Edit or Delete document in the target's thread. `Worker::amend_message` (`crates/rv-crypto/src/delivery.rs`) sends it through the same outbox as `send_message`.
- Projection: `Amendments` (`crates/rv-crypto/src/groups/amendments.rs`) is filled while the projection walks documents newest first; amendments are never rows, deleted targets are dropped, edits ride on `ProjectedMessage.edit`. The recovered catalog does the same (`crates/rv-crypto/src/groups/archive/recovered.rs`).
- Server: `submit` in `apps/server/src/e2ee/groups/messages.rs` refuses a target that is not an accepted non-amendment message of the same room, author and thread (`invalid_amendment_target`); column `target` from migration `0047_e2ee_amendments.sql`.

## Mobile

- Bridge: command `amend` in `crates/rv-crypto-mobile/src/conversations.rs`; view rows carry `edited` and, for an unsettled amendment, `amendment: {operation, status}` on the target row, the target keeping its own operation.
- `CryptoConversationAccess.amend` (`providers/rocketvibe/cryptoConversations.ts`) prepares, then resumes like a send; `privateRows` turns `edited` into `editedAt` (`cryptoProjection.ts`).
- `ui/encryptedConversation.ts`: `privateRow` / `privateInterrupted`; the outbox's retry, discard and process act on the amendment's operation when there is one. Room and thread screens show such a row as pending and block its actions.
- `app/message-actions.tsx`: the private payload adds `edit` and `delete` for the user's own rows when the room can send; save and delete call `amend` through the sheet's own actor.

## Desktop

- `rv-core` `enrollment/rooms/messages.rs`: `Access::amend`; `refresh` applies `edit` to journaled rows (`edited`, re-rendered Markdown) and shows an unsettled amendment on its target with the amendment's operation, so the existing retry and abandon reuse it.
- GTK: `chat_native.rs` adds Edit and Delete to the encrypted message menu and handles in-place save; `chat_crypto.rs` `start_crypto_edit` / `crypto_amend`, `thread.rs` `amend_private`; `chat.rs` `edit_last` takes the encrypted path.
- SwiftUI: `RoomModel` (`macos/Sources/RocketVibeKit/RoomModel.swift`) offers `.edit` / `.delete` on own journaled private rows and routes `edit` / `delete` to `NativeCryptoMessages.amend` (`crates/rv-ffi/src/native_crypto/messages.rs`); `supportsEditing` follows `privateReady`, so Up in an empty composer works too.

## Sources

- docs/protocol/E2EE_AMENDMENTS.md
- crates/rv-crypto-public/src/messages.rs
- crates/rv-crypto/src/groups/amendments.rs
- crates/rv-crypto/src/groups/messages.rs
- crates/rv-crypto/src/groups/archive/journal.rs
- crates/rv-crypto/src/groups/archive/recovered.rs
- crates/rv-crypto/src/delivery.rs
- apps/server/src/e2ee/groups/messages.rs
- apps/server/migrations/0047_e2ee_amendments.sql
- crates/rv-crypto-mobile/src/conversations.rs
- apps/mobile/providers/rocketvibe/cryptoConversations.ts
- apps/mobile/providers/rocketvibe/cryptoProjection.ts
- apps/mobile/ui/encryptedConversation.ts
- apps/mobile/app/message-actions.tsx
- apps/desktop/crates/rv-core/src/native/crypto/enrollment/rooms/messages.rs
- apps/desktop/crates/rv-gtk/src/chat_native.rs
- apps/desktop/crates/rv-gtk/src/chat_crypto.rs
- apps/desktop/crates/rv-ffi/src/native_crypto/messages.rs
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
