# Native rendering in the existing clients (P07)

The GTK / SwiftUI / mobile interfaces remain those of the existing client. The
Rocket.Chat provider keeps its historical normalizer and rendering.
The RocketVibe provider adapts the native data to the same widgets; no
new screen, theme, composer or client is introduced by this batch.

## Text and document

Room activities carry a structured `system` field and have no
Markdown document. They use the existing system rows; see
[their contract and guarantees](SYSTEM_MESSAGES.md).

`Message.text` remains the source. The optional additive field `body` contains a
`Document` of format `native1`, with typed nodes: text, styles, code,
paragraphs, headings, text quotes, lists / tasks, links, mentions and
emoji codes. The protocol exposes no Rocket.Chat `md` tree and no rendered HTML.
The server computes the document from the source; send and edit accept
no presentation document and no right supplied by the client.

The parser uses the CommonMark structure of `pulldown-cmark`, task
lists and strikethrough. The conventions of the existing composers take precedence for
styles: `*bold*` / `**bold**`, `_italic_` / `__italic__`, `~strike~` /
`~~strike~~`. Markers present in code remain literal. Headings
are projected to the four sizes already present in the widgets.

The document is translated at the Rust / TypeScript boundaries into the existing
presentation models. The common core serves GTK and the SwiftUI / UniFFI runs.
SQLite keeps the document or its projection with the message revision; an
old response does not replace an edit. The desktop rescans the source
with the native parser for old caches or messages without a document. The
mobile keeps its historical fallback for an old server that omits `body` and
for optimistic messages predating the confirmation.

## Contexts and bounds

Mention recognition for rendering and notifications uses the
same parser. Code, quotes, link labels / destinations, images, raw
URLs, email addresses and escapes do not trigger a mention. A normal
occurrence does not make an identical occurrence in a
quote or a link active. The resolution of active recipients and the edit
policy remain those of [P05](READ_STATE.md). `@here` remains literal until
P12. Room mentions are textual; resolved profiles / references
remain their following parity batches.

HTML and Markdown images keep their literal text. A third-party image URL
receives no authenticated request from this rendering. The existing renderers filter
external links; a `javascript:` destination executes nothing. A permalink
without a resolved native quote remains visible, instead of hiding its source.
Standard emojis use the existing local catalog; an unknown custom code
remains readable. This document does not enable the custom catalog / files.

Sources remain limited to 32,768 bytes. The parser bounds its depth to
32 and its traversal to 4,096 events; beyond that, it keeps the whole source as
plain text. This presentation creates no active mention. The mobile
validator checks the discriminators before the children and bounds its recursion,
to refuse hostile trees without traversing impossible alternatives.
Documents fall within the existing journal / snapshot / batch budgets.

## Verification and next steps

[Shared native corpus](native-rendering.fixture.json): fifteen cases go through the
Rust parser, the serialized document, the desktop and mobile presentation models,
the GTK paragraphs and the runs used by SwiftUI. The local trees are
compared exactly, with independent checks of the composer's text and styles.
The real HTTP / PostgreSQL server and the mobile transport exercise
the same corpus, SQLite, edit, old replay, removal of the body in the
journal and refusal of an account outside the room. The depth limit and the volume
of a dense source are verified separately.

The GTK binary connected to the PostgreSQL server is also verified in a
435 px window: two rich messages reach the current widgets, the
document is kept in SQLite and the composer fits in the window. The
Swift bindings / models build under Linux and their connected room
management test passes with this contract. The Android Hermes bundle is exported.

The qualification of the installed Android / macOS / Windows applications remains
open. The [quote references and per-reader excerpts](QUOTES.md) are
delivered server-side; their wiring to the existing cards, the structured
system messages and the native emoji catalog remain P07. Message
quotes are not replaced by Markdown text quotes.
