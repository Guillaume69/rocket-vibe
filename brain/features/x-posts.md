# X posts

A link to a post on X (Twitter) shows as a card shaped like the post: the author's photo, name and @handle, the text, and the post's picture or its video's first image. Every app recognises the link in the message text, so the card appears before the server has described it, and fills it from the server's link metadata. A Rocket.Chat server gets nothing from X, so on a Rocket.Chat account (only there) the app reads the post from X itself. The card opens the post in the X app or the browser.

## Shared rules

- **Which links.** `x.com/<handle>/status/<id>` and `/statuses/`, on `x.com` and `twitter.com` with an optional `www.` or `mobile.` host, plus the handle-less `x.com/i/web/status/<id>` and `x.com/i/status/<id>`. A handle is 1 to 15 of `[A-Za-z0-9_]`, an id 1 to 20 digits; trailing path (`/photo/1`), query and fragment are ignored, sentence punctuation after the id is allowed, a letter is not. The link's own host must be X's: `box.com/a/status/1`, `me@x.com/...`, `https://evil.example/x.com/a/status/1`, a Wayback or `?u=` redirect link are other sites' pages, whose metadata must never pose as the post (they keep their own generic preview). rv-core and the web split the text into tokens and read each token's host; mobile's pattern requires the start, a space, a bracket, a quote or markdown emphasis (`*`, `_`, `~`) before the link, and its server entries the X host itself. Mobile and rv-core take a link without a scheme (`x.com/jack/status/20`) and an emphasised one (`*https://x.com/...*`); the web needs a scheme, as for video links. The card opens the canonical `https://x.com/<handle>/status/<id>` (`/i/status/<id>` without a handle). At most 3 per message, deduplicated by id.
- **What X serves** (probed 2026-10-14 with the Vibez fetcher's agent and a browser's, identical; a Googlebot agent gets 403): ordinary OpenGraph tags. `og:title` is `"<name> (@<handle>) on X"`, `og:description` the text, `og:image` the post's first picture (`pbs.twimg.com/media/...`), a video's first image (`ext_tw_video_thumb`, `amplify_video_thumb`, `tweet_video_thumb`), or for a post without media the author's photo (`profile_images/..._400x400.jpg`). `twitter.com` redirects to `x.com`. An unknown or deleted post answers 404 without tags.
- **Filling the card.** The server entry is matched to the detected link by post id (the server keeps the raw URL with its `?s=20`). The title is split into name and handle (anything else becomes the name), its handle winning over the link's: the title names the account as it is now, a link may carry an old one; the image is classed by its path: an author photo becomes the avatar, a video image gets a play badge, anything else is the picture. Without metadata the card shows the handle from the link and "Open the post on X".
- **No double card.** The generic link previews skip X post links, as they skip video links ([media-playback.md](media-playback.md)).
- **Vibez server.** Its fetcher (`apps/server/src/link_previews/network.rs`) drops an `og:image` on `pbs.twimg.com/profile_images/` (`x_avatar`): stored as the preview's only image, a portrait would read as the post's picture. Its preview image is a private PNG with no source path, so on Vibez there is no avatar (a monogram stands in) and no video badge.
- **Rocket.Chat gets nothing from X.** 8.5 registers an oEmbed provider for `(twitter|x).com/<user>/status/` whose only effect is a user agent of `<API_Embed_UserAgent> Rocket.Chat/<version> Googlebot/2.1`, and X answers 403 to a Googlebot not coming from Google's addresses: the message keeps `urls: [{url, meta: {}}]` (probed on the 8.5.1 bench 2026-10-14, a GitHub link in the same message unfurled fully; read in its bundle). Hence the next rule.
- **Rocket.Chat accounts ask X** (user decision, 2026-10-14): when the server gave no text, the card asks X's syndication endpoint, the one X's embed widget reads: `GET https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=<t>&lang=en`, no credentials. `token` is the widget's `((id / 1e15) * π).toString(36)` without zeros and point; its value is not checked (any non-empty token answers, none answers `{}`), but the apps send the real one (rv-core ports V8's base-36 formatting, tested against values computed in JavaScript). The answer (probed 2026-10-14): `__typename: "Tweet"` (`TweetTombstone` for a removed post, HTTP 404 for an unknown one), `user.{name, screen_name, profile_image_url_https}` (`_normal` is 48 px: the apps take `_bigger`, 73 px), `text` HTML-escaped, `display_text_range` and `mediaDetails[].indices` in code points of the ESCAPED text (`&amp;` counts five; decoding first left "htt" from the next link behind), `mediaDetails[0].{type, media_url_https}` (`photo`, `video`, `animated_gif`, the poster for the last two), `entities.urls[].{url, display_url}`, `quoted_tweet` for a quote (not shown: the card holds the quoting post only). The text shown is the range minus each media's `t.co` link (older posts keep it inside the range), other `t.co` links in display form, then decoded. Only https images are kept. X refuses a request without a user agent (400); desktop sends a bare `Mozilla/5.0`, naming no app. Answers are cached in memory per post (300 at most); a 404 or a tombstone is remembered as "no such post", a failure (network, status, cut or malformed body) is not, but the post is not asked again for 60 s, and concurrent cards share one request, so a room scrolled while X refuses sends no request per row. Never about a link in an encrypted message: the server never saw it, X would learn what it could not (mobile shows no card in an `e2e` message at all; desktop shows it but never asks, rv-ffi's `Card.x_lookup`). Never on Vibez, Mattermost, kChat or WhatsApp: their server or the sender already described the post. The device then tells X which posts were linked in the rooms it reads.
- **Mattermost.** Its unfurler stores OpenGraph embeds, mapped to the same `ogTitle`, `ogDescription`, `ogImage` keys by each app's translator. The images are X's public URLs (unless the server's image proxy rewrites them, which hides the avatar and video classes).

## Mobile

`lib/xPosts.ts` detects (`detectXPosts`, `xPostId`, `isXPostLink`) and classes images (`xImageKind`, `splitXTitle`); `xPostMetas` in `lib/linkPreview.ts` projects `urls` by post id, through the private reader on Vibez (`nativePreviewUri`). `lib/xSyndication.ts` (`fetchXPost`, `parseSyndication`, `syndicationToken`) asks X; `XPosts` passes `askX` for `client.kind === 'rocketchat'`, the card's `useXPost` hook asks when the server had no text, and `mergeXMeta` (`lib/linkPreview.ts`) overlays X's answer on the server's field by field, as rv-core's `Details::apply` does. `ui/xPostCard.tsx` (`XPosts`) draws the card under the video cards in `ui/messageRow.tsx`: the shared `AvatarTile` (`ui/kit.tsx`, 36 px, round) with the photo or an initial, name, handle, an "X" mark, the text up to 8 lines, the picture at 16:9 with the themed play badge of the other video cards. A tap goes through `openExternalLink`, so Android's app links hand it to the X app when installed. No WebView (ROADMAP section 4.2).

## Desktop

`content::x_posts` (`rv-core/src/content.rs`) detects and fills `XPost`; `link_previews` skips X links. GTK draws it in `cards::x_post` (`rv-gtk/src/cards.rs`), called from the three provider branches of `rows.rs`; a click anywhere opens the post in the browser, the tooltip shows the link. rv-ffi carries it as a `Card` with `x_post`, `handle` and `avatar` (`rv-ffi/src/model.rs`, `title` the name, `description` the text, `image` the picture); SwiftUI draws `XPostCard` in `macos/Sources/RocketVibe/RoomView.swift`.

`rv-core/src/x_syndication.rs` asks X: `applies(&SessionInfo)` (not native, Mattermost, kChat or WhatsApp), `fetch` with its cache, one lock per post in flight and the 60 s pause after a failure, `cached`, and `Details::apply` onto an `XPost`. GTK's Rocket.Chat branch of `rows.rs` uses `cards::x_post_asking_x` unless the message is encrypted; it fills the card from the cache at once or rebuilds it when X answers. SwiftUI's `XPostCard` calls `Chat.xPostDetails(url:)` (`rv-ffi/src/links.rs`, None on any account but Rocket.Chat) when `card.xLookup`, and drops the previous answer when an edit changes the link.

## Web

`src/x-links.ts` (`xPostLink`, `xPostLinks`, `splitXTitle`) reads the same links from the message's markdown links and text; `XPostCard` in `src/ui/messages.tsx` takes the matching `message.previews` entry and loads its protected image like other previews. Monogram only, per the Vibez rule above. Unit test `tests/x-links.test.ts` (detection only): no browser case renders the card yet.

## Parity

[parity](../parity.md) §3, row "X (Twitter) post cards": done on Android, GTK and SwiftUI, partial on the web (implemented, not qualified by a browser case). What a card holds depends on the account: full on Mattermost and on Rocket.Chat (read from X), without avatar or video badge on Vibez.

## Sources

- apps/mobile/lib/xPosts.ts
- apps/mobile/lib/xSyndication.ts
- apps/mobile/lib/xSyndication.test.ts
- apps/mobile/lib/xPosts.test.ts
- apps/mobile/lib/linkPreview.ts
- apps/mobile/lib/linkPreview.test.ts
- apps/mobile/ui/xPostCard.tsx
- apps/mobile/ui/messageRow.tsx
- apps/desktop/crates/rv-core/src/content.rs
- apps/desktop/crates/rv-core/src/x_syndication.rs
- apps/desktop/crates/rv-ffi/src/links.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-ffi/src/model.rs
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/web/src/x-links.ts
- apps/web/src/ui/messages.tsx
- apps/web/tests/x-links.test.ts
- apps/server/src/link_previews/network.rs
