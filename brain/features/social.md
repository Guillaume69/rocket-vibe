# Polls, game nights, stickers and GIFs

## Scope

Quick polls, game-night cards and voice reactions are Vibez features in unencrypted rooms. The image shelf and GIF picker also work with Rocket.Chat in Android, GTK and SwiftUI. Web speaks to Vibez only. Mattermost and kChat do not offer these controls.

## Server and contract

Additive `Message.social` carries a typed poll, game night or image. Older clients still see a text fallback. `social_cards`, `sticker_shelf`, `giphy` and `voice_reactions` capabilities gate the controls. Polls and events can be thread replies. Polls have 2 to 10 distinct options, one choice or several, optional closure within 30 days, explicit vote withdrawal, and author-only closure. Events carry a future RFC3339 start within a year, description and Going/Maybe/Can't make it responses. Dates display locally. At most 200 accounts answer a card.

Create, answer and close run in PostgreSQL transactions, lock current room membership, persist operation receipts and publish message revisions to the journal. Exact retries do not overwrite newer answers. Ordinary text edits cannot change social cards; ordinary deletion hides their typed content. Poll closure and event expiry are also enforced by the server.

The private shelf holds at most 200 public HTTPS image links per account. On Vibez it syncs through GET/POST/DELETE `/api/v1/stickers`; POST `/api/v1/rooms/{room}/images` sends one with the usual idempotent message identity. Authenticated file links and credential-bearing URLs cannot become shelf entries.

Voice uses POST `/api/v1/rooms/{room}/voice/reactions` and the ephemeral `LiveState.voice_reactions` vector. Only currently connected voice participants of the current data epoch can send and receive bursts. The six choices are applause, laughter, heart, party, thumbs-up and wave. Bursts expire after six seconds, stay out of history, and have a two-second sender cooldown. Maintenance removes expired rows. Encrypted voice reactions remain debt; no plaintext reaction is sent there.

## GIPHY configuration

Vibez reads a private, bounded JSON file via `VIBEZ_GIPHY_CONFIG_FILE` or `--giphy-config-file`. See `apps/server/giphy.example.json`. Required `api_key`; rating defaults to `pg` and accepts `g`, `pg`, `pg-13`, `r`. A Unix file must be private to its owner. The key stays on the server and is cleared from memory on drop. No key is shipped. Without configuration, discovery advertises `giphy=false` and search returns `giphy_not_configured`.

GET `/api/v1/gifs?q=...` searches or lists trending GIFs; `stickers=true` selects the provider's sticker collection. Queries are bounded, authenticated and rate-limited. Provider requests time out, reject redirects and bound response size. Only GIPHY media origins enter search results. Pickers and cards show Powered By GIPHY.

Rocket.Chat uses its own installed GIPHY app and key. The clients GET `commands.preview` with command, roomId and params, then POST the selected image's id/type/value with triggerId and optional tmid to that endpoint. They no longer rely on `commands.run` alone. Cancellation preserves the draft; successful selection clears only the unchanged draft. The client does not receive the Rocket.Chat app's key. A missing or disabled server app produces an unavailable/search error.

Typing `/giphy` opens the same GIF picker as the sharing menu, in rooms and threads. Its search field refreshes automatically after 300 ms without another keystroke. Changing the query immediately clears the selected image and invalidates earlier responses. The picker uses a compact, scrollable thumbnail grid with a highlighted selection and fixed search/actions; one Save-to-shelf and one Send action concern the selected GIF. Choosing an image alone sends nothing. Enter or Send submits it, with duplicate submissions blocked while the request is in flight. No image-link field appears in a GIF search. Cancel keeps the composer draft, and a successful command send clears only the draft captured when the picker opened.

## Mobile

`app/social.tsx` is a native form sheet opened from the composer. Poll options use one line each; closing presets keep the same timestamp on retry. Game nights use local date choices and HH:MM. Card votes, RSVPs, local reminders and the voice page are accessible from the timeline. Voice bursts use native Animated text. Encrypted-room controls are hidden.

Rocket.Chat shelves are private files keyed by a native SHA256 digest of server and user. Vibez shelves live on the server. RN Image renders GIFs with Expo's existing native Fresco GIF support. No extra UI or native dependency was added.

## Desktop

GTK uses libadwaita dialogs, grouped native checkboxes, local date/time fields and a reusable image gallery. Native GdkPixbuf decodes and animates gallery/card GIFs. Rocket.Chat image attachments retain the existing media animation path. The per-account Rocket.Chat shelf is a migrated SQLite table. Failed sticker sends confirm their stable message id with chat.getMessage before reporting failure.

SwiftUI uses SocialPanel, SocialCardView and VoiceReactionsView through typed UniFFI records and guarded RoomModel operations. AppKit NSImageView preserves GIF animation in both the gallery and ordinary attachments. The shared Swift models build on Linux; a Mac GUI run is still needed for visible qualification. GTK game-night cards owe the dedicated pre-event reminder shortcut; the ordinary message reminder remains available.

## Web

The composer opens GTK's Share something dialog with ordinary full-width choices. Poll and game-night dialogs follow the native 600 by 560 layout, plain entry fields, local date/time strings and inline validation. Poll options use `|`; game nights default to tomorrow at 20:00. Poll cards use native check rows with counts and vertical Vote/Clear/Close actions; game cards use centered local timestamps and vertical RSVP controls. The image shelf keeps Search/Refresh and the native Image/title action row. GIFs use native browser images. Requests/results are fenced to the account, current room and room opening. Voice reactions float on participant tiles with reduced-motion support. The dedicated pre-event reminder shortcut is absent to follow the requested GTK reference; ordinary message reminders remain available and the shortcut is explicit parity debt.

## Verification

Server integration tests exercise create replay, answer changes, stale retries, unauthorized votes and closure, private shelves, credential-bearing URL refusal, thread image sends, connected-only bursts, expiry, stale epochs and key-free discovery. Mobile tests exercise the Rocket.Chat preview/selection request contract, thread forwarding and cancel resolution, and social-card retention through snapshot quote refresh, voting and projection restart. Android launches against the disposable server and renders the typed social cards. GTK passes the full Fedora build gate and a native login/room-render smoke with an isolated keyring. The web browser test uses real server writes and journal delivery, with controlled GIPHY/media fixtures instead of a live API key. It covers command and menu opening, live search, debounce, out-of-order responses, empty results, selection without sending, repeated Enter while a send is pending, the Send button, and cancellation. `RV_SMOKE_GIPHY` drives the real GTK controls against a local Rocket.Chat preview fixture; `hold` retains a selection for a gallery screenshot. Live GIPHY-provider validation awaits an operator key; Mac GUI qualification is not supplied by Linux Swift tests.

## Sources

- crates/rv-protocol/src/social.rs
- crates/rv-client/src/lib.rs
- apps/server/src/social.rs
- apps/server/src/giphy.rs
- apps/server/src/http.rs
- apps/server/src/live.rs
- apps/server/migrations/0059_social.sql
- apps/server/tests/social.rs
- apps/mobile/app/social.tsx
- apps/mobile/ui/social.tsx
- apps/mobile/lib/giphy.ts
- apps/mobile/ui/gifSelection.ts
- apps/mobile/providers/vibez/social.test.ts
- apps/desktop/crates/rv-core/src/social.rs
- apps/desktop/crates/rv-core/src/native/social.rs
- apps/desktop/crates/rv-gtk/src/social.rs
- apps/desktop/crates/rv-ffi/src/social.rs
- apps/desktop/macos/Sources/RocketVibe/Social.swift
- apps/desktop/macos/Sources/RocketVibeKit/SocialModel.swift
- apps/web/src/social.tsx
- apps/web/src/social-parity.css
- apps/web/tests/social.mjs
- apps/desktop/crates/rv-gtk/src/smoke/giphy.rs
