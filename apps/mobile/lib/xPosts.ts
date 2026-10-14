/**
 * Detection of X (Twitter) post links in a message's text: `x.com/<handle>/
 * status/<id>`, the same on `twitter.com`, `mobile.` and `www.` hosts, and
 * the handle-less `x.com/i/web/status/<id>`.
 *
 * Like video links (`lib/videoLinks.ts`), DETECTION owes nothing to the
 * server: the card shows as soon as the link is in the text, and fills in
 * with what the server collected (`xPostMetas`, `lib/linkPreview.ts`),
 * matched by post id. No request to X from here: a tap opens the post in the
 * X app or the browser.
 */

export type XPostLink = {
  /** The post id (decimal, up to 20 digits). */
  id: string;
  /** The author's handle from the URL, `null` for `i/web/status` links. */
  handle: string | null;
  /** Canonical URL to open externally. */
  url: string;
};

/**
 * What may precede the link: the start, a space, a bracket or quote, or
 * markdown emphasis. Not `/`, `=` or a letter: `box.com/a/status/1`,
 * `me@x.com/...`, `https://evil.example/x.com/a/status/1` and
 * `?u=https://x.com/...` are links to OTHER hosts, whose server-collected
 * metadata must never dress up as an X post (the same split as rv-core and
 * the web: a token, then its host).
 */
const START = String.raw`(?:^|[\s<>"'()[\]*_~])`;
const X_HOSTS = new Set(['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com', 'mobile.x.com', 'mobile.twitter.com']);
const HOST = String.raw`(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/`;
/** Group 1: the handle (absent for `i/web/status`), group 2: the post id. */
const PATTERN = new RegExp(
  `${START}${HOST}(?:([A-Za-z0-9_]{1,15})\\/status(?:es)?|i\\/web\\/status)\\/(\\d{1,20})(?![\\w])`,
  'gi',
);

function link(handle: string | undefined, id: string): XPostLink {
  // `x.com/i/status/<id>` is X's own handle-less form, not a user named "i".
  const who = handle === undefined || handle.toLowerCase() === 'i' ? null : handle;
  return {
    id,
    handle: who,
    url: who === null ? `https://x.com/i/status/${id}` : `https://x.com/${who}/status/${id}`,
  };
}

/**
 * The X post links in `text`, in order of appearance, without duplicates
 * (same post id), capped at `max`.
 */
export function detectXPosts(text: string | null | undefined, max = 3): XPostLink[] {
  if (text === null || text === undefined || text === '') return [];
  const found: XPostLink[] = [];
  PATTERN.lastIndex = 0; // shared regex + `g` flag: reset before each scan
  let r: RegExpExecArray | null;
  while ((r = PATTERN.exec(text)) !== null && found.length < max) {
    const id = r[2]!;
    if (found.some((p) => p.id === id)) continue;
    found.push(link(r[1], id));
  }
  return found;
}

/**
 * The post id in `url` (a server `urls[]` entry, so a whole URL), or `null`
 * if it is not an X post link: the URL's own host must be X's.
 */
export function xPostId(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!X_HOSTS.has(host)) return null;
  PATTERN.lastIndex = 0;
  const r = PATTERN.exec(url);
  return r === null || r.index !== 0 ? null : r[2]!;
}

/** True if `url` is rendered by the X card: generic previews skip it. */
export function isXPostLink(url: string): boolean {
  return xPostId(url) !== null;
}

/** What X's image for a post shows, read from its path on `pbs.twimg.com`. */
export type XImageKind = 'photo' | 'video' | 'avatar';

export function xImageKind(url: string): XImageKind {
  let path: string;
  try {
    const u = new URL(url);
    if (u.hostname !== 'pbs.twimg.com') return 'photo';
    path = u.pathname;
  } catch {
    return 'photo';
  }
  if (path.startsWith('/profile_images/')) return 'avatar';
  if (/^\/(ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(path)) return 'video';
  return 'photo';
}

/**
 * X titles its posts `"<name> (@<handle>) on X"`: the name and handle, or
 * the whole title as the name when it has another shape.
 */
export function splitXTitle(title: string): { name: string; handle: string | null } {
  const m = /^(.*) \(@([A-Za-z0-9_]{1,15})\) on (?:X|Twitter)$/.exec(title);
  return m === null ? { name: title, handle: null } : { name: m[1]!.trim() || m[2]!, handle: m[2]! };
}
