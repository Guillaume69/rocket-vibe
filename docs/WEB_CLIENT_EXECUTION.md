# Web client execution

Reference: [RFC 0005](rfcs/0005-web-client.md). Direction selected on 2026-10-08: a real browser client, delivered by the RocketVibe server, with GTK as the visual reference.

Current state: real application implemented and embedded in the server. One serving origin/account; encrypted conversations explicitly unsupported. Statuses below describe native RocketVibe equivalents, not Rocket.Chat endpoint support.

## Construction and qualification

- [x] Dedicated worktree and branch; native server serves the built application.
- [x] Actual Fedora GTK reference build/capture; shared theme, fonts, icons, emoji and sounds.
- [x] Single-origin authentication, factors, live model, browser state and durable queues.
- [x] Ordinary rooms, threads, actions, search, files, recording, management and settings.
- [x] Browser LiveKit calls and security flows exercised against local services.
- [x] Brain, changelog and continuous browser build/test workflow.
- [ ] Full GTK visual-state comparison and all remaining per-row qualifications.
- [x] Browser DOM composer with GTK inline draft styling, selection, undo/redo and cursor-line markers.
- [ ] Offline signout replay and closed-tab Web Push.

The inherited inventory below retains the GTK feature descriptions. A native browser equivalent uses the native protocol, not the endpoint named for Rocket.Chat. "done" is implementation status; qualified scenarios are listed separately. This branch does not claim all GTK parity is complete.

## Master integration

The web branch includes master `a5462516` (desktop 0.12.1/mobile 0.9.0), including Mattermost/kChat from `27900c7d` and bots/workflows from `fdef824c`. The 0.12.1 release carries the same SwiftUI sidebar type correction qualified on this branch by macOS CI. External-provider login and sidebar settings remain outside the serving-origin browser scope. Browser screens follow `native_bots.rs`, `native_workflows.rs` and `workflow_forms.rs`; categories, labels and refusals use the shared desktop catalog. The merge preserves the server web delivery module alongside the workflow module and all main parity rows. The browser RFC is now 0005, leaving 0003 for bots and 0004 for workflows. New feature implementation is distinguished from comprehensive GTK qualification below.

## Verification evidence

On 2026-10-09 the isolated server serves the final embedded bundle on loopback; its returned HTML matches the built bundle. Two builds produce identical hashes for all 25 assets. The continuous browser gate now covers 85 scenarios: 18 conversations, eleven advanced media/permission/capture cases, four dedicated video cases, four image/staging cases, 20 voice cases, three session cases, one synthetic locked-room case, six editor cases, six TLS email/TOTP cases, seven visual/settings cases and five bot/workflow cases. The complete 82-case image gate passed in CI; the staging/recording update adds original/reduced sending, ordered single-caption batches, cancellation and constructor/start failure cleanup. Twenty-five Node model/API/composition/workflow/grid/audio-activity/video tests pass. The mandatory Fedora GTK fmt/clippy/tests/build gate passes on master `a5462516`, desktop 0.12.1; after a memory-related interrupted link, its affected test artifact was regenerated and the full gate repeated successfully. The server's three web-delivery routing tests pass; its unchanged library previously passed 200 tests with one intentionally ignored and clippy with warnings denied. The locked-room case proves UI exclusion, not cryptographic behavior.

The final 85-case continuous browser gate passes on `f9e2ec5f`, along with the 25 Node tests, server fmt/clippy/library tests and committed-bundle reconstruction: [CI evidence](https://github.com/Guillaume69/rocket-vibe/actions/runs/37882454270). Local production verification repeats the 37 affected conversation, capture, image/staging and video cases against the exact embedded bundle. The source and committed assets are unchanged by this evidence-only documentation update.

The actual connected GTK settings and root-window audio menu are captured against the same server. A GTK session built from the latest master receives the browser's real screen stream and publishes a microphone stream back; its stage and the browser's are captured. This proves native/browser interoperability, not physical-device audibility. The voice gate qualifies actual microphone/camera/screen RTP, capture and encoder cadence at 720p/30 fps, native tile/mini presentation, quiet PCM speaking halos, real gains/local mute/deafen, ring/decline/accept, the two-second direct-call grace, takeover while fullscreen, capture-ended cleanup, delayed screen claims and microphone processor failure/retry. The native Voice preferences expose styled device rows and switches, with no invented display options.

Shared sound rejects an unconfirmed own-audio exclusion before publication. The native opt-in call mix is qualified through actual shared-sound RTP and deafen. A controlled program-sound fixture marks its exclusion explicitly and qualifies processing and cleanup; it does not prove browser operating-system loopback exclusion. Browser-native noise suppression differs from GTK RNNoise. Remaining voice debt includes platform program-sound capture, physical-device switching and noise qualification. Full GTK visual-state comparison, closed-tab Web Push and offline signout replay remain separate debt; implemented code does not establish complete GTK parity.

The media fixture is a real browser-recorded protected clip, uploaded through the file chooser and played in both Chromium and actual GTK. The four browser cases qualify the 16:9 poster, play/pause/seek/volume/fullscreen, connected-player retention through live reactions, canonical three-card video-site detection and membership withdrawal while fullscreen. Provider responses are intercepted to qualify origin-only referrer identity and iframe-document retention; vendor streaming itself remains unqualified. The native and web controls captures are compared on the same file.

The four image/staging cases qualify GTK inline limits/crop and attachment title, full-size and small-image viewer geometry, closing from empty margins, PNG export/download, live reaction retention and withdrawal closing/clearing the viewer. Actual GTK inline, viewer and root-window context-menu captures use the same original files. The staged thumbnail/Original-quality row and recording controls are also captured in real GTK through its official smoke fixtures. Browser tests verify parked quality, original PNG preservation, real JPEG reduction to 1920x960, file order and a first-file-only caption. Cancel and controlled recorder-constructor/start failures release actual capture tracks. The generated full-size clipboard PNG is intercepted, preserving the user's OS clipboard; actual OS clipboard permission integration remains unqualified. Opening another application maps to downloading the PNG.

The active worktree and bench are on `D:/RocketVibe/.cache/worktrees/web-client`, branch `codex/web-client`. Browser binaries/profiles/temporary files, object storage and PostgreSQL fixtures are on D:. The old managed checkout on C: was archived and its remaining directory removed. These are local bench paths, not deployment settings.

## Voice connection regression

The 2026-10-09 voice-connection regression adds three scenarios to the 85-case gate. Local verification against the exact embedded server bundle passes all 20 existing voice scenarios, plus Firefox/Chromium automatic joining, bidirectional audio RTP and both live occupants; an actual ICE timeout with the native error and released context; and successful retry receiving the peer's audio. The 25 Node tests, formatting, TypeScript and embedded server build pass. Behavior/test commit: `a645c0f3`. The expanded 88-case continuous gate passes: [CI evidence](https://github.com/Guillaume69/rocket-vibe/actions/runs/37900515407).

The Windows SFU now uses the official checksummed LiveKit 1.13.8 Windows binary on D:. Its API remains 127.0.0.1:17880; only the explicitly approved audio UDP 17882 listener binds 192.168.1.47. RTC TCP is disabled and the interface filter excludes other addresses. Its configuration and PID are `.cache/livekit-native.yaml` and `.cache/livekit-native.pid`; the prior loopback Docker SFU is stopped. The browser retains its ordinary preferences. The previous Firefox attempt reached the WebSocket but failed ICE through the loopback media configuration; Chromium-only checks had missed it. These are disposable bench settings, not production settings.

## Bot identity regression

The workflow BOT regression on `36f32703` preserves `User.bot` in the server's live profile projection. Both the native bot integration assertion and the real workflow browser scenario failed before the correction and pass afterward. The browser waits for two actual socket profile refreshes and retains the message badge after reload. All six workflow scenarios pass against the updated embedded server. Server formatting, clippy with warnings denied and the library gate pass locally: 200 passed, one intentionally ignored. The 89-case browser gate and native bot projection integration test pass in [CI](https://github.com/Guillaume69/rocket-vibe/actions/runs/37901957899).

## Observed-read and device-session regressions

The 2026-10-09 read regression failed against the preceding embedded bundle: a new message fitting in the already-open timeline stayed unread because no scroll occurred. The corrected scheduler passes six actual-server scenarios: ordinary no-scroll arrivals, a real command workflow's bot message, a settings dialog withholding reads, inactive visibility and notification withdrawal, navigation canceling a pending read, and earlier history withholding unseen arrivals. It also covers sending the command through the button, which temporarily clears browser keyboard focus. Headless browser tabs stay active after `bringToFront`, so the inactive cases inject document visibility events and notification objects; actual OS background notification delivery remains unqualified. All 18 existing conversation cases pass against the final embedded bundle.

The session suite now has four cases and checks the server's actual device list before and after a same-tab reload, accepted rotation with a lost response, recovery and simultaneous two-tab renewal. The device IDs and current device remain unchanged. Repeated fresh test logins create separate device families; local automation uses fixture accounts separate from manual test accounts. The updated continuous gate includes 96 browser cases, with 25 Node cases and the server gate unchanged.

## GTK inventory

GTK baseline is inherited, not a new verification claim. Web status refers to the native provider; mappings and exclusions follow the accepted origin/account/encryption scope.

| Feature | GTK baseline | Web | Evidence or debt |
|---|---|---|---|
| Server + username/email + password login (`POST login`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| 2FA: TOTP, password (SHA-256) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| 2FA by email: send and resend the code | partial | done | Native provider: see [web implementation](../apps/web/README.md). |
| Session in the system keychain, resumed at launch; a 401 on an authenticated call signs out | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Server probe before login (`/api/info`, `settings.public`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Choose the server type at sign-in (automatic, Rocket.Chat, RocketVibe) | done | n/a | One account on the serving origin, explicit user decision. |
| Known servers offered on the login screen | done | n/a | One account on the serving origin, explicit user decision. |
| Several servers side by side, switch without signing out | done | n/a | One account on the serving origin, explicit user decision. |
| Server rail: a button per account, "+" to add one, a dot on another account with unread | done | n/a | One account on the serving origin, explicit user decision. |
| Several accounts on the same server | done | n/a | One account on the serving origin, explicit user decision. |
| Sign out: `logout` sent, keychain item and local data removed | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Replay of a sign-out that failed offline | missing | missing | No browser implementation yet. |
| Rooms sorted by last activity, live (`rooms.get`/`subscriptions.get` deltas, `rooms-changed`/`subscriptions-changed`) | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Avatar, name, preview, unread badge | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Time of the last message and an `@n` badge on mentions | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Encrypted rooms: padlock tile, "Encrypted message" preview | partial | done | Locked metadata; no encrypted content or sending. src/app.ts. |
| Sync indicator while connecting or loading | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Sections: Unread, Favourites, Channels, Direct messages | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Presence dot on DMs (`users.presence`, `user-status`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| System and video-call messages translated in previews | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| New conversation: `spotlight`, open a DM (`im.create`), join a channel (`channels.join`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Rocket.Chat: create a channel or a private group (`channels.create`, `groups.create`) | missing | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Unread total on the app | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| History with paging on scroll up, live messages and edits, live deletions | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Author grouping (5 min), day separators, time | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Mark as read on open and while viewing | done | done | Captured 1.5-second root reads including no-scroll bot arrivals; six actual-server scenarios in tests/reads.mjs. Inactive visibility is controlled; actual OS background delivery remains separate qualification. |
| Edited marker, sending state, failed with retry | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Markdown from the server's `md`, local parse as fallback | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| `mailto:` links open | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Mentions of me highlighted apart from other mentions | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| `:shortcode:` emoji (6222 codes, same table) and custom emoji images | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Images inline (original), viewer, protected-file token only to our origin | done | done | Actual GTK inline/viewer/menu comparison on the same originals. PNG export, live retention and withdrawal in tests/images.mjs; clipboard payload intercepted, OS clipboard permission unqualified. |
| Photo avatars over gradient tiles, updated live | partial | done | Native provider: see [web implementation](../apps/web/README.md). |
| Read-only rooms: no composer | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Header: room info, DM presence, search in room, start a call | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| New-messages bar at the first unread | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Pill over the list jumping to the first unread while it is above the view | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Typing indicator (`user-activity`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Mentions open the profile | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Link previews from `message.urls` | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| YouTube / Dailymotion / Vimeo cards | done | partial | Canonical native-style cards, protected thumbnails, origin-only identification and live retention qualified with intercepted providers. Real vendor streaming remains unqualified. |
| Video and audio attachments, voice messages (player) | done | done | Real protected clip, native controls, seek/volume/fullscreen, live retention and membership withdrawal in tests/media.mjs; same clip plays in actual GTK. Inline audio in tests/features.mjs. |
| Other files: download, open | done | mapped | Protected local-copy download maps the native default-application action. Browsers cannot directly launch arbitrary installed applications. |
| Quotes as cards (nested up to 2) | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| System messages, the full translated set | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Video-call message card with Join | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Reactions row, toggle (`chat.react`) | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Thread chip opens the thread | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Upload strip: progress, waiting, failed with retry or discard | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Encrypted rooms: locked state, "Unlock to read" | done | done | Locked metadata; no encrypted content or sending. src/app.ts. |
| Send through the outbox, retry | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Enter sends, Shift+Enter new line | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Drafts per room and thread | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| `@` mention completion (recent authors, `@all`, `@here`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| `:` emoji completion | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Emoji picker (search, categories) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Formatting toolbar and live styling | done | done | DOM editor, GTK span styles and cursor-line markers; tests/composer.mjs. |
| Spell check | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Up arrow in an empty field edits my last message | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| List continuation on Enter | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Reply with quote (permalink prefix) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Attach files | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Pre-send preview with captions and quality | done | done | GTK thumbnail/type/size, parked Original choice and full-size preview. Real 1920/82 JPEG reduction, atomic ordered batch and one caption; tests/images.mjs. |
| Reduce photos before sending | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Reduce videos before sending (H.264 720p) | missing | missing | No browser implementation yet. |
| Checks against `FileUpload_MaxFileSize` and `FileUpload_MediaTypeWhiteList` | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Two-step upload (`rooms.media`, `rooms.mediaConfirm`) with progress | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Voice recording | done | done | Actual GTK recording bar capture; elapsed/cancel/stop, inline staged replay, real capture cancellation and constructor/start failure cleanup in tests/features.mjs. |
| Replay and caption a voice message before sending | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Slash commands (`commands.list`, `commands.run`) and their private answers | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Slash commands on a RocketVibe server (`/api/v1/commands`), text commands written by the client so they work in encrypted rooms | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Every command listed after `/` in a titled panel, narrowed as one types, completed with a tap or Tab/Enter | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Quick reactions and removing mine | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| React with any emoji (picker from the menu, the server's custom emoji included) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Report a message to the administrators (`chat.reportMessage`, RocketVibe `reports`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Reply (quote), reply in thread | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Copy text | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Share an attachment | mapped | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Edit within the server's time limit and permissions (`chat.update`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Delete (`chat.delete`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Confirmation before deleting | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Pin (`chat.pinMessage`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Pinned and starred lists, jump to the message | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Jump to a message of any age (the history around it) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Thread view: root and replies, live, composer targeting the thread | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Files and voice messages in a thread | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| List of a room's threads, following a thread, "also send to the room" | missing | missing | No browser implementation yet. |
| Search messages in the room (`chat.search`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Open a result at its message | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Search across rooms | missing | missing | No browser implementation yet. |
| Room info (`rooms.info`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Favourite a room | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| User profile (`users.info`), Message and Call buttons | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| My profile: avatar, status, name, bio, email and username (with password and 2FA) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Remove my photo (`users.resetAvatar`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Live avatar changes (`updateAvatar`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Report a user from the profile (`moderation.reportUser`, RocketVibe `reports`) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Room members, room settings, roles | missing | done | Native provider: see [web implementation](../apps/web/README.md). |
| Settings in categories (account, notifications, language, voice, encryption, security, devices, accounts, app), each shown only with content, Sign out under them | done | done | Native category order/icons, conditional content, profile subpages and separate administration are compared with actual GTK. Server provider/account switching and encryption are excluded by scope. |
| A click or tap outside a modal (dialog, alert, confirmation, sheet, overlay) closes it like Cancel, never running its action | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Profile card, notification preference, language, E2EE status, account, server | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| French and English, automatic by default | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Accounts list in settings | done | n/a | One account on the serving origin, explicit user decision. |
| Notification check | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| App version in settings | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Logs folder | done | missing | No browser implementation yet. |
| New versions | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| DMs and mentions notified, click opens the room | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Reply from the notification | done | missing | No browser implementation yet. |
| Nothing of encrypted rooms' content | done | done | Locked metadata; no encrypted content or sending. src/app.ts. |
| Running with the window closed, starting at login | done | partial | Installable public shell; closed-tab Web Push and OS autostart absent. |
| Unlock with the E2E password, decrypt messages and previews, lock again | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Room keys AES-128 and AES-256 | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Send, edit and answer in a thread, encrypted | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Encrypted files, both directions | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Key kept across launches | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Create an encrypted room | missing | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: create an encrypted room (MLS group): prepare the device for invitations, review and confirm creation, admission and device changes | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: a new device asks for history, another device of the account reviews and shares it, the new device imports it ([e2ee-history](features/e2ee-history.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: history backup with a separate code (enable, join, continuous upload, restore) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: edit and delete own private messages, pending on the target until accepted ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: react to private messages, pending on the target until accepted ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: search an encrypted room on the device ([e2ee-private-actions](features/e2ee-private-actions.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: send and open encrypted files in private rooms ([e2ee-private-files](features/e2ee-private-files.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: storage key renewed every 30 days and on request, old keys destroyed ([e2ee-storage-keys](features/e2ee-storage-keys.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: hand control of the account to another device with a history share ([e2ee-delegation](features/e2ee-delegation.md)) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| RocketVibe server: recovered history shown in conversations | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| Start and join a Jitsi call (`video-conference.start`, `.join`), Rocket.Chat servers | done | n/a | Native RocketVibe origin only; calls use LiveKit. |
| Meeting information: the link without the token (`video-conference.info`) | done | n/a | Native RocketVibe origin only; calls use LiveKit. |
| Voice channels: speaker mark, entered on selection, writable | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| People connected under each room of the list, ring lit while speaking in your session | done | done | Native identifier-based avatars, room occupants, PCM speaking halos and person menus. Real GTK/browser interop and two-browser voice tests. |
| Voice screen: a tile per person sharing all the room, glowing while they speak, chat one step away | done | done | GTK TileGrid geometry, connected header, speaking halo and chat navigation are implemented. Compared to actual GTK captures and qualified against a native GTK audio stream. Further camera/share layouts remain separate debt. |
| Who speaks told from the sound itself, a whisper included | done | partial | Local/remote PCM thresholds, normalized meter decay and 350 ms hangover are ported from GTK and qualified with quiet real RTP. Browser noise suppression has no RNNoise voice-probability path. |
| "Voice connected" panel: mute, deafen, leave | done | done | Native controls and labels, real microphone mute and playback deafen, tested through LiveKit/Web Audio with restored individual gains. |
| Call from any room's header (joins its voice) | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Direct call rings the other member, accept or decline, original ringtone | done | done | Browser tests exchange actual audio after acceptance, verify decline stops the caller, and prevent delayed acceptance from reopening media after signout/signin. Original ring sounds in src/voice.ts. |
| Call rows show the outcome (missed, declined, duration) and call back | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Create a voice channel | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Turn a room into a voice channel or back (room settings, owners) | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Choose the microphone and speakers | done | partial | LiveKit implementation in src/voice.ts; audio/video/mute/rejoin qualified, exhaustive device/ringing/share qualification remains. |
| Call menu beside the microphone: devices, input and output volume, input level, noise remover, deafen | done | partial | Native menu entries implemented; real input/output gains, meter and deafen qualified. Browser-native suppression differs from GTK RNNoise; the idle menu is compared to a real GTK root capture; physical device switching and noise qualification remain. |
| Someone's volume here (0 to 200 %), or muted for oneself only, kept | done | done | Actual Web Audio gain and local-only mute, retained across rejoin in account-scoped storage; qualified in apps/web/tests/voice.mjs. |
| Noise remover (RNNoise) on the microphone, on by default | done | partial | Browser-native noiseSuppression is implemented and on by default. GTK uses nnnoiseless/RNNoise; matching the engine and qualifying physical capture remain debt. |
| Camera and one screen share per room, a new share replacing the current one | partial | done | Actual camera/screen RTP, stage/camera thumbnails and SFU takeover stop previous capture/sound. apps/web/tests/voice.mjs; actual GTK receiving the browser share is captured. |
| Choose what to share (a screen or a window) and its quality | done | mapped | Browser consent picker supplies screen/window selection, as GTK Wayland delegates to its portal. Native resolution/cadence choices reach capture and sender; actual 720p/30 fps qualified. |
| A shared screen full screen | done | done | Native exit/double-click affordance, follows actual SFU takeover and closes on capture-ended events. apps/web/tests/voice.mjs. |
| Direct call: the other person leaving hangs up here, and the chat comes back | done | done | Actual two-browser call test verifies automatic hangup and chat restoration on peer departure. |
| A shared screen's sound, without the call's voices unless asked | partial | partial | Verified own-audio exclusion gates program-sound publication; otherwise video only. Native opt-in call mix and deafen are qualified over real RTP. Controlled program-sound fixture qualifies processing/cleanup; browser OS-loopback exclusion and platform capture remain debt. |
| Voice in encrypted rooms (end-to-end encrypted frames) | done | n/a | Encrypted rooms explicitly excluded by the user, 2026-10-08. |
| `rocketvibe://room/<rid>?host=` opens the room | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Share files and text into a room from other apps | mapped | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Local SQLite per (server, account), screens read the database | done | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Text outbox surviving restarts, retry on reconnection | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Reconnection with back-off, dead-socket probe, catch-up after the subscriptions are armed | done | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| Rooms deleted server-side purged locally | partial | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |
| `chat.syncMessages` catch-up of edits and deletions | partial | mapped | Native browser storage/HTTP/socket, HTTPS links, downloads and live-tab alerts; see web-client.md. |
| Message retention (500 newest per room) | missing | missing | No browser implementation yet. |
| Server administration for an administrator only: Dashboard (deployment, latest published version, users, rooms, messages, uploads, open reports; on Rocket.Chat the dated cached figures, refreshed on demand) | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Moderation: reported messages and accounts, reasons, dismiss, delete the message, deactivate the author or account | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Rooms list: every room, direct conversations, discussions and teams included, searched by the server | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Users list with actions: admin right, activation, deletion (confirmed); none on my own account | done | done | Native provider: see [web implementation](../apps/web/README.md). |
| Deleted RocketVibe account shown as "Deleted user" (author, reactions, quotes, notifications) | partial | partial | Implemented native browser equivalent requires row-specific GTK qualification; see docs/WEB_CLIENT_EXECUTION.md. |

## Sources

- brain/parity.md
- docs/protocol/PARITY.md
- apps/desktop/crates/rv-gtk/src
- apps/desktop/crates/rv-core/src/native
