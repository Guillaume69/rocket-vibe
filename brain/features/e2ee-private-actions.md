# Encrypted edits, deletions, reactions and search (RocketVibe server)

On the RocketVibe native server (MLS end-to-end encryption, not Rocket.Chat E2EE), the author of a private message can edit or delete it, any member can react to it, and the room can be searched on the device. Edits, deletions and reactions are **amendments**: ordinary encrypted messages of the room whose authenticated header names the amended message. The protocol is `docs/protocol/E2EE_AMENDMENTS.md`.

## What the user sees

- **Edit and Delete** appear on the user's own journaled private messages, in rooms and threads, next to Reply and Copy. Edit opens the existing in-place editor with the current text; Delete asks for confirmation on desktop.
- **Reactions** work on any journaled private message, as in ordinary rooms: quick reactions in the message menu or sheet, and the chips under a message add or withdraw one's own. Standard and catalog emojis; the server never learns which.
- **For everyone in the room**, an edited message shows its new text and the "edited" mark; a deleted one leaves the list and the thread's reply count, and a deleted thread root is no longer shown and its thread can no longer be answered. Reactions show with their counts, one's own marked.
- **Pending change.** Until the server accepts it, the message already shows the change (new text or reaction), with the usual pending mark, Retry and Cancel. Cancelling leaves the message as it was.
- **Search** in an encrypted room uses the same search screen as an ordinary room, but runs on the device over its verified private history (recovered history included): edited text is found by its new wording, deleted messages never. Nothing is sent to the server.
- Only the author edits or deletes. An edit by anyone else is refused before sending, by the server, and ignored by readers. A deletion is final; the latest edit wins; for one person and one emoji, the latest reaction or withdrawal wins.
- Recovered history (path A share or path B backup) carries the amendments, so recovered messages show edited, reacted or disappear too.
- **Not done**: editing quotes or cards of a private message (an edit changes text only), an edit history, deleting someone else's message as a moderator, reacting to a message only known from recovered history, jumping to a search result older than the loaded page.

## Engine and server

- Header: `kind` (`chat`, `edit`, `delete`, `react`, `unreact`) and `target` in `crates/rv-crypto-public/src/messages.rs`; `target` is skipped when absent, so older vectors are unchanged.
- `Coordinator::prepare_amendment` and `prepare_reaction` (`crates/rv-crypto/src/groups/messages.rs`) find the target in the room's verified archive (`amendable`, over `journal_archive_find` in `crates/rv-crypto/src/groups/archive/journal.rs`), refuse an amendment as target, check the author for edits and deletions, and prepare the document in the target's thread. `Worker::amend_message` and `react_message` (`crates/rv-crypto/src/delivery.rs`) send through the same outbox as `send_message`.
- Projection: `Amendments` (`crates/rv-crypto/src/groups/amendments.rs`) is filled while the projection walks documents newest first, comparing positions; amendments are never rows, deleted targets are dropped, edits ride on `ProjectedMessage.edit` and reactions on `ProjectedMessage.reactions`. The recovered catalog does the same (`crates/rv-crypto/src/groups/archive/recovered.rs`).
- Search: `Coordinator::journal_search` (`crates/rv-crypto/src/groups/journal.rs`) over `archive_journal_search` then `recovered_search`; `Worker::journal_search`.
- Server: `submit` in `apps/server/src/e2ee/groups/messages.rs` refuses a target that is not an accepted non-amendment message of the same room and thread, and an edit or deletion by anyone but its author (`invalid_amendment_target`); column `target` from migration `0047_e2ee_amendments.sql`.

## Mobile

- Bridge (`crates/rv-crypto-mobile/src/conversations.rs`): commands `amend`, `react` and `search`; view rows carry `edited`, `reactions` (`{emoji, users}`) and, for an unsettled amendment, `amendment: {operation, status}` on the target row, the target keeping its own operation.
- `CryptoConversationAccess` (`providers/rocketvibe/cryptoConversations.ts`): `amend`, `react` (canonical emoji names through `canonicalEmoji`) and `search`; `privateRows` / `privateRow` (`cryptoProjection.ts`) turn `edited` into `editedAt` and reactions into the ordinary reaction JSON, with the user's id shown as their username so their reactions are marked.
- `ui/encryptedConversation.ts`: `privateRow` / `privateInterrupted`, `react`; the outbox's retry, discard and process act on the amendment's operation when there is one. Room and thread screens show such a row as pending, block its actions and route reaction chips to `react`.
- `app/message-actions.tsx`: the private payload adds `react` when the room can send and `edit` / `delete` for the user's own rows; save, delete and the quick reactions go through the sheet's own actor.
- `app/message-search.tsx`: for an encrypted room, its own `CryptoConversationAccess` searches on the device (closed in background and on leaving); the header's search button stays enabled for encrypted rooms (`privateSearch` in `ui/roomHeader.tsx`).

## Desktop

- `rv-core` `enrollment/rooms/messages.rs`: `Access::amend`, `react` and `search`; `refresh` applies edits (`edited`, re-rendered Markdown) and reactions (ordinary reaction JSON keyed by usernames, from `members` in `rooms.rs`), and shows an unsettled amendment on its target with the amendment's operation, so the existing retry and abandon reuse it. Emoji names go through `NativeSession::reaction_emoji` (`native.rs`), shared with ordinary reactions.
- GTK: `chat_native.rs` adds quick reactions, Edit and Delete to the encrypted message menu and handles reaction chips and in-place save; `chat_crypto.rs` `start_crypto_edit` / `crypto_amend` / `crypto_react`, `thread.rs` `amend_private` / `react_private`; `chat.rs` `edit_last` takes the encrypted path and the search button opens `details::search_private`.
- SwiftUI: `RoomModel` (`macos/Sources/RocketVibeKit/RoomModel.swift`) offers `.react` on journaled private rows and `.edit` / `.delete` on own ones, routes them to `NativeCryptoMessages.react` / `amend`, and searches through `NativeCryptoMessages.search` (`crates/rv-ffi/src/native_crypto/messages.rs`); `supportsEditing` and `supportsSearch` follow `privateReady`, so Up in an empty composer works too.

## Sources

- docs/protocol/E2EE_AMENDMENTS.md
- crates/rv-crypto-public/src/messages.rs
- crates/rv-crypto/src/groups/amendments.rs
- crates/rv-crypto/src/groups/messages.rs
- crates/rv-crypto/src/groups/journal.rs
- crates/rv-crypto/src/groups/archive/journal.rs
- crates/rv-crypto/src/groups/archive/recovered.rs
- crates/rv-crypto/src/delivery.rs
- apps/server/src/e2ee/groups/messages.rs
- apps/server/migrations/0047_e2ee_amendments.sql
- crates/rv-crypto-mobile/src/conversations.rs
- apps/mobile/providers/rocketvibe/cryptoConversations.ts
- apps/mobile/providers/rocketvibe/cryptoProjection.ts
- apps/mobile/ui/encryptedConversation.ts
- apps/mobile/ui/roomHeader.tsx
- apps/mobile/app/message-actions.tsx
- apps/mobile/app/message-search.tsx
- apps/desktop/crates/rv-core/src/native/crypto/enrollment/rooms/messages.rs
- apps/desktop/crates/rv-core/src/native/crypto/enrollment/rooms.rs
- apps/desktop/crates/rv-core/src/native.rs
- apps/desktop/crates/rv-gtk/src/chat_native.rs
- apps/desktop/crates/rv-gtk/src/chat_crypto.rs
- apps/desktop/crates/rv-gtk/src/details.rs
- apps/desktop/crates/rv-ffi/src/native_crypto/messages.rs
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
