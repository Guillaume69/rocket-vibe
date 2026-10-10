/**
 * What is allowed to LEAVE the process.
 *
 * Opening a URL with `Linking.openURL` emits a `VIEW` intent: the string goes
 * to the browser (hence its history, synced to the Google account) and to any
 * app that claims to handle the scheme. Two things must therefore be true
 * BEFORE handing it to the system.
 *
 * 1. **The scheme is web, or an email address.** `javascript:`, `intent:`,
 *    `file:`, `content:` go nowhere; `mailto:` opens the mail app, which shows
 *    the draft before anything is sent (the parser links bare addresses so). The URLs displayed come from markdown, link previews
 *    (`message.urls`) and attachments: all other people's data, stored raw in
 *    the database and projected without validation.
 * 2. **It carries none of our credentials.** `protectedFileUrl`
 *    (lib/upload.ts) puts `rc_uid` and `rc_token` in the query, because
 *    Rocket.Chat's protected-file middleware authenticates that way. An
 *    `rc_token` is worth the whole account. Such a URL is meant to be consumed
 *    INSIDE the process (`<Image>`, video player, download) and nowhere else.
 *
 * The second point is a safety net, not the fix: the path that leaked (the
 * "file" branch of `ui/messageRow.tsx`) no longer goes through external
 * opening at all, it downloads and shares a LOCAL file. This guard is there so
 * that reintroducing the same defect elsewhere fails instead of leaking
 * silently, and it can be tested.
 *
 * Pure module: `ui/externalLink.ts` makes the `Linking` call.
 */

/** The only schemes handed to the system. */
const WEB = /^https?:\/\//i;

/**
 * Our session credentials, as `protectedFileUrl` puts them in the query.
 * Deliberately broad (no anchoring on `?`/`&`): better to refuse an exotic
 * external URL literally containing `rc_token=` than to let through a form
 * nobody thought of.
 */
const CREDENTIALS = /\brc_(token|uid)=/i;

/** True if `url` is an `http(s)://...` string. */
export function isWebLink(url: unknown): url is string {
  return typeof url === 'string' && WEB.test(url);
}

/** `mailto:` and something after it, no spaces (the desktop accepts it too). */
const MAIL = /^mailto:[^\s]+$/i;

/** True if the URL carries `rc_uid` or `rc_token`. */
export function carriesCredentials(url: string): boolean {
  return CREDENTIALS.test(url);
}

/**
 * The only question to ask before `Linking.openURL`: may this string leave
 * the process?
 */
export function canLeaveProcess(url: unknown): url is string {
  return (isWebLink(url) || (typeof url === 'string' && MAIL.test(url))) && !carriesCredentials(url);
}
