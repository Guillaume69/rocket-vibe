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
| Go engine | `apps/desktop/whatsapp/engine.go` | whatsmeow association, protocol events, history, sends, reactions, edits and revocations, the command set; transport-free (`open` returns the engine and its closer, `handle` runs one command, frames go to a sink) so a mobile binding can drive it |
| Go cache | `apps/desktop/whatsapp/store.go` | The engine's tables (`rv_messages`, `rv_reactions`, `rv_chat_names`, `rv_avatars`), migrations, pruning, LID to phone-number re-keying, replay |
| Go identities | `apps/desktop/whatsapp/identity.go` | Canonical JIDs, the name table, group subjects |
| Go photos | `apps/desktop/whatsapp/avatars.go` | Profile previews fetched one at a time, cached sealed for a week |
| Go transport | `apps/desktop/whatsapp/main.go` | stdin/stdout JSON lines for the desktop |
| Encrypted state | `apps/desktop/whatsapp/vault.go` | In-memory SQLite, serialization, AES-GCM snapshots, atomic replace and revocation |
| Rust adapter | `apps/desktop/crates/rv-core/src/whatsapp.rs` | Spawn and reap the child, bounded IPC, transient QR, in-memory native projection |
| GTK pilot | `apps/desktop/crates/rv-gtk/src/whatsapp_pilot.rs` | QR screen, conversation selection, existing timeline and composer, drafts and pending sends, names and photos, message menu (quick reactions, copy, edit, delete for everyone) |
| Keychain | `apps/desktop/crates/rv-gtk/src/secrets.rs` | Separate wrapping-key entry; missing key with existing state fails closed |
| Entry points | `rv-gtk/src/main.rs`, `rv-gtk/src/login.rs` | Environment-selected pilot, and login shortcut when the sidecar is present |
| Test child | `apps/desktop/crates/rv-core/tests/support/fake_whatsapp_sidecar.rs` | Synthetic QR, two conversations, names, a photo, a reaction, send, react and logout |
| IPC tests | `apps/desktop/crates/rv-core/tests/whatsapp.rs` | Actual subprocess exchange and shutdown |
| Go tests | `apps/desktop/whatsapp/vault_test.go` | Encrypted restoration and storage invariants, pruning, author-only edits and revocations, reaction replacement and retraction |

The pilot does not extend `provider::Chat`, `Session`, `supervisor::Supervisor`, `ServerKind`, the persistent account list or `rv-ffi`. Those are the next integration seams, **not already completed**. The mobile driver factory currently contains only Rocket.Chat, RocketVibe, Mattermost and kChat. The web app remains a client of its serving RocketVibe origin.

## Local IPC contract (version 1, experimental)

One UTF-8 JSON object per line, over private process pipes. Stdout is exclusively protocol data; stderr is suppressed by the adapter, and whatsmeow uses its no-op logger. The executable takes `--state <private-path>`; no credential appears on its command line.

The first stdin object is `{"type":"start","key":"<base64-encoded 32-byte OS-keychain key>"}`. These placeholders are illustrative, not usable credentials.

Subsequent commands:

- `connect`: restart transport; obtain a fresh QR only if the device has not been paired.
- `send`: includes `id` (a stable intent/message id), `chat` (WhatsApp JID), `text`. Text is bounded to 20,000 UTF-8 bytes. Only personal PN/LID and group JIDs are accepted.
- `react`: `id` (a scoped message id), `text` (the emoji glyph; empty takes my reaction back).
- `edit`: `id` of my own settled message, `text`; refused past WhatsApp's 15-minute window (`edit_expired`).
- `delete`: `id` of my own settled message, deleted for everyone; refused past 48 hours (`delete_expired`).
- `logout`: remotely unlink the device, delete encrypted state on success, then exit. Failure is visible; local removal alone is not a remote logout.
- `stop`: close transport, checkpoint state and exit, preserving the association.

Output types:

- `qr`: `code`, `expires_ms`. Expiry is relative to receipt. Replace the old QR, hide on expiry or any terminal state, and never log it.
- `status`: `state` among loaded, connecting, paired, connected, offline, qr_expired, replaced and logged_out.
- `message`: nested `id, chat, name, sender, author, text, ts, mine, status`, plus `edited` and `deleted` when set (a deleted message has an empty text). Timestamps are epoch milliseconds; ids are scoped as `<chat>:<WhatsApp message id>`, the chat canonical (its phone number once WhatsApp mapped its LID). `sender` is `me` for mine. A message is re-sent whole whenever it changes.
- `names`: `names`, the whole table JID to display name (address book, then push name, business name, group subject or history name, then `+<number>`); the client swaps it in and prefers it over a message's own `name`/`author`. Sent at most once a second, when contacts, push names, groups or the cache moved.
- `avatar`: `jid`, `data` (a base64 JPEG preview; empty once the photo is gone).
- `reaction`: nested `message, sender, emoji, ts`; an empty emoji takes that sender's reaction back. One reaction per sender per message, the newest wins.
- `reload`: the cache was re-keyed (a LID mapped to a number); the client drops messages and reactions, a full replay follows.
- `sent`: `id, state`; empty state is accepted by WhatsApp, `uncertain` is an ambiguous outcome. Acceptance is not a delivery/read receipt.
- `error`: a stable non-sensitive `code`, plus `id` when it refuses one send before any record or network attempt (`not_connected`, `invalid_send`, `local_storage_failed`, `send_already_recorded`): the client gives that send's text back as a draft. Without `id`, `logout_failed`, `invalid_command` and `local_storage_failed` leave the connection state alone; `action_failed`, `edit_expired`, `delete_expired` refuse one reaction, edit or deletion; every other code (`connector_start_failed`, `secure_storage_failed`, `session_ended`, `pairing_failed`, `client_outdated`, `connection_failed`, `state_removal_failed`) ends it (`state: error`) and Refresh starts a new helper. Do not log upstream exception bodies.

QR channel events map as: `code` to `qr`, `timeout` to `qr_expired`, `err-client-outdated` to `client_outdated`, any other error event (a phone without multi-device, unexpected state) to `pairing_failed`.

The Rust reader limits each frame to 1 MiB and reaps or kills a child that stops responding during shutdown (5 s). It retains partial input when a command interrupts an in-progress read. The projection is bounded to 20,000 messages. A stream failure clears the QR and marks the connector stopped; `Snapshot::exited` then says the child is gone and its state lock free, which a restart waits for (the helper takes an exclusive lock on its state, so a second helper started early fails with `connector_start_failed`). `Snapshot::loaded` turns true once the helper replayed its cache.

The Go helper checkpoints once per second but seals only when SQLite's `total_changes()` moved since the last sealed snapshot, so an idle session does not rewrite the file. Its text cache keeps the newest 20,000 settled messages (pruned at startup and after each history sync), with the reactions of the messages it keeps; `sending` and `uncertain` rows are kept whatever their age.

Identity: whatsmeow may key a conversation by phone number (PN) or by LID. The engine stores the canonical form (PN when `Store.LIDs` maps the LID) and keeps the addressing WhatsApp used in `raw_chat` / `raw_sender`, which sends, reactions, edits and revocations reuse. A re-keying pass runs at startup, after each history sync and every 30 s, and announces `reload` when it moved anything. Edits are accepted from the message's author only; revocations from the author, or anyone in a group (admins may delete others' messages; the engine cannot check the role). History is replayed oldest first so edits and revocations find their message; `WebMessageInfo.reactions` are kept too.

Photos: after each connection or `events.Picture`, a worker asks `GetProfilePictureInfo` (preview) for the 300 most recent chats and the authors of the last 3,000 group messages whose photo is older than a week, one every 400 ms, passing the kept picture id so an unchanged photo is not downloaded again. Downloads are https from `*.whatsapp.net` only, capped at 512 KiB. A hidden or absent photo is cached as none.

The Go cache stores send intents before their network attempt, and emits the record before that attempt. It turns surviving `sending` records into `uncertain` at startup, and never replays them automatically. The GTK window gives the text back as a draft only when the send provably never left: an `error` naming its id, the helper exited with no record of it, or a restarted helper replayed its cache without it. A stale error from another command never counts. An ambiguous network outcome is shown as unconfirmed rather than restoring a tempting duplicate-send draft.

## Commands and synthetic UI checks

See `apps/desktop/whatsapp/README.md` for the build and real launch. From Windows PowerShell for the Rust gate:

```powershell
$env:MSYS_NO_PATHCONV = '1'
& 'C:\Program Files\Git\bin\bash.exe' apps/desktop/scripts/build.sh
```

A Linux synthetic render runs the compiled app and fake child in the Fedora image, with `RV_WHATSAPP_PILOT=1`, `RV_WHATSAPP_SMOKE=qr` or `chat`, `RV_WHATSAPP_SMOKE_SHOT=<output.png>`, Xvfb and `GSK_RENDERER=cairo`. The QR is explicitly invalid and the messages are fixtures. Chat mode uses the actual native composer to submit a synthetic message and asserts that the actual timeline row exists. An automatic capture must never run against a real linked account.

## Verification record

2026-10-12, on `claude/whatsapp-feasibility`, Windows host with Docker Desktop:

- Go: `apps/desktop/scripts/build-whatsapp.sh` (gofmt, `go vet`, `go test -race`, Linux build) passed; 8 tests, among them the skipped unchanged checkpoint and the cache pruning. `TARGET_OS=windows PROFILE=release` cross-builds `rv-whatsapp.exe` with mingw-w64; it imports only `KERNEL32.dll` and `msvcrt.dll`.
- Rust, in `rocket-vibe-rs-build` with `CARGO_TARGET_DIR=/cargo/target-desktop`: `cargo fmt --check` and `cargo clippy --workspace --all-targets -D warnings` passed; `cargo test -p rv-core --lib whatsapp` (4), `--lib i18n` (4), `--test whatsapp` (3, real child process: pairing, send, refused send by id, unlink, stop) and `cargo test -p rocket-vibe-gtk --bins` (15) passed.
- Synthetic render: `RV_CARGO_TARGET=/cargo/target-desktop apps/desktop/scripts/smoke-whatsapp.sh` printed `whatsapp smoke: native flow=true screenshot=true` for `qr` and `chat`; both screenshots were inspected (QR centred with instructions; the two fixture conversations, the received and the sent message in the native timeline, composer reduced to text). The inspection found the sent message's author empty, since fixed.
- Windows test package: `gh workflow run desktop.yml --ref claude/whatsapp-feasibility` for the GTK app, the helper cross-built as above and copied beside `rocket-vibe-gtk.exe`. Launching it is a manual step; see "Live test on Windows" below.
- Live, 2026-10-12, by the user on Windows with the package of run 38256657698 and the release helper: QR pairing succeeded and the conversations showed. The user reported phone numbers instead of names, no photos and no reactions; the following increment (engine split, name table, LID re-keying, photos, reactions, edits, deletions) answers that, checked by Go and Rust tests and the synthetic render (names, a decoded photo on the tile and the author, a reaction chip). Its live check is pending.
- Not yet checked live: text delivery both ways, reconnect after process restart, remote unlink and upstream failure scenarios.
- macOS GTK runtime, SwiftUI, Android: absent. Web: `n/a`.

Update this record with actual commands and evidence, never with intended results.

## Live test on Windows

1. Unzip the `desktop-windows` artifact's portable zip under `D:\RocketVibe\artifacts\` and put `rv-whatsapp.exe` (`TARGET_OS=windows PROFILE=release apps/desktop/scripts/build-whatsapp.sh`, output in `apps/desktop/target/release/`) in its `bin\` folder, next to `rocket-vibe-gtk.exe`.
2. In PowerShell: `$env:RV_WHATSAPP_PILOT = '1'; & '<folder>\bin\rocket-vibe-gtk.exe'`. The pilot has its own application id, so the installed RocketVibe may stay open. Without the variable, the sign-in page of a signed-out app offers Connect WhatsApp when the helper is present.
3. Scan the QR from WhatsApp > Linked devices > Link a device. The key goes to Windows Credential Manager (service `me.barrut.RocketVibe`, entry `whatsapp-pilot-storage-v1`), the sealed state to `%LOCALAPPDATA%\rocket-vibe-rs\whatsapp-pilot\state.bin`.
4. To start over: Unlink in the window (or remove the device from the phone, then Refresh). Deleting `state.bin` alone leaves the device linked on the phone's side.

## Known limitations and next work

1. Qualify on a dedicated, human-authorized WhatsApp account: association; a known recent conversation; inbound and outbound text; app restart with the phone offline; normal unlink; unlink from the phone; interrupted sends. Keep only sanitized evidence. Not yet rendered: QR expiry, failed startup, an uncertain send and closing while connecting (the logic is in `whatsapp_pilot.rs`, the unit and IPC tests cover the snapshot side only).
2. Package the helper: `package-windows.sh` and the installer do not ship `rv-whatsapp.exe`, nor the Linux and macOS bundles their helper; add its build to `desktop.yml`, with whatsmeow's MPL-2.0 notice, before any public release.
3. Make identifier normalization explicit: PN and LID aliases can represent one person. The current pilot can split a conversation when upstream identity forms change. Contact/group renaming, unread counters, read/delivery receipts, mutations and a complete historical backfill are not qualified.
4. The pilot excludes view-once and disappearing message content. It does not yet qualify outgoing behavior in a disappearing chat, nor guarantee deletion/edit reconciliation. Keep it experimental until retention and remote mutations are handled correctly.
5. Qualify snapshot durability during a crash and keychain loss, and concurrent restore failures. The encrypted-file limit is 128 MiB; exceeding it stops the connection instead of silently discarding state. The in-memory database lives on database/sql's single pooled connection: a driver returning `ErrBadConn` would drop it and the session with it (not observed).
6. Add explicit user-facing states for missing helper, locked keychain, corrupt encrypted state (today the only way out is deleting `state.bin`), simultaneous process and network failure. Current startup error text groups these cases.
7. A send blocks the helper's command loop for up to 45 s; a Stop during it is answered after the send, and the adapter kills the helper after 5 s, leaving the send `uncertain` at the next start.
8. Integrate a dedicated account/session variant with the normal rail and supervisor, preserving provider separation. Do not pretend WhatsApp is a Rocket.Chat REST backend. Capabilities must hide unsupported threads, server administration, calls, media, search and scheduling.
9. After the desktop increment is live-qualified, design the SwiftUI facade and Android native embedding/background notification model. A server relay would change the privacy boundary and needs a separate decision.

## Primary references

- [whatsmeow](https://github.com/tulir/whatsmeow): third-party Go linked-device protocol library, MPL-2.0. Calls are outside its implemented feature set.
- [whatsmeow API](https://pkg.go.dev/go.mau.fi/whatsmeow): QR channel, event and send interfaces.
- [Meta multi-device architecture](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/): independent device keys and encrypted recent-history transfer.
- [Meta Business Platform](https://www.postman.com/meta/whatsapp-business-platform/overview): separate professional messaging API, not a personal-account import.
- [Meta interoperability](https://engineering.fb.com/2024/03/06/security/whatsapp-messenger-messaging-interoperability-eu/): provider agreement and security requirements; distinct from this linked-account pilot.

