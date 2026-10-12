# WhatsApp account

A personal WhatsApp account linked by scanning a QR from the official phone app, the way WhatsApp Desktop is: the computer becomes a linked device with its own keys, and the account then lives in RocketVibe like any other (rail, room list, timeline, composer, notifications). It is a local third-party implementation of the linked-device protocol (whatsmeow), not Meta's Business API, and nothing goes through a RocketVibe server ([decision](../decisions.md#whatsapp-through-a-local-linked-device-helper-2026-10-12)). Desktop (GTK) only for now; work on `claude/whatsapp-feasibility`, live-tested by the user on Windows. Protocol details and the verification record: [the handoff](../../docs/WHATSAPP_HANDOFF.md).

## Desktop

**Helper.** A Go process (`apps/desktop/whatsapp/`) per account, beside the app (`rv-whatsapp`, or `RV_WHATSAPP_HELPER`). Its engine (`engine.go`) is transport-free; `main.go` speaks JSON lines over private pipes. Its SQLite stays in memory and reaches disk only sealed with AES-256-GCM (`vault.go`) under a key from the system keychain, one entry per account; a state without its key fails closed. Restoring goes through SQLite's backup API, since a deserialized image cannot grow.

**Account.** A `SessionInfo` with `base_url = whatsapp://<state id>`, `user_id` = the account's JID, no token, genre `whatsapp` in the keychain (`rv-core/src/whatsapp.rs`, `native.rs`); older builds and the SwiftUI app skip it. Places that read `base_url` as an http server check `whatsapp::is_whatsapp` first. `WaSession` (`rv-core/src/whatsapp_session.rs`) keeps the helper alive (restarts with back-off once the old one released its state lock), builds `RoomRow`s and the timeline from its snapshot, and is `provider::Chat::WhatsApp`: the supervisor counts its unread chats and keeps it connected in the background like any account.

**Adding.** The login page's Connect WhatsApp (shown when the helper is installed) opens a dialog with the QR on a new state (`rv-gtk/src/whatsapp_link.rs`); closing it abandons and erases that state. The device the earlier pilot window linked (`whatsapp-pilot/`) is adopted once at startup as the account `whatsapp://pilot`, its state and key left in place.

**Chats** (`rv-gtk/src/chat_whatsapp.rs`). Names resolved when shown, from the name table the helper refreshes as contacts sync (address book, push name, business name, group subject, else the number); a phone number and its LID make one conversation once WhatsApp maps them (`store.go`, `normalize`). Profile photos on tiles, beside messages and for my own account. Reactions (chips, quick reactions in the message menu), quoted replies (native quote card, Reply in the menu), my own messages edited in place (15 minutes) or deleted for everyone (48 hours, confirmation that closes on a backdrop click). Unread counts shared with the phone; the open chat is read while the window has the focus, with read receipts unless my privacy settings send none; Delivered, Read or Played under my latest message. New conversation searches the phone's contacts and groups, or a typed number WhatsApp confirms; the chat opens before its first message. A send is recorded before its network attempt; its text comes back as a draft only when it provably never left, and an unconfirmed one is never sent again. Notifications for new messages (not what was there when the helper connected). Unlinking from the account menu asks WhatsApp to forget the device; a failure keeps the account, an unlink from the phone ends it.

**Hidden** because WhatsApp has no equivalent here yet: search, pins and stars, threads, calls, files and voice notes, room details and settings, reminders. Media, typing, presence and complete history are not there yet; view-once and disappearing content is never kept.

**Not packaged**: release builds do not ship the helper (`TARGET_OS=windows apps/desktop/scripts/build-whatsapp.sh` builds it for Windows by hand).

SwiftUI: missing (the FFI filters WhatsApp accounts out of the shared keychain index).

## Mobile

Missing. The Go engine is meant to be embedded on Android through a `gomobile` binding of the same engine; receiving in the background needs the app to keep the connection itself (a foreground service), since WhatsApp sends no push to a linked device, or a relay, which is a separate privacy decision.

## Web

`n/a`: the web app speaks to its serving RocketVibe origin only.

## Sources

- apps/desktop/whatsapp/engine.go
- apps/desktop/whatsapp/main.go
- apps/desktop/whatsapp/store.go
- apps/desktop/whatsapp/identity.go
- apps/desktop/whatsapp/avatars.go
- apps/desktop/whatsapp/reads.go
- apps/desktop/whatsapp/search.go
- apps/desktop/whatsapp/vault.go
- apps/desktop/whatsapp/vault_test.go
- apps/desktop/whatsapp/README.md
- apps/desktop/crates/rv-core/src/whatsapp.rs
- apps/desktop/crates/rv-core/src/whatsapp_session.rs
- apps/desktop/crates/rv-core/src/provider.rs
- apps/desktop/crates/rv-core/src/native.rs
- apps/desktop/crates/rv-core/tests/whatsapp.rs
- apps/desktop/crates/rv-core/tests/support/fake_whatsapp_sidecar.rs
- apps/desktop/crates/rv-gtk/src/chat_whatsapp.rs
- apps/desktop/crates/rv-gtk/src/whatsapp_link.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-gtk/src/secrets.rs
- apps/desktop/crates/rv-gtk/src/smoke/whatsapp.rs
- apps/desktop/crates/rv-ffi/src/accounts.rs
- apps/desktop/scripts/build-whatsapp.sh
- apps/desktop/scripts/smoke-whatsapp.sh
- docs/WHATSAPP_HANDOFF.md
