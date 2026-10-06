# Native threads (P11)

The Rust server and the mobile / desktop providers use the existing thread screens,
message lists, menus and composers. The Rocket.Chat provider
keeps its routes and its `tmid` model; RocketVibe announces `threads` and uses
`reply_to` / `root_id`. The qualification of the installed applications remains open.

## Roots and replies

`POST /api/v1/rooms/{room}/messages` accepts an optional `SendMessage.reply_to`.
Its absence keeps the sending of a root and the earlier idempotent fingerprint.
A reply keeps the same operation ID, text, quotes and root across
a retry or a restart. Changing the root under the same ID gives a conflict.

The root must belong to the same room, be a confirmed non-deleted message,
with no parent and no system activity. An unknown root / one from another room returns
`404`, a reply used as a root `422 invalid_thread_root`, and a deleted
root `410 thread_root_deleted`. The receipt of an already committed reply remains
replayable after its root is deleted, for a current member of the room.

`Message.reply_to` identifies replies. A root receives `Message.thread`
with `replies` as an exact decimal and `last_reply_at`. The count covers only
non-deleted replies. Creating and deleting a reply also publish
a new revision of the root without changing its creation position.
The room history and its main list contain only roots.

`GET /api/v1/messages/{root}/thread?before=…&limit=…` returns `ThreadPage`:
root, replies by descending position, `has_more` and personal state.
The limit is 50 by default, between 1 and 100. The transactional view and the
delivery barriers also cover the sources of quotes.
A deleted root remains consultable as a tombstone with its old replies.
The instance administration gives no implicit access to a private thread.
The reserved route `GET /messages/{root}/replies` returns this same page.
`POST /messages/{root}/replies` sends into the root in the path; a redundant
`reply_to` must designate it exactly. Both send routes share the same
fingerprint, the same rights and the same receipt, including after root deletion.

Snapshots keep at most 50 roots **and** 50 recent replies per room.
A flood of replies therefore does not push all the roots out of the window.
Opening a thread then completes its history by pages. The mobile and desktop
projections verify the room, the root, the exact positions and the membership
duration before the SQLite commit; a failure confirms no intent.

## Independent reads

`POST /api/v1/messages/{root}/thread/read` receives `{ position }`, captured from
a confirmed reply actually displayed. `ThreadReadState` contains
`root_id`, `room_id`, `membership_version`, `position`, `revision` and `unread`.
Positions, revisions and counters remain canonical strings, including
beyond `2^53`.

The read advances by maximum, without going back after an old receipt.
It clears neither the unread of the roots nor those of the other threads. Global
room reads now accept `reply_position`; a read of an effective
reply takes the maximum of this position and that of the thread. Room counters
and mentions use the same rule. Own sends, edits,
reactions and system activities add no unread.

The persistent caches keep one intent per thread. A receipt covering an
old observation does not erase a more recent observation. New
membership: positions initialized at the room maximum with no historical backlog.
Removal, change of generation or of membership duration: deletion of the
drafts, intents and private messages of the thread, then refusal of old callbacks.

## Composers and qualification

Each thread has its own draft, distinct from the room's. GTK and SwiftUI
reuse their panels; mobile uses `/thread/[id]`. The room right and
the availability of the root control sending. A deleted root keeps
the draft and makes the thread consultable without accepting a new reply.
Quotes use the existing cards and controls, including in a thread.

The PostgreSQL tests cover pagination, monotonic / independent reads,
mentions, rights, deletion, replay and removal. The SQLite caches cover
on-disk restart, exact positions, rollback and old memberships.
The real mobile provider verifies a lost confirmation and a replay after
root deletion. The GTK journeys and Swift models use their existing interface
and keychain against PostgreSQL. Physical Android, installed Windows and
the macOS application remain explicitly open external validations.
