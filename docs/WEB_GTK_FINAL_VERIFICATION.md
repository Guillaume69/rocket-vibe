# GTK and browser verification, 2026-10-12

GTK is the visual and interaction reference for the RocketVibe-server browser client. This record supplements the earlier [screen audit](WEB_GTK_SCREEN_AUDIT.md) and the [41-family screen matrix](WEB_GTK_SCREEN_MATRIX.md). It separates inspected screens, executed behavior and platform mappings; a source-inventoried refusal state is not a separately tested screen.

## Corrections found by the final sweep

- New message opens GTK's people/public-channel search before the separate Create room form. Search is debounced, people precede channels, and stale replies cannot replace a newer query or account.
- Social chooser, poll/event forms and cards, reusable-image shelf, image Save feedback, room invitations, workflow step buttons, command completion and settings typography follow actual native layouts and labels.
- Marked messages use the native Pinned/My starred header switcher. Scheduling and reminder pickers use the headerless alert, locale calendar, separate month/year navigation and wrapping time spin controls.
- Bot details use the username and disable photo removal when no photo exists. Email-code status remains visible before verification and throughout pending changes and original receipts. Security follows the actual native row order, with QR/key and code-bag extras beneath their actions; unfinished operations retain Continue/Cancel.
- Slash paths, unknown names and quoted commands remain messages. Recognized text commands pass through MLS in private conversations. Command results and catalogues belong to the current room membership/account.
- Server, crypto-worker and local failure notices use the translated GTK catalog instead of technical codes. Native general and command refusal mappings are generated from their source handlers. Unknown codes and missing translations use readable fallback copy; diagnostics retain the original error.
- Factor sign-in follows the real native captions, method selector, spacing and Confirm button. An accepted operation can resume with a blank code; email delivery resumes the original receipt before a resend. Login intents use authenticated account/challenge-bound ciphertext and are retired on Back, acceptance or account closure.
- Incoming calls require an explicit answer; caller cancellation and account teardown retain their own closure paths. Presence choices include the four native circles, completion includes emoji previews, and grouped entries/composer controls retain native focus and sizing.
- Cross-conversation quoting preserves current references across ordinary and encrypted destinations. Protected excerpts stay in the live authorized reader; ordinary storage/authoring retains references. Passive quote cards render native Markdown, two nested levels and reader-authorized ordinary file descriptors.
- Native workflow changes refresh the current GTK command catalogue immediately. New native DM/channel membership navigates only after authoritative synchronization and cannot override a newer user choice. Private history follows its oldest-position cursor and keeps the newer page. Hidden GTK stack pages no longer dictate authentication-page sizing.

## Verification method

The GTK app runs from the required Fedora build with real libadwaita, Xvfb and an unlocked task-owned Secret Service. Wide captures use 1280 by 900, narrow captures use 390 by 844, and English/French routes are inspected. Browser checks use real HTTP/WebSocket/PostgreSQL, protected files, TLS SMTP and LiveKit. Dedicated fixture actors preserve the manual-test accounts and server data.

The source inventory covers 41 distinct route/control families and groups their conditional states under their actual screen families. Layout inspection is separate from feature execution. Browser and native happy paths are accompanied by focused stale-answer, original-receipt, membership-withdrawal, teardown and retry checks where those affect the changes.

## Completed integrated checks

Actual GTK and normal-policy Windows Firefox exchange audio and camera RTP. Native microphone mute/unmute, deafen/undeafen, per-person mute/volume, camera toggles, source/quality picker, screen publication and Leave are exercised. Firefox receives two native video streams with more than 2,000 decoded frames each and positive decoded audio energy. Both peers appear in the real native/browser rosters, and browser Leave closes all peer connections. Synthetic capture proves media transport and UI behavior; it does not establish physical-device audibility.

Separate real native Security, email-factor settings and email-OTP login pilots run across fresh GTK processes and assert PostgreSQL oracles. Their accepted proof/delivery/code-bag identities survive restart and response recovery. Native protected-file staging, rendering, reader/quote handling and GTK/browser MLS admission and messages have independent real-process checks.

The immutable ByN distribution passed fifteen changed-area browser suites, comprising 83 executed groups, plus the normal-policy Chromium/Windows Firefox voice-connection suite and the browser-vault harness. Those results qualify the changed conversation, social, workflow, scheduling, reminder, settings, security and media paths at that asset revision. Protected quote/history checks run independently; an earlier interrupted run is not counted as a completed suite.

The immutable D5 error/authentication candidate is served on the task-owned staging origin at port 3420. Its index-D5zRvP4J.js, index-D4vBUS8J.css and service worker match the built bytes exactly. Six factor-login groups, six legacy Security groups and twelve feature groups pass, including actual bilingual server conflicts and future unknown-code notices. Sixteen masked MFA and four roster captures cover English/French wide/narrow routes, with zero browser errors.

The subsequent index-CuqJbBSR.js contains one further own-property guard for unknown authentication error names; it retains the exact same CSS bytes. Its format check, strict TypeScript build and 164 unit tests pass. Final delivery and a focused unknown-code replay qualify this last delta separately.

The committed index-COv4Cf-K.js then adds identity-backup proof renewal: an expired proof during root-backup publication asks for the password and resumes the original encrypted packet. The enlarged E2EE run had failed its fresh-profile restoration for this reason. Strict TypeScript, 164 unit tests and the actual-server `tests/crypto-recovery.mjs` pilot (three scenarios, zero page errors) pass on this source.

The required Fedora desktop gate passes all 715 tests. Thirteen display-dependent GTK cases run separately under Cairo/Xvfb with real mapped widgets, including native creation/navigation, narrow login forms, non-dismissible incoming calls and the Windows-shadow profile. Additional actual native pilots cover protected files, microphone recording through Send, account addition/cancel/refusal, two-account switching, per-account drafts and logout preserving another healthy account.

Earlier C6 CI passed all 34 actual-server browser suites, the vault harness and native integration. It remains historical evidence. Final-source CI and the enlarged encrypted-history pilots are tracked separately; they are not silently relabeled as completed by that baseline.

## Windows voice-to-text crash

The installed Windows 0.16.0 crash reports an access violation in Cairo immediately after a failed CreateDIBSection and the GTK A8 blur assertion. An isolated helper using the installed GTK 4.24.1/Cairo 1.18.6 DLLs reproduces the same cairo_set_source_rgba fault location when its own mask allocation fails. It does not modify installed files or another process.

The GTK fix applies only to an actual Windows Cairo renderer after realization. Speaking borders and green rings, plus pink button feedback, use finite zero-blur shadows; GL/Vulkan and other platforms retain the existing stylesheet. The helper's positive regression confirms preserved colored pixels without further A8 blur-mask allocation. The mapped GTK regression follows three actual voice-to-ordinary-room transitions and checks the rendered shadow nodes and retained voice view.

The user's installed executable is unchanged by these source and container checks. A newly built Windows package needs its own compile, packaged-DLL regression and launch evidence before this record claims the fix is present in that executable. The official packaging workflow is used for this check without publishing a release tag.

## Platform and evidence boundaries

The established browser scope has one RocketVibe origin/account. Native provider/account switching, server rail, OS tray/autostart and keyring remain installed-app capabilities. Browser capture requires the browser's own consent/source chooser after the retained quality dialog. Links, downloads, storage and installation follow browser mechanisms.

The existing native user-directory endpoint returns its first 100 active users. GTK and browser spotlight use that same contract; fixture accounts outside it cannot appear in client-side filtering. This limit is recorded rather than mistaken for a search-layout failure.

Headless tests use synthetic capture. Physical input/output switching, OS program audio exclusion, native RNNoise equivalence, external video-provider streaming and a live GIPHY account are not established by those fixtures. GIPHY configuration is documented in [the server README](../apps/server/README.md#gif-search). Advanced cryptographic/error variants remain individually qualified in [browser E2EE](WEB_E2EE.md) and [parity](../brain/parity.md); screen counts are not a claim that every possible refusal was executed.

## Sources

- apps/desktop/scripts/build.sh
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/chat_native.rs
- apps/desktop/crates/rv-gtk/src/chat_crypto.rs
- apps/desktop/crates/rv-gtk/src/chat_voice.rs
- apps/desktop/crates/rv-gtk/src/tests/native_navigation.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-gtk/src/tests/login_layout.rs
- apps/desktop/crates/rv-gtk/src/tests/windows_cairo.rs
- apps/desktop/crates/rv-gtk/src/style.rs
- apps/desktop/scripts/windows-cairo-shadow-proof.py
- apps/web/src/new-conversation.ts
- apps/web/src/crypto/chat.ts
- apps/web/src/crypto/ordinary-quotes.ts
- apps/web/src/crypto/quote-sources.ts
- apps/web/src/ui/quote-card.tsx
- apps/web/src/security.ts
- apps/web/src/factor-auth.ts
- apps/web/src/factor-auth-vault.ts
- apps/web/src/ui-errors.ts
- apps/web/tests/factor-auth.mjs
- apps/web/tests/ui-errors.test.ts
- apps/web/tests/translated-errors.mjs
- apps/web/src/time-picker.ts
- apps/web/src/social.tsx
- apps/web/src/panels.ts
- apps/web/src/workflows.ts
- apps/web/tests/gtk-forms.mjs
- apps/web/tests/conversation-parity.mjs
- apps/web/tests/scheduled.mjs
- apps/web/tests/reminders.mjs
- apps/web/tests/social.mjs
- apps/web/tests/workflows.mjs
- apps/web/tests/e2ee.mjs
- apps/web/tests/private-quote-search.mjs
- apps/web/tests/desktop-crypto.mjs
- apps/web/tests/voice-connection.mjs
- .github/workflows/web-client.yml
- .github/workflows/native-server.yml
