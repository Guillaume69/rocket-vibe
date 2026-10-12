# Server-delivered web client

## Mobile

The installed Android client retains its own provider, account, native notification and encryption behavior. The web client does not replace it.

## Desktop

GTK is the requested visual reference. Its fonts, palette, icons, sounds and layout inform the browser screens. GTK and SwiftUI keep multi-account/provider and encrypted-room capabilities.

## Web

A real browser application served by the native server, with one account on that origin. It provides ordinary rooms/DMs, paging, live messages/actions, threads, quotes, search, drafts, durable offline text and upload queues, protected media, recording, room/profile/member controls, administration, factors, sessions, preferences and LiveKit calls.

User decisions on 2026-10-08 explicitly exclude account/server switching. On 2026-10-09 the user superseded the temporary encryption exclusion and requested usable browser E2EE. Native encrypted rooms now use the shared Rust MLS engine in WebAssembly, with identity/device reviews, peer pins, group admission, private conversations/files and recovery/history controls; full state-by-state qualification remains tracked in parity. Browser vault protection differs from the native keyring; see [browser E2EE](../../docs/WEB_E2EE.md). Browser notifications map foreground desktop alerts while the tab lives, shown by the service worker with the author's photo, the message's picture, Mark as read and Like buttons acted on by a live tab, and the app's own sound ([notifications](notifications.md#web)); closed-tab delivery is missing. HTTPS room URLs replace the native custom scheme. Browser installation/public-shell updates replace binary updates; OS tray, autostart and native keyring are absent.

The merged master bots and workflows are exposed in browser settings, with the bot-creation policy in administration. Message forms run through the same server engine, with room-scoped slash completion and guarded one-time secrets. Labels and refusal wording are generated from the desktop catalog. Native general and slash-command refusal mappings are generated from the GTK controller and core command handler as well. The presentation boundary chooses translated copy for server/worker failures and safe native fallback for unknown codes or missing translations; protocol codes remain intact for recovery and diagnostics. Encrypted-room failures use the native trust/refusal taxonomy without showing a raw code paragraph.

Settings follow the GTK category order and icons, with profile editing in a subpage and separate server administration. Display zoom and clock switches were removed because GTK exposes neither. Language supports automatic, French and English, saved to native preferences for the next launch. Device sessions expose renaming, dates and confirmed revocation. Audio attachments provide inline playback controls. Selecting a voice channel joins automatically and shows the main call page plus live room occupants.

Incoming room messages become read after GTK's 1.5-second captured-message delay when the active document shows the latest timeline. Incoming messages schedule the read even on a short timeline with no scroll. A modal, inactive document, earlier-history position or hidden call timeline prevents it; navigation cancels the pending target. Read acknowledgments are fenced by account and membership, and older revisions cannot replace newer unread state. Reading all room messages withdraws its browser notification.

The administration Dashboard follows GTK's native overview projection and shared catalog, including elapsed uptime, migration, instance copying, four presence dots, encrypted-kind counts, upload size, open reports with Moderation navigation and the native bot-policy switch. The Deployment heading owns the refresh icon. Actual GTK/browser captures on the same native server qualify the wide and narrow dashboard; see [administration](administration.md) for evidence and remaining state qualification.

Reloading the same tab, opening another tab with its saved account and renewing the token keep the same server device family. A new password login creates another device session, so isolated browser test contexts must use dedicated fixture accounts rather than the account reserved for manual testing. The generic RocketVibe label is not a count of distinct physical machines.

The voice page ports GTK's centered 16:9 TileGrid, native circular call controls, connection status and speaking halos. Manual Leave retains the room's call preview and Join action; account/access teardown clears it. The audio menu applies microphone gain and a processed-input meter through Web Audio, plus output and per-person gains up to 200 percent. Microphone processing is attached before publication. A processor failure stops capture, including a failed retry. Local mute does not change the remote person's published microphone. Person preferences live in account-scoped browser storage and are purged on signout. Device selection and browser noise constraints use the browser's capture APIs; this is not the GTK RNNoise implementation. Screen claims are ordered before call teardown, and stale callbacks cannot reopen capture. Direct calls retain the native two-second peer reconnection grace.

Speaking now uses the native PCM thresholds, decay and hangover instead of SFU hints. Deafen uses the GTK/server wire attribute. Screen sharing keeps GTK's quality choices, stage label/fullscreen placement and mini participant presentation, with the browser's consent picker for sources. Capture quality reaches both capture and encoder. Fullscreen follows takeover and closes on capture ending. Shared sound is processed before publication, rejects capture with unconfirmed own-audio exclusion and implements GTK's opt-in call mix. Browser/OS program-sound capture remains partial; see [voice](voice.md) for the actual bench evidence and fallback.

The 2026-10-12 screen audit uses running Fedora GTK as the presentation and interaction reference. New message opens the native people/public-channel spotlight before the separate Create room form. Marked messages retain the Pinned/My starred header and narrow bottom sheet. Scheduling/reminders share the native headerless calendar, locale weekday order and wrapping time controls. Social forms/cards, image shelf, workflow steps and the complete room command catalogue follow their native counterparts. The final inventory and qualified execution evidence live in `docs/WEB_GTK_FINAL_VERIFICATION.md`, supplementing `docs/WEB_GTK_SCREEN_AUDIT.md`; its 41 route/control families are distinct from conditional source records. Browser rasterization and native OS permissions remain platform mappings; closed-tab Web Push and exhaustive physical-device/platform qualification remain separate debt.

Quoting between ordinary and MLS conversations uses the existing protected reference contract in every direction. Reader-authorized private excerpts remain volatile and never enter the ordinary model, draft, outbox or snapshot. Passive cards render native Markdown and bounded nested quotes; only ordinary source attachments obtain public descriptors, matching GTK. Private search opens compact previews, loads older retained history and activates its room jump or thread. Account, room, membership, revision and admission fences retire stale readers. See [private message actions](e2ee-private-actions.md) and [search](search.md).

Message avatars and author names open the GTK-sized profile card. Its native identity, BOT owner, live status, Message/Call/Report actions, own-card exclusions and narrow layout follow `details.rs`. Live revisions refresh the card, expired observations clear presence, and missing leases in a complete observation mean Offline. Browser presence renews every 20 seconds while connected and clears on orderly shutdown. Profile DM actions fetch the personal read/access state before navigation. Bios and room texts render safe Markdown; see [room info and profiles](room-info-and-profiles.md).

The shipping review fences reconnect snapshots, history/thread loads, action receipts, preview caching and upload preparation/completion to their captured account and membership lifetime. A room change cannot erase the new composer draft or quote. The text outbox preserves creation order and reruns when another send arrives during its worker. Personal-star revisions merge independently of message revisions. Online logout shares the renewal lock, recovers an already-committed successor if necessary and revokes that token before purging local storage. When the server cannot be reached, the purge still happens and only the token waits in the `logouts` store for a replay at the next start or when back online ([login-and-servers](login-and-servers.md#web)).

Local data follows the native apps: the persisted model keeps 500 messages per room after the session catch-up ([offline-and-sync](offline-and-sync.md#web)), Ctrl+Shift+F finds words across the rooms this browser holds ([search](search.md)), and Settings > App > Diagnostics downloads recent client-side events in place of a logs folder ([settings](settings.md#web)).

Call takeover caused by duplicate identity or participant removal clears only the old local call. Incoming acceptance catches initial connection failures and checks membership before capture. Camera capture obtained after leave is stopped before publication, pending publications are stopped during teardown, and muted cameras restore the avatar.

Media uses GTK-style inline controls, protected video posters and native human-readable file sizes. Canonical video-site cards are capped at three, and remain connected through live reactions. The provider iframe receives the serving origin as its referrer, with no room path or authenticated API header. Protected video playback, seeking, volume, fullscreen and access withdrawal are qualified with a recorded/uploaded clip that also plays in the actual GTK reference. Provider streaming itself remains unqualified because the browser suite intercepts external embeds. Browser downloads map opening a local copy in another application; see [media playback](media-playback.md).

## Sources

- docs/WEB_GTK_SCREEN_AUDIT.md
- docs/WEB_GTK_FINAL_VERIFICATION.md
- apps/web/src/new-conversation.ts
- apps/web/src/time-picker.ts
- apps/web/src/crypto/ordinary-quotes.ts
- apps/web/src/crypto/quote-sources.ts
- apps/web/src/ui/quote-card.tsx
- apps/web/tests/private-quote-search.mjs
- apps/web/src/markdown-text.ts
- apps/web/src/ui/format.tsx
- apps/web/README.md
- apps/web/src/app.ts
- apps/web/src/notifications.ts
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
- apps/web/src/logouts.ts
- apps/web/src/local-search.ts
- apps/web/src/diagnostics.ts
- apps/web/src/dom.ts
- apps/web/src/ui-errors.ts
- apps/web/src/native-i18n.ts
- apps/web/tests/ui-errors.test.ts
- apps/web/tests/translated-errors.mjs
- apps/web/tests/media.mjs
- docs/WEB_CLIENT_EXECUTION.md
- docs/rfcs/0005-web-client.md
