# Notes

A room's notes: one markdown document per room, read and edited inside the app,
rendered with the same native markdown renderer as messages. No web view, no
browser, no external editor (user decision, 2026-11-02). The document is saved
whole against the revision it was read at; a save someone made in between
answers a conflict, the draft stays in the editor and the next save goes over the
newer version. A provider without notes hides the entry.

Providers: the Vibez server, Slack (a conversation's canvas, read-only) and Teams
(a chat's Loop page, read and edited): see [Slack](#slack) and [Teams](#teams).

## Server (Vibez)

- `GET /api/v1/rooms/{id}/notes` answers `RoomNotes {room_id, body, revision,
  updated_by, updated_at, editable}`: `body` is markdown (empty and revision
  `"0"` before the first save), `updated_by` the last editor's username,
  `editable` whether this account may save. Members only (404 otherwise).
- `PUT /api/v1/rooms/{id}/notes {body, expected_revision}` replaces the
  document when `expected_revision` is still the stored one, else 409
  `revision_conflict`. At most 64 KiB of markdown (`NOTES_BYTES`), else 400.
  Saving needs the right to post (`RoomPermissions.send`), so a read-only room's
  notes are edited by those who may write there.
- An encrypted room refuses notes (409 `notes_encrypted_room`, `editable`
  false): its notes would sit in clear on the server ([decisions](../decisions.md)).
- Table `room_notes` (migration `0066_room_notes.sql`): one row per room,
  `revision` a counter, deleted with the room.
- A save publishes the room (`room_details::publish`), so the room's revision
  moves and a `RoomUpsert` reaches every member: no new wire event, nothing an
  older client cannot read.
- Capability `room_notes` in `/.well-known/vibez`.
- Sources: `apps/server/src/notes.rs`, `apps/server/tests/notes.rs`,
  `crates/rv-protocol/src/parity.rs` (`RoomNotes`, `UpdateRoomNotes`).

## Slack

A conversation's canvas is its notes, in the same tab:
- `conversations.info` gives the canvas's file id (`properties.canvas.file_id`,
  else a `canvas` tab's `data.file_id`); `files.info` its `url_private`, `updated`
  and `last_editor`; the HTML at `url_private` (Slack's file host, the session's
  cookie) is read back into markdown by `rv_slack::canvas::markdown` (desktop)
  and `canvasMarkdown` (`packages/provider-slack/src/canvas.ts`), same rules and
  the same test cases: headings, paragraphs, bold, italic, strike, inline and
  block code, links (http and https only), nested and numbered lists, checklists,
  quotes, rules; anything else keeps its text.
- **Read-only** (2026-11-03): Slack answers every `canvases.*` method
  (`canvases.edit`, `canvases.sections.lookup`, `canvases.access.set`) and
  `conversations.canvases.create` with `not_allowed_token_type` for the browser
  session's `xoxc` token (tried live on a workspace's channel); its web client
  edits canvases through internal `quip.*` methods instead. So the apps report
  Slack notes as not editable and offer no first canvas; the save path
  (`canvases.edit` replace, `conversations.canvases.create`, the file's `updated`
  second as the revision) stays in the code, unreachable from the UI.
- Desktop: `Service::canvas` / `save_canvas` (`crates/rv-slack/src/service.rs`),
  `SlackSync::notes` / `save_notes`, `Session::notes_available` /
  `room_notes` / `save_room_notes`; GTK's dialog through `session_notes`
  (no live signal: read on opening), SwiftUI through rv-ffi `Chat.room_notes`.
  Mobile: `SlackActions.roomNotes` / `saveRoomNotes`, `SlackClient.fileText`,
  `Capabilities.notes`.
- Reading a real canvas is not verified yet (the test channel had none, and none
  can be created with this token); tested against fake Web API servers.

## Teams

A chat's Notes tab on the three native apps, read and edited natively (edit
2026-11-03). The page is a Loop file in SharePoint Embedded; when a chat's notes
are created Teams posts `ThreadActivity/FileAdd`
(`<type>loop</type><subtype>loopThread</subtype>`) whose `<uri>` is the page's
address, its `nav` parameter a base64 query naming the drive (`d`) and item (`f`).
The apps keep that event as the system message `rv-notes-created` ("created the
chat's notes"), its text the address, and read the page from it; the web app's
create-or-get `POST …/files` is never sent, so a chat without notes stays without.

- **Reading** (`rv_teams::notes`, `packages/provider-teams/src/notes.ts`): a
  SharePoint bearer for the tenant's host minted from the refresh token;
  `GET <host>/_api/v2.1/drives/<d>/items/<f>/opStream/snapshots/trees/latest?ump=1`
  (JSON: blobs, the tree, and the operations since its summary), then
  `…/opStream?ump=1&filter=sequenceNumber ge N and sequenceNumber le M` for later
  ones (an open range answers 400 "must specify 'AND' filter").
- **Decoding**: the text component's merge-tree summary
  (`.app/.channels/<component>/.channels/text/content/header` and its chunks),
  then every `component` op for that component and channel `text` replayed in
  sequence order (grouped batches unwrapped). Positions count UTF-16 units. A
  paragraph marker closes the text before it. Loop's editor (Scriptor) keys,
  read from its bundle and confirmed by writing them and seeing Teams' web app
  render them (2026-11-03): the marker's `style!reference` is `Heading 1`..`6`,
  `Title`, `Subtitle`, `Code`; text carries `format!bold`, `format!italic`,
  `format!strikeThrough` (or `format!textDecoration`), `format!underline` (no
  markdown, dropped) and `hyperlink!url` (shown by Teams as `scriptor-hyperlink`);
  a list item's marker has `list!reference` = `list!list-<id>` pointing to a
  `List` map node (`list!id`, `list!itemFormat-<level>`: `%cb` a checkbox, a
  `cssClass` bullet, else numbered). The older `nodeType` names stay understood.
- **Saving** (`rv_teams::notes::save` / `submit`, `saveTeamsNotes` / `notesSubmit`):
  the page is read again and the save refused (`revision_conflict`) if its
  sequence number moved; the edited markdown is compared paragraph by paragraph
  (a longest common subsequence of rendered lines) and only the paragraphs that
  differ are rewritten: remove the old text, insert the new runs with their
  `format!*` / `hyperlink!url` props and Loop's `attribution`, annotate the
  marker's `style!reference`, insert new paragraphs' markers (`markerId` a fresh
  UUID, `nodeType: Paragraph`), all in descending position so each op holds
  against the version read. Then Fluid's delta stream, as Loop's editor speaks it:
  `POST …/opStream/joinSession` (`deltaStreamSocketUrl`, `id`, `runtimeTenantId`,
  an empty `socketToken`), a socket.io WebSocket at `wss://<push host>/socket.io/?EIO=4&transport=websocket`
  on the URL's path as namespace (`/fluid`), `connect_document` in write mode
  with a bearer for OneDrive's push channel (`https://pushchannel.1drv.ms`,
  minted from the same refresh token; a SharePoint bearer answers "Invalid
  token"), `submitOp(clientId, [[{contents, referenceSequenceNumber,
  clientSequenceNumber, type:"op"}]])` once our own `join` is sequenced, each op
  wrapped as `{type:"component", contents:{address:<component>, contents:{content:{address:"text",
  contents:<merge op>}, type:"op"}}}`; done when every op comes back sequenced,
  then the page is read until it reaches the last one (the op stream serves an op
  a moment after the socket confirms it). Someone else's op meanwhile answers
  `revision_conflict`. Verified live on 2026-11-03 on a test chat, desktop and
  mobile code: the edits were sequenced, read back identical, and rendered
  formatted in Teams' web app.
- **What cannot be written natively**, kept readable instead: a quote (a Loop
  sub-component, `BlockQuoteComponentType`) is written as a paragraph starting
  `> `; a list item with no list next to it to join (a list is a `List` map node)
  as a paragraph starting with its markdown prefix (`- `, `1. `, `- [ ] `); such
  paragraphs read back as the same markdown, so the next save leaves them alone.
  Teams shows the `Code` style as plain text.
- **Not covered**: toggling a native checkbox or creating a native list or quote;
  compressed (`compressionLz4`) or chunked op batches, skipped on reading; ops
  replayed without merge-tree's per-client reference views, so concurrent edits
  may read a few characters off; a chat whose `FileAdd` event is older than its
  stored history (desktop) or its newest 200 messages (mobile) shows no notes;
  Loop components embedded in the page (tables, tasks, quotes) are not read.
- **Where**: desktop `TeamsSync::notes_page` / `notes` / `save_notes` over
  `Store::latest_system_text`, `Service::notes` / `save_notes`, `Tokens::push`;
  GTK and SwiftUI through the same generic path as Slack, editable; mobile
  `teamsNotes` / `saveTeamsNotes` (the chat's newest 200 messages read each time),
  `TeamsClient.notesJoin` / `notesPush`, `Capabilities.notes` on for Teams (a
  chat without notes shows the empty state, no edit).

## Desktop

- `rv_core::notes::Notes` is the shape every provider's notes take (markdown,
  revision, editable, editor, time); `NativeSession::notes_available`,
  `room_notes`, `save_room_notes` serve Vibez rooms, never an encrypted one.
- GTK: a header button (`text-x-generic-symbolic`) opens `notes.rs`, an
  `adw::Dialog`: the markdown rendered by `markdown_view`, Edit switches to a
  monospace `gtk::TextView`, Save and Cancel; a conflict keeps the text with a
  toast. Each provider hands in its own `notes::Source` (load, save, a stamp
  polled every 2 s while shown: for Vibez the room's revision, so a save
  elsewhere reloads the notes). Wired in `chat_native.rs` (`open_notes`,
  `native_notes`).
- SwiftUI: `RoomModel.supportsNotes`, `roomNotes`, `saveRoomNotes` over rv-ffi
  `NativeChat.notes_available`, `room_notes`, `save_room_notes`, whose
  `RoomNotes` carries the markdown already rendered to `BodyBlock`s; the header's
  `note.text` button opens `NotesView` (a `SheetFrame` panel, `TextEditor` for the
  markdown), read again every 10 s while shown and not editing. Checked by the
  macOS CI build only.

## Mobile

- `Provider.roomNotes` / `saveRoomNotes` and `Capabilities.notes` in
  `@rocket-vibe/provider-api`, `NOTES_CONFLICT` the conflict code; the Vibez
  provider maps the server's answer (`roomNotes` in `providers/vibez/index.ts`).
- The room header shows the notes button (`text-x-generic`) when the provider
  has notes and the room is not encrypted; `app/notes.tsx` renders with
  `MessageBody`, edits in a multiline `TextInput`, Edit / Save / Cancel in the
  header, read again every 10 s while shown and not editing.

## Web

- The room header's notes button opens `panels.notes`: rendered with the
  metadata markdown renderer (`metadataMarkdown`), a `textarea` for the edit,
  read again every 10 s while shown. Strings come from the desktop's catalogue
  (`nt("notes.…")`).

## Sources

`apps/server/src/notes.rs`, `apps/server/migrations/0066_room_notes.sql`,
`crates/rv-protocol/src/parity.rs`, `crates/rv-client/src/lib.rs`,
`apps/desktop/crates/rv-core/src/notes.rs`, `apps/desktop/crates/rv-core/src/native.rs`,
`apps/desktop/crates/rv-gtk/src/notes.rs`, `apps/desktop/crates/rv-gtk/src/chat_native.rs`,
`apps/desktop/crates/rv-ffi/src/native_rooms.rs`,
`apps/desktop/macos/Sources/RocketVibe/NotesView.swift`,
`packages/provider-api/src/provider.ts`, `apps/mobile/app/notes.tsx`,
`apps/mobile/providers/vibez/index.ts`, `apps/web/src/panels.ts`.
