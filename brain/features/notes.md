# Notes

A room's notes: one markdown document per room, read and edited inside the app,
rendered with the same native markdown renderer as messages. No web view, no
browser, no external editor (user decision, 2026-11-02). The document is saved
whole against the revision it was read at; a save someone made in between
answers a conflict, the draft stays in the editor and the next save goes over the
newer version. A provider without notes hides the entry.

Providers: the Vibez server, Slack (a conversation's canvas) and Teams (a chat's
Loop page), all three read and edited: see [Slack](#slack) and [Teams](#teams).

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

A conversation's canvas is its notes, in the same tab, read and edited natively
through Quip's canvas service, the way Slack's web client does (the public
`canvases.*` methods answer `not_allowed_token_type` to the browser session's
`xoxc` token, seen 2026-11-03). Wire format:
[slack-session](../architecture/slack-session.md#canvases-quips-collab-protocol).

- **Locating it**: `conversations.info` gives the canvas's file id
  (`properties.canvas.file_id`, else a `canvas` tab's `data.file_id`), `files.info`
  its `updated`, `last_editor` and `editable`, `quip.lookupThreadIds` the Quip
  thread behind it.
- **Reading**: `POST /canvas/-/load-data/editor/1` (form `request_binary`, the
  session's token in the form) on the web client's origin `app.slack.com`
  (`slack.com` serves no `/canvas/`); the protobuf answer is read by `rv-canvas`
  (`crates/rv-canvas`) into one markdown line per block: headings, plain text,
  code, quotes, bulleted, numbered and checklist items. The revision is the
  document's version, which every save moves.
- **Saving**: the canvas is read again and the save refused (`revision_conflict`)
  if its version moved; `rv_canvas::plan` aligns the edited lines with the
  blocks and builds only the sections that changed, each block's text a fresh
  Automerge change on a new editing session (12 hex characters, plus 8 for the
  actor), new blocks and list items placed between their neighbours, removed
  ones deleted; then one `POST /canvas/-/edit-document`. Nothing changed sends
  nothing. The engine was verified live in a test channel (2026-11-04,
  `rv-canvas`'s `canvas-probe`): written, read back identical, a second save
  empty; the apps' wiring is tested against fake servers (`rv-core/tests/slack.rs`,
  `canvas.test.ts`), not yet against a live workspace.
- **Mobile engine**: Hermes has no WebAssembly for Automerge, so Android runs the
  same `rv-canvas` over JNI in the voice module's library
  (`crates/rv-voice-mobile/src/canvas.rs`, `Canvas.kt`, `VoiceNative.canvasRead` /
  `canvasPlan`, base64 in, JSON out); the app does the HTTP
  (`SlackClient.canvasService`). `ui/sync.tsx` hands the engine to the provider
  (`providers/slackCanvas.ts`); a build without the library falls back to the
  canvas's HTML at `url_private`, read by `canvasMarkdown`
  (`packages/provider-slack/src/canvas.ts`), read-only.
- **Not covered**: inline formatting (bold, italic, links) is neither read nor
  written, so a rewritten block loses it; a checklist item reads unchecked and
  cannot be ticked; a conversation without a canvas offers no first one (Quip's
  `create-collab-document` is captured, not built); tables, images and embeds
  are skipped.
- Desktop: `Service::canvas` / `save_canvas` (`crates/rv-slack/src/service.rs`)
  over `RestClient::slack_canvas` (`crates/rv-provider/src/rest.rs`, paths
  `CANVAS_PATHS`), `SlackSync::notes` / `save_notes`, `Session::notes_available` /
  `room_notes` / `save_room_notes`; GTK's pane through `session_notes` (no live
  signal: read on opening), SwiftUI through rv-ffi `Chat.room_notes`.
  Mobile: `SlackActions.roomNotes` / `saveRoomNotes`, `Capabilities.notes`.

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
- **Saving** (`rv_teams::notes::save` / `edit` / `submit`, `saveTeamsNotes` / `notesEdit` /
  `notesSubmit`): the page is read again and the save refused (`revision_conflict`) if its
  sequence number moved; the edited markdown is compared line by line
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
- **Blocks** (read and edited natively since 2026-11-07, shapes read from a real
  page and its op history, each kind confirmed in Teams' web app):
  - *Lists*: a marker's `list!reference` is `<level>;<list id>[;1 ticked]`. A list is a
    directory channel of the page component (`nodeType: List`, `list!id`,
    `list!itemFormat-<level>`: `%cb` a checkbox, a `cssClass` bullet, `%cd<n>` numbered),
    registered in the page's `ListRegistry` channel (root key `text:list!registry`). A new
    item joins the same kind of list right before it, else a new list is attached
    (`attach` of the channel, then `set` in the registry). A tick annotates the
    reference and Loop's `format!textDecoration`, which the apps do not show as a strike.
  - *Quote, code block*: `BlockQuoteComponentType` / `CodeBlockComponentType`, placed by a
    `FluidComponent` marker whose `component!url` is the component's handle; their
    paragraphs are in its own `text` channel. New lines go in that channel; a new quote
    attaches a data store (`.component`, `root`, `text`) then places its marker.
  - *Table* (`TableroComponentType`, `richTextTablero`): root → view model
    (`tableViewModelIdKey`) → data model (`tableroDocumentId`). The order shown is the
    `rowSequence` / `colSequence` `SharedArray`s (`{type: 0 insert, 1 delete, 2 move}`);
    the `SharedMatrix` (`matrixIdKey`) keeps a column's definition in its row 0 (id,
    title's handle) and a row's id in its column 0, and each cell a handle to an
    `IRichTextData` component with its own `text`. Its `cells` blob is a sparse tree
    keyed by the two handles' interleaved bits (column even, row odd), `rows` / `cols`
    `segments` `[length, first handle]`. Shown as a pipe table, the titles first.
    A save changes titles and cells in their own channels and adds or removes rows and
    columns as Loop's editor does: rows and columns aligned (columns by title, rows by
    content), a new one inserted at the matrix's end (`{pos1, seg: [1, -2147483648],
    type: 0, target}`), its definition and a new component per cell set by position,
    its order entry inserted, a removal `{pos1, pos2, type: 1, target}` plus the order
    entry's delete, then a `sharedSignal` for open editors. The first line is always
    the titles, so it can be renamed, not removed. A pipe table with no table behind
    it is kept as text; creating a table is not done.
  - *Task list* (`TasklistComponentType`, about 30 data stores with Planner's
    connector and sync schedulers): the same table one component down, shown as
    `- [x] title`. A row's `ICheckboxRichText` cell holds a component whose root key
    `ConfigurationType` carries `checked` and the title's handle. Titles and ticks are
    edited, a whole list can go; removing one task, adding a task (a new line becomes
    a checklist item below) and creating a list are not done, and a partial removal
    answers `notes_structure`, the draft kept. Assignee, due date and bucket are not
    shown. Teams' "Other people's changes … haven't been synced with Planner" banner
    follows an edit from here, as it would any other person's. Whether such an edit then
    reaches Planner is not verified: on the only page tried, Teams' own `CreateTaskList`
    sync had failed with `errorCode: 500` since the list was created, about 1,600
    operations before our first write (`keyAllSyncStatusDir`), so Sync now answers
    "isn't ready to sync with Planner" whoever edited.
  - Emoji and tab markers are inline (`inlineMarker`), not paragraph ends; a rewritten
    cell turns an emoji marker into plain text.
- **Not covered**: compressed (`compressionLz4`) or chunked op batches, skipped on
  reading; ops replayed without merge-tree's per-client reference views, so concurrent
  edits may read a few characters off; a chat whose `FileAdd` event is older than its
  stored history (desktop) or its newest 200 messages (mobile) shows no notes; other
  Loop components are kept but not shown; a table with a non-text column cannot change
  that column's values.
- **Where**: desktop `TeamsSync::notes_page` / `notes` / `save_notes` over
  `Store::latest_system_text`, `Service::notes` / `save_notes`, `Tokens::push`;
  GTK and SwiftUI through the same generic path as Slack, editable; mobile
  `teamsNotes` / `saveTeamsNotes` (the chat's newest 200 messages read each time),
  `TeamsClient.notesJoin` / `notesPush`, `Capabilities.notes` on for Teams (a
  chat without notes shows the empty state, no edit).

## The pane and the formatting bar

On a desktop or web window the notes open beside the conversation, not in a modal
(user decision, 2026-11-06): the room list is hidden while they show, the
conversation stays as it was, each pane takes about half. Opening and closing are
states of the back and forward history: back from the notes restores the list with
the conversation untouched, forward reopens them, and a state of another room
closes the pane (going back to the state that had it open reopens it). A narrow
window shows the notes alone. An edit left unsaved when the pane closes, by back,
Close or another room, comes back in the editor when it reopens, as long as the
app runs; Cancel drops it.

The editor carries a formatting bar in every app, the composers' buttons writing
standard markdown (`**`, `_`, `~~`), since Teams' reader takes `*` for italic and
ignores a single `~`. `Notes.blocks_only` / `RoomNotes.blocksOnly`, set for
Slack, whose canvases keep no inline marks, leaves only the block buttons.

A save replaces the revision the edit started from, moved only after a refused save
has told the person about the newer one: a read in the background can no longer
turn a stale draft into a silent overwrite.

## Desktop

- `rv_core::notes::Notes` is the shape every provider's notes take (markdown,
  revision, editable, `blocks_only`, editor, time); `NativeSession::notes_available`,
  `room_notes`, `save_room_notes` serve Vibez rooms, never an encrypted one.
- GTK: the header button (`text-x-generic-symbolic`) toggles `notes.rs`'s `Page`, the
  sidebar (at the end) of an `adw::OverlaySplitView` around the content stack, which
  handles the window buttons and lays the pane over the room when narrow. The list
  goes by collapsing the `NavigationSplitView`: `ChatPage::fit_panes` sets
  `collapsed = narrow || notes open`, so the window's breakpoint calls `set_narrow`
  rather than setting `collapsed` itself; the room header's automatic back button then
  means "back" (`connect_show_content_notify`). History entries are
  `(account, rid, notes)` (`remember`, `push_history`, `walk_to`, `show_notes_state`;
  `notes_after_walk` for a walk across accounts), drafts `ChatPage.notes_drafts`. The
  markdown is rendered by `markdown_view`, Edit switches to a monospace `gtk::TextView`
  under `composer::toolbar`; each provider hands in its own `notes::Source` (load,
  save, a stamp polled every 2 s while shown: for Vibez the room's revision, so a save
  elsewhere reloads the notes). Wired in `chat_native.rs`. Checked by `RV_SMOKE_NAV`.
- SwiftUI: `RoomModel.supportsNotes`, `roomNotes`, `saveRoomNotes` over rv-ffi
  `NativeChat.notes_available`, `room_notes`, `save_room_notes`, whose `RoomNotes`
  carries the markdown already rendered to `BodyBlock`s. The header's `note.text`
  button calls `AppModel.toggleNotes`; `notesOpen` shows `NotesView` in the room's
  inspector, in place of a thread, and hides the sidebar (`columnVisibility`), each
  `Visit` remembering it. `TextEditor` with a selection, `NotesFormatBar` over rv-ffi
  `format_notes`, read again every 10 s while shown and not editing. Checked by the
  macOS CI build only.

## Mobile

- `Provider.roomNotes` / `saveRoomNotes` and `Capabilities.notes` in
  `@rocket-vibe/provider-api`, `NOTES_CONFLICT` the conflict code; the Vibez
  provider maps the server's answer (`roomNotes` in `providers/vibez/index.ts`).
- The room header shows the notes button (`text-x-generic`) when the provider
  has notes and the room is not encrypted; `app/notes.tsx` renders with
  `MessageBody`, edits in a multiline `TextInput` under `ui/formatRow.tsx` (the
  composer's row), Edit / Save / Cancel in the header, read again every 10 s while
  shown and not editing. A phone has one pane: the notes are a screen, and the
  system's back returns to the conversation, keeping an unsaved edit
  (`leftDrafts`, in memory).

## Web

- The room header's notes button (`App.toggleNotes`) fills `.notes-pane`, beside
  `.room-content`, the sidebar hidden by CSS, the room alone under 900 px. The state
  is the address: `/room/<id>?notes=1`, pushed on each toggle and followed on
  `popstate` without reopening the room (`followNotesUrl`), so the browser's back and
  forward and a reload all work. `panels.notes` renders with the metadata markdown
  renderer (`metadataMarkdown`), a `textarea` under `NotesFormatBar`
  (`ui/format.tsx`), read again every 10 s while shown, drafts in `App.notesDrafts`.
  Strings come from the desktop's catalogue (`nt("notes.…")`).

## Sources

`apps/server/src/notes.rs`, `apps/server/migrations/0066_room_notes.sql`,
`crates/rv-protocol/src/parity.rs`, `crates/rv-client/src/lib.rs`,
`apps/desktop/crates/rv-core/src/notes.rs`, `apps/desktop/crates/rv-core/src/native.rs`,
`apps/desktop/crates/rv-gtk/src/notes.rs`, `apps/desktop/crates/rv-gtk/src/chat_native.rs`,
`apps/desktop/crates/rv-ffi/src/native_rooms.rs`,
`apps/desktop/macos/Sources/RocketVibe/NotesView.swift`,
`packages/provider-api/src/provider.ts`, `apps/mobile/app/notes.tsx`,
`apps/mobile/providers/vibez/index.ts`, `apps/mobile/ui/formatRow.tsx`,
`apps/web/src/panels.ts`, `apps/web/src/ui/format.tsx`, `apps/desktop/crates/rv-gtk/src/composer.rs`,
`apps/desktop/crates/rv-ffi/src/writing.rs`,
`crates/rv-canvas/src/`, `crates/rv-slack/src/service.rs`,
`crates/rv-voice-mobile/src/canvas.rs`, `packages/provider-slack/src/actions.ts`,
`packages/provider-slack/src/canvasEngine.ts`, `apps/mobile/providers/slackCanvas.ts`.
