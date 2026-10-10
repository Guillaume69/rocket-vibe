# Discussions

A Rocket.Chat discussion is a room of its own, born from a parent room (and optionally from one of its messages), which the parent announces with a card. The mobile app shows that card, opens the discussion (joining it when it belongs to a public channel) and creates discussions; the desktop apps do not yet.

## The server contract

Probed on 8.5.1 (2026-10-10); also in `CLAUDE.md`, "Discussions".

- `POST rooms.createDiscussion {prid, t_name, pmid?, reply?, users?}` creates a room whose `prid` is the parent, `fname` the name and `name` a random id, of the parent's kind (`c` in a channel); it answers `{discussion: <room document>}`. An **empty `t_name` is accepted** and makes a nameless room, so the client requires one. A DM can host a discussion. With `pmid`, the source message itself is left unchanged.
- The parent gets a `discussion-created` system message whose `msg` is the name and whose `drid`, `dcount` and `dlm` name the discussion, its message count and its last message time.
- The creator (and the users listed) are members. Anyone else reaches a discussion of a public channel by `channels.join`, like any channel; one of a private group is for its members only.

## Mobile

- **Storage.** `messages.discussion_id`, `discussion_count`, `discussion_last` (migration `0029`), from `drid`, `dcount`, `dlm` in `lib/normalize.ts`.
- **Card.** `ui/discussion.tsx` (`DiscussionCard`), drawn by `MessageRow` for a `discussion-created` message: "Discussion", the name, "N messages · last" (`useListTimeFormatter`) and Open. `useOpenDiscussion` opens the room when it is local, else reads `rooms.info` and, for a channel, `channels.join`s it and ingests it first; a private discussion the account is not in says so. Elsewhere the message reads as a sentence (`sys.discussionCreated`).
- **Creation.** `app/new-discussion.tsx`, a form sheet: a name (required, suggested from the message's first line by `suggestedName`, `lib/discussions.ts`) and an optional first message (`reply`). Reached from a message's actions ("Start a discussion", where Forward is offered: Rocket.Chat, an ordinary message) and from the room information sheet ("New discussion", outside encrypted rooms). The answer's room is ingested and opened.
- The discussion then lives in the room list like any room, under its `fname`.

## Desktop

- The store keeps `drid`, `dcount`, `dlm` (`rv-core/src/store.rs`, a migration), and a `discussion-created` message renders as a card (GTK `cards::discussion` in `rv-gtk/src/cards.rs`, SwiftUI `DiscussionCardView` in `Discussions.swift`): name, "N messages · last", Open. The figures lag by one (the creation's first message is not counted, CLAUDE.md "Discussions").
- Open (`Session::open_discussion`): the room opens if it is listed; otherwise `rooms.info` says what it is, and a public one is joined (`channels.join`, through `rocketchat::actions`), a private one says it is for members only.
- Create: "Start a discussion" beside Forward in the message menu, "New discussion" in the room information dialog, not in an encrypted or read-only room (`Session::discussions_available`). The dialog (GTK `rv-gtk/src/discussions.rs`, closing on its backdrop; SwiftUI `NewDiscussionSheet`) requires a name, suggests one from the message's first line (60 characters at most) and takes an optional first message; `Session::create_discussion` (`rocketchat::actions::create_discussion`) ingests the new room, catches it up and opens it.
- Rocket.Chat only; Mattermost and kChat refuse these calls without a request (`tests/session_backends.rs`).

## Sources

- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/rocketchat/actions.rs
- apps/desktop/crates/rv-gtk/src/discussions.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/macos/Sources/RocketVibe/Discussions.swift

- apps/mobile/ui/discussion.tsx
- apps/mobile/app/new-discussion.tsx
- apps/mobile/lib/discussions.ts
- apps/mobile/lib/normalize.ts
- apps/mobile/db/schema.ts
- apps/mobile/ui/messageRow.tsx
- apps/mobile/app/message-actions.tsx
- apps/mobile/app/room-info.tsx
- apps/mobile/lib/systemMessages.ts
