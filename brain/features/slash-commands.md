# Slash commands

A `/` at the start of a message offers the server's slash commands the user may run in the room, with their parameters and description; sending runs the command through `commands.run`, inside the thread when typed there. The server's answer (an unknown channel, `/help`) shows above the composer, seen only by the user. Both apps share one design: mobile `lib/commands.ts` states it follows `rv-core/src/commands.rs`, and the two are line-for-line ports.

## The server contract

- `GET commands.list?count=0` lists every command: `command` (name), `params` and `description` (i18n **keys** such as `Slash_Shrug_Description`, not text), `permission` (a string or an array; any one suffices, none means anyone), plus fields like `clientOnly` that neither app uses.
- `POST commands.run` with `{command, roomId, params, triggerId}` and `tmid` in a thread. `triggerId` is a random client token.
- `commands.run` answers `{success: true}` **even when the command fails**. The real answer (an error, `/help` output) arrives as a private message on `stream-notify-user` / `<uid>/message`, with args `[{rid, msg, private: true, ...}]`, never in the REST response (probed on 8.5). Both apps subscribe to that key at session start (mobile `initialSubscriptions` in `providers/rocketchat/index.ts`, desktop `Session` construction in `rv-core/src/session.rs`).

## On a RocketVibe server

The native server (`apps/server/src/commands.rs`) offers Rocket.Chat's core commands under their names and i18n keys, so both apps read its list with the same code. It announces them with the `slash_commands` capability.

- `GET /api/v1/commands` returns `CommandList { commands: [{command, params, description, client_side}] }`, the catalogue in `crates/rv-protocol/src/commands.rs` (`catalogue`). No permissions are listed: the server checks rights when a command runs, so the completion leaves nothing out.
- `POST /api/v1/commands/run` with `RunCommand {room_id, command, params}` answers 204, or an ordinary API error. Each command is an operation the API already has, under the same checks:
  - `/topic` changes the room settings;
  - `/invite @a @b` (20 at most) and `/kick @a` change the membership, owner only;
  - `/leave` leaves the room;
  - `/join #name` joins the public room of that exact name, case aside;
  - `/msg @a text` opens the direct conversation and sends the text, refused with `crypto_required` when it is encrypted;
  - `/status text` sets the profile's status text.
- Errors: `unknown_command` (404), `client_side_command` (400) for a text command, `invalid_request` for missing parameters, then the operation's own codes (`not_found`, `permission_denied`...). Both apps word them (rv-core `commands::error_key`, mobile `commandErrorKey`) inside "Command refused: ...". There is no private answer on this server: a refusal is the only reply.

**Text commands are written by the client, on both servers.** `/me`, `/gimme`, `/lennyface`, `/shrug`, `/tableflip` and `/unflip` only decorate a message, so the app writes the text Rocket.Chat's own command writes (`rv_protocol::commands::decorate`, ported as mobile `textCommand`) and sends it through the room's normal path. That is what makes them work in an encrypted room, which the server cannot write into. `/me` alone sends nothing. A Rocket.Chat server still has to list the name, so on a server without the command it stays text.

## Words for i18n keys

The web client turns the keys into text with its own catalogue. Both apps carry a small table (`WORDS` in both) of French and English wordings for the core commands (archive, invite, kick, leave, me, msg, mute, status, topic, gimme, lennyface, shrug, tableflip, unflip...). A Rocket.Chat app namespaces its keys (`app-<id>.GIPHY_Search_Term`): the prefix is dropped. A key the table does not know but that looks like one (no whitespace, an underscore, an uppercase letter) is shown with underscores turned into spaces, so an app's command (`Poll_App_Create_Poll`) at least reads as words. Anything else is shown as sent.

## Completion

- The command token is the text before the cursor when it starts with `/` and has no whitespace or second `/` yet (`detectCommandToken` / `commands::query`). `/usr/bin` or `hi /sh` offer nothing.
- Candidates are commands whose name starts with the typed prefix (case-insensitive), sorted by name, **all of them**: `/` alone lists every command, and each letter typed narrows the list.
- **Permissions filter the list** when known: a command with permissions is shown only if one of them is granted. Granted permissions are computed as the server checks them: a permission is held when one of its roles (`permissions.listAll`, about 270 KB, read once per session with `me`) is one of mine, global (`me.roles`) or in the room (the subscription's `roles`, stored locally). While they are unknown (offline, refused) nothing is hidden and the server decides. Mobile: `lib/permissions.ts`; desktop: `actions::granted` behind `Session::permissions`.
- The list itself is read once per session and account; a failed read is not remembered, so the next use retries (mobile `rawList` cache, desktop `OnceCell::get_or_try_init` in `Session::commands`).
- The list is a panel titled "COMMANDS" with the keys to use, scrolling past a few rows, the first or selected row marked by a pink bar.
  - Mobile (`ui/commandCompletion.tsx`, `useCommands`) puts `/name  params` over the description in a card above the composer; a tap completes.
  - GTK (`command_choice` and `update_completion` in `rv-gtk/src/composer.rs`) spreads it over the field's width, name and parameters left, description right; arrows walk it (the row is kept in sight), Tab or Enter completes, Escape closes.
  - SwiftUI (`SuggestionList.commands` in `Composer.swift`) does the same through rv-ffi's `suggestions` (`command_suggestions` in `rv-ffi/src/writing.rs`; `NativeChat::suggestions` for a RocketVibe account).

## Sending

1. The draft is split into name and params (`splitCommand` / `commands::split`): leading whitespace is ignored, the name runs to the first whitespace, the rest is trimmed.
2. The name is checked against the server's list. **An unknown name is an ordinary message**, so typing `/shrug` on a server without it, or a path like `/home`, posts the text. If the list cannot be read, the text is sent as a message too.
3. A known command is posted to `commands.run`, with `tmid` when the composer belongs to a thread.
4. If the server refuses the call, the text goes back into the composer **only if the field is still empty** (the user may have typed since), and a toast shows the error.

On a RocketVibe server the composer knows the list already (loaded when the room binds): a text command is rewritten and sent like the draft, encrypted or not; another goes to `NativeSession::run_command` (GTK `Chat::native_command`, SwiftUI `NativeChat.runCommand`, mobile `NativeChat.runSlashCommand`), and a refusal puts the text back if the field is still empty.

Mobile only treats a draft as a command when no quote reply is armed (`ui/composer.tsx`); on desktop the quote link put in front of the text makes it no longer start with `/`, which has the same effect.

## The private answer

The private message is shown above the composer of the page it concerns, rendered as markdown, under a "only you" title, until closed. A newer note replaces the previous one. It is volatile: memory only, no database row.

- Mobile: `ui/sync.tsx` routes each DDP event through `provider.privateNote`, then `setPrivateNote`; `ui/privateNotes.tsx` keeps one note per room in a module store read with `useSyncExternalStore`.
- Desktop: `Session::apply_live` emits `SessionEvent::Private { rid, text }`; GTK's `Chat::on_private` shows it in the open thread's composer if the thread belongs to that room, else in the room's composer if it is open (`Composer::show_private`). Binding a composer to another room hides the note. SwiftUI keeps it in `RoomModel.note` and shows `PrivateNote`.

## Parity

Present in both apps (mobile 0.5.0, desktop 0.6.0 for GTK and SwiftUI), same rules and wording tables. The private answers above the composer exist in both. The RocketVibe server's commands and the full command panel reached the three apps together; the SwiftUI side is checked by the Linux build of RocketVibeKit and the macOS CI only.

## Sources

- crates/rv-protocol/src/commands.rs
- apps/server/src/commands.rs
- apps/server/tests/commands.rs
- apps/mobile/providers/rocketvibe/chat.ts
- apps/mobile/providers/rocketvibe/transport.ts
- apps/desktop/crates/rv-core/src/native.rs
- apps/desktop/crates/rv-gtk/src/chat_native.rs
- apps/desktop/crates/rv-ffi/src/native.rs
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
