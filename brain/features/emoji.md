# Emoji

How `:shortcode:` emoji become glyphs, how the server's custom emoji become images, and how the composer offers emoji through `:` completion and a picker. Rocket.Chat sends only shortcode names, so both apps carry their own shortcode table, generated from the same source.

## The server contract

- **Shortcodes are not resolved.** 8.5 pre-parses `:smile:` into `{type: 'EMOJI', shortCode: 'smile'}` with no `unicode` field (a `unicode` field appears only when the author typed the glyph itself). The client must know that `smile` is 😄; without a table the screen shows `:smile:`.
- **Nothing is validated.** The parser accepts `:anything:`; an isolated `:not_an_emoji:` comes out as a `BIG_EMOJI` block like a real one. The table is therefore also the judge of what is an emoji: an unknown code renders as its literal `:name:` and is never enlarged.
- **Custom emoji.** `GET /api/v1/emoji-custom.list` gives `name`, `extension` and `aliases`. It accepts only `updatedSince`; a `count` parameter is refused ("must NOT have additional properties"). The image is at `/emoji-custom/<name>.<ext>` and must use the **canonical name**: `/emoji-custom/<alias>.<ext>` returns a fallback SVG, not the image. On 8.5 that route is public (`FileUpload_ProtectFiles` does not cover it).
- **Mattermost and kChat**: `GET /api/v4/emoji` (paged, no aliases), images at `/api/v4/emoji/<id>/image` behind the bearer; see `docs/MATTERMOST.md` §6.4 and [mattermost-and-kchat](mattermost-and-kchat.md).
- **Resolution order**, both apps: Unicode glyph first, then custom image, then literal `:name:`. A shortcode that is both standard and custom renders the glyph.
- **Index rule.** Names are indexed before aliases, so an alias can never hide another emoji's own name whatever the server's order; between two valid entries the first wins.

- **Managing them**: an administrator adds and deletes custom emoji from the administration of every app, on Rocket.Chat (`emoji-custom.create`/`delete`) and RocketVibe (`/api/v1/admin/emoji/{name}`); see [administration](administration.md#custom-emoji). Mattermost and kChat: not offered.

## The shortcode table

Both tables come from `emoji-toolkit` 10.0.0 (JoyPixels' JSON, MIT; no artwork is used, the system font draws the glyphs), the source Rocket.Chat takes its shortnames from: **6222 shortcodes**, including tone variants and alternate names, and 8 picker categories in JoyPixels order (people, nature, food, activity, travel, objects, symbols, flags). Both generators are deterministic.

- **Mobile:** `apps/mobile/scripts/generate-emojis.mjs` (`npm run emojis:generate`, `emoji-toolkit` is a dev dependency) writes `lib/emojis.generated.ts`: one JSON **string** of hexadecimal code points, parsed on first use. A string costs less than 6222 object properties built at module load, and ASCII code points let Hermes store one byte per character instead of two (124 KB saved). `lib/emojis.ts` exposes `unicodeOfShortcode` (code to glyph, `null` for "not an emoji"), `codesEmojiStandard` (frozen list for completion) and `emojisByCategory` (1918 base codes for the picker).
- **Desktop:** `apps/desktop/scripts/generate-emojis.mjs` writes `crates/rv-core/data/emojis.tsv` (shortcode, dash-separated code points, category or `-` for tone variants and aliases, then `+` when Rocket.Chat's `chat.react` accepts the code, `-` otherwise), embedded with `include_str!` in `rv-core/src/emoji.rs` and indexed once (`OnceLock`): `unicode`, `shortcode` (glyph back to code, with or without the variation selector), `category`, `complete`, `replace_shortcodes` (plain text such as previews) and `at` (the longest known emoji under a position, for hover cards).

## Mobile

- **Rendering.** `emojiUnicode` in `lib/markdown.ts` decides whether an `EMOJI` node is an emoji. `renderEmoji` in `ui/markdown.tsx` returns the glyph, else an inline `<Image>` from `customEmojiUrl` (animated GIFs play through Fresco), else `null` so the caller shows `:name:`; a `BIG_EMOJI` block that does not fully resolve is drawn as an ordinary paragraph. Reactions use the same order ([message-actions.md](message-actions.md)).
- **Custom index.** `lib/customEmojis.ts` keeps a module-level map (`buildIndex`, `setCustomEmojis`, `customEmojiUrl`, `customEmojiCodes`) so rendering stays synchronous. The list is persisted in the SQLite table `custom_emojis`, restored at startup (`restoreCustomEmojis`) so the first render and offline use work, and refreshed with the full list **once per session** after the first connection (`syncCustomEmojis`, called from `ui/sync.tsx`; on failure it retries at the next reconnection). The table is replaced only when a list was actually received, so a failed call never empties the offline cache. `isDiscarded` stops a late answer from server A from re-arming the index after a switch to server B, and `clearCustomEmojis` clears it on sign-out.
- **Completion.** `lib/emojiCompletion.ts` (pure, tested) with `ui/emojiCompletion.tsx` (the strip above the field, shared by room and thread composers). `detectEmojiToken` opens on `:` only at a word start (start of field, or after a character that is neither letter nor digit, accented letters included via `\p{L}`), so `http://`, `12:34` and `clé:valeur` do not trigger, nor does a closed `:smile:`; one letter after `:` suffices (`MIN_QUERY`). `completeEmoji` ranks exact, then prefix, then substring; at equal quality custom before standard, then shorter, then alphabetical; at most 30 (`SUGGESTION_LIMIT`). A custom emoji named like a standard one is dropped, since the glyph wins at render. Choosing inserts the **glyph** for a standard emoji and `:name:` for a custom one (a `TextInput` cannot show an image), followed by a space unless one already follows. `keyboardShouldPersistTaps="always"` keeps the first tap from merely blurring the field.
- **Picker.** `ui/emojiPicker.tsx` (`useEmojiPanel`, `EmojiPicker`): a native panel that takes the keyboard's place (its height is the last measured keyboard height, about 42 % of the screen before any keyboard showed), with search, category tabs plus a tab for the server's emoji, and a `FlatList` grid. It inserts at the cursor without a space and stays open for the next pick; the smiley / keyboard button in the composer swaps it with the keyboard and Back closes it rather than the screen. Its search, tabs and grid are `EmojiGrid`, a standalone component with a fixed height and a `customs` switch (no server tab), which the message sheet also hosts to react with any emoji (below).

## Desktop

- **Rendering.** `rv-core/src/markdown.rs` (`emoji_text`) writes the glyph, or wraps an unresolved shortcode in `CUSTOM_MARK` (U+FFFC); `rv-core/src/runs.rs` turns marked spans into runs carrying `custom_emoji`. `rv-gtk/src/markdown_view.rs` anchors the custom image in the text view when the session knows the code (`set_custom_emoji`), else prints `:code:`; a big-emoji block of custom emoji is drawn at 48 px. Hovering an emoji shows it large with its shortcode.
- **Custom index.** `emoji::custom_index` and `custom_names` build the map (code to `/emoji-custom/<name>.<ext>`, percent-encoded). `Session::once_per_session` fetches `emoji-custom.list` once per session (`Session::refresh_custom_emojis`, which the administration calls again after a change and which replaces the index), in memory only (nothing persisted), then emits `SessionEvent::Avatar` so rows redraw. Images load through the session's media cache.
- **Completion.** `rv-core/src/completion.rs` (`query`) detects `@` or `:` opening a word (start or after whitespace) with a non-empty prefix for `:`. The GTK composer (`rv-gtk/src/composer.rs`) lists matching custom codes first (`Session::custom_emoji_codes`, prefix match, sorted) then standard ones (`emoji::complete`, prefix match, shortest first), 8 in all. A standard pick inserts the glyph and a space, a custom one `:code: `.
- **GTK picker.** `rv-gtk/src/emoji_picker.rs`: a 😊 menu button with a search entry, category tabs, a tab for the server's emoji, and a grid; a search lists custom emoji containing the query, then up to 180 standard prefix matches. Glyphs the machine's fonts cannot draw as one emoji (unknown glyphs, or a sequence drawn as pieces) are left out (`drawable`). Picking inserts at the cursor and leaves the picker open. `emoji_picker::popover(pick, custom, once)` builds the same picker as a popover with a `Pick` callback (`once` pops it down after a pick, which the reaction menus use; `custom` `None` drops the server tab); `button` is the composer's.
- **SwiftUI.** Its own `EmojiPicker` grid (categories, search, in `macos/Sources/RocketVibe/Details.swift`), opened from the composer and, with `custom:` false in a private conversation, from the message menu to react; the system's Emoji & Symbols panel also works in its composer.

## Quick reactions and reacting with any emoji

The message menus of the three apps show the 5 emoji I react with most on this account (`QUICK_COUNT`), then "+" (or "React with another emoji…") opening the picker to react with any emoji, the server's custom ones included. Behaviour of the menus: [message-actions.md](message-actions.md).

- **Counting.** Every reaction I ADD counts one use at the tap or pick, before the server answers, from the menu, the picker or a reaction chip; a removal counts nothing. Counted on the device only, per account, never sent anywhere. Ranking: most uses, then most recent, then the defaults `+1 heart joy tada open_mouth pray` fill the row, skipping what is already there. Aliases of one emoji are one emoji: a use is stored under the canonical code of its glyph (the default quick reaction drawing it, else the picker's name), so `+1` and `thumbsup` count together. At most 64 codes are kept; when a new one comes, the lowest-ranked OTHER code makes room, so the code just used always stays and can grow past established ones.
- **Codes.** Shortcodes without colons (`+1`, `party_parrot`); `chat.react` wants `:code:`, never a glyph. A private (E2EE) RocketVibe conversation takes standard emoji only: no custom tab there, and custom codes are filtered out of its quick row. A custom emoji the server no longer has is filtered out too.
- **Rocket.Chat accepts only its own codes.** `chat.react` takes the codes of the server's `emoji.list` (8.5.1: 4,278, aliases included, frozen in `scripts/rocketchat-emojis.json`) or a custom emoji, and that list is older than emoji-toolkit's. Both generators read it: on Rocket.Chat a picked or quick standard code goes out as itself when accepted, else as an accepted alias of the same glyph (`alien_monster` as `space_invader`), and a glyph with no accepted code is hidden from the reaction picker and the quick row. The composer's picker and RocketVibe are unaffected. Mobile `lib/rocketchatReactions.ts#rocketChatReaction` over `lib/emojis.rocketchat.generated.ts` (refused codes mapped to their accepted alias or `""`), `EmojiGrid`'s `standard` filter; desktop `rv_core::emoji::rc_reaction` over the fourth column of `emojis.tsv`, rv-ffi `reaction_emoji(code, custom, rocket_chat)` and `rocket_chat_reacts_with`, the GTK picker's `allowed` filter.
- **Mobile.** Pure rules in `lib/emojiUsage.ts` (`QUICK_COUNT`, `DEFAULT_REACTIONS`, `KEPT_CODES` = 64, `normalizeEmojiCode`, `canonicalEmojiCode` for the stored code, `emojiIdentity`, `topEmojis`, which still merges aliases of rows written before); stored in the account's database, table `emoji_usage` (`createEmojiUsageStore`, [../architecture/mobile-data.md](../architecture/mobile-data.md)); reached through the module slot `ui/emojiUsage.ts` (`recordReaction`, `readEmojiUsage`), mounted by `SyncProvider` and released at session end.
- **Desktop.** `rv-core/src/emoji_usage.rs` (`EmojiUsage::for_account(config_dir, base_url, user_id)`, one shared instance per file in the process; `open`, `path_for`, `record`, `top`, `top_filtered(n, allowed)`, `canonical`, `same`, `QUICK_COUNT`): a text file `<config>/rocket-vibe-rs/emoji-usage/<host>-<uid>.tsv` (`code`, count, last use in seconds), where `record` canonicalises an alias to one name per glyph. GTK and SwiftUI on one Mac share the file: `record` reads it again before each write and writes through a temporary file of its own name, so the two apps merge their counts instead of overwriting each other. GTK (`rv-gtk/src/reactions.rs`: `usage`, `record`, `row` builds the quick row with its "+") and rv-ffi (`rv-ffi/src/reactions.rs`: `usage`, `quick`, `quick_rocket_chat`, the exports `reaction_emoji`, `rocket_chat_reacts_with`, `same_emoji`) both go through `for_account` and `top_filtered`; rv-ffi counts inside its react exports.

## Test data

`scripts/emojis-seed.mjs` holds two custom emoji frozen in base64 (an animated GIF `party_parrot` with alias `parrot`, a static PNG `shipit`), uploaded by `scripts/seed.mjs`, so rendering, aliases and animation can be checked on the test server.

## Parity

[Parity](../parity.md) marks shortcode emoji ("6222 codes, same table as Android"), custom emoji images and completion done. Behavioural differences: mobile completion also matches substrings and shows up to 30, desktop matches prefixes and shows 8; mobile keeps custom emoji offline in SQLite, desktop refetches them each session; the GTK picker hides glyphs the fonts cannot draw. Quick reactions (top 5 of my own use) and reacting with any emoji are done in all three; the counts live per account on the device, in SQLite on mobile and in a file the two desktop apps share. On Rocket.Chat all three send an accepted code and hide the glyphs the server refuses.

## Sources

- apps/mobile/lib/emojis.ts
- apps/mobile/lib/emojis.generated.ts
- apps/mobile/lib/customEmojis.ts
- apps/mobile/lib/emojiCompletion.ts
- apps/mobile/lib/markdown.ts
- apps/mobile/ui/markdown.tsx
- apps/mobile/ui/emojiCompletion.tsx
- apps/mobile/ui/emojiPicker.tsx
- apps/mobile/lib/emojiUsage.ts
- apps/mobile/lib/rocketchatReactions.ts
- apps/mobile/lib/emojis.rocketchat.generated.ts
- scripts/rocketchat-emojis.json
- apps/mobile/ui/emojiUsage.ts
- apps/mobile/db/store.ts
- apps/mobile/app/message-actions.tsx
- apps/mobile/ui/sync.tsx
- apps/mobile/db/schema.ts
- apps/mobile/scripts/generate-emojis.mjs
- apps/mobile/package.json
- apps/desktop/scripts/generate-emojis.mjs
- apps/desktop/crates/rv-core/data/emojis.tsv
- apps/desktop/crates/rv-core/src/emoji.rs
- apps/desktop/crates/rv-core/src/markdown.rs
- apps/desktop/crates/rv-core/src/runs.rs
- apps/desktop/crates/rv-core/src/completion.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-gtk/src/markdown_view.rs
- apps/desktop/crates/rv-gtk/src/composer.rs
- apps/desktop/crates/rv-gtk/src/emoji_picker.rs
- apps/desktop/crates/rv-core/src/emoji_usage.rs
- apps/desktop/crates/rv-gtk/src/reactions.rs
- apps/desktop/crates/rv-ffi/src/reactions.rs
- apps/desktop/macos/Sources/RocketVibe/Details.swift
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/desktop/macos/Sources/RocketVibe/Composer.swift
- scripts/emojis-seed.mjs
- scripts/seed.mjs
