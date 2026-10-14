# X posts

A link to a post on X (Twitter) shows as a card shaped like the post: the author's photo, name and @handle, the text, and the post's picture or its video's first image. Every app recognises the link in the message text, so the card appears before the server has described it, and fills it from the server's link metadata. No app asks X anything but the images: the card opens the post in the X app or the browser.

## Shared rules

- **Which links.** `x.com/<handle>/status/<id>` and `/statuses/`, on `x.com` and `twitter.com` with an optional `www.` or `mobile.` host, plus the handle-less `x.com/i/web/status/<id>` and `x.com/i/status/<id>`. A handle is 1 to 15 of `[A-Za-z0-9_]`, an id 1 to 20 digits; trailing path (`/photo/1`), query and fragment are ignored, sentence punctuation after the id is allowed, a letter is not. The host needs a boundary, so `box.com/a/status/1` and `me@x.com/...` are not posts. The card opens the canonical `https://x.com/<handle>/status/<id>` (`/i/status/<id>` without a handle). At most 3 per message, deduplicated by id.
- **What X serves** (probed 2026-10-14 with the Vibez fetcher's agent and a browser's, identical; a Googlebot agent gets 403): ordinary OpenGraph tags. `og:title` is `"<name> (@<handle>) on X"`, `og:description` the text, `og:image` the post's first picture (`pbs.twimg.com/media/...`), a video's first image (`ext_tw_video_thumb`, `amplify_video_thumb`, `tweet_video_thumb`), or for a post without media the author's photo (`profile_images/..._400x400.jpg`). `twitter.com` redirects to `x.com`. An unknown or deleted post answers 404 without tags.
- **Filling the card.** The server entry is matched to the detected link by post id (the server keeps the raw URL with its `?s=20`). The title is split into name and handle (anything else becomes the name); the image is classed by its path: an author photo becomes the avatar, a video image gets a play badge, anything else is the picture. Without metadata the card shows the handle from the link and "Open the post on X".
- **No double card.** The generic link previews skip X post links, as they skip video links ([media-playback.md](media-playback.md)).
- **Vibez server.** Its fetcher (`apps/server/src/link_previews/network.rs`) drops an `og:image` on `pbs.twimg.com/profile_images/` (`x_avatar`): stored as the preview's only image, a portrait would read as the post's picture. Its preview image is a private PNG with no source path, so on Vibez there is no avatar (a monogram stands in) and no video badge.
- **Rocket.Chat gets nothing from X.** 8.5 registers an oEmbed provider for `(twitter|x).com/<user>/status/` whose only effect is a user agent of `<API_Embed_UserAgent> Rocket.Chat/<version> Googlebot/2.1`, and X answers 403 to a Googlebot not coming from Google's addresses: the message keeps `urls: [{url, meta: {}}]` (probed on the 8.5.1 bench 2026-10-14, a GitHub link in the same message unfurled fully; read in its bundle). On a Rocket.Chat server the card therefore shows the handle from the link and "Open the post on X", nothing else.
- **Mattermost.** Its unfurler stores OpenGraph embeds, mapped to the same `ogTitle`, `ogDescription`, `ogImage` keys by each app's translator. The images are X's public URLs (unless the server's image proxy rewrites them, which hides the avatar and video classes).

## Mobile

`lib/xPosts.ts` detects (`detectXPosts`, `xPostId`, `isXPostLink`) and classes images (`xImageKind`, `splitXTitle`); `xPostMetas` in `lib/linkPreview.ts` projects `urls` by post id, through the private reader on Vibez (`nativePreviewUri`). `ui/xPostCard.tsx` (`XPosts`) draws the card under the video cards in `ui/messageRow.tsx`: 36 px avatar or monogram, name, handle, an "X" mark, the text up to 8 lines, the picture at 16:9 with a drawn play badge for a video. A tap goes through `openExternalLink`, so Android's app links hand it to the X app when installed. No WebView (ROADMAP section 4.2).

## Desktop

`content::x_posts` (`rv-core/src/content.rs`) detects and fills `XPost`; `link_previews` skips X links. GTK draws it in `cards::x_post` (`rv-gtk/src/cards.rs`), called from the three provider branches of `rows.rs`; a click anywhere opens the post in the browser, the tooltip shows the link. rv-ffi carries it as a `Card` with `x_post`, `handle` and `avatar` (`rv-ffi/src/model.rs`, `title` the name, `description` the text, `image` the picture); SwiftUI draws `XPostCard` in `macos/Sources/RocketVibe/RoomView.swift`.

## Web

`src/x-links.ts` (`xPostLink`, `xPostLinks`, `splitXTitle`) reads the same links from the message's markdown links and text; `XPostCard` in `src/ui/messages.tsx` takes the matching `message.previews` entry and loads its protected image like other previews. Monogram only, per the Vibez rule above. Unit test `tests/x-links.test.ts`.

## Parity

[parity](../parity.md) §3, row "X (Twitter) post cards": done in the four apps. What a card holds depends on the server, not the app: full on Mattermost, without avatar or video badge on Vibez, the handle only on Rocket.Chat.

## Sources

- apps/mobile/lib/xPosts.ts
- apps/mobile/lib/xPosts.test.ts
- apps/mobile/lib/linkPreview.ts
- apps/mobile/lib/linkPreview.test.ts
- apps/mobile/ui/xPostCard.tsx
- apps/mobile/ui/messageRow.tsx
- apps/desktop/crates/rv-core/src/content.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-ffi/src/model.rs
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/web/src/x-links.ts
- apps/web/src/ui/messages.tsx
- apps/web/tests/x-links.test.ts
- apps/server/src/link_previews/network.rs
