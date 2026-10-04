# Slash commands

A `/` at the start of a message offers the server's slash commands the user may run in the room, with their parameters and description; sending runs the command through `commands.run`, inside the thread when typed there. The server's answer (an unknown channel, `/help`) shows above the composer, seen only by the user. Both apps share one design: mobile `lib/commands.ts` states it follows `rv-core/src/commands.rs`, and the two are line-for-line ports.

## The server contract

- `GET commands.list?count=0` lists every command: `command` (name), `params` and `description` (i18n **keys** such as `Slash_Shrug_Description`, not text), `permission` (a string or an array; any one suffices, none means anyone), plus fields like `clientOnly` that neither app uses.
- `POST commands.run` with `{command, roomId, params, triggerId}` and `tmid` in a thread. `triggerId` is a random client token.
- `commands.run` answers `{success: true}` **even when the command fails**. The real answer (an error, `/help` output) arrives as a private message on `stream-notify-user` / `<uid>/message`, with args `[{rid, msg, private: true, ...}]`, never in the REST response (probed on 8.5). Both apps subscribe to that key at session start (mobile `initialSubscriptions` in `providers/rocketchat/index.ts`, desktop `Session` construction in `rv-core/src/session.rs`).

## Words for i18n keys

The web client turns the keys into text with its own catalogue. Both apps carry a small table (`WORDS` in both) of French and English wordings for the core commands (archive, invite, kick, leave, me, msg, mute, status, topic, gimme, lennyface, shrug, tableflip, unflip...). A key the table does not know but that looks like one (no whitespace, an underscore, an uppercase letter) is shown with underscores turned into spaces, so an app's command (`Poll_App_Create_Poll`) at least reads as words. Anything else is shown as sent.

## Completion

- The command token is the text before the cursor when it starts with `/` and has no whitespace or second `/` yet (`detectCommandToken` / `commands::query`). `/usr/bin` or `hi /sh` offer nothing.
- Candidates are commands whose name starts with the typed prefix (case-insensitive), sorted by name, 8 at most.
- **Permissions filter the list** when known: a command with permissions is shown only if one of them is granted. Granted permissions are computed as the server checks them: a permission is held when one of its roles (`permissions.listAll`, about 270 KB, read once per session with `me`) is one of mine, global (`me.roles`) or in the room (the subscription's `roles`, stored locally). While they are unknown (offline, refused) nothing is hidden and the server decides. Mobile: `lib/permissions.ts`; desktop: `actions::granted` behind `Session::permissions`.
- The list itself is read once per session and account; a failed read is not remembered, so the next use retries (mobile `rawList` cache, desktop `OnceCell::get_or_try_init` in `Session::commands`).
- Mobile shows a vertical band (`ui/commandCompletion.tsx`, `useCommands`) with `/name  params` over the description. GTK shows the same in the completion popover (`command_choice` in `rv-gtk/src/composer.rs`); SwiftUI gets it through `rv-ffi`'s `suggestions` (`rv-ffi/src/writing.rs`).

## Sending

1. The draft is split into name and params (`splitCommand` / `commands::split`): leading whitespace is ignored, the name runs to the first whitespace, the rest is trimmed.
2. The name is checked against the server's list. **An unknown name is an ordinary message**, so typing `/shrug` on a server without it, or a path like `/home`, posts the text. If the list cannot be read, the text is sent as a message too.
3. A known command is posted to `commands.run`, with `tmid` when the composer belongs to a thread.
4. If the server refuses the call, the text goes back into the composer **only if the field is still empty** (the user may have typed since), and a toast shows the error.

Mobile only treats a draft as a command when no quote reply is armed (`ui/composer.tsx`); on desktop the quote link put in front of the text makes it no longer start with `/`, which has the same effect.

## The private answer

The private message is shown above the composer of the page it concerns, rendered as markdown, under a "only you" title, until closed. A newer note replaces the previous one. It is volatile: memory only, no database row.

- Mobile: `ui/sync.tsx` routes each DDP event through `provider.privateNote`, then `setPrivateNote`; `ui/privateNotes.tsx` keeps one note per room in a module store read with `useSyncExternalStore`.
- Desktop: `Session::apply_live` emits `SessionEvent::Private { rid, text }`; GTK's `Chat::on_private` shows it in the open thread's composer if the thread belongs to that room, else in the room's composer if it is open (`Composer::show_private`). Binding a composer to another room hides the note. SwiftUI keeps it in `RoomModel.note` and shows `PrivateNote`.

## Parity

Present in both apps (mobile 0.5.0, desktop 0.6.0 for GTK and SwiftUI), same rules and wording tables. The private answers above the composer exist in both.

## Sources

- apps/mobile/lib/commands.ts
- apps/mobile/ui/commandCompletion.tsx
- apps/mobile/ui/privateNotes.tsx
- apps/mobile/ui/composer.tsx
- apps/mobile/ui/sync.tsx
- apps/mobile/lib/permissions.ts
- apps/mobile/providers/rocketchat/index.ts
- apps/mobile/CHANGELOG.md
- apps/desktop/crates/rv-core/src/commands.rs
- apps/desktop/crates/rv-core/src/live.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/actions.rs
- apps/desktop/crates/rv-gtk/src/composer.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-ffi/src/writing.rs
- apps/desktop/macos/Sources/RocketVibe/Composer.swift
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
- apps/desktop/CHANGELOG.md
