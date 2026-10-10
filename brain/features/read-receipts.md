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

Not offered yet.

## Desktop

Not offered yet (GTK, SwiftUI).

## Sources

- crates/rv-protocol/src/live.rs
- crates/rv-protocol/src/parity.rs
- crates/rv-protocol/src/profiles.rs
- apps/server/migrations/0056_read_receipts.sql
- apps/server/src/live.rs
- apps/server/src/profiles.rs
- docs/protocol/LIVE.md
- docs/protocol/PROFILES.md
