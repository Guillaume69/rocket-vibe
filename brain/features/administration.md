# Server administration and reports

An administrator of the open server gets a separate administration screen: a Dashboard of the deployment and its counts, the Moderation of members' reports, every Rooms and every Users with their actions. Every member can report a message or an account to the administrators. Both providers (Rocket.Chat and RocketVibe) map to one client model per app, so the screens never know which server they talk to. On RocketVibe a deleted account is a tombstone whose messages stay, shown as "Deleted user".

## The model and the contract per provider

One neutral model per app: mobile `lib/admin.ts` (`ProviderAdmin`, `ProviderReports`, `AdminOverview`, `AdminUser`, `AdminRoom`, `ReportedMessage`, `ReportedUser`, `AdminPage`, the `LastOwnerError` and `BulkDeleteRequired` refusals, `verdictCache`), desktop `rv-core/src/admin.rs` (`Overview`, `AdminUser`, `UserLite`, `AdminRoom`, `ReportedMessage`, `ReportedUser`, `Page`, `AdminError` with its optional `LastOwner` and `count`, `error_key`, and `enum Admin { RocketChat(Arc<Session>), Native(Arc<NativeSession>) }` whose async methods both desktop UIs call).

- **Bots** (RocketVibe only): a dashboard card with the switch "Users can create bots" (`instance.user_bots`, administrators always can), and bots marked in the Users list ([bots.md](bots.md)).
- **Overview**: product, version, latest published version, uptime, database ("MongoDB 8.0.32 (wiredTiger)" or "PostgreSQL 18.1"), migration, runtime (Node on Rocket.Chat, none on RocketVibe), instance id, and on Rocket.Chat the date of the figures (`asOf` / `as_of`); users (total, active, deactivated, admins, online, away, busy, offline), rooms and messages by kind (public, private, direct, plus discussions on Rocket.Chat and encrypted on RocketVibe; `null` / `None` where a server does not count it), uploads (count, bytes), open reports (messages, accounts). A figure the account may not read (a 403 on `roles.getUsersInRole` or `moderation.*`) is unknown and shows as "-": it never fails the dashboard.
- **Lists** are paged by the server (50 per page) and searched by the server: users, rooms, reported messages, reported accounts. A reported item carries its count and latest report; its reasons come with it (RocketVibe, up to 20) or are read lazily when the item opens (Rocket.Chat).
- **Actions**: give or remove the admin right, activate or deactivate, delete an account (confirmed, destructive); dismiss a message's reports, delete the reported message, deactivate its author; dismiss an account's reports, deactivate it. My own account offers no action (the server refuses it too: `self_administration` on RocketVibe). An action that ends after the user moved to another page leaves that page alone.
- **Errors** read the same in every app: the server's code maps to one sentence (mobile `ui/adminKit.tsx`, desktop `admin::error_key`, exported to Swift as `admin_error_key`): `last_administrator` and Rocket.Chat's `error-admin-required` give the last-administrator text, `not_found` "not found", `self_report` the report-specific text, an offline failure the offline text.
- **Reports**: a required reason, trimmed, 1 to 1,000 characters (`reportReason` / `valid_reason`, `REPORT_REASON_MAX` / `REASON_MAX`; Swift's `ReportDraft` counts Unicode scalars like rv-core).

### Who is an administrator

- Rocket.Chat: `me.roles` contains `admin` (mobile `AdminRC.isAdmin`; desktop `admin::rc::roles`, which reads `me` on every `is_admin`, then `rc::is_admin`).
- RocketVibe: the server advertises the `administration` capability AND `GET /api/v1/me/permissions` grants `manage_accounts` or `manage_instance` (mobile `NativeAdmin.isAdmin`, desktop `NativeSession::administrator`).
- A failure counts as "not an administrator" for that check; nothing is shown. Mobile caches the verdict per provider object and session generation, failures excepted (`verdictCache` in `lib/admin.ts`, used by `ui/adminAccess.ts`).

### Latest version

Fetched by the client from GitHub, kept for the screen's life, shown as "Update available: X" or "Up to date", nothing when unknown. Rocket.Chat: the highest non-draft, non-prerelease version of `RocketChat/Rocket.Chat` `releases?per_page=30`, because `releases/latest` can name a backport of an older line. RocketVibe: the highest `server-vX.Y.Z` tag among the releases of `Guillaume69/rocket-vibe` (`rv_core::update::REPO`), pre-releases (`-rc`) ignored; none is published yet, so "unknown" is today's normal result. Mobile `fetchLatestVersion` / `latestFromReleases` / `updateStatus` in `lib/admin.ts`; desktop `admin::latest_version`, `highest_release`, `latest_server_tag`, `update_available` over `update::github_json`.

## Rocket.Chat mapping

Probed on the 8.5.1 bench as admin (2026-10-07/08); the facts are in `CLAUDE.md` ("Administration endpoints"). Mobile `providers/rocketchat/admin.ts` (`AdminRC`, `rcReports`), desktop `rv-core/src/admin.rs` (module `rc`).

| Need | Endpoint |
|---|---|
| Overview | `statistics`, the last stored snapshot dated by `createdAt`; `statistics?refresh=true` only from the refresh button (it inserts a statistics document and aggregates the whole workspace); admins from `roles.getUsersInRole?role=admin` (`total`); open reports from `moderation.reportsByUsers` and `moderation.userReports` |
| Users | `users.listByStatus` with `searchTerm` (`users.list` refuses `filter` and ignores `query`); no creation date; `avatarETag` absent means no photo, drawn with the no-photo marker ([avatars](avatars.md)) |
| Admin right | `roles.addUserToRole` / `roles.removeUserFromRole` `{roleId: "admin", username}`; removing the last admin answers `error-admin-required` |
| Activation, deletion | `users.setActiveStatus {userId, activeStatus}`, `users.delete {userId}`, first WITHOUT `confirmRelinquish`. A last owner of rooms gets 400 `user-last-owner` with `details: {shouldBeRemoved, shouldChangeOwner}`: a second confirmation names the rooms deleted with the account and those whose owner changes, then the call is repeated with `confirmRelinquish: true`. The delete confirmation says that Rocket.Chat also deletes the person's direct conversations and that the messages follow the server's own erasure setting |
| Rooms | `rooms.adminRooms` with `types[]` `c`, `p`, `d`, `discussions`, `teams` (without them discussions and team main rooms are hidden) and `filter`; no last-message date and no `encrypted` in its projection |
| Reported messages | `moderation.reportsByUsers` is grouped by AUTHOR, so each page of 20 authors fans out (8 at a time) to `moderation.user.reportedMessages?userId=`, which has one entry per message; each message's own count is `moderation.reports?msgId=&count=1` (`total`), its reasons the same route. A message of an encrypted room (`t: "e2e"`) reads "Encrypted message", never the ciphertext |
| Message actions | dismiss `moderation.dismissReports {msgId}`; delete = `chat.delete {roomId, msgId}` then the dismissal. `chat.delete` needs access to the room: in a DM or private group the admin is not in it fails `error-action-not-allowed`, and the app then offers, explicitly and with the number of messages, Rocket.Chat's only alternative, `moderation.user.deleteReportedMessages {userId}`, which deletes ALL that author's reported messages |
| Reported accounts | `moderation.userReports`; reasons `moderation.user.reportsByUserId?userId=`; dismiss `moderation.dismissUserReports {userId}` |
| Report | `chat.reportMessage {messageId, description}`, `moderation.reportUser {userId, description}` |

Admins bypass the REST rate limit (`api-bypass-rate-limit`), which makes the per-author fan-out affordable. The open message report count is the sum of the per-author `count` of the first 100 authors of `moderation.reportsByUsers` in all apps (mobile `providers/rocketchat/admin.ts`, desktop `rc::overview`): that endpoint's `total` counts authors, not reports.

## RocketVibe contract

`docs/protocol/ADMINISTRATION.md`, "In-app administration", is the contract; the route table is in `docs/protocol/README.md`, the types in `crates/rv-protocol/src/admin.rs`, the server in `apps/server/src/admin.rs` (migration `apps/server/migrations/0051_administration.sql`). In short:

- Capabilities `administration` (the `/api/v1/admin/*` routes, which need `users.admin`, else 403 `permission_denied`) and `reports` (members report). Routes: `GET /admin/overview`, `/admin/users`, `/admin/rooms` (direct conversations included), `/admin/reports/messages`, `/admin/reports/users`; `PATCH /admin/users/{id}`, `POST /admin/users/{id}/delete`, the dismiss and moderation-delete routes; `POST /messages/{message}/report`, `POST /users/{user}/report`. Custom emoji: `PUT`/`DELETE /admin/emoji/{name}` with the `custom_emoji_admin` capability (above). Users and rooms pages resume on an opaque cursor carrying the sort key and the id, so a rename or a deletion between two pages neither skips nor repeats a row.
- Every command carries an `operation_id` whose receipt the server keeps per acting account for seven days; account changes carry the account's `revision` (`409 revision_conflict` when stale). A reported message carries `author_revision` (none for a deleted author), so an admin deactivates the author without searching the users list. Guards: `409 self_administration`, `409 last_administrator` (the CLI keeps the last active administrator too), `409 self_report`.
- **Admin rights open no private content.** A message's text reaches an admin only through an open report, as the reporters saw it: each report keeps a snapshot of the text at report time, and the admin reads the newest one, not the live message. Moderation deletes only a reported message; private (E2EE) messages are not in the server's `messages`, so they cannot be reported.
- A reporter holds at most 200 open reports, messages and accounts together; beyond, `429 report_limit`.
- **Deletion is a tombstone**: the account row stays so its messages keep their author; username `deleted-<id>` (the `deleted-` prefix is reserved), credentials, factors, devices, sessions and memberships removed, as well as pending e-mail recoveries, E2EE root and history backups and the avatar object; a room left without owner promotes its earliest remaining member; open reports about it closed. The former username is retired (`retired_usernames`): nobody can take it again. The wire `User` carries `deleted: true`.
- Every mutation and report lands in `operator_audit` with `actor_id`, never with a message text or reason.

Clients: mobile `providers/rocketvibe/admin.ts` (`NativeAdmin`, `nativeReports`), every call through `NativeChat.administration` (verified session, same server identity, same generation, the capability checked again, a fresh `operation_id`); desktop `rv-core/src/native/admin.rs` (`NativeSession` methods over `rv-client`), whose client mask advertises `administration` and `reports`. A direct conversation in the rooms list is named by its members, a deleted one as "Deleted user".

## Custom emoji

An administrator adds and deletes the server's custom emoji ([emoji](emoji.md) for how they render). The name and the aliases (comma-separated) are checked by the app first, the same rule everywhere: 1 to 80 lowercase ASCII letters, digits, `_` or `-`, at most 8 aliases, no repeat, never a standard emoji's code (its glyph would win at render). Rocket.Chat would otherwise rewrite a name silently (`Bad Name!` becomes `bad_name`). Images: PNG, JPEG or GIF, 1 MiB at most (RocketVibe's limit, applied to both). There is no editing: delete, then add again.

- **Rocket.Chat**: `emoji-custom.list` to list (the id is kept for deletion), `emoji-custom.create` multipart (`emoji` file, `name`, `aliases` comma-separated) to add, `emoji-custom.delete {emojiId}` to delete. The `manage-emoji` permission belongs to `admin` by default, so the category is offered to every administrator. Refusals come as `errorType`: `not_authorized` (400, a member), `Custom_Emoji_Error_Name_Or_Alias_Already_In_Use`, `emoji-is-not-image`.
- **RocketVibe**: `PUT /api/v1/admin/emoji/{name}` (raw image, `?operation_id=&aliases=`) and `DELETE /api/v1/admin/emoji/{name}` (`?operation_id=&expected_revision=`), both answering the new `EmojiCatalog`, offered with the `custom_emoji_admin` capability (`docs/protocol/CUSTOM_EMOJIS.md`). The server keeps the receipts per administrator like its other commands, and the operator journal names the administrator. A taken name is `409 revision_conflict`, an alias another entry holds `409 emoji_code_conflict`, a standard code `400 emoji_name_reserved`.
- **After a change** each app reads the catalogue again at once, so its pickers and messages follow: on Rocket.Chat the desktop session's index is now replaced rather than extended (`Session::refresh_custom_emojis`), so a deletion leaves the pickers too; other connected apps of a Rocket.Chat server see the change at their next session, those of a RocketVibe server through `emoji_catalog_revision`.

Where: mobile `app/admin/emoji.tsx` (form with the photo picker, list, delete confirmed in an `Alert`; `ProviderAdmin.canManageEmojis`, `emojis`, `createEmoji`, `deleteEmoji`, `lib/admin.ts#emojiCodes`; the multipart transport `transportEmojiExpo` and the bytes reader are injected by the screen; `useSync().refreshCustomEmojis`); desktop `rv_core::admin::{Admin::emoji_supported, emojis, create_emoji, delete_emoji, emoji_codes}`, GTK `rv-gtk/src/admin_emoji.rs` (list, an "Add" subpage, delete in an `adw::AlertDialog`), SwiftUI `AdminModel` (`.emoji` category, `emojis`, `createEmoji`, `deleteEmoji`) and `AdminEmojiSections` in `AdminView.swift` over rv-ffi `ServerAdmin::{emoji_supported, emojis, create_emoji, delete_emoji}`; web `apps/web/src/admin.ts#emojiPage`.

## Server icon

An administrator sets or removes the server's icon, which every app's server rail shows instead of the host's initial ([login-and-servers](login-and-servers.md)), from a Server icon card on the Dashboard (current icon, Change, Remove after a confirmation).

- **Rocket.Chat**: the `favicon_192` asset. `assets.setAsset` multipart (`asset` file, `assetName`) **demands exactly 192 by 192 pixels** (`error-invalid-file-width` otherwise) and a PNG or JPEG (`error-invalid-file-type`); `assets.unsetAsset {assetName}` removes it. `manage-assets` belongs to `admin`. So the apps crop the picked image's center square and scale it to 192 px PNG first (mobile the photo picker's square crop then `expo-image-manipulator`; GTK `gdk_pixbuf` in `admin.rs#square_png`; SwiftUI `AdminIconCard.squarePNG`). The web client is RocketVibe-only.
- **RocketVibe**: `PUT /api/v1/admin/icon` with the raw image and `DELETE`, both `?operation_id=`, capability `instance_icon` (`docs/protocol/ADMINISTRATION.md`); the server crops and scales to a 256 px PNG itself, keeps per-administrator receipts, journals `instance.icon`, and moves `Discovery.icon_revision`. The image is public at `GET /api/v1/instance/icon`. The web tab's favicon follows it (`App.serverIcon`).

Where: mobile `ui/adminIcon.tsx` (`ProviderAdmin.canSetIcon`, `setIcon`, the multipart transport `transportAssetExpo`); desktop `rv_core::admin::{Admin::icon_supported, set_icon}` and `rv_core::server_icon`, GTK `admin.rs#icon_card`, SwiftUI `AdminModel.{iconSupported, icon, loadIcon, setIcon}` and `AdminIconCard` over rv-ffi `ServerAdmin::{icon_supported, icon, set_icon}` and `icon_side`; web `apps/web/src/admin.ts#iconCard`.

## Mobile

- **Entry points**, only for an administrator (`useServerAdmin`, `ui/adminAccess.ts`): the "Server administration" card at the bottom of the settings list (`app/settings/index.tsx`), and a long press on the OPEN server's tile of the server rail (`ui/serverRail.tsx`, a native `Alert` with that choice); another server's tile does nothing more than a tap.
- **Screens** (`app/admin/`, full pages): `index.tsx` the Dashboard (deployment, latest version, counts, the figures' date with a Refresh action and pull to refresh) followed by rows to `moderation.tsx`, `emoji.tsx` (when `canManageEmojis`, see Custom emoji above), (two tabs, messages and accounts, items expanded in place with lazily read reasons and their actions, destructive ones confirmed in a native `Alert`; a handled item leaves the list), `rooms.tsx` (read-only list: kind, counts, creation, read-only and encrypted marks) and `users.tsx` (avatar, badges admin / deactivated / bot, presence, creation, last activity; tapping expands the actions, my row has none; the delete confirmation names what happens to the messages per product). The Rocket.Chat second confirmations (last owner, bulk delete) are further `Alert`s. Dates and numbers follow the app's language. Shared pieces: `ui/adminKit.tsx` (error sentence per server code, paged and searchable list state whose rows always belong to the latest query: a failed first page never shows the previous query's rows).
- **Provider wiring**: `Provider.admin` and `Provider.reports` are optional members of the facade (`lib/provider.ts`), offered with `capabilities.administration` and `capabilities.reports`; the Rocket.Chat driver offers them to everyone and lets `isAdmin` decide.
- **Report a message**: "Report" in the long-press sheet (`app/message-actions.tsx`) for someone else's message that is not a system message (the decrypted `e2e` type counts as normal) and not deleted, never in a private RocketVibe conversation, and only with `capabilities.reports`. It swaps the actions for `ui/reportForm.tsx` like the edit swap; sending shows the "Report sent" toast and closes the sheet.
- **Report a user**: "Report this user" on a profile (`app/profile.tsx`), not on mine, same form in the sheet.
- **Deleted authors** (RocketVibe only): `lib/deletedUser.ts#isDeletedUsername` (the reserved `deleted-` prefix) turns the author and quote author of `ui/messageRow.tsx` into "Deleted user" and disables the profile card. No new column: the stored username is enough.

## Desktop

### GTK

- **Entry points**, only for an administrator: the "Server administration" link at the bottom of the settings sidebar (`rv-gtk/src/settings.rs`, CSS class `settings-admin`, shown once `Admin::is_admin` answers), and a right click or long press on the open account's rail button (`rv-gtk/src/rail.rs` `connect_menu`, the popover built in `rv-gtk/src/window.rs`); another account's button has no menu. `ChatPage::admin` / `open_admin` (`rv-gtk/src/chat.rs`) build the `Admin` of the open account.
- **The screen**: `rv-gtk/src/admin.rs::open(parent, Admin)` builds a `SidebarDialog` ([settings.md](settings.md)) opening on the Dashboard: cards in a two-column masonry (`Cards`: two vertical boxes filled in reading order, each column as tall as its own cards, one column when narrow) for the deployment with the latest version, the figures' date and a refresh button, users, rooms, messages, uploads and reports; Moderation carries a badge with the open report count (`Host::set_badge`) and lists reported messages and accounts, each opening a subpage with lazily read reasons and its actions; Rooms; Users, whose subpage holds the actions; Custom emoji when `Admin::emoji_supported` (`admin_emoji.rs`) (the delete text differs per product), my row reading "This is your account". Destructive actions and the Rocket.Chat second confirmations (last owner, bulk delete) ask in an `adw::AlertDialog`; failures go through `admin::error_key`. An action that ends goes back only from its own page (`Host::pop_if`).
- **Reports**: "Report" in the message menu (`rv-gtk/src/actions_menu.rs` for Rocket.Chat: someone else's message, not a system line, not still in the outbox; `rv-gtk/src/chat_native.rs` for RocketVibe rooms: not deleted, not system, not mine, `reports_supported`, never a private conversation) and "Report this user" on a profile (`rv-gtk/src/details.rs`, not mine). Both open `admin::report`, an `adw::AlertDialog` with an entry; success toasts "Report sent".
- **Deleted authors** (RocketVibe): `rv_core::native::deleted_username`, `shown_username` and `deleted_user` (`rv-core/src/native.rs`); `native::store::MessageRow::presentation` shows the author as "Deleted user", and so do reaction user lists, quote cards and notifications built from the native store; admin lists and DM names in them go through `UserLite::shown`.

### SwiftUI

- **rv-ffi** (`rv-ffi/src/admin.rs`): `ServerAdmin`, one per open account from `Chat::admin()` or `NativeChat::admin()`, wraps rv-core's `Admin` with async exports for every read and action (`is_admin`, `overview(refresh)`, `latest_version`, `users`, `set_admin`, `set_active`, `delete_user`, `rooms`, the report lists, reasons, dismissals, moderation delete and the bulk delete, `deactivate_author`, `report_message`, `report_user`) over UniFFI records (`AdminOverview`, `AdminUser` with its photo as a path `MediaStore` reads, `AdminRoom`, `AdminReportedMessage`, `AdminReportedUser`, pages). A refusal is `AdminFailure::Refused` with the server's code, the rooms a last owner leaves (`AdminLastOwner`) and the count a bulk delete would take. Free exports: `report_reason`, `report_reason_max`, `admin_error_key`, `server_update_available`, `deleted_username`; `NativeChat::reports_supported`.
- **RocketVibeKit** (`macos/Sources/RocketVibeKit/AdminModel.swift`): `AdminCategory` (Dashboard, Moderation, Rooms, Users, Custom emoji, the GTK order; `AdminModel.categories` drops Custom emoji where the server does not offer it), `AdminText` (sentences from `admin_error_key`, dates, the update note), `AdminList` (one paged, searchable list; a generation counter drops an answer to an older query or reload, and a search reloads 250 ms after typing pauses), `AdminModel` (the screen: overview and its date, the refresh, latest version, the Moderation badge, the four lists, the opened item with lazily read reasons, the actions with their "Done" or failure notice, the follow-up confirmations built from `AdminFailure`, nothing applied once closed), `ReportTarget` and `ReportDraft`. `AppModel` holds `administrator`, `admin` (the open `AdminModel`) and `reporting` (the open `ReportDraft`), with `refreshAdministrator`, `openAdmin` (closes the settings), `closeAdmin`, `startReport`, `sendReport`, `deletedAccount(username:)`; `ChatProvider.admin()` and `supportsReports` pick the provider.
- **Entry points**, administrator only: the "Server administration" link at the bottom of the settings sidebar (`SettingsView.swift`) and the context menu of the open account's rail tile (`ChatView.swift`); other tiles have no menu. A SwiftUI context menu is built synchronously, so `AppModel.administrator` is asked ahead: when a session starts and each time the settings open.
- **The screen** (`macos/Sources/RocketVibe/AdminView.swift`): `AdminOverlay` in the same `PanelOverlay` as the settings (dimmed backdrop, 85 % panel, one pane when narrow; `PanelOverlay` lives in `SettingsView.swift`), the Dashboard's cards two abreast when wide (`AdminDashboard`), searchable lists with "Show more" (`AdminSearch`, `AdminListRows`), item pages with their actions; destructive ones and the follow-ups confirm through `confirmOverlay` (`AdminConfirm`, `Modals.swift`).
- **Reports**: "Report" in the message context menu (`RoomView.swift`, `RoomModel.canReport`: someone else's delivered message, not a system line, never a private conversation, and on RocketVibe only when the server takes reports) and "Report this user" on a profile (`Details.swift`, not mine, not a deleted account). Both open `ReportSheet` as a modal overlay of the window (`modalOverlay` in `RocketVibeApp.swift`); from a profile, the profile closes and the report opens in its place. The result shows as the window's toast.
- **Deleted authors**: native message rows get "Deleted user" from rv-core's native projection, which rv-ffi uses (`read_presentation::group` in `rv-ffi/src/native.rs`), reactions, quotes and notifications too; the admin records carry rv-core's shown name. `ProfileView` of a deleted RocketVibe account shows "Deleted user" with no `@username`, presence, Message, Call or Report.

## Web

The browser opens a separate administrator-only sidebar dialog on the serving RocketVibe origin. Its Dashboard follows GTK's `overview_groups` and native `native_overview` projection: Version, elapsed Uptime, PostgreSQL Database, optional Migration, shortened Instance with full tooltip and Copy; users in GTK order with four presence dots; public/private/direct/encrypted rooms and messages; decimal upload size; open reports with the Moderation shortcut and sidebar count; the native bot-creation policy switch with its subtitle. The refresh icon belongs to the Deployment heading. Two independent card columns use GTK's 30-pixel spacing and collapse when the content pane is at most 680 pixels wide.

Labels and administration error sentences come from the desktop catalog generated at build time. The optional latest-version suffix selects the highest published `server-v` release, ignores drafts and prereleases, and remains hidden when unknown. Its unauthenticated GitHub request omits credentials and the referrer; it is retained for the dialog's lifetime. Refresh and policy responses are fenced to the account and connected page. A pending policy change disables the switch, uses the server's returned value, and restores the previous value on refusal. Upload sizes follow GLib's decimal units and the browser's system locale, independently of UI language. Users, Rooms and Moderation retain server-paged lists and item subpages. Custom emoji (with `custom_emoji_admin`) is one page: the add form (name, aliases, file input) then the catalogue with a confirmed delete; every change rereads the app's catalogue.

Actual GTK Fedora captures in English and French use the same local native server as the embedded browser bundle. The browser visual suite checks the actual overview fields, four presences, refresh and Moderation navigation, French labels, a controlled release list and a controlled policy refusal. Wide and narrow dashboard captures qualify this state; the browser's OS font rasterizer can differ, and exhaustive list/detail/confirmation state comparisons remain separate qualification.

## Limits

- Messages ingested before an author's deletion keep the old username until the server sends them again: the server does not republish authors (all apps).
- Private (E2EE) conversations: their rows are not built from the server's `User`, so no app applies the label there. Desktop (GTK and SwiftUI, `rv-core/src/native/crypto/enrollment/rooms/messages.rs`) names authors from the room's current member list, which a deleted account has left, so its messages show its raw user id; mobile (`providers/rocketvibe/cryptoProjection.ts`) shows the username the account's `users` table knows for that id, "Deleted user" only when that is already the `deleted-` placeholder.
- Names the RocketVibe server computes (DM names made of usernames at creation, room names) keep the old username; a profile lookup by the placeholder finds nothing.
- Rocket.Chat lists carry no account creation date and no room last-message date.

## Parity

[parity.md](../parity.md) §5, §8 and §15: the dashboard, moderation, rooms list, users with actions, reporting a message or a user are done in all three apps; the deleted-user label is partial in all three (the limits above).

## Sources

- apps/web/src/admin.ts
- apps/mobile/ui/adminIcon.tsx
- apps/mobile/lib/serverIcon.ts
- apps/desktop/crates/rv-core/src/server_icon.rs
- apps/server/src/instance_icon.rs
- apps/web/src/api.ts
- apps/web/src/sidebar.ts
- apps/web/src/extra.css
- apps/web/scripts/sync-strings.mjs
- apps/web/tests/visual.mjs
- docs/protocol/ADMINISTRATION.md
- docs/protocol/README.md
- crates/rv-protocol/src/admin.rs
- crates/rv-client/src/lib.rs
- apps/server/src/admin.rs
- apps/server/migrations/0051_administration.sql
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
- apps/desktop/macos/Sources/RocketVibe/Modals.swift
- apps/desktop/macos/Sources/RocketVibe/RocketVibeApp.swift
- apps/desktop/crates/rv-gtk/src/widgets.rs
- apps/desktop/crates/rv-gtk/src/admin_emoji.rs
- apps/mobile/app/admin/emoji.tsx
- apps/server/src/custom_emojis.rs
- apps/web/src/admin.ts
