# Message actions

What a user can do to one message: react (with my most used emoji or any other), reply (quote), reply in a thread, copy, share or download its file, edit, delete, pin and star, report it to the administrators, plus the room's lists of pinned and starred messages. Which actions are offered is decided by one pure function per app that mirrors the server's own checks; the server stays the authority and a wrongly offered action fails with its error. Mobile `lib/messageActions.ts` (`possibleActions`) and desktop `rv-core/src/actions.rs` (`possible_actions`, "ported from the Android app") apply the same rules.

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
- **Report**: decided beside `possibleActions` / `possible_actions`, by the menus: someone else's message that is not a system message, on Rocket.Chat always; on RocketVibe when the server advertises `reports`, never in a private (E2EE) conversation, never on a deleted message. See [administration.md](administration.md).

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
| Report | `chat.reportMessage` `{messageId, description}` | Reason required, 1 to 1,000 characters. RocketVibe: `POST /api/v1/messages/{message}/report` ([administration.md](administration.md)). |

Mobile wraps them in `ActionsRC` (`providers/rocketchat/actions.ts`, behind the `ProviderActions` interface so screens never name endpoints); desktop in free functions of `rv-core/src/actions.rs` called by `Session`.

**Footgun: `chat.pinMessage` does not broadcast the pinned message** on `stream-room-messages` (only the `message_pinned` system message arrives; unpin does broadcast). So the local state must be set by hand after success: mobile writes it (`updateMessageMarks`, `starredAfter` in `lib/marks.ts`); desktop refetches the message with `chat.getMessage` and ingests it (`Session::refresh_message`). Stars are stored as the list of uids (`starred: [{_id}]`), "starred by me" decided at read time; reactions are keyed by shortcode with usernames, "mine" decided by username, since the server stores only usernames (`lib/reactions.ts`, `actions::reactions`).

## Mobile

- A long press on a message row (with a haptic "pop") opens `app/message-actions.tsx`, a native bottom sheet (`presentation: 'formSheet'` from react-native-screens, fitted to content, capped at 80 % of the screen; bottom-sheet libraries are banned). It reads the message from SQLite by id; a message deleted in between shows "not found".
- **Quick reactions**: the 5 emoji I react with most on this account (`topEmojis`, [emoji.md](emoji.md#quick-reactions-and-reacting-with-any-emoji)), custom ones drawn as images, then **"+"**, which swaps the actions for `EmojiGrid` (search, categories, the server's tab except in a private conversation) at a fixed 60 % of the screen; a pick reacts and closes the sheet (an emoji already mine just closes it). Mine show outlined, matched by emoji (`emojiIdentity`, so an alias counts); tapping one of mine removes it under the code the message carries. A use is counted at the tap. On Rocket.Chat the quick row and the grid keep only the emoji the server accepts, and an addition goes out under an accepted alias (`lib/rocketchatReactions.ts`, [emoji.md](emoji.md#quick-reactions-and-reacting-with-any-emoji)). Reaction pills under a message also toggle on tap (`ui/messageRow.tsx`), fire-and-forget, joining one counting a use: the stream echo rewrites `messages.reactions`.
- **Edit** swaps the list for a text field with Cancel / Save in the same sheet. The result arrives through the stream.
- **Report** swaps the list for `ui/reportForm.tsx` (reason, Cancel / Report) the same way; sent through `provider.reports`, it toasts "Report sent" and closes the sheet.
- **Delete asks for confirmation** in a native `Alert` over the sheet ("Delete this message?", Cancel / Delete), private messages of an encrypted RocketVibe room included. If `chat.delete` fails, `messageGoneFromServer` asks `chat.getMessage`: a 400 means the server no longer knows the message (deleted from another client while the app was closed), so purging the local row is the requested deletion. Any other outcome keeps the original error. Otherwise the row disappears through the `deleteMessage` stream.
- **Copy** uses `expo-clipboard`. **Share** sends the text through the system share sheet, or downloads the file and shares the local copy; **Save** stores it in the gallery or Downloads. Both run in the background with progress on the message row ([uploads](uploads.md#downloads)).
- **Reply** arms the quote target for the composer the sheet came from ([composer](composer.md#replies-quotes)); **Reply in thread** opens `/thread/<tmid or id>`.
- A ref guards against double taps: two `router.back()` would pop the room too. For the same reason an action that finishes after the sheet was closed (a tap outside, Back) does not go back again (`sheetOpen`, `close`).
- Every `Alert` of the sheet is dismissible: a tap outside or Back is Cancel, never the confirming button (`ui/alerts.ts#dismissible`).
- Rows still in the outbox have no actions; their only actions are retry and discard.
- **Pinned and starred lists**: `app/marked-messages.tsx`, two tabs, each loaded on first open (one request per tab per visit, the route being limited). The lists are ephemeral, rendered from the response and never written to the database. Tapping a message closes the screen and jumps to it in the room (`ui/messageJump.ts`; an old one opens in a context window, see [room-view.md](room-view.md)); a thread reply opens its thread.

## Desktop (GTK)

- Right-click on a message, or its "more" button, opens a popover (`rv-gtk/src/actions_menu.rs`). A right-click on selected text or a link shows the text menu instead.
- Quick reactions on top (`rv-gtk/src/reactions.rs::row`: my 5 most used, then "+" opening `emoji_picker::popover`, which pops down after a pick; native rooms in `rv-gtk/src/chat_native.rs`, private conversations without the server's tab; on Rocket.Chat only the emoji the server accepts, through `rv_core::emoji::rc_reaction`), then the allowed actions, then **Report** (someone else's message, not a system line, not in the outbox; an `adw::AlertDialog` asking the reason, `admin::report`). **Delete asks for confirmation** (`adw::AlertDialog`, presented through `widgets::present` like every dialog, so a click outside is Cancel) and removes the local row at once on success. **Edit** is in place in the message list (Escape cancels, saving an unchanged or empty text does nothing); the returned document is ingested. **Up** in an empty composer edits my last message if still allowed ("too late" toast otherwise). Pin, star and failures confirm with a toast.
- **Download** saves into the Downloads folder under a free name.
- **Pinned and starred**: a dialog with a tab each (`rv-gtk/src/marked.rs`); the lists are ingested into the store (`Session::marked`). A click jumps to the message; one older than the loaded history opens in the history around it (`Chat::jump_to`, see [room-view.md](room-view.md)). The toast remains for a message the server cannot give back.

## Desktop (SwiftUI)

The same actions come from `rv-ffi` (`Chat::actions`, cached per message per list version in `RoomModel.actionsOf`). The context menu's emoji submenu lists the quick reactions as toggles, mine ticked (`RoomModel.quickReactions` from `Chat::quick_reactions` or the native `quick_reactions(custom:)`; `quickReact` withdraws mine under the code the server keyed), and "React with another emoji…" opens `EmojiPicker` in a popover on the row, a context menu being unable to host one (`reactWithPick`, through rv-ffi's `reaction_emoji`; on Rocket.Chat the picker keeps only `rocket_chat_reacts_with` emoji and the quick row is filtered the same way). **Report** (someone else's delivered message, not a system line, never a private conversation: `RoomModel.canReport`) opens `ReportSheet` in a modal overlay of the window. Reply puts the quote link in the draft, edit is in place (Up opens an edit card in a modal overlay, `Composer.swift`), delete asks through `confirmOverlay` (a click outside or Escape is Cancel), download goes to Downloads. `MarkedView` in `Details.swift` shows the two lists.

## Parity

Same rule set in all three apps, delete confirmation included. Desktop adds Up-to-edit; mobile adds the ghost-delete purge and Share. Quick reactions (my top 5) and reacting with any emoji through the picker are in all three. Reporting a message is in all three ([parity](../parity.md) §5).

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
- apps/mobile/ui/reportForm.tsx
- apps/mobile/ui/emojiPicker.tsx
- apps/mobile/lib/emojiUsage.ts
- apps/mobile/providers/rocketchat/admin.ts
- apps/mobile/ui/attachmentActions.ts
- apps/mobile/ui/messageJump.ts
- apps/mobile/lib/contextWindow.ts
- apps/desktop/crates/rv-core/src/actions.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-gtk/src/actions_menu.rs
- apps/desktop/crates/rv-gtk/src/reactions.rs
- apps/desktop/crates/rv-gtk/src/chat_native.rs
- apps/desktop/crates/rv-gtk/src/admin.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/marked.rs
- apps/desktop/crates/rv-ffi/src/lib.rs
- apps/desktop/crates/rv-ffi/src/reactions.rs
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/desktop/macos/Sources/RocketVibe/Details.swift
- apps/desktop/macos/Sources/RocketVibe/AdminView.swift
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
- apps/mobile/ui/alerts.ts
- apps/mobile/lib/rocketchatReactions.ts
- apps/desktop/macos/Sources/RocketVibe/Composer.swift
- apps/desktop/macos/Sources/RocketVibe/Modals.swift
- apps/desktop/crates/rv-gtk/src/widgets.rs
