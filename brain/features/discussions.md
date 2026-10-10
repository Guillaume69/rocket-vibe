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

Not implemented in GTK or SwiftUI: a `discussion-created` message reads as an unknown system message there. See [parity](../parity.md) §6.

## Sources

- apps/mobile/ui/discussion.tsx
- apps/mobile/app/new-discussion.tsx
- apps/mobile/lib/discussions.ts
- apps/mobile/lib/normalize.ts
- apps/mobile/db/schema.ts
- apps/mobile/ui/messageRow.tsx
- apps/mobile/app/message-actions.tsx
- apps/mobile/app/room-info.tsx
- apps/mobile/lib/systemMessages.ts
