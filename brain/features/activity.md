# Activity

One view of what concerns me across rooms: messages that mention me, replies in threads I take part in, and my messages others reacted to, newest first; above them, the rooms where the server counts unread mentions the device holds no message for. It is read **only from the messages already stored on the device**, no server call (user decisions 2026-10-13: these three kinds, the counter rows, desktop gathering every account). The desktop merges every signed-in account; mobile shows the open server's account; the web its one account.

## The rule (every app)

- **Candidates**: the newest stored messages that can be activity (about 2000): others' messages with an `@` in their words, a thread root id, or (desktop) encrypted and stored without words, which the session opens; and mine that carry reactions. A message with an attachment alone counts (it can be a reply or carry reactions, not a mention). Excluded: system messages, deleted ones, a locked encrypted message (a decrypted one counts), messages of rooms I no longer list (desktop and web by the room list, mobile in `ACTIVITY_CANDIDATES` with the room list's rule: stored and not `open = 0`), and WhatsApp accounts entirely (no mentions, no threads, reactors are phone ids).
- **Mention**: someone else's message (room message or thread reply) whose parsed markdown has a `MENTION_USER` node naming my username, `all` or `here`; without a tree (Mattermost, kChat) a word `@<me>`, `@all` or `@here` in the text, split on whitespace and `,;:!?`, exact and case-sensitive. A word `@all` or `@here` in the text counts even with a tree, because the RocketVibe trees (`rv-core/src/native/markdown.rs`, mobile `providers/rocketvibe/markdown.ts`) render `@here` as plain text. Desktop: `rv_core::notify::mentions` (the rule live notifications use) and `notify::names_in_text`. Web also trusts the server's `personal_mention`.
- **Reply**: someone else's thread reply, not a mention, in a thread I take part in: I wrote the root, or a reply in it, or I follow it (Rocket.Chat's `replies`, stored as `thread_followers`; web: the root's `personal_follow`). Mattermost, kChat and RocketVibe store no follow state on the desktop and mobile (the thread-following debt of `parity.md` section 6), so authorship decides there.
- **Reaction**: my message with at least one reactor other than me; the entry names the other reactors (once each, in order) and their emojis. No reaction is timed (Rocket.Chat, Mattermost and RocketVibe keep only who reacted), so the entry sits at the message's own time.
- One entry per message, Mention before Reply before Reaction; newest first, 100 at most (the merged desktop view too).
- **Unread mentions**: a row per room whose mention counter (the room list's `@n` source: Rocket.Chat `userMentions`, plus `groupMentions` on desktop, Mattermost `mention_count`, RocketVibe `read_state.mentions`) is greater than the number of Mention entries listed for it, newest activity first: an old, already-read mention listed there must not hide new unread ones. A mobile Rocket.Chat account holds messages only for rooms it opened (`offline-and-sync.md`), so these rows are what keeps a mention in another room from going unseen.
- **Open**: an entry opens its room at the message, a thread reply its thread at the message (the local search's navigation); a room row opens the room. On desktop an entry of another account opens that account first (the background notification's path).
- Read when the view opens; no live refresh while it is shown. It closes like any modal. FR / EN strings: the `activity.*` keys (`rv-core/src/i18n.rs`, mobile `ui/messages.ts`).

## Desktop

`rv_core::activity` holds the rule: `gather(rows, me, my_threads, rooms)` returns an `Activity` (`rooms: Vec<RoomMentions>`, `items: Vec<Item>` with `kind`, room name, the `MessageRow`, reactors and emoji shortcodes), and `merge` makes one `Merged<K>` of several accounts' activities, each part tagged with its account, `several` when more than one has something. Candidates: `Store::activity_candidates` and `Store::my_threads` (the roots I wrote, replied in, or follow through the comma-separated `thread_followers`), `NativeStore::activity_candidates` / `my_threads` (`native/store/activity.rs`, rows presented with `MessageRow::presentation`, whose tree carries the mentions). `Session::activity`, `NativeSession::activity` and `Chat::activity` (None for WhatsApp) give an account's share; `Supervisor::activity` merges every running account, store reads to run off the interface's thread. Tests: `activity.rs` (classification, precedence, rows, the limit, the merge) and `store::tests::activity_reads_mentions_thread_replies_and_reactions_from_the_store` (the SQL on a real store).

- **GTK**: a bell button in the room list header (`chat.rs`, next to the local search) raises `ChatPage::connect_activity`, and Ctrl+Shift+A is caught by the window's capture-phase key handler (`AppWindow::new`), before a text field takes it for "unselect all"; the window (`AppWindow::open_activity`) reads `Supervisor::activity` on the runtime and opens `rv-gtk/src/activity_view.rs`, an `adw::Dialog` with "Unread mentions" then "Recent", each entry with its server when several accounts show. `open_activity_entry` opens the open account's room through `ChatPage::open_search_hit` / `open_room`, another account through the pending room link (`RoomLink` with `message` and `root`) and `switch_to_for_link`.
- **SwiftUI**: rv-ffi `Client.activity()` (`rv-ffi/src/activity.rs`: `ActivityView` with `ActivityRoom` and `ActivityItem`, emojis as glyphs, `several`), `AppModel.activity()` and `openActivity(account:rid:message:thread:)` (switching account first, then the message, its thread or the room); `ActivitySheet` (`macos/Sources/RocketVibe/Activity.swift`) from a bell in the room list header, Cmd+Shift+A.

## Mobile

`lib/activityFeed.ts` (Node-pure, tested in `lib/activityFeed.test.ts`) classifies; `db/upserts.ts` reads the candidates, the thread roots and the threads I replied in, and the rooms with a mention counter (`ACTIVITY_*`, tested against SQLite in `db/upserts.test.ts`), through `LocalSearch.activity` (`db/store.ts`) and `readActivity` (`ui/localSearch.ts`), on the open session's database. `app/activity.tsx` shows the two sections (a room row with its `@n` badge), re-read at each focus; reactors are shown under their display names; a message with an attachment alone shows "Attachment" (`common.attachment`); a tap opens like a local search result (`requestJump`, or `/thread/[id]` with the message). The entry is a bell in the home header (`app/index.tsx`), hidden on a WhatsApp account. The candidates query scans the messages table without an index of its own, at each focus: fine at the 500 kept per room, to watch on a very large device store.

## Web

`src/activity-feed.ts` (`collectActivity`, `mentionsMe`; tests `tests/activity-feed.test.ts`) reads `app.model`, skipping encrypted rooms (their words are not in the model); `personal_mention` or a mention node marks a Mention, the root's `personal_follow` a followed thread. The panel `activityFeed` (`src/panels.ts`, lazily loaded by `panel-actions.ts`) opens from a bell before the sidebar's "+" (`ui/application.tsx`) or Ctrl+Shift+A (`app.ts`, ignored while a dialog is open or on a held key; browsers that keep that key for themselves may take it first), both through `App.openActivity`, whose in-flight flag keeps a double press on a cold load from opening two panels; an entry calls `app.jumpTo`. The strings come from the desktop catalog through `scripts/sync-strings.mjs` (the `activity.` prefix). Browser check: `tests/activity-feed.mjs` (`npm run test:activity-feed`, three users, not in CI yet).

## Sources

- apps/desktop/crates/rv-core/src/activity.rs
- apps/desktop/crates/rv-core/src/store.rs
- apps/desktop/crates/rv-core/src/native/store/activity.rs
- apps/desktop/crates/rv-core/src/native.rs
- apps/desktop/crates/rv-core/src/provider.rs
- apps/desktop/crates/rv-core/src/supervisor.rs
- apps/desktop/crates/rv-core/src/notify.rs
- apps/desktop/crates/rv-gtk/src/activity_view.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-ffi/src/activity.rs
- apps/desktop/macos/Sources/RocketVibe/Activity.swift
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
- apps/mobile/lib/activityFeed.ts
- apps/mobile/app/activity.tsx
- apps/mobile/db/upserts.ts
- apps/mobile/db/store.ts
- apps/mobile/ui/localSearch.ts
- apps/web/src/activity-feed.ts
- apps/web/src/panels.ts
- apps/web/scripts/sync-strings.mjs
