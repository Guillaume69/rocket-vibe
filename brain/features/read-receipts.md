# Read receipts (RocketVibe server)

On a RocketVibe server, the room shows how far the others read: under my most recent message, "Seen" in a direct conversation, "Seen by Bob, Carol" in a group. It is live (the server's live frame, every 2 seconds) and needs no request of its own. An account can turn it off, both ways. Rocket.Chat (whose read receipts are an Enterprise feature) and Mattermost accounts have none here.

## The contract

- The server already keeps each member's read position per room (`room_read_states.root_position`, [READ_STATE](../../docs/protocol/READ_STATE.md)): every root message at or below it is read.
- `LiveRoom.reads` (`crates/rv-protocol/src/live.rs`, `ReadMark { user_id, root_position }`) carries the other members' positions in the live snapshot (`apps/server/src/live.rs`, `state`), names from the snapshot's `profiles`. Never the reader's own; only in rooms of at most `RECEIPT_MEMBERS` (50) members; none at all past 512 marks in a snapshot. Threads keep their own reads and have no receipts. Documented in `docs/protocol/LIVE.md`.
- `UserPreferences.share_read_receipts` (on by default; `UpdatePreferences.share_read_receipts: Option<bool>`, absent keeps), column `users.share_reads` (migration `0056_read_receipts.sql`). Both ways: off, an account's marks are not sent to anyone and it receives none. Test: `apps/server/src/live.rs`, `read_receipts_follow_the_reads_both_ways_and_skip_large_rooms`.

## What every app shows (the rule)

- Take my most recent message in the room's main timeline (a root message, mine, confirmed by the server: not one still in the outbox, not a system message). Its readers are the marks whose `root_position` is at least the message's `position` (positions compare as numbers: a longer decimal string is greater, equal lengths compare as text).
- No reader: nothing shows. A direct room: "Seen". A group: "Seen by" and up to three names (display name, else username), then "and N others" (FR: "Vu", "Vu par", "et N autres").
- A small dim line under that message, in the timeline only, never in a thread. Nothing for an older message: being older, it is read too.
- Settings > My account: "Share read receipts" (FR "Partager les confirmations de lecture"), a switch, with the explanation that it works both ways. It sends `share_read_receipts` alone (the other preferences fields as read, `quiet_hours` and `muted_until` absent).

## Web

Not offered yet.

## Mobile

- The rule is `apps/mobile/lib/readReceipts.ts` (pure, `node --test`): `receiptAnchor` walks the timeline rows newest first and keeps the first of mine that is not a system message, not a thread reply (even one also sent to the room), not in the outbox and has a stored server position (`native_positions`; a deleted message has no row); `readersAt` keeps the marks at or past it (`comparePositions`, decimal strings); `receiptLine` gives "Seen" for a direct room, else up to three names (`RECEIPT_NAMES`) and the count of the rest. A reader the frame has no profile for is counted, never shown as an id; with no name at all the line reads "Seen".
- The provider exposes the frame: `NativeLive.reads(rid)` (`providers/rocketvibe/live.ts`, the frame's own array, empty once the photo expires) and `NativeLive.memberName(uid)` (display name, else username, from `profiles`, then presence and direct peers). Listeners fire only when a frame changes, so the line follows within a frame (2 s).
- `useReadReceipt` (`ui/readReceipts.tsx`) feeds the rule from the room screen (`app/room/[rid].tsx`: the rows shown, `provider.identity.accountId`, the room's positions, the outbox rows, `room.type === 'd'`) and `ReadReceiptLine` draws the dim line (the `object-select` check icon, 11 pt, `tertiaryText`, aligned with the message bodies) under that row; the list's `extraData` carries it so the row re-renders. Off in a context window (an older stretch of history), in an encrypted room (its rows come from the private journal, with no stored position, and the screen marks no read there), and in the thread screen, which never calls it. Strings `room.seen`, `room.seenBy`, `room.seenByOne` ("and 1 other"), `room.seenByOthers` (`ui/messages.ts`, FR and EN).
- Settings > My account, RocketVibe accounts only: a "Privacy" card (`PrivacyCard`, `ui/settingsSections.tsx`) with the "Share read receipts" switch and its hint (`settings.privacy`, `settings.shareReads`, `settings.shareReadsHelp`), absent preference read as on. It saves through `useNativePreferences` (`ui/nativePreferences.ts`): `preferencesInput` (`providers/rocketvibe/profileOperations.ts`) puts `share_read_receipts` in the command only when the change names it, so the switch sends it with the other fields as read and `quiet_hours` / `muted_until` absent, and a language, push or do-not-disturb change never carries it. The same save state as the other native preferences shows a failure and Retry or Cancel of a pending command. Tests: `providers/rocketvibe/profiles.test.ts`, `providers/rocketvibe/live.test.ts`.

## Desktop

Not offered yet (GTK, SwiftUI).

## Sources

- apps/mobile/lib/readReceipts.ts
- apps/mobile/ui/readReceipts.tsx
- apps/mobile/app/room/[rid].tsx
- apps/mobile/providers/rocketvibe/live.ts
- apps/mobile/providers/rocketvibe/profileOperations.ts
- apps/mobile/ui/settingsSections.tsx
- crates/rv-protocol/src/live.rs
- crates/rv-protocol/src/parity.rs
- crates/rv-protocol/src/profiles.rs
- apps/server/migrations/0056_read_receipts.sql
- apps/server/src/live.rs
- apps/server/src/profiles.rs
- docs/protocol/LIVE.md
- docs/protocol/PROFILES.md
