# Browser E2EE

The browser implements the native RocketVibe MLS protocol. Rocket.Chat's
password/RSA room-key protocol and external providers remain outside the
serving-origin browser scope. The user requested usable browser encryption on
2026-10-09, superseding the temporary exclusion in RFC 0005.

## Engine and delivery

`crates/rv-crypto-web` compiles the existing `rv-crypto` engine and the public
ceremony bridge from `rv-crypto-mobile` to WebAssembly. Native UniFFI remains
the default feature of the mobile bridge. The browser builds it without those
bindings. MLS identities, device certificates, pins, explicit consents,
KeyPackages, group transitions, journals, message actions, recovery and files
use the same Rust code and formats. Browser Markdown is also parsed locally by
`rv-protocol`; private text is never sent to a server Markdown endpoint.

`apps/web/scripts/sync-crypto.mjs` generates browser adapters from the canonical
platform-independent mobile orchestration. Do not edit `src/crypto/shared`.
`npm run crypto:build` builds in Fedora with Rust 1.97.1 and wasm-bindgen 0.2.129.
The source/artifact manifest rejects stale checked-in WASM during ordinary
`npm run build`. Production embeds all assets in the server binary. The CSP
allows same-origin workers and WASM compilation, without JavaScript eval.

## Storage and boundaries

A dedicated worker owns a volatile SQLite database and the protected native
records. Before each operation it acquires a Web Lock for
`[origin, instance, data epoch, user, server device]`, restores the latest
authenticated snapshot, runs the native operation, and saves any changed state
in a strict-durability IndexedDB transaction. A compare-and-swap revision
prevents replacing a newer checkpoint. Only after persistence may a result or
outgoing packet reach the renderer. A failed operation can still checkpoint
a withdrawal or pending original before returning its error.

The complete private snapshot is sealed with AES-256-GCM, a fresh random IV,
scope/revision associated data, and a non-extractable WebCrypto key. It lives in
`rocket-vibe-private`, separate from ordinary accounts, caches, media, drafts,
upload jobs and outboxes. Native storage-key renewal also replaces the outer
WebCrypto key. Each view has its own worker and opaque consent, but all views
and tabs serialize their persistent state through the same lock.

Private rendered documents, quote cards, search results, staged files and
decrypted media URLs remain volatile. Drafts and message originals go through
the protected native journal. Encrypted uploads carry opaque ciphertext,
object size/digest and `application/octet-stream`; the original filename,
media type and file key travel inside the encrypted message. Downloads verify
the native chunked file format before creating an in-memory media URL.
Navigation, changed membership, signout and closed views stop workers, remove
private rendered documents and release media URLs. No public service-worker
cache receives private API responses or plaintext.

## Browser trust model

This is browser storage, not an OS keyring, hardware enclave or independently
anchored anti-rollback counter. A full browser-profile restore can restore the
key and its old authenticated snapshot together. Non-extractability prevents
the WebCrypto export/wrap APIs; it does not prevent same-origin malicious code
from using the key. A compromised serving origin or injected script can read
rendered plaintext and invoke browser cryptography. HTTPS, delivered-code
integrity and the origin's XSS boundary are therefore part of browser E2EE's
trust model. JavaScript GC, browser caches and profile backups do not provide
native forensic-erasure guarantees. Clearing site data removes this device's
local identity; use device approval or the explicit recovery/history codes.

WASM execution, workers, Web Locks, IndexedDB CryptoKey cloning and WebCrypto
must be available in a secure context. Unsupported browsers fail closed.
WebRTC frame encryption additionally requires LiveKit's supported encoded
transform APIs. An encrypted call never falls back to clear frames. The
padded base64 MLS voice exporter is passed as a string to the SDK, matching
the native PBKDF2 frame-key format rather than its ArrayBuffer/HKDF variant.

## Qualification

`tests/crypto-storage.mjs` exercises the actual WASM engine in Chromium and
Firefox: identity persistence, simultaneous worker access, refusal to export
the browser key and rejection of a corrupted authenticated snapshot.
`tests/e2ee.mjs` drives the production bundle served by the native server,
including its CSP, WASM and module-worker MIME types. Chromium and Firefox
register devices, compare/pin peer fingerprints, approve certificates, create
and accept a real MLS group, exchange private Markdown/messages and files,
edit/quote/reply/react/delete, search locally, and reload without losing the
identity or ratchet. New members cannot read pre-admission messages. Private
text stays outside ordinary IndexedDB stores and HTTP payloads.

The same scenario publishes an identity backup, verifies that the old browser
key cannot decrypt the renewed vault, enables/uploads history backup, joins
an encrypted voice channel in both browsers and checks actual decrypted audio
energy and both occupants. A fresh browser profile recovers the same identity,
registers a fresh leaf and restores nonempty history with its separate code.
The GTK identity/group controls were also launched under Xvfb. The separate
`desktop-crypto.mjs` scenario creates a real GTK installation in Secret Service,
admits it into a browser-created MLS group, and exchanges messages through the
actual GTK timeline/composer and browser UI. It also checks fingerprint equality
and pre-admission isolation. The shared native engine and mobile bridge tests
cover the same wire formats.

Remaining qualification debt: installed mobile/browser sessions and cross-app
desktop files, recovery/history and encrypted voice,
full visual comparisons of every crypto dialog state, multiple-tab reload and
withdrawal races in real accounts, history path A sharing/delegation/cancellation,
device renewal/removal and history-backup rotation/cancellation, camera/screen
frame encryption and approved epoch changes during an active call. Ordinary
source quote lookup and jumping to older private search results are not wired.
Offline private browsing requires online signed-directory/scope checks. These
limits are recorded as partial parity, not as complete native equivalence.

See `brain/parity.md` and `docs/WEB_CLIENT_EXECUTION.md`. Browser key guarantees
must not be described as equivalent to the native system-keystore anchor.

The local GTK interoperability check is `RV_WEB_TEST_URL=http://127.0.0.1:3417
npm run test:desktop-crypto` from `apps/web`. It requires the built Fedora GTK
binary and the disposable `rv-web-e2ee-api` container labelled
`rocketvibe.task=web-e2ee`. It creates fresh synthetic accounts, launches a real
GTK process under Xvfb and Secret Service in its own disposable container, and
exchanges messages through the existing GTK composer/timeline and production
browser UI. Keys stay in the container's temporary Linux profile; fixture
markers, public fingerprints and test logs are in ignored `.cache/bench`.

## Sources

- crates/rv-crypto/src/browser.rs
- crates/rv-crypto-web/src/lib.rs
- crates/rv-crypto-mobile/src/lib.rs
- apps/web/src/crypto/worker.ts
- apps/web/src/crypto/vault.ts
- apps/web/src/crypto/access.ts
- apps/web/src/crypto/chat.ts
- apps/web/src/crypto/panels.ts
- apps/web/src/crypto/settings-controls.ts
- apps/web/src/crypto/voice.ts
- apps/web/tests/crypto-storage.mjs
- apps/web/tests/e2ee.mjs
- apps/web/tests/desktop-crypto.mjs
- apps/desktop/crates/rv-gtk/src/smoke/native_crypto.rs
- docs/protocol/VOICE.md
- [OpenMLS WASM support](https://book.openmls.tech/)
- [WebCrypto key extractability](https://developer.mozilla.org/en-US/docs/Web/API/CryptoKey/extractable)
