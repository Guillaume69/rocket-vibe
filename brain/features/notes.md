# Notes

A room's notes: one markdown document per room, read and edited inside the app,
rendered with the same native markdown renderer as messages. No web view, no
browser, no external editor (user decision, 2026-11-02). The document is saved
whole against the revision it was read at; a save someone made in between
answers a conflict, the draft stays in the editor and the next save goes over the
newer version. A provider without notes hides the entry.

Providers: the Vibez server, Slack (a conversation's canvas) and Teams (a chat's
Loop page, read-only): see [Teams](#teams).

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
- Slack keeps no revision: the file's `updated` second stands in for one. A save
  reads `files.info` again and is refused (`revision_conflict`) when it moved,
  else replaces the whole canvas with `canvases.edit` (`changes:
  [{operation:"replace", document_content:{type:"markdown", markdown}}]`); a
  conversation without one gets it with `conversations.canvases.create`
  (`channel_id`, `document_content`). The check and the write are two calls, so
  a save landing between them is overwritten.
- Desktop: `Service::canvas` / `save_canvas` (`crates/rv-slack/src/service.rs`),
  `SlackSync::notes` / `save_notes`, `Session::notes_available` /
  `room_notes` / `save_room_notes`; GTK's dialog through `session_notes`
  (no live signal: read on opening), SwiftUI through rv-ffi `Chat.room_notes`.
  Mobile: `SlackActions.roomNotes` / `saveRoomNotes`, `SlackClient.fileText`,
  `Capabilities.notes`.
- Not run against a real workspace: no Slack account was signed in on the
  development machine. Tested against fake Web API servers on both sides.

## Teams

A chat's Notes tab, read-only, on the three native apps (2026-11-02). The page is
a Loop file in SharePoint Embedded; when a chat's notes are created Teams posts
`ThreadActivity/FileAdd` (`<type>loop</type><subtype>loopThread</subtype>`) whose
`<uri>` is the page's address, its `nav` parameter a base64 query naming the
drive (`d`) and item (`f`). The apps keep that event as the system message
`rv-notes-created` ("created the chat's notes"), its text the address, and read
the page from it: no write, the web app's create-or-get `POST …/files` is never
sent (seen in Teams' web app on a chat that had notes: it went straight to the page).

- **Reading** (`rv_teams::notes`, `packages/provider-teams/src/notes.ts`): a
  SharePoint bearer for the tenant's host minted from the refresh token;
  `GET <host>/_api/v2.1/drives/<d>/items/<f>/opStream/snapshots/trees/latest?ump=1`
  (JSON: blobs, the tree, and the operations since its summary), then
  `…/opStream?ump=1&filter=sequenceNumber ge N and sequenceNumber le M` for later
  ones (an open range answers 400 "must specify 'AND' filter"). Verified live
  read-only on 2026-11-02: the page read as its two paragraphs.
- **Decoding**: the text component's merge-tree summary
  (`.app/.channels/<component>/.channels/text/content/header` and its chunks),
  then every `component` op for that component and channel `text` replayed in
  sequence order (grouped batches unwrapped): insert, remove, annotate, group.
  Positions count UTF-16 units. A paragraph marker closes the text before it;
  its `nodeType` gives the block (only `Paragraph` has been seen; headings,
  bullet, numbered and check lists, quotes and code are mapped by name), text
  props `bold`, `italic`, `strikethrough`, `code` and a link become inline markdown.
- **Not covered**: editing (Fluid's delta stream through `joinSession`); compressed
  (`compressionLz4`) or chunked op batches, skipped; ops replayed in sequence
  order without merge-tree's per-client reference views, so concurrent edits may
  land a few characters off; a chat whose `FileAdd` event is older than its
  stored history (desktop) or its newest 200 messages (mobile) shows no notes;
  Loop components embedded in the page (tables, tasks) are not read.
- **Where**: desktop `TeamsSync::notes_page` / `notes` over `Store::latest_system_text`
  (the Notes button shows once the event is stored), GTK and SwiftUI through the
  same generic path as Slack, never editable; mobile `teamsNotes` reads the
  chat's newest 200 messages each time, `Capabilities.notes` on for Teams (a
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
