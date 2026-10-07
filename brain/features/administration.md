# Server administration and reports

An administrator of the open server gets a separate administration screen: a Dashboard of the deployment and its counts, the Moderation of members' reports, every Rooms and every Users with their actions. Every member can report a message or an account to the administrators. Both providers (Rocket.Chat and RocketVibe) map to one client model per app, so the screens never know which server they talk to. On RocketVibe a deleted account is a tombstone whose messages stay, shown as "Deleted user".

## The model and the contract per provider

One neutral model per app: mobile `lib/admin.ts` (`ProviderAdmin`, `ProviderReports`, `AdminOverview`, `AdminUser`, `AdminRoom`, `ReportedMessage`, `ReportedUser`, `AdminPage`), desktop `rv-core/src/admin.rs` (`Overview`, `AdminUser`, `UserLite`, `AdminRoom`, `ReportedMessage`, `ReportedUser`, `Page`, and `enum Admin { RocketChat(Arc<Session>), Native(Arc<NativeSession>) }` whose async methods both desktop UIs call).

- **Overview**: product, version, latest published version, uptime, database ("MongoDB 8.0.32 (wiredTiger)" or "PostgreSQL 18.1"), migration, runtime (Node on Rocket.Chat, none on RocketVibe), instance id; users (total, active, deactivated, admins, online, away, busy, offline), rooms and messages by kind (public, private, direct, plus discussions on Rocket.Chat and encrypted on RocketVibe; `null` / `None` where a server does not count it), uploads (count, bytes), open reports (messages, accounts).
- **Lists** are paged by the server (50 per page) and searched by the server: users, rooms, reported messages, reported accounts. A reported item carries its count and latest report; its reasons come with it (RocketVibe, up to 20) or are read lazily when the item opens (Rocket.Chat).
- **Actions**: give or remove the admin right, activate or deactivate, delete an account (confirmed, destructive); dismiss a message's reports, delete the reported message, deactivate its author; dismiss an account's reports, deactivate it. My own account offers no action (the server refuses it too: `self_administration` on RocketVibe).
- **Reports**: a required reason, trimmed, 1 to 1,000 characters (`reportReason` / `valid_reason`, `REPORT_REASON_MAX` / `REASON_MAX`).

### Who is an administrator

- Rocket.Chat: `me.roles` contains `admin` (mobile `AdminRC.isAdmin`; desktop `Session::roles`, read once per session with the permissions, then `rc::is_admin`).
- RocketVibe: the server advertises the `administration` capability AND `GET /api/v1/me/permissions` grants `manage_accounts` or `manage_instance` (mobile `NativeAdmin.isAdmin`, desktop `NativeSession::administrator`).
- A failure counts as "not an administrator" for that check; nothing is shown. Mobile caches the verdict per provider object and session generation, failures excepted (`ui/adminAccess.ts`).

### Latest version

Fetched by the client from GitHub, kept for the screen's life, shown as "Update available: X" or "Up to date", nothing when unknown. Rocket.Chat: `RocketChat/Rocket.Chat` `releases/latest`, `tag_name` (a leading `v` tolerated). RocketVibe: the newest `server-vX.Y.Z` tag among the releases of `Guillaume69/rocket-vibe` (`rv_core::update::REPO`); none is published yet, so "unknown" is today's normal result. Drafts and pre-releases never count. Mobile `fetchLatestVersion` / `latestFromReleases` / `updateStatus` in `lib/admin.ts`; desktop `admin::latest_version`, `latest_server_tag`, `update_available` over `update::github_json`.

## Rocket.Chat mapping

Probed on the 8.5.1 bench as admin (2026-10-07); the facts are in `CLAUDE.md` ("Administration endpoints"). Mobile `providers/rocketchat/admin.ts` (`AdminRC`, `rcReports`), desktop `rv-core/src/admin.rs` (module `rc`).

| Need | Endpoint |
|---|---|
| Overview | `statistics?refresh=true` (cached snapshot without it); admins from `roles.getUsersInRole?role=admin` (`total`); open reports from `moderation.reportsByUsers` and `moderation.userReports` |
| Users | `users.listByStatus` with `searchTerm` (`users.list` refuses `filter` and ignores `query`); no creation date in either |
| Admin right | `roles.addUserToRole` / `roles.removeUserFromRole` `{roleId: "admin", username}` |
| Activation | `users.setActiveStatus {userId, activeStatus, confirmRelinquish: true}` |
| Delete | `users.delete {userId, confirmRelinquish: true}`; the messages follow the server's own erasure setting, which the confirmation says |
| Rooms | `rooms.adminRooms` with `filter`, every type, DMs included, no last-message date |
| Reported messages | `moderation.reportsByUsers` is grouped by AUTHOR, so each page fans out to `moderation.user.reportedMessages?userId=` per author and regroups per message; reasons `moderation.reports?msgId=` |
| Message actions | dismiss `moderation.dismissReports {msgId}`; delete = `chat.delete {roomId, msgId}` then the dismissal |
| Reported accounts | `moderation.userReports`; reasons `moderation.user.reportsByUserId?userId=`; dismiss `moderation.dismissUserReports {userId}` |
| Report | `chat.reportMessage {messageId, description}`, `moderation.reportUser {userId, description}` |

Admins bypass the REST rate limit (`api-bypass-rate-limit`), which makes the per-author fan-out affordable. The open message report count is the sum of the per-author `count` of the first 100 authors in both apps (`moderation.reportsByUsers`'s `total` counts authors, not reports).

## RocketVibe contract

`docs/protocol/ADMINISTRATION.md`, "In-app administration", is the contract; the route table is in `docs/protocol/README.md`, the types in `crates/rv-protocol/src/admin.rs`, the server in `apps/server/src/admin.rs` (migration `apps/server/migrations/0050_administration.sql`). In short:

- Capabilities `administration` (the `/api/v1/admin/*` routes, which need `users.admin`, else 403 `permission_denied`) and `reports` (members report). Routes: `GET /admin/overview`, `/admin/users`, `/admin/rooms` (direct conversations included), `/admin/reports/messages`, `/admin/reports/users`; `PATCH /admin/users/{id}`, `POST /admin/users/{id}/delete`, the dismiss and moderation-delete routes; `POST /messages/{message}/report`, `POST /users/{user}/report`.
- Every command carries an `operation_id` whose receipt the server keeps per acting account for seven days; account changes carry the account's `revision` (`409 revision_conflict` when stale). Guards: `409 self_administration`, `409 last_administrator`, `409 self_report`.
- **Admin rights open no private content.** A message's text reaches an admin only through an open report, which its reporter disclosed; moderation deletes only a reported message; private (E2EE) messages are not in the server's `messages`, so they cannot be reported.
- **Deletion is a tombstone**: the account row stays so its messages keep their author; username `deleted-<id>` (the `deleted-` prefix is reserved), credentials, factors, devices, sessions and memberships removed, a room left without owner promotes its earliest remaining member, open reports about it closed. The wire `User` carries `deleted: true`.
- Every mutation and report lands in `operator_audit` with `actor_id`, never with a message text or reason.

Clients: mobile `providers/rocketvibe/admin.ts` (`NativeAdmin`, `nativeReports`), every call through `NativeChat.administration` (verified session, same server identity, same generation, the capability checked again, a fresh `operation_id`); desktop `rv-core/src/native/admin.rs` (`NativeSession` methods over `rv-client`), whose client mask advertises `administration` and `reports`.

## Mobile

- **Entry points**, only for an administrator (`useServerAdmin`, `ui/adminAccess.ts`): the "Server administration" card at the bottom of the settings list (`app/settings/index.tsx`), and a long press on the OPEN server's tile of the server rail (`ui/serverRail.tsx`, a native `Alert` with that choice); another server's tile does nothing more than a tap.
- **Screens** (`app/admin/`, full pages): `index.tsx` the Dashboard (deployment, latest version, counts) followed by rows to `moderation.tsx` (two tabs, messages and accounts, items expanded in place with lazily read reasons and their actions, destructive ones confirmed in a native `Alert`; a handled item leaves the list), `rooms.tsx` (read-only list: kind, counts, creation, read-only and encrypted marks) and `users.tsx` (avatar, badges admin / deactivated / bot, presence, creation, last activity; tapping expands the actions, my row has none; the delete confirmation names what happens to the messages per product). Shared pieces: `ui/adminKit.tsx` (error sentence per server code, paged and searchable list state).
- **Provider wiring**: `Provider.admin` and `Provider.reports` are optional members of the facade (`lib/provider.ts`), offered with `capabilities.administration` and `capabilities.reports`; the Rocket.Chat driver offers them to everyone and lets `isAdmin` decide.
- **Report a message**: "Report" in the long-press sheet (`app/message-actions.tsx`) for someone else's message that is not a system message (the decrypted `e2e` type counts as normal), never in a private RocketVibe conversation, and only with `capabilities.reports`. It swaps the actions for `ui/reportForm.tsx` like the edit swap; sending shows the "Report sent" toast and closes the sheet.
- **Report a user**: "Report this user" on a profile (`app/profile.tsx`), not on mine, same form in the sheet.
- **Deleted authors** (RocketVibe only): `lib/deletedUser.ts#isDeletedUsername` (the reserved `deleted-` prefix) turns the author and quote author of `ui/messageRow.tsx` into "Deleted user" and disables the profile card. No new column: the stored username is enough.

## Desktop

### GTK

- **Entry points**, only for an administrator: the "Server administration" link at the bottom of the settings sidebar (`rv-gtk/src/settings.rs`, CSS class `settings-admin`, shown once `Admin::is_admin` answers), and a right click or long press on the open account's rail button (`rv-gtk/src/rail.rs` `connect_menu`, the popover built in `rv-gtk/src/window.rs`); another account's button has no menu. `ChatPage::admin` / `open_admin` (`rv-gtk/src/chat.rs`) build the `Admin` of the open account.
- **The screen**: `rv-gtk/src/admin.rs::open(parent, Admin)` builds a `SidebarDialog` ([settings.md](settings.md)) opening on the Dashboard: cards two abreast in a `gtk::FlowBox` (deployment with the latest version, users, rooms, messages, uploads, reports) and a refresh; Moderation carries a badge with the open report count (`Host::set_badge`) and lists reported messages and accounts, each opening a subpage with lazily read reasons and its actions; Rooms; Users, whose subpage holds the actions (the delete text differs per product), my row reading "This is your account". Destructive actions confirm in an `adw::AlertDialog`; failures map server codes to sentences (`error_text`).
- **Reports**: "Report" in the message menu (`rv-gtk/src/actions_menu.rs` for Rocket.Chat: someone else's message, not a system line, not still in the outbox; `rv-gtk/src/chat_native.rs` for RocketVibe rooms: not deleted, not system, not mine, `reports_supported`, never a private conversation) and "Report this user" on a profile (`rv-gtk/src/details.rs`, not mine). Both open `admin::report`, an `adw::AlertDialog` with an entry; success toasts "Report sent".
- **Deleted authors** (RocketVibe): `rv_core::native::deleted_username`, `shown_username` and `deleted_user` (`rv-core/src/native.rs`); `native::store::MessageRow::presentation` shows the author as "Deleted user", and so do reaction user lists, quote cards and notifications built from the native store; admin lists and DM names in them go through `UserLite::shown`.

### SwiftUI

- **rv-ffi** (`rv-ffi/src/admin.rs`): `ServerAdmin`, one per open account from `Chat::admin()` or `NativeChat::admin()`, wraps rv-core's `Admin` with async exports for every read and action (`is_admin`, `overview`, `latest_version`, `users`, `set_admin`, `set_active`, `delete_user`, `rooms`, the report lists, reasons, dismissals, moderation delete, `deactivate_author`, `report_message`, `report_user`) over UniFFI records (`AdminOverview`, `AdminUser` with its photo as a path `MediaStore` reads, `AdminRoom`, `AdminReportedMessage`, `AdminReportedUser`, pages). A refusal is `RvError::Local` whose message is the server's code (`self_administration`, `last_administrator`, `revision_conflict`...). Free exports: `report_reason`, `report_reason_max`, `server_update_available`, `deleted_username`; `NativeChat::reports_supported`.
- **RocketVibeKit** (`macos/Sources/RocketVibeKit/AdminModel.swift`): `AdminCategory` (Dashboard, Moderation, Rooms, Users, the GTK order), `AdminText` (error sentences per code, dates, the update note), `AdminList` (one paged, searchable list; a generation counter drops an answer to an older query or reload, and a search reloads 250 ms after typing pauses), `AdminModel` (the screen: overview, latest version, the Moderation badge, the four lists, the opened item with lazily read reasons, the actions with their "Done" or failure notice, nothing applied once closed), `ReportTarget` and `ReportDraft` (the reason, cut at the longest the servers take). `AppModel` holds `administrator`, `admin` (the open `AdminModel`) and `reporting` (the open `ReportDraft`), with `refreshAdministrator`, `openAdmin` (closes the settings), `closeAdmin`, `startReport`, `sendReport`, `deletedAccount(username:)`; `ChatProvider.admin()` and `supportsReports` pick the provider.
- **Entry points**, administrator only: the "Server administration" link at the bottom of the settings sidebar (`SettingsView.swift`) and the context menu of the open account's rail tile (`ChatView.swift`); other tiles have no menu. A SwiftUI context menu is built synchronously, so `AppModel.administrator` is asked ahead: when a session starts and each time the settings open.
- **The screen** (`macos/Sources/RocketVibe/AdminView.swift`): `AdminOverlay` in the same `PanelOverlay` as the settings (dimmed backdrop, 85 % panel, one pane when narrow; `PanelOverlay` lives in `SettingsView.swift`), the Dashboard's cards two abreast when wide (`AdminDashboard`), searchable lists with "Show more" (`AdminSearch`, `AdminListRows`), item pages with their actions, destructive ones confirmed (`AdminConfirm`).
- **Reports**: "Report" in the message context menu (`RoomView.swift`, `RoomModel.canReport`: someone else's delivered message, not a system line, never a private conversation, and on RocketVibe only when the server takes reports) and "Report this user" on a profile (`Details.swift`, not mine, not a deleted account). Both open `ReportSheet`, a sheet of the window; from a profile, the profile sheet closes first and the report opens about 0.35 s later, the window showing one sheet at a time. The result shows as the window's toast.
- **Deleted authors**: native message rows get "Deleted user" from rv-core's native projection, which rv-ffi uses (`read_presentation::group` in `rv-ffi/src/native.rs`), reactions, quotes and notifications too; the admin records carry rv-core's shown name. `ProfileView` of a deleted RocketVibe account shows "Deleted user" with no `@username`, presence, Message, Call or Report.

## Limits

- Messages ingested before an author's deletion keep the old username until the server sends them again: the server does not republish authors (all apps).
- Private (E2EE) conversations: their rows are not built from the server's `User`, so no app applies the label there. Desktop (GTK and SwiftUI, `rv-core/src/native/crypto/enrollment/rooms/messages.rs`) names authors from the room's current member list, which a deleted account has left, so its messages show its raw user id; mobile (`providers/rocketvibe/cryptoProjection.ts`) shows the username the account's `users` table knows for that id, "Deleted user" only when that is already the `deleted-` placeholder.
- Names the RocketVibe server computes (DM names made of usernames at creation, room names) keep the old username; a profile lookup by the placeholder finds nothing.
- Rocket.Chat lists carry no account creation date and no room last-message date.

## Parity

[parity.md](../parity.md) §5, §8 and §15: the dashboard, moderation, rooms list, users with actions, reporting a message or a user are done in all three apps; the deleted-user label is partial in all three (the limits above).

## Sources

- docs/protocol/ADMINISTRATION.md
- docs/protocol/README.md
- crates/rv-protocol/src/admin.rs
- crates/rv-client/src/lib.rs
- apps/server/src/admin.rs
- apps/server/migrations/0050_administration.sql
- apps/mobile/lib/admin.ts
- apps/mobile/lib/deletedUser.ts
- apps/mobile/lib/provider.ts
- apps/mobile/providers/rocketchat/admin.ts
- apps/mobile/providers/rocketchat/index.ts
- apps/mobile/providers/rocketvibe/admin.ts
- apps/mobile/providers/rocketvibe/chat.ts
- apps/mobile/providers/rocketvibe/index.ts
- apps/mobile/ui/adminAccess.ts
- apps/mobile/ui/adminKit.tsx
- apps/mobile/ui/reportForm.tsx
- apps/mobile/ui/serverRail.tsx
- apps/mobile/ui/messageRow.tsx
- apps/mobile/app/admin/index.tsx
- apps/mobile/app/admin/moderation.tsx
- apps/mobile/app/admin/rooms.tsx
- apps/mobile/app/admin/users.tsx
- apps/mobile/app/settings/index.tsx
- apps/mobile/app/message-actions.tsx
- apps/mobile/app/profile.tsx
- apps/desktop/crates/rv-core/src/admin.rs
- apps/desktop/crates/rv-core/src/native/admin.rs
- apps/desktop/crates/rv-core/src/native.rs
- apps/desktop/crates/rv-core/src/native/store.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-core/src/update.rs
- apps/desktop/crates/rv-gtk/src/admin.rs
- apps/desktop/crates/rv-gtk/src/sidebar_dialog.rs
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/crates/rv-gtk/src/rail.rs
- apps/desktop/crates/rv-gtk/src/window.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/actions_menu.rs
- apps/desktop/crates/rv-gtk/src/chat_native.rs
- apps/desktop/crates/rv-gtk/src/details.rs
- apps/desktop/crates/rv-ffi/src/native.rs
- apps/desktop/crates/rv-ffi/src/admin.rs
- apps/desktop/crates/rv-core/src/native/crypto/enrollment/rooms/messages.rs
- apps/mobile/providers/rocketvibe/cryptoProjection.ts
- apps/desktop/macos/Sources/RocketVibeKit/AdminModel.swift
- apps/desktop/macos/Sources/RocketVibeKit/AppModel.swift
- apps/desktop/macos/Sources/RocketVibeKit/ChatProvider.swift
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
- apps/desktop/macos/Sources/RocketVibe/AdminView.swift
- apps/desktop/macos/Sources/RocketVibe/SettingsView.swift
- apps/desktop/macos/Sources/RocketVibe/ChatView.swift
- apps/desktop/macos/Sources/RocketVibe/RoomView.swift
- apps/desktop/macos/Sources/RocketVibe/Details.swift
