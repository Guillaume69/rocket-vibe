# WhatsApp linked-device pilot: agent handoff

Date: 2026-10-12.
Branch: `claude/whatsapp-feasibility`, based on `origin/master` at `089df389`. It continues `codex/whatsapp-feasibility`, whose work was left uncommitted in the Codex worktree when that session ended; the first commit imports it unchanged, the following ones fix and qualify it.
Status: synthetic qualification complete (see the verification record); live WhatsApp qualification pending.

## Accepted direction and scope

The user selected QR association with a personal WhatsApp account, reusing the app's native UI, and selected desktop first. They explicitly requested English documentation for another agent. Keep this work in its own worktree.

The first increment is a local **GTK text pilot**: display an actual QR produced by the connector, receive the supported recent history and live text, select conversations, send text, preserve an encrypted session and unlink it. Reuse `MessageList`, `Composer`, room tiles, styling and the existing system keychain integration.

There is no authorization to claim a live pairing, merge this experimental pilot into master, release it, or expand it simultaneously to every platform. Do not manufacture an account, import a personal database, send messages to contacts, or check credentials into the repository for testing. Live acceptance requires a person to scan the QR in WhatsApp and authorize the chosen test conversation.

## Architecture and source map

| Layer | Source | Responsibility |
|---|---|---|
| Go child | `apps/desktop/whatsapp/main.go` | whatsmeow association, protocol events, history, outgoing intents and stdin/stdout frames |
| Encrypted state | `apps/desktop/whatsapp/vault.go` | In-memory SQLite, serialization, AES-GCM snapshots, atomic replace and revocation |
| Rust adapter | `apps/desktop/crates/rv-core/src/whatsapp.rs` | Spawn and reap the child, bounded IPC, transient QR, in-memory native projection |
| GTK pilot | `apps/desktop/crates/rv-gtk/src/whatsapp_pilot.rs` | QR screen, conversation selection, existing timeline and composer, drafts and pending sends |
| Keychain | `apps/desktop/crates/rv-gtk/src/secrets.rs` | Separate wrapping-key entry; missing key with existing state fails closed |
| Entry points | `rv-gtk/src/main.rs`, `rv-gtk/src/login.rs` | Environment-selected pilot, and login shortcut when the sidecar is present |
| Test child | `apps/desktop/crates/rv-core/tests/support/fake_whatsapp_sidecar.rs` | Synthetic QR, two conversations, send response and logout |
| IPC tests | `apps/desktop/crates/rv-core/tests/whatsapp.rs` | Actual subprocess exchange and shutdown |
| Go tests | `apps/desktop/whatsapp/vault_test.go` | Encrypted restoration and storage invariants |

The pilot does not extend `provider::Chat`, `Session`, `supervisor::Supervisor`, `ServerKind`, the persistent account list or `rv-ffi`. Those are the next integration seams, **not already completed**. The mobile driver factory currently contains only Rocket.Chat, RocketVibe, Mattermost and kChat. The web app remains a client of its serving RocketVibe origin.

## Local IPC contract (version 1, experimental)

One UTF-8 JSON object per line, over private process pipes. Stdout is exclusively protocol data; stderr is suppressed by the adapter, and whatsmeow uses its no-op logger. The executable takes `--state <private-path>`; no credential appears on its command line.

The first stdin object is `{"type":"start","key":"<base64-encoded 32-byte OS-keychain key>"}`. These placeholders are illustrative, not usable credentials.

Subsequent commands:

- `connect`: restart transport; obtain a fresh QR only if the device has not been paired.
- `send`: includes `id` (a stable intent/message id), `chat` (WhatsApp JID), `text`. Text is bounded to 20,000 UTF-8 bytes. Only personal PN/LID and group JIDs are accepted.
- `logout`: remotely unlink the device, delete encrypted state on success, then exit. Failure is visible; local removal alone is not a remote logout.
- `stop`: close transport, checkpoint state and exit, preserving the association.

Output types:

- `qr`: `code`, `expires_ms`. Expiry is relative to receipt. Replace the old QR, hide on expiry or any terminal state, and never log it.
- `status`: `state` among loaded, connecting, paired, connected, offline, qr_expired, replaced and logged_out.
- `message`: nested `id, chat, name, sender, author, text, ts, mine, status`. Timestamps are epoch milliseconds; ids are scoped as `<chat>:<WhatsApp message id>`.
- `sent`: `id, state`; empty state is accepted by WhatsApp, `uncertain` is an ambiguous outcome. Acceptance is not a delivery/read receipt.
- `error`: a stable non-sensitive `code`, plus `id` when it refuses one send before any record or network attempt (`not_connected`, `invalid_send`, `local_storage_failed`, `send_already_recorded`): the client gives that send's text back as a draft. Without `id`, `logout_failed`, `invalid_command` and `local_storage_failed` leave the connection state alone; every other code (`connector_start_failed`, `secure_storage_failed`, `session_ended`, `pairing_failed`, `client_outdated`, `connection_failed`, `state_removal_failed`) ends it (`state: error`) and Refresh starts a new helper. Do not log upstream exception bodies.

QR channel events map as: `code` to `qr`, `timeout` to `qr_expired`, `err-client-outdated` to `client_outdated`, any other error event (a phone without multi-device, unexpected state) to `pairing_failed`.

The Rust reader limits each frame to 1 MiB and reaps or kills a child that stops responding during shutdown (5 s). It retains partial input when a command interrupts an in-progress read. The projection is bounded to 20,000 messages. A stream failure clears the QR and marks the connector stopped; `Snapshot::exited` then says the child is gone and its state lock free, which a restart waits for (the helper takes an exclusive lock on its state, so a second helper started early fails with `connector_start_failed`). `Snapshot::loaded` turns true once the helper replayed its cache.

The Go helper checkpoints once per second but seals only when SQLite's `total_changes()` moved since the last sealed snapshot, so an idle session does not rewrite the file. Its text cache keeps the newest 20,000 settled messages (pruned at startup and after each history sync); `sending` and `uncertain` rows are kept whatever their age.

The Go cache stores send intents before their network attempt, and emits the record before that attempt. It turns surviving `sending` records into `uncertain` at startup, and never replays them automatically. The GTK window gives the text back as a draft only when the send provably never left: an `error` naming its id, the helper exited with no record of it, or a restarted helper replayed its cache without it. A stale error from another command never counts. An ambiguous network outcome is shown as unconfirmed rather than restoring a tempting duplicate-send draft.

## Commands and synthetic UI checks

See `apps/desktop/whatsapp/README.md` for the build and real launch. From Windows PowerShell for the Rust gate:

```powershell
$env:MSYS_NO_PATHCONV = '1'
& 'C:\Program Files\Git\bin\bash.exe' apps/desktop/scripts/build.sh
```

A Linux synthetic render runs the compiled app and fake child in the Fedora image, with `RV_WHATSAPP_PILOT=1`, `RV_WHATSAPP_SMOKE=qr` or `chat`, `RV_WHATSAPP_SMOKE_SHOT=<output.png>`, Xvfb and `GSK_RENDERER=cairo`. The QR is explicitly invalid and the messages are fixtures. Chat mode uses the actual native composer to submit a synthetic message and asserts that the actual timeline row exists. An automatic capture must never run against a real linked account.

## Verification record

- Go dependency resolution and initial Linux connector build: passed.
- Go vet and race-enabled vault tests: passed.
- Rust gate and synthetic GTK rendering: pending at the time this document was started.
- Live QR pairing, initial WhatsApp history, actual text delivery, reconnect after process restart, remote unlink and upstream failure scenarios: unverified.
- Windows sidecar/GTK package, macOS GTK runtime, SwiftUI, Android and web integration: unverified or absent.

Update this record with actual commands and evidence, never with intended results.

## Known limitations and next work

1. Finish and visually inspect the synthetic native flow, including expiry, failed startup, send ambiguity and closing while connecting.
2. Qualify on a dedicated, human-authorized WhatsApp test account: association; a known recent conversation; inbound and outbound text; app restart with the phone offline; normal unlink; unlink from the phone; interrupted sends. Keep only sanitized evidence.
3. Build and run a Windows artifact if Windows is the desired test desktop. The current Go script produces Linux only. Do not bypass the required project build environment or claim Windows readiness from Linux tests.
4. Make identifier normalization explicit: PN and LID aliases can represent one person. The current pilot can split a conversation when upstream identity forms change. Contact/group renaming, unread counters, read/delivery receipts, mutations and a complete historical backfill are not qualified.
5. The pilot excludes view-once and disappearing message content. It does not yet qualify outgoing behavior in a disappearing chat, nor guarantee deletion/edit reconciliation. Keep it experimental until retention and remote mutations are handled correctly.
6. Bound/prune the Go history cache, qualify snapshot durability during a crash and keychain loss, and qualify concurrent restore failures. The encrypted-file limit is 128 MiB; exceeding it stops the connection instead of silently discarding state.
7. Add explicit user-facing states for missing helper, locked keychain, corrupt encrypted state, simultaneous process and network failure. Current startup error text groups these cases.
8. Integrate a dedicated account/session variant with the normal rail and supervisor, preserving provider separation. Do not pretend WhatsApp is a Rocket.Chat REST backend. Capabilities must hide unsupported threads, server administration, calls, media, search and scheduling.
9. Add packaging, license notices and CI for the helper before any public desktop release. No sidecar is bundled by existing release workflows.
10. After the first desktop increment is complete and live-qualified, design the SwiftUI facade and Android native embedding/background notification model. A server relay would change the privacy boundary and needs a separate decision.

## Primary references

- [whatsmeow](https://github.com/tulir/whatsmeow): third-party Go linked-device protocol library, MPL-2.0. Calls are outside its implemented feature set.
- [whatsmeow API](https://pkg.go.dev/go.mau.fi/whatsmeow): QR channel, event and send interfaces.
- [Meta multi-device architecture](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/): independent device keys and encrypted recent-history transfer.
- [Meta Business Platform](https://www.postman.com/meta/whatsapp-business-platform/overview): separate professional messaging API, not a personal-account import.
- [Meta interoperability](https://engineering.fb.com/2024/03/06/security/whatsapp-messenger-messaging-interoperability-eu/): provider agreement and security requirements; distinct from this linked-account pilot.

