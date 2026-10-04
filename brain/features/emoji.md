# Emoji

How `:shortcode:` emoji become glyphs, how the server's custom emoji become images, and how the composer offers emoji through `:` completion and a picker. Rocket.Chat sends only shortcode names, so both apps carry their own shortcode table, generated from the same source.

## The server contract

- **Shortcodes are not resolved.** 8.5 pre-parses `:smile:` into `{type: 'EMOJI', shortCode: 'smile'}` with no `unicode` field (a `unicode` field appears only when the author typed the glyph itself). The client must know that `smile` is 😄; without a table the screen shows `:smile:`.
- **Nothing is validated.** The parser accepts `:anything:`; an isolated `:not_an_emoji:` comes out as a `BIG_EMOJI` block like a real one. The table is therefore also the judge of what is an emoji: an unknown code renders as its literal `:name:` and is never enlarged.
- **Custom emoji.** `GET /api/v1/emoji-custom.list` gives `name`, `extension` and `aliases`. It accepts only `updatedSince`; a `count` parameter is refused ("must NOT have additional properties"). The image is at `/emoji-custom/<name>.<ext>` and must use the **canonical name**: `/emoji-custom/<alias>.<ext>` returns a fallback SVG, not the image. On 8.5 that route is public (`FileUpload_ProtectFiles` does not cover it).
- **Resolution order**, both apps: Unicode glyph first, then custom image, then literal `:name:`. A shortcode that is both standard and custom renders the glyph.
- **Index rule.** Names are indexed before aliases, so an alias can never hide another emoji's own name whatever the server's order; between two valid entries the first wins.

## The shortcode table

Both tables come from `emoji-toolkit` 10.0.0 (JoyPixels' JSON, MIT; no artwork is used, the system font draws the glyphs), the source Rocket.Chat takes its shortnames from: **6222 shortcodes**, including tone variants and alternate names, and 8 picker categories in JoyPixels order (people, nature, food, activity, travel, objects, symbols, flags). Both generators are deterministic.

- **Mobile:** `apps/mobile/scripts/generer-emojis.mjs` (`npm run emojis:generer`, `emoji-toolkit` is a dev dependency) writes `lib/emojis.genere.ts`: one JSON **string** of hexadecimal code points, parsed on first use. A string costs less than 6222 object properties built at module load, and ASCII code points let Hermes store one byte per character instead of two (124 KB saved). `lib/emojis.ts` exposes `unicodeDeCodeCourt` (code to glyph, `null` for "not an emoji"), `codesEmojiStandard` (frozen list for completion) and `emojisParCategorie` (1918 base codes for the picker).
- **Desktop:** `apps/desktop/scripts/generate-emojis.mjs` writes `crates/rv-core/data/emojis.tsv` (shortcode, dash-separated code points, category or `-` for tone variants and aliases), embedded with `include_str!` in `rv-core/src/emoji.rs` and indexed once (`OnceLock`): `unicode`, `shortcode` (glyph back to code, with or without the variation selector), `category`, `complete`, `replace_shortcodes` (plain text such as previews) and `at` (the longest known emoji under a position, for hover cards).

## Mobile

- **Rendering.** `unicodeDEmoji` in `lib/markdown.ts` decides whether an `EMOJI` node is an emoji. `rendreEmoji` in `ui/markdown.tsx` returns the glyph, else an inline `<Image>` from `urlEmojiCustom` (animated GIFs play through Fresco), else `null` so the caller shows `:name:`; a `BIG_EMOJI` block that does not fully resolve is drawn as an ordinary paragraph. Reactions use the same order ([message-actions.md](message-actions.md)).
- **Custom index.** `lib/emojisCustom.ts` keeps a module-level map (`indexer`, `definirEmojisCustom`, `urlEmojiCustom`, `codesEmojiCustom`) so rendering stays synchronous. The list is persisted in the SQLite table `emojis_custom`, restored at startup (`restaurerEmojisCustom`) so the first render and offline use work, and refreshed with the full list **once per session** after the first connection (`synchroniserEmojisCustom`, called from `ui/synchro.tsx`; on failure it retries at the next reconnection). The table is replaced only when a list was actually received, so a failed call never empties the offline cache. `estAbandonne` stops a late answer from server A from re-arming the index after a switch to server B, and `viderEmojisCustom` clears it on sign-out.
- **Completion.** `lib/completionEmoji.ts` (pure, tested) with `ui/completionEmoji.tsx` (the strip above the field, shared by room and thread composers). `detecterJetonEmoji` opens on `:` only at a word start (start of field, or after a character that is neither letter nor digit, accented letters included via `\p{L}`), so `http://`, `12:34` and `clé:valeur` do not trigger, nor does a closed `:smile:`; one letter after `:` suffices (`MIN_REQUETE`). `completerEmoji` ranks exact, then prefix, then substring; at equal quality custom before standard, then shorter, then alphabetical; at most 30 (`LIMITE_SUGGESTIONS`). A custom emoji named like a standard one is dropped, since the glyph wins at render. Choosing inserts the **glyph** for a standard emoji and `:name:` for a custom one (a `TextInput` cannot show an image), followed by a space unless one already follows. `keyboardShouldPersistTaps="always"` keeps the first tap from merely blurring the field.
- **Picker.** `ui/navigateurEmoji.tsx` (`usePanneauEmoji`, `NavigateurEmoji`): a native panel that takes the keyboard's place (its height is the last measured keyboard height, about 42 % of the screen before any keyboard showed), with search, category tabs plus a tab for the server's emoji, and a `FlatList` grid. It inserts at the cursor without a space and stays open for the next pick; the 😀/⌨️ toggle swaps it with the keyboard and Back closes it rather than the screen.

## Desktop

- **Rendering.** `rv-core/src/markdown.rs` (`emoji_text`) writes the glyph, or wraps an unresolved shortcode in `CUSTOM_MARK` (U+FFFC); `rv-core/src/runs.rs` turns marked spans into runs carrying `custom_emoji`. `rv-gtk/src/markdown_view.rs` anchors the custom image in the text view when the session knows the code (`set_custom_emoji`), else prints `:code:`; a big-emoji block of custom emoji is drawn at 48 px. Hovering an emoji shows it large with its shortcode.
- **Custom index.** `emoji::custom_index` and `custom_names` build the map (code to `/emoji-custom/<name>.<ext>`, percent-encoded). `Session::once_per_session` fetches `emoji-custom.list` once per session, in memory only (nothing persisted), then emits `SessionEvent::Avatar` so rows redraw. Images load through the session's media cache.
- **Completion.** `rv-core/src/completion.rs` (`query`) detects `@` or `:` opening a word (start or after whitespace) with a non-empty prefix for `:`. The GTK composer (`rv-gtk/src/composer.rs`) lists matching custom codes first (`Session::custom_emoji_codes`, prefix match, sorted) then standard ones (`emoji::complete`, prefix match, shortest first), 8 in all. A standard pick inserts the glyph and a space, a custom one `:code: `.
- **GTK picker.** `rv-gtk/src/emoji_picker.rs`: a 😊 menu button with a search entry, category tabs, a tab for the server's emoji, and a grid; a search lists custom emoji containing the query, then up to 180 standard prefix matches. Glyphs the machine's fonts cannot draw as one emoji (unknown glyphs, or a sequence drawn as pieces) are left out (`drawable`). Picking inserts at the cursor and leaves the picker open.
- **SwiftUI.** Its own `EmojiPicker` grid (categories, search, in `macos/Sources/RocketVibe/Details.swift`), opened from the composer; the system's Emoji & Symbols panel also works in its composer.

## Test data

`scripts/emojis-seed.mjs` holds two custom emoji frozen in base64 (an animated GIF `party_parrot` with alias `parrot`, a static PNG `shipit`), uploaded by `scripts/seed.mjs`, so rendering, aliases and animation can be checked on the test server.

## Parity

PARITY marks shortcode emoji ("6222 codes, same table as Android"), custom emoji images and completion done. Behavioural differences: mobile completion also matches substrings and shows up to 30, desktop matches prefixes and shows 8; mobile keeps custom emoji offline in SQLite, desktop refetches them each session; the GTK picker hides glyphs the fonts cannot draw.

## Sources

- apps/mobile/lib/emojis.ts
- apps/mobile/lib/emojis.genere.ts
- apps/mobile/lib/emojisCustom.ts
- apps/mobile/lib/completionEmoji.ts
- apps/mobile/lib/markdown.ts
- apps/mobile/ui/markdown.tsx
- apps/mobile/ui/completionEmoji.tsx
- apps/mobile/ui/navigateurEmoji.tsx
- apps/mobile/ui/synchro.tsx
- apps/mobile/db/schema.ts
- apps/mobile/scripts/generer-emojis.mjs
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
- apps/desktop/macos/Sources/RocketVibe/Details.swift
- apps/desktop/macos/Sources/RocketVibe/Composer.swift
- scripts/emojis-seed.mjs
- scripts/seed.mjs
- brain/parity.md
