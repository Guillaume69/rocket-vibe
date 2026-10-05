/**
 * Which THREADS already received their opening load, and under which
 * connection generation. Same reasoning as [[loadedRooms]], but the waste it
 * avoids is bigger, not smaller.
 *
 * The load effect of `app/thread/[id].tsx` has `generation` in its deps and had
 * no guard: every connection setup (so every return to the foreground, every
 * network flap) replayed `chat.getMessage` THEN the full pagination of
 * `chat.getThreadMessages` in pages of 100. On a 300-reply thread, 4 REST calls
 * per connection setup on a route capped at 10/min, to re-ingest exactly the
 * same documents.
 *
 * A thread has no equivalent of the `ui/hotRooms.ts` net: its replies arrive
 * through the ROOM stream, which the screen subscribes to itself. The criterion
 * thus stays causal, not temporal: has the connection held since? A drop,
 * however brief, voids the guard, because the gap can be any size.
 *
 * Module-level store: nothing should re-render the tree when this table changes.
 */

import { invalidateSessionToken, sessionToken } from './sessionToken.ts';

const payloads = new Map<string, number>();

/**
 * After a SUCCESSFUL thread load, never on a network failure, otherwise a
 * thread opened offline would stay empty until the NEXT connection setup.
 *
 * `token`: captured when the load starts, rejected if it changed since.
 * See [[sessionToken]].
 */
export function markThreadLoaded(threadId: string, generation: number, token: number): void {
  if (token !== sessionToken()) return;
  payloads.set(threadId, generation);
}

export function threadLoadedUnder(threadId: string, generation: number): boolean {
  return payloads.get(threadId) === generation;
}

/** Session end / server change: nothing in this cache holds anymore. */
export function forgetLoadedThreads(): void {
  payloads.clear();
  invalidateSessionToken();
}
