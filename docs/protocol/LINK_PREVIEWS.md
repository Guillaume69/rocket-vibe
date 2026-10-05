# Native link previews (P15)

The server adds `Message.previews`, an optional list of at most three previews, to
its reads and to the sync journal. The original text and position
remain unchanged; publishing the metadata advances the revision,
without marking the message as edited.

## Contract

Each preview carries the original link, `kind` (`page` or `image`), a title of
at most 512 bytes, a description of 2,048 bytes and a site of 256 bytes.
Strings are text, with no HTML or executable content. The original link
remains the navigation target, even after a collection redirect.

An image carries `file_id`, SHA-256, exact decimal size, dimensions and PNG type.
The opaque identifier is distinct from the fingerprint. The resource is accessible through
`GET /api/v1/messages/{message}/previews/{file_id}` with the account's bearer.
The reader verifies the session, the current access to the room and the presence of this
image in the current message. Edit, deletion and removal from the room can
therefore withdraw access to an object kept on disk. The response is `no-store` and
`nosniff`; the authorization locks cover the delivery of the HTTP body.

The Rust transport verifies type, size, SHA-256 and PNG dimensions. It builds
the path itself on the native origin; a remote URL is never used
to send the bearer.

## Collection and limits

Links come from the Markdown structure of the plaintext message. Code,
quotes, Markdown images and system activities are not collected.
Sending and each edit atomically replace the message's tasks with a
new generation. Tasks live ten minutes, with three attempts at
most, a one-minute lease and four concurrent collections per process.
Processes share the PostgreSQL leases. No network access is made within
a SQL transaction; publication verifies generation, epoch, account,
membership and lease, then emits a normal journal event.

Only HTTP and HTTPS on ports 80/443 are collected. Userinfo, private networks,
loopback, link-local, multicast, documentation addresses, transition IPv6 and
unallocated spaces are refused. The policy is conservative and also excludes
a few public special assignments. Each DNS response must contain at
most 64 addresses, all public. The client is pinned to these addresses with
the original host for HTTP and TLS: no implicit second DNS lookup is used.

Each redirect is validated and resolved again, at most four times; a downgrade
from HTTPS to HTTP is refused. Automatic proxy, cookies, authentication
and Referer are absent. Compressed responses are refused. DNS: three
seconds; request: eight seconds; complete collection: twenty-four seconds.

HTML/XHTML: 512 KiB, at most 512 meta tags read. OpenGraph, Twitter and HTML
title are parsed with an HTML parser, without execution or trust in `base`.
A relative thumbnail is resolved against the final page, then follows the same network
policy. PNG/JPEG/GIF/WebP: two MiB in input, bounded decoding allocation,
static normalization to PNG of at most 1,200 × 1,200 and four MiB in output.
SVG and unsupported formats are refused. An invalid thumbnail leaves
a text card available if its title is valid.

The network policy follows the recommendations of
[OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
and the IANA special registries
[IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry) /
[IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry).

## Delivery state

The contract, collection, durable tasks, publication and the Rust reader
are implemented. The targeted tests exercise network policies, mixed DNS,
redirects, body limits, parsing, normalization, leases, retries, edits,
deletion, epoch change and real private HTTP / SDK reads.

The mobile provider projects the metadata into `messages.urls` and the existing
article, image and video cards. Its `rv-preview:` references contain
neither origin nor token. The readers verify size, PNG, dimensions,
SHA-256, current message and membership before exposing the pixels. The volatile cache
is bounded to 128 entries, four simultaneous reads and 32 MiB of strings.
A journal update hides the images before checking their rights;
a reaction keeps the cache if the descriptor and the membership are identical.
Search results have temporary rights without enlarging the confirmed
history. The viewer uses the same revocable reference;
the explicit export revalidates the message, copies to the gallery then erases its
temporary file.

The PostgreSQL bench exercises the real mobile provider with HTTP, WebSocket and
SQLite: projection, private image, reuse and removal after edit.
It uses the discovery capability announced by the server, without replacing it
in its test transport. It uses an image published
by the test collector; this bench does not replace the public-network tests
nor the qualification of an installed Android app.

The desktop core projects the previews into the same GTK / SwiftUI cards,
including for temporary search results. The shared private reader
revalidates the message after the read and binds each cache entry to the account,
the instance, the message, the image and the membership. Reactions keep
the pixels; a new membership removes the old one's cache, even if the
opaque path is identical. The GTK and Swift pixel caches are bounded.
Direct images open in the existing viewer, whose saving also
revalidates access. No bearer is sent to the external link of a card.

The GTK test under Xvfb displays a real texture in the existing card,
reuses the cache then removes the pixels and reloads after a membership
change. The core tests use real HTTP / WebSocket and SQLite.
The Swift bindings and models compile; compilation of the AppKit /
SwiftUI interface is checked separately by the macOS CI.

The macOS compilation of the desktop batch `1e073b1` is green. The server now
announces `link_previews` when an object volume is configured. The structured
[integration cards](INTEGRATION_CARDS.md) are also wired
to the three clients. P15 remains open for the qualification of the installed
applications; E2EE previews will be built client-side
after decryption in J4. The messaging interfaces are kept.
