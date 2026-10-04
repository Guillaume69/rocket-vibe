# Message actions

What a user can do to one message: react, reply (quote), reply in a thread, copy, share or download its file, edit, delete, pin and star, plus the room's lists of pinned and starred messages. Which actions are offered is decided by one pure function per app that mirrors the server's own checks; the server stays the authority and a wrongly offered action fails with its error. Mobile `lib/messageActions.ts` (`possibleActions`) and desktop `rv-core/src/actions.rs` (`possible_actions`, "ported from the Android app") apply the same rules.

## Which actions are offered

Inputs: the message (author, timestamp, system type, text, attachments, pinned, starred by me), my uid, the room (read-only, encrypted), whether the menu is opened from a thread, the server settings and my granted permissions in the room.

- **Nothing** on a system message (joins, renames, calls). An `e2e` message is not a system message for this purpose: once decrypted (text present) it gets the normal actions; before that it gets none. An earlier version returned nothing for every message of an encrypted room.
- **React**: unless the room is read-only.
- **Reply** (quote): unless read-only or **encrypted**, because the server builds the quote card from the text, which it cannot read there; one answers in a thread instead.
- **Reply in thread**: unless read-only or already in a thread.
- **Copy**: when there is text once the leading quote links are stripped (`textToCopy` / `copyable_text`).
- **Share** (mobile, text or file) and **Save / Download** (a file attachment, `title_link` first since `image_url` is only the thumbnail).
- **Edit**: (`edit-message` permission, or my message and `Message_AllowEditing`) and within `Message_AllowEditing_BlockEditInMinutes` (0 = no limit). The time limit comes from **settings**, not permissions.
- **Delete**: `force-delete-message`, or `Message_AllowDeleting` and (`delete-message`, or my message and `delete-own-message`) within `Message_AllowDeleting_BlockDeleteInMinutes`.
- `bypass-time-limit-edit-and-delete` lifts both time limits.
- **Pin / Unpin**: `Message_AllowPinning` and `pin-message`. **Star / Unstar**: `Message_AllowStarring`.

Settings are read from `settings.public` with `count=0` (the `query` parameter is dead since 7.0). Mobile caches them per server base URL (`rulesByServer` in `app/message-actions.tsx`, so a server switch never applies the old server's rules) and never caches a failure: offline it falls back to permissive rules for that opening. Desktop reads them once per session (`Session::settings`). Permissions come from `permissions.listAll` plus my global and room roles, read once per session; **when unknown**, only what a member may do on their own messages plus Pin is offered (`delete-own-message` and `pin-message` default to granted, the others to denied).

## The calls

| Action | Endpoint | Notes |
|---|---|---|
| React | `chat.react` `{messageId, emoji: ":code:", shouldReact}` | The server wants the shortcode, refuses raw Unicode ("Invalid emoji provided"). `shouldReact` makes it a set, not a toggle. |
| Edit | `chat.update` `{roomId, msgId, text}` | In an encrypted message: `content` plus `e2eMentions`, never `text`, which the server refuses on an `e2e` message. |
| Delete | `chat.delete` `{roomId, msgId}` | |
| Pin / Unpin | `chat.pinMessage` / `chat.unPinMessage` `{messageId}` | |
| Star / Unstar | `chat.starMessage` / `chat.unStarMessage` `{messageId}` | |
| Pinned / starred lists | `chat.getPinnedMessages` / `chat.getStarredMessages` `{roomId, count: 50}` | Newest first. |

Mobile wraps them in `ActionsRC` (`providers/rocketchat/actions.ts`, behind the `ProviderActions` interface so screens never name endpoints); desktop in free functions of `rv-core/src/actions.rs` called by `Session`.

**Footgun: `chat.pinMessage` does not broadcast the pinned message** on `stream-room-messages` (only the `message_pinned` system message arrives; unpin does broadcast). So the local state must be set by hand after success: mobile writes it (`updateMessageMarks`, `starredAfter` in `lib/marks.ts`); desktop refetches the message with `chat.getMessage` and ingests it (`Session::refresh_message`). Stars are stored as the list of uids (`starred: [{_id}]`), "starred by me" decided at read time; reactions are keyed by shortcode with usernames, "mine" decided by username, since the server stores only usernames (`lib/reactions.ts`, `actions::reactions`).

## Mobile

- A long press on a message row (with a haptic "pop") opens `app/message-actions.tsx`, a native bottom sheet (`presentation: 'formSheet'` from react-native-screens, fitted to content, capped at 80 % of the screen; bottom-sheet libraries are banned). It reads the message from SQLite by id; a message deleted in between shows "not found".
- The six quick reactions (👍 ❤️ 😂 🎉 😮 🙏, sent as `+1`, `heart`, `joy`, `tada`, `open_mouth`, `pray`) show mine outlined; tapping one of mine removes it. Reaction pills under a message also toggle on tap (`ui/messageRow.tsx`), fire-and-forget: the stream echo rewrites `messages.reactions`.
- **Edit** swaps the list for a text field with Cancel / Save in the same sheet. The result arrives through the stream.
- **Delete** has no confirmation dialog. If `chat.delete` fails, `messageGoneFromServer` asks `chat.getMessage`: a 400 means the server no longer knows the message (deleted from another client while the app was closed), so purging the local row is the requested deletion. Any other outcome keeps the original error. Otherwise the row disappears through the `deleteMessage` stream.
- **Copy** uses `expo-clipboard`. **Share** sends the text through the system share sheet, or downloads the file and shares the local copy; **Save** stores it in the gallery or Downloads. Both run in the background with progress on the message row ([uploads](uploads.md#downloads)).
- **Reply** arms the quote target for the composer the sheet came from ([composer](composer.md#replies-quotes)); **Reply in thread** opens `/thread/<tmid or id>`.
- A ref guards against double taps: two `router.back()` would pop the room too.
- Rows still in the outbox have no actions; their only actions are retry and discard.
- **Pinned and starred lists**: `app/marked-messages.tsx`, two tabs, each loaded on first open (one request per tab per visit, the route being limited). The lists are ephemeral, rendered from the response and never written to the database. Tapping a message closes the screen and jumps to it in the room (`ui/messageJump.ts`, `ui/bringMessage.ts`, paging history back up to 4 pages from the oldest local message, never an isolated page that would leave a hidden gap); a thread reply opens its thread.

## Desktop (GTK)

- Right-click on a message, or its "more" button, opens a popover (`rv-gtk/src/actions_menu.rs`). A right-click on selected text or a link shows the text menu instead.
- Quick reactions on top, then the allowed actions. **Delete asks for confirmation** (`adw::AlertDialog`) and removes the local row at once on success. **Edit** is in place in the message list (Escape cancels, saving an unchanged or empty text does nothing); the returned document is ingested. **Up** in an empty composer edits my last message if still allowed ("too late" toast otherwise). Pin, star and failures confirm with a toast.
- **Download** saves into the Downloads folder under a free name.
- **Pinned and starred**: a dialog with a tab each (`rv-gtk/src/marked.rs`); the lists are ingested into the store (`Session::marked`). A click jumps to the message, paging older history up to 30 times, else a "not loaded" toast.

## Desktop (SwiftUI)

The same actions come from `rv-ffi` (`Chat::actions`, cached per message per list version in `RoomModel.actionsOf`). Reply puts the quote link in the draft, edit is in place (Up opens an edit sheet), delete asks through a `confirmationDialog`, download goes to Downloads. `MarkedView` in `Details.swift` shows the two lists.

## Parity

Same rule set in both apps. Desktop adds delete confirmation and Up-to-edit; mobile adds the ghost-delete purge and Share. Neither offers the full emoji picker for reactions from the menu, only the six quick ones.

## Sources

- apps/mobile/lib/messageActions.ts
- apps/mobile/app/message-actions.tsx
- apps/mobile/app/marked-messages.tsx
- apps/mobile/providers/rocketchat/actions.ts
- apps/mobile/lib/provider.ts
- apps/mobile/lib/marks.ts
- apps/mobile/lib/reactions.ts
- apps/mobile/lib/permissions.ts
- apps/mobile/ui/messageRow.tsx
- apps/mobile/ui/attachmentActions.ts
- apps/mobile/ui/messageJump.ts
- apps/mobile/ui/bringMessage.ts
- apps/desktop/crates/rv-core/src/actions.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-gtk/src/actions_menu.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/marked.rs
- apps/desktop/crates/rv-ffi/src/lib.rs
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/desktop/macos/Sources/RocketVibe/Details.swift
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
