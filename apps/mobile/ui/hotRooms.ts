/**
 * The rooms we keep LISTENING to after leaving them.
 *
 * The problem, measured on the real server: re-entering a room just left
 * restarted `chat.syncMessages`, which takes **3 seconds** to answer "nothing
 * new" on a big room (the Mongo index is `{rid, ts, _updatedAt}`; filtering
 * on `_updatedAt` alone forces the server to sort the whole room). Three
 * seconds of sync bar for zero documents.
 *
 * Why that request went out: leaving the screen released the room's
 * subscriptions (those of `Provider.roomSubscriptions`), so its cache was no
 * longer kept current by realtime, and only a read could guarantee nothing was
 * missed. The answer is not to wait less, it is not to create the gap: we KEEP
 * listening on the way out. Nothing could be missed, so there is nothing to
 * catch up.
 *
 * `ddp.subscribe` counts references (`lib/ddp.ts`): holding one more
 * reference sends no extra `sub` on the wire; the stream was already there,
 * we just refrain from closing it.
 *
 * Bounded to `MAX` rooms, LRU: unbounded, a session visiting 25 rooms would
 * end up listening to all of them. Beyond that, the least recently left is
 * released, and becomes a room to catch up again, which is the original
 * behaviour, not a regression.
 *
 * The connection `generation` plays the same role as elsewhere
 * ([[loadedRooms]]): a drop, however brief, invalidates the coverage, because
 * the gap can then be of any size.
 */

import { invalidateSessionToken, sessionToken } from './sessionToken.ts';

type Release = () => void;

const MAX = 3;

/** Insertion order = LRU order (the first is the least recently left). */
const hot = new Map<string, { generation: number; releases: Release[] }>();

/**
 * Has this room stayed listened to without interruption since its last visit?
 * If so, no catch-up read is needed when it reopens.
 */
export function roomCovered(rid: string, generation: number): boolean {
  const entry = hot.get(rid);
  return entry !== undefined && entry.generation === generation;
}

/**
 * On LEAVING a room: its subscriptions stay open and their releasers are
 * handed over here.
 *
 * Always releases the previous set of the same room: on the second exit, the
 * screen took its own references again at mount, and otherwise each round trip
 * would pile up one more.
 *
 * `token` is the one captured at MOUNT, when those subscriptions were taken
 * (see [[sessionToken]]). If it no longer matches, the session they belonged
 * to is over and their DDP client has already been `reset()`. We then release
 * on the spot: storing would leave a GHOST entry that `releaseHotRooms` will
 * never come back to clean, and that would make the next session answer
 * "nothing to catch up" for a room its socket never listened to.
 */
export function keepWarm(
  rid: string,
  generation: number,
  releases: Release[],
  token: number,
): void {
  if (token !== sessionToken()) {
    for (const release of releases) release();
    return;
  }
  const old = hot.get(rid);
  if (old !== undefined) for (const release of old.releases) release();
  // Reinsert at the end of the Map: this room becomes the most recently left.
  hot.delete(rid);
  hot.set(rid, { generation, releases });

  while (hot.size > MAX) {
    const oldest = hot.keys().next().value;
    if (oldest === undefined) break;
    const outgoing = hot.get(oldest);
    if (outgoing !== undefined) for (const release of outgoing.releases) release();
    hot.delete(oldest);
  }
}

/** End of session / server switch: close everything we held. */
export function releaseHotRooms(): void {
  for (const entry of hot.values()) {
    for (const release of entry.releases) release();
  }
  hot.clear();
  // And nothing from this session may repopulate the table any more: the
  // screens still mounted will call `keepWarm` as they unmount.
  invalidateSessionToken();
}
