# rocket-vibe web

The native RocketVibe server serves this actual browser client at `/`. It uses that origin and one account. Encrypted conversations are currently unsupported and shown locked.

The interface reuses the GTK theme, Nunito/Baloo 2 fonts, Adwaita icons, Noto emoji and project sounds. Chat, threads, actions, search, drafts, offline queues, uploads, recording, profiles, room management, administration, security settings, bots, workflows, their message forms and LiveKit calls are implemented. See [execution and remaining parity](../../docs/WEB_CLIENT_EXECUTION.md).

## Build

Use Node 24. Run from `apps/web`:

```sh
npm ci
npm run format:check
npm run check
npm test
npm run build
```

The build synchronizes GTK design values, the feature catalog and refusal wording and generates dependency licence notices before compiling. Commit `dist` and the generated design/licence files alongside source changes. Cargo embeds these committed files, so a fresh server checkout or Docker build needs no Node runtime. Rebuild the server after changing the web bundle:

```sh
cargo build --locked -p rv-server
```

For development, `RV_WEB_API_URL=http://127.0.0.1:3400 npm run dev` proxies the native API and WebSocket. Production requires HTTPS for browser media, Web Crypto, Web Locks and the worker; loopback is an allowed development exception. The existing server deployment serves the application automatically.

## Verification

The Node tests cover model ordering/access withdrawal and authenticated error handling. Playwright tests use real disposable accounts `webalice` (administrator) and `webbob`, password `web-client-disposable-password`, on loopback only. Never point fixtures at a real deployment.

```sh
npx playwright install chromium
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:browser
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:features
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:media
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:voice
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:sessions
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:locked
RV_WEB_TEST_URL=http://127.0.0.1:3417 npm run test:composer
RV_WEB_SECURITY_USER=websecurity npm run test:security
RV_WEB_VISUAL_USER=webvisual npm run test:visual
RV_WEB_WORKFLOWS_USER=webworkflows npm run test:workflows
```

Voice requires the server's isolated LiveKit configuration. Security requires the TLS SMTP fixture (`node apps/web/tests/smtp.mjs` from repository root), the server's SMTP configuration pointing to localhost:14653 and its fixture certificate, plus a fresh `websec*` account. The editor suite uses `RV_WEB_COMPOSER_USER` when set and creates its own room; CI seeds a separate `webcomposer` account to keep combined login scenarios within the native ten-per-minute account budget. Fixture captures are in ignored `.cache/smtp-mails.json`; screenshots in `.cache/web-shots`.

## Browser mappings and limits

One origin/account intentionally replaces the GTK server rail. Browser storage replaces the native keyring/SQLite; clearing site data removes drafts and pending work. Private blobs stay out of worker caches and are removed on logout/access withdrawal. Notifications work while a tab lives; closed-tab Web Push is absent. Audio/video/share permissions and capture choices belong to the browser.

Calls use GTK's tile geometry, listening gains, PCM speaking thresholds and peer-reconnection grace. The quality picker configures screen capture and encoding; the browser supplies its source consent picker. Fullscreen and the stage follow share takeover. Screen sound requires a confirmed `restrictOwnAudio` capture setting, otherwise video remains without program sound. GTK's opt-in include-call preference mixes remote microphones separately and respects listening volume, local mute and deafen. Browser-native noise suppression differs from GTK RNNoise. Physical-device and platform program-sound qualification remain incomplete.

The voice suite transmits real microphone, camera, screen and shared-sound RTP through the isolated SFU. The program-sound source is a controlled fixture whose exclusion setting is marked explicitly; it proves pre-publication processing and cleanup, not operating-system loopback exclusion. Native GTK/browser interop is also exercised locally in the mandatory Fedora environment.

The media suite uses separate `webmedia` and `webmediapeer` disposable accounts. It records and uploads a real video, checks the GTK frame and playback controls, keeps media and fullscreen during live reactions, and stops private playback on access withdrawal. External provider embeds use intercepted fixture responses to verify origin-only identification and context retention; this does not qualify vendor streaming. Browser downloads map GTK's external application action.

Encrypted rooms, browser crypto enrolment/recovery and Rocket.Chat provider support are outside the accepted scope. Complete GTK visual parity remains under qualification; the DOM editor follows GTK's draft styling, selection and marker visibility.

## Licences

LiveKit browser transport is Apache-2.0. Original fonts and Adwaita assets include their licence files. Generated production dependency notices are included in the bundle.
