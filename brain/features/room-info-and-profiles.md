# Room info and profiles

Three read-on-demand views and one editor: a room's information sheet, a person's profile (with Message and Call actions), and "my profile" to change my status, name, bio, email, username and photo. Room details and profiles are fetched from the server each time they open and never stored locally.

## Server contract

- `GET rooms.info {roomId}`: `fname`/`name`, `t`, `topic`, `announcement`, `description`, `usersCount`, `ro`, `encrypted`, `archived`, `default`.
- `GET users.info {username}` or `{userId}` (one or the other): `name`, `username`, `status`, `statusText`, `roles`, `utcOffset` (hours, may be fractional, 5.5 for India), `bio`, `avatarETag`.
- `GET me`: my own fields (`statusDefault`, `statusText`, `emails[0].address`, `bio`, `avatarETag`, `settings.preferences`).
- `POST users.setStatus {status, message}`: both fields are always sent, because the server clears whichever is omitted.
- `POST users.updateOwnBasicInfo {data}`: only the changed fields among `name`, `username`, `email`, `bio`. Changing `username` or `email` requires `currentPassword` (the SHA-256 of the password) and often triggers 2FA (`totp-required`), replayed with the code through the same mechanism as login ([login-and-servers.md](login-and-servers.md)). Re-sending an unchanged email would restart a verification, hence the diff.
- `POST users.setAvatar` (multipart field `image`), `POST users.resetAvatar`. Avatar versions and cache busting: [avatars.md](avatars.md).
- `POST rooms.favorite {roomId, favorite}` toggles the favourite flag.
- `POST rooms.saveRoomSettings {rid, roomName?, roomTopic?, roomDescription?, roomAnnouncement?, readOnly?}`: the changed keys only, `edit-room` checked by the server, any unknown key refused. `roomName` sets both `name` (the room's address) and `fname`, checked like a new channel's name (`error-invalid-room-name`); an empty one answers 200 and changes nothing (probed on 8.5.1, 2026-10-23).
- Renaming elsewhere, a channel's name only: Mattermost and kChat `PUT /channels/<id>/patch {display_name}` (the address `name` stays; an empty name is stored, probed on 11.11, 2026-10-23), Slack `conversations.rename {channel, name}` (Slack's own name rules, not probed), Teams `PATCH <aggregator host>/fabric/<region>/templates/api/teams/<groupId>/channels/OID:<substrateGroupId>@<tenant>?forceSync=false {displayName}` with a `templates.teams.microsoft.com` token (verified live 2026-10-23, [Teams](../architecture/teams.md)). Every app trims the name and refuses an empty one before sending.
- GTK channel images use the same endpoint with `roomAvatar` as a full PNG/JPEG data URI. Vibez uses `PUT /rooms/{id}/avatar?operation_id=&expected_revision=` with raw image bytes and a `RoomCommandReceipt`; versioned image reads are `GET /rooms/{id}/avatar?revision=<room journal revision>`. See [avatars.md](avatars.md).
- Vibez: `GET /rooms/{id}` (`RoomDetails`: texts, `read_only`, `voice`, details `revision`, my `permissions`), `GET /rooms/{id}/members?after=&revision=` (pages of 50, `next`), the versioned commands `PATCH /rooms/{id}`, `PUT /rooms/{id}/members/{user}/role`, `POST /rooms/{id}/leave` (each with `operation_id` and `expected_revision`, receipt at `GET /rooms/{id}/commands/{operation}`), and the owner's unversioned `POST` / `DELETE /rooms/{room}/members/{user}` (no body, `204`, removal idempotent, never oneself): `docs/protocol/ROOMS.md`, `docs/protocol/README.md`.
- Vibez's full settings command preserves the room's encryption policy binding for name, text and voice-only edits. A real privacy or read-only change rotates authority and still needs an explicit MLS review; reverting the setting cannot restore the former binding. Details revisions and `room_upsert` still publish metadata-only edits.

## Mobile

- **Room info** `app/room-info.tsx`, a native `formSheet` opened by tapping the room name in the header (`ui/roomHeader.tsx`). For a DM the header goes straight to the other person's profile instead: the "info" of a one-to-one is the person. The skeleton (name, avatar, type, encrypted and read-only flags) comes from the local DB and shows immediately, offline included; member count, announcement, topic and description arrive from `rooms.info`. It also toggles the favourite (`rooms.favorite`), with an error line on failure. Encrypted rooms show the lock and a decrypted-or-not tile (see [e2ee.md](e2ee.md)).
- **Profile** `app/profile.tsx`, a `formSheet` sized `fitToContents`. Opened from a message's avatar or author name (`ui/messageRow.tsx`), an `@mention` (`ui/markdown.tsx`) or the DM header. Shows avatar, name, `@username`, presence, roles, the person's local time (`14:07 (UTC+2)`, computed from `utcOffset`) and bio (falling back to `statusText`). Actions: Message (`actions.openOrCreateDm`, `im.create`, idempotent) and Call when a conference provider exists ([calls.md](calls.md)). **Report this user** (not on my own profile, when the server takes reports) swaps in `ui/reportForm.tsx` for a reason and sends it through `provider.reports.user` (`moderation.reportUser` on Rocket.Chat), then toasts "Report sent" ([administration.md](administration.md)).
- **Preloading** (`lib/profilePreload.ts`): a `fitToContents` sheet measures itself on first render, so content arriving later made it jump. `openProfileCard` fetches `users.info` and settles the call probe **before** navigating; the screen reads the result with `readPreloadedProfile` and renders at its final height. It is a hand-off buffer, not a freshness cache: each opening refetches. The client and the navigator are module singletons (`setProfileClient`, `setProfileNavigator`) because mentions are rendered by plain functions with nothing at hand; `ui/openingIndicator.tsx` shows feedback if the fetch drags.
- **My profile** `app/my-profile.tsx`, a full page (it has a keyboard), reached from the profile card of the My account settings category. One Save button calls only the endpoints of what changed (`lib/myProfile.ts`: `diffInfos`, `requiresPassword`, `saveStatus`, `saveBasicInfo`): presence among online/away/busy/offline plus status text, name, bio, email, username, and a new photo picked with `ui/pickAvatar.ts` (`setAvatar`, `lib/upload.ts`). "Remove photo", shown while my avatar version is not the no-photo marker, acts at once after a confirmation, like the desktop: Rocket.Chat `users.resetAvatar` then the local `AVATAR_NO_PHOTO` marker (the `updateAvatar` event confirms it without an etag), Vibez the avatar command without an image; with a photo picked but not saved, it only drops the pick. The current password field appears when email or username changes; a 2FA challenge is answered with `prepareTwoFactorCode`.

- **Members** (Rocket.Chat channel or group, `ProviderActions.listMembers`): "N members" (the `system-users` icon) in the room information sheet opens `app/room-members.tsx`, read from the server (`rooms.membersOrderedByRole`: owners, then moderators, then the rest; `filter` searched by the server, debounced; pages of 50 on scroll, a page with nothing new ending the list), not stored, since the local database knows who wrote, not the roster. A row shows the photo, a presence dot from the answer's `status`, name, `@username` and the room roles (owner, moderator, leader), and opens the profile. A DM has no list (`error-room-type-not-supported`). A long press on someone else unfolds a row of actions (an Android alert holds three buttons, too few): make or remove moderator, make or remove owner, remove from the room (confirmed), each shown only when my global and room roles grant `set-moderator`, `set-owner` or `remove-user` (`lib/permissions.ts`); `channels.*` or `groups.*` by the room's type (`setMemberRole`, `removeMember`), the row updated on success since the list is not live.
- **Room settings** (`ui/roomSettingsEditor.tsx`): on Rocket.Chat with `edit-room` granted, "Edit room settings" turns name, topic, description and announcement into fields and adds a native "Read-only" switch; on Mattermost, kChat, Slack and Teams a channel's name only, as the provider's `editableSettings` answers. Save sends only what changed, never an emptied name (`lib/roomSettings.ts`: `roomSettingsDraft`, `roomSettingsChanges`, `nameEmptied`; `ProviderActions.saveRoomSettings`), then the sheet reads the room again and writes its `ro` (Rocket.Chat) and its name into the local room row when they differ (`app/room-info.tsx`), so the composer's read-only note and the room list follow without waiting for a live event Slack and Teams never send. Slack's room information is read from `conversations.info` (`packages/provider-slack/src/actions.ts`).
- **Vibez room management** (`ui/roomManagement.tsx`, `providers/vibez/index.ts` `roomManagement`, `providers/vibez/chat.ts`), inside the same sheet and driven by `RoomDetails.permissions` and the server's capabilities (`room_settings`, `room_roles`, `room_leave`), never in a DM. **Edit room** (`change_settings`): name, private, topic, description, announcement, read-only and, for an owner on a server announcing `voice`, voice channel, sent as one `UpdateRoom` with the details revision; **roles** (owner): member, moderator or owner per member, `ChangeRoomRole` with the member page's revision; **Leave**, confirmed. These three are saved before HTTP and resumable (`nativeRoomOperations`: Resume, Review, Clear; last-owner and conflict explanations). **Show members** lists `RoomMemberPage`s (name, `@username`, role, deactivated, bot badge), "More members" following `next` with the same `revision`; the list follows the details revision: a role change, a removal or an addition rereads the details and reloads the first page at the new revision, and a `409 revision_conflict` rereads them too. **Remove from the room** (`remove_member`, not me, not a deactivated account) after a dismissible confirmation, and **Add** by username (`invite`, the account found in `GET /users`, `NativeChat.invite`): the owner's unversioned routes (`NativeChat.removeMember`, `NativeTransport.removeMember` / `addMember`), so no saved operation, their failures worded on their own (unknown username, offline, refused). A member's name opens their profile (`openProfileCard({uid})`, the sheet closing first).
- **Invite link** (Rocket.Chat channel or group, `ui/roomInvite.tsx`): shown when my global and room roles grant `create-invite-links` (`lib/permissions.ts`, as the message actions do); `inviteLink` (`lib/invites.ts`) asks `findOrCreateInvite {rid, days: 7, maxUses: 0}`, which answers the same invite for the same settings, and shares `<Site_Url>/invite/<id>` with the system share sheet, never the `go.rocket.chat` redirector the answer's `url` may name.

## Desktop

- **Room info** (`rv-gtk/src/details.rs::room_info`): an `adw::Dialog` from the room title (tooltip `info.room`). For a DM, `show_room_info` opens the partner's profile by id instead. Facts line: public/private, members, read-only, encrypted, archived, default; then topic, announcement and description as markdown sections, or "nothing to show". Parsed by `rv-core/src/info.rs::room_info`.
- **Profile** (`details.rs::profile`): by username or by id. Avatar, name, `@username`, presence (live presence from the session first, then `users.info`'s) with status text, role chips, local time (`info::local_time`), bio. Message and Call buttons for anyone but me (`ProfileActions`), and below them **Report this user** (Rocket.Chat always, Vibez when `reports_supported`), which closes the profile and asks the reason in `admin::report` ([administration.md](administration.md)). Opened from avatars and names (`RowEvent::Profile`), mentions, and DM headers.
- **Invite link** (Rocket.Chat, a channel or group, when my global and room roles grant `create-invite-links`, `Session::permissions`): an "Invite link" group in the room information dialog; `Session::invite_link` (`rocketchat::actions::find_or_create_invite`, 7 days, unlimited uses) builds `<Site_Url>/invite/<id>`, never the server's `url` field, copies it and shows a toast. SwiftUI: `InviteSection` (`Discussions.swift`) in `RoomInfoView`.
- **Members** (Rocket.Chat, a channel or group, `Session::members_available`): an "N members" row (`system-users-symbolic`) in the room information dialog opens `rv-gtk/src/details/members.rs`, an `adw::Dialog` over it, read from the server and never stored: `Session::room_members` (`rocketchat::actions::members`, `rooms.membersOrderedByRole`, 50 a page, owners then moderators first), a `gtk::SearchEntry` whose server-side search waits `members::SEARCH_DELAY_MS` (300 ms) and drops an older search's late page (a generation counter), the next page when the scroll reaches the bottom, the list's end when a page brings nothing new (`rv-core/src/members.rs::MemberList`). A row: photo with the presence dot (live presence first, else the answer's `status`), name, `@username`, room role chips (owner, moderator, leader, `Member::role_keys`); activating it opens the profile dialog. A DM has none.
- **Role actions**: someone else's row carries a menu button (`view-more-horizontal-symbolic`), also opened by a right click: make or remove moderator, make or remove owner, remove from the room, each only when my global and room roles grant `set-moderator`, `set-owner`, `remove-user` (`Session::member_rights`, over `Session::permissions`; `members::member_actions`). `Session::set_member_role` / `remove_member` take `channels.*` or `groups.*` by the stored room kind (no `rooms.*` route); the routes are not idempotent, so `members::already_done` takes `error-user-already-moderator`/`-owner`, `error-user-not-owner` and `error-user-not-in-room` as done, while `error-remove-last-owner` gets its own sentence (`members::error_key`), shown in a toast. Removal is confirmed by an `adw::AlertDialog`. On success the row is rebuilt (or dropped, the count lowered): the list is not live.
- **Room settings** (`Session::editable_settings`: Rocket.Chat with `edit-room` everything, Mattermost, kChat, Slack and Teams a channel's name): "Edit the room" opens `details/room_settings.rs` with the fields its server allows, a name entry, three text fields and a **Read-only** switch; Save (sensitive only once something moved and the name is not empty) sends only what changed through `Session::save_room_settings`: Rocket.Chat `rooms.saveRoomSettings` (`members::settings_changes`: `roomName`, `roomTopic`, `roomDescription`, `roomAnnouncement`, `readOnly`; an empty text clears it), Mattermost the channel patch, Slack `SlackSync::rename`, Teams `TeamsSync::rename`; the stored name follows at once (`Store::set_room_display_name`), then the information dialog reads the room again. A moderator without `set-readonly` may set `readOnly` (probed on 8.5.1, 2026-10-11), so `edit-room` alone gates the switch. Read-only rooms keep the composers of those whose roles grant `post-readonly` ([composer](composer.md)).
- **Vibez** rooms have their own roster, role selector and settings form (`details/native_rooms.rs`, SwiftUI `NativeRoomControls.swift`), over the native room commands, not these.
- **Favourite**: toggled from the room list's context menu (`chat.rs`, `actions::favorite`), not from the info dialog.
- **My profile** (`rv-gtk/src/settings.rs`): the My account category shows a profile card, a status group (presence combo and a status text entry, saved on change through `Session` with both fields) and an "Edit profile" subpage: photo change (file dialog, `users.setAvatar`) or removal (`users.resetAvatar`), name, username, email, bio, with the current password and 2FA code rows revealed only when needed (`rv-core/src/account.rs`: `basic_info_changes`, `needs_password`; `two_factor_code`).
- **SwiftUI**: `RoomInfoView` and `ProfileView` in `macos/Sources/RocketVibe/Details.swift`; `MyProfileSection` in `SettingsView.swift` (My account category) edits photo, presence and the basic fields. `MembersSection` (`Members.swift`) in `RoomInfoView` holds "N members", which opens `MembersView` (a `modalOverlay` sheet: search field with the same 300 ms pause, a `List` paged on the last row's appearance, rows opening `ProfileView`, a `Menu` and a context menu of rv-core's `member_actions`, removal behind a `confirmOverlay`), and `RoomSettingsSection` with `RoomSettingsEditor` (a card overlay with the fields rv-core's `editable_settings` allows: name, the three texts and the read-only toggle, Save disabled until something changed and while the name is empty). The paging, the rights, the menu and the refusals' wording come from rv-ffi `room_members.rs` (`Chat::members`, `member_rights`, `member_actions`, `run_member_action`, `editable_settings`, `save_room_settings`, which carry the list and answer catalog keys). `ProfileView` offers **Report this user** (not mine, when reports are supported): the profile closes and `ReportSheet` opens in its place, a modal overlay of the window (`modalOverlay`, `Modals.swift`) like the profile itself, which a click outside or Escape closes. A deleted Vibez account's profile reads "Deleted user" with no `@username`, presence or buttons.

## Web

Conversation avatars and author names open the same profile as the message menu (`src/ui/messages.tsx`, `App.profile`). `panels.ts::profile` fetches the native user profile on every open, uses the GTK 420 by 520 dialog with a 96-pixel portrait, centered identity and live presence/status text, then bio and Message/Call/Report actions. BOT ownership is shown; own profiles hide the other-person actions. Native profiles supply neither role chips nor a timezone. Bio and room texts render bounded safe Markdown through `markdown-text.ts` and the React message renderer. The native-origin browser E2EE controls use explicit peer/device reviews; browser storage guarantees are documented separately.

Room information is read-only with separate room settings, members and invitation dialogs. Membership roles use an explicit Apply action. Own-profile editing follows the native photo row suffix controls, name/username/read-only email/bio order and grouped Save. Selected profile photos become 512-pixel PNGs subject to the native size limit. These states are exercised by `tests/conversation-parity.mjs` and `tests/profiles.mjs`.

The read-only email row uses GTK's verified-address tooltip directing changes to Security. It has no edit caret or focus stroke; Security owns entering and verifying a new address through the actual email flow. Profile fields retain floating captions and edit indicators, and Save is a separate solid-accent group. New conversation uses the native two-group form with 24-pixel spacing, private rooms selected initially, right-aligned switches and focus strokes rounded only at the outer group corners. `tests/gtk-forms.mjs` checks both creation paths, cancellation, profile email hints and real SMTP verification.

The native room-information layout is 420 by 600, with filled actions in GTK order; a DM heading opens its peer profile. Owners change the channel image through a PNG/JPEG picker, with original bytes, command revision and nonce persisted in account/membership-scoped operation intents. A lost response resumes the identical command; Clear retires the local intent. Metadata responses preserve the model's personal read state, which also supplies the favourite command's actual revision. The roster uses native role combo rows and a separate Apply action; profile/removal remain available from its context menu.

Live profile revisions reload the open card. A valid, complete live observation without a lease means Offline; expired or limited observations supply no presence. The browser renews its Online lease every 20 seconds while its authenticated socket remains open, respecting the server's chosen Away/Busy/Offline status. Shutdown serializes Offline after any in-flight publication. Profile responses/actions are fenced to the captured account, connection and room membership. Message/Call fetch the DM's personal read/access state before opening it, since creation returns a room without that personal state. Call uses the ordinary direct-call ringing path; Report replaces the card with the reason dialog. `tests/profiles.mjs` exercises these paths with two real fixture accounts, including expiry, signout, narrow layout and ringing/decline.

## Parity

Room info, profile with Message and Call, my profile with password and 2FA, live avatar changes: both apps ([parity](../parity.md) §8). Differences: mobile toggles the favourite from room info, desktop from the room list; mobile prefetches the profile so the sheet never jumps. Report this user is in all three apps. All three native apps list a Rocket.Chat room's members, change their roles, remove members and edit the room's texts and read-only switch. Mobile also edits a Vibez room's settings and lists, adds and removes its members and changes their roles, as the web does; the desktop keeps its own Vibez roster and form. Mattermost and kChat have none of it yet, on any app.

## Quick activity change

The bottom avatar opens the four activity choices on GTK, SwiftUI, mobile and web. The badge on it shows my activity, separate from server connectivity. Choosing a status preserves the current status text and other profile fields; mobile uses a native form sheet, GTK and web use dismissible popovers, SwiftUI uses a platform menu. Native profile conflicts and pending operations retain the existing settings recovery paths.

The web popover reuses GTK's 9-pixel `.presence` circles in 16-pixel icon slots: green Online, yellow Away, red Busy and gray Offline. `tests/shell-parity.mjs` measures the actual colors and geometry, then chooses Away and Online through real profile commands and verifies the account badge.

## Sources

- apps/web/src/settings-parity.css
- apps/web/src/new-conversation.ts
- apps/web/tests/gtk-forms.mjs

- apps/web/src/markdown-text.ts
- apps/web/src/ui/profile.tsx
- apps/web/tests/conversation-parity.mjs
- apps/web/src/render.ts
- apps/web/src/app.ts
- apps/web/src/panels.ts
- apps/web/src/extra.css
- apps/web/tests/profiles.mjs
- apps/mobile/app/room-info.tsx
- apps/mobile/app/room-members.tsx
- apps/mobile/ui/roomSettingsEditor.tsx
- apps/mobile/lib/roomSettings.ts
- apps/mobile/ui/roomManagement.tsx
- apps/mobile/lib/permissions.ts
- apps/mobile/providers/rocketchat/actions.ts
- apps/mobile/providers/vibez/index.ts
- apps/mobile/providers/vibez/chat.ts
- apps/mobile/providers/vibez/transport.ts
- docs/protocol/ROOMS.md
- apps/server/migrations/0063_room_authority_changes.sql
- apps/server/tests/room_details.rs
- apps/mobile/app/profile.tsx
- apps/mobile/app/my-profile.tsx
- apps/mobile/app/presence.tsx
- apps/mobile/app/settings/index.tsx
- apps/mobile/ui/reportForm.tsx
- apps/mobile/lib/myProfile.ts
- apps/mobile/lib/profilePreload.ts
- apps/mobile/lib/upload.ts
- apps/mobile/ui/pickAvatar.ts
- apps/mobile/ui/roomHeader.tsx
- apps/mobile/ui/messageRow.tsx
- apps/mobile/ui/markdown.tsx
- apps/mobile/ui/openingIndicator.tsx
- apps/desktop/crates/rv-core/src/info.rs
- apps/desktop/crates/rv-core/src/members.rs
- apps/desktop/crates/rv-core/src/rocketchat/actions.rs
- apps/desktop/crates/rv-core/tests/members.rs
- apps/desktop/crates/rv-core/src/account.rs
- apps/desktop/crates/rv-core/src/actions.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/crates/rv-gtk/src/details.rs
- apps/desktop/crates/rv-gtk/src/details/members.rs
- apps/desktop/crates/rv-gtk/src/details/room_settings.rs
- apps/desktop/crates/rv-gtk/src/details/native_rooms.rs
- apps/desktop/crates/rv-gtk/src/smoke/rocket_chat.rs
- apps/desktop/crates/rv-ffi/src/room_members.rs
- apps/desktop/macos/Sources/RocketVibe/Members.swift
- apps/desktop/macos/Sources/RocketVibe/NativeRoomControls.swift
- apps/desktop/crates/rv-gtk/src/settings.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/admin.rs
- apps/desktop/macos/Sources/RocketVibe/Details.swift
- apps/desktop/macos/Sources/RocketVibe/SettingsView.swift
- apps/desktop/macos/Sources/RocketVibe/Modals.swift
