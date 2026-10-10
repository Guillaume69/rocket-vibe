# Composer

The field at the bottom of a room or thread: the text, its persisted draft, `@` / `:` / `/` completion, the reply (quote) banner, staged attachments and the voice button. A send goes through the optimistic text outbox, the file queue, or `commands.run` for a slash command. Mobile has one shared component (`ui/composer.tsx`); desktop has `rv-gtk/src/composer.rs` (GTK) and `Composer.swift` (SwiftUI), both over `rv-core`.

## What a send does

- **Text** goes to the outbox: a client-generated 24-hex `_id`, an optimistic row shown at once, the intent persisted, then `chat.sendMessage`. A replay never duplicates (the server dedups on `_id`). The full mechanism, including the 400-on-replay quirk confirmed by `chat.getMessage`, is in [offline and sync](offline-and-sync.md).
- **Staged files** go to the upload queue one by one, in order, and the typed text becomes the caption of the **first** file only (repeated on each, it would show as many times). See [uploads](uploads.md).
- **A draft that starts with `/name`** where `name` is a command the server lists goes to `commands.run`. See [slash commands](slash-commands.md).
- In an encrypted room the outbox encrypts when the message leaves, never before; a locked room shows an "unlock" composer on mobile (`LockedComposer`). See [E2EE](e2ee.md).
- A read-only room shows a note instead of the composer (mobile), or hides it (desktop).

Neither app **emits** the typing indicator: emitting needs a DDP method call, and the DDP client has no `call` by design (`lib/typing.ts`). Both only listen.

## Drafts

Drafts are kept per room (`rid`) and per thread (`rid:tmid`), written 400 ms after the last keystroke, removed when blank, and live in the per-server, per-account database, so they never leak between accounts.

- Mobile: table `drafts` (drafts; `db/schema.ts`), through the write queue of `DraftStore` so a debounced write that lands during a sync batch is not lost with that batch's transaction. `ui/drafts.ts` (`useDraft`) creates one debouncer per key (`ui/deferredDraft.ts`, tested with an injected clock) and **flushes on unmount or key change**, under the old key: the last characters typed before leaving are kept, and never written under the new room. The screen mounts the composer only once the draft is read, so it cannot overwrite it with an empty string. MMKV was considered and rejected: the debounce hides SQLite's latency and the extra native dependency was not worth it.
- Desktop: table `drafts` (`Store::draft`, `set_draft`). GTK's `Composer::bind` restores the draft and debounces with a generation counter; SwiftUI's `RoomModel.draft` uses a cancellable 400 ms task.
- After a file send, mobile clears the field only if it still holds the caption that left: text typed during a long upload is kept (`draftRef`).

## Replies (quotes)

A reply uses Rocket.Chat's native quote: the text is prefixed by an invisible link `[ ](<permalink>?msg=<id>)`. The server recognises it, attaches the quoted message (`message_link`, `author_name`, `text`) and skips its link preview, so quotes interoperate with the official clients.

- The permalink is built on the server's `Site_Url`, falling back on the base URL (mobile `messagePermalink` in `lib/quote.ts`, desktop `Session::permalink` / `actions::permalink`), with the canonical path `/channel/<name>`, `/group/<name>` or `/direct/<rid>`. Built on the base URL alone it was not recognised whenever the two differed (proxy alias, emulator `10.0.2.2`), and the quote vanished once the server echo replaced the optimistic attachments.
- Mobile: the action sheet arms a target in a module store (`ui/reply.ts`) keyed `rid` or `rid:threadId`, so a room and a thread stacked on it never steal each other's target. The composer shows it in `ReplyBanner` with a thumbnail of the quoted image, focuses the field, and on send prefixes the text (`quote`) and shows an optimistic quote card (`localQuoteAttachment`, nested at most 2 levels) until the server version arrives. The target is consumed by the send, cancelled by the cross or the Android back button, and cleared at session end (`forgetReplies`): the permalink embeds the old server's URL. A reply is not offered in an encrypted room (the server cannot read the text it would build the card from); one answers in a thread there.
- GTK: `Composer::set_reply` shows a bar with the author and a preview; `submit` applies `actions::quote`.
- SwiftUI: "Reply" puts the quote link at the start of the draft (`RoomModel.quote`), with no separate bar.

## Mentions and emoji

`@` completion offers the room's recent authors, most recent first, then `@all` and `@here`. Candidates come from the local database only, never a `spotlight` call per keystroke (REST is rate-limited). The insertion is plain `@username `: the server re-parses mentions.

- Mobile (`lib/mentionCompletion.ts`, `ui/mentionCompletion.tsx`): authors of the room's last 400 messages; a bare `@` shows all; ranking is exact, then prefix, then substring, a person before a special mention, ties by recency; up to 12 in a horizontal band. `@` only opens a token at a word start (not inside an email), and the query must stay in the username charset. A thread offers the whole room's authors.
- Desktop (`rv-core/src/completion.rs`, `Store::recent_authors`): the last 30 authors, case-insensitive prefix, myself excluded, 8 at most, in a popover driven by arrows, Enter, Tab and Escape.

`:` completion, custom emoji and the picker are in [emoji](emoji.md). The `@`, `:` and `/` bands are mutually exclusive.

## Editing

Editing is a message action, not a composer mode. Mobile edits in the action sheet's own text field ([message actions](message-actions.md)). GTK edits in place in the message list (`MessageList::start_edit`), and **Up in an empty composer** edits my last message when the server still allows it (else a "too late" toast). SwiftUI opens an edit card in a modal overlay on Up (`Composer.swift`) and edits in place from the menu.

## Formatting

GTK has a formatting toolbar (bold, italic, strike, heading, link, inline code, code block, quote, bullets, numbers) over `rv-core/src/compose.rs`, which toggles Rocket.Chat markers around the selection or before its lines. The draft is styled as typed (`compose::spans`), markers are hidden except on the cursor's line (`hidden_markers`), Shift+Enter in a list continues it (`list_break`), and misspelled words get suggestions and "Add to dictionary" on right-click (`rv-gtk/src/spell.rs`). Every desktop send and edit passes through `compose::fenced`, which puts code fences on lines of their own as the server's parser needs. SwiftUI uses AppKit's text view (system spell checker, Emoji & Symbols) without a toolbar. Mobile has no formatting aids: the user types markdown.

Mobile has the toolbar without the live styling: "Aa" beside 😀 shows a row of buttons (bold, italic, strike, link, inline code, code block, quote, bullets, numbers, in GTK's order) over `lib/formatting.ts`, a port of `toggle_wrap`, `toggle_lines`, `code_block` and `link` with their test cases; they act on the selection the composer now tracks whole (`selectionEnd`, `placeSelection` in `ui/emojiCompletion.tsx`) and select the result.

## Keys and layout

- GTK: Enter sends, Shift+Enter breaks the line, the field grows to 160 px then scrolls.
- SwiftUI: Return sends, Shift+Return breaks the line, Cmd+Return on the send button; the field grows to 170 px.
- GTK and mobile share one layout: an outlined pill holding attach, the field, the emoji button and the microphone, its border cyan with a soft halo while the field has the focus (`.composer-pill` in `rv-gtk/src/style.rs`; `styles.pill` in `apps/mobile/ui/composer.tsx`), then a round gradient send button with an up arrow. On mobile the send button is always there, dimmed and inert while there is nothing to send (no text, staged file or armed RocketVibe reply), and becomes the red stop button while recording, where GTK swaps the whole row for its recording bar. Mobile's field is multiline (Enter breaks the line; in a list item the break continues the list, or ends it on an empty item: `lib/listBreak.ts`, a port of `compose::list_break` with its test cases, applied in `ui/composer.tsx`'s `changeDraft` when `typedBreak` sees exactly one break typed at the caret); the smiley swaps the keyboard for the emoji panel and becomes a keyboard while it is open.

## Attachments in the composer

Mobile: the paperclip opens a native sheet (`app/attach.tsx`) offering photo, video (camera), library (up to 10, ordered) or file. The sheet answers through `ui/attachmentSource.ts` while staying open and the composer closes it after the picker returns, because Android crashes durably when an activity launches while a view is being removed (`ui/launchPicker.ts`). Picked files become chips (`ui/stagedAttachments.tsx`): a thumbnail, a real player for voice, a Reduced / Original toggle for reducible media (reduction happens at send, not at pick). Android back removes the last chip; a removed chip deletes its cache copy. Leaving the room parks the chips in memory for that room and thread (`parkedAttachments`).

Desktop: the file chooser, drag-and-drop on the page and paste (files, or a picture saved as PNG) stage files as chips (`rv-gtk/src/staged.rs`) with a preview and an image quality choice; `Staged::switch` keeps each room's chips while another is open.

## Parity

Both apps: outbox send with retry, drafts per room and thread, `@`/`:` completion, picker, quote reply, attachments with captions and quality, voice, slash commands. Formatting toolbar: GTK and mobile; live styling: GTK only. Desktop only: spell check, Up-to-edit. List continuation: all three (SwiftUI on Shift+Return through rv-ffi's `list_break`). Mobile only: video reduction. All clients can replay a staged voice message before sending.

## Web

The native serving-origin client uses the GTK toolbar/draft styling with a real DOM editor and ordinary native-protocol room/thread outboxes. Prepared files have GTK's 40-pixel thumbnail, name/type/size, remove and inline sound replay. Image preview opens the full-size viewer without invented caption or per-image size controls. The Original-quality checkbox is parked per room, defaults to reduction and applies JPEG 1920/82 when the batch leaves; [uploads](uploads.md) describes its atomic queue handoff, ordering and first-file caption. The native recording bar supplies elapsed time, Cancel and stop-to-listen; [voice messages](voice-messages.md) describes capture and replay. Browser tests qualify these flows on actual files.

## Sources

- apps/mobile/ui/composer.tsx
- apps/mobile/ui/icon.tsx
- apps/desktop/crates/rv-gtk/src/composer.rs
- apps/desktop/crates/rv-gtk/src/style.rs
- apps/web/src/app.ts
- apps/web/src/staged.ts
- apps/web/src/uploads.ts
- apps/web/tests/images.mjs
- apps/web/tests/features.mjs

- apps/mobile/ui/composer.tsx
- apps/mobile/ui/drafts.ts
- apps/mobile/ui/deferredDraft.ts
- apps/mobile/ui/reply.ts
- apps/mobile/ui/replyBanner.tsx
- apps/mobile/lib/quote.ts
- apps/mobile/lib/mentionCompletion.ts
- apps/mobile/ui/mentionCompletion.tsx
- apps/mobile/lib/typing.ts
- apps/mobile/lib/outbox.ts
- apps/mobile/ui/stagedAttachments.tsx
- apps/mobile/ui/attachmentPreview.tsx
- apps/mobile/ui/attachmentSource.ts
- apps/mobile/ui/launchPicker.ts
- apps/mobile/app/attach.tsx
- apps/mobile/db/schema.ts
- apps/desktop/crates/rv-gtk/src/composer.rs
- apps/desktop/crates/rv-gtk/src/staged.rs
- apps/desktop/crates/rv-gtk/src/spell.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-core/src/compose.rs
- apps/desktop/crates/rv-core/src/completion.rs
- apps/desktop/crates/rv-core/src/actions.rs
- apps/desktop/crates/rv-core/src/outbox.rs
- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/macos/Sources/RocketVibe/Composer.swift
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
