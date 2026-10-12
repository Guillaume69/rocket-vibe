# GTK and web screen audit

Date: 2026-10-12. Reference: the GTK client connected to a RocketVibe server. The browser retains the previously agreed single serving origin/account. The comparison covers structure, text, navigation, controls, defaults and dismissal, rather than palette similarity.

## Screen inventory and corrections

| Screen or state | GTK reference | Browser correction |
| --- | --- | --- |
| Login, invitation, recovery | `rv-gtk/src/login.rs` | Mutually exclusive account-mode checkboxes, invitation/recovery help, hidden secrets, new-password caption and consistent login column. |
| Second-factor challenge | `rv-gtk/src/login.rs` | Verification is an inline login step with Back, shield, native captions, method selection and email send/resend. Durable verification intents remain intact. |
| Startup and unavailable browser storage | Native account opening | A blocked database upgrade or unavailable storage shows localized help and Retry instead of an indefinite loading screen. Existing messages and drafts survive; current tabs release their database when a newer app upgrades it. |
| Empty conversation, header, account | `rv-gtk/src/chat.rs`, `chat_native.rs`, `chat_voice.rs` | Native marked/search/phone order and captions, encrypted tile, DM presence subtitle, plain account block with gear and explicit action menus. Native-provider toolbar visibility follows GTK; web threads remain reachable from the heading context menu and across-room search by Ctrl+Shift+F. |
| Room list, folding, unread state | `rv-gtk/src/chat.rs`, `rows.rs` | Headings/folding only with multiple nonempty groups, icon chevrons and counts, language-independent fold keys, unread preview/clock styles, badges in the second line and native day-sensitive timestamps. Right-click opens a menu before changing a favourite. |
| New conversation and room | `rv-gtk/src/chat_native.rs::native_conversation` | Direct-message and room-creation preference groups replace tabbed, nested creation. New rooms default to private. |
| Timeline and inline editing | `rv-gtk/src/rows.rs`, `message_list.rs`, `rv-core/src/timeline.rs` | Initial/day-change separators and five-minute author grouping follow the native projection; grouped minute labels avoid repetition, reply icons and edited metadata share the footer. Enter saves, Escape cancels and empty edits cannot save. |
| Composer, thread composer | `rv-gtk/src/composer.rs`, `thread.rs` | Shared pill, controls, native toolbar labels and toggling formatting shortcuts. Links edit their selected address in place. |
| Thread page and following | `rv-gtk/src/thread.rs` | Thread replaces the conversation within the content pane, with Back, following and the same composer. |
| Message actions, quick reactions | `rv-gtk/src/chat_native.rs`, `reactions.rs` | Native order, quote/reply/thread wording, copy/link controls, quick reaction state and additional-emoji entry. |
| Emoji picker | `rv-gtk/src/emoji_picker.rs` | Anchored picker, category strip, search and nine-column grid; composer selection can remain open. |
| Search, across-room search, pinned/starred, thread list | `rv-gtk/src/details.rs`, `local_search.rs`, `threads.rs` | Compact activatable previews replace full timeline rows and redundant Open buttons. |
| Room information, settings, members, invite, channel image | `rv-gtk/src/details.rs`, `details/native_rooms.rs`, `details/room_avatar.rs` | Native 420 by 600 information dialog and filled button order; a DM heading opens its peer profile. Separate settings, membership and invitation dialogs, explicit role Apply, and owner image changes with protected revisioned header/list images. |
| Profile and own-profile editing | `rv-gtk/src/details.rs`, `settings/native_profiles.rs` | Native profile geometry, photo row suffix controls, ordered fields, read-only email and grouped Save; selected images normalize to native dimensions/format. |
| Settings categories and subpages | `rv-gtk/src/sidebar_dialog.rs`, `settings.rs` | Categories retain drafts and scroll state; server-backed mutations explicitly invalidate affected pages. |
| App preferences, diagnostics and room switcher | `rv-gtk/src/settings.rs`, `logs.rs`, `spotlight.rs` | Native preference groups and captions, cached category state and Ctrl+K room navigation. Browser installation, diagnostics download and web version display retain their platform mappings. |
| Notifications and quiet hours | `rv-gtk/src/settings.rs` | Backend/test group, switch rows and quiet-hours expander with nested time rows. |
| Security, email, device sessions | `rv-gtk/src/native_security.rs`, `settings.rs` | Grouped status, inline proof/setup/acknowledgement and native action rows. Unfinished sensitive changes retain Continue/Cancel across reload, exact operation/version replay and explicit email-code direction. Accepted code bags and verified/removed receipts stay until acknowledgement; setup secrets and bags use scoped authenticated ciphertext. |
| Administration dashboard, moderation, rooms, users, invitations, emoji | `rv-gtk/src/admin.rs`, `admin_emoji.rs` | Native category order, both moderation groups, presence badges, room metadata and grouped rows. |
| Encryption, identity and device association, peers, groups, recovery and history | `rv-gtk/src/native_crypto/` | Dialog/account lifetime survives cached categories; native grouped controls and subpages, explicit device choices, typed current/previous fingerprint confirmation, inline history offers and recovery steps. Repaints replace rather than accumulate warnings. |
| Bots, workflows, triggers, steps and runs | `rv-gtk/src/settings/native_bots.rs`, `settings/native_workflows.rs` | Native descriptions, ButtonRows, expanders, proof fields and numeric limits; category mutations refresh their cached pages. |
| Send later, reminders and custom dates | `rv-gtk/src/scheduled.rs`, `reminders.rs` | Anchored scheduling choices and compact rows, native-style month calendar and numeric hour/minute fields, cancel and explicit confirmation. |
| GIFs, polls, game-night cards and sticker shelf | `rv-gtk/src/social.rs` | Existing grouped pickers/cards and social actions pass the actual-server social suite; sharing and composer controls retain the native compact geometry. |
| Files, images, video and recording | `rv-gtk/src/attach.rs`, `media.rs`, `video.rs`, `player.rs` | Existing native media layouts remain qualified by real upload/viewer/playback suites; no full message controls inside compact previews. |
| Voice page, empty/occupants, rejoin | `rv-gtk/src/call_window.rs`, `chat_voice.rs` | Room page remains after a user leaves, shows occupants/empty state and Join. Active-call/account teardown still removes private call state. |
| Connected/reconnecting/listen-only call | `rv-gtk/src/call_window.rs`, `chat_voice.rs` | Native status row, secure icon, forced listen-only mute, circular reaction control and shared reaction strip. |
| Incoming call | `rv-gtk/src/chat_call_ring.rs` | Native alert heading/body, destructive Decline followed by default Accept, replacing portrait and stacked actions. |
| Sharing stage and participant menu | `rv-gtk/src/call_window.rs`, `chat_voice.rs` | Native mini roster and volume-popover geometry; browser capture source consent remains platform-provided. |

Source paths above are relative to `apps/desktop/crates/`. Browser implementation paths and executed checks are recorded below. Additional media, social, bot/workflow, encrypted-room and scheduling dialogs are included in the regression suites rather than inferred from matching colours.

## Verification

The work uses disposable local PostgreSQL, TLS SMTP and LiveKit services and real RocketVibe API responses. Browser checks use the built production distribution rather than hot reload. A fresh GTK build passes its mandatory Fedora formatting, clippy and test gate; connected GTK captures supply the screen reference.

Strict TypeScript, formatting, the production build and all 146 Node tests pass. The full actual-server browser and authenticated-vault workflow passes in [web CI](https://github.com/Guillaume69/rocket-vibe/actions/runs/38204565043). The actual-server checks pass conversation acceptance (18), composer (8), threads (5), shell (5), reads (6), navigation (4), device sessions (4), receipts (2), offline signout (4), notifications (8), social cards (4) and video reduction (5). The shell checks hold a real older database connection, verify the English and French retry screen, preserve a saved draft through retry, and prove the current tab releases a subsequent upgrade. The expanded conversation-parity suite exercises GTK message controls, room/member dialogs, roles, DM profile navigation and channel images. It holds a committed image response through reload to prove nonce-preserving replay, then withdraws actual membership to prove pending image intents are purged. Four additional model/receipt tests hold personal-state responses through initial membership, withdrawal, removal/rejoin and newer live revisions. Settings, profiles, workflows, quiet hours, scheduling, reminders, global search, images, media and advanced capture/offline scenarios also pass their real-server suites. Security verifies TOTP and verified/removed email receipts through the local TLS SMTP service.

All twenty voice and eight voice-lifecycle groups pass real microphone/camera/screen RTP, gains, mute/deafen, incoming calls, leave/rejoin and account/access teardown against the isolated SFU. The native device/capture captions, silent chooser cancellation and listening-only claim release pass on the final embedded build. The fixture closes its own injected tone contexts and oscillators; the production two-second peer-rejoin grace is unchanged. Controlled screen/program-sound fixtures qualify processing and cleanup; physical-device audibility, operating-system loopback exclusion and platform font rasterization are not established by headless tests.

Voice-channel creation opens the connected voice page automatically, matching GTK. Its room-settings test explicitly uses the native Open the chat action before opening room information, and leaves the call through the sidebar when finished. The connected-SFU helper and all four conversation-parity groups pass with fresh unprivileged users and zero page errors; the application retains automatic joining.

The room-image lost-response fixture waits for the actual successful receipt and the client failure state before taking its baseline snapshot. The staged Resume control appears before HTTP completes and cannot establish that baseline. The fixture compares the snapshot with the receipt's applied revision, then preserves the exact operation ID and unchanged avatar version through reload and replay.

All twelve E2EE checkpoints pass against the embedded server app: identity/device review, MLS genesis and peer admission, cross-browser messages/files, private edits/quotes/threads/reactions/search, root and history backup, browser-key renewal, encrypted voice and fresh-profile recovery with separate-code history restoration. The official Linux Playwright fixture includes a disposable PulseAudio null sink and private bridge SFU; both Chromium and Firefox retain normal ICE policy and exchange real decrypted audio energy. The original Windows loopback/virtual-adapter SFU could not qualify Firefox transport. Browser vault tests separately pass reload, concurrent workers, non-extractable keys and authenticated-corruption refusal.

The encrypted-call preparation also exposed a server policy defect: a full room-settings command touched privacy/read-only columns even when only text or the voice flag changed, invalidating the accepted policy. Additive migration 0063 preserves authority for unchanged values. All ten real PostgreSQL room-details cases pass, including metadata/voice receipt replay and unique authority rotation for genuine privacy/read-only changes and reversals. The web gate now runs this target. The TLS mail fixture publishes its mailbox atomically, eliminating the truncated JSON read that failed the preceding master web CI run.

The first audit CI run also exposed fixture coupling: fast suites shared localhost's 30-login-admissions-per-minute IP window, so notifications reached a login screen showing `auth_rate_limited`. Between closed suites, the disposable workflow now releases only per-IP login windows alongside snapshot leases. Global, per-username and intra-suite limits stay active. Deliberately saturating the real localhost quota reproduces HTTP 429 with `Retry-After`; the same boundary cleanup then permits all eight real notification checks to pass against the final embedded distribution.

The server gate passes formatting, clippy with warnings denied, 220 library tests and ten room-details integration tests. One protected-worker test is intentionally delegated to its dedicated CI job. The three TypeScript pilot tests require Node 24; the Fedora fixture supplies the official test-image runtime. The rebuilt, restarted server applies migration 0063 and serves HTML and entry-asset bytes identical to the committed distribution.

Integration preserves current master's email sign-in, authenticator QR setup, per-account folds and visible security status. Migration 0062 remains the email sign-in migration; the new room-policy guard is 0063. All ten admin integration cases pass with the current migration count. The complete web and native CI workflows above qualify application source commit `82bbee8f`. The subsequent master integration preserves the published web 0.6.0, server 0.5.0, desktop 0.17.0 and mobile 0.14.0 versions; it changes version metadata and generated web chunks without changing application source. Published changelog sections remain identical to master and this audit's changes stay Unreleased. Formatting, strict TypeScript, all 146 Node tests and the production build also pass after that integration. The rebuilt server serves final HTML and entry bytes identical to the committed distribution: `index-wGzq0ckc.js`, SHA-256 `08bbbd00d1b0f96630da43d9f4aaa33950a02e3c643ff67b0d7f24a495c3a7c4`. All 34 final actual-server groups pass again against those bytes: nine conversation/shell, six security, seven pending-security and twelve visual/settings checks, with zero page errors. The final conversation capture is inspected; the suites close all browser contexts.

The integrated native-client checks exposed a suspended-account resume defect in the current master's background-session reuse. Opening a cached native session now resumes it only when paused. The same session, draft and durable outbox survive, while healthy background accounts keep their sockets. A scripted HTTP/WebSocket regression passes on Fedora and Windows, verifies one new socket after resume and exactly one acknowledged queued message, and retains the existing server-identity and closed-session fences. The final mandatory Fedora `apps/desktop/scripts/build.sh` gate passes formatting, clippy with warnings denied, all 715 tests and the workspace binary build. Its nine display-dependent GTK cases and the real PostgreSQL GTK/SwiftUI provider, media, security, email and restart checks pass in [native integration CI](https://github.com/Guillaume69/rocket-vibe/actions/runs/38204564993). [GTK checks](https://github.com/Guillaume69/rocket-vibe/actions/runs/38204565283) and [SwiftUI packaging and launch](https://github.com/Guillaume69/rocket-vibe/actions/runs/38204565004) also pass. These native corrections leave the browser source and distribution unchanged.

SwiftUI's protected media view also enforces its own closed lifetime independently of the retained background session. Closed current/cached reads, loads and new downloads are rejected, and a new download reports `session_closed` before contacting the provider or creating a destination. The existing real protected-emoji regression checks these boundaries and confirms the background account stays online.

Browser-specific mappings remain browser storage, same-origin HTTPS links, native media/capture permissions, downloads and installation. OS keyring, external-provider login, multi-account/server switching and closed-tab push are separate existing scope or platform decisions, not claims of visual equivalence.

The follow-up Security correction closes the visible pending-state gap for authenticator setup/removal, backup-code replacement, email verification/removal and both email-code directions. Seven actual-server groups against the final embedded distribution deliberately commit and then abort responses, expire only dedicated fixture proof grants, reload and recover the same receipt. Continue/Cancel preserve current account status; accepted replay precedes proof, and original request IDs prevent replacement code bags. The proof form also keeps its original operation through second-factor confirmation and labels recovery codes correctly. Normal account signout purges the sealed pending receipt and its key material. Twenty-one model/vault cases qualify save-before-request, stale/refusal semantics, authenticated nonextractable storage and held-write/read/retirement fences. The existing six Security groups also pass with real TLS SMTP delivery. The disposable Windows SMTP helper retries transient mailbox rename locks for at most one second while preserving atomic complete JSON and acknowledgement after publication.

## Sources

- apps/web/src/ui/application.tsx
- apps/web/src/ui/login.tsx
- apps/web/src/ui/rooms.tsx
- apps/web/src/ui/format.tsx
- apps/web/src/ui/messages.tsx
- apps/web/src/ui/thread.tsx
- apps/web/src/ui/menu.tsx
- apps/web/src/ui/sidebar.tsx
- apps/web/src/new-conversation.ts
- apps/web/src/room-avatar.ts
- apps/web/src/room-state.ts
- apps/web/src/ui/controls.tsx
- apps/web/src/panels.ts
- apps/web/src/preferences-controls.ts
- apps/web/src/security.ts
- apps/web/src/security-intents.ts
- apps/web/src/security-vault.ts
- apps/web/src/email.ts
- apps/web/src/admin.ts
- apps/web/src/voice.ts
- apps/web/src/ui/voice.tsx
- apps/web/src/shell-parity.css
- apps/web/src/conversation-parity.css
- apps/web/src/settings-parity.css
- apps/web/src/voice-parity.css
- apps/web/tests/conversation-parity.mjs
- apps/web/tests/shell-parity.mjs
- apps/web/tests/startup-storage.mjs
- apps/web/tests/visual.mjs
- apps/web/tests/composer.mjs
- apps/web/tests/security.mjs
- apps/web/tests/security-pending.mjs
- apps/web/tests/security-intents.test.ts
- apps/web/tests/security-vault.test.ts
- apps/web/tests/threads.mjs
- apps/web/tests/voice.mjs
- apps/server/migrations/0063_room_authority_changes.sql
- apps/server/tests/room_details.rs
- apps/web/tests/smtp.mjs
- apps/web/tests/notifications.mjs
- apps/desktop/crates/rv-core/src/native.rs
- apps/desktop/crates/rv-core/src/supervisor.rs
- apps/desktop/crates/rv-core/tests/supervisor.rs
- apps/desktop/macos/Tests/RocketVibeKitTests/NativeProviderTests.swift
- apps/desktop/macos/Sources/RocketVibeKit/MediaStore.swift
- apps/desktop/macos/Tests/RocketVibeKitTests/NativeEmojiTests.swift
- apps/server/src/limits.rs
- .github/workflows/web-client.yml
