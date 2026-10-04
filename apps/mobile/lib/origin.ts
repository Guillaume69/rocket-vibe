/**
 * A web URL's origin (scheme + authority) and origin comparison.
 *
 * Three places depend on it, all from the same workstream "what leaves the
 * process is chosen by us": the token is only set on a URL of our server
 * (`lib/upload.ts`), the call WebView only navigates on the conference's
 * origin (`app/call/[callId].tsx`), and native push only authenticates to the
 * server of a known session (`plugins/with-fcm-deeplink.js`, in Kotlin: same
 * rule, written twice for lack of a common language).
 *
 * **Why not `new URL(u).origin`.** React Native's `URL` is not Node's: it is a
 * regex-based polyfill (`react-native/Libraries/Blob/URL.js`) that NEVER
 * THROWS on invalid input and whose `origin` returns `''` instead of
 * rejecting. A `try/catch` around it would be decorative, and above all the
 * Node bench would validate a behaviour the device does not have, exactly the
 * kind of gap that turns a test green on wrong code. An explicit regex behaves
 * the same on both sides.
 *
 * The authority is taken AS IS, `userinfo` included: `https://server@evil`
 * must never reduce to `https://server`.
 */

const ORIGIN = /^(https?:\/\/[^/?#]+)/i;

/** Lowercase scheme + authority, `null` if it is not a web URL. */
export function originOf(url: string): string | null {
  const m = ORIGIN.exec(url);
  return m === null ? null : m[1]!.toLowerCase();
}

/**
 * True if `url` is served by `origin`.
 *
 * Above all NOT `url.startsWith(origin)`: `https://server` is a prefix of
 * `https://server.evil.com/x`. The origin is re-extracted on both sides and
 * the two whole strings are compared: the boundary then lives in the regex,
 * not in index arithmetic that can go wrong.
 */
export function sameOrigin(url: string, origin: string): boolean {
  const theirs = originOf(url);
  return theirs !== null && theirs === originOf(origin);
}
