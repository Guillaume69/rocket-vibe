# Native integration cards (P15)

`SendMessage.cards` and `Message.cards` carry structured attachments.
An integration uses a normal session and `POST /api/v1/rooms/{room}/messages`:
it must belong to the room and have the right to write in it. No anonymous
webhook, implicit privileged role or marketplace is added.

```json
{
  "operation_id": "integration-build-42",
  "text": "",
  "cards": [{
    "author": "CI",
    "title": "Build finished",
    "url": "https://example.org/build/42",
    "text": "The package is available.",
    "color": "#1177aa",
    "fields": [{"title": "Commit", "value": "abcdef", "short": true}]
  }]
}
```

Three cards and 16 KiB of JSON in total; twelve fields per card. UTF-8 limits:
author 256 bytes, title 512, text 8,192, field label 128, value 2,048,
link 2,048. Links are HTTP(S), with a host, without userinfo or control characters.
The color is `#rrggbb`. Unrecognized properties are refused; no remote
image, executable action or interpreted HTML tag is carried.
A title, text or fields are required. The message text may
be empty when cards are present.

Cards enter the fingerprint of the intent. An identical repeat
returns the current message; a change of card under the same identifier
is a conflict. An edit of the text keeps the cards. Deletion
erases their JSON and rewrites the old events with the current tombstone.
A distinct GIN index makes it possible to search their content without modifying the
text index; the same search rights and limits apply.

The SQLite projections and the temporary search results use
the existing attachments. Quote refreshes keep
the message's cards. The GTK core provides the renderer already present; the
UniFFI model adds color and fields to the existing SwiftUI card. Mobile
completes the rendering of attachments in the current row, with the existing styles
and Markdown renderer. These presentations also accept the structured
Rocket.Chat cards in their current provider.

Verifications: contract validation, rights / replay / search / edit /
erasure over HTTP and PostgreSQL, real mobile provider with SQLite and search,
rollback and room removal in the caches, UniFFI projection and GTK widget.
The Swift models compile locally; the AppKit interface is verified by
the macOS CI. The Android / Hermes export does not qualify an installed application.
