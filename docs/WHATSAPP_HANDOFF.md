# WhatsApp accounts: agent handoff

Date: 2026-10-12.
Branch: `claude/whatsapp-feasibility`, based on `origin/master` at `089df389`. It continues `codex/whatsapp-feasibility`, whose work was left uncommitted in the Codex worktree when that session ended; the first commit imports it unchanged, the following ones fix it, then make WhatsApp an account of the GTK app.
Status: linked and used live by the user on Windows (pilot window builds); the integrated account is checked by tests and the synthetic GTK smoke, its live check pending. Not merged into master, not released.

## Accepted direction and scope

The user chose QR association with a personal WhatsApp account, the app's native interface, desktop first, and whatsmeow (alternatives weighed: Baileys needs a Node runtime, a Rust port is less proven, an own implementation is out of reach). The user asked for the implementation "done properly" after the pilot, and said mobile follows: the Go engine is transport-free so that an Android `gomobile` binding can drive it. Keep this work in its own worktree; documentation in English.

Do not manufacture an account, import a personal database, send messages to contacts, or check credentials into the repository for testing. Live checks are the user's: they scan the QR with their own phone.

## Architecture and source map

| Layer | Source | Responsibility |
|---|---|---|
| Go engine | `apps/desktop/whatsapp/engine.go` | whatsmeow association, protocol events, history, sends, reactions, edits and revocations, the command set; transport-free (`open` returns the engine and its closer, `handle` runs one command, frames go to a sink) |
| Go cache | `apps/desktop/whatsapp/store.go` | The engine's tables (`rv_messages`, `rv_reactions`, `rv_chat_names`, `rv_avatars`, `rv_chats`), migrations, pruning, LID to phone-number re-keying, replay |
| Go identities | `apps/desktop/whatsapp/identity.go` | Canonical JIDs, the name table, group subjects |
| Go photos | `apps/desktop/whatsapp/avatars.go` | Profile previews (mine first) fetched one at a time, cached sealed for a week |
| Go read state | `apps/desktop/whatsapp/reads.go` | Unread counts per chat, receipts on my messages, read receipts when a chat is read |
| Go search | `apps/desktop/whatsapp/search.go` | Contacts, groups and typed numbers for new conversations |
| Go media | `apps/desktop/whatsapp/media.go` | Attachments kept with their metadata and thumbnail; `download` decrypts one into the account's private folder |
| Go transport | `apps/desktop/whatsapp/main.go` | stdin/stdout JSON lines for the desktop |
| Sealed state | `apps/desktop/whatsapp/vault.go` | In-memory SQLite, AES-GCM snapshots, atomic replace, revocation; restore through the backup API (a deserialized image cannot grow) |
| Rust adapter | `apps/desktop/crates/rv-core/src/whatsapp.rs` | Spawn and reap the child, bounded IPC, snapshot, change signal, `whatsapp://` identity, state locations |
| Account | `apps/desktop/crates/rv-core/src/whatsapp_session.rs` | `WaSession`: helper kept alive, room rows, timeline, sends and drafts, reads, notifications, unlink, expiry, connector handoff |
| Provider | `apps/desktop/crates/rv-core/src/provider.rs` | `Chat::WhatsApp`: spotlight (search), events |
| GTK chats | `apps/desktop/crates/rv-gtk/src/chat_whatsapp.rs` | The account in `ChatPage`: room list, timeline, composer, menu, photos, reads |
| GTK linking | `apps/desktop/crates/rv-gtk/src/whatsapp_link.rs` | QR dialog for a new account, adoption of the pilot's linked device |
| GTK window | `apps/desktop/crates/rv-gtk/src/window.rs` | Start, reload, notifications, unlink, expiry |
| Keychain | `apps/desktop/crates/rv-gtk/src/secrets.rs` | One wrapping key per state; missing key with existing state fails closed; forgetting an unlinked account |
| Test helper | `apps/desktop/crates/rv-core/tests/support/fake_whatsapp_sidecar.rs` | Synthetic QR (and its own "scan"), conversations, names, photos, a reaction, a reply, search, send, read, logout |
| IPC tests | `apps/desktop/crates/rv-core/tests/whatsapp.rs` | Actual subprocess exchange, `WaSession` against the fake helper |
| GTK smoke | `apps/desktop/crates/rv-gtk/src/smoke/whatsapp.rs`, `apps/desktop/scripts/smoke-whatsapp.sh` | The whole flow in the app under Xvfb |
| Go tests | `apps/desktop/whatsapp/vault_test.go` | Sealed state, growth after a restore, pruning, author-only edits and revocations, reactions, unread counts and receipts, replies, numbers |

## Local IPC contract (version 1, experimental)

One UTF-8 JSON object per line, over private process pipes. Stdout is exclusively protocol data; stderr is suppressed by the adapter, and whatsmeow uses its no-op logger. The executable takes `--state <private-path>`; no credential appears on its command line.

The first stdin object is `{"type":"start","key":"<base64-encoded 32-byte OS-keychain key>"}`. These placeholders are illustrative, not usable credentials.

Subsequent commands:

- `connect`: restart transport; obtain a fresh QR only if the device has not been paired.
- `send`: includes `id` (a stable intent/message id), `chat` (WhatsApp JID), `text`, and `reply` (the scoped id of the message it answers, same chat) for a quoted reply. Text is bounded to 20,000 UTF-8 bytes. Only personal PN/LID and group JIDs are accepted.
- `react`: `id` (a scoped message id), `text` (the emoji glyph; empty takes my reaction back).
- `edit`: `id` of my own settled message, `text`; refused past WhatsApp's 15-minute window (`edit_expired`).
- `delete`: `id` of my own settled message, deleted for everyone; refused past 48 hours (`delete_expired`).
- `read`: `chat`; sends read receipts for its unread messages of others (at most 100, newest first; a private `read-self` when my privacy settings send no read receipts) and sets its count to zero, here and on my other devices.
- `search`: `id`, `text`; answered by a `found` frame (`id`, `people`: `jid`, `name`) from the contacts, groups and a typed number WhatsApp knows.
- `upload`: `id`, `chat`, `text` (caption), `reply`, `path` (a local file), `mime`, `name`, `voice`; uploaded before the message is recorded and sent, then like `send`. Over 100 MB is refused (`file_refused`), a failed upload is `upload_failed`, both naming the id.
- `download`: `id` of a message with an attachment; answered by a `file` frame (`id`, `path`, empty on failure). Over 200 MB is refused.
- `logout`: remotely unlink the device, delete encrypted state on success, then exit. Failure is visible; local removal alone is not a remote logout.
- `stop`: close transport, checkpoint state and exit, preserving the association.

Output types:

- `qr`: `code`, `expires_ms`. Expiry is relative to receipt. Replace the old QR, hide on expiry or any terminal state, and never log it.
- `status`: `state` among loaded, connecting, paired, connected, offline, qr_expired, replaced and logged_out.
- `message`: nested `id, chat, name, sender, author, text, ts, mine, status`, plus `edited` and `deleted` when set (a deleted message has an empty text). Timestamps are epoch milliseconds; ids are scoped as `<chat>:<WhatsApp message id>`, the chat canonical (its phone number once WhatsApp mapped its LID). `sender` is `me` for mine. A message is re-sent whole whenever it changes.
- `names`: `names`, the whole table JID to display name (address book, then push name, business name, group subject or history name, then `+<number>`); the client swaps it in and prefers it over a message's own `name`/`author`. Sent at most once a second, when contacts, push names, groups or the cache moved.
- `avatar`: `jid`, `data` (a base64 JPEG preview; empty once the photo is gone).
- `reaction`: nested `message, sender, emoji, ts`; an empty emoji takes that sender's reaction back. One reaction per sender per message, the newest wins.
- `chat`: `jid`, `unread`: the chat's unread count. Seeded from the phone's own count in the first history sync, one more per new message of someone else, zero when a chat is read here or on the phone (`read-self` receipt or `MarkChatAsRead`), at least one when the phone marks it unread.
- `message` also carries `receipt` on my messages (`delivered`, `read`, `played`, never moving back; only `delivered` in groups, where one reader is not everyone) and, on a reply, `reply_to`, `quote_sender` (`me` for mine) and `quote_text` as quoted.
- `reload`: the cache was re-keyed (a LID mapped to a number); the client drops messages, reactions and counts, a full replay follows.

Compatibility: the Rust adapter skips a frame whose type it does not know (a newer helper beside an older app), and stops only on a frame that is not JSON. New fields are optional on both sides.
- `sent`: `id, state`; empty state is accepted by WhatsApp, `uncertain` is an ambiguous outcome. Acceptance is not a delivery/read receipt.
- `error`: a stable non-sensitive `code`, plus `id` when it refuses one send before any record or network attempt (`not_connected`, `invalid_send`, `local_storage_failed`, `send_already_recorded`): the client gives that send's text back as a draft. Without `id`, `logout_failed`, `invalid_command` and `local_storage_failed` leave the connection state alone; `action_failed`, `edit_expired`, `delete_expired` refuse one reaction, edit or deletion; every other code (`connector_start_failed`, `secure_storage_failed`, `session_ended`, `pairing_failed`, `client_outdated`, `connection_failed`, `state_removal_failed`) ends it (`state: error`) and Refresh starts a new helper. Do not log upstream exception bodies.

QR channel events map as: `code` to `qr`, `timeout` to `qr_expired`, `err-client-outdated` to `client_outdated`, any other error event (a phone without multi-device, unexpected state) to `pairing_failed`.

The Rust reader limits each frame to 1 MiB and reaps or kills a child that stops responding during shutdown (5 s). It retains partial input when a command interrupts an in-progress read. The projection is bounded to 20,000 messages. A stream failure clears the QR and marks the connector stopped; `Snapshot::exited` then says the child is gone and its state lock free, which a restart waits for (the helper takes an exclusive lock on its state, so a second helper started early fails with `connector_start_failed`). `Snapshot::loaded` turns true once the helper replayed its cache.

The Go helper checkpoints once per second but seals only when SQLite's `total_changes()` moved since the last sealed snapshot, so an idle session does not rewrite the file. Its text cache keeps the newest 20,000 settled messages (pruned at startup and after each history sync), with the reactions of the messages it keeps; `sending` and `uncertain` rows are kept whatever their age.

Identity: whatsmeow may key a conversation by phone number (PN) or by LID. The engine stores the canonical form (PN when `Store.LIDs` maps the LID) and keeps the addressing WhatsApp used in `raw_chat` / `raw_sender`, which sends, reactions, edits and revocations reuse. A re-keying pass runs at startup, after each history sync and every 30 s, and announces `reload` when it moved anything. Edits are accepted from the message's author only; revocations from the author, or anyone in a group (admins may delete others' messages; the engine cannot check the role). History is replayed oldest first so edits and revocations find their message; `WebMessageInfo.reactions` are kept too.

Photos: after each connection or `events.Picture`, a worker asks `GetProfilePictureInfo` (preview) for the 300 most recent chats and the authors of the last 3,000 group messages whose photo is older than a week, one every 400 ms, passing the kept picture id so an unchanged photo is not downloaded again. Downloads are https from `*.whatsapp.net` only, capped at 512 KiB. A hidden or absent photo is cached as none.

The Go cache stores send intents before their network attempt, and emits the record before that attempt. It turns surviving `sending` records into `uncertain` at startup, and never replays them automatically. The GTK window gives the text back as a draft only when the send provably never left: an `error` naming its id, the helper exited with no record of it, or a restarted helper replayed its cache without it. A stale error from another command never counts. An ambiguous network outcome is shown as unconfirmed rather than restoring a tempting duplicate-send draft.

## Commands and synthetic checks

See `apps/desktop/whatsapp/README.md` for the helper's build. On this Windows machine the Rust gate runs in the Fedora container directly (see the project memory): `cargo fmt`, `cargo clippy --workspace --all-targets -D warnings`, `cargo test -p rv-core --test whatsapp`, `cargo test -p rv-core --lib whatsapp`.

`RV_CARGO_TARGET=/cargo/target-desktop apps/desktop/scripts/smoke-whatsapp.sh` runs the app under Xvfb with an unlocked keychain and the synthetic helper (`RV_WHATSAPP_HELPER`), which scans its own QR after `RV_FAKE_WHATSAPP_SCAN_MS`: Connect WhatsApp, QR dialog, account opened, names, unread count, messages, text-only composer, a send, my photo, a new conversation. Screenshots go to `.cache/whatsapp/`. An automatic capture must never run against a real linked account.

## Verification record

2026-10-12, on `claude/whatsapp-feasibility`, Windows host with Docker Desktop:

- Go: `apps/desktop/scripts/build-whatsapp.sh` (gofmt, `go vet`, `go test -race`) passes; the tests cover the sealed state and its growth after a restore, pruning, author-only edits and revocations, reactions, unread counts and receipts, replies, phone numbers. `TARGET_OS=windows PROFILE=release` cross-builds `rv-whatsapp.exe` with mingw-w64; it imports only `KERNEL32.dll` and `msvcrt.dll`.
- Rust, in `rocket-vibe-rs-build` with `CARGO_TARGET_DIR=/cargo/target-desktop`: `cargo fmt --check` and `cargo clippy --workspace --all-targets -D warnings` pass; `cargo test -p rv-core --lib whatsapp` (8), `--test whatsapp` (6, real child processes: pairing, send, refused send, react, unlink, stop; `WaSession` listing, reading, notifying only a new message, unlinking, ending when its state is gone, stopping without unlinking), `--test supervisor` (3) and `cargo test -p rocket-vibe-gtk --bins` (15) pass.
- GTK smoke: `smoke-whatsapp.sh` passes every check (QR dialog, account opened and active, names, unread count, messages, text-only composer, a send, my photo, a new conversation found, opened and written to); `link.png` and `chat.png` inspected (rail tile, sections, badge, photos, reaction chip, quote card, Read under my message, account named WhatsApp).
- Live, by the user on Windows: the first package (run 38256657698) paired and listed conversations, with numbers instead of names and no photos or reactions, which the next increments answer. Launching the second package (run 38267472381) found the helper unable to start on the state the first session sealed: SQLite's deserialized image could not grow ("database or disk is full"), so no linked device had ever survived a restart. Reproduced in Docker with the first helper's state, fixed (restore through the backup API), and the fixed helper restarted on the user's real state (the state grew from 1.29 to 1.55 MB as it synced).
- Live, by the user on Windows with the integrated package (run 38274025137, helper of `cc69fa57`): the pilot's device was adopted at startup without a scan (its helper started on `whatsapp-pilot/`), and the user confirmed WhatsApp in the account rail.
- Live: the user then received no new message. The opt-in diagnostic log (`RV_WHATSAPP_LOG`) showed whatsmeow's "Node handling is taking long" on the first message received offline, and its goroutine dump showed the decryption transaction waiting for a second database connection (`message.go:606` reading the identity store outside its transaction). With the shared in-memory cache (`15642da5`), the 10 waiting messages arrived, offline sync completed, the state was sealed again, and the user confirmed messages arrive.
- Not yet checked live: notifications in the background, unlinking, attachments shown and sent (run 38279855876 onwards), typing, upstream failure scenarios.
- macOS GTK runtime, SwiftUI, Android: absent. Web: `n/a`.

Update this record with actual commands and evidence, never with intended results.

## Live test on Windows

1. `gh workflow run desktop.yml --ref claude/whatsapp-feasibility` (one dispatch at a time: a second cancels the first), then `gh run download <id> -n desktop-windows` and unzip the portable zip under `D:\RocketVibe\artifacts\`.
2. Build the helper of the same commit (`git archive <sha> apps/desktop/whatsapp`, then `TARGET_OS=windows PROFILE=release apps/desktop/scripts/build-whatsapp.sh` or the same cross-build in a scratch copy) and put `rv-whatsapp.exe` in the package's `bin\`, next to `rocket-vibe-gtk.exe`. A helper and an app of different commits mostly work (unknown frames are skipped) but say nothing about either.
3. Launch `bin\rocket-vibe-gtk.exe`. A device linked by an earlier pilot build is adopted at startup as an account; otherwise Connect WhatsApp on the sign-in page (or the rail's +, then the sign-in page) shows the QR. The key goes to Windows Credential Manager (service `me.barrut.RocketVibe`, entry `whatsapp-storage-v1|<state>`, or `whatsapp-pilot-storage-v1` for the adopted one), the sealed state to `%LOCALAPPDATA%\rocket-vibe-rs\whatsapp\<state>\` (`whatsapp-pilot\` for the adopted one).
4. To start over: the account menu's Unlink WhatsApp (or remove the device on the phone). Deleting the state alone leaves the device linked on the phone's side.

## Known limitations and next work

1. Live-check the integrated account on Windows: adoption of the pilot's device, notifications in the background, unlink from the menu and from the phone, a restart with the phone offline, an interrupted send.
2. Media: receiving (`media.go`, `download`, `media::Provider::WhatsApp`) and sending (`upload.go`, `upload`, `attach::send_all_whatsapp`) are done; videos other than MP4 go as documents (no transcoding), and outgoing GIFs too. Thumbnails are kept but not yet shown while the full file downloads; a caption shows above its image.
3. Typing and presence (`SendPresence`, `SubscribePresence`, chat presence events), and the rail tile's photo for the account.
4. Ship the helper in `desktop.yml` packages (Windows mingw cross-build or MSYS2, Linux, macOS), with whatsmeow's MPL-2.0 notice.
5. The pilot excludes view-once and disappearing message content; outgoing behaviour in a disappearing chat is not handled.
6. Qualify snapshot durability during a crash and keychain loss. The encrypted-file limit is 128 MiB; exceeding it stops the connection instead of silently discarding state. The in-memory database lives on database/sql's single pooled connection: a driver returning `ErrBadConn` would drop it (not observed).
7. A send blocks the helper's command loop for up to 45 s; a Stop during it is answered after the send, and the adapter kills the helper after 5 s, leaving the send `uncertain` at the next start.
8. Calls ring and can be declined (`calls.go`); talking is out of scope: whatsmeow implements no VoIP, and we do not reverse-engineer WhatsApp's proprietary call protocol (decided 2026-10-12).
9. SwiftUI facade (the FFI filters WhatsApp accounts out today), then Android through a `gomobile` binding of the engine, with a foreground service to receive in the background (WhatsApp sends no push to a linked device) or a relay, which is a separate privacy decision.

## Primary references

- [whatsmeow](https://github.com/tulir/whatsmeow): third-party Go linked-device protocol library, MPL-2.0. Calls are outside its implemented feature set (it sees call offers and can reject them). We build from our fork, [boubou666/whatsmeow](https://github.com/boubou666/whatsmeow) branch `rocketvibe`, chosen by the user so that fixes and calls can be done there.
- [whatsmeow API](https://pkg.go.dev/go.mau.fi/whatsmeow): QR channel, event and send interfaces.
- [Meta multi-device architecture](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/): independent device keys and encrypted recent-history transfer.
- [Meta Business Platform](https://www.postman.com/meta/whatsapp-business-platform/overview): separate professional messaging API, not a personal-account import.
- [Meta interoperability](https://engineering.fb.com/2024/03/06/security/whatsapp-messenger-messaging-interoperability-eu/): provider agreement and security requirements; distinct from this linked-account pilot.

