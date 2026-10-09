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

The voice page ports GTK's centered 16:9 TileGrid, native six-button controls, connection status and speaking halos. The audio menu applies microphone gain and a processed-input meter through Web Audio, plus output and per-person gains up to 200 percent. Microphone processing is attached before publication. A processor failure stops capture, including a failed retry. Local mute does not change the remote person's published microphone. Person preferences live in account-scoped browser storage and are purged on signout. Device selection and browser noise constraints use the browser's capture APIs; this is not the GTK RNNoise implementation. Screen claims are ordered before call teardown, and stale callbacks cannot reopen capture. Direct calls retain the native two-second peer reconnection grace.

Known qualification debt: full GTK visual-state comparisons, closed-tab Web Push, offline signout replay, and exhaustive call/device/platform qualification. The detailed inventory and current evidence live in `docs/WEB_CLIENT_EXECUTION.md`. Implemented code is not a claim of complete GTK parity.

## Sources

- apps/web/README.md
- apps/web/src/app.ts
- apps/web/src/panels.ts
- apps/web/src/voice.ts
- apps/web/src/voice-grid.ts
- apps/web/src/voice-audio.ts
- apps/web/src/security.ts
- apps/web/src/email.ts
- docs/WEB_CLIENT_EXECUTION.md
- docs/rfcs/0005-web-client.md
