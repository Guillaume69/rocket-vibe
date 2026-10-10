# Read receipts (RocketVibe server)

On a RocketVibe server, the room shows how far the others read: under my most recent message, "Seen" in a direct conversation, "Seen by Bob, Carol" in a group. It is live (the server's live frame, every 2 seconds) and needs no request of its own. An account can turn it off, both ways. Rocket.Chat (whose read receipts are an Enterprise feature) and Mattermost accounts have none here.

## The contract

- The server already keeps each member's read position per room (`room_read_states.root_position`, [READ_STATE](../../docs/protocol/READ_STATE.md)): every root message at or below it is read.
- `LiveRoom.reads` (`crates/rv-protocol/src/live.rs`, `ReadMark { user_id, root_position }`) carries the other members' positions in the live snapshot (`apps/server/src/live.rs`, `state`), names from the snapshot's `profiles`. Never the reader's own; only in rooms of at most `RECEIPT_MEMBERS` (50) members; none at all past 512 marks in a snapshot. Threads keep their own reads and have no receipts. Documented in `docs/protocol/LIVE.md`.
- `UserPreferences.share_read_receipts` (on by default; `UpdatePreferences.share_read_receipts: Option<bool>`, absent keeps), column `users.share_reads` (migration `0056_read_receipts.sql`). Both ways: off, an account's marks are not sent to anyone and it receives none. Test: `apps/server/src/live.rs`, `read_receipts_follow_the_reads_both_ways_and_skip_large_rooms`.

## What every app shows (the rule)

- Take my most recent message in the room's main timeline (a root message, mine, confirmed by the server: not one still in the outbox, not a system message). Its readers are the marks whose `root_position` is at least the message's `position` (positions compare as numbers: a longer decimal string is greater, equal lengths compare as text).
- No reader: nothing shows. A direct room: "Seen". A group: "Seen by" and up to three names (display name, else username), then "and 1 other" or "and N others" (FR: "Vu", "Vu par", "et 1 autre", "et N autres"). A reader the frame has no profile for is counted in the others, never shown as an id; with no known name at all the line is "Seen".
- No line in an encrypted room (its rows come from the private journal, whose positions are not the read positions), nor while the timeline shows an older stretch of history after a jump (my latest message is not on screen; an older one must not carry it).
- A small dim line under that message, in the timeline only, never in a thread. Nothing for an older message: being older, it is read too.
- Settings > My account: "Share read receipts" (FR "Partager les confirmations de lecture"), a switch, with the explanation that it works both ways. It sends `share_read_receipts` alone (the other preferences fields as read, `quiet_hours` and `muted_until` absent).

## Web

`seen` and `seenText` (`src/receipts.ts`, tested in `tests/receipts.test.ts`) apply the rule to the room's timeline (`App.seenLine`, `paintTimeline`'s `seen`, a `.seen-receipt` line under the message in `ui/messages.tsx`), names from the live frame's `profiles`; a frame whose `reads` changed for the open room repaints the timeline. An encrypted room renders through `PrivateChat` and shows none. A jump keeps the newest page in the same timeline, so the line stays on the latest message. Settings > My account, group "Privacy" (`panels.ts`): the switch sends `share_read_receipts` alone. Browser test `tests/receipts.mjs` (a read shows live as "Seen by", the switch hides it), in CI.

## Mobile

- The rule is `apps/mobile/lib/readReceipts.ts` (pure, `node --test`): `receiptAnchor` walks the timeline rows newest first and keeps the first of mine that is not a system message, not a thread reply (even one also sent to the room), not in the outbox and has a stored server position (`native_positions`; a deleted message has no row); `readersAt` keeps the marks at or past it (`comparePositions`, decimal strings); `receiptLine` gives "Seen" for a direct room, else up to three names (`RECEIPT_NAMES`) and the count of the rest. A reader the frame has no profile for is counted, never shown as an id; with no name at all the line reads "Seen".
- The provider exposes the frame: `NativeLive.reads(rid)` (`providers/rocketvibe/live.ts`, the frame's own array, empty once the photo expires) and `NativeLive.memberName(uid)` (display name, else username, from `profiles`, then presence and direct peers). Listeners fire only when a frame changes, so the line follows within a frame (2 s).
- `useReadReceipt` (`ui/readReceipts.tsx`) feeds the rule from the room screen (`app/room/[rid].tsx`: the rows shown, `provider.identity.accountId`, the room's positions, the outbox rows, `room.type === 'd'`) and `ReadReceiptLine` draws the dim line (the `object-select` check icon, 11 pt, `tertiaryText`, aligned with the message bodies) under that row; the list's `extraData` carries it so the row re-renders. Off in a context window (an older stretch of history), in an encrypted room (its rows come from the private journal, with no stored position, and the screen marks no read there), and in the thread screen, which never calls it. Strings `room.seen`, `room.seenBy`, `room.seenByOne` ("and 1 other"), `room.seenByOthers` (`ui/messages.ts`, FR and EN).
- Settings > My account, RocketVibe accounts only: a "Privacy" card (`PrivacyCard`, `ui/settingsSections.tsx`) with the "Share read receipts" switch and its hint (`settings.privacy`, `settings.shareReads`, `settings.shareReadsHelp`), absent preference read as on. It saves through `useNativePreferences` (`ui/nativePreferences.ts`): `preferencesInput` (`providers/rocketvibe/profileOperations.ts`) puts `share_read_receipts` in the command only when the change names it, so the switch sends it with the other fields as read and `quiet_hours` / `muted_until` absent, and a language, push or do-not-disturb change never carries it. The same save state as the other native preferences shows a failure and Retry or Cancel of a pending command. Tests: `providers/rocketvibe/profiles.test.ts`, `providers/rocketvibe/live.test.ts`.

## Desktop

GTK and SwiftUI, over rv-core.

- **The rule** is `rv-core/src/native/receipts.rs`, pure and unit-tested: `latest_own` (a `Candidate` of mine with a decimal position, not in the outbox, not a system message, not a thread reply; the highest position wins, whatever the rows' order), `readers` (the marks at or past it under `compare`, the decimal-string order; each reader once, never me), `line` and `receipt`, then `place`, which sets `timeline::Display.seen` on that row and clears it on every other. Up to three names, display name else username; past them `receipts.and_others` is a plural (`tn`: "and 1 other", "and 2 others"); a reader whose name is not known is counted among the others, never shown as an id, and with no name known at all the line is "Seen". Strings: `receipts.*` in `rv-core/src/i18n.rs`.
- **The data**: `LiveCache::reads` (`native/live.rs`) hands the room's marks, the membership version they belong to and the readers' profiles from the frame, only while the frame is fresh. `NativeSession::read_receipt(room, candidates)` uses them only when that membership is the room's current one in the store (like typing), names a reader from the frame's profile, else the stored identity (`NativeStore::profile_identity`), and knows a direct room by `NativeStore::room_direct`. It answers None in an encrypted room (`NativeStore::room_encrypted`, an unknown answer counting as encrypted): those keep their own private view (`chat.rs` and rv-ffi `native_crypto/messages.rs` group without it). `NativeSession::timeline(rows, room, after)` is `read_presentation::group` plus the receipt: the main timeline only; threads keep `group` and never get a line. The RocketVibe timeline is always the newest `limit` rows of the store (a jump to an old message raises the limit and pages back, it opens no detached window), so the newest messages are always in it and the line never shows over an older stretch alone.
- **Live**: a live frame whose snapshot changed sends the session's event and the page reads again. GTK's `MessageList::set_native_rows` compares the `Display` rows (`seen` included) and returns early when nothing moved; otherwise `update_in_place` rebuilds only the rows that differ, the one losing the line and the one gaining it. SwiftUI compares `MessageItem`s (`RoomModel.reload`), and `MessageRow` is `Equatable` on its item.
- **GTK**: a dim line (`message-note read-receipt`) at the foot of the message's column (`rv-gtk/src/rows.rs`). The ordinary timeline goes through `QuoteCards`, whose scope without a root calls `timeline` (`native_quote_cards.rs`).
- **SwiftUI**: `MessageItem.seen` (rv-ffi `model.rs`). `message_items` and `message_items_from_boundary` go through `timeline` (`timeline_items` in `rv-ffi/src/native.rs`), `thread_message_items` does not. `MessageRow.footer` (`macos/Sources/RocketVibe/RoomView.swift`) shows it in `Vibe.faint`, 11 points.
- **The setting**: GTK's account page gets a "Privacy" group with an `adw::SwitchRow` "Share read receipts" and its hint (`rv-gtk/src/settings/native_profiles.rs`); it sends `preferences_input` with `share_read_receipts: Some(_)` alone, and the page's 250 ms refresh shows the saved value (or a queued change's). SwiftUI: `PrivacySection` under My account (`SettingsView.swift`), `MyProfileModel.setShareReadReceipts`, rv-ffi `NativeChat::set_share_read_receipts` and `NativePreferences.share_read_receipts` (`native_profiles.rs`).
- Not run against a server: the GTK and SwiftUI screens were not walked against a RocketVibe server with migration 0056; SwiftUI is checked by `swiftc -parse` and the macOS CI only.

## Sources

- apps/web/src/receipts.ts
- apps/web/src/app.ts
- apps/web/src/ui/messages.tsx
- apps/web/src/panels.ts
- apps/web/tests/receipts.mjs
- apps/mobile/lib/readReceipts.ts
- apps/mobile/ui/readReceipts.tsx
- apps/mobile/app/room/[rid].tsx
- apps/mobile/providers/rocketvibe/live.ts
- apps/mobile/providers/rocketvibe/profileOperations.ts
- apps/mobile/ui/settingsSections.tsx
- apps/desktop/crates/rv-core/src/native/receipts.rs
- apps/desktop/crates/rv-core/src/native/live.rs
- apps/desktop/crates/rv-core/src/native/store.rs
- apps/desktop/crates/rv-core/src/timeline.rs
- apps/desktop/crates/rv-core/src/i18n.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/native_quote_cards.rs
- apps/desktop/crates/rv-gtk/src/settings/native_profiles.rs
- apps/desktop/crates/rv-ffi/src/native.rs
- apps/desktop/crates/rv-ffi/src/native_profiles.rs
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/desktop/macos/Sources/RocketVibe/SettingsView.swift
- apps/desktop/macos/Sources/RocketVibeKit/MyProfileModel.swift
- crates/rv-protocol/src/live.rs
- crates/rv-protocol/src/parity.rs
- crates/rv-protocol/src/profiles.rs
- apps/server/migrations/0056_read_receipts.sql
- apps/server/src/live.rs
- apps/server/src/profiles.rs
- docs/protocol/LIVE.md
- docs/protocol/PROFILES.md
