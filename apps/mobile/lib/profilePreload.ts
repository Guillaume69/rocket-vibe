/**
 * Preloading the user profile BEFORE opening the `/profile` sheet.
 *
 * The sheet is a `formSheet` with `sheetAllowedDetents: 'fitToContents'`: it
 * measures itself on the FIRST render. If the content (name, roles, bio, time
 * zone, "Call" button) then arrives async, the height jumps: the "jump" the
 * user saw. We break that by fetching `users.info` AND settling the call probe
 * BEFORE navigating: on mount, the screen reads this profile from the cache and
 * starts already complete, at its final height.
 *
 * The cache is NOT a freshness cache: it is a hand-off buffer between the
 * pre-navigation call and the screen's first frame. Every opening redoes the
 * call and rewrites the entry, so the profile shown is always the one just
 * fetched.
 *
 * `client` and navigation are singletons (set from `ui/`: `SessionProvider` for
 * the client, the root layout for the navigator), not parameters: an `@user`
 * mention in a message body is rendered by plain functions (`ui/markdown.tsx`),
 * with nothing at hand. It is also what keeps this module LOADABLE UNDER NODE:
 * no `expo-router` nor i18n here, navigation is injected, the error travels as
 * a key translated at display time.
 */

import type { TranslationKey } from '../ui/messages.ts'; // type-only import: recorded, like lib/systemMessages.ts
import { probeCallAvailable } from './call.ts';
import type { RestClient } from './rest.ts';

/** One of the two forms `users.info` accepts (never both at once). */
export type ProfileParams = { username?: string; uid?: string };

/**
 * Why `user` is missing: a catalogue key (translated at DISPLAY time, this
 * module is pure lib/) or the message of a `RestError`, already localized.
 */
export type ProfileError = { key: TranslationKey } | { message: string };

/** Raw cached `users.info`: `user` missing ⇒ failure described by `error`. */
export type RawProfile = { user: Record<string, unknown> | undefined; error: ProfileError | null };

/**
 * Wait cap before opening anyway. On a normal network, `users.info` answers
 * well below it and the sheet opens already complete; beyond it (sluggish
 * network), it opens anyway and the screen falls back on its async load, with
 * its skeleton. A tap that responds beats a tap that seems dead.
 */
const CAP_MS = 2000;

/**
 * Indicator anti-flicker, in two parts:
 *
 * - `INDICATOR_THRESHOLD_MS`: delay before SHOWING it. Under this delay (the
 *   normal case) nothing shows, the sheet opens, the tap feels instant. Set
 *   high enough that ordinary prod latency stays BELOW it and triggers nothing.
 * - `MIN_VISIBLE_MS`: once shown, it STAYS at least this long, even if that
 *   delays the opening a little. Without it, a load finishing just after the
 *   threshold would show the pill only to hide it at once: the flash. A
 *   flickering loader looks more "broken" than "slow".
 */
const INDICATOR_THRESHOLD_MS = 450;
const MIN_VISIBLE_MS = 400;

let activeClient: RestClient | null = null;

/** Set by `SessionProvider` on every session change. */
export function setProfileClient(client: RestClient | null): void {
  activeClient = client;
}

let activeBrowser: ((p: ProfileParams) => void) | null = null;

/**
 * Set by the root layout (`app/_layout.tsx`): IT knows how to push `/profile`,
 * this pure lib/ module does not know expo-router. Same model as
 * `setProfileClient`. Without a navigator set (never the case once the app is
 * mounted), opening is a silent no-op.
 */
export function setProfileNavigator(nav: ((p: ProfileParams) => void) | null): void {
  activeBrowser = nav;
}

// --- Opening indicator (deferred) ------------------------------------------
// Minimal store, outside React (this module is `lib/`): the UI subscribes via
// `ui/openingIndicator`. `setBusy` only notifies on a real change.
type BusyListener = (active: boolean) => void;
const listeners = new Set<BusyListener>();
let busy = false;

function setBusy(v: boolean): void {
  if (busy === v) return;
  busy = v;
  for (const e of listeners) e(v);
}

/** Subscribes a listener to the "opening in progress" state; returns the unsubscribe. */
export function subscribeProfileOpening(cb: BusyListener): () => void {
  listeners.add(cb);
  cb(busy);
  return () => {
    listeners.delete(cb);
  };
}

const cache = new Map<string, RawProfile>();

function key(p: ProfileParams): string {
  return typeof p.username === 'string' && p.username !== ''
    ? `u:${p.username}`
    : `i:${p.uid ?? ''}`;
}

/** Preloaded profile for these params, or `undefined` if the screen must load it itself. */
export function readPreloadedProfile(p: ProfileParams): RawProfile | undefined {
  return cache.get(key(p));
}

/**
 * Session end / server change.
 *
 * The cache holds RAW `users.info` profiles (roles, bio, time zone, custom
 * fields) under a key carrying neither server nor account. The nominal path
 * cannot serve them to another account (`preloadThenOpen` rewrites the entry
 * before pushing the screen), but keeping them in memory for the life of the
 * process is a residence of personal data nothing justifies, and a narrow race
 * is enough to display them.
 */
export function forgetProfileCards(): void {
  cache.clear();
  currentKey = null;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The TARGET whose opening is in flight: see the guard in `openProfileCard`. */
let currentKey: string | null = null;

/**
 * Preloads the profile then opens `/profile`. Use instead of a direct
 * `router.push('/profile')`, wherever a profile is opened.
 *
 * Reentrancy guarded: the function waits up to `CAP_MS` before pushing the
 * screen, and the waiting indicator is mounted with `pointerEvents="none"`, so
 * nothing stopped a second tap. We got two `push`es, so two stacked profiles to
 * close, and the first run's `finally` turned the indicator off while the
 * second was still in flight (`setBusy` is a global boolean, not a counter).
 * A STATE guard, as everywhere else in the repo (app/message-actions.tsx,
 * app/search.tsx, app/profile.tsx): no delay added.
 *
 * The guard is on the TARGET, not on "any opening": a global lock would have
 * swallowed, for up to 2.4 s and without any visual feedback (the indicator
 * only appears after `INDICATOR_THRESHOLD_MS`), a tap on ANOTHER profile, which
 * the user would have had to tap again. Two different targets therefore keep
 * the previous behaviour.
 */
export async function openProfileCard(p: ProfileParams): Promise<void> {
  const k = key(p);
  if (currentKey === k) return;
  currentKey = k;
  try {
    await preloadThenOpen(p);
  } finally {
    // A more recent opening took over: do not clear ITS key.
    if (currentKey === k) currentKey = null;
  }
}

async function preloadThenOpen(p: ProfileParams): Promise<void> {
  const client = activeClient;
  const k = key(p);

  // No client (unlikely: before the session is set): open directly, the screen
  // will make the call. Purge any entry from a previous opening so as not to
  // serve stale data.
  if (client === null) {
    cache.delete(k);
    activeBrowser?.(p);
    return;
  }

  const params: ProfileParams =
    typeof p.username === 'string' && p.username !== ''
      ? { username: p.username }
      : { uid: p.uid ?? '' };
  const rest = params.username !== undefined ? { username: params.username } : { userId: params.uid };

  const rawFetch = client
    .get<{ user?: Record<string, unknown> }>('users.info', { params: rest })
    .then<RawProfile>((r) => ({
      user: r.user,
      error: r.user ? null : { key: 'profile.profileUnreadable' },
    }))
    .catch<RawProfile>((e: unknown) => ({
      user: undefined,
      error: e instanceof Error ? { message: e.message } : { key: 'profile.profileNotFound' },
    }));

  // Deferred indicator: shows ONLY if the wait exceeds the threshold, and then
  // stays visible a minimum time (anti-flash, see the constants).
  let shownAt: number | null = null;
  const timer = setTimeout(() => {
    setBusy(true);
    shownAt = Date.now();
  }, INDICATOR_THRESHOLD_MS);
  // ALSO wait for the call probe (memoized per server): it decides whether the
  // "Call" button is present, hence the final height.
  let raw: RawProfile | null;
  try {
    raw = await Promise.race<RawProfile | null>([
      Promise.all([rawFetch, probeCallAvailable(client)]).then(([b]) => b),
      delay(CAP_MS).then(() => null),
    ]);
  } finally {
    clearTimeout(timer);
    if (shownAt !== null) {
      // Pill shown: keep it up to its minimum before hiding and opening,
      // otherwise flash. So the opening happens right as it disappears.
      const remainingMs = MIN_VISIBLE_MS - (Date.now() - shownAt);
      if (remainingMs > 0) await delay(remainingMs);
    }
    setBusy(false);
  }

  if (raw !== null) {
    cache.set(k, raw);
  } else {
    // Cap exceeded: open without serving a stale earlier entry; the screen
    // will read a miss and do its own async load.
    cache.delete(k);
  }
  activeBrowser?.(p);
}
