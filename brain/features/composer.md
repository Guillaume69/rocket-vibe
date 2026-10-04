# Composer

The field at the bottom of a room or thread: the text, its persisted draft, `@` / `:` / `/` completion, the reply (quote) banner, staged attachments and the voice button. A send goes through the optimistic text outbox, the file queue, or `commands.run` for a slash command. Mobile has one shared component (`ui/composer.tsx`); desktop has `rv-gtk/src/composer.rs` (GTK) and `Composer.swift` (SwiftUI), both over `rv-core`.

## What a send does

- **Text** goes to the outbox: a client-generated 24-hex `_id`, an optimistic row shown at once, the intent persisted, then `chat.sendMessage`. A replay never duplicates (the server dedups on `_id`). The full mechanism, including the 400-on-replay quirk confirmed by `chat.getMessage`, is in [offline and sync](offline-and-sync.md).
- **Staged files** go to the upload queue one by one, in order, and the typed text becomes the caption of the **first** file only (repeated on each, it would show as many times). See [uploads](uploads.md).
- **A draft that starts with `/name`** where `name` is a command the server lists goes to `commands.run`. See [slash commands](slash-commands.md).
- In an encrypted room the outbox encrypts when the message leaves, never before; a locked room shows an "unlock" composer on mobile (`ComposerVerrouille`). See [E2EE](e2ee.md).
- A read-only room shows a note instead of the composer (mobile), or hides it (desktop).

Neither app **emits** the typing indicator: emitting needs a DDP method call, and the DDP client has no `call` by design (`lib/saisie.ts`). Both only listen.

## Drafts

Drafts are kept per room (`rid`) and per thread (`rid:tmid`), written 400 ms after the last keystroke, removed when blank, and live in the per-server, per-account database, so they never leak between accounts.

- Mobile: table `brouillons` (drafts; `db/schema.ts`), through the write queue of `DepotBrouillons` so a debounced write that lands during a sync batch is not lost with that batch's transaction. `ui/brouillons.ts` (`useBrouillon`) creates one debouncer per key (`ui/brouillonDifferre.ts`, tested with an injected clock) and **flushes on unmount or key change**, under the old key: the last characters typed before leaving are kept, and never written under the new room. The screen mounts the composer only once the draft is read, so it cannot overwrite it with an empty string. MMKV was considered and rejected: the debounce hides SQLite's latency and the extra native dependency was not worth it.
- Desktop: table `drafts` (`Store::draft`, `set_draft`). GTK's `Composer::bind` restores the draft and debounces with a generation counter; SwiftUI's `RoomModel.draft` uses a cancellable 400 ms task.
- After a file send, mobile clears the field only if it still holds the caption that left: text typed during a long upload is kept (`brouillonRef`).

## Replies (quotes)

A reply uses Rocket.Chat's native quote: the text is prefixed by an invisible link `[ ](<permalink>?msg=<id>)`. The server recognises it, attaches the quoted message (`message_link`, `author_name`, `text`) and skips its link preview, so quotes interoperate with the official clients.

- The permalink is built on the server's `Site_Url`, falling back on the base URL (mobile `permalienMessage` in `lib/citation.ts`, desktop `Session::permalink` / `actions::permalink`), with the canonical path `/channel/<name>`, `/group/<name>` or `/direct/<rid>`. Built on the base URL alone it was not recognised whenever the two differed (proxy alias, emulator `10.0.2.2`), and the quote vanished once the server echo replaced the optimistic attachments.
- Mobile: the action sheet arms a target in a module store (`ui/reponse.ts`) keyed `rid` or `rid:filId`, so a room and a thread stacked on it never steal each other's target. The composer shows it in `BandeauReponse` with a thumbnail of the quoted image, focuses the field, and on send prefixes the text (`citer`) and shows an optimistic quote card (`jointeCitationLocale`, nested at most 2 levels) until the server version arrives. The target is consumed by the send, cancelled by the cross or the Android back button, and cleared at session end (`oublierReponses`): the permalink embeds the old server's URL. A reply is not offered in an encrypted room (the server cannot read the text it would build the card from); one answers in a thread there.
- GTK: `Composer::set_reply` shows a bar with the author and a preview; `submit` applies `actions::quote`.
- SwiftUI: "Reply" puts the quote link at the start of the draft (`RoomModel.quote`), with no separate bar.

## Mentions and emoji

`@` completion offers the room's recent authors, most recent first, then `@all` and `@here`. Candidates come from the local database only, never a `spotlight` call per keystroke (REST is rate-limited). The insertion is plain `@username `: the server re-parses mentions.

- Mobile (`lib/completionMention.ts`, `ui/completionMention.tsx`): authors of the room's last 400 messages; a bare `@` shows all; ranking is exact, then prefix, then substring, a person before a special mention, ties by recency; up to 12 in a horizontal band. `@` only opens a token at a word start (not inside an email), and the query must stay in the username charset. A thread offers the whole room's authors.
- Desktop (`rv-core/src/completion.rs`, `Store::recent_authors`): the last 30 authors, case-insensitive prefix, myself excluded, 8 at most, in a popover driven by arrows, Enter, Tab and Escape.

`:` completion, custom emoji and the picker are in [emoji](emoji.md). The `@`, `:` and `/` bands are mutually exclusive.

## Editing

Editing is a message action, not a composer mode. Mobile edits in the action sheet's own text field ([message actions](message-actions.md)). GTK edits in place in the message list (`MessageList::start_edit`), and **Up in an empty composer** edits my last message when the server still allows it (else a "too late" toast). SwiftUI opens an edit sheet on Up and edits in place from the menu.

## Formatting (desktop)

GTK has a formatting toolbar (bold, italic, strike, heading, link, inline code, code block, quote, bullets, numbers) over `rv-core/src/compose.rs`, which toggles Rocket.Chat markers around the selection or before its lines. The draft is styled as typed (`compose::spans`), markers are hidden except on the cursor's line (`hidden_markers`), Shift+Enter in a list continues it (`list_break`), and misspelled words get suggestions and "Add to dictionary" on right-click (`rv-gtk/src/spell.rs`). Every desktop send and edit passes through `compose::fenced`, which puts code fences on lines of their own as the server's parser needs. SwiftUI uses AppKit's text view (system spell checker, Emoji & Symbols) without a toolbar. Mobile has no formatting aids: the user types markdown.

## Keys and layout

- GTK: Enter sends, Shift+Enter breaks the line, the field grows to 160 px then scrolls.
- SwiftUI: Return sends, Shift+Return breaks the line, Cmd+Return on the send button; the field grows to 170 px.
- Mobile: a multiline field, the send button (➤) replaces the microphone as soon as there is text or a staged file, never while recording. The 😀 button swaps the keyboard for the emoji panel.

## Attachments in the composer

Mobile: 📎 opens a native sheet (`app/joindre.tsx`) offering photo, video (camera), library (up to 10, ordered) or file. The sheet answers through `ui/sourcePieceJointe.ts` while staying open and the composer closes it after the picker returns, because Android crashes durably when an activity launches while a view is being removed (`ui/lancerSelecteur.ts`). Picked files become chips (`ui/piecesEnAttente.tsx`): a thumbnail, a real player for voice, a Reduced / Original toggle for reducible media (reduction happens at send, not at pick). Android back removes the last chip; a removed chip deletes its cache copy. Leaving the room parks the chips in memory for that room and thread (`piecesParquees`).

Desktop: the file chooser, drag-and-drop on the page and paste (files, or a picture saved as PNG) stage files as chips (`rv-gtk/src/staged.rs`) with a preview and an image quality choice; `Staged::switch` keeps each room's chips while another is open.

## Parity

Both apps: outbox send with retry, drafts per room and thread, `@`/`:` completion, picker, quote reply, attachments with captions and quality, voice, slash commands. Desktop only: the formatting toolbar and live styling (GTK), spell check, Up-to-edit, list continuation. Mobile only: video reduction, replaying a voice message before sending.

## Sources

- apps/mobile/ui/composer.tsx
- apps/mobile/ui/brouillons.ts
- apps/mobile/ui/brouillonDifferre.ts
- apps/mobile/ui/reponse.ts
- apps/mobile/ui/bandeauReponse.tsx
- apps/mobile/lib/citation.ts
- apps/mobile/lib/completionMention.ts
- apps/mobile/ui/completionMention.tsx
- apps/mobile/lib/saisie.ts
- apps/mobile/lib/envoi.ts
- apps/mobile/ui/piecesEnAttente.tsx
- apps/mobile/ui/apercuPieceJointe.tsx
- apps/mobile/ui/sourcePieceJointe.ts
- apps/mobile/ui/lancerSelecteur.ts
- apps/mobile/app/joindre.tsx
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
- brain/parity.md
