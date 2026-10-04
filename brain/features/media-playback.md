# Media playback

How images, video and audio attachments, and YouTube, Dailymotion and Vimeo links are shown and played: inline images with a full-size viewer, players that exist only while used, and video-site cards. Mobile has no WebView outside the call screen, so its video cards open the app or browser; desktop plays them inside the card.

## Shared rules

- **Protected files.** The target server has `FileUpload_ProtectFiles` on: every `/file-upload/...` read needs `rc_uid` and `rc_token` in the query. Both apps add them **only when the URL is on the session's own origin**. An attachment URL comes from a message, so ultimately from anyone (`chat.sendMessage` accepts arbitrary attachments); an off-origin link stays bare and a protected file then fails to load, which is the right failure (mobile `urlFichierProtege` in `lib/upload.ts`, desktop `media::protected_url` in `rv-core/src/media.rs`).
- **Which image.** Rocket.Chat stores a ~480 px thumbnail in `image_url` and the original in `title_link`. Both apps show the original when `title_link` is a server path, falling back to `image_url`, so an enlarged image is not pixelated. Layout: natural width clamped (desktop 120 to 360 px, mobile 120 px to the available width), height at the original's ratio, capped (desktop 300 px, mobile 400 px) and cropped with cover; `image_dimensions` describes the thumbnail but its ratio is the original's. The viewer shows the whole image.
- **Link-preview images** (OpenGraph, oEmbed thumbnails, a link that is an image) are public URLs and load without the token.
- **Video sites.** A link is recognised by pattern in the message text (YouTube, Dailymotion, Vimeo), so a card appears even before the server described the link; its title and author come from the server's `urls[]` metadata matched by video id (YouTube through oEmbed, the others through OpenGraph). At most 3 per message. These links are skipped by the generic link previews so a message never carries two cards. Vimeo has no predictable thumbnail.
- **Downloads have no total.** `/file-upload/...` answers chunked, without `Content-Length`; progress uses the size in the attachment (`size`, `video_size`, `audio_size`, `image_size`). See [uploads.md](uploads.md) for downloads and saving.
- **Encrypted rooms.** The server holds only ciphertext of their files: each app downloads, decrypts locally and then shows the media as in a clear room. See [e2ee.md](e2ee.md).

## Mobile

- **Images.** `ImageJointe` in `ui/ligneMessage.tsx`. A tap opens `ui/visionneuse.tsx`, a full-screen viewer in a native `Modal` with its own `GestureHandlerRootView` (a `Modal` is a separate native window the root gesture handler does not cover): pinch to zoom, pan once zoomed, double tap to zoom in or out, swipe down to close, and a save button (`enregistrerEnFond` in `ui/actionsJointe.ts`). The protected URL is kept in context state and **never passed as an expo-router route parameter**, which would put a secret in a serialisable URL. Animated GIFs play through Fresco's animated-GIF support.
- **Video attachments.** `ui/lecteurVideo.tsx` (`expo-video`). The message shows a themed card (aurora banner, play button, download progress overlay `BarreTransfert`); a tap opens a full-screen `Modal` with native controls. The player is created only when the modal mounts and released when it closes: `useVideoPlayer` is a costly native instance and a room can hold several videos. Video attachments must be tested before the generic file branch, since they also carry `title_link`.
- **Audio attachments and voice messages.** `ui/lecteurAudio.tsx` (`expo-audio`) plays in place: play/pause, a tappable progress bar and a "rainbow comet" visualiser fed by `useAudioSampleListener`, a Hann-windowed FFT over log-spaced bands with high-band lift, automatic gain and per-bar smoothing. On Android the sample tap needs `RECORD_AUDIO` (already granted for recording); without it playback still works with idle bars. The player exists only once "play" is pressed (`LecteurAudioActif`): created per visible message, it buffered every voice note on screen (about 20 MB for twenty notes heard zero seconds). One player at a time, coordinated at module level. See [voice-messages.md](voice-messages.md).
- **Video-site cards.** `ui/carteEmbed.tsx` with `lib/liensVideo.ts` (`detecterLiensVideo`, `idVideo`, `estLienVideo`) and `metasVideo` in `lib/apercuLien.ts`. A card with the public thumbnail (rebuilt from the id for YouTube and Dailymotion, an aurora banner otherwise), a dark veil, a play button, and the title and channel when known. A tap calls `ouvrirLienExterne`, which hands the URL to the native app or the browser. Embedded playback would need a WebView, forbidden outside the call screen ([decisions.md](../decisions.md), ROADMAP section 4.2). The pattern requires a host boundary, so `notyoutube.com/watch?v=...` does not match.
- **Encrypted media.** `JointeChiffree` decrypts images, audio and video into the cache before showing them; above 25 MB (`APERCU_CHIFFRE_MAX`) a medium is not decrypted for preview and stays a card to share or save.

## Desktop

- **Images.** `rows::image_widget` (`rv-gtk/src/rows.rs`) loads the texture through `rv-gtk/src/media.rs`, which fetches each path once, shares the request among every widget waiting for it, and keeps decoded textures for the session (`TEXTURES`, cleared at session stop). Animated GIFs are decoded by `rv-core/src/animation.rs` into composited RGBA frames (a 0 or 10 ms delay plays at 100 ms, like browsers), within a 48 MB budget, the frames of the last 8 GIFs kept. A click opens `open_viewer`: an `adw::Dialog` that closes on a backdrop click (the dimmed backdrop otherwise acted as a window drag handle) with a right-click menu to copy, save as PNG, or open elsewhere. The image's alt text (8.5 stores the upload's caption in `image_alt`) is its tooltip.
- **Video attachments.** `rv-gtk/src/video.rs`: a 16:9 frame with the first image and a play badge, playing in the same frame with a controls bar, fullscreen on demand. The file is downloaded to a local copy first (protected files need the token, and the player reads a file), with progress on the card; a click during the download plays once it lands. The first image is not fetched for files over 25 MB (`POSTER_MAX_BYTES`).
- **Audio.** `cards::file` shows name, size and type with Play and Download; Play downloads then appends `gtk::MediaControls` (`audio_player`). Other files open in the default application.
- **Media backend.** `rv-gtk/src/gst_stream.rs` (`for_file`) uses GTK's own media file when GTK has a backend, else a GStreamer `playbin` behind a `gtk::MediaStream` (Homebrew's GTK ships without one). Under NVIDIA's proprietary driver on Linux (`/proc/driver/nvidia/version` present), or with `RV_SOFTWARE_VIDEO=1`, video is drawn from CPU frames: the GL driver crashed in GTK's renderer on GPU frames, and WebKit drew its video black. `RV_MEDIA_BACKEND=gstreamer` forces the GStreamer path.
- **Video-site cards played in the card.** `cards::video_link`: provider, title, author; the title opens the browser, the thumbnail plays. `rv-core/src/player.rs` builds a page of ours holding the provider's embed in an iframe (`embed_url` with autoplay; ids restricted to `[A-Za-z0-9_-]`). YouTube refuses an embed loaded without a Referer (error 153), so the page is served from `ORIGIN` = `https://player.rocket-vibe.invalid`, a name that resolves nowhere, handed over by each engine. `navigation` keeps the main frame on that page; inside the embed the provider goes where it likes, but a user click leaving the player ("Watch on YouTube") opens the browser. Engines (`rv-gtk/src/player.rs`): WebKitGTK 6 in the card on Linux, with an ephemeral network session and hardware acceleration off when video is on CPU; on Windows (WebView2, `rv-native/src/windows_player.rs`) and macOS (WKWebView, `rv-native/src/macos_player.rs`) a GTK window cannot hold a native view, so the engine is laid over the card each frame and clipped to the scrolled list. A card's video keeps playing while scrolled away and back; leaving the room stops it (`cards::stop_players`, called when the message list clears).
- **SwiftUI.** `macos/Sources/RocketVibe/Player.swift`: `VideoCard` and `InlinePlayer`, a `WKWebView` loaded at rv-core's player origin, following `playerNavigation`, storing nothing. Audio and video attachments (`FileCard` in `RoomView.swift`) are copied to a temporary file first, since protected files cannot be streamed without the token, then play in a sheet (`PlayerView` in `Composer.swift`, AVKit's `VideoPlayer`), not in place as in GTK; `ImageViewer` (`Media.swift`) opens full size in its own window; pictures decode off the main thread at their drawn size and stay cached (`Pictures.swift`, `RocketVibeKit/MediaStore.swift`).

## Parity

PARITY section 3 marks images, video, audio and video-site cards done on both. The one designed difference is the video-site card: played inline on desktop, opened externally on mobile. Desktop's web engine therefore serves two uses, calls and these video cards (ROADMAP section 4.2).

## Sources

- apps/mobile/ui/ligneMessage.tsx
- apps/mobile/ui/visionneuse.tsx
- apps/mobile/ui/lecteurVideo.tsx
- apps/mobile/ui/lecteurAudio.tsx
- apps/mobile/ui/carteEmbed.tsx
- apps/mobile/ui/carteLien.tsx
- apps/mobile/ui/actionsJointe.ts
- apps/mobile/ui/barreTransfert.tsx
- apps/mobile/ui/lienExterne.ts
- apps/mobile/lib/liensVideo.ts
- apps/mobile/lib/apercuLien.ts
- apps/mobile/lib/upload.ts
- apps/mobile/lib/fichierJoint.ts
- apps/desktop/crates/rv-core/src/media.rs
- apps/desktop/crates/rv-core/src/animation.rs
- apps/desktop/crates/rv-core/src/player.rs
- apps/desktop/crates/rv-core/src/content.rs
- apps/desktop/crates/rv-gtk/src/rows.rs
- apps/desktop/crates/rv-gtk/src/media.rs
- apps/desktop/crates/rv-gtk/src/video.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/crates/rv-gtk/src/gst_stream.rs
- apps/desktop/crates/rv-gtk/src/player.rs
- apps/desktop/crates/rv-native/src/windows_player.rs
- apps/desktop/crates/rv-native/src/macos_player.rs
- apps/desktop/macos/Sources/RocketVibe/Player.swift
- apps/desktop/macos/Sources/RocketVibe/Media.swift
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/desktop/macos/Sources/RocketVibe/Composer.swift
- apps/desktop/macos/Sources/RocketVibe/Pictures.swift
- apps/desktop/macos/Sources/RocketVibeKit/MediaStore.swift
- ROADMAP.md
- brain/parity.md
