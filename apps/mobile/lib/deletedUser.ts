/**
 * A deleted RocketVibe account. Deletion tombstones the account: its messages,
 * reactions and quotes keep it as author, its wire `User` carries
 * `deleted: true` and its username becomes `deleted-<id>`, a prefix the server
 * refuses to anyone else (creation, rename, invitation, import; see
 * `docs/protocol/ADMINISTRATION.md`, "Account deletion"). So the username the
 * rows already store is enough to tell, with no new column: a native author
 * named `deleted-…` is shown as "Deleted user".
 *
 * Rocket.Chat reserves no such prefix: the rule applies to the native
 * provider only, which the callers check.
 */

export function isDeletedUsername(username: string | null | undefined): boolean {
  return typeof username === 'string' && /^deleted-/i.test(username);
}
