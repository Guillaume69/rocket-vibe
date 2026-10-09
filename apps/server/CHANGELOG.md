# Changelog

## [Unreleased]

### Fixed

- Preserve bot identity in live profile observations so author refreshes keep the BOT badge on bot and workflow messages.

### Added

- The server has an icon of its own, set and removed by an administrator from the apps (`PUT`/`DELETE /api/v1/admin/icon`, capability `instance_icon`), public at `GET /api/v1/instance/icon` and announced by `icon_revision` in the discovery document.
- Administrators add and remove custom emoji from the apps (`PUT`/`DELETE /api/v1/admin/emoji/{name}`, capability `custom_emoji_admin`), with per-administrator receipts and the administrator named in the operator journal.
- Embed the native web client in the server binary and Docker image, serving explicit application routes and immutable hashed assets without a Node runtime.
- Accept browser-recorded audio WebM with the same EBML header validation as video WebM.
