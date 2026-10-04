/**
 * Which rooms already received their opening history, and UNDER WHICH
 * connection generation.
 *
 * The problem: the room screen is UNMOUNTED when left (navigation stack). Its
 * guard `useRef` goes with it, so coming back two seconds later redid a whole
 * `*.history?count=50`: ~31 KB, plus re-ingesting the same 50 messages (150
 * SQLite statements), plus the sync bar lit for the fetch. Entirely redundant
 * work.
 *
 * Why a generation rather than "less than N seconds ago": what decides whether
 * a cache is valid is not a delay but a fact: has the connection held since?
 * `generation` is incremented on EVERY connection setup (`ui/sync.tsx`), so:
 *
 *  - leave and come back without incident → same generation → no request,
 *    the cache shows at once;
 *  - after a drop, however brief → different generation → history reloaded,
 *    because the gap can be any size.
 *
 * Catch-up, for its part, only runs if the room was NOT kept listened to in
 * between (see [[hotRooms]]): on a big room, that read takes several seconds to
 * answer "nothing new".
 *
 * Module-level store, like `ui/uploadProbe`: nothing should re-render the
 * navigation tree when this table changes.
 */

import { invalidateSessionToken, sessionToken } from './sessionToken.ts';

const payloads = new Map<string, number>();

/**
 * After a SUCCESSFUL opening history, never on a network failure.
 *
 * `token` is the one captured when the load STARTED: a response landing after
 * the session ended must not refill a cache that was just cleared (see
 * [[sessionToken]]). Without it, the mark outlived the session, and the next
 * one skipped the room's opening history as soon as its generation counter,
 * restarted from 0, reached the remembered value.
 */
export function markRoomLoaded(rid: string, generation: number, token: number): void {
  if (token !== sessionToken()) return;
  payloads.set(rid, generation);
}

export function roomLoadedUnder(rid: string, generation: number): boolean {
  return payloads.get(rid) === generation;
}

/** Session end / server change: nothing in this cache holds anymore. */
export function forgetLoadedRooms(): void {
  payloads.clear();
  invalidateSessionToken();
}
