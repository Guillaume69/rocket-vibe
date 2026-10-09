# Server-delivered web client

## Mobile

The installed Android client retains its own provider, account, native notification and encryption behavior. The web client does not replace it.

## Desktop

GTK is the requested visual reference. Its fonts, palette, icons, sounds and layout inform the browser screens. GTK and SwiftUI keep multi-account/provider and encrypted-room capabilities.

## Web

A real browser application served by the native server, with one account on that origin. It provides ordinary rooms/DMs, paging, live messages/actions, threads, quotes, search, drafts, durable offline text and upload queues, protected media, recording, room/profile/member controls, administration, factors, sessions, preferences and LiveKit calls.

User decisions on 2026-10-08 explicitly exclude account/server switching and encrypted conversations. Locked room metadata remains visible. Browser notifications map foreground desktop alerts while the tab lives; closed-tab delivery is missing. HTTPS room URLs replace the native custom scheme. Browser installation/public-shell updates replace binary updates; OS tray, autostart and native keyring are absent.

The merged master bots and workflows are exposed in browser settings, with the bot-creation policy in administration. Message forms run through the same server engine, with room-scoped slash completion and guarded one-time secrets. Labels and refusal wording are generated from the desktop catalog.

Settings follow the GTK category order and icons, with profile editing in a subpage and separate server administration. Display zoom and clock switches were removed because GTK exposes neither. Language supports automatic, French and English, saved to native preferences for the next launch. Device sessions expose renaming, dates and confirmed revocation. Audio attachments provide inline playback controls. Selecting a voice channel joins automatically and shows the main call page plus live room occupants.

Incoming room messages become read after GTK's 1.5-second captured-message delay when the active document shows the latest timeline. Incoming messages schedule the read even on a short timeline with no scroll. A modal, inactive document, earlier-history position or hidden call timeline prevents it; navigation cancels the pending target. Read acknowledgments are fenced by account and membership, and older revisions cannot replace newer unread state. Reading all room messages withdraws its browser notification.

The administration Dashboard follows GTK's native overview projection and shared catalog, including elapsed uptime, migration, instance copying, four presence dots, encrypted-kind counts, upload size, open reports with Moderation navigation and the native bot-policy switch. The Deployment heading owns the refresh icon. Actual GTK/browser captures on the same native server qualify the wide and narrow dashboard; see [administration](administration.md) for evidence and remaining state qualification.

Reloading the same tab, opening another tab with its saved account and renewing the token keep the same server device family. A new password login creates another device session, so isolated browser test contexts must use dedicated fixture accounts rather than the account reserved for manual testing. The generic RocketVibe label is not a count of distinct physical machines.

The voice page ports GTK's centered 16:9 TileGrid, native six-button controls, connection status and speaking halos. The audio menu applies microphone gain and a processed-input meter through Web Audio, plus output and per-person gains up to 200 percent. Microphone processing is attached before publication. A processor failure stops capture, including a failed retry. Local mute does not change the remote person's published microphone. Person preferences live in account-scoped browser storage and are purged on signout. Device selection and browser noise constraints use the browser's capture APIs; this is not the GTK RNNoise implementation. Screen claims are ordered before call teardown, and stale callbacks cannot reopen capture. Direct calls retain the native two-second peer reconnection grace.

Speaking now uses the native PCM thresholds, decay and hangover instead of SFU hints. Deafen uses the GTK/server wire attribute. Screen sharing keeps GTK's quality choices, stage label/fullscreen placement and mini participant presentation, with the browser's consent picker for sources. Capture quality reaches both capture and encoder. Fullscreen follows takeover and closes on capture ending. Shared sound is processed before publication, rejects capture with unconfirmed own-audio exclusion and implements GTK's opt-in call mix. Browser/OS program-sound capture remains partial; see [voice](voice.md) for the actual bench evidence and fallback.

Known qualification debt: full GTK visual-state comparisons, closed-tab Web Push, offline signout replay, and exhaustive call/device/platform qualification. The detailed inventory and current evidence live in `docs/WEB_CLIENT_EXECUTION.md`. Implemented code is not a claim of complete GTK parity.

The shipping review fences reconnect snapshots, history/thread loads, action receipts, preview caching and upload preparation/completion to their captured account and membership lifetime. A room change cannot erase the new composer draft or quote. The text outbox preserves creation order and reruns when another send arrives during its worker. Personal-star revisions merge independently of message revisions. Online logout shares the renewal lock, recovers an already-committed successor if necessary and revokes that token before purging local storage; offline server revocation remains unconfirmed.

Call takeover caused by duplicate identity or participant removal clears only the old local call. Incoming acceptance catches initial connection failures and checks membership before capture. Camera capture obtained after leave is stopped before publication, pending publications are stopped during teardown, and muted cameras restore the avatar.

Media uses GTK-style inline controls, protected video posters and native human-readable file sizes. Canonical video-site cards are capped at three, and remain connected through live reactions. The provider iframe receives the serving origin as its referrer, with no room path or authenticated API header. Protected video playback, seeking, volume, fullscreen and access withdrawal are qualified with a recorded/uploaded clip that also plays in the actual GTK reference. Provider streaming itself remains unqualified because the browser suite intercepts external embeds. Browser downloads map opening a local copy in another application; see [media playback](media-playback.md).

## Sources

- apps/web/README.md
- apps/web/src/app.ts
- apps/web/src/panels.ts
- apps/web/src/voice.ts
- apps/web/src/voice-grid.ts
- apps/web/src/voice-audio.ts
- apps/web/src/voice-activity.ts
- apps/web/src/voice-share.ts
- apps/web/src/voice-share-audio.ts
- apps/web/src/security.ts
- apps/web/src/email.ts
- apps/web/src/audio.ts
- apps/web/src/video-attachment.ts
- apps/web/src/video-links.ts
- apps/web/src/video.ts
- apps/web/src/media-format.ts
- apps/web/src/image-attachment.ts
- apps/web/tests/images.mjs
- apps/web/tests/reads.mjs
- apps/web/tests/sessions.mjs
- apps/web/tests/session.test.ts
- apps/web/tests/uploads.test.ts
- apps/web/tests/app-lifecycle.test.ts
- apps/web/tests/voice-lifecycle.mjs
- apps/web/src/session.ts
- apps/web/src/uploads.ts
- apps/web/src/store.ts
- apps/web/src/dom.ts
- apps/web/tests/media.mjs
- docs/WEB_CLIENT_EXECUTION.md
- docs/rfcs/0005-web-client.md
